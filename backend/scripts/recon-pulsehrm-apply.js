// ---------------------------------------------------------------------------
// recon-pulsehrm-apply.js - CORRECTIONS for the PulseHRM <-> TeamLink reconciliation
// (27 Sep -> 9 Oct 2026). DRY-RUN BY DEFAULT: it only reads and prints the plan.
//
//   node scripts/recon-pulsehrm-apply.js --files <folder with the 4 exports> --db <copy.db>            (dry run)
//   node scripts/recon-pulsehrm-apply.js ... --report plan.json                                         (dry run + full plan as JSON)
//   node scripts/recon-pulsehrm-apply.js ... --only days,summary,leave                                  (default: all three)
//   node scripts/recon-pulsehrm-apply.js ... --apply                                                    (write, on a COPY)
//   node scripts/recon-pulsehrm-apply.js --db <copy.db> --undo <manifest.json>                          (put everything back)
//   --apply on the REAL prisma/dev.db is refused unless BOTH  --really-real  AND  TL_ALLOW_REAL_APPLY=1.
//
// What it prepares (nothing else is ever touched):
//   days     Attendance days + AttendancePunch (first check-in = In, last check-out = Out) + AttendanceHistory
//            (every raw punch time of the day, "HH:MM:SS|HH:MM:SS|...") from the "First check-in & last check-out
//            report" and the "Bio-metric logs". SAME RULES as utils/attendanceHistoryImport.js (the Attendance
//            -> Import history screen): Employee ID is the only key, an existing day keeps its status, only
//            EMPTY check-in / check-out are filled, nothing is duplicated on a re-run. ONE EXTENSION: a day that
//            was imported earlier from the bio-metric LOG ONLY (e.g. 29 Sep in batch hist-20260929060603) and now
//            has its report row is UPGRADED (the old importer says "Already imported" and would leave those days
//            without a check-out forever); and a log that has grown (today) refreshes its punch list.
//   summary  AttendanceHistorySummary rows (PulseHRM's own totals, stored exactly as exported; payroll does not read them).
//   leave    LeaveRequest rows from the Leave History .xlsx (all statuses, as in the file). No approval chain is
//            started and nobody is notified (a Pending row gets its chain laid down by the app the first time it
//            is read - routes/leave.js ensureWorkflow). LEAVE BALANCES ARE NOT TOUCHED unless --draw-balance
//            is given (then an Approved row of the current year draws its days, like src/io/leaveHistory.js).
// Name / ID / department differences are NEVER written - they are listed for HR (see the workbook).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const L = require('./recon-pulsehrm-lib');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const APPLY = has('--apply');
const UNDO = val('--undo');
const REAL_FLAG = has('--really-real');
const ONLY = new Set(String(val('--only', 'days,summary,leave')).split(',').map((s) => s.trim()).filter(Boolean));
const DRAW_BALANCE = has('--draw-balance');
const REPORT = val('--report');
const SAMPLES = Number(val('--samples', 6));
const PERIOD = val('--period'); // "2026-09-27..2026-10-09" if the summary file name has no period

// ---- which database -------------------------------------------------------
const backendDir = path.resolve(__dirname, '..');
const realDb = path.resolve(backendDir, 'prisma/dev.db').replace(/\\/g, '/').toLowerCase();
let dbPath = val('--db');
if (dbPath) dbPath = path.resolve(dbPath).replace(/\\/g, '/');
const isReal = !dbPath || dbPath.toLowerCase() === realDb;
if ((APPLY || UNDO) && isReal) {
  if (!(REAL_FLAG && process.env.TL_ALLOW_REAL_APPLY === '1')) {
    console.error('REFUSED: --apply / --undo on the real prisma/dev.db needs BOTH  --really-real  and  TL_ALLOW_REAL_APPLY=1.\n'
      + 'Run it on a copy:  --db <copy.db>.');
    process.exit(3);
  }
}
if (dbPath) process.env.DATABASE_URL = `file:${dbPath}`;
else { try { require('dotenv').config({ path: path.join(backendDir, '.env') }); } catch (e) { /* dotenv optional */ } }

const prisma = require('../src/db');
const H = require('../src/utils/attendanceHistoryImport');
const leaveText = require('../src/utils/leaveText');

const hhmm = (t) => (t ? t.slice(0, 5) : null);
const secOf = (p) => p.clockTime || (p.time ? `${p.time}:00` : null);
const sample = (arr) => arr.slice(0, SAMPLES);
const pad2 = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; };
const BATCH = `recon-${stamp()}`;
const EDITABLE = new Set(['Present', 'Half Day', 'Late']);
const SOURCE = H.SOURCE;

