#!/usr/bin/env node
// ---------------------------------------------------------------------------
// MONTHLY CTC COLUMN TEST (2026-11-27) - SANDBOX ONLY.
//   node scripts/payroll-ctc-test.js          (needs the sandbox API: TL_API, default http://localhost:4011, and prisma/sandbox.db)
//
// The Process Payroll "Monthly CTC" column (utils/payrollCtc.js) and the loader scripts/payroll-ctc-from-register.js:
//   register figure for the month -> earlier register figure -> salary structure (revision after the register month wins);
//   the list, the Details answer and the Excel / CSV export carry it; the loader reads "Monthly CTC" / "Montly CTC", dry run first,
//   refuses a sheet without the column or with nobody matching, and can be undone. ZZCTC fixtures (codes TL999xx), removed after.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const DB = path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db'));
if (!fs.existsSync(DB) || /dev\.db$/.test(DB)) { console.error('No prisma/sandbox.db - start the sandbox first (never dev.db).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require('dotenv').config({ path: path.join(BACK, '.env') });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
const API = `${String(process.env.TL_API || 'http://localhost:4011').replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
if (/:4010(\/|$)/.test(API)) { console.error('Refusing: 4010 is the real server.'); process.exit(2); }
const prisma = require('../src/db');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const CTC = require('../src/utils/payrollCtc');

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400)}`); } };
const made = { users: [], emps: [] };
const MONTHS = ['2026-03', '2026-04'];
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function get(user, url) {
  let r;
  for (let i = 0; i < 10; i += 1) {
    try { r = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${tok(user)}` } }); break; } catch (e) { if (i === 9) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
async function emp(code, version) {
  const u = await prisma.user.create({ data: { name: `ZZCTC ${code}`, email: `zzctc-${code.toLowerCase()}-${Date.now().toString(36)}@example.test`, passwordHash: 'x'.repeat(40), role: 'EMPLOYEE' } });
  made.users.push(u.id);
  const e = await prisma.employee.create({ data: { userId: u.id, name: `ZZCTC ${code}`, employeeCode: code, email: u.email, department: 'ZZCTC', designation: 'Tester', employmentStatus: 'Active', dateOfJoining: new Date('2025-01-01') } });
  made.emps.push(e.id);
  const v = version ? await prisma.salaryStructureVersion.create({ data: { employeeId: e.id, ...version } }) : null;
  return { u, e, v };
}
const run = (e, month, extra = {}) => prisma.employeePayrollRun.create({ data: { employeeId: e.e.id, month, year: 2026, monthNum: Number(month.slice(5)), salaryVersionId: e.v ? e.v.id : null, payMode: e.v ? e.v.payMode : 'Package', workingDays: 31, daysPresent: 31, ...extra } });
const loader = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.join(BACK, 'scripts', 'payroll-ctc-from-register.js'), ...args, '--db', DB], { cwd: BACK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};
function register(file, groupA, stipend, ctcHeader = 'Monthly CTC') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['', 'Teamlink'], ['', 'Employee ID', 'Employee Name', ...(ctcHeader ? [ctcHeader] : []), 'Gross Salary'], ...groupA.map(([c, v]) => ['', c, 'x', ...(ctcHeader ? [v] : []), 100])]), 'Group A');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['', 'Teamlink'], ['', 'Employee ID', 'Employee Name', 'Montly CTC', 'Stipend'], ...stipend.map(([c, v]) => ['', c, 'x', v, 100])]), 'Stipend');
  XLSX.writeFile(wb, file);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zzctc-'));
  try {
    try { const h = await fetch(`${API}/health`); if (!h.ok) throw new Error('x'); } catch { console.error(`The sandbox API is not answering at ${API}.`); process.exit(3); }
    for (const m of MONTHS) if (await prisma.appSetting.findUnique({ where: { key: CTC.keyOf(m) } })) { console.error(`The sandbox already keeps register figures for ${m} - refusing to overwrite them.`); process.exit(2); } // eslint-disable-line no-restricted-syntax, no-await-in-loop
    const admin = await prisma.user.create({ data: { name: 'ZZCTC Admin', email: `zzctc-admin-${Date.now().toString(36)}@example.test`, passwordHash: 'x'.repeat(40), role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsRole: 'NONE', hrmsAccess: true, accountsAccess: true, atsAccess: false, status: 'Active' } });
    made.users.push(admin.id);
    const pkg = await emp('TL99901', { effectiveFrom: '2026-01-01', payMode: 'Package', ctc: 120000, basic: 4000 });
    const stp = await emp('TL99902', { effectiveFrom: '2026-01-01', payMode: 'Stipend', stipend: 8000 });
    const own = await emp('TL99903', { effectiveFrom: '2026-01-01', payMode: 'Package', ctc: 240000 });
    const r3 = await run(pkg, '2026-03'); const r4 = await run(pkg, '2026-04');
    const s3 = await run(stp, '2026-03');
    const o3 = await run(own, '2026-03', { importNote: 'ZZ', importedBreakup: JSON.stringify({ sheet: { monthlyCtc: 21500 } }) });

    console.log('A. Before any register figure: the salary structure');
    let map = await CTC.monthlyCtcFor([r3, s3, o3]);
    ok(map.get(r3.id).value === 10000 && map.get(r3.id).from === 'structure', 'package: annual CTC / 12', map.get(r3.id));
    ok(map.get(s3.id).value === 8000 && map.get(s3.id).from === 'structure', 'stipend: the stipend', map.get(s3.id));
    ok(map.get(o3.id).value === 21500 && map.get(o3.id).from === 'register', "a record's own register figure wins", map.get(o3.id));

    console.log('B. The loader');
    const bad = path.join(tmp, 'no-ctc.xlsx'); register(bad, [['TL99901', 11000]], [], null);
    let r = loader(['--register', bad, '--month', '2026-03', '--apply']);
    ok(r.code === 2 && /no "Monthly CTC" column/.test(r.out), 'a sheet without the column is refused', r.out);
    const none = path.join(tmp, 'nobody.xlsx'); register(none, [['TL00001', 100]], []);
    r = loader(['--register', none, '--month', '2026-03', '--apply']);
    ok(r.code === 2 && /Nobody in the register matches/.test(r.out), 'a register with nobody matching changes nothing', r.out);
    const good = path.join(tmp, 'Pay Register Mar.xlsx'); register(good, [['TL99901', 11000], ['TL00002', 500]], [['TL99902', 10000]]);
    r = loader(['--register', good, '--month', '2026-03']);
    ok(r.code === 0 && /Dry run: nothing changed/.test(r.out) && /Matched to TeamLink employees: 2/.test(r.out) && /TL00002/.test(r.out), 'dry run: says what it would keep, names the one not in TeamLink', r.out);
    ok(!(await prisma.appSetting.findUnique({ where: { key: CTC.keyOf('2026-03') } })), 'dry run wrote nothing');
    const before = await prisma.salaryStructureVersion.findMany({ where: { employeeId: { in: made.emps } }, orderBy: { id: 'asc' } });
    r = loader(['--register', good, '--month', '2026-03', '--apply']);
    ok(r.code === 0 && /Kept the Monthly CTC of 2 people/.test(r.out), 'apply keeps the figures', r.out);
    const after = await prisma.salaryStructureVersion.findMany({ where: { employeeId: { in: made.emps } }, orderBy: { id: 'asc' } });
    ok(JSON.stringify(before) === JSON.stringify(after), 'no salary structure was changed');
    const runAfter = await prisma.employeePayrollRun.findUnique({ where: { id: r3.id } });
    ok(runAfter.importedBreakup === null && runAfter.importNote === null && runAfter.updatedAt.getTime() === r3.updatedAt.getTime(), 'no payroll record was touched (it stays editable)');
    ok(!!(await prisma.auditLog.findFirst({ where: { action: 'Register Monthly CTC loaded', entityId: CTC.keyOf('2026-03') } })), 'the load is in the audit log');

    console.log('C. What a record shows after it');
    map = await CTC.monthlyCtcFor([r3, r4, s3]);
    ok(map.get(r3.id).value === 11000 && map.get(r3.id).from === 'register' && map.get(r3.id).month === '2026-03', "that month: the register's figure", map.get(r3.id));
    ok(map.get(s3.id).value === 10000, 'stipend from the "Montly CTC" column', map.get(s3.id));
    ok(map.get(r4.id).value === 11000 && map.get(r4.id).month === '2026-03', 'the next month keeps the register figure (no revision since)', map.get(r4.id));
    const earlier = await run(own, '2026-04');
    map = await CTC.monthlyCtcFor([earlier]);
    ok(map.get(earlier.id).value === 21500 && map.get(earlier.id).month === '2026-03', "an earlier record's own register figure carries forward too", map.get(earlier.id));
    await prisma.salaryStructureVersion.update({ where: { id: pkg.v.id }, data: { effectiveTo: '2026-03-31' } });
    await prisma.salaryStructureVersion.create({ data: { employeeId: pkg.e.id, effectiveFrom: '2026-04-01', payMode: 'Package', ctc: 144000 } });
    map = await CTC.monthlyCtcFor([r3, r4]);
    ok(map.get(r4.id).value === 12000 && map.get(r4.id).from === 'structure', 'revised after the register month: the new salary counts', map.get(r4.id));
    ok(map.get(r3.id).value === 11000, 'and the register month keeps its own figure', map.get(r3.id));

    console.log('D. The payroll screens');
    let a = await get(admin, '/payroll/entries?month=2026-03');
    const row = a.body && a.body.entries.find((x) => x.id === r3.id);
    ok(a.status === 200 && row && row.monthlyCtc === 11000 && row.monthlyCtcFrom.from === 'register', 'the Process Payroll list carries Monthly CTC and where it came from', row && { c: row.monthlyCtc, f: row.monthlyCtcFrom });
    a = await get(admin, `/payroll/entries/${s3.id}`);
    ok(a.status === 200 && a.body.entry.monthlyCtc === 10000, 'the Details answer carries it', a.body && a.body.entry && a.body.entry.monthlyCtc);
    a = await get(admin, '/payroll/runs/2026-03/export?format=csv');
    const lines = a.text.split(/\r?\n/);
    const head = lines[0].replace(/^﻿/, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
    const i = head.indexOf('Monthly CTC');
    const line = lines.find((x) => x.includes('TL99901'));
    ok(a.status === 200 && i === 5 && line && line.split(',')[i].replace(/"/g, '') === '11000', 'the export has a Monthly CTC column with the figure', [head.slice(0, 8), line && line.slice(0, 120)]);
    const total = lines.find((x) => /TOTAL/.test(x));
    ok(!!total && total.split(',').length === head.length, 'the export totals row still lines up with the headings', total && [total.split(',').length, head.length]);
    a = await get(pkg.u, '/payroll/entries?month=2026-03');
    ok(a.status === 403, 'an employee cannot read the payroll list (403)', a.status);

    console.log('E. Undo');
    r = loader(['--undo', '--month', '2026-03', '--apply']);
    ok(r.code === 0 && /Removed/.test(r.out) && !(await prisma.appSetting.findUnique({ where: { key: CTC.keyOf('2026-03') } })), 'undo removes the month\'s figures', r.out);
    map = await CTC.monthlyCtcFor([r3]);
    ok(map.get(r3.id).value === 10000 && map.get(r3.id).from === 'structure', 'back to the salary structure', map.get(r3.id));
  } catch (e) {
    console.error(e);
    fail += 1;
  } finally {
    try {
      await prisma.appSetting.deleteMany({ where: { key: { in: MONTHS.map((m) => CTC.keyOf(m)) } } });
      await prisma.employeePayrollRun.deleteMany({ where: { employeeId: { in: made.emps } } });
      await prisma.salaryStructureVersion.deleteMany({ where: { employeeId: { in: made.emps } } });
      await prisma.auditLog.deleteMany({ where: { entityId: { in: MONTHS.map((m) => CTC.keyOf(m)) } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    } catch (e) { console.error('cleanup:', e.message); }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
