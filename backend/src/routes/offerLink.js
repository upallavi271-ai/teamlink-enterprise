// ---------------------------------------------------------------------------
// THE CANDIDATE'S OFFER LINK — public, by token, no login (B3, 2026-10-06).
// Mounted at /api/offer-link. The token addresses ONE offer version, is stored
// hashed, stops when a newer link / version is made, and the offer expires.
//
//   GET  /:token                  the letter + where it stands (opening = viewed)
//   POST /:token/signature        draw / type / upload (multipart: file, method, name)
//   POST /:token/email-code       a 6-digit code to the candidate's email on record
//   POST /:token/accept           { otp, name, agree:true } -> Accepted + signed PDF kept
//   POST /:token/decline          { reason } -> Declined
//   GET  /:token/pdf              the signed PDF (after accepting)
//   GET  /:token/file/sign        the signature image shown on the page
//   POST /:token/emudhra/start    Aadhaar eSign at eMudhra (only when set up)
//   POST /emudhra/return/:ref/:kind   eMudhra's reply (verified with eMudhra's API)
//
// Rate-limited per IP (utils/publicRateLimit.js). The order is enforced here:
// no accept without a signature, the right code and the tick; nothing after
// the offer expired or was answered. Every step is audited on the version
// (entity OfferVersion) with time and IP.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const attachments = require('../utils/attachments');
const OL = require('../utils/offerLink');
const { rateLimit } = require('../utils/publicRateLimit');

const router = express.Router();
router.use(rateLimit({ bucket: 'offer-link', max: 120, windowMs: 10 * 60000 }));
const codeLimit = rateLimit({ bucket: 'offer-code', max: 6, windowMs: 60 * 60000, message: 'Too many codes asked for from your network. Please wait an hour, or call your recruiter.' });
const signLimit = rateLimit({ bucket: 'offer-sign', max: 20, windowMs: 10 * 60000 });

const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 60);
const uaOf = (req) => String(req.headers['user-agent'] || '').slice(0, 160);

const APP_INCLUDE = { candidate: true, requirement: { include: { client: true } } };
const infoOf = (app) => ({
  candidateName: app && app.candidate ? app.candidate.name : '',
  job: app && app.requirement ? app.requirement.title : '',
  company: app && app.requirement ? (app.requirement.internal ? 'TeamLink' : (app.requirement.client && app.requirement.client.name) || '') : '',
});
const staffIds = (app) => {
  const r = (app && app.requirement) || {};
  return [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim()), r.tlId].filter(Boolean);
};

// The version for a token. open: must still be waiting for an answer.
async function byToken(req, res, { open = true } = {}) {
  if (!OL.ready()) { res.status(503).json({ error: OL.NOT_READY }); return null; }
  const v = await OL.findByToken(req.params.token);
  const st = OL.linkState(v);
  if (!st.ok) { res.status(st.code).json({ error: st.error }); return null; }
  if (open) {
    if (v.status === 'Sent' && v.expiresAt && v.expiresAt < new Date()) await OL.expireDue({ applicationId: v.applicationId });
    const fresh = await prisma.offerVersion.findUnique({ where: { id: v.id } });
    if (fresh.status === 'Expired') { res.status(410).json({ error: 'This offer has expired, so it can no longer be accepted. Ask your recruiter about a new offer.', expired: true }); return null; }
    if (fresh.status !== 'Sent') { res.status(409).json({ error: `You already answered this offer (${fresh.status.toLowerCase()}).` }); return null; }
    return fresh;
  }
  return v;
}

router.get('/:token', async (req, res, next) => {
  try {
    const v = await byToken(req, res, { open: false });
    if (!v) return undefined;
    if (v.status === 'Sent' && v.expiresAt && v.expiresAt < new Date()) await OL.expireDue({ applicationId: v.applicationId });
    if (!v.viewedAt && v.status === 'Sent') {
      await prisma.offerVersion.update({ where: { id: v.id }, data: { viewedAt: new Date() } });
      await logAudit({ action: 'Offer opened by the candidate', entity: 'OfferVersion', entityId: v.id, reason: `IP ${ipOf(req)}` });
    }
    return res.json(await OL.publicView(await prisma.offerVersion.findUnique({ where: { id: v.id } })));
  } catch (err) { return next(err); }
});

