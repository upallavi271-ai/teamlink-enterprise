#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE WHOLE ATS WORKFLOW, ROLE BY ROLE, THROUGH THE REAL API (founder 2026-10-26: "complete ats lo workflow ekkada nunchi start ayyi,
// ekkada end avuthundhi ... sample client, recruiters, bde, tls, candidates theeskoni workflow mottham avuthundho ledho chudu. only testing").
// SANDBOX ONLY (a copy of the database); every ZZTEST row it makes is deleted at the end.
//
//   BDE adds client -> BDE adds requirement (parked: agreement not active) -> agreement: BDE -> HR -> BDE TL -> sent -> signed -> active
//   -> requirement opens -> TL takes it -> TL assigns recruiter -> recruiter adds candidate + applies -> recruiter -> TL review
//   -> TL -> BDE -> BDE shares with client -> client shortlists -> BDE books interview -> client + internal feedback -> TL selects
//   -> BDE records the client's offer letter -> recruiter shares it -> candidate accepts -> joining scheduled -> joined
//   -> invoice raised by itself -> accountant records the payment -> Paid.
//
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/ats-full-workflow-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('WFL');

const day = (d = 0) => { const t = new Date(Date.now() + d * 86400000 + 5.5 * 3600000); return t.toISOString().slice(0, 10); };
const ok2 = (r) => r && r.status >= 200 && r.status < 300;
const err = (r) => (r ? [r.status, (r.body && (r.body.error || r.body.code)) || r.text.slice(0, 200)] : 'no response');

