// CLIENT INVOICE = the invoices of ONE client that share a base number and an
// invoice date (2026-10-14, founder spec "one client = one row").
//
// Nothing is merged in the database. Every candidate keeps its own Invoice row
// (TY26-072, TY26-072-1, TY26-072-2 ...) with its own payments; a client
// invoice is only the GROUP of those rows, worked out when they are read:
//
//   group key  = clientId | base number | invoice date
//   base number = the number without its "-n" candidate suffix (TY26-072-2 -> TY26-072)
//   shown as    = the base number. When the same client + base number also
//                 has a LATER date (an Excel split that reused the base), that
//                 later group shows its own lowest candidate number instead,
//                 so two list rows never carry the same number. A lone
//                 candidate invoice that only has a suffixed number (1830-1,
//                 nothing else) shows its own number.
//
// frontend/src/pages/invoices/clientInvoice.js does the same grouping for the
// screen (scripts/client-invoice-group-test.js proves both agree). This file is
// also the home of the two rules the server needs: the number a NEW invoice
// takes (so a new candidate joins the existing client invoice) and how one
// payment is split across a client invoice's candidate rows.

const SUFFIX_RE = /^(.*\d)-(\d{1,2})$/;

function baseNumber(no) {
  const s = String(no || '').trim();
  const m = SUFFIX_RE.exec(s);
  return m ? m[1] : s;
}
function suffixOf(no) {
  const m = SUFFIX_RE.exec(String(no || '').trim());
  return m ? Number(m[2]) : 0;
}
const dayOf = (v) => String(v || '').slice(0, 10);

// Group invoices (any objects with id, clientId, invoiceNumber, invoiceDate).
// An invoice with no number is never grouped (it is its own client invoice).
// Returns [{ key, clientId, base, date, no, members: [...] }] with members
// sorted oldest suffix first.
function groupInvoices(list, universe) {
  const map = new Map();
  // The displayed number is worked out over `universe` (the whole register) so a filtered list never renumbers a row.
  const all = universe || list;
  const allGroups = universe ? groupInvoices(universe) : null;
  list.forEach((r) => {
    const base = r.invoiceNumber ? baseNumber(r.invoiceNumber) : `#${r.id}`;
    const key = `${r.clientId}|${base}|${dayOf(r.invoiceDate)}`;
    if (!map.has(key)) map.set(key, { key, clientId: r.clientId, base, date: dayOf(r.invoiceDate), members: [] });
    map.get(key).members.push(r);
  });
  const groups = [...map.values()];
  if (allGroups) {
    const noOf = new Map(allGroups.map((g) => [g.key, g]));
    groups.forEach((g) => { const u = noOf.get(g.key); g.no = u ? u.no : null; g.splitDates = u ? u.splitDates : false; });
  }
  groups.forEach((g) => g.members.sort((a, b) => suffixOf(a.invoiceNumber) - suffixOf(b.invoiceNumber)
    || String(a.invoiceNumber || '').localeCompare(String(b.invoiceNumber || ''), undefined, { numeric: true })));
  if (allGroups) return groups;
  // Several dates under one client + base: the earliest keeps the base number.
  const byBase = new Map();
  groups.forEach((g) => { const k = `${g.clientId}|${g.base}`; byBase.set(k, [...(byBase.get(k) || []), g]); });
  groups.forEach((g) => {
    const sibs = byBase.get(`${g.clientId}|${g.base}`);
    const first = sibs.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
    const own = g.members[0].invoiceNumber;
    // The base number when it is the client invoice's number: several candidates, or one that carries it.
    const isBase = g === first && (g.members.length > 1 || g.members.some((m) => m.invoiceNumber === g.base));
    g.no = !own ? null : (isBase ? g.base : own);
    g.splitDates = sibs.length > 1;
  });
  return groups;
}

