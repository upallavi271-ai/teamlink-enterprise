// ---------------------------------------------------------------------------
// VENDOR PORTAL — settings, policy and notices (spec v2, 2026-10-06).
//
// ENVIRONMENT (no secrets here; every value has a safe default):
//   VENDOR_PORTAL_ENABLED     1 / 0. Unset = ON unless NODE_ENV=production.
//                             Production: leave it unset (OFF) or set 0 until
//                             the portal is tested; set 1 to switch it on.
//                             OFF = vendor login, portal and every
//                             /api/vendor-portal API answer 404; nothing else
//                             changes (staff screens keep working, vendor
//                             tokens are still refused everywhere).
//   VENDOR_IDLE_MINUTES       30   sliding idle timeout
//   VENDOR_SESSION_MAX_HOURS  12   absolute session length
//   VENDOR_LOCK_MINUTES       30   lock after MAX failures (auto-unlock)
//   VENDOR_MAX_FAILED_LOGINS  5
//   VENDOR_TEMP_PASSWORD_DAYS 7    an unused temporary password expires
//   VENDOR_UPLOAD_MAX_MB      10   per file
//   VENDOR_PORTAL_ORIGINS     comma list of browser origins allowed to call
//                             /api/vendor-portal (default APP_BASE_URL +
//                             the local dev / sandbox frontends)
//   VENDOR_JWT_SECRET         optional; default is derived from JWT_SECRET
//
// SETTINGS (AppSetting 'vendorPortal.settings', Administration → Company
// Setup → Vendor logins → Settings): emailsEnabled — the "Vendor emails"
// switch, OFF by default, like the candidate-emails switch. While OFF the app
// sends no vendor / reviewer email; in-app notices still go out.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

function portalEnabled() {
  const raw = String(process.env.VENDOR_PORTAL_ENABLED ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return process.env.NODE_ENV !== 'production';
}

const CFG = {
  get idleMinutes() { return num(process.env.VENDOR_IDLE_MINUTES, 30); },
  get maxHours() { return num(process.env.VENDOR_SESSION_MAX_HOURS, 12); },
  get lockMinutes() { return num(process.env.VENDOR_LOCK_MINUTES, 30); },
  get maxFailed() { return num(process.env.VENDOR_MAX_FAILED_LOGINS, 5); },
  get tempPasswordDays() { return num(process.env.VENDOR_TEMP_PASSWORD_DAYS, 7); },
  get uploadMaxBytes() { return num(process.env.VENDOR_UPLOAD_MAX_MB, 10) * 1024 * 1024; },
};

function allowedOrigins() {
  const list = String(process.env.VENDOR_PORTAL_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (list.length) return list;
  const base = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  return [...new Set([base, 'http://localhost:5183', 'http://localhost:5184', 'http://127.0.0.1:5183', 'http://127.0.0.1:5184'].filter(Boolean))];
}

// ---- password policy (vendor logins only; staff policy is untouched) --------
const PW_MIN = 10;
function vendorPasswordProblem(pw, { email, name } = {}) {
  const p = String(pw || '');
  if (p.length < PW_MIN) return `Use at least ${PW_MIN} characters.`;
  if (p.length > 128) return 'That password is too long (128 characters at most).';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p) || !/[^A-Za-z0-9]/.test(p)) {
    return 'Use a capital letter, a small letter, a number and a symbol (like ! or #).';
  }
  const lower = p.toLowerCase();
  const mail = String(email || '').toLowerCase();
  if (mail && (lower === mail || (mail.split('@')[0].length >= 4 && lower.includes(mail.split('@')[0])))) return 'Do not use your email in the password.';
  const first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
  if (first && first.length >= 4 && lower.includes(first)) return 'Do not use your name in the password.';
  return null;
}
const HISTORY_KEEP = 3;
function parseHistory(raw) { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
// The new history after `oldHash` is replaced: newest first, at most HISTORY_KEEP.
const pushHistory = (raw, oldHash) => JSON.stringify([oldHash, ...parseHistory(raw)].filter(Boolean).slice(0, HISTORY_KEEP));

// ---- settings ---------------------------------------------------------------
const SETTINGS_KEY = 'vendorPortal.settings';
async function loadSettings() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = row ? JSON.parse(row.value) : {};
    return {
      emailsEnabled: v.emailsEnabled === true, supportEmail: String(v.supportEmail || ''), supportPhone: String(v.supportPhone || ''), brandName: String(v.brandName || ''),
      updatedAt: row ? row.updatedAt : null, updatedByName: row ? row.updatedByName : null,
    };
  } catch { return { emailsEnabled: false, supportEmail: '', supportPhone: '', brandName: '' }; }
}
async function saveSettings(patch, user) {
  const cur = await loadSettings();
  // The text fields (support contact, brand name) are tidied here: one line, no markup, short.
  const text = (v, d, n) => (v === undefined ? d : String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n));
  const next = {
    emailsEnabled: patch.emailsEnabled === undefined ? cur.emailsEnabled : patch.emailsEnabled === true,
    supportEmail: text(patch.supportEmail, cur.supportEmail, 160), supportPhone: text(patch.supportPhone, cur.supportPhone, 40), brandName: text(patch.brandName, cur.brandName, 80),
  };
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next), updatedById: user && user.id, updatedByName: user && (user.name || user.email) },
    update: { value: JSON.stringify(next), updatedById: user && user.id, updatedByName: user && (user.name || user.email) },
  });
  return loadSettings();
}

