// ---------------------------------------------------------------------------
// THE FREE VOICE ENGINES of AI phone calls (user, 2026-10-28: "everything free except the SIM / call charges").
// All run on our own machine; the gateway only talks to them over local sockets, so TeamLink gets no heavy libraries.
//
//   VEXYL-TTS   (Apache-2.0; AI4Bharat Indic Parler-TTS) speaking - Telugu / Hindi / English   ws://127.0.0.1:8092
//   VEXYL-STT   (Apache-2.0; AI4Bharat IndicConformer)   listening - Telugu / Hindi           ws://127.0.0.1:8091
//   Whisper     (MIT; faster-whisper, deploy/ai-voice/whisper_server.py)  listening - English + "which language is this?"  http://127.0.0.1:8093
//   Piper       (MIT) speaking - Telugu / English, a local program (AI_VOICE_PIPER_*)
//   Kokoro      (Apache-2.0 weights; deploy/ai-voice/kokoro_server.py) speaking - Hindi (Piper has no free Hindi voice)  http://127.0.0.1:8094
//
// One interface for the gateway:  tts(text, lang) -> 8 kHz PCM   stt(pcm8k, lang) -> text   detect(pcm8k) -> lang | null
// lang is the ATS word: 'English' | 'Telugu' | 'Hindi'. Settings: AI_VOICE_TTS_URL, AI_VOICE_STT_URL, AI_VOICE_WHISPER_URL,
// AI_VOICE_KEY (the shared X-API-Key of the three servers), AI_VOICE_STYLE (default | warm | formal).
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const CODE = { English: 'en-IN', Telugu: 'te-IN', Hindi: 'hi-IN' };
const FROM_ISO = { en: 'English', te: 'Telugu', hi: 'Hindi' };

// --- audio helpers -------------------------------------------------------------------------------------------------------
// WAV (any rate, 16-bit mono) -> { pcm, rate }
function wavToPcm(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return { pcm: buf, rate: 8000 };
  let rate = 8000; let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    if (id === 'data') return { pcm: buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)), rate };
    off += 8 + size + (size % 2);
  }
  return { pcm: Buffer.alloc(0), rate };
}
// 16-bit mono PCM, linear resampling (enough for speech on a phone line)
// Going DOWN (Piper 22 kHz / Kokoro 24 kHz -> 8 kHz phone) needs a low-pass first, or the high sounds fold back as a
// harsh hiss on the line (heard on the first real calls, 2026-10-28): windowed-sinc filter at ~3.6 kHz. Going up: linear.
function resample(pcm, from, to) {
  if (from === to) return pcm;
  const n = Math.floor(pcm.length / 2); const m = Math.max(1, Math.floor((n * to) / from));
  const out = Buffer.alloc(m * 2);
  if (from > to) {
    const ratio = from / to; const fc = (0.45 * to) / from; const half = Math.ceil(8 * ratio);
    const x = new Float32Array(n); for (let i = 0; i < n; i += 1) x[i] = pcm.readInt16LE(i * 2);
    for (let i = 0; i < m; i += 1) {
      const c = i * ratio; const c0 = Math.floor(c); let acc = 0; let wsum = 0;
      for (let k = c0 - half + 1; k <= c0 + half; k += 1) {
        if (k >= 0 && k < n) {
          const d = k - c; const t = 2 * fc * d;
          const w = (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * (0.5 + 0.5 * Math.cos((Math.PI * d) / (half + 1)));
          acc += x[k] * w; wsum += w;
        }
      }
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(wsum ? acc / wsum : 0))), i * 2);
    }
    return out;
  }
  for (let i = 0; i < m; i += 1) {
    const x = (i * from) / to; const a = Math.floor(x); const b = Math.min(n - 1, a + 1); const f = x - a;
    const s = (1 - f) * pcm.readInt16LE(Math.min(n - 1, a) * 2) + f * pcm.readInt16LE(b * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}
const silence = (ms) => Buffer.alloc(Math.round((8000 * ms) / 1000) * 2);
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// --- VEXYL-TTS: one kept-open WebSocket, many requests (request_id) ---------------------------------------------------------
function vexylTts({ url, key, style }) {
  const WS = require('ws'); // eslint-disable-line global-require
  let ws = null; let ready = null; const waiting = new Map();
  function open() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      ws = new WS(url, { headers: key ? { 'X-API-Key': key } : {} });
      const t = setTimeout(() => reject(new Error('VEXYL-TTS did not answer')), 15000);
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === 'ready') { clearTimeout(t); resolve(); return; }
        const w = m.request_id && waiting.get(m.request_id);
        if (!w) return;
        waiting.delete(m.request_id);
        if (m.type === 'audio') {
          const { pcm, rate } = wavToPcm(Buffer.from(m.audio_b64 || '', 'base64'));
          w.resolve(resample(pcm, m.sample_rate || rate, 8000));
        } else w.reject(new Error(m.message || 'TTS error'));
      });
      const down = (e) => { clearTimeout(t); ready = null; for (const w of waiting.values()) w.reject(e || new Error('VEXYL-TTS closed')); waiting.clear(); reject(e || new Error('VEXYL-TTS closed')); };
      ws.on('error', down); ws.on('close', () => down());
    });
    return ready;
  }
  return async (text, lang) => {
    await open();
    const id = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new Error('VEXYL-TTS took too long')); }, 120000);
      waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      ws.send(JSON.stringify({ type: 'synthesize', text, lang: CODE[lang] || 'en-IN', style: style || 'default', request_id: id }));
    });
  };
}

