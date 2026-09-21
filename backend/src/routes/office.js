const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const {
  ROUND, dashRange, inRange, monthLabel, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus,
} = require('../utils/accounts');

const router = express.Router();
router.use(requireAuth);

router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Office & Expenses', 'view'));

// ---------------------------------------------------------------------------
// OFFICE EXPENDITURE
// The accounting application's own vocabulary, kept literally:
//   base   — the bill amount before GST
//   gst    — GST paid to the vendor; input credit, never a cost
//   tds    — TDS we held back from the vendor and deposit on their behalf
//   net    — base + gst − tds, which is what actually leaves the bank
// Profit & Loss on an accrual basis uses `base` (GST excluded on both sides);
// on a cash basis it uses `net` of the bills actually settled.
// ---------------------------------------------------------------------------
const EXP_FREQ = ['Monthly', 'Quarterly', '3 Times a Year', 'Half-Yearly', 'Yearly', 'One-Time'];
const EXP_MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card'];
const EXP_STATUS = ['Paid', 'Pending'];
const EXP_TYPES = ['Goods', 'Service'];
const GST_TREAT = ['Registered Business - Regular', 'Registered Business - Composition',
  'Unregistered Business', 'Consumer', 'Overseas', 'Special Economic Zone', 'Deemed Export',
  'Tax Deductor', 'SEZ Developer'];
// The rates the form offers. Nothing here is ever assumed on a bill — the rate
// and the money both come off the record.
const GST_RATES = [0, 5, 12, 18, 28];
const TDS_RATES = [1, 2, 10];
const GROUP_BY = [['month', 'Month'], ['vendor', 'Paid to'], ['cat', 'Category'],
  ['status', 'Paid / pending'], ['none', 'No grouping — every bill']];
const PROOF_FILTERS = [['all', 'Everything'], ['file', 'Bill attached'], ['bank', 'Bank statement'],
  ['none', 'Nothing on file'], ['gstdue', 'Vendor tax invoice still needed']];
// Statutory dates that do not move, shown on the calendar.
const CAL_DUE = [
  { d: 7, t: 'TDS / TCS deposit', s: 'For last month’s deductions' },
  { d: 11, t: 'GSTR-1', s: 'Outward supplies, monthly filers' },
  { d: 15, t: 'PF (ECR) and ESI', s: 'Contributions for last month' },
  { d: 20, t: 'GSTR-3B', s: 'Summary return and tax payment, monthly filers' },
  { d: 25, t: 'PMT-06', s: 'QRMP filers only' },
];
// Salary, PF, ESI, PT and TDS carry no GST — a nil GST figure on those is right,
// so they are never reported as "GST probably missing".
const GST_NA = /^(salary|salaries|wages|pf|epf|esi|esic|pt|professional tax|tds|income tax|advance tax|bank charges|interest|stipend)$/i;
// "TDS" is both a category of bill and a column on every bill, and the two mean
// opposite things.
const TAX_CATS = /^(tds|gst|pf|esi|pt|professional tax|income tax|advance tax)$/i;

const FREQ_MONTHS = {
  Monthly: 1, Quarterly: 3, '3 Times a Year': 4, 'Half-Yearly': 6, Yearly: 12, 'One-Time': 12,
  // the labels an older row may still carry
  'Half-yearly': 6, 'One-time': 12,
};
// The application calls an unpaid bill "Pending"; the column has always stored
// "Unpaid", so the label is translated on the way out and on the way in rather
// than rewriting rows.
const PENDING_LABEL = (paidStatus) => (paidStatus === 'Unpaid' ? 'Pending' : 'Paid');
const PENDING_STORE = (label) => ((label === 'Pending' || label === 'Unpaid') ? 'Unpaid' : 'Paid');

const todayIso = () => new Date().toISOString().slice(0, 10);

function monthsCoveredOf(e) {
  const n = Number(e.monthsCovered);
  if (n > 0) return Math.round(n);
  return FREQ_MONTHS[e.frequency] || 1;
}

// What is on file behind a payment. A bill filed off the bank statement already
// carries the line that paid it, so the statement IS the proof of payment. The
// one thing a statement line cannot prove is input GST: for that the vendor's
// own tax invoice is still needed.
function proofKindOf(e, gst) {
  if (e.proofName) return 'file';
  if (e.bankTxnId) return gst > 0.5 ? 'gstdue' : 'bank';
  return 'none';
}

function decorate(e) {
  const gross = ROUND(Number(e.monthlyAmount || 0));
  const gst = ROUND(Number(e.gstAmount || 0));
  const tds = ROUND(Number(e.tdsAmount || 0));
  const base = ROUND(gross - gst);
  const months = monthsCoveredOf(e);
  // What actually leaves the bank: the bill including GST, less the TDS we keep
  // back and deposit ourselves.
  const net = ROUND(base + gst - tds);
  const pending = e.paidStatus === 'Unpaid';
  const due = e.dueDate || e.expenseDate || null;
  const daysPending = pending && due
    ? Math.round((Date.now() - new Date(`${due}T00:00:00`).getTime()) / 86400000)
    : null;
  // The rate is reported from the record. Where an older row stored only the
  // money, the rate it implies is derived from that same row — never assumed.
  const gstRate = e.gstRatePct != null ? Number(e.gstRatePct)
    : (base > 0 && gst > 0 ? ROUND((gst / base) * 100) : 0);
  const tdsRate = e.tdsRatePct != null ? Number(e.tdsRatePct)
    : (base > 0 && tds > 0 ? ROUND((tds / base) * 100) : 0);
  return {
    ...e,
    gross,
    base,
    gst,
    tds,
    gstRate,
    tdsRate,
    afterGst: ROUND(base + gst),
    net,
    // The cost of doing business, GST excluded on both sides — what accrual
    // profit is measured against.
    costExGst: base,
    monthsCovered: months,
    perMonth: ROUND(net / months),
    pending,
    daysPending,
    overdue: pending && daysPending != null && daysPending > 0,
    paidValue: pending ? 0 : net,
    pendingValue: pending ? net : 0,
    statusLabel: PENDING_LABEL(e.paidStatus),
    entryKind: e.entryKind || 'expense',
    proofKind: proofKindOf(e, gst),
    hasProof: !!(e.proofName || e.bankTxnId),
    month: (e.expenseDate || '').slice(0, 7) || null,
    dueOn: due,
  };
}

