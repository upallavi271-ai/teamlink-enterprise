#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PAYROLL FROM THE PAY REGISTER (founder 2026-10-28): makes the app's own payroll for a month EXACTLY the salary
// register the team makes in Excel, from
//   --register    the Pay Register .xlsx (the September 2026 shape - earned amounts - or the shape with the yellow
//                 "Full: Basic / HRA / Conveyance / Special / Performance Bonus / Monthly Bonus", "PF rule",
//                 "PF fixed amount", "TDS" columns, e.g. "Pay Register for Oct 2026.xlsx")
//   --attendance  the month's attendance sheet ("To pavan sharing sheet Sep16-Oct15_update.xlsx": tabs Attendance,
//                 Compansation (joiners), DOE (exits))
//   --month       the payroll month, YYYY-MM (2026-10 = the cycle 16 Sep - 15 Oct)
//
// It writes (only with --apply):
//   1. AppSetting 'payroll.registerRules' = { from: <month> } (utils/payrollRegister.js): the pay-register rules from
//      this month on (paise, earned parts, PF rule, ESI rounded up, PT slab on the earned total). Earlier months untouched.
//   2. one salary-structure VERSION per person effective <month>-01: Group A = the register's full-month amounts as they
//      are + the PF rule + TDS; a new joiner without a package gets the package of the colleague on the same CTC
//      (the Compansation tab); Stipend = Rs 10,000 (or the register's / Compansation's figure).
//   3. PayrollAttendance for the month: payroll days = "Payable days per month", present = "Payable Days",
//      LOP = the rest (so a person who left in the cycle is paid for the days in the sheet).
//   4. recalculates the month for these people (utils/payrollEngine.js calculateMonth): the stale DRAFT records are
//      replaced; a record already submitted / approved / posted / paid is NEVER touched (the run refuses).
//   5. checks every record against the register's own arithmetic (to the paisa) and prints the table.
//
//   node scripts/payroll-from-register.js --register "<xlsx>" --attendance "<xlsx>" --month 2026-10
//        DRY RUN (default): makes a throw-away COPY of the database, applies everything to the COPY, prints the app's
//        numbers vs the register's and deletes the copy. The real database is only read.
//   ... --db <copy.db> --apply                         apply to a copy you made
//   TL_ALLOW_REAL_APPLY=1 node scripts/payroll-from-register.js ... --apply --really-real   the REAL database
//        (a VACUUM INTO backup is taken first; the run is recorded in the audit log)
//   --drop-others    also delete this month's DRAFT records of people who are NOT in the attendance sheet
//   --reset-edited   a DRAFT record somebody edited by hand is recalculated too (normally the script stops)
// Running it twice changes nothing new.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const ON_COPY = has('--on-copy'); // set by the dry run for its own child process
const REGISTER = val('--register');
const ATTENDANCE = val('--attendance');
const MONTH = val('--month');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `payroll-from-register-${STAMP}`)));
const WHO = 'Pay register import';

if (!REGISTER || !ATTENDANCE || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(MONTH || ''))) {
  console.error('Give --register "<Pay Register .xlsx>" --attendance "<attendance sheet .xlsx>" --month YYYY-MM');
  process.exit(2);
}
[REGISTER, ATTENDANCE].forEach((f) => { if (!fs.existsSync(f)) { console.error(`Not found: ${f}`); process.exit(2); } });
if (!fs.existsSync(dbArg)) { console.error(`No database at ${dbArg}`); process.exit(2); }
if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: --apply on the REAL database needs --really-real AND TL_ALLOW_REAL_APPLY=1. Run the dry run first, or --db <copy>.');
  process.exit(2);
}
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
const XLSX = require('xlsx');

