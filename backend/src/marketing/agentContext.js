// ---------------------------------------------------------------------------
// AI MARKETING > AI AGENT > BUSINESS CONTEXT (2026-11-25). "The user never explains twice": what the agent knows about a business, saved once and reused by every goal.
//   A business is either OUR OWN company ('own': the brand kit of AI Marketing > Brand voice is the starting point) or a CLIENT ('c:<name>').
//   WHERE THE FACTS COME FROM (each fact says where it came from, nothing is guessed):
//     * the brand kit (name, about, audience, website, contact, colours, logo, social pages, hashtags, key messages, language, tone, never-say words),
//     * the client plan (what the client does), the latest saved website check (the website), the client's latest project (logo and colours),
//     * what a person typed to the agent (saved here, table OmniMkAgentBiz; it wins over everything else).
//   WHAT IS NEVER TAKEN: the client's personal contact name, phone number or email. The line captions use to say "call us" is typed by a person (contactLine) and is used word for word.
//   WHAT IS NEVER INVENTED: services, prices, years, awards, results. A fact the agent does not have is asked for once; "skip" is remembered (skips) so it is not asked again.
// Nothing here sends, posts or calls anything. Audit: "Omni-Channel AI Marketing: agent business context ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkAgentBiz';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL DEFAULT '', "data" TEXT NOT NULL DEFAULT '{}', "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "updatedById" TEXT, "updatedByName" TEXT)`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] agent context schema:', e.message); return false; } // eslint-disable-line no-console
}

const mayWrite = (u) => A.has('mayAiMarketing')(u);
const OWN = 'own';
const slug = (name) => String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, '-').slice(0, 60);
const keyOfName = (name) => { const s = slug(name); return s ? `c:${s}` : ''; };
const HEX = /^#[0-9a-f]{6}$/i;
const urlOk = (v) => { try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; } };

// the facts, with their words: kind text | list | url ; `ask` is the question the agent puts when it needs the fact
const FIELDS = {
  name: { label: 'Business name', kind: 'text', max: 80, ask: 'What is the name of the business, exactly as customers know it?', hint: 'For example: TeamLink Consultants' },
  industry: { label: 'What the business does', kind: 'text', max: 120, ask: 'In a few words, what does the business do?', hint: 'For example: Recruitment consultancy' },
  about: { label: 'About the business', kind: 'text', max: 400, ask: 'Two plain sentences about the business (only true facts).', hint: 'Used in the introduction post' },
  services: { label: 'Services or products', kind: 'list', max: 8, each: 60, ask: 'Which services or products should the posts talk about? One per line, the main ones first.', hint: 'For example: Permanent recruitment, Contract staffing, HR consulting' },
  audience: { label: 'Who you want to reach', kind: 'text', max: 200, ask: 'Who do you want to reach?', hint: 'For example: Small and mid-size companies hiring in Hyderabad' },
  locations: { label: 'Where (cities or areas)', kind: 'list', max: 6, each: 40, ask: 'Which cities or areas do you serve?', hint: 'For example: Hyderabad, Secunderabad' },
  website: { label: 'Website', kind: 'url', max: 200, ask: 'What is the website address?', hint: 'Starts with https://' },
  contactLine: { label: 'How people reach you (used word for word)', kind: 'text', max: 100, ask: 'How should people reach you? Write it exactly as it should appear on the posts.', hint: 'For example: Call 040 1234 5678 or WhatsApp us' },
  tagline: { label: 'Tagline', kind: 'text', max: 120 },
  keyMessages: { label: 'Key messages (true facts you always say)', kind: 'list', max: 6, each: 160 },
  hashtags: { label: 'Hashtags', kind: 'list', max: 10, each: 40 },
  tone: { label: 'Tone', kind: 'text', max: 40 },
  language: { label: 'Language', kind: 'text', max: 20 },
  avoid: { label: 'Words never to use', kind: 'list', max: 20, each: 40 },
  notes: { label: 'Your preferences and rules for the agent', kind: 'text', max: 600 },
};
const SOCIAL_KEYS = ['facebook', 'instagram', 'linkedin', 'x'];
const clip = (s, n) => S.clip(String(s == null ? '' : s).replace(/[\r\t]+/g, ' ').replace(/ {2,}/g, ' '), n);
const listOf = (v, max, each) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\n;]+|,(?![^(]*\))/)).map((x) => clip(x, each)).filter(Boolean).filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, max);

