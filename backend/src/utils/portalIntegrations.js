// ---------------------------------------------------------------------------
// THE JOB PORTAL USES TEAMLINK'S INTEGRATIONS, BY ITSELF (founder 2026-11-02: "job portal loo kudaa ee social media accounts and whtsapp anii
// same undalii integrations loo unnaa anii social media platforms undalii ... intergrate avalii job portal loo ki automatic gaa ... even ai calling").
//
//   WhatsApp      TeamLink's default WhatsApp number (Administration -> Integrations -> WhatsApp) is handed to the portal as ITS primary
//                 number (bridge POST .../whatsapp/primary), so what the portal sends (candidate logins, interview invitations, status
//                 messages) leaves from the same company number. The token goes to the portal's memory only, never to a screen, and is sent
//                 again after every portal restart and whenever the number changes (a check every 2 minutes compares a fingerprint).
//   Social media  the accounts of Integrations -> Social Media (Facebook Pages, Instagram, Threads, LinkedIn, YouTube, X). The portal has no social
//                 posting of its own: TeamLink publishes a portal job to them (jobPublish, ticked in the Post step). The portal settings screen
//                 shows the SAME list, read-only, so nothing is entered twice (snapshot()).
//   AI calling    TeamLink's self-hosted AI calling (Ollama + Asterisk / Synway). The portal's recruiters use it through TeamLink's own routes
//                 (routes/aiCalling.js /portal door), so its status is shown beside the others (snapshot()).
// Nothing secret is ever in snapshot().
//
// HOW THE VALUES REACH THE PORTAL (2026-11-23, founder: "Do the integrations in CRM and in the Job Portal ... Administration > Integrations").
//   The portal is a separate process on this machine (utils/jobPortalEmbed.js starts it). It ASKS for the values when it sends (at most once
//   a minute, and when nudged): GET /api/public/job-portal/integrations (routes/jobPortalBridge.js), answered only to a request from this
//   machine (127.0.0.1, no proxy headers) with the bridge secret, else 404. valuesForPortal() below is the in-process function behind it.
//   The portal keeps them in memory only (job_portal-main/api/src/notify/host-integrations.js) and uses them only for a channel its own
//   administrator has NOT connected (a channel connected in the portal always wins). Nothing secret is pushed any more: the tick below only
//   nudges the portal to ask again when a value changed or the portal restarted. Email -> the SMTP fields; WhatsApp -> the number TeamLink
//   sends from + its bulk / OTP template names and language; SMS -> TeamLink's gateway sends each portal SMS (no key leaves TeamLink);
//   AI -> the AI Assistant (Claude) key, only when the portal has no AI_API_KEY of its own (the portal's AI speaks Anthropic only).
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const PORTAL = '/integrations/teamlink/whatsapp/primary';
const PORTAL_REFRESH = '/integrations/teamlink/integrations/refresh';
const PORTAL_EMAIL = '/integrations/teamlink/email/config';
const PORTAL_SMS = '/integrations/teamlink/sms/relay';
const bridge = () => require('./jobPortalBridge'); // eslint-disable-line global-require
const isSandbox = () => require('./sandbox').isSandbox(); // eslint-disable-line global-require

let last = { fingerprint: '', pid: null, at: null, ok: null, error: null };

// The number TeamLink itself sends from: the list's default number, else the single old connection.
async function whatsappSource() {
  const WN = require('./waNumbers'); // eslint-disable-line global-require
  const wa = require('./whatsappCloud'); // eslint-disable-line global-require
  let cfg = null;
  try { if (await WN.hasNumbers()) cfg = await WN.defaultConfig(); } catch { cfg = null; }
  if (!cfg) cfg = await wa.legacyConfig();
  return cfg;
}

const fingerprintOf = (cfg) => crypto.createHash('sha256').update(`${cfg.phoneId}|${cfg.token}|${cfg.wabaId || ''}`).digest('hex').slice(0, 16);

