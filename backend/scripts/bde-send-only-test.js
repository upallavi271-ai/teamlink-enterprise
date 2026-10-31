#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A BDE ONLY SENDS A REQUIREMENT (founder 2026-10-31: "bde ki just send cheyyadam antharey"). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/bde-send-only-test.js
//
// The BDE saves a requirement with team leads ticked: nothing is posted (even if sites are sent), the team lead hears
// "You got a new requirement", the BDE cannot post it anywhere, the team lead can.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('BSO');

const { prisma, check, RUN } = Z;

(async () => {
  await Z.preclean();
  try {
    // a real team lead of the sandbox copy (the TL picker leaves ZZTEST users out); the bell it gets is removed at the end
    const tl = await prisma.user.findFirst({ where: { atsAccess: true, status: 'Active', atsRole: 'TL', NOT: [{ name: { contains: 'ZZTEST' } }, { atsDepartment: 'BDE' }, { atsDepartment: null }] } });
    if (!tl) throw new Error('no team lead in the sandbox copy');
    const DEPT = tl.atsDepartment;
    const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, { department: 'BDE' });
    const tk = { bde: await Z.mint(bde), tl: await Z.mint(tl) };
    const c = await prisma.client.create({
      data: {
        name: `ZZTEST BSO Client ${RUN}`, industry: 'IT', location: 'Hyderabad', ownerDepartment: DEPT, bdeOwner: bde.name, clientType: 'Client',
        contactName: 'ZZ Contact', contactEmail: `zz-bso-${RUN}@example.test`, contactPhone: '9000000002', agreementStatus: 'ACTIVE', agreementFeePercent: 8.33,
      },
    });
    Z.made.clients.push(c.id);

    const rq = await Z.call('POST', '/api/requirements', tk.bde, {
      title: `ZZTEST BSO Java Developer ${RUN}`, clientId: c.id, department: DEPT, openings: 1, location: 'Hyderabad', salary: '6-9 LPA',
      jobDescription: 'Java, Spring Boot (ZZTEST BSO).', skills: 'Java, Spring Boot', experienceMin: 2, experienceMax: 5,
      tlId: tl.id, tlIds: [tl.id], postingSources: 'TeamLink Job Portal, TeamLink Website',
    });
    const id = rq.body && rq.body.id;
    if (id) Z.made.reqs.push(id);
    check('1 the BDE saves the requirement with a team lead ticked', rq.status < 300 && !!id, [rq.status, rq.body && rq.body.error]);
    const row = id && await prisma.requirement.findUnique({ where: { id } });
    check('2 nothing is set to post, even though sites were sent', row && row.postingSources === 'None' && row.tlId === tl.id, row && [row.postingSources, row.tlId]);

    const note = await prisma.notification.findFirst({ where: { userId: tl.id, title: { contains: 'You got a new requirement' } } });
    check('3 the team lead hears "You got a new requirement"', !!note, note && note.title);

    const stB = await Z.call('GET', `/api/job-publish/jobs/${id}/status`, tk.bde);
    const stT = await Z.call('GET', `/api/job-publish/jobs/${id}/status`, tk.tl);
    check('4 the posting window: BDE cannot post, the team lead can', stB.status === 200 && stB.body.canPost === false && stT.status === 200 && stT.body.canPost === true, [stB.status, stB.body && stB.body.canPost, stT.status, stT.body && stT.body.canPost]);

    const pubB = await Z.call('POST', `/api/job-publish/jobs/${id}/publish`, tk.bde, { portals: ['jobportal'], dryRun: true });
    check('5 the BDE is refused when trying to post', pubB.status === 403, [pubB.status, pubB.body && pubB.body.error]);

    const siteB = await Z.call('PUT', `/api/requirements/${id}/posting-sites`, tk.bde, { sites: ['jobportal'] });
    const siteT = await Z.call('PUT', `/api/requirements/${id}/posting-sites`, tk.tl, { sites: [] });
    check('6 ticking sites: BDE refused, team lead allowed', siteB.status === 403 && siteT.status !== 403, [siteB.status, siteT.status, siteT.body && siteT.body.error]);

    const edB = await Z.call('PUT', `/api/requirements/${id}`, tk.bde, { postingSources: 'TeamLink Job Portal' });
    const row2 = await prisma.requirement.findUnique({ where: { id } });
    check('7 the BDE editing the job cannot switch posting on', edB.status < 300 && row2.postingSources === 'None', [edB.status, edB.body && edB.body.error, row2.postingSources]);
  } catch (e) {
    console.log('TEST CRASHED', (e && e.stack) || e);
    Z.fail += 1;
  }
  try {
    await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'ZZTEST BSO' } }, { message: { contains: 'ZZTEST BSO' } }] } });
    console.log('cleanup left:', JSON.stringify(await Z.cleanup()));
  } catch (e) { console.log('cleanup problem', e.message); }
  await Z.finish();
})();
