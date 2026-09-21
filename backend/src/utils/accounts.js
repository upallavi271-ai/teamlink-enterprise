// Shared Accounts money rules.
//
// These mirror the design prototype: an invoice's total is amount + GST - TDS
// (TDS is deducted at source by the client, so it never arrives in the bank),
// and a bank credit is only auto-suggested against an invoice when it lands
// within 2% of what is still outstanding on it.

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;

// amount + gst - tds — the figure the client actually transfers.
function invoiceTotal(invoice) {
  return ROUND(Number(invoice.amount || 0) + Number(invoice.gst || 0) - Number(invoice.tds || 0));
}

// What is still to be collected after any receipts already recorded.
function invoiceOutstanding(invoice) {
  return ROUND(invoiceTotal(invoice) - Number(invoice.receivedAmount || 0));
}

const SETTLED_TOLERANCE = 0.5; // rupees — below this an invoice counts as closed

// The status an invoice *should* carry, given its receipts and due date.
// 'Cancelled' is sticky: a cancelled invoice is never re-derived.
function deriveInvoiceStatus(invoice, today = new Date()) {
  if (invoice.status === 'Cancelled') return 'Cancelled';
  const outstanding = invoiceOutstanding(invoice);
  if (outstanding <= SETTLED_TOLERANCE) return 'Paid';
  if (Number(invoice.receivedAmount || 0) > 0) return 'Partially Paid';
  if (invoice.dueDate && String(invoice.dueDate) < toIsoDate(today)) return 'Overdue';
  return 'Pending';
}

function toIsoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// "Net 30" / "Net 45" / "Due on receipt" -> number of days.
function termDays(paymentTerms) {
  const m = String(paymentTerms || '').match(/(\d+)/);
  return m ? Number(m[1]) : 30;
}

function dueDateFor(invoiceDate, paymentTerms) {
  const d = new Date(invoiceDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + termDays(paymentTerms));
  return toIsoDate(d);
}

// An invoice is "open" for matching purposes while money is still expected on it.
function isOpenInvoice(invoice) {
  return invoice.status !== 'Cancelled' && invoiceOutstanding(invoice) > SETTLED_TOLERANCE;
}

const SUGGEST_TOLERANCE_PCT = 0.02; // 2% of the outstanding amount

// The prototype's suggestInvoiceFor: credits only, closest open invoice by
// outstanding amount, and only confident enough to offer when the gap is
// within 2% of that invoice. Returns null when nothing is close enough.
function suggestInvoiceFor(txn, invoices) {
  if (!txn || txn.type !== 'Credit') return null;
  const open = invoices.filter(isOpenInvoice);
  let best = null;
  let bestDiff = Infinity;
  for (const inv of open) {
    const diff = Math.abs(invoiceOutstanding(inv) - Number(txn.amount || 0));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = inv;
    }
  }
  if (!best) return null;
  const allowed = invoiceOutstanding(best) * SUGGEST_TOLERANCE_PCT;
  return bestDiff <= allowed ? { invoice: best, diff: ROUND(bestDiff) } : null;
}

// The reconciliation state machine. 'Imported' and 'Suggested Match' are
// presentation states derived from the stored row, not stored themselves.
const RECON_STATES = ['Unmatched', 'Matched', 'Reconciled', 'Ignored'];

function txnState(txn) {
  if (txn.reconStatus && RECON_STATES.includes(txn.reconStatus)) return txn.reconStatus;
  return txn.matched ? 'Matched' : 'Unmatched';
}

// ---------------------------------------------------------------------------
// Period picker. The prototype's financial year runs April to March and rolls
// over on its own; the picker offers the whole year, either half, any quarter
// or a single month of it (fyOf / periodMonths / periodLabel in the accounts
// application). `sel` is one of: all | FY:<year> | H1:<year> | H2:<year> |
// Q1:<year>..Q4:<year> | M:<YYYY-MM>.
// ---------------------------------------------------------------------------