function findFile(dir, test) {
  const names = fs.readdirSync(dir);
  return names.map((n) => path.join(dir, n)).find((f) => test(path.basename(f).toLowerCase()));
}

// ===========================================================================
// UNDO
// ===========================================================================
async function undo() {
  const m = JSON.parse(fs.readFileSync(UNDO, 'utf8'));
  console.log(`UNDO ${UNDO}  (batch ${m.batch}, applied ${m.appliedAt}, db ${m.db})`);
  if (path.resolve(m.db).replace(/\\/g, '/').toLowerCase() !== (dbPath || realDb).toLowerCase()) {
    console.error('REFUSED: this manifest was written for a different database file.'); process.exit(3);
  }
  const model = { AttendancePunch: 'attendancePunch', Attendance: 'attendance', AttendanceHistory: 'attendanceHistory', AttendanceHistorySummary: 'attendanceHistorySummary', LeaveRequest: 'leaveRequest', LeaveBalance: 'leaveBalance', AuditLog: 'auditLog' };
  let del = 0; let restored = 0;
  await prisma.$transaction(async (tx) => {
    for (const [name, ids] of Object.entries(m.created || {})) {
      if (!ids.length) continue;
      const r = await tx[model[name]].deleteMany({ where: { id: { in: ids } } });
      del += r.count; console.log(`  deleted ${r.count} ${name}`);
    }
    for (const [name, rows] of Object.entries(m.updated || {})) {
      for (const u of rows) {
        const { id, ...rest } = u.before;
        const data = {}; Object.entries(rest).forEach(([k, v]) => { if (!['createdAt', 'updatedAt'].includes(k)) data[k] = v; });
        await tx[model[name]].update({ where: { id: u.id }, data });
        restored += 1;
      }
      if (rows.length) console.log(`  restored ${rows.length} ${name}`);
    }
  }, { timeout: 120000, maxWait: 20000 });
  console.log(`UNDO done: ${del} rows removed, ${restored} rows restored.`);
}

