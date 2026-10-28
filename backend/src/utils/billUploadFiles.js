// ---------------------------------------------------------------------------
// VENDOR BILL UPLOADS - FILE HARDENING (2026-10-21).
// A bill is up to MAX_FILES files (a multi-page bill = several photos, or one PDF) of at most the vendor upload size (10 MB) each, MAX_PAGES pages
// in all. Allowed: JPG, PNG, WebP, PDF - decided by the FIRST BYTES of the file, never by the name or the browser's Content-Type, which must
// agree. Pictures must be real pictures (decoded header), not absurdly large (decompression bomb: 60 megapixels at most), not animated. A PDF
// must open, must not be locked (encrypted) and must not carry scripts, launch actions or embedded files. There is NO antivirus on this server:
// these checks refuse the common bad shapes; they are not a virus scan.
// The stored name is random (utils/attachments.js store), the vendor's file name is kept for display only.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const MAX_FILES = 5;
const MAX_PAGES = 5;
const MAX_PIXELS = 60e6;
const MIN_SIDE = 100;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
// EXCEL / CSV (founder 2026-10-28): decided by the bytes AND the file name (browsers send many different types for a CSV, so the declared
// type is not required to agree for these). The file must open as a spreadsheet; its text is what the AI reads (billOcr/providers).
const SHEETS = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv' };
const SHEET_MIMES = Object.values(SHEETS);
const MAX_SHEET_ROWS = 5000;
const EXT_OK = { 'image/jpeg': /\.(jpe?g)$/i, 'image/png': /\.png$/i, 'image/webp': /\.webp$/i, 'application/pdf': /\.pdf$/i };

const MESSAGE = {
  NOT_MULTIPART: 'Could not read the upload. Please try again.',
  NO_FILE: 'Choose a photo or a PDF of the bill.',
  TOO_MANY: `A bill can have up to ${MAX_FILES} files.`,
  TOO_LARGE: 'That file is too big. Please upload a smaller photo or PDF (up to 10 MB each).',
  BAD_TYPE: 'Only a photo (JPG, PNG, WebP), a PDF or an Excel / CSV file can be uploaded.',
  BAD_SHEET: 'That Excel / CSV file could not be opened. Please save it again, or send a photo or PDF of the bill.',
  BIG_SHEET: `That Excel file has too many rows (more than ${MAX_SHEET_ROWS}). Send only the bill.`,
  CONTENT_MISMATCH: "That file doesn't look like a real photo or PDF. Please choose the original file.",
  BAD_IMAGE: 'That picture could not be opened. Please take the photo again.',
  IMAGE_TOO_BIG: 'That picture is much too large (more than 60 megapixels). Please take a normal photo.',
  IMAGE_TOO_SMALL: 'That picture is too small to read. Please take a clearer photo.',
  ANIMATED: 'Please upload a normal photo, not an animation.',
  BAD_PDF: 'That PDF could not be opened. Please save it again or send a photo instead.',
  LOCKED_PDF: 'That PDF is locked with a password. Please send an unlocked PDF or a photo.',
  ACTIVE_PDF: 'That PDF contains scripts or attachments, so it cannot be accepted. Please send a photo or a plain PDF.',
  TOO_MANY_PAGES: `A bill can have up to ${MAX_PAGES} pages in all. Please send only the pages of this bill.`,
  SAME_FILE: 'The same file was added twice.',
};
const fail = (code) => Object.assign(new Error(code), { code });
const messageOf = (err) => MESSAGE[err && err.code] || 'Could not save the file. Please try again.';

// ---- multipart with SEVERAL files (utils/attachments.js parseMultipart keeps only one) -------------------------------------------------
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(fail('TOO_LARGE')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function splitBuffer(buf, sep) {
  const parts = []; let from = 0;
  for (;;) {
    const at = buf.indexOf(sep, from);
    if (at === -1) { parts.push(buf.slice(from)); break; }
    parts.push(buf.slice(from, at));
    from = at + sep.length;
  }
  return parts;
}
async function parseMultipartMany(req, { maxBytesEach, maxFiles = MAX_FILES } = {}) {
  const type = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!/^multipart\/form-data/i.test(type) || !m) throw fail('NOT_MULTIPART');
  const cap = (maxFiles + 1) * maxBytesEach + 65536;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > cap) throw fail('TOO_LARGE');
  const body = await readBody(req, cap);
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const fields = {}; const files = [];
  splitBuffer(body, boundary).forEach((raw) => {
    if (raw.length < 4) return;
    let part = raw;
    if (part.slice(0, 2).toString('latin1') === '--') return;
    if (part.slice(0, 2).toString('latin1') === '\r\n') part = part.slice(2);
    const split = part.indexOf('\r\n\r\n');
    if (split === -1) return;
    const head = part.slice(0, split).toString('latin1');
    let data = part.slice(split + 4);
    if (data.slice(-2).toString('latin1') === '\r\n') data = data.slice(0, -2);
    const nameMatch = /name="([^"]*)"/i.exec(head);
    if (!nameMatch) return;
    const filenameMatch = /filename="([^"]*)"/i.exec(head);
    if (filenameMatch) {
      if (!filenameMatch[1]) return;
      const ctMatch = /content-type:\s*([^\r\n;]+)/i.exec(head);
      files.push({ filename: Buffer.from(filenameMatch[1], 'latin1').toString('utf8'), contentType: (ctMatch ? ctMatch[1] : '').trim().toLowerCase(), data });
    } else {
      fields[nameMatch[1]] = data.toString('utf8').slice(0, 4000);
    }
  });
  if (files.length > maxFiles) throw fail('TOO_MANY');
  return { fields, files };
}

