#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ANSWERS FROM THE ATS + SAID THE WAY PEOPLE SAY IT (founder 2026-10-30) - text level, no database.
//
//   cd backend && node scripts/ai-call-answers-test.js
//
// 1. questions in the middle of a call are answered from the requirement (fields + description): pay of THIS role from a
//    "Package:" list (a misspelt label too, never another role's pay), timings, joining, qualification, openings, company rule
// 2. what the ATS does not hold: "I'll confirm with the team" + the question kept for the recruiter (never "I don't know")
// 3. a recruiter's answer from the Questions list is used
// 4. an answer at "how many years / which city" is not taken for a question; before the name is confirmed only "who is this?"
// 5. the Telugu voice text: everyday "u" endings, lakh / days-a-week / "to" in daily words, letter names untouched
// ---------------------------------------------------------------------------
const path = require('path');

process.env.AI_CALL_BRAIN = 'off';
const B = path.resolve(__dirname, '..');
const S = require(path.join(B, 'src/calling/scripts'));
const A = require(path.join(B, 'src/calling/answers'));
const V = require(path.join(B, 'src/calling/voice/speakScript'));
const { Dialogue } = require(path.join(B, 'src/calling/dialogue'));

let pass = 0; let fail = 0;
const ok = (c, m, d) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m, d !== undefined ? JSON.stringify(d).slice(0, 400) : ''); } };

const DESC = 'Qualification: MD\n\nPackage:\nProfessor -1.8l to 3L\nAssociate professor -1.6L to 2L\nAssistant professor -1.2L \nSenor Residence - 90000\n6 days a week Timings- 9:00 to 4:00\n\nBed capacity: 100\n\nFrom the Medical team requirements sheet (tab Running, row 19).';
const req = (title, extra = {}) => ({ title, description: DESC, location: 'Kakinada', openings: 4, joiningTimeline: 'Within 15 Days', education: 'MD', internal: false, ...extra });
const talk = async (r, lang = 'Telugu', knowledge = []) => {
  const d = new Dialogue({ purpose: 'Screening', language: lang, data: S.buildData({ candidate: { name: 'Keerthi Rao' }, requirement: r, app: {} }), requirement: r, knowledge });
  const Y = { English: 'yes', Telugu: 'అవును', Hindi: 'हाँ' }[lang];
  d.start(); await d.hear(Y); await d.hear(Y); await d.hear(Y); // name, two minutes, tell me about it -> the job is told
  return d;
};

