const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const {
  ROUND, dashRange, inRange, monthLabel, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus,
} = require('../utils/accounts');
// B9.9: income / client billing / GST charged NET of issued credit & debit notes (utils/creditNotes.js decorateNet).
const CNU = require('../utils/creditNotes');

const XLSX = require('xlsx');
const attachments = require('../utils/attachments');
const { roleForProduct, SET, can } = require('../utils/permissions');
const {
  checkGstin, isPan, isTan, isIfsc, isUpi, clean: cleanId, stateName: gstStateName,
} = require('../utils/gstin');

const router = express.Router();
router.use(requireAuth);

router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Office & Expenses', 'view'));

// OFFICE & EXPENSES IS SUPER ADMIN, ADMIN AND ACCOUNTS ONLY.
//
// The matrix above answers "may this login view Office & Expenses", and Role
// Catalog can widen it. This module also carries the business's GSTIN, PAN and
// bank account, so on top of the matrix the login's ACCOUNTS role must be one
// of the accounts desk's own — a Manager, a TL or a Recruiter is refused here
// with a 403 whatever a saved matrix row says.
router.use((req, res, next) => {
  const role = roleForProduct(req.user, 'accounts');
  if (role && SET.ACCOUNTS.includes(role)) return next();
  return res.status(403).json({ error: 'Office & Expenses is open to Super Admin, Admin and Accounts only' });
});

// VIEW != WRITE, AND THE API IS WHAT REFUSES.  (§20)
//
// As in routes/bank.js: the guard above is `view`, which is exactly what a
// view-only Manager (§3) holds on Accounts, and every write below it — record
// an expense, mark one paid, attach or remove a proof, DELETE an expense —
// sat behind that single `view` guard. One guard on every mutating method; a
// read stays a read.
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const requireOfficeWrite = requirePerm('accounts', 'accounts', 'Office & Expenses', 'edit');
router.use((req, res, next) => {
  if (!WRITE_METHODS.includes(req.method)) return next();
  return requireOfficeWrite(req, res, next);
});

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
const EXP_MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Credit Card', 'Debit Card', 'Other'];
// The seven payment modes the one-page Expenses table offers (spec 8), in its
// order. 'Card' stays accepted above because 25 existing bills carry it; it is
// shown as it is and never rewritten.
const LEDGER_MODES = ['Bank Transfer', 'UPI', 'Cash', 'Credit Card', 'Debit Card', 'Cheque', 'Other'];
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
// Statutory dates that do not move, read with the record-based due dates
// (GET /overview and GET /due-dates, which the Dashboard Reminders card reads).
const CAL_DUE = [
  { d: 7, t: 'TDS / TCS deposit', s: 'For last month’s deductions' },
  { d: 11, t: 'GSTR-1', s: 'Outward supplies, monthly filers' },
  { d: 15, t: 'PF (ECR) and ESI', s: 'Contributions for last month' },
  { d: 20, t: 'GSTR-3B', s: 'Summary return and tax payment, monthly filers' },
  { d: 25, t: 'PMT-06', s: 'QRMP filers only' },
];
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

// ---------------------------------------------------------------------------
// APPROVAL LIFECYCLE (spec A)
//   PENDING -> APPROVED -> PAID, or PENDING -> REJECTED (a reason is required).
// paidStatus stays the PAYMENT status and is kept in step with it: only PAID
// is "Paid"; every other state is "Unpaid". A REJECTED bill is out of the
// books — it is left out of every total, GST figure and P&L on this module,
// and is listed only when the Status filter asks for Rejected.
//
// WHO MAY DECIDE. The "Accounts Admin / Approver" is Super Admin or Admin on
// Accounts, or an ACCOUNTANT whose role holds `approve` on
// accounts · Office & Expenses (utils/permissions.js DEFAULT_RULES grants it
// to SET.ACCOUNTS; Role Catalog can take it away). Any Accounts user may add
// and view. Approve / reject / mark paid and editing the category list are
// the approver's.
//
// REIMBURSED (one-page spec, 2026-09-26) is one more final state, added on top:
// a bill someone paid out of their own pocket that the office has since paid
// back. An approver reaches it from APPROVED or PAID ("Mark as Reimbursed").
// It is money out, exactly like PAID: paidStatus "Paid", in every total.
// ---------------------------------------------------------------------------
const APPROVAL = ['PENDING', 'APPROVED', 'PAID', 'REJECTED', 'REIMBURSED'];
const APPROVAL_LABEL = {
  PENDING: 'Pending approval', APPROVED: 'Approved', PAID: 'Paid', REJECTED: 'Rejected', REIMBURSED: 'Reimbursed',
};
const approvalOf = (e) => (APPROVAL.includes(e.approvalStatus) ? e.approvalStatus
  : (e.paidStatus === 'Paid' ? 'PAID' : 'PENDING'));
// spec's paid_by (cash | bank | card), read off the payment mode — UPI,
// cheque and bank transfer all leave the bank account.
const paidByOf = (mode) => {
  const m = String(mode || '').toLowerCase();
  if (m === 'cash') return 'cash';
  if (m === 'card' || m === 'credit card' || m === 'debit card') return 'card';
  return 'bank';
};
const accountsRoleOf = (user) => roleForProduct(user, 'accounts');
const isAdminLike = (user) => ['SUPER_ADMIN', 'ADMIN'].includes(accountsRoleOf(user));
async function isApprover(user) {
  if (isAdminLike(user)) return true;
  if (accountsRoleOf(user) !== 'ACCOUNTANT') return false;
  return can(user, 'accounts', 'accounts', 'Office & Expenses', 'approve');
}
const APPROVER_ONLY = 'Only the Accounts Admin / Approver (Super Admin, Admin, or an Accountant with approve on Office & Expenses) may do this';

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

// A bill's GSTIN is its own, else the vendor master's (OfficeVendor). It is
// "on file" only when it passes the real GSTIN checksum — a mistyped GSTIN
// cannot be matched in GSTR-2B any more than a missing one.
const vendorNameKey = (v) => String(v || '').trim().toLowerCase();
function gstinFacts(e, vendorMap) {
  const own = cleanId(e.vendorGstin);
  const master = vendorMap ? cleanId(vendorMap.get(vendorNameKey(e.vendor)) || '') : '';
  const eff = own || master;
  const ok = eff ? checkGstin(eff).ok : false;
  return { effGstin: eff || null, gstinSource: own ? 'bill' : (master ? 'vendor' : null), gstinOnFile: ok };
}

function decorate(e, vendorMap) {
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
  // The money is the truth: an imported row can carry the rate as a fraction
  // (0.18 for 18%), so where the stored rate disagrees with the amounts the
  // rate the amounts imply is reported instead. Nothing is rewritten.
  const rateOf = (stored, amt) => {
    if (!(amt > 0) || !(base > 0)) return 0;
    const implied = ROUND((amt / base) * 100);
    if (stored == null) return implied;
    return Math.abs(Number(stored) - implied) > 0.05 ? implied : Number(stored);
  };
  const gstRate = rateOf(e.gstRatePct, gst);
  const tdsRate = rateOf(e.tdsRatePct, tds);
  const gf = gstinFacts(e, vendorMap);
  // What a bill is missing, in the order the register flags it: a GST claim
  // with no vendor GSTIN, no bill number, nobody named as paid.
  const missing = [];
  if (gst > 0.5 && !gf.gstinOnFile) missing.push('GSTIN');
  if (!String(e.billNumber || '').trim()) missing.push('Bill no');
  if (!String(e.vendor || '').trim()) missing.push('Vendor');
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
    // A PAID bill that carried GST, with no vendor tax invoice on file: the
    // bank line proves the payment, but only the vendor's own tax invoice lets
    // the input GST be claimed.
    taxInvoiceNeeded: !pending && gst > 0.5 && !e.proofName,
    // An uploaded proof (utils/attachments.js) as opposed to a typed name.
    proofOnServer: !!e.proofFile,
    month: (e.expenseDate || '').slice(0, 7) || null,
    dueOn: due,
    billName: String(e.description || '').trim() || e.category || '—',
    ...gf,
    // GST on this bill that cannot be claimed until a GSTIN is on file.
    atRisk: gst > 0.5 && !gf.gstinOnFile,
    missing,
    // The approval lifecycle (spec A) next to the payment status above.
    approvalStatus: approvalOf(e),
    paid_by: paidByOf(e.paymentMode),
    attachmentUrl: e.proofFile ? `/api/office-expenses/${e.id}/proof/file` : null,
    editable: approvalOf(e) === 'PENDING',
  };
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

// The period picker. Everything dashRange() knows (all | FY | H1/H2 | Q1–Q4 |
// M:) plus a custom range, `C:<from>:<to>` with ISO dates, which is what the
// Office & Expenses "Custom Date" calendar sends.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day in that shape (2026-13-40 has the shape but is no date).
const isRealDay = (s) => {
  const v = String(s || '');
  if (!ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const fmtDay = (iso) => {
  const [y, m, d] = String(iso).split('-');
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
};
function officeRange(sel) {
  const s = String(sel || 'all');
  if (s.startsWith('C:')) {
    const [, from, to] = s.split(':');
    if (ISO_DAY.test(from || '') && ISO_DAY.test(to || '') && from <= to) {
      return {
        all: false, from, to, label: `${fmtDay(from)} – ${fmtDay(to)}`, months: null,
      };
    }
    return dashRange('all');
  }
  const r = dashRange(s);
  if (r.all) return { ...r, label: 'All time' };
  return r;
}

async function vendorMapOf() {
  const vendors = await prisma.officeVendor.findMany();
  const m = new Map();
  vendors.forEach((v) => { if (v.gstin) m.set(vendorNameKey(v.name), v.gstin); });
  return m;
}

async function officeScope(query) {
  const range = officeRange(query.period);
  const [expenses, invoices, payments, vendorMap] = await Promise.all([
    prisma.officeExpense.findMany({ orderBy: [{ expenseDate: 'desc' }, { category: 'asc' }] }),
    prisma.invoice.findMany({ include: { client: true } }),
    prisma.invoicePayment.findMany({ include: { invoice: { include: { client: true } } } }),
    vendorMapOf(),
  ]);
  await CNU.decorateNet(invoices); // B9.9: billed figures after issued notes
  // A hand loan or the owner's own money is not a cost — it stays out of
  // profit and out of GST, exactly as the accounting application has it.
  // A REJECTED bill is out of the books as well (see APPROVAL above); it is
  // kept aside so the Rejected filter can still list it.
  const decorated = expenses.map((e) => decorate(e, vendorMap));
  const rejected = decorated.filter((r) => r.approvalStatus === 'REJECTED');
  const all = decorated.filter((r) => r.entryKind !== 'hand' && r.approvalStatus !== 'REJECTED');
  const hand = decorated.filter((r) => r.entryKind === 'hand' && r.approvalStatus !== 'REJECTED');
  const live = invoices.filter((i) => deriveInvoiceStatus(i) !== 'Cancelled');
  return {
    range,
    all,
    hand,
    rejectedInPeriod: rejected.filter((r) => range.all || inRange(r.expenseDate, range)),
    inPeriod: all.filter((r) => range.all || inRange(r.expenseDate, range)),
    invoices: live,
    invoicesInPeriod: live.filter((i) => range.all || inRange(i.invoiceDate, range)),
    payments,
  };
}

// GST both ways — what clients paid us against what we paid vendors.
function gstBothWays(invoicesInPeriod, expensesInPeriod) {
  const out = ROUND(invoicesInPeriod.reduce((s, i) => s + CNU.gstBilledOf(i), 0));
  const outRec = ROUND(invoicesInPeriod.reduce((s, i) => {
    const total = CNU.receivableOf(i);
    const share = total > 0 ? Math.min(1, Number(i.receivedAmount || 0) / total) : 0;
    return s + CNU.gstBilledOf(i) * share;
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
    out = out.filter((r) => r.atRisk);
  }
  const term = String(q.q || '').trim().toLowerCase();
  if (term) {
    out = out.filter((r) => [r.category, r.description, r.vendor, r.billNumber, r.remarks, r.approvedBy]
      .join(' ').toLowerCase().includes(term));
  }
  return out;
}

// ---------------------------------------------------------------------------
// SPEC A — THE EXPENSE API
//   GET  /?month=&year=&category=&status=&search=&from=&to=&sort=&dir=&page=&pageSize=
//   GET  /summary?month=&year=      -> { total_amount, category_wise_totals, ... }
//   GET  /:id                       -> one expense with who created / approved it
//   POST /                          -> always PENDING, unless an approver says otherwise
//   PUT  /:id  (and PATCH /:id)     -> only while PENDING (409 otherwise)
//   PATCH /:id/status               -> approve | reject (reason) | mark_paid
//   GET/POST /categories
//
// "amount" on this API is the bill's Total — before GST + GST − TDS, what is
// actually paid to the vendor (the register's Total column). TDS held back is
// paid to Government separately and is not counted here twice.
// ---------------------------------------------------------------------------
const ISO_MONTH = /^\d{4}-\d{2}$/;
function monthKeyOf(q) {
  const m = String(q.month ?? '').trim();
  if (ISO_MONTH.test(m)) return m;
  const y = Number(q.year);
  const mm = Number(m);
  if (Number.isInteger(y) && y >= 2000 && y <= 2100 && Number.isInteger(mm) && mm >= 1 && mm <= 12) {
    return `${y}-${String(mm).padStart(2, '0')}`;
  }
  return null;
}
const apprList = (v) => listParam(v).map((s) => s.toUpperCase().replace(/[\s-]+/g, '_'))
  .map((s) => (s === 'MARK_PAID' ? 'PAID' : s)).filter((s) => APPROVAL.includes(s));
const LIST_SORTS = {
  date: (r) => String(r.expenseDate || ''),
  amount: (r) => r.net,
};

async function expenseList(q) {
  const where = {};
  const mk = monthKeyOf(q);
  const and = [];
  if (mk) and.push({ expenseDate: { startsWith: mk } });
  if (ISO_DAY.test(String(q.from || ''))) and.push({ expenseDate: { gte: q.from } });
  if (ISO_DAY.test(String(q.to || ''))) and.push({ expenseDate: { lte: q.to } });
  if (and.length) where.AND = and;
  const cats = listParam(q.category);
  if (cats.length) where.category = { in: cats };
  const statuses = apprList(q.status);
  if (statuses.length) where.approvalStatus = { in: statuses };
  const vendorMap = await vendorMapOf();
  let rows = (await prisma.officeExpense.findMany({ where })).map((e) => decorate(e, vendorMap));
  // Search reads the vendor and the description (spec A), case-insensitive.
  const term = String(q.search ?? q.q ?? '').trim().toLowerCase();
  if (term) rows = rows.filter((r) => `${r.vendor || ''} ${r.description || ''}`.toLowerCase().includes(term));

  const sort = LIST_SORTS[q.sort] ? q.sort : 'date';
  const dir = q.dir === 'asc' ? 'asc' : 'desc';
  const keyFn = LIST_SORTS[sort];
  const mul = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = keyFn(a); const y = keyFn(b);
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return (c * mul) || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0)) || String(a.id).localeCompare(String(b.id));
  });
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(q.pageSize, 10) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number.parseInt(q.page, 10) || 1));
  const slice = rows.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
    ...r, amount: r.net, status: r.approvalStatus, statusText: APPROVAL_LABEL[r.approvalStatus],
  }));
  return {
    month: mk ? Number(mk.slice(5, 7)) : null,
    year: mk ? Number(mk.slice(0, 4)) : null,
    label: mk ? monthLabel(mk) : null,
    filters: {
      category: cats, status: statuses, search: term || null, from: q.from || null, to: q.to || null,
    },
    sort,
    dir,
    page,
    pageSize,
    pages,
    total,
    totalAmount: ROUND(rows.reduce((s, r) => s + r.net, 0)),
    rows: slice,
  };
}

