#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BACKFILL: past HRMS payroll runs -> employee-wise Payroll vouchers in the
// Accounts journal (user spec 2026-10-09, point 7).
//
//   node scripts/backfill-payroll-vouchers.js                       DRY RUN of every run (reads only)
//   node scripts/backfill-payroll-vouchers.js --months=2026-08,2026-09
//   node scripts/backfill-payroll-vouchers.js --plug-difference     show it with the register differences booked
//   node scripts/backfill-payroll-vouchers.js --db=<file> --apply --run=2026-08,2026-09 [--with-payments] [--plug-difference] [--no-employer]
//   node scripts/backfill-payroll-vouchers.js --db=<file> --undo [--run=2026-08]
//
// WHY A DRY RUN FIRST. The imported runs (Sep 2025 - Sep 2026) are PAID and were
// deliberately never posted to the journal: the pay-register sheets are the
// authority, and the bank statements / Office & Accounts expenses may already
// carry the salary payments. Posting them could count the same money twice.
// So nothing is posted unless a run is named with --run=, one run at a time.
//
//   * IDEMPOTENT: one voucher per payroll run (key payroll-month:<runId>:v<n>);
//     a run that already has a live voucher is skipped, so a second --apply
//     creates nothing.
//   * Each voucher is employee-wise and balanced per employee. An employee whose
//     register net does not equal gross less deductions (e.g. the register
//     ignored TDS / professional tax) BLOCKS the run - unless --plug-difference,
//     which books the difference to Other deductions payable and says so.
//   * Employer PF / ESI are booked as the live payroll posting does; --no-employer leaves
//     them out (the sheets do not contain them).
//   * Imported records stay PAID in HRMS. --with-payments also books the employee-wise
//     Payment voucher (Dr Salary payable - name / Cr Bank, on each record's paid date,
//     mode "Bank transfer", no UTR on file). Without it the voucher shows the salary as
//     still payable in the Journal until Accounts records the payments.
//   * --apply / --undo take a backup first (VACUUM INTO backups/). On the REAL database
//     they are refused unless BOTH --really-real and TL_ALLOW_REAL_APPLY=1 are given.
//   * --undo deletes only what this script booked (marked "backfill" in the voucher).
// ---------------------------------------------------------------------------
/* eslint-disable no-console, global-require */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const TAG = 'payroll-vouchers-2026-10-09';

const DB = path.resolve(val('db') || path.join(BACK, 'prisma', 'dev.db'));
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
const isReal = DB.toLowerCase() === REAL.toLowerCase();
const apply = has('--apply');
const undo = has('--undo');
const plug = has('--plug-difference');
const includeEmployer = !has('--no-employer');
const withPayments = has('--with-payments');
const runList = (val('run') || '').split(',').map((s) => s.trim()).filter(Boolean);
const monthFilter = (val('months') || '').split(',').map((s) => s.trim()).filter(Boolean);

if ((apply || undo) && isReal) {
  if (!has('--really-real') || process.env.TL_ALLOW_REAL_APPLY !== '1') {
    console.error('REFUSED: this is the REAL database (prisma/dev.db). Applying or undoing here needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Run it on a copy first, or ask the person who owns the books.');
    process.exit(3);
  }
}
if (apply && !runList.length) {
  console.error('REFUSED: --apply needs --run=YYYY-MM[,YYYY-MM...] - one explicit switch per run. Look at the dry run first.');
  process.exit(3);
}
if (!fs.existsSync(DB)) { console.error(`No such database: ${DB}`); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(String.fromCharCode(92)).join('/')}`;

const inr = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][mo - 1]} ${y}`; };
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo, 1)); return d.toISOString().slice(0, 7); };

