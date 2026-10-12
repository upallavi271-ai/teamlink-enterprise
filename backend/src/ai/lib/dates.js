// ---------------------------------------------------------------------------
// Dates and times typed (or spoken) in plain words:
//   "tomorrow 3pm", "next Monday", "on 15 Oct", "15/10", "2026-10-15",
//   "day after tomorrow at 4:30 pm", "in 3 days", and the Telugu / Hindi
//   words for today / tomorrow / yesterday ("repu", "ee roju", "kal", "aaj").
// Everything is worked out by the SERVER from its own clock, never by a model.
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';

const pad = (n) => String(n).padStart(2, '0');
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(base, n) { return new Date(base.getFullYear(), base.getMonth(), base.getDate() + n); }
function isReal(y, m, d) {
  const x = new Date(y, m - 1, d);
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d;
}
function monthIndex(word) { return MONTHS.indexOf(String(word).slice(0, 3).toLowerCase()); }

// Telugu / Hindi (Roman script) day words -> English, so one parser serves all.
const DATE_WORDS = [
  [/\bee\s*roju\b|\beeroju\b|\bivala\b|\baaj\b|\bindhu\b/gi, 'today'],
  [/\brepu\b|\brapu\b|\bkal\b/gi, 'tomorrow'],
  [/\bellundi\b|\bparso\b|\bparson\b/gi, 'day after tomorrow'],
  [/\bninna\b|\bnenne\b/gi, 'yesterday'],
];
function translateDateWords(text) {
  let s = String(text || '');
  DATE_WORDS.forEach(([re, en]) => { s = s.replace(re, en); });
  return s;
}

// Build a Date for day/month with an optional year; a bare day/month that is
// well in the past means next year's.
function resolveDayMonth(day, month, year, now) {
  const base = now || new Date();
  let y = year ? Number(year) : base.getFullYear();
  if (year && String(year).length === 2) y += 2000;
  if (!isReal(y, month, day)) return null;
  let d = new Date(y, month - 1, day);
  if (!year && d < addDays(base, -30)) {
    y += 1;
    if (!isReal(y, month, day)) return null;
    d = new Date(y, month - 1, day);
  }
  return d;
}

