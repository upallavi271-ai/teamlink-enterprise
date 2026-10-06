// ---------------------------------------------------------------------------
// AGREEMENT — TeamLink's saved signature & stamp, versions, new version
// (2026-10-05). Mounted into routes/agreementSeal.js (/api/agreement) BEFORE
// its "/:clientId" routes.
//
//   GET    /agreement/settings/teamlink-seal            what is saved (SA / Admin)
//   POST   /agreement/settings/teamlink-seal            upload / draw (multipart:
//                                                       kind sign|stamp, method,
//                                                       signedBy, signedByTitle)
//   DELETE /agreement/settings/teamlink-seal/:kind      remove it
//   GET    /agreement/settings/teamlink-seal/file/:kind the image
//   POST   /agreement/:clientId/company-seal/use-saved   put the saved signature
//                                                       + stamp on this agreement
//   GET    /agreement/:clientId/versions                every kept signed PDF
//   POST   /agreement/:clientId/new-version             EDIT a signed agreement:
//                                                       the signed copy stays in
//                                                       history, a new draft is
//                                                       made to be signed again
// Edit = Super Admin / Admin only (agreementAccess edit / Agreement Lifecycle
// edit) — enforced here, whatever the screen shows.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const signing = require('../utils/agreementSigning');
const lifecycle = require('../utils/agreementLifecycle');
const seal = require('../utils/teamlinkSeal');

