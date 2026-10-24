// Items 24 + 7 + 8 — Employee Management visibility by hierarchy; reporting managers; birthdays. SANDBOX ONLY.
const TLT = require('./tl-target');
if (!TLT.sandbox) throw new Error('sandbox only');
const path = require('path'); const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const crypto = require('crypto');

const tag = Date.now().toString(36);
const made = { users: [], emps: [] };
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m); } };
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function http(u, method, p, body) {
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await fetch(`${TLT.API}${p}`, { method, headers: { Authorization: `Bearer ${tok(u)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) { await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw new Error('API down');
}
const listOf = (b) => (Array.isArray(b) ? b : (b && (b.employees || b.rows || b.items))) || [];
async function person(label, { role = 'EMPLOYEE', dept, team = null, scopeDepts = null, scopeTeams = null, login = true, extra = {} }) {
  let u = null;
  if (login) {
    u = await prisma.user.create({ data: { name: `ZZTEST ${label}`, email: `zztest.scope.${label.toLowerCase().replace(/\W+/g, '')}.${tag}@example.test`, passwordHash: crypto.randomBytes(16).toString('hex'), status: 'Active', role, hrmsRole: role, hrmsAccess: true, atsAccess: false, accountsAccess: false, atsScopeDepartments: scopeDepts, atsScopeTeams: scopeTeams } });
    made.users.push(u.id);
  }
  const e = await prisma.employee.create({ data: { userId: u ? u.id : null, employeeCode: `ZZT-${label.replace(/\W+/g, '').slice(0, 8)}-${tag}`, name: `ZZTEST ${label}`, email: u ? u.email : `zztest.${label}.${tag}@example.test`, department: dept, team, employmentStatus: 'Active', ...extra } });
  made.emps.push(e.id);
  return { u, e };
}
const zz = (list) => listOf(list).filter((x) => /ZZTEST/.test(x.name) && String(x.employeeCode || '').endsWith(tag)).map((x) => x.name.replace('ZZTEST ', '')).sort();

(async () => {
  const eduA = await person('EduA', { dept: 'Education', team: 'Team-A', login: false });
  const eduB = await person('EduB', { dept: 'Education', team: 'Team-B', login: false });
  const med = await person('Med', { dept: 'Medical', login: false });
  const mfg = await person('Mfg', { dept: 'Manufacturing', login: false });
  const hr = await person('HRdept', { dept: 'HR', login: false });
  const left = await person('Left', { dept: 'Medical', login: false, extra: { employmentStatus: 'Exited', dateOfBirth: new Date(new Date().setDate(new Date().getDate() + 2)) } });
  const bday = await person('Bday', { dept: 'Medical', login: false, extra: { dateOfBirth: new Date(new Date().setDate(new Date().getDate() + 2)) } });

  const stl1 = await person('STL1', { role: 'STL', dept: 'Education', scopeDepts: 'Education', scopeTeams: 'Team-A,Team-B' });
  const stl1a = await person('STL1a', { role: 'STL', dept: 'Education', scopeDepts: 'Education', scopeTeams: 'Team-A' });
  const stl2 = await person('STL2', { role: 'STL', dept: 'Medical', scopeDepts: 'Medical,Manufacturing' });
  const tl = await person('TLA', { role: 'TL', dept: 'Education', team: 'Team-A' });
  const mgr = await person('Mgr', { role: 'MANAGER', dept: 'Administration' });
  const am = await person('AM', { role: 'ASSISTANT_MANAGER', dept: 'Administration' });
  const emp = await person('Emp', { role: 'EMPLOYEE', dept: 'Medical' });

  const seen = async (p) => zz((await http(p.u, 'GET', '/employees/management')).body);
  let v = await seen(stl1); console.log('STL1', v);
  ok(v.includes('EduA') && v.includes('EduB') && !v.includes('Med') && !v.includes('HRdept'), 'STL-1 (Education Team A + B) sees both Education teams only');
  v = await seen(stl1a); console.log('STL1a', v);
  ok(v.includes('EduA') && !v.includes('EduB') && !v.includes('Med'), 'STL with only Team A sees Team A, not Team B');
  v = await seen(stl2); console.log('STL2', v);
  ok(v.includes('Med') && v.includes('Mfg') && !v.includes('EduA') && !v.includes('HRdept'), 'STL-2 (Medical + Manufacturing) sees exactly those');
  ok(!v.includes('STL1') && !v.includes('Mgr'), 'STL does not see people above or peer STLs elsewhere');
  v = await seen(tl); console.log('TL', v);
  ok(v.includes('EduA') && !v.includes('EduB'), 'TL sees own team only');
  for (const [p, n] of [[mgr, 'Manager'], [am, 'Assistant Manager']]) {
    const r = await http(p.u, 'GET', '/employees/management');
    v = zz(r.body);
    ok(['EduA', 'EduB', 'Med', 'Mfg', 'HRdept'].every((x) => v.includes(x)), `${n} sees every department`);
    ok(r.body.caps && r.body.caps.edit === false && r.body.caps.create === false, `${n} is view-only (caps.edit=${r.body.caps && r.body.caps.edit})`);
    const put = await http(p.u, 'PUT', `/employees/${med.e.id}`, { location: 'ZZTEST' });
    ok(put.status === 403, `${n} cannot edit an employee (PUT -> ${put.status})`);
  }
  const er = await http(emp.u, 'GET', '/employees/management');
  v = zz(er.body);
  ok(er.status === 403 || (v.length <= 1 && !v.includes('Med')), `plain employee sees no one else (status ${er.status}, ${v})`);
  const one = await http(stl2.u, 'GET', `/employees/${eduA.e.id}`);
  ok([403, 404].includes(one.status), `STL-2 cannot open an Education record by id (${one.status})`);

  // Item 7 — reporting manager options
  const SA = await person('SA', { role: 'SUPER_ADMIN', dept: 'Administration' });
  const opt = await http(SA.u, 'GET', '/employees/management/options');
  const rms = opt.body.reportingManagers || [];
  ok(rms.length > 0 && rms.every((m) => m.label), `reportingManagers labelled (${rms.length}) e.g. "${rms[0] && rms[0].label}"`);
  ok(!rms.some((m) => /zztest/i.test(m.name)), 'no ZZTEST person offered as reporting manager');
  const exited = await prisma.employee.findMany({ where: { employmentStatus: { in: ['Relieved', 'Exited'] } }, select: { id: true } });
  const exitedIds = new Set(exited.map((x) => x.id));
  ok(!rms.some((m) => exitedIds.has(m.id)), `no leaver offered (${exited.length} leavers on file)`);
  const leads = rms.filter((m) => m.role).length;
  ok(leads > 0 && rms.slice(0, leads).every((m) => m.role), `leads listed first (${leads})`);
  const optTl = await http(tl.u, 'GET', '/employees/management/options');
  ok((optTl.body.reportingManagers || []).some((m) => m.role === 'ASSISTANT_MANAGER' || m.role === 'SUPER_ADMIN'), 'a TL is offered leads outside their own team');

  // Item 8 — birthdays only for active employees (via the dashboard as SA)
  const d = await http(SA.u, 'GET', '/hrms/dashboard');
  if (d.status === 200) {
    const cel = JSON.stringify(d.body.celebrations || d.body.birthdays || d.body);
    ok(!/ZZTEST Left/.test(cel), 'exited employee birthday not shown');
    const fo = d.body.filterOptions;
    ok(fo && fo.counts && Object.values(fo.counts.department || {}).every((n) => n > 0), 'dashboard filter options carry counts, none zero');
  } else console.log('dashboard status', d.status, d.body && d.body.error);
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); fail += 1; }).finally(async () => {
  const out = {};
  out.audit = (await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: [...made.users, ...made.emps] } }] } })).count;
  out.notes = (await prisma.notification.deleteMany({ where: { userId: { in: made.users } } })).count;
  out.emps = (await prisma.employee.deleteMany({ where: { id: { in: made.emps } } })).count;
  out.users = (await prisma.user.deleteMany({ where: { id: { in: made.users } } })).count;
  console.log('cleanup', out);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
});
