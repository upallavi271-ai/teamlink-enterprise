// ---------------------------------------------------------------------------
// VEXYL STT (self-hosted speech to text) - the documented WebSocket protocol (github.com/vexyl-ai/vexyl-stt, vexyl_stt_server.py):
//   connect (X-API-Key header when the server has VEXYL_STT_API_KEY)  <- {type:'ready', model}
//   -> {type:'start', lang:'te-IN', session_id}                       <- {type:'started', session_id, lang}
//   -> binary frames: raw 16 kHz 16-bit mono PCM                       <- {type:'final', text, lang, duration, latency_ms} per utterance
//   -> {type:'stop'}                                                   <- {type:'final', ..., flushed:true}? then {type:'stopped'}
//   errors: {type:'error', message}; a full server closes with 1013 "Server at capacity".
// The server cuts the utterances itself; there is no partial text.
// ---------------------------------------------------------------------------
const { EventEmitter } = require('events');
const { cfg } = require('./config');

let WS = null;
function wsLib() { if (!WS) WS = require('ws'); return WS; } // eslint-disable-line global-require

// One open STT session for a whole call: write() audio as it arrives, 'final' events carry the words.
class SttStream extends EventEmitter {
  constructor({ lang, sessionId }) {
    super();
    this.lang = lang;
    this.sessionId = String(sessionId || `call_${Date.now().toString(36)}`).replace(/\W/g, '_').slice(0, 64);
    this.ws = null;
    this.started = false;
    this.closed = false;
  }

  open(timeoutMs = 8000) {
    const c = cfg().stt;
    if (!c.ok) return Promise.reject(new Error(`Vexyl STT address: ${c.error}`));
    return new Promise((resolve, reject) => {
      const ws = new (wsLib())(c.url, { headers: c.key ? { 'X-API-Key': c.key } : {}, handshakeTimeout: timeoutMs, maxPayload: 10 * 1024 * 1024 });
      this.ws = ws;
      const timer = setTimeout(() => { reject(new Error('Vexyl STT did not start in time')); ws.terminate(); }, timeoutMs);
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let m = null;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === 'ready') ws.send(JSON.stringify({ type: 'start', lang: this.lang, session_id: this.sessionId }));
        else if (m.type === 'started') { this.started = true; clearTimeout(timer); resolve(this); } else if (m.type === 'final') {
          const text = String(m.text || '').trim();
          if (text) this.emit('final', text, { flushed: !!m.flushed, latencyMs: m.latency_ms });
        } else if (m.type === 'stopped') this.emit('stopped');
        else if (m.type === 'error') this.emit('sttError', new Error(`Vexyl STT: ${m.message || 'error'}`));
      });
      ws.on('error', (e) => { clearTimeout(timer); if (!this.started) reject(e); else this.emit('sttError', e); });
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.closed = true;
        if (!this.started) reject(new Error(`Vexyl STT closed (${code}${reason ? ` ${reason}` : ''})`));
        this.emit('closed', code);
      });
    });
  }

  write(pcm16k) {
    if (this.started && !this.closed && this.ws && this.ws.readyState === 1 && pcm16k && pcm16k.length) this.ws.send(pcm16k, { binary: true });
  }

  // Flush what was said last and close. Resolves once the server said 'stopped' (or after a short wait).
  close(waitMs = 4000) {
    return new Promise((resolve) => {
      if (!this.ws || this.closed) { resolve(); return; }
      const done = () => { clearTimeout(t); try { this.ws.close(1000); } catch { /* gone */ } resolve(); };
      const t = setTimeout(done, waitMs);
      this.once('stopped', done);
      this.once('closed', done);
      try { this.ws.send(JSON.stringify({ type: 'stop' })); } catch { done(); }
    });
  }
}

// One piece of audio -> its words (all 'final' texts joined). For the Exotel voicebot path, which hands over finished chunks.
async function transcribeOnce(pcm16k, lang, timeoutMs = 15000) {
  const s = new SttStream({ lang, sessionId: `once_${Date.now().toString(36)}` });
  const parts = [];
  s.on('final', (t) => parts.push(t));
  await s.open();
  s.write(pcm16k);
  await s.close(timeoutMs);
  return parts.join(' ').trim();
}

async function health() {
  const c = cfg().stt;
  if (!c.ok) return { ok: false, message: `Vexyl STT: ${c.error}` };
  try { const s = new SttStream({ lang: 'te-IN', sessionId: 'health' }); await s.open(5000); await s.close(2000); return { ok: true, message: 'Vexyl STT ready' }; } catch (e) { return { ok: false, message: `Vexyl STT did not answer at ${c.url}: ${e.message}` }; }
}

module.exports = { SttStream, transcribeOnce, health };
