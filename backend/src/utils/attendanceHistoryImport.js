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
//   * Re-running never duplicates: a day already imported is skipped.
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

  // ---- what TeamLink already has for those days ----
  const matchedIds = [...new Set([...days.values()].map((d) => byCode.get(d.employeeRef)?.id).filter(Boolean))];
  const [existingDays, existingHistory, existingPunchDays] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: matchedIds } }, select: { id: true, employeeId: true, date: true, status: true, checkIn: true, checkOut: true } }),
    prisma.attendanceHistory.findMany({ select: { id: true, employeeRef: true, date: true, matchStatus: true } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: matchedIds } }, select: { employeeId: true, date: true } }),
  ]);
  const exDay = new Map(existingDays.map((a) => [`${a.employeeId}|${a.date}`, a]));
  const exHist = new Map(existingHistory.map((h) => [`${h.employeeRef}|${h.date}`, h]));
  const hasPunches = new Set(existingPunchDays.map((p) => `${p.employeeId}|${p.date}`));

  const items = [];
  for (const d of days.values()) {
    const emp = byCode.get(d.employeeRef) || null;
    const prev = exHist.get(`${d.employeeRef}|${d.date}`);
    const item = { ...d, sources: [...d.sources].sort().join('+'), employee: emp, historyId: prev ? prev.id : null };
    if (prev && (prev.matchStatus === 'Matched' || !emp)) {
      item.action = 'skip'; item.result = 'Already imported';
    } else if (!emp) {
      item.action = 'unmatched'; item.result = 'Unmatched Employee — nothing created';
    } else if (!d.firstCheckIn) {
      item.action = 'history-only'; item.result = 'Punch times only (no first check-in in the report) — attendance not created';
    } else {
      const a = exDay.get(`${emp.id}|${d.date}`);
      const punchesAlready = hasPunches.has(`${emp.id}|${d.date}`);
      if (!a) {
        item.action = 'create'; item.result = 'Day created (Present) with the imported check-in / check-out';
      } else if (!EDITABLE_STATUSES.has(a.status)) {
        item.action = 'conflict'; item.result = `Kept as it is — TeamLink has this day as ${a.status}`;
      } else if (a.checkIn && (a.checkOut || !d.lastCheckOut)) {
        item.action = 'keep'; item.result = 'Kept as it is — TeamLink already has check-in / check-out for this day';
      } else {
        item.action = 'fill'; item.result = `Times added to the existing ${a.status} day (status unchanged)`;
      }
      item.existing = a || null;
      // Punches only for a day this import creates or fills, and never on top
      // of punches TeamLink already has for that day.
      item.addPunches = !punchesAlready && ['create', 'fill'].includes(item.action);
    }
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
    days: { total: items.length, byAction: count(items, 'action'), punchesToAdd: items.filter((i) => i.addPunches).length },
    summaries: { total: summaries.length, byAction: count(summaries, 'action') },
    unmatched: unmatchedRefs,
    items,
    summaryItems: summaries,
  };
}

// Apply a plan. Everything for one run shares an importBatch id.
async function apply(p, { userId }) {
  const batch = `hist-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const done = { daysCreated: 0, daysFilled: 0, punchesCreated: 0, historyRows: 0, summaryRows: 0 };
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
      if (!it.existing.checkOut && it.lastCheckOut) data.checkOut = hhmm(it.lastCheckOut);
      if (Object.keys(data).length) { writes.push(prisma.attendance.update({ where: { id: it.existing.id }, data })); done.daysFilled += 1; }
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
