// ---------------------------------------------------------------------------
// UPLOAD REPAIR BILL - PURE LOGIC shared by the vendor screens (AssetPortalBillUploads.jsx) and Accounts' review screen
// (pages/office/VendorBillUploadsReview.jsx). No React, no network: unit-tested by scripts/vendor-bill-upload-test.js (group J).
// The server is always the judge (it re-checks everything); these helpers only draw the same words and recompute the totals live.
// ---------------------------------------------------------------------------

// The steps the founder asked for: Not sent yet -> Uploaded -> AI reading -> Needs review / Waiting for approval -> Approved -> Synced
export const STEP_LABELS = ['Not sent yet', 'Uploaded', 'AI reading', 'Needs review / Waiting for approval', 'Approved', 'Synced'];
export const STEP_OF = { NOT_SENT: 0, UPLOADED: 1, AI_PROCESSING: 2, NEEDS_REVIEW: 3, PENDING_APPROVAL: 3, REJECTED: 3, APPROVED: 4, SYNCED: 5, SUPERSEDED: 0 };
export const STATUS_WORDS = {
  NOT_SENT: 'Not sent yet', UPLOADED: 'Uploaded', AI_PROCESSING: 'AI is reading it', NEEDS_REVIEW: 'Needs review', PENDING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved', REJECTED: 'Rejected', SYNCED: 'Synced to Accounts', SUPERSEDED: 'Replaced by a newer file',
};
export const STATUS_TONE = {
  NOT_SENT: 'grey', UPLOADED: 'blue', AI_PROCESSING: 'blue', NEEDS_REVIEW: 'yellow', PENDING_APPROVAL: 'yellow', APPROVED: 'green', SYNCED: 'green', REJECTED: 'red', SUPERSEDED: 'grey',
};
// One plain sentence per status for the vendor.
export const STATUS_HELP = {
  NOT_SENT: 'You have not sent this bill yet. Press Send when it is ready.',
  UPLOADED: 'We have your bill. Reading it will start in a moment.',
  AI_PROCESSING: 'The bill is being read. This takes about a minute.',
  NEEDS_REVIEW: 'Accounts will check a few things on this bill. You can correct anything that is wrong.',
  PENDING_APPROVAL: 'The bill looks clear. It is waiting for Accounts to approve it.',
  APPROVED: 'Accounts approved this bill. It is being added to your invoices.',
  SYNCED: 'Accounts approved this bill and it is in your invoices. Payment follows the company\'s usual process.',
  REJECTED: 'Accounts did not accept this bill. The reason is below. You can upload a corrected bill.',
  SUPERSEDED: 'You replaced this file with a newer one.',
};

// stepper(status) -> [{ label, state: 'done' | 'now' | 'todo' | 'bad' }]
export function stepper(status) {
  const now = STEP_OF[status] ?? 0;
  return STEP_LABELS.map((label, i) => {
    if (status === 'REJECTED' && i === 3) return { label: 'Rejected', state: 'bad' };
    if (status === 'SUPERSEDED') return { label, state: 'todo' };
    if (status === 'SYNCED') return { label, state: 'done' }; // the last step is finished, not "current"
    if (i < now) return { label, state: 'done' };
    if (i === now) return { label, state: 'now' };
    return { label, state: 'todo' };
  });
}

