// ---------------------------------------------------------------------------
// VENDOR EXPORT - the "Export Excel" / "Export CSV" buttons of EVERY vendor portal (2026-10-19).
// Route: routes/vendorIo.js  GET /api/vendor-portal/vendor-io/export/:list?format=csv|xlsx&<the list's own search / filters / sort>
//
// RULES (all enforced here, never in the browser):
//   * The vendor comes from the SESSION. A vendorId in the query is never read.
//   * The rows come from the SAME function the list page calls, with the SAME search / filters / sort, only without paging (utils/exportAll.js).
//     So an export holds exactly the rows the list shows under those filters - nothing more, nothing the page does not show.
//   * Only the columns the portal itself shows: full SIM numbers (shown in full since 2026-10-29), no bank account, narration, UTR, bank line id, bank balance,
//     no employee personal data (department only), no purchase cost unless the login may see it. The ID-card lists carry the ID-card fields
//     the vendor needs to print the card (that is what the old CSV already held).
//   * CSV: UTF-8 with a byte-order mark (Excel shows it right) and the formula guard (a cell starting with = + - @ gets a leading apostrophe).
//     Excel: the same guard (utils/tabularExport.js -> utils/formulaGuard.js).
//   * The login needs the "Download lists" tick (module permission "download", on by default); without it the server answers 403.
//   * One audit row per export: who, when, which list, how many rows. No data in it.
//   * A list over 10,000 rows is refused with a plain message (narrow it with a search or dates), never cut off silently.
// ---------------------------------------------------------------------------
const { toCsv, toXlsx } = require('./tabularExport');
const { EXPORT_ALL, MAX_EXPORT_ROWS } = require('./exportAll');
const VP = require('./vendorPortal');
const R = require('./vendorRecords');
const AVP = require('./assetVendorPortal');
const IDC = require('./idCardVendorPortal');
const ATB = require('./airtelBillsPortal');

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const num = (n) => (n == null || n === '' ? '' : Number(n));
const dayOnly = (s) => (s ? String(s).slice(0, 10) : '');
const whenOf = (s) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('T', ' ').slice(0, 16); };

// The query keys a list understands. Anything else is dropped (so a stray key can never change what is exported).
const FILTER_KEYS = ['q', 'status', 'stage', 'category', 'payment', 'condition', 'kind', 'method', 'period', 'sim', 'department', 'bucket', 'printing', 'delivery', 'file', 'view', 'from', 'to', 'sort', 'dir'];
function filtersOf(query) {
  const out = {};
  FILTER_KEYS.forEach((k) => { if (query && query[k] !== undefined && query[k] !== null && typeof query[k] !== 'object') out[k] = String(query[k]).slice(0, 120); });
  return out;
}
const withAll = (q) => ({ ...q, [EXPORT_ALL]: true });

