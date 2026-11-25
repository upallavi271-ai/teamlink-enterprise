// ---------------------------------------------------------------------------
// PROFIT & LOSS + FORECAST (founder 2026-11-25: "Give me the profit and loss predictions for this invoice and expenses" ->
// "i need this in accounts"). Accounts > Reports > Profit & Loss. READ-ONLY: nothing here writes.
//
// One month's result, the way the books already read it (routes/office.js, accrual basis, GST left out on both sides):
//   income    = the fee on the month's invoices, before GST, after issued credit notes (creditNotes.billedOf); cancelled invoices left out
//   payroll   = the month's payroll run, gross pay (PayrollRun.totalGross)
//   statutory = PF / ESI / PT bills in office expenses
//   office    = every other office bill before GST, credit-card payments included
//   left out  = "Salary" bills (the payroll's own bank payout - counted once, through payroll), "TDS" bills (tax deposited for others),
//               "assets" (equipment bought, not a running cost); "hand" entries and rejected bills, as everywhere in Accounts
//   result    = income − payroll − statutory − office
// The forecast runs from next month to March (the end of the financial year): joinings × fee per joining − the month's costs, with
// defaults taken from the latest months; the screen lets the person change every input.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const CNU = require('./creditNotes');

const R = (n) => Math.round(Number(n) || 0);
const ym = (v) => {
  if (!v) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '';
};
const key = (s) => String(s || '').trim().toLowerCase();
const LEFT_OUT = { salary: 'salary', tds: 'tds', assets: 'assets', asset: 'assets' };
const STATUTORY = new Set(['pf', 'esi', 'pt']);
const CHECK_KINDS = [
  ['open', 'This month is still running', 'Its office bills are not entered yet, so it has no result.'],
  ['nobills', 'Months with no office bills', 'No result is shown for these months until their bills are entered.'],
  ['twice', 'Entered twice', 'The same bill appears more than once (same category, amount, date and note).'],
  ['tds', 'Large payments filed under TDS', 'Payments of ₹1 lakh or more under TDS. They are left out of the costs; check they really are TDS.'],
  ['fee', 'Large amounts filed as Bank Fees', 'Bank fees are usually small; these are ₹10,000 or more (some are cash withdrawals). They are counted as costs.'],
];

// the financial year (April to March) a month belongs to: '2026-11' -> { start: '2026-04', end: '2027-03' }
function fyOf(month) {
  const [y, m] = month.split('-').map(Number);
  const s = m >= 4 ? y : y - 1;
  return { start: `${s}-04`, end: `${s + 1}-03`, label: `${s}-${String((s + 1) % 100).padStart(2, '0')}` };
}
function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}
const istMonth = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);

