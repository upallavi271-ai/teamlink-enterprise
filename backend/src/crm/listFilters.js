// ---------------------------------------------------------------------------
// CRM LIST FILTERS (founder 2026-11-20: "every list needs filters ... when a filter is applied the whole history must come").
// SQL terms for the CRM lists in crm/service.js. They only ever NARROW the list's own owner scope (scopeSql) - none widens it.
//
//   cFrom cTo                 the day the record was added (IST days, both ends included) - every list
//   Leads     city (csv, contains)  industry (csv, contains)
//   Accounts  city  industry  source (csv)
//   Contacts  role (csv)
//   Deals     valueMin valueMax (rupees)  stage (csv)  closeFrom closeTo (expected close day)
//   Invoices  q  amtMin amtMax (invoice total)  issueFrom issueTo  dueFrom dueTo  owner
//   Follow-ups q (title or the lead / deal / account name)
//   Campaigns q  status (csv)  channel
//
// WHOLE HISTORY: a search or any filter drops the list's default window (closed deals only for 30 days, open leads only, the 1,000-row
// cut) - any(q) says whether a query is a filtered one; `cap(q)` is then 20,000 rows.
// ---------------------------------------------------------------------------
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const csv = (v) => String(v === undefined || v === null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30);
const num = (v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const istStart = (d) => new Date(`${d}T00:00:00+05:30`).toISOString();
const istEnd = (d) => new Date(`${d}T23:59:59.999+05:30`).toISOString();

// keys that are paging / sorting / scope, never "a filter"
const NOT_FILTERS = ['page', 'pageSize', 'sort', 'dir', 'max', 'status_', 'layout', 'all', 'mine', 'when', 'closedDays', 'format'];
function any(q, extraKeys = []) {
  const o = q || {};
  return Object.keys(o).some((k) => !NOT_FILTERS.includes(k) && o[k] !== '' && o[k] !== undefined && o[k] !== null && k !== 'status' && k !== 'stage') || extraKeys.some((k) => o[k]);
}
const cap = (q) => (any(q) ? 20000 : 1000);

/** `col LIKE any of the words` */
function likeAny(where, params, col, value) {
  const w = csv(value);
  if (!w.length) return;
  where.push(`(${w.map(() => `${col} LIKE ?`).join(' OR ')})`);
  params.push(...w.map((x) => `%${x}%`));
}
function inList(where, params, col, value) {
  const w = csv(value);
  if (!w.length) return;
  where.push(`${col} IN (${w.map(() => '?').join(',')})`);
  params.push(...w);
}
function range(where, params, col, lo, hi) {
  const a = num(lo); const b = num(hi);
  if (a !== null) { where.push(`${col} >= ?`); params.push(a); }
  if (b !== null) { where.push(`${col} <= ?`); params.push(b); }
}
function dayRange(where, params, col, from, to) {
  if (from && YMD.test(String(from))) { where.push(`${col} >= ?`); params.push(istStart(from)); }
  if (to && YMD.test(String(to))) { where.push(`${col} <= ?`); params.push(istEnd(to)); }
}
function ymdRange(where, params, col, from, to) {
  if (from && YMD.test(String(from))) { where.push(`${col} >= ?`); params.push(String(from)); }
  if (to && YMD.test(String(to))) { where.push(`${col} <= ?`); params.push(String(to)); }
}

function lead(q, where, params, a = 'x.') {
  likeAny(where, params, `${a}"city"`, q.city);
  likeAny(where, params, `${a}"industry"`, q.industry);
  dayRange(where, params, `${a}"createdAt"`, q.cFrom, q.cTo);
}
function account(q, where, params, a = 'x.') {
  likeAny(where, params, `${a}"city"`, q.city);
  likeAny(where, params, `${a}"industry"`, q.industry);
  inList(where, params, `${a}"source"`, q.source);
  dayRange(where, params, `${a}"createdAt"`, q.cFrom, q.cTo);
}
function contact(q, where, params, a = 'x.') {
  inList(where, params, `${a}"role"`, q.role);
  dayRange(where, params, `${a}"createdAt"`, q.cFrom, q.cTo);
}
function deal(q, where, params, a = 'x.') {
  range(where, params, `${a}"value"`, q.valueMin, q.valueMax);
  inList(where, params, `${a}"stage"`, q.stage);
  ymdRange(where, params, `${a}"expectedClose"`, q.closeFrom, q.closeTo);
  dayRange(where, params, `${a}"createdAt"`, q.cFrom, q.cTo);
}
function invoice(q, where, params, a = 'x.') {
  if (q.q) {
    const t = `%${String(q.q).trim().slice(0, 80)}%`;
    where.push(`(${a}"code" LIKE ? OR ${a}"title" LIKE ? OR ${a}"accountName" LIKE ?)`);
    params.push(t, t, t);
  }
  range(where, params, `${a}"total"`, q.amtMin, q.amtMax);
  ymdRange(where, params, `${a}"issueDate"`, q.issueFrom, q.issueTo);
  ymdRange(where, params, `${a}"dueDate"`, q.dueFrom, q.dueTo);
}
function campaign(q, where, params) {
  if (q.q) { where.push('"name" LIKE ?'); params.push(`%${String(q.q).trim().slice(0, 80)}%`); }
  inList(where, params, '"status"', q.status);
  inList(where, params, '"channel"', q.channel);
  dayRange(where, params, '"createdAt"', q.cFrom, q.cTo);
}

module.exports = {
  any, cap, lead, account, contact, deal, invoice, campaign, csv, num, YMD,
};