function currentFy(today = new Date()) {
  return today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1;
}

// All twelve month keys of a financial year, April first.
function fyMonths(year) {
  const out = [];
  for (let i = 0; i < 12; i += 1) {
    const m = 4 + i;
    const y = m > 12 ? year + 1 : year;
    out.push(`${y}-${String(m > 12 ? m - 12 : m).padStart(2, '0')}`);
  }
  return out;
}

const PERIOD_SLICE = {
  FY: [0, 12], H1: [0, 6], H2: [6, 12], Q1: [0, 3], Q2: [3, 6], Q3: [6, 9], Q4: [9, 12],
};

const PERIOD_WORD = {
  FY: 'FY', H1: 'Apr–Sep', H2: 'Oct–Mar', Q1: 'Q1 Apr–Jun', Q2: 'Q2 Jul–Sep', Q3: 'Q3 Oct–Dec', Q4: 'Q4 Jan–Mar',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (mk) => (mk ? `${MONTH_NAMES[Number(String(mk).slice(5, 7)) - 1]} ${String(mk).slice(0, 4)}` : '—');

function lastDayOf(mk) {
  const y = Number(String(mk).slice(0, 4));
  const m = Number(String(mk).slice(5, 7));
  return toIsoDate(new Date(y, m, 0));
}

// { from, to, label, months[] } for a picker selection. `all` means every date.
function dashRange(sel, today = new Date()) {
  const s = String(sel || `FY:${currentFy(today)}`);
  if (s === 'all') return { all: true, from: null, to: null, label: 'Every month on record', months: null };
  if (s.startsWith('M:')) {
    const mk = s.slice(2);
    return { all: false, from: `${mk}-01`, to: lastDayOf(mk), label: monthLabel(mk), months: [mk] };
  }
  const [kind, yRaw] = s.split(':');
  const year = Number(yRaw) || currentFy(today);
  const slice = PERIOD_SLICE[kind] || PERIOD_SLICE.FY;
  const months = fyMonths(year).slice(slice[0], slice[1]);
  const word = PERIOD_WORD[kind] || 'FY';
  return {
    all: false,
    from: `${months[0]}-01`,
    to: lastDayOf(months[months.length - 1]),
    // "Financial year 2026-2027" is how the note under the filters names it.
    label: kind === 'FY' ? `Financial year ${year}-${year + 1}` : `${word} ${year}–${String(year + 1).slice(2)}`,
    months,
  };
}

const inRange = (dateStr, range) => {
  if (!dateStr) return false;
  if (!range || range.all) return true;
  const d = String(dateStr).slice(0, 10);
  return d >= range.from && d <= range.to;
};

// The picker's own option list, so the Accounts Dashboard and the Invoice page
// offer exactly the same periods. The current financial year is named as the
// application names it rather than by its years.
function periodOptions(today = new Date()) {
  const fyNow = currentFy(today);
  const out = [
    { value: 'all', label: 'Every month on record' },
    { value: `FY:${fyNow}`, label: 'Current Financial Year' },
  ];
  [fyNow, fyNow - 1, fyNow - 2].forEach((y) => {
    const tag = `${y}–${String(y + 1).slice(2)}`;
    if (y !== fyNow) out.push({ value: `FY:${y}`, label: `FY ${tag}` });
    out.push({ value: `H1:${y}`, label: `Apr–Sep ${y}` });
    out.push({ value: `H2:${y}`, label: `Oct–Mar ${tag}` });
    out.push({ value: `Q1:${y}`, label: `Q1 Apr–Jun ${y}` });
    out.push({ value: `Q2:${y}`, label: `Q2 Jul–Sep ${y}` });
    out.push({ value: `Q3:${y}`, label: `Q3 Oct–Dec ${y}` });
    out.push({ value: `Q4:${y}`, label: `Q4 Jan–Mar ${y + 1}` });
    fyMonths(y).forEach((mk) => out.push({ value: `M:${mk}`, label: monthLabel(mk) }));
  });
  return out;
}

// The payment-status filter vocabulary. "Received" is the old tracker's word
// for a fully settled invoice, so it picks the same rows as "Paid" — kept
// because the team still asks for it. Overdue and Cancelled are this
// application's own and have no equivalent in the tracker.
const PAY_STATUS = ['All', 'Pending', 'Received', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'];
const STATUS_ALIAS = { Received: 'Paid' };
const statusMatch = (status, want) => !want || want === 'All' || status === (STATUS_ALIAS[want] || want);

// "8.33%" — the application's own percentage text, never a bare number.
const pctTxt = (p) => (p == null || p === '' || Number.isNaN(Number(p)) ? '—' : `${Number(p)}%`);

// "Billing type" as the client agreement states it. Percentage of annual CTC is
// the only basis this application models; a flat-fee invoice says so.
function billingLabel(client, invoice) {
  const pct = invoice && invoice.feePercent != null ? invoice.feePercent : (client ? client.agreementFeePercent : null);
  if (pct != null && pct !== '') return `% of Annual CTC · ${pctTxt(pct)}`;
  return 'Flat fee';
}

// The Client GSTIN cell, in its own words: the number when we hold it, else
// whether the client is registered at all.
function clientGstinText(client) {
  const v = String((client && client.gst) || '').trim();
  if (v) return { text: v, kind: 'number' };
  if (client && String(client.state || '').trim()) return { text: 'registered · no number', kind: 'warn' };
  return { text: 'Not registered', kind: 'plain' };
}

// Whether a client has never, always, or sometimes been charged GST — the
// "By the client's whole history" half of the GST charged filter.
function gstStance(invoices) {
  const by = {};
  invoices.forEach((i) => {
    const c = (i.client && i.client.name) || null;
    if (!c) return;
    by[c] = by[c] || { y: 0, n: 0 };
    if (Number(i.gst || 0) > 0.5) by[c].y += 1; else by[c].n += 1;
  });
  const out = {};
  Object.keys(by).forEach((c) => {
    const o = by[c];
    out[c] = (o.y && o.n) ? 'mixed' : (o.y ? 'always' : 'never');
  });
  return out;
}

// ---------------------------------------------------------------------------
// The printable tax invoice: GST state codes for "Place Of Supply", and the
// amount in words the document prints under its totals.
// ---------------------------------------------------------------------------

const GST_STATE = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04', uttarakhand: '05',
  haryana: '06', delhi: '07', rajasthan: '08', 'uttar pradesh': '09', bihar: '10', sikkim: '11',
  'arunachal pradesh': '12', nagaland: '13', manipur: '14', mizoram: '15', tripura: '16', meghalaya: '17',
  assam: '18', 'west bengal': '19', jharkhand: '20', odisha: '21', chhattisgarh: '22', 'madhya pradesh': '23',
  gujarat: '24', 'daman and diu': '26', maharashtra: '27', 'andhra pradesh': '37', karnataka: '29', goa: '30',
  lakshadweep: '31', kerala: '32', 'tamil nadu': '33', puducherry: '34', 'andaman and nicobar islands': '35',
  telangana: '36', ladakh: '38',
};

function stateOf(text) {
  const t = String(text || '').toLowerCase();
  const hit = Object.keys(GST_STATE).find((s) => t.indexOf(s) >= 0);
  return hit ? { name: hit.replace(/\b\w/g, (c) => c.toUpperCase()), code: GST_STATE[hit] } : null;
}

function placeOfSupply(clientText, companyState) {
  const s = stateOf(clientText) || stateOf(companyState);
  return s ? `${s.name} (${s.code})` : (companyState || '—');
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven',
  'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const three = (n) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${two(n % 100)}` : ''}` : two(n));

// "Indian Rupee Three Lakh Five Thousand Only" — the wording the document uses.
function wordsINR(amount) {
  const neg = amount < 0;
  const amt = Math.abs(Math.round((Number(amount) || 0) * 100) / 100);
  const rupees = Math.floor(amt);
  const paise = Math.round((amt - rupees) * 100);
  const parts = [];
  const cr = Math.floor(rupees / 10000000);
  const lk = Math.floor((rupees % 10000000) / 100000);
  const th = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;
  if (cr) parts.push(`${three(cr)} Crore`);
  if (lk) parts.push(`${three(lk)} Lakh`);
  if (th) parts.push(`${three(th)} Thousand`);
  if (rest) parts.push(three(rest));
  let s = `${neg ? 'Minus ' : ''}Indian Rupee ${parts.join(' ').replace(/\s+/g, ' ').trim() || 'Zero'}`;
  if (paise) s += ` and ${two(paise)} Paise`;
  return `${s} Only`;
}

// ---------------------------------------------------------------------------
// Receivables ageing, in the prototype's own bucket vocabulary.
// ---------------------------------------------------------------------------

const AGE_BUCKETS = ['Not due yet', '0–30 days', '31–60 days', '61–90 days', '90+ days'];

function daysOverdue(dueDate, today = new Date()) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((today - d) / 86400000);
}

// "Invoice age" in the pending screens is days since the invoice was raised —
// not days past its due date. An invoice not yet due still has an age.
function invoiceAge(invoiceDate, today = new Date()) {
  if (!invoiceDate) return null;
  const d = new Date(String(invoiceDate).slice(0, 10));
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((today - d) / 86400000));
}

