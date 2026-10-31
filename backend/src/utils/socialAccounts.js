// ---------------------------------------------------------------------------
// SOCIAL MEDIA ACCOUNTS - many per platform (founder 2026-10-30: "separate ga tabs ravali ... okka tab social media anni dantlo facebook ...
// instagram ... threads ... okatey accounts unadav facebook accounts 5 ala unati anni accounts ina connect chesukodaniki undali").
//
// One list (AppSetting 'social.accounts'; tokens encrypted with utils/secrets.js, never sent to a screen):
//   facebook   a Page, from "Connect with Facebook" (any number of Pages, from any number of Facebook logins)
//   instagram  the Instagram professional account linked to such a Page (found by itself; posts use that Page's token)
//   threads    a Threads profile, from a pasted Threads access token
// One account per platform is the DEFAULT (*): it is the one job posts use and the one Omni-Channel gets (Green Start keeps one
// Facebook Page / Threads profile per workspace). Making a Facebook Page the default writes it into the Social Media channel exactly
// as before (facebookConnect.save -> routes/admin.js applySocial -> job-posting login + check + Omni-Channel), so nothing that reads
// that channel changes. A connection made before this list existed is taken into it as the default.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { encryptSecret, decryptSecret } = require('./secrets');
const { readConfig, writeValues } = require('./integrationStore');

const KEY = 'social.accounts';
const PLATFORMS = ['facebook', 'instagram', 'threads', 'linkedin', 'youtube'];
const graphBase = () => String(process.env.TL_FACEBOOK_GRAPH_BASE || 'https://graph.facebook.com/v19.0').replace(/\/+$/, '');
const threadsBase = () => String(process.env.TL_THREADS_GRAPH_BASE || 'https://graph.threads.net/v1.0').replace(/\/+$/, '');

async function readAll() {
  try { const row = await prisma.appSetting.findUnique({ where: { key: KEY } }); const v = row ? JSON.parse(row.value) : []; return Array.isArray(v) ? v : []; } catch { return []; }
}
async function writeAll(list) {
  const value = JSON.stringify(list);
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
}
const tokenOf = (a) => (a && a.tokenEnc ? decryptSecret(a.tokenEnc) : '');
// LinkedIn tokens last 60 days: a token past its date is shown as Expired (posting would be refused), never as Connected
const expired = (a) => !!(a.expiresAt && Date.parse(a.expiresAt) < Date.now());
const shape = (a) => ({
  id: a.id, platform: a.platform, externalId: a.externalId, name: a.name, username: a.username || null, parentId: a.parentId || null,
  parentName: a.parentName || null, isDefault: !!a.isDefault, status: expired(a) ? 'Expired' : (a.status || 'Connected'), error: expired(a) ? (a.platform === 'youtube' ? 'The YouTube sign-in has expired. Press Connect YouTube again.' : 'The LinkedIn token has expired (they last 60 days). Press Connect LinkedIn again.') : (a.error || null),
  connectedByName: a.connectedByName || null, connectedAt: a.connectedAt || null, viaLogin: a.viaLogin || null, expiresAt: a.expiresAt || null, kind: a.kind || null,
});

