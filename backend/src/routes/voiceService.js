// ---------------------------------------------------------------------------
// THE CALLING VOICE FOR THE JOB PORTAL'S AI VIDEO INTERVIEW (founder 2026-11-11: "ats lo ai calling laaganey, job portal lo ai interview
// vuntadhi, andhulo kuda same fluent ga, neat ga, language switch avuthuu matladali").
//
// The Job Portal runs next to TeamLink on this server (utils/jobPortalEmbed.js) and calls these three, on this machine only, with the
// secret both already share (JOB_PORTAL_SYNC_TOKEN, sent as x-teamlink-token):
//
//   POST /api/voice-service/speak       { text, language }  -> audio/wav   the AI calling voices (Piper: Telugu maya, English, Hindi),
//                                                                         at full quality - not the 8 kHz phone sound
//   POST /api/voice-service/transcribe  audio bytes (webm / ogg / wav; ?hint=te) -> { text, language }   Whisper tells the language,
//                                                                         the Telugu / Hindi listener the words - the calls' own rules
//   POST /api/voice-service/translate   { lines: [...], to }  -> { lines }   the local model (Ollama), for the interview's questions
//
// Nothing here is reachable from outside: a request that is not from this machine, or without the secret, gets 404.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const { spawn } = require('child_process');

const router = express.Router();
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LANG_OF = { en: 'English', te: 'Telugu', hi: 'Hindi', english: 'English', telugu: 'Telugu', hindi: 'Hindi' };
const CODE_OF = { English: 'en', Telugu: 'te', Hindi: 'hi' };
const langOf = (v) => LANG_OF[String(v || '').toLowerCase().split(/[-_]/)[0]] || null;

function allowed(req) {
  const secret = String(process.env.JOB_PORTAL_SYNC_TOKEN || '');
  const got = String(req.headers['x-teamlink-token'] || '');
  if (!secret || !got || got.length !== secret.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret))) return false;
  return LOCAL.has(String((req.socket && req.socket.remoteAddress) || ''));
}
router.use((req, res, next) => (allowed(req) ? next() : res.status(404).json({ error: 'Not found' })));

const V = () => require('../calling/voice/gateway'); // eslint-disable-line global-require
const E = () => require('../calling/voice/engines'); // eslint-disable-line global-require

// --- speak -----------------------------------------------------------------------------------------------------------------
// a small cache: the same question in the same language is made once (an interview asks each once, a reload asks again)
const spoken = new Map();
router.post('/speak', express.json({ limit: '64kb' }), async (req, res) => {
  const text = String((req.body && req.body.text) || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const lang = langOf(req.body && req.body.language) || 'English';
  if (!text) return res.status(400).json({ error: 'No text' });
  const key = `${lang}|${text}`;
  try {
    let wav = spoken.get(key);
    if (!wav) {
      const engines = V().engines();
      const parts = V().sentences(text);
      // every sentence at once, joined in order with a short breath between them (the calls' way: no hole in the middle)
      const pcms = await Promise.all(parts.map((s) => (engines.ttsWide ? engines.ttsWide(s, lang) : engines.tts(s, lang).then((pcm) => ({ pcm, rate: 8000 })))));
      const rate = pcms[0] ? pcms[0].rate : 8000;
      const gap = Buffer.alloc(Math.round(rate * 0.18) * 2);
      const all = Buffer.concat(pcms.flatMap((p, i) => (i ? [gap, E().resample(p.pcm, p.rate, rate)] : [p.pcm])));
      wav = E().pcmToWav(all, rate);
      spoken.set(key, wav);
      if (spoken.size > 300) spoken.delete(spoken.keys().next().value);
    }
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('cache-control', 'no-store');
    return res.send(wav);
  } catch (e) {
    console.error('[voice-service] speak failed:', e.message);
    return res.status(502).json({ error: 'The voice could not be made' });
  }
});

// --- transcribe ------------------------------------------------------------------------------------------------------------
// the browser's recording (webm / ogg / mp4 / wav) -> 8 kHz 16-bit mono, the sound the calling listeners are tuned for
function toPcm8k(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const out = []; let err = '';
    const t = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('ffmpeg took too long')); }, 60000);
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += String(d); });
    ff.on('error', (e) => { clearTimeout(t); reject(new Error(`ffmpeg is not available (${e.code || e.message})`)); });
    ff.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(Buffer.concat(out)); else reject(new Error(`ffmpeg failed: ${err.slice(0, 160)}`)); });
    ff.stdin.on('error', () => {});
    ff.stdin.end(buf);
  });
}