// 'Settled' is a sixth bucket the chips only show when something lands in it.
function ageBucket(invoice, today = new Date()) {
  if (invoiceOutstanding(invoice) <= SETTLED_TOLERANCE) return 'Settled';
  const n = daysOverdue(invoice.dueDate, today);
  if (n == null || n < 0) return 'Not due yet';
  if (n <= 30) return '0–30 days';
  if (n <= 60) return '31–60 days';
  if (n <= 90) return '61–90 days';
  return '90+ days';
}

// ---------------------------------------------------------------------------
// Bank matching. The embedded accounting app reads the client out of the
// narration before it ever looks at the amount, which is what turns a pile of
// "no match" lines into "client named". We keep main's 2%-of-outstanding
// amount match as the fallback, and add the narration read on top of it.
// ---------------------------------------------------------------------------

const normName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Words a bank narration is full of that say nothing about who paid.
const NOISE = new Set(['NEFT', 'RTGS', 'IMPS', 'UPI', 'CR', 'DR', 'CHQ', 'CHEQUE', 'TRF', 'TRANSFER',
  'PAYMENT', 'PAYMT', 'INB', 'MB', 'BY', 'TO', 'FROM', 'THE', 'AND', 'LTD', 'PVT', 'PRIVATE',
  'LIMITED', 'INDIA', 'BANK', 'REF', 'UTR', 'A', 'C', 'AC', 'NO']);

