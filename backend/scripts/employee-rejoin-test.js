#!/usr/bin/env node
// ---------------------------------------------------------------------------
// REJOIN EMPLOYEE (founder 2026-10-15) - SANDBOX ONLY.
//   node scripts/employee-rejoin-test.js        (needs the sandbox API on :4011 and prisma/sandbox.db)
// Creates ZZTEST RJ users / employees / seats in sandbox.db, drives the API (and utils/rejoin.js for the refusal matrix),
// then removes every row it made. It refuses to run against dev.db / port 4010.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
if (!fs.existsSync(DB)) { console.error('No prisma/sandbox.db - start the sandbox first.'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
const API = `${String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '')}/api`; // TL_API: a private test server on its own port
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const R = require('../src/utils/rejoin');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${extra}`); } };
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function http(user, method, url, body) {
  let r;
  for (let i = 0; i < 15; i += 1) {
    try { r = await fetch(`${API}${url}`, { method, headers: { Authorization: `Bearer ${tok(user)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); break; } catch (e) {
      const refused = e && e.cause && e.cause.code === 'ECONNREFUSED';
      if (i === 14 || (method !== 'GET' && !refused)) { return { status: 0, body: null, text: `connection lost (${e.cause && e.cause.code})` }; }
      await new Promise((res) => setTimeout(res, 4000));
    }
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const RUN = Date.now().toString(36);
const TAG = `ZZTEST RJ`;
const made = { users: [], emps: [], positions: [], punches: [] };
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const TODAY = iso(new Date());
const REJOIN = addDays(TODAY, -3); // a day in the past
const LWD = addDays(TODAY, -45);

async function mkUser(tag, role, hrmsRole, extra = {}, emp = {}) {
  const u = await prisma.user.create({
    data: {
      passwordHash: `hash-${tag}-${RUN}`, name: `${TAG} ${tag} ${RUN}`, email: `zz-rj-${tag.toLowerCase()}-${RUN}@example.test`, username: `zz-rj-${tag.toLowerCase()}-${RUN}@example.test`,
      role, hrmsRole, atsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: true, atsAccess: false, accountsAccess: false, status: 'Active', atsDepartment: 'Medical', ...extra,
    },
  });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: {
      employeeCode: `ZZRJ${tag}${RUN}`.slice(0, 30), name: u.name, userId: u.id, email: u.email, designation: tag, department: 'Medical', employmentStatus: 'Active',
      dateOfJoining: new Date('2025-01-01T00:00:00.000Z'), ...emp,
    },
  });
  made.emps.push(e.id);
  return { u, e };
}
// A person who has LEFT: status Relieved, an exit record (Relieved, last working day LWD), an ended seat tenure.
async function mkLeaver(tag, { login = true, status = 'Relieved', userExtra = {} } = {}) {
  let p;
  if (login) p = await mkUser(tag, 'EMPLOYEE', 'EMPLOYEE', { status: 'Inactive', ...userExtra }, { employmentStatus: status, designation: 'Recruiter', tl: 'ZZTEST Old TL', team: 'Team-A' });
  else {
    const e = await prisma.employee.create({ data: { employeeCode: `ZZRJ${tag}${RUN}`.slice(0, 30), name: `${TAG} ${tag} ${RUN}`, email: `zz-rj-${tag.toLowerCase()}-${RUN}@example.test`, designation: 'Recruiter', department: 'Medical', employmentStatus: status, dateOfJoining: new Date('2025-01-01T00:00:00.000Z'), tl: 'ZZTEST Old TL' } });
    made.emps.push(e.id); p = { e, u: null };
  }
  const rec = await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: p.e.id, title: 'Resignation', status: 'Relieved', date: LWD, detail: 'Original exit note' } });
  await prisma.resignationDetail.create({ data: { recordId: rec.id, employeeId: p.e.id, employeeCode: p.e.employeeCode, employeeName: p.e.name, resignationDate: addDays(LWD, -30), approvedLastWorkingDate: LWD, reason: 'Other', reasonOther: 'ZZTEST RJ', submittedByName: 'ZZTEST RJ' } });
  await prisma.attendance.create({ data: { employeeId: p.e.id, date: addDays(LWD, -5), status: 'Present', checkIn: '09:00', checkOut: '18:00' } });
  p.exit = rec;
  return p;
}
const empOf = (id) => prisma.employee.findUnique({ where: { id } });
const go = (actor, p, body) => http(actor.u, 'POST', `/resignations/exit/employee/${p.e.id}/rejoin`, { date: REJOIN, department: 'Manufacturing', ...body });