// The month (or period) summary: the total and the category-wise totals.
// Hand loans are not expenses and never count. By default the total is every
// bill that is still live — PENDING, APPROVED and PAID; REJECTED is out of the
// books. `status=` narrows it (e.g. status=APPROVED|PAID, what the combined
// outflow uses). by_status always reports all four.
async function expenseSummary(q) {
  const mk = monthKeyOf(q);
  const range = mk ? null : officeRange(q.period);
  const base = await prisma.officeExpense.findMany({ where: mk ? { expenseDate: { startsWith: mk } } : {} });
  const rows = base.map((e) => decorate(e))
    .filter((r) => r.entryKind !== 'hand')
    .filter((r) => mk || range.all || inRange(r.expenseDate, range));
  const asked = apprList(q.status);
  const statuses = asked.length ? asked : ['PENDING', 'APPROVED', 'PAID', 'REIMBURSED'];
  const inScope = rows.filter((r) => statuses.includes(r.approvalStatus));
  const byCat = new Map();
  inScope.forEach((r) => {
    const k = r.category || '—';
    const c = byCat.get(k) || { category: k, total_amount: 0, count: 0 };
    c.total_amount = ROUND(c.total_amount + r.net);
    c.count += 1;
    byCat.set(k, c);
  });
  const byStatus = {};
  APPROVAL.forEach((s) => {
    const l = rows.filter((r) => r.approvalStatus === s);
    byStatus[s] = { count: l.length, total_amount: ROUND(l.reduce((a, r) => a + r.net, 0)) };
  });
  return {
    month: mk ? Number(mk.slice(5, 7)) : null,
    year: mk ? Number(mk.slice(0, 4)) : null,
    monthKey: mk,
    label: mk ? monthLabel(mk) : range.label,
    from: mk ? `${mk}-01` : (range.all ? null : range.from),
    to: mk ? lastDayOfMonth(mk) : (range.all ? null : range.to),
    statuses,
    total_amount: ROUND(inScope.reduce((s, r) => s + r.net, 0)),
    count: inScope.length,
    category_wise_totals: [...byCat.values()].sort((a, b) => b.total_amount - a.total_amount),
    by_status: byStatus,
    // Reimbursed is money out, like Paid (it is 0 until a bill is reimbursed).
    approved_paid_total: ROUND(byStatus.APPROVED.total_amount + byStatus.PAID.total_amount + byStatus.REIMBURSED.total_amount),
    amount_definition: 'Total per bill = before GST + GST − TDS (what is paid to the vendor); hand loans excluded',
  };
}
const lastDayOfMonth = (mk) => {
  const y = Number(mk.slice(0, 4)); const m = Number(mk.slice(5, 7));
  return `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

// GET / — with any spec-A parameter (year, status, search, page, pageSize,
// sort, from, to) it answers the paginated list; the original call (category,
// location and a YYYY-MM month only) still answers the plain array it always
// did.
const SPEC_LIST_KEYS = ['year', 'status', 'search', 'page', 'pageSize', 'sort', 'dir', 'from', 'to'];
router.get('/', async (req, res) => {
  if (SPEC_LIST_KEYS.some((k) => req.query[k] !== undefined)) {
    return res.json(await expenseList(req.query));
  }
  const where = {};
  if (req.query.category) where.category = req.query.category;
  if (req.query.location) where.location = req.query.location;
  const expenses = await prisma.officeExpense.findMany({ where, orderBy: [{ expenseDate: 'desc' }, { category: 'asc' }] });
  let rows = expenses.map((e) => decorate(e));
  if (req.query.month) rows = rows.filter((r) => r.month === req.query.month);
  return res.json(rows);
});

// Office & Business: the category and month summary, the profit & loss and the
// GST position — GST charged to clients against GST paid to vendors.
// With `year` (spec A: ?month=9&year=2026) or `period`, it answers the spec's
// { total_amount, category_wise_totals } summary instead.
router.get('/summary', async (req, res, next) => {
  if (req.query.year !== undefined || req.query.period !== undefined) {
    return res.json(await expenseSummary(req.query));
  }
  return next();
});
router.get('/summary', async (req, res) => {
  const [expenses, invoices] = await Promise.all([
    prisma.officeExpense.findMany(),
    prisma.invoice.findMany({ where: { status: { not: 'Cancelled' } } }),
  ]);
  await CNU.decorateNet(invoices); // B9.9: income after issued notes
  const rows = expenses.map((e) => decorate(e)).filter((r) => r.entryKind !== 'hand' && r.approvalStatus !== 'REJECTED');
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
  const incomeNet = ROUND(invoicesInScope.reduce((s, i) => s + CNU.billedOf(i), 0));
  const gstCharged = ROUND(invoicesInScope.reduce((s, i) => s + CNU.gstBilledOf(i), 0));
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
  const income = ROUND(invoicesInPeriod.reduce((s, i) => s + CNU.billedOf(i), 0));
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
    incOf.set(k, ROUND((incOf.get(k) || 0) + CNU.billedOf(i)));
    gstOutOf.set(k, ROUND((gstOutOf.get(k) || 0) + CNU.gstBilledOf(i)));
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
    if (r.atRisk) g.noGstin += 1;
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
      unclaimable: ROUND(inPeriod.filter((r) => r.atRisk).reduce((s, r) => s + r.gst, 0)),
      unclaimableCount: inPeriod.filter((r) => r.atRisk).length,
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

// ===========================================================================
// OFFICE & EXPENSES — THE REGISTER
//
// One endpoint behind the sticky filter bar, the eight summary cards and the
// expenses table, and the Excel export reads the SAME function, so what is
// downloaded is exactly the filtered, sorted and grouped view on screen.
//
// The money, and the choice behind each figure:
//   base      before GST
//   gst       GST paid to the vendor (stored as an amount)
//   afterGst  base + gst                   — the "TOTAL AMOUNT" card
//   tds       TDS we held back
//   net       afterGst − tds               — the "Total" column / chip: what
//                                            is actually paid to the vendor
// Paid and Pending are sums of `net`, so Paid + Pending = the Total chip.
// ===========================================================================
const listParam = (v) => {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split('|');
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
};
const vendorLabel = (r) => String(r.vendor || '').trim();
const REG_GROUPS = ['month', 'cat', 'vendor', 'none'];
const REG_SORTS = {
  bill: (r) => String(r.billName || '').toLowerCase(),
  date: (r) => String(r.expenseDate || ''),
  vendor: (r) => vendorLabel(r).toLowerCase(),
  category: (r) => String(r.category || '').toLowerCase(),
  billNo: (r) => String(r.billNumber || '').toLowerCase(),
  base: (r) => r.base,
  gst: (r) => r.gst,
  tds: (r) => r.tds,
  afterGst: (r) => r.afterGst,
  net: (r) => r.net,
  status: (r) => r.statusLabel,
};

function registerFilter(list, q) {
  const cats = listParam(q.cats);
  const vens = listParam(q.vens);
  let out = list;
  if (cats.length) out = out.filter((r) => cats.includes(r.category));
  if (vens.length) out = out.filter((r) => vens.includes(vendorLabel(r)));
  if (q.gst === 'Yes' || q.gst === 'No') out = out.filter((r) => ((q.gst === 'Yes') === (r.gst > 0.5)));
  if (q.status === 'Paid' || q.status === 'Pending') out = out.filter((r) => r.statusLabel === q.status);
  // The approval status (spec A). REJECTED rows are handed in separately by
  // registerData, so this filter never has to bring them back.
  const appr = String(q.appr || '').toUpperCase();
  if (APPROVAL.includes(appr)) out = out.filter((r) => r.approvalStatus === appr);
  if (q.mode && q.mode !== 'All') out = out.filter((r) => (r.paymentMode || '') === q.mode);
  if (q.only === 'atrisk') out = out.filter((r) => r.atRisk);
  if (q.only === 'missing') out = out.filter((r) => r.missing.length > 0);
  // The search box reads the vendor, the bill's description, its bill number
  // and its remarks — the free-text fields on a bill.
  const term = String(q.q || '').trim().toLowerCase();
  if (term) {
    out = out.filter((r) => [r.vendor, r.description, r.billNumber, r.remarks]
      .join(' ').toLowerCase().includes(term));
  }
  return { rows: out, cats, vens };
}

function moneySum(rows) {
  return {
    n: rows.length,
    base: ROUND(rows.reduce((s, r) => s + r.base, 0)),
    gst: ROUND(rows.reduce((s, r) => s + r.gst, 0)),
    tds: ROUND(rows.reduce((s, r) => s + r.tds, 0)),
    afterGst: ROUND(rows.reduce((s, r) => s + r.afterGst, 0)),
    net: ROUND(rows.reduce((s, r) => s + r.net, 0)),
  };
}

// The table as it is shown: sorted, then grouped, each group carrying its own
// subtotal, and one grand total under everything.
function registerView(rows, q) {
  const sort = REG_SORTS[q.sort] ? q.sort : 'date';
  const dir = q.dir === 'asc' ? 'asc' : 'desc';
  const groupBy = REG_GROUPS.includes(q.groupBy) ? q.groupBy : 'month';
  const keyFn = REG_SORTS[sort];
  const mul = dir === 'asc' ? 1 : -1;
  const sorted = rows.slice().sort((a, b) => {
    const x = keyFn(a); const y = keyFn(b);
    const c = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y));
    return (c * mul) || String(b.expenseDate || '').localeCompare(String(a.expenseDate || ''));
  });
  if (groupBy === 'none') {
    return {
      groupBy, sort, dir, grouped: false, groups: [{ key: 'all', label: 'Every bill', rows: sorted, sub: moneySum(sorted) }], total: moneySum(sorted),
    };
  }
  const keyOf = (r) => (groupBy === 'month' ? (r.month || '—')
    : groupBy === 'cat' ? (r.category || '—') : (vendorLabel(r) || '(no vendor)'));
  const map = new Map();
  sorted.forEach((r) => {
    const k = keyOf(r);
    map.set(k, [...(map.get(k) || []), r]);
  });
  // Months run newest first unless the table is sorted oldest-first by date;
  // category and vendor groups read A–Z.
  const monthDir = sort === 'date' && dir === 'asc' ? 1 : -1;
  const groups = [...map.entries()]
    .sort(([a], [b]) => (groupBy === 'month' ? a.localeCompare(b) * monthDir : a.localeCompare(b)))
    .map(([k, rs]) => ({
      key: k, label: groupBy === 'month' ? (k === '—' ? 'No date' : monthLabel(k)) : k, rows: rs, sub: moneySum(rs),
    }));
  return {
    groupBy, sort, dir, grouped: true, groups, total: moneySum(sorted),
  };
}

// Grouped by month, every month carries what the business EARNED that month
// and what is left of it: income is the fee billed on invoices dated in that
// month, before GST (Invoice.amount); profit / loss is that income less what
// the office actually paid out on the month's bills; GST payable is the GST
// charged to clients on those invoices less the GST on the month's bills.
function withMonthMetrics(view, invoicesInPeriod) {
  if (view.groupBy !== 'month') return view;
  const inc = new Map();
  const gstOut = new Map();
  invoicesInPeriod.forEach((i) => {
    const k = String(i.invoiceDate || '').slice(0, 7);
    if (!k) return;
    inc.set(k, ROUND((inc.get(k) || 0) + CNU.billedOf(i)));
    gstOut.set(k, ROUND((gstOut.get(k) || 0) + CNU.gstBilledOf(i)));
  });
  const tot = {
    income: 0, paidOut: 0, pl: 0, gstOut: 0, gstIn: 0, gstPayable: 0,
  };
  view.groups.forEach((g) => {
    const income = inc.get(g.key) || 0;
    const paidOut = ROUND(g.rows.filter((r) => !r.pending).reduce((s, r) => s + r.net, 0));
    const out = gstOut.get(g.key) || 0;
    // eslint-disable-next-line no-param-reassign
    g.month = {
      income,
      paidOut,
      pl: ROUND(income - paidOut),
      gstOut: out,
      gstIn: g.sub.gst,
      gstPayable: ROUND(out - g.sub.gst),
    };
    Object.keys(tot).forEach((k) => { tot[k] = ROUND(tot[k] + g.month[k]); });
  });
  return { ...view, monthTotals: tot };
}

async function registerData(query) {
  const {
    range, all, inPeriod: booked, rejectedInPeriod, invoices, invoicesInPeriod,
  } = await officeScope(query);
  // Status = Rejected lists the rejected bills; every other view is the books.
  const inPeriod = String(query.appr || '').toUpperCase() === 'REJECTED' ? rejectedInPeriod : booked;
  const { rows, cats, vens } = registerFilter(inPeriod, query);
  const t = moneySum(rows);

  // The bank statement line behind a bill (OfficeExpense.bankTxnId — the link
  // a bill filed off the bank statement carries), so the Proof column can say
  // "Bank statement" and open that very line.
  const txnIds = [...new Set(rows.map((r) => r.bankTxnId).filter(Boolean))];
  if (txnIds.length) {
    const txns = await prisma.bankTransaction.findMany({ where: { id: { in: txnIds } } });
    const byId = new Map(txns.map((x) => [x.id, x]));
    rows.forEach((r) => {
      const x = r.bankTxnId ? byId.get(r.bankTxnId) : null;
      r.bankLine = x ? {
        id: x.id, date: x.date, description: x.description, reference: x.reference, amount: x.amount, type: x.type,
      } : null;
    });
  }
  const paidRows = rows.filter((r) => !r.pending);
  const pendRows = rows.filter((r) => r.pending);

  const byVendor = (list) => {
    const m = new Map();
    list.forEach((r) => {
      const k = vendorLabel(r) || r.category || '—';
      m.set(k, ROUND((m.get(k) || 0) + r.net));
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, amount]) => ({ name, amount }));
  };

  // GST both ways. GST received comes off the invoicing module's own rows
  // (routes/invoices.js, model Invoice) — the invoices raised in the period,
  // cancelled ones left out; GST paid is this filter's bills.
  const gstReceived = ROUND(invoicesInPeriod.reduce((s, i) => s + CNU.gstBilledOf(i), 0));
  const periodGstPaid = ROUND(booked.reduce((s, r) => s + r.gst, 0));

  // The pickers follow each other: choose categories and only their vendors
  // are offered; choose vendors and only the categories they bill under are.
  const countBy = (list, fn) => {
    const m = new Map();
    list.forEach((r) => { const k = fn(r); if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n }));
  };
  const inCats = cats.length ? inPeriod.filter((r) => cats.includes(r.category)) : inPeriod;
  const inVens = vens.length ? inPeriod.filter((r) => vens.includes(vendorLabel(r))) : inPeriod;

  const company = (await prisma.company.findFirst()) || {};
  const gstin = cleanId(company.gstin);
  const gc = gstin ? checkGstin(gstin) : null;
  const modes = [...new Set([...EXP_MODES.filter((m) => m !== 'Card'),
    ...all.map((r) => r.paymentMode).filter(Boolean)])];

  return {
    range,
    rows,
    cats,
    vens,
    body: {
      period: {
        sel: query.period || 'all', label: range.label, from: range.from, to: range.to, all: !!range.all,
      },
      filtered: rows.length !== inPeriod.length,
      totals: {
        ...t,
        categories: new Set(rows.map((r) => r.category).filter(Boolean)).size,
        paid: ROUND(paidRows.reduce((s, r) => s + r.net, 0)),
        pending: ROUND(pendRows.reduce((s, r) => s + r.net, 0)),
        paidVendors: byVendor(paidRows),
        pendingVendors: byVendor(pendRows),
        atRisk: ROUND(rows.filter((r) => r.atRisk).reduce((s, r) => s + r.gst, 0)),
        missingCount: rows.filter((r) => r.missing.length).length,
      },
      gst: {
        received: gstReceived,
        invoices: invoicesInPeriod.length,
        paid: t.gst,
        payable: ROUND(gstReceived - t.gst),
        tds: t.tds,
        // The whole period, whatever the category / vendor filter — what the
        // books say is owed to Government for the period.
        periodPaid: periodGstPaid,
        periodPayable: ROUND(gstReceived - periodGstPaid),
      },
      ourGstin: gstin || null,
      ourGstinValid: !!(gc && gc.ok),
      options: {
        categories: countBy(inPeriod, (r) => r.category),
        vendors: countBy(inPeriod, vendorLabel),
        fitVendors: countBy(inCats, vendorLabel).map((x) => x.name),
        fitCategories: countBy(inVens, (r) => r.category).map((x) => x.name),
        allCategories: [...new Set(all.map((r) => r.category).filter(Boolean))].sort(),
        allVendors: [...new Set(all.map(vendorLabel).filter(Boolean))].sort(),
        vendorsByCategory: Object.fromEntries(
          [...new Set(all.map((r) => r.category).filter(Boolean))].map((c) => [
            c, [...new Set(all.filter((r) => r.category === c).map(vendorLabel).filter(Boolean))].sort(),
          ]),
        ),
        modes,
        // The edit form's pick-lists: ledgers already used, the clients a
        // cost can be recharged to (from Invoices), and the tags in use.
        expenseAccounts: [...new Set(all.map((r) => r.expenseAccount).filter(Boolean))].sort(),
        clients: [...new Set(invoices.map((i) => i.client?.name).filter(Boolean))].sort(),
        tags: [...new Set(all.flatMap((r) => String(r.reportingTags || '').split(',').map((t) => t.trim())).filter(Boolean))].sort(),
        statuses: EXP_STATUS,
        gstRates: GST_RATES,
        tdsRates: [0, 1, 2, 5, 10],
      },
      view: withMonthMetrics(registerView(rows, query), invoicesInPeriod),
      outsidePeriod: all.length - inPeriod.length,
    },
  };
}

router.get('/register', async (req, res) => {
  const { body } = await registerData(req.query);
  res.json(body);
});

// Excel — exactly the view on screen: the same filters, the same sort, the
// same grouping, a subtotal under every group and one TOTAL row at the end.
router.get('/register/export.xlsx', requirePerm('accounts', 'accounts', 'Office & Expenses', 'export'), async (req, res) => {
  const { body, cats, vens } = await registerData(req.query);
  const v = body.view;
  const head = ['Bill', 'Bills', 'Date', 'Paid to', 'Category', 'Bill no', 'Vendor GSTIN', 'Payment mode', 'Status',
    'Before GST', 'GST', 'TDS', 'After GST', 'Total', 'Paid', 'Balance', 'Missing', 'Proof',
    'Income (month)', 'Profit / Loss (month)', 'GST payable (month)'];
  const proofText = (r) => {
    const base = r.bankLine ? `Bank statement · ${r.bankLine.reference || r.bankLine.date}`
      : (r.proofName ? `Bill · ${r.proofName}` : 'No bill');
    return r.taxInvoiceNeeded ? `${base} · vendor tax invoice still needed` : base;
  };
  const mm = (m) => (m ? [m.income, m.pl, m.gstPayable] : ['', '', '']);
  const said = [];
  if (cats.length) said.push(`Category: ${cats.join(', ')}`);
  if (vens.length) said.push(`Vendor: ${vens.join(', ')}`);
  if (req.query.q) said.push(`Search: ${req.query.q}`);
  if (req.query.gst === 'Yes' || req.query.gst === 'No') said.push(`GST on the bill: ${req.query.gst}`);
  if (req.query.status === 'Paid' || req.query.status === 'Pending') said.push(`Status: ${req.query.status}`);
  if (APPROVAL.includes(String(req.query.appr || '').toUpperCase())) said.push(`Approval: ${APPROVAL_LABEL[String(req.query.appr).toUpperCase()]}`);
  if (req.query.mode && req.query.mode !== 'All') said.push(`Payment mode: ${req.query.mode}`);
  if (req.query.only === 'atrisk') said.push('Only bills with GST at risk');
  const groupWord = { month: 'month', cat: 'category', vendor: 'paid to', none: 'no grouping' }[v.groupBy];
  const aoa = [
    ['Office & Expenses'],
    [`Period: ${body.period.label}`],
    [`Filters: ${said.length ? said.join(' · ') : 'none'} · Grouped by ${groupWord} · Sorted by ${v.sort} ${v.dir}`],
    ['Total = After GST − TDS (what is actually paid to the vendor). After GST = Before GST + GST. Income and Profit / Loss show when the table is grouped by month — income is the fee earned that month before GST, profit is that income minus what the office actually paid out, and GST payable is what we charged clients less what we paid vendors.'],
    [],
    head,
  ];
  const kinds = [];
  const money = (s) => [s.base, s.gst, s.tds, s.afterGst, s.net];
  v.groups.forEach((g) => {
    g.rows.forEach((r) => {
      aoa.push([r.billName, '', r.expenseDate || '', vendorLabel(r), r.category || '', r.billNumber || '',
        r.effGstin || '', r.paymentMode || '', LEDGER_STATUS_SHORT[r.approvalStatus] || r.statusLabel, ...money(r), r.paidValue, r.pendingValue,
        r.missing.join(', '), proofText(r), '', '', '']);
      kinds.push('row');
    });
    if (v.grouped) {
      const gp = ROUND(g.rows.filter((r) => !r.pending).reduce((s, r) => s + r.net, 0));
      aoa.push([`${g.label} — subtotal`, g.sub.n, '', '', '', '', '', '', '', ...money(g.sub), gp, ROUND(g.sub.net - gp),
        '', '', ...mm(g.month)]);
      kinds.push('sub');
    }
  });
  if (!v.total.n) { aoa.push(['No expenses in this period']); kinds.push('empty'); }
  const tp = ROUND(v.groups.reduce((s, g) => s + g.rows.filter((r) => !r.pending).reduce((a, r) => a + r.net, 0), 0));
  aoa.push(['TOTAL', v.total.n, '', '', '', '', '', '', '', ...money(v.total), tp, ROUND(v.total.net - tp), '', '', ...mm(v.monthTotals)]);
  kinds.push('total');

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const first = 6; // 0-based index of the first data row
  for (let i = first; i < aoa.length; i += 1) {
    for (let c = 9; c <= 20; c += 1) {
      const ref = XLSX.utils.encode_cell({ r: i, c });
      if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0.00';
    }
  }
  ws['!cols'] = [34, 7, 11, 24, 22, 14, 18, 14, 9, 13, 12, 12, 13, 13, 13, 13, 18, 34, 14, 16, 16].map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: `A6:U${aoa.length}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Office expenses');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const tag = body.period.all ? 'all-time' : `${body.period.from}_to_${body.period.to}`;
  await logAudit({
    userId: req.user.id, action: 'Office expenses exported', entity: 'OfficeExpense', toValue: `${v.total.n} bill(s) · ${tag}`,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="office-expenses-${tag}.xlsx"`);
  res.send(buf);
});

// ===========================================================================
// THE ONE-PAGE EXPENSES TABLE (Office & Accounts one-page spec 4–18)
//
//   GET /ledger?q=&from=&to=&category=&vendor=&mode=&status=&page=&pageSize=
//   GET /ledger/export.xlsx   (same filters, every matching row)
//
// The transaction table under THE POSITION. Its own filters (the page's
// period picker still drives the GST summary above it). Money per row:
//   Amount        before GST                     (base)
//   GST Amount    Amount × GST %                 (gst, as stored)
//   Total Amount  Amount + GST                   (afterGst — the spec's Total)
// TDS, where a bill has it, is not part of this Total; the drawer shows it and
// what was actually paid after it (the older register's "Total" = after GST −
// TDS is unchanged in the register view).
// Status (Accounts spec S1.3c, 2026-10-05): the list offers Paid and Pending
// only. Reimbursed / Approved / Rejected are no longer offered, counted or
// badged; a stored row that still carries one of them (none on 2026-10-05) is
// shown as "Other (old status)" so nothing disappears — nothing is rewritten.
// For the totals (S1.2) every money column is summed as it is shown:
//   Before GST · GST · After GST (= before + GST) · TDS we cut ·
//   Total (= after GST − TDS, what the vendor is paid) · Paid · Pending,
//   Paid    = Total of PAID (+ an old REIMBURSED row)   — money out
//   Pending = Total of PENDING (+ an old APPROVED row)  — not paid yet
// so Paid + Pending = Total. REJECTED stays out of the books (listed only
// under "Other (old status)"). Hand loans are not expenses and never listed.
// ===========================================================================
const LEDGER_STATUS = [['PAID', 'Paid'], ['PENDING', 'Pending']];
const OLD_STATUSES = ['APPROVED', 'REIMBURSED', 'REJECTED'];
const OTHER_STATUS_LABEL = 'Other (old status)';
const LEDGER_STATUS_SHORT = {
  ...Object.fromEntries(LEDGER_STATUS), APPROVED: OTHER_STATUS_LABEL, REIMBURSED: OTHER_STATUS_LABEL, REJECTED: OTHER_STATUS_LABEL, OTHER: OTHER_STATUS_LABEL,
};
const PAID_LIKE = ['PAID', 'REIMBURSED'];
const PENDING_LIKE = ['PENDING', 'APPROVED'];
// GST on the bill (S1.3b). "Vendor GSTIN missing" = the bill carries GST and
// no valid vendor GSTIN is on file (the GST that cannot be claimed yet);
// "available" = a valid vendor GSTIN is on file. Yes / No are the old names.
const GST_FILTERS = {
  with: { label: 'With GST', test: (r) => r.gst > 0.5 },
  without: { label: 'Without GST', test: (r) => !(r.gst > 0.5) },
  missing: { label: 'Vendor GSTIN missing', test: (r) => !!r.atRisk },
  onfile: { label: 'Vendor GSTIN available', test: (r) => !!r.gstinOnFile },
};
const GST_ALIAS = { Yes: 'with', No: 'without' };
const gstKeyOf = (v) => { const k = GST_ALIAS[v] || String(v || ''); return GST_FILTERS[k] ? k : null; };
const codeNo = (r) => { const x = CODE_RE.exec(r.expenseCode || ''); return x ? Number(x[1]) : 0; };
const LEDGER_SORTS = {
  date: (r) => String(r.expenseDate || ''),
  code: codeNo,
  amount: (r) => r.base,
  gst: (r) => r.gst,
  after: (r) => r.afterGst,
  tds: (r) => r.tds,
  total: (r) => r.net,
  paid: (r) => (PAID_LIKE.includes(r.approvalStatus) ? r.net : 0),
  pending: (r) => (PENDING_LIKE.includes(r.approvalStatus) ? r.net : 0),
};

function ledgerTotals(list) {
  const s = (l, f) => ROUND(l.reduce((a, r) => a + f(r), 0));
  return {
    count: list.length,
    before: s(list, (r) => r.base),
    amount: s(list, (r) => r.base),
    gst: s(list, (r) => r.gst),
    after: s(list, (r) => r.afterGst),
    tds: s(list, (r) => r.tds),
    total: s(list, (r) => r.net),
    paid: s(list.filter((r) => PAID_LIKE.includes(r.approvalStatus)), (r) => r.net),
    pending: s(list.filter((r) => PENDING_LIKE.includes(r.approvalStatus)), (r) => r.net),
    paidCount: list.filter((r) => PAID_LIKE.includes(r.approvalStatus)).length,
    pendingCount: list.filter((r) => PENDING_LIKE.includes(r.approvalStatus)).length,
    withGstCount: list.filter((r) => r.gst > 0.5).length,
    tdsCount: list.filter((r) => r.tds > 0.5).length,
  };
}

// The list filters as one set of tests, so a facet can be counted against all
// the OTHER filters (the cascading-filter rule) and /overview can apply the
// very same set to its bills.
function ledgerFilter(q) {
  const from = ISO_DAY.test(String(q.from || '')) ? q.from : null;
  const to = ISO_DAY.test(String(q.to || '')) ? q.to : null;
  const cats = listParam(q.category);
  const vens = listParam(q.vendor);
  const modes = listParam(q.mode);
  const status = String(q.status || '').trim().toUpperCase();
  const gstKey = gstKeyOf(q.gst);
  const term = String(q.q || '').trim().toLowerCase();
  const tests = {
    date: from || to ? (r) => !!r.expenseDate && (!from || r.expenseDate >= from) && (!to || r.expenseDate <= to) : null,
    category: cats.length ? (r) => cats.includes(r.category) : null,
    vendor: vens.length ? (r) => vens.includes(vendorLabel(r)) : null,
    mode: modes.length ? (r) => modes.includes(r.paymentMode || '') : null,
    status: status === 'OTHER' ? (r) => OLD_STATUSES.includes(r.approvalStatus)
      : (status === 'PAID' || status === 'PENDING' ? (r) => r.approvalStatus === status : null),
    gst: gstKey ? GST_FILTERS[gstKey].test : null,
    tds: q.tds === 'Yes' || q.tds === 'No' ? (r) => (q.tds === 'Yes') === (r.tds > 0.5) : null,
    // Source (vendor portal v2 §11): a bill booked from a vendor's submission carries the tag 'Vendor Portal'.
    source: q.source === 'Vendor Portal' || q.source === 'Manual' ? (r) => (String(r.reportingTags || '').includes('Vendor Portal')) === (q.source === 'Vendor Portal') : null,
    // Search (spec 17): Expense ID, bill no, description, vendor and category.
    q: term ? (r) => [r.expenseCode, r.billNumber, r.description, vendorLabel(r), r.category]
      .map((x) => String(x || '')).join(' ').toLowerCase().includes(term) : null,
  };
  const run = (rows, skip) => rows.filter((r) => Object.entries(tests).every(([k, t]) => !t || k === skip || t(r)));
  return {
    tests, run, status, gstKey, active: Object.values(tests).some(Boolean),
  };
}
// Facet options with counts from the rows that match every other filter;
// options with no rows are left out (the one picked always stays).
function facetOf(rows, keyFn, picked) {
  const m = new Map();
  rows.forEach((r) => { const k = keyFn(r); if (k) m.set(k, (m.get(k) || 0) + 1); });
  listParam(picked).forEach((p) => { if (!m.has(p)) m.set(p, 0); });
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, n]) => ({ value, n }));
}

async function ledgerData(q) {
  await ensureExpenseCodes();
  const [expenses, vendorMap, catRows] = await Promise.all([
    prisma.officeExpense.findMany({ orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }] }),
    vendorMapOf(),
    prisma.expenseCategory.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
  ]);
  const decorated = expenses.map((e) => decorate(e, vendorMap)).filter((r) => r.entryKind !== 'hand');
  const lf = ledgerFilter(q);
  const books = decorated.filter((r) => r.approvalStatus !== 'REJECTED');
  // "Other (old status)" may list an old REJECTED row; every other view is the books.
  const pool = lf.status === 'OTHER' ? decorated : books;
  let rows = lf.run(pool);

  const sort = LEDGER_SORTS[q.sort] ? q.sort : 'date';
  const dir = q.dir === 'asc' ? 'asc' : 'desc';
  const keyFn = LEDGER_SORTS[sort];
  const mul = dir === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    const x = keyFn(a); const y = keyFn(b);
    const c = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y));
    // Same date: the later Expense ID first (or last, sorted oldest first).
    return (c * mul) || ((codeNo(a) - codeNo(b)) * mul);
  });

  const filtered = lf.active;
  const usedCats = [...new Set(decorated.map((r) => r.category).filter(Boolean))];
  // Cascading facets (agent-rules FILTER RULE): each one counted on the rows
  // that match all the other filters. Status / GST count against the books
  // (an old REJECTED row shows only under "Other (old status)").
  const statusCounts = new Map();
  lf.run(decorated, 'status').forEach((r) => {
    const k = OLD_STATUSES.includes(r.approvalStatus) ? 'OTHER' : r.approvalStatus;
    statusCounts.set(k, (statusCounts.get(k) || 0) + 1);
  });
  const gstBase = lf.run(books, 'gst');
  const facets = {
    category: facetOf(lf.run(books, 'category'), (r) => r.category, q.category),
    vendor: facetOf(lf.run(books, 'vendor'), (r) => vendorLabel(r), q.vendor),
    mode: facetOf(lf.run(books, 'mode'), (r) => r.paymentMode, q.mode),
    status: [
      ...LEDGER_STATUS.map(([value, label]) => ({ value, label, n: statusCounts.get(value) || 0 })),
      ...((statusCounts.get('OTHER') || lf.status === 'OTHER') ? [{ value: 'OTHER', label: OTHER_STATUS_LABEL, n: statusCounts.get('OTHER') || 0 }] : []),
    ],
    gst: Object.entries(GST_FILTERS).map(([value, g]) => ({ value, label: g.label, n: gstBase.filter(g.test).length })),
    source: [['Manual', 'Entered by staff'], ['Vendor Portal', 'Vendor Portal']].map(([value, label]) => ({ value, label, n: lf.run(books, 'source').filter((r) => (String(r.reportingTags || '').includes('Vendor Portal')) === (value === 'Vendor Portal')).length })),
  };
  const vendorCounts = new Map();
  books.forEach((r) => { const v = vendorLabel(r); if (v) vendorCounts.set(v, (vendorCounts.get(v) || 0) + 1); });
  const usedModes = [...new Set(decorated.map((r) => r.paymentMode).filter(Boolean))];
  return {
    rows,
    filtered,
    sort,
    dir,
    totals: ledgerTotals(rows),
    all: ledgerTotals(books),
    options: {
      categories: [...new Set([...catRows.map((c) => c.name), ...usedCats])].sort((a, b) => a.localeCompare(b)),
      vendors: [...vendorCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n })),
      modes: [...LEDGER_MODES, ...usedModes.filter((m) => !LEDGER_MODES.includes(m))],
      newModes: LEDGER_MODES,
      statuses: facets.status.map(({ value, label }) => ({ value, label })),
      gstRates: GST_RATES,
      facets,
    },
  };
}

async function peopleOf(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const people = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true, email: true } });
  return new Map(people.map((p) => [p.id, p.name || p.email]));
}

const isoDateOf = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
};
const paymentDateOf = (r) => (r.approvalStatus === 'REIMBURSED' ? isoDateOf(r.reimbursedAt || r.paidAt)
  : (r.approvalStatus === 'PAID' ? isoDateOf(r.paidAt) : null));

function ledgerRow(r, names) {
  return {
    id: r.id,
    expenseCode: r.expenseCode || null,
    expenseDate: r.expenseDate || null,
    category: r.category || null,
    description: r.description || null,
    vendor: vendorLabel(r) || null,
    paymentMode: r.paymentMode || null,
    amount: r.base,
    gstRate: r.gstRate,
    gst: r.gst,
    // S1.2: Before GST (amount) · GST · After GST · TDS · Total (after GST −
    // TDS) · Paid · Pending — Paid + Pending = Total.
    after: r.afterGst,
    total: r.net,
    paid: PAID_LIKE.includes(r.approvalStatus) ? r.net : 0,
    pending: PENDING_LIKE.includes(r.approvalStatus) ? r.net : 0,
    tds: r.tds,
    tdsRate: r.tdsRate,
    netAfterTds: r.net,
    vendorGstin: r.effGstin || null,
    gstinOnFile: !!r.gstinOnFile,
    oldStatus: OLD_STATUSES.includes(r.approvalStatus),
    status: r.approvalStatus,
    statusText: LEDGER_STATUS_SHORT[r.approvalStatus] || r.approvalStatus,
    // When the money went out: marked paid, or reimbursed. Bills paid before
    // payment dates were recorded have none — nothing is guessed.
    paymentDate: paymentDateOf(r),
    billNumber: r.billNumber || null,
    bill: r.proofName ? {
      name: r.proofName,
      onServer: !!r.proofFile,
      mime: r.proofMime || null,
      isImage: !!(r.proofFile && /^image\//.test(r.proofMime || '')),
      isPdf: !!(r.proofFile && /pdf/i.test(r.proofMime || '')),
    } : null,
    bankLine: !!r.bankTxnId,
    addedBy: r.createdById ? (names.get(r.createdById) || 'a removed login') : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt || null,
    notes: r.remarks || r.notes || null,
    atRisk: r.atRisk,
  };
}

router.get('/ledger', async (req, res) => {
  const d = await ledgerData(req.query);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 10));
  const total = d.rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page, 10) || 1));
  const slice = d.rows.slice((page - 1) * pageSize, page * pageSize);
  const names = await peopleOf(slice.map((r) => r.createdById));
  const approver = await isApprover(req.user);
  res.json({
    rows: slice.map((r) => ledgerRow(r, names)),
    page,
    pageSize,
    pages,
    total,
    from: total ? (page - 1) * pageSize + 1 : 0,
    to: Math.min(page * pageSize, total),
    filtered: d.filtered,
    sort: d.sort,
    dir: d.dir,
    totals: d.totals,
    all: d.all,
    options: d.options,
    access: {
      approver,
      override: isAdminLike(req.user),
      export: await can(req.user, 'accounts', 'accounts', 'Office & Expenses', 'export'),
      edit: await can(req.user, 'accounts', 'accounts', 'Office & Expenses', 'edit'),
    },
    definitions: {
      after: 'After GST = Before GST + GST',
      total: 'Total = After GST − TDS we cut (what the vendor is paid)',
      paid: 'Paid = the Total of the bills already paid',
      pending: 'Pending = the Total of the bills not paid yet',
    },
  });
});

// Excel (spec 18) — every row the filters match, with exactly the spec's
// columns. A second sheet says which filters made it and what it adds up to.
router.get('/ledger/export.xlsx', requirePerm('accounts', 'accounts', 'Office & Expenses', 'export'), async (req, res) => {
  const d = await ledgerData(req.query);
  const names = await peopleOf(d.rows.map((r) => r.createdById));
  const ist = (v) => {
    if (!v) return '';
    const t = new Date(new Date(v).getTime() + 330 * 60000).toISOString();
    return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
  };
  // S1.2 / S1.8: the same money columns as the table, and a TOTAL row.
  const head = ['Date', 'Expense ID', 'Category', 'Description', 'Vendor', 'Vendor GSTIN', 'Payment Mode', 'Before GST', 'GST %', 'GST Amount',
    'After GST', 'TDS', 'Total', 'Paid', 'Pending', 'Status', 'Bill/Invoice Number', 'Added By', 'Created Date'];
  const MONEY_COLS = [7, 9, 10, 11, 12, 13, 14];
  // Indian grouping (1,00,000.00) — Excel has no lakh separator of its own.
  const INR_FMT = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';
  const aoa = [head, ...d.rows.map((r) => [
    r.expenseDate || '', r.expenseCode || '', r.category || '', r.description || '', vendorLabel(r), r.effGstin || '', r.paymentMode || '',
    r.base, r.gstRate, r.gst, r.afterGst, r.tds, r.net,
    PAID_LIKE.includes(r.approvalStatus) ? r.net : 0, PENDING_LIKE.includes(r.approvalStatus) ? r.net : 0,
    LEDGER_STATUS_SHORT[r.approvalStatus] || r.approvalStatus, r.billNumber || '',
    r.createdById ? (names.get(r.createdById) || '') : '', ist(r.createdAt),
  ])];
  const tt = d.totals;
  aoa.push(['TOTAL', `${tt.count} expense(s)`, '', '', '', '', '', tt.before, '', tt.gst, tt.after, tt.tds, tt.total, tt.paid, tt.pending, '', '', '', '']);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 1; i < aoa.length; i += 1) {
    MONEY_COLS.forEach((c) => { const ref = XLSX.utils.encode_cell({ r: i, c }); if (ws[ref]) ws[ref].z = INR_FMT; });
  }
  ws['!cols'] = [11, 11, 22, 40, 26, 17, 14, 13, 7, 12, 13, 11, 13, 13, 13, 18, 18, 20, 17].map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: `A1:S${Math.max(1, aoa.length - 1)}` };

  const said = [];
  if (req.query.from || req.query.to) said.push(['Date range', `${req.query.from || '…'} to ${req.query.to || '…'}`]);
  if (listParam(req.query.category).length) said.push(['Category', listParam(req.query.category).join(', ')]);
  if (listParam(req.query.vendor).length) said.push(['Vendor', listParam(req.query.vendor).join(', ')]);
  if (listParam(req.query.mode).length) said.push(['Payment mode', listParam(req.query.mode).join(', ')]);
  if (LEDGER_STATUS_SHORT[String(req.query.status || '').toUpperCase()]) said.push(['Status', LEDGER_STATUS_SHORT[String(req.query.status).toUpperCase()]]);
  if (String(req.query.q || '').trim()) said.push(['Search', String(req.query.q).trim()]);
  if (gstKeyOf(req.query.gst)) said.push(['GST on the bill', GST_FILTERS[gstKeyOf(req.query.gst)].label]);
  if (req.query.tds === 'Yes' || req.query.tds === 'No') said.push(['TDS applicable', req.query.tds]);
  const t = d.totals;
  const sum = XLSX.utils.aoa_to_sheet([
    ['Office expenses — filtered export'],
    ['Filters', said.length ? '' : 'none — every expense'],
    ...said,
    [],
    ['Expenses', t.count],
    ['Before GST', t.before],
    ['GST paid', t.gst],
    ['After GST (Before GST + GST)', t.after],
    ['TDS we cut', t.tds],
    ['Total (After GST − TDS)', t.total],
    ['Paid', t.paid],
    ['Pending', t.pending],
  ]);
  sum['!cols'] = [{ wch: 36 }, { wch: 40 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Expenses');
  XLSX.utils.book_append_sheet(wb, sum, 'Filters & totals');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name || req.user.email || null,
    action: 'Office expenses exported',
    entity: 'OfficeExpense',
    toValue: `${d.rows.length} expense(s) · ${said.length ? said.map(([k, v]) => `${k}: ${v}`).join(' · ') : 'no filters'}`,
  });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${stamp}.xlsx"`);
  res.send(buf);
});