function clientFromNarration(description, clients) {
  const text = normName(description);
  if (!text) return null;
  let best = null;
  clients.forEach((c) => {
    const full = normName(c.name);
    if (!full) return;
    if (text.includes(full)) {
      if (!best || full.length > best.score) best = { client: c, score: full.length, why: `"${c.name}" appears in the narration` };
      return;
    }
    // Fall back to the distinctive words of the name — banks truncate.
    const words = full.split(' ').filter((w) => w.length > 3 && !NOISE.has(w));
    const hit = words.filter((w) => text.includes(w));
    if (hit.length && hit.length === words.length) {
      const score = hit.join('').length;
      if (!best || score > best.score) best = { client: c, score, why: `the narration names ${hit.join(' ')}` };
    }
  });
  return best;
}

// Oldest invoice first, exactly as the application settles a lump receipt.
function allocPlan(invoices, amount) {
  let left = ROUND(amount);
  const parts = [];
  invoices
    .filter(isOpenInvoice)
    .sort((a, b) => String(a.invoiceDate || '').localeCompare(String(b.invoiceDate || '')))
    .forEach((inv) => {
      if (left <= SETTLED_TOLERANCE) return;
      const take = Math.min(left, invoiceOutstanding(inv));
      if (take <= SETTLED_TOLERANCE) return;
      parts.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: ROUND(take) });
      left = ROUND(left - take);
    });
  return { parts, unallocated: ROUND(Math.max(0, left)) };
}

