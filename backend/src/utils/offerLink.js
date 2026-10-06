// ---------------------------------------------------------------------------
// OFFER LETTER — VERSIONS, EXPIRY AND THE CANDIDATE'S E-SIGN LINK (B3, 2026-10-06).
//
// Built on the client-agreement pattern (utils/agreementSigning.js), not a
// second e-sign engine:
//   * every letter sent is an OfferVersion row (v1, v2 …). Re-issuing keeps the
//     old one, marked Replaced, with its own text, CTC and dates.
//   * the link token is an HMAC of the version id and the moment the link was
//     made (server secret), stored only as sha256 — a copy of the database
//     opens nothing, yet "Copy link" still works after a reload.
//   * the email code is hashed with the version id AND the current token,
//     10-minute expiry, 5 attempts, 60 s resend wait, at most 8 codes a link.
//   * the signature is the same image SignatureCapture makes (draw / type /
//     upload); eMudhra Aadhaar eSign is offered only when it is set up.
//   * the offer EXPIRES (default 7 days, Offers → admin line). An expired
//     offer cannot be accepted; the recruiter and the TL get a bell notice.
//   * accept / decline / expire write Application.offerStatus — the same
//     field the Offers and Joining screens already run on.
//
// The candidate-emails switch (utils/interviewNotices.js) is OFF: the letter is
// RECORDED, never mailed, and the link is shared by the recruiter (Copy /
// WhatsApp). The one email this flow sends is the 6-digit code the candidate
// asks for on the page (like the agreement OTP) — never automatically.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');

const SETTINGS_KEY = 'offer-settings';
const DEFAULT_DAYS = 7;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_S = 60;
const OTP_MAX_SENDS = 8;
const OFFER_EXPIRED = 'Offer Expired';
const SIGN_METHODS = { typed: 'Typed name (signature font)', drawn: 'Drawn on screen', uploaded: 'Uploaded signature image' };

// The tables arrive with migration 20261006090000; until then every call says so.
const ready = () => !!(prisma.offerVersion && typeof prisma.offerVersion.findFirst === 'function');
const NOT_READY = 'Offer versions are being set up (database update pending). Please try again later.';

// --- settings ---------------------------------------------------------------
async function loadSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  const d = Math.round(Number(v.expiryDays));
  return {
    expiryDays: Number.isFinite(d) && d >= 1 && d <= 60 ? d : DEFAULT_DAYS,
    updatedByName: row ? row.updatedByName : null,
    updatedAt: row ? row.updatedAt : null,
  };
}
async function saveSettings({ expiryDays }, user) {
  const d = Math.round(Number(expiryDays));
  if (!Number.isFinite(d) || d < 1 || d > 60) throw Object.assign(new Error('Pick 1 to 60 days.'), { status: 400 });
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify({ expiryDays: d }), ...who },
    update: { value: JSON.stringify({ expiryDays: d }), ...who },
  });
  return loadSettings();
}

// --- the link token ------------------------------------------------------------
const linkSecret = () => process.env.OFFER_LINK_SECRET || process.env.AGREEMENT_LINK_SECRET || process.env.JWT_SECRET || 'teamlink-offer-link';
const tokenHash = (token) => crypto.createHash('sha256').update(`offer-link:${String(token || '')}`).digest('hex');
const deriveToken = (versionId, at) => crypto.createHmac('sha256', linkSecret()).update(`offer:${versionId}:${new Date(at).getTime()}`).digest('hex');

function tokenFor(v) {
  if (!v || !v.tokenHash || !v.linkCreatedAt || v.linkStoppedAt) return null;
  const t = deriveToken(v.id, v.linkCreatedAt);
  return tokenHash(t) === v.tokenHash ? t : null;
}
async function findByToken(token) {
  if (!ready()) return null;
  const t = String(token || '');
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  return prisma.offerVersion.findUnique({ where: { tokenHash: tokenHash(t) } });
}
function publicBase(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/+$/, '');
  const origin = req && req.headers && req.headers.origin;
  if (origin) return String(origin).replace(/\/+$/, '');
  return req ? `${req.protocol}://${req.get('host')}`.replace(':4010', ':5183').replace(':4011', ':5184') : 'http://localhost:5183';
}
const linkUrl = (req, token) => `${publicBase(req)}/offer/${token}`;
function freshLinkData(versionId) {
  const at = new Date();
  return { linkCreatedAt: at, linkStoppedAt: null, tokenHash: tokenHash(deriveToken(versionId, at)) };
}

