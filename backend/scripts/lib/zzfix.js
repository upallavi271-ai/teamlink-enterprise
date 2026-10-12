// ---------------------------------------------------------------------------
// Shared helpers for the SANDBOX acceptance tests (pending-work-test.js, bde-client-access-test.js).
// Refuses to run against anything but the sandbox API/database (never 4010 / dev.db).
//   const Z = require('./lib/zzfix')('PW');   // tag used in names: "ZZTEST PW ..."
//   Z.prisma, Z.call(method, path, token, body), Z.check(name, ok, detail), Z.mint(user),
//   Z.mkUser(tag, userData, employeeData), Z.made (ids to clean), Z.finish()
// ---------------------------------------------------------------------------
const path = require('path');

module.exports = function zzfix(TAG) {
  const BACK = path.resolve(__dirname, '..', '..');
  const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
  if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) {
    console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.');
    process.exit(2);
  }
  const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
  process.env.DATABASE_URL = SBX;
  require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
  process.env.DATABASE_URL = SBX;
  process.env.TEST_MODE = '1';
  const realFetch = globalThis.fetch;
  const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
  const prisma = require(path.join(BACK, 'src/db'));
  const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
  const RUN = Date.now().toString(36);
  const Z = {
    BACK, API, RUN, prisma, TAG, pass: 0, fail: 0,
    made: { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [], extra: [] },
  };

  Z.check = (name, ok, detail) => {
    if (ok) Z.pass += 1; else Z.fail += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''}`);
  };
  Z.call = async (method, p, token, body, headers) => {
    const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(headers || {}) };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    for (let i = 0; ; i += 1) {
      try {
        const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(400000) });
        const buf = Buffer.from(await r.arrayBuffer());
        const text = buf.toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: r.status, body: json, text, buf, headers: r.headers };
      } catch (e) { if (i >= 120 || (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))) throw e; await new Promise((res) => setTimeout(res, 2000)); }
    }
  };
  Z.mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
  Z.identity = (u) => resolveIdentity(u.id);

  const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
  Z.mkUser = async (tag, extra, empExtra, name = null) => {
    const nm = name || `ZZTEST ${TAG} ${tag} ${RUN}`;
    const u = await prisma.user.create({ data: { ...base, name: nm, email: `zz-${TAG.toLowerCase()}-${tag}-${RUN}@example.test`, username: `zz-${TAG.toLowerCase()}-${tag}-${RUN}@example.test`, ...extra } });
    Z.made.users.push(u.id);
    if (empExtra) {
      const e = await prisma.employee.create({
        data: { employeeCode: `ZZTEST-${TAG}-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, email: u.email, ...empExtra },
      });
      Z.made.emps.push(e.id);
    }
    return u;
  };

  // Deletes everything the tests made (and what the app wrote because of it), then proves it.
  Z.cleanup = async (extraTitles = []) => {
    const m = Z.made;
    const userIds = m.users;
    const apiReqs = await prisma.requirement.findMany({ where: { title: { contains: `ZZTEST ${TAG}` } }, select: { id: true } });
    const reqIds = [...new Set([...m.reqs, ...apiReqs.map((r) => r.id)])];
    const apiClients = await prisma.client.findMany({ where: { name: { contains: `ZZTEST ${TAG}` } }, select: { id: true } });
    const clientIds = [...new Set([...m.clients, ...apiClients.map((c) => c.id)])];
    const apps = await prisma.application.findMany({ where: { OR: [{ id: { in: m.apps } }, { requirementId: { in: reqIds } }, { candidateId: { in: m.cands } }] }, select: { id: true } });
    const appIds = apps.map((a) => a.id);
    const allIds = [...userIds, ...m.cands, ...clientIds, ...reqIds, ...appIds, ...m.emps];
    const del = async (fn) => {
      try { await fn(); } catch (e) {
        if (!/does not exist|no such table/i.test(e.message)) console.log('  cleanup step failed:', String(e.message).replace(/s+/g, ' ').slice(-220));
      }
    };
    await del(() => prisma.applicationFollowUp.deleteMany({ where: { applicationId: { in: appIds } } }));
    await del(() => prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: appIds } } }));
    await del(() => prisma.interviewFeedback.deleteMany({ where: { applicationId: { in: appIds } } }));
    await del(() => prisma.interviewEvent.deleteMany({ where: { applicationId: { in: appIds } } }));
    await del(() => prisma.candidateMessage.deleteMany({ where: { OR: [{ candidateId: { in: m.cands } }, { senderUserId: { in: userIds } }] } }));
    await del(() => prisma.candidateNote.deleteMany({ where: { candidateId: { in: m.cands } } }));
    await del(() => prisma.application.deleteMany({ where: { id: { in: appIds } } }));
    await del(() => prisma.invoice.deleteMany({ where: { clientId: { in: clientIds } } }));
    await del(() => prisma.clientDocument.deleteMany({ where: { clientId: { in: clientIds } } }));
    await del(() => prisma.portalRequest.deleteMany({ where: { OR: [{ clientId: { in: clientIds } }, { requestedById: { in: userIds } }] } }));
    await del(() => prisma.approvalStep.deleteMany({ where: { OR: [{ recordId: { startsWith: 'ZZPW' } }, { approverUserId: { in: userIds } }] } }));
    await del(() => prisma.requirementPosting.deleteMany({ where: { requirementId: { in: reqIds } } }));
    await del(() => prisma.requirement.deleteMany({ where: { id: { in: reqIds } } }));
    await del(() => prisma.notification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }, { recipient: { contains: 'zz-' } }] } }));
    await del(() => prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: allIds } }, { reason: { contains: 'ZZTEST' } }, { toValue: { contains: 'ZZTEST' } }, { actorName: { contains: 'ZZTEST' } }] } }));
    await del(() => prisma.user.updateMany({ where: { clientId: { in: clientIds } }, data: { clientId: null } }));
    await del(() => prisma.user.deleteMany({ where: { clientId: { in: clientIds } } }));
    await del(() => prisma.candidate.deleteMany({ where: { id: { in: m.cands } } }));
    await del(() => prisma.client.deleteMany({ where: { id: { in: clientIds } } }));
    await del(() => prisma.positionAssignment.deleteMany({ where: { employeeId: { in: m.emps } } }));
    await del(() => prisma.employee.deleteMany({ where: { id: { in: m.emps } } }));
    await del(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));
    for (const t of extraTitles) await del(() => t(prisma)); // eslint-disable-line no-await-in-loop
    // The reminder engine's own small rows (today's "already sent", the escalation memory, snapshots of the fixture TLs).
    await del(() => prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'pwr.' } }, { key: { startsWith: 'eod.' } }, { key: 'pendingwork.settings' }] } }));
    const left = {
      users: await prisma.user.count({ where: { name: { contains: `ZZTEST ${TAG}` } } }),
      clients: await prisma.client.count({ where: { name: { contains: `ZZTEST ${TAG}` } } }),
      reqs: await prisma.requirement.count({ where: { title: { contains: `ZZTEST ${TAG}` } } }),
      cands: await prisma.candidate.count({ where: { name: { contains: `ZZTEST ${TAG}` } } }),
      notes: await prisma.notification.count({ where: { OR: [{ title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }),
      audit: await prisma.auditLog.count({ where: { OR: [{ reason: { contains: 'ZZTEST' } }, { actorName: { contains: 'ZZTEST' } }] } }),
    };
    return left;
  };
  // A previous run that crashed leaves its ZZTEST rows behind: take them first.
  Z.preclean = async () => {
    const users = await prisma.user.findMany({ where: { name: { contains: `ZZTEST ${TAG}` } }, select: { id: true } });
    const emps = await prisma.employee.findMany({ where: { OR: [{ userId: { in: users.map((u) => u.id) } }, { name: { contains: `ZZTEST ${TAG}` } }] }, select: { id: true } });
    const cands = await prisma.candidate.findMany({ where: { name: { contains: `ZZTEST ${TAG}` } }, select: { id: true } });
    Z.made.users.push(...users.map((u) => u.id)); Z.made.emps.push(...emps.map((e) => e.id)); Z.made.cands.push(...cands.map((c) => c.id));
    const left = await Z.cleanup();
    Z.made.users.length = 0; Z.made.emps.length = 0; Z.made.cands.length = 0; Z.made.clients.length = 0; Z.made.reqs.length = 0; Z.made.apps.length = 0;
    return left;
  };
  Z.finish = async () => {
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  };
  return Z;
};