// A bill's cost spread over the months it covers, starting at its own month.
function amortisedFor(rows, mk) {
  let total = 0;
  rows.forEach((r) => {
    if (!r.month) return;
    const start = new Date(`${r.month}-01`);
    for (let i = 0; i < r.monthsCovered; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (key === mk) total += r.perMonth;
    }
  });
  return ROUND(total);
}

function aggExpenses(list) {
  return {
    n: list.length,
    base: ROUND(list.reduce((s, r) => s + r.base, 0)),
    gst: ROUND(list.reduce((s, r) => s + r.gst, 0)),
    tds: ROUND(list.reduce((s, r) => s + r.tds, 0)),
    net: ROUND(list.reduce((s, r) => s + r.net, 0)),
    afterGst: ROUND(list.reduce((s, r) => s + r.afterGst, 0)),
    monthly: ROUND(list.reduce((s, r) => s + r.perMonth, 0)),
    paid: ROUND(list.filter((r) => !r.pending).reduce((s, r) => s + r.net, 0)),
    pendingValue: ROUND(list.filter((r) => r.pending).reduce((s, r) => s + r.net, 0)),
    categories: [...new Set(list.map((r) => r.category).filter(Boolean))].length,
  };
}

// Who the money was paid to, and what is still missing behind it.
function payeeRows(list) {
  const m = new Map();
  list.forEach((r) => {
    const k = String(r.vendor || '').trim() || `— ${r.category || 'unnamed'} —`;
    const o = m.get(k) || { name: k, n: 0, base: 0, gst: 0, tds: 0, net: 0, noBill: 0, last: null };
    o.n += 1; o.base = ROUND(o.base + r.base); o.gst = ROUND(o.gst + r.gst);
    o.tds = ROUND(o.tds + r.tds); o.net = ROUND(o.net + r.net);
    if (!r.hasProof) o.noBill += 1;
    if (!o.last || String(r.expenseDate || '') > o.last) o.last = r.expenseDate;
    m.set(k, o);
  });
  return [...m.values()].sort((a, b) => b.net - a.net);
}

const vendorKeyOf = (r) => String(r.vendor || '').trim() || `— ${r.category || 'unnamed'} —`;

// PF for one month can be paid a few days late, so a window rather than a date.
const DUP_DAYS = 12;
const daysBetween = (a, b) => Math.abs(Math.round(
  (new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime()) / 86400000,
));

// The same payment filed twice: same category, same amount, dates within the
// window. Nothing is removed automatically — the screen asks first.
function dupeGroups(list) {
  const by = new Map();
  list.forEach((r) => {
    const k = `${String(r.category || '').trim().toLowerCase()}|${Math.round(r.net)}`;
    by.set(k, [...(by.get(k) || []), r]);
  });
  const out = [];
  by.forEach((rowsIn) => {
    const rows = rowsIn.slice().sort((a, b) => String(a.expenseDate || '').localeCompare(String(b.expenseDate || '')));
    if (rows.length < 2) return;
    let cur = [rows[0]];
    const push = (c) => { if (c.length > 1) out.push(c); };
    for (let i = 1; i < rows.length; i += 1) {
      const gap = (cur[0].expenseDate && rows[i].expenseDate)
        ? daysBetween(cur[0].expenseDate, rows[i].expenseDate) : 0;
      if (gap <= DUP_DAYS) cur.push(rows[i]); else { push(cur); cur = [rows[i]]; }
    }
    push(cur);
  });
  // The one worth keeping: a real bill first, then a statement line, then the oldest.
  return out.map((c) => ({
    key: `${c[0].category || '—'} · ₹${Math.round(c[0].net).toLocaleString('en-IN')}`,
    category: c[0].category || '—',
    amount: c[0].net,
    rows: c,
    extra: ROUND(c[0].net * (c.length - 1)),
    extraGst: ROUND(c[0].gst * (c.length - 1)),
    keep: (c.find((x) => x.proofName) || c.find((x) => x.bankTxnId) || c[0]).id,
  })).sort((a, b) => b.extra - a.extra || b.rows.length - a.rows.length);
}

async function officeScope(query) {
  const range = dashRange(query.period);
  const [expenses, invoices, payments] = await Promise.all([
    prisma.officeExpense.findMany({ orderBy: [{ expenseDate: 'desc' }, { category: 'asc' }] }),
    prisma.invoice.findMany({ include: { client: true } }),
    prisma.invoicePayment.findMany({ include: { invoice: { include: { client: true } } } }),
  ]);
  // A hand loan or the owner's own money is not a cost — it stays out of
  // profit and out of GST, exactly as the accounting application has it.
  const all = expenses.map(decorate).filter((r) => r.entryKind !== 'hand');
  const hand = expenses.map(decorate).filter((r) => r.entryKind === 'hand');
  const live = invoices.filter((i) => deriveInvoiceStatus(i) !== 'Cancelled');
  return {
    range,
    all,
    hand,
    inPeriod: all.filter((r) => range.all || inRange(r.expenseDate, range)),
    invoices: live,
    invoicesInPeriod: live.filter((i) => range.all || inRange(i.invoiceDate, range)),
    payments,
  };
}

// GST both ways — what clients paid us against what we paid vendors.
function gstBothWays(invoicesInPeriod, expensesInPeriod) {
  const out = ROUND(invoicesInPeriod.reduce((s, i) => s + Number(i.gst || 0), 0));
  const outRec = ROUND(invoicesInPeriod.reduce((s, i) => {
    const total = invoiceTotal(i);
    const share = total > 0 ? Math.min(1, Number(i.receivedAmount || 0) / total) : 0;
    return s + Number(i.gst || 0) * share;
  }, 0));
  const inp = ROUND(expensesInPeriod.reduce((s, r) => s + r.gst, 0));
  return { out, outRec, inp, net: ROUND(out - inp), pendingGst: ROUND(out - outRec) };
}

