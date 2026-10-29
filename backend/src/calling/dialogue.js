// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE DIALOGUE ENGINE ("the AI brain"), testable with plain text.
//
// The audio part (speech to text, text to speech, the Exotel Voicebot stream) lives outside this file and CANNOT be tested
// without Exotel. This file takes what the candidate SAID AS TEXT and answers with the next sentence to speak:
//
//     const d = new Dialogue({ purpose, language, data, fields });
//     d.start()           -> { say, done }
//     await d.hear(text)  -> { say, done }
//     d.outcome()         -> a validated JSON result (validateOutcome)
//
// GUARDRAILS
//   * every sentence is a FIXED sentence from scripts.js with verified slots; the model never writes free speech
//   * the first sentence says it is an AI assistant of TeamLink Consultants
//   * nothing about the job / shortlist / interview is said before the person confirms their name
//   * "shortlisted", never selected / hired / offered; no promise; no salary unless it is in the database
//   * the candidate's words are UNTRUSTED: they are matched against fixed word lists (and, if configured, a classifier that can
//     only return one word from a fixed list). They are never obeyed, never put into a prompt, never repeated back except as a
//     short sanitised note (place, notice days, a preferred time)
//   * a call can only END with one of the allowed outcomes for its purpose; the result is validated before it is saved
// ---------------------------------------------------------------------------
const S = require('./scripts');

const OUTCOMES = {
  Screening: ['Interested', 'Not Interested', 'Call Back Later', 'Unclear'],
  'Shortlist Notification': ['Interested', 'Not Interested', 'Call Back Later', 'Unclear'],
  'Interview Notification': ['Confirmed', 'Reschedule Requested', 'Not Available', 'No Response'],
  'Interview Reminder': ['Confirmed', 'Reschedule Requested', 'Not Available', 'No Response'],
};
const INTENTS = ['stop', 'human', 'later', 'reschedule', 'ai_q', 'salary_q', 'info_q', 'other_cand', 'no', 'yes', 'silence', 'unclear'];

