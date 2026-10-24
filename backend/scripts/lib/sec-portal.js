// Item 5: client portal reviewer leak + outbound scrub safety net.
module.exports = async function secPortal({ check, call, mkUser, mint, made, prisma, RUN }) {
  console.log('\n--- 5: client / external portal answers ---');
  const ids = {};
  made.extra.push(async () => {
    if (ids.app) {
      await prisma.interviewFeedback.deleteMany({ where: { applicationId: ids.app } });
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: ids.app } }).catch(() => {});
      await prisma.interviewEvent.deleteMany({ where: { applicationId: ids.app } }).catch(() => {});
      await prisma.applicationFollowUp.deleteMany({ where: { applicationId: ids.app } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: ids.app } });
    }
    if (ids.cand) await prisma.candidate.deleteMany({ where: { id: ids.cand } });
    if (ids.req) await prisma.requirement.deleteMany({ where: { id: ids.req } });
    const cl = [ids.client, ids.other].filter(Boolean);
    if (cl.length) { await prisma.user.deleteMany({ where: { clientId: { in: cl } } }); await prisma.client.deleteMany({ where: { id: { in: cl } } }); }
  });
  const SENT = { panel: 'ZZSentinelPanelNote', email: `zz-sent-cand-${RUN}@example.test`, phone: '9000012345' };
  const client = await prisma.client.create({ data: { name: `ZZTEST Sec Client ${RUN}`, location: 'ZZ' } });
  ids.client = client.id;
  const other = await prisma.client.create({ data: { name: `ZZTEST Sec Other Client ${RUN}`, location: 'ZZ' } });
  ids.other = other.id;
  const staff = await mkUser('PStaff', { role: 'TL', atsRole: 'TL', atsAccess: true, atsDepartment: 'Educational' }, { designation: 'TL' });
  const reqm = await prisma.requirement.create({ data: { title: `ZZTEST Sec Job ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Educational', recruiterId: staff.u.id, tlId: staff.u.id, openings: 1 } });
  ids.req = reqm.id;
  const cand = await prisma.candidate.create({ data: { name: `ZZTEST Sec Cand ${RUN}`, email: SENT.email, phone: SENT.phone, currentSalary: '7L', expectedSalary: '9L', location: 'ZZ' } });
  ids.cand = cand.id;
  const app = await prisma.application.create({
    data: { candidateId: cand.id, requirementId: reqm.id, stage: 'INTERVIEW_SCHEDULED', interviewStatus: 'SCHEDULED', interviewAt: new Date(Date.now() + 86400000), offeredCtc: 998877 },
  });
  ids.app = app.id;
  await prisma.interviewFeedback.create({ data: { applicationId: app.id, kind: 'Internal', overall: SENT.panel, recommendation: 'Selected', technical: 5, communication: 4, submittedBy: 'ZZ' } });
  const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
  const mkClient = async (label, c) => {
    const email = `zz-sec-${label}-${RUN}@example.test`;
    const u = await prisma.user.create({ data: { ...base, name: `ZZTEST Sec ${label}`, email, username: email, role: 'CLIENT', atsRole: 'CLIENT', clientId: c.id, portalType: 'REVIEWER' } });
    made.users.push(u.id); return u;
  };
  const uClient = await mkClient('client', client);
  const uOther = await mkClient('otherclient', other);
  const tClient = await mint(uClient);
  const tOther = await mint(uOther);

  const leaks = (r) => [SENT.panel, SENT.email, SENT.phone, 'interviewScore', 'aiScore', '"panel"', '998877', 'internalFeedback'].filter((s) => String(r.text || '').includes(s));
  const r = await call('POST', `/api/ats/interviews/${app.id}/client-feedback`, tClient, { recommendation: 'Selected', overall: 'ZZTEST client says fine' });
  check('client feedback is accepted (200)', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  check('client feedback answer is the minimal {ok,id,status}', r.body && r.body.ok === true && r.body.id === app.id && Object.keys(r.body).sort().join() === 'id,ok,status', r.text.slice(0, 200));
  check('client feedback answer carries no panel note / score / candidate e-mail / phone / offered CTC', leaks(r).length === 0, leaks(r));
  const fb = await prisma.interviewFeedback.findFirst({ where: { applicationId: app.id, kind: 'Client' } });
  check('the client feedback was still saved as its own record', !!fb && fb.recommendation === 'Selected');
  const internal = await prisma.interviewFeedback.findFirst({ where: { applicationId: app.id, kind: 'Internal' } });
  check('the internal panel feedback was left alone', internal && internal.overall === SENT.panel);
  const ro = await call('POST', `/api/ats/interviews/${app.id}/client-feedback`, tOther, { recommendation: 'Selected', overall: 'ZZTEST other company' });
  check('another company client cannot post on this interview (403)', ro.status === 403 && leaks(ro).length === 0, ro.status);

  // staff still get the full row
  const ts = await mint(staff.u);
  const rs = await call('POST', `/api/ats/interviews/${app.id}/client-feedback`, ts, { recommendation: 'Selected', overall: 'ZZTEST staff on behalf' });
  check('staff answer is unchanged (still a full row, or a refusal by role)', rs.status !== 200 || (rs.body && rs.body.candidate), rs.status);

  // safety net: the scrubber removes the staff-only keys from any answer
  const EP = require('../../src/utils/externalPortalAuth');
  const scrubbed = EP.scrubOutbound({ ok: true, rows: [{ id: 1, panelNote: 'x', nested: { aiScore: 9, interviewScore: 4, keep: 'yes', internalNotes: 'n' } }] });
  check('outbound scrub strips staff-only keys at any depth and keeps the rest', JSON.stringify(scrubbed) === '{"ok":true,"rows":[{"id":1,"nested":{"keep":"yes"}}]}', scrubbed);

  // every external-portal WRITE route, called with the client token and empty body: no sentinel may come back
  const { listRoutes } = require('../lib/listRoutes');
  const routes = listRoutes().filter((x) => x.path.startsWith('/api') && !x.path.includes('<regex') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(x.method));
  const concrete = (p) => p.replace(/:[A-Za-z0-9_]+/g, app.id);
  const allowed = routes.filter((x) => EP.isAllowed('CLIENT', x.method, concrete(x.path)) && !/\/auth\/|\/public|\/notifications|view-as|offers\/.+release|\/agreement\/(token|emudhra)/.test(x.path));
  let bad = 0; let tried = 0;
  for (const rt of allowed) {
    // eslint-disable-next-line no-await-in-loop
    const x = await call(rt.method, concrete(rt.path), tClient, {});
    tried += 1;
    if (leaks(x).length) { bad += 1; console.log('  leak via', rt.method, rt.path, leaks(x)); }
  }
  check(`no external-portal write route (${tried} tried) answers a client with staff-only data`, bad === 0, bad);
  // reads that the portal calls
  for (const p of ['/api/portal/client/overview', '/api/job-portal/client']) {
    const x = await call('GET', p, tClient);
    check(`client GET ${p} carries no panel note / interview score`, ![SENT.panel, 'interviewScore', 'internalFeedback'].some((s) => String(x.text || '').includes(s)), x.status);
  }
};