function applyBillFilters(list, q) {
  let out = list;
  if (q.category && q.category !== 'All') out = out.filter((r) => r.category === q.category);
  if (q.vendor && q.vendor !== 'All') out = out.filter((r) => vendorKeyOf(r) === q.vendor);
  if (q.month && q.month !== 'All') out = out.filter((r) => r.month === q.month);
  if (q.status && q.status !== 'All') out = out.filter((r) => r.statusLabel === q.status);
  if (q.mode && q.mode !== 'All') out = out.filter((r) => (r.paymentMode || '') === q.mode);
  if (q.gst && q.gst !== 'All') out = out.filter((r) => ((q.gst === 'Yes') === (r.gst > 0.5)));
  if (q.noGstin === 'true' || q.noGstin === true) {
    out = out.filter((r) => r.gst > 0.5 && String(r.vendorGstin || '').trim().length < 10);
  }
  const term = String(q.q || '').trim().toLowerCase();
  if (term) {
    out = out.filter((r) => [r.category, r.description, r.vendor, r.billNumber, r.remarks, r.approvedBy]
      .join(' ').toLowerCase().includes(term));
  }
  return out;
}

router.get('/', async (req, res) => {
  const where = {};
  if (req.query.category) where.category = req.query.category;
  if (req.query.location) where.location = req.query.location;
  const expenses = await prisma.officeExpense.findMany({ where, orderBy: [{ expenseDate: 'desc' }, { category: 'asc' }] });
  let rows = expenses.map(decorate);
  if (req.query.month) rows = rows.filter((r) => r.month === req.query.month);
  res.json(rows);
});

// Office & Business: the category and month summary, the profit & loss and the
// GST position — GST charged to clients against GST paid to vendors.
router.get('/summary', async (req, res) => {
  const [expenses, invoices] = await Promise.all([
    prisma.officeExpense.findMany(),
    prisma.invoice.findMany({ where: { status: { not: 'Cancelled' } } }),
  ]);
  const rows = expenses.map(decorate).filter((r) => r.entryKind !== 'hand');
  const month = req.query.month || null;
  const inScope = month ? rows.filter((r) => r.month === month) : rows;
  const invoicesInScope = month ? invoices.filter((i) => String(i.invoiceDate).slice(0, 7) === month) : invoices;

  const group = (rowsIn, keyOf) => {
    const map = new Map();
    rowsIn.forEach((r) => {
      const k = keyOf(r) || '—';
      const cur = map.get(k) || { key: k, count: 0, gross: 0, gst: 0, net: 0 };
      cur.count += 1;
      cur.gross = ROUND(cur.gross + r.gross);
      cur.gst = ROUND(cur.gst + r.gst);
      cur.net = ROUND(cur.net + r.net);
      map.set(k, cur);
    });
    return [...map.values()].sort((a, b) => b.net - a.net);
  };

  // Income is taken net of GST: GST charged is collected for the government,
  // not earned, and TDS is deducted but still counts as income billed.
  const incomeNet = ROUND(invoicesInScope.reduce((s, i) => s + Number(i.amount || 0), 0));
  const gstCharged = ROUND(invoicesInScope.reduce((s, i) => s + Number(i.gst || 0), 0));
  const gstPaid = ROUND(inScope.reduce((s, r) => s + r.gst, 0));
  const spendNet = ROUND(inScope.reduce((s, r) => s + r.costExGst, 0));

  res.json({
    month,
    byCategory: group(inScope, (r) => r.category),
    byMonth: group(rows.filter((r) => r.month), (r) => r.month).sort((a, b) => String(a.key).localeCompare(String(b.key))),
    byLocation: group(inScope, (r) => r.location || 'All'),
    profitAndLoss: {
      incomeNet,
      spendNet,
      profit: ROUND(incomeNet - spendNet),
      marginPct: incomeNet > 0 ? ROUND(((incomeNet - spendNet) / incomeNet) * 100) : 0,
    },
    gstPosition: {
      charged: gstCharged,
      paid: gstPaid,
      // Positive means GST is owed to the government; negative is credit carried.
      payable: ROUND(gstCharged - gstPaid),
    },
    unpaidCount: inScope.filter((r) => r.paidStatus === 'Unpaid').length,
    unpaidValue: ROUND(inScope.filter((r) => r.paidStatus === 'Unpaid').reduce((s, r) => s + r.gross, 0)),
  });
});

// ---------------------------------------------------------------------------
// Office & Accounts — the six tabs, each on its own endpoint so the numbers on
// a tab are computed once rather than re-derived in the browser.
// ---------------------------------------------------------------------------

