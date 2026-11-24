'use strict';
// ---------------------------------------------------------------------------
// TOTAL WORKING TIME of a person-day (founder 2026-11-24: "total working time column kuda add chey", Attendance Dashboard day list).
//
// FIRST CHECK-IN TO LAST CHECK-OUT, AS ONE BLOCK OF TIME (founder, same day: "dont mention break time; the check-ins and check-outs in
// between, consider that timing as the total working time"). A check-out followed by a later check-in inside the day is NOT taken off and
// NOT shown: the whole time from the first check-in to the last check-out counts. (The Biometric list's "Total Time Worked" is a different
// column with its own break rule, and is left as it was.) Whole minutes as the times read on screen (seconds dropped, like
// utils/punchIntervals.js), so 09:00:50 -> 09:01:10 is 1 min.
//
// DISPLAY ONLY. Nothing here changes a stored punch, the day's status or anything payroll reads. A day with no check-in or no check-out
// (or a check-out before the check-in) has no total: the screen shows a dash, a time is never guessed.
// ---------------------------------------------------------------------------
const secsOf = (t) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(t || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
};
const mins = (s) => Math.floor(s / 60);

// day: { checkIn, checkOut }  ->  { workedMinutes } | null   (the punch list is not needed: nothing in between is taken off)
function workedOfDay(day) {
  const ci = secsOf(day && day.checkIn);
  const co = secsOf(day && day.checkOut);
  if (ci == null || co == null || co < ci) return null;
  return { workedMinutes: mins(co) - mins(ci) };
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
  return w ? { workedMinutes: w.workedMinutes, workedText: text(w.workedMinutes) } : { workedMinutes: null, workedText: '' };
}

module.exports = { workedOfDay, fieldsOf, text };
