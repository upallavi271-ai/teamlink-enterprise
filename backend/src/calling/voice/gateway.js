// ---------------------------------------------------------------------------
// THE AI VOICE GATEWAY (2026-10-28) - a real phone call <-> the AI assistant, with free engines only.
//
//   Asterisk (free phone system, the SIP trunk) --AudioSocket TCP--> this gateway
//     listen   : Vad finds each sentence the person says (and when they start talking, to stop the assistant: barge-in)
//     language : engines.detect (Whisper) says which language the sentence is in, when it is set up
//     text     : engines.stt (VEXYL-STT Telugu / Hindi, Whisper English)
//     brain    : dialogue.js - the SAME assistant and rules as the free AI link (language switch, upset, later, honesty)
//     speak    : engines.tts (VEXYL-TTS) sentence by sentence; the first sentence plays while the next is being made;
//                every sentence is kept (cache) so fixed sentences cost nothing the next time
//     result   : outcomes.js - answers, outcome, next step, "Talked for ..." on the candidate's history
//
// A call is found by the UUID Asterisk sends first: AiCall.callSid = that UUID, initiatedVia 'sip' (set when the call is
// placed). Off unless AI_VOICE_GATEWAY=1 (index.js); listens on 127.0.0.1 only (AI_VOICE_GATEWAY_PORT, default 9092).
// ---------------------------------------------------------------------------
const net = require('net');
const A = require('./audioSocket');
const { Vad } = require('./vad');
const E = require('./engines');
const svc = require('../callService');

const VIA = 'sip';
const GAP_MS = 80; // a short breath between sentences (kept short: a slow assistant sounds unnatural)
const cache = new Map(); // `${lang}|${sentence}` -> 8 kHz PCM
const CACHE_MAX = 3000;
const log = (...a) => console.log('[ai-voice]', ...a); // eslint-disable-line no-console

