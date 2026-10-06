// ---------------------------------------------------------------------------
// THE AGREEMENT LINK — our side (2026-10-05). Mounted into routes/agreementSeal.js
// (/api/agreement), so it shares its access check (loadForView).
//
//   GET  /agreement/:clientId/link          the current link: url, valid until,
//                                           stopped?, WhatsApp text, where email goes
//   POST /agreement/:clientId/link          make a NEW link { days } — the old one
//                                           stops working. DRAFT -> SENT. Nothing
//                                           is sent: the screen offers Copy /
//                                           WhatsApp / Email.
//   POST /agreement/:clientId/link/revoke   stop the link; back to DRAFT
//   POST /agreement/:clientId/link/email    email the link to the client contact
//                                           (only when the user presses it; the
//                                           sandbox mailer is fake)
//
// WHO: Super Admin / Admin — 'Agreement Lifecycle' create, the same right as
// "Send to client" (utils/permissions.js; spec 6: a BDE VIEWS their own
// clients' agreements and does not send). Scope: loadForView (the client must
// be one this login may see).
//
// The token is stored hashed (utils/agreementSigning.js newLinkData /
// tokenFor). Every step is audited on the client.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { can, requireAuth } = require('../middleware/auth');
const signing = require('../utils/agreementSigning');
const lifecycle = require('../utils/agreementLifecycle');
const settingsStore = require('../utils/agreementSettings');
const { nextAgreementId } = require('../utils/agreement');

const LINKABLE = ['DRAFT', 'SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'];
const ACT = {
  created: 'Agreement link created',
  revoked: 'Agreement link stopped',
  emailed: 'Agreement link emailed',
};

// A phone number as wa.me wants it: digits, with India's 91 for a 10-digit number.
function waNumber(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) return `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : '';
}

function messageText(client, url, expiresAt) {
  const until = expiresAt ? new Date(expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
  const c = lifecycle.contactsOf(client);
  return [
    `${c.name ? `Hello ${c.name},` : 'Hello,'}`,
    `Please read and sign the TeamLink service agreement ${client.agreementId || ''} for ${client.name}:`,
    url,
    `We will email a code to ${c.email || 'your registered email'} to confirm it is you.${until ? ` The link works until ${until}.` : ''}`,
    '— TeamLink Consultants',
  ].join('\n');
}

async function shape(req, client) {
  // eslint-disable-next-line global-require
  const core = require('../utils/messagingCore');
  const st = signing.statusOf(client);
  const meta = signing.linkMeta(client);
  const token = signing.tokenFor(client);
  const link = signing.linkState(client);
  const live = !!token && link.ok && signing.OUT_FOR_SIGNATURE.includes(st);
  const url = live ? lifecycle.signingUrl(req, token) : null;
  const expiresAt = signing.linkExpiresAt(client);
  const c = lifecycle.contactsOf(client);
  const wa = waNumber(c.whatsapp);
  const settings = await settingsStore.agreementSettings();
  const text = url ? messageText(client, url, expiresAt) : null;
  return {
    status: st,
    canMake: LINKABLE.includes(st) && !!client.agreementDocument,
    // Why a link cannot be made now, in plain words.
    blocked: !client.agreementDocument ? 'Make the agreement draft first.'
      : (LINKABLE.includes(st) ? null : (['SIGNED', 'ACTIVE'].includes(st) ? 'Already signed. No link needed.' : 'Make a new draft first.')),
    live,
    url,
    createdAt: client.agreementSentAt || null,
    days: meta.days,
    expiresAt: live ? expiresAt : null,
    expired: !!(token && expiresAt && expiresAt < new Date() && signing.OUT_FOR_SIGNATURE.includes(st)),
    stoppedAt: meta.revokedAt,
    defaultDays: settings.linkDays || signing.LINK_DAYS,
    message: text,
    whatsappUrl: text ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}` : null,
    whatsappTo: wa ? core.maskMobile(c.whatsapp) : null,
    emailTo: c.email ? core.maskEmail(c.email) : null,
    viewedAt: client.agreementViewedAt || null,
  };
}