// "Bills & expenses" — the KPI strip, the filter option lists and the one
// grouped table.
router.get('/bills', async (req, res) => {
  const {
    range, all, inPeriod, invoicesInPeriod,
  } = await officeScope(req.query);
  const list = applyBillFilters(inPeriod, req.query);

  const t = aggExpenses(list);
  const periodTotals = aggExpenses(inPeriod);
  // GST payable and profit compare the WHOLE period — a category filter must
  // not make it look as though we paid more GST than we charged.
  const gb = gstBothWays(invoicesInPeriod, inPeriod);
  const income = ROUND(invoicesInPeriod.reduce((s, i) => s + Number(i.amount || 0), 0));
  const cashIn = ROUND(invoicesInPeriod.reduce((s, i) => s + Number(i.receivedAmount || 0), 0));

  // The category and vendor pickers follow each other: pick a category and only
  // its vendors are left at the top, pick a vendor and only the categories it
  // bills for are. Nothing is ever removed from a list, only re-ordered.
  const byVendor = (req.query.vendor && req.query.vendor !== 'All')
    ? inPeriod.filter((r) => vendorKeyOf(r) === req.query.vendor) : inPeriod;
  const byCat = (req.query.category && req.query.category !== 'All')
    ? inPeriod.filter((r) => r.category === req.query.category) : inPeriod;
  const fitCats = [...new Set(byVendor.map((r) => r.category).filter(Boolean))].sort();
  const fitVendors = [...new Set(byCat.map((r) => String(r.vendor || '').trim()).filter(Boolean))].sort();
  const everyCat = [...new Set(inPeriod.map((r) => r.category).filter(Boolean))].sort();
  const everyVendor = [...new Set(inPeriod.map((r) => String(r.vendor || '').trim()).filter(Boolean))].sort();

  // ---- the one grouped table -------------------------------------------
  const mode = GROUP_BY.some(([k]) => k === req.query.groupBy) ? req.query.groupBy : 'month';
  const incOf = new Map(); const gstOutOf = new Map();
  invoicesInPeriod.forEach((i) => {
    const k = String(i.invoiceDate || '').slice(0, 7) || '—';
    incOf.set(k, ROUND((incOf.get(k) || 0) + Number(i.amount || 0)));
    gstOutOf.set(k, ROUND((gstOutOf.get(k) || 0) + Number(i.gst || 0)));
  });
  const keyOf = (r) => (mode === 'month' ? (r.month || '—')
    : mode === 'vendor' ? vendorKeyOf(r)
      : mode === 'cat' ? (r.category || '—')
        : (r.pending ? 'Pending to pay' : 'Paid'));
  const groupMap = new Map();
  list.forEach((r) => {
    const k = keyOf(r);
    const g = groupMap.get(k) || {
      key: k, label: mode === 'month' ? monthLabel(k) : k,
      n: 0, base: 0, gst: 0, tds: 0, net: 0, paid: 0, pending: 0, noBill: 0, noGstin: 0, rows: [],
    };
    g.n += 1; g.base = ROUND(g.base + r.base); g.gst = ROUND(g.gst + r.gst);
    g.tds = ROUND(g.tds + r.tds); g.net = ROUND(g.net + r.net);
    if (r.pending) g.pending = ROUND(g.pending + r.net); else g.paid = ROUND(g.paid + r.net);
    if (!r.hasProof) g.noBill += 1;
    if (r.gst > 0.5 && String(r.vendorGstin || '').trim().length < 10) g.noGstin += 1;
    g.rows.push(r);
    groupMap.set(k, g);
  });
  const groups = [...groupMap.values()]
    .sort((a, b) => (mode === 'month' ? String(a.key).localeCompare(String(b.key)) : b.net - a.net))
    .map((g) => {
      g.rows.sort((a, b) => String(b.expenseDate || '').localeCompare(String(a.expenseDate || '')));
      if (mode === 'month') {
        g.income = ROUND(incOf.get(g.key) || 0);
        g.pl = ROUND(g.income - g.net);
        g.gstPayable = ROUND((gstOutOf.get(g.key) || 0) - g.gst);
      }
      return g;
    });
  const groupTotals = {
    n: t.n, base: t.base, gst: t.gst, tds: t.tds, net: t.net, paid: t.paid, pending: t.pendingValue,
    income: mode === 'month'
      ? ROUND(groups.reduce((s, g) => s + (g.income || 0), 0))
      : income,
    gstOut: mode === 'month'
      ? ROUND(groups.reduce((s, g) => s + (gstOutOf.get(g.key) || 0), 0))
      : gb.out,
  };
  groupTotals.pl = ROUND(groupTotals.income - t.net);
  groupTotals.gstPayable = ROUND(groupTotals.gstOut - t.gst);

  const proofs = { file: 0, bank: 0, gstdue: 0, none: 0 };
  all.forEach((r) => { proofs[r.proofKind] += 1; });

  // What the pick is worth on its own — a figure is never simply hidden.
  const soloSource = (req.query.category && req.query.category !== 'All')
    ? inPeriod.filter((r) => r.category === req.query.category)
    : ((req.query.vendor && req.query.vendor !== 'All')
      ? inPeriod.filter((r) => vendorKeyOf(r) === req.query.vendor) : []);

  res.json({
    period: { sel: req.query.period || null, ...range },
    groupBy: mode,
    groups,
    groupTotals,
    rows: list.slice().sort((a, b) => String(b.expenseDate || '').localeCompare(String(a.expenseDate || ''))),
    totals: t,
    periodTotals,
    payees: payeeRows(list),
    filtered: list.length !== inPeriod.length,
    proofs,
    taxCatNote: TAX_CATS.test(String(req.query.category || '').trim())
      ? String(req.query.category).trim().toUpperCase() : null,
    solo: soloSource.length ? { name: req.query.category && req.query.category !== 'All' ? req.query.category : req.query.vendor, ...aggExpenses(soloSource) } : null,
    gst: {
      out: gb.out,
      outReceived: gb.outRec,
      pending: gb.pendingGst,
      input: gb.inp,
      net: gb.net,
      unclaimable: ROUND(inPeriod.filter((r) => r.gst > 0.5 && String(r.vendorGstin || '').trim().length < 10).reduce((s, r) => s + r.gst, 0)),
      unclaimableCount: inPeriod.filter((r) => r.gst > 0.5 && String(r.vendorGstin || '').trim().length < 10).length,
    },
    profit: { income, spend: periodTotals.net, pl: ROUND(income - periodTotals.net) },
    cashProfit: { cashIn, paid: periodTotals.paid, pl: ROUND(cashIn - periodTotals.paid) },
    outsidePeriod: all.length - inPeriod.length,
    options: {
      categories: everyCat,
      fitCategories: fitCats,
      vendors: everyVendor,
      fitVendors,
      months: [...new Set(inPeriod.map((r) => r.month).filter(Boolean))].sort()
        .map((mk) => [mk, monthLabel(mk)]),
      statuses: EXP_STATUS,
      gst: ['Yes', 'No'],
      frequencies: EXP_FREQ,
      modes: EXP_MODES,
      supplyTypes: EXP_TYPES,
      gstTreatments: GST_TREAT,
      gstRates: GST_RATES,
      tdsRates: TDS_RATES,
      groupBy: GROUP_BY,
    },
  });
});

