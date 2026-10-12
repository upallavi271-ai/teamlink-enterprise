#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop, no-restricted-syntax */
// ---------------------------------------------------------------------------
// ONE-SHOT LOADER — PulseHRM attendance + leave, 27 Sep 2026 .. 08 Oct 2026.
//
// WHAT IT LOADS (nothing outside 2026-09-27 .. 2026-10-08; 9 Oct is NOT loaded,
// PulseHRM's export of that day is incomplete):
//   1. EMPLOYEES   TL517, TL519, TL520 (in PulseHRM with punches, not in TeamLink):
//                  minimal records like TL518 — Active, Full-time, no login, no
//                  e-mail, NO welcome mail, no join date (the roster engine starts
//                  them on their first recorded day), department left empty
//                  (PulseHRM's "HR" is not TeamLink's HR department; HR assigns the seat).
//   2. ATTENDANCE  TeamLink's own PulseHRM importer (utils/attendanceHistoryImport.js
//                  plan()) decides every day; rows are shaped exactly as that importer
//                  shapes them (AttendanceHistory, Attendance "Present" day with the
//                  check-in / check-out, AttendancePunch In / Out with source
//                  "PulseHRM import"). On top of it:
//                    * 29 Sep: the days the earlier LOG-ONLY import left with a morning
//                      punch (importer would skip them as "Already imported") are
//                      COMPLETED from the report: the missing punches are added
//                      idempotently by (employee, date, direction, clock time), the day row
//                      is filled, the history row is updated. Nothing is ever duplicated.
//                    * a lone punch stays a lone punch (no check-out is invented); a
//                      5-second double punch is kept exactly as the file has it.
//                    * HR's own marks (Attendance rows with no times: 29 Sep TL102 Absent,
//                      000, TL518 Present) are never changed.
//                    * people who are Relieved / Exited in TeamLink are NOT loaded (their
//                      punches would put them back on the rolls); they are listed.
//   3. LEAVE       'Leave History' rows overlapping the range, through the rules of
//                  io/leaveHistory.js (Approved / Cancelled history: no chain, no
//                  notification; an Approved leave of the current year draws its days from
//                  the balance) and routes/leave.js (Pending: a normal Pending request with
//                  its approval chain from utils/approvalWorkflow.js start()). SILENT: no
//                  e-mail, no bell, no SMS. days = the file's Duration (so the holiday /
//                  Sunday inside a range is not charged); a half day carries the
//                  "Half day: First/Second Half" marker.
//   4. The attendance SUMMARY file is NOT loaded (used only by the re-compare report).
//
// MODES   (default = DRY RUN)
//   node scripts/load-pulsehrm-27sep-08oct.js [--db <file>] [--dir <folder>] [--report <md>] [--json <file>]
//        DRY RUN: snapshots the target db into a throw-away copy, runs the WHOLE load on
//        that copy, verifies it, prints the exact counts, deletes the copy. Nothing in the
//        target db is touched (it is only read, by VACUUM INTO).
//   ... --apply          really writes: full backup copy first, one transaction for the data,
//                        a JSON manifest of every created / changed row, then the same checks.
//   ... --undo <manifest> exact reverse of one --apply (after a backup of its own).
//   ... --verify         read-only re-compare of the files against the db + tile equation.
//   --db <file>          default backend/prisma/dev.db. --apply / --undo on the real dev.db is
//                        refused unless  --really-real  AND env  TL_ALLOW_REAL_APPLY=1.
//   --dir <folder>       where the four PulseHRM exports are (default C:/Users/user/Downloads).
//   --backup-dir <dir>   where the backup + manifest go (default backend/backups/pulsehrm-load-<stamp>).
//   --new-employee-department <name>   department for TL517/519/520 (default: none).
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const REAL_DB = path.join(BACKEND, 'prisma', 'dev.db');
const RANGE = { from: '2026-09-27', to: '2026-10-08' };
const FILES = {
  report: 'first_check-in_&_last_check-out_report_form_27-sep-2026_to_09-oct-2026 (1).csv',
  logs: 'bio-metric_logs (3) (1).csv',
  summary: 'attendance_summary_from_27-sep-2026_to_09-oct-2026 (1).csv',
  leave: 'Leave History (2) (1).xlsx',
};
const NEW_EMPLOYEES = ['TL517', 'TL519', 'TL520'];
const LEFT = ['Relieved', 'Exited'];
const ACTOR = 'PulseHRM load 27 Sep - 8 Oct 2026 (script)';
const SOURCE_TAG = 'PulseHRM leave history';

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const MODE = flag('--undo') ? 'undo' : flag('--apply') ? 'apply' : flag('--verify') ? 'verify' : 'dry';
const DB_ARG = path.resolve(opt('--db', REAL_DB));
const DIR = opt('--dir', 'C:/Users/user/Downloads');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const BACKUP_DIR = path.resolve(opt('--backup-dir', path.join(BACKEND, 'backups', `pulsehrm-load-${STAMP}`)));
const NEW_DEPT = opt('--new-employee-department', null);
const isReal = (p) => path.resolve(p).toLowerCase() === REAL_DB.toLowerCase();

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 60).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
if ((MODE === 'apply' || MODE === 'undo') && isReal(DB_ARG)) {
  if (!flag('--really-real') || process.env.TL_ALLOW_REAL_APPLY !== '1') {
    console.error(`REFUSED: ${MODE} on the real dev.db needs  --really-real  AND the environment variable TL_ALLOW_REAL_APPLY=1.`);
    process.exit(2);
  }
}
if (!fs.existsSync(DB_ARG)) { console.error(`database not found: ${DB_ARG}`); process.exit(2); }

// ------------------------------------------------------------------ sqlite snapshot (VACUUM INTO)
function snapshot(src, dest) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(dest + s); } catch { /* none */ } }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let db;
  try { db = new DatabaseSync(src, { readOnly: true }); } catch { db = new DatabaseSync(src); }
  try { db.exec('PRAGMA busy_timeout=20000'); db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); } finally { db.close(); }
  const c = new DatabaseSync(dest, { readOnly: true });
  const q = String(Object.values(c.prepare('PRAGMA quick_check').get())[0]);
  c.close();
  if (q !== 'ok') throw new Error(`snapshot failed its integrity check: ${q}`);
}

// Which db does this process run on? (decided BEFORE src/db.js is required)
let WORK_DB = DB_ARG;
let TEMP_DB = null;
if (MODE === 'dry') {
  TEMP_DB = path.join(os.tmpdir(), `tl-pulse-dryrun-${STAMP}-${process.pid}.db`);
  snapshot(DB_ARG, TEMP_DB);
  WORK_DB = TEMP_DB;
}
process.env.DATABASE_URL = `file:${WORK_DB.replace(/\\/g, '/')}?connection_limit=1&socket_timeout=300`;
process.env.TEST_MODE = process.env.TEST_MODE || '1'; // belt and braces: nothing here sends mail, but never let a module think it may

const prisma = require('../src/db');
const hist = require('../src/utils/attendanceHistoryImport');
const leaveText = require('../src/utils/leaveText');
const D = require('../src/utils/attendanceDays');
const workflow = require('../src/utils/approvalWorkflow');