async function cleanup() {
  const ids = made.emps;
  await prisma.approvalStep.deleteMany({ where: { workflow: 'resignation', recordId: { in: (await prisma.employeeRecord.findMany({ where: { employeeId: { in: ids } }, select: { id: true } })).map((r) => r.id) } } }).catch(() => null);
  await prisma.resignationDetail.deleteMany({ where: { employeeId: { in: ids } } });
  await prisma.employeeRecord.deleteMany({ where: { employeeId: { in: ids } } });
  await prisma.fnfRequest.deleteMany({ where: { employeeId: { in: ids } } });
  await prisma.attendance.deleteMany({ where: { employeeId: { in: ids } } });
  await prisma.attendancePunch.deleteMany({ where: { employeeId: { in: ids } } });
  await prisma.positionAssignment.deleteMany({ where: { OR: [{ employeeId: { in: ids } }, { positionId: { in: made.positions } }] } });
  if (made.positions.length) await prisma.position.deleteMany({ where: { id: { in: made.positions } } });
  await prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: made.users } }, { assignedById: { in: made.users } }, { name: { contains: TAG } }, { description: { contains: TAG } }, { assigneeName: { contains: TAG } }] } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...made.users] } }, { actorName: { contains: TAG } }, { userId: { in: made.users } }, { toValue: { contains: TAG } }, { reason: { contains: TAG } }, { fromValue: { contains: TAG } }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { userId: { in: made.users } }, { message: { contains: TAG } }] } });
  await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
}