function backup(label) {
  const dir = isReal ? path.join(BACK, 'backups') : path.dirname(DB);
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, `${isReal ? 'dev' : path.basename(DB, '.db')}-before-${label}-${ts}.db`);
  const src = new DatabaseSync(DB, { readOnly: false });
  try { src.exec(`VACUUM INTO '${out.split(String.fromCharCode(92)).join('/').replace(/'/g, "''")}'`); } finally { src.close(); }
  console.log(`Backup written: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  return out;
}

// ---- DRY RUN (reads only, through node:sqlite opened read-only) ------------------------------------
function dryRun() {
  // A dry run never opens a Prisma connection (it would run start-up pragmas on the database): the
  // shared db module is replaced by a stub that refuses any use, and the arithmetic is the pure builder.
  const dbPath = require.resolve('../src/db');
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
    exports: new Proxy({}, { get: (_t, k) => { if (k === 'then' || typeof k === 'symbol') return undefined; throw new Error(`dry run must not use the database (${String(k)})`); } }),
  };
  const V = require('../src/utils/payrollVouchers');
  const db = new DatabaseSync(DB, { readOnly: true });
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const runs = all('SELECT * FROM PayrollRun ORDER BY month').filter((r) => (!monthFilter.length || monthFilter.includes(r.month)) && (!runList.length || runList.includes(r.month)));
  const accountsRows = all('SELECT code, name FROM LedgerAccount');
  const mapRow = all("SELECT value FROM AppSetting WHERE key = 'accounts.payrollLedgerMapping'")[0];
  const defaults = { salary: '5100', employerPf: '5110', employerEsi: '5120', pfPayable: '2210', esiPayable: '2220', tdsPayable: '2230', ptPayable: '2240', otherPayable: '2250', salaryPayable: '2100', bank: '1100' };
  let saved = {}; try { saved = mapRow ? JSON.parse(mapRow.value) || {} : {}; } catch { saved = {}; }
  const accounts = {};
  Object.keys(defaults).forEach((k) => { const code = saved[k] || defaults[k]; const a = accountsRows.find((x) => x.code === code) || { code, name: code }; accounts[k] = a; });
  const closedRow = all("SELECT value FROM AppSetting WHERE key = 'accounts.booksClosedUpTo'")[0];
  let closed = null; try { closed = closedRow ? JSON.parse(closedRow.value) : null; } catch { closed = null; }
  const posted = new Set(all("SELECT referenceId FROM JournalEntry WHERE referenceType = 'PAYROLL_MONTH'").map((r) => r.referenceId));
  const office = all("SELECT category, monthlyAmount, expenseDate, paidStatus FROM OfficeExpense WHERE category IN ('Salary','PF','ESI','PT','TDS') AND expenseDate IS NOT NULL");
  const bank = all("SELECT date, amount, category, description FROM BankTransaction WHERE type = 'Debit'");
  const out = [];
  const grand = { employees: 0, gross: 0, ded: 0, net: 0, er: 0 };
  const warnings = [];
  for (const run of runs) {
    const entries = all('SELECT e.*, emp.name AS _name, emp.employeeCode AS _code, emp.department AS _dept FROM EmployeePayrollRun e JOIN Employee emp ON emp.id = e.employeeId WHERE e.month = ?', run.month)
      .map((e) => ({ ...e, employee: { name: e._name, employeeCode: e._code, department: e._dept } }));
    const strict = V.buildVoucher({ entries, accounts, includeEmployer, plug: false });
    const used = V.buildVoucher({ entries, accounts, includeEmployer, plug });
    const byStatus = {};
    entries.forEach((e) => { byStatus[e.status] = (byStatus[e.status] || 0) + 1; });
    const sum = (k) => used.rows.reduce((n, r) => n + Math.round(r[k] * 100), 0) / 100;
    const gross = sum('earnedGross');
    const ded = used.totals.deductionsPaise / 100;
    const net = used.totals.netPaise / 100;
    const er = used.totals.employerPaise / 100;
    const nm = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    void nm;
    const next = nextMonth(run.month);
    // Salary for month M is normally paid at the start of M+1, and PF / ESI / PT / TDS in the following weeks.
    const off = { SalarySame: 0, SalaryNext: 0 };
    office.forEach((e) => {
      const m = e.expenseDate.slice(0, 7);
      if (e.category === 'Salary') { if (m === run.month) off.SalarySame += e.monthlyAmount; else if (m === next) off.SalaryNext += e.monthlyAmount; } else if (m === next) off[e.category] = (off[e.category] || 0) + e.monthlyAmount;
    });
    const bankSalary = bank.filter((t) => t.date && (t.date.slice(0, 7) === run.month || t.date.slice(0, 7) === next) && /salary|payroll|stipend/i.test(`${t.category || ''} ${t.description || ''}`));
    // bank debits that equal one employee's net pay (a possible salary transfer)
    const netSet = new Map(entries.map((e) => [Math.round(e.netPay * 100), e._name]));
    const bankEq = bank.filter((t) => t.date && (t.date.slice(0, 7) === run.month || t.date.slice(0, 7) === next) && netSet.has(Math.round(t.amount * 100)));
    out.push({
      month: run.month, id: run.id, employees: entries.length, gross, ded, net, er, voucherDr: used.totals.debitPaise / 100, lines: used.lines.length,
      byStatus, problems: strict.problems, plugTotal: used.rows.reduce((n, r) => n + Math.round(r.registerDifference * 100), 0) / 100,
      postedAlready: posted.has(run.id), closedBlock: !!(closed && run.month <= closed), off, bankSalary: bankSalary.length, bankSalaryAmt: bankSalary.reduce((n, t) => n + t.amount, 0), bankEq: bankEq.length,
      paidDates: [...new Set(entries.filter((e) => e.paidAt).map((e) => new Date(e.paidAt).toISOString().slice(0, 10)))].length,
    });
    grand.employees += entries.length; grand.gross += gross; grand.ded += ded; grand.net += net; grand.er += er;
  }
  console.log(`\nDRY RUN - ${isReal ? 'REAL database (read-only)' : DB}\nOptions: plug-difference=${plug}  employer PF/ESI booked=${includeEmployer}  with-payments=${withPayments}\n`);
  console.log([pad('Run', 10), lpad('Staff', 6), lpad('Gross (earned)', 16), lpad('Deductions', 14), lpad('Net pay', 14), lpad('Employer PF/ESI', 16), lpad('Voucher Dr=Cr', 16), lpad('Lines', 6), '  Status / notes'].join(' '));
  out.forEach((r) => {
    const notes = [];
    notes.push(Object.entries(r.byStatus).map(([k, v]) => `${v} ${k}`).join(', '));
    if (r.postedAlready) notes.push('ALREADY POSTED - would be skipped');
    if (r.problems.length) notes.push(plug ? `${r.problems.length} register difference(s) plugged ${inr(r.plugTotal)}` : `BLOCKED: ${r.problems.length} employee(s) unbalanced`);
    if (r.closedBlock) notes.push('books closed for this month');
    console.log([pad(r.month, 10), lpad(r.employees, 6), lpad(inr(r.gross), 16), lpad(inr(r.ded), 14), lpad(inr(r.net), 14), lpad(inr(r.er), 16), lpad(inr(r.voucherDr), 16), lpad(r.lines, 6), `  ${notes.join(' | ')}`].join(' '));
  });
  console.log([pad('TOTAL', 10), lpad(grand.employees, 6), lpad(inr(grand.gross), 16), lpad(inr(grand.ded), 14), lpad(inr(grand.net), 14), lpad(inr(grand.er), 16)].join(' '));
  const blocked = out.filter((r) => r.problems.length);
  if (blocked.length) {
    console.log('\nUNBALANCED EMPLOYEES (register net is not earned gross less deductions) - these block a run unless --plug-difference:');
    blocked.forEach((r) => r.problems.forEach((p) => console.log(`  ${r.month}  ${pad(p.code || '', 8)} ${pad(p.name, 34)} difference ${inr(p.differencePaise / 100)} (${p.differencePaise > 0 ? 'would be credited to Other deductions payable' : 'would be debited to Other deductions payable'})`)));
  }
  console.log('\nOVERLAP WITH WHAT IS ALREADY IN THE BOOKS (Office & Accounts expenses and bank statement lines dated in the payroll month or the month after):');
  console.log('(Office "Salary" rows are shown twice because the sheet does not say which month a transfer pays: dated in the payroll month, and dated in the month after. PF/ESI/PT/TDS are the rows dated in the month after.)');
  console.log([pad('Run', 10), lpad('Net pay (sheet)', 16), lpad('Salary dated M', 16), lpad('Salary dated M+1', 17), lpad('PF', 12), lpad('ESI', 10), lpad('PT', 10), lpad('TDS', 12), lpad('Bank "salary" lines', 20), lpad('Bank = one net', 15)].join(' '));
  out.forEach((r) => console.log([pad(r.month, 10), lpad(inr(r.net), 16), lpad(inr(r.off.SalarySame), 16), lpad(inr(r.off.SalaryNext), 17), lpad(inr(r.off.PF || 0), 12), lpad(inr(r.off.ESI || 0), 10), lpad(inr(r.off.PT || 0), 10), lpad(inr(r.off.TDS || 0), 12), lpad(`${r.bankSalary} (${inr(r.bankSalaryAmt)})`, 20), lpad(r.bankEq, 15)].join(' ')));
  const withOverlap = out.filter((r) => r.off.SalarySame > 0 || r.off.SalaryNext > 0 || r.bankSalary > 0);
  if (withOverlap.length) warnings.push(`${withOverlap.length} run(s) have a "Salary" expense in Office & Accounts or a salary-worded bank line close to their month (${withOverlap.map((r) => r.month).join(', ')}). Posting their Payment vouchers (--with-payments) books the same salary money a second time in the journal.`);
  warnings.push('The pay-register sheets (the net figures above) are authoritative. The journal is separate from Office & Accounts expenses and bank reconciliation today; nothing here changes them. If a report ever adds the journal to those, salary would be counted twice.');
  if (includeEmployer) warnings.push(`Employer PF / ESI (${inr(grand.er)} over the runs) are booked as an extra expense, as the live payroll posting does. They are NOT in the sheets' net pay. Use --no-employer to leave them out.`);
  console.log('\nWARNINGS');
  warnings.forEach((w) => console.log(` - ${w}`));
  console.log('\nNothing was written. To post a run: --db=<copy> --apply --run=YYYY-MM  (first run on a copy of the database).');
  db.close();
}

