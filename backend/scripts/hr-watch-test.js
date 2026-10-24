#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HR WATCH + INTERNAL HR PARITY TEST (founder, 2026-10-16) - COPY DATABASE ONLY.
//
//   cd backend
//   COPY_DB=C:/tmp/hrwatch-copy.db node scripts/hr-watch-test.js
//
// COPY_DB = a VACUUM INTO copy of the real database (never prisma/dev.db). The script makes its OWN working copy next to it
// (<name>-work.db), runs the set-internal-hr-v2.js dry run / apply / undo on it, starts its OWN throw-away API (port 4095,
// TEST_MODE=1) and checks:
//   S  the apply script: dry run, apply, undo restores the copy exactly, apply again (idempotent: second dry run says nothing to do)
//   P  parity: Purna (TL, escalated by Internal HR) and Divya (HR, escalated) see the same HRMS data (lists + details + me)
//   W  watch: Divya's actions -> ONE notification to Purna (text / link / count), SA alerts kept, nobody else told
//   N  noise / safety: coalescing, window expiry, no self-notify, default TL, not-on-list = nothing, failure never breaks the action, no recursion
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-work.db');
fs.copyFileSync(path.resolve(copy), WORK);
const DB_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
const BACKUP_DIR = path.resolve(copy, '..', 'hrwatch-backups');
const PORT = Number(process.env.TEST_PORT || 4095);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
process.env.HR_WATCH_WINDOW_MS = '1500'; // the in-process window test; the server below gets the real 2 minutes
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);

async function http(method, p, token, body, raw) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = raw ? '' : buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, bytes: buf.length };
}

