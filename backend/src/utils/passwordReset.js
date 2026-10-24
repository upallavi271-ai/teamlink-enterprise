// ---------------------------------------------------------------------------
// FORGOT PASSWORD + "SOMEONE CHANGED THEIR PASSWORD" ALERTS (2026-10-12).
//
// WHAT THIS FILE OWNS
//   1. The reset link: a 32-byte random token, mailed to the e-mail on file,
//      stored ONLY as a SHA-256 hash, valid for 30 minutes, usable once, and
//      replaced by any newer link or by any successful password change.
//   2. The alert to the people with overall access (Super Admin / Admin, a
//      small setting on Company Setup): "<Name> changed their password on
//      <when> using <how>" - in the bell AND by e-mail.
//   3. A tiny session gate: a sign-in token issued BEFORE the last password
//      change stops working (the app's tokens are JWT-only, so this is the only
//      way a reset can log out a thief who already has a session).
//
// WHAT IT NEVER DOES
//   A password - old or new - is never e-mailed, shown, logged, audited or
//   stored in clear, and NOT EVEN Super Admin is ever told what it is. The
//   alert says THAT it changed, WHO and WHEN and HOW. Accountability needs
//   exactly that; nobody but the owner should know a password. An Admin who
//   needs to get someone back in uses "Get reset link" (the person still
//   chooses the password themselves).
//
// STORAGE (no migration): AppSetting rows
//   pwreset:t:<sha256(token)>  { userId, expiresAt, createdAt, via, byName, usedAt, supersededAt }
//   pwreset:u:<userId>         { hash }          (the one live link of that login)
//   security.passwordAlert     { roles: [...], email: true }   (who is told)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const { logAudit } = require('./audit');
const { ipOf } = require('./clientIp');
const { strengthError, passwordEventData } = require('./passwordPolicy');
const { sendMail, emailConfig } = require('./mailer');
const sandbox = require('./sandbox');

const RESET_TTL_MIN = Number(process.env.PASSWORD_RESET_TTL_MIN || 30);
const ADMIN_LINK_TTL_MIN = Number(process.env.PASSWORD_ADMIN_LINK_TTL_MIN || 60);
const KEY_T = 'pwreset:t:';
const KEY_U = 'pwreset:u:';
const SETTING_KEY = 'security.passwordAlert';
const DEFAULT_SETTING = Object.freeze({ roles: ['SUPER_ADMIN', 'ADMIN'], email: true });
const ALERT_ROLES = ['SUPER_ADMIN', 'ADMIN'];

const NEUTRAL_MESSAGE = 'If this email is registered, a reset link is on its way. Check your Inbox and Spam folder.';
const EMAIL_OFF_MESSAGE = 'We could not send the email right now. Please ask your Admin to help you.';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex'); // 32 bytes = 64 hex characters
const tokenShape = (t) => /^[a-f0-9]{64}$/.test(String(t || ''));
const normEmail = (e) => String(e || '').trim().toLowerCase();
const looksLikeEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 160;
const isTestIdentity = (u) => /zztest|example\.test/i.test(`${u && u.name} ${u && u.email}`);

// Where the link opens. NEVER taken from the request (a forged Origin / Host
// header would otherwise mail a victim a link to the attacker's site).
function baseUrl() {
  const v = process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'http://localhost:5183';
  return String(v).replace(/\/+$/, '');
}
// /new-password, NOT /reset-password: /reset-password belongs to the Job Portal
// (utils/jobPortalEmbed.js forwards it to the portal's own page).
const linkFor = (token) => `${baseUrl()}/new-password?token=${token}`;

// ---------------------------------------------------------------------------
// RATE LIMITS (in memory, sliding window). Counted for ANY e-mail typed, real or
// not, so the answer never depends on whether the account exists.
// ---------------------------------------------------------------------------
const hits = new Map(); // key -> [timestamps]
function hit(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return { limited: true, retryAfter: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) { // keep memory flat
    hits.forEach((v, k) => { if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k); });
  }
  return { limited: false };
}
const LIMITS = {
  emailPerHour: Number(process.env.PASSWORD_RESET_EMAIL_MAX || 5),
  ipPerHour: Number(process.env.PASSWORD_RESET_IP_MAX || 20),
  tokenTriesPerHour: Number(process.env.PASSWORD_RESET_TRY_MAX || 40),
};
const HOUR = 3600 * 1000;
function limitMessage(retryAfter) {
  const mins = Math.max(1, Math.ceil(retryAfter / 60));
  return `Too many tries. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again.`;
}

