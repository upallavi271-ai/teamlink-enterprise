#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE PORTAL'S AI INTERVIEW AND THE AI CALLING ENGINES (founder 2026-11-05): utils/interviewVoice.js with stand-in engines. No server, no database needed.
//   cd backend && node scripts/interview-voice-test.js
// ---------------------------------------------------------------------------
const V = require('../src/utils/interviewVoice');

let pass = 0; let fail = 0;
const check = (name, ok, d) => { if (ok) { pass += 1; console.log('PASS ', name); } else { fail += 1; console.log('FAIL ', name, '->', JSON.stringify(d)); } };
const pcm = Buffer.alloc(32000 * 4);
const eng = ({ detect = null, te = '', hi = '', en = '', speechMs = 3000 }) => ({
  detect: async () => detect,
  speech: async () => ({ speechMs }),
  stt: async (_p, l) => ({ Telugu: te, Hindi: hi, English: en }[l] || ''),
  tts: async () => Buffer.alloc(800),
});

(async () => {
  const none = await V.hear(pcm, 'English', { engines: null });
  check('V1 no engines on this server: ready false, the screen works from the browser', none.ready === false, none);
  const noise = await V.hear(pcm, 'English', { engines: eng({ detect: 'Telugu', te: 'నేను నా పని', speechMs: 200 }) });
  check('V2 a cough or a click (little real speech) never switches', noise.ready && !noise.changed && noise.lang === 'English', noise);
  const te = await V.hear(pcm, 'English', { engines: eng({ detect: 'Telugu', te: 'నేను మీ దగ్గర పని చేశాను అవును' }) });
  check('V3 real Telugu words: switches, with the words heard', te.changed && te.lang === 'Telugu' && /నేను/.test(te.text), te);
  const hi = await V.hear(pcm, 'English', { engines: eng({ detect: 'Hindi', hi: 'मैं यहाँ काम करता हूँ और मेरा नाम है' }) });
  check('V4 real Hindi words: switches', hi.changed && hi.lang === 'Hindi', hi);
  const proof = await V.hear(pcm, 'English', { engines: eng({ detect: 'Telugu', te: 'ల మక', hi: 'कि अ' }) });
  check('V5 the sound says Telugu but no real words: no proof, no switch', proof.ready && !proof.changed && proof.lang === 'English', proof);
  const back = await V.hear(pcm, 'Telugu', { engines: eng({ detect: 'English', en: 'I worked as a nurse for five years and I like it', te: 'ఐ వర్క్డ్ ఏజ్ అ నర్స్ ఫర్ ఫైవ్ ఇయర్స్ అండ్ ఐ లైక్ ఇట్ ఇన్ హాస్పిటల్' }) });
  check('V6 English in a Telugu interview: back to English', back.changed && back.lang === 'English' && /nurse/.test(back.text), back);
  const stay = await V.hear(pcm, 'Telugu', { engines: eng({ detect: 'English', te: 'నేను నర్సుగా పని చేశాను', en: 'My God Adam' }) });
  const halluc = await V.hear(pcm, 'Telugu', { engines: eng({ detect: 'English', te: 'నేను హైదరాబాద్ లో టీచర్ గా పని చేస్తున్నాను', en: "I'm going to change that one. Thank you very much for watching." }) });
  check('V7b Whisper writes a plausible English sentence over Telugu speech: stays in Telugu', !halluc.changed && halluc.lang === 'Telugu', halluc);
  check('V7 English-looking sound over real Telugu words: stays in Telugu', !stay.changed && stay.lang === 'Telugu', stay);
  const unsure = await V.hear(pcm, 'English', { engines: eng({ detect: null }) });
  check('V8 Whisper not sure: no switch', unsure.ready && !unsure.changed, unsure);
  const s = await V.say('నమస్తే', 'Telugu', { engines: eng({}) });
  check('V9 say gives a WAV', s.ready && s.wav.slice(0, 4).toString() === 'RIFF', s.ready);
  const n = await V.say('x', 'Telugu', { engines: null });
  check('V10 say without engines: ready false', n.ready === false, n);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
