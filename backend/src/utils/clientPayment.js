// CATEGORISE MANUALLY -> "Customer (client) payment" on a money-in bank line (Accounts, 2026-11-16).
// Zoho Books' "Categorize" for a customer payment: pick the client, say how much of the bank amount goes to
// each open invoice, leave the rest unapplied. Pure rules only - no database - so the same checks run in the
// route (routes/bank.js POST /:id/client-payment) and in test-fixtures/clientPayment.test.js.
//
// TDS: the receipt rule is the one Record Payment uses (utils/accounts.js receiptProblem): an invoice's
// outstanding is ALREADY net of the TDS the client deducts (amount + GST - TDS - received), so a client who pays
// net of TDS settles the invoice exactly and its status stays right. The panel shows each invoice's TDS next to it.
const { receiptProblem, invoiceOutstanding, isOpenInvoice } = require('./accounts');

const paise = (n) => Math.round((Number(n) || 0) * 100);
const rupees = (p) => p / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Oldest invoice first (due date, then invoice date, then number) - the order the panel pre-fills.
function oldestFirst(invoices) {
  return invoices.filter(isOpenInvoice).sort(
    (a, b) => String(a.dueDate || a.invoiceDate || '9999').localeCompare(String(b.dueDate || b.invoiceDate || '9999'))
      || String(a.invoiceDate || '9999').localeCompare(String(b.invoiceDate || '9999'))
      || String(a.invoiceNumber || '').localeCompare(String(b.invoiceNumber || '')),
  );
}

// The default the panel fills: the bank amount spread oldest-first, each invoice up to what it still owes.
function defaultAllocation(invoices, amount) {
  let left = paise(amount);
  const out = [];
  oldestFirst(invoices).forEach((inv) => {
    if (left <= 0) return;
    const take = Math.min(left, paise(invoiceOutstanding(inv)));
    if (take > 0) { out.push({ invoiceId: inv.id, amount: rupees(take) }); left -= take; }
  });
  return { allocations: out, unapplied: rupees(left) };
}

// Checks a person's allocation. Returns { error } or { parts, applied, unapplied }.
//   line          { amount }                        the bank line
//   alreadyPosted rupees already receipted FROM THIS LINE (InvoicePayment.bankTxnId) - a line applied once is closed
//   allocations   [{ invoiceId, amount }]
//   invoices      the client's invoice rows (must contain every allocated invoice, with .clientId)
//   clientId      the client the person picked
function planClientPayment({
  line, alreadyPosted = 0, allocations = [], invoices = [], clientId, date, today,
}) {
  if (!clientId) return { error: 'Choose the client who paid.' };
  if (paise(alreadyPosted) > 0) return { error: 'This line is already applied to an invoice - undo that first.' };
  if (date !== undefined) {
    if (!ISO.test(String(date || ''))) return { error: 'Enter the date the money arrived.' };
    if (today && String(date) > today) return { error: 'A payment date cannot be in the future.' };
  }
  const lineP = paise(line.amount);
  if (!(lineP > 0)) return { error: 'This line has no amount.' };
  const seen = new Set();
  let appliedP = 0;
  const parts = [];
  for (const a of allocations) {
    const amtP = paise(a.amount);
    if (amtP === 0) continue; // a blank / zero row is "nothing to this invoice"
    if (amtP < 0) return { error: 'An amount cannot be negative.' };
    if (seen.has(a.invoiceId)) return { error: 'The same invoice is listed twice.' };
    seen.add(a.invoiceId);
    const inv = invoices.find((i) => i.id === a.invoiceId);
    if (!inv) return { error: 'One of the invoices could not be found.' };
    if (inv.clientId !== clientId) return { error: `${inv.invoiceNumber || 'An invoice'} belongs to a different client.` };
    const problem = receiptProblem(inv, rupees(amtP));
    if (problem) return { error: `${inv.invoiceNumber || 'Invoice'}: ${problem}` };
    appliedP += amtP;
    parts.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber || String(inv.id).slice(-6), amount: rupees(amtP) });
  }
  if (appliedP > lineP) {
    return { error: `The invoices add up to ${rupees(appliedP).toFixed(2)} - more than the bank amount ${rupees(lineP).toFixed(2)}.` };
  }
  return { parts, applied: rupees(appliedP), unapplied: rupees(lineP - appliedP) };
}

module.exports = { planClientPayment, defaultAllocation, oldestFirst };
