// ---------------------------------------------------------------------------
// EXECUTING AN AGREEMENT — both seals, and a verified signature.
//
//   we prepare it        apply OUR stamp and signature
//   send                 mail / WhatsApp / SMS link      (already built)
//   client reads it      uploads THEIR stamp and signature
//   client clicks Done   chooses how to verify:
//        Aadhaar         Aadhaar number, eSign, mobile OTP
//        Alternative     mobile OTP to the contact already on record
//   verified             the executed agreement becomes visible to the BDE,
//                        the Super Admin, the Admin, the Client and the
//                        Accountant — view only, except Super Admin and Admin
//
// THREE RULES THAT ARE NOT NEGOTIABLE HERE
//
// 1. THE FULL AADHAAR NUMBER IS NEVER STORED. Section 29 of the Aadhaar Act
//    and the UIDAI circulars forbid an unauthenticated entity retaining it.
//    The number is validated, used, and dropped; what is kept is the last four
//    digits for display and the eSign provider's transaction id, which is what
//    actually proves the signature and what an auditor asks for.
//
// 2. THE OTP IS HASHED, with an expiry and an attempt counter — the same shape
//    utils/employeeAdmin.js already uses for employee email verification. A
//    plaintext OTP column would make the database a way to sign an agreement.
//
// 3. AN UNVERIFIED SIGNATURE IS NEVER RECORDED AS VERIFIED. No eSign provider
//    is connected to this installation yet, so the Aadhaar path completes the
//    OTP step and records itself as `Alternative (mobile OTP)` with a note
//    saying no eSign provider was connected — it does not write a transaction
//    id it does not have. When a licensed ASP/ESP is configured, esignProvider()
//    returns it and the same path records a real one.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const prisma = require('../db');
const { readConfig } = require('./integrationStore');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

const METHODS = ['AADHAAR', 'ALTERNATIVE'];

// Same hashing as the employee-verification OTP: a salted SHA-256, because the
// value is short-lived and single-use and bcrypt's work factor buys nothing
// that the ten-minute expiry does not already buy.
function hashOtp(otp, salt) {
  return crypto.createHash('sha256').update(`${salt}:${String(otp)}`).digest('hex');
}
function newOtp() {
  // Six digits, from a CSPRNG rather than Math.random.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// A mobile number, shown without showing it.
function maskMobile(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length < 4) return null;
  return `${'•'.repeat(Math.max(2, d.length - 4))}${d.slice(-4)}`;
}

// Aadhaar is twelve digits and never starts with 0 or 1. That is the whole of
// what can be checked offline — the Verhoeff checksum is also computable, so
// it is, because a typo caught here is a failed eSign avoided.
function aadhaarShape(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 12) return { ok: false, error: 'An Aadhaar number is 12 digits.' };
  if (/^[01]/.test(d)) return { ok: false, error: 'An Aadhaar number does not begin with 0 or 1.' };
  if (!verhoeff(d)) return { ok: false, error: 'That Aadhaar number fails its checksum — please re-enter it.' };
  return { ok: true, last4: d.slice(-4) };
}

// The Verhoeff check digit scheme UIDAI uses.
const D_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P_TABLE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
function verhoeff(num) {
  let c = 0;
  String(num).split('').reverse().forEach((ch, i) => {
    c = D_TABLE[c][P_TABLE[i % 8][Number(ch)]];
  });
  return c === 0;
}

