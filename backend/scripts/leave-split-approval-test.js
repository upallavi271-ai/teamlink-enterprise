#!/usr/bin/env node
// ---------------------------------------------------------------------------
// LEAVE APPROVAL BY PAY MONTH (founder 2026-11-25 / 27, utils/leaveSplit.js) - SANDBOX ONLY.
//   node scripts/leave-split-approval-test.js     (needs the sandbox API: TL_API, default http://localhost:4011, and prisma/sandbox.db)
// The first 2 leave days of a pay month need the Team Lead and then HR; every further day the Super Admin. Pay month 16th-15th here.
//
//   A  the setting: on for TeamLink, off in a second company; only Super Admin / Admin may switch it
//   B  4 days, none used: days 1-2 wait for the Team Lead then HR, days 3-4 for the Super Admin only
//   C  who may decide: the Team Lead's yes sends it to HR, HR's yes grants it; STL / Manager only see; nobody else touches the rest
//   D  the Super Admin approves the rest
//   E  the monthly count: used days (waiting or approved), rejected and cancelled give them back, half days, a new pay month, a crossing leave
//   F  each part stands on its own
//   G  not under the rule: a TL's own leave, a Manager's own leave, switch off, TL rule counting requests; requests raised before
//   H  the Approve / Reject screen: every part with who approved it, the employee's other leaves, balance, totals
//   I  what payroll charges (utils/payrollLeaveRule.js: 1 free day, approved 1 LOP, waiting 2 LOP, rejected + absent 2 LOP, sandwich)
// Removes every row it made and puts the settings back. Refuses to run against dev.db / port 4010.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
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
const LS = require('../src/utils/leaveSplit');
const AD = require('../src/utils/attendanceDays');
const PL = require('../src/utils/payrollLeaveRule');
const leaveDays = require('../src/utils/leaveDays');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600)}`); } };
const RUN = Date.now().toString(36);
const DEPT = `ZZSP Dept ${RUN}`;
const made = { users: [], emps: [] };
const tokens = new Map();
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

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
    } catch (e) { if (i === 9) throw e; await wait(3000); }
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const tokenFor = async (userId) => {
  if (!tokens.has(userId)) tokens.set(userId, jwt.sign(tokenPayload(await resolveIdentity(userId)), process.env.JWT_SECRET, { expiresIn: '2h' }));
  return tokens.get(userId);
};
const base = { passwordHash: 'x'.repeat(40), atsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: false, status: 'Active' };
async function mk(tag, role, { dept = DEPT, lead = null, designation = 'Executive' } = {}) {
  const name = `ZZTEST SP ${tag} ${RUN}`;
  const u = await prisma.user.create({ data: { ...base, name, email: `zzsp-${tag.toLowerCase()}-${RUN}@example.test`, username: `zzsp-${tag.toLowerCase()}-${RUN}@example.test`, role, hrmsRole: role, accountsRole: role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : 'NONE' } });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: {
      employeeCode: `ZZSP-${tag}-${RUN}`.slice(0, 40), name, userId: u.id, designation, employmentStatus: 'Active', department: dept, team: null, email: u.email,
      dateOfJoining: new Date('2025-01-01'), ...(lead ? { tl: lead.name, reportingManagerId: lead.e.id } : {}),
    },
  });
  made.emps.push(e.id);
  return { u, e, name, t: await tokenFor(u.id) };
}

const rowsOf = (who) => prisma.leaveRequest.findMany({ where: { employeeId: who.e.id }, orderBy: [{ fromDate: 'asc' }, { createdAt: 'asc' }] });
const one = (id) => prisma.leaveRequest.findUnique({ where: { id } });
const stepsOf = (id) => prisma.approvalStep.findMany({ where: { workflow: 'leave', recordId: id }, orderBy: { seq: 'asc' } });
const pendingStep = async (id) => (await stepsOf(id)).find((s) => s.status === 'Pending') || null;
const kindOf = async (id) => { const s = await LS.of(id); return s ? s.kind : null; };
const shape = async (rows) => Promise.all(rows.map(async (r) => `${r.fromDate.slice(5)}..${r.toDate.slice(5)}=${r.days}:${await kindOf(r.id)}`));

// Pay month "May 2027" = 16 Apr - 15 May; "June 2027" = 16 May - 15 Jun. Fri 7, Sat 8, (Sunday), Mon 10, Tue 11 May.
const MAY = { fri: '2027-05-07', sat: '2027-05-08', mon: '2027-05-10', tue: '2027-05-11', wed: '2027-05-12', thu: '2027-05-13', fri2: '2027-05-14', sat2: '2027-05-15' };
const JUN = { mon: '2027-05-17', tue: '2027-05-18', wed: '2027-05-19', thu: '2027-05-20' };
const OLD = { fri: '2026-07-10', tue: '2026-07-14' }; // long past: the "old pending" desk

(async () => {
  const keys = [LS.KEY, 'payroll.cycle'];
  const before = await prisma.appSetting.findMany({ where: { key: { in: keys } } });
  const ruleBefore = await prisma.approvalLevelConfig.findUnique({ where: { workflow_level: { workflow: 'leave-tl-rule', level: 'TL' } } });
  try {
    try { const h = await fetch(`${API}/health`); if (!h.ok) throw new Error('x'); } catch { console.error(`The sandbox API is not answering at ${API}.`); process.exit(3); }
    await prisma.appSetting.deleteMany({ where: { key: { in: keys } } }); // split: default
    await prisma.appSetting.create({ data: { key: 'payroll.cycle', value: JSON.stringify({ startDay: 16, effectiveFrom: '2026-01' }) } });
    await prisma.approvalLevelConfig.deleteMany({ where: { workflow: 'leave-tl-rule' } }); // default: on, days, 2
    await wait(3500); // the pay-cycle setting is cached for 3 seconds

    const tl = await mk('TL', 'TL', { designation: 'Team Lead' });
    const stl = await mk('STL', 'STL', { designation: 'Senior Team Lead' });
    const mgr = await mk('MGR', 'MANAGER', { designation: 'Manager' });
    const hr = await mk('HR', 'HR');
    const admin = await mk('SA', 'SUPER_ADMIN');
    const emp = async (tag) => mk(tag, 'EMPLOYEE', { lead: tl });
    const types = (await call(hr.t, 'GET', '/leave/types')).body || [];
    const TYPE = (types.find((t) => t.name === 'Casual Leave' && t.active !== false) || types.find((t) => t.active !== false)).name;
    const reasons = ((await call(hr.t, 'GET', '/leave/reasons')).body || []).filter((r) => r.active);
    const apply = (who, from, to, extra = {}) => call(who.t, 'POST', '/leave', { type: TYPE, reason: 'zz split test', fromDate: from, toDate: to, ...extra });
    // Applied by HR with the balance override, for the cases that need more days than a new person holds.
    const applyFor = (who, from, to = from, extra = {}) => call(hr.t, 'POST', '/leave', { employeeId: who.e.id, type: TYPE, reason: 'zz split test', overrideBalance: true, fromDate: from, toDate: to, ...extra });
    const decide = (token, id, body) => call(token, 'PATCH', `/leave/${id}/decision`, body);
    const yes = (token, id, extra = {}) => decide(token, id, { status: 'Approved', comment: 'ok', ...(reasons.length ? { approvalReason: reasons[0].label } : {}), ...extra });
    const no = (token, id) => decide(token, id, { status: 'Rejected', rejectReason: 'zz not possible' });
    const screen = (token, id) => call(token, 'GET', `/leave/${id}/workflow`);
    const approverToken = async (id) => { const s = await pendingStep(id); return tokenFor(s.approverUserId); };
    const hrToken = approverToken; // after the Team Lead, the pending step is HR's
    const both = async (id) => { const a = await yes(tl.t, id); const b = await yes(await hrToken(id), id); return [a, b]; };
    const balanceOf = async (who) => (await prisma.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: who.e.id, type: TYPE } } }))?.taken || 0;

    const counted = await leaveDays.countFor(MAY.fri, MAY.tue);
    ok(counted.countedDays === 4, 'the test dates are four working days around one Sunday', counted);

    console.log('\nA. The setting');
    const companyWas = process.env.COMPANY_KEY;
    process.env.COMPANY_KEY = 'zzco';
    ok((await LS.getSettings()).enabled === false, 'a second company running this code (COMPANY_KEY set) starts with it OFF');
    if (companyWas === undefined) delete process.env.COMPANY_KEY; else process.env.COMPANY_KEY = companyWas;
    let r = await call(hr.t, 'GET', '/leave/concurrency-policy');
    ok(r.body && r.body.splitApproval && r.body.splitApproval.enabled === true && r.body.splitApproval.limit === 2 && r.body.splitApproval.applies === true, 'on by default, 2 days (the TL rule limit)', r.body && r.body.splitApproval);
    const worker = await emp('E0');
    r = await call(worker.t, 'PUT', '/leave/split-approval', { enabled: false });
    ok(r.status === 403, 'an employee cannot switch it', r.status);
    r = await call(hr.t, 'PUT', '/leave/split-approval', { enabled: false });
    ok(r.status === 403, 'plain HR cannot switch it', r.status);
    r = await call(admin.t, 'PUT', '/leave/split-approval', {});
    ok(r.status === 400, 'a request that does not say on or off is refused', r.status);
    r = await call(admin.t, 'PUT', '/leave/split-approval', { enabled: false });
    ok(r.status === 200 && r.body.splitApproval.enabled === false, 'the Super Admin switches it off', r.body);
    r = await call(admin.t, 'PUT', '/leave/split-approval', { enabled: true });
    ok(r.status === 200 && r.body.splitApproval.enabled === true, 'and on again', r.body);

    console.log('\nB. Four days, none used this pay month');
    const e1 = await emp('E1');
    r = await call(e1.t, 'GET', `/leave/split-preview?from=${MAY.fri}&to=${MAY.tue}`);
    const pv = r.body && r.body.split;
    ok(pv && pv.parts.length === 2 && pv.parts[0].kind === 'tl' && pv.parts[0].toDate === MAY.sat && pv.parts[1].kind === 'sa' && pv.parts[1].days === 2 && pv.months[0].usedBefore === 0 && pv.leadName === tl.name && pv.hrName, 'the Apply form is told beforehand: Fri-Sat Team Lead then HR, Mon-Tue Super Admin', pv);
    ok(pv && /16 Apr/.test(pv.months[0].rangeText) && /15 May/.test(pv.months[0].rangeText), 'the month is the pay month 16 Apr - 15 May', pv && pv.months);
    r = await apply(e1, MAY.fri, MAY.tue);
    ok(r.status === 201 && r.body.split && r.body.split.parts.length === 2, 'applied: the answer names two parts', [r.status, r.text.slice(0, 300)]);
    let rows = await rowsOf(e1);
    ok(rows.length === 2, 'two requests saved', rows.length);
    const [p1, p2] = rows;
    ok(p1.fromDate === MAY.fri && p1.toDate === MAY.sat && p1.days === 2 && p2.fromDate === MAY.mon && p2.toDate === MAY.tue && p2.days === 2, 'Fri-Sat and Mon-Tue (the Sunday belongs to neither)', await shape(rows));
    ok(r.body.id === p1.id, 'the id returned (documents are attached to it) is part 1');
    let s1 = await stepsOf(p1.id);
    ok(s1.find((s) => s.level === 'TL').status === 'Pending' && s1.find((s) => s.level === 'HR').status === 'Waiting', 'part 1: waiting for the Team Lead, HR next', s1.map((s) => `${s.level}:${s.status}`));
    ok(s1.filter((s) => ['Pending', 'Waiting'].includes(s.status)).length === 2 && s1.filter((s) => ['STL', 'MANAGER', 'SUPER_ADMIN'].includes(s.level) && s.approverUserId).every((s) => s.status === 'Visibility'), 'part 1: STL, Manager and the Super Admin only see it', s1.map((s) => `${s.level}:${s.status}`));
    const s2 = await pendingStep(p2.id);
    ok(s2 && s2.level === 'SUPER_ADMIN' && (await stepsOf(p2.id)).filter((s) => ['Pending', 'Waiting'].includes(s.status)).length === 1, 'part 2: the Super Admin only', s2);
    await wait(1500);
    const said = (await prisma.notification.findMany({ where: { userId: { in: [tl.u.id, s2.approverUserId] }, createdAt: { gte: new Date(Date.now() - 60000) } } })).map((b) => `${b.userId} ${b.title} ${b.message}`).join('\n');
    ok(new RegExp(`${tl.u.id}[\\s\\S]*part 1 of 2`).test(said), 'the Team Lead is told, and that it is part 1 of 2', said.slice(0, 400));
    ok(new RegExp(`${s2.approverUserId}[\\s\\S]*part 2 of 2`).test(said), 'the Super Admin is told about part 2 at the same time', said.slice(0, 400));
    r = await call(e1.t, 'GET', '/leave');
    ok(r.body && r.body.filter((x) => x.split).length === 2 && r.body.some((x) => x.split && x.split.kind === 'sa' && x.split.part === 2), 'the employee\'s list marks the parts', r.body && r.body.map((x) => x.split));
    r = await apply(e1, MAY.mon, MAY.mon);
    ok(r.status === 409 && r.body.code === 'DUPLICATE_LEAVE', 'applying again for a day of part 2 is still a duplicate', r.status);

    console.log('\nC. Who may decide which part');
    r = await yes(tl.t, p2.id);
    ok(r.status === 403 && /only the Super Admin/i.test(r.body.error || ''), 'the TL cannot approve part 2', [r.status, r.body]);
    r = await yes(hr.t, p2.id);
    ok(r.status === 403 && /only the Super Admin/i.test(r.body.error || ''), 'HR cannot approve part 2', [r.status, r.body]);
    r = await no(hr.t, p2.id);
    ok(r.status === 403 && (await one(p2.id)).status === 'Pending', 'HR cannot reject part 2', r.status);
    r = await call(hr.t, 'POST', `/leave/${p2.id}/reassign`, { toUserId: hr.u.id, reason: 'zz' });
    ok(r.status >= 400, 'part 2 cannot be handed to HR', [r.status, r.body]);
    let v = (await screen(hr.t, p2.id)).body;
    ok(v && v.workflow.canAct === false && v.workflow.canDirect === false && v.reassign.allowed === false, 'HR\'s screen shows no buttons on part 2', v && { a: v.workflow.canAct, d: v.workflow.canDirect, re: v.reassign });
    r = await yes(hr.t, p1.id); // HR before the Team Lead
    ok(r.status === 403 && (await one(p1.id)).status === 'Pending', 'HR cannot approve part 1 before the Team Lead', [r.status, r.body]);
    r = await yes(stl.t, p1.id);
    ok(r.status === 403, 'the STL cannot approve part 1 (only sees it)', [r.status, r.body]);
    r = await yes(mgr.t, p1.id);
    ok(r.status === 403, 'the Manager cannot approve part 1 (only sees it)', [r.status, r.body]);
    v = (await screen(tl.t, p1.id)).body;
    ok(v && v.workflow.canAct === true && v.tl && /Team Lead and then HR/.test(v.tl.note), 'the Team Lead\'s screen on part 1: may decide, told that HR follows', v && v.tl);
    ok(v && v.split && v.split.parts.length === 2 && v.split.parts[0].approvals.map((a) => `${a.level}:${a.status}`).join() === 'TL:Pending,HR:Waiting' && v.split.parts[1].approvals.map((a) => `${a.level}:${a.status}`).join() === 'SUPER_ADMIN:Pending', 'and shows both parts with their approvers', v && v.split.parts);
    r = await decide(tl.t, p1.id, { status: 'Approved' });
    ok(r.status === 400 && r.body.tlReasonRequired, 'the Team Lead still has to give a reason', r.body);
    r = await decide(tl.t, p1.id, { status: 'Approved', comment: 'tl ok' });
    let hrStep = await pendingStep(p1.id);
    ok(r.status === 200 && (await one(p1.id)).status === 'Pending' && hrStep && hrStep.level === 'HR', 'the Team Lead approves: still Pending, now with HR', [r.status, r.text.slice(0, 200), hrStep && hrStep.level]);
    ok((await balanceOf(e1)) === 0, 'balance not moved yet');
    await wait(1200);
    const hrBell = await prisma.notification.findMany({ where: { userId: hrStep.approverUserId, createdAt: { gte: new Date(Date.now() - 60000) } } });
    ok(hrBell.some((b) => /your approval is needed too/.test(b.message || '')), 'HR is told at once', hrBell.map((b) => b.title));
    r = await yes(await hrToken(p1.id), p1.id, { comment: 'hr ok' });
    ok(r.status === 200 && (await one(p1.id)).status === 'Approved', 'HR approves: part 1 is Approved', [r.status, r.text.slice(0, 300)]);
    s1 = await stepsOf(p1.id);
    ok(s1.find((s) => s.level === 'TL').status === 'Approved' && s1.find((s) => s.level === 'HR').status === 'Approved' && !s1.some((s) => s.level === 'SUPER_ADMIN' && s.status === 'Approved'), 'both approvals are on record', s1.map((s) => `${s.level}:${s.status}`));
    ok((await one(p2.id)).status === 'Pending', 'part 2 still waits');
    ok((await balanceOf(e1)) === 2, 'balance: 2 days taken for part 1');

    console.log('\nD. The Super Admin approves the rest');
    const sa2 = await approverToken(p2.id);
    if (reasons.length) {
      r = await decide(sa2, p2.id, { status: 'Approved' });
      ok(r.status === 400 && Array.isArray(r.body.reasons), 'the approval reason still applies to a 4 day leave', [r.status, r.body]);
    }
    r = await yes(sa2, p2.id);
    ok(r.status === 200 && (await one(p2.id)).status === 'Approved', 'part 2 Approved', [r.status, r.text.slice(0, 300)]);
    ok((await balanceOf(e1)) === 5, 'balance: 4 days + the Sunday between them (sandwich rule, as for one 4 day leave)', await balanceOf(e1));

    console.log('\nE. Counting by the pay month');
    r = await applyFor(e1, MAY.wed);
    rows = await rowsOf(e1);
    let last = rows.find((x) => x.fromDate === MAY.wed);
    ok(rows.length === 3 && (await kindOf(last.id)) === 'sa' && (await pendingStep(last.id)).level === 'SUPER_ADMIN', 'a 5th day in the same month: Super Admin only', await shape(rows));
    await applyFor(e1, MAY.thu, MAY.thu, { halfDay: 'First Half' });
    last = (await rowsOf(e1)).find((x) => x.fromDate === MAY.thu);
    ok((await kindOf(last.id)) === 'sa', 'and a half day too', await kindOf(last.id));
    await applyFor(e1, JUN.mon);
    last = (await rowsOf(e1)).find((x) => x.fromDate === JUN.mon);
    ok((await kindOf(last.id)) === 'tl' && (await pendingStep(last.id)).level === 'TL', 'the next pay month (from 16 May) starts again: Team Lead', await kindOf(last.id));
    await applyFor(e1, JUN.tue, JUN.thu);
    rows = (await rowsOf(e1)).filter((x) => x.fromDate >= JUN.tue);
    ok(rows.length === 2 && rows[0].days === 1 && (await kindOf(rows[0].id)) === 'tl' && rows[1].days === 2 && (await kindOf(rows[1].id)) === 'sa', 'one day used (still waiting), then 3 days: 1 Team Lead + HR, 2 Super Admin', await shape(rows));
    r = await call(e1.t, 'GET', `/leave/split-preview?from=2027-05-22&to=2027-05-22`);
    ok(r.body.split && r.body.split.months[0].usedBefore === 4 && r.body.split.parts[0].kind === 'sa', 'the preview counts waiting days', r.body.split);

    const e2 = await emp('E2');
    await applyFor(e2, MAY.fri, MAY.sat);
    rows = await rowsOf(e2);
    ok(rows.length === 1 && (await kindOf(rows[0].id)) === 'tl', '2 days: one request, Team Lead then HR', await shape(rows));
    await no(tl.t, rows[0].id);
    await applyFor(e2, MAY.mon, MAY.tue);
    last = (await rowsOf(e2)).find((x) => x.fromDate === MAY.mon);
    ok((await kindOf(last.id)) === 'tl', 'rejected days are given back to the month', await kindOf(last.id));
    r = await call(e2.t, 'POST', `/leave/${last.id}/cancel`, { reason: 'zz not needed' });
    await applyFor(e2, MAY.wed, MAY.thu);
    last = (await rowsOf(e2)).find((x) => x.fromDate === MAY.wed);
    ok(r.status === 200 && (await kindOf(last.id)) === 'tl', 'cancelled days too', [r.status, await kindOf(last.id)]);

    const e3 = await emp('E3');
    await applyFor(e3, MAY.fri, MAY.fri, { halfDay: 'First Half' });
    await applyFor(e3, MAY.sat, MAY.sat, { halfDay: 'First Half' });
    await applyFor(e3, MAY.mon);
    await applyFor(e3, MAY.tue, MAY.tue, { halfDay: 'First Half' });
    rows = await rowsOf(e3);
    ok((await Promise.all(rows.map((x) => kindOf(x.id)))).join() === 'tl,tl,tl,sa', 'half + half + 1 day = 2 for the Team Lead, the next half day to the Super Admin', await shape(rows));

    const e4 = await emp('E4');
    await applyFor(e4, MAY.fri2, JUN.tue); // Fri 14, Sat 15 (May month) | Mon 17, Tue 18 (June month)
    rows = await rowsOf(e4);
    ok(rows.length === 1 && rows[0].days === 4 && (await kindOf(rows[0].id)) === 'tl', '4 days across two pay months, 2 in each: all Team Lead then HR, one request', await shape(rows));
    const e5 = await emp('E5');
    await applyFor(e5, MAY.fri);
    await applyFor(e5, MAY.fri2, JUN.tue);
    rows = (await rowsOf(e5)).filter((x) => x.fromDate >= MAY.fri2);
    ok(rows.length === 3 && (await Promise.all(rows.map((x) => kindOf(x.id)))).join() === 'tl,sa,tl' && rows[1].fromDate === MAY.sat2 && rows[2].days === 2, 'with 1 day used in May: 14th Team Lead, 15th Super Admin, 17-18 Team Lead (three parts)', await shape(rows));
    const e5b = await emp('E5B');
    await applyFor(e5b, MAY.fri, MAY.thu); // 6 working days
    rows = await rowsOf(e5b);
    ok(rows.length === 2 && rows[0].days === 2 && rows[1].days === 4, '6 days: 2 + 4', await shape(rows));

    console.log('\nF. Each part stands on its own');
    const f1 = await emp('F1');
    await applyFor(f1, MAY.fri, MAY.tue);
    let [a, b] = await rowsOf(f1);
    await both(a.id);
    r = await no(await approverToken(b.id), b.id);
    ok(r.status === 200 && (await one(a.id)).status === 'Approved' && (await one(b.id)).status === 'Rejected', 'Team Lead + HR yes, Super Admin no: first 2 approved, last 2 rejected', r.body);
    const f2 = await emp('F2');
    await applyFor(f2, MAY.fri, MAY.tue);
    [a, b] = await rowsOf(f2);
    r = await no(tl.t, a.id);
    ok(r.status === 200 && (await one(a.id)).status === 'Rejected' && (await one(b.id)).status === 'Pending', 'Team Lead no: part 1 rejected (HR not asked), part 2 still waits', r.body);
    await yes(await approverToken(b.id), b.id);
    ok((await one(b.id)).status === 'Approved' && (await one(a.id)).status === 'Rejected', 'and the Super Admin may still approve the rest');
    const f3 = await emp('F3');
    await applyFor(f3, MAY.fri, MAY.tue);
    [a, b] = await rowsOf(f3);
    await yes(tl.t, a.id);
    r = await no(await hrToken(a.id), a.id);
    ok(r.status === 200 && (await one(a.id)).status === 'Rejected', 'Team Lead yes, HR no: rejected', r.body);
    const f4 = await emp('F4');
    await applyFor(f4, MAY.fri, MAY.tue);
    [a, b] = await rowsOf(f4);
    const saUser = await approverToken(b.id);
    r = await yes(saUser, b.id);
    ok(r.status === 200 && (await one(b.id)).status === 'Approved' && (await one(a.id)).status === 'Pending', 'the Super Admin may decide the rest before the Team Lead answers', r.body);
    r = await yes(saUser, a.id);
    ok(r.status === 200 && (await one(a.id)).status === 'Approved', 'the Super Admin may still decide part 1 directly (as on any leave)', [r.status, r.body]);
    const f5 = await emp('F5');
    await applyFor(f5, MAY.fri, MAY.tue);
    [a, b] = await rowsOf(f5);
    r = await call(f5.t, 'POST', `/leave/${a.id}/cancel`, { reason: 'zz not needed' });
    ok(r.status === 200 && (await one(a.id)).status === 'Cancelled' && (await one(b.id)).status === 'Pending', 'the employee can cancel one part on its own', [r.status, r.body]);

    console.log('\nG. Not under the rule');
    const lead2 = await mk('TL2', 'TL', { designation: 'Team Lead' });
    await applyFor(lead2, MAY.fri, MAY.tue);
    rows = await rowsOf(lead2);
    ok(rows.length === 1 && rows[0].days === 4 && !(await LS.of(rows[0].id)), 'a TL\'s own 4 day leave: one request, as before (only the Super Admin approves it)', await shape(rows));
    await applyFor(mgr, MAY.fri, MAY.tue);
    rows = await rowsOf(mgr);
    ok(rows.length === 1 && !(await LS.of(rows[0].id)), 'a Manager\'s own leave: one request, as before', await shape(rows));
    await applyFor(hr, MAY.fri);
    rows = await rowsOf(hr);
    const hrOwn = rows.length ? await stepsOf(rows[0].id) : [];
    ok(rows.length === 1 && !hrOwn.some((s) => s.level === 'HR' && ['Pending', 'Waiting'].includes(s.status)), 'HR\'s own leave never waits on HR', hrOwn.map((s) => `${s.level}:${s.status}`));
    await call(admin.t, 'PUT', '/leave/split-approval', { enabled: false });
    const g1 = await emp('G1');
    await applyFor(g1, MAY.fri, MAY.tue);
    const offRow = (await rowsOf(g1))[0];
    ok((await rowsOf(g1)).length === 1 && (await pendingStep(offRow.id)).level === 'HR', 'switched off: one 4 day request with HR', (await rowsOf(g1)).length);
    const g2 = await emp('G2');
    await applyFor(g2, MAY.mon);
    const offShort = (await rowsOf(g2))[0];
    console.log('\n   Requests raised before keep the old rule');
    await call(admin.t, 'PUT', '/leave/split-approval', { enabled: true });
    r = await yes(tl.t, offRow.id);
    ok(r.status >= 400 && (await one(offRow.id)).status === 'Pending', 'the TL still cannot approve the old 4 day request', [r.status, r.body]);
    r = await yes(hr.t, offRow.id);
    ok(r.status === 200 && (await one(offRow.id)).status === 'Approved' && (await rowsOf(g1)).length === 1, 'HR\'s approval still grants it, as before', [r.status, r.text.slice(0, 300)]);
    r = await yes(tl.t, offShort.id);
    ok(r.status === 200 && (await one(offShort.id)).status === 'Approved', 'an old 1 day request: the TL\'s approval alone still grants it', [r.status, r.text.slice(0, 300)]);
    await applyFor(g2, MAY.tue, MAY.wed);
    rows = (await rowsOf(g2)).filter((x) => x.fromDate >= MAY.tue);
    ok(rows.length === 2 && (await kindOf(rows[0].id)) === 'tl' && (await kindOf(rows[1].id)) === 'sa', 'but an old leave does count in its month', await shape(rows));
    const g3 = await emp('G3');
    await applyFor(g3, OLD.fri, OLD.tue);
    const [, old2] = await rowsOf(g3);
    r = await call(hr.t, 'POST', `/leave/pulse/old-pending/${old2.id}/close`, { action: 'approve', reason: 'zz' });
    ok(r.status >= 400 && (await one(old2.id)).status === 'Pending', 'HR cannot approve the Super Admin\'s days from the old-pending list either', [r.status, r.body]);
    const ruleSet = await call(admin.t, 'PUT', '/leave/tl-rule', { mode: 'count', limit: 2, enabled: true });
    r = await call(admin.t, 'GET', '/leave/concurrency-policy');
    ok(ruleSet.status === 200 && r.body.splitApproval.applies === false && /counts requests/.test(r.body.splitApproval.blockedBy || ''), 'TL rule counting requests: the setting says it does nothing', r.body.splitApproval);
    const g4 = await emp('G4');
    await applyFor(g4, MAY.fri, MAY.tue);
    ok((await rowsOf(g4)).length === 1, 'and nothing is split');
    await call(admin.t, 'PUT', '/leave/tl-rule', { mode: 'days', limit: 1, enabled: true });
    const g5 = await emp('G5');
    await applyFor(g5, MAY.fri, MAY.tue);
    rows = await rowsOf(g5);
    ok(rows.length === 2 && rows[0].days === 1 && rows[1].days === 3, 'limit changed to 1 day: 1 + 3', await shape(rows));
    await call(admin.t, 'PUT', '/leave/tl-rule', { mode: 'days', limit: 2, enabled: true });

    console.log('\nH. The Approve / Reject screen');
    const h1 = await emp('H1');
    await applyFor(h1, '2027-03-01', '2027-03-02'); // approved (March)
    await applyFor(h1, '2027-03-22'); // rejected (April pay month)
    const [m1, m2] = await rowsOf(h1);
    await both(m1.id);
    await no(tl.t, m2.id);
    await applyFor(h1, MAY.fri, MAY.tue);
    const all = await rowsOf(h1);
    const cur = all.find((x) => x.fromDate === MAY.fri);
    v = (await screen(tl.t, cur.id)).body;
    const h = v && v.employeeLeave;
    ok(h && h.year === '2027' && h.count === 3 && !h.requests.some((x) => x.id === cur.id), 'the other leaves are listed, this one is not', h && [h.year, h.count]);
    ok(h && h.totals.approved.days === 2 && h.totals.rejected.days === 1 && h.totals.pending.days === 2, 'totals: approved 2, rejected 1, waiting 2 (the other part)', h && h.totals);
    const done = h && h.requests.find((x) => x.id === m1.id);
    ok(done && done.approvals.map((x) => `${x.level}:${x.status}`).join() === 'TL:Approved,HR:Approved' && done.approvals[0].name === tl.name, 'an approved one shows BOTH who approved: Team Lead and HR', done && done.approvals);
    const rej = h && h.requests.find((x) => x.id === m2.id);
    ok(rej && rej.status === 'Rejected' && rej.approvals.map((x) => `${x.level}:${x.status}`).join() === 'TL:Rejected' && /zz not possible/.test(rej.approvals[0].note || ''), 'a rejected one says who and why', rej && rej.approvals);
    ok(h && h.requests.some((x) => x.split && x.split.sameApplication), 'the other part is marked');
    ok(h && h.balances.some((x) => x.type === TYPE && x.taken === 2), 'balance by type', h && h.balances.filter((x) => x.type === TYPE));
    await yes(tl.t, cur.id);
    v = (await screen(await hrToken(cur.id), cur.id)).body;
    ok(v && v.workflow.canAct === true && v.split.parts[0].approvals[0].status === 'Approved' && v.split.parts[0].approvals[1].status === 'Pending' && v.split.parts[0].waitingLevel === 'HR', 'HR\'s screen: the Team Lead\'s approval is shown and HR may decide', v && v.split.parts[0]);
    v = (await screen(h1.t, cur.id)).body;
    ok(v && v.employeeLeave && v.workflow.canAct === false && v.split.parts.length === 2, 'the employee sees the parts and their own history, with no buttons');
    r = await screen(e1.t, cur.id);
    ok(r.status === 403, 'a colleague cannot open it', r.status);

    console.log('\nI. What payroll charges (1 free day, approved 1 LOP, waiting or rejected-and-absent 2 LOP)');
    const cfg = (await prisma.hrConfig.findFirst()) || {};
    const lopFor = async (who, { rejected = null } = {}) => {
      const { days } = await AD.loadDays(prisma, { employees: [who.e], from: MAY.fri, to: MAY.tue, cfg, asOf: '2027-06-15' });
      const dr = days(who.e).filter((d) => d.date >= MAY.fri && d.date <= MAY.tue);
      const a1 = PL.allocate(dr, { paidLeave: 1, days: 2, carry: 0, rejected, unmarkedUnpaid: true });
      const absent = dr.filter((d) => rejected && rejected.has(d.date)).reduce((n, d) => n + (Number(d.absent) || (d.status === 'Missing Check-In' ? 1 : 0)), 0);
      return { leave: a1.leaveCost, waiting: a1.pendingLop, rejected: Math.round((a1.rejectedExtra + absent) * 100) / 100, total: Math.round((a1.leaveCost + a1.pendingLop + a1.rejectedExtra + absent) * 100) / 100 };
    };
    const q1 = await emp('Q1');
    await applyFor(q1, MAY.fri, MAY.tue);
    const [x1, x2] = await rowsOf(q1);
    const nobody = await lopFor(q1);
    await yes(tl.t, x1.id);
    const tlOnly = await lopFor(q1);
    await yes(await hrToken(x1.id), x1.id);
    const tlHr = await lopFor(q1);
    await yes(await approverToken(x2.id), x2.id);
    const full = await lopFor(q1);
    const q2 = await emp('Q2');
    await applyFor(q2, MAY.fri, MAY.tue);
    const [y1, y2] = await rowsOf(q2);
    await both(y1.id);
    await no(await approverToken(y2.id), y2.id);
    const saNo = await lopFor(q2, { rejected: new Set([MAY.mon, MAY.tue]) });
    console.log('       Fri-Tue (Sunday between). LOP days:', JSON.stringify({ nobody, tlOnly, tlHr, full, saNo }));
    ok(nobody.total === 8 && tlOnly.total === 8, 'nobody decided, or only the Team Lead: 1 free day, the other 4 (with the Sunday) x 2 = 8', { nobody, tlOnly });
    ok(tlHr.leave === 1 && tlHr.waiting === 6 && tlHr.total === 7, 'Team Lead + HR approved, Super Admin not yet: Sat 1, Sun + Mon + Tue x 2 = 7', tlHr);
    ok(full.leave === 4 && full.waiting === 0 && full.total === 4, 'all approved: 4 days x 1 = 4', full);
    ok(saNo.leave === 1 && saNo.waiting === 0 && saNo.rejected === 4 && saNo.total === 5, 'Super Admin rejected and the person stayed away: Sat 1 + Mon, Tue x 2 = 5', saNo);
  } catch (e) {
    fail += 1; console.error('  FAIL the test stopped:', e.stack || e.message);
  } finally {
    try {
      const mine = await prisma.leaveRequest.findMany({ where: { employeeId: { in: made.emps } }, select: { id: true } });
      const ids = mine.map((l) => l.id);
      await wait(1500); // let the last notifications land before they are removed
      await prisma.approvalStep.deleteMany({ where: { recordId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
      await prisma.appSetting.deleteMany({ where: { key: { in: ids.map((i) => `leave.meta.${i}`) } } });
      await prisma.leaveRequest.deleteMany({ where: { id: { in: ids } } });
      const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
      const raw = new DatabaseSync(DB);
      raw.exec('PRAGMA busy_timeout = 20000');
      const q = (list) => list.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(',');
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
      const refs = [];
      tables.forEach((t) => raw.prepare(`PRAGMA foreign_key_list("${t}")`).all().forEach((f) => { if (f.table === 'Employee' || f.table === 'User') refs.push({ t, col: f.from, to: f.table }); }));
      for (let p = 0; p < 3; p += 1) {
        refs.forEach((x) => {
          const list = x.to === 'Employee' ? made.emps : made.users;
          if (list.length) { try { raw.exec(`DELETE FROM "${x.t}" WHERE "${x.col}" IN (${q(list)})`); } catch { /* a later pass */ } }
        });
      }
      raw.close();
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    } catch (e) { console.error('cleanup:', e.message); }
    await prisma.appSetting.deleteMany({ where: { key: { in: keys } } }).catch(() => {});
    for (const row of before) await prisma.appSetting.create({ data: { key: row.key, value: row.value } }).catch(() => {});
    await prisma.approvalLevelConfig.deleteMany({ where: { workflow: 'leave-tl-rule' } }).catch(() => {});
    if (ruleBefore) await prisma.approvalLevelConfig.create({ data: ruleBefore }).catch(() => {});
    const left = await prisma.employee.count({ where: { employeeCode: { startsWith: 'ZZSP-' } } }).catch(() => -1);
    console.log(`\nZZSP test employees left in the sandbox: ${left}`);
    console.log(`${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
