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
const TL_WORDS = /\b(enti|entha|enni|ennu|emi|emiti|em|ela|evaru|eppudu|ekkada|cheppu|cheppandi|chupinchu|chupinchandi|chepu|kavali|undi|unnayi|unnaya|unda|vunnayi|vunnaya|vundi|ayyindi|ayyayi|ayyindha|ayye|ayyevi|aithe|ledu|levu|naaku|naa|maa|meeku|mee|gurinchi|lo|ki|ni|ga|ivala|eeroju|ee|roju|repu|ninna|vaaram|nela|gatha|poyina|vachhe|vacche|raabooye|pending\s+lo|chesanu|cheyali|cheyyali|cheyalo|cheyyalo|evi|ivvu|ivvandi|adagali|vachayi|vachindi|pampinchanu|pampali|chudali|kottha|kotha|nundi|nunchi|varaku|daaka|samvatsaram|sanvatsaram|ippati|ippativaraku|motham|mottham|janavari|phibravari|febravari|maarchi|epril|joon|julai|aagastu|agastu|septembar|aktobar|navambar|disambar|nelalo)\b/;

function langOf(text) {
  const s = String(text || '');
  if (TELUGU.test(s)) return 'te';
  const hits = (s.toLowerCase().match(new RegExp(TL_WORDS.source, 'g')) || []).length;
  return hits >= 1 ? 'tl' : 'en';
}

