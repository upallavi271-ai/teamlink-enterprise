#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TELUGU OR HINDI? (founder 2026-10-30: "telugu matladithey, hindi lo theeskuntundhi") - text level, stand-in listeners.
//
//   cd backend && node scripts/ai-call-telugu-hindi-test.js
//
// The real calls of 2026-10-30 11:05-11:09: the person spoke Telugu, Whisper's sound check said "Hindi", the Hindi listener
// wrote the Telugu sound in Hindi letters ("ఓకే చెప్పండి" -> "ओके चपंडी ह") and the call went over to Hindi. Now both
// listeners hear it and the language whose words are real everyday words wins (voice/gateway.js teluguOrHindi).
// ---------------------------------------------------------------------------
const path = require('path');

process.env.AI_CALL_BRAIN = 'off';
const B = path.resolve(__dirname, '..');
const G = require(path.join(B, 'src/calling/voice/gateway'));
const S = require(path.join(B, 'src/calling/scripts'));
const { Dialogue } = require(path.join(B, 'src/calling/dialogue'));

let pass = 0; let fail = 0;
const ok = (c, m, d) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m, d !== undefined ? JSON.stringify(d).slice(0, 400) : ''); } };
// a stand-in for the two Indian-language listeners: what each one writes for the same sound
const ears = (te, hi) => { const asked = []; return { asked, stt: async (_pcm, l) => { asked.push(l); return l === 'Telugu' ? te : hi; } }; };

(async () => {
  // ---- the real cases ----------------------------------------------------------------------------------------------------
  let e = ears('ఓకే చెప్పండి', 'ओके चपंडी ह');
  let r = await G.teluguOrHindi(e, null, 'Hindi');
  ok(r && r.lang === 'Telugu' && r.text === 'ఓకే చెప్పండి', 'R1 "ఓకే చెప్పండి" that the sound check called Hindi stays Telugu', r);
  e = ears('సరే చెప్పండి', 'सरे चप्पंडी');
  r = await G.teluguOrHindi(e, null, 'Hindi');
  ok(r && r.lang === 'Telugu', 'R2 "సరే చెప్పండి" -> Telugu', r);
  e = ears('నాకు రెండు ఏళ్ళ ఎక్స్‌పీరియన్స్ ఉంది', 'नाकु रेंडु एल्ला एक्सपीरियंस उंदी');
  r = await G.teluguOrHindi(e, null, 'Hindi');
  ok(r && r.lang === 'Telugu', 'R3 a Telugu sentence about experience -> Telugu', r);
  // real Hindi stays Hindi
  e = ears('మై హైదరాబాద్ మే రహతా హూ', 'मैं हैदराबाद में रहता हूँ');
  r = await G.teluguOrHindi(e, null, 'Telugu');
  ok(r && r.lang === 'Hindi', 'R4 a real Hindi sentence stays Hindi even if the sound check said Telugu', r);
  e = ears('హా జీ బతాయియే', 'हाँ जी बताइए');
  r = await G.teluguOrHindi(e, null, 'Hindi');
  ok(r && r.lang === 'Hindi', 'R5 "हाँ जी बताइए" -> Hindi', r);
  // nothing real in either: no proof, nothing is switched
  e = ears('తకనం చపీ', 'तकननम चपी हा');
  r = await G.teluguOrHindi(e, null, 'Hindi');
  ok(r === null, 'R6 noise in both -> no proof (the call keeps its language)', r);
  // a tie: the sound check decides
  e = ears('అవును', 'हाँ');
  r = await G.teluguOrHindi(e, null, 'Hindi');
  ok(r && r.lang === 'Hindi', 'R7 one real word each -> the sound check breaks the tie', r);
  // words already heard are not heard again
  e = ears('సరే చెప్పండి', 'सरे चप्पंडी');
  r = await G.teluguOrHindi(e, null, 'Hindi', { Hindi: 'ओके चपंडी ह' });
  ok(r && r.lang === 'Telugu' && e.asked.join() === 'Telugu', 'R8 only the missing listener is asked (no extra wait)', e.asked);

  // ---- scores ------------------------------------------------------------------------------------------------------------
  ok(G.nativeScore('ओके चपंडी ह', 'Hindi') === 0 && G.nativeScore('ఓకే చెప్పండి', 'Telugu') >= 1, 'N1 Telugu sound in Hindi letters has no real Hindi word');
  ok(G.nativeScore('Yes I am interested', 'Telugu') === 0, 'N2 English letters count for neither');

  // ---- what the listener got wrong is not kept or said back --------------------------------------------------------------
  ok(S.looksGarbled('हैायदराबाद ह') && !S.looksGarbled('हैदराबाद') && !S.looksGarbled('हैं') && !S.looksGarbled('హైదరాబాద్'), 'G1 two vowel signs in a row = a wrong hearing; real words pass');
  const d = new Dialogue({ purpose: 'Screening', language: 'Hindi', data: S.buildData({ candidate: { name: 'Gujjula Velangini Keerthi' }, requirement: { title: 'Faculty' }, app: {} }) });
  d.remember({ answers: { experienceYears: 2, currentLocation: 'हैायदराबाद ह', noticePeriodText: '5 days', noticePeriodDays: 5 } });
  ok(d.st.answers.experienceYears === 2 && !d.st.answers.currentLocation, 'G2 a garbled city from an earlier call is not carried over (asked again)', d.st.answers);
  d.start();
  const r2 = await d.hear('हाँ');
  ok(!/Gujjula/.test(r2.say.split('।')[0]), 'G3 the greeting does not guess a first name ("Hello Gujjula" was the family name)', r2.say);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
