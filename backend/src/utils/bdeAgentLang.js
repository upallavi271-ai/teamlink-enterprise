// ---------------------------------------------------------------------------
// BDE AGENT - WORDS (2026-11-20): the language of a question, the period it names, and the few phrases the code answers are written in.
//
//   langOf(text)          'te' (Telugu script) | 'tl' (Telugu written in English letters) | 'en'
//   normalize(text)       lower case, Telugu-script keywords mapped to the English words the router reads, common typos fixed
//   periodOf(text, def)   { key, from, to, label(lang) }  IST days, 'YYYY-MM-DD'
//   say(lang, {en, tl, te})  the phrase in the asker's language (English when a variant is missing)
// Pure functions, no database.
// ---------------------------------------------------------------------------

const TELUGU = /[ఀ-౿]/;
// Telugu written in English letters: words that do not occur in English questions
const TL_WORDS = /\b(enti|entha|enni|ennu|emi|emiti|em|ela|evaru|eppudu|ekkada|cheppu|cheppandi|chupinchu|chupinchandi|chepu|kavali|undi|unnayi|unnaya|unda|vunnayi|vunnaya|vundi|ayyindi|ayyayi|ayyindha|ayye|ayyevi|aithe|ledu|levu|naaku|naa|maa|meeku|mee|gurinchi|lo|ki|ni|ga|ivala|eeroju|ee|roju|repu|ninna|vaaram|nela|gatha|poyina|vachhe|vacche|raabooye|pending\s+lo|chesanu|cheyali|cheyyali|cheyalo|cheyyalo|evi|ivvu|ivvandi|adagali|vachayi|vachindi|pampinchanu|pampali|chudali|kottha|kotha)\b/;

function langOf(text) {
  const s = String(text || '');
  if (TELUGU.test(s)) return 'te';
  const hits = (s.toLowerCase().match(new RegExp(TL_WORDS.source, 'g')) || []).length;
  return hits >= 1 ? 'tl' : 'en';
}

