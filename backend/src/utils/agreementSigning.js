// ---------------------------------------------------------------------------
// EXECUTING AN AGREEMENT — the signing link, the e-signature, the OTP, and
// who may see the result.
//
//   Send to client     a NEW single-use token every time (resend invalidates
//                      the old link), valid for LINK_DAYS (default 14,
//                      AGREEMENT_LINK_DAYS) from the send
//   Client opens it    reads the agreement, presses "OK, Proceed"
//   E-signature        typed name in a signature font, drawn on a pad, or an
//                      uploaded image — each arrives as an image
//   OTP                six digits to the REGISTERED mobile on the client record
//                      (SMS, else WhatsApp, else email as the last fallback),
//                      hashed, 10-minute expiry, 5 attempts, 60 s resend
//                      cooldown, at most OTP_MAX_SENDS codes per link
//   Submit             the correct code signs it: SIGNED. With TeamLink's
//                      countersign on as well it becomes ACTIVE by itself.
//
// NOTHING HERE ADDS A COLUMN. Link expiry is derived from agreementSentAt,
// the resend cooldown from agreementOtpExpiresAt, and the "proceeded" step and
// the OTP send count from the audit trail — which also makes every step of the
// signing auditable.
//
// THE OTP IS HASHED with the client id AND the current token, so a code issued
// for an old link is useless on a new one, and it is compared in constant time.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const prisma = require('../db');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_S = 60;
const OTP_MAX_SENDS = 8;
const LINK_DAYS = Number(process.env.AGREEMENT_LINK_DAYS) > 0 ? Number(process.env.AGREEMENT_LINK_DAYS) : 14;
const OUT_FOR_SIGNATURE = ['SENT', 'VIEWED', 'CLIENT_CONFIRMATION_PENDING'];
const SIGN_METHODS = { typed: 'Typed name (signature font)', drawn: 'Drawn on screen', uploaded: 'Uploaded signature image' };
// The one-page "type your name and press I agree and sign" signature (2026-10-05).
const AGREE_METHOD = 'Typed name - "I agree and sign" (email code)';

// ---------------------------------------------------------------------------
// THE LINK TOKEN IS STORED HASHED (2026-10-05). Client.esignToken holds
// sha256 of the token, never the token. The token itself is an HMAC of the
// client id and the moment the link was made, keyed by the server secret, so
// a copy of the database alone opens nothing — yet SA / Admin can still press
// "Copy link" after a reload (the server re-derives it). A 48-hex token from
// before this change is still honoured as it was (legacy plaintext).
//
// THE LINK'S OWN SETTINGS ride in Client.agreementEsignTxnId (unused until
// now; "the e-sign transaction" — our own link is that transaction), so no
// column is added:  "LINK;d=14"  -> valid 14 days from agreementSentAt
//                   "LINK;d=14;r=1759650000000" -> stopped (revoked) then.
// ---------------------------------------------------------------------------
const linkSecret = () => process.env.AGREEMENT_LINK_SECRET || process.env.JWT_SECRET || 'teamlink-agreement-link';
function tokenHash(token) {
  return crypto.createHash('sha256').update(`agreement-link:${String(token || '')}`).digest('hex');
}
function deriveToken(clientId, sentAt) {
  return crypto.createHmac('sha256', linkSecret()).update(`${clientId}:${new Date(sentAt).getTime()}`).digest('hex');
}
// What a NEW link writes on the client record (merge into the update).
// manual: made with "Create agreement link" — shared by the user (Copy /
// WhatsApp / Email button), so no automatic reminder goes to the client.
// WHERE THE LINK SETTINGS LIVE (2026-10-05): Client.agreementLinkMeta once
// migration 20261005190000 is applied (agreementEsignTxnId then holds only an
// eSign provider's transaction id, e.g. eMudhra's); until then the old place.
function linkMetaField() {
  // eslint-disable-next-line global-require
  return require('./clientProfile').hasColumn('agreementLinkMeta') ? 'agreementLinkMeta' : 'agreementEsignTxnId';
}
function newLinkData(clientId, { days, manual = false } = {}) {
  const sentAt = new Date();
  const d = Math.round(Number(days));
  const token = deriveToken(clientId, sentAt);
  return {
    token,
    data: {
      agreementSentAt: sentAt,
      esignToken: tokenHash(token),
      [linkMetaField()]: `LINK;d=${Number.isFinite(d) && d >= 1 && d <= 90 ? d : LINK_DAYS}${manual ? ';m=1' : ''}`,
    },
  };
}
function linkMeta(client) {
  const a = String((client && client.agreementLinkMeta) || '');
  const raw = a.startsWith('LINK;') ? a : String((client && client.agreementEsignTxnId) || '');
  if (!raw.startsWith('LINK;')) return { days: LINK_DAYS, revokedAt: null, manual: false };
  const kv = Object.fromEntries(raw.split(';').slice(1).map((p) => p.split('=')));
  const days = Math.round(Number(kv.d));
  return { days: Number.isFinite(days) && days >= 1 ? days : LINK_DAYS, revokedAt: kv.r ? new Date(Number(kv.r)) : null, manual: kv.m === '1' };
}
// The token for a client's CURRENT link, or null (none / stopped / unknown).
function tokenFor(client) {
  if (!client || !client.esignToken) return null;
  if (/^[a-f0-9]{48}$/.test(client.esignToken)) return client.esignToken; // legacy plaintext link
  if (!client.agreementSentAt || linkMeta(client).revokedAt) return null;
  const t = deriveToken(client.id, client.agreementSentAt);
  return tokenHash(t) === client.esignToken ? t : null;
}
const pathFor = (client) => { const t = tokenFor(client); return t ? `/agreement/${t}` : null; };
// The client a link token opens (hashed lookup; legacy 48-hex as stored).
async function findByToken(token) {
  const t = String(token || '');
  if (!/^[a-f0-9]{48}$|^[a-f0-9]{64}$/.test(t)) return null;
  const hit = await prisma.client.findUnique({ where: { esignToken: tokenHash(t) } });
  if (hit || t.length !== 48) return hit;
  return prisma.client.findUnique({ where: { esignToken: t } });
}

