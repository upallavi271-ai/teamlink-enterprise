// ---------------------------------------------------------------------------
// MONEY FACTS — ONE rule for "how much was received, and when", shared by the
// dashboard's Money panel (utils/atsHome.js) and Reports → Client revenue
// (utils/reportsPlus.js), so "Received" means the same everywhere (user,
// 2026-10-03: never "Received ₹0" while invoices are Paid).
//
// THE RULE
//   1. An invoice's recorded payments (InvoicePayment rows) are what was
//      received, each on its own payment date.
//   2. An invoice with NO payment rows whose status is Paid or Partially Paid
//      (old imports kept the money on the invoice itself) counts its
//      receivedAmount, once, on:
//        paidDate (set when it was marked paid — present on almost all of
//        them) → else the day the invoice row was created (IST) → else its
//        invoice date. (Invoice has no updatedAt, and imports wrote no audit
//        trail for the status change, so neither can be used.)
//   3. Cancelled invoices receive nothing.
//
// THE CALLER SELECTS, on the invoice:
//   { id, status, receivedAmount, paidDate, createdAt, invoiceDate,
//     payments: { select: { id, date, amount } } }
//
// API
//   receiptsOf(inv)          -> [{ id, invoiceId, date: 'YYYY-MM-DD', amount, from: 'payment' | 'invoice' }]
//   receivedFor(inv, range?) -> rupees received (range { from, to } 'YYYY-MM-DD', inclusive; none = all time)
//   receivedOn(inv)          -> the date of the latest receipt, or null
//   isWithoutPaymentRows(inv)-> true when rule 2 applied (for the "Includes N invoices…" note)
//   INVOICE_SELECT           -> the select above, to spread into a findMany
// ---------------------------------------------------------------------------
const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PAID_STATUSES = ['paid', 'partially paid'];
const IST = 330 * 60000;
const day = (v) => {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t + IST).toISOString().slice(0, 10);
};

const INVOICE_SELECT = {
  id: true, status: true, receivedAmount: true, paidDate: true, createdAt: true, invoiceDate: true,
  payments: { select: { id: true, date: true, amount: true } },
};

function isWithoutPaymentRows(inv) {
  if (!inv || String(inv.status || '').toLowerCase() === 'cancelled') return false;
  return !(inv.payments || []).length
    && PAID_STATUSES.includes(String(inv.status || '').toLowerCase())
    && Number(inv.receivedAmount || 0) > 0;
}

function receiptsOf(inv) {
  if (!inv || String(inv.status || '').toLowerCase() === 'cancelled') return [];
  const pays = inv.payments || [];
  if (pays.length) {
    return pays.map((p) => ({ id: p.id, invoiceId: inv.id, date: day(p.date), amount: ROUND(p.amount), from: 'payment' }));
  }
  if (!isWithoutPaymentRows(inv)) return [];
  return [{
    id: `inv:${inv.id}`, invoiceId: inv.id, date: day(inv.paidDate) || day(inv.createdAt) || day(inv.invoiceDate), amount: ROUND(inv.receivedAmount), from: 'invoice',
  }];
}

const inRange = (d, r) => !r || (!!d && d >= r.from && d <= r.to);

function receivedFor(inv, range) {
  return ROUND(receiptsOf(inv).filter((x) => inRange(x.date, range)).reduce((n, x) => n + x.amount, 0));
}

function receivedOn(inv) {
  const dates = receiptsOf(inv).map((x) => x.date).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

module.exports = {
  INVOICE_SELECT, receiptsOf, receivedFor, receivedOn, isWithoutPaymentRows,
};
