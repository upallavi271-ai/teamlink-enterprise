'use strict';
// ---------------------------------------------------------------------------
// TOTAL WORKING TIME of a person-day (founder 2026-11-24: "total working time column kuda add chey", Attendance Dashboard day list).
//
// First check-in to last check-out, minus every break in between (a check-out followed by the next check-in): the SAME rule as
// "Total Time Worked" in the Biometric list (routes/attendance.js reportDay: Total Hours - Total Time In Break). Whole minutes as the
// times read on screen (seconds dropped, like utils/punchIntervals.js), so 13:30 -> 13:58 is 28 min, never 29.
//
// DISPLAY ONLY. Nothing here changes a stored punch, the day's status or anything payroll reads. A day with no check-in or no check-out
// (or a check-out before the check-in) has no total: the screen shows a dash, a time is never guessed.
// ---------------------------------------------------------------------------
const secsOf = (t) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(t || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
};
const mins = (s) => Math.floor(s / 60);

// day: { checkIn, checkOut, punchList: [{ time, direction }] }  ->  { spanMinutes, breakMinutes, workedMinutes } | null
function workedOfDay(day) {
  const ci = secsOf(day && day.checkIn);
  const co = secsOf(day && day.checkOut);
  if (ci == null || co == null || co < ci) return null;
  const seq = ((day && day.punchList) || [])
    .map((p) => ({ s: secsOf(p.time), dir: p.direction }))
    .filter((p) => p.s != null && p.s >= ci && p.s <= co)
    .sort((a, b) => a.s - b.s);
  let breakMinutes = 0;
  for (let i = 0; i < seq.length - 1; i += 1) {
    if (seq[i].dir === 'Out' && seq[i + 1].dir !== 'Out') breakMinutes += mins(seq[i + 1].s) - mins(seq[i].s);
  }
  const spanMinutes = mins(co) - mins(ci);
  return { spanMinutes, breakMinutes, workedMinutes: Math.max(0, spanMinutes - breakMinutes) };
}

// "6h 47m" / "35 min": the same wording as the punch log's time-away text.
const text = (m) => {
  if (m == null) return '';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h}h ${String(r).padStart(2, '0')}m` : `${r} min`;
};

// the fields a report row carries
function fieldsOf(day) {
  const w = workedOfDay(day);
  return w
    ? { workedMinutes: w.workedMinutes, breakMinutes: w.breakMinutes, spanMinutes: w.spanMinutes, workedText: text(w.workedMinutes) }
    : { workedMinutes: null, breakMinutes: 0, spanMinutes: null, workedText: '' };
}

module.exports = { workedOfDay, fieldsOf, text };
