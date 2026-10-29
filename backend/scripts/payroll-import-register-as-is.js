#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A MONTH'S PAYROLL = THE PAY REGISTER, AS IT IS (founder 2026-10-29, with "Pay Register for Oct 2026.xlsx":
// "oct payroll clear ga calculate chesi echaru deni em change kuda upload chey payrollos loki evvi correct claculation ne").
//
// The register is the team's final, checked calculation. Every row becomes that person's payroll record for the month with the
// register's OWN figures - nothing is recalculated - exactly the way the paid months Sep 2025 - Sep 2026 were imported
// (importNote + importedBreakup; utils/payrollMonthDetails.js shows them as the sheet says, utils/payrollEdit.js keeps them
// read-only, and utils/payrollEngine.js never recalculates them). The records stay DRAFT, so the month still goes
// Submit -> Approve -> Paid in the app.
//
//   sheets "Group A" and "Stipend": header row with Employee ID, Payable Days, Non Payable Days, Gross Salary, LOP, the earned
//   parts (Basic Pay, HR Allowance, Conveyance, Special Allowance, Performance Bonus, Monthly Bonus / Stipend), Total Earning,
//   ESI, Provident Fund, Professional Tax, TDS, Total Deduction, Net Salary (+ Round Off, Employer Share PF / ESI);
//   sheet "Attendance": Employee Ref No, Payable days per Month.
// On the record (as in the earlier imports): Basic / HRA / Conveyance / Special / Bonus = the full-month figures (the sheet's
// earned amounts x Gross Salary / Total Earning), LOP a deduction line, total deductions = LOP + the sheet's Total Deduction,
// net pay = the sheet's Net Salary to the paisa.
//
//   node scripts/payroll-import-register-as-is.js --register "<xlsx>" --month 2026-10
//        DRY RUN (default): reads the database, prints every row and the totals, changes nothing
//   ... --apply              writes (a VACUUM INTO backup of the database is taken first, into <repo>/backups)
//   ... --drop-others        with --apply: also removes this month's DRAFT records of people who are NOT in the register
//   ... --db <file.db>       another database file (a copy); default backend/prisma/dev.db
// A record already submitted / approved / paid is never touched (it is listed). Running it twice changes nothing new.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const dbArg = path.resolve(val('--db', path.join(BACK, 'prisma', 'dev.db')));
const REGISTER = val('--register');
const MONTH = val('--month');
const APPLY = has('--apply');
const DROP = has('--drop-others');
const WHO = 'Pay register import (as is)';

if (!REGISTER || !fs.existsSync(REGISTER) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(MONTH || ''))) {
  console.error('Give --register "<Pay Register .xlsx>" --month YYYY-MM');
  process.exit(2);
}
if (!fs.existsSync(dbArg)) { console.error(`No database at ${dbArg}`); process.exit(2); }
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
const XLSX = require('xlsx');
const prisma = require('../src/db');
const { versionsFor } = require('../src/utils/salaryVersions');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const z = (v) => (Number.isFinite(num(v)) ? num(v) : 0);
const fileName = path.basename(REGISTER);
const today = new Date().toISOString().slice(0, 10);
const [year, monthNum] = MONTH.split('-').map(Number);

function excelDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  return v ? String(v) : null;
}

// --- read the register ------------------------------------------------------
const wb = XLSX.readFile(REGISTER, { cellDates: true });
function tableOf(sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const hi = rows.findIndex((r) => r.some((c) => /^employee (id|ref no)$/i.test(String(c || '').trim())));
  if (hi < 0) return null;
  const head = rows[hi].map((c) => String(c || '').trim().toLowerCase());
  const col = (name) => head.indexOf(name.toLowerCase());
  const out = [];
  for (let i = hi + 1; i < rows.length; i += 1) {
    const r = rows[i];
    const get = (name) => { const k = col(name); return k >= 0 ? r[k] : null; };
    const code = String(get('Employee ID') || get('Employee Ref No') || '').trim();
    if (!/^TL\d+$/i.test(code)) continue; // eslint-disable-line no-continue
    out.push({ code: code.toUpperCase(), rowNo: i + 1, get });
  }
  return out;
}
const attendance = new Map();
(tableOf('Attendance') || []).forEach((a) => attendance.set(a.code, {
  perMonth: num(a.get('Payable days per Month')), payableDays: num(a.get('Payable Days')), nonPayableDays: num(a.get('Non Payable Days')),
  reportGroup: a.get('Report') || null,
}));

