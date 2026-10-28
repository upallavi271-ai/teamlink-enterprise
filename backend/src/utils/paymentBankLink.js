// ---------------------------------------------------------------------------
// A PAYMENT AND ITS BANK STATEMENT LINE, BOTH WAYS (Accounts prompt 2026-10-27: "complete automatic bank statement linking,
// paid status & reconciliation").
//
// Statement imported AFTER the payment was recorded: utils/reconMatch.js rungs 1 / 1b (exact reference, or the invoice
// number in the narration + a waiting receipt of exactly that amount) link the line to the receipt on import.
// Payment recorded AFTER the statement was imported: this file looks through the lines already imported.
//
// A line is linked to a receipt ONLY on a reliable match, never on the amount alone:
//   exact amount (to the paisa) AND ( the receipt's reference / UTR (6+ characters) is in the line's narration / reference
//                                     OR the narration names THIS invoice's number (a strong number, and no other invoice) )
// and only when that is true for exactly ONE waiting line and that line fits no other waiting receipt the same way.
// Two or more such lines (or another receipt fitting the same line) = "Multiple Possible Matches - Verification Required":
// nothing is linked. Lines with only the same amount near the payment date are shown as possibilities, never linked.
// Linking goes through routes/bank.js linkPayment (the receipt gets the line as its proof; no money moves; audited) and is
// idempotent: a receipt that already has a line, or a line already used, is never touched.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const RM = require('./reconMatch');

const NEAR_DAYS = 10; // "possible" lines: same amount within this many days of the payment date (display only)
const refKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const DEAD = ['Reconciled', 'Ignored', 'Reversed'];

// Credits of exactly this amount that nothing has claimed yet: no receipt points at them, not reconciled / ignored /
// reversed, not filed as income / loan / transfer, not set aside.
async function waitingLinesOf(amount) {
  const p = RM.toPaise(amount);
  const lines = await prisma.bankTransaction.findMany({
    where: { type: 'Credit', excluded: false, amount: { gte: (p - 0.5) / 100, lte: (p + 0.5) / 100 } },
  });
  const exact = lines.filter((t) => RM.toPaise(t.amount) === p && !DEAD.includes(t.reconStatus) && !t.matched && !t.category && !t.categoryKind);
  if (!exact.length) return [];
  const used = new Set((await prisma.invoicePayment.findMany({ where: { bankTxnId: { in: exact.map((t) => t.id) } }, select: { bankTxnId: true } })).map((x) => x.bankTxnId));
  return exact.filter((t) => !used.has(t.id));
}

// Why a line fits a receipt reliably (null = it does not). invoices: every non-cancelled invoice (to be sure the
// narration names THIS one and no other).
function reliableWhy(line, pay, invoice, invoices) {
  const refs = RM.extractRefs(line.description, line.reference, line.externalId);
  const k = refKey(pay.reference);
  if (k.length >= 6 && refs.includes(k)) return `reference ${pay.reference} is on the bank line`;
  const named = RM.invoicesNamed(String(`${line.description || ''} ${line.reference || ''}`).toUpperCase(), invoices);
  if (named.length === 1 && named[0].strong && named[0].inv.id === invoice.id) return `invoice number ${invoice.invoiceNumber} is in the narration`;
  return null;
}

// Everything known about one receipt that has no bank line: { sure, why, reliable[], possible[] }.
async function searchFor(pay, ctx = {}) {
  const invoice = ctx.invoice || await prisma.invoice.findUnique({ where: { id: pay.invoiceId } });
  const invoices = ctx.invoices || await prisma.invoice.findMany({ where: { status: { not: 'Cancelled' } }, select: { id: true, invoiceNumber: true, status: true } });
  const lines = await waitingLinesOf(pay.amount);
  const reliable = [];
  const possible = [];
  lines.forEach((t) => {
    const why = reliableWhy(t, pay, invoice, invoices);
    if (why) reliable.push({ line: t, why });
    else if (pay.date && RM.daysApart(t.date, pay.date) != null && RM.daysApart(t.date, pay.date) <= NEAR_DAYS) possible.push({ line: t, why: 'same amount, near the payment date' });
  });
  let sure = null;
  let why = null;
  if (reliable.length === 1) {
    // the line must not fit another waiting receipt just as well (the same reference typed twice, two equal receipts)
    const others = await prisma.invoicePayment.findMany({ where: { bankTxnId: null, id: { not: pay.id } }, include: { invoice: { select: { id: true, invoiceNumber: true } } } });
    const rivals = others.filter((o) => RM.toPaise(o.amount) === RM.toPaise(pay.amount) && o.invoice && reliableWhy(reliable[0].line, o, o.invoice, invoices));
    if (rivals.length) why = `the bank line also fits ${rivals.length} other recorded receipt(s)`;
    else { sure = reliable[0].line; why = reliable[0].why; }
  } else if (reliable.length > 1) why = `${reliable.length} bank lines fit this payment`;
  return {
    sure, why, reliable: reliable.map((r) => brief(r.line, r.why)), possible: possible.map((r) => brief(r.line, r.why)),
  };
}

