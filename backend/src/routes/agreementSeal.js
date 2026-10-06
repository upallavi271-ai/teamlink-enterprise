// ---------------------------------------------------------------------------
// AGREEMENT EXECUTION — mounted at /api/agreement.
//
// OUR SIDE, behind a login. Who may see / edit is utils/agreementSigning.js
// agreementAccess(): Client login (own), the client's BDE, Accountants,
// Manager / Asst Manager (view) and Super Admin / Admin (view + EDIT).
//   GET   /agreement/list                   agreements this login may see
//   GET   /agreement/:clientId              document + execution + timeline
//   GET   /agreement/:clientId/executed     execution summary (legacy)
//   GET   /agreement/:clientId/pdf          the signed agreement as a PDF
//   GET   /agreement/:clientId/file/:kind   a stored signature / stamp image
//   POST  /agreement/:clientId/company-seal TeamLink countersign (SA/Admin)
//   PATCH /agreement/:clientId              dates / note (SA/Admin)
//   POST  /agreement/:clientId/void         void a signed agreement (SA/Admin)
//
// THE CLIENT'S SIDE, by the tokenised link (no login — the token is the key,
// it addresses one agreement, expires, and is replaced on every resend):
//   POST /agreement/token/:token/proceed      "OK, Proceed" after reading
//   POST /agreement/token/:token/signature    typed / drawn / uploaded
//   POST /agreement/token/:token/client-seal  optional company stamp
//   POST /agreement/token/:token/otp/send     code to the REGISTERED mobile
//   POST /agreement/token/:token/otp/verify   the code -> SIGNED
//   GET  /agreement/token/:token/pdf          the signed PDF
//   GET  /agreement/token/:token/file/:kind   images shown on the page
// (verify/start and verify/confirm remain as aliases of otp/send, otp/verify.)
//
// THE ONE-PAGE AGREEMENT LINK (2026-10-05) — what the page uses now:
//   POST /agreement/token/:token/email-code   code to the client contact EMAIL
//   POST /agreement/token/:token/agree-sign   code + name + designation +
//                                             "I agree and sign" -> SIGNED
// and for SA / Admin (routes/agreementLinkRoutes.js):
//   GET/POST /agreement/:clientId/link, /link/revoke, /link/email
// Every /token/* call is rate-limited per IP (utils/publicRateLimit.js), and
// the token is stored hashed (utils/agreementSigning.js findByToken).
//
// Every step is audited (entity Client) and the order is enforced here, not
// only in the page: no signature before Proceed, no code before a signature,
// no SIGNED without the right code.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const signing = require('../utils/agreementSigning');
const lifecycle = require('../utils/agreementLifecycle');
const { notifyUsers } = require('../utils/notify');

const router = express.Router();
const { ACTION } = signing;

const KINDS = {
  'company-stamp': ['agreementCompanyStampFile', 'agreementCompanyStampName'],
  'company-sign': ['agreementCompanySignFile', 'agreementCompanySignName'],
  'client-stamp': ['agreementClientStampFile', 'agreementClientStampName'],
  'client-sign': ['agreementClientSignFile', 'agreementClientSignName'],
};

async function readUpload(req, { imageOnly = true } = {}) {
  let parsed;
  try {
    parsed = await attachments.parseMultipart(req);
  } catch (err) {
    if (err.code === 'NOT_MULTIPART') throw Object.assign(new Error('Send the image as a form upload.'), { status: 400 });
    if (err.code === 'TOO_LARGE') throw Object.assign(new Error('That image is over 5 MB.'), { status: 413 });
    throw err;
  }
  if (!parsed.file) throw Object.assign(new Error('Choose or draw a signature image first.'), { status: 400 });
  let stored;
  try {
    stored = attachments.store(parsed.file);
  } catch (err) {
    throw Object.assign(new Error(attachments.MESSAGE[err.code] || 'That file could not be stored.'), { status: 400 });
  }
  if (imageOnly && /\.pdf$/i.test(stored.billFile)) {
    attachments.remove(stored.billFile);
    throw Object.assign(new Error('Upload a PNG or JPG image, not a PDF.'), { status: 400 });
  }
  // Signatures and stamps are kept small (<= 600 px) from the start.
  // eslint-disable-next-line global-require
  await require('../utils/imageShrink').shrinkFile(attachments.resolveStored(stored.billFile));
  return { stored, fields: parsed.fields || {} };
}
function dropFile(stored) { if (stored) { try { attachments.remove(stored); } catch { /* already gone */ } } }
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 60);

// The agreement's own audit trail, oldest first.
async function trailOf(client, { sinceSend = false } = {}) {
  const rows = await prisma.auditLog.findMany({
    where: {
      entity: 'Client', entityId: client.id,
      ...(sinceSend && client.agreementSentAt ? { createdAt: { gte: new Date(new Date(client.agreementSentAt).getTime() - 5000) } } : {}),
      OR: [{ action: { contains: 'Agreement' } }, { action: { contains: 'agreement' } }, { action: { startsWith: 'Client e-signature' } },
        { action: { startsWith: 'Client company stamp' } }, { action: { startsWith: 'TeamLink countersign' } }, { action: 'Signed copy attached' }],
    },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
    take: 300,
  });
  return rows.map((r) => ({
    at: r.createdAt,
    event: r.action,
    detail: [r.toValue && !/^\d{4}-\d{2}-\d{2}T/.test(r.toValue) ? r.toValue : null, r.reason].filter(Boolean).join(' · ') || null,
    by: r.user ? r.user.name : (r.actorName || null),
  }));
}

async function notifySigned(client, updated, verifiedVia) {
  const clientBdes = await prisma.requirement.findMany({
    where: { clientId: client.id, bdeId: { not: null } }, select: { bdeId: true }, distinct: ['bdeId'],
  });
  const audience = await prisma.user.findMany({
    where: {
      status: 'Active',
      // 2026-10-05: Accounts + the job BDEs + the client's own logins here;
      // the owner BDE, Admins and Super Admins get the "make it Active"
      // notice (utils/agreementActivateReminders.js notifyClientSigned).
      OR: [
        { accountsRole: { in: ['ACCOUNTANT'] } },
        { role: 'ACCOUNTANT' },
        { id: { in: clientBdes.map((r) => r.bdeId) } },
        { clientId: client.id },
      ],
    },
    select: { id: true },
  });
  await notifyUsers(audience.map((u) => u.id), {
    title: `${client.name} — agreement signed`,
    message: `${updated.agreementId || 'The agreement'} was e-signed by ${updated.agreementSignedBy || 'the client'}${updated.agreementSignedByTitle ? ` (${updated.agreementSignedByTitle})` : ''} and confirmed by a one-time code (${verifiedVia}).${updated.agreementCompanySealedAt ? '' : ' Next: press "Make it active" on the client\'s Agreement tab.'}`,
  });
}

