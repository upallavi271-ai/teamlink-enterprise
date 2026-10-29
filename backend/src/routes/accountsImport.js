const express = require('express');
const XLSX = require('xlsx');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { parseMultipart } = require('../utils/attachments');
const { ROUND, normName, dueDateFor, deriveInvoiceStatus } = require('../utils/accounts');
const bankRoutes = require('./bank');
const BIC = require('../utils/bankImportCore');
const SD = require('../utils/bankStatementDedupe');
const BF = require('../utils/bankFormat'); // which bank a statement file belongs to (2026-10-29)

// The bank a stored upload (batch) belongs to, read from its first row's own columns.
async function batchBank(batchId) {
  // a readable row keeps the bank's columns in "raw", an unreadable one in "row"
  const r = (await prisma.$queryRawUnsafe('SELECT "rowJson" FROM "BankStmtRow" WHERE "batchId" = ? AND ("rowJson" LIKE \'%"raw":{%\' OR "rowJson" LIKE \'%"row":{%\') LIMIT 1', batchId).catch(() => []))[0];
  let row = null;
  try { row = r ? JSON.parse(r.rowJson) : null; } catch { row = null; }
  return BF.bankOfColumns(Object.keys((row && (row.raw || row.row)) || {}));
}
async function bankVerdict(fileBank, accountId) {
  const accounts = await prisma.bankAccount.findMany({ select: { id: true, name: true, bank: true, accNo: true }, orderBy: { createdAt: 'asc' } });
  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  return BF.checkAccount(fileBank, account, accounts);
}
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
    // The TRANSACTION date wins over the value date; a value date is kept in its own field.
    ['date', 'Date', [/^(txn|tran|trans|transaction|posting|post|booking)\W*(date|dt)\b/, /^date\b/, /date|\bdt\b/]],
    ['valueDate', 'Value date', [/(value|val)\W*(date|dt)\b|^value\b/]],
    ['credit', 'Credit / deposit', [/deposit|credit|money in|cr amount|receipt/]],
    ['debit', 'Debit / withdrawal', [/withdraw|debit|money out|dr amount|payment/]],
    ['balance', 'Balance', [/balance|closing/]],
    ['drcr', 'Dr / Cr marker', [/^(dr ?\/? ?cr|cr ?\/? ?dr|type|txn type|d ?\/? ?c)$/]],
    ['amount', 'Amount (signed)', [/^amount|amount/]],
    ['externalId', 'Bank transaction id', [/^((bank|unique)\W+)?(txn|transaction|tran|trans)\W*(id|no|number)\b/, /^bank\W*(id|number)\b|\bunique\b.*(id|ref)|^serial|^s\.? ?no\.?$|^sr\W*no/]],
    ['reference', 'Reference / UTR / cheque', [/ref|utr|cheque|chq|instrument/]],
    ['description', 'Narration', [/narration|description|particular|remark|details/, /transaction(?!.*(date|dt|id|no|number))/]],
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
  const dateCols = ['date', 'valueDate', 'dueDate', 'invoiceDate', 'paidDate'].flatMap((f) => mapping[f] || []);
  const heads = mapping.__heads || [];
  const rawOf = (r) => {
    const o = {};
    r.forEach((c, i) => { o[String(heads[i] || `column ${i + 1}`)] = c == null ? '' : c; });
    return o;
  };
  const failed = []; // bank rows that look like a transaction but cannot be used
  const stated = {}; // opening / closing balance printed in the file itself
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
      const cr = money(r, 'credit');
      const dr = money(r, 'debit');
      const signed = money(r, 'amount');
      const hasMoney = !!(cr || dr || signed);
      const anyText = r.map((c) => String(c == null ? '' : c)).join(' ');
      const balLine = /^(opening|closing) balance/i.exec(description) || /^\s*(opening|closing) balance/i.exec(anyText);
      if (balLine) {
        const v = money(r, 'balance') != null ? money(r, 'balance') : (cr || dr || signed || null);
        if (v != null) stated[/^opening/i.test(balLine[0]) ? 'opening' : 'closing'] = v;
        skipped.push({ line, reason: 'Balance / total line' });
        return;
      }
      if (/^total|^grand total|^statement summary/i.test(description)) { skipped.push({ line, reason: 'Balance / total line' }); return; }
      if (!d) {
        skipped.push({ line, reason: 'No date — not a transaction line' });
        // A line with money on it but no readable date is a transaction we could not read: report it.
        if (hasMoney) failed.push({ line, reason: `No usable date (${String(r[(mapping.date || [])[0]] ?? '').trim() || 'blank'})`, row: rawOf(r) });
        return;
      }
      let amount = null;
      let type = null;
      if (cr && dr) { skipped.push({ line, reason: 'Both a debit and a credit amount' }); failed.push({ line, reason: 'Both a debit and a credit amount on one line', row: rawOf(r) }); return; }
      if (cr) { amount = Math.abs(cr); type = 'Credit'; } else if (dr) { amount = Math.abs(dr); type = 'Debit'; } else if (signed) {
        const marker = text(r, 'drcr').toLowerCase();
        amount = Math.abs(signed);
        type = /^c|credit|deposit/.test(marker) ? 'Credit' : (/^d|debit|withdraw/.test(marker) ? 'Debit' : (signed > 0 ? 'Credit' : 'Debit'));
      }
      if (!amount) { skipped.push({ line, reason: 'No amount' }); failed.push({ line, reason: 'No amount', row: rawOf(r) }); return; }
      out.push({
        line,
        date: d,
        valueDate: date(r, 'valueDate'),
        description: description || '—',
        reference: text(r, 'reference') || null,
        externalId: text(r, 'externalId') || null,
        type,
        amount,
        balance: money(r, 'balance'),
        raw: rawOf(r),
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
  return { rows: out, skipped, failed, stated };
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
  // The client's OLD names (ClientAlias: merged-away spellings, the name before it was renamed to the official one): a sheet that still
  // says "VCare" lands on "Prabs VCare Health Clinic" instead of creating a second client. Official names always win a clash.
  const oldNames = await require('../utils/clientSearch').aliasMap(); // eslint-disable-line global-require
  const byId = new Map(clients.map((c) => [c.id, c]));
  oldNames.forEach((list, clientId) => {
    const c = byId.get(clientId);
    if (c) list.forEach((a) => { const k = clientKey(a); if (k && !byKey.has(k)) byKey.set(k, c); });
  });
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
  return analyseFile(file, fields);
}

// The reading of one uploaded file (shared with scripts/recon-narration-repair.js,
// which re-reads original statements without any HTTP request).
function analyseFile(file, fields) {
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
  const {
    rows, skipped, failed, stated,
  } = normalise(kind, dataRows, { ...mapping, __example: exampleAt >= 0 ? [exampleAt] : [], __heads: heads });
  // Lines are numbered as the spreadsheet shows them.
  const offset = header.index + 1;
  rows.forEach((r) => { r.line += offset; });
  skipped.forEach((s) => { s.line += offset; });
  (failed || []).forEach((f) => { f.line += offset; });

  return {
    file, fields, kind, sheet: sheet.name, sheets: read.sheets.map((s) => s.name), headerRow: header.index + 1, heads, mapping, rows, skipped, failed: failed || [], stated: stated || {},
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
    // Duplicate check (utils/bankStatementDedupe.js): EVERY row is compared with every line already on the account
    // and with the other rows of this file. The rows and their statuses are kept on the server as a "Preview" batch
    // (no bank line is written) so the import acts on exactly what was shown.
    let prep;
    if (permitted) {
      prep = await bankRoutes.prepareStatement(req, {
        rows: p.rows, bankAccountId: p.fields.bankAccountId || null, file: p.file.filename, failedRows: p.failed || [], stated: p.stated || {}, sourceHash: BIC.sha256(p.file.data), sheet: p.sheet,
      });
      summary.stmt = { batchId: prep.batchId, accountId: prep.account.id, counts: prep.counts };
      // 2026-10-29: whose statement is it? An ICICI file going into the HDFC account (or the reverse) is said before anything is saved
      summary.bankCheck = BF.checkAccount(BF.bankOfColumns(p.heads), accounts.find((a) => a.id === prep.account.id) || prep.account, accounts);
      if (!summary.bankCheck.ok) problems.push(summary.bankCheck.message);
    } else {
      // a login that may not import still sees what the file contains (counts only, nothing stored)
      const accounts = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true } });
      const accId = p.fields.bankAccountId || (accounts[0] && accounts[0].id);
      const v0 = BIC.validateRows(p.rows);
      const ordered = [...v0.ok].sort((a, b) => (a.line || 0) - (b.line || 0));
      const cls = SD.classifyRows(ordered, accId ? await SD.loadExisting(accId, accounts[0].id) : []);
      const n = (st) => cls.filter((c) => c.status === st).length;
      prep = {
        failed: [...(p.failed || []), ...v0.failed], balanceCheck: BIC.checkBalances(v0.ok, p.stated || {}), fileAlreadyImported: null,
        counts: {
          total: ordered.length + (p.failed || []).length + v0.failed.length, alreadyImported: n(SD.STATUS.AI), notImported: n(SD.STATUS.NI), duplicateInUpload: n(SD.STATUS.DUP), needsReview: n(SD.STATUS.NR), newlyImported: 0, failed: (p.failed || []).length + v0.failed.length,
        },
      };
    }
    const failedAll = prep.failed;
    const c = prep.counts;
    Object.assign(summary, {
      failed: failedAll.length, duplicates: c.alreadyImported + c.duplicateInUpload, newLines: c.notImported, needsReview: c.needsReview,
      alreadyImported: c.alreadyImported, duplicateInUpload: c.duplicateInUpload, total: c.total,
    });
    summary.failedRows = failedAll.slice(0, 100);
    summary.balanceCheck = prep.balanceCheck;
    summary.fileAlreadyImported = prep.fileAlreadyImported;
    const prior = prep.fileAlreadyImported;
    if (failedAll.length) problems.push(`${failedAll.length} row(s) cannot be imported - they are listed below with the reason.`);
    if (c.alreadyImported) problems.push(`${c.alreadyImported} transaction(s) are already imported and will be skipped.`);
    if (c.duplicateInUpload) problems.push(`${c.duplicateInUpload} row(s) repeat another row of this same file and will be skipped (you can choose to import one anyway if it is a real second transaction).`);
    if (c.needsReview) problems.push(`${c.needsReview} row(s) need your review - they look like a transaction already on file but not exactly. Choose Import or Leave out for each.`);
    if (prior) problems.push(`This exact file was imported on ${prior.on}.`);
    if (summary.balanceCheck.checked && summary.balanceCheck.ok === false) problems.push('The statement balances do not tie (see the balance check).');
  } else if (p.kind === 'expenses') {
    Object.assign(summary, {
      value: ROUND(p.rows.reduce((s, r) => s + r.base + r.gst, 0)),
      gst: ROUND(p.rows.reduce((s, r) => s + r.gst, 0)),
      undated: p.rows.filter((r) => !r.expenseDate).length,
      uncategorised: p.rows.filter((r) => r.category === 'Uncategorised').length,
    });
    if (summary.undated) problems.push(`${summary.undated} bill(s) have no date - they will NOT be imported (no date is ever made up). Add the date column, or tick "date them today" if you really want that.`);
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
    const undatedInv = p.rows.filter((r) => !r.invoiceDate).length;
    summary.undatedInvoices = undatedInv;
    if (undatedInv) problems.push(`${undatedInv} invoice line(s) have no invoice date - they will NOT be imported (no date is ever made up). Map the date column below.`);
    const noPaidOn = p.rows.filter((r) => (r.received > 0 || r.status === 'Paid') && !r.paidDate).length;
    summary.receiptsWithoutDate = noPaidOn;
    if (noPaidOn) problems.push(`${noPaidOn} invoice(s) show money received but no "paid on" date - the amount is kept and the payment date is left blank (not guessed). Map the paid-on column if the sheet has one.`);
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

// --- bank statement batches (duplicate check + selective import) -------------------------------
//
// preview stores the uploaded rows with their statuses on the server (a "Preview" batch). Everything below acts on
// that stored batch, never on rows sent back by the browser, and needs the same permission as importing a statement.
//   GET  /bank-batch/:id             the counts for the Statements Matching strip + batch facts
//   GET  /bank-batch/:id/rows        the list (filter = a status, page, limit)
//   POST /bank-batch/:id/check       look again (the account was changed, or lines were added meanwhile)
//   POST /bank-batch/:id/plan        a person's choice per row: import this one anyway / leave it out
//   POST /bank-batch/:id/import      Import New Transactions (only "Not Imported" + the rows a person chose)
//   POST /bank-batch/:id/retry       Retry failed (only the rows that failed)
//   GET  /bank-batches               the upload history
async function needBank(req, res, next) {
  try {
    if (!(await allowed(req.user, 'bank'))) return res.status(403).json({ error: 'Your login cannot import bank statements.' });
    return next();
  } catch (e) { return res.status(500).json({ error: 'Could not check your permission.' }); }
}
const batchGuard = (fn) => async (req, res) => {
  try { return await fn(req, res); } catch (e) {
    console.error('[bank-batch]', e); // eslint-disable-line no-console
    return res.status(500).json({ error: 'That did not work and nothing was lost. Please try again.', detail: String(e && e.message).slice(0, 300) });
  }
};
const batchFacts = (b) => ({
  id: b.id, file: b.file, bankAccountId: b.bankAccountId, status: b.status, uploadedBy: b.uploadedByName, uploadedAt: b.createdAt, lastRunAt: b.lastRunAt, importId: b.importId, runs: b.runs,
});

router.get('/bank-batches', needBank, batchGuard(async (req, res) => {
  res.json({ batches: (await SD.recentBatches(req.query.bankAccountId || null, 30)).map((b) => ({ ...batchFacts(b), counts: b.counts })) });
}));

router.get('/bank-batch/:id', needBank, batchGuard(async (req, res) => {
  const b = await SD.getBatch(req.params.id);
  if (!b) return res.status(404).json({ error: 'That upload is no longer available. Choose the file again.' });
  res.json({ batch: batchFacts(b), counts: await SD.countsOf(b.id) });
}));

router.get('/bank-batch/:id/rows', needBank, batchGuard(async (req, res) => {
  const b = await SD.getBatch(req.params.id);
  if (!b) return res.status(404).json({ error: 'That upload is no longer available. Choose the file again.' });
  res.json(await SD.listRows(b.id, { filter: String(req.query.filter || ''), page: req.query.page, limit: req.query.limit }));
}));

router.post('/bank-batch/:id/check', needBank, batchGuard(async (req, res) => {
  const accounts = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  const firstId = accounts[0] && accounts[0].id;
  const b = await SD.getBatch(req.params.id);
  if (!b) return res.status(404).json({ error: 'That upload is no longer available. Choose the file again.' });
  const accountId = req.body?.bankAccountId || b.bankAccountId || firstId;
  if (!accounts.some((a) => a.id === accountId)) return res.status(400).json({ error: 'Choose a bank account from the list.' });
  const out = await SD.recheck(b.id, { accountId, firstId });
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  return res.json({ counts: out.counts, bankCheck: await bankVerdict(await batchBank(b.id), accountId) });
}));

router.post('/bank-batch/:id/plan', needBank, batchGuard(async (req, res) => {
  const b = await SD.getBatch(req.params.id);
  if (!b) return res.status(404).json({ error: 'That upload is no longer available. Choose the file again.' });
  const list = Array.isArray(req.body?.decisions) ? req.body.decisions.slice(0, 5000) : [];
  const out = await SD.setDecisions(b.id, list);
  return res.json({ set: out.set, refused: out.refused, counts: out.counts });
}));

const runBatchRoute = (mode) => batchGuard(async (req, res) => {
  // 2026-10-29: a statement of one bank is not saved into another bank's account unless the person confirmed it
  if (!(req.body && req.body.confirmOtherBank === true)) {
    const b = await SD.getBatch(req.params.id);
    const v = b ? await bankVerdict(await batchBank(b.id), req.body?.bankAccountId || b.bankAccountId) : { ok: true };
    if (!v.ok) return res.status(409).json({ error: v.message, code: 'BANK_MISMATCH', bankCheck: v });
  }
  const out = await bankRoutes.importBatch(req, {
    batchId: req.params.id, mode, bankAccountId: req.body?.bankAccountId || null, autoPost: req.body?.autoPost !== false && req.body?.autoPost !== 'false',
  });
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  return res.status(201).json({
    kind: 'bank', imported: out.imported, duplicates: out.duplicates, failed: out.failed, failedRows: out.failedRows, summary: out.summary, stmt: out.stmt, uploadBatchId: out.uploadBatchId, mode,
    balanceCheck: out.balanceCheck, fileAlreadyImported: out.fileAlreadyImported, duplicateRows: out.duplicateRows, autoPosted: out.autoPosted, openingSetTo: out.openingSetTo, batch: out.batch,
    suggested: out.suggested, autoReconcileOn: out.autoReconcileOn, loansLinked: out.loansLinked, billsFiled: out.billsFiled, chargesFiled: out.chargesFiled, autoMatched: out.autoMatched, needsReview: out.needsReview,
    existedWhileSaving: out.existedWhileSaving,
  });
});
router.post('/bank-batch/:id/import', needBank, runBatchRoute('new'));
router.post('/bank-batch/:id/retry', needBank, runBatchRoute('retry'));

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
    if (!opt('confirmOtherBank')) { // 2026-10-29: not into another bank's account without a yes
      const v = await bankVerdict(BF.bankOfColumns(p.heads), p.fields.bankAccountId || null);
      if (!v.ok) return res.status(409).json({ error: v.message, code: 'BANK_MISMATCH', bankCheck: v });
    }
    // One step: classify (against every line on the account), then save ONLY the "Not Imported" rows.
    // A row that is a repeat or "Needs Review" is saved only when its row number is listed in "decisions" with 'import'.
    let decisions = null;
    try { decisions = p.fields.decisions ? JSON.parse(p.fields.decisions) : null; } catch { decisions = null; }
    let out;
    try {
      out = await bankRoutes.importStatement(req, {
        rows: p.rows,
        bankAccountId: p.fields.bankAccountId || null,
        file: fileName,
        autoPost: p.fields.autoPost !== 'false',
        failedRows: p.failed || [],
        stated: p.stated || {},
        sourceHash: BIC.sha256(p.file.data),
        decisions: Array.isArray(decisions) ? decisions : null,
      });
    } catch (err) {
      return res.status(500).json({ error: 'The import did not finish. Lines already saved are never duplicated - run it again.', detail: err.message });
    }
    // Auto-Reconcile: keep the uploaded statement itself for audit (never blocks the import).
    try { if (out.batch && bankRoutes.autoApi) await bankRoutes.autoApi.saveOriginal(out.batch, fileName, p.file.data); } catch (e) { console.error('[bank] original statement not kept:', e.message); } // eslint-disable-line no-console
    return res.status(201).json({
      kind: 'bank', imported: out.imported, duplicates: out.duplicates, failed: out.failed, failedRows: out.failedRows, summary: out.summary, stmt: out.stmt, uploadBatchId: out.uploadBatchId,
      balanceCheck: out.balanceCheck, fileAlreadyImported: out.fileAlreadyImported, duplicateRows: out.duplicateRows,
      skippedLines: p.skipped.length, autoPosted: out.autoPosted, openingSetTo: out.openingSetTo, batch: out.batch,
      // Accounts S5 — the auto-match + proof summary.
      suggested: out.suggested, autoReconcileOn: out.autoReconcileOn, loansLinked: out.loansLinked, billsFiled: out.billsFiled, chargesFiled: out.chargesFiled, autoMatched: out.autoMatched, needsReview: out.needsReview,
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
    let noDate = 0;
    const undatedRows = [];
    for (const r of p.rows) {
      // Spec 7: an expense with no date is not given the import day.
      if (!r.expenseDate && !opt('allowTodayDate')) { noDate += 1; undatedRows.push({ line: r.line, reason: 'No bill date', row: { category: r.category, vendor: r.vendor, base: r.base } }); continue; }
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
    await logAudit({ userId: req.user.id, action: 'Office expenses imported', entity: 'OfficeExpense', entityId: fileName, toValue: `${imported} imported, ${duplicates} already on file, ${noDate} without a date (not imported)` });
    return res.status(201).json({
      kind: 'expenses', imported, duplicates, noDate, failedRows: undatedRows.slice(0, 100), skippedLines: p.skipped.length, value,
    });
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
  let noDate = 0;
  let receiptsUndated = 0;
  const undatedRows = [];
  for (const r of p.rows) {
    if (r.invoiceNumber && taken.has(r.invoiceNumber)) { duplicates += 1; continue; }
    if (!r.client) { noClient += 1; continue; }
    // Spec 7: no invoice date is ever made up.
    if (!r.invoiceDate && !opt('allowTodayDate')) { noDate += 1; undatedRows.push({ line: r.line, reason: 'No invoice date', row: { invoiceNumber: r.invoiceNumber, client: r.client, amount: r.amount } }); continue; }
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
    const number = r.invoiceNumber || await invoiceRoutes.numberForNewInvoice(client.id, invoiceDate);
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
      invoice.receivedAmount = received;
      if (r.paidDate) {
        await prisma.invoicePayment.create({
          data: {
            invoiceId: invoice.id, date: r.paidDate, dateSource: 'sheet', amount: received, method: 'Imported', notes: `Receipt as recorded in ${fileName}`, recordedBy: who,
          },
        });
        paymentsRecorded += 1;
        invoice.paidDate = received >= net - 0.5 ? r.paidDate : null;
      } else {
        // The sheet gives the amount but not the day: keep the amount on the
        // invoice (as older imports did) and leave the payment date blank.
        receiptsUndated += 1;
        invoice.paidDate = null;
      }
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
    kind: 'invoices', imported, duplicates, noClient, noDate, receiptsUndated, failedRows: undatedRows.slice(0, 100), clientsCreated, paymentsRecorded, skippedLines: p.skipped.length,
  });
});

router.analyseFile = analyseFile;
module.exports = router;
