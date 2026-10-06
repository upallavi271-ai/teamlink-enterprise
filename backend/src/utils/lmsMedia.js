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

// SIZE CAPS, per kind. A video may be a long screen-cast; a document has no
// business being bigger than a large slide deck. Both are stated on the
// Create Course form in the same words the server refuses with.
const VIDEO_MAX = 300 * 1024 * 1024; // 300 MB — a long screen-cast, not a film
const DOC_MAX = 25 * 1024 * 1024; // 25 MB — documents and pictures
const MAX_BYTES = VIDEO_MAX; // the largest anything may be (kept for callers)
const MULTIPART_MAX = 25 * 1024 * 1024; // the buffered form stays small

const OOXML = 'application/vnd.openxmlformats-officedocument';
// MIME -> extension. This map IS the LMS allow-list; anything absent is refused.
const ALLOWED = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  [`${OOXML}.wordprocessingml.document`]: 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  [`${OOXML}.presentationml.presentation`]: 'pptx',
  'application/vnd.ms-excel': 'xls',
  [`${OOXML}.spreadsheetml.sheet`]: 'xlsx',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
};

// Extension -> MIME. The filename's extension must be on this list AND the
// type the browser declared must be one this extension may carry (EXT_ALSO),
// or a generic octet-stream / blank — so "notes.exe" sent as application/pdf
// and "talk.pdf" sent as video/mp4 are both refused.
const BY_EXT = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mov: 'video/quicktime', doc: 'application/msword', docx: `${OOXML}.wordprocessingml.document`,
  ppt: 'application/vnd.ms-powerpoint', pptx: `${OOXML}.presentationml.presentation`,
  xls: 'application/vnd.ms-excel', xlsx: `${OOXML}.spreadsheetml.sheet`, txt: 'text/plain',
};
// Other declared types a browser / OS really sends for these extensions.
const ZIPPISH = ['application/zip', 'application/x-zip-compressed'];
const EXT_ALSO = {
  m4v: ['video/x-m4v'],
  mov: ['video/mp4'],
  docx: ZIPPISH, pptx: ZIPPISH, xlsx: ZIPPISH,
};
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

// A stored name THIS module produced. Older materials were stored by
// utils/attachments.js and are resolved through it.
const STORED_NAME = /^lms-[a-f0-9]{32}\.(pdf|png|jpg|webp|mp4|webm|ogv|mov|doc|docx|ppt|pptx|xls|xlsx|txt)$/;

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // .doc/.ppt/.xls
const isZip = (buf) => buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
// QuickTime atoms that may open a .mov ('ftyp' on anything recent).
const MOV_ATOMS = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

function sniffAgrees(mime, buf) {
  if (mime === 'text/plain') {
    // Plain text has no signature: it must simply not be binary. No NUL byte
    // in the first bytes, and not a program or an archive wearing ".txt".
    if (!buf || !buf.length) return false;
    if (buf.includes(0x00)) return false;
    const head = buf.slice(0, 4).toString('latin1');
    return !(head.startsWith('MZ') || head === '\x7fELF' || isZip(buf));
  }
  if (!buf || buf.length < 12) return false;
  switch (mime) {
    case 'application/msword':
    case 'application/vnd.ms-powerpoint':
    case 'application/vnd.ms-excel':
      return buf.slice(0, 8).equals(OLE);
    case `${OOXML}.wordprocessingml.document`:
    case `${OOXML}.presentationml.presentation`:
    case `${OOXML}.spreadsheetml.sheet`:
      return isZip(buf);
    case 'video/quicktime':
      return MOV_ATOMS.has(buf.slice(4, 8).toString('latin1'));
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
// Returns '' when the extension and the declared type do not agree.
function mimeFor(declared, filename) {
  const d = String(declared || '').split(';')[0].trim().toLowerCase();
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  // No extension at all (an older client that sent no filename): the declared
  // type alone, as before.
  if (!ext) return ALLOWED[d] ? d : '';
  const want = BY_EXT[ext];
  if (!want) return '';
  if (GENERIC.has(d) || d === want || (EXT_ALSO[ext] || []).includes(d)) return want;
  return '';
}

// Video | Document — what the learner's player does with a stored file.
function kindForMime(mime) {
  return String(mime || '').startsWith('video/') ? 'Video' : 'Document';
}

// The size cap for one type, and the reason a file over it is refused.
function capFor(mime) {
  return kindForMime(mime) === 'Video' ? VIDEO_MAX : DOC_MAX;
}
function tooLarge(mime) {
  return kindForMime(mime) === 'Video' ? 'TOO_LARGE_VIDEO' : 'TOO_LARGE_DOC';
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
  const cap = capFor(mime);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > cap) return Promise.reject(fail(tooLarge(mime)));

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
      if (head.length < 512) head = Buffer.concat([head, chunk.slice(0, 512 - head.length)]);
      if (size > cap) {
        abort(tooLarge(mime));
        // Give the route a moment to answer 413 before the socket goes, so
        // the screen gets the reason rather than a dropped connection.
        setTimeout(() => req.destroy(), 1500).unref();
      }
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
  if (file.data.length > capFor(mime)) throw fail(tooLarge(mime));
  if (!sniffAgrees(mime, file.data.slice(0, 512))) throw fail('CONTENT_MISMATCH');
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
  // A .mov is an MP4-family container; browsers play it as video/mp4 and some
  // refuse the video/quicktime label outright.
  const served = mimeType === 'video/quicktime' ? 'video/mp4'
    : mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : mimeType;
  res.setHeader('Content-Type', served || 'application/octet-stream');
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

const MB = 1024 * 1024;
const MESSAGE = {
  NO_FILE: 'Choose a file to upload.',
  TOO_LARGE: `That file is bigger than ${VIDEO_MAX / MB} MB.`,
  TOO_LARGE_VIDEO: `This video is bigger than ${VIDEO_MAX / MB} MB. Make it shorter or smaller and try again.`,
  TOO_LARGE_DOC: `This document is bigger than ${DOC_MAX / MB} MB. Make it smaller (for example, save it as PDF) and try again.`,
  BAD_TYPE: 'This kind of file can\'t be added. Videos: MP4, WebM or MOV. Documents: PDF, Word, PowerPoint, Excel, text or a picture (PNG, JPG).',
  CONTENT_MISMATCH: 'This file doesn\'t match its name — it may be damaged or renamed. Open it, save it again, and upload that copy.',
  NOT_MULTIPART: 'Upload the file as a multipart/form-data request.',
};
// HTTP status per refusal: an oversized file is 413, everything else 400.
const STATUS = { TOO_LARGE: 413, TOO_LARGE_VIDEO: 413, TOO_LARGE_DOC: 413 };

module.exports = {
  MAX_BYTES, VIDEO_MAX, DOC_MAX, MULTIPART_MAX, ALLOWED, MESSAGE, STATUS,
  mimeFor, kindForMime, receive, storeBuffer, resolve, remove, stream,
  MEDIA_TTL_SECONDS, signMedia, verifyMedia,
};
