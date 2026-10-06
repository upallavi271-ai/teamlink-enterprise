// ---------------------------------------------------------------------------
// CLIENT DOCUMENTS (Add client section 8, 2026-10-05) — mounted into
// routes/clients.js, so router.param('id') has already checked scope.
//
//   GET    /clients/:id/documents                the list + each one's status
//   POST   /clients/:id/documents                upload (multipart: file, kind,
//                                                name, expiryDate, pending)
//   PATCH  /clients/:id/documents/:docId         name / expiry / pending
//   DELETE /clients/:id/documents/:docId         remove it (file + row)
//   GET    /clients/:id/documents/:docId/file    the file itself
//
// Files: PDF / JPG / PNG only, checked by their BYTES (utils/attachments.js
// sniffs the magic numbers), at most 5 MB. Status: Pending (marked), Expired /
// Expiring soon (30 days) / Valid from the expiry date (utils/clientProfile.js).
// WHO: read = the client desk (Super Admin, Admin, Manager, BDE on own
// clients, Accounts) — never a client login, a TL or a Recruiter; change =
// Client Detail edit (Super Admin, Admin, the owner BDE).
// Works only once the ClientDocument table exists (migration
// 20261005170000); before that every call answers 503 in plain words.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { can } = require('../middleware/auth');
const attachments = require('../utils/attachments');
const profile = require('../utils/clientProfile');
const { clientLevelFor } = require('../utils/clientRedact');
const { atsViewRole } = require('../utils/scope');

const ALLOWED_EXT = /\.(pdf|png|jpg)$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function shapeDoc(d) {
  return {
    id: d.id, kind: d.kind, kindLabel: profile.DOC_KINDS[d.kind] || 'Other', name: d.name,
    fileName: d.fileName, fileMime: d.fileMime, fileSize: d.fileSize, uploadedAt: d.createdAt,
    uploadedByName: d.uploadedByName, expiryDate: d.expiryDate, pending: !!d.pending, status: profile.documentStatus(d),
  };
}

