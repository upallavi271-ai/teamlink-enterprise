// ---------------------------------------------------------------------------
// Sign-in details for a newly created employee — by email, from HR.
//
// WHY A LINK AND NOT A PASSWORD
// The lifecycle says "credentials go out from the HR mailbox". The obvious
// reading is "email them the password", and this module deliberately does not
// do that. A password in an inbox is a password in a mail server's storage, in
// every forward of that thread and in every backup of it, and it is still
// valid months later. Instead HR's mail carries a SINGLE-USE, EXPIRING link:
//
//   * the token is 32 random bytes; only its SHA-256 hash is stored, so
//     reading the database does not reconstruct the link;
//   * it expires (SET_PASSWORD_TTL_HOURS, 48h by default);
//   * it is burned the moment it is used (setPasswordUsedAt);
//   * the password the employee picks is never seen by HR, never logged and
//     never echoed back by any endpoint here.
//
// The account is created with a random unguessable passwordHash, so the link
// is the ONLY way in until the employee sets their own password. Nothing in
// this file ever writes a password into a mail body.
//
// SENDER IDENTITY — the acting HR user's own address
// utils/candidateComms.js senderIdentity() already resolves "the Employee
// record behind this login, and its email" for candidate messages. It is
// reused verbatim here, so the sign-in mail leaves from the HR person who
// pressed the button, with Reply-To pointing back at them (see utils/mailer.js
// for the envelope shape and the SPF/DKIM caveat).
//
// DEGRADING HONESTLY
// When no SMTP provider is configured, nothing pretends. sendCredentials()
// returns { sent: false, notConfigured: true, reason }, writes that same
// sentence onto Employee.credentialsSentStatus, and hands the caller the
// set-password link so HR can pass it on themselves. The screens print it.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { sendMail, emailConfig } = require('./mailer');
const { senderIdentity } = require('./candidateComms');

const SET_PASSWORD_TTL_HOURS = Number(process.env.SET_PASSWORD_TTL_HOURS || 48);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// A password nobody knows — not HR, not this process after the call returns.
// It exists only so the User row has a valid hash before the employee sets
// their own. It is never returned, printed or logged.
async function unguessablePasswordHash() {
  return bcrypt.hash(crypto.randomBytes(48).toString('hex'), 10);
}

// Issues (or re-issues) the one-time link for a login. Any previously issued
// token stops working, because the stored hash is replaced.
async function issueSetPasswordToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SET_PASSWORD_TTL_HOURS * 60 * 60 * 1000);
  await prisma.user.update({
    where: { id: userId },
    data: { setPasswordTokenHash: hashToken(token), setPasswordExpiresAt: expiresAt, setPasswordUsedAt: null },
  });
  return { token, expiresAt };
}

// Where the employee's browser should land. An explicit APP_BASE_URL wins;
// otherwise the origin the request came from (the frontend dev server or the
// deployed host), which is what HR is looking at right now.
function appBaseUrl(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/+$/, '');
  const origin = req && req.headers && req.headers.origin;
  if (origin) return String(origin).replace(/\/+$/, '');
  const host = req && req.headers && req.headers.host;
  return host ? `http://${host}` : 'http://localhost:5183';
}

// The redeemer for the public route. Returns { ok } or { ok: false, reason }.
// It never says whether a token merely expired vs never existed to an
// unauthenticated caller beyond the one word the screen needs.
async function redeemSetPasswordToken(token, password) {
  if (!token) return { ok: false, code: 'invalid', reason: 'This link is not valid.' };
  if (!password || String(password).length < 8) {
    return { ok: false, code: 'weak', reason: 'Choose a password of at least 8 characters.' };
  }
  const user = await prisma.user.findFirst({ where: { setPasswordTokenHash: hashToken(token) } });
  if (!user) return { ok: false, code: 'invalid', reason: 'This link is not valid — it may already have been used.' };
  if (user.setPasswordUsedAt) return { ok: false, code: 'used', reason: 'This link has already been used.' };
  if (!user.setPasswordExpiresAt || user.setPasswordExpiresAt < new Date()) {
    return { ok: false, code: 'expired', reason: 'This link has expired. Ask HR to send a new one.' };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(String(password), 10),
      setPasswordUsedAt: new Date(),
      setPasswordTokenHash: null,
      setPasswordExpiresAt: null,
      status: user.status === 'Inactive' ? 'Active' : user.status,
    },
  });
  return { ok: true, email: user.email, name: user.name };
}

