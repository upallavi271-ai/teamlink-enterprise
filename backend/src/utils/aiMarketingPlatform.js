// ---------------------------------------------------------------------------
// AI MARKETING PLATFORM (founder 2026-11-09: "settings ahh modules kadhu ... integrate chesukovachu, omnichannel ki direct ga connect avuthundhi").
//
// The outside AI platform that makes the pictures and videos of Omni-Channel > AI Marketing is typed ONCE, here, in
// Administration > Integrations > AI Marketing - like Email, WhatsApp and Social Media. TeamLink keeps it (AppSetting
// omni.aiMarketingPlatform, the key encrypted with utils/secrets.js) and hands it to Green Start's own
// PUT /api/v1/marketing/maker, signed in as the company account (one-click ticket), once per Green Start organisation.
// Green Start checks the address itself (public https only) and keeps the key encrypted too. Test asks Green Start's
// POST /marketing/maker/test, so it tries exactly the road the real work takes. The contract the platform must speak
// is green-start-app gs-api/src/modules/marketing/marketing-maker-rules.ts (also shown on the screen).
// Nothing here sends a message or makes anything public.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const SSO = require('./greenStartSso');
const { encryptSecret, decryptSecret, maskStored } = require('./secrets');

const KEY = 'omni.aiMarketingPlatform';
const KINDS = ['POST', 'STORY', 'BANNER', 'REEL'];
const apiBase = () => `http://127.0.0.1:${parseInt(process.env.GREENSTART_API_PORT, 10) || 4020}/api/v1`;

