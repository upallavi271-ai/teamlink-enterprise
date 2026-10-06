// ---------------------------------------------------------------------------
// FILL FROM A FILE (docfill_, 2026-10-06) — /api/doc-fill
//
//   POST /:target                       target = job | candidate | client.
//                                       multipart "file" (PDF / DOCX / DOC /
//                                       TXT / JPG / PNG, 10 MB) or JSON
//                                       { text } (a pasted e-mail).
//                                       -> { fields, found, missing, sources,
//                                            confidence, engine, warnings }
//   POST /attach/:target/:id            keep the file on the saved job /
//                                       client ("Source document").
//   GET  /source/:target/:id            the source documents of a job / client
//   GET  /source/:target/:id/:docId/file?download=1   the bytes
//
// WHO: the same permission as the form itself (Create Requirement / Add
// Candidate / Add Client, `create`). Attach / list / download also need the
// record to be in the caller's scope (utils/scope.js). Nothing here is
// public. The engine is utils/docFill.js; every read, attach and download is
// audited. A per-login limit stops a runaway loop (40 reads / 10 minutes).
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { requirementWhere, clientWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const docFill = require('../utils/docFill');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const PERM = {
  job: ['ats', 'requirements', 'Create Requirement', 'create'],
  candidate: ['ats', 'candidates', 'Add Candidate', 'create'],
  client: ['ats', 'clients', 'Add Client', 'create'],
};
const NOUN = { job: 'job', candidate: 'candidate', client: 'client' };
const ENTITY = { job: 'Requirement', candidate: 'Candidate', client: 'Client' };

// Per-login fixed window (the office shares one IP, so not per IP).
const hits = new Map();
const LIMIT = 40; const WINDOW = 10 * 60000;
function userLimit(req, res, next) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const row = hits.get(req.user.id);
  if (!row || now - row.start > WINDOW) { hits.set(req.user.id, { start: now, count: 1 }); return next(); }
  row.count += 1;
  if (row.count > LIMIT) {
    const retry = Math.max(1, Math.ceil((row.start + WINDOW - now) / 1000));
    res.set('Retry-After', String(retry));
    return res.status(429).json({ error: `You have read many files in a short time. Please wait ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''} and try again.`, retryAfter: retry });
  }
  return next();
}

async function mayUse(req, res, target) {
  if (!PERM[target]) { res.status(404).json({ error: 'Unknown form. Use job, candidate or client.' }); return false; }
  if (!(await can(req.user, ...PERM[target]))) {
    res.status(403).json({ error: `Your role cannot add a ${NOUN[target]}, so there is nothing to fill in.` });
    return false;
  }
  return true;
}

// The record, in the caller's scope (job / client only).
async function recordOf(req, res, target, id) {
  if (target === 'job') {
    const r = await prisma.requirement.findFirst({ where: { AND: [{ id }, requirementWhere(req.user)] }, select: { id: true, title: true, reqCode: true } });
    if (!r) res.status(404).json({ error: 'That job is not in your area.' });
    return r;
  }
  if (target === 'client') {
    const c = await prisma.client.findFirst({ where: { AND: [{ id }, clientWhere(req.user)] }, select: { id: true, name: true } });
    if (!c) res.status(404).json({ error: 'That client is not in your area.' });
    return c;
  }
  res.status(400).json({ error: 'A resume is kept on the candidate itself (Resume tab).' });
  return null;
}

// Works once the SourceDocument table exists (migration requested from main).
const available = () => !!(prisma.sourceDocument && typeof prisma.sourceDocument.findMany === 'function');
const UNAVAILABLE = 'The source document could not be kept yet: the database update for "Source documents" is still pending. The details were saved.';

const shape = (d) => ({
  id: d.id, target: d.target, fileName: d.fileName, mime: d.mime, size: d.size, engine: d.engine,
  fieldsFound: (() => { try { return d.fieldsFound ? JSON.parse(d.fieldsFound) : []; } catch { return []; } })(),
  uploadedByName: d.uploadedByName, uploadedAt: d.createdAt,
});

function fileError(res, err) {
  const code = err && err.code;
  if (code === 'TOO_LARGE') return res.status(413).json({ error: docFill.MESSAGE.TOO_LARGE, code });
  if (docFill.MESSAGE[code]) return res.status(400).json({ error: docFill.MESSAGE[code], code });
  return res.status(400).json({ error: 'The file could not be read. Please try another file, or paste the text.', code: code || 'READ_FAILED' });
}