// ===========================================================================
// ONE SOURCE OF TRUTH for the one-page Office & Accounts (v2 spec).
//
// officeFacts() is the ONE helper every money figure on the page comes from:
// the Financial Overview row, the GST reconciliation statement and its detail,
// and the record-based due dates (the Dashboard Reminders card). It reads
// the same officeScope() every other Office view reads (the same decorated
// bills, the same live invoices), so no figure is computed twice in two ways.
//   Total Expenses     Σ (before GST + GST)  of the period's live bills
//   Taxable Expenses   Σ before GST           (the table's Taxable Amount)
//   GST Paid           Σ GST on those bills
//   Input GST Credit   GST on bills whose vendor GSTIN passes the checksum
//   Client Billing     Σ taxable value of the period's invoices (before GST)
//   GST Collected      Σ GST charged on those invoices
//   Net GST            GST Collected − Input GST Credit (+ payable, − credit)
//   Outstanding        Σ still to be received on those invoices (after TDS)
// Live = not REJECTED and not a hand loan; invoices = not Cancelled.
// ===========================================================================
function officeFacts({
  inPeriod, invoicesInPeriod, invoices, all,
}, company) {
  const gstin = cleanId(company.gstin);
  const gc = gstin ? checkGstin(gstin) : null;

  const taxable = ROUND(invoicesInPeriod.reduce((s, i) => s + CNU.billedOf(i), 0));
  const charged = ROUND(invoicesInPeriod.reduce((s, i) => s + CNU.gstBilledOf(i), 0));
  const cli = new Map();
  invoicesInPeriod.forEach((i) => {
    const k = i.client?.name || '—';
    const c = cli.get(k) || {
      name: k, n: 0, taxable: 0, gst: 0, value: 0,
    };
    c.n += 1; c.taxable = ROUND(c.taxable + CNU.billedOf(i));
    c.gst = ROUND(c.gst + CNU.gstBilledOf(i));
    c.value = ROUND(c.taxable + c.gst);
    cli.set(k, c);
  });

  const withGst = inPeriod.filter((r) => r.gst > 0.5);
  const claimRows = withGst.filter((r) => r.gstinOnFile);
  const riskRows = withGst.filter((r) => r.atRisk);
  const purchases = ROUND(withGst.reduce((s, r) => s + r.base, 0));
  const gstPaid = ROUND(withGst.reduce((s, r) => s + r.gst, 0));
  const claimable = ROUND(claimRows.reduce((s, r) => s + r.gst, 0));
  const atRisk = ROUND(gstPaid - claimable);

  const riskByVendor = new Map();
  riskRows.forEach((r) => {
    const k = vendorLabel(r) || `${r.category || 'Unnamed'} (no vendor)`;
    const o = riskByVendor.get(k) || { name: k, gst: 0, bills: [] };
    o.gst = ROUND(o.gst + r.gst);
    if (r.billNumber) o.bills.push(r.billNumber);
    riskByVendor.set(k, o);
  });

  const taxableExp = ROUND(inPeriod.reduce((s, r) => s + r.base, 0));
  const gstOnBills = ROUND(inPeriod.reduce((s, r) => s + r.gst, 0));
  const outstandingOf = (i) => Math.max(0, invoiceOutstanding(i));
  const outstanding = ROUND(invoicesInPeriod.reduce((s, i) => s + outstandingOf(i), 0));

  return {
    overview: {
      totalExpenses: ROUND(taxableExp + gstOnBills),
      taxableExpenses: taxableExp,
      gstPaid: gstOnBills,
      inputCredit: claimable,
      clientBilling: taxable,
      gstCollected: charged,
      netGst: ROUND(charged - claimable),
      outstanding,
      counts: {
        bills: inPeriod.length, invoices: invoicesInPeriod.length, billsWithGst: withGst.length, atRiskBills: riskRows.length,
      },
    },
    recon: {
      outward: {
        taxable,
        charged,
        value: ROUND(taxable + charged),
        invoices: invoicesInPeriod.length,
        clients: [...cli.values()].sort((a, b) => b.value - a.value),
      },
      inward: {
        purchases, bills: withGst.length, gstPaid, claimable, claimableBills: claimRows.length, atRisk, atRiskBills: riskRows.length,
      },
      position: {
        total: ROUND(taxable + charged + purchases),
        billed: ROUND(taxable + charged),
        bought: purchases,
        payable: ROUND(charged - claimable),
        ifFilled: ROUND(charged - gstPaid),
        saving: ROUND(atRisk),
      },
      ourGstin: gstin || null,
      ourGstinValid: !!(gc && gc.ok),
      ourCompany: company.legalName || company.name || null,
      ourState: (gstin ? gstStateName(gstin.slice(0, 2)) : null) || company.state || null,
      ourStateCode: gstin ? gstin.slice(0, 2) : null,
      riskVendors: [...riskByVendor.values()].sort((a, b) => b.gst - a.gst),
      riskBills: riskRows
        .slice()
        .sort((a, b) => b.gst - a.gst || String(b.expenseDate || '').localeCompare(String(a.expenseDate || '')))
        .map((r) => ({
          id: r.id,
          vendor: vendorLabel(r) || null,
          category: r.category,
          date: r.expenseDate,
          billNo: r.billNumber || null,
          base: r.base,
          gst: r.gst,
          gstin: r.effGstin,
        })),
    },
    // Due dates that come off the records: open invoices and bills not paid.
    // The Dashboard's Reminders card reads them through GET /due-dates.
    dues: {
      invoices: (invoices || []).filter((i) => outstandingOf(i) > 0.5 && i.dueDate).map((i) => ({
        kind: 'invoice',
        id: i.id,
        date: String(i.dueDate).slice(0, 10),
        title: `Invoice ${i.invoiceNumber || ''}`.trim(),
        who: i.client?.name || '—',
        amount: ROUND(outstandingOf(i)),
      })),
      bills: (all || []).filter((r) => r.pending && r.dueOn).map((r) => ({
        kind: 'bill',
        id: r.id,
        date: String(r.dueOn).slice(0, 10),
        title: r.expenseCode || 'Bill',
        who: vendorLabel(r) || r.category || '—',
        amount: r.afterGst,
        status: r.approvalStatus,
      })),
    },
  };
}

