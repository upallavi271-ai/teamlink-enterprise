#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE APPLICANT'S STAGE GOES TO THE JOB PORTAL RIGHT AWAY (founder 2026-11-10: "stage maaragane portal lo kuda ventane maarali").
// SANDBOX ONLY. The portal is never called: pushStagesNow gets a stand-in for the portal's two calls.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/portal-stage-push-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('PSTG');
const path = require('path');

(async () => {
  try {
    const { prisma } = Z;
    const B = require(path.join(Z.BACK, 'src/utils/jobPortalBridge'));
    const client = await prisma.client.create({ data: { name: `ZZTEST PSTG Client ${Z.RUN}` } });
    Z.made.clients.push(client.id);
    const req = await prisma.requirement.create({ data: { title: `ZZTEST PSTG Staff Nurse ${Z.RUN}`, clientId: client.id, status: 'OPEN' } });
    Z.made.reqs.push(req.id);
    const mk = async (s, stage, extra = {}) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST PSTG ${s} ${Z.RUN}`, email: `zz-pstg-${s}-${Z.RUN}@example.test` } });
      Z.made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage, source: 'TeamLink Job Portal', ...extra } });
      Z.made.apps.push(a.id);
      return { c, a };
    };
    const anu = await mk('anu', 'CLIENT_SHORTLISTED');
    const bala = await mk('bala', 'RECRUITER_REVIEW', { portalImportedAt: new Date() });
    const chitra = await mk('chitra', 'REJECTED');
    const item = (x, id, stage) => ({ application: { id, stage }, candidate: { name: x.c.name, email: x.c.email }, requirementId: req.id });
    const portalSays = [item(anu, 'pa-anu', 'applied'), item(bala, 'pa-bala', 'applied'), item(chitra, 'pa-chitra', 'rejected')];
    const calls = [];
    const fetchFn = async (p, opts = {}) => {
      calls.push({ p, opts });
      if (p.startsWith('/integrations/teamlink/applications?')) return { applications: portalSays };
      if (p === '/integrations/teamlink/applications/stages') return { results: opts.body.updates.map((u) => ({ id: u.id, changed: true })) };
      throw new Error(`unexpected portal call ${p}`);
    };
    const out = await B.pushStagesNow({ fetchFn });
    const post = calls.find((c) => c.p === '/integrations/teamlink/applications/stages');
    const ups = post ? post.opts.body.updates : [];
    const of = (id) => (ups.find((u) => u.id === id) || {}).stage;
    Z.check('1 the run reads the portal and sends the stages back', out.ok && out.pulled === 3 && !!post, [out, calls.map((c) => c.p)]);
    Z.check('2 client shortlisted in the ATS -> "client_review" on the portal', of('pa-anu') === 'client_review', ups);
    Z.check('3 sent to the ATS by a recruiter -> "shortlisted" on the portal', of('pa-bala') === 'shortlisted', ups);
    Z.check('4 a stage the portal already shows is not sent again', of('pa-chitra') === undefined, ups);
    Z.check('5 no second candidate or application was made', (await prisma.application.count({ where: { requirementId: req.id } })) === 3);
    Z.check('6 a stage change asks for the push only where the portal is reachable (off in the sandbox)', B.pushStagesSoon() === false);
  } catch (err) {
    Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err);
  } finally {
    await Z.cleanup().catch((err) => console.log('cleanup problem', String(err.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