// ---------------------------------------------------------------------------
// TOKEN STORE
// ---------------------------------------------------------------------------
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function markDead(hash, field) {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY_T + hash } }).catch(() => null);
  if (!row) return;
  const rec = parse(row.value);
  if (!rec || rec.usedAt || rec.supersededAt) return;
  rec[field] = new Date().toISOString();
  await prisma.appSetting.updateMany({ where: { key: row.key, value: row.value }, data: { value: JSON.stringify(rec) } });
}

// Any live link of this login stops working (a newer link, or a password change).
async function invalidateFor(userId, field = 'supersededAt') {
  const cur = await prisma.appSetting.findUnique({ where: { key: KEY_U + userId } }).catch(() => null);
  const hash = cur && (parse(cur.value) || {}).hash;
  if (hash) await markDead(hash, field);
}

async function issueToken(user, { via = 'email', byName = null, byUserId = null, ttlMin = RESET_TTL_MIN } = {}) {
  await invalidateFor(user.id, 'supersededAt');
  const token = newToken();
  const hash = sha(token);
  const now = Date.now();
  const rec = {
    userId: user.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMin * 60000).toISOString(),
    via, byName, byUserId, usedAt: null, supersededAt: null,
  };
  await prisma.appSetting.create({ data: { key: KEY_T + hash, value: JSON.stringify(rec) } });
  await prisma.appSetting.upsert({
    where: { key: KEY_U + user.id }, create: { key: KEY_U + user.id, value: JSON.stringify({ hash }) }, update: { value: JSON.stringify({ hash }) },
  });
  // Old, finished links are tidied away after a week.
  prisma.appSetting.deleteMany({ where: { key: { startsWith: KEY_T }, updatedAt: { lt: new Date(now - 7 * 86400000) } } }).catch(() => {});
  return { token, expiresAt: new Date(rec.expiresAt), ttlMin };
}

// -> { state: 'ok'|'invalid'|'used'|'superseded'|'expired', rec, row, user }
async function lookup(token) {
  if (!tokenShape(token)) return { state: 'invalid' };
  const row = await prisma.appSetting.findUnique({ where: { key: KEY_T + sha(token) } }).catch(() => null);
  const rec = row && parse(row.value);
  if (!rec) return { state: 'invalid' };
  const user = await prisma.user.findUnique({ where: { id: rec.userId } }).catch(() => null);
  if (!user) return { state: 'invalid' };
  let state = 'ok';
  if (rec.usedAt) state = 'used';
  else if (rec.supersededAt) state = 'superseded';
  else if (new Date(rec.expiresAt) <= new Date()) state = 'expired';
  return { state, rec, row, user };
}

const STATE_TEXT = {
  invalid: 'This link is not valid. Ask for a new one.',
  used: 'This link was already used. Ask for a new one if you still need it.',
  superseded: 'A newer link was sent to you after this one. Please use the newest email.',
  expired: 'This link has expired. Links work for 30 minutes. Ask for a new one.',
};

// ---------------------------------------------------------------------------
// SESSION GATE - "a token older than the last password change is dead".
// ---------------------------------------------------------------------------
const gateCache = new Map(); // userId -> { at, changedAt }
async function tokenIsStale(claims) {
  if (!claims || !claims.id || !claims.iat) return false;
  let c = gateCache.get(claims.id);
  if (!c || Date.now() - c.at > 15000) {
    const u = await prisma.user.findUnique({ where: { id: claims.id }, select: { passwordChangedAt: true } }).catch(() => null);
    c = { at: Date.now(), changedAt: u && u.passwordChangedAt ? new Date(u.passwordChangedAt).getTime() : 0 };
    gateCache.set(claims.id, c);
    if (gateCache.size > 5000) gateCache.clear();
  }
  // JWT iat is whole seconds: compare at the same precision.
  return c.changedAt > 0 && claims.iat * 1000 < Math.floor(c.changedAt / 1000) * 1000;
}
const dropGate = (userId) => gateCache.delete(userId);