// =========================================================================
// OUR SIDE
// =========================================================================
const LIST_SELECT = {
  id: true, name: true, clientCode: true, agreementId: true, agreementStatus: true, agreementSentAt: true,
  agreementSignedAt: true, agreementSignedBy: true, agreementActivatedAt: true, agreementCompanySealedAt: true,
  agreementClientSealedAt: true, agreementVerifiedAt: true, agreementStart: true, agreementEnd: true,
  agreementFeePercent: true, bdeOwner: true,
};

router.get('/list', requireAuth, async (req, res, next) => {
  try {
    const where = await signing.visibleClientWhere(req.user);
    if (!where) return res.status(403).json({ error: 'Agreements are visible to the client, their BDE, Accounts, Admin and Super Admin.' });
    const probe = await signing.agreementAccess(req.user, { id: req.user.clientId || '__probe__' });
    const accountsOnly = false; // 2026-10-05: Accounts view every agreement
    const rows = await prisma.client.findMany({
      where: {
        AND: [where, { agreementDocument: { not: null } },
          ...(accountsOnly ? [{ agreementStatus: { in: ['SIGNED', 'ACTIVE', 'EXPIRED', 'CONFIRMED'] } }] : [])],
      },
      select: LIST_SELECT,
      orderBy: [{ agreementSignedAt: 'desc' }, { name: 'asc' }],
      take: 2000,
    });
    return res.json({
      edit: probe.as === 'admin',
      rows: rows.map((c) => {
        const summary = signing.executedSummary(c);
        return {
          id: c.id, name: c.name, clientCode: c.clientCode, agreementId: c.agreementId, status: summary.status,
          sentAt: c.agreementSentAt, signedAt: c.agreementSignedAt, signedBy: c.agreementSignedBy, activatedAt: c.agreementActivatedAt,
          start: c.agreementStart, end: c.agreementEnd, feePercent: c.agreementFeePercent,
          awaitingCountersign: summary.awaitingCountersign, linkExpired: summary.linkExpired, pdfAvailable: summary.pdfAvailable,
          missing: summary.missing,
        };
      }),
    });
  } catch (err) { return next(err); }
});

async function loadForView(req, res, { edit = false } = {}) {
  const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
  if (!client) { res.status(404).json({ error: 'Client not found' }); return null; }
  const access = await signing.agreementAccess(req.user, client);
  if (!access.view) {
    res.status(403).json({ error: 'The agreement is visible to the client it belongs to, their BDE, Accounts, Admin and Super Admin.' });
    return null;
  }
  if (edit && !access.edit) {
    res.status(403).json({ error: 'Only a Super Admin or Admin can change an agreement.' });
    return null;
  }
  return { client, access };
}

// TeamLink's saved signature + stamp (Agreement settings), versions, new
// version, "use the saved signature & stamp" — routes/agreementSealExtra.js.
require('./agreementSealExtra')(router, { loadForView, readUpload, dropFile, keepSignedPdf: (c) => keepSignedPdf(c), KEPT_ACTION: 'Signed agreement PDF kept' });

router.get('/:clientId/executed', requireAuth, async (req, res, next) => {
  try {
    const loaded = await loadForView(req, res);
    if (!loaded) return undefined;
    return res.json({ ...signing.executedSummary(loaded.client), access: loaded.access });
  } catch (err) { return next(err); }
});

router.get('/:clientId/pdf', requireAuth, async (req, res, next) => {
  try {
    const loaded = await loadForView(req, res);
    if (!loaded) return undefined;
    const { client } = loaded;
    // A kept older signed copy can be downloaded whatever the step is now.
    if (!req.query.copy && !signing.executedSummary(client).pdfAvailable) return res.status(409).json({ error: 'The PDF is produced once the agreement is signed.' });
    if (req.query.copy && req.query.copy !== 'signed') {
      const row = await prisma.auditLog.findFirst({ where: { id: String(req.query.copy), entity: 'Client', entityId: client.id, action: { in: [KEPT_ACTION, EMUDHRA_KEPT] } }, select: { toValue: true } });
      const file = row ? attachments.resolveStored(row.toValue) : null;
      if (!file) return res.status(404).json({ error: 'That signed copy is no longer on file.' });
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${(client.agreementId || 'agreement').replace(/[^\w.-]/g, '')}-signed-copy.pdf"`);
      return res.sendFile(file);
    }
    if (req.query.copy === 'signed') {
      const kept = await keptPdfOf(client);
      if (!kept) return res.status(404).json({ error: 'No kept copy for this signature. Download the current PDF instead.' });
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${(client.agreementId || 'agreement').replace(/[^\w.-]/g, '')}-as-signed.pdf"`);
      return res.sendFile(kept);
    }
    // eslint-disable-next-line global-require
    const { consultantParty } = require('../utils/agreement');
    const us = await consultantParty();
    const trail = await trailOf(client, { sinceSend: true });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${(client.agreementId || 'agreement').replace(/[^\w.-]/g, '')}-${client.name.replace(/[^\w.-]+/g, '-').slice(0, 40)}.pdf"`);
    // eslint-disable-next-line global-require
    await require('../utils/agreementPdf').renderAgreementPdf(client, { trail, consultantName: us.name }, res);
    return undefined;
  } catch (err) { return next(err); }
});

router.get('/:clientId/file/:kind', requireAuth, async (req, res, next) => {
  try {
    const mapping = KINDS[req.params.kind];
    if (!mapping) return res.status(404).json({ error: 'Unknown image' });
    const loaded = await loadForView(req, res);
    if (!loaded) return undefined;
    const stored = loaded.client[mapping[0]];
    if (!stored) return res.status(404).json({ error: 'Nothing uploaded for that' });
    const resolved = attachments.resolveStored(stored);
    if (!resolved) return res.status(404).json({ error: 'That file is no longer on disk' });
    res.set('Cache-Control', 'private, no-store');
    return res.sendFile(resolved);
  } catch (err) { return next(err); }
});