module.exports = function mountAgreementLink(router, { loadForView }) {
  // The client, in scope, for a login allowed to run the agreement (SA / Admin).
  async function loadForLink(req, res) {
    const loaded = await loadForView(req, res);
    if (!loaded) return null;
    if (loaded.access.as === 'client' || !(await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'create'))) {
      res.status(403).json({ error: 'Only a Super Admin or Admin can make or share the agreement link.' });
      return null;
    }
    return loaded.client;
  }

  router.get('/:clientId/link', requireAuth, async (req, res, next) => {
    try {
      const client = await loadForLink(req, res);
      if (!client) return undefined;
      return res.json(await shape(req, client));
    } catch (err) { return next(err); }
  });

  router.post('/:clientId/link', requireAuth, async (req, res, next) => {
    try {
      const client = await loadForLink(req, res);
      if (!client) return undefined;
      const st = signing.statusOf(client);
      if (!client.agreementDocument) return res.status(409).json({ error: 'Make the agreement draft first.' });
      if (!LINKABLE.includes(st)) {
        return res.status(409).json({ error: ['SIGNED', 'ACTIVE'].includes(st) ? 'This agreement is already signed. No link is needed.' : 'Make a new draft first, then make the link.' });
      }
      const settings = await settingsStore.agreementSettings();
      const asked = (req.body || {}).days;
      const days = asked === undefined || asked === null || asked === '' ? settings.linkDays : Number(asked);
      if (!Number.isInteger(days) || days < 1 || days > 90) return res.status(400).json({ error: 'The link must work for 1 to 90 days.' });
      const staleFiles = [client.agreementClientSignFile, client.agreementClientStampFile].filter(Boolean);
      const { data } = signing.newLinkData(client.id, { days, manual: true });
      const updated = await prisma.client.update({
        where: { id: client.id },
        data: {
          ...data,
          agreementStatus: st === 'DRAFT' ? 'SENT' : client.agreementStatus,
          agreementId: client.agreementId || (await nextAgreementId()),
          // A new link starts clean: anything half-done on the old one goes.
          agreementClientSignFile: null, agreementClientSignName: null,
          agreementClientStampFile: null, agreementClientStampName: null,
          agreementClientSealedAt: null, agreementVerifiedAt: null, agreementVerifyMobile: null,
          agreementVerifyMethod: null, agreementVerifyNote: null,
          ...signing.RESET_OTP,
        },
      });
      // eslint-disable-next-line global-require
      staleFiles.forEach((f) => { try { require('../utils/attachments').remove(f); } catch { /* gone */ } });
      // Pre-signed: TeamLink's saved signature + stamp go on before the client opens it.
      // eslint-disable-next-line global-require
      await require('../utils/teamlinkSeal').applyDefaults(updated, { actorUserId: req.user.id });
      await logAudit({
        userId: req.user.id, action: ACT.created, entity: 'Client', entityId: client.id,
        fromValue: st, toValue: signing.statusOf(updated),
        reason: `Works for ${days} day${days === 1 ? '' : 's'}${client.esignToken ? ' · the earlier link no longer works' : ''}`,
      });
      return res.json({ ...(await shape(req, await prisma.client.findUnique({ where: { id: client.id } }))), made: true });
    } catch (err) { return next(err); }
  });

  router.post('/:clientId/link/revoke', requireAuth, async (req, res, next) => {
    try {
      const client = await loadForLink(req, res);
      if (!client) return undefined;
      const st = signing.statusOf(client);
      if (!client.esignToken || signing.linkMeta(client).revokedAt) return res.status(409).json({ error: 'There is no working link to stop.' });
      if (!signing.OUT_FOR_SIGNATURE.includes(st)) return res.status(409).json({ error: 'This agreement is already signed. The link is closed.' });
      const meta = signing.linkMeta(client);
      const updated = await prisma.client.update({
        where: { id: client.id },
        data: {
          [signing.linkMetaField()]: `LINK;d=${meta.days}${meta.manual ? ';m=1' : ''};r=${Date.now()}`,
          agreementStatus: 'DRAFT',
          ...signing.RESET_OTP,
        },
      });
      await logAudit({
        userId: req.user.id, action: ACT.revoked, entity: 'Client', entityId: client.id, fromValue: st, toValue: 'DRAFT',
        reason: String((req.body || {}).reason || '').trim().slice(0, 300) || null,
      });
      return res.json({ ...(await shape(req, updated)), stopped: true });
    } catch (err) { return next(err); }
  });

  router.post('/:clientId/link/email', requireAuth, async (req, res, next) => {
    try {
      const client = await loadForLink(req, res);
      if (!client) return undefined;
      const info = await shape(req, client);
      if (!info.live) return res.status(409).json({ error: 'Make a link first.' });
      const c = lifecycle.contactsOf(client);
      if (!c.email) return res.status(409).json({ error: 'There is no email on this client. Add the HR contact email first.' });
      // eslint-disable-next-line global-require
      const messaging = require('../utils/messaging');
      const r = await messaging.send('Email', {
        to: c.email,
        subject: `Service agreement ${client.agreementId || ''} — please read and sign`.replace(/\s+/g, ' '),
        text: info.message,
        fromName: '',
      });
      await logAudit({
        userId: req.user.id, action: signing.ACTION.sent, entity: 'Client', entityId: client.id,
        toValue: `Email: ${r.outcome}`, reason: r.ok ? `${ACT.emailed} to ${info.emailTo}` : `Email — ${r.error || r.outcome}`.slice(0, 1000),
      });
      if (!r.ok) {
        const why = r.outcome === 'Not configured' ? 'Email is not set up yet. Copy the link or use WhatsApp.'
          : (r.outcome === 'Skipped' ? 'This email address cannot receive mail. Check the client\'s email.' : 'The email did not go. Please try again, or copy the link.');
        return res.status(502).json({ error: why, outcome: r.outcome });
      }
      // eslint-disable-next-line global-require
      return res.json({ ...info, emailed: true, sandbox: require('../utils/sandbox').isSandbox() });
    } catch (err) { return next(err); }
  });
};