(async () => {
  const { prisma, RUN } = Z;
  const AP_KEY = 'agreementWorkflow.approvers';
  const apBefore = await prisma.appSetting.findUnique({ where: { key: AP_KEY } });
  const ids = { client: null, req: null, cand: null, app: null, inv: null };
  const steps = [];
  const step = (who, what, okay, detail) => { steps.push({ who, what, okay }); Z.check(`[${who}] ${what}`, okay, detail); return okay; };
  try {
    const DEPT = 'IT'; // no real IT TL in the database, so nobody is auto-assigned
    const sa = await Z.mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
    const bdeTl = await Z.mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL', department: 'BDE' });
    const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, { tl: bdeTl.name, department: 'BDE' });
    const hr = await Z.mkUser('hr', { role: 'TL', atsRole: 'TL', atsDepartment: 'Internal HR', atsScopeDepartments: 'Internal HR' }, { designation: 'TL', department: 'Internal HR' });
    const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL', department: DEPT });
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT });
    const rec2 = await Z.mkUser('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: tl.name, department: DEPT });
    const acc = await Z.mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsAccess: true, accountsRole: 'ACCOUNTANT' });
    const hrEmp = await prisma.employee.findFirst({ where: { userId: hr.id } });
    const T = {};
    for (const [k, u] of Object.entries({ sa, bdeTl, bde, hr, tl, rec, rec2, acc })) T[k] = await Z.mint(u); // eslint-disable-line no-await-in-loop
    const C = (m, p, who, body) => Z.call(m, p, T[who], body);
    await C('PUT', '/api/agreement-flow/settings', 'sa', { approvers: [hrEmp.employeeCode] });

    // ---------- 1. CLIENT ----------
    const cl = await C('POST', '/api/clients', 'bde', {
      mode: 'create', name: `ZZTEST WFL Orbit Software ${RUN}`, industry: 'Information Technology', contactName: 'ZZ Ravi', contactEmail: `zz-wfl-client-${RUN}@example.test`,
      contactPhone: '9000000101', ownerDepartment: DEPT, bdeOwner: bde.name, agreementFeePercent: 8.33, paymentTerms: 'Invoice 6 days after joining; payment due within 6 days of invoice',
      guaranteePeriod: '90 Days', state: 'Telangana', city: 'Hyderabad', confirmSeparate: true,
    });
    ids.client = cl.body && (cl.body.id || (cl.body.client && cl.body.client.id));
    if (ids.client) Z.made.clients.push(ids.client);
    step('BDE', '1 adds the client (agreement starts as Draft)', ok2(cl) && !!ids.client && (cl.body.agreementStatus || 'DRAFT') === 'DRAFT', err(cl));
    if (!ids.client) throw new Error('no client - cannot go on');

    // ---------- 2. REQUIREMENT (parked until the agreement is active) ----------
    const tlTry = await C('POST', '/api/requirements', 'tl', { title: `ZZTEST WFL TL try ${RUN}`, clientId: ids.client, department: DEPT, jobDescription: 'x', skills: 'x' });
    step('TL', '2a cannot create a requirement (BDE team and above only)', tlTry.status === 403, err(tlTry));
    const rq = await C('POST', '/api/requirements', 'bde', {
      title: `ZZTEST WFL Java Developer ${RUN}`, clientId: ids.client, department: DEPT, openings: 2, location: 'Hyderabad', salary: '6-9 LPA',
      jobDescription: 'Java, Spring Boot, REST APIs (ZZTEST WFL).', skills: 'Java, Spring Boot, REST', experienceMin: 2, experienceMax: 5,
    });
    ids.req = rq.body && (rq.body.id || (rq.body.requirement && rq.body.requirement.id));
    if (ids.req) Z.made.reqs.push(ids.req);
    const rq0 = ids.req && await prisma.requirement.findUnique({ where: { id: ids.req } });
    step('BDE', '2b adds the requirement; it waits at Agreement Check (not live yet)', ok2(rq) && rq0 && rq0.status === 'AGREEMENT_CHECK', [err(rq), rq0 && rq0.status]);

    // ---------- 3. AGREEMENT ----------
    const a1 = await C('POST', `/api/agreement-flow/${ids.client}/action`, 'bde', { action: 'send_to_hr' });
    step('BDE', '3a sends the agreement to HR', ok2(a1) && a1.body.stage === 'WITH_HR', err(a1));
    const a2 = await C('PUT', `/api/agreement-flow/${ids.client}/sections`, 'hr', { legalName: `ZZTEST WFL Orbit Software Pvt Ltd ${RUN}`, gst: '36AABCT1234C1Z5', pan: 'AABCT1234C', invoiceEmail: 'zz-wfl-inv@example.test', paymentMethod: 'Bank transfer' });
    step('HR', '3b fills legal / tax / billing details', ok2(a2), err(a2));
    const a3 = await C('POST', `/api/agreement-flow/${ids.client}/action`, 'hr', { action: 'send_to_tl' });
    step('HR', '3c sends it to the BDE TL', ok2(a3) && a3.body.stage === 'WITH_TL', err(a3));
    const a4bad = await C('POST', `/api/clients/${ids.client}/agreement/send`, 'bde', {});
    step('BDE', '3d cannot send it to the client himself (BDE TL checks first)', !ok2(a4bad), err(a4bad));
    const a4 = await C('POST', `/api/clients/${ids.client}/agreement/send`, 'bdeTl', { verified: ['commercial', 'tax', 'payment', 'documents'] });
    let cr = await prisma.client.findUnique({ where: { id: ids.client } });
    step('BDE TL', '3e checks and sends the agreement to the client (Sent)', ok2(a4) && cr.agreementStatus === 'SENT', [err(a4), cr.agreementStatus]);
    const a5 = await C('POST', `/api/clients/${ids.client}/agreement/confirm`, 'sa', { signedCopyName: 'zz-wfl-signed.pdf', signedByName: 'ZZ Ravi' });
    cr = await prisma.client.findUnique({ where: { id: ids.client } });
    step('Super Admin', '3f records the client\'s signature (Signed)', ok2(a5) && ['SIGNED', 'ACTIVE'].includes(cr.agreementStatus), [err(a5), cr.agreementStatus]);
    if (cr.agreementStatus === 'SIGNED') {
      const tlAct = await C('POST', `/api/clients/${ids.client}/agreement/activate`, 'tl', {});
      step('TL', '3g cannot activate an agreement', !ok2(tlAct), err(tlAct));
      const a6 = await C('POST', `/api/clients/${ids.client}/agreement/activate`, 'bde', {});
      cr = await prisma.client.findUnique({ where: { id: ids.client } });
      step('BDE', '3h activates the agreement (Active)', ok2(a6) && cr.agreementStatus === 'ACTIVE', [err(a6), cr.agreementStatus]);
    }
    const rq1 = await prisma.requirement.findUnique({ where: { id: ids.req } });
    step('System', '3i the parked requirement opens by itself once the agreement is Active', rq1 && ['OPEN', 'RECRUITER_ASSIGNED'].includes(rq1.status), rq1 && rq1.status);

    // ---------- 4. TL + RECRUITER ----------
    const t1 = await C('POST', `/api/requirements/${ids.req}/assign`, 'tl', { tlId: tl.id });
    step('TL', '4a takes the requirement', ok2(t1), err(t1));
    const wl = await C('GET', `/api/requirements/assignable-people?recruiters=1&tlId=${tl.id}`, 'tl');
    const wlList = wl.body && Array.isArray(wl.body.groups) ? wl.body.groups.flatMap((g) => g.people || []) : ((wl.body && (wl.body.recruiters || wl.body.people || wl.body)) || []);
    // the workload picker never offers a test (ZZTEST / example.test) login - founder's rule 2026-09-29 - so it answers, without the test recruiters
    step('TL', '4b opens the recruiter workload list (test logins are never offered there)', ok2(wl) && Array.isArray(wlList) && !wlList.some((p) => p.id === rec.id), [wl.status, Array.isArray(wlList) ? wlList.length : typeof wlList]);
    const t2 = await C('POST', `/api/requirements/${ids.req}/assign`, 'tl', { recruiterId: rec.id, recruiterIds: [rec.id, rec2.id] });
    const rq2 = await prisma.requirement.findUnique({ where: { id: ids.req } });
    step('TL', '4c assigns recruiters (Recruiter Assigned)', ok2(t2) && rq2.status === 'RECRUITER_ASSIGNED' && rq2.tlId === tl.id, [err(t2), rq2.status, rq2.tlId === tl.id]);

    // ---------- 5. CANDIDATE + APPLICATION ----------
    const cd = await C('POST', '/api/candidates', 'rec', {
      name: `ZZTEST WFL Arjun ${RUN}`, phone: `9${String(Date.now()).slice(-9)}`, email: `zz-wfl-cand-${RUN}@example.test`, skills: 'Java, Spring Boot, REST',
      currentSalary: 600000, expectedSalary: 800000, totalExperience: 3, currentLocation: 'Hyderabad', source: 'Naukri', department: DEPT,
    });
    ids.cand = cd.body && (cd.body.id || (cd.body.candidate && cd.body.candidate.id));
    if (ids.cand) Z.made.cands.push(ids.cand);
    step('Recruiter', '5a adds the candidate', ok2(cd) && !!ids.cand, err(cd));
    let ap = await C('POST', '/api/applications', 'rec', { candidateId: ids.cand, requirementId: ids.req });
    if (ap.status === 409 && ap.body && ap.body.code === 'NEEDS_OVERRIDE') ap = await C('POST', '/api/applications', 'rec', { candidateId: ids.cand, requirementId: ids.req, overrideReason: 'ZZTEST WFL good fit' });
    ids.app = ap.body && (ap.body.id || (ap.body.application && ap.body.application.id));
    if (ids.app) Z.made.apps.push(ids.app);
    step('Recruiter', '5b applies the candidate to the requirement (stage New)', ok2(ap) && !!ids.app && (ap.body.stage || 'NEW') === 'NEW', err(ap));
    if (!ids.app) throw new Error('no application - cannot go on');
    const stage = async () => (await prisma.application.findUnique({ where: { id: ids.app } })).stage;
    const move = (who, s, extra = {}) => C('PATCH', `/api/applications/${ids.app}/stage`, who, { stage: s, comment: 'ZZTEST WFL', ...extra });

    // ---------- 6. INTERNAL REVIEW ----------
    const skip = await move('rec', 'SHARED_WITH_CLIENT');
    step('Recruiter', '6a cannot jump straight to the client', !ok2(skip), err(skip));
    const m1 = await move('rec', 'RECRUITER_REVIEW');
    const m2 = await move('rec', 'TL_REVIEW');
    step('Recruiter', '6b reviews and sends to the TL (TL Review)', ok2(m1) && ok2(m2) && await stage() === 'TL_REVIEW', [err(m1), err(m2)]);
    const recBde = await move('rec', 'WITH_BDE');
    step('Recruiter', '6c cannot send to the BDE (that is the TL\'s step)', !ok2(recBde), err(recBde));
    const m3 = await move('tl', 'WITH_BDE');
    step('TL', '6d approves and sends to the BDE (With BDE)', ok2(m3) && await stage() === 'WITH_BDE', err(m3));
    const m4 = await move('bde', 'SHARED_WITH_CLIENT');
    step('BDE', '6e shares the profile with the client', ok2(m4) && await stage() === 'SHARED_WITH_CLIENT', err(m4));

    // ---------- 7. CLIENT ----------
    const clientUser = await Z.mkUser('client', { role: 'CLIENT', atsRole: 'CLIENT', clientId: ids.client, portalType: 'REVIEWER', portalPerms: 'VIEW,AGREEMENT,REQUEST,DECIDE,INTERVIEW,FEEDBACK,OFFERS' });
    T.client = await Z.mint(clientUser);
    const pd = await C('GET', '/api/portal/client', 'client');
    step('Client', '7a opens the client portal', ok2(pd), err(pd));
    const sl = await C('POST', `/api/job-portal/client/applications/${ids.app}/decision`, 'client', { decision: 'SHORTLIST' });
    step('Client', '7b shortlists the candidate', ok2(sl) && await stage() === 'CLIENT_SHORTLISTED', [err(sl), await stage()]);

    // ---------- 8. INTERVIEW ----------
    const bookBody = { date: day(1), time: '11:00', mode: 'online', interviewer: 'ZZ Panel (client CTO)', meetingLink: 'https://meet.example.test/zz-wfl' };
    const recBook = await C('POST', `/api/ats/interviews/${ids.app}/book`, 'rec', bookBody);
    step('Recruiter', '8a cannot book the client interview (the BDE books it)', !ok2(recBook), err(recBook));
    const bk = await C('POST', `/api/ats/interviews/${ids.app}/book`, 'bde', bookBody);
    step('BDE', '8b books the interview (Interview Scheduled)', ok2(bk) && await stage() === 'INTERVIEW_SCHEDULED', err(bk));
    const invRows = (bk.body && bk.body.invites && bk.body.invites.rows) || [];
    step('BDE', '8b2 the invite goes to the client AND the candidate', invRows.some((x) => /Client/.test(x.role || '')) && invRows.some((x) => /Candidate/.test(x.role || '')), invRows.map((x) => x.role));
    const cf = await C('POST', `/api/ats/interviews/${ids.app}/client-feedback`, 'client', { overall: 'Strong Java, good communication (ZZTEST WFL)', recommendation: 'Selected', ratings: { technical: 4, communication: 4 } });
    step('Client', '8c gives interview feedback', ok2(cf), err(cf));
    const seen = await prisma.notification.findMany({ where: { userId: { in: [bde.id, bdeTl.id, rec.id, tl.id] }, title: { startsWith: 'Client feedback' } }, select: { userId: true } });
    const got = (u) => seen.some((n) => n.userId === u.id);
    step('System', "8c2 the client's feedback reaches the BDE, BDE TL, recruiter and TL", got(bde) && got(bdeTl) && got(rec) && got(tl), { bde: got(bde), bdeTl: got(bdeTl), rec: got(rec), tl: got(tl) });
    const tellC = await C('POST', `/api/candidates/${ids.cand}/contact`, 'rec', { method: 'Email', purpose: 'Interview feedback', subject: 'Interview feedback', body: 'Hi Arjun, the client liked your interview (ZZTEST WFL).', applicationId: ids.app });
    step('Recruiter', "8c3 sends the client's feedback to the candidate (kept in the candidate's messages)", tellC.status === 201, err(tellC));
    const fb = await C('POST', `/api/ats/interviews/${ids.app}/feedback`, 'rec', { feedback: 'Client liked him (ZZTEST WFL)', result: 'Selected', score: 8 });
    step('Recruiter', '8d records the interview feedback (Interview Completed)', ok2(fb) && await stage() === 'INTERVIEW_COMPLETED', [err(fb), await stage()]);
    const dc = await C('POST', `/api/ats/interviews/${ids.app}/decision`, 'tl', { decision: 'Selected' });
    step('TL', '8e marks the candidate Selected', ok2(dc) && await stage() === 'SELECTED', [err(dc), await stage()]);

    // ---------- 9. OFFER + JOINING ----------
    const direct = await move('rec', 'OFFER');
    step('Recruiter', '9a cannot skip the offer flow with a plain stage move', !ok2(direct), err(direct));
    const fd = new FormData();
    fd.append('note', 'Client emailed the offer letter (ZZTEST WFL)');
    fd.append('designation', 'Java Developer');
    fd.append('file', new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' }), 'zz-wfl-offer.pdf');
    const rl = await fetch(`${Z.API}/api/ats/offers/${ids.app}/client-release`, { method: 'POST', headers: { Authorization: `Bearer ${T.bde}` }, body: fd });
    const rlText = await rl.text();
    step('BDE', '9b records the client\'s offer letter', rl.status >= 200 && rl.status < 300, [rl.status, rlText.slice(0, 200)]);
    const sh = await C('POST', `/api/ats/offers/${ids.app}/share`, 'rec', { via: 'Link' });
    step('Recruiter', '9c shares the offer with the candidate (Offer)', ok2(sh) && await stage() === 'OFFER', [err(sh), await stage()]);
    let acp = await C('POST', `/api/ats/offers/${ids.app}/accept`, 'rec', {});
    if (acp.status === 409 && acp.body && acp.body.code === 'CTC_CONFIRM') acp = await C('POST', `/api/ats/offers/${ids.app}/accept`, 'rec', { confirmCtc: true });
    step('Recruiter', '9d records that the candidate accepted (Offer Accepted)', ok2(acp) && await stage() === 'OFFER_ACCEPTED', [err(acp), await stage()]);
    let js = await C('POST', `/api/ats/joining/${ids.app}/schedule`, 'rec', { joiningDate: day(0), offeredCtc: 800000 });
    if (js.status === 409 && js.body && js.body.code === 'CTC_CONFIRM') js = await C('POST', `/api/ats/joining/${ids.app}/schedule`, 'rec', { joiningDate: day(0), offeredCtc: 800000, confirmCtc: true });
    step('Recruiter', '9e schedules the joining', ok2(js), err(js));
    let jn = await C('POST', `/api/ats/joining/${ids.app}/joined`, 'rec', { joinedOn: day(0), offeredCtc: 800000 });
    if (jn.status === 409 && jn.body && jn.body.code === 'CTC_CONFIRM') jn = await C('POST', `/api/ats/joining/${ids.app}/joined`, 'rec', { joinedOn: day(0), offeredCtc: 800000, confirmCtc: true });
    step('Recruiter', '9f marks the candidate Joined', ok2(jn) && await stage() === 'JOINED', [err(jn), await stage()]);

    // ---------- 10. ACCOUNTS ----------
    const inv = await prisma.invoice.findFirst({ where: { clientId: ids.client } });
    ids.inv = inv && inv.id;
    const expectFee = Math.round(800000 * 0.0833);
    step('System', '10a the invoice is raised by itself on joining (8.33% of 8 LPA)', !!inv && Math.abs((inv.amount || inv.subtotal || 0) - expectFee) <= 2, inv ? { amount: inv.amount, subtotal: inv.subtotal, total: inv.total, status: inv.status } : 'no invoice');
    if (inv) {
      const li = await C('GET', `/api/invoices?clientId=${ids.client}`, 'acc');
      step('Accountant', '10b sees the invoice in Accounts', ok2(li) && JSON.stringify(li.body).includes(inv.id), err(li));
      const amt = require('../src/utils/accounts').invoiceOutstanding(inv); // eslint-disable-line global-require
      const pay = await C('POST', `/api/invoices/${inv.id}/payments`, 'acc', { amount: amt, date: day(0), method: 'Bank transfer', reference: 'ZZTEST WFL UTR' });
      const inv2 = await prisma.invoice.findUnique({ where: { id: inv.id } });
      step('Accountant', `10c records the full payment of Rs ${amt} (fee + GST - TDS) -> Paid`, ok2(pay) && inv2.status === 'Paid', [err(pay), inv2.status]);
      const recPay = await C('POST', `/api/invoices/${inv.id}/payments`, 'rec', { amount: 1, date: day(0) });
      step('Recruiter', '10d cannot touch invoices', !ok2(recPay), err(recPay));
    }

    // ---------- 11. HISTORY ----------
    const ev = await prisma.applicationStageEvent.count({ where: { applicationId: ids.app } });
    step('System', '11a every move is in the candidate\'s history', ev >= 10, ev);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    // ---------- summary ----------
    console.log('\nWORKFLOW SUMMARY');
    steps.forEach((s) => console.log(`  ${s.okay ? 'OK ' : 'XX '} ${s.who.padEnd(12)} ${s.what}`));
    // ---------- cleanup (rows zzfix does not know about first) ----------
    try {
      if (apBefore) await prisma.appSetting.update({ where: { key: AP_KEY }, data: { value: apBefore.value } });
      else await prisma.appSetting.deleteMany({ where: { key: AP_KEY } });
      const appIds = Z.made.apps;
      const inv = ids.client ? (await prisma.invoice.findMany({ where: { clientId: ids.client }, select: { id: true } })).map((i) => i.id) : [];
      const tryDel = async (fn) => { try { await fn(); } catch (e) { if (!/does not exist|no such table|Unknown/.test(e.message)) console.log('  cleanup:', String(e.message).slice(0, 140)); } };
      await tryDel(() => prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: inv } } }));
      await tryDel(() => prisma.invoiceAdjustment.deleteMany({ where: { invoiceId: { in: inv } } }));
      await tryDel(() => prisma.creditNote.deleteMany({ where: { invoiceId: { in: inv } } }));
      await tryDel(() => prisma.partnerPayout.deleteMany({ where: { applicationId: { in: appIds } } }));
      await tryDel(() => prisma.offerVersion.deleteMany({ where: { applicationId: { in: appIds } } }));
      await tryDel(() => prisma.interviewPanelist.deleteMany({ where: { applicationId: { in: appIds } } }));
      for (const a of appIds) await tryDel(() => prisma.$executeRawUnsafe('DELETE FROM "JoiningRecord" WHERE "applicationId" = ?', a)); // eslint-disable-line no-await-in-loop
      if (ids.client) await tryDel(() => prisma.appSetting.deleteMany({ where: { key: { contains: ids.client } } }));
      for (const a of appIds) await tryDel(() => prisma.appSetting.deleteMany({ where: { key: { contains: a } } })); // eslint-disable-line no-await-in-loop
      if (ids.req) await tryDel(() => prisma.appSetting.deleteMany({ where: { key: { contains: ids.req } } }));
      if (ids.cand) await tryDel(() => prisma.candidateNote.deleteMany({ where: { candidateId: ids.cand } }));
    } catch (e) { console.log('pre-cleanup problem', String(e.message).slice(0, 160)); }
    const left = await Z.cleanup().catch((e) => { console.log('cleanup problem', String(e.message).slice(0, 200)); return null; });
    console.log('left behind:', left);
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