const entries = [];
for (const sheet of ['Group A', 'Stipend']) {
  const t = tableOf(sheet);
  if (!t) { console.error(`The register has no "${sheet}" sheet with an Employee ID header.`); process.exit(2); }
  for (const x of t) {
    const g = x.get;
    const stipend = sheet === 'Stipend';
    const s = {
      payableDays: num(g('Payable Days')), nonPayableDays: num(g('Non Payable Days')), grossSalary: num(g('Gross Salary')), lop: num(g('LOP')),
      ...(stipend ? { stipend: num(g('Stipend')) } : {
        basic: num(g('Basic Pay')), hra: num(g('HR Allowance')), conveyance: num(g('Conveyance')), specialAllowance: num(g('Special Allowance')),
        performanceBonus: num(g('Performance Bonus')), monthlyBonus: num(g('Monthly Bonus')),
      }),
      totalEarning: num(g('Total Earning')), esi: num(g('ESI')), pf: num(g('Provident Fund')), pt: num(g('Professional Tax')), tds: num(g('TDS')),
      totalDeduction: num(g('Total Deduction')), netSalary: num(g('Net Salary')),
      ...(stipend ? {} : { roundOff: num(g('Round Off')), employerPf: num(g('Employer Share PF')), employerEsi: num(g('Employer Share ESI')) }),
      department: g('Department'), designation: g('Designation'), location: g('Location'), taxRegime: g('Tax Regime'),
      dateOfJoining: excelDate(g('Date Of Joining')), name: g('Employee Name'),
    };
    entries.push({ code: x.code, sheet, rowNo: x.rowNo, stipend, s });
  }
}

// --- the record for one row -------------------------------------------------
function recordOf(e) {
  const s = e.s;
  const att = attendance.get(e.code);
  const present = z(s.payableDays);
  const lopDays = z(s.nonPayableDays);
  const workingDays = att && Number.isFinite(att.perMonth) ? att.perMonth : present + lopDays;
  const gross = z(s.grossSalary);
  const earned = z(s.totalEarning);
  const f = earned > 0 ? gross / earned : 0; // earned (prorated) part -> full-month part
  const full = (v) => r2(z(v) * f);
  const lop = z(s.lop);
  return {
    payMode: e.stipend ? 'Stipend' : 'Package',
    workingDays, daysPresent: present, daysLop: lopDays, attendanceSource: 'OVERRIDE',
    basic: e.stipend ? 0 : full(s.basic), hra: e.stipend ? 0 : full(s.hra), conveyance: e.stipend ? 0 : full(s.conveyance),
    specialAllowance: e.stipend ? 0 : full(s.specialAllowance), bonus: e.stipend ? 0 : r2(full(s.performanceBonus) + full(s.monthlyBonus)),
    incentive: 0, arrears: 0,
    grossPay: r2(gross), lopDeduction: r2(lop), earnedGross: r2(earned),
    pfEmployee: r2(z(s.pf)), esiEmployee: r2(z(s.esi)), professionalTax: r2(z(s.pt)), tds: r2(z(s.tds)), otherDeductions: 0,
    totalDeductions: r2(lop + z(s.totalDeduction)), netPay: r2(z(s.netSalary)),
    pfEmployer: r2(z(s.employerPf)), esiEmployer: r2(z(s.employerEsi)), gratuity: 0,
    importNote: `Imported from "${fileName}" (sheet ${e.sheet}, row ${e.rowNo}) on ${today} - the register's own figures, not recalculated`,
    importedBreakup: JSON.stringify({
      source: { file: fileName, sheet: e.sheet, row: e.rowNo, importedOn: today, asIs: true },
      sheet: s,
      attendance: att ? { payableDays: att.payableDays, nonPayableDays: att.nonPayableDays, payableDaysPerMonth: att.perMonth, reportGroup: att.reportGroup } : null,
      flags: [],
      note: 'Sheet earning columns are the earned (prorated) amounts. On the record, Basic/HRA/Conveyance/Special/Bonus are the full-month figures and LOP is a deduction line, so the payslip adds up to the same net. Imported as it is: the register is the final calculation.',
    }),
    calculatedBy: WHO, calculatedAt: new Date(),
  };
}

