// ---------------------------------------------------------------------------
// VENDOR INVOICES (payables) — what we owe a vendor, and what has been paid.
//
// A vendor invoice is either
//   * a bill the vendor sent through the portal (VendorBillSubmission) that is
//     still waiting / rejected / withdrawn, or
//   * the Accounts bill (OfficeExpense) that is linked to the vendor by
//     vendorId — booked by Accounts, or created when a portal bill was approved.
// An approved portal bill and its Accounts bill are ONE row here (the
// submission's expenseId points at the expense). A client SALES invoice
// (Invoice table) is a different thing and never appears here.
//
// Payment details come off the Accounts bill: total = amount + GST, TDS is what
// we deducted, net = total - TDS (what actually goes to the vendor), paid when
// the bill is Paid / Reimbursed, outstanding = net while unpaid.
//
// forVendor=true returns ONLY fields a vendor may see (no internal ids, no
// journal / ledger / approver names / remarks).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function fromExpense(e, sub) {
  const total = ROUND(e.monthlyAmount);
  const gst = ROUND(e.gstAmount);
  const tds = ROUND(e.tdsAmount);
  const net = ROUND(total - tds);
  const paid = ['PAID', 'REIMBURSED'].includes(e.approvalStatus);
  return {
    key: `exp:${e.id}`,
    source: sub ? 'Vendor Portal' : 'Accounts',
    expenseId: e.id,
    expenseCode: e.expenseCode || null,
    submissionId: sub ? sub.id : null,
    billCode: sub ? sub.billCode : null,
    billNumber: e.billNumber || (sub && sub.billNumber) || null,
    billDate: e.expenseDate || (sub && sub.billDate) || null,
    dueDate: e.dueDate || null,
    amount: ROUND(total - gst),
    gst,
    tds,
    total,
    netPayable: net,
    paid,
    status: paid ? 'PAID' : 'PENDING_PAYMENT',
    statusText: paid ? 'Paid' : 'Approved, waiting for payment',
    paidAmount: paid ? net : 0,
    outstanding: paid ? 0 : net,
    paymentDate: paid ? (e.paymentDate || isoDay(e.paidAt) || isoDay(e.reimbursedAt)) : null,
    paymentMode: paid ? (e.paymentMode || null) : null,
    description: e.description || null,
    hasDocument: !!(sub && sub.documentFile),
    vendorNameSnap: e.vendor || null,
  };
}
const SUB_TEXT = {
  PENDING_REVIEW: 'Sent, waiting for Accounts to check', VERIFIED: 'Checked, waiting for approval', REJECTED: 'Rejected — see the reason',
  WITHDRAWN: 'Withdrawn by you', APPROVED: 'Approved, waiting for payment',
};
function fromSubmission(b) {
  const open = ['PENDING_REVIEW', 'VERIFIED'].includes(b.status);
  return {
    key: `sub:${b.id}`,
    source: 'Vendor Portal',
    expenseId: null,
    expenseCode: null,
    submissionId: b.id,
    billCode: b.billCode,
    billNumber: b.billNumber,
    billDate: b.billDate,
    dueDate: null,
    amount: ROUND(b.amount),
    gst: ROUND(b.gst),
    tds: ROUND(b.tds),
    total: ROUND(Number(b.amount || 0) + Number(b.gst || 0)),
    netPayable: ROUND(b.total),
    paid: false,
    status: b.status,
    statusText: SUB_TEXT[b.status] || b.status,
    paidAmount: 0,
    outstanding: open ? ROUND(b.total) : 0,
    paymentDate: null,
    paymentMode: null,
    description: b.remarks || null,
    rejectionReason: b.status === 'REJECTED' ? b.rejectionReason : null,
    hasDocument: !!b.documentFile,
    assetCode: b.assetCode || null,
    assetName: b.assetName || null,
    vendorNameSnap: b.vendorNameSnap || null,
  };
}

async function listVendorInvoices(vendorId, { forVendor = false } = {}) {
  const [subs, exps] = await Promise.all([
    prisma.vendorBillSubmission.findMany({ where: { vendorId } }),
    prisma.officeExpense.findMany({ where: { vendorId, entryKind: { not: 'hand' }, NOT: { approvalStatus: 'REJECTED' } } }),
  ]);
  const expById = new Map(exps.map((e) => [e.id, e]));
  const subByExp = new Map(subs.filter((s) => s.expenseId).map((s) => [s.expenseId, s]));
  const rows = [];
  for (const s of subs) {
    const e = s.expenseId ? expById.get(s.expenseId) : null;
    if (e) rows.push(fromExpense(e, s));
    else if (s.status !== 'APPROVED') rows.push(fromSubmission(s)); // an approved one whose expense is gone/rejected is not "owed"
  }
  for (const e of exps) if (!subByExp.has(e.id)) rows.push(fromExpense(e, null));
  rows.sort((a, b) => String(b.billDate || '').localeCompare(String(a.billDate || '')) || String(b.billNumber || '').localeCompare(String(a.billNumber || '')));
  const live = rows.filter((r) => !['REJECTED', 'WITHDRAWN'].includes(r.status));
  const summary = {
    count: rows.length,
    invoiced: ROUND(live.reduce((t, r) => t + r.netPayable, 0)),
    paid: ROUND(live.reduce((t, r) => t + r.paidAmount, 0)),
    outstanding: ROUND(live.reduce((t, r) => t + r.outstanding, 0)),
    tds: ROUND(live.reduce((t, r) => t + r.tds, 0)),
  };
  if (!forVendor) return { rows, summary };
  const VENDOR_FIELDS = [
    'key', 'submissionId', 'billCode', 'billNumber', 'billDate', 'dueDate', 'amount', 'gst', 'tds', 'total', 'netPayable', 'paid', 'status', 'statusText',
    'paidAmount', 'outstanding', 'paymentDate', 'paymentMode', 'description', 'rejectionReason', 'hasDocument', 'assetCode', 'assetName',
  ];
  return {
    rows: rows.map((r) => Object.fromEntries(VENDOR_FIELDS.map((k) => [k, r[k] === undefined ? null : r[k]]))),
    summary,
  };
}

module.exports = { listVendorInvoices, fromExpense, fromSubmission };
