// ---------------------------------------------------------------------------
// AI MARKETING > AI VIDEO > "FREE STOCK CLIPS" (2026-11-14): real moving footage of people, offices, hospitals, cities ... for FREE, from Pixabay or Pexels.
//   key     a free key typed in Administration > Integrations: "Stock video clips (Pixabay, free)" or "(Pexels, free)". Pexels has PAUSED new keys (Nov 2026),
//           so Pixabay is the one to get; a Pexels key that already exists still works. If both are set, Pixabay is used first. Only the server calls them.
//   use     a person searches in plain words, sees thumbnails, presses "Use this clip": the server downloads that clip and saves it EXACTLY like an uploaded
//           clip (a draft: ask for approval, then mix it into a video in AI Video). The author's name and the source page are kept on the clip.
//   safety  the browser never sends an address: only a video id. The server asks the source for that id, picks one of ITS files, and downloads only from the
//           source's own https address. Size is capped (40 MB), length is capped (30 s), a per-person daily limit and a per-person search limit apply.
//   free    searches are cached for 10 minutes (Pixabay asks for caching; Pexels allows 200 requests an hour), so a team asking for the same thing costs one request.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const sandbox = require('../utils/sandbox');

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_SECONDS = 30;
const PAGE = 18;
const ASPECTS = [['1:1', 1], ['4:5', 0.8], ['9:16', 9 / 16], ['16:9', 16 / 9], ['3:4', 0.75]];
const mayWrite = (u) => A.has('mayAiMarketing')(u);
const aspectOf = (w, h) => { const r = (Number(w) || 1) / (Number(h) || 1); return ASPECTS.map(([k, v]) => ({ k, d: Math.abs(Math.log(r / v)) })).sort((a, b) => a.d - b.d)[0].k; };
const shapeOf = (w, h) => (h > w * 1.1 ? 'portrait' : w > h * 1.1 ? 'landscape' : 'square');
const ORIENT = { portrait: 'portrait', tall: 'portrait', landscape: 'landscape', wide: 'landscape', square: 'square' };
const base = (envName, real) => String(process.env[envName] || '').replace(/\/+$/, '') || real; // the env override is for tests only (a local fake source)

