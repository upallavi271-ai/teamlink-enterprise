// ---------------------------------------------------------------------------
// EXPENSE CLAIM PAID TO A PHONE NUMBER: the number is proved first (founder 2026-10-30: "phone number ahh kadha verification
// ravali"). The employee types the number on the claim, gets a 6-digit code by SMS on it, types the code; the server answers with
// a short-lived signed proof that this employee proved this number, and the claim is saved with that number only when the proof
// matches. The code goes out through the app's one SMS door (utils/employeeVerification.js sendCode -> utils/messaging.js): only
// the provider accepting it counts as sent; nothing is ever faked, and the code is never returned to the screen.
// Pending codes live in memory (a restart only means asking for a new code); 10 minutes, 5 tries, one code a minute.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const TTL_MIN = 10;
const MAX_TRIES = 5;
const RESEND_S = 60;
const PROOF_HOURS = 24;
const pending = new Map(); // employeeId -> { phone, hash, exp, tries, sentAt }

// An Indian mobile: 10 digits starting 6-9, with or without +91 / 0.
function normalise(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}
const mask = (p) => `${p.slice(0, 2)}******${p.slice(-2)}`;
const hashOf = (employeeId, phone, code) => crypto.createHash('sha256').update(`${employeeId}|${phone}|${code}`).digest('hex');
const secret = () => crypto.createHmac('sha256', String(process.env.JWT_SECRET || 'teamlink')).update('expense pay phone v1').digest();

function proofFor(employeeId, phone) {
  const exp = Date.now() + PROOF_HOURS * 3600 * 1000;
  const sig = crypto.createHmac('sha256', secret()).update(`${employeeId}|${phone}|${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}
function proofOk(employeeId, phone, proof) {
  const [exp, sig] = String(proof || '').split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const want = crypto.createHmac('sha256', secret()).update(`${employeeId}|${phone}|${exp}`).digest('base64url');
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

// -> { status, body }
async function start(employee, rawPhone) {
  const phone = normalise(rawPhone);
  if (!phone) return { status: 400, body: { error: 'Enter a 10-digit mobile number.' } };
  const had = pending.get(employee.id);
  if (had && Date.now() - had.sentAt < RESEND_S * 1000) {
    const wait = Math.ceil((RESEND_S * 1000 - (Date.now() - had.sentAt)) / 1000);
    return { status: 429, body: { error: `A code was sent a moment ago. Wait ${wait} seconds before asking for another.`, retryAfter: wait } };
  }
  const V = require('./employeeVerification'); // eslint-disable-line global-require
  const channel = await V.smsChannel();
  if (!channel.deliverable) return { status: 409, body: { error: channel.reason || 'No SMS service is set up, so the number cannot be verified.', notConfigured: true } };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ref = `P${Date.now().toString(36).toUpperCase()}`;
  const sent = await V.sendCode({ employee, otp: code, mobile: phone, ttlMinutes: TTL_MIN, ref });
  if (!sent.ok) return { status: sent.notConfigured ? 409 : 502, body: { error: `The code could not be sent: ${sent.error || 'the SMS provider did not accept it'}`, ref } };
  pending.set(employee.id, { phone, hash: hashOf(employee.id, phone, code), exp: Date.now() + TTL_MIN * 60000, tries: 0, sentAt: Date.now() });
  return { status: 200, body: { sent: true, to: mask(phone), ttlMinutes: TTL_MIN, ref, note: 'The SMS provider accepted the message. It usually arrives within a minute.' } };
}

// -> { status, body: { verified, proof, phone } }
function confirm(employee, rawPhone, code) {
  const phone = normalise(rawPhone);
  const p = pending.get(employee.id);
  if (!p || !phone || p.phone !== phone) return { status: 400, body: { error: 'Ask for a code for this number first.' } };
  if (Date.now() > p.exp) { pending.delete(employee.id); return { status: 400, body: { error: 'The code has expired. Ask for a new one.' } }; }
  if (p.tries >= MAX_TRIES) { pending.delete(employee.id); return { status: 400, body: { error: 'Too many wrong codes. Ask for a new one.' } }; }
  p.tries += 1;
  if (hashOf(employee.id, phone, String(code || '').trim()) !== p.hash) return { status: 400, body: { error: `That code is not right. ${MAX_TRIES - p.tries} tries left.` } };
  pending.delete(employee.id);
  return { status: 200, body: { verified: true, phone, proof: proofFor(employee.id, phone) } };
}

module.exports = { normalise, mask, start, confirm, proofOk, proofFor, _pending: pending };