// ------------------------------------------------------------------ small helpers
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sec = (t) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t || ''); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
const hms = (s) => (s == null ? '' : `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
const hhmm = (t) => (t ? t.slice(0, 5) : null);
const eachDay = (a, b) => { const o = []; const d = new Date(`${a}T00:00:00Z`); const e = new Date(`${b}T00:00:00Z`); for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) o.push(d.toISOString().slice(0, 10)); return o; };
const inRange = (d) => d >= RANGE.from && d <= RANGE.to;
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const counts = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const readTxt = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

async function readLeaveXlsx() {
  // exceljs mis-reads the t="d" ISO dates of this export, so the sheet XML is read directly.
  // eslint-disable-next-line global-require
  const JSZip = require('jszip');
  const z = await JSZip.loadAsync(fs.readFileSync(path.join(DIR, FILES.leave)));
  const un = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const ss = await z.file('xl/sharedStrings.xml').async('string');
  const strs = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => un([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const sh = await z.file('xl/worksheets/sheet1.xml').async('string');
  const rows = [];
  for (const rm of sh.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const t = (/t="(\w+)"/.exec(cm[2]) || [])[1];
      const vm = /<v>([\s\S]*?)<\/v>/.exec(cm[3] || '');
      let v = vm ? vm[1] : null;
      if (v !== null) v = t === 's' ? strs[Number(v)] : un(v);
      cells[cm[1]] = v;
    }
    rows.push({ n: Number(rm[1]), cells });
  }
  const head = rows[0].cells;
  const col = Object.fromEntries(Object.entries(head).map(([k, v]) => [tidy(v).toLowerCase(), k]));
  const need = ['employee id', 'leave type', 'leave from', 'leave to', 'duration', 'status'];
  need.forEach((h) => { if (!col[h]) throw new Error(`Leave History: column "${h}" not found`); });
  const g = (r, h) => (col[h] && r.cells[col[h]] != null ? String(r.cells[col[h]]) : '');
  return rows.slice(1).filter((r) => g(r, 'employee id').trim()).map((r) => ({
    row: r.n, code: g(r, 'employee id').trim(), name: tidy(g(r, 'employee name')), dept: tidy(g(r, 'department')),
    applied: g(r, 'date of application').slice(0, 10), type: tidy(g(r, 'leave type')),
    from: g(r, 'leave from').slice(0, 10), to: g(r, 'leave to').slice(0, 10), half: tidy(g(r, 'half day')),
    dur: Number(g(r, 'duration')), reason: tidy(g(r, 'reason')), comments: g(r, 'comments'),
    approver: tidy(g(r, 'approver')), apprComments: g(r, 'approver comments'), approvedAt: g(r, 'approved date').slice(0, 19),
    status: tidy(g(r, 'status')),
  }));
}

// ------------------------------------------------------------------ the manifest (what a run created / changed)
function newManifest() {
  return {
    version: 1, script: path.basename(__filename), createdAt: new Date().toISOString(), db: WORK_DB, range: RANGE, batch: null, backup: null,
    created: { Employee: [], Attendance: [], AttendancePunch: [], AttendanceHistory: [], LeaveRequest: [], LeaveBalance: [], AuditLog: [], ApprovalStep: [], ApprovalLevelConfig: [] },
    // before-images / deltas of rows that already existed
    changed: { Attendance: [], AttendanceHistory: [], LeaveBalance: [] },
  };
}

// ------------------------------------------------------------------ THE LOAD
let CURRENT = null;
async function load(report) {
  const man = newManifest();
  CURRENT = man;
  man.batch = `hist-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  report.manifestBatch = man.batch;

  // ---- inputs
  const f1text = readTxt(FILES.report);
  const f4text = readTxt(FILES.logs);
  const leaveRows = await readLeaveXlsx();
  const F1 = hist.parseCsv(f1text).rows;
  const F4 = hist.parseCsv(f4text).rows;
  const f1Of = new Map(F1.map((r) => [`${(r['Employee Ref No'] || '').trim()}|${hist.isoDate(r.Date)}`, r]));
  report.inputs = {
    report: { file: FILES.report, rows: F1.length }, logs: { file: FILES.logs, rows: F4.length },
    leave: { file: FILES.leave, rows: leaveRows.length }, summary: { file: FILES.summary, loaded: false, note: 'used only for the re-compare' },
  };

  // ---- 1. employees --------------------------------------------------------
  const fileDays = new Map(); // code -> {name, dept, desig, firstDate}
  F1.forEach((r) => {
    const c = (r['Employee Ref No'] || '').trim(); const d = hist.isoDate(r.Date);
    if (!c || !d) return;
    const o = fileDays.get(c) || { code: c, name: tidy(r['Employee Name']), dept: tidy(r.Department), desig: tidy(r.Designation), firstDate: d };
    if (d < o.firstDate) o.firstDate = d;
    fileDays.set(c, o);
  });
  const empNow = await prisma.employee.findMany({ select: { id: true, employeeCode: true } });
  const have = new Set(empNow.map((e) => e.employeeCode.trim()));
  report.employees = { toCreate: [], alreadyThere: [] };
  for (const code of NEW_EMPLOYEES) {
    const f = fileDays.get(code);
    if (have.has(code)) { report.employees.alreadyThere.push(code); continue; }
    if (!f) { report.employees.alreadyThere.push(`${code} (not in the report file - skipped)`); continue; }
    report.employees.toCreate.push(f);
  }
  if (report.employees.toCreate.length) {
    await prisma.$transaction(async (tx) => {
      for (const f of report.employees.toCreate) {
        const e = await tx.employee.create({
          data: {
            employeeCode: f.code, name: f.name, department: NEW_DEPT, designation: 'Employee', location: 'Hyderabad', branch: 'Hyderabad',
            employmentStatus: 'Active', employeeType: 'Full-time', email: '', phone: '',
          },
        });
        man.created.Employee.push(e.id);
        const a = await tx.auditLog.create({
          data: {
            userId: null, actorName: ACTOR, action: 'Employee created (PulseHRM load, no login)', entity: 'Employee', entityId: e.id,
            toValue: `${f.code} ${f.name} - imported from PulseHRM (department "${f.dept}", designation "${f.desig}", first punch ${f.firstDate}); no login, no welcome mail, department to be assigned by HR`,
          },
        });
        man.created.AuditLog.push(a.id);
        f.id = e.id;
      }
    }, { maxWait: 60000, timeout: 120000 });
  }

  // ---- 2. attendance: the importer's own plan() ---------------------------
  const plan = await hist.plan([{ name: FILES.report, text: f1text }, { name: FILES.logs, text: f4text }]);
  report.plan = { files: plan.files, problems: plan.problems, allDays: plan.days, unmatched: plan.unmatched };
  const emps = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, employmentStatus: true, department: true } });
  const empByCode = new Map(emps.map((e) => [e.employeeCode.trim(), e]));
  const statusOf = new Map(emps.map((e) => [e.id, e.employmentStatus]));
  const items = plan.items.filter((i) => inRange(i.date));
  report.attendance = {
    outsideRange: plan.items.length - items.length,
    outsideRangeDates: counts(plan.items.filter((i) => !inRange(i.date)), (i) => i.date),
    planByAction: counts(items, (i) => i.action), excluded: [], notLoaded: [], completed: [], skippedSame: 0, skippedDifferent: [],
    created: { Attendance: 0, AttendancePunch: 0, AttendanceHistory: 0 }, filled: 0, histUpdated: 0, punchesAdded: 0,
    perDate: {}, perEmployee: {}, hrMarksUntouched: [],
  };
  const A = report.attendance;
  const byDate = (d) => (A.perDate[d] = A.perDate[d] || { files: 0, created: 0, filled: 0, completed: 0, histOnly: 0, kept: 0, conflict: 0, same: 0, excluded: 0, punches: 0 });
  const byEmp = (c) => (A.perEmployee[c] = A.perEmployee[c] || { code: c, name: (empByCode.get(c) || {}).name || '', days: 0, punches: 0 });

  // existing facts for the range
  const ids = [...new Set(items.map((i) => i.employee && i.employee.id).filter(Boolean))];
  const [exDays, exAH, exPunches] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { gte: RANGE.from, lte: RANGE.to } } }),
    prisma.attendanceHistory.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { gte: RANGE.from, lte: RANGE.to } }, select: { employeeId: true, date: true, direction: true, clockTime: true, time: true } }),
  ]);
  const dayOf = new Map(exDays.map((a) => [`${a.employeeId}|${a.date}`, a]));
  const ahOf = new Map(exAH.map((h) => [`${h.employeeRef}|${h.date}`, h]));
  const punchKey = (p) => `${p.employeeId}|${p.date}|${p.direction}|${p.clockTime || `${p.time}:00`}`;
  const punchSet = new Set(exPunches.map(punchKey));
  // HR's own marks in the range (Attendance rows with no times) - listed, never touched.
  const empById = new Map(emps.map((e) => [e.id, e]));
  const hrMarks = (await prisma.attendance.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to }, checkIn: null, checkOut: null } }));
  A.hrMarksUntouched = hrMarks.map((a) => ({ id: a.id, code: (empById.get(a.employeeId) || {}).employeeCode, date: a.date, status: a.status }));
  const hrMarkKeys = new Set(hrMarks.map((a) => `${a.employeeId}|${a.date}`));

  const EDITABLE = new Set(['Present', 'Half Day', 'Late']);
  const ops = []; // decided work: {kind, it, ...}
  for (const it of items) {
    const code = it.employeeRef;
    const emp = it.employee ? empByCode.get(code) : null;
    byDate(it.date).files += 1;
    if (!emp) { A.notLoaded.push({ code, date: it.date, reason: 'Employee ID is not in TeamLink (nothing created for it)' }); continue; }
    if (LEFT.includes(statusOf.get(emp.id))) {
      A.excluded.push({ code, name: emp.name, status: statusOf.get(emp.id), date: it.date, firstCheckIn: it.firstCheckIn || null, lastCheckOut: it.lastCheckOut || null, punchTimes: it.punchTimes || null });
      byDate(it.date).excluded += 1;
      continue;
    }
    if (it.action === 'skip') {
      const prev = ahOf.get(`${code}|${it.date}`);
      const pt = (prev && prev.punchTimes) || '';
      const filePt = it.punchTimes || '';
      const incomplete = prev && (
        (!prev.firstCheckIn && it.firstCheckIn)
        || (!prev.lastCheckOut && it.lastCheckOut)
        || (filePt && filePt.length > pt.length && filePt.startsWith(pt))
      );
      if (incomplete) { ops.push({ kind: 'complete', it, prev, emp }); continue; }
      const differs = prev && ((prev.firstCheckIn || null) !== (it.firstCheckIn || null) || (prev.lastCheckOut || null) !== (it.lastCheckOut || null));
      if (differs) A.skippedDifferent.push({ code, date: it.date, theirs: `${prev.firstCheckIn || '-'} / ${prev.lastCheckOut || '-'}`, file: `${it.firstCheckIn || '-'} / ${it.lastCheckOut || '-'}` });
      else { A.skippedSame += 1; byDate(it.date).same += 1; }
      continue;
    }
    ops.push({ kind: it.action, it, emp });
  }

  await prisma.$transaction(async (tx) => {
    const writeHistory = async (it, emp, resultText, existingId) => {
      const data = {
        employeeRef: it.employeeRef, employeeId: emp.id, matchStatus: 'Matched', sourceName: null, date: it.date,
        firstCheckIn: it.firstCheckIn || null, lastCheckOut: it.lastCheckOut || null, totalTimeWorked: it.totalTimeWorked || null,
        totalBreak: it.totalBreak || null, totalHours: it.totalHours || null, workLocation: it.workLocation || null,
        punchTimes: it.punchTimes || null, sources: it.sources, result: resultText, importBatch: man.batch, importedById: null,
      };
      if (existingId) { await tx.attendanceHistory.update({ where: { id: existingId }, data }); A.histUpdated += 1; return existingId; }
      const h = await tx.attendanceHistory.create({ data });
      man.created.AttendanceHistory.push(h.id); A.created.AttendanceHistory += 1;
      return h.id;
    };
    const ensurePunch = async (emp, it, direction, clock) => {
      const k = `${emp.id}|${it.date}|${direction}|${clock}`;
      if (punchSet.has(k)) return false;
      const inLog = !!(it.punchTimes && it.punchTimes.split('|').includes(clock));
      const p = await tx.attendancePunch.create({
        data: {
          employeeId: emp.id, date: it.date, location: it.workLocation || null, source: hist.SOURCE, verificationStatus: 'Imported',
          time: hhmm(clock), clockTime: clock, direction, method: inLog ? 'Biometric' : hist.SOURCE,
        },
      });
      punchSet.add(k); man.created.AttendancePunch.push(p.id); A.created.AttendancePunch += 1; A.punchesAdded += 1;
      byDate(it.date).punches += 1; byEmp(it.employeeRef).punches += 1;
      return true;
    };
    const dayAction = (it, a) => {
      if (!it.firstCheckIn) return { action: 'history-only', result: 'Punch times only (no first check-in in the report) — attendance not created' };
      if (!a) return { action: 'create', result: 'Day created (Present) with the imported check-in / check-out' };
      if (!EDITABLE.has(a.status)) return { action: 'conflict', result: `Kept as it is — TeamLink has this day as ${a.status}` };
      if (a.checkIn && (a.checkOut || !it.lastCheckOut)) return { action: 'keep', result: 'Kept as it is — TeamLink already has check-in / check-out for this day' };
      return { action: 'fill', result: `Times added to the existing ${a.status} day (status unchanged)` };
    };

    for (const op of ops) {
      const { it, emp } = op;
      const dKey = `${emp.id}|${it.date}`;
      let { action, result } = op.kind === 'complete' ? dayAction(it, dayOf.get(dKey) || null) : { action: op.kind, result: it.result };
      const a = dayOf.get(dKey) || null;
      // a day row the importer would 'create' may already exist (HR mark): never create twice
      if (action === 'create' && a) ({ action, result } = dayAction(it, a));
      if (hrMarkKeys.has(dKey) && action === 'fill') { action = 'conflict'; result = `Kept as it is — HR marked this day ${a.status} (no times)`; }
      const completing = op.kind === 'complete';
      const prevAH = completing ? op.prev : (it.historyId ? ahOf.get(`${it.employeeRef}|${it.date}`) : null);
      if (prevAH) man.changed.AttendanceHistory.push({ id: prevAH.id, before: JSON.parse(JSON.stringify(prevAH)) });
      await writeHistory(it, emp, completing ? `${result} (completed from the report by the PulseHRM 27 Sep - 8 Oct load)` : result, prevAH ? prevAH.id : null);
      if (completing) {
        A.completed.push({ code: it.employeeRef, date: it.date, first: it.firstCheckIn || null, last: it.lastCheckOut || null });
        byDate(it.date).completed += 1;
      }
      byEmp(it.employeeRef).days += 1;
      if (action === 'create') {
        const row = await tx.attendance.create({ data: { employeeId: emp.id, date: it.date, status: 'Present', checkIn: hhmm(it.firstCheckIn), checkOut: hhmm(it.lastCheckOut) } });
        man.created.Attendance.push(row.id); A.created.Attendance += 1; byDate(it.date).created += 1;
      } else if (action === 'fill') {
        const data = {};
        if (!a.checkIn && it.firstCheckIn) data.checkIn = hhmm(it.firstCheckIn);
        if (!a.checkOut && it.lastCheckOut) data.checkOut = hhmm(it.lastCheckOut);
        if (Object.keys(data).length) {
          man.changed.Attendance.push({ id: a.id, before: { checkIn: a.checkIn, checkOut: a.checkOut }, set: data });
          await tx.attendance.update({ where: { id: a.id }, data }); A.filled += 1; byDate(it.date).filled += 1;
        }
      } else if (action === 'history-only') byDate(it.date).histOnly += 1;
      else if (action === 'keep') byDate(it.date).kept += 1;
      else if (action === 'conflict') byDate(it.date).conflict += 1;
      if (['create', 'fill'].includes(action)) {
        await ensurePunch(emp, it, 'In', it.firstCheckIn);
        if (it.lastCheckOut) await ensurePunch(emp, it, 'Out', it.lastCheckOut);
      }
    }
    const al = await tx.auditLog.create({
      data: {
        userId: null, actorName: ACTOR, action: 'Past attendance imported', entity: 'AttendanceHistory', entityId: man.batch,
        toValue: `${A.created.AttendanceHistory} history row(s) added, ${A.histUpdated} updated (29 Sep completions), ${A.created.Attendance} day(s) created, ${A.filled} filled, ${A.created.AttendancePunch} punch(es), 0 summary row(s) (summary file not loaded)`,
      },
    });
    man.created.AuditLog.push(al.id);
  }, { maxWait: 120000, timeout: 600000 });

  // ---- 3. leave -------------------------------------------------------------
  const types = await prisma.leaveType.findMany();
  const typeNames = types.map((t) => t.name);
  const exLeave = await prisma.leaveRequest.findMany({ where: { fromDate: { lte: RANGE.to }, toDate: { gte: RANGE.from } } });
  const empFull = await prisma.employee.findMany();
  const empFullByCode = new Map(empFull.map((e) => [e.employeeCode.trim().toUpperCase(), e]));
  const L = (report.leave = { rows: [], counts: {}, balance: [], pendingChains: [] });
  const span = (a, b) => eachDay(a, b).length;
  const approvedSoFar = []; // {empId, from, to, row}
  const plans = [];
  for (const x of leaveRows) {
    const out = { row: x.row, code: x.code, name: x.name, type: x.type, from: x.from, to: x.to, fileHalf: x.half, dur: x.dur, status: x.status, approver: x.approver, outcome: '', note: '' };
    L.rows.push(out);
    const e = empFullByCode.get(x.code.toUpperCase());
    if (!e) { out.outcome = 'SKIPPED'; out.note = 'Employee is not in TeamLink'; continue; }
    if (LEFT.includes(e.employmentStatus)) { out.outcome = 'SKIPPED'; out.note = `Employee is ${e.employmentStatus} in TeamLink`; continue; }
    if (!(x.from <= RANGE.to && x.to >= RANGE.from)) { out.outcome = 'SKIPPED'; out.note = `outside ${RANGE.from}..${RANGE.to} (apply it on the Leave screen when needed)`; continue; }
    const type = typeNames.find((t) => t.toLowerCase() === x.type.toLowerCase());
    if (!type) { out.outcome = 'SKIPPED'; out.note = `"${x.type}" is not a TeamLink leave type`; continue; }
    if (!['Pending', 'Approved', 'Cancelled', 'Rejected'].includes(x.status)) { out.outcome = 'SKIPPED'; out.note = `status "${x.status}" not understood`; continue; }
    const sp = span(x.from, x.to);
    if (!Number.isFinite(x.dur) || x.dur <= 0 || Math.round(x.dur * 2) !== x.dur * 2 || x.dur > sp) { out.outcome = 'SKIPPED'; out.note = `Duration ${x.dur} does not fit ${x.from}..${x.to}`; continue; }
    const twin = exLeave.find((l) => l.employeeId === e.id && l.type === type && l.fromDate === x.from && l.toDate === x.to);
    if (twin) { out.outcome = 'ALREADY IN TEAMLINK'; out.note = `existing request is ${twin.status}${twin.status !== x.status ? ` (file says ${x.status}; left as it is)` : ''}`; continue; }
    if (x.status === 'Approved') {
      const clash = exLeave.find((l) => l.employeeId === e.id && ['Approved', 'Pending', 'Cancellation Requested'].includes(l.status) && l.fromDate <= x.to && l.toDate >= x.from);
      if (clash) { out.outcome = 'SKIPPED'; out.note = `overlaps TeamLink ${clash.status} ${clash.type} ${clash.fromDate}..${clash.toDate}`; continue; }
      const twin2 = approvedSoFar.find((c) => c.empId === e.id && c.from <= x.to && c.to >= x.from);
      if (twin2) { out.outcome = 'SKIPPED'; out.note = `overlaps the Approved file row ${twin2.row}`; continue; }
      approvedSoFar.push({ empId: e.id, from: x.from, to: x.to, row: x.row });
    }
    // half-day marker: the file's own, else read from the punches of that day (worked the first half and left ~13:30 = the SECOND half is the leave)
    let half = /first/i.test(x.half) ? 'First Half' : /second/i.test(x.half) ? 'Second Half' : null;
    let halfNote = half ? 'from the file' : '';
    if (!half && x.dur === 0.5 && x.from === x.to) {
      const f = f1Of.get(`${x.code}|${x.from}`);
      const fi = f ? sec(f['First Check In']) : null; const fo = f ? sec(f['Last Check Out']) : null;
      if (fi != null && fo != null && fo <= 14 * 3600 + 30 * 60 && fi <= 11 * 3600) { half = 'Second Half'; halfNote = `derived: punched ${f['First Check In']}-${f['Last Check Out']} (worked the first half)`; }
      else if (fi != null && fi >= 12 * 3600) { half = 'First Half'; halfNote = `derived: came ${f['First Check In']} (worked the second half)`; }
      else halfNote = 'session unknown (no marker; TeamLink reads a single 0.5 day as a half day)';
    }
    out.stored = { days: x.dur, half, halfNote, calendarSpan: sp };
    plans.push({ x, e, type, half, out });
  }

  const balanceDelta = new Map(); // `${empId}|${type}` -> days
  const createdLeaves = [];
  const parseIst = (s) => (s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s) ? new Date(`${s}+05:30`) : null);
  await prisma.$transaction(async (tx) => {
    for (const p of plans) {
      const { x, e, type, half, out } = p;
      const details = [['Half day', half]];
      if (x.status === 'Pending') details.push(['Approver', x.approver]);
      if (x.status === 'Cancelled' && tidy(x.apprComments)) details.push(['Approver comments', x.apprComments]);
      details.push(['Source', SOURCE_TAG]);
      const reason = leaveText.compose({ reason: x.reason, comments: x.comments, details });
      const decided = x.status !== 'Pending';
      const leave = await tx.leaveRequest.create({
        data: {
          employeeId: e.id, type, fromDate: x.from, toDate: x.to, days: x.dur, reason, status: x.status,
          decidedBy: decided ? (x.approver || 'Imported from PulseHRM') : null,
          decidedAt: decided ? (parseIst(x.approvedAt) || new Date(`${x.to}T00:00:00.000Z`)) : null,
          approvalReason: x.status === 'Approved' && tidy(x.apprComments) ? x.apprComments.replace(/\r/g, '').trim() : null,
          createdAt: x.applied ? new Date(`${x.applied}T00:00:00.000Z`) : undefined,
        },
      });
      man.created.LeaveRequest.push(leave.id);
      createdLeaves.push({ leave, e, status: x.status });
      const a1 = await tx.auditLog.create({
        data: {
          userId: null, actorName: ACTOR, action: 'Leave imported', entity: 'LeaveRequest', entityId: leave.id,
          toValue: `${x.status} · ${type} ${x.from} → ${x.to} · ${x.dur} day(s)`, reason: `${e.employeeCode} ${e.name}`,
        },
      });
      man.created.AuditLog.push(a1.id);
      out.outcome = `CREATED ${x.status}`;
      if (x.status === 'Approved' && x.from.slice(0, 4) === String(new Date().getFullYear())) {
        // io/leaveHistory.js: the current year's balance is drawn down exactly as an approval does.
        const have2 = new Set((await tx.leaveBalance.findMany({ where: { employeeId: e.id }, select: { type: true } })).map((b) => b.type));
        const missing = types.filter((t) => t.active && !have2.has(t.name));
        for (const t of missing) {
          const total = t.unit === 'unpaid' ? 0 : (t.unit === 'month' ? Number(t.cap || 0) * 12 : Number(t.cap || 0));
          const b = await tx.leaveBalance.create({ data: { employeeId: e.id, type: t.name, total, taken: 0 } });
          man.created.LeaveBalance.push(b.id);
        }
        const bal = await tx.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: e.id, type } } });
        if (bal) {
          await tx.leaveBalance.update({ where: { id: bal.id }, data: { taken: round2(bal.taken + x.dur) } });
          if (!man.created.LeaveBalance.includes(bal.id)) man.changed.LeaveBalance.push({ id: bal.id, deltaTaken: x.dur, before: { taken: bal.taken, updatedAt: bal.updatedAt } });
          else man.changed.LeaveBalance.push({ id: bal.id, deltaTaken: x.dur, before: { taken: bal.taken, updatedAt: bal.updatedAt }, createdHere: true });
          const k = `${e.id}|${type}`;
          const cur = balanceDelta.get(k) || { code: e.employeeCode, name: e.name, type, before: bal.taken, total: bal.total, delta: 0 };
          cur.delta = round2(cur.delta + x.dur);
          balanceDelta.set(k, cur);
          const a2 = await tx.auditLog.create({
            data: {
              userId: null, actorName: ACTOR, action: 'Leave imported — drawn from balance', entity: 'LeaveRequest', entityId: leave.id,
              toValue: `${type}: taken ${bal.taken} → ${round2(bal.taken + x.dur)} of ${bal.total}`, reason: `${e.employeeCode} ${e.name}`,
            },
          });
          man.created.AuditLog.push(a2.id);
        }
      }
    }
  }, { maxWait: 120000, timeout: 600000 });
  L.balance = [...balanceDelta.values()].map((b) => ({ ...b, after: round2(b.before + b.delta) }));

  // ---- 4. approval chains of the Pending requests (their own writes; a failure rolls everything back)
  const levelBefore = new Set((await prisma.approvalLevelConfig.findMany({ select: { id: true } })).map((r) => r.id));
  for (const c of createdLeaves.filter((c0) => c0.status === 'Pending')) {
    await workflow.start({ workflow: 'leave', recordId: c.leave.id, employee: c.e, applicantUserId: c.e.userId || null, applicantName: c.e.name });
    const steps = await prisma.approvalStep.findMany({ where: { workflow: 'leave', recordId: c.leave.id }, orderBy: { seq: 'asc' } });
    steps.forEach((s) => man.created.ApprovalStep.push(s.id));
    const cur = steps.find((s) => s.status === 'Pending');
    L.pendingChains.push({ code: c.e.employeeCode, name: c.e.name, dates: `${c.leave.fromDate}..${c.leave.toDate}`, waitingOn: cur ? `${cur.level}: ${cur.approverName || '(none)'}` : '(no pending step)', steps: steps.length });
  }
  (await prisma.approvalLevelConfig.findMany({ select: { id: true } })).filter((r) => !levelBefore.has(r.id)).forEach((r) => man.created.ApprovalLevelConfig.push(r.id));

  L.counts = counts(L.rows, (r) => r.outcome);
  report.manifest = man;
  return man;
}

