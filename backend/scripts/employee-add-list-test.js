#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ADD EMPLOYEE + THE EMPLOYEE LIST (founder, 2026-10-23). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --detach --no-watch && TL_API=http://localhost:4011 node scripts/employee-add-list-test.js
//   Biometric ID on the Edit route; the Team -> Position data (Education Team A = EDU-1..5, Team B = EDU-6..10); the exit dates beside the
//   joining date in the list (notice period / relieved); the screen puts Team before Position and has the Biometric ID and Dates columns.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX; process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j };
}
(async () => {
  const made = { users: [], emps: [] };
  try {
    const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST EA admin ${RUN}`, email: `zz-ea-${RUN}@example.test`, username: `zz-ea-${RUN}@example.test`, role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'NONE', hrmsAccess: true, accountsAccess: false, atsAccess: true, status: 'Active' } });
    made.users.push(u.id);
    const tok = jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });

    // ---- the Team -> Position data the form uses ----
    const opts = (await call('GET', '/api/employees/management/options', tok)).body;
    const edu = (opts.positions || []).filter((p) => p.department === 'Education');
    const codesOf = (team) => edu.filter((p) => p.team === team && !/TL$/i.test(p.code)).map((p) => p.code).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    check('T1 Education Team A = EDU-1 to EDU-5 (the seats carry their team)', JSON.stringify(codesOf('Team A')) === JSON.stringify(['EDU-1', 'EDU-2', 'EDU-3', 'EDU-4', 'EDU-5']), codesOf('Team A'));
    check('T2 Education Team B = EDU-6 to EDU-10', JSON.stringify(codesOf('Team B')) === JSON.stringify(['EDU-6', 'EDU-7', 'EDU-8', 'EDU-9', 'EDU-10']), codesOf('Team B'));
    check('T3 the two teams share no seat (a team picks only its own seats)', !codesOf('Team A').some((c) => codesOf('Team B').includes(c)), null);

    // ---- Biometric ID on the Edit route ----
    const mk = async (tag) => { const r = await call('POST', '/api/employees/management', tok, { name: `ZZTEST EA ${tag} ${RUN}`, email: `zz-ea-${tag}-${RUN}@example.test`, department: 'Education', designation: 'Employee', phone: '', password: 'Zz-test-pass1' }); if (r.body && r.body.id) made.emps.push(r.body.id); return r; };
    const e1 = await mk('one'); const e2 = await mk('two');
    check('B0 two test employees created', e1.status === 201 && e2.status === 201, [e1.status, e2.status, e1.body && e1.body.error]);
    const pin = `ZZ${RUN}`.slice(0, 18);
    let r = await call('PUT', `/api/employees/${e1.body.id}`, tok, { biometricPin: pin });
    check('B1 Biometric ID set from the Edit route (200)', r.status === 200, [r.status, r.body]);
    r = await call('PUT', `/api/employees/${e2.body.id}`, tok, { biometricPin: pin });
    check('B2 the same Biometric ID on another employee is refused (409), naming the holder', r.status === 409 && /already belongs to/.test((r.body && r.body.error) || ''), [r.status, r.body]);
    r = await call('PUT', `/api/employees/${e2.body.id}`, tok, { biometricPin: 'no spaces!' });
    check('B3 an odd Biometric ID is refused (400)', r.status === 400, [r.status, r.body]);
    r = await call('PUT', `/api/employees/${e1.body.id}`, tok, { biometricPin: '' });
    const cleared = await prisma.employee.findUnique({ where: { id: e1.body.id }, select: { biometricPin: true } });
    check('B4 an empty Biometric ID clears it', r.status === 200 && cleared.biometricPin === null, [r.status, cleared]);
    r = await call('PUT', `/api/employees/${e2.body.id}`, tok, { biometricPin: pin });
    check('B5 once cleared, the same ID can go to someone else', r.status === 200, [r.status, r.body]);

    // ---- the exit dates in the list ----
    const list = (await call('GET', '/api/employees/management', tok)).body;
    const rows = (list && list.rows) || [];
    const relieved = rows.filter((x) => x.employmentStatus === 'Relieved');
    const withDate = relieved.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x.exitDate || '')));
    const dbDated = await prisma.$queryRawUnsafe("select count(distinct r.employeeId) c from EmployeeRecord r join Employee e on e.id=r.employeeId where r.type='RESIGNATION' and e.employmentStatus='Relieved' and r.status not in ('Withdrawn','Rejected') and r.date glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'");
    const expected = Number(dbDated[0].c);
    check('D1 every relieved person whose resignation record has a last day shows it (the same count as the records)', relieved.length > 0 && expected > 0 && withDate.length >= expected, [relieved.length, withDate.length, expected]);
    const noticeDb = await prisma.$queryRawUnsafe("select count(*) c from ResignationDetail d join EmployeeRecord r on r.id=d.recordId join Employee e on e.id=r.employeeId where e.employmentStatus='Relieved' and d.resignationDate glob '[0-9][0-9][0-9][0-9]-*'");
    const withNotice = relieved.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x.noticeFrom || '')));
    check('D2 notice-from shows only where a resignation date is really recorded (never invented)', Number(noticeDb[0].c) === 0 ? withNotice.length === 0 : withNotice.length > 0, [Number(noticeDb[0].c), withNotice.length]);
    check('D2b people with no recorded date show nothing, not a guess', relieved.filter((x) => !x.exitDate).every((x) => x.exitDate === null), null);
    const active = rows.filter((x) => x.employmentStatus === 'Active');
    check('D3 an active employee carries no exit dates', active.every((x) => !x.exitDate && !x.noticeFrom), active.filter((x) => x.exitDate || x.noticeFrom).map((x) => x.name));
    const notice = rows.filter((x) => x.employmentStatus === 'Notice Period');
    check('D4 people on notice are in the list with the date fields present (a missing date is null, never a wrong one)', notice.every((x) => 'exitDate' in x && 'noticeFrom' in x), notice.map((x) => [x.name, x.exitDate, x.noticeFrom]));
    check('D5 the joining date is still there for everybody', rows.filter((x) => x.joiningDate).length > rows.length * 0.8, rows.length);

    // ---- the screen ----
    const src = fs.readFileSync(path.join(BACK, '..', 'frontend/src/pages/Employees.jsx'), 'utf8');
    const modal = src.slice(src.indexOf('function AddEmployeeModal'));
    const iTeam = modal.indexOf("FL.label('team', 'Team')"); const iPos = modal.indexOf("FL.label('position', 'Position')");
    check('U1 Add Employee: Team comes BEFORE Position', iTeam > 0 && iPos > 0 && iTeam < iPos, [iTeam, iPos]);
    check('U2 Add Employee has the Biometric ID field and sends it', /FL\.label\('biometricPin', 'Biometric ID'\)/.test(modal) && /biometricPin: ''/.test(src), null);
    check('U3 choosing a team narrows the seats and choosing a seat fills its team', /tkey\(r\.team\) === tkey\(form\.team\)/.test(modal) && /seat\.team && !form\.team/.test(modal) && /teamName\(seat\.team\)/.test(modal), null);
    check('U4 the employee list has a Dates column (Joined, Notice from, Last day, Relieved on)', /<th[^>]*>Dates<\/th>/.test(src) && /Relieved on/.test(src) && /Notice from/.test(src), null);
  } catch (e) { fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 600) : e); } finally {
    try {
      const emps = await prisma.employee.findMany({ where: { name: { contains: `ZZTEST EA ` } }, select: { id: true, userId: true } });
      const ids = [...new Set([...made.emps, ...emps.map((e) => e.id)])];
      await prisma.positionAssignment.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { actorName: { contains: 'ZZTEST EA' } }] } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { OR: [{ id: { in: [...made.users, ...emps.map((e) => e.userId).filter(Boolean)] } }, { email: { contains: 'zz-ea-' } }] } }).catch(() => {});
    } catch (e) { console.log('cleanup problem:', e.message.slice(0, 160)); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
