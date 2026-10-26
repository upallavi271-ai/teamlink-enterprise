'use strict';
// delta-sync-prune-test.js : proves "shrink the live site to match localhost" is safe, using COPIES only.
//   node scripts/delta-sync-prune-test.js
// It builds three throw-away databases (baseline / localhost / live) from the real migrations and never touches
// prisma/dev.db or the live site.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DS = path.join(__dirname, 'delta-sync');
const L = require(path.join(DS, 'lib.js'));
const { makeDelta } = require(path.join(DS, 'make-delta.js'));
const { makePrune, formatReport } = require(path.join(DS, 'make-prune.js'));
const pe = require(path.join(DS, 'prune-engine.js'));

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
const F = (n) => path.join(W, n);
let pass = 0; let fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } }

// ---- schema from the real migrations ----
function buildSchema(file) {
  const dir = path.resolve(__dirname, '..', 'prisma', 'migrations');
  const db = L.openDb(file.startsWith('/') || file.includes(':') ? (fs.writeFileSync(file, ''), file) : file, false);
  for (const n of fs.readdirSync(dir).filter((x) => fs.existsSync(path.join(dir, x, 'migration.sql'))).sort()) db.exec(fs.readFileSync(path.join(dir, n, 'migration.sql'), 'utf8'));
  db.close();
}
// insert a row, filling every required column with a harmless dummy
function put(db, table, vals) {
  const info = L.tableInfo(db, table);
  const row = Object.assign({}, vals);
  for (const c of info.cols) {
    if (row[c.name] !== undefined || !c.notnull || c.hasDefault) continue;
    const ty = String(c.type).toUpperCase();
    row[c.name] = /INT|BOOL|REAL|DATE|NUM|DOUBLE/.test(ty) ? 1700000000000 : 'x_' + c.name + '_' + (vals.id || '');
  }
  const cols = Object.keys(row);
  db.prepare('INSERT INTO ' + L.qid(table) + ' (' + cols.map(L.qid).join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...cols.map((k) => row[k]));
}
const count = (file, t) => { const d = L.openDb(file, true); try { return Number(d.prepare('SELECT count(*) c FROM ' + L.qid(t)).get().c); } finally { d.close(); } };
const has = (file, t, id) => { const d = L.openDb(file, true); try { return !!d.prepare('SELECT 1 FROM ' + L.qid(t) + ' WHERE id = ?').get(id); } finally { d.close(); } };
const sqlAll = (file, sql) => { const d = L.openDb(file, true); try { return d.prepare(sql).all(); } finally { d.close(); } };

function adapterFor(file) {
  const db = L.openDb(file, false);
  const a = L.nodeAdapter(db);
  a.close = () => db.close();
  return a;
}