// ------------------------------------------------------------------ UNDO
async function undo(manifestPath) {
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (path.resolve(man.db).toLowerCase() !== WORK_DB.toLowerCase()) throw new Error(`this manifest belongs to ${man.db}, not ${WORK_DB}`);
  return undoManifest(man);
}
async function undoManifest(man, { force = false } = {}) {
  const c = man.created; const ch = man.changed;
  const out = {};
  // safety: a created Pending request that somebody has since decided, or an employee that now has a login, is not rolled back silently
  const emps = c.Employee.length ? await prisma.employee.findMany({ where: { id: { in: c.Employee } } }) : [];
  for (const e of emps) if (e.userId) throw new Error(`${e.employeeCode} has a login now - not undoing automatically`);
  if (!force && !flag('--force')) {
    const steps = c.ApprovalStep.length ? await prisma.approvalStep.findMany({ where: { id: { in: c.ApprovalStep } } }) : [];
    const acted = steps.filter((s) => ['Approved', 'Rejected'].includes(s.status));
    if (acted.length) throw new Error(`${acted.length} approval step(s) of the loaded Pending requests have been acted on since the load - undo would erase those decisions. Re-run with --force to override.`);
  }
  await prisma.$transaction(async (tx) => {
    out.ApprovalStep = (await tx.approvalStep.deleteMany({ where: { id: { in: c.ApprovalStep } } })).count;
    out.ApprovalLevelConfig = (await tx.approvalLevelConfig.deleteMany({ where: { id: { in: c.ApprovalLevelConfig } } })).count;
    // the leave balance: take back exactly the days this load drew
    out.balanceRestored = 0;
    for (const b of ch.LeaveBalance) {
      const cur = await tx.leaveBalance.findUnique({ where: { id: b.id } });
      if (!cur) continue;
      await tx.leaveBalance.update({ where: { id: b.id }, data: { taken: Math.max(0, round2(cur.taken - b.deltaTaken)) } });
      // @updatedAt moves on every write; put the original stamp back so the row is exactly as it was
      if (b.before && b.before.updatedAt) await tx.$executeRawUnsafe('UPDATE "LeaveBalance" SET "updatedAt" = ? WHERE id = ?', new Date(b.before.updatedAt).getTime(), b.id);
      out.balanceRestored += 1;
    }
    out.AuditLog = (await tx.auditLog.deleteMany({ where: { id: { in: c.AuditLog } } })).count;
    out.LeaveRequest = (await tx.leaveRequest.deleteMany({ where: { id: { in: c.LeaveRequest } } })).count;
    // balance rows this load created: remove when nothing else uses them
    out.LeaveBalance = 0;
    for (const id of c.LeaveBalance) {
      const cur = await tx.leaveBalance.findUnique({ where: { id } });
      if (cur && cur.taken === 0) { await tx.leaveBalance.delete({ where: { id } }); out.LeaveBalance += 1; }
    }
    out.AttendancePunch = (await tx.attendancePunch.deleteMany({ where: { id: { in: c.AttendancePunch } } })).count;
    // day rows we filled: put the blanks back (only where the value is still the one we wrote)
    out.attendanceRestored = 0;
    for (const r of ch.Attendance) {
      const cur = await tx.attendance.findUnique({ where: { id: r.id } });
      if (!cur) continue;
      const data = {};
      if (r.set.checkIn !== undefined && cur.checkIn === r.set.checkIn) data.checkIn = r.before.checkIn;
      if (r.set.checkOut !== undefined && cur.checkOut === r.set.checkOut) data.checkOut = r.before.checkOut;
      if (Object.keys(data).length) { await tx.attendance.update({ where: { id: r.id }, data }); out.attendanceRestored += 1; }
    }
    out.Attendance = (await tx.attendance.deleteMany({ where: { id: { in: c.Attendance } } })).count;
    out.historyRestored = 0;
    for (const r of ch.AttendanceHistory) {
      const b = r.before;
      const data = {
        firstCheckIn: b.firstCheckIn, lastCheckOut: b.lastCheckOut, totalTimeWorked: b.totalTimeWorked, totalBreak: b.totalBreak, totalHours: b.totalHours,
        workLocation: b.workLocation, punchTimes: b.punchTimes, sources: b.sources, result: b.result, importBatch: b.importBatch, importedById: b.importedById,
      };
      await tx.attendanceHistory.update({ where: { id: r.id }, data }); out.historyRestored += 1;
      if (b.updatedAt) await tx.$executeRawUnsafe('UPDATE "AttendanceHistory" SET "updatedAt" = ? WHERE id = ?', new Date(b.updatedAt).getTime(), r.id);
    }
    out.AttendanceHistory = (await tx.attendanceHistory.deleteMany({ where: { id: { in: c.AttendanceHistory } } })).count;
    out.Employee = (await tx.employee.deleteMany({ where: { id: { in: c.Employee } } })).count;
  }, { maxWait: 60000, timeout: 300000 });
  return out;
}

