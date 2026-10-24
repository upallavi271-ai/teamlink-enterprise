// Fixture for the interview tell-them tests: every role + one job with a candidate ready to book. SANDBOX ONLY.
const L = require('./iv-lib');
const P = L.prisma;
async function build() {
  const W = { u: {} };
  const mk = async (k, data, emp) => { W.u[k] = await L.mkUser(k, data, emp); return W.u[k]; };
  await mk('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' });
  await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  await mk('tl', { role: 'TL', atsRole: 'TL', hrmsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
  await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { tl: W.u.tl.name });
  await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { tl: W.u.tl.name });
  await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', hrmsRole: 'EMPLOYEE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
  await mk('bdetl', { role: 'TL', atsRole: 'TL', hrmsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
  await mk('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR', atsDepartment: 'HR', atsScopeDepartments: 'HR' }, { department: 'HR' });
  const client = await P.client.create({ data: { name: `ZZTEST IV Client ${L.stamp}`, ownerDepartment: 'Education', bdeOwner: W.u.bde.name, clientType: 'Client', contactName: 'Mr IV Contact', contactEmail: `iv.contact.${L.stamp}@${L.OK}`, contactPhone: '9000000020' } });
  L.made.clients.push(client.id); W.client = client;
  const req = await P.requirement.create({ data: { title: 'ZZTEST IV Teacher', reqCode: `ZZIV${L.stamp}`, status: 'OPEN', clientId: client.id, department: 'Education', recruiterId: W.u.rec.id, tlId: W.u.tl.id, bdeId: W.u.bde.id, openings: 3 } });
  L.made.requirements.push(req.id); W.req = req;
  W.mkc = async (k, stage = 'CLIENT_SHORTLISTED', extra = {}, reqRow = null) => {
    const c = await P.candidate.create({ data: { name: `ZZTEST IV ${k}`, source: 'Direct', email: `iv.${k.toLowerCase()}.${L.stamp}@${L.OK}`, phone: `90000${String(Math.floor(Math.random() * 90000) + 10000)}`, ...extra } });
    L.made.candidates.push(c.id);
    const a = await P.application.create({ data: { candidateId: c.id, requirementId: (reqRow || req).id, stage } });
    L.made.applications.push(a.id);
    return { c, a };
  };
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
    const apps = L.made.applications;
    if (apps.length) {
      const t2 = await P.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE name='ScheduledMessage'");
      if (t2.length) out.sched = await P.$executeRawUnsafe(`DELETE FROM "ScheduledMessage" WHERE "applicationId" IN (${apps.map(() => '?').join(',')})`, ...apps);
    }
  } catch (e) { out.convErr = e.message.slice(0, 80); }
  await del('followups', () => P.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: L.made.applications } }, { candidateId: { in: L.made.candidates } }] } }));
  await del('cmsg', () => P.candidateMessage.deleteMany({ where: { candidateId: { in: L.made.candidates } } }));
  await del('stageev', () => P.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: L.made.applications } }, { candidateId: { in: L.made.candidates } }] } }));
  await del('ivev', () => P.interviewEvent.deleteMany({ where: { applicationId: { in: L.made.applications } } }));
  await del('panel', () => P.interviewPanelist.deleteMany({ where: { applicationId: { in: L.made.applications } } }));
  await del('apps', () => P.application.deleteMany({ where: { id: { in: L.made.applications } } }));
  await del('cands', () => P.candidate.deleteMany({ where: { id: { in: L.made.candidates } } }));
  await del('reqs', () => P.requirement.deleteMany({ where: { id: { in: L.made.requirements } } }));
  await del('clients', () => P.client.deleteMany({ where: { id: { in: L.made.clients } } }));
  await del('audit', () => P.auditLog.deleteMany({ where: { OR: [{ userId: { in: L.made.users } }, { entityId: { in: ids } }, { toValue: { contains: 'ZZTEST' } }] } }));
  await del('notif', () => P.notification.deleteMany({ where: { OR: [{ userId: { in: L.made.users } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }));
  await del('emps', () => P.employee.deleteMany({ where: { id: { in: L.made.employees } } }));
  await del('users', () => P.user.deleteMany({ where: { id: { in: L.made.users } } }));
  return out;
}
module.exports = { build, cleanup, L };