// ---------------------------------------------------------------------------
// E-MAIL
// ---------------------------------------------------------------------------
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BLUE = '#1d4ed8';

let logoCache; // { buffer } | null
async function logoAttachment() {
  if (logoCache === undefined) {
    logoCache = null;
    try {
      const file = path.resolve(__dirname, '../../../frontend/src/assets/teamlink-full-logo.png');
      if (fs.existsSync(file)) {
        // eslint-disable-next-line global-require
        const sharp = require('sharp');
        logoCache = { buffer: await sharp(file).resize({ width: 320 }).png({ compressionLevel: 9 }).toBuffer() };
      }
    } catch { logoCache = null; }
  }
  return logoCache ? [{ filename: 'teamlink.png', content: logoCache.buffer, cid: 'teamlink-logo', contentType: 'image/png' }] : [];
}

function shell({ title, inner, hasLogo }) {
  const header = hasLogo
    ? '<img src="cid:teamlink-logo" alt="TeamLink" width="160" style="display:block;border:0;height:auto" />'
    : `<span style="font-size:22px;font-weight:700;color:${BLUE}">TeamLink</span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:14px 8px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e5e7eb">
<tr><td style="padding:18px 22px 10px;border-bottom:4px solid ${BLUE};border-radius:10px 10px 0 0">${header}</td></tr>
<tr><td style="padding:18px 22px 22px">${inner}</td></tr>
<tr><td style="padding:12px 22px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280">Sent by TeamLink. We never send passwords by email.</td></tr>
</table></td></tr></table></body></html>`;
}
const btn = (href, label) => `<p style="margin:18px 0"><a href="${esc(href)}" style="background:${BLUE};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block">${esc(label)}</a></p>`;
const para = (t, extra = '') => `<p style="margin:10px 0;font-size:14px;line-height:1.55;color:#1f2937;${extra}">${t}</p>`;
const whenText = (d) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// The reset e-mail. Contains: a link, the expiry, the "ignore it" line. Nothing
// about the person (no name, no e-mail, no role, no IP) and never a password.
function buildResetEmail({ link, expiresAt, hasLogo = false, ttlMin = RESET_TTL_MIN }) {
  const subject = 'Reset your TeamLink password';
  const until = whenText(expiresAt);
  const text = [
    'Hello,',
    '',
    'Someone asked to reset the password for your TeamLink account. If it was you, open this link and choose a new password:',
    '',
    link,
    '',
    `The link works once and stops working in ${ttlMin} minutes (at ${until}).`,
    '',
    "Didn't ask for this? Ignore this email. Your password is safe and nothing changes unless someone uses the link.",
    '',
    'We never send passwords by email.',
    '',
    '- TeamLink',
  ].join('\n');
  const inner = [
    para('Hello,'),
    para('Someone asked to reset the password for your TeamLink account. If it was you, press the button and choose a new password.'),
    btn(link, 'Reset my password'),
    para(`Button not working? Copy this link into your browser:<br><a href="${esc(link)}" style="color:${BLUE};word-break:break-all;font-size:12px">${esc(link)}</a>`),
    para(`<b>The link works once and stops working in ${ttlMin} minutes</b> (at ${esc(until)}).`),
    para("<b>Didn't ask for this?</b> Ignore this email. Your password is safe and nothing changes unless someone uses the link.", 'background:#f0f9ff;border-radius:8px;padding:10px 12px'),
  ].join('');
  return { subject, text, html: shell({ title: subject, inner, hasLogo }) };
}

