#!/usr/bin/env node
// ---------------------------------------------------------------------------
// LOAD THE MONTHLY CTC OF A PAY REGISTER (founder 2026-11-27) - the figures the Process Payroll "Monthly CTC" column shows
// (utils/payrollCtc.js). Reads the register's "Group A" and "Stipend" sheets (Employee ID + "Monthly CTC", the Stipend sheet's
// "Montly CTC" spelling too) and keeps them for the month in AppSetting 'payroll.registerCtc:<month>'.
// ADDITIVE ONLY: no salary structure, payroll record or payslip is touched; loading again replaces that month's figures.
//
//   node scripts/payroll-ctc-from-register.js --register "<xlsx>" --month 2026-10              dry run: says what it would keep
//   ... --apply                                                                                keeps them (audit-logged)
//   ... --undo --month 2026-10 --apply                                                         removes that month's figures
//   ... --db <file.db>                                                                         another database file (a copy)
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
const UNDO = has('--undo');

if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(MONTH || '')) || (!UNDO && (!REGISTER || !fs.existsSync(REGISTER)))) {
  console.error('Give --register "<Pay Register .xlsx>" --month YYYY-MM   (or --undo --month YYYY-MM)');
  process.exit(2);
}
if (!fs.existsSync(dbArg)) { console.error(`No database at ${dbArg}`); process.exit(2); }
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
const prisma = require('../src/db');
const CTC = require('../src/utils/payrollCtc');
const { logAudit } = require('../src/utils/audit');

const norm = (h) => String(h == null ? '' : h).replace(/\s+/g, ' ').trim().toLowerCase();

function readRegister() {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const wb = XLSX.readFile(REGISTER);
  const rows = [];
  for (const sheet of ['Group A', 'Stipend']) {
    const ws = wb.Sheets[sheet];
    if (!ws) continue; // eslint-disable-line no-continue
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    const hi = aoa.findIndex((r) => r.some((c) => /^employee (id|ref no)$/.test(norm(c))));
    if (hi < 0) continue; // eslint-disable-line no-continue
    const head = aoa[hi].map(norm);
    const cId = head.findIndex((h) => /^employee (id|ref no)$/.test(h));
    const cCtc = head.findIndex((h) => h === 'monthly ctc' || h === 'montly ctc');
    if (cCtc < 0) { console.error(`The "${sheet}" sheet has no "Monthly CTC" column. Nothing was changed.`); process.exit(2); }
    aoa.slice(hi + 1).forEach((r) => {
      const code = String(r[cId] || '').trim().toUpperCase();
      if (!/^TL\d+$/.test(code)) return;
      rows.push({ code, sheet, ctc: Number(r[cCtc]) });
    });
  }
  if (!rows.length) { console.error('No "Group A" / "Stipend" rows with an Employee ID in that file. Nothing was changed.'); process.exit(2); }
  return rows;
}

(async () => {
  const key = CTC.keyOf(MONTH);
  const before = await prisma.appSetting.findUnique({ where: { key } });
  if (UNDO) {
    console.log(before ? `Monthly CTC figures kept for ${MONTH}: ${Object.keys(JSON.parse(before.value).people || {}).length} people.` : `Nothing is kept for ${MONTH}.`);
    if (!APPLY) { console.log('Dry run: add --apply to remove them.'); return; }
    await prisma.appSetting.deleteMany({ where: { key } });
    await logAudit({ userId: null, actorName: 'Monthly CTC from the pay register', action: 'Register Monthly CTC removed', entity: 'AppSetting', entityId: key, toValue: MONTH });
    console.log('Removed.');
    return;
  }
  const rows = readRegister();
  const dup = rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i);
  if (dup.length) { console.error(`The same Employee ID twice in the register: ${[...new Set(dup)].join(', ')}. Nothing was changed.`); process.exit(2); }
  const emps = await prisma.employee.findMany({ where: { employeeCode: { in: rows.map((r) => r.code) } }, select: { id: true, employeeCode: true } });
  const idOf = new Map(emps.map((e) => [String(e.employeeCode).toUpperCase(), e.id]));
  const missing = rows.filter((r) => !idOf.has(r.code)).map((r) => r.code);
  const noFigure = rows.filter((r) => !(r.ctc > 0)).map((r) => r.code);
  const people = {};
  rows.forEach((r) => { if (idOf.has(r.code) && r.ctc > 0) people[idOf.get(r.code)] = Math.round(r.ctc * 100) / 100; });
  const records = await prisma.employeePayrollRun.findMany({ where: { month: MONTH, employeeId: { in: Object.keys(people) } }, select: { employeeId: true } });
  // what the screen shows today for those people (before this file), to say how many differ
  const shown = await CTC.monthlyCtcFor(await prisma.employeePayrollRun.findMany({ where: { month: MONTH, employeeId: { in: Object.keys(people) } }, select: { id: true, employeeId: true, month: true, importedBreakup: true, salaryVersionId: true } }));
  const runs = await prisma.employeePayrollRun.findMany({ where: { month: MONTH }, select: { id: true, employeeId: true } });
  const codeOfId = new Map(emps.map((e) => [e.id, e.employeeCode]));
  const differ = runs.filter((x) => people[x.employeeId] && (!shown.has(x.id) || Math.abs(shown.get(x.id).value - people[x.employeeId]) >= 1)).map((x) => codeOfId.get(x.employeeId));
  console.log(`Register: ${rows.length} people (Group A ${rows.filter((r) => r.sheet === 'Group A').length}, Stipend ${rows.filter((r) => r.sheet === 'Stipend').length}).`);
  console.log(`Matched to TeamLink employees: ${Object.keys(people).length}; ${records.length} of them have a ${MONTH} payroll record.`);
  if (missing.length) console.log(`Not in TeamLink (left out): ${missing.join(', ')}`);
  if (noFigure.length) console.log(`No Monthly CTC in the sheet (left out): ${noFigure.join(', ')}`);
  console.log(`${MONTH} records where the register differs from what the screen shows now: ${differ.length}${differ.length ? ` (${differ.sort().join(', ')})` : ''}`);
  if (before) console.log(`Figures were already kept for ${MONTH}; this replaces them. Previous value (to restore by hand if wanted): ${before.value.slice(0, 120)}...`);
  if (!Object.keys(people).length) { console.log('Nobody in the register matches a TeamLink employee with a Monthly CTC. Nothing was changed.'); process.exitCode = 2; return; }
  if (!APPLY) { console.log('Dry run: nothing changed. Add --apply to keep these figures.'); return; }
  const value = JSON.stringify({ file: path.basename(REGISTER), loadedOn: new Date().toISOString().slice(0, 10), people });
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  await logAudit({ userId: null, actorName: 'Monthly CTC from the pay register', action: 'Register Monthly CTC loaded', entity: 'AppSetting', entityId: key, toValue: `${MONTH}: ${Object.keys(people).length} people from ${path.basename(REGISTER)}` });
  console.log(`Kept the Monthly CTC of ${Object.keys(people).length} people for ${MONTH}. Undo: --undo --month ${MONTH} --apply`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
