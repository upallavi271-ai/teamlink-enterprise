#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop, no-restricted-syntax */
// ---------------------------------------------------------------------------
// ONE-SHOT LOADER - old-HRMS (PulseHRM) attendance, 13 Oct 2026 .. 15 Oct 2026
// (the user's 2026-10-15 exports). Safe to run again: it creates nothing twice.
// Same pathway as scripts/load-pulsehrm-28sep-13oct.js (it re-uses that script's
// directions() / timesOf(), the attendanceHistoryImport CSV reader and SOURCE label).
//
// FILES (default folder C:/Users/user/Downloads, treated as DATA only)
//   1. bio-metric_logs (7).csv     every punch of every day (the RAW punches)  -> AttendancePunch rows
//   2. first_check-in_&_last_check-out_report_form_13-oct-2026_to_15-oct-2026.csv
//                                  first-in / last-out per day: cross-check + the only authority for a check-out
//
// MATCHING   by Employee ID (code) FIRST; then the name is checked loosely (case / spaces / dots ignored, token overlap).
//            Code found but name DISAGREES  -> the person is NOT loaded and is listed.
//            Code not in TeamLink           -> NOT loaded, never created, listed as "not in the system".
//            Relieved / Exited people       -> NOT loaded (listed; --include-left TLxxx to override).
//            Department / designation of the file are never copied (only reported when they differ).
//
// WHAT --apply WRITES
//   * AttendancePunch  one row per raw punch: source "PulseHRM import", method "Biometric" (method "PulseHRM import" for a
//                      report time the log does not carry), verification "Imported", IST HH:MM:SS. First punch = In; the Out
//                      cluster only when the report has a check-out (a missing check-out is NEVER invented).
//                      Dedupe: a punch whose (employee, date, second) already exists in ANY source (earlier import, device,
//                      web check-in) is skipped; nothing existing is edited or deleted.
//   * AttendanceHistory the raw log + report values of the day (as the earlier loads).
//   * Attendance day   Present + check-in/out only when the REPORT has the day and TeamLink has no row; blank times of an
//                      existing Present / Half Day / Late row are filled. Nothing else. 15 Oct (no report rows) gets punches
//                      only: the day is not over, no day row, no absence, no LOP.
//   * One AuditLog row + one idempotency marker (AppSetting). NO notification, NO e-mail, NO late/early marks: imported
//     punches never count for the live alert sweeps (utils/attendanceAlerts.js) and the status of every day is derived by
//     utils/attendanceDays.js (late after 09:15, Sunday off, absent-without-leave never on today).
//
// MODES (default = DRY RUN)
//   node scripts/load-attendance-13-15oct.js [--db <file>] [--dir <folder>] [--report <md>] [--csv <prefix>]
//        DRY RUN: VACUUM INTO a temp copy, runs the whole load on the copy, prints the tables, deletes the copy.
//   ... --apply            backup first (VACUUM INTO ~/.teamlink-backups/...), ONE transaction, undo manifest, marker.
//   ... --undo <manifest>  exact reverse of one --apply.
//   --include-left TL424,..  --force-rerun  --backup-dir <dir>  --from/--to (default 2026-10-13 / 2026-10-15)
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
const MARKER_KEY = 'attendance.load.bio-13-15oct';

const prev = require('./load-pulsehrm-28sep-13oct'); // directions(), timesOf() (module.exports; main() does not run on require)
const { directions, timesOf } = prev;