const brief = (t, why) => ({
  txnId: t.id, date: t.date, amount: t.amount, reference: t.reference || null, narration: String(t.description || '').slice(0, 160), why,
});

// An Auto-Reconcile suggestion still waiting on a line that is now linked is out of date: it leaves the review queue
// (approving it was already refused as Stale; this only stops it being listed). No-op where Auto-Reconcile is not installed.
async function staleSuggestions(txnId) {
  await prisma.$executeRawUnsafe('UPDATE "ReconProposal" SET "status"=\'Stale\',"updatedAt"=? WHERE "txnId"=? AND "status"=\'Pending\'', new Date().toISOString(), txnId).catch(() => 0);
}

// After "Record payment": link the receipt to its line when the match is reliable. Never throws (the payment is saved
// whatever happens here); says what it did.
async function autoLink(paymentId, req) {
  try {
    const pay = await prisma.invoicePayment.findUnique({ where: { id: paymentId } });
    if (!pay || pay.bankTxnId || !(Number(pay.amount) > 0)) return { linked: null };
    const s = await searchFor(pay);
    if (!s.sure) {
      return { linked: null, review: s.reliable.length ? 'Multiple Possible Matches - Verification Required' : null, why: s.why, candidates: s.reliable.length ? s.reliable : s.possible };
    }
    const bank = require('../routes/bank'); // eslint-disable-line global-require
    const out = await bank.linkPayment(s.sure, pay.id, req);
    if (out.error) return { linked: null, why: out.error };
    await staleSuggestions(s.sure.id);
    return { linked: s.sure.id, why: s.why };
  } catch (e) {
    console.error('[paymentBankLink]', e.message); // eslint-disable-line no-console
    return { linked: null, why: 'The bank statement could not be searched just now.' };
  }
}

// ---- what the invoice screen says -------------------------------------------------------------------------------
// One receipt: Matched / Under Review / Unmatched, and whether its statement can be shown.
//   txn: its BankTransaction (null = the link points at nothing), stmtOk: the line came from an imported statement on file.
function paymentRecon(p, txn, stmtOk, search) {
  if (p.bankTxnId) {
    if (!txn) return { state: 'unavailable', label: 'Bank Statement Not Available', tone: 'red', why: 'The bank line this payment was linked to is no longer on file.' };
    if (['Reversed', 'Ignored'].includes(txn.reconStatus)) return { state: 'unmatched', label: `Bank line ${txn.reconStatus.toLowerCase()}`, tone: 'red', why: `The linked bank line is ${txn.reconStatus.toLowerCase()}.` };
    if (!stmtOk) return { state: 'matched', label: 'Matched - Bank Statement Not Available', tone: 'amber', statement: false, why: 'Matched to a bank line that was added by hand or whose statement record is gone.' };
    return { state: 'matched', label: 'Matched', tone: 'green', statement: true };
  }
  if (search && (search.reliable.length > 1 || (search.reliable.length === 1 && !search.sure) || search.possible.length > 1)) {
    return { state: 'review', label: 'Multiple Possible Matches - Verification Required', tone: 'amber', why: search.why || `${search.possible.length} bank lines of the same amount are near this date`, candidates: search.reliable.length ? search.reliable : search.possible };
  }
  if (search && (search.sure || search.possible.length === 1)) {
    return { state: 'review', label: 'Possible Match - Verification Required', tone: 'amber', why: search.sure ? `${search.why} - not linked yet` : 'One bank line of the same amount is near this date, but nothing on it names this payment', candidates: search.sure ? search.reliable : search.possible };
  }
  return { state: 'unmatched', label: 'Bank Statement Not Matched', tone: 'red', why: 'No imported bank line fits this payment yet.' };
}

// The invoice: Payment Status (Unpaid / Partially Paid / Paid) and Bank Reconciliation Status, kept apart.
function invoiceRecon({ status, received, pending, rows }) {
  const TOL = 0.5;
  const pay = String(status) === 'Cancelled' ? 'Cancelled' : (received <= TOL ? 'Unpaid' : (pending <= TOL ? 'Paid' : 'Partially Paid'));
  const live = rows.filter((r) => r.amount > 0);
  const matched = live.filter((r) => r.recon.state === 'matched').reduce((s, r) => s + r.amount, 0);
  let recon;
  if (pay === 'Unpaid' || pay === 'Cancelled') recon = '—';
  else if (live.some((r) => r.recon.state === 'review')) recon = 'Under Review';
  else if (matched >= received - TOL && live.length) recon = 'Matched';
  else if (matched > TOL) recon = 'Partially Matched';
  else recon = 'Unmatched';
  let label = `${pay}${recon !== '—' ? ` · ${recon}` : ''}`;
  if (pay === 'Paid' && recon === 'Unmatched') label = 'Paid - Bank Statement Not Matched';
  if (recon === 'Under Review') label = `${pay} - Multiple Possible Matches - Verification Required`;
  return { paymentStatus: pay, reconStatus: recon, label };
}

module.exports = {
  searchFor, autoLink, staleSuggestions, waitingLinesOf, reliableWhy, paymentRecon, invoiceRecon, NEAR_DAYS,
};