// ===========================================================================
// PLAN - days (report + logs)
// ===========================================================================
async function planDays(files, employees) {
  const byCode = new Map(employees.map((e) => [e.employeeCode.trim().toUpperCase(), e]));
  const parsed = H.readFiles(files);
  const out = { items: [], problems: [...parsed.problems], files: {} };
  if (!parsed.report && !parsed.logs) return out;
  const days = new Map();
  const dayOf = (ref, date) => { const k = `${ref}|${date}`; if (!days.has(k)) days.set(k, { employeeRef: ref, date, sources: new Set() }); return days.get(k); };
  (parsed.report?.rows || []).forEach((r, i) => {
    const ref = (r['Employee Ref No'] || r['Employee No'] || '').trim();
    const date = H.isoDate(r.Date);
    if (!ref || !date) { out.problems.push(`Report row ${i + 2}: missing Employee ID or unreadable date "${r.Date}"`); return; }
    const d = dayOf(ref, date);
    if (d.sources.has('report')) { out.problems.push(`Report row ${i + 2}: ${ref} ${date} appears twice - first row used`); return; }
    d.sources.add('report');
    d.sourceName = d.sourceName || L.cleanName(r['Employee Name']);
    const c = (t) => { const x = L.clock(t); return x || null; };
    d.firstCheckIn = c(r['First Check In']); d.lastCheckOut = c(r['Last Check Out']);
    const dur = (t) => { const v = String(t || '').trim(); return v && v !== '::' ? v : null; };
    d.totalTimeWorked = dur(r['Total Time Worked']); d.totalBreak = dur(r['Total Time In Break']); d.totalHours = dur(r['Total Hours']);
    d.workLocation = L.cleanName(r['Work Location']) || null;
  });
  (parsed.logs?.rows || []).forEach((r, i) => {
    const [refPart, ...nameParts] = String(r.Employee || '').split(' - ');
    const ref = (refPart || '').trim();
    const date = H.isoDate(r['Attendance Date']);
    if (!ref || !date) { out.problems.push(`Log row ${i + 2}: missing Employee ID or unreadable date`); return; }
    const d = dayOf(ref, date);
    if (d.sources.has('logs')) { out.problems.push(`Log row ${i + 2}: ${ref} ${date} appears twice - first row used`); return; }
    d.sources.add('logs');
    d.sourceName = d.sourceName || L.cleanName(nameParts.join(' - '));
    d.punchTimes = String(r['Time Interval'] || '').split('|').map((t) => L.clock(t)).filter(Boolean).join('|') || null;
  });
  out.files = { report: parsed.report ? parsed.report.rows.length : 0, logs: parsed.logs ? parsed.logs.rows.length : 0 };

  const dates = [...days.values()].map((d) => d.date).sort();
  const lo = dates[0]; const hi = dates[dates.length - 1];
  const ids = [...new Set([...days.values()].map((d) => byCode.get(d.employeeRef.toUpperCase())?.id).filter(Boolean))];
  const [att, hist, punches] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { gte: lo, lte: hi } } }),
    prisma.attendanceHistory.findMany({ where: { date: { gte: lo, lte: hi } } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { gte: lo, lte: hi } }, select: { employeeId: true, date: true, time: true, clockTime: true, direction: true } }),
  ]);
  const exDay = new Map(att.map((a) => [`${a.employeeId}|${a.date}`, a]));
  const exHist = new Map(hist.map((h) => [`${h.employeeRef}|${h.date}`, h]));
  const punchesOf = new Map();
  punches.forEach((p) => { const k = `${p.employeeId}|${p.date}`; if (!punchesOf.has(k)) punchesOf.set(k, []); punchesOf.get(k).push(p); });

  for (const d of days.values()) {
    const emp = byCode.get(d.employeeRef.toUpperCase()) || null;
    const prev = exHist.get(`${d.employeeRef}|${d.date}`) || null;
    const item = { ...d, sources: [...d.sources].sort().join('+'), employee: emp, historyId: prev ? prev.id : null, prev, action: null, result: '', addPunches: false, historyOp: 'create' };
    const newReport = d.sources.has('report');
    const dayEval = () => {
      if (!d.firstCheckIn) { item.action = 'history-only'; item.result = 'Punch times only (no first check-in in the report) - attendance not created'; return; }
      const a = exDay.get(`${emp.id}|${d.date}`);
      const have = punchesOf.get(`${emp.id}|${d.date}`) || [];
      if (!a) { item.action = 'create'; item.result = 'Day created (Present) with the imported check-in / check-out'; } else if (!EDITABLE.has(a.status)) { item.action = 'conflict'; item.result = `Kept as it is - TeamLink has this day as ${a.status}`; } else if (a.checkIn && (a.checkOut || !d.lastCheckOut)) { item.action = 'keep'; item.result = 'Kept as it is - TeamLink already has check-in / check-out for this day'; } else { item.action = 'fill'; item.result = `Times added to the existing ${a.status} day (status unchanged)`; }
      item.existing = a || null;
      // punches only for a day this run creates / fills, never on top of punches TeamLink already has
      // (one small extension of the old rule: a missing Out is added to a day that already holds the In, never a second In)
      item.addIn = !have.some((p) => p.direction === 'In') && ['create', 'fill'].includes(item.action);
      item.addOut = !!d.lastCheckOut && !have.some((p) => p.direction === 'Out') && ['create', 'fill'].includes(item.action);
      item.addPunches = item.addIn || item.addOut;
      if (have.length && ['create', 'fill', 'keep'].includes(item.action)) {
        const mine = have.map(secOf).filter(Boolean).sort();
        const wantIn = d.firstCheckIn; const wantOut = d.lastCheckOut;
        const hasIn = mine.includes(wantIn); const hasOut = !wantOut || mine.includes(wantOut);
        if (!hasIn || !hasOut) item.note = `TeamLink already holds punches for this day (${mine.join(', ')}) that differ from the report (in ${wantIn}${wantOut ? `, out ${wantOut}` : ''}) - NOT changed`;
      }
    };
    if (!emp) {
      if (prev) { item.action = 'skip'; item.result = 'Already imported (unmatched employee)'; } else { item.action = 'unmatched'; item.result = 'Unmatched Employee - nothing created in TeamLink (history row only)'; }
    } else if (prev && prev.matchStatus === 'Matched') {
      const prevHasReport = String(prev.sources || '').includes('report');
      const outNowKnown = prevHasReport && prev.firstCheckIn === d.firstCheckIn && !prev.lastCheckOut && !!d.lastCheckOut;
      if (newReport && (!prevHasReport || outNowKnown)) {
        item.action = 'upgrade'; item.historyOp = 'update';
        dayEval();
        item.upgrade = item.action; item.action = `upgrade+${item.upgrade}`;
        item.result = `${outNowKnown ? 'Earlier import had a check-in but no check-out; the check-out is now in the report' : 'Earlier import had the bio-metric log only; report row added'}. ${item.result}`;
      } else if (newReport && prevHasReport && (prev.firstCheckIn !== d.firstCheckIn || prev.lastCheckOut !== d.lastCheckOut)) {
        item.action = 'differs'; item.result = `Already imported with different times (TeamLink history: ${prev.firstCheckIn || '-'} / ${prev.lastCheckOut || '-'}; file: ${d.firstCheckIn || '-'} / ${d.lastCheckOut || '-'}) - NOT changed, HR to decide`;
      } else if (d.punchTimes && d.punchTimes !== prev.punchTimes) {
        const grown = !prev.punchTimes || d.punchTimes.startsWith(prev.punchTimes);
        if (grown) { item.action = 'refresh-log'; item.historyOp = 'update'; item.result = 'Punch list refreshed (the log has more punches than the earlier import)'; } else { item.action = 'differs'; item.result = `Already imported with a different punch list (TeamLink: ${prev.punchTimes}) - NOT changed, HR to decide`; }
      } else { item.action = 'skip'; item.result = 'Already imported'; }
    } else {
      if (prev) item.historyOp = 'update'; // an earlier "Unmatched Employee" row, employee now exists
      dayEval();
    }
    out.items.push(item);
  }
  out.items.sort((a, b) => a.date.localeCompare(b.date) || a.employeeRef.localeCompare(b.employeeRef));
  return out;
}