// ------------------------------------------------------------------ CHECKS (read-only)
async function tilesFor(from, to) {
  const all = await prisma.employee.findMany();
  const roll = await D.rollOf(prisma, all);
  const employees = roll.employees.filter((e) => D.onRolls(e, from, to, roll.lastDayOf));
  const cfg = (await prisma.hrConfig.findFirst()) || {};
  const { days } = await D.loadDays(prisma, { employees, from, to, cfg, lastDayOf: roll.lastDayOf, preview: true });
  const dates = eachDay(from, to);
  const res = Object.fromEntries(dates.map((d) => [d, { date: d, headcount: 0, expectedHeadcount: 0, present: 0, absent: 0, halfDay: 0, onLeave: 0, offDay: 0, noRecord: 0, notYet: 0, other: 0 }]));
  const rowsOf = new Map();
  employees.forEach((e) => {
    const rows = days(e); rowsOf.set(e.id, rows);
    rows.forEach((d) => {
      const bk = D.bucketOf(d);
      if (!bk || bk === 'upcoming') return;
      const r = res[d.date]; if (!r) return;
      r.headcount += 1; if (r[bk] !== undefined) r[bk] += 1; else r.other += 1;
    });
    // headcount counted independently: on the rolls = joined by that day and not past their last day
    const joined = D.joinedOn(e);
    const left = roll.lastDayOf.has(e.id); const last = left ? roll.lastDayOf.get(e.id) : null;
    dates.forEach((d) => { if ((!joined || joined <= d) && !(left && (!last || d > last))) res[d].expectedHeadcount += 1; });
  });
  Object.values(res).forEach((r) => { r.sum = r.present + r.absent + r.halfDay + r.onLeave + r.offDay + r.noRecord + r.notYet + r.other; r.ok = r.sum === r.headcount && r.headcount === r.expectedHeadcount; });
  return { tiles: res, rowsOf, employees, cfg };
}