// The number a NEW invoice for (client, invoiceDate) takes. When that client
// already has invoices dated the same day, the new one is the next candidate
// line of the same client invoice (TY26-072 -> TY26-072-3); otherwise null and
// the caller takes the next number in the series as always.
function nextLineNumber(existing, invoiceDate) {
  const day = dayOf(invoiceDate);
  const same = existing.filter((i) => i.invoiceNumber && dayOf(i.invoiceDate) === day);
  if (!same.length) return null;
  const groups = groupInvoices(same.map((i) => ({ ...i, id: i.id || i.invoiceNumber, clientId: 'c' })));
  // The most recently numbered group of that day.
  const g = groups.sort((a, b) => Math.max(...b.members.map((m) => suffixOf(m.invoiceNumber))) - Math.max(...a.members.map((m) => suffixOf(m.invoiceNumber))))[0];
  const taken = new Set(existing.map((i) => i.invoiceNumber));
  let n = Math.max(...g.members.map((m) => suffixOf(m.invoiceNumber))) + 1;
  while (taken.has(`${g.base}-${n}`)) n += 1;
  return `${g.base}-${n}`;
}

// ONE PAYMENT ACROSS A CLIENT INVOICE'S CANDIDATE ROWS.
// Rule (documented, deterministic): the money is split in proportion to what
// each candidate row still owes, worked in whole paise (floor), so no row can
// be over-paid and every row finishes at the same moment; the few paise left
// by the rounding go to the LAST row that can still take them. The parts always
// add up to the amount to the paisa. Rows are in candidate order (oldest suffix first).
//   lines: [{ id, outstanding }]   amount: rupees
// Returns { parts: [{ id, amount }], total } (amount in rupees), or { error }.
const SETTLED_TOLERANCE_PAISE = 50; // the same 0.50 rupee the single-invoice rule allows

function allocatePayment(lines, amount) {
  const paise = (x) => Math.round(Number(x) * 100);
  const caps = lines.map((l) => Math.max(0, paise(l.outstanding)));
  const owed = caps.reduce((s, c) => s + c, 0);
  let want = paise(amount);
  if (!(want > 0)) return { error: 'A positive amount is required' };
  if (want > owed + SETTLED_TOLERANCE_PAISE) return { error: `That is more than the ₹${(owed / 100).toLocaleString('en-IN')} still outstanding on this invoice` };
  want = Math.min(want, owed);
  const alloc = caps.map((c) => (owed ? Number((BigInt(want) * BigInt(c)) / BigInt(owed)) : 0));
  let rest = want - alloc.reduce((s, a) => s + a, 0);
  for (let i = alloc.length - 1; i >= 0 && rest > 0; i -= 1) {
    const take = Math.min(caps[i] - alloc[i], rest);
    alloc[i] += take;
    rest -= take;
  }
  return {
    parts: lines.map((l, i) => ({ id: l.id, amount: alloc[i] / 100 })).filter((p) => p.amount > 0),
    total: want / 100,
  };
}

// The figures and status of a group of REGISTER rows (routes/invoices.js row()):
// every money figure is the plain sum of its candidate rows, so no total can
// ever disagree with the rows under it. Cancelled rows add nothing.
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function groupSummary(members) {
  const live = members.filter((m) => m.status !== 'Cancelled');
  const sum = (k) => r2(live.reduce((s, m) => s + (Number(m[k]) || 0), 0));
  let status;
  if (!live.length) status = 'Cancelled';
  else if (live.every((m) => m.status === 'Paid')) status = 'Paid';
  else if (live.some((m) => (Number(m.received) || 0) > 0)) status = 'Partially Paid';
  else if (live.some((m) => m.status === 'Overdue')) status = 'Overdue';
  else status = 'Pending';
  return {
    candidates: members.length,
    billing: sum('billing'),
    gst: sum('gst'),
    invoiceValue: sum('invoiceValue'),
    tds: sum('tds'),
    receivable: sum('receivable'),
    received: sum('received'),
    pending: sum('pending'),
    status,
  };
}

module.exports = {
  baseNumber, suffixOf, groupInvoices, nextLineNumber, allocatePayment, groupSummary,
};
