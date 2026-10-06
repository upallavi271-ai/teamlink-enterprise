// ---------------------------------------------------------------------------
// THE INVOICE PAGE'S FILTERS (Accounts spec S7) — every filter, how a row is
// matched, and the cascading option counts, in one place so the tiles, the
// stat cards, the aging chips, the TDS pill, the table + TOTAL and the three
// downloads all read the SAME filtered set.
//
// The register (GET /invoices/register?period=all) is loaded whole, so every
// filter is applied in the browser, instantly, with AND logic. Nothing here
// works out a figure — it only decides which invoice rows are in.
// ---------------------------------------------------------------------------
import { ALL, matchesHierarchy } from './invHierarchy';

export const NONE = '__none'; // the Recruiter filter's "Unassigned"

export const APPLY_TO = [
  { value: 'invoice', label: 'Invoice date' },
  { value: 'joining', label: 'Joining month' },
  { value: 'due', label: 'Due date' },
  { value: 'payment', label: 'Payment date' },
];
export const PERIOD_PRESETS = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'cfy', 'pfy', 'custom', 'all'];
export const ALL_PERIOD = { from: null, to: null, preset: 'all', applyTo: 'invoice' };
export const periodOn = (p) => !!(p && p.from && p.to);

// Status — the spec's six words over the register's own statuses.
//   Settled = paid in full AND nothing left to chase (no TDS, or the Form 16A
//   is in hand); Paid = paid in full, certificate or not.
export const STATUS_OPTS = [
  { value: 'All', label: 'All' },
  { value: 'Paid', label: 'Paid' },
  { value: 'Partially Paid', label: 'Part-paid' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Overdue', label: 'Overdue' },
  { value: 'Settled', label: 'Settled' },
];
export const statusLabel = (v) => (STATUS_OPTS.find((o) => o.value === v) || {}).label || v;
export function statusMatch(r, want) {
  if (!want || want === 'All') return true;
  if (want === 'Settled') return r.status === 'Paid' && (!(r.tds > 0.5) || r.tdsCert === 'in hand');
  // "Received" (the old tracker's word, still in old links) = Paid.
  return r.status === (want === 'Received' ? 'Paid' : want);
}

export const GST_OPTS = [
  { value: 'All', label: 'All' },
  { value: 'Yes', label: 'Yes — GST on this invoice' },
  { value: 'No', label: 'No — no GST on this invoice' },
];
export const GST_HISTORY = [
  { value: 'Never', label: 'Never charged GST', kind: 'never' },
  { value: 'Always', label: 'Always charged GST', kind: 'always' },
  { value: 'Mixed', label: 'Both ways — worth a look', kind: 'mixed' },
];

// P4 — GST & TDS filters: GST type, GST rate, TDS applicable, TDS rate,
// TDS status, and the due date. Each one cascades and counts like the rest.
export const DUE_OPTS = [
  { value: 'late', label: 'Late — still owed' },
  { value: 'week', label: 'Due in the next 7 days' },
  { value: 'month', label: 'Due in the next 30 days' },
  { value: 'later', label: 'Due later' },
  { value: 'none', label: 'No due date' },
];
export const TDS_STATUS_OPTS = ['Not Applicable', 'Pending', 'Deducted', 'Certificate Received'];
export const GST_TYPE_OPTS = [
  { value: 'CGST_SGST', label: 'CGST + SGST' },
  { value: 'IGST', label: 'IGST' },
  { value: 'NONE', label: 'No GST' },
];
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
export function dueMatch(r, want) {
  if (!want || want === ALL) return true;
  const due = r.dueDate ? String(r.dueDate).slice(0, 10) : '';
  if (want === 'none') return !due;
  if (!due) return false;
  const today = plusDays(0);
  if (want === 'late') return due < today && Number(r.pending) > 0.5 && r.status !== 'Cancelled';
  if (want === 'week') return due >= today && due <= plusDays(7);
  if (want === 'month') return due >= today && due <= plusDays(30);
  if (want === 'later') return due > plusDays(30);
  return true;
}
// "18" -> the rate as the option value; 0 = no GST / no TDS.
export const rateKey = (p) => String(Math.round((Number(p) || 0) * 100) / 100);
export const rateLabel = (k, none) => (Number(k) > 0 ? `${k}%` : none);

export const BLANK_FILTERS = {
  clients: [], dept: ALL, section: ALL, role: ALL, recs: [], rec: ALL, gstin: ALL, status: ALL, q: '',
  gstType: ALL, gstRate: ALL, tds: ALL, tdsRate: ALL, tdsStatus: ALL, due: ALL,
};

// A saved view / old link may still hold the older shapes (client: 'Name',
// period: 'M:2026-09'); bring them to today's.
export function normFilters(f) {
  const x = { ...BLANK_FILTERS, ...(f || {}) };
  if (!Array.isArray(x.clients)) x.clients = [];
  if (f && typeof f.client === 'string' && f.client && f.client !== ALL && !x.clients.length) x.clients = [f.client];
  delete x.client;
  if (!Array.isArray(x.recs)) x.recs = [];
  if (x.status === 'Received') x.status = 'Paid';
  if (!STATUS_OPTS.some((o) => o.value === x.status)) x.status = ALL;
  x.q = typeof x.q === 'string' ? x.q : '';
  ['gstType', 'gstRate', 'tds', 'tdsRate', 'tdsStatus', 'due'].forEach((k) => { if (typeof x[k] !== 'string' || !x[k]) x[k] = ALL; });
  return x;
}

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(y, m, 0).getDate(); // m = 1..12
const SLICE = { FY: [0, 12], H1: [0, 6], H2: [6, 12], Q1: [0, 3], Q2: [3, 6], Q3: [6, 9], Q4: [9, 12] };
// The Accounts desk's links (?period=M:2026-09 | Q2:2026 | FY:2026 | all) as
// a calendar range on the invoice date — the same dates the server used.
export function periodFromLegacy(sel) {
  const s = String(sel || '');
  if (!s || s === 'all') return { ...ALL_PERIOD };
  if (s.startsWith('M:')) {
    const [y, m] = s.slice(2).split('-').map(Number);
    if (!y || !m) return { ...ALL_PERIOD };
    return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}`, preset: 'custom', applyTo: 'invoice' };
  }
  const [kind, yRaw] = s.split(':');
  const fy = Number(yRaw);
  if (!SLICE[kind] || !fy) return { ...ALL_PERIOD };
  const months = [];
  for (let i = 0; i < 12; i += 1) { const m = 4 + i; months.push([m > 12 ? fy + 1 : fy, m > 12 ? m - 12 : m]); }
  const [a, b] = SLICE[kind];
  const [fy1, fm1] = months[a];
  const [ty, tm] = months[b - 1];
  return {
    from: `${fy1}-${pad(fm1)}-01`, to: `${ty}-${pad(tm)}-${pad(lastDay(ty, tm))}`, preset: 'custom', applyTo: 'invoice',
  };
}
export function normPeriod(p) {
  if (typeof p === 'string') return periodFromLegacy(p);
  if (!p || typeof p !== 'object') return { ...ALL_PERIOD };
  return { ...ALL_PERIOD, ...p, applyTo: APPLY_TO.some((o) => o.value === p.applyTo) ? p.applyTo : 'invoice' };
}

const d10 = (s) => (s ? String(s).slice(0, 10) : '');
const inside = (s, p) => { const d = d10(s); return !!d && d >= p.from && d <= p.to; };
export function periodMatch(r, p) {
  if (!periodOn(p)) return true;
  switch (p.applyTo) {
    case 'joining': return inside(r.joiningDate, p);
    case 'due': return inside(r.dueDate, p);
    case 'payment':
      // A receipt row's date, or the date an older import says it was paid.
      return (r.payments || []).some((x) => inside(x.date, p)) || inside(r.paidDate, p);
    default: return inside(r.invoiceDate, p);
  }
}

// "Search anything": candidate, client, phone, invoice no, position, recruiter code…
export function searchMatch(r, q) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return true;
  const phone = String(r.candidatePhone || '');
  const hay = [r.invoiceNumber, r.client, r.candidateName, phone, phone.replace(/\D/g, ''), r.role, r.recruiter, r.seat, r.tl,
    r.department, r.section, r.clientGstin, r.billingType, r.status].join(' ').toLowerCase();
  return t.split(/\s+/).every((w) => hay.includes(w));
}

export const recKeyOf = (r) => r.recruiterKey || NONE;
export const recLabelOf = (r) => (r.recruiterKey ? [r.seat, r.recruiter].filter(Boolean).join(' · ') : 'Unassigned');

// One row through every filter — `skip` leaves one out (for that filter's own
// option counts: each list is counted over what the OTHER filters leave).
export function passes(r, F, period, stance, skip) {
  if (skip !== 'period' && !periodMatch(r, period)) return false;
  if (skip !== 'clients' && F.clients.length && !F.clients.includes(r.client)) return false;
  if (skip !== 'dept' && F.dept !== ALL && r.department !== F.dept) return false;
  if (skip !== 'section' && F.section !== ALL && r.sectionKey !== F.section) return false;
  if (skip !== 'rec' && F.rec !== ALL && !matchesHierarchy(r, { dept: ALL, section: ALL, rec: F.rec })) return false;
  if (skip !== 'role' && F.role !== ALL && r.role !== F.role) return false;
  // An invoice matches if ANY of its candidates has a picked recruiter (every
  // invoice in this register bills one candidate).
  if (skip !== 'recs' && F.recs.length && !F.recs.includes(recKeyOf(r))) return false;
  if (skip !== 'status' && !statusMatch(r, F.status)) return false;
  if (skip !== 'gstin' && F.gstin !== ALL) {
    if (F.gstin === 'Yes' && !r.clientPayingGst) return false;
    if (F.gstin === 'No' && r.clientPayingGst) return false;
    const h = GST_HISTORY.find((x) => x.value === F.gstin);
    if (h && (stance || {})[r.client] !== h.kind) return false;
  }
  if (skip !== 'gstType' && F.gstType !== ALL && r.gstType !== F.gstType) return false;
  if (skip !== 'gstRate' && F.gstRate !== ALL && rateKey(r.gstPercent) !== F.gstRate) return false;
  if (skip !== 'tds' && F.tds !== ALL && (F.tds === 'Yes') !== !!r.tdsApplicable) return false;
  if (skip !== 'tdsRate' && F.tdsRate !== ALL && rateKey(r.tdsPercent) !== F.tdsRate) return false;
  if (skip !== 'tdsStatus' && F.tdsStatus !== ALL && r.tdsStatus !== F.tdsStatus) return false;
  if (skip !== 'due' && !dueMatch(r, F.due)) return false;
  if (skip !== 'q' && !searchMatch(r, F.q)) return false;
  return true;
}

// Option counts for every list, cascading: { clients: Map, dept: Map, … }.
export function facetCounts(rows, F, period, stance) {
  const out = {
    clients: new Map(), dept: new Map(), section: new Map(), role: new Map(), recs: new Map(), rec: new Map(), gstin: new Map(), status: new Map(), recLabel: new Map(),
    gstType: new Map(), gstRate: new Map(), tds: new Map(), tdsRate: new Map(), tdsStatus: new Map(), due: new Map(),
  };
  const bump = (m, k) => { if (k !== null && k !== undefined && k !== '') m.set(k, (m.get(k) || 0) + 1); };
  rows.forEach((r) => {
    if (passes(r, F, period, stance, 'clients')) bump(out.clients, r.client);
    if (passes(r, F, period, stance, 'dept')) bump(out.dept, r.department);
    if (passes(r, F, period, stance, 'section')) bump(out.section, r.sectionKey);
    if (passes(r, F, period, stance, 'role')) bump(out.role, r.role);
    if (passes(r, F, period, stance, 'recs')) { bump(out.recs, recKeyOf(r)); if (!out.recLabel.has(recKeyOf(r))) out.recLabel.set(recKeyOf(r), recLabelOf(r)); }
    if (passes(r, F, period, stance, 'rec')) {
      bump(out.rec, r.recruiterKey);
      if (r.tlKey && r.tlKey !== r.recruiterKey) bump(out.rec, r.tlKey);
    }
    if (passes(r, F, period, stance, 'gstin')) {
      bump(out.gstin, r.clientPayingGst ? 'Yes' : 'No');
      const k = (stance || {})[r.client];
      const h = GST_HISTORY.find((x) => x.kind === k);
      if (h) bump(out.gstin, h.value);
    }
    if (passes(r, F, period, stance, 'status')) {
      STATUS_OPTS.slice(1).forEach((o) => { if (statusMatch(r, o.value)) bump(out.status, o.value); });
    }
    if (passes(r, F, period, stance, 'gstType')) bump(out.gstType, r.gstType);
    if (passes(r, F, period, stance, 'gstRate')) bump(out.gstRate, rateKey(r.gstPercent));
    if (passes(r, F, period, stance, 'tds')) bump(out.tds, r.tdsApplicable ? 'Yes' : 'No');
    if (passes(r, F, period, stance, 'tdsRate')) bump(out.tdsRate, rateKey(r.tdsPercent));
    if (passes(r, F, period, stance, 'tdsStatus')) bump(out.tdsStatus, r.tdsStatus);
    if (passes(r, F, period, stance, 'due')) DUE_OPTS.forEach((o) => { if (dueMatch(r, o.value)) bump(out.due, o.value); });
  });
  return out;
}
