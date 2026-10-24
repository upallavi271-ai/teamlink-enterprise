// ---------------------------------------------------------------------------
// ASSETS VENDOR PORTAL - PAYMENT STATUS, READ LIVE FROM ACCOUNTS (2026-10-19).
//
// A vendor invoice for a repair (or an asset) is, in Accounts, a vendor BILL:
//   VendorBillSubmission (the vendor's invoice waiting in Accounts' "Bills from vendors" queue)
//     -> when an approver approves it: OfficeExpense (the payable; submission.expenseId points at it, billNumber = the invoice no.,
//        vendorId = the vendor)
//     -> Accounts pays it through its own process; a bank statement is imported (routes/accounts-import) and its OUTGOING line is
//        matched to the bill (routes/bank.js match-bills / auto-match): OfficeExpense.bankTxnId + BankTransaction.billLinks.
// utils/expensePaymentState.js is the ONE truth table for "is that bill really paid?". This file only ASKS it and translates the answer into
// what a vendor may see. NOTHING is stored here (no copy to drift): every read recomputes from the persisted Accounts rows, so a bank
// import, a match, an "ignore" or a reversal shows on the vendor's next page load. A vendor can never set a payment status: there is no
// code path that writes one.
//
// What the vendor gets: status (Pending / Waiting for Accounts / Paid / Partially Paid / Overdue / Reversed / Rejected), the amount paid, the
// balance, the date of the last payment, the payment mode of the bill. NEVER: a bank account, the bank line's id / narration / reference /
// balance, another vendor's or the company's other transactions.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./vmDb');
const PAY = require('./expensePaymentState');
const ACC = require('./accounts');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const normRef = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const dayOf = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10); };

const STATUS = {
  PENDING: 'Pending', WAITING: 'Waiting for Accounts', PAID: 'Paid', PART: 'Partially Paid', OVERDUE: 'Overdue', REVERSED: 'Reversed', REJECTED: 'Rejected', NOT_SENT: 'Not sent to Accounts',
};
const TONE = { Pending: 'yellow', 'Waiting for Accounts': 'yellow', Paid: 'green', 'Partially Paid': 'blue', Overdue: 'red', Reversed: 'red', Rejected: 'red', 'Not sent to Accounts': 'grey' };

const out = (status, o = {}) => ({
  status, tone: TONE[status], paidAmount: 0, balance: 0, lastPaymentDate: null, basis: null, overdue: false, dueDate: null, paymentMode: null, note: null, ...o,
});
const isOverdue = (due, today) => !!due && String(due).slice(0, 10) < today;