// one place that knows how each source answers; both return the same plain shape
const PROVIDERS = [
  {
    id: 'pexels', name: 'Pexels', channel: 'stock-pexels', keyField: 'Pexels API key', env: 'MK_PEXELS_API', hosts: ['pexels.com'],
    api: () => base('MK_PEXELS_API', 'https://api.pexels.com'),
    // Pexels moved its video endpoints to /v1/videos; the old /videos path is kept as a fallback
    async get(path, key) { return pxGet(this, path, key); },
    async search(text, orient, page, key) {
      const j = await this.get(`/videos/search?query=${encodeURIComponent(text)}&per_page=${PAGE}&page=${page}${orient ? `&orientation=${orient}` : ''}`, key);
      return { items: (j.videos || []).map((v) => this.card(v)), hasMore: !!j.next_page, total: S.num(j.total_results) };
    },
    card(v) {
      const files = (Array.isArray(v.video_files) ? v.video_files : []).filter((f) => /mp4/i.test(f.file_type || '') && f.link);
      return { id: String(v.id), thumb: String(v.image || ''), seconds: Math.round(Number(v.duration) || 0), width: S.num(v.width), height: S.num(v.height), author: S.clip((v.user && v.user.name) || 'Pexels contributor', 80), pageUrl: String(v.url || ''), files: files.map((f) => ({ link: f.link, width: S.num(f.width), height: S.num(f.height), size: 0 })) };
    },
    async one(id, key) { const v = await this.get(`/videos/videos/${id}`, key); return v && String(v.id) === id ? this.card(v) : null; },
    // free photos (2026-11-14): [{ link, author, pageUrl }] best first
    async photos(text, shape, key) {
      const { r, text: body, json } = await call(this, `${this.api()}/v1/search?query=${encodeURIComponent(text)}&per_page=15&orientation=${shape}`, { Authorization: key });
      if (!r.ok) throw fail(this, r, body, json);
      return ((json && json.photos) || []).map((x) => ({ link: String((x.src && (x.src.large2x || x.src.large || x.src.original)) || ''), author: S.clip(x.photographer || 'Pexels contributor', 80), pageUrl: String(x.url || '') })).filter((x) => x.link);
    },
  },
  {
    id: 'pixabay', name: 'Pixabay', channel: 'stock-pixabay', keyField: 'Pixabay API key', env: 'MK_PIXABAY_API', hosts: ['pixabay.com'],
    api: () => base('MK_PIXABAY_API', 'https://pixabay.com'),
    async get(path, key) { return pbGet(this, path, key); },
    async search(text, orient, page, key) {
      // Pixabay has no shape filter for video: ask for 40 and keep the clips of the wanted shape
      const j = await this.get(`/api/videos/?q=${encodeURIComponent(text)}&video_type=film&safesearch=true&per_page=40&page=${page}`, key);
      let items = (j.hits || []).map((v) => this.card(v));
      if (orient) items = items.filter((x) => shapeOf(x.width, x.height) === orient);
      return { items: items.slice(0, PAGE), hasMore: page * 40 < S.num(j.totalHits), total: S.num(j.totalHits) };
    },
    card(v) {
      const vs = v.videos || {}; const sizes = ['large', 'medium', 'small', 'tiny'].map((k) => vs[k]).filter((f) => f && f.url);
      const ref = vs.medium || vs.small || vs.large || vs.tiny || {};
      return { id: String(v.id), thumb: String(ref.thumbnail || (v.picture_id ? `https://i.vimeocdn.com/video/${v.picture_id}_295x166.jpg` : '')), seconds: Math.round(Number(v.duration) || 0), width: S.num(ref.width), height: S.num(ref.height), author: S.clip(v.user || 'Pixabay contributor', 80), pageUrl: String(v.pageURL || ''), files: sizes.map((f) => ({ link: f.url, width: S.num(f.width), height: S.num(f.height), size: S.num(f.size) })) };
    },
    async one(id, key) { const j = await this.get(`/api/videos/?id=${id}`, key); const v = (j.hits || [])[0]; return v && String(v.id) === id ? this.card(v) : null; },
    async photos(text, shape, key) {
      const orient = shape === 'portrait' ? '&orientation=vertical' : shape === 'landscape' ? '&orientation=horizontal' : '';
      const j = await this.get(`/api/?q=${encodeURIComponent(text)}&image_type=photo&safesearch=true&per_page=20&order=popular&min_width=700${orient}`, key);
      return (j.hits || []).map((x) => ({ link: String(x.largeImageURL || x.webformatURL || ''), author: S.clip(x.user || 'Pixabay contributor', 80), pageUrl: String(x.pageURL || '') })).filter((x) => x.link);
    },
  },
];

// ---- the key, the limit, which source is on ------------------------------------------------------------------------------------------------------
async function configOf(p) {
  let c = { values: {}, missingKey: false };
  try { c = await require('../utils/integrationStore').readConfig(p.channel); } catch { /* not configured */ } // eslint-disable-line global-require
  const v = c.values || {}; const raw = String(v['Clips per person per day'] == null ? '' : v['Clips per person per day']).trim(); const n = Number(raw);
  return { p, key: String(v[p.keyField] || '').trim(), missingKey: !!c.missingKey, perDay: raw !== '' && Number.isFinite(n) && n >= 0 ? Math.min(100, Math.floor(n)) : 30 };
}
const overridden = (p) => !!String(process.env[p.env] || '').trim();
const sandboxBlocked = (p) => sandbox.isSandbox() && !sandbox.allowAi() && !overridden(p);
// the source in use: Pixabay first (its keys can still be had; a wrong or old key in the Pexels card must never block it), then Pexels; else the first with a
// saved-but-unreadable key; else Pixabay (the one to get)
async function active() {
  const cs = []; for (const p of [PROVIDERS[1], PROVIDERS[0]]) cs.push(await configOf(p)); // eslint-disable-line no-await-in-loop
  return cs.find((c) => c.key) || cs.find((c) => c.missingKey) || cs[0];
}
async function status() {
  const c = await active(); const p = c.p;
  const out = { perDay: c.perDay, maxSeconds: MAX_SECONDS, source: p.name };
  if (sandboxBlocked(p)) return { ...out, ready: false, reason: 'The test sandbox makes no outside calls, so no stock clip is searched here.' };
  if (c.missingKey) return { ...out, ready: false, reason: `The saved ${p.name} key cannot be read on this server. An Admin enters it again in Administration > Integrations > Stock video clips (${p.name}).` };
  if (!c.key) return { ...out, ready: false, reason: 'No stock-clip key yet. It is free: an Admin makes an account on pixabay.com, copies the API key shown on pixabay.com/api/docs, and pastes it in Administration > Integrations > Stock video clips (Pixabay). (Pexels has paused new keys; an existing Pexels key still works.)' };
  if (c.perDay === 0) return { ...out, ready: false, reason: 'Stock clips are switched off (0 a day). An Admin can change it in Administration > Integrations.' };
  return { ...out, ready: true, reason: '' };
}
async function usedToday(userId) {
  try { return S.num(((await S.q('SELECT COUNT(*) AS n FROM "OmniMkImage" WHERE model IN (?, ?) AND createdById = ? AND createdAt >= ?', 'stock', 'pexels', userId, AI.dayStart()))[0] || {}).n); } catch { return 0; }
}
async function meta(u) {
  const st = await status(); const used = await usedToday(u.id);
  return { ...st, usedToday: used, left: Math.max(0, st.perDay - used), canWrite: mayWrite(u) };
}