// --- versions ------------------------------------------------------------------
async function versionsOf(applicationId) {
  if (!ready()) return [];
  return prisma.offerVersion.findMany({ where: { applicationId }, orderBy: { version: 'desc' } });
}
async function currentVersion(applicationId) {
  if (!ready()) return null;
  return prisma.offerVersion.findFirst({ where: { applicationId }, orderBy: { version: 'desc' } });
}

// A new version for the letter just approved. The previous open one is
// Replaced (its link stops). Returns { version, token }.
async function createVersion(app, { letterText, actor }) {
  if (!ready()) return null;
  const { expiryDays } = await loadSettings();
  const last = await currentVersion(app.id);
  const now = new Date();
  if (last && last.status === 'Sent') {
    await prisma.offerVersion.update({ where: { id: last.id }, data: { status: 'Replaced', linkStoppedAt: last.linkStoppedAt || now } });
    await logAudit({ userId: actor ? actor.id : null, action: `Offer v${last.version} replaced by a new version`, entity: 'OfferVersion', entityId: last.id, fromValue: 'Sent', toValue: 'Replaced' });
  }
  const created = await prisma.offerVersion.create({
    data: {
      applicationId: app.id,
      version: (last ? last.version : 0) + 1,
      status: 'Sent',
      letterText: String(letterText || '').slice(0, 20000),
      offeredCtc: app.offeredCtc || null,
      offerDate: app.offerDate || null,
      joiningDate: app.joiningDate || null,
      expiresAt: new Date(now.getTime() + expiryDays * 86400000),
      createdById: actor ? actor.id : null,
      createdByName: actor ? actor.name : null,
    },
  });
  const v = await prisma.offerVersion.update({ where: { id: created.id }, data: freshLinkData(created.id) });
  await logAudit({
    userId: actor ? actor.id : null, action: `Offer v${v.version} sent — link made`, entity: 'OfferVersion', entityId: v.id,
    toValue: 'Sent', reason: `Works until ${v.expiresAt.toISOString().slice(0, 10)} (${expiryDays} days)`,
  });
  return { version: v, token: tokenFor(v) };
}

// "Make a new link": the old link stops working; the expiry stays the offer's.
async function remakeLink(v, actor) {
  const upd = await prisma.offerVersion.update({ where: { id: v.id }, data: { ...freshLinkData(v.id), otpHash: null, otpExpiresAt: null, otpAttempts: 0 } });
  await logAudit({ userId: actor ? actor.id : null, action: `Offer v${v.version} — new link made (the old link stopped)`, entity: 'OfferVersion', entityId: v.id });
  return { version: upd, token: tokenFor(upd) };
}

// Mark the current open version with the answer that came another way
// (recruiter "Candidate said yes / no", the candidate portal).
async function markCurrent(applicationId, status, { via, reason } = {}) {
  if (!ready()) return null;
  const v = await currentVersion(applicationId);
  if (!v || v.status !== 'Sent') return null;
  const now = new Date();
  const data = status === 'Accepted'
    ? { status, signedAt: now, signMethod: via || 'Recorded by the recruiter', linkStoppedAt: now }
    : { status, declinedAt: now, declineReason: reason || null, linkStoppedAt: now };
  const upd = await prisma.offerVersion.update({ where: { id: v.id }, data });
  await logAudit({ action: `Offer v${v.version} ${status.toLowerCase()} — ${via || 'recorded by the recruiter'}`, entity: 'OfferVersion', entityId: v.id, fromValue: 'Sent', toValue: status, reason: reason || null });
  return upd;
}

