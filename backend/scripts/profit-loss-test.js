// PROFIT & LOSS (Accounts > Reports > Profit & Loss, utils/profitLoss.js): on a COPY of a database, never the live one.
//   TEST_SOURCE_DB=<a .db file> node scripts/profit-loss-test.js
// Checks: the financial-year months, each month's result = income − payroll − PF/ESI/PT − office, Salary / TDS / assets bills left out,
// a month with no bills has no result, the totals add up, and nothing is written.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = process.env.TEST_SOURCE_DB;
if (!SRC || !fs.existsSync(SRC)) { console.log('Set TEST_SOURCE_DB to a .db file to copy.'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `pl-test-${Date.now()}.db`);
fs.copyFileSync(SRC, COPY);
process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`;

let total = 0; let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };

(async () => {
  const prisma = require('../src/db');
  const PL = require('../src/utils/profitLoss');
  try {
    check('the financial year of November 2026 is April 2026 to March 2027', JSON.stringify(PL.fyOf('2026-11')) === JSON.stringify({ start: '2026-04', end: '2027-03', label: '2026-27' }));
    check('the financial year of February 2027 is still 2026-27', PL.fyOf('2027-02').label === '2026-27' && PL.fyOf('2026-03').label === '2025-26');
    check('months between, across a year end', PL.monthsBetween('2026-11', '2027-03').join() === '2026-11,2026-12,2027-01,2027-02,2027-03');

    // a test month with known money: an invoice, a payroll run and bills of each kind (Salary / TDS / assets must be left out)
    const M = '2026-05';
    const tag = `PLTEST-${Date.now()}`;
    const today = new Date('2026-11-20T10:00:00+05:30');
    const before = await PL.buildProfitLoss({ today });
    const b = before.rows.find((r) => r.month === M);
    const client = await prisma.client.findFirst({ select: { id: true } });
    await prisma.invoice.create({ data: { invoiceNumber: tag, clientId: client ? client.id : null, amount: 100000, gst: 18000, tds: 10000, invoiceDate: `${M}-10`, status: 'Pending' } }).catch((e) => { throw new Error(`invoice: ${e.message.slice(0, 200)}`); });
    const run = await prisma.payrollRun.findUnique({ where: { month: M } });
    if (run) await prisma.payrollRun.update({ where: { month: M }, data: { totalGross: run.totalGross + 50000 } });
    else await prisma.payrollRun.create({ data: { month: M, period: 'May 2026', totalGross: 50000, employees: 1 } });
    const bill = (category, amount, gst = 0) => prisma.officeExpense.create({ data: { category, monthlyAmount: amount, gstAmount: gst, expenseDate: `${M}-12`, description: tag, approvalStatus: 'APPROVED' } });
    await bill('Office Rent', 11800, 1800); // 10,000 before GST
    await bill('PF', 3000);
    await bill('Salary', 40000); // left out (payroll's own payout)
    await bill('TDS', 250000); // left out, and listed to check
    await bill('assets', 70000); // left out
    await bill('Credit Card Payment', 5000); // office
    const after = await PL.buildProfitLoss({ today });
    const a = after.rows.find((r) => r.month === M);
    check('income grows by the fee before GST (₹1,00,000)', a.income - b.income === 100000, [b.income, a.income]);
    check('payroll grows by the run\'s gross (₹50,000)', a.payroll - b.payroll === 50000, [b.payroll, a.payroll]);
    check('PF counts as PF / ESI / PT (₹3,000)', a.statutory - b.statutory === 3000, [b.statutory, a.statutory]);
    check('office grows by rent before GST + the card payment only (₹15,000): Salary, TDS and assets left out', a.office - b.office === 15000, [b.office, a.office]);
    check('the month\'s result = income − payroll − statutory − office', a.result === a.income - a.payroll - a.statutory - a.office, a);
    check('Salary / TDS / assets are shown as left out', a.leftOut.salary - b.leftOut.salary === 40000 && a.leftOut.tds - b.leftOut.tds === 250000 && a.leftOut.assets - b.leftOut.assets === 70000, a.leftOut);
    const tdsGroup = after.checks.find((g) => g.kind === 'tds');
    check('the ₹2,50,000 under TDS is listed to check', !!tdsGroup && tdsGroup.items.some((x) => x.amount === 250000 && x.note === tag), tdsGroup);
    check('the running month has no result yet', after.rows.find((r) => r.month === '2026-11').result === null);
    const closed = after.rows.filter((r) => r.result !== null);
    check('the total result is the sum of the closed months', after.totals.result === closed.reduce((s, r) => s + r.result, 0));
    check('the forecast covers November to March (5 months) and starts from the actual result', after.forecast.remainingMonths === 5 && after.forecast.actualSoFar === after.totals.result);
    check('forecast defaults are numbers', ['joinings', 'fee', 'payroll', 'office', 'statutory'].every((k) => Number.isFinite(after.forecast.defaults[k])), after.forecast.defaults);
    // read-only: building it twice changes nothing
    const n1 = await prisma.officeExpense.count(); await PL.buildProfitLoss({ today }); const n2 = await prisma.officeExpense.count();
    check('working it out writes nothing', n1 === n2);
  } catch (e) {
    failed += 1; total += 1; console.log(`FAIL  crashed: ${e.message}`);
  } finally {
    await prisma.$disconnect();
    try { fs.unlinkSync(COPY); } catch { /* gone */ }
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