// ---- calls (the key never appears in a message or a log) ---------------------------------------------------------------------------------------
async function call(p, url, headers) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    return { r, text, json };
  } catch (e) {
    throw new AI.AiMkError(e.name === 'AbortError' ? `${p.name} did not answer in time.` : `${p.name} could not be reached.`, 503, 'unreachable');
  } finally { clearTimeout(t); }
}
const fail = (p, r, text, json) => {
  if (r.status === 401 || r.status === 403 || (r.status === 400 && /key/i.test(text))) return new AI.AiMkError(`${p.name} did not accept the key. Check that it is pasted in the ${p.name} card (a Pixabay key does not work in the Pexels card, and the other way round), without spaces.`, 502, 'provider');
  if (r.status === 429) return new AI.AiMkError(`${p.name} says too many searches for now. Try again in a few minutes.`, 429, 'provider');
  if (r.status === 404) return new AI.AiMkError('That stock clip is not there any more.', 404, 'gone');
  return new AI.AiMkError(`${p.name} said: ${S.clip(String((json && (json.error || json.message)) || text || `HTTP ${r.status}`).replace(/key=[^&\s]+/gi, 'key=…'), 160)}`, 502, 'provider');
};
async function pxGet(p, pathAndQuery, key) {
  for (const prefix of ['/v1', '']) {
    const { r, text, json } = await call(p, `${p.api()}${prefix}${pathAndQuery}`, { Authorization: key }); // eslint-disable-line no-await-in-loop
    if (r.status === 404 && prefix === '/v1' && /^\/videos\/search/.test(pathAndQuery)) continue;
    if (r.ok) return json || {};
    throw fail(p, r, text, json);
  }
  throw new AI.AiMkError('Pexels did not answer this search. Try again.', 502, 'provider');
}
async function pbGet(p, pathAndQuery, key) {
  const { r, text, json } = await call(p, `${p.api()}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`, {});
  if (r.ok) return json || {};
  throw fail(p, r, text, json);
}
// the Test button of a card checks THAT card's own key (channel = 'stock-pixabay' or 'stock-pexels'); with no channel, the source in use
async function testKey(channel) {
  const own = PROVIDERS.find((x) => x.channel === channel);
  const c = own ? await configOf(own) : await active(); const p = c.p;
  if (!c.key) return { ok: false, text: `no ${p.name} key saved in this card` };
  if (sandboxBlocked(p)) return { ok: false, text: 'the test sandbox makes no outside calls' };
  try { const x = await p.search('office', '', 1, c.key); return { ok: true, text: `${p.name} answered (${x.total} office clips found)` }; } catch (e) { return { ok: false, text: e.message }; }
}

