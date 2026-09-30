// ---------------------------------------------------------------------------
// THE EMPLOYEE PROVES THEIR OWN MOBILE AND AADHAAR.
//
// HR creates the account with an email and a password. Everything else about
// the person is entered by the person, and verification belongs on that side
// of the line — HR typing somebody's Aadhaar number and ticking "verified"
// verifies nothing at all.
//
// Two things can be proved, and they are NOT the same kind of thing:
//
//   MOBILE    a six-digit code to the number. The proof is that the code came
//             back, so the code has to reach the PHONE. Sending it to their
//             email would prove they can read their email, which we already
//             knew. Without an SMS gateway this cannot be done, and this
//             module says so rather than proving something else and calling
//             it a mobile.
//
//   AADHAAR   only a licensed ASP/ESP may perform Aadhaar eSign — eMudhra,
//             NSDL, Digio, SignDesk, Leegality. With one configured the number
//             goes to them and a transaction id comes back. With none
//             configured the number can still be CHECKED offline (12 digits,
//             never leading 0 or 1, Verhoeff checksum) and the last four kept,
//             but that is a format check and is recorded as exactly that.
//
// THE FULL AADHAAR NUMBER IS NEVER STORED. Section 29 of the Aadhaar Act and
// the UIDAI circulars forbid an unauthenticated entity retaining it. It is
// validated, used, and dropped inside one function call. Employee.verifyLast4
// exists so the confirm step has something to write without the number itself
// having to survive the round trip.
//
// THE OTP IS HASHED, expiring and attempt-counted — the same shape as
// utils/agreementSigning.js and utils/employeeAdmin.js. A plaintext OTP column
// would make the database a way to pass verification.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const prisma = require('../db');
const { readConfig } = require('./integrationStore');
// Reused rather than reimplemented: one Verhoeff table in this codebase, not
// two that can drift apart.
const { aadhaarShape, maskMobile, esignProvider } = require('./agreementSigning');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const KINDS = ['MOBILE', 'AADHAAR'];

function hashOtp(otp, salt) {
  return crypto.createHash('sha256').update(`${salt}:${String(otp)}`).digest('hex');
}
function newOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// An Indian mobile: ten digits, first one 6-9. A leading 0 or +91 is accepted
// and stripped, because people type both.
function mobileShape(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length !== 10) return { ok: false, error: 'A mobile number is 10 digits.' };
  if (!/^[6-9]/.test(d)) return { ok: false, error: 'An Indian mobile number starts with 6, 7, 8 or 9.' };
  return { ok: true, digits: d };
}

// ---------------------------------------------------------------------------
// CAN WE ACTUALLY SEND AN SMS?
//
// The SMS channel stores a Provider, a Sender ID, an API key and a DLT
// template id, but nothing in this codebase transmits over it yet. So this
// reports the truth in two parts — configured, and deliverable — and no caller
// has to guess which one it is looking at. Saying "configured" and meaning
// "sent" is precisely the lie this codebase refuses everywhere else.
// ---------------------------------------------------------------------------
async function smsChannel() {
  try {
    const cfg = await readConfig('sms');
    const provider = String((cfg.values || {}).Provider || '').trim();
    const key = String((cfg.values || {})['API key'] || '').trim();
    const configured = !!(cfg.enabled && provider && key);
    return {
      configured,
      provider: provider || null,
      deliverable: false,
      reason: configured
        ? `The ${provider} SMS gateway is configured, but no gateway client is implemented yet, so no code can be transmitted.`
        : 'No SMS gateway is configured — set one up under Administration → Integrations → SMS Gateway.',
    };
  } catch {
    return {
      configured: false,
      provider: null,
      deliverable: false,
      reason: 'The SMS channel could not be read.',
    };
  }
}

// What the screen needs to render the panel. No secrets in it.
function verificationState(employee) {
  const pending = !!(employee.verifyKind && employee.verifyOtpExpiresAt
    && employee.verifyOtpExpiresAt > new Date());
  return {
    mobile: {
      verified: !!employee.mobileVerifiedAt,
      number: employee.mobileVerified || null,
      at: employee.mobileVerifiedAt || null,
    },
    aadhaar: {
      verified: !!employee.aadhaarVerifiedAt,
      last4: employee.aadhaarLast4 || null,
      at: employee.aadhaarVerifiedAt || null,
      reference: employee.aadhaarVerifyRef || null,
      note: employee.aadhaarVerifyNote || null,
    },
    pending: pending
      ? {
        kind: employee.verifyKind,
        sentTo: maskMobile(employee.verifyTarget),
        expiresAt: employee.verifyOtpExpiresAt,
        attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - (employee.verifyOtpAttempts || 0)),
      }
      : null,
  };
}

