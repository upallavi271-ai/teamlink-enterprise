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
// TWO PATHS, AND WHICH ONE RUNS DEPENDS ON HR.
//
//   HR left Password blank  ->  the account gets a random unguessable hash
//                               and a single-use set-password link is the
//                               ONLY way in. HR never learns the password.
//                               This is the better path and the default.
//
//   HR typed a password     ->  a "Welcome to HRMS" mail carries the sign-in
//                               address and that password, because HR asked
//                               for exactly that. No set-password link is
//                               minted, so there is still only one way in.
//
// The password in that mail is a real trade-off: it persists in the mailbox
// and in anything it is forwarded to. The mail asks them to change it. It is
// still never logged, never stored in clear and never echoed by an endpoint.
//
// SENDER IDENTITY — the company mailbox, with no display name
// A CANDIDATE message goes out as the named recruiter handling them, and
// utils/candidateComms.js senderIdentity() exists for that. An ACCOUNT mail
// is different: the new joiner has never met the HR user who pressed the
// button, and the mail is from the company. Sending it as that person put
// their name in the From header of every welcome mail, which is what it was
// doing. It now leaves from the configured From address with NO display name
// at all — plain hr@tmlink.in — via sendMail's useEmployeeFrom:false and
// fromName:''.
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
  // The same strength rule as every other password path (utils/passwordPolicy.js).
  // eslint-disable-next-line global-require
  const weak = user && require('./passwordPolicy').strengthError(password, { email: user.email, name: user.name });
  if (weak) return { ok: false, code: 'weak', reason: weak };
  if (!user) return { ok: false, code: 'invalid', reason: 'This link is not valid — it may already have been used.' };
  if (user.setPasswordUsedAt) return { ok: false, code: 'used', reason: 'This link has already been used.' };
  if (!user.setPasswordExpiresAt || user.setPasswordExpiresAt < new Date()) {
    return { ok: false, code: 'expired', reason: 'This link has expired. Ask HR to send a new one.' };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(String(password), 10),
      // Password status (hrms-24 §12): set by its owner, nothing outstanding.
      // eslint-disable-next-line global-require
      ...require('./passwordPolicy').passwordEventData('link'),
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

// WELCOME TO HRMS — sent when HR set a password on the Add Employee form.
//
// This mail carries the password itself, which is what HR asked for: they
// type the password, and the employee is told it. Worth being clear-eyed
// about the trade — a password in a mailbox stays in that mailbox, and in
// any mailbox it is forwarded to, so the message asks them to change it and
// the password is never written to the audit log or echoed to the screen.
//
// When HR leaves the password blank there IS no password to send, and the
// set-password link below is used instead. That is not a fallback; it is the
// better of the two paths, and it stays the default.
function welcomeBody({ employee, password, signInUrl, companyName }) {
  return [
    `Hi ${employee.name},`,
    '',
    `Welcome to ${companyName}. Your HRMS account is ready.`,
    '',
    `Sign in here : ${signInUrl}`,
    `Email        : ${employee.email}`,
    `Password     : ${password}`,
    '',
    `Your employee id is ${employee.employeeCode}`
      + `${employee.designation ? `, designation ${employee.designation}` : ''}`
      + `${employee.department ? `, department ${employee.department}` : ''}.`,
    '',
    'Please change this password after you sign in — open My Profile to do it.',
    '',
    'While you are there, complete the remaining details on your profile and submit '
      + 'them for review. HR checks what you entered; once it is approved the profile '
      + 'is locked, and you can request edit access later if something needs changing.',
    '',
    'If you did not expect this message, reply to it and tell us.',
    '',
    `— ${companyName} HR`,
  ].join('\n');
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
// `password` is the one HR typed on Add Employee, when they typed one. It is
// passed straight through to the mail body and nowhere else — not logged, not
// stored, not returned to the caller.
async function sendCredentials({ employee, userId, actingUser, req, companyName = 'TeamLink', password = '' }) {
  if (!userId) {
    const status = 'No login — nothing to send';
    return { sent: false, status, reason: 'This employee has no login account yet.' };
  }
  if (!employee.email) {
    const status = 'Not sent — no email address on this employee record';
    await prisma.employee.update({ where: { id: employee.id }, data: { credentialsSentStatus: status } }).catch(() => {});
    return { sent: false, status, reason: status };
  }

  // A set-password link is a live credential. When HR has already set a
  // password there is nothing for it to do, so none is minted — issuing one
  // anyway would leave a second way into the account that nobody asked for.
  const given = String(password || '').trim();
  let link = null;
  let expiresAt = null;
  if (!given) {
    const issued = await issueSetPasswordToken(userId);
    expiresAt = issued.expiresAt;
    link = `${appBaseUrl(req)}/set-password/${issued.token}`;
  }

  // RESERVED TEST ADDRESSES (RFC 2606 / 6761 — example.test, *.invalid …) are
  // never handed to the mail server: they cannot be delivered, and fixtures use
  // them. The link is handed back exactly as when no provider is configured.
  // eslint-disable-next-line global-require
  if (require('./audience').reservedTestAddress && require('./audience').reservedTestAddress(employee.email)) {
    const status = `Not sent — ${employee.email} is a reserved test address, so it was not handed to the mail server.`;
    await prisma.employee.update({ where: { id: employee.id }, data: { credentialsSentStatus: status, credentialsSentAt: null } }).catch(() => {});
    return { sent: false, status, reason: status, link, expiresAt };
  }

  const cfg = await emailConfig().catch(() => ({ configured: false, reason: 'The email channel could not be read.' }));
  if (!cfg.configured) {
    // WHAT HR SHOULD DO ABOUT IT depends on which path we are on, so the
    // message says. With a password there is no link to hand over — but HR
    // typed that password and can pass it on themselves, which they will not
    // think to do if the screen only says "not sent".
    const status = given
      ? `Not sent — no email provider. ${cfg.reason || ''} Give ${employee.name} the email address and password yourself.`.trim()
      : `Not sent — no email provider. ${cfg.reason || ''}`.trim();
    await prisma.employee.update({ where: { id: employee.id }, data: { credentialsSentStatus: status, credentialsSentAt: null } });
    // Where there IS a link it is handed back so HR can pass it on out of
    // band. It is shown once, to the person who just created the employee.
    return { sent: false, notConfigured: true, status, reason: status, link, expiresAt };
  }

  // AN ACCOUNT MAIL COMES FROM THE COMPANY, NOT FROM A COLLEAGUE.
  //
  // It used to go out as the acting HR user — header From "Nikhil Joshi"
  // <nikhil@…> — because that is right for a CANDIDATE message, where a
  // named recruiter is the point. It is wrong here: the new joiner has never
  // met Nikhil, and the mail is from the company. So this one is sent from
  // the configured mailbox with no display name at all — plain hr@tmlink.in.
  const result = await sendMail({
    to: employee.email,
    subject: given ? `Welcome to ${companyName} HRMS` : `${companyName} — your sign-in details`,
    text: given
      ? welcomeBody({ employee, password: given, signInUrl: appBaseUrl(req), companyName })
      : body({ employee, actingName: null, link, expiresAt, companyName }),
    useEmployeeFrom: false,
    fromName: '',
  });

  if (result.ok) {
    const status = `Sent to ${employee.email}${given ? ' (welcome mail with password)' : ' (set-password link)'}`;
    await prisma.employee.update({
      where: { id: employee.id },
      data: { credentialsSentStatus: status, credentialsSentAt: new Date() },
    });
    return { sent: true, status, providerRef: result.providerRef, expiresAt };
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