// -> { value, notes } or { error }: only known facts are kept; what was shortened is said
function clean(patch) {
  const b = patch && typeof patch === 'object' ? patch : {}; const out = {}; const notes = [];
  for (const [k, def] of Object.entries(FIELDS)) {
    if (b[k] === undefined) continue;
    if (def.kind === 'list') {
      const raw = Array.isArray(b[k]) ? b[k] : String(b[k] == null ? '' : b[k]).split(/[\n;,]+/).filter((x) => x.trim());
      out[k] = listOf(b[k], def.max, def.each);
      if (raw.length > def.max) notes.push(`${def.label}: only the first ${def.max} are kept.`);
    } else if (def.kind === 'url') {
      const v = clip(b[k], def.max);
      const full = v && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
      if (full && !urlOk(full)) return { error: 'The website must be a web address such as https://example.com.' };
      out[k] = full;
    } else out[k] = clip(b[k], def.max);
  }
  if (b.socials !== undefined && b.socials && typeof b.socials === 'object') out.socials = Object.fromEntries(SOCIAL_KEYS.map((k) => [k, clip(b.socials[k], 120)]));
  if (b.colors !== undefined && b.colors && typeof b.colors === 'object') {
    out.colors = {};
    for (const k of ['primary', 'secondary', 'accent']) { const c = b.colors[k]; if (c) { if (!HEX.test(c)) return { error: `The ${k} colour must look like #0f766e.` }; out.colors[k] = c.toLowerCase(); } }
  }
  if (b.skips !== undefined) out.skips = (Array.isArray(b.skips) ? b.skips : []).map(String).filter((k) => FIELDS[k] && !['name', 'services', 'website'].includes(k)).filter((k, i, a) => a.indexOf(k) === i);
  return { value: out, notes };
}

const rowOf = async (key) => (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, key))[0] || null;
const parse = (r) => (r ? S.parse(r.data, {}) || {} : {});

// ---- what the other modules already know (read only, each part optional) ----------------------------------------------------------------------------------------------------
async function fromBrand() {
  const b = await Cfg.getBrand(); const f = {}; const has = (v) => (Array.isArray(v) ? v.length : !!v);
  const put = (k, v) => { if (has(v)) f[k] = v; };
  put('name', b.brandName); put('about', b.about); put('audience', b.audience); put('industry', (b.industries || []).join(', ')); put('keyMessages', b.keyMessages); put('tagline', b.tagline);
  put('website', b.website); put('contactLine', b.contact); put('hashtags', b.hashtags); put('tone', b.tone); put('language', b.language); put('avoid', b.avoidWords);
  f.colors = b.colors; f.socials = b.socials; f.hasLogo = !!b.hasLogo;
  return f;
}
async function fromClient(u, name) {
  const f = {}; const info = { plan: null, siteCheck: null, gbp: null, project: null };
  const same = (v) => String(v || '').trim().toLowerCase() === name.trim().toLowerCase();
  try {
    const CS = require('./clientServices'); // eslint-disable-line global-require
    const pl = await CS.listPlans(u, {});
    const p = (pl.items || []).find((x) => same(x.clientName));
    if (p) { if (p.industry) f.industry = p.industry; info.plan = { label: p.planLabel || p.plan, status: p.status, endDate: p.endDate || null }; }
  } catch { /* the plans are not there yet */ }
  try {
    const Site = require('./siteCheck'); // eslint-disable-line global-require
    const s = await Site.latestFor(u, name);
    if (s) { if (s.url) f.website = s.url; info.siteCheck = { url: s.url, score: s.score, at: s.createdAt }; }
  } catch { /* none */ }
  try {
    const g = (await S.q('SELECT score, band, createdAt FROM "OmniMkGbpAudit" WHERE lower(clientName) = ? ORDER BY createdAt DESC LIMIT 1', name.trim().toLowerCase()))[0];
    if (g) info.gbp = { score: S.num(g.score), band: g.band || '', at: S.iso(g.createdAt) };
  } catch { /* none */ }
  try {
    const r = (await S.q('SELECT id, logoData, colors FROM "OmniMkProject" WHERE lower(clientName) = ? AND deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 1', name.trim().toLowerCase()))[0];
    if (r) {
      let colors = null; try { colors = r.colors ? JSON.parse(r.colors) : null; } catch { colors = null; }
      if (colors && colors.primary) f.colors = colors;
      f.hasLogo = !!r.logoData; info.project = { id: r.id };
    }
  } catch { /* none */ }
  return { f, info };
}

// the clients this login can see (client plans, client projects) + the businesses already saved here, for the picker
async function businesses(u) {
  await ensure(); const out = new Map(); const brand = await Cfg.getBrand();
  out.set(OWN, { key: OWN, name: brand.brandName || 'Our own company', own: true, saved: false });
  for (const r of await S.q(`SELECT id, name, updatedAt FROM "${T}" ORDER BY updatedAt DESC LIMIT 200`)) if (r.id !== OWN) out.set(r.id, { key: r.id, name: r.name, own: false, saved: true });
  if (out.has(OWN)) out.get(OWN).saved = !!(await rowOf(OWN));
  const add = (name) => { const key = keyOfName(name); if (key && !out.has(key)) out.set(key, { key, name: clip(name, 80), own: false, saved: false }); };
  try { const CS = require('./clientServices'); ((await CS.listPlans(u, {})).items || []).forEach((p) => add(p.clientName)); } catch { /* none */ } // eslint-disable-line global-require
  try { (await S.q('SELECT DISTINCT clientName FROM "OmniMkProject" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 100')).forEach((r) => add(r.clientName)); } catch { /* none */ }
  return [...out.values()];
}

