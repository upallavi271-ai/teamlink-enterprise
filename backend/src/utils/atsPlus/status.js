// ---------------------------------------------------------------------------
// STATUS PAGE, TRUST CENTRE, UPTIME / SUPPORT SLA (market benchmark 15.12 / 15.16, and the public half of 15.11 / IN-14 and 15.09).
// Public pages at /status, /trust and /sla (frontend/src/pages/public/TrustPages.jsx), data from:
//
//   GET /api/public/status          live check (the API answers, the database answers and how fast) + uptime for 24 h / 7 / 30 / 90 days
//                                   from the health samples this server takes every 5 minutes (table AtsPlusUptime) + the outages the
//                                   outside health check recorded (scripts/healthcheck.js -> uptime.json). No names, no counts of records.
//   GET /api/public/trust           the security practices this product really has (each one is in the code), where the data is stored,
//                                   the sub-processors, the privacy notice link, and plainly: which certifications are NOT held.
//   GET /api/public/sla             the uptime and support response targets an Admin set, against the measured uptime.
//   GET /api/public/privacy-notice?lang=en|te|hi   the DPDP notice (utils/atsPlus/privacy.js)
//   GET/PUT /api/ats-plus/status/settings   (Admin) the SLA targets, support hours and whether the public pages are on.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../../db');
const { logAudit } = require('../audit');
const S = require('./store');

const SET_KEY = 'statusPages';
const DEFAULTS = {
  public: true, uptimeTarget: 99.5, supportHours: 'Monday to Saturday, 9:30 am to 6:30 pm IST', supportEmail: '', supportPhone: '',
  response: { P1: '2 hours', P2: '8 working hours', P3: '2 working days' }, credits: '',
};
async function settings() { const s = await S.settings.get(SET_KEY, DEFAULTS); return { ...DEFAULTS, ...s, response: { ...DEFAULTS.response, ...(s.response || {}) } }; }

async function sample() {
  await S.ensure();
  const t0 = Date.now(); let ok = 1; let note = null;
  try { await prisma.$queryRawUnsafe('SELECT 1'); } catch (e) { ok = 0; note = String(e.message).slice(0, 120); }
  const ms = Date.now() - t0;
  await prisma.$executeRawUnsafe('INSERT OR REPLACE INTO "AtsPlusUptime" ("at","ok","ms","note") VALUES (?,?,?,?)', new Date().toISOString(), ok, ms, note).catch(() => null);
  await prisma.$executeRawUnsafe('DELETE FROM "AtsPlusUptime" WHERE "at" < ?', new Date(Date.now() - 120 * 86400000).toISOString()).catch(() => null);
  return { ok: !!ok, ms };
}
let timer = null;
function startSampler() {
  if (timer || S.sandbox()) return;
  sample().catch(() => null);
  timer = setInterval(() => { sample().catch(() => null); }, 5 * 60000);
  if (timer.unref) timer.unref();
}
function outages() {
  try { const s = require('../uptimeAlert').readState() || {}; return { history: (s.history || []).map((o) => ({ since: o.since, upAt: o.upAt })), down: s.down ? { since: s.down.since } : null, lastCheckAt: s.lastCheckAt || null }; } catch { return { history: [], down: null, lastCheckAt: null }; } // eslint-disable-line global-require
}
// uptime % over a window: samples (5-minute slots) minus outage minutes from the outside check
async function uptime(days) {
  await S.ensure();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await prisma.$queryRawUnsafe('SELECT "at","ok","ms" FROM "AtsPlusUptime" WHERE "at" >= ? ORDER BY "at"', since);
  const o = outages();
  const windowMs = days * 86400000;
  const downMs = [...o.history, ...(o.down ? [{ since: o.down.since, upAt: new Date().toISOString() }] : [])].reduce((a, x) => {
    const s = Math.max(new Date(x.since).getTime(), Date.now() - windowMs); const e = new Date(x.upAt).getTime();
    return e > s ? a + (e - s) : a;
  }, 0);
  const failed = rows.filter((r) => !Number(r.ok)).length;
  const sampleDown = failed * 5 * 60000;
  const measuredFrom = rows.length ? rows[0].at : null;
  const covered = measuredFrom ? Math.min(windowMs, Date.now() - new Date(measuredFrom).getTime()) : 0;
  const pct = covered > 0 ? Math.max(0, Math.round((1 - Math.max(downMs, sampleDown) / Math.max(covered, 1)) * 100000) / 1000) : null;
  const avgMs = rows.length ? Math.round(rows.reduce((a, r) => a + Number(r.ms || 0), 0) / rows.length) : null;
  return { days, pct, samples: rows.length, measuredFrom, avgMs };
}
async function daily(days = 90) {
  await S.ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT substr("at",1,10) AS d, COUNT(*) AS n, SUM("ok") AS up FROM "AtsPlusUptime" WHERE "at" >= ? GROUP BY d ORDER BY d', new Date(Date.now() - days * 86400000).toISOString());
  return rows.map((r) => ({ day: r.d, pct: Number(r.n) ? Math.round((Number(r.up) / Number(r.n)) * 1000) / 10 : null }));
}