// "GST position" — what we charged clients against what we paid vendors, the
// way GSTR-3B reads it: month by month, output against input.
router.get('/gst', async (req, res) => {
  const { range, inPeriod, invoicesInPeriod } = await officeScope(req.query);
  const months = [...new Set([
    ...invoicesInPeriod.map((i) => String(i.invoiceDate || '').slice(0, 7)),
    ...inPeriod.map((r) => r.month),
  ].filter(Boolean))].sort();

  const rows = months.map((mk) => {
    const inv = invoicesInPeriod.filter((i) => String(i.invoiceDate || '').slice(0, 7) === mk);
    const exp = inPeriod.filter((r) => r.month === mk);
    const output = ROUND(inv.reduce((s, i) => s + Number(i.gst || 0), 0));
    const input = ROUND(exp.reduce((s, r) => s + r.gst, 0));
    return {
      month: mk,
      label: monthLabel(mk),
      outBase: ROUND(inv.reduce((s, i) => s + Number(i.amount || 0), 0)),
      output,
      // Only the purchases that actually carry GST — the reference app summed
      // every bill here and called it "purchases with GST", which overstated
      // the taxable value on the filing card.
      inBase: ROUND(exp.filter((r) => r.gst > 0).reduce((s, r) => s + r.base, 0)),
      input,
      net: ROUND(output - input),
      nOut: inv.length,
      nIn: exp.filter((r) => r.gst > 0).length,
    };
  });
  const output = ROUND(rows.reduce((s, r) => s + r.output, 0));
  const input = ROUND(rows.reduce((s, r) => s + r.input, 0));
  const outBase = ROUND(rows.reduce((s, r) => s + r.outBase, 0));
  const inBase = ROUND(rows.reduce((s, r) => s + r.inBase, 0));

  // Input credit by vendor.
  const V = new Map();
  inPeriod.forEach((r) => {
    const k = String(r.vendor || '').trim() || '(vendor name not entered)';
    const v = V.get(k) || { key: k, n: 0, base: 0, gst: 0, rates: [], cats: [], bills: 0, named: !!String(r.vendor || '').trim() };
    v.n += 1; v.base = ROUND(v.base + r.base); v.gst = ROUND(v.gst + r.gst);
    if (r.gstRate && !v.rates.includes(r.gstRate)) v.rates.push(r.gstRate);
    if (r.category && !v.cats.includes(r.category)) v.cats.push(r.category);
    if (r.billNumber) v.bills += 1;
    V.set(k, v);
  });
  const vendors = [...V.values()].sort((a, b) => b.gst - a.gst || b.base - a.base);

  // Expenses with no GST recorded, where GST probably applies.
  const missing = inPeriod.filter((r) => r.gst === 0 && !GST_NA.test(String(r.category || '').trim()));
  const missByCat = new Map();
  missing.forEach((r) => {
    const k = r.category || '—';
    const c = missByCat.get(k) || { key: k, n: 0, base: 0 };
    c.n += 1; c.base = ROUND(c.base + r.base);
    missByCat.set(k, c);
  });

  const withGst = inPeriod.filter((r) => r.gst > 0);
  const noGstin = inPeriod.filter((r) => r.gst > 0.5 && String(r.vendorGstin || '').trim().length < 10);
  // The effective output rate is what the invoices actually carry — it is
  // computed, never assumed to be 18%.
  const outRatePct = outBase > 0 ? ROUND((output / outBase) * 100) : 0;

  res.json({
    period: { sel: req.query.period || null, ...range },
    rows,
    totals: {
      output, input, net: ROUND(output - input), outBase, inBase, outRatePct,
    },
    vendors,
    purchases: withGst
      .slice()
      .sort((a, b) => String(b.expenseDate || '').localeCompare(String(a.expenseDate || '')))
      .map((r) => ({
        id: r.id, month: r.month, date: r.expenseDate, vendor: r.vendor, category: r.category,
        bill: r.billNumber, base: r.base, rate: r.gstRate, gst: r.gst, total: r.afterGst, paid: !r.pending,
      })),
    filing: {
      billsWithGst: withGst.length,
      billNumbersOnFile: withGst.filter((r) => r.billNumber).length,
      vendorNamesOnFile: withGst.filter((r) => String(r.vendor || '').trim()).length,
      cashToPay: ROUND(Math.max(0, output - input)),
    },
    missing: { n: missing.length, base: ROUND(missing.reduce((s, r) => s + r.base, 0)), cats: [...missByCat.values()].sort((a, b) => b.base - a.base) },
    unclaimable: { count: noGstin.length, value: ROUND(noGstin.reduce((s, r) => s + r.gst, 0)), rows: noGstin },
  });
});

// "Profit & Loss" — on accrual (work done, bills raised) or on cash (money in
// and out of the bank), month by month with a running total.
router.get('/pnl', async (req, res) => {
  const basis = req.query.basis === 'cash' ? 'cash' : 'accrual';
  const {
    range, all, inPeriod, invoices, invoicesInPeriod,
  } = await officeScope(req.query);
  const months = [...new Set([
    ...invoicesInPeriod.map((i) => String(i.invoiceDate || '').slice(0, 7)),
    ...inPeriod.map((r) => r.month),
  ].filter(Boolean))].sort();

  const rowFor = (mk, b) => {
    const inv = invoicesInPeriod.filter((i) => String(i.invoiceDate || '').slice(0, 7) === mk);
    const exp = inPeriod.filter((r) => r.month === mk);
    const income = b === 'accrual'
      ? ROUND(inv.reduce((s, i) => s + Number(i.amount || 0), 0))
      : ROUND(inv.reduce((s, i) => s + Number(i.receivedAmount || 0), 0));
    // Accrual is measured GST-excluded on both sides; cash is what actually
    // moved, which does include the GST paid across.
    const spend = b === 'accrual'
      ? ROUND(exp.reduce((s, r) => s + r.costExGst, 0))
      : ROUND(exp.filter((r) => !r.pending).reduce((s, r) => s + r.net, 0));
    return {
      month: mk, label: monthLabel(mk), joins: inv.length, entries: exp.length,
      income, spend, pl: ROUND(income - spend),
    };
  };

  let cum = 0;
  const rows = months.map((mk) => rowFor(mk, basis)).map((r) => {
    cum = ROUND(cum + r.pl);
    return {
      ...r, cum, noExp: r.entries === 0 && r.income > 0, noInc: r.joins === 0 && r.spend > 0,
    };
  }).map((r) => ({ ...r, matched: !r.noExp && !r.noInc }));

  const sum = (list) => list.reduce((a, r) => ({
    income: ROUND(a.income + r.income), spend: ROUND(a.spend + r.spend), pl: ROUND(a.pl + r.pl),
    joins: a.joins + r.joins, entries: a.entries + r.entries,
  }), { income: 0, spend: 0, pl: 0, joins: 0, entries: 0 });
  const totals = sum(rows);
  const matched = rows.filter((r) => r.matched);
  const mt = {
    ...sum(matched),
    from: matched.length ? matched[0].month : null,
    to: matched.length ? matched[matched.length - 1].month : null,
    months: matched.length,
  };

  const accrualRows = months.map((mk) => rowFor(mk, 'accrual'));
  const cashRows = months.map((mk) => rowFor(mk, 'cash'));
  const accrual = sum(accrualRows);
  const cash = sum(cashRows);

  // Money held for someone else — never profit, never loss.
  const gstOut = ROUND(invoices.reduce((s, i) => s + Number(i.gst || 0), 0));
  const gstIn = ROUND(all.reduce((s, r) => s + r.gst, 0));
  const tdsByClients = ROUND(invoices.reduce((s, i) => s + Number(i.tds || 0), 0));
  const tdsByUs = ROUND(all.reduce((s, r) => s + r.tds, 0));
  const receivable = ROUND(invoices.reduce((s, i) => s + invoiceOutstanding(i), 0));
  const payable = ROUND(all.filter((r) => r.pending).reduce((s, r) => s + r.net, 0));

  const topOf = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([key, value]) => ({ key, value: ROUND(value) }));
  const cliMap = new Map();
  invoices.forEach((i) => {
    const k = i.client?.name || '—';
    cliMap.set(k, (cliMap.get(k) || 0) + Number(i.amount || 0));
  });
  const catMap = new Map();
  all.forEach((r) => {
    const k = r.category || '—';
    catMap.set(k, (catMap.get(k) || 0) + r.base);
  });

  res.json({
    period: { sel: req.query.period || null, ...range },
    basis,
    rows,
    totals,
    matchedTotals: mt,
    accrual: { ...accrual },
    cash: { ...cash },
    receivable,
    payable,
    topClients: topOf(cliMap),
    topCategories: topOf(catMap),
    held: {
      gstOut, gstIn, gstNet: ROUND(gstOut - gstIn), tdsByClients, tdsByUs, receivable, payable, netInflow: ROUND(receivable - payable),
    },
  });
});