module.exports = function mountExtra(router, { loadForView, readUpload, dropFile, keepSignedPdf, KEPT_ACTION }) {
  async function mayEditSettings(req, res) {
    if (!(await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'edit'))) {
      res.status(403).json({ error: 'Only a Super Admin or Admin can set TeamLink\'s signature and stamp.' });
      return false;
    }
    return true;
  }

  router.get('/settings/teamlink-seal', requireAuth, async (req, res, next) => {
    try {
      if (!(await mayEditSettings(req, res))) return undefined;
      // eslint-disable-next-line global-require
      const { consultantParty } = require('../utils/agreement');
      const us = await consultantParty();
      const sum = seal.summary(await seal.getSeal());
      // eslint-disable-next-line global-require
      const em = await require('../utils/emudhra').setupReport();
      return res.json({ ...sum, signatoryName: us.signatoryName, signatoryTitle: us.signatoryTitle, ready: !!(sum.hasSign && sum.hasStamp && us.signatoryName), emudhra: { ready: em.ready, environment: em.environment, result: em.result } });
    } catch (err) { return next(err); }
  });

  router.post('/settings/teamlink-seal', requireAuth, async (req, res, next) => {
    try {
      if (!(await mayEditSettings(req, res))) return undefined;
      const { stored, fields } = await readUpload(req);
      const kind = String(fields.kind || 'sign');
      if (!['sign', 'stamp'].includes(kind)) { dropFile(stored.billFile); return res.status(400).json({ error: 'Say whether this is the signature or the stamp.' }); }
      const before = await seal.getSeal();
      const patch = kind === 'sign'
        ? {
          signFile: stored.billFile,
          signMethod: signing.SIGN_METHODS[fields.method] || 'Uploaded signature image',
          signedBy: String(fields.signedBy || '').trim().slice(0, 100) || before.signedBy || req.user.name || null,
          signedByTitle: String(fields.signedByTitle || '').trim().slice(0, 100) || before.signedByTitle || null,
        }
        : { stampFile: stored.billFile };
      const now = await seal.saveSeal(patch, req.user);
      const old = kind === 'sign' ? before.signFile : before.stampFile;
      if (old && old !== stored.billFile) dropFile(old);
      await logAudit({ userId: req.user.id, action: `TeamLink ${kind === 'sign' ? 'signature' : 'company stamp'} saved for agreements`, entity: 'AppSetting', entityId: seal.KEY });
      return res.json(seal.summary(now));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  });

  router.delete('/settings/teamlink-seal/:kind', requireAuth, async (req, res, next) => {
    try {
      if (!(await mayEditSettings(req, res))) return undefined;
      const field = { sign: 'signFile', stamp: 'stampFile' }[req.params.kind];
      if (!field) return res.status(404).json({ error: 'Unknown image' });
      const before = await seal.getSeal();
      const now = await seal.saveSeal({ [field]: null }, req.user);
      if (before[field]) dropFile(before[field]);
      await logAudit({ userId: req.user.id, action: `TeamLink ${req.params.kind === 'sign' ? 'signature' : 'company stamp'} removed from agreement settings`, entity: 'AppSetting', entityId: seal.KEY });
      return res.json(seal.summary(now));
    } catch (err) { return next(err); }
  });

  router.get('/settings/teamlink-seal/file/:kind', requireAuth, async (req, res, next) => {
    try {
      if (!(await mayEditSettings(req, res))) return undefined;
      const s = await seal.getSeal();
      const stored = { sign: s.signFile, stamp: s.stampFile }[req.params.kind];
      const file = stored ? attachments.resolveStored(stored) : null;
      if (!file) return res.status(404).json({ error: 'Nothing saved yet' });
      res.set('Cache-Control', 'private, no-store');
      return res.sendFile(file);
    } catch (err) { return next(err); }
  });

  router.post('/:clientId/company-seal/use-saved', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res, { edit: true });
      if (!loaded) return undefined;
      const { client } = loaded;
      if (['ACTIVE', 'EXPIRED', 'REJECTED'].includes(signing.statusOf(client))) {
        return res.status(409).json({ error: 'This agreement cannot be signed now. Make a new version first.' });
      }
      const s = seal.summary(await seal.getSeal());
      if (!s.hasSign && !s.hasStamp) return res.status(409).json({ error: 'No TeamLink signature or stamp is saved yet. Add them in Agreement settings, or sign here.' });
      const wrote = await seal.applyDefaults(client, { actorUserId: req.user.id });
      if (!Object.keys(wrote).length) return res.status(409).json({ error: 'TeamLink has already signed and stamped this agreement.' });
      const activated = await lifecycle.maybeAutoActivate(client.id, { actorUserId: req.user.id, via: 'TeamLink countersigned with the saved signature & stamp' });
      if (activated) await keepSignedPdf(activated);
      const fresh = activated || await prisma.client.findUnique({ where: { id: client.id } });
      return res.json({ ...signing.executedSummary(fresh), autoActivated: !!activated });
    } catch (err) { return next(err); }
  });

  router.get('/:clientId/versions', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res);
      if (!loaded) return undefined;
      const rows = await prisma.auditLog.findMany({
        where: { entity: 'Client', entityId: loaded.client.id, action: { in: [KEPT_ACTION, 'eMudhra-signed PDF kept (legal copy)'] } },
        orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, reason: true, toValue: true },
      });
      return res.json(rows.filter((r) => attachments.resolveStored(r.toValue)).map((r) => ({
        id: r.id, at: r.createdAt,
        sha256: (String(r.reason || '').match(/sha256 ([a-f0-9]{64})/) || [])[1] || null,
        kind: /eMudhra transaction/.test(r.reason || '') ? 'eMudhra-signed PDF (legal copy, digitally signed)'
          : (/fully signed/.test(r.reason || '') ? 'Fully signed (both sides) — our copy with the audit page' : 'Signed by the client — our copy with the audit page'),
      })));
    } catch (err) { return next(err); }
  });

  // "Make the PDF again" (SA / Admin): a new kept copy from the stored
  // signatures + stamps; the older copy stays in history.
  router.post('/:clientId/pdf/rebuild', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res, { edit: true });
      if (!loaded) return undefined;
      const { client } = loaded;
      if (!signing.executedSummary(client).pdfAvailable) return res.status(409).json({ error: 'The PDF is made once the agreement is signed.' });
      const file = await keepSignedPdf(client);
      if (!file) return res.status(500).json({ error: 'The PDF could not be made. Please try again.' });
      await logAudit({ userId: req.user.id, action: 'Signed agreement PDF made again', entity: 'Client', entityId: client.id, reason: 'The earlier copy stays in history' });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  router.post('/:clientId/new-version', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res, { edit: true });
      if (!loaded) return undefined;
      const { client } = loaded;
      const st = signing.statusOf(client);
      if (!['SIGNED', 'ACTIVE', 'EXPIRED'].includes(st)) {
        return res.status(409).json({ error: 'This agreement is not signed yet — just change the terms and make a new draft.' });
      }
      const reason = String((req.body || {}).reason || '').trim().slice(0, 300) || 'Terms edited by Admin';
      // The signed copy stays in history: keep one now if none is kept yet.
      const kept = await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: client.id, action: KEPT_ACTION, createdAt: { gte: new Date(new Date(client.agreementSignedAt || 0).getTime() - 1000) } } });
      if (!kept && client.agreementSignedAt) await keepSignedPdf(client);
      // eslint-disable-next-line global-require
      const { buildAgreementDocument, consultantParty } = require('../utils/agreement');
      const files = ['agreementCompanyStampFile', 'agreementCompanySignFile', 'agreementClientStampFile', 'agreementClientSignFile'].map((k) => client[k]).filter(Boolean);
      const updated = await prisma.client.update({
        where: { id: client.id },
        data: {
          ...signing.RESET_EXECUTION,
          agreementStatus: 'DRAFT',
          agreementActivatedAt: null,
          agreementSource: 'Generated',
          agreementDocument: buildAgreementDocument(client, await consultantParty()),
        },
      });
      files.forEach(dropFile);
      await logAudit({
        userId: req.user.id, action: 'Agreement new version started — the signed copy is kept in history', entity: 'Client', entityId: client.id,
        fromValue: st, toValue: 'DRAFT', reason,
      });
      return res.json({ ...signing.executedSummary(updated), newVersion: true });
    } catch (err) { return next(err); }
  });
};