(async () => {
  // ---- 1. pay of THIS role ------------------------------------------------------------------------------------------------
  ok(A.salaryOf({ data: {} }, req('Assistant Professor — Anatomy')) === '1.2 lakh', 'P1 Assistant Professor -> 1.2 lakh (not the Professor line)', A.salaryOf({ data: {} }, req('Assistant Professor — Anatomy')));
  ok(A.salaryOf({ data: {} }, req('Associate Professor — Anatomy')) === '1.6 lakh to 2 lakh', 'P2 Associate Professor -> 1.6 to 2 lakh');
  ok(A.salaryOf({ data: {} }, req('Senior Resident — Anatomy')) === '90 thousand', 'P3 "Senor Residence" in the sheet still matches Senior Resident -> 90 thousand');
  ok(A.salaryOf({ data: {} }, req('Lab Technician')) === '', 'P4 a role not in the pay list -> no pay said (never another role\'s)');

  let d = await talk(req('Assistant Professor — Anatomy'));
  let r = await d.hear('సాలరీ ఎంత?');
  ok(/లక్ష|1\.2 lakh/.test(r.say) && r.say.endsWith(S.phrases('Telugu').interestQ), 'A1 "సాలరీ ఎంత?" -> the pay from the ATS, then the question again', r.say);
  r = await d.hear('టైమింగ్స్ ఏంటి?');
  ok(/6 days a week/.test(r.say) && /9 to 4/.test(r.say), 'A2 "టైమింగ్స్ ఏంటి?" -> "6 days a week, 9 to 4" from the description', r.say);
  r = await d.hear('ఎప్పుడు జాయిన్ అవ్వాలి?');
  ok(/15 days/i.test(r.say), 'A3 joining -> "within 15 days"', r.say);
  r = await d.hear('క్వాలిఫికేషన్ ఏంటి?');
  ok(/MD/.test(r.say), 'A4 qualification -> MD', r.say);
  r = await d.hear('ఎన్ని పోస్ట్‌లు ఉన్నాయి?');
  ok(/4/.test(r.say), 'A5 openings -> 4', r.say);
  r = await d.hear('ఏ హాస్పిటల్?');
  ok(r.say.startsWith(A.answer(d, 'ఏ హాస్పిటల్?').say) && /ఇంటర్వ్యూ/.test(r.say), 'A6 which hospital -> the ATS rule: named when the interview is fixed (no name leaked)', r.say);
  r = await d.hear('మీరు ఎవరు?');
  ok(/టీమ్‌లింక్/.test(r.say), 'A7 "మీరు ఎవరు?" -> TeamLink Consultants, Hyderabad', r.say);

  // ---- 2. not in the ATS: confirm with the team, kept for the recruiter ---------------------------------------------------
  r = await d.hear('బస్ ఉంటుందా?');
  ok(r.say.startsWith('అది టీమ్‌తో కన్ఫర్మ్') && d.st.pending.includes('బస్ ఉంటుందా?') && !/తెలియదు|లేదు/.test(r.say.split('.')[0]), 'N1 bus (not in the ATS) -> "I\'ll confirm with the team", kept for the recruiter, never "I don\'t know"', [r.say, d.st.pending]);
  ok(d.outcome().pendingQuestions && d.outcome().pendingQuestions.includes('బస్ ఉంటుందా?'), 'N2 the question reaches the call result (-> AI Calling > Questions)', d.outcome().pendingQuestions);

  // ---- 3. the recruiter's own answer ----------------------------------------------------------------------------------------
  d = await talk(req('Assistant Professor — Anatomy'), 'English', [{ q: 'Is transport provided?', a: 'Yes, there is a college bus from Kakinada town.' }]);
  r = await d.hear('is there a bus?');
  ok(r.say.startsWith('Yes, there is a college bus'), 'K1 a recruiter-written answer (Questions tab) is used on the next call', r.say);

  // ---- 4. answers are not questions; nothing before the name ------------------------------------------------------------------
  d = await talk(req('Assistant Professor — Anatomy'));
  await d.hear('అవును'); // interested -> how many years?
  r = await d.hear('ఎన్ని ఏళ్ళు అంటే 3 ఏళ్ళు');
  ok(d.st.answers.experienceYears === 3 && d.st.step === 'qLoc', 'Q1 at "how many years?" an answer with question words is read as the answer', [d.st.answers, d.st.step]);
  r = await d.hear('సాలరీ ఎంత?');
  ok(/లక్ష|lakh/.test(r.say) && d.st.step === 'qLoc', 'Q2 ...but a real question about pay at that step is answered, then the city is asked again', [r.say, d.st.step]);
  const d2 = new Dialogue({ purpose: 'Screening', language: 'Telugu', data: S.buildData({ candidate: { name: 'Keerthi Rao' }, requirement: req('Assistant Professor — Anatomy'), app: {} }), requirement: req('Assistant Professor — Anatomy') });
  d2.start();
  r = await d2.hear('సాలరీ ఎంత?');
  ok(!/లక్ష|lakh/.test(r.say) && d2.st.step === 'identity', 'Q3 before the name is confirmed nothing about the job is told', r.say);
  r = await d2.hear('మీరు ఎవరు?');
  ok(/టీమ్‌లింక్/.test(r.say) && d2.st.step === 'identity', 'Q4 ...but "who is calling?" is answered, then the name is asked', r.say);

  // ---- 4b. a job with few facts; "interest undi"; "tell the job again" (test call 2026-10-30) ---------------------------------
  const thin = { title: 'Faculty requirement', description: 'Created for the Education interview tracker (local import 2026-10-27).', education: 'Any Degree', employmentType: 'Full Time', workMode: 'Work From Office', joiningTimeline: 'Within 15 Days', openings: 1, internal: false, client: { name: 'ARMIET - Alamuri Ratnamala Institute of Engineering & Technology, Engineering College Shahapur' } };
  d = await talk(thin);
  ok(d.B.brief.includes('engineering college') && d.B.brief.includes('ఏ డిగ్రీ') && d.B.brief.includes('within 15 days') && !/ARMIET|Alamuri/.test(d.B.brief), 'T1 a job with few facts: the kind of place (not its name), the degree and the joining time are told', d.B.brief);
  r = await d.hear('జాబ్ గురించి మళ్ళీ చెప్పు');
  ok(r.say.includes('engineering college') && r.say.endsWith(S.phrases('Telugu').interestQ), 'T2 "జాబ్ గురించి మళ్ళీ చెప్పు" -> the job again in full, then the question (not only "ఓకే, మళ్ళీ చెప్తా" + the question)', r.say);
  await d.hear('నాకు ఇంట్రెస్ట్ ఉంది నువ్ చెప్తే నేను వింటా');
  ok(d.st.interest === 'yes' && d.st.step === 'qExp', 'T3 "నాకు ఇంట్రెస్ట్ ఉంది ..." is a yes (was not understood)', [d.st.interest, d.st.step]);
  const { classify } = require(path.join(B, 'src/calling/dialogue'));
  ok(['ఇంట్రెస్ట్ ఉంది', 'इंटरेस्ट है', 'interest undi'].every((t) => classify(t).intent === 'yes') && ['ఇంట్రెస్ట్ లేదు', 'इंटरेस्ट नहीं है', 'not interested'].every((t) => classify(t).intent === 'no'), 'T4 "interest undi / है" = yes, "interest ledu / नहीं है" = no');
  ok(!(await talk(req('Assistant Professor — Anatomy'))).B.brief.includes('ఏ డిగ్రీ'), 'T5 a job with its own facts keeps the short brief (the extra facts only when asked again)');

  // ---- 5. the voice's text --------------------------------------------------------------------------------------------------
  const v = (t) => V.native(t, 'Telugu');
  ok(v('ఒక Faculty జాబ్ ఉంది. థాంక్స్.') === 'ఒక ఫ్యాకల్టీ జాబ్ ఉంది. థాంక్స్.', 'V1 no added "u" ("jobuuuu, thankuuuu" - founder 2026-10-30): the plain spelling', v('ఒక Faculty జాబ్ ఉంది. థాంక్స్.'));
  ok(v('సాలరీ 1.2 lakh వరకు ఉంటుంది.') === 'సాలరీ లక్షా 20 వేలు వరకు ఉంటుంది.', 'V2 "1.2 lakh" -> "లక్షా 20 వేలు" (was "ఒకటి దశాంకం రెండు")', v('సాలరీ 1.2 lakh వరకు ఉంటుంది.'));
  ok(v('టైమింగ్స్: 6 days a week, 9 to 4.').includes('వారానికి 6 రోజులు, 9 నుంచి 4 వరకు'), 'V3 "6 days a week, 9 to 4" -> "వారానికి 6 రోజులు, 9 నుంచి 4 వరకు"', v('టైమింగ్స్: 6 days a week, 9 to 4.'));
  ok(v('M.Tech CSE') === 'ఎం టెక్ సీ ఎస్ ఈ' && v('అసిస్టెంట్‌ని') === 'అసిస్టెంట్‌ని', 'V4 letter names, degrees and a joined word keep their sound', [v('M.Tech CSE'), v('అసిస్టెంట్‌ని')]);
  ok(V.native('सैलरी 1.6 lakh to 2 lakh तक है।', 'Hindi') === 'सैलरी 1 लाख 60 हज़ार से 2 लाख तक है।', 'V5 Hindi: "1 लाख 60 हज़ार से 2 लाख तक" (no doubled तक)', V.native('सैलरी 1.6 lakh to 2 lakh तक है।', 'Hindi'));
  ok(!S.LANGS.some((l) => /నెక్స్ట్/.test(Object.values(S.phrases(l)).join(' '))), 'V6 no "నెక్స్ట్ స్టెప్స్" left (the voice could not say it): "తర్వాత ఏం చేయాలో" / "ముందుకు వెళ్దామా"');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
