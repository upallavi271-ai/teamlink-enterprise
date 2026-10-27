// CLIENT INVOICE = the register rows of ONE client that share a base number and
// an invoice date (2026-10-14, "one client = one row"). Nothing is merged in the
// database: every candidate keeps its own invoice row (TY26-072, TY26-072-1,
// TY26-072-2 ...) with its own payments, and the screen reads the group.
//
//   group key   = clientId | base number | invoice date
//   base number = the number without its "-n" candidate suffix
//   shown as    = the base number (a later date under the same client + base
//                 shows its own lowest candidate number, so no two rows share one)
//
// Every figure of a group is the plain sum of its candidate rows, so the TOTAL
// row, the cards and the Excel file can never disagree with the list.
// (backend/src/utils/clientInvoice.js is the server's copy of the same rule;
// scripts/client-invoice-group-test.js proves the two group alike.)

const SUFFIX_RE = /^(.*\d)-(\d{1,2})$/;
export const baseNumber = (no) => {
  const s = String(no || '').trim();
  const m = SUFFIX_RE.exec(s);
  return m ? m[1] : s;
};
export const suffixOf = (no) => {
  const m = SUFFIX_RE.exec(String(no || '').trim());
  return m ? Number(m[2]) : 0;
};
const day = (v) => String(v || '').slice(0, 10);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (list, f) => r2(list.reduce((s, r) => s + (Number(f(r)) || 0), 0));

export const keyOf = (r) => `${r.clientId || `name:${r.client}`}|${r.invoiceNumber ? baseNumber(r.invoiceNumber) : `#${r.id}`}|${day(r.invoiceDate)}`;

// Which number a client invoice shows, worked out over the WHOLE register so it
// does not change when a filter hides some of its candidates.
// Returns Map(key -> { no, total, lead, ids }): total = candidate rows in the register, lead = the id the
// row answers to (its lowest candidate number), ids = every candidate invoice id of the client invoice.
export function groupIndex(allRows) {
  const byKey = new Map();
  allRows.forEach((r) => {
    const k = keyOf(r);
    if (!byKey.has(k)) byKey.set(k, { key: k, base: r.invoiceNumber ? baseNumber(r.invoiceNumber) : null, clientKey: r.clientId || `name:${r.client}`, date: day(r.invoiceDate), rows: [] });
    byKey.get(k).rows.push(r);
  });
  const bySib = new Map();
  byKey.forEach((g) => { if (g.base) { const k = `${g.clientKey}|${g.base}`; bySib.set(k, [...(bySib.get(k) || []), g]); } });
  const out = new Map();
  byKey.forEach((g) => {
    g.rows.sort((a, b) => suffixOf(a.invoiceNumber) - suffixOf(b.invoiceNumber));
    let no = g.rows[0].invoiceNumber;
    if (g.base) {
      const first = bySib.get(`${g.clientKey}|${g.base}`).slice().sort((a, b) => a.date.localeCompare(b.date))[0];
      // the base number when it is the client invoice's number (several candidates, or one that carries it); else its own lowest number
      no = g === first && (g.rows.length > 1 || g.rows.some((x) => x.invoiceNumber === g.base)) ? g.base : g.rows[0].invoiceNumber;
    }
    out.set(g.key, { no, total: g.rows.length, lead: g.rows[0].id, ids: g.rows.map((x) => x.id) });
  });
  return out;
}

// Candidate earliest-joining first, a missing date last, then candidate number.
const joinSort = (a, b) => {
  const da = day(a.joiningDate) || '9999-99-99';
  const db = day(b.joiningDate) || '9999-99-99';
  return da.localeCompare(db) || suffixOf(a.invoiceNumber) - suffixOf(b.invoiceNumber);
};

// The worst aging bucket among the lines still owing money.
const AGE_ORDER = ['Settled', 'Not due yet', '0–30 days', '31–60 days', '61–90 days', '90+ days'];

export function groupStatus(members) {
  const live = members.filter((m) => m.status !== 'Cancelled');
  if (!live.length) return 'Cancelled';
  if (live.every((m) => m.status === 'Paid')) return 'Paid';
  if (live.some((m) => (Number(m.received) || 0) > 0)) return 'Partially Paid';
  if (live.some((m) => m.status === 'Overdue')) return 'Overdue';
  return 'Pending';
}

// ONE payment recorded on a client invoice is stored as one receipt per candidate
// row (same key in the note). Show it once: merge by that key, else by the same
// date + mode + reference / bank line; receipts with neither stay as they are.
export function mergedPayments(members) {
  const rows = [];
  members.forEach((m) => (m.paymentHistory || []).forEach((h) => rows.push({ ...h, invoiceId: m.id, invoiceNumber: m.invoiceNumber, candidate: m.candidateName })));
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.recordedAt).localeCompare(String(b.recordedAt)));
  const out = [];
  const seen = new Map();
  rows.forEach((h) => {
    const k = h.group ? `g:${h.group}` : ((h.reference || h.bankTxnId) ? `m:${h.date}|${h.method}|${h.reference || ''}|${h.bankTxnId || ''}|${h.amount < 0 ? 'r' : 'p'}` : null);
    if (k && seen.has(k)) {
      const e = seen.get(k);
      e.amount = r2(e.amount + h.amount);
      e.lines += 1;
      return;
    }
    const e = { ...h, lines: 1 };
    if (k) seen.set(k, e);
    out.push(e);
  });
  return out;
}