// ---- APPLY / UNDO ------------------------------------------------------------------------------------------
async function applyRuns() {
  backup('payroll-vouchers');
  const prisma = require('../src/db');
  const PP = require('../src/utils/payrollPosting');
  const V = require('../src/utils/payrollVouchers');
  const L = require('../src/utils/ledger');
  if (!(await L.employeeWiseReady())) { console.error('The employee-wise salary migration (20261009210000) is not applied to this database.'); process.exit(4); }
  const actor = { id: null, name: 'Payroll backfill (script)' };
  const { map } = await PP.getMapping();
  const accounts = await PP.resolveMapping(map);
  let created = 0; let skipped = 0; let failed = 0;
  for (const month of runList) {
    // eslint-disable-next-line no-await-in-loop
    const run = await prisma.payrollRun.findUnique({ where: { month } });
    if (!run) { console.log(`${month}: no payroll run - skipped`); skipped += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    const st = await PP.monthState(month);
    if (st.posted) { console.log(`${month}: already has a voucher (${st.journalEntry.idempotencyKey}) - skipped, nothing duplicated`); skipped += 1; } else {
      // eslint-disable-next-line no-await-in-loop
      const entries = await prisma.employeePayrollRun.findMany({ where: { month }, include: { employee: { select: { name: true, employeeCode: true, department: true } } } });
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await V.postRunVoucher({
          month, run, entries, accounts, actor, key: PP.monthKey(run.id, st.nextVersion), plug, includeEmployer, skipClosedCheck: has('--ignore-closed'), extra: { backfill: TAG },
        });
        // eslint-disable-next-line no-await-in-loop
        await prisma.employeePayrollRun.updateMany({ where: { month }, data: { journalEntryId: r.entry.id } });
        console.log(`${month}: posted ${entries.length} employees, voucher total ${inr(r.entry.totalDebit)} (${r.replay ? 'replay' : 'new'})`);
        created += 1;
      } catch (err) { console.log(`${month}: NOT posted - ${err.message}`); failed += 1; continue; }
    }
    if (withPayments) {
      // eslint-disable-next-line no-await-in-loop
      const entries = await prisma.employeePayrollRun.findMany({ where: { month, status: 'PAID' }, select: { employeeId: true, paidAt: true } });
      const byDate = new Map();
      entries.forEach((e) => { const d = e.paidAt ? new Date(e.paidAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10); byDate.set(d, [...(byDate.get(d) || []), e.employeeId]); });
      for (const [date, ids] of byDate) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await V.payRun(month, actor, { items: ids.map((employeeId) => ({ employeeId })), date, mode: 'Bank transfer', reference: null, extra: { backfill: TAG }, skipClosedCheck: has('--ignore-closed') });
          console.log(`${month}: payment voucher for ${ids.length} employees dated ${date}${r && r.already ? ' (already paid - nothing new)' : ''}`);
        } catch (err) { console.log(`${month}: payment NOT booked (${date}) - ${err.message}`); failed += 1; }
      }
    }
  }
  console.log(`\nDone: ${created} voucher(s) created, ${skipped} skipped, ${failed} problem(s).`);
  await prisma.$disconnect();
}

