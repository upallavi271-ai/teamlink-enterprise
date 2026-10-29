// ---------------------------------------------------------------------------
// "IMPORT BILLS" FROM THE PROVIDER'S OWN PDF BILL (founder 2026-10-28: Airtel Bills portal - "aa file upload chesina adhi tisukovali").
// The Airtel bill PDF (one bill or many, one after another) becomes the same rows an Excel line becomes (utils/vendorBillFlexImport.js
// shape), so it goes through the SAME preview -> confirm -> duplicate checks -> Accounts review as every other import, and the PDF is
// attached to each bill as its copy.
//   1. the PDF's own text (pdf-parse - no AI, no cost): pages are grouped by the bill number printed on them; on each bill the values
//      are found by the labels printed beside them (Bill No. / Invoice No., Bill Date, Bill Period / Billing Cycle, Due Date / Pay by,
//      Total Amount Payable / Amount Due / Net Payable, CGST + SGST / IGST / Total Tax). Amount before tax = total - GST.
//   2. a scanned PDF (no text inside): read by the AI bill reader (utils/billOcr) when Accounts has switched it on; otherwise a plain
//      message says so. Nothing is ever guessed: what is not on the bill stays empty (a missing due date is set by Accounts) and is
//      written in the line's notes.
// ---------------------------------------------------------------------------
const F = require('./vendorBillFlexImport');

const SEP = '[\\s:.#\\-–]{0,8}';
const DATE = '(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{1,2}[\\s-]+[A-Za-z]{3,9}[\\s,-]+\\d{2,4}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4})';
const MONEY = '(?:Rs\\.?|₹|INR)?\\s*([\\d,]+\\.\\d{1,2}|[\\d,]{2,})';
const rx = (src) => new RegExp(src, 'i');
const LABEL = {
  billNo: rx(`\\b(?:bill|invoice)\\s*(?:no\\.?|number|num)${SEP}([A-Z0-9][A-Z0-9/\\-]{3,30})`),
  billDate: rx(`\\b(?:bill|invoice)\\s*date${SEP}${DATE}`),
  dueDate: rx(`\\b(?:due\\s*date|pay\\s*by|payment\\s*due(?:\\s*date)?|last\\s*date(?:\\s*(?:of|for)\\s*payment)?)${SEP}${DATE}`),
  periodRange: rx(`\\b(?:bill(?:ing)?\\s*(?:period|cycle)|period)${SEP}${DATE}\\s*(?:to|till|-|–)\\s*${DATE}`),
  periodMonth: rx('\\bbill(?:ing)?\\s*(?:period|month|cycle)[\\s:.\\-–]{0,8}([A-Za-z]{3,9}[\\s\'-]*\\d{2,4})'),
  account: rx('\\b(?:account|a/c|relationship)\\s*(?:no\\.?|number|id)[\\s:.#\\-–]{0,8}([A-Z0-9][A-Z0-9\\-]{3,30})'),
};
// the bill's total, strongest wording first (the amount actually payable for this bill)
const TOTALS = ['total\\s*amount\\s*payable', 'amount\\s*payable', 'total\\s*payable', 'net\\s*(?:amount\\s*)?payable', 'total\\s*amount\\s*due', 'amount\\s*due', 'grand\\s*total', 'invoice\\s*total', 'total\\s*amount']
  .map((l) => rx(`\\b${l}${SEP}${MONEY}`));
