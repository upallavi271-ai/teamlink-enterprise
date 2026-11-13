'use strict';
// ---------------------------------------------------------------------------
// TIME INTERVAL of a person-day (founder 2026-11-13: "attendance lo HR manual check-in ichina kuda malli biometric employee vestey adhi
// interval laga teesukovali ... time interval column okkati add chey ... anni saarlu vesina adhi record avali").
//
// DISPLAY ONLY. Nothing here changes a stored punch, the day's check-in / check-out, its status, or anything payroll reads
// (utils/attendanceDays.js and utils/attendanceMath.js stay the one rule for those).
//
// EVERY TIME IS LISTED, once, in clock order: every stored punch of every source (device, web / phone, typed by HR, the imported
// old-HRMS log) plus the check-in / check-out times HR (or the Super Admin) set in Marked attendance. Those HR times STAND over the
// punches for the day (Attendance.timesSetBy, utils/attendanceDays.js), and they are often not punches at all, so they are added here
// as "Set by HR" entries unless a punch already carries the same minute.
//
// WHICH ENTRY IS WHAT
//   check-in    the day's check-in: HR's time when HR set it, else the first check-in punch (the punch log's "First in")
//   check-out   the day's check-out: HR's time when HR set it, else the last pressed check-out ("Last out")
//   interval    every other time between them: the person punched again, so it is an interval, whoever checked them in
//               (a manual HR check-in does not stop a later device punch counting)
//   extra       a time outside check-in .. check-out (before the first in, after the last out) or on a day with no check-in:
//               listed, never paired, never made into a check-in or a check-out
//
// INTERVALS are the interval times taken two at a time, the old HRMS convention for the times between the first and the last
// ("the times in between alternate, starting with a check-out", routes/attendance.js displayPunches): out -> back, with the minutes
// away. A time left over has no return recorded - it is shown as such, never guessed. No check-out is ever inferred.
// ---------------------------------------------------------------------------

const hhmm = (t) => (t ? String(t).slice(0, 5) : null);
function secsOf(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(t || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
}

// rawPunches: PSRC.rawPunchList() items ({ id, time, direction, source, sourceLabel, group })
// record:     the Attendance row of the day ({ checkIn, checkOut, timesSetBy }) or null
// firstInTime / lastOutTime: the punch log row's own First in / Last out (punch based)
function build({
  rawPunches = [], record = null, firstInTime = null, lastOutTime = null,
}) {
  const hrSet = !!(record && record.timesSetBy);
  const hrIn = hrSet && record.checkIn ? hhmm(record.checkIn) : null;
  const hrOut = hrSet && record.checkOut ? hhmm(record.checkOut) : null;

  const entries = (rawPunches || []).map((p) => ({
    id: p.id || null,
    time: String(p.time || '').slice(0, 8),
    direction: p.direction === 'Out' ? 'Out' : 'In',
    source: p.source,
    from: p.sourceLabel || p.from || '',
    group: p.group || null,
  })).filter((e) => secsOf(e.time) != null);
  [['In', hrIn], ['Out', hrOut]].forEach(([direction, t]) => {
    if (t && !entries.some((e) => e.time.slice(0, 5) === t)) {
      entries.push({ id: null, time: `${t}:00`, direction, source: 'hr', from: 'Set by HR', group: 'hr', hrSet: true });
    }
  });
  entries.sort((a, b) => secsOf(a.time) - secsOf(b.time));

  const dayIn = hrIn || hhmm(firstInTime);
  const dayOut = hrOut || hhmm(lastOutTime);
  const inIdx = dayIn ? entries.findIndex((e) => e.time.slice(0, 5) === dayIn) : -1;
  let outIdx = -1;
  if (dayOut) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].time.slice(0, 5) === dayOut && i !== inIdx) { outIdx = i; break; }
    }
  }
  entries.forEach((e, i) => {
    if (i === inIdx) e.kind = 'checkin';
    else if (i === outIdx) e.kind = 'checkout';
    else if (inIdx === -1) e.kind = 'extra';
    else if (i < inIdx || (outIdx !== -1 && i > outIdx)) e.kind = 'extra';
    else e.kind = 'interval';
  });

  const between = entries.filter((e) => e.kind === 'interval');
  const intervals = [];
  for (let i = 0; i < between.length; i += 2) {
    const from = between[i];
    const to = between[i + 1] || null;
    // whole minutes between the times as they read on screen (HH:MM, seconds dropped), so 13:30 -> 13:58 is 28 min, never 29
    const minutes = to ? Math.max(0, Math.floor(secsOf(to.time) / 60) - Math.floor(secsOf(from.time) / 60)) : null;
    intervals.push({ from: from.time, to: to ? to.time : null, minutes, fromSource: from.from, toSource: to ? to.from : null });
  }
  return {
    entries,
    hrSet,
    dayIn,
    dayOut,
    intervals,
    intervalCount: between.length,
    intervalMinutes: intervals.reduce((n, x) => n + (x.minutes || 0), 0),
  };
}

const minutesText = (m) => {
  if (m == null) return '';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h}h ${String(r).padStart(2, '0')}m` : `${r} min`;
};

// "13:05 → 14:02 (57 min); 16:00 → no return" for the Excel / CSV export.
function intervalsText(intervals) {
  return (intervals || []).map((x) => `${hhmm(x.from)} → ${x.to ? `${hhmm(x.to)}${x.minutes != null ? ` (${minutesText(x.minutes)})` : ''}` : 'no return recorded'}`).join('; ');
}

module.exports = { build, intervalsText, minutesText };
