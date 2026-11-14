// ---------------------------------------------------------------------------
// AI MARKETING > AI VIDEO > "FREE STOCK CLIPS" (2026-11-14): real moving footage of people, offices, hospitals, cities ... from Pexels, for FREE.
//   key     a free Pexels API key (pexels.com/api) typed in Administration > Integrations > "Stock video clips (Pexels, free)". Only the server calls Pexels.
//   use     a person searches in plain words, sees thumbnails, presses "Use this clip": the server downloads that clip and saves it EXACTLY like an uploaded
//           clip (a draft: ask for approval, then mix it into a video in AI Video). The photographer's name and the Pexels page are kept on the clip.
//   safety  the browser never sends an address: only a Pexels video id. The server asks Pexels for that id, picks one of ITS files, and downloads only
//           from a *.pexels.com address (https). Size is capped (40 MB), length is capped (30 s), a per-person daily limit and a per-person search limit apply.
//   free    Pexels allows 200 requests an hour; searches are cached for 10 minutes so a team asking for the same thing costs one request.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const sandbox = require('../utils/sandbox');

const CHANNEL = 'stock-pexels';
const API = () => String(process.env.MK_PEXELS_API || '').replace(/\/+$/, '') || 'https://api.pexels.com'; // the override is for tests only (a local fake Pexels)
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_SECONDS = 30;
const ASPECTS = [['1:1', 1], ['4:5', 0.8], ['9:16', 9 / 16], ['16:9', 16 / 9], ['3:4', 0.75]];
const mayWrite = (u) => A.has('mayAiMarketing')(u);
const aspectOf = (w, h) => { const r = (Number(w) || 1) / (Number(h) || 1); return ASPECTS.map(([k, v]) => ({ k, d: Math.abs(Math.log(r / v)) })).sort((a, b) => a.d - b.d)[0].k; };

async function config() {
  let c = { values: {}, missingKey: false };
  try { c = await require('../utils/integrationStore').readConfig(CHANNEL); } catch { /* not configured */ } // eslint-disable-line global-require
  const v = c.values || {};
  const n = Number(String(v['Clips per person per day'] == null ? '' : v['Clips per person per day']).trim());
  return { key: String(v['Pexels API key'] || '').trim(), missingKey: !!c.missingKey, perDay: Number.isFinite(n) && String(v['Clips per person per day']).trim() !== '' && n >= 0 ? Math.min(100, Math.floor(n)) : 30 };
}
const overridden = () => !!String(process.env.MK_PEXELS_API || '').trim();
async function status() {
  const c = await config();
  const base = { perDay: c.perDay, maxSeconds: MAX_SECONDS };
  if (sandbox.isSandbox() && !sandbox.allowAi() && !overridden()) return { ...base, ready: false, reason: 'The test sandbox makes no outside calls, so no stock clip is searched here.' };
  if (c.missingKey) return { ...base, ready: false, reason: 'The saved Pexels key cannot be read on this server. An Admin enters it again in Administration > Integrations > Stock video clips (Pexels).' };
  if (!c.key) return { ...base, ready: false, reason: 'No Pexels key yet. It is free: an Admin makes an account on pexels.com, opens pexels.com/api, copies the key, and pastes it in Administration > Integrations > Stock video clips (Pexels).' };
  if (c.perDay === 0) return { ...base, ready: false, reason: 'Stock clips are switched off (0 a day). An Admin can change it in Administration > Integrations.' };
  return { ...base, ready: true, reason: '' };
}
async function usedToday(userId) {
  try { return S.num(((await S.q('SELECT COUNT(*) AS n FROM "OmniMkImage" WHERE model = ? AND createdById = ? AND createdAt >= ?', 'pexels', userId, AI.dayStart()))[0] || {}).n); } catch { return 0; }
}
async function meta(u) {
  const st = await status(); const used = await usedToday(u.id);
  return { ...st, usedToday: used, left: Math.max(0, st.perDay - used), canWrite: mayWrite(u) };
}