// TEAMLINK'S COUNTERSIGN. Super Admin / Admin, any of the three signature
// options (the browser sends an image either way), optional company stamp.
// Allowed before sending (pre-sealed) or after the client signed (countersign);
// never on an Active / Expired / Rejected agreement.
router.post('/:clientId/company-seal', requireAuth, async (req, res, next) => {
  try {
    const loaded = await loadForView(req, res, { edit: true });
    if (!loaded) return undefined;
    const { client } = loaded;
    const st = signing.statusOf(client);
    if (!client.agreementDocument) return res.status(409).json({ error: 'Generate the agreement first.' });
    if (['ACTIVE', 'EXPIRED', 'REJECTED'].includes(st)) {
      return res.status(409).json({ error: `An agreement that is ${st.toLowerCase()} cannot be countersigned now. Void it to start again.` });
    }
    const { stored, fields } = await readUpload(req);
    const kind = String(fields.kind || 'company-sign').trim();
    if (!['company-stamp', 'company-sign'].includes(kind)) {
      dropFile(stored.billFile);
      return res.status(400).json({ error: 'Say which image this is: company-sign or company-stamp.' });
    }
    const method = signing.SIGN_METHODS[fields.method] ? fields.method : 'uploaded';
    const signedBy = String(fields.signedBy || '').trim().slice(0, 100) || client.agreementCompanySignedBy || req.user.name;
    const [fileField, nameField] = KINDS[kind];
    const previous = client[fileField];
    const data = { [fileField]: stored.billFile, [nameField]: kind === 'company-sign' ? signing.SIGN_METHODS[method] : 'Company stamp' };
    if (kind === 'company-sign') {
      data.agreementCompanySignedBy = signedBy;
      data.agreementCompanySealedAt = new Date();
    }
    const updated = await prisma.client.update({ where: { id: client.id }, data });
    if (previous && previous !== stored.billFile) dropFile(previous);
    await logAudit({
      userId: req.user.id, action: kind === 'company-sign' ? ACTION.sealed : 'TeamLink countersign — company stamp added',
      entity: 'Client', entityId: client.id,
      reason: kind === 'company-sign' ? `${signing.SIGN_METHODS[method]} by ${signedBy}` : null,
    });
    const activated = await lifecycle.maybeAutoActivate(client.id, { actorUserId: req.user.id, via: 'TeamLink countersigned' });
    if (activated) await keepSignedPdf(activated);
    return res.json({ ...signing.executedSummary(activated || updated), autoActivated: !!activated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

const YMD = /^\d{4}-\d{2}-\d{2}$/;
router.patch('/:clientId', requireAuth, async (req, res, next) => {
  try {
    const loaded = await loadForView(req, res, { edit: true });
    if (!loaded) return undefined;
    const b = req.body || {};
    const data = {};
    ['agreementStart', 'agreementEnd'].forEach((k) => {
      if (b[k] === undefined) return;
      const v = String(b[k] || '').trim();
      if (v && !YMD.test(v)) throw Object.assign(new Error(`${k === 'agreementStart' ? 'Start' : 'End'} date must be YYYY-MM-DD.`), { status: 400 });
      data[k] = v || null;
    });
    if (b.agreementSignedCopyNote !== undefined) data.agreementSignedCopyNote = String(b.agreementSignedCopyNote || '').slice(0, 500) || null;
    if (data.agreementStart && data.agreementEnd && data.agreementEnd < data.agreementStart) return res.status(400).json({ error: 'The end date is before the start date.' });
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to change.' });
    const updated = await prisma.client.update({ where: { id: loaded.client.id }, data });
    await logAudit({
      userId: req.user.id, action: 'Agreement details edited', entity: 'Client', entityId: loaded.client.id,
      // Old → new (clients role spec §6): the values before this edit.
      fromValue: Object.keys(data).map((k) => `${k}=${loaded.client[k] == null ? '—' : loaded.client[k]}`).join(', ').slice(0, 500),
      toValue: Object.entries(data).map(([k, v]) => `${k}=${v == null ? '—' : v}`).join(', ').slice(0, 500),
    });
    return res.json(signing.executedSummary(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

router.post('/:clientId/void', requireAuth, async (req, res, next) => {
  try {
    const loaded = await loadForView(req, res, { edit: true });
    if (!loaded) return undefined;
    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'Give the reason for voiding this agreement.' });
    const { client } = loaded;
    const st = signing.statusOf(client);
    if (st === 'DRAFT') return res.status(409).json({ error: 'This agreement is still a draft — nothing to void.' });
    const files = Object.values(KINDS).map(([f]) => client[f]).filter(Boolean);
    const updated = await prisma.client.update({
      where: { id: client.id },
      data: { ...signing.RESET_EXECUTION, agreementStatus: 'DRAFT', agreementActivatedAt: null },
    });
    files.forEach(dropFile);
    await logAudit({ userId: req.user.id, action: ACTION.voided, entity: 'Client', entityId: client.id, fromValue: st, toValue: 'DRAFT', reason });
    return res.json(signing.executedSummary(updated));
  } catch (err) { return next(err); }
});

router.get('/:clientId', requireAuth, async (req, res, next) => {
  try {
    const loaded = await loadForView(req, res);
    if (!loaded) return undefined;
    const { client, access } = loaded;
    const st = signing.statusOf(client);
    const trail = await trailOf(client);
    const lastSend = [...trail].reverse().find((t) => t.event === ACTION.sent || t.event.startsWith('Agreement signing reminder'));
    // The link is handed back to the client's own login and to whoever runs
    // the lifecycle (they send it); never to BDE-view / Accounts.
    // eslint-disable-next-line global-require
    const { can } = require('../utils/permissions');
    const lifecycleUser = access.as !== 'client' && await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'create');
    const link = signing.linkState(client);
    return res.json({
      client: { id: client.id, name: client.name, legalName: client.legalName || null, clientCode: client.clientCode || null },
      document: client.agreementDocument,
      summary: signing.executedSummary(client),
      access,
      start: client.agreementStart, end: client.agreementEnd, feePercent: client.agreementFeePercent,
      signedCopyName: client.agreementSignedCopyName, signedCopyNote: client.agreementSignedCopyNote,
      timeline: access.as === 'client' ? trail.map(({ by, ...t }) => t) : trail,
      lastSend: lastSend || null,
      signingPath: signing.OUT_FOR_SIGNATURE.includes(st) && link.ok && (access.as === 'client' || lifecycleUser) ? signing.pathFor(client) : null,
      linkDays: signing.LINK_DAYS,
      // TeamLink's signer (Agreement settings) for the signature block.
      // eslint-disable-next-line global-require
      ...(await (async () => { const us = await require('../utils/agreement').consultantParty(); return { teamlinkName: us.signatoryName, teamlinkTitle: us.signatoryTitle }; })()),
    });
  } catch (err) { return next(err); }
});

// =========================================================================
// THE CLIENT'S SIDE — by token, no login
// =========================================================================
// Loads the client for a token. `open` = must still be out for signature.
async function byToken(req, res, { open = true } = {}) {
  const client = await signing.findByToken(req.params.token);
  const link = signing.linkState(client);
  if (!link.ok) { res.status(link.code).json({ error: link.error }); return null; }
  if (open && !signing.OUT_FOR_SIGNATURE.includes(signing.statusOf(client))) {
    res.status(409).json({ error: signing.statusOf(client) === 'DRAFT' ? 'This agreement has not been sent for signature.' : 'This agreement has already been signed.' });
    return null;
  }
  return client;
}

// Per IP: 120 calls / 10 min on any token route; codes and sign attempts
// are tighter still (below).
const { rateLimit } = require('../utils/publicRateLimit');
router.use('/token', rateLimit({ bucket: 'agreement-token', max: 120, windowMs: 10 * 60000 }));
const codeLimit = rateLimit({ bucket: 'agreement-code', max: 6, windowMs: 60 * 60000, message: 'Too many codes asked for from your network. Please wait an hour, or ask your TeamLink contact.' });
const signLimit = rateLimit({ bucket: 'agreement-sign', max: 20, windowMs: 10 * 60000 });

router.post('/token/:token/proceed', async (req, res, next) => {
  try {
    const client = await byToken(req, res);
    if (!client) return undefined;
    const steps = await signing.stepsOf(client);
    if (!steps.proceededAt) {
      await logAudit({ action: ACTION.proceeded, entity: 'Client', entityId: client.id, reason: `IP ${ipOf(req)}` });
    }
    const fresh = await prisma.client.findUnique({ where: { id: client.id } });
    return res.json(await signing.publicView(fresh));
  } catch (err) { return next(err); }
});

router.post('/token/:token/signature', async (req, res, next) => {
  try {
    const client = await byToken(req, res);
    if (!client) return undefined;
    const steps = await signing.stepsOf(client);
    if (!steps.proceededAt) return res.status(409).json({ error: 'Read the agreement and press "OK, Proceed" first.' });
    const { stored, fields } = await readUpload(req);
    const method = signing.SIGN_METHODS[fields.method] ? fields.method : 'uploaded';
    const signedBy = String(fields.signedBy || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (signedBy.length < 2 && fields.method === 'typed') { dropFile(stored.billFile); return res.status(400).json({ error: 'Type your full name for the typed signature.' }); }
    const previous = client.agreementClientSignFile;
    const updated = await prisma.client.update({
      where: { id: client.id },
      data: {
        agreementClientSignFile: stored.billFile,
        agreementClientSignName: signing.SIGN_METHODS[method],
        agreementSignedBy: signedBy || client.agreementSignedBy || null,
        agreementSignedByTitle: String(fields.signedByTitle || '').trim().slice(0, 100) || client.agreementSignedByTitle || null,
        agreementClientSealedAt: new Date(),
        // A new signature needs a new code.
        ...signing.RESET_OTP,
      },
    });
    if (previous && previous !== stored.billFile) dropFile(previous);
    await logAudit({
      action: ACTION.signature, entity: 'Client', entityId: client.id, toValue: signing.SIGN_METHODS[method],
      reason: `${signedBy || 'name with the signing'}${updated.agreementSignedByTitle ? `, ${updated.agreementSignedByTitle}` : ''} · IP ${ipOf(req)}`,
    });
    return res.json(await signing.publicView(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// The optional company stamp.
router.post('/token/:token/client-seal', async (req, res, next) => {
  try {
    const client = await byToken(req, res);
    if (!client) return undefined;
    const { stored, fields } = await readUpload(req);
    if (String(fields.kind || 'client-stamp') !== 'client-stamp') {
      dropFile(stored.billFile);
      return res.status(400).json({ error: 'Sign in the signature step; this upload is for the company stamp.' });
    }
    const previous = client.agreementClientStampFile;
    const updated = await prisma.client.update({
      where: { id: client.id },
      data: { agreementClientStampFile: stored.billFile, agreementClientStampName: 'Company stamp' },
    });
    if (previous && previous !== stored.billFile) dropFile(previous);
    await logAudit({ action: ACTION.stamp, entity: 'Client', entityId: client.id, reason: `IP ${ipOf(req)}` });
    return res.json(await signing.publicView(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// THE CODE GOES TO THE REGISTERED MOBILE — the contact number on the client
// record, never a number typed on this page. SMS first; WhatsApp when SMS is
// not set up or fails; email only as the last fallback. The response says
// exactly which channel carried it and where (masked).
async function sendOtp(req, res, next) {
  try {
    const client = await byToken(req, res);
    if (!client) return undefined;
    if (!client.agreementClientSignFile || !client.agreementClientSealedAt) {
      return res.status(409).json({ error: 'Add your signature before requesting the code — the code confirms that signature.' });
    }
    const st = signing.otpState(client);
    if (st.cooldownRemaining > 0) {
      return res.status(429).json({ error: `Please wait ${st.cooldownRemaining} seconds before requesting another code.`, retryAfter: st.cooldownRemaining });
    }
    const steps = await signing.stepsOf(client);
    if (steps.otpSends >= signing.OTP_MAX_SENDS) {
      return res.status(429).json({ error: 'Too many codes have been requested on this link. Ask TeamLink to send the agreement again.' });
    }
    // eslint-disable-next-line global-require
    const messaging = require('../utils/messaging');
    // eslint-disable-next-line global-require
    const core = require('../utils/messagingCore');
    const c = lifecycle.contactsOf(client);
    const plan = [
      { channel: 'SMS', to: c.mobile, label: `SMS to ${core.maskMobile(c.mobile) || 'the registered mobile'}` },
      { channel: 'WhatsApp', to: c.whatsapp, label: `WhatsApp to ${core.maskMobile(c.whatsapp) || 'the registered mobile'}` },
      { channel: 'Email', to: c.email, label: `email to ${core.maskEmail(c.email) || 'the registered email'}` },
    ];
    const otp = await signing.issueOtp(client, { destinationLabel: null });
    const text = `${otp} is your TeamLink agreement signing code for ${client.agreementId || 'your agreement'}. It is valid for ${signing.OTP_TTL_MINUTES} minutes. Do not share it.`;
    const tried = [];
    let used = null;
    // eslint-disable-next-line no-restricted-syntax
    for (const step of plan) {
      if (!step.to) { tried.push({ channel: step.channel, outcome: 'Skipped', error: `No ${step.channel === 'Email' ? 'email' : 'mobile number'} on the client record` }); continue; }
      // eslint-disable-next-line no-await-in-loop
      const r = await messaging.send(step.channel, {
        to: step.to, kind: 'otp', text, vars: step.channel === 'SMS' ? [otp, signing.OTP_TTL_MINUTES] : [otp],
        subject: `Your agreement signing code — ${client.agreementId || 'TeamLink'}`, fromName: '',
      });
      tried.push({ channel: step.channel, outcome: r.outcome, error: r.ok ? null : r.error });
      if (r.ok) { used = step; break; }
    }
    if (!used) {
      await prisma.client.update({ where: { id: client.id }, data: signing.RESET_OTP });
      await logAudit({
        action: ACTION.otpFailed, entity: 'Client', entityId: client.id,
        reason: tried.map((t) => `${t.channel}: ${t.outcome}${t.error ? ` (${t.error})` : ''}`).join(' | ').slice(0, 1000),
      });
      return res.status(503).json({
        error: 'We could not deliver a code to your registered contact right now. Please contact your TeamLink account manager.',
        tried: tried.map((t) => ({ channel: t.channel, outcome: t.outcome })),
      });
    }
    await prisma.client.update({ where: { id: client.id }, data: { agreementVerifyMobile: used.label } });
    await logAudit({
      action: ACTION.otpSent, entity: 'Client', entityId: client.id, toValue: used.label,
      reason: tried.map((t) => `${t.channel}: ${t.outcome}${t.error ? ` (${t.error})` : ''}`).join(' | ').slice(0, 1000),
    });
    const fallbackNote = used.channel === 'Email'
      ? 'SMS and WhatsApp could not be used, so the code was sent by email instead.'
      : (used.channel === 'WhatsApp' ? 'SMS could not be used, so the code was sent on WhatsApp.' : null);
    return res.json({
      sentVia: used.channel,
      destination: used.label,
      ttlMinutes: signing.OTP_TTL_MINUTES,
      resendInSeconds: signing.OTP_RESEND_COOLDOWN_S,
      attemptsLeft: signing.OTP_MAX_ATTEMPTS,
      note: fallbackNote,
      tried: tried.map((t) => ({ channel: t.channel, outcome: t.outcome })),
    });
  } catch (err) { return next(err); }
}
router.post('/token/:token/otp/send', sendOtp);
router.post('/token/:token/verify/start', sendOtp);

async function verifyOtp(req, res, next) {
  try {
    const client = await byToken(req, res);
    if (!client) return undefined;
    const checked = await signing.checkOtp(client, (req.body || {}).otp);
    if (!checked.ok) {
      if (checked.attemptsLeft !== undefined) {
        await logAudit({
          action: checked.locked ? ACTION.otpLocked : ACTION.otpWrong, entity: 'Client', entityId: client.id,
          reason: `${checked.attemptsLeft} attempt(s) left · IP ${ipOf(req)}`,
        });
      }
      return res.status(checked.locked ? 423 : 400).json({ error: checked.error, attemptsLeft: checked.attemptsLeft, locked: !!checked.locked, expired: !!checked.expired });
    }
    const from = signing.statusOf(client);
    // Conditional on the status so two racing submits cannot both sign.
    const done = await prisma.client.updateMany({
      where: { id: client.id, agreementStatus: client.agreementStatus },
      data: {
        agreementStatus: 'SIGNED',
        agreementSignedAt: new Date(),
        agreementVerifiedAt: new Date(),
        agreementVerifyNote: null,
        ...signing.RESET_OTP,
      },
    });
    if (!done.count) return res.status(409).json({ error: 'This agreement has already been signed.' });
    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    await logAudit({
      action: ACTION.verified, entity: 'Client', entityId: client.id, fromValue: from, toValue: 'SIGNED',
      reason: `Code sent by ${updated.agreementVerifyMobile || 'the registered contact'} · signed by ${updated.agreementSignedBy || '—'} · IP ${ipOf(req)}`,
    });
    await notifySigned(client, updated, updated.agreementVerifyMobile || 'registered contact');
    const activated = await lifecycle.maybeAutoActivate(client.id, { via: 'client signed with OTP after TeamLink countersigned' });
    // eslint-disable-next-line global-require
    if (!activated) await require('../utils/agreementActivateReminders').notifyClientSigned(updated);
    const view = await signing.publicView(activated || updated);
    return res.json({ ...view, autoActivated: !!activated, summary: signing.executedSummary(activated || updated) });
  } catch (err) { return next(err); }
}
router.post('/token/:token/otp/verify', verifyOtp);
router.post('/token/:token/verify/confirm', verifyOtp);

// ---------------------------------------------------------------------------
// THE ONE-PAGE LINK (2026-10-05): read -> email code -> name + designation ->
// "I agree and sign". The code goes ONLY to the client contact's email on the
// client record (never an address typed on the page).
// ---------------------------------------------------------------------------
router.post('/token/:token/email-code', codeLimit, async (req, res, next) => {
  try {
    const client = await byToken(req, res);
    if (!client) return undefined;
    const st = signing.otpState(client);
    if (st.cooldownRemaining > 0) {
      return res.status(429).json({ error: `Please wait ${st.cooldownRemaining} seconds before asking for another code.`, retryAfter: st.cooldownRemaining });
    }
    const steps = await signing.stepsOf(client);
    if (steps.otpSends >= signing.OTP_MAX_SENDS) {
      return res.status(429).json({ error: 'Too many codes were asked for on this link. Ask TeamLink for a new link.' });
    }
    // eslint-disable-next-line global-require
    const messaging = require('../utils/messaging');
    // eslint-disable-next-line global-require
    const core = require('../utils/messagingCore');
    const email = lifecycle.contactsOf(client).email;
    if (!email) return res.status(409).json({ error: 'There is no email on your company record. Ask your TeamLink contact to add it.' });
    const label = `email to ${core.maskEmail(email) || 'your registered email'}`;
    const otp = await signing.issueOtp(client, { destinationLabel: label });
    await prisma.client.update({ where: { id: client.id }, data: { agreementVerifyMethod: 'EMAIL_OTP' } });
    const r = await messaging.send('Email', {
      to: email,
      subject: `Your agreement code — ${client.agreementId || 'TeamLink'}`,
      text: [
        'Hello,', '',
        `${otp} is your code to sign the TeamLink service agreement ${client.agreementId || ''} for ${client.name}.`,
        `It works for ${signing.OTP_TTL_MINUTES} minutes. Do not share it with anyone.`, '',
        'If you did not ask for this code, you can ignore this email.', '', '— TeamLink Consultants',
      ].join('\n'),
      fromName: '',
    });
    if (!r.ok) {
      await prisma.client.update({ where: { id: client.id }, data: signing.RESET_OTP });
      await logAudit({ action: ACTION.otpFailed, entity: 'Client', entityId: client.id, reason: `Email: ${r.outcome}${r.error ? ` (${r.error})` : ''}`.slice(0, 1000) });
      return res.status(503).json({ error: 'We could not email you a code right now. Please try again in a few minutes, or ask your TeamLink contact.' });
    }
    await logAudit({ action: ACTION.otpSent, entity: 'Client', entityId: client.id, toValue: label, reason: `Email: ${r.outcome} · IP ${ipOf(req)}` });
    return res.json({ sentTo: label, ttlMinutes: signing.OTP_TTL_MINUTES, resendInSeconds: signing.OTP_RESEND_COOLDOWN_S, attemptsLeft: signing.OTP_MAX_ATTEMPTS });
  } catch (err) { return next(err); }
});

router.post('/token/:token/agree-sign', signLimit, async (req, res, next) => {
  try {
    const client = await byToken(req, res);
    if (!client) return undefined;
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const designation = String(b.designation || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (name.length < 2) return res.status(400).json({ error: 'Type your full name.' });
    if (designation.length < 2) return res.status(400).json({ error: 'Type your designation (for example HR Manager).' });
    if (b.agree !== true) return res.status(400).json({ error: 'Tick "I have read and agree" first.' });
    // 2026-10-05 (user): e-sign AND company stamp from the client side.
    const steps0 = await signing.stepsOf(client);
    if (!steps0.proceededAt) return res.status(409).json({ error: 'Read the agreement and press "OK, proceed" first.', step: 'read' });
    if (!client.agreementClientSignFile) return res.status(409).json({ error: 'Add your signature first (draw, type or upload).', step: 'sign' });
    if (!client.agreementClientStampFile) return res.status(409).json({ error: 'Upload your company stamp / seal first.', step: 'stamp' });
    const checked = await signing.checkOtp(client, b.otp);
    if (!checked.ok) {
      if (checked.attemptsLeft !== undefined) {
        await logAudit({
          action: checked.locked ? ACTION.otpLocked : ACTION.otpWrong, entity: 'Client', entityId: client.id,
          reason: `${checked.attemptsLeft} attempt(s) left · IP ${ipOf(req)}`,
        });
      }
      return res.status(checked.locked ? 423 : 400).json({ error: checked.error, attemptsLeft: checked.attemptsLeft, locked: !!checked.locked, expired: !!checked.expired });
    }
    const from = signing.statusOf(client);
    const now = new Date();
    const ip = ipOf(req);
    const ua = String(req.headers['user-agent'] || '').slice(0, 160);
    // Conditional on the status so two racing submits cannot both sign.
    const done = await prisma.client.updateMany({
      where: { id: client.id, agreementStatus: client.agreementStatus },
      data: {
        agreementStatus: 'SIGNED',
        agreementSignedAt: now,
        agreementVerifiedAt: now,
        agreementSignedBy: name,
        agreementSignedByTitle: designation,
        agreementClientSealedAt: now,
        agreementVerifyMethod: 'EMAIL_OTP',
        agreementViewedAt: client.agreementViewedAt || now,
        agreementVerifyNote: `Signed from IP ${ip}`.slice(0, 200),
        ...signing.RESET_OTP,
      },
    });
    if (!done.count) return res.status(409).json({ error: 'This agreement has already been signed.' });
    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    await logAudit({
      action: ACTION.verified, entity: 'Client', entityId: client.id, fromValue: from, toValue: 'SIGNED',
      reason: `"I agree and sign" by ${name}, ${designation} · code sent by ${updated.agreementVerifyMobile || 'email'} · IP ${ip}${ua ? ` · ${ua}` : ''}`.slice(0, 1000),
    });
    await notifySigned(client, updated, updated.agreementVerifyMobile || 'email');
    // TeamLink's saved signature + stamp, if this agreement still lacks them.
    // eslint-disable-next-line global-require
    await require('../utils/teamlinkSeal').applyDefaults(updated, { via: 'saved TeamLink signature & stamp (countersign)' });
    const activated = await lifecycle.maybeAutoActivate(client.id, { via: 'client signed on the agreement link after TeamLink countersigned' });
    // Not Active yet: the BDE(s) + Admins + Super Admins are told to sign & stamp
    // for TeamLink and make it Active (and reminded daily until it is).
    // eslint-disable-next-line global-require
    if (!activated) await require('../utils/agreementActivateReminders').notifyClientSigned(await prisma.client.findUnique({ where: { id: client.id } }));
    const kept = await keepSignedPdf(activated || await prisma.client.findUnique({ where: { id: client.id } }));
    const view = await signing.publicView(activated || updated);
    return res.json({ ...view, autoActivated: !!activated, pdfKept: !!kept });
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// AADHAAR eSIGN AT eMUDHRA (2026-10-05) — utils/emudhra.js has the official
// doc links and the honesty rules.
//   POST /agreement/token/:token/emudhra/start   name, designation, agree →
//        the agreement PDF (with the client's company stamp and TeamLink's
//        side) is encrypted for eMudhra's Signer Gateway; the page posts the
//        form there and the client signs with Aadhaar OTP on eMudhra's page.
//   POST /agreement/emudhra/return/:ref/:kind     where eMudhra sends the
//        browser back (success / failure / cancel). The posted form is NOT
//        trusted: Signed only after eMudhra's status API says Completed and the
//        signed PDF is fetched, decrypted and carries a digital signature.
// Our email code is skipped on this path: eMudhra's Aadhaar OTP is the
// identity check. The Aadhaar number never reaches TeamLink.
// ---------------------------------------------------------------------------
const EMUDHRA_KEPT = 'eMudhra-signed PDF kept (legal copy)';
const emudhraLimit = rateLimit({ bucket: 'agreement-emudhra', max: 20, windowMs: 10 * 60000 });
function frontBase(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/+$/, '');
  const o = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
  return o ? String(o).replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`;
}

router.post('/token/:token/emudhra/start', emudhraLimit, async (req, res, next) => {
  try {
    const client = await byToken(req, res);
    if (!client) return undefined;
    // eslint-disable-next-line global-require
    const emudhra = require('../utils/emudhra');
    if (!(await emudhra.isAvailable())) return res.status(409).json({ error: 'Aadhaar eSign is not available yet. Please use another way to sign.', notAvailable: true });
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const designation = String(b.designation || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    const steps = await signing.stepsOf(client);
    if (!steps.proceededAt) return res.status(409).json({ error: 'Read the agreement and press "OK, proceed" first.', step: 'read' });
    if (!client.agreementClientStampFile) return res.status(409).json({ error: 'Upload your company stamp / seal first.', step: 'stamp' });
    if (name.length < 2) return res.status(400).json({ error: 'Type your full name (as on Aadhaar).' });
    if (designation.length < 2) return res.status(400).json({ error: 'Type your designation (for example HR Manager).' });
    if (b.agree !== true) return res.status(400).json({ error: 'Tick "I have read and agree" first.' });
    // TeamLink's saved signature + stamp go on first, so the PDF eMudhra signs is complete.
    // eslint-disable-next-line global-require
    await require('../utils/teamlinkSeal').applyDefaults(client, { via: 'saved TeamLink signature & stamp (before eMudhra eSign)' });
    const fresh = await prisma.client.update({ where: { id: client.id }, data: { agreementSignedBy: name, agreementSignedByTitle: designation } });
    // eslint-disable-next-line global-require
    const { PassThrough } = require('stream');
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve, reject) => { sink.on('end', resolve); sink.on('error', reject); });
    // eslint-disable-next-line global-require
    const us = await require('../utils/agreement').consultantParty();
    // eslint-disable-next-line global-require
    await require('../utils/agreementPdf').renderAgreementPdf({ ...fresh, agreementEsignProvider: 'eMudhra' }, { consultantName: us.name, agreementOnly: true }, sink);
    await done;
    const base = frontBase(req);
    const form = await emudhra.startSession({ client: fresh, pdf: Buffer.concat(chunks), signerName: name, returnBase: base });
    await prisma.appSetting.update({ where: { key: `${emudhra.SESSION_PREFIX}${form.ref}` }, data: { value: JSON.stringify({ ...(await emudhra.readSession(form.ref)), frontBase: base }) } });
    await logAudit({ action: 'Agreement sent to eMudhra for Aadhaar eSign', entity: 'Client', entityId: client.id, toValue: form.ref, reason: `${name}, ${designation} · IP ${ipOf(req)}` });
    return res.json({ gatewayUrl: form.gatewayUrl, fields: form.fields, ref: form.ref });
  } catch (err) {
    if (err.code === 'NOT_READY') return res.status(409).json({ error: 'Aadhaar eSign is not available yet. Please use another way to sign.', notAvailable: true });
    return next(err);
  }
});

const plainPage = (res, code, text) => res.status(code).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agreement</title><body style="font-family:system-ui;padding:24px;max-width:560px;margin:auto"><h2>Agreement signing</h2><p>${text}</p></body>`);

router.post('/emudhra/return/:ref/:kind', emudhraLimit, require('express').urlencoded({ extended: false, limit: '30mb' }), async (req, res, next) => {
  try {
    // eslint-disable-next-line global-require
    const emudhra = require('../utils/emudhra');
    const ref = String(req.params.ref || '');
    const kind = String(req.params.kind || '');
    const session = await emudhra.readSession(ref);
    if (!session || !['success', 'failure', 'cancel'].includes(kind)) return plainPage(res, 400, 'This signing reply was not recognised, so nothing was changed.');
    const client = await prisma.client.findUnique({ where: { id: session.clientId } });
    const token = client ? signing.tokenFor(client) : null;
    const back = (state, why) => res.redirect(303, `${session.frontBase || ''}/agreement/${token || ''}?emudhra=${state}${why ? `&why=${encodeURIComponent(why)}` : ''}`);
    if (!client || !token) return plainPage(res, 410, 'This agreement link is no longer open. Ask your TeamLink contact.');
    const b = req.body || {};
    if (session.status !== 'Started') return plainPage(res, 409, 'This signing reply was already handled, so nothing was changed.');
    if (kind !== 'success' || String(b.ReturnStatus || '').toLowerCase() !== 'success') {
      await emudhra.closeSession(ref, kind === 'cancel' ? 'Cancelled' : 'Failed');
      await logAudit({ action: kind === 'cancel' ? 'eMudhra eSign cancelled by the signer' : 'eMudhra eSign failed', entity: 'Client', entityId: client.id, toValue: ref, reason: String(b.ErrorMessage || '').slice(0, 300) || null });
      return back(kind === 'cancel' ? 'cancelled' : 'failed', String(b.ErrorMessage || '').slice(0, 160));
    }
    const v = await emudhra.verifyAndFetch({ ref, postedTxn: b.Transactionnumber });
    if (!v.ok) {
      if (v.refuse) return plainPage(res, 400, 'This signing reply could not be verified, so nothing was changed.');
      await emudhra.closeSession(ref, 'Failed');
      await logAudit({ action: 'eMudhra eSign not confirmed — not signed', entity: 'Client', entityId: client.id, toValue: ref, reason: v.reason.slice(0, 300) });
      // The technical detail stays in the audit; the client gets plain words.
      return back('failed', v.reason.replace(/\s*\(.*\)\s*$/, ''));
    }
    // Verified by eMudhra: keep their signed PDF untouched as the legal copy.
    const stored = attachments.store({ data: v.pdf, contentType: 'application/pdf', filename: `${client.agreementId || 'agreement'}-emudhra-signed.pdf` }, { maxBytes: 25 * 1024 * 1024 });
    const sha = require('crypto').createHash('sha256').update(v.pdf).digest('hex'); // eslint-disable-line global-require
    const now = new Date();
    const from = signing.statusOf(client);
    const doneUpd = await prisma.client.updateMany({
      where: { id: client.id, agreementStatus: { in: signing.OUT_FOR_SIGNATURE } },
      data: {
        agreementStatus: 'SIGNED', agreementSignedAt: now, agreementVerifiedAt: now, agreementClientSealedAt: now,
        agreementVerifyMethod: 'EMUDHRA_AADHAAR_ESIGN', agreementVerifyMobile: 'Aadhaar OTP at eMudhra',
        agreementEsignProvider: 'eMudhra', agreementEsignTxnId: v.transactionNumber.slice(0, 80),
        agreementClientSignName: 'Aadhaar eSign (eMudhra)', agreementVerifyNote: `eMudhra transaction ${v.transactionNumber}`.slice(0, 200),
        ...signing.RESET_OTP,
      },
    });
    await emudhra.closeSession(ref, doneUpd.count ? 'Signed' : 'Late');
    if (!doneUpd.count) return back('failed', 'This agreement is no longer open for signing.');
    await logAudit({ action: EMUDHRA_KEPT, entity: 'Client', entityId: client.id, toValue: stored.billFile, reason: `${stored.billSize} bytes · sha256 ${sha} · eMudhra transaction ${v.transactionNumber}` });
    await logAudit({ action: ACTION.verified, entity: 'Client', entityId: client.id, fromValue: from, toValue: 'SIGNED', reason: `Aadhaar eSign at eMudhra by ${client.agreementSignedBy || '—'}${client.agreementSignedByTitle ? `, ${client.agreementSignedByTitle}` : ''} · transaction ${v.transactionNumber} · confirmed by eMudhra's status API` });
    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    await notifySigned(client, updated, 'Aadhaar eSign at eMudhra');
    // eslint-disable-next-line global-require
    await require('../utils/teamlinkSeal').applyDefaults(updated, { via: 'saved TeamLink signature & stamp (countersign)' });
    const activated = await lifecycle.maybeAutoActivate(client.id, { via: 'client signed with Aadhaar eSign (eMudhra) after TeamLink countersigned' });
    // eslint-disable-next-line global-require
    if (!activated) await require('../utils/agreementActivateReminders').notifyClientSigned(updated);
    // Our audit appendix is a SEPARATE PDF; eMudhra's signed file is never changed.
    await keepSignedPdf(activated || await prisma.client.findUnique({ where: { id: client.id } }));
    return back('signed');
  } catch (err) { return next(err); }
});

// THE SIGNED COPY IS KEPT: the PDF exactly as it stood at the client's
// signature, stored in the upload folder; the audit row names the file, so
// the record of what was signed survives later countersigns or a void.
const KEPT_ACTION = 'Signed agreement PDF kept';
async function keepSignedPdf(client) {
  try {
    // eslint-disable-next-line global-require
    const { consultantParty } = require('../utils/agreement');
    // eslint-disable-next-line global-require
    const { PassThrough } = require('stream');
    const us = await consultantParty();
    const trail = await trailOf(client, { sinceSend: true });
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', (c) => chunks.push(c));
    const finished = new Promise((resolve, reject) => { sink.on('end', resolve); sink.on('error', reject); });
    // eslint-disable-next-line global-require
    await require('../utils/agreementPdf').renderAgreementPdf(client, { trail, consultantName: us.name }, sink);
    await finished;
    const stored = attachments.store({ data: Buffer.concat(chunks), contentType: 'application/pdf', filename: `${client.agreementId || 'agreement'}-signed.pdf` }, { maxBytes: 20 * 1024 * 1024 });
    const sha = require('crypto').createHash('sha256').update(Buffer.concat(chunks)).digest('hex'); // eslint-disable-line global-require
    await logAudit({ action: KEPT_ACTION, entity: 'Client', entityId: client.id, toValue: stored.billFile, reason: `${stored.billSize} bytes · sha256 ${sha} · ${client.agreementStatus === 'ACTIVE' ? 'fully signed (both sides)' : 'as signed by the client'} ${new Date(client.agreementSignedAt).toISOString()}` });
    return stored.billFile;
  } catch (err) {
    console.error('[agreement] could not keep the signed PDF:', err.message);
    return null;
  }
}
// The kept file for the CURRENT signature (null if none).
async function keptPdfOf(client) {
  if (!client.agreementSignedAt) return null;
  const row = await prisma.auditLog.findFirst({
    where: { entity: 'Client', entityId: client.id, action: KEPT_ACTION, createdAt: { gte: new Date(new Date(client.agreementSignedAt).getTime() - 1000) } },
    orderBy: { createdAt: 'desc' }, select: { toValue: true },
  });
  return row ? attachments.resolveStored(row.toValue) : null;
}

router.get('/token/:token/pdf', async (req, res, next) => {
  try {
    const client = await byToken(req, res, { open: false });
    if (!client) return undefined;
    if (req.query.copy === 'emudhra') {
      const row = await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: client.id, action: EMUDHRA_KEPT }, orderBy: { createdAt: 'desc' }, select: { toValue: true } });
      const file = row ? attachments.resolveStored(row.toValue) : null;
      if (!file) return res.status(404).json({ error: 'There is no eMudhra-signed copy for this agreement.' });
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${(client.agreementId || 'agreement').replace(/[^\w.-]/g, '')}-eMudhra-signed.pdf"`);
      return res.sendFile(file);
    }
    if (!signing.executedSummary(client).pdfAvailable) return res.status(409).json({ error: 'The PDF is available once the agreement is signed.' });
    // eslint-disable-next-line global-require
    const { consultantParty } = require('../utils/agreement');
    const us = await consultantParty();
    const trail = await trailOf(client, { sinceSend: true });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${(client.agreementId || 'agreement').replace(/[^\w.-]/g, '')}.pdf"`);
    // eslint-disable-next-line global-require
    await require('../utils/agreementPdf').renderAgreementPdf(client, { trail, consultantName: us.name }, res);
    return undefined;
  } catch (err) { return next(err); }
});

router.get('/token/:token/file/:kind', async (req, res, next) => {
  try {
    const mapping = KINDS[req.params.kind];
    if (!mapping) return res.status(404).json({ error: 'Unknown image' });
    const client = await byToken(req, res, { open: false });
    if (!client) return undefined;
    const stored = client[mapping[0]];
    const resolved = stored ? attachments.resolveStored(stored) : null;
    if (!resolved) return res.status(404).json({ error: 'Nothing uploaded for that' });
    res.set('Cache-Control', 'private, no-store');
    return res.sendFile(resolved);
  } catch (err) { return next(err); }
});

// SA / Admin: create / copy / stop / email the agreement link.
require('./agreementLinkRoutes')(router, { loadForView, keptPdfOf });

module.exports = router;