// Telugu-script words -> the English words the router understands (the record names stay as typed: atsSearch reads Telugu itself)
const TE_MAP = [
  [/ఇంటర్వ్యూ\S*/g, ' interviews '], [/క్లయింట్\S*|క్లైంట్\S*/g, ' clients '], [/ఇన్వాయిస్\S*|బిల్లు\S*/g, ' invoices '], [/ఒప్పంద\S*|అగ్రిమెంట్\S*/g, ' agreements '],
  [/జాయిన్\S*|చేరిన\S*|చేరారు/g, ' joinings '], [/సెలెక్ట్\S*|ఎంపిక\S*/g, ' selected '], [/ఆఫర్\S*/g, ' offers '], [/రీప్లేస్\S*|భర్తీ/g, ' replacements '],
  [/డ్రాప్\S*|మానేసి\S*/g, ' drops '], [/ఫీడ్‌?బ్యాక్\S*|స్పందన/g, ' feedback '], [/ఫాలో\s*అప్\S*/g, ' follow ups '], [/టార్గెట్\S*|లక్ష్య\S*/g, ' target '],
  [/రిక్వైర్‌?మెంట్\S*|ఉద్యోగ\S*|ఖాళీ\S*/g, ' requirements '], [/ప్రొఫైల్\S*/g, ' profiles '], [/షేర్\S*|పంపిన\S*|పంపారు/g, ' shared '],
  [/ఈ\s*రోజు|ఈరోజు|నేడు|ఇవాళ/g, ' today '], [/రేపు/g, ' tomorrow '], [/నిన్న/g, ' yesterday '], [/ఈ\s*వారం/g, ' this week '], [/ఈ\s*నెల/g, ' this month '],
  [/గత\s*నెల/g, ' last month '], [/పెండింగ్\S*/g, ' pending '], [/ఎన్ని|ఎంత/g, ' how many '], [/గురించి|వివరాలు/g, ' about '], [/ఎలా/g, ' how do i '], [/గడువు\s*దాటిన|బాకీ/g, ' overdue '],
];
// frequent misspellings of the words the router keys on
const TYPOS = [
  [/\bint(e)?r?v(i)?e?w(s)?\b|\bintreviews?\b|\bintervw(s)?\b|\binterveiws?\b|\binterviw(s)?\b|\bintervews?\b|\bintervies\b/g, 'interviews'],
  [/\bcl(e)?i?n?e?ts?\b|\bcleints?\b|\bclinets?\b|\bclents?\b|\bclints?\b/g, 'clients'],
  [/\binvo?i?ce?s?\b|\binvoic(es)?\b|\binvioces?\b|\binvoises?\b/g, 'invoices'],
  [/\bagre+ments?\b|\bagrements?\b|\bagreemnts?\b|\baggrements?\b/g, 'agreements'],
  [/\brequir(e)?me?nts?\b|\brequirments?\b|\brequirmnts?\b|\breqirements?\b|\brequiremnts?\b/g, 'requirements'],
  [/\bjoin(n)?ings?\b|\bjoinigs?\b|\bjoinnings?\b/g, 'joinings'],
  [/\breplacments?\b|\breplacemnts?\b|\breplacemets?\b|\brepalcements?\b/g, 'replacements'],
  [/\bfeed\s*back\b|\bfeedbak\b|\bfeedbck\b/g, 'feedback'],
  [/\bfollow\s*-?\s*ups?\b|\bfollowups?\b|\bfolow\s*ups?\b|\bfollo\s*ups?\b/g, 'follow ups'],
  [/\bselction(s)?\b|\bselections?\b|\bselecteds?\b|\bslected\b/g, 'selected'],
  [/\bprofils?\b|\bprofiels?\b|\bprofles?\b|\bcvs?\b|\bresumes?\b/g, 'profiles'],
  [/\btommorow\b|\btomorow\b|\btmrw\b|\btmr\b|\btommorrow\b/g, 'tomorrow'],
  [/\btoday'?s\b|\btday\b|\btodays\b/g, 'today'],
  [/\boverdu\b|\bover\s+due\b/g, 'overdue'],
];
function normalize(text) {
  let s = String(text || '').normalize('NFC');
  TE_MAP.forEach(([re, w]) => { s = s.replace(re, w); });
  s = s.toLowerCase().replace(/[’']/g, "'").replace(/[?!.,;:()[\]{}"]/g, ' ');
  TYPOS.forEach(([re, w]) => { s = s.replace(re, w); });
  // Telugu-in-English period words -> English
  s = s.replace(/\b(ivala|eeroju|ee\s+roju|ee\s+rooju|ee\s+day|today\s+roju)\b/g, ' today ')
    .replace(/\brepu\b/g, ' tomorrow ').replace(/\bninna\b/g, ' yesterday ')
    .replace(/\bee\s+(vaaram|varam|week)\b/g, ' this week ').replace(/\b(vachhe|vacche|next)\s+(vaaram|varam)\b/g, ' next week ').replace(/\b(gatha|poyina|last)\s+(vaaram|varam)\b/g, ' last week ')
    .replace(/\bee\s+(nela|month|nelalo)\b/g, ' this month ').replace(/\b(gatha|poyina|last)\s+(nela|nelalo)\b/g, ' last month ').replace(/\b(vachhe|vacche|next)\s+nela\b/g, ' next month ');
  return s.replace(/\s+/g, ' ').trim();
}

// ---- dates (IST) -----------------------------------------------------------------------------------------------------------------
const IST = 330 * 60000;
const todayIst = (now = Date.now()) => new Date(now + IST).toISOString().slice(0, 10);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (day) => (day ? `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}` : '');
const dmy = (day) => (day ? `${dm(day)} ${day.slice(0, 4)}` : '');
const monthLabel = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const lastOfMonth = (day) => { const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const mondayOf = (day) => { const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); return addDays(day, -((dow + 6) % 7)); };
// an IST day -> the UTC instants that bound it (for DateTime columns)
const startOf = (day) => new Date(`${day}T00:00:00+05:30`);
const endOf = (day) => new Date(`${addDays(day, 1)}T00:00:00+05:30`);
const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10) : null);
const timeOf = (d) => (d ? new Date(new Date(d).getTime() + IST).toISOString().slice(11, 16) : '');

function say(lang, v) {
  if (typeof v === 'string') return v;
  return (v && (v[lang] || (lang === 'te' && v.tl) || v.en)) || '';
}