// ------------------------------------------------------------------ pure helpers
const sec = (t) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t || ''); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : null; };
const hhmm = (t) => (t ? t.slice(0, 5) : null);
const clk = (t) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}` : null; };
const eachDay = (a, b) => { const o = []; const d = new Date(`${a}T00:00:00Z`); const e = new Date(`${b}T00:00:00Z`); for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) o.push(d.toISOString().slice(0, 10)); return o; };
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const counts = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const normDesig = (s) => { const a = alnum(s).replace('recuiter', 'recruiter'); return a === 'tl' ? 'teamlead' : a; };
const toMin = (t) => { const s = sec(t); return s == null ? null : Math.floor(s / 60); };
const GAP_SEC = 120;

// ---- loose name check: code is the key, the name must only agree loosely
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function lev(a, b) {
  const m = a.length; const n = b.length; if (!m) return n; if (!n) return m;
  let p = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) { const c = [i]; for (let j = 1; j <= n; j += 1) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; }
  return p[n];
}
const tokMatch = (a, b) => a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b)) || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a) || lev(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1)));
// 'exact' (same words, case/space/dot-insensitive) | 'loose' (token overlap >= 50%, at least one real word) | 'disagree'
function nameVerdict(fileName, tlName) {
  const a = tokens(fileName); const b = tokens(tlName);
  if (!a.length || !b.length) return 'disagree';
  if (alnum(fileName) === alnum(tlName) || [...a].sort().join('') === [...b].sort().join('')) return 'exact';
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const pool = [...l]; let hit = 0; let real = 0;
  for (const t of s) { const i = pool.findIndex((x) => tokMatch(t, x)); if (i >= 0) { hit += 1; if (t.length > 1 && pool[i].length > 1) real += 1; pool.splice(i, 1); } }
  return real >= 1 && hit / s.length >= 0.5 ? 'loose' : 'disagree';
}

async function main(argv) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const RANGE = { from: opt('--from', '2026-10-13'), to: opt('--to', '2026-10-15') };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(RANGE.from) || !/^\d{4}-\d{2}-\d{2}$/.test(RANGE.to) || RANGE.from > RANGE.to) throw new Error(`bad --from/--to: ${RANGE.from} .. ${RANGE.to}`);
  const inRange = (d) => d >= RANGE.from && d <= RANGE.to;
  const DIR = opt('--dir', 'C:/Users/user/Downloads');
  const FILES = {
    logs: opt('--logs', 'bio-metric_logs (7).csv'),
    report: opt('--attendance-report', 'first_check-in_&_last_check-out_report_form_13-oct-2026_to_15-oct-2026.csv'),
  };
  const filePath = (f) => (path.isAbsolute(f) ? f : path.join(DIR, f));
  const MODE = flag('--undo') ? 'undo' : flag('--apply') ? 'apply' : 'dry';
  const DB_ARG = path.resolve(opt('--db', REAL_DB));
  const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const BACKUP_DIR = path.resolve(opt('--backup-dir', path.join(os.homedir(), '.teamlink-backups', `attendance-13-15oct-${STAMP}`)));
  const INCLUDE_LEFT = new Set(String(opt('--include-left', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const isReal = (p) => path.resolve(p).toLowerCase() === REAL_DB.toLowerCase();
  const TAG = `Attendance load ${RANGE.from}..${RANGE.to} (${FILES.logs})`;
  const ACTOR = `Attendance load ${RANGE.from} - ${RANGE.to} (script)`;

  if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 42).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
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

  let WORK_DB = DB_ARG; let TEMP_DB = null;
  if (MODE === 'dry') { TEMP_DB = path.join(os.tmpdir(), `tl-att-1315-${STAMP}-${process.pid}.db`); snapshot(DB_ARG, TEMP_DB); WORK_DB = TEMP_DB; }
  process.env.DATABASE_URL = `file:${WORK_DB.split(path.sep).join('/')}?connection_limit=1&socket_timeout=300`;
  process.env.TEST_MODE = process.env.TEST_MODE || '1'; // no workers / mail from this process
  const prisma = require('../src/db'); // eslint-disable-line global-require
  const hist = require('../src/utils/attendanceHistoryImport'); // eslint-disable-line global-require
  const D = require('../src/utils/attendanceDays'); // eslint-disable-line global-require
  const { isLate } = require('../src/utils/attendanceMath'); // eslint-disable-line global-require
  const readTxt = (f) => fs.readFileSync(filePath(f), 'utf8');
  const inputHash = crypto.createHash('sha256').update(Buffer.concat(['logs', 'report'].map((k) => fs.readFileSync(filePath(FILES[k]))))).digest('hex').slice(0, 16);

  const newManifest = () => ({
    version: 1, script: path.basename(__filename), createdAt: new Date().toISOString(), db: WORK_DB, range: RANGE, batch: null, backup: null, inputHash,
    created: { Attendance: [], AttendancePunch: [], AttendanceHistory: [], AuditLog: [], AppSetting: [] },
    changed: { Attendance: [], AttendanceHistory: [], AppSetting: [] },
  });
  let CURRENT = null;

  // ================================================================ THE LOAD
  async function load(report) {
    const man = newManifest(); CURRENT = man;
    man.batch = `att1315-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    report.batch = man.batch;
    const marker = await prisma.appSetting.findUnique({ where: { key: MARKER_KEY } });
    report.marker = marker ? JSON.parse(marker.value) : null;
    if (MODE === 'apply' && marker && report.marker.inputHash === inputHash && !flag('--force-rerun')) {
      report.alreadyApplied = true;
      throw new Error(`already applied on ${report.marker.at} (batch ${report.marker.batch}) with these same input files - nothing to do (use --force-rerun to run the idempotent pass anyway)`);
    }

    // ---- inputs
    const F4 = hist.parseCsv(readTxt(FILES.logs)).rows;
    const F1 = hist.parseCsv(readTxt(FILES.report)).rows;
    report.inputs = { logs: { file: FILES.logs, rows: F4.length }, report: { file: FILES.report, rows: F1.length }, inputHash };
    const logDays = new Map(); const fileIssues = [];
    F4.forEach((r, i) => {
      const [c, ...n] = String(r.Employee || '').split(' - '); const code = (c || '').trim(); const date = hist.isoDate(r['Attendance Date']);
      if (!code || !date) { fileIssues.push(`bio-metric log row ${i + 2}: unreadable id/date`); return; }
      if (!inRange(date)) { fileIssues.push(`bio-metric log row ${i + 2}: ${code} ${date} is outside ${RANGE.from}..${RANGE.to} (ignored)`); return; }
      const raw = String(r['Time Interval'] || '').split('|').map((t) => clk(t)).filter(Boolean);
      const key = `${code}|${date}`;
      if (logDays.has(key)) { fileIssues.push(`bio-metric log row ${i + 2}: ${code} ${date} listed twice (times merged)`); const o = logDays.get(key); o.times = [...new Set([...o.times, ...raw])].sort(); o.rawCount += raw.length; return; }
      logDays.set(key, { code, date, name: tidy(n.join(' - ')), dept: tidy(r.Department), desig: tidy(r.Designation), times: timesOf(r['Time Interval']), rawCount: raw.length });
    });
    const repDays = new Map();
    F1.forEach((r, i) => {
      const code = (r['Employee Ref No'] || r['Employee No'] || '').trim(); const date = hist.isoDate(r.Date);
      if (!code || !date) { fileIssues.push(`report row ${i + 2}: unreadable id/date`); return; }
      if (!inRange(date)) { fileIssues.push(`report row ${i + 2}: ${code} ${date} outside range (ignored)`); return; }
      const dup = repDays.has(`${code}|${date}`);
      if (dup) fileIssues.push(`report row ${i + 2}: ${code} ${date} listed twice (last row wins)`);
      repDays.set(`${code}|${date}`, { code, date, name: tidy(r['Employee Name']), dept: tidy(r.Department), desig: tidy(r.Designation), first: clk(r['First Check In']), last: clk(r['Last Check Out']), location: tidy(r['Work Location']) || null, worked: r['Total Time Worked'] || null, breakT: r['Total Time In Break'] || null, hours: r['Total Hours'] || null });
    });
    report.fileIssues = fileIssues;

    // ---- 1. MATCH TABLE (code first, then the name)
    const empNow = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, department: true, designation: true, employmentStatus: true } });
    const byCode = new Map(empNow.map((e) => [e.employeeCode.trim().toUpperCase(), e]));
    const fileP = new Map();
    const addP = (code, src, name, dept, desig) => {
      const o = fileP.get(code) || { code, names: new Set(), dept: '', desig: '', sources: new Set() };
      o.sources.add(src); if (tidy(name)) o.names.add(tidy(name)); if (!o.dept && tidy(dept)) o.dept = tidy(dept); if (!o.desig && tidy(desig)) o.desig = tidy(desig);
      fileP.set(code, o);
    };
    logDays.forEach((x) => addP(x.code, 'bio-metric log', x.name, x.dept, x.desig));
    repDays.forEach((x) => addP(x.code, 'first/last report', x.name, x.dept, x.desig));
    const matchRows = [];
    for (const f of [...fileP.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))) {
      const row = { code: f.code, fileNames: [...f.names], fileDept: f.dept, fileDesig: f.desig, sources: [...f.sources], verdict: '', flags: [], tl: null, loadable: false };
      const e = byCode.get(f.code.toUpperCase());
      if (f.names.size > 1 && new Set([...f.names].map((n) => alnum(n))).size > 1) row.flags.push('two different names in the two files for this id');
      if (!e) {
        row.verdict = 'NOT IN THE SYSTEM';
        const hit = empNow.filter((x) => [...f.names].some((n) => nameVerdict(n, x.name) === 'exact'));
        if (hit.length) row.flags.push(`a similar name exists under another id: ${hit.map((h) => h.employeeCode).join(', ')} (NOT loaded: id decides)`);
        matchRows.push(row); continue;
      }
      row.tl = { id: e.id, code: e.employeeCode, name: e.name, designation: e.designation || '', department: e.department || '', status: e.employmentStatus };
      const verdicts = [...f.names].map((n) => nameVerdict(n, e.name));
      const v = verdicts.includes('disagree') ? 'disagree' : verdicts.includes('loose') ? 'loose' : 'exact';
      const exactStr = [...f.names].every((n) => tidy(n).toLowerCase() === tidy(e.name).toLowerCase());
      if (v === 'disagree') { row.verdict = 'NAME DISAGREES (not loaded)'; row.flags.push('id found but the name does not match: loading skipped'); }
      else if (v === 'loose') { row.verdict = 'ID + NAME MATCH (name spelt differently)'; row.loadable = true; }
      else { row.verdict = exactStr ? 'ID + NAME EXACT' : 'ID + NAME MATCH (case/spacing/dots only)'; row.loadable = true; }
      if (f.desig && normDesig(e.designation) !== normDesig(f.desig)) row.flags.push('designation differs (info only)');
      if (f.dept && alnum(e.department) !== alnum(f.dept)) row.flags.push("department differs (the file's own list; TeamLink's is kept)");
      if (LEFT.includes(e.employmentStatus) && !INCLUDE_LEFT.has(f.code.toUpperCase())) { row.flags.push(`${e.employmentStatus} in TeamLink: not loaded`); row.loadable = false; row.left = true; }
      matchRows.push(row);
    }
    report.match = matchRows;
    const matchOf = new Map(matchRows.map((m) => [m.code.toUpperCase(), m]));

    // ---- 2. attendance plan
    const A = (report.attendance = {
      notInSystem: [], nameDisagree: [], left: [], protectedDays: [], created: { Attendance: 0, AttendancePunch: 0, AttendanceHistory: 0 }, filled: 0, histUpdated: 0,
      perDay: [], perDate: {}, crossCheck: { first: [], last: [], reportOnly: [], logOnly: [], eveningNoOut: [] }, daysNoChange: 0, fileDupSeconds: 0, dupBySource: {},
      lonePunch15: [], firstOnly14: [], complexDays: [],
    });
    const byDate = (d) => (A.perDate[d] = A.perDate[d] || { fileDays: 0, filePunches: 0, punchesNew: 0, punchesDup: 0, daysCreate: 0, daysFill: 0, people: 0 });
    const allKeys = new Set([...logDays.keys(), ...repDays.keys()]);
    const ids = [...new Set([...allKeys].map((k) => (byCode.get(k.split('|')[0].toUpperCase()) || {}).id).filter(Boolean))];
    const [exDays, exAH, exPunches, exRegs] = await Promise.all([
      prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { gte: RANGE.from, lte: RANGE.to } } }),
      prisma.attendanceHistory.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } }),
      prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { gte: RANGE.from, lte: RANGE.to } } }),
      prisma.attendanceRegularization.findMany({ where: { employeeId: { in: ids }, date: { gte: RANGE.from, lte: RANGE.to }, status: 'Approved' } }),
    ]);
    const dayOf = new Map(exDays.map((a) => [`${a.employeeId}|${a.date}`, a]));
    const ahOf = new Map(exAH.map((h) => [`${h.employeeRef}|${h.date}`, h]));
    const punchTime = (p) => p.clockTime || `${p.time}:00`;
    const punchSrc = new Map(); // emp|date|second -> label of what is already there
    exPunches.forEach((p) => punchSrc.set(`${p.employeeId}|${p.date}|${punchTime(p)}`, `${p.source || '?'}${p.method ? ` / ${p.method}` : ''}`));
    const punchesOfDay = new Map(); exPunches.forEach((p) => { (punchesOfDay.get(`${p.employeeId}|${p.date}`) || punchesOfDay.set(`${p.employeeId}|${p.date}`, []).get(`${p.employeeId}|${p.date}`)).push(p); });
    const regSet = new Set(exRegs.map((r) => `${r.employeeId}|${r.date}`));
    const EDITABLE = new Set(['Present', 'Half Day', 'Late']);
    const ops = [];
    const sortedKeys = [...allKeys].sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]) || a.localeCompare(b, undefined, { numeric: true }));
    for (const key of sortedKeys) {
      const [code, date] = key.split('|');
      const lg = logDays.get(key); const rp = repDays.get(key);
      const times = [...new Set([...(lg ? lg.times : []), ...(rp && rp.first ? [rp.first] : []), ...(rp && rp.last ? [rp.last] : [])])].sort();
      // cross-check of the report (first / last) against the log
      if (lg && rp) {
        if (rp.first && lg.times[0] && rp.first !== lg.times[0]) A.crossCheck.first.push({ code, date, report: rp.first, log: lg.times[0] });
        if (rp.last && lg.times.length && rp.last !== lg.times[lg.times.length - 1]) A.crossCheck.last.push({ code, date, report: rp.last, log: lg.times[lg.times.length - 1] });
        if (!rp.last && lg.times.length > 1 && sec(lg.times[lg.times.length - 1]) - sec(lg.times[0]) > GAP_SEC) A.crossCheck.eveningNoOut.push({ code, date, log: lg.times.join('|'), first: rp.first });
        if (!rp.last && lg.times.length === 1 && rp.first && lg.times[0] !== rp.first) A.crossCheck.eveningNoOut.push({ code, date, log: lg.times.join('|'), first: rp.first });
      } else if (rp && !lg) A.crossCheck.reportOnly.push({ code, date });
      else if (lg && !rp) A.crossCheck.logOnly.push({ code, date, times: lg.times.length });
      if (lg) A.fileDupSeconds += lg.rawCount - lg.times.length;
      const m = matchOf.get(code.toUpperCase());
      const emp = m && m.tl ? byCode.get(code.toUpperCase()) : null;
      if (!emp) { A.notInSystem.push({ code, date, punches: times.length }); continue; }
      if (m.verdict.startsWith('NAME DISAGREES')) { A.nameDisagree.push({ code, date, punches: times.length }); continue; }
      if (m.left) { A.left.push({ code, status: emp.employmentStatus, date, punches: times.length }); continue; }
      const dk = `${emp.id}|${date}`;
      const a = dayOf.get(dk) || null; const eps = punchesOfDay.get(dk) || [];
      const manual = eps.some((p) => /manual/i.test(String(p.source || '')));
      let protect = null;
      if (regSet.has(dk)) protect = 'an approved attendance correction exists for this day';
      else if (manual) protect = 'a punch typed by HR exists for this day';
      else if (a && !EDITABLE.has(a.status)) protect = `TeamLink has this day marked ${a.status}`;
      else if (a && !a.checkIn && !a.checkOut && !eps.length) protect = `HR marked this day ${a.status} (no times)`;
      const d = byDate(date); d.fileDays += 1; d.filePunches += times.length; d.people += 1;
      if (protect) { A.protectedDays.push({ code, date, why: protect, punches: times.length }); A.perDay.push({ code, date, filePunches: times.length, newP: 0, dup: 0, dupWeb: 0, dupImport: 0, existingOther: eps.length, protect }); continue; }
      const dir = directions(times, rp && rp.last ? rp.last : null);
      const inLog = new Set(lg ? lg.times : []);
      if (times.length > 3 && rp && rp.last) { const d0 = [...dir.values()]; if (d0.filter((x) => x === 'Out').length > 1 && d0.filter((x) => x === 'In').length > 1) A.complexDays.push({ code, date, times: times.length }); }
      const newPunches = []; let dup = 0; let dupWeb = 0; let dupImport = 0; let dupDev = 0;
      for (const t of times) {
        const ex = punchSrc.get(`${emp.id}|${date}|${t}`);
        if (ex) { dup += 1; if (/import/i.test(ex)) dupImport += 1; else if (/web|mobile/i.test(ex)) dupWeb += 1; else dupDev += 1; A.dupBySource[ex] = (A.dupBySource[ex] || 0) + 1; continue; }
        newPunches.push({ time: t, direction: dir.get(t), method: inLog.has(t) ? 'Biometric' : hist.SOURCE });
      }
      d.punchesNew += newPunches.length; d.punchesDup += dup;
      A.perDay.push({ code, date, filePunches: times.length, newP: newPunches.length, dup, dupWeb, dupImport, dupDev, existingOther: eps.length, protect: null });
      if (date === RANGE.to && times.length === 1) A.lonePunch15.push({ code, time: times[0] });
      if (rp && rp.first && !rp.last) A.firstOnly14.push({ code, date, first: rp.first, logTimes: lg ? lg.times.join('|') : '(no log row)' });
      ops.push({ emp, code, date, lg, rp, times, newPunches, a, dk });
    }

    // ---- 3. the writes (one transaction)
    await prisma.$transaction(async (tx) => {
      for (const op of ops) {
        const { emp, code, date, lg, rp, newPunches, a } = op;
        const first = rp && rp.first ? rp.first : null; const last = rp && rp.last ? rp.last : null;
        const pv = ahOf.get(`${code}|${date}`);
        const logTimes = lg ? lg.times : [];
        const mergedTimes = [...new Set([...(pv && pv.punchTimes ? pv.punchTimes.split('|').filter(Boolean) : []), ...logTimes])].sort();
        const punchTimes = mergedTimes.length ? mergedTimes.join('|') : null;
        const histData = {
          employeeRef: code, employeeId: emp.id, matchStatus: 'Matched', sourceName: null, date, firstCheckIn: first || (pv ? pv.firstCheckIn : null), lastCheckOut: last || (pv ? pv.lastCheckOut : null),
          totalTimeWorked: rp ? (rp.worked || (pv && pv.totalTimeWorked) || null) : (pv ? pv.totalTimeWorked : null), totalBreak: rp ? (rp.breakT || (pv && pv.totalBreak) || null) : (pv ? pv.totalBreak : null),
          totalHours: rp ? (rp.hours || (pv && pv.totalHours) || null) : (pv ? pv.totalHours : null), workLocation: rp ? (rp.location || (pv && pv.workLocation) || null) : (pv ? pv.workLocation : null),
          punchTimes, sources: [...new Set([...(pv ? pv.sources.split('+') : []), lg ? 'logs' : null, rp ? 'report' : null].filter(Boolean))].join('+'),
          result: `Loaded by the ${RANGE.from} - ${RANGE.to} attendance load: ${newPunches.length} punch(es) added`, importBatch: man.batch, importedById: null,
        };
        if (!pv) { const h = await tx.attendanceHistory.create({ data: histData }); man.created.AttendanceHistory.push(h.id); A.created.AttendanceHistory += 1; }
        else if (['punchTimes', 'firstCheckIn', 'lastCheckOut', 'totalHours', 'totalTimeWorked', 'sources'].some((k) => (pv[k] || null) !== (histData[k] || null))) {
          man.changed.AttendanceHistory.push({ id: pv.id, before: JSON.parse(JSON.stringify(pv)) });
          await tx.attendanceHistory.update({ where: { id: pv.id }, data: { ...histData, sourceName: pv.sourceName } });
          A.histUpdated += 1;
        }
        if (rp && first) {
          if (!a) {
            const row = await tx.attendance.create({ data: { employeeId: emp.id, date, status: 'Present', checkIn: hhmm(first), checkOut: last ? hhmm(last) : null } });
            man.created.Attendance.push(row.id); A.created.Attendance += 1; byDate(date).daysCreate += 1;
          } else if (EDITABLE.has(a.status)) {
            const data = {};
            if (!a.checkIn && first) data.checkIn = hhmm(first);
            if (!a.checkOut && last) data.checkOut = hhmm(last);
            if (Object.keys(data).length) {
              man.changed.Attendance.push({ id: a.id, before: { checkIn: a.checkIn, checkOut: a.checkOut }, set: data });
              await tx.attendance.update({ where: { id: a.id }, data }); A.filled += 1; byDate(date).daysFill += 1;
            }
          }
        }
        for (const p of newPunches) {
          const row = await tx.attendancePunch.create({
            data: { employeeId: emp.id, date, location: rp ? rp.location : null, source: hist.SOURCE, verificationStatus: 'Imported', time: hhmm(p.time), clockTime: p.time, direction: p.direction, method: p.method, userAgent: TAG },
          });
          man.created.AttendancePunch.push(row.id); A.created.AttendancePunch += 1;
        }
        if (!newPunches.length) A.daysNoChange += 1;
      }
      if (A.created.AttendancePunch + A.created.Attendance + A.filled + A.created.AttendanceHistory + A.histUpdated > 0) {
        const al = await tx.auditLog.create({ data: { userId: null, actorName: ACTOR, action: 'Attendance loaded from the old HRMS files', entity: 'AttendanceHistory', entityId: man.batch, toValue: `${A.created.AttendancePunch} punch(es), ${A.created.Attendance} day(s) created, ${A.filled} filled, ${A.created.AttendanceHistory} history created, ${A.histUpdated} updated (${RANGE.from}..${RANGE.to})` } });
        man.created.AuditLog.push(al.id);
        const value = JSON.stringify({ batch: man.batch, at: new Date().toISOString(), inputHash, range: RANGE });
        await tx.appSetting.upsert({ where: { key: MARKER_KEY }, update: { value }, create: { key: MARKER_KEY, value } });
        if (marker) man.changed.AppSetting.push({ key: MARKER_KEY, before: marker.value }); else man.created.AppSetting.push(MARKER_KEY);
      }
    }, { maxWait: 120000, timeout: 600000 });
    report.manifest = man;
    report.fileState = { logDays, repDays };
    return man;
  }

  // ================================================================ UNDO
  async function undoManifest(man) {
    const c = man.created; const ch = man.changed; const out = {};
    await prisma.$transaction(async (tx) => {
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
      out.AuditLog = (await tx.auditLog.deleteMany({ where: { id: { in: c.AuditLog } } })).count;
      out.AppSetting = 0;
      for (const k of ch.AppSetting) { await tx.appSetting.update({ where: { key: k.key }, data: { value: k.before } }).catch(() => {}); out.AppSetting += 1; }
      out.AppSetting += (await tx.appSetting.deleteMany({ where: { key: { in: c.AppSetting } } })).count;
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
    const res = Object.fromEntries(dates.map((d) => [d, { date: d, headcount: 0, expectedHeadcount: 0, present: 0, absent: 0, halfDay: 0, onLeave: 0, offDay: 0, noRecord: 0, notYet: 0, other: 0, late: 0, awl: 0, missingOut: 0 }]));
    const rowsOf = new Map();
    employees.forEach((e) => {
      const rows = days(e); rowsOf.set(e.id, rows);
      rows.forEach((d) => {
        const bk = D.bucketOf(d); if (!bk || bk === 'upcoming') return; const r = res[d.date]; if (!r) return;
        r.headcount += 1; if (r[bk] !== undefined) r[bk] += 1; else r.other += 1;
        if (d.late) r.late += 1; if (d.awlKind) r.awl += 1; if (d.status === 'Missing Check-Out') r.missingOut += 1;
      });
      const joined = D.joinedOn(e); const left = roll.lastDayOf.has(e.id); const last = left ? roll.lastDayOf.get(e.id) : null;
      dates.forEach((d) => { if ((!joined || joined <= d) && !(left && (!last || d > last))) res[d].expectedHeadcount += 1; });
    });
    Object.values(res).forEach((r) => { r.sum = r.present + r.absent + r.halfDay + r.onLeave + r.offDay + r.noRecord + r.notYet + r.other; r.ok = r.sum === r.headcount && r.headcount === r.expectedHeadcount; });
    return { tiles: res, rowsOf, employees, cfg };
  }

  // every file punch present in TeamLink; first-in / last-out of the loaded rows vs the report
  async function recompare(fs0) {
    const { logDays, repDays } = fs0;
    const punches = await prisma.attendancePunch.findMany({ where: { date: { gte: RANGE.from, lte: RANGE.to } } });
    const pBy = new Map(); punches.forEach((p) => { (pBy.get(`${p.employeeId}|${p.date}`) || pBy.set(`${p.employeeId}|${p.date}`, []).get(`${p.employeeId}|${p.date}`)).push(p); });
    const r = { checked: 0, mismatches: [], notChecked: 0 };
    const fresh = new Map((await prisma.employee.findMany({ select: { id: true, employeeCode: true, employmentStatus: true, name: true } })).map((e) => [e.employeeCode.trim().toUpperCase(), e]));
    for (const k of new Set([...logDays.keys(), ...repDays.keys()])) {
      const [code, date] = k.split('|'); const e = fresh.get(code.toUpperCase());
      const m = (report0.match || []).find((x) => x.code.toUpperCase() === code.toUpperCase());
      if (!e || !m || !m.loadable) { r.notChecked += 1; continue; }
      const ps = pBy.get(`${e.id}|${date}`) || [];
      if (ps.some((p) => /manual/i.test(String(p.source || '')))) { r.notChecked += 1; continue; }
      const lg = logDays.get(k); const rp = repDays.get(k);
      const have = new Set(ps.map((p) => p.clockTime || `${p.time}:00`));
      const want = [...new Set([...(lg ? lg.times : []), ...(rp && rp.first ? [rp.first] : []), ...(rp && rp.last ? [rp.last] : [])])];
      const missing = want.filter((t) => !have.has(t));
      const prot = (report0.attendance.protectedDays || []).some((x) => x.code === code && x.date === date);
      if (prot) { r.notChecked += 1; continue; }
      r.checked += 1;
      const bad = [];
      if (missing.length) bad.push(`${missing.length} punch(es) of the file are not in TeamLink`);
      const imp = ps.filter((p) => p.source === hist.SOURCE);
      const outs = imp.filter((p) => p.direction === 'Out').map((p) => p.clockTime || `${p.time}:00`).sort();
      if (rp && rp.last && outs[outs.length - 1] !== rp.last) bad.push(`last-out report ${rp.last} vs TeamLink imported ${outs[outs.length - 1] || '-'}`);
      if (rp && !rp.last && outs.length) bad.push('TeamLink has an imported check-out the report does not');
      if (bad.length) r.mismatches.push({ code, date, problems: bad });
    }
    return r;
  }
  const report0 = {};

  // late rule: the file's first punch vs the app's engine (09:15 grace), for the days that carry a report
  async function lateCheck(tilesRes, fs0) {
    const grace = tilesRes.cfg.graceTime || '09:15';
    const emps = await prisma.employee.findMany({ select: { id: true, employeeCode: true } });
    const idOf = new Map(emps.map((e) => [e.employeeCode.trim().toUpperCase(), e.id]));
    const rows = []; const perDate = {};
    for (const [k, lg] of fs0.logDays) {
      const [code, date] = k.split('|'); if (date === RANGE.to) continue; // today is checked separately
      const m = report0.match.find((x) => x.code.toUpperCase() === code.toUpperCase());
      const rp = fs0.repDays.get(k);
      if (!m || !m.loadable || !idOf.has(code.toUpperCase())) continue;
      if (report0.attendance.protectedDays.some((x) => x.code === code && x.date === date)) continue;
      const first = [...lg.times, ...(rp && rp.first ? [rp.first] : [])].sort()[0];
      if (!first) continue;
      const expectLate = isLate(first.slice(0, 5), grace); // minutes-based, exactly as the engine: 09:15:xx is NOT late, 09:16 is
      const direct = toMin(first) > toMin(grace);
      const dr = (tilesRes.rowsOf.get(idOf.get(code.toUpperCase())) || []).find((x) => x.date === date);
      if (!dr) continue;
      const engineLate = !!(dr.late || dr.lateExcused);
      const web = (await prisma.attendancePunch.count({ where: { employeeId: idOf.get(code.toUpperCase()), date, source: { notIn: [hist.SOURCE] } } })) > 0;
      rows.push({ code, date, first, expectLate, direct, engineLate, engineStatus: dr.status, engineCheckIn: dr.checkIn, web });
      const pd = (perDate[date] = perDate[date] || { people: 0, fileLate: 0, engineLate: 0, differ: 0 });
      pd.people += 1; if (expectLate) pd.fileLate += 1; if (engineLate) pd.engineLate += 1; if (expectLate !== engineLate) pd.differ += 1;
    }
    return { grace, rows, perDate };
  }

  // ================================================================ REPORT
  const esc = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  function md(report) {
    const o = []; const p = (s = '') => o.push(s);
    const A = report.attendance; const V = report.verify; const c = report.manifest.created; const ch = report.manifest.changed;
    p(`# Attendance load ${RANGE.from} .. ${RANGE.to} - ${MODE === 'dry' ? 'DRY RUN (the real database is not written)' : MODE.toUpperCase()}`);
    p(`Generated ${new Date().toISOString()} - target ${path.basename(DB_ARG)} - files in ${DIR} - input fingerprint ${report.inputs.inputHash}.`);
    p('');
    p('## 1. Files and what the load writes');
    p(`- Bio-metric log: ${report.inputs.logs.rows} rows; first/last report: ${report.inputs.report.rows} rows; employee-days in the files: ${report.fileState.logDays.size} (log) / ${report.fileState.repDays.size} (report).`);
    p(`- Issues reading the files: ${report.fileIssues.length ? report.fileIssues.join('; ') : 'none'}.`);
    p('| Table | Rows created | Rows changed |'); p('|---|---|---|');
    [['AttendancePunch (raw punches)', c.AttendancePunch.length, 0], ['Attendance (day rows)', c.Attendance.length, ch.Attendance.length], ['AttendanceHistory (raw log + report)', c.AttendanceHistory.length, ch.AttendanceHistory.length], ['AuditLog', c.AuditLog.length, 0], ['AppSetting (idempotency marker)', c.AppSetting.length, ch.AppSetting.length], ['Notification / e-mail', 0, 0]]
      .forEach(([t, n, m]) => p(`| ${t} | ${n} | ${m} |`));
    p(''); p(`Batch ${report.batch}. Marker: ${report.marker ? `already present from ${report.marker.at}` : 'none yet; written by --apply'}.`);
    p('');
    p('## 2. MATCH TABLE (Employee ID first, then the name)');
    p(`Summary: ${Object.entries(counts(report.match, (m) => m.verdict)).map(([k, n]) => `${k}: ${n}`).join(' | ')}`); p('');
    p('| Id | Result | Name in files | Name in TeamLink | TeamLink status | Notes |'); p('|---|---|---|---|---|---|');
    report.match.forEach((m) => p(`| ${m.code} | ${m.verdict} | ${m.fileNames.join(' / ') || '-'} | ${m.tl ? m.tl.name : '-'} | ${m.tl ? m.tl.status : '-'} | ${m.flags.join('; ')} |`));
    p('');
    const bad = report.match.filter((m) => !m.loadable);
    p(`### Not loaded (${bad.length}): ${bad.map((m) => `${m.code} (${m.verdict}${m.left ? `, ${m.tl.status}` : ''})`).join('; ') || 'none'}`);
    p(`Not in the system (never created): ${report.match.filter((m) => m.verdict === 'NOT IN THE SYSTEM').map((m) => `${m.code} ${m.fileNames[0] || ''}`).join('; ') || 'none'}.`);
    p(`Name differs only by spelling (loaded): ${report.match.filter((m) => m.verdict.includes('spelt differently')).map((m) => `${m.code} file "${m.fileNames[0]}" / TeamLink "${m.tl.name}"`).join('; ') || 'none'}.`);
    p(`TL517-TL521 in TeamLink: ${['TL517', 'TL518', 'TL519', 'TL520', 'TL521'].map((k) => `${k} ${report.codesPresent[k] ? 'exists' : 'missing'}`).join(', ')}.`);
    p('');
    p('## 3. Punches: new vs duplicate');
    p(`Raw punches to create ${A.created.AttendancePunch}; already in TeamLink (same person + same second, any source: skipped) ${Object.values(A.dupBySource).reduce((a, b) => a + b, 0)}${Object.keys(A.dupBySource).length ? ` (${Object.entries(A.dupBySource).map(([k, n]) => `${k}: ${n}`).join(', ')})` : ''}; same-second repeats inside the log file collapsed: ${A.fileDupSeconds}; day rows created ${A.created.Attendance}, filled ${A.filled}; history rows created ${A.created.AttendanceHistory}, updated ${A.histUpdated}.`);
    p('| Date | People with data | Punches in files | New | Duplicates skipped | Day rows created | Day rows filled |'); p('|---|---|---|---|---|---|---|');
    Object.keys(A.perDate).sort().forEach((d) => { const x = A.perDate[d]; p(`| ${d} | ${x.people} | ${x.filePunches} | ${x.punchesNew} | ${x.punchesDup} | ${x.daysCreate} | ${x.daysFill} |`); });
    p(''); p('| Id | Date | Punches in files | New | Duplicate | (dup of web/mobile) | (dup of import) | Other punches already that day |'); p('|---|---|---|---|---|---|---|---|');
    A.perDay.forEach((x) => p(`| ${x.code} | ${x.date} | ${x.filePunches} | ${x.newP} | ${x.dup} | ${x.dupWeb || 0} | ${x.dupImport || 0} | ${x.existingOther}${x.protect ? ` PROTECTED: ${x.protect}` : ''} |`));
    p('');
    p(`Not loaded: id not in the system: ${A.notInSystem.length} day row(s) ${A.notInSystem.map((x) => `${x.code} ${x.date}`).join(', ') || ''}; name disagrees: ${A.nameDisagree.length}; Relieved/Exited: ${A.left.length} ${A.left.map((x) => `${x.code} (${x.status}) ${x.date}`).join(', ')}.`);
    p(`Days left alone on purpose (${A.protectedDays.length}): ${A.protectedDays.map((x) => `${x.code} ${x.date}: ${x.why}`).join('; ') || 'none'}.`);
    p('');
    p('### Cross-check: first/last report against the bio-metric log');
    const X = A.crossCheck;
    p(`- First check-in differs: ${X.first.length}${X.first.length ? ` -> ${X.first.map((x) => `${x.code} ${x.date} (report ${x.report}, log ${x.log})`).join('; ')}` : ''}.`);
    p(`- Last check-out differs: ${X.last.length}${X.last.length ? ` -> ${X.last.map((x) => `${x.code} ${x.date} (report ${x.report}, log ends ${x.log})`).join('; ')}` : ''}. The report time is added as a punch (method "PulseHRM import").`);
    p(`- Days in the report but not in the log: ${X.reportOnly.length}${X.reportOnly.length ? ` -> ${X.reportOnly.map((x) => `${x.code} ${x.date}`).join('; ')}` : ''}.`);
    p(`- Days in the log but not in the report: ${X.logOnly.length} (of which ${RANGE.to}: ${X.logOnly.filter((x) => x.date === RANGE.to).length}; the report has no ${RANGE.to} rows).`);
    p(`- Report has no check-out but the log has a different/evening punch: ${X.eveningNoOut.length}${X.eveningNoOut.length ? ` -> ${X.eveningNoOut.map((x) => `${x.code} ${x.date} (report first ${x.first}, log ${x.log})`).join('; ')}` : ''}. Punches are loaded as given; no check-out is invented (they stay In).`);
    p(`- Complex days (several in/out visits): ${A.complexDays.length}.`);
    p('');
    p('### Partial days');
    p(`- ${RANGE.to} (today): ${(A.perDate[RANGE.to] || {}).people || 0} people with punches, ${A.lonePunch15.length} with a single punch so far. No day rows, no absences, no LOP written.`);
    p(`- Report rows with a first check-in but no check-out (never fabricated): ${A.firstOnly14.length}${A.firstOnly14.length ? ` -> ${A.firstOnly14.map((x) => `${x.code} ${x.date} first ${x.first}, log: ${x.logTimes}`).join('; ')}` : ''}.`);
    p('');
    p('## 4. Checks on the loaded copy');
    p(`Re-compare of the files against TeamLink: ${V.recompare.checked} day-checks -> ${V.recompare.mismatches.length} mismatch(es); ${V.recompare.notChecked} not checked (not loaded by design).`);
    V.recompare.mismatches.forEach((m) => p(`- MISMATCH ${m.code} ${m.date}: ${m.problems.join('; ')}`));
    p(''); p('Day tiles (engine) BEFORE -> AFTER; equation Present + Absent + Half + Leave + Off + No device data + Not yet = Headcount must hold:');
    p('| Date | Headcount | Present | Absent | Half day | On leave | Off | No device data | Not yet | Late | Absent-no-leave (2 LOP tag) | Missing check-out | Equation |'); p('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    Object.keys(V.after).sort().forEach((d) => { const b = V.before[d]; const a = V.after[d]; p(`| ${d} | ${b.headcount} -> ${a.headcount} | ${b.present} -> ${a.present} | ${b.absent} -> ${a.absent} | ${b.halfDay} -> ${a.halfDay} | ${b.onLeave} -> ${a.onLeave} | ${b.offDay} -> ${a.offDay} | ${b.noRecord} -> ${a.noRecord} | ${b.notYet} -> ${a.notYet} | ${b.late} -> ${a.late} | ${b.awl} -> ${a.awl} | ${b.missingOut} -> ${a.missingOut} | ${a.ok ? 'OK' : `FAIL ${a.sum} vs ${a.headcount}/${a.expectedHeadcount}`} |`); });
    p('');
    p(`### Late rule (after ${V.late.grace}, minute-based as the engine): file first punch vs the app's day engine`);
    p('| Date | Loaded people | Late by the file (direct) | Late in the app | Disagree |'); p('|---|---|---|---|---|');
    Object.entries(V.late.perDate).sort().forEach(([d, x]) => p(`| ${d} | ${x.people} | ${x.fileLate} | ${x.engineLate} | ${x.differ} |`));
    const dis = V.late.rows.filter((x) => x.expectLate !== x.engineLate);
    p(`Disagreements: ${dis.length}${dis.length ? ` -> ${dis.map((x) => `${x.code} ${x.date} first ${x.first} (file says ${x.expectLate ? 'late' : 'on time'}, app ${x.engineLate ? 'late' : 'on time'}; app check-in ${x.engineCheckIn || '-'}, status ${x.engineStatus}${x.web ? ', has an earlier/other web or mobile check-in that day' : ''})`).join('; ')}` : ''}.`);
    p('Five examples:'); p('| Id | Date | First punch (file) | Direct rule (> 09:15) | App says | App status |'); p('|---|---|---|---|---|---|');
    report.lateExamples.forEach((x) => p(`| ${x.code} | ${x.date} | ${x.first} | ${x.direct ? 'late' : 'on time'} | ${x.engineLate ? 'late' : 'on time'} | ${x.engineStatus} |`));
    p('');
    p('People the app now shows as Absent (no punch in the files; before the load these dates had no device data at all): '+Object.entries(report.absentAfter).map(([d, l]) => `${d}: ${l.length}${l.length ? ` (${l.join(', ')})` : ''}`).join('; ')+'. None of them is tagged absent-without-leave (the 2-LOP rule is not active for these dates), and today is never marked absent.');
    p(`Side effects: Notification rows ${V.sideEffects.notifBefore} -> ${V.sideEffects.notifAfter}; AuditLog rows added ${V.sideEffects.auditAdded}; Task rows ${V.sideEffects.taskBefore} -> ${V.sideEffects.taskAfter}. Attendance issue tasks setting: ${V.sideEffects.issueTasks}. Live late/missing alerts: imported punches never count (source "PulseHRM import").`);
    return o.join('\n');
  }
  function csvs(report, prefix) {
    const w = (name, head, rows) => fs.writeFileSync(`${prefix}-${name}.csv`, `\uFEFF${[head.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n')}\r\n`);
    w('unmatched-mismatched', ['Id', 'Result', 'Name in files', 'Name in TeamLink', 'TeamLink status', 'Department (file)', 'Department (TeamLink)', 'Designation (file)', 'Designation (TeamLink)', 'Notes'],
      report.match.filter((m) => m.verdict !== 'ID + NAME EXACT').map((m) => [m.code, m.verdict, m.fileNames.join(' / '), m.tl ? m.tl.name : '', m.tl ? m.tl.status : '', m.fileDept, m.tl ? m.tl.department : '', m.fileDesig, m.tl ? m.tl.designation : '', m.flags.join('; ')]));
    w('punches-per-employee-day', ['Id', 'Date', 'Punches in files', 'New', 'Duplicate', 'Protected'], report.attendance.perDay.map((x) => [x.code, x.date, x.filePunches, x.newP, x.dup, x.protect || '']));
    w('late-check', ['Id', 'Date', 'First punch', 'Direct (> grace)', 'App late', 'App status'], report.verify.late.rows.map((x) => [x.code, x.date, x.first, x.direct, x.engineLate, x.engineStatus]));
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
    const before = await tilesFor(RANGE.from, RANGE.to);
    const notifBefore = await prisma.notification.count(); const auditBefore = await prisma.auditLog.count(); const taskBefore = await prisma.task.count().catch(() => -1);
    if (MODE === 'apply') {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const bk = path.join(BACKUP_DIR, 'teamlink-before.db'); snapshot(WORK_DB, bk); console.log(`full backup copy: ${bk}`); report.backup = bk;
    }
    let man;
    try { man = await load(report); } catch (err) {
      console.error('LOAD FAILED:', err.message);
      throw err;
    }
    if (MODE === 'apply') {
      man.backup = report.backup; const mf = path.join(BACKUP_DIR, 'manifest.json'); fs.writeFileSync(mf, JSON.stringify(man, null, 1)); console.log(`manifest: ${mf}`); report.manifestFile = mf;
    }
    Object.assign(report0, report);
    const after = await tilesFor(RANGE.from, RANGE.to);
    const late = await lateCheck(after, report.fileState);
    const rc = await recompare(report.fileState);
    // five examples: spread over both days, late and on time, plus the 09:15:xx boundary when present
    const ex = []; const pick = (f) => { const x = late.rows.find((r) => f(r) && !ex.includes(r)); if (x) ex.push(x); };
    pick((r) => r.expectLate && r.date === '2026-10-13'); pick((r) => r.expectLate && r.date === '2026-10-14'); pick((r) => !r.expectLate && r.date === '2026-10-13'); pick((r) => !r.expectLate && r.date === '2026-10-14');
    pick((r) => toMin(r.first) === toMin(late.grace)); late.rows.forEach((r) => { if (ex.length < 5 && !ex.includes(r)) ex.push(r); });
    report.lateExamples = ex.slice(0, 5).map((r) => ({ ...r }));
    const is = await prisma.appSetting.findUnique({ where: { key: 'attendance.issueTasks.settings' } });
    const present = new Set((await prisma.employee.findMany({ where: { employeeCode: { in: ['TL517', 'TL518', 'TL519', 'TL520', 'TL521'] } }, select: { employeeCode: true } })).map((e) => e.employeeCode));
    report.codesPresent = Object.fromEntries(['TL517', 'TL518', 'TL519', 'TL520', 'TL521'].map((k) => [k, present.has(k)]));
    report.absentAfter = {};
    for (const d of eachDay(RANGE.from, RANGE.to)) { report.absentAfter[d] = []; for (const e of after.employees) { const r = (after.rowsOf.get(e.id) || []).find((x) => x.date === d); if (r && r.status === 'Absent') report.absentAfter[d].push(`${e.employeeCode}${(report.match.find((m) => m.code.toUpperCase() === e.employeeCode.trim().toUpperCase()) || {}).loadable ? '' : ''}`); } }
    report.verify = {
      recompare: rc, before: before.tiles, after: after.tiles, late,
      sideEffects: { notifBefore, notifAfter: await prisma.notification.count(), auditAdded: (await prisma.auditLog.count()) - auditBefore, taskBefore, taskAfter: await prisma.task.count().catch(() => -1), issueTasks: is ? is.value.slice(0, 120) : 'not set (engine OFF)' },
    };
    const text = md(report);
    const out = opt('--report'); if (out) fs.writeFileSync(out, text);
    const csvPrefix = opt('--csv'); if (csvPrefix) csvs(report, csvPrefix);
    console.log(text);
    const nBad = rc.mismatches.length + Object.values(after.tiles).filter((x) => !x.ok).length;
    console.log(`\nSUMMARY (${MODE}): created punches ${report.attendance.created.AttendancePunch}, days ${report.attendance.created.Attendance}, history ${report.attendance.created.AttendanceHistory}; mismatches ${rc.mismatches.length}, equation failures ${Object.values(after.tiles).filter((x) => !x.ok).length}`);
    if (MODE === 'dry') console.log('DRY RUN: nothing was written to the target database.');
    code = nBad ? 1 : 0;
  } finally {
    await prisma.$disconnect().catch(() => {});
    if (TEMP_DB) for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(TEMP_DB + s); } catch { /* gone */ } }
  }
  return code;
}

module.exports = { main, nameVerdict };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c || 0; }).catch((err) => { console.error('FAILED:', err.message); process.exitCode = 1; });
}
