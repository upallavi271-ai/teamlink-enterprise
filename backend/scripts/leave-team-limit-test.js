#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TEAM LEAVE LIMIT TEST (2026-11-25) - SANDBOX ONLY.
//   node scripts/leave-team-limit-test.js        (needs the sandbox API: TL_API, default http://localhost:4011, and prisma/sandbox.db)
//
// Founder 2026-11-25: "in a team, if 2 people are on leave, another employee cannot apply; Education Team A and Team B are
// separate - show it team-wise." utils/teamLeaveLimit.js + POST /api/leave + GET /api/leave/who-else + PUT /api/leave/team-limit.
// ZZTL employees in two teams of one department (Team-A: 4, Team-B: 3) and three people with no team:
//   A  two of Team-A on leave -> the third is refused (409, TEAM_LEAVE_FULL), Team-B and people with no team are not affected
//   B  counted day by day: a partly overlapping range is refused only where the team is full
//   C  a Rejected / Cancelled leave frees its slot; a half day holds a slot; a Pending request holds a slot
//   D  HR (Leave & Holidays / configure) may apply beyond the limit on purpose (audit-logged); an employee may not
//   E  who-else says the slots team-wise (taken / left per day); a person with no team gets none
//   F  the setting: read, change the number, switch off / on, refused values, employees may not change it
// Removes every row it made and puts the setting back. Refuses to run against dev.db / port 4010.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
if (!fs.existsSync(DB) || /dev\.db$/.test(DB)) { console.error('No prisma/sandbox.db - start the sandbox first (never dev.db).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.env.TEST_MODE = process.env.TEST_MODE || '1';
const API = `${String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
if (/:4010(\/|$)/.test(API)) { console.error('Refusing: 4010 is the real server.'); process.exit(2); }
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const TL = require('../src/utils/teamLeaveLimit');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500)}`); } };
const RUN = Date.now().toString(36);
const DEPT = `ZZTL Dept ${RUN}`;
const made = { users: [], emps: [], leaves: [] };

