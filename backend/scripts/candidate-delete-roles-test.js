#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ARCHIVE FOR RECRUITERS, DELETE (WRONG ENTRY) FOR TLs (founder 2026-10-31: "tl ki delete option ivvu, recruiter ki archive option ivvu").
// SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/candidate-delete-roles-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('CDR');

const { check, RUN } = Z;

(async () => {
  await Z.preclean();
  try {
    const DEPT = 'IT';
    const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL', department: DEPT });
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT });
    const tk = { tl: await Z.mint(tl), rec: await Z.mint(rec) };
    const add = async (n) => {
      const r = await Z.call('POST', '/api/candidates', tk.rec, {
        name: `ZZTEST CDR ${n} ${RUN}`, phone: `9${String(Date.now()).slice(-9)}`, email: `zz-cdr-${n}-${RUN}@example.test`, skills: 'Java',
        currentSalary: 400000, expectedSalary: 500000, totalExperience: 2, currentLocation: 'Hyderabad', source: 'Naukri', department: DEPT,
      });
      const id = r.body && (r.body.id || (r.body.candidate && r.body.candidate.id));
      if (id) Z.made.cands.push(id);
      return { r, id };
    };
    const a = await add('A');
    check('0 the recruiter adds a person', !!a.id, [a.r.status, a.r.body && a.r.body.error]);
    // a TL sees the people on their team's requirements: put this one on a requirement the TL leads (still at New, no work on it)
    const { prisma } = Z;
    const cl = await prisma.client.create({ data: { name: `ZZTEST CDR Client ${RUN}`, industry: 'IT', location: 'Hyderabad', ownerDepartment: DEPT, clientType: 'Client', agreementStatus: 'ACTIVE' } });
    Z.made.clients.push(cl.id);
    const rq = await prisma.requirement.create({ data: { title: `ZZTEST CDR Job ${RUN}`, clientId: cl.id, department: DEPT, status: 'OPEN', tlId: tl.id, tl: tl.name, recruiterId: rec.id } });
    Z.made.reqs.push(rq.id);
    await prisma.application.create({ data: { candidateId: a.id, requirementId: rq.id, stage: 'NEW' } });
    const arc = await Z.call('POST', `/api/candidates/${a.id}/archive`, tk.rec, { reason: 'ZZTEST CDR test' });
    check('1 a recruiter can archive', arc.status === 200, [arc.status, arc.body]);
    const back = await Z.call('POST', `/api/candidates/${a.id}/unarchive`, tk.rec, {});
    check('2 a recruiter can bring them back', back.status === 200, [back.status, back.body]);
    const recDel = await Z.call('DELETE', `/api/candidates/${a.id}`, tk.rec, { reason: 'Wrong entry', confirmName: `ZZTEST CDR A ${RUN}` });
    check('3 a recruiter cannot delete (Archive only)', recDel.status === 403, [recDel.status, recDel.body]);
    const why = await Z.call('DELETE', `/api/candidates/${a.id}`, tk.tl, { reason: 'Not needed', confirmName: `ZZTEST CDR A ${RUN}` });
    check('4 delete is still only for a duplicate or a wrong entry', why.status === 400, [why.status, why.body]);
    const tlDel = await Z.call('DELETE', `/api/candidates/${a.id}`, tk.tl, { reason: 'Wrong entry', confirmName: `ZZTEST CDR A ${RUN}` });
    check('5 the TL deletes a wrong entry in their area', tlDel.status === 200 && tlDel.body.deleted === a.id, [tlDel.status, tlDel.body]);
  } catch (e) {
    console.log('TEST CRASHED', (e && e.stack) || e);
    Z.fail += 1;
  }
  try { console.log('cleanup left:', JSON.stringify(await Z.cleanup())); } catch (e) { console.log('cleanup problem', e.message); }
  await Z.finish();
})();
