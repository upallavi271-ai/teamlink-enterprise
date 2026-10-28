// ---------------------------------------------------------------------------
// PAST ATTENDANCE IMPORT — the old HRMS's (PulseHRM) CSV exports.
//
//   * "First Check-In & Last Check-Out report"  one row per employee per day
//   * "Bio-metric logs"                          every punch time of the day
//   * "Attendance summary"                       totals for the period
//
// RULES (from the user, binding):
//   * Employee ID is the only matching key. Name, Department, Designation,
//     Role and Team always come from Employee Management — the file's
//     department / designation are never read into TeamLink.
//   * Historical values are stored exactly as exported (AttendanceHistory,
//     AttendanceHistorySummary). Nothing is recalculated or "corrected".
//   * Existing TeamLink attendance is never changed: an existing day keeps its
//     status; only an EMPTY check-in / check-out is filled in. A day TeamLink
//     marks Absent / Leave is left alone and reported as a conflict.
//   * An Employee ID not in Employee Management is stored as
//     "Unmatched Employee" and nothing is created for it. Re-running the
//     import after the employee is added applies those rows then.
//   * Re-running never duplicates: a day already imported is skipped —
//     UNLESS the new file knows more about it (2026-10-28, founder: "Oct 11 to
//     today some records are there, some are not"). A morning export imported
//     first, then the full-day file, used to be skipped as "Already imported",
//     so the evening check-out never arrived. Now that day is UPDATED: the
//     earlier first check-in / later last check-out / extra punch times are
//     merged in, an empty time is filled, and a check-out that the earlier
//     import itself wrote moves to the later one. Times HR or the Super Admin
//     set by hand, and days marked Absent / Leave, still stand.
//
// WHAT A MATCHED DAY BECOMES IN TEAMLINK
//   * First Check In  -> an AttendancePunch "In"  (exact HH:MM:SS kept)
//   * Last Check Out  -> an AttendancePunch "Out" (only if the file has one)
//   * Attendance day  -> created as Present with those times if TeamLink has
//                        no record for the day; otherwise blanks filled only.
//   The other punch times from the bio-metric log carry no check-in/check-out
//   direction in the export, so they are NOT turned into check-ins or
//   check-outs; they are kept in AttendanceHistory.punchTimes and shown on the
//   Punch Log as the imported punch times.
// ---------------------------------------------------------------------------

const prisma = require('../db');

const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const SOURCE = 'PulseHRM import';
const EDITABLE_STATUSES = new Set(['Present', 'Half Day', 'Late']);

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return { head: [], rows: [] };
  const head = rows[0].map((h) => h.trim());
  const body = rows.slice(1).filter((r) => r.some((x) => String(x).trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] || '').trim()])));
  return { head, rows: body };
}

function detectKind(head) {
  const h = head.map((x) => x.toLowerCase());
  if (h.includes('first check in') && h.includes('last check out')) return 'report';
  if (h.includes('time interval') && h.includes('attendance date')) return 'logs';
  if (h.some((x) => x.startsWith('payable days')) && h.includes('present')) return 'summary';
  return null;
}

// 13-APR-2026 -> 2026-04-13 (also accepts 2026-04-13 and 13/04/2026).
function isoDate(s) {
  const v = String(s || '').trim().toUpperCase();
  let m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/.exec(v);
  if (m && MON[m[2]]) return `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return v;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
// "9:05:07" -> "09:05:07". The value is otherwise kept as exported.
function clock(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}${m[3] !== undefined ? `:${m[3]}` : ''}` : null;
}
const hhmm = (t) => (t ? t.slice(0, 5) : null);
const duration = (t) => { const v = String(t || '').trim(); return v && v !== '::' ? v : null; };
const num = (v) => { const n = Number(String(v || '').trim()); return String(v || '').trim() === '' || Number.isNaN(n) ? null : n; };
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim() || null;

// "01-jan-2026_to_01-sep-2026" in a file name -> the summary period.
function periodFromName(name) {
  const m = /(\d{2}-[a-z]{3}-\d{4})_to_(\d{2}-[a-z]{3}-\d{4})/i.exec(String(name || ''));
  return m ? { from: isoDate(m[1]), to: isoDate(m[2]) } : null;
}