// --- reading what the person said --------------------------------------------------------------------------------------
const DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9', '౦': '0', '౧': '1', '౨': '2', '౩': '3', '౪': '4', '౫': '5', '౬': '6', '౭': '7', '౮': '8', '౯': '9' };
function norm(text) {
  return String(text == null ? '' : text).normalize('NFKC').replace(/[०-९౦-౯]/g, (d) => DIGITS[d]).toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ').replace(/[.,!?;:।"'`()[\]{}\-_/\\|]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const ascii = (w) => /^[\x00-\x7f]+$/.test(w);
// one entry matches when: a multi-word entry is inside the text (a Telugu / Hindi one may carry an ending on its last word, but
// must START at a word: "बाद में" is not inside "हैदराबाद में"); a word equals a token; a long non-Latin word starts a token (endings)
function has(text, list) {
  const tokens = text.split(' ');
  const padded = ` ${text} `;
  return list.some((e) => {
    if (e.includes(' ')) return padded.includes(` ${e} `) || (!ascii(e) && padded.includes(` ${e}`));
    if (tokens.includes(e)) return true;
    return !ascii(e) && e.length >= 3 && tokens.some((t) => t.startsWith(e));
  });
}
const L = {
  stop: ['do not call', 'dont call', 'don t call', 'stop calling', 'remove my number', 'remove me', 'never call', 'do not disturb', 'unsubscribe', 'call mat', 'phone mat', 'कॉल मत', 'फोन मत', 'कॉल न करें', 'परेशान मत', 'కాల్ చేయకండి', 'కాల్ చేయొద్దు', 'కాల్ వద్దు', 'call cheyakandi', 'call cheyoddu'],
  human: ['human', 'real person', 'a person', 'someone', 'recruiter', 'talk to a', 'speak to a', 'speak with a', 'manager', 'insaan', 'इंसान', 'रिक्रूटर', 'किसी से बात', 'आदमी', 'మనిషి', 'రిక్రూటర్', 'వ్యక్తి', 'మేనేజర్', 'ఎవరైనా'],
  ai_q: ['robot', 'are you ai', 'are you a bot', 'are you human', 'are you a human', 'are you a person', 'are you real', 'is this a human', 'real person or', 'machine', 'automated', 'bot', 'ai',
    'insaan ho', 'manishaa', 'manishena', 'रोबोट', 'मशीन', 'आप इंसान', 'రోబో', 'మెషిన్', 'మనిషా', 'మనిషేనా', 'మనిషి నా'],
  other: ['other candidate', 'other candidates', 'another candidate', 'someone else', 'other people', 'who else', 'names of', 'list of candidates', 'all candidates'],
  salary: ['salary', 'pay', 'ctc', 'package', 'lpa', 'how much', 'stipend', 'वेतन', 'सैलरी', 'तनख्वाह', 'पैकेज', 'జీతం', 'జీతము', 'వేతనం', 'జీతమెంత'],
  later: ['later', 'call back', 'call me back', 'not now', 'busy', 'driving', 'in a meeting', 'meeting', 'tomorrow', 'another time', 'some other time', 'after some time', 'evening', 'next week', 'baad mein', 'baad me', 'abhi nahi', 'kal', 'बाद में', 'अभी नहीं', 'व्यस्त', 'कल', 'शाम', 'తర్వాత', 'తరువాత', 'ఇప్పుడు కాదు', 'బిజీ', 'రేపు', 'సాయంత్రం', 'taruvata', 'taruvaata', 'ippudu kaadu', 'repu'],
  resched: ['reschedule', 'change the time', 'change time', 'another time', 'different time', 'other time', 'postpone', 'can we move', 'move it', 'समय बदल', 'दूसरा समय', 'दूसरे समय', 'సమయం మార్చ', 'టైమ్ మార్చ', 'వేరే సమయం', 'మరో సమయం', 'వాయిదా', 'vere samayam'],
  no: ['no', 'nope', 'nah', 'not', 'cannot', 'cant', 'can t', 'wont', 'dont', 'wrong', 'nahi', 'nahin', 'nhi', 'नहीं', 'नही', 'కాదు', 'లేదు', 'లేద', 'వద్దు', 'kaadu', 'ledu', 'vaddu', 'not interested', 'not me', 'నో', 'నొ', 'नो', 'नॉट'],
  yes: ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'correct', 'right', 'speaking', 'sounds good', 'go ahead', 'interested', 'available', 'i can', 'of course', 'definitely', 'absolutely', 'haan', 'han', 'haa', 'ji', 'theek', 'bilkul', 'avunu', 'sare', 'sari', 'हाँ', 'हां', 'जी', 'ठीक', 'बिल्कुल', 'सही', 'అవున', 'సరే', 'సరి', 'అలాగే', 'ఓకే', 'ఉన్నాను', 'ఆసక్తి ఉంది', 'ఇష్టం', 'ఎస్', 'యెస్', 'యస్', 'యా', 'ఓకే', 'ఓకె', 'కరెక్ట్', 'స్పీకింగ్', 'యస', 'यस', 'येस', 'यस्', 'एस', 'ओके', 'ओक', 'करेक्ट', 'स्पीकिंग', 'या'],
  info: ['what', 'where', 'which', 'who', 'when', 'how', 'why', 'details', 'tell me', 'more info', 'location', 'address', 'company', 'client', 'link', 'kya', 'kahan', 'kaun', 'kab', 'kaise', 'क्या', 'कहाँ', 'कहां', 'कौन', 'कब', 'कैसे', 'क्यों', 'ఏమిటి', 'ఎక్కడ', 'ఎవరు', 'ఎప్పుడు', 'ఎలా', 'ఎందుకు', 'ఏంటి'],
  immediate: ['immediate', 'immediately', 'serving', 'free', 'fresher', 'तुरंत', 'वेंटनहीं', 'వెంటనే', 'ఇప్పుడే'],
  // the person is upset (user rule 2026-10-28: stay calm, apologise, keep it short, offer a recruiter; never argue)
  angry: ['irritating', 'irritated', 'annoying', 'annoyed', 'disturbing', 'frustrating', 'frustrated', 'nonsense', 'rubbish', 'stupid', 'idiot', 'useless', 'wasting', 'time waste',
    'waste of time', 'shut up', 'angry', 'how many times', 'already told', 'again and again', 'bakwas', 'pareshan', 'baar baar', 'kitni baar', 'बकवास', 'परेशान', 'बार बार', 'कितनी बार',
    'दिमाग खराब', 'chiraku', 'visugu', 'enni sarlu', 'malli malli', 'pichi', 'విసుగు', 'చిరాకు', 'ఎన్ని సార్లు', 'మళ్ళీ మళ్ళీ', 'టైమ్ వేస్ట్', 'చెత్త', 'పిచ్చి'],
  // money / fraud worries: answered with the fixed "TeamLink never asks for money" sentence
  scam: ['fraud', 'scam', 'fake', 'cheat', 'cheating', 'fee', 'fees', 'deposit', 'registration fee', 'money', 'otp', 'bank details', 'paisa', 'paise', 'dabbu', 'dabbulu', 'mosam',
    'फ्रॉड', 'धोखा', 'पैसे', 'फीस', 'ओटीपी', 'ఫ్రాడ్', 'మోసం', 'డబ్బు', 'ఫీజు', 'ఓటీపీ'],
};
const NO_BUT_FINE = ['no problem', 'not a problem', 'not bad', 'no issue'];

// --- which language the person is speaking (user rule 2026-10-28: answer in the person's language, switch at once) ---------
// Script first (Telugu / Devanagari letters), then romanised Telugu / Hindi words, then plain English. One or two English
// words ("ok", "yes") never switch the call. Returns null (stay) or { lang, only } - only = the person just asked for a language.
const ROMAN = {
  Telugu: ['avunu', 'ledu', 'ledhu', 'kaadu', 'kadu', 'cheppandi', 'cheppu', 'naaku', 'naku', 'meeru', 'emi', 'enti', 'ekkada', 'undi', 'undhi', 'vaddu', 'ippudu', 'taruvata',
    'tarvatha', 'repu', 'nenu', 'matladandi', 'telusu', 'kavali', 'chestanu', 'chesthanu', 'andi', 'garu', 'sare'],
  Hindi: ['haan', 'nahi', 'nahin', 'kya', 'hai', 'hain', 'mera', 'meri', 'mujhe', 'aap', 'aapka', 'kahan', 'theek', 'thik', 'baad', 'abhi', 'bilkul', 'hoon', 'kaun', 'kyun', 'batao',
    'bataiye', 'chahiye', 'karunga', 'sakta', 'mein'],
};
// "can we talk in English", "हिंदी में बात करो", "తెలుగులో మాట్లాడండి": a request to switch, not an answer
const LANG_ASK = /\b(talk|speak|continue|switch|change)\b|\bbaat\b|\bbol|matlad|మాట్లాడ|बात|बोल/i;
const LANG_NAMES = [
  ['Telugu', /\btelugu\b|తెలుగు|तेलुगु/i],
  ['Hindi', /\bhindi\b|हिंदी|हिन्दी|హిందీ/i],
  ['English', /\benglish\b|इंग्लिश|अंग्रेज़?ी|ఇంగ్లీష్|ఇంగ్లిష్|ఆంగ్ల/i],
];
function detectLanguage(textIn) {
  const raw = String(textIn == null ? '' : textIn).normalize('NFKC');
  const t = norm(raw);
  if (!t) return null;
  const words = t.split(' ').filter(Boolean);
  const named = LANG_NAMES.filter(([, re]) => re.test(raw)).map(([l]) => l);
  if (named.length === 1 && words.length <= 8) {
    const k = classify(raw).intent;
    return { lang: named[0], only: (words.length <= 5 && ['unclear', 'info_q', 'silence', 'human'].includes(k)) || (LANG_ASK.test(raw) && !['stop', 'later', 'reschedule'].includes(k)) };
  }
  const te = (raw.match(/[ఀ-౿]/g) || []).length;
  const hi = (raw.match(/[ऀ-ॿ]/g) || []).length;
  if (te >= 3 && te >= hi) return { lang: 'Telugu', only: false };
  if (hi >= 3) return { lang: 'Hindi', only: false };
  const latin = words.filter((w) => /^[a-z']+$/.test(w));
  const rt = latin.filter((w) => ROMAN.Telugu.includes(w)).length;
  const rh = latin.filter((w) => ROMAN.Hindi.includes(w)).length;
  if (rt > rh) return { lang: 'Telugu', only: false };
  if (rh > rt) return { lang: 'Hindi', only: false };
  if (latin.length >= 3 && rt === 0 && rh === 0) return { lang: 'English', only: false };
  return null;
}

// "Hello?" / "చెప్పండి" / "बोलिए" on picking up the phone: not an answer and not a failed try - the question is asked again
const GREETING = ['hello', 'helo', 'hallo', 'hi', 'hey', 'cheppandi', 'boliye', 'bolo', 'హలో', 'హాయ్', 'చెప్పండి', 'हैलो', 'हेलो', 'हलो', 'बोलिए', 'बोलो'];
const HELLO_BACK = { English: 'Hello.', Telugu: 'హలో.', Hindi: 'जी, नमस्ते।' };
const GREET_EXTRA =['ji', 'जी', 'అండి', 'sir', 'madam', 'haan', 'हाँ', 'హా'];
function isGreeting(t) {
  const w = t.split(' ').filter(Boolean);
  return w.length > 0 && w.length <= 3 && w.some((x) => GREETING.includes(x)) && w.every((x) => GREETING.includes(x) || GREET_EXTRA.includes(x));
}

// Fixed answer from a fixed list. Returns { intent, human }.
function classify(text) {
  const t = norm(text);
  if (!t) return { intent: 'silence', human: false };
  const human = has(t, L.human);
  if (has(t, L.stop)) return { intent: 'stop', human };
  if (has(t, L.other)) return { intent: 'other_cand', human };
  if (has(t, L.ai_q) && !has(t, L.yes.filter((x) => x !== 'ai'))) return { intent: 'ai_q', human };
  if (has(t, L.resched)) return { intent: 'reschedule', human };
  if (has(t, L.salary)) return { intent: 'salary_q', human };
  const fine = NO_BUT_FINE.some((p) => t.includes(p));
  const neg = !fine && has(t, L.no);
  if (has(t, L.later) && !neg) return { intent: 'later', human };
  if (neg) return { intent: 'no', human };
  if (has(t, L.yes) || fine) return { intent: 'yes', human };
  if (has(t, L.info) || t.endsWith('?')) return { intent: 'info_q', human };
  return { intent: human ? 'human' : 'unclear', human };
}

const NUM_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
  ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  okati: 1, rendu: 2, moodu: 3, nalugu: 4, aidu: 5, aaru: 6, edu: 7, enimidi: 8, tommidi: 9, padi: 10,
  एक: 1, दो: 2, तीन: 3, चार: 4, पाँच: 5, पांच: 5, छह: 6, सात: 7, आठ: 8, नौ: 9, दस: 10,
  ఒకటి: 1, రెండు: 2, మూడు: 3, నాలుగు: 4, ఐదు: 5, ఆరు: 6, ఏడు: 7, ఎనిమిది: 8, తొమ్మిది: 9, పది: 10,
  // phone calls: speech-to-text writes numbers as words (notice periods are mostly 15 / 30 / 45 / 60 / 90 days)
  forty: 40, 'forty-five': 45, fortyfive: 45, pandra: 15, pandrah: 15, bees: 20, tees: 30, saath: 60, nabbe: 90, padihenu: 15, iravai: 20, muppai: 30, aravai: 60, tombhai: 90,
  पंद्रह: 15, बीस: 20, तीस: 30, पैंतालीस: 45, साठ: 60, नब्बे: 90,
  పదిహేను: 15, ఇరవై: 20, ముప్పై: 30, నలభై: 40, నలభైఐదు: 45, అరవై: 60, తొంభై: 90,
};
function firstNumber(t) {
  const m = /(\d{1,3}(?:\.\d)?)/.exec(t);
  if (m) return Number(m[1]);
  for (const w of t.split(' ')) if (Object.prototype.hasOwnProperty.call(NUM_WORDS, w)) return NUM_WORDS[w];
  return null;
}
function readYears(text) {
  const t = norm(text);
  if (has(t, ['fresher', 'no experience', 'zero'])) return 0;
  const n = firstNumber(t);
  return n != null && n >= 0 && n <= 50 ? n : null;
}
function readNotice(text) {
  const t = norm(text);
  if (has(t, L.immediate)) return { days: 0, text: 'immediate' };
  const n = firstNumber(t);
  if (n == null) return { days: null, text: null };
  if (has(t, ['month', 'months', 'महीना', 'महीने', 'నెల', 'నెలలు', 'nelalu', 'mahine'])) return { days: Math.round(n * 30), text: `${n} month${n === 1 ? '' : 's'}` };
  if (has(t, ['week', 'weeks', 'हफ्ता', 'हफ्ते', 'వారం', 'వారాలు'])) return { days: Math.round(n * 7), text: `${n} week${n === 1 ? '' : 's'}` };
  if (has(t, ['day', 'days', 'दिन', 'రోజులు', 'రోజు', 'din', 'rojulu'])) return { days: Math.round(n), text: `${n} days` };
  if (n >= 7 && n <= 365) return { days: Math.round(n), text: `${n} days` };
  return { days: null, text: `${n}` };
}
// a place: letters and spaces only, short
// the words around a city name in an answer ("मैं हैदराबाद में रहता हूँ", "నేను హైదరాబాద్‌లో ఉంటాను"): dropped, the city kept
const PLACE_FILLER = new Set(['i', 'am', 'live', 'living', 'stay', 'staying', 'currently', 'now', 'right', 'my', 'city', 'is', 'mai', 'main', 'mein', 'rehta', 'rehti', 'hoon', 'hu', 'hai',
  'मैं', 'में', 'मे', 'रहता', 'रहती', 'रहते', 'हूँ', 'हूं', 'हैं', 'है', 'अभी', 'मेरा', 'शहर', 'से', 'నేను', 'లో', 'ఉంటాను', 'ఉన్నాను', 'ఉంటున్నాను', 'ప్రస్తుతం', 'ఇప్పుడు', 'మా', 'ఊరు', 'nenu', 'lo', 'untanu', 'unnanu']);
function readPlace(text) {
  const raw = String(text || '').normalize('NFKC').replace(/[^\p{L}\p{M}\s.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const m = /\b(?:in|at|from|near|live in|staying in|based in)\s+(.{2,40})$/i.exec(raw);
  const words = (m ? m[1] : raw).split(' ').map((w) => w.replace(/‌?లో$/, '')).filter((w) => w && !PLACE_FILLER.has(w.toLowerCase()));
  const pick = words.slice(0, 4).join(' ').trim();
  return pick.length >= 2 && pick.length <= 40 ? pick : null;
}
function readTime(text) {
  const raw = String(text || '').normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}\s:.,/-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const t = raw.replace(/[s.,:/-]+$/, ''); // "Tomorrow." -> "Tomorrow" (it is read back inside a sentence)
  return t ? t.slice(0, 120) : null;
}

// --- the result, validated -----------------------------------------------------------------------------------------------
const str = (v, max) => (v == null ? undefined : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) || undefined);
// Returns { ok, errors, value }. Unknown keys are dropped; every value is type- and length-checked.
function validateOutcome(raw, purpose) {
  const errors = [];
  const o = raw && typeof raw === 'object' ? raw : {};
  const allowed = OUTCOMES[purpose];
  if (!allowed) return { ok: false, errors: ['unknown purpose'], value: null };
  if (!allowed.includes(o.outcome)) errors.push(`outcome must be one of: ${allowed.join(', ')}`);
  const bool = (v) => v === true;
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
  const a = o.answers && typeof o.answers === 'object' ? o.answers : {};
  const value = {
    purpose,
    language: S.LANGS.includes(o.language) ? o.language : 'English',
    outcome: allowed.includes(o.outcome) ? o.outcome : undefined,
    identityConfirmed: bool(o.identityConfirmed),
    wrongPerson: bool(o.wrongPerson),
    interest: ['yes', 'no', 'unsure'].includes(o.interest) ? o.interest : null,
    answers: {
      experienceYears: num(a.experienceYears, 0, 50),
      currentLocation: str(a.currentLocation, 40),
      noticePeriodDays: num(a.noticePeriodDays, 0, 365),
      noticePeriodText: str(a.noticePeriodText, 30),
      willingToProceed: typeof a.willingToProceed === 'boolean' ? a.willingToProceed : undefined,
    },
    callbackRequested: bool(o.callbackRequested),
    callbackWhen: str(o.callbackWhen, 120),
    humanFollowUpRequested: bool(o.humanFollowUpRequested),
    doNotCallRequested: bool(o.doNotCallRequested),
    shortlistTold: bool(o.shortlistTold),
    attendance: ['confirmed', 'reschedule', 'not_available', null].includes(o.attendance) ? o.attendance : null,
    preferredTime: str(o.preferredTime, 120),
    summary: str(o.summary, 600) || '',
    turns: num(o.turns, 0, 200) || 0,
  };
  Object.keys(value.answers).forEach((k) => { if (value.answers[k] === undefined) delete value.answers[k]; });
  // rules that tie fields together
  if (value.wrongPerson && value.identityConfirmed) errors.push('wrongPerson and identityConfirmed cannot both be true');
  if (!value.identityConfirmed && (value.shortlistTold || value.attendance === 'confirmed')) errors.push('shortlist / interview details cannot be told before identity is confirmed');
  if (S.hasForbidden(value.summary)) errors.push('the summary uses a word the assistant must not say');
  return { ok: errors.length === 0, errors, value };
}

// --- the engine -------------------------------------------------------------------------------------------------------------
class Dialogue {
  // opts: { purpose, language, data (scripts.buildData), fields (recruiter edits), recordingNotice, classifier (async text -> intent word), maxTurns }
  constructor(opts) {
    this.purpose = opts.purpose;
    if (!OUTCOMES[this.purpose]) throw new Error(`Unknown purpose: ${this.purpose}`);
    this.data = opts.data || {};
    this.fields = opts.fields || {};
    this.recordingNotice = !!opts.recordingNotice;
    this.autoLanguage = opts.autoLanguage !== false; // answer in the language the person speaks (opts.autoLanguage: false keeps the call's language)
    this.classifier = typeof opts.classifier === 'function' ? opts.classifier : null;
    this.maxTurns = opts.maxTurns || 16;
    this.prefix = '';
    this.st = {
      step: 'identity', turns: 0, tries: 0, done: false, ended: null, identity: false, wrong: false, interest: null, told: false,
      answers: {}, callback: false, callbackWhen: null, human: false, stop: false, attendance: null, preferredTime: null, transcript: [], outcome: null, lastAsk: '',
      language: null, upset: 0, calmFrom: null,
    };
    this.setLanguage(S.LANGS.includes(opts.language) ? opts.language : 'English');
  }

  // Every fixed sentence from here on is in this language (the call's start language, or the one the person switched to).
  setLanguage(lang) {
    if (!S.LANGS.includes(lang)) return;
    this.language = lang;
    this.P = S.phrases(lang);
    this.B = S.blocks(this.purpose, lang, this.data, this.fields, { recordingNotice: this.recordingNotice });
    this.st.language = lang;
  }

  snapshot() { return JSON.parse(JSON.stringify(this.st)); }
  restore(st) {
    if (st && typeof st === 'object') this.st = { ...this.st, ...st };
    if (this.st.language && this.st.language !== this.language) this.setLanguage(this.st.language);
    return this;
  }

  // The static text of a sentence must be free of forbidden words (the slots are database values). A failure here is a
  // programming error, never a candidate's doing: the safe sentence is spoken instead.
  guard(text) {
    const skeleton = String(text);
    if (S.hasForbidden(skeleton.replace(this.data.jobTitle || '\u0000', '').replace(this.data.name || '\u0000', ''))) return this.P.noInfo;
    return skeleton;
  }
  speak(...parts) {
    if (this.prefix) { parts.unshift(this.prefix); this.prefix = ''; } // e.g. "Sure, let us continue in Telugu." once, before the next sentence
    const text = this.guard(parts.filter(Boolean).join(' '));
    this.st.transcript.push({ who: 'assistant', text: text.slice(0, 600) });
    this.st.lastAsk = text;
    return text;
  }
  finish(say, why) {
    this.st.done = true; this.st.ended = why;
    return { say, done: true };
  }

  start() {
    const text = this.speak(this.B.ai, this.B.identity);
    this.st.step = 'identity';
    return { say: text, done: false };
  }

  // Ask the current question again, shortly.
  again(prefix) {
    const q = {
      // after an answer (prefix), simply ask again; "sorry, I did not catch that" only when nothing was understood
      identity: prefix ? this.B.identity : this.P.identityAgain.replace('{name}', S.clean(this.data.name || this.data.firstName)),
      convenient: this.P.convenient,
      intro: this.P.screenIntro.replace('{job}', S.clean(this.data.jobTitle)),
      interest: this.P.interestQ,
      human_offer: this.P.interestMore,
      qExp: this.P.qExp,
      qLoc: this.P.qLoc,
      qNotice: this.P.qNotice,
      qProceed: this.P.qProceed,
      proceed: this.P.shortProceed,
      avail: this.P.ivAvail,
      resched_time: this.P.ivReschedAsk,
      later_when: this.P.laterAsk,
      calm: this.P.calmOffer,
    }[this.st.step];
    return this.speak(prefix, q);
  }

  async intentOf(text) {
    const k = classify(text);
    if (k.intent === 'unclear' && this.classifier) {
      try {
        const w = await this.classifier(String(text).slice(0, 300));
        if (INTENTS.includes(w) && w !== 'stop') return { intent: w, human: k.human }; // a model can NEVER end the call on a stop word it invented
      } catch { /* the word lists already answered */ }
    }
    return k;
  }

  // What the candidate said. Always returns { say, done }.
  async hear(textIn) {
    if (this.st.done) return { say: '', done: true };
    const text = String(textIn == null ? '' : textIn).slice(0, 600);
    this.st.turns += 1;
    this.st.transcript.push({ who: 'candidate', text: S.clean(text, 300) });
    if (this.st.turns > this.maxTurns) return this.close('Unclear', 'too many turns');
    const st = this.st;
    // 1. the person's language: from this sentence on, every answer is in it
    const lg = this.autoLanguage ? detectLanguage(text) : null;
    if (lg && lg.lang !== this.language) { this.setLanguage(lg.lang); this.prefix = this.P.langSwitched; }
    if (lg && lg.only) { this.prefix = ''; return { say: this.again(this.P.langSwitched), done: false }; }
    const k = await this.intentOf(text);
    if (k.human) st.human = true;

    if (k.intent === 'silence') {
      st.tries += 1;
      if (st.tries >= 2) return this.close('Unclear', 'no answer heard');
      return { say: this.again(this.P.repeat), done: false };
    }
    if (k.intent === 'stop') { st.stop = true; return this.finish(this.speak(this.P.closeStop), 'stop'); }
    const t = norm(text);
    if (isGreeting(t) && (st.greets || 0) < 3) { st.greets = (st.greets || 0) + 1; return { say: st.step === 'identity' ? this.speak(this.B.identity) : this.again(HELLO_BACK[this.language] || HELLO_BACK.English), done: false }; } // the name question already says hello
    // 2. money / fraud worry: the fixed reassurance, then the same question again (allowed before the name is confirmed: it shares nothing)
    if (has(t, L.scam) && !has(t, L.salary)) return { say: this.again(this.P.noMoney), done: false };
    // 3. upset: apologise, keep it short, offer a recruiter; a second time ends the call politely. Never argue.
    if (has(t, L.angry)) {
      st.upset += 1;
      const notInterested = k.intent === 'no';
      if (st.upset >= 2 || notInterested) {
        if (notInterested && st.identity) st.interest = 'no';
        const out = notInterested && st.identity
          ? (this.purpose.startsWith('Interview') ? 'Not Available' : 'Not Interested')
          : (this.purpose.startsWith('Interview') ? 'No Response' : 'Unclear');
        return this.close(out, 'candidate upset', this.P.calmClose);
      }
      if (st.step !== 'calm') st.calmFrom = st.step;
      st.step = 'calm';
      return { say: this.speak(this.P.calmSorry, this.P.calmOffer), done: false };
    }
    if (k.intent === 'ai_q') return { say: this.again(this.P.amAi), done: false };
    if (k.intent === 'other_cand') return { say: this.again(this.P.onlyYou), done: false };

    if (st.step === 'calm') return this.on_calm(k);
    if (st.step === 'identity') return this.onIdentity(k);
    // nothing about the job before the person is confirmed (the step cannot be anything else after identity)
    if (k.intent === 'salary_q') {
      const sal = this.data.salary && this.B.brief.includes(this.data.salary);
      return { say: this.again(sal ? this.P.briefSalary.replace('{salary}', S.clean(this.data.salary)) : this.P.noSalary), done: false };
    }
    if (k.intent === 'info_q' && st.step !== 'resched_time' && st.step !== 'later_when' && !/^q/.test(st.step)) {
      const where = has(norm(text), ['where', 'location', 'address', 'kahan', 'कहाँ', 'कहां', 'ఎక్కడ']);
      if (where && this.data.location && this.purpose === 'Screening') return { say: this.again(this.P.briefLoc.replace('{location}', S.clean(this.data.location))), done: false };
      if (where && this.data.interview && this.data.interview.location) return { say: this.again(this.P.ivInPerson.replace('{location}', S.clean(this.data.interview.location))), done: false };
      return { say: this.again(this.P.noInfo), done: false };
    }
    return this[`on_${st.step}`](k, text);
  }

  // After an apology: go on (back to the question that was interrupted), a recruiter call, or a polite goodbye.
  on_calm(k) {
    const st = this.st;
    const back = st.calmFrom || 'identity';
    if (k.intent === 'yes') {
      st.tries = 0;
      if (back === 'convenient') { st.step = 'intro'; return { say: this.speak(this.B.intro), done: false }; } // "go on" already answers "is this a good time"
      st.step = back;
      return { say: this.again(), done: false };
    }
    if (k.intent === 'human') { st.human = true; return this.close(this.purpose.startsWith('Interview') ? 'No Response' : 'Unclear', 'recruiter call requested', this.P.humanNoted); }
    if (k.intent === 'later' || k.intent === 'reschedule') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    if (k.intent === 'no') return this.close(this.purpose.startsWith('Interview') ? 'No Response' : 'Unclear', 'candidate upset', this.P.calmClose);
    st.tries += 1;
    if (st.tries >= 2) return this.close(this.purpose.startsWith('Interview') ? 'No Response' : 'Unclear', 'candidate upset', this.P.calmClose);
    return { say: this.speak(this.P.calmOffer), done: false };
  }

  onIdentity(k) {
    const st = this.st;
    if (k.intent === 'yes') {
      st.identity = true; st.tries = 0;
      if (this.purpose === 'Screening') { st.step = 'convenient'; return { say: this.speak(this.B.convenient), done: false }; }
      if (this.purpose === 'Shortlist Notification') {
        st.step = 'proceed'; st.told = true;
        return { say: this.speak(this.B.news, this.B.shortIv, this.B.note, this.P.shortProceed), done: false };
      }
      if (!this.data.interview) return this.close('No Response', 'no interview record');
      st.step = 'avail';
      return { say: this.speak(this.B.ivLine, this.B.ivMode, this.B.ivInstr, this.B.note, this.P.ivAvail), done: false };
    }
    if (k.intent === 'no') { st.wrong = true; return this.finish(this.speak(this.P.wrong), 'wrong person'); }
    if (k.intent === 'later') {
      st.callback = true; st.step = 'later_when';
      return { say: this.speak(this.P.laterAsk), done: false };
    }
    if (k.intent === 'info_q' || k.intent === 'salary_q') return { say: this.speak(this.P.identityNeeded.replace('{name}', S.clean(this.data.name)), this.B.identity), done: false };
    st.tries += 1;
    if (st.tries >= 2) return this.close('Unclear', 'identity not confirmed');
    return { say: this.again(), done: false };
  }

  on_convenient(k) {
    const st = this.st;
    if (k.intent === 'yes') { st.step = 'intro'; return { say: this.speak(this.B.intro), done: false }; }
    if (k.intent === 'no' || k.intent === 'later' || k.intent === 'reschedule') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    return this.retry(k);
  }

  on_intro(k) {
    const st = this.st;
    if (k.intent === 'yes') { st.step = 'interest'; return { say: this.speak(this.B.brief, this.P.interestQ), done: false }; }
    if (k.intent === 'no') { st.interest = 'no'; return this.close('Not Interested', 'not interested'); }
    if (k.intent === 'later') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    return this.retry(k);
  }

  on_interest(k) {
    const st = this.st;
    if (k.intent === 'yes') { st.interest = 'yes'; st.tries = 0; st.step = 'qExp'; return { say: this.speak(this.P.qExp), done: false }; }
    if (k.intent === 'no') { st.interest = 'no'; return this.close('Not Interested', 'not interested'); }
    if (k.intent === 'later') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    if (k.intent === 'human') { st.human = true; st.interest = 'unsure'; return this.close('Unclear', 'asked for a recruiter', this.P.humanNoted); }
    st.tries += 1;
    if (st.tries >= 2) { st.interest = 'unsure'; st.step = 'human_offer'; st.tries = 0; return { say: this.speak(this.P.interestMore), done: false }; }
    return { say: this.again(this.P.repeat), done: false };
  }

  on_human_offer(k) {
    const st = this.st;
    if (k.intent === 'yes' || k.intent === 'human') { st.human = true; return this.close('Unclear', 'recruiter call requested', this.P.humanNoted); }
    return this.close('Unclear', 'unclear interest');
  }

  // "Later" / "busy" in the middle of the questions: a call-back request (never an answer such as a city called "later")
  laterInQuestions(k) {
    if (k.intent !== 'later') return null;
    this.st.callback = true; this.st.step = 'later_when'; this.st.tries = 0;
    return { say: this.speak(this.P.laterAsk), done: false };
  }

  on_qExp(k, text) {
    const st = this.st;
    let y = readYears(text);
    if (y == null) { const l = this.laterInQuestions(k); if (l) return l; }
    if (y == null && k.intent === 'no') y = 0;
    if (y == null) {
      st.tries += 1;
      if (st.tries < 2) return { say: this.again(this.P.repeat), done: false };
    } else st.answers.experienceYears = y;
    st.tries = 0; st.step = 'qLoc';
    return { say: this.speak(this.P.qLoc), done: false };
  }

  on_qLoc(k, text) {
    const st = this.st;
    const l = this.laterInQuestions(k); if (l) return l;
    const place = k.intent === 'no' || k.intent === 'yes' ? null : readPlace(text);
    if (!place) {
      st.tries += 1;
      if (st.tries < 2) return { say: this.again(this.P.repeat), done: false };
    } else st.answers.currentLocation = place;
    st.tries = 0; st.step = 'qNotice';
    return { say: this.speak(this.P.qNotice), done: false };
  }

  on_qNotice(k, text) {
    const st = this.st;
    const n = readNotice(text);
    if (n.text == null) { const l = this.laterInQuestions(k); if (l) return l; }
    if (n.text == null) {
      st.tries += 1;
      if (st.tries < 2) return { say: this.again(this.P.repeat), done: false };
    } else {
      if (n.days != null) st.answers.noticePeriodDays = n.days;
      st.answers.noticePeriodText = n.text;
    }
    st.tries = 0; st.step = 'qProceed';
    return { say: this.speak(this.P.qProceed), done: false };
  }

  on_qProceed(k) {
    const st = this.st;
    if (k.intent === 'yes') { st.answers.willingToProceed = true; return this.close('Interested', 'interested'); }
    if (k.intent === 'no') { st.answers.willingToProceed = false; return this.close('Not Interested', 'will not proceed'); }
    if (k.intent === 'later') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    return this.retry(k);
  }

  on_proceed(k) {
    const st = this.st;
    if (k.intent === 'yes') { st.interest = 'yes'; return this.close('Interested', 'wants to proceed'); }
    if (k.intent === 'no') { st.interest = 'no'; return this.close('Not Interested', 'does not want to proceed'); }
    if (k.intent === 'later') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    return this.retry(k);
  }

  on_later_when(k, text) {
    const st = this.st;
    if (!['yes', 'no'].includes(k.intent) || /\d/.test(text) || text.trim().split(/\s+/).length > 1) st.callbackWhen = readTime(text);
    st.callback = true;
    const out = this.purpose.startsWith('Interview') ? 'No Response' : 'Call Back Later';
    return this.close(out, 'call back later', st.callbackWhen ? this.P.laterNoted.replace('{when}', st.callbackWhen) : this.P.laterClose);
  }

  on_avail(k, text) {
    const st = this.st;
    if (k.intent === 'yes') { st.attendance = 'confirmed'; return this.close('Confirmed', 'confirmed'); }
    if (k.intent === 'reschedule') {
      const t = readTime(text);
      const own = t && !has(norm(text), L.resched) ? t : null;
      st.attendance = 'reschedule';
      if (own || /\d/.test(text)) { st.preferredTime = readTime(text); return this.close('Reschedule Requested', 'reschedule requested', this.P.ivReschedNoted); }
      st.step = 'resched_time';
      return { say: this.speak(this.P.ivReschedAsk), done: false };
    }
    if (k.intent === 'no') { st.attendance = 'not_available'; st.step = 'resched_time'; return { say: this.speak(this.P.ivReschedAsk), done: false }; }
    if (k.intent === 'later') { st.callback = true; st.callbackWhen = readTime(text); return this.close('No Response', 'asked to call later', this.P.ivNoReply); }
    return this.retry(k);
  }

  on_resched_time(k, text) {
    const st = this.st;
    if (k.intent === 'no') return this.close('Not Available', 'not available', this.P.ivNotAvail);
    st.attendance = 'reschedule';
    if (k.intent !== 'yes' || /\d/.test(text)) st.preferredTime = readTime(text);
    return this.close('Reschedule Requested', 'reschedule requested', this.P.ivReschedNoted);
  }

  retry(k) {
    const st = this.st;
    st.tries += 1;
    if (st.tries >= 2) {
      return this.close(this.purpose.startsWith('Interview') ? 'No Response' : 'Unclear', 'unclear answer');
    }
    return { say: this.again(this.P.repeat), done: false };
  }

  // End the call with an outcome and the closing sentence for it.
  close(outcome, why, sentence) {
    const st = this.st;
    st.outcome = outcome;
    let line = sentence;
    if (!line) {
      if (this.purpose === 'Screening') line = outcome === 'Interested' ? this.P.closeInterested : outcome === 'Not Interested' ? this.P.closeNotInterested : this.P.closeUnclear;
      else if (this.purpose === 'Shortlist Notification') line = outcome === 'Interested' ? this.P.shortYes : outcome === 'Not Interested' ? this.P.closeNotInterested : this.P.closeUnclear;
      else line = outcome === 'Confirmed' ? this.P.ivConfirmed : outcome === 'Not Available' ? this.P.ivNotAvail : this.P.ivNoReply;
    }
    return this.finish(this.speak(line), why);
  }

  // The person hung up, the line dropped, or the provider ended the call.
  hangup(reason = 'call ended') {
    if (!this.st.done) {
      this.st.done = true; this.st.ended = reason;
      if (!this.st.outcome) this.st.outcome = this.purpose.startsWith('Interview') ? 'No Response' : (this.st.callback ? 'Call Back Later' : 'Unclear');
    }
    return this.outcome();
  }

  summaryText() {
    const st = this.st;
    const bits = [`AI call (${this.purpose}, ${this.language}).`];
    if (st.wrong) bits.push('Wrong person on the line. No details were shared.');
    else if (!st.identity) bits.push('The person did not confirm their name. No details were shared.');
    else bits.push('Name confirmed.');
    if (st.identity && this.purpose === 'Shortlist Notification') bits.push(st.told ? 'Told that they are shortlisted.' : '');
    if (st.interest === 'yes') bits.push('Interested.'); else if (st.interest === 'no') bits.push('Not interested.');
    const a = st.answers;
    if (a.experienceYears != null) bits.push(`Experience: ${a.experienceYears} years.`);
    if (a.currentLocation) bits.push(`Lives in: ${a.currentLocation}.`);
    if (a.noticePeriodText) bits.push(`Notice period: ${a.noticePeriodText}.`);
    if (a.willingToProceed != null) bits.push(a.willingToProceed ? 'Willing to go ahead.' : 'Not willing to go ahead.');
    if (st.attendance === 'confirmed') bits.push('Confirmed they will attend.');
    if (st.attendance === 'reschedule') bits.push(`Asked to change the interview time${st.preferredTime ? `: ${st.preferredTime}` : ''}. The interview was NOT changed.`);
    if (st.attendance === 'not_available') bits.push('Cannot attend.');
    if (st.callback) bits.push(`Asked for a call back${st.callbackWhen ? `: ${st.callbackWhen}` : ''}.`);
    if (st.human) bits.push('Asked to speak to a recruiter.');
    if (st.upset) bits.push(`The person sounded upset${st.ended === 'candidate upset' ? ', so the assistant apologised and ended politely' : '; the assistant apologised and kept it short'}.`);
    if (st.stop) bits.push('Asked not to be called again.');
    return bits.filter(Boolean).join(' ');
  }

  // The validated result. Throws nothing: an invalid result becomes a safe "Unclear / No Response".
  outcome() {
    const st = this.st;
    const fallback = this.purpose.startsWith('Interview') ? 'No Response' : 'Unclear';
    const raw = {
      purpose: this.purpose,
      language: this.language,
      outcome: st.outcome || fallback,
      identityConfirmed: st.identity,
      wrongPerson: st.wrong,
      interest: st.interest,
      answers: st.answers,
      callbackRequested: st.callback,
      callbackWhen: st.callbackWhen || undefined,
      humanFollowUpRequested: st.human,
      doNotCallRequested: st.stop,
      shortlistTold: st.told && st.identity,
      attendance: st.attendance,
      preferredTime: st.preferredTime || undefined,
      summary: this.summaryText(),
      turns: st.turns,
    };
    const v = validateOutcome(raw, this.purpose);
    if (v.ok) return v.value;
    const safe = validateOutcome({ ...raw, outcome: fallback, identityConfirmed: false, shortlistTold: false, attendance: null, summary: 'The result could not be read safely, so nothing was recorded from this call.' }, this.purpose);
    return { ...safe.value, invalid: v.errors };
  }

  transcript() { return this.st.transcript.slice(); }
}

module.exports = { Dialogue, classify, detectLanguage, validateOutcome, OUTCOMES, INTENTS, readYears, readNotice, readPlace, norm };
