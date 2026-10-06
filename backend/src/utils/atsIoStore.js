// ---------------------------------------------------------------------------
// ATS DATA I/O — the private folder that holds what an import or export needs
// to keep for a while (spec 2026-10-03 §B):
//
//   batches/<id>.json     every import batch: the records it created and the
//                         before-values of the ones it updated (Undo import)
//   requests/<id>.bin     the file a BDE sent for approval (import REQUEST)
//   exports/<id>.<fmt>    a big export produced in the background
//   resumes/<token>.*     resumes uploaded for a bulk upload, until confirmed
//
// OUTSIDE THE REPOSITORY and outside every static folder: nothing here is
// ever served by express.static. Files are read back only through the
// /api/ats-io routes, which check who is asking. ATS_IO_DIR overrides the
// location (default ~/.teamlink-data/ats-io).
//
// No schema change: an import batch's index row is an AuditLog row (entity
// 'ImportBatch'); this folder carries the detail.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.ATS_IO_DIR || path.join(os.homedir() || os.tmpdir(), '.teamlink-data', 'ats-io');
const KINDS = ['batches', 'requests', 'exports', 'resumes'];

function dir(kind) {
  if (!KINDS.includes(kind)) throw new Error(`atsIoStore: unknown folder ${kind}`);
  const d = path.join(ROOT, kind);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// Ids we generate are hex; anything else is refused before it touches a path.
const SAFE = /^[a-z0-9][a-z0-9-]{5,80}$/i;
const newId = (prefix = '') => `${prefix}${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

function fileOf(kind, name) {
  if (!SAFE.test(String(name).replace(/\.[a-z0-9]{2,5}$/i, ''))) return null;
  const d = dir(kind);
  const full = path.resolve(d, name);
  return path.dirname(full) === d ? full : null;
}

function writeJson(kind, id, value) {
  const f = fileOf(kind, `${id}.json`);
  if (!f) throw new Error('atsIoStore: bad id');
  fs.writeFileSync(f, JSON.stringify(value), { mode: 0o600 });
  return f;
}

function readJson(kind, id) {
  const f = fileOf(kind, `${id}.json`);
  if (!f || !fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function writeBin(kind, name, buffer) {
  const f = fileOf(kind, name);
  if (!f) throw new Error('atsIoStore: bad name');
  fs.writeFileSync(f, buffer, { mode: 0o600 });
  return f;
}

function readBin(kind, name) {
  const f = fileOf(kind, name);
  if (!f || !fs.existsSync(f)) return null;
  return fs.readFileSync(f);
}

function remove(kind, name) {
  const f = fileOf(kind, name);
  if (f && fs.existsSync(f)) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
}

// Old staging files go after a day; exports after a week. Never throws.
function sweep(kind, maxAgeMs) {
  try {
    const d = dir(kind);
    const now = Date.now();
    fs.readdirSync(d).forEach((n) => {
      const f = path.join(d, n);
      try { if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

module.exports = {
  ROOT, dir, newId, fileOf, writeJson, readJson, writeBin, readBin, remove, sweep,
};
