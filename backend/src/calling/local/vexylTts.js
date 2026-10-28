// ---------------------------------------------------------------------------
// VEXYL TTS (self-hosted text to speech) - the documented WebSocket protocol (github.com/vexyl-ai/vexyl-tts, vexyl_tts_server.py):
//   connect (X-API-Key header when the server has VEXYL_TTS_API_KEY)  <- {type:'ready', model, sample_rate, languages}
//   -> {type:'synthesize', text, lang:'te-IN', style:'default'|'warm'|'formal', request_id}
//   <- {type:'audio', request_id, audio_b64 (a WAV file), sample_rate, cached, latency_ms}  or  {type:'error', request_id, message}
// Run the server with VEXYL_TTS_SAMPLE_RATE=8000 for the phone; any other rate is converted here.
//
// SPEED: one sentence takes 1-3 s even on a graphics card, so every rendered sentence is KEPT (memory, and AI_CALL_TTS_CACHE_DIR
// when set). The bot's sentences are fixed text, so after the first calls almost every line is already audio; prewarm() renders a
// call's lines before the phone rings.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { cfg, ttsLang } = require('./config');
const A = require('./audio');

let WS = null;
function wsLib() { if (!WS) WS = require('ws'); return WS; } // eslint-disable-line global-require

const MAX_MEM = 600;
const mem = new Map(); // key -> 8 kHz PCM
const stats = { rendered: 0, fromCache: 0 };
const keyOf = (text, lang, style) => crypto.createHash('sha1').update(`${lang}|${style}|${text}`).digest('hex');

// text -> { wav, sampleRate } straight from the server.
function render(text, lang, style, timeoutMs = 45000) {
  const c = cfg().tts;
  if (!c.ok) return Promise.reject(new Error(`Vexyl TTS address: ${c.error}`));
  return new Promise((resolve, reject) => {
    const ws = new (wsLib())(c.url, { headers: c.key ? { 'X-API-Key': c.key } : {}, handshakeTimeout: 8000, maxPayload: 50 * 1024 * 1024 });
    const id = `tl_${crypto.randomBytes(6).toString('hex')}`;
    let settled = false;
    const end = (err, val) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(1000); } catch { /* gone */ } if (err) reject(err); else resolve(val); };
    const timer = setTimeout(() => end(new Error('Vexyl TTS did not answer in time')), timeoutMs);
    ws.on('message', (raw) => {
      let m = null;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'ready') ws.send(JSON.stringify({ type: 'synthesize', text, lang, style, request_id: id }));
      else if (m.type === 'audio' && (!m.request_id || m.request_id === id)) end(null, { wav: Buffer.from(String(m.audio_b64 || ''), 'base64'), sampleRate: Number(m.sample_rate) || null });
      else if (m.type === 'error' && (!m.request_id || m.request_id === id)) end(new Error(`Vexyl TTS: ${m.message || 'error'}`));
    });
    ws.on('error', (e) => end(e));
    ws.on('close', (code) => end(new Error(`Vexyl TTS closed (${code})`)));
  });
}

function diskPath(key) { const d = cfg().tts.cacheDir; return d ? path.join(d, `${key}.wav`) : null; }
function remember(key, pcm) {
  if (mem.size >= MAX_MEM) mem.delete(mem.keys().next().value);
  mem.set(key, pcm);
}

// A sentence -> 8 kHz 16-bit mono PCM for the phone.
async function pcm8k(text, language) {
  const t = String(text || '').trim();
  if (!t) return Buffer.alloc(0);
  const c = cfg().tts;
  const lang = ttsLang(language);
  const key = keyOf(t, lang, c.style);
  if (mem.has(key)) { stats.fromCache += 1; const v = mem.get(key); mem.delete(key); mem.set(key, v); return v; }
  const file = diskPath(key);
  if (file) {
    try { const pcm = A.parseWav(fs.readFileSync(file)).pcm; remember(key, pcm); stats.fromCache += 1; return pcm; } catch { /* not on disk yet */ }
  }
  const r = await render(t, lang, c.style);
  const w = A.parseWav(r.wav);
  const pcm = A.resample(w.pcm, w.sampleRate, 8000);
  stats.rendered += 1;
  remember(key, pcm);
  if (file) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, A.toWav(pcm, 8000)); } catch { /* the memory copy is enough */ } }
  return pcm;
}

// Render sentences ahead of a call, one after the other (the server is slow; never hammer it). Never throws.
async function prewarm(texts, language) {
  let ok = 0; const failed = [];
  for (const t of [...new Set((texts || []).map((x) => String(x || '').trim()).filter(Boolean))]) {
    try { await pcm8k(t, language); ok += 1; } catch (e) { failed.push(e.message); } // eslint-disable-line no-await-in-loop
  }
  return { ok, failed };
}

async function health() {
  const c = cfg().tts;
  if (!c.ok) return { ok: false, message: `Vexyl TTS: ${c.error}` };
  try {
    const r = await render('Hello', 'en-IN', c.style, 60000);
    return { ok: true, message: `Vexyl TTS ready (${r.sampleRate || '?'} Hz${r.sampleRate && r.sampleRate !== 8000 ? ' - set VEXYL_TTS_SAMPLE_RATE=8000 for the phone' : ''})` };
  } catch (e) { return { ok: false, message: `Vexyl TTS did not answer at ${c.url}: ${e.message}` }; }
}

module.exports = { pcm8k, prewarm, render, health, stats, _mem: mem };
