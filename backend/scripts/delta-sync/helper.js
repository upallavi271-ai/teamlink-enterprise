'use strict';
// helper.js : small jobs the PowerShell scripts need. Everything here only READS the databases it is given
// (snapshot writes only the NEW file it is told to create).
//
//   node helper.js snapshot  --src <db> --dest <new file>      consistent copy (VACUUM INTO), source opened read-only
//   node helper.js integrity --db <db>                         prints "ok" or the problem
//   node helper.js schema    --baseline <db> --local <db>      compares database versions (migrations)
//   node helper.js count     --baseline <db> --local <db> [--config <json>]   how many un-pushed changes there are
//   node helper.js stamp     --baseline <db> --delta <delta.json> --result <result.json> [--only-already]

const fs = require('fs');
const L = require('./lib');

async function main() {
  const cmd = process.argv[2];
  const a = L.parseArgs(process.argv.slice(3));
  if (cmd === 'snapshot') {
    if (!a.src || !a.dest) throw new Error('--src and --dest needed');
    L.snapshotTo(a.src, a.dest, true);
    const d = L.openDb(a.dest, true); const ic = d.prepare('PRAGMA integrity_check').get().integrity_check; d.close();
    if (ic !== 'ok') throw new Error('Snapshot failed the integrity check: ' + ic);
    console.log('snapshot ok');
  } else if (cmd === 'integrity') {
    const d = L.openDb(a.db, true); console.log(d.prepare('PRAGMA integrity_check').get().integrity_check); d.close();
  } else if (cmd === 'schema') {
    const b = L.openDb(a.baseline, true); const l = L.openDb(a.local, true);
    const bm = new Set(L.migrationNames(b)); const lm = new Set(L.migrationNames(l));
    b.close(); l.close();
    const localNew = [...lm].filter((m) => !bm.has(m));
    const baseNew = [...bm].filter((m) => !lm.has(m));
    console.log(JSON.stringify({ baseline: bm.size, local: lm.size, localNew, baseNew }));
    process.exitCode = (localNew.length || baseNew.length) ? 3 : 0;
  } else if (cmd === 'count') {
    const { makeDelta } = require('./make-delta');
    const d = makeDelta({ baseline: a.baseline, local: a.local, configFile: a.config });
    console.log(JSON.stringify({ inserts: d.summary.inserts, updates: d.summary.updates, deletes: d.summary.deletesNotApplied }));
  } else if (cmd === 'stamp') {
    // advance a baseline using a CLASSIFY result: only changes that are already there (no live site involved)
    const { updateBaseline } = require('./update-baseline');
    const res = L.readJson(a.result);
    const statuses = res.statuses.filter((s) => (a['only-already'] ? s.status === 'already' : (s.status === 'applied' || s.status === 'already')));
    const r = await updateBaseline(a.baseline, L.readJson(a.delta), { statuses, rolledBack: false });
    console.log('Baseline moved forward by ' + r.advanced + ' change(s).');
  } else {
    throw new Error('unknown command ' + cmd);
  }
}
main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
void fs;