// ---- email (through the existing mailer; never when the switch is OFF) ------
// Every attempt is written to the central Notification log (channel Email,
// recipient, status) so it can be seen in Administration → Notifications.
async function sendVendorEmail({ to, subject, text, userId = null }) {
  const s = await loadSettings();
  if (!s.emailsEnabled) return { sent: false, reason: 'Vendor emails are switched off' };
  let r;
  try { r = await require('./mailer').sendMail({ to, subject, text, useEmployeeFrom: false }); } catch (e) { r = { ok: false, error: e.message }; }
  try {
    await prisma.notification.create({
      data: {
        userId, title: String(subject || '').slice(0, 190), message: r.ok ? 'Email sent' : `Email not sent: ${String(r.error || '').slice(0, 300)}`,
        channel: 'Email', recipient: String(to || '').slice(0, 190), status: r.ok ? 'Sent' : 'Failed', read: true,
      },
    });
  } catch { /* the log never breaks the action */ }
  return { sent: !!r.ok, reason: r.ok ? null : (r.error || 'not sent') };
}

// ---- who reviews vendor bills (money notices) -------------------------------
// FOUNDER RULE (2026-10-19, replaces the 2026-10-06 'Super Admin + Accountant' rule): Accounts reminders and money notices go
// to the ACCOUNTANT role only, not to the Admin / Super Admin. The one decision lives in utils/accountsRecipients.js (active
// Accountant logins, re-checked against the live permission engine; test logins never get a real notice; the Admin is added only
// if the founder switched on 'Also send to the Admin' on the Proof reminder card). When there is no Accountant at all, nothing
// goes to the Admin instead: the Admin gets ONE 'No accountant is set up' notice and this returns an empty list.
// Used by: vendor bills (vendorPortal), vendor invoices / monthly bills (vendorModulePortal), repair invoices and 'Changed in HRMS'
// cost changes (assetVendorPortal), partner payouts to approve (partners).
async function billReviewers(kind) {
  const AR = require('./accountsRecipients'); // eslint-disable-line global-require
  const RS = require('./accountsReminderSettings'); // eslint-disable-line global-require
  // Which reminder this is: callers pass the kind; the repair notices of assetVendorPortal.js (another team's file) are told apart by the
  // function that called, so that file did not have to change.
  let k = RS.kindDef(kind) ? kind : null;
  if (!k) {
    const stack = String(new Error().stack || '');
    if (/assetVendorPortal/.test(stack)) k = /sendInvoice/.test(stack) ? 'repairInvoice' : 'repairCost';
    else if (/vendorModulePortal/.test(stack)) k = 'vendorInvoice';
    else if (/partners.js/.test(stack)) k = 'partnerPayout';
    else k = 'vendorBill';
  }
  const team = await AR.reminderRecipients({ kind: k });
  if (team.none && team.on) await AR.warnNoRecipients(k, 'a vendor bill, invoice or payout is waiting for a check');
  // Email is only handed out when the Admin left the email way ON for this reminder (callers mail whoever has an address here).
  const mail = team.channels.includes('email');
  return team.users.map((u) => ({ id: u.id, email: mail ? u.email : null, name: u.name }));
}

