// ---------------------------------------------------------------------------
// AFTER A CALL (founder 2026-11-23): "history must show what was said; the call must be RECORDED (no 'this call is being recorded'
// message); history must show how long they talked and what they talked about."
//
//   Asterisk (generated dialplan, lines.js) records the answered part of the call silently: <recDir>/<token>.wav (MixMonitor b).
//   events.js -> enqueue(callId) when the call hangs up. ONE job at a time, retried once, never in the way of a call:
//     1. find the raw file (wait until it stops growing), length from the WAV header
//     2. ONE ffmpeg command -> small mono MP3 in the uploads store (<UPLOAD_DIR>/call-recordings/<id>.mp3); no ffmpeg -> the WAV is kept as is
//     3. transcript, language auto (Telugu / Hindi / English mixed): the Whisper server (AI_VOICE_WHISPER_URL, deploy/ai-voice) if set,
//        else Groq Whisper (whisper-large-v3) with the Groq key Fast AI uses, else "Transcript not available" with the reason
//     4. a short plain-English summary through utils/fastAi.js (low temperature; it runs inside the AI governance wrapper utils/mktb/gov.js);
//        phone numbers and e-mails are masked in the text first. Model down -> a summary made by code from the words themselves
//     5. the raw WAV is deleted; the candidate's activity gets "Call by <name>, 3:42 talk - <one line>"
//   Recordings (audio + transcript) are deleted after keepDays (Admin setting, default 180); the summary and the talk time stay.
//
// SANDBOX: nothing leaves the machine. BROWSER_CALL_FAKE_STT=<text> stands in for the transcriber, BROWSER_CALL_FAKE_AI=1 for the model
// (BROWSER_CALL_FAKE_AI=down = the model is down -> the code summary).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const S = require('./schema');
const CFG = require('./config');

const { ENV } = CFG;
const TEST_CALL = 'test-call';
const queue = [];
let busy = false;
let lastError = null;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const sandbox = () => { try { return require('../utils/sandbox').isSandbox(); } catch { return false; } }; // eslint-disable-line global-require
const recDir = () => path.resolve(process.env.BROWSER_CALL_REC_DIR || ENV.recDir);
function storeDir() {
  const att = require('../utils/attachments'); // eslint-disable-line global-require
  const d = path.join(att.uploadDir(), 'call-recordings');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const mmss = (n) => `${Math.floor((n || 0) / 60)}:${String((n || 0) % 60).padStart(2, '0')}`;
const wait = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); });

// ---- 1. the raw file --------------------------------------------------------------------------------------------------------------
function wavInfo(buf) {
  // RIFF....WAVE, chunks; returns { rate, channels, bits, dataOffset, dataBytes, seconds }
  if (buf.length < 44 || buf.slice(0, 4).toString('latin1') !== 'RIFF' || buf.slice(8, 12).toString('latin1') !== 'WAVE') return null;
  let at = 12; let fmt = null;
  while (at + 8 <= buf.length) {
    const id = buf.slice(at, at + 4).toString('latin1'); const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === 'data' && fmt) {
      const bytes = Math.min(size, buf.length - at - 8);
      return { ...fmt, dataOffset: at + 8, dataBytes: bytes, seconds: Math.round(bytes / (fmt.rate * fmt.channels * (fmt.bits / 8))) };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
async function findRaw(token) {
  const safe = String(token || '').replace(/[^a-z0-9]/g, '');
  if (!safe) return null;
  const f = path.join(recDir(), `${safe}.wav`);
  let last = -1;
  for (let i = 0; i < 12; i += 1) { // up to ~12 s: MixMonitor closes the file just after the hangup
    let st = null; try { st = fs.statSync(f); } catch { st = null; }
    if (st && st.size === last && st.size > 44) return f;
    last = st ? st.size : -1;
    // eslint-disable-next-line no-await-in-loop
    await wait(sandbox() ? 50 : 1000);
  }
  try { return fs.statSync(f).size > 44 ? f : null; } catch { return null; }
}

// ---- 2. ONE ffmpeg command ----------------------------------------------------------------------------------------------------------
// for the transcriber only (deleted right after): mono 16 kHz WAV at normal loudness
function toSttWav(src, dst, skipSec = 0) {
  return new Promise((resolve) => {
    execFile(ENV.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...(skipSec > 0 ? ['-ss', skipSec.toFixed(2)] : []), '-ac', '1', '-ar', '16000', '-af', 'loudnorm=I=-18:TP=-2', '-c:a', 'pcm_s16le', dst], { timeout: 180000, windowsHide: true }, (e) => resolve(!e && fs.existsSync(dst) && fs.statSync(dst).size > 44));
  });
}
function toMp3(src, dst, skipSec = 0) {
  return new Promise((resolve) => {
    execFile(ENV.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...(skipSec > 0 ? ['-ss', skipSec.toFixed(2)] : []), '-ac', '1', '-ar', '16000', '-af', 'loudnorm=I=-18:TP=-2', '-c:a', 'libmp3lame', '-b:a', '24k', dst], { /* loudnorm (23 Nov 2026): phone audio is quiet - Whisper heard only "Thank you." in a real call until it was brought up to normal loudness */ timeout: 180000, windowsHide: true }, (e) => resolve(!e && fs.existsSync(dst) && fs.statSync(dst).size > 0));
  });
}