async function getJson(url) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(30000) }); } catch { throw new Error('could not be reached from this server'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j && j.error)) throw new Error(String((j.error && j.error.message) || res.status).replace(/access_token=[^&\s"]+/gi, 'access_token=...').slice(0, 200));
  return j;
}

// a connection made before the list existed (the Social Media channel's Page / the Threads token) becomes the default entry
async function adoptLegacy(list) {
  let changed = false;
  try {
    const c = await readConfig('social');
    const v = c.values || {};
    const pageId = String(v['Facebook Page ID'] || '').trim();
    const pageTok = String(v['Facebook Page access token'] || '').trim();
    if (c.connected && pageId && pageTok && !list.some((a) => a.platform === 'facebook' && a.externalId === pageId)) {
      list.push({ id: crypto.randomUUID(), platform: 'facebook', externalId: pageId, name: `Page ${pageId}`, tokenEnc: encryptSecret(pageTok), isDefault: !list.some((a) => a.platform === 'facebook' && a.isDefault), status: 'Connected', connectedAt: new Date().toISOString(), connectedByName: 'Earlier connection' });
      changed = true;
    }
    const thTok = String(v['Threads access token'] || '').trim();
    const thProfile = String(v['Threads profile'] || '').trim();
    if (thTok && !list.some((a) => a.platform === 'threads')) {
      list.push({ id: crypto.randomUUID(), platform: 'threads', externalId: thProfile || 'threads', name: thProfile || 'Threads', username: thProfile.replace(/^@/, '') || null, tokenEnc: encryptSecret(thTok), isDefault: true, status: 'Connected', connectedAt: new Date().toISOString(), connectedByName: 'Earlier connection' });
      changed = true;
    }
  } catch { /* no key / nothing saved: nothing to adopt */ }
  return changed;
}

async function list() {
  const all = await readAll();
  if (await adoptLegacy(all)) await writeAll(all);
  const out = {};
  PLATFORMS.forEach((p) => { out[p] = all.filter((a) => a.platform === p).map(shape).sort((x, y) => (y.isDefault - x.isDefault) || String(x.name).localeCompare(String(y.name))); });
  return out;
}

function upsert(all, acc, token, user) {
  const i = all.findIndex((a) => a.platform === acc.platform && a.externalId === acc.externalId);
  const base = i >= 0 ? all[i] : { id: crypto.randomUUID(), isDefault: false, connectedAt: new Date().toISOString() };
  const next = { ...base, ...acc, tokenEnc: token ? encryptSecret(token) : base.tokenEnc, status: 'Connected', error: null, connectedByName: user ? user.name : base.connectedByName, updatedAt: new Date().toISOString() };
  if (i >= 0) all[i] = next; else all.push(next);
  return next;
}

// the Instagram professional account linked to a Page (none = the Page has no linked Instagram account)
async function instagramOf(pageId, pageToken) {
  const j = await getJson(`${graphBase()}/${encodeURIComponent(pageId)}?${new URLSearchParams({ fields: 'instagram_business_account{id,username,name}', access_token: pageToken })}`);
  return j && j.instagram_business_account && j.instagram_business_account.id ? j.instagram_business_account : null;
}

// Pages picked after "Connect with Facebook": every one is kept; each Page's linked Instagram account is added by itself.
async function addFacebookPages(user, pages, { viaLogin = null } = {}) {
  const all = await readAll();
  await adoptLegacy(all);
  const added = [];
  const igFound = [];
  const igMissing = [];
  for (const p of pages) {
    const fb = upsert(all, { platform: 'facebook', externalId: String(p.id), name: String(p.name || p.id), viaLogin }, p.token, user);
    added.push(fb);
    try {
      const ig = await instagramOf(p.id, p.token); // eslint-disable-line no-await-in-loop
      if (ig) igFound.push(upsert(all, { platform: 'instagram', externalId: String(ig.id), name: ig.name || ig.username || String(ig.id), username: ig.username || null, parentId: String(p.id), parentName: String(p.name || p.id) }, p.token, user));
      else igMissing.push(String(p.name || p.id));
    } catch (err) { igMissing.push(`${p.name || p.id} (${err.message})`); }
  }
  // the first Instagram account becomes the default when none is
  if (!all.some((a) => a.platform === 'instagram' && a.isDefault)) { const first = all.find((a) => a.platform === 'instagram'); if (first) first.isDefault = true; }
  await writeAll(all);
  const needDefault = !all.some((a) => a.platform === 'facebook' && a.isDefault);
  return { added: added.map(shape), instagram: igFound.map(shape), instagramMissing: igMissing, needDefault, firstId: added[0] ? added[0].id : null };
}

async function refreshInstagram(user) {
  const all = await readAll();
  let found = 0;
  const missing = [];
  for (const fb of all.filter((a) => a.platform === 'facebook')) {
    const tok = tokenOf(fb);
    if (!tok) { missing.push(`${fb.name} (token cannot be read)`); continue; } // eslint-disable-line no-continue
    try {
      const ig = await instagramOf(fb.externalId, tok); // eslint-disable-line no-await-in-loop
      if (ig) { upsert(all, { platform: 'instagram', externalId: String(ig.id), name: ig.name || ig.username || String(ig.id), username: ig.username || null, parentId: fb.externalId, parentName: fb.name }, tok, user); found += 1; } else missing.push(fb.name);
    } catch (err) { missing.push(`${fb.name} (${err.message})`); }
  }
  if (!all.some((a) => a.platform === 'instagram' && a.isDefault)) { const first = all.find((a) => a.platform === 'instagram'); if (first) first.isDefault = true; }
  await writeAll(all);
  return { found, missing };
}

// LinkedIn (2026-10-31): the profile that signed in (always) and, when its number was typed, a Company Page the same token may post for.
// The default one is what job posts use (utils/socialPosting.js copies it to the job-posting connection).
async function addLinkedin(user, { sub, name, token, expiresAt, orgId = null, orgName = null }) {
  const all = await readAll();
  await adoptLegacy(all);
  const urn = `urn:li:person:${sub}`;
  const person = upsert(all, { platform: 'linkedin', externalId: urn, name: name || urn, kind: 'profile', expiresAt: expiresAt || null }, token, user);
  let page = null;
  if (orgId) page = upsert(all, { platform: 'linkedin', externalId: `urn:li:organization:${orgId}`, name: orgName || `Company Page ${orgId}`, kind: 'page', parentId: urn, parentName: person.name, expiresAt: expiresAt || null }, token, user);
  if (!all.some((a) => a.platform === 'linkedin' && a.isDefault)) (page || person).isDefault = true;
  await writeAll(all);
  return { ok: true, person: shape(person), page: page ? shape(page) : null };
}

// YouTube (2026-10-31): the channels of the Google account that signed in (utils/youtubeConnect.js). The REFRESH token is kept (it does not
// expire on its own); without one (Google gives it only with consent) the short access token is kept with its end time, shown as Expired after.
async function addYoutube(user, channels, { refreshToken = null, accessToken = null, expiresIn = null } = {}) {
  const all = await readAll();
  await adoptLegacy(all);
  const token = refreshToken || accessToken;
  const expiresAt = refreshToken ? null : (expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null);
  const added = channels.map((c) => upsert(all, { platform: 'youtube', externalId: String(c.id), name: c.title || String(c.id), username: c.handle ? String(c.handle).replace(/^@/, '') : null, kind: 'channel', tokenKind: refreshToken ? 'refresh' : 'access', expiresAt }, token, user));
  if (!all.some((a) => a.platform === 'youtube' && a.isDefault) && added[0]) added[0].isDefault = true;
  await writeAll(all);
  return { ok: true, added: added.map(shape) };
}

async function addThreads(user, token) {
  const t = String(token || '').trim();
  if (t.length < 20 || /\s/.test(t)) return { error: 'That does not look like a Threads access token. Copy the whole token.', status: 400 };
  let me;
  try { me = await getJson(`${threadsBase()}/me?${new URLSearchParams({ fields: 'id,username', access_token: t })}`); } catch (err) { return { error: `Threads did not accept the token: ${err.message}`, status: 422 }; }
  const all = await readAll();
  await adoptLegacy(all);
  const acc = upsert(all, { platform: 'threads', externalId: String(me.id), name: me.username ? `@${me.username}` : String(me.id), username: me.username || null }, t, user);
  const makeDefault = !all.some((a) => a.platform === 'threads' && a.isDefault && a.id !== acc.id);
  await writeAll(all);
  return { ok: true, account: shape(acc), makeDefault };
}

// Threads default -> the Social Media channel's Threads fields (what utils/greenStartIntegrations.js gives Omni-Channel)
async function writeThreadsChannel(token, profile) {
  const w = await writeValues('social', { 'Threads access token': token || '-', 'Threads profile': profile || '' });
  await prisma.integration.update({ where: { id: 'social' }, data: { values: JSON.stringify(w.values) } });
}

// make one account the default of its platform. saveFacebook(user, { id, access_token }) = facebookConnect.save (the old one-Page path)
async function setDefault(user, id, { saveFacebook } = {}) {
  const all = await readAll();
  const acc = all.find((a) => a.id === id);
  if (!acc) return { error: 'That account is not in the list any more.', status: 404 };
  const tok = tokenOf(acc);
  if (!tok) return { error: 'The token of this account cannot be read on this server. Connect it again.', status: 400 };
  let result = null;
  if (acc.platform === 'facebook' && saveFacebook) result = await saveFacebook(user, { id: acc.externalId, access_token: tok });
  if (acc.platform === 'threads') await writeThreadsChannel(tok, acc.name);
  all.forEach((a) => { if (a.platform === acc.platform) a.isDefault = a.id === acc.id; });
  if (result && result.ok === false) { acc.status = 'Problem'; acc.error = String(result.words || '').slice(0, 300); } else { acc.status = 'Connected'; acc.error = null; }
  await writeAll(all);
  return { ok: !result || result.ok !== false, account: shape(acc), result };
}

async function remove(user, id) {
  const all = await readAll();
  const acc = all.find((a) => a.id === id);
  if (!acc) return { error: 'That account is not in the list any more.', status: 404 };
  // a Page takes its Instagram account with it (the Instagram account was reached through that Page)
  const drop = new Set([acc.id, ...all.filter((a) => (acc.platform === 'facebook' && a.platform === 'instagram' && a.parentId === acc.externalId) || (acc.platform === 'linkedin' && a.platform === 'linkedin' && a.parentId === acc.externalId)).map((a) => a.id)]);
  const rest = all.filter((a) => !drop.has(a.id));
  let clearedDefault = false;
  for (const p of PLATFORMS) {
    if (all.some((a) => drop.has(a.id) && a.platform === p && a.isDefault)) {
      clearedDefault = clearedDefault || p === acc.platform;
      const next = rest.find((a) => a.platform === p);
      if (next) next.isDefault = true;
    }
  }
  await writeAll(rest);
  return { ok: true, removed: [...drop].length, platform: acc.platform, wasDefault: !!acc.isDefault, nextDefault: (rest.find((a) => a.platform === acc.platform && a.isDefault) || {}).id || null };
}

// EDIT (founder 2026-10-31: "edit chesukodaniki kuda button evvu"): the name shown in TeamLink, and - optionally - a new token for the same
// account (a Page / Instagram / Threads token that expired or was renewed). The token must belong to THIS account (checked with Facebook /
// Threads); for the default account the change reaches job posts and Omni-Channel at once. LinkedIn renews by connecting again.
async function edit(user, id, { name, token } = {}, { saveFacebook } = {}) {
  const all = await readAll();
  const acc = all.find((a) => a.id === id);
  if (!acc) return { error: 'That account is not in the list any more.', status: 404 };
  const nm = name === undefined ? acc.name : String(name || '').trim().slice(0, 80);
  if (!nm) return { error: 'Type a name.', status: 400 };
  const t = String(token || '').trim();
  if (t) {
    if (t.length < 20 || /\s/.test(t)) return { error: 'That does not look like an access token. Copy the whole token.', status: 400 };
    try {
      if (acc.platform === 'facebook' || acc.platform === 'instagram') {
        const j = await getJson(`${graphBase()}/${encodeURIComponent(acc.externalId)}?${new URLSearchParams({ fields: 'id', access_token: t })}`);
        if (String(j.id) !== String(acc.externalId)) return { error: 'That token belongs to another account.', status: 422 };
      } else if (acc.platform === 'threads') {
        const j = await getJson(`${threadsBase()}/me?${new URLSearchParams({ fields: 'id,username', access_token: t })}`);
        if (String(j.id) !== String(acc.externalId)) return { error: `That token belongs to another Threads profile${j.username ? ` (@${j.username})` : ''}.`, status: 422 };
      } else return { error: acc.platform === 'youtube' ? 'A YouTube channel is renewed by pressing Connect YouTube again.' : 'A LinkedIn token is renewed by pressing Connect LinkedIn again.', status: 400 };
    } catch (err) { return { error: `Not accepted: ${err.message}`, status: 422 }; }
    acc.tokenEnc = encryptSecret(t);
    acc.status = 'Connected'; acc.error = null;
  }
  acc.name = nm;
  acc.updatedAt = new Date().toISOString();
  // an Instagram account reached through this Page shows the new Page name
  if (acc.platform === 'facebook') all.forEach((a) => { if (a.platform === 'instagram' && a.parentId === acc.externalId) a.parentName = nm; });
  await writeAll(all);
  let result = null;
  if (t && acc.isDefault) {
    if (acc.platform === 'facebook' && saveFacebook) result = await saveFacebook(user, { id: acc.externalId, access_token: t });
    if (acc.platform === 'threads') await writeThreadsChannel(t, nm);
  }
  return { ok: !result || result.ok !== false, account: shape(acc), tokenChanged: !!t, result };
}

module.exports = { edit, list, addFacebookPages, refreshInstagram, addThreads, addLinkedin, addYoutube, tokenOf, setDefault, remove, writeThreadsChannel, readAll, PLATFORMS };
