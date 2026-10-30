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
const A = require('./answers');

const OUTCOMES = {
  Screening: ['Interested', 'Not Interested', 'Call Back Later', 'Unclear'],
  'Shortlist Notification': ['Interested', 'Not Interested', 'Call Back Later', 'Unclear'],
  'Interview Notification': ['Confirmed', 'Reschedule Requested', 'Not Available', 'No Response'],
  'Interview Reminder': ['Confirmed', 'Reschedule Requested', 'Not Available', 'No Response'],
  // Interested = "I will take the AI interview"
  'AI Interview Pending': ['Interested', 'Not Interested', 'Call Back Later', 'Unclear'],
  'Job Match': ['Interested', 'Not Interested', 'Call Back Later', 'Unclear'],
};
const INTENTS = ['stop', 'human', 'later', 'reschedule', 'ai_q', 'salary_q', 'info_q', 'other_cand', 'no', 'yes', 'mixed', 'maybe', 'repeat', 'cant_hear', 'silence', 'unclear'];

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
  later: ['later', 'call back', 'call me back', 'not now', 'not right now', 'busy', 'driving', 'in a meeting', 'meeting', 'tomorrow', 'another time', 'some other time', 'after some time', 'evening', 'next week', 'baad mein', 'baad me', 'abhi nahi', 'kal', 'बाद में', 'अभी नहीं', 'व्यस्त', 'कल', 'शाम', 'తర్వాత', 'తరువాత', 'ఇప్పుడు కాదు', 'బిజీ', 'రేపు', 'సాయంత్రం', 'taruvata', 'taruvaata', 'ippudu kaadu', 'repu'],
  resched: ['reschedule', 'change the time', 'change time', 'another time', 'different time', 'other time', 'postpone', 'can we move', 'move it', 'समय बदल', 'दूसरा समय', 'दूसरे समय', 'సమయం మార్చ', 'టైమ్ మార్చ', 'వేరే సమయం', 'మరో సమయం', 'వాయిదా', 'vere samayam'],
  no: ['no', 'nope', 'nah', 'not', 'cannot', 'cant', 'can t', 'wont', 'dont', 'wrong', 'nahi', 'nahin', 'nhi', 'नहीं', 'नही', 'కాదు', 'లేదు', 'లేద', 'వద్దు', 'kaadu', 'ledu', 'vaddu', 'not interested', 'not me', 'నో', 'నొ', 'नो', 'नॉट'],
  yes: ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'correct', 'right', 'speaking', 'sounds good', 'go ahead', 'interested', 'available', 'i can', 'of course', 'definitely', 'absolutely', 'haan', 'han', 'haa', 'ji', 'theek', 'bilkul', 'avunu', 'sare', 'sari', 'हाँ', 'हां', 'जी', 'ठीक', 'बिल्कुल', 'सही', 'అవున', 'సరే', 'సరి', 'అలాగే', 'ఓకే', 'హా', 'హాఁ', 'ఆ', 'ఆఁ', 'ఉన్నాను', 'ఆసక్తి ఉంది', 'ఇష్టం', 'ఎస్', 'యెస్', 'యస్', 'యా', 'ఓకే', 'ఓకె', 'కరెక్ట్', 'స్పీకింగ్', 'యస', 'यस', 'येस', 'यस्', 'एस', 'ओके', 'ओक', 'करेक्ट', 'स्पीकिंग', 'या'],
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
// "GO AHEAD / TELL ME / SPEAK" (real calls 2026-10-30: "చెప్పు", "మాట్లాడు" were asked again and again until the call ended):
// to "can I tell you about it?" / "do you have two minutes?" these mean yes. Daily speech in all three languages.
const GO_AHEAD = ['go ahead', 'go on', 'tell me', 'please tell', 'tell', 'carry on', 'continue', 'proceed', 'listening', 'i am listening', 'im listening', 'say it', 'shoot',
  'చెప్పు', 'చెప్పండి', 'చెప్పండీ', 'చెప్పవే', 'చెప్పరా', 'చెప్పమ్మా', 'చెప్పయ్యా', 'మాట్లాడు', 'మాట్లాడండి', 'మాట్లాడొచ్చు', 'మాట్లాడవచ్చు', 'వింటున్నా', 'వింటున్నాను',
  'చెపో', 'చెప్పో', 'చెప్పవా', 'cheppo', 'కానివ్వండి', 'కానివ్వు', 'కానీయండి', 'ఫ్రీగా ఉన్నా', 'ఫ్రీ ఉన్నా', 'టైమ్ ఉంది', 'cheppu', 'cheppandi', 'chepandi', 'chepu', 'matladu', 'matladandi', 'vintunna',
  'बोलो', 'बोलिए', 'बोलिये', 'बोलें', 'बताओ', 'बताइए', 'बताइये', 'बताएं', 'बताइ', 'कहिए', 'कहो', 'सुनाइए', 'सुन रहा', 'सुन रही', 'चलो', 'चलिए', 'टाइम है', 'फ्री हूँ',
  'bolo', 'boliye', 'batao', 'bataiye', 'bataye', 'kahiye', 'chalo'];