// --- expiry ---------------------------------------------------------------------
async function staffOf(app) {
  const r = app.requirement || {};
  return [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((s) => s.trim()), r.tlId].filter(Boolean);
}
// Expire every Sent version whose time is up (all, or one application's).
// Conditional updates, so two passes cannot both notify. Returns the count.
async function expireDue({ now = new Date(), applicationId = null } = {}) {
  if (!ready()) return 0;
  const due = await prisma.offerVersion.findMany({
    where: { status: 'Sent', expiresAt: { lt: now }, ...(applicationId ? { applicationId } : {}) },
    select: { id: true, version: true, applicationId: true, expiresAt: true },
    take: 500,
  });
  let n = 0;
  for (const v of due) {
    // eslint-disable-next-line no-await-in-loop
    const done = await prisma.offerVersion.updateMany({ where: { id: v.id, status: 'Sent' }, data: { status: 'Expired', expiredAt: now } });
    if (!done.count) continue;
    n += 1;
    // eslint-disable-next-line no-await-in-loop
    const app = await prisma.application.findUnique({ where: { id: v.applicationId }, include: { candidate: { select: { name: true } }, requirement: { select: { title: true, recruiterId: true, recruiterIds: true, tlId: true } } } });
    if (!app) continue;
    if (app.offerStatus === 'Offer Released') {
      // eslint-disable-next-line no-await-in-loop
      await prisma.application.updateMany({ where: { id: app.id, offerStatus: 'Offer Released' }, data: { offerStatus: OFFER_EXPIRED } });
    }
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ action: `Offer v${v.version} expired — not answered in time`, entity: 'OfferVersion', entityId: v.id, fromValue: 'Sent', toValue: 'Expired' });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ action: 'Offer expired', entity: 'Application', entityId: app.id, fromValue: 'Offer Released', toValue: OFFER_EXPIRED });
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(await staffOf(app), {
      title: `🔴 Offer expired: ${app.candidate ? app.candidate.name : 'Candidate'}`,
      message: `${app.requirement ? app.requirement.title : 'Job'} — the offer (v${v.version}) was not answered by ${v.expiresAt.toISOString().slice(0, 10)}. Open Offers → Offer again, or call the candidate.`,
    });
  }
  return n;
}
// For the candidate portal / staff accept: true when the current offer is past
// its time (and makes it Expired on the way).
async function isExpired(applicationId) {
  if (!ready()) return false;
  const v = await currentVersion(applicationId);
  if (!v) return false;
  if (v.status === 'Expired') return true;
  if (v.status === 'Sent' && v.expiresAt && v.expiresAt < new Date()) {
    await expireDue({ applicationId });
    return true;
  }
  return false;
}

// --- OTP --------------------------------------------------------------------------
const hashOtp = (otp, v) => crypto.createHash('sha256').update(`offer:${v.id}:${v.tokenHash || ''}:${String(otp).trim()}`).digest('hex');
function otpState(v) {
  const expiresAt = v.otpExpiresAt ? new Date(v.otpExpiresAt) : null;
  const sentAt = expiresAt ? new Date(expiresAt.getTime() - OTP_TTL_MINUTES * 60000) : null;
  const attempts = v.otpAttempts || 0;
  return {
    active: !!(v.otpHash && expiresAt && expiresAt > new Date()),
    expiresAt,
    attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
    locked: !!v.otpHash && attempts >= OTP_MAX_ATTEMPTS,
    cooldownRemaining: sentAt ? Math.max(0, Math.ceil((sentAt.getTime() + OTP_RESEND_COOLDOWN_S * 1000 - Date.now()) / 1000)) : 0,
    sendsLeft: Math.max(0, OTP_MAX_SENDS - (v.otpSends || 0)),
  };
}
async function issueOtp(v, sentTo) {
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await prisma.offerVersion.update({
    where: { id: v.id },
    data: { otpHash: hashOtp(otp, v), otpExpiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60000), otpAttempts: 0, otpSends: (v.otpSends || 0) + 1, otpSentTo: sentTo },
  });
  return otp;
}
async function checkOtp(v, otp) {
  const st = otpState(v);
  if (!v.otpHash || !st.expiresAt) return { error: 'Ask for the code first — no code is waiting.' };
  if (st.locked) return { error: 'Too many wrong codes. Ask for a new code.', locked: true, attemptsLeft: 0 };
  if (st.expiresAt < new Date()) return { error: 'That code has expired. Ask for a new code.', expired: true };
  const given = Buffer.from(hashOtp(String(otp || '').replace(/\D/g, ''), v), 'hex');
  const want = Buffer.from(v.otpHash, 'hex');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    const attempts = (v.otpAttempts || 0) + 1;
    await prisma.offerVersion.update({ where: { id: v.id }, data: { otpAttempts: attempts } });
    const left = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
    return left > 0
      ? { error: `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`, attemptsLeft: left }
      : { error: 'That code is not right, and that was the last try. Ask for a new code.', locked: true, attemptsLeft: 0 };
  }
  return { ok: true };
}

