// ---------------------------------------------------------------------------
// CANDIDATE ACCESS BY ONE-TIME CODE (spec B2 + the "My applications by email"
// security fix, 2026-10-03).
//
// The old public page answered anyone who typed an email with that person's
// applications. Now nothing about a person is shown until the visitor PROVES
// they own the address:
//
//   1. POST /api/portal/public/otp/request  { email }
//        -> always the same answer, whether or not the email is known
//           (no enumeration). A 6-digit code is mailed; only its hash is
//           stored (EmailVerification, purpose 'candidate-portal').
//   2. POST /api/portal/public/otp/verify   { email, code, name?, phone?, password? }
//        -> a wrong code costs an attempt (5 per code); codes expire in 10
//           minutes. A right code proves the address, and only THEN is the
//           candidate record with that email linked to a candidate login
//           (created if needed) and a session issued. No candidate on file:
//           the caller is asked for a name and becomes a new candidate
//           (careers-portal self-registration).
//
// LIMITS: per email (5 codes / hour, counted in the database), per IP
// (20 code requests / hour, 40 wrong codes / hour, in memory), per code
// (5 attempts, 10 minutes).
//
// NEVER LINKED BY THIS PATH: an email that already belongs to an employee or a
// client login — nothing is sent and the answer is the same.
//
// PHONE: the SMS code path is wired (sendSms) but switched off until an SMS
// provider exists (utils/portalSettings.js phoneOtpEnabled).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const mailer = require('./mailer');
const { logAudit } = require('./audit');
const { unguessablePasswordHash } = require('./employeeInvite');
const { portalSettings } = require('./portalSettings');

const PURPOSE = 'candidate-portal';
const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const PER_EMAIL_PER_HOUR = 5;
const PER_IP_REQUESTS_PER_HOUR = 20;
const PER_IP_FAILS_PER_HOUR = 40;
const HOUR = 3600000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (e) => String(e || '').trim().toLowerCase();
const hashCode = (key, code) => crypto.createHash('sha256').update(`${PURPOSE}|${key}|${code}`).digest('hex');

// The one answer every request gets (status 200), known email or not.
const GENERIC = `If this email can be used for the candidate portal, a 6-digit code has been sent to it. The code expires in ${TTL_MINUTES} minutes.`;

// ---- in-memory per-IP counters --------------------------------------------
const ipHits = new Map(); // key -> [timestamps]
function hit(key, limit) {
  const now = Date.now();
  const list = (ipHits.get(key) || []).filter((t) => now - t < HOUR);
  if (list.length >= limit) { ipHits.set(key, list); return false; }
  list.push(now);
  ipHits.set(key, list);
  return true;
}
function count(key) {
  const now = Date.now();
  return (ipHits.get(key) || []).filter((t) => now - t < HOUR).length;
}
// The caller's address. A header is believed ONLY when the connection itself
// comes from this machine (the nginx reverse proxy), and then only its LAST
// entry — the one the proxy appended — so a visitor cannot pick their own
// "IP" by sending X-Forwarded-For.
function ipOf(req) {
  if (!req) return 'unknown';
  const sock = String((req.socket && req.socket.remoteAddress) || req.ip || '');
  const loopback = /^(::1|127\.|::ffff:127\.)/.test(sock);
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (loopback && xff.length) return xff[xff.length - 1];
  return sock || 'unknown';
}

// Only the TEST SANDBOX may reset limits (scratchpad tests run many cases).
function resetLimitsForTests() {
  if (require('./sandbox').isSandbox()) ipHits.clear(); // eslint-disable-line global-require
}

// May a candidate login be issued / used for this address?
// Returns { blocked: true } for an employee / client / disabled login.
async function loginForEmail(email) {
  const [u] = await prisma.$queryRaw`SELECT id, role, status, candidateId FROM User WHERE lower(trim(email)) = ${email} LIMIT 1`;
  if (!u) return { user: null };
  if (u.role !== 'CANDIDATE') return { blocked: 'other-login', user: u };
  if (['Inactive', 'Suspended', 'Disabled'].includes(u.status)) return { blocked: 'disabled', user: u };
  return { user: u };
}