// The reset e-mail for a mailbox with SEVERAL logins: each login is named by its role and department (never a number or an ID), and has its own link. No names, no phone numbers, no other e-mail addresses, no password. Resetting one login never changes another.
function buildMultiResetEmail({ items, hasLogo = false }) {
  const several = items.length > 1;
  const subject = several ? 'Reset a TeamLink password - choose your login' : 'Reset your TeamLink password';
  const ttlMin = items[0].issued.ttlMin;
  const until = whenText(items[0].issued.expiresAt);
  const textLines = [
    'Hello,',
    '',
    several
      ? 'Someone asked to reset a TeamLink password for this email address. More than one TeamLink login uses this email, and each login has its OWN password. Open the link of the login you want. Resetting one login does not change the others.'
      : 'Someone asked to reset the password for your TeamLink login. If it was you, open the link and choose a new password.',
    '',
  ];
  items.forEach((it) => {
    textLines.push(`Your ${it.label} login`, `Reset link: ${it.link}`, '');
  });
  textLines.push(
    `Each link works once and stops working in ${ttlMin} minutes (at ${until}).`,
    '',
    "Didn't ask for this? Ignore this email. Your passwords are safe and nothing changes unless someone uses a link.",
    '',
    'We never send passwords by email.',
    '',
    '- TeamLink',
  );
  const blocks = items.map((it) => `<table width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;border:1px solid #e5e7eb;border-radius:8px"><tr><td style="padding:10px 12px">
<div style="font-size:12px;color:#6b7280">Login for</div><div style="font-size:16px;font-weight:700;color:#111827">${esc(it.label)}</div>
${btn(it.link, several ? `Reset the ${it.label} password` : 'Reset my password')}
<div style="font-size:11px;color:#6b7280;word-break:break-all">${esc(it.link)}</div></td></tr></table>`).join('');
  const inner = [
    para('Hello,'),
    para(several
      ? 'Someone asked to reset a TeamLink password for this email address. <b>More than one TeamLink login uses this email, and each login has its own password.</b> Open the link of the login you want. Resetting one login does not change the others.'
      : 'Someone asked to reset the password for your TeamLink login. If it was you, press the button and choose a new password.'),
    blocks,
    para(`<b>Each link works once and stops working in ${ttlMin} minutes</b> (at ${esc(until)}).`),
    para("<b>Didn't ask for this?</b> Ignore this email. Your passwords are safe and nothing changes unless someone uses a link.", 'background:#f0f9ff;border-radius:8px;padding:10px 12px'),
  ].join('');
  return { subject, text: textLines.join('\n'), html: shell({ title: subject, inner, hasLogo }) };
}

const ROLE_TEXT = {
  SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Assistant Manager', HR: 'HR', TL: 'TL', STL: 'STL',
  RECRUITER: 'Recruiter', BDE: 'BDE', ACCOUNTANT: 'Accountant', EMPLOYEE: 'Employee', CLIENT: 'Client', CANDIDATE: 'Candidate',
};
const roleText = (r) => ROLE_TEXT[r] || String(r || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const METHODS = {
  reset_link: 'the reset link',
  admin_link: 'a reset link given by an Admin',
  my_profile: 'My Profile',
  admin_reset: 'an Admin reset',
  hr_reset: 'an HR reset',
  signin_link: 'the sign-in link HR sent',
};

function alertText({ target, method, at, byName }) {
  const who = `${target.name} (${[roleText(target.role), target.department].filter(Boolean).join(' / ')})`;
  const how = METHODS[method] || method;
  const by = byName && ['admin_reset', 'hr_reset', 'admin_link'].includes(method) ? ` Done by ${byName}.` : '';
  return {
    who,
    line: `${who} changed their password on ${whenText(at)} using ${how}.${by} If this was not them, open Users and block the login.`,
  };
}

function buildAlertEmail({ target, method, at, byName, blockLink, hasLogo = false }) {
  const { line } = alertText({ target, method, at, byName });
  const subject = `TeamLink: ${target.name} changed their password`;
  const text = [
    'Hello,',
    '',
    line,
    '',
    `Block this login: ${blockLink}`,
    '',
    'You are told THAT the password changed, and who, when and how. TeamLink never shows or emails anyone\'s password, not even to Super Admin.',
    '',
    '- TeamLink',
  ].join('\n');
  const inner = [
    para('Hello,'),
    para(`<b>${esc(target.name)}</b> (${esc([roleText(target.role), target.department].filter(Boolean).join(' / '))}) changed their password on <b>${esc(whenText(at))}</b> using <b>${esc(METHODS[method] || method)}</b>.${byName && ['admin_reset', 'hr_reset', 'admin_link'].includes(method) ? ` Done by ${esc(byName)}.` : ''}`),
    para('If this was not them, open Users and block the login.', 'font-weight:600'),
    btn(blockLink, 'Block this login'),
    para('You are told that the password changed, and who, when and how. TeamLink never shows or emails anyone\'s password, not even to Super Admin.', 'font-size:12px;color:#6b7280'),
  ].join('');
  return { subject, text, html: shell({ title: subject, inner, hasLogo }) };
}

// In the sandbox every mail we build is written to a folder, so a test can
// assert on it (nothing is sent). Never active outside the sandbox.
function captureDir() { return path.join(os.homedir(), '.teamlink-sandbox', 'mail-outbox'); }
function captureMail(mail) {
  try {
    fs.mkdirSync(captureDir(), { recursive: true });
    fs.writeFileSync(path.join(captureDir(), `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`), JSON.stringify({ ...mail, capturedAt: new Date().toISOString() }));
  } catch { /* capture is a test aid only */ }
}

// -> { ok, reason }. Never throws. The reason is for the server log / audit
// only; callers do not show it to an anonymous visitor.
async function deliver({ to, kind, build }) {
  try {
    const attachments = await logoAttachment();
    const mail = build(attachments.length > 0);
    if (sandbox.isSandbox()) captureMail({ to, kind, subject: mail.subject, text: mail.text, html: mail.html });
    const cfg = await emailConfig();
    if (!cfg.configured) return { ok: false, reason: `Email is not connected. ${cfg.reason || ''}`.trim() };
    const res = await sendMail({
      to, subject: mail.subject, text: mail.text, html: mail.html, attachments, useEmployeeFrom: false, fromName: 'TeamLink',
    });
    return res.ok ? { ok: true } : { ok: false, reason: String(res.error || 'The mail server refused it.').slice(0, 300) };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 300) };
  }
}