// The period a question names. def: the key used when none is named.
const PERIOD_WORDS = {
  today: { en: 'today', tl: 'ee roju', te: 'ఈ రోజు' },
  tomorrow: { en: 'tomorrow', tl: 'repu', te: 'రేపు' },
  yesterday: { en: 'yesterday', tl: 'ninna', te: 'నిన్న' },
  week: { en: 'this week', tl: 'ee vaaram', te: 'ఈ వారం' },
  nextweek: { en: 'next week', tl: 'vachhe vaaram', te: 'వచ్చే వారం' },
  lastweek: { en: 'last week', tl: 'gatha vaaram', te: 'గత వారం' },
  month: { en: 'this month', tl: 'ee nela', te: 'ఈ నెల' },
  lastmonth: { en: 'last month', tl: 'gatha nela', te: 'గత నెల' },
  nextmonth: { en: 'next month', tl: 'vachhe nela', te: 'వచ్చే నెల' },
  next7: { en: 'in the next 7 days', tl: 'next 7 rojullo', te: 'రాబోయే 7 రోజుల్లో' },
  upcoming: { en: 'coming up', tl: 'raabooye', te: 'రాబోయే' },
};
function periodOf(text, def = 'month', today = todayIst()) {
  const t = ` ${String(text || '')} `;
  let key = null;
  let n = null;
  const m = t.match(/\b(?:next|within|in|coming|upcoming|raabooye)\s+(\d{1,3})\s*(?:days?|rojul?(?:u|lo)?)\b/) || t.match(/\b(\d{1,3})\s*(?:days?|rojul?(?:u|lo)?)\b/);
  if (/\btoday\b/.test(t)) key = 'today';
  else if (/\btomorrow\b/.test(t)) key = 'tomorrow';
  else if (/\byesterday\b/.test(t)) key = 'yesterday';
  else if (/\bnext week\b/.test(t)) key = 'nextweek';
  else if (/\blast week\b|\bprevious week\b/.test(t)) key = 'lastweek';
  else if (/\bthis week\b|\bweek\b|\bweekly\b/.test(t)) key = 'week';
  else if (/\blast month\b|\bprevious month\b/.test(t)) key = 'lastmonth';
  else if (/\bnext month\b/.test(t)) key = 'nextmonth';
  else if (/\bthis month\b|\bmonth\b|\bmonthly\b/.test(t)) key = 'month';
  else if (m) { key = 'days'; n = Math.min(Number(m[1]), 365); }
  const named = !!key;
  if (!key) key = def;
  let from; let to;
  switch (key) {
    case 'today': from = today; to = today; break;
    case 'tomorrow': from = addDays(today, 1); to = from; break;
    case 'yesterday': from = addDays(today, -1); to = from; break;
    case 'week': from = mondayOf(today); to = addDays(from, 6); break;
    case 'nextweek': from = addDays(mondayOf(today), 7); to = addDays(from, 6); break;
    case 'lastweek': from = addDays(mondayOf(today), -7); to = addDays(from, 6); break;
    case 'lastmonth': { const l = addDays(`${today.slice(0, 7)}-01`, -1); from = `${l.slice(0, 7)}-01`; to = l; break; }
    case 'nextmonth': { const f = addDays(lastOfMonth(today), 1); from = f; to = lastOfMonth(f); break; }
    case 'next7': from = today; to = addDays(today, 6); break;
    case 'days': if (n == null) n = 30; from = today; to = addDays(today, n); break;
    case 'upcoming': from = today; to = '9999-12-31'; break;
    default: key = 'month'; from = `${today.slice(0, 7)}-01`; to = lastOfMonth(today);
  }
  const range = from === to ? dm(from) : `${dm(from)} - ${dm(to)}`;
  const label = (lang) => {
    if (key === 'days') return say(lang, { en: `in the next ${n} days`, tl: `next ${n} rojullo`, te: `రాబోయే ${n} రోజుల్లో` });
    const w = say(lang, PERIOD_WORDS[key]);
    if (['week', 'nextweek', 'lastweek', 'next7'].includes(key)) return `${w} (${range})`;
    if (['month', 'lastmonth', 'nextmonth'].includes(key)) return `${w} (${monthLabel(from)})`;
    if (key === 'upcoming') return w;
    return `${w} (${dm(from)})`;
  };
  return { key, from, to, n, label, named };
}

module.exports = {
  langOf, normalize, periodOf, say, todayIst, addDays, daysBetween, dm, dmy, monthLabel, lastOfMonth, mondayOf, startOf, endOf, istDay, timeOf, TELUGU,
};