router.post('/:token/signature', signLimit, async (req, res, next) => {
  try {
    const v = await byToken(req, res);
    if (!v) return undefined;
    let parsed;
    try { parsed = await attachments.parseMultipart(req); } catch (err) {
      return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: err.code === 'TOO_LARGE' ? 'That image is over 5 MB.' : 'Send the signature as an image.' });
    }
    if (!parsed.file) return res.status(400).json({ error: 'Draw, type or upload your signature first.' });
    let stored;
    try { stored = attachments.store(parsed.file); } catch (err) {
      return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'That file could not be saved.' });
    }
    if (/\.pdf$/i.test(stored.billFile)) { attachments.remove(stored.billFile); return res.status(400).json({ error: 'Upload a PNG or JPG picture, not a PDF.' }); }
    // eslint-disable-next-line global-require
    await require('../utils/imageShrink').shrinkFile(attachments.resolveStored(stored.billFile)).catch(() => null);
    const f = parsed.fields || {};
    const method = OL.SIGN_METHODS[f.method] ? f.method : 'uploaded';
    const name = String(f.name || f.signedBy || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (method === 'typed' && name.length < 2) { attachments.remove(stored.billFile); return res.status(400).json({ error: 'Type your full name for the typed signature.' }); }
    const previous = v.signFile;
    const upd = await prisma.offerVersion.update({
      where: { id: v.id },
      data: { signFile: stored.billFile, signMethod: OL.SIGN_METHODS[method], signedName: name || v.signedName || null },
    });
    if (previous && previous !== stored.billFile) { try { attachments.remove(previous); } catch { /* gone */ } }
    await logAudit({ action: 'Candidate signature added', entity: 'OfferVersion', entityId: v.id, toValue: OL.SIGN_METHODS[method], reason: `IP ${ipOf(req)}` });
    return res.json(await OL.publicView(upd));
  } catch (err) { return next(err); }
});

router.post('/:token/email-code', codeLimit, async (req, res, next) => {
  try {
    const v = await byToken(req, res);
    if (!v) return undefined;
    const st = OL.otpState(v);
    if (st.cooldownRemaining > 0) return res.status(429).json({ error: `Please wait ${st.cooldownRemaining} seconds before asking for another code.`, retryAfter: st.cooldownRemaining });
    if (st.sendsLeft <= 0) return res.status(429).json({ error: 'Too many codes were asked for on this link. Ask your recruiter for a new link.' });
    const app = await prisma.application.findUnique({ where: { id: v.applicationId }, include: APP_INCLUDE });
    const email = String((app && app.candidate && app.candidate.email) || '').trim();
    if (!email) return res.status(409).json({ error: 'There is no email on your record, so we cannot send a code. Ask your recruiter to add it.' });
    // eslint-disable-next-line global-require
    const core = require('../utils/messagingCore');
    const label = `email to ${core.maskEmail(email) || 'your email'}`;
    const otp = await OL.issueOtp(v, label);
    // eslint-disable-next-line global-require
    const r = await require('../utils/messaging').send('Email', {
      to: email,
      subject: `Your offer code — ${infoOf(app).job}`,
      text: ['Hello,', '', `${otp} is your code to sign your offer for ${infoOf(app).job}${infoOf(app).company ? ` at ${infoOf(app).company}` : ''}.`,
        `It works for ${OL.OTP_TTL_MINUTES} minutes. Do not share it with anyone.`, '', 'If you did not ask for this code, ignore this email.', '', '— TeamLink'].join('\n'),
      fromName: '',
    });
    if (!r.ok) {
      await prisma.offerVersion.update({ where: { id: v.id }, data: { otpHash: null, otpExpiresAt: null, otpAttempts: 0 } });
      await logAudit({ action: 'Offer code could not be emailed', entity: 'OfferVersion', entityId: v.id, reason: `Email: ${r.outcome}${r.error ? ` (${r.error})` : ''}`.slice(0, 1000) });
      return res.status(503).json({ error: 'We could not email you a code right now. Please try again in a few minutes, or call your recruiter.' });
    }
    await logAudit({ action: 'Offer code emailed', entity: 'OfferVersion', entityId: v.id, toValue: label, reason: `Email: ${r.outcome} · IP ${ipOf(req)}` });
    return res.json({ sentTo: label, ttlMinutes: OL.OTP_TTL_MINUTES, resendInSeconds: OL.OTP_RESEND_COOLDOWN_S });
  } catch (err) { return next(err); }
});

