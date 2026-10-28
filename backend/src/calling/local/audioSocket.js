// ---------------------------------------------------------------------------
// ASTERISK AUDIOSOCKET BRIDGE - the phone side of self-hosted AI calling (Synway gateway -> SIP -> Asterisk -> here).
//
// Asterisk's AudioSocket() application opens ONE TCP connection per call to this server and speaks a tiny framed protocol
// (docs.asterisk.org, "AudioSocket"): every frame is  kind (1 byte) + payload length (2 bytes, big-endian) + payload.
//   0x01 UUID   16 bytes - the id given in the dialplan: AudioSocket(${AICALL_UUID},127.0.0.1:<port>). It is the call's
//               AiCall."callSid", so the bridge knows which TeamLink call this is.
//   0x10 AUDIO  8 kHz 16-bit mono PCM (both ways; 20 ms = 320 bytes per frame)
//   0x03 DTMF   one key pressed
//   0x00 HANGUP the call ended (we send it to end the call after the last sentence)
//   0xff ERROR
//
// One call = caller's audio -> Vexyl STT (streaming, 16 kHz) -> each 'final' text -> voicebot.handleTurn (the SAME verified
// dialogue + outcome saving as every AI call) -> the sentence -> Vexyl TTS (cached) -> paced audio frames back to the caller.
// Barge-in: if the caller talks over the bot, the bot stops and listens. Silence: no words for AI_CALL_SILENCE_MS after the
// bot finished = a silent turn (the dialogue asks again, and ends the call after two).
// Nothing is logged with the caller's words; problems are written as AiCallEvent rows on the call.
// ---------------------------------------------------------------------------
const net = require('net');
const { cfg, sttLang } = require('./config');
const A = require('./audio');
const { SttStream } = require('./vexylStt');
const tts = require('./vexylTts');

const KIND = { HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10, ERROR: 0xff };
const FRAME_BYTES = 320; // 20 ms at 8 kHz
const FRAME_MS = 20;
const BARGE_RMS = 900; // loud enough to be speech on a phone line
const BARGE_FRAMES = 10; // 200 ms of it while the bot talks

const frame = (kind, payload = Buffer.alloc(0)) => Buffer.concat([Buffer.from([kind, (payload.length >> 8) & 0xff, payload.length & 0xff]), payload]);
const uuidOf = (b) => { const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };

// lazy: the bridge is loaded at start-up, the calling module only when a call comes in
const vb = () => require('../voicebot'); // eslint-disable-line global-require
const svc = () => require('../callService'); // eslint-disable-line global-require
const DB = () => require('../schema'); // eslint-disable-line global-require

async function note(callId, key, status, text) {
  try {
    await DB().run('INSERT OR IGNORE INTO "AiCallEvent" ("id","callId","eventKey","kind","status","note","applied","receivedAt") VALUES (?,?,?,?,?,?,0,?)',
      svc().newId('aie'), callId, `${key}:${callId}:${Date.now()}`, 'audiosocket', status, String(text).slice(0, 500), new Date().toISOString());
  } catch { /* the call goes on */ }
}

// THE CALL ENDED. Asterisk opens AudioSocket only on an ANSWERED call, so a bridge session that ran is a completed call - the
// same final step Exotel's "completed" callback takes (callService.applyProviderEvent): status, end time, duration, then
// outcomes.afterCompleted. A call already final (cancelled, or finished another way) is left alone.
async function completed(callId, durationSec, why) {
  const row = await svc().getCall(callId);
  if (!row || !['calling', 'queued'].includes(row.status)) return;
  await svc().setRow(callId, {
    status: 'completed', providerStatus: 'completed', endedAt: new Date().toISOString(), durationSec, waitReason: null, nextAttemptAt: null, failReason: null,
  });
  await note(callId, 'bridge-end', 'completed', `${why} after ${durationSec} s`);
  try { await require('../outcomes').afterCompleted(await svc().getCall(callId)); } catch (e) { await note(callId, 'outcome', 'error', e.message); } // eslint-disable-line global-require
}