const TAX = {
  cgst: rx('\\bcgst\\b[^\\n\\d]{0,30}(?:@?\\s*[\\d.]+\\s*%[^\\n\\d]{0,12})?([\\d,]+\\.\\d{2})'),
  sgst: rx('\\b(?:sgst|utgst)\\b[^\\n\\d]{0,30}(?:@?\\s*[\\d.]+\\s*%[^\\n\\d]{0,12})?([\\d,]+\\.\\d{2})'),
  igst: rx('\\bigst\\b[^\\n\\d]{0,30}(?:@?\\s*[\\d.]+\\s*%[^\\n\\d]{0,12})?([\\d,]+\\.\\d{2})'),
  total: rx('\\b(?:total\\s*(?:tax|gst)|gst\\s*amount|tax\\s*amount)[\\s:.\\-–]{0,8}(?:Rs\\.?|₹|INR)?\\s*([\\d,]+\\.\\d{1,2})'),
};
const MOBILE = /\b(?:mobile|phone|service)\s*(?:no\.?|number)[\s:.#\-–]{0,8}(\+?\d[\d\s-]{8,14}\d)/i;

const first = (re, text) => { const m = re.exec(text); return m ? m : null; };
const money = (s) => { const n = F.toNumber(s); return n == null ? null : Math.round(n * 100) / 100; };
const isPdf = (buffer, fileName) => /\.pdf$/i.test(String(fileName || '')) || (Buffer.isBuffer(buffer) && buffer.slice(0, 5).toString('latin1') === '%PDF-');

// The text of each page.
async function pagesOf(buffer) {
  const { PDFParse } = require('pdf-parse'); // eslint-disable-line global-require
  const p = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const r = await Promise.race([p.getText(), new Promise((_, rej) => setTimeout(() => rej(new Error('The PDF took too long to read.')), 20000))]);
    if (r && Array.isArray(r.pages) && r.pages.length) return r.pages.map((x) => String((x && x.text) || ''));
    return String((r && r.text) || '').split('\f');
  } finally { try { await p.destroy(); } catch { /* ignore */ } }
}

// One bill's text -> a row (what is not printed stays empty and is noted).
function billFrom(text, line, today) {
  const notes = [];
  const bn = first(LABEL.billNo, text);
  const billNumber = bn && /\d/.test(bn[1]) ? bn[1].replace(/[-/]+$/, '') : null;
  const bd = first(LABEL.billDate, text);
  const billDate = bd ? F.toDate(bd[1]) : null;
  const dd = first(LABEL.dueDate, text);
  const dueDate = dd ? F.toDate(dd[1]) : null;
  let period = null;
  const pr = first(LABEL.periodRange, text);
  if (pr) { const end = F.toDate(pr[2]); period = end ? end.slice(0, 7) : null; }
  if (!period) { const pm = first(LABEL.periodMonth, text); period = pm ? F.toPeriod(pm[1]) : null; }
  if (!period && billDate) { period = billDate.slice(0, 7); notes.push('billing month taken from the bill date'); }
  let total = null;
  for (const re of TOTALS) { const m = first(re, text); if (m) { total = money(m[1]); if (total != null && total > 0) break; } }
  const c = first(TAX.cgst, text); const s = first(TAX.sgst, text); const i = first(TAX.igst, text); const t = first(TAX.total, text);
  let gst = null;
  if (c && s) gst = Math.round((money(c[1]) + money(s[1])) * 100) / 100;
  else if (i) gst = money(i[1]);
  else if (t) gst = money(t[1]);
  let amount = null;
  if (total != null) {
    if (gst != null && gst > 0 && gst < total) amount = Math.round((total - gst) * 100) / 100;
    else { amount = total; gst = 0; notes.push('GST not found on the bill - the total is taken as the amount; Accounts checks it'); }
  }
  if (!dueDate) notes.push('no due date on the bill - Accounts sets it');
  const acc = first(LABEL.account, text); const mob = first(MOBILE, text);
  const remarks = ['[PDF bill]', acc ? `Account ${acc[1]}` : null, mob ? `Mobile ${mob[1].replace(/\s+/g, '')}` : null].filter(Boolean).join(' · ');
  if (!billNumber || amount == null) return null;
  return {
    line, billNumber, period: period || today.slice(0, 7), billDate: billDate || today, billDateMissing: !billDate, dueDate: dueDate || '', amount, gst: gst || 0, remarks, notes,
  };
}

