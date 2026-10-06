// ---------------------------------------------------------------------------
// RESUME FILE STORAGE (resume_) — the single place resume bytes are written.
//
// Same rules as utils/attachments.js, which this reuses for the upload root
// and the multipart parser:
//   * files live in <UPLOAD_DIR>/resumes (default ~/.teamlink-uploads/resumes,
//     the sandbox's ~/.teamlink-sandbox/uploads/resumes), OUTSIDE the repo;
//   * the name on disk is 32 random hex chars + an extension chosen here;
//     the client's filename is sanitised and kept for display only;
//   * allow-list PDF / DOCX / DOC, and the first bytes must agree with the
//     extension (magic-byte check) — a renamed .exe/.html is refused;
//   * 10 MB cap, enforced while reading the socket;
//   * a stored ORIGINAL is never overwritten or deleted: a new upload is a
//     new row + new file (the newest original is the current one).
//
// PUBLIC API for other features (e.g. bulk resume upload in the Candidates
// import) — keep these stable:
//   validateResumeFile(file)                     -> { kind, ext, mime } or throws { code }
//   saveOriginalResume({ candidateId, file, user, note }) -> CandidateResume row (+ text/parsed)
//   extractAndParse(buffer, kind)                (re-exported from resumeParse.js)
//   resolveResumeFile(storedName)                -> absolute path or null
//   parseResumeUpload(req)                       -> { fields, file } (multipart, 10 MB cap)
//   RESUME_MAX_BYTES, RESUME_MESSAGE
// `file` everywhere is { filename, contentType, data: Buffer }.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../db');
const attachments = require('./attachments');
const { extractAndParse } = require('./resumeParse');
const { logAudit } = require('./audit');

const RESUME_MAX_BYTES = 10 * 1024 * 1024;

const KINDS = {
  pdf: { ext: 'pdf', mime: 'application/pdf' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  doc: { ext: 'doc', mime: 'application/msword' },
};
const STORED_NAME = /^[a-f0-9]{32}\.(pdf|docx|doc)$/;

const RESUME_MESSAGE = {
  NO_FILE: 'Choose a resume file to upload.',
  TOO_LARGE: `That file is larger than ${RESUME_MAX_BYTES / (1024 * 1024)} MB.`,
  BAD_TYPE: 'Only PDF, DOCX and DOC resumes can be uploaded.',
  CONTENT_MISMATCH: "That file's contents do not match its type (it is not a real PDF / Word file).",
  NOT_MULTIPART: 'Upload the file as a multipart/form-data request.',
};

function resumeDir() {
  const dir = path.join(attachments.uploadDir(), 'resumes');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

// What the bytes ARE, from their first bytes alone.
function sniffKind(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'doc';
  // DOCX = a ZIP whose entries include word/document.xml (entry names are
  // stored uncompressed in the local headers).
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
    && buf.indexOf('word/', 0, 'latin1') !== -1 && buf.indexOf('[Content_Types].xml', 0, 'latin1') !== -1) return 'docx';
  return null;
}

function validateResumeFile(file) {
  const err = (code) => Object.assign(new Error(code), { code });
  if (!file || !file.data || !file.data.length) throw err('NO_FILE');
  if (file.data.length > RESUME_MAX_BYTES) throw err('TOO_LARGE');
  const ext = (String(file.filename || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1];
  if (!ext || !KINDS[ext]) throw err('BAD_TYPE');
  const sniffed = sniffKind(file.data);
  // A Word file saved under the other Word extension is still a Word file;
  // anything else whose bytes disagree with its name is refused.
  const word = (k) => k === 'doc' || k === 'docx';
  if (!sniffed || (sniffed !== ext && !(word(sniffed) && word(ext)))) throw err('CONTENT_MISMATCH');
  return { kind: sniffed, ext: sniffed, mime: KINDS[sniffed].mime };
}

function writeStored(buffer, ext) {
  const stored = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  // 'wx': never overwrite an existing file, even by a (practically
  // impossible) random-name collision.
  fs.writeFileSync(path.join(resumeDir(), stored), buffer, { mode: 0o600, flag: 'wx' });
  return stored;
}

function resolveResumeFile(storedName) {
  if (!storedName || !STORED_NAME.test(storedName)) return null;
  const dir = resumeDir();
  const full = path.resolve(dir, storedName);
  if (path.dirname(full) !== dir) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function parseResumeUpload(req) {
  return attachments.parseMultipart(req, { maxBytes: RESUME_MAX_BYTES });
}

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

async function saveOriginalResume({
  candidateId, file, user = null, note = null,
}) {
  const { kind, ext, mime } = validateResumeFile(file);
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { id: true } });
  if (!candidate) throw Object.assign(new Error('NO_CANDIDATE'), { code: 'NO_CANDIDATE' });
  const stored = writeStored(file.data, ext);
  const { text, parsed, parser, error } = await extractAndParse(file.data, kind);
  const fileName = attachments.safeDisplayName(file.filename);
  const row = await prisma.candidateResume.create({
    data: {
      candidateId,
      kind: 'ORIGINAL',
      file: stored,
      fileName,
      mime,
      size: file.data.length,
      sha256: crypto.createHash('sha256').update(file.data).digest('hex'),
      text: text || null,
      parsed: parsed ? JSON.stringify({ ...parsed, ...(error ? { extractError: error } : {}) }) : (error ? JSON.stringify({ extractError: error }) : null),
      parser,
      createdById: user ? user.id : null,
      createdByName: user ? user.name : null,
    },
  });
  const version = await prisma.candidateResume.count({ where: { candidateId, kind: 'ORIGINAL', createdAt: { lte: row.createdAt } } });
  // The candidate's "Resume" field shows the current file's name.
  await prisma.candidate.update({ where: { id: candidateId }, data: { resumeName: fileName } }).catch(() => null);
  try { require('./candidateListCache').markCandidateDirty(candidateId); } catch { /* list cache optional */ }
  await logAudit({
    userId: user ? user.id : null,
    actorName: user ? user.name : null,
    action: `Resume uploaded (Original v${version})`,
    entity: 'Candidate',
    entityId: candidateId,
    toValue: `${fileName} · ${Math.round(file.data.length / 1024)} KB · ${parser}${note ? ` · ${note}` : ''}`,
  });
  return { ...row, version, parsed: safeParse(row.parsed), extractError: error };
}

module.exports = {
  RESUME_MAX_BYTES, RESUME_MESSAGE, KINDS,
  resumeDir, sniffKind, validateResumeFile, writeStored, resolveResumeFile, parseResumeUpload, saveOriginalResume,
  extractAndParse, safeParse,
};
