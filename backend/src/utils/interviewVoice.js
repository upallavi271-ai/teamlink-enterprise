// ---------------------------------------------------------------------------
// THE JOB PORTAL'S AI INTERVIEW USES THE AI CALLING VOICES (founder 2026-11-05: "ai interview lo language switch avali, candidates aa language
// lo matladithey aa language ki switch avali, job portal lo candidates interview lo"). The free engines already running for phone calls
// (calling/voice/engines.js: Whisper tells the language, IndicConformer hears Telugu / Hindi, Piper / Kokoro speak) are reached here by the
// portal's interview add-on, server to server (routes/jobPortalBridge.js, the bridge secret). The audio stays on this server.
//   hear(pcm16k, cur)   which language did the candidate speak? Uses the phone line's own proof: real speech, Whisper's guess, then real everyday
//                       Telugu / Hindi words (gateway.teluguOrHindi) - noise never switches the language. -> { ready, lang, text }
//   say(text, lang)     the sentence in that language's voice -> WAV bytes (the phone voice, 8 kHz)
// Both report ready:false when the voice engines are not set up here (a PC without them): the screen then works from the browser alone.
// ---------------------------------------------------------------------------
const E = require('../calling/voice/engines');

const MIN_SPEECH_MS = 900; // less real speech than this in the clip: no decision
const LANGS = ['English', 'Telugu', 'Hindi'];
const MAX_SAY = 400;

let cached = null;
function engines(env = process.env) {
  if (cached) return cached;
  if (!env.AI_VOICE_WHISPER_URL && !env.AI_VOICE_PIPER_EXE) return null;
  cached = E.fromEnv(env);
  return cached;
}
const langOf = (v) => (LANGS.includes(v) ? v : 'English');

// at least 5 words, 85% of the letters in that language's script, and not one word said over and over (noise written in a script)
function scriptRun(text, lang) {
  const t = String(text || '').trim();
  const own = lang === 'Telugu' ? /[ఀ-౿]/g : /[ऀ-ॿ]/g;
  const letters = (t.match(/\p{L}/gu) || []).length;
  const words = t.replace(/[.,!?।]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 5 || !letters || (t.match(own) || []).length / letters < 0.85) return false;
  return new Set(words).size >= Math.ceil(words.length * 0.6);
}
async function hearCore(pcm16k, current, deps = {}) {
  const en = Object.prototype.hasOwnProperty.call(deps, 'engines') ? deps.engines : engines();
  if (!en || !en.detect || !en.stt) return { ready: false };
  const cur = langOf(current);
  const pcm = E.resample(pcm16k, 16000, 8000);
  const G = require('../calling/voice/gateway'); // eslint-disable-line global-require
  const sp = en.speech ? await en.speech(pcm).catch(() => null) : null;
  if (sp && Number.isFinite(sp.speechMs) && sp.speechMs < MIN_SPEECH_MS) return { ready: true, lang: cur, changed: false, why: 'noise' };
  const found = await en.detect(pcm, 0.7).catch(() => null);
  if (!found) {
    // Whisper was not sure (Hindi after Telugu was never heard this way): somebody already speaking Telugu / Hindi is asked of both listeners, and only REAL everyday words of the other language switch
    if (cur !== 'English') {
      const [te, hi] = await Promise.all(['Telugu', 'Hindi'].map((l) => en.stt(pcm, l).catch(() => '')));
      const sT = G.nativeScore(te, 'Telugu'); const sH = G.nativeScore(hi, 'Hindi');
      const other = cur === 'Telugu' ? 'Hindi' : 'Telugu';
      const so = other === 'Telugu' ? sT : sH; const sc = cur === 'Telugu' ? sT : sH;
      if (so >= 2 && so > sc) return { ready: true, lang: other, changed: true, text: other === 'Telugu' ? te : hi };
      return { ready: true, lang: cur, changed: false, why: 'unsure', text: cur === 'Telugu' ? te : hi };
    }
    return { ready: true, lang: cur, changed: false, why: 'unsure' };
  }
  if (found === 'English') {
    if (cur === 'English') return { ready: true, lang: cur, changed: false };
    // the phone line's rule: English-looking sound over real words of the current language stays in that language
    const own = await en.stt(pcm, cur).catch(() => '');
    if (G.nativeScore(own, cur) >= 1) return { ready: true, lang: cur, changed: false, why: 'own words' };
    return { ready: true, lang: 'English', changed: true, text: await en.stt(pcm, 'English').catch(() => '') };
  }
  // Telugu or Hindi: no real words = no proof = no switch
  const th = await G.teluguOrHindi(en, pcm, found, {}, ['Telugu', 'Hindi'].includes(cur) ? cur : null);
  if (!th) {
    // an interview answer is free speech, not the phone line's short list of everyday words (founder 2026-11-11: he spoke Telugu and it stayed English): a clear run of words
    // written in the script the sound was recognised as, from a listener that heard Telugu / Hindi, is proof enough
    // Whisper often calls Telugu 'Hindi' (and the Hindi listener then writes the Telugu sound in Devanagari): when NO real everyday word of either was found, the Telugu listener is asked first
    const te = await en.stt(pcm, 'Telugu').catch(() => '');
    if (scriptRun(te, 'Telugu')) return { ready: true, lang: 'Telugu', changed: cur !== 'Telugu', text: te };
    const hi = found === 'Hindi' ? await en.stt(pcm, 'Hindi').catch(() => '') : '';
    if (scriptRun(hi, 'Hindi')) return { ready: true, lang: 'Hindi', changed: cur !== 'Hindi', text: hi };
    return { ready: true, lang: cur, changed: false, why: 'no real words' };
  }
  return { ready: true, lang: th.lang, changed: th.lang !== cur, text: th.text };
}

// what the candidate said so far, in the language they are speaking, comes back with every check: the live caption of a Telugu / Hindi answer (the browser's own
// recogniser was slow for Telugu - founder 2026-11-11)
async function hear(pcm16k, current, deps = {}) {
  const out = await hearCore(pcm16k, current, deps);
  if (!out || !out.ready || out.text || out.why === 'noise' || !['Telugu', 'Hindi'].includes(out.lang)) return out;
  const en = Object.prototype.hasOwnProperty.call(deps, 'engines') ? deps.engines : engines();
  const text = en && en.stt ? await en.stt(E.resample(pcm16k, 16000, 8000), out.lang).catch(() => '') : '';
  return text ? { ...out, text } : out;
}

async function say(text, lang, deps = {}) {
  const en = Object.prototype.hasOwnProperty.call(deps, 'engines') ? deps.engines : engines();
  if (!en || !en.tts) return { ready: false };
  const pcm = await en.tts(String(text || '').slice(0, MAX_SAY), langOf(lang));
  return { ready: true, wav: E.pcmToWav(pcm, 8000) };
}

module.exports = { hear, say, MIN_SPEECH_MS, scriptRun };