// ===========================================================================
// PLAN - summary
// ===========================================================================
async function planSummary(files, employees) {
  const parsed = H.readFiles(files);
  const out = { items: [], problems: [] };
  if (!parsed.summary) return out;
  const byCode = new Map(employees.map((e) => [e.employeeCode.trim().toUpperCase(), e]));
  let period = PERIOD ? { from: PERIOD.split('..')[0], to: PERIOD.split('..')[1] } : null;
  if (!period) {
    const m = /(\d{2}-[a-z]{3}-\d{4})_to_(\d{2}-[a-z]{3}-\d{4})/i.exec(String(parsed.summary.name || ''));
    period = m ? { from: H.isoDate(m[1]), to: H.isoDate(m[2]) } : null;
  }
  if (!period || !period.from) { out.problems.push('The summary file name has no DD-mon-YYYY_to_DD-mon-YYYY period - pass --period 2026-09-27..2026-10-09'); return out; }
  out.period = period;
  const existing = await prisma.attendanceHistorySummary.findMany({ where: { periodFrom: period.from, periodTo: period.to } });
  const ex = new Map(existing.map((s) => [s.employeeRef, s]));
  parsed.summary.rows.forEach((r) => {
    const ref = (r['Employee Ref No'] || '').trim();
    if (!ref) return;
    const emp = byCode.get(ref.toUpperCase()) || null;
    const prev = ex.get(ref);
    const g = (label) => { const k = Object.keys(r).find((x) => x.trim().toLowerCase() === label); return k ? r[k] : ''; };
    const n = (v) => { const t = String(v || '').trim(); const x = Number(t); return t === '' || Number.isNaN(x) ? null : x; };
    const dur = (v) => { const t = String(v || '').trim(); return t && t !== '::' ? t : null; };
    const nm = L.cleanName(String(r['Employee Name'] || '').replace(new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-`), ''));
    out.items.push({
      employeeRef: ref, employee: emp, sourceName: nm, periodFrom: period.from, periodTo: period.to, location: L.cleanName(g('location')) || null,
      halfDay: n(g('half-day')), present: n(g('present')), weekOffs: n(g('week offs')), publicHolidays: n(g('public holidays')),
      leaves: n(g('leaves')), payableDays: n(g('payable days')), totalHours: dur(g('total hours')),
      historyId: prev ? prev.id : null,
      action: prev && (prev.matchStatus === 'Matched' || !emp) ? 'skip' : emp ? 'import' : 'unmatched',
    });
  });
  return out;
}

// ===========================================================================
// PLAN - leave
// ===========================================================================
const WIN_APPLIED_AFTER = '2026-09-29';
async function planLeave(file, employees) {
  const out = { items: [], problems: [] };
  if (!file) return out;
  const rows = await L.readLeaveXlsx(file);
  const byCode = new Map(employees.map((e) => [e.employeeCode.trim().toUpperCase(), e]));
  const ids = [...new Set(rows.map((r) => byCode.get(r.code.toUpperCase())?.id).filter(Boolean))];
  const types = await prisma.leaveType.findMany();
  const typeNames = types.map((t) => t.name);
  const existing = ids.length ? await prisma.leaveRequest.findMany({ where: { employeeId: { in: ids } } }) : [];
  const seen = new Map();
  for (const r of rows) {
    const emp = byCode.get(r.code.toUpperCase()) || null;
    const it = { row: r, employee: emp, action: null, notes: [] };
    const status = { approved: 'Approved', pending: 'Pending', rejected: 'Rejected', cancelled: 'Cancelled' }[String(r.status || '').toLowerCase()];
    if (!emp) { it.action = 'unmatched'; it.notes.push('Employee ID not in TeamLink - not imported'); out.items.push(it); continue; }
    if (!status) { it.action = 'error'; it.notes.push(`Unknown status "${r.status}"`); out.items.push(it); continue; }
    if (!r.from || !r.to) { it.action = 'error'; it.notes.push('No usable dates'); out.items.push(it); continue; }
    const type = typeNames.find((t) => t.toLowerCase() === r.type.toLowerCase());
    if (!type) { it.action = 'error'; it.notes.push(`Leave type "${r.type}" is not a TeamLink leave type`); out.items.push(it); continue; }
    const nm = L.compareNames(r.name, emp.name);
    if (nm === 'Different') it.notes.push(`Name in file "${r.name}" differs from TeamLink "${emp.name}" (matched by Employee ID)`);
    const half = /second/i.test(r.halfDay || '') ? 'Second Half' : /first/i.test(r.halfDay || '') ? 'First Half' : null;
    const days = r.days != null && r.days > 0 ? r.days : (half ? 0.5 : null);
    if (days == null) { it.action = 'error'; it.notes.push('No Duration'); out.items.push(it); continue; }
    if (days === 0.5 && !half && r.from === r.to) it.notes.push('Duration 0.5 but the Half Day column is blank (TeamLink reads a single-date 0.5 as a half day; PulseHRM\'s summary counted it as a FULL leave day)');
    const reasonStored = leaveText.compose({
      reason: r.reason, comments: r.comments,
      details: [['Half day', half], ['Approver', status === 'Pending' || !r.approver ? r.approver : null], ['Source', 'PulseHRM leave history']],
    });
    const key = `${emp.id}|${type}|${r.from}|${r.to}|${status}|${r.applied || ''}`;
    if (seen.has(key)) { it.action = 'duplicate-in-file'; it.notes.push(`Same person, type, dates, status and applied date as file row ${seen.get(key)}`); out.items.push(it); continue; }
    seen.set(key, r.row);
    const sameDates = existing.filter((x) => x.employeeId === emp.id && x.fromDate === r.from && x.toDate === r.to);
    const exact = sameDates.find((x) => x.type === type && x.status === status && String(x.createdAt.toISOString()).slice(0, 10) === (r.applied || String(x.createdAt.toISOString()).slice(0, 10)));
    const sameTypeDates = sameDates.find((x) => x.type === type && x.status === status);
    const overlap = existing.filter((x) => x.employeeId === emp.id && x.fromDate <= r.to && x.toDate >= r.from && ['Approved', 'Pending', 'Cancellation Requested'].includes(x.status));
    it.data = {
      employeeId: emp.id, type, fromDate: r.from, toDate: r.to, days, status, reason: reasonStored,
      decidedBy: status === 'Pending' ? null : (r.approver || 'Imported from spreadsheet'),
      decidedAt: status === 'Pending' ? null : (r.approvedDate ? new Date(`${r.approvedDate}T00:00:00.000Z`) : null),
      createdAt: r.applied ? new Date(`${r.applied}T00:00:00.000Z`) : undefined,
      approvalReason: status === 'Approved' ? (r.approverComments || null) : null,
      rejectReason: status === 'Rejected' ? (r.approverComments || null) : null,
    };
    it.draw = DRAW_BALANCE && status === 'Approved' && r.from.slice(0, 4) === String(new Date().getFullYear());
    if (exact || sameTypeDates) {
      it.action = 'exists'; it.existingId = (exact || sameTypeDates).id;
      it.notes.push(`Already in TeamLink (${(exact || sameTypeDates).status}, ${(exact || sameTypeDates).days} day(s))`);
    } else {
      const otherStatus = sameDates.find((x) => x.type === type);
      if (otherStatus) { it.action = 'status-differs'; it.existingId = otherStatus.id; it.notes.push(`TeamLink has the same leave as ${otherStatus.status}; file says ${status} - NOT changed (decide on the Leave screen, it moves the balance)`); } else {
        it.action = 'create';
        const clash = overlap.filter((x) => !(x.type === type && x.fromDate === r.from && x.toDate === r.to));
        if (clash.length && status === 'Approved') it.notes.push(`Overlaps TeamLink ${clash.map((x) => `${x.type} ${x.fromDate}->${x.toDate} ${x.status}`).join('; ')}`);
        if (clash.length && status !== 'Approved') it.notes.push(`Other leave on these dates in TeamLink: ${clash.map((x) => `${x.type} ${x.fromDate}->${x.toDate} ${x.status}`).join('; ')}`);
      }
    }
    out.items.push(it);
  }
  return out;
}

// ===========================================================================
// PRINT
// ===========================================================================
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
function printPlan(plan) {
  const line = (s = '') => console.log(s);
  line(`MODE: ${APPLY ? 'APPLY' : 'DRY RUN (nothing is written)'}   db: ${dbPath || '(default from .env)'}${isReal ? '   [REAL DATABASE]' : ''}`);
  if (plan.days) {
    const it = plan.days.items;
    line(`\n== DAYS (report ${plan.days.files.report} rows, logs ${plan.days.files.logs} rows -> ${it.length} employee-days)`);
    Object.entries(count(it, (x) => x.action)).forEach(([k, v]) => line(`   ${String(k).padEnd(28)} ${v}`));
    line(`   punches to add (In/Out): ${it.reduce((n, x) => n + (x.addIn ? 1 : 0) + (x.addOut ? 1 : 0), 0)}   attendance days to create: ${it.filter((x) => /(^|\+)create$/.test(x.action)).length}   filled: ${it.filter((x) => /(^|\+)fill$/.test(x.action)).length}`);
    line(`   history rows to create: ${it.filter((x) => !['skip', 'differs'].includes(x.action) && x.historyOp === 'create').length}, to update: ${it.filter((x) => !['skip', 'differs'].includes(x.action) && x.historyOp === 'update').length}`);
    const un = [...new Map(it.filter((x) => !x.employee).map((x) => [x.employeeRef, x.sourceName])).entries()];
    if (un.length) line(`   employee IDs not in TeamLink (history row only): ${un.map(([c, n]) => `${c} ${n}`).join('; ')}`);
    ['upgrade+create', 'upgrade+fill', 'upgrade+keep', 'upgrade+history-only', 'create', 'history-only', 'refresh-log', 'differs', 'conflict'].forEach((a) => {
      const s = it.filter((x) => x.action === a);
      if (s.length) { line(`   sample ${a}:`); sample(s).forEach((x) => line(`     ${x.employeeRef} ${x.date}  in ${x.firstCheckIn || '-'} out ${x.lastCheckOut || '-'}  punches ${(x.punchTimes || '').split('|').filter(Boolean).length}  ${x.result}${x.note ? ` | ${x.note}` : ''}`)); }
    });
    plan.days.problems.slice(0, 8).forEach((p) => line(`   problem: ${p}`));
  }
  if (plan.summary) {
    const it = plan.summary.items;
    line(`\n== SUMMARY (${plan.summary.period ? `${plan.summary.period.from} -> ${plan.summary.period.to}` : 'no period'}): ${it.length} rows`);
    Object.entries(count(it, (x) => x.action)).forEach(([k, v]) => line(`   ${k.padEnd(12)} ${v}`));
    plan.summary.problems.forEach((p) => line(`   problem: ${p}`));
  }
  if (plan.leave) {
    const it = plan.leave.items;
    line(`\n== LEAVE (${it.length} file rows)`);
    Object.entries(count(it, (x) => x.action)).forEach(([k, v]) => line(`   ${k.padEnd(18)} ${v}`));
    line(`   by status to create: ${JSON.stringify(count(it.filter((x) => x.action === 'create'), (x) => x.data.status))}   leave days to create: ${it.filter((x) => x.action === 'create').reduce((n, x) => n + x.data.days, 0)}`);
    line(`   balances: ${DRAW_BALANCE ? `Approved current-year rows DRAW their days (${it.filter((x) => x.action === 'create' && x.draw).length} rows)` : 'NOT touched (use --draw-balance to draw Approved days, like the Leave import screen)'}`);
    sample(it.filter((x) => x.action === 'create')).forEach((x) => line(`     create ${x.employee.employeeCode} ${x.data.type} ${x.data.fromDate}->${x.data.toDate} ${x.data.days}d ${x.data.status}${x.row.halfDay ? ` (${x.row.halfDay})` : ''} ${x.notes.join('; ')}`));
    it.filter((x) => !['create', 'exists'].includes(x.action)).forEach((x) => line(`     ${x.action}: ${x.row.code} ${x.row.type} ${x.row.from}->${x.row.to} ${x.row.status} | ${x.notes.join('; ')}`));
  }
}

// ===========================================================================
// APPLY
// ===========================================================================
async function applyPlan(plan) {
  const manifest = { batch: BATCH, appliedAt: new Date().toISOString(), db: dbPath || realDb, created: {}, updated: {} };
  const made = (name, id) => { (manifest.created[name] = manifest.created[name] || []).push(id); };
  const changed = (name, id, before) => { (manifest.updated[name] = manifest.updated[name] || []).push({ id, before }); };
  // backup first (VACUUM INTO a new file beside the database)
  const target = dbPath || realDb;
  const backup = `${target}.recon-backup-${BATCH}.db`;
  await prisma.$queryRawUnsafe(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`\nBACKUP written: ${backup}`);
  const manifestFile = `${target}.recon-manifest-${BATCH}.json`;
  const done = { daysCreated: 0, daysFilled: 0, punches: 0, historyCreated: 0, historyUpdated: 0, summary: 0, leave: 0, balanceDraws: 0 };

  await prisma.$transaction(async (tx) => {
    if (plan.days) {
      for (const it of plan.days.items) {
        if (['skip', 'differs'].includes(it.action)) continue;
        const emp = it.employee;
        const data = {
          employeeRef: it.employeeRef, employeeId: emp ? emp.id : null, matchStatus: emp ? 'Matched' : 'Unmatched Employee',
          sourceName: emp ? null : (it.sourceName || null), date: it.date,
          firstCheckIn: it.firstCheckIn || null, lastCheckOut: it.lastCheckOut || null, totalTimeWorked: it.totalTimeWorked || null,
          totalBreak: it.totalBreak || null, totalHours: it.totalHours || null, workLocation: it.workLocation || null, punchTimes: it.punchTimes || null,
          sources: it.sources, result: it.result.slice(0, 250), importBatch: BATCH, importedById: null,
        };
        if (it.action === 'refresh-log') {
          // keep every report column exactly as it was, only the log side changes
          const p = it.prev;
          Object.assign(data, { firstCheckIn: p.firstCheckIn, lastCheckOut: p.lastCheckOut, totalTimeWorked: p.totalTimeWorked, totalBreak: p.totalBreak, totalHours: p.totalHours, workLocation: p.workLocation, sources: String(p.sources).includes('logs') ? p.sources : `${p.sources}+logs`, result: p.result });
        }
        if (it.historyOp === 'update' && it.historyId) {
          const before = await tx.attendanceHistory.findUnique({ where: { id: it.historyId } });
          changed('AttendanceHistory', it.historyId, before);
          await tx.attendanceHistory.update({ where: { id: it.historyId }, data });
          done.historyUpdated += 1;
        } else {
          const r = await tx.attendanceHistory.create({ data });
          made('AttendanceHistory', r.id); done.historyCreated += 1;
        }
        if (!emp) continue;
        const act = it.upgrade || it.action;
        if (act === 'create') {
          const r = await tx.attendance.create({ data: { employeeId: emp.id, date: it.date, status: 'Present', checkIn: hhmm(it.firstCheckIn), checkOut: hhmm(it.lastCheckOut) } });
          made('Attendance', r.id); done.daysCreated += 1;
        } else if (act === 'fill') {
          const d = {};
          if (!it.existing.checkIn && it.firstCheckIn) d.checkIn = hhmm(it.firstCheckIn);
          if (!it.existing.checkOut && it.lastCheckOut) d.checkOut = hhmm(it.lastCheckOut);
          if (Object.keys(d).length) {
            changed('Attendance', it.existing.id, await tx.attendance.findUnique({ where: { id: it.existing.id } }));
            await tx.attendance.update({ where: { id: it.existing.id }, data: d }); done.daysFilled += 1;
          }
        }
        if (it.addPunches) {
          const inLog = (t) => !!(it.punchTimes && it.punchTimes.split('|').includes(t));
          const base = { employeeId: emp.id, date: it.date, location: it.workLocation || null, source: SOURCE, verificationStatus: 'Imported' };
          if (it.addIn) {
            const a = await tx.attendancePunch.create({ data: { ...base, time: hhmm(it.firstCheckIn), clockTime: it.firstCheckIn, direction: 'In', method: inLog(it.firstCheckIn) ? 'Biometric' : SOURCE } });
            made('AttendancePunch', a.id); done.punches += 1;
          }
          if (it.addOut) {
            const b = await tx.attendancePunch.create({ data: { ...base, time: hhmm(it.lastCheckOut), clockTime: it.lastCheckOut, direction: 'Out', method: inLog(it.lastCheckOut) ? 'Biometric' : SOURCE } });
            made('AttendancePunch', b.id); done.punches += 1;
          }
        }
      }
    }
    if (plan.summary) {
      for (const s of plan.summary.items) {
        if (!['import', 'unmatched'].includes(s.action)) continue;
        const data = {
          employeeRef: s.employeeRef, employeeId: s.employee ? s.employee.id : null, matchStatus: s.employee ? 'Matched' : 'Unmatched Employee',
          sourceName: s.employee ? null : s.sourceName, periodFrom: s.periodFrom, periodTo: s.periodTo, location: s.location,
          halfDay: s.halfDay, present: s.present, weekOffs: s.weekOffs, publicHolidays: s.publicHolidays, leaves: s.leaves,
          payableDays: s.payableDays, totalHours: s.totalHours, importBatch: BATCH, importedById: null,
        };
        if (s.historyId) {
          changed('AttendanceHistorySummary', s.historyId, await tx.attendanceHistorySummary.findUnique({ where: { id: s.historyId } }));
          await tx.attendanceHistorySummary.update({ where: { id: s.historyId }, data });
        } else { const r = await tx.attendanceHistorySummary.create({ data }); made('AttendanceHistorySummary', r.id); }
        done.summary += 1;
      }
    }
    if (plan.leave) {
      for (const it of plan.leave.items) {
        if (it.action !== 'create') continue;
        const r = await tx.leaveRequest.create({ data: it.data });
        made('LeaveRequest', r.id);
        const a = await tx.auditLog.create({ data: { actorName: 'PulseHRM reconciliation', action: 'Leave imported', entity: 'LeaveRequest', entityId: r.id, toValue: `${it.data.status} - ${it.data.type} ${it.data.fromDate} -> ${it.data.toDate} - ${it.data.days} day(s)`, reason: `${it.employee.employeeCode} ${it.employee.name} (${BATCH})` } });
        made('AuditLog', a.id);
        if (it.draw) {
          const bal = await tx.leaveBalance.findUnique({ where: { employeeId_type: { employeeId: it.employee.id, type: it.data.type } } });
          if (bal) {
            changed('LeaveBalance', bal.id, bal);
            await tx.leaveBalance.update({ where: { id: bal.id }, data: { taken: bal.taken + it.data.days } });
            const d = await tx.auditLog.create({ data: { actorName: 'PulseHRM reconciliation', action: 'Leave imported - drawn from balance', entity: 'LeaveRequest', entityId: r.id, toValue: `${it.data.type}: taken ${bal.taken} -> ${bal.taken + it.data.days} of ${bal.total}`, reason: `${it.employee.employeeCode} ${it.employee.name}` } });
            made('AuditLog', d.id); done.balanceDraws += 1;
          }
        }
        done.leave += 1;
      }
    }
  }, { timeout: 300000, maxWait: 30000 });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
  console.log(`APPLIED (batch ${BATCH}): ${JSON.stringify(done)}`);
  console.log(`UNDO with:  node scripts/recon-pulsehrm-apply.js --db "${target}" --undo "${manifestFile}"`);
}

// ===========================================================================
(async () => {
  if (UNDO) { await undo(); await prisma.$disconnect(); process.exit(0); }
  const dir = val('--files');
  if (!dir) { console.error('usage: --files <folder> [--db <copy.db>] [--only days,summary,leave] [--report plan.json] [--apply] | --undo <manifest>'); process.exit(2); }
  const f = {
    f1: val('--report-csv') || findFile(dir, (n) => n.endsWith('.csv') && n.includes('first')),
    f4: val('--logs-csv') || findFile(dir, (n) => n.endsWith('.csv') && (n.includes('bio') || n.includes('f4'))),
    f3: val('--summary-csv') || findFile(dir, (n) => n.endsWith('.csv') && (n.includes('summary'))),
    leave: val('--leave-xlsx') || findFile(dir, (n) => n.endsWith('.xlsx') && n.includes('leave')),
  };
  console.log('files:', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v ? path.basename(v) : null])));
  const text = (p) => ({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') });
  const csvs = [f.f1, f.f4, f.f3].filter(Boolean).map(text);
  const employees = await prisma.employee.findMany({ select: { id: true, employeeCode: true, name: true, department: true, designation: true } });
  const plan = {};
  if (ONLY.has('days')) plan.days = await planDays(csvs, employees);
  if (ONLY.has('summary')) plan.summary = await planSummary(csvs, employees);
  if (ONLY.has('leave')) plan.leave = await planLeave(f.leave, employees);
  printPlan(plan);
  if (REPORT) {
    const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'prev' || k === 'existing' ? undefined : (k === 'employee' && v ? { id: v.id, employeeCode: v.employeeCode, name: v.name } : v))));
    fs.writeFileSync(REPORT, JSON.stringify(strip(plan), null, 1));
    console.log(`\nplan written to ${REPORT}`);
  }
  if (APPLY) await applyPlan(plan);
  else console.log('\nDRY RUN - nothing was written. Add --apply (on a copy: --db <copy.db>) to write.');
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