// ---- the lists ----------------------------------------------------------------------------------------------------
// fetch(v, q) -> { rows: [<row objects>], total } ; map(row) -> an array of cells in the order of `headers`.
const LISTS = {
  finance: {
    invoices: {
      label: 'Invoices', file: 'invoices', sheet: 'Invoices',
      headers: ['Invoice no.', 'Invoice code', 'Date', 'Due date', 'Description', 'Amount', 'GST', 'TDS', 'Net payable', 'Paid', 'Outstanding', 'Status', 'Payment date', 'Payment mode'],
      fetch: (v, q) => R.listInvoices(v.vendorId, withAll(q)),
      map: (r) => [r.invoiceNo, r.billCode || '', r.date || '', r.dueDate || '', r.description || '', num(r.amount), num(r.gst), num(r.tds), num(r.netPayable), num(r.paidAmount), num(r.outstanding), r.statusText, r.paymentDate || '', r.paymentMode || ''],
    },
    payments: {
      label: 'Payments', file: 'payments', sheet: 'Payments',
      headers: ['Date', 'Reference', 'Invoice', 'Amount', 'Method', 'Status', 'Still to pay on the invoice'],
      fetch: (v, q) => R.listPayments(v.vendorId, withAll(q)),
      map: (r) => [r.date || '', r.reference || '', r.invoiceNo || '', num(r.amount), r.method || '', r.status, num(r.outstandingOnInvoice)],
    },
    'purchase-orders': {
      label: 'Purchase Orders', file: 'purchase-orders', sheet: 'Purchase Orders',
      headers: ['PO number', 'Order date', 'Expected delivery', 'Details', 'Status', 'Delivered on'],
      fetch: (v, q) => R.listPurchaseOrders(v.vendorId, withAll(q)),
      map: (r) => [r.poNumber, r.orderDate || '', r.expectedDelivery || '', r.description || '', r.statusText, r.deliveredOn || ''],
    },
  },
  assets: {
    assets: {
      label: 'Assets', file: 'assets', sheet: 'Assets',
      // exactly what the Assets page shows: the tab (view=available | repair) is part of the filters
      headers: (v) => ['Asset ID', 'Name', 'Category', 'Brand', 'Model', 'Serial number', 'Condition', 'Department', 'Status', 'Repair step', 'Warranty until', 'Warranty', ...(v.showAmounts === false ? [] : ['Amount', 'GST', 'Total'])],
      fetch: (v, q) => AVP.listAssets(v, withAll(q)),
      map: (r, v) => [r.assetCode, r.name, r.category || '', r.brand || '', r.model || '', r.serialNumber || '', r.condition || '', r.department || '', r.status, r.repairStage || '', r.warranty && r.warranty.until ? r.warranty.until : '', r.warranty ? r.warranty.status : '',
        ...(v.showAmounts === false ? [] : [r.amount == null ? 'Not recorded' : num(r.amount), r.gst == null ? '' : num(r.gst), r.amountTotal == null ? '' : num(r.amountTotal)])],
    },
    orders: {
      label: 'Orders', file: 'orders', sheet: 'Orders',
      headers: ['Order', 'Type', 'Order date', 'Details', 'Quantity', 'Amount', 'Delivery status', 'Payment'],
      fetch: (v, q) => AVP.listOrders(v, withAll(q)),
      map: (r) => [r.orderNo, r.kindText, r.orderDate || '', r.description || '', num(r.quantity), num(r.amount), r.deliveryStatus, r.payment ? r.payment.status : ''],
    },
    repairs: {
      label: 'Repairs', file: 'repairs', sheet: 'Repairs',
      headers: (v) => ['Repair ID', 'Asset ID', 'Asset', 'Problem', 'Reported', 'Repair step', 'Expected date', 'Estimate', 'Final cost', 'GST', 'Invoice number', 'Payment', 'Ticket', 'Warranty', ...(v.showAmounts === false ? [] : ['Asset amount'])],
      fetch: (v, q) => AVP.listRepairs(v, withAll(q)),
      map: (r, v) => [r.repairNo, r.assetCode, r.assetName, r.issue || '', r.dateReported || '', r.stage, r.expectedDate || '', num(r.estimateTotal), num(r.finalCost), num(r.finalGst), r.invoiceNo || '', r.payment ? r.payment.status : '', r.ticketRef || '', r.warranty ? r.warranty.status : '',
        ...(v.showAmounts === false ? [] : [r.amount == null ? 'Not recorded' : num(r.amount)])],
    },
    history: {
      label: 'Repair History', file: 'repair-history', sheet: 'Repair History',
      headers: ['When', 'Repair', 'Asset', 'Changed by', 'What changed', 'From', 'To'],
      fetch: (v, q) => AVP.listHistory(v, withAll(q)),
      map: (e) => [whenOf(e.at), e.repairNo || '', [e.assetCode, e.assetName].filter(Boolean).join(' - '), e.by, e.field || e.kind, e.kind === 'remark' ? '' : (e.from == null ? '' : e.from), e.to == null || e.to === '' ? (e.note || '') : e.to],
    },
    invoices: {
      label: 'Invoices', file: 'invoices', sheet: 'Invoices',
      headers: ['Invoice number', 'Repair', 'Asset', 'Invoice date', 'Total', 'Payment', 'Paid', 'Balance', 'File attached'],
      fetch: (v, q) => AVP.listInvoices(v, withAll(q)),
      map: (r) => [r.invoiceNo || '', r.repairNo || '', [r.assetCode, r.assetName].filter(Boolean).join(' - '), r.billDate || '', num(r.total), r.payment ? r.payment.status : '', r.payment ? num(r.payment.paidAmount) : '', r.payment ? num(r.payment.balance) : '', r.hasDocument ? 'Yes' : 'No'],
    },
    // "My bills" (Upload repair bill): the vendor's own uploads, with the same search / filters / sort as the page
    'bill-uploads': {
      label: 'My uploaded bills', file: 'my-bills', sheet: 'My bills',
      headers: ['Bill', 'Uploaded', 'Repair', 'Asset', 'Invoice number', 'Invoice date', 'Total', 'Status', 'Note'],
      fetch: (v, q) => require('./billUploads').listForVendor(v, withAll(q)), // eslint-disable-line global-require
      map: (r) => [r.code, whenOf(r.uploadedAt), r.repairNo || '', [r.assetCode, r.assetName].filter(Boolean).join(' - '), r.invoiceNo || '', r.invoiceDate || '', num(r.total), r.statusLabel, r.reason || ''],
    },
  },
  idcards: {
    requests: {
      label: 'ID card requests', file: 'id-card-requests', sheet: 'ID card requests',
      headers: IDC.CSV_HEAD,
      // the ID-card list is SQL: one more than the maximum is read, to know when it is too big
      fetch: async (v, q) => { const rows = await IDC.exportRows(v, q, MAX_EXPORT_ROWS + 1); return { rows, total: rows.length, plain: true }; },
      map: (r) => r,
    },
  },
  telecom: {
    bills: {
      label: 'Bills', file: 'bills', sheet: 'Bills',
      headers: ['Invoice number', 'Bill date', 'Bill month', 'Due date', 'Amount', 'Tax', 'Total payable', 'Payment', 'Paid', 'Still to pay'],
      fetch: (v, q) => ATB.listBills(v, withAll(q)),
      map: (r) => [r.invoiceNo || '', r.billDate || '', r.periodLabel || r.billMonth || '', r.dueDate || '', num(r.amount), num(r.tax), num(r.total), r.payment ? r.payment.status : '', r.payment ? num(r.payment.paidAmount) : '', r.payment ? num(r.payment.balance) : ''],
    },
    history: {
      label: 'Monthly History', file: 'monthly-history', sheet: 'Monthly History',
      headers: ['Month', 'Bill amount', 'Due date', 'Paid', 'Still to pay', 'Status', 'Invoice number', 'Payment reference'],
      fetch: (v, q) => ATB.listHistory(v, withAll(q)),
      map: (r) => [r.label, r.noBill ? '' : num(r.billAmount), r.dueDate || '', r.noBill ? '' : num(r.paidAmount), r.noBill ? '' : num(r.outstanding), r.noBill ? 'No bill recorded' : (r.status || ''), (r.invoiceNos || []).join(', '), (r.references || []).join(', ')],
    },
    sims: {
      label: 'SIMs', file: 'sims', sheet: 'SIMs',
      headers: ['SIM ID', 'Mobile number', 'Used by (now)', 'Employee ID', 'SIM card', 'Department', 'Status', 'Last bill'],
      fetch: (v, q) => ATB.listSims(v, withAll(q)),
      map: (r) => [r.simRef, r.number || '', r.usedBy ? r.usedBy.name || '' : 'Nobody (in stock)', r.usedBy ? r.usedBy.employeeCode || '' : '', r.iccid || '', r.department || '', r.status, r.lastBill ? `${r.lastBill.invoiceNo || ''} ${r.lastBill.periodLabel || ''}`.trim() : ''],
    },
  },
};

