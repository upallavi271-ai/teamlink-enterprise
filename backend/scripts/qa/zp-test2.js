// SANDBOX: a board that gets a connection later flips from "post by hand" to "goes out by itself" and uses the connector (+ Retry).
const path = require('path');
const { prisma, call, check, fails, sleep } = require('./zp-lib');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
(async () => {
  const tag = Date.now().toString(36);
  const made = { users: [], reqs: [], clients: [] };
  let before;
  try {
    const bde = await prisma.user.create({ data: { name: `Zpt Poster2 ${tag}`, email: `zpt-p2-${tag}@zpt.invalid`, passwordHash: 'x', status: 'Active', atsAccess: true, role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'Medical' } });
    made.users.push(bde.id);
    const client = await prisma.client.create({ data: { name: `ZZTEST Client ${tag}`, status: 'Active', agreementStatus: 'ACTIVE', ownerDepartment: 'Medical' } });
    made.clients.push(client.id);
    const job = await prisma.requirement.create({ data: { title: `ZZTEST Job ${tag}`, clientId: client.id, department: 'Medical', status: 'DRAFT', bdeId: bde.id, reqCode: `ZZT-${tag}`, postingSources: 'TeamLink Job Portal, TeamLink Website, Naukri' } });
    made.reqs.push(job.id);
    await call(bde.id, 'POST', `/requirements/${job.id}/activate`, {});
    await sleep(2500);
    let ps = await call(bde.id, 'GET', `/requirements/${job.id}/posting-sites`);
    check('Not connected: waiting for you (by hand)', ps.data.sites.find((s) => s.id === 'naukri').code === 'WAITING_BY_HAND');
    // connect Naukri (Amplify details saved)
    before = await prisma.integration.findUnique({ where: { id: 'naukri' } });
    const { writeValues } = require(path.join(BACK, 'src/utils/integrationStore'));
    const w = await writeValues('naukri', { 'Job endpoint URL': 'https://amplify.example.invalid/jobs', 'API key': 'zpt-key-123', 'Secret key': 'zpt-secret-123' });
    await prisma.integration.upsert({ where: { id: 'naukri' }, create: { id: 'naukri', values: JSON.stringify(w.values), connected: true, enabled: true }, update: { values: JSON.stringify(w.values), connected: true, enabled: true } });
    const pc = await call(bde.id, 'GET', '/requirements/posting-sources');
    const n = pc.data.sources.find((s) => s.id === 'naukri');
    check('Connected: the row says it goes out by itself', n.mode === 'auto' && /by itself/.test(n.line), n.line);
    ps = await call(bde.id, 'GET', `/requirements/${job.id}/posting-sites`);
    const row = ps.data.sites.find((s) => s.id === 'naukri');
    check('Old waiting row is no longer a hand task; Retry is offered', row.code !== 'WAITING_BY_HAND' && row.canRetry, { code: row.code, canRetry: row.canRetry });
    const rt = await call(bde.id, 'POST', `/requirements/${job.id}/posting-sites/naukri/retry`, {});
    const after = rt.data.sites.find((s) => s.id === 'naukri');
    check('Retry goes through the connector (sandbox blocks the call: Failed, never Posted, never hand)', rt.status === 200 && after.code === 'FAILED', { code: after.code, reason: after.reason });
    const sweep = await require(path.join(BACK, 'src/utils/jobBoards/manual')).sweep();
    console.log('  sweep', JSON.stringify(sweep));
  } catch (e) { console.error('TEST ERROR', e); process.exitCode = 1; } finally {
    await prisma.integration.update({ where: { id: 'naukri' }, data: { values: before ? before.values : null, connected: before ? before.connected : false, enabled: before ? before.enabled : false } }).catch(() => {});
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'posting.handReminded.' } } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { title: { contains: `ZZT-${tag}` } }] } });
    await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: made.reqs } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: made.reqs } }] } });
    await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
    await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
    await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    console.log(`\nfailures: ${fails()}`);
    await prisma.$disconnect();
  }
})();
