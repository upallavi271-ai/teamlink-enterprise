// Fixture: every role + a world (client, job, people in process, an employee to message). Sandbox only.
const L = require('./oc');
const P = L.prisma;
async function build() {
  const W = { u: {} };
  const mk = async (k, data, emp) => { W.u[k] = await L.mkUser(k, data, emp); return W.u[k]; };
  await mk('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' });
  await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  await mk('am', { role: 'ASSISTANT_MANAGER', atsRole: 'ASSISTANT_MANAGER', hrmsRole: 'ASSISTANT_MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  await mk('stl', { role: 'STL', atsRole: 'STL', hrmsRole: 'STL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  await mk('tl', { role: 'TL', atsRole: 'TL', hrmsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { tl: W.u.tl.name });
  await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', hrmsRole: 'EMPLOYEE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
  await mk('bdetl', { role: 'TL', atsRole: 'TL', hrmsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
  await mk('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR', atsDepartment: 'HR', atsScopeDepartments: 'HR' }, { department: 'HR' });
  await mk('acct', { role: 'ACCOUNTANT', atsRole: 'NONE', hrmsRole: 'EMPLOYEE', atsAccess: false, accountsAccess: true, accountsRole: 'ACCOUNTANT' }, { department: 'Accounts' });
  await mk('emp', { role: 'EMPLOYEE', atsRole: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { tl: W.u.tl.name });
  const client = await P.client.create({ data: { name: `ZZTEST OC Client ${L.stamp}`, ownerDepartment: 'Education', bdeOwner: W.u.bde.name, clientType: 'Client', contactName: 'Mr OC Contact', contactEmail: `oc.contact.${L.stamp}@${L.OK}`, contactPhone: '9000071020', billingContactName: 'Ms OC Billing', billingContactEmail: `oc.billing.${L.stamp}@${L.OK}`, billingContactPhone: '9000071021' } });
  L.made.clients.push(client.id); W.client = client;
  const req = await P.requirement.create({ data: { title: 'ZZTEST OC Teacher', reqCode: `ZZOC${L.stamp}`, status: 'OPEN', clientId: client.id, department: 'Education', recruiterId: W.u.rec.id, tlId: W.u.tl.id, stlId: W.u.stl.id, bdeId: W.u.bde.id, openings: 2 } });
  L.made.requirements.push(req.id); W.req = req;
  const mkc = async (k, stage, extra, reqRow) => {
    const c = await P.candidate.create({ data: { name: `ZZTEST OC ${k}`, source: 'Direct', email: `oc.${k.toLowerCase()}.${L.stamp}@${L.OK}`, phone: `900000${String(Math.floor(Math.random() * 9000) + 1000)}`, ...(extra || {}) } });
    L.made.candidates.push(c.id);
    const a = await P.application.create({ data: { candidateId: c.id, requirementId: (reqRow || req).id, stage } });
    L.made.applications.push(a.id);
    return { c, a };
  };
  W.c1 = await mkc('Anita', 'SHARED_WITH_CLIENT', { phone: '9000071345' });
  W.c0 = await mkc('Early', 'RECRUITER_REVIEW', { phone: '9000071346' });
  W.cj = await mkc('Joined', 'JOINED', { phone: '9000071347' });
  const ic = await P.client.create({ data: { name: `ZZTEST OC Internal ${L.stamp}`, clientType: 'Internal', ownerDepartment: 'HR' } });
  L.made.clients.push(ic.id);
  const ir = await P.requirement.create({ data: { title: 'ZZTEST OC HR Exec', reqCode: `ZZOCI${L.stamp}`, status: 'OPEN', clientId: ic.id, internal: true, department: 'HR', openings: 1 } });
  L.made.requirements.push(ir.id);
  W.ci = await mkc('InternalHire', 'NEW', { phone: '9000071348' }, ir);
  W.empRow = await P.employee.findFirst({ where: { userId: W.u.emp.id } });
  return W;
}
async function cleanup() {
  const ids = [...L.made.users, ...L.made.employees, ...L.made.candidates, ...L.made.clients, ...L.made.requirements, ...L.made.applications];
  const out = {};
  const del = async (name, fn) => { try { out[name] = (await fn()).count; } catch (e) { out[name] = `ERR ${e.message.split('\n').pop().slice(0, 80)}`; } };
  const people = [...L.made.candidates, ...L.made.clients, ...L.made.employees];
  try {
    const ph = people.map(() => '?').join(',');
    if (people.length) {
      const t = await P.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name='Conversation'");
      if (t.length) { out.convmsg = await P.$executeRawUnsafe(`DELETE FROM "ConversationMessage" WHERE "personId" IN (${ph})`, ...people); out.conv = await P.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "personId" IN (${ph})`, ...people); }
    }
  } catch (e) { out.convErr = e.message.slice(0, 80); }
  await del('followups', () => P.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: L.made.applications } }, { candidateId: { in: L.made.candidates } }] } }));
  await del('cmsg', () => P.candidateMessage.deleteMany({ where: { candidateId: { in: L.made.candidates } } }));
  await del('stageev', () => P.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: L.made.applications } }, { candidateId: { in: L.made.candidates } }] } }));
  await del('apps', () => P.application.deleteMany({ where: { id: { in: L.made.applications } } }));
  await del('cands', () => P.candidate.deleteMany({ where: { id: { in: L.made.candidates } } }));
  await del('reqs', () => P.requirement.deleteMany({ where: { id: { in: L.made.requirements } } }));
  await del('clients', () => P.client.deleteMany({ where: { id: { in: L.made.clients } } }));
  await del('audit', () => P.auditLog.deleteMany({ where: { OR: [{ userId: { in: L.made.users } }, { entityId: { in: ids } }] } }));
  await del('notif', () => P.notification.deleteMany({ where: { OR: [{ userId: { in: L.made.users } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }));
  await del('emps', () => P.employee.deleteMany({ where: { id: { in: L.made.employees } } }));
  await del('users', () => P.user.deleteMany({ where: { id: { in: L.made.users } } }));
  return out;
}
module.exports = { build, cleanup, L };
