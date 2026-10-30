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
// a short, EVEN breath between sentences. Each sentence's own silence at the start / end is trimmed first (Piper left up to
// 280 ms at the end, so the pause between sentences used to swing from 100 to 360 ms - 2026-10-30 "gaps lekunda").
const GAP_MS = 150;
const cache = new Map(); // `${lang}|${sentence}` -> 8 kHz PCM
const CACHE_MAX = 3000;
// DISK COPY (2026-10-30): a sentence made once is kept on disk, so after a restart / deploy it is ready at once and the
// shared Hindi voice server is not asked again. Keyed by language + text + the engine's name (a new voice = new files).
// AI_VOICE_CACHE_DIR (default: <tmp>/teamlink-voice-cache). Never required: a disk problem just means "make it again".
const DISK = process.env.AI_VOICE_CACHE_DIR || require('path').join(require('os').tmpdir(), 'teamlink-voice-cache'); // eslint-disable-line global-require
const diskName = (engines, key) => require('path').join(DISK, `${require('crypto').createHash('sha1').update(`${engines.name || ''}|v2|${key}`).digest('hex')}.pcm`); // eslint-disable-line global-require
function diskGet(engines, key) { try { return require('fs').readFileSync(diskName(engines, key)); } catch { return null; } } // eslint-disable-line global-require
function diskPut(engines, key, pcm) { try { const fs = require('fs'); fs.mkdirSync(DISK, { recursive: true }); fs.writeFileSync(diskName(engines, key), pcm); } catch { /* optional */ } } // eslint-disable-line global-require
const log = (...a) => console.log('[ai-voice]', ...a); // eslint-disable-line no-console
// AI_VOICE_DEBUG_FILE (test PCs only): what was heard / said, one line each, to see why a call went wrong. Holds speech text.
const DEBUG = process.env.AI_VOICE_DEBUG_FILE || '';
const debug = (line) => { try { require('fs').appendFileSync(DEBUG, `${new Date().toISOString().slice(11, 19)} ${line}
`); } catch { /* */ } }; // eslint-disable-line global-require