// (GET /reconciliation and the invoice- / purchase-level reconciliation lists
// were removed by Accounts spec S1.5, 2026-10-05; the GST position below is
// built from the same officeFacts() figures.)

// The one-page payload: the KPI chips, the GST position and the record-based
// due dates — all from officeFacts().
//
// Accounts spec S1.3 (2026-10-05): the page's list filters (search, category,
// vendor, payment mode, status, GST on the bill — the dates come from the
// period) apply to the bills here as well, through the SAME ledgerFilter()
// the table uses, so the KPI chips, the table's TOTAL row and the GST
// position always agree. `kpi` is ledgerTotals() of those bills — exactly
// the table's totals. The invoice (outward) side follows the period only.
router.get('/overview', async (req, res) => {
  const scope = await officeScope(req.query);
  const lf = ledgerFilter({ ...req.query, from: undefined, to: undefined });
  if (lf.active) scope.inPeriod = lf.run(scope.inPeriod);
  const company = (await prisma.company.findFirst()) || {};
  const facts = officeFacts(scope, company);
  const { range } = scope;
  res.json({
    period: {
      sel: req.query.period || 'all', label: range.label, from: range.from, to: range.to, all: !!range.all,
    },
    filtered: lf.active,
    ...facts,
    kpi: ledgerTotals(scope.inPeriod),
    statutory: CAL_DUE,
  });
});