// One answer -> its words and its language, by the calls' rules: Whisper says which language; Telugu / Hindi only on real Telugu / Hindi
// words (teluguOrHindi); English only on a real English sentence. A candidate who keeps to one language is heard in it (hint).
async function hearAnswer(pcm, hint) {
  const G = V(); const engines = G.engines();
  const SEC = 8000 * 2;
  const english = async () => { const r = await engines.stt(pcm, 'English').catch(() => ''); return String((r && r.text) || r || ''); };
  let found = null; let enText = '';
  if (engines.hear) {
    const h = await engines.hear(pcm, pcm.length >= SEC * 1.4 ? 0.6 : 0.75, '', false).catch(() => null);
    if (h) { if (h.lang === 'English') enText = h.text || ''; else found = h.lang; }
  }
  const prefer = ['Telugu', 'Hindi'].includes(hint) ? hint : null;
  if (found || prefer) {
    const th = await G.teluguOrHindi(engines, pcm, found || prefer, {}, prefer).catch(() => null);
    if (th && th.text) return { text: th.text, language: th.lang };
  }
  if (!enText) enText = await english();
  return { text: enText, language: 'English' };
}

router.post('/transcribe', express.raw({ type: () => true, limit: '40mb' }), async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length < 200) return res.status(400).json({ error: 'No audio' });
  try {
    // a plain WAV is read here; anything else (the browser's webm / ogg / mp4) goes through ffmpeg
    let pcm;
    if (buf.slice(0, 4).toString('ascii') === 'RIFF') { const w = E().wavToPcm(buf); pcm = E().resample(w.pcm, w.rate, 8000); } else pcm = await toPcm8k(buf);
    if (pcm.length < 8000 * 2 * 0.4) return res.json({ text: '', language: null });
    const r = await hearAnswer(pcm, langOf(req.query.hint));
    return res.json({ text: String(r.text || '').replace(/\s+/g, ' ').trim(), language: CODE_OF[r.language] || 'en' });
  } catch (e) {
    console.error('[voice-service] transcribe failed:', e.message);
    return res.status(502).json({ error: 'The answer could not be heard' });
  }
});

// --- translate -------------------------------------------------------------------------------------------------------------
const LANG_NAME = { Telugu: 'Telugu (తెలుగు)', Hindi: 'Hindi (हिन्दी)', English: 'English' };
const translated = new Map(); // `${to}|${line}` -> line
function ollamaUrl() {
  const raw = String(process.env.AI_CALL_OLLAMA_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  try { const u = new URL(raw); return ['127.0.0.1', 'localhost', '::1'].includes(u.hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname) ? raw : null; } catch { return null; }
}
async function pickModel(url) {
  if (process.env.AI_CALL_TRANSLATE_MODEL) return String(process.env.AI_CALL_TRANSLATE_MODEL).trim();
  const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) });
  const j = r.ok ? await r.json() : null;
  const names = ((j && j.models) || []).map((m) => m.name);
  return names.find((n) => /llama|qwen|gemma|mistral/i.test(n)) || names[0] || '';
}
router.post('/translate', express.json({ limit: '256kb' }), async (req, res) => {
  const to = langOf(req.body && req.body.to);
  const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines.map((x) => String(x || '').slice(0, 1200)).slice(0, 60) : [];
  if (!to || !lines.length) return res.status(400).json({ error: 'Give lines and a language' });
  if (to === 'English') return res.json({ lines });
  const todo = [...new Set(lines.filter((l) => l.trim() && !translated.has(`${to}|${l}`)))];
  if (todo.length) {
    const url = ollamaUrl();
    if (!url) return res.status(503).json({ error: 'The local AI is not set up' });
    try {
      const model = await pickModel(url);
      if (!model) throw new Error('no model');
      const system = `You translate a job interviewer's questions for candidates in Hyderabad into ${LANG_NAME[to]}, the way people really speak: simple everyday words, polite, short. `
        + 'Technical words, product names, skills and job titles (Python, Django, SQL, API, project, team, experience, interview) stay in English letters. '
        + 'Reply with JSON only: {"lines":["..."]} - exactly one translated line for each input line, in the same order.';
      const r = await fetch(`${url}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, format: 'json', options: { temperature: 0.2 }, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ lines: todo }) }] }),
        signal: AbortSignal.timeout(Number(process.env.AI_CALL_TRANSLATE_TIMEOUT_MS) || 90000),
      });
      if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
      const j = await r.json();
      const out = JSON.parse(String((j && j.message && j.message.content) || '{}')).lines;
      if (!Array.isArray(out) || out.length !== todo.length) throw new Error('the translation did not have one line per line');
      todo.forEach((l, i) => { const t = String(out[i] || '').trim(); if (t) translated.set(`${to}|${l}`, t); });
      while (translated.size > 3000) translated.delete(translated.keys().next().value);
    } catch (e) {
      console.error('[voice-service] translate failed:', e.message);
      return res.status(502).json({ error: 'The translation could not be made' });
    }
  }
  return res.json({ lines: lines.map((l) => translated.get(`${to}|${l}`) || l) });
});

module.exports = router;
module.exports._test = { hearAnswer, langOf, allowed };
