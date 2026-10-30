#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AI CALL SPOKEN LIKE A PERSON (founder 2026-10-30: "oka person laaga matladali" / "official telugu & official hindi
// avasaram ledhu") - text level, no database.
//
//   cd backend && node scripts/ai-call-human-talk-test.js
//
// 1. calls do not all sound the same (a wording per call), and one call keeps its wording on every turn (the AI link
//    builds the talk again on each turn from the call id)
// 2. answers are acknowledged the way a person does ("Okay, 3 years." / "ఓకే, వరంగల్.") - but not on top of the brain's own
// 3. Telugu / Hindi lines are daily speech: no bookish / official words, no "అండి", no forbidden word in any wording
// 4. the AI is still said first (never pretends to be a person)
// ---------------------------------------------------------------------------
const path = require('path');

process.env.AI_CALL_BRAIN = 'off';
const B = path.resolve(__dirname, '..');
const S = require(path.join(B, 'src/calling/scripts'));
const { Dialogue } = require(path.join(B, 'src/calling/dialogue'));

let pass = 0; let fail = 0;
const ok = (c, m, d) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m, d !== undefined ? JSON.stringify(d).slice(0, 400) : ''); } };
const data = S.buildData({ candidate: { name: 'Keerthi Rao' }, requirement: { title: 'Staff Nurse', location: 'Hyderabad', skills: 'Nursing, ICU', experience: '2-5', workMode: 'Work From Office', employmentType: 'Full Time' }, app: {} });
const YES = { English: 'yes', Telugu: 'అవును', Hindi: 'हाँ' };

(async () => {
  // ---- 1. variety between calls, the same inside one call ------------------------------------------------------------
  for (const lang of S.LANGS) {
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) seen.add(S.phrases(lang, `aic_${i}`).qExp);
    ok(seen.size >= 2, `V1 ${lang}: different calls ask the experience question in different words`, [...seen]);
    ok(S.phrases(lang, 'aic_x').qLoc === S.phrases(lang, 'aic_x').qLoc && S.phrases(lang).qLoc === S.phrases(lang, '').qLoc, `V2 ${lang}: one call keeps its wording; no seed = the first wording`);
  }
  const a = new Dialogue({ purpose: 'Screening', language: 'Telugu', data, seed: 'aic_same' });
  a.start(); await a.hear('అవును');
  const b = new Dialogue({ purpose: 'Screening', language: 'Telugu', data, seed: 'aic_same' });
  b.restore(a.snapshot());
  ok(b.P.qNotice === a.P.qNotice && b.B.intro === a.B.intro, 'V3 the talk built again on the next turn (same call id) uses the same words');

  // ---- 2. acknowledgements -----------------------------------------------------------------------------------------------
  for (const lang of S.LANGS) {
    const d = new Dialogue({ purpose: 'Screening', language: lang, data });
    const P = S.phrases(lang);
    d.start();
    let r = await d.hear(YES[lang]);
    ok(r.say.startsWith(S.fill(P.ackName, { first: 'Keerthi' })), `A1 ${lang}: greets them by first name once they confirm`, r.say);
    await d.hear(YES[lang]); await d.hear(YES[lang]);
    r = await d.hear(YES[lang]);
    ok(r.say.startsWith(P.ackInterest), `A2 ${lang}: "yes, interested" gets a short reaction before the next question`, r.say);
    r = await d.hear({ English: '3 years', Telugu: '3 ఏళ్ళు', Hindi: '3 साल' }[lang]);
    ok(r.say.includes('3') && r.say.indexOf('3') < r.say.indexOf(P.qLoc), `A3 ${lang}: says the years back ("3 years") before asking the city`, r.say);
    r = await d.hear({ English: 'Warangal', Telugu: 'వరంగల్', Hindi: 'वारंगल' }[lang]);
    ok(r.say.startsWith(S.fill(P.ackLoc, { place: { English: 'Warangal', Telugu: 'వరంగల్', Hindi: 'वारंगल' }[lang] })), `A4 ${lang}: says the city back`, r.say);
    r = await d.hear({ English: 'immediately', Telugu: 'వెంటనే', Hindi: 'तुरंत' }[lang]);
    ok(r.say.startsWith(P.ackNoticeNow), `A5 ${lang}: "immediately" -> "so you can join right away"`, r.say);
  }
  const fresher = new Dialogue({ purpose: 'Screening', language: 'English', data });
  fresher.start(); for (let i = 0; i < 4; i += 1) await fresher.hear('yes'); // eslint-disable-line no-await-in-loop
  let r = await fresher.hear('no experience');
  ok(r.say.startsWith(S.phrases('English').ackFresher), 'A6 no experience -> "Okay, a fresher." (never "0 years")', r.say);
  const withBrain = new Dialogue({ purpose: 'Screening', language: 'English', data, brain: async () => ({ intent: 'answer', language: 'English', experienceYears: 4, location: '', noticeDays: null, noticeText: '', callbackText: '', callbackAt: '', question: '', answeredFromFacts: false, declineReason: '', leadIn: 'Four years, nice.', ms: 3 }) });
  withBrain.start(); withBrain.st.step = 'qExp';
  r = await withBrain.hear('four years');
  ok(r.say.startsWith('Four years, nice.') && !r.say.includes('Okay, 4 years'), 'A7 when the brain gives its own reaction, the fixed one is not added on top', r.say);

  // ---- 3. daily speech, not official -----------------------------------------------------------------------------------
  const BOOKISH = { Telugu: ['సంవత్సరం', 'సంవత్సరాలు', 'ప్రస్తుతం', 'జీతం', 'అండి', 'దయచేసి'], Hindi: ['भारतीय समय', 'आमने-सामने', 'फ़ैसला', 'कृपया', 'वेतन', 'अनुभव'] };
  for (const lang of ['Telugu', 'Hindi']) {
    const words = [];
    for (let i = 0; i < 40; i += 1) words.push(...Object.values(S.phrases(lang, `aic_${i}`)));
    const bad = BOOKISH[lang].filter((w) => words.some((t) => String(t).includes(w)));
    ok(!bad.length, `D1 ${lang}: no bookish / official words in any wording`, bad);
  }
  ok(S.checkTemplates().length === 0, 'D2 no forbidden word (selected / hired / offer ...) in any wording of any language', S.checkTemplates());

  // ---- 4. still honest that it is an AI ------------------------------------------------------------------------------------
  for (const lang of S.LANGS) {
    const all = new Set(); for (let i = 0; i < 20; i += 1) all.add(S.phrases(lang, `aic_${i}`).ai);
    ok([...all].every((t) => /\bAI\b/.test(t)), `H1 ${lang}: every opening line says it is an AI assistant`, [...all]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