// The pipeline move the portal's Accept makes (routes/portal.js), done here.
async function applyAccept(app, v, actorName) {
  const pseudo = { id: null, name: `${actorName} (offer link)`, role: 'CANDIDATE', atsRole: 'CANDIDATE' };
  const done = await prisma.application.updateMany({
    where: { id: app.id, offerStatus: 'Offer Released' },
    data: { stage: 'OFFER_ACCEPTED', offerStatus: 'Offer Accepted', offerAcceptedAt: new Date(), documentsStatus: app.documentsStatus === 'Verified' ? 'Verified' : (app.documentsStatus || 'Pending') },
  });
  if (!done.count) return false;
  await logAudit({ action: `Offer accepted by the candidate (offer link v${v.version})`, entity: 'Application', entityId: app.id, fromValue: 'Offer Released', toValue: 'Offer Accepted', actorName: pseudo.name });
  // eslint-disable-next-line global-require
  await require('../utils/stageEvents').recordWorkflowMove({ user: pseudo, existing: app, toStage: 'OFFER_ACCEPTED', action: 'Offer accepted and signed by the candidate (offer link)' });
  await notifyUsers(staffIds(app), { title: `✅ Offer accepted: ${app.candidate.name}`, message: `${app.requirement.title} — signed on the offer link (v${v.version}). Next: joining.` });
  return true;
}

router.post('/:token/accept', signLimit, async (req, res, next) => {
  try {
    const v = await byToken(req, res);
    if (!v) return undefined;
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (name.length < 2) return res.status(400).json({ error: 'Type your full name.' });
    if (b.agree !== true) return res.status(400).json({ error: 'Tick "I accept this offer" first.' });
    if (!v.signFile) return res.status(409).json({ error: 'Add your signature first (draw, type or upload).', step: 'sign' });
    const app = await prisma.application.findUnique({ where: { id: v.applicationId }, include: APP_INCLUDE });
    if (!app || app.offerStatus !== 'Offer Released') return res.status(409).json({ error: 'This offer is no longer waiting for an answer. Ask your recruiter.' });
    const checked = await OL.checkOtp(v, b.otp);
    if (!checked.ok) {
      if (checked.attemptsLeft !== undefined) await logAudit({ action: checked.locked ? 'Offer code locked (too many tries)' : 'Offer code wrong', entity: 'OfferVersion', entityId: v.id, reason: `${checked.attemptsLeft} left · IP ${ipOf(req)}` });
      return res.status(checked.locked ? 423 : 400).json({ error: checked.error, attemptsLeft: checked.attemptsLeft, locked: !!checked.locked, expired: !!checked.expired });
    }
    const now = new Date();
    const won = await prisma.offerVersion.updateMany({
      where: { id: v.id, status: 'Sent' },
      data: { status: 'Accepted', signedAt: now, otpVerifiedAt: now, signedName: name, signedIp: ipOf(req), signedUserAgent: uaOf(req), otpHash: null, otpExpiresAt: null, otpAttempts: 0 },
    });
    if (!won.count) return res.status(409).json({ error: 'This offer was already answered.' });
    await logAudit({ action: 'Offer accepted and signed — code verified', entity: 'OfferVersion', entityId: v.id, fromValue: 'Sent', toValue: 'Accepted', reason: `${name} · code sent by ${v.otpSentTo || 'email'} · IP ${ipOf(req)}${uaOf(req) ? ` · ${uaOf(req)}` : ''}`.slice(0, 1000) });
    await applyAccept(app, v, name);
    // Keep the signed PDF exactly as it stands now.
    // eslint-disable-next-line global-require
    const kept = await require('../utils/offerPdf').keepOfferPdf(prisma, await prisma.offerVersion.findUnique({ where: { id: v.id } }), infoOf(app));
    if (kept) {
      await prisma.offerVersion.update({ where: { id: v.id }, data: { pdfFile: kept.file, pdfSha256: kept.sha256 } });
      await logAudit({ action: 'Signed offer PDF kept', entity: 'OfferVersion', entityId: v.id, toValue: kept.file, reason: `${kept.size} bytes · sha256 ${kept.sha256}` });
    }
    return res.json({ ...(await OL.publicView(await prisma.offerVersion.findUnique({ where: { id: v.id } }))), message: 'Accepted. Thank you! Your recruiter will share the joining steps.' });
  } catch (err) { return next(err); }
});

