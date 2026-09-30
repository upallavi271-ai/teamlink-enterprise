// ---------------------------------------------------------------------------
// LMS media — course materials on disk, and the view-only stream that plays
// them back.
//
// utils/attachments.js is the app's shared upload helper: 5 MB, images and
// PDFs only, the whole body buffered. That is right for a bill or a stamp and
// wrong for a training video, and widening it would widen every other upload
// in the app with it. So the LMS keeps its OWN allow-list and cap here, and
// reuses only the parts that are about safety rather than size:
//
//   * the same UPLOAD_DIR (outside the repository),
//   * the same rule that the client's filename is display-only — the name on
//     disk is random hex plus an extension chosen from the MIME type,
//   * the same magic-byte check — the declared type is a claim, the first
//     bytes of the file are the evidence.
//
// A file arrives STREAMED (the request body is the file itself), so a 200 MB
// video is written to disk as it arrives instead of being held in memory. The
// older multipart form still works for the small files it always carried.
//
// VIEW-ONLY is the other half. Nothing here ever answers with
// `Content-Disposition: attachment`, a cacheable response or a sniffable one;
// see stream() below. What a browser can still do with bytes it has been
// given to display (screen recording, a screenshot, devtools) no web app can
// prevent, and the screen says so rather than pretending otherwise.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const attachments = require('./attachments');

const MAX_BYTES = 300 * 1024 * 1024; // 300 MB — a long screen-cast, not a film
const MULTIPART_MAX = 25 * 1024 * 1024; // the buffered form stays small

// MIME -> extension. This map IS the LMS allow-list; anything absent is refused.
const ALLOWED = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
};

// Extension -> MIME, for a browser that sends application/octet-stream.
const BY_EXT = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
};

// A stored name THIS module produced. Older materials were stored by
// utils/attachments.js and are resolved through it.
const STORED_NAME = /^lms-[a-f0-9]{32}\.(pdf|png|jpg|webp|mp4|webm|ogv)$/;

function sniffAgrees(mime, buf) {
  if (!buf || buf.length < 12) return false;
  switch (mime) {
    case 'video/mp4':
      // ISO base media: [size:4]['ftyp'] at the very start.
      return buf.slice(4, 8).toString('latin1') === 'ftyp';
    case 'video/webm':
      return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    case 'video/ogg':
      return buf.slice(0, 4).toString('latin1') === 'OggS';
    case 'application/pdf':
      return buf.slice(0, 5).toString('latin1') === '%PDF-';
    case 'image/png':
      return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/webp':
      return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
    default:
      return false;
  }
}

// The declared type, or one inferred from the filename's extension when the
// browser had no better answer than octet-stream. Either way sniffAgrees()
// still has the final say.
function mimeFor(declared, filename) {
  const d = String(declared || '').split(';')[0].trim().toLowerCase();
  if (ALLOWED[d]) return d;
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return BY_EXT[ext] || d;
}