// HOW CLEARLY an answer was heard (2026-10-29: "Yes, I have" reached the assistant as "Yes, I can't tell you so much about
// it", and noise as the Hindi-looking 'आपस्पटोल'). An answer that is not heard reliably is never read as yes / no / a time:
// the assistant asks again (dialogue.js unheard()). Whisper's own sureness (whisper_server.py conf) decides for English;
// IndicConformer gives none, so Telugu / Hindi are judged only by empty words and the language-switch check below.
const num = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
// from REAL phone calls (2026-10-29): a real "Yes." scores -0.4 to -1.1, "Yeah." -0.5 / -0.9; garbage ("You", "here", "I'm going
// to get ready to cool") -1.15 and below. -0.7 (tuned on computer voices) turned real yeses into "couldn't hear you clearly".
const MIN_LOGPROB = num(process.env.AI_VOICE_MIN_LOGPROB, -1.0); // below = Whisper was guessing
const MAX_NO_SPEECH = num(process.env.AI_VOICE_MAX_NO_SPEECH, 0.6); // above (with a weak logprob) = words made up from noise
const MAX_RATIO = 2.4; // repeated / looping text
// no voice at all this long after the assistant finished = "are you still there?" (never read as an answer)
const SILENCE_MS = Math.min(30000, Math.max(4000, num(process.env.AI_VOICE_SILENCE_MS, 8000)));
const NOISE_MS = Math.max(0, num(process.env.AI_VOICE_NOISE_MS, 150)); // less real speech than this in a clip = noise
// "Bangalore" was heard as "Bang the law" (2026-10-30 test): at "which city?" Whisper is told the usual answers
const CITY_HINT = ' Hyderabad, Secunderabad, Bangalore, Chennai, Vijayawada, Visakhapatnam, Warangal, Guntur, Kakinada, Tirupati, Nellore, Karimnagar, Pune, Mumbai, Delhi, Kolkata.';
const END_YESNO_MS = Math.min(2000, Math.max(400, num(process.env.AI_VOICE_END_YESNO_MS, 750)));
const END_OPEN_MS = Math.min(2500, Math.max(600, num(process.env.AI_VOICE_END_OPEN_MS, 1150)));
const OPEN_STEPS = ['qExp', 'qLoc', 'qNotice', 'later_when', 'resched_time', 'why_not'];
// Whisper's known made-up lines on noise / non-English sound (Bag of Hallucinations, arXiv 2501.11378, + our own calls): believed
// only when Whisper was really sure (a real "Thank you." is said with a high logprob)
const MADE_UP = /^(thank you( (so much|very much|for watching|for listening))?|thanks for watching|please subscribe|subscribe|bye( bye)?|you|my god[ ,a-z]*|oh my god|i'm sorry|so|okay so|music|applause|silence|the end|amen|hmm+|uh+|um+)[.!? ]*$/i;
const MAX_WORDS_PER_SEC = 5; // faster than anyone speaks = text made up, not heard
function clarityOf(text, conf, seconds) {
  if (!String(text || '').trim()) return 'unclear'; // the line carried speech (the VAD heard it) but no words came out
  // "ా", "అ", "म": a sound, not a word (real call 2026-10-30) - but a known short answer ("हाँ", "హా", "ఆ") is one
  if (String(text).replace(/[\p{M}\p{P}\s]/gu, '').length < 2 && ['unclear', 'silence'].includes(require('../dialogue').classify(text).intent)) return 'unclear'; // eslint-disable-line global-require
  const words = String(text).trim().split(/\s+/).length;
  if (seconds > 0 && words / seconds > MAX_WORDS_PER_SEC && words > 4) return 'unclear';
  if (conf && typeof conf === 'object' && MADE_UP.test(String(text).trim()) && !(Number(conf.logprob) > -0.35)) return 'unclear';
  if (conf && typeof conf === 'object') {
    const lp = Number(conf.logprob); const ns = Number(conf.noSpeech); const ratio = Number(conf.ratio);
    if (Number.isFinite(lp) && lp < MIN_LOGPROB) return 'unclear';
    if (Number.isFinite(ns) && ns > MAX_NO_SPEECH && Number.isFinite(lp) && lp < -0.7) return 'unclear';
    if (Number.isFinite(ratio) && ratio > MAX_RATIO) return 'unclear';
  }
  return 'clear';
}
// A switch by SOUND alone is believed only when the words heard in the new language make sense: two words or more, or a
// known answer ("avunu", "हाँ"). One unknown word ('आपस्पटोल') is noise: unclear, and the call stays in its language.
function believable(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  return words.length === 1 && !['unclear', 'silence'].includes(require('../dialogue').classify(text).intent); // eslint-disable-line global-require
}

// A Telugu / Hindi answer the English listener could not place: the Indian-language listener's words count only when at
// least one is a REAL Telugu / Hindi word. That listener writes English speech in its own letters ("First November" came
// out as "ఫస్ట్ నవంబర్" and switched an English call to Telugu, 2026-10-29), so script and word count prove nothing.
const NATIVE = {
  Telugu: ['అవును', 'అవునండి', 'అవునా', 'లేదు', 'లేదండి', 'సరే', 'కాదు', 'వద్దు', 'చెప్పండి', 'చెప్పు', 'హా', 'నేను', 'నేనే', 'నాకు', 'నా', 'మీరు', 'మీకు',
    'మీ', 'ఉంది', 'ఉన్నాను', 'ఉంటాను', 'ఉంటున్నాను', 'లో', 'ఇప్పుడు', 'తర్వాత', 'తరువాత', 'రేపు', 'ఎల్లుండి', 'సంవత్సరాలు', 'సంవత్సర', 'ఏళ్ళు', 'రోజులు', 'రోజు',
    'నెలలు', 'నెల', 'ఆసక్తి', 'ఇష్టం', 'మాట్లాడ', 'తెలుగు', 'ఏంటి', 'ఎక్కడ', 'ఎప్పుడు', 'ఎలా', 'ఎందుకు', 'కావాలి', 'వస్తాను', 'చేస్తాను', 'పని', 'ఊరు', 'సాయంత్రం', 'ఉదయం',
    'మధ్యాహ్నం', 'అలాగే', 'పర్లేదు', 'కూడా', 'ఇంకా', 'మళ్ళీ', 'గారు', 'అండి', 'చెప్పండి', 'చెప్పాలి', 'చెప్పన', 'ఏమి', 'ఏం', 'లేదా', 'ఉన్నారు',
    'ఉన్నా', 'ఉంటా', 'చేస్తున్నా', 'చేశాను', 'చేసాను', 'చేస్తా', 'వచ్చు', 'అయితే', 'కదా', 'బాగుంది', 'బాగా', 'ఇక్కడ', 'అక్కడ', 'వెళ్ళ', 'రెండు', 'మూడు',
    'నాలుగు', 'ఐదు', 'ఒక', 'వర్క్ చేస్తున్నా', 'చూస్తా', 'ఆలోచిస్తా', 'వద్దండి', 'ఓకేనా', 'ఎంత', 'ఎన్ని', 'ఉంటుంది', 'ఉంటుందా', 'ఉందా',
    'ఇస్తారా', 'ఇస్తారు', 'కావాలా', 'చేయాలి', 'చేయాలా', 'వెళ్ళాలి', 'ఎవరు', 'ఏమిటి', 'మంచిది'],
  Hindi: ['हाँ', 'हां', 'जी', 'नहीं', 'नही', 'ठीक', 'बोलिए', 'बोलो', 'मैं', 'मुझे', 'मेरा', 'मेरी', 'आप', 'आपका', 'है', 'हैं', 'हूँ', 'हूं', 'में', 'का', 'की', 'के',
    'को', 'से', 'साल', 'दिन', 'महीने', 'कल', 'परसों', 'अभी', 'बाद', 'रहता', 'रहती', 'करता', 'करती', 'बात', 'हिंदी', 'क्या', 'कहाँ', 'कब', 'कैसे', 'क्यों', 'चाहिए',
    'शाम', 'सुबह', 'दोपहर', 'बिल्कुल', 'अच्छा', 'भी', 'और', 'बताइए', 'बताओ', 'सकते', 'सकता', 'सकती', 'रहा', 'रही', 'रहे', 'था', 'थी', 'गया',
    'लेकिन', 'मतलब', 'यहाँ', 'वहाँ', 'दो', 'तीन', 'चार', 'पांच', 'पाँच', 'एक'],
};
function nativeAnswer(text, lang) {
  const t = String(text || '').trim();
  const script = lang === 'Telugu' ? /[ఀ-౿]/g : /[ऀ-ॿ]/g;
  if ((t.match(script) || []).length < 3) return false;
  const words = t.replace(/[.,!?।]/g, ' ').split(/\s+/).filter(Boolean);
  const list = NATIVE[lang] || [];
  return words.some((w) => list.some((n) => w === n || (n.length >= 3 && w.startsWith(n))));
}

// "I'm listening" sounds - not answers when they come in the middle of the assistant's sentence
const BACKCHANNEL = ['ఆ', 'హా', 'హ', 'ఊ', 'హ్మ్', 'ఓకే', 'సరే', 'అవును', 'ఓ', 'ok', 'okay', 'hmm', 'hm', 'yes', 'yeah', 'aa', 'haa', 'haan', 'achha', 'हाँ', 'हां', 'जी', 'हम्म', 'अच्छा', 'ठीक', 'ओके', 'आ'];
// the assistant's own sentence heard back (a SIM line echoes): most of the words heard are words it was saying
function isEcho(heard, said) {
  const w = (t) => String(t || '').toLowerCase().replace(/[.,!?।:;]/g, ' ').split(/\s+/).filter((x) => x.length > 1);
  const h = w(heard); const s = new Set(w(said));
  return h.length >= 2 && h.filter((x) => s.has(x)).length / h.length >= 0.6;
}
function isBackchannel(text) {
  const w = String(text || '').toLowerCase().replace(/[.,!?।]/g, ' ').split(/\s+/).filter(Boolean);
  return w.length > 0 && w.length <= 2 && w.every((x) => BACKCHANNEL.includes(x) || x.replace(/[\p{M}]/gu, '').length <= 1);
}

// HOW MANY real everyday words of that language are in the words heard (0 = no proof it is that language)
function nativeScore(text, lang) {
  const t = String(text || '').trim();
  const script = lang === 'Telugu' ? /[ఀ-౿]/g : /[ऀ-ॿ]/g;
  if ((t.match(script) || []).length < 3) return 0;
  const words = t.replace(/[.,!?।]/g, ' ').split(/\s+/).filter(Boolean);
  const list = NATIVE[lang] || [];
  // a 1-2 letter word ("లో", "నా", "मे") turns up in noise written in that script: it counts half - alone it is no proof
  // (an English "Bangalore. Immediately." was written "టకు లో మీది ఎతుయి" and switched the call to Telugu, 2026-10-30 test)
  return words.filter((w) => list.some((n) => w === n || (n.length >= 4 && w.startsWith(n))))
    .reduce((sum, w) => sum + (w.length >= 3 ? 1 : 0.5), 0);
}
// TELUGU OR HINDI? (founder 2026-10-30: "telugu matladithey, hindi lo theeskuntundhi"). On phone audio Whisper's language
// guess often calls Telugu "Hindi"; the Hindi listener then writes the Telugu sound in Hindi letters ("ఓకే చెప్పండి" came
// out as "ओके चपंडी ह") and the call went over to Hindi. So BOTH listeners hear the answer and the language whose words
// are real everyday words wins; Whisper's guess only breaks a tie. No real words in either = no proof (null).
// known: { Telugu?: text, Hindi?: text } already heard, not asked again.
// prefer: the Telugu / Hindi the person already spoke in this call - it wins a tie (a person rarely changes language)
async function teluguOrHindi(engines, pcm, guess, known = {}, prefer = null) {
  // already heard and clearly that language (2+ everyday words) and the sound did not say the other: no second listener
  for (const l of ['Telugu', 'Hindi']) {
    if (known[l] == null || guess === (l === 'Telugu' ? 'Hindi' : 'Telugu')) continue;
    const t = await known[l]; // eslint-disable-line no-await-in-loop
    known[l] = t; // eslint-disable-line no-param-reassign
    if (nativeScore(t, l) >= 2) return { lang: l, text: t, sT: l === 'Telugu' ? nativeScore(t, l) : 0, sH: l === 'Hindi' ? nativeScore(t, l) : 0 };
  }
  const [te, hi] = await Promise.all(['Telugu', 'Hindi'].map((l) => (known[l] != null ? known[l] : engines.stt(pcm, l).catch(() => ''))));
  const sT = nativeScore(te, 'Telugu'); const sH = nativeScore(hi, 'Hindi');
  if (sT < 1 && sH < 1) return null; // no real word in either
  const tie = ['Telugu', 'Hindi'].includes(prefer) ? prefer : (guess === 'Hindi' ? 'Hindi' : 'Telugu');
  // eslint-disable-next-line no-nested-ternary
  let lang = sT > sH ? 'Telugu' : sH > sT ? 'Hindi' : tie;
  if (['Telugu', 'Hindi'].includes(prefer) && lang !== prefer && Math.abs(sT - sH) < 2) lang = prefer;
  return { lang, text: lang === 'Telugu' ? te : hi, sT, sH };
}

const sentences = (text) => String(text || '').split(/(?<=[.?!।])\s+/).map((s) => s.trim()).filter(Boolean);
const talkTime = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec} s`);

// CLEAR ON THE PHONE (2026-10-30: "voice clearity ga vundeylaaga, gaps lekunda"). Measured on our voices: English hit the
// top of the scale (32767, it crackles on the line) and the three voices differed in loudness (English ~4000, Telugu up to
// ~7100, Hindi ~6000). Every sentence is: trimmed of its own silence at both ends (40 ms kept), brought to one loudness, and
// kept under a ceiling so nothing clips. Text and timing are unchanged.
const TARGET_RMS = 5000; // the same loudness for every voice / language
const CEILING = 26000; // never louder than this (the line distorts near 32767)
function polish(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n < 160) return pcm;
  const F = 160; // 20 ms frames at 8 kHz
  const frames = [];
  for (let i = 0; i + F <= n; i += F) { let sq = 0; for (let k = 0; k < F; k += 1) { const v = pcm.readInt16LE((i + k) * 2); sq += v * v; } frames.push(Math.sqrt(sq / F)); }
  const loud = Math.max(...frames);
  if (!loud) return pcm;
  const th = Math.max(150, loud * 0.05);
  let first = frames.findIndex((x) => x > th); if (first < 0) return pcm;
  let last = frames.length - 1; while (last > first && frames[last] <= th) last -= 1;
  first = Math.max(0, first - 2); last = Math.min(frames.length - 1, last + 2); // keep 40 ms of the soft start / end
  const from = first * F; const to = Math.min(n, (last + 1) * F);
  const voiced = frames.slice(first, last + 1);
  const rms = Math.sqrt(voiced.reduce((a, x) => a + x * x, 0) / voiced.length) || 1;
  let peak = 1; for (let i = from; i < to; i += 1) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
  const gain = Math.min(TARGET_RMS / rms, CEILING / peak, 4); // louder only up to 4x, never past the ceiling
  const out = Buffer.alloc((to - from) * 2);
  for (let i = from; i < to; i += 1) out.writeInt16LE(Math.max(-CEILING, Math.min(CEILING, Math.round(pcm.readInt16LE(i * 2) * gain))), (i - from) * 2);
  return out;
}

// ONE QUEUE PER VOICE, the live call first (2026-10-30): the Hindi voice (Kokoro, on the server) makes one sentence at a
// time. Sentences sent all at once were made in any order - the FIRST sentence of a goodbye waited 12 s behind the others -
// and the background "prepare" work could hold up a live reply. Now each language's voice works through its own queue:
// live sentences (high) in the order they are said, background preparing (low) only when nothing live is waiting.
const lanes = new Map(); // lang -> { busy, high: [], low: [] }
const pending = new Map(); // `${lang}|${sentence}` -> job (asked twice = made once; a live ask lifts a waiting low job)
function pump(lang) {
  const lane = lanes.get(lang);
  if (!lane || lane.busy) return;
  const job = lane.high.shift() || lane.low.shift();
  if (!job) return;
  lane.busy = true;
  job.started = true;
  Promise.resolve().then(() => job.engines.tts(require('./speakScript').native(job.sentence, lang), lang)) // eslint-disable-line global-require
    .then((pcm) => { const out = polish(pcm); if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); cache.set(job.key, out); diskPut(job.engines, job.key, out); job.resolve(out); })
    .catch((e) => job.reject(e))
    .finally(() => { pending.delete(job.key); lane.busy = false; pump(lang); });
}
function voiceOf(engines, sentence, lang, high = true) {
  const key = `${lang}|${sentence}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const saved = diskGet(engines, key);
  if (saved && saved.length) { if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); cache.set(key, saved); return Promise.resolve(saved); }
  if (!lanes.has(lang)) lanes.set(lang, { busy: false, high: [], low: [] });
  const lane = lanes.get(lang);
  const had = pending.get(key);
  if (had) {
    if (high && !had.high && !had.started) { lane.low = lane.low.filter((j) => j !== had); had.high = true; lane.high.push(had); }
    return had.promise;
  }
  const job = { key, sentence, engines, high, started: false };
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  pending.set(key, job);
  (high ? lane.high : lane.low).push(job);
  pump(lang);
  return job.promise;
}