async function read() {
  try { const row = await prisma.appSetting.findUnique({ where: { key: KEY } }); return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function write(v) {
  const value = JSON.stringify(v);
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
}

// ---- Green Start's API (same road as utils/greenStartIntegrations.js) ----
function wordsOf(body, status) {
  const e = body && (body.error || body);
  const m = (e && (e.message || e.error)) || (body && body.message);
  const text = Array.isArray(m) ? m.join(' ') : (typeof m === 'string' ? m : '');
  return (text || `Omni-Channel answered ${status}`).slice(0, 300);
}
async function call(method, path, { token, ws, body, timeoutMs = 45000 } = {}) {
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ws ? { 'x-workspace-id': ws } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Omni-Channel (Green Start) is not running on this server, or it took too long.');
  }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (res.status === 404 && /marketing\/maker/.test(path)) throw new Error('Omni-Channel on this server is older: it has no AI Marketing platform yet. Update Green Start first.');
  if (!res.ok || (data && data.success === false)) throw new Error(wordsOf(data, res.status));
  return data && typeof data === 'object' && 'success' in data && 'data' in data ? data.data : data;
}
async function signIn() {
  if (String(process.env.GREENSTART_ENABLED || 'true').toLowerCase() === 'false') throw new Error('Omni-Channel (Green Start) is switched off on this server.');
  if (!SSO.secretSet()) throw new Error('One-click sign-in to Omni-Channel is not set up on this server (GREENSTART_SSO_SECRET).');
  const email = await SSO.ssoEmail();
  if (!SSO.EMAIL_RE.test(email)) throw new Error('The company Omni-Channel account is not picked yet (Integrations > Omni-Channel).');
  const ticket = SSO.greenStartTicket({ email, name: 'TeamLink', externalUserId: 'teamlink-integrations-sync' });
  const out = await call('POST', '/auth/teamlink', { body: { ticket } });
  if (!out || !out.accessToken) throw new Error('Omni-Channel asked for a second sign-in step for the company account.');
  return out.accessToken;
}
/** One workspace per Green Start organisation: the platform is kept per organisation there. */
async function oneWorkspacePerOrg(token) {
  const list = await call('GET', '/workspaces', { token });
  const rows = Array.isArray(list) ? list : (list && list.items) || [];
  const seen = new Map();
  rows.forEach((w) => { const org = (w.organization && w.organization.id) || w.organizationId || w.id; if (!seen.has(org)) seen.set(org, { id: w.id, name: w.name }); });
  return [...seen.values()];
}

// ---- the screen ----
async function view() {
  const s = await read();
  return {
    name: s.name || '', endpoint: s.endpoint || '', authHeader: s.authHeader || 'Authorization', authPrefix: s.authPrefix ?? 'Bearer ',
    kinds: s.kinds || [], enabled: !!s.enabled, keySaved: !!s.keyEnc, keyHint: s.keyEnc ? maskStored(s.keyEnc) : '',
    updatedAt: s.updatedAt || null, updatedBy: s.updatedBy || '', sent: s.sent || null, lastTest: s.lastTest || null,
  };
}

function clean(input) {
  const name = String(input.name || '').trim().slice(0, 60);
  const endpoint = String(input.endpoint || '').trim().slice(0, 500);
  const authHeader = String(input.authHeader || 'Authorization').trim();
  const authPrefix = String(input.authPrefix ?? 'Bearer ').slice(0, 30);
  const kinds = [...new Set((Array.isArray(input.kinds) ? input.kinds : []).map((k) => String(k).toUpperCase()).filter((k) => KINDS.includes(k)))];
  const enabled = input.enabled === true || input.enabled === 'true';
  if (name.length < 2) return { error: 'Give the platform a name.' };
  let u;
  try { u = new URL(endpoint); } catch { return { error: 'Paste the full https:// address of the platform.' }; }
  if (u.protocol !== 'https:') return { error: 'The address must start with https:// (the key must not travel unprotected).' };
  if (u.username || u.password) return { error: 'Put the key in the key box, not in the address.' };
  if (!/^[A-Za-z0-9-]{1,60}$/.test(authHeader)) return { error: 'A key header name has only letters, numbers and -.' };
  if (/[\r\n]/.test(authPrefix) || /[\r\n]/.test(String(input.apiKey || ''))) return { error: 'The key must be on one line.' };
  if (enabled && !kinds.length) return { error: 'Tick at least one thing it makes, or keep it off.' };
  return { name, endpoint, authHeader, authPrefix, kinds, enabled };
}

/** Saves, then hands it to Omni-Channel straight away. The answer says whether Omni-Channel took it. */
async function save(input, by) {
  const c = clean(input || {});
  if (c.error) return { error: c.error, status: 400 };
  const prev = await read();
  let keyEnc = prev.keyEnc || '';
  if (input.removeKey) keyEnc = '';
  else if (String(input.apiKey || '').trim()) keyEnc = encryptSecret(String(input.apiKey).trim());
  const next = { ...prev, ...c, keyEnc, updatedAt: new Date().toISOString(), updatedBy: by || '' };
  await write(next);
  const sent = await send(next);
  return { ...(await view()), sent };
}

/** Puts the saved platform into every Omni-Channel organisation. */
async function send(s) {
  const st = s || await read();
  const out = { at: new Date().toISOString(), ok: false, words: '' };
  try {
    if (!st.endpoint) throw new Error('Nothing is saved yet.');
    const key = st.keyEnc ? decryptSecret(st.keyEnc) : '';
    if (st.keyEnc && key === null) throw new Error('The saved key cannot be read with this server\'s secret key. Paste the key again.');
    const token = await signIn();
    const wss = await oneWorkspacePerOrg(token);
    if (!wss.length) throw new Error('The company Omni-Channel account has no workspace yet.');
    const body = {
      name: st.name, endpoint: st.endpoint, authHeader: st.authHeader, authPrefix: st.authPrefix, kinds: st.kinds, enabled: st.enabled,
      ...(key ? { apiKey: key } : { removeKey: true }),
    };
    for (const ws of wss) await call('PUT', '/marketing/maker', { token, ws: ws.id, body }); // eslint-disable-line no-await-in-loop
    out.ok = true;
    out.words = `Omni-Channel AI Marketing now uses ${st.name}${st.enabled ? '' : ' (switched off)'}.`;
  } catch (err) { out.words = err.message; }
  await write({ ...st, sent: out }).catch(() => {});
  return out;
}

/** One small test job through Omni-Channel, exactly the road the real work takes. */
async function test() {
  const st = await read();
  let out;
  try {
    if (!st.endpoint) throw new Error('Save the platform first.');
    if (!st.sent || !st.sent.ok) { const s = await send(st); if (!s.ok) throw new Error(s.words); }
    const token = await signIn();
    const [ws] = await oneWorkspacePerOrg(token);
    if (!ws) throw new Error('The company Omni-Channel account has no workspace yet.');
    const r = await call('POST', '/marketing/maker/test', { token, ws: ws.id, timeoutMs: 13 * 60 * 1000 });
    out = { at: new Date().toISOString(), ok: !!(r && r.ok), words: (r && r.note) || 'No answer.' };
  } catch (err) { out = { at: new Date().toISOString(), ok: false, words: err.message }; }
  await write({ ...(await read()), lastTest: out }).catch(() => {});
  return out;
}

module.exports = { view, save, send, test, KEY, KINDS, _clean: clean };