// --- VEXYL-STT: one session per sentence (start -> 16 kHz audio -> stop -> finals) -------------------------------------------
function vexylStt({ url, key }) {
  const WS = require('ws'); // eslint-disable-line global-require
  return (pcm8k, lang) => new Promise((resolve, reject) => {
    const ws = new WS(url, { headers: key ? { 'X-API-Key': key } : {} });
    const parts = [];
    const t = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error('VEXYL-STT took too long')); }, 60000);
    const done = (fn, v) => { clearTimeout(t); try { ws.close(); } catch { /* */ } fn(v); };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'ready') ws.send(JSON.stringify({ type: 'start', lang: CODE[lang] || 'hi-IN', session_id: crypto.randomBytes(4).toString('hex') }));
      else if (m.type === 'started') {
        const pcm16 = resample(pcm8k, 8000, 16000);
        for (let i = 0; i < pcm16.length; i += 3200) ws.send(pcm16.subarray(i, i + 3200));
        ws.send(JSON.stringify({ type: 'stop' }));
      } else if (m.type === 'final') { if (m.text) parts.push(String(m.text).trim()); } else if (m.type === 'stopped') done(resolve, parts.join(' ').trim());
      else if (m.type === 'error') done(reject, new Error(m.message || 'STT error'));
    });
    ws.on('error', (e) => done(reject, e));
  });
}

// --- Whisper (English, and which language a sentence is in): voice-ai/whisper/whisper_server.py ----------------------------
// the question for Whisper's prompt: plain English, the last 200 characters (the question is at the end of what was said)
function promptHeader(prompt) {
  const t = String(prompt || '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(-200);
  return t ? { 'X-Prompt': encodeURIComponent(t) } : {};
}
function whisperHttp({ url, key }) {
  const post = async (path, pcm8k, extra) => {
    const r = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(key ? { 'X-API-Key': key } : {}), ...(extra || {}) },
      body: resample(pcm8k, 8000, 16000),
    });
    if (!r.ok) throw new Error(`Whisper ${r.status}`);
    return r.json();
  };
  return {
    // minProb: how sure Whisper must be before the assistant switches (stricter for short answers)
    detect: async (pcm8k, minProb = 0.7) => { const j = await post('/detect', pcm8k); return j.prob >= minProb ? (FROM_ISO[j.lang] || null) : null; },
    // English mode in one pass: { lang: 'Telugu' | 'Hindi' | 'English', text } - the English words only when it is English
    // conf: Whisper's own sureness of the words ({ logprob, noSpeech, ratio }, whisper_server.py); null from an older server
    // prompt: the question the assistant just asked (English); Whisper hears a short answer far better knowing it (2026-10-29)
    hear: async (pcm8k, minProb = 0.6, prompt = '') => { const j = await post('/hear', pcm8k, { 'X-Min-Prob': String(minProb), ...promptHeader(prompt) }); return { lang: FROM_ISO[j.lang] || 'English', text: j.text || '', conf: j.conf || null, prob: typeof j.prob === 'number' ? j.prob : null }; },
    // lang 'auto': Whisper writes what it hears in the language it hears (Telugu / Hindi letters = the person switched)
    stt: async (pcm8k, lang) => (await post('/transcribe', pcm8k, { 'X-Lang': lang === 'auto' ? 'auto' : (CODE[lang] || 'en-IN').slice(0, 2) })).text || '',
    // how much real speech the clip holds (Silero VAD on the server): { speechMs, parts }; an older server has no /speech -> null
    speech: async (pcm8k) => { try { return await post('/speech', pcm8k); } catch { return null; } },
    // the same, with the sureness: { text, conf }
    sttEx: async (pcm8k, lang, prompt = '') => { const j = await post('/transcribe', pcm8k, { 'X-Lang': (CODE[lang] || 'en-IN').slice(0, 2), ...(lang === 'English' ? promptHeader(prompt) : {}) }); return { text: j.text || '', conf: j.conf || null }; },
  };
}