// files: [{ name, text }] -> parsed, per kind, with anything unusable listed.
function readFiles(files) {
  const out = { report: null, logs: null, summary: null, unknown: [], problems: [] };
  for (const f of files || []) {
    const { head, rows } = parseCsv(f.text);
    const kind = detectKind(head);
    if (!kind) { out.unknown.push(f.name); continue; }
    if (out[kind]) { out.problems.push(`Two ${kind} files were given (${out[kind].name}, ${f.name}); only the first is used.`); continue; }
    out[kind] = { name: f.name, rows };
  }
  return out;
}

// A day imported before + what this file says about it. null = the file adds
// nothing; else { day: merged values, what: "later check-out 18:10, 4 more
// punch times" }. Merge = the earlier first check-in, the later last
// check-out, every punch time once; totals / location from this file when it
// has them.
const secsOf = (t) => { const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '')); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null; };
function mergeDay(prev, d) {
  const what = [];
  const fin = [prev.firstCheckIn, d.firstCheckIn].filter((t) => secsOf(t) != null).sort((a, b) => secsOf(a) - secsOf(b))[0] || null;
  if (fin && fin !== prev.firstCheckIn) what.push(`${prev.firstCheckIn ? 'earlier ' : ''}check-in ${hhmm(fin)}`);
  const lout = [prev.lastCheckOut, d.lastCheckOut].filter((t) => secsOf(t) != null).sort((a, b) => secsOf(b) - secsOf(a))[0] || null;
  if (lout && lout !== prev.lastCheckOut) what.push(`${prev.lastCheckOut ? 'later ' : ''}check-out ${hhmm(lout)}`);
  const had = String(prev.punchTimes || '').split('|').filter(Boolean);
  const all = [...new Set([...had, ...String(d.punchTimes || '').split('|').filter(Boolean)])].sort((a, b) => (secsOf(a) ?? 0) - (secsOf(b) ?? 0));
  if (all.length > had.length) what.push(`${all.length - had.length} more punch time${all.length - had.length === 1 ? '' : 's'}`);
  if (!what.length) return null;
  return {
    what: what.join(', '),
    day: {
      firstCheckIn: fin, lastCheckOut: lout, punchTimes: all.length ? all.join('|') : null,
      totalTimeWorked: d.totalTimeWorked || prev.totalTimeWorked || null, totalBreak: d.totalBreak || prev.totalBreak || null,
      totalHours: d.totalHours || prev.totalHours || null, workLocation: d.workLocation || prev.workLocation || null,
    },
  };
}
// The punches a re-imported day still needs: its In when no punch has that
// time; its Out — the earlier import's own Out moved to the later time, or a
// new Out when no punch has that time.
//
// 2026-10-28 (founder: "attendance imported, but employee logins not updated"): a day that already had a punch - e.g. a
// web / GPS check-in at 09:49 - never got the device's 09:14 check-in from the file, so the employee saw Late 09:49. The
// device's own first check-in is added when it is EARLIER than every punch TeamLink has for the day, and its last
// check-out when it is LATER than every one. The day then reads the device's times; nothing else is touched.
function punchFixOf(ps, it) {
  // the same punch: within a minute (a device row may carry HH:MM only, the file HH:MM:SS)
  const at = (t) => ps.some((p) => { const a = secsOf(p.clockTime || p.time); const b = secsOf(t); return a != null && b != null && Math.abs(a - b) < 60; });
  const times = ps.map((p) => secsOf(p.clockTime || p.time)).filter((x) => x != null);
  const earliest = times.length ? Math.min(...times) : Infinity;
  const latest = times.length ? Math.max(...times) : -Infinity;
  const addIn = !!(it.firstCheckIn && !at(it.firstCheckIn) && secsOf(it.firstCheckIn) < earliest);
  let moveOutId = null; let addOut = false;
  if (it.lastCheckOut && !at(it.lastCheckOut)) {
    const own = ps.find((p) => p.source === SOURCE && p.direction === 'Out' && it.prevOut && (p.clockTime || p.time) === it.prevOut);
    if (own) moveOutId = own.id; else if (secsOf(it.lastCheckOut) > latest) addOut = true;
  }
  return addIn || moveOutId || addOut ? { addIn, moveOutId, addOut } : null;
}
const fixWords = (f, it) => [f.addIn ? `device check-in ${hhmm(it.firstCheckIn)} added` : '', f.moveOutId || f.addOut ? `device check-out ${hhmm(it.lastCheckOut)} added` : ''].filter(Boolean).join(', ');

