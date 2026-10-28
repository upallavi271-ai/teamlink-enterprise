// TeamLink AI voice - SERVER TEST (no call, no TeamLink data): are the free engines on this server fast and correct?
//
//   NODE_PATH=/opt/teamlink-enterprise/backend/node_modules node server-voice-test.js /path/to/engines.js
//
// Speaks test sentences (Piper Telugu / English, Kokoro Hindi), hears them back (IndicConformer / Whisper), checks the
// language guess, and measures 1 and 4 calls at the same time. Reads the services' key from /opt/ai-voice/.key itself.
const fs = require('fs');
const E = require(process.argv[2] || './engines.js'); // eslint-disable-line import/no-dynamic-require
const R = '/opt/ai-voice';
const KEY = fs.readFileSync(`${R}/.key`, 'utf8').trim();
const env = {
  AI_VOICE_TTS: 'piper', AI_VOICE_PIPER_EXE: `${R}/piper/piper`, AI_VOICE_PIPER_TELUGU: `${R}/voices/te_IN-padmavathi-medium.onnx`,
  AI_VOICE_PIPER_ENGLISH: `${R}/voices/en_US-ljspeech-medium.onnx`, AI_VOICE_SPEED: '0.75', AI_VOICE_KEY: KEY,
  AI_VOICE_STT_URL: 'ws://127.0.0.1:8091', AI_VOICE_WHISPER_URL: 'http://127.0.0.1:8093', AI_VOICE_KOKORO_URL: 'http://127.0.0.1:8094',
};
const eng = E.fromEnv(env);
const cand = E.piperTts({ exe: `${R}/piper/piper`, voices: { Telugu: `${R}/voices/te_IN-venkatesh-medium.onnx`, English: `${R}/voices/en_US-ljspeech-medium.onnx` }, lengthScale: 1 });
const candHi = E.kokoroHttp({ url: 'http://127.0.0.1:8094', key: KEY, voice: 'hm_omega', speed: 1 });
const say = (t, l) => (l === 'Hindi' ? candHi(t) : cand(t, l));
const ms = async (f) => { const t = Date.now(); const v = await f(); return [v, Date.now() - t]; };
const avg = (a) => Math.round(a.reduce((p, c) => p + c, 0) / a.length);

const LINES = [
  ['అవును, నేనే మాట్లాడుతున్నాను', 'Telugu'], ['నాకు మూడు సంవత్సరాల అనుభవం ఉంది', 'Telugu'], ['హైదరాబాద్', 'Telugu'], ['ముప్పై రోజులు', 'Telugu'],
  ['Yes, I am interested in this job.', 'English'], ['I have three years of experience.', 'English'],
  ['मैं हैदराबाद में रहता हूँ।', 'Hindi'], ['तीस दिन का नोटिस है।', 'Hindi'],
];
const AI = [
  ['నేను టీమ్‌లింక్ కన్సల్టెంట్స్ యొక్క AI రిక్రూట్‌మెంట్ అసిస్టెంట్‌ని.', 'Telugu'], ['మీ నోటీస్ పీరియడ్ ఎన్ని రోజులు?', 'Telugu'],
  ['How many years of relevant experience do you have?', 'English'], ['आपका नोटिस पीरियड कितने दिनों का है?', 'Hindi'],
];

(async () => {
  console.log('engines:', eng.name);
  console.log('\n1. MAKING THE ASSISTANT\'S SENTENCES (first time; afterwards they are kept and cost nothing)');
  const mk = [];
  for (const [t, l] of AI) { const [pcm, m] = await ms(() => eng.tts(t, l)); mk.push(m); console.log(`  ${l.padEnd(8)} ${String(m).padStart(5)} ms for ${(pcm.length / 16000).toFixed(1)} s of speech`); } // eslint-disable-line no-await-in-loop
  console.log('\n2. ONE CALL: candidate answers -> heard back (language guess + words)');
  const clips = [];
  for (const [t, l] of LINES) clips.push([await say(t, l), t, l]); // eslint-disable-line no-await-in-loop
  const hear = [];
  let right = 0;
  for (const [pcm, t, l] of clips) {
    const [[found, words], m] = await ms(() => Promise.all([pcm.length >= 16000 * 2 ? eng.detect(pcm) : null, eng.stt(pcm, l)])); // eslint-disable-line no-await-in-loop
    hear.push(m);
    if (found === null || found === l) right += 1;
    console.log(`  ${l.padEnd(8)} ${String(m).padStart(5)} ms  lang: ${String(found || '(too short)').padEnd(11)} heard: ${words}`);
  }
  console.log(`  language guess right (or not needed): ${right}/${clips.length}; hearing avg ${avg(hear)} ms, max ${Math.max(...hear)} ms`);
  console.log('\n3. FOUR CALLS AT THE SAME TIME (each hears one Telugu answer)');
  const [, all] = await ms(() => Promise.all([0, 1, 2, 3].map((i) => ms(() => eng.stt(clips[i][0], 'Telugu')))));
  console.log(`  all four heard in ${all} ms`);
  const mem = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
  console.log(`\nfree memory now: ${Math.round(Number(mem[1]) / 1024)} MB`);
  process.exit(0);
})().catch((e) => { console.log('ERROR', e.message); process.exit(1); });
