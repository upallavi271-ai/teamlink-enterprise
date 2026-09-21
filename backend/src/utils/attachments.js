// ---------------------------------------------------------------------------
// File attachments — a real upload, kept deliberately small.
//
// Until now every "document" in this app was a filename typed into a text box:
// candidate documents, client agreements and accounts proofs all record a
// string and store nothing. An Expense & Travel claim has to carry its actual
// bill, so this is the first place bytes are written, and it is written to be
// the pattern the other screens adopt rather than a one-off.
//
// The rules, all enforced here rather than in the route:
//
//   * THE CLIENT'S FILENAME IS NEVER A PATH. It is sanitised and kept for
//     display only; the name on disk is 32 random hex characters plus an
//     extension this file chose from the MIME type.
//   * Only image/png, image/jpeg, image/webp and application/pdf are accepted,
//     and the first bytes of the upload have to agree with the declared type —
//     a .pdf that is really an HTML page is refused.
//   * MAX_BYTES is enforced while reading the socket, so an oversized body is
//     aborted rather than buffered.
//   * Files live in UPLOAD_DIR, which is OUTSIDE the repository. Reading one
//     back re-validates the stored name against a strict pattern and then
//     checks the resolved path is still inside UPLOAD_DIR, so a stored name
//     can never address an arbitrary file.
//
// Multipart is parsed here rather than with a dependency: the form is one
// small file plus a couple of text fields, and adding multer to a checkout the
// user already has running would break their server until they reinstalled.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// MIME -> extension. This map IS the allow-list; anything absent is refused.
const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

// A stored name this module produced, and nothing else.
const STORED_NAME = /^[a-f0-9]{32}\.(png|jpg|webp|pdf)$/;

function uploadDir() {
  const dir = process.env.UPLOAD_DIR
    || path.join(os.homedir() || os.tmpdir(), '.teamlink-uploads');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

// Magic-byte check. The browser's Content-Type is a claim, not evidence.
function sniffAgrees(mime, buf) {
  if (buf.length < 4) return false;
  switch (mime) {
    case 'image/png':
      return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/webp':
      return buf.slice(0, 4).toString('latin1') === 'RIFF'
        && buf.slice(8, 12).toString('latin1') === 'WEBP';
    case 'application/pdf':
      return buf.slice(0, 5).toString('latin1') === '%PDF-';
    default:
      return false;
  }
}

// Display-only. Strips every path separator and anything exotic, so the name
// is safe to render and useless as a path even if someone later misuses it.
function safeDisplayName(raw) {
  const base = String(raw || 'upload').split(/[\\/]/).pop();
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'upload').slice(0, 120);
}

// --- multipart/form-data ---------------------------------------------------

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('TOO_LARGE'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function splitBuffer(buf, sep) {
  const parts = [];
  let from = 0;
  for (;;) {
    const at = buf.indexOf(sep, from);
    if (at === -1) { parts.push(buf.slice(from)); break; }
    parts.push(buf.slice(from, at));
    from = at + sep.length;
  }
  return parts;
}

// Parses one multipart body into { fields, file }. `file` is
// { filename, contentType, data } or null when the form carried no file part.
async function parseMultipart(req, { maxBytes = MAX_BYTES } = {}) {
  const type = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!/^multipart\/form-data/i.test(type) || !m) {
    throw Object.assign(new Error('NOT_MULTIPART'), { code: 'NOT_MULTIPART' });
  }
  // Refuse an oversized body from its declared length, BEFORE reading a byte,
  // so the caller gets a real error message. The streaming cap below is the
  // backstop for a request that lies about (or omits) Content-Length — that
  // one aborts the socket, which is the right answer to a lie.
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > maxBytes + 8192) {
    throw Object.assign(new Error('TOO_LARGE'), { code: 'TOO_LARGE' });
  }
  // A little headroom over the file cap for the part headers themselves.
  const body = await readBody(req, maxBytes + 8192);
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const fields = {};
  let file = null;

  splitBuffer(body, boundary).forEach((raw) => {
    // Every part is preceded by CRLF and followed by CRLF; the closing
    // boundary carries a trailing "--". Anything shorter is noise.
    if (raw.length < 4) return;
    let part = raw;
    if (part.slice(0, 2).toString('latin1') === '--') return; // closing boundary
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
      if (!filenameMatch[1]) return; // empty file input
      const ctMatch = /content-type:\s*([^\r\n;]+)/i.exec(head);
      file = {
        filename: filenameMatch[1],
        contentType: (ctMatch ? ctMatch[1] : '').trim().toLowerCase(),
        data,
      };
    } else {
      fields[nameMatch[1]] = data.toString('utf8');
    }
  });

  return { fields, file };
}

// --- store / read ----------------------------------------------------------

// Validates and writes the file. Returns the columns to persist on the row.
// Throws an Error whose `.code` names the reason, so the route can phrase it.
function store(file) {
  if (!file || !file.data || !file.data.length) {
    throw Object.assign(new Error('NO_FILE'), { code: 'NO_FILE' });
  }
  if (file.data.length > MAX_BYTES) {
    throw Object.assign(new Error('TOO_LARGE'), { code: 'TOO_LARGE' });
  }
  const ext = ALLOWED[file.contentType];
  if (!ext) throw Object.assign(new Error('BAD_TYPE'), { code: 'BAD_TYPE' });
  if (!sniffAgrees(file.contentType, file.data)) {
    throw Object.assign(new Error('CONTENT_MISMATCH'), { code: 'CONTENT_MISMATCH' });
  }
  // The name on disk is ours. The client never influences it.
  const stored = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(uploadDir(), stored), file.data, { mode: 0o600 });
  return {
    billFile: stored,
    billName: safeDisplayName(file.filename),
    billMime: file.contentType,
    billSize: file.data.length,
  };
}

// Resolves a stored name to an absolute path, or null. Two independent checks:
// the name must match the pattern this module generates, and the resolved path
// must still sit directly inside the upload directory.
function resolveStored(storedName) {
  if (!storedName || !STORED_NAME.test(storedName)) return null;
  const dir = uploadDir();
  const full = path.resolve(dir, storedName);
  if (path.dirname(full) !== dir) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function remove(storedName) {
  const full = resolveStored(storedName);
  if (full) { try { fs.unlinkSync(full); } catch { /* already gone */ } }
}

const MESSAGE = {
  NO_FILE: 'Choose a file to upload.',
  TOO_LARGE: `That file is larger than ${MAX_BYTES / (1024 * 1024)}MB.`,
  BAD_TYPE: 'Only PNG, JPEG, WebP images and PDF files can be attached.',
  CONTENT_MISMATCH: "That file's contents do not match its type.",
  NOT_MULTIPART: 'Upload the file as a multipart/form-data request.',
};

module.exports = {
  MAX_BYTES, ALLOWED, MESSAGE,
  uploadDir, parseMultipart, store, resolveStored, remove, safeDisplayName,
};