// ---- the register's arithmetic (independent of the app; the check) -----------------------------
const r2 = (n) => { const x = Number(n) || 0; const s = x < 0 ? -1 : 1; return (s * Math.round(Math.abs(x) * 100 + 1e-6)) / 100; };
const pyRound2 = (x) => Number((Math.round(Number(x) * 100 + (Number(x) >= 0 ? 1e-7 : -1e-7)) / 100).toFixed(2));
const KEYS = ['basic', 'hra', 'conveyance', 'specialAllowance', 'perfBonus', 'monthlyBonus'];
function expectedOf(p, payable, days) {
  if (p.mode === 'Stipend') {
    const te = r2((p.stipend * payable) / days);
    return { gross: p.stipend, earned: te, esi: 0, pf: 0, pt: 0, tds: 0, net: te };
  }
  const gross = r2(KEYS.reduce((n, k) => n + p.full[k], 0));
  const parts = {}; KEYS.forEach((k) => { parts[k] = r2((p.full[k] * payable) / days); });
  const te = r2(KEYS.reduce((n, k) => n + parts[k], 0));
  const esi = gross <= 21000 && te > 0 ? Math.ceil(Number((te * 0.0075).toFixed(6))) : 0;
  let pf = 0;
  if (te > 0) pf = p.rule.mode === 'PCT' ? r2((parts.basic * p.rule.pct) / 100) : r2(p.rule.amount);
  const pt = te > 20000 ? 200 : (te > 15000 ? 150 : 0);
  const tds = r2(p.tds || 0);
  return { gross, earned: te, esi, pf, pt, tds, net: r2(te - esi - pf - pt - tds) };
}