// The caller's IP (proxy-aware, same rule as publicRateLimit) and user agent.
function requestMeta(req) {
  let ip = 'unknown';
  try { ip = require('./publicRateLimit').ipOf(req); } catch { /* keep unknown */ }
  return { ip: String(ip).slice(0, 60), userAgent: String((req && req.headers && req.headers['user-agent']) || '').slice(0, 300) || null };
}


// ---- harmless noise in what a person types or pastes (2026-10-19) -----------------------------------------------
// A password or login ID copied from an email (or typed on a phone) often carries invisible extras: a space or line break at the end,
// a non-breaking space, a zero-width character, a curly quote around it. They are removed here. NEVER used to change what is SAVED
// (a chosen password is stored exactly as typed); only to also TRY the cleaned form when the exact form is not right.
// (The code points are written as numbers so no invisible character ever sits in this source file.)
const BS = String.fromCharCode(92);
const cp = (n) => ([0x5D, 0x5B, 0x5C, 0x5E, 0x2D].includes(n) ? BS : '') + String.fromCodePoint(n);
const classOf = (ranges) => `[${ranges.map(([a, b]) => cp(a) + (b ? `-${cp(b)}` : '')).join('')}]`;
const INVISIBLE = new RegExp(classOf([[0xAD], [0x34F], [0x61C], [0x115F], [0x1160], [0x17B4], [0x17B5], [0x180B, 0x180E], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x206F], [0x3164], [0xFE00, 0xFE0F], [0xFEFF], [0xFFA0]]), 'g');
const SPACES = new RegExp(`${classOf([[0x09, 0x0D], [0x20], [0xA0], [0x1680], [0x2000, 0x200A], [0x2028], [0x2029], [0x202F], [0x205F], [0x3000]])}+`, 'g');
const QUOTES = `${String.fromCodePoint(0x201C)}${String.fromCodePoint(0x201D)}${String.fromCodePoint(0x2018)}${String.fromCodePoint(0x2019)}`;
const EDGE_SET = [[0x22], [0x27], [0x201C, 0x201D], [0x2018, 0x2019], [0x3C], [0x3E], [0x28, 0x29], [0x5B], [0x5D], [0x7B], [0x7D], [0x2C], [0x2E], [0x3A, 0x3B]];
const EDGE_MARKS = new RegExp(`^${classOf(EDGE_SET)}+|${classOf(EDGE_SET)}+$`, 'g');
function tidyPasted(s) {
  let t = String(s == null ? '' : s).replace(INVISIBLE, '');
  try { t = t.normalize('NFKC'); } catch { /* keep */ }
  return t.replace(INVISIBLE, '').replace(SPACES, ' ').trim();
}
// The login ID (an email) as a person may have typed it: tidy, no mailto:, no <angle brackets>, lower case.
function loginIdOf(s) {
  return tidyPasted(s).replace(/^mailto:/i, '').replace(/^[<"']+|[>"']+$/g, '').replace(/\s+/g, '').toLowerCase();
}
// The passwords to try, the exact one FIRST. A temporary password (letters, digits and a few symbols, never a space) is also tried with
// every space / line break taken out and without a quote or full stop at either end.
function passwordCandidates(raw, { temp = false } = {}) {
  const exact = String(raw == null ? '' : raw);
  const out = [exact];
  const tidy = tidyPasted(exact);
  if (tidy && tidy !== exact) out.push(tidy);
  if (temp) {
    const compact = tidy.replace(/\s+/g, '').replace(EDGE_MARKS, '');
    if (compact && !out.includes(compact)) out.push(compact);
  }
  return out.filter((v) => v);
}

module.exports = {
  tidyPasted, loginIdOf, passwordCandidates,
  portalEnabled, CFG, allowedOrigins, vendorPasswordProblem, PW_MIN, pushHistory, parseHistory, HISTORY_KEEP,
  loadSettings, saveSettings, sendVendorEmail, billReviewers, requestMeta,
};