// Audit actions the flow writes and reads back. One vocabulary.
const ACTION = {
  sent: 'Agreement link sent',
  opened: 'Agreement opened by client',
  proceeded: 'Agreement read — client pressed OK, Proceed',
  signature: 'Client e-signature captured',
  stamp: 'Client company stamp uploaded',
  otpSent: 'Agreement OTP sent',
  otpFailed: 'Agreement OTP could not be delivered',
  otpWrong: 'Agreement OTP incorrect',
  otpLocked: 'Agreement OTP locked after too many attempts',
  verified: 'Agreement OTP verified — signed',
  sealed: 'TeamLink countersign / seal applied',
  activated: 'Agreement auto-activated',
  reminder: (d) => `Agreement signing reminder (day ${d})`,
  expiredLink: 'Agreement signing link expired',
  voided: 'Agreement voided for re-signing',
};

const { normalizeAgreementStatus } = require('./atsVocab');
const statusOf = (c) => normalizeAgreementStatus(c && c.agreementStatus);

// Everything that makes an agreement "executed", cleared when the document is
// regenerated, re-uploaded or voided — a signature belongs to one text.
const RESET_EXECUTION = {
  esignToken: null,
  agreementSignedAt: null,
  agreementSignedBy: null,
  agreementSignedByTitle: null,
  agreementViewedAt: null,
  agreementCompanyStampFile: null, agreementCompanyStampName: null,
  agreementCompanySignFile: null, agreementCompanySignName: null,
  agreementCompanySignedBy: null, agreementCompanySealedAt: null,
  agreementClientStampFile: null, agreementClientStampName: null,
  agreementClientSignFile: null, agreementClientSignName: null,
  agreementClientSealedAt: null,
  agreementVerifyMethod: null, agreementAadhaarLast4: null, agreementEsignTxnId: null,
  agreementEsignProvider: null, agreementVerifyMobile: null, agreementVerifiedAt: null,
  agreementVerifyNote: null,
  agreementOtpHash: null, agreementOtpExpiresAt: null, agreementOtpAttempts: 0,
};
const RESET_OTP = { agreementOtpHash: null, agreementOtpExpiresAt: null, agreementOtpAttempts: 0 };

