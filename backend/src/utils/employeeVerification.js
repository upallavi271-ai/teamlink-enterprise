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
const { maskMobile } = require('./messagingCore');

// 2026-10-28: aadhaarShape / esignProvider / maskMobile used to come from
// utils/agreementSigning.js. That module stopped exporting them, so "Send the
// code" crashed ("maskMobile is not a function" -> "Something went wrong").
// The Verhoeff check lives here now — this is its only user.
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
  String(num).split('').reverse().forEach((ch, i) => { c = D_TABLE[c][P_TABLE[i % 8][Number(ch)]]; });
  return c === 0;
}
// Twelve digits, never starting 0 or 1, Verhoeff checksum.
function aadhaarShape(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length !== 12) return { ok: false, error: 'An Aadhaar number is 12 digits.' };
  if (/^[01]/.test(d)) return { ok: false, error: 'An Aadhaar number does not begin with 0 or 1.' };
  if (!verhoeff(d)) return { ok: false, error: 'That Aadhaar number fails its checksum — please re-enter it.' };
  return { ok: true, last4: d.slice(-4) };
}
// The licensed eSign provider (Administration → Integrations → eMudhra eSign), or null.
async function esignProvider() {
  try {
    const cfg = await readConfig('esign');
    if (!cfg || !cfg.enabled || !cfg.connected) return null;
    const token = String((cfg.values || {})['Auth token'] || '').trim();
    return token ? { name: 'eMudhra', configured: true } : null;
  } catch {
    return null;
  }
}

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
// CAN WE ACTUALLY SEND AN SMS? (fixed 2026-10-28)
//
// The answer comes from the SAME place every other SMS in the app uses
// (channels/index.js: the SMS providers in order — the paid gateway of
// Administration → Integrations → SMS Gateway, or an Android phone), so a
// gateway that sends the Test SMS is the gateway the OTP goes through.
// Before, this read two labels the SMS form never saves ("Provider",
// "API key"), so it said "No SMS gateway is configured" even when SMS Push
// Platform was connected — and nothing here ever sent.
//
// configured  = an SMS provider is ready;  deliverable = an OTP can go on it
// (MSG91 and SMS Push Platform deliver only a DLT-approved OTP template).
// ---------------------------------------------------------------------------
const GATEWAY_SCREEN = 'Administration → Integrations → SMS Gateway';
async function smsChannel() {
  try {
    const channels = require('../channels'); // eslint-disable-line global-require
    const st = await channels.status('SMS');
    if (!st.configured) {
      return {
        configured: false, provider: null, deliverable: false,
        reason: `No SMS gateway is ready to send — ${String(st.reason || 'not set up').replace(/[.s]+$/, '')}. Set it up under ${GATEWAY_SCREEN}.`,
      };
    }
    const provider = st.providerLabel || st.via || null;
    if (st.provider === 'sms.gateway') {
      const g = await require('./smsGateway').smsConfig(); // eslint-disable-line global-require
      if (['SMSGW', 'MSG91'].includes(g.provider) && !g.templates.otp) {
        const field = g.provider === 'SMSGW' ? '"SMS Push Platform: DLT Template ID — OTP"' : '"DLT template ID — OTP"';
        return {
          configured: true, provider, deliverable: false, missing: 'otpTemplate',
          reason: `${g.providerLabel} is connected, but its OTP DLT Template ID is empty, and Indian operators deliver only an approved template. Add it under ${GATEWAY_SCREEN} (${field}).`,
        };
      }
    }
    return { configured: true, provider, deliverable: true, reason: null };
  } catch {
    return { configured: false, provider: null, deliverable: false, reason: 'The SMS channel could not be read.' };
  }
}

// ---------------------------------------------------------------------------
// DELIVER THE CODE through the app's one SMS door (utils/messaging.js, the
// same send as the agreement-signing OTP). Accepted by the provider is the
// only success: a refusal, a missing setting or an unreadable answer comes
// back as { ok: false, error } in the provider's own words.
// ref = a correlation id for the server log and the screen; the code, the
// number and every credential stay out of the log.
// ---------------------------------------------------------------------------
async function sendCode({ employee, otp, mobile, ttlMinutes, ref }) {
  const sms = require('./smsGateway'); // eslint-disable-line global-require
  const messaging = require('./messaging'); // eslint-disable-line global-require
  const cfg = await sms.smsConfig().catch(() => null);
  const fallback = `${otp} is your TeamLink verification code. It is valid for ${ttlMinutes} minutes. Do not share it.`;
  const text = sms.otpText(cfg, otp, ttlMinutes, fallback);
  const r = await messaging.send('SMS', {
    to: mobile, kind: 'otp', text, vars: [otp, ttlMinutes],
    meta: { audience: 'employee', personId: employee.id, personName: employee.name, purpose: 'Mobile verification OTP', module: 'HRMS', masked: true }, // no sender: an OTP never spends a person's message credits
  });
  console.info(`[verify-otp ${ref}] provider=${r.provider || '-'} outcome=${r.outcome}${r.providerRef ? ` providerRef=${r.providerRef}` : ''}${r.errorCode ? ` code=${r.errorCode}` : ''}${r.ok ? '' : ` error="${String(r.error || '').slice(0, 200)}"`}`);
  return r;
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

// Seconds before another code may be sent (one a minute), 0 = now.
const OTP_RESEND_COOLDOWN_S = 60;
function resendWait(employee) {
  if (!employee.verifyOtpExpiresAt || !employee.verifyOtpHash) return 0;
  const issued = new Date(employee.verifyOtpExpiresAt).getTime() - OTP_TTL_MINUTES * 60000;
  return Math.max(0, Math.ceil((issued + OTP_RESEND_COOLDOWN_S * 1000 - Date.now()) / 1000));
}

// A code that did not leave is not outstanding.
async function clearPending(employeeId) {
  await prisma.employee.update({
    where: { id: employeeId },
    data: { verifyKind: null, verifyTarget: null, verifyLast4: null, verifyOtpHash: null, verifyOtpExpiresAt: null, verifyOtpAttempts: 0 },
  });
}

module.exports = {
  sendCode,
  resendWait,
  clearPending,
  OTP_RESEND_COOLDOWN_S,
  aadhaarShape,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  KINDS,
  mobileShape,
  smsChannel,
  verificationState,
  startVerification,
  confirmVerification,
};
