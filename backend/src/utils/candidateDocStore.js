// ---------------------------------------------------------------------------
// CANDIDATE DOCUMENT FILES (b5_, ATS-100 B5.2 / B5.3) — the one place the bytes
// of a staff-uploaded candidate document or certificate are written.
//
// The same rules as utils/resumeStore.js / utils/attachments.js:
//   * files live in <UPLOAD_DIR>/candidate-docs (default
//     ~/.teamlink-uploads/candidate-docs; the sandbox's own upload dir in
//     TEST_MODE), OUTSIDE the repository, never served statically;
//   * the name on disk is 32 random hex chars + an extension chosen HERE from
//     what the bytes are — the client's filename is sanitised, display only;
//   * allow-list PDF / JPG / PNG / DOCX, and the first bytes must agree with
//     the extension (a renamed .exe / .html is refused);
//   * 10 MB cap, enforced while reading the socket (attachments.parseMultipart);
//   * a stored file is never overwritten ('wx'); "delete" on the Documents tab
//     hides the row with a reason and keeps the file for the audit trail.
//
//   validateDocFile(file)  -> { ext, mime } or throws { code }
//   storeDocFile(file)     -> { stored, fileName, mime, size, sha256 }
//   resolveDocFile(stored) -> absolute path or null
//   parseDocUpload(req)    -> { fields, file }
// `file` everywhere is { filename, contentType, data: Buffer }.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const attachments = require('./attachments');
const { sniffKind } = require('./resumeStore');

const DOC_MAX_BYTES = 10 * 1024 * 1024;

const KINDS = {
  pdf: { ext: 'pdf', mime: 'application/pdf' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  jpg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
};
const EXT_ALIAS = { jpeg: 'jpg' };
const STORED_NAME = /^[a-f0-9]{32}\.(pdf|docx|jpg|png)$/;

const DOC_MESSAGE = {
  NO_FILE: 'Choose a file to upload.',
  TOO_LARGE: `That file is larger than ${DOC_MAX_BYTES / (1024 * 1024)} MB.`,
  BAD_TYPE: 'Only PDF, JPG, PNG and Word (DOCX) files can be uploaded.',
  CONTENT_MISMATCH: "That file's contents do not match its type (it is not a real PDF / picture / Word file).",
  NOT_MULTIPART: 'Upload the file as a multipart/form-data request.',
};

function docDir() {
  const dir = path.join(attachments.uploadDir(), 'candidate-docs');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

// What the bytes ARE (PDF / DOCX via resumeStore's sniffer; pictures here).
function sniffDoc(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const k = sniffKind(buf);
  return k === 'pdf' || k === 'docx' ? k : null;
}

function validateDocFile(file) {
  const err = (code) => Object.assign(new Error(code), { code });
  if (!file || !file.data || !file.data.length) throw err('NO_FILE');
  if (file.data.length > DOC_MAX_BYTES) throw err('TOO_LARGE');
  let ext = (String(file.filename || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1];
  ext = EXT_ALIAS[ext] || ext;
  if (!ext || !KINDS[ext]) throw err('BAD_TYPE');
  const sniffed = sniffDoc(file.data);
  if (!sniffed || sniffed !== ext) throw err('CONTENT_MISMATCH');
  return { ext: sniffed, mime: KINDS[sniffed].mime };
}

function storeDocFile(file) {
  const { ext, mime } = validateDocFile(file);
  const stored = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(docDir(), stored), file.data, { mode: 0o600, flag: 'wx' });
  return {
    stored,
    fileName: attachments.safeDisplayName(file.filename),
    mime,
    size: file.data.length,
    sha256: crypto.createHash('sha256').update(file.data).digest('hex'),
  };
}

function resolveDocFile(storedName) {
  if (!storedName || !STORED_NAME.test(storedName)) return null;
  const dir = docDir();
  const full = path.resolve(dir, storedName);
  if (path.dirname(full) !== dir) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function parseDocUpload(req) {
  return attachments.parseMultipart(req, { maxBytes: DOC_MAX_BYTES });
}

// Sends a stored file: inline for PDF / pictures (view), attachment on ?download=1.
function sendDocFile(res, row, { download = false } = {}) {
  const full = resolveDocFile(row.file);
  if (!full) return res.status(404).json({ error: 'The file is missing on the server.' });
  const name = String(row.fileName || `document.${String(row.file).split('.').pop()}`).replace(/["\r\n\\]/g, '');
  const inline = !download && /^(application\/pdf|image\/)/.test(row.mime || '');
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return fs.createReadStream(full).pipe(res);
}

module.exports = {
  DOC_MAX_BYTES, DOC_MESSAGE, KINDS, docDir, sniffDoc, validateDocFile, storeDocFile, resolveDocFile, parseDocUpload, sendDocFile,
};