// Video | Document — what the learner's player does with a stored file.
function kindForMime(mime) {
  return String(mime || '').startsWith('video/') ? 'Video' : 'Document';
}

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function newName(ext) {
  return `lms-${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

// STREAMED upload: the request body is the file. Resolves to the columns to
// persist, or rejects with an Error whose `.code` names the reason.
function receive(req, { filename, contentType }) {
  const mime = mimeFor(contentType, filename);
  const ext = ALLOWED[mime];
  if (!ext) return Promise.reject(fail('BAD_TYPE'));
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > MAX_BYTES) return Promise.reject(fail('TOO_LARGE'));

  const dir = attachments.uploadDir();
  const stored = newName(ext);
  const tmp = path.join(dir, `${stored}.part`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    let size = 0;
    let head = Buffer.alloc(0);
    let failed = null;
    const abort = (code) => {
      if (failed) return;
      failed = code;
      req.unpipe(out);
      // Windows will not unlink a file that is still open, so the partial file
      // goes once the write stream has actually closed.
      out.once('close', () => { try { fs.unlinkSync(tmp); } catch { /* never written */ } });
      out.destroy();
      reject(fail(code));
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (head.length < 16) head = Buffer.concat([head, chunk.slice(0, 16 - head.length)]);
      if (size > MAX_BYTES) { abort('TOO_LARGE'); req.destroy(); }
    });
    req.on('error', () => abort('NO_FILE'));
    out.on('error', () => abort('NO_FILE'));
    // 'close', not 'finish': the handle must be released before the rename or
    // the unlink, on Windows in particular.
    out.on('close', () => {
      if (failed) return;
      const bad = !size ? 'NO_FILE' : (!sniffAgrees(mime, head) ? 'CONTENT_MISMATCH' : null);
      if (bad) {
        failed = bad;
        try { fs.unlinkSync(tmp); } catch { /* never written */ }
        reject(fail(bad));
        return;
      }
      fs.renameSync(tmp, path.join(dir, stored));
      resolve({
        storedPath: stored,
        fileName: attachments.safeDisplayName(filename),
        mimeType: mime,
        sizeBytes: size,
      });
    });
    req.pipe(out);
  });
}

// The multipart form's file, already in memory (capped at MULTIPART_MAX by
// the parser). Same allow-list and sniff as the streamed path.
function storeBuffer(file) {
  if (!file || !file.data || !file.data.length) throw fail('NO_FILE');
  const mime = mimeFor(file.contentType, file.filename);
  const ext = ALLOWED[mime];
  if (!ext) throw fail('BAD_TYPE');
  if (!sniffAgrees(mime, file.data)) throw fail('CONTENT_MISMATCH');
  const stored = newName(ext);
  fs.writeFileSync(path.join(attachments.uploadDir(), stored), file.data, { mode: 0o600 });
  return {
    storedPath: stored,
    fileName: attachments.safeDisplayName(file.filename),
    mimeType: mime,
    sizeBytes: file.data.length,
  };
}

// A stored name -> absolute path, or null. Ours are checked against our own
// pattern; anything else is handed to attachments.js, which applies its own.
function resolve(storedName) {
  if (!storedName) return null;
  if (!STORED_NAME.test(storedName)) return attachments.resolveStored(storedName);
  const dir = attachments.uploadDir();
  const full = path.resolve(dir, storedName);
  if (path.dirname(full) !== dir) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function remove(storedName) {
  const full = resolve(storedName);
  if (full) { try { fs.unlinkSync(full); } catch { /* already gone */ } }
}

// THE VIEW-ONLY STREAM. Byte ranges are honoured, because a <video> element
// cannot seek without them; everything else is set so the response is shown
// and never saved:
//   Content-Disposition: inline   — never "attachment"
//   Cache-Control: no-store       — no copy left in the browser cache
//   X-Content-Type-Options        — the declared type, never a guessed one
function stream(req, res, full, { mimeType, fileName }) {
  const { size } = fs.statSync(full);
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${attachments.safeDisplayName(fileName || 'material')}"`);
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (range && (range[1] || range[2])) {
    let start;
    let end;
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      // "bytes=-500" is the LAST 500 bytes.
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', size);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(full).pipe(res);
}

// --- SIGNED, SHORT-LIVED VIEWING URLS (HRMS-24 §15) --------------------------
// A <video> or pdf fetch cannot send the login token, so the stream URL
// carries its own credential: an HMAC-SHA256 over (material, user, expiry)
// with a key DERIVED from the server secret for this one purpose — so the
// token is useless as a login token and a login token is useless here.
//
//   t = <expiresAtEpochSeconds>.<userId>.<base64url signature>
//
// Nothing about the file's location is in it; GET /api/lms/media/:id checks
// the signature, the expiry, and — again, at stream time — that the user is
// still assigned to the course (or manages courses).
const MEDIA_TTL_SECONDS = 10 * 60;

function mediaKey() {
  const secret = process.env.LMS_MEDIA_SECRET || process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', secret).update('teamlink-lms-media-v1').digest();
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signMedia(materialId, userId, ttlSeconds = MEDIA_TTL_SECONDS, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', mediaKey()).update(`${materialId}|${userId}|${exp}`).digest();
  return { token: `${exp}.${userId}.${b64url(sig)}`, expiresAt: new Date(exp * 1000) };
}

// { ok: true, userId } or { ok: false, reason }. Constant-time comparison.
function verifyMedia(materialId, token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'missing' };
  const [expRaw, userId, sig] = parts;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || !userId || !sig) return { ok: false, reason: 'malformed' };
  const want = b64url(crypto.createHmac('sha256', mediaKey()).update(`${materialId}|${userId}|${exp}`).digest());
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature' };
  if (Math.floor(now / 1000) > exp) return { ok: false, reason: 'expired' };
  return { ok: true, userId };
}

const MESSAGE = {
  NO_FILE: 'Choose a file to upload.',
  TOO_LARGE: `That file is larger than ${MAX_BYTES / (1024 * 1024)} MB.`,
  BAD_TYPE: 'Course materials can be MP4 / WebM / Ogg video, PDF, or PNG / JPEG / WebP images.',
  CONTENT_MISMATCH: "That file's contents do not match its type.",
  NOT_MULTIPART: 'Upload the file as a multipart/form-data request.',
};

module.exports = {
  MAX_BYTES, MULTIPART_MAX, ALLOWED, MESSAGE,
  mimeFor, kindForMime, receive, storeBuffer, resolve, remove, stream,
  MEDIA_TTL_SECONDS, signMedia, verifyMedia,
};
