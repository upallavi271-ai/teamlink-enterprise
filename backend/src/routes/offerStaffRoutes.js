// ---------------------------------------------------------------------------
// B3 (2026-10-06): OFFER VERSIONS, EXPIRY AND THE CANDIDATE'S SIGNING LINK —
// our side. Mounted into routes/interviewsJoining.js (/api/ats), so it shares
// its login, ATS product gate and scope (loadScoped).
//
//   GET  /offers/settings              how many days an offer stays open
//   PUT  /offers/settings              { expiryDays } (Admin)
//   GET  /offers/:id/versions          every version, newest first
//   GET  /offers/:id/versions/:vid/pdf the signed PDF of one version (or the
//                                      letter as sent, for an unsigned one)
//   GET  /offers/:id/link              the live link: Copy / WhatsApp / Email
//   POST /offers/:id/link              make a new link (the old one stops)
//   POST /offers/:id/link/email        email the link — ONLY while the
//                                      "Candidate emails" switch is on
// The candidate's page itself: routes/offerLink.js (/offer/:token).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const OL = require('../utils/offerLink');

const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u && u.role);
const emailsOn = () => require('../utils/interviewNotices').candidateEmailsOn(); // eslint-disable-line global-require

function waNum(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : '';
}
const companyOf = (r) => (r.internal ? 'TeamLink' : (r.client && r.client.name) || '');

async function linkShape(req, app, v, token) {
  // eslint-disable-next-line global-require
  const core = require('../utils/messagingCore');
  const candidateEmailsOn = await emailsOn();
  const shaped = OL.staffShape(v, req);
  const url = token && shaped.status === 'Sent' ? OL.linkUrl(req, token) : null;
  const r = app.requirement || {};
  const first = String(app.candidate.name || '').replace(/^ZZTEST\S*\s*/i, '').split(/\s+/)[0] || 'there';
  const until = v.expiresAt ? new Date(v.expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null;
  const text = url ? [
    `Hi ${first}, here is your offer for ${r.title || 'the job'}${companyOf(r) ? ` at ${companyOf(r)}` : ''}.`,
    'Open it, read it and press Accept (you sign on your phone) or Decline:',
    url,
    until ? `Please answer by ${until}.` : '',
    `— ${req.user.name}, TeamLink`,
  ].filter(Boolean).join('\n') : null;
  const wa = waNum(app.candidate.phone);
  return {
    version: shaped,
    url,
    live: !!url,
    message: text,
    whatsappUrl: text ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}` : null,
    whatsappTo: wa ? core.maskMobile(app.candidate.phone) : null,
    emailTo: app.candidate.email ? core.maskEmail(app.candidate.email) : null,
    candidateEmailsOn,
    emailNote: candidateEmailsOn ? null : 'Candidate emails are switched off, so the app does not email this link. Copy it or send it on WhatsApp.',
  };
}

module.exports = function mountOfferStaffRoutes(router, { loadScoped }) {
  router.get('/offers/settings', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
    res.json({ ...(await OL.loadSettings()), canEdit: isAdmin(req.user), candidateEmailsOn: await emailsOn() });
  });

  router.put('/offers/settings', requirePerm('ats', 'interviews', 'Offers', 'approve'), async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can change how long offers stay open.' });
    const before = await OL.loadSettings();
    try {
      const s = await OL.saveSettings({ expiryDays: (req.body || {}).expiryDays }, req.user);
      await logAudit({ userId: req.user.id, action: 'Offer expiry days changed', entity: 'AppSetting', entityId: OL.SETTINGS_KEY, fromValue: String(before.expiryDays), toValue: String(s.expiryDays) });
      return res.json({ ...s, canEdit: true, candidateEmailsOn: await emailsOn(), message: `Saved. New offers stay open for ${s.expiryDays} day${s.expiryDays === 1 ? '' : 's'}.` });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  });

  router.get('/offers/:id/versions', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return;
    await OL.expireDue({ applicationId: app.id }).catch(() => 0);
    res.json({ versions: (await OL.versionsOf(app.id)).map((v) => OL.staffShape(v, req)) });
  });

  router.get('/offers/:id/versions/:vid/pdf', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    if (!OL.ready()) return res.status(503).json({ error: OL.NOT_READY });
    const v = await prisma.offerVersion.findFirst({ where: { id: req.params.vid, applicationId: app.id } });
    if (!v) return res.status(404).json({ error: 'That offer version was not found.' });
    // eslint-disable-next-line global-require
    const attachments = require('../utils/attachments');
    const file = v.pdfFile ? attachments.resolveStored(v.pdfFile) : null;
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="offer-${String(app.candidate.name || 'candidate').replace(/[^\w.-]+/g, '-')}-v${v.version}.pdf"`);
    if (file) return res.sendFile(file);
    // Not signed (an older / declined version): the letter as sent, with its trail.
    // eslint-disable-next-line global-require
    const P = require('../utils/offerPdf');
    const r = app.requirement || {};
    await P.renderOfferPdf(v, { candidateName: app.candidate.name, job: r.title, company: companyOf(r) }, { trail: await P.trailOf(prisma, v) }, res);
    return undefined;
  });

  router.get('/offers/:id/link', requirePerm('ats', 'interviews', 'Offers', 'view'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    await OL.expireDue({ applicationId: app.id }).catch(() => 0);
    const v = await OL.currentVersion(app.id);
    if (!v) return res.status(404).json({ error: 'This offer was sent before offer links existed. Use "Offer again" to send a new version with a link.', noVersion: true });
    return res.json(await linkShape(req, app, v, OL.tokenFor(v)));
  });

  router.post('/offers/:id/link', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    await OL.expireDue({ applicationId: app.id }).catch(() => 0);
    const v = await OL.currentVersion(app.id);
    if (!v) return res.status(404).json({ error: 'There is no offer letter to link to yet.' });
    if (v.status !== 'Sent') {
      return res.status(409).json({ error: v.status === 'Expired' ? 'This offer has expired. Use "Offer again" — it becomes the next version.' : `This offer is already ${v.status.toLowerCase()}.` });
    }
    const made = await OL.remakeLink(v, req.user);
    return res.json({ ...(await linkShape(req, app, made.version, made.token)), message: 'New link made. The old link no longer works.' });
  });

  router.post('/offers/:id/link/email', requirePerm('ats', 'interviews', 'Offers', 'edit'), async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    if (!(await emailsOn())) {
      return res.status(409).json({ error: 'Candidate emails are switched off (Admin switch), so nothing was emailed. Copy the link or send it on WhatsApp.', switchedOff: true });
    }
    const v = await OL.currentVersion(app.id);
    const token = v ? OL.tokenFor(v) : null;
    if (!v || v.status !== 'Sent' || !token) return res.status(409).json({ error: 'There is no open offer link to send.' });
    const shaped = await linkShape(req, app, v, token);
    // eslint-disable-next-line global-require
    const row = await require('../utils/interviewNotices').queueCandidateEmail(app, {
      template: 'OFFER_LINK', label: 'Offer link', subject: `Your offer — ${app.requirement.title}`, body: shaped.message, actor: req.user,
    });
    await logAudit({ userId: req.user.id, action: `Offer v${v.version} link emailed`, entity: 'OfferVersion', entityId: v.id, toValue: row ? row.status : 'not recorded' });
    return res.json({ ...shaped, emailed: !!row && row.status === 'QUEUED', message: row && row.status === 'QUEUED' ? 'Emailed to the candidate.' : 'Recorded, but not emailed (no email provider, or no email on the candidate).' });
  });
};
