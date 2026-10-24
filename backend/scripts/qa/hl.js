const TLT = require('./tl-target');
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const crypto = require('crypto');
const API = TLT.API;
const tag = Date.now().toString(36);
const created = { users: [], emps: [] };
const DEPT = 'ZZTEST-HL-' + tag;
let pass = 0; let fail = 0;
function ok(cond, msg) { if (cond) { pass += 1; console.log('  ok   ' + msg); } else { fail += 1; console.log('  FAIL ' + msg); } }
async function persona(label, { role = 'EMPLOYEE', hrmsRole = 'EMPLOYEE', atsRole = 'EMPLOYEE', dept = DEPT, team = 'ZT', status = 'Active', empStatus = 'Active', tlName = null, stlName = null, noEmp = false, userStatus = 'Active' } = {}) {
  const u = await prisma.user.create({ data: {
    name: `ZZTEST ${label} ${tag}`, email: `zztest.${label.toLowerCase()}.${tag}@example.test`, passwordHash: `!disabled-${crypto.randomBytes(6).toString('hex')}`,
    role, atsRole, hrmsRole, status: userStatus, hrmsAccess: true, atsAccess: true, accountsAccess: false, atsDepartment: dept,
  } });
  created.users.push(u.id);
  let e = null;
  if (!noEmp) {
    e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-${label}-${tag}`, name: u.name, userId: u.id, department: dept, team, designation: label, employmentStatus: empStatus, tl: tlName, stl: stlName, email: u.email } });
    created.emps.push(e.id);
  }
  return { u, e };
}
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '2h' });
async function call(p, method, path2, body, raw) {
  const headers = { Authorization: `Bearer ${tok(p.u || p)}` };
  if (!raw) headers['Content-Type'] = 'application/json';
  let r; let text;
  for (let i = 0; i < 25; i += 1) {
    try { r = await fetch(API + path2, { method, headers, body: raw ? body : (body ? JSON.stringify(body) : undefined) }); text = await r.text(); break; } catch (e) { if (i === 24) throw e; await new Promise((x) => setTimeout(x, 3000)); }
  }
  let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { s: r.status, j };
}
const get = (p, x) => call(p, 'GET', x);
const post = (p, x, b) => call(p, 'POST', x, b || {});
const patch = (p, x, b) => call(p, 'PATCH', x, b || {});
const put = (p, x, b) => call(p, 'PUT', x, b || {});
async function cleanup() {
  const uids = created.users; const eids = created.emps;
  const leaves = await prisma.leaveRequest.findMany({ where: { employeeId: { in: eids } }, select: { id: true } });
  const lids = leaves.map((l) => l.id);
  const regs = await prisma.attendanceRegularization.findMany({ where: { employeeId: { in: eids } }, select: { id: true } });
  const lps = prisma.latePermission ? await prisma.latePermission.findMany({ where: { employeeId: { in: eids } }, select: { id: true } }) : [];
  const recIds = [...lids, ...regs.map((r) => r.id), ...lps.map((r) => r.id)];
  const out = {};
  const tasks = await prisma.task.findMany({ where: { OR: [{ description: { contains: '[auto-attendance' }, assigneeId: { in: uids } }, { assigneeId: { in: uids } }] }, select: { id: true } });
  out.tasks = (await prisma.task.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } })).count;
  out.steps = (await prisma.approvalStep.deleteMany({ where: { recordId: { in: recIds } } })).count;
  out.leaves = (await prisma.leaveRequest.deleteMany({ where: { id: { in: lids } } })).count;
  out.regs = (await prisma.attendanceRegularization.deleteMany({ where: { id: { in: regs.map((r) => r.id) } } })).count;
  if (lps.length) out.lps = (await prisma.latePermission.deleteMany({ where: { id: { in: lps.map((r) => r.id) } } })).count;
  out.balances = (await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: eids } } })).count;
  out.punch = (await prisma.attendancePunch.deleteMany({ where: { employeeId: { in: eids } } })).count;
  out.att = (await prisma.attendance.deleteMany({ where: { employeeId: { in: eids } } })).count;
  out.settings = (await prisma.appSetting.deleteMany({ where: { OR: [{ key: { in: lids.flatMap((i) => [`leave.early.${i}`, `leave.meta.${i}`]) } }, { key: { startsWith: 'leave.pulse.sync.' } }, { key: 'leave.pulse.last' }] } })).count;
  out.audit = (await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: uids } }, { entityId: { in: [...recIds, ...eids, ...tasks.map((t) => t.id)] } }, { actorName: { contains: 'ZZTEST' } }] } })).count;
  out.notes = (await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: uids } }, { recipient: { contains: 'example.test' } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } })).count;
  try { await prisma.session.deleteMany({ where: { userId: { in: uids } } }); } catch { /* */ }
  out.emps = (await prisma.employee.deleteMany({ where: { id: { in: eids } } })).count;
  out.users = (await prisma.user.deleteMany({ where: { id: { in: uids } } })).count;
  return out;
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = iso(new Date());
module.exports = { TLT, prisma, API, tag, created, DEPT, persona, tok, call, get, post, patch, put, cleanup, ok, summary: () => ({ pass, fail }), iso, addDays, today };
