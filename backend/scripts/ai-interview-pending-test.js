#!/usr/bin/env node
// ---------------------------------------------------------------------------
// JOB PORTAL AI CALLING: "AI interview pending" (2026-10-30) - on a COPY of dev.db (deleted at the end).
//
//   cd backend && node scripts/ai-interview-pending-test.js
//
// 1. the Job Portal's AI interview status comes into the ATS application (utils/jobPortalBridge.js syncAiInterview):
//    started / completed + score / the deadline as an India-time day, never moving a result back
// 2. who may get the reminder call (calling/policy.js aiInterviewOwed + personVerdict)
// 3. the talk itself in English / Telugu / Hindi: what is said, "yes" / "no" / "call later", the summary
// 4. the purpose stays off the ATS AI Calling lists (scripts.PORTAL_PURPOSES)
// ---------------------------------------------------------------------------
const path = require('path'); const fs = require('fs');

const B = path.resolve(__dirname, '..');
const COPY = path.join(B, 'prisma', 'zz-ai-pending-test.db');
let pass = 0; let fail = 0;
const ok = (c, m, d) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m, d !== undefined ? JSON.stringify(d).slice(0, 500) : ''); } };
const istDay = (ms) => new Date(Date.now() + ms + 330 * 60000).toISOString().slice(0, 10);

