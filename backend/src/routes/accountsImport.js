const express = require('express');
const XLSX = require('xlsx');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { parseMultipart } = require('../utils/attachments');
const { ROUND, normName, dueDateFor, deriveInvoiceStatus } = require('../utils/accounts');
const bankRoutes = require('./bank');
const invoiceRoutes = require('./invoices');

// ---------------------------------------------------------------------------
// ACCOUNTS — IMPORT ANY FILE
//
// One upload for every Accounts screen. Whatever the file is — xlsx, xls,
// xlsm, xlsb, ods, csv, tsv, txt — SheetJS reads it into a grid; this route
// then finds the header row, works out whether the sheet is a BANK STATEMENT,
// a list of EXPENSES or a list of INVOICES, and maps the columns by name.
//
//   POST /preview   file (+ kind, sheet, mapping)  → what WOULD be imported
//   POST /commit    same fields + options          → writes it
//
// Nothing is written by /preview. The commit re-reads the same file with the
// same choices, so what is written is what was previewed.
//
// Each kind is written through the same rules its own screen uses:
//   bank      → bank.js importStatement (dedupe, batch, opening balance,
//               auto-posting of client receipts)
//   expenses  → office rules: amount before GST + GST = stored gross
//   invoices  → the sheet's own invoice numbers are kept; a number already on
//               file is skipped, never overwritten; the client is matched by
//               name. Importing an invoice list NEVER raises new invoices for
//               joinings — it records the ones in the sheet.
//
// PDFs and images are refused with a plain reason: they carry no table this
// can read reliably, and a guessed amount in the ledger is worse than none.
// ---------------------------------------------------------------------------

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('accounts'));

const MAX_BYTES = 15 * 1024 * 1024;
const PREVIEW_ROWS = 15;

const KINDS = {
  bank: { label: 'Bank statement', perm: ['Bank & Reconciliation', 'edit'] },
  expenses: { label: 'Office expenses', perm: ['Office & Expenses', 'edit'] },
  invoices: { label: 'Invoices', perm: ['Invoices', 'create'] },
};