// Telugu-script words -> the English words the router understands (the record names stay as typed: atsSearch reads Telugu itself)
const TE_MAP = [
  [/ఇంటర్వ్యూ\S*/g, ' interviews '], [/క్లయింట్\S*|క్లైంట్\S*/g, ' clients '], [/ఇన్వాయిస్\S*|బిల్లు\S*/g, ' invoices '], [/ఒప్పంద\S*|అగ్రిమెంట్\S*/g, ' agreements '],
  [/జాయిని\S*|జాయిన్\S*|చేరిన\S*|చేరారు/g, ' joinings '], [/సెలెక్ట్\S*|ఎంపిక\S*/g, ' selected '], [/ఆఫర్\S*/g, ' offers '], [/రీప్లేస్\S*|భర్తీ/g, ' replacements '],
  [/డ్రాప్\S*|మానేసి\S*/g, ' drops '], [/ఫీడ్‌?బ్యాక్\S*|స్పందన/g, ' feedback '], [/ఫాలో\s*అప్\S*/g, ' follow ups '], [/టార్గెట్\S*|లక్ష్య\S*/g, ' target '],
  [/రిక్వైర్‌?మెంట్\S*|ఉద్యోగ\S*|ఖాళీ\S*/g, ' requirements '], [/ప్రొఫైల్\S*/g, ' profiles '], [/షేర్\S*|పంపిన\S*|పంపారు/g, ' shared '],
  [/ఈ\s*రోజు|ఈరోజు|నేడు|ఇవాళ/g, ' today '], [/రేపు/g, ' tomorrow '], [/నిన్న/g, ' yesterday '], [/ఈ\s*వారం/g, ' this week '], [/ఈ\s*నెల/g, ' this month '],
  [/నెల\s*వారీ\S*/g, ' month wise '], [/రోజు\s*వారీ\S*/g, ' day wise '], [/అందరు|అందరి/g, ' andaru '], [/రిపోర్ట్\S*|నివేదిక/g, ' report '], [/విభాగ\S*/g, ' department '],
  [/గత\s*నెల/g, ' last month '], [/ఈ\s*సంవత్సరం/g, ' this year '], [/గత\s*సంవత్సరం/g, ' last year '], [/ఇప్పటి\s*వరకు|ఇప్పటివరకు|ఇంతవరకు/g, ' till now '],
  [/మొత్తం/g, ' total '], [/నుండి|నుంచి/g, ' nundi '], [/వరకు/g, ' varaku '], [/జాబితా|లిస్ట్/g, ' list '],
  [/జనవరి/g, ' january '], [/ఫిబ్రవరి/g, ' february '], [/మార్చి/g, ' march '], [/ఏప్రిల్/g, ' april '], [/మే\s+(?=\d)/g, ' may '], [/జూన్/g, ' june '], [/జూలై|జులై/g, ' july '],
  [/ఆగస్టు|ఆగష్టు/g, ' august '], [/సెప్టెంబర్|సెప్టెంబరు/g, ' september '], [/అక్టోబర్|అక్టోబరు/g, ' october '], [/నవంబర్|నవంబరు/g, ' november '], [/డిసెంబర్|డిసెంబరు/g, ' december '], [/పెండింగ్\S*/g, ' pending '], [/ఎన్ని|ఎంత/g, ' how many '], [/గురించి|వివరాలు/g, ' about '], [/ఎలా/g, ' how do i '], [/గడువు\s*దాటిన|బాకీ/g, ' overdue '],
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
    .replace(/\b(ippati\s*varaku|ippativaraku|ippati\s*daaka|ippatidaaka|inthavaraku|intha\s*varaku|ipativaraku|ippativarku)\b/g, ' till now ')
    .replace(/\b(motham|mottham|motthamga|mothamga)\b/g, ' total ')
    .replace(/\b(ee|ee\s+current)\s+(samvatsaram|sanvatsaram|samvathsaram|year)(lo)?\b/g, ' this year ').replace(/\b(gatha|poyina|last)\s+(samvatsaram|sanvatsaram|samvathsaram)(lo)?\b/g, ' last year ')
    .replace(/\b(janavari|janvari|janauary|janurary|januray)\b/g, 'january').replace(/\b(phibravari|febravari|februvari|febuary|feburary|febrary)\b/g, 'february')
    .replace(/\b(maarchi|marchi)\b/g, 'march').replace(/\b(epril|epril|aprill)\b/g, 'april').replace(/\b(joon|joonu|jun)\b/g, 'june').replace(/\b(julai|julay|juli)\b/g, 'july')
    .replace(/\b(aagastu|agastu|agust|agustu)\b/g, 'august').replace(/\b(septembar|setember|septmber|sepṭembar)\b/g, 'september').replace(/\b(aktobar|aktober|octobar|octber)\b/g, 'october')
    .replace(/\b(navambar|novembar|navamber|novmber|novemebr)\b/g, 'november').replace(/\b(disambar|decembar|disember|decmber)\b/g, 'december')
    .replace(/\b(\w+)lo\b/g, (w, x) => (/^(january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)$/.test(x) ? `${x}` : w))
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

// THE TIME WINDOW a question names (founder 2026-11-20: "till now" = all time; "january 2026 to november 2026" = that range; the window used is said
// in the first line of every answer). Understood, in English and Telugu written in English letters (normalize() maps those words first):
//   till now / so far / total / all time / ever / overall                         -> all time (up to today)
//   today / yesterday / tomorrow / this|last|next week / this|last|next month / this|last|next year
//   last N days|weeks|months / next N days / in N days
//   a month ("january", "jan 2026"), a year ("2026"), a day ("15/01/2026", "2026-01-15", "15 jan 2026", "jan 15")
//   "from X to Y", "X to Y", "between X and Y", "X nundi Y varaku", "since X", "from X", "before X", "till X"
// def: the window used when the question names none. opts.future: a month without a year means the NEXT one (agreements ending in "march").
const PERIOD_WORDS = {
  today: { en: 'Today', tl: 'Ee roju', te: 'ఈ రోజు' },
  tomorrow: { en: 'Tomorrow', tl: 'Repu', te: 'రేపు' },
  yesterday: { en: 'Yesterday', tl: 'Ninna', te: 'నిన్న' },
  week: { en: 'This week', tl: 'Ee vaaram', te: 'ఈ వారం' },
  nextweek: { en: 'Next week', tl: 'Vachhe vaaram', te: 'వచ్చే వారం' },
  lastweek: { en: 'Last week', tl: 'Gatha vaaram', te: 'గత వారం' },
  month: { en: 'This month', tl: 'Ee nela', te: 'ఈ నెల' },
  lastmonth: { en: 'Last month', tl: 'Gatha nela', te: 'గత నెల' },
  nextmonth: { en: 'Next month', tl: 'Vachhe nela', te: 'వచ్చే నెల' },
  year: { en: 'This year', tl: 'Ee samvatsaram', te: 'ఈ సంవత్సరం' },
  lastyear: { en: 'Last year', tl: 'Gatha samvatsaram', te: 'గత సంవత్సరం' },
  next7: { en: 'Next 7 days', tl: 'Next 7 rojullo', te: 'రాబోయే 7 రోజుల్లో' },
  upcoming: { en: 'Coming up', tl: 'Raabooye', te: 'రాబోయే' },
};
const ALL_FROM = '2000-01-01';
const MONTH_SRC = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const MNUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const okDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && !Number.isNaN(new Date(`${ymd(y, m, d)}T00:00:00Z`).getTime()) && new Date(`${ymd(y, m, d)}T00:00:00Z`).getUTCDate() === d;
const yearOf = (s) => { const n = Number(s); return n < 100 ? 2000 + n : n; };

// every date / month / year written in the text, in order: { start, end, y, m, d }
function mentionsOf(t) {
  const M = MONTH_SRC;
  const RES = [
    [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (x) => ({ y: +x[1], m: +x[2], d: +x[3] })],
    [/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g, (x) => ({ y: yearOf(x[3]), m: +x[2], d: +x[1] })],
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${M}\\b(?:\\s*,?\\s*(\\d{4}))?`, 'g'), (x) => ({ y: x[3] ? +x[3] : null, m: MNUM[x[2].slice(0, 3)], d: +x[1] })],
    [new RegExp(`\\b${M}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(\\d{4}))?`, 'g'), (x) => ({ y: x[3] ? +x[3] : null, m: MNUM[x[1].slice(0, 3)], d: +x[2] })],
    [new RegExp(`\\b${M}\\b(?:\\s*,?\\s*(\\d{4}))?`, 'g'), (x) => ({ y: x[2] ? +x[2] : null, m: MNUM[x[1].slice(0, 3)], d: null, may: x[1] === 'may' && !x[2] })],
    [/\b((?:19|20)\d{2})\b/g, (x) => ({ y: +x[1], m: null, d: null })],
  ];
  const taken = [];
  const out = [];
  RES.forEach(([re, mk]) => {
    let x;
    re.lastIndex = 0;
    while ((x = re.exec(t))) { // eslint-disable-line no-cond-assign
      const start = x.index; const end = x.index + x[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue; // eslint-disable-line no-continue
      const v = mk(x);
      if (v.d != null && v.m != null && v.y != null && !okDay(v.y, v.m, v.d)) continue; // eslint-disable-line no-continue
      if (v.d != null && (v.d < 1 || v.d > 31)) continue; // eslint-disable-line no-continue
      // "may" is a month only next to a date word ("from may", "may to june", "in may"): "may I see ..." is not
      if (v.may && !/\b(from|since|in|to|till|until|between|and|before|after|of|nundi|lo)\s*$/.test(t.slice(Math.max(0, start - 9), start)) && !/^\s*(to|nundi|varaku|-|lo)\b/.test(t.slice(end, end + 9))) continue; // eslint-disable-line no-continue
      taken.push([start, end]);
      out.push({ start, end, ...v });
    }
  });
  return out.sort((a, b) => a.start - b.start);
}
const spanOf = (v) => {
  if (v.m == null) return [ymd(v.y, 1, 1), ymd(v.y, 12, 31)];
  if (v.d == null) return [ymd(v.y, v.m, 1), lastOfMonth(ymd(v.y, v.m, 1))];
  return [ymd(v.y, v.m, v.d), ymd(v.y, v.m, v.d)];
};

function periodOf(text, def = 'month', today = todayIst(), opts = {}) {
  const t = ` ${String(text || '')} `;
  const cy = Number(today.slice(0, 4)); const cm = Number(today.slice(5, 7)); const cd = Number(today.slice(8, 10));
  let key = null; let n = null; let from = null; let to = null;
  const ms = mentionsOf(t);
  const guessYear = (v) => {
    if (v.y != null) return v;
    const later = v.m > cm || (v.m === cm && v.d != null && v.d > cd);
    const earlier = v.m < cm || (v.m === cm && v.d != null && v.d < cd);
    return { ...v, y: opts.future ? (earlier ? cy + 1 : cy) : (later ? cy - 1 : cy) };
  };
  if (ms.length >= 2) {
    let [a, b] = ms;
    if (a.y == null && b.y == null) { b = guessYear(b); a = { ...a, y: a.m <= b.m ? b.y : b.y - 1 }; } else if (b.y == null) b = { ...b, y: b.m >= a.m ? a.y : a.y + 1 }; else if (a.y == null) a = { ...a, y: a.m <= b.m ? b.y : b.y - 1 };
    from = spanOf(a)[0]; to = spanOf(b)[1];
    if (from > to) [from, to] = [spanOf(b)[0], spanOf(a)[1]];
    key = 'range';
  } else if (ms.length >= 1) {
    const v = guessYear(ms[0]);
    const [s, e] = spanOf(v);
    const before = t.slice(Math.max(0, v.start - 10), v.start); const after = t.slice(v.end, v.end + 12);
    if (/\b(since|from|after)\s*$/.test(before) || /^\s*(nundi|nunchi|onwards|onward)\b/.test(after)) { from = /\bafter\s*$/.test(before) ? addDays(e, 1) : s; to = today; key = 'range'; } else if (/\bbefore\s*$/.test(before)) { from = ALL_FROM; to = addDays(s, -1); key = 'range'; } else if (/\b(till|until|upto|up to|by)\s*$/.test(before) || /^\s*(varaku|daaka|varuku)\b/.test(after)) { from = ALL_FROM; to = e; key = 'range'; } else { from = s; to = e; key = 'range'; }
  } else {
    const back = t.match(/\b(?:last|past|previous|gatha|poyina)\s+(\d{1,3})\s*(days?|weeks?|months?|years?|rojulu|rojullo|nelalu|nelallo|varalu)\b/);
    const ahead = t.match(/\b(?:next|within|in|coming|upcoming|raabooye)\s+(\d{1,3})\s*(?:days?|rojul?(?:u|lo)?)\b/) || t.match(/\b(\d{1,3})\s*(?:days?|rojul?(?:u|lo)?)\b/);
    if (/\btoday\b/.test(t)) key = 'today';
    else if (/\btomorrow\b/.test(t)) key = 'tomorrow';
    else if (/\byesterday\b/.test(t)) key = 'yesterday';
    else if (back) {
      const k = Number(back[1]); const u = back[2];
      key = 'range'; to = today;
      if (/^(day|rojul)/.test(u)) from = addDays(today, -(k - 1));
      else if (/^(week|varal)/.test(u)) from = addDays(today, -(7 * k - 1));
      else if (/^(month|nelal)/.test(u)) { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - k); from = addDays(d.toISOString().slice(0, 10), 1); } else from = ymd(cy - k, cm, Math.min(cd, 28));
    } else if (/\bnext week\b/.test(t)) key = 'nextweek';
    else if (/\blast week\b|\bprevious week\b/.test(t)) key = 'lastweek';
    else if (/\bthis week\b|\bweek\b|\bweekly\b/.test(t)) key = 'week';
    else if (/\blast month\b|\bprevious month\b/.test(t)) key = 'lastmonth';
    else if (/\bnext month\b/.test(t)) key = 'nextmonth';
    else if (/\bthis month\b|\bmonth\b/.test(t) && !(/\bmonth[\s-]?(by|wise)\b|\bmonthly\b|\bper month\b|\bevery month\b/.test(t) && !/\bthis month\b/.test(t))) key = 'month';
    else if (/\blast year\b|\bprevious year\b/.test(t)) key = 'lastyear';
    else if (/\bthis year\b|\bcurrent year\b/.test(t)) key = 'year';
    else if (ahead) { key = 'days'; n = Math.min(Number(ahead[1]), 365); }
    else if (/\b(till now|till date|to date|so far|all time|alltime|ever|overall|total|totally|lifetime|altogether|since (the )?(beginning|start)|from (the )?(beginning|start))\b/.test(t)) key = 'all';
  }
  const named = !!key;
  if (!key) key = def;
  switch (key) {
    case 'range': break;
    case 'all': from = ALL_FROM; to = today; break;
    case 'today': from = today; to = today; break;
    case 'tomorrow': from = addDays(today, 1); to = from; break;
    case 'yesterday': from = addDays(today, -1); to = from; break;
    case 'week': from = mondayOf(today); to = addDays(from, 6); break;
    case 'nextweek': from = addDays(mondayOf(today), 7); to = addDays(from, 6); break;
    case 'lastweek': from = addDays(mondayOf(today), -7); to = addDays(from, 6); break;
    case 'lastmonth': { const l = addDays(`${today.slice(0, 7)}-01`, -1); from = `${l.slice(0, 7)}-01`; to = l; break; }
    case 'nextmonth': { const f = addDays(lastOfMonth(today), 1); from = f; to = lastOfMonth(f); break; }
    case 'year': from = `${cy}-01-01`; to = `${cy}-12-31`; break;
    case 'lastyear': from = `${cy - 1}-01-01`; to = `${cy - 1}-12-31`; break;
    case 'next7': from = today; to = addDays(today, 6); break;
    case 'days': if (n == null) n = 30; from = today; to = addDays(today, n); break;
    case 'upcoming': from = today; to = '9999-12-31'; break;
    default: key = 'month'; from = `${today.slice(0, 7)}-01`; to = lastOfMonth(today);
  }
  const label = (lang) => {
    if (key === 'all') return say(lang, { en: `All time (till ${dmy(to)})`, tl: `Ippati varaku (${dmy(to)} varaku)`, te: `ఇప్పటి వరకు (${dmy(to)} వరకు)` });
    if (key === 'days') return say(lang, { en: `Next ${n} days (${dm(from)} - ${dm(to)})`, tl: `Next ${n} rojullo (${dm(from)} - ${dm(to)})`, te: `రాబోయే ${n} రోజుల్లో (${dm(from)} - ${dm(to)})` });
    if (key === 'upcoming') return say(lang, PERIOD_WORDS.upcoming);
    if (key === 'range') return rangeText(from, to);
    const w = say(lang, PERIOD_WORDS[key]);
    if (['week', 'nextweek', 'lastweek', 'next7'].includes(key)) return `${w} (${dm(from)} - ${dm(to)})`;
    if (['month', 'lastmonth', 'nextmonth'].includes(key)) return `${w} (${monthLabel(from)})`;
    if (['year', 'lastyear'].includes(key)) return `${w} (${from.slice(0, 4)})`;
    return `${w} (${dm(from)})`;
  };
  return { key, from, to, n, label, named, all: key === 'all' || from === ALL_FROM };
}
// "Nov 2026", "Jan 2026 - Nov 2026", "2026", "15 Jan 2026", "1 Jan 2026 - 15 Mar 2026", "Till 30 Nov 2026"
function rangeText(from, to) {
  if (from === ALL_FROM) return `Till ${dmy(to)}`;
  if (from === to) return dmy(from);
  const wholeFrom = from.slice(8) === '01'; const wholeTo = to === lastOfMonth(to);
  if (wholeFrom && wholeTo) {
    if (from.slice(0, 7) === to.slice(0, 7)) return monthLabel(from);
    if (from.slice(5) === '01-01' && to.slice(5) === '12-31' && from.slice(0, 4) === to.slice(0, 4)) return from.slice(0, 4);
    return `${monthLabel(from)} - ${monthLabel(to)}`;
  }
  return `${dmy(from)} - ${dmy(to)}`;
}

module.exports = {
  langOf, normalize, periodOf, rangeText, ALL_FROM, say, todayIst, addDays, daysBetween, dm, dmy, monthLabel, lastOfMonth, mondayOf, startOf, endOf, istDay, timeOf, TELUGU,
};