class CallBridge {
  constructor(sock, opts = {}) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.row = null;
    this.token = null;
    this.stt = null;
    this.done = false; // the dialogue has ended
    this.ended = false; // the socket is finished
    this.playing = null; // { stop: bool }
    this.loud = 0;
    this.chain = Promise.resolve(); // one turn at a time
    this.silenceTimer = null;
    this.silenceMs = opts.silenceMs || cfg().silenceMs;
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => this.onEnd('socket closed'));
    sock.on('error', () => this.onEnd('socket error'));
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 3) {
      const len = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + len) break;
      const kind = this.buf[0];
      const payload = this.buf.subarray(3, 3 + len);
      this.buf = this.buf.subarray(3 + len);
      this.onFrame(kind, Buffer.from(payload));
    }
  }

  onFrame(kind, payload) {
    if (kind === KIND.UUID) { this.begin(uuidOf(payload)).catch((e) => this.fail(`start: ${e.message}`)); return; }
    if (kind === KIND.AUDIO) { this.onAudio(payload); return; }
    if (kind === KIND.HANGUP) { this.onEnd('caller hung up'); return; }
    if (kind === KIND.ERROR) this.onEnd('asterisk error');
  }

  async begin(uuid) {
    const row = await DB().one('SELECT * FROM "AiCall" WHERE "callSid" = ?', uuid);
    if (!row) { this.hangup(); return; }
    this.row = row;
    this.startedAt = Date.now();
    this.token = await svc().botTokenFor(row.id);
    this.stt = new SttStream({ lang: sttLang(row.language), sessionId: row.id });
    this.stt.on('final', (text) => this.turn({ text }));
    this.stt.on('sttError', (e) => note(row.id, 'stt-error', 'error', e.message));
    try { await this.stt.open(); } catch (e) { await this.fail(`speech to text is not available: ${e.message}`); return; }
    this.turn({ event: 'start' });
  }

  onAudio(pcm8k) {
    if (!this.stt || this.done) return;
    this.stt.write(A.resample(pcm8k, 8000, 16000));
    // barge-in: the caller talks over the bot -> stop talking, listen
    if (this.playing && !this.playing.stop) {
      this.loud = A.rms(pcm8k) >= BARGE_RMS ? this.loud + 1 : 0;
      if (this.loud >= BARGE_FRAMES) { this.playing.stop = true; this.loud = 0; }
    }
    if (A.rms(pcm8k) >= BARGE_RMS) this.clearSilence(); // they are talking: no "silence" turn
  }

  // body = { event:'start' } | { text } ; turns run one after another
  turn(body) {
    this.clearSilence();
    if (this.playing) this.playing.stop = true; // their words arrived: stop the bot
    this.chain = this.chain.then(async () => {
      if (this.done || this.ended) return;
      const r = await vb().handleTurn(this.token, body);
      if (r.status !== 200) { this.done = true; await this.fail(`turn refused: ${(r.body && r.body.error) || r.status}`); return; }
      if (r.body.done) this.done = true;
      if (r.body.say) await this.say(r.body.say);
      if (this.done) { this.hangup(); return; }
      this.armSilence();
    }).catch((e) => this.fail(`turn: ${e.message}`));
  }

  async say(text) {
    let pcm;
    try { pcm = await tts.pcm8k(text, this.row.language); } catch (e) { await this.fail(`text to speech is not available: ${e.message}`); return; }
    const me = { stop: false };
    this.playing = me;
    const t0 = Date.now();
    for (let i = 0, n = 0; i < pcm.length && !me.stop && !this.ended; i += FRAME_BYTES, n += 1) {
      const chunk = pcm.subarray(i, i + FRAME_BYTES);
      this.write(frame(KIND.AUDIO, chunk.length === FRAME_BYTES ? chunk : Buffer.concat([chunk, Buffer.alloc(FRAME_BYTES - chunk.length)])));
      const wait = t0 + (n + 1) * FRAME_MS - Date.now(); // real-time pace: the phone plays what it gets
      if (wait > 0) await new Promise((r) => setTimeout(r, wait)); // eslint-disable-line no-await-in-loop
    }
    if (this.playing === me) this.playing = null;
  }

  armSilence() {
    this.clearSilence();
    this.silenceTimer = setTimeout(() => { if (!this.done && !this.ended) this.turn({ text: '' }); }, this.silenceMs);
  }

  clearSilence() { if (this.silenceTimer) clearTimeout(this.silenceTimer); this.silenceTimer = null; }

  write(b) { if (!this.ended && this.sock.writable) this.sock.write(b); }

  hangup() { this.write(frame(KIND.HANGUP)); setTimeout(() => this.sock.end(), 100); }

  async fail(why) {
    if (this.row) await note(this.row.id, 'bridge-error', 'error', why);
    console.error(`[ai-calling] audiosocket ${this.row ? this.row.id : '-'}: ${why}`); // eslint-disable-line no-console
    this.hangup();
  }

  onEnd(why) {
    if (this.ended) return;
    this.ended = true;
    this.clearSilence();
    if (this.playing) this.playing.stop = true;
    const st = this.stt;
    if (this.row && !this.done) {
      this.done = true;
      this.chain = this.chain.then(() => vb().handleTurn(this.token, { event: 'stop' })).catch(() => {});
    }
    if (this.row) {
      const { id } = this.row;
      const secs = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
      this.chain = this.chain.then(() => completed(id, secs, why)).catch((e) => note(id, 'bridge-end', 'error', e.message));
    }
    this.chain.finally(() => st && st.close(1500));
  }
}

let server = null;
// Start listening (AI_CALL_AUDIOSOCKET_PORT). port 0 = any free port (tests). Returns the server.
function listen(port, host) {
  if (server) return server;
  server = net.createServer((sock) => { sock.setNoDelay(true); new CallBridge(sock); }); // eslint-disable-line no-new
  server.listen(port, host || '127.0.0.1');
  return server;
}
function close() { if (server) { server.close(); server = null; } }

module.exports = { listen, close, CallBridge, frame, KIND, uuidOf, FRAME_BYTES };
