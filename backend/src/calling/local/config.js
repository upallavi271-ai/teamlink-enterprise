// ---------------------------------------------------------------------------
// SELF-HOSTED AI CALLING - SETTINGS (founder 2026-10-28: zero paid AI APIs - Ollama + Vexyl STT / TTS + Synway / Asterisk).
//
// Everything comes from the server's environment (backend/.env), read fresh on every call:
//   AI_CALL_OLLAMA_URL      http://127.0.0.1:11434       the Ollama server (local LLM: yes / no / later labels only)
//   AI_CALL_OLLAMA_MODEL    qwen2.5:1.5b                 Apache-2.0 model; the 3B size has another licence, so not used
//   AI_CALL_STT_URL         ws://127.0.0.1:8090          Vexyl STT WebSocket (16 kHz 16-bit mono PCM in, {type:'final', text} out)
//   AI_CALL_STT_KEY         (optional)                   its VEXYL_STT_API_KEY, sent as the X-API-Key header
//   AI_CALL_TTS_URL         ws://127.0.0.1:8092          Vexyl TTS WebSocket ({type:'synthesize'} in, base64 WAV out)
//   AI_CALL_TTS_KEY         (optional)                   its VEXYL_TTS_API_KEY
//   AI_CALL_TTS_STYLE       default                      default | warm | formal
//   AI_CALL_TTS_CACHE_DIR   (optional)                   keep rendered sentences on disk across restarts
//   AI_CALL_AUDIOSOCKET_PORT  (empty = off)              Asterisk AudioSocket() connects here
//   AI_CALL_AUDIOSOCKET_HOST  127.0.0.1
//   AI_CALL_SILENCE_MS      7000                         no answer for this long = "silence" turn (the dialogue asks again)
//   AI_CALL_PRIVATE_HOSTS   (optional, comma list)       extra host names allowed to receive call audio / text
//
// NO EXTERNAL TRANSMISSION: candidate audio, transcripts and names go ONLY to an address on this machine or the private
// network (loopback, 10/8, 172.16/12, 192.168/16, 100.64/10, a bare service name, *.local / *.lan / *.internal, or one listed
// in AI_CALL_PRIVATE_HOSTS). Any other address is refused here, before anything is sent.
// ---------------------------------------------------------------------------

// Vexyl language codes. Vexyl STT has no English model: an English or Tenglish call is heard with the Telugu model (English words
// come back in Telugu script, which the dialogue's word lists read). AI_CALL_STT_LANG_ENGLISH changes that (e.g. hi-IN).
const TTS_LANG = { English: 'en-IN', Telugu: 'te-IN', Tenglish: 'te-IN', Hindi: 'hi-IN' };
const STT_LANG = { English: 'te-IN', Telugu: 'te-IN', Tenglish: 'te-IN', Hindi: 'hi-IN' };

function privateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  const extra = String(process.env.AI_CALL_PRIVATE_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(h)) return true;
  if (h === 'localhost' || h === '::1' || h === 'host.docker.internal') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return /^f[cd]/.test(h) || /^fe80/.test(h); // IPv6 unique-local / link-local
  if (!h.includes('.')) return true; // a bare service name (docker / LAN)
  return /\.(local|lan|internal|home\.arpa)$/.test(h);
}

// { ok, url, error }: the address may receive call data only when it is private.
function checkUrl(raw, protocols) {
  const v = String(raw || '').trim();
  if (!v) return { ok: false, url: null, error: 'not set' };
  let u;
  try { u = new URL(v); } catch { return { ok: false, url: null, error: `"${v}" is not an address` }; }
  if (!protocols.includes(u.protocol)) return { ok: false, url: null, error: `must start with ${protocols.join(' or ')}` };
  if (!privateHost(u.hostname)) return { ok: false, url: null, error: `${u.hostname} is not on this server or the private network - call audio and text never leave it` };
  return { ok: true, url: v.replace(/\/+$/, ''), error: null };
}

function cfg() {
  const e = process.env;
  const ollama = checkUrl(e.AI_CALL_OLLAMA_URL || '', ['http:', 'https:']);
  const stt = checkUrl(e.AI_CALL_STT_URL || '', ['ws:', 'wss:']);
  const tts = checkUrl(e.AI_CALL_TTS_URL || '', ['ws:', 'wss:']);
  const port = String(e.AI_CALL_AUDIOSOCKET_PORT || '').trim();
  return {
    ollama: { ...ollama, model: String(e.AI_CALL_OLLAMA_MODEL || 'qwen2.5:1.5b').trim(), timeoutMs: Number(e.AI_CALL_OLLAMA_TIMEOUT_MS) || 2500 },
    stt: { ...stt, key: String(e.AI_CALL_STT_KEY || '').trim() },
    tts: { ...tts, key: String(e.AI_CALL_TTS_KEY || '').trim(), style: ['default', 'warm', 'formal'].includes(e.AI_CALL_TTS_STYLE) ? e.AI_CALL_TTS_STYLE : 'default', cacheDir: String(e.AI_CALL_TTS_CACHE_DIR || '').trim() || null },
    audioSocket: { port: port === '' ? null : Number(port), host: String(e.AI_CALL_AUDIOSOCKET_HOST || '127.0.0.1').trim() },
    silenceMs: Number(e.AI_CALL_SILENCE_MS) || 7000,
  };
}

const ttsLang = (language) => TTS_LANG[language] || 'en-IN';
const sttLang = (language) => (language === 'English' && process.env.AI_CALL_STT_LANG_ENGLISH) || STT_LANG[language] || 'te-IN';

module.exports = { cfg, checkUrl, privateHost, ttsLang, sttLang };
