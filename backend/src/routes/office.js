const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const {
  ROUND, dashRange, inRange, monthLabel, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus,
} = require('../utils/accounts');

const XLSX = require('xlsx');
const attachments = require('../utils/attachments');
const { roleForProduct, SET, can } = require('../utils/permissions');
const {
  checkGstin, isPan, isTan, isIfsc, isUpi, clean: cleanId, stateName: gstStateName,
} = require('../utils/gstin');
const {
  secretsConfigured, encryptSecret, decryptSecret, isEncrypted, NO_KEY_MESSAGE,
} = require('../utils/secrets');
const { parseValues } = require('../utils/integrationStore');

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
    inc.set(k, ROUND((inc.get(k) || 0) + Number(i.amount || 0)));
    gstOut.set(k, ROUND((gstOut.get(k) || 0) + Number(i.gst || 0)));
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

const portalPeriodKey = (range) => ({
  periodStart: range.all ? '' : range.from,
  periodEnd: range.all ? '' : range.to,
});

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
  const gstReceived = ROUND(invoicesInPeriod.reduce((s, i) => s + Number(i.gst || 0), 0));
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
      portalBalances: await portalBalancesFor(range),
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
        r.effGstin || '', r.paymentMode || '', APPROVAL_LABEL[r.approvalStatus] || r.statusLabel, ...money(r), r.paidValue, r.pendingValue,
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
// Status: every approval status is listed as it is. For the totals,
//   Paid    = PAID + REIMBURSED  (money out)
//   Pending = PENDING + APPROVED (not paid yet)
// REJECTED is out of the books, as everywhere on this module: listed only when
// the Status filter asks for it. Hand loans are not expenses and never listed.
// ===========================================================================
const LEDGER_STATUS = [['PAID', 'Paid'], ['PENDING', 'Pending'], ['REIMBURSED', 'Reimbursed'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']];
const LEDGER_STATUS_SHORT = Object.fromEntries(LEDGER_STATUS);
const PAID_LIKE = ['PAID', 'REIMBURSED'];
const PENDING_LIKE = ['PENDING', 'APPROVED'];
const codeNo = (r) => { const x = CODE_RE.exec(r.expenseCode || ''); return x ? Number(x[1]) : 0; };
const LEDGER_SORTS = {
  date: (r) => String(r.expenseDate || ''),
  code: codeNo,
  amount: (r) => r.base,
  total: (r) => r.afterGst,
};

function ledgerTotals(list) {
  const s = (l, f) => ROUND(l.reduce((a, r) => a + f(r), 0));
  return {
    count: list.length,
    amount: s(list, (r) => r.base),
    gst: s(list, (r) => r.gst),
    total: s(list, (r) => r.afterGst),
    tds: s(list, (r) => r.tds),
    paid: s(list.filter((r) => PAID_LIKE.includes(r.approvalStatus)), (r) => r.afterGst),
    pending: s(list.filter((r) => PENDING_LIKE.includes(r.approvalStatus)), (r) => r.afterGst),
  };
}

async function ledgerData(q) {
  await ensureExpenseCodes();
  const [expenses, vendorMap, catRows] = await Promise.all([
    prisma.officeExpense.findMany({ orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }] }),
    vendorMapOf(),
    prisma.expenseCategory.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
  ]);
  const decorated = expenses.map((e) => decorate(e, vendorMap)).filter((r) => r.entryKind !== 'hand');
  const status = String(q.status || '').trim().toUpperCase();
  const books = decorated.filter((r) => r.approvalStatus !== 'REJECTED');
  const pool = status === 'REJECTED' ? decorated.filter((r) => r.approvalStatus === 'REJECTED') : books;

  let rows = pool;
  const from = ISO_DAY.test(String(q.from || '')) ? q.from : null;
  const to = ISO_DAY.test(String(q.to || '')) ? q.to : null;
  if (from) rows = rows.filter((r) => r.expenseDate && r.expenseDate >= from);
  if (to) rows = rows.filter((r) => r.expenseDate && r.expenseDate <= to);
  const cats = listParam(q.category);
  if (cats.length) rows = rows.filter((r) => cats.includes(r.category));
  const vens = listParam(q.vendor);
  if (vens.length) rows = rows.filter((r) => vens.includes(vendorLabel(r)));
  const modes = listParam(q.mode);
  if (modes.length) rows = rows.filter((r) => modes.includes(r.paymentMode || ''));
  if (LEDGER_STATUS_SHORT[status] && status !== 'REJECTED') rows = rows.filter((r) => r.approvalStatus === status);
  // v2 §3: GST Applicable / TDS Applicable (Yes = the bill carries it).
  if (q.gst === 'Yes' || q.gst === 'No') rows = rows.filter((r) => (q.gst === 'Yes') === (r.gst > 0.5));
  if (q.tds === 'Yes' || q.tds === 'No') rows = rows.filter((r) => (q.tds === 'Yes') === (r.tds > 0.5));
  // Search (spec 17): Expense ID, description, vendor and category.
  const term = String(q.q || '').trim().toLowerCase();
  if (term) {
    rows = rows.filter((r) => [r.expenseCode, r.description, r.vendor, r.category]
      .map((x) => String(x || '')).join(' ').toLowerCase().includes(term));
  }

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

  const filtered = !!(from || to || cats.length || vens.length || modes.length || term || LEDGER_STATUS_SHORT[status]
    || q.gst === 'Yes' || q.gst === 'No' || q.tds === 'Yes' || q.tds === 'No');
  const usedCats = [...new Set(decorated.map((r) => r.category).filter(Boolean))];
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
      statuses: LEDGER_STATUS.map(([value, label]) => ({ value, label })),
      gstRates: GST_RATES,
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
    total: r.afterGst,
    tds: r.tds,
    tdsRate: r.tdsRate,
    netAfterTds: r.net,
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
      total: 'Total Amount = Amount + GST Amount',
      paid: 'Total Paid = Paid + Reimbursed',
      pending: 'Total Pending = Pending + Approved (approved, not paid yet)',
      rejected: 'Rejected expenses are out of the books — pick Status: Rejected to list them',
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
  const head = ['Date', 'Expense ID', 'Category', 'Description', 'Vendor', 'Payment Mode', 'Amount', 'GST %', 'GST Amount',
    'Total Amount', 'Status', 'Bill/Invoice Number', 'Added By', 'Created Date'];
  const aoa = [head, ...d.rows.map((r) => [
    r.expenseDate || '', r.expenseCode || '', r.category || '', r.description || '', vendorLabel(r), r.paymentMode || '',
    r.base, r.gstRate, r.gst, r.afterGst, LEDGER_STATUS_SHORT[r.approvalStatus] || r.approvalStatus, r.billNumber || '',
    r.createdById ? (names.get(r.createdById) || '') : '', ist(r.createdAt),
  ])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 1; i < aoa.length; i += 1) {
    [6, 8, 9].forEach((c) => { const ref = XLSX.utils.encode_cell({ r: i, c }); if (ws[ref]) ws[ref].z = '#,##0.00'; });
  }
  ws['!cols'] = [11, 11, 22, 40, 26, 14, 13, 7, 12, 13, 11, 18, 20, 17].map((wch) => ({ wch }));
  ws['!autofilter'] = { ref: `A1:N${Math.max(1, aoa.length)}` };

  const said = [];
  if (req.query.from || req.query.to) said.push(['Date range', `${req.query.from || '…'} to ${req.query.to || '…'}`]);
  if (listParam(req.query.category).length) said.push(['Category', listParam(req.query.category).join(', ')]);
  if (listParam(req.query.vendor).length) said.push(['Vendor', listParam(req.query.vendor).join(', ')]);
  if (listParam(req.query.mode).length) said.push(['Payment mode', listParam(req.query.mode).join(', ')]);
  if (LEDGER_STATUS_SHORT[String(req.query.status || '').toUpperCase()]) said.push(['Status', LEDGER_STATUS_SHORT[String(req.query.status).toUpperCase()]]);
  if (String(req.query.q || '').trim()) said.push(['Search', String(req.query.q).trim()]);
  if (req.query.gst === 'Yes' || req.query.gst === 'No') said.push(['GST applicable', req.query.gst]);
  if (req.query.tds === 'Yes' || req.query.tds === 'No') said.push(['TDS applicable', req.query.tds]);
  const t = d.totals;
  const sum = XLSX.utils.aoa_to_sheet([
    ['Office expenses — filtered export'],
    ['Filters', said.length ? '' : 'none — every expense'],
    ...said,
    [],
    ['Expenses', t.count],
    ['Total Expenses (Amount + GST)', t.total],
    ['Total GST', t.gst],
    ['Total Paid (Paid + Reimbursed)', t.paid],
    ['Total Pending (Pending + Approved)', t.pending],
    [],
    ['Rejected expenses are out of the books and are included only when the Status filter is Rejected.'],
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

  const taxable = ROUND(invoicesInPeriod.reduce((s, i) => s + Number(i.amount || 0), 0));
  const charged = ROUND(invoicesInPeriod.reduce((s, i) => s + Number(i.gst || 0), 0));
  const cli = new Map();
  invoicesInPeriod.forEach((i) => {
    const k = i.client?.name || '—';
    const c = cli.get(k) || {
      name: k, n: 0, taxable: 0, gst: 0, value: 0,
    };
    c.n += 1; c.taxable = ROUND(c.taxable + Number(i.amount || 0));
    c.gst = ROUND(c.gst + Number(i.gst || 0));
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
      // Purchase-level reconciliation: every bill with GST in the period.
      purchases: withGst
        .slice()
        .sort((a, b) => String(b.expenseDate || '').localeCompare(String(a.expenseDate || '')))
        .map((r) => ({
          id: r.id,
          expenseCode: r.expenseCode || null,
          date: r.expenseDate,
          vendor: vendorLabel(r) || null,
          category: r.category,
          billNo: r.billNumber || null,
          base: r.base,
          rate: r.gstRate,
          gst: r.gst,
          gstin: r.effGstin,
          claimable: !!r.gstinOnFile,
        })),
      // Invoice-level: every invoice raised in the period, with its GST.
      invoices: invoicesInPeriod
        .slice()
        .sort((a, b) => String(b.invoiceDate || '').localeCompare(String(a.invoiceDate || '')))
        .map((i) => ({
          id: i.id,
          invoiceNumber: i.invoiceNumber || null,
          client: i.client?.name || '—',
          date: i.invoiceDate || null,
          taxable: ROUND(Number(i.amount || 0)),
          gst: ROUND(Number(i.gst || 0)),
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

// ---------------------------------------------------------------------------
// GST reconciliation — outward (what we billed clients, read from the
// invoicing module) against inward (what we bought), and the position.
// Uses the period only: a category filter must not change what is owed.
// Same numbers as before; they now come from officeFacts() above.
// ---------------------------------------------------------------------------
router.get('/reconciliation', async (req, res) => {
  const scope = await officeScope(req.query);
  const company = (await prisma.company.findFirst()) || {};
  const { recon } = officeFacts(scope, company);
  const { range } = scope;
  // eslint-disable-next-line no-unused-vars
  const { purchases, invoices, ...legacy } = recon;
  res.json({
    period: {
      sel: req.query.period || 'all', label: range.label, from: range.from, to: range.to, all: !!range.all,
    },
    ...legacy,
  });
});

// The one-page payload: Financial Overview, GST reconciliation (with its
// invoice- and purchase-level detail) and the record-based due dates — all
// from officeFacts().
router.get('/overview', async (req, res) => {
  const scope = await officeScope(req.query);
  const company = (await prisma.company.findFirst()) || {};
  const facts = officeFacts(scope, company);
  const { range } = scope;
  res.json({
    period: {
      sel: req.query.period || 'all', label: range.label, from: range.from, to: range.to, all: !!range.all,
    },
    ...facts,
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

// ---------------------------------------------------------------------------
// Government portals — a link launcher and nothing else. No login is stored,
// nothing is fetched; the address each one opens can be edited and is kept.
// ---------------------------------------------------------------------------
const PORTALS = [
  {
    key: 'gst',
    name: 'GST portal',
    sub: 'GSTR-1 and GSTR-3B are filed here',
    idLabel: 'GSTIN',
    ledgerPath: 'Services → Ledgers → Electronic Cash Ledger',
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
const parseJson = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

function shapePortals(links, co) {
  const prof = shapeProfile(co || {});
  const byKey = new Map(links.map((l) => [l.portalKey, l]));
  return PORTALS.map((p) => {
    const row = byKey.get(p.key);
    const edits = parseJson(row?.pageUrls);
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
      ledgerPath: p.ledgerPath || null,
      pages,
      selectedPage,
      url: pages.find((pg) => pg.key === selectedPage).url,
      lastEditedAt: row?.lastEditedAt || null,
      lastEditedBy: row?.lastEditedBy || null,
    };
  });
}

router.get('/portals', async (req, res) => {
  const range = officeRange(req.query.period);
  const [links, co] = await Promise.all([prisma.portalLink.findMany(), prisma.company.findFirst()]);
  res.json({
    portals: shapePortals(links, co),
    balances: await portalBalancesFor(range),
    period: {
      sel: req.query.period || 'all', label: range.label, from: range.from, to: range.to, all: !!range.all,
    },
  });
});

router.put('/portal-links/:key', async (req, res) => {
  const p = PORTALS.find((x) => x.key === req.params.key);
  if (!p) return res.status(404).json({ error: 'No such portal' });
  const page = req.body.selectedPage || p.pages[0].key;
  const pg = p.pages.find((x) => x.key === page);
  if (!pg) return res.status(400).json({ error: `${p.name} has no page "${page}"` });
  const existing = await prisma.portalLink.findUnique({ where: { portalKey: p.key } });
  const edits = parseJson(existing?.pageUrls);
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
  if (touchedUrl) {
    await logAudit({
      userId: req.user.id, action: 'Portal address changed', entity: 'PortalLink', entityId: p.key, toValue: `${page}: ${data.url}`,
    });
  }
  const [links, co] = await Promise.all([prisma.portalLink.findMany(), prisma.company.findFirst()]);
  res.json(shapePortals(links, co).find((x) => x.key === p.key));
});

// The two balances read off the portals by hand, for the period on screen.
// A blank value removes the entry, and the chip says "not entered" again.
router.put('/portal-balances', async (req, res) => {
  const range = officeRange(req.body.period);
  const { periodStart, periodEnd } = portalPeriodKey(range);
  const keys = ['gst', 'traces'].filter((k) => req.body[k] !== undefined);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to save — send gst and/or traces' });
  for (const k of keys) {
    const raw = req.body[k];
    if (raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return res.status(400).json({ error: `${k === 'gst' ? 'GST portal' : 'TRACES'} balance must be a number` });
  }
  for (const k of keys) {
    const raw = req.body[k];
    const where = { portalKey_periodStart_periodEnd: { portalKey: k, periodStart, periodEnd } };
    if (raw === null || raw === '') {
      await prisma.portalBalance.deleteMany({ where: { portalKey: k, periodStart, periodEnd } });
    } else {
      const enteredAmount = ROUND(Number(raw));
      const enteredBy = req.user.name || req.user.email || null;
      await prisma.portalBalance.upsert({
        where,
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
  res.json(await portalBalancesFor(range));
});

// ---------------------------------------------------------------------------
// GST & TDS PORTALS (Accounts spec 1) — the login the desk uses on the GST
// portal and on TRACES, kept on the server and nowhere else.
//
//   * GSTIN and TAN are NOT stored here: they are the Company row's gstin / tan,
//     the same fields Business & Tax Details edits — one source of truth. A
//     blank box leaves them as they are (clearing is done there).
//   * User ID and password live in the existing Integration table, one row
//     each ('gst-portal', 'tds-portal'), which Administration → Integrations
//     never lists (it lists its own catalogue only). The password is
//     AES-256-GCM ciphertext (utils/secrets.js); with no INTEGRATION_SECRET_KEY
//     a password is refused, never stored in plain text.
//   * No read returns the password. GET gives hasPassword and a fixed mask.
//     Only POST …/reveal returns it — to an Accounts login holding edit on
//     Office & Expenses — and that view is written to the audit log WITHOUT
//     the value. Nothing here logs, audits or echoes a password, and every
//     response carries Cache-Control: no-store.
//   * Who: the router's guards (Accounts desk role + Office & Expenses view)
//     plus `edit` on every route here, reads included — a view-only login
//     never sees the portal logins at all.
//   * Nothing is ever sent to a portal: "Open portal" is a plain link; the
//     credentials are not auto-submitted anywhere.
// ---------------------------------------------------------------------------
const TAX_PORTALS = {
  gst: {
    row: 'gst-portal', name: 'GST portal', idField: 'gstin', idLabel: 'GSTIN', url: 'https://www.gst.gov.in/',
  },
  tds: {
    row: 'tds-portal', name: 'TDS portal (TRACES)', idField: 'tan', idLabel: 'TAN', url: 'https://www.tdscpc.gov.in/',
  },
};
const TP_USER = 'User ID';
const TP_PASS = 'Password';
const TP_BY = 'Updated by';
const TP_MASK = '••••••••';
const noStore = (res) => res.set('Cache-Control', 'no-store, private');

function taxPortalOf(req, res) {
  const p = TAX_PORTALS[req.params.which];
  if (!p) { res.status(404).json({ error: 'No such portal — gst or tds' }); return null; }
  return p;
}

// What a read may carry — never the password, only whether one is stored.
function shapeTaxPortal(p, row, co) {
  const v = parseValues(row);
  const stored = v[TP_PASS] || '';
  const hasPassword = !!stored;
  const readable = hasPassword ? decryptSecret(stored) !== null : true;
  return {
    idLabel: p.idLabel,
    idValue: cleanId(co?.[p.idField]) || null,
    userId: v[TP_USER] || '',
    hasPassword,
    passwordHint: hasPassword ? (readable ? TP_MASK : `${TP_MASK} (stored, but this key cannot read it)`) : '',
    encrypted: hasPassword ? isEncrypted(stored) : null,
    portalUrl: p.url,
    updatedAt: row?.values ? row.updatedAt : null,
    updatedBy: v[TP_BY] || null,
  };
}

async function taxPortalsPayload() {
  const [gstRow, tdsRow, co] = await Promise.all([
    prisma.integration.findUnique({ where: { id: TAX_PORTALS.gst.row } }),
    prisma.integration.findUnique({ where: { id: TAX_PORTALS.tds.row } }),
    prisma.company.findFirst(),
  ]);
  return {
    keyConfigured: secretsConfigured(),
    noKeyMessage: secretsConfigured() ? null : NO_KEY_MESSAGE,
    gst: shapeTaxPortal(TAX_PORTALS.gst, gstRow, co),
    tds: shapeTaxPortal(TAX_PORTALS.tds, tdsRow, co),
  };
}

router.get('/tax-portals', requireOfficeWrite, async (req, res) => {
  noStore(res);
  try {
    res.json(await taxPortalsPayload());
  } catch {
    res.status(500).json({ error: 'The portal details could not be read.' });
  }
});

// Save one portal's GSTIN / TAN, User ID and (optionally) password.
//   gstin | tan   blank = leave the business profile as it is
//   userId        saved as typed (trimmed); blank clears it
//   password      blank = KEEP the stored one; clearPassword: true removes it
router.put('/tax-portals/:which', async (req, res) => {
  noStore(res);
  const p = taxPortalOf(req, res);
  if (!p) return undefined;
  const b = req.body || {};
  const bad = (error) => res.status(400).json({ error });

  // --- validate everything before anything is written --------------------
  const co = (await prisma.company.findFirst()) || null;
  let newId;
  const rawId = b[p.idField] !== undefined ? b[p.idField] : b.idValue;
  const id = cleanId(rawId);
  if (id) {
    if (p.idField === 'gstin') {
      const c = checkGstin(id);
      if (!c.ok) return bad(`GSTIN: ${c.error}`);
      const pan = cleanId(co?.pan);
      if (pan && id.slice(2, 12) !== pan) {
        return bad(`The PAN inside this GSTIN (${id.slice(2, 12)}) is not the business PAN (${pan}) — change the PAN in Business & Tax Details first`);
      }
    } else if (!isTan(id)) {
      return bad('TAN must be 4 letters, 5 digits and a letter — e.g. HYDT12345A');
    }
    if (id !== (cleanId(co?.[p.idField]) || null)) newId = id;
  }
  const userId = b.userId === undefined ? undefined : String(b.userId || '').trim();
  if (userId !== undefined && userId.length > 120) return bad('The User ID is too long (120 characters at most)');
  const password = typeof b.password === 'string' ? b.password : '';
  const clearPassword = b.clearPassword === true;
  if (password && password.length > 200) return bad('The password is too long (200 characters at most)');
  if (password && !password.trim()) return bad('The password cannot be only spaces');

  let cipher = null;
  if (password && !clearPassword) {
    if (!secretsConfigured()) return bad(NO_KEY_MESSAGE);
    try {
      cipher = encryptSecret(password);
    } catch (e) {
      // Never echo the value — only the configuration problem.
      return bad(e && e.code === 'NO_SECRET_KEY' ? NO_KEY_MESSAGE : 'The password could not be encrypted.');
    }
  }

  try {
    const actor = req.user.name || req.user.email || null;
    // --- the business profile (one source of truth for GSTIN / TAN) --------
    if (newId) {
      let company = co;
      if (!company) company = await prisma.company.create({ data: { name: 'TeamLink Consultants' } });
      await prisma.company.update({ where: { id: company.id }, data: { [p.idField]: newId } });
      await logAudit({
        userId: req.user.id,
        action: 'Business details updated',
        entity: 'Company',
        entityId: company.id,
        field: p.idField,
        fieldLabel: p.idLabel,
        fromValue: company[p.idField] ? String(company[p.idField]) : '—',
        toValue: newId,
        actorName: actor,
      });
    }

    // --- the portal login ----------------------------------------------------
    const row = await prisma.integration.findUnique({ where: { id: p.row } });
    const cur = parseValues(row);
    const next = { ...cur };
    const changed = [];
    if (userId !== undefined && userId !== (cur[TP_USER] || '')) { next[TP_USER] = userId; changed.push('User ID'); }
    if (clearPassword && cur[TP_PASS]) { next[TP_PASS] = ''; changed.push('Password removed'); }
    if (cipher) { next[TP_PASS] = cipher; changed.push('Password changed'); }
    if (changed.length) {
      next[TP_BY] = actor;
      const values = JSON.stringify(next);
      await prisma.integration.upsert({
        where: { id: p.row },
        create: { id: p.row, values },
        update: { values },
      });
      // Which fields changed — never a password, never its ciphertext.
      await logAudit({
        userId: req.user.id,
        action: `${p.name} login updated`,
        entity: 'TaxPortal',
        entityId: req.params.which,
        toValue: changed.join(', '),
        actorName: actor,
      });
    }
    return res.json(await taxPortalsPayload());
  } catch {
    return res.status(500).json({ error: 'The portal details could not be saved.' });
  }
});

// The one call that returns a password — explicitly asked for (Show), to an
// Accounts login with edit (the router's write guard covers POST), recorded
// in the audit log without the value. The browser keeps it in memory only.
router.post('/tax-portals/:which/reveal', async (req, res) => {
  noStore(res);
  const p = taxPortalOf(req, res);
  if (!p) return undefined;
  try {
    const row = await prisma.integration.findUnique({ where: { id: p.row } });
    const stored = parseValues(row)[TP_PASS] || '';
    if (!stored) return res.status(404).json({ error: `No ${p.name} password is saved.` });
    const plain = decryptSecret(stored);
    if (plain === null) {
      return res.status(409).json({ error: `The saved ${p.name} password cannot be read with the current INTEGRATION_SECRET_KEY — save it again.` });
    }
    await logAudit({
      userId: req.user.id,
      action: `${p.name} password viewed`,
      entity: 'TaxPortal',
      entityId: req.params.which,
      actorName: req.user.name || req.user.email || null,
    });
    return res.json({ password: plain });
  } catch {
    return res.status(500).json({ error: 'The password could not be shown.' });
  }
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
  if (wanted === 'REJECTED') return res.status(400).json({ error: 'A new expense cannot start out rejected' });
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
const NEXT = { PENDING: ['APPROVED', 'REJECTED'], APPROVED: ['PAID', 'REIMBURSED'], PAID: ['REIMBURSED'] };
router.patch('/:id/status', async (req, res) => {
  if (!(await isApprover(req.user))) return res.status(403).json({ error: APPROVER_ONLY });
  const existing = await prisma.officeExpense.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  const raw = String(req.body.action || req.body.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const to = STATUS_ACTIONS[raw];
  if (!to) return res.status(400).json({ error: 'action must be approve, reject, mark_paid or mark_reimbursed' });
  const from = approvalOf(existing);
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
      approve: approver && st === 'PENDING',
      reject: approver && st === 'PENDING',
      markPaid: approver && st === 'APPROVED',
      markReimbursed: approver && (st === 'APPROVED' || st === 'PAID'),
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

module.exports = router;