// Make every sentence of one call before it is dialled (we know the name, job, date): no waiting during the call.
// background work: low priority, never ahead of a live sentence
async function prepare(engines, lines, lang) {
  for (const l of lines) for (const s of sentences(l)) await voiceOf(engines, s, lang, false); // eslint-disable-line no-await-in-loop
}

// EVERY sentence this call may need, made while the phone rings (2026-10-29: "chaala slow ga respond avuthundhi"): the
// job's own lines first (name, intro, brief, questions), then the fixed replies. Kept, so later calls get them free.
// ownOnly: just this job's own lines (after a language switch - the fixed replies are made at start-up and kept on disk)
function prepareCall(engines, d, { ownOnly = false } = {}) {
  const own = Object.values(d.B || {}).flat().filter((t) => typeof t === 'string' && t);
  const fixed = ownOnly ? [] : Object.values(d.P || {}).filter((t) => typeof t === 'string' && t && !t.includes('{'));
  return prepare(engines, [...own, ...fixed], d.language).catch((e) => log('prepare failed:', e.message));
}
// The fixed replies of every language, once when the gateway starts (idle time), so the first calls are quick too.
function prepareFixed(engines, S) {
  return S.LANGS.reduce((p, lang) => p.then(() => prepare(engines, Object.values(S.phrases(lang)).filter((t) => typeof t === 'string' && t && !t.includes('{')), lang)).catch(() => {}), Promise.resolve());
}

