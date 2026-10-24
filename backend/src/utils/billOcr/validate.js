// ---------------------------------------------------------------------------
// BILL READING - PURE VALIDATION AND CLEAN-UP (2026-10-21). No database, no network: every function here is a plain function of its
// arguments, so it is unit-tested directly (scripts/vendor-bill-upload-test.js).
//
//   toAsciiDigits / parseMoney / parseDate   strict readers for what a handwritten bill says ("Rs. 1,23,456/-", "05/10/26", Telugu digits)
//   cleanText                                the only way a string from the AI (or a person) is stored: no tags, no control characters, capped
//   normaliseModelOutput                     the model's JSON -> our own shape. Unknown keys are dropped, numbers parsed strictly, text capped.
//   derive                                   fills a missing subtotal / GST / total ONLY when the other two are known (and says so)
//   checkTotals / checkDates / checkNames    the arithmetic and plausibility checks. They return FLAGS: { code, field, level, message }
//   normInvoiceNo / normNameTokens / matchRef   the keys the duplicate and matching checks compare
//
// A flag has a level: 'block' = approval is impossible until it is fixed or cleared (a missing invoice number, a duplicate, no repair record),
// 'check' = a person must look at it and acknowledge it or correct the value (unclear handwriting, totals that do not add up, ...).
// NOTHING here guesses a value: an unreadable field stays null.
// ---------------------------------------------------------------------------

const ROUND2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Telugu (U+0C66..), Devanagari (U+0966..), Bengali and Arabic-Indic digits -> 0-9
function toAsciiDigits(s) {
  return String(s == null ? '' : s).replace(/[౦-౯०-९০-৯٠-٩۰-۹]/g, (ch) => {
    const c = ch.codePointAt(0);
    const base = [0x0C66, 0x0966, 0x09E6, 0x0660, 0x06F0].find((b) => c >= b && c <= b + 9);
    return String(c - base);
  });
}

// Plain text only: tags, angle brackets and control characters out, spaces tidied, capped.
function cleanText(v, max = 300) {
  const t = String(v == null ? '' : v)
    .replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ').trim();
  return max ? t.slice(0, max) : t;
}