const PRACTICES = [
  ['Sign-in', 'Passwords are stored hashed (bcrypt). Two-step sign-in with an authenticator app can be required for everyone. Logins lock after repeated failures. An idle session signs out.'],
  ['Who sees what', 'Every screen and every answer of the server is cut to the person\'s role, department and team. Client and candidate logins reach only their own portal. Managers can view but not change the ATS.'],
  ['ID numbers', 'Aadhaar numbers are never stored in full - only the last 4 digits. PAN and bank account numbers are encrypted and shown masked; opening one needs a reason and is logged.'],
  ['Secrets', 'Provider keys and passwords of integrations are encrypted with AES-256-GCM; they never leave the server in an answer or a log line.'],
  ['Audit trail', 'Every important change, export, deletion, AI action and opening of a sensitive record is written to the audit log with who, when and why.'],
  ['Network', 'An optional company IP allow-list, rate limits on every public address, security headers on every answer, and HTTPS in production.'],
  ['Backups', 'Regular database backups with a restore check (Administration -> Backups & safety).'],
  ['Privacy (DPDP Act 2023)', 'An itemised privacy notice in English, Telugu and Hindi, a consent log, requests to see / correct / erase data with due dates, legal hold, retention rules and a breach register with the 72-hour clock.'],
  ['AI', 'The AI writes from facts built by the software. Candidate contact details and ID numbers are not sent to an AI model. What the AI did is in the AI activity log.'],
];
const CERTS = [
  ['SOC 2 Type II', 'Not held. SOC 2 is an audit by an outside firm; it cannot be built in software.'],
  ['ISO/IEC 27001', 'Not held. Needs an information security management system audited by a certification body.'],
  ['ISO/IEC 42001 (AI management)', 'Not held.'],
];

const router = express.Router();
router.get('/status/settings', S.internal, S.wrap(async (req, res) => res.json({ ...(await settings()), canEdit: S.isAdmin(req.user) && !req.viewAs, last: await uptime(30) })));
router.put('/status/settings', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {}; const cur = await settings();
  const next = {
    public: 'public' in b ? !!b.public : cur.public,
    uptimeTarget: Math.max(90, Math.min(99.999, Number(b.uptimeTarget) || cur.uptimeTarget)),
    supportHours: String(b.supportHours ?? cur.supportHours).slice(0, 200), supportEmail: String(b.supportEmail ?? cur.supportEmail).slice(0, 120), supportPhone: String(b.supportPhone ?? cur.supportPhone).slice(0, 40),
    response: { ...cur.response, ...Object.fromEntries(Object.entries(b.response || {}).filter(([k]) => ['P1', 'P2', 'P3'].includes(k)).map(([k, v]) => [k, String(v).slice(0, 60)])) },
    credits: String(b.credits ?? cur.credits).slice(0, 1000),
  };
  await S.settings.set(SET_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: 'Status / SLA page settings saved', entity: 'AtsPlusSetting', entityId: SET_KEY, toValue: `target ${next.uptimeTarget}% · public ${next.public}` });
  res.json(next);
}));
router.post('/status/sample', S.adminOnly, S.wrap(async (req, res) => res.json(await sample())));

const pub = express.Router();
const { rateLimit } = require('../publicRateLimit');
pub.use(['/status', '/trust', '/sla', '/privacy-notice'], rateLimit({ bucket: 'status-pages', max: 240, windowMs: 10 * 60000 }));
async function offGuard(res) { const s = await settings(); if (!s.public) { res.status(404).json({ error: 'This page is switched off.' }); return null; } return s; }
pub.get('/status', S.wrap(async (req, res) => {
  if (!(await offGuard(res))) return;
  const live = await sample().catch(() => ({ ok: false, ms: null }));
  const o = outages();
  res.json({
    at: new Date().toISOString(), overall: live.ok && !o.down ? 'All systems working' : 'Some systems have a problem',
    components: [{ name: 'Web app and API', ok: true }, { name: 'Database', ok: live.ok, ms: live.ms }],
    uptime: { day: await uptime(1), week: await uptime(7), month: await uptime(30), quarter: await uptime(90) },
    daily: await daily(90), incidents: o.history.slice(0, 10), lastOutsideCheck: o.lastCheckAt,
  });
}));
pub.get('/trust', S.wrap(async (req, res) => {
  if (!(await offGuard(res))) return;
  const R = await require('./privacy').residency(); // eslint-disable-line global-require
  res.json({
    practices: PRACTICES.map(([title, text]) => ({ title, text })), certifications: CERTS.map(([name, status]) => ({ name, status })),
    residency: { region: R.region, provider: R.provider || null, city: R.city || null, backupLocation: R.backupLocation, backupProvider: R.backupProvider || null, processors: R.processors, confirmedAt: R.confirmedAt || null },
    privacyNotice: '/api/public/privacy-notice', status: '/status', sla: '/sla', month: await uptime(30),
  });
}));
pub.get('/sla', S.wrap(async (req, res) => {
  const s = await offGuard(res); if (!s) return;
  const m = await uptime(30); const q = await uptime(90);
  res.json({ uptimeTarget: s.uptimeTarget, supportHours: s.supportHours, supportEmail: s.supportEmail || null, supportPhone: s.supportPhone || null, response: s.response, credits: s.credits || null, measured: { month: m, quarter: q }, met: m.pct === null ? null : m.pct >= s.uptimeTarget });
}));
pub.get('/privacy-notice', S.wrap(async (req, res) => {
  const PV = require('./privacy'); // eslint-disable-line global-require
  const n = await PV.notice(); const lang = ['en', 'te', 'hi'].includes(req.query.lang) ? req.query.lang : 'en';
  res.json({ version: n.version, lang, text: PV.renderNotice(n, lang), purposes: n.purposes, languages: ['en', 'te', 'hi'] });
}));

module.exports = { router, publicRouter: pub, startSampler, sample, uptime, settings };