const FILE_SAFE = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'vendor';
const stamp = () => new Date().toISOString().slice(0, 10);

class ExportError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }

function listsOf(kind) { return LISTS[kind] || {}; }

// -> { buffer, filename, mime, count }  (throws ExportError)
async function build(kind, listKey, v, query, format) {
  const def = listsOf(kind)[listKey];
  if (!def) throw new ExportError(404, 'This list cannot be exported.');
  const fmt = format === 'xlsx' ? 'xlsx' : 'csv';
  const out = await def.fetch(v, filtersOf(query));
  const rows = out.rows || [];
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new ExportError(413, `This list has ${out.plain ? 'more than 10,000' : rows.length.toLocaleString('en-IN')} rows. One export holds at most 10,000. Narrow the list with a search or a date range, then export again.`, { tooMany: true });
  }
  const headers = typeof def.headers === 'function' ? def.headers(v) : def.headers;
  const cells = rows.map((r) => def.map(r, v).map((c) => (c === undefined || c === null ? '' : c)));
  const base = `${def.file}-${FILE_SAFE(v.vendorName)}-${stamp()}`;
  if (fmt === 'csv') {
    return { buffer: Buffer.from(`﻿${toCsv(headers, cells)}\r\n`, 'utf8'), filename: `${base}.csv`, mime: 'text/csv; charset=utf-8', count: rows.length, label: def.label, format: fmt };
  }
  return { buffer: toXlsx(headers, cells, def.sheet), filename: `${base}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', count: rows.length, label: def.label, format: fmt };
}

// One audit row per export. No data in it - only who, when, which list, how many rows.
async function audit(req, v, listKey, built) {
  await VP.auditReq(req, {
    vendorId: v.vendorId, vendorUserId: v.userId, actorName: `${v.name} (vendor ${v.vendorName})`, role: 'Vendor',
    action: 'List exported', documentName: built.filename, newValue: `${listKey} · ${built.count} row(s) · ${built.format}`, status: 'Exported',
  });
}

// One export at a time per login (a big list is built in memory).
const running = new Set();
async function guarded(userId, fn) {
  if (running.has(userId)) throw new ExportError(429, 'Your last export is still being prepared. Wait a moment, then try again.');
  running.add(userId);
  try { return await fn(); } finally { running.delete(userId); }
}

module.exports = { LISTS, listsOf, build, audit, guarded, filtersOf, ExportError, str, dayOnly };
