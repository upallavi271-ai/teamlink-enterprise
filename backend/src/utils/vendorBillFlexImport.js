// ---------------------------------------------------------------------------
// BILL IMPORT FROM ANY EXCEL / CSV FILE (founder 2026-10-28: "alanti file upload chesina tisukovali, rules undakudadhu").
//
// The vendor's bill imports (Airtel bills, finance invoices) no longer need the sample file: ANY .xlsx / .xls / .csv is read.
//   * the header row is FOUND (any of the first 25 rows) by the names people really use: "Invoice No", "Bill No.", "Bill Date",
//     "Due Date", "Amount", "Total", "Net Payable", "GST", "Tax", "Month", "Billing Period", "Remarks", "Particulars" ... in any order,
//     extra columns are simply ignored;
//   * formulas are never run: the value Excel saved with the file is used;
//   * dates in any usual shape (2026-10-05, 05/10/2026, 05-10-2026, 5 Oct 2026, Excel day numbers), amounts like "Rs. 1,234.50";
//   * a line without any amount (a blank line, a heading, a "Total" line) is skipped, never an error.
// What the bill rules still need is FILLED from the same line, never invented: no bill number -> "ROW-<line>" with a note; no billing
// month -> the month of the bill date / due date; no bill date -> today. The due date stays empty when the file has none.
// Pure: no database. vendorImport.js uses it for the 'bills' imports.
// ---------------------------------------------------------------------------
const XLSX = require('xlsx');

const ALIASES = {
  billNumber: ['bill no', 'bill number', 'bill num', 'billno', 'invoice no', 'invoice number', 'invoice num', 'inv no', 'inv number', 'invoice', 'bill', 'bill id', 'invoice id', 'reference', 'ref no', 'document no', 'voucher no'],
  period: ['billing month', 'bill month', 'month', 'period', 'billing period', 'bill period', 'for the month', 'service month'],
  billDate: ['bill date', 'invoice date', 'date', 'inv date', 'billed on', 'document date', 'issue date'],
  dueDate: ['due date', 'due', 'pay by', 'payment due', 'due on', 'last date', 'last date of payment', 'pay before'],
  amount: ['amount', 'bill amount', 'invoice amount', 'total', 'total amount', 'net amount', 'net payable', 'amount payable', 'payable', 'grand total', 'charges', 'value', 'taxable value', 'taxable amount', 'sub total', 'subtotal', 'amount before tax'],
  gst: ['gst', 'gst amount', 'tax', 'tax amount', 'igst', 'total tax', 'gst value'],
  remarks: ['remarks', 'remark', 'notes', 'note', 'description', 'particulars', 'details', 'comments', 'narration'],
};
// When a sheet has both "Amount" (before tax) and "Total", the amount before tax wins and GST is the difference.
const BEFORE_TAX = ['amount', 'bill amount', 'invoice amount', 'taxable value', 'taxable amount', 'sub total', 'subtotal', 'amount before tax', 'charges', 'value'];
const WITH_TAX = ['total', 'total amount', 'grand total', 'net amount', 'net payable', 'amount payable', 'payable'];

const clean = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const str = (v) => (v == null ? '' : String(v).trim());

function columnsOf(row) {
  const map = {}; const used = new Set();
  // exact alias first, then "starts with" (e.g. "Amount (Rs)" -> amount)
  for (const pass of ['exact', 'start']) {
    row.forEach((cell, i) => {
      const h = clean(cell);
      if (!h || used.has(i)) return;
      // the LONGEST name that fits wins ("bill date (dd/mm)" is a bill date, not a bill number)
      let best = null;
      for (const [key, names] of Object.entries(ALIASES)) {
        if (map[key] !== undefined) continue; // eslint-disable-line no-continue
        for (const n of names) {
          const hit = pass === 'exact' ? h === n : h.startsWith(`${n} `);
          if (hit && (!best || n.length > best.len)) best = { key, len: n.length };
        }
      }
      if (best) { map[best.key] = i; used.add(i); }
    });
  }
  // THE AMOUNT: a before-tax column ("Amount (Rs)", "Taxable value") wins over a with-tax one ("Total", "Net payable"); when both are there,
  // the with-tax one is kept as "total" (GST = the difference). Decided here over the whole row, whatever pass first took a column.
  const fits = (c, names) => { const h = clean(c); return names.some((n) => h === n || h.startsWith(`${n} `)); };
  const before = row.findIndex((c, i) => fits(c, BEFORE_TAX) && (map.gst === undefined || map.gst !== i));
  const withTax = row.findIndex((c, i) => i !== before && fits(c, WITH_TAX));
  if (before >= 0 || withTax >= 0) {
    if (map.amount !== undefined && map.amount !== before && map.amount !== withTax) used.delete(map.amount);
    map.amount = before >= 0 ? before : withTax;
    if (before >= 0 && withTax >= 0) map.total = withTax; else delete map.total;
    ['billNumber', 'period', 'billDate', 'dueDate', 'gst', 'remarks'].forEach((k) => { if (map[k] === map.amount || map[k] === map.total) delete map[k]; });
  }
  return map;
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = str(v).replace(/^(rs\.?|inr|₹)\s*/i, '').replace(/[,\s]/g, '').replace(/\/-$/, '').replace(/^\((.*)\)$/, '-$1');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const realDay = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null; };
function toDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) { const p = XLSX.SSF.parse_date_code(v); return p ? realDay(p.y, p.m, p.d) : null; }
  const s = str(v);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return realDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s); // Indian order: day first
  if (m) return realDay(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s,-]+(\d{2,4})$/i.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return realDay(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^([a-z]{3})[a-z]*[\s-]+(\d{1,2}),?[\s-]+(\d{4})$/i.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return realDay(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}
function toPeriod(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = toDate(v); return d ? d.slice(0, 7) : null; }
  const s = str(v);
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad(+m[2])}`;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${pad(+m[1])}`;
  m = /^([a-z]{3})[a-z]*[\s'-]*(\d{2,4})$/i.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2].length === 2 ? 2000 + +m[2] : m[2]}-${pad(MONTHS[m[1].toLowerCase()])}`;
  const d = toDate(v);
  return d ? d.slice(0, 7) : null;
}

