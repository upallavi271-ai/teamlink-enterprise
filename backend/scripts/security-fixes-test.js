#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SECURITY FIXES 2026-10-13 - regression suite. SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/security-fixes-test.js [section ...]
//
// Sections: roles, fields (items 3+4), portal, booking, partners, seedpw, harden
// ZZTEST users / rows are created in sandbox.db and removed again.
// ---------------------------------------------------------------------------
const path = require('path');

const realFetch = globalThis.fetch; // listRoutes() loads index.js, which installs the sandbox fetch block
globalThis.__realFetch = realFetch;

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const DB = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}?socket_timeout=120`;
process.env.DATABASE_URL = DB;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}` : ''}`);
}
async function rfetch(url, opt) {
  for (let i = 0; ; i += 1) {
    try { return await realFetch(url, opt); } catch (e) { if (i >= 150) throw e; await new Promise((r) => setTimeout(r, 2000)); }
  }
}
let ipN = 0;
async function call(method, p, token, body, extra = {}) {
  ipN += 1;
  const h = { 'X-Forwarded-For': `10.${(ipN >> 8) & 255}.${ipN & 255}.${Math.floor(Math.random() * 250)}`, ...(extra.headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined && !extra.raw) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); } else if (extra.raw) payload = body;
  const r = await rfetch(`${API}${p}`, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, headers: r.headers };
}

const made = { users: [], employees: [], clients: [], candidates: [], extra: [] };
let seq = 0;
async function mkUser(label, data = {}, empData = null) {
  seq += 1;
  const email = `zz-sec-${label.toLowerCase().replace(/\W+/g, '')}-${RUN}-${seq}@example.test`;
  const u = await prisma.user.create({
    data: {
      name: `ZZTEST Sec ${label}`, email, username: email, passwordHash: await bcrypt.hash(`Zz-${RUN}-Unused-${seq}!`, 4),
      status: 'Active', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', atsRole: 'NONE', accountsRole: 'NONE',
      hrmsAccess: true, atsAccess: false, accountsAccess: false, passwordChangedAt: new Date(), ...data,
    },
  });
  made.users.push(u.id);
  let emp = null;
  if (empData) {
    emp = await prisma.employee.create({
      data: {
        employeeCode: `ZZS${RUN}${seq}`.toUpperCase().slice(0, 14), name: u.name, email, department: 'Educational', designation: 'Employee',
        userId: u.id, employmentStatus: 'Active', ...empData,
      },
    });
    made.employees.push(emp.id);
  }
  return { u, emp };
}
const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });

async function cleanup() {
  const ids = made.users;
  const out = {};
  try {
    out.notif = (await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { message: { contains: 'ZZTEST Sec' } }] } })).count;
    out.audit = (await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }, { toValue: { contains: 'ZZTEST' } }, { action: { contains: 'ZZTEST' } }] } })).count;
    if (made.employees.length) {
      for (const m of ['payslip', 'salaryStructure', 'attendance', 'leaveRequest']) {
        // eslint-disable-next-line no-await-in-loop
        await prisma[m].deleteMany({ where: { employeeId: { in: made.employees } } }).catch(() => {});
      }
      await prisma.employee.deleteMany({ where: { id: { in: made.employees } } }).catch((e) => console.log('emp cleanup', e.message));
    }
    for (const fn of made.extra) { try { await fn(); } catch (e) { console.log('extra cleanup', e.message); } }
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.log('user cleanup', e.message));
  } catch (e) { console.log('cleanup error', e.message); }
  console.log('cleanup', JSON.stringify(out));
}

// ===================================================================== ROLES
async function sectionRoles() {
  console.log('\n--- 1/2: role escalation ---');
  const sa1 = await mkUser('SA1', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Super Admin' });
  const sa2 = await mkUser('SA2', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Super Admin' });
  const adm = await mkUser('Admin', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Admin' });
  const adm2 = await mkUser('Admin2', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Admin' });
  const hr = await mkUser('HR', { role: 'HR', hrmsRole: 'HR' }, { designation: 'HR', department: 'Educational' });
  const stl = await mkUser('STL', { role: 'STL', hrmsRole: 'STL', atsRole: 'STL', atsAccess: true, atsDepartment: 'Educational', atsScopeDepartments: 'Educational' }, { designation: 'STL' });
  const tl = await mkUser('TL', { role: 'TL', hrmsRole: 'TL', atsRole: 'TL', atsAccess: true, atsDepartment: 'Educational', atsScopeDepartments: 'Educational' }, { designation: 'TL' });
  const tgt = await mkUser('Target', {}, { designation: 'Employee' });
  const tgtSa = await mkUser('TargetSA', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN' }, { designation: 'Super Admin' });
  const t = {}; for (const [k, v] of Object.entries({ sa1, sa2, adm, adm2, hr, stl, tl })) t[k] = await mint(v.u);
  const roleOf = async (id) => (await prisma.user.findUnique({ where: { id } })).role;
  const rolePath = (e) => `/api/employees/management/${e.id}/roles`;

  // ---- legacy {role} on the employee screen
  for (const who of ['hr', 'stl', 'tl', 'adm']) {
    for (const val of ['ADMIN', 'SUPER_ADMIN']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call('PUT', rolePath(tgt.emp), t[who], { role: val });
      check(`${who} cannot make an employee ${val} (legacy role field)`, r.status === 403, r.status);
    }
  }
  for (const who of ['hr', 'stl']) {
    for (const val of ['MANAGER', 'HR', 'ASSISTANT_MANAGER']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call('PUT', rolePath(tgt.emp), t[who], { role: val });
      check(`${who} cannot give ${val}`, r.status === 403, r.status);
    }
    const r2 = await call('PUT', rolePath(tgt.emp), t[who], { roleCode: 'ADMIN' });
    check(`${who} cannot give roleCode ADMIN`, r2.status === 403, r2.status);
  }
  check('target stayed EMPLOYEE after all refused attempts', (await roleOf(tgt.u.id)) === 'EMPLOYEE', await roleOf(tgt.u.id));
  // ---- HR / Admin touching a Super Admin or Admin login
  for (const who of ['hr', 'adm']) {
    const r = await call('PUT', rolePath(tgtSa.emp), t[who], { role: 'EMPLOYEE' });
    check(`${who} cannot demote a Super Admin`, r.status === 403, r.status);
  }
  const r0 = await call('PUT', rolePath(adm2.emp), t.hr, { role: 'EMPLOYEE' });
  check('hr cannot demote an Admin', r0.status === 403, r0.status);
  const r0b = await call('PUT', rolePath(adm2.emp), t.adm, { role: 'EMPLOYEE' });
  check('admin cannot demote another Admin', r0b.status === 403, r0b.status);
  // ---- self-promotion
  const rs = await call('PUT', rolePath(hr.emp), t.hr, { role: 'ADMIN' });
  check('hr cannot promote self', rs.status === 403, rs.status);
  const rs2 = await call('PUT', rolePath(sa1.emp), t.sa1, { role: 'EMPLOYEE' });
  check('super admin cannot change own role', rs2.status === 403, rs2.status);
  // ---- Admin may hand out Manager
  const ra = await call('PUT', rolePath(tgt.emp), t.adm, { role: 'MANAGER' });
  check('admin may give MANAGER', ra.status === 200 && (await roleOf(tgt.u.id)) === 'MANAGER', ra.status);
  await prisma.user.update({ where: { id: tgt.u.id }, data: { role: 'EMPLOYEE' } });
  // ---- Super Admin may; audit row + notification to the other SA
  const before = await prisma.notification.count({ where: { userId: sa2.u.id } });
  const rsa = await call('PUT', rolePath(tgt.emp), t.sa1, { role: 'ADMIN' });
  check('super admin may give ADMIN', rsa.status === 200 && (await roleOf(tgt.u.id)) === 'ADMIN', rsa.status);
  const au = await prisma.auditLog.findFirst({ where: { entityId: tgt.u.id, action: { startsWith: 'Role change' } }, orderBy: { createdAt: 'desc' } });
  check('role change written to the audit log (who, whom, old -> new)', !!au && /ADMIN/.test(au.toValue || '') && /EMPLOYEE/.test(au.fromValue || ''), au);
  check('other Super Admin was notified of the ADMIN grant', (await prisma.notification.count({ where: { userId: sa2.u.id } })) === before + 1);
  await prisma.user.update({ where: { id: tgt.u.id }, data: { role: 'EMPLOYEE' } });
  const rsa2 = await call('PUT', rolePath(tgt.emp), t.sa1, { role: 'SUPER_ADMIN' });
  check('super admin may give SUPER_ADMIN', rsa2.status === 200, rsa2.status);
  await prisma.user.update({ where: { id: tgt.u.id }, data: { role: 'EMPLOYEE' } });

  // ---- admin.js users routes
  const U = (id) => `/api/admin/users/${id}`;
  let r = await call('PUT', U(tgt.u.id), t.adm, { role: 'SUPER_ADMIN' });
  check('admin cannot set SUPER_ADMIN via PUT /admin/users/:id', r.status === 403, r.status);
  r = await call('PUT', U(tgt.u.id), t.adm, { role: 'ADMIN' });
  check('admin cannot set ADMIN via PUT /admin/users/:id', r.status === 403, r.status);
  r = await call('PUT', U(tgt.u.id), t.adm, { hrmsRole: 'SUPER_ADMIN' });
  check('admin cannot set hrmsRole SUPER_ADMIN', r.status === 403, r.status);
  r = await call('PUT', U(tgtSa.u.id), t.adm, { name: 'ZZTEST Sec renamed', role: 'EMPLOYEE' });
  check('admin cannot edit a Super Admin', r.status === 403, r.status);
  r = await call('PUT', U(tgtSa.u.id), t.adm, { atsDepartment: 'IT' });
  check('admin cannot change a Super Admin department', r.status === 403, r.status);
  r = await call('POST', '/api/admin/users', t.adm, { name: 'ZZTEST Sec NewSA', email: `zz-sec-newsa-${RUN}@example.test`, password: 'Zz!Strong-Pass-123', role: 'SUPER_ADMIN' });
  check('admin cannot create a Super Admin', r.status === 403, r.status);
  r = await call('POST', '/api/admin/users', t.adm, { name: 'ZZTEST Sec NewAdm', email: `zz-sec-newadm-${RUN}@example.test`, password: 'Zz!Strong-Pass-123', role: 'ADMIN' });
  check('admin cannot create an Admin', r.status === 403, r.status);
  r = await call('POST', `${U(tgtSa.u.id)}/reset-password`, t.adm, { password: 'Zz!Strong-Pass-456-x' });
  check('admin cannot reset a Super Admin password (typed path)', r.status === 403, r.status);
  r = await call('POST', `${U(adm2.u.id)}/reset-password`, t.adm, { password: 'Zz!Strong-Pass-456-x' });
  check('admin cannot reset another Admin password (typed path)', r.status === 403, r.status);
  r = await call('POST', `${U(tgtSa.u.id)}/reset-link`, t.adm, {});
  check('admin cannot make a reset link for a Super Admin', r.status === 403, r.status);
  r = await call('POST', `${U(adm2.u.id)}/reset-link`, t.adm, {});
  check('admin cannot make a reset link for another Admin', r.status === 403, r.status);
  r = await call('POST', `${U(tgtSa.u.id)}/toggle-status`, t.adm, {});
  check('admin cannot switch off a Super Admin', r.status === 403, r.status);
  r = await call('PUT', U(tgt.u.id), t.hr, { role: 'ADMIN' });
  check('hr is refused on /admin/users (no Users right)', r.status === 403, r.status);
  // HR typed-password reset on a Super Admin / Admin (employee screen)
  r = await call('POST', `/api/employees/management/${tgtSa.emp.id}/reset-password`, t.hr, { password: 'Zz!Strong-Pass-456-x' });
  check('hr cannot reset a Super Admin password', r.status === 403, r.status);
  r = await call('POST', `/api/employees/management/${adm2.emp.id}/reset-password`, t.hr, { password: 'Zz!Strong-Pass-456-x' });
  check('hr cannot reset an Admin password', r.status === 403, r.status);
  r = await call('POST', `/api/employees/management/${tgtSa.emp.id}/toggle-login`, t.hr, {});
  check('hr cannot switch off a Super Admin login', r.status === 403, r.status);
  // designation mapping to Admin
  r = await call('PUT', '/api/admin/designation-roles/ZZTEST-Desig', t.adm, { hrmsRole: 'ADMIN', atsRole: 'ADMIN' });
  check('admin cannot map a designation to ADMIN', r.status === 403, r.status);
  // role catalog rows of SA / Admin
  r = await call('PUT', '/api/admin/role-catalog/SUPER_ADMIN/modules/candidates', t.adm, { enabled: true });
  check('admin cannot edit the Super Admin role catalog row', r.status === 403, r.status);
  // Super Admin succeeds
  r = await call('PUT', U(tgt.u.id), t.sa1, { role: 'ADMIN' });
  check('super admin may set ADMIN via PUT /admin/users/:id', r.status === 200, r.status);
  await prisma.user.update({ where: { id: tgt.u.id }, data: { role: 'EMPLOYEE' } });
  r = await call('POST', '/api/admin/users', t.sa1, { name: 'ZZTEST Sec NewSA2', email: `zz-sec-newsa2-${RUN}@example.test`, password: 'Zz!Strong-Pass-123', role: 'SUPER_ADMIN' });
  check('super admin may create a Super Admin', r.status === 201, r.status);
  if (r.body && r.body.id) made.users.push(r.body.id);
  r = await call('POST', `${U(tgtSa.u.id)}/reset-password`, t.sa1, { password: 'Zz!Strong-Pass-456-x' });
  check('super admin may reset a Super Admin password', r.status === 200, r.status);
  // last super admin guard (unit): demoting when no other active SA exists
  const guard = require(path.join(BACK, 'src/utils/roleGuard'));
  const realCount = guard.superAdminCount;
  const others = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'Active', id: { notIn: [sa1.u.id] } }, select: { id: true } });
  await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'Inactive' } });
  try {
    const why = await guard.checkRoleChange({ actor: { id: sa2.u.id, role: 'SUPER_ADMIN' }, current: { id: sa1.u.id, role: 'SUPER_ADMIN' }, next: { role: 'EMPLOYEE' } });
    check('the last Super Admin cannot be downgraded', /at least one Super Admin/.test(why || ''), why);
  } finally {
    await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'Active' } });
  }
  void realCount;
}

(async () => {
  try {
    if (want('roles')) await sectionRoles();
    for (const s of ['fields', 'portal', 'booking', 'partners', 'seedpw', 'harden']) {
      if (want(s) && require('fs').existsSync(path.join(__dirname, 'lib', `sec-${s}.js`))) {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const ctx = { check, call, mkUser, mint, made, prisma, RUN, API, BACK, rfetch };
        // eslint-disable-next-line global-require, import/no-dynamic-require
        await require(path.join(__dirname, 'lib', `sec-${s}.js`))(ctx);
        // eslint-disable-next-line global-require
        if (s === 'harden') await require(path.join(__dirname, 'lib', 'sec-harden2.js'))(ctx);
      }
    }
  } catch (e) {
    fail += 1; console.log('FAIL  suite crashed:', e && e.stack);
  } finally {
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