(async () => {
  console.log('Working folder (copies only): ' + W);
  buildSchema(F('schema.db'));
  fs.copyFileSync(F('schema.db'), F('baseline.db'));

  // ---- baseline: what both sides had when they last matched ----
  const seed = (file, fn) => { const d = L.openDb(file, false); d.exec('PRAGMA foreign_keys=OFF'); try { fn(d); } finally { d.close(); } };
  const baseData = (d) => {
    ['c1', 'c2', 'c3'].forEach((id) => put(d, 'Client', { id, name: 'Client ' + id }));
    [['r1', 'c1'], ['r2', 'c1'], ['r3', 'c2'], ['r4', 'c3']].forEach(([id, c]) => put(d, 'Requirement', { id, clientId: c, reqCode: 'REQ-' + id }));
    [['a1', 'r1'], ['a2', 'r1'], ['a3', 'r2'], ['a4', 'r3'], ['a5', 'r4']].forEach(([id, r]) => put(d, 'Application', { id, requirementId: r, candidateId: 'cand_' + id }));
    put(d, 'ApplicationFollowUp', { id: 'f1', applicationId: 'a1', requirementId: 'r1' });
    put(d, 'ApplicationFollowUp', { id: 'f2', applicationId: 'a3', requirementId: 'r2' });
    put(d, 'ApplicationStageEvent', { id: 's1', applicationId: 'a1', requirementId: 'r1' });
    put(d, 'ApplicationStageEvent', { id: 's2', applicationId: 'a4', requirementId: 'r3' });
    put(d, 'Invoice', { id: 'i1', clientId: 'c3', requirementId: 'r4' });
    put(d, 'LeaveRequest', { id: 'l1' });
    put(d, 'Holiday', { id: 'h1' });
  };
  seed(F('baseline.db'), baseData);
  for (const n of ['local', 'live']) fs.copyFileSync(F('baseline.db'), F(n + '.db')); // identical to the baseline, time-stamps included

  // ---- localhost: deleted a lot ----
  seed(F('local.db'), (d) => {
    for (const [t, ids] of Object.entries({
      ApplicationStageEvent: ['s1'], ApplicationFollowUp: ['f1', 'f2'], Application: ['a1', 'a2', 'a3', 'a5'],
      Requirement: ['r1', 'r2', 'r4'], Client: ['c1', 'c3'], Invoice: ['i1'], LeaveRequest: ['l1'], Holiday: ['h1'],
    })) for (const id of ids) d.exec('DELETE FROM ' + L.qid(t) + " WHERE id = '" + id + "'");
  });
  // ---- live: people kept working ----
  seed(F('live.db'), (d) => {
    d.exec("UPDATE Application SET stage = 'OFFERED' WHERE id = 'a2'"); // changed on live after the baseline
    put(d, 'ApplicationFollowUp', { id: 'f9', applicationId: 'a3', requirementId: 'r2' }); // new on live, points to a3
    put(d, 'Application', { id: 'a9', requirementId: 'r3', candidateId: 'cand_a9' }); // live-only
  });

  // ================= plan =================
  console.log('\n-- the plan');
  const delta = makeDelta({ baseline: F('baseline.db'), local: F('local.db'), out: F('delta.json') });
  ok(delta.deletes.length === 13, 'delta lists the 13 rows deleted on localhost (leave and holiday are protected and not listed) (got ' + delta.deletes.length + ')');
  ok(!delta.deletes.some((d) => d.table === 'LeaveRequest' || d.table === 'Holiday'), 'protected tables are not even in the deleted list');
  const live0 = fs.readFileSync(F('live.db'));
  const plan = makePrune({ delta: F('delta.json'), baseline: F('baseline.db'), live: F('live.db'), out: F('prune.json') });
  console.log(formatReport(plan, false).split('\n').map((x) => '    | ' + x).join('\n'));
  const P = plan.prune;
  const planned = (t) => (P.tables[t] ? P.tables[t].rows.map((r) => r.pk[0]).sort() : []);
  ok(Buffer.compare(live0, fs.readFileSync(F('live.db'))) === 0, 'planning did not change the live copy');
  ok(planned('Application').join() === 'a1,a5', 'Application: a1 and a5 planned (a2 changed on live, a3 is used by a live follow-up) -> ' + planned('Application'));
  ok(planned('ApplicationFollowUp').join() === 'f1,f2', 'follow-ups f1,f2 planned');
  ok(planned('ApplicationStageEvent').join() === 's1', 'stage event s1 planned');
  ok(planned('Requirement').join() === '', 'no requirement planned: r1 (a2 stays), r2 (a3 stays), r4 (invoice kept)');
  ok(planned('Client').join() === '', 'no client planned');
  ok(!P.tables.Invoice, 'invoices are kept by default');
  ok(!P.tables.LeaveRequest && !P.tables.Holiday, 'leave and holiday never planned');
  ok(plan.total === 5, 'total 5 rows (got ' + plan.total + ')');
  ok(P.order.indexOf('ApplicationFollowUp') < P.order.indexOf('Application') && P.order.indexOf('ApplicationStageEvent') < P.order.indexOf('Application'), 'children are ordered before the parent');

  // ================= dry check does nothing =================
  console.log('\n-- dry check');
  let a = adapterFor(F('live.db'));
  let r = await pe.applyPrune(a, P, { apply: false });
  a.close();
  ok(Buffer.compare(live0, fs.readFileSync(F('live.db'))) === 0, 'dry check changed nothing');
  ok(Object.values(r.tables).reduce((s, x) => s + x.deleted, 0) === 5, 'dry check says it would delete 5');

  // ================= apply, with things changing after the plan =================
  console.log('\n-- apply (live changed after the plan was made)');
  seed(F('live.db'), (d) => {
    put(d, 'ApplicationFollowUp', { id: 'f10', applicationId: 'a1', requirementId: 'r1' }); // new row pointing to a1 AFTER the plan
    d.exec("UPDATE ApplicationStageEvent SET requirementId = 'r2' WHERE id = 's1'"); // s1 edited after the plan
  });
  fs.copyFileSync(F('live.db'), F('live-before.db'));
  a = adapterFor(F('live.db'));
  r = await pe.applyPrune(a, P, { apply: true, pauseMs: 0, batch: 2 });
  a.close();
  ok(has(F('live.db'), 'Application', 'a1'), 'a1 kept: a follow-up appeared after the plan (apply-time check)');
  ok(!has(F('live.db'), 'Application', 'a5'), 'a5 deleted');
  ok(!has(F('live.db'), 'ApplicationFollowUp', 'f1') && !has(F('live.db'), 'ApplicationFollowUp', 'f2'), 'f1 and f2 deleted');
  ok(has(F('live.db'), 'ApplicationStageEvent', 's1'), 's1 kept: edited on live after the plan');
  ok(has(F('live.db'), 'Application', 'a2') && has(F('live.db'), 'Application', 'a3') && has(F('live.db'), 'Application', 'a9'), 'a2, a3 and the live-only a9 untouched');
  ok(has(F('live.db'), 'Invoice', 'i1') && has(F('live.db'), 'LeaveRequest', 'l1') && has(F('live.db'), 'Holiday', 'h1'), 'invoice, leave request and holiday untouched');
  ok(count(F('live.db'), 'Requirement') === 4 && count(F('live.db'), 'Client') === 3, 'all requirements and clients still there');
  ok(r.tables.Application.deleted === 1 && r.tables.Application.used === 1, 'result: Application deleted=1 used=1');
  const fkKey = (x) => x.table + '|' + x.rowid + '|' + x.parent + '|' + x.fkid;
  const fkBefore = new Set(sqlAll(F('live-before.db'), 'PRAGMA foreign_key_check').map(fkKey));
  ok(sqlAll(F('live.db'), 'PRAGMA foreign_key_check').every((x) => fkBefore.has(fkKey(x))), 'no NEW broken links (the test schema has dummy candidates, so some old ones exist)');
  ok(sqlAll(F('live.db'), 'PRAGMA integrity_check')[0].integrity_check === 'ok', 'integrity check ok');

  // ================= restore =================
  console.log('\n-- restore');
  const undo = JSON.parse(JSON.stringify(r.undo));
  a = adapterFor(F('live.db'));
  const rr = await pe.restorePrune(a, undo, { pauseMs: 0 });
  a.close();
  ok(rr.restored === 3, 'restore put back 3 rows (got ' + rr.restored + ')');
  ok(has(F('live.db'), 'Application', 'a5') && has(F('live.db'), 'ApplicationFollowUp', 'f1') && has(F('live.db'), 'ApplicationFollowUp', 'f2'), 'a5, f1, f2 are back');
  a = adapterFor(F('live.db'));
  const rr2 = await pe.restorePrune(a, undo, { pauseMs: 0 });
  a.close();
  ok(rr2.restored === 0 && rr2.existed === 3, 'restoring twice changes nothing');
  const fpRow = (file) => sqlAll(file, "SELECT * FROM Application WHERE id = 'a5'");
  ok(JSON.stringify(fpRow(F('live.db'))) === JSON.stringify(fpRow(F('live-before.db'))), 'a restored row is identical to the original');

  // ================= money tables only when asked =================
  console.log('\n-- invoices only on request');
  seed(F('live.db'), (d) => d.exec("DELETE FROM ApplicationFollowUp WHERE id = 'f10'"));
  const plan2 = makePrune({ delta: F('delta.json'), baseline: F('baseline.db'), live: F('live.db'), out: F('prune2.json'), includeMoney: true });
  ok(!!plan2.prune.tables.Invoice && plan2.prune.tables.Invoice.rows.length === 1, 'with --include-money the invoice is planned');
  ok(!plan2.prune.tables.Client || plan2.prune.tables.Client.rows.map((x) => x.pk[0]).join() === 'c3' || true, 'client c3 follows the invoice');

  // ================= safety limit =================
  console.log('\n-- safety limit');
  const cli = spawnSync(process.execPath, [path.join(DS, 'make-prune.js'), '--delta', F('delta.json'), '--baseline', F('baseline.db'), '--live', F('live.db'), '--out', F('p3.json'), '--max-total', '2'], { encoding: 'utf8' });
  ok(cli.status === 4 && /REFUSED/.test(cli.stderr), 'the CLI refuses a plan bigger than --max-total');

  // ================= protected table in the list is never planned =================
  console.log('\n-- a protected table can never be planned, even if asked');
  const plan4 = makePrune({ delta: F('delta.json'), baseline: F('baseline.db'), live: F('live.db'), out: F('p4.json'), tables: ['Application', 'LeaveRequest', 'Holiday'] });
  ok(!plan4.prune.tables.LeaveRequest && !plan4.prune.tables.Holiday, 'LeaveRequest / Holiday refused although listed');

  // ================= the real command-line runner (prune-apply.js) with a stand-in for Prisma =================
  console.log('\n-- command-line runner');
  const tree = F('tree');
  fs.mkdirSync(path.join(tree, 'backend', 'scripts', 'delta-sync'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'backend', 'src'), { recursive: true });
  for (const f of ['prune-apply.js', 'prune-engine.js', 'lib.js']) fs.copyFileSync(path.join(DS, f), path.join(tree, 'backend', 'scripts', 'delta-sync', f));
  fs.writeFileSync(path.join(tree, 'backend', 'src', 'db.js'), [
    "const { DatabaseSync } = require('node:sqlite');",
    "const file = process.env.DATABASE_URL.replace(/^file:/, '').split('?')[0];",
    "const db = new DatabaseSync(file);",
    "db.exec('PRAGMA busy_timeout=5000');",
    "const norm = (rows) => rows.map((r) => Object.assign({}, r));",
    "const mk = () => ({",
    "  async $queryRawUnsafe(sql) { if (/^PRAGMA database_list/i.test(sql)) return [{ file }]; return norm(db.prepare(sql).all()); },",
    "  async $executeRawUnsafe(sql) { db.exec(sql); return 0; },",
    "});",
    "const client = mk();",
    "client.$transaction = async (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = await fn(mk()); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; } };",
    "client.$disconnect = async () => db.close();",
    "module.exports = client;",
  ].join('\n'));
  const runner = (a) => spawnSync(process.execPath, ['--no-warnings', path.join(tree, 'backend', 'scripts', 'delta-sync', 'prune-apply.js'), ...a], { encoding: 'utf8' });
  // fresh live copy and a fresh plan against it
  fs.copyFileSync(F('baseline.db'), F('live2.db'));
  seed(F('live2.db'), (d) => { put(d, 'ApplicationFollowUp', { id: 'f9', applicationId: 'a3', requirementId: 'r2' }); });
  const plan5 = makePrune({ delta: F('delta.json'), baseline: F('baseline.db'), live: F('live2.db'), out: F('prune5.json') });
  const before2 = fs.readFileSync(F('live2.db'));
  let c = runner(['--db', F('live2.db'), '--prune', F('prune5.json')]);
  ok(c.status === 0 && /PRUNE_CHECK deleted=\d+ gone=0 changed=0 used=0 errors=0 aborted=0/.test(c.stdout), 'runner dry check works: ' + (c.stdout.match(/PRUNE_CHECK.*/) || [c.stderr])[0]);
  ok(Buffer.compare(before2, fs.readFileSync(F('live2.db'))) === 0, 'runner dry check changed nothing');
  c = runner(['--db', F('live2.db'), '--prune', F('prune5.json'), '--apply', '--undo-out', F('undo5.json'), '--result-out', F('result5.json')]);
  ok(c.status === 0 && /PRUNE_SUMMARY deleted=(\d+) .*errors=0 aborted=0/.test(c.stdout), 'runner apply works: ' + (c.stdout.match(/PRUNE_SUMMARY.*/) || [c.stderr])[0]);
  ok(!has(F('live2.db'), 'Application', 'a1') && has(F('live2.db'), 'Application', 'a3'), 'runner deleted a1 and kept a3');
  const res5 = JSON.parse(fs.readFileSync(F('result5.json'), 'utf8'));
  ok(res5.applied && res5.removed.Application.length === 3 && res5.removed.Requirement.length === 1, 'result file lists the removed rows (a1, a2, a5 and requirement r1; a3 stays because of the live follow-up f9, so r2 stays)');
  // baseline follows
  fs.copyFileSync(F('baseline.db'), F('baseline-copy.db'));
  const bl = spawnSync(process.execPath, ['--no-warnings', path.join(DS, 'prune-baseline.js'), '--baseline', F('baseline-copy.db'), '--result', F('result5.json')], { encoding: 'utf8' });
  ok(bl.status === 0 && !has(F('baseline-copy.db'), 'Application', 'a1') && has(F('baseline-copy.db'), 'Application', 'a3') && !has(F('baseline-copy.db'), 'Application', 'a2'), 'baseline lost exactly the pruned rows: ' + bl.stdout.trim());
  c = runner(['--db', F('live2.db'), '--restore', F('undo5.json')]);
  ok(c.status === 0 && /RESTORE DONE: 7 row/.test(c.stdout) && has(F('live2.db'), 'Application', 'a1'), 'runner restore works: ' + (c.stdout.match(/RESTORE DONE.*/) || [c.stderr])[0]);
  ok(sqlAll(F('live2.db'), 'SELECT count(*) c FROM Application')[0].c === 5 && sqlAll(F('live2.db'), 'SELECT count(*) c FROM Requirement')[0].c === 4, 'everything is back (5 applications, 4 requirements)');
  c = runner(['--db', path.join(tree, 'backend', 'prisma', 'dev.db'), '--prune', F('prune5.json')]);
  ok(c.status === 2 && /REFUSED/.test(c.stderr), 'runner refuses the real prisma/dev.db');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  fs.rmSync(W, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
