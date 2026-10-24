// ---------------------------------------------------------------------------
// THE CLIENT'S OWN AGREEMENT AS A FILE (PDF, Word or picture) - user request, 2026-10-16.
//
//   POST /api/clients/:id/agreement/upload-file      (multipart: file)  mountUpload() -> routes/clients.js
//   GET  /api/agreement/:clientId/own-file/info      what is on file    mountView()   -> routes/agreementSeal.js
//   GET  /api/agreement/:clientId/own-file           the file itself    (?download=1 saves it, otherwise it opens in the browser)
//
// WHO: uploading = Admin / Super Admin only (2026-10-17; a BDE views, never uploads). Reading = the same
// rule as the agreement PDF (agreementAccess: the client, their BDE, BDE TL, Manager, Accounts, Admin) - a TL,
// STL, Recruiter or HR login is refused, exactly like every other agreement route.
//
// FILES: PDF, Word (.docx / .doc), PNG, JPG, WebP, up to 10 MB. The type is decided by the file's first
// BYTES (a ".pdf" that is not really a PDF is refused), never by its name alone. The stored name is random.
// WHERE: the existing ClientDocument table (kind AGREEMENT) - no schema change.
// TEXT: a PDF / Word file is read for its text so the agreement still has text for the signing page;
// a scanned PDF or a picture has no readable text, and the screen says so in plain words.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const attachments = require('../utils/attachments');
const profile = require('../utils/clientProfile');
const signing = require('../utils/agreementSigning');
const { logAudit } = require('../utils/audit');

const MAX_BYTES = 10 * 1024 * 1024;
const LIMIT_WORDS = 'The limit is 10 MB.';
const ONLY_WORDS = 'Only PDF, Word or image files (PNG, JPG, WebP) are accepted.';
const DOC_NAME = "Client's own agreement";
const EXT_MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};
const KIND_WORD = { 'application/pdf': 'PDF', 'image/png': 'picture', 'image/jpeg': 'picture', 'image/webp': 'picture' };
const INLINE_OK = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']); // a browser can show these; Word is always saved

const extOf = (name) => (/\.([A-Za-z0-9]{1,5})$/.exec(String(name || '').trim()) || [null, ''])[1].toLowerCase();
const safeName = (n) => String(n || 'agreement').replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 100) || 'agreement';

function tooBig(res) { return res.status(413).json({ error: `That file is too big. ${LIMIT_WORDS}` }); }