// The confidence vocabulary shown against a credit: the prototype's own words.
// 'client named' | 'amount only — check' | 'several match' | 'no match'.
function matchCredit(txn, invoices, clients) {
  if (!txn || txn.type !== 'Credit') return null;
  const named = clientFromNarration(txn.description, clients);
  if (named) {
    const theirs = invoices.filter((i) => i.clientId === named.client.id && isOpenInvoice(i));
    if (theirs.length) {
      const exact = theirs.find((i) => Math.abs(invoiceOutstanding(i) - Number(txn.amount || 0)) <= 1);
      const plan = allocPlan(theirs, txn.amount);
      return {
        kind: 'client named',
        client: named.client.name,
        clientId: named.client.id,
        why: named.why,
        invoiceId: exact ? exact.id : (plan.parts[0] || {}).invoiceId || null,
        invoiceNumber: exact ? exact.invoiceNumber : (plan.parts[0] || {}).invoiceNumber || null,
        plan,
        options: theirs.map((i) => i.id),
      };
    }
    return { kind: 'no match', client: named.client.name, clientId: named.client.id, why: `${named.client.name} is named but has nothing outstanding`, plan: { parts: [], unallocated: ROUND(txn.amount) }, options: [] };
  }
  const amountHits = invoices.filter((i) => isOpenInvoice(i) && Math.abs(invoiceOutstanding(i) - Number(txn.amount || 0)) <= invoiceOutstanding(i) * SUGGEST_TOLERANCE_PCT);
  if (amountHits.length === 1) {
    return {
      kind: 'amount only — check',
      client: null,
      why: 'nothing in the narration — this is the only invoice the amount fits',
      invoiceId: amountHits[0].id,
      invoiceNumber: amountHits[0].invoiceNumber,
      plan: { parts: [{ invoiceId: amountHits[0].id, invoiceNumber: amountHits[0].invoiceNumber, amount: ROUND(txn.amount) }], unallocated: 0 },
      options: amountHits.map((i) => i.id),
    };
  }
  if (amountHits.length > 1) {
    return {
      kind: 'several match',
      client: null,
      why: `${amountHits.length} invoices are open for this amount — pick the right one`,
      invoiceId: null,
      invoiceNumber: null,
      plan: { parts: [], unallocated: ROUND(txn.amount) },
      options: amountHits.map((i) => i.id),
    };
  }
  return { kind: 'no match', client: null, why: 'no client in the narration and no invoice at this amount', invoiceId: null, invoiceNumber: null, plan: { parts: [], unallocated: ROUND(txn.amount) }, options: [] };
}

module.exports = {
  ROUND,
  currentFy,
  fyMonths,
  dashRange,
  inRange,
  periodOptions,
  PAY_STATUS,
  STATUS_ALIAS,
  statusMatch,
  pctTxt,
  billingLabel,
  clientGstinText,
  gstStance,
  stateOf,
  placeOfSupply,
  wordsINR,
  monthLabel,
  lastDayOf,
  AGE_BUCKETS,
  ageBucket,
  daysOverdue,
  invoiceAge,
  normName,
  clientFromNarration,
  allocPlan,
  matchCredit,
  invoiceTotal,
  invoiceOutstanding,
  deriveInvoiceStatus,
  dueDateFor,
  termDays,
  toIsoDate,
  isOpenInvoice,
  suggestInvoiceFor,
  txnState,
  RECON_STATES,
  SETTLED_TOLERANCE,
  SUGGEST_TOLERANCE_PCT,
};