(async () => {
  const { PrismaClient } = require(path.join(B, 'node_modules/@prisma/client'));
  const src = new PrismaClient(); try { fs.unlinkSync(COPY); } catch { /* */ }
  await src.$executeRawUnsafe(`VACUUM INTO '${COPY.split(path.sep).join('/')}'`); await src.$disconnect();
  process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`; process.env.TEST_MODE = '1'; process.env.AI_CALL_BRAIN = 'off';
  try {
    const prisma = require(path.join(B, 'src/db'));
    const S = require(path.join(B, 'src/calling/scripts'));
    const { Dialogue } = require(path.join(B, 'src/calling/dialogue'));
    const P = require(path.join(B, 'src/calling/policy'));
    const Bridge = require(path.join(B, 'src/utils/jobPortalBridge'));
    require(path.join(B, 'src/calling/schema'));

    // ---- 1. the sync --------------------------------------------------------------------------------------------------
    const app0 = await prisma.application.findFirst({ where: { candidate: { phone: { not: null } } }, include: { candidate: true, requirement: true } });
    await prisma.application.update({ where: { id: app0.id }, data: { source: 'TeamLink Job Portal', stage: 'NEW', aiInterviewStatus: 'Required', aiInterviewScore: null, aiInterviewDeadline: null } });
    const due = new Date(Date.now() + 2 * 86400000);
    let changed = await Bridge.syncAiInterview(app0.id, { status: 'in_progress', score: null, completedAt: null, dueAt: due.toISOString() });
    let a = await prisma.application.findUnique({ where: { id: app0.id } });
    ok(changed && a.aiInterviewStatus === 'Started' && a.aiInterviewDeadline === new Date(due.getTime() + 330 * 60000).toISOString().slice(0, 10), 'S1 started on the portal -> Started, the deadline as an India-time day', [a.aiInterviewStatus, a.aiInterviewDeadline]);
    changed = await Bridge.syncAiInterview(app0.id, { status: 'not_started', dueAt: due.toISOString() });
    ok(!changed, 'S2 nothing new -> nothing written');
    changed = await Bridge.syncAiInterview(app0.id, { status: 'completed', score: 71.6, completedAt: new Date().toISOString(), dueAt: due.toISOString() });
    a = await prisma.application.findUnique({ where: { id: app0.id } });
    ok(changed && a.aiInterviewStatus === 'Completed' && a.aiInterviewScore === 72, 'S3 completed on the portal -> Completed + the score', [a.aiInterviewStatus, a.aiInterviewScore]);
    changed = await Bridge.syncAiInterview(app0.id, { status: 'in_progress', dueAt: due.toISOString() });
    a = await prisma.application.findUnique({ where: { id: app0.id } });
    ok(!changed && a.aiInterviewStatus === 'Completed', 'S4 a result is never moved back to Started', a.aiInterviewStatus);
    await prisma.application.update({ where: { id: app0.id }, data: { aiInterviewStatus: 'Manual Review Requested', aiInterviewScore: null } });
    changed = await Bridge.syncAiInterview(app0.id, { status: 'completed', score: 40, dueAt: due.toISOString() });
    a = await prisma.application.findUnique({ where: { id: app0.id } });
    ok(!changed && a.aiInterviewStatus === 'Manual Review Requested', 'S5 a recruiter\'s manual review is kept', a.aiInterviewStatus);
    ok(await Bridge.syncAiInterview(app0.id, null) === false, 'S6 an older portal without AI interview data: nothing happens');
    const audit = await prisma.auditLog.findMany({ where: { entityId: app0.id, action: 'AI interview (Job Portal)' } });
    ok(audit.length === 2, 'S7 each status change is in the audit trail', audit.map((x) => x.toValue));

    // ---- 2. who may be called -----------------------------------------------------------------------------------------
    const base = { source: 'TeamLink Job Portal', stage: 'NEW', aiInterviewStatus: 'Required', aiInterviewScore: null, aiInterviewDeadline: istDay(86400000) };
    ok(P.aiInterviewOwed(base).ok && P.aiInterviewOwed(base).deadline === base.aiInterviewDeadline, 'P1 portal applicant, not taken, deadline ahead -> may be called');
    ok(P.aiInterviewOwed({ ...base, aiInterviewDeadline: istDay(0) }).ok, 'P2 the last day is today -> still called');
    ok(!P.aiInterviewOwed({ ...base, aiInterviewDeadline: istDay(-86400000) }).ok, 'P3 deadline passed -> not called (extend it first)');
    ok(!P.aiInterviewOwed({ ...base, source: 'Naukri' }).ok, 'P4 not a Job Portal applicant -> not called');
    ok(!P.aiInterviewOwed({ ...base, aiInterviewStatus: 'Completed' }).ok && !P.aiInterviewOwed({ ...base, aiInterviewScore: 55 }).ok, 'P5 already done (status or score) -> not called');
    ok(!P.aiInterviewOwed({ ...base, stage: 'SHARED_WITH_CLIENT' }).ok, 'P6 past the AI interview step -> not called');
    ok(P.aiInterviewOwed({ ...base, aiInterviewStatus: 'Started', aiInterviewDeadline: null }).ok, 'P7 started but not finished, no deadline -> called');

    const s = { mode: 'Test', testNumbers: [], dndService: true, consentApplied: true, shortlistStages: ['CLIENT_SHORTLISTED'] };
    const cand = { ...app0.candidate, phone: '9100654424', doNotContact: false, consentStatus: 'GIVEN', consentPurposes: 'recruitment' };
    const core = require(path.join(B, 'src/utils/messagingCore'));
    s.testNumbers = [core.normalizeMobile('9100654424').e164];
    const ctx = (app, extra = {}) => ({ candidate: cand, app, requirement: { ...app0.requirement, status: 'OPEN' }, purpose: 'AI Interview Pending', s, now: new Date(), ...extra });
    let v = await P.personVerdict(ctx(base));
    ok(v.ok && v.service, 'P8 the call rules allow it as a service call to a test number', v);
    v = await P.personVerdict(ctx({ ...base, aiInterviewStatus: 'Completed' }));
    ok(!v.ok && v.code === 'ai_interview' && /already done/.test(v.message || v.reason || JSON.stringify(v)), 'P9 already done -> refused with the reason', v);
    v = await P.personVerdict({ ...ctx(base), requirement: { ...app0.requirement, status: 'CLOSED' } });
    ok(!v.ok && v.code === 'job_closed', 'P10 a closed requirement -> refused', v);

    // ---- 3. the talk -----------------------------------------------------------------------------------------------------
    const data = S.buildData({ candidate: { name: 'Keerthi Rao' }, requirement: { title: 'Maths Faculty requirement', location: 'Kakinada' }, app: { aiInterviewDeadline: '2031-03-04' } });
    for (const lang of S.LANGS) {
      const Ph = S.phrases(lang);
      const d = new Dialogue({ purpose: 'AI Interview Pending', language: lang, data });
      d.start();
      const yes = { English: 'yes', Telugu: 'అవును', Hindi: 'हाँ' }[lang];
      let r = await d.hear(yes);
      ok(r.say.includes('Maths Faculty') && r.say.includes(Ph.aiHow) && r.say.endsWith(Ph.aiProceed) && /2031|4|٤|४|౪/.test(r.say), `T1 ${lang}: says the job, the last day, how to take it, then asks`, r.say);
      r = await d.hear(yes);
      const o = d.outcome();
      ok(r.done && o.outcome === 'Interested' && r.say.includes(Ph.aiYes) && /will take the AI interview/.test(o.summary), `T2 ${lang}: "yes" -> will take it, thanks + deadline line`, [o.outcome, o.summary, r.say]);
    }
    let d = new Dialogue({ purpose: 'AI Interview Pending', language: 'English', data });
    d.start(); await d.hear('yes'); let r = await d.hear('no I am not interested');
    ok(r.done && d.outcome().outcome === 'Not Interested', 'T3 "no" -> Not Interested', d.outcome());
    d = new Dialogue({ purpose: 'AI Interview Pending', language: 'English', data });
    d.start(); await d.hear('yes'); r = await d.hear('I am busy, call me later');
    ok(!r.done && d.st.step === 'later_when', 'T4 "call me later" -> asks when', [d.st.step, r.say]);
    d = new Dialogue({ purpose: 'AI Interview Pending', language: 'English', data: { ...data, aiDeadline: null } });
    d.start(); r = await d.hear('yes');
    ok(!/finish it by/.test(r.say), 'T5 no deadline on file -> no date is said', r.say);
    d = new Dialogue({ purpose: 'AI Interview Pending', language: 'English', data });
    d.start(); r = await d.hear('no, wrong number');
    ok(r.done && !/Maths/.test(r.say), 'T6 wrong person -> nothing about the job is said', r.say);

    // ---- 4. separate from ATS calling --------------------------------------------------------------------------------------
    ok(S.PORTAL_PURPOSES.includes('AI Interview Pending') && S.TRANSACTIONAL.has('AI Interview Pending'), 'X1 a Job Portal purpose, a service call');
    const shared = fs.readFileSync(path.join(B, '..', 'frontend/src/components/aicalling/aiCallingShared.js'), 'utf8');
    const atsList = shared.slice(shared.indexOf('export const PURPOSES'), shared.indexOf('];', shared.indexOf('export const PURPOSES')));
    ok(!atsList.includes('AI Interview Pending'), 'X2 not on the ATS AI Calling purpose list');
    ok(S.checkTemplates().length === 0, 'X3 no forbidden word in any line', S.checkTemplates());
  } catch (e) {
    fail += 1; console.log('FAIL crashed', e && e.stack);
  } finally {
    try { await require(path.join(B, 'src/db')).$disconnect(); } catch { /* */ }
    for (const f of [COPY, `${COPY}-journal`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