// buffer -> { rows, skipped, header: { source: 'pdf' | 'pdf-ai', pages } }. Throws { status, message } when nothing can be read.
async function readPdf(buffer, fileName, { today = new Date().toISOString().slice(0, 10), ocr = null, hints = {} } = {}) {
  let pages;
  try { pages = await pagesOf(buffer); } catch (err) { throw Object.assign(new Error(`This PDF could not be opened (${String(err.message || err).slice(0, 80)}). Save it again from Airtel and try once more.`), { status: 400 }); }
  const text = pages.join('\n');
  if (text.replace(/\s+/g, '').length < 40) return readScanned(buffer, fileName, today, ocr, hints, pages.length);
  // pages -> bills: a page that prints a new bill number starts a new bill; pages without one belong to the bill before them
  const groups = [];
  pages.forEach((pg) => {
    const m = first(LABEL.billNo, pg);
    const no = m && /\d/.test(m[1]) ? m[1] : null;
    const last = groups[groups.length - 1];
    if (!last || (no && last.no && no !== last.no)) groups.push({ no, text: pg });
    else { last.text += `\n${pg}`; if (!last.no && no) last.no = no; }
  });
  const rows = []; let skipped = 0;
  groups.forEach((g) => { const r = billFrom(g.text, rows.length + 1, today); if (r) rows.push(r); else skipped += 1; });
  if (!rows.length) {
    throw Object.assign(new Error('No bill could be read from this PDF: the bill number and the total amount were not found on it. Use "Send a bill" and type them, or send the bill as Excel / CSV.'), { status: 400 });
  }
  return { rows, skipped, header: { source: 'pdf', pages: pages.length } };
}

// A scan: the AI bill reader, only when it is switched on (it is never called in the test sandbox unless a test provides one).
async function readScanned(buffer, fileName, today, ocr, hints, pageCount) {
  const OCR = ocr || require('./billOcr'); // eslint-disable-line global-require
  const st = await OCR.status().catch(() => ({ ready: false }));
  if (!st.ready) throw Object.assign(new Error('This PDF is a scanned picture (no text inside), and AI bill reading is not switched on. Use "Send a bill" and type the numbers, or ask Accounts to switch on AI bill reading.'), { status: 400 });
  let out;
  try { out = await OCR.read({ files: [{ name: String(fileName || 'bill.pdf'), mime: 'application/pdf', data: buffer }], hints }); } catch (err) { throw Object.assign(new Error(`The scanned PDF could not be read (${String(err.message || err).slice(0, 80)}). Try again, or use "Send a bill".`), { status: 400 }); }
  const val = (k) => { const v = out && out.fields ? out.fields[k] : null; return v && typeof v === 'object' && 'value' in v ? v.value : v; };
  const notes = ['read by AI from a scanned PDF - check the numbers'];
  const billNumber = val('invoiceNo') ? String(val('invoiceNo')).trim() : null;
  const billDate = val('invoiceDate') ? F.toDate(val('invoiceDate')) : null;
  const total = money(val('total'));
  let gst = money(val('gst'));
  if (gst == null && (val('cgst') != null || val('igst') != null)) gst = Math.round(((money(val('cgst')) || 0) + (money(val('sgst')) || 0) + (money(val('igst')) || 0)) * 100) / 100;
  if (!billNumber || total == null) throw Object.assign(new Error('The AI could not find the bill number and the total on this scanned PDF. Use "Send a bill" and type them.'), { status: 400 });
  const amount = gst != null && gst > 0 && gst < total ? Math.round((total - gst) * 100) / 100 : total;
  if (!(gst > 0 && gst < total)) { gst = 0; notes.push('GST not found on the bill - the total is taken as the amount'); }
  notes.push('no due date read - Accounts sets it');
  return {
    rows: [{ line: 1, billNumber, period: (billDate || today).slice(0, 7), billDate: billDate || today, billDateMissing: !billDate, dueDate: '', amount, gst, remarks: '[PDF bill, scanned]', notes }],
    skipped: 0, header: { source: 'pdf-ai', pages: pageCount },
  };
}

module.exports = { readPdf, billFrom, isPdf, pagesOf };
