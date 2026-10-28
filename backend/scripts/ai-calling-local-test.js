#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SELF-HOSTED AI CALLING (calling/local) - TESTS. NO REAL CALL, NO REAL MODEL: Ollama, Vexyl STT and Vexyl TTS are mock servers on
// 127.0.0.1, and "Asterisk" is this script talking the AudioSocket protocol. Runs in-process on a COPY of the database, sandbox
// on (no message leaves):
//   TL_TEST_DB=C:/path/copy.db node scripts/ai-calling-local-test.js
// Proves: only private addresses receive call data; Ollama labels; WAV / resampling; TTS cache; the Exotel speech provider;
// a whole Screening call over AudioSocket (greeting -> answers -> outcome saved -> hang-up); silence ends a call; an unknown call
// is hung up.
// ---------------------------------------------------------------------------
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const BACK = path.resolve(__dirname, '..');
const DB_FILE = String(process.env.TL_TEST_DB || '');
if (!DB_FILE || /(^|[\\/])dev\.db$/i.test(DB_FILE)) { console.error('Refusing: set TL_TEST_DB to a COPY of the database (never dev.db).'); process.exit(2); }
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB_FILE.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1';
process.env.TEST_MODE = '1';
const WS = require(path.join(BACK, 'node_modules/ws'));

let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mocks ------------------------------------------------------------------------------------------------------------------
const OLLAMA_GOT = [];
const ollama = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    OLLAMA_GOT.push({ url: req.url, body: b });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }] })); return; }
    const said = (() => { try { return JSON.parse(b).messages[1].content; } catch { return ''; } })();
    res.end(JSON.stringify({ message: { role: 'assistant', content: /see/.test(said) ? 'Later.' : (/maybe/.test(said) ? 'later' : 'unclear') } }));
  });
});

// Vexyl STT: one scripted answer per ~0.6 s of audio received
let ANSWERS = [];
const STT_LOG = { starts: [], keys: [] };
const sttHttp = http.createServer();
const sttWss = new WS.WebSocketServer({ server: sttHttp });
sttWss.on('connection', (ws, req) => {
  STT_LOG.keys.push(req.headers['x-api-key'] || null);
  let bytes = 0; let started = false;
  ws.send(JSON.stringify({ type: 'ready', model: 'indic-conformer-600m-multilingual' }));
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (!started) return;
      bytes += raw.length;
      if (bytes >= 16000 * 2 * 0.6) { bytes = 0; const t = ANSWERS.shift(); if (t) ws.send(JSON.stringify({ type: 'final', text: t, lang: 'te-IN', duration: 0.6, latency_ms: 5 })); }
      return;
    }
    const m = JSON.parse(String(raw));
    if (m.type === 'start') { started = true; STT_LOG.starts.push(m); ws.send(JSON.stringify({ type: 'started', session_id: m.session_id, lang: m.lang })); }
    if (m.type === 'stop') {
      if (bytes > 0) { const t = ANSWERS.shift(); if (t) ws.send(JSON.stringify({ type: 'final', text: t, flushed: true })); }
      ws.send(JSON.stringify({ type: 'stopped' }));
    }
  });
});

// Vexyl TTS: 0.2 s of tone at 22050 Hz (so the bridge has to resample to 8 kHz)
const TTS_TEXTS = [];
const ttsHttp = http.createServer();
const ttsWss = new WS.WebSocketServer({ server: ttsHttp });
ttsWss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'ready', model: 'indic-parler-tts', sample_rate: 22050, languages: ['en-IN', 'te-IN'] }));
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== 'synthesize') return;
    TTS_TEXTS.push({ text: m.text, lang: m.lang, style: m.style });
    const A = require(path.join(BACK, 'src/calling/local/audio')); // eslint-disable-line global-require
    const n = Math.floor(22050 * 0.2); const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 22050)), i * 2);
    ws.send(JSON.stringify({ type: 'audio', request_id: m.request_id, audio_b64: A.toWav(pcm, 22050).toString('base64'), sample_rate: 22050, cached: false, latency_ms: 3 }));
  });
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// "Asterisk": one AudioSocket call. answer() is called each time the bot stops talking; it returns true to send a spoken answer.
function asteriskCall(port, uuid, { answer = () => true, maxMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const out = { audioFrames: 0, hangup: false, answersSent: 0 };
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0); let lastAudio = 0; let heard = false;
    const fr = (kind, p = Buffer.alloc(0)) => Buffer.concat([Buffer.from([kind, p.length >> 8, p.length & 255]), p]);
    const loud = Buffer.alloc(320); for (let i = 0; i < 160; i += 1) loud.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
    sock.on('connect', () => sock.write(fr(0x01, Buffer.from(uuid.replace(/-/g, ''), 'hex'))));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 3 && buf.length >= 3 + buf.readUInt16BE(1)) {
        const kind = buf[0]; const len = buf.readUInt16BE(1); buf = buf.subarray(3 + len);
        if (kind === 0x10) { out.audioFrames += 1; lastAudio = Date.now(); heard = true; }
        if (kind === 0x00) out.hangup = true;
      }
    });
    const tick = setInterval(() => {
      if (heard && Date.now() - lastAudio > 250) { // the bot finished a sentence
        heard = false;
        if (answer()) { out.answersSent += 1; for (let i = 0; i < 32; i += 1) sock.write(fr(0x10, loud)); }
      }
    }, 50);
    const finish = () => { clearInterval(tick); clearTimeout(t); resolve(out); };
    const t = setTimeout(() => { sock.destroy(); finish(); }, maxMs);
    sock.on('close', finish);
    sock.on('error', finish);
  });
}

