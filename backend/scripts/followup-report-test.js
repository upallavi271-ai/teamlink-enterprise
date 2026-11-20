#!/usr/bin/env node
/**
 * THE TEAM FOLLOW-UP REPORT (founder 2026-11-20): a TL reads all their recruiters' follow-ups in one place, a recruiter only their own.
 * Two TLs with two recruiters each (+ a TL under another STL), follow-ups on known IST days incl. 23:59 / 00:00, overdue, carried over,
 * an imported one, a handed-over candidate and a recruiter who left. Every column, the day / week / month tables, the Excel, the scope.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4261 node scripts/followup-report-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-furep-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4261;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'furep-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const old = new Date(Date.now() - 3600e3);
const Z = (s) => new Date(s); // an instant, written in UTC ("...Z")

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const DEPT = `Fur${P}`;
  const mk = async (tag, role, extra = {}) => {
    const dept = extra.dept || DEPT;
    const u = await prisma.user.create({ data: { name: `Fur ${tag} ${P}`, email: `fur.${tag}.${P}@fur-test.in`, passwordHash: 'x', status: extra.status || 'Active', role: extra.sysRole || (role === 'RECRUITER' ? 'EMPLOYEE' : role), atsRole: role, atsDepartment: dept, atsAccess: true, passwordChangedAt: old } });
    const e = await prisma.employee.create({ data: { userId: u.id, employeeCode: `FUR${tag}${P}`, name: u.name, department: dept, team: extra.team || null, employmentStatus: extra.employment || 'Active' } });
    return { u, e };
  };
  const seat = async (code, kind, holder, team, reportsToId, dept = DEPT) => {
    const p = await prisma.position.create({ data: { code: `${code}-${P}`, name: code, department: dept, team, kind, reportsToId: reportsToId || null, active: true } });
    if (holder) await prisma.positionAssignment.create({ data: { positionId: p.id, employeeId: holder.e.id, fromDate: '2026-01-01' } });
    return p;
  };
  const stl = await mk('stl', 'STL'); const stl2 = await mk('stl2', 'STL');
  const tl1 = await mk('tl1', 'TL', { team: 'Team A' }); const tl2 = await mk('tl2', 'TL', { team: 'Team B' }); const tl3 = await mk('tl3', 'TL', { team: 'Team C' });
  const r1a = await mk('r1a', 'RECRUITER', { team: 'Team A' }); const r1b = await mk('r1b', 'RECRUITER', { team: 'Team A' });
  const r2a = await mk('r2a', 'RECRUITER', { team: 'Team B' }); const r2b = await mk('r2b', 'RECRUITER', { team: 'Team B' });
  const r3a = await mk('r3a', 'RECRUITER', { team: 'Team C' });
  const r1x = await mk('r1x', 'RECRUITER', { team: 'Team A', status: 'Inactive', employment: 'Relieved' }); // sat under TL1 until 2026-10-07, then left
  const mgr = await mk('mgr', 'MANAGER', { sysRole: 'MANAGER' });
  const bde = await mk('bde', 'BDE', { dept: 'BDE' });
  const hr = await mk('hr', 'HR', { dept: 'HR' });
  const sSTL = await seat('STL', 'STL', stl, null); const sSTL2 = await seat('STL2', 'STL', stl2, null);
  const sTL1 = await seat('TL1', 'TL', tl1, 'Team A', sSTL.id); const sTL2 = await seat('TL2', 'TL', tl2, 'Team B', sSTL.id); const sTL3 = await seat('TL3', 'TL', tl3, 'Team C', sSTL2.id);
  const sR1a = await seat('R1A', 'RECRUITER', r1a, 'Team A', sTL1.id); const sR1b = await seat('R1B', 'RECRUITER', r1b, 'Team A', sTL1.id);
  const sR1x = await seat('R1X', 'RECRUITER', null, 'Team A', sTL1.id);
  await prisma.positionAssignment.create({ data: { positionId: sR1x.id, employeeId: r1x.e.id, fromDate: '2026-01-01', toDate: '2026-10-07' } });
  await seat('R2A', 'RECRUITER', r2a, 'Team B', sTL2.id); await seat('R2B', 'RECRUITER', r2b, 'Team B', sTL2.id); await seat('R3A', 'RECRUITER', r3a, 'Team C', sTL3.id);

  const client = await prisma.client.findFirst({});
  const mkReq = (tag, tl, recs) => prisma.requirement.create({ data: { title: `Fur job ${tag} ${P}`, clientId: client.id, department: DEPT, status: 'RECRUITER_ASSIGNED', tlId: tl.u.id, recruiterId: recs[0].u.id, recruiterIds: recs.map((r) => r.u.id).join(',') } });
  const reqA = await mkReq('A', tl1, [r1a]); const reqB = await mkReq('B', tl1, [r1b]); const reqC = await mkReq('C', tl2, [r2a]); const reqD = await mkReq('D', tl2, [r2b]); const reqE = await mkReq('E', tl3, [r3a]);
  let n = 0;
  const cand = (tag) => { n += 1; return prisma.candidate.create({ data: { name: `Fur Person ${tag} ${P}`, phone: `7${String(P + n * 977).padStart(9, '5').slice(-9)}`, email: `fur.person.${tag}.${P}@fur-test.in` } }); };
  const app = async (c, req, owner) => prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage: 'SOURCED', ownerRecruiterId: owner.u.id } });
  const person = async (tag, req, owner) => { const c = await cand(tag); return { c, a: await app(c, req, owner) }; };
  const task = (who, p, o) => prisma.applicationFollowUp.create({
    data: {
      applicationId: p.a.id, candidateId: p.c.id, ownerUserId: who.u.id, ownerName: who.u.name, ownerRole: 'Recruiter', createdById: who.u.id, createdByName: who.u.name, purpose: 'Follow-up test', nextAction: 'Call', ...o,
    },
  });
  const quick = (who, p, createdAt, body) => prisma.candidateMessage.create({ data: { candidateId: p.c.id, applicationId: p.a.id, channel: 'Call', template: 'QUICK_LOG', templateLabel: 'Follow-up', trigger: 'Manual', recipient: '9999999999', body, status: 'LOGGED', senderUserId: who.u.id, senderName: who.u.name, createdAt } });
  const comment = (who, p, onDate, note) => {
    const id = `fu${P}${Math.random().toString(16).slice(2, 8)}`;
    return prisma.appSetting.create({ data: { key: `candlog.${p.c.id}.${id}`, value: JSON.stringify({ id, candidateId: p.c.id, applicationId: p.a.id, onDate, note, byId: who.u.id, byName: who.u.name, byRole: 'Recruiter', createdAt: `${onDate}T08:00:00.000Z`, source: 'manual' }), updatedById: who.u.id, updatedByName: who.u.name } }).then(() => id);
  };

  // ---- R1a (Team A): the numbers worked out by hand (range Mon 2026-10-05 .. Sun 2026-10-11)
  const X = {};
  for (const k of ['t1', 't2', 't3', 't4', 'ti', 'h', 'q1', 'q3', 'q4', 'q5', 'cm', 'b1', 'x1', 'x2', 'tl', 's1', 'r2a', 'r2b', 'r3']) X[k] = null;
  X.t1 = await person('t1', reqA, r1a); X.t2 = await person('t2', reqA, r1a); X.t3 = await person('t3', reqA, r1a); X.t4 = await person('t4', reqA, r1a); X.ti = await person('ti', reqA, r1a);
  X.h = await person('handover', reqA, r1a); X.q1 = await person('q1', reqA, r1a); X.q3 = await person('q3', reqA, r1a); X.q4 = await person('q4', reqA, r1a); X.q5 = await person('q5', reqA, r1a); X.cm = await person('cm', reqA, r1a);
  await task(r1a, X.t1, { createdAt: Z('2026-10-06T18:29:00Z'), dueDate: '2026-10-08', completedAt: Z('2026-10-08T18:29:00Z'), completedById: r1a.u.id, outcome: 'Interested' }); // added Oct 6 23:59 IST; done Oct 8 23:59 IST: on time
  await task(r1a, X.t2, { createdAt: Z('2026-10-06T18:30:00Z'), dueDate: '2026-10-08', completedAt: Z('2026-10-08T18:30:00Z'), completedById: r1a.u.id, outcome: 'Not Interested' }); // added Oct 7 00:00 IST; done Oct 9 00:00 IST: late
  await task(r1a, X.t3, { createdAt: Z('2026-10-07T06:00:00Z'), dueDate: '2026-10-09' }); // open, overdue
  await task(r1a, X.t4, { createdAt: Z('2026-09-28T06:00:00Z'), dueDate: '2026-10-02' }); // open, carried over into the week
  await prisma.applicationFollowUp.create({ data: { applicationId: X.ti.a.id, candidateId: X.ti.c.id, ownerUserId: r1a.u.id, ownerName: r1a.u.name, ownerRole: 'Recruiter', createdByName: 'Imported — Education sheets catch-up', purpose: 'Education sourcing', createdAt: Z('2026-10-08T06:00:00Z'), completedAt: Z('2026-10-08T06:30:00Z'), outcome: 'No Response' } });
  await task(r1a, X.h, { createdAt: Z('2026-10-06T06:00:00Z'), dueDate: '2026-10-07', completedAt: Z('2026-10-06T08:00:00Z'), completedById: r1a.u.id, outcome: 'Answered' }); // done before the handover
  const TO = await task(r1a, X.h, { createdAt: Z('2026-10-06T07:00:00Z'), dueDate: '2026-10-09' }); // open when the candidate is handed to R1b
  await quick(r1a, X.q1, Z('2026-10-06T06:00:00Z'), 'Interested'); await quick(r1a, X.q1, Z('2026-10-06T07:00:00Z'), 'Not picked');
  await quick(r1a, X.q3, Z('2026-10-07T06:00:00Z'), 'Not interested');
  await quick(r1a, X.q4, Z('2026-10-11T18:29:00Z'), 'Interested'); // 23:59 IST on Oct 11: inside
  await quick(r1a, X.q5, Z('2026-10-11T18:30:00Z'), 'Interested'); // 00:00 IST on Oct 12: outside
  const cmId = await comment(r1a, X.cm, '2026-10-07', 'Spoke to the candidate, call back on 9th');
  const FUR = require('../src/utils/followUpReminders');
  await FUR.daysOfEntries(['x']); // makes the reminder table
  const ins = (entryId, userId, remindOn, status, doneAt) => prisma.$executeRawUnsafe('INSERT INTO "FollowUpReminder" (id, userId, remindOn, status, entryId, candidateId, createdAt, doneAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', `fr${P}${Math.random().toString(16).slice(2, 8)}`, userId, remindOn, status, entryId, X.cm.c.id, '2026-10-07T08:00:00Z', doneAt);
  await ins(cmId, r1a.u.id, '2026-10-09', 'DONE', '2026-10-09T05:00:00Z');
  await ins(cmId, r1b.u.id, '2026-10-09', 'OPEN', null); // the recruiter's own copy of the same reminder is not a second promise
  // the handover
  const { moveOwner } = require('../src/utils/handover');
  await moveOwner({ apps: [{ id: X.h.a.id, candidateId: X.h.c.id, ownerRecruiterId: r1a.u.id, stage: 'SOURCED' }], to: { id: r1b.u.id, name: r1b.u.name }, by: { id: adminRow.id, name: 'Admin' }, kind: 'test handover' });
  // ---- R1b
  X.b1 = await person('b1', reqB, r1b);
  await task(r1b, X.b1, { createdAt: Z('2026-10-08T06:00:00Z'), dueDate: '2026-10-10', completedAt: Z('2026-10-10T06:00:00Z'), completedById: r1b.u.id, outcome: 'Interested' });
  X.s1 = await person('system', reqB, r1b);
  await prisma.applicationFollowUp.create({ data: { applicationId: X.s1.a.id, candidateId: X.s1.c.id, ownerUserId: r1b.u.id, ownerName: r1b.u.name, ownerRole: 'Recruiter', purpose: 'Interview confirmation', autoCreated: true, dueDate: '2026-10-07', createdAt: Z('2026-10-05T06:00:00Z') } }); // raised by the system: nobody's "added"
  // ---- the recruiter who left (sat under TL1 until Oct 7)
  X.x1 = await person('x1', reqA, r1a); X.x2 = await person('x2', reqA, r1a);
  await task(r1x, X.x1, { createdAt: Z('2026-10-06T06:00:00Z'), completedAt: Z('2026-10-06T07:00:00Z'), completedById: r1x.u.id, outcome: 'Answered' });
  await task(r1x, X.x2, { createdAt: Z('2026-10-09T06:00:00Z'), completedAt: Z('2026-10-09T07:00:00Z'), completedById: r1x.u.id, outcome: 'Answered' }); // after they left the team
  // ---- the TL's own, and the other teams
  X.tl = await person('tl', reqA, r1a);
  await task(tl1, X.tl, { createdAt: Z('2026-10-06T06:00:00Z'), completedAt: Z('2026-10-06T07:00:00Z'), completedById: tl1.u.id, outcome: 'Answered' });
  X.r2a = await person('r2a', reqC, r2a); X.r2b = await person('r2b', reqD, r2b); X.r3 = await person('r3', reqE, r3a);
  await task(r2a, X.r2a, { createdAt: Z('2026-10-06T06:00:00Z'), dueDate: '2026-10-07', completedAt: Z('2026-10-06T07:00:00Z'), completedById: r2a.u.id, outcome: 'Interested' });
  await task(r2a, X.r2a, { createdAt: Z('2026-10-07T06:00:00Z'), dueDate: '2026-10-08' }); // open: overdue
  await quick(r2b, X.r2b, Z('2026-10-07T06:00:00Z'), 'Interested'); await quick(r2b, X.r2b, Z('2026-10-08T06:00:00Z'), 'Not picked');
  await task(r3a, X.r3, { createdAt: Z('2026-10-06T06:00:00Z'), completedAt: Z('2026-10-06T07:00:00Z'), completedById: r3a.u.id, outcome: 'Interested' });
  // ---- one candidate worked by all four recruiters (the candidate page)
  const shared = await cand('shared');
  const sApps = {};
  for (const [k, req, who] of [['r1a', reqA, r1a], ['r1b', reqB, r1b], ['r2a', reqC, r2a], ['r2b', reqD, r2b]]) {
    sApps[k] = await app(shared, req, who);
    // eslint-disable-next-line no-await-in-loop
    await comment(who, { c: shared, a: sApps[k] }, '2026-10-07', `Shared candidate line by ${k}`);
  }

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    // eslint-disable-next-line no-await-in-loop
    if (!up) await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('the server did not answer /api/health'); await stop(2); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = {};
  for (const [k, u] of Object.entries({ admin: adminRow, stl: stl.u, stl2: stl2.u, tl1: tl1.u, tl2: tl2.u, tl3: tl3.u, r1a: r1a.u, r1b: r1b.u, r2a: r2a.u, mgr: mgr.u, bde: bde.u, hr: hr.u })) T[k] = await tok(u.id); // eslint-disable-line no-await-in-loop

  const WEEK = 'from=2026-10-05&to=2026-10-11';
  const sum = (t, qs = '') => call('GET', `/followup-report/summary?${WEEK}&period=day${qs ? `&${qs}` : ''}`, null, t);
  const FIELDS = ['added', 'done', 'logged', 'contacted', 'promised', 'kept', 'overdue', 'carried', 'interested', 'notInterested', 'noAnswer'];
  const M = (row) => Object.fromEntries(FIELDS.map((f, i) => [f, row.m[i]]));
  const rowOf = (res, u) => (res.body.rows || []).find((x) => x.id === u.u.id);
  const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
  const R2NAMES = [r2a.u.name, r2b.u.name, tl2.u.name];

  // ================= THE TL's VIEW: one row per recruiter, every column
  const s1 = await sum(T.tl1);
  check('TL1: the summary answers', s1.status === 200 && s1.body.mode === 'team' && s1.body.fields.length === 11, s1.body);
  const ids1 = (s1.body.rows || []).map((x) => x.id).sort();
  check('TL1: the rows are TL1, R1a, R1b and the recruiter who left (days there) - nobody else', same(ids1, [tl1.u.id, r1a.u.id, r1b.u.id, r1x.u.id].sort()), ids1);
  check('R1a: added 8 (23:59 IST on Oct 6 and 00:00 on Oct 7 are two days; the system task and the carried one are not added)',
    same(M(rowOf(s1, r1a)), { added: 8, done: 4, logged: 4, contacted: 9, promised: 6, kept: 3, overdue: 2, carried: 1, interested: 3, notInterested: 2, noAnswer: 2 }), M(rowOf(s1, r1a)));
  check('R1b: the handed-over open task is owed by R1b; the system task is overdue for R1b but not "added"',
    same(M(rowOf(s1, r1b)), { added: 2, done: 1, logged: 0, contacted: 2, promised: 1, kept: 1, overdue: 2, carried: 0, interested: 1, notInterested: 0, noAnswer: 0 }), M(rowOf(s1, r1b)));
  check('R1x (left): credited for the follow-up done while they sat under TL1, not for the one after; marked left',
    same(M(rowOf(s1, r1x)), { added: 1, done: 1, logged: 0, contacted: 1, promised: 0, kept: 0, overdue: 0, carried: 0, interested: 0, notInterested: 0, noAnswer: 0 }) && rowOf(s1, r1x).former === true, M(rowOf(s1, r1x)));
  check('TL1 own row counts too',
    same(M(rowOf(s1, tl1)), { added: 1, done: 1, logged: 0, contacted: 1, promised: 0, kept: 0, overdue: 0, carried: 0, interested: 0, notInterested: 0, noAnswer: 0 }), M(rowOf(s1, tl1)));
  const tot = Object.fromEntries(FIELDS.map((f, i) => [f, s1.body.total.m[i]]));
  check('the Totals row is the people added up (contacted: different candidates - the shared candidate is counted once)', same(tot, { added: 12, done: 7, logged: 4, contacted: 12, promised: 7, kept: 4, overdue: 4, carried: 1, interested: 4, notInterested: 2, noAnswer: 2 }), tot);
  check('the handover kept the old work with the old recruiter: R1a still has the closed one, R1b did not get it', M(rowOf(s1, r1a)).done === 4 && M(rowOf(s1, r1b)).done === 1);
  const toNow = await prisma.applicationFollowUp.findUnique({ where: { id: TO.id } });
  check('(the open task did move to R1b)', toNow.ownerUserId === r1b.u.id);
  check('TL1 table: the "TL" column is left out, a Total row is there', !s1.body.table.headers.includes('TL') && s1.body.table.rows[s1.body.table.rows.length - 1][0] === 'Total', s1.body.table.headers);

  // imported ones can be filtered out
  const sx = await sum(T.tl1, 'imported=exclude');
  check('imported excluded: R1a loses the imported follow-up (added 7, done 3, contacted 8, no answer 1)', same(M(rowOf(sx, r1a)), { added: 7, done: 3, logged: 4, contacted: 8, promised: 6, kept: 3, overdue: 2, carried: 1, interested: 3, notInterested: 2, noAnswer: 1 }), M(rowOf(sx, r1a)));
  const so = await sum(T.tl1, 'imported=only');
  check('imported only: just that one, on its own date', M(rowOf(so, r1a)).added === 1 && M(rowOf(so, r1a)).done === 1 && M(rowOf(so, r1a)).logged === 0, M(rowOf(so, r1a)));
  const lstI = await call('GET', `/followup-report/list?${WEEK}&imported=only`, null, T.tl1);
  check('the list flags it "Imported" and dates it Oct 8', lstI.body.rows.length === 1 && lstI.body.rows[0].imported === true && lstI.body.rows[0].day === '2026-10-08', lstI.body.rows);

  // ================= day / week / month tables
  const d = rowOf(s1, r1a).buckets; // [day][field]
  check('day table: 7 columns Oct 5..11', s1.body.buckets.length === 7 && s1.body.granularity === 'day' && s1.body.buckets[0].from === '2026-10-05' && s1.body.buckets[6].from === '2026-10-11');
  const col = (i, f) => d[i][FIELDS.indexOf(f)];
  check('day table: done Oct 8 = 2 (23:59 IST one + the imported one), Oct 9 = 1 (00:00 IST one)', col(3, 'done') === 2 && col(4, 'done') === 1, d.map((x) => x[1]));
  check('day table: added Oct 6 = 3 (23:59 IST one, the handover pair), Oct 7 = 4 (00:00 IST one, open one, comment, the shared candidate line)', col(1, 'added') === 3 && col(2, 'added') === 4, d.map((x) => x[0]));
  check('day table: logged Oct 6 = 2, Oct 7 = 1, Oct 11 = 1 (23:59 IST in, 00:00 IST Oct 12 out)', col(1, 'logged') === 2 && col(2, 'logged') === 1 && col(6, 'logged') === 1 && d.reduce((a, x) => a + x[2], 0) === 4, d.map((x) => x[2]));
  check('day table: call-backs by their own date (Oct 8: promised 2, kept 1, overdue 1)', col(3, 'promised') === 2 && col(3, 'kept') === 1 && col(3, 'overdue') === 1, d.map((x) => [x[4], x[5], x[6]]));
  check('day table: the trend bar numbers are added + done + logged per day', rowOf(s1, r1a).trend[1] === 3 + 1 + 2 && rowOf(s1, r1a).trend.length === 7, rowOf(s1, r1a).trend);
  check('day table: the day columns add up to the Total row', FIELDS.every((f, i) => f === 'contacted' || f === 'carried' || d.reduce((a, x) => a + x[i], 0) === rowOf(s1, r1a).m[i]), d);
  const wk = await call('GET', '/followup-report/summary?from=2026-10-05&to=2026-10-18&period=week&columns=week', null, T.tl1);
  const wr = rowOf(wk, r1a);
  check('week table: two weeks, Oct 5-11 and Oct 12-18; the 00:00 IST Oct 12 log is in week 2', wk.body.buckets.length === 2 && wr.buckets[0][0] === 8 && wr.buckets[1][2] === 1 && wr.buckets[0][2] === 4, wr && wr.buckets);
  const mo = await call('GET', '/followup-report/summary?from=2026-09-28&to=2026-10-11&period=month&columns=month', null, T.tl1);
  const mr = rowOf(mo, r1a);
  check('month table: Sep (28-30) and Oct (1-11); the Sep 28 task is added in September', mo.body.buckets.length === 2 && mo.body.buckets[0].label === 'Sep 2026' && mr.buckets[0][0] === 1 && mr.buckets[1][0] === 8, mr && mr.buckets);
  const dflt = await call('GET', '/followup-report/summary?period=month', null, T.tl1);
  check('a month with no dates opens on this month', dflt.status === 200 && dflt.body.from.endsWith('-01') && dflt.body.to >= dflt.body.from, [dflt.body.from, dflt.body.to]);
  const pdet = await call('GET', `/followup-report/person?${WEEK}&period=day&personId=${r1a.u.id}`, null, T.tl1);
  check('a recruiter row opens a day-by-day table with every column', pdet.status === 200 && pdet.body.person.id === r1a.u.id && pdet.body.byBucket.length === 7 && pdet.body.byBucket[0].length === 11 && pdet.body.total[0] === 8, pdet.body);

  // ================= the whole-team list
  const lst = await call('GET', `/followup-report/list?${WEEK}`, null, T.tl1);
  const names1 = new Set(lst.body.rows.map((x) => x.byName));
  check('TL1 list: each follow-up once, recruiters of TL1 only', lst.status === 200 && lst.body.rows.length === lst.body.total && new Set(lst.body.rows.map((x) => x.id)).size === lst.body.rows.length && ![...names1].some((x) => R2NAMES.includes(x)), [lst.body.total, [...names1]]);
  const lr = await call('GET', `/followup-report/list?${WEEK}&personId=${r1a.u.id}`, null, T.tl1);
  check('recruiter filter: R1a\'s follow-ups, with candidate, requirement, client, what happened, call-back date, outcome and status', lr.body.rows.length > 5 && lr.body.rows.every((x) => x.candidateName) && lr.body.rows.some((x) => x.callBackDay === '2026-10-08' && x.status === 'Done late') && lr.body.rows.some((x) => x.status === 'Overdue' && x.outcome === null) && lr.body.rows.some((x) => x.requirement && x.client), lr.body.rows.slice(0, 3));
  const lcar = lr.body.rows.find((x) => x.carried);
  check('the carried-over one is in the list, flagged', !!lcar && lcar.callBackDay === '2026-10-02', lcar);
  const lq = await call('GET', `/followup-report/list?${WEEK}&q=handover`, null, T.tl1);
  check('search finds by candidate name', lq.body.rows.length >= 2 && lq.body.rows.every((x) => /handover/i.test(x.candidateName)), lq.body.rows.length);
  const lo = await call('GET', `/followup-report/list?${WEEK}&outcome=interested`, null, T.tl1);
  check('outcome filter: interested', lo.body.rows.length === 4 && lo.body.rows.every((x) => x.outcomeClass === 'interested'), lo.body.rows.length);
  check('the leaver shows with "(left)" nowhere in the list as a stranger: named as themselves', lst.body.rows.some((x) => x.byName === r1x.u.name));

  // ================= Excel equals the table
  const xr = await fetch(`${API}/followup-report/export?${WEEK}&period=day&format=xlsx`, { headers: { Authorization: `Bearer ${T.tl1}` } });
  const wb = XLSX.read(Buffer.from(await xr.arrayBuffer()), { type: 'buffer' });
  const sheet = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
  const rep = sheet('Report');
  check('Excel: the Report sheet is the table on screen (headers and every cell)', xr.status === 200 && same(rep, [s1.body.table.headers, ...s1.body.table.rows]), rep.slice(0, 3));
  check('Excel: the Follow-ups sheet has every follow-up of the list', sheet('Follow-ups').length - 1 === lst.body.total, [sheet('Follow-ups').length - 1, lst.body.total]);
  check('Excel: a Day by day sheet with one column per day', sheet('Day by day')[0].length === 1 + 7 + 1, sheet('Day by day')[0]);
  const exportText = JSON.stringify(wb.SheetNames.map((nm) => sheet(nm)));
  check('Excel (TL1): no name from TL2\'s team', !R2NAMES.some((x) => exportText.includes(x)));
  const csvRes = await fetch(`${API}/followup-report/export?${WEEK}&format=csv`, { headers: { Authorization: `Bearer ${T.tl1}` } });
  check('CSV also works and carries the table', csvRes.status === 200 && (await csvRes.text()).includes(r1a.u.name));
  const audit = await prisma.auditLog.findFirst({ where: { action: { startsWith: 'Follow-up report exported' }, userId: tl1.u.id }, orderBy: { createdAt: 'desc' } });
  check('the export is in the export log (audit)', !!audit, audit);

  // ================= SCOPE: TL1 cannot reach TL2's team any way
  const bodyText = (r) => JSON.stringify(r.body);
  const leakTests = [
    ['summary', s1], ['list', lst], ['person', pdet],
    ['options', await call('GET', '/followup-report/options', null, T.tl1)],
    ['search for TL2\'s recruiter', await call('GET', `/followup-report/list?${WEEK}&q=${encodeURIComponent('Fur r2a')}`, null, T.tl1)],
  ];
  leakTests.forEach(([nm, r]) => check(`TL1 ${nm}: no name or id of TL2's team anywhere`, r.status === 200 && !R2NAMES.some((x) => bodyText(r).includes(x)) && ![r2a.u.id, r2b.u.id, tl2.u.id].some((x) => bodyText(r).includes(x)), r.status));
  check('TL1 search for TL2\'s recruiter finds nothing', leakTests[4][1].body.rows.length === 0);
  check('TL1 asks for TL2\'s team: 403', (await sum(T.tl1, `leadId=${tl2.u.id}`)).status === 403);
  check('TL1 asks for TL2\'s recruiter in the summary: 403', (await sum(T.tl1, `personId=${r2a.u.id}`)).status === 403);
  check('TL1 asks for TL2\'s recruiter in the list (recruiter filter): 403', (await call('GET', `/followup-report/list?${WEEK}&personId=${r2a.u.id}`, null, T.tl1)).status === 403);
  check('TL1 asks for TL2\'s recruiter in the person table: 403', (await call('GET', `/followup-report/person?${WEEK}&personId=${r2a.u.id}`, null, T.tl1)).status === 403);
  check('TL1 export for TL2\'s team: 403', (await fetch(`${API}/followup-report/export?${WEEK}&leadId=${tl2.u.id}`, { headers: { Authorization: `Bearer ${T.tl1}` } })).status === 403);
  check('TL1 export for TL2\'s recruiter: 403', (await fetch(`${API}/followup-report/export?${WEEK}&personId=${r2b.u.id}`, { headers: { Authorization: `Bearer ${T.tl1}` } })).status === 403);
  check('TL1 department / team pickers do not widen the team', !(await sum(T.tl1, 'department=zzz')).body.rows.some((x) => x.id === r2a.u.id));

  // ================= TL2 and the other STL
  const s2 = await sum(T.tl2);
  const ids2 = s2.body.rows.map((x) => x.id).sort();
  check('TL2: TL2, R2a, R2b only', same(ids2, [tl2.u.id, r2a.u.id, r2b.u.id].sort()), ids2);
  check('R2a: 3 added (2 tasks + the shared candidate line), 1 done, overdue 1; R2b: 2 logged', same(M(rowOf(s2, r2a)), { added: 3, done: 1, logged: 0, contacted: 2, promised: 2, kept: 1, overdue: 1, carried: 0, interested: 1, notInterested: 0, noAnswer: 0 }) && M(rowOf(s2, r2b)).logged === 2 && M(rowOf(s2, r2b)).interested === 1 && M(rowOf(s2, r2b)).noAnswer === 1, [M(rowOf(s2, r2a)), M(rowOf(s2, r2b))]);
  check('TL2 sees no name of TL1\'s team', ![r1a.u.name, r1b.u.name, r1x.u.name, tl1.u.name].some((x) => bodyText(s2).includes(x)));
  const sS = await sum(T.stl);
  const idsS = sS.body.rows.map((x) => x.id);
  check('STL: both TLs\' teams (TL1, TL2 and their recruiters), not the other STL\'s TL3', [tl1, tl2, r1a, r1b, r2a, r2b].every((p) => idsS.includes(p.u.id)) && !idsS.includes(tl3.u.id) && !idsS.includes(r3a.u.id), idsS.length);
  check('STL: the TL picker lists TL1 and TL2, not TL3', same((sS.body.leads || []).map((l) => l.id).sort(), [tl1.u.id, tl2.u.id].sort()), sS.body.leads);
  const sS2 = await sum(T.stl, `leadId=${tl2.u.id}`);
  check('STL picks TL2: exactly TL2\'s team', same(sS2.body.rows.map((x) => x.id).sort(), [tl2.u.id, r2a.u.id, r2b.u.id].sort()), sS2.body.rows.map((x) => x.name));
  check('STL asks for TL3 (the other STL\'s team): 403', (await sum(T.stl, `leadId=${tl3.u.id}`)).status === 403);
  check('STL asks for TL3\'s recruiter: 403', (await sum(T.stl, `personId=${r3a.u.id}`)).status === 403);
  const sS3 = await sum(T.stl2);
  check('the other STL sees TL3 team only', same(sS3.body.rows.map((x) => x.id).sort(), [tl3.u.id, r3a.u.id, stl2.u.id].sort()), sS3.body.rows.map((x) => x.name));

  // ================= the recruiter: only themselves
  const sr = await sum(T.r1a);
  check('R1a: one row, their own, no Total row, mode mine', sr.status === 200 && sr.body.mode === 'mine' && sr.body.rows.length === 1 && sr.body.rows[0].id === r1a.u.id && !sr.body.table.rows.some((r) => r[0] === 'Total') && same(M(sr.body.rows[0]), M(rowOf(s1, r1a))), sr.body.rows.length);
  const srText = bodyText(sr) + bodyText(await call('GET', '/followup-report/options', null, T.r1a)) + bodyText(await call('GET', `/followup-report/list?${WEEK}`, null, T.r1a));
  check('R1a: no other recruiter\'s name anywhere (summary, options, list)', ![r1b.u.name, r1x.u.name, tl1.u.name, ...R2NAMES].some((x) => srText.includes(x)));
  const rl = await call('GET', `/followup-report/list?${WEEK}`, null, T.r1a);
  check('R1a: the list has only their own follow-ups, once each', rl.status === 200 && rl.body.rows.length > 5 && rl.body.rows.every((x) => x.byName === r1a.u.name) && new Set(rl.body.rows.map((x) => x.id)).size === rl.body.rows.length, rl.body.rows.map((x) => x.byName));
  const rb = await call('GET', `/followup-report/list?${WEEK}&q=${encodeURIComponent('Fur r1b')}`, null, T.r1a);
  check('R1a: searching R1b\'s name finds nothing', rb.status === 200 && rb.body.rows.length === 0);
  check('R1a asks for R1b: 403 (summary, list, person, export)', (await sum(T.r1a, `personId=${r1b.u.id}`)).status === 403 && (await call('GET', `/followup-report/list?${WEEK}&personId=${r1b.u.id}`, null, T.r1a)).status === 403 && (await call('GET', `/followup-report/person?${WEEK}&personId=${r1b.u.id}`, null, T.r1a)).status === 403 && (await fetch(`${API}/followup-report/export?${WEEK}&personId=${r1b.u.id}`, { headers: { Authorization: `Bearer ${T.r1a}` } })).status === 403);
  check('R1a asks for a team (leadId): 403', (await sum(T.r1a, `leadId=${tl1.u.id}`)).status === 403);
  const xr1 = await fetch(`${API}/followup-report/export?${WEEK}&format=xlsx`, { headers: { Authorization: `Bearer ${T.r1a}` } });
  const wb1 = XLSX.read(Buffer.from(await xr1.arrayBuffer()), { type: 'buffer' });
  const txt1 = JSON.stringify(wb1.SheetNames.map((nm) => XLSX.utils.sheet_to_json(wb1.Sheets[nm], { header: 1 })));
  check('R1a Excel of their own list: no other name', xr1.status === 200 && ![r1b.u.name, r1x.u.name, tl1.u.name, ...R2NAMES].some((x) => txt1.includes(x)) && txt1.includes(r1a.u.name));
  check('R1a: the task R1b now owns (handed over) is not R1a\'s overdue', M(sr.body.rows[0]).overdue === 2);

  // ================= Manager / Admin: everyone, with the team picker
  const sm = await sum(T.mgr);
  const idsM = sm.body.rows.map((x) => x.id);
  check('Manager: sees TL1\'s and TL2\'s teams and the other STL\'s', [r1a, r1b, r2a, r2b, r3a, tl1, tl2, tl3].every((p) => idsM.includes(p.u.id)), idsM.length);
  check('Manager: the picker lists all three TLs, departments and teams; the TL column is there', ['TL1', 'TL2', 'TL3'].every((_, i) => (sm.body.leads || []).some((l) => l.id === [tl1, tl2, tl3][i].u.id)) && sm.body.table.headers.includes('TL') && (sm.body.departments || []).includes(DEPT), sm.body.leads && sm.body.leads.length);
  check('Manager: R1a\'s row names TL1 as the TL', rowOf(sm, r1a).leadName === tl1.u.name, rowOf(sm, r1a).leadName);
  const sm2 = await sum(T.mgr, `leadId=${tl2.u.id}`);
  check('Manager picks TL2: exactly TL2\'s team', same(sm2.body.rows.map((x) => x.id).sort(), [tl2.u.id, r2a.u.id, r2b.u.id].sort()), sm2.body.rows.map((x) => x.name));
  const sm3 = await sum(T.mgr, `department=${encodeURIComponent(DEPT)}&team=${encodeURIComponent('Team B')}`);
  check('Manager picks the department and Team B: R2a, R2b (and TL2)', sm3.body.rows.every((x) => [tl2.u.id, r2a.u.id, r2b.u.id].includes(x.id)) && sm3.body.rows.some((x) => x.id === r2a.u.id), sm3.body.rows.map((x) => x.name));
  const sa = await sum(T.admin, `leadId=${tl1.u.id}`);
  check('Admin picks TL1: TL1\'s team, same numbers as TL1 sees', same(sa.body.rows.map((x) => x.id).sort(), ids1) && same(M(rowOf(sa, r1a)), M(rowOf(s1, r1a))), sa.body.rows.map((x) => x.name));
  check('Admin: an unknown TL is a 404', (await sum(T.admin, 'leadId=nope')).status === 404);
  check('Manager: one recruiter through the person endpoint', (await call('GET', `/followup-report/person?${WEEK}&personId=${r2a.u.id}`, null, T.mgr)).body.person.id === r2a.u.id);
  const mExp = await fetch(`${API}/followup-report/export?${WEEK}&leadId=${tl2.u.id}`, { headers: { Authorization: `Bearer ${T.mgr}` } });
  check('Manager export for TL2\'s team works', mExp.status === 200);

  // ================= other logins, bad input
  const sb = await sum(T.bde);
  check('BDE: only their own row (their client desk), no team', sb.status === 200 && sb.body.mode === 'mine' && sb.body.rows.length === 1 && sb.body.rows[0].id === bde.u.id && (await sum(T.bde, `personId=${r1a.u.id}`)).status === 403, sb.status);
  check('HR: refused (403)', (await sum(T.hr)).status === 403);
  check('no login: 401', (await fetch(`${API}/followup-report/summary?${WEEK}`)).status === 401);
  const cl = await prisma.user.findFirst({ where: { role: 'CLIENT', status: 'Active' } });
  if (cl) {
    const tc = await tok(cl.id);
    check('a client login gets nothing (403)', [401, 403].includes((await sum(tc)).status));
  }
  check('from after to: 400', (await call('GET', '/followup-report/summary?from=2026-10-11&to=2026-10-05', null, T.tl1)).status === 400);
  check('a date that is not a date: 400', (await call('GET', '/followup-report/summary?from=2026-13-45&to=2026-10-05', null, T.tl1)).status === 400 && (await call('GET', '/followup-report/summary?from=abc', null, T.tl1)).status === 400);
  check('more than a year: 400', (await call('GET', '/followup-report/summary?from=2024-01-01&to=2026-10-05', null, T.tl1)).status === 400);
  check('from after to is refused by the list and the export too', (await call('GET', '/followup-report/list?from=2026-10-11&to=2026-10-05', null, T.tl1)).status === 400 && (await fetch(`${API}/followup-report/export?from=2026-10-11&to=2026-10-05`, { headers: { Authorization: `Bearer ${T.tl1}` } })).status === 400);
  const one = await call('GET', '/followup-report/summary?from=2026-10-12&to=2026-10-12', null, T.tl1);
  check('the last day is inclusive and a single day works: Oct 12 holds only the 00:00 IST log', rowOf(one, r1a).m[2] === 1 && rowOf(one, r1a).m[0] === 0, rowOf(one, r1a).m);

  // ================= end to end through the ordinary follow-up box, then the report
  const todayIst = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const post = await call('POST', '/client-followlog', { candidateId: shared.id, applicationId: sApps.r1a.id, onDate: todayIst, note: 'Called today, will attend the interview' }, T.r1a);
  check('R1a adds a follow-up in the candidate box', post.status === 201, post.body);
  const t1 = await call('GET', `/followup-report/summary?from=${todayIst}&to=${todayIst}&period=day`, null, T.tl1);
  check('it counts once for R1a in TL1\'s report today (added 1, contacted 1)', rowOf(t1, r1a) && rowOf(t1, r1a).m[0] === 1 && rowOf(t1, r1a).m[3] === 1, rowOf(t1, r1a));
  check('...and nowhere in TL2\'s', (await call('GET', `/followup-report/summary?from=${todayIst}&to=${todayIst}`, null, T.tl2)).body.rows.every((x) => x.m[0] === 0));

  // ================= the candidate page list ("Everyone" dropdown)
  const cp = (t) => call('GET', `/client-followlog?candidateId=${shared.id}`, null, t);
  const pr = await cp(T.r1a);
  check('candidate page, recruiter: only their own lines, the list is "Me" only', pr.status === 200 && pr.body.whoMode === 'mine' && pr.body.whoPeople.length === 1 && pr.body.whoPeople[0].id === r1a.u.id && pr.body.entries.length === 2 && pr.body.entries.every((e) => e.byName === r1a.u.name), pr.body.entries && pr.body.entries.map((e) => e.byName));
  check('candidate page, recruiter: no other name in the response', ![r1b.u.name, ...R2NAMES, tl1.u.name].some((x) => bodyText(pr).includes(x)));
  const pt = await cp(T.tl1);
  check('candidate page, TL1: lists Everyone (team) and each recruiter by name; lines of R1a and R1b, none of TL2\'s', pt.body.whoMode === 'team' && [r1a, r1b].every((p) => pt.body.whoPeople.some((x) => x.id === p.u.id && x.role === 'Recruiter')) && pt.body.entries.some((e) => e.byName === r1b.u.name) && !R2NAMES.some((x) => bodyText(pt).includes(x)), pt.body.whoPeople);
  const pt2 = await cp(T.tl2);
  check('candidate page, TL2: R2a and R2b lines only', pt2.body.entries.length === 2 && pt2.body.entries.every((e) => R2NAMES.includes(e.byName)) && ![r1a.u.name, r1b.u.name].some((x) => bodyText(pt2).includes(x)), pt2.body.entries.map((e) => e.byName));
  const pa = await cp(T.admin);
  check('candidate page, Admin: everyone\'s lines, everyone in the list', pa.body.whoMode === 'all' && [r1a, r1b, r2a, r2b].every((p) => pa.body.entries.some((e) => e.byName === p.u.name)), pa.body.entries.map((e) => e.byName));
  check('candidate page: entries keep the name with the role and the requirement / client tag', pt.body.entries.every((e) => e.byRole === 'Recruiter') && pt.body.entries.every((e) => e.requirementLabel && e.byId), pt.body.entries[0]);
  const ex = await fetch(`${API}/client-followlog/export?candidateId=${shared.id}&format=csv`, { headers: { Authorization: `Bearer ${T.r1a}` } });
  const exT = await ex.text();
  check('candidate page export follows the same scope', ex.status === 200 && !R2NAMES.some((x) => exT.includes(x)) && !exT.includes(r1b.u.name));

  // ================= the screens, in a real browser (FUR_BROWSER=1): the TL's tab, the recruiter's tab, the manager's picker, the candidate page
  if (process.env.FUR_BROWSER) {
    const { chromium } = require('playwright-core');
    const VPORT = Number(process.env.FUR_VITE_PORT) || 5291;
    const vite = spawn(process.execPath, [path.join(BACK, '..', 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(VPORT), '--strictPort'], { cwd: path.join(BACK, '..', 'frontend'), env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: 'ignore' });
    let vup = false;
    for (let i = 0; i < 120 && !vup; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      vup = await fetch(`http://localhost:${VPORT}/`).then((r) => r.ok).catch(() => false);
      // eslint-disable-next-line no-await-in-loop
      if (!vup) await new Promise((r) => { setTimeout(r, 500); });
    }
    const shots = path.join(BACK, '..', 'docs', 'followup-report-2026-11-20');
    fs.mkdirSync(shots, { recursive: true });
    let browser; let lastPage;
    try {
      browser = await chromium.launch({ channel: 'msedge' });
      const open = async (token, url) => {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
        await ctx.addInitScript((tk) => { try { localStorage.setItem('tl_token', tk); } catch { /* none */ } }, token);
        const page = await ctx.newPage();
        lastPage = page;
        await page.goto(`http://localhost:${VPORT}${url}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
        return { ctx, page };
      };
      const setDays = async (page, from, to) => {
        await page.locator('.fur-bar label:has-text("From") input[type=date]').first().fill(from);
        await page.locator('.fur-bar label:has-text("To") input[type=date]').first().fill(to);
        await page.waitForTimeout(1500);
      };
      const text = (page) => page.locator('.fur').innerText();
      // TL
      let { ctx, page } = await open(T.tl1, '/ats/team?view=followups&sub=report');
      await page.waitForSelector('.fur-table', { timeout: 90000 });
      await setDays(page, '2026-10-05', '2026-10-11');
      let t = await text(page);
      check('browser, TL1: the Follow-up report tab shows a row per recruiter and a Total row', [r1a.u.name, r1b.u.name].every((x) => t.includes(x)) && /Total/.test(t) && (await page.locator('.fur-table tbody tr').count()) >= 3, t.slice(0, 300));
      check('browser, TL1: no name from TL2\'s team on the screen', !R2NAMES.some((x) => t.includes(x)));
      await page.screenshot({ path: path.join(shots, '1-tl-by-recruiter.png') });
      await page.locator('.fur-table tbody tr', { hasText: r1a.u.name }).first().click();
      await page.waitForSelector('.fur-drill', { timeout: 20000 });
      await page.waitForTimeout(1200);
      check('browser, TL1: a recruiter row opens that recruiter\'s day-by-day table and their list', (await page.locator('.fur-drill tbody tr').count()) === 7 && (await page.locator('.fur-list tbody tr').count()) > 5);
      await page.screenshot({ path: path.join(shots, '2-tl-recruiter-drill.png'), fullPage: true });
      await page.getByRole('tab', { name: /Day by day/ }).click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(shots, '3-tl-day-by-day.png') });
      await ctx.close();
      // recruiter
      ({ ctx, page } = await open(T.r1a, '/ats/followups?sub=report'));
      await page.waitForSelector('.fur-table', { timeout: 90000 });
      await setDays(page, '2026-10-05', '2026-10-11');
      t = await text(page);
      check('browser, R1a: only their own row, no other name, no Total row', t.includes(r1a.u.name) && ![r1b.u.name, tl1.u.name, r1x.u.name, ...R2NAMES].some((x) => t.includes(x)) && (await page.locator('.fur-table tbody tr').count()) === 1 && !/Total/.test(t), t.slice(0, 300));
      await page.getByRole('tab', { name: /My follow-ups/ }).click();
      await page.waitForTimeout(1500);
      t = await text(page);
      check('browser, R1a: their list shows only their own follow-ups', ![r1b.u.name, tl1.u.name, ...R2NAMES].some((x) => t.includes(x)) && (await page.locator('.fur-list tbody tr').count()) > 5);
      await page.screenshot({ path: path.join(shots, '4-recruiter-own.png') });
      await ctx.close();
      // Manager: the team picker
      ({ ctx, page } = await open(T.mgr, '/ats/team?view=followups&sub=report'));
      await page.waitForSelector('.fur-table', { timeout: 90000 });
      await setDays(page, '2026-10-05', '2026-10-11');
      const picker = page.locator('select[aria-label="Team lead"]');
      check('browser, Manager: a team-lead picker is there with every TL', (await picker.locator('option').count()) >= 4);
      await picker.selectOption(tl2.u.id);
      await page.waitForTimeout(1500);
      t = await text(page);
      check('browser, Manager picks TL2: TL2\'s recruiters only', t.includes(r2a.u.name) && !t.includes(r1a.u.name), t.slice(0, 200));
      await page.screenshot({ path: path.join(shots, '5-manager-picker.png') });
      await ctx.close();
      // the candidate page
      ({ ctx, page } = await open(T.tl1, `/candidates/${shared.id}?tab=followups`));
      await page.waitForSelector('select[aria-label="Who"]', { timeout: 90000 });
      const wopts = await page.locator('select[aria-label="Who"] option').allInnerTexts();
      check('browser, candidate page, TL1: the Who list is Everyone (team) and each recruiter by name', wopts[0] === 'Everyone (team)' && wopts.some((o) => o.includes(r1a.u.name)) && wopts.some((o) => o.includes(r1b.u.name)) && !wopts.some((o) => R2NAMES.some((x) => o.includes(x))), wopts);
      check('browser, candidate page: a from-to date filter is there', (await page.locator('input[aria-label="From date"]').count()) === 1 && (await page.locator('input[aria-label="To date"]').count()) === 1);
      await page.screenshot({ path: path.join(shots, '6-candidate-who.png') });
      await ctx.close();
    } catch (e) {
      let seen = ''; try { seen = (await lastPage.innerText('body')).slice(0, 400); await lastPage.screenshot({ path: path.join(os.tmpdir(), 'fur-fail.png') }); } catch { /* none */ }
      check(`browser check ran (${e.message.slice(0, 80)})`, false, { url: lastPage && lastPage.url(), seen });
    } finally {
      if (browser) await browser.close().catch(() => {});
      vite.kill();
    }
  }

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