// The due dates alone — what the Dashboard's Reminders card reads (the
// "Upcoming due dates" list moved there from this page). The same dues
// officeFacts() builds for /overview, so the two can never disagree; the
// period does not matter to them (every open invoice, every unpaid bill).
// Behind the same guards as the rest of this router: Office & Expenses view
// and an Accounts-desk role, so a login that cannot open this page gets 403.
router.get('/due-dates', async (req, res) => {
  const scope = await officeScope({ period: 'all' });
  const company = (await prisma.company.findFirst()) || {};
  const { dues } = officeFacts(scope, company);
  res.json({ today: todayIso(), dues, statutory: CAL_DUE });
});

// ---------------------------------------------------------------------------
// Business Details — the Company row is the business profile.
// ---------------------------------------------------------------------------
function shapeProfile(co) {
  const gstin = cleanId(co.gstin);
  const gc = gstin ? checkGstin(gstin) : null;
  const pan = cleanId(co.pan);
  return {
    name: co.legalName || co.name || null,
    gstin: gstin || null,
    gstinCheck: gc ? {
      ok: gc.ok, stateCode: gc.stateCode || gstin.slice(0, 2), stateName: gc.stateName || null, pan: gc.pan || gstin.slice(2, 12), error: gc.error,
    } : null,
    pan: pan || null,
    panSet: !!pan,
    panShown: pan || (gstin && gstin.length >= 12 ? gstin.slice(2, 12) : null),
    tan: cleanId(co.tan) || null,
    bankName: co.bankName || null,
    accountName: co.accountName || null,
    accountNumber: co.accountNumber || null,
    ifsc: cleanId(co.ifsc) || null,
    branch: co.branch || null,
    accountType: co.accountType || null,
    upi: co.upi || null,
  };
}

router.get('/business-profile', async (req, res) => {
  const co = (await prisma.company.findFirst()) || {};
  res.json(shapeProfile(co));
});

router.put('/business-profile', async (req, res) => {
  const b = req.body || {};
  const data = {};
  const bad = (error) => res.status(400).json({ error });
  const txt = (v) => (v == null ? null : String(v).trim() || null);

  if (b.gstin !== undefined) {
    const g = cleanId(b.gstin);
    if (g) {
      const c = checkGstin(g);
      if (!c.ok) return bad(`GSTIN: ${c.error}`);
    }
    data.gstin = g || null;
  }
  if (b.pan !== undefined) {
    const p = cleanId(b.pan);
    if (p && !isPan(p)) return bad('PAN must be 5 letters, 4 digits and a letter — e.g. AAPFU0939F');
    data.pan = p || null;
  }
  const gstinNow = data.gstin !== undefined ? data.gstin : cleanId(((await prisma.company.findFirst()) || {}).gstin);
  if (data.pan && gstinNow && gstinNow.slice(2, 12) !== data.pan) {
    return bad(`PAN ${data.pan} is not the PAN inside the GSTIN (${gstinNow.slice(2, 12)})`);
  }
  if (b.tan !== undefined) {
    const t = cleanId(b.tan);
    if (t && !isTan(t)) return bad('TAN must be 4 letters, 5 digits and a letter — e.g. HYDT12345A');
    data.tan = t || null;
  }
  if (b.ifsc !== undefined) {
    const i = cleanId(b.ifsc);
    if (i && !isIfsc(i)) return bad('IFSC must be 11 characters: 4 letters, a zero, then 6 letters or digits');
    data.ifsc = i || null;
  }
  if (b.accountNumber !== undefined) {
    const a = String(b.accountNumber || '').replace(/\s+/g, '');
    if (a && !/^[0-9]{6,18}$/.test(a)) return bad('Account number must be 6 to 18 digits');
    data.accountNumber = a || null;
  }
  if (b.upi !== undefined) {
    const u = txt(b.upi);
    if (u && !isUpi(u)) return bad('UPI / VPA must look like name@bank');
    data.upi = u;
  }
  if (b.accountType !== undefined) {
    const t = txt(b.accountType);
    if (t && !['Current', 'Savings'].includes(t)) return bad('Account type is Current or Savings');
    data.accountType = t;
  }
  ['bankName', 'branch', 'accountName'].forEach((k) => { if (b[k] !== undefined) data[k] = txt(b[k]); });

  let co = await prisma.company.findFirst();
  if (!co) co = await prisma.company.create({ data: { name: 'TeamLink Consultants' } });
  const updated = await prisma.company.update({ where: { id: co.id }, data });
  // One Audit Log row per field that actually changed, carrying the old value
  // and the new one; the row itself records who and when.
  const LABEL = {
    gstin: 'GSTIN', pan: 'PAN', tan: 'TAN', ifsc: 'IFSC', accountNumber: 'Bank account number', upi: 'UPI / VPA',
    accountType: 'Account type', bankName: 'Bank name', branch: 'Branch', accountName: 'Account name',
  };
  const changed = Object.keys(data).filter((k) => (co[k] ?? null) !== (data[k] ?? null));
  for (const k of changed) {
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      userId: req.user.id,
      action: 'Business details updated',
      entity: 'Company',
      entityId: updated.id,
      field: k,
      fieldLabel: LABEL[k] || k,
      fromValue: co[k] == null || co[k] === '' ? '—' : String(co[k]),
      toValue: data[k] == null || data[k] === '' ? '—' : String(data[k]),
      actorName: req.user.name || req.user.email || null,
    });
  }
  res.json(shapeProfile(updated));
});

// GST / TDS PORTALS — REMOVED (Accounts spec S1.4, 2026-10-05): the Government
// portals launcher, the typed portal balances and the GST / TRACES portal
// logins (routes /portals, /portal-links/:key, /portal-balances, /tax-portals…)
// are gone with their UI. The rows they stored are NOT deleted — PortalLink,
// PortalBalance and the Integration rows 'gst-portal' / 'tds-portal' (the
// encrypted login) stay in the database until the user decides.
//
// BROUGHT BACK (Office spec P1.2 / P2.2, 2026-10-05) — only the two parts the
// user asked for again, the way they worked before S1.4: the launcher (3 small
// cards, one Open button each; the page / address choice behind an Admin-only
// Edit) and the two balances typed in by hand ("In the GST portal", "In
// TRACES" cards). The portal LOGINS (/tax-portals…) stay removed. Same tables,
// same rules, nothing fetched from any portal.
// ---------------------------------------------------------------------------
const PORTALS = [
  {
    key: 'gst',
    name: 'GST portal',
    sub: 'GSTR-1 and GSTR-3B are filed here',
    idLabel: 'GSTIN',
    pages: [
      { key: 'searchtp', label: 'Search taxpayer — no login needed', url: 'https://services.gst.gov.in/services/searchtp' },
      { key: 'returns', label: 'Returns dashboard', url: 'https://return.gst.gov.in/returns/auth/dashboard' },
    ],
  },
  {
    key: 'traces',
    name: 'TRACES – TDS',
    sub: 'Form 16A download and TDS return correction',
    idLabel: 'TAN',
    pages: [{ key: 'home', label: 'TRACES home', url: 'https://www.tdscpc.gov.in' }],
  },
  {
    key: 'incometax',
    name: 'Income Tax e-filing',
    sub: 'TDS challans, 26AS and the annual return',
    idLabel: 'PAN',
    pages: [{ key: 'login', label: 'e-filing login', url: 'https://eportal.incometax.gov.in/iec/foservices/#/login' }],
  },
];
const parsePortalJson = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const portalPeriodKey = (range) => ({ periodStart: range.all ? '' : range.from, periodEnd: range.all ? '' : range.to });
async function portalBalancesFor(range) {
  const { periodStart, periodEnd } = portalPeriodKey(range);
  const rows = await prisma.portalBalance.findMany({ where: { periodStart, periodEnd } });
  const out = { gst: null, traces: null, updatedAt: null };
  rows.forEach((b) => {
    if (b.portalKey in out) out[b.portalKey] = ROUND(b.enteredAmount);
    if (!out.updatedAt || b.updatedAt > out.updatedAt) out.updatedAt = b.updatedAt;
  });
  return out;
}
function shapePortals(links, co) {
  const prof = shapeProfile(co || {});
  const byKey = new Map(links.map((l) => [l.portalKey, l]));
  return PORTALS.map((p) => {
    const row = byKey.get(p.key);
    const edits = parsePortalJson(row?.pageUrls);
    const selectedPage = p.pages.some((pg) => pg.key === row?.selectedPage) ? row.selectedPage : p.pages[0].key;
    const pages = p.pages.map((pg) => ({
      key: pg.key, label: pg.label, defaultUrl: pg.url, url: edits[pg.key] || pg.url, edited: !!edits[pg.key],
    }));
    const idValue = p.idLabel === 'GSTIN' ? prof.gstin : p.idLabel === 'TAN' ? prof.tan : prof.panShown;
    return {
      key: p.key,
      name: p.name,
      sub: p.sub,
      idLabel: p.idLabel,
      idValue: idValue || null,
      pages,
      selectedPage,
      url: pages.find((pg) => pg.key === selectedPage).url,
      lastEditedAt: row?.lastEditedAt || null,
      lastEditedBy: row?.lastEditedBy || null,
    };
  });
}
// Which page a portal button opens / its address: Admin and Super Admin only.
const isOfficeAdmin = (user) => ['ADMIN', 'SUPER_ADMIN'].includes(roleForProduct(user, 'accounts'));

