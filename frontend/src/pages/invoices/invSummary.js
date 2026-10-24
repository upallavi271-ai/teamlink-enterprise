// ---------------------------------------------------------------------------
// THE INVOICE PAGE'S HEADLINE FIGURES AND AGE CHIPS (Accounts, 2026-10-17) - pure, so a test can prove them.
//
// Everything here is read off the SAME client-invoice rows the list shows (clientInvoice.js
// buildClientInvoices: one row per client invoice, its candidate lines added up), so a card, a chip and the
// list can never disagree:
//
//   Total candidates  distinct PEOPLE (candidate id) on a live invoice in view - a person invoiced twice counts once
//   Total clients     distinct CLIENT IDS with a live invoice in view (two clients with one name count twice)
//   Total amount      sum of the invoices' value after GST (after any credit / debit note); cancelled invoices are not in
//   Amount received   sum of the money received on those invoices (the receipts; a refund is negative)
//   Pending amount    sum of Pending as the list prints it = receivable (after TDS, credit / debit notes, adjustments) - received;
//                     an invoice received for MORE than billed is set off (it is shown below zero), as on the Accounts dashboard
//   Overdue invoices  CLIENT INVOICES that still owe money and whose due date is before today (IST); one client invoice
//                     with several candidate lines is ONE invoice, late by its worst line that still owes
//
// Age chips: every client invoice that still owes money sits in exactly ONE bucket - the age of its worst line that
// still owes (the due date its row shows). The five open buckets add up to the "All" chip; "Settled" holds the rest.
// Clicking a chip keeps those client invoices WHOLE (never half a client invoice).
// ---------------------------------------------------------------------------
import { keyOf } from './clientInvoice';

export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sumOf = (list, f) => r2(list.reduce((s, x) => s + (Number(f(x)) || 0), 0));

// The open age buckets, oldest last. 'Settled' = nothing left to collect.
export const OPEN_BUCKETS = ['Not due yet', '0–30 days', '31–60 days', '61–90 days', '90+ days'];
export const LATE_BUCKETS = OPEN_BUCKETS.slice(1);

// Does a client invoice of age `age` belong under the chip `want`? ('60+' = the desk's link: 61-90 and 90+ together.)
export const ageMatches = (age, want) => !want || want === 'All'
  || (want === '60+' ? age === '61–90 days' || age === '90+ days' : age === want);

// The register rows of the client invoices that sit under the chip `want`. `groups` = buildClientInvoices(base rows).
export function rowsForAge(base, groups, want) {
  if (!want || want === 'All') return base;
  const ageByKey = new Map(groups.map((g) => [g.key, g.age]));
  return base.filter((r) => ageMatches(ageByKey.get(keyOf(r)), want));
}

// The six cards over the rows in view (`rows` = filtered register rows, `groups` = their client invoices).
export function cardsOf(rows, groups) {
  const live = rows.filter((r) => r.status !== 'Cancelled');
  const liveGroups = groups.filter((g) => g.status !== 'Cancelled');
  const overdue = liveGroups.filter((g) => g.overdue && g.open);
  const overpaid = live.filter((r) => r.pending < -0.5);
  return {
    candidates: new Set(live.map((r) => r.candidateId).filter(Boolean)).size,
    clients: new Set(live.map((r) => r.clientId || `name:${r.client}`)).size,
    invoices: liveGroups.length, // client invoices (the list's rows)
    lines: live.length, // candidate lines behind them
    total: sumOf(live, (r) => r.invoiceValue),
    billing: sumOf(live, (r) => r.billing),
    gst: sumOf(live, (r) => r.gst),
    tds: sumOf(live, (r) => r.tds),
    receivable: sumOf(live, (r) => r.receivable),
    received: sumOf(live, (r) => r.received),
    pending: sumOf(live, (r) => r.pending),
    overpaid: sumOf(overpaid, (r) => r.pending), // negative: received in excess, already set off inside pending
    overpaidCount: overpaid.length,
    overdue,
    overdueCount: overdue.length,
    overdueAmount: sumOf(overdue, (g) => g.pending),
  };
}

// The age chips over everything the other filters leave. `groups` = client invoices of the base rows.
export function chipsOf(groups) {
  const live = groups.filter((g) => g.status !== 'Cancelled');
  const openG = live.filter((g) => g.open);
  const settled = live.filter((g) => !g.open);
  const chips = [
    { k: 'All', count: live.length, amt: sumOf(openG, (g) => g.pending), note: 'pending' },
    ...OPEN_BUCKETS.map((k) => {
      const list = openG.filter((g) => g.age === k);
      return { k, count: list.length, amt: sumOf(list, (g) => g.pending), list };
    }),
    // Nothing left to collect - its amount is what came in, not what is owed.
    { k: 'Settled', count: settled.length, amt: sumOf(settled, (g) => g.received), note: 'received', list: settled },
  ];
  return chips;
}
