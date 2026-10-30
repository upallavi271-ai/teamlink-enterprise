// ---------------------------------------------------------------------------
// ONE SET OF INTEGRATIONS FOR TEAMLINK AND OMNI-CHANNEL (founder 2026-10-30: "omnichannel ki integrations teamlink enterprise lone ve and
// omnichannel lo unna integration teamlink enterprise ve both application is same").
//
// Omni-Channel is Green Start (green-start-app/, its source is never edited): its own server, its own database, its own Integrations
// screen. Until now nothing was shared, so Email, SMS and WhatsApp had to be connected twice. Now:
//
//   TeamLink -> Omni-Channel   Administration > Integrations is the ONE place where Email (SMTP), SMS (SMS Push Platform / MSG91) and
//                              WhatsApp Business (Meta Cloud) are typed. This module puts those same settings into Green Start through
//                              Green Start's OWN API (PUT /integrations/email, PUT /integrations/sms, POST /integrations/whatsapp/credentials),
//                              signed in as the company Green Start account with the one-click ticket (utils/greenStartSso.js), so Green
//                              Start checks and encrypts them itself. Email and SMS go to every workspace of the company account; WhatsApp to
//                              the main workspace (Green Start allows one workspace per WhatsApp number). A channel TeamLink no longer has is
//                              disconnected in Green Start too - only when TeamLink had put it there (Green Start's own connections stay).
//   Omni-Channel -> TeamLink   connections() lists what Green Start has connected (Facebook, Instagram, LinkedIn, Shopify, Google Ads ...) so
//                              Administration > Integrations > Omni-Channel shows them next to TeamLink's own (status only, never a token).
//
// When: right after Email / SMS / WhatsApp is saved, connected or disconnected in Administration > Integrations (schedule()), every hour
// (start()), and on "Send to Omni-Channel now". A setting that did not change is not sent again (a SHA-256 fingerprint is kept per
// workspace and channel - never the value). Nothing here can stop TeamLink: every failure becomes words in the last result.
// Off when Green Start is switched off (GREENSTART_ENABLED=false) or one-click sign-in is not set up (GREENSTART_SSO_SECRET + the company account).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const SSO = require('./greenStartSso');

const STATE_KEY = 'omni.gs.integrationSync';
const LABEL = 'TeamLink - Administration > Integrations';
const apiBase = () => `http://127.0.0.1:${parseInt(process.env.GREENSTART_API_PORT, 10) || 4020}/api/v1`;
const enabled = () => String(process.env.GREENSTART_ENABLED || 'true').toLowerCase() !== 'false';
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

async function readState() {
  try { const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } }); return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function writeState(st) {
  const value = JSON.stringify(st);
  await prisma.appSetting.upsert({ where: { key: STATE_KEY }, update: { value }, create: { key: STATE_KEY, value } });
}

