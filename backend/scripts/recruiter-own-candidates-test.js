#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A RECRUITER SEES ONLY THEIR OWN CANDIDATES (founder 2026-10-26: "ey req ki related candidate, ahh req assign ayyi vunna recruiters
// portal lo, ahh respective tl portal lo visible avvali. oka recruiter daggara vunna candidates inkokari dhaanlo kanipinchakudadhu").
// SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/recruiter-own-candidates-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('ROC');

(async () => {
  const { prisma, RUN } = Z;
  try {
    const DEPT = 'IT';
    const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL', department: DEPT });
    const recA = await Z.mkUser('reca', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT });
    const recB = await Z.mkUser('recb', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT });
    const T = { tl: await Z.mint(tl), a: await Z.mint(recA), b: await Z.mint(recB) };
    const client = await prisma.client.create({ data: { name: `ZZTEST ROC Client ${RUN}`, agreementStatus: 'ACTIVE', ownerDepartment: DEPT, industry: 'IT' } });
    Z.made.clients.push(client.id);
    const req = await prisma.requirement.create({ data: { title: `ZZTEST ROC Java ${RUN}`, clientId: client.id, department: DEPT, status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: recA.id, recruiterIds: `${recA.id},${recB.id}`, openings: 2, reqCode: `ZZROC${RUN}`.slice(0, 20) } });
    Z.made.reqs.push(req.id);
    const mkCand = async (tag) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST ROC ${tag} ${RUN}`, email: `zz-roc-${tag}-${RUN}@example.test`, phone: `8${String(Date.now()).slice(-8)}${tag.length}`, skills: 'Java', currentSalary: '500000', expectedSalary: '700000', source: 'Naukri' } });
      Z.made.cands.push(c.id); return c;
    };
    const cA = await mkCand('a'); const cB = await mkCand('b'); const cP = await mkCand('portal');
    const apA = await Z.call('POST', '/api/applications', T.a, { candidateId: cA.id, requirementId: req.id });
    const apB = await Z.call('POST', '/api/applications', T.b, { candidateId: cB.id, requirementId: req.id });
    const idA = apA.body && apA.body.id; const idB = apB.body && apB.body.id;
    if (idA) Z.made.apps.push(idA); if (idB) Z.made.apps.push(idB);
    // a job-portal / job-board application: made without a recruiter, like the portal intake does
    const portal = await prisma.application.create({ data: { candidateId: cP.id, requirementId: req.id, stage: 'NEW', source: 'TeamLink Job Portal', firstSource: 'Naukri' } });
    Z.made.apps.push(portal.id);
    const own = async (id) => (await prisma.application.findUnique({ where: { id } })).ownerRecruiterId;
    Z.check('O1 each recruiter\'s added candidate is theirs', apA.status === 201 && apB.status === 201 && await own(idA) === recA.id && await own(idB) === recB.id, [apA.status, apB.status]);

    const seesApp = async (who, id) => { const r = await Z.call('GET', `/api/applications?requirementId=${req.id}`, T[who]); const rows = Array.isArray(r.body) ? r.body : ((r.body && (r.body.rows || r.body.applications)) || []); return r.status === 200 && rows.some((x) => x.id === id); };
    const seesCand = async (who, id) => (await Z.call('GET', `/api/candidates/${id}`, T[who])).status === 200;
    Z.check('O2 recruiter B cannot open recruiter A\'s application or candidate', !(await seesApp('b', idA)) && !(await seesCand('b', cA.id)), { app: await seesApp('b', idA), cand: await seesCand('b', cA.id) });
    Z.check('O3 recruiter A cannot open recruiter B\'s', !(await seesApp('a', idB)) && !(await seesCand('a', cB.id)), { app: await seesApp('a', idB), cand: await seesCand('a', cB.id) });
    Z.check('O4 each sees their own', await seesApp('a', idA) && await seesApp('b', idB) && await seesCand('a', cA.id), null);
    Z.check('O5 the TL of the requirement sees both', await seesApp('tl', idA) && await seesApp('tl', idB) && await seesCand('tl', cA.id) && await seesCand('tl', cB.id), null);
    const listB = await Z.call('GET', `/api/candidates?q=ZZTEST%20ROC&limit=50`, T.b);
    const txt = listB.text || '';
    Z.check('O6 recruiter B\'s candidate list does not carry A\'s candidate', listB.status === 200 && !txt.includes(cA.id) && txt.includes(cB.id), [listB.status, txt.includes(cA.id), txt.includes(cB.id)]);

    Z.check('O7 a portal / job-board application goes straight to the requirement recruiter (A, the main one)', await own(portal.id) === recA.id, await own(portal.id));

    Z.check('O8 nobody else sees it: not recruiter B; the TL does', await seesApp('a', portal.id) && !(await seesApp('b', portal.id)) && await seesApp('tl', portal.id), { a: await seesApp('a', portal.id), b: await seesApp('b', portal.id), tl: await seesApp('tl', portal.id) });

    const as = await Z.call('POST', `/api/requirements/${req.id}/assign`, T.tl, { recruiterId: recB.id, recruiterIds: [recB.id] });
    Z.check('O9 recruiter A taken off the job: A candidates (and the portal one) go to the recruiter on it now (B); A no longer sees them', as.status === 200 && await own(idA) === recB.id && await own(portal.id) === recB.id && await seesApp('b', idA) && !(await seesApp('a', idA)), [as.status, (as.body && as.body.error) || '', await own(idA), await own(portal.id)]);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