// THE TRANSLATION (pure). expense = the OfficeExpense, judged = expensePaymentState.judge() of it.
function paymentFromJudge(expense, judged, today = ACC.istDay()) {
  const net = PAY.netOf(expense);
  const due = expense.dueDate ? String(expense.dueDate).slice(0, 10) : null;
  const mode = expense.paymentMode || null;
  if (PAY.approvalOf(expense) === 'REJECTED') return out(STATUS.REJECTED, { dueDate: due, balance: 0, note: 'Accounts rejected this bill.' });
  if (judged.state === 'reversed') {
    return out(STATUS.REVERSED, { balance: net, dueDate: due, paymentMode: mode, note: 'The bank payment was reversed (the money came back). It does not count as paid.' });
  }
  if (judged.state === 'part') {
    return out(STATUS.PART, {
      paidAmount: ROUND(judged.bankPaid), balance: ROUND(judged.balance), lastPaymentDate: dayOf(judged.proof.line && judged.proof.line.date), basis: 'bank', overdue: isOverdue(due, today), dueDate: due, paymentMode: mode,
      note: 'Only part of the amount has been paid so far.',
    });
  }
  if (judged.state === 'confirmed') {
    return out(STATUS.PAID, {
      paidAmount: net, balance: 0, lastPaymentDate: dayOf((judged.proof.line && judged.proof.line.date) || expense.paymentDate), basis: 'bank', dueDate: due, paymentMode: mode,
      note: judged.needsApprover ? 'The payment has left the bank. Accounts is finishing the paperwork.' : 'The payment is confirmed in the bank statement.',
    });
  }
  if (judged.state === 'no_link' && judged.paid) {
    // Paid in Accounts without a bank statement line (cash, or not yet imported): Accounts' own status, not a bank-verified one.
    return out(STATUS.PAID, { paidAmount: net, balance: 0, lastPaymentDate: dayOf(expense.paymentDate || expense.paidAt), basis: 'accounts', dueDate: due, paymentMode: mode, note: 'Marked as paid by Accounts.' });
  }
  // Pending: not paid, or the bank line is not trusted (set aside, broken, linked but not matched) - never shown as Paid.
  const check = judged.inconsistent || ['ignored', 'broken', 'link_only'].includes(judged.state);
  const late = isOverdue(due, today);
  return out(late ? STATUS.OVERDUE : STATUS.PENDING, {
    balance: net, overdue: late, dueDate: due, paymentMode: mode,
    note: check ? 'Accounts is checking this payment. It is not counted as paid yet.' : (late ? 'The payment date has passed.' : 'Waiting for payment.'),
  });
}
// A bill still in Accounts' review queue (no Accounts bill yet).
function paymentFromSubmission(sub) {
  if (sub.status === 'REJECTED') return out(STATUS.REJECTED, { note: 'Accounts rejected this invoice. Correct it and send it again.' });
  if (sub.status === 'WITHDRAWN') return out(STATUS.NOT_SENT, { note: 'You withdrew this invoice.' });
  return out(STATUS.WAITING, { balance: ROUND(sub.total), note: 'Sent. Waiting for Accounts to check it.' });
}
// An order's bill (VendorModuleBill: Accounts marks it Paid with the amount and date).
function paymentFromModuleBill(b, today = ACC.istDay()) {
  const total = ROUND(b.total);
  if (b.status === 'Rejected') return out(STATUS.REJECTED, { note: 'Accounts rejected this invoice.' });
  if (b.status === 'Paid') {
    const paid = b.paidAmount == null ? total : Math.min(ROUND(b.paidAmount), total || ROUND(b.paidAmount));
    const part = paid + 0.5 < total;
    return out(part ? STATUS.PART : STATUS.PAID, { paidAmount: paid, balance: ROUND(Math.max(0, total - paid)), lastPaymentDate: dayOf(DB.toDate(b.paidOn)), basis: 'accounts', paymentMode: b.paymentMode || null });
  }
  const due = b.dueDate ? String(b.dueDate).slice(0, 10) : null;
  const late = b.status === 'Approved' && isOverdue(due, today);
  return out(late ? STATUS.OVERDUE : (b.status === 'Submitted' ? STATUS.WAITING : STATUS.PENDING), { balance: total, overdue: late, dueDate: due, note: b.status === 'Submitted' ? 'Sent. Waiting for Accounts to check it.' : 'Approved. Waiting for payment.' });
}