// --- what the candidate's page is told ------------------------------------------------
function linkState(v) {
  if (!v || !v.tokenHash) return { ok: false, code: 404, error: 'This offer link does not work. Ask your recruiter for a new link.' };
  if (v.linkStoppedAt && v.status === 'Sent') return { ok: false, code: 410, error: 'This link was replaced by a newer one. Ask your recruiter for the latest link.' };
  if (v.status === 'Replaced') return { ok: false, code: 410, error: 'This offer was replaced by a newer offer. Ask your recruiter for the latest link.' };
  return { ok: true };
}
async function publicView(v) {
  // eslint-disable-next-line global-require
  const core = require('./messagingCore');
  const app = await prisma.application.findUnique({
    where: { id: v.applicationId },
    include: { candidate: { select: { name: true, email: true } }, requirement: { select: { title: true, internal: true, location: true, client: { select: { name: true } } } } },
  });
  const r = (app && app.requirement) || {};
  const expired = v.status === 'Expired' || (v.status === 'Sent' && v.expiresAt && v.expiresAt < new Date());
  const otp = otpState(v);
  // eslint-disable-next-line global-require
  const emudhraReady = await require('./emudhra').isAvailable().catch(() => false);
  return {
    version: v.version,
    status: expired ? 'Expired' : v.status,
    open: v.status === 'Sent' && !expired,
    candidateName: app && app.candidate ? app.candidate.name : '',
    job: r.title || '',
    company: r.internal ? 'TeamLink' : (r.client && r.client.name) || '',
    ctc: v.offeredCtc,
    joiningDate: v.joiningDate,
    offerDate: v.offerDate,
    expiresAt: v.expiresAt,
    letter: v.letterText,
    contactEmail: app && app.candidate && app.candidate.email ? core.maskEmail(app.candidate.email) : null,
    signature: v.signFile ? { captured: true, method: v.signMethod, name: v.signedName } : { captured: false },
    otp: { waiting: otp.active && !otp.locked, sentTo: v.otpSentTo || null, attemptsLeft: otp.attemptsLeft, cooldownRemaining: otp.cooldownRemaining, sendsLeft: otp.sendsLeft, ttlMinutes: OTP_TTL_MINUTES },
    emudhra: { available: emudhraReady },
    signedAt: v.signedAt, signedName: v.signedName,
    declinedAt: v.declinedAt, declineReason: v.declineReason,
    pdfAvailable: v.status === 'Accepted' && !!v.signedAt,
  };
}

// What the Offers screen shows for one version (staff).
function staffShape(v, req) {
  const token = v.status === 'Sent' ? tokenFor(v) : null;
  const expired = v.status === 'Expired' || (v.status === 'Sent' && v.expiresAt && v.expiresAt < new Date());
  return {
    id: v.id,
    version: v.version,
    status: expired ? 'Expired' : v.status,
    offeredCtc: v.offeredCtc,
    joiningDate: v.joiningDate,
    offerDate: v.offerDate,
    expiresAt: v.expiresAt,
    sentAt: v.createdAt,
    sentBy: v.createdByName,
    viewedAt: v.viewedAt,
    signedAt: v.signedAt,
    signedName: v.signedName,
    signMethod: v.signMethod,
    signedIp: v.signedIp,
    otpVerifiedAt: v.otpVerifiedAt,
    otpSentTo: v.otpSentTo,
    declinedAt: v.declinedAt,
    declineReason: v.declineReason,
    expiredAt: v.expiredAt,
    hasPdf: !!v.pdfFile,
    esign: v.esignProvider || null,
    url: token && !expired && req ? linkUrl(req, token) : null,
    letter: v.letterText,
  };
}

module.exports = {
  SETTINGS_KEY, DEFAULT_DAYS, OFFER_EXPIRED, SIGN_METHODS, NOT_READY,
  OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_S, OTP_MAX_SENDS,
  ready, loadSettings, saveSettings,
  tokenHash, tokenFor, findByToken, linkUrl, publicBase,
  versionsOf, currentVersion, createVersion, remakeLink, markCurrent,
  expireDue, isExpired,
  hashOtp, otpState, issueOtp, checkOtp,
  linkState, publicView, staffShape,
};