// --- The link ----------------------------------------------------------------
function linkExpiresAt(client) {
  if (!client || !client.agreementSentAt) return null;
  return new Date(new Date(client.agreementSentAt).getTime() + linkMeta(client).days * 86400000);
}
// { ok, code, error, expiresAt } — code: 404 unknown, 410 expired.
function linkState(client) {
  if (!client || !client.agreementDocument || !client.esignToken) {
    return { ok: false, code: 404, error: 'This signing link is not valid — ask TeamLink to send it again.' };
  }
  const { revokedAt } = linkMeta(client);
  if (revokedAt) {
    return { ok: false, code: 410, revoked: true, error: 'This link was stopped by TeamLink. Ask your TeamLink contact for a new link.' };
  }
  const expiresAt = linkExpiresAt(client);
  if (expiresAt && expiresAt < new Date()) {
    return { ok: false, code: 410, expiresAt, error: `This signing link expired on ${expiresAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}. Ask TeamLink to send you a new one.` };
  }
  return { ok: true, expiresAt };
}

// --- Steps read back from the audit trail --------------------------------------
async function stepsOf(client) {
  const since = client.agreementSentAt ? new Date(client.agreementSentAt) : new Date(0);
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'Client', entityId: client.id, createdAt: { gte: since }, action: { in: [ACTION.proceeded, ACTION.otpSent] } },
    select: { action: true, createdAt: true },
  });
  return {
    proceededAt: (rows.find((r) => r.action === ACTION.proceeded) || {}).createdAt || null,
    otpSends: rows.filter((r) => r.action === ACTION.otpSent).length,
  };
}

// --- OTP -------------------------------------------------------------------------
function hashOtp(otp, client) {
  return crypto.createHash('sha256').update(`${client.id}:${client.esignToken || ''}:${String(otp).trim()}`).digest('hex');
}
function newOtp() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

function otpState(client) {
  const expiresAt = client.agreementOtpExpiresAt ? new Date(client.agreementOtpExpiresAt) : null;
  const sentAt = expiresAt ? new Date(expiresAt.getTime() - OTP_TTL_MINUTES * 60000) : null;
  const attempts = client.agreementOtpAttempts || 0;
  const cooldownRemaining = sentAt ? Math.max(0, Math.ceil((sentAt.getTime() + OTP_RESEND_COOLDOWN_S * 1000 - Date.now()) / 1000)) : 0;
  return {
    active: !!(client.agreementOtpHash && expiresAt && expiresAt > new Date()),
    sentAt, expiresAt, attempts,
    attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
    locked: !!client.agreementOtpHash && attempts >= OTP_MAX_ATTEMPTS,
    cooldownRemaining,
  };
}

// Stores the hash and returns the plaintext for the CALLER to deliver. The
// plaintext never goes to the browser.
async function issueOtp(client, { destinationLabel }) {
  const otp = newOtp();
  await prisma.client.update({
    where: { id: client.id },
    data: {
      agreementOtpHash: hashOtp(otp, client),
      agreementOtpExpiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60000),
      agreementOtpAttempts: 0,
      agreementVerifyMethod: 'MOBILE_OTP',
      agreementVerifyMobile: destinationLabel || null,
    },
  });
  return otp;
}

