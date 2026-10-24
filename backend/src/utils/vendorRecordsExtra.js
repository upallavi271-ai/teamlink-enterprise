// ---------------------------------------------------------------------------
// VENDOR PORTAL, THE FULLER PICTURE (founder, 2026-10-23): billing period, category, GST detail, real payment status (Paid / Partially Paid /
// Overdue / Unpaid / Pending Verification), the outstanding list, upcoming due dates, services and agreements.
//
// It only ADDS to the rows utils/vendorRecords.js already builds from Accounts (invoiceRows); no number is recomputed anywhere else, so the
// Dashboard, Bills & Invoices and Payments & Outstanding always agree. Everything is read from records that exist; a field a record does not
// have stays null and the screens say "Not available". Nothing is invented: a CGST / SGST / IGST split is shown only when the bill's recorded
// GST treatment says which it is; a service's "covered until" only when the bill recorded how many months it covers.
// Every function takes the vendorId from the SESSION (callers pass req.vendor.vendorId) and filters by it.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const DEAD = ['REJECTED', 'WITHDRAWN'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// today in India (the company's day), YYYY-MM-DD
const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

// '2026-10-05' (+ months covered) -> { key: '2026-10', label: 'Oct 2026' } or 'Oct 2026 to Dec 2026'
function periodOf(day, monthsCovered) {
  const m = /^(\d{4})-(\d{2})/.exec(str(day));
  if (!m) return { key: null, label: null };
  const y = Number(m[1]); const mo = Number(m[2]) - 1;
  const first = `${MONTHS[mo]} ${y}`;
  const n = Number(monthsCovered);
  if (!Number.isFinite(n) || n <= 1) return { key: `${m[1]}-${m[2]}`, label: first, endLabel: null, until: null };
  const e = new Date(Date.UTC(y, mo + n - 1, 1));
  const endLabel = `${MONTHS[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
  const until = new Date(Date.UTC(y, mo + n, 0)).toISOString().slice(0, 10); // last day of the last covered month
  return { key: `${m[1]}-${m[2]}`, label: `${first} to ${endLabel}`, endLabel, until };
}

// CGST / SGST / IGST only when the bill says which one it is (GST treatment text); otherwise null = "Not available".
function gstSplit(gst, treatment) {
  const g = ROUND(gst);
  const t = str(treatment).toLowerCase();
  if (!g || !t) return { cgst: null, sgst: null, igst: null };
  if (/igst|inter[- ]?state/.test(t)) return { cgst: null, sgst: null, igst: g };
  if (/cgst|sgst|intra[- ]?state|within state/.test(t)) return { cgst: ROUND(g / 2), sgst: ROUND(g / 2), igst: null };
  return { cgst: null, sgst: null, igst: null };
}

// Paid / Pending Verification / Overdue / Partially Paid / Unpaid (+ the flags the filters use)
function stateOf(r, today) {
  const dead = DEAD.includes(r.status);
  const verifying = ['PENDING_REVIEW', 'VERIFIED'].includes(r.status);
  const owes = !dead && r.outstanding > 0;
  const overdue = owes && !verifying && !!r.dueDate && r.dueDate < today;
  const partial = owes && r.paidAmount > 0;
  let payStatus;
  if (r.status === 'REJECTED') payStatus = 'Rejected';
  else if (r.status === 'WITHDRAWN') payStatus = 'Withdrawn';
  else if (verifying) payStatus = 'Pending Verification';
  else if (r.paid && r.outstanding <= 0) payStatus = 'Paid';
  else if (overdue) payStatus = 'Overdue';
  else if (partial) payStatus = 'Partially Paid';
  else payStatus = 'Unpaid';
  return { payStatus, overdue, partial, verifying, daysOverdue: overdue ? daysBetween(r.dueDate, today) : 0 };
}

// Adds the fields to the vendor's invoice rows, in place. `rows` are already this vendor's own (vendorRecords.invoiceRows).
async function enrich(rows, vendorId) {
  const today = istToday();
  const ids = rows.filter((r) => String(r.key).startsWith('exp:')).map((r) => String(r.key).slice(4));
  const [exps, vendor] = await Promise.all([
    ids.length ? prisma.officeExpense.findMany({
      where: { id: { in: ids }, vendorId },
      select: {
        id: true, category: true, expenseDate: true, monthsCovered: true, frequency: true, vendorGstin: true, gstRatePct: true, gstTreatment: true, hsnSac: true,
        expenseCode: true, bankTxnId: true, supplyType: true, description: true,
      },
    }) : [],
    prisma.officeVendor.findUnique({ where: { id: vendorId }, select: { gstin: true } }),
  ]);
  const byId = new Map(exps.map((e) => [e.id, e]));
  const txIds = exps.map((e) => e.bankTxnId).filter(Boolean);
  const txs = txIds.length ? await prisma.bankTransaction.findMany({ where: { id: { in: txIds } }, select: { id: true, date: true, reference: true } }) : [];
  const txById = new Map(txs.map((t) => [t.id, t]));
  rows.forEach((r) => {
    const e = String(r.key).startsWith('exp:') ? byId.get(String(r.key).slice(4)) : null;
    const per = periodOf(e ? e.expenseDate : r.date, e ? e.monthsCovered : null);
    const split = gstSplit(r.gst, e && e.gstTreatment);
    const tx = e && e.bankTxnId ? txById.get(e.bankTxnId) : null;
    Object.assign(r, {
      category: e ? e.category || null : null,
      serviceName: e ? (e.category || null) : null,
      supplyType: e ? e.supplyType || null : null,
      frequency: e ? e.frequency || null : null,
      periodKey: per.key,
      period: per.label,
      coveredUntil: per.until || null,
      gstin: (e && e.vendorGstin) || (vendor && vendor.gstin) || null,
      gstRatePct: e && e.gstRatePct != null ? e.gstRatePct : null,
      gstTreatment: e ? e.gstTreatment || null : null,
      hsnSac: e ? e.hsnSac || null : null,
      taxable: r.amount,
      ...split,
      accountsRef: e ? e.expenseCode || null : null,
      bankRef: tx ? { reference: tx.reference || null, date: tx.date || null } : null,
      ...stateOf(r, today),
    });
  });
  return rows;
}

// Extra summary numbers, from the same rows.
function extraSummary(rows) {
  const live = rows.filter((r) => !DEAD.includes(r.status));
  const sum = (list, k) => ROUND(list.reduce((t, r) => t + r[k], 0));
  const overdue = live.filter((r) => r.overdue);
  const partial = live.filter((r) => r.partial);
  const verifying = live.filter((r) => r.verifying);
  const pending = live.filter((r) => r.outstanding > 0 && !r.overdue && !r.verifying);
  return {
    overdue: { count: overdue.length, amount: sum(overdue, 'outstanding') },
    partial: { count: partial.length, amount: sum(partial, 'outstanding') },
    verification: { count: verifying.length, amount: sum(verifying, 'outstanding') },
    pendingPayment: { count: pending.length, amount: sum(pending, 'outstanding') },
    unpaid: live.filter((r) => r.outstanding > 0 && !r.paidAmount).length,
    gstTotal: sum(live, 'gst'),
  };
}

// status / category / period filters for the Bills & Invoices list
function filterRows(rows, q) {
  const f = str(q.status);
  let out = rows;
  if (f === 'overdue') out = out.filter((r) => r.overdue);
  else if (f === 'partial') out = out.filter((r) => r.partial);
  else if (f === 'verification') out = out.filter((r) => r.verifying);
  else if (f === 'pending') out = out.filter((r) => r.outstanding > 0 && !r.overdue && !r.verifying && !DEAD.includes(r.status));
  if (str(q.category)) out = out.filter((r) => (r.category || '') === str(q.category));
  if (/^\d{4}-\d{2}$/.test(str(q.period))) out = out.filter((r) => r.periodKey === str(q.period));
  return out;
}
const facetsOf = (rows) => ({
  categories: [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(),
  periods: [...new Map(rows.filter((r) => r.periodKey).map((r) => [r.periodKey, r.period])).entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, label]) => ({ key, label })),
});

// The Payments & Outstanding module's own numbers and its outstanding list.
function paymentsSummary(rows, payments) {
  const x = extraSummary(rows);
  const live = rows.filter((r) => !DEAD.includes(r.status));
  return {
    paid: ROUND(payments.reduce((t, p) => t + p.amount, 0)),
    outstanding: ROUND(live.reduce((t, r) => t + r.outstanding, 0)),
    pending: x.pendingPayment,
    overdue: x.overdue,
    partial: x.partial,
    verification: x.verification,
    payments: payments.length,
  };
}
function outstandingRows(rows) {
  return rows.filter((r) => !DEAD.includes(r.status) && r.outstanding > 0)
    .map((r) => ({
      key: r.key, invoiceNo: r.invoiceNo, date: r.date, dueDate: r.dueDate, total: r.netPayable, paid: r.paidAmount, outstanding: r.outstanding,
      payStatus: r.payStatus, overdue: r.overdue, daysOverdue: r.daysOverdue,
    }))
    .sort((a, b) => (b.overdue - a.overdue) || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
}

// Dashboard additions
function dashboardExtras(rows) {
  const today = istToday();
  const live = rows.filter((r) => !DEAD.includes(r.status));
  const upcoming = live.filter((r) => r.outstanding > 0 && !r.overdue && r.dueDate && r.dueDate >= today && daysBetween(today, r.dueDate) <= 30)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5)
    .map((r) => ({ key: r.key, invoiceNo: r.invoiceNo, dueDate: r.dueDate, outstanding: r.outstanding, daysLeft: daysBetween(today, r.dueDate) }));
  const pendingBills = live.filter((r) => r.outstanding > 0).slice(0, 5)
    .map((r) => ({ key: r.key, invoiceNo: r.invoiceNo, date: r.date, dueDate: r.dueDate, outstanding: r.outstanding, payStatus: r.payStatus, overdue: r.overdue }));
  const x = extraSummary(rows);
  const rejected = rows.filter((r) => r.status === 'REJECTED').length;
  const actions = [];
  if (x.overdue.count) actions.push({ text: `${x.overdue.count} overdue invoice${x.overdue.count === 1 ? '' : 's'}, ₹${x.overdue.amount.toLocaleString('en-IN')} to be paid`, to: '/vendor/payments' });
  if (x.verification.count) actions.push({ text: `${x.verification.count} invoice${x.verification.count === 1 ? '' : 's'} waiting for the company to check`, to: '/vendor/invoices?status=verification' });
  if (rejected) actions.push({ text: `${rejected} invoice${rejected === 1 ? ' was' : 's were'} rejected. Open to read the reason`, to: '/vendor/invoices?status=rejected' });
  return { overdue: x.overdue, partial: x.partial, verification: x.verification, pendingPayment: x.pendingPayment, upcoming, pendingBills, actions };
}

// ---- Services & Agreements ----------------------------------------------------------------------------------------------
// agreements: documents of type "Agreement" the company shared with this vendor.
// services: what the vendor bills us for, grouped by the bill's category (Rent, Internet, Subscription ...): how many bills, first / last bill,
//           the billing period the bills record, and "covered until" when a bill recorded the months it covers.
// orders:   passed in (vendorRecords.purchaseOrders: shared purchase-order documents and ID-card orders).
// charges:  there is no additional-charges record in the app, so none is shown (and none is invented).
async function servicesFor(vendorId, rows, orders) {
  const docs = await prisma.vendorSharedDocument.findMany({ where: { vendorId, revokedAt: null, docType: 'Agreement' }, orderBy: { createdAt: 'desc' } });
  const agreements = docs.map((d) => ({
    id: `agr:${d.id}`, title: d.title, type: 'Agreement', sharedOn: d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : null, note: d.note || null,
    effective: null, expiry: null, renewal: null, status: 'Shared by the company', document: { kind: 'shared', id: d.id, name: d.name, size: d.size },
  }));
  const groups = new Map();
  rows.filter((r) => !DEAD.includes(r.status) && r.category).forEach((r) => {
    const g = groups.get(r.category) || { name: r.category, bills: 0, billed: 0, outstanding: 0, first: null, last: null, frequency: null, coveredUntil: null, latestInvoice: null, descriptions: new Set() };
    g.bills += 1; g.billed += r.netPayable; g.outstanding += r.outstanding;
    if (r.date && (!g.first || r.date < g.first)) g.first = r.date;
    if (r.date && (!g.last || r.date > g.last)) { g.last = r.date; g.latestInvoice = r.invoiceNo; if (r.frequency) g.frequency = r.frequency; }
    if (r.coveredUntil && (!g.coveredUntil || r.coveredUntil > g.coveredUntil)) g.coveredUntil = r.coveredUntil;
    if (r.description) g.descriptions.add(r.description);
    groups.set(r.category, g);
  });
  const services = [...groups.values()].map((g) => ({
    name: g.name, description: [...g.descriptions][0] || null, billingPeriod: g.frequency || null, bills: g.bills, billed: ROUND(g.billed), outstanding: ROUND(g.outstanding),
    firstBilled: g.first, lastBilled: g.last, latestInvoice: g.latestInvoice, coveredUntil: g.coveredUntil,
  })).sort((a, b) => String(b.lastBilled || '').localeCompare(String(a.lastBilled || '')));
  return { agreements, services, orders, charges: [] };
}

// Payment advices, TDS certificates and statements the company shared with this vendor (shown in Payments & Outstanding).
async function paymentDocuments(vendorId) {
  const docs = await prisma.vendorSharedDocument.findMany({ where: { vendorId, revokedAt: null, docType: { in: ['Payment advice', 'TDS certificate', 'Statement'] } }, orderBy: { createdAt: 'desc' }, take: 50 });
  return docs.map((d) => ({ id: d.id, title: d.title, type: d.docType, sharedOn: d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : null, note: d.note || null, document: { kind: 'shared', id: d.id, name: d.name, size: d.size } }));
}

module.exports = { istToday, periodOf, gstSplit, stateOf, enrich, extraSummary, filterRows, facetsOf, paymentsSummary, outstandingRows, dashboardExtras, servicesFor, paymentDocuments };
