// ---------------------------------------------------------------------------
// VERIFIED BY THE BANK, OR ONLY RECORDED? (Accounts prompt 2026-10-27: "invoices show Paid without proof; the user cannot
// tell whether a payment was matched to a bank statement, typed by hand, or came from an old Paid flag")
//
// utils/invoicePaymentState.js says how much is received / pending. This file says WHERE that money's evidence is. It READS
// the invoice and its receipt rows (it writes nothing) and sorts every rupee received into one of three:
//   verified           a receipt row linked to a real bank statement CREDIT (not reversed / ignored)
//   pending verification  a receipt row with no bank line: typed by hand ("Record payment", "Settle in full") or imported
//   evidence missing   received on the invoice (Invoice.receivedAmount - an old sheet import, a Paid flag) with NO receipt
//                      row at all: no date, no amount split, no bank line. Nothing is invented for it.
// The invoice then reads (first that fits):
//   Cancelled · Unpaid · Payment evidence missing · Manual payment - verification required · Verified paid ·
//   Partially paid (verified)
// "Verified paid" needs every rupee received to sit on a bank credit AND nothing left to collect.
// ---------------------------------------------------------------------------
const TOL = 0.5;
const R = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rs = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Where one receipt row came from, in plain words.
function sourceOf(p) {
  if (p.bankTxnId && p.dateSource === 'bank-evidence') return 'Bank statement (for money already marked received)';
  if (p.bankTxnId) return p.bankLinked ? 'Recorded by hand, linked to the bank line' : 'Bank statement';
  if (p.method === 'Imported' || p.dateSource === 'sheet' || p.dateSource === 'backfill') return 'Imported from a sheet';
  return 'Recorded by hand';
}

// txn: the BankTransaction row (null = the link points at nothing; undefined = not loaded - a list view trusts the link).
function rowVerified(p, txn) {
  if (!p.bankTxnId) return false;
  if (txn === undefined) return true;
  return !!txn && txn.type === 'Credit' && !['Reversed', 'Ignored'].includes(txn.reconStatus);
}

// inv: { status, receivedAmount, payments[] }; pending: what is still to collect; txnById: Map (optional).
function verifyOf(inv, pending, txnById) {
  const pays = (inv.payments || []).filter((p) => Number(p.amount) !== 0);
  let verified = 0;
  let manual = 0;
  let installments = 0;
  let verifiedInstallments = 0;
  let last = null;
  pays.forEach((p) => {
    const a = Number(p.amount) || 0;
    const ok = rowVerified(p, txnById ? (txnById.get(p.bankTxnId) || null) : undefined);
    if (a > 0) {
      installments += 1;
      if (ok) verifiedInstallments += 1;
      if (p.date && (!last || String(p.date) > last)) last = String(p.date).slice(0, 10);
    }
    if (ok) verified += a; else manual += a;
  });
  verified = R(verified);
  manual = R(Math.max(0, manual));
  const received = R(inv.receivedAmount);
  const missing = R(Math.max(0, received - verified - manual));
  const outstanding = R(Math.max(0, pending));
  const out = {
    verifiedAmount: verified, pendingVerification: manual, missingEvidence: missing, outstanding, received, installments, verifiedInstallments, lastPaymentDate: last,
  };
  if (String(inv.status) === 'Cancelled') return { ...out, state: 'cancelled', label: 'Cancelled', tone: 'grey', reason: 'This invoice is cancelled.' };
  if (received <= TOL && verified + manual <= TOL) return { ...out, state: 'unpaid', label: 'Unpaid', tone: 'grey', reason: `Nothing received yet. ${rs(outstanding)} to collect.` };
  if (missing > TOL) {
    return {
      ...out,
      state: 'missing',
      label: 'Payment evidence missing',
      tone: 'red',
      reason: `${rs(missing)} is marked as received on this invoice, but no payment record (date, amount, bank line) sits behind it - it came from an older import or a Paid mark. It has not been checked against a bank statement.`,
    };
  }
  if (manual > TOL) {
    return {
      ...out,
      state: 'manual',
      label: 'Manual payment - verification required',
      tone: 'amber',
      reason: `${rs(manual)} was recorded by hand or imported and is not linked to a bank statement line yet.${verified > TOL ? ` ${rs(verified)} is matched to the bank.` : ''}`,
    };
  }
  if (outstanding <= TOL) return { ...out, state: 'verified', label: 'Verified paid', tone: 'green', reason: `Every payment (${rs(verified)}) is matched to a bank statement credit.` };
  return { ...out, state: 'partial', label: 'Partially paid (verified)', tone: 'amber', reason: `${rs(verified)} received and matched to the bank; ${rs(outstanding)} still to collect.` };
}

module.exports = { verifyOf, sourceOf, rowVerified };