async function undoRuns() {
  backup('payroll-vouchers-undo');
  const prisma = require('../src/db');
  const marker = `"backfill":"${TAG}"`;
  const where = { source: 'HRMS_PAYROLL', payload: { contains: marker } };
  let jes = await prisma.journalEntry.findMany({ where, select: { id: true, payrollRunId: true, voucherType: true, narration: true } });
  if (runList.length) {
    const runs = await prisma.payrollRun.findMany({ where: { month: { in: runList } }, select: { id: true } });
    const ids = new Set(runs.map((r) => r.id));
    jes = jes.filter((j) => ids.has(j.payrollRunId));
  }
  const ids = jes.map((j) => j.id);
  console.log(`Undo: ${jes.length} voucher(s) booked by this script${runList.length ? ` for ${runList.join(', ')}` : ''}.`);
  if (!ids.length) { await prisma.$disconnect(); return; }
  await prisma.$transaction([
    prisma.payrollVoucherPayment.deleteMany({ where: { journalEntryId: { in: ids } } }),
    prisma.payrollVoucherEmployee.deleteMany({ where: { journalEntryId: { in: ids } } }),
    prisma.journalLine.deleteMany({ where: { journalEntryId: { in: ids } } }),
    prisma.employeePayrollRun.updateMany({ where: { journalEntryId: { in: ids } }, data: { journalEntryId: null } }),
    prisma.employeePayrollRun.updateMany({ where: { paymentJournalEntryId: { in: ids } }, data: { paymentJournalEntryId: null } }),
    prisma.journalEntry.deleteMany({ where: { id: { in: ids } } }),
  ]);
  console.log('Removed. The HRMS records themselves (status PAID, amounts) were never changed by the backfill.');
  await prisma.$disconnect();
}

(async () => {
  if (undo) return undoRuns();
  if (apply) return applyRuns();
  return dryRun();
})().catch((e) => { console.error(e); process.exit(1); });