router.get('/portals', async (req, res) => {
  const range = officeRange(req.query.period);
  const [links, co] = await Promise.all([prisma.portalLink.findMany(), prisma.company.findFirst()]);
  res.json({
    portals: shapePortals(links, co),
    balances: await portalBalancesFor(range),
    canEditLinks: isOfficeAdmin(req.user),
    period: {
      sel: req.query.period || 'all', label: range.label, from: range.from, to: range.to, all: !!range.all,
    },
  });
});

router.put('/portal-links/:key', async (req, res) => {
  if (!isOfficeAdmin(req.user)) return res.status(403).json({ error: 'Only Admin can change where a portal button goes.' });
  const p = PORTALS.find((x) => x.key === req.params.key);
  if (!p) return res.status(404).json({ error: 'No such portal' });
  const page = req.body.selectedPage || p.pages[0].key;
  const pg = p.pages.find((x) => x.key === page);
  if (!pg) return res.status(400).json({ error: `${p.name} has no page "${page}"` });
  const existing = await prisma.portalLink.findUnique({ where: { portalKey: p.key } });
  const edits = parsePortalJson(existing?.pageUrls);
  let touchedUrl = false;
  if (req.body.reset) {
    delete edits[page];
    touchedUrl = true;
  } else if (req.body.url !== undefined) {
    const raw = String(req.body.url || '').trim();
    let u;
    try { u = new URL(raw); } catch { u = null; }
    if (!u || !['https:', 'http:'].includes(u.protocol) || raw.length > 500) {
      return res.status(400).json({ error: 'The address must be a full web address starting with https://' });
    }
    if (raw === pg.url) delete edits[page]; else edits[page] = raw;
    touchedUrl = true;
  }
  const data = {
    selectedPage: page,
    url: edits[page] || pg.url,
    pageUrls: JSON.stringify(edits),
    ...(touchedUrl ? { lastEditedAt: new Date(), lastEditedBy: req.user.name || req.user.email || null } : {}),
  };
  await prisma.portalLink.upsert({ where: { portalKey: p.key }, create: { portalKey: p.key, ...data }, update: data });
  await logAudit({
    userId: req.user.id, action: 'Portal address changed', entity: 'PortalLink', entityId: p.key, toValue: `${page}: ${data.url}`,
  });
  const [links, co] = await Promise.all([prisma.portalLink.findMany(), prisma.company.findFirst()]);
  return res.json(shapePortals(links, co).find((x) => x.key === p.key));
});

// The two balances read off the portals by hand, for the period on screen.
// A blank value removes the entry, and the card says "not entered" again.
router.put('/portal-balances', async (req, res) => {
  const range = officeRange(req.body.period);
  const { periodStart, periodEnd } = portalPeriodKey(range);
  const keys = ['gst', 'traces'].filter((k) => req.body[k] !== undefined);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to save — send gst and/or traces' });
  for (const k of keys) {
    const raw = req.body[k];
    if (raw !== null && raw !== '' && !Number.isFinite(Number(raw))) {
      return res.status(400).json({ error: `${k === 'gst' ? 'GST portal' : 'TRACES'} balance must be a number` });
    }
  }
  for (const k of keys) {
    const raw = req.body[k];
    if (raw === null || raw === '') {
      // eslint-disable-next-line no-await-in-loop
      await prisma.portalBalance.deleteMany({ where: { portalKey: k, periodStart, periodEnd } });
    } else {
      const enteredAmount = ROUND(Number(raw));
      const enteredBy = req.user.name || req.user.email || null;
      // eslint-disable-next-line no-await-in-loop
      await prisma.portalBalance.upsert({
        where: { portalKey_periodStart_periodEnd: { portalKey: k, periodStart, periodEnd } },
        create: {
          portalKey: k, periodStart, periodEnd, enteredAmount, enteredBy,
        },
        update: { enteredAmount, enteredBy },
      });
    }
  }
  await logAudit({
    userId: req.user.id, action: 'Portal balance entered', entity: 'PortalBalance', toValue: `${keys.join(', ')} · ${range.label}`,
  });
  return res.json(await portalBalancesFor(range));
});

// The vendor master — the GSTIN a vendor has on every bill.
router.get('/vendors', async (req, res) => {
  res.json(await prisma.officeVendor.findMany({ orderBy: { name: 'asc' } }));
});

// "+ Add Vendor" (Office & Expenses → Expenses & Bills, and the expense forms).
// Same guard as recording an expense: the router-level WRITE guard above
// (accounts · Office & Expenses · edit) on top of the Accounts-desk role gate.
// A vendor name is unique CASE-INSENSITIVELY — against the vendor master and
// against the names already used on bills (both fill the Vendor dropdown), so
// "AIRTEL" cannot be added next to "Airtel". The GST / Tax ID is the master's
// `gstin` (it becomes every bill's fallback GSTIN), so it must pass the real
// checksum when given.
const VENDOR_TEXT = {
  contactPerson: ['Contact person', 120],
  phone: ['Phone', 30],
  email: ['Email', 160],
  address: ['Address', 500],
  paymentTerms: ['Payment terms', 200],
  notes: ['Notes', 1000],
};
router.post('/vendors', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Vendor name is required', field: 'name' });
  if (name.length > 120) return res.status(400).json({ error: 'Keep the vendor name under 120 characters', field: 'name' });
  const data = { name };
  for (const [k, [label, max]] of Object.entries(VENDOR_TEXT)) {
    const v = String(b[k] ?? '').trim();
    if (v.length > max) return res.status(400).json({ error: `${label} must be ${max} characters or fewer`, field: k });
    data[k] = v || null;
  }
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return res.status(400).json({ error: 'Enter a valid email address', field: 'email' });
  }
  if (data.phone && !(/^[+()\d\s-]+$/.test(data.phone) && data.phone.replace(/\D/g, '').length >= 6 && data.phone.replace(/\D/g, '').length <= 15)) {
    return res.status(400).json({ error: 'Enter a valid phone number (6 to 15 digits)', field: 'phone' });
  }
  const g = cleanId(b.gstin || '');
  if (g) {
    const c = checkGstin(g);
    if (!c.ok) return res.status(400).json({ error: `GST / Tax ID: ${c.error}`, field: 'gstin' });
  }
  data.gstin = g || null;

  const key = vendorNameKey(name);
  const [masters, billVendors] = await Promise.all([
    prisma.officeVendor.findMany({ select: { id: true, name: true } }),
    prisma.officeExpense.findMany({ where: { vendor: { not: null } }, select: { vendor: true }, distinct: ['vendor'] }),
  ]);
  const hit = masters.find((v) => vendorNameKey(v.name) === key)
    || billVendors.map((e) => ({ name: String(e.vendor).trim() })).find((v) => vendorNameKey(v.name) === key);
  if (hit) {
    return res.status(409).json({ error: `A vendor named "${hit.name}" already exists — pick it from the Vendor list`, field: 'name', vendor: { name: hit.name } });
  }
  let row;
  try {
    row = await prisma.officeVendor.create({ data });
  } catch (e) {
    if (e && e.code === 'P2002') return res.status(409).json({ error: `A vendor named "${name}" already exists — pick it from the Vendor list`, field: 'name' });
    throw e;
  }
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name || req.user.email || null,
    action: 'Vendor added',
    entity: 'OfficeVendor',
    entityId: row.id,
    fromValue: '— (new)',
    toValue: [row.name, row.gstin && `GSTIN ${row.gstin}`, row.contactPerson, row.phone, row.email, row.paymentTerms && `terms: ${row.paymentTerms}`]
      .filter(Boolean).join(' · ').slice(0, 500),
  });
  return res.status(201).json(row);
});

// What this login may do on the approval lifecycle — the screen asks rather
// than re-deriving the rule.
router.get('/access', async (req, res) => {
  const approver = await isApprover(req.user);
  res.json({
    approver,
    canApprove: approver,
    canEditCategories: approver,
    canOverride: isAdminLike(req.user),
    canAdd: await can(req.user, 'accounts', 'accounts', 'Office & Expenses', 'edit'),
  });
});