// ---- reading what a person types -----------------------------------------------------------------------------------------------
// "1,500", "Rs. 1500.50", "1500/-" -> number ; anything else -> null (never guesses). Same rule as the server.
export function parseMoney(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? Math.round(text * 100) / 100 : null;
  let s = String(text).trim().replace(/^(?:rs\.?|inr|rupees|₹)\s*/i, '').replace(/\s*\/?-+\s*$/, '').replace(/\s/g, '');
  if (!/^(?:\d{1,3}(?:,\d{2,3})*|\d+)(?:\.\d{1,2})?$/.test(s)) return null;
  s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const money = (n) => (n === null || n === undefined || n === '' ? '' : String(r2(n)));
const tol = (n) => Math.max(1, Math.abs(Number(n) || 0) * 0.005);

// The live arithmetic under the table: the lines against the amount before GST, and amount + GST against the total.
// -> { linesSum, lineProblems: [lineNo], linesVsSubtotal: null | { ok, text }, totalVsParts: null | { ok, text } }
export function liveTotals({ subtotal, gst, total }, lines) {
  const rows = Array.isArray(lines) ? lines : [];
  const amounts = rows.map((l) => parseMoney(l.amount));
  const allAmounts = rows.length > 0 && rows.every((l, i) => (String(l.amount ?? '').trim() === '' ? false : amounts[i] !== null));
  const linesSum = allAmounts ? r2(amounts.reduce((a, b) => a + b, 0)) : null;
  const lineProblems = [];
  rows.forEach((l, i) => {
    const q = parseMoney(l.quantity); const rt = parseMoney(l.rate); const am = parseMoney(l.amount);
    if (q !== null && rt !== null && am !== null && Math.abs(r2(q * rt) - am) > tol(am)) lineProblems.push(i + 1);
  });
  const s = parseMoney(subtotal); const g = parseMoney(gst); const t = parseMoney(total);
  let linesVsSubtotal = null;
  if (linesSum !== null && s !== null) {
    const ok = Math.abs(linesSum - s) <= tol(s);
    linesVsSubtotal = { ok, text: ok ? `The lines add up to ${linesSum}.` : `The lines add up to ${linesSum}, but the amount before GST is ${s}.` };
  }
  let totalVsParts = null;
  if (s !== null && g !== null && t !== null) {
    const ok = Math.abs(r2(s + g) - t) <= tol(t);
    totalVsParts = { ok, text: ok ? `${s} + GST ${g} = ${r2(s + g)}.` : `${s} + GST ${g} is ${r2(s + g)}, but the total says ${t}.` };
  }
  return { linesSum, lineProblems, linesVsSubtotal, totalVsParts };
}

// ---- the files chosen in the upload window ------------------------------------------------------------------------------------------
export const LIMITS = { maxFiles: 5, maxBytes: 10 * 1024 * 1024 };
const TYPE_OK = /\.(jpe?g|png|webp|pdf)$/i;
// pickFiles(existing, chosen, limits) -> { files, error } ; keeps what is valid, says in plain words what was left out
export function pickFiles(existing, chosen, limits = LIMITS) {
  const files = [...existing];
  const problems = [];
  for (const f of chosen) {
    const name = f.name || 'file';
    if (!TYPE_OK.test(name) || (f.type && !/^(image\/(jpeg|png|webp)|application\/pdf)$/i.test(f.type))) { problems.push(`${name}: only JPG, PNG, WebP or PDF.`); continue; } // eslint-disable-line no-continue
    if (f.size > limits.maxBytes) { problems.push(`${name}: bigger than ${Math.round(limits.maxBytes / 1048576)} MB.`); continue; } // eslint-disable-line no-continue
    if (f.size === 0) { problems.push(`${name}: the file is empty.`); continue; } // eslint-disable-line no-continue
    if (files.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) { problems.push(`${name}: already added.`); continue; } // eslint-disable-line no-continue
    if (files.length >= limits.maxFiles) { problems.push(`${name}: a bill can have up to ${limits.maxFiles} files.`); continue; } // eslint-disable-line no-continue
    files.push(f);
  }
  return { files, error: problems.join(' ') };
}

// A unique key for one open upload window (the server answers a repeated key with the first result, so a double click makes one bill).
export function newIdemKey() {
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `bu-${Date.now().toString(36)}-${rnd()}${rnd()}`;
}

// A short, plain line for a flag the server sent (staff screen): "Check this" amber text.
export const FLAG_LEVEL_WORDS = { block: 'Must be fixed', check: 'Check this', info: 'For your information' };
