// ---------------------------------------------------------------------------
// AGREEMENT EXECUTION — the seals and the verified signature.
//
// Mounted at /api/agreement. Two audiences, deliberately separated:
//
//   OUR SIDE, behind a login and the Agreement Lifecycle permission
//     POST /agreement/:clientId/company-seal    apply our stamp + signature
//     GET  /agreement/:clientId/executed        the executed summary
//     GET  /agreement/:clientId/file/:kind      view a stored stamp/signature
//
//   THE CLIENT'S SIDE, reached by the tokenised link with NO login
//     POST /agreement/token/:token/client-seal  their stamp + signature
//     POST /agreement/token/:token/verify/start  choose Aadhaar or alternative
//     POST /agreement/token/:token/verify/confirm  the OTP
//
// WHY THE CLIENT ROUTES TAKE A TOKEN AND NOT A LOGIN. The signatory at the
// client is a person with an email and a phone, not a TeamLink user — the same
// reason routes/public.js already serves the agreement itself by token. The
// token is the authorisation, it addresses exactly one client's agreement, and
// nothing here will read or write any other.
//
// THE FULL AADHAAR NUMBER IS NEVER STORED. utils/agreementSigning.js validates
// it, keeps the last four digits and drops the rest. See the note there.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const signing = require('../utils/agreementSigning');
const mailer = require('../utils/mailer');
const { notifyUsers } = require('../utils/notify');

const router = express.Router();

// Which of the four stored images a request is asking about. Named rather
// than free text so a path can never address a file outside this set.
const KINDS = {
  'company-stamp': ['agreementCompanyStampFile', 'agreementCompanyStampName'],
  'company-sign': ['agreementCompanySignFile', 'agreementCompanySignName'],
  'client-stamp': ['agreementClientStampFile', 'agreementClientStampName'],
  'client-sign': ['agreementClientSignFile', 'agreementClientSignName'],
};

// Read one uploaded image out of a multipart body, with the field name saying
// which it is. Returns { file, fields } or throws with a .status.
async function readUpload(req) {
  let parsed;
  try {
    parsed = await attachments.parseMultipart(req);
  } catch (err) {
    if (err.code === 'NOT_MULTIPART') throw Object.assign(new Error('Send the image as a form upload.'), { status: 400 });
    if (err.code === 'TOO_LARGE') throw Object.assign(new Error('That image is over 5 MB.'), { status: 413 });
    throw err;
  }
  if (!parsed.file) throw Object.assign(new Error('Choose an image to upload.'), { status: 400 });
  let stored;
  try {
    stored = attachments.store(parsed.file);
  } catch (err) {
    throw Object.assign(new Error(attachments.MESSAGE[err.code] || 'That file could not be stored.'), { status: 400 });
  }
  return { stored, fields: parsed.fields };
}

// =========================================================================
// OUR SIDE
// =========================================================================
router.post(
  '/:clientId/company-seal',
  requireAuth,
  requirePerm('ats', 'clients', 'Agreement Lifecycle', 'create'),
  async (req, res, next) => {
    try {
      const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
      if (!client) return res.status(404).json({ error: 'Client not found' });
      // THE SEAL GOES ON BEFORE IT GOES OUT. Stamping a document the client has
      // already signed would change what they signed.
      if (client.agreementClientSealedAt) {
        return res.status(409).json({ error: 'The client has already sealed this agreement — our seal cannot be changed now. Regenerate the agreement to start again.' });
      }
      const { stored, fields } = await readUpload(req);
      const kind = String(fields.kind || '').trim();
      if (!['company-stamp', 'company-sign'].includes(kind)) {
        return res.status(400).json({ error: 'Say which image this is: company-stamp or company-sign.' });
      }
      const [fileField, nameField] = KINDS[kind];
      const updated = await prisma.client.update({
        where: { id: client.id },
        data: {
          [fileField]: stored.billFile,
          [nameField]: stored.billName,
          agreementCompanySignedBy: fields.signedBy || client.agreementCompanySignedBy || req.user.name,
          // Sealed once BOTH the stamp and the signature are on.
          agreementCompanySealedAt:
            (kind === 'company-stamp' ? client.agreementCompanySignFile : client.agreementCompanyStampFile)
              ? new Date()
              : client.agreementCompanySealedAt,
        },
      });
      await logAudit({
        userId: req.user.id, action: `Agreement ${kind.replace('-', ' ')} applied`,
        entity: 'Client', entityId: client.id,
      });
      return res.json(signing.executedSummary(updated));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      return next(err);
    }
  },
);

// The executed summary, for whoever is allowed to see it.
router.get('/:clientId/executed', requireAuth, async (req, res, next) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const access = signing.agreementAccess(req.user, client);
    if (!access.view) {
      return res.status(403).json({
        error: 'The executed agreement is visible to the BDE, the Super Admin, the Admin, the Accountant and the client it belongs to.',
      });
    }
    return res.json({ ...signing.executedSummary(client), access });
  } catch (err) { return next(err); }
});