router.post('/:token/decline', signLimit, async (req, res, next) => {
  try {
    const v = await byToken(req, res);
    if (!v) return undefined;
    const reason = String((req.body || {}).reason || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    if (reason.length < 2) return res.status(400).json({ error: 'Tell us why, in a few words.' });
    const app = await prisma.application.findUnique({ where: { id: v.applicationId }, include: APP_INCLUDE });
    const now = new Date();
    const won = await prisma.offerVersion.updateMany({ where: { id: v.id, status: 'Sent' }, data: { status: 'Declined', declinedAt: now, declineReason: reason, signedIp: ipOf(req), signedUserAgent: uaOf(req), otpHash: null, otpExpiresAt: null } });
    if (!won.count) return res.status(409).json({ error: 'This offer was already answered.' });
    await logAudit({ action: 'Offer declined by the candidate', entity: 'OfferVersion', entityId: v.id, fromValue: 'Sent', toValue: 'Declined', reason: `${reason} · IP ${ipOf(req)}`.slice(0, 1000) });
    if (app && app.offerStatus === 'Offer Released') {
      await prisma.application.update({ where: { id: app.id }, data: { offerStatus: 'Offer Declined', offerNotes: `Candidate (offer link): ${reason}` } });
      await logAudit({ action: `Offer declined by the candidate (offer link v${v.version}) — ${reason}`, entity: 'Application', entityId: app.id, fromValue: 'Offer Released', toValue: 'Offer Declined' });
      await notifyUsers(staffIds(app), { title: `Offer declined: ${app.candidate.name}`, message: `${app.requirement.title}: ${reason}` });
    }
    return res.json({ ...(await OL.publicView(await prisma.offerVersion.findUnique({ where: { id: v.id } }))), message: 'Your answer is saved. Your recruiter has been told.' });
  } catch (err) { return next(err); }
});

router.get('/:token/pdf', async (req, res, next) => {
  try {
    const v = await byToken(req, res, { open: false });
    if (!v) return undefined;
    if (v.status !== 'Accepted') return res.status(409).json({ error: 'The signed PDF is ready once you accept the offer.' });
    const file = req.query.copy === 'emudhra' && v.esignProvider === 'eMudhra'
      ? attachments.resolveStored((await prisma.auditLog.findFirst({ where: { entity: 'OfferVersion', entityId: v.id, action: 'eMudhra-signed offer PDF kept' }, orderBy: { createdAt: 'desc' } }) || {}).toValue)
      : (v.pdfFile ? attachments.resolveStored(v.pdfFile) : null);
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="offer-v${v.version}-signed.pdf"`);
    if (file) return res.sendFile(file);
    const app = await prisma.application.findUnique({ where: { id: v.applicationId }, include: APP_INCLUDE });
    // eslint-disable-next-line global-require
    const P = require('../utils/offerPdf');
    await P.renderOfferPdf(v, infoOf(app), { trail: await P.trailOf(prisma, v) }, res);
    return undefined;
  } catch (err) { return next(err); }
});

router.get('/:token/file/sign', async (req, res, next) => {
  try {
    const v = await byToken(req, res, { open: false });
    if (!v) return undefined;
    const file = v.signFile ? attachments.resolveStored(v.signFile) : null;
    if (!file) return res.status(404).json({ error: 'No signature yet' });
    res.set('Cache-Control', 'private, no-store');
    return res.sendFile(file);
  } catch (err) { return next(err); }
});

// --- Aadhaar eSign at eMudhra (greyed on the page until set up) -------------------
const emudhraLimit = rateLimit({ bucket: 'offer-emudhra', max: 20, windowMs: 10 * 60000 });
router.post('/:token/emudhra/start', emudhraLimit, async (req, res, next) => {
  try {
    const v = await byToken(req, res);
    if (!v) return undefined;
    // eslint-disable-next-line global-require
    const emudhra = require('../utils/emudhra');
    if (!(await emudhra.isAvailable())) return res.status(409).json({ error: 'Aadhaar eSign is not set up yet. Please sign another way.', notAvailable: true });
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (name.length < 2) return res.status(400).json({ error: 'Type your full name (as on Aadhaar).' });
    if (b.agree !== true) return res.status(400).json({ error: 'Tick "I accept this offer" first.' });
    const app = await prisma.application.findUnique({ where: { id: v.applicationId }, include: APP_INCLUDE });
    await prisma.offerVersion.update({ where: { id: v.id }, data: { signedName: name } });
    // eslint-disable-next-line global-require
    const { PassThrough } = require('stream');
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve, reject) => { sink.on('end', resolve); sink.on('error', reject); });
    // eslint-disable-next-line global-require
    await require('../utils/offerPdf').renderOfferPdf({ ...v, signedName: name, signFile: null }, infoOf(app), { trail: [] }, sink);
    await done;
    const base = OL.publicBase(req);
    const form = await emudhra.startSession({ client: null, pdf: Buffer.concat(chunks), signerName: name, returnBase: base, returnPath: '/api/offer-link/emudhra/return', sessionExtra: { kind: 'offer', versionId: v.id, frontBase: base } });
    await logAudit({ action: 'Offer sent to eMudhra for Aadhaar eSign', entity: 'OfferVersion', entityId: v.id, toValue: form.ref, reason: `${name} · IP ${ipOf(req)}` });
    return res.json({ gatewayUrl: form.gatewayUrl, fields: form.fields, ref: form.ref });
  } catch (err) {
    if (err.code === 'NOT_READY') return res.status(409).json({ error: 'Aadhaar eSign is not set up yet. Please sign another way.', notAvailable: true });
    return next(err);
  }
});

const plainPage = (res, code, text) => res.status(code).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offer</title><body style="font-family:system-ui;padding:24px;max-width:560px;margin:auto"><h2>Offer signing</h2><p>${text}</p></body>`);
router.post('/emudhra/return/:ref/:kind', emudhraLimit, express.urlencoded({ extended: false, limit: '30mb' }), async (req, res, next) => {
  try {
    // eslint-disable-next-line global-require
    const emudhra = require('../utils/emudhra');
    const ref = String(req.params.ref || '');
    const kind = String(req.params.kind || '');
    const session = await emudhra.readSession(ref);
    if (!session || session.kind !== 'offer' || !['success', 'failure', 'cancel'].includes(kind)) return plainPage(res, 400, 'This signing reply was not recognised, so nothing was changed.');
    const v = await prisma.offerVersion.findUnique({ where: { id: session.versionId } });
    const token = v ? OL.tokenFor(v) : null;
    const back = (state, why) => res.redirect(303, `${session.frontBase || ''}/offer/${token || ''}?emudhra=${state}${why ? `&why=${encodeURIComponent(why)}` : ''}`);
    if (!v || !token) return plainPage(res, 410, 'This offer link is no longer open. Ask your recruiter.');
    if (session.status !== 'Started') return plainPage(res, 409, 'This signing reply was already handled, so nothing was changed.');
    const b = req.body || {};
    if (kind !== 'success' || String(b.ReturnStatus || '').toLowerCase() !== 'success') {
      await emudhra.closeSession(ref, kind === 'cancel' ? 'Cancelled' : 'Failed');
      await logAudit({ action: kind === 'cancel' ? 'eMudhra eSign cancelled by the candidate' : 'eMudhra eSign failed', entity: 'OfferVersion', entityId: v.id, toValue: ref, reason: String(b.ErrorMessage || '').slice(0, 300) || null });
      return back(kind === 'cancel' ? 'cancelled' : 'failed', String(b.ErrorMessage || '').slice(0, 160));
    }
    const ver = await emudhra.verifyAndFetch({ ref, postedTxn: b.Transactionnumber });
    if (!ver.ok) {
      if (ver.refuse) return plainPage(res, 400, 'This signing reply could not be verified, so nothing was changed.');
      await emudhra.closeSession(ref, 'Failed');
      await logAudit({ action: 'eMudhra eSign not confirmed — not signed', entity: 'OfferVersion', entityId: v.id, toValue: ref, reason: ver.reason.slice(0, 300) });
      return back('failed', ver.reason.replace(/\s*\(.*\)\s*$/, ''));
    }
    const app = await prisma.application.findUnique({ where: { id: v.applicationId }, include: APP_INCLUDE });
    if (!app || app.offerStatus !== 'Offer Released' || (v.expiresAt && v.expiresAt < new Date())) {
      await emudhra.closeSession(ref, 'Late');
      return back('failed', 'This offer is no longer open.');
    }
    const stored = attachments.store({ data: ver.pdf, contentType: 'application/pdf', filename: `offer-v${v.version}-emudhra-signed.pdf` }, { maxBytes: 25 * 1024 * 1024 });
    const sha = crypto.createHash('sha256').update(ver.pdf).digest('hex');
    const now = new Date();
    const won = await prisma.offerVersion.updateMany({
      where: { id: v.id, status: 'Sent' },
      data: { status: 'Accepted', signedAt: now, signMethod: 'Aadhaar eSign (eMudhra)', esignProvider: 'eMudhra', esignTxnId: ver.transactionNumber.slice(0, 80), signedIp: ipOf(req), signedUserAgent: uaOf(req) },
    });
    await emudhra.closeSession(ref, won.count ? 'Signed' : 'Late');
    if (!won.count) return back('failed', 'This offer was already answered.');
    await logAudit({ action: 'eMudhra-signed offer PDF kept', entity: 'OfferVersion', entityId: v.id, toValue: stored.billFile, reason: `${stored.billSize} bytes · sha256 ${sha} · eMudhra transaction ${ver.transactionNumber}` });
    await logAudit({ action: 'Offer accepted — Aadhaar eSign at eMudhra', entity: 'OfferVersion', entityId: v.id, fromValue: 'Sent', toValue: 'Accepted', reason: `${v.signedName || '—'} · transaction ${ver.transactionNumber} · confirmed by eMudhra's status API` });
    await applyAccept(app, v, v.signedName || app.candidate.name);
    // eslint-disable-next-line global-require
    const kept = await require('../utils/offerPdf').keepOfferPdf(prisma, await prisma.offerVersion.findUnique({ where: { id: v.id } }), infoOf(app));
    if (kept) await prisma.offerVersion.update({ where: { id: v.id }, data: { pdfFile: kept.file, pdfSha256: kept.sha256 } });
    return back('signed');
  } catch (err) { return next(err); }
});

module.exports = router;