async function recompare(report) {
  const f1 = hist.parseCsv(readTxt(FILES.report)).rows;
  const f4 = hist.parseCsv(readTxt(FILES.logs)).rows;
  const emps = await prisma.employee.findMany({ select: { id: true, employeeCode: true, employmentStatus: true } });
  const byCode = new Map(emps.map((e) => [e.employeeCode.trim(), e]));
  const punches = await prisma.attendancePunch.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } });
  const pBy = new Map(); punches.forEach((p) => { const k = `${p.employeeId}|${p.date}`; (pBy.get(k) || pBy.set(k, []).get(k)).push(p); });
  const ahs = await prisma.attendanceHistory.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } });
  const ahBy = new Map(ahs.map((h) => [`${h.employeeRef}|${h.date}`, h]));
  const days = await prisma.attendance.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } });
  const dayBy = new Map(days.map((a) => [`${a.employeeId}|${a.date}`, a]));
  const clk = (t) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t || ''); return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}` : null; };
  const r = { checked: 0, checkedF1: 0, checkedF4Only: 0, mismatches: [], notChecked: [], hrMarksSeen: 0 };
  const f1Keys = new Set();
  for (const row of f1) {
    const code = (row['Employee Ref No'] || '').trim(); const date = hist.isoDate(row.Date);
    if (!inRange(date)) continue;
    const e = byCode.get(code);
    if (!e) { r.notChecked.push(`${code} ${date}: not in TeamLink`); continue; }
    if (LEFT.includes(e.employmentStatus)) { r.notChecked.push(`${code} ${date}: ${e.employmentStatus} - not loaded by design`); continue; }
    f1Keys.add(`${code}|${date}`);
    const first = clk(row['First Check In']); const last = clk(row['Last Check Out']);
    const ps = pBy.get(`${e.id}|${date}`) || [];
    const ins = ps.filter((p) => p.direction !== 'Out').map((p) => p.clockTime || `${p.time}:00`).sort();
    const outs = ps.filter((p) => p.direction === 'Out').map((p) => p.clockTime || `${p.time}:00`).sort();
    const gotFirst = ins[0] || null; const gotLast = outs.length ? outs[outs.length - 1] : null;
    r.checked += 1; r.checkedF1 += 1;
    const bad = [];
    if (first !== gotFirst) bad.push(`first-in file ${first} vs TeamLink ${gotFirst}`);
    if ((last || null) !== gotLast) bad.push(`last-out file ${last} vs TeamLink ${gotLast}`);
    const a = dayBy.get(`${e.id}|${date}`);
    if (a && (a.checkIn || a.checkOut)) {
      if ((a.checkIn || null) !== hhmm(first)) bad.push(`day row check-in ${a.checkIn} vs ${hhmm(first)}`);
      if ((a.checkOut || null) !== (last ? hhmm(last) : null)) bad.push(`day row check-out ${a.checkOut} vs ${last ? hhmm(last) : null}`);
    } else if (a) r.hrMarksSeen += 1; else bad.push('no Attendance day row');
    const h = ahBy.get(`${code}|${date}`);
    if (!h) bad.push('no history row');
    else {
      if ((h.firstCheckIn || null) !== first) bad.push(`history first ${h.firstCheckIn} vs ${first}`);
      if ((h.lastCheckOut || null) !== (last || null)) bad.push(`history last ${h.lastCheckOut} vs ${last || null}`);
    }
    if (bad.length) r.mismatches.push({ code, date, problems: bad });
  }
  for (const row of f4) {
    const [refPart] = String(row.Employee || '').split(' - '); const code = refPart.trim(); const date = hist.isoDate(row['Attendance Date']);
    if (!inRange(date)) continue;
    const e = byCode.get(code);
    if (!e || LEFT.includes(e.employmentStatus)) continue;
    const times = String(row['Time Interval'] || '').split('|').filter(Boolean).map((t) => clk(t.trim())).filter(Boolean);
    const h = ahBy.get(`${code}|${date}`);
    if (!f1Keys.has(`${code}|${date}`)) r.checkedF4Only += 1;
    r.checked += 1;
    const got = h && h.punchTimes ? h.punchTimes.split('|').map(clk).join('|') : null;
    if (got !== times.join('|')) r.mismatches.push({ code, date, problems: [`biometric log "${times.join('|')}" vs history "${got}"`] });
  }
  return r;
}

// the PulseHRM summary vs TeamLink's own engine, per employee, with the day-level reason
async function summaryCompare(tilesRes, report) {
  const f1 = hist.parseCsv(readTxt(FILES.report)).rows.filter((r) => inRange(hist.isoDate(r.Date)));
  const f3 = hist.parseCsv(readTxt(FILES.summary)).rows;
  const f1By = {};
  f1.forEach((r) => { (f1By[(r['Employee Ref No'] || '').trim()] = f1By[(r['Employee Ref No'] || '').trim()] || {})[hist.isoDate(r.Date)] = r; });
  const leave = await readLeaveXlsx();
  const HOL = new Set((await prisma.holiday.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } })).map((h) => h.date));
  const isSun = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
  const lvDay = {};
  leave.filter((x) => x.status === 'Approved').forEach((x) => { for (const d of eachDay(x.from, x.to)) { if (isSun(d) || HOL.has(d)) continue; (lvDay[x.code] = lvDay[x.code] || {})[d] = x.dur === 0.5 ? 0.5 : 1; } });
  const model = (code, d) => {
    const l = (lvDay[code] || {})[d]; if (l) return { p: 0, l, w: `approved leave ${l}` };
    const r = (f1By[code] || {})[d]; if (!r) return { p: 0, l: 0, w: 'no punches' };
    const w = sec(r['Total Time Worked']); const out = !!r['Last Check Out'];
    if (!out) return { p: 0, l: 0, w: 'single punch (PulseHRM gives no credit)' };
    if (w < 4 * 3600) return { p: 0, l: 0, w: `worked ${hms(w)} (<4h, no credit in PulseHRM)` };
    if (w < 9 * 3600) return { p: 0.5, l: 0, w: `worked ${hms(w)} (4-9h = half day in PulseHRM)` };
    return { p: 1, l: 0, w: `worked ${hms(w)}` };
  };
  const emps = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, employmentStatus: true } });
  const byCode = new Map(emps.map((e) => [e.employeeCode.trim(), e]));
  const dates = eachDay(RANGE.from, RANGE.to);
  const rows = [];
  for (const r of f3) {
    const code = (r['Employee Ref No'] || '').trim();
    const file = { half: +r['Half-Day'], present: +r.Present, wo: +r['Week Offs'], ph: +r['Public Holidays'], leaves: +r.Leaves, payable: +r['Payable Days'], hours: r['Total Hours'] };
    const e = byCode.get(code);
    const row = { code, name: e ? e.name : tidy(String(r['Employee Name']).replace(/^[^-]*-/, '')), tlStatus: e ? e.employmentStatus : 'not in TeamLink', file, engine: null, diffs: [], reasons: [] };
    const days = e ? tilesRes.rowsOf.get(e.id) : null;
    if (!days) { row.reasons.push(e ? `${e.employmentStatus} in TeamLink: not on the rolls, the engine counts nothing` : 'not in TeamLink'); rows.push(row); continue; }
    const counted = days.filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status));
    const present = counted.filter((d) => d.present === 1).length; const half = counted.filter((d) => d.present === 0.5).length;
    const wo = counted.filter((d) => d.status === 'Weekly Off').length; const ph = counted.filter((d) => d.status === 'Holiday').length;
    const leaves = round2(counted.reduce((n, d) => n + (Number(d.leave) || 0), 0));
    const s = D.summarise(counted);
    const payable = round2(s.paidDays + s.weeklyOffs + s.holidays);
    let hoursSecs = 0;
    days.forEach((d) => { if (d.checkIn && d.checkOut) { const a = sec(d.checkIn); const b = sec(d.checkOut); if (b > a) hoursSecs += b - a; } });
    row.engine = { half, present, wo, ph, leaves, payable, hours: hms(hoursSecs) };
    // hours from the clock times of the punches themselves (seconds)
    const fileSecs = sec(file.hours) || 0;
    const cmp = (k, a, b) => { if (k === 'hours' ? a !== b : Math.abs(a - b) > 1e-9) row.diffs.push(`${k}: PulseHRM ${a} / TeamLink ${b}`); };
    cmp('present', file.present, present); cmp('half', file.half, half); cmp('week offs', file.wo, wo); cmp('holidays', file.ph, ph); cmp('leaves', file.leaves, leaves); cmp('payable', file.payable, payable);
    void fileSecs;
    for (const d of dates) {
      if (isSun(d) || HOL.has(d)) continue;
      const dr = days.find((x) => x.date === d); if (!dr || ['Upcoming', 'Not Joined', 'Left'].includes(dr.status)) continue;
      const m = model(code, d);
      if (Math.abs((dr.present || 0) - m.p) > 1e-9 || Math.abs((dr.leave || 0) - m.l) > 1e-9) {
        const tag = m.l > 0 && Math.abs(dr.leave - m.l) < 1e-9 && dr.present > 0 ? 'HALF LEAVE + THE OTHER HALF WORKED (PulseHRM shows only the leave)' : m.p === 0.5 && dr.present === 1 ? 'HALF-DAY RULE' : m.p === 0 && m.l === 0 && dr.present > 0 ? (dr.checkIn ? 'SINGLE/DOUBLE-PUNCH OR SHORT DAY COUNTED' : 'HR MARK') : m.l !== dr.leave ? 'LEAVE HANDLING' : 'OTHER';
        row.reasons.push(`${d.slice(5)}: PulseHRM ${m.w}; TeamLink ${dr.status}${dr.checkIn ? ` (${dr.checkIn}-${dr.checkOut || '?'})` : ''} [${tag}]`);
      }
    }
    if (days.some((d) => d.sandwich)) row.reasons.push('TeamLink turns a holiday/Sunday between two leave days into leave (sandwich rule) - PulseHRM does not');
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------------ REPORT (markdown)
function md(report) {
  const o = [];
  const p = (s = '') => o.push(s);
  const A = report.attendance; const L = report.leave;
  p(`# PulseHRM load ${RANGE.from} .. ${RANGE.to} - ${report.mode === 'dry' ? 'DRY RUN (nothing written to the target database)' : report.mode.toUpperCase()}`);
  p(`Generated ${new Date().toISOString()} · target ${DB_ARG} · inputs ${DIR}`);
  p('');
  p('## 1. Counts (what --apply writes)');
  const c = report.manifest.created; const ch = report.manifest.changed;
  p('| Table | Rows created | Rows changed |');
  p('|---|---|---|');
  [['Employee', c.Employee.length, 0], ['Attendance (day rows)', c.Attendance.length, ch.Attendance.length], ['AttendancePunch', c.AttendancePunch.length, 0], ['AttendanceHistory', c.AttendanceHistory.length, ch.AttendanceHistory.length],
    ['LeaveRequest', c.LeaveRequest.length, 0], ['LeaveBalance', c.LeaveBalance.length, ch.LeaveBalance.length], ['ApprovalStep', c.ApprovalStep.length, 0], ['AuditLog', c.AuditLog.length, 0]]
    .forEach(([t, n, m]) => p(`| ${t} | ${n} | ${m} |`));
  p('');
  p('Attendance summary file: NOT loaded (0 AttendanceHistorySummary rows). 9 Oct: NOT loaded.');
  p('');
  p('## 2. Employees');
  report.employees.toCreate.forEach((f) => p(`- CREATE ${f.code} ${f.name} · PulseHRM dept "${f.dept}" / "${f.desig}" -> TeamLink dept ${NEW_DEPT ? `"${NEW_DEPT}"` : '(empty, HR assigns)'} · designation Employee · Active · Full-time · no login · no join date (first punch ${f.firstDate})`));
  report.employees.alreadyThere.forEach((s) => p(`- already there: ${s}`));
  p('');
  p('## 3. Attendance');
  p(`Importer plan for the range (${A.outsideRange} day rows outside the range left out - ${Object.entries(A.outsideRangeDates).map(([d, n]) => `${d}: ${n}`).join(', ')}): ${JSON.stringify(A.planByAction)}`);
  p(`Written: ${A.created.Attendance} day rows created, ${A.filled} day rows filled, ${A.created.AttendanceHistory} history rows created, ${A.histUpdated} history rows updated (completed), ${A.created.AttendancePunch} punches added. Already in TeamLink and identical (left as they are): ${A.skippedSame}.`);
  p('');
  p('| Date | Day rows in files | Created | Filled | Completed (29 Sep fix) | History only | Same already | Not loaded (Relieved/Exited) | Punches added |');
  p('|---|---|---|---|---|---|---|---|---|');
  Object.keys(A.perDate).sort().forEach((d) => { const x = A.perDate[d]; p(`| ${d} | ${x.files} | ${x.created} | ${x.filled} | ${x.completed} | ${x.histOnly} | ${x.same} | ${x.excluded} | ${x.punches} |`); });
  p('');
  p(`### Completed days (the 29 Sep fix and similar): ${A.completed.length}`);
  p(A.completed.map((x) => `${x.code} ${x.date} ${x.first || '-'} / ${x.last || '-'}`).join('; ') || '(none)');
  p('');
  p(`### HR manual marks in the range - NOT touched (${A.hrMarksUntouched.length})`);
  p(A.hrMarksUntouched.map((x) => `${x.code} ${x.date} ${x.status}`).join('; ') || '(none)');
  p('');
  p(`### People NOT loaded because TeamLink has them Relieved / Exited (${new Set(A.excluded.map((x) => x.code)).size} people, ${A.excluded.length} day rows)`);
  Object.entries(counts(A.excluded, (x) => `${x.code} ${x.name} (${x.status})`)).forEach(([k, n]) => p(`- ${k}: ${n} day(s) with punches in the files: ${A.excluded.filter((x) => `${x.code} ${x.name} (${x.status})` === k).map((x) => `${x.date} ${x.firstCheckIn || '-'}/${x.lastCheckOut || '-'}`).join(', ')}`));
  p('');
  p(`### Rows not loaded - employee not in TeamLink (${A.notLoaded.length})`);
  p(A.notLoaded.map((x) => `${x.code} ${x.date}`).join('; ') || '(none)');
  p('');
  p(`### Existing TeamLink history that differs from the file and was left alone (${A.skippedDifferent.length})`);
  A.skippedDifferent.forEach((x) => p(`- ${x.code} ${x.date}: TeamLink ${x.theirs} vs file ${x.file}`));
  p('');
  p('### Per employee (days loaded / punches added)');
  p(Object.values(A.perEmployee).sort((a, b) => a.code.localeCompare(b.code)).map((x) => `${x.code} ${x.name}: ${x.days} / ${x.punches}`).join('\n'));
  p('');
  p('## 4. Leave');
  p(`Outcome counts: ${JSON.stringify(L.counts)}`);
  p('');
  p('| File row | Employee | Type | From | To | File days | Half (file) | Status | Outcome | Stored |');
  p('|---|---|---|---|---|---|---|---|---|---|');
  L.rows.forEach((x) => p(`| ${x.row} | ${x.code} ${x.name} | ${x.type} | ${x.from} | ${x.to} | ${x.dur} | ${x.fileHalf || ''} | ${x.status} | ${x.outcome}${x.note ? ` - ${x.note}` : ''} | ${x.stored ? `days ${x.stored.days}${x.stored.half ? `, "Half day: ${x.stored.half}" (${x.stored.halfNote})` : x.stored.halfNote ? `, ${x.stored.halfNote}` : ''}; calendar span ${x.stored.calendarSpan}` : ''} |`));
  p('');
  p('Balance effect of the Approved rows (taken = days used; balances are the PulseHRM figures imported on 28 Sep):');
  L.balance.forEach((b) => p(`- ${b.code} ${b.name} · ${b.type}: taken ${b.before} -> ${b.after} (+${b.delta}) of ${b.total}`));
  const tot = {}; L.balance.forEach((b) => { tot[b.type] = round2((tot[b.type] || 0) + b.delta); });
  p(`Total drawn: ${JSON.stringify(tot)}`);
  p('');
  p('Pending requests created (approval chain laid down like a normal application, silent):');
  L.pendingChains.forEach((x) => p(`- ${x.code} ${x.name} ${x.dates}: now waiting on ${x.waitingOn} (${x.steps} steps)`));
  p('');
  p('## 5. Checks on the loaded copy');
  const V = report.verify;
  p(`HR manual marks (${V.hrMarksIntact === undefined ? '' : ''}${report.attendance.hrMarksUntouched.length}) still exactly as they were: ${V.hrMarksIntact ? 'YES' : 'NO'}`);
  p(`Re-compare of the files against TeamLink: ${V.recompare.checked} day-checks (${V.recompare.checkedF1} report days, ${V.recompare.checkedF4Only} biometric-log-only days) -> ${V.recompare.mismatches.length} mismatch(es). ${V.recompare.notChecked.length} file day(s) not checked (Relieved/Exited by design).`);
  V.recompare.mismatches.forEach((m) => p(`- MISMATCH ${m.code} ${m.date}: ${m.problems.join('; ')}`));
  p('');
  p('Dashboard tiles (Present + Absent + Half day + On leave + Week off/Holiday [+ No device data + Not checked in yet] = Headcount), engine rule preview, BEFORE -> AFTER the load:');
  p('| Date | Headcount before -> after | Present | Absent | Half day | On leave | Week off/Holiday | No device data | Equation after |');
  p('|---|---|---|---|---|---|---|---|---|');
  Object.keys(V.after).sort().forEach((d) => { const b = V.before[d]; const a = V.after[d]; p(`| ${d} | ${b.headcount} -> ${a.headcount} | ${b.present} -> ${a.present} | ${b.absent} -> ${a.absent} | ${b.halfDay} -> ${a.halfDay} | ${b.onLeave} -> ${a.onLeave} | ${b.offDay} -> ${a.offDay} | ${b.noRecord} -> ${a.noRecord} | ${a.ok ? 'OK' : `FAIL sum ${a.sum} vs ${a.headcount} / independent ${a.expectedHeadcount}`} |`); });
  p('');
  p('## 6. PulseHRM attendance-summary vs TeamLink engine (27 Sep - 8 Oct) - differences only');
  p('Rule differences are expected: PulseHRM = 9h full / 4-9h half / under 4h or a lone punch no credit; TeamLink = clock rule (in 9:00-1:30, out after 5/6 PM). The rule is NOT changed by this load.');
  report.summaryRows.filter((r) => r.diffs.length || r.reasons.length).forEach((r) => {
    p(`- ${r.code} ${r.name} [${r.tlStatus}]${r.engine ? ` PulseHRM present ${r.file.present}/half ${r.file.half}/WO ${r.file.wo}/PH ${r.file.ph}/leave ${r.file.leaves}/payable ${r.file.payable}; TeamLink ${r.engine.present}/${r.engine.half}/${r.engine.wo}/${r.engine.ph}/${r.engine.leaves}/${r.engine.payable}` : ''}`);
    r.reasons.forEach((x) => p(`    - ${x}`));
  });
  const same = report.summaryRows.filter((r) => !r.diffs.length && !r.reasons.length).length;
  p(`Employees whose summary matches TeamLink exactly: ${same} of ${report.summaryRows.length}.`);
  return o.join('\n');
}