// "₹ 1,23,456/-", "Rs.1500.50", "1500", 1500.5, "१५००" -> number; anything else (words, "1,5,00", negative, text) -> null. Never guesses.
function parseMoney(x) {
  if (x == null || x === '') return null;
  if (typeof x === 'number') return Number.isFinite(x) && x >= 0 && x < 1e9 ? ROUND2(x) : null;
  if (typeof x !== 'string') return null;
  let s = toAsciiDigits(x).trim();
  s = s.replace(/^(?:rs\.?|inr|rupees|₹)\s*/i, '').replace(/\s*\/?-+\s*$/, '').replace(/\s*only\s*$/i, '').replace(/\s/g, '');
  if (!/^(?:\d{1,3}(?:,\d{2,3})*|\d+)(?:\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? ROUND2(n) : null;
}

// Strict plain number (quantity, rate): a number, or a string like "2", "2.5", "1,200".
function parseNumber(x) {
  if (x == null || x === '') return null;
  if (typeof x === 'number') return Number.isFinite(x) && x >= 0 && x < 1e9 ? Math.round(x * 1000) / 1000 : null;
  const s = toAsciiDigits(String(x)).trim().replace(/\s/g, '').replace(/\/?-+$/, '');
  if (!/^(?:\d{1,3}(?:,\d{2,3})*|\d+)(?:\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n < 1e9 ? Math.round(n * 1000) / 1000 : null;
}

const isRealDay = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
// "2026-10-05", "05/10/2026", "5-10-26", "05.10.26" -> "2026-10-05" (Indian order: day first) or null. 2-digit years are 20yy.
function parseDate(x) {
  if (x == null || x === '') return null;
  const s = toAsciiDigits(String(x)).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y; let mo; let d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; } else {
    m = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/.exec(s);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  }
  if (y < 1990 || y > 2100 || !isRealDay(y, mo, d)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const clamp01 = (n) => { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null; };
const UNCLEAR_BELOW = 0.6;

// ---- the model's answer -> our shape ------------------------------------------------------------------------------------------------
// Field table: key in the model's JSON -> our key, kind, cap. This is also what the JSON schema (schema.js) is built from.
const FIELD_DEFS = [
  { src: 'vendor_name', key: 'vendorNameOnBill', kind: 'text', max: 160 },
  { src: 'invoice_number', key: 'invoiceNo', kind: 'text', max: 60 },
  { src: 'invoice_date', key: 'invoiceDate', kind: 'date' },
  { src: 'service_date', key: 'serviceDate', kind: 'date' },
  { src: 'asset_reference', key: 'assetRef', kind: 'text', max: 80 },
  { src: 'subtotal', key: 'subtotal', kind: 'money' },
  { src: 'gst_total', key: 'gst', kind: 'money' },
  { src: 'cgst', key: 'cgst', kind: 'money' },
  { src: 'sgst', key: 'sgst', kind: 'money' },
  { src: 'igst', key: 'igst', kind: 'money' },
  { src: 'total', key: 'total', kind: 'money' },
  { src: 'work_description', key: 'workDescription', kind: 'text', max: 1000 },
];
const FIELD_KEYS = FIELD_DEFS.map((f) => f.key);

function readValue(def, v) {
  if (v == null) return null;
  if (def.kind === 'money') return parseMoney(v);
  if (def.kind === 'date') return parseDate(v);
  const t = cleanText(v, def.max);
  return t || null;
}

// The model answer (any shape it may have returned) -> { fields: {key: {value, confidence, unclear, note}}, lines: [...], notes, docType, isBill }
// A value that cannot be read STRICTLY becomes null and the field is marked unclear (so a person types it); it is never "fixed" by guessing.
function normaliseModelOutput(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fields = {};
  for (const def of FIELD_DEFS) {
    const f = o[def.src] && typeof o[def.src] === 'object' && !Array.isArray(o[def.src]) ? o[def.src] : { value: o[def.src] };
    const had = f.value != null && String(f.value).trim() !== '';
    const value = readValue(def, f.value);
    let confidence = clamp01(f.confidence);
    let unclear = f.unclear === true;
    if (had && value == null) { unclear = true; confidence = Math.min(confidence == null ? 0.3 : confidence, 0.3); } // written but not readable under the strict rules
    if (value != null && confidence != null && confidence < UNCLEAR_BELOW) unclear = true;
    if (value == null && confidence == null) confidence = unclear ? 0 : null;
    fields[def.key] = { value, confidence, unclear, note: f.note ? cleanText(f.note, 200) : null };
  }
  const lines = [];
  const rows = Array.isArray(o.lines) ? o.lines.slice(0, 60) : [];
  rows.forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const description = cleanText(r.description, 300) || null;
    const quantity = parseNumber(r.quantity);
    const rate = parseMoney(r.rate);
    const amount = parseMoney(r.amount);
    if (description == null && quantity == null && rate == null && amount == null) return;
    let confidence = clamp01(r.confidence);
    let unclear = r.unclear === true;
    const wrote = (x) => x != null && String(x).trim() !== '';
    if ((wrote(r.quantity) && quantity == null) || (wrote(r.rate) && rate == null) || (wrote(r.amount) && amount == null)) { unclear = true; confidence = Math.min(confidence == null ? 0.3 : confidence, 0.3); }
    if (confidence != null && confidence < UNCLEAR_BELOW) unclear = true;
    lines.push({ description, quantity, rate, amount, confidence, unclear, note: r.note ? cleanText(r.note, 200) : null });
  });
  const dt = String(o.document_type || '').toLowerCase();
  return {
    fields, lines, notes: cleanText(o.notes, 1000) || null,
    docType: ['printed', 'handwritten', 'mixed'].includes(dt) ? dt : 'unknown',
    isBill: o.is_bill_or_invoice === false ? false : true,
  };
}

// ---- derive what can be computed (never when two of three are missing) ---------------------------------------------------------------
// Returns { subtotal, gst, total, derived: ['gst', ...] }. A value that was READ is never overwritten; the total is never derived.
function derive({ subtotal, gst, total, lines }) {
  let s = subtotal == null ? null : subtotal; let g = gst == null ? null : gst; let t = total == null ? null : total;
  const derived = [];
  const sum = lines && lines.length && lines.every((l) => l.amount != null) ? ROUND2(lines.reduce((a, l) => a + l.amount, 0)) : null;
  if (t != null && s != null && g == null && t >= s) { g = ROUND2(t - s); derived.push('gst'); }
  if (t != null && g != null && s == null && t >= g) { s = ROUND2(t - g); derived.push('subtotal'); }
  // the TOTAL is never worked out: it is the headline figure of the bill, so if it was not read a person types it (and the totals check stays honest)
  if (t != null && s == null && g == null && sum != null && t >= sum) { s = sum; g = ROUND2(t - sum); derived.push('subtotal', 'gst'); }
  return { subtotal: s, gst: g, total: t, derived };
}

// ---- checks ----------------------------------------------------------------------------------------------------------------------
const tol = (n) => Math.max(1, Math.abs(Number(n) || 0) * 0.005); // 1 rupee or 0.5 %
const GST_RATES = [0, 5, 12, 18, 28];
const flag = (code, field, level, message) => ({ code, field: field || null, level, message });

function checkLine(l) {
  if (l.quantity != null && l.rate != null && l.amount != null && Math.abs(ROUND2(l.quantity * l.rate) - l.amount) > tol(l.amount)) return true;
  return false;
}

// subtotal, gst, total and the lines: the arithmetic of the bill. `f` = { subtotal, gst, cgst, sgst, igst, total }.
function checkTotals(f, lines = []) {
  const out = [];
  lines.forEach((l, i) => {
    if (checkLine(l)) out.push(flag('line-math', `line.${i + 1}`, 'check', `Line ${i + 1}: quantity x rate (${ROUND2(l.quantity * l.rate)}) is not the amount written (${l.amount}).`));
  });
  if (f.total == null || !(f.total > 0)) out.push(flag('total-missing', 'total', 'block', 'The final total is not filled in.'));
  if (f.subtotal == null || !(f.subtotal > 0)) out.push(flag('subtotal-missing', 'subtotal', 'block', 'The amount before GST is not filled in.'));
  if (f.gst == null && f.subtotal != null && f.total != null) out.push(flag('gst-missing', 'gst', 'check', 'GST is not filled in. If the bill has no GST, type 0.'));
  const sum = lines.length && lines.every((l) => l.amount != null) ? ROUND2(lines.reduce((a, l) => a + l.amount, 0)) : null;
  if (sum != null && f.subtotal != null && Math.abs(sum - f.subtotal) > tol(f.subtotal)) {
    out.push(flag('lines-sum', 'subtotal', 'check', `The lines add up to ${sum}, but the amount before GST is ${f.subtotal}.`));
  }
  if (f.subtotal != null && f.gst != null && f.total != null && Math.abs(ROUND2(f.subtotal + f.gst) - f.total) > tol(f.total)) {
    out.push(flag('total-math', 'total', 'check', `Amount before GST (${f.subtotal}) + GST (${f.gst}) is ${ROUND2(f.subtotal + f.gst)}, but the total is ${f.total}.`));
  }
  const parts = [f.cgst, f.sgst, f.igst].filter((x) => x != null);
  if (parts.length) {
    const ps = ROUND2(parts.reduce((a, b) => a + b, 0));
    if (f.gst != null && Math.abs(ps - f.gst) > tol(f.gst)) out.push(flag('gst-parts', 'gst', 'check', `CGST + SGST + IGST is ${ps}, but GST is ${f.gst}.`));
    if (f.cgst != null && f.sgst != null && Math.abs(f.cgst - f.sgst) > 1) out.push(flag('gst-parts', 'gst', 'check', 'CGST and SGST should be equal.'));
    if (f.igst != null && (f.cgst != null || f.sgst != null) && f.igst > 0 && ((f.cgst || 0) + (f.sgst || 0)) > 0) out.push(flag('gst-parts', 'gst', 'check', 'A bill has either CGST + SGST or IGST, not both.'));
  }
  if (f.subtotal != null && f.subtotal > 0 && f.gst != null && f.gst > 0) {
    const pct = (f.gst / f.subtotal) * 100;
    // The half-rates (2.5, 6, 9, 14) are CGST or SGST alone, they only add up to the full rates above.
    const ok = GST_RATES.some((r) => Math.abs(pct - r) <= 0.6);
    if (!ok) out.push(flag('gst-rate', 'gst', 'check', `GST is ${ROUND2(pct)}% of the amount before GST. Usual GST rates are 5%, 12%, 18% or 28%.`));
  }
  return out;
}

// Dates: not in the future, not older than two years. `today` = 'YYYY-MM-DD'.
function checkDates({ invoiceDate, serviceDate }, today) {
  const out = [];
  const t = new Date(`${today}T00:00:00Z`).getTime();
  const old = new Date(t); old.setUTCFullYear(old.getUTCFullYear() - 2);
  const oldIso = old.toISOString().slice(0, 10);
  if (!invoiceDate) out.push(flag('date-missing', 'invoiceDate', 'block', 'The invoice date is not filled in.'));
  else {
    if (invoiceDate > today) out.push(flag('date-future', 'invoiceDate', 'check', 'The invoice date is in the future.'));
    else if (invoiceDate < oldIso) out.push(flag('date-old', 'invoiceDate', 'check', 'The invoice date is more than 2 years old.'));
  }
  if (serviceDate) {
    if (serviceDate > today) out.push(flag('date-future', 'serviceDate', 'check', 'The repair date is in the future.'));
    else if (serviceDate < oldIso) out.push(flag('date-old', 'serviceDate', 'check', 'The repair date is more than 2 years old.'));
  }
  return out;
}

// ---- keys for matching and duplicates -------------------------------------------------------------------------------------------------
// "INV-001", "inv 001" -> "INV001" ; "0045" -> "45" (a purely numeric number loses its leading zeros)
function normInvoiceNo(s) {
  let t = toAsciiDigits(String(s == null ? '' : s)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^\d+$/.test(t)) t = t.replace(/^0+(?=\d)/, '');
  return t;
}
// Asset codes / serial numbers: upper-case letters and digits only.
const normRef = (s) => toAsciiDigits(String(s == null ? '' : s)).toUpperCase().replace(/[^A-Z0-9]/g, '');

const NAME_NOISE = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'corp', 'corporation', 'and', 'the', 'of', 'inc', 'enterprises', 'enterprise', 'services', 'service', 'solutions', 'solution', 'traders', 'trading', 'sons', 'proprietor', 'prop']);
function normNameTokens(s) {
  return toAsciiDigits(String(s == null ? '' : s)).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9ऀ-ॿఀ-౿]+/g, ' ').split(' ').filter((w) => w && !NAME_NOISE.has(w));
}
// Does the name written on the bill look like the logged-in vendor? (fuzzy: shared words, or one name inside the other)
function sameVendorName(onBill, vendorName) {
  const a = normNameTokens(onBill); const b = normNameTokens(vendorName);
  if (!a.length || !b.length) return null; // nothing to compare
  const sa = new Set(a); const sb = new Set(b);
  const inter = [...sa].filter((w) => sb.has(w)).length;
  const dice = (2 * inter) / (sa.size + sb.size);
  if (dice >= 0.5) return true;
  const ja = a.join(''); const jb = b.join('');
  if (ja.length >= 4 && jb.length >= 4 && (ja.includes(jb) || jb.includes(ja))) return true;
  // a one-letter slip in a single-word name ("chandra" / "chandhra")
  if (a.length === 1 && b.length === 1) return editDistance(a[0], b[0]) <= Math.max(1, Math.floor(Math.max(a[0].length, b[0].length) / 6));
  return false;
}
function editDistance(a, b) {
  const m = a.length; const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) for (let j = 1; j <= n; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// Match what the bill says about the asset against candidates [{ id, keys: [strings] }] (codes, serial numbers, repair numbers).
// -> { status: 'matched'|'ambiguous'|'unmatched'|'none', id?, ids? }. Exact, normalised match only: a near-miss is "unmatched" (a person decides).
function matchRef(ref, candidates) {
  const key = normRef(ref);
  if (!key || key.length < 3) return { status: 'none' };
  const hits = candidates.filter((c) => (c.keys || []).some((k) => normRef(k) === key));
  const ids = [...new Set(hits.map((h) => h.id))];
  if (ids.length === 1) return { status: 'matched', id: ids[0] };
  if (ids.length > 1) return { status: 'ambiguous', ids };
  return { status: 'unmatched' };
}

// Total of a bill vs the repair's estimate: how many percent over (null when no estimate).
function overEstimatePct(total, estimateTotal) {
  if (!(estimateTotal > 0) || total == null) return null;
  return ROUND2(((total - estimateTotal) / estimateTotal) * 100);
}

module.exports = {
  ROUND2, toAsciiDigits, cleanText, parseMoney, parseNumber, parseDate, clamp01, UNCLEAR_BELOW,
  FIELD_DEFS, FIELD_KEYS, normaliseModelOutput, derive, checkLine, checkTotals, checkDates, flag, tol, GST_RATES,
  normInvoiceNo, normRef, normNameTokens, sameVendorName, matchRef, overEstimatePct, editDistance,
};
