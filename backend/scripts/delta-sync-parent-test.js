'use strict';
// delta-sync-parent-test.js : a row whose parent row is missing on the target must be a CONFLICT of its own,
// not make the final broken-link check roll back the whole run. Copies only.
//   node scripts/delta-sync-parent-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const DS = path.join(__dirname, 'delta-sync');
const L = require(path.join(DS, 'lib.js'));
const { makeDelta } = require(path.join(DS, 'make-delta.js'));
const engine = require(path.join(DS, 'engine.js'));

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-test-'));
const F = (n) => path.join(W, n);
let pass = 0; let fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } }

function buildSchema(file) {
  const dir = path.resolve(__dirname, '..', 'prisma', 'migrations');
  fs.writeFileSync(file, '');
  const db = L.openDb(file, false);
  for (const n of fs.readdirSync(dir).filter((x) => fs.existsSync(path.join(dir, x, 'migration.sql'))).sort()) db.exec(fs.readFileSync(path.join(dir, n, 'migration.sql'), 'utf8'));
  db.close();
}
function put(db, table, vals) {
  const info = L.tableInfo(db, table);
  const row = Object.assign({}, vals);
  for (const c of info.cols) {
    if (row[c.name] !== undefined || !c.notnull || c.hasDefault) continue;
    row[c.name] = /INT|BOOL|REAL|DATE|NUM|DOUBLE/.test(String(c.type).toUpperCase()) ? 1700000000000 : 'x_' + c.name + '_' + (vals.id || '');
  }
  const cols = Object.keys(row);
  db.prepare('INSERT INTO ' + L.qid(table) + ' (' + cols.map(L.qid).join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...cols.map((k) => row[k]));
}
const seed = (file, fn) => { const d = L.openDb(file, false); d.exec('PRAGMA foreign_keys=OFF'); try { fn(d); } finally { d.close(); } };
const has = (file, t, id) => { const d = L.openDb(file, true); try { return !!d.prepare('SELECT 1 FROM ' + L.qid(t) + ' WHERE id = ?').get(id); } finally { d.close(); } };
async function run(file, delta, opts) {
  const db = L.openDb(file, false);
  try { return await engine.run(L.nodeAdapter(db), delta, opts); } finally { db.close(); }
}

(async () => {
  buildSchema(F('schema.db'));
  fs.copyFileSync(F('schema.db'), F('baseline.db'));
  seed(F('baseline.db'), (d) => {
    put(d, 'Client', { id: 'c1', name: 'Client one' });
    ['cand1', 'cand2'].forEach((id) => put(d, 'Candidate', { id }));
    put(d, 'Requirement', { id: 'r1', clientId: 'c1', reqCode: 'REQ-1' });
    put(d, 'Requirement', { id: 'r2', clientId: 'c1', reqCode: 'REQ-2' });
    put(d, 'Application', { id: 'a1', requirementId: 'r1', candidateId: 'cand1' });
    put(d, 'Application', { id: 'a2', requirementId: 'r2', candidateId: 'cand2' });
  });
  fs.copyFileSync(F('baseline.db'), F('source.db')); // the side that has the news
  fs.copyFileSync(F('baseline.db'), F('target.db')); // the side that receives them
  // the TARGET deleted application a1 (and its parent requirement r1)
  seed(F('target.db'), (d) => { d.exec("DELETE FROM Application WHERE id='a1'; DELETE FROM Requirement WHERE id='r1'"); });
  // the SOURCE added: a follow-up on a1 (parent gone on the target), a follow-up on a2 (parent fine),
  // a brand-new requirement r9 with a new application a9 (parent travels in the same run), and an edit of a2's requirement to the missing r1.
  seed(F('source.db'), (d) => {
    put(d, 'ApplicationFollowUp', { id: 'f_bad', applicationId: 'a1', requirementId: 'r2' });
    put(d, 'ApplicationFollowUp', { id: 'f_ok', applicationId: 'a2', requirementId: 'r2' });
    put(d, 'Candidate', { id: 'cand9' });
    put(d, 'Requirement', { id: 'r9', clientId: 'c1', reqCode: 'REQ-9' });
    put(d, 'Application', { id: 'a9', requirementId: 'r9', candidateId: 'cand9' });
    put(d, 'ApplicationStageEvent', { id: 's9', applicationId: 'a9', requirementId: 'r9', candidateId: 'cand9' });
    d.exec("UPDATE Application SET requirementId='r1' WHERE id='a2'");
  });
  const delta = makeDelta({ baseline: F('baseline.db'), local: F('source.db'), out: F('delta.json') });

  console.log('\n-- without the parent check (the old behaviour)');
  fs.copyFileSync(F('target.db'), F('t-old.db'));
  let r = await run(F('t-old.db'), delta, { dryRun: false });
  ok(r.rolledBack === true, 'the final broken-link check rolls back EVERYTHING');
  ok(!has(F('t-old.db'), 'Requirement', 'r9'), 'so even the harmless new requirement r9 is lost');

  console.log('\n-- with the parent check');
  fs.copyFileSync(F('target.db'), F('t-new.db'));
  r = await run(F('t-new.db'), delta, { dryRun: false, checkParents: true });
  const st = (t, id) => (r.results.find((x) => x.table === t && JSON.stringify(x.pk || null) !== undefined && x.id !== undefined && (delta.tables[t].ops.find((o) => o.id === x.id).pk[0] === id)) || {}).status;
  ok(r.rolledBack === false, 'no rollback');
  ok(st('ApplicationFollowUp', 'f_bad') === 'conflict', 'the follow-up on the missing application is a conflict (skipped)');
  ok(st('ApplicationFollowUp', 'f_ok') === 'applied' && has(F('t-new.db'), 'ApplicationFollowUp', 'f_ok'), 'the follow-up on an existing application is added');
  ok(st('Requirement', 'r9') === 'applied' && st('Application', 'a9') === 'applied' && st('ApplicationStageEvent', 's9') === 'applied', 'a new requirement, its application and its stage event travel together');
  ok(st('Application', 'a2') === 'conflict', 'the edit that points a2 at the missing requirement r1 is a conflict');
  ok(!has(F('t-new.db'), 'ApplicationFollowUp', 'f_bad'), 'f_bad is not in the target');
  const fk = L.openDb(F('t-new.db'), true);
  const before = L.openDb(F('target.db'), true);
  const key = (x) => x.table + '|' + x.rowid + '|' + x.parent + '|' + x.fkid;
  const old = new Set(before.prepare('PRAGMA foreign_key_check').all().map(key));
  ok(fk.prepare('PRAGMA foreign_key_check').all().every((x) => old.has(key(x))), 'no new broken links');
  fk.close(); before.close();

  console.log('\n-- dry run gives the same answer as the real run');
  fs.copyFileSync(F('target.db'), F('t-dry.db'));
  const rd = await run(F('t-dry.db'), delta, { dryRun: true, checkParents: true });
  const sig = (x) => x.results.map((e) => e.id + ':' + e.status).join(',');
  ok(sig(rd) === sig(r), 'classification (dry) == application (real)');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  fs.rmSync(W, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