const TABLES = ['AppSetting', 'Employee', 'User', 'Department', 'Position', 'PositionAssignment', 'Role', 'RoleAccess'];
async function fingerprint() {
  const out = {};
  for (const t of TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY 1`);
    out[t] = crypto.createHash('sha1').update(JSON.stringify(rows, (k, v) => (k === 'updatedAt' ? undefined : typeof v === 'bigint' ? String(v) : v))).digest('hex') + `:${rows.length}`;
  }
  return out;
}
function runScript(args) {
  const r = spawnSync(process.execPath, ['scripts/set-internal-hr-v2.js', '--db', WORK, ...args], { cwd: BACK, env: { ...process.env, BACKUP_DIR }, encoding: 'utf8', timeout: 600000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const shape = (b, depth = 0) => {
  if (Array.isArray(b)) return b.length;
  if (b && typeof b === 'object' && depth < 2) {
    const o = {};
    Object.keys(b).sort().forEach((k) => {
      const v = b[k];
      if (Array.isArray(v)) o[k] = v.length;
      else if (typeof v === 'number') o[k] = v;
      else if (v && typeof v === 'object') o[k] = shape(v, depth + 1);
    });
    return o;
  }
  return typeof b;
};

(async () => {
  let server;
  const made = { users: [], emps: [], anns: [], leaves: [] };
  try {
    // ================================================================ S: the apply script on the copy
    const before = await fingerprint();
    const auditBefore = await prisma.auditLog.count();
    let r = runScript([]);
    check('S1 dry run on the copy runs and ends with "DRY RUN - nothing was written"', r.code === 0 && /DRY RUN - nothing was written/.test(r.out), r.out.slice(-600));
    check('S2 dry run prints the watch line "WOULD ADD: every action by Divya"', /WOULD ADD: every action by Divya \(TL517\) will notify/.test(r.out), r.out.slice(-600));
    check('S3 dry run wrote nothing', JSON.stringify(await fingerprint()) === JSON.stringify(before));
    r = runScript(['--apply']);
    const manifest = (r.out.match(/Undo manifest: (.+)/) || [])[1];
    check('S4 apply on the copy works and makes an undo manifest', r.code === 0 && !!manifest && fs.existsSync(manifest.trim()), r.out.slice(-800));
    const watchRow = await prisma.appSetting.findUnique({ where: { key: 'hr-watch' } });
    const watchVal = watchRow ? JSON.parse(watchRow.value) : null;
    check('S5 the hr-watch setting holds Divya -> Purna', Array.isArray(watchVal) && watchVal.length === 1 && watchVal[0].actorEmployeeCode === 'TL517' && watchVal[0].notifyEmployeeCodes.join() === 'TL309' && watchVal[0].includeSuperAdmins === false, watchRow);
    const afterApply = await fingerprint();
    r = runScript([]);
    check('S6 second dry run: nothing left to change (idempotent)', /nothing: already set/.test(r.out), r.out.slice(-500));
    r = runScript(['--undo', manifest.trim()]);
    check('S7 undo works', r.code === 0 && /Undone/.test(r.out), r.out.slice(-500));
    const afterUndo = await fingerprint();
    check('S8 undo restores the copy exactly (settings, employees, logins, departments, seats, roles)', JSON.stringify(afterUndo) === JSON.stringify(before), { before, afterUndo });
    check('S9 undo removed the hr-watch setting again', !(await prisma.appSetting.findUnique({ where: { key: 'hr-watch' } })));
    check('S10 the apply and the undo each left one audit row', (await prisma.auditLog.count()) === auditBefore + 2, await prisma.auditLog.count());
    r = runScript(['--apply']);
    check('S11 apply again (the working state for the tests below)', r.code === 0, r.out.slice(-400));

    // ================================================================ people
    const emp = async (code) => prisma.employee.findFirst({ where: { employeeCode: code }, include: { user: true } });
    const divyaE = await emp('TL517'); const purnaE = await emp('TL309');
    check('0 Divya and Purna exist with logins in the copy', !!(divyaE && divyaE.user && purnaE && purnaE.user));
    const divya = divyaE.user; const purna = purnaE.user;
    check('0b stored roles untouched: Divya HR, Purna TL; both on the Internal HR list', divya.hrmsRole === 'HR' && purna.role === 'TL' && purna.hrmsRole === 'TL');
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', NOT: { email: { contains: 'example.test' } } } });
    check('0c a real Super Admin exists in the copy', !!sa);

    // ZZTEST people used for the noise checks (set before the server starts, so its caches are fresh)
    const base = { passwordHash: 'x', hrmsAccess: true, atsAccess: false, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const mk = async (tag, extra, empExtra = {}) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST HW ${tag} ${RUN}`, email: `zz-hw-${tag}-${RUN}@example.test`, username: `zz-hw-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', ...extra } });
      made.users.push(u.id);
      const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-HW-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'ZZ Dept', ...empExtra } });
      made.emps.push(e.id);
      return { u, e };
    };
    const staff1 = await mk('s1', {}); const staff2 = await mk('s2', {}); const staff3 = await mk('s3', {});
    const selfA = await mk('self', { role: 'HR', hrmsRole: 'HR' });
    const mgr = await mk('mgr', { role: 'TL', hrmsRole: 'TL' });
    const defA = await mk('def', { role: 'HR', hrmsRole: 'HR' }, { reportingManagerId: mgr.e.id });
    const stranger = await mk('stranger', { role: 'HR', hrmsRole: 'HR' });
    const entries = [
      { actorEmployeeCode: 'TL517', notifyEmployeeCodes: ['TL309'], includeSuperAdmins: false },
      { actorEmployeeCode: selfA.e.employeeCode, notifyEmployeeCodes: [selfA.e.employeeCode], includeSuperAdmins: false },
      { actorEmployeeCode: defA.e.employeeCode, notifyEmployeeCodes: [], includeSuperAdmins: false },
    ];
    await prisma.appSetting.update({ where: { key: 'hr-watch' }, data: { value: JSON.stringify(entries) } });

    // ================================================================ in-process: the hook itself (window 1.5 s)
    const audit = require(path.join(BACK, 'src/utils/audit'));
    const hrWatch = require(path.join(BACK, 'src/utils/hrWatch'));
    hrWatch.resetForTests();
    const notesFor = (uid, since) => prisma.notification.findMany({ where: { userId: uid, channel: 'In-App', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } });
    let t0 = new Date(Date.now() - 1000);
    await audit.logAudit({ userId: divya.id, action: 'ZZ first action', entity: 'Employee', entityId: staff1.e.id, toValue: 'Done' });
    await sleep(900);
    let n = await notesFor(purna.id, t0);
    check('N1 one audit row by Divya -> exactly one bell notification for Purna', n.length === 1 && /^Divya \(HR\): ZZ first action - Employee of ZZTEST HW s1/.test(n[0].message), n.map((x) => x.message));
    check('N2 the text names who and what, and has an Open link to the record', n[0] && n[0].message.includes(`\nOpen: /employees/${staff1.e.id}`), n[0] && n[0].message);
    await audit.logAudit({ userId: divya.id, action: 'ZZ first action', entity: 'Employee', entityId: staff2.e.id, toValue: 'Done' });
    await audit.logAudit({ userId: divya.id, action: 'ZZ first action', entity: 'Employee', entityId: staff3.e.id, toValue: 'Done' });
    await sleep(900);
    n = await notesFor(purna.id, t0);
    check('N3 repeating the same action within the window UPDATES the one notification (count 3, unread again), no new row', n.length === 1 && /3 times/.test(n[0].message) && n[0].read === false, n.map((x) => x.message));
    await sleep(1700);
    await audit.logAudit({ userId: divya.id, action: 'ZZ first action', entity: 'Employee', entityId: staff1.e.id, toValue: 'Done' });
    await sleep(900);
    n = await notesFor(purna.id, t0);
    check('N4 after the window the same action starts a NEW notification', n.length === 2, n.length);
    check('N5 a different action = a different notification', await (async () => {
      await audit.logAudit({ userId: divya.id, action: 'ZZ other action', entity: 'LeaveRequest', entityId: 'none' });
      await sleep(900);
      return (await notesFor(purna.id, t0)).length === 3;
    })());
    // the salary / password value is never in the text
    await audit.logAudit({ userId: divya.id, action: 'Salary structure edited', entity: 'Employee', entityId: staff1.e.id, toValue: '{"basic": 45000, "hra": 20000}' });
    await audit.logAudit({ userId: divya.id, action: 'ZZ password check', entity: 'Employee', entityId: staff1.e.id, toValue: 'newPassword123' });
    await sleep(900);
    n = await notesFor(purna.id, t0);
    check('N6 amounts / passwords / JSON values never appear in the text', !n.some((x) => /45000|20000|newPassword123|basic/.test(`${x.title} ${x.message}`)), n.map((x) => x.message));
    // not on the list
    t0 = new Date(Date.now() - 500);
    await audit.logAudit({ userId: stranger.u.id, action: 'ZZ stranger action', entity: 'Employee', entityId: staff1.e.id, toValue: 'Done' });
    await sleep(900);
    check('N7 a person NOT on the watch list: nobody is told', (await prisma.notification.count({ where: { createdAt: { gte: t0 }, message: { contains: 'ZZ stranger action' } } })) === 0);
    // never the actor about herself
    await audit.logAudit({ userId: selfA.u.id, action: 'ZZ self action', entity: 'Employee', entityId: staff1.e.id });
    await sleep(900);
    check('N8 a person who would only notify themselves: no notification', (await prisma.notification.count({ where: { createdAt: { gte: t0 }, message: { contains: 'ZZ self action' } } })) === 0);
    await audit.logAudit({ userId: purna.id, action: 'ZZ purna own action', entity: 'Employee', entityId: staff1.e.id });
    await sleep(900);
    check('N9 Purna\'s own actions do not notify Purna (she is not the actor on the list)', (await prisma.notification.count({ where: { userId: purna.id, createdAt: { gte: t0 }, message: { contains: 'ZZ purna own action' } } })) === 0);
    // default team lead (no notify codes)
    await audit.logAudit({ userId: defA.u.id, action: 'ZZ default tl action', entity: 'Employee', entityId: staff1.e.id });
    await sleep(900);
    const dn = await notesFor(mgr.u.id, t0);
    check('N10 an entry with no notify codes tells the actor\'s team lead (reporting manager)', dn.length === 1 && /ZZ default tl action/.test(dn[0].message), dn.map((x) => x.message));
    // sign-in rows are not actions
    await audit.logAudit({ userId: divya.id, action: 'Signed in', entity: 'User', entityId: divya.id });
    await sleep(700);
    check('N11 "Signed in" is not reported', (await prisma.notification.count({ where: { userId: purna.id, createdAt: { gte: t0 }, message: { contains: 'Signed in' } } })) === 0);
    // no recursion: the notification writes raised no audit rows of their own
    const aBefore = await prisma.auditLog.count();
    await audit.logAudit({ userId: divya.id, action: 'ZZ recursion probe', entity: 'Employee', entityId: staff1.e.id });
    await sleep(1000);
    check('N12 no loop: only the one audit row exists after the notification was made', (await prisma.auditLog.count()) === aBefore + 1);
    // failure never breaks the action
    const origCreate = prisma.notification.create;
    const origErr = console.error; let errs = 0; console.error = (...a) => { if (/hrWatch/.test(String(a[0]))) errs += 1; else origErr(...a); };
    prisma.notification.create = () => { throw new Error('forced failure'); };
    hrWatch.resetForTests();
    let threw = false; try { await audit.logAudit({ userId: divya.id, action: 'ZZ failing notify', entity: 'Employee', entityId: staff1.e.id }); await audit.logAudit({ userId: divya.id, action: 'ZZ failing notify 2', entity: 'Employee', entityId: staff1.e.id }); } catch { threw = true; }
    await sleep(900);
    prisma.notification.create = origCreate; console.error = origErr;
    check('N13 a failing notification never breaks the audit write / the action', !threw && (await prisma.auditLog.count({ where: { action: { startsWith: 'ZZ failing notify' } } })) === 2);
    check('N14 the failure is logged once, not per action', errs === 1, errs);
    hrWatch.resetForTests();

    // ================================================================ the throw-away API
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT), HR_WATCH_WINDOW_MS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const TD = await tokenOf(divya); const TP = await tokenOf(purna); const TS = await tokenOf(sa); const TX = await tokenOf(stranger.u);
    const TStaff = await tokenOf(staff1.u);

    // ================================================================ P: parity
    const meD = await http('GET', '/api/auth/me', TD); const meP = await http('GET', '/api/auth/me', TP);
    const pick = (m) => { const b = (m.body && (m.body.user || m.body)) || {}; return { role: b.role, hrmsRole: b.hrmsRole, atsRole: b.atsRole, accountsRole: b.accountsRole, products: b.products, internalHr: b.internalHr || null }; };
    check('P0 both logins resolve to the same Super-Admin-level identity (role, HRMS / ATS / Accounts roles, products)', meD.status === 200 && meP.status === 200 && JSON.stringify(pick(meD)) === JSON.stringify(pick(meP)) && pick(meD).hrmsRole === 'SUPER_ADMIN', { d: pick(meD), p: pick(meP) });
    const deptsSeen = await prisma.employee.groupBy({ by: ['department'], where: { employmentStatus: 'Active' }, _count: true });
    const lists = [
      '/api/employees', '/api/employees/management', '/api/employees/management/options', '/api/employees/review-queue', '/api/employees/after-exit',
      '/api/attendance', '/api/attendance/regularizations', '/api/attendance/dashboard', '/api/attendance/punches', '/api/attendance/report',
      '/api/leave', '/api/leave/balances', '/api/leave/on-leave-today', '/api/leave/monthly', '/api/leave/types', '/api/leave/holidays',
      '/api/late-permissions', '/api/late-permissions/people', '/api/announcements', '/api/documents',
      '/api/payroll', '/api/payroll/runs', '/api/payroll/structure', '/api/payroll/reports', '/api/payroll/policy', '/api/payroll/fnf',
      '/api/hrms/dashboard', '/api/hrms/dashboard/list', '/api/insights/attendance', '/api/insights/leave', '/api/insights/employees',
      '/api/helpdesk', '/api/employee-fields', '/api/resignations',
    ];
    let compared = 0;
    for (const u of lists) {
      // eslint-disable-next-line no-await-in-loop
      const [a, b] = [await http('GET', u, TD), await http('GET', u, TP)];
      if (a.status === 404 && b.status === 404) { console.log(`skip  ${u} (no such route)`); continue; } // eslint-disable-line no-continue
      compared += 1;
      const same = a.status === b.status && JSON.stringify(shape(a.body)) === JSON.stringify(shape(b.body));
      check(`P ${u}  Divya ${a.status} = Purna ${b.status}, same counts`, same, { d: JSON.stringify(shape(a.body)).slice(0, 300), p: JSON.stringify(shape(b.body)).slice(0, 300) });
    }
    check('P-all at least 20 list screens compared', compared >= 20, compared);
    const dEmps = await http('GET', '/api/employees', TD);
    const dArr = Array.isArray(dEmps.body) ? dEmps.body : (dEmps.body && (dEmps.body.rows || dEmps.body.employees)) || [];
    check('P-all the employee directory is company-wide for both (more than one department)', new Set(dArr.map((e) => e.department)).size > 1 || deptsSeen.length <= 1, { n: dArr.length });
    // detail of people from three different departments
    const sample = []; const seenD = new Set();
    for (const e of dArr) { if (!seenD.has(e.department) && sample.length < 4 && e.id) { seenD.add(e.department); sample.push(e.id); } }
    for (const id of sample) {
      // eslint-disable-next-line no-await-in-loop
      for (const suffix of ['', '/documents']) {
        const [a, b] = [await http('GET', `/api/employees/${id}${suffix}`, TD), await http('GET', `/api/employees/${id}${suffix}`, TP)];
        check(`P detail /api/employees/${id.slice(0, 6)}...${suffix}  both ${a.status}/${b.status}, identical`, a.status === b.status && a.status === 200 && JSON.stringify(a.body) === JSON.stringify(b.body), { a: a.status, b: b.status, same: JSON.stringify(a.body) === JSON.stringify(b.body) });
      }
      // eslint-disable-next-line no-await-in-loop
      const [a, b] = [await http('GET', `/api/payroll/structure/${id}`, TD), await http('GET', `/api/payroll/structure/${id}`, TP)];
      check(`P salary structure of ${id.slice(0, 6)}...  both ${a.status}/${b.status}, identical`, a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body), { a: a.status, b: b.status });
    }
    const [ex1, ex2] = [await http('GET', '/api/employees/export.xlsx', TD, undefined, true), await http('GET', '/api/employees/export.xlsx', TP, undefined, true)];
    check('P employee export: both 200 and the same size', ex1.status === 200 && ex2.status === 200 && Math.abs(ex1.bytes - ex2.bytes) < 64, { a: [ex1.status, ex1.bytes], b: [ex2.status, ex2.bytes] });

    // ================================================================ W: the watch through the real API
    const T0 = new Date(Date.now() - 500);
    const purnaNotes = () => prisma.notification.findMany({ where: { userId: purna.id, channel: 'In-App', createdAt: { gte: T0 } }, orderBy: { createdAt: 'asc' } });
    const day = new Date().toISOString().slice(0, 10);
    // attendance for 3 people
    for (const s of [staff1, staff2, staff3]) {
      // eslint-disable-next-line no-await-in-loop
      const x = await http('POST', '/api/attendance', TD, { employeeId: s.e.id, date: day, status: 'Present' });
      check(`W1 Divya marks attendance (${s.e.employeeCode.slice(-8)}) -> ${x.status}`, x.status === 201, x.text.slice(0, 200));
    }
    await sleep(1500);
    let pn = (await purnaNotes()).filter((x) => /Attendance marked/.test(x.title));
    check('W2 three attendance marks in a row = ONE notification for Purna with the count', pn.length === 1 && /marked attendance for 3 people/.test(pn[0].message), pn.map((x) => x.message));
    check('W2b the notification went to Purna only (not the stranger / staff)', (await prisma.notification.count({ where: { createdAt: { gte: T0 }, title: { contains: 'Attendance marked' }, NOT: { userId: purna.id } } })) === 0);
    // leave request + decision
    const lv = await http('POST', '/api/leave', TStaff, { type: 'Casual', fromDate: day, toDate: day, reason: 'ZZTEST watch' });
    let leaveId = lv.body && lv.body.id;
    if (!leaveId) {
      const row = await prisma.leaveRequest.create({ data: { employeeId: staff1.e.id, type: 'Casual', fromDate: day, toDate: day, days: 1, reason: 'ZZTEST watch', status: 'Pending' } });
      leaveId = row.id;
    }
    made.leaves.push(leaveId);
    const dec = await http('PATCH', `/api/leave/${leaveId}/decision`, TD, { status: 'Approved', comment: 'ok' });
    check('W3 Divya approves a leave request', dec.status === 200, dec.text.slice(0, 300));
    await sleep(1500);
    pn = (await purnaNotes()).filter((x) => /Leave|Approval/i.test(x.title));
    check('W4 one approval = ONE notification: Divya (HR): Leave approved - Leave request of <name>, with a link', pn.length === 1 && /^Divya \(HR\): Leave approved - Leave request of ZZTEST HW s1/.test(pn[0].message) && /Open: \/leave/.test(pn[0].message), pn.map((x) => x.message));
    // announcement post, pin (no audit row: request-level), delete
    const an = await http('POST', '/api/announcements', TD, { title: `ZZTEST HW notice ${RUN}`, body: 'zz', category: 'General', target: 'All', date: day });
    check('W5 Divya posts an announcement', an.status === 201 && an.body && an.body.id, an.text.slice(0, 200));
    if (an.body && an.body.id) made.anns.push(an.body.id);
    const pin = await http('PUT', `/api/announcements/${an.body && an.body.id}/pin`, TD);
    check('W6 pin works (a write with no audit row)', pin.status === 200, pin.text.slice(0, 200));
    await sleep(1500);
    pn = await purnaNotes();
    check('W7 the announcement post notified Purna', pn.some((x) => /Announcement posted/.test(x.title)), pn.map((x) => x.title));
    check('W8 the pin (no audit row) still notified Purna once, via the request watch ("Changed ...")', pn.filter((x) => /^Divya \(HR\): Changed /.test(x.title)).length === 1, pn.map((x) => x.title));
    const del = await http('DELETE', `/api/announcements/${an.body && an.body.id}`, TD);
    check('W9 Divya deletes it', del.status === 204, del.text.slice(0, 200));
    await sleep(1500);
    pn = await purnaNotes();
    check('W10 the delete notified Purna ("Announcement deleted"), ONE line (the audit hook and the request watch do not double up)', pn.filter((x) => /Announcement deleted/.test(x.title)).length === 1 && pn.filter((x) => /Deleted Announcements/.test(x.title)).length === 0, pn.map((x) => x.title));
    const saDel = await prisma.notification.count({ where: { userId: sa.id, createdAt: { gte: T0 }, title: 'Internal HR deleted something' } });
    check('W11 the Super Admin delete alert is still sent (kept)', saDel >= 1, saDel);
    // export
    const exp = await http('GET', '/api/employees/export.xlsx', TD, undefined, true);
    await sleep(1500);
    pn = await purnaNotes();
    check('W12 an export notified Purna and kept the Super Admin alert', exp.status === 200 && pn.some((x) => /export/i.test(x.title)) && (await prisma.notification.count({ where: { userId: sa.id, createdAt: { gte: T0 }, title: 'Internal HR exported data' } })) >= 1, { s: exp.status, t: pn.map((x) => x.title) });
    // import
    const imp = await http('POST', '/api/employees/bulk-import', TD, { rows: [{ 'Employee Name': `ZZTEST HW Imported ${RUN}`, Email: `zz-hw-imp-${RUN}@example.test`, Department: 'HR', Designation: 'HR' }] });
    const impEmp = await prisma.employee.findFirst({ where: { email: `zz-hw-imp-${RUN}@example.test` } });
    if (impEmp) made.emps.push(impEmp.id);
    await sleep(1500);
    pn = await purnaNotes();
    check('W13 an import notified Purna ("Bulk import run") and kept the Super Admin alert', pn.some((x) => /Bulk import run/.test(x.title)) && (await prisma.notification.count({ where: { userId: sa.id, createdAt: { gte: T0 }, title: 'Internal HR imported data' } })) >= 1, { s: imp.status, t: pn.map((x) => x.title), b: imp.text.slice(0, 200) });
    // a failed request is not reported
    const cntBefore = (await purnaNotes()).length;
    const bad = await http('PATCH', '/api/leave/does-not-exist/decision', TD, { status: 'Approved' });
    await sleep(1000);
    check('W14 a refused / failed request tells nobody', bad.status >= 400 && (await purnaNotes()).length === cntBefore, bad.status);
    // reads are not reported, a stranger is not watched
    const cnt2 = (await purnaNotes()).length;
    await http('GET', '/api/employees', TD); await http('GET', '/api/leave', TD);
    await http('POST', '/api/attendance', TX, { employeeId: staff2.e.id, date: day, status: 'Present' });
    await sleep(1200);
    check('W15 reads, and a not-watched HR login, tell Purna nothing', (await purnaNotes()).length === cnt2);
    // Purna sees them in the Notifications screen API; unread counter
    const mine = await http('GET', '/api/admin/notifications?page=1', TP);
    check('W16 the bell / Notifications list of Purna shows the lines', mine.status === 200 && JSON.stringify(mine.body).includes('Divya (HR)'), mine.text.slice(0, 200));
    check('W17 Divya does not see Purna\'s notifications of her actions', !JSON.stringify((await http('GET', '/api/admin/notifications?page=1', TD)).body).includes('marked attendance for 3 people'));
  } catch (e) {
    fail += 1; console.log('FAIL  unexpected error', e && e.stack);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed.  (working copy: ${WORK} - delete it when done)`);
    process.exit(fail ? 1 : 0);
  }
})();
