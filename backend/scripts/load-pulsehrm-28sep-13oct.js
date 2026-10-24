#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop, no-restricted-syntax */
// ---------------------------------------------------------------------------
// ONE-SHOT LOADER - PulseHRM attendance + leave, 28 Sep 2026 .. 13 Oct 2026
// (the user's 2026-10-13 exports). Safe to run again: it creates nothing twice.
//
// FILES (default folder C:/Users/user/Downloads, all treated as DATA only):
//   1. bio-metric_logs (6).csv           every punch of every day (the RAW punches)
//   2. attendance_summary_from_28-sep-2026_to_13-oct-2026.csv   period totals (used ONLY to reconcile)
//   3. first_check-in_&_last_check-out_report_form_28-sep-2026_to_13-oct-2026.csv   first-in / last-out (cross-check + check-out authority)
//   4. Leave History (3).csv             leave requests (.xlsx also accepted)
//
// WHAT --apply WRITES (nothing outside --from .. --to for attendance)
//   * PEOPLE        matched by Employee ID first (name / department / designation only checked).
//                   An ID that is not in TeamLink is only REPORTED (use --create-missing-employees to create a
//                   minimal record like TL518). Relieved / Exited people are NOT loaded (use --include-left TLxxx).
//                   Departments are never changed from Pulse.
//   * PUNCHES       EVERY raw punch of file 1 becomes an AttendancePunch row (method "Biometric", source
//                   "PulseHRM import", verification "Imported", exact HH:MM:SS, IST). The first punch of the day is an
//                   In; the last one is an Out only when the first/last report (file 3) has a check-out for the day
//                   (a missing check-out is never invented). The report's own first / last time is added if the log does
//                   not carry it (method "PulseHRM import"). utils/punchGuard.js (live punches) is NOT applied; no raw punch
//                   is collapsed. A punch that already exists (same person + same HH:MM:SS) is skipped, so web check-ins
//                   and earlier imports stay untouched and BOTH kinds remain visible. userAgent carries the load tag.
//   * DAYS          as the earlier PulseHRM loads: AttendanceHistory row (raw log + report values), and an Attendance day
//                   row (Present, check-in / check-out) when the report has the day and TeamLink has none; blank times
//                   of an existing Present / Half Day / Late day are filled; nothing else is edited. The STATUS of every
//                   day (present / late / half / absent / on leave / holiday / Sunday off) is never stored by this
//                   script: utils/attendanceDays.js works it out from punches + leaves + holidays, exactly as the app.
//                   Days with an approved regularization, an HR-typed punch, or an HR mark that is Absent / Leave /
//                   has no times are left alone and listed.
//   * LEAVE         through utils/pulseSync.js plan() (match by employee id + type + from + to + half): Pulse Approved /
//                   Cancelled / Rejected / Pending rows TeamLink does not have are CREATED (Source = Pulse sync, approver
//                   name + date from Pulse, no notification); a TeamLink Pending that Pulse decided is UPDATED; same state
//                   = unchanged; TeamLink-only pending rows are listed. Extra guards: the same leave listed twice in the
//                   file keeps the Approved one; a request that overlaps another type's Pending/Approved request in
//                   TeamLink is skipped for HR. Balances are NOT moved for created rows (as the Pulse sync); --draw-balance
//                   draws Approved current-year days the way the earlier loader did.
//   * ONE HR summary bell (unless --no-bell). No employee is notified.
//
// MODES (default = DRY RUN)
//   node scripts/load-pulsehrm-28sep-13oct.js [--db <file>] [--dir <folder>] [--report <md>] [--csv <prefix>] [--json <file>]
//        DRY RUN: copies the db (VACUUM INTO, read-only on the source), runs the WHOLE load on the copy, prints every table,
//        deletes the copy. The real database is never written.
//   ... --apply            backup first (VACUUM INTO), ONE transaction for data, undo manifest, idempotency marker.
//   ... --undo <manifest>  exact reverse of one --apply.
//   ... --verify           read-only check of the files against the db.
//   --from / --to          default 2026-09-28 / 2026-10-13.
//   --include-left TL424,..   load these Relieved / Exited people anyway.
//   --create-missing-employees  create minimal employee records for ids not in TeamLink that have punches.
//   --draw-balance / --no-bell / --force-rerun / --backup-dir <dir>
//   The real dev.db is refused for --apply / --undo unless  --really-real  AND env TL_ALLOW_REAL_APPLY=1.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BACKEND = path.resolve(__dirname, '..');
const REAL_DB = path.join(BACKEND, 'prisma', 'dev.db');
const LEFT = ['Relieved', 'Exited'];
const MARKER_KEY = 'attendance.load.pulse-28sep-13oct';
const STATUS_MAP = { approved: 'Approved', pending: 'Pending', rejected: 'Rejected', declined: 'Rejected', cancelled: 'Cancelled', canceled: 'Cancelled', withdrawn: 'Cancelled' };
const STATUS_RANK = { Approved: 4, Pending: 3, Rejected: 2, Cancelled: 1 };

// ------------------------------------------------------------------ pure helpers (no db)
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sec = (t) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t || ''); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
const hms = (s) => (s == null ? '' : `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
const hhmm = (t) => (t ? t.slice(0, 5) : null);
const clk = (t) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}` : null; };
const eachDay = (a, b) => { const o = []; const d = new Date(`${a}T00:00:00Z`); const e = new Date(`${b}T00:00:00Z`); for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) o.push(d.toISOString().slice(0, 10)); return o; };
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const counts = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normName = (s) => tidy(s).toLowerCase();
const normDesig = (s) => { const a = alnum(s).replace('recuiter', 'recruiter'); return a === 'tl' ? 'teamlead' : a; };
const initials = (s) => tidy(s).split(' ').filter(Boolean).map((w) => w[0].toUpperCase()).join('.');
const isSunday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
const GAP_SEC = 120; // punches closer than this are one visit to the device

// "bio-metric log" line -> sorted unique HH:MM:SS list
const timesOf = (cell) => [...new Set(String(cell || '').split('|').map((t) => clk(t)).filter(Boolean))].sort();

// Direction of each punch of one day. First punch In. The Out cluster only when the first/last report has a check-out.
function directions(times, lastOut) {
  const dir = new Map(times.map((t) => [t, 'In']));
  if (!lastOut || !times.includes(lastOut) || times.length < 2 || times[0] === lastOut) return dir;
  const secs = times.map(sec);
  const cl = [];
  secs.forEach((v, i) => { if (!i || v - secs[i - 1] > GAP_SEC) cl.push([times[i]]); else cl[cl.length - 1].push(times[i]); });
  if (cl.length === 1) { dir.set(lastOut, 'Out'); return dir; }
  const lastIdx = cl.findIndex((c) => c.includes(lastOut));
  // counting back from the Out cluster: Out, In, Out ... ; the very first visit is always an In
  for (let k = lastIdx, flip = 0; k >= 1; k -= 1, flip += 1) cl[k].forEach((t) => dir.set(t, flip % 2 === 0 ? 'Out' : 'In'));
  return dir;
}

function readLeaveCsv(text, hist, toIso) {
  const rows = hist.parseCsv(text).rows;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = [];
  rows.forEach((r, i) => {
    const get = (...names) => { const k = Object.keys(r).find((x) => names.some((n) => norm(x) === norm(n))); return k === undefined ? '' : r[k]; };
    const code = tidy(get('Employee ID', 'Employee Number', 'Employee Code'));
    if (!code && !tidy(get('Leave From'))) return;
    const half = tidy(get('Half Day', 'Half Day Type'));
    const dur = Number(get('Duration', 'Days'));
    const raw = tidy(get('Status'));
    out.push({
      row: i + 2, code, name: tidy(get('Employee Name', 'Name')), type: tidy(get('Leave Type')),
      from: toIso(get('Leave From', 'From')), to: toIso(get('Leave To', 'To')) || toIso(get('Leave From', 'From')),
      appliedOn: toIso(get('Date Of Application', 'Applied On')),
      half: /first/i.test(half) ? 'First Half' : /second/i.test(half) ? 'Second Half' : (half && !/^(no|n|false|0)$/i.test(half) ? 'Half' : (dur === 0.5 ? 'Half' : '')),
      days: Number.isFinite(dur) && dur > 0 ? dur : null, reason: tidy(get('Reason')), comments: tidy(get('Comments')),
      approver: tidy(get('Approver')), approverComments: tidy(get('Approver Comments')), approvedOn: toIso(get('Approved Date')),
      status: STATUS_MAP[raw.toLowerCase()] || null, rawStatus: raw,
    });
  });
  return out;
}

