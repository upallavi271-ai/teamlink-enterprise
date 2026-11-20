// ---------------------------------------------------------------------------
// THE DATE A PERSON REALLY CAME, READ FROM A SHEET CELL (founder 2026-11-20: "the candidates' data is already with me; when I add them to the
// ATS the present date shows, not the date on which the candidate actually came").
//
// parseCameDate(raw) reads whatever a person types or Excel hands over and answers ONE of
//   { ok: true,  day: 'YYYY-MM-DD' (IST day), at: Date, hasTime: bool }
//   { ok: false, reason: 'bad' | 'future' | 'old', message }
//   { ok: null }                                  the cell is empty (no date was given)
//
// Read: 12/03/2026  12-03-2026  12.03.2026  2026-03-12  2026/03/12  12 Mar 2026  12-Mar-26  12th March, 2026  Mar 12, 2026
//       Excel serial numbers (45000, 45000.5), JS Date cells, text with a time ("12/03/2026 14:30", "2026-03-12T09:15:00+05:30", "2:30 pm"),
//       two-digit years (12-03-26 = 2026), yyyymmdd (20260312), epoch seconds / milliseconds (a "Timestamp" column).
// INDIAN DAY-FIRST by default: 03/04/2026 is 3 April. Month-first is used only when day-first is impossible (03/25/2026).
// Refused, with the reason: not a date, a date in the future (after today in IST), a date before 2000.
// TIME OF DAY IS NOT GUESSED: a cell with no time is 00:00 IST; a cell with a time keeps it.
// ---------------------------------------------------------------------------
const { istDay } = require('./nextAction');

const MIN_YEAR = 2000;
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const pad = (n) => String(n).padStart(2, '0');
const realDate = (y, m, d) => {
  if (!(y >= 1900 && y <= 2999) || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const fullYear = (yy, digits) => (digits === 2 ? (yy <= 69 ? 2000 + yy : 1900 + yy) : yy);

// "14:30", "2:30 pm", "09:15:00" -> 'HH:MM' or null
function timeIn(text) {
  const m = /(?:^|[\sT,])(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(text);
  if (!m) return { time: null, rest: text };
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return { time: null, rest: text, bad: true };
    h = (h % 12) + (/^p/i.test(m[3]) ? 12 : 0);
  }
  if (h > 23 || min > 59) return { time: null, rest: text, bad: true };
  return { time: `${pad(h)}:${pad(min)}`, rest: text.replace(m[0], ' ') };
}

// A date part (no time) -> { y, m, d } or null
function dayPart(text) {
  let s = text.replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?\b\.?,?/gi, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/\bof\b/gi, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let m;
  // 2026-03-12 / 2026/03/12 / 2026.03.12
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) return { y: +m[1], m: +m[2], d: +m[3] };
  // 20260312
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return { y: +m[1], m: +m[2], d: +m[3] };
  // 12/03/2026, 12-03-26, 12.03.2026 (day first; month first only when day first is impossible)
  if ((m = /^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2}|\d{4})$/.exec(s))) {
    const a = +m[1]; const b = +m[2]; const y = fullYear(+m[3], m[3].length);
    if (realDate(y, b, a)) return { y, m: b, d: a };
    if (realDate(y, a, b)) return { y, m: a, d: b };
    return { y, m: b, d: a, invalid: true };
  }
  // 12 Mar 2026, 12-Mar-26, 12/Mar/2026
  if ((m = /^(\d{1,2})[-/.\s]*([a-z]{3,9})\.?[-/.\s]*(\d{2}|\d{4})$/i.exec(s)) && MONTHS[m[2].toLowerCase()]) {
    return { y: fullYear(+m[3], m[3].length), m: MONTHS[m[2].toLowerCase()], d: +m[1] };
  }
  // Mar 12 2026, March 12, 2026
  if ((m = /^([a-z]{3,9})\.?[-/.\s]*(\d{1,2})[-/.\s]+(\d{2}|\d{4})$/i.exec(s)) && MONTHS[m[1].toLowerCase()]) {
    return { y: fullYear(+m[3], m[3].length), m: MONTHS[m[1].toLowerCase()], d: +m[2] };
  }
  return null;
}

const atIst = (day, time) => new Date(`${day}T${time || '00:00'}:00+05:30`);

