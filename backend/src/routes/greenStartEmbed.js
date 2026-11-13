// ---------------------------------------------------------------------------
// /api/omni-gs : the small TeamLink side of Green Start (utils/greenStartEmbed.js; Green Start itself lives in green-start-app/).
//   GET  /status   per-part state (database, Redis, server, worker, entrance) and the state words, from utils/greenStartSupervisor.js
//   POST /start /stop /restart /backup, GET /log   Admin / Super Admin only, rate limited, each press is an audit row
//   POST /session  signs this browser in to the Green Start gate (one signed HttpOnly cookie, 2 hours).
// Needs a normal TeamLink login AND the Omni-Channel permission AND a role that may see real contact details (outreach/access.js mayGreenStart).
// Reads nothing from the TeamLink database; the only write is the audit row of an Admin's button press. (GET /verify, used by the gate, is answered in utils/greenStartEmbed.js proxy(), ahead of this.)
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const A = require('../outreach/access');
const G = require('../utils/greenStartEmbed');
const Sup = require('../utils/greenStartSupervisor');
const { makeLimiter } = require('../utils/apiRateLimit');
const { logAudit } = require('../utils/audit');
const clientIp = require('../utils/clientIp');

const router = express.Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  try { await A.warm(); } catch { /* keep the last list */ }
  if (!A.mayGreenStart(req.user)) return res.status(403).json({ error: 'Green Start is not switched on for your kind of login. An Admin can switch it on in Administration > Integrations > Omni-Channel.' });
  return next();
});

router.get('/status', async (req, res) => {
  try {
    const st = await G.status();
    res.set('Cache-Control', 'no-store').json({ ...st, canControl: A.isAdmin(req.user) });
  } catch { res.status(500).json({ error: 'Could not check Green Start.' }); }
});

// ---- Admin / Super Admin only: Start, Stop, Restart, Show log, Backup now ------------------------------------------------------------
// Rate limited (GREENSTART_CONTROL_RATE per minute per login, default 6) and every press is written to the audit trail.
const limiter = makeLimiter({ userMax: Number(process.env.GREENSTART_CONTROL_RATE) || 6, windowMs: 60000 });
const adminOnly = (req, res, next) => (A.isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin or Super Admin can do this.' }));
function limited(req, res, next) {
  const over = limiter.check({ method: req.method, path: '/omni-gs-control', userId: String(req.user.id || 'u'), ip: clientIp.ipOf(req) });
  if (!over) return next();
  res.set('Retry-After', String(over.retryAfter));
  return res.status(429).json({ error: `Too many button presses. Please wait ${over.retryAfter} second${over.retryAfter === 1 ? '' : 's'}.`, retryAfter: over.retryAfter });
}
const WORDS = { start: 'Start', stop: 'Stop', restart: 'Restart', backup: 'Backup now' };
Object.keys(WORDS).forEach((action) => {
  router.post(`/${action}`, adminOnly, limited, async (req, res) => {
    let r;
    try { r = await Sup.control(action); } catch (e) { r = { ok: false, error: 'Something went wrong.' }; }
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: `Green Start: ${WORDS[action]}`, entity: 'GreenStart', entityId: 'supervisor',
      toValue: r.ok ? (r.message || r.file || 'done') : String(r.error || 'refused').slice(0, 200),
    });
    return res.status(r.ok ? 200 : 409).set('Cache-Control', 'no-store').json(r);
  });
});
router.get('/log', adminOnly, limited, (req, res) => {
  const part = String(req.query.part || 'supervisor').toLowerCase();
  const out = Sup.readLog(part, Number(req.query.lines) || 80);
  if (out.error) return res.status(400).json({ error: out.error });
  return res.set('Cache-Control', 'no-store').json(out); // lines are scrubbed: no emails, tokens, passwords, keys
});

// ---- OPEN GREEN START WITHOUT ITS LOGIN PAGE (founder 2026-10-26: "login page remove cheyyu, direct ga omnichannel open cheyyi";
// asked, he chose ONE company account for everybody) ------------------------------------------------------------------------
// Green Start's own one-click sign-in from TeamLink (green-start-app/docs/integrations/TEAMLINK_SSO.md): a signed, single-use,
// 60-second ticket for the company's Green Start account. Needs GREENSTART_SSO_SECRET here (the same value as Green Start's
// TEAMLINK_SSO_SECRET) and the company account's email (Admin sets it below; GREENSTART_SSO_EMAIL as the default). Missing either
// = the frame shows Green Start's own login page, exactly as before. Every open is an audit row with who opened it.
const prisma = require('../db');
const { SSO_EMAIL_KEY, EMAIL_RE, ssoEmail, greenStartTicket } = require('../utils/greenStartSso');

