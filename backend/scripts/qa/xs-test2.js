// Cascades + BDE directory + default TL + Add Employee without documents.
const L = require('./xs-lib');
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
const { prisma, ok } = L;
const { bdeDirectory } = require(path.join(BACK, 'src/utils/bdeSeats'));
const dtl = require(path.join(BACK, 'src/utils/defaultTeamLead'));
const extraUsers = []; const extraEmps = [];

(async () => {
  const admin = await L.mkUser('Admin2', { role: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true });

  // ---- A. BDE who exits -----------------------------------------------------
  console.log('A. BDE directory / clients');
  const seat = await L.mkSeat('BDE-EDU-1');
  const bde = await L.mkEmp('Bde Leaver', { department: 'BDE' }, { atsRole: 'BDE', atsAccess: true, role: 'BDE' });
  await L.seatIn(seat.id, bde.id, '2026-09-01');
  const keep = await L.mkEmp('Bde Stays', { department: 'BDE' }, { atsRole: 'BDE', atsAccess: true, role: 'BDE' });
  const cl = await prisma.client.create({ data: { name: `ZZTEST Client ${L.tag}`, bdeOwner: bde.name, secondaryBde: keep.name, ownerDepartment: 'Education' } });
  L.made.clients.push(cl.id);
  let dir = await bdeDirectory();
  ok(dir.infoFor(bde.name) && dir.infoFor(bde.name).active === true, 'before exit: BDE is an active desk BDE', dir.infoFor(bde.name));
  ok(dir.all().some((i) => i.name === bde.name), 'before exit: listed in all()');
  let r = await L.call(admin, 'PUT', `/employees/${bde.id}`, { employmentStatus: 'Exited' });
  ok(r.status === 200, 'BDE set to Exited');
  dir = await bdeDirectory();
  const info = dir.infoFor(bde.name);
  ok(info && info.active === false && info.former === true, 'after exit: former + inactive', info);
  ok(!dir.all().some((i) => i.name === bde.name), 'after exit: NOT in all() (not offered / not counted)');
  ok(dir.labelFor(bde.name) === `${bde.name} (former BDE)`, 'label reads "(former BDE)"', dir.labelFor(bde.name));
  ok(dir.all().some((i) => i.name === keep.name), 'the other BDE is still listed');
  r = await L.get(admin, '/clients/owner-options');
  ok(r.status === 200 && !(r.body || []).some((o) => o.name === bde.name), 'Owner BDE picker does not offer the leaver', (r.body || []).length);
  const clAfter = await prisma.client.findUnique({ where: { id: cl.id } });
  ok(clAfter.bdeOwner === bde.name && clAfter.secondaryBde === keep.name, 'client NOT silently reassigned (name kept as history)');
  r = await L.get(admin, '/employees/after-exit');
  ok(r.status === 200, 'after-exit worklist answers', r.body && r.body.error);
  const row = ((r.body || {}).clients || []).find((x) => x.id === cl.id);
  ok(row && row.formerBde === bde.name && row.stillCovered === true && row.otherBde === keep.name, 'worklist lists the client with former BDE and the BDE who remains', row);

  // ---- B. clients with NO other BDE ----------------------------------------------
  const cl2 = await prisma.client.create({ data: { name: `ZZTEST Client2 ${L.tag}`, bdeOwner: bde.name, ownerDepartment: 'Education' } });
  L.made.clients.push(cl2.id);
  r = await L.get(admin, '/employees/after-exit');
  const row2 = ((r.body || {}).clients || []).find((x) => x.id === cl2.id);
  ok(row2 && row2.needs === 'No active BDE' && row2.stillCovered === false, 'client with only the leaver: "No active BDE"', row2);

  // ---- C. people whose manager left + bulk reassign -----------------------------------
  console.log('C. Managers / jobs');
  const tlUser = await L.mkUser('Tl Leaver', { role: 'TL', atsRole: 'TL', atsAccess: true, atsDepartment: 'Education' });
  const tlEmp = await L.mkEmp('Tl Leaver', { designation: 'TL', userId: tlUser.id });
  const rec1 = await L.mkEmp('Recruiter A', { tl: tlEmp.name, reportingManagerId: tlEmp.id });
  const rec2 = await L.mkEmp('Recruiter B', { tl: tlEmp.name });
  const newTl = await L.mkEmp('New Boss', { designation: 'TL' });
  const job = await prisma.requirement.create({ data: { title: `ZZTEST job ${L.tag}`, department: 'Education', status: 'OPEN', tlId: tlUser.id, tl: tlEmp.name, clientId: cl.id } }).catch(async (e) => { console.log('job create:', e.message.split('\n').slice(-3).join(' ')); return null; });
  if (job) L.made.requirements.push(job.id);
  r = await L.call(admin, 'PUT', `/employees/${tlEmp.id}`, { employmentStatus: 'Relieved' });
  r = await L.get(admin, '/employees/after-exit');
  const people = (r.body || {}).people || [];
  ok(people.some((p) => p.id === rec1.id) && people.some((p) => p.id === rec2.id), 'worklist: people whose manager has left', people.map((p) => p.name));
  const p1 = people.find((p) => p.id === rec1.id);
  ok(p1 && p1.gone.length === 2, 'rec1 has both a team-lead name and a reporting-manager link to the leaver', p1 && p1.gone);
  if (job) ok(((r.body || {}).jobs || []).some((j) => j.id === job.id && j.missing === 'team lead'), 'worklist: job whose team lead left');
  r = await L.call(admin, 'POST', '/employees/management/reassign-manager', { employeeIds: [rec1.id, rec2.id], managerId: tlEmp.id });
  ok(r.status === 409, 'cannot move people to someone who has left', r.body);
  const eduTl = (await L.get(admin, '/employees/management/manager-options?department=Education&designation=Employee')).body.options.find((o) => o.role === 'TL');
  r = await L.call(admin, 'POST', '/employees/management/reassign-manager', { employeeIds: [rec1.id, rec2.id], managerId: newTl.id });
  ok(r.status === 200 && r.body.moved === 0 && r.body.skipped.length === 2, 'a manager who is not a lead of the department is skipped, with the reason', r.body);
  r = await L.call(admin, 'POST', '/employees/management/reassign-manager', { employeeIds: [rec1.id, rec2.id], managerId: eduTl.id });
  ok(r.status === 200 && r.body.moved === 2, 'bulk reassign moved 2', r.body);
  const a1 = await prisma.employee.findUnique({ where: { id: rec1.id } });
  const a2 = await prisma.employee.findUnique({ where: { id: rec2.id } });
  ok(a1.tl === eduTl.name && a1.reportingManagerId === eduTl.id && a2.tl === eduTl.name, 'fields point to the new manager');
  const hist = await prisma.auditLog.findMany({ where: { entityId: rec1.id, action: { contains: 'Manager changed' } } });
  ok(hist.length >= 1, 'audit rows written', hist.length);
  r = await L.get(admin, '/employees/after-exit');
  ok(!((r.body || {}).people || []).some((p) => p.id === rec1.id || p.id === rec2.id), 'worklist no longer lists them');
  // scope: a recruiter-level login sees nothing
  const rl = await L.mkUser('Plain Recruiter', { role: 'RECRUITER', atsRole: 'RECRUITER', atsAccess: true, hrmsAccess: false });
  r = await L.get(rl, '/employees/after-exit');
  ok(r.status === 200 && (r.body.counts.clients + r.body.counts.people + r.body.counts.approvals) === 0, 'a plain recruiter sees an empty worklist', r.body && r.body.counts);
  r = await L.call(rl, 'POST', '/employees/management/reassign-manager', { employeeIds: [rec1.id], managerId: newTl.id });
  ok(r.status === 403, 'a plain recruiter cannot reassign', r.status);

  // ---- D. default team lead ignores leavers ----------------------------------------------
  console.log('D. Default team lead');
  const dept = `Qa Desk ${L.tag}`;
  const u = await prisma.user.create({ data: { name: `Qa Lead ${L.tag}`, email: `qa.lead.${L.tag}@qa-seat.invalid`, passwordHash: 'x', status: 'Active', atsAccess: true, atsRole: 'TL', atsDepartment: dept, role: 'TL' } });
  extraUsers.push(u.id);
  const ue = await prisma.employee.create({ data: { employeeCode: `QA${L.tag}`.toUpperCase().slice(0, 12), name: u.name, department: dept, employmentStatus: 'Active', userId: u.id } });
  extraEmps.push(ue.id);
  await dtl.prime({ fresh: true });
  ok(dtl.defaultFor(dept) && dtl.defaultFor(dept).id === u.id, 'before exit: the department has exactly one team lead -> default');
  await prisma.employee.update({ where: { id: ue.id }, data: { employmentStatus: 'Relieved' } });
  await dtl.prime({ fresh: true });
  ok(dtl.defaultFor(dept) === null && dtl.tlsOf(dept).length === 0, 'after exit: the leaver is NOT the default team lead');
  await prisma.employee.update({ where: { id: ue.id }, data: { employmentStatus: 'Active' } });
  await dtl.prime({ fresh: true });
  ok(dtl.defaultFor(dept) && dtl.defaultFor(dept).id === u.id, 're-hire: back as the default team lead');

  // ---- E. Add Employee without documents -------------------------------------------------
  console.log('E. Add Employee without any document');
  const email = `zztest.addnodoc.${L.tag}@example.test`;
  r = await L.call(admin, 'POST', '/employees/management', { name: `ZZTEST NoDoc ${L.tag}`, email, department: 'Education', designation: 'Employee', password: 'Zz-Test-Pass-1' });
  ok(r.status === 201 || r.status === 200, 'employee created with NO documents at all', r.body && (r.body.error || r.status));
  if (r.body && r.body.id) {
    L.made.employees.push(r.body.id);
    const emp = await prisma.employee.findUnique({ where: { id: r.body.id }, include: { documents: true } });
    ok(emp && emp.documents.length === 0, 'no document rows, none required');
    if (emp && emp.userId) L.made.users.push(emp.userId);
    // documents remain available AFTER creation
    const dl = await L.get(admin, `/employees/${r.body.id}/documents`);
    ok(dl.status === 200 && Array.isArray(dl.body.documents) && Array.isArray(dl.body.docTypes), 'documents list/types are still served on the profile', dl.status);
  }
  r = await L.get(admin, '/employees/management/options');
  ok(r.status === 200 && r.body.documents === undefined, 'Add Employee options: no documents block');

  const cl3 = await L.cleanup();
  await prisma.user.deleteMany({ where: { id: { in: extraUsers } } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { id: { in: extraEmps } } }).catch(() => {});
  console.log('cleanup', JSON.stringify(cl3));
  process.exitCode = L.summary() ? 1 : 0;
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  try { await prisma.user.deleteMany({ where: { id: { in: extraUsers } } }); await prisma.employee.deleteMany({ where: { id: { in: extraEmps } } }); console.log('cleanup', JSON.stringify(await L.cleanup())); } catch (x) { console.error(x); }
  process.exit(1);
});