function weekdayDate(idx, now, { prefix = '', dir = 'future' } = {}) {
  const base = now || new Date();
  const today = base.getDay();
  const back = prefix === 'last' || prefix === 'previous' || (dir === 'past' && !['next', 'coming', 'this'].includes(prefix));
  if (back) return addDays(base, -(((today - idx) + 7) % 7 || 7));
  let diff = ((idx - today) + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(base, diff);
}

function to24(h, min, ap) {
  let hour = Number(h);
  const m = Number(min || 0);
  if (ap) {
    const a = ap.toLowerCase();
    if (a === 'pm' && hour < 12) hour += 12;
    if (a === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || m > 59) return null;
  return `${pad(hour)}:${pad(m)}`;
}

// Parse every date / time phrase in `text`.
//   -> { dates: ['YYYY-MM-DD', ...] in the order they were written,
//        time: 'HH:MM' | null, times: [...], rest: text with the matched words
//        blanked out, found: ['tomorrow', '3pm', ...] }
function parseWhen(text, { now = new Date(), dir = 'future' } = {}) {
  let s = translateDateWords(text);
  const hits = []; // { at, date }
  const found = [];
  const times = [];

  function take(re, fn) {
    s = s.replace(re, (...args) => {
      const at = args[args.length - 2];
      const groups = args.slice(0, args.length - 2);
      const out = fn(groups, at);
      if (!out) return args[0];
      found.push(String(args[0]).trim());
      if (out.date) hits.push({ at, date: out.date });
      if (out.time) times.push({ at, time: out.time });
      return ' '.repeat(String(args[0]).length);
    });
  }

  // 2026-10-15
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => (isReal(+m[1], +m[2], +m[3]) ? { date: ymd(new Date(+m[1], +m[2] - 1, +m[3])) } : null));
  // 15th oct 2026 / 15 oct / 15th of october
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_RE}\\b(?:[,\\s]+(\\d{4}))?`, 'gi'), (m) => {
    const d = resolveDayMonth(+m[1], monthIndex(m[2]) + 1, m[3], now);
    return d ? { date: ymd(d) } : null;
  });
  // oct 15 / october 15th 2026
  take(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:[,\\s]+(\\d{4}))?`, 'gi'), (m) => {
    const d = resolveDayMonth(+m[2], monthIndex(m[1]) + 1, m[3], now);
    return d ? { date: ymd(d) } : null;
  });
  // 15/10/2026, 15-10-26, 15/10  (day first, as in India)
  take(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g, (m) => {
    const d = resolveDayMonth(+m[1], +m[2], m[3], now);
    return d ? { date: ymd(d) } : null;
  });
  // in 3 days / after 2 days
  take(/\b(?:in|after)\s+(\d{1,2})\s+days?\b/gi, (m) => ({ date: ymd(addDays(now, Number(m[1]))) }));
  // relative words
  take(/\bday after tomorrow\b/gi, () => ({ date: ymd(addDays(now, 2)) }));
  take(/\bday before yesterday\b/gi, () => ({ date: ymd(addDays(now, -2)) }));
  take(/\btomorrow\b/gi, () => ({ date: ymd(addDays(now, 1)) }));
  take(/\byesterday\b/gi, () => ({ date: ymd(addDays(now, -1)) }));
  take(/\b(?:today|tonight)\b/gi, () => ({ date: ymd(now) }));
  // next / this / coming / last Monday, or a bare "Monday" / "on Monday"
  take(new RegExp(`\\b(?:(next|this|coming|last|previous|on)\\s+)?${DAY_RE}\\b`, 'gi'), (m) => {
    const idx = DAYS.findIndex((d) => d.startsWith(m[2].slice(0, 3).toLowerCase()));
    if (idx < 0) return null;
    return { date: ymd(weekdayDate(idx, now, { prefix: (m[1] || '').toLowerCase(), dir })) };
  });

  // Times. "3:30 pm", "3.30pm", "15:00", "3pm"
  take(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)\b/gi, (m) => ({ time: to24(m[1], m[2], m[3]) }));
  take(/\b(\d{1,2})\s*(am|pm)\b/gi, (m) => ({ time: to24(m[1], 0, m[2]) }));
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (m) => ({ time: to24(m[1], m[2]) }));
  take(/\bat\s+(\d{1,2})[.:]([0-5]\d)\b/gi, (m) => ({ time: to24(m[1], m[2]) }));
  take(/\bnoon\b/gi, () => ({ time: '12:00' }));
  // Telugu / Hindi "10 gantalaku" / "3 baje" (o'clock)
  take(/\b(\d{1,2})\s*(?:gantalaku|gantaki|gantala|ghantelu|baje)\b/gi, (m) => {
    const h = Number(m[1]);
    if (!(h >= 1 && h <= 12)) return null;
    return { time: to24(h >= 1 && h <= 7 ? h + 12 : h, 0) };
  });
  // A bare "at 3" / "3 o'clock": 1-7 means the afternoon, 8-11 the morning.
  take(/\b(?:at\s+(\d{1,2})|(\d{1,2})\s*o'?clock)\b(?!\s*(?:am|pm|:|\.))/gi, (m) => {
    const h = Number(m[1] || m[2]);
    if (!(h >= 1 && h <= 12)) return null;
    return { time: to24(h >= 1 && h <= 7 ? h + 12 : h, 0) };
  });

  hits.sort((a, b) => a.at - b.at);
  times.sort((a, b) => a.at - b.at);
  return {
    dates: [...new Set(hits.map((h) => h.date))],
    time: times.length ? times[0].time : null,
    times: times.map((t) => t.time),
    rest: s,
    found,
  };
}

function daysBetween(a, b) {
  const x = new Date(`${a}T00:00:00`);
  const y = new Date(`${b}T00:00:00`);
  return Math.round((y - x) / 86400000);
}

function niceDate(date) {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00`);
  const wd = DAYS[d.getDay()].slice(0, 3).replace(/^./, (c) => c.toUpperCase());
  return `${wd} ${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getFullYear()}`;
}

function niceTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ap}`;
}

function isRealDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && isReal(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));
}

module.exports = {
  parseWhen, translateDateWords, ymd, addDays, daysBetween, niceDate, niceTime, isRealDate,
};