// ------------------------------------------------------------------ the loader (everything below runs only from main())
async function main(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const RANGE = { from: opt('--from', '2026-09-28'), to: opt('--to', '2026-10-13') };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(RANGE.from) || !/^\d{4}-\d{2}-\d{2}$/.test(RANGE.to) || RANGE.from > RANGE.to) throw new Error(`bad --from/--to: ${RANGE.from} .. ${RANGE.to}`);
  const inRange = (d) => d >= RANGE.from && d <= RANGE.to;
  const DIR = opt('--dir', 'C:/Users/user/Downloads');
  const FILES = {
    logs: opt('--logs', 'bio-metric_logs (6).csv'),
    summary: opt('--summary', 'attendance_summary_from_28-sep-2026_to_13-oct-2026.csv'),
    report: opt('--attendance-report', 'first_check-in_&_last_check-out_report_form_28-sep-2026_to_13-oct-2026.csv'),
    leave: opt('--leave', 'Leave History (3).csv'),
  };
  const filePath = (f) => (path.isAbsolute(f) ? f : path.join(DIR, f));
  const MODE = flag('--undo') ? 'undo' : flag('--apply') ? 'apply' : flag('--verify') ? 'verify' : 'dry';
  const DB_ARG = path.resolve(opt('--db', REAL_DB));
  const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const BACKUP_DIR = path.resolve(opt('--backup-dir', path.join(BACKEND, 'backups', `pulsehrm-load-28sep-13oct-${STAMP}`)));
  const INCLUDE_LEFT = new Set(String(opt('--include-left', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const CREATE_MISSING = flag('--create-missing-employees');
  const DRAW_BALANCE = flag('--draw-balance');
  const BELL = !flag('--no-bell');
  const isReal = (p) => path.resolve(p).toLowerCase() === REAL_DB.toLowerCase();
  const TAG = `Pulse load ${RANGE.from}..${RANGE.to} (${FILES.logs})`;
  const ACTOR = `PulseHRM load ${RANGE.from} - ${RANGE.to} (script)`;

  if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 62).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  for (const k of Object.keys(FILES)) if (MODE !== 'undo' && !fs.existsSync(filePath(FILES[k]))) throw new Error(`input file not found (${k}): ${filePath(FILES[k])}`);
  if ((MODE === 'apply' || MODE === 'undo') && isReal(DB_ARG) && (!flag('--really-real') || process.env.TL_ALLOW_REAL_APPLY !== '1')) {
    console.error(`REFUSED: ${MODE} on the real dev.db needs  --really-real  AND the environment variable TL_ALLOW_REAL_APPLY=1.`);
    return 2;
  }
  if (!fs.existsSync(DB_ARG)) throw new Error(`database not found: ${DB_ARG}`);

  function snapshot(src, dest) {
    const { DatabaseSync } = require('node:sqlite'); // eslint-disable-line global-require
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

  // which db does this process run on? (decided BEFORE src/db.js is required)
  let WORK_DB = DB_ARG; let TEMP_DB = null;
  if (MODE === 'dry') { TEMP_DB = path.join(os.tmpdir(), `tl-pulse-2813-${STAMP}-${process.pid}.db`); snapshot(DB_ARG, TEMP_DB); WORK_DB = TEMP_DB; }
  process.env.DATABASE_URL = `file:${WORK_DB.split(path.sep).join('/')}?connection_limit=1&socket_timeout=300`;
  process.env.TEST_MODE = process.env.TEST_MODE || '1';
  const prisma = require('../src/db'); // eslint-disable-line global-require
  const hist = require('../src/utils/attendanceHistoryImport'); // eslint-disable-line global-require
  const pulse = require('../src/utils/pulseSync'); // eslint-disable-line global-require
  const leaveText = require('../src/utils/leaveText'); // eslint-disable-line global-require
  const D = require('../src/utils/attendanceDays'); // eslint-disable-line global-require
  const workflow = require('../src/utils/approvalWorkflow'); // eslint-disable-line global-require
  const readTxt = (f) => fs.readFileSync(filePath(f), 'utf8');
  const inputHash = crypto.createHash('sha256').update(['logs', 'report', 'leave'].map((k) => fs.readFileSync(filePath(FILES[k]))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).digest('hex').slice(0, 16);

  const newManifest = () => ({
    version: 1, script: path.basename(__filename), createdAt: new Date().toISOString(), db: WORK_DB, range: RANGE, batch: null, backup: null, inputHash,
    created: { Employee: [], Attendance: [], AttendancePunch: [], AttendanceHistory: [], LeaveRequest: [], LeaveBalance: [], AuditLog: [], ApprovalStep: [], ApprovalLevelConfig: [], Notification: [], AppSetting: [] },
    changed: { Attendance: [], AttendanceHistory: [], LeaveBalance: [], LeaveRequest: [], AppSetting: [] },
  });
  let CURRENT = null;

  // ================================================================ THE LOAD
  async function load(report) {
    const man = newManifest(); CURRENT = man;
    man.batch = `pulse2813-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    report.batch = man.batch;
    const marker = await prisma.appSetting.findUnique({ where: { key: MARKER_KEY } });
    report.marker = marker ? JSON.parse(marker.value) : null;
    if (MODE === 'apply' && marker && report.marker.inputHash === inputHash && !flag('--force-rerun')) {
      report.alreadyApplied = true;
      throw new Error(`already applied on ${report.marker.at} (batch ${report.marker.batch}) with these same input files - nothing to do (use --force-rerun to run the idempotent pass anyway)`);
    }

    // ---- inputs
    const F4 = hist.parseCsv(readTxt(FILES.logs)).rows; // bio-metric log
    const F1 = hist.parseCsv(readTxt(FILES.report)).rows; // first/last report
    const F3 = hist.parseCsv(readTxt(FILES.summary)).rows; // summary
    const leaveRows = /\.xlsx$/i.test(FILES.leave) ? pulse.parseExport(fs.readFileSync(filePath(FILES.leave))).rows : readLeaveCsv(readTxt(FILES.leave), hist, pulse.toIso);
    report.inputs = { logs: { file: FILES.logs, rows: F4.length }, report: { file: FILES.report, rows: F1.length }, summary: { file: FILES.summary, rows: F3.length }, leave: { file: FILES.leave, rows: leaveRows.length }, inputHash };
    const logDays = new Map(); // code|date -> {code,name,dept,desig,times}
    F4.forEach((r) => {
      const [c, ...n] = String(r.Employee || '').split(' - '); const code = (c || '').trim(); const date = hist.isoDate(r['Attendance Date']);
      if (!code || !date || !inRange(date)) return;
      logDays.set(`${code}|${date}`, { code, date, name: tidy(n.join(' - ')), dept: tidy(r.Department), desig: tidy(r.Designation), times: timesOf(r['Time Interval']) });
    });
    const repDays = new Map();
    F1.forEach((r) => {
      const code = (r['Employee Ref No'] || '').trim(); const date = hist.isoDate(r.Date);
      if (!code || !date || !inRange(date)) return;
      repDays.set(`${code}|${date}`, { code, date, name: tidy(r['Employee Name']), dept: tidy(r.Department), desig: tidy(r.Designation), first: clk(r['First Check In']), last: clk(r['Last Check Out']), location: tidy(r['Work Location']) || null, worked: r['Total Time Worked'], breakT: r['Total Time In Break'], hours: r['Total Hours'] });
    });

    // ---- 1. MATCH TABLE
    const empNow = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, department: true, designation: true, employmentStatus: true } });
    const seats = await prisma.positionAssignment.findMany({ where: { toDate: null }, include: { position: true } }).catch(() => []);
    const seatsOf = new Map(); seats.forEach((s) => { (seatsOf.get(s.employeeId) || seatsOf.set(s.employeeId, []).get(s.employeeId)).push(s.position.code); });
    const fileP = new Map();
    const addP = (code, src, name, dept, desig) => {
      const c = String(code || '').trim(); if (!c) return;
      const o = fileP.get(c) || { code: c, names: new Set(), dept: '', desig: '', sources: new Set() };
      o.sources.add(src); if (tidy(name)) o.names.add(tidy(name)); if (!o.dept && tidy(dept)) o.dept = tidy(dept); if (!o.desig && tidy(desig)) o.desig = tidy(desig);
      fileP.set(c, o);
    };
    logDays.forEach((x) => addP(x.code, 'bio-metric log', x.name, x.dept, x.desig));
    repDays.forEach((x) => addP(x.code, 'first/last report', x.name, x.dept, x.desig));
    F3.forEach((r) => { const c = (r['Employee Ref No'] || '').trim(); addP(c, 'summary', String(r['Employee Name'] || '').replace(new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-`), ''), r.Department, r.Designation); });
    leaveRows.forEach((x) => addP(x.code, 'leave', x.name, '', ''));
    const byCode = new Map(empNow.map((e) => [e.employeeCode.trim().toUpperCase(), e]));
    const byName = new Map(); empNow.forEach((e) => { const k = normName(e.name); (byName.get(k) || byName.set(k, []).get(k)).push(e); });
    const matchRows = [];
    for (const f of [...fileP.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))) {
      const row = { code: f.code, fileNames: [...f.names], fileDept: f.dept, fileDesig: f.desig, sources: [...f.sources], cat: '', flags: [], tl: null };
      if (f.names.size > 1 && new Set([...f.names].map(normName)).size > 1) row.flags.push('two different names in the files for this id');
      let e = byCode.get(f.code.toUpperCase()) || null;
      if (!e) { const cand = byName.get(normName([...f.names][0])) || []; if (cand.length === 1) { e = cand[0]; row.flags.push(`TeamLink has this name under another id (${e.employeeCode})`); row.cat = 'ID DIFFERS (name matches)'; } }
      if (!e) { row.cat = f.code === '000' ? 'PSEUDO USER (excluded)' : 'ID NOT IN TEAMLINK'; matchRows.push(row); continue; }
      row.tl = { id: e.id, code: e.employeeCode, name: e.name, designation: e.designation || '', department: e.department || '', status: e.employmentStatus, seats: seatsOf.get(e.id) || [] };
      const nm = [...f.names][0] || '';
      const nameSame = normName(e.name) === normName(nm);
      if (f.code === '000') row.cat = 'PSEUDO USER (excluded)';
      else if (!nameSame) { row.cat = alnum(e.name) === alnum(nm) ? 'NAME DIFFERS (punctuation only)' : 'NAME DIFFERS'; row.flags.push(alnum(e.name) === alnum(nm) ? 'name differs only by punctuation/spacing' : 'name differs'); }
      const desigSame = !f.desig || normDesig(e.designation) === normDesig(f.desig);
      const deptSame = !f.dept || alnum(e.department) === alnum(f.dept);
      if (!desigSame) row.flags.push('designation differs (sanity only)');
      if (!deptSame) row.flags.push("department differs (Pulse's own list; TeamLink's is kept)");
      if (LEFT.includes(e.employmentStatus)) row.flags.push(`${e.employmentStatus} in TeamLink`);
      if (!row.cat) row.cat = (!desigSame || !deptSame) ? 'ID + NAME MATCH (Pulse dept/designation text differs)' : 'EXACT';
      matchRows.push(row);
    }
    report.match = matchRows;

    // ---- 2. missing employees (optional)
    report.employees = { toCreate: [], notCreated: [] };
    const hasPunches = (code) => [...logDays.keys(), ...repDays.keys()].some((k) => k.startsWith(`${code}|`));
    for (const m of matchRows.filter((x) => x.cat === 'ID NOT IN TEAMLINK')) {
      const days = new Set([...logDays.keys(), ...repDays.keys()].filter((k) => k.startsWith(`${m.code}|`)));
      const times = [...logDays.values()].filter((x) => x.code === m.code).reduce((n, x) => n + x.times.length, 0);
      const entry = { code: m.code, name: m.fileNames[0] || '', dept: m.fileDept, desig: m.fileDesig, days: days.size, punches: times };
      if (CREATE_MISSING && hasPunches(m.code)) report.employees.toCreate.push(entry); else report.employees.notCreated.push(entry);
    }
    if (report.employees.toCreate.length) {
      await prisma.$transaction(async (tx) => {
        for (const f of report.employees.toCreate) {
          const e = await tx.employee.create({ data: { employeeCode: f.code, name: f.name, department: null, designation: f.desig || 'Employee', location: 'Hyderabad', branch: 'Hyderabad', employmentStatus: 'Active', employeeType: 'Full-time', email: '', phone: '' } });
          man.created.Employee.push(e.id);
          const a = await tx.auditLog.create({ data: { userId: null, actorName: ACTOR, action: 'Employee created (PulseHRM load, no login)', entity: 'Employee', entityId: e.id, toValue: `${f.code} - imported from PulseHRM; no login, no welcome mail, department to be assigned by HR` } });
          man.created.AuditLog.push(a.id);
        }
      }, { maxWait: 60000, timeout: 120000 });
    }
    const emps = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, employmentStatus: true, department: true, userId: true } });
    const empByCode = new Map(emps.map((e) => [e.employeeCode.trim(), e]));
    const empById = new Map(emps.map((e) => [e.id, e]));

    // ---- 3. attendance plan
    const A = (report.attendance = {
      excluded: [], notLoaded: [], protectedDays: [], created: { Attendance: 0, AttendancePunch: 0, AttendanceHistory: 0 }, filled: 0, histUpdated: 0, punchesSkippedExisting: 0,
      perEmployee: {}, perDate: {}, crossCheck: { first: [], last: [], reportOnly: [], logOnly: [], missingOutInLog: [] }, hrMarks: [], daysNoChange: 0, existingPunchesNotInFile: 0, complexDays: [],
    });
    const byEmp = (c) => (A.perEmployee[c] = A.perEmployee[c] || { code: c, fileDays: 0, filePunches: 0, punchesCreate: 0, punchesSkip: 0, daysCreate: 0, daysFill: 0, histCreate: 0, histUpdate: 0 });
    const byDate = (d) => (A.perDate[d] = A.perDate[d] || { fileDays: 0, filePunches: 0, punchesCreate: 0, punchesSkip: 0, daysCreate: 0, daysFill: 0 });
    const allKeys = new Set([...logDays.keys(), ...repDays.keys()]);
    const ids = [...new Set([...allKeys].map((k) => (empByCode.get(k.split('|')[0]) || {}).id).filter(Boolean))];
    const [exDays, exAH, exPunches, exRegs] = await Promise.all([
      prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { gte: RANGE.from, lte: RANGE.to } } }),
      prisma.attendanceHistory.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } }),
      prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { gte: RANGE.from, lte: RANGE.to } } }),
      prisma.attendanceRegularization.findMany({ where: { employeeId: { in: ids }, date: { gte: RANGE.from, lte: RANGE.to }, status: 'Approved' } }),
    ]);
    const dayOf = new Map(exDays.map((a) => [`${a.employeeId}|${a.date}`, a]));
    const ahOf = new Map(exAH.map((h) => [`${h.employeeRef}|${h.date}`, h]));
    const punchTime = (p) => p.clockTime || `${p.time}:00`;
    const punchSet = new Set(exPunches.map((p) => `${p.employeeId}|${p.date}|${punchTime(p)}`));
    const punchesOfDay = new Map(); exPunches.forEach((p) => { (punchesOfDay.get(`${p.employeeId}|${p.date}`) || punchesOfDay.set(`${p.employeeId}|${p.date}`, []).get(`${p.employeeId}|${p.date}`)).push(p); });
    const regSet = new Set(exRegs.map((r) => `${r.employeeId}|${r.date}`));
    const EDITABLE = new Set(['Present', 'Half Day', 'Late']);
    A.hrMarks = exDays.filter((a) => !a.checkIn && !a.checkOut).map((a) => ({ id: a.id, code: (empById.get(a.employeeId) || {}).employeeCode, date: a.date, status: a.status }));
    const ops = [];
    for (const key of [...allKeys].sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]) || a.localeCompare(b))) {
      const [code, date] = key.split('|');
      const lg = logDays.get(key); const rp = repDays.get(key);
      const emp = empByCode.get(code);
      if (code === '000') continue; // the pseudo user is excluded as before
      const times = [...new Set([...(lg ? lg.times : []), ...(rp && rp.first ? [rp.first] : []), ...(rp && rp.last ? [rp.last] : [])])].sort();
      byDate(date).fileDays += 1; byDate(date).filePunches += times.length;
      // cross-check of file 3 (first / last) against file 1 (the log)
      if (lg && rp) {
        if (rp.first && lg.times[0] && rp.first !== lg.times[0]) A.crossCheck.first.push({ code, date, report: rp.first, log: lg.times[0] });
        if (rp.last && lg.times.length && rp.last !== lg.times[lg.times.length - 1]) A.crossCheck.last.push({ code, date, report: rp.last, log: lg.times[lg.times.length - 1] });
        if (!rp.last && lg.times.length > 1 && sec(lg.times[lg.times.length - 1]) - sec(lg.times[0]) > GAP_SEC) A.crossCheck.missingOutInLog.push({ code, date, log: lg.times.join('|') });
      } else if (rp && !lg) A.crossCheck.reportOnly.push({ code, date });
      else if (lg && !rp) A.crossCheck.logOnly.push({ code, date, times: lg.times.length });
      if (!emp) { A.notLoaded.push({ code, date, punches: times.length }); continue; }
      const left = LEFT.includes(emp.employmentStatus) && !INCLUDE_LEFT.has(code.toUpperCase());
      byEmp(code).fileDays += 1; byEmp(code).filePunches += times.length;
      if (left) { A.excluded.push({ code, status: emp.employmentStatus, date, punches: times.length }); continue; }
      const dk = `${emp.id}|${date}`;
      const a = dayOf.get(dk) || null; const eps = punchesOfDay.get(dk) || [];
      const manual = eps.some((p) => /manual/i.test(String(p.source || '')));
      let protect = null;
      if (regSet.has(dk)) protect = 'an approved attendance correction exists for this day';
      else if (manual) protect = 'a punch typed by HR exists for this day';
      else if (a && !EDITABLE.has(a.status)) protect = `TeamLink has this day marked ${a.status}`;
      else if (a && !a.checkIn && !a.checkOut && !eps.length) protect = `HR marked this day ${a.status} (no times)`;
      if (protect) { A.protectedDays.push({ code, date, why: protect, punches: times.length }); byEmp(code).punchesSkip += times.length; byDate(date).punchesSkip += times.length; continue; }
      const dir = directions(times, rp && rp.last ? rp.last : null);
      const inLog = new Set(lg ? lg.times : []);
      if (times.length > 3 && rp && rp.last) { const d0 = [...dir.values()]; if (d0.filter((x) => x === 'Out').length > 1 && d0.filter((x) => x === 'In').length > 1) A.complexDays.push({ code, date, times: times.length }); }
      const newPunches = []; let skipped = 0;
      for (const t of times) {
        if (punchSet.has(`${emp.id}|${date}|${t}`)) { skipped += 1; continue; }
        newPunches.push({ time: t, direction: dir.get(t), method: inLog.has(t) ? 'Biometric' : hist.SOURCE });
      }
      byEmp(code).punchesCreate += newPunches.length; byEmp(code).punchesSkip += skipped; byDate(date).punchesCreate += newPunches.length; byDate(date).punchesSkip += skipped;
      A.punchesSkippedExisting += skipped;
      ops.push({ emp, code, date, lg, rp, times, newPunches, a, dk });
    }
    // existing imported punches of loaded days that the new files do not carry (information only)
    for (const p of exPunches) { if (p.source !== hist.SOURCE) continue; const e = empById.get(p.employeeId); if (!e) continue; const k = `${e.employeeCode}|${p.date}`; const lg = logDays.get(k); const rp = repDays.get(k); const t = punchTime(p); if (!(lg && lg.times.includes(t)) && !(rp && (rp.first === t || rp.last === t))) A.existingPunchesNotInFile += 1; }

    await prisma.$transaction(async (tx) => {
      for (const op of ops) {
        const { emp, code, date, lg, rp, times, newPunches, a } = op;
        const first = rp && rp.first ? rp.first : null; const last = rp && rp.last ? rp.last : null;
        // history row (the raw log + report values, exactly as the earlier loads store it)
        const punchTimes = lg ? lg.times.join('|') : null;
        const prev = ahOf.get(`${code}|${date}`);
        const histData = {
          employeeRef: code, employeeId: emp.id, matchStatus: 'Matched', sourceName: null, date, firstCheckIn: first, lastCheckOut: last,
          totalTimeWorked: rp ? (rp.worked || null) : null, totalBreak: rp ? (rp.breakT || null) : null, totalHours: rp ? (rp.hours || null) : null, workLocation: rp ? rp.location : null,
          punchTimes, sources: [lg ? 'logs' : null, rp ? 'report' : null].filter(Boolean).join('+'), result: `Loaded by the PulseHRM ${RANGE.from} - ${RANGE.to} load: ${newPunches.length} punch(es) added`, importBatch: man.batch, importedById: null,
        };
        if (!prev) { const h = await tx.attendanceHistory.create({ data: histData }); man.created.AttendanceHistory.push(h.id); A.created.AttendanceHistory += 1; byEmp(code).histCreate += 1; }
        else {
          const fuller = (punchTimes && (!prev.punchTimes || punchTimes.length > prev.punchTimes.length || punchTimes !== prev.punchTimes)) || (first && !prev.firstCheckIn) || (last && !prev.lastCheckOut) || (rp && !prev.totalHours && rp.hours);
          if (fuller && (prev.punchTimes !== punchTimes || prev.firstCheckIn !== first || prev.lastCheckOut !== last || (prev.totalHours || null) !== (histData.totalHours || null))) {
            man.changed.AttendanceHistory.push({ id: prev.id, before: JSON.parse(JSON.stringify(prev)) });
            await tx.attendanceHistory.update({ where: { id: prev.id }, data: { ...histData, sourceName: prev.sourceName } });
            A.histUpdated += 1; byEmp(code).histUpdate += 1;
          }
        }
        // day row
        let dayTouched = false;
        if (rp && first) {
          if (!a) {
            const row = await tx.attendance.create({ data: { employeeId: emp.id, date, status: 'Present', checkIn: hhmm(first), checkOut: last ? hhmm(last) : null } });
            man.created.Attendance.push(row.id); A.created.Attendance += 1; byEmp(code).daysCreate += 1; byDate(date).daysCreate += 1; dayTouched = true;
          } else if (EDITABLE.has(a.status)) {
            const data = {};
            if (!a.checkIn && first) data.checkIn = hhmm(first);
            if (!a.checkOut && last) data.checkOut = hhmm(last);
            if (Object.keys(data).length) {
              man.changed.Attendance.push({ id: a.id, before: { checkIn: a.checkIn, checkOut: a.checkOut }, set: data });
              await tx.attendance.update({ where: { id: a.id }, data }); A.filled += 1; byEmp(code).daysFill += 1; byDate(date).daysFill += 1; dayTouched = true;
            }
          }
        }
        for (const p of newPunches) {
          const row = await tx.attendancePunch.create({
            data: {
              employeeId: emp.id, date, location: rp ? rp.location : null, source: hist.SOURCE, verificationStatus: 'Imported', time: hhmm(p.time), clockTime: p.time,
              direction: p.direction, method: p.method, userAgent: TAG,
            },
          });
          punchSet.add(`${emp.id}|${date}|${p.time}`); man.created.AttendancePunch.push(row.id); A.created.AttendancePunch += 1;
        }
        if (!dayTouched && !newPunches.length) A.daysNoChange += 1;
      }
    }, { maxWait: 120000, timeout: 600000 });

    // ---- 4. leave: pulseSync.plan() classification (+ guards), then the writes
    const types = await prisma.leaveType.findMany();
    const typeNames = new Map(types.map((t) => [t.name.toLowerCase(), t.name]));
    const todayIso = D.localDate();
    // the same leave listed twice in the file: the Approved row wins
    const groups = new Map();
    leaveRows.forEach((r) => { const k = `${r.code.toLowerCase()}|${r.type.toLowerCase()}|${r.from}|${r.to}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); });
    const winners = []; const superseded = [];
    for (const g of groups.values()) {
      if (g.length === 1) { winners.push(g[0]); continue; }
      const best = [...g].sort((x, y) => (STATUS_RANK[y.status] || 0) - (STATUS_RANK[x.status] || 0) || (y.approvedOn || '').localeCompare(x.approvedOn || '') || y.row - x.row)[0];
      winners.push(best); g.filter((x) => x !== best).forEach((x) => superseded.push({ x, by: best }));
    }
    winners.sort((x, y) => x.row - y.row);
    const unmappedTypes = [...new Set(leaveRows.filter((r) => r.type && !typeNames.has(r.type.toLowerCase())).map((r) => r.type))];
    const pl = await pulse.plan(winners.filter((r) => typeNames.has(r.type.toLowerCase())).map((r) => ({ ...r, type: typeNames.get(r.type.toLowerCase()) })), { create: true, createPending: true, onlyDays: 7, now: new Date() });
    const exLeave = await prisma.leaveRequest.findMany({ where: { status: { in: ['Pending', 'Approved', 'Cancellation Requested'] } } });
    const L = (report.leave = { items: [], counts: {}, pendingPast: [], balance: [], approvers: [], pendingChains: [], only: pl.only, unmappedTypes, drawNote: [] });
    const apprMap = new Map(); // normalized approver name -> employee
    const empByNormName = new Map(emps.map((e) => [alnum(e.name), e]));
    const resolveApprover = (n) => { if (!n) return null; if (apprMap.has(alnum(n))) return apprMap.get(alnum(n)); const e = empByNormName.get(alnum(n)) || null; apprMap.set(alnum(n), e); return e; };
    const planned = []; // creates accepted in this run, for overlap guards between file rows
    const dayCount = (r) => (r.half && r.half !== 'Half' ? 0.5 : (r.half === 'Half' ? 0.5 : (r.days || eachDay(r.from, r.to).length)));
    const decided = []; // final ops
    for (const it of pl.items) {
      const r = it.r; const e = empById.get(it.employeeId) || empByCode.get(it.code);
      const out = { row: it.row, code: it.code, type: it.type, from: it.from, to: it.end, half: it.half, status: it.pulseStatus, action: it.action, reason: it.reason, days: dayCount(r), appr: r.approver };
      if (it.action === 'create') {
        const ov = exLeave.find((l) => e && l.employeeId === e.id && l.type !== it.type && ['Pending', 'Approved', 'Cancellation Requested'].includes(l.status) && String(l.fromDate).slice(0, 10) <= it.end && String(l.toDate).slice(0, 10) >= it.from);
        const ov2 = planned.find((p) => p.empId === (e && e.id) && ['Pending', 'Approved'].includes(r.status) && p.from <= it.end && p.to >= it.from);
        if ((r.status === 'Pending' || r.status === 'Approved') && ov) { out.action = 'skipped'; out.reason = `TeamLink already has ${ov.status} ${ov.type} ${String(ov.fromDate).slice(0, 10)}..${String(ov.toDate).slice(0, 10)} for the same days (a different leave type): HR decides`; }
        else if (ov2) { out.action = 'skipped'; out.reason = `Overlaps Pulse row ${ov2.row} for the same person (not created twice): HR decides`; }
        else {
          if (r.status === 'Pending' || r.status === 'Approved') planned.push({ empId: e.id, from: it.from, to: it.end, row: it.row });
          if (!(Math.round(out.days * 2) === out.days * 2) || out.days <= 0 || out.days > eachDay(it.from, it.end).length) { out.action = 'skipped'; out.reason = `Duration ${r.days} does not fit ${it.from}..${it.end}`; }
        }
      }
      if (out.action === 'create' && r.status === 'Pending' && it.end < todayIso) { out.pastPending = true; }
      L.items.push(out); if (out.action === 'create' || out.action === 'update') decided.push({ out, it, r, e });
    }
    superseded.forEach(({ x, by }) => L.items.push({ row: x.row, code: x.code, type: x.type, from: x.from, to: x.to, half: x.half, status: x.rawStatus, action: 'skipped', reason: `Same leave listed twice: Pulse row ${by.row} (${by.status}) wins over this ${x.status} row`, days: x.days }));
    winners.filter((r) => !typeNames.has(r.type.toLowerCase())).forEach((x) => L.items.push({ row: x.row, code: x.code, type: x.type, from: x.from, to: x.to, status: x.rawStatus, action: 'skipped', reason: `"${x.type}" is not a TeamLink leave type`, days: x.days }));
    L.items.sort((p, q) => p.row - q.row);
    // approver names for the display of the approval chain
    for (const nm of [...new Set(leaveRows.map((r) => r.approver).filter(Boolean))]) { const ap = resolveApprover(nm); L.approvers.push({ initials: initials(nm), employee: ap ? ap.employeeCode : null, status: ap ? ap.employmentStatus : null, usedFor: leaveRows.filter((r) => r.approver === nm).length }); }

    const createdLeaves = []; const balanceDelta = new Map();
    const parseAt = (d) => new Date(`${d}T12:00:00`);
    await prisma.$transaction(async (tx) => {
      const setMeta = async (id, value) => {
        const key = `leave.meta.${id}`;
        const cur = await tx.appSetting.findUnique({ where: { key } });
        if (cur) man.changed.AppSetting.push({ key, before: cur.value }); else man.created.AppSetting.push(key);
        const v = JSON.stringify({ ...(cur ? JSON.parse(cur.value) : {}), ...value });
        await tx.appSetting.upsert({ where: { key }, update: { value: v }, create: { key, value: v } });
      };
      for (const d of decided) {
        const { out, it, r, e } = d;
        const ap = resolveApprover(r.approver);
        const decidedBy = `${ap ? ap.name : (r.approver || 'Pulse HRM')} (Pulse)`;
        if (it.action === 'update') {
          const cur = await tx.leaveRequest.findUnique({ where: { id: it.leaveId } });
          if (!cur || cur.status !== 'Pending') { out.action = 'skipped'; out.reason = 'Changed in TeamLink since the plan'; continue; }
          const data = { status: it.to, decidedAt: r.approvedOn ? parseAt(r.approvedOn) : new Date(), decidedBy };
          if (it.to === 'Approved') data.approvalReason = r.approverComments || null; else if (it.to === 'Rejected') data.rejectReason = r.approverComments || 'Rejected in Pulse HRMS';
          man.changed.LeaveRequest.push({ id: cur.id, before: { status: cur.status, decidedAt: cur.decidedAt, decidedBy: cur.decidedBy, approvalReason: cur.approvalReason, rejectReason: cur.rejectReason } });
          const open = await tx.approvalStep.findMany({ where: { workflow: 'leave', recordId: cur.id, status: { in: ['Pending', 'Waiting', 'Visibility'] } } });
          man.changed.LeaveRequest[man.changed.LeaveRequest.length - 1].steps = open.map((s) => ({ id: s.id, status: s.status, actedAt: s.actedAt, actedByName: s.actedByName, note: s.note }));
          for (const s of open) await tx.approvalStep.update({ where: { id: s.id }, data: { status: s.status === 'Pending' ? (it.to === 'Approved' ? 'Approved' : 'Rejected') : 'Skipped', actedAt: new Date(), actedByName: decidedBy, note: `Decided in Pulse HRMS (${it.to}) - ${ACTOR}` } });
          await tx.leaveRequest.update({ where: { id: cur.id }, data });
          await setMeta(cur.id, { source: 'Pulse sync', pulseStatus: it.to, pulseBy: r.approver || null, pulseAt: r.approvedOn || null, syncId: man.batch });
          const a1 = await tx.auditLog.create({ data: { userId: null, actorName: ACTOR, action: 'Leave updated from Pulse sync', entity: 'LeaveRequest', entityId: cur.id, fromValue: 'Pending', toValue: it.to, reason: `Pulse row ${it.row}` } });
          man.created.AuditLog.push(a1.id);
          out.note = it.to === 'Approved' ? 'balance not moved by the script (no ledger row); run the Leave screen sync if HR wants it drawn' : '';
          continue;
        }
        // create
        const status = it.to; const isDecided = status !== 'Pending';
        const halfMark = r.half && r.half !== 'Half' ? r.half : null;
        const reason = leaveText.compose({ reason: r.reason, comments: r.comments, details: [['Half day', halfMark], ['Source', 'Pulse HRM sync']] });
        const leave = await tx.leaveRequest.create({
          data: {
            employeeId: e.id, type: it.type, fromDate: it.from, toDate: it.end, days: out.days, reason, status,
            ...(r.appliedOn ? { createdAt: new Date(`${r.appliedOn}T09:00:00`) } : {}),
            ...(isDecided ? { decidedAt: r.approvedOn ? parseAt(r.approvedOn) : new Date(`${it.end}T12:00:00`), decidedBy, approvalReason: status === 'Approved' ? (r.approverComments || null) : null, rejectReason: status === 'Rejected' ? (r.approverComments || 'Rejected in Pulse HRMS') : null } : {}),
          },
        });
        man.created.LeaveRequest.push(leave.id); createdLeaves.push({ leave, e, status });
        await setMeta(leave.id, { source: 'Pulse sync', pulseStatus: status, pulseBy: r.approver || null, pulseAt: r.approvedOn || null, syncId: man.batch });
        const a1 = await tx.auditLog.create({ data: { userId: null, actorName: ACTOR, action: 'Leave created from Pulse sync', entity: 'LeaveRequest', entityId: leave.id, toValue: `${status} ${it.type} ${it.from}-${it.end}`, reason: `Pulse row ${it.row}` } });
        man.created.AuditLog.push(a1.id);
        out.leaveId = leave.id;
        if (status === 'Approved') {
          const k = `${e.employeeCode}|${it.type}`; const cur = balanceDelta.get(k) || { code: e.employeeCode, type: it.type, days: 0, drawn: false };
          cur.days = round2(cur.days + out.days); balanceDelta.set(k, cur);
        }
        if (DRAW_BALANCE && status === 'Approved' && it.from.slice(0, 4) === String(new Date().getFullYear())) {
          const bal = await tx.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: e.id, type: it.type } } });
          if (bal) {
            await tx.leaveBalance.update({ where: { id: bal.id }, data: { taken: round2(bal.taken + out.days) } });
            man.changed.LeaveBalance.push({ id: bal.id, deltaTaken: out.days, before: { taken: bal.taken, updatedAt: bal.updatedAt } });
            balanceDelta.get(`${e.employeeCode}|${it.type}`).drawn = true;
          }
        }
      }
      // ONE bell to HR, never one per employee
      const created = decided.filter((d) => d.it.action === 'create' && d.out.action === 'create').length;
      if (BELL && (A.created.AttendancePunch + created > 0)) {
        const hr = await tx.user.findMany({ where: { status: 'Active', OR: [{ hrmsRole: 'HR' }, { AND: [{ hrmsRole: null }, { role: 'HR' }] }] }, select: { id: true, name: true, email: true } });
        const real = (x) => !/zztest|example\.test/i.test(`${x.name} ${x.email}`);
        let to = hr.filter(real);
        // TeamLink has no user with the HR role yet: the one summary then goes to the people who run HR (Super Admin / Assistant Manager)
        if (!to.length) to = (await tx.user.findMany({ where: { status: 'Active', hrmsRole: { in: ['SUPER_ADMIN', 'ASSISTANT_MANAGER'] } }, select: { id: true, name: true, email: true } })).filter(real);
        for (const u of to) {
          const n = await tx.notification.create({ data: { userId: u.id, title: 'Attendance and leave loaded from Pulse', message: `${A.created.AttendancePunch} punch(es), ${A.created.Attendance} day(s) created, ${A.filled} filled, ${created} leave request(s) created for ${RANGE.from} to ${RANGE.to}. Review the Pending leave and the absent-without-leave days before payroll.\nOpen: /attendance`, channel: 'In-App', status: 'Delivered' } });
          man.created.Notification.push(n.id);
        }
      }
      if (A.created.AttendancePunch + A.created.Attendance + A.filled + A.created.AttendanceHistory + A.histUpdated + decided.length > 0) {
        const al = await tx.auditLog.create({ data: { userId: null, actorName: ACTOR, action: 'Pulse attendance and leave loaded', entity: 'AttendanceHistory', entityId: man.batch, toValue: `${A.created.AttendancePunch} punch(es), ${A.created.Attendance} day(s) created, ${A.filled} filled, ${A.created.AttendanceHistory} history created, ${A.histUpdated} updated, ${decided.length} leave row(s) written` } });
        man.created.AuditLog.push(al.id);
      }
    }, { maxWait: 120000, timeout: 600000 });
    L.balance = [...balanceDelta.values()];
    L.items.filter((x) => x.pastPending && x.action === 'create').forEach((x) => L.pendingPast.push(x));

    // ---- approval chains of the newly created Pending requests
    const levelBefore = new Set((await prisma.approvalLevelConfig.findMany({ select: { id: true } })).map((x) => x.id));
    for (const c of createdLeaves.filter((x) => x.status === 'Pending')) {
      try { await workflow.start({ workflow: 'leave', recordId: c.leave.id, employee: c.e, applicantUserId: c.e.userId || null, applicantName: c.e.name }); } catch (err) { L.pendingChains.push({ code: c.e.employeeCode, error: err.message }); continue; }
      const steps = await prisma.approvalStep.findMany({ where: { workflow: 'leave', recordId: c.leave.id }, orderBy: { seq: 'asc' } });
      steps.forEach((s) => man.created.ApprovalStep.push(s.id));
      const cur = steps.find((s) => s.status === 'Pending');
      L.pendingChains.push({ code: c.e.employeeCode, dates: `${c.leave.fromDate}..${c.leave.toDate}`, waitingOn: cur ? cur.level : '(no pending step)', waitingInitials: cur && cur.approverName ? initials(cur.approverName) : '', steps: steps.length });
    }
    (await prisma.approvalLevelConfig.findMany({ select: { id: true } })).filter((x) => !levelBefore.has(x.id)).forEach((x) => man.created.ApprovalLevelConfig.push(x.id));

    // idempotency marker (written last; part of the manifest so --undo removes it)
    if (MODE === 'apply' || MODE === 'dry') {
      const value = JSON.stringify({ batch: man.batch, at: new Date().toISOString(), inputHash, range: RANGE });
      await prisma.appSetting.upsert({ where: { key: MARKER_KEY }, update: { value }, create: { key: MARKER_KEY, value } });
      if (marker) man.changed.AppSetting.push({ key: MARKER_KEY, before: marker.value }); else man.created.AppSetting.push(MARKER_KEY);
    }
    L.counts = counts(L.items, (x) => x.action);
    report.manifest = man;
    report.fileState = { logDays, repDays, F3, leaveRows, empByCode, empById, emps };
    return man;
  }

  // ================================================================ UNDO
  async function undoManifest(man, { force = false } = {}) {
    const c = man.created; const ch = man.changed; const out = {};
    const emps2 = c.Employee.length ? await prisma.employee.findMany({ where: { id: { in: c.Employee } } }) : [];
    for (const e of emps2) if (e.userId) throw new Error(`${e.employeeCode} has a login now - not undoing automatically`);
    if (!force && !flag('--force')) {
      const steps = c.ApprovalStep.length ? await prisma.approvalStep.findMany({ where: { id: { in: c.ApprovalStep } } }) : [];
      if (steps.some((s) => ['Approved', 'Rejected'].includes(s.status))) throw new Error('approval step(s) of the loaded Pending requests were acted on since the load - undo would erase those decisions. Re-run with --force to override.');
    }
    await prisma.$transaction(async (tx) => {
      out.ApprovalStep = (await tx.approvalStep.deleteMany({ where: { id: { in: c.ApprovalStep } } })).count;
      out.ApprovalLevelConfig = (await tx.approvalLevelConfig.deleteMany({ where: { id: { in: c.ApprovalLevelConfig } } })).count;
      out.Notification = (await tx.notification.deleteMany({ where: { id: { in: c.Notification || [] } } })).count;
      out.balanceRestored = 0;
      for (const b of ch.LeaveBalance) { const cur = await tx.leaveBalance.findUnique({ where: { id: b.id } }); if (!cur) continue; await tx.leaveBalance.update({ where: { id: b.id }, data: { taken: Math.max(0, round2(cur.taken - b.deltaTaken)) } }); out.balanceRestored += 1; }
      const firstStamp = new Map(); for (const b of ch.LeaveBalance) if (!firstStamp.has(b.id) && b.before && b.before.updatedAt) firstStamp.set(b.id, b.before.updatedAt);
      for (const [id, st] of firstStamp) await tx.$executeRawUnsafe('UPDATE "LeaveBalance" SET "updatedAt" = ? WHERE id = ?', new Date(st).getTime(), id);
      out.leaveRestored = 0;
      for (const r of ch.LeaveRequest || []) {
        await tx.leaveRequest.update({ where: { id: r.id }, data: { status: r.before.status, decidedAt: r.before.decidedAt ? new Date(r.before.decidedAt) : null, decidedBy: r.before.decidedBy, approvalReason: r.before.approvalReason, rejectReason: r.before.rejectReason } });
        for (const s of r.steps || []) await tx.approvalStep.update({ where: { id: s.id }, data: { status: s.status, actedAt: s.actedAt ? new Date(s.actedAt) : null, actedByName: s.actedByName, note: s.note } }).catch(() => {});
        out.leaveRestored += 1;
      }
      out.AuditLog = (await tx.auditLog.deleteMany({ where: { id: { in: c.AuditLog } } })).count;
      out.LeaveRequest = (await tx.leaveRequest.deleteMany({ where: { id: { in: c.LeaveRequest } } })).count;
      out.AppSetting = 0;
      for (const k of ch.AppSetting || []) { await tx.appSetting.update({ where: { key: k.key }, data: { value: k.before } }).catch(() => {}); out.AppSetting += 1; }
      out.AppSetting += (await tx.appSetting.deleteMany({ where: { key: { in: c.AppSetting || [] } } })).count;
      out.LeaveBalance = 0;
      for (const id of c.LeaveBalance) { const cur = await tx.leaveBalance.findUnique({ where: { id } }); if (cur && cur.taken === 0) { await tx.leaveBalance.delete({ where: { id } }); out.LeaveBalance += 1; } }
      out.AttendancePunch = (await tx.attendancePunch.deleteMany({ where: { id: { in: c.AttendancePunch } } })).count;
      out.attendanceRestored = 0;
      for (const r of ch.Attendance) {
        const cur = await tx.attendance.findUnique({ where: { id: r.id } }); if (!cur) continue;
        const data = {};
        if (r.set.checkIn !== undefined && cur.checkIn === r.set.checkIn) data.checkIn = r.before.checkIn;
        if (r.set.checkOut !== undefined && cur.checkOut === r.set.checkOut) data.checkOut = r.before.checkOut;
        if (Object.keys(data).length) { await tx.attendance.update({ where: { id: r.id }, data }); out.attendanceRestored += 1; }
      }
      out.Attendance = (await tx.attendance.deleteMany({ where: { id: { in: c.Attendance } } })).count;
      out.historyRestored = 0;
      for (const r of ch.AttendanceHistory) {
        const b = r.before;
        await tx.attendanceHistory.update({ where: { id: r.id }, data: { firstCheckIn: b.firstCheckIn, lastCheckOut: b.lastCheckOut, totalTimeWorked: b.totalTimeWorked, totalBreak: b.totalBreak, totalHours: b.totalHours, workLocation: b.workLocation, punchTimes: b.punchTimes, sources: b.sources, result: b.result, importBatch: b.importBatch, importedById: b.importedById } });
        if (b.updatedAt) await tx.$executeRawUnsafe('UPDATE "AttendanceHistory" SET "updatedAt" = ? WHERE id = ?', new Date(b.updatedAt).getTime(), r.id);
        out.historyRestored += 1;
      }
      out.AttendanceHistory = (await tx.attendanceHistory.deleteMany({ where: { id: { in: c.AttendanceHistory } } })).count;
      out.Employee = (await tx.employee.deleteMany({ where: { id: { in: c.Employee } } })).count;
    }, { maxWait: 60000, timeout: 300000 });
    return out;
  }

  // ================================================================ CHECKS (read-only)
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
      rows.forEach((d) => { const bk = D.bucketOf(d); if (!bk || bk === 'upcoming') return; const r = res[d.date]; if (!r) return; r.headcount += 1; if (r[bk] !== undefined) r[bk] += 1; else r.other += 1; });
      const joined = D.joinedOn(e); const left = roll.lastDayOf.has(e.id); const last = left ? roll.lastDayOf.get(e.id) : null;
      dates.forEach((d) => { if ((!joined || joined <= d) && !(left && (!last || d > last))) res[d].expectedHeadcount += 1; });
    });
    Object.values(res).forEach((r) => { r.sum = r.present + r.absent + r.halfDay + r.onLeave + r.offDay + r.noRecord + r.notYet + r.other; r.ok = r.sum === r.headcount && r.headcount === r.expectedHeadcount; });
    return { tiles: res, rowsOf, employees, cfg };
  }

  // the loaded files against the db: every raw punch present; first-in / last-out vs the report
  async function recompare(fs0) {
    const { logDays, repDays, empByCode: ebc } = fs0;
    const punches = await prisma.attendancePunch.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } });
    const pBy = new Map(); punches.forEach((p) => { (pBy.get(`${p.employeeId}|${p.date}`) || pBy.set(`${p.employeeId}|${p.date}`, []).get(`${p.employeeId}|${p.date}`)).push(p); });
    const r = { checked: 0, mismatches: [], notChecked: 0 };
    const fresh = new Map((await prisma.employee.findMany({ select: { id: true, employeeCode: true, employmentStatus: true } })).map((e) => [e.employeeCode.trim(), e]));
    const keys = new Set([...logDays.keys(), ...repDays.keys()]);
    for (const k of keys) {
      const [code, date] = k.split('|'); const e = fresh.get(code);
      if (!e || code === '000' || (LEFT.includes(e.employmentStatus) && !INCLUDE_LEFT.has(code.toUpperCase()))) { r.notChecked += 1; continue; }
      void ebc;
      const ps = pBy.get(`${e.id}|${date}`) || [];
      const lg = logDays.get(k); const rp = repDays.get(k);
      const have = new Set(ps.map((p) => p.clockTime || `${p.time}:00`));
      const want = [...new Set([...(lg ? lg.times : []), ...(rp && rp.first ? [rp.first] : []), ...(rp && rp.last ? [rp.last] : [])])];
      const missing = want.filter((t) => !have.has(t));
      if (missing.length && ps.some((p) => /manual/i.test(String(p.source || '')))) { r.notChecked += 1; continue; }
      r.checked += 1;
      const bad = [];
      if (missing.length) bad.push(`${missing.length} punch(es) of the file are not in TeamLink`);
      const ins = ps.filter((p) => p.direction !== 'Out').map((p) => p.clockTime || `${p.time}:00`).sort(); const outs = ps.filter((p) => p.direction === 'Out').map((p) => p.clockTime || `${p.time}:00`).sort();
      if (rp && rp.first && ins[0] !== rp.first && !(ins[0] && ins[0] < rp.first)) bad.push(`first-in report ${rp.first} vs TeamLink ${ins[0] || '-'}`);
      if (rp && rp.last && outs[outs.length - 1] !== rp.last) bad.push(`last-out report ${rp.last} vs TeamLink ${outs[outs.length - 1] || '-'}`);
      if (rp && !rp.last && outs.length) bad.push('TeamLink has a check-out the report does not');
      if (bad.length) r.mismatches.push({ code, date, problems: bad });
    }
    return r;
  }

  // PulseHRM summary (file 2) vs TeamLink's own engine, per employee
  async function summaryCompare(tilesRes, fs0, report0) {
    const { repDays, F3, leaveRows } = fs0;
    const HOL = new Set((await prisma.holiday.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } })).map((h) => h.date));
    const lvDay = {};
    leaveRows.filter((x) => x.status === 'Approved').forEach((x) => { for (const d of eachDay(x.from, x.to)) { if (isSunday(d) || HOL.has(d)) continue; (lvDay[x.code] = lvDay[x.code] || {})[d] = (x.days === 0.5 || x.half) ? 0.5 : 1; } });
    const model = (code, d) => {
      const l = (lvDay[code] || {})[d]; if (l) return { p: 0, l, w: `Pulse: approved leave ${l}` };
      const r = repDays.get(`${code}|${d}`); if (!r) return { p: 0, l: 0, w: 'Pulse: no first/last row (no punches or a lone morning punch)' };
      const w = sec(r.worked); const out = !!r.last;
      if (!out) return { p: 0, l: 0, w: 'Pulse: single punch, no credit' };
      if (w < 4 * 3600) return { p: 0, l: 0, w: `Pulse: worked ${hms(w)} (<4h, no credit)` };
      if (w < 9 * 3600) return { p: 0.5, l: 0, w: `Pulse: worked ${hms(w)} (4-9h = half day)` };
      return { p: 1, l: 0, w: `Pulse: worked ${hms(w)}` };
    };
    const emps2 = await prisma.employee.findMany({ select: { id: true, employeeCode: true, employmentStatus: true } });
    const ebc = new Map(emps2.map((e) => [e.employeeCode.trim(), e]));
    const dates = eachDay(RANGE.from, RANGE.to);
    const rows = [];
    for (const r of F3) {
      const code = (r['Employee Ref No'] || '').trim();
      const g = (k) => { const kk = Object.keys(r).find((x) => x.trim().toLowerCase() === k); return kk ? r[kk] : ''; };
      const file = { half: +g('half-day'), present: +g('present'), wo: +g('week offs'), ph: +g('public holidays'), leaves: +g('leaves'), payable: +g('payable days'), hours: g('total hours') };
      const e = ebc.get(code);
      const row = { code, tlStatus: e ? e.employmentStatus : 'not in TeamLink', file, engine: null, diffs: [], reasons: [], kinds: new Set() };
      const days = e ? tilesRes.rowsOf.get(e.id) : null;
      if (code === '000') { row.reasons.push('pseudo user, excluded'); row.kinds.add('excluded'); rows.push(row); continue; }
      if (!days) { row.reasons.push(e ? `${e.employmentStatus} in TeamLink: not on the rolls, the engine counts nothing` : 'not in TeamLink: nothing loaded'); row.kinds.add(e ? 'left-not-loaded' : 'not-in-teamlink'); rows.push(row); continue; }
      const counted = days.filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status));
      const present = counted.filter((d) => d.present === 1).length; const half = counted.filter((d) => d.present === 0.5).length;
      const wo = counted.filter((d) => d.status === 'Weekly Off').length; const ph = counted.filter((d) => d.status === 'Holiday').length;
      const leaves = round2(counted.reduce((n, d) => n + (Number(d.leave) || 0), 0));
      const s = D.summarise(counted);
      const payable = round2(s.paidDays + s.weeklyOffs + s.holidays);
      row.engine = { half, present, wo, ph, leaves, payable };
      const cmp = (k, a, b) => { if (Math.abs(a - b) > 1e-9) { row.diffs.push(`${k}: Pulse ${a} / TeamLink ${b}`); row.kinds.add(k); } };
      cmp('present', file.present, present); cmp('half', file.half, half); cmp('week offs', file.wo, wo); cmp('holidays', file.ph, ph); cmp('leaves', file.leaves, leaves); cmp('payable', file.payable, payable);
      for (const d of dates) {
        if (isSunday(d) || HOL.has(d)) continue;
        const dr = days.find((x) => x.date === d); if (!dr || ['Upcoming', 'Not Joined', 'Left'].includes(dr.status)) continue;
        const m = model(code, d);
        if (Math.abs((dr.present || 0) - m.p) > 1e-9 || Math.abs((dr.leave || 0) - m.l) > 1e-9) {
          const tag = d === D.localDate() && !repDays.get(`${code}|${d}`) ? 'TODAY IS AN OPEN DAY' : m.l > 0 && dr.present > 0 ? 'HALF LEAVE + OTHER HALF WORKED' : m.p === 0.5 && dr.present === 1 ? 'HALF-DAY RULE (Pulse 4-9h; TeamLink clock rule)' : m.p === 0 && m.l === 0 && dr.present > 0 ? (dr.checkIn ? 'MISSING-CHECK-OUT / SHORT DAY COUNTED' : 'HR MARK (kept as HR marked it)') : m.p === 1 && dr.present === 0.5 ? 'HALF-DAY RULE (TeamLink stricter)' : m.l !== dr.leave ? 'LEAVE HANDLING' : 'OTHER';
          row.kinds.add(tag); report0.dayTally[tag] = (report0.dayTally[tag] || 0) + 1;
          row.reasons.push(`${d.slice(5)}: ${m.w}; TeamLink ${dr.status}${dr.checkIn ? ` (${dr.checkIn}-${dr.checkOut || '?'})` : ''} [${tag}]`);
        }
      }
      if (days.some((d) => d.sandwich)) { row.reasons.push('sandwich rule: TeamLink turns a holiday/Sunday between two leave days into leave'); row.kinds.add('SANDWICH RULE'); }
      rows.push(row);
    }
    return rows;
  }


  // DATA FIDELITY: run PULSE'S OWN RULE (9h+ = present, 4-9h = half, lone punch / under 4h = no credit; Sundays and the
  // holiday off; approved leave) on what is now in the database and compare with Pulse's six totals. If these agree, the
  // load carried every punch and leave faithfully, whatever TeamLink's own (different) day rule says in section 6.
  async function pulseRuleCheck(fs0) {
    const { F3 } = fs0;
    const HOL = new Set((await prisma.holiday.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } })).map((h) => h.date));
    const emps2 = await prisma.employee.findMany({ select: { id: true, employeeCode: true, employmentStatus: true } });
    const ebc = new Map(emps2.map((e) => [e.employeeCode.trim(), e]));
    const ps = await prisma.attendancePunch.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } });
    const pBy = new Map(); ps.forEach((p) => { const k = `${p.employeeId}|${p.date}`; (pBy.get(k) || pBy.set(k, []).get(k)).push(p); });
    const leaves = await prisma.leaveRequest.findMany({ where: { status: 'Approved', fromDate: { lte: RANGE.to }, toDate: { gte: RANGE.from } } });
    const dates = eachDay(RANGE.from, RANGE.to);
    const out = [];
    for (const r of F3) {
      const code = (r['Employee Ref No'] || '').trim(); if (code === '000') continue;
      const g = (k) => { const kk = Object.keys(r).find((x) => x.trim().toLowerCase() === k); return kk ? r[kk] : ''; };
      const pulseT = { present: +g('present'), half: +g('half-day'), wo: +g('week offs'), ph: +g('public holidays'), leaves: +g('leaves'), payable: +g('payable days') };
      const e = ebc.get(code);
      if (!e) { out.push({ code, pulse: pulseT, rule: null, diffs: ['not in TeamLink'], kind: 'not in TeamLink' }); continue; }
      if (LEFT.includes(e.employmentStatus) && !INCLUDE_LEFT.has(code.toUpperCase())) { out.push({ code, pulse: pulseT, rule: null, diffs: [], kind: `${e.employmentStatus}: not loaded` }); continue; }
      let present = 0; let half = 0; let wo = 0; let ph = 0; let lv = 0; const notes = [];
      for (const d of dates) {
        if (isSunday(d)) { wo += 1; continue; }
        if (HOL.has(d)) { ph += 1; continue; }
        const l = leaves.find((x) => x.employeeId === e.id && String(x.fromDate).slice(0, 10) <= d && String(x.toDate).slice(0, 10) >= d);
        const lshare = l ? (/first|second/i.test(String(leaveText.halfOf(l))) ? 0.5 : 1) : 0; // Pulse counts a 0.5 leave WITHOUT a First/Second Half marker as a whole leave day
        const p = pBy.get(`${e.id}|${d}`) || [];
        let credit = 0;
        if (p.length) {
          const t = p.map((x) => x.clockTime || `${x.time}:00`).sort(); const outs = p.filter((x) => x.direction === 'Out').map((x) => x.clockTime || `${x.time}:00`).sort();
          const w = outs.length ? sec(outs[outs.length - 1]) - sec(t[0]) : 0;
          credit = w >= 9 * 3600 ? 1 : w >= 4 * 3600 ? 0.5 : 0;
        }
        if (lshare) { lv += lshare; continue; }
        if (credit === 1) present += 1; else if (credit === 0.5) half += 1;
      }
      const payable = round2(present + half * 0.5 + wo + ph + lv);
      const ruleT = { present, half, wo, ph, leaves: round2(lv), payable };
      const diffs = Object.keys(pulseT).filter((k) => Math.abs(pulseT[k] - ruleT[k]) > 1e-9).map((k) => `${k}: Pulse ${pulseT[k]} / Pulse-rule on loaded data ${ruleT[k]}`);
      out.push({ code, pulse: pulseT, rule: ruleT, diffs, kind: e.employmentStatus, notes });
    }
    return out;
  }

  // absent-without-leave and the other open items per employee (counts only)
  function awlTable(tilesRes, inFileCodes, withPunchCodes) {
    const out = [];
    for (const e of tilesRes.employees) {
      if (e.employeeCode.trim() === '000') continue;
      const rows = tilesRes.rowsOf.get(e.id) || [];
      const counted = rows.filter((d) => !['Upcoming', 'Not Joined', 'Left'].includes(d.status));
      const n = (f) => counted.filter(f).length;
      const o = { code: e.employeeCode, inFiles: inFileCodes.has(e.employeeCode.trim()) ? (withPunchCodes.has(e.employeeCode.trim()) ? 'punches in files' : 'summary only: NO punches in the files') : 'not in any file', absent: n((d) => d.status === 'Absent'), lop2: n((d) => d.awlKind === 'full'), halfLop: n((d) => d.awlKind === 'half'), missingOut: n((d) => d.status === 'Missing Check-Out'), missingIn: n((d) => d.status === 'Missing Check-In'), noData: n((d) => d.status === 'No device data' || d.noRecord === true && d.status !== 'Absent'), open: n((d) => d.status === 'Checked In') + rows.filter((d) => d.status === 'Not Checked In').length };
      if (o.absent || o.missingOut || o.missingIn || o.open || o.noData) out.push(o);
    }
    return out.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }

  // ================================================================ REPORT
  const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  function md(report) {
    const o = []; const p = (s = '') => o.push(s);
    const A = report.attendance; const L = report.leave; const V = report.verify;
    const c = report.manifest.created; const ch = report.manifest.changed;
    p(`# PulseHRM load ${RANGE.from} .. ${RANGE.to} - ${MODE === 'dry' ? 'DRY RUN (the real database is not written)' : MODE.toUpperCase()}`);
    p(`Generated ${new Date().toISOString()} - target ${path.basename(DB_ARG)} - files in ${DIR} - input fingerprint ${report.inputs.inputHash}. Only employee ids and initials are shown here (no names).`);
    p('');
    p('## 1. What the load writes');
    p('| Table | Rows created | Rows changed |'); p('|---|---|---|');
    [['Employee (only with --create-missing-employees)', c.Employee.length, 0], ['AttendancePunch (raw punches)', c.AttendancePunch.length, 0], ['Attendance (day rows)', c.Attendance.length, ch.Attendance.length], ['AttendanceHistory (raw log + report)', c.AttendanceHistory.length, ch.AttendanceHistory.length],
      ['LeaveRequest', c.LeaveRequest.length, ch.LeaveRequest.length], ['LeaveBalance', c.LeaveBalance.length, ch.LeaveBalance.length], ['ApprovalStep (chains of new Pending)', c.ApprovalStep.length, 0], ['AuditLog', c.AuditLog.length, 0], ['Notification (one HR bell per HR user)', c.Notification.length, 0], ['AppSetting (leave meta + idempotency marker)', c.AppSetting.length, ch.AppSetting.length]]
      .forEach(([t, n, m]) => p(`| ${t} | ${n} | ${m} |`));
    p(''); p(`Batch ${report.batch}. Idempotency marker: ${report.marker ? `already present from ${report.marker.at} (${report.marker.inputHash === report.inputs.inputHash ? 'same files' : 'different files'})` : 'none yet; it is written by --apply'}.`);
    p('');
    p('## 2. MATCH TABLE (Employee ID first, then name, designation, department)');
    const cat = counts(report.match, (m) => m.cat); p(`Summary: ${Object.entries(cat).map(([k, n]) => `${k}: ${n}`).join(' | ')}`); p('');
    p('| Id | Result | Found in | TeamLink status | Initials file / TeamLink | Notes |'); p('|---|---|---|---|---|---|');
    report.match.forEach((m) => p(`| ${m.code} | ${m.cat} | ${m.sources.join(', ')} | ${m.tl ? m.tl.status : '-'} | ${m.fileNames.map(initials).join('/') || '-'} / ${m.tl ? initials(m.tl.name) : '-'} | ${m.flags.join('; ')} |`));
    p('');
    const dupIds = report.match.filter((m) => m.flags.some((f) => /two different names/.test(f)));
    p(`Duplicates (same id, two different names in the files): ${dupIds.length ? dupIds.map((m) => m.code).join(', ') : 'none'}.`);
    p(`Ids not in TeamLink: ${[...report.employees.toCreate, ...report.employees.notCreated].map((x) => `${x.code} (${x.days} day(s), ${x.punches} log punches, ${report.employees.toCreate.includes(x) ? 'WOULD BE CREATED' : 'NOT created - use --create-missing-employees'})`).join('; ') || 'none'}.`);
    p('');
    p('### People in the files with NO punches in the files (nothing invented)');
    const withPunch = new Set([...report.fileState.logDays.values(), ...report.fileState.repDays.values()].map((x) => x.code));
    p(report.match.filter((m) => !withPunch.has(m.code) && m.sources.includes('summary')).map((m) => `${m.code}${m.tl ? ` (${m.tl.status})` : ''}`).join(', ') || '(none)');
    p('');
    p('## 3. Attendance');
    p(`Raw punches to create ${A.created.AttendancePunch}; already in TeamLink (same person + same second, skipped) ${A.punchesSkippedExisting}; day rows created ${A.created.Attendance}, filled ${A.filled}; history rows created ${A.created.AttendanceHistory}, updated ${A.histUpdated}; loaded days with nothing to change ${A.daysNoChange}.`);
    p(`Existing imported punches (earlier loads) that the new files do not carry: ${A.existingPunchesNotInFile} (left as they are).`);
    p('');
    p('| Date | Day rows in files | Raw punches in files | Punches to create | Punches skipped (exist / protected) | Day rows created | Day rows filled |'); p('|---|---|---|---|---|---|---|');
    Object.keys(A.perDate).sort().forEach((d) => { const x = A.perDate[d]; p(`| ${d} | ${x.fileDays} | ${x.filePunches} | ${x.punchesCreate} | ${x.punchesSkip} | ${x.daysCreate} | ${x.daysFill} |`); });
    p('');
    p('| Id | Days in files | Punches in files | Punches create | Punches skip | Days create | Days fill | History create / update |'); p('|---|---|---|---|---|---|---|---|');
    Object.values(A.perEmployee).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).forEach((x) => p(`| ${x.code} | ${x.fileDays} | ${x.filePunches} | ${x.punchesCreate} | ${x.punchesSkip} | ${x.daysCreate} | ${x.daysFill} | ${x.histCreate} / ${x.histUpdate} |`));
    p('');
    p(`### Not loaded: Relieved / Exited in TeamLink (${new Set(A.excluded.map((x) => x.code)).size} id(s), ${A.excluded.length} day rows, ${A.excluded.reduce((n, x) => n + x.punches, 0)} punches)`);
    Object.entries(counts(A.excluded, (x) => `${x.code} (${x.status})`)).forEach(([k, n]) => p(`- ${k}: ${n} day(s) with punches in the files (dates ${A.excluded.filter((x) => `${x.code} (${x.status})` === k).map((x) => x.date.slice(5)).join(', ')}). Load with --include-left ${k.split(' ')[0]} only if HR confirms they are working again.`));
    p('');
    p(`### Not loaded: id not in TeamLink (${A.notLoaded.length} day rows, ${A.notLoaded.reduce((n, x) => n + x.punches, 0)} punches)`);
    p(Object.entries(counts(A.notLoaded, (x) => x.code)).map(([k, n]) => `${k}: ${n} day(s)`).join('; ') || '(none)');
    p('');
    p(`### Days left alone on purpose (${A.protectedDays.length}): approved corrections, HR-typed punches, HR marks`);
    A.protectedDays.forEach((x) => p(`- ${x.code} ${x.date}: ${x.why} (${x.punches} punch(es) of the file NOT added)`));
    if (!A.protectedDays.length) p('(none)');
    p(`HR marks (no times) in the range, never touched: ${A.hrMarks.map((x) => `${x.code} ${x.date} ${x.status}`).join('; ') || 'none'}`);
    p('');
    p('### Cross-check: first/last report (file 3) against the bio-metric log (file 1)');
    const X = A.crossCheck;
    p(`- First check-in differs: ${X.first.length}${X.first.length ? ` -> ${X.first.map((x) => `${x.code} ${x.date} (report ${x.report}, log ${x.log})`).join('; ')}` : ''}. Both times are loaded; the earlier one is the day's first-in.`);
    p(`- Last check-out differs: ${X.last.length}${X.last.length ? ` -> ${X.last.map((x) => `${x.code} ${x.date} (report ${x.report}, log ends ${x.log})`).join('; ')}` : ''}. The report's time is added as a punch (method "PulseHRM import").`);
    p(`- Days in the report but not in the log (report times used): ${X.reportOnly.length}${X.reportOnly.length ? ` -> ${X.reportOnly.map((x) => `${x.code} ${x.date}`).join('; ')}` : ''}.`);
    p(`- Days in the log but not in the report (open / morning-only days, no check-out invented): ${X.logOnly.length}, of which on ${D.localDate()}: ${X.logOnly.filter((x) => x.date === D.localDate()).length}.`);
    p(`- Log has an evening punch but the report has no check-out: ${X.missingOutInLog.length}${X.missingOutInLog.length ? ` -> ${X.missingOutInLog.map((x) => `${x.code} ${x.date}`).join('; ')}` : ''}.`);
    p(`- Complex days (several in/out visits): ${A.complexDays.length}.`);
    p('');
    p('## 4. Leave (through utils/pulseSync.js plan(), then the guards)');
    p(`Classification: ${Object.entries(L.counts).map(([k, n]) => `${({ create: 'Create', update: 'Update status', unchanged: 'Unchanged', skipped: 'Skipped' })[k] || k}: ${n}`).join(' | ')} | Only in TeamLink (not in the file, Pending): ${L.only.length}. Unmapped leave types: ${L.unmappedTypes.length ? L.unmappedTypes.join(', ') : 'none'}.`);
    p(''); p('| File row | Id | Type | From | To | Days | Half | Pulse status | Approver (initials -> TeamLink id) | Result | Why |'); p('|---|---|---|---|---|---|---|---|---|---|---|');
    L.items.forEach((x) => { const ap = x.appr ? `${initials(x.appr)} -> ${(L.approvers.find((a) => a.initials === initials(x.appr)) || {}).employee || 'not found'}` : '-'; p(`| ${x.row} | ${x.code} | ${x.type} | ${x.from} | ${x.to} | ${x.days != null ? x.days : ''} | ${x.half || ''} | ${x.status} | ${ap} | ${({ create: 'CREATE', update: 'UPDATE STATUS', unchanged: 'UNCHANGED', skipped: 'SKIPPED' })[x.action] || x.action} | ${x.reason || ''}${x.note ? ` ${x.note}` : ''} |`); });
    p('');
    p('### Approver names resolved to TeamLink people (for the approval-chain display)');
    L.approvers.forEach((a) => p(`- ${a.initials}: ${a.employee ? `${a.employee} (${a.status})` : 'NOT FOUND (the decided-by text keeps the Pulse spelling)'} - used on ${a.usedFor} row(s)`));
    p('');
    p(`### Pending in Pulse with dates already past (${L.pendingPast.length} to be created as Pending; HR decides) - plus the Pending rows TeamLink already has`);
    L.pendingPast.forEach((x) => p(`- row ${x.row} ${x.code} ${x.type} ${x.from}..${x.to} (CREATE as Pending, applied earlier; the date is past)`));
    L.items.filter((x) => x.action === 'unchanged' && x.status === 'Pending' && x.to < D.localDate()).forEach((x) => p(`- row ${x.row} ${x.code} ${x.type} ${x.from}..${x.to} (already Pending in TeamLink; the date is past)`));
    p('');
    p(`### Only in TeamLink (Pending there, not in the Pulse file) - ${L.only.length}`);
    const recent = L.only.filter((x) => x.to >= '2026-09-01'); recent.forEach((x) => p(`- ${x.code} ${x.type} ${x.from}..${x.to} applied ${x.appliedOn}`));
    p(`(${L.only.length - recent.length} older Pending request(s) from before September are not listed here; they belong to the old-pending list HR already has.)`);
    p('');
    p('Approval chains laid down for the new Pending rows (silent, nobody notified):');
    L.pendingChains.forEach((x) => p(`- ${x.code} ${x.dates || ''}: ${x.error ? `chain failed: ${x.error}` : `waiting on ${x.waitingOn}${x.waitingInitials ? ` (${x.waitingInitials})` : ''}, ${x.steps} steps`}`));
    p('');
    p(`Leave balance: created Approved rows do NOT move the balance (as the Pulse sync; the Leave Balances import is the source of truth). ${DRAW_BALANCE ? '--draw-balance IS ON: current-year Approved days were drawn.' : 'Days that would be drawn with --draw-balance:'}`);
    L.balance.forEach((b) => p(`- ${b.code} ${b.type}: ${b.days} day(s)${b.drawn ? ' (drawn)' : ''}`));
    p('');
    p('## 5. Checks on the loaded copy');
    p(`Re-compare of the files against TeamLink: ${V.recompare.checked} day-checks -> ${V.recompare.mismatches.length} mismatch(es); ${V.recompare.notChecked} not checked (not loaded by design).`);
    V.recompare.mismatches.forEach((m) => p(`- MISMATCH ${m.code} ${m.date}: ${m.problems.join('; ')}`));
    p(''); p('Dashboard tiles (engine rule preview) BEFORE -> AFTER the load; the equation Present + Absent + Half day + On leave + Week off/Holiday + No device data + Not checked in yet = Headcount must hold:');
    p('| Date | Headcount | Present | Absent | Half day | On leave | Week off/Holiday | No device data | Not yet | Equation after |'); p('|---|---|---|---|---|---|---|---|---|---|');
    Object.keys(V.after).sort().forEach((d) => { const b = V.before[d]; const a = V.after[d]; p(`| ${d} | ${b.headcount} -> ${a.headcount} | ${b.present} -> ${a.present} | ${b.absent} -> ${a.absent} | ${b.halfDay} -> ${a.halfDay} | ${b.onLeave} -> ${a.onLeave} | ${b.offDay} -> ${a.offDay} | ${b.noRecord} -> ${a.noRecord} | ${b.notYet} -> ${a.notYet} | ${a.ok ? 'OK' : `FAIL ${a.sum} vs ${a.headcount}/${a.expectedHeadcount}`} |`); });
    p('');
    p('## 6. Reconciliation: Pulse attendance summary (file 2) vs TeamLink\'s own engine on the loaded copy');
    p('Pulse rules: Present = a 9h+ day, Half-Day = a 4-9h day, a lone punch or under 4h = no credit, Week Offs = Sundays (4 Oct, 11 Oct), Public Holidays = 2 Oct. TeamLink rules: the clock rule of utils/attendanceDays.js, leave from the Leave History, 13 Oct is an open day (not counted). Counts are DAYS (Half-Day = number of half days).');
    p(''); p('| Id | Pulse present/half/WO/PH/leave/payable | TeamLink present/half/WO/PH/leave/payable | Difference classes |'); p('|---|---|---|---|');
    const sc = report.summaryRows;
    sc.forEach((r) => p(`| ${r.code} | ${r.file.present}/${r.file.half}/${r.file.wo}/${r.file.ph}/${r.file.leaves}/${r.file.payable} | ${r.engine ? `${r.engine.present}/${r.engine.half}/${r.engine.wo}/${r.engine.ph}/${r.engine.leaves}/${r.engine.payable}` : (r.reasons[0] || '-')} | ${r.diffs.length || !r.engine ? [...r.kinds].join('; ') : 'EXACT'} |`));
    const exact = sc.filter((r) => r.engine && !r.diffs.length).length; const exactWithPunches = sc.filter((r) => r.engine && !r.diffs.length && withPunch.has(r.code)).length;
    p(''); p(`Employees whose six totals match Pulse exactly under TeamLink's own rule: ${exact} of ${sc.length} rows (of those, ${exactWithPunches} have punches; the others are people with no punches in the files). Rows that could not be compared (pseudo user, not loaded, not in TeamLink): ${sc.filter((r) => !r.engine).length}.`);
    p(`Day-level disagreement classes (days, all employees): ${Object.entries(report.dayTally).map(([k, n]) => `${k}: ${n}`).join(' | ') || 'none'}`);
    p('Whose rule explains each class: HALF-DAY RULE (Pulse 4-9h; TeamLink clock rule) = Pulse-side rule (Pulse needs 9h worked for a full day; TeamLink pays a full day for the 9:00-1:30 / after-5-6pm clock rule, Late is only a flag). MISSING-CHECK-OUT / SHORT DAY COUNTED = Pulse gives no credit for a lone punch or a 3-12 second double punch, TeamLink shows Missing Check-Out and counts the day as Present for HR to fix (app-side rule; mostly 28 Sep, where the device export holds only the morning visit). HALF LEAVE + OTHER HALF WORKED = Pulse shows only the leave, TeamLink shows Half Day + Half Leave. SANDWICH RULE = TeamLink turns a holiday/Sunday between two leave days into leave (app-side policy). LEAVE HANDLING / TODAY IS AN OPEN DAY = a leave TeamLink still has Pending (a different leave type), and 13 Oct, which is not counted yet.');
    const kinds = {}; sc.forEach((r) => { if (r.engine) r.kinds.forEach((k) => { kinds[k] = (kinds[k] || 0) + 1; }); });
    p(`Difference classes (employees affected): ${Object.entries(kinds).map(([k, n]) => `${k}: ${n}`).join(' | ') || 'none'}`);
    p(''); p('Day-level reasons (only the days where TeamLink and Pulse disagree):');
    sc.filter((r) => r.engine && r.reasons.length).forEach((r) => { p(`- ${r.code}:`); r.reasons.forEach((x) => p(`    - ${x}`)); });
    p('');
    p("### 6b. Data fidelity: Pulse's OWN rule applied to the loaded data vs Pulse's totals");
    const pr = report.pulseRule; const prOk = pr.filter((x) => x.rule && !x.diffs.length);
    p(`Using Pulse's rule on what is now in TeamLink (9h+ present, 4-9h half, lone punch no credit, Sundays + 2 Oct off, Approved leave): ${prOk.length} of ${pr.filter((x) => x.rule).length} comparable employees match Pulse's six totals exactly. The others:`);
    pr.filter((x) => x.diffs.length).forEach((x) => p(`- ${x.code} (${x.kind}): ${x.diffs.join('; ')}${x.notes && x.notes.length ? ` [${x.notes.join(', ')}]` : ''}`));
    p('');
    p('## 7. Absent without leave in the loaded range (counts only, for HR to review before payroll)');
    p('| Id | Source | Absent days (no check-in, no leave) | tagged 2-LOP (full) | tagged half-day LOP | Missing check-out | Missing check-in | Open today / not yet | No device data |'); p('|---|---|---|---|---|---|---|---|---|');
    report.awl.forEach((x) => p(`| ${x.code} | ${x.inFiles} | ${x.absent} | ${x.lop2} | ${x.halfLop} | ${x.missingOut} | ${x.missingIn} | ${x.open} | ${x.noData} |`));
    p(`Total absent days: ${report.awl.reduce((n, x) => n + x.absent, 0)} across ${report.awl.filter((x) => x.absent).length} employee(s).`);
    return o.join('\n');
  }
  function csvs(report, prefix) {
    const w = (name, head, rows) => fs.writeFileSync(`${prefix}-${name}.csv`, `\uFEFF${[head.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n')}\r\n`);
    const A = report.attendance; const L = report.leave;
    w('match', ['Id', 'Result', 'Found in', 'TeamLink status', 'Initials (file)', 'Initials (TeamLink)', 'Notes'], report.match.map((m) => [m.code, m.cat, m.sources.join('+'), m.tl ? m.tl.status : '', m.fileNames.map(initials).join('/'), m.tl ? initials(m.tl.name) : '', m.flags.join('; ')]));
    w('punches-per-employee', ['Id', 'Days in files', 'Punches in files', 'Punches create', 'Punches skip', 'Days create', 'Days fill'], Object.values(A.perEmployee).map((x) => [x.code, x.fileDays, x.filePunches, x.punchesCreate, x.punchesSkip, x.daysCreate, x.daysFill]));
    w('reconciliation', ['Id', 'Pulse present', 'Pulse half', 'Pulse WO', 'Pulse PH', 'Pulse leave', 'Pulse payable', 'TL present', 'TL half', 'TL WO', 'TL PH', 'TL leave', 'TL payable', 'Classes'], report.summaryRows.map((r) => [r.code, r.file.present, r.file.half, r.file.wo, r.file.ph, r.file.leaves, r.file.payable, ...(r.engine ? [r.engine.present, r.engine.half, r.engine.wo, r.engine.ph, r.engine.leaves, r.engine.payable] : ['', '', '', '', '', '']), [...r.kinds].join('; ')]));
    w('leave', ['Row', 'Id', 'Type', 'From', 'To', 'Days', 'Pulse status', 'Result', 'Why'], L.items.map((x) => [x.row, x.code, x.type, x.from, x.to, x.days, x.status, x.action, x.reason]));
    w('absent-without-leave', ['Id', 'Absent', 'LOP2', 'HalfLOP', 'MissingOut', 'MissingIn', 'Open', 'NoData'], report.awl.map((x) => [x.code, x.absent, x.lop2, x.halfLop, x.missingOut, x.missingIn, x.open, x.noData]));
  }

  // ================================================================ MODES
  const report = { mode: MODE, db: DB_ARG };
  let code = 0;
  try {
    if (MODE === 'undo') {
      const mp = path.resolve(opt('--undo'));
      const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (path.resolve(man.db).toLowerCase() !== WORK_DB.toLowerCase()) throw new Error(`this manifest belongs to ${man.db}, not ${WORK_DB}`);
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bk = path.join(BACKUP_DIR, 'teamlink-before-undo.db'); snapshot(WORK_DB, bk); console.log(`backup before undo: ${bk}`);
      console.log('UNDO done:', JSON.stringify(await undoManifest(man)));
      return 0;
    }
    if (MODE === 'verify') {
      const fsx = {}; // build the file state only (no writes)
      const hist2 = hist; const F4 = hist2.parseCsv(readTxt(FILES.logs)).rows; const F1 = hist2.parseCsv(readTxt(FILES.report)).rows;
      fsx.logDays = new Map(); F4.forEach((r) => { const [c0] = String(r.Employee || '').split(' - '); const date = hist2.isoDate(r['Attendance Date']); if (date && inRange(date)) fsx.logDays.set(`${c0.trim()}|${date}`, { times: timesOf(r['Time Interval']) }); });
      fsx.repDays = new Map(); F1.forEach((r) => { const c0 = (r['Employee Ref No'] || '').trim(); const date = hist2.isoDate(r.Date); if (date && inRange(date)) fsx.repDays.set(`${c0}|${date}`, { first: clk(r['First Check In']), last: clk(r['Last Check Out']) }); });
      const rc = await recompare(fsx); const t = await tilesFor(RANGE.from, RANGE.to);
      console.log(JSON.stringify({ recompare: { checked: rc.checked, mismatches: rc.mismatches, notChecked: rc.notChecked }, tilesOk: Object.values(t.tiles).every((x) => x.ok) }, null, 1));
      return rc.mismatches.length || !Object.values(t.tiles).every((x) => x.ok) ? 1 : 0;
    }
    const before = await tilesFor(RANGE.from, RANGE.to);
    if (MODE === 'apply') {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bk = path.join(BACKUP_DIR, 'teamlink-before.db'); snapshot(WORK_DB, bk); console.log(`full backup copy: ${bk}`); report.backup = bk;
    }
    let man;
    try { man = await load(report); } catch (err) {
      console.error('LOAD FAILED:', err.message);
      if (MODE === 'apply' && CURRENT && !report.alreadyApplied) {
        const mf = path.join(BACKUP_DIR, 'manifest-failed-run.json'); fs.writeFileSync(mf, JSON.stringify(CURRENT, null, 1));
        try { console.error('ROLLED BACK the partial run:', JSON.stringify(await undoManifest(CURRENT, { force: true }))); } catch (e2) { console.error(`could not roll back automatically (${e2.message}); restore ${report.backup} or run --undo ${mf}`); }
      }
      throw err;
    }
    if (MODE === 'apply') {
      man.backup = report.backup; const mf = path.join(BACKUP_DIR, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(man, null, 1)); console.log(`manifest: ${mf}`); report.manifestFile = mf;
    }
    const after = await tilesFor(RANGE.from, RANGE.to);
    report.verify = { recompare: await recompare(report.fileState), before: before.tiles, after: after.tiles };
    report.dayTally = {};
    report.summaryRows = await summaryCompare(after, report.fileState, report);
    report.pulseRule = await pulseRuleCheck(report.fileState);
    report.awl = awlTable(after, new Set(report.match.map((m) => m.code)), new Set([...report.fileState.logDays.values(), ...report.fileState.repDays.values()].map((x) => x.code)));
    const text = md(report);
    const out = opt('--report'); if (out) fs.writeFileSync(out, text);
    const csvPrefix = opt('--csv'); if (csvPrefix) csvs(report, csvPrefix);
    const jf = opt('--json'); if (jf) fs.writeFileSync(jf, JSON.stringify({ batch: report.batch, counts: Object.fromEntries(Object.entries(man.created).map(([k, v]) => [k, v.length])), changed: Object.fromEntries(Object.entries(man.changed).map(([k, v]) => [k, v.length])), leave: report.leave.counts }, null, 1));
    console.log(text);
    const bad = report.verify.recompare.mismatches.length + Object.values(after.tiles).filter((x) => !x.ok).length;
    console.log(`\nSUMMARY (${MODE}): mismatches ${report.verify.recompare.mismatches.length}, equation failures ${Object.values(after.tiles).filter((x) => !x.ok).length}`);
    if (MODE === 'dry') console.log('DRY RUN: nothing was written to the target database.');
    code = bad ? 1 : 0;
  } finally {
    await prisma.$disconnect().catch(() => {});
    if (TEMP_DB) for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(TEMP_DB + s); } catch { /* gone */ } }
  }
  return code;
}

module.exports = { main, directions, timesOf, readLeaveCsv };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c || 0; }).catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; });
}