// --- Kokoro (Hindi speaking): POST /speak {text, voice, lang, speed} -> WAV -------------------------------------------------
function kokoroHttp({ url, key, voice, speed = 1.1 }) {
  return async (text) => {
    const r = await fetch(`${url}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
      body: JSON.stringify({ text, voice, lang: 'hi', speed }),
    });
    if (!r.ok) throw new Error(`Kokoro ${r.status}`);
    const w = wavToPcm(Buffer.from(await r.arrayBuffer()));
    return resample(w.pcm, w.rate, 8000);
  };
}

// --- Piper (MIT, rhasspy/piper): light, fast on a normal CPU. One process per voice stays loaded (--json-input). -----------
// Voices free for business use (checked 2026-10-28): Telugu padmavathi / venkatesh (IndicVoices-R, CC-BY-4.0: credit
// "AI4Bharat IndicVoices-R" in the product notes), English ljspeech (public domain). No free Hindi Piper voice yet.
// lengthScale: speaking speed (1 = the voice's own pace, lower = faster). The Telugu voices are slow at 1 (user, 2026-10-28).
// lengthScale: a number, or one per language ({ English: 1, Telugu: 0.9 })
function piperTts({ exe, voices, lengthScale = 0.75 }) {
  const scaleOf = (lang) => (typeof lengthScale === 'object' && lengthScale ? (lengthScale[lang] || 1) : lengthScale);
  const path = require('path'); const fs = require('fs'); const os = require('os'); const { spawn } = require('child_process'); // eslint-disable-line global-require
  const procs = {};
  function procFor(lang) {
    if (procs[lang] && !procs[lang].dead) return procs[lang];
    const p = spawn(exe, ['-m', voices[lang], '--json-input', '--sentence_silence', '0.05', '--length_scale', String(scaleOf(lang))], { cwd: path.dirname(exe), windowsHide: true });
    const st = { p, queue: [], dead: false, buf: '' };
    p.stdout.on('data', (d) => {
      st.buf += String(d);
      let i;
      while ((i = st.buf.indexOf('\n')) >= 0) { // Piper prints the file it wrote, one line per request, in order
        const line = st.buf.slice(0, i).trim(); st.buf = st.buf.slice(i + 1);
        const w = line && st.queue.shift(); if (w) w.resolve(line);
      }
    });
    p.stderr.on('data', () => {});
    p.on('exit', () => { st.dead = true; st.queue.splice(0).forEach((w) => w.reject(new Error('Piper stopped'))); });
    procs[lang] = st;
    return st;
  }
  return async (text, lang) => {
    if (!voices[lang]) throw new Error(`No free Piper voice for ${lang}`);
    const st = procFor(lang);
    const out = path.join(os.tmpdir(), `tl-piper-${crypto.randomBytes(6).toString('hex')}.wav`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Piper took too long')), 30000);
      st.queue.push({ resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      st.p.stdin.write(`${JSON.stringify({ text: String(text), output_file: out })}\n`);
    });
    const { pcm, rate } = wavToPcm(fs.readFileSync(out));
    fs.unlink(out, () => {});
    return resample(pcm, rate, 8000);
  };
}

// --- the set the gateway uses ---------------------------------------------------------------------------------------------
// AI_VOICE_TTS = piper (default when AI_VOICE_PIPER_EXE is set) | vexyl. Piper voices: AI_VOICE_PIPER_TELUGU / _ENGLISH / _HINDI (.onnx).
function fromEnv(env = process.env) {
  const key = env.AI_VOICE_KEY || '';
  const usePiper = (env.AI_VOICE_TTS || (env.AI_VOICE_PIPER_EXE ? 'piper' : 'vexyl')) === 'piper';
  const tts = usePiper
    ? piperTts({
      exe: env.AI_VOICE_PIPER_EXE,
      voices: { Telugu: env.AI_VOICE_PIPER_TELUGU, English: env.AI_VOICE_PIPER_ENGLISH, Hindi: env.AI_VOICE_PIPER_HINDI },
      // 2026-10-29 "fast ga matladthundhi": English at the voice's own pace, Telugu a little quicker (its voice is slow at 1).
      // AI_VOICE_SPEED_ENGLISH / _TELUGU (0.65 fast ... 1.2 slow); the old single AI_VOICE_SPEED no longer speeds up English.
      lengthScale: {
        English: Number(env.AI_VOICE_SPEED_ENGLISH) > 0 ? Number(env.AI_VOICE_SPEED_ENGLISH) : 1,
        Telugu: Number(env.AI_VOICE_SPEED_TELUGU) > 0 ? Number(env.AI_VOICE_SPEED_TELUGU) : 0.9,
        Hindi: Number(env.AI_VOICE_SPEED_HINDI) > 0 ? Number(env.AI_VOICE_SPEED_HINDI) : 1,
      },
    })
    : vexylTts({ url: env.AI_VOICE_TTS_URL || 'ws://127.0.0.1:8092', key, style: env.AI_VOICE_STYLE });
  // HINDI VOICE (2026-10-30: "gaps lekunda"): the Piper Hindi voice (AI_VOICE_PIPER_HINDI) runs faster than real time on the
  // CPU; Kokoro took 2-3 s a sentence and left gaps. Piper is used when its voice is set; AI_VOICE_HINDI=kokoro goes back.
  const piperHindi = usePiper && env.AI_VOICE_PIPER_HINDI && env.AI_VOICE_HINDI !== 'kokoro';
  const hindi = env.AI_VOICE_KOKORO_URL && !piperHindi ? kokoroHttp({ url: env.AI_VOICE_KOKORO_URL, key, voice: env.AI_VOICE_KOKORO_VOICE || undefined, speed: Number(env.AI_VOICE_SPEED_HINDI) > 0 ? Number(env.AI_VOICE_SPEED_HINDI) : 1 }) : null;
  const vstt = vexylStt({ url: env.AI_VOICE_STT_URL || 'ws://127.0.0.1:8091', key });
  const wh = env.AI_VOICE_WHISPER_URL ? whisperHttp({ url: env.AI_VOICE_WHISPER_URL, key }) : null;
  return {
    name: `free (${usePiper ? 'Piper' : 'VEXYL-TTS'}${hindi ? ' + Kokoro Hindi' : ''} + VEXYL-STT${wh ? ' + Whisper' : ''})`,
    tts: (text, lang) => (lang === 'Hindi' && hindi ? hindi(text) : tts(text, lang)),
    // English goes to Whisper; Telugu / Hindi to VEXYL-STT. Without Whisper, English is heard through the Hindi model
    // (IndicConformer has no English) - set AI_VOICE_WHISPER_URL for English calls.
    stt: (pcm, lang) => (lang === 'English' && wh ? wh.stt(pcm, 'English') : vstt(pcm, lang === 'English' ? 'Hindi' : lang)),
    // { text, conf }: conf only from Whisper (English); IndicConformer gives no sureness, so Telugu / Hindi get null - never a made-up number
    sttEx: async (pcm, lang, prompt) => (lang === 'English' && wh ? wh.sttEx(pcm, 'English', prompt) : { text: await vstt(pcm, lang === 'English' ? 'Hindi' : lang), conf: null }),
    detect: wh ? wh.detect : null,
    speech: wh ? wh.speech : null,
    sttAny: wh ? (pcm) => wh.stt(pcm, 'auto') : null,
    hear: wh ? wh.hear : null,
    warmup: () => vstt(silence(500), 'Telugu'), // load the speech model before the first caller
  };
}

// Test engines (no models): the "caller" says the lines of a script; speech is silence of a matching length.
function scripted(lines) {
  const q = lines.slice();
  return {
    name: 'scripted test',
    tts: async (text) => silence(Math.min(2000, 20 * String(text).length)),
    stt: async () => (q.length ? q.shift() : ''),
    detect: null,
    said: () => lines.length - q.length,
  };
}

module.exports = {
  kokoroHttp, fromEnv, scripted, vexylTts, vexylStt, whisperHttp, piperTts, wavToPcm, pcmToWav, resample, silence, CODE };
