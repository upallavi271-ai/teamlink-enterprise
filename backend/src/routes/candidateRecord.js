// ---------------------------------------------------------------------------
// THE CANDIDATE RECORD (b5_, ATS-100 B5) — mounted INSIDE routes/candidates.js
// (/api/candidates/...), so the router-wide "Candidate List: view" check and
// the record's scope (loadInScope) are the same as the profile's.
//
//   GET  /:id/record                         consent · referred by · campus ·
//                                            certifications (+ ones read from
//                                            the resume) · documents with files
//   POST /:id/consent                        recruiter-recorded consent
//                                            { status, purposes[], note }
//   PUT  /:id/referred-by                    { employeeId } | { name } (+ applicationId)
//   POST /:id/documents/upload               multipart: file, docType, note, internalOnly
//   GET  /:id/documents/:docId/file          view (?download=1 = save) — audited
//   POST /:id/documents/:docId/delete        { reason } — hidden with the reason,
//                                            file kept for the audit trail
//   POST /:id/certifications                 multipart or JSON: name, issuer,
//                                            issuedOn, expiresOn, credentialId, file?
//   GET  /:id/certifications/:cid/file       view / download — audited
//   POST /:id/certifications/:cid/delete     { reason }
//
// Files: utils/candidateDocStore.js (PDF / JPG / PNG / DOCX, bytes checked,
// 10 MB, private folder). Files are INTERNAL: a client or candidate login is
// never served one from here. Every write and every file opened is audited.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const rec = require('../utils/candidateRecord');
const docs = require('../utils/candidateDocStore');

const router = express.Router();
const cand = () => require('./candidates'); // eslint-disable-line global-require