function mountUpload(router, { requirePerm, agreementTransition, executionFiles, dropExecutionFiles, OPEN_FOR_AUTHORING, agreementIsSigned, statusOf }) {
  router.post('/:id/agreement/upload-file', requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'), async (req, res) => {
    // 2026-10-17: uploading an agreement file = Admin / Super Admin only (a BDE can view, not upload).
    const acc = await signing.agreementAccess(req.user, req.client);
    if (!acc.edit) return res.status(403).json({ error: 'Only an Admin or Super Admin can upload an agreement file.' });
    if (!profile.docsAvailable()) return res.status(503).json({ error: 'Files can be added after the database update. Please try again later.' });
    if (agreementIsSigned(req.client.agreementStatus)) {
      return res.status(400).json({ error: 'This agreement is already signed — upload a signed copy instead' });
    }
    // Refuse a too-big body from its stated size before reading it.
    let parsed;
    try { parsed = await attachments.parseMultipart(req, { maxBytes: MAX_BYTES }); } catch (err) {
      if (err.code === 'TOO_LARGE') return tooBig(res);
      return res.status(400).json({ error: 'Choose a file to upload.' });
    }
    const file = parsed.file;
    if (!file || !file.data || !file.data.length) return res.status(400).json({ error: 'Choose a file to upload.' });
    if (file.data.length > MAX_BYTES) return tooBig(res);
    const ext = extOf(file.filename);
    const mime = EXT_MIME[ext];
    if (!mime) return res.status(400).json({ error: ONLY_WORDS });
    let stored;
    try { stored = attachments.store({ ...file, contentType: mime }, { maxBytes: MAX_BYTES, allowWord: true }); } catch (err) {
      if (err.code === 'TOO_LARGE') return tooBig(res);
      if (err.code === 'CONTENT_MISMATCH') {
        return res.status(400).json({ error: `That file is not a real ${KIND_WORD[mime] || 'Word'} file. It may be broken, or its name may have been changed. Please pick the file again. ${ONLY_WORDS}` });
      }
      return res.status(400).json({ error: ONLY_WORDS });
    }

    // Read the words out of it when it has any (a PDF / Word file). A scan or a picture has none.
    let text = '';
    if (['pdf', 'docx', 'doc'].includes(ext)) {
      try {
        // eslint-disable-next-line global-require
        text = (await require('../utils/resumeParse').extractText(file.data, ext)).text || '';
      } catch { text = ''; }
    }
    const readable = text.trim().length >= 40;
    const shownName = stored.billName;
    const document = readable
      ? text.trim()
      : `This is the client's own agreement, kept as the file "${shownName}". Open the file to read it. TeamLink could not read words out of it (a scanned or picture file has none).`;

    // Same rule the step change below applies, checked first so nothing is stored for a refusal.
    const stepNow = statusOf(req.client);
    if (!OPEN_FOR_AUTHORING.includes(stepNow)) {
      attachments.remove(stored.billFile);
      return res.status(400).json({ error: `An agreement in "${stepNow}" cannot be uploaded.` });
    }
    const oldDocs = await prisma.clientDocument.findMany({ where: { clientId: req.client.id, kind: 'AGREEMENT', name: DOC_NAME } });
    const row = await prisma.clientDocument.create({
      data: {
        clientId: req.client.id, kind: 'AGREEMENT', name: DOC_NAME,
        fileStored: stored.billFile, fileName: shownName, fileMime: stored.billMime, fileSize: stored.billSize,
        uploadedById: req.user.id, uploadedByName: req.user.name || null,
      },
    });
    const files = executionFiles(req.client);
    // The older file is replaced BEFORE the answer goes out, so the next request already sees only the new one.
    for (const d of oldDocs) {
      await prisma.clientDocument.delete({ where: { id: d.id } }).catch(() => {});
      attachments.remove(d.fileStored);
    }
    // agreementTransition answers the request itself (the new client row, or a plain error).
    await agreementTransition(req, res, {
      id: req.client.id,
      from: OPEN_FOR_AUTHORING,
      action: 'Agreement document uploaded',
      to: 'DRAFT',
      data: {
        ...signing.RESET_EXECUTION,
        agreementDocument: document,
        agreementStatus: 'DRAFT',
        agreementSource: 'Uploaded',
        agreementSignedCopyName: shownName,
      },
    });
    if (res.statusCode < 400) {
      dropExecutionFiles(files);
      await logAudit({ userId: req.user.id, action: 'Client agreement file uploaded', entity: 'Client', entityId: req.client.id, toValue: `${shownName}${readable ? '' : ' (no readable text)'}`.slice(0, 300) });
    } else {
      await prisma.clientDocument.delete({ where: { id: row.id } }).catch(() => {});
      attachments.remove(stored.billFile);
    }
  });
}

function mountView(router, { requireAuth, loadForView }) {
  async function current(clientId) {
    return prisma.clientDocument.findFirst({ where: { clientId, kind: 'AGREEMENT', name: DOC_NAME }, orderBy: { createdAt: 'desc' } });
  }
  router.get('/:clientId/own-file/info', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res);
      if (!loaded) return undefined;
      const d = profile.docsAvailable() && loaded.client.agreementSource === 'Uploaded' ? await current(loaded.client.id) : null;
      // The signed agreement files (routes/agreementSignedFiles.js): "has" is true when there are any, so older screens know.
      const signedFiles = await require('./agreementSignedFiles').countFor(loaded.client.id); // eslint-disable-line global-require
      if (!d || !attachments.resolveStored(d.fileStored)) return res.json(signedFiles ? { has: true, own: false, signedFiles } : { has: false });
      return res.json({
        has: true, own: true, signedFiles, name: d.fileName, mime: d.fileMime, size: d.fileSize, uploadedAt: d.createdAt,
        canShow: INLINE_OK.has(d.fileMime), limitMb: MAX_BYTES / (1024 * 1024),
      });
    } catch (err) { return next(err); }
  });
  router.get('/:clientId/own-file', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res);
      if (!loaded) return undefined;
      const d = profile.docsAvailable() ? await current(loaded.client.id) : null;
      const file = d ? attachments.resolveStored(d.fileStored) : null;
      if (!d || !file) return res.status(404).json({ error: 'There is no agreement file for this client.' });
      const mime = EXT_MIME[extOf(d.fileStored)] || 'application/octet-stream';
      const inline = !req.query.download && INLINE_OK.has(mime);
      res.set('Content-Type', mime);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName(d.fileName)}"`);
      return res.sendFile(file);
    } catch (err) { return next(err); }
  });
}

module.exports = { mountUpload, mountView, MAX_BYTES, EXT_MIME };