// BY DEPARTMENT (founder 2026-11-02, utils/omniDeptLogins.js): Super Admin / Admin / developer open with their own email, seeing every workspace; everybody
// else opens their department's own login, a member of only their department workspace (their WhatsApp number, its replies, their
// campaigns). No department login yet = no ticket, with the reason (never the company account).
router.post('/sso-ticket', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const secret = String(process.env.GREENSTART_SSO_SECRET || '');
  if (secret.length < 32) return res.json({ ticket: null, reason: 'One-click sign-in is not set up on this server (GREENSTART_SSO_SECRET).' });
  const company = await ssoEmail();
  if (!EMAIL_RE.test(company)) return res.json({ ticket: null, reason: 'An Admin has not picked the company Green Start account yet (Omni-Channel → Manage).' });
  const who = await require('../utils/omniDeptLogins').loginFor(req.user); // eslint-disable-line global-require
  if (who.blocked) return res.json({ ticket: null, blocked: true, reason: who.reason });
  const email = who.email;
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: who.own ? `Opened Omni-Channel (Green Start) as ${who.email}` : who.all ? `Opened Omni-Channel (Green Start) with the company account${who.ownFailed ? ` (own email refused: ${who.ownFailed})` : ''}` : `Opened Omni-Channel (Green Start) as ${who.dept}`, entity: 'GreenStart', toValue: email }).catch(() => {});
  return res.json({ ticket: greenStartTicket({ email, name: who.own ? (req.user.name || 'TeamLink') : who.all ? 'TeamLink' : `TeamLink ${who.dept}`, externalUserId: req.user.id }), next: '/app', ...(who.all ? {} : { department: who.dept, workspace: who.workspace }) });
});
// the departments' Omni-Channel workspaces and logins (Integrations > Omni-Channel), and "Set up department logins now"
router.get('/departments', adminOnly, async (req, res) => {
  const st = await require('../utils/omniDeptLogins').last(); // eslint-disable-line global-require
  // the last run's rows (ready ones, failures, numbers with several departments); before any run, the stored logins
  res.set('Cache-Control', 'no-store').json({ last: st.last || null, departments: (st.last && st.last.rows) || Object.values(st.departments || {}) });
});
router.post('/departments/run', adminOnly, async (req, res) => {
  const r = await require('../utils/omniDeptLogins').run({ why: `${req.user.name || 'Admin'} pressed Set up now` }); // eslint-disable-line global-require
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel department logins set up', entity: 'GreenStart', entityId: 'departments', toValue: String(r.words).slice(0, 480) }).catch(() => {});
  res.set('Cache-Control', 'no-store').json(r);
});
router.get('/sso-settings', adminOnly, async (req, res) => {
  res.json({ email: await ssoEmail(), secretSet: String(process.env.GREENSTART_SSO_SECRET || '').length >= 32 });
});
router.put('/sso-settings', adminOnly, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'That is not an email address.' });
  const value = JSON.stringify(email);
  await prisma.appSetting.upsert({ where: { key: SSO_EMAIL_KEY }, create: { key: SSO_EMAIL_KEY, value }, update: { value } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel company Green Start account set', entity: 'AppSetting', entityId: SSO_EMAIL_KEY, toValue: email || '(none - login page)' });
  res.json({ email });
});