(async () => {
  const codes = entries.map((e) => e.code);
  const dup = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dup.length) { console.error(`The same Employee ID twice in the register: ${[...new Set(dup)].join(', ')}`); process.exit(2); }
  const emps = await prisma.employee.findMany({ where: { employeeCode: { in: codes } }, select: { id: true, employeeCode: true, name: true } });
  const empOf = new Map(emps.map((x) => [String(x.employeeCode).toUpperCase(), x]));
  const missing = codes.filter((c) => !empOf.has(c));
  if (missing.length) { console.error(`Not in TeamLink (no employee with this code): ${missing.join(', ')}. Nothing was changed.`); process.exit(2); }
  const ids = emps.map((x) => x.id);
  const existing = await prisma.employeePayrollRun.findMany({ where: { month: MONTH }, include: { employee: { select: { employeeCode: true, name: true } } } });
  const priorOf = new Map(existing.map((x) => [x.employeeId, x]));
  const versions = await versionsFor(ids, MONTH).catch(() => new Map());

  const plan = [];
  const locked = [];
  for (const e of entries) {
    const emp = empOf.get(e.code);
    const prior = priorOf.get(emp.id);
    if (prior && prior.status !== 'DRAFT') { locked.push(`${e.code} ${emp.name}: already ${prior.status}, left as it is`); continue; } // eslint-disable-line no-continue
    const v = versions.get ? versions.get(emp.id) : null;
    plan.push({ e, emp, prior, rec: { ...recordOf(e), salaryVersionId: v ? v.id : null } });
  }
  const inRegister = new Set(ids);
  const others = existing.filter((x) => !inRegister.has(x.employeeId));

  // --- show it ---
  const pad = (v, n) => String(v).padEnd(n).slice(0, n);
  const amt = (n) => r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN (nothing is changed)'}: ${fileName} -> payroll ${MONTH}  (database ${path.basename(dbArg)})\n`);
  console.log(`${pad('Code', 7)}${pad('Name', 30)}${pad('Sheet', 9)}${pad('Days', 11)}${pad('Gross', 12)}${pad('LOP', 10)}${pad('Deductions', 12)}${pad('Net', 12)}Now`);
  const totals = {};
  for (const p of plan) {
    const r = p.rec;
    totals[p.e.sheet] = totals[p.e.sheet] || { n: 0, gross: 0, net: 0 };
    totals[p.e.sheet].n += 1; totals[p.e.sheet].gross += r.earnedGross; totals[p.e.sheet].net += r.netPay;
    const now = p.prior ? `replaces the draft (net ${amt(p.prior.netPay)})` : 'new';
    console.log(`${pad(p.e.code, 7)}${pad(p.emp.name, 30)}${pad(p.e.sheet, 9)}${pad(`${r.daysPresent}/${r.workingDays}`, 11)}${pad(amt(r.grossPay), 12)}${pad(amt(r.lopDeduction), 10)}${pad(amt(r.totalDeductions - r.lopDeduction), 12)}${pad(amt(r.netPay), 12)}${now}`);
  }
  console.log('');
  let all = 0;
  Object.entries(totals).forEach(([k, t]) => { all += t.net; console.log(`${k}: ${t.n} people, earned ${amt(t.gross)}, NET ${amt(t.net)}`); });
  console.log(`TOTAL NET: ${amt(all)}`);
  if (locked.length) console.log(`\nNot touched (already past Draft):\n  ${locked.join('\n  ')}`);
  if (others.length) {
    console.log(`\n${MONTH} records of people NOT in the register:`);
    others.forEach((x) => console.log(`  ${x.employee.employeeCode} ${x.employee.name}: ${x.status}, net ${amt(x.netPay)}${x.status === 'DRAFT' ? (DROP ? (APPLY ? ' - removed' : ' - would be removed (--drop-others)') : ' - kept (add --drop-others to remove)') : ' - kept (past Draft)'}`));
  }
  if (!APPLY) { console.log('\nNothing changed. Add --apply to write it.'); await prisma.$disconnect(); return; }

  // --- write ---
  // the backup goes to <repo>/backups, never next to dev.db (a deploy packages backend/ and would carry it along)
  const bdir = path.join(BACK, '..', 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  const backup = path.join(bdir, `dev-before-payroll-import-${MONTH}-${Date.now()}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${backup.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  console.log(`\nBackup of the database: ${backup}`);
  let run = await prisma.payrollRun.findUnique({ where: { month: MONTH } });
  if (!run) {
    const { monthLabel } = require('../src/utils/attendanceMath'); // eslint-disable-line global-require
    run = await prisma.payrollRun.create({ data: { month: MONTH, period: monthLabel(MONTH), status: 'Draft', processedBy: WHO } });
  }
  let created = 0; let replaced = 0;
  for (const p of plan) {
    const data = { ...p.rec, payrollRunId: run.id, year, monthNum };
    if (p.prior) {
      // a fresh record (new id): the old draft's edit history / state cannot hang on to it
      // eslint-disable-next-line no-await-in-loop
      await prisma.$transaction([
        prisma.employeePayrollRun.deleteMany({ where: { id: p.prior.id, status: 'DRAFT' } }),
        prisma.appSetting.deleteMany({ where: { key: `payroll.edit:${p.prior.id}` } }),
        prisma.employeePayrollRun.create({ data: { employeeId: p.emp.id, month: MONTH, status: 'DRAFT', ...data } }),
      ]);
      replaced += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.employeePayrollRun.create({ data: { employeeId: p.emp.id, month: MONTH, status: 'DRAFT', ...data } });
      created += 1;
    }
  }
  let dropped = 0;
  if (DROP) {
    const drop = others.filter((x) => x.status === 'DRAFT').map((x) => x.id);
    if (drop.length) {
      dropped = (await prisma.employeePayrollRun.deleteMany({ where: { id: { in: drop }, status: 'DRAFT' } })).count;
      await prisma.appSetting.deleteMany({ where: { key: { in: drop.map((id) => `payroll.edit:${id}`) } } });
    }
  }
  try {
    const { logAudit } = require('../src/utils/audit'); // eslint-disable-line global-require
    await logAudit({ userId: null, actorName: WHO, action: `Payroll ${MONTH} imported from "${fileName}" as it is`, entity: 'PayrollRun', entityId: run.id, toValue: `${created} new, ${replaced} replaced, ${dropped} removed; total net ${amt(all)}` });
  } catch { /* the import itself is done */ }
  console.log(`\nDONE: ${created} new, ${replaced} drafts replaced, ${dropped} other drafts removed. Total net ${amt(all)}.`);
  await prisma.$disconnect();
})().catch(async (err) => { console.error(`STOPPED: ${err.message}`); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