// What to print next to the status when a line carries proof but no recorded payment (the server decides; this only gathers it).
function proofNote(live) {
  const st = (m) => (m.payState && m.payState.state) || '';
  const proofOnly = live.filter((m) => st(m) === 'proof_only');
  const unrecorded = live.filter((m) => st(m) === 'unrecorded');
  const ref = (proofOnly.map((m) => m.payState.action && m.payState.action.reference).find(Boolean)) || '';
  const matched = live.filter((m) => st(m) === 'matched');
  const first = proofOnly[0] || matched[0] || unrecorded[0];
  return {
    payNote: first ? first.payState.short : null,
    payNoteWhy: first ? first.payState.reason : null,
    payNoteTone: first ? first.payState.tone : null,
    proofOnlyCount: proofOnly.length,
    proofRef: ref,
  };
}

// Build the client-invoice rows from the (already filtered) register rows.
// `index` = groupIndex(all rows of the register).
export function buildClientInvoices(rows, index) {
  const map = new Map();
  rows.forEach((r) => {
    const k = keyOf(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  });
  const out = [];
  map.forEach((list, key) => {
    const members = list.slice().sort(joinSort);
    const byNo = list.slice().sort((a, b) => suffixOf(a.invoiceNumber) - suffixOf(b.invoiceNumber));
    const lead = byNo[0];
    const info = (index && index.get(key)) || { no: lead.invoiceNumber, total: list.length };
    const live = members.filter((m) => m.status !== 'Cancelled');
    const owing = live.filter((m) => m.pending > 0.5);
    const pendingSum = sum(live, (m) => m.pending);
    // OPEN = the client invoice still owes money once an overpaid line is set off (the same Pending the row shows).
    const open = owing.length > 0 && pendingSum > 0.5;
    // Late = days past the due date of a line that STILL OWES — a line already paid never makes the invoice late.
    const lateDays = open ? Math.max(0, ...owing.map((m) => m.daysOverdue || 0)) : 0;
    const billingTypes = [...new Set(members.map((m) => m.billingType).filter(Boolean))];
    const dues = (owing.length ? owing : live).map((m) => m.dueDate).filter(Boolean).sort();
    const sent = live.length > 0 && live.every((m) => m.sentVia);
    const withTds = live.filter((m) => m.tds > 0.5);
    const g = {
      key,
      id: info.lead || lead.id,
      ids: byNo.map((m) => m.id),
      members,
      no: info.no,
      invoiceNumber: info.no,
      invoiceDate: lead.invoiceDate,
      clientId: lead.clientId,
      client: lead.client,
      candidates: members.length,
      hiddenByFilters: Math.max(0, info.total - list.length),
      candidateNames: members.map((m) => m.candidateName).filter(Boolean),
      billingType: billingTypes.length > 1 ? `Mixed (${billingTypes.length})` : (billingTypes[0] || '—'),
      billingTypes,
      billing: sum(live, (m) => m.billing),
      gst: sum(live, (m) => m.gst),
      invoiceValue: sum(live, (m) => m.invoiceValue),
      tds: sum(live, (m) => m.tds),
      receivable: sum(live, (m) => m.receivable),
      received: sum(live, (m) => m.received),
      pending: pendingSum,
      paymentCount: sum(members, (m) => m.paymentCount),
      // the DIFFERENT bank lines behind the candidate lines: one client payment split over three candidates is ONE bank line, not three
      proofCount: members.some((m) => Array.isArray(m.proofTxnIds)) ? new Set(members.flatMap((m) => m.proofTxnIds || [])).size : sum(members, (m) => m.proofCount),
      status: groupStatus(members),
      // 2026-10-21: proof attached but nothing received - the status says why instead of a bare Pending (server: utils/invoicePaymentState.js).
      ...proofNote(live),
      dueDate: dues[0] || null,
      daysOverdue: lateDays,
      open,
      overdue: lateDays > 0,
      // The worst age bucket among the lines that still owe — the bucket of the due date this row shows.
      age: open ? owing.map((m) => m.age).sort((a, b) => AGE_ORDER.indexOf(b) - AGE_ORDER.indexOf(a))[0] : 'Settled',
      sentAll: sent,
      sentSome: live.some((m) => m.sentVia),
      sentVia: sent ? [...new Set(live.map((m) => m.sentVia))].join(' / ') : null,
      sentDate: sent ? live.map((m) => m.sentDate).filter(Boolean).sort().pop() || null : null,
      tdsLines: withTds.length,
      tdsInHand: withTds.filter((m) => m.tdsCertReceived).length,
      departments: [...new Set(members.map((m) => m.department).filter((d) => d && d !== '—'))],
      recruiters: [...new Set(members.map((m) => m.recruiter).filter(Boolean))],
      gstins: [...new Set(members.map((m) => m.clientGstin).filter(Boolean))],
      payments: mergedPayments(members),
      // "Client paying GST": does this client's invoice carry GST at all?
      gstOn: live.some((m) => (m.gstApplicable !== undefined ? !!m.gstApplicable : Number(m.gst) > 0)),
    };
    out.push(g);
  });
  return out;
}

// Which payment form to use: the group's ids for a client invoice of several
// candidates, the plain invoice for a single one.
export const isMulti = (g) => g.members.length > 1;