// ---- the vendor's invoices, read live --------------------------------------------------------------
async function repairLinks(vendorId) {
  const rows = await DB.q('SELECT "billId","repairId" FROM "AssetRepairBill" WHERE "vendorId" = ?', [vendorId]).catch(() => []);
  return new Map(rows.map((r) => [r.billId, r.repairId]));
}
// One vendor-safe row per invoice (a bill the vendor sent, or a bill Accounts booked against this vendor).
async function invoiceRows(v, today = ACC.istDay()) {
  const [subs, exps, links] = await Promise.all([
    prisma.vendorBillSubmission.findMany({ where: { vendorId: v.vendorId }, orderBy: { submittedAt: 'desc' } }),
    prisma.officeExpense.findMany({ where: { vendorId: v.vendorId, entryKind: { not: 'hand' } } }),
    repairLinks(v.vendorId),
  ]);
  const judged = await PAY.describeMany(prisma, exps);
  const expById = new Map(exps.map((e) => [e.id, e]));
  const subByExp = new Map(subs.filter((s) => s.expenseId).map((s) => [s.expenseId, s]));
  const rows = [];
  const base = (o) => ({ repairId: null, assetCode: null, assetName: null, hasDocument: false, rejectionReason: null, ...o });
  for (const s of subs) {
    const e = s.expenseId ? expById.get(s.expenseId) : null;
    if (s.status === 'WITHDRAWN') continue; // eslint-disable-line no-continue
    if (e) {
      rows.push(base({
        key: `sub:${s.id}`, source: 'Vendor Portal', billCode: s.billCode, invoiceNo: e.billNumber || s.billNumber, billDate: e.expenseDate || s.billDate, dueDate: e.dueDate || null,
        amount: ROUND(Number(e.monthlyAmount) - Number(e.gstAmount)), gst: ROUND(e.gstAmount), tds: ROUND(e.tdsAmount), total: ROUND(e.monthlyAmount), net: PAY.netOf(e),
        payment: paymentFromJudge(e, judged.get(e.id), today), repairId: links.get(s.id) || null, assetCode: s.assetCode, assetName: s.assetName, hasDocument: !!s.documentFile, submissionId: s.id, expenseKey: e.id,
      }));
    } else if (s.status !== 'APPROVED') {
      rows.push(base({
        key: `sub:${s.id}`, source: 'Vendor Portal', billCode: s.billCode, invoiceNo: s.billNumber, billDate: s.billDate, dueDate: null, amount: ROUND(s.amount), gst: ROUND(s.gst), tds: ROUND(s.tds),
        total: ROUND(Number(s.amount) + Number(s.gst)), net: ROUND(s.total), payment: paymentFromSubmission(s), repairId: links.get(s.id) || null, assetCode: s.assetCode, assetName: s.assetName,
        hasDocument: !!s.documentFile, rejectionReason: s.status === 'REJECTED' ? s.rejectionReason : null, submissionId: s.id,
      }));
    }
  }
  for (const e of exps) {
    if (subByExp.has(e.id) || PAY.approvalOf(e) === 'REJECTED') continue; // eslint-disable-line no-continue
    rows.push(base({
      key: `exp:${e.id}`, source: 'Accounts', billCode: null, invoiceNo: e.billNumber || null, billDate: e.expenseDate || null, dueDate: e.dueDate || null,
      amount: ROUND(Number(e.monthlyAmount) - Number(e.gstAmount)), gst: ROUND(e.gstAmount), tds: ROUND(e.tdsAmount), total: ROUND(e.monthlyAmount), net: PAY.netOf(e),
      payment: paymentFromJudge(e, judged.get(e.id), today), expenseKey: e.id,
    }));
  }
  return rows.sort((a, b) => String(b.billDate || '').localeCompare(String(a.billDate || '')) || String(b.invoiceNo || '').localeCompare(String(a.invoiceNo || '')));
}
// The invoice that belongs to ONE repair: the bill sent for it (the stored link), else a bill of this vendor with the same invoice number
// (stable reference, never the vendor's name alone) - e.g. one Accounts booked by hand.
function invoiceOfRepair(rows, repair) {
  const linked = rows.filter((r) => r.repairId === repair.id && r.payment.status !== STATUS.REJECTED);
  if (linked.length) return linked[0];
  const key = normRef(repair.invoiceNo);
  if (!key) return null;
  return rows.find((r) => !r.repairId && normRef(r.invoiceNo) === key && (!r.assetCode || r.assetCode === (repair.asset && repair.asset.assetCode))) || null;
}
const safe = (r) => (r ? {
  key: r.key, invoiceNo: r.invoiceNo, billCode: r.billCode, billDate: r.billDate, dueDate: r.dueDate, amount: r.amount, gst: r.gst, tds: r.tds, total: r.total, net: r.net,
  source: r.source, hasDocument: r.hasDocument, rejectionReason: r.rejectionReason, payment: r.payment, repairId: r.repairId,
} : null);

module.exports = { STATUS, TONE, paymentFromJudge, paymentFromSubmission, paymentFromModuleBill, invoiceRows, invoiceOfRepair, repairLinks, safe, normRef };