const sentences = (text) => String(text || '').split(/(?<=[.?!।])\s+/).map((s) => s.trim()).filter(Boolean);
const talkTime = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`);

async function voiceOf(engines, sentence, lang) {
  const k = `${lang}|${sentence}`;
  if (cache.has(k)) return cache.get(k);
  const pcm = await engines.tts(sentence, lang);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, pcm);
  return pcm;
}

// Make every sentence of one call before it is dialled (we know the name, job, date): no waiting during the call.
async function prepare(engines, lines, lang) {
  for (const l of lines) for (const s of sentences(l)) await voiceOf(engines, s, lang); // eslint-disable-line no-await-in-loop
}

// Plays PCM to Asterisk at real-time pace (20 ms frames). stop() = silence at once (barge-in).
class Speaker {
  constructor(sock) { this.sock = sock; this.queue = []; this.timer = null; this.onIdle = null; this.sent = 0; }
  get busy() { return this.queue.length > 0; }
  add(pcm) {
    for (let i = 0; i < pcm.length; i += A.FRAME_BYTES) {
      const f = Buffer.alloc(A.FRAME_BYTES); pcm.copy(f, 0, i, Math.min(pcm.length, i + A.FRAME_BYTES)); this.queue.push(f);
    }
    if (!this.timer) this.timer = setInterval(() => this.tick(), A.FRAME_MS);
  }
  tick() {
    const f = this.queue.shift();
    if (f && !this.sock.destroyed) { this.sock.write(A.encode(A.KIND.AUDIO, f)); this.sent += 1; }
    if (!this.queue.length) { clearInterval(this.timer); this.timer = null; const cb = this.onIdle; this.onIdle = null; if (cb) cb(); }
  }
  stop() { this.queue = []; if (this.timer) { clearInterval(this.timer); this.timer = null; } const cb = this.onIdle; this.onIdle = null; if (cb) cb(); }
  whenIdle() { return this.busy || this.timer ? new Promise((r) => { this.onIdle = r; }) : Promise.resolve(); }
}

async function finish(row, d, why) {
  const result = why ? d.hangup(why) : d.outcome();
  const t = new Date();
  const durationSec = row.startedAt ? Math.max(0, Math.round((t - new Date(row.startedAt)) / 1000)) : null;
  if (durationSec != null) result.summary = `${result.summary} Talked for ${talkTime(durationSec)} (AI phone call).`.slice(0, 600);
  await svc.setRow(row.id, { botStateJson: JSON.stringify({ ...d.snapshot(), done: true }), status: 'completed', language: d.language, endedAt: t.toISOString(), durationSec, providerStatus: 'audiosocket' });
  await require('../outcomes').applyResult(row.id, result, d.transcript()); // eslint-disable-line global-require
  return result;
}

// One phone call.
function handle(sock, engines, opts = {}) {
  const reader = new A.Reader();
  const speaker = new Speaker(sock);
  let row = null; let d = null; let ended = false; let saved = false; let busy = false; let pending = null; let gen = 0;
  // the result is saved exactly once: at the assistant's own goodbye, or when the line drops (even during that goodbye)
  const save = (why) => { if (saved || !row || !d) return null; saved = true; return finish(row, d, why).catch((e) => log('finish failed:', e.message)); };
  const hangup = () => { if (!sock.destroyed) { sock.write(A.encode(A.KIND.HANGUP)); sock.end(); } };

  async function say(text) {
    const my = ++gen; // a newer reply (or a barge-in) cancels the rest of this one
    for (const s of sentences(text)) {
      let pcm;
      try { pcm = await voiceOf(engines, s, d.language); } catch (e) { log('tts failed:', e.message); continue; } // eslint-disable-line no-await-in-loop
      if (my !== gen || sock.destroyed) return;
      speaker.add(pcm); speaker.add(E.silence(GAP_MS));
    }
  }

  async function heard(pcm) {
    if (ended || !d) return;
    if (busy) { pending = pcm; return; } // keep only the latest sentence said while we were still thinking
    busy = true;
    try {
      // which language + the words, at the same time; only when the person really switched is it heard again in the new one
      // (a clip under ~2 s with its end pause - "yes", "haan theek" - is too short to tell a language by sound)
      const cur = d.language;
      const listen = (l) => engines.stt(pcm, l).catch((e) => { log('stt failed:', e.message); return ''; });
      const [found, first] = await Promise.all([
        engines.detect && pcm.length >= A.RATE * 2 * 2 ? engines.detect(pcm).catch((e) => { log('detect failed:', e.message); return null; }) : null,
        listen(cur),
      ]);
      const lang = found || cur;
      const text = lang === cur ? first : await listen(lang);
      if (opts.onHeard) opts.onHeard(text, lang);
      const out = await d.hear(text);
      await svc.setRow(row.id, { botStateJson: JSON.stringify({ ...d.snapshot(), done: !!out.done }) });
      await say(out.say);
      if (out.done) {
        ended = true;
        await speaker.whenIdle();
        await save();
        hangup();
      }
    } finally {
      busy = false;
      if (pending && !ended) { const p = pending; pending = null; heard(p); }
    }
  }

  const vad = new Vad({
    onStart: () => { if (speaker.busy) { gen += 1; speaker.stop(); if (opts.onBargeIn) opts.onBargeIn(); } }, // the person talks: the assistant stops at once
    onEnd: (pcm) => { heard(pcm); },
  });

  async function begin(uuid) {
    row = await require('../schema').one('SELECT * FROM "AiCall" WHERE "callSid" = ? AND "initiatedVia" = ?', uuid, VIA); // eslint-disable-line global-require
    if (!row || !['calling', 'queued'].includes(row.status)) { log('unknown call', uuid); hangup(); return; }
    d = await require('../webTalk').dialogueFor(row); // eslint-disable-line global-require
    if (!d) { hangup(); return; }
    const at = new Date().toISOString();
    await svc.setRow(row.id, { status: 'calling', startedAt: at, providerStatus: 'answered' });
    row.startedAt = at;
    const first = d.start();
    await svc.setRow(row.id, { botStateJson: JSON.stringify({ ...d.snapshot(), done: false }) });
    if (opts.onStart) opts.onStart(row);
    await say(first.say);
  }

  sock.on('data', (chunk) => {
    for (const m of reader.feed(chunk)) {
      if (m.kind === A.KIND.UUID) begin(A.uuidText(m.payload)).catch((e) => { log('start failed:', e.message); hangup(); });
      else if (m.kind === A.KIND.AUDIO) { for (let i = 0; i + A.FRAME_BYTES <= m.payload.length; i += A.FRAME_BYTES) vad.push(m.payload.subarray(i, i + A.FRAME_BYTES)); }
      else if (m.kind === A.KIND.HANGUP) sock.end();
    }
  });
  sock.on('close', () => {
    speaker.stop();
    if (!ended) { ended = true; save('the person hung up'); } else save(); // cut during the goodbye: the assistant had finished, keep its result
    if (opts.onClose) opts.onClose();
  });
  sock.on('error', () => {});
}

let ENGINES = null; // the engines the running gateway uses (sipCall.js makes the first sentences with them before dialling)
function start({ host = '127.0.0.1', port = 9092, engines = E.fromEnv(), ...opts } = {}) {
  ENGINES = engines;
  // warm the speech models once, so the first caller of the day does not wait for them to load
  if (engines.warmup) Promise.resolve().then(engines.warmup).catch(() => {});
  const server = net.createServer((sock) => handle(sock, engines, opts));
  return new Promise((resolve) => server.listen(port, host, () => { log(`listening on ${host}:${server.address().port} (${engines.name})`); resolve(server); }));
}

module.exports = { start, handle, prepare, sentences, VIA, engines: () => ENGINES || (ENGINES = E.fromEnv()), _cache: cache };