// Plays PCM to Asterisk at real-time pace (20 ms frames). stop() = silence at once (barge-in).
// Paced by the clock, not by the timer count: Windows timers fire every ~16 ms, so "one frame per tick" came out uneven
// and crackled on the line. Every 5 ms it sends exactly the frames that are due since playback began.
class Speaker {
  constructor(sock) { this.sock = sock; this.queue = []; this.timer = null; this.onIdle = null; this.sent = 0; this.t0 = 0; this.done = 0; this.quietSince = Date.now(); }
  get busy() { return this.queue.length > 0; }
  add(pcm) {
    for (let i = 0; i < pcm.length; i += A.FRAME_BYTES) {
      const f = Buffer.alloc(A.FRAME_BYTES); pcm.copy(f, 0, i, Math.min(pcm.length, i + A.FRAME_BYTES)); this.queue.push(f);
    }
    if (!this.timer) { this.t0 = Date.now(); this.done = 0; this.timer = setInterval(() => this.tick(), 5); }
  }
  tick() {
    const due = Math.floor((Date.now() - this.t0) / A.FRAME_MS) + 1 - this.done;
    for (let k = 0; k < due && this.queue.length; k += 1) {
      const f = this.queue.shift(); this.done += 1;
      if (!this.sock.destroyed) { this.sock.write(A.encode(A.KIND.AUDIO, f)); this.sent += 1; }
    }
    if (!this.queue.length) { clearInterval(this.timer); this.timer = null; this.quietSince = Date.now(); const cb = this.onIdle; this.onIdle = null; if (cb) cb(); }
  }
  stop() { this.queue = []; if (this.timer) { clearInterval(this.timer); this.timer = null; } this.quietSince = Date.now(); const cb = this.onIdle; this.onIdle = null; if (cb) cb(); }
  whenIdle() { return this.busy || this.timer ? new Promise((r) => { this.onIdle = r; }) : Promise.resolve(); }
}

