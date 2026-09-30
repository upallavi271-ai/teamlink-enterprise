// ---------------------------------------------------------------------------
// THE EMPLOYEE PROVES THEIR OWN EMAIL.
//
// On their own details form the employee types an email and presses "Send
// code"; a six-digit code goes TO THAT ADDRESS; typing it back marks the
// address Verified. Unlike a mobile, an email CAN be proved by email — the
// code reaching the inbox is exactly the proof.
//
// It uses the same EmailVerification table as HR's Add Employee check, so an
// address HR already verified while creating the record counts as verified
// here too. What "verified" means is always "THIS address was proved" — an
// employee who changes their email is Not verified again until they prove
// the new one.
//
// NOT VERIFIED → HR IS TOLD. Two moments:
//   * the employee submits their profile while its email is unverified;
//   * a code was sent but never entered within 24 hours (the hourly sweep).
// Each (employee, address) is reported once — the audit log is the record
// of having told HR, so a restart never repeats it.
//
// The code is hashed, expires in OTP_TTL_MINUTES and allows OTP_MAX_ATTEMPTS
// tries — the same rules as the Add Employee code. It is never returned to
// the browser and never logged.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const prisma = require('../db');
const mailer = require('./mailer');
const { notifyUsers } = require('./notify');
const { logAudit } = require('./audit');
const {
  EMAIL_RE, normalEmail, OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS, hashOtp,
} = require('./employeeAdmin');

const PURPOSE = 'employee-self-email';
const REMIND_AFTER_HOURS = 24;
const HR_NOTIFIED = 'Email not verified — HR notified';

// Proved at some point, by either route (Add Employee or the employee).
async function verifiedAt(email) {
  const e = normalEmail(email);
  if (!e) return null;
  const row = await prisma.emailVerification.findFirst({
    where: { email: e, verifiedAt: { not: null } },
    orderBy: { verifiedAt: 'desc' },
    select: { verifiedAt: true },
  });
  return row ? row.verifiedAt : null;
}

// Every proved address, for lists (one query, not one per row).
async function verifiedSet() {
  const rows = await prisma.emailVerification.findMany({
    where: { verifiedAt: { not: null } }, select: { email: true },
  });
  return new Set(rows.map((r) => normalEmail(r.email)));
}