// 2026-10-29 fixes: an answer that is not a plain yes / no is never forced into one
const L2 = {
  // "maybe / it depends / I'll check / I don't know": not interested, not uninterested - not confirmed
  maybe: ['maybe', 'may be', 'not sure', 'depends', 'i will check', 'i ll check', 'ill check', 'let me check', 'will check', 'will see', 'let me see', 'let me think',
    'i will think', 'i ll think', 'think about it', 'don t know', 'dont know', 'do not know', 'no idea', 'shayad', 'pata nahi', 'dekhta hoon', 'dekhte hain', 'soch ke',
    'शायद', 'पता नहीं', 'देखता हूँ', 'देखते हैं', 'सोच कर', 'सोचकर', 'emo', 'chustanu', 'chusta', 'chuddam', 'alochistanu', 'teliyadu', 'telidu',
    'ఏమో', 'చూస్తాను', 'చూస్తా', 'చూద్దాం', 'ఆలోచిస్తాను', 'ఆలోచిస్తా', 'తెలియదు', 'తెలీదు'],
  // "sorry, can you repeat?": the same question again, not counted as an answer
  repeat: ['repeat', 'say again', 'say that again', 'come again', 'pardon', 'once more', 'one more time', 'what did you say', 'didn t get', 'didnt get', 'sorry what',
    'phir se', 'fir se', 'dobara', 'phir bolo', 'फिर से', 'दोबारा', 'क्या बोला', 'क्या कहा', 'malli cheppandi', 'malli chepandi', 'malli cheppu',
    'మళ్ళీ చెప్పండి', 'మళ్లీ చెప్పండి', 'మళ్ళీ చెప్పు', 'మళ్లీ చెప్పు', 'ఏమన్నారు', 'ఏం అన్నారు'],
  // the person cannot hear the assistant: stop, check the line, do not go on with the job
  cantHear: ['can t hear', 'cannot hear', 'cant hear', 'unable to hear', 'not able to hear', 'not audible', 'voice is not clear', 'voice not clear', 'voice is breaking',
    'voice breaking', 'breaking up', 'hello hello', 'sunai nahi', 'awaaz nahi', 'aawaz nahi', 'awaz nahi', 'सुनाई नहीं', 'आवाज़ नहीं', 'आवाज नहीं',
    'vinapadatledu', 'vinapadatle', 'vinipinchatledu', 'వినపడటం లేదు', 'వినపడట్లేదు', 'వినిపించడం లేదు', 'వినిపించట్లేదు', 'వినబడటం లేదు', 'వాయిస్ రావట్లేదు'],
};
const NOT_NOW = ['not now', 'not right now', 'abhi nahi', 'अभी नहीं', 'ippudu kaadu', 'ఇప్పుడు కాదు'];
// a one-word "What?" / "Sorry?" is a request to hear the question again
const REPEAT_ALONE = ['what', 'sorry', 'pardon', 'sorry what', 'what sorry', 'kya', 'enti', 'ఏంటి', 'क्या'];
// a "yes" word inside a negative is not a yes: "I can't tell you" holds "i can", "not interested" holds "interested"
const NEGATORS = ['not', 'cannot', 'cant', 'dont', 'wont', 'nahi', 'nahin', 'नहीं'];
function withoutNegated(t) {
  const w = t.split(' ');
  const out = [];
  for (let i = 0; i < w.length; i += 1) {
    if (['can', 'don', 'won'].includes(w[i]) && w[i + 1] === 't') { i += 2; continue; } // "can't X": "can" and X both go
    if (NEGATORS.includes(w[i])) { i += 1; continue; } // "not X": X goes
    out.push(w[i]);
  }
  return out.join(' ');
}
// a call-back time must hold a time or a day ("आपस्पटोल" heard from noise was saved as one, 2026-10-29)
const TIME_WORDS = ['today', 'tomorrow', 'morning', 'afternoon', 'evening', 'night', 'tonight', 'noon', 'lunch', 'weekend', 'week', 'hour', 'hours', 'minute', 'minutes', 'am', 'pm',
  'oclock', 'o clock', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'aaj', 'kal', 'parso', 'subah', 'dopahar', 'shaam', 'sham', 'raat', 'baje', 'ghante',
  'repu', 'ellundi', 'podduna', 'sayantram', 'saayantram', 'raatri', 'gantalaku', 'ganta',
  'आज', 'कल', 'परसों', 'सुबह', 'दोपहर', 'शाम', 'रात', 'बजे', 'घंटे', 'घंटा', 'मिनट', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार', 'रविवार', 'हफ्ते',
  'ఈరోజు', 'రేపు', 'ఎల్లుండి', 'ఉదయం', 'పొద్దున', 'మధ్యాహ్నం', 'సాయంత్రం', 'రాత్రి', 'గంటలకు', 'గంట', 'నిమిషాల', 'సోమవారం', 'మంగళవారం', 'బుధవారం',
  'గురువారం', 'శుక్రవారం', 'శనివారం', 'ఆదివారం', 'వారం',
  // a date by its month or its day ("First November", "5th", "November first" - 2026-10-29), in all three languages
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'next', 'day after tomorrow', 'date',
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'fifteenth', 'twentieth', 'thirtieth',
  'జనవరి', 'ఫిబ్రవరి', 'మార్చి', 'ఏప్రిల్', 'జూన్', 'జూలై', 'ఆగస్టు', 'ఆగస్ట్', 'సెప్టెంబర్', 'అక్టోబర్', 'నవంబర్', 'డిసెంబర్', 'ఫస్ట్', 'సెకండ్', 'తేదీ',
  'जनवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर', 'फर्स्ट', 'तारीख'];
// ("am" / "pm" alone is not a time: "I am busy")
const timeLike = (text) => { const t = norm(text); return /\d/.test(t) || has(t, TIME_WORDS.filter((w) => w !== 'am' && w !== 'pm')); };

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
const LANG_ASK = /\b(talk|speak|continue|switch|change|explain|tell)\b|\bbaat\b|\bbol|matlad|మాట్లాడ|बात|बोल/i;
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
  // one word nobody knows ('आपस्पटोल', heard from noise on 2026-10-29) never switches the call: two words or a known answer
  const sensible = words.length >= 2 || !['unclear', 'silence'].includes(classify(raw).intent);
  if (te >= 3 && te >= hi && sensible) return { lang: 'Telugu', only: false };
  if (hi >= 3 && sensible) return { lang: 'Hindi', only: false };
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
const PLAIN_HELLO = ['hello', 'helo', 'hallo', 'hi', 'hey', 'హలో', 'హాయ్', 'हैलो', 'हेलो', 'हलो'];
const GREET_EXTRA =['ji', 'जी', 'అండి', 'sir', 'madam', 'haan', 'हाँ', 'హా'];
function isGreeting(t) {
  const w = t.split(' ').filter(Boolean);
  return w.length > 0 && w.length <= 3 && w.some((x) => GREETING.includes(x)) && w.every((x) => GREETING.includes(x) || GREET_EXTRA.includes(x));
}

// a place the assistant may say back: one of the known Indian cities / localities (utils/locationMatch.js), or words in Telugu /
// Hindi letters (the Indian-language listener writes real words); English words it does not know are not repeated
let PLACES = null;
function knownPlace(p) {
  const t = String(p || '').trim();
  if (!t) return false;
  if (/[\u0900-\u097F\u0C00-\u0C7F]/.test(t)) return knownIndicPlace(t);
  if (!PLACES) {
    PLACES = new Set();
    Object.entries(require('../utils/locationMatch').CITY_ALIASES).forEach(([c, al]) => { PLACES.add(c.toLowerCase().replace(/[^a-z]/g, '')); al.forEach((a) => PLACES.add(a)); }); // eslint-disable-line global-require
  }
  return t.split(/[\s,]+/).some((w) => PLACES.has(w.toLowerCase().replace(/[^a-z]/g, '')));
}

const EXPLAIN = ['explain', 'once more', 'one more time', 'again tell', 'tell again', 'details', 'full details', 'job details', 'more details',
  'మళ్ళీ చెప్పండి', 'మళ్ళీ చెప్పు', 'ఇంకోసారి', 'ఇంకొకసారి', 'డీటెయిల్స్', 'వివరంగా', 'ఎక్స్‌ప్లెయిన్', 'అర్థం కాలేదు', 'జాబ్ గురించి',
  'फिर से बताइए', 'फिर से बताओ', 'एक बार और', 'डिटेल्स', 'समझाइए', 'समझाओ', 'जॉब के बारे में', 'phir se', 'malli cheppandi', 'inkosari'];

