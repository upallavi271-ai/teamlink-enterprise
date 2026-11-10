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
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const PORTAL = '/integrations/teamlink/whatsapp/primary';
const PORTAL_EMAIL = '/integrations/teamlink/email/config';
const PORTAL_SMS = '/integrations/teamlink/sms/relay';
const bridge = () => require('./jobPortalBridge'); // eslint-disable-line global-require
const isSandbox = () => require('./sandbox').isSandbox(); // eslint-disable-line global-require

let last = { fingerprint: '', pid: null, at: null, ok: null, error: null };
let lastEmail = { fingerprint: '', pid: null, at: null, ok: null, error: null };
let lastSms = { pid: null, at: null, ok: null, error: null };

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

// Hands the number to the portal when it has changed, or when the portal has started again (its pid changed). Never throws.
async function pushWhatsapp({ force = false } = {}) {
  if (isSandbox()) return { skipped: 'sandbox' };
  try {
    const cfg = await whatsappSource();
    if (!cfg || !cfg.configured || !cfg.token || !cfg.phoneId) return { skipped: 'TeamLink has no working WhatsApp number', configured: false };
    const fp = fingerprintOf(cfg);
    const now = await bridge().portalFetch(PORTAL, { timeoutMs: 8000 });
    if (!force && last.fingerprint === fp && now && now.pid === last.pid && now.configured) return { unchanged: true, configured: true };
    const out = await bridge().portalFetch(PORTAL, { method: 'POST', body: { accessToken: cfg.token, phoneNumberId: cfg.phoneId, businessId: cfg.wabaId || undefined }, timeoutMs: 10000 });
    last = { fingerprint: fp, pid: out.pid, at: new Date().toISOString(), ok: true, error: null };
    return { pushed: true, configured: !!out.configured, phoneNumberId: out.phoneNumberId };
  } catch (err) {
    last = { ...last, ok: false, error: String((err && err.message) || err).slice(0, 200), at: new Date().toISOString() };
    return { error: last.error };
  }
}

// TeamLink's Email (SMTP) account becomes the portal's SMTP. Never throws.
async function pushEmail({ force = false } = {}) {
  if (isSandbox()) return { skipped: 'sandbox' };
  try {
    const cfg = await require('./mailer').emailConfig(); // eslint-disable-line global-require
    if (!cfg || !cfg.configured || !cfg.host || !cfg.fromAddress) return { skipped: 'TeamLink has no working email account', configured: false };
    const fp = crypto.createHash('sha256').update([cfg.host, cfg.port, cfg.user, cfg.pass, cfg.fromAddress, cfg.fromName, cfg.secure].join('|')).digest('hex').slice(0, 16);
    const now = await bridge().portalFetch(PORTAL_EMAIL, { timeoutMs: 8000 });
    if (!force && lastEmail.fingerprint === fp && now && now.pid === lastEmail.pid && now.configured) return { unchanged: true, configured: true };
    const body = { host: cfg.host, port: cfg.port, secure: !!cfg.secure, encryption: cfg.allowInsecure ? 'None' : (cfg.secure ? 'SSL' : 'STARTTLS'), user: cfg.user, pass: cfg.pass, fromAddress: cfg.fromAddress, fromName: cfg.fromName };
    const out = await bridge().portalFetch(PORTAL_EMAIL, { method: 'POST', body, timeoutMs: 10000 });
    lastEmail = { fingerprint: fp, pid: out.pid, at: new Date().toISOString(), ok: true, error: null };
    return { pushed: true, configured: !!out.configured, host: out.host };
  } catch (err) {
    lastEmail = { ...lastEmail, ok: false, error: String((err && err.message) || err).slice(0, 200), at: new Date().toISOString() };
    return { error: lastEmail.error };
  }
}

// The portal hands its SMS to TeamLink's SMS channel (the portal cannot speak the SMS Push Platform). Never throws.
async function pushSms({ force = false } = {}) {
  if (isSandbox()) return { skipped: 'sandbox' };
  try {
    const now = await bridge().portalFetch(PORTAL_SMS, { timeoutMs: 8000 });
    if (!force && now && now.relay && now.pid === lastSms.pid) return { unchanged: true, relay: true };
    const out = await bridge().portalFetch(PORTAL_SMS, { method: 'POST', body: { on: true }, timeoutMs: 8000 });
    lastSms = { pid: out.pid, at: new Date().toISOString(), ok: !!out.relay, error: null };
    return { pushed: true, relay: !!out.relay };
  } catch (err) {
    lastSms = { ...lastSms, ok: false, error: String((err && err.message) || err).slice(0, 200), at: new Date().toISOString() };
    return { error: lastSms.error };
  }
}

const pushAll = async (o = {}) => ({ whatsapp: await pushWhatsapp(o), email: await pushEmail(o), sms: await pushSms(o) });

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
  // mail in that gap failed as "not configured". Each tick is three small local checks; a push happens only when the portal restarted
  // (its pid changed) or a setting changed. One tick at a time.
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

module.exports = { pushWhatsapp, pushEmail, pushSms, pushAll, snapshot, startSchedule, fingerprintOf };
