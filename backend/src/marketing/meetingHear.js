// ---------------------------------------------------------------------------
// PLANS MEETING > HEARING THE CLIENT (founder 2026-11-17: "i cant ask my doubts in live ... it is not taking the audio"). The page first uses the phone's own speech recognition; where that is missing
// (iPhone, Firefox, an in-app browser) or fails (no internet to Google, no Telugu / Hindi model), it records the question and sends it here: the same free speech engines the AI interview and the AI
// calls use (calling/voice/engines.js: Whisper for English, VEXYL-STT for Telugu and Hindi). The words come back and are answered from the fixed answers, exactly like a typed question.
//   hear(lang, audioBytes) -> { text } | { error, status }
// The recording is not kept. One at a time, at most 2 MB (about 15 seconds), so the server's other work is not starved.
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');

const NAME = { en: 'English', te: 'Telugu', hi: 'Hindi' };
const MAX_BYTES = 2 * 1024 * 1024;
let busy = 0;
const gateway = () => require('../calling/voice/gateway'); // eslint-disable-line global-require
const engines = () => require('../calling/voice/engines'); // eslint-disable-line global-require

// the browser's recording (webm / ogg / mp4) -> 8 kHz 16-bit mono PCM, the sound the listeners are tuned for (the same step as routes/voiceService.js)
function toPcm8k(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const out = []; let err = '';
    const t = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('ffmpeg took too long')); }, 30000);
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += String(d); });
    ff.on('error', (e) => { clearTimeout(t); reject(new Error(`ffmpeg is not available (${e.code || e.message})`)); });
    ff.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(Buffer.concat(out)); else reject(new Error(`ffmpeg failed: ${err.slice(0, 160)}`)); });
    ff.stdin.on('error', () => {});
    ff.stdin.end(buf);
  });
}

async function hear(lang, buf) {
  if (!NAME[lang]) return { error: 'Unknown language.', status: 400 };
  if (!Buffer.isBuffer(buf) || buf.length < 1500) return { error: 'No sound was recorded. Please try again.', status: 400 };
  if (buf.length > MAX_BYTES) return { error: 'The recording is too long. Please ask in a few seconds.', status: 413 };
  if (busy >= 1) return { error: 'The listener is busy. Please try again in a few seconds, or type your question.', status: 503 };
  busy += 1;
  try {
    const G = gateway(); const R = engines();
    const E = G.engines();
    if (!E || !E.stt) return { error: 'Listening is not available here. Please type your question.', status: 503 };
    let pcm;
    if (buf.slice(0, 4).toString('ascii') === 'RIFF') { const w = R.wavToPcm(buf); pcm = R.resample(w.pcm, w.rate, 8000); } else pcm = await toPcm8k(buf);
    if (pcm.length < 8000 * 2 * 0.4) return { text: '' }; // under 0.4 s: nothing was said
    const r = await Promise.race([E.stt(pcm, NAME[lang], 8000), new Promise((_, reject) => setTimeout(() => reject(new Error('the listener took too long')), 40000))]);
    return { text: String((r && r.text) || r || '').replace(/\s+/g, ' ').trim().slice(0, 300) };
  } catch (e) {
    console.error('[omni-mk] meeting hear:', e.message); // eslint-disable-line no-console
    return { error: 'Your voice could not be understood. Please type your question.', status: 502 };
  } finally { busy -= 1; }
}

module.exports = { hear, MAX_BYTES };