// ------------------------------------------------------------------ MAIN
(async () => {
  const report = { mode: MODE, db: DB_ARG };
  try {
    if (MODE === 'undo') {
      const mp = path.resolve(opt('--undo'));
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bk = path.join(BACKUP_DIR, 'teamlink-before-undo.db');
      snapshot(WORK_DB, bk);
      console.log(`backup before undo: ${bk}`);
      const r = await undo(mp);
      console.log('UNDO done:', JSON.stringify(r));
      process.exit(0);
    }
    if (MODE === 'verify') {
      const rc = await recompare(report);
      const t = await tilesFor(RANGE.from, RANGE.to);
      console.log(JSON.stringify({ recompare: { checked: rc.checked, mismatches: rc.mismatches, notChecked: rc.notChecked.length }, tiles: Object.values(t.tiles) }, null, 1));
      process.exit(rc.mismatches.length || Object.values(t.tiles).some((x) => !x.ok) ? 1 : 0);
    }
    const before = await tilesFor(RANGE.from, RANGE.to);
    if (MODE === 'apply') {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bk = path.join(BACKUP_DIR, 'teamlink-before.db');
      snapshot(WORK_DB, bk);
      console.log(`full backup copy: ${bk}`);
      report.backup = bk;
    }
    let man;
    try {
      man = await load(report);
    } catch (err) {
      console.error('LOAD FAILED:', err.stack || err.message);
      if (MODE === 'apply' && CURRENT) {
        // put back whatever the failed run already committed (employees / attendance / leave stages)
        const mf = path.join(BACKUP_DIR, 'manifest-failed-run.json');
        fs.writeFileSync(mf, JSON.stringify(CURRENT, null, 1));
        try { console.error('ROLLED BACK the partial run:', JSON.stringify(await undoManifest(CURRENT, { force: true }))); } catch (e2) { console.error(`could not roll back automatically (${e2.message}); restore the backup ${report.backup} or run --undo ${mf}`); }
      }
      throw err;
    }
    if (MODE === 'apply') {
      man.backup = report.backup;
      const mf = path.join(BACKUP_DIR, 'manifest.json');
      fs.writeFileSync(mf, JSON.stringify(man, null, 1));
      console.log(`manifest: ${mf}`);
      report.manifestFile = mf;
    }
    const after = await tilesFor(RANGE.from, RANGE.to);
    report.verify = { recompare: await recompare(report), before: before.tiles, after: after.tiles };
    const marks = report.attendance.hrMarksUntouched;
    const nowMarks = marks.length ? await prisma.attendance.findMany({ where: { id: { in: marks.map((m) => m.id) } } }) : [];
    report.verify.hrMarksIntact = nowMarks.length === marks.length && nowMarks.every((a) => !a.checkIn && !a.checkOut && marks.find((m) => m.id === a.id).status === a.status);
    report.summaryRows = await summaryCompare(after, report);
    const text = md(report);
    const out = opt('--report');
    if (out) fs.writeFileSync(out, text);
    const jf = opt('--json');
    if (jf) fs.writeFileSync(jf, JSON.stringify({ ...report, manifest: { ...man } }, null, 1));
    console.log(text);
    const bad = report.verify.recompare.mismatches.length + Object.values(after.tiles).filter((x) => !x.ok).length;
    console.log(`\nSUMMARY (${MODE}): mismatches ${report.verify.recompare.mismatches.length}, equation failures ${Object.values(after.tiles).filter((x) => !x.ok).length}`);
    if (MODE === 'dry') console.log('DRY RUN: nothing was written to the target database. To apply for real: see the header of this file.');
    process.exitCode = bad ? 1 : 0;
  } catch (err) {
    console.error('FAILED:', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
    if (TEMP_DB) for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(TEMP_DB + s); } catch { /* gone */ } }
  }
})();
