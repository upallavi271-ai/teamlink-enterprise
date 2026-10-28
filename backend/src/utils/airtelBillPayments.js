// ---------------------------------------------------------------------------
// AIRTEL BILLS PORTAL - PAYMENT STATUS, READ LIVE FROM ACCOUNTS (2026-10-19). NOTHING IS STORED OR WRITTEN HERE.
//
// An Airtel bill is, in Accounts, an OfficeExpense (the payable). The ONE truth table for "is it really paid?" is
// utils/expensePaymentState.js (judge): it looks at the bill, the bank statement line it points to, whether that line is an OUTGOING
// payment that is matched to THIS bill, set aside, reversed, or smaller than the bill. utils/assetVendorPayments.js (paymentFromJudge) turns that
// answer into the words a vendor may see. This file only adds what the Airtel portal needs on top, and never changes either of them:
//
//   Pending              not paid, not late
//   Overdue              due date passed and nothing (or not enough) is paid        (IST day, the same rule as the Accounts invoices)
//   Partially Paid       the matched bank line covers only part of the bill; paid / balance come from the line
//   Paid                 the money LEFT THE BANK and the line is matched to this bill  (bank-verified)
//   Paid by Accounts     Accounts marked the bill Paid but no bank statement line is matched to it yet. Shown in its own words: it is NOT
//                        "Paid" until the bank statement confirms it. (A vendor, or a portal status, can never produce either Paid.)
//   Reversed             the bank payment was reversed (the money came back): it does not count as paid
//   Waiting for Accounts a bill the vendor sent that Accounts has not booked yet
//   Rejected             Accounts rejected the bill the vendor sent
//
// What a vendor gets about a payment: status, amount paid, balance, the verified payment DATE and a MASKED short reference (last 4 characters
// of the bank's reference, only for a payment a matched bank line shows: Paid, or the paid part of Partially Paid). NEVER: the bank account, the line's id, narration, balance or full reference.
// ---------------------------------------------------------------------------
const PAYS = require('./assetVendorPayments');
const ACC = require('./accounts');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DUE_SOON_DAYS = 7; // "approaching due date" = due within the next 7 days (today counts)

const STATUS = {
  PENDING: 'Pending', WAITING: 'Waiting for Accounts', PAID: 'Paid', PAID_ACCOUNTS: 'Paid by Accounts', PART: 'Partially Paid', OVERDUE: 'Overdue', REVERSED: 'Reversed', REJECTED: 'Rejected',
  UNDER_REVIEW: 'Under Review', // 2026-10-28 (Assets portal Stage E): a linked bank line Accounts has not confirmed - never a payment
};
const TONE = {
  Pending: 'yellow', 'Waiting for Accounts': 'yellow', Paid: 'green', 'Paid by Accounts': 'soft', 'Partially Paid': 'blue', Overdue: 'red', Reversed: 'red', Rejected: 'red', 'Under Review': 'yellow',
};
// How bad a status is, for rolling several bills of one month into one word (worst first).
const WORST_FIRST = [STATUS.OVERDUE, STATUS.REVERSED, STATUS.REJECTED, STATUS.PENDING, STATUS.WAITING, STATUS.PART, STATUS.PAID_ACCOUNTS, STATUS.PAID];
const UNPAID = [STATUS.PENDING, STATUS.OVERDUE, STATUS.PART, STATUS.WAITING, STATUS.REVERSED];

const dayNum = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null; };
// whole days from `today` to `due` (negative = late); null when there is no due date
const daysBetween = (today, due) => { const a = dayNum(today); const b = dayNum(due); return a == null || b == null ? null : b - a; };

// The bank's reference, masked: "UTR123456789" -> "••••6789". A reference shorter than 8 characters is not shown (too easy to read whole).
function maskRef(ref) {
  const s = String(ref == null ? '' : ref).replace(/\s+/g, '');
  return s.length >= 8 ? `••••${s.slice(-4)}` : null;
}

// Final shape of a payment, whatever the source. `a` is a paymentFromJudge / paymentFromModuleBill answer.
function shape(a, { today, dueDate, verified, reference }) {
  const bankBacked = a.basis === 'bank'; // the money is shown by a matched OUTGOING bank line (a full payment is also `verified`)
  let status = a.status;
  if (status === 'Paid' && !verified) status = STATUS.PAID_ACCOUNTS;
  const unpaid = UNPAID.includes(status);
  const days = dueDate ? daysBetween(today, dueDate) : null;
  const overdue = unpaid && status !== STATUS.WAITING && days != null && days < 0;
  const dueSoon = unpaid && days != null && days >= 0 && days <= DUE_SOON_DAYS && status !== STATUS.REVERSED;
  const note = status === STATUS.PAID_ACCOUNTS
    ? 'Accounts has marked this bill paid. It shows as Paid only after the bank statement payment is matched to it.'
    : a.note;
  return {
    status, tone: TONE[status] || 'grey', verified: !!verified, basis: bankBacked ? 'bank' : (status === STATUS.PAID_ACCOUNTS ? 'accounts' : null),
    paidAmount: ROUND(a.paidAmount), balance: ROUND(a.balance), paymentDate: [STATUS.PAID, STATUS.PAID_ACCOUNTS, STATUS.PART].includes(status) ? (a.lastPaymentDate || null) : null,
    reference: bankBacked && reference && [STATUS.PAID, STATUS.PART].includes(status) ? maskRef(reference) : null, overdue: overdue || status === STATUS.OVERDUE, dueSoon, daysToDue: days, dueDate: dueDate || null, note: note || null,
  };
}

// An Accounts bill (OfficeExpense) + its judged state (expensePaymentState.describeMany). Pure.
function fromExpense(expense, judged, today = ACC.istDay()) {
  const a = PAYS.paymentFromJudge(expense, judged, today);
  const verified = a.status === 'Paid' && a.basis === 'bank';
  const line = judged && judged.proof && judged.proof.line;
  const p = shape(a, { today, dueDate: a.dueDate || (expense.dueDate ? String(expense.dueDate).slice(0, 10) : null), verified, reference: line && line.reference });
  // a part payment that is also late is Partially Paid + the late flag (the chip shows both)
  return p;
}
// A bill the vendor sent that has no Accounts bill yet (VendorModuleBill). Accounts' manual "Mark paid" there is NOT a bank match.
function fromModuleBill(b, today = ACC.istDay()) {
  const a = PAYS.paymentFromModuleBill(b, today);
  const p = shape(a, { today, dueDate: a.dueDate || (b.dueDate ? String(b.dueDate).slice(0, 10) : null), verified: false, reference: null });
  return p;
}

// Roll several payments (one month) into one word, worst first. Empty -> null.
function rollup(statuses) {
  const set = new Set(statuses);
  return WORST_FIRST.find((s) => set.has(s)) || null;
}

module.exports = {
  STATUS, TONE, UNPAID, WORST_FIRST, DUE_SOON_DAYS, fromExpense, fromModuleBill, rollup, maskRef, daysBetween, ROUND,
};