// ---- read the files --------------------------------------------------------------------------------
const norm = (h) => String(h == null ? '' : h).replace(/\s+/g, ' ').trim().toLowerCase();
const str = (v) => String(v == null ? '' : v).trim();
const isId = (v) => /^TL\d+$/i.test(str(v));
const numOr = (v, d = 0) => (str(v) !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
function table(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
  const hi = aoa.findIndex((r) => r.some((c) => norm(c) === 'employee id' || norm(c) === 'employee ref no' || norm(c) === 'employee'));
  if (hi < 0) return [];
  const head = aoa[hi].map(norm);
  return aoa.slice(hi + 1).map((r, i) => { const o = { _row: hi + i + 2 }; head.forEach((h, j) => { if (h) o[h] = r[j]; }); return o; });
}
function readAttendanceSheet(file) {
  const wb = XLSX.readFile(file);
  const att = wb.Sheets.Attendance || wb.Sheets[wb.SheetNames[0]];
  const rows = table(att).filter((r) => isId(r['employee ref no'])).map((r) => ({
    eid: str(r['employee ref no']).toUpperCase(), name: str(r['employee name']), report: str(r.report),
    days: numOr(r['payable days per month'], null), payable: numOr(r['payable days'], 0), nonPayable: numOr(r['non payable days'], null), remark: str(r.remarks),
  }));
  const comp = new Map();
  if (wb.Sheets.Compansation || wb.Sheets.Compensation) {
    table(wb.Sheets.Compansation || wb.Sheets.Compensation).filter((r) => isId(r.employee)).forEach((r) => comp.set(str(r.employee).toUpperCase(), {
      join: str(r['joining date/hike']), oldCtc: numOr(r['old ctc'], null), newCtc: numOr(r['new ctc'], null),
    }));
  }
  const doe = new Map();
  if (wb.Sheets.DOE) table(wb.Sheets.DOE).filter((r) => isId(r.employee)).forEach((r) => doe.set(str(r.employee).toUpperCase(), r['existing date']));
  return { rows, comp, doe };
}
function readRegister(file) {
  const wb = XLSX.readFile(file);
  const settings = new Map();
  if (wb.Sheets.Settings) {
    XLSX.utils.sheet_to_json(wb.Sheets.Settings, { header: 1, defval: '', raw: true }).forEach((r) => { const k = r.findIndex((c) => str(c)); if (k >= 0) settings.set(norm(r[k]), r[k + 1]); });
  }
  const stipendDefault = numOr(settings.get('stipend (full month)'), 10000) || 10000;
  const pk = table(wb.Sheets.Package).filter((r) => isId(r['employee id']));
  const fullShape = pk.length && Object.prototype.hasOwnProperty.call(pk[0], 'full: basic');
  const pkg = new Map();
  let prevDays = null;
  const prevPay = new Map();
  if (!fullShape) {
    // the older register (September 2026): the EARNED amounts; taken back to the full month with its own attendance
    table(wb.Sheets.Attendance).filter((r) => isId(r['employee ref no'])).forEach((r) => {
      prevPay.set(str(r['employee ref no']).toUpperCase(), numOr(r['payable days'], null));
      if (prevDays === null && numOr(r['payable days per month'], null)) prevDays = numOr(r['payable days per month'], null);
    });
    if (!prevDays) throw new Error('The register has no "Payable days per month" on its Attendance tab (needed to take the September amounts back to the full month).');
  }
  pk.forEach((r) => {
    const eid = str(r['employee id']).toUpperCase();
    let full; let rule; let source;
    if (fullShape) {
      full = {
        basic: numOr(r['full: basic']), hra: numOr(r['full: hra']), conveyance: numOr(r['full: conveyance']), specialAllowance: numOr(r['full: special']),
        perfBonus: numOr(r['full: performance bonus']), monthlyBonus: numOr(r['full: monthly bonus']),
      };
      const t = str(r['pf rule']);
      const m = t.match(/^(\d+(?:\.\d+)?)\s*%/);
      if (m) rule = { mode: 'PCT', pct: Number(m[1]) };
      else if (/^fixed/i.test(t)) rule = { mode: 'FIXED', amount: r2(numOr(r['pf fixed amount'])) };
      else throw new Error(`${eid}: PF rule "${t}" is not 24% / 12% of earned basic or Fixed.`);
      source = str(r['package source']) || 'register';
    } else {
      const pay = prevPay.has(eid) && prevPay.get(eid) ? prevPay.get(eid) : prevDays;
      const f = prevDays / pay;
      const earned = {
        basic: numOr(r['basic pay']), hra: numOr(r['hr allowance']), conveyance: numOr(r.conveyance), specialAllowance: numOr(r['special allowance']),
        perfBonus: numOr(r['performance bonus']), monthlyBonus: numOr(r['monthly bonus']),
      };
      full = {}; KEYS.forEach((k) => { full[k] = pyRound2(earned[k] * f); });
      const pf = numOr(r['provident fund']);
      const ratio = earned.basic ? pf / earned.basic : 0;
      if (Math.abs(ratio - 0.24) < 0.002) rule = { mode: 'PCT', pct: 24 };
      else if (Math.abs(ratio - 0.12) < 0.002) rule = { mode: 'PCT', pct: 12 };
      else rule = { mode: 'FIXED', amount: r2(pf) };
      source = 'register (September amounts taken back to the full month)';
    }
    pkg.set(eid, { eid, mode: 'Package', name: str(r['employee name']), ctc: numOr(r['ctc montly']), full, rule, tds: numOr(r.tds), source });
  });
  const stip = new Map();
  if (wb.Sheets.Stipend) {
    table(wb.Sheets.Stipend).filter((r) => isId(r['employee id'])).forEach((r) => {
      const g = numOr(r['gross salary'], null);
      stip.set(str(r['employee id']).toUpperCase(), { eid: str(r['employee id']).toUpperCase(), mode: 'Stipend', name: str(r['employee name']), stipend: g && g > 0 ? g : stipendDefault });
    });
  }
  return { pkg, stip, stipendDefault, shape: fullShape ? 'Full: columns' : 'September (earned amounts)' };
}

// Who is paid this month and on what: everybody in the attendance sheet, nobody else (the register's rule).
function buildPlan(reg, att) {
  const people = []; const notes = []; const problems = [];
  const pkgList = [...reg.pkg.values()];
  att.rows.forEach((a) => {
    const c = att.comp.get(a.eid);
    if (/stipend/i.test(a.report)) {
      const base = reg.stip.get(a.eid);
      const amount = c ? (c.newCtc || c.oldCtc || reg.stipendDefault) : (base ? base.stipend : reg.stipendDefault);
      if (!base) notes.push(`${a.eid} ${a.name}: stipend joiner, stipend Rs ${amount} (Compansation tab).`);
      people.push({ ...a, plan: { mode: 'Stipend', stipend: amount, source: base ? 'register' : 'Compansation tab' } });
      return;
    }
    let p = reg.pkg.get(a.eid);
    if (!p) {
      const ctc = c ? (c.newCtc || c.oldCtc || 0) : 0;
      const tmpl = pkgList.find((x) => Math.abs(x.ctc - ctc) < 1);
      if (!tmpl) { problems.push(`${a.eid} ${a.name}: no package in the register and no colleague on CTC ${ctc} - add the package to the register.`); return; }
      p = { ...tmpl, eid: a.eid, name: a.name, tds: 0, source: `same package as ${tmpl.eid} (CTC ${ctc})` };
      notes.push(`${a.eid} ${a.name}: new joiner on CTC ${ctc}; package copied from ${tmpl.eid} ${tmpl.name}.`);
    }
    people.push({ ...a, plan: p });
  });
  return { people, notes, problems };
}

const fmt = (n) => (n === null || n === undefined ? '' : Number(n).toFixed(2));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

async function main() {
  const reg = readRegister(REGISTER);
  const att = readAttendanceSheet(ATTENDANCE);
  const { people, notes, problems } = buildPlan(reg, att);
  console.log(`Register: ${path.basename(REGISTER)} (${reg.shape}): ${reg.pkg.size} packages, ${reg.stip.size} stipends.`);
  console.log(`Attendance: ${path.basename(ATTENDANCE)}: ${att.rows.length} people (${people.filter((p) => p.plan.mode !== 'Stipend').length} Group A, ${people.filter((p) => p.plan.mode === 'Stipend').length} stipend).`);
  notes.forEach((n) => console.log(`  note: ${n}`));
  if (problems.length) { problems.forEach((p) => console.log(`  PROBLEM: ${p}`)); process.exit(1); }

  // ---- DRY RUN: everything on a throw-away copy, then the copy is deleted ----
  if (!APPLY) {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const copy = path.join(os.tmpdir(), `payroll-from-register-dry-${Date.now().toString(36)}.db`);
    await prisma.$executeRawUnsafe(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
    await prisma.$disconnect();
    console.log(`\nDRY RUN: applying to a throw-away copy of the database (${copy}); the real one is only read.\n`);
    const passOn = argv.filter((a, i) => !['--db', '--out'].includes(a) && !['--db', '--out'].includes(argv[i - 1]));
    const r = spawnSync(process.execPath, [__filename, ...passOn, '--db', copy, '--apply', '--on-copy', '--out', path.join(OUT, 'dry-run')], { stdio: 'inherit', env: { ...process.env, TL_ALLOW_REAL_APPLY: '' } });
    ['', '-wal', '-shm', '-journal'].forEach((x) => { try { fs.unlinkSync(copy + x); } catch { /* gone */ } });
    console.log(r.status === 0
      ? '\nDRY RUN finished - the copy was deleted, nothing changed. If the numbers are right, run it again with --apply (see the header).'
      : '\nDRY RUN found a problem (see above) - nothing changed.');
    process.exit(r.status || 0);
  }

  // ---- APPLY ----
  fs.mkdirSync(OUT, { recursive: true });
  const prisma = require('../src/db');
  const E = require('../src/utils/payrollEngine');
  const SV = require('../src/utils/salaryVersions');
  const PC = require('../src/utils/payrollCycle');
  const REG = require('../src/utils/payrollRegister');
  const PEdit = require('../src/utils/payrollEdit');
  const { monthLabel } = require('../src/utils/attendanceMath');

  const settings = await PC.getSettings({ fresh: true });
  const cycle = PC.cycleOf(MONTH, settings.cycle);
  const policy = await E.getPolicy();
  const cycleDays = E.payrollWorkingDays(MONTH, policy, cycle);
  const sheetDays = [...new Set(people.map((p) => p.days).filter((d) => d !== null))];
  if (sheetDays.length > 1 || (sheetDays.length && sheetDays[0] !== cycleDays)) {
    console.error(`STOP: the sheet's "Payable days per month" (${sheetDays.join(', ')}) is not the ${monthLabel(MONTH)} payroll's ${cycleDays} days (${cycle.rangeText}). Check the month / the payroll cycle setting.`);
    process.exit(1);
  }
  console.log(`${monthLabel(MONTH)}: pay period ${cycle.rangeText} = ${cycleDays} days.`);

  // people in the database
  const emps = await prisma.employee.findMany({ where: { employeeCode: { in: people.map((p) => p.eid) } } });
  const byCode = new Map(emps.map((e) => [String(e.employeeCode).toUpperCase(), e]));
  const missing = people.filter((p) => !byCode.has(p.eid));
  if (missing.length) { console.error(`STOP: not in the database: ${missing.map((p) => `${p.eid} ${p.name}`).join(', ')}`); process.exit(1); }
  const ids = people.map((p) => byCode.get(p.eid).id);

  // nothing beyond DRAFT may be touched
  const locked = await prisma.employeePayrollRun.findMany({ where: { employeeId: { in: ids }, month: { gte: MONTH }, status: { not: 'DRAFT' } }, include: { employee: { select: { employeeCode: true, name: true } } } });
  if (locked.length) {
    console.error(`STOP: already beyond Draft (never changed by this script): ${locked.map((l) => `${l.employee.employeeCode} ${l.month} ${l.status}`).join(', ')}`);
    process.exit(1);
  }
  const drafts = await prisma.employeePayrollRun.findMany({ where: { month: MONTH }, include: { employee: { select: { employeeCode: true, name: true } } } });
  const editedSet = await PEdit.editedIds(drafts.map((d) => d.id));
  const editedMine = drafts.filter((d) => ids.includes(d.employeeId) && editedSet.has(d.id));
  if (editedMine.length && !has('--reset-edited')) {
    console.error(`STOP: these ${monthLabel(MONTH)} drafts were edited by hand: ${editedMine.map((d) => `${d.employee.employeeCode} ${d.employee.name}`).join(', ')}. Run with --reset-edited to recalculate them from the register too.`);
    process.exit(1);
  }
  const others = drafts.filter((d) => !ids.includes(d.employeeId));

  // backup of the real database first
  if (isReal) {
    const bak = path.join(path.join(os.homedir(), '.teamlink-backups'), `payroll-from-register-${MONTH}-${STAMP}.db`);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    console.log(`Backup of the database before this run: ${bak}`);
  }

  const eff = `${MONTH}-01`;
  const counts = { versionsCreated: 0, versionsUpdated: 0, versionsSame: 0, rulesSet: 0, attendanceWritten: 0, attendanceSame: 0, editedReset: 0, othersDropped: 0 };
  const EPS = 0.001;
  const same = (a, b) => (a === null || a === undefined || b === null || b === undefined ? a === b : (typeof a === 'number' || typeof b === 'number' ? Math.abs(Number(a) - Number(b)) < EPS : a === b));
  const FIELDS = ['payMode', 'ctc', 'stipend', 'basic', 'hra', 'conveyance', 'specialAllowance', 'bonus', 'employerPf', 'employeePf', 'professionalTax', 'gratuity',
    'esiApplicable', 'esiEmployee', 'esiEmployer', 'tds', 'otherDeductions'];

  // 1. the switch
  const from = await REG.registerFrom();
  if (!from || from > MONTH) { await REG.setRegisterFrom(MONTH, WHO); console.log(`Pay-register rules switched on from ${monthLabel(MONTH)}.`); }

  for (const p of people) {
    const emp = byCode.get(p.eid);
    const pl = p.plan;
    // 2. the structure version
    let data; let rule = null;
    if (pl.mode === 'Stipend') {
      data = {
        payMode: 'Stipend', ctc: 0, stipend: r2(pl.stipend), basic: 0, hra: 0, conveyance: 0, specialAllowance: 0, bonus: 0,
        employerPf: 0, employeePf: 0, professionalTax: 0, gratuity: 0, esiApplicable: false, esiEmployee: 0, esiEmployer: 0, tds: null, otherDeductions: 0,
      };
    } else {
      rule = pl.rule;
      data = REG.directStructure({
        full: { basic: pl.full.basic, hra: pl.full.hra, conveyance: pl.full.conveyance, specialAllowance: pl.full.specialAllowance, bonus: r2(pl.full.perfBonus + pl.full.monthlyBonus) },
        rule, monthlyCtc: pl.ctc, cfg: policy, esiApplicable: null, tds: pl.tds || 0, otherDeductions: 0,
      });
    }
    const note = `Pay register ${monthLabel(MONTH)} (${path.basename(REGISTER)}; ${pl.source})`.slice(0, 300);
    const existing = await prisma.salaryStructureVersion.findUnique({ where: { employeeId_effectiveFrom: { employeeId: emp.id, effectiveFrom: eff } } });
    let version = existing;
    const oldRule = existing ? await REG.pfRuleOf(existing.id) : null;
    const sameRule = JSON.stringify(REG.cleanRule(oldRule)) === JSON.stringify(REG.cleanRule(rule));
    if (existing && FIELDS.every((k) => same(existing[k], data[k])) && sameRule) counts.versionsSame += 1;
    else {
      version = existing
        ? await prisma.salaryStructureVersion.update({ where: { id: existing.id }, data: { ...data, note } })
        : await prisma.salaryStructureVersion.create({ data: { employeeId: emp.id, effectiveFrom: eff, createdBy: WHO, note, ...data } });
      if (existing) counts.versionsUpdated += 1; else counts.versionsCreated += 1;
      if (!sameRule || !existing) { await REG.setPfRule(version.id, rule); if (rule) counts.rulesSet += 1; }
      await SV.relink(emp.id);
      await prisma.auditLog.create({
        data: {
          actorName: WHO, action: existing ? 'Salary structure version updated from the pay register' : 'Salary structure version created from the pay register',
          entity: 'SalaryStructure', entityId: version.id, reason: `${emp.employeeCode} ${emp.name}`,
          toValue: `effective ${MONTH} · ${data.payMode === 'Stipend' ? `stipend ${data.stipend}` : `gross ${r2(data.basic + data.hra + data.conveyance + data.specialAllowance + data.bonus)} · PF ${rule.mode === 'FIXED' ? `fixed ${rule.amount}` : `${rule.pct}% of earned basic`} · TDS ${data.tds || 0}`}`,
        },
      });
    }
    // 3. the month's payroll days
    const days = p.days !== null ? p.days : cycleDays;
    const present = Math.max(0, Math.min(days, p.payable));
    const lop = Math.max(0, r2(days - present));
    const reason = `Attendance sheet "${path.basename(ATTENDANCE)}"${p.remark ? `: ${p.remark}` : ''}`.slice(0, 500);
    const prev = await prisma.payrollAttendance.findUnique({ where: { employeeId_month: { employeeId: emp.id, month: MONTH } } });
    if (prev && same(prev.workingDays, days) && same(prev.daysPresent, present) && same(prev.daysLop, lop)) counts.attendanceSame += 1;
    else {
      const { year, monthNum } = E.monthParts(MONTH);
      const row = await prisma.payrollAttendance.upsert({
        where: { employeeId_month: { employeeId: emp.id, month: MONTH } },
        update: { workingDays: days, daysPresent: present, daysLop: lop, reason, overriddenByName: WHO, overriddenAt: new Date() },
        create: { employeeId: emp.id, month: MONTH, year, monthNum, workingDays: days, daysPresent: present, daysLop: lop, reason, overriddenByName: WHO, overriddenAt: new Date() },
      });
      await prisma.auditLog.create({
        data: {
          actorName: WHO, action: 'Payroll attendance overridden (pay register)', entity: 'PayrollAttendance', entityId: row.id, field: 'attendance',
          fieldLabel: `${emp.name} · ${monthLabel(MONTH)}`, fromValue: prev ? `present ${prev.daysPresent}, LOP ${prev.daysLop} of ${prev.workingDays}` : null,
          toValue: `present ${present}, LOP ${lop} of ${days}`, reason,
        },
      });
      counts.attendanceWritten += 1;
    }
  }
  // edited drafts: back to the engine (only with --reset-edited)
  for (const d of editedMine) {
    await prisma.appSetting.deleteMany({ where: { key: `payroll.edit:${d.id}` } });
    await prisma.auditLog.create({ data: { actorName: WHO, action: 'Payroll edit reset for the pay register', entity: 'EmployeePayrollRun', entityId: d.id, reason: `${d.employee.employeeCode} ${d.employee.name}` } });
    counts.editedReset += 1;
  }
  if (others.length) {
    if (has('--drop-others')) {
      const unedited = others.filter((d) => d.status === 'DRAFT' && !editedSet.has(d.id));
      for (const d of unedited) {
        await prisma.employeePayrollRun.deleteMany({ where: { id: d.id, status: 'DRAFT' } });
        await prisma.auditLog.create({ data: { actorName: WHO, action: 'Payroll draft removed (not in the attendance sheet)', entity: 'EmployeePayrollRun', entityId: d.id, reason: `${d.employee.employeeCode} ${d.employee.name} · ${MONTH}` } });
        counts.othersDropped += 1;
      }
    } else console.log(`  note: ${others.length} ${monthLabel(MONTH)} record(s) of people NOT in the sheet stay as they are: ${others.map((d) => `${d.employee.employeeCode} ${d.employee.name} (${d.status})`).join(', ')} (--drop-others removes the drafts).`);
  }

  // 4. recalculate the month for these people
  const calc = await E.calculateMonth({ month: MONTH, employeeIds: ids, actor: { id: null, name: WHO } });
  console.log(`Calculated: ${calc.created} created, ${calc.updated} recalculated, ${calc.locked.length} locked, ${calc.edited.length} edited (kept), ${calc.skipped.length} skipped.`);
  calc.skipped.forEach((s) => console.log(`  skipped ${s.employeeCode} ${s.name}: ${s.reason}`));
  if (counts.othersDropped) await E.refreshMonthRun(MONTH, WHO);

  // 5. the check: the app's records vs the register's arithmetic
  const entries = await prisma.employeePayrollRun.findMany({ where: { month: MONTH, employeeId: { in: ids } } });
  const entryOf = new Map(entries.map((e) => [e.employeeId, e]));
  const rows = []; let bad = 0;
  const tot = { A: { app: 0, exp: 0, n: 0 }, S: { app: 0, exp: 0, n: 0 } };
  console.log(`\n${pad('Group', 8)}${pad('ID', 7)}${lpad('Paid', 6)}${lpad('Gross', 11)}${lpad('Earned', 11)}${lpad('ESI', 6)}${lpad('PF', 9)}${lpad('PT', 5)}${lpad('TDS', 5)}${lpad('Net (app)', 12)}${lpad('Net (register)', 16)}  diff`);
  for (const p of people) {
    const emp = byCode.get(p.eid);
    const e = entryOf.get(emp.id);
    const days = p.days !== null ? p.days : cycleDays;
    const x = expectedOf(p.plan, p.payable, days);
    const g = p.plan.mode === 'Stipend' ? 'S' : 'A';
    const app = e ? {
      gross: r2(e.grossPay), earned: r2(e.earnedGross), esi: r2(e.esiEmployee), pf: r2(e.pfEmployee), pt: r2(e.professionalTax), tds: r2(e.tds), net: r2(e.netPay),
    } : null;
    const diffs = app ? ['gross', 'earned', 'esi', 'pf', 'pt', 'tds', 'net'].filter((k) => Math.abs(app[k] - x[k]) > 0.0049) : ['no record'];
    if (diffs.length) bad += 1;
    tot[g].app = r2(tot[g].app + (app ? app.net : 0)); tot[g].exp = r2(tot[g].exp + x.net); tot[g].n += 1;
    rows.push({ group: g === 'A' ? 'Group A' : 'Stipend', eid: p.eid, payable: p.payable, app, expected: x, diffs });
    console.log(`${pad(g === 'A' ? 'Group A' : 'Stipend', 8)}${pad(p.eid, 7)}${lpad(p.payable, 6)}${lpad(fmt(app && app.gross), 11)}${lpad(fmt(app && app.earned), 11)}${lpad(app ? app.esi : '', 6)}${lpad(fmt(app && app.pf), 9)}${lpad(app ? app.pt : '', 5)}${lpad(app ? app.tds : '', 5)}${lpad(fmt(app && app.net), 12)}${lpad(fmt(x.net), 16)}  ${diffs.length ? `DIFFERENT: ${diffs.join(', ')}` : '0.00'}`);
  }
  const grandApp = r2(tot.A.app + tot.S.app); const grandExp = r2(tot.A.exp + tot.S.exp);
  console.log(`\nGroup A (${tot.A.n}) net: app ${fmt(tot.A.app)} | register ${fmt(tot.A.exp)}`);
  console.log(`Stipend (${tot.S.n}) net: app ${fmt(tot.S.app)} | register ${fmt(tot.S.exp)}`);
  console.log(`TOTAL net: app ${fmt(grandApp)} | register ${fmt(grandExp)}`);
  const run = await prisma.payrollRun.findUnique({ where: { month: MONTH } });
  console.log(`${monthLabel(MONTH)} payroll run: ${run ? `${run.status}, ${run.employees} records, net ${fmt(run.totalNet)}` : 'none'}`);
  console.log(`Writes: ${JSON.stringify(counts)}`);
  await prisma.auditLog.create({
    data: {
      actorName: WHO, action: `Payroll ${monthLabel(MONTH)} made from the pay register`, entity: 'PayrollRun', entityId: run ? run.id : null,
      fromValue: `${path.basename(REGISTER)} + ${path.basename(ATTENDANCE)}`,
      toValue: `${people.length} people; Group A net ${fmt(tot.A.app)}, stipend net ${fmt(tot.S.app)}, total ${fmt(grandApp)}; ${bad ? `${bad} DIFFERENT from the register` : 'equal to the register to the paisa'}`,
      reason: JSON.stringify(counts).slice(0, 500),
    },
  });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ month: MONTH, register: REGISTER, attendance: ATTENDANCE, db: ON_COPY ? 'dry-run copy' : dbArg, counts, totals: { groupA: tot.A, stipend: tot.S, grandApp, grandExp }, rows, notes }, null, 1));
  console.log(`Report: ${path.join(OUT, 'report.json')}`);
  if (bad) { console.log(`\n${bad} record(s) DIFFERENT from the register - see above.`); process.exitCode = 1; } else console.log('\nEvery record equals the register to the paisa.');
  await prisma.$disconnect();
}

main().catch((err) => { console.error('FAILED:', err && err.stack ? err.stack : err); process.exit(1); });
