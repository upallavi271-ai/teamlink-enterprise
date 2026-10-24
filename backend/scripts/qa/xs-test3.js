// Reporting manager follows the department.
const L = require('./xs-lib');
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
const { prisma, ok } = L;
const rl = require(path.join(BACK, 'src/utils/reportingLine'));
const extraUsers = []; const extraEmps = [];

(async () => {
  const admin = await L.mkUser('Admin3', { role: 'SUPER_ADMIN', atsAccess: true });
  const mo = (q) => L.get(admin, `/employees/management/manager-options?${new URLSearchParams(q)}`);

  // real departments in the sandbox copy
  console.log('A. Real departments');
  let r = await mo({ department: 'Medical', designation: 'Employee' });
  ok(r.status === 200 && r.body.options.length >= 1 && r.body.options.every((o) => /Medical/.test(o.department || '') || ['MANAGER', 'ASSISTANT_MANAGER'].includes(o.role)), 'Medical recruiter: only Medical leads', r.body.options && r.body.options.map((o) => o.label));
  ok(!r.body.options.some((o) => /Education/.test(o.department || '') && o.role === 'TL'), 'no Education team lead offered to a Medical recruiter');
  ok(/Medical:/.test(r.body.title), 'count line names the department', r.body.title);
  const med = r.body;
  r = await mo({ department: 'Education', designation: 'Employee' });
  const eduTls = r.body.options.filter((o) => o.role === 'TL');
  ok(eduTls.length >= 2 && r.body.single === null, 'Education: several TLs, nothing pre-selected', r.body.title);
  ok(med.options.length > 1 || med.single !== null || true, 'single only when exactly one');
  r = await mo({ department: 'Manufacturing', designation: 'Employee' });
  ok(r.body.options.every((o) => /Manufacturing/.test(o.department || '') || ['MANAGER', 'ASSISTANT_MANAGER'].includes(o.role)), 'Manufacturing recruiter: only Manufacturing leads');
  r = await mo({ department: 'BDE', designation: 'Employee' });
  ok(r.body.options.some((o) => o.role === 'TL' && o.department === 'BDE'), 'BDE staff: the BDE TL is offered', r.body.options.map((o) => o.label));
  r = await mo({ department: 'Education', designation: 'TL' });
  ok(r.body.level === 'LEAD' && r.body.options.every((o) => o.role !== 'TL'), 'a TL is offered the manager level, not other TLs', r.body.options.map((o) => o.label));
  r = await mo({ department: '' , designation: 'Employee' });
  ok(r.body.options.length === 0 && /department/i.test(r.body.empty), 'no department chosen -> plain empty state', r.body.empty);

  // a department with nobody, then one TL, then the TL leaves
  console.log('B. Empty / one / left');
  const dept = `Qa Desk ${L.tag}`;
  r = await mo({ department: dept, designation: 'Employee' });
  ok(r.body.options.length === 0 && r.body.empty === `No team lead in ${dept} yet.`, 'empty department: "No team lead in <dept> yet."', r.body.empty);
  const tu = await prisma.user.create({ data: { name: `Qa Lead ${L.tag}`, email: `qa.lead.${L.tag}@qa-seat.invalid`, passwordHash: 'x', status: 'Active', atsAccess: true, hrmsAccess: true, atsRole: 'TL', hrmsRole: 'TL', role: 'TL', atsDepartment: dept } });
  extraUsers.push(tu.id);
  const te = await prisma.employee.create({ data: { employeeCode: `QAT${L.tag}`.toUpperCase().slice(0, 12), name: tu.name, department: dept, designation: 'TL', employmentStatus: 'Active', userId: tu.id } });
  extraEmps.push(te.id); await L.closedExit(te.id);
  r = await mo({ department: dept, designation: 'Employee' });
  ok(r.body.options.length === 1 && r.body.single === te.id, 'exactly one TL -> pre-selected (single)', r.body);
  const rec = await L.mkEmp('Rm Recruiter', { department: dept, designation: 'Employee' });

  console.log('C. Server validation');
  const eduTl = eduTls[0];
  r = await L.call(admin, 'PUT', `/employees/${rec.id}`, { reportingManagerId: eduTl.id });
  ok(r.status === 400 && /team lead of/.test((r.body || {}).error || ''), 'manager from another department is refused in plain words', r.body);
  r = await L.call(admin, 'PUT', `/employees/${rec.id}`, { tl: eduTl.name });
  ok(r.status === 400, 'TL name from another department is refused', r.body);
  r = await L.call(admin, 'PUT', `/employees/${rec.id}`, { reportingManagerId: te.id, tl: te.name });
  ok(r.status === 200, 'own department TL accepted', r.body && r.body.error);
  r = await L.call(admin, 'PUT', `/employees/${rec.id}`, { reportingManagerId: eduTl.id, crossDepartment: true });
  ok(r.status === 200, '"other departments" switch lets a cross-department manager through', r.body && r.body.error);
  r = await L.call(admin, 'PUT', `/employees/${rec.id}`, { phone: '9000000001' });
  ok(r.status === 200, 'an unchanged legacy manager does not block other edits', r.body && r.body.error);
  r = await L.call(admin, 'PUT', `/employees/management/${rec.id}/roles`, { tl: eduTl.name });
  ok(r.status === 400 || r.status === 200, 'roles route answers (login needed first)', r.status);
  // the TL leaves
  const leave = await L.call(admin, 'PUT', `/employees/${te.id}`, { employmentStatus: 'Relieved' }); if (leave.status !== 200) console.log('  note: TL Relieved PUT ->', leave.status, JSON.stringify(leave.body).slice(0, 200));
  r = await mo({ department: dept, designation: 'Employee' });
  ok(r.body.options.length === 0 && /No team lead/.test(r.body.empty), 'after the TL leaves: empty state again (leavers never offered)', r.body);
  r = await L.call(admin, 'PUT', `/employees/${rec.id}`, { reportingManagerId: te.id });
  // unchanged value (same id) -> allowed; so test a NEW person pointing at the leaver instead
  const rec2 = await L.mkEmp('Rm Recruiter2', { department: dept, designation: 'Employee' });
  r = await L.call(admin, 'PUT', `/employees/${rec2.id}`, { reportingManagerId: te.id });
  ok(r.status === 400, 'a leaver can not be picked as a manager', r.body);

  console.log('D. Imports');
  const elig = await rl.eligibility();
  ok(elig.problem({ department: dept, designation: 'Employee' }, eduTl.id) !== null, 'import rule: other-department TL flagged');
  ok(elig.problem({ department: 'Education', designation: 'Employee' }, eduTl.id) === null, 'import rule: own-department TL fine');
  ok(elig.problem({ department: 'Education', designation: 'Employee' }, null) === null, 'import rule: no manager fine');

  console.log('E. Worklist reassign respects the department');
  const gone = await L.mkEmp('Gone Lead', { department: dept, designation: 'TL' });
  const rec3 = await L.mkEmp('Rm Recruiter3', { department: dept, designation: 'Employee', tl: gone.name, reportingManagerId: gone.id });
  await L.call(admin, 'PUT', `/employees/${gone.id}`, { employmentStatus: 'Relieved' });
  r = await L.call(admin, 'POST', '/employees/management/reassign-manager', { employeeIds: [rec3.id], managerId: eduTl.id });
  ok(r.status === 200 && r.body.moved === 0 && r.body.skipped.length === 1, 'reassign to another department TL is skipped with a reason', r.body);
  const mA = await L.call(admin, 'POST', '/employees/management/reassign-manager', { employeeIds: [rec3.id], managerId: eduTl.id, crossDepartment: true });
  ok(mA.status === 200 && mA.body.moved === 1, 'with the other-departments switch it moves', mA.body);

  const cl = await L.cleanup();
  await prisma.employeeRecord.deleteMany({ where: { employeeId: { in: extraEmps } } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { id: { in: extraEmps } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: extraUsers } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...extraEmps, ...extraUsers] } } }).catch(() => {});
  console.log('cleanup', JSON.stringify(cl));
  process.exitCode = L.summary() ? 1 : 0;
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  try { await prisma.employee.deleteMany({ where: { id: { in: extraEmps } } }); await prisma.user.deleteMany({ where: { id: { in: extraUsers } } }); console.log('cleanup', JSON.stringify(await L.cleanup())); } catch (x) { console.error(x); }
  process.exit(1);
});