// The fields each kind understands, in the order columns are claimed. Specific
// fields come before generic ones so "GST Amount" is claimed by GST before the
// bare /amount/ pattern of the base amount can take it.
const FIELDS = {
  bank: [
    ['date', 'Date', [/^(txn |tran |transaction |value |posting |post )?date/, /date/]],
    ['credit', 'Credit / deposit', [/deposit|credit|money in|cr amount|receipt/]],
    ['debit', 'Debit / withdrawal', [/withdraw|debit|money out|dr amount|payment/]],
    ['balance', 'Balance', [/balance|closing/]],
    ['drcr', 'Dr / Cr marker', [/^(dr ?\/? ?cr|cr ?\/? ?dr|type|txn type|d ?\/? ?c)$/]],
    ['amount', 'Amount (signed)', [/^amount|amount/]],
    ['reference', 'Reference / UTR / cheque', [/ref|utr|cheque|chq|instrument/]],
    ['description', 'Narration', [/narration|description|particular|remark|details|transaction/]],
  ],
  expenses: [
    ['dueDate', 'Due date', [/due/]],
    ['date', 'Bill date', [/^(bill|expense|invoice|paid|payment|voucher) date|paid on/, /^date$/, /date/]],
    ['gstRate', 'GST %', [/gst.*(%|rate|percent)|(%|rate).*gst/]],
    ['tdsRate', 'TDS %', [/tds.*(%|rate|percent)|(%|rate).*tds/]],
    ['gst', 'GST amount', [/^(c|s|i|u)?gst( amount| amt)?$/, /\b(c|s|i)gst\b|\bgst\b(?!.*(in|no|number))/]],
    ['tds', 'TDS amount', [/\btds\b/]],
    ['total', 'Total (incl. GST)', [/total|gross|incl|invoice value|bill value|net payable/]],
    ['base', 'Amount before GST', [/taxable|before gst|base|basic|excl/, /^(bill |expense )?amount$/, /amount|cost/, /value/]],
    ['category', 'Category / expense head', [/categor|expense head|^head$|ledger|account head|expense type|type of expense|nature/]],
    ['vendor', 'Vendor / paid to', [/vendor|paid to|payee|party|supplier|merchant/]],
    ['billNumber', 'Bill number', [/bill no|bill number|invoice no|invoice number|inv no|voucher/]],
    ['vendorGstin', 'Vendor GSTIN', [/gstin/]],
    ['status', 'Paid / pending', [/status|paid ?\/ ?unpaid|payment status/]],
    ['mode', 'Payment mode', [/mode|method/]],
    ['location', 'Location / branch', [/location|branch|office|city/]],
    ['description', 'Description', [/description|particular|details|purpose|item|narration/]],
    ['notes', 'Notes', [/remark|note|comment/]],
  ],
  invoices: [
    ['invoiceNumber', 'Invoice number', [/inv(oice)? ?(no|number|#|num)|bill no|invoice id/]],
    ['dueDate', 'Due date', [/due/]],
    ['paidDate', 'Paid on', [/paid (date|on)|payment date|receipt date|received (date|on)|realis/]],
    ['invoiceDate', 'Invoice date', [/inv(oice)? date|bill date|raised on/, /^date$/, /date/]],
    ['gstRate', 'GST %', [/gst.*(%|rate|percent)|(%|rate).*gst/]],
    ['tdsRate', 'TDS %', [/tds.*(%|rate|percent)|(%|rate).*tds/]],
    ['received', 'Amount received', [/received|collected|realised|realized|amount paid|paid amount|receipt/]],
    ['gst', 'GST amount', [/^(c|s|i)?gst( amount| amt)?$/, /\b(c|s|i)gst\b|\bgst\b(?!.*(in|no|number))/]],
    ['tds', 'TDS amount', [/\btds\b/]],
    ['total', 'Invoice value (incl. GST)', [/total|gross|invoice value|invoice amount|incl|bill value/]],
    ['amount', 'Amount before GST', [/taxable|before gst|base amount|basic|excl/, /^(invoice |bill )?amount$|professional fee|service (fee|charge)/, /amount|\bfee\b(?!.*%)/, /value/]],
    ['client', 'Client', [/client|customer|company|party|billed to|bill to|employer/]],
    ['candidate', 'Candidate', [/candidate|joinee|joiner/]],
    ['status', 'Status', [/status/]],
    ['notes', 'Notes', [/remark|note|comment|description/]],
  ],
};
const NUMERIC = new Set(['credit', 'debit', 'balance', 'amount', 'gst', 'tds', 'total', 'base', 'received', 'gstRate', 'tdsRate']);

// --- reading the file --------------------------------------------------------

const UNREADABLE = [
  [/\.pdf$/i, 'PDF'],
  [/\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i, 'image'],
  [/\.(docx?|rtf|pptx?)$/i, 'Word / PowerPoint'],
  [/\.(zip|rar|7z)$/i, 'archive'],
];

function readGrid(file) {
  const bad = UNREADABLE.find(([re]) => re.test(file.filename || ''));
  if (bad) {
    const extra = bad[1] === 'PDF'
      ? ' Net banking and accounting tools all offer the same statement as Excel or CSV — download that and import it here.'
      : ' Save or export the table as Excel or CSV and import that.';
    return { error: `A ${bad[1]} file has no table that can be read reliably, so nothing was imported.${extra}` };
  }
  let wb;
  try {
    // raw: true keeps CSV / TXT cells as the text they are — otherwise the
    // reader guesses US month/day dates and turns 01/02 into 2 January.
    wb = XLSX.read(file.data, { type: 'buffer', raw: true, cellDates: false, dense: true });
  } catch (err) {
    return { error: `That file could not be read as a spreadsheet (${err.message}). Save it as Excel (.xlsx) or CSV and try again.` };
  }
  const sheets = wb.SheetNames.map((name) => {
    // Blank rows are kept so a line number here is the row number Excel shows.
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true });
    return { name, rows };
  }).filter((s) => s.rows.some(hasContent));
  if (!sheets.length) return { error: 'The file has no rows in it.' };
  return { sheets };
}

function hasContent(r) {
  return Array.isArray(r) && r.some((c) => String(c == null ? '' : c).trim() !== '');
}

const headText = (v) => String(v == null ? '' : v).toLowerCase().replace(/[_.\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();

// Claim columns for one kind: each field takes the first unclaimed header its
// patterns match. GST may be split into CGST + SGST + IGST, so it takes all of
// its matching columns and they are added together.
function autoMap(kind, heads) {
  const used = new Set();
  const mapping = {};
  for (const [field, , pats] of FIELDS[kind]) {
    const hits = [];
    for (const p of pats) {
      heads.forEach((h, i) => { if (h && !used.has(i) && !hits.includes(i) && p.test(h)) hits.push(i); });
      if (hits.length) break;
    }
    const take = field === 'gst' ? hits.filter((i) => !/rate|%|in$|gstin/.test(heads[i])) : hits.slice(0, 1);
    take.forEach((i) => used.add(i));
    mapping[field] = take;
  }
  return mapping;
}

// How well a mapping fits its kind — what decides a sheet's kind when the
// screen did not say, and which row is the header.
function fit(kind, m) {
  const has = (f) => (m[f] || []).length > 0;
  if (kind === 'bank') {
    return (has('date') ? 2 : 0) + (has('credit') && has('debit') ? 4 : 0) + (has('balance') ? 2 : 0)
      + (has('description') ? 1 : 0) + (has('amount') || has('credit') || has('debit') ? 1 : 0);
  }
  if (kind === 'expenses') {
    return (has('category') ? 3 : 0) + (has('vendor') ? 2 : 0) + (has('base') || has('total') ? 1 : 0)
      + (has('date') ? 1 : 0) + (has('billNumber') ? 1 : 0);
  }
  return (has('client') ? 3 : 0) + (has('invoiceNumber') ? 3 : 0) + (has('amount') || has('total') ? 1 : 0)
    + (has('invoiceDate') ? 1 : 0) + (has('received') ? 1 : 0);
}

// The header row is the one, among the first forty, whose cells name the most
// known columns — bank statements carry the bank's address and the account
// number above it.
function findHeader(rows, kinds) {
  let best = { score: 0, index: -1 };
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const heads = (rows[i] || []).map(headText);
    if (heads.filter(Boolean).length < 2) continue;
    for (const kind of kinds) {
      const score = fit(kind, autoMap(kind, heads));
      if (score > best.score) best = { score, index: i, kind };
    }
  }
  return best;
}

// --- values --------------------------------------------------------------------

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v == null ? '' : v).trim();
  if (!t || t === '-' || t === '—') return null;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
  if (/\bdr\.?$/i.test(t)) sign = -1;
  t = t.replace(/(rs\.?|inr|₹|\bcr\.?|\bdr\.?|,|\s|%)/gi, '');
  if (t.endsWith('-')) { sign = -1; t = t.slice(0, -1); }
  const n = Number(t);
  return t === '' || Number.isNaN(n) ? null : sign * n;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

// dayFirst: Indian dd/mm unless the column itself proves mm/dd.
function isoDate(v, dayFirst = true) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {
      const d = XLSX.SSF.parse_date_code(v);
      return d && validYmd(d.y, d.m, d.d) ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null;
    }
    const s = String(v);
    if (/^\d{8}$/.test(s)) return isoDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`);
    return null;
  }
  const t = String(v).trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validYmd(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  m = t.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const [d, mo] = dayFirst ? [+m[1], +m[2]] : [+m[2], +m[1]];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = t.match(/^(\d{1,2})[-/. ]?([a-z]{3,9})[-/., ]*(\d{2,4})/i);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validYmd(y, mo, +m[1]) ? `${y}-${pad(mo)}-${pad(m[1])}` : null;
  }
  m = t.match(/^([a-z]{3,9})[-/. ]+(\d{1,2}),?[-/. ]+(\d{2,4})/i);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validYmd(y, mo, +m[2]) ? `${y}-${pad(mo)}-${pad(m[2])}` : null;
  }
  return null;
}

// A column is month-first only if some value in it cannot be day-first.
function dayFirstFor(rows, cols) {
  for (const r of rows) {
    for (const c of cols) {
      const m = String(r[c] == null ? '' : r[c]).trim().match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ]\d{2,4}/);
      if (m && +m[1] > 12) return true;
      if (m && +m[2] > 12) return false;
    }
  }
  return true;
}

// --- normalising one sheet into rows for one kind -------------------------------

function normalise(kind, dataRows, mapping) {
  const text = (r, f) => (mapping[f] || []).map((i) => String(r[i] == null ? '' : r[i]).trim()).filter(Boolean).join(' · ');
  const money = (r, f) => {
    const cols = mapping[f] || [];
    if (!cols.length) return null;
    const vals = cols.map((i) => num(r[i])).filter((n) => n != null);
    return vals.length ? ROUND(vals.reduce((s, n) => s + n, 0)) : null;
  };
  const dateCols = ['date', 'dueDate', 'invoiceDate', 'paidDate'].flatMap((f) => mapping[f] || []);
  const dayFirst = dayFirstFor(dataRows, dateCols);
  const date = (r, f) => {
    const cols = mapping[f] || [];
    return cols.length ? isoDate(r[cols[0]], dayFirst) : null;
  };

  const out = [];
  const skipped = [];
  // A leading "Example?" column (the import templates) marks sample rows.
  const exampleCol = (mapping.__example || []);
  dataRows.forEach((r, idx) => {
    const line = idx + 1;
    if (!hasContent(r)) return;
    if (exampleCol.length && /^\s*example/i.test(String(r[exampleCol[0]] || ''))) {
      skipped.push({ line, reason: 'Example row' }); return;
    }
    if (kind === 'bank') {
      const description = text(r, 'description');
      const d = date(r, 'date');
      if (!d) { skipped.push({ line, reason: 'No date — not a transaction line' }); return; }
      if (/^(opening|closing) balance|^total|^grand total|^statement summary/i.test(description)) {
        skipped.push({ line, reason: 'Balance / total line' }); return;
      }
      const cr = money(r, 'credit');
      const dr = money(r, 'debit');
      let amount = null;
      let type = null;
      if (cr) { amount = Math.abs(cr); type = 'Credit'; } else if (dr) { amount = Math.abs(dr); type = 'Debit'; } else {
        const a = money(r, 'amount');
        if (a) {
          const marker = text(r, 'drcr').toLowerCase();
          amount = Math.abs(a);
          type = /^c|credit|deposit/.test(marker) ? 'Credit' : (/^d|debit|withdraw/.test(marker) ? 'Debit' : (a > 0 ? 'Credit' : 'Debit'));
        }
      }
      if (!amount) { skipped.push({ line, reason: 'No amount' }); return; }
      out.push({
        line, date: d, description: description || '—', reference: text(r, 'reference') || null, type, amount, balance: money(r, 'balance'),
      });
      return;
    }

    if (kind === 'expenses') {
      const gstRate = money(r, 'gstRate');
      const tdsRate = money(r, 'tdsRate');
      let gst = money(r, 'gst');
      const total = money(r, 'total');
      let base = money(r, 'base');
      if (base == null && total != null) {
        if (gst == null && gstRate != null) base = ROUND(total / (1 + gstRate / 100));
        else base = ROUND(total - (gst || 0));
      }
      if (gst == null && gstRate != null && base != null) gst = ROUND(base * gstRate / 100);
      if (gst == null && total != null && base != null && total > base) gst = ROUND(total - base);
      let tds = money(r, 'tds');
      if (tds == null && tdsRate != null && base != null) tds = ROUND(base * tdsRate / 100);
      const category = text(r, 'category');
      const vendor = text(r, 'vendor');
      if (!(base > 0)) {
        skipped.push({ line, reason: category || vendor ? 'No amount' : 'Blank or a total line' }); return;
      }
      if (!category && !vendor && !text(r, 'description')) { skipped.push({ line, reason: 'Nothing says what the bill was for' }); return; }
      if (/^(sub ?)?total|grand total/i.test(category || vendor)) { skipped.push({ line, reason: 'Total line' }); return; }
      const status = text(r, 'status').toLowerCase();
      out.push({
        line,
        expenseDate: date(r, 'date'),
        dueDate: date(r, 'dueDate'),
        category: category || 'Uncategorised',
        vendor: vendor || null,
        description: text(r, 'description') || null,
        billNumber: text(r, 'billNumber') || null,
        vendorGstin: text(r, 'vendorGstin') || null,
        location: text(r, 'location') || null,
        paymentMode: text(r, 'mode') || null,
        notes: text(r, 'notes') || null,
        base: ROUND(base),
        gst: ROUND(Math.abs(gst || 0)),
        tds: ROUND(Math.abs(tds || 0)),
        gstRatePct: gstRate,
        tdsRatePct: tdsRate,
        paidStatus: /unpaid|pending|due|not paid|outstanding/.test(status) ? 'Unpaid' : 'Paid',
      });
      return;
    }

    // invoices
    const client = text(r, 'client');
    const invoiceNumber = text(r, 'invoiceNumber');
    if (/^(sub ?)?total|grand total/i.test(client || invoiceNumber)) { skipped.push({ line, reason: 'Total line' }); return; }
    const gstRate = money(r, 'gstRate');
    const tdsRate = money(r, 'tdsRate');
    let gst = money(r, 'gst');
    const total = money(r, 'total');
    let amount = money(r, 'amount');
    if (amount == null && total != null) {
      if (gst != null) amount = ROUND(total - gst);
      else if (gstRate != null) amount = ROUND(total / (1 + gstRate / 100));
    }
    if (amount == null && total != null) amount = total; // GST worked out below from the client's rate
    if (!client && !invoiceNumber) { skipped.push({ line, reason: 'Blank line' }); return; }
    if (!(amount > 0)) { skipped.push({ line, reason: 'No amount' }); return; }
    const status = text(r, 'status').toLowerCase();
    out.push({
      line,
      invoiceNumber: invoiceNumber || null,
      client,
      candidate: text(r, 'candidate') || null,
      invoiceDate: date(r, 'invoiceDate'),
      dueDate: date(r, 'dueDate'),
      paidDate: date(r, 'paidDate'),
      amount: ROUND(amount),
      grossOnly: money(r, 'amount') == null && gst == null && gstRate == null && total != null,
      gst: gst == null ? null : ROUND(Math.abs(gst)),
      tds: money(r, 'tds') == null ? null : ROUND(Math.abs(money(r, 'tds'))),
      gstRatePct: gstRate,
      tdsRatePct: tdsRate,
      received: money(r, 'received'),
      status: /cancel/.test(status) ? 'Cancelled' : (/(^|\s)paid|received|settled|cleared/.test(status) && !/unpaid|part/.test(status) ? 'Paid' : null),
      notes: text(r, 'notes') || null,
    });
  });
  return { rows: out, skipped };
}

// --- clients (invoices) ----------------------------------------------------------

const SUFFIX = /\b(PVT|PRIVATE|LTD|LIMITED|LLP|INC|CO|COMPANY|CORP|CORPORATION|THE|INDIA)\b/g;
const clientKey = (s) => normName(s).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();

async function clientIndex() {
  const clients = await prisma.client.findMany({ select: { id: true, name: true, legalName: true, gstPercent: true, tdsPercent: true, paymentTerms: true } });
  const byKey = new Map();
  for (const c of clients) {
    [c.name, c.legalName].filter(Boolean).forEach((n) => { if (!byKey.has(clientKey(n))) byKey.set(clientKey(n), c); });
  }
  return byKey;
}

// --- one parse, shared by preview and commit --------------------------------------

async function parseUpload(req) {
  let upload;
  try {
    upload = await parseMultipart(req, { maxBytes: MAX_BYTES });
  } catch (err) {
    if (err.code === 'TOO_LARGE') return { status: 413, error: `The file is larger than ${MAX_BYTES / 1024 / 1024} MB. Split it and import the parts.` };
    if (err.code === 'NOT_MULTIPART') return { status: 400, error: 'Attach the file to import.' };
    throw err;
  }
  const { fields, file } = upload;
  if (!file || !file.data || !file.data.length) return { status: 400, error: 'Attach the file to import.' };

  const read = readGrid(file);
  if (read.error) return { status: 415, error: read.error };

  const wanted = KINDS[fields.kind] ? fields.kind : null;
  const kinds = wanted ? [wanted] : Object.keys(KINDS);

  // The sheet: the one asked for, or the one whose header fits best.
  let sheet = read.sheets.find((s) => s.name === fields.sheet);
  let header = sheet ? findHeader(sheet.rows, kinds) : null;
  if (!sheet) {
    let best = null;
    for (const s of read.sheets) {
      const h = findHeader(s.rows, kinds);
      if (!best || h.score > best.h.score) best = { s, h };
    }
    sheet = best.s;
    header = best.h;
  }
  if (header.index < 0) {
    return {
      status: 422,
      error: `No header row was found in "${sheet.name}". The sheet needs a row of column names — for example Date, Narration, Debit, Credit for a statement; Category, Vendor, Amount for expenses; Invoice No, Client, Amount for invoices.`,
      sheets: read.sheets.map((s) => s.name),
    };
  }
  const kind = wanted || header.kind;
  const heads = sheet.rows[header.index].map((h, i) => String(h == null || h === '' ? `Column ${i + 1}` : h).trim());
  let mapping = autoMap(kind, heads.map(headText));
  if (fields.mapping) {
    try {
      const given = JSON.parse(fields.mapping);
      if (given && typeof given === 'object') {
        mapping = { ...mapping };
        for (const [f] of FIELDS[kind]) {
          if (Array.isArray(given[f])) mapping[f] = given[f].map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < heads.length);
        }
      }
    } catch { /* a bad mapping falls back to the detected one */ }
  }
  const dataRows = sheet.rows.slice(header.index + 1);
  const exampleAt = heads.findIndex((h) => /^example\??$/i.test(String(h).trim()));
  const { rows, skipped } = normalise(kind, dataRows, { ...mapping, __example: exampleAt >= 0 ? [exampleAt] : [] });
  // Lines are numbered as the spreadsheet shows them.
  const offset = header.index + 1;
  rows.forEach((r) => { r.line += offset; });
  skipped.forEach((s) => { s.line += offset; });

  return {
    file, fields, kind, sheet: sheet.name, sheets: read.sheets.map((s) => s.name), headerRow: header.index + 1, heads, mapping, rows, skipped,
  };
}

async function allowed(user, kind) {
  const [feature, action] = KINDS[kind].perm;
  return can(user, 'accounts', 'accounts', feature, action);
}

function mappingView(kind, heads, mapping) {
  return FIELDS[kind].map(([field, label]) => ({
    field, label, numeric: NUMERIC.has(field), columns: mapping[field] || [], columnNames: (mapping[field] || []).map((i) => heads[i]),
  }));
}

function refuse(res, p) {
  return res.status(p.status).json({ error: p.error, sheets: p.sheets });
}

// --- preview ------------------------------------------------------------------------

router.post('/preview', async (req, res) => {
  const p = await parseUpload(req);
  if (p.error) return refuse(res, p);
  const permitted = await allowed(req.user, p.kind);

  const summary = { rows: p.rows.length, skipped: p.skipped.length };
  const problems = [];
  let clients = null;
  if (p.kind === 'bank') {
    const cr = p.rows.filter((r) => r.type === 'Credit');
    const dr = p.rows.filter((r) => r.type === 'Debit');
    Object.assign(summary, {
      credits: cr.length, creditValue: ROUND(cr.reduce((s, r) => s + r.amount, 0)),
      debits: dr.length, debitValue: ROUND(dr.reduce((s, r) => s + r.amount, 0)),
      from: p.rows.map((r) => r.date).sort()[0] || null, to: p.rows.map((r) => r.date).sort().pop() || null,
    });
    const accounts = await prisma.bankAccount.findMany({ where: { active: true }, select: { id: true, name: true, bank: true, accNo: true }, orderBy: { createdAt: 'asc' } });
    summary.bankAccounts = accounts;
  } else if (p.kind === 'expenses') {
    Object.assign(summary, {
      value: ROUND(p.rows.reduce((s, r) => s + r.base + r.gst, 0)),
      gst: ROUND(p.rows.reduce((s, r) => s + r.gst, 0)),
      undated: p.rows.filter((r) => !r.expenseDate).length,
      uncategorised: p.rows.filter((r) => r.category === 'Uncategorised').length,
    });
    if (summary.undated) problems.push(`${summary.undated} bill(s) have no date — they will be dated today.`);
    if (summary.uncategorised) problems.push(`${summary.uncategorised} bill(s) have no category — filed as "Uncategorised"; change them on the Office screen.`);
  } else {
    const index = await clientIndex();
    const unknown = [...new Set(p.rows.filter((r) => r.client && !index.has(clientKey(r.client))).map((r) => r.client))];
    const noClient = p.rows.filter((r) => !r.client).length;
    const numbers = p.rows.map((r) => r.invoiceNumber).filter(Boolean);
    const onFile = numbers.length
      ? (await prisma.invoice.findMany({ where: { invoiceNumber: { in: numbers } }, select: { invoiceNumber: true } })).length : 0;
    clients = { unknown, matched: [...new Set(p.rows.filter((r) => r.client && index.has(clientKey(r.client))).map((r) => r.client))].length };
    Object.assign(summary, {
      value: ROUND(p.rows.reduce((s, r) => s + r.amount, 0)),
      received: ROUND(p.rows.reduce((s, r) => s + (r.received || 0), 0)),
      alreadyOnFile: onFile,
      withoutNumber: p.rows.filter((r) => !r.invoiceNumber).length,
    });
    if (onFile) problems.push(`${onFile} invoice number(s) are already on file — those lines will be skipped, not overwritten.`);
    if (summary.withoutNumber) problems.push(`${summary.withoutNumber} line(s) have no invoice number — they will get the next number in the series.`);
    if (noClient) problems.push(`${noClient} line(s) name no client and will be skipped.`);
    if (unknown.length) problems.push(`${unknown.length} client name(s) are not on file: ${unknown.slice(0, 6).join(', ')}${unknown.length > 6 ? '…' : ''}.`);
    if (p.rows.some((r) => r.grossOnly)) problems.push('Some lines give only a total — it is taken as the amount before GST, and GST is added at the client\'s rate. Map "Amount before GST" if that is wrong.');
    if (!p.rows.some((r) => r.invoiceDate)) problems.push('No invoice date column was found — every invoice would be dated today. Map the date column below.');
  }

  res.json({
    file: p.file.filename,
    kind: p.kind,
    kindLabel: KINDS[p.kind].label,
    kinds: Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label })),
    permitted,
    sheet: p.sheet,
    sheets: p.sheets,
    headerRow: p.headerRow,
    columns: p.heads,
    mapping: mappingView(p.kind, p.heads, p.mapping),
    summary,
    problems,
    clients,
    sample: p.rows.slice(0, PREVIEW_ROWS),
    skippedSample: p.skipped.slice(0, 10),
  });
});

// --- commit ---------------------------------------------------------------------------

router.post('/commit', async (req, res) => {
  const p = await parseUpload(req);
  if (p.error) return refuse(res, p);
  if (!(await allowed(req.user, p.kind))) {
    return res.status(403).json({ error: `Your login cannot add ${KINDS[p.kind].label.toLowerCase()}.` });
  }
  if (!p.rows.length) return res.status(400).json({ error: 'No usable lines were found — check the column mapping.' });
  const opt = (k) => p.fields[k] === 'true' || p.fields[k] === '1' || p.fields[k] === 'yes';
  const who = req.user.name || req.user.email || 'Import';
  const fileName = String(p.file.filename || 'upload').slice(0, 200);

  if (p.kind === 'bank') {
    const out = await bankRoutes.importStatement(req, {
      rows: p.rows,
      bankAccountId: p.fields.bankAccountId || null,
      dedup: p.fields.dedup !== 'false',
      file: fileName,
      autoPost: p.fields.autoPost !== 'false',
    });
    return res.status(201).json({
      kind: 'bank', imported: out.imported, duplicates: out.duplicates, skippedLines: p.skipped.length, autoPosted: out.autoPosted, openingSetTo: out.openingSetTo, batch: out.batch,
      // Accounts S5 — the auto-match + proof summary.
      loansLinked: out.loansLinked, billsFiled: out.billsFiled, chargesFiled: out.chargesFiled, autoMatched: out.autoMatched, needsReview: out.needsReview,
    });
  }

  if (p.kind === 'expenses') {
    const existing = await prisma.officeExpense.findMany({ select: { expenseDate: true, category: true, vendor: true, monthlyAmount: true, billNumber: true } });
    const key = (e) => [e.expenseDate || '', String(e.category || '').toLowerCase(), String(e.vendor || '').toLowerCase(), Math.round(e.monthlyAmount), String(e.billNumber || '').toLowerCase()].join('|');
    const seen = new Set(existing.map(key));
    const today = new Date().toISOString().slice(0, 10);
    const MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card'];
    let imported = 0;
    let duplicates = 0;
    let value = 0;
    for (const r of p.rows) {
      const data = {
        category: r.category.slice(0, 120),
        vendor: r.vendor,
        description: r.description,
        billNumber: r.billNumber,
        vendorGstin: r.vendorGstin,
        location: r.location,
        notes: r.notes,
        expenseDate: r.expenseDate || today,
        dueDate: r.dueDate,
        monthlyAmount: ROUND(r.base + r.gst),
        gstAmount: r.gst,
        tdsAmount: Math.min(r.tds, ROUND(r.base + r.gst)),
        gstRatePct: r.gstRatePct,
        tdsRatePct: r.tdsRatePct,
        paidStatus: r.paidStatus,
        paymentMode: MODES.find((m) => m.toLowerCase() === String(r.paymentMode || '').toLowerCase()) || 'Bank Transfer',
        recurring: false,
        frequency: 'One-Time',
        remarks: `Imported from ${fileName}`,
        // Office & Expenses approval lifecycle: an imported bill that was
        // already paid is PAID; an unpaid one waits for approval.
        approvalStatus: r.paidStatus === 'Paid' ? 'PAID' : 'PENDING',
        createdById: req.user.id,
      };
      if (p.fields.dedup !== 'false' && seen.has(key(data))) { duplicates += 1; continue; }
      seen.add(key(data));
      await prisma.officeExpense.create({ data });
      // Keep the category list complete, so no imported bill is orphaned.
      await prisma.expenseCategory.upsert({
        where: { name: data.category }, create: { name: data.category, createdById: req.user.id }, update: {},
      }).catch(() => {});
      imported += 1;
      value = ROUND(value + data.monthlyAmount);
    }
    await logAudit({ userId: req.user.id, action: 'Office expenses imported', entity: 'OfficeExpense', entityId: fileName, toValue: `${imported} imported, ${duplicates} already on file` });
    return res.status(201).json({ kind: 'expenses', imported, duplicates, skippedLines: p.skipped.length, value });
  }

  // invoices
  const index = await clientIndex();
  const createClients = opt('createClients');
  const today = new Date().toISOString().slice(0, 10);
  const taken = new Set((await prisma.invoice.findMany({ select: { invoiceNumber: true } })).map((i) => i.invoiceNumber).filter(Boolean));
  let imported = 0;
  let duplicates = 0;
  let noClient = 0;
  let clientsCreated = 0;
  let paymentsRecorded = 0;
  for (const r of p.rows) {
    if (r.invoiceNumber && taken.has(r.invoiceNumber)) { duplicates += 1; continue; }
    if (!r.client) { noClient += 1; continue; }
    let client = index.get(clientKey(r.client));
    if (!client) {
      if (!createClients) { noClient += 1; continue; }
      client = await prisma.client.create({ data: { name: r.client.slice(0, 160) } });
      index.set(clientKey(r.client), client);
      clientsCreated += 1;
      await logAudit({ userId: req.user.id, action: 'Client added by invoice import', entity: 'Client', entityId: client.id, toValue: client.name });
    }
    const gstPct = r.gstRatePct != null ? r.gstRatePct : (client.gstPercent ?? 0);
    const tdsPct = r.tdsRatePct != null ? r.tdsRatePct : (client.tdsPercent ?? 0);
    const amount = r.grossOnly && gstPct ? ROUND(r.amount / (1 + gstPct / 100)) : r.amount;
    const invoiceDate = r.invoiceDate || today;
    const terms = client.paymentTerms || 'Net 30';
    const number = r.invoiceNumber || await invoiceRoutes.nextInvoiceNumber();
    taken.add(number);
    const gst = r.gst != null ? r.gst : ROUND(amount * gstPct / 100);
    // No TDS column: the client's standing rate — unless the sheet shows the
    // full amount incl. GST was received, which means no TDS was held back.
    let tds = r.tds != null ? r.tds : ROUND(amount * tdsPct / 100);
    if (r.tds == null && r.tdsRatePct == null && r.received > 0 && r.received >= ROUND(amount + gst) - 0.5) tds = 0;
    const data = {
      clientId: client.id,
      invoiceNumber: number,
      amount,
      gst,
      tds,
      gstPercent: gstPct,
      tdsPercent: tdsPct,
      invoiceDate,
      dueDate: r.dueDate || dueDateFor(invoiceDate, terms),
      paymentTerms: terms,
      notes: [r.candidate ? `Candidate: ${r.candidate}` : null, r.notes, `Imported from ${fileName}`].filter(Boolean).join(' · '),
    };
    const net = ROUND(data.amount + data.gst - data.tds);
    let received = r.received != null && r.received > 0 ? Math.min(ROUND(r.received), net) : 0;
    if (!received && r.status === 'Paid') received = net;
    const invoice = await prisma.invoice.create({ data: { ...data, status: 'Pending' } });
    if (received > 0) {
      const paidDate = r.paidDate || invoiceDate;
      await prisma.invoicePayment.create({
        data: {
          invoiceId: invoice.id, date: paidDate, amount: received, method: 'Imported', notes: `Receipt as recorded in ${fileName}`, recordedBy: who,
        },
      });
      paymentsRecorded += 1;
      invoice.receivedAmount = received;
      invoice.paidDate = received >= net - 0.5 ? paidDate : null;
    }
    const status = r.status === 'Cancelled' ? 'Cancelled' : deriveInvoiceStatus(invoice);
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { receivedAmount: invoice.receivedAmount || 0, paidDate: invoice.paidDate || null, status },
    });
    imported += 1;
  }
  await logAudit({
    userId: req.user.id, action: 'Invoices imported', entity: 'Invoice', entityId: fileName, toValue: `${imported} imported, ${duplicates} already on file, ${noClient} without a known client`,
  });
  return res.status(201).json({
    kind: 'invoices', imported, duplicates, noClient, clientsCreated, paymentsRecorded, skippedLines: p.skipped.length,
  });
});

module.exports = router;