// ---------------------------------------------------------------------------
// Categories (spec A). GET answers the active list (all=1 adds the retired
// ones); POST adds one and PATCH retires / restores one — approver only.
// ---------------------------------------------------------------------------
async function categoryList(includeRetired) {
  const [cats, used] = await Promise.all([
    prisma.expenseCategory.findMany({ where: includeRetired ? {} : { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.officeExpense.groupBy({ by: ['category'], _count: { _all: true } }),
  ]);
  const n = new Map(used.map((u) => [u.category, u._count._all]));
  return cats.map((c) => ({
    id: c.id, name: c.name, isActive: c.isActive, expenses: n.get(c.name) || 0,
  }));
}
const findCategory = async (name) => {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const all = await prisma.expenseCategory.findMany();
  return all.find((c) => c.name.toLowerCase() === key) || null;
};
// A category typed on an expense must be on the list. An approver adding a
// bill with a new category adds the category too; anyone else is refused.
async function resolveCategory(user, raw) {
  const name = String(raw || '').trim().slice(0, 120);
  if (!name) return { status: 400, error: 'Category is required' };
  const hit = await findCategory(name);
  if (hit && hit.isActive) return { name: hit.name };
  if (hit) return { status: 400, error: `The category "${hit.name}" has been retired — pick another, or restore it on the category list` };
  if (!(await isApprover(user))) {
    return { status: 403, error: `"${name}" is not on the category list. ${APPROVER_ONLY} — ask an approver to add it.` };
  }
  const row = await prisma.expenseCategory.create({ data: { name, createdById: user.id } });
  await logAudit({
    userId: user.id, action: 'Expense category added', entity: 'ExpenseCategory', entityId: row.id, toValue: name,
  });
  return { name, created: true };
}

router.get('/categories', async (req, res) => {
  res.json(await categoryList(req.query.all === '1' || req.query.all === 'true'));
});

router.post('/categories', async (req, res) => {
  if (!(await isApprover(req.user))) return res.status(403).json({ error: APPROVER_ONLY });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'A category name is required' });
  if (name.length > 60) return res.status(400).json({ error: 'Keep the category name under 60 characters' });
  const hit = await findCategory(name);
  if (hit) {
    return res.status(409).json({
      error: hit.isActive ? `"${hit.name}" is already on the list` : `"${hit.name}" is on the list but retired — restore it instead`,
      category: hit,
    });
  }
  const row = await prisma.expenseCategory.create({ data: { name, createdById: req.user.id } });
  await logAudit({
    userId: req.user.id, action: 'Expense category added', entity: 'ExpenseCategory', entityId: row.id, toValue: name,
  });
  return res.status(201).json({
    id: row.id, name: row.name, isActive: row.isActive, expenses: 0,
  });
});

router.patch('/categories/:id', async (req, res) => {
  if (!(await isApprover(req.user))) return res.status(403).json({ error: APPROVER_ONLY });
  const row = await prisma.expenseCategory.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: 'Category not found' });
  if (req.body.isActive === undefined) return res.status(400).json({ error: 'Send isActive true or false' });
  const isActive = req.body.isActive === true || req.body.isActive === 'true';
  const updated = await prisma.expenseCategory.update({ where: { id: row.id }, data: { isActive } });
  await logAudit({
    userId: req.user.id,
    action: isActive ? 'Expense category restored' : 'Expense category retired',
    entity: 'ExpenseCategory',
    entityId: row.id,
    fromValue: row.isActive ? 'active' : 'retired',
    toValue: isActive ? 'active' : 'retired',
  });
  return res.json({ id: updated.id, name: updated.name, isActive: updated.isActive });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
// A vendor GSTIN typed on a bill must pass the real checksum; blank is fine.
function gstinProblem(body) {
  if (body.vendorGstin === undefined || body.vendorGstin === null) return null;
  const g = cleanId(body.vendorGstin);
  if (!g) return null;
  const c = checkGstin(g);
  return c.ok ? null : `Vendor GSTIN: ${c.error}`;
}

function writeFields(body, data) {
  ['category', 'location', 'vendor', 'expenseDate', 'dueDate', 'notes',
    'description', 'billNumber', 'remarks', 'approvedBy', 'sourceState',
    'expenseAccount', 'destState', 'billableClient'].forEach((k) => {
    if (body[k] !== undefined) data[k] = (typeof body[k] === 'string' ? body[k].trim() : body[k]) || null;
  });
  if (body.vendorGstin !== undefined) data.vendorGstin = cleanId(body.vendorGstin) || null;
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
  if (body.hsnSac !== undefined) data.hsnSac = String(body.hsnSac || '').replace(/\s+/g, '') || null;
  if (body.reverseCharge !== undefined) {
    data.reverseCharge = body.reverseCharge === '' || body.reverseCharge == null ? null
      : (body.reverseCharge === true || body.reverseCharge === 'true' || body.reverseCharge === 'Yes');
  }
  if (body.reportingTags !== undefined) {
    const tags = [...new Set(String(body.reportingTags || '').split(',').map((t) => t.trim()).filter(Boolean))];
    data.reportingTags = tags.length ? tags.join(', ') : null;
  }
  return data;
}

// HSN (goods) is 4, 6 or 8 digits; SAC (services) is 6 digits starting 99.
function hsnProblem(body) {
  if (body.hsnSac === undefined || body.hsnSac === null) return null;
  const v = String(body.hsnSac).replace(/\s+/g, '');
  if (!v) return null;
  if (!/^(\d{4}|\d{6}|\d{8})$/.test(v)) return 'HSN / SAC must be 4, 6 or 8 digits — e.g. 997212 for renting of office space';
  return null;
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

// ---------------------------------------------------------------------------
// EXPENSE ID (one-page spec 10) — EXP-0001, EXP-0002 … in the order expenses
// are recorded. The migration numbered every existing row in date order; a
// row that arrives without one (the Excel import writes straight to the
// table) is numbered the next time the Expenses table is read. The column is
// unique, so two saves at the same moment cannot share a number: the loser
// takes the next one.
// ---------------------------------------------------------------------------
const CODE_RE = /^EXP-(\d+)$/;
// The highest number ever given — on a live row, or on one since deleted (its
// "Expense Created" / "Expense Deleted" audit row keeps it), so a deleted
// expense's ID is never handed out again.
const CODE_LEAD = /^(EXP-\d+)/;
async function maxExpenseNo() {
  const [rows, trail] = await Promise.all([
    prisma.officeExpense.findMany({ where: { expenseCode: { not: null } }, select: { expenseCode: true } }),
    prisma.auditLog.findMany({
      where: { entity: 'OfficeExpense', action: { in: ['Expense Created', 'Expense Deleted'] } },
      select: { fromValue: true, toValue: true },
    }),
  ]);
  const codes = [
    ...rows.map((r) => r.expenseCode),
    ...trail.flatMap((t) => [t.fromValue, t.toValue].map((v) => (CODE_LEAD.exec(String(v || '')) || [])[1])),
  ];
  return codes.reduce((m, c) => {
    const x = CODE_RE.exec(c || '');
    return x ? Math.max(m, Number(x[1])) : m;
  }, 0);
}
const codeOf = (n) => `EXP-${String(n).padStart(4, '0')}`;
const isUniqueClash = (err) => err && err.code === 'P2002';
async function createWithCode(data) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const n = (await maxExpenseNo()) + 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await prisma.officeExpense.create({ data: { ...data, expenseCode: codeOf(n) } });
    } catch (err) {
      if (!isUniqueClash(err)) throw err;
    }
  }
  return prisma.officeExpense.create({ data });
}
async function ensureExpenseCodes() {
  const missing = await prisma.officeExpense.findMany({
    where: { expenseCode: null },
    orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  if (!missing.length) return 0;
  let n = await maxExpenseNo();
  for (const r of missing) {
    n += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      await prisma.officeExpense.updateMany({ where: { id: r.id, expenseCode: null }, data: { expenseCode: codeOf(n) } });
    } catch (err) {
      if (!isUniqueClash(err)) throw err;
      n = (await maxExpenseNo()); // someone else numbered a row meanwhile
    }
  }
  return missing.length;
}

// The clean "+ New Expense" modal (spec 10) sends form: 'quick' and asks for
// more than the older full form did: description, vendor and payment mode are
// required there, and the mode must be one of the seven the modal offers.
function quickProblem(body, isNew) {
  const has = (k) => String(body[k] ?? '').trim().length > 0;
  if (isNew || body.description !== undefined) { if (!has('description')) return 'Description is required'; }
  if (isNew || body.vendor !== undefined) { if (!has('vendor')) return 'Vendor / Paid To is required'; }
  if (isNew || body.paymentMode !== undefined) {
    if (!has('paymentMode')) return 'Payment mode is required';
    if (!LEDGER_MODES.includes(body.paymentMode) && !EXP_MODES.includes(body.paymentMode)) return `Payment mode must be one of: ${LEDGER_MODES.join(', ')}`;
  }
  if (body.gstRatePct !== undefined && body.gstRatePct !== '' && body.gstRatePct != null) {
    const g = Number(body.gstRatePct);
    if (!Number.isFinite(g) || g < 0 || g > 100) return 'GST % must be between 0 and 100';
  }
  if (String(body.description || '').length > 500) return 'Keep the description under 500 characters';
  return null;
}

// The same bill entered twice from the quick modal: same date, same vendor,
// same amount before GST (and the same bill number when both carry one).
async function likelyDuplicate({ expenseDate, vendor, base, billNumber }, exceptId) {
  const v = String(vendor || '').trim().toLowerCase();
  if (!expenseDate || !v) return null;
  const same = await prisma.officeExpense.findMany({ where: { expenseDate } });
  const bn = String(billNumber || '').trim().toLowerCase();
  return same.find((e) => e.id !== exceptId
    && String(e.vendor || '').trim().toLowerCase() === v
    && Math.abs(ROUND(Number(e.monthlyAmount || 0) - Number(e.gstAmount || 0)) - ROUND(base)) < 0.01
    && (!bn || !String(e.billNumber || '').trim() || String(e.billNumber).trim().toLowerCase() === bn)
    && approvalOf(e) !== 'REJECTED') || null;
}

// Audit (spec 21): what a changed field is called, and how its value reads.
const EXP_FIELD_LABEL = {
  category: 'Category', expenseDate: 'Expense date', description: 'Description', vendor: 'Vendor / Paid to',
  paymentMode: 'Payment mode', monthlyAmount: 'Amount after GST', gstAmount: 'GST amount', tdsAmount: 'TDS amount',
  gstRatePct: 'GST %', tdsRatePct: 'TDS %', billNumber: 'Bill / Invoice number', remarks: 'Notes', notes: 'Notes (old)',
  vendorGstin: 'Vendor GSTIN', dueDate: 'Due date', location: 'Location', expenseAccount: 'Expense account',
  frequency: 'Payment frequency', monthsCovered: 'Months covered', entryKind: 'Kind', supplyType: 'Goods or service',
  gstTreatment: 'GST treatment', sourceState: 'Source of supply', destState: 'Destination of supply', hsnSac: 'HSN / SAC',
  reverseCharge: 'Reverse charge', billableClient: 'Billable to', reportingTags: 'Reporting tags', recurring: 'Recurring',
};
const auditVal = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
const codeLabel = (e) => e.expenseCode || e.id;

router.post('/', async (req, res) => {
  const {
    location, vendor, expenseDate, recurring, notes,
  } = req.body;
  // Spec A validation: date required, category required (and on the list),
  // amount > 0 (below).
  if (!String(req.body.category || '').trim()) return res.status(400).json({ error: 'Category is required' });
  if (!isRealDay(expenseDate)) return res.status(400).json({ error: 'Date is required (YYYY-MM-DD)' });
  const gp = gstinProblem(req.body) || hsnProblem(req.body);
  if (gp) return res.status(400).json({ error: gp });
  const quick = req.body.form === 'quick';
  if (quick) {
    const qp = quickProblem(req.body, true);
    if (qp) return res.status(400).json({ error: qp });
  }
  // A new bill is PENDING. Only an approver may record one straight in as
  // APPROVED, PAID or REIMBURSED (e.g. a bill already settled), and that is
  // audited as the approval it is.
  const approver = await isApprover(req.user);
  const wanted = apprList(req.body.approvalStatus ?? req.body.initialStatus)[0] || 'PENDING';
  if (OLD_STATUSES.includes(wanted)) return res.status(400).json({ error: 'A new expense is Pending or Paid — Approved, Rejected and Reimbursed are no longer used.' });
  if (wanted !== 'PENDING' && !approver) return res.status(403).json({ error: `${APPROVER_ONLY}. A new expense starts Pending approval.` });
  // The form asks for the bill amount BEFORE GST, the way the accounting
  // application does; the stored column has always been the gross.
  const base = Number(req.body.baseAmount ?? req.body.monthlyAmount);
  if (!(base > 0)) return res.status(400).json({ error: 'Bill amount must be a positive number' });
  const { gst, tds } = taxAmounts(req.body, base);
  if (gst < 0) return res.status(400).json({ error: 'GST cannot be negative' });
  if (tds < 0 || tds > base + gst) return res.status(400).json({ error: 'TDS cannot be negative or larger than the bill' });

  if (quick && !req.body.allowDuplicate) {
    const dup = await likelyDuplicate({
      expenseDate, vendor: req.body.vendor, base, billNumber: req.body.billNumber,
    });
    if (dup) {
      return res.status(409).json({
        error: `This looks like ${codeLabel(dup)} — the same date, vendor and amount are already on file.`,
        duplicateOf: { id: dup.id, expenseCode: dup.expenseCode || null },
      });
    }
  }

  const cat = await resolveCategory(req.user, req.body.category);
  if (cat.error) return res.status(cat.status).json({ error: cat.error });
  const category = cat.name;

  const data = writeFields(req.body, {
    category,
    location: location || null,
    monthlyAmount: ROUND(base + gst),
    vendor: vendor || null,
    expenseDate,
    gstAmount: ROUND(gst),
    tdsAmount: ROUND(tds),
    recurring: recurring === undefined ? true : !!recurring,
    notes: notes || null,
  });
  // The lifecycle decides the payment status and who approved — never the
  // form's own paidStatus / approvedBy fields.
  const now = new Date();
  const actor = req.user.name || req.user.email || null;
  data.category = category;
  data.approvalStatus = wanted;
  data.paidStatus = (wanted === 'PAID' || wanted === 'REIMBURSED') ? 'Paid' : 'Unpaid';
  data.createdById = req.user.id;
  data.approvedBy = null;
  if (wanted !== 'PENDING') Object.assign(data, { approvedById: req.user.id, approvedAt: now, approvedBy: actor });
  if (wanted === 'PAID') Object.assign(data, { paidById: req.user.id, paidAt: now });
  if (wanted === 'REIMBURSED') Object.assign(data, { reimbursedById: req.user.id, reimbursedAt: now });
  const expense = await createWithCode(data);
  // Spec 21: "Expense Created" with the Expense ID and what was recorded.
  await logAudit({
    userId: req.user.id,
    actorName: actor,
    action: 'Expense Created',
    entity: 'OfficeExpense',
    entityId: expense.id,
    fromValue: '— (new)',
    toValue: `${codeLabel(expense)} · ${expenseDate} · ${category} · ${String(expense.description || '').slice(0, 80) || '—'} · ${expense.vendor || '—'} · ${expense.paymentMode || '—'} · amount ₹${ROUND(base)} + GST ₹${ROUND(gst)} = ₹${ROUND(base + gst)}${tds > 0 ? ` · TDS ₹${ROUND(tds)}` : ''} · ${APPROVAL_LABEL[wanted]}`,
    approvalStatus: wanted,
  });
  if (wanted !== 'PENDING') {
    await logAudit({
      userId: req.user.id,
      actorName: actor,
      action: `Office expense status: ${APPROVAL_LABEL[wanted]}`,
      entity: 'OfficeExpense',
      entityId: expense.id,
      field: 'approvalStatus',
      fieldLabel: 'Approval status',
      fromValue: '— (new)',
      toValue: wanted,
      reason: 'Recorded by an approver at creation',
      approvalStatus: wanted,
      approvedByName: actor,
      approvedAt: now,
    });
  }
  res.status(201).json(decorate(expense));
});

// PUT /:id (spec A) and PATCH /:id (the edit form) — one handler.
// Editable only while PENDING. After that the server answers 409, except that
// Super Admin / Admin may still correct a bill by sending override: true with
// an overrideReason — recorded in the audit log as the override it is.
async function updateExpense(req, res) {
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const status = approvalOf(existing);
  const override = req.body.override === true || req.body.override === 'true';
  const overrideReason = String(req.body.overrideReason || '').trim();
  if (status !== 'PENDING') {
    if (!override) {
      return res.status(409).json({
        error: `This expense is ${APPROVAL_LABEL[status]} — it can be edited only while Pending approval`,
        status,
      });
    }
    if (!isAdminLike(req.user)) {
      return res.status(403).json({ error: 'Only Super Admin or Admin may correct an expense after it has been approved' });
    }
    if (!overrideReason) return res.status(400).json({ error: 'Say why this approved expense is being corrected' });
  }
  const gp = gstinProblem(req.body) || hsnProblem(req.body);
  if (gp) return res.status(400).json({ error: gp });
  if (req.body.expenseDate !== undefined && !isRealDay(req.body.expenseDate)) {
    return res.status(400).json({ error: 'Date is required (YYYY-MM-DD)' });
  }
  if (req.body.form === 'quick') {
    const qp = quickProblem(req.body, false);
    if (qp) return res.status(400).json({ error: qp });
  }
  const data = writeFields(req.body, {});
  // The Expense ID, Created By and Created At never change on an edit.
  delete data.expenseCode;
  delete data.createdById;
  // Status and approver are the lifecycle's (PATCH /:id/status), not the form's.
  delete data.paidStatus;
  delete data.approvedBy;
  if (req.body.category !== undefined && String(req.body.category || '').trim() !== existing.category) {
    const cat = await resolveCategory(req.user, req.body.category);
    if (cat.error) return res.status(cat.status).json({ error: cat.error });
    data.category = cat.name;
  } else {
    delete data.category;
  }

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

  // Modified By (spec 13); Modified At is updatedAt, which Prisma stamps.
  data.updatedById = req.user.id;
  const expense = await prisma.officeExpense.update({ where: { id: existing.id }, data });
  const changed = Object.keys(data).filter((k) => k !== 'updatedById' && String(existing[k] ?? '') !== String(data[k] ?? ''));
  // Spec 21: "Expense Updated" — one row per field that really changed, with
  // the old value and the new one, keyed to the Expense ID.
  for (const k of changed) {
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name || req.user.email || null,
      action: 'Expense Updated',
      entity: 'OfficeExpense',
      entityId: expense.id,
      field: k,
      fieldLabel: `${codeLabel(expense)} · ${EXP_FIELD_LABEL[k] || k}`,
      fromValue: auditVal(existing[k]),
      toValue: auditVal(data[k]),
      reason: status !== 'PENDING' ? overrideReason : null,
      approvalStatus: status,
    });
  }
  if (status !== 'PENDING') {
    await logAudit({
      userId: req.user.id,
      actorName: req.user.name || req.user.email || null,
      action: 'Office expense corrected after approval (override)',
      entity: 'OfficeExpense',
      entityId: expense.id,
      fromValue: status,
      toValue: changed.length ? `changed: ${changed.join(', ')}` : 'no field changed',
      reason: overrideReason,
      approvalStatus: status,
    });
  } else if (!changed.length) {
    await logAudit({
      userId: req.user.id, action: 'Expense Updated', entity: 'OfficeExpense', entityId: expense.id, toValue: `${codeLabel(expense)} · no field changed`,
    });
  }
  return res.json(decorate(expense));
}
router.patch('/:id', updateExpense);
router.put('/:id', updateExpense);