// ---- search --------------------------------------------------------------------------------------------------------------------------------------
const cache = new Map(); // key -> { at, data }
const rate = new Map(); // userId -> [timestamps]
function tooMany(userId) {
  const now = Date.now(); const list = (rate.get(userId) || []).filter((t) => now - t < 600000);
  if (list.length >= 40) { rate.set(userId, list); return true; }
  list.push(now); rate.set(userId, list); return false;
}
const pub = (x) => ({ id: x.id, thumb: x.thumb, seconds: x.seconds, width: x.width, height: x.height, aspect: aspectOf(x.width, x.height), author: x.author, pageUrl: x.pageUrl }); // never the file addresses
async function search(u, q = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at clips but not search for them.', status: 403 };
  const st = await status();
  if (!st.ready) return { error: st.reason, status: 503, code: 'not_ready' };
  const text = String(q.q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (text.length < 2) return { error: 'Type what you want to see, for example "nurse hospital" or "team meeting".', status: 400 };
  const orientation = ORIENT[String(q.orientation || '').toLowerCase()] || '';
  const page = Math.max(1, Math.min(20, Math.floor(Number(q.page)) || 1));
  const c = await active();
  const ck = `${c.p.id}|${text.toLowerCase()}|${orientation}|${page}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < 600000) return hit.data;
  if (tooMany(u.id)) return { error: 'Too many searches in a few minutes. Wait a little, or use the results you already have.', status: 429 };
  const got = await c.p.search(text, orientation, page, c.key);
  const items = got.items.filter((x) => x.files.length && x.seconds >= 2 && x.seconds <= MAX_SECONDS).map(pub);
  const data = { items, page, hasMore: got.hasMore, query: text, source: c.p.name };
  cache.set(ck, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

// ---- use a clip ----------------------------------------------------------------------------------------------------------------------------------
const hostOk = (p, url) => {
  try {
    const x = new URL(url);
    if (overridden(p) && x.origin === new URL(p.api()).origin) return true;
    return x.protocol === 'https:' && p.hosts.some((h) => x.hostname === h || x.hostname.endsWith(`.${h}`));
  } catch { return false; }
};
// the mp4 files of one video, best first: about 720-1080 px on the short side (sharp enough for a phone video, small enough to save)
const ranked = (x) => {
  const score = (f) => { const side = Math.min(f.width, f.height); return side >= 540 && side <= 1080 ? Math.abs(side - 720) : side > 1080 ? 1000 + side : 2000 - side; };
  return x.files.filter((f) => !f.size || f.size <= MAX_BYTES).sort((a, b) => score(a) - score(b));
};
async function fetchBytes(p, url, cap = MAX_BYTES) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.url && !hostOk(p, r.url)) throw new AI.AiMkError('The clip came from an address that is not allowed.', 502, 'provider');
    if (!r.ok) throw new AI.AiMkError(`The clip could not be downloaded (HTTP ${r.status}).`, 502, 'provider');
    const len = Number(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
    if (len > cap) return { big: true };
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > cap ? { big: true } : { buf };
  } catch (e) {
    if (e instanceof AI.AiMkError) throw e;
    throw new AI.AiMkError(e.name === 'AbortError' ? 'The clip download took too long.' : 'The clip could not be downloaded.', 503, 'unreachable');
  } finally { clearTimeout(t); }
}
async function importClip(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at clips but not add them.', status: 403 };
  const st = await status();
  if (!st.ready) return { error: st.reason, status: 503, code: 'not_ready' };
  const id = String(b.id || '').trim();
  if (!/^\d{1,12}$/.test(id)) return { error: 'Pick a clip from the search results.', status: 400 };
  if ((await usedToday(u.id)) >= st.perDay) return { error: `You have already added ${st.perDay} stock clips today. Try again tomorrow, or ask an Admin to raise the limit in Administration > Integrations.`, status: 429, code: 'limit' };
  const c = await active();
  const x = await c.p.one(id, c.key);
  if (!x) return { error: 'That stock clip is not there any more.', status: 404 };
  if (x.seconds > MAX_SECONDS) return { error: `That clip is ${x.seconds} seconds long. Pick one of ${MAX_SECONDS} seconds or less.`, status: 400 };
  let buf = null;
  for (const f of ranked(x).slice(0, 4)) {
    if (!hostOk(c.p, f.link)) continue;
    const got = await fetchBytes(c.p, f.link); // eslint-disable-line no-await-in-loop
    if (got.buf) { buf = got.buf; break; }
  }
  if (!buf) return { error: 'This clip is too big to save (over 40 MB). Pick a shorter one.', status: 413 };
  const label = S.clip(String(b.query || '').replace(/\s+/g, ' ').trim(), 40);
  return require('./images').saveVideo(u, buf, 'video/mp4', { // eslint-disable-line global-require
    kind: 'clip', model: 'stock', title: `Stock: ${label || `${c.p.name} clip`}`, aspect: aspectOf(x.width, x.height), seconds: x.seconds, department: b.department,
    about: `Stock clip from ${c.p.name} by ${x.author} (${S.clip(x.pageUrl, 120)}), ${x.seconds} seconds. Free to use under the ${c.p.name} licence.`,
  });
}

// ---- a free stock PHOTO (2026-11-14) ----------------------------------------------------------------------------------------------------------------------
// The background of a DESIGNED picture ("Create from your content" in AI Video / AI Images, when no paid picture AI is connected): the browser sends only words and a shape, the server asks the
// source (Pixabay first), downloads ONE photo from the source's own https address (8 MB at most, a real picture only) and hands the bytes back. Cached for 10 minutes; 60 a person in 10 minutes.
const PHOTO_MAX = 8 * 1024 * 1024;
const photoCache = new Map(); const photoRate = new Map();
const photoTooMany = (userId) => { const now = Date.now(); const l = (photoRate.get(userId) || []).filter((t) => now - t < 600000); if (l.length >= 60) { photoRate.set(userId, l); return true; } l.push(now); photoRate.set(userId, l); return false; };
const looksImage = (buf) => (buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 ? 'image/png' : (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : '')));
async function photo(u, q = {}) {
  if (!mayWrite(u)) return { error: 'Your login cannot search for photos.', status: 403 };
  const st = await status();
  if (!st.ready) return { error: st.reason, status: 503, code: 'not_ready' };
  const text = String(q.q || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (text.length < 2) return { error: 'Say what the background should show, for example "office team".', status: 400 };
  const shape = ORIENT[String(q.shape || '').toLowerCase()] || 'square';
  const n = Math.max(0, Math.min(19, Math.floor(Number(q.n)) || 0));
  const c = await active();
  const ck = `${c.p.id}|${text.toLowerCase()}|${shape}|${n}`;
  const hit = photoCache.get(ck);
  if (hit && Date.now() - hit.at < 600000) return hit.data;
  if (photoTooMany(u.id)) return { error: 'Too many photo searches in a few minutes. Wait a little.', status: 429 };
  const list = (await c.p.photos(text, shape, c.key)).filter((x) => hostOk(c.p, x.link));
  if (!list.length) return { error: `No ${c.p.name} photo was found for "${text}". Try other words.`, status: 404, code: 'none' };
  for (let i = 0; i < Math.min(3, list.length); i += 1) {
    const pick = list[(n + i) % list.length];
    let got; try { got = await fetchBytes(c.p, pick.link, PHOTO_MAX); } catch (e) { if (i === 2) throw e; continue; } // eslint-disable-line no-await-in-loop
    if (!got.buf) continue; // eslint-disable-line no-continue
    const mime = looksImage(got.buf);
    if (!mime) continue; // eslint-disable-line no-continue
    const data = { buf: got.buf, mime, author: pick.author, pageUrl: pick.pageUrl, source: c.p.name };
    photoCache.set(ck, { at: Date.now(), data });
    if (photoCache.size > 40) photoCache.delete(photoCache.keys().next().value);
    return data;
  }
  return { error: 'The photo could not be downloaded. Try again or use other words.', status: 502 };
}

// a source / download problem is returned as plain words and a status, never thrown into the route
const safe = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) {
    if (e instanceof AI.AiMkError) return { error: e.message, status: e.status || 502, code: e.code };
    console.error('[omni-mk] stock clips:', e.message); // eslint-disable-line no-console
    return { error: 'Stock clips could not be reached just now. Try again in a minute.', status: 502 };
  }
};
module.exports = { status, meta, search: safe(search), importClip: safe(importClip), photo: safe(photo), testKey, PROVIDERS };
