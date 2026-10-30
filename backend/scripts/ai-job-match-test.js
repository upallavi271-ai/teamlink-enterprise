#!/usr/bin/env node
// ---------------------------------------------------------------------------
// JOB PORTAL AI CALLING: "Job Match" (2026-10-30) - on a COPY of dev.db (deleted at the end).
//
//   cd backend && node scripts/ai-job-match-test.js
//
// 1. GET /api/job-portal/job-match: the Job Portal applicants who fit a live requirement, not already on it, best first,
//    only in the login's scope
// 2. the screen's two steps through the real routes: matching jobs of a person, then POST /applications (the normal Add)
// 3. who may get the call (policy: a Job Portal person, consent like screening - not a service call)
// 4. the talk in English / Telugu / Hindi: the job-match opening, then the screening questions; the summary
// ---------------------------------------------------------------------------
const path = require('path'); const fs = require('fs');

const B = path.resolve(__dirname, '..');
const COPY = path.join(B, 'prisma', 'zz-job-match-test.db');
let pass = 0; let fail = 0;
const ok = (c, m, d) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m, d !== undefined ? JSON.stringify(d).slice(0, 500) : ''); } };

(async () => {
  const { PrismaClient } = require(path.join(B, 'node_modules/@prisma/client'));
  const src = new PrismaClient(); try { fs.unlinkSync(COPY); } catch { /* */ }
  await src.$executeRawUnsafe(`VACUUM INTO '${COPY.split(path.sep).join('/')}'`); await src.$disconnect();
  require(path.join(B, 'node_modules/dotenv')).config({ path: path.join(B, '.env'), override: false });
  process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`; process.env.TEST_MODE = '1'; process.env.AI_CALL_BRAIN = 'off';
  let server;
  try {
    const prisma = require(path.join(B, 'src/db'));
    const S = require(path.join(B, 'src/calling/scripts'));
    const { Dialogue } = require(path.join(B, 'src/calling/dialogue'));
    const P = require(path.join(B, 'src/calling/policy'));
    const core = require(path.join(B, 'src/utils/messagingCore'));
    require(path.join(B, 'src/calling/schema'));
    const jwt = require(path.join(B, 'node_modules/jsonwebtoken'));
    const { resolveIdentity, tokenPayload } = require(path.join(B, 'src/utils/identity'));
    const express = require(path.join(B, 'node_modules/express'));
    const app = express();
    app.use(express.json());
    app.use('/api/job-portal', require(path.join(B, 'src/routes/jobPortal')));
    app.use('/api/applications', require(path.join(B, 'src/routes/applications')));
    app.use('/api/candidates', require(path.join(B, 'src/routes/candidates')));
    server = await new Promise((r) => { const s2 = app.listen(0, () => r(s2)); });
    const API = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, p, token, body) => {
      const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
      return { status: r.status, body: j, text: t.slice(0, 300) };
    };

    const RUN = Date.now().toString(36);
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const admin = await prisma.user.create({ data: { ...base, name: `ZZ JM admin ${RUN}`, email: `zz-jm-a-${RUN}@example.test`, username: `zz-jm-a-${RUN}@example.test`, role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' } });
    const T = jwt.sign(tokenPayload(await resolveIdentity(admin.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const client = await prisma.client.create({ data: { name: `ZZ JM Hospital ${RUN}`, location: 'Hyderabad', ownerDepartment: 'Medical', clientType: 'Client' } });
    const mkReq = (title, skills) => prisma.requirement.create({ data: { title: `${title} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', openings: 2, skills, experience: '1-5', location: 'Hyderabad', salary: '30 thousand', workMode: 'Work From Office', employmentType: 'Full Time' } });
    const reqA = await mkReq('ZZ Staff Nurse', 'Nursing, ICU');
    const reqB = await mkReq('ZZ ICU Nurse', 'Nursing, ICU');
    const mkCand = (n, extra = {}) => prisma.candidate.create({ data: { name: `ZZ JM ${n} ${RUN}`, email: `zz-jm-${n}-${RUN}@example.test`, phone: '9100654424', consentStatus: 'GIVEN', consentPurposes: 'Recruitment', skills: 'Nursing, ICU', experienceYears: 3, location: 'Hyderabad', ...extra } });
    const portalOne = await mkCand('portal');
    const atsOne = await mkCand('ats');
    const appA = await prisma.application.create({ data: { candidateId: portalOne.id, requirementId: reqA.id, stage: 'NEW', source: 'TeamLink Job Portal' } });
    await prisma.application.create({ data: { candidateId: atsOne.id, requirementId: reqA.id, stage: 'NEW', source: 'Naukri' } });

    // ---- 1. the list for a requirement -----------------------------------------------------------------------------
    let r = await call('GET', `/job-portal/job-match?requirementId=${reqB.id}`, T);
    const ids = ((r.body && r.body.rows) || []).map((x) => x.candidateId);
    ok(r.status === 200 && ids.includes(portalOne.id), 'L1 a Job Portal applicant who fits shows for the other requirement', r.body || r.text);
    ok(!ids.includes(atsOne.id), 'L2 a person who did not come from the Job Portal is not in the Job Portal list');
    const row = (r.body.rows || []).find((x) => x.candidateId === portalOne.id);
    ok(row && row.fit >= 50 && /ZZ Staff Nurse/.test(row.appliedFor), 'L3 the fit (50%+) and what they applied for are shown', row);
    r = await call('GET', `/job-portal/job-match?requirementId=${reqA.id}`, T);
    ok(r.status === 200 && !(r.body.rows || []).some((x) => x.candidateId === portalOne.id), 'L4 not offered for the requirement they are already on', r.body);
    await prisma.requirement.update({ where: { id: reqB.id }, data: { status: 'CLOSED' } });
    r = await call('GET', `/job-portal/job-match?requirementId=${reqB.id}`, T);
    ok(r.status === 404, 'L5 a closed requirement is refused', r.status);
    await prisma.requirement.update({ where: { id: reqB.id }, data: { status: 'OPEN' } });

    // ---- 2. the screen's steps: matching jobs of a person, then the normal Add ----------------------------------------
    r = await call('GET', `/candidates/${portalOne.id}/matching-requirements?limit=30`, T);
    ok(r.status === 200 && (r.body.rows || []).some((x) => x.id === reqB.id), 'M1 the person\'s matching jobs include the other requirement', r.body || r.text);
    r = await call('POST', '/applications', T, { candidateId: portalOne.id, requirementId: reqB.id, comment: 'Job match (Job Portal AI calling)' });
    const added = r.body && r.body.id;
    ok(r.status === 201 && added, 'M2 added to the requirement through the normal Add', r.body || r.text);
    r = await call('POST', '/applications', T, { candidateId: portalOne.id, requirementId: reqB.id });
    ok(r.status === 409, 'M3 a second add is refused as a duplicate', r.status);

    // ---- 3. who may be called -----------------------------------------------------------------------------------------
    const s = { mode: 'Test', testNumbers: [core.normalizeMobile('9100654424').e164], dndService: true, consentApplied: true, shortlistStages: [] };
    const newApp = await prisma.application.findUnique({ where: { id: added } });
    const ctx = (cand, a) => ({ candidate: cand, app: a, requirement: reqB, purpose: 'Job Match', s, now: new Date() });
    let v = await P.personVerdict(ctx(portalOne, newApp));
    ok(v.ok && v.service === false, 'C1 a Job Portal person may get the job-match call (not a service call)', v);
    const atsApp = await prisma.application.create({ data: { candidateId: atsOne.id, requirementId: reqB.id, stage: 'NEW', source: 'ATS Match' } });
    v = await P.personVerdict(ctx(atsOne, atsApp));
    ok(!v.ok && v.code === 'not_portal', 'C2 someone who never came through the Job Portal is refused', v);
    v = await P.personVerdict(ctx({ ...portalOne, consentStatus: null }, newApp));
    ok(!v.ok && v.code === 'no_consent', 'C3 no consent record -> refused like a screening call', v);
    v = await P.personVerdict({ ...ctx(portalOne, newApp), requirement: { ...reqB, status: 'CLOSED' } });
    ok(!v.ok && v.code === 'job_closed', 'C4 a closed requirement -> refused', v);

    // ---- 4. the talk ------------------------------------------------------------------------------------------------
    const data = S.buildData({ candidate: { name: 'Keerthi Rao' }, requirement: { title: 'ICU Nurse requirement', location: 'Hyderabad' }, app: {} });
    for (const lang of S.LANGS) {
      const Ph = S.phrases(lang);
      const yes = { English: 'yes', Telugu: 'అవును', Hindi: 'हाँ' }[lang];
      const d = new Dialogue({ purpose: 'Job Match', language: lang, data });
      d.start();
      await d.hear(yes); // identity
      const r1 = await d.hear(yes); // two minutes
      ok(r1.say.includes(S.fill(Ph.matchIntro, { job: 'ICU Nurse' })), `T1 ${lang}: the job-match opening line`, r1.say);
      const r2 = await d.hear(yes);
      ok(r2.say.includes(Ph.interestQ) && /Hyderabad/.test(r2.say), `T2 ${lang}: the job brief, then the interest question`, r2.say);
    }
    let d = new Dialogue({ purpose: 'Job Match', language: 'English', data });
    d.start(); await d.hear('yes'); await d.hear('yes'); await d.hear('yes'); await d.hear('yes');
    await d.hear('3 years'); await d.hear('Hyderabad'); await d.hear('one month'); const last = await d.hear('yes');
    const o = d.outcome();
    ok(last.done && o.outcome === 'Interested' && o.answers.experienceYears === 3, 'T3 the whole talk -> Interested, with the answers', [o.outcome, o.answers]);
    d = new Dialogue({ purpose: 'Job Match', language: 'English', data });
    d.start(); await d.hear('yes'); await d.hear('yes'); await d.hear('yes'); r = await d.hear('no not interested');
    ok(d.outcome().outcome === 'Not Interested' || d.st.step === 'why_not', 'T4 "not interested" is taken as no', [d.st.step, d.outcome().outcome]);
    ok(S.PORTAL_PURPOSES.includes('Job Match') && !S.TRANSACTIONAL.has('Job Match') && S.checkTemplates().length === 0, 'X1 a Job Portal purpose, not a service call, no forbidden word');
  } catch (e) {
    fail += 1; console.log('FAIL crashed', e && e.stack);
  } finally {
    if (server) server.close();
    try { await require(path.join(B, 'src/db')).$disconnect(); } catch { /* */ }
    for (const f of [COPY, `${COPY}-journal`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
