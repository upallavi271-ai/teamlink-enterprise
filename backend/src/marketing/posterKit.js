// ---------------------------------------------------------------------------
// AI MARKETING > AI IMAGES > POSTER (2026-11-27). Owner: "we have to create like this or better for my clients automatically" (a recruitment flyer; the design is marketing/bannerPoster.js), then: "the
// photo is just for reference, no need of keeping 4 people; keep the client company logo as it is, clearly, and then their services clearly".
//   * each BUSINESS keeps its LOGO and contact details, typed once (table OmniMkPosterKit: our own company, one per client project, one per client business typed by name). The logo is used exactly as
//     uploaded; a client's poster never carries our logo or our contact details. Its colours are read from its logo. The AI never writes a phone number, an address or a link.
//   * the SERVICES are only what a person typed for that business (saved like the contacts): the AI never makes them up. The other WORDS (headline, pill, motto, call to action, post caption) and the description of the photograph (at most two people) are written by the AI from the person's idea (the fast writer,
//     else the app's own model); what the person typed, above all the SERVICES, is used as it is; when the AI cannot answer, plain words are made from the person's own. Nothing is made or posted from
//     here: the screen then makes the photograph and draws the poster (POST /banners, layout 'poster').
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');

const T = 'OmniMkPosterKit';
const DDL = [`CREATE TABLE IF NOT EXISTS "${T}" ("key" TEXT NOT NULL PRIMARY KEY, "data" TEXT, "byId" TEXT, "updatedAt" DATETIME NOT NULL DEFAULT 0)`];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] poster kit schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

const mayWrite = (u) => A.has('mayAiMarketing')(u);
const CONTACT = { companyName: 60, tagline: 60, phone: 24, location: 44, website: 40, email: 48, services: 220 };
const DEFAULT_BLUE = '#0b5ed7';
const one = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const slug = (v) => one(v, 60).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
// which business: a client project, else a client business typed by name, else our own company
const keyOf = (projectId, business) => (S.clip(projectId, 40) ? `project:${S.clip(projectId, 40)}` : (slug(business) ? `biz:${slug(business)}` : 'own'));
const list = (v, count, n) => (Array.isArray(v) ? v : String(v || '').split(/[\n,|;]+/)).map((x) => one(String(x).replace(/^[-•*\d.)\s]+/, ''), n)).filter(Boolean).slice(0, count);

