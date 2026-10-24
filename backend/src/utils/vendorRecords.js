// ---------------------------------------------------------------------------
// VENDOR PORTAL RECORDS - what the four vendor modules show (2026-10-19): Dashboard, Invoices, Payments, Purchase Orders.
//
// ONE SOURCE FOR ALL FOUR. The Dashboard numbers, the Invoices list and the Payments list are all computed from the SAME invoice rows
// (invoiceRows), so a figure can never disagree between two screens and nothing is counted twice:
//   * an invoice is either an Accounts bill / a portal bill (utils/vendorInvoices.js - an approved portal bill and its Accounts bill are
//     already ONE row there) or a bill the vendor sent from the portal (VendorModuleBill). The two tables never overlap;
//   * a payment is the paid part of ONE invoice (one payment row per invoice, key pay:<invoice key>). The company records a bill as
//     Paid with its amount, date and mode; there is no separate "payment" table to double count. Where a module bill was paid for less
//     than its total, the paid part is the payment and the rest stays outstanding (counted once, in outstanding);
//   * outstanding = what is still to be paid on live invoices (rejected / withdrawn ones owe nothing);
//   * the amount shown is what the vendor receives: bill + GST - TDS (module bills carry no TDS).
//
// Purchase orders: the app has no formal purchase-order table. What it does hold for a vendor, and what is shown here, is
//   (1) the purchase-order documents the company shared with the vendor (VendorSharedDocument, type "Purchase order"), and
//   (2) the ID-card orders placed with the vendor (IdCardOrder + its lines: number of cards, status, dates, delivery challan).
// Fields a record does not have (expected delivery, unit price) show as "-"; nothing is invented.
//
// EVERY function takes the vendorId from the SESSION (req.vendor.vendorId) and filters by it; ids in the request are only ever looked
// up INSIDE that vendor's own rows, so another vendor's record answers exactly like a missing one.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./vmDb');
const INVOICES = require('./vendorInvoices');
const VM = require('./vendorModules');
const X = require('./vendorRecordsExtra'); // billing period, GST detail, real payment status, outstanding list, services & agreements (2026-10-23)
const { wantsAll } = require('./exportAll'); // the vendor Export asks for every row of a list (never reachable from a query string)

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const day = (v) => { if (!v) return null; const d = DB.toDate(v) || new Date(v); return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10); };
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const DEAD = ['REJECTED', 'WITHDRAWN'];

// ---- invoices ----------------------------------------------------------------------------------
function fromLegacy(r) {
  return {
    key: r.key, source: r.submissionId ? 'Vendor Portal' : 'Accounts', invoiceNo: r.billNumber || r.billCode || '-', billCode: r.billCode || null,
    date: day(r.billDate), dueDate: day(r.dueDate), description: r.description || null, amount: r.amount, gst: r.gst, tds: r.tds, total: r.total,
    netPayable: r.netPayable, paid: !!r.paid, paidAmount: r.paidAmount || 0, outstanding: r.outstanding || 0, status: r.status, statusText: r.statusText,
    paymentDate: day(r.paymentDate), paymentMode: r.paymentMode || null, paymentRef: null, rejectionReason: r.rejectionReason || null,
    document: r.hasDocument && r.submissionId ? { kind: 'bill', id: r.submissionId } : null,
  };
}
const MOD_STATUS = {
  Submitted: ['PENDING_REVIEW', 'Sent, waiting for Accounts to check'], Approved: ['PENDING_PAYMENT', 'Approved, waiting for payment'],
  Paid: ['PAID', 'Paid'], Rejected: ['REJECTED', 'Rejected - see the reason'],
};
function fromModule(b) {
  const [status, statusText] = MOD_STATUS[b.status] || ['PENDING_REVIEW', b.status];
  const total = ROUND(b.total);
  const paidAmount = b.status === 'Paid' ? ROUND(b.paidAmount == null ? total : Math.min(Number(b.paidAmount), total || Number(b.paidAmount))) : 0;
  const outstanding = DEAD.includes(status) ? 0 : ROUND(Math.max(total - paidAmount, 0));
  return {
    key: `mod:${b.id}`, source: 'Vendor Portal', invoiceNo: b.billNumber || b.billCode || '-', billCode: b.billCode || null, date: day(b.billDate), dueDate: day(b.dueDate),
    description: b.remarks || null, amount: ROUND(b.amount), gst: ROUND(b.gst), tds: 0, total, netPayable: total, paid: b.status === 'Paid' && outstanding === 0, paidAmount, outstanding,
    status, statusText: b.status === 'Paid' && outstanding > 0 ? 'Partly paid' : statusText, paymentDate: day(b.paidOn), paymentMode: b.paymentMode || null, paymentRef: b.paymentRef || null,
    rejectionReason: b.status === 'Rejected' ? b.rejectionReason || null : null, document: b.documentFile ? { kind: 'module-bill', id: b.id } : null,
  };
}

