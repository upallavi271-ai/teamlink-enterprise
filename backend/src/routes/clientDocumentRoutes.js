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
const CL = require('../utils/clientLifecycle');
// Drive links of signed agreements (2026-10-12): kind AGREEMENT_LINK rows - utils/agreementDriveLinks.js.
const DL = require('../utils/agreementDriveLinks');
// Documents (section 8) are filled by Purna Sir (HR) and Admin; the BDE desk does not see or add them (user, 2026-10-13).
const WF = require('../utils/agreementWorkflow');
const HR_ONLY = 'HR adds the documents after you send the client to HR.';

const ALLOWED_EXT = /\.(pdf|png|jpg)$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function shapeDoc(d) {
  return {
    id: d.id, kind: d.kind, kindLabel: profile.DOC_KINDS[d.kind] || 'Other', name: d.name,
    fileName: d.fileName, fileMime: d.fileMime, fileSize: d.fileSize, uploadedAt: d.createdAt,
    uploadedByName: d.uploadedByName, expiryDate: d.expiryDate, pending: !!d.pending, status: profile.documentStatus(d),
  };
}

// opts.mayRead(req,res) / opts.mayEdit(req,res) replace the default rights (the HR step of the agreement workflow,
// routes/agreementFlow.js, mounts the same handlers with its own rule). opts.canEdit(req) tells the list.
module.exports = function mountClientDocuments(router, opts = {}) {
  const unavailable = (res) => res.status(503).json({ error: 'Documents can be added after the database update. Please try again later.' });
  async function mayRead(req, res) {
    if (opts.mayRead) return opts.mayRead(req, res);
    if (!profile.docsAvailable()) { unavailable(res); return false; }
    const level = clientLevelFor(req.user);
    if (atsViewRole(req.user) === 'client' || !['full', 'billing'].includes(level)) {
      res.status(403).json({ error: 'Client documents are seen by the client desk only.' });
      return false;
    }
    return true;
  }
  async function mayEdit(req, res) {
    if (opts.mayEdit) return opts.mayEdit(req, res);
    if (!(await mayRead(req, res))) return false;
    if (!(await can(req.user, 'ats', 'clients', 'Client Detail', 'edit')) || !(await can(req.user, 'ats', 'clients', 'Client Documents', 'create'))) {
      res.status(403).json({ error: 'Only an Admin or the client\'s BDE can change its documents.' });
      return false;
    }
    // A BDE adds documents only to their OWN clients (2026-10-10).
    if (!CL.ownsClient(req.user, req.client)) {
      res.status(403).json({ error: 'This client is not yours. Ask the client\'s BDE, the BDE team lead or an Admin.' });
      return false;
    }
    return true;
  }
  async function docOf(req, res) {
    const d = await prisma.clientDocument.findFirst({ where: { id: req.params.docId, clientId: req.client.id, kind: { not: 'AGREEMENT_SIGNED' } } }); // the signed agreement files have their own route (agreementSignedFiles.js)
    if (!d) res.status(404).json({ error: 'That document is not on this client.' });
    return d;
  }

  router.get('/:id/documents', async (req, res) => {
    if (!profile.docsAvailable()) return res.json({ available: false, rows: [] });
    if (!(await mayRead(req, res))) return undefined;
    const all = await prisma.clientDocument.findMany({ where: { clientId: req.client.id }, orderBy: { createdAt: 'desc' } });
    const rows = WF.hidesHrFor(req.user) && !opts.mayRead ? [] : all.filter((d) => !DL.isLinkDoc(d) && d.kind !== 'AGREEMENT_SIGNED').map(shapeDoc);
    // The Drive links of the signed agreement: only those who may read them see them (never a colleague BDE, a TL, a client).
    if (all.some(DL.isLinkDoc) && DL.canSeeFor(DL.viewMode(req.user), req.user, req.client)) {
      (await DL.docsWithMeta({ clientId: req.client.id })).filter(DL.isActive).forEach((x) => {
        const l = DL.shapeLink(x);
        rows.push({
          id: x.doc.id, kind: DL.KIND, kindLabel: DL.KIND_LABEL, name: 'Signed agreement: open in Drive', fileName: l.label, uploadedAt: x.doc.createdAt,
          uploadedByName: x.doc.uploadedByName, expiryDate: x.doc.expiryDate, pending: false, status: profile.documentStatus(x.doc),
          isLink: true, linkUrl: l.url, linkHost: l.host, agreementDate: l.agreementDate, note: l.note, signedCopy: l.signedCopy,
        });
      });
      rows.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    }
    return res.json({ available: true, kinds: profile.DOC_KINDS, canEdit: opts.canEdit ? await opts.canEdit(req) : await can(req.user, 'ats', 'clients', 'Client Detail', 'edit'), rows });
  });

  router.post('/:id/documents', async (req, res) => {
    if (!(await mayEdit(req, res))) return undefined;
    if (!opts.mayEdit && WF.hidesHrFor(req.user)) return res.status(403).json({ error: HR_ONLY });
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
    const kind = profile.DOC_KINDS[String(f.kind || '').toUpperCase()] ? String(f.kind).toUpperCase() : 'OTHER'; // AGREEMENT_LINK is not in DOC_KINDS: links come only through agreement-links
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
    if (!opts.mayEdit && WF.hidesHrFor(req.user) && !DL.isLinkDoc(d)) return res.status(403).json({ error: HR_ONLY });
    if (DL.isLinkDoc(d)) return res.status(400).json({ error: 'A Drive link cannot be edited here. Use "Replace the Drive link" on the Agreement card.' });
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
    // (2026-10-13: a BDE uploads AND replaces / removes the documents of their own clients - only DELETING a client is a request.)
    const d = await docOf(req, res);
    if (!d) return undefined;
    if (!opts.mayEdit && WF.hidesHrFor(req.user) && !DL.isLinkDoc(d)) return res.status(403).json({ error: HR_ONLY });
    if (DL.isLinkDoc(d)) {
      // soft: the link stays in the client's history as "Removed" (Admin only)
      if (!(await DL.rightsOf(req.user)).canRemove) return res.status(403).json({ error: 'Only an Admin or the BDE team can remove an agreement link.' });
      await DL.removeLink(req.user, req.client, d.id, req.body && req.body.reason);
      return res.json({ ok: true });
    }
    await prisma.clientDocument.delete({ where: { id: d.id } });
    attachments.remove(d.fileStored);
    await logAudit({ userId: req.user.id, action: 'Client document removed', entity: 'Client', entityId: req.client.id, toValue: d.name.slice(0, 300) });
    return res.json({ ok: true });
  });

  router.get('/:id/documents/:docId/file', async (req, res) => {
    if (!(await mayRead(req, res))) return undefined;
    // The papers of a colleague's client (agreement, GST, PAN ...) are opened by that client's BDE, not the whole desk.
    if (!opts.mayRead && !CL.ownsClient(req.user, req.client)) return res.status(403).json({ error: 'The documents of this client are opened by its own BDE, the BDE team lead or an Admin.' });
    const d = await docOf(req, res);
    if (!d) return undefined;
    if (DL.isLinkDoc(d)) return res.status(400).json({ error: 'This is a Drive link, not a file. Use "Open in Drive".' });
    if (!opts.mayRead && WF.hidesHrFor(req.user)) return res.status(403).json({ error: HR_ONLY });
    const file = attachments.resolveStored(d.fileStored);
    if (!file) return res.status(404).json({ error: 'That file is no longer on disk.' });
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${String(d.fileName || 'document').replace(/[^\w.-]+/g, '-')}"`);
    return res.sendFile(file);
  });
};