(async () => {
  const ports = { ollama: await listen(ollama), stt: await listen(sttHttp), tts: await listen(ttsHttp) };
  process.env.AI_CALL_OLLAMA_URL = `http://127.0.0.1:${ports.ollama}`;
  process.env.AI_CALL_STT_URL = `ws://127.0.0.1:${ports.stt}`;
  process.env.AI_CALL_STT_KEY = 'zz-stt-key';
  process.env.AI_CALL_TTS_URL = `ws://127.0.0.1:${ports.tts}`;
  process.env.AI_CALL_SILENCE_MS = '1500';

  const C = require(path.join(BACK, 'src/calling/local/config'));
  const A = require(path.join(BACK, 'src/calling/local/audio'));
  const O = require(path.join(BACK, 'src/calling/local/ollama'));
  const T = require(path.join(BACK, 'src/calling/local/vexylTts'));
  const S = require(path.join(BACK, 'src/calling/local/speech'));
  const bridge = require(path.join(BACK, 'src/calling/local/audioSocket'));
  const prisma = require(path.join(BACK, 'src/db'));
  const DB = require(path.join(BACK, 'src/calling/schema'));
  const made = [];

  try {
    // ---- 1. private addresses only
    const pub = ['ws://api.openai.com/x', 'https://api.anthropic.com', 'ws://8.8.8.8:8090', 'ws://stt.example.com'].map((u) => C.checkUrl(u, ['ws:', 'wss:', 'http:', 'https:']).ok);
    const priv = ['ws://127.0.0.1:8090', 'ws://10.0.0.5:8090', 'ws://192.168.1.20:8092', 'ws://172.20.0.3:8090', 'ws://vexyl-stt:8090', 'ws://ai.lan:8092', 'http://localhost:11434'].map((u) => C.checkUrl(u, ['ws:', 'wss:', 'http:', 'https:']).ok);
    check('1a a public address never receives call audio / text', pub.every((x) => !x), pub);
    check('1b this machine / the private network / a service name is allowed', priv.every(Boolean), priv);

    // ---- 2. Ollama
    check('2a Ollama labels an unclear answer (mock says "Later.")', await O.classify('hmm I will see') === 'later');
    check('2b the candidate words go as quoted, untrusted text with the label rules', /untrusted/.test(OLLAMA_GOT[0].body) && /"""hmm I will see"""/.test(JSON.parse(OLLAMA_GOT[0].body).messages[1].content), OLLAMA_GOT[0]);
    process.env.AI_CALL_OLLAMA_URL = 'https://api.example.com'; const before = OLLAMA_GOT.length;
    check('2c a public Ollama address: "unclear", nothing sent', await O.classify('yes') === 'unclear' && OLLAMA_GOT.length === before);
    process.env.AI_CALL_OLLAMA_URL = `http://127.0.0.1:${ports.ollama}`;
    const vb = require(path.join(BACK, 'src/calling/voicebot'));
    check('2d the voicebot classifier uses the local model (no Claude)', await vb.llmClassifier('ok maybe') === 'later');
    check('2e Ollama health sees the pulled model', (await O.health()).ok);

    // ---- 3. audio
    const pcm = Buffer.alloc(800); for (let i = 0; i < 400; i += 1) pcm.writeInt16LE(i * 10, i * 2);
    const w = A.parseWav(A.toWav(pcm, 8000));
    check('3a WAV in / out keeps the samples', w.sampleRate === 8000 && w.pcm.equals(pcm));
    check('3b 8 kHz -> 16 kHz doubles the samples, 22050 -> 8000 shrinks them', A.resample(pcm, 8000, 16000).length === 1600 && A.resample(Buffer.alloc(44100), 22050, 8000).length === 16000);

    // ---- 4. TTS cache + the Exotel speech provider
    const a1 = await T.pcm8k('Hello, this is the TeamLink AI assistant.', 'English');
    const n1 = TTS_TEXTS.length;
    const a2 = await T.pcm8k('Hello, this is the TeamLink AI assistant.', 'English');
    check('4a a sentence is rendered once (22050 Hz -> 8 kHz) and then served from the cache', a1.length === 3200 && a2.equals(a1) && TTS_TEXTS.length === n1 && TTS_TEXTS[0].lang === 'en-IN', [a1.length, TTS_TEXTS.length]);
    await T.pcm8k('Namaskaram', 'Telugu');
    check('4b a Telugu call speaks with the Telugu voice (te-IN)', TTS_TEXTS[TTS_TEXTS.length - 1].lang === 'te-IN');
    ANSWERS = ['avunu'];
    const words = await S.provider.transcribe(Buffer.alloc(16000), 'Telugu');
    check('4c the Exotel speech provider: 8 kHz audio -> Vexyl STT (te-IN, X-API-Key) -> words', words === 'avunu' && STT_LOG.starts[0].lang === 'te-IN' && STT_LOG.keys[0] === 'zz-stt-key', [words, STT_LOG]);
    check('4d ... and words -> 8 kHz audio, base64', Buffer.from(await S.provider.synthesize('Hello, this is the TeamLink AI assistant.', 'English'), 'base64').equals(a1));

    // ---- 5. a whole call over AudioSocket
    const app = await prisma.application.findFirst({ where: { candidate: { phone: { not: null } } }, include: { candidate: true } });
    const mkCall = async (lang) => {
      const id = `aic_zzlocal_${crypto.randomBytes(4).toString('hex')}`;
      const uuid = crypto.randomUUID();
      await DB.run('INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","dedupeKey","language","callSid","initiatedVia","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, 'live', 'Screening', 'calling', app.id, app.candidateId, app.requirementId, `zz-local-${id}`, lang, uuid, 'test', new Date().toISOString(), new Date().toISOString())
        .catch(async () => DB.run('INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","dedupeKey","language","callSid","initiatedVia") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          id, 'live', 'Screening', 'calling', app.id, app.candidateId, app.requirementId, `zz-local-${id}`, lang, uuid, 'test'));
      made.push(id);
      return { id, uuid };
    };
    const srv = bridge.listen(0, '127.0.0.1');
    await new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));
    const port = srv.address().port;

    ANSWERS = ['yes', 'yes', 'yes', 'yes', '3 years', 'Hyderabad', '30 days', 'yes', 'yes', 'yes', 'yes', 'yes'];
    const c1 = await mkCall('English');
    const r1 = await asteriskCall(port, c1.uuid, { maxMs: 40000 });
    await sleep(500);
    const row1 = await DB.one('SELECT * FROM "AiCall" WHERE "id" = ?', c1.id);
    check('5a the bot greets, hears the answers and ends the call itself (hang-up frame)', r1.audioFrames > 20 && r1.answersSent >= 2 && r1.hangup, r1);
    check('5b the call is completed with its duration, and the outcome + summary are saved (same dialogue + outcomes as every AI call)', row1.status === 'completed' && row1.durationSec > 0 && !!row1.outcome && !/Call Back/i.test(row1.outcome) && !!row1.summary, { outcome: row1.outcome, status: row1.status, d: row1.durationSec, s: String(row1.summary || '').slice(0, 200) });
    const ev1 = await DB.one('SELECT * FROM "AiCallEvent" WHERE "callId" = ? AND "status" = ?', c1.id, 'completed');
    check('5e the end of the call is written on the call (AiCallEvent, no caller words)', !!ev1 && /hung up|socket/.test(ev1.note), ev1);

    // silence: nobody speaks -> asked again -> the dialogue ends the call
    const c2 = await mkCall('English');
    const r2 = await asteriskCall(port, c2.uuid, { answer: () => false, maxMs: 20000 });
    await sleep(300);
    const row2 = await DB.one('SELECT * FROM "AiCall" WHERE "id" = ?', c2.id);
    check('5c silence: the bot asks again, then ends the call as Unclear', r2.hangup && /Unclear|No Response/i.test(String(row2.outcome || '')), { r2, outcome: row2.outcome });

    // unknown call id
    const r3 = await asteriskCall(port, crypto.randomUUID(), { maxMs: 3000 });
    check('5d an AudioSocket id that is no TeamLink call is hung up at once, nothing said', r3.hangup && r3.audioFrames === 0, r3);
    bridge.close();
  } finally {
    for (const id of made) {
      await DB.run('DELETE FROM "AiCallEvent" WHERE "callId" = ?', id).catch(() => {}); // eslint-disable-line no-await-in-loop
      await DB.run('DELETE FROM "AiCall" WHERE "id" = ?', id).catch(() => {}); // eslint-disable-line no-await-in-loop
    }
    ollama.close(); sttHttp.close(); ttsHttp.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