// PATCH /:id/status — the lifecycle. { action: approve | reject | mark_paid }
// (or { status: APPROVED | REJECTED | PAID }); reject needs a reason.
//   PENDING  -> APPROVED | REJECTED
//   APPROVED -> PAID
//   APPROVED | PAID -> REIMBURSED   (mark_reimbursed — one-page spec)
// Approver only. The move is conditional on the status the row had when it was
// read, so two people deciding at once cannot both win. Every move is audited.
const STATUS_ACTIONS = {
  APPROVE: 'APPROVED', APPROVED: 'APPROVED', REJECT: 'REJECTED', REJECTED: 'REJECTED', MARK_PAID: 'PAID', PAID: 'PAID', PAY: 'PAID',
  MARK_REIMBURSED: 'REIMBURSED', REIMBURSE: 'REIMBURSED', REIMBURSED: 'REIMBURSED',
};
// Accounts spec S1.3c (2026-10-05): Approved, Rejected and Reimbursed are no
// longer used. A bill goes Pending -> Paid (marking it paid is the approval,
// recorded as such); an old Approved row can still be marked paid. Nothing
// stored is rewritten.
const NEXT = { PENDING: ['PAID'], APPROVED: ['PAID'] };
const RETIRED_MOVE = 'Approved, Rejected and Reimbursed are no longer used — mark the expense Paid when the money goes out, or delete it if it should not be in the books.';
router.patch('/:id/status', async (req, res) => {
  if (!(await isApprover(req.user))) return res.status(403).json({ error: APPROVER_ONLY });
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const raw = String(req.body.action || req.body.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const to = STATUS_ACTIONS[raw];
  if (!to) return res.status(400).json({ error: 'action must be approve, reject, mark_paid or mark_reimbursed' });
  const from = approvalOf(existing);
  if (OLD_STATUSES.includes(to)) return res.status(400).json({ error: RETIRED_MOVE, status: from });
  if (!(NEXT[from] || []).includes(to)) {
    return res.status(409).json({
      error: `An expense that is ${APPROVAL_LABEL[from]} cannot be moved to ${APPROVAL_LABEL[to]}`,
      status: from,
    });
  }
  const reason = String(req.body.reason || '').trim();
  if (to === 'REJECTED' && reason.length < 3) return res.status(400).json({ error: 'A reason is required to reject an expense' });
  const now = new Date();
  const actor = req.user.name || req.user.email || null;
  const data = { approvalStatus: to, updatedById: req.user.id };
  if (to === 'APPROVED') Object.assign(data, { approvedById: req.user.id, approvedAt: now, approvedBy: actor });
  if (to === 'REJECTED') Object.assign(data, { rejectedById: req.user.id, rejectedAt: now, rejectionReason: reason.slice(0, 500) });
  if (to === 'PAID') {
    Object.assign(data, { paidById: req.user.id, paidAt: now, paidStatus: 'Paid' });
    // Straight from Pending: marking it paid is the approval as well.
    if (from === 'PENDING') Object.assign(data, { approvedById: req.user.id, approvedAt: now, approvedBy: actor });
    if (req.body.paymentMode !== undefined && EXP_MODES.includes(req.body.paymentMode)) data.paymentMode = req.body.paymentMode;
  }
  // Reimbursed is money out as well — the payment status follows.
  if (to === 'REIMBURSED') Object.assign(data, { reimbursedById: req.user.id, reimbursedAt: now, paidStatus: 'Paid' });
  const done = await prisma.officeExpense.updateMany({ where: { id: existing.id, approvalStatus: existing.approvalStatus }, data });
  if (done.count !== 1) return res.status(409).json({ error: 'Someone else changed this expense a moment ago — reload and try again' });
  await logAudit({
    userId: req.user.id,
    actorName: actor,
    action: `Office expense status: ${APPROVAL_LABEL[to]}`,
    entity: 'OfficeExpense',
    entityId: existing.id,
    field: 'approvalStatus',
    fieldLabel: 'Approval status',
    fromValue: from,
    toValue: to,
    reason: to === 'REJECTED' ? reason : (reason || null),
    approvalStatus: to,
    approvedByName: actor,
    approvedAt: now,
  });
  return res.json(await expenseDetail(existing.id, req.user));
});

// One expense with the people behind it — the row-click accordion's detail.
async function expenseDetail(id, user) {
  const e = await prisma.officeExpense.findUnique({ where: { id } });
  if (!e) return null;
  const ids = [...new Set([e.createdById, e.approvedById, e.rejectedById, e.paidById, e.updatedById, e.reimbursedById].filter(Boolean))];
  const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : [];
  const who = (uid) => {
    if (!uid) return null;
    const p = people.find((x) => x.id === uid);
    return { id: uid, name: p ? (p.name || p.email) : 'a removed login' };
  };
  const d = decorate(e, await vendorMapOf());
  const approver = await isApprover(user);
  const st = d.approvalStatus;
  return {
    ...d,
    amount: d.net,
    status: st,
    statusText: APPROVAL_LABEL[st],
    createdBy: who(e.createdById),
    approvedByUser: who(e.approvedById) || (e.approvedBy ? { id: null, name: e.approvedBy } : null),
    rejectedBy: who(e.rejectedById),
    paidByUser: who(e.paidById),
    // One-page spec: Modified By / At and who marked it reimbursed.
    updatedBy: who(e.updatedById),
    reimbursedByUser: who(e.reimbursedById),
    attachment: e.proofName ? {
      name: e.proofName,
      mime: e.proofMime || null,
      size: e.proofSize || null,
      url: e.proofFile ? `/api/office-expenses/${e.id}/proof/file` : null,
      isImage: !!(e.proofFile && /^image\//.test(e.proofMime || '')),
      onServer: !!e.proofFile,
    } : null,
    can: {
      approve: false,
      reject: false,
      markPaid: approver && (st === 'PENDING' || st === 'APPROVED'),
      markReimbursed: false,
      edit: st === 'PENDING',
      override: st !== 'PENDING' && isAdminLike(user),
      // The same rule DELETE /:id enforces.
      delete: ['PENDING', 'REJECTED'].includes(st) || approver,
    },
  };
}

// "Add GSTIN" on an at-risk bill: the vendor's GSTIN goes on THIS bill (and,
// when asked, on the vendor master so every bill from them has it). The input
// credit is recomputed from the record on the next read, so a bill whose
// GSTIN now passes the checksum leaves the at-risk list by itself.
router.post('/:id/gstin', async (req, res) => {
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const c = checkGstin(req.body.gstin);
  if (!c.ok) return res.status(400).json({ error: `GSTIN: ${c.error}` });
  const expense = await prisma.officeExpense.update({ where: { id: existing.id }, data: { vendorGstin: c.gstin, updatedById: req.user.id } });
  const vendor = String(existing.vendor || '').trim();
  if (req.body.rememberForVendor && vendor) {
    await prisma.officeVendor.upsert({
      where: { name: vendor }, create: { name: vendor, gstin: c.gstin }, update: { gstin: c.gstin },
    });
  }
  await logAudit({
    userId: req.user.id, action: 'Vendor GSTIN added to bill', entity: 'OfficeExpense', entityId: expense.id, fromValue: existing.vendorGstin || '—', toValue: c.gstin,
  });
  res.json(decorate(expense, await vendorMapOf()));
});

// Proof of payment / the vendor's tax invoice. Two ways in:
//   * multipart/form-data with a `file` part — the bytes are stored by
//     utils/attachments.js (PNG, JPEG, WebP or PDF, 5 MB, magic bytes checked,
//     random name on disk outside the repository) and proofFile keeps that
//     stored name;
//   * JSON { proofName } — the older "type the file name" path the Proofs tab
//     uses, which records the name only.
router.post('/:id/proof', async (req, res) => {
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const stamp = { proofAt: todayIso(), proofBy: req.user.name || req.user.email || null };
  let data;
  if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    let parsed;
    try {
      parsed = await attachments.parseMultipart(req);
    } catch (err) {
      return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' });
    }
    let stored;
    try {
      stored = attachments.store(parsed.file);
    } catch (err) {
      return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not store the upload.' });
    }
    data = {
      proofName: stored.billName, proofMime: stored.billMime, proofSize: stored.billSize, proofFile: stored.billFile, ...stamp,
    };
  } else {
    const typed = String(req.body.proofName || '').trim();
    if (!typed) return res.status(400).json({ error: 'A file name is required' });
    data = {
      proofName: typed,
      proofMime: req.body.proofMime || null,
      proofSize: Number(req.body.proofSize) > 0 ? Math.round(Number(req.body.proofSize)) : null,
      proofFile: null,
      ...stamp,
    };
  }
  // Replacing a proof removes the old bytes rather than orphaning them.
  if (existing.proofFile && existing.proofFile !== data.proofFile) attachments.remove(existing.proofFile);
  const expense = await prisma.officeExpense.update({ where: { id: existing.id }, data: { ...data, updatedById: req.user.id } });
  const name = data.proofName;
  // Spec 21: "Bill Uploaded" the first time, "Bill Updated" when it replaces one.
  const replacing = !!(existing.proofName || existing.proofFile);
  await logAudit({
    userId: req.user.id,
    actorName: req.user.name || req.user.email || null,
    action: replacing ? 'Bill Updated' : 'Bill Uploaded',
    entity: 'OfficeExpense',
    entityId: expense.id,
    field: 'proofName',
    fieldLabel: `${codeLabel(expense)} · Bill / Invoice file`,
    fromValue: replacing ? auditVal(existing.proofName) : '—',
    toValue: `${name}${data.proofFile ? '' : ' (name only, no file)'}`,
  });
  res.json(decorate(expense));
});

// The uploaded proof itself. Same guard as the register; the path is rebuilt
// from the stored name only after utils/attachments.js has re-validated it.
// ?inline=1 is the bill preview (View); without it the file is sent as an
// attachment (Download). Only PDF / PNG / JPEG / WebP are ever stored, and
// nosniff stays on either way.
router.get('/:id/proof/file', async (req, res) => {
  const e = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!e) return res.status(404).json({ error: 'Expense not found' });
  if (!e.proofFile) return res.status(404).json({ error: 'No file was uploaded for this expense — only its name is on record' });
  const full = attachments.resolveStored(e.proofFile);
  if (!full) return res.status(404).json({ error: 'The attached file is no longer on the server' });
  res.setHeader('Content-Type', e.proofMime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const inline = req.query.inline === '1' || req.query.inline === 'true';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${attachments.safeDisplayName(e.proofName)}"`);
  return res.sendFile(full);
});

// The bank statement line an expense was paid off (OfficeExpense.bankTxnId),
// with the lines either side of it on the same account, so "View line" shows
// the statement as the bank printed it.
router.get('/:id/bank-line', async (req, res) => {
  const e = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!e) return res.status(404).json({ error: 'Expense not found' });
  if (!e.bankTxnId) return res.status(404).json({ error: 'This expense is not matched to a bank statement line' });
  const txn = await prisma.bankTransaction.findUnique({ where: { id: e.bankTxnId } });
  if (!txn) return res.status(404).json({ error: 'The bank line this expense was matched to is no longer on file' });
  const accounts = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } });
  const firstId = accounts[0]?.id || null;
  const accId = txn.bankAccountId || firstId;
  const all = await prisma.bankTransaction.findMany({ orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] });
  const same = all.filter((t) => (t.bankAccountId || firstId) === accId);
  const at = same.findIndex((t) => t.id === txn.id);
  const shape = (t) => ({
    id: t.id,
    date: t.date,
    description: t.description,
    reference: t.reference,
    type: t.type,
    amount: t.amount,
    balance: t.balance,
    reconStatus: t.reconStatus,
    match: t.id === txn.id,
  });
  const acc = accounts.find((a) => a.id === accId) || null;
  const d = decorate(e, await vendorMapOf());
  return res.json({
    expense: {
      id: d.id,
      vendor: d.vendor,
      billName: d.billName,
      expenseDate: d.expenseDate,
      net: d.net,
      gst: d.gst,
      statusLabel: d.statusLabel,
      proofName: d.proofName,
      taxInvoiceNeeded: d.taxInvoiceNeeded,
    },
    line: shape(txn),
    around: (at >= 0 ? same.slice(Math.max(0, at - 2), at + 3) : [txn]).map(shape),
    account: acc ? {
      bank: acc.bank, name: acc.name, accNo: acc.accNo ? `··${String(acc.accNo).slice(-4)}` : null, branch: acc.branch,
    } : null,
    difference: ROUND(Number(txn.amount || 0) - d.net),
  });
});

router.delete('/:id/proof', async (req, res) => {
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  if (existing.proofFile) attachments.remove(existing.proofFile);
  const expense = await prisma.officeExpense.update({
    where: { id: existing.id },
    data: {
      proofName: null, proofMime: null, proofSize: null, proofAt: null, proofBy: null, proofFile: null,
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
  // A bill still Pending (or Rejected) is anyone's on the desk to withdraw;
  // an approved or paid one is on the books, so only an approver removes it
  // (the Proofs tab's duplicate clean-up is exactly that).
  const status = approvalOf(existing);
  if (!['PENDING', 'REJECTED'].includes(status) && !(await isApprover(req.user))) {
    return res.status(403).json({ error: `This expense is ${APPROVAL_LABEL[status]}. ${APPROVER_ONLY}` });
  }
  await prisma.officeExpense.delete({ where: { id: existing.id } });
  if (existing.proofFile) attachments.remove(existing.proofFile);
  // Accounts S5: the bank line this bill was proof-linked to goes back to
  // uncategorised (the line itself is never deleted).
  if (existing.bankTxnId) await require('./bank').releaseLineForBill(existing).catch(() => null);
  await logAudit({
    // Spec 21: "Expense Deleted", with the Expense ID and the record as it was.
    userId: req.user.id,
    actorName: req.user.name || req.user.email || null,
    action: 'Expense Deleted',
    entity: 'OfficeExpense',
    entityId: existing.id,
    fromValue: `${codeLabel(existing)} · ${existing.expenseDate || '—'} · ${existing.category} · ${String(existing.description || '').slice(0, 80) || '—'} · ${existing.vendor || '—'} · ${existing.paymentMode || '—'} · amount ₹${ROUND(Number(existing.monthlyAmount || 0) - Number(existing.gstAmount || 0))} + GST ₹${ROUND(existing.gstAmount || 0)} = ₹${existing.monthlyAmount}${Number(existing.tdsAmount || 0) > 0 ? ` · TDS ₹${existing.tdsAmount}` : ''} · ${APPROVAL_LABEL[status] || status}${existing.billNumber ? ` · bill ${existing.billNumber}` : ''}${existing.proofName ? ` · file ${existing.proofName}` : ''}`,
    toValue: '— (deleted)',
    approvalStatus: status,
  });
  res.json({ ok: true });
});

// GET /:id — last, so every fixed GET path above wins.
router.get('/:id', async (req, res) => {
  const d = await expenseDetail(req.params.id, req.user);
  if (!d) return res.status(404).json({ error: 'Expense not found' });
  return res.json(d);
});

// The Accounts Dashboard (utils/accountsControl.js) reads the SAME office
// numbers as this page — no second expense / GST formula.
Object.assign(router, {
  officeScope, officeFacts, ledgerData, PAID_LIKE, PENDING_LIKE, vendorLabel,
  // Vendor portal (routes/vendorBills.js): an APPROVED vendor bill is booked through the same numbering / category / approver rules.
  createWithCode, isApprover, resolveCategory, decorate, APPROVAL_LABEL,
});
module.exports = router;
