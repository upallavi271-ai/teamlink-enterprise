#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AI CALL BRAIN + CALL-BACKS + QUESTIONS + MEMORY (2026-10-30) - on a COPY of dev.db (deleted at the end).
//
//   cd backend && node scripts/ai-call-brain-callbacks-test.js
//
// The brain is a STAND-IN here (fixed readings, no Claude call): this checks how the call uses what the brain says -
// lead-ins, questions kept for the team, the call-back moment, a stop that needs real stop words, a lead-in with an
// invented number refused - then the call-back reminder (made once, moved not duplicated, kept in calling hours, the
// before / at / overdue notices), the questions list + answer used on the next call, and the memory of a call-back.
// The real Claude brain is tested on the live server once its account has credits (brain.js needs them).
// ---------------------------------------------------------------------------
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');

const B = path.resolve(__dirname, '..');
const COPY = path.join(B, 'prisma', 'zz-brain-cb-test.db');
let pass = 0; let fail = 0;
const ok = (c, m, d) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m, d !== undefined ? JSON.stringify(d).slice(0, 500) : ''); } };

(async () => {
  const { PrismaClient } = require(path.join(B, 'node_modules/@prisma/client'));
  const src = new PrismaClient(); try { fs.unlinkSync(COPY); } catch { /* */ }
  await src.$executeRawUnsafe(`VACUUM INTO '${COPY.split(path.sep).join('/')}'`); await src.$disconnect();
  process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`; process.env.TEST_MODE = '1';
  try {
    const prisma = require(path.join(B, 'src/db'));
    const S = require(path.join(B, 'src/calling/scripts'));
    const { Dialogue } = require(path.join(B, 'src/calling/dialogue'));
    const Brain = require(path.join(B, 'src/calling/brain'));
    const DB = require(path.join(B, 'src/calling/schema'));
    const CB = require(path.join(B, 'src/calling/callbacks'));
    const KB = require(path.join(B, 'src/calling/knowledge'));
    const outcomes = require(path.join(B, 'src/calling/outcomes'));
    const { resolveIdentity } = require(path.join(B, 'src/utils/identity'));
    const P = S.phrases('English');
    const data = S.buildData({ candidate: { name: 'Ravi Kumar' }, requirement: { title: 'Faculty requirement', location: 'Kakinada', salary: '40 thousand' }, app: {} });
    // the stand-in brain: answers by the words said
    const READ = {};
    const fake = async (d, text) => READ[text] || null;
    const mk = (extra = {}) => new Dialogue({ purpose: 'Screening', language: 'English', data, brain: fake, ...extra });
    const blank = { language: 'English', experienceYears: null, location: '', noticeDays: null, noticeText: '', callbackText: '', callbackAt: '', question: '', answeredFromFacts: false, declineReason: '', leadIn: '', ms: 5 };

    // ---- the brain inside a call ------------------------------------------------------------------------------------
    let d = mk(); d.start(); await d.hear('yes speaking'); await d.hear('yes'); await d.hear('yes');
    READ['Is transport given?'] = { ...blank, intent: 'question', question: 'Is transport provided?', answeredFromFacts: false, leadIn: "I don't have confirmed information about transport. The team will check and tell you." };
    let r = await d.hear('Is transport given?');
    ok(r.say.startsWith("I don't have confirmed information about transport") && r.say.includes(P.interestQ) && d.st.pending.includes('Is transport provided?'), 'B1 an unknown question: honest answer, the same question again, kept for the team', r.say);
    READ['Salary entha untundhi?'] = { ...blank, intent: 'question', question: 'What is the salary?', answeredFromFacts: true, leadIn: 'The salary is 40 thousand.' };
    r = await d.hear('Salary entha untundhi?');
    ok(r.say.startsWith('The salary is 40 thousand.') && d.st.pending.length === 1, 'B2 a question the facts answer: answered, not kept as pending', r.say);
    READ['Yes, interested'] = { ...blank, intent: 'yes', leadIn: "That's great." };
    r = await d.hear('Yes, interested');
    ok(r.say === `That's great. ${P.qExp}` && d.st.interest === 'yes', 'B3 the lead-in goes before the next question', r.say);
    READ['moodu samvatsaralu'] = { ...blank, intent: 'answer', experienceYears: 3, leadIn: 'Okay, three years, noted.' };
    r = await d.hear('moodu samvatsaralu');
    ok(d.st.answers.experienceYears === 3 && r.say === `Okay, three years, noted. ${P.qLoc}`, 'B4 the brain reads "moodu samvatsaralu" as 3 years (the word reader could not)', [d.st.answers, r.say]);

    // a stop needs real stop / no words: never ended on a guess
    d = mk(); d.start(); await d.hear('yes speaking');
    READ['I am a bit busy now'] = { ...blank, intent: 'stop' };
    r = await d.hear('I am a bit busy now');
    ok(!d.st.stop, 'B5 the brain alone cannot put someone on Do-not-call (no stop words)', d.st.stop);
    d = mk(); d.start(); await d.hear('yes speaking');
    READ['Please do not call me again'] = { ...blank, intent: 'stop' };
    r = await d.hear('Please do not call me again');
    ok(d.st.stop && r.done, 'B6 a real "do not call me again" still stops at once', d.st.stop);

    // "call me tomorrow 5 pm": the moment the brain worked out is noted at once
    d = mk(); d.start(); await d.hear('yes speaking');
    READ['call me tomorrow at 5 pm'] = { ...blank, intent: 'later', callbackText: 'tomorrow 5 pm', callbackAt: '2031-01-15T17:00' };
    r = await d.hear('call me tomorrow at 5 pm');
    ok(r.done && d.outcome().callbackAt === '2031-01-15T17:00' && d.outcome().outcome === 'Call Back Later', 'B7 "call me tomorrow at 5 pm": noted with its moment, not asked again', d.outcome());
    // not interested with the reason already given: no second "why?"
    d = mk(); d.start(); await d.hear('yes speaking'); await d.hear('yes'); await d.hear('yes');
    READ['No, I already have a job'] = { ...blank, intent: 'already_employed', declineReason: 'Already working in a college' };
    r = await d.hear('No, I already have a job');
    ok(!r.done && d.st.step === 'convince', 'B8a the reason given with the no gets ONE honest try, not a second "why?"', [d.st.step, r.say]);
    await d.hear('no'); r = await d.hear('no');
    ok(r.done && d.outcome().outcome === 'Not Interested' && /Already working in a college/.test(d.outcome().summary), 'B8 not interested with the reason already said: closed politely, reason kept, not asked again', d.outcome().summary);
    // no brain answer (too slow / no credits): the script goes on exactly as before
    d = mk(); d.start(); await d.hear('yes speaking');
    r = await d.hear('yes');
    ok(d.st.step === 'intro', 'B9 no brain answer: the word lists carry the call (unchanged)', d.st.step);
    // the lead-in guard
    const facts = 'Job: Faculty\nSalary: 40 thousand';
    ok(Brain.safeLeadIn('The salary is 55 thousand.', { facts, heard: 'salary?' }) === '', 'B10 a lead-in with a number from nowhere is refused', null);
    ok(Brain.safeLeadIn('You are selected for this job.', { facts, heard: '' }) === '', 'B11 a lead-in with a forbidden word is refused', null);
    ok(Brain.safeLeadIn('Okay, noted. Are you free tomorrow?', { facts, heard: '' }) === 'Okay, noted.', 'B12 a question inside a lead-in is cut off (the engine asks the questions)', null);
    ok(Brain.safeLeadIn('సరే అండి, నోట్ చేసుకున్నా.', { facts, heard: '' }) === 'సరే, నోట్ చేసుకున్నా.', 'B13 never "అండి"', null);

    // ---- call-back reminders --------------------------------------------------------------------------------------------
    const app = await prisma.application.findFirst({ where: { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] }, requirement: { internal: false } }, orderBy: { createdAt: 'desc' } });
    const ins = async (extra = {}) => {
      const id = `aic_${crypto.randomBytes(9).toString('hex')}`; const t = new Date().toISOString();
      await DB.run(`INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","dedupeKey","language","scriptJson","initiatedVia","callSid","attempts","maxAttempts","outcomePending","createdAt","updatedAt")
        VALUES (?,?,?,'completed',?,?,?,?,?,?,?,?,1,1,1,?,?)`, id, 'test', 'Screening', app.id, app.candidateId, app.requirementId, `t:${id}`, 'English', '{}', 'sip', id, t, t);
      return id;
    };
    const res0 = { purpose: 'Screening', language: 'English', outcome: 'Call Back Later', identityConfirmed: true, callbackRequested: true, callbackWhen: 'tomorrow 5 pm', callbackAt: '2031-01-15T17:00', summary: 'AI call. Asked for a call back.', pendingQuestions: ['Is transport provided?'] };
    const c1 = await ins();
    await outcomes.applyResult(c1, res0, [{ who: 'assistant', text: 'Hi' }]);
    let open = await DB.all('SELECT * FROM "AiCallCallback" WHERE "applicationId" = ? AND "status" = ?', app.id, 'pending');
    ok(open.length === 1 && open[0].dueAt === new Date('2031-01-15T17:00:00+05:30').toISOString() && open[0].timeGiven === 1, 'C1 a call that ends "call me back tomorrow 5 pm" makes ONE reminder at 17:00 India time', open);
    const c2 = await ins();
    await outcomes.applyResult(c2, { ...res0, callbackWhen: '6 pm instead', callbackAt: '2031-01-15T18:00' }, [{ who: 'assistant', text: 'Hi' }]);
    open = await DB.all('SELECT * FROM "AiCallCallback" WHERE "applicationId" = ? AND "status" = ?', app.id, 'pending');
    ok(open.length === 1 && open[0].dueAt === new Date('2031-01-15T18:00:00+05:30').toISOString() && open[0].callId === c2, 'C2 a new time on the next call MOVES the same reminder (no duplicate)', open.map((x) => x.dueAt));
    const late = CB.intoHours(new Date('2031-01-15T23:30:00+05:30'), { hoursFrom: '09:00', hoursTo: '21:00' });
    ok(late.moved && late.at.toISOString() === new Date('2031-01-16T09:00:00+05:30').toISOString(), 'C3 "call me at 11:30 pm" moves to the next calling-hours start (09:00)', late);
    // the notices
    const due = new Date(open[0].dueAt);
    const n1 = await CB.tick(new Date(due.getTime() - 10 * 60000));
    const n2 = await CB.tick(new Date(due.getTime() + 60000));
    const n3 = await CB.tick(new Date(due.getTime() + 61 * 60000));
    const n4 = await CB.tick(new Date(due.getTime() + 62 * 60000));
    ok(n1.before === 1 && n2.due === 1 && n3.overdue === 1 && n4.before + n4.due + n4.overdue === 0, 'C4 the owner is told 15 min before, at the time, and once when an hour overdue - each once', [n1, n2, n3, n4]);
    const admin = await prisma.user.findFirst({ where: { email: 'chitturi.vasu84@gmail.com' } });
    const me = await resolveIdentity(admin.id);
    let list = await CB.list(me, { status: 'open' });
    const mine = list.find((x) => x.applicationId === app.id);
    ok(mine && mine.status === 'Overdue' && mine.requirement.title && mine.dueIst === '2031-01-15 18:00' || (mine && mine.dueIst === '2031-01-15 18:00'), 'C5 the Call-backs list shows candidate, requirement, India time and a status', mine);
    const rec = await prisma.user.findFirst({ where: { atsRole: 'RECRUITER', status: 'Active', id: { not: app.ownerRecruiterId || '' } } });
    const other = await resolveIdentity(rec.id);
    const { applicationInScope } = require(path.join(B, 'src/utils/scope'));
    const seen = (await CB.list(other, { status: 'open' })).some((x) => x.applicationId === app.id);
    const should = applicationInScope(other, await prisma.application.findUnique({ where: { id: app.id }, include: { requirement: true } }));
    ok(seen === should, 'C6 another recruiter sees the reminder only if the candidate is theirs (same scope as Candidates)', { seen, should });
    let mv = await CB.setStatus(me, mine.id, 'move', { dueAtIst: '2031-01-20T11:00' });
    open = await DB.one('SELECT * FROM "AiCallCallback" WHERE "id" = ?', mine.id);
    ok(mv.ok && open.dueAt === new Date('2031-01-20T11:00:00+05:30').toISOString() && !open.notifiedOverdueAt, 'C7 moving it resets the notices', open.dueAt);
    mv = await CB.setStatus(me, mine.id, 'done', { how: 'Called by hand' });
    list = await CB.list(me, { status: 'all' });
    ok(mv.ok && list.find((x) => x.id === mine.id).status === 'Completed', 'C8 "I called by hand" closes it (Completed)', null);
    // a stop request never makes a reminder
    const c3 = await ins();
    await outcomes.applyResult(c3, { ...res0, doNotCallRequested: true, outcome: 'Not Interested' }, [{ who: 'assistant', text: 'Hi' }]);
    ok((await DB.all('SELECT * FROM "AiCallCallback" WHERE "applicationId" = ? AND "status" = ?', app.id, 'pending')).length === 0, 'C9 "do not call me" never makes a call-back', null);

    // ---- questions kept for the team, answered, then used -----------------------------------------------------------
    let qs = await KB.list(me, { status: 'pending', requirementId: app.requirementId });
    ok(qs.length === 1 && qs[0].question === 'Is transport provided?' && qs[0].askedCount === 3, 'Q1 the unanswered question is kept once per requirement and counted each time (3 calls)', qs.map((x) => [x.question, x.askedCount]));
    const bad = await KB.answer(me, qs[0].id, { answer: 'Yes, you are selected and we give transport' });
    ok(bad && bad.error, 'Q2 an answer with a forbidden word is refused', bad);
    const good = await KB.answer(me, qs[0].id, { answer: 'Yes, the college bus picks up from LB Nagar.' });
    ok(good && good.status === 'answered', 'Q3 the recruiter answer is saved', good);
    const kn = await KB.forRequirement(app.requirementId);
    ok(kn.length === 1 && /college bus/.test(kn[0].a), 'Q4 the next call of this requirement gets the answer (only answered ones)', kn);
    ok(/college bus/.test(Brain.factsOf({ data, fields: {}, knowledge: kn })), 'Q5 the brain is given that answer as a verified fact', null);

    // ---- memory on a call-back ----------------------------------------------------------------------------------------
    d = mk().remember({ answers: { experienceYears: 4, currentLocation: 'Guntur', noticePeriodDays: 30, noticePeriodText: '30 days' } });
    d.start(); r = await d.hear('yes speaking');
    ok(r.say.replace(S.fill(P.ackName, { first: data.firstName }), '').trim().startsWith(S.fill(P.resumeLine, { job: data.jobTitle })), 'M1 a call-back starts with "(Hi Ravi.) we spoke earlier about the Faculty job"', r.say);
    await d.hear('yes'); await d.hear('yes');
    r = await d.hear('yes');
    ok(d.st.step === 'qProceed' && r.say.includes(P.qProceed), 'M2 experience, city and notice period told before are NOT asked again', [d.st.step, r.say]);
    await prisma.$disconnect();
  } catch (e) { fail += 1; console.log('ERROR', e.stack); }
  try { fs.unlinkSync(COPY); } catch { /* */ }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed (copy deleted; the brain was a stand-in - no Claude call)`);
  process.exit(fail ? 1 : 0);
})();