(async () => {
  if (/4010/.test(API)) throw new Error('refusing 4010');
  const former = await prisma.appSetting.findUnique({ where: { key: 'former-access' } });
  const leaveBalBefore = await prisma.leaveBalance.count();
  try {
    const hr = await mkUser('HR', 'HR', 'HR', {}, { designation: 'HR' });
    const ihr = await mkUser('IHR', 'TL', 'CUSTOM_INTERNAL_HR', {}, { designation: 'TL' });
    const adm = await mkUser('ADM', 'ADMIN', 'ADMIN', {}, { designation: 'Admin' });
    const sa1 = await mkUser('SA1', 'SUPER_ADMIN', 'SUPER_ADMIN', {}, { designation: 'Super Admin' });
    const sa2 = await mkUser('SA2', 'SUPER_ADMIN', 'SUPER_ADMIN', {}, { designation: 'Super Admin' });
    const tl = await mkUser('TL', 'TL', 'TL', {}, { designation: 'TL', department: 'Manufacturing' });
    const bde = await mkUser('BDE', 'BDE', 'EMPLOYEE', {}, { designation: 'BDE' });
    const rec = await mkUser('REC', 'RECRUITER', 'EMPLOYEE', {}, { designation: 'Recruiter' });
    const staff = await mkUser('STAFF', 'EMPLOYEE', 'EMPLOYEE', {}, { designation: 'Employee', department: 'Manufacturing' });
    // the team lead to pick is a REAL working lead of the sandbox copy (the lead pickers never offer ZZTEST rows)
    const realTl = (await require('../src/utils/reportingLine').candidatesFor({ department: 'Manufacturing', level: 'STAFF', cross: true })).options.find((o) => o.role === 'TL');
    if (!realTl) throw new Error('no working Manufacturing TL in the sandbox copy');
    const act = await prisma.employee.create({ data: { employeeCode: `ZZRJACT${RUN}`.slice(0, 30), name: `${TAG} ACTIVE ${RUN}`, designation: 'Employee', department: 'Medical', employmentStatus: 'Active' } });
    made.emps.push(act.id);

    // seats: a vacant one, one held by a LEAVER (released on rejoin), one held by a live person, one of another department
    const mk = async (code, dept) => { const p = await prisma.position.create({ data: { code, department: dept, name: `${TAG} seat`, active: true, kind: 'RECRUITER' } }); made.positions.push(p.id); return p; };
    const seatVac = await mk(`MFG-ZZRJ-A${RUN}`.toUpperCase(), 'Manufacturing');
    const seatLeaver = await mk(`MFG-ZZRJ-B${RUN}`.toUpperCase(), 'Manufacturing');
    const seatHeld = await mk(`MFG-ZZRJ-C${RUN}`.toUpperCase(), 'Manufacturing');
    const seatMed = await mk(`MED-ZZRJ-D${RUN}`.toUpperCase(), 'Medical');
    const seatSeat3 = await mk(`MFG-ZZRJ-E${RUN}`.toUpperCase(), 'Manufacturing');
    const gone = await mkLeaver('GONE', { login: false, status: 'Exited' });
    await prisma.positionAssignment.create({ data: { positionId: seatLeaver.id, employeeId: gone.e.id, fromDate: '2025-02-01' } });
    await prisma.positionAssignment.create({ data: { positionId: seatHeld.id, employeeId: staff.e.id, fromDate: '2025-02-01' } });

    console.log('\nA. Options for the dialog');
    const X1 = await mkLeaver('X1');
    // an ended seat tenure of the earlier stint
    const oldSeat = await mk(`MED-ZZRJ-OLD${RUN}`.toUpperCase(), 'Medical');
    await prisma.positionAssignment.create({ data: { positionId: oldSeat.id, employeeId: X1.e.id, fromDate: '2025-01-01', toDate: LWD, note: 'Exited - now Relieved. Seat freed' } });
    // the "switch off former access" entry for X1's login (a later rejoin must clear it)
    await prisma.appSetting.upsert({ where: { key: 'former-access' }, update: { value: JSON.stringify({ limitMonths: 0, off: [{ userId: X1.u.id, at: LWD, byName: TAG }, ...(((former && JSON.parse(former.value).off) || []))] }) }, create: { key: 'former-access', value: JSON.stringify({ limitMonths: 0, off: [{ userId: X1.u.id, at: LWD, byName: TAG }] }) } });
    const o1 = await http(hr.u, 'GET', `/resignations/exit/employee/${X1.e.id}/rejoin/options?department=Manufacturing`);
    ok(o1.status === 200 && o1.body.allowed === true && o1.body.departments.includes('Manufacturing') && o1.body.minDate === LWD && Array.isArray(o1.body.designations), 'HR gets the options (departments, designations, min date = last working day)', o1.text.slice(0, 200));
    const seatCodes = (o1.body.seats || []);
    const sv = seatCodes.find((s) => s.code === seatVac.code); const sl = seatCodes.find((s) => s.code === seatLeaver.code); const sh = seatCodes.find((s) => s.code === seatHeld.code);
    ok(sv && sv.vacant && sl && sl.vacant && sl.formerHolder && sh && !sh.vacant, 'seat list: vacant, vacant-with-former-holder, and held are told apart', JSON.stringify(seatCodes.filter((s) => /ZZRJ/.test(s.code))));
    ok(!seatCodes.some((s) => s.code === seatMed.code), 'only seats of the chosen department are listed');
    ok((await http(tl.u, 'GET', `/resignations/exit/employee/${X1.e.id}/rejoin/options`)).status === 403, 'plain TL cannot open the options');
    const rp = await http(hr.u, 'GET', '/resignations/exit/relieve-now/options');
    ok(rp.body && rp.body.isDesk === true, 'the existing options call now says isDesk (the button shows for HR)');
    ok((await http(tl.u, 'GET', '/resignations/exit/relieve-now/options')).body.isDesk === false, 'isDesk false for a TL (no Rejoin button)');

    console.log('\nB. Role gates');
    for (const [name, who] of [['TL', tl], ['BDE', bde], ['Recruiter', rec], ['staff', staff]]) {
      const r = await go(who, X1, {});
      ok(r.status === 403, `${name} gets 403`, `${r.status} ${r.text.slice(0, 100)}`);
    }
    ok((await empOf(X1.e.id)).employmentStatus === 'Relieved', 'nothing changed after the refused attempts');

    console.log('\nC. Refusals in plain words');
    const x = async (body, actor = hr) => go(actor, X1, body);
    let r = await go(hr, { e: act }, {});
    ok(r.status === 409 && r.body.code === 'NOT_LEFT' && /not relieved or exited/.test(r.body.error), 'an Active person: not relieved/exited', r.text);
    r = await x({ date: addDays(LWD, -1) });
    ok(r.status === 400 && r.body.code === 'DATE_BEFORE_EXIT' && /before the last working day/.test(r.body.error), 'date before the last working day refused', r.text);
    r = await x({ date: addDays(TODAY, 31) });
    ok(r.status === 400 && r.body.code === 'DATE_FUTURE', 'date more than 30 days ahead refused', r.text);
    r = await x({ date: '2026-02-30' });
    ok(r.status === 400, 'an impossible date refused', r.text);
    r = await x({ date: '' });
    ok(r.status === 400 && /Pick the date/.test(r.body.error), 'no date refused', r.text);
    r = await x({ department: 'Atlantis' });
    ok(r.status === 400 && r.body.code === 'DEPARTMENT', 'unknown department refused', r.text);
    r = await x({ seat: seatMed.code });
    ok(r.status === 409 && r.body.code === 'SEAT_DEPARTMENT' && /belongs to Medical, not Manufacturing/.test(r.body.error), 'seat of another department refused (department mismatch)', r.text);
    r = await x({ seat: seatHeld.code });
    ok(r.status === 409 && r.body.code === 'SEAT_HELD', 'seat held by a live person refused', r.text);
    r = await x({ seat: 'MFG-NOPE-999' });
    ok(r.status === 404 && r.body.code === 'SEAT_NONE', 'unknown seat refused', r.text);
    r = await x({ tlId: staff.e.id });
    ok(r.status === 409 && r.body.code === 'TL', 'a person who is not a team lead cannot be the TL', r.text);
    // The typed type is accepted, so this call REALLY rejoins: it is made on its own leaver, so X1 stays Relieved for the checks below.
    const astro = await mkLeaver('AST', { userExtra: {}, login: true });
    r = await go(hr, astro, { employeeType: 'Astronaut' });
    // 2026-10-15 (founder): a typed own employee type is accepted (same rule as Add/Edit employee), no longer refused.
    ok(!(r.status === 400 && r.body && r.body.code === 'EMP_TYPE'), 'a typed own employee type is not refused as EMP_TYPE', r.text);
    // self + top account through the library (a relieved person cannot call the API: their own login is limited)
    const selfRes = await R.prepare({ employee: X1.e, actor: { id: X1.u.id, employeeId: X1.e.id, role: 'HR', hrmsRole: 'HR', name: 'x' }, input: { date: REJOIN } });
    ok(selfRes.refusal && selfRes.refusal.code === 'SELF', 'nobody can rejoin their own record');
    const topLeaver = await mkLeaver('TOP', { userExtra: {}, login: true });
    await prisma.user.update({ where: { id: topLeaver.u.id }, data: { role: 'ADMIN', hrmsRole: 'ADMIN' } });
    r = await go(hr, topLeaver, {});
    ok(r.status === 403 && r.body.code === 'TOP_ACCOUNT', 'an Admin login: HR refused', r.text);
    r = await go(sa1, topLeaver, {});
    ok(r.status === 201, 'an Admin login: the Super Admin may', `${r.status} ${r.text.slice(0, 150)}`);
    ok((await empOf(X1.e.id)).employmentStatus === 'Relieved', 'refusals left the person Relieved');

    console.log('\nD. The rejoin (HR) - everything it writes');
    const before = {
      emp: await empOf(X1.e.id), user: await prisma.user.findUnique({ where: { id: X1.u.id } }),
      leaveReq: await prisma.leaveRequest.count({ where: { employeeId: X1.e.id } }), att: await prisma.attendance.count({ where: { employeeId: X1.e.id } }),
      payslips: await prisma.payslip.count({ where: { employeeId: X1.e.id } }),
    };
    const bellBefore1 = await prisma.notification.count({ where: { userId: sa1.u.id, channel: 'In-App', title: { contains: 'rejoined' } } });
    const d1 = await go(hr, X1, { designation: 'Senior Recruiter', seat: seatLeaver.code, tlId: realTl.id, employeeType: 'Contract', location: 'Pune', remarks: `${TAG} came back` });
    ok(d1.status === 201 && d1.body.ok && d1.body.seat === seatLeaver.code, 'HR rejoins: 201', `${d1.status} ${d1.text.slice(0, 250)}`);
    const e1 = await empOf(X1.e.id);
    ok(e1.employmentStatus === 'Active' && e1.offboardingStatus === null, 'status Active, offboarding cleared');
    ok(e1.id === before.emp.id && e1.employeeCode === before.emp.employeeCode, 'SAME employee id and code (no duplicate)');
    ok((await prisma.employee.count({ where: { name: before.emp.name } })) === 1, 'still exactly one employee with this name');
    ok(e1.department === 'Manufacturing' && e1.designation === 'Senior Recruiter' && e1.tl === realTl.name && e1.reportingManagerId === realTl.id && e1.employeeType === 'Contract' && e1.location === 'Pune' && e1.branch === 'Pune', 'new department, designation, TL, type, location');
    ok(e1.stl === null && e1.team === null, 'old team cleared on a department change; no STL invented');
    ok(String(e1.dateOfJoining) === String(before.emp.dateOfJoining), 'dateOfJoining kept = FIRST joined (not overwritten)');
    const rj = await prisma.employeeRecord.findMany({ where: { employeeId: X1.e.id, type: 'REJOINING' } });
    const man = rj[0] && JSON.parse(rj[0].notes);
    ok(rj.length === 1 && rj[0].status === 'Done' && rj[0].date === REJOIN && /Rejoined on/.test(rj[0].title) && rj[0].toName === 'Manufacturing' && rj[0].fromName === 'Medical', 'REJOINING record: Done, dated, old and new department');
    ok(man && man.gap && man.gap.from === addDays(LWD, 1) && man.gap.to === addDays(REJOIN, -1), 'the gap = day after last working day .. day before rejoining', JSON.stringify(man && man.gap));
    const exit = await prisma.employeeRecord.findUnique({ where: { id: X1.exit.id } });
    ok(exit.status === 'Relieved' && exit.date === LWD && /Original exit note/.test(exit.detail) && /Rejoined on/.test(exit.detail), 'old exit record KEPT (still Relieved) and marked "Rejoined on"');
    ok((await prisma.resignationDetail.count({ where: { recordId: X1.exit.id } })) === 1, 'exit form row kept');
    const seats = await prisma.positionAssignment.findMany({ where: { employeeId: X1.e.id }, orderBy: { fromDate: 'asc' } });
    const mine = seats.find((s) => s.positionId === seatLeaver.id);
    ok(seats.length === 2 && mine && mine.toDate === null && mine.fromDate === REJOIN, 'new seat tenure from the rejoining date; the old tenure stays in history', JSON.stringify(seats));
    ok(seats.some((s) => s.positionId === oldSeat.id && s.toDate === LWD), 'earlier tenure untouched');
    const goneSeat = await prisma.positionAssignment.findFirst({ where: { employeeId: gone.e.id, positionId: seatLeaver.id } });
    ok(goneSeat && goneSeat.toDate && goneSeat.toDate < REJOIN === true && /released for a rejoining/i.test(goneSeat.note || ''), "the former holder's tenure was closed (not deleted)", JSON.stringify(goneSeat));
    const u1 = await prisma.user.findUnique({ where: { id: X1.u.id } });
    ok(u1.status === 'Active' && u1.lockedUntil === null && u1.atsDepartment === 'Manufacturing' && u1.branch === 'Pune', 'login reactivated; department / branch follow');
    ok(u1.passwordHash === before.user.passwordHash && u1.setPasswordTokenHash === before.user.setPasswordTokenHash, 'the password was NOT touched and none was made');
    const fa = await prisma.appSetting.findUnique({ where: { key: 'former-access' } });
    ok(!(JSON.parse(fa.value).off || []).some((x) => x.userId === X1.u.id), 'the "switch off former access" entry was removed');
    const au = await prisma.auditLog.findMany({ where: { entityId: X1.e.id, createdAt: { gte: new Date(Date.now() - 120000) } } });
    ok(au.some((a) => /^Employee rejoined/.test(a.action) && a.fromValue === 'Relieved' && a.toValue === 'Active') && au.some((a) => a.action === 'Department changed (rejoin)' && a.toValue === 'Manufacturing') && au.some((a) => a.action === 'Position changed (rejoin)' && a.toValue.startsWith(seatLeaver.code)), 'audit: rejoin + department change + seat change', au.map((a) => a.action).join(' | '));
    ok(au.every((a) => a.actorName === hr.u.name || !/rejoin/i.test(a.action)), 'audit rows name the person who did it');
    const bell1 = await prisma.notification.count({ where: { userId: sa1.u.id, channel: 'In-App', title: { contains: 'rejoined' } } });
    const bell2 = await prisma.notification.count({ where: { userId: sa2.u.id, channel: 'In-App', title: { contains: 'rejoined' } } });
    ok(bell1 === bellBefore1 + 1 && bell2 >= 1, 'every Super Admin gets the bell');
    const bellText = await prisma.notification.findFirst({ where: { userId: sa1.u.id, channel: 'In-App', title: { contains: 'rejoined' } }, orderBy: { createdAt: 'desc' } });
    ok(bellText && /rejoined on .*Manufacturing, by /.test(bellText.message) && bellText.message.includes(hr.u.name), 'bell text: who, when, department, by whom', bellText && bellText.message);
    ok((await prisma.task.count({ where: { assigneeId: sa1.u.id, name: { contains: `${X1.e.name} rejoined` } } })) === 1, 'Super Admin gets an information task');
    ok((await prisma.notification.count({ where: { userId: hr.u.id, title: { contains: 'rejoined' } } })) === 0, 'the person who did it is not told');
    ok((await prisma.notification.count({ where: { channel: 'Email', title: { contains: 'rejoined' } } })) === 0, 'no e-mail is sent');
    ok((await prisma.leaveRequest.count({ where: { employeeId: X1.e.id } })) === before.leaveReq && (await prisma.attendance.count({ where: { employeeId: X1.e.id } })) === before.att && (await prisma.payslip.count({ where: { employeeId: X1.e.id } })) === before.payslips, 'past leave, attendance and payslips untouched');
    ok((await prisma.leaveBalance.count()) === leaveBalBefore, 'leave balances: no row added or removed');
    const info = await http(hr.u, 'GET', `/resignations/exit/employee/${X1.e.id}/rejoin/info`);
    ok(info.status === 200 && info.body.rejoined && info.body.rejoinedOn === REJOIN && info.body.firstJoined === '2025-01-01' && /First joined 1 Jan 2025 · Rejoined/.test(info.body.text), '"First joined / Rejoined" for the screens', info.text.slice(0, 200));
    ok(info.body.canUndo === false, 'HR is not offered Undo (Admin only)');

    console.log('\nE. The day engine counts the person from the rejoining date');
    // a punch on the rejoining day and a weekday inside the gap
    const gapDay = (() => { let d = addDays(REJOIN, -4); while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, -1); return d; })();
    const rejoinDay = (() => { let d = REJOIN; while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1); return d; })();
    if (rejoinDay <= TODAY) {
      const pn = await prisma.attendancePunch.create({ data: { employeeId: X1.e.id, date: rejoinDay, time: '09:05', direction: 'In', method: 'Biometric', source: 'ZZTEST RJ' } }).catch((e) => { console.log('  (punch create:', e.message.slice(0, 120), ')'); return null; });
      if (pn) made.punches.push(pn.id);
    }
    const dash = async (date) => http(hr.u, 'GET', `/attendance/dashboard?date=${date}`);
    const dGap = await dash(gapDay);
    const inGap = dGap.body && (dGap.body.marking || []).find((m) => m.employeeId === X1.e.id);
    ok(dGap.status === 200 && !inGap, `a day in the gap (${gapDay}): NOT in the day's list (not counted absent)`, JSON.stringify(inGap));
    const dRj = await dash(rejoinDay);
    const inRj = dRj.body && (dRj.body.marking || []).find((m) => m.employeeId === X1.e.id);
    ok(inRj && inRj.hrStatus !== 'Relieved' && inRj.hrStatus !== 'Exited', `the rejoining day (${rejoinDay}): counted in the headcount, status ${inRj && inRj.hrStatus} (no Relieved flag)`, JSON.stringify(inRj));
    ok(inRj && ['Present', 'Late', 'Missing Check-Out', 'Checked In'].includes(inRj.dayStatus) && inRj.bucket === 'present', `...and shown ${inRj && inRj.dayStatus} with the punch`);
    const dNext = await dash(TODAY);
    const inNext = dNext.body && (dNext.body.marking || []).find((m) => m.employeeId === X1.e.id);
    ok(inNext || [0, 6].includes(new Date(`${TODAY}T00:00:00Z`).getUTCDay()), 'today: on the rolls');
    const gapKpi = await http(hr.u, 'GET', `/attendance/kpi-report?from=${addDays(LWD, 2)}&to=${addDays(LWD, 6)}&employeeId=${X1.e.id}`);
    const gapRows = (gapKpi.body && (gapKpi.body.rows || gapKpi.body.list || [])) || [];
    ok(gapKpi.status === 200 && !gapRows.some((x) => (x.kpi === 'absent' || x.tile === 'absent') && (x.employeeId === X1.e.id || x.employeeCode === X1.e.employeeCode)), 'attendance report: the gap weeks show NO absent days for the person', gapKpi.text.slice(0, 160));

    console.log('\nF. Idempotency, double submit, rollback');
    r = await go(hr, X1, {});
    ok(r.status === 409 && r.body.code === 'NOT_LEFT', 'a second submit is refused (already Active)', r.text);
    ok((await prisma.employeeRecord.count({ where: { employeeId: X1.e.id, type: 'REJOINING' } })) === 1 && (await prisma.positionAssignment.count({ where: { employeeId: X1.e.id, toDate: null } })) === 1, 'still ONE rejoin record and ONE open seat');
    const X2 = await mkLeaver('X2', { login: false });
    const [p1, p2] = await Promise.all([go(hr, X2, {}), go(ihr, X2, {})]);
    ok([p1.status, p2.status].filter((s) => s === 201).length === 1 && [p1.status, p2.status].filter((s) => s === 409).length === 1, 'two submits at the same moment: exactly one wins', `${p1.status} ${p2.status}`);
    ok((await prisma.employeeRecord.count({ where: { employeeId: X2.e.id, type: 'REJOINING' } })) === 1, 'one rejoin record after the race');
    const X3 = await mkLeaver('X3');
    const beforeX3 = await empOf(X3.e.id);
    const rb = await go(hr, X3, { seat: seatSeat3.code, designation: 'Rolled Back', __testFail: true });
    ok(rb.status >= 400, 'forced failure returns an error', `${rb.status}`);
    const afterX3 = await empOf(X3.e.id);
    ok(afterX3.employmentStatus === 'Relieved' && afterX3.department === 'Medical' && afterX3.designation === 'Recruiter', 'rollback: employee untouched');
    ok((await prisma.employeeRecord.count({ where: { employeeId: X3.e.id, type: 'REJOINING' } })) === 0 && (await prisma.positionAssignment.count({ where: { employeeId: X3.e.id } })) === 0, 'rollback: no rejoin record, no seat');
    ok((await prisma.employeeRecord.findUnique({ where: { id: X3.exit.id } })).detail === 'Original exit note', 'rollback: exit record text unchanged');
    ok((await prisma.user.findUnique({ where: { id: X3.u.id } })).status === 'Inactive', 'rollback: login unchanged');
    ok((await prisma.auditLog.count({ where: { entityId: X3.e.id, action: { contains: 'rejoin' } } })) === 0, 'rollback: no audit rows');
    ok(beforeX3.updatedAt.getTime() === afterX3.updatedAt.getTime(), 'rollback: the employee row was not even touched');
    const ok3 = await go(hr, X3, { seat: seatSeat3.code });
    ok(ok3.status === 201, 'after the failed try the same rejoin works', `${ok3.status} ${ok3.text.slice(0, 120)}`);

    console.log('\nG. A person without a login; Internal HR; Admin; Super Admin; Admin-only undo');
    const e2 = await empOf(X2.e.id);
    const winner = p1.status === 201 ? p1 : p2;
    ok(e2.employmentStatus === 'Active' && winner.body.needsLogin === true && (winner.body.warnings || []).some((w) => /needs login/.test(w)), 'no login: rejoined, told "needs login"; no login was created', JSON.stringify(winner.body && winner.body.warnings));
    ok(!e2.userId, 'no User row was made');
    ok((winner.body.warnings || []).some((w) => /seat to be assigned/.test(w)), 'no seat chosen: "seat to be assigned" (nothing guessed)');
    const X4 = await mkLeaver('X4');
    const g1 = await go(ihr, X4, { department: 'Medical' });
    ok(g1.status === 201 && (await empOf(X4.e.id)).department === 'Medical', 'Internal HR can rejoin (same department kept)', `${g1.status} ${g1.text.slice(0, 150)}`);
    ok((await empOf(X4.e.id)).tl === 'ZZTEST Old TL', 'same department: the old TL is kept');
    ok((await prisma.auditLog.count({ where: { entityId: X4.e.id, action: 'Department changed (rejoin)' } })) === 0, 'no department-change audit when the department is the same');
    const X5 = await mkLeaver('X5');
    ok((await go(adm, X5, {})).status === 201, 'Admin can rejoin');
    const X6 = await mkLeaver('X6');
    ok((await go(sa2, X6, {})).status === 201, 'Super Admin can rejoin');
    // undo
    const un1 = await http(hr.u, 'POST', `/resignations/exit/employee/${X5.e.id}/rejoin/undo`);
    ok(un1.status === 403, 'HR cannot undo (Admin only)', un1.text);
    await prisma.attendancePunch.create({ data: { employeeId: X5.e.id, date: REJOIN, time: '09:00', direction: 'In', method: 'Biometric', source: 'ZZTEST RJ' } }).then((p) => made.punches.push(p.id)).catch(() => null);
    const un2 = await http(adm.u, 'POST', `/resignations/exit/employee/${X5.e.id}/rejoin/undo`);
    ok(un2.status === 409 && un2.body.code === 'ACTIVITY', 'undo refused when something was recorded since rejoining', un2.text);
    await prisma.attendancePunch.deleteMany({ where: { employeeId: X5.e.id } });
    const un3 = await http(adm.u, 'POST', `/resignations/exit/employee/${X5.e.id}/rejoin/undo`);
    const e5 = await empOf(X5.e.id);
    ok(un3.status === 200 && e5.employmentStatus === 'Relieved' && e5.department === 'Medical' && e5.designation === 'Recruiter', 'Admin undo: status, department, designation back', `${un3.status} ${un3.text.slice(0, 120)}`);
    ok((await prisma.employeeRecord.findFirst({ where: { employeeId: X5.e.id, type: 'REJOINING' } })).status === 'Undone', 'the rejoin record is marked Undone (kept)');
    ok((await prisma.user.findUnique({ where: { id: X5.u.id } })).status === 'Inactive', 'undo: the login is back to Inactive');
    // after an undo the person can rejoin again
    ok((await go(adm, X5, {})).status === 201, 'after an undo the person can rejoin again');
    // after a rejoin a NEW exit is its own record (the old relieved one is history)
    const exFlow = require('../src/utils/exitFlow');
    const eNow = await empOf(X6.e.id);
    const ens = await exFlow.ensureExitRecord(eNow, { id: adm.u.id, name: adm.u.name }, { status: 'Notice Period' });
    ok(ens.record.id !== X6.exit.id && ens.record.status === 'Notice Period', 'a new exit after rejoining makes a NEW exit record (the old relieved one stays history)');
    // the exit guard still holds for a rejoined person
    ok((await http(tl.u, 'POST', `/resignations/exit/employee/${X6.e.id}/relieve-now`, { reason: 'x', lastWorkingDate: TODAY })).status === 403, 'a TL still cannot relieve');
  } catch (e) {
    fail += 1; console.error('TEST CRASHED:', e && e.stack ? e.stack : e);
  } finally {
    // put the shared setting back exactly as it was, then remove every row this test made
    if (former) await prisma.appSetting.update({ where: { key: 'former-access' }, data: { value: former.value } }).catch(() => null); else await prisma.appSetting.deleteMany({ where: { key: 'former-access' } }).catch(() => null);
    await cleanup();
    const left = (await prisma.employee.count({ where: { name: { contains: TAG } } })) + (await prisma.user.count({ where: { name: { contains: TAG } } })) + (await prisma.position.count({ where: { name: { contains: TAG } } }))
      + (await prisma.auditLog.count({ where: { OR: [{ actorName: { contains: TAG } }, { toValue: { contains: TAG } }] } })) + (await prisma.notification.count({ where: { title: { contains: TAG } } })) + (await prisma.task.count({ where: { name: { contains: TAG } } }));
    console.log(`\ncleanup: ${left === 0 ? 'every ZZTEST RJ row removed' : `${left} ZZTEST RJ rows LEFT`}`);
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