// Read-only check, for the screen that renders the form.
async function inspectSetPasswordToken(token) {
  if (!token) return { ok: false, reason: 'This link is not valid.' };
  const user = await prisma.user.findFirst({ where: { setPasswordTokenHash: hashToken(token) } });
  if (!user) return { ok: false, reason: 'This link is not valid — it may already have been used.' };
  if (user.setPasswordUsedAt) return { ok: false, reason: 'This link has already been used.' };
  if (!user.setPasswordExpiresAt || user.setPasswordExpiresAt < new Date()) {
    return { ok: false, reason: 'This link has expired. Ask HR to send a new one.' };
  }
  return { ok: true, name: user.name, email: user.email, expiresAt: user.setPasswordExpiresAt };
}

function body({ employee, actingName, link, expiresAt, companyName }) {
  return [
    `Hi ${employee.name},`,
    '',
    `Your ${companyName} account has been created. Your employee id is ${employee.employeeCode}`
      + `${employee.designation ? `, designation ${employee.designation}` : ''}`
      + `${employee.department ? `, department ${employee.department}` : ''}.`,
    '',
    `Sign-in email: ${employee.email}`,
    '',
    'Choose your own password using the link below. It works once and expires on '
      + `${expiresAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}:`,
    '',
    link,
    '',
    'After signing in, open My Profile, complete the remaining details and submit them for review. '
      + 'HR checks what you entered; once it is approved the profile is locked and you can request edit access if something needs changing later.',
    '',
    'We never send passwords by email. If you did not expect this message, reply to it and tell us.',
    '',
    actingName ? `— ${actingName}` : `— ${companyName} HR`,
  ].join('\n');
}

// The one call sites use. `employee` must carry email/name/employeeCode;
// `userId` is the login the link belongs to.
//
// Returns:
//   { sent: true,  status, link, expiresAt, providerRef }
//   { sent: false, notConfigured: true, status, reason, link, expiresAt }
//   { sent: false, status, reason, link?, expiresAt? }
async function sendCredentials({ employee, userId, actingUser, req, companyName = 'TeamLink' }) {
  if (!userId) {
    const status = 'No login — nothing to send';
    return { sent: false, status, reason: 'This employee has no login account yet.' };
  }
  if (!employee.email) {
    const status = 'Not sent — no email address on this employee record';
    await prisma.employee.update({ where: { id: employee.id }, data: { credentialsSentStatus: status } }).catch(() => {});
    return { sent: false, status, reason: status };
  }

  const { token, expiresAt } = await issueSetPasswordToken(userId);
  const link = `${appBaseUrl(req)}/set-password/${token}`;

  const cfg = await emailConfig().catch(() => ({ configured: false, reason: 'The email channel could not be read.' }));
  if (!cfg.configured) {
    const status = `Not sent — no email provider. ${cfg.reason || ''}`.trim();
    await prisma.employee.update({ where: { id: employee.id }, data: { credentialsSentStatus: status, credentialsSentAt: null } });
    // The link is handed back so HR can pass it on out of band. It is shown
    // once, on the screen of the person who just created the employee.
    return { sent: false, notConfigured: true, status, reason: status, link, expiresAt };
  }

  const sender = await senderIdentity(actingUser);
  const result = await sendMail({
    to: employee.email,
    subject: `${companyName} — your sign-in details`,
    text: body({ employee, actingName: sender.senderName, link, expiresAt, companyName }),
    senderEmail: sender.senderEmail,
    senderName: sender.senderName,
  });

  if (result.ok) {
    const status = `Sent to ${employee.email}${sender.senderEmail ? ` from ${sender.senderEmail}` : ''}`;
    await prisma.employee.update({
      where: { id: employee.id },
      data: { credentialsSentStatus: status, credentialsSentAt: new Date() },
    });
    return { sent: true, status, providerRef: result.providerRef, expiresAt, senderEmail: sender.senderEmail };
  }

  const status = `Failed: ${result.error}`.slice(0, 480);
  await prisma.employee.update({ where: { id: employee.id }, data: { credentialsSentStatus: status, credentialsSentAt: null } });
  return { sent: false, status, reason: status, link, expiresAt };
}

module.exports = {
  SET_PASSWORD_TTL_HOURS,
  unguessablePasswordHash,
  issueSetPasswordToken,
  inspectSetPasswordToken,
  redeemSetPasswordToken,
  sendCredentials,
  appBaseUrl,
};