function judge(day, time, now) {
  const [y] = day.split('-').map(Number);
  if (y < MIN_YEAR) return { ok: false, reason: 'old', message: `${day.split('-').reverse().join('-')} is before the year ${MIN_YEAR} — check the date` };
  const at = atIst(day, time);
  const today = istDay(now);
  if (day > today) return { ok: false, reason: 'future', message: `${day.split('-').reverse().join('-')} is in the future — a person cannot have come on a day that has not happened` };
  return { ok: true, day, at, hasTime: !!time };
}

function parseCameDate(raw, { now = Date.now() } = {}) {
  if (raw === null || raw === undefined) return { ok: null };
  let v = raw;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (v.result !== undefined) v = v.result; else if (v.text !== undefined) v = v.text; else return { ok: null };
  }
  if (typeof v === 'string') {
    v = v.trim();
    if (!v || /^(-|--|n\/?a|na|nil|null|none|not known|unknown)$/i.test(v)) return { ok: null };
  }
  if (v === '') return { ok: null };

  // a JS Date cell: a pure UTC midnight is "that date"; anything else is an instant
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { ok: false, reason: 'bad', message: 'not a date I can read' };
    const midnight = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
    if (midnight) return judge(`${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`, null, now);
    const day = istDay(v);
    const r = judge(day, null, now);
    if (r.ok) { r.at = v; r.hasTime = true; }
    return r;
  }

  const shown = () => (typeof raw === 'string' ? `"${raw.trim().slice(0, 40)}"` : String(raw));
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return { ok: false, reason: 'bad', message: `${shown()} is not a date I can read` };
    // epoch milliseconds / seconds ("Timestamp" columns)
    if (v >= 1e12 && v < 1e14) { const d = new Date(v); const day = istDay(d); const r = judge(day, null, now); if (r.ok) { r.at = d; r.hasTime = true; } return r; }
    if (v >= 9.5e8 && v < 1e11 && Number.isInteger(v) && String(Math.trunc(v)).length === 10) { const d = new Date(v * 1000); const day = istDay(d); const r = judge(day, null, now); if (r.ok) { r.at = d; r.hasTime = true; } return r; }
    // yyyymmdd
    if (Number.isInteger(v) && v >= 19000101 && v <= 29991231) {
      const p = dayPart(String(v));
      if (p && realDate(p.y, p.m, p.d)) return judge(`${p.y}-${pad(p.m)}-${pad(p.d)}`, null, now);
    }
    // Excel serial (days since 1899-12-30; the fraction is the time of day)
    if (v < 2958466) {
      const whole = Math.floor(v);
      const ms = Math.round((whole - 25569) * 86400000);
      const d = new Date(ms);
      const frac = v - whole;
      let time = null;
      if (frac > 0.0001) { const mins = Math.round(frac * 1440); time = `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`; }
      return judge(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time, now);
    }
    return { ok: false, reason: 'bad', message: `${shown()} is not a date I can read` };
  }

  let text = String(v).trim();
  // a number typed as text: 45000 or 45000.5 is an Excel serial; 20260312 is yyyymmdd
  if (/^\d+(\.\d+)?$/.test(text) && !/^\d{4}$/.test(text) && text.length !== 8) return parseCameDate(Number(text), { now });
  if (/^\d{8}$/.test(text)) return parseCameDate(Number(text), { now });
  // ISO with a zone: the exact instant
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(text);
  if (iso) {
    const t = new Date(text.replace(' ', 'T').replace(/\s+/g, '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (!Number.isNaN(t.getTime())) {
      const r = judge(istDay(t), null, now);
      if (r.ok) { r.at = t; r.hasTime = true; }
      return r;
    }
  }
  const { time, rest, bad } = timeIn(text);
  if (bad) return { ok: false, reason: 'bad', message: `${shown()} has a time I cannot read` };
  text = rest.replace(/\bT\b/g, ' ').replace(/\s+/g, ' ').trim();
  const p = dayPart(text);
  if (!p || p.invalid || !realDate(p.y, p.m, p.d)) {
    return { ok: false, reason: 'bad', message: `${shown()} is not a date I can read — use DD-MM-YYYY (for example 12-03-2026)` };
  }
  return judge(`${p.y}-${pad(p.m)}-${pad(p.d)}`, time, now);
}

// The one date typed in the dialog (a date picker gives YYYY-MM-DD). Throws a plain message when it cannot be used.
function oneDateOf(value, opts) {
  const r = parseCameDate(value, opts);
  if (r.ok === null) throw new Error('Pick the date these people came on.');
  if (!r.ok) throw new Error(r.message);
  return r;
}

module.exports = { parseCameDate, oneDateOf, MIN_YEAR };