async function emailIsOn() {
  try { return !!(await emailConfig()).configured; } catch { return false; }
}

// ---------------------------------------------------------------------------
// THE FORGOT-PASSWORD REQUEST
// ---------------------------------------------------------------------------
const uaOf = (req) => String((req && req.headers && req.headers['user-agent']) || '').slice(0, 120);
const whereText = (req) => `IP ${ipOf(req)} - ${uaOf(req) || 'unknown browser'}`;

// Step 1, synchronous and identical for every e-mail: validation, the two rate
// limits, and "is e-mail connected at all". Returns { status, body } to send,
// or null to carry on with the (neutral) accepted answer.
async function screenRequest(req, email) {
  if (!email || !looksLikeEmail(email)) return { status: 400, body: { error: 'Enter your email address, like name@company.com.' } };
  const ipHit = hit(`ip|${ipOf(req)}`, LIMITS.ipPerHour, HOUR);
  const mailHit = hit(`mail|${email}`, LIMITS.emailPerHour, HOUR);
  if (ipHit.limited || mailHit.limited) {
    const retry = Math.max(ipHit.retryAfter || 0, mailHit.retryAfter || 0);
    await logAudit({ action: 'Password reset request refused - too many tries', entity: 'User', toValue: 'Rate limited', reason: whereText(req) });
    return { status: 429, headers: { 'Retry-After': String(retry) }, body: { error: limitMessage(retry), retryAfter: retry } };
  }
  if (!(await emailIsOn())) {
    // The SAME answer for every address, so it says nothing about any account.
    await logAudit({ action: 'Password reset requested - email not connected', entity: 'User', toValue: 'Not emailed', reason: whereText(req) });
    return { status: 503, body: { error: EMAIL_OFF_MESSAGE, code: 'EMAIL_OFF' } };
  }
  return null;
}