// ---- 3. transcript -------------------------------------------------------------------------------------------------------------------
async function groqKey() {
  try {
    const { readConfig } = require('../utils/integrationStore'); // eslint-disable-line global-require
    const v = (await readConfig('ai-fast')).values || {};
    return String(v['Groq API key'] || process.env.GROQ_API_KEY || '').trim();
  } catch { return String(process.env.GROQ_API_KEY || '').trim(); }
}
function pcm16kFromWav(buf) {
  const R = require('../calling/voice/engines'); // eslint-disable-line global-require
  const w = R.wavToPcm(buf);
  return { pcm: R.resample(w.pcm, w.rate, 16000), rate: 16000 };
}
// opts (ATS wave 2 Y, 2026-11-25): { mime, fileName } of a recording that is neither WAV nor MP3 (an interview's webm / m4a / ogg / mp4 voice
// note or upload), so Groq reads it by its own format. Only the Groq path takes such a file; the Whisper server needs a WAV.
async function transcribe(wavBuf, mp3Path, opts = {}) {
  if (sandbox()) {
    if (process.env.BROWSER_CALL_FAKE_STT) return { text: String(process.env.BROWSER_CALL_FAKE_STT), source: 'Test transcriber (sandbox)' };
    return { text: '', reason: 'Transcript not available: this is a test copy, the recording is not sent anywhere.' };
  }
  const errors = [];
  // ORDER (23 Nov 2026): Groq Whisper large-v3 first - it writes a whole call (Telugu / Hindi / English mixed) far better; the AI phone's own
  // Whisper server is tuned for short answers and heard nothing in a full recording. It stays as the second try.
  const key = await groqKey();
  if (key) {
    try {
      const file = mp3Path && fs.existsSync(mp3Path) ? mp3Path : null;
      const data = file ? fs.readFileSync(file) : wavBuf;
      const ask = async (what) => {
        const body = new FormData();
        const other = !file && opts && opts.mime && !/wav/i.test(opts.mime);
        body.append('file', new Blob([data], { type: file ? 'audio/mpeg' : (other ? opts.mime : 'audio/wav') }), file ? 'call.mp3' : (other ? (opts.fileName || 'recording.webm') : 'call.wav'));
        body.append('model', 'whisper-large-v3');
        body.append('response_format', 'verbose_json');
        body.append('temperature', '0');
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 120000); t.unref();
        const r = await fetch(`https://api.groq.com/openai/v1/audio/${what}`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body, signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error(`Groq answered ${r.status}`);
        return r.json();
      };
      const j = await ask('transcriptions');
      const gtext = String(j.text || '').trim();
      const lang = String(j.language || '').trim();
      // A call in Telugu / Hindi (founder 2026-11-23: the Telugu-letter text "had nothing to do with the audio"): what was said is
      // written in ENGLISH (Whisper's own translation of the audio, which keeps the meaning), with the words as spoken below it.
      // The summary reads the English part.
      if (gtext && lang && !/^en(glish)?$/i.test(lang)) {
        let english = '';
        try { english = String((await ask('translations')).text || '').trim(); } catch { english = ''; }
        if (english) {
          const L = lang.charAt(0).toUpperCase() + lang.slice(1);
          return { text: `${english}\n\n— As spoken (${L}) —\n${gtext}`, english, source: `Groq Whisper (spoken ${L}, written in English)` };
        }
      }
      if (gtext) return { text: gtext, english: gtext, source: 'Groq Whisper (whisper-large-v3)' };
      errors.push('Groq Whisper: heard nothing');
    } catch (e) { errors.push(`Groq Whisper: ${clip(String(e.message).replace(key, '•••'), 80)}`); }
  }
  if (process.env.AI_VOICE_WHISPER_URL && wavBuf && !(opts && opts.mime && !/wav/i.test(opts.mime))) {
    try {
      const R = require('../calling/voice/engines'); // eslint-disable-line global-require
      const wh = R.whisperHttp({ url: process.env.AI_VOICE_WHISPER_URL, key: process.env.AI_VOICE_KEY || '' });
      const { pcm } = pcm16kFromWav(wavBuf);
      const CHUNK = 16000 * 2 * 25; const parts = [];
      for (let at = 0; at < pcm.length && at < CHUNK * 72; at += CHUNK) { // at most 30 minutes
        const piece = pcm.slice(at, at + CHUNK);
        if (piece.length < 16000) break;
        // eslint-disable-next-line no-await-in-loop
        const t = await Promise.race([wh.stt(piece, 'auto', 16000), new Promise((_, rej) => { setTimeout(() => rej(new Error('Whisper took too long')), 90000).unref(); })]);
        if (String(t || '').trim()) parts.push(String(t).trim());
      }
      const wtext = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (wtext) return { text: wtext, source: 'Whisper (TeamLink server)' };
      errors.push('Whisper server: heard nothing');
    } catch (e) { errors.push(`Whisper server: ${clip(e.message, 80)}`); }
  }
  return { text: '', reason: `Transcript not available: ${errors.length ? errors.join('; ') : 'no speech-to-text is set up (AI_VOICE_WHISPER_URL, or a Groq key in Administration > Integrations > Fast AI).'}` };
}