function codeMail(code) {
  return [
    'Hello,',
    '',
    `Your TeamLink candidate portal code is ${code}.`,
    `It expires in ${TTL_MINUTES} minutes and works once.`,
    '',
    'Enter it on the page where you asked for it. TeamLink will never ask you for this code by phone or chat.',
    'If you did not ask for it, ignore this message — nothing happens without the code.',
    '',
    '— TeamLink Consultants',
  ].join('\n');
}

// Issues a code. Returns { status, body }.
async function requestCode({ email: rawEmail, phone: rawPhone, channel = 'email', req, purposeNote = 'portal' }) {
  const ip = ipOf(req);
  if (channel === 'sms') {
    const s = await portalSettings();
    if (!s.phoneOtpEnabled) return { status: 400, body: { error: 'Codes by SMS are not available yet — use your email address.' } };
  }
  const email = norm(rawEmail);
  if (channel !== 'sms' && !EMAIL_RE.test(email)) return { status: 400, body: { error: 'Enter a valid email address.' } };
  if (!hit(`req|${ip}`, PER_IP_REQUESTS_PER_HOUR)) return { status: 429, body: { error: 'Too many code requests from this network — try again in an hour.' } };

  // ---- SMS path (OFF until an SMS provider exists) ----------------------
  if (channel === 'sms') {
    // eslint-disable-next-line global-require
    const { phoneKeys } = require('./candidateDedupe');
    const key = `phone:${(phoneKeys(rawPhone) || [])[0] || ''}`;
    if (key === 'phone:') return { status: 400, body: { error: 'Enter a valid mobile number.' } };
    const recent = await prisma.emailVerification.count({ where: { email: key, purpose: PURPOSE, createdAt: { gt: new Date(Date.now() - HOUR) } } });
    if (recent >= PER_EMAIL_PER_HOUR) return { status: 429, body: { error: 'Too many codes for this number — try again in an hour.' } };
    await prisma.emailVerification.updateMany({ where: { email: key, purpose: PURPOSE, consumedAt: null, verifiedAt: null }, data: { consumedAt: new Date() } });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await prisma.emailVerification.create({ data: { email: key, purpose: PURPOSE, codeHash: hashCode(key, code), expiresAt: new Date(Date.now() + TTL_MINUTES * 60000) } });
    // eslint-disable-next-line global-require
    setImmediate(() => require('./smsGateway').sendSms({ to: rawPhone, kind: 'otp', text: `Your TeamLink code is ${code}. Valid ${TTL_MINUTES} min.`, vars: [code] }).catch(() => {}));
    return { status: 200, body: { message: GENERIC.replace('email', 'mobile number'), ttlMinutes: TTL_MINUTES } };
  }

  // Per-email limit, counted in the database so a restart does not reset it.
  const recent = await prisma.emailVerification.count({ where: { email, purpose: PURPOSE, createdAt: { gt: new Date(Date.now() - HOUR) } } });
  if (recent >= PER_EMAIL_PER_HOUR) return { status: 429, body: { error: 'Too many codes were requested for this email — try again in an hour.' } };

  const login = await loginForEmail(email);

  // A fresh code retires every earlier one for this address.
  await prisma.emailVerification.updateMany({ where: { email, purpose: PURPOSE, consumedAt: null, verifiedAt: null }, data: { consumedAt: new Date() } });
  if (login.blocked) {
    // Same answer, nothing sent: an employee / client login is never turned
    // into a candidate login from a public form. The row looks EXACTLY like
    // a real one (same expiry, same attempt counting, a hash no 6-digit code
    // can produce), so a wrong-code answer ("4 tries left") cannot tell an
    // employee's address from anyone else's either.
    await prisma.emailVerification.create({
      data: { email, purpose: PURPOSE, codeHash: crypto.randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + TTL_MINUTES * 60000) },
    });
    return { status: 200, body: { message: GENERIC, ttlMinutes: TTL_MINUTES } };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await prisma.emailVerification.create({
    data: { email, purpose: PURPOSE, codeHash: hashCode(email, code), expiresAt: new Date(Date.now() + TTL_MINUTES * 60000) },
  });
  // Sent AFTER answering, so the response time does not depend on whether a
  // mail went out (timing would otherwise tell known from unknown).
  setImmediate(() => {
    mailer.sendMail({ to: email, subject: 'TeamLink — your one-time code', text: codeMail(code), useEmployeeFrom: false, fromName: '' })
      .then((r) => { if (!r.ok && !mailer.isReservedTestAddress(email)) console.warn(`[candidate-otp] code mail not sent (${purposeNote}): ${r.error}`); })
      .catch(() => {});
  });
  return { status: 200, body: { message: GENERIC, ttlMinutes: TTL_MINUTES } };
}