// THE IN-PROCESS FUNCTION: TeamLink's Integrations, decrypted, in the shape the portal's channel overlay reads. Only what is configured AND
// switched on; a channel that is not ready is left out (the portal then keeps its own / environment settings). Never logged; the only
// caller outside this file is the localhost-only route for the portal process. Never throws.
async function valuesForPortal() {
  const out = {};
  try {
    const e = await require('./mailer').emailConfig(); // eslint-disable-line global-require
    if (e && e.configured && e.host && e.fromAddress) {
      out.email = { host: e.host, port: e.port, encryption: e.allowInsecure ? 'None' : (e.secure ? 'SSL' : 'STARTTLS'), user: e.user || '', pass: e.pass || '', fromAddress: e.fromAddress, fromName: e.fromName || '' };
    }
  } catch { /* left out */ }
  try {
    const w = await whatsappSource();
    if (w && w.configured && w.token && w.phoneId) {
      const t = w.templates || {};
      // bulk: ONE {{1}} = the whole message, and otp: {{1}} = the code - the same contract on both sides. TeamLink's "agreement link"
      // template has its own blanks, so it is not given to the portal's agreement messages.
      out.whatsapp = { accessToken: w.token, phoneNumberId: w.phoneId, businessId: w.wabaId || '', language: w.language || 'en', templateBulk: t.bulk || '', templateOtp: t.otp || '' };
    }
  } catch { /* left out */ }
  try {
    const c = await require('./smsGateway').smsConfig(); // eslint-disable-line global-require
    if (c && c.configured) out.sms = { relay: true };
  } catch { /* left out */ }
  try {
    const a = await require('./aiAgent').agentConfig(); // eslint-disable-line global-require
    if (a && a.configured && a.apiKey) out.ai = { apiKey: a.apiKey };
  } catch { /* left out */ }
  return out;
}

const fingerprintOfValues = (v) => crypto.createHash('sha256').update(JSON.stringify(v || {})).digest('hex').slice(0, 16);

// Nudges the portal to ask again when a value changed or the portal started again (its pid changed). No value is sent. Never throws.
async function nudge({ force = false } = {}) {
  if (isSandbox()) return { skipped: 'sandbox' };
  try {
    const fp = fingerprintOfValues(await valuesForPortal());
    const now = await bridge().portalFetch(PORTAL_REFRESH, { timeoutMs: 8000 });
    if (!force && last.fingerprint === fp && now && now.pid === last.pid) return { unchanged: true, state: now };
    const out = await bridge().portalFetch(PORTAL_REFRESH, { method: 'POST', body: {}, timeoutMs: 15000 });
    last = { fingerprint: fp, pid: out && out.pid, at: new Date().toISOString(), ok: !(out && out.error), error: (out && out.error) || null };
    return { pushed: true, state: out };
  } catch (err) {
    last = { ...last, ok: false, error: String((err && err.message) || err).slice(0, 200), at: new Date().toISOString() };
    return { error: last.error };
  }
}

// One channel's line of the nudge, in the shape the Integrations screen already shows (pushed / unchanged / skipped / error).
const lineOf = (r, ch) => {
  if (r.error) return { error: r.error };
  if (r.skipped) return { skipped: r.skipped };
  const inUse = !!(r.state && r.state.inUse && r.state.inUse[ch]);
  const own = !!(r.state && r.state.own && r.state.own[ch]);
  return { ...(r.pushed ? { pushed: true } : { unchanged: true }), inUse, own, configured: inUse || own };
};
const pushAll = async (o = {}) => {
  const r = await nudge(o);
  return { whatsapp: lineOf(r, 'whatsapp'), email: lineOf(r, 'email'), sms: lineOf(r, 'sms'), ai: lineOf(r, 'ai') };
};
// the older names (the Integrations screen's "Sync now", tests)
const pushWhatsapp = async (o) => (await pushAll(o)).whatsapp;
const pushEmail = async (o) => (await pushAll(o)).email;
const pushSms = async (o) => (await pushAll(o)).sms;