async function projectOf(projectId) {
  const id = S.clip(projectId, 40); if (!id) return null;
  try { return (await S.q('SELECT clientName, occasion, brief, logoData FROM "OmniMkProject" WHERE id = ? AND deletedAt IS NULL', id))[0] || null; } catch { return null; }
}
async function stored(key) {
  const row = (await S.q(`SELECT data FROM "${T}" WHERE "key" = ?`, key))[0];
  try { return row ? JSON.parse(row.data) : null; } catch { return null; }
}
// the main colour of a logo (its strongest colour; white, black and grey do not count), dark enough to carry white words; '' when the logo has none
async function colorOf(buf) {
  try {
    const sharp = require('sharp'); // eslint-disable-line global-require
    const { data } = await sharp(buf).flatten({ background: '#ffffff' }).resize({ width: 80, height: 80, fit: 'inside', kernel: 'nearest' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }); // nearest: the logo's own colours, not blends of its edges
    const bins = new Map(); let total = 0;
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2]; const hi = Math.max(r, g, b); const lo = Math.min(r, g, b); total += 1;
      const light = (hi + lo) / 510; const sat = hi === lo ? 0 : (hi - lo) / (255 - Math.abs(hi + lo - 255));
      if (sat < 0.3 || light > 0.82 || light < 0.1) continue; // eslint-disable-line no-continue
      const hue = hi === r ? ((g - b) / (hi - lo) + 6) % 6 : hi === g ? (b - r) / (hi - lo) + 2 : (r - g) / (hi - lo) + 4;
      const key = Math.floor(hue * 4) % 24; const x = bins.get(key) || { w: 0, n: 0, r: 0, g: 0, b: 0 };
      x.w += sat; x.n += 1; x.r += r; x.g += g; x.b += b; bins.set(key, x);
    }
    const best = [...bins.values()].sort((a, b) => b.w - a.w)[0];
    if (!best || best.n < total * 0.015) return '';
    let c = [best.r / best.n, best.g / best.n, best.b / best.n];
    const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; if (lum > 0.46) c = c.map((v) => v * (0.46 / lum));
    return `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
  } catch { return ''; }
}
// what is known before anything was saved: our own brand kit, or the client's name (never our details for a client)
async function defaults(project, business) {
  const empty = { companyName: '', tagline: '', phone: '', location: '', website: '', email: '', services: '' };
  if (project) return { ...empty, companyName: one(project.clientName, 60) };
  if (slug(business)) return { ...empty, companyName: one(business, 60) };
  const b = await Cfg.getBrand(); const contact = String(b.contact || '');
  const email = (contact.match(/[^\s,;|]+@[^\s,;|]+\.[a-z]{2,}/i) || [''])[0];
  const phone = (contact.replace(email, ' ').match(/\+?\d[\d \-()]{6,18}\d/) || [''])[0];
  return { ...empty, companyName: one(b.brandName, 60), tagline: one(b.tagline, 60), website: one(String(b.website || '').replace(/^https?:\/\//i, '').replace(/\/$/, ''), 40), email: one(email, 48), phone: one(phone, 24) };
}
// the logo a poster of this business will carry: the one saved here, else the client project's, else (our own company only) the brand logo
async function logoOf(key, saved, project) {
  if (saved && saved.logo) return saved.logo;
  if (project) return project.logoData || '';
  if (key === 'own') { const l = await Cfg.getLogo(); return l ? l.dataUrl : ''; }
  return '';
}
// the client businesses saved before, newest first
async function businesses() {
  const rows = await S.q(`SELECT "key" AS k, data FROM "${T}" WHERE "key" LIKE 'biz:%' ORDER BY updatedAt DESC LIMIT 200`);
  return rows.map((r) => { try { return one(JSON.parse(r.data).business, 60); } catch { return ''; } }).filter(Boolean);
}
async function getKit(u, projectId, business) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to create.', status: 403 };
  await ensure();
  const project = await projectOf(projectId); if (S.clip(projectId, 40) && !project) return { error: 'That client project was not found.', status: 404 };
  const biz = project ? '' : business; const key = keyOf(projectId, biz);
  const saved = await stored(key);
  const kit = { ...(await defaults(project, biz)) }; if (saved) for (const k of Object.keys(CONTACT)) if (saved[k] !== undefined) kit[k] = saved[k];
  kit.website = Cfg.publicSite(kit.website);
  return { key, kit, logo: await logoOf(key, saved, project), saved: !!saved, businesses: await businesses() };
}
// only the fields that were sent are changed (an empty one clears that detail). logoDataUrl: a new logo; removeLogo: forget the saved one
async function saveKit(u, projectId, b = {}) {
  const got = await getKit(u, projectId, b.business); if (got.error) return got;
  const prev = (await stored(got.key)) || {}; const next = { ...prev }; let changed = false;
  if (got.key.startsWith('biz:')) next.business = one(b.business, 60);
  for (const [k, n] of Object.entries(CONTACT)) if (b[k] !== undefined) { next[k] = k === 'services' ? one(list(b[k], 6, 34).join(', '), n) : one(b[k], n); changed = true; }
  if (b.logoDataUrl) {
    const l = Cfg.cleanLogo({ dataUrl: b.logoDataUrl }); if (l.error) return { error: l.error, status: 400 };
    next.logo = l.value.dataUrl; next.color = await colorOf(Buffer.from(next.logo.split(',')[1], 'base64')); changed = true;
  } else if (b.removeLogo === true) { delete next.logo; delete next.color; changed = true; }
  if (changed || (got.key.startsWith('biz:') && !got.saved)) {
    await S.run(`INSERT INTO "${T}" ("key", data, byId, updatedAt) VALUES (?,?,?,?) ON CONFLICT("key") DO UPDATE SET data = excluded.data, byId = excluded.byId, updatedAt = excluded.updatedAt`, got.key, JSON.stringify(next), u.id, Date.now());
  }
  return getKit(u, projectId, b.business);
}
// for the banner drawer (images.js lookFor): whose logo, name and colours a poster carries. null = our own brand as it is
async function look(posterKey, project) {
  await ensure();
  const key = String(posterKey || '');
  if (project) {
    const saved = key.startsWith('project:') ? await stored(key) : null;
    return { clientName: project.clientName, logoData: (saved && saved.logo) || project.logoData || null, colors: project.colors || (saved && saved.color ? { primary: saved.color } : null) };
  }
  if (key.startsWith('biz:')) { const s = (await stored(key)) || {}; return { clientName: s.companyName || s.business || '', logoData: s.logo || null, colors: { primary: s.color || DEFAULT_BLUE } }; }
  const own = await stored('own'); if (!own || !own.logo) return null;
  const brand = await Cfg.getBrand(); return { clientName: own.companyName || brand.brandName, logoData: own.logo, colors: null };
}

// ---- the words -----------------------------------------------------------------------------------------------------------------------------------------------------------
const LIMIT = { headline: 22, headline2: 24, sub: 52, motto: 36, motto2: 28, cta: 40, closing: 52 };
// a number, link, e-mail, price or offer the person never wrote must not appear on their poster
function invented(text, given) {
  const hits = String(text || '').match(/\d[\d,. ]*|https?:\/\/\S+|www\.\S+|\S+@\S+|[%₹]|\b(?:free|discount|offer|guaranteed?|no\.? ?1|best)\b/gi) || [];
  const own = String(given).toLowerCase().replace(/[ ,]/g, '');
  return hits.some((h) => !own.includes(h.toLowerCase().replace(/[ ,.]+$/, '').replace(/[ ,]/g, '')));
}
const NO_TEXT = 'At most two people, any people are Indian, a clear simple composition with empty space around the subject, bright clean background, professional photography, no text, no letters, no logos, no watermark';
// plain words from the person's own, when the AI cannot answer
function fromOwnWords({ heading, title, topic, content, who }) {
  const main = one(heading || title || String(topic).split(/[.:\n]/)[0].replace(/^topic\s*/i, ''), 46) || who;
  const words = main.split(' '); let cut = Math.ceil(words.length / 2);
  while (cut > 1 && words.slice(0, cut).join(' ').length > LIMIT.headline) cut -= 1;
  const lines = String(content || '').split('\n').map((x) => one(x, 60)).filter(Boolean);
  return { headline: words.length > 1 ? words.slice(0, cut).join(' ') : '', headline2: words.length > 1 ? words.slice(cut).join(' ') : main, sub: one(lines[0] || '', LIMIT.sub), motto: '', motto2: '', cta: one(who ? `Contact ${who}` : 'Contact us today', LIMIT.cta), closing: '', heroPrompt: `A photograph about: ${one(topic, 160)}`, caption: one(lines.join(' ') || topic, 400) };
}

// b: { projectId, business, idea, title, heading, content, cta, services, motto, motto2, closing, logoDataUrl, department, + the contact fields (saved) }
async function write(u, b = {}) {
  if (!mayWrite(u)) return { error: 'Your login can look at AI Marketing but not use it to create.', status: 403 };
  const idea = String(b.idea || b.prompt || '').replace(/\r/g, '').trim().slice(0, 800); const title = one(b.title, 80); const heading = one(b.heading, 80);
  const content = String(b.content || '').replace(/\r/g, '').trim().slice(0, 1200);
  const project = await projectOf(b.projectId);
  const topic = idea || heading || title || content || (project ? one(`${project.occasion || ''} ${project.brief || ''}`, 600) : '');
  if (one(topic, 80).length < 3) return { error: 'Write the idea for the poster first (the topic and who it is for).', status: 400 };
  const saved = await saveKit(u, b.projectId, b); if (saved.error) return saved;
  const kit = saved.kit; const brand = await Cfg.getBrand(); const ours = saved.key === 'own';
  const who = kit.companyName || (project && project.clientName) || (ours ? brand.brandName : one(b.business, 60)) || '';
  const mine = { services: list(kit.services, 6, 34), roles: list(b.roles, 3, 24), motto: one(b.motto, LIMIT.motto), motto2: one(b.motto2, LIMIT.motto2), cta: one(b.cta, LIMIT.cta), closing: one(b.closing, LIMIT.closing) };
  const given = [idea, heading, title, content, who, kit.tagline, project ? `${project.occasion || ''} ${project.brief || ''}` : '', ...mine.services, ...mine.roles, mine.motto, mine.motto2, mine.cta, mine.closing].join(' \n ');
  const system = [
    'You write the words of one promotional poster for a business in India, and describe its photograph.',
    `headline: the first big line, 1 or 2 words, at most ${LIMIT.headline} characters. headline2: the second big line, 1 to 3 words, at most ${LIMIT.headline2} characters. Together they name what the poster is about.`,
    `sub: one short line under the headline, at most ${LIMIT.sub} characters.`,
    'The services of the business are given: never add, rename or invent a service.',
    `motto: the start of a short motto, at most ${LIMIT.motto} characters; motto2: its strong ending, at most ${LIMIT.motto2} characters.`,
    `cta: a call to action, at most ${LIMIT.cta} characters. closing: one warm closing line, at most ${LIMIT.closing} characters.`,
    'heroPrompt: describe ONE clear photograph for this topic, with at most two people (or the place or the product when that says it better): who or what, clothes, place. No words or logos in the picture.',
    'caption: 2 or 3 sentences to post with the picture. hashtags: 3 to 6.',
    'NEVER invent phone numbers, addresses, websites, e-mails, prices, discounts, offers, dates, counts, awards or promises such as guaranteed, free, best or No. 1: use only what is given.',
    brand.language && brand.language !== 'English' && ours ? `Write in ${brand.language}.` : 'Write in English unless the idea is written in another language.',
    ...(ours && brand.avoidWords && brand.avoidWords.length ? [`Never use these words: ${brand.avoidWords.join(', ')}.`] : []),
    'Answer with ONLY a JSON object: {"headline":"","headline2":"","sub":"","motto":"","motto2":"","cta":"","closing":"","heroPrompt":"","caption":"","hashtags":[]}',
  ].join('\n');
  const prompt = [`Business: ${who || 'a business'}`, `Idea: ${topic}`, heading ? `Heading the person wrote: ${heading}` : '', content ? `Content the person wrote:\n${content}` : '', project && project.brief ? `The client's brief: ${one(project.brief, 500)}` : '', mine.services.length ? `The services of the business: ${mine.services.join(', ')}` : ''].filter(Boolean).join('\n');
  const own = fromOwnWords({ heading, title, topic, content, who });
  let ans = null; let note = ''; let provider = ''; let demo = false;
  try {
    const r = await AI.generate({ user: u, module: 'studio', task: 'poster', system, prompt, json: true, fast: { own: true, maxTokens: 700, ms: 15000 }, quickMs: 40000, demo: () => ({ ...own, headline: 'SAMPLE', headline2: 'Poster words', sub: 'Test mode, not written by AI' }), department: S.clip(b.department, 60) || undefined });
    ans = r.result && typeof r.result === 'object' ? r.result : null; provider = r.provider || ''; demo = !!r.demo;
  } catch (e) {
    if (!e.fast && (e.status === 403 || e.status === 429)) return { error: e.message, status: e.status, code: e.code }; // a person's own limit, or AI switched off, is shown as it is
    note = 'The AI writer is busy right now, so the poster words are made from your own. Change them if you like.';
  }
  const pick = (k) => { const v = one(ans && ans[k], LIMIT[k]); return v && !invented(v, given) ? v : one(own[k], LIMIT[k]); };
  const words = {
    headline: pick('headline'), headline2: pick('headline2'), sub: pick('sub'),
    roles: mine.roles, services: mine.services,
    motto: mine.motto || pick('motto'), motto2: mine.motto2 || pick('motto2'), cta: mine.cta || pick('cta'), closing: mine.closing || pick('closing'),
  };
  if (heading && !one(ans && ans.headline2, 40)) { words.headline = own.headline; words.headline2 = own.headline2; }
  if (!saved.logo) note = `${note ? `${note} ` : ''}No logo is saved for ${who || 'this business'}, so its name is written instead. Upload the logo to show it.`;
  if (!mine.services.length) note = `${note ? `${note} ` : ''}No services are listed for ${who || 'this business'}: type them in SERVICES so the picture says what is offered.`;
  const scene = one(ans && ans.heroPrompt, 360) || own.heroPrompt;
  const caption = one(ans && ans.caption, 500);
  const hashtags = list(ans && ans.hashtags, 6, 40).map((h) => `#${h.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`).filter((h) => h.length > 1);
  return {
    poster: { ...words, servicesTitle: words.services.length ? 'Our Services' : '', posterKey: saved.key, companyName: who, tagline: kit.tagline, phone: kit.phone, location: kit.location, website: kit.website, email: kit.email, heroPrompt: `${scene.replace(/[.\s]+$/, '')}. ${NO_TEXT}`, heroSearch: one([words.headline, words.headline2].filter(Boolean).join(' '), 60), caption: caption && !invented(caption, given) ? caption : own.caption, hashtags },
    kit, logo: saved.logo, note, provider, demo,
  };
}

module.exports = { ensure, getKit, saveKit, write, look, colorOf, invented, fromOwnWords, keyOf };