// Build the whole plan without writing anything.
async function plan(files) {
  const parsed = readFiles(files);
  const employees = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, department: true, designation: true } });
  const byCode = new Map(employees.map((e) => [e.employeeCode.trim(), e]));

  // ---- day-level: merge report + logs on (Employee ID, date) ----
  const days = new Map();
  const bad = [];
  const dayOf = (ref, date) => {
    const k = `${ref}|${date}`;
    if (!days.has(k)) days.set(k, { employeeRef: ref, date, sources: new Set() });
    return days.get(k);
  };
  (parsed.report?.rows || []).forEach((r, i) => {
    const ref = (r['Employee Ref No'] || r['Employee No'] || '').trim();
    const date = isoDate(r.Date);
    if (!ref || !date) { bad.push(`Report row ${i + 2}: missing Employee ID or unreadable date "${r.Date}"`); return; }
    const d = dayOf(ref, date);
    if (d.sources.has('report')) { bad.push(`Report row ${i + 2}: ${ref} ${date} appears twice — the first row is used`); return; }
    d.sources.add('report');
    d.sourceName = d.sourceName || cleanName(r['Employee Name']);
    d.firstCheckIn = clock(r['First Check In']);
    d.lastCheckOut = clock(r['Last Check Out']);
    d.totalTimeWorked = duration(r['Total Time Worked']);
    d.totalBreak = duration(r['Total Time In Break']);
    d.totalHours = duration(r['Total Hours']);
    d.workLocation = cleanName(r['Work Location']);
  });
  (parsed.logs?.rows || []).forEach((r, i) => {
    const [refPart, ...nameParts] = String(r.Employee || '').split(' - ');
    const ref = (refPart || '').trim();
    const date = isoDate(r['Attendance Date']);
    if (!ref || !date) { bad.push(`Bio-metric log row ${i + 2}: missing Employee ID or unreadable date "${r['Attendance Date']}"`); return; }
    const d = dayOf(ref, date);
    if (d.sources.has('logs')) { bad.push(`Bio-metric log row ${i + 2}: ${ref} ${date} appears twice — the first row is used`); return; }
    d.sources.add('logs');
    d.sourceName = d.sourceName || cleanName(nameParts.join(' - '));
    d.punchTimes = String(r['Time Interval'] || '').split('|').map(clock).filter(Boolean).join('|') || null;
  });

  // ---- a day the REPORT does not give a check-in / check-out for: read them from the bio-metric log ----
  // 2026-10-28 (founder: "check-outs miss avutunnai" with a bio-metric log of 15-26 Oct and no report): a log-only day used to
  // be stored as "punch times only" and never got its check-out. Now the log's first time is the check-in, and its last
  // time is the check-out when it is after the half-day split (13:30 by default, Attendance policy) and at least an hour
  // after the check-in - the same reading as the device's own evening press (utils/biometricDevice.js settledDirections).
  // A report time always wins over a log time.
  const cfg = await prisma.hrConfig.findFirst().catch(() => null);
  const splitSecs = require('./attendanceDays').policyTimes(cfg || {}).split * 60; // eslint-disable-line global-require
  for (const d of days.values()) {
    const times = String(d.punchTimes || '').split('|').filter((t) => secsOf(t) != null).sort((a, b) => secsOf(a) - secsOf(b));
    if (!times.length) continue;
    const first = times[0];
    const last = times[times.length - 1];
    if (!d.firstCheckIn) { d.firstCheckIn = first; d.fromLog = true; }
    if (!d.lastCheckOut && secsOf(last) >= splitSecs && secsOf(last) - secsOf(d.firstCheckIn) >= 3600) { d.lastCheckOut = last; d.fromLog = true; }
  }

  // ---- what TeamLink already has for those days ----
  const matchedIds = [...new Set([...days.values()].map((d) => byCode.get(d.employeeRef)?.id).filter(Boolean))];
  const [existingDays, existingHistory, existingPunchDays] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: matchedIds } }, select: { id: true, employeeId: true, date: true, status: true, checkIn: true, checkOut: true, timesSetBy: true } }),
    prisma.attendanceHistory.findMany({ select: { id: true, employeeRef: true, date: true, matchStatus: true, firstCheckIn: true, lastCheckOut: true, punchTimes: true, totalTimeWorked: true, totalBreak: true, totalHours: true, workLocation: true } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: matchedIds } }, select: { id: true, employeeId: true, date: true, clockTime: true, time: true, direction: true, source: true } }),
  ]);
  const exDay = new Map(existingDays.map((a) => [`${a.employeeId}|${a.date}`, a]));
  const exHist = new Map(existingHistory.map((h) => [`${h.employeeRef}|${h.date}`, h]));
  const hasPunches = new Set(existingPunchDays.map((p) => `${p.employeeId}|${p.date}`));
  const punchesOf = new Map();
  existingPunchDays.forEach((p) => { const k = `${p.employeeId}|${p.date}`; if (!punchesOf.has(k)) punchesOf.set(k, []); punchesOf.get(k).push(p); });

  const items = [];
  for (const d of days.values()) {
    const emp = byCode.get(d.employeeRef) || null;
    const prev = exHist.get(`${d.employeeRef}|${d.date}`);
    const item = { ...d, sources: [...d.sources].sort().join('+'), employee: emp, historyId: prev ? prev.id : null };
    // a day imported before: merged with what this file adds; nothing new = skipped as before
    const newer = prev && prev.matchStatus === 'Matched' && emp ? mergeDay(prev, d) : null;
    if (newer) { Object.assign(item, newer.day); item.refresh = newer.what; item.prevOut = prev.lastCheckOut || null; }
    // imported before with nothing new: still give the day the device check-in / check-out it is missing (the case above)
    const again = prev && prev.matchStatus === 'Matched' && emp && !newer && prev.firstCheckIn ? exDay.get(`${emp.id}|${d.date}`) : null;
    const againFix = again && EDITABLE_STATUSES.has(again.status) && hasPunches.has(`${emp.id}|${d.date}`)
      ? punchFixOf(punchesOf.get(`${emp.id}|${d.date}`) || [], { firstCheckIn: prev.firstCheckIn, lastCheckOut: prev.lastCheckOut }) : null;
    if (againFix) {
      Object.assign(item, { firstCheckIn: prev.firstCheckIn, lastCheckOut: prev.lastCheckOut, punchTimes: prev.punchTimes, totalTimeWorked: prev.totalTimeWorked, totalBreak: prev.totalBreak, totalHours: prev.totalHours, workLocation: prev.workLocation });
      item.action = 'keep'; item.existing = again; item.punchFix = againFix;
      item.result = `Already imported — ${fixWords(againFix, item)}`;
    } else if (prev && (prev.matchStatus === 'Matched' || !emp) && !newer) {
      item.action = 'skip'; item.result = 'Already imported';
    } else if (!emp) {
      item.action = 'unmatched'; item.result = 'Unmatched Employee — nothing created';
    } else if (!item.firstCheckIn) {
      item.action = 'history-only'; item.result = 'Punch times only (no first check-in in the report) — attendance not created';
    } else {
      const a = exDay.get(`${emp.id}|${d.date}`);
      const punchesAlready = hasPunches.has(`${emp.id}|${d.date}`);
      // a check-out the earlier import wrote (not HR / Super Admin) moves to this file's later one
      const moveOut = !!(item.refresh && a && !a.timesSetBy && item.prevOut && a.checkOut === hhmm(item.prevOut)
        && item.lastCheckOut && hhmm(item.lastCheckOut) > a.checkOut);
      if (!a) {
        item.action = 'create'; item.result = 'Day created (Present) with the imported check-in / check-out';
      } else if (!EDITABLE_STATUSES.has(a.status)) {
        item.action = 'conflict'; item.result = `Kept as it is — TeamLink has this day as ${a.status}`;
      } else if (a.checkIn && (a.checkOut || !item.lastCheckOut) && !moveOut) {
        item.action = 'keep'; item.result = 'Kept as it is — TeamLink already has check-in / check-out for this day';
      } else {
        item.action = 'fill';
        item.result = moveOut ? `Check-out moved to the later ${hhmm(item.lastCheckOut)} (status unchanged)` : `Times added to the existing ${a.status} day (status unchanged)`;
        item.moveOut = moveOut;
      }
      item.existing = a || null;
      // Punches only for a day this import creates or fills, and never on top
      // of punches TeamLink already has for that day. A day imported before
      // gets only the punches it is missing (its own earlier Out moves).
      item.addPunches = !punchesAlready && ['create', 'fill'].includes(item.action);
      if (punchesAlready && ['create', 'fill', 'keep'].includes(item.action)) {
        item.punchFix = punchFixOf(punchesOf.get(`${emp.id}|${d.date}`) || [], item);
        if (item.punchFix) item.result = `${item.result}; ${fixWords(item.punchFix, item)}`;
      }
    }
    if (item.refresh && item.action !== 'skip') item.result = `Updated from the newer file (${item.refresh}) — ${item.result.charAt(0).toLowerCase()}${item.result.slice(1)}`;
    items.push(item);
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.employeeRef.localeCompare(b.employeeRef));

  // ---- summary ----
  const period = periodFromName(parsed.summary?.name) || { from: null, to: null };
  const existingSums = parsed.summary ? await prisma.attendanceHistorySummary.findMany({ select: { employeeRef: true, periodFrom: true, periodTo: true, matchStatus: true, id: true } }) : [];
  const exSum = new Map(existingSums.map((s) => [`${s.employeeRef}|${s.periodFrom}|${s.periodTo}`, s]));
  const summaries = (parsed.summary?.rows || []).map((r) => {
    const ref = (r['Employee Ref No'] || '').trim();
    const emp = byCode.get(ref) || null;
    const prev = exSum.get(`${ref}|${period.from}|${period.to}`);
    const get = (label) => { const k = Object.keys(r).find((x) => x.trim().toLowerCase() === label); return k ? r[k] : ''; };
    return {
      employeeRef: ref, employee: emp, sourceName: cleanName(String(r['Employee Name'] || '').replace(new RegExp(`^${ref}-`), '')),
      periodFrom: period.from, periodTo: period.to, location: cleanName(get('location')),
      halfDay: num(get('half-day')), present: num(get('present')), weekOffs: num(get('week offs')),
      publicHolidays: num(get('public holidays')), leaves: num(get('leaves')), payableDays: num(get('payable days')),
      totalHours: duration(get('total hours')),
      historyId: prev ? prev.id : null,
      action: !ref ? 'invalid' : (prev && (prev.matchStatus === 'Matched' || !emp)) ? 'skip' : emp ? 'import' : 'unmatched',
    };
  });

  const count = (arr, key) => arr.reduce((m, x) => { m[x[key]] = (m[x[key]] || 0) + 1; return m; }, {});
  const unmatchedRefs = [...new Map(
    [...items, ...summaries].filter((x) => !x.employee && x.employeeRef).map((x) => [x.employeeRef, x.sourceName || null]),
  ).entries()].map(([employeeRef, sourceName]) => ({ employeeRef, sourceName })).sort((a, b) => a.employeeRef.localeCompare(b.employeeRef));

  return {
    files: {
      report: parsed.report ? { name: parsed.report.name, rows: parsed.report.rows.length } : null,
      logs: parsed.logs ? { name: parsed.logs.name, rows: parsed.logs.rows.length } : null,
      summary: parsed.summary ? { name: parsed.summary.name, rows: parsed.summary.rows.length, period } : null,
      unknown: parsed.unknown,
    },
    problems: [...parsed.problems, ...bad, ...(parsed.summary && !period.from ? ['The summary file name has no "DD-mon-YYYY_to_DD-mon-YYYY" period; it cannot be imported.'] : [])],
    days: {
      total: items.length, byAction: count(items, 'action'), punchesToAdd: items.filter((i) => i.addPunches || i.punchFix).length,
      updated: items.filter((i) => i.refresh && i.action !== 'skip').length, // imported before, this file adds to them
    },
    summaries: { total: summaries.length, byAction: count(summaries, 'action') },
    unmatched: unmatchedRefs,
    items,
    summaryItems: summaries,
  };
}

