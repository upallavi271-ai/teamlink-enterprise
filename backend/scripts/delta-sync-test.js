'use strict';
// delta-sync-test.js : proves the "changes-only push" works, using COPIES only.
//   node scripts/delta-sync-test.js
// It never opens prisma/dev.db for writing and never contacts the live site.
//   Part 1: synthetic local + synthetic "live" databases built from a copy of the baseline.
//   Part 2: READ-ONLY dry run of the real local database against the baseline -> a Markdown report.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DS = path.join(__dirname, 'delta-sync');
const L = require(path.join(DS, 'lib.js'));
const { makeDelta } = require(path.join(DS, 'make-delta.js'));
const { classify } = require(path.join(DS, 'classify-delta.js'));
const { updateBaseline } = require(path.join(DS, 'update-baseline.js'));
const report = require(path.join(DS, 'report.js'));

const REAL_DEV_DB = path.resolve(__dirname, '..', 'prisma', 'dev.db');
const BASELINE_ORIGINAL = process.env.BASELINE_ORIGINAL || 'C:\\Users\\user\\.teamlink-backups\\sync-baseline\\vps-at-pull-20261015-093919.db';
const OUT_MD = process.env.DELTA_REPORT_MD || 'C:\\Users\\user\\Desktop\\All_Projects\\TeamLink-Local-Changes-Since-Pull.md';

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-sync-test-'));
const F = (n) => path.join(W, n);
let pass = 0; let fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } }
function guard(file) {
  if (path.resolve(file).toLowerCase() === REAL_DEV_DB.toLowerCase()) throw new Error('REFUSED: test would touch prisma/dev.db');
  return file;
}
function rw(file) { guard(file); const d = L.openDb(file, false); d.exec('PRAGMA foreign_keys=OFF'); return d; }
function ro(file) { return L.openDb(file, true); }
function one(file, sql) { const d = ro(file); try { return d.prepare(sql).get(); } finally { d.close(); } }
function all(file, sql) { const d = ro(file); try { return d.prepare(sql).all(); } finally { d.close(); } }
function fingerprint(file) {
  const d = ro(file); const out = {};
  try {
    for (const t of L.listTables(d)) {
      const x = Buffer.alloc(16); let n = 0;
      const st = d.prepare('SELECT * FROM ' + L.qid(t)); st.setReadBigInts(true);
      for (const r of st.iterate()) { n++; const h = crypto.createHash('md5').update(Object.keys(r).map((k) => k + '=' + L.canon(r[k])).join('|')).digest(); for (let i = 0; i < 16; i++) x[i] ^= h[i]; }
      out[t] = n + ':' + x.toString('hex');
    }
  } finally { d.close(); }
  return out;
}
function sameFp(a, b) { const ks = new Set([...Object.keys(a), ...Object.keys(b)]); return [...ks].filter((k) => a[k] !== b[k]); }
function applyCli(args) {
  const r = spawnSync(process.execPath, [path.join(DS, 'apply-delta.js'), ...args], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 28 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function summaryOf(text) { const m = text.match(/APPLY_SUMMARY (.*)/); const o = {}; if (m) m[1].split(' ').forEach((p) => { const [k, v] = p.split('='); o[k] = Number(v); }); return o; }

(async () => {
  console.log('Working folder (copies only): ' + W);
  if (!fs.existsSync(BASELINE_ORIGINAL)) throw new Error('Baseline original not found: ' + BASELINE_ORIGINAL);

  // ------------------------------------------------------------------ PART 1
  console.log('\nPART 1: synthetic local + synthetic live site, built from a copy of the baseline');
  fs.copyFileSync(BASELINE_ORIGINAL, F('baseline.db'));          // only the .db file, never its -shm/-wal
  L.snapshotTo(F('baseline.db'), F('baseline-clean.db'), true);  // consistent, non-WAL copy
  fs.copyFileSync(F('baseline-clean.db'), F('baseline.db'));
  fs.copyFileSync(F('baseline.db'), F('local.db'));
  fs.copyFileSync(F('baseline.db'), F('vps.db'));
  const baseFp = fingerprint(F('baseline.db'));

  const cands = all(F('baseline.db'), "SELECT id,name,location,phone FROM Candidate WHERE name NOT LIKE '%ZZTEST%' ORDER BY id LIMIT 3");
  const X = cands[0]; const X2 = cands[1];
  const clients = all(F('baseline.db'), "SELECT id,name FROM Client ORDER BY id LIMIT 2");
  const Y = clients[0]; const Y2 = clients[1];
  const emp = one(F('baseline.db'), 'SELECT id FROM Employee ORDER BY id LIMIT 1').id;
  const hol = one(F('baseline.db'), 'SELECT id,name FROM Holiday ORDER BY id LIMIT 1');
  const usr = one(F('baseline.db'), 'SELECT id FROM User ORDER BY id LIMIT 1').id;
  const now = Date.now();

  // ---- LOCAL work ----
  let d = rw(F('local.db'));
  d.exec("INSERT INTO Candidate (id,name,email,createdAt,doNotContact) VALUES ('t-new-narendra','Narendra','narendra@realmail.in'," + now + ',0)');
  d.exec("UPDATE Candidate SET name='Ravindra EDITED-LOCAL' WHERE id='" + X.id + "'");
  d.exec("UPDATE Candidate SET phone='9000000001' WHERE id='" + X2.id + "'");
  d.exec("INSERT INTO Attendance (id,employeeId,date,status,createdAt) VALUES ('t-att-1','" + emp + "','2099-01-01','Present'," + now + ')');
  d.exec("DELETE FROM Holiday WHERE id='" + hol.id + "'");
  d.exec("INSERT INTO Notification (id,userId,title,createdAt) VALUES ('t-notif-1','" + usr + "','local bell'," + now + ')');
  d.exec("UPDATE Integration SET \"values\"='{\"LOCAL\":\"LOCAL-TOKEN-MUST-NOT-TRAVEL\"}' WHERE id='ai-claude'");
  d.exec("INSERT OR REPLACE INTO AppSetting (key,value,updatedAt) VALUES ('wa.settings','{\"token\":\"LOCAL-WA\"}'," + now + ")");
  d.exec("INSERT OR REPLACE INTO AppSetting (key,value,updatedAt) VALUES ('webhook.seen.abc','1'," + now + ")");
  d.exec("INSERT OR REPLACE INTO AppSetting (key,value,updatedAt) VALUES ('leave.meta.t-real','{\"note\":\"hello\"}'," + now + ")");
  d.exec("INSERT INTO Candidate (id,name,email,createdAt,doNotContact) VALUES ('t-zz-1','ZZTEST Person','zz@example.test'," + now + ',0)');
  d.exec("UPDATE Client SET name='Client-LOCAL-EDIT' WHERE id='" + Y.id + "'");
  d.exec("UPDATE Client SET name='Client2-LOCAL-EDIT' WHERE id='" + Y2.id + "'");
  d.exec("INSERT INTO Employee (id,employeeCode,name,createdAt,updatedAt) VALUES ('t-emp-clash','CLASH-1','Local Clash Person'," + now + ',' + now + ')');
  d.exec("INSERT INTO Attendance (id,employeeId,date,status,createdAt) VALUES ('t-att-child','t-emp-clash','2099-01-02','Present'," + now + ')');
  d.exec("UPDATE User SET lastLoginAt=" + now + ' WHERE id=' + "'" + usr + "'");
  d.exec("UPDATE Employee SET updatedAt=" + (now + 5) + " WHERE id='" + emp + "'");   // time-stamp only: not a change
  d.close();

  // ---- LIVE-SITE-only work ----
  d = rw(F('vps.db'));
  d.exec("INSERT INTO Employee (id,employeeCode,name,createdAt,updatedAt) VALUES ('v-emp-1','VPS-ONLY-1','Live Only Person'," + now + ',' + now + ')');
  d.exec("UPDATE Candidate SET location='LIVE-LOCATION' WHERE id='" + X.id + "'");
  d.exec("UPDATE Client SET name='Client-LIVE-EDIT' WHERE id='" + Y.id + "'");
  d.exec("INSERT INTO Employee (id,employeeCode,name,createdAt,updatedAt) VALUES ('v-emp-clash','CLASH-1','Live Clash Person'," + now + ',' + now + ')');
  d.exec("UPDATE Integration SET \"values\"='{\"LIVE\":\"LIVE-SECRET\"}' WHERE id='ai-claude'");
  d.exec("INSERT OR REPLACE INTO AppSetting (key,value,updatedAt) VALUES ('wa.settings','{\"token\":\"LIVE-WA\"}'," + now + ")");
  d.exec("INSERT INTO Notification (id,userId,title,createdAt) VALUES ('v-notif-1','" + usr + "','live bell'," + now + ')');
  d.exec("INSERT INTO Candidate (id,name,email,createdAt,doNotContact) VALUES ('v-cand-1','Live Candidate','lc@realmail.in'," + now + ',0)');
  d.exec("UPDATE Candidate SET location='LIVE-LOC2' WHERE id='" + X2.id + "'");
  d.close();
  const vpsBeforeFp = fingerprint(F('vps.db'));

  // ---- delta ----
  const delta = makeDelta({ baseline: F('baseline.db'), local: F('local.db'), out: F('delta.json') });
  const T = delta.tables;
  const opsOf = (t) => (T[t] ? T[t].ops : []);
  ok(opsOf('Candidate').some((o) => o.k === 'I' && o.pk[0] === 't-new-narendra'), 'delta has the new candidate Narendra');
  ok(opsOf('Candidate').some((o) => o.k === 'U' && o.pk[0] === X.id && o.changed.join() === 'name'), 'delta has the edited candidate name (only the name column)');
  ok(!opsOf('Candidate').some((o) => o.pk[0] === 't-zz-1'), 'delta does not contain the ZZTEST candidate');
  ok(!T.Notification && !T.Integration, 'delta has no Notification / Integration rows');
  ok(!opsOf('AppSetting').some((o) => o.pk[0] === 'wa.settings' || o.pk[0] === 'webhook.seen.abc'), 'delta has no wa.settings / webhook.seen AppSetting keys');
  ok(opsOf('AppSetting').some((o) => o.pk[0] === 'leave.meta.t-real'), 'delta has the allowed AppSetting key leave.meta.*');
  ok(delta.excluded.appSettings.some((a) => a.key === 'wa.settings') && delta.excluded.appSettings.some((a) => a.key === 'webhook.seen.abc'), 'excluded AppSetting keys are listed for the founder');
  ok(delta.deletes.some((x) => x.table === 'Holiday' && x.pk[0] === hol.id), 'the deleted Holiday is reported as a delete (report only)');
  ok(!opsOf('User').length, 'User.lastLoginAt change ignored (login counter)');
  ok(!opsOf('Employee').some((o) => o.pk[0] === emp), 'time-stamp-only change (updatedAt) is not a change');

  // ---- dry run against a copy of the live site ----
  fs.copyFileSync(F('vps.db'), F('vps-readonly-copy.db'));
  const dry = await classify(delta, F('vps-readonly-copy.db'));
  const stOf = (id) => dry.results.find((r) => r.id === id).status;
  const opId = (t, pk, k) => opsOf(t).find((o) => o.pk[0] === pk && (!k || o.k === k)).id;
  ok(stOf(opId('Candidate', 't-new-narendra')) === 'applied', 'dry run: Narendra will be added');
  ok(stOf(opId('Candidate', X.id)) === 'applied', 'dry run: candidate name edit merges (live edited a different column)');
  ok(stOf(opId('Client', Y.id)) === 'conflict', 'dry run: same-column client edit is a CONFLICT');
  ok(stOf(opId('Employee', 't-emp-clash')) === 'conflict', 'dry run: unique employeeCode clash is a CONFLICT');
  ok(stOf(opId('Attendance', 't-att-child')) === 'blocked', 'dry run: row that depends on the clashed employee is held back');
  ok(!sameFp(vpsBeforeFp, fingerprint(F('vps-readonly-copy.db'))).length, 'dry run changed nothing');
  const txt = report.format(delta, dry, 'dry');
  ok(/Client-LOCAL-EDIT/.test(txt) && /Client-LIVE-EDIT/.test(txt), 'report shows both versions of a conflict');

  // ---- apply for real (through the live-server applier, on the copy) ----
  const ap = applyCli(['--delta', F('delta.json'), '--db', F('vps.db'), '--apply', '--undo-out', F('undo.json'), '--result-out', F('result.json')]);
  if (ap.code !== 0) console.log(ap.out.slice(-2500));
  ok(ap.code === 0, 'apply-delta.js ran with exit code 0');
  const s1 = summaryOf(ap.out);
  const v = (sql) => one(F('vps.db'), sql);
  ok(v("SELECT name FROM Candidate WHERE id='t-new-narendra'")?.name === 'Narendra', 'LANDED: new candidate Narendra');
  ok(v("SELECT name FROM Candidate WHERE id='" + X.id + "'").name === 'Ravindra EDITED-LOCAL', 'LANDED: edited candidate name');
  ok(v("SELECT location FROM Candidate WHERE id='" + X.id + "'").location === 'LIVE-LOCATION', 'MERGED: the live edit of another column of the same row survived');
  ok(v("SELECT phone FROM Candidate WHERE id='" + X2.id + "'").phone === '9000000001' && v("SELECT location FROM Candidate WHERE id='" + X2.id + "'").location === 'LIVE-LOC2', 'MERGED: second row, both sides kept');
  ok(v("SELECT count(*) c FROM Attendance WHERE id='t-att-1'").c === 1, 'LANDED: attendance row');
  ok(v("SELECT count(*) c FROM AppSetting WHERE key='leave.meta.t-real'").c === 1, 'LANDED: allowed AppSetting key');
  ok(v("SELECT name FROM Client WHERE id='" + Y.id + "'").name === 'Client-LIVE-EDIT', 'CONFLICT NOT APPLIED: client keeps the live value');
  ok(v("SELECT name FROM Client WHERE id='" + Y2.id + "'").name === 'Client2-LOCAL-EDIT', 'LANDED: a different client edit with no conflict');
  ok(v("SELECT count(*) c FROM Employee WHERE id='t-emp-clash'").c === 0 && v("SELECT name FROM Employee WHERE id='v-emp-clash'").name === 'Live Clash Person', 'UNIQUE CLASH NOT APPLIED: live employee kept, local one not added');
  ok(v("SELECT count(*) c FROM Attendance WHERE id='t-att-child'").c === 0, 'dependent row not added');
  ok(v("SELECT count(*) c FROM Holiday WHERE id='" + hol.id + "'").c === 1, 'DELETE NOT APPLIED: holiday still on the live site');
  ok(v("SELECT name FROM Employee WHERE id='v-emp-1'").name === 'Live Only Person' && v("SELECT name FROM Candidate WHERE id='v-cand-1'").name === 'Live Candidate', 'LIVE-ONLY rows untouched');
  ok(v("SELECT \"values\" v FROM Integration WHERE id='ai-claude'").v === '{"LIVE":"LIVE-SECRET"}', 'CREDENTIALS: live Integration row not overwritten');
  ok(v("SELECT value FROM AppSetting WHERE key='wa.settings'").value === '{"token":"LIVE-WA"}' && v("SELECT count(*) c FROM AppSetting WHERE key='webhook.seen.abc'").c === 0, 'CREDENTIALS: wa.settings / webhook.seen not copied');
  ok(v("SELECT count(*) c FROM Notification WHERE id='t-notif-1'").c === 0, 'EXCLUDED: local Notification not copied');
  ok(v("SELECT count(*) c FROM Candidate WHERE id='t-zz-1'").c === 0, 'ZZTEST candidate not copied');
  ok(v("SELECT count(*) c FROM Candidate WHERE name LIKE '%ZZTEST%'").c === one(F('baseline.db'), "SELECT count(*) c FROM Candidate WHERE name LIKE '%ZZTEST%'").c, 'no ZZTEST rows appeared on the live copy');
  // everything else identical to before, except the expected rows
  const afterFp = fingerprint(F('vps.db'));
  const changedTables = sameFp(vpsBeforeFp, afterFp).sort();
  const expectTables = ['Candidate', 'Attendance', 'AppSetting', 'Client'].sort();
  ok(JSON.stringify(changedTables) === JSON.stringify(expectTables), 'ONLY these tables changed on the live copy: ' + changedTables.join(', '));
  const res1 = L.readJson(F('result.json'));
  ok(res1.counts.conflicts === 2 && res1.counts.blocked === 1, 'result: 2 conflicts, 1 held back (' + JSON.stringify(res1.counts) + ')');

  // ---- second apply = no-op ----
  const fpMid = fingerprint(F('vps.db'));
  const ap2 = applyCli(['--delta', F('delta.json'), '--db', F('vps.db'), '--apply', '--undo-out', F('undo2.json'), '--result-out', F('result2.json')]);
  const s2 = summaryOf(ap2.out);
  ok(ap2.code === 0 && s2.added === 0 && s2.changed === 0, 'IDEMPOTENT: second apply adds/changes nothing (' + ap2.out.match(/APPLY_SUMMARY.*/)?.[0] + ')');
  ok(!sameFp(fpMid, fingerprint(F('vps.db'))).length, 'IDEMPOTENT: database identical after the second apply');
  ok(L.readJson(F('undo2.json')).ops.length === 0, 'second apply wrote an empty undo file');

  // ---- baseline advances by exactly the applied ops ----
  fs.copyFileSync(F('baseline.db'), F('baseline-before.db'));
  const upd = await updateBaseline(F('baseline.db'), delta, res1);
  ok(fs.existsSync(F('baseline.prev.db')) && !sameFp(baseFp, fingerprint(F('baseline.prev.db'))).length, 'baseline.prev.db is the old baseline');
  const everything = { appSetting: { allowPrefixes: [''] }, excludedTables: {}, excludedNamePatterns: [], alwaysPushTables: {}, softColumns: [], ignoreColumns: {} };
  const dd = makeDelta({ baseline: F('baseline-before.db'), local: F('baseline.db'), config: everything });
  const expectedMoved = res1.statuses.filter((s) => s.status === 'applied' || s.status === 'already').length;
  ok(dd.summary.inserts + dd.summary.updates === expectedMoved && upd.advanced === expectedMoved, 'baseline moved by exactly ' + expectedMoved + ' applied ops (' + (dd.summary.inserts + dd.summary.updates) + ' rows differ)');
  const d2 = makeDelta({ baseline: F('baseline.db'), local: F('local.db') });
  const left = [];
  for (const t of d2.order) for (const o of d2.tables[t].ops) left.push(t + ':' + o.pk[0]);
  ok(left.sort().join() === ['Client:' + Y.id, 'Employee:t-emp-clash', 'Attendance:t-att-child'].sort().join(), 'next delta contains only the conflicts + the held-back row: ' + left.join(', '));
  ok(d2.deletes.length === 1, 'the local delete still shows next time (report only)');

  // ---- undo restores the target exactly ----
  const un = applyCli(['--revert', F('undo.json'), '--db', F('vps.db')]);
  if (un.code !== 0) console.log(un.out.slice(-1500));
  const diffAfterUndo = sameFp(vpsBeforeFp, fingerprint(F('vps.db')));
  ok(un.code === 0 && !diffAfterUndo.length, 'UNDO restores the live copy exactly' + (diffAfterUndo.length ? ' (differs: ' + diffAfterUndo.join(',') + ')' : ''));

  // ---- foreign-key rollback ----
  fs.copyFileSync(F('baseline-clean.db'), F('fk-local.db'));
  fs.copyFileSync(F('baseline-clean.db'), F('fk-vps.db'));
  d = rw(F('fk-local.db'));
  d.exec("INSERT INTO Holiday (id,name,date) VALUES ('t-hol-new','Test Holiday FK','2099-05-05')");
  d.exec("INSERT INTO Application (id,candidateId,requirementId,stage,createdAt,updatedAt) VALUES ('t-app-broken','no-such-candidate','no-such-req','Applied'," + now + ',' + now + ')');
  d.close();
  const fkDelta = makeDelta({ baseline: F('baseline-clean.db'), local: F('fk-local.db'), out: F('fk-delta.json') });
  const fkBefore = fingerprint(F('fk-vps.db'));
  const fk = applyCli(['--delta', F('fk-delta.json'), '--db', F('fk-vps.db'), '--apply', '--undo-out', F('fk-undo.json'), '--result-out', F('fk-result.json')]);
  ok(fk.code === 3 && /SAFETY STOP/.test(fk.out), 'FK check found the broken link and stopped (exit 3)');
  ok(!sameFp(fkBefore, fingerprint(F('fk-vps.db'))).length, 'FK rollback: NOTHING changed (even the harmless holiday was rolled back)');
  ok(fkDelta.summary.inserts === 2, 'FK scenario delta had 2 new rows');

  // ---- schema parity: refuse a table with a one-sided required column ----
  fs.copyFileSync(F('baseline-clean.db'), F('par-vps.db'));
  fs.copyFileSync(F('baseline-clean.db'), F('par-local.db'));
  d = rw(F('par-vps.db'));
  // NOT NULL without default cannot be added with ALTER; emulate by rebuilding the table
  d.exec('CREATE TABLE Holiday2 AS SELECT * FROM Holiday'); d.exec('DROP TABLE Holiday');
  d.exec('CREATE TABLE Holiday (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, type TEXT DEFAULT \'Festival\', mustHave TEXT NOT NULL)');
  d.exec("INSERT INTO Holiday SELECT id,name,date,createdAt,type,'x' FROM Holiday2"); d.exec('DROP TABLE Holiday2'); d.close();
  d = rw(F('par-local.db')); d.exec("INSERT INTO Holiday (id,name,date) VALUES ('t-hol-par','Parity Holiday','2099-06-06')"); d.close();
  const parDelta = makeDelta({ baseline: F('baseline-clean.db'), local: F('par-local.db'), out: F('par-delta.json') });
  const parDry = await classify(parDelta, F('par-vps.db'));
  ok(Object.keys(parDry.refused).includes('Holiday') && /mustHave/.test(parDry.refused.Holiday), 'PARITY: table with a one-sided required column is refused with a clear reason');

  // ---- the guard itself ----
  let refused = false; try { guard(REAL_DEV_DB); } catch { refused = true; }
  ok(refused, 'the test refuses to touch prisma/dev.db');

  // ------------------------------------------------------------------ PART 3
  console.log('\nPART 3: TWO-WAY sync (changes on both sides) on copies');
  const cmpLib = require(path.join(DS, 'compare-dbs.js'));
  let runNo = 0;
  async function twoWay(base, loc, live, o) {
    o = o || {}; runNo++;
    const p = (n) => F('tw' + runNo + '-' + n);
    const dl = makeDelta({ baseline: base, local: loc, out: p('dl.json') });
    const dv = makeDelta({ baseline: base, local: live, out: p('dv.json') });
    const apL = applyCli(['--delta', p('dl.json'), '--db', live, '--apply'].concat(o.preferLocal ? ['--prefer'] : [], ['--undo-out', p('undo-live.json'), '--result-out', p('rl.json')]));
    const apV = applyCli(['--delta', p('dv.json'), '--db', loc, '--apply'].concat(o.preferVps ? ['--prefer'] : [], ['--undo-out', p('undo-local.json'), '--result-out', p('rv.json')]));
    if (apL.code !== 0 || apV.code !== 0) console.log(apL.out.slice(-800) + apV.out.slice(-800));
    const rl = L.readJson(p('rl.json')); const rv = L.readJson(p('rv.json'));
    await updateBaseline(base, dl, rl, [loc, live]);
    await updateBaseline(base, dv, rv, [loc, live]);
    return { dl, dv, rl, rv, apL, apV, files: { dl: p('dl.json'), dv: p('dv.json'), rl: p('rl.json'), rv: p('rv.json'), ul: p('undo-live.json'), uv: p('undo-local.json') } };
  }
  const mkCopies = (tag) => { for (const n of ['base', 'local', 'live']) fs.copyFileSync(F('baseline-clean.db'), F(tag + '-' + n + '.db')); return { base: F(tag + '-base.db'), loc: F(tag + '-local.db'), live: F(tag + '-live.db') }; };
  const q1 = (f, sql) => one(f, sql);

  const S = mkCopies('s3');
  const hols = all(S.base, 'SELECT id FROM Holiday ORDER BY id LIMIT 2');
  const XA = cands[0]; const XB = cands[1];
  d = rw(S.loc);
  d.exec("INSERT INTO Candidate (id,name,createdAt,doNotContact) VALUES ('l-new','Loc New'," + now + ',0)');
  d.exec("UPDATE Candidate SET name='XA-LOCAL' WHERE id='" + XA.id + "'");
  d.exec("UPDATE Candidate SET phone='9111111111' WHERE id='" + XB.id + "'");
  d.exec("UPDATE Client SET name='Y-LOCAL' WHERE id='" + Y.id + "'");
  d.exec("UPDATE Client SET name='Y2-LOCAL' WHERE id='" + Y2.id + "'");
  d.exec("DELETE FROM Holiday WHERE id='" + hols[0].id + "'");
  d.exec("UPDATE Integration SET \"values\"='{\"L\":\"LOCAL-SECRET\"}' WHERE id='ai-claude'");
  d.exec("INSERT INTO Candidate (id,name,email,createdAt,doNotContact) VALUES ('l-zz','ZZTEST L','a@example.test'," + now + ',0)');
  d.exec("INSERT INTO AppSetting (key,value,updatedAt) VALUES ('leave.meta.l-key','{\"a\":1}'," + now + ')');
  d.close();
  d = rw(S.live);
  d.exec("INSERT INTO Candidate (id,name,createdAt,doNotContact) VALUES ('v-new','Vps New'," + now + ',0)');
  d.exec("INSERT INTO Employee (id,employeeCode,name,createdAt,updatedAt) VALUES ('v3-emp','V3-EMP','Vps Employee'," + now + ',' + now + ')');
  d.exec("UPDATE Candidate SET location='V-LOC' WHERE id='" + XB.id + "'");
  d.exec("UPDATE Client SET name='Y-VPS' WHERE id='" + Y.id + "'");
  d.exec("UPDATE Client SET name='Y2-VPS' WHERE id='" + Y2.id + "'");
  d.exec("DELETE FROM Holiday WHERE id='" + hols[1].id + "'");
  d.exec("UPDATE Integration SET \"values\"='{\"V\":\"LIVE-SECRET\"}' WHERE id='ai-claude'");
  d.exec("INSERT INTO Candidate (id,name,email,createdAt,doNotContact) VALUES ('v-zz','ZZTEST V','b@example.test'," + now + ',0)');
  d.exec("INSERT INTO AppSetting (key,value,updatedAt) VALUES ('leave.meta.v-key','{\"b\":1}'," + now + ')');
  d.close();
  const locPre = fingerprint(S.loc); const livePre = fingerprint(S.live);

  const run1 = await twoWay(S.base, S.loc, S.live);
  ok(run1.apL.code === 0 && run1.apV.code === 0, 'two-way: both applies ran (exit 0)');
  const lv = (sql) => q1(S.loc, sql); const vv = (sql) => q1(S.live, sql);
  ok(vv("SELECT name n FROM Candidate WHERE id='l-new'").n === 'Loc New' && lv("SELECT name n FROM Candidate WHERE id='v-new'").n === 'Vps New', 'both sides got the other side new candidate');
  ok(lv("SELECT name n FROM Employee WHERE id='v3-emp'").n === 'Vps Employee', 'localhost got the live-only employee');
  ok(vv("SELECT name n FROM Candidate WHERE id='" + XA.id + "'").n === 'XA-LOCAL', 'live site got the local name edit');
  const xbL = lv("SELECT phone p, location l FROM Candidate WHERE id='" + XB.id + "'");
  const xbV = vv("SELECT phone p, location l FROM Candidate WHERE id='" + XB.id + "'");
  ok(xbL.p === '9111111111' && xbL.l === 'V-LOC' && xbV.p === '9111111111' && xbV.l === 'V-LOC', 'same row, different columns: BOTH sides hold both edits');
  ok(lv("SELECT name n FROM Client WHERE id='" + Y.id + "'").n === 'Y-LOCAL' && vv("SELECT name n FROM Client WHERE id='" + Y.id + "'").n === 'Y-VPS', 'same column conflict: untouched on BOTH sides');
  ok(lv("SELECT count(*) c FROM Holiday WHERE id='" + hols[1].id + "'").c === 1 && vv("SELECT count(*) c FROM Holiday WHERE id='" + hols[0].id + "'").c === 1 && vv("SELECT count(*) c FROM Holiday WHERE id='" + hols[1].id + "'").c === 0 && lv("SELECT count(*) c FROM Holiday WHERE id='" + hols[0].id + "'").c === 0, 'deletes were NOT copied either way (each side keeps its own state)');
  ok(lv("SELECT \"values\" v FROM Integration WHERE id='ai-claude'").v === '{"L":"LOCAL-SECRET"}' && vv("SELECT \"values\" v FROM Integration WHERE id='ai-claude'").v === '{"V":"LIVE-SECRET"}', 'excluded credentials untouched on both sides');
  ok(vv("SELECT count(*) c FROM Candidate WHERE id='l-zz'").c === 0 && lv("SELECT count(*) c FROM Candidate WHERE id='v-zz'").c === 0, 'ZZTEST rows crossed in neither direction');
  ok(vv("SELECT count(*) c FROM AppSetting WHERE key='leave.meta.l-key'").c === 1 && lv("SELECT count(*) c FROM AppSetting WHERE key='leave.meta.v-key'").c === 1, 'allowed AppSetting keys crossed both ways');
  // comparison report
  const cmp1 = cmpLib.compare({ a: S.loc, b: S.live, dl: run1.files.dl, dv: run1.files.dv, rl: run1.files.rl, rv: run1.files.rv });
  const crow = (t) => cmp1.rows.find((r) => r.table === t);
  ok(crow('Candidate').same && crow('Employee').same && crow('AppSetting').same, 'COMPARE: Candidate / Employee / AppSetting are the same on both sides');
  ok(!crow('Client').same && crow('Client').unexplained === 0, 'COMPARE: Client differs only because of the explained conflicts');
  ok(!crow('Holiday').same && crow('Holiday').unexplained === 0, 'COMPARE: Holiday differs only because of the explained deletes');
  ok(cmp1.sum.allSameOrExplained && cmp1.excludedInfo.some((x) => x.table === 'Integration'), 'COMPARE: nothing unexplained; excluded tables are listed');
  const mdText = cmpLib.toMarkdown(cmp1, {});
  ok(/\| Candidate \| \d+ \| \d+ \| yes \|/.test(mdText) && /Different on purpose/.test(mdText), 'COMPARE: the markdown has the table and the explanation section');
  // a difference nobody explained must be called UNEXPLAINED
  fs.copyFileSync(S.live, F('s3-live-tamper.db'));
  d = rw(F('s3-live-tamper.db')); d.exec("UPDATE Candidate SET name='TAMPERED' WHERE id='" + XA.id + "'"); d.close();
  const cmpBad = cmpLib.compare({ a: S.loc, b: F('s3-live-tamper.db'), dl: run1.files.dl, dv: run1.files.dv, rl: run1.files.rl, rv: run1.files.rv });
  ok(!cmpBad.sum.allSameOrExplained && cmpBad.rows.find((r) => r.table === 'Candidate').unexplained === 1, 'COMPARE: an unexplained difference is reported as UNEXPLAINED');
  // undo restores BOTH sides exactly
  fs.copyFileSync(S.loc, F('s3-local-u.db')); fs.copyFileSync(S.live, F('s3-live-u.db'));
  const u1 = applyCli(['--revert', run1.files.ul, '--db', F('s3-live-u.db')]); const u2 = applyCli(['--revert', run1.files.uv, '--db', F('s3-local-u.db')]);
  const dU1 = sameFp(livePre, fingerprint(F('s3-live-u.db'))); const dU2 = sameFp(locPre, fingerprint(F('s3-local-u.db')));
  ok(u1.code === 0 && u2.code === 0 && !dU1.length && !dU2.length, 'UNDO restores both the live copy and the local copy exactly' + (dU1.length || dU2.length ? ' (differs: ' + dU1.concat(dU2).join(',') + ')' : ''));
  // second run: nothing new except the conflicts, and nothing changes
  const fpL = fingerprint(S.loc); const fpV = fingerprint(S.live);
  const run2 = await twoWay(S.base, S.loc, S.live);
  const ops2 = (dd) => dd.order.map((t) => dd.tables[t].ops.map((o) => t + ':' + o.pk[0])).flat().sort();
  const want2 = ['Client:' + Y.id, 'Client:' + Y2.id].sort();
  ok(JSON.stringify(ops2(run2.dl)) === JSON.stringify(want2) && JSON.stringify(ops2(run2.dv)) === JSON.stringify(want2), 'second run: only the 2 conflicts remain on each side');
  ok(!sameFp(fpL, fingerprint(S.loc)).length && !sameFp(fpV, fingerprint(S.live)).length, 'second run is a NO-OP on both sides (conflicts still untouched)');
  // -Prefer Local
  const run3 = await twoWay(S.base, S.loc, S.live, { preferLocal: true });
  ok(vv("SELECT name n FROM Client WHERE id='" + Y.id + "'").n === 'Y-LOCAL' && vv("SELECT name n FROM Client WHERE id='" + Y2.id + "'").n === 'Y2-LOCAL' && lv("SELECT name n FROM Client WHERE id='" + Y.id + "'").n === 'Y-LOCAL', '-Prefer Local: the local value won on the live site, local unchanged');
  ok(L.readJson(run3.files.ul).ops.some((u) => u.k === 'restore' && u.set.name === "'Y-VPS'"), '-Prefer Local: the overwritten live value is saved in the undo file');
  ok(cmpLib.compare({ a: S.loc, b: S.live }).rows.find((r) => r.table === 'Client').same, 'after -Prefer Local the Client table is the same on both sides');

  // -Prefer VPS on a fresh pair, and "auto" (no prefer) never resolving
  const P = mkCopies('s4');
  d = rw(P.loc); d.exec("UPDATE Client SET name='P-LOCAL' WHERE id='" + Y.id + "'"); d.close();
  d = rw(P.live); d.exec("UPDATE Client SET name='P-VPS' WHERE id='" + Y.id + "'"); d.close();
  const noPref = await twoWay(P.base, P.loc, P.live);
  ok(q1(P.loc, "SELECT name n FROM Client WHERE id='" + Y.id + "'").n === 'P-LOCAL' && q1(P.live, "SELECT name n FROM Client WHERE id='" + Y.id + "'").n === 'P-VPS' && noPref.rl.counts.conflicts === 1, 'AUTO-like run (no -Prefer) never resolves a conflict');
  const withVps = await twoWay(P.base, P.loc, P.live, { preferVps: true });
  ok(q1(P.loc, "SELECT name n FROM Client WHERE id='" + Y.id + "'").n === 'P-VPS' && q1(P.live, "SELECT name n FROM Client WHERE id='" + Y.id + "'").n === 'P-VPS' && withVps.rv.counts.changed === 1, '-Prefer VPS: the live value won on localhost');

  // auto-mode guards in the PowerShell script (desk check)
  const sb = fs.readFileSync(path.resolve(__dirname, '..', '..', 'sync-both.ps1'), 'utf8');
  ok(/-Auto never prefers a side/.test(sb) && /BatchMode=yes/.test(sb) && /SYNC BOTH/.test(sb), 'sync-both.ps1 refuses -Auto with -Prefer, uses ssh BatchMode, asks SYNC BOTH');

  // ------------------------------------------------------------------ PART 2
  console.log('\nPART 2: READ-ONLY dry run of the real local database against the baseline');
  const realLocalSnap = F('real-local-snapshot.db');
  L.snapshotTo(REAL_DEV_DB, realLocalSnap, true);   // read-only open of dev.db; VACUUM INTO writes only the snapshot
  fs.copyFileSync(BASELINE_ORIGINAL, F('real-baseline.db'));
  L.snapshotTo(F('real-baseline.db'), F('real-baseline-clean.db'), true);
  const realDelta = makeDelta({ baseline: F('real-baseline-clean.db'), local: realLocalSnap, out: F('real-delta.json') });
  const realOut = await classify(realDelta, F('real-baseline-clean.db')); // baseline itself as a stand-in for the live site
  const text = report.format(realDelta, realOut, 'dry');
  const c = report.counts(realOut);
  const md = [];
  md.push('# TeamLink: what changed on localhost since the pull of 15 Oct 09:39');
  md.push('');
  md.push('Made automatically on ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC by `backend/scripts/delta-sync-test.js`. READ-ONLY: localhost database was only read, the live site was not contacted (the baseline copy stands in for the live site, so "conflicts" cannot show here).');
  md.push('');
  md.push('**Headline:** ' + c.added + ' new rows and ' + c.changed + ' changed rows would be pushed. ' + realDelta.deletes.length + ' deleted rows (never applied).');
  md.push('');
  md.push('## Notable names');
  const notable = realOut.results.filter((r) => r.status === 'applied' && !/^(AppSetting|AuditLog|AssetAuditLog|AttendancePunch|AttendanceHistory|ApprovalStep|LeaveRequest|Attendance)$/.test(r.table));
  for (const r of notable.slice(0, 40)) {
    if (r.k === 'I') md.push('- NEW ' + r.table + (r.label ? ': ' + r.label : ''));
    else md.push('- EDIT ' + r.table + (r.label ? ': ' + r.label : '') + ' (' + ((r.detail && r.detail.columns) || []).slice(0, 3).map((x) => x.column + ' ' + x.baseline + ' => ' + x.local).join('; ') + ')');
  }
  md.push('');
  md.push('## Full report');
  md.push('```');
  md.push(text);
  md.push('```');
  fs.writeFileSync(OUT_MD, md.join('\n'));
  console.log('  Real dry run: ' + c.added + ' new, ' + c.changed + ' changed, ' + realDelta.deletes.length + ' deletes (not applied). Report -> ' + OUT_MD);
  ok(c.added + c.changed > 0 && !sameFp({}, {}).length, 'real dry run produced a report');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(W, { recursive: true, force: true }); } catch { /* leave it */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED: ' + (e.stack || e)); process.exit(2); });