// ---- one file -------------------------------------------------------------------------------------------------------------------
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
const declaredMime = (ct) => (ct === 'image/jpg' || ct === 'image/pjpeg' ? 'image/jpeg' : ct);

async function pdfPages(buf) {
  const { PDFParse } = require('pdf-parse'); // eslint-disable-line global-require
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const info = await Promise.race([p.getInfo(), new Promise((_, rej) => setTimeout(() => rej(new Error('pdf timeout')), 12000))]);
    return Number(info.total) || 0;
  } finally { try { await p.destroy(); } catch { /* ignore */ } }
}

// -> { mime, ext, pages, width, height, size, sha256 }  or throws an error whose .code is a MESSAGE key
// An Excel / CSV file -> { mime, rows } or throws BAD_SHEET / BIG_SHEET. No macros: .xlsm is not accepted (the name must be .xlsx / .xls / .csv).
function sheetOf(file) {
  const m = /\.(xlsx|xls|csv)$/i.exec(String(file.filename || ''));
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const buf = file.data;
  const zip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const ole = buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if ((kind === 'xlsx' && !zip) || (kind === 'xls' && !ole && !zip) || (kind === 'csv' && buf.slice(0, 4096).includes(0))) throw fail('CONTENT_MISMATCH');
  let wb;
  try {
    const XLSX = require('xlsx'); // eslint-disable-line global-require
    wb = kind === 'csv' ? XLSX.read(buf.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', raw: true }) : XLSX.read(buf, { type: 'buffer', bookVBA: false });
    if (kind === 'xlsx' && wb.vbaraw) throw fail('BAD_SHEET');
    let rows = 0;
    wb.SheetNames.forEach((n) => { rows += XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false }).length; });
    if (!rows) throw fail('BAD_SHEET');
    if (rows > MAX_SHEET_ROWS) throw fail('BIG_SHEET');
    return { mime: SHEETS[kind === 'xls' && zip ? 'xlsx' : kind], rows };
  } catch (err) { if (err && err.code) throw err; throw fail('BAD_SHEET'); }
}
// The text of a stored Excel / CSV (for the AI reader and the review screen): every sheet as CSV, at most maxChars.
function sheetText(buf, mime, maxChars = 20000) {
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const wb = mime === 'text/csv' ? XLSX.read(buf.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', raw: true }) : XLSX.read(buf, { type: 'buffer' });
  let out = '';
  for (const n of wb.SheetNames) { out += `Sheet "${n}":\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}\n`; if (out.length > maxChars) break; }
  return out.slice(0, maxChars);
}

async function inspect(file, { maxBytes }) {
  if (!file || !file.data || !file.data.length) throw fail('NO_FILE');
  if (file.data.length > maxBytes) throw fail('TOO_LARGE');
  const sheet = sheetOf(file);
  if (sheet) return { mime: sheet.mime, ext: Object.keys(SHEETS).find((k) => SHEETS[k] === sheet.mime), pages: 1, width: null, height: null, size: file.data.length, sha256: crypto.createHash('sha256').update(file.data).digest('hex'), rows: sheet.rows };
  const mime = sniff(file.data);
  const dm = declaredMime(file.contentType);
  const extType = Object.keys(EXT_OK).find((k) => EXT_OK[k].test(String(file.filename || '')));
  // the bytes must be a photo / PDF, and the file name and the declared type must tell the same story
  if (!mime || dm !== mime || extType !== mime) throw fail(TYPES[dm] || extType ? 'CONTENT_MISMATCH' : 'BAD_TYPE');
  const out = { mime, ext: TYPES[mime], pages: 1, width: null, height: null, size: file.data.length, sha256: crypto.createHash('sha256').update(file.data).digest('hex') };
  if (mime === 'application/pdf') {
    const text = file.data.toString('latin1');
    if (/\/Encrypt\b/.test(text)) throw fail('LOCKED_PDF');
    if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(text)) throw fail('ACTIVE_PDF');
    let pages = 0;
    try { pages = await pdfPages(file.data); } catch { throw fail('BAD_PDF'); }
    if (!(pages >= 1)) throw fail('BAD_PDF');
    if (pages > MAX_PAGES) throw fail('TOO_MANY_PAGES');
    out.pages = pages;
    return out;
  }
  let meta;
  try { meta = await require('sharp')(file.data, { failOn: 'error' }).metadata(); } catch { throw fail('BAD_IMAGE'); } // eslint-disable-line global-require
  if (!meta.width || !meta.height) throw fail('BAD_IMAGE');
  if (meta.width * meta.height > MAX_PIXELS) throw fail('IMAGE_TOO_BIG');
  if (Math.min(meta.width, meta.height) < MIN_SIDE) throw fail('IMAGE_TOO_SMALL');
  if ((meta.pages || 1) > 1) throw fail('ANIMATED');
  out.width = meta.width; out.height = meta.height;
  return out;
}

module.exports = { MAX_FILES, MAX_PAGES, MAX_PIXELS, MESSAGE, messageOf, fail, parseMultipartMany, inspect, sniff, TYPES, SHEETS, SHEET_MIMES, sheetText };