// Apply a plan. Everything for one run shares an importBatch id.
async function apply(p, { userId }) {
  const batch = `hist-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const done = { daysCreated: 0, daysFilled: 0, daysUpdated: 0, punchesCreated: 0, punchesMoved: 0, historyRows: 0, summaryRows: 0 };
  const writes = [];

  for (const it of p.items) {
    if (it.action === 'skip') continue;
    const emp = it.employee;
    const history = {
      employeeRef: it.employeeRef, employeeId: emp ? emp.id : null,
      matchStatus: emp ? 'Matched' : 'Unmatched Employee',
      sourceName: emp ? null : (it.sourceName || null),
      date: it.date, firstCheckIn: it.firstCheckIn || null, lastCheckOut: it.lastCheckOut || null,
      totalTimeWorked: it.totalTimeWorked || null, totalBreak: it.totalBreak || null, totalHours: it.totalHours || null,
      workLocation: it.workLocation || null, punchTimes: it.punchTimes || null,
      sources: it.sources, result: it.result, importBatch: batch, importedById: userId || null,
    };
    writes.push(it.historyId
      ? prisma.attendanceHistory.update({ where: { id: it.historyId }, data: history })
      : prisma.attendanceHistory.create({ data: history }));
    done.historyRows += 1;

    if (!emp) continue;
    if (it.action === 'create') {
      writes.push(prisma.attendance.create({
        data: { employeeId: emp.id, date: it.date, status: 'Present', checkIn: hhmm(it.firstCheckIn), checkOut: hhmm(it.lastCheckOut) },
      }));
      done.daysCreated += 1;
    } else if (it.action === 'fill') {
      const data = {};
      if (!it.existing.checkIn && it.firstCheckIn) data.checkIn = hhmm(it.firstCheckIn);
      if ((!it.existing.checkOut || it.moveOut) && it.lastCheckOut) data.checkOut = hhmm(it.lastCheckOut);
      if (Object.keys(data).length) { writes.push(prisma.attendance.update({ where: { id: it.existing.id }, data })); done.daysFilled += 1; }
    }
    if (it.refresh) done.daysUpdated += 1;
    if (it.punchFix) {
      const fixBase = { employeeId: emp.id, date: it.date, location: it.workLocation || null, source: SOURCE, verificationStatus: 'Imported' };
      const logged = (t) => !!(it.punchTimes && it.punchTimes.split('|').includes(t));
      if (it.punchFix.addIn) {
        writes.push(prisma.attendancePunch.create({ data: { ...fixBase, time: hhmm(it.firstCheckIn), clockTime: it.firstCheckIn, direction: 'In', method: logged(it.firstCheckIn) ? 'Biometric' : SOURCE } }));
        done.punchesCreated += 1;
      }
      if (it.punchFix.moveOutId) {
        writes.push(prisma.attendancePunch.update({ where: { id: it.punchFix.moveOutId }, data: { time: hhmm(it.lastCheckOut), clockTime: it.lastCheckOut, method: logged(it.lastCheckOut) ? 'Biometric' : SOURCE } }));
        done.punchesMoved += 1;
      } else if (it.punchFix.addOut) {
        writes.push(prisma.attendancePunch.create({ data: { ...fixBase, time: hhmm(it.lastCheckOut), clockTime: it.lastCheckOut, direction: 'Out', method: logged(it.lastCheckOut) ? 'Biometric' : SOURCE } }));
        done.punchesCreated += 1;
      }
    }
    if (it.addPunches) {
      const inLog = (t) => !!(it.punchTimes && it.punchTimes.split('|').includes(t));
      const base = { employeeId: emp.id, date: it.date, location: it.workLocation || null, source: SOURCE, verificationStatus: 'Imported' };
      writes.push(prisma.attendancePunch.create({
        data: { ...base, time: hhmm(it.firstCheckIn), clockTime: it.firstCheckIn, direction: 'In', method: inLog(it.firstCheckIn) ? 'Biometric' : SOURCE },
      }));
      done.punchesCreated += 1;
      if (it.lastCheckOut) {
        writes.push(prisma.attendancePunch.create({
          data: { ...base, time: hhmm(it.lastCheckOut), clockTime: it.lastCheckOut, direction: 'Out', method: inLog(it.lastCheckOut) ? 'Biometric' : SOURCE },
        }));
        done.punchesCreated += 1;
      }
    }
  }

  for (const s of p.summaryItems) {
    if (s.action !== 'import' && s.action !== 'unmatched') continue;
    if (!s.periodFrom || !s.periodTo) continue;
    const data = {
      employeeRef: s.employeeRef, employeeId: s.employee ? s.employee.id : null,
      matchStatus: s.employee ? 'Matched' : 'Unmatched Employee', sourceName: s.employee ? null : s.sourceName,
      periodFrom: s.periodFrom, periodTo: s.periodTo, location: s.location,
      halfDay: s.halfDay, present: s.present, weekOffs: s.weekOffs, publicHolidays: s.publicHolidays,
      leaves: s.leaves, payableDays: s.payableDays, totalHours: s.totalHours, importBatch: batch, importedById: userId || null,
    };
    writes.push(s.historyId
      ? prisma.attendanceHistorySummary.update({ where: { id: s.historyId }, data })
      : prisma.attendanceHistorySummary.create({ data }));
    done.summaryRows += 1;
  }

  // All or nothing: one transaction, so a failure leaves TeamLink untouched.
  if (writes.length) await prisma.$transaction(writes);
  return { batch, ...done };
}

module.exports = { plan, apply, readFiles, parseCsv, isoDate, SOURCE };