// ---- 4. summary -----------------------------------------------------------------------------------------------------------------------
const mask = (t) => String(t || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]').replace(/(?:\+|00)?\d[\d\s-]{8,}\d/g, '[phone]');
const FIELDS = ['discussed', 'interest', 'currentSalary', 'expectedSalary', 'noticePeriod', 'nextStep', 'followUpDate'];
const LABEL = { discussed: 'Discussed', interest: 'Interest', currentSalary: 'Current salary', expectedSalary: 'Expected salary', noticePeriod: 'Notice period', nextStep: 'Next step', followUpDate: 'Follow-up' };
function codeSummary(text) {
  const t = String(text || '');
  const near = (re) => { const m = t.match(re); return m ? clip(m[0].replace(/\s+/g, ' ').trim(), 80) : ''; };
  const o = {
    discussed: clip(t.replace(/\s+/g, ' ').trim(), 220) + (t.length > 220 ? '…' : ''),
    interest: /\b(not interested|no interest|not looking)\b/i.test(t) ? 'Not interested' : (/\b(interested|okay|ok|yes|sure)\b/i.test(t) ? 'Sounded interested' : ''),
    currentSalary: near(/current[^.?!]{0,40}?\d+(\.\d+)?\s*(lpa|lakhs?|lacs?|k|thousand)/i),
    expectedSalary: near(/expect[^.?!]{0,40}?\d+(\.\d+)?\s*(lpa|lakhs?|lacs?|k|thousand)/i),
    noticePeriod: near(/(\d+\s*(days?|months?|weeks?)\s*notice|notice[^.?!]{0,30}?\d+\s*(days?|months?|weeks?)|immediate(ly)? joiner|serving notice)/i),
    nextStep: near(/(will (call|send|share|schedule|confirm)[^.?!]{0,60}|send (the )?(cv|resume)[^.?!]{0,40}|interview[^.?!]{0,60})/i),
    followUpDate: near(/\b(tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i),
  };
  return o;
}
const textOf = (o) => FIELDS.filter((k) => o[k]).map((k) => `${LABEL[k]}: ${o[k]}`).join('. ');
const oneLine = (o) => clip(o.discussed || o.nextStep || o.interest || '', 140);
async function summarize(transcript, user) {
  const masked = mask(transcript);
  if (sandbox() && process.env.BROWSER_CALL_FAKE_AI && process.env.BROWSER_CALL_FAKE_AI !== 'down') {
    const o = { ...codeSummary(masked), discussed: `Test summary: ${clip(masked, 60)}` };
    return { data: o, source: 'Test AI (sandbox)', sent: masked };
  }
  if (!sandbox()) {
    const system = 'You summarise a recruiter\'s phone call with a job candidate. The call may mix Telugu, Hindi and English. Answer in plain, short English only, from the transcript alone - never guess. '
      + 'Return JSON only: {"discussed": one or two sentences, "interest": "Interested" | "Not interested" | "Not sure" | "", "currentSalary": the words as said or "", "expectedSalary": the words as said or "", '
      + '"noticePeriod": as said or "", "nextStep": what was agreed or "", "followUpDate": the day/date agreed or ""}.';
    try {
      const fa = require('../utils/fastAi'); // eslint-disable-line global-require
      const gov = require('../utils/mktb/gov'); // eslint-disable-line global-require
      const ask = () => fa.chat(system, [{ role: 'user', content: `Transcript:\n${clip(masked, 12000)}` }], { maxTokens: 400, temperature: 0.1, json: true, timeoutMs: 30000, deadlineMs: 40000, purpose: 'Browser call summary' });
      const r = user ? await gov.runAs(user, ask) : await ask();
      const raw = String((r && r.text) || '').replace(/^```(json)?|```$/g, '').trim();
      const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      const o = {}; for (const k of FIELDS) o[k] = clip(typeof j[k] === 'string' ? j[k].trim() : '', 300);
      if (o.discussed) return { data: o, source: `AI (${(r && r.provider) || 'Fast AI'})`, sent: masked };
    } catch (e) { lastError = `summary: ${clip(e.message, 100)}`; }
  }
  return { data: codeSummary(masked), source: 'Made from the words (the AI was not available)', sent: masked };
}

// ---- 5. the candidate's activity -------------------------------------------------------------------------------------------------------
async function activity(row, line) {
  if (!row.candidateId || row.candidateId === TEST_CALL) return;
  const prisma = require('../db'); // eslint-disable-line global-require
  const cand = await prisma.candidate.findUnique({ where: { id: row.candidateId }, select: { id: true, name: true } }).catch(() => null);
  if (!cand) return;
  const text = `${row.direction === 'inbound' ? `Incoming call to ${row.userName || 'a recruiter'} (their SIM)` : `Call by ${row.userName || 'a recruiter'}`}, ${mmss(row.talkSec)} talk${line ? ` - ${line}` : ''}`;
  await prisma.candidateMessage.create({ data: {
    candidateId: cand.id, applicationId: row.applicationId || null, channel: 'Call', template: 'BROWSER_CALL', templateLabel: 'Browser call', trigger: 'Manual',
    recipient: row.toNumber || '', status: 'SENT', statusDetail: clip(text, 500), providerRef: row.id, sentAt: new Date(row.answerAt || row.startAt), attempts: 1, lastAttemptAt: new Date(),
    senderUserId: row.userId, senderName: row.userName,
  } }).catch(() => {});
  try { await require('../utils/conversations').recordOut({ personType: 'CANDIDATE', personId: cand.id, personName: cand.name, channel: 'Call', body: text, templateLabel: 'Browser call' }); } catch { /* the call row keeps it anyway */ } // eslint-disable-line global-require
  await prisma.applicationFollowUp.updateMany({ where: { candidateId: cand.id, completedAt: null, ...(row.applicationId ? { applicationId: row.applicationId } : {}) }, data: { lastContactedAt: new Date(), contactMode: 'Call' } }).catch(() => {});
}

// ---- the job ----------------------------------------------------------------------------------------------------------------------------
async function processCall(id) {
  let englishText = ''; // what the summary reads: the English of the call (a Telugu / Hindi call is translated by the transcriber)
  const row = await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', id);
  if (!row || row.processedAt) return { skipped: true };
  if (!row.answerAt) {
    await S.run('UPDATE "BrowserCall" SET "recordingStatus"=CASE WHEN "recordingStatus"=\'pending\' THEN \'none\' ELSE "recordingStatus" END, "processedAt"=? WHERE "id"=?', S.nowIso(), id);
    const raw = await findRaw(row.token).catch(() => null); if (raw) try { fs.unlinkSync(raw); } catch { /* none */ }
    return { answered: false };
  }
  await S.run('UPDATE "BrowserCall" SET "recordingStatus"=CASE WHEN "recordingStatus"=\'pending\' THEN \'processing\' ELSE "recordingStatus" END, "processTries"=COALESCE("processTries",0)+1 WHERE "id"=?', id);
  const set = {};
  let user = null;
  try { user = await require('../utils/identity').resolveIdentity(row.userId); } catch { user = null; } // eslint-disable-line global-require
  if (row.recordingStatus === 'off') {
    set.recordingNote = 'Recording was switched off for this call.';
  } else if (row.bridgeDeviceId && !row.bridgeMergedAt) {
    // TALK IN TEAMLINK that never joined the candidate: the file holds only the office leg (the operator's "on hold" message), nothing to keep
    const raw0 = await findRaw(row.token).catch(() => null); if (raw0) try { fs.unlinkSync(raw0); } catch { /* none */ }
    Object.assign(set, { recordingStatus: 'none', recordingNote: 'Not kept: the candidate was never joined to the call.' });
  } else {
    const raw = await findRaw(row.token);
    // TALK IN TEAMLINK: the file starts when the phone answered the office leg; the conversation starts when the phone joined the candidate in
    const skip = row.bridgeMergedAt && row.answerAt ? Math.max(0, (Date.parse(row.bridgeMergedAt) - Date.parse(row.answerAt)) / 1000 + 0.9) /* the merge completes about a second after the phone presses Merge (seen on a real call: the tail of the operator's hold message) */ : 0;
    if (!raw) {
      Object.assign(set, { recordingStatus: 'missing', recordingNote: 'No recording file came from the phone system (is the generated dialplan installed and recording on?).' });
    } else {
      const buf = fs.readFileSync(raw);
      const info = wavInfo(buf);
      const dir = storeDir();
      const mp3 = path.join(dir, `${row.id}.mp3`);
      let stored = null;
      if (await toMp3(raw, mp3, skip)) stored = mp3;
      else { const wav = path.join(dir, `${row.id}.wav`); fs.copyFileSync(raw, wav); stored = wav; set.recordingNote = 'Kept as WAV: ffmpeg is not available on this server.'; }
      Object.assign(set, { recordingStatus: 'done', recordingPath: path.relative(storeDir(), stored), recordingBytes: fs.statSync(stored).size, recordingSec: info ? Math.max(0, Math.round(info.seconds - skip)) : null });
      // the transcriber gets a clean 16 kHz WAV at normal loudness (23 Nov 2026): the small MP3 made Whisper drop most of a real call
      const sttWav = path.join(os.tmpdir(), `tl-stt-${row.id}.wav`);
      const sttOk = await toSttWav(raw, sttWav, skip);
      let tr;
      try { tr = await transcribe(sttOk ? fs.readFileSync(sttWav) : buf, sttOk ? null : (stored.endsWith('.mp3') ? stored : null)); } finally { try { fs.unlinkSync(sttWav); } catch { /* gone */ } }
      if (tr.text) Object.assign(set, { transcript: clip(tr.text, 60000), transcriptSource: tr.source });
      else set.transcriptSource = clip(tr.reason, 300);
      if (tr.english) englishText = tr.english;
      try { fs.unlinkSync(raw); } catch { /* removed already */ }
    }
  }
  let line = '';
  if (set.transcript) {
    const sm = await summarize(englishText || String(set.transcript).split('\n\n— As spoken (')[0], user);
    Object.assign(set, { summary: JSON.stringify(sm.data), summaryText: clip(textOf(sm.data), 2000), summarySource: sm.source });
    line = oneLine(sm.data);
  }
  set.processedAt = S.nowIso();
  const keys = Object.keys(set);
  await S.run(`UPDATE "BrowserCall" SET ${keys.map((k) => `"${k}"=?`).join(',')}, "updatedAt"=? WHERE "id"=?`, ...keys.map((k) => set[k]), S.nowIso(), id);
  await activity({ ...row, ...set }, line);
  return { ok: true, ...set };
}

async function work() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try { await processCall(job.id); } catch (e) { // eslint-disable-line no-await-in-loop
        lastError = `${job.id}: ${clip(e.message, 140)}`;
        console.error('[browser-call] recording:', lastError);
        if (!job.retried) { const again = { id: job.id, retried: true }; setTimeout(() => { queue.push(again); work(); }, sandbox() ? 200 : 60000).unref(); } else await S.run('UPDATE "BrowserCall" SET "recordingStatus"=\'failed\', "recordingNote"=?, "processedAt"=? WHERE "id"=?', clip(e.message, 300), S.nowIso(), job.id).catch(() => {}); // eslint-disable-line no-await-in-loop
      }
    }
  } finally { busy = false; }
}
/** After a hangup (events.js). Never throws, never waits. */
function enqueue(id) {
  if (!id || queue.some((j) => j.id === id)) return;
  queue.push({ id });
  setTimeout(() => { work().catch(() => {}); }, sandbox() ? 10 : 3000).unref();
}
/** Wait until the queue is empty (tests). */
async function drain(ms = 20000) { const end = Date.now() + ms; while ((queue.length || busy) && Date.now() < end) await wait(50); } // eslint-disable-line no-await-in-loop