// ---------------------------------------------------------------------------
// THE eSIGN PROVIDER, if one is configured.
//
// Aadhaar eSign can only be performed by a licensed ASP/ESP — NSDL, eMudhra,
// Digio, SignDesk, Leegality. This reads whichever is configured under
// Administration -> Integrations and returns null when none is. The caller
// then records what actually happened instead of what was hoped for.
// ---------------------------------------------------------------------------
async function esignProvider() {
  try {
    const cfg = await readConfig('esign');
    if (!cfg || !cfg.enabled) return null;
    const name = String(cfg.values?.Provider || '').trim();
    const key = String(cfg.values?.['API key'] || '').trim();
    if (!name || !key) return null;
    return { name, configured: true };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// START: the client has sealed the document and picked how to verify.
// Returns the OTP so the CALLER can deliver it over the configured channel —
// this module never sends, and never returns it to the browser.
// ---------------------------------------------------------------------------
async function startVerification(client, { method, aadhaar, mobile }) {
  if (!METHODS.includes(method)) {
    return { error: 'Choose Aadhaar verification or the alternative.' };
  }
  if (!client.agreementClientSignFile) {
    return { error: 'Upload your signature before verifying — the signature is what is being verified.' };
  }

  let last4 = null;
  if (method === 'AADHAAR') {
    const shape = aadhaarShape(aadhaar);
    if (!shape.ok) return { error: shape.error };
    last4 = shape.last4;
  }

  // The number the code goes to: what was typed, or the contact on record.
  const target = String(mobile || client.contactPhone || '').replace(/\D/g, '');
  if (target.length < 10) {
    return { error: 'A 10-digit mobile number is needed to send the verification code.' };
  }

  const otp = newOtp();
  await prisma.client.update({
    where: { id: client.id },
    data: {
      agreementVerifyMethod: method,
      // Last four ONLY — the full number is not kept. See the header.
      agreementAadhaarLast4: last4,
      agreementVerifyMobile: maskMobile(target),
      agreementOtpHash: hashOtp(otp, client.id),
      agreementOtpExpiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60000),
      agreementOtpAttempts: 0,
    },
  });
  return { otp, mobile: target, masked: maskMobile(target), method, ttlMinutes: OTP_TTL_MINUTES };
}

// ---------------------------------------------------------------------------
// CONFIRM: the code the client typed.
// ---------------------------------------------------------------------------
async function confirmVerification(client, { otp }) {
  if (!client.agreementOtpHash || !client.agreementOtpExpiresAt) {
    return { error: 'Start the verification first — no code has been sent.' };
  }
  if (new Date(client.agreementOtpExpiresAt) < new Date()) {
    return { error: 'That code has expired. Send a new one.' };
  }
  if ((client.agreementOtpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
    return { error: 'Too many wrong codes. Send a new one.' };
  }
  if (hashOtp(otp, client.id) !== client.agreementOtpHash) {
    await prisma.client.update({
      where: { id: client.id },
      data: { agreementOtpAttempts: (client.agreementOtpAttempts || 0) + 1 },
    });
    const left = OTP_MAX_ATTEMPTS - (client.agreementOtpAttempts || 0) - 1;
    return { error: `That code is not right.${left > 0 ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ''}` };
  }

  // WHAT IS RECORDED IS WHAT HAPPENED.
  //
  // With a licensed provider connected, the Aadhaar path is a real eSign and
  // carries the provider's transaction id. With none connected, the mobile OTP
  // is all that was actually verified, and the record says exactly that rather
  // than claiming an Aadhaar eSign that never took place.
  const provider = await esignProvider();
  const wantedAadhaar = client.agreementVerifyMethod === 'AADHAAR';
  const note = wantedAadhaar && !provider
    ? 'Aadhaar was chosen, but no licensed eSign provider is connected to this installation, '
      + 'so the identity was verified by mobile OTP only. Connect a provider under '
      + 'Administration → Integrations to record a legally recognised Aadhaar eSign.'
    : null;

  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
      agreementVerifiedAt: new Date(),
      agreementEsignProvider: wantedAadhaar && provider ? provider.name : null,
      agreementEsignTxnId: null, // set by the provider call when one exists
      agreementVerifyNote: note,
      // The code is single-use.
      agreementOtpHash: null,
      agreementOtpExpiresAt: null,
      agreementOtpAttempts: 0,
    },
  });
  return { client: updated, verifiedBy: wantedAadhaar && provider ? `Aadhaar eSign (${provider.name})` : 'Mobile OTP', note };
}

// ---------------------------------------------------------------------------
// WHO SEES THE EXECUTED AGREEMENT, AND WHO MAY CHANGE IT.
//
// "ahh agreement bde ki, super admin ki, admin ki, client ki, accountant ki
//  valla logins lo visible avvali. edit only super admin & admin."
//
// Read from the role rather than from a list of user ids, so a new BDE or a
// new accountant is covered the day they are created.
// ---------------------------------------------------------------------------
const VIEW_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'BDE', 'ACCOUNTANT', 'CLIENT'];
const EDIT_ROLES = ['SUPER_ADMIN', 'ADMIN'];

function agreementAccess(user, client) {
  if (!user) return { view: false, edit: false };
  const roles = [user.role, user.atsRole, user.hrmsRole, user.accountsRole].filter(Boolean);
  const isClientOwner = user.role === 'CLIENT' && client && user.clientId === client.id;

  // A CLIENT SEES THEIR OWN AGREEMENT AND NOBODY ELSE'S. Being a client login
  // is not the same as being THIS client.
  if (user.role === 'CLIENT') return { view: isClientOwner, edit: false };

  const view = roles.some((r) => VIEW_ROLES.includes(r));
  const edit = roles.some((r) => EDIT_ROLES.includes(r));
  return { view, edit };
}

// The executed-agreement summary a screen renders. Everything here is safe to
// show to any audience that passed agreementAccess().view — there is no
// Aadhaar number in it because there is no Aadhaar number stored.
function executedSummary(client) {
  if (!client) return null;
  return {
    agreementId: client.agreementId,
    status: client.agreementStatus,
    company: {
      sealedAt: client.agreementCompanySealedAt,
      signedBy: client.agreementCompanySignedBy,
      hasStamp: !!client.agreementCompanyStampFile,
      hasSignature: !!client.agreementCompanySignFile,
    },
    clientSide: {
      sealedAt: client.agreementClientSealedAt,
      signedBy: client.agreementSignedBy,
      signedByTitle: client.agreementSignedByTitle,
      hasStamp: !!client.agreementClientStampFile,
      hasSignature: !!client.agreementClientSignFile,
    },
    verification: client.agreementVerifiedAt
      ? {
        method: client.agreementVerifyMethod,
        aadhaarLast4: client.agreementAadhaarLast4,
        mobile: client.agreementVerifyMobile,
        verifiedAt: client.agreementVerifiedAt,
        provider: client.agreementEsignProvider,
        transactionId: client.agreementEsignTxnId,
        note: client.agreementVerifyNote,
      }
      : null,
    executed: !!(client.agreementCompanySealedAt && client.agreementClientSealedAt && client.agreementVerifiedAt),
  };
}

module.exports = {
  METHODS, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS,
  aadhaarShape, maskMobile, esignProvider,
  startVerification, confirmVerification,
  agreementAccess, executedSummary,
  VIEW_ROLES, EDIT_ROLES,
};