// "Category & month summary" — where the money goes, by category and by month,
// on a cash basis against the amortised run-rate.
router.get('/summary-tabs', async (req, res) => {
  const { range, all, inPeriod } = await officeScope(req.query);
  const list = applyBillFilters(inPeriod, req.query);
  const t = aggExpenses(list);

  const cats = new Map();
  list.forEach((r) => {
    const k = r.category || '—';
    const cur = cats.get(k) || { key: k, n: 0, base: 0, gst: 0, tds: 0, net: 0 };
    cur.n += 1; cur.base = ROUND(cur.base + r.base); cur.gst = ROUND(cur.gst + r.gst);
    cur.tds = ROUND(cur.tds + r.tds); cur.net = ROUND(cur.net + r.net);
    cats.set(k, cur);
  });

  const months = [...new Set(all.map((r) => r.month).filter(Boolean))].sort();
  const monthRows = months.map((mk) => {
    const rs = all.filter((r) => r.month === mk);
    const a = aggExpenses(rs);
    return {
      month: mk, label: monthLabel(mk), n: a.n,
      cash: ROUND(rs.filter((r) => !r.pending).reduce((s, r) => s + r.net, 0)),
      amortised: amortisedFor(all, mk),
      gst: a.gst, tds: a.tds, pending: a.pendingValue,
    };
  });

  // The summary carries the same filter bar as the bills register, so the
  // option lists come back with it.
  const byVendor = (req.query.vendor && req.query.vendor !== 'All')
    ? inPeriod.filter((r) => vendorKeyOf(r) === req.query.vendor) : inPeriod;
  const byCat = (req.query.category && req.query.category !== 'All')
    ? inPeriod.filter((r) => r.category === req.query.category) : inPeriod;

  res.json({
    period: { sel: req.query.period || null, ...range },
    totals: t,
    gstEntries: list.filter((r) => r.gst > 0.5).length,
    tdsEntries: list.filter((r) => r.tds > 0.5).length,
    byCategory: [...cats.values()].sort((a, b) => b.net - a.net),
    byMonth: monthRows,
    filtered: list.length !== inPeriod.length,
    options: {
      categories: [...new Set(inPeriod.map((r) => r.category).filter(Boolean))].sort(),
      fitCategories: [...new Set(byVendor.map((r) => r.category).filter(Boolean))].sort(),
      vendors: [...new Set(inPeriod.map((r) => String(r.vendor || '').trim()).filter(Boolean))].sort(),
      fitVendors: [...new Set(byCat.map((r) => String(r.vendor || '').trim()).filter(Boolean))].sort(),
      statuses: EXP_STATUS,
      gst: ['Yes', 'No'],
      modes: EXP_MODES,
    },
  });
});

// "🗓 Calendar" — the month laid out day by day: what went out, what came in,
// what is still due, and the statutory dates that do not move. Built from the
// same expense and payment records as every other screen.
router.get('/calendar', async (req, res) => {
  const { all, payments } = await officeScope({ period: 'all' });
  const now = new Date();
  const mk = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
    ? req.query.month
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const day = new Map();
  const put = (iso, kind, item) => {
    if (!iso || String(iso).slice(0, 7) !== mk) return;
    const d = day.get(iso) || {
      date: iso, out: 0, in: 0, due: 0, paidN: 0, dueN: 0, inN: 0, items: [],
    };
    if (kind === 'out') { d.out = ROUND(d.out + item.amount); d.paidN += 1; }
    if (kind === 'due') { d.due = ROUND(d.due + item.amount); d.dueN += 1; }
    if (kind === 'in') { d.in = ROUND(d.in + item.amount); d.inN += 1; }
    d.items.push({ kind, ...item });
    day.set(iso, d);
  };

  all.forEach((r) => {
    const item = {
      id: r.id, t: r.category || '—', sub: r.vendor || r.description || '',
      amount: r.net, gst: r.gst, what: 'expense',
    };
    if (r.pending) put(r.dueOn, 'due', { ...item, overdue: !!r.overdue });
    else put(r.expenseDate, 'out', item);
  });
  payments.forEach((p) => {
    put(p.date, 'in', {
      id: p.id,
      t: p.invoice?.client?.name || 'Receipt',
      sub: `${p.invoice?.invoiceNumber || ''}${p.method ? ` · ${p.method}` : ''}`.trim(),
      amount: ROUND(Number(p.amount || 0)),
      what: 'receipt',
    });
  });

  const days = [...day.values()].map((d) => {
    d.items.sort((a, b) => b.amount - a.amount);
    return d;
  });
  const totals = days.reduce((a, d) => ({
    out: ROUND(a.out + d.out), in: ROUND(a.in + d.in), due: ROUND(a.due + d.due),
    paidN: a.paidN + d.paidN, dueN: a.dueN + d.dueN, inN: a.inN + d.inN,
  }), {
    out: 0, in: 0, due: 0, paidN: 0, dueN: 0, inN: 0,
  });

  res.json({
    month: mk,
    label: monthLabel(mk),
    today: todayIso(),
    days,
    totals: { ...totals, net: ROUND(totals.in - totals.out) },
    statutory: CAL_DUE,
  });
});