module.exports = function mountClientDocuments(router) {
  const unavailable = (res) => res.status(503).json({ error: 'Documents can be added after the database update. Please try again later.' });
  async function mayRead(req, res) {
    if (!profile.docsAvailable()) { unavailable(res); return false; }
    const level = clientLevelFor(req.user);
    if (atsViewRole(req.user) === 'client' || !['full', 'billing'].includes(level)) {
      res.status(403).json({ error: 'Client documents are seen by the client desk only.' });
      return false;
    }
    return true;
  }
  async function mayEdit(req, res) {
    if (!(await mayRead(req, res))) return false;
    if (!(await can(req.user, 'ats', 'clients', 'Client Detail', 'edit'))) {
      res.status(403).json({ error: 'Only an Admin or the client\'s BDE can change its documents.' });
      return false;
    }
    return true;
  }
  async function docOf(req, res) {
    const d = await prisma.clientDocument.findFirst({ where: { id: req.params.docId, clientId: req.client.id } });
    if (!d) res.status(404).json({ error: 'That document is not on this client.' });
    return d;
  }

  router.get('/:id/documents', async (req, res) => {
    if (!profile.docsAvailable()) return res.json({ available: false, rows: [] });
    if (!(await mayRead(req, res))) return undefined;
    const rows = await prisma.clientDocument.findMany({ where: { clientId: req.client.id }, orderBy: { createdAt: 'desc' } });
    return res.json({ available: true, kinds: profile.DOC_KINDS, canEdit: await can(req.user, 'ats', 'clients', 'Client Detail', 'edit'), rows: rows.map(shapeDoc) });
  });

  router.post('/:id/documents', async (req, res) => {
    if (!(await mayEdit(req, res))) return undefined;
    let parsed;
    try { parsed = await attachments.parseMultipart(req); } catch (err) {
      if (err.code === 'TOO_LARGE') return res.status(413).json({ error: 'That file is over 5 MB. Please upload a smaller one.' });
      return res.status(400).json({ error: 'Choose a file to upload.' });
    }
    if (!parsed.file) return res.status(400).json({ error: 'Choose a file to upload.' });
    let stored;
    try { stored = attachments.store(parsed.file); } catch (err) {
      return res.status(400).json({ error: err.code === 'CONTENT_MISMATCH' ? 'That file is not really a PDF / JPG / PNG.' : (err.code === 'TOO_LARGE' ? 'That file is over 5 MB.' : 'Only PDF, JPG or PNG files can be uploaded.') });
    }
    if (!ALLOWED_EXT.test(stored.billFile)) {
      attachments.remove(stored.billFile);
      return res.status(400).json({ error: 'Only PDF, JPG or PNG files can be uploaded.' });
    }
    const f = parsed.fields || {};
    const kind = profile.DOC_KINDS[String(f.kind || '').toUpperCase()] ? String(f.kind).toUpperCase() : 'OTHER';
    const expiry = String(f.expiryDate || '').trim();
    if (expiry && !YMD.test(expiry)) { attachments.remove(stored.billFile); return res.status(400).json({ error: 'The expiry date does not look right.' }); }
    const doc = await prisma.clientDocument.create({
      data: {
        clientId: req.client.id, kind,
        name: String(f.name || '').trim().slice(0, 200) || profile.DOC_KINDS[kind],
        fileStored: stored.billFile, fileName: stored.billName, fileMime: stored.billMime, fileSize: stored.billSize,
        expiryDate: expiry || null, pending: f.pending === 'true' || f.pending === '1',
        uploadedById: req.user.id, uploadedByName: req.user.name || null,
      },
    });
    await logAudit({ userId: req.user.id, action: 'Client document uploaded', entity: 'Client', entityId: req.client.id, toValue: `${profile.DOC_KINDS[kind]}: ${doc.name}`.slice(0, 300) });
    return res.status(201).json(shapeDoc(doc));
  });

  router.patch('/:id/documents/:docId', async (req, res) => {
    if (!(await mayEdit(req, res))) return undefined;
    const d = await docOf(req, res);
    if (!d) return undefined;
    const b = req.body || {};
    const data = {};
    if (b.name !== undefined) data.name = String(b.name || '').trim().slice(0, 200) || d.name;
    if (b.expiryDate !== undefined) {
      const e = String(b.expiryDate || '').trim();
      if (e && !YMD.test(e)) return res.status(400).json({ error: 'The expiry date does not look right.' });
      data.expiryDate = e || null;
    }
    if (b.pending !== undefined) data.pending = b.pending === true;
    const updated = await prisma.clientDocument.update({ where: { id: d.id }, data });
    await logAudit({ userId: req.user.id, action: 'Client document changed', entity: 'Client', entityId: req.client.id, toValue: updated.name.slice(0, 300) });
    return res.json(shapeDoc(updated));
  });

  router.delete('/:id/documents/:docId', async (req, res) => {
    if (!(await mayEdit(req, res))) return undefined;
    const d = await docOf(req, res);
    if (!d) return undefined;
    await prisma.clientDocument.delete({ where: { id: d.id } });
    attachments.remove(d.fileStored);
    await logAudit({ userId: req.user.id, action: 'Client document removed', entity: 'Client', entityId: req.client.id, toValue: d.name.slice(0, 300) });
    return res.json({ ok: true });
  });

  router.get('/:id/documents/:docId/file', async (req, res) => {
    if (!(await mayRead(req, res))) return undefined;
    const d = await docOf(req, res);
    if (!d) return undefined;
    const file = attachments.resolveStored(d.fileStored);
    if (!file) return res.status(404).json({ error: 'That file is no longer on disk.' });
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${String(d.fileName || 'document').replace(/[^\w.-]+/g, '-')}"`);
    return res.sendFile(file);
  });
};
