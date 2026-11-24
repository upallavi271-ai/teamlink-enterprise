// ---------------------------------------------------------------------------
// INTERVIEW SPEECH TO TEXT (ATS wave 2 Y: 07.13 voice feedback, 07.11 notetaker uploads).
// The SAME Groq Whisper path the browser-call recordings use (browsercall/recording.js transcribe(): Groq whisper-large-v3 with the Groq key
// Fast AI already has, a Telugu / Hindi recording written in English with the words as spoken below; the AI phone's Whisper server second).
// No new account. AI_VOICE_WHISPER_URL is no longer needed for interviews.
//   status()                               -> { ready, engine, why }
//   transcribeMedia(buf, { mime, fileName }) -> { text, source } | { error }
// A video, or a file over Groq's 25 MB, is first made a small mono MP3 by ONE ffmpeg command (never several in a row: the server's memory).
// SANDBOX: nothing leaves the machine; BROWSER_CALL_FAKE_STT stands in for the transcriber (the call recordings' own test switch).
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const GROQ_MAX = 24 * 1024 * 1024;

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const a4 = buf.slice(0, 4).toString('latin1');
  if (a4 === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'audio/webm', ext: 'webm' };
  if (a4 === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (a4.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3' };
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return { mime: /M4A|m4a/.test(buf.slice(8, 12).toString('latin1')) ? 'audio/mp4' : 'video/mp4', ext: /M4A/.test(buf.slice(8, 12).toString('latin1')) ? 'm4a' : 'mp4' };
  return null;
}
const EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'video/mp4': 'mp4' };

async function groqKeySet() {
  try {
    const { readConfig } = require('../integrationStore'); // eslint-disable-line global-require
    const v = (await readConfig('ai-fast')).values || {};
    return !!String(v['Groq API key'] || process.env.GROQ_API_KEY || '').trim();
  } catch { return !!process.env.GROQ_API_KEY; }
}
async function status() {
  const sandbox = require('./core').isSandbox(); // eslint-disable-line global-require
  if (sandbox) return process.env.BROWSER_CALL_FAKE_STT ? { ready: true, engine: 'Test transcriber (sandbox)' } : { ready: false, engine: null, why: 'This is a test copy: recordings are not sent anywhere. Paste the transcript.' };
  if (await groqKeySet()) return { ready: true, engine: 'Groq Whisper (whisper-large-v3), the same as call recordings' };
  if (process.env.AI_VOICE_WHISPER_URL) return { ready: true, engine: 'Whisper (TeamLink server)' };
  return { ready: false, engine: null, why: 'No speech-to-text is set up: add the Groq key in Administration > Integrations > Fast AI (the call recordings use the same one).' };
}

function toMp3(src, dst) {
  return new Promise((resolve) => {
    execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-af', 'loudnorm=I=-18:TP=-2', '-c:a', 'libmp3lame', '-b:a', '32k', dst],
      { timeout: 300000, windowsHide: true }, (e) => resolve(!e && fs.existsSync(dst) && fs.statSync(dst).size > 0));
  });
}

async function transcribeMedia(buf, { mime, fileName } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 1500) return { error: 'The recording is empty.' };
  const REC = require('../../browsercall/recording'); // eslint-disable-line global-require
  const sn = sniff(buf);
  const type = String(mime || (sn && sn.mime) || 'audio/webm').toLowerCase();
  const ext = EXT[type] || (sn && sn.ext) || 'webm';
  const name = `interview.${ext}`;
  let tmpDir = null;
  try {
    let r;
    const isVideo = /^video\//.test(type) && type !== 'video/webm';
    if (!require('./core').isSandbox() && (isVideo || buf.length > GROQ_MAX)) { // eslint-disable-line global-require
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ivs-'));
      const src = path.join(tmpDir, `in.${ext}`); const mp3 = path.join(tmpDir, 'out.mp3');
      fs.writeFileSync(src, buf, { mode: 0o600 });
      if (!(await toMp3(src, mp3))) return { error: 'The recording is a video or larger than 25 MB, and this server could not make its sound small (ffmpeg). Paste the transcript instead.' };
      if (fs.statSync(mp3).size > GROQ_MAX) return { error: 'The recording is too long for one transcript (more than about 1.5 hours). Paste the transcript instead.' };
      r = await REC.transcribe(null, mp3);
    } else if (type === 'audio/wav' || type === 'audio/x-wav') {
      r = await REC.transcribe(buf, null);
    } else {
      r = await REC.transcribe(buf, null, { mime: type === 'video/webm' ? 'audio/webm' : type, fileName: fileName && /\.[a-z0-9]{2,4}$/i.test(fileName) ? fileName.replace(/[^\w.-]/g, '_') : name });
    }
    if (r && r.text) return { text: String(r.text), english: r.english || null, source: r.source };
    return { error: `${String((r && r.reason) || 'Transcript not available.').replace(/\.?$/, '.')} Paste the transcript instead.` };
  } catch (e) {
    return { error: `The recording could not be turned into text (${String(e.message).slice(0, 80)}). Paste the transcript instead.` };
  } finally {
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

module.exports = { status, transcribeMedia, sniff };