// "📎 Proofs & bill files" — what is on file behind every office payment.
router.get('/proofs', async (req, res) => {
  const { all } = await officeScope({ period: 'all' });
  const scopeMode = req.query.scopeMode || null;
  const scopeKey = req.query.scopeKey || null;
  const inScope = (r) => {
    if (!scopeMode || !scopeKey) return true;
    if (scopeMode === 'month') return (r.month || '—') === scopeKey;
    if (scopeMode === 'vendor') return vendorKeyOf(r) === scopeKey;
    if (scopeMode === 'cat') return (r.category || '—') === scopeKey;
    if (scopeMode === 'status') return (r.pending ? 'Pending to pay' : 'Paid') === scopeKey;
    return true;
  };
  const scoped = all.filter(inScope);
  const n = (k) => scoped.filter((r) => r.proofKind === k).length;

  const f = req.query.filter || 'all';
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = scoped
    .filter((r) => (f === 'all'
      || (f === 'gstdue' ? r.proofKind === 'gstdue'
        : (f === 'bank' ? (r.proofKind === 'bank' || r.proofKind === 'gstdue') : r.proofKind === f))))
    .filter((r) => !q || [r.category, r.vendor, r.billNumber, r.description, r.remarks, r.paymentMode]
      .join(' ').toLowerCase().includes(q))
    .sort((a, b) => String(b.expenseDate || '').localeCompare(String(a.expenseDate || '')) || b.net - a.net);

  const gstAtRisk = ROUND(scoped.filter((r) => r.proofKind === 'none' || r.proofKind === 'gstdue')
    .reduce((s, r) => s + r.gst, 0));

  // Two bills with the same category, the same amount and dates within twelve
  // days are almost always the same payment entered twice.
  const dupes = dupeGroups(scoped);
  const dupeTotals = {
    groups: dupes.length,
    copies: dupes.reduce((s, c) => s + c.rows.length - 1, 0),
    money: ROUND(dupes.reduce((s, c) => s + c.extra, 0)),
    gst: ROUND(dupes.reduce((s, c) => s + c.extraGst, 0)),
    days: DUP_DAYS,
  };

  // Every fixable gap on these bills, counted.
  const pick = (fn) => scoped.filter(fn);
  const none = pick((r) => r.proofKind === 'none');
  const taxDue = pick((r) => r.proofKind === 'gstdue');
  const gstNoGstin = pick((r) => r.gst > 0.5 && String(r.vendorGstin || '').trim().length < 10);
  const gstNoBillNo = pick((r) => r.gst > 0.5 && !String(r.billNumber || '').trim());
  const noVendor = pick((r) => !String(r.vendor || '').trim() && r.gst > 0.5);
  const gstOf = (l) => ROUND(l.reduce((s, r) => s + r.gst, 0));
  const fixes = [
    {
      key: 'none', n: none.length, t: 'No bill and no statement line', why: 'Nothing at all behind the payment.', gst: gstOf(none), sev: 'bad', filter: 'none',
    },
    {
      key: 'gstdue', n: taxDue.length, t: 'Vendor tax invoice still to come', why: 'The statement proves the payment; the input GST needs their invoice.', gst: gstOf(taxDue), sev: 'warn', filter: 'gstdue',
    },
    {
      key: 'nogstin', n: gstNoGstin.length, t: 'GST claimed, vendor GSTIN missing', why: 'Without the vendor GSTIN the credit cannot be matched in GSTR-2B.', gst: gstOf(gstNoGstin), sev: 'bad', hint: 'Open the bill and put the vendor GSTIN in. It is the 15-character number on their invoice.', rows: gstNoGstin,
    },
    {
      key: 'nobillno', n: gstNoBillNo.length, t: 'GST claimed, bill number missing', why: 'The return needs the vendor invoice number against each claim.', gst: gstOf(gstNoBillNo), sev: 'warn', hint: 'Open the bill and type the vendor invoice number from their bill.', rows: gstNoBillNo,
    },
    {
      key: 'novendor', n: noVendor.length, t: 'GST claimed, no vendor name', why: 'Nobody to chase the invoice from.', gst: gstOf(noVendor), sev: 'warn', hint: 'Open the bill and name who it was paid to.', rows: noVendor,
    },
  ].filter((i) => i.n);

  res.json({
    scope: scopeMode && scopeKey ? { mode: scopeMode, key: scopeKey, label: scopeMode === 'month' ? monthLabel(scopeKey) : scopeKey } : null,
    filter: f,
    filters: PROOF_FILTERS.map(([k, l]) => ({
      key: k, label: l, n: k === 'all' ? scoped.length : (k === 'bank' ? n('bank') + n('gstdue') : n(k)),
    })),
    counts: {
      all: scoped.length, file: n('file'), bank: n('bank'), gstdue: n('gstdue'), none: n('none'), proved: n('file') + n('bank') + n('gstdue'),
    },
    gstAtRisk,
    gstWaiting: ROUND(scoped.filter((r) => r.proofKind === 'gstdue').reduce((s, r) => s + r.gst, 0)),
    fixes,
    dupes,
    dupeTotals,
    rows,
  });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
function writeFields(body, data) {
  ['category', 'location', 'vendor', 'expenseDate', 'dueDate', 'notes', 'vendorGstin',
    'description', 'billNumber', 'remarks', 'approvedBy', 'sourceState'].forEach((k) => {
    if (body[k] !== undefined) data[k] = body[k] || null;
  });
  if (body.entryKind !== undefined) data.entryKind = body.entryKind === 'hand' ? 'hand' : 'expense';
  if (body.supplyType !== undefined) data.supplyType = EXP_TYPES.includes(body.supplyType) ? body.supplyType : null;
  if (body.gstTreatment !== undefined) data.gstTreatment = GST_TREAT.includes(body.gstTreatment) ? body.gstTreatment : null;
  if (body.gstRatePct !== undefined) data.gstRatePct = body.gstRatePct === '' || body.gstRatePct == null ? null : Number(body.gstRatePct);
  if (body.tdsRatePct !== undefined) data.tdsRatePct = body.tdsRatePct === '' || body.tdsRatePct == null ? null : Number(body.tdsRatePct);
  if (body.frequency !== undefined) data.frequency = EXP_FREQ.includes(body.frequency) ? body.frequency : 'Monthly';
  if (body.monthsCovered !== undefined) data.monthsCovered = Number(body.monthsCovered) > 0 ? Math.round(Number(body.monthsCovered)) : null;
  if (body.paymentMode !== undefined) data.paymentMode = EXP_MODES.includes(body.paymentMode) ? body.paymentMode : 'Bank Transfer';
  if (body.paidStatus !== undefined) data.paidStatus = PENDING_STORE(body.paidStatus);
  if (body.recurring !== undefined) data.recurring = !!body.recurring;
  if (body.bankTxnId !== undefined) data.bankTxnId = body.bankTxnId || null;
  return data;
}

// GST and TDS money is always taken from the record. Where a rate is supplied
// and the amount is not, the amount is computed from that rate — never from a
// default, and never from a hardcoded 18%.
function taxAmounts(body, base) {
  let gst = body.gstAmount !== undefined && body.gstAmount !== '' ? Number(body.gstAmount) : null;
  let tds = body.tdsAmount !== undefined && body.tdsAmount !== '' ? Number(body.tdsAmount) : null;
  if (gst == null && body.gstRatePct != null && body.gstRatePct !== '') gst = ROUND(base * (Number(body.gstRatePct) / 100));
  if (tds == null && body.tdsRatePct != null && body.tdsRatePct !== '') tds = ROUND(base * (Number(body.tdsRatePct) / 100));
  return { gst: gst || 0, tds: tds || 0 };
}

router.post('/', async (req, res) => {
  const {
    category, location, vendor, expenseDate, paidStatus, recurring, notes,
  } = req.body;
  if (!category) return res.status(400).json({ error: 'An expense account is required' });
  // The form asks for the bill amount BEFORE GST, the way the accounting
  // application does; the stored column has always been the gross.
  const base = Number(req.body.baseAmount ?? req.body.monthlyAmount);
  if (!(base > 0)) return res.status(400).json({ error: 'Bill amount must be a positive number' });
  const { gst, tds } = taxAmounts(req.body, base);
  if (gst < 0) return res.status(400).json({ error: 'GST cannot be negative' });
  if (tds < 0 || tds > base + gst) return res.status(400).json({ error: 'TDS cannot be negative or larger than the bill' });

  const data = writeFields(req.body, {
    category,
    location: location || null,
    monthlyAmount: ROUND(base + gst),
    vendor: vendor || null,
    expenseDate: expenseDate || todayIso(),
    gstAmount: ROUND(gst),
    tdsAmount: ROUND(tds),
    paidStatus: PENDING_STORE(paidStatus),
    recurring: recurring === undefined ? true : !!recurring,
    notes: notes || null,
  });
  const expense = await prisma.officeExpense.create({ data });
  await logAudit({
    userId: req.user.id, action: 'Office expense added', entity: 'OfficeExpense', entityId: expense.id, toValue: `${category} — ₹${ROUND(base + gst)}`,
  });
  res.status(201).json(decorate(expense));
});

router.patch('/:id', async (req, res) => {
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const data = writeFields(req.body, {});

  const oldGst = Number(existing.gstAmount || 0);
  const oldBase = ROUND(Number(existing.monthlyAmount || 0) - oldGst);
  const base = req.body.baseAmount !== undefined && req.body.baseAmount !== ''
    ? Number(req.body.baseAmount)
    : (req.body.monthlyAmount !== undefined ? ROUND(Number(req.body.monthlyAmount) - oldGst) : oldBase);
  if (!(base > 0)) return res.status(400).json({ error: 'Bill amount must be a positive number' });

  const touchesTax = ['gstAmount', 'tdsAmount', 'gstRatePct', 'tdsRatePct', 'baseAmount', 'monthlyAmount']
    .some((k) => req.body[k] !== undefined);
  if (touchesTax) {
    const t = taxAmounts(
      {
        gstAmount: req.body.gstAmount !== undefined ? req.body.gstAmount : (req.body.gstRatePct !== undefined ? '' : oldGst),
        tdsAmount: req.body.tdsAmount !== undefined ? req.body.tdsAmount : (req.body.tdsRatePct !== undefined ? '' : Number(existing.tdsAmount || 0)),
        gstRatePct: req.body.gstRatePct,
        tdsRatePct: req.body.tdsRatePct,
      },
      base,
    );
    if (t.gst < 0) return res.status(400).json({ error: 'GST cannot be negative' });
    if (t.tds < 0 || t.tds > base + t.gst) return res.status(400).json({ error: 'TDS cannot be negative or larger than the bill' });
    data.gstAmount = ROUND(t.gst);
    data.tdsAmount = ROUND(t.tds);
    data.monthlyAmount = ROUND(base + t.gst);
  }

  const expense = await prisma.officeExpense.update({ where: { id: existing.id }, data });
  await logAudit({ userId: req.user.id, action: 'Office expense updated', entity: 'OfficeExpense', entityId: expense.id });
  res.json(decorate(expense));
});

// Proof of payment. The bytes are NOT stored — see the note in the report: a
// real implementation needs an object store (S3 / disk) plus a signed-URL
// route. What is kept here is the metadata the register is audited on, so the
// screen can say truthfully what is on file and what is missing.
router.post('/:id/proof', async (req, res) => {
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const name = String(req.body.proofName || '').trim();
  if (!name) return res.status(400).json({ error: 'A file name is required' });
  const expense = await prisma.officeExpense.update({
    where: { id: existing.id },
    data: {
      proofName: name,
      proofMime: req.body.proofMime || null,
      proofSize: Number(req.body.proofSize) > 0 ? Math.round(Number(req.body.proofSize)) : null,
      proofAt: todayIso(),
      proofBy: req.user.name || req.user.email || null,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Office bill proof attached', entity: 'OfficeExpense', entityId: expense.id, toValue: name,
  });
  res.json(decorate(expense));
});

router.delete('/:id/proof', async (req, res) => {
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const expense = await prisma.officeExpense.update({
    where: { id: existing.id },
    data: {
      proofName: null, proofMime: null, proofSize: null, proofAt: null, proofBy: null,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Office bill proof removed', entity: 'OfficeExpense', entityId: expense.id, fromValue: existing.proofName || '—',
  });
  res.json(decorate(expense));
});

router.delete('/:id', async (req, res) => {
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  await prisma.officeExpense.delete({ where: { id: existing.id } });
  await logAudit({
    userId: req.user.id, action: 'Office expense removed', entity: 'OfficeExpense', entityId: existing.id, fromValue: `${existing.category} — ₹${existing.monthlyAmount}`,
  });
  res.json({ ok: true });
});

module.exports = router;
