// ---------------------------------------------------------------------------
// THE ONE TRUTH TABLE FOR "HAS THIS CLIENT INVOICE REALLY BEEN PAID?" (Accounts, 2026-10-21)
//
// The twin of utils/expensePaymentState.js, for the money we RECEIVE. An invoice can carry proof - a proof file,
// a typed bank reference / UTR, a bank statement line - without any receipt being recorded. Before this file such an
// invoice said just "Pending" next to a "Proof" column and nothing said why. This file READS the invoice (it writes
// nothing) and answers in plain words; the list, the details, the dashboard and the exports print the answer.
//
// WHAT COUNTS AS MONEY RECEIVED (never changed here):
//   Invoice.receivedAmount      what has been received (every receipt - Record payment, a matched bank credit, an import -
//                               adds to it and re-derives the status in utils/accounts.js, so the status always follows it)
//   InvoicePayment rows         the receipts themselves (each may carry the bank line that proves it)
// WHAT IS ONLY PROOF (never money by itself - a file, a UTR or a link is not a payment):
//   Invoice.proofFile / proofRef / proofName     the proof attached on the Accounts dashboard
//   Invoice.bankTxnId                            the bank line that closed the invoice off
//
// THE TABLE (first row that fits wins):
//   cancelled                                     -> "cancelled"
//   nothing left to collect                       -> "paid"        (proof, if any, is just the proof)
//   receipts recorded, balance left               -> "part"        Rs X received of Y, balance Z
//   receipt rows add up to MORE than the invoice  -> "unrecorded"  the receipts exist but the invoice total was not updated: a repair
//     says is received (should not happen)                         (scripts/pending-with-proof-repair.js) brings it in line
//   a bank credit is MATCHED to it (Bank &        -> "matched"     "Bank credit matched - receipt not posted yet": the bank screen's own
//     Reconciliation) but not yet posted as a receipt                two steps (Match, then Reconcile) - the receipt is what moves the money
//   proof attached, no receipt at all             -> "proof_only"  "Proof attached - payment not recorded yet" + the one-click
//                                                                  "Record payment" (amount = balance, reference = the proof's UTR)
//   nothing                                       -> "none"
//
// A bare proof file NEVER moves an invoice to Paid or Partially Paid. Only a recorded receipt does.
// ---------------------------------------------------------------------------
const { invoiceOutstanding } = require('./accounts');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const TOL = 0.5; // the same "closed" slack as utils/accounts.js SETTLED_TOLERANCE
const rs = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// What proof does this invoice carry? (pure; a bank line counts only as a reference here)
function proofOf(inv) {
  const pays = inv.payments || [];
  const file = !!inv.proofFile;
  const ref = String(inv.proofRef || '').trim() || null;
  const bankLine = !!inv.bankTxnId || pays.some((p) => p.bankTxnId);
  const payRefs = pays.map((p) => String(p.reference || '').trim()).filter(Boolean);
  const has = file || !!ref || bankLine;
  const bits = [file ? (inv.proofName || 'proof file') : null, ref ? `ref ${ref}` : null, bankLine ? 'bank line' : null].filter(Boolean);
  return {
    has, file, ref, bankLine, name: inv.proofName || null, at: inv.proofAt || null, by: inv.proofBy || null, refs: ref ? [ref, ...payRefs] : payRefs, text: has ? bits.join(' · ') : null,
  };
}

// opts.pending: the figure the screen already works out (after credit / debit notes); default = utils/accounts invoiceOutstanding.
// opts.matchedLines: bank credits in state 'Matched' (not yet Reconciled) that point at this invoice: [{ date, amount }].
function judge(inv, opts = {}) {
  const proof = proofOf(inv);
  const pays = inv.payments || [];
  const received = ROUND(inv.receivedAmount);
  const paysTotal = ROUND(pays.reduce((s, p) => s + Number(p.amount || 0), 0));
  const pending = opts.pending != null ? ROUND(opts.pending) : invoiceOutstanding(inv);
  const base = {
    received, pending: Math.max(0, pending), paysTotal, proof, action: null, needsRecord: false, inconsistent: false,
  };
  if (String(inv.status) === 'Cancelled') {
    return {
      ...base, state: 'cancelled', label: 'Cancelled', short: 'Cancelled', tone: 'grey', reason: 'This invoice is cancelled.',
    };
  }
  if (pending <= TOL) {
    return {
      ...base, state: 'paid', label: 'Paid', short: 'Paid', tone: 'green', pending: 0, reason: `Paid. ${rs(received)} received${proof.has ? `; proof on file (${proof.text}).` : '.'}`,
    };
  }
  // receipt rows exist for more than the invoice says it received: the receipts are real, the total was not brought up
  if (pays.length && paysTotal > received + TOL) {
    return {
      ...base,
      state: 'unrecorded',
      label: 'Receipts recorded - total not updated',
      short: 'Receipts recorded - total not updated',
      tone: 'red',
      inconsistent: true,
      reason: `${pays.length} receipt(s) add up to ${rs(paysTotal)}, but the invoice says only ${rs(received)} was received, so it still shows ${rs(pending)} pending. Run the repair to bring the total in line.`,
    };
  }
  const ml = (opts.matchedLines || []).filter(Boolean);
  if (received <= TOL && ml.length) {
    const m0 = ml[0];
    return {
      ...base,
      state: 'matched',
      label: 'Bank credit matched - receipt not posted yet',
      short: 'Bank credit matched - receipt not posted yet',
      tone: 'amber',
      needsRecord: true,
      reason: `A bank credit of ${rs(m0.amount)} (${m0.date}) is matched to this invoice in Bank & Reconciliation, but it has not been posted as a receipt, so the ${rs(pending)} still shows as pending. Press Reconcile on that bank line to post it.`,
      action: { type: 'reconcile-line', amount: ROUND(m0.amount), reference: null },
    };
  }
  if (received > TOL) {
    return {
      ...base,
      state: 'part',
      label: `Part paid: ${rs(received)} received, ${rs(pending)} pending`,
      short: 'Part paid',
      tone: 'amber',
      reason: `${rs(received)} has been received. ${rs(pending)} is still to come${proof.has ? ` (proof on file: ${proof.text}).` : '.'}`,
    };
  }
  if (proof.has) {
    return {
      ...base,
      state: 'proof_only',
      label: 'Proof attached - payment not recorded yet',
      short: 'Proof attached - payment not recorded yet',
      tone: 'amber',
      needsRecord: true,
      reason: `Proof is attached (${proof.text}) but no payment has been recorded on this invoice, so the full ${rs(pending)} still shows as pending. A proof on its own is not a payment: press "Record payment" to record what was received.`,
      action: { type: 'record-payment', amount: ROUND(pending), reference: proof.ref || null },
    };
  }
  return {
    ...base, state: 'none', label: 'Not paid yet', short: 'Pending', tone: 'grey', reason: `Nothing received yet. ${rs(pending)} pending.`,
  };
}

// The trimmed answer a table row carries (the details view gets the whole thing).
function brief(p) {
  if (!p) return null;
  return {
    state: p.state, label: p.label, short: p.short, tone: p.tone, reason: p.reason, needsRecord: p.needsRecord, inconsistent: p.inconsistent, received: p.received, pending: p.pending, action: p.action,
    proof: { has: p.proof.has, file: p.proof.file, ref: p.proof.ref, bankLine: p.proof.bankLine, text: p.proof.text },
  };
}

module.exports = { judge, brief, proofOf, TOL };