// Step 2, runs AFTER the answer has been sent (so the response time is the same
// for a real and an unknown address). Never throws.
//
// SEPARATE LOGINS ON ONE EMAIL (2026-10-21). `identifier` is the email:
//   * an email with ONE account -> exactly the mail this always sent (no name, no role);
//   * an email with SEVERAL accounts -> ONE mail to that mailbox listing each login by role + department with ITS OWN single-use link. The
//     mailbox owner owns every account on it, so listing them there is safe; each link changes only its own account's password.
// The answer already sent to the browser is the same in every case.
async function processRequest(req, identifier, userOverride = null) {
  const where = whereText(req);
  try {
    const LA = require('./loginAccounts'); // eslint-disable-line global-require
    let accounts;
    let mention = false;
    if (userOverride) {
      accounts = [userOverride];
      mention = (await LA.accountsByEmail(userOverride.email)).length > 1;
    } else {
      const got = await LA.resolveIdentifier(identifier);
      accounts = got.accounts;
      mention = accounts.length > 1;
    }
    if (!accounts.length) {
      await logAudit({ action: 'Password reset requested - no such account', entity: 'User', toValue: 'Nothing sent', reason: `${where} - typed: ${String(identifier).slice(0, 60)}` });
      return;
    }
    const live = accounts.filter((u) => (u.status || 'Active') === 'Active' && looksLikeEmail(normEmail(u.email)));
    for (const u of accounts.filter((x) => !live.includes(x))) {
      // eslint-disable-next-line no-await-in-loop
      await logAudit({ userId: u.id, action: 'Password reset requested - login is not active', entity: 'User', entityId: u.id, toValue: 'Nothing sent', reason: where });
    }
    if (!live.length) return;
    // One mail per mailbox (the address typed).
    const byAddress = new Map();
    live.forEach((u) => { const a = normEmail(u.email); byAddress.set(a, [...(byAddress.get(a) || []), u]); });
    for (const list of byAddress.values()) {
      const items = [];
      const sums = mention ? await LA.summariesFor(list) : [];
      for (let i = 0; i < list.length; i += 1) {
        const user = list[i];
        // eslint-disable-next-line no-await-in-loop
        const issued = await issueToken(user, { via: 'email' });
        items.push({ user, issued, link: linkFor(issued.token), label: mention ? sums[i].mailLabel : '' });
      }
      const first = items[0];
      // eslint-disable-next-line no-await-in-loop
      const res = await deliver({
        to: list[0].email,
        kind: 'password-reset',
        build: (hasLogo) => (mention
          ? buildMultiResetEmail({ items, hasLogo })
          : buildResetEmail({ link: first.link, expiresAt: first.issued.expiresAt, hasLogo, ttlMin: first.issued.ttlMin })),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error('[password-reset] could not e-mail the reset link for %d login(s) on one address: %s', items.length, res.reason);
      }
      for (const it of items) {
        // eslint-disable-next-line no-await-in-loop
        await logAudit({
          userId: it.user.id, action: 'Password reset requested', entity: 'User', entityId: it.user.id,
          toValue: res.ok ? 'Link emailed' : `Not emailed - ${res.reason}`, reason: where,
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[password-reset] request failed: %s', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// SEEING / USING THE LINK
// ---------------------------------------------------------------------------
async function inspect(req, token) {
  const t = hit(`try|${ipOf(req)}`, LIMITS.tokenTriesPerHour, HOUR);
  if (t.limited) return { status: 429, code: 'limited', error: limitMessage(t.retryAfter) };
  const got = await lookup(token);
  if (got.state !== 'ok') return { status: 410, code: got.state, error: STATE_TEXT[got.state] };
  if ((got.user.status || 'Active') !== 'Active') return { status: 410, code: 'invalid', error: STATE_TEXT.invalid };
  const minutesLeft = Math.max(1, Math.ceil((new Date(got.rec.expiresAt) - Date.now()) / 60000));
  return { status: 200, expiresAt: got.rec.expiresAt, minutesLeft };
}

async function redeem(req, token, password, confirm) {
  const t = hit(`try|${ipOf(req)}`, LIMITS.tokenTriesPerHour, HOUR);
  if (t.limited) return { status: 429, code: 'limited', error: limitMessage(t.retryAfter) };
  const got = await lookup(token);
  if (got.state !== 'ok' || (got.user.status || 'Active') !== 'Active') {
    const code = got.state === 'ok' ? 'invalid' : got.state;
    if (got.user) {
      await logAudit({
        userId: got.user.id, action: 'Password reset link refused', entity: 'User', entityId: got.user.id, toValue: code, reason: whereText(req),
      });
    }
    return { status: 410, code, error: STATE_TEXT[code] };
  }
  const user = got.user;
  if (confirm !== undefined && confirm !== password) return { status: 400, code: 'mismatch', error: 'The two passwords do not match.' };
  const weak = strengthError(password, { email: user.email, name: user.name });
  if (weak) return { status: 400, code: 'weak', error: weak };
  if (await bcrypt.compare(String(password), user.passwordHash)) {
    return { status: 400, code: 'same', error: 'Choose a password different from your old one.' };
  }
  // SINGLE USE: claim the link first. Two people (or two taps) racing for the
  // same link cannot both win - the update only matches the unchanged row.
  const used = { ...got.rec, usedAt: new Date().toISOString() };
  const claim = await prisma.appSetting.updateMany({ where: { key: got.row.key, value: got.row.value }, data: { value: JSON.stringify(used) } });
  if (claim.count !== 1) return { status: 410, code: 'used', error: STATE_TEXT.used };
  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(String(password), 10),
        // failed-login counter + lock cleared by passwordEventData
        ...passwordEventData('self'),
        setPasswordTokenHash: null, setPasswordExpiresAt: null,
      },
    });
  } catch (err) {
    await prisma.appSetting.updateMany({ where: { key: got.row.key }, data: { value: got.row.value } }).catch(() => {});
    throw err;
  }
  const method = got.rec.via === 'admin' ? 'admin_link' : 'reset_link';
  await logAudit({
    userId: user.id, action: 'Password changed using a reset link', entity: 'User', entityId: user.id,
    toValue: got.rec.via === 'admin' ? `Changed (link from ${got.rec.byName || 'an Admin'})` : 'Changed', reason: whereText(req),
  });
  await afterPasswordChange({ user, method, byName: got.rec.byName, byUserId: got.rec.byUserId || null });
  return { status: 200 };
}

// "Send me a new link" from an expired / used link: mail goes to the account
// behind THAT link (the page never learns or shows the address).
async function resend(req, token) {
  const ip = hit(`ip|${ipOf(req)}`, LIMITS.ipPerHour, HOUR);
  if (ip.limited) return { status: 429, body: { error: limitMessage(ip.retryAfter), retryAfter: ip.retryAfter } };
  if (!(await emailIsOn())) return { status: 503, body: { error: EMAIL_OFF_MESSAGE, code: 'EMAIL_OFF' } };
  const got = await lookup(token);
  if (got.user) {
    const m = hit(`mail|${normEmail(got.user.email)}`, LIMITS.emailPerHour, HOUR);
    if (m.limited) return { status: 429, body: { error: limitMessage(m.retryAfter), retryAfter: m.retryAfter } };
  }
  const user = got.user;
  setImmediate(() => {
    if (user) processRequest(req, normEmail(user.email), user);
  });
  return { status: 200, body: { ok: true, message: NEUTRAL_MESSAGE } };
}

// ---------------------------------------------------------------------------
// ADMIN: "Get reset link" - shown ON SCREEN to the Admin to hand over.
// ---------------------------------------------------------------------------
async function adminLink(req, target) {
  const issued = await issueToken(target, { via: 'admin', byName: req.user.name, byUserId: req.user.id, ttlMin: ADMIN_LINK_TTL_MIN });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Reset link made for ${target.name}`, entity: 'User', entityId: target.id,
    toValue: `Shown to the Admin on screen, works once for ${ADMIN_LINK_TTL_MIN} minutes`, reason: whereText(req),
  });
  return { link: linkFor(issued.token), expiresAt: issued.expiresAt, minutes: ADMIN_LINK_TTL_MIN };
}

// ---------------------------------------------------------------------------
// WHO IS TOLD
// ---------------------------------------------------------------------------
async function readSetting() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } }).catch(() => null);
  const v = row && parse(row.value);
  const roles = v && Array.isArray(v.roles) ? v.roles.filter((r) => ALERT_ROLES.includes(r)) : DEFAULT_SETTING.roles.slice();
  return { roles: roles.length ? roles : ['SUPER_ADMIN'], email: v && typeof v.email === 'boolean' ? v.email : DEFAULT_SETTING.email, updatedByName: row && row.updatedByName, updatedAt: row && row.updatedAt };
}

async function writeSetting(user, body) {
  const roles = ALERT_ROLES.filter((r) => Array.isArray(body.roles) && body.roles.includes(r));
  if (!roles.includes('SUPER_ADMIN')) roles.unshift('SUPER_ADMIN'); // Super Admin is always told
  const value = JSON.stringify({ roles, email: body.email !== false });
  const before = await readSetting();
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value, updatedById: user.id, updatedByName: user.name },
    update: { value, updatedById: user.id, updatedByName: user.name },
  });
  await logAudit({
    userId: user.id, actorName: user.name, action: 'Changed who is told when someone changes their password', entity: 'Settings', entityId: SETTING_KEY,
    fromValue: `${before.roles.join(' + ')}${before.email ? ' + email' : ''}`, toValue: `${roles.join(' + ')}${body.email === false ? '' : ' + email'}`,
  });
  return readSetting();
}

// One alert per change. The person who did it (and the person it happened to)
// are never told about themselves.
async function notifyPasswordChange({ user, method, byUserId = null, byName = null, at = new Date() }) {
  try {
    const setting = await readSetting();
    const emp = await prisma.employee.findUnique({ where: { userId: user.id }, select: { department: true } }).catch(() => null);
    const target = { id: user.id, name: user.name, role: user.role, department: (emp && emp.department) || user.atsDepartment || null };
    const testWorld = isTestIdentity(user) || (byName && /zztest/i.test(byName));
    const all = await prisma.user.findMany({
      where: { status: 'Active', role: { in: setting.roles } }, select: { id: true, name: true, email: true, role: true },
    });
    const people = all.filter((r) => r.id !== user.id && r.id !== byUserId && isTestIdentity(r) === !!testWorld);
    if (!people.length) return { told: 0 };
    const { line } = alertText({ target, method, at, byName });
    const title = `Password changed: ${user.name}`;
    const message = `${line}\nOpen: /admin/users?block=${user.id}`;
    const base = baseUrl();
    const blockLink = `${base}/admin/users?block=${user.id}`;
    let told = 0;
    for (const person of people) {
      // De-dupe: the same change must not ping the same person twice.
      // eslint-disable-next-line no-await-in-loop
      const dup = await prisma.notification.findFirst({
        where: { userId: person.id, title, createdAt: { gt: new Date(Date.now() - 60000) } }, select: { id: true },
      });
      if (dup) continue;
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({
        data: { userId: person.id, title, message, channel: 'In-App', recipient: person.name, status: 'Delivered' },
      });
      told += 1;
      if (setting.email && looksLikeEmail(normEmail(person.email))) {
        // eslint-disable-next-line no-await-in-loop
        const res = await deliver({
          to: person.email, kind: 'password-alert', build: (hasLogo) => buildAlertEmail({ target, method, at, byName, blockLink, hasLogo }),
        });
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.error('[password-alert] e-mail to %s not sent: %s', person.id, res.reason);
        }
      }
    }
    return { told };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[password-alert] could not alert: %s', err && err.message);
    return { told: 0 };
  }
}

// The ONE call every password path makes after the new hash is saved:
// kills any live reset link, ends older sessions, tells the overall-access people.
// A login that has never been used and never had a password of its own (first
// "set your password" from a welcome link) is a set-up, not a change: not alerted.
async function afterPasswordChange({
  user, method, byUserId = null, byName = null, firstSetup = false,
}) {
  dropGate(user.id);
  // A link already used is already dead (markDead skips it); any other live link dies here.
  await invalidateFor(user.id, 'supersededAt').catch(() => {});
  if (firstSetup) return { told: 0 };
  return notifyPasswordChange({ user, method, byUserId, byName });
}

// True when this login already had a password of its own before now (so a
// change is a real change, not first-time set-up).
function hadPasswordBefore(userRow) {
  return !!(userRow && (userRow.lastLoginAt || userRow.passwordChangedAt || userRow.passwordResetRequired));
}

module.exports = {
  RESET_TTL_MIN, ADMIN_LINK_TTL_MIN, NEUTRAL_MESSAGE, EMAIL_OFF_MESSAGE, SETTING_KEY, DEFAULT_SETTING, ALERT_ROLES, LIMITS,
  baseUrl, linkFor, sha, screenRequest, processRequest, inspect, redeem, resend, adminLink, issueToken, lookup, invalidateFor,
  tokenIsStale, dropGate, readSetting, writeSetting, notifyPasswordChange, afterPasswordChange, hadPasswordBefore,
  buildResetEmail, buildMultiResetEmail, buildAlertEmail, captureDir, normEmail, looksLikeEmail, hit, whereText,
  // shared with utils/loginActivation.js (the activation mail of a separate login)
  roleText, shell, btn, para, esc, whenText, deliver,
};
