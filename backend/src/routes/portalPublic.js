// ---------------------------------------------------------------------------
// PUBLIC candidate-portal endpoints (no login) — mounted by routes/portal.js
// at /api/portal/public. Spec B2 + the "My applications by email" fix.
//
//   POST /otp/request              { email }                  -> same answer for every email
//   POST /otp/verify               { email, code, name?, phone?, password? } -> session
//   GET  /invite/:token            what the invite link page shows (masked email)
//   POST /invite/:token/send-code  mails an OTP to the invited address
//   POST /invite/:token/accept     { code, password? } -> proves the email, burns the link, session
//
// Nothing about a person's applications is ever returned here: the verify
// step returns a normal session token, and the applications are read from
// the signed-in candidate portal (GET /api/portal/candidate).
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const otp = require('../utils/candidatePortalAuth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

router.post('/otp/request', wrap(async (req, res) => {
  const b = req.body || {};
  const out = await otp.requestCode({ email: b.email, phone: b.phone, channel: b.channel === 'sms' ? 'sms' : 'email', req });
  return res.status(out.status).json(out.body);
}));

router.post('/otp/verify', wrap(async (req, res) => {
  const b = req.body || {};
  const out = await otp.verifyAndSignIn({ email: b.email, code: b.code, name: b.name, phone: b.phone, password: b.password, req });
  return res.status(out.status).json(out.body);
}));

// ---- "Invite to portal" link (candidate) -----------------------------------
// The link alone opens nothing: the candidate must prove the invited email
// with a code first (spec B2 — linking a login to a candidate record needs
// OTP proof, so a forwarded or leaked link cannot hijack the record).
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const mask = (e) => String(e || '').replace(/^(.)(.*)(.@.*)$/, (m, a, b, c) => `${a}${'•'.repeat(Math.min(6, b.length))}${c}`);

async function inviteUser(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return { error: 'This link is not valid.', status: 404 };
  const u = await prisma.user.findFirst({ where: { setPasswordTokenHash: hashToken(token) } });
  if (!u || u.role !== 'CANDIDATE' || !u.candidateId) return { error: 'This link is not valid — it may already have been used.', status: 404 };
  if (u.setPasswordUsedAt) return { error: 'This link has already been used.', status: 410 };
  if (!u.setPasswordExpiresAt || u.setPasswordExpiresAt < new Date()) return { error: 'This link has expired. Ask your recruiter for a new one, or sign in with a code on the My Applications page.', status: 410 };
  if (['Inactive', 'Suspended', 'Disabled'].includes(u.status)) return { error: 'This portal login has been switched off. Contact TeamLink.', status: 403 };
  return { user: u };
}

router.get('/invite/:token', wrap(async (req, res) => {
  const got = await inviteUser(req.params.token);
  if (got.error) return res.status(got.status).json({ error: got.error });
  return res.json({ name: got.user.name, email: mask(got.user.email), expiresAt: got.user.setPasswordExpiresAt, kind: 'candidate', needsCode: true });
}));

router.post('/invite/:token/send-code', wrap(async (req, res) => {
  const got = await inviteUser(req.params.token);
  if (got.error) return res.status(got.status).json({ error: got.error });
  const out = await otp.requestCode({ email: got.user.email, req, purposeNote: 'invite' });
  if (out.status !== 200) return res.status(out.status).json(out.body);
  return res.json({ message: `A 6-digit code has been sent to ${mask(got.user.email)}. It expires in ${otp.TTL_MINUTES} minutes.` });
}));

router.post('/invite/:token/accept', wrap(async (req, res) => {
  const got = await inviteUser(req.params.token);
  if (got.error) return res.status(got.status).json({ error: got.error });
  const u = got.user;
  const b = req.body || {};
  const ok = await otp.checkCode({ email: u.email, code: b.code, req });
  if (!ok.ok) return res.status(ok.status).json({ error: ok.error });
  // Proved: burn the link, activate the login.
  await prisma.user.update({
    where: { id: u.id },
    data: { status: 'Active', setPasswordUsedAt: new Date(), setPasswordTokenHash: null, setPasswordExpiresAt: null },
  });
  let passwordSet = false;
  let passwordError = null;
  if (b.password) {
    const pw = await otp.setOwnPassword(u, b.password);
    if (pw.error) passwordError = `${pw.error} You are signed in; you can keep using a code to sign in.`;
    else passwordSet = true;
  }
  await logAudit({ userId: u.id, action: 'Candidate portal invite accepted (email verified by code)', entity: 'User', entityId: u.id, toValue: passwordSet ? 'Password set' : 'Code only' });
  const token = await otp.sessionFor(u);
  return res.json({ token, passwordSet, passwordError });
}));

module.exports = router;