// buffer + file name -> { rows: [{ line, billNumber, period, billDate, dueDate, amount, gst, remarks, notes: [] }], skipped, header: {...} }
// Throws { status, message } only when the file cannot be opened at all, or no amount column exists in any of its sheets.
function readAny(buffer, fileName, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const name = String(fileName || '');
  if (!/\.(xlsx|xls|csv)$/i.test(name)) throw Object.assign(new Error('Choose an Excel file (.xlsx or .xls) or a CSV file.'), { status: 400 });
  let wb;
  try {
    wb = /\.csv$/i.test(name) ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true }) : XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, bookVBA: false });
  } catch { throw Object.assign(new Error('That file could not be opened. Save it again from Excel and try once more.'), { status: 400 }); }
  for (const sheetName of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: true });
    let headerAt = -1; let cols = null; let best = 0;
    for (let i = 0; i < Math.min(grid.length, 25); i += 1) {
      const c = columnsOf(grid[i] || []);
      const n = Object.keys(c).length;
      if (c.amount !== undefined && n > best) { best = n; headerAt = i; cols = c; }
    }
    if (headerAt < 0) continue; // eslint-disable-line no-continue
    const rows = []; let skipped = 0;
    for (let i = headerAt + 1; i < grid.length; i += 1) {
      const r = grid[i] || [];
      const cell = (k) => (cols[k] === undefined ? '' : r[cols[k]]);
      let amount = toNumber(cell('amount'));
      let gst = toNumber(cell('gst'));
      const total = cols.total !== undefined ? toNumber(r[cols.total]) : null;
      if ((amount == null || amount === 0) && total) amount = total; // only a total on this line
      else if (gst == null && total != null && amount != null && total > amount) gst = Math.round((total - amount) * 100) / 100;
      const labelText = clean(cell('billNumber') || cell('remarks'));
      if (!(amount > 0) || /^(grand )?total\b|^sub ?total\b/.test(labelText)) { if (r.some((x) => str(x))) skipped += 1; continue; } // eslint-disable-line no-continue
      const notes = [];
      const line = i + 1;
      let billNumber = str(cell('billNumber')).slice(0, 60);
      if (!billNumber) { billNumber = `ROW-${line}`; notes.push('no bill number in the file'); }
      const billDate = toDate(cell('billDate')) || null;
      const dueDate = toDate(cell('dueDate')) || null;
      const period = toPeriod(cell('period')) || (billDate ? billDate.slice(0, 7) : null) || (dueDate ? dueDate.slice(0, 7) : null) || today.slice(0, 7);
      if (!cols.period && !billDate && !dueDate) notes.push('billing month taken as this month');
      rows.push({ line, billNumber, period, billDate: billDate || today, billDateMissing: !billDate, dueDate, amount: Math.round(amount * 100) / 100, gst: gst != null && gst >= 0 ? gst : 0, remarks: str(cell('remarks')).slice(0, 900), notes });
    }
    return { rows, skipped, sheet: sheetName, header: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, str((grid[headerAt] || [])[i])])) };
  }
  throw Object.assign(new Error('No column with the amount was found in this file. Add a column named "Amount" (or "Total") next to each bill and try again.'), { status: 400 });
}

module.exports = { readAny, columnsOf, toDate, toPeriod, toNumber, ALIASES };