async function buildProfitLoss({ today = new Date(), fy: fyWanted } = {}) {
  const now = istMonth(today);
  const fy = fyWanted && /^\d{4}$/.test(String(fyWanted)) ? fyOf(`${fyWanted}-04`) : fyOf(now);
  const lastShown = now < fy.end ? now : fy.end;
  const months = monthsBetween(fy.start, lastShown);
  const M = new Map(months.map((k) => [k, {
    month: k, invoices: 0, income: 0, gst: 0, tds: 0, received: 0, joinings: 0, feeByJoin: 0,
    payroll: 0, payrollPeople: 0, statutory: 0, office: 0, bills: 0, leftOut: { salary: 0, tds: 0, assets: 0 },
  }]));
  const at = (k) => M.get(k);

  const [invoices, pays, bills, runs, joined] = await Promise.all([
    prisma.invoice.findMany({ where: { status: { not: 'Cancelled' } } }),
    prisma.invoicePayment.findMany({ select: { date: true, amount: true } }).catch(() => []),
    prisma.officeExpense.findMany(),
    prisma.payrollRun.findMany({ select: { month: true, totalGross: true, employees: true } }),
    prisma.application.findMany({ where: { stage: { in: ['JOINED', 'HIRED'] } }, select: { joiningDate: true, joinedAt: true } }),
  ]);
  await CNU.decorateNet(invoices);
  invoices.forEach((i) => {
    const m = at(ym(i.invoiceDate));
    if (m) { m.invoices += 1; m.income += CNU.billedOf(i); m.gst += CNU.gstBilledOf(i); m.tds += Number(i.netTds != null ? i.netTds : i.tds || 0); }
    const j = at(ym(i.joiningDate));
    if (j) j.feeByJoin += CNU.billedOf(i);
  });
  pays.forEach((p) => { const m = at(ym(p.date)); if (m) m.received += Number(p.amount || 0); });
  joined.forEach((a) => { const m = at(ym(a.joiningDate) || ym(a.joinedAt)); if (m) m.joinings += 1; });
  runs.forEach((r) => { const m = at(r.month); if (m) { m.payroll += Number(r.totalGross || 0); m.payrollPeople += Number(r.employees || 0); } });

  // bills, and the entries worth a second look
  const checks = [];
  const seen = new Map();
  bills.filter((e) => e.entryKind !== 'hand' && e.approvalStatus !== 'REJECTED').forEach((e) => {
    const k = ym(e.expenseDate) || ym(e.createdAt);
    const base = Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0);
    const cat = key(e.category);
    const m = at(k);
    if (m) {
      m.bills += 1;
      if (LEFT_OUT[cat]) m.leftOut[LEFT_OUT[cat]] += base;
      else if (STATUTORY.has(cat)) m.statutory += base;
      else m.office += base;
    }
    if (!m) return;
    const sig = `${k}|${cat}|${R(e.monthlyAmount)}|${e.expenseDate || ''}|${e.description || ''}`;
    if (R(e.monthlyAmount) >= 10000 && seen.has(sig)) checks.push({ kind: 'twice', month: k, date: e.expenseDate || k, category: e.category, amount: R(e.monthlyAmount), note: e.description || '' });
    seen.set(sig, true);
    if (cat === 'tds' && base >= 100000) checks.push({ kind: 'tds', month: k, date: e.expenseDate || k, category: e.category, amount: R(base), note: e.description || '' });
    if (/bank fee/.test(cat) && base >= 10000) checks.push({ kind: 'fee', month: k, date: e.expenseDate || k, category: e.category, amount: R(base), note: e.description || '' });
  });

  const rows = months.map((k) => {
    const m = at(k);
    const open = k >= now; // this month is still running
    const noBills = m.bills === 0;
    const cost = m.payroll + m.statutory + m.office;
    return {
      month: k, open, noBills,
      invoices: m.invoices, joinings: m.joinings, income: R(m.income), gst: R(m.gst), tds: R(m.tds), received: R(m.received),
      payroll: R(m.payroll), payrollPeople: m.payrollPeople, statutory: R(m.statutory), office: R(m.office), costs: R(cost),
      result: open || noBills ? null : R(m.income - cost),
      feePerJoining: m.joinings ? R(m.feeByJoin / m.joinings) : null,
      leftOut: { salary: R(m.leftOut.salary), tds: R(m.leftOut.tds), assets: R(m.leftOut.assets) },
    };
  });
  rows.filter((r) => r.noBills).forEach((r) => checks.push({ kind: r.open ? 'open' : 'nobills', month: r.month, date: r.month, amount: 0, note: '' }));

  const closed = rows.filter((r) => r.result !== null);
  const tot = (list, f) => R(list.reduce((s, r) => s + (Number(r[f]) || 0), 0));
  const last = (n) => closed.slice(-n);
  const avg = (list, f) => (list.length ? R(tot(list, f) / list.length) : 0);
  const withJoin = rows.filter((r) => r.joinings > 0 && r.feePerJoining).slice(-3);
  const latestPayroll = [...rows].reverse().find((r) => r.payroll > 0);
  const defaults = {
    joinings: withJoin.length ? R(withJoin.reduce((s, r) => s + r.joinings, 0) / withJoin.length) : 0,
    fee: withJoin.length ? R(withJoin.reduce((s, r) => s + r.feePerJoining * r.joinings, 0) / Math.max(1, withJoin.reduce((s, r) => s + r.joinings, 0))) : 0,
    payroll: latestPayroll ? latestPayroll.payroll : avg(last(3), 'payroll'),
    office: avg(last(6), 'office'),
    statutory: avg(last(6), 'statutory'),
  };
  const remaining = monthsBetween(now, fy.end).length; // this month (still running) to March
  const actual = tot(closed, 'result');

  // money owed now (every client invoice not paid in full, after notes)
  const owed = invoices.map((i) => CNU.pendingOf(i)).filter((p) => p > 0.5);

  return {
    fy: fy.label, from: fy.start, to: fy.end, now,
    rows,
    totals: {
      months: closed.length, income: tot(closed, 'income'), costs: tot(closed, 'costs'), result: actual,
      received: tot(rows, 'received'), invoiced: tot(rows, 'income'), joinings: tot(rows, 'joinings'),
      averageResult: closed.length ? R(actual / closed.length) : 0,
    },
    owed: { invoices: owed.length, amount: R(owed.reduce((s, p) => s + p, 0)) },
    forecast: { remainingMonths: remaining, actualSoFar: actual, defaults },
    // the entries worth a second look, one group per kind (each item: month, date, category, amount, note)
    checks: CHECK_KINDS.map(([kind, title, effect]) => {
      const items = checks.filter((c) => c.kind === kind);
      return items.length ? { kind, title, effect, count: items.length, amount: R(items.reduce((t, c) => t + (c.amount || 0), 0)), items } : null;
    }).filter(Boolean),
    rules: 'Income is the fee on the month\'s invoices before GST, after credit notes. Costs are gross payroll, PF / ESI / PT and office bills before GST (credit-card payments included). Salary bills (the payroll\'s own payout), TDS deposits and assets bought are left out.',
  };
}

module.exports = { buildProfitLoss, fyOf, monthsBetween };