// a place in Telugu / Hindi letters is said back only when it is close to a known city written the same way ("వరంగల్" yes,
// "వరంగవ అ" - a mis-hearing - no)
let INDIC_PLACES = null;
function knownIndicPlace(t) {
  if (!INDIC_PLACES) {
    const V = require('./voice/speakScript'); // eslint-disable-line global-require
    INDIC_PLACES = new Set();
    Object.keys(require('../utils/locationMatch').CITY_ALIASES).forEach((c) => { // eslint-disable-line global-require
      ['Telugu', 'Hindi'].forEach((l) => INDIC_PLACES.add(skeleton(V.native(c, l))));
    });
    Object.values(V.WORDS).forEach(([te, hi]) => { INDIC_PLACES.add(skeleton(te)); INDIC_PLACES.add(skeleton(hi)); });
  }
  return String(t).split(/[\s,]+/).filter((w) => w.replace(/[\p{M}]/gu, '').length > 1).every((w) => {
    const k = skeleton(w.replace(/లో$|में$/, ''));
    return k.length >= 2 && [...INDIC_PLACES].some((p) => p.length >= 2 && editDistance(k, p) <= (p.length >= 5 ? 1 : 0));
  });
}

// MIS-HEARD SHORT REPLIES (research 2026-10-30): the listener writes "చెప్పండి" as "చపండి", or Telugu sound in Hindi letters
// ("चपंडी"). Hindi letters are moved to the Telugu block (the Indic blocks share one layout), vowel signs and the virama are
// dropped, and what is left is compared with the known go-ahead / yes words - one letter of difference allowed.
const toTeluguBlock = (s) => String(s || '').replace(/[\u0900-\u097F]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x300));
const skeleton = (w) => toTeluguBlock(w).replace(/[\u0C3E-\u0C4D\u0C55\u0C56\u0C01\u0C03\u0C3C]/g, '');
function editDistance(a, b) {
  const m = a.length; const n = b.length; const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) for (let j = 1; j <= n; j += 1) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}