// What the portal settings screen shows. No secret.
async function snapshot() {
  const out = { whatsapp: { numbers: [], portal: null }, social: [], aiCalling: null };
  try {
    const WN = require('./waNumbers'); // eslint-disable-line global-require
    const rows = (await WN.hasNumbers()) ? await WN.listRows() : [];
    out.whatsapp.numbers = rows.filter((r) => !r.removedAt).map((r) => ({ label: r.label, number: r.displayNumber || null, isDefault: !!r.isDefault, active: !!r.active }));
  } catch { /* none */ }
  try {
    const cfg = await whatsappSource();
    out.whatsapp.sendsFrom = cfg && cfg.configured ? { number: cfg.display || null, phoneNumberId: cfg.phoneId ? `…${String(cfg.phoneId).slice(-4)}` : null } : null;
    out.whatsapp.problem = cfg && !cfg.configured ? cfg.reason : null;
  } catch { /* none */ }
  try { out.whatsapp.portal = await bridge().portalFetch(PORTAL, { timeoutMs: 6000 }); } catch (e) { out.whatsapp.portal = { error: String((e && e.message) || e).slice(0, 160) }; }
  out.whatsapp.lastPush = { at: last.at, ok: last.ok, error: last.error };
  // which of the portal's channels use TeamLink's Integrations now, and which the portal connected itself (no value)
  try { out.bridge = await bridge().portalFetch(PORTAL_REFRESH, { timeoutMs: 6000 }); } catch (e) { out.bridge = { error: String((e && e.message) || e).slice(0, 160) }; }
  out.email = { teamlink: null, portal: null };
  try { const e = await require('./mailer').emailConfig(); out.email.teamlink = e.configured ? { host: e.host, from: e.fromAddress } : { problem: e.reason }; } catch { /* none */ } // eslint-disable-line global-require
  try { out.email.portal = await bridge().portalFetch(PORTAL_EMAIL, { timeoutMs: 6000 }); } catch (e) { out.email.portal = { error: String((e && e.message) || e).slice(0, 160) }; }
  out.sms = { teamlink: null, portal: null };
  try { const c = await require('./smsGateway').smsConfig(); out.sms.teamlink = c.configured ? { provider: c.provider || null } : { problem: c.reason }; } catch { /* none */ } // eslint-disable-line global-require
  try { out.sms.portal = await bridge().portalFetch(PORTAL_SMS, { timeoutMs: 6000 }); } catch (e) { out.sms.portal = { error: String((e && e.message) || e).slice(0, 160) }; }
  try {
    const SA = require('./socialAccounts'); // eslint-disable-line global-require
    const all = await SA.list(); // { facebook: [...], instagram: [...], ... }
    out.social = SA.PLATFORMS.map((p) => ({
      platform: p,
      accounts: (all[p] || []).map((x) => ({ name: x.name, username: x.username || null, status: x.status, isDefault: !!x.isDefault })),
    }));
  } catch { out.social = []; }
  try {
    const st = await require('../calling/settings').status(); // eslint-disable-line global-require
    out.aiCalling = { state: st.state, detail: st.detail || null };
  } catch { out.aiCalling = null; }
  return out;
}

let timer = null;
function startSchedule() {
  if (timer || process.env.NODE_ENV === 'test') return;
  // Every 15 s (founder 2026-11-10, Forgot password mails missing): the portal keeps TeamLink's email / WhatsApp / SMS in memory only,
  // so after each portal restart (several a day while TeamLink deploys) it had NO mail account for up to 2 minutes and every reset
  // mail in that gap failed as "not configured". Each tick is one small local check; the portal is nudged to ask again only when it
  // restarted (its pid changed) or a setting changed (2026-11-23: the portal also asks by itself at start, at send time and every minute).
  // One tick at a time.
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    pushAll().catch(() => {}).finally(() => { busy = false; });
  };
  setTimeout(tick, 10 * 1000); // as soon as the portal can answer
  timer = setInterval(tick, 15 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { pushWhatsapp, pushEmail, pushSms, pushAll, snapshot, startSchedule, fingerprintOf, valuesForPortal, fingerprintOfValues };