// { ok } | { error, locked, attemptsLeft }
async function checkOtp(client, otp) {
  const st = otpState(client);
  if (!client.agreementOtpHash || !st.expiresAt) return { error: 'Send the code first — no code is waiting.' };
  if (st.locked) return { error: 'Too many wrong codes. Request a new code.', locked: true, attemptsLeft: 0 };
  if (st.expiresAt < new Date()) return { error: 'That code has expired. Request a new code.', expired: true };
  const given = Buffer.from(hashOtp(String(otp || '').replace(/\D/g, ''), client), 'hex');
  const want = Buffer.from(client.agreementOtpHash, 'hex');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    const attempts = st.attempts + 1;
    await prisma.client.update({ where: { id: client.id }, data: { agreementOtpAttempts: attempts } });
    const left = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
    return left > 0
      ? { error: `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`, attemptsLeft: left }
      : { error: 'That code is not right, and that was the last attempt. Request a new code.', locked: true, attemptsLeft: 0 };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// WHO SEES THE AGREEMENT, AND WHO MAY CHANGE IT.
//
// "The agreement can be viewed in the client login, BDE logins, Accountants,
//  Admin & Super Admin (view & edit)."
//
//   Super Admin / Admin (any product role)   view + EDIT
//   Manager / Assistant Manager              view (they see everything, view-only)
//   Accountant / Accounts roles              view
//   BDE                                      view — only for THEIR clients
//                                            (assigned, holding a requirement,
//                                            or named as BDE owner)
//   Client login                             view — only their own company
//   everyone else (TL, Recruiter, HR, …)     nothing
//
// Read from roles rather than a list of user ids, so a new BDE or accountant is
// covered the day they are created. Enforced by every route that serves an
// agreement, its images or its PDF.
// ---------------------------------------------------------------------------
async function agreementAccess(user, client) {
  if (!user || !client) return { view: false, edit: false, as: null };
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  const s = scope.atsScopeOf(user);
  if (user.role === 'CLIENT' || s.atsRole === 'CLIENT') {
    const own = !!user.clientId && user.clientId === client.id;
    return { view: own, edit: false, as: own ? 'client' : null };
  }
  if (user.role === 'CANDIDATE' || s.atsRole === 'CANDIDATE') return { view: false, edit: false, as: null };
  if (s.global) return { view: true, edit: true, as: 'admin' };
  const held = [user.role, s.atsRole, s.hrmsRole, s.accountsRole].filter(Boolean);
  if (held.some((r) => ['MANAGER', 'ASSISTANT_MANAGER'].includes(r))) return { view: true, edit: false, as: 'manager' };
  if (held.includes('ACCOUNTANT')) return { view: true, edit: false, as: 'accounts' };
  // A TL / STL VIEWS the agreements of the clients in their own team's scope
  // (clients rule, 2026-10-05 — read only, like Accounts).
  if (['TL', 'STL'].includes(s.atsRole)) {
    const inScope = !!(await prisma.client.findFirst({ where: { AND: [{ id: client.id }, scope.clientWhere(user)] }, select: { id: true } }));
    return { view: inScope, edit: false, as: inScope ? 'tl' : null };
  }
  if (s.atsRole === 'BDE') {
    const byName = client.bdeOwner && user.name && String(client.bdeOwner).trim().toLowerCase() === String(user.name).trim().toLowerCase();
    const inScope = byName || !!(await prisma.client.findFirst({ where: { AND: [{ id: client.id }, scope.clientWhere(user)] }, select: { id: true } }));
    return { view: inScope, edit: false, as: inScope ? 'bde' : null };
  }
  return { view: false, edit: false, as: null };
}

// The Prisma filter for "every agreement this login may see" (lists).
async function visibleClientWhere(user) {
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  const s = scope.atsScopeOf(user);
  if (user.role === 'CLIENT' || s.atsRole === 'CLIENT') return user.clientId ? { id: user.clientId } : null;
  if (user.role === 'CANDIDATE' || s.atsRole === 'CANDIDATE') return null;
  if (s.global) return {};
  const held = [user.role, s.atsRole, s.hrmsRole, s.accountsRole].filter(Boolean);
  if (held.some((r) => ['MANAGER', 'ASSISTANT_MANAGER', 'ACCOUNTANT'].includes(r))) return {};
  if (s.atsRole === 'BDE') return { OR: [scope.clientWhere(user), ...(user.name ? [{ bdeOwner: user.name }] : [])] };
  if (['TL', 'STL'].includes(s.atsRole)) return scope.clientWhere(user);
  return null;
}

// The execution summary a screen renders — safe for anyone with view access.
function executedSummary(client) {
  if (!client) return null;
  const link = linkExpiresAt(client);
  return {
    agreementId: client.agreementId,
    status: statusOf(client),
    sentAt: client.agreementSentAt || null,
    linkExpiresAt: link,
    linkExpired: !!(link && link < new Date() && OUT_FOR_SIGNATURE.includes(statusOf(client))),
    company: {
      sealedAt: client.agreementCompanySealedAt,
      signedBy: client.agreementCompanySignedBy,
      signMethod: client.agreementCompanySignName || null,
      hasStamp: !!client.agreementCompanyStampFile,
      hasSignature: !!client.agreementCompanySignFile,
    },
    clientSide: {
      sealedAt: client.agreementClientSealedAt,
      signedBy: client.agreementSignedBy,
      signedByTitle: client.agreementSignedByTitle,
      signMethod: client.agreementClientSignName || null,
      hasStamp: !!client.agreementClientStampFile,
      hasSignature: !!client.agreementClientSignFile,
      // Aadhaar eSign at eMudhra (verified with eMudhra's own status API).
      esign: client.agreementEsignProvider === 'eMudhra' && client.agreementEsignTxnId ? 'eMudhra' : null,
      esignTxnId: client.agreementEsignProvider === 'eMudhra' ? client.agreementEsignTxnId || null : null,
    },
    verification: client.agreementVerifiedAt
      ? {
        method: { MOBILE_OTP: 'OTP to registered contact', EMAIL_OTP: 'Code emailed to the client contact' }[client.agreementVerifyMethod] || client.agreementVerifyMethod,
        sentTo: client.agreementVerifyMobile,
        mobile: client.agreementVerifyMobile,
        verifiedAt: client.agreementVerifiedAt,
        note: client.agreementVerifyNote,
      }
      : null,
    signedAt: client.agreementSignedAt || null,
    activatedAt: client.agreementActivatedAt || null,
    awaitingCountersign: statusOf(client) === 'SIGNED' && !(client.agreementCompanySignFile && client.agreementCompanyStampFile),
    // What each side still has to add (signature / stamp / code) — the card shows it.
    // eslint-disable-next-line global-require
    missing: require('./agreementLifecycle').missingSeals(client),
    // eslint-disable-next-line global-require
    executed: require('./agreementLifecycle').isExecuted(client),
    pdfAvailable: ['SIGNED', 'ACTIVE', 'EXPIRED'].includes(statusOf(client)),
  };
}

// What the public signing page is told. No token, no hash, no contact detail
// beyond a masked hint of where the code will go.
async function publicView(client) {
  // eslint-disable-next-line global-require
  const core = require('./messagingCore');
  const st = statusOf(client);
  const steps = await stepsOf(client);
  const otp = otpState(client);
  // eslint-disable-next-line global-require
  const { consultantParty, keyTermsOf } = require('./agreement');
  // eslint-disable-next-line global-require
  const emudhraReady = await require('./emudhra').isAvailable().catch(() => false);
  return {
    // The 4th signing choice: Aadhaar eSign at eMudhra (only when set up).
    emudhra: { available: emudhraReady, signed: client.agreementEsignProvider === 'eMudhra' && !!client.agreementEsignTxnId },
    keyTerms: keyTermsOf(client, await consultantParty()),
    // Where the email code goes: the contact email on the client record, masked.
    contactEmail: core.maskEmail(String(client.contactEmail || client.recruitmentContactEmail || '').trim()) || null,
    clientName: client.name,
    agreementId: client.agreementId,
    document: client.agreementDocument,
    status: st,
    open: OUT_FOR_SIGNATURE.includes(st),
    linkExpiresAt: linkExpiresAt(client),
    consultant: { countersigned: !!client.agreementCompanySealedAt, sealedAt: client.agreementCompanySealedAt || null, signedBy: client.agreementCompanySignedBy || null, hasSignature: !!client.agreementCompanySignFile, hasStamp: !!client.agreementCompanyStampFile },
    proceededAt: steps.proceededAt,
    signature: client.agreementClientSignFile
      ? { captured: true, method: client.agreementClientSignName, signedBy: client.agreementSignedBy, signedByTitle: client.agreementSignedByTitle, at: client.agreementClientSealedAt }
      : { captured: false },
    hasStamp: !!client.agreementClientStampFile,
    registeredMobile: core.maskMobile(client.contactPhone) || null,
    otp: {
      waiting: otp.active && !otp.locked, sentTo: client.agreementVerifyMobile || null, expiresAt: otp.active ? otp.expiresAt : null,
      attemptsLeft: otp.attemptsLeft, locked: otp.locked, cooldownRemaining: otp.cooldownRemaining,
      sendsLeft: Math.max(0, OTP_MAX_SENDS - steps.otpSends), ttlMinutes: OTP_TTL_MINUTES,
    },
    verifiedAt: client.agreementVerifiedAt || null,
    signedAt: client.agreementSignedAt || null,
    signedBy: client.agreementSignedBy || null,
    signedByTitle: client.agreementSignedByTitle || null,
    activatedAt: client.agreementActivatedAt || null,
    pdfAvailable: ['SIGNED', 'ACTIVE', 'EXPIRED'].includes(st),
  };
}

module.exports = {
  OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_S, OTP_MAX_SENDS, LINK_DAYS,
  OUT_FOR_SIGNATURE, SIGN_METHODS, AGREE_METHOD, ACTION, RESET_EXECUTION, RESET_OTP,
  tokenHash, newLinkData, linkMeta, linkMetaField, tokenFor, pathFor, findByToken,
  statusOf, linkExpiresAt, linkState, stepsOf,
  otpState, issueOtp, checkOtp, hashOtp,
  agreementAccess, visibleClientWhere, executedSummary, publicView,
};