// ---- Pexels calls (key in a header only) ---------------------------------------------------------------------------------------------------------
async function px(pathAndQuery, key) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    // Pexels moved its video endpoints to /v1/videos; the old /videos path is kept as a fallback
    for (const prefix of ['/v1', '']) {
      const r = await fetch(`${API()}${prefix}${pathAndQuery}`, { headers: { Authorization: key }, signal: ctl.signal }); // eslint-disable-line no-await-in-loop
      const text = await r.text(); // eslint-disable-line no-await-in-loop
      if (r.status === 404 && prefix === '/v1' && /^\/videos\/search/.test(pathAndQuery)) continue;
      let json = null; try { json = JSON.parse(text); } catch { json = null; }
      if (r.ok) return json || {};
      if (r.status === 401 || r.status === 403) throw new AI.AiMkError('Pexels did not accept the key. An Admin checks it in Administration > Integrations > Stock video clips (Pexels).', 502, 'provider');
      if (r.status === 429) throw new AI.AiMkError('Pexels says too many searches for now (its free limit is 200 an hour). Try again in a few minutes.', 429, 'provider');
      if (r.status === 404) throw new AI.AiMkError('That stock clip is not on Pexels any more.', 404, 'gone');
      throw new AI.AiMkError(`Pexels said: ${(json && (json.error || json.code)) || text.slice(0, 160) || `HTTP ${r.status}`}`, 502, 'provider');
    }
    throw new AI.AiMkError('Pexels did not answer this search. Try again.', 502, 'provider');
  } catch (e) {
    if (e instanceof AI.AiMkError) throw e;
    throw new AI.AiMkError(e.name === 'AbortError' ? 'Pexels did not answer in time.' : `Pexels could not be reached: ${e.message}`, 503, 'unreachable');
  } finally { clearTimeout(t); }
}
async function testKey() {
  const c = await config();
  if (!c.key) return { ok: false, text: 'no Pexels key' };
  if (sandbox.isSandbox() && !sandbox.allowAi() && !overridden()) return { ok: false, text: 'the test sandbox makes no outside calls' };
  try { const j = await px('/videos/search?query=office&per_page=1', c.key); return { ok: true, text: `Pexels answered (${S.num(j.total_results)} office clips found)` }; } catch (e) { return { ok: false, text: e.message }; }
}