// --- read a file / pasted text and fill the fields -------------------------------
router.post('/:target', userLimit, async (req, res) => {
  const { target } = req.params;
  if (!(await mayUse(req, res, target))) return undefined;
  let file = null; let text = '';
  if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    let parsed;
    try { parsed = await docFill.parseUpload(req); } catch (err) { return fileError(res, err); }
    file = parsed.file;
    text = String((parsed.fields || {}).text || '');
  } else {
    text = String((req.body || {}).text || '');
  }
  if (!file && !text.trim()) return res.status(400).json({ error: docFill.MESSAGE.NO_FILE, code: 'NO_FILE' });
  if (text.length > 60000) text = text.slice(0, 60000);
  let out;
  try {
    out = await docFill.fill({ target, file, text, user: req.user });
  } catch (err) {
    return fileError(res, err);
  }
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Fill from file read', entity: ENTITY[target], entityId: null,
    toValue: `${out.fileName || 'pasted text'} · ${out.kind || 'text'} · ${out.engine}${out.error ? ' · no text' : ` · found ${out.found.length} of ${out.total}`}`.slice(0, 300),
  });
  if (out.error) return res.status(422).json({ ...out, needsAi: !!out.needsAi });
  return res.json(out);
});

// --- keep the file on the saved record -----------------------------------------------
router.post('/attach/:target/:id', async (req, res) => {
  const { target, id } = req.params;
  if (!(await mayUse(req, res, target))) return undefined;
  const rec = await recordOf(req, res, target, id);
  if (!rec) return undefined;
  let parsed;
  try { parsed = await docFill.parseUpload(req); } catch (err) { return fileError(res, err); }
  if (!parsed.file) return res.status(400).json({ error: 'Choose a file to keep.', code: 'NO_FILE' });
  if (!available()) return res.status(503).json({ error: UNAVAILABLE, pending: true });
  let stored;
  try { stored = docFill.storeSource(parsed.file); } catch (err) { return fileError(res, err); }
  const f = parsed.fields || {};
  const fieldsFound = (() => { try { const a = JSON.parse(f.fieldsFound || '[]'); return Array.isArray(a) ? a.map(String).slice(0, 60) : []; } catch { return []; } })();
  const row = await prisma.sourceDocument.create({
    data: {
      target, entityId: rec.id, file: stored.stored, fileName: stored.fileName, mime: stored.mime, size: stored.size, sha256: stored.sha256,
      engine: String(f.engine || '').slice(0, 40) || null, fieldsFound: JSON.stringify(fieldsFound),
      uploadedById: req.user.id, uploadedByName: req.user.name || null,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Source document attached', entity: ENTITY[target], entityId: rec.id,
    toValue: `${stored.fileName} · ${Math.round(stored.size / 1024)} KB · filled ${fieldsFound.length} field${fieldsFound.length === 1 ? '' : 's'}`.slice(0, 300),
  });
  return res.status(201).json(shape(row));
});

router.get('/source/:target/:id', async (req, res) => {
  const { target, id } = req.params;
  if (!PERM[target] || target === 'candidate') return res.status(404).json({ error: 'Unknown form.' });
  const rec = await recordOf(req, res, target, id);
  if (!rec) return undefined;
  if (!available()) return res.json({ available: false, rows: [] });
  const rows = await prisma.sourceDocument.findMany({ where: { target, entityId: rec.id }, orderBy: { createdAt: 'desc' } });
  return res.json({ available: true, rows: rows.map(shape) });
});

router.get('/source/:target/:id/:docId/file', async (req, res) => {
  const { target, id, docId } = req.params;
  if (!PERM[target] || target === 'candidate') return res.status(404).json({ error: 'Unknown form.' });
  const rec = await recordOf(req, res, target, id);
  if (!rec) return undefined;
  if (!available()) return res.status(503).json({ error: UNAVAILABLE });
  const d = await prisma.sourceDocument.findFirst({ where: { id: docId, target, entityId: rec.id } });
  if (!d) return res.status(404).json({ error: 'That document is not on this record.' });
  const full = docFill.resolveSource(d.file);
  if (!full) return res.status(404).json({ error: 'The file is missing on the server.' });
  const download = String(req.query.download || '') === '1';
  const name = String(d.fileName || 'source').replace(/["\r\n\\]/g, '');
  const inline = !download && /^(application\/pdf|image\/|text\/plain)/.test(d.mime || '');
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  if (download) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Source document downloaded', entity: ENTITY[target], entityId: rec.id, toValue: name.slice(0, 300) });
  }
  return fs.createReadStream(full).pipe(res);
});

module.exports = router;