async function liveCode(email) {
  return prisma.emailVerification.findFirst({
    where: { email: normalEmail(email), purpose: PURPOSE, consumedAt: null, verifiedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
}

// What the screen needs. No secrets.
async function emailState(employee, email = employee.email) {
  const address = normalEmail(email);
  const at = await verifiedAt(address);
  const live = at ? null : await liveCode(address);
  return {
    email: address || null,
    verified: !!at,
    at,
    pending: live ? {
      sentTo: address, expiresAt: live.expiresAt,
      attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - (live.attempts || 0)),
    } : null,
  };
}

async function start(employee, rawEmail, user) {
  const email = normalEmail(rawEmail || employee.email);
  if (!EMAIL_RE.test(email)) return { status: 400, error: 'That email does not look right.' };
  if (await verifiedAt(email)) return { status: 200, alreadyVerified: true, email };

  const cfg = await mailer.emailConfig();
  if (!cfg.configured) {
    return {
      status: 503,
      error: `No code could be sent — the email channel is not set up (${cfg.reason}). Ask HR to connect Administration → Integrations → Email (SMTP).`,
    };
  }

  // A fresh request retires every earlier code for this address.
  await prisma.emailVerification.updateMany({
    where: { email, purpose: PURPOSE, consumedAt: null, verifiedAt: null },
    data: { consumedAt: new Date() },
  });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60000);
  const row = await prisma.emailVerification.create({
    data: { email, purpose: PURPOSE, codeHash: hashOtp(email, code), expiresAt, requestedById: user.id },
  });
  const sent = await mailer.sendMail({
    to: email,
    subject: 'TeamLink — verify your email',
    text: [
      `Hello ${employee.name},`,
      '',
      `Your TeamLink email verification code is ${code}.`,
      `Enter it on your employee details form. It expires in ${OTP_TTL_MINUTES} minutes.`,
      '',
      'If you did not ask for this, ignore this message.',
    ].join('\n'),
    useEmployeeFrom: false,
  });
  if (!sent.ok) {
    await prisma.emailVerification.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    return { status: 502, error: `The code could not be sent — ${sent.error}` };
  }
  await logAudit({ userId: user.id, action: 'Email verification code sent', entity: 'Employee', entityId: employee.id, toValue: email });
  return { status: 200, sent: true, email, expiresAt, ttlMinutes: OTP_TTL_MINUTES };
}

async function confirm(employee, rawEmail, rawCode, user) {
  const email = normalEmail(rawEmail || employee.email);
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!code) return { status: 400, error: 'Enter the code from the email.' };
  const row = await liveCode(email);
  if (!row) return { status: 400, error: 'No live code for that address — send a new one.' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { status: 429, error: 'Too many attempts on that code — send a new one.' };
  const attempts = row.attempts + 1;
  if (row.codeHash !== hashOtp(email, code)) {
    await prisma.emailVerification.update({ where: { id: row.id }, data: { attempts } });
    const left = OTP_MAX_ATTEMPTS - attempts;
    return { status: 400, error: left > 0 ? `That code is not right — ${left} attempt(s) left.` : 'That code is not right and the attempts are used up — send a new one.' };
  }
  await prisma.emailVerification.update({ where: { id: row.id }, data: { attempts, verifiedAt: new Date() } });
  await logAudit({ userId: user.id, action: 'Email verified', entity: 'Employee', entityId: employee.id, toValue: email });
  return { status: 200, verified: true, email };
}

// HR: every active login whose HRMS work is HR. If a company has no HR login
// yet, the administrators hear instead — somebody must.
async function hrAudience() {
  const hr = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ role: 'HR' }, { hrmsRole: 'HR' }] }, select: { id: true },
  });
  if (hr.length) return hr.map((u) => u.id);
  const admins = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true },
  });
  return admins.map((u) => u.id);
}

// Tell HR once per (employee, address).
async function notifyHrUnverified(employee, email, why) {
  const address = normalEmail(email);
  if (!address || await verifiedAt(address)) return false;
  const told = await prisma.auditLog.findFirst({
    where: { action: HR_NOTIFIED, entityId: employee.id, toValue: address }, select: { id: true },
  });
  if (told) return false;
  await notifyUsers(await hrAudience(), {
    title: `Email not verified — ${employee.name}${employee.employeeCode ? ` (${employee.employeeCode})` : ''}`,
    message: `${address} has not been verified: ${why}. Ask them to open My Employee Profile and verify it with the emailed code.`,
  });
  await logAudit({ action: HR_NOTIFIED, entity: 'Employee', entityId: employee.id, toValue: address, reason: why });
  return true;
}

// Hourly: a code sent more than a day ago and never entered.
async function sweep() {
  const cutoff = new Date(Date.now() - REMIND_AFTER_HOURS * 3600000);
  const stale = await prisma.emailVerification.findMany({
    where: { purpose: PURPOSE, verifiedAt: null, createdAt: { lt: cutoff } },
    select: { email: true, requestedById: true },
    orderBy: { createdAt: 'desc' },
  });
  let told = 0;
  const seen = new Set();
  for (const row of stale) {
    const k = `${row.requestedById}|${row.email}`;
    if (seen.has(k) || !row.requestedById) continue;
    seen.add(k);
    // eslint-disable-next-line no-await-in-loop
    const employee = await prisma.employee.findUnique({ where: { userId: row.requestedById } });
    // eslint-disable-next-line no-await-in-loop
    if (employee && await notifyHrUnverified(employee, row.email, `a code was sent over ${REMIND_AFTER_HOURS} hours ago and never entered`)) told += 1;
  }
  return told;
}

let timer = null;
function startSweep() {
  if (timer) return;
  const run = () => sweep().catch((e) => console.error('[email-verify sweep]', e.message));
  setTimeout(run, 60000);
  timer = setInterval(run, 3600000);
  if (timer.unref) timer.unref();
}

module.exports = {
  PURPOSE, emailState, verifiedAt, verifiedSet, start, confirm, notifyHrUnverified, sweep, startSweep,
};