let fuzzyKeys = null;
function fuzzyGoAhead(text) {
  if (!fuzzyKeys) fuzzyKeys = [...GO_AHEAD, ...L.yes].filter((e) => !ascii(e) && !e.includes(' ')).map(skeleton).filter((k) => k.length >= 3);
  const words = String(text || '').normalize('NFC').replace(/[.,!?।]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return words.some((w) => { const k = skeleton(w); return k.length >= 2 && fuzzyKeys.some((f) => (k.length >= 3 || f.length <= 3) && editDistance(k, f) <= (f.length >= 6 ? 2 : 1)); });
}

// Fixed answer from a fixed list. Returns { intent, human }.
function classify(text) {
  const t = norm(text);
  if (!t) return { intent: 'silence', human: false };
  const human = has(t, L.human);
  if (has(t, L.stop)) return { intent: 'stop', human };
  if (has(t, L.other)) return { intent: 'other_cand', human };
  if (has(t, L2.cantHear)) return { intent: 'cant_hear', human };
  if (has(t, L2.repeat) || REPEAT_ALONE.includes(t)) return { intent: 'repeat', human };
  if (has(t, L.ai_q) && !has(t, L.yes.filter((x) => x !== 'ai'))) return { intent: 'ai_q', human };
  if (has(t, L.resched)) return { intent: 'reschedule', human };
  if (has(t, L.salary)) return { intent: 'salary_q', human };
  if (has(t, L2.maybe)) return { intent: 'maybe', human };
  const fine = NO_BUT_FINE.some((p) => t.includes(p));
  const neg = !fine && has(t, L.no);
  // "not now" / "abhi nahi" / "ippudu kaadu" hold a no word but mean "call me later"
  if (has(t, L.later) && (!neg || has(t, NOT_NOW))) return { intent: 'later', human };
  const yes = fine || has(withoutNegated(t), L.yes);
  // "Yes, I can't ..." holds both: never read as a no (or a yes) - the person is asked which they meant
  if (neg && yes) return { intent: 'mixed', human };
  if (neg) return { intent: 'no', human };
  // "tell me" / "చెప్పు" / "बोलिए" = go on (unless they also ask something: "tell me the location" is a question)
  const goAhead = has(t, GO_AHEAD) && !has(t, L.info.filter((x) => x !== 'tell me')) && !has(t, ['more', 'ఇంకా', 'और', 'ज़्यादा', 'zyada', 'inka']); // "tell me more" asks for more
  if (yes) return { intent: 'yes', human, goAhead: goAhead && !has(t, L.yes) };
  if (goAhead) return { intent: 'yes', human, goAhead: true };
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
  पंद्रह: 15, पन्द्रह: 15, पंद्रा: 15, पदह: 15, बीस: 20, तीस: 30, पैंतालीस: 45, साठ: 60, नब्बे: 90, // + the listener's spellings
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
  if (!t) return null;
  // only the WHEN of a longer sentence is said back ("busy now, call me tomorrow 6 pm" -> "tomorrow 6 pm"): the time words,
  // numbers and "o'clock" words, in the order said; the whole sentence only when nothing like a time is in it
  const words = t.split(/[\s,]+/);
  const isTime = (w) => { const x = norm(w); return /\d/.test(x) || TIME_WORDS.some((tw) => !tw.includes(' ') && (x === tw || (!ascii(tw) && tw.length >= 3 && x.startsWith(tw)))) || Object.prototype.hasOwnProperty.call(NUM_WORDS, x) || /^(గంట|గంటల|बजे|baje|o'?clock|ganta)/.test(x); };
  const keep = words.filter((w, i) => isTime(w) && !(/^(am|pm)$/i.test(w) && !/\d/.test(words[i - 1] || ''))); // "I am busy": not a time
  return (keep.length && keep.length < words.length ? keep.join(' ') : t).slice(0, 120);
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
    callbackAt: /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(String(o.callbackAt || '')) ? o.callbackAt : undefined, // India time
    pendingQuestions: Array.isArray(o.pendingQuestions) ? o.pendingQuestions.map((q) => str(q, 200)).filter(Boolean).slice(0, 5) : [],
    declineReason: str(o.declineReason, 120),
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
    // the AI brain (brain.js think(d, text)): understanding + a natural lead-in; null = the word lists only
    this.brain = typeof opts.brain === 'function' ? opts.brain : null;
    // verified answers for this requirement ([{ q, a }]) the brain may use (pending clarifications answered by recruiters)
    this.knowledge = Array.isArray(opts.knowledge) ? opts.knowledge : [];
    // the requirement row from the ATS (its description holds timings, pay per role, accommodation ...): answers.js reads it
    this.requirement = opts.requirement || null;
    this.maxTurns = opts.maxTurns || 20; // room for a few "could you say that again?" turns
    // which wording of each line this call uses (scripts.phrases); the call id, so every turn of one call sounds the same
    this.seed = opts.seed == null ? null : String(opts.seed);
    this.prefix = '';
    this.st = {
      step: 'identity', turns: 0, tries: 0, done: false, ended: null, identity: false, wrong: false, interest: null, told: false,
      answers: {}, callback: false, callbackWhen: null, human: false, stop: false, attendance: null, preferredTime: null, transcript: [], outcome: null, lastAsk: '',
      language: null, upset: 0, calmFrom: null,
      pending: [], callbackAt: null, heardFacts: null,
      unheard: 0, silent: 0, mixed: 0, repeats: 0, audioFrom: null, audioTries: 0, askedWhy: false, declineReason: null, changedMind: false, whenAsked: false,
    };
    this.setLanguage(S.LANGS.includes(opts.language) ? opts.language : 'English');
  }

  // Every fixed sentence from here on is in this language (the call's start language, or the one the person switched to).
  setLanguage(lang) {
    if (!S.LANGS.includes(lang)) return;
    this.language = lang;
    this.P = S.phrases(lang, this.seed);
    this.B = S.blocks(this.purpose, lang, this.data, this.fields, { recordingNotice: this.recordingNotice, seed: this.seed });
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
  // A SHORT HUMAN ACKNOWLEDGEMENT of what the person just said ("Okay, three years." / "సరే, హైదరాబాద్."), said before the next
  // line - only when the brain has not already given its own lead-in for this turn.
  ack(key, vals = {}) {
    if (this.prefix || !this.P[key]) return;
    if (Object.values(vals).some((v) => v === '' || v == null)) return;
    this.prefix = S.fill(this.P[key], vals);
  }
  yearsWords(y) {
    const n = Math.round(y * 10) / 10;
    if (this.language === 'Telugu') return n === 1 ? 'ఒక సంవత్సరం' : `${n} ఏళ్ళు`;
    if (this.language === 'Hindi') return n === 1 ? 'एक साल' : `${n} साल`;
    return n === 1 ? 'one year' : `${n} years`;
  }

  speak(...parts) {
    if (this.prefix) { parts.unshift(this.prefix); this.prefix = ''; } // e.g. the brain's short lead-in, once, before the next sentence
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
  // prefix '' = understood, nothing to say before the question (e.g. a language switch); undefined = not understood
  again(prefix) {
    const q = {
      // after an answer (prefix), simply ask again; "sorry, I did not catch that" only when nothing was understood
      identity: prefix != null ? this.B.identity : this.P.identityAgain.replace('{name}', S.clean(this.data.name || this.data.firstName)),
      convenient: this.P.convenient,
      intro: this.B.intro,
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
      why_not: this.P.whyNot,
      convince: this.P.convinceQ,
      keep_other: this.P.keepOtherQ,
      audio_check: this.P.canHear,
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
  //   meta.heard  'unclear' = speech was there but not heard reliably (the phone gateway decides: Whisper's sureness, a
  //               language guess from noise, empty words for real speech). Never read as an answer: asked again.
  //   meta.lang / meta.conf  kept on the turn for the Talk history (conf only where the engine gives one)
  // Every candidate turn keeps the EXACT words heard (text), how clearly (heard: clear | unclear | none) and, separately,
  // how the assistant read them (understood) - the reading is never shown as the person's words.
  async hear(textIn, meta = {}) {
    if (this.st.done) return { say: '', done: true };
    const text = String(textIn == null ? '' : textIn).slice(0, 600);
    const heardAs = meta.heard === 'unclear' ? 'unclear' : (text.trim() ? 'clear' : 'none');
    this.st.turns += 1;
    const turn = { who: 'candidate', text: S.clean(text, 300), heard: heardAs, at: new Date().toISOString() };
    if (meta.lang) turn.lang = meta.lang;
    if (meta.conf) turn.conf = meta.conf;
    this.st.transcript.push(turn);
    if (this.st.turns > this.maxTurns) return this.close(this.fallback(), 'too many turns');
    const st = this.st;
    // 0. not heard reliably: never guessed, never a language switch - asked again (2 tries, then a polite end)
    if (heardAs === 'unclear') { turn.understood = 'not_clear'; return this.unheard(); }
    // 1. the person's language: from this sentence on, every answer is in it
    const lg = this.autoLanguage ? detectLanguage(text) : null;
    // A LANGUAGE SWITCH IS NOT ANNOUNCED (founder 2026-10-30: "sare telugu lo matladkundham ani cheppakunda, direct
    // conversation"): the next sentence is simply in their language, like a person who speaks both would do.
    if (lg && lg.lang !== this.language) this.setLanguage(lg.lang);
    if (lg && lg.only) { turn.understood = 'language'; this.prefix = ''; return { say: this.again(''), done: false }; }
    // 1b. THE BRAIN (brain.js): what they meant in the context of the last question, the facts in it, and a short natural
    // lead-in in their language. The word lists below are the fallback - and the only reader when the brain is off / slow.
    let b = null;
    if (this.brain) {
      try { b = await this.brain(this, text); } catch { b = null; }
      if (b) {
        turn.brain = { intent: b.intent, ms: b.ms };
        // a switch the word check missed (a Teluglish / Hinglish sentence): the brain read the language from the words
        if (this.autoLanguage && b.language && b.language !== this.language && !lg && text.trim().split(/\s+/).length >= 3) {
          this.setLanguage(b.language);
        }
      }
    }
    st.heardFacts = b;
    let k = b ? this.fromBrain(b, text) : await this.intentOf(text);
    // a mis-heard "చెప్పండి" / "ఓకే" to "can we talk? / shall I tell you about it?": go on (only where a yes just means "go on")
    if (k.intent === 'unclear' && ['convenient', 'intro', 'audio_check', 'calm'].includes(st.step) && fuzzyGoAhead(text)) k = { intent: 'yes', human: k.human, goAhead: true, fuzzy: true };
    turn.understood = k.intent;
    st.lastHeard = text;
    if (k.human) st.human = true;

    // silence is never yes, no, interest or consent: "are you still there?", then a polite end
    if (k.intent === 'silence') return this.silent();
    st.unheard = 0; st.silent = 0;
    if (k.intent === 'stop') { st.stop = true; return this.finish(this.speak(this.P.closeStop), 'stop'); }
    // the person cannot hear the assistant: check the line before anything else is said
    if (k.intent === 'cant_hear' && st.step !== 'audio_check') {
      st.audioFrom = st.step; st.step = 'audio_check'; st.audioTries = 0;
      return { say: this.speak(this.P.canHear), done: false };
    }
    const t = norm(text);
    if (isGreeting(t) && (st.step === 'identity' || t.split(' ').every((w) => PLAIN_HELLO.includes(w) || GREET_EXTRA.includes(w))) && (st.greets || 0) < 3) { st.greets = (st.greets || 0) + 1; return { say: st.step === 'identity' ? this.speak(this.B.identity) : this.again(HELLO_BACK[this.language] || HELLO_BACK.English), done: false }; } // the name question already says hello
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
    // "can you repeat?": the same question again (a few times; then it is read like any unclear answer)
    if (k.intent === 'repeat' && st.step !== 'audio_check' && (st.repeats += 1) <= 3) return { say: this.again(this.P.sureRepeat), done: false };
    // "Yes, I can't ..." on a yes / no question: ask which, neutrally - never pick one
    if (k.intent === 'mixed' && YES_NO_STEPS.includes(st.step) && st.step !== 'audio_check') {
      if ((st.mixed += 1) <= 2) return { say: this.speak(this.P.yesOrNo), done: false };
      return this.close(this.fallback(), 'answer not clear (yes and no)');
    }
    // the brain's lead-in ("Okay, three years, noted.") goes before whatever the step says next
    if (b && b.leadIn && LEAD_OK.includes(b.intent)) this.prefix = [this.prefix, b.leadIn].filter(Boolean).join(' ');
    // "call me tomorrow at 5": the day and time are already said - noted at once, not asked again
    if (k.intent === 'later' && b && b.callbackAt && st.step !== 'identity') {
      st.callback = true; st.callbackAt = b.callbackAt; st.callbackWhen = b.callbackText || readTime(text);
      return this.close(this.purpose.startsWith('Interview') ? 'No Response' : 'Call Back Later', 'call back later', this.P.laterNoted.replace('{when}', st.callbackWhen));
    }
    if (k.intent === 'maybe') { const m = this.onMaybe(); if (m) return m; }

    if (st.step === 'calm') return this.on_calm(k);
    // "explain once more / details cheppandi / फिर से समझाइए": the job again (any number of times), then the open question
    if (st.step !== 'identity' && S.screenLike(this.purpose) && has(norm(text), EXPLAIN) && !['later_when', 'resched_time'].includes(st.step)) {
      turn.understood = 'explain again';
      return { say: this.again(this.B.brief), done: false };
    }
    // "who is this? / where are you calling from?" before the name: who we are (it shares nothing), then the name again
    if (st.step === 'identity' && A.topicOf(text).includes('who')) { turn.understood = 'question'; return { say: this.speak(A.answer(this, text).say, this.B.identity), done: false }; }
    if (st.step === 'identity') return this.onIdentity(k);
    if (st.step === 'audio_check') return this.on_audio_check(k);
    // a QUESTION, answered by the brain from the verified facts only - or "I don't have confirmed information, the team
    // will check" and the question is kept for the recruiter (pending clarification). Then the same question again.
    if (b && b.intent === 'question' && st.step !== 'why_not') {
      if (b.question && !b.answeredFromFacts && st.pending.length < 5 && !st.pending.includes(b.question)) st.pending.push(b.question);
      this.prefix = '';
      return { say: this.again(b.leadIn || this.P.noInfo), done: false };
    }
    // nothing about the job before the person is confirmed (the step cannot be anything else after identity)
    // (at "why not interested?" a salary / location remark IS the reason: it goes to the step)
    // A QUESTION ABOUT THE JOB, answered from the ATS (answers.js: the requirement's fields and description, the recruiters'
    // answers). Never "I don't know": what the ATS does not hold is "I'll confirm with the team" and goes to the recruiter.
    // Then the same question again. (Before the name is confirmed only "who is calling?" is answered.)
    // At "how many years / which city / notice period?" an answer often holds question words ("ఎన్ని రోజులు అంటే 30 రోజులు"):
    // there only a real question about ANOTHER thing ("salary entha?") is answered; the step reads the rest.
    const OWN = { qExp: 'experienceNeeded', qLoc: 'location', qNotice: 'joining' };
    const topics = A.topicOf(text);
    const qStep = /^q/.test(st.step);
    const asks = !['resched_time', 'later_when', 'why_not'].includes(st.step) && (qStep
      ? topics.some((x) => x !== OWN[st.step]) && A.looksQuestion(text)
      : (k.intent === 'salary_q' || k.intent === 'info_q' || (topics.length > 0 && k.intent !== 'no' && (A.looksQuestion(text) || String(text).trim().split(/\s+/).length <= 3))));
    if (asks) {
      const qa = A.answer(this, text);
      if (qa && (st.step !== 'identity' || qa.topic === 'who')) {
        turn.understood = 'question';
        turn.answered = qa.unknown ? 'to confirm' : (qa.fromRecruiter ? 'recruiter answer' : 'from the ATS');
        if (qa.unknown && st.pending.length < 5) { const q = S.clean(text, 200); if (q && !st.pending.includes(q)) st.pending.push(q); }
        if (qa.topic === 'eligibility' && st.answers.experienceYears == null) { const y = readYears(text); if (y != null) st.answers.experienceYears = y; }
        return { say: this.again(qa.say), done: false };
      }
    }
    return this[`on_${st.step}`](k, text);
  }

  fallback() { return this.purpose.startsWith('Interview') ? 'No Response' : 'Unclear'; }

  // MEMORY ACROSS CALLS (2026-10-30): what the person already told on an earlier call about THIS application is not asked
  // again. Only the plain answers are carried over (years, city, notice period) - never an interest or an outcome.
  remember(prev) {
    if (!prev) return this;
    this.memory = { at: prev.at || null };
    const a = prev.answers || {};
    if (Number.isFinite(a.experienceYears)) this.st.answers.experienceYears = a.experienceYears;
    if (a.currentLocation && !S.looksGarbled(a.currentLocation)) this.st.answers.currentLocation = S.clean(a.currentLocation, 40);
    if (a.noticePeriodText) { this.st.answers.noticePeriodText = S.clean(a.noticePeriodText, 30); if (Number.isFinite(a.noticePeriodDays)) this.st.answers.noticePeriodDays = a.noticePeriodDays; }
    this.st.remembered = true;
    return this;
  }
  // the next question that is still open, from this step on (a remembered answer is skipped)
  ask(step) {
    const order = ['qExp', 'qLoc', 'qNotice', 'qProceed'];
    const a = this.st.answers;
    const known = { qExp: a.experienceYears != null, qLoc: !!a.currentLocation, qNotice: !!a.noticePeriodText };
    let i = Math.max(0, order.indexOf(step));
    while (i < order.length - 1 && known[order[i]]) i += 1;
    this.st.step = order[i];
    return { say: this.speak(this.P[order[i]]), done: false };
  }

  // The brain's reading -> the intent the steps understand. A stop is believed only when the words hold a no / stop too:
  // a stop ends every future call, so it is never taken from a guess.
  fromBrain(b, text) {
    const words = classify(text);
    const human = b.intent === 'human' || words.human;
    switch (b.intent) {
      case 'stop': return { intent: ['stop', 'no'].includes(words.intent) ? 'stop' : 'no', human };
      case 'question': return { intent: words.intent === 'salary_q' ? 'salary_q' : 'info_q', human };
      case 'already_employed':
        if (!this.st.declineReason) this.st.declineReason = b.declineReason || 'Already employed';
        return { intent: 'no', human };
      case 'wrong_person': return { intent: this.st.step === 'identity' ? 'no' : 'unclear', human };
      case 'answer': case 'greeting': return { intent: words.intent === 'silence' ? 'unclear' : words.intent, human };
      default: return { intent: b.intent, human };
    }
  }

  // Speech that was not heard reliably: ask again; the second time say the line is breaking; the third time end politely.
  unheard() {
    const st = this.st;
    st.unheard += 1;
    if (st.unheard >= 3) return this.close(this.fallback(), 'could not hear the person clearly', this.P.audioClose);
    return { say: this.again(st.unheard === 1 ? this.P.notClear : this.P.breaking), done: false };
  }

  // No reply at all (the gateway's quiet timer, or empty text): "are you still there?" twice, then a polite end.
  silent() {
    const st = this.st;
    st.silent += 1;
    if (st.silent >= 3) return this.close(this.fallback(), 'no answer heard', this.P.noAnswerClose);
    return { say: this.again(st.silent === 1 ? this.P.stillThere : this.P.stillThere2), done: false };
  }

  // "Maybe / it depends / I'll check": never recorded as interested or as not interested.
  onMaybe() {
    const st = this.st;
    if (st.step === 'convenient') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    if (st.step === 'intro') { st.step = 'interest'; return { say: this.speak(this.B.brief, this.P.interestQ), done: false }; } // hearing about the job commits to nothing
    if (['interest', 'qProceed', 'proceed'].includes(st.step)) {
      st.interest = 'unsure'; st.step = 'human_offer'; st.tries = 0;
      return { say: this.speak(this.P.thatsFine, this.P.interestMore), done: false };
    }
    if (st.step === 'avail') { st.step = 'later_when'; return { say: this.speak(this.P.checkFollowUp), done: false }; } // not confirmed
    return null; // the questions (experience, place, notice ...) read the words themselves
  }

  // "Can you hear me now?": yes -> the interrupted question again; otherwise once more, then a polite end.
  on_audio_check(k) {
    const st = this.st;
    if (k.intent === 'yes') { st.step = st.audioFrom || 'identity'; st.audioTries = 0; return { say: this.again(this.P.sureRepeat), done: false }; }
    st.audioTries += 1;
    if (st.audioTries >= 2) return this.close(this.fallback(), 'the person could not hear the assistant', this.P.audioClose);
    return { say: this.speak(this.P.canHear), done: false };
  }

  // Not interested: ONE polite, optional question (is it this job, or not looking now?), then the answer is accepted.
  notInterested() {
    const st = this.st;
    st.interest = 'no';
    const told = st.heardFacts && st.heardFacts.declineReason;
    if (told && !st.declineReason) st.declineReason = told;
    if (st.convinced) return this.keepOther(); // already tried once: never pushed twice
    // a reason said WITH the no ("salary takkuva, interest ledhu"): what is left once the plain no-words are taken out
    const NO_WORDS = new Set(['no', 'not', 'nope', 'interested', 'interest', 'i', 'am', 'im', "i'm", 'thanks', 'thank', 'you', 'sorry', 'sir', 'madam', 'really', 'at', 'all',
      'లేదు', 'లేద', 'వద్దు', 'కాదు', 'ఇంట్రెస్ట్', 'ఇంట్రెస్టు', 'నాకు', 'సారీ', 'అండి', 'ఓకే', 'నహీం', 'नहीं', 'नही', 'इंटरेस्ट', 'है', 'मुझे', 'जी', 'सॉरी', 'ledu', 'vaddu', 'nahi']);
    if (!st.declineReason && st.lastHeard && norm(st.lastHeard).split(' ').filter((w) => w && !NO_WORDS.has(w)).length >= 2) st.declineReason = S.clean(st.lastHeard, 120);
    if (st.declineReason) return this.convince(st.declineReason); // the reason came with the "no"
    if (st.askedWhy) return this.close('Not Interested', 'not interested');
    st.askedWhy = true; st.step = 'why_not'; st.tries = 0;
    return { say: this.speak(this.P.whyNot), done: false };
  }

  // ONE honest try (founder 2026-10-30: "not interested ante convince cheyyali, thanks cheppi pettesthundhi"): answer the
  // reason with a true fact from the ATS (the pay when it is about money, the place when it is about distance, else what kind
  // of job it is and that the interview commits them to nothing), then "would you like to give it a try?". A second no is
  // respected: "shall I call you for a job that suits you better?" - never pushed twice.
  convince(reason) {
    const st = this.st;
    st.convinced = true; st.step = 'convince'; st.tries = 0;
    const t = norm(reason || '');
    const x = this.data || {};
    const money = has(t, [...L.salary, 'money', 'low', 'less', 'తక్కువ', 'कम']);
    const far = has(t, ['far', 'distance', 'location', 'travel', 'దూరం', 'లొకేషన్', 'दूर', 'लोकेशन']);
    const kind = [x.employmentType, x.workMode].filter(Boolean).join(', ');
    const pay = x.salary && !String(x.salary).includes(',') ? S.clean(x.salary, 60) : '';
    const place = x.location ? S.clean(x.location, 60) : '';
    const notNow = has(t, ['not looking', 'no change', 'not changing', 'happy', 'working', 'job undi', 'మారే ఆలోచన', 'మారను', 'వర్క్ చేస్తున్నా', 'జాబ్ ఉంది', 'बदलने', 'काम कर रहा', 'जॉब है']);
    const parts = [];
    // what they said, answered first - then the job's true facts, the "nothing to lose", and the question
    if (money && pay) parts.push(S.fill(this.P.convinceSalary, { salary: pay }));
    else if (far && place) parts.push(S.fill(this.P.convinceLoc, { location: place }));
    else parts.push(notNow ? this.P.pitchNotNow : this.P.pitchAck);
    const job = place && kind ? S.fill(this.P.pitchJob, { location: place, kind }) : (kind ? S.fill(this.P.convinceGeneral, { kind }).replace(/^[^.।]*[.।]\s*/, '') : '');
    if (job && !(far && place)) parts.push(job);
    if (pay && !money) parts.push(S.fill(this.P.pitchPay, { salary: pay }));
    parts.push(this.P.pitchNoLoss);
    return { say: this.speak(...parts, this.P.convinceQ), done: false };
  }
  on_convince(k) {
    const st = this.st;
    if (k.intent === 'yes' || k.goAhead) { st.interest = 'yes'; st.changedMind = true; st.tries = 0; this.ack('ackInterest'); return this.ask('qExp'); }
    if (k.intent === 'later') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    if (k.intent === 'no' || k.intent === 'maybe') return this.keepOther();
    return this.retry(k);
  }
  keepOther() {
    this.st.step = 'keep_other'; this.st.tries = 0;
    return { say: this.speak(this.P.keepOtherQ), done: false };
  }
  on_keep_other(k) {
    const st = this.st;
    if (k.intent === 'yes' || k.goAhead) { st.openToOther = true; return this.close('Not Interested', 'not interested, open to other jobs', this.P.keepOtherYes); }
    return this.close('Not Interested', 'not interested');
  }

  on_why_not(k, text) {
    const st = this.st;
    const t = norm(text);
    // changed their mind: the earlier "no" stays in the history and the summary
    if (k.intent === 'yes' && (has(t, ['interested', 'interest', 'इंटरेस्टेड', 'ఇంట్రెస్ట్', 'ఆసక్తి ఉంది', 'dilchaspi', 'try', 'ట్రై', 'ट्राई', 'చేద్దాం', 'चलो']) || t.split(' ').length <= 2)) {
      st.interest = 'yes'; st.changedMind = true; st.tries = 0;
      return this.ask('qExp');
    }
    // their own words, short, as the reason (a bare yes / no says nothing about why: nothing is recorded)
    if (st.heardFacts && st.heardFacts.declineReason) st.declineReason = st.heardFacts.declineReason;
    else if (!['yes', 'no', 'silence'].includes(k.intent)) st.declineReason = S.clean(text, 120) || null;
    return this.convince(st.declineReason || text);
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
      this.ack('ackName');
      // a call-back: "we spoke earlier about the ... job" before "is this a good time?" (memory, 2026-10-30)
      if (S.screenLike(this.purpose)) { st.step = 'convenient'; return { say: this.speak(this.memory ? S.fill(this.P.resumeLine, { job: this.data.jobTitle }) : '', this.B.convenient), done: false }; }
      if (this.purpose === 'AI Interview Pending') {
        st.step = 'proceed'; st.told = true;
        return { say: this.speak(this.B.aiNews, this.B.aiDue, this.P.aiHow, this.B.note, this.P.aiProceed), done: false };
      }
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
    if (st.tries >= 3) return this.close('Unclear', 'identity not confirmed');
    return { say: this.again(st.tries === 2 ? this.P.yesOrNo : undefined), done: false };
  }

  on_convenient(k, text) {
    const st = this.st;
    if (k.intent === 'yes') { st.step = 'intro'; this.ack('ackTime'); return { say: this.speak(this.B.intro), done: false }; }
    if (k.intent === 'no' || k.intent === 'later' || k.intent === 'reschedule') {
      st.callback = true; st.step = 'later_when';
      if (k.intent !== 'no' && timeLike(text)) return this.on_later_when(k, text); // the time is already in the sentence
      return { say: this.speak(this.P.laterAsk), done: false };
    }
    return this.retry(k);
  }

  on_intro(k) {
    const st = this.st;
    if (k.intent === 'yes') { st.step = 'interest'; return { say: this.speak(this.B.brief, this.P.interestQ), done: false }; }
    if (k.intent === 'no') return this.notInterested();
    if (k.intent === 'later') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    // still not clear the second time: the person is on the line and talking - tell them about the job (it commits to
    // nothing) instead of ending the call (a real call ended here, 2026-10-30)
    if (st.tries >= 1) { st.tries = 0; st.step = 'interest'; return { say: this.speak(this.B.brief, this.P.interestQ), done: false }; }
    return this.retry(k);
  }

  on_interest(k) {
    const st = this.st;
    // "చెప్పండి" / "tell me" after the job = tell me (again): as many times as they ask
    if (k.intent === 'yes' && k.goAhead) return { say: this.speak(this.B.brief, this.P.interestQ), done: false };
    if (k.intent === 'repeat') return { say: this.speak(this.B.brief, this.P.interestQ), done: false };
    if (k.intent === 'yes') { st.interest = 'yes'; st.tries = 0; this.ack('ackInterest'); return this.ask('qExp'); }
    if (k.intent === 'no') return this.notInterested();
    if (k.intent === 'later') { st.callback = true; st.step = 'later_when'; return { say: this.speak(this.P.laterAsk), done: false }; }
    if (k.intent === 'human') { st.human = true; st.interest = 'unsure'; return this.close('Unclear', 'asked for a recruiter', this.P.humanNoted); }
    st.tries += 1;
    if (st.tries >= 3) { st.interest = 'unsure'; st.step = 'human_offer'; st.tries = 0; return { say: this.speak(this.P.interestMore), done: false }; }
    return { say: this.again(st.tries === 2 ? this.P.yesOrNo : this.P.repeat), done: false };
  }

  // "shall I tell you about the job once more?" - the assistant explains it again itself (no hand-off to a recruiter)
  on_human_offer(k) {
    const st = this.st;
    if (k.intent === 'human') { st.human = true; return this.close('Unclear', 'recruiter call requested', this.P.humanNoted); }
    if (k.intent === 'yes' || k.goAhead) { st.step = 'interest'; st.tries = 0; return { say: this.speak(this.B.brief, this.P.interestQ), done: false }; }
    if (k.intent === 'no') return this.notInterested();
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
    if (y == null && st.heardFacts && st.heardFacts.experienceYears != null) y = st.heardFacts.experienceYears;
    if (y == null) { const l = this.laterInQuestions(k); if (l) return l; }
    if (y == null && k.intent === 'no') y = 0;
    if (y == null) {
      st.tries += 1;
      if (st.tries < 2) return { say: this.again(this.P.repeat), done: false };
    } else {
      st.answers.experienceYears = y;
      if (y === 0) this.ack('ackFresher'); else this.ack('ackExp', { yrs: this.yearsWords(y) });
    }
    st.tries = 0;
    return this.ask('qLoc');
  }

  on_qLoc(k, text) {
    const st = this.st;
    const l = this.laterInQuestions(k); if (l) return l;
    const place = (st.heardFacts && st.heardFacts.location) || (['no', 'yes', 'maybe', 'mixed'].includes(k.intent) ? null : readPlace(text));
    if (!place) {
      st.tries += 1;
      if (st.tries < 2) return { say: this.again(this.P.repeat), done: false };
    } else {
      st.answers.currentLocation = String(place).split(/\s+/).filter((w) => w.replace(/[\p{M}\p{P}]/gu, '').length > 1).join(' ') || place;
      const spokenPlace = S.clean(String(st.answers.currentLocation).replace(/[.,!?।]+$/g, ''), 40);
      if (!S.looksGarbled(place) && knownPlace(spokenPlace)) this.ack('ackLoc', { place: spokenPlace }); else this.ack('ackNoted');
    }
    st.tries = 0;
    return this.ask('qNotice');
  }

  on_qNotice(k, text) {
    const st = this.st;
    let n = readNotice(text);
    if (n.text == null && st.heardFacts && st.heardFacts.noticeDays != null) n = { days: st.heardFacts.noticeDays, text: st.heardFacts.noticeText || (st.heardFacts.noticeDays === 0 ? 'immediate' : `${st.heardFacts.noticeDays} days`) };
    if (n.text == null) { const l = this.laterInQuestions(k); if (l) return l; }
    if (n.text == null) {
      st.tries += 1;
      if (st.tries < 2) return { say: this.again(this.P.repeat), done: false };
    } else {
      if (n.days != null) st.answers.noticePeriodDays = n.days;
      st.answers.noticePeriodText = n.text;
      if (n.days === 0) this.ack('ackNoticeNow'); else if (n.days > 0) this.ack('ackNotice', { days: n.days }); else this.ack('ackNoted');
    }
    st.tries = 0;
    return this.ask('qProceed');
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
    st.callback = true;
    // only a real day / time is noted; anything else is asked once more, then the call ends without a time
    if (st.heardFacts && st.heardFacts.callbackAt) { st.callbackAt = st.heardFacts.callbackAt; st.callbackWhen = st.heardFacts.callbackText || readTime(text); } else
    if (timeLike(text)) st.callbackWhen = readTime(text);
    else if (!st.whenAsked && k.intent !== 'no') { st.whenAsked = true; return { say: this.speak(this.P.laterWhenAgain), done: false }; }
    const out = this.purpose.startsWith('Interview') ? 'No Response' : 'Call Back Later';
    return this.close(out, 'call back later', st.callbackWhen ? this.P.laterNoted.replace('{when}', st.callbackWhen) : this.P.laterClose);
  }

  on_avail(k, text) {
    const st = this.st;
    if (k.intent === 'yes') { st.attendance = 'confirmed'; return this.close('Confirmed', 'confirmed'); }
    if (k.intent === 'reschedule') {
      st.attendance = 'reschedule';
      if (timeLike(text)) { st.preferredTime = readTime(text); return this.close('Reschedule Requested', 'reschedule requested', this.P.ivReschedNoted); }
      st.step = 'resched_time';
      return { say: this.speak(this.P.ivReschedAsk), done: false };
    }
    if (k.intent === 'no') { st.attendance = 'not_available'; st.step = 'resched_time'; return { say: this.speak(this.P.ivReschedAsk), done: false }; }
    if (k.intent === 'later') { st.callback = true; st.callbackWhen = timeLike(text) ? readTime(text) : null; return this.close('No Response', 'asked to call later', this.P.ivNoReply); }
    return this.retry(k);
  }

  on_resched_time(k, text) {
    const st = this.st;
    if (k.intent === 'no') return this.close('Not Available', 'not available', this.P.ivNotAvail);
    st.attendance = 'reschedule';
    if (timeLike(text)) st.preferredTime = readTime(text);
    return this.close('Reschedule Requested', 'reschedule requested', this.P.ivReschedNoted);
  }

  retry(k) {
    const st = this.st;
    st.tries += 1;
    if (st.tries >= 3) {
      return this.close(this.purpose.startsWith('Interview') ? 'No Response' : 'Unclear', 'unclear answer');
    }
    // the second time, asked another way ("was that a yes or a no?" + the question), like a person would
    return { say: this.again(st.tries === 2 && YES_NO_STEPS.includes(st.step) ? this.P.yesOrNo : this.P.repeat), done: false };
  }

  // End the call with an outcome and the closing sentence for it.
  close(outcome, why, sentence) {
    const st = this.st;
    st.outcome = outcome;
    let line = sentence;
    if (!line) {
      if (S.screenLike(this.purpose)) line = outcome === 'Interested' ? this.P.closeInterested : outcome === 'Not Interested' ? this.P.closeNotInterested : this.P.closeUnclear;
      else if (this.purpose === 'AI Interview Pending') line = outcome === 'Interested' ? this.P.aiYes : outcome === 'Not Interested' ? this.P.closeNotInterested : this.P.closeUnclear;
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
    if (st.convinced) bits.push(st.changedMind ? 'Said no first; agreed to try after hearing more about the job.' : (st.openToOther ? 'Not interested in this job; wants a call for other suitable jobs.' : 'Not interested even after hearing more.'));
    if (st.identity && this.purpose === 'AI Interview Pending') bits.push(st.told ? 'Told that the AI interview is pending and how to take it.' : '');
    if (this.purpose === 'AI Interview Pending' && st.interest === 'yes') bits.push('Said they will take the AI interview.');
    else if (this.purpose === 'AI Interview Pending' && st.interest === 'no') bits.push('Does not want to take the AI interview.');
    else if (st.interest === 'yes') bits.push('Interested.'); else if (st.interest === 'no') bits.push('Not interested.');
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
    if (st.changedMind) bits.push('First said not interested, then said they are interested.');
    if (st.declineReason) bits.push(`Why not interested (their words): "${st.declineReason}".`);
    if (st.callbackAt) bits.push(`Call back at: ${st.callbackAt.replace('T', ' ')} (India time).`);
    if (st.pending && st.pending.length) bits.push(`Asked (the team must answer): ${st.pending.join(' | ')}.`);
    const unclear = st.transcript.filter((x) => x.heard === 'unclear').length;
    if (unclear) bits.push(`${unclear} answer${unclear === 1 ? ' was' : 's were'} not heard clearly and asked again; nothing was assumed.`);
    if (st.ended === 'could not hear the person clearly' || st.ended === 'the person could not hear the assistant') bits.push('Ended because of a line / audio problem.');
    if (st.ended === 'no answer heard') bits.push('No reply was heard, so the call ended.');
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
      callbackAt: st.callbackAt || undefined,
      pendingQuestions: st.pending || [],
      declineReason: st.declineReason || undefined,
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

// the brain intents whose lead-in is spoken before the next question
const LEAD_OK = ['answer', 'yes', 'no', 'maybe', 'later', 'reschedule', 'already_employed', 'human'];
// the steps whose question is a plain yes / no
const YES_NO_STEPS = ['identity', 'convenient', 'intro', 'interest', 'human_offer', 'qProceed', 'proceed', 'avail', 'calm', 'audio_check', 'convince', 'keep_other'];

module.exports = { Dialogue, timeLike, classify, fuzzyGoAhead, skeleton, detectLanguage, validateOutcome, OUTCOMES, INTENTS, readYears, readNotice, readPlace, norm };
