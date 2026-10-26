'use strict';
// update-baseline.js : after a successful push, move the baseline forward by EXACTLY what was pushed
// (changes that were added or were already there). Conflicts and skipped changes stay "different"
// and come back in the next run. It runs the same rule engine on a COPY of the baseline, checks it,
// keeps the old one as baseline.prev.db and swaps the new one in.
//
//   node update-baseline.js --baseline <baseline.db> --delta delta.json --result result.json [--ddl-from a.db,b.db]

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const engine = require('./engine');

async function updateBaseline(baselineFile, delta, result, ddlSources) {
  if (result.rolledBack) throw new Error('The push was rolled back, the baseline is not changed.');
  const ids = new Set(result.statuses.filter((s) => s.status === 'applied' || s.status === 'already').map((s) => s.id));
  const dir = path.dirname(baselineFile);
  const next = path.join(dir, 'baseline.new.db');
  const prev = path.join(dir, 'baseline.prev.db');
  L.snapshotTo(baselineFile, next, true);
  const db = L.openDb(next, false);
  let out;
  let skipped = [];
  try {
    createMissingTables(db, delta, ids, ddlSources || []);
    out = await engine.run(L.nodeAdapter(db), delta, { dryRun: false, only: ids, checkParents: true });
    if (out.rolledBack) throw new Error('The baseline copy failed the broken-link check. Baseline not changed.');
    // A few changes the baseline copy cannot take (for example a job code the old baseline still uses for another row) are simply
    // left out: they stay "different", show up as "already there" in the next report, and nothing is lost.
    skipped = out.results.filter((r) => r.status !== 'applied' && r.status !== 'already');
    const ic = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (ic !== 'ok') throw new Error('Baseline copy failed the integrity check. Baseline not changed.');
  } catch (e) {
    db.close(); try { fs.unlinkSync(next); } catch { /* none */ }
    throw e;
  }
  db.close();
  for (const s of ['-wal', '-shm']) { try { fs.unlinkSync(next + s); } catch { /* none */ } }
  fs.copyFileSync(baselineFile, prev);
  fs.renameSync(next, baselineFile);
  return { advanced: ids.size - skipped.length, skipped: skipped.length, firstSkipped: skipped[0] ? skipped[0].table + ': ' + skipped[0].reason : '', applied: out.results.filter((r) => r.status === 'applied').length, already: out.results.filter((r) => r.status === 'already').length };
}

// A table that is new on the other side may not exist in the baseline yet: create it (same CREATE TABLE) so
// the pushed rows can be recorded. Columns that only one side has are simply not recorded.
function createMissingTables(db, delta, ids, sources) {
  const have = new Set(L.listTables(db));
  const wanted = delta.order.filter((t) => !have.has(t) && delta.tables[t].ops.some((o) => ids.has(o.id)));
  for (const t of wanted) {
    for (const f of sources) {
      const s = L.openDb(f, true);
      try {
        const r = s.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
        if (r && r.sql) { db.exec(r.sql); break; }
      } finally { s.close(); }
    }
  }
}

module.exports = { updateBaseline };

if (require.main === module) {
  (async () => {
    const a = L.parseArgs(process.argv.slice(2));
    if (!a.baseline || !a.delta || !a.result) { console.error('Use: node update-baseline.js --baseline <baseline.db> --delta <delta.json> --result <result.json>'); process.exit(2); }
    const r = await updateBaseline(a.baseline, L.readJson(a.delta), L.readJson(a.result), a['ddl-from'] ? String(a['ddl-from']).split(',') : []);
    console.log('Baseline moved forward by ' + r.advanced + ' change(s) (' + r.applied + ' added/updated, ' + r.already + ' already there). Old baseline kept as baseline.prev.db');
    if (r.skipped) console.log('Note: ' + r.skipped + ' change(s) could not be recorded in the baseline (first: ' + r.firstSkipped + '). Harmless: they show as "already there" in the next report.');
  })().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
}