async function invoiceRows(vendorId) {
  const legacy = await INVOICES.listVendorInvoices(vendorId, { forVendor: true });
  const rows = legacy.rows.map(fromLegacy);
  if (await DB.ready()) {
    const mods = await DB.q('SELECT * FROM "VendorModuleBill" WHERE "vendorId" = ? AND "kind" IN (\'invoice\',\'monthly_bill\')', [vendorId]);
    mods.forEach((b) => rows.push(fromModule(b)));
  }
  rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.invoiceNo).localeCompare(String(a.invoiceNo)));
  await X.enrich(rows, vendorId);
  return rows;
}

const live = (rows) => rows.filter((r) => !DEAD.includes(r.status));
function invoiceSummary(rows) {
  const l = live(rows);
  return {
    total: rows.length,
    paid: rows.filter((r) => r.paid).length,
    pending: l.filter((r) => !r.paid).length,
    rejected: rows.filter((r) => DEAD.includes(r.status)).length,
    billed: ROUND(l.reduce((t, r) => t + r.netPayable, 0)),
    received: ROUND(l.reduce((t, r) => t + r.paidAmount, 0)),
    outstanding: ROUND(l.reduce((t, r) => t + r.outstanding, 0)),
    ...X.extraSummary(rows),
  };
}

// search / filter / sort / pages, all on the server. -> { rows, total (after filters), page, pageSize, pages }
function listQuery(rows, q, { searchIn, sorts, defaultSort }) {
  const s = str(q.q).toLowerCase();
  let out = rows;
  if (s) out = out.filter((r) => searchIn(r).some((x) => String(x || '').toLowerCase().includes(s)));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(str(q.from)) ? str(q.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(str(q.to)) ? str(q.to) : null;
  if (from) out = out.filter((r) => (r.date || '') >= from);
  if (to) out = out.filter((r) => (r.date || '') <= to);
  return { out, sort: sorts[str(q.sort)] ? str(q.sort) : defaultSort, dir: str(q.dir) === 'asc' ? 'asc' : 'desc' };
}
function page(rows, q, sortKey, dir, sorts) {
  const f = sorts[sortKey];
  const cmp = (a, b) => { const x = f(a); const y = f(b); return (typeof x === 'number' && typeof y === 'number') ? x - y : String(x ?? '').localeCompare(String(y ?? '')); };
  const sorted = [...rows].sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  if (wantsAll(q)) return { rows: sorted, total: sorted.length, page: 1, pageSize: sorted.length, pages: 1 };
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const p = Math.min(pages, Math.max(1, Number(q.page) || 1));
  return { rows: sorted.slice((p - 1) * pageSize, p * pageSize), total: sorted.length, page: p, pageSize, pages };
}

const INV_SORTS = { date: (r) => r.date || '', dueDate: (r) => r.dueDate || '', amount: (r) => r.netPayable, outstanding: (r) => r.outstanding, status: (r) => r.statusText, invoiceNo: (r) => r.invoiceNo };
async function listInvoices(vendorId, q = {}) {
  const all = await invoiceRows(vendorId);
  const { out, sort, dir } = listQuery(all, q, { searchIn: (r) => [r.invoiceNo, r.billCode, r.description, r.statusText, r.paymentMode], sorts: INV_SORTS, defaultSort: 'date' });
  let rows = out;
  const f = str(q.status);
  if (f === 'paid') rows = rows.filter((r) => r.paid);
  else if (f === 'unpaid') rows = rows.filter((r) => !r.paid && !DEAD.includes(r.status));
  else if (f === 'rejected') rows = rows.filter((r) => DEAD.includes(r.status));
  rows = X.filterRows(rows, q);
  return { ...page(rows, q, sort, dir, INV_SORTS), summary: invoiceSummary(all), all: all.length, ...X.facetsOf(all) };
}
async function invoiceDetail(vendorId, key) {
  const all = await invoiceRows(vendorId);
  const r = all.find((x) => x.key === String(key || ''));
  if (!r) return null;
  const pay = r.paidAmount > 0 ? paymentOf(r) : null;
  return { ...r, payment: pay };
}

// ---- payments ----------------------------------------------------------------------------------
function paymentOf(r) {
  return {
    key: `pay:${r.key}`, invoiceKey: r.key, invoiceNo: r.invoiceNo, date: r.paymentDate || r.date || null, amount: r.paidAmount, reference: r.paymentRef || null, method: r.paymentMode || null,
    status: r.payStatus === 'Paid' ? 'Paid' : (r.payStatus === 'Partially Paid' || r.paidAmount > 0 ? 'Partially Paid' : r.payStatus), outstandingOnInvoice: r.outstanding, description: r.description || null, document: r.document,
    allocated: r.paidAmount, remaining: r.outstanding, invoiceTotal: r.netPayable, invoiceDate: r.date, bankRef: r.bankRef || null, accountsRef: r.accountsRef || null,
  };
}
const PAY_SORTS = { date: (r) => r.date || '', amount: (r) => r.amount, invoiceNo: (r) => r.invoiceNo, status: (r) => r.status };
async function paymentRows(vendorId, preloaded) {
  const all = preloaded || await invoiceRows(vendorId);
  return all.filter((r) => r.paidAmount > 0 && !DEAD.includes(r.status)).map(paymentOf);
}
async function listPayments(vendorId, q = {}) {
  const inv = await invoiceRows(vendorId);
  const all = await paymentRows(vendorId, inv);
  const s = str(q.q).toLowerCase();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(str(q.from)) ? str(q.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(str(q.to)) ? str(q.to) : null;
  let rows = all;
  if (s) rows = rows.filter((r) => [r.invoiceNo, r.reference, r.method, r.description].some((x) => String(x || '').toLowerCase().includes(s)));
  if (from) rows = rows.filter((r) => (r.date || '') >= from);
  if (to) rows = rows.filter((r) => (r.date || '') <= to);
  if (str(q.method)) rows = rows.filter((r) => (r.method || '') === str(q.method));
  const sort = PAY_SORTS[str(q.sort)] ? str(q.sort) : 'date';
  const methods = [...new Set(all.map((r) => r.method).filter(Boolean))].sort();
  return {
    ...page(rows, q, sort, str(q.dir) === 'asc' ? 'asc' : 'desc', PAY_SORTS),
    summary: { count: all.length, received: ROUND(all.reduce((t, r) => t + r.amount, 0)), ...X.paymentsSummary(inv, all) }, methods, all: all.length,
    outstanding: X.outstandingRows(inv), documents: await X.paymentDocuments(vendorId),
  };
}
async function paymentDetail(vendorId, key) {
  const all = await paymentRows(vendorId);
  return all.find((x) => x.key === String(key || '')) || null;
}

// ---- purchase orders ---------------------------------------------------------------------------
const ORDER_TEXT = { New: 'New', Received: 'Received by you', Printing: 'In printing', Ready: 'Ready', Delivered: 'Delivered' };
async function purchaseOrders(vendorId) {
  const out = [];
  const docs = await prisma.vendorSharedDocument.findMany({ where: { vendorId, revokedAt: null, docType: 'Purchase order' }, orderBy: { createdAt: 'desc' } });
  docs.forEach((d) => out.push({
    id: `doc:${d.id}`, kind: 'document', poNumber: d.title, orderDate: day(d.createdAt), expectedDelivery: null, status: 'Issued', statusText: 'Issued by the company',
    description: d.note || null, items: [], total: null, documents: [{ kind: 'shared', id: d.id, name: d.name, size: d.size, label: 'Purchase order document' }],
  }));
  if (await DB.ready()) {
    const orders = await DB.q('SELECT * FROM "IdCardOrder" WHERE "vendorId" = ? ORDER BY "createdAt" DESC', [vendorId]);
    if (orders.length) {
      const lines = await DB.q(`SELECT "orderId", "cardType", COUNT(*) AS n FROM "IdCardOrderLine" WHERE "orderId" IN (${orders.map(() => '?').join(',')}) GROUP BY "orderId", "cardType"`, orders.map((o) => o.id));
      const by = new Map();
      lines.forEach((l) => { if (!by.has(l.orderId)) by.set(l.orderId, []); by.get(l.orderId).push({ description: `ID card (${l.cardType})`, quantity: l.n, unitPrice: null, total: null }); });
      orders.forEach((o) => {
        const items = by.get(o.id) || [];
        const qty = items.reduce((t, i) => t + i.quantity, 0);
        out.push({
          id: `idc:${o.id}`, kind: 'order', poNumber: o.orderCode, orderDate: day(o.createdAt), expectedDelivery: null, status: o.status, statusText: ORDER_TEXT[o.status] || o.status,
          description: `ID cards${qty ? ` for ${qty} ${qty === 1 ? 'person' : 'people'}` : ''}${o.note ? ` - ${o.note}` : ''}`, items, total: null,
          deliveredOn: day(o.deliveredAt),
          documents: o.challanFile ? [{ kind: 'po-challan', id: o.id, name: o.challanName || 'Delivery challan', size: o.challanSize || null, label: 'Delivery challan' }] : [],
        });
      });
    }
  }
  return out.sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')) || String(b.poNumber).localeCompare(String(a.poNumber)));
}
const PO_SORTS = { orderDate: (r) => r.orderDate || '', poNumber: (r) => r.poNumber, status: (r) => r.statusText };
function poSummary(rows) {
  const m = new Map();
  rows.forEach((r) => { const k = r.statusText; m.set(k, (m.get(k) || 0) + 1); });
  return { count: rows.length, byStatus: [...m.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count) };
}
async function listPurchaseOrders(vendorId, q = {}) {
  const all = await purchaseOrders(vendorId);
  const s = str(q.q).toLowerCase();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(str(q.from)) ? str(q.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(str(q.to)) ? str(q.to) : null;
  let rows = all;
  if (s) rows = rows.filter((r) => [r.poNumber, r.description, r.statusText].some((x) => String(x || '').toLowerCase().includes(s)));
  if (from) rows = rows.filter((r) => (r.orderDate || '') >= from);
  if (to) rows = rows.filter((r) => (r.orderDate || '') <= to);
  if (str(q.status)) rows = rows.filter((r) => r.statusText === str(q.status));
  const sort = PO_SORTS[str(q.sort)] ? str(q.sort) : 'orderDate';
  return { ...page(rows, q, sort, str(q.dir) === 'asc' ? 'asc' : 'desc', PO_SORTS), summary: poSummary(all), statuses: poSummary(all).byStatus.map((x) => x.status), all: all.length };
}
async function purchaseOrderDetail(vendorId, id) {
  const all = await purchaseOrders(vendorId);
  return all.find((x) => x.id === String(id || '')) || null;
}

// ---- services & agreements ---------------------------------------------------------------------
async function services(vendorId) {
  const [inv, orders] = await Promise.all([invoiceRows(vendorId), purchaseOrders(vendorId)]);
  const out = await X.servicesFor(vendorId, inv, orders);
  return { ...out, counts: { agreements: out.agreements.length, services: out.services.length, orders: out.orders.length, charges: out.charges.length } };
}

// ---- dashboard ---------------------------------------------------------------------------------
async function overview(vendorId) {
  const [inv, pos] = await Promise.all([invoiceRows(vendorId), purchaseOrders(vendorId)]);
  const pays = await paymentRows(vendorId, inv);
  const s = invoiceSummary(inv);
  const recentPayments = [...pays].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 5);
  const recentInvoices = inv.slice(0, 5);
  // "Recent activity": the vendor's own invoices and payments, newest first - read from the same rows, nothing else.
  const activity = [
    ...pays.map((p) => ({ at: p.date, kind: 'payment', text: `Payment received against invoice ${p.invoiceNo}`, amount: p.amount, to: '/vendor/payments' })),
    ...inv.map((r) => ({ at: r.date, kind: 'invoice', text: `Invoice ${r.invoiceNo}: ${r.statusText}`, amount: r.netPayable, to: '/vendor/invoices' })),
    ...pos.map((o) => ({ at: o.orderDate, kind: 'po', text: `Order ${o.poNumber}: ${o.statusText}`, amount: null, to: '/vendor/services' })),
  ].filter((a) => a.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8);
  return {
    invoices: s,
    payments: { count: pays.length, received: ROUND(pays.reduce((t, p) => t + p.amount, 0)), recent: recentPayments },
    purchaseOrders: poSummary(pos),
    recentInvoices,
    activity,
    ...X.dashboardExtras(inv),
    services: { orders: pos.length, agreements: (await X.servicesFor(vendorId, inv, pos)).agreements.length },
  };
}

module.exports = {
  invoiceRows, invoiceSummary, listInvoices, invoiceDetail, paymentRows, listPayments, paymentDetail,
  purchaseOrders, listPurchaseOrders, purchaseOrderDetail, poSummary, overview, services, ROUND,
};
