// ---------------------------------------------------------------------------
// VENDOR LOGIN EMAILS (2026-10-19) - the welcome / password-reset / new-address emails a vendor gets, and the honest record of each.
//
//   kinds     invite  the welcome email with the secure link to set their OWN password (new login, or "Resend invitation")
//             reset   the password-reset email ("Forgot password" on the Vendor Portal, or Admin's "Send password reset")
//             verify  goes to a NEW email address when Admin changes the email of an ACTIVE vendor; the change counts only after the
//                     vendor opens the link (until then the old email keeps working)
//
//   SECURITY   * No password is ever emailed, stored in clear, logged or shown. The link is a random 32-byte token; only its sha256 is
//                stored (VendorLoginToken for invite / reset, VendorEmailChange for verify); single use; expires (invite 72 h, reset 1 h
//                when the vendor asked / 24 h when Admin sent it, verify 24 h); a newer link kills the older ones.
//              * The raw link exists only in memory while the email is composed. The email log (VendorMailLog) keeps the status, the
//                provider's words (with the link scrubbed) and the times - never the link, the token or the body.
//
//   HONEST STATUS  "accepted" = the mail server took the message (acceptedAt). "delivered" = the provider CONFIRMED delivery (deliveredAt),
//                  which needs the provider's delivery webhook (applyProviderEvent, wired into the existing signed email webhook).
//                  Where the provider cannot confirm, the screen says so ("Delivery not confirmed by the provider"). In the test sandbox
//                  nothing leaves the machine and the status says "Test mode: not really sent".
//
//   ONE EMAIL PER ATTEMPT  claimAttempt() inserts the attempt row first; dedupeKey is UNIQUE, so a double click or an API retry (same
//                  Idempotency-Key, or the same attempt number) loses the insert and gets the existing state back instead of a second email.
//
//   WORDING  the three emails are editable Message templates (audience "Vendors", purposes VENDOR_WELCOME / VENDOR_PASSWORD_RESET /
//            VENDOR_EMAIL_VERIFY - utils/vendorMessageDefaults.js). The template gives the words; this file adds the TeamLink Consultants
//            frame, the button, the plain-text twin and the details (login ID, portal address, expiry, support contact).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./vmDb');
const SCHEMA = require('./vendorMailSchema');
const VC = require('./vendorConfig');
const INV = require('./vendorInvite');
const H = require('./reportMailHtml');

const PURPOSE = { invite: 'VENDOR_WELCOME', reset: 'VENDOR_PASSWORD_RESET', verify: 'VENDOR_EMAIL_VERIFY', notice: 'VENDOR_EMAIL_CHANGED' };
const KIND_WORD = { invite: 'Welcome email', reset: 'Password reset email', verify: 'New email confirmation', notice: 'Email change notice' };
const STALE_SENDING_MS = 3 * 60 * 1000;
const VERIFY_HOURS = () => (Number.isFinite(Number(process.env.VENDOR_VERIFY_HOURS)) && Number(process.env.VENDOR_VERIFY_HOURS) > 0 ? Number(process.env.VENDOR_VERIFY_HOURS) : 24);
const FORGOT_HOURS = () => (Number.isFinite(Number(process.env.VENDOR_FORGOT_HOURS)) && Number(process.env.VENDOR_FORGOT_HOURS) > 0 ? Number(process.env.VENDOR_FORGOT_HOURS) : 1);
// A forgotten-password request: at most this many emails per login per hour (the rest are quietly skipped, never revealed).
const FORGOT_MAX_PER_HOUR = () => (Number.isFinite(Number(process.env.VENDOR_FORGOT_MAX_PER_HOUR)) && Number(process.env.VENDOR_FORGOT_MAX_PER_HOUR) > 0 ? Number(process.env.VENDOR_FORGOT_MAX_PER_HOUR) : 3);