async function finish(row, d, why) {
  const result = why ? d.hangup(why) : d.outcome();
  const t = new Date();
  const durationSec = row.startedAt ? Math.max(0, Math.round((t - new Date(row.startedAt)) / 1000)) : null;
  if (durationSec != null) result.summary = `${result.summary} Talked for ${talkTime(durationSec)} (AI phone call).`.slice(0, 600);
  await svc.setRow(row.id, { botStateJson: JSON.stringify({ ...d.snapshot(), done: true }), status: 'completed', language: d.language, endedAt: t.toISOString(), durationSec, providerStatus: 'audiosocket' });
  await require('../outcomes').applyResult(row.id, result, d.transcript()); // eslint-disable-line global-require
  // the language they spoke is where the next call starts
  if (row.candidateId && d.language) await require('../schema').run('INSERT OR REPLACE INTO "AiCallPref" ("candidateId","language","source","updatedAt") VALUES (?,?,?,?)', row.candidateId, d.language, 'call', t.toISOString()).catch(() => {}); // eslint-disable-line global-require
  return result;
}

// One phone call.
function handle(sock, engines, opts = {}) {
  const reader = new A.Reader();
  const speaker = new Speaker(sock);
  let row = null; let d = null; let ended = false; let saved = false; let busy = false; let pending = null; let gen = 0;
  let lastVoice = Date.now(); let quietTimer = null;
  let spoken = null; // the Telugu / Hindi this person has spoken in this call
  // the talk so far, after every turn (a dropped line or a restart keeps it); never blocks or breaks the call
  const keepTurns = () => (row && d ? require('../outcomes').saveTurns(row.id, d.transcript()).catch(() => false) : Promise.resolve(false)); // eslint-disable-line global-require
  // the result is saved exactly once: at the assistant's own goodbye, or when the line drops (even during that goodbye)
  const save = (why) => { if (saved || !row || !d) return null; saved = true; return finish(row, d, why).catch((e) => log('finish failed:', e.message)); };
  const hangup = () => { if (!sock.destroyed) { sock.write(A.encode(A.KIND.HANGUP)); sock.end(); } };

  // what the assistant is saying now, sentence by sentence, and the line frame where each sentence ends
  let current = null; // { parts: [sentence], ends: [frame] }
  let interrupted = null; // { rest: 'the sentences not said yet', at: ms } - set when the person talks over the assistant
  async function say(text) {
    const my = ++gen; // a newer reply (or a barge-in) cancels the rest of this one
    current = { parts: [], ends: [] }; interrupted = null;
    if (DEBUG && row) debug(`${row.id} says [${d.language}]: ${text}`);
    const t0 = Date.now(); let firstOut = true;
    // every sentence of the reply is made AT ONCE and played in order: the second is ready while the first plays (made one
    // after another, a Hindi sentence took 2.4-3.3 s and left a hole in the middle of the reply - 2026-10-30)
    const lang = d.language;
    const jobs = sentences(text).map((s) => voiceOf(engines, s, lang).catch((e) => { log('tts failed:', e.message); return null; }));
    for (const job of jobs) {
      const pcm = await job; // eslint-disable-line no-await-in-loop
      if (!pcm) continue;
      if (my !== gen || sock.destroyed) return;
      speaker.add(pcm); speaker.add(E.silence(GAP_MS));
      current.parts.push(sentences(text)[jobs.indexOf(job)]); current.ends.push(speaker.sent + speaker.queue.length);
      if (DEBUG && row && firstOut) { firstOut = false; debug(`${row.id} voice ready in ${Date.now() - t0} ms`); }
    }
  }

  // One answer (or a silence) -> the assistant's reply. A failing engine or database never leaves the line silent.
  async function reply(text, meta) {
    const before = d.language;
    const out = await d.hear(text, meta);
    // switched language: this job's lines in the new language are made in the background now, so the next replies are ready
    if (d.language !== before && !out.done) prepareCall(engines, d, { ownOnly: true });
    await svc.setRow(row.id, { botStateJson: JSON.stringify({ ...d.snapshot(), done: !!out.done }) }).catch((e) => log('state not saved:', e.message));
    await keepTurns();
    await say(out.say);
    if (out.done) {
      ended = true;
      await speaker.whenIdle();
      await save();
      hangup();
    }
  }

  async function heard(pcm) {
    if (ended || !d) return;
    if (busy) { pending = pcm; return; } // keep only the latest sentence said while we were still thinking
    busy = true;
    try {
      // which language + the words, at the same time; only when the person really switched is it heard again in the new one
      // (a clip under ~2 s with its end pause - "yes", "haan theek" - is too short to tell a language by sound)
      const t0 = Date.now();
      const cur = d.language;
      // the words AND Whisper's sureness ({ text, conf }); an engine without sttEx gives words only (conf null)
      // the question just asked, for Whisper's prompt (English calls): a short "yes" is heard far better knowing it (2026-10-29)
      const ask = cur === 'English' ? `${String(d.st.lastAsk || '')}${d.st.step === 'qLoc' ? CITY_HINT : ''}` : '';
      // an OPEN answer (which city, how many years, notice period, when to call) is heard by the more exact English model
      const exact = OPEN_STEPS.includes(d.st.step);
      const listen = (l) => (engines.sttEx ? engines.sttEx(pcm, l, l === 'English' ? ask : '', l === 'English' && exact) : engines.stt(pcm, l).then((t) => ({ text: t, conf: null })))
        .then((r) => ({ text: (r && r.text) || '', conf: (r && r.conf) || null }))
        .catch((e) => { log('stt failed:', e.message); return { text: '', conf: null }; });
      let found = null; let first = { text: '', conf: null }; let byScript = false; let enProb = null;
      // how much real speech (Silero VAD, server) - asked at the same time as the words, so it costs no time
      const speechP = engines.speech ? engines.speech(pcm) : Promise.resolve(null);
      // (Starting BOTH other listeners on every turn was tried: it loaded the speech server and made every reply ~1 s slower.)
      // An ENGLISH call starts ONE Indian listener at the same time as Whisper - the language the person already spoke in
      // this call, else Telugu (Hyderabad) - on a different server, so nothing queues; a switch then has its words at once
      // (the real call 2026-10-30 waited 3.8 s for them after Whisper).
      const spec = {};
      // (not on an open answer: the exact English model needs the CPU then)
      if (engines.stt && cur === 'English' && !exact && pcm.length >= A.RATE * 2 * 0.6) { const l = spoken || 'Telugu'; spec[l] = engines.stt(pcm, l).catch(() => ''); }
      {
        // ENGLISH MODE (2026-10-29: "madhyalo telugu or hindi use chesthey, sorry i cant understand ani ..."): the English
        // model turns Telugu into English-looking words, so a Telugu / Hindi sound is believed more easily there (0.6).
        // (Whisper's own any-language writing was tried and wrote Telugu as Tamil / Arabic letters on phone audio: not used.)
        const sure = cur === 'English' || pcm.length >= A.RATE * 2 * 2 ? 0.6 : 0.75;
        if (cur === 'English' && engines.hear) {
          // one Whisper pass: the language, and the English words only when it is English (2026-10-29: "chaala late")
          const h = await engines.hear(pcm, pcm.length >= A.RATE * 2 * 1.4 ? sure : 0.75, ask, exact).catch((e) => { log('hear failed:', e.message); return { lang: 'English', text: '', conf: null }; });
          if (h.lang !== 'English') { found = h.lang; byScript = true; } else { first = { text: h.text || '', conf: h.conf || null }; enProb = typeof h.prob === 'number' ? h.prob : null; }
        } else {
          // Telugu / Hindi mode: the words and Whisper's language check side by side, on EVERY answer of 1.4 s or more. (A
          // skip-when-understood shortcut missed English: the Telugu model writes "Yes, I have ..." as "యెస్ ఐ హావ్ ...",
          // which reads as a yes - founder 2026-10-29: "madhyalo english matladthunte kuda telugu lo ney matladthundhi".)
          [found, first] = await Promise.all([
            engines.detect && pcm.length >= A.RATE * 2 * 1.4 ? engines.detect(pcm, sure).catch((e) => { log('detect failed:', e.message); return null; }) : null,
            listen(cur),
          ]);
        }
      }
      // a click, a cough, a line noise (under NOISE_MS of real speech): not an answer - nothing is said back, nothing switches
      const sp = await speechP;
      if (sp && Number.isFinite(sp.speechMs) && sp.speechMs < NOISE_MS) {
        if (DEBUG) debug(`${row.id} ignored ${(pcm.length / 16000).toFixed(1)}s of sound: only ${sp.speechMs} ms of speech`);
        return;
      }
      if (byScript) first = { text: '', conf: null }; // heard again below in the language found
      let pre = null; // the words already heard in the language decided by teluguOrHindi
      if (found && found !== cur && ['Telugu', 'Hindi'].includes(found) && engines.stt) {
        const known = ['Telugu', 'Hindi'].includes(cur) ? { ...spec, [cur]: first.text } : { ...spec };
        const th = await teluguOrHindi(engines, pcm, found, known, spoken);
        if (th) {
          if (DEBUG && th.lang !== found) debug(`${row.id} sound said ${found}, the words say ${th.lang} (Telugu ${th.sT} / Hindi ${th.sH})`);
          found = th.lang; pre = { text: th.text, conf: null };
          if (found === cur) { first = pre; byScript = false; }
        } else {
          // NO PROOF, NO SWITCH (real calls 2026-10-30: "ल मक", "कि अ" moved Telugu / English calls to Hindi): neither listener
          // heard a real Telugu / Hindi word, so the call stays in its language and the answer is heard in it
          if (DEBUG) debug(`${row.id} sound said ${found}, but no real Telugu / Hindi words: staying in ${cur}`);
          found = null;
          if (byScript) { byScript = false; first = await listen(cur); }
        }
      }
      // ...and a Telugu / Hindi call does not go to English on English-looking words that make no sense ("My God, Adam."
      // was Telugu speech): English must be understood, or a real sentence
      if (found === 'English' && cur !== 'English' && nativeScore(first.text, cur) >= 1) {
        if (DEBUG) debug(`${row.id} sound said English, but "${first.text}" is real ${cur}: staying in ${cur}`);
        found = null;
      }
      if (found === 'English' && cur !== 'English') {
        const en = await listen('English');
        const words = en.text.trim().split(/\s+/).filter(Boolean).length;
        // a "question" word alone is no proof ("हाँ, इंटरेस्ट है" was written "How interesting!" and read as a question)
        const understoodEn = !['unclear', 'silence', 'info_q'].includes(require('../dialogue').classify(en.text).intent); // eslint-disable-line global-require
        if (understoodEn || (words >= 4 && clarityOf(en.text, en.conf) === 'clear')) pre = en;
        else { if (DEBUG) debug(`${row.id} sound said English, but "${en.text}" makes no sense: staying in ${cur}`); found = null; }
      }
      // a short answer that already makes sense in the current language ("haan theek", "avunu", "yes") is not a switch:
      // Whisper guesses badly on a second of sound (heard 'हाँ, ठीक है' as English in the 2026-10-28 test)
      const shortClip = pcm.length < A.RATE * 2 * 2;
      const understood = !byScript && shortClip && found && found !== cur && !['unclear', 'silence'].includes(require('../dialogue').classify(first.text).intent); // eslint-disable-line global-require
      let lang = (understood ? null : found) || cur;
      // eslint-disable-next-line no-nested-ternary
      const r = lang === cur && !byScript ? first : (pre && lang === found ? pre : await listen(lang));
      let heardAs = clarityOf(r.text, r.conf, pcm.length / 16000);
      // a language guessed from the sound whose words make no sense in that language: noise, not a switch
      if (lang !== cur && !believable(r.text)) {
        if (DEBUG) debug(`${row.id} not switching to ${lang}: "${r.text}" does not make sense`);
        lang = cur; heardAs = 'unclear';
      }
      // ENGLISH CALL, ANSWER NOT CLEARLY ENGLISH (2026-10-29: "language switch avvatledhu"): Whisper was unsure it was English
      // (a Telugu sentence came out as "I'm going to get ready to cool", 41% English) or the words were a guess. Before asking
      // again, the Telugu and Hindi listeners try the same audio; clearly Telugu / Hindi words switch the call.
      let r2 = r;
      if (['Telugu', 'Hindi'].includes(cur) && lang === cur && engines.stt && !nativeScore(r.text, cur)
        && ['unclear', 'silence'].includes(require('../dialogue').classify(r.text).intent)) { // eslint-disable-line global-require
        const other = cur === 'Telugu' ? 'Hindi' : 'Telugu';
        const th = await teluguOrHindi(engines, pcm, cur, { ...spec, [cur]: r.text }, spoken);
        if (th && th.lang === other) {
          if (DEBUG) debug(`${row.id} "${r.text}" is not ${cur}; the ${other} words make sense: back to ${other}`);
          lang = other; r2 = { text: th.text, conf: null }; heardAs = 'clear'; found = other;
        }
      }
      // (only when English really is in doubt: unclear words, or Whisper under 50% sure it was English)
      const unsureEn = heardAs === 'unclear' || (enProb != null && enProb < 0.5);
      if (cur === 'English' && lang === 'English' && !unsureEn && spoken && spec[spoken]) {
        // sure-looking English from a person who spoke Telugu / Hindi before ("I'm going to call the police" was Telugu):
        // their own language's words, already heard at the same time, decide - no extra wait
        const own = await spec[spoken];
        if (nativeScore(own, spoken) >= 2) {
          if (DEBUG) debug(`${row.id} "${r2.text}" was really ${spoken}: ${own}`);
          lang = spoken; r2 = { text: own, conf: null }; heardAs = 'clear'; found = spoken;
        }
      }
      if (cur === 'English' && lang === 'English' && engines.stt && unsureEn) {
        const th = await teluguOrHindi(engines, pcm, null, { ...spec }, spoken);
        const pick = th ? [th.lang, th.text] : null;
        if (DEBUG) debug(`${row.id} English unsure (${enProb == null ? '?' : enProb}, ${heardAs})${th ? `: Telugu ${th.sT} / Hindi ${th.sH} words -> ${th.lang}: ${th.text}` : ': no Telugu / Hindi words'}`);
        if (pick) { lang = pick[0]; r2 = { text: pick[1], conf: null }; heardAs = 'clear'; found = pick[0]; }
      }
      const { text } = r2;
      // A LISTENING NOISE OVER THE ASSISTANT (founder 2026-10-30: "matladuthu matladuthu agi pothundhi"): "ఆ", "హా", "ok",
      // "हाँ", a cough - said while the assistant was still explaining - is not an answer. The assistant goes on with the rest of
      // what it was saying. (Over the LAST sentence - the question - a "yes" is the answer and is read as one.)
      const cut = interrupted && Date.now() - interrupted.at < 15000 ? interrupted : null;
      interrupted = null;
      if (cut && cut.rest.length > 1 && (heardAs !== 'clear' || isBackchannel(text) || isEcho(text, cut.rest.join(' ')))) {
        if (DEBUG) debug(`${row.id} "${text}" over the assistant: going on with what it was saying`);
        await say(cut.rest.join(' '));
        return;
      }
      // the Telugu / Hindi the person speaks in this call (it wins a later tie)
      if (['Telugu', 'Hindi'].includes(lang) && heardAs === 'clear' && nativeScore(text, lang)) spoken = lang;
      if (opts.onHeard) opts.onHeard(text, lang);
      if (DEBUG) debug(`${row.id} heard [${lang}${found ? ' by sound' : ''}] ${(pcm.length / 16000).toFixed(1)}s in ${Date.now() - t0} ms, ${heardAs}: ${text}`);
      await reply(text, { heard: heardAs, lang });
    } catch (e) {
      // the brain / an engine / the database failed on this answer: say a safe line and wait for the next one
      log('turn failed:', e.message);
      if (!ended && d && !sock.destroyed) await say(d.P.notClear).catch(() => {});
    } finally {
      busy = false;
      if (pending && !ended) { const p = pending; pending = null; heard(p); }
    }
  }

  const vad = new Vad({
    strict: () => speaker.busy,
    // a yes / no question: a short pause ends the answer; "how many years / which city / when": people think aloud, wait longer
    endMs: () => (d && OPEN_STEPS.includes(d.st.step) ? END_OPEN_MS : END_YESNO_MS),
    onStart: () => { lastVoice = Date.now(); if (speaker.busy) {
      // what was not said yet (the sentence cut and the ones after it): said again if this turns out to be only "ఆ" / "ok"
      if (current) { const played = speaker.sent; const i = current.ends.findIndex((e) => e > played); interrupted = i >= 0 ? { rest: current.parts.slice(i), at: Date.now() } : null; }
      gen += 1; speaker.stop(); if (DEBUG && row) debug(`${row.id} interrupted by the caller`); if (opts.onBargeIn) opts.onBargeIn(); } }, // the person talks: the assistant stops at once
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
    await keepTurns();
    if (opts.onStart) opts.onStart(row);
    await say(first.say);
    // SILENCE: nothing said for SILENCE_MS after the assistant went quiet -> "are you still there?" (never yes / no / consent)
    quietTimer = setInterval(() => {
      if (ended || busy || !d || speaker.busy || speaker.timer || vad.talking) return;
      const since = Math.max(speaker.quietSince, lastVoice);
      if (Date.now() - since < SILENCE_MS) return;
      lastVoice = Date.now(); // one check-in per quiet stretch
      busy = true;
      if (DEBUG) debug(`${row.id} no reply for ${Math.round(SILENCE_MS / 1000)} s`);
      reply('', { heard: 'none' }).catch((e) => log('silence turn failed:', e.message)).finally(() => {
        busy = false;
        if (pending && !ended) { const p = pending; pending = null; heard(p); }
      });
    }, 500);
  }

  sock.on('data', (chunk) => {
    for (const m of reader.feed(chunk)) {
      if (m.kind === A.KIND.UUID) begin(A.uuidText(m.payload)).catch((e) => { log('start failed:', e.message); hangup(); });
      else if (m.kind === A.KIND.AUDIO) { for (let i = 0; i + A.FRAME_BYTES <= m.payload.length; i += A.FRAME_BYTES) vad.push(m.payload.subarray(i, i + A.FRAME_BYTES)); }
      else if (m.kind === A.KIND.HANGUP) sock.end();
    }
  });
  sock.on('close', () => {
    if (quietTimer) { clearInterval(quietTimer); quietTimer = null; }
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

module.exports = { polish, nativeAnswer, nativeScore, teluguOrHindi, isBackchannel, clarityOf, believable, SILENCE_MS, start, handle, prepare, prepareCall, prepareFixed, sentences, VIA, engines: () => ENGINES || (ENGINES = E.fromEnv()), _cache: cache };