const EDIT = requirePerm('ats', 'candidates', 'Candidate Master', 'edit');
const DOC_TYPES = ['Resume', 'ID', 'Certificate', 'Offer', 'Joining', 'Other'];
const ymd = (v) => {
  const s = String(v || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const today = () => new Date().toISOString().slice(0, 10);

async function load(req, res, { internalOnly = false } = {}) {
  if (!rec.supported()) {
    res.status(503).json({ error: rec.NOT_READY });
    return null;
  }
  const loaded = await cand().loadInScope(req, res);
  if (!loaded) return null;
  const kind = cand().viewerKind(req.user);
  if (internalOnly && kind !== 'internal') {
    res.status(403).json({ error: 'Only the TeamLink team can do this.' });
    return null;
  }
  return { ...loaded, kind, internal: kind === 'internal' };
}

const docOut = (d, internal) => ({
  id: d.id,
  docType: d.docType,
  name: d.name,
  note: d.note,
  internalOnly: d.internalOnly,
  uploadedByName: d.uploadedByName,
  createdAt: d.createdAt,
  hasFile: !!d.file,
  fileName: internal ? d.fileName : undefined,
  mime: internal ? d.mime : undefined,
  size: internal ? d.size : undefined,
});

const certState = (c) => {
  if (!c.expiresOn) return { key: 'valid', label: 'No expiry' };
  if (c.expiresOn < today()) return { key: 'expired', label: 'Expired' };
  const days = Math.round((new Date(`${c.expiresOn}T00:00:00Z`) - new Date(`${today()}T00:00:00Z`)) / 86400000);
  return days <= 60 ? { key: 'soon', label: `Expires in ${days} day${days === 1 ? '' : 's'}` } : { key: 'valid', label: 'Valid' };
};
const certOut = (c, internal) => ({
  id: c.id, name: c.name, issuer: c.issuer, issuedOn: c.issuedOn, expiresOn: c.expiresOn,
  credentialId: internal ? c.credentialId : undefined, source: c.source, hasFile: !!c.file,
  fileName: internal ? c.fileName : undefined, createdByName: internal ? c.createdByName : undefined, createdAt: c.createdAt,
  state: certState(c),
});

// --- the whole record --------------------------------------------------------
router.get('/:id/record', async (req, res) => {
  const ctx = await load(req, res);
  if (!ctx) return undefined;
  const { candidate, internal } = ctx;
  const [documents, certifications, drive, latestResume] = await Promise.all([
    prisma.candidateDocument.findMany({
      where: { candidateId: candidate.id, deletedAt: null, ...(internal ? {} : { internalOnly: false }) },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.candidateCertification.findMany({ where: { candidateId: candidate.id }, orderBy: { createdAt: 'desc' } }),
    candidate.campusDriveId ? prisma.campusDrive.findUnique({ where: { id: candidate.campusDriveId } }) : null,
    internal ? prisma.candidateResume.findFirst({
      where: { candidateId: candidate.id, kind: 'ORIGINAL', hiddenAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, text: true },
    }) : null,
  ]);
  // Certifications the latest resume lists that are not on the record yet.
  const have = new Set(certifications.map((c) => c.name.toLowerCase()));
  const fromResume = latestResume ? rec.certificationsFromText(latestResume.text)
    .filter((c) => !have.has(c.name.toLowerCase())) : [];
  const canEdit = internal && await require('../middleware/auth').can(req.user, 'ats', 'candidates', 'Candidate Master', 'edit'); // eslint-disable-line global-require
  // Who referred, per application (the ones this login sees).
  const visibleApps = ctx.decorated.applications || [];
  const appRows = visibleApps.length ? await prisma.application.findMany({
    where: { id: { in: visibleApps.map((a) => a.id) } },
    select: {
      id: true, requirementId: true, referredByName: true, referralId: true, utmSource: true, utmMedium: true,
      utmCampaign: true, utmContent: true, campusDriveId: true, firstSource: true, source: true,
    },
  }) : [];
  const titleOf = new Map(visibleApps.map((a) => [a.id, a.requirement && a.requirement.title]));
  return res.json({
    consent: rec.consentView(candidate, { internal }),
    purposes: rec.PURPOSES,
    referredBy: candidate.referredByName ? { name: candidate.referredByName, employeeId: internal ? candidate.referredByEmployeeId : undefined } : null,
    campusDrive: drive ? { id: drive.id, collegeName: drive.collegeName, driveDate: drive.driveDate } : null,
    attribution: internal ? appRows.map((a) => ({ ...a, requirementTitle: titleOf.get(a.id) || null })) : [],
    documents: documents.map((d) => docOut(d, internal)),
    docTypes: DOC_TYPES,
    certifications: certifications.map((c) => certOut(c, internal)),
    fromResume,
    rights: { canEdit, canViewFiles: internal, maxMb: docs.DOC_MAX_BYTES / (1024 * 1024) },
  });
});

// --- consent recorded by a recruiter ------------------------------------------
router.post('/:id/consent', EDIT, async (req, res) => {
  const ctx = await load(req, res, { internalOnly: true });
  if (!ctx) return undefined;
  const status = String(req.body.status || '').toUpperCase();
  const note = String(req.body.note || '').replace(/\s+/g, ' ').trim();
  if (!rec.CONSENT_STATUSES.includes(status)) return res.status(400).json({ error: 'Pick Given, Not given or Withdrawn.' });
  if (note.length < 5) return res.status(400).json({ error: 'Write what the person said and how (for example: "Said yes on a call today").' });
  const purposes = rec.cleanPurposes(req.body.purposes);
  if (status === 'GIVEN' && !purposes.length) return res.status(400).json({ error: 'Tick at least one thing they agreed to.' });
  try {
    const c = await rec.setConsent(ctx.candidate.id, {
      status, purposes, source: 'recruiter', proof: `${note} — recorded by ${req.user.name}`, byName: req.user.name, userId: req.user.id,
    });
    return res.json({ ok: true, message: status === 'WITHDRAWN' ? 'Saved. This person will not get bulk messages and is hidden from exports.' : 'Saved.', consent: rec.consentView(c) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// --- referred by -----------------------------------------------------------------
router.put('/:id/referred-by', EDIT, async (req, res) => {
  const ctx = await load(req, res, { internalOnly: true });
  if (!ctx) return undefined;
  let name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  let employeeId = null;
  if (req.body.employeeId) {
    const emp = await prisma.employee.findUnique({ where: { id: String(req.body.employeeId) }, select: { id: true, name: true } });
    if (!emp) return res.status(400).json({ error: 'That employee was not found.' });
    employeeId = emp.id;
    name = emp.name;
  }
  if (!name && req.body.clear !== true) return res.status(400).json({ error: 'Pick an employee or type the person\'s name.' });
  const data = req.body.clear === true ? { referredByEmployeeId: null, referredByName: null } : { referredByEmployeeId: employeeId, referredByName: name };
  await prisma.candidate.update({ where: { id: ctx.candidate.id }, data });
  const appId = req.body.applicationId ? String(req.body.applicationId) : null;
  if (appId && (ctx.decorated.applications || []).some((a) => a.id === appId)) {
    await prisma.application.update({ where: { id: appId }, data });
  }
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Referred by updated', entity: 'Candidate', entityId: ctx.candidate.id,
    fromValue: ctx.candidate.referredByName || null, toValue: data.referredByName || '(cleared)',
  });
  return res.json({ ok: true, message: 'Saved.', referredBy: data.referredByName ? { name: data.referredByName, employeeId } : null });
});

// --- documents with a real file ---------------------------------------------------
function uploadError(res, err) {
  const code = err && err.code;
  if (docs.DOC_MESSAGE[code]) return res.status(code === 'TOO_LARGE' ? 413 : 400).json({ error: docs.DOC_MESSAGE[code] });
  throw err;
}

router.post('/:id/documents/upload', EDIT, async (req, res) => {
  const ctx = await load(req, res, { internalOnly: true });
  if (!ctx) return undefined;
  let parsed;
  try { parsed = await docs.parseDocUpload(req); } catch (err) { return uploadError(res, err); }
  const f = parsed.fields || {};
  const docType = DOC_TYPES.includes(f.docType) ? f.docType : null;
  if (!docType) return res.status(400).json({ error: `Pick the kind of document: ${DOC_TYPES.join(', ')}.` });
  let stored;
  try { stored = docs.storeDocFile(parsed.file); } catch (err) { return uploadError(res, err); }
  const name = String(f.name || '').replace(/\s+/g, ' ').trim().slice(0, 160) || stored.fileName;
  const internalOnly = f.internalOnly != null && f.internalOnly !== '' ? /^(1|true|yes|on)$/i.test(String(f.internalOnly)) : docType === 'Offer' || docType === 'ID';
  const doc = await prisma.candidateDocument.create({
    data: {
      candidateId: ctx.candidate.id,
      docType,
      name,
      note: String(f.note || '').trim().slice(0, 500) || null,
      internalOnly,
      uploadedByUserId: req.user.id,
      uploadedByName: req.user.name,
      file: stored.stored,
      fileName: stored.fileName,
      mime: stored.mime,
      size: stored.size,
      sha256: stored.sha256,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Document uploaded (${docType})`, entity: 'Candidate', entityId: ctx.candidate.id,
    toValue: `${name} · ${stored.fileName} · ${Math.round(stored.size / 1024)} KB`,
  });
  return res.status(201).json({ ok: true, message: 'Uploaded.', document: docOut(doc, true) });
});

router.get('/:id/documents/:docId/file', async (req, res) => {
  const ctx = await load(req, res, { internalOnly: true });
  if (!ctx) return undefined;
  const d = await prisma.candidateDocument.findFirst({ where: { id: req.params.docId, candidateId: ctx.candidate.id } });
  if (!d || d.deletedAt) return res.status(404).json({ error: 'Document not found' });
  if (!d.file) return res.status(404).json({ error: 'Only the name of this document was recorded — there is no file.' });
  const download = req.query.download === '1';
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Document ${download ? 'downloaded' : 'viewed'} (${d.docType})`,
    entity: 'Candidate', entityId: ctx.candidate.id, toValue: d.name,
  });
  return docs.sendDocFile(res, d, { download });
});

router.post('/:id/documents/:docId/delete', EDIT, async (req, res) => {
  const ctx = await load(req, res, { internalOnly: true });
  if (!ctx) return undefined;
  const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'Say why this document is being deleted.' });
  const d = await prisma.candidateDocument.findFirst({ where: { id: req.params.docId, candidateId: ctx.candidate.id } });
  if (!d || d.deletedAt) return res.status(404).json({ error: 'Document not found' });
  await prisma.candidateDocument.update({
    where: { id: d.id },
    data: { deletedAt: new Date(), deletedById: req.user.id, deletedByName: req.user.name, deleteReason: reason.slice(0, 500) },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Document deleted (${d.docType})`, entity: 'Candidate', entityId: ctx.candidate.id,
    fromValue: d.name, reason: reason.slice(0, 500),
  });
  return res.json({ ok: true, message: 'Deleted. It stays in the history with your reason.' });
});

// --- certifications -------------------------------------------------------------------
router.post('/:id/certifications', EDIT, async (req, res) => {
  const ctx = await load(req, res, { internalOnly: true });
  if (!ctx) return undefined;
  let fields = req.body || {};
  let file = null;
  if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    try {
      const parsed = await docs.parseDocUpload(req);
      fields = parsed.fields || {};
      file = parsed.file;
    } catch (err) { return uploadError(res, err); }
  }
  const g = (k, max) => String(fields[k] == null ? '' : fields[k]).replace(/\s+/g, ' ').trim().slice(0, max);
  const name = g('name', 160);
  if (name.length < 2) return res.status(400).json({ error: 'Type the certification name.' });
  const issuedOn = ymd(fields.issuedOn);
  const expiresOn = ymd(fields.expiresOn);
  if (fields.issuedOn && !issuedOn) return res.status(400).json({ error: 'The issue date is not a real date.' });
  if (fields.expiresOn && !expiresOn) return res.status(400).json({ error: 'The expiry date is not a real date.' });
  if (issuedOn && expiresOn && expiresOn < issuedOn) return res.status(400).json({ error: 'The expiry date is before the issue date.' });
  let stored = null;
  if (file) {
    try { stored = docs.storeDocFile(file); } catch (err) { return uploadError(res, err); }
  }
  const row = await prisma.candidateCertification.create({
    data: {
      candidateId: ctx.candidate.id,
      name,
      issuer: g('issuer', 120) || null,
      issuedOn,
      expiresOn,
      credentialId: g('credentialId', 120) || null,
      source: fields.source === 'Resume' ? 'Resume' : 'Manual',
      createdById: req.user.id,
      createdByName: req.user.name,
      ...(stored ? {
        file: stored.stored, fileName: stored.fileName, mime: stored.mime, size: stored.size, sha256: stored.sha256,
      } : {}),
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Certification added', entity: 'Candidate', entityId: ctx.candidate.id,
    toValue: [name, row.issuer, expiresOn && `expires ${expiresOn}`, stored && 'with file'].filter(Boolean).join(' · '),
  });
  return res.status(201).json({ ok: true, message: 'Saved.', certification: certOut(row, true) });
});

router.get('/:id/certifications/:cid/file', async (req, res) => {
  const ctx = await load(req, res, { internalOnly: true });
  if (!ctx) return undefined;
  const c = await prisma.candidateCertification.findFirst({ where: { id: req.params.cid, candidateId: ctx.candidate.id } });
  if (!c || !c.file) return res.status(404).json({ error: 'No file for this certification.' });
  const download = req.query.download === '1';
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Certificate file ${download ? 'downloaded' : 'viewed'}`,
    entity: 'Candidate', entityId: ctx.candidate.id, toValue: c.name,
  });
  return docs.sendDocFile(res, c, { download });
});

router.post('/:id/certifications/:cid/delete', EDIT, async (req, res) => {
  const ctx = await load(req, res, { internalOnly: true });
  if (!ctx) return undefined;
  const reason = String(req.body.reason || '').replace(/\s+/g, ' ').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'Say why this certification is being removed.' });
  const c = await prisma.candidateCertification.findFirst({ where: { id: req.params.cid, candidateId: ctx.candidate.id } });
  if (!c) return res.status(404).json({ error: 'Certification not found' });
  await prisma.candidateCertification.delete({ where: { id: c.id } });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Certification removed', entity: 'Candidate', entityId: ctx.candidate.id,
    fromValue: [c.name, c.issuer, c.expiresOn && `expires ${c.expiresOn}`, c.file && `file ${c.fileName}`].filter(Boolean).join(' · '),
    reason: reason.slice(0, 500),
  });
  return res.json({ ok: true, message: 'Removed. The history keeps a note of it.' });
});

module.exports = router;