const nowIso = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');
const newId = () => `vml${crypto.randomBytes(12).toString('hex')}`;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// ---- the TEMPORARY PASSWORD in the welcome email (founder, 2026-10-19: "the vendor must see BOTH login ID and password") ------------------
// Made on the server, 12 readable characters with no look-alikes (no 0 O 1 l I), one capital, one small letter, one number, one symbol,
// and it passes the vendor password rules. It exists in plain text ONLY in memory, for the one email that carries it. What is stored is
// its bcrypt hash in the login's password column (the app's own mechanism). It expires with the invitation (tempPasswordExpiresAt), the
// vendor is FORCED to choose their own at the first sign-in (mustChangePassword), a new invitation replaces it, and it is never logged,
// audited, returned by an API or shown to Admin. It is never a permanent password.
const TEMP_SETS = { U: 'ABCDEFGHJKLMNPQRSTUVWXYZ', L: 'abcdefghjkmnpqrstuvwxyz', D: '23456789', S: '!#$%*+=?@' };
function generateTempPassword({ email, name } = {}) {
  const pick = (set) => set[crypto.randomInt(set.length)];
  const all = TEMP_SETS.U + TEMP_SETS.L + TEMP_SETS.D + TEMP_SETS.S;
  for (let tries = 0; tries < 50; tries += 1) {
    const chars = [pick(TEMP_SETS.U), pick(TEMP_SETS.L), pick(TEMP_SETS.D), pick(TEMP_SETS.S), ...Array.from({ length: 8 }, () => pick(all))];
    for (let i = chars.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    const pw = chars.join('');
    if (!VC.vendorPasswordProblem(pw, { email, name })) return pw;
  }
  throw new Error('could not make a temporary password');
}

// ---- the fingerprint of an invitation's temporary password (2026-10-19) -----------------------------------------------------------------
// WHY: every Resend / Retry / Edit email makes a NEW temporary password and kills the old one. A vendor who then types the password from an OLDER
// email used to get only "Invalid credentials." and, after 5 tries, a 30 minute lock - while the right password sat in the newest email.
// WHAT: for each invitation attempt we keep credMark = HMAC-SHA256(server secret, login row + "|" + password). It is NOT the password and
// cannot be turned back into it (the key stays on the server and the password has about 70 bits of randomness). At sign-in, a password that
// matches the mark of an OLDER attempt is answered with "this password was replaced by a newer email (invitation #N)" - only to somebody who
// really holds that old password, so nothing leaks to a stranger - and it is NOT counted as a wrong try.
function markKey() {
  const base = process.env.VENDOR_JWT_SECRET || process.env.JWT_SECRET || '';
  return base ? crypto.createHash('sha256').update(`vendor-cred-mark:${base}`).digest() : null;
}
function credMark(vendorUserId, password) {
  const key = markKey();
  if (!key || !password || !vendorUserId) return null;
  return crypto.createHmac('sha256', key).update(`${vendorUserId}|${password}`).digest('hex');
}

// ---- the brand, the portal address, the support contact ---------------------------------------
const maskEmail = (e) => {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  return `${u.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`;
};

async function brand() {
  const s = await VC.loadSettings();
  const co = await prisma.company.findFirst().catch(() => null);
  const supportEmail = s.supportEmail || (co && co.email) || process.env.VENDOR_SUPPORT_EMAIL || '';
  const supportPhone = s.supportPhone || (co && co.phone) || '';
  const logoUrl = co && /^https:\/\//i.test(String(co.logoUrl || '')) ? co.logoUrl : '';
  const supportLine = supportEmail && supportPhone ? `Email ${supportEmail} or call ${supportPhone}.`
    : supportEmail ? `Email ${supportEmail}.` : supportPhone ? `Call ${supportPhone}.` : 'Reply to this email and we will help you.';
  return {
    name: s.brandName || 'TeamLink Consultants', supportEmail, supportPhone, supportLine, logoUrl,
    supportSource: s.supportEmail || s.supportPhone ? 'settings' : (co && (co.email || co.phone) ? 'company' : 'none'),
  };
}
const portalUrl = () => `${INV.baseUrl()}/vendor-login`;
const verifyLink = (token) => `${INV.baseUrl()}/vendor-login?verify=${encodeURIComponent(token)}`;

function whenText(d) {
  return `${new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST`;
}
function spanText(hours) {
  const h = Math.round(Number(hours) || 0);
  if (h >= 24 && h % 24 === 0) { const d = h / 24; return `${d} day${d === 1 ? '' : 's'}`; }
  return `${h} hour${h === 1 ? '' : 's'}`;
}

// ---- composing the email ----------------------------------------------------------------------
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text -> branded HTML. A line that is only the secure link becomes a button (plus the plain address under it, for mail apps that hide buttons).
function htmlOf({ subject, text, link, buttonLabel, brand: b, portal, secret, loginId }) {
  const BLUE = '#1d4ed8';
  // The login ID and the temporary password each sit in ONE plain monospace box: no letter spacing, no hidden characters, one click selects it.
  const BOX = "font-family:Consolas,'Courier New',monospace;font-size:16px;font-weight:700;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;padding:2px 8px;white-space:nowrap;-webkit-user-select:all;user-select:all";
  const linkify = (line) => {
    const alts = [link, portal, secret, loginId, b.supportEmail].filter(Boolean).map(escRe);
    if (!alts.length) return H.esc(line);
    const re = new RegExp(`(${alts.join('|')})`, 'g');
    return line.split(re).map((part) => {
      if (!part) return '';
      if (part === link || part === portal) return `<a href="${H.esc(part)}" style="color:${BLUE}">${H.esc(part)}</a>`;
      if ((secret && part === secret) || (loginId && part === loginId)) return `<span style="${BOX}">${H.esc(part)}</span>`;
      if (b.supportEmail && part === b.supportEmail) return `<a href="mailto:${H.esc(part)}" style="color:${BLUE}">${H.esc(part)}</a>`;
      return H.esc(part);
    }).join('');
  };
  const out = [];
  String(text).split(/\n{2,}/).forEach((para) => {
    let buf = [];
    const flush = () => { if (buf.length) out.push(`<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#1f2937">${buf.join('<br>')}</p>`); buf = []; };
    para.split('\n').forEach((line) => {
      if (link && line.trim() === link) {
        flush();
        out.push(`<div style="margin:6px 0 18px"><a href="${H.esc(link)}" style="background:${BLUE};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600;display:inline-block">${H.esc(buttonLabel)}</a>`
          + `<div style="margin-top:10px;font-size:12px;color:#6b7280;word-break:break-all">If the button does not work, copy this address into your browser:<br><a href="${H.esc(link)}" style="color:${BLUE}">${H.esc(link)}</a></div></div>`);
      } else buf.push(linkify(line));
    });
    flush();
  });
  const logo = b.logoUrl ? `<img src="${H.esc(b.logoUrl)}" alt="${H.esc(b.name)}" height="36" style="display:block;margin:0 0 6px;border:0">` : '';
  const contact = [b.supportEmail ? `<a href="mailto:${H.esc(b.supportEmail)}" style="color:${BLUE}">${H.esc(b.supportEmail)}</a>` : '', b.supportPhone ? H.esc(b.supportPhone) : ''].filter(Boolean).join(' &middot; ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${H.esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px 8px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb"><tr><td style="padding:0">
<div style="background:${BLUE};color:#ffffff;padding:16px 22px;border-radius:8px 8px 0 0">${logo}<div style="font-size:19px;font-weight:700">${H.esc(b.name)}</div><div style="font-size:13px;opacity:.9">Vendor Portal</div></div>
<div style="padding:22px 22px 8px">${out.join('')}</div>
<div style="padding:12px 22px 18px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;line-height:1.5">This is an automatic email from ${H.esc(b.name)}.${contact ? `<br>Support: ${contact}` : ''}</div>
</td></tr></table></td></tr></table></body></html>`;
}

// -> { subject, text, html, templateId, templateVersion }
async function compose({ kind, vu, vendor, link, expiresAt, hours, newEmail, tempPassword, attemptNo = 1 }) {
  const MT = require('./messageTemplates'); // eslint-disable-line global-require
  const b = await brand();
  const t = await MT.resolve({ purpose: PURPOSE[kind], channel: 'Email', language: 'English' });
  // A built-in template nobody has edited (still version 1) always follows the wording in the code, so a wording fix ships with the app.
  if (t.source === 'saved' && t.builtIn && t.version === 1) {
    const d = require('./vendorMessageDefaults').find(PURPOSE[kind], 'Email'); // eslint-disable-line global-require
    if (d) { t.subject = d.subject; t.body = d.body; }
  }
  const portal = portalUrl();
  const values = {
    name: vu.name, vendorCompany: (vendor && (vendor.name || vendor.companyName)) || '', loginId: vu.email, portalUrl: portal, setupLink: link || '',
    expiresOn: whenText(expiresAt), expiryText: spanText(hours), supportLine: b.supportLine, supportEmail: b.supportEmail, supportPhone: b.supportPhone,
    newEmail: newEmail || '', company: b.name, tempPassword: tempPassword || '', attemptNo: String(attemptNo || 1), sentAt: whenText(new Date()),
  };
  let text = MT.render(t.body, values, { blank: '' }).text.replace(/\n{3,}/g, '\n\n').trim();
  // Wording that lost the link (it cannot be saved that way, but never send a mail the vendor cannot use).
  if (link && !text.includes(link)) text += `\n\nSecure link:\n${link}`;
  if (tempPassword && !text.includes(tempPassword)) text += `\n\nTemporary password: ${tempPassword}`;
  // Which email is the newest? Said in the body (even when the wording was edited) and in the subject, so two emails never look the same.
  if (kind === 'invite' && tempPassword && !/newest email/i.test(text)) {
    text += `

This is invitation number ${values.attemptNo}, sent on ${values.sentAt}. Use only the newest email we send you: older passwords stop working.`;
  }
  let subject = MT.render(t.subject || '', values, { blank: '' }).text.trim() || `${b.name} Vendor Portal`;
  if (kind === 'invite' && tempPassword && !/invitation (#|number|no)/i.test(subject)) subject = `${subject} (invitation #${values.attemptNo})`;
  const buttonLabel = kind === 'notice' ? '' : kind === 'invite' ? 'Set my password' : kind === 'verify' ? 'Confirm my new email' : 'Choose a new password';
  const html = htmlOf({ subject, text, link, buttonLabel, brand: b, portal, secret: tempPassword || '', loginId: tempPassword ? vu.email : '' });
  return { subject, text, html, templateId: t.id || null, templateVersion: t.version || 1 };
}

// ---- sending ----------------------------------------------------------------------------------
const REASON = {
  EMAILS_OFF: 'Vendor emails are switched off. Turn them on in Vendor logins > Settings, then press Retry.',
  NOT_SET_UP: 'Email is not set up yet. Ask your admin to fill in Administration > Integrations > Email (SMTP), then press Retry.',
  PORTAL_OFF: 'The Vendor Portal is switched off on this server, so the link would not work. Switch it on, then press Retry.',
  TEST_ADDRESS: 'This is a test address (like example.test), so nothing was sent. Use the vendor\'s real email.',
  REJECTED: 'The mail server did not accept the email. Check the vendor\'s email address, then press Retry.',
  TEMPORARY: 'The mail server could not be reached just now. Press Retry in a few minutes.',
  INTERRUPTED: 'Sending was interrupted before it finished. Press Retry.',
  BOUNCED: 'The email came back as undelivered (bounced). Check the vendor\'s email address, then press Retry.',
  SERVER_ERROR: 'Something went wrong while sending. Press Retry; if it happens again, tell the support team.',
};
// Only when email is simply not set up (never for a mail-server error) may Admin be given the link to pass on by hand, once.
const MANUAL_LINK_CODES = ['EMAILS_OFF', 'NOT_SET_UP'];

// Takes the link out of anything we keep (a provider's words never contain it, this is the belt to the braces).
const scrub = (text, secrets) => (secrets || []).filter(Boolean).reduce((t, s) => String(t).split(s).join('[link removed]'), String(text || ''));

async function transmit({ to, subject, text, html, b }) {
  const s = await VC.loadSettings();
  if (!s.emailsEnabled) return { ok: false, code: 'EMAILS_OFF' };
  if (!VC.portalEnabled()) return { ok: false, code: 'PORTAL_OFF' };
  const mailer = require('./mailer'); // eslint-disable-line global-require
  const r = await mailer.sendMail({
    to, subject, text, html, useEmployeeFrom: false, fromName: b.name, senderEmail: b.supportEmail || undefined,
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
  });
  if (r && r.ok) return { ok: true, providerRef: r.providerRef || null, response: r.response || '' };
  if (r && r.notConfigured) return { ok: false, code: 'NOT_SET_UP', detail: r.error };
  if (/reserved test domain/i.test(String(r && r.error))) return { ok: false, code: 'TEST_ADDRESS', detail: r.error };
  return { ok: false, code: r && r.transient ? 'TEMPORARY' : 'REJECTED', detail: r && r.error };
}

// ---- the attempt ledger -----------------------------------------------------------------------
const rowShape = (r) => r && ({
  ...r,
  attemptNo: Number(r.attemptNo || 1),
});

async function latest(vendorUserId, kind, c) {
  return DB.one(`SELECT * FROM "VendorMailLog" WHERE "vendorUserId" = ?${kind ? ' AND "kind" = ?' : ''} ORDER BY "createdAt" DESC, "attemptNo" DESC LIMIT 1`, kind ? [vendorUserId, kind] : [vendorUserId], c);
}

// Inserts the attempt row FIRST. -> { row, duplicate } ; duplicate:true = somebody already holds this attempt (nothing must be sent).
async function claimAttempt({ vu, kind, toEmail, tokenId = null, changeId = null, linkExpiresAt = null, actor = null, via = 'admin', idemKey = '', credMark: mark = null }, c) {
  const maxRow = await DB.one('SELECT MAX("attemptNo") AS n FROM "VendorMailLog" WHERE "vendorUserId" = ? AND "kind" = ?', [vu.id, kind], c);
  const attemptNo = Number((maxRow && maxRow.n) || 0) + 1;
  const dedupeKey = idemKey ? `${kind}:${vu.id}:k:${sha(idemKey).slice(0, 32)}` : `${kind}:${vu.id}:n:${attemptNo}`;
  const same = await DB.one('SELECT * FROM "VendorMailLog" WHERE "dedupeKey" = ?', [dedupeKey], c);
  if (same) return { row: rowShape(same), duplicate: true };
  const id = newId();
  const t = nowIso();
  try {
    await DB.run(
      `INSERT INTO "VendorMailLog" ("id","vendorUserId","vendorId","kind","attemptNo","dedupeKey","toEmail","status","tokenId","changeId","linkExpiresAt","requestedById","requestedByName","requestedVia","createdAt","updatedAt","credMark")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, vu.id, vu.vendorId || null, kind, attemptNo, dedupeKey, toEmail, 'sending', tokenId, changeId, linkExpiresAt ? iso(linkExpiresAt) : null, actor ? actor.id || null : null, actor ? clip(actor.name || actor.email || '', 120) : null, via, t, t, mark],
      c,
    );
  } catch (err) {
    if (!/UNIQUE|constraint/i.test(String(err && err.message))) throw err;
    const win = await DB.one('SELECT * FROM "VendorMailLog" WHERE "dedupeKey" = ?', [dedupeKey], c);
    if (win) return { row: rowShape(win), duplicate: true };
    throw err;
  }
  return { row: rowShape(await DB.one('SELECT * FROM "VendorMailLog" WHERE "id" = ?', [id], c)), duplicate: false };
}
const iso = (d) => new Date(d).toISOString();

async function patchRow(id, set) {
  const keys = Object.keys(set);
  if (!keys.length) return;
  await DB.run(`UPDATE "VendorMailLog" SET ${keys.map((k) => `"${k}" = ?`).join(', ')}, "updatedAt" = ? WHERE "id" = ?`, [...keys.map((k) => set[k]), nowIso(), id]);
}

async function logBell({ to, subject, ok, reason }) {
  try {
    await prisma.notification.create({
      data: {
        userId: null, title: clip(subject, 190), message: ok ? 'Email accepted by the mail server' : `Email not sent: ${clip(reason, 300)}`,
        channel: 'Email', recipient: clip(to, 190), status: ok ? 'Sent' : 'Failed', read: true,
      },
    });
  } catch { /* the log never breaks the action */ }
}

// Sends ONE attempt that this request has just claimed. Never throws. The raw link is passed in and goes nowhere but the email.
// -> { ok, status: 'accepted' | 'failed', failCode, reason, testMode, manualLinkAllowed }
async function deliver(row, { vu, vendor, link, expiresAt, hours, newEmail = null, tempPassword = null }) {
  let mail = null;
  try {
    const b = await brand();
    mail = await compose({ kind: row.kind, vu, vendor, link, expiresAt, hours, newEmail, tempPassword, attemptNo: row.attemptNo });
    await patchRow(row.id, { subject: clip(mail.subject, 200), templateId: mail.templateId, templateVersion: mail.templateVersion });
    const r = await transmit({ to: row.toEmail, subject: mail.subject, text: mail.text, html: mail.html, b });
    const sandbox = require('./sandbox').isSandbox(); // eslint-disable-line global-require
    if (r.ok) {
      await patchRow(row.id, { status: 'accepted', acceptedAt: nowIso(), providerRef: clip(r.providerRef, 200), mode: sandbox ? 'test' : 'live', providerDetail: clip(scrub(r.response, [link, tempPassword]), 300) });
      await logBell({ to: row.toEmail, subject: mail.subject, ok: true });
      return { ok: true, status: 'accepted', testMode: sandbox };
    }
    const reason = REASON[r.code] || REASON.SERVER_ERROR;
    await patchRow(row.id, { status: 'failed', failCode: r.code, failReason: reason, failedAt: nowIso(), providerDetail: clip(scrub(r.detail, [link, tempPassword]), 300), mode: sandbox ? 'test' : 'live' });
    await logBell({ to: row.toEmail, subject: mail.subject, ok: false, reason });
    return { ok: false, status: 'failed', failCode: r.code, reason, manualLinkAllowed: MANUAL_LINK_CODES.includes(r.code) };
  } catch (err) {
    const reason = REASON.SERVER_ERROR;
    try { await patchRow(row.id, { status: 'failed', failCode: 'SERVER_ERROR', failReason: reason, failedAt: nowIso(), providerDetail: clip(scrub(err && err.message, [link, tempPassword]), 300) }); } catch { /* ignore */ }
    console.error('[vendor-mail] deliver:', clip(scrub(err && err.message, [link, tempPassword]), 200));
    return { ok: false, status: 'failed', failCode: 'SERVER_ERROR', reason, manualLinkAllowed: false };
  }
}

// Waits for deliver() at most `ms`; if it is slower, the request answers "still sending" and the row finishes in the background.
async function deliverWithin(row, ctx, ms = 20000) {
  const work = deliver(row, ctx);
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: null, status: 'sending', slow: true }), ms); });
  const r = await Promise.race([work, slow]);
  clearTimeout(timer);
  return r;
}

// ---- reading the state (what the Admin list shows) ---------------------------------------------
const TOKEN_KINDS = ['invite', 'reset'];

// One log row (+ its token row, for invite / reset) -> { status, text, detail, ... } in plain words.
function viewOf(row, token) {
  if (!row) return { status: 'not_sent', text: 'Not sent', detail: 'No email has been sent yet.' };
  const base = {
    id: row.id, kind: row.kind, kindWord: KIND_WORD[row.kind] || row.kind, attemptNo: Number(row.attemptNo || 1), toEmail: row.toEmail,
    requestedByName: row.requestedByName || null, requestedVia: row.requestedVia || null, createdAt: row.createdAt,
    acceptedAt: row.acceptedAt || null, deliveredAt: row.deliveredAt || null, expiresAt: row.linkExpiresAt || null,
    testMode: row.mode === 'test', failCode: row.failCode || null,
  };
  const fresh = Date.now() - new Date(row.createdAt).getTime() < STALE_SENDING_MS;
  if (row.status === 'sending' && fresh) return { ...base, status: 'sending', text: 'Sending...', detail: 'The email is being sent.' };
  if (row.status === 'sending') return { ...base, status: 'failed', text: 'Failed', failCode: 'INTERRUPTED', detail: REASON.INTERRUPTED, reason: REASON.INTERRUPTED };
  if (row.status === 'failed') return { ...base, status: 'failed', text: 'Failed', detail: row.failReason || REASON.SERVER_ERROR, reason: row.failReason || REASON.SERVER_ERROR };
  if (row.status === 'bounced') return { ...base, status: 'failed', text: 'Failed (bounced)', failCode: 'BOUNCED', detail: REASON.BOUNCED, reason: REASON.BOUNCED };
  // accepted | delivered: the link itself may have been used or may have run out
  if (token && token.usedAt) return { ...base, status: 'used', text: 'Used', detail: `The vendor used the link on ${whenText(token.usedAt)}.` };
  const exp = (token && token.expiresAt) || row.linkExpiresAt;
  if (TOKEN_KINDS.includes(row.kind) && ((token && token.revokedAt) || (exp && new Date(exp).getTime() <= Date.now()))) {
    const replaced = token && token.revokedAt;
    return { ...base, status: 'expired', text: replaced ? 'Replaced' : 'Expired', detail: replaced ? 'A newer link was made, so this one no longer works.' : `The link ran out on ${whenText(exp)}.` };
  }
  if (row.kind === 'verify' && exp && new Date(exp).getTime() <= Date.now()) return { ...base, status: 'expired', text: 'Expired', detail: `The link ran out on ${whenText(exp)}.` };
  if (row.status === 'delivered') return { ...base, status: 'delivered', text: 'Delivered', detail: `The mail provider confirmed delivery on ${whenText(row.deliveredAt)}.` };
  if (row.mode === 'test') return { ...base, status: 'sent', text: 'Test mode: not really sent', detail: 'Test mode: nothing left this computer. No real email was sent, so there is no delivery to confirm.' };
  return {
    ...base, status: 'sent', text: 'Sent', detail: `Accepted by the mail server on ${whenText(row.acceptedAt || row.createdAt)}. Delivery not confirmed by the provider.`,
  };
}

const isActivated = (vu) => !!(vu && (vu.passwordChangedAt || !vu.mustChangePassword));

// For many logins at once. -> Map(vendorUserId -> { activated, invitation, lastMail, pendingEmail, canResend, canRetry, canSendReset })
async function statesFor(users) {
  await SCHEMA.ensure();
  const out = new Map();
  if (!users.length) return out;
  const ids = users.map((u) => u.id);
  const marks = ids.map(() => '?').join(',');
  const logs = await DB.q(`SELECT * FROM "VendorMailLog" WHERE "vendorUserId" IN (${marks}) ORDER BY "createdAt" DESC, "attemptNo" DESC`, ids);
  const changes = await DB.q(`SELECT * FROM "VendorEmailChange" WHERE "vendorUserId" IN (${marks}) AND "status" = 'pending'`, ids);
  const byUser = new Map();
  logs.forEach((r) => { if (!byUser.has(r.vendorUserId)) byUser.set(r.vendorUserId, []); byUser.get(r.vendorUserId).push(r); });
  const wanted = new Set();
  byUser.forEach((list) => {
    const inv = list.find((r) => r.kind === 'invite'); const any = list[0];
    [inv, any].forEach((r) => { if (r && r.tokenId) wanted.add(r.tokenId); });
  });
  const tokens = wanted.size ? await prisma.vendorLoginToken.findMany({ where: { id: { in: [...wanted] } } }) : [];
  const tokMap = new Map(tokens.map((t) => [t.id, t]));
  const chMap = new Map(changes.map((c) => [c.vendorUserId, c]));
  for (const vu of users) {
    const list = byUser.get(vu.id) || [];
    const activated = isActivated(vu);
    const inviteRow = list.find((r) => r.kind === 'invite') || null;
    const anyRow = list[0] || null;
    let invitation = viewOf(inviteRow, inviteRow && tokMap.get(inviteRow.tokenId));
    // An activated login: the invitation did its job (older logins have no email row at all).
    if (activated) invitation = { ...invitation, status: 'used', text: 'Used', detail: inviteRow ? 'The vendor set a password and activated the login.' : 'The vendor has activated the login.' };
    const lastMail = anyRow ? viewOf(anyRow, tokMap.get(anyRow.tokenId)) : null;
    const ch = chMap.get(vu.id) || null;
    let pendingEmail = null;
    if (ch) {
      const chRow = list.find((r) => r.changeId === ch.id) || null;
      pendingEmail = {
        id: ch.id, newEmail: ch.newEmail, expiresAt: ch.expiresAt, requestedByName: ch.requestedByName || null, createdAt: ch.createdAt,
        expired: new Date(ch.expiresAt).getTime() <= Date.now(), mail: chRow ? viewOf(chRow, null) : null,
      };
    }
    const emailFailed = invitation.status === 'failed';
    // The Admin column, in the founder's words. "Sent" only ever follows the mail server's acceptance; "Delivered" only the provider's report.
    const label = activated ? 'Account Active'
      : ({ not_sent: 'Invitation Pending', sending: 'Invitation Pending', sent: 'Invitation Sent', delivered: 'Invitation Sent', failed: 'Invitation Failed', expired: 'Invitation Expired', used: 'Account Active' })[invitation.status] || 'Invitation Pending';
    invitation = { ...invitation, label };
    const lastAttempt = anyRow ? { at: anyRow.createdAt, kindWord: KIND_WORD[anyRow.kind] || anyRow.kind, toEmail: anyRow.toEmail, attemptNo: Number(anyRow.attemptNo || 1), kind: anyRow.kind } : null;
    // Only the NEWEST invitation's password and link work. Said plainly to Admin, so nobody points a vendor to an older email.
    const newestInvitation = !activated && inviteRow ? {
      attemptNo: Number(inviteRow.attemptNo || 1), at: inviteRow.createdAt, toEmail: inviteRow.toEmail, status: invitation.status,
      note: `Newest invitation: #${Number(inviteRow.attemptNo || 1)}, sent ${whenText(inviteRow.createdAt)} to ${inviteRow.toEmail}. Only its password and link work; older emails no longer do.`,
    } : null;
    const lastDelivery = list.find((r) => r.deliveredAt) ? { at: list.find((r) => r.deliveredAt).deliveredAt, toEmail: list.find((r) => r.deliveredAt).toEmail } : null;
    out.set(vu.id, {
      activated,
      invitation,
      lastMail,
      lastAttempt,
      newestInvitation,
      lastDelivery,
      emailStatus: ch ? 'change_waiting' : (activated ? 'verified' : 'not_verified'),
      pendingEmail,
      attempts: list.length,
      canResend: !activated && vu.status === 'Active',
      canRetry: !activated && vu.status === 'Active' && emailFailed,
      canSendReset: activated && vu.status === 'Active',
    });
  }
  return out;
}
async function stateOf(vu) { return (await statesFor([vu])).get(vu.id); }

// The whole history of one login, newest first (the "Emails" box in Admin).
async function historyOf(vendorUserId) {
  await SCHEMA.ensure();
  const logs = await DB.q('SELECT * FROM "VendorMailLog" WHERE "vendorUserId" = ? ORDER BY "createdAt" DESC, "attemptNo" DESC LIMIT 100', [vendorUserId]);
  const ids = logs.map((r) => r.tokenId).filter(Boolean);
  const tokens = ids.length ? await prisma.vendorLoginToken.findMany({ where: { id: { in: ids } } }) : [];
  const tm = new Map(tokens.map((t) => [t.id, t]));
  return logs.map((r) => viewOf(r, tm.get(r.tokenId)));
}

// ---- what the email set-up looks like right now (Settings tab, the banner) ---------------------
async function readiness() {
  const s = await VC.loadSettings();
  const sandbox = require('./sandbox').isSandbox(); // eslint-disable-line global-require
  let cfg = { configured: false, reason: 'Email (SMTP) could not be read.' };
  try { cfg = await require('./mailer').emailConfig(); } catch { /* keep default */ } // eslint-disable-line global-require
  const b = await brand();
  let problem = '';
  let code = '';
  if (!s.emailsEnabled) { code = 'EMAILS_OFF'; problem = REASON.EMAILS_OFF; } else if (!VC.portalEnabled()) { code = 'PORTAL_OFF'; problem = REASON.PORTAL_OFF; } else if (!cfg.configured) { code = 'NOT_SET_UP'; problem = `${REASON.NOT_SET_UP}${cfg.reason ? ` (${cfg.reason})` : ''}`; }
  await SCHEMA.ensure();
  const seen = await DB.one('SELECT COUNT(*) AS n FROM "VendorMailLog" WHERE "deliveredAt" IS NOT NULL');
  return {
    ready: !problem, code, problem, emailsEnabled: !!s.emailsEnabled, smtpConfigured: !!cfg.configured, smtpReason: cfg.configured ? '' : cfg.reason,
    fromAddress: cfg.fromAddress || '', testMode: sandbox, portalUrl: portalUrl(), portalOn: VC.portalEnabled(),
    brandName: b.name, supportEmail: b.supportEmail, supportPhone: b.supportPhone, supportSource: b.supportSource,
    deliveryReports: Number(seen && seen.n) > 0 ? 'receiving' : 'not_connected',
    deliveryNote: Number(seen && seen.n) > 0
      ? 'The mail provider is sending delivery reports, so some emails show "Delivered".'
      : 'The mail provider has not sent any delivery report yet. Until it does, an email shows "Sent" (the mail server accepted it) and never "Delivered".',
  };
}

// ---- the provider's delivery report (delivered / bounced) ---------------------------------------
// Called by the existing signed email webhook (outreach/webhook.js) for an event that is not an outreach message.
const bare = (s) => String(s || '').trim().replace(/^<|>$/g, '');
async function applyProviderEvent(ev, atMs) {
  await SCHEMA.ensure();
  const ref = bare(ev && ev.providerRef);
  if (!ref) return { unmatched: true };
  const rows = await DB.q('SELECT * FROM "VendorMailLog" WHERE "providerRef" IN (?, ?) LIMIT 5', [ref, `<${ref}>`]);
  if (!rows.length) return { unmatched: true };
  const at = new Date(atMs || Date.now()).toISOString();
  const type = String(ev.type || '');
  let updated = null;
  for (const r of rows) {
    if (type === 'delivered') {
      if (r.status === 'accepted') { await patchRow(r.id, { status: 'delivered', deliveredAt: at }); updated = 'delivered'; }
    } else if (type === 'bounce' || type === 'complaint') {
      const hard = type === 'complaint' || ev.bounceType === 'hard';
      if (r.status === 'bounced' || (!hard && r.status === 'delivered')) continue; // eslint-disable-line no-continue
      await patchRow(r.id, { status: hard ? 'bounced' : 'failed', bouncedAt: at, failCode: hard ? 'BOUNCED' : 'REJECTED', failReason: hard ? REASON.BOUNCED : 'The mail provider could not deliver the email yet. Press Retry.', failedAt: at });
      updated = hard ? 'bounced' : 'failed';
    }
  }
  return updated ? { updated } : { unchanged: true };
}

// ---- helpers the routes share -------------------------------------------------------------------
// FOUNDER RULE (2026-10-19): every deliberate click on Send / Resend / Retry invitation is a NEW attempt and sends a NEW email (new temporary
// password, new link; the older ones die). Duplicate protection is ONLY for the technical case: the SAME request repeated (same Idempotency-Key,
// or a second request in the very same moment). Rate limit, explained and never silent: at most VENDOR_INVITE_MAX_PER_HOUR (10) Admin-requested
// emails of one kind per login per hour; beyond that a plain message with the minutes to wait. After the window it works again.
const INVITE_MAX_PER_HOUR = () => (Number.isFinite(Number(process.env.VENDOR_INVITE_MAX_PER_HOUR)) && Number(process.env.VENDOR_INVITE_MAX_PER_HOUR) > 0 ? Number(process.env.VENDOR_INVITE_MAX_PER_HOUR) : 10);
const SAME_MOMENT_MS = 3000;
async function findByKey(vendorUserId, kind, idemKey) {
  if (!idemKey) return null;
  return DB.one('SELECT * FROM "VendorMailLog" WHERE "dedupeKey" = ?', [`${kind}:${vendorUserId}:k:${sha(idemKey).slice(0, 32)}`]);
}
// -> { limited, minutes, max, used }
async function rateCheck(vendorUserId, kind) {
  await SCHEMA.ensure();
  const max = INVITE_MAX_PER_HOUR();
  const since = new Date(Date.now() - 3600000).toISOString();
  const rows = await DB.q('SELECT "createdAt" FROM "VendorMailLog" WHERE "vendorUserId" = ? AND "kind" = ? AND "requestedVia" = \'admin\' AND "createdAt" > ? ORDER BY "createdAt" ASC', [vendorUserId, kind, since]);
  if (rows.length < max) return { limited: false, max, used: rows.length };
  const frees = new Date(rows[rows.length - max].createdAt).getTime() + 3600000;
  return { limited: true, max, used: rows.length, minutes: Math.max(1, Math.ceil((frees - Date.now()) / 60000)) };
}
const rateMessage = (r) => `Too many invitations in a short time (${r.max} in one hour for this login). Please try again in ${r.minutes} minute${r.minutes === 1 ? '' : 's'}.`;
// A request in the very same moment as the newest attempt (a double submit): not a new click.
const inSameMoment = (row) => !!row && row.status === 'sending' && Date.now() - new Date(row.createdAt).getTime() < SAME_MOMENT_MS;

// How many password-reset emails a vendor asked for in the last hour (the "forgot password" limit).
async function forgotCountLastHour(vendorUserId) {
  await SCHEMA.ensure();
  const since = new Date(Date.now() - 3600000).toISOString();
  const r = await DB.one('SELECT COUNT(*) AS n FROM "VendorMailLog" WHERE "vendorUserId" = ? AND "kind" = \'reset\' AND "requestedVia" = \'vendor\' AND "createdAt" > ?', [vendorUserId, since]);
  return Number((r && r.n) || 0);
}

// A verification token for an email change. Only the sha256 is stored.
function newVerifyToken() { return crypto.randomBytes(32).toString('base64url'); }

module.exports = {
  PURPOSE, KIND_WORD, REASON, MANUAL_LINK_CODES, STALE_SENDING_MS,
  VERIFY_HOURS, FORGOT_HOURS, FORGOT_MAX_PER_HOUR,
  generateTempPassword, credMark, brand, portalUrl, verifyLink, maskEmail, compose, htmlOf, spanText, whenText,
  claimAttempt, latest, patchRow, deliver, deliverWithin, viewOf, statesFor, stateOf, historyOf, readiness, applyProviderEvent,
  forgotCountLastHour, newVerifyToken, findByKey, rateCheck, rateMessage, inSameMoment, INVITE_MAX_PER_HOUR, isActivated, sha,
  ensure: SCHEMA.ensure,
};
