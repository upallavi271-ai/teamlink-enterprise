// ---------------------------------------------------------------------------
// PLANS MEETING > SERVER VOICE (founder 2026-11-17: "telugu hindi ki voice ravadam ledu, english voice only it is coming"). Most phones have no Telugu or Hindi voice, so the meeting page asks THIS
// server to say each sentence: the same free Piper voices the AI interview and the AI phone calls use (calling/voice/engines.js: Telugu, Hindi, English; no paid service).
//   status()          { en, te, hi }: true where this server can make that voice (so the page does not ask for one that is missing)
//   speak(lang, text) -> { wav } | { error, status }
// ONLY the sentences in marketing/meetingSentences.json can be spoken (made by scripts/make-meeting-sentences.js from the page's own words), so this public address can never be used to read any other
// text. Each sentence is made once and kept (the meeting is fixed words); two at a time at most, so the server's other work is not starved. Nothing is sent anywhere.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const LIST = require('./meetingSentences.json');

const NAME = { en: 'English', te: 'Telugu', hi: 'Hindi' };
const ALLOW = Object.fromEntries(Object.keys(NAME).map((k) => [k, new Set(LIST[k] || [])]));
const MAX_KEPT = 260;
const kept = new Map(); // "lang|sentence" -> wav
// every sentence is also kept as a file, so a restart of the server (every deploy) does not make the voice cold: a cold Telugu voice took about 5 seconds for the first sentence (founder 2026-11-17: "voice is not coming")
const dir = () => process.env.MK_MEETING_VOICE_DIR || path.join(os.tmpdir(), 'tl-meeting-voice');
const fileOf = (key) => path.join(dir(), `${crypto.createHash('sha1').update(key).digest('hex')}.wav`);
const fromDisk = (key) => { try { const b = fs.readFileSync(fileOf(key)); return b.length > 44 && b.slice(0, 4).toString() === 'RIFF' ? b : null; } catch { return null; } };
const toDisk = (key, wav) => { try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(fileOf(key), wav); } catch { /* the memory copy is enough */ } };
let active = 0; const queue = [];
const take = () => new Promise((resolve) => { if (active < 2) { active += 1; resolve(); } else queue.push(resolve); });
const give = () => { const next = queue.shift(); if (next) next(); else active -= 1; };
const gateway = () => require('../calling/voice/gateway'); // eslint-disable-line global-require
const engines = () => require('../calling/voice/engines'); // eslint-disable-line global-require

// can this server make the voice? (Piper needs its program and the language's voice file set; Vexyl TTS is decided by its own server)
function ready(lang) {
  let e = null;
  try { e = gateway().engines(); } catch { return false; }
  if (!e || !e.tts) return false;
  const env = process.env;
  const piper = (env.AI_VOICE_TTS || (env.AI_VOICE_PIPER_EXE ? 'piper' : 'vexyl')) === 'piper';
  if (!piper) return true;
  if (!env.AI_VOICE_PIPER_EXE) return false;
  const voice = { te: env.AI_VOICE_PIPER_TELUGU, en: env.AI_VOICE_PIPER_ENGLISH, hi: env.AI_VOICE_PIPER_HINDI }[lang];
  return !!voice || (lang === 'hi' && !!env.AI_VOICE_KOKORO_URL);
}
const status = () => ({ en: ready('en'), te: ready('te'), hi: ready('hi') });

async function speak(lang, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!NAME[lang] || !t || !ALLOW[lang].has(t)) return { error: 'Not found', status: 404 };
  if (!ready(lang)) return { error: 'The voice is not available', status: 503 };
  const key = `${lang}|${t}`;
  let wav = kept.get(key) || fromDisk(key);
  if (wav) { kept.set(key, wav); return { wav }; }
  await take();
  try {
    wav = kept.get(key); // another request may have made it while this one waited
    if (!wav) {
      const G = gateway(); const R = engines(); const E = G.engines();
      const parts = G.sentences(t);
      const made = await Promise.race([
        Promise.all(parts.map((s) => (E.ttsWide ? E.ttsWide(s, NAME[lang]) : E.tts(s, NAME[lang]).then((pcm) => ({ pcm, rate: 8000 }))))),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the voice took too long')), 40000)),
      ]);
      const rate = made[0] ? made[0].rate : 8000;
      const gap = Buffer.alloc(Math.round(rate * 0.12) * 2);
      wav = R.pcmToWav(Buffer.concat(made.flatMap((p, i) => (i ? [gap, R.resample(p.pcm, p.rate, rate)] : [p.pcm]))), rate);
      kept.set(key, wav); toDisk(key, wav);
      if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
    }
    return { wav };
  } catch (e) {
    console.error('[omni-mk] meeting voice:', e.message); // eslint-disable-line no-console
    return { error: 'The voice could not be made', status: 502 };
  } finally { give(); }
}

// the first slides of each language are made a minute after the server starts (one after another, low priority), so the first thing a client hears is already there
async function prewarm(max = 14) {
  for (const lang of ['te', 'hi', 'en']) {
    if (!ready(lang)) continue; // eslint-disable-line no-continue
    for (const text of (LIST[lang] || []).slice(0, max)) {
      try { await speak(lang, text); } catch { /* the next one */ } // eslint-disable-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300)); // eslint-disable-line no-await-in-loop
    }
  }
}

module.exports = { status, speak, ready, prewarm, ALLOW, _kept: kept };
