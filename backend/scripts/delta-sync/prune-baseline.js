'use strict';
// prune-baseline.js : after rows were really deleted from the live site, remove the same rows from the baseline
// (the baseline = "the copy where localhost and the live site matched"; both sides now lack these rows).
//
//   node prune-baseline.js --baseline baseline.db --result prune-result.json

const L = require('./lib');

const a = L.parseArgs(process.argv.slice(2));
if (!a.baseline || !a.result) { console.error('Use: node prune-baseline.js --baseline <db> --result <prune-result.json>'); process.exit(2); }
const res = L.readJson(a.result);
const db = L.openDb(a.baseline, false);
let n = 0;
try {
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN IMMEDIATE');
  for (const [t, pks] of Object.entries(res.removed || {})) {
    if (!pks.length) continue;
    const pkCols = L.tableInfo(db, t).pkCols;
    if (!pkCols.length) continue;
    for (const pk of pks) {
      db.exec('DELETE FROM ' + L.qid(t) + ' WHERE ' + pkCols.map((c, i) => L.qid(c) + ' = ' + L.lit(pk[i])).join(' AND '));
      n++;
    }
  }
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* none */ }
  console.error('ERROR: ' + e.message);
  process.exit(1);
} finally { db.close(); }
console.log('Baseline updated: ' + n + ' deleted row(s) removed from it.');