// ---- search --------------------------------------------------------------------------------------------------------------------------------------
const cache = new Map(); // key -> { at, data }
const rate = new Map(); // userId -> [timestamps]
function tooMany(userId) {
  const now = Date.now(); const list = (rate.get(userId) || []).filter((t) => now - t < 600000);
  if (list.length >= 40) { rate.set(userId, list); return true; }
  list.push(now); rate.set(userId, list); return false;
}
const ORIENT = { portrait: 'portrait', tall: 'portrait', landscape: 'landscape', wide: 'landscape', square: 'square' };
function card(v) {
  const files = Array.isArray(v.video_files) ? v.video_files : [];
  return {
    id: String(v.id), thumb: String(v.image || (v.video_pictures && v.video_pictures[0] && v.video_pictures[0].picture) || ''), seconds: Math.round(Number(v.duration) || 0),
    width: S.num(v.width), height: S.num(v.height), aspect: aspectOf(v.width, v.height), author: S.clip((v.user && v.user.name) || 'Pexels contributor', 80),
    pageUrl: String(v.url || ''), hasFile: files.some((f) => /mp4/i.test(f.file_type || '')),
  };
}
async function search(u, q = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at clips but not search for them.', status: 403 };
  const st = await status();
  if (!st.ready) return { error: st.reason, status: 503, code: 'not_ready' };
  const text = String(q.q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (text.length < 2) return { error: 'Type what you want to see, for example "nurse hospital" or "team meeting".', status: 400 };
  const orientation = ORIENT[String(q.orientation || '').toLowerCase()] || '';
  const page = Math.max(1, Math.min(20, Math.floor(Number(q.page)) || 1));
  const ck = `${text.toLowerCase()}|${orientation}|${page}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 600000) return hit.data;
  if (tooMany(u.id)) return { error: 'Too many searches in a few minutes. Wait a little, or use the results you already have.', status: 429 };
  const c = await config();
  const j = await px(`/videos/search?query=${encodeURIComponent(text)}&per_page=18&page=${page}${orientation ? `&orientation=${orientation}` : ''}`, c.key);
  const items = (j.videos || []).map(card).filter((x) => x.hasFile && x.seconds >= 2 && x.seconds <= MAX_SECONDS);
  const data = { items, page, hasMore: !!j.next_page, query: text };
  cache.set(ck, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

// ---- use a clip ----------------------------------------------------------------------------------------------------------------------------------
const hostOk = (url) => {
  try { const x = new URL(url); if (overridden() && x.origin === new URL(API()).origin) return true; return x.protocol === 'https:' && (x.hostname === 'pexels.com' || x.hostname.endsWith('.pexels.com')); } catch { return false; }
};
// the mp4 files of one video, best first: about 720-1080 px on the short side (sharp enough for a phone video, small enough to save)
function ranked(v) {
  const mp4 = (v.video_files || []).filter((f) => /mp4/i.test(f.file_type || '') && f.link);
  const score = (f) => { const side = Math.min(S.num(f.width), S.num(f.height)); return side >= 540 && side <= 1080 ? Math.abs(side - 720) : side > 1080 ? 1000 + side : 2000 - side; };
  return mp4.sort((a, b) => score(a) - score(b));
}
async function fetchBytes(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.url && !hostOk(r.url)) throw new AI.AiMkError('The clip came from an address that is not allowed.', 502, 'provider');
    if (!r.ok) throw new AI.AiMkError(`The clip could not be downloaded (HTTP ${r.status}).`, 502, 'provider');
    const len = Number(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
    if (len > MAX_BYTES) return { big: true };
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > MAX_BYTES ? { big: true } : { buf };
  } catch (e) {
    if (e instanceof AI.AiMkError) throw e;
    throw new AI.AiMkError(e.name === 'AbortError' ? 'The clip download took too long.' : `The clip could not be downloaded: ${e.message}`, 503, 'unreachable');
  } finally { clearTimeout(t); }
}
async function importClip(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at clips but not add them.', status: 403 };
  const st = await status();
  if (!st.ready) return { error: st.reason, status: 503, code: 'not_ready' };
  const id = String(b.id || '').trim();
  if (!/^\d{1,12}$/.test(id)) return { error: 'Pick a clip from the search results.', status: 400 };
  if ((await usedToday(u.id)) >= st.perDay) return { error: `You have already added ${st.perDay} stock clips today. Try again tomorrow, or ask an Admin to raise the limit in Administration > Integrations.`, status: 429, code: 'limit' };
  const c = await config();
  const v = await px(`/videos/videos/${id}`, c.key);
  if (!v || String(v.id) !== id) return { error: 'That stock clip is not on Pexels any more.', status: 404 };
  const secs = Math.round(Number(v.duration) || 0);
  if (secs > MAX_SECONDS) return { error: `That clip is ${secs} seconds long. Pick one of ${MAX_SECONDS} seconds or less.`, status: 400 };
  let buf = null;
  for (const f of ranked(v).slice(0, 4)) {
    if (!hostOk(f.link)) continue;
    const got = await fetchBytes(f.link); // eslint-disable-line no-await-in-loop
    if (got.buf) { buf = got.buf; break; }
  }
  if (!buf) return { error: 'This clip is too big to save (over 40 MB). Pick a shorter one.', status: 413 };
  const who = S.clip((v.user && v.user.name) || 'a Pexels contributor', 80);
  const label = S.clip(String(b.query || '').replace(/\s+/g, ' ').trim(), 40);
  const saved = await require('./images').saveVideo(u, buf, 'video/mp4', { // eslint-disable-line global-require
    kind: 'clip', model: 'pexels', title: `Stock: ${label || 'Pexels clip'}`, aspect: aspectOf(v.width, v.height), seconds: secs, department: b.department,
    about: `Stock clip from Pexels by ${who} (${S.clip(v.url, 120)}), ${secs} seconds. Free to use under the Pexels licence.`,
  });
  return saved;
}

module.exports = { status, meta, search, importClip, testKey, CHANNEL };