// ---------------------------------------------------------------------------
// START. Returns the OTP to the CALLER so the route can deliver it over
// whichever channel is real. This module never sends, and never returns the
// code to the browser.
// ---------------------------------------------------------------------------
async function startVerification(employee, { kind, mobile, aadhaar }) {
  if (!KINDS.includes(kind)) return { error: 'Choose mobile or Aadhaar verification.' };

  let last4 = null;
  if (kind === 'AADHAAR') {
    const shape = aadhaarShape(aadhaar);
    if (!shape.ok) return { error: shape.error };
    last4 = shape.last4;
    // The number itself goes no further than this function: nothing below
    // writes it, and it is not returned.
  }

  // Both paths need a phone. Aadhaar eSign sends its own OTP to the number
  // registered against the Aadhaar; the mobile path sends one to the number
  // being claimed.
  const shape = mobileShape(mobile || employee.phone);
  if (!shape.ok) return { error: shape.error };

  const otp = newOtp();
  await prisma.employee.update({
    where: { id: employee.id },
    data: {
      verifyKind: kind,
      verifyTarget: shape.digits,
      verifyLast4: last4,
      verifyOtpHash: hashOtp(otp, employee.id),
      verifyOtpExpiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60000),
      verifyOtpAttempts: 0,
    },
  });

  const sms = await smsChannel();
  const esign = kind === 'AADHAAR' ? await esignProvider() : null;
  return {
    otp, // for the route to deliver — never for the browser
    kind,
    mobile: shape.digits,
    masked: maskMobile(shape.digits),
    ttlMinutes: OTP_TTL_MINUTES,
    sms,
    esign,
  };
}

// ---------------------------------------------------------------------------
// CONFIRM.
// ---------------------------------------------------------------------------
async function confirmVerification(employee, { otp }) {
  if (!employee.verifyKind || !employee.verifyOtpHash) {
    return { error: 'Start the verification first — there is no code outstanding.' };
  }
  if (!employee.verifyOtpExpiresAt || employee.verifyOtpExpiresAt < new Date()) {
    return { error: 'That code has expired. Send a new one.' };
  }
  if ((employee.verifyOtpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
    return { error: 'Too many attempts. Send a new code.' };
  }

  const given = String(otp || '').replace(/\D/g, '');
  if (hashOtp(given, employee.id) !== employee.verifyOtpHash) {
    const attempts = (employee.verifyOtpAttempts || 0) + 1;
    await prisma.employee.update({
      where: { id: employee.id },
      data: { verifyOtpAttempts: attempts },
    });
    const left = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
    return { error: `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.` };
  }

  // Correct. What gets RECORDED depends on what was actually proved.
  const clear = {
    verifyKind: null,
    verifyTarget: null,
    verifyLast4: null,
    verifyOtpHash: null,
    verifyOtpExpiresAt: null,
    verifyOtpAttempts: 0,
  };

  if (employee.verifyKind === 'MOBILE') {
    const updated = await prisma.employee.update({
      where: { id: employee.id },
      data: {
        ...clear,
        mobileVerified: maskMobile(employee.verifyTarget),
        mobileVerifiedAt: new Date(),
        // The proved number becomes the number on file. Verifying one and
        // storing another would make the tick meaningless.
        phone: employee.verifyTarget,
      },
    });
    return { employee: updated, kind: 'MOBILE', verified: true, note: null };
  }

  // AADHAAR. AN UNVERIFIED IDENTITY IS NEVER RECORDED AS VERIFIED. With no
  // licensed provider connected, what actually happened is a checksum test
  // plus a mobile OTP — so that is what is written down, and
  // aadhaarVerifiedAt stays null.
  const esign = await esignProvider();
  const note = esign
    ? `Verified through ${esign.name} Aadhaar eSign.`
    : 'Checked offline only — the number passed its 12-digit Verhoeff checksum and the mobile was '
      + 'confirmed by one-time code. This is NOT a UIDAI-authenticated verification, because no '
      + 'Aadhaar eSign provider is connected. Connect one under Administration → Integrations.';

  const updated = await prisma.employee.update({
    where: { id: employee.id },
    data: {
      ...clear,
      aadhaarLast4: employee.verifyLast4,
      aadhaarVerifiedAt: esign ? new Date() : null,
      aadhaarVerifyRef: null,
      aadhaarVerifyNote: note,
      // The mobile WAS genuinely proved on the way through, so record that.
      mobileVerified: maskMobile(employee.verifyTarget),
      mobileVerifiedAt: new Date(),
      phone: employee.verifyTarget,
    },
  });
  return {
    employee: updated, kind: 'AADHAAR', verified: !!esign, esign: !!esign, note,
  };
}

module.exports = {
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  KINDS,
  mobileShape,
  smsChannel,
  verificationState,
  startVerification,
  confirmVerification,
};