async function call(token, method, url, body) {
  let r;
  for (let i = 0; i < 10; i += 1) {
    try {
      r = await fetch(`${API}${url}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) { if (i === 9) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const base = { passwordHash: 'x'.repeat(40), atsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
async function mk(tag, role, team) {
  const name = `ZZTL ${tag} ${RUN}`;
  const u = await prisma.user.create({ data: { ...base, name, email: `zztl-${tag.toLowerCase()}-${RUN}@example.test`, username: `zztl-${tag.toLowerCase()}-${RUN}@example.test`, role, hrmsRole: role, accountsRole: role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'NONE' } });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: { employeeCode: `ZZTL-${tag}-${RUN}`.slice(0, 40), name, userId: u.id, designation: 'Executive', employmentStatus: 'Active', department: DEPT, team: team || null, email: u.email, dateOfJoining: new Date('2025-01-01') },
  });
  made.emps.push(e.id);
  const t = jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
  return { u, e, t, name };
}
// working days of May 2027 (Mon-Sat), one block per case so the cases do not touch each other
const DAYS = [];
for (let d = 3; d <= 29; d += 1) { const date = `2027-05-${String(d).padStart(2, '0')}`; if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) DAYS.push(date); }
const day = (n) => DAYS[n];

(async () => {
  let before = null;
  try {
    try { const h = await fetch(`${API}/health`); if (!h.ok) throw new Error('x'); } catch { console.error(`The sandbox API is not answering at ${API}.`); process.exit(3); }
    before = await prisma.appSetting.findUnique({ where: { key: TL.KEY } });
    await prisma.appSetting.deleteMany({ where: { key: TL.KEY } }); // default: on, 2
    const hr = await mk('HR', 'HR');
    const sa = await mk('SA', 'SUPER_ADMIN'); // holds Leave & Holidays / configure: may apply beyond the limit and change the setting
    const A = []; for (let i = 1; i <= 4; i += 1) A.push(await mk(`A${i}`, 'EMPLOYEE', 'Team-A')); // eslint-disable-line no-await-in-loop
    const B = []; for (let i = 1; i <= 3; i += 1) B.push(await mk(`B${i}`, 'EMPLOYEE', 'Team-B')); // eslint-disable-line no-await-in-loop
    const N = []; for (let i = 1; i <= 3; i += 1) N.push(await mk(`N${i}`, 'EMPLOYEE', null)); // eslint-disable-line no-await-in-loop
    const types = (await call(hr.t, 'GET', '/leave/types')).body || [];
    const TYPE = (types.find((t) => t.active !== false) || { name: 'Casual Leave' }).name;
    // HR applies on behalf (with the balance override) so only the team limit is under test; employees apply for themselves where the point is "an employee cannot"
    const apply = (who, o, extra = {}) => call(hr.t, 'POST', '/leave', { employeeId: who.e.id, type: TYPE, reason: 'zz team limit test', overrideBalance: true, fromDate: o.from, toDate: o.to || o.from, ...(o.halfDay ? { halfDay: o.halfDay } : {}), ...extra });
    const applySelf = (who, o) => call(who.t, 'POST', '/leave', { type: TYPE, reason: 'zz team limit test', fromDate: o.from, toDate: o.to || o.from });
    const keep = (r) => { if (r.body && r.body.id) made.leaves.push(r.body.id); return r; };

    console.log(`\nA. Two of a team on leave: the third cannot apply (leave type "${TYPE}", day ${day(0)})`);
    let r = keep(await apply(A[0], { from: day(0) }));
    ok(r.status === 201, 'Team-A person 1 applies: saved', [r.status, r.text.slice(0, 200)]);
    r = keep(await apply(A[1], { from: day(0) }));
    ok(r.status === 201, 'Team-A person 2 applies the same day: saved (2 of 2)', [r.status, r.text.slice(0, 200)]);
    r = await applySelf(A[2], { from: day(0) });
    ok(r.status === 409 && r.body && r.body.code === 'TEAM_LEAVE_FULL', 'Team-A person 3 applies themselves: refused (409 TEAM_LEAVE_FULL)', [r.status, r.text.slice(0, 200)]);
    ok(r.body && /Team-A/.test(r.body.error || '') && /ZZTL A1/.test(r.body.error || '') && /ZZTL A2/.test(r.body.error || '') && /only 2/.test(r.body.error || ''), 'the message names the team, the two people and the limit', r.body && r.body.error);
    ok(r.body && r.body.teamLimit && r.body.teamLimit.blocked && r.body.teamLimit.fullDates.length === 1, 'the answer carries the slots for the screen');
    r = await apply(A[2], { from: day(0) });
    ok(r.status === 409 && r.body.code === 'TEAM_LEAVE_FULL', 'HR applying for person 3 without the override is refused too');
    r = keep(await apply(B[0], { from: day(0) }));
    ok(r.status === 201, 'Team-B person 1, same day: saved (Team-B is counted on its own)', [r.status, r.text.slice(0, 200)]);
    r = keep(await apply(B[1], { from: day(0) }));
    ok(r.status === 201, 'Team-B person 2, same day: saved (2 of 2 in Team-B)', [r.status, r.text.slice(0, 200)]);
    r = await applySelf(B[2], { from: day(0) });
    ok(r.status === 409 && r.body.code === 'TEAM_LEAVE_FULL' && /Team-B/.test(r.body.error) && !/Team-A/.test(r.body.error) && !/ZZTL A1/.test(r.body.error), 'Team-B person 3 is refused with Team-B\'s own message (no Team-A names)', r.body && r.body.error);
    for (const n of N) { r = keep(await apply(n, { from: day(0) })); ok(r.status === 201, `${n.name.replace(` ${RUN}`, '')} (no team) applies the same day: saved (no team = no limit)`, [r.status, r.text.slice(0, 160)]); } // eslint-disable-line no-restricted-syntax, no-await-in-loop
    r = keep(await apply(A[2], { from: day(1) }));
    ok(r.status === 201, 'Team-A person 3 on a free day: saved');

    console.log('\nB. Counted day by day');
    // A1 on days 3-4, A2 on days 4-5: day 4 is full, days 3 and 5 have one slot left
    keep(await apply(A[0], { from: day(3), to: day(4) }));
    keep(await apply(A[1], { from: day(4), to: day(5) }));
    r = await apply(A[3], { from: day(3), to: day(5) });
    ok(r.status === 409 && r.body.teamLimit && JSON.stringify(r.body.teamLimit.fullDates) === JSON.stringify([day(4)]), 'a range over days 3-5 is refused only because of day 4', r.body && r.body.teamLimit && r.body.teamLimit.fullDates);
    r = keep(await apply(A[3], { from: day(3) }));
    ok(r.status === 201, 'day 3 alone (one slot left) is saved');
    r = keep(await apply(A[2], { from: day(5) }));
    ok(r.status === 201, 'day 5 alone (one slot left) is saved');
    // two single days next to each other never make a full day
    keep(await apply(A[0], { from: day(6) }));
    keep(await apply(A[1], { from: day(7) }));
    r = keep(await apply(A[2], { from: day(6), to: day(7) }));
    ok(r.status === 201, 'one person on day 6 and another on day 7 leave a slot for a third on both days (max 1 a day)');

    console.log('\nC. What holds a slot');
    keep(await apply(A[0], { from: day(8) }));
    const second = keep(await apply(A[1], { from: day(8) }));
    r = await apply(A[2], { from: day(8) });
    ok(r.status === 409, 'a Pending request holds a slot (the third is refused)');
    await prisma.leaveRequest.update({ where: { id: second.body.id }, data: { status: 'Rejected' } });
    r = keep(await apply(A[2], { from: day(8) }));
    ok(r.status === 201, 'once the second one is Rejected its slot is free: the third is saved');
    r = await apply(A[3], { from: day(8) });
    ok(r.status === 409, '...and that one now holds the slot again');
    await prisma.leaveRequest.update({ where: { id: r.body ? (made.leaves[made.leaves.length - 1]) : '' }, data: { status: 'Cancelled' } });
    r = keep(await apply(A[3], { from: day(8) }));
    ok(r.status === 201, 'a Cancelled leave frees its slot too');
    keep(await apply(A[0], { from: day(9), halfDay: 'First Half' }));
    keep(await apply(A[1], { from: day(9), halfDay: 'Second Half' }));
    r = await apply(A[2], { from: day(9) });
    ok(r.status === 409, 'a half day holds a slot: two half days make the day full');
    // Approved holds a slot
    const appr = keep(await apply(A[0], { from: day(10) }));
    await prisma.leaveRequest.update({ where: { id: appr.body.id }, data: { status: 'Approved', decidedBy: 'ZZTL Approver', decidedAt: new Date() } });
    keep(await apply(A[1], { from: day(10) }));
    r = await apply(A[3], { from: day(10) });
    ok(r.status === 409, 'an Approved leave holds a slot');

    console.log('\nD. Beyond the limit on purpose');
    r = await apply(A[2], { from: day(0) }, { overrideTeamLimit: true });
    ok(r.status === 409 && r.body.code === 'TEAM_LEAVE_FULL', 'HR (no configure right) sending the override flag is still refused', r.status);
    r = keep(await call(sa.t, 'POST', '/leave', { employeeId: A[2].e.id, type: TYPE, reason: 'zz override', overrideBalance: true, overrideTeamLimit: true, fromDate: day(0), toDate: day(0) }));
    ok(r.status === 201, 'Super Admin applies beyond the limit with the override: saved', [r.status, r.text.slice(0, 200)]);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'Leave applied beyond the team limit', entityId: r.body && r.body.id } });
    ok(!!audit && /Team-A/.test(audit.toValue || ''), 'the override is in the audit log');
    r = await call(A[3].t, 'POST', '/leave', { type: TYPE, reason: 'zz', fromDate: day(0), toDate: day(0), overrideTeamLimit: true });
    ok(r.status === 409 && r.body.code === 'TEAM_LEAVE_FULL', 'an employee sending the override flag is still refused');

    console.log('\nE. who-else says the slots team-wise');
    r = await call(A[3].t, 'GET', `/leave/who-else?from=${day(4)}&to=${day(4)}`);
    ok(r.status === 200 && r.body.teamLimit && r.body.teamLimit.blocked === true && r.body.teamLimit.limit === 2 && /Team-A/.test(r.body.teamLimit.teamName), 'Team-A person: the team limit is full on day 4', r.body && r.body.teamLimit);
    const d4 = r.body.teamLimit && r.body.teamLimit.days.find((d) => d.date === day(4));
    ok(d4 && d4.taken === 2 && d4.left === 0 && d4.full === true && d4.people.length === 2, 'taken 2, left 0, with the two names');
    r = await call(A[3].t, 'GET', `/leave/who-else?from=${day(3)}&to=${day(3)}`);
    ok(r.body.teamLimit && r.body.teamLimit.blocked === false, 'a day with a slot left is not blocked');
    r = await call(B[2].t, 'GET', `/leave/who-else?from=${day(0)}&to=${day(0)}`);
    ok(r.body.teamLimit && /Team-B/.test(r.body.teamLimit.teamName) && r.body.teamLimit.days[0].people.every((p) => /ZZTL B/.test(p.name)), 'Team-B person sees only Team-B\'s slots and names');
    r = await call(N[0].t, 'GET', `/leave/who-else?from=${day(0)}&to=${day(0)}`);
    ok(r.status === 200 && r.body.teamLimit === null, 'a person with no team gets no team limit');

    console.log('\nF. The setting');
    r = await call(sa.t, 'GET', '/leave/concurrency-policy');
    ok(r.status === 200 && r.body.teamLeaveLimit && r.body.teamLeaveLimit.enabled === true && r.body.teamLeaveLimit.limit === 2, 'default: on, 2 per team', r.body && r.body.teamLeaveLimit);
    r = await call(A[0].t, 'PUT', '/leave/team-limit', { limit: 5 });
    ok(r.status === 403, 'an employee cannot change it (403)', r.status);
    r = await call(hr.t, 'PUT', '/leave/team-limit', { limit: 5 });
    ok(r.status === 403, 'HR without the configure right cannot change it either (403)', r.status);
    r = await call(sa.t, 'PUT', '/leave/team-limit', { limit: 0 });
    ok(r.status === 400, 'a limit of 0 is refused', r.status);
    r = await call(sa.t, 'PUT', '/leave/team-limit', { limit: 'many' });
    ok(r.status === 400, 'a limit that is not a number is refused', r.status);
    r = await call(sa.t, 'PUT', '/leave/team-limit', { limit: 3 });
    ok(r.status === 200 && r.body.teamLeaveLimit.limit === 3, 'Super Admin sets the limit to 3');
    r = keep(await apply(A[3], { from: day(10) }));
    ok(r.status === 201, 'with 3 allowed, the third person on day 10 is saved');
    r = await apply(N[0], { from: day(11) });
    keep(r);
    keep(await apply(A[0], { from: day(11) })); keep(await apply(A[1], { from: day(11) })); keep(await apply(A[2], { from: day(11) }));
    r = await apply(A[3], { from: day(11) });
    ok(r.status === 409, 'and a fourth is refused');
    r = await call(sa.t, 'PUT', '/leave/team-limit', { enabled: false });
    ok(r.status === 200 && r.body.teamLeaveLimit.enabled === false, 'Super Admin switches it off');
    r = keep(await apply(A[3], { from: day(11) }));
    ok(r.status === 201, 'switched off: the fourth person is saved');
    r = await call(A[0].t, 'GET', `/leave/who-else?from=${day(11)}&to=${day(11)}`);
    ok(r.body.teamLimit === null, 'switched off: who-else carries no team limit');
    r = await call(sa.t, 'PUT', '/leave/team-limit', { enabled: true, limit: 2 });
    ok(r.status === 200 && r.body.teamLeaveLimit.enabled === true && r.body.teamLeaveLimit.limit === 2, 'Super Admin switches it back on at 2');
    const audit2 = await prisma.auditLog.findFirst({ where: { action: 'Team leave limit updated' }, orderBy: { createdAt: 'desc' } });
    ok(!!audit2, 'every change of the setting is in the audit log');
  } catch (e) {
    console.error(e);
    fail += 1;
  } finally {
    try {
      const ids = made.leaves;
      const all = await prisma.leaveRequest.findMany({ where: { employeeId: { in: made.emps } }, select: { id: true } });
      const leaveIds = [...new Set([...ids, ...all.map((l) => l.id)])];
      await prisma.approvalStep.deleteMany({ where: { recordId: { in: leaveIds } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { entityId: { in: leaveIds } } }).catch(() => {});
      await prisma.leaveRequest.deleteMany({ where: { id: { in: leaveIds } } });
      // every fixture of this and of an earlier, interrupted run (ZZTL-): whatever points at them goes first (found from the schema's foreign keys)
      const emps = await prisma.employee.findMany({ where: { employeeCode: { startsWith: 'ZZTL-' } }, select: { id: true, userId: true } });
      const empIds = [...new Set([...made.emps, ...emps.map((x) => x.id)])];
      const userIds = [...new Set([...made.users, ...emps.map((x) => x.userId).filter(Boolean)])];
      const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
      const raw = new DatabaseSync(DB);
      raw.exec('PRAGMA busy_timeout = 20000');
      const q = (ids) => ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(',');
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
      const refs = [];
      tables.forEach((t) => raw.prepare(`PRAGMA foreign_key_list("${t}")`).all().forEach((f) => { if (f.table === 'Employee' || f.table === 'User') refs.push({ t, col: f.from, to: f.table }); }));
      for (let pass = 0; pass < 3; pass += 1) {
        refs.forEach((x) => {
          const ids = x.to === 'Employee' ? empIds : userIds;
          if (ids.length) { try { raw.exec(`DELETE FROM "${x.t}" WHERE "${x.col}" IN (${q(ids)})`); } catch { /* a later pass */ } }
        });
      }
      raw.close();
      await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (e) { console.error('cleanup:', e.message); }
    await prisma.appSetting.deleteMany({ where: { key: TL.KEY } }).catch(() => {});
    if (before) await prisma.appSetting.create({ data: { key: before.key, value: before.value } }).catch(() => {});
    const left = await prisma.employee.count({ where: { employeeCode: { startsWith: 'ZZTL-' } } }).catch(() => -1);
    console.log(`\nZZTL test employees left in the sandbox: ${left}`);
    console.log(`${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