/** Retention: delete the audio and the transcript of calls older than keepDays. The summary and the talk time stay. */
async function sweepOld() {
  const s = await CFG.load();
  const cut = new Date(Date.now() - s.keepDays * 86400000).toISOString();
  const old = await S.all('SELECT "id","recordingPath" FROM "BrowserCall" WHERE "startAt"<? AND ("recordingPath" IS NOT NULL OR "transcript" IS NOT NULL)', cut);
  for (const r of old) {
    if (r.recordingPath) { try { fs.unlinkSync(resolveStored(r.recordingPath)); } catch { /* gone */ } }
    // eslint-disable-next-line no-await-in-loop
    await S.run('UPDATE "BrowserCall" SET "recordingPath"=NULL, "recordingBytes"=NULL, "transcript"=NULL, "recordingStatus"=\'deleted\', "recordingDeletedAt"=?, "recordingNote"=? WHERE "id"=?', S.nowIso(), `Deleted after ${s.keepDays} days (recordings are kept ${s.keepDays} days).`, r.id);
  }
  // calls answered and hung up, but never processed (the server restarted): queue them
  const stuck = await S.all('SELECT "id" FROM "BrowserCall" WHERE "processedAt" IS NULL AND "endAt" IS NOT NULL AND "endAt"<? AND "startAt">? LIMIT 20', new Date(Date.now() - 120000).toISOString(), new Date(Date.now() - 2 * 86400000).toISOString());
  stuck.forEach((r) => enqueue(r.id));
  return { deleted: old.length };
}
/** The stored file of a call, only inside the recordings folder. */
function resolveStored(rel) {
  const base = storeDir();
  const p = path.resolve(base, String(rel || ''));
  if (!p.startsWith(base + path.sep) || !/^[0-9a-f-]{36}\.(mp3|wav)$/.test(path.basename(p))) return null;
  return p;
}
const status = () => ({ queued: queue.length, busy, lastError });

module.exports = { enqueue, drain, processCall, sweepOld, resolveStored, transcribe, summarize, codeSummary, mask, wavInfo, status, FIELDS, LABEL };
