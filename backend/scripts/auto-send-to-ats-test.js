// ---------------------------------------------------------------------------
// utils/autoSendToAts.js - the 65% rule (AI interview AND resume both >= 65% -> into the ATS, Shortlisted, by itself).
// Runs on a COPY of the database (VACUUM INTO a temp file - the real one is only read) with the Job Portal call replaced by a
// stand-in that records what would be sent.
//   node scripts/auto-send-to-ats-test.js
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-auto-'));
  const copy = path.join(tmp, 'copy.db').replace(/\\/g, '/');
  const real = new PrismaClient();
  await real.$executeRawUnsafe(`VACUUM INTO '${copy}'`);
  await real.$disconnect();
  process.env.DATABASE_URL = `file:${copy}`;
  process.env.MAILBOX_SEATS_HOOK = '0';

  const sent = [];
  const realBridge = require('../src/utils/jobPortalBridge');
  stub('../src/utils/jobPortalBridge', { ...realBridge, portalFetch: async (p, o) => { sent.push({ p, body: o && o.body }); return { results: [] }; } });
  stub('../src/utils/notify', { notifyUsers: async () => null });
  const prisma = require('../src/db');
  const A = require('../src/utils/autoSendToAts');
  try {
    const req = await prisma.requirement.findFirst({ where: { status: 'OPEN', internal: false }, select: { id: true, title: true } });
    const stamp = Date.now();
    const mk = async (n, data, candExtra = {}) => {
      const cand = await prisma.candidate.create({ data: { name: `ZZ Auto ${n}`, email: `zz.auto.${n}.${stamp}@example.invalid`, phone: `7${String(stamp).slice(-7)}${n}${n}`, source: 'Job Portal', ...candExtra } });
      return prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'AI_INTERVIEW_COMPLETED', source: 'TeamLink Job Portal', aiInterviewStatus: 'Completed', ...data } });
    };
    const good = await mk(1, { aiInterviewScore: 80, resumeScore: 70 });
    let r = await A.check(good.id, { portalAppId: 'pa_1' });
    let g = await prisma.application.findUnique({ where: { id: good.id } });
    ok('AI 80% + resume 70%: sent to the ATS by itself', r.sent === true && !!g.portalImportedAt, r.why);
    ok('...at Shortlisted ("Approved by recruiter")', g.stage === 'RECRUITER_APPROVED');
    const ev = await prisma.applicationStageEvent.findMany({ where: { applicationId: good.id }, orderBy: { createdAt: 'asc' } });
    ok('...with the duplicate check and the reason on its history', ev.some((e) => /Duplicate check/i.test(e.action)) && ev.some((e) => /Sent to ATS — automatically/.test(e.action) && /80% and resume 70%/.test(e.comment || '')), ev.map((e) => e.action).join(' | '));
    ok('...and the Job Portal told: Shortlisted + "Pushed to ATS" (auto_screening)', sent.length === 1 && sent[0].body.updates[0].id === 'pa_1' && sent[0].body.updates[0].stage === 'shortlisted' && sent[0].body.updates[0].pushed.via === 'auto_screening');
    r = await A.check(good.id, { portalAppId: 'pa_1' });
    ok('a second check moves nothing (already in the ATS)', r.sent === false && sent.length === 1);

    const lowAi = await mk(2, { aiInterviewScore: 60, resumeScore: 90 });
    r = await A.check(lowAi.id);
    g = await prisma.application.findUnique({ where: { id: lowAi.id } });
    ok('AI 60%: stays in the screening for the recruiter', r.sent === false && !g.portalImportedAt && g.stage === 'AI_INTERVIEW_COMPLETED', r.why);
    const lowResume = await mk(3, { aiInterviewScore: 90, resumeScore: 50 });
    r = await A.check(lowResume.id);
    ok('resume 50%: stays in the screening', r.sent === false && /resume 50%/.test(r.why), r.why);
    const edge = await mk(4, { aiInterviewScore: 65, resumeScore: 65 });
    r = await A.check(edge.id);
    ok('exactly 65% and 65%: goes (65 or more)', r.sent === true, r.why);
    const notDone = await mk(5, { aiInterviewStatus: 'Started', aiInterviewScore: null, resumeScore: 90 });
    r = await A.check(notDone.id);
    ok('AI interview not finished: waits', r.sent === false && /not finished/.test(r.why));
    const unscored = await mk(6, { aiInterviewScore: 85, resumeScore: null }, { resumeScore: 77 });
    r = await A.check(unscored.id);
    g = await prisma.application.findUnique({ where: { id: unscored.id } });
    ok('resume never scored: the system scores it (77%), then sends', g.resumeScore === 77 && r.sent === true, r.why);
    // a duplicate: another candidate with the same phone
    const twinPhone = `98${String(stamp).slice(-8)}`;
    await prisma.candidate.create({ data: { name: 'ZZ Auto Twin', email: `zz.twin.${stamp}@example.invalid`, phone: twinPhone, source: 'Manual' } });
    const dup = await mk(7, { aiInterviewScore: 95, resumeScore: 95 }, { phone: twinPhone });
    r = await A.check(dup.id);
    g = await prisma.application.findUnique({ where: { id: dup.id } });
    ok('a possible duplicate on file: not sent - the recruiter sorts it out first', r.sent === false && !g.portalImportedAt, r.why);
    const manual = await prisma.application.create({ data: { candidateId: (await prisma.candidate.create({ data: { name: 'ZZ Auto Manual', email: `zz.m.${stamp}@example.invalid`, source: 'Manual' } })).id, requirementId: req.id, stage: 'NEW', source: 'Manual', aiInterviewStatus: 'Completed', aiInterviewScore: 99, resumeScore: 99 } });
    r = await A.check(manual.id);
    ok('an application a recruiter added (not from the Job Portal): untouched', r.sent === false && /not in the Job Portal screening/.test(r.why));
  } finally {
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
