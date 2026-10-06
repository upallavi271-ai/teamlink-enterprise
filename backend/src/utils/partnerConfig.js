// ---------------------------------------------------------------------------
// PARTNER PORTAL (B7, 2026-10-06) — settings, policy and notices.
// Same shape as the vendor portal's config, written separately so the two
// portals never share a switch or a secret.
//
// ENVIRONMENT (no secrets here; every value has a safe default):
//   PARTNER_PORTAL_ENABLED   1 / 0. Unset = ON unless NODE_ENV=production.
//   PARTNER_IDLE_MINUTES     30   sliding idle timeout
//   PARTNER_SESSION_MAX_HOURS 12  absolute session length
//   PARTNER_LOCK_MINUTES     30   lock after 5 wrong passwords (auto-unlock)
//   PARTNER_MAX_FAILED_LOGINS 5
//   PARTNER_TEMP_PASSWORD_DAYS 7  an unused temporary password expires
//   PARTNER_UPLOAD_MAX_MB    10   per file (resume, agreement, partner invoice)
//   PARTNER_PORTAL_ORIGINS   comma list of browser origins allowed to call
//                            /api/partner-portal (default APP_BASE_URL + the
//                            local dev / sandbox frontends)
//   PARTNER_JWT_SECRET       optional; default derived from JWT_SECRET
//
// SETTINGS (AppSetting 'partners.settings', Administration → Company Setup →
// Partners → Settings): emailsEnabled — the "Partner emails" switch, OFF by
// default. While OFF the app sends no partner email; in-portal notices still
// go out.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

function portalEnabled() {
  const raw = String(process.env.PARTNER_PORTAL_ENABLED ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return process.env.NODE_ENV !== 'production';
}

const CFG = {
  get idleMinutes() { return num(process.env.PARTNER_IDLE_MINUTES, 30); },
  get maxHours() { return num(process.env.PARTNER_SESSION_MAX_HOURS, 12); },
  get lockMinutes() { return num(process.env.PARTNER_LOCK_MINUTES, 30); },
  get maxFailed() { return num(process.env.PARTNER_MAX_FAILED_LOGINS, 5); },
  get tempPasswordDays() { return num(process.env.PARTNER_TEMP_PASSWORD_DAYS, 7); },
  get uploadMaxBytes() { return num(process.env.PARTNER_UPLOAD_MAX_MB, 10) * 1024 * 1024; },
};

function allowedOrigins() {
  const list = String(process.env.PARTNER_PORTAL_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (list.length) return list;
  const base = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  return [...new Set([base, 'http://localhost:5183', 'http://localhost:5184', 'http://127.0.0.1:5183', 'http://127.0.0.1:5184'].filter(Boolean))];
}

// ---- password policy (partner logins only) ----------------------------------
const PW_MIN = 10;
function partnerPasswordProblem(pw, { email, name } = {}) {
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
const pushHistory = (raw, oldHash) => JSON.stringify([oldHash, ...parseHistory(raw)].filter(Boolean).slice(0, HISTORY_KEEP));

// ---- settings ---------------------------------------------------------------
const SETTINGS_KEY = 'partners.settings';
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
async function sendPartnerEmail({ to, subject, text }) {
  const s = await loadSettings();
  if (!s.emailsEnabled) return { sent: false, reason: 'Partner emails are switched off' };
  if (!to) return { sent: false, reason: 'no address' };
  let r;
  try { r = await require('./mailer').sendMail({ to, subject, text, useEmployeeFrom: false }); } catch (e) { r = { ok: false, error: e.message }; } // eslint-disable-line global-require
  try {
    await prisma.notification.create({
      data: {
        userId: null, title: String(subject || '').slice(0, 190), message: r.ok ? 'Email sent' : `Email not sent: ${String(r.error || '').slice(0, 300)}`,
        channel: 'Email', recipient: String(to || '').slice(0, 190), status: r.ok ? 'Sent' : 'Failed', read: true,
      },
    });
  } catch { /* the log never breaks the action */ }
  return { sent: !!r.ok, reason: r.ok ? null : (r.error || 'not sent') };
}

function requestMeta(req) {
  let ip = 'unknown';
  try { ip = require('./publicRateLimit').ipOf(req); } catch { /* keep unknown */ } // eslint-disable-line global-require
  return { ip: String(ip).slice(0, 60), userAgent: String((req && req.headers && req.headers['user-agent']) || '').slice(0, 300) || null };
}

module.exports = {
  portalEnabled, CFG, allowedOrigins, partnerPasswordProblem, PW_MIN, pushHistory, parseHistory, HISTORY_KEEP,
  loadSettings, saveSettings, sendPartnerEmail, requestMeta, SETTINGS_KEY,
};
