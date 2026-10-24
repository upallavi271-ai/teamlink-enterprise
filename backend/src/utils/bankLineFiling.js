// ---------------------------------------------------------------------------
// WHAT A BANK STATEMENT LINE HAS BEEN FILED AS (Accounts, 2026-10-17) - read only.
//
// The Bank statements table opens one line in a small window (frontend pages/bank/BankLineModal.jsx).
// This file decides the two facts that window adds to what the table row already has:
//   "Filed as"      a short plain label, and its `kind` (the screen picks its message from the kind)
//   "Amount filed"  the part of the line that is recorded against that entry (null = nothing is filed yet)
//
// Nothing here writes, reconciles, categorises or works out an amount of its own: it only READS what the
// reconciliation (routes/bankRecon.js), the categorise panel (routes/bank.js) and the hand loans already stored:
//   receipts on invoices (InvoicePayment.bankTxnId)       -> invoice_receipt
//   a returned receipt (state Reversed)                    -> reversed
//   a client refund (categoryKind refund)                  -> refund
//   a hand loan link / categoryKind hand                   -> loan
//   our own transfer (categoryKind transfer)               -> transfer
//   a partner payout (PartnerPayout.bankTxnId)             -> vendor_payment
//   an office bill / category: salary words -> salary, a vendor -> vendor_payment, else expense (or other)
//   set aside (Ignored / excluded)                         -> ignored
//   nothing filed: money in -> unallocated, money out -> unmatched
// ---------------------------------------------------------------------------
const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const SALARY_RE = /\b(salary|salaries|payroll|wage|wages|stipend)\b/i;

const list = (items, max = 3) => {
  const u = [...new Set(items.filter(Boolean))];
  return u.length > max ? `${u.slice(0, max).join(', ')} +${u.length - max} more` : u.join(', ');
};

// facts = {
//   txn:      the BankTransaction row,
//   state:    its reconciliation state (utils/accounts.js txnState),
//   allocations: [{ amount, invoiceNumber, client }]   receipts that point at this line (a negative one is a reversal),
//   bills:    [{ category, vendor, net }]               office bills paid off this line,
//   loan:     { name } | null,
//   partner:  { name, net } | null,
//   matchedInvoice: { invoiceNumber, client } | null    a legacy Matched line with no receipt row,
// }
function describeFiling(facts) {
  const {
    txn, state, allocations = [], bills = [], loan = null, partner = null, matchedInvoice = null,
  } = facts;
  const credit = txn.type === 'Credit';
  const amount = ROUND(txn.amount);

  if (state === 'Reversed') {
    return { kind: 'reversed', label: 'Returned receipt (bounced or sent back)', amountFiled: null, unallocated: null };
  }
  if (txn.excluded || state === 'Ignored') {
    return { kind: 'ignored', label: 'Set aside — not counted', amountFiled: null, unallocated: null };
  }

  const positive = allocations.filter((a) => Number(a.amount) > 0);
  if (credit && positive.length) {
    const filed = ROUND(allocations.reduce((s, a) => s + Number(a.amount || 0), 0));
    const who = list(positive.map((a) => a.client));
    return {
      kind: 'invoice_receipt',
      label: `Invoice receipt · ${list(positive.map((a) => a.invoiceNumber)) || 'invoice'}${who ? ` · ${who}` : ''}`,
      amountFiled: filed,
      unallocated: ROUND(Math.max(0, amount - filed)),
    };
  }
  if (credit && matchedInvoice && ['Matched', 'Reconciled'].includes(state)) {
    return {
      kind: 'invoice_receipt',
      label: `Invoice receipt · ${matchedInvoice.invoiceNumber || 'invoice'}${matchedInvoice.client ? ` · ${matchedInvoice.client}` : ''}`,
      amountFiled: ROUND(Math.max(0, amount - Number(txn.excess || 0))),
      unallocated: ROUND(Number(txn.excess || 0)),
    };
  }

  if (txn.categoryKind === 'refund') {
    return { kind: 'refund', label: `Client refund · ${txn.counterparty || 'client'}`, amountFiled: amount, unallocated: null };
  }
  if (loan || txn.categoryKind === 'hand') {
    return { kind: 'loan', label: `Hand loan · ${(loan && loan.name) || txn.counterparty || '—'}`, amountFiled: amount, unallocated: null };
  }
  if (txn.categoryKind === 'transfer') {
    return { kind: 'transfer', label: 'Transfer between our own accounts', amountFiled: amount, unallocated: null };
  }
  if (partner) {
    return { kind: 'vendor_payment', label: `Partner payout · ${partner.name || 'partner'}`, amountFiled: partner.net != null ? ROUND(partner.net) : amount, unallocated: null };
  }

  const filedAsBill = bills.length > 0 || !!txn.createdBillId || !!txn.billLinks;
  if (filedAsBill || txn.category || txn.categoryKind === 'expense' || txn.categoryKind === 'other') {
    const cat = txn.category || (bills[0] && bills[0].category) || null;
    const vendor = txn.vendor || (bills.find((b) => b.vendor) || {}).vendor || null;
    const filed = bills.length ? ROUND(bills.reduce((s, b) => s + Number(b.net || 0), 0)) : amount;
    if (SALARY_RE.test(`${cat || ''} ${vendor || ''}`)) {
      return { kind: 'salary', label: cat && !/^salary$/i.test(cat) ? `Salary · ${cat}` : 'Salary', amountFiled: filed, unallocated: null };
    }
    if (vendor) {
      return { kind: 'vendor_payment', label: `Vendor payment · ${vendor}${cat ? ` · ${cat}` : ''}`, amountFiled: filed, unallocated: null };
    }
    if (txn.categoryKind === 'other' && !filedAsBill) {
      return { kind: 'other', label: `Other · ${cat || 'filed by hand'}`, amountFiled: filed, unallocated: null };
    }
    return { kind: 'expense', label: cat ? `Expense · ${cat}` : 'Expense', amountFiled: filed, unallocated: null };
  }

  return credit
    ? { kind: 'unallocated', label: 'Not filed yet — money in', amountFiled: null, unallocated: amount }
    : { kind: 'unmatched', label: 'Not filed yet — money out', amountFiled: null, unallocated: null };
}

// "xxxx3333" — only the last four digits, the same as the Bank statements table shows. null = no number on file.
const maskAccount = (accNo) => {
  const d = String(accNo || '').replace(/\s+/g, '');
  return d ? `xxxx${d.slice(-4)}` : null;
};

module.exports = { describeFiling, maskAccount, SALARY_RE };