// Checks a code. Burns an attempt on a wrong one. Returns { ok } or { status, error }.
// `consume` false leaves a right code usable once more (used when the caller
// still has to give their name — nothing is created yet).
async function checkCode({ email: rawEmail, code: rawCode, req, consume = true }) {
  const ip = ipOf(req);
  const email = norm(rawEmail);
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!EMAIL_RE.test(email) || code.length !== 6) return { status: 400, error: 'Enter the 6-digit code from the email.' };
  if (count(`fail|${ip}`) >= PER_IP_FAILS_PER_HOUR) return { status: 429, error: 'Too many wrong codes from this network — try again in an hour.' };
  const row = await prisma.emailVerification.findFirst({
    where: { email, purpose: PURPOSE, consumedAt: null, verifiedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  const BAD = 'That code is not right, or it has expired. Ask for a new code.';
  if (!row) { hit(`fail|${ip}`, Infinity); return { status: 400, error: BAD }; }
  if (row.attempts >= MAX_ATTEMPTS) return { status: 429, error: 'Too many wrong tries on this code — ask for a new one.' };
  const a = Buffer.from(row.codeHash);
  const b = Buffer.from(hashCode(email, code));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const attempts = row.attempts + 1;
    await prisma.emailVerification.update({ where: { id: row.id }, data: { attempts } });
    hit(`fail|${ip}`, Infinity);
    const left = MAX_ATTEMPTS - attempts;
    return { status: 400, error: left > 0 ? `That code is not right — ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code is not right and no tries are left — ask for a new code.' };
  }
  if (consume) await prisma.emailVerification.update({ where: { id: row.id }, data: { attempts: row.attempts + 1, verifiedAt: new Date(), consumedAt: new Date() } });
  return { ok: true, email, rowId: row.id };
}

// The candidate record a proved address belongs to (oldest first, by the
// same normalised key the Add Candidate form and the portal import use).
async function candidateForEmail(email) {
  // eslint-disable-next-line global-require
  const { findCandidateByContact } = require('./jobPortalBridge');
  return findCandidateByContact({ email });
}

// Creates (or re-uses) the candidate login for a PROVED address. Called only
// after checkCode() / an invite's OTP succeeded.
async function ensureCandidateLogin({ email, candidate, name }) {
  const login = await loginForEmail(email);
  if (login.blocked === 'other-login') return { error: 'This email already signs in to TeamLink with another login. Use the normal sign-in page.', status: 409 };
  if (login.blocked === 'disabled') return { error: 'This portal login has been switched off. Contact TeamLink.', status: 403 };
  if (login.user) {
    const u = await prisma.user.findUnique({ where: { id: login.user.id } });
    if (u.candidateId && u.candidateId !== candidate.id) {
      // The login already points at another (duplicate) record — keep it.
      return { user: u, created: false };
    }
    // Archived after a year of no use, or invited and not yet proved: the
    // code is the proof, so the login is live again.
    const data = { status: 'Active' };
    if (!u.candidateId) data.candidateId = candidate.id;
    const fresh = await prisma.user.update({ where: { id: u.id }, data });
    return { user: fresh, created: false, reactivated: u.status !== 'Active' };
  }
  const user = await prisma.user.create({
    data: {
      name: String(name || candidate.name || email).slice(0, 120),
      email,
      username: email,
      passwordHash: await unguessablePasswordHash(),
      role: 'CANDIDATE',
      atsRole: 'CANDIDATE',
      hrmsRole: 'NONE',
      accountsRole: 'NONE',
      atsAccess: true,
      hrmsAccess: false,
      accountsAccess: false,
      candidateId: candidate.id,
      status: 'Active',
    },
  });
  return { user, created: true };
}

async function setOwnPassword(user, password) {
  // eslint-disable-next-line global-require
  const policy = require('./passwordPolicy');
  const weak = policy.strengthError(password, { email: user.email, name: user.name });
  if (weak) return { error: weak };
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(String(password), 10),
      ...policy.passwordEventData('link'),
      setPasswordTokenHash: null, setPasswordExpiresAt: null, setPasswordUsedAt: new Date(),
    },
  });
  return { ok: true };
}

// A normal 8-hour session, exactly what /api/auth/login issues.
async function sessionFor(user) {
  // eslint-disable-next-line global-require
  const { resolveIdentity, tokenPayload } = require('./identity');
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
  const identity = await resolveIdentity(user.id);
  return jwt.sign(tokenPayload(identity), process.env.JWT_SECRET, { expiresIn: '8h' });
}

// The whole public verify step. Returns { status, body }.
async function verifyAndSignIn({ email: rawEmail, code, name, phone, password, req }) {
  const email = norm(rawEmail);
  // Peek first: if there is no candidate and no name yet, the code is
  // checked but NOT burned — the visitor is asked for their name.
  const candidate = EMAIL_RE.test(email) ? await candidateForEmail(email) : null;
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!candidate && !cleanName) {
    const peek = await checkCode({ email, code, req, consume: false });
    if (!peek.ok) return { status: peek.status, body: { error: peek.error } };
    return { status: 200, body: { needsName: true, message: 'Your email is confirmed. We have no applications under it yet — enter your name to create your candidate profile.' } };
  }
  const login = await loginForEmail(email);
  if (login.blocked) {
    // No usable code exists for such an address; the generic wrong-code
    // answer keeps it indistinguishable.
    const r = await checkCode({ email, code, req });
    return { status: r.status || 400, body: { error: r.error || 'That code is not right, or it has expired. Ask for a new code.' } };
  }
  const ok = await checkCode({ email, code, req });
  if (!ok.ok) return { status: ok.status, body: { error: ok.error } };

  let cand = candidate;
  let registered = false;
  if (!cand) {
    const p = String(phone || '').trim();
    if (p && !/^[+\d][\d\s-]{6,18}$/.test(p)) return { status: 400, body: { error: 'Enter a valid phone number, or leave it empty.' } };
    cand = await prisma.candidate.create({ data: { name: cleanName, email, phone: p || null, source: 'Careers portal (self-registered)' } });
    registered = true;
    await logAudit({ action: 'Candidate self-registered (careers portal, email verified by code)', entity: 'Candidate', entityId: cand.id, toValue: cand.name });
  }
  const out = await ensureCandidateLogin({ email, candidate: cand, name: cleanName || cand.name });
  if (out.error) return { status: out.status, body: { error: out.error } };
  let passwordSet = false;
  if (password) {
    const pw = await setOwnPassword(out.user, password);
    if (pw.error) {
      // The address is proved and the login exists; only the password failed.
      // Sign them in anyway and let them choose another later.
      await logAudit({ userId: out.user.id, action: 'Candidate portal: password not set (too weak)', entity: 'User', entityId: out.user.id });
    } else passwordSet = true;
  }
  await logAudit({
    userId: out.user.id,
    action: `Candidate portal sign-in by email code${out.created ? ' (login created)' : ''}${out.reactivated ? ' (login re-activated)' : ''}`,
    entity: 'User', entityId: out.user.id, toValue: passwordSet ? 'Password set' : 'Code only',
  });
  const token = await sessionFor(out.user);
  return {
    status: 200,
    body: {
      token, registered, created: out.created, passwordSet,
      passwordError: password && !passwordSet ? 'Signed in — but that password was too weak, so it was not saved. You can keep signing in with a code.' : null,
    },
  };
}

module.exports = {
  PURPOSE, TTL_MINUTES, MAX_ATTEMPTS, PER_EMAIL_PER_HOUR, GENERIC,
  hashCode, requestCode, checkCode, candidateForEmail, ensureCandidateLogin, setOwnPassword, sessionFor,
  verifyAndSignIn, loginForEmail, resetLimitsForTests, ipOf,
};