// -> { key, name, context, sources, info, saved }   context = the facts to plan with (saved ones win), sources[field] = where each fact came from
async function resolve(u, ref, nameHint) {
  await ensure();
  const raw = String(ref || OWN).trim();
  let key = raw === OWN || !raw ? OWN : (raw.startsWith('c:') ? raw : keyOfName(raw));
  if (!key) key = OWN;
  const row = await rowOf(key);
  const saved = parse(row);
  let name = row ? row.name : '';
  const derived = {}; let info = {};
  if (key === OWN) Object.assign(derived, await fromBrand());
  else {
    if (!name) name = clip(nameHint, 80) || (raw.startsWith('c:') ? raw.slice(2).replace(/-/g, ' ') : raw);
    const c = await fromClient(u, name); Object.assign(derived, c.f); info = c.info;
  }
  const context = { ...derived }; const sources = {};
  const has = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.values(v).some(Boolean) : !!v);
  const brandKit = key === OWN ? 'the brand kit' : null;
  for (const k of Object.keys(derived)) if (has(derived[k])) sources[k] = brandKit || (k === 'website' ? 'the latest website check' : k === 'industry' ? 'the client plan' : k === 'colors' || k === 'hasLogo' ? 'the client project' : 'saved');
  for (const k of [...Object.keys(FIELDS), 'socials', 'colors']) {
    if (has(saved[k])) { context[k] = k === 'colors' ? { ...(derived.colors || {}), ...saved[k] } : saved[k]; sources[k] = `typed by ${row.updatedByName || 'a team member'}`; }
  }
  if (!context.name) context.name = name || '';
  if (context.name) sources.name = sources.name || 'saved';
  for (const [k, d] of Object.entries(FIELDS)) if (d.kind === 'list' && !Array.isArray(context[k])) context[k] = [];
  context.skips = Array.isArray(saved.skips) ? saved.skips : [];
  context.language = context.language || 'English';
  return { key, name: context.name || name || (key === OWN ? 'Our own company' : ''), context, sources, info, saved: !!row, updatedAt: row ? S.iso(row.updatedAt) : null, updatedByName: row ? row.updatedByName || '' : '' };
}

// merge a person's facts into the saved record (only the fields sent change). ref: 'own' or a client name / key.
async function save(u, ref, patch, opts = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at the agent but not save business facts.', status: 403 };
  const c = clean(patch); if (c.error) return { error: c.error, status: 400 };
  const cur = await resolve(u, ref); const key = cur.key;
  const row = await rowOf(key); const saved = parse(row);
  const next = { ...saved, ...c.value };
  // "skip" is remembered so the question is not asked again; a fact that is then given is no longer skipped
  const skips = new Set([...(saved.skips || []), ...(c.value.skips || [])]);
  for (const [k, v] of Object.entries(c.value)) {
    if (k === 'skips') continue;
    const given = Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.values(v).some(Boolean) : !!v;
    if (given && !(c.value.skips || []).includes(k)) skips.delete(k);
  }
  next.skips = [...skips];
  const name = clip(c.value.name || (row && row.name) || cur.name || (key === OWN ? (await Cfg.getBrand()).brandName : ''), 80);
  if (key !== OWN && !name) return { error: 'Write the business name first.', status: 400 };
  const now = Date.now();
  if (row) await S.run(`UPDATE "${T}" SET name = ?, data = ?, updatedAt = ?, updatedById = ?, updatedByName = ? WHERE id = ?`, name, JSON.stringify(next), now, u.id, S.clip(u.name, 80), key);
  else await S.run(`INSERT INTO "${T}" (id, name, data, createdAt, updatedAt, updatedById, updatedByName) VALUES (?,?,?,?,?,?,?)`, key, name, JSON.stringify(next), now, now, u.id, S.clip(u.name, 80));
  if (!opts.quiet) await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: agent business context saved', entity: T, entityId: key, toValue: `${name}: ${Object.keys(c.value).join(', ') || 'nothing changed'}` });
  return { ...(await resolve(u, key)), notes: c.notes };
}

// which facts a goal needs and which are still missing -> [{ key, label, ask, hint, kind, required, skippable }]
const NEVER_SKIP = ['name', 'services', 'website'];
const present = (ctx, k) => (Array.isArray(ctx[k]) ? ctx[k].length > 0 : !!ctx[k]);
function missing(ctx, essentials, optional = [], hints = {}) {
  const skips = ctx.skips || []; const out = [];
  const add = (k, required) => {
    if (present(ctx, k)) return;
    if (skips.includes(k)) return;
    const d = FIELDS[k];
    out.push({ key: k, label: d.label, ask: d.ask || `${d.label}?`, hint: d.hint || '', kind: d.kind, required, skippable: !NEVER_SKIP.includes(k), suggest: hints[k] || '' });
  };
  essentials.forEach((k) => add(k, true)); optional.forEach((k) => add(k, false));
  return out;
}

module.exports = { ensure, FIELDS, OWN, keyOfName, slug, clean, businesses, resolve, save, missing, mayWrite, listOf, SOCIAL_KEYS };
