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
    return { emailsEnabled: v.emailsEnabled === true, updatedAt: row ? row.updatedAt : null, updatedByName: row ? row.updatedByName : null };
  } catch { return { emailsEnabled: false }; }
}
async function saveSettings(patch, user) {
  const cur = await loadSettings();
  const next = { emailsEnabled: patch.emailsEnabled === undefined ? cur.emailsEnabled : patch.emailsEnabled === true };
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
// USER RULE (2026-10-06): money / invoice notifications go ONLY to Super Admin
// and the Accounts Accountant role, resolved NOW (at send time), never to
// Recruiter / BDE / HR / employees. Each candidate is re-checked against the
// live permission engine (Accounts product, Office & Expenses view, Accounts
// desk role); test logins never receive real notices (agent-rules lesson).
async function billReviewers() {
  const { resolveIdentity } = require('./identity');
  const { can, roleForProduct, SET } = require('./permissions');
  const users = await prisma.user.findMany({
    where: {
      status: 'Active',
      OR: [{ role: 'SUPER_ADMIN' }, { accountsRole: 'ACCOUNTANT' }, { role: 'ACCOUNTANT' }],
      NOT: [{ name: { contains: 'ZZTEST' } }, { name: { contains: 'zztest' } }, { email: { contains: 'example.test' } }],
    },
    select: { id: true, email: true, name: true },
  });
  const out = [];
  for (const u of users) {
    // eslint-disable-next-line no-await-in-loop
    const id = await resolveIdentity(u.id).catch(() => null);
    if (!id || (id.status && id.status !== 'Active')) continue; // eslint-disable-line no-continue
    const accRole = roleForProduct(id, 'accounts');
    const isSuper = id.role === 'SUPER_ADMIN';
    const isAccountant = accRole === 'ACCOUNTANT';
    if (!(isSuper || isAccountant)) continue; // eslint-disable-line no-continue
    if (!accRole || !SET.ACCOUNTS.includes(accRole)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if (!(await can(id, 'accounts', 'accounts', 'Office & Expenses', 'view').catch(() => false))) continue; // eslint-disable-line no-continue
    out.push({ id: u.id, email: u.email, name: u.name });
  }
  return out;
}

// The caller's IP (proxy-aware, same rule as publicRateLimit) and user agent.
function requestMeta(req) {
  let ip = 'unknown';
  try { ip = require('./publicRateLimit').ipOf(req); } catch { /* keep unknown */ }
  return { ip: String(ip).slice(0, 60), userAgent: String((req && req.headers && req.headers['user-agent']) || '').slice(0, 300) || null };
}

module.exports = {
  portalEnabled, CFG, allowedOrigins, vendorPasswordProblem, PW_MIN, pushHistory, parseHistory, HISTORY_KEEP,
  loadSettings, saveSettings, sendVendorEmail, billReviewers, requestMeta,
};