// ---- WHO OPENS OMNI-CHANNEL THE GREEN START WAY (Admin only; founder 2026-11-13) ---------------------------------------------------------------
// A login whose kind is switched on here opens Green Start in its own tab as its DEPARTMENT's login (Green Start's "Team Leader" role: campaigns, conversations, templates, customers;
// no integrations, billing or workspace settings), seeing only its department's workspace. A login whose kind is off, or whose department has no ready Omni-Channel login yet,
// keeps the native Omni-Channel pages. Admin / Super Admin always open Green Start with every workspace.
const GS_ACCESS_KEY = 'omni.gsAccess';
const accessView = () => {
  const on = A.gsKindsNow();
  return {
    kinds: A.GS_KINDS.map((k) => ({ kind: k, words: A.KIND_WORDS[k], on: on.includes(k), masked: A.RULES.masked.includes(k) })),
    role: 'Green Start\'s "Team Leader" role in the person\'s department workspace: campaigns, conversations, templates and customers; no integrations, billing or workspace settings.',
  };
};
router.get('/access', adminOnly, (req, res) => res.set('Cache-Control', 'no-store').json(accessView()));
router.put('/access', adminOnly, async (req, res) => {
  const given = Array.isArray(req.body && req.body.kinds) ? req.body.kinds.map(String) : null;
  if (!given || given.some((k) => !A.GS_KINDS.includes(k))) return res.status(400).json({ error: 'Pick from the list of kinds of login.' });
  const kinds = A.GS_KINDS.filter((k) => given.includes(k));
  const value = JSON.stringify({ kinds });
  const before = A.gsKindsNow().slice();
  await prisma.appSetting.upsert({ where: { key: GS_ACCESS_KEY }, create: { key: GS_ACCESS_KEY, value }, update: { value } });
  A.setGsKinds(kinds);
  const words = (list) => (list.length ? list.map((k) => A.KIND_WORDS[k]).join(', ') : 'nobody but Admin');
  if (before.join() !== kinds.join()) await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel: who opens Green Start changed', entity: 'OmniGsAccess', entityId: 'kinds', fromValue: words(before).slice(0, 400), toValue: words(kinds).slice(0, 400) });
  return res.set('Cache-Control', 'no-store').json({ ok: 'Saved.', ...accessView() });
});
// a name search for the check below (Admin only; names and role words, nothing else)
router.get('/access/people', adminOnly, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ people: [] });
  const rows = await prisma.user.findMany({ where: { status: 'Active', name: { contains: q }, NOT: { email: { contains: 'example.test' } } }, select: { id: true, name: true, atsRole: true, atsDepartment: true, role: true }, take: 12 });
  return res.json({ people: rows.map((r) => ({ id: r.id, name: r.name, role: r.atsRole || r.role, department: r.atsDepartment || '' })) });
});
// "Why does this person see this?": plain words about ONE login (nothing is changed)
router.get('/access/check', adminOnly, async (req, res) => {
  const id = String(req.query.userId || '');
  const u = id ? await prisma.user.findUnique({ where: { id }, select: { id: true, name: true } }).catch(() => null) : null;
  if (!u) return res.status(404).json({ error: 'That person was not found.' });
  let ident = null;
  try { ident = await require('../utils/identity').resolveIdentity(u.id); } catch { ident = null; } // eslint-disable-line global-require
  if (!ident) return res.status(404).json({ error: 'That login could not be read.' });
  const k = A.kind(ident);
  const out = { name: u.name, kind: k, kindWords: A.KIND_WORDS[k] || (k === 'none' ? 'No Omni-Channel role' : k) };
  if (!A.mayUse(ident)) return res.json({ ...out, opens: 'nothing', why: 'This login has no Omni-Channel access at all.' });
  if (A.isAdmin(ident)) return res.json({ ...out, opens: 'green-start', why: 'Super Admin / Admin always open Green Start with every department.' });
  if (!A.mayGreenStart(ident)) return res.json({ ...out, opens: 'native', why: `${out.kindWords} is not switched on for Green Start above, so this person sees the native Omni-Channel pages. Tick it to change that.` });
  const who = await require('../utils/omniDeptLogins').loginFor(ident).catch(() => null); // eslint-disable-line global-require
  if (!who || who.blocked) return res.json({ ...out, opens: 'native', why: `${out.kindWords} is switched on, but ${who && who.reason ? who.reason : 'this person has no Omni-Channel login yet'} Until then this person sees the native Omni-Channel pages.` });
  return res.json({ ...out, opens: 'green-start', department: who.dept || '', why: `Opens Green Start in its own tab as the ${who.dept || 'department'} login: only that department's workspace, with the "Team Leader" role (no integrations, billing or workspace settings).` });
});

router.post('/session', (req, res) => {
  if (!G.enabled()) return res.status(404).json({ error: 'Green Start is switched off on this server (GREENSTART_ENABLED).' });
  G.issueCookies(req, res, String(req.user.id || req.user.userId || 'u').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'u');
  return res.set('Cache-Control', 'no-store').json({ ok: true, port: G.gatePort() });
});

require('../utils/omniDeptLogins').start(); // eslint-disable-line global-require -- hourly; not in the sandbox
module.exports = router;