// One stored image, streamed. Same permission as the summary.
router.get('/:clientId/file/:kind', requireAuth, async (req, res, next) => {
  try {
    const mapping = KINDS[req.params.kind];
    if (!mapping) return res.status(404).json({ error: 'Unknown image' });
    const client = await prisma.client.findUnique({ where: { id: req.params.clientId } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!signing.agreementAccess(req.user, client).view) {
      return res.status(403).json({ error: 'This record is outside your access' });
    }
    const stored = client[mapping[0]];
    if (!stored) return res.status(404).json({ error: 'Nothing uploaded for that' });
    const resolved = attachments.resolveStored(stored);
    if (!resolved) return res.status(404).json({ error: 'That file is no longer on disk' });
    return res.sendFile(resolved);
  } catch (err) { return next(err); }
});

// =========================================================================
// THE CLIENT'S SIDE — by token, no login
// =========================================================================
async function byToken(token) {
  if (!token) return null;
  return prisma.client.findUnique({ where: { esignToken: token } });
}

router.post('/token/:token/client-seal', async (req, res, next) => {
  try {
    const client = await byToken(req.params.token);
    if (!client || !client.agreementDocument) {
      return res.status(404).json({ error: 'This signing link is not valid — ask TeamLink to resend it.' });
    }
    if (client.agreementVerifiedAt) {
      return res.status(409).json({ error: 'This agreement has already been signed and verified.' });
    }
    const { stored, fields } = await readUpload(req);
    const kind = String(fields.kind || '').trim();
    if (!['client-stamp', 'client-sign'].includes(kind)) {
      return res.status(400).json({ error: 'Say which image this is: client-stamp or client-sign.' });
    }
    const [fileField, nameField] = KINDS[kind];
    const updated = await prisma.client.update({
      where: { id: client.id },
      data: {
        [fileField]: stored.billFile,
        [nameField]: stored.billName,
        agreementSignedBy: fields.signedBy || client.agreementSignedBy || null,
        agreementSignedByTitle: fields.signedByTitle || client.agreementSignedByTitle || null,
        agreementClientSealedAt:
          (kind === 'client-stamp' ? client.agreementClientSignFile : client.agreementClientStampFile)
            ? new Date()
            : client.agreementClientSealedAt,
      },
    });
    await logAudit({
      action: `Agreement ${kind.replace('-', ' ')} uploaded by the client`,
      entity: 'Client', entityId: client.id,
    });
    return res.json(signing.executedSummary(updated));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// The client clicked Done and chose how to verify.
router.post('/token/:token/verify/start', async (req, res, next) => {
  try {
    const client = await byToken(req.params.token);
    if (!client || !client.agreementDocument) {
      return res.status(404).json({ error: 'This signing link is not valid — ask TeamLink to resend it.' });
    }
    if (client.agreementVerifiedAt) {
      return res.status(409).json({ error: 'This agreement has already been verified.' });
    }
    const started = await signing.startVerification(client, {
      method: req.body.method,
      aadhaar: req.body.aadhaar,
      mobile: req.body.mobile,
    });
    if (started.error) return res.status(400).json({ error: started.error });

    // THE CODE IS DELIVERED, NEVER RETURNED. Sending it back in the response
    // would let anyone holding the link sign without the phone.
    let delivered = 'not sent';
    const cfg = await mailer.emailConfig().catch(() => ({ configured: false }));
    if (cfg.configured && client.contactEmail) {
      try {
        await mailer.sendMail({
          to: client.contactEmail,
          subject: `Verification code for agreement ${client.agreementId || ''}`.trim(),
          text: `Your verification code is ${started.otp}. It expires in ${started.ttlMinutes} minutes.`,
        });
        delivered = `emailed to ${client.contactEmail}`;
      } catch { delivered = 'could not be emailed'; }
    }

    await logAudit({
      action: `Agreement verification started (${started.method})`,
      entity: 'Client', entityId: client.id,
    });
    return res.json({
      method: started.method,
      mobile: started.masked,
      ttlMinutes: started.ttlMinutes,
      delivery: delivered,
      // Said plainly rather than implied: with no SMS provider connected the
      // code cannot reach the phone, and the person signing needs to know
      // where to look for it.
      note: delivered === 'not sent'
        ? 'No email or SMS provider is connected to this installation, so the code could not be delivered automatically. Ask TeamLink for it.'
        : null,
    });
  } catch (err) { return next(err); }
});

router.post('/token/:token/verify/confirm', async (req, res, next) => {
  try {
    const client = await byToken(req.params.token);
    if (!client || !client.agreementDocument) {
      return res.status(404).json({ error: 'This signing link is not valid — ask TeamLink to resend it.' });
    }
    const done = await signing.confirmVerification(client, { otp: req.body.otp });
    if (done.error) return res.status(400).json({ error: done.error });

    // Verified: the agreement is executed and signed.
    const updated = await prisma.client.update({
      where: { id: client.id },
      data: {
        agreementStatus: 'SIGNED',
        agreementSignedAt: client.agreementSignedAt || new Date(),
        agreementSignedBy: client.agreementSignedBy || done.client.agreementSignedBy,
      },
    });
    await logAudit({
      action: `Agreement verified and signed (${done.verifiedBy})`,
      entity: 'Client', entityId: client.id, toValue: 'SIGNED',
    });

    // Everybody who is allowed to see it is told it exists.
    const audience = await prisma.user.findMany({
      where: {
        OR: [
          { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
          { atsRole: { in: ['SUPER_ADMIN', 'ADMIN', 'BDE', 'MANAGER'] } },
          { accountsRole: { not: null } },
          { clientId: client.id },
        ],
      },
      select: { id: true },
    });
    await notifyUsers(audience.map((u) => u.id), {
      title: `${client.name} — agreement executed`,
      message: `${updated.agreementId || 'The agreement'} is signed and verified (${done.verifiedBy}). Requirements can now be raised against this client.`,
    });

    return res.json({
      ...signing.executedSummary(updated),
      verifiedBy: done.verifiedBy,
      note: done.note,
    });
  } catch (err) { return next(err); }
});

module.exports = router;