// ---- Green Start's API ----------------------------------------------------------
function wordsOf(body, status) {
  const e = body && (body.error || body);
  const m = (e && (e.message || e.error)) || (body && body.message);
  const text = Array.isArray(m) ? m.join(' ') : (typeof m === 'string' ? m : '');
  return (text || `Omni-Channel answered ${status}`).slice(0, 300);
}
async function call(method, path, { token, ws, body } = {}) {
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ws ? { 'x-workspace-id': ws } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch (err) {
    const e = new Error('Omni-Channel (Green Start) is not running on this server.'); e.down = true; throw e;
  }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok || (data && data.success === false)) { const e = new Error(wordsOf(data, res.status)); e.status = res.status; throw e; }
  // Green Start wraps every answer as { success, data }
  return data && typeof data === 'object' && 'success' in data && 'data' in data ? data.data : data;
}
async function signIn() {
  if (!SSO.secretSet()) throw new Error('One-click sign-in to Omni-Channel is not set up on this server (GREENSTART_SSO_SECRET).');
  const email = await SSO.ssoEmail();
  if (!SSO.EMAIL_RE.test(email)) throw new Error('The company Omni-Channel account is not picked yet (Omni-Channel > Manage).');
  const ticket = SSO.greenStartTicket({ email, name: 'TeamLink', externalUserId: 'teamlink-integrations-sync' });
  let out;
  try { out = await call('POST', '/auth/teamlink', { body: { ticket } }); } catch (err) {
    if (err.status === 404) throw new Error('Omni-Channel has one-click sign-in from TeamLink switched off (its TEAMLINK_SSO_SECRET).');
    throw err;
  }
  if (!out || !out.accessToken) throw new Error('Omni-Channel asked for a second sign-in step for the company account, so TeamLink cannot sign in by itself.');
  return { token: out.accessToken, email };
}
async function workspacesOf(token) {
  const list = await call('GET', '/workspaces', { token });
  const rows = (Array.isArray(list) ? list : (list && list.items) || []).map((w) => ({ id: w.id, name: w.name, createdAt: w.createdAt || '' }));
  return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// ---- TeamLink's own settings, in Green Start's words ----------------------------
async function teamlinkChannels() {
  const out = {};
  try {
    const c = await require('./mailer').emailConfig(); // eslint-disable-line global-require
    if (!c.configured) out.email = { none: c.reason || 'Email is not set up in TeamLink.' };
    else if (!c.user) out.email = { none: 'TeamLink sends email without a username (a relay); Omni-Channel needs a username and password.' };
    else out.email = { body: { host: c.host, port: c.port, secure: !!c.secure, username: c.user, password: c.pass || undefined, from: c.fromAddress, ...(c.fromName ? { fromName: c.fromName } : {}), label: LABEL } };
  } catch (err) { out.email = { none: `Email could not be read: ${err.message}` }; }
  try {
    const c = await require('./smsGateway').smsConfig(); // eslint-disable-line global-require
    if (!c.configured) out.sms = { none: c.reason || 'SMS is not set up in TeamLink.' };
    else if (c.provider === 'SMSGW') out.sms = { body: { gateway: 'smspush', username: c.push.user, authKey: c.push.pass, senderId: c.sender, route: '4', defaultCountryCode: '91', ...(c.push.pe ? { dltEntityId: c.push.pe } : {}), label: LABEL } };
    else if (c.provider === 'MSG91') out.sms = { body: { gateway: 'msg91', authKey: c.key, senderId: c.sender, route: '4', defaultCountryCode: '91', label: LABEL } };
    else out.sms = { none: `Omni-Channel can send SMS through SMS Push Platform or MSG91 only; TeamLink uses ${c.providerLabel || c.provider}.` };
  } catch (err) { out.sms = { none: `SMS could not be read: ${err.message}` }; }
  try {
    const c = await require('./whatsappCloud').whatsappConfig(); // eslint-disable-line global-require
    if (!c.configured) out.whatsapp = { none: c.reason || 'WhatsApp Business is not set up in TeamLink.' };
    else if (c.testMode) out.whatsapp = { none: 'TeamLink\'s WhatsApp is on a test server address; it is not given to Omni-Channel.' };
    else out.whatsapp = { body: { accessToken: c.token, phoneNumberId: c.phoneId, ...(c.wabaId ? { wabaId: c.wabaId } : {}), label: LABEL } };
  } catch (err) { out.whatsapp = { none: `WhatsApp could not be read: ${err.message}` }; }
  return out;
}

// ---- one channel into one workspace -----------------------------------------------
const NAME = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
async function pushOne(token, ws, channel, want, prev, force) {
  if (want.none) {
    if (!prev) return { state: 'skipped', words: want.none };
    // TeamLink had put it there: take it away again (both apps are the same)
    try {
      if (channel === 'whatsapp') {
        const list = await call('GET', '/integrations', { token, ws: ws.id });
        const row = (list || []).find((x) => x.provider === 'whatsapp' && x.id && x.status !== 'DISCONNECTED' && x.status !== 'NOT_CONNECTED');
        if (row) await call('DELETE', `/integrations/${row.id}`, { token, ws: ws.id });
      } else await call('DELETE', `/integrations/${channel}`, { token, ws: ws.id });
      return { state: 'removed', words: `Disconnected in Omni-Channel too (TeamLink: ${want.none})`, fp: null };
    } catch (err) { return { state: 'failed', words: `Could not disconnect it in Omni-Channel: ${err.message}`, fp: prev }; }
  }
  const fp = sha(want.body);
  if (!force && prev === fp) return { state: 'same', words: 'Already the same as TeamLink', fp };
  try {
    if (channel === 'email') await call('PUT', '/integrations/email', { token, ws: ws.id, body: want.body });
    else if (channel === 'sms') await call('PUT', '/integrations/sms', { token, ws: ws.id, body: want.body });
    else await call('POST', '/integrations/whatsapp/credentials', { token, ws: ws.id, body: want.body });
    return { state: 'sent', words: 'Same as TeamLink now', fp };
  } catch (err) { return { state: 'failed', words: err.message, fp: prev }; }
}

// ---- the whole run ----------------------------------------------------------------
let running = null;
async function sync({ force = false, why = 'manual', by = null } = {}) {
  if (running) return running;
  running = (async () => {
    const st = await readState();
    const fps = st.fingerprints || {};
    const result = { at: new Date().toISOString(), why, by, ok: false, words: '', workspaces: [] };
    try {
      if (!enabled()) throw new Error('Omni-Channel (Green Start) is switched off on this server (GREENSTART_ENABLED).');
      const want = await teamlinkChannels();
      const { token, email } = await signIn();
      const wss = await workspacesOf(token);
      if (!wss.length) throw new Error(`The company Omni-Channel account (${email}) has no workspace yet.`);
      result.account = email;
      for (const [i, ws] of wss.entries()) {
        const one = { id: ws.id, name: ws.name, main: i === 0, channels: {} };
        for (const ch of ['email', 'sms', 'whatsapp']) {
          const k = `${ws.id}:${ch}`;
          let r;
          if (ch === 'whatsapp' && i > 0) r = { state: 'skipped', words: `One WhatsApp number can belong to one workspace only: it is in "${wss[0].name}".` };
          else r = await pushOne(token, ws, ch, want[ch], fps[k] || null, force); // eslint-disable-line no-await-in-loop
          if (r.fp) fps[k] = r.fp; else if (r.fp === null) delete fps[k];
          one.channels[ch] = { state: r.state, words: r.words };
        }
        result.workspaces.push(one);
      }
      const bad = result.workspaces.flatMap((w) => Object.entries(w.channels).filter(([, c]) => c.state === 'failed').map(([ch, c]) => `${w.name} ${NAME[ch]}: ${c.words}`));
      result.ok = !bad.length;
      result.words = bad.length ? `Not everything reached Omni-Channel: ${bad.join(' | ')}` : 'Omni-Channel uses the same Email, SMS and WhatsApp as TeamLink.';
    } catch (err) {
      result.words = err.message;
      result.down = !!err.down;
    }
    await writeState({ ...st, fingerprints: fps, last: result }).catch(() => {});
    if (by || !result.ok) {
      try { await require('./audit').logAudit({ userId: null, actorName: by || 'System', action: 'Integrations sent to Omni-Channel', entity: 'Integration', entityId: 'omni-channel', toValue: result.words.slice(0, 480) }); } catch { /* history only */ } // eslint-disable-line global-require
    }
    return result;
  })();
  try { return await running; } finally { running = null; }
}

// What Green Start has connected (all providers), for Administration > Integrations > Omni-Channel. Status only, never a token.
async function connections() {
  const { token, email } = await signIn();
  const wss = await workspacesOf(token);
  const out = [];
  for (const ws of wss) {
    const list = await call('GET', '/integrations', { token, ws: ws.id }); // eslint-disable-line no-await-in-loop
    out.push({
      id: ws.id, name: ws.name,
      items: (list || []).filter((x) => x.status && !['NOT_CONNECTED', 'DISCONNECTED'].includes(x.status)).map((x) => ({ provider: x.provider, label: x.label, category: x.category, status: x.status, account: x.displayName || x.externalAccountId || '', lastError: x.lastError || '' })),
    });
  }
  return { account: email, workspaces: out };
}

let timer = null;
function schedule(why = 'saved') {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; sync({ why }).catch(() => {}); }, 4000);
  if (timer.unref) timer.unref();
}
function start() {
  if (process.env.NODE_ENV === 'test' || require('./sandbox').isSandbox()) return; // eslint-disable-line global-require
  const first = setTimeout(() => sync({ why: 'start' }).catch(() => {}), 90 * 1000);
  const every = setInterval(() => sync({ why: 'hourly' }).catch(() => {}), 60 * 60 * 1000);
  if (first.unref) first.unref();
  if (every.unref) every.unref();
}
async function lastResult() { return (await readState()).last || null; }

module.exports = { sync, connections, schedule, start, lastResult, teamlinkChannels, STATE_KEY };
