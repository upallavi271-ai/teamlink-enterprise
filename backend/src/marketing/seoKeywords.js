// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > KEYWORDS (2026-11-25). Keyword RESEARCH and keyword TRACKING from what is real:
//   * RESEARCH   primary, secondary, long-tail, local and brand phrases for a client, made with plain code from the facts typed for the client (business name, kind of business, services, city, areas,
//                audience) and the industry pack's own local phrases; each phrase has a SEARCH INTENT (informational, commercial, transactional, navigational, local) guessed from its words;
//   * LISTS      the phrases the team keeps for a client (saved, "tracked" or not);
//   * TRACKING   Google Search Console "Queries" exports pasted as CSV (the same export the monthly report reads): each import is a dated snapshot of the real queries, clicks, impressions and average
//                position. A tracked phrase shows its position in the newest snapshot and in the one before; the queries at position 4 to 20 are the real keyword OPPORTUNITIES.
// HONEST BY DESIGN: SEARCH VOLUME AND KEYWORD DIFFICULTY ARE NOT AVAILABLE: no reliable free data source exists and no provider is connected, so every phrase shows them as "not available" and nothing is
// estimated. A phrase is a research idea, never a promise of traffic or a ranking. A position is what Search Console reported for the period, not a cause. Intent is a guess from the words.
// saved: tables OmniMkSeoKeyword, OmniMkSeoRankSet, OmniMkSeoRank; audit log "Omni-Channel AI Marketing: SEO keywords ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Sites = require('./seoSites');
const Copy = require('./seoCopy');
const Packs = require('./industryPacks');
const Mrep = require('./monthlyReport');
const { logAudit } = require('../utils/audit');

const TK = 'OmniMkSeoKeyword'; const TS = 'OmniMkSeoRankSet'; const TR = 'OmniMkSeoRank';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TK}" ("id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL, "phrase" TEXT NOT NULL, "phraseKey" TEXT NOT NULL, "grp" TEXT NOT NULL DEFAULT 'typed', "intent" TEXT, "tracked" INTEGER NOT NULL DEFAULT 0, "source" TEXT NOT NULL DEFAULT 'research', "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${TK}_one" ON "${TK}"("siteId", "phraseKey")`,
  `CREATE TABLE IF NOT EXISTS "${TS}" ("id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL, "label" TEXT, "periodEnd" TEXT NOT NULL, "rows" INTEGER NOT NULL DEFAULT 0, "clicks" INTEGER NOT NULL DEFAULT 0, "impressions" INTEGER NOT NULL DEFAULT 0, "source" TEXT, "importedById" TEXT, "importedByName" TEXT, "importedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${TS}_site" ON "${TS}"("siteId", "periodEnd")`,
  `CREATE TABLE IF NOT EXISTS "${TR}" ("id" TEXT NOT NULL PRIMARY KEY, "setId" TEXT NOT NULL, "siteId" TEXT NOT NULL, "query" TEXT NOT NULL, "queryKey" TEXT NOT NULL, "clicks" REAL, "impressions" REAL, "ctr" REAL, "position" REAL)`,
  `CREATE INDEX IF NOT EXISTS "${TR}_set" ON "${TR}"("setId")`,
  `CREATE INDEX IF NOT EXISTS "${TR}_q" ON "${TR}"("siteId", "queryKey")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] seo keyword schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const key = (p) => String(p || '').toLowerCase().replace(/\s+/g, ' ').trim();
const NA = 'not available';
const PROVIDER = { connected: false, volume: NA, difficulty: NA, note: 'Search volume and keyword difficulty need a keyword data provider, and none is connected. Free sources do not give reliable numbers, so TeamLink shows "not available" and never estimates them. For real numbers, use the Search Console queries below.' };
const NOUN = { doctor: 'doctor', clinic: 'clinic', hospital: 'hospital', it: 'company', manufacturing: 'manufacturer', education: 'institute', other: 'provider' };
const INTENTS = { informational: 'Wants to learn', commercial: 'Comparing or checking cost', transactional: 'Ready to act (book, buy, call)', navigational: 'Looking for this business by name', local: 'Looking for a place near them' };

// the search intent of a phrase, guessed from its words. brand: the business name (a phrase with it is navigational)
function intentOf(phrase, brand) {
  const p = key(phrase); if (brand && key(brand).length > 2 && p.includes(key(brand))) return 'navigational';
  if (/^(how|what|why|when|which|who|can|does|do|is|are|should|questions)\b/.test(p) || /\b(guide|tips|symptoms|causes|meaning|difference|steps|process|benefits)\b/.test(p)) return 'informational';
  if (/\b(book|appointment|buy|order|enrol|enroll|admission|register|contact|call|hire|quote)\b/.test(p)) return 'transactional';
  if (/\b(near me|nearby|near)\b/.test(p)) return 'local';
  if (/\b(best|top|cost|price|prices|fees|charges|reviews|compare|cheap|affordable|vs|versus)\b/.test(p)) return 'commercial';
  return 'local';
}

// the phrases for a client's facts: F = Copy.facts(...). -> { groups, total, needs, notes }
function generate(F, o = {}) {
  const svc = F.services.slice(0, 4); const sp = F.specialty; const main = svc.length ? svc : (sp ? [sp] : []); const loc = F.city ? ` in ${F.city}` : ''; const noun = NOUN[F.industry] || 'provider'; const low = (s) => s.toLowerCase();
  const needs = []; const notes = [];
  if (!main.length) return { groups: [], total: 0, needs: ['services'], notes: ['Add the main services (or the specialty) to get phrases.'], error: 'Write at least one service or product (or the main specialty).', status: 400 };
  if (!F.city) { needs.push('city'); notes.push('No city is set, so there are no local phrases with a place. Add the city to get them.'); }
  // searches are not case sensitive: phrases are lower case (like the Search Console queries); a brand keeps its capitals
  const G = { primary: [], secondary: [], longtail: [], local: [], brand: [] }; const seen = new Set();
  const add = (g, phrase) => { const p = (g === 'brand' ? String(phrase) : String(phrase).toLowerCase()).replace(/\s+/g, ' ').trim(); const k = key(p); if (!p || p.length < 4 || p.length > 90 || seen.has(k)) return; seen.add(k); G[g].push(p); };
  // PRIMARY: the main service with the place, and the specialty with the kind of business
  main.slice(0, 3).forEach((s) => add('primary', `${low(s)}${loc}`)); if (sp && F.city) add('primary', `${low(sp)} ${F.kind}${loc}`); if (F.city) add('primary', `${noun} for ${low(main[0])}${loc}`);
  // SECONDARY: the same services seen from the buyer's side
  // one pattern at a time over the services, so a short list still shows every kind of phrase
  const each = (g, n, pats) => pats.forEach((f) => main.slice(0, n).forEach((s) => { const p = f(low(s)); if (p) add(g, p); }));
  each('secondary', 4, [(s) => `${s} services${loc}`, (s) => `${s} cost${loc}`, (s) => `best ${s}${loc}`, (s) => (F.audience ? `${s} for ${low(F.audience)}${loc}` : ''), (s) => (F.healthcare ? `${s} consultation${loc}` : '')]);
  // LONG-TAIL: questions and specific searches
  if (main.length > 1) add('longtail', `${low(main[0])} vs ${low(main[1])}`);
  each('longtail', 3, [(s) => `how much does ${s} cost${loc}`, (s) => `how to choose a ${noun} for ${s}`, (s) => `what to expect from ${s}`, (s) => `questions to ask before ${s}`, (s) => `how long does ${s} take`]);
  // LOCAL: near me, the areas served, the kind of business with the place
  main.slice(0, 3).forEach((s) => add('local', `${low(s)} near me`)); add('local', `${F.kind} near me`);
  if (F.city) { add('local', `${F.kind}${loc}`); if (sp) add('local', `${low(sp)} ${noun}${loc}`); for (const a of F.areas.slice(0, 5)) { add('local', `${F.kind} in ${a}`); main.slice(0, 2).forEach((s) => add('local', `${low(s)} in ${a}`)); } }
  else if (F.areas.length) for (const a of F.areas.slice(0, 5)) main.slice(0, 2).forEach((s) => add('local', `${low(s)} in ${a}`));
  // the industry pack's own local phrases (only the ones with no gap)
  try { const pk = Packs.buildPack(F.industry, { name: F.name, city: F.city, state: F.state, services: F.services.join(', '), specialty: F.specialty }); (pk.keywords || []).forEach((k) => add('local', k)); } catch { /* the pack is optional */ }
  // BRAND: people looking for the business itself
  if (F.name) { add('brand', F.name); if (F.city) add('brand', `${F.name} ${F.city}`); add('brand', `${F.name} reviews`); add('brand', `${F.name} contact number`); add('brand', F.healthcare ? `${F.name} appointment` : `${F.name} address`); }
  const LABEL = { primary: ['Primary', 'The main phrases: what the business is and where. Use them in the home page title, the H1 and the first paragraph.'], secondary: ['Secondary', 'Close variations that bring the same buyer from another side (cost, services, "best"). "Best" is a phrase people search: do not claim it on the page without proof.'], longtail: ['Long-tail', 'Longer, more specific searches, mostly questions. Each is a good blog post or FAQ answer.'], local: ['Local', 'Searches with "near me", the city or the areas served. Use them on the Google profile, the contact page and location pages.'], brand: ['Brand', 'People who already know the business and look for it by name. Make sure the website and the Google profile come first for these.'] };
  const groups = Object.keys(G).map((k) => ({ key: k, label: LABEL[k][0], note: LABEL[k][1], items: G[k].slice(0, k === 'secondary' ? 14 : 12).map((p) => ({ phrase: p, intent: intentOf(p, F.name), volume: null, difficulty: null })) })).filter((g) => g.items.length);
  notes.push('Search intent is a guess from the words of each phrase.', PROVIDER.note);
  if (F.healthcare) notes.push('Healthcare: a doctor or a qualified medical reviewer approves what is written for these phrases before it is published.');
  return { groups, total: groups.reduce((a, g) => a + g.items.length, 0), needs, notes, provider: PROVIDER, intents: INTENTS };
}

// ---- Search Console snapshots ----------------------------------------------------------------------------------------------------------------------------------
const okDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
// the "Queries" export of Search Console: Query, Clicks, Impressions, CTR, Position -> up to 1000 rows
function parseQueries(text) {
  const rows = Mrep.parseCsv(text); if (rows.length < 2) return { error: 'That does not look like a Search Console export (no rows).', status: 400 };
  const head = rows[0].map((h) => String(h).trim().toLowerCase()); const ix = (re) => head.findIndex((h) => re.test(h));
  const q = ix(/quer|top quer|search term/); const c = ix(/click/); const im = ix(/impression/); const ct = ix(/ctr|click.?through/); const po = ix(/position/);
  if (q < 0 || c < 0 || im < 0) return { error: 'The file needs the columns Query (or Top queries), Clicks and Impressions. In Search Console open Performance, choose the Queries tab and press Export > Download CSV.', status: 400 };
  const data = []; for (const r of rows.slice(1)) { const query = S.clip(r[q], 160); const clicks = Mrep.cell(r[c]); const imp = Mrep.cell(r[im]); if (!query || clicks == null || imp == null || /^https?:\/\//i.test(query)) continue; data.push({ query, clicks, impressions: imp, ctr: ct >= 0 ? Mrep.cell(r[ct]) : null, position: po >= 0 ? Mrep.cell(r[po]) : null }); }
  if (!data.length) return { error: 'No rows with a query and numbers were found in that file. Export the Queries tab, not the Pages tab.', status: 400 };
  return { rows: data.slice(0, 1000), read: data.length };
}
async function importQueries(u, siteId, b = {}) {
  if (!(await ensure())) return { error: 'The queries could not be saved.', status: 500 };
  const site = await Sites.mine(u, siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  const p = parseQueries(b.text); if (p.error) return p; const periodEnd = okDay(b.periodEnd) ? String(b.periodEnd) : new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const label = S.clip(b.label, 80) || `Search Console to ${periodEnd}`;
  const set = await storeSnapshot(site, u, p.rows, { label, periodEnd, source: 'Google Search Console CSV' });
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: SEO keywords: Search Console queries imported', entity: TS, entityId: set.id, toValue: `${site.clientName}: ${p.rows.length} queries to ${periodEnd}` });
  return { set: { ...set, read: p.read, truncated: p.read > p.rows.length } };
}
// one dated snapshot of real queries: from a pasted CSV or from the Search Console API (seoGoogle.js). rows: [{ query, clicks, impressions, ctr (percent), position }];
// o: { label, periodEnd, source, clicks, impressions (the property's own totals, when the API gave them), replace: a snapshot of the same source and period is replaced, not doubled }
async function storeSnapshot(site, u, rows, o) {
  if (!(await ensure())) throw new Error('The queries could not be saved.');
  if (o.replace) for (const old of await S.q(`SELECT id FROM "${TS}" WHERE siteId = ? AND periodEnd = ? AND source = ?`, site.id, o.periodEnd, o.source)) { await S.run(`DELETE FROM "${TR}" WHERE setId = ?`, old.id); await S.run(`DELETE FROM "${TS}" WHERE id = ?`, old.id); } // eslint-disable-line no-await-in-loop
  const id = S.newId('srs'); const clicks = o.clicks != null ? o.clicks : rows.reduce((a, r) => a + r.clicks, 0); const imps = o.impressions != null ? o.impressions : rows.reduce((a, r) => a + r.impressions, 0);
  await S.run(`INSERT INTO "${TS}" (id, siteId, label, periodEnd, rows, clicks, impressions, source, importedById, importedByName, importedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, site.id, o.label, o.periodEnd, rows.length, clicks, imps, o.source, u.id, S.clip(u.name, 80), Date.now());
  for (const r of rows) await S.run(`INSERT INTO "${TR}" (id, setId, siteId, query, queryKey, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?,?,?,?)`, S.newId('srk'), id, site.id, r.query, key(r.query), r.clicks, r.impressions, r.ctr, r.position); // eslint-disable-line no-await-in-loop
  return { id, label: o.label, periodEnd: o.periodEnd, rows: rows.length, clicks, impressions: imps, source: o.source };
}
async function sets(siteId, limit = 12) {
  if (!(await ensure())) return [];
  return (await S.q(`SELECT * FROM "${TS}" WHERE siteId = ? ORDER BY periodEnd DESC, importedAt DESC LIMIT ?`, siteId, limit)).map((r) => ({ id: r.id, label: r.label, periodEnd: r.periodEnd, source: r.source || '', rows: S.num(r.rows), clicks: S.num(r.clicks), impressions: S.num(r.impressions), importedByName: r.importedByName || '', importedAt: S.iso(r.importedAt) }));
}
// the REAL opportunities of the newest snapshot: queries at position 4 to 20 (close to the first page), the most seen first. saved: which are already on the client's list.
async function opportunities(siteId, limit = 15) {
  if (!(await ensure())) return { set: null, items: [] };
  const set = (await sets(siteId, 1))[0]; if (!set) return { set: null, items: [] };
  const rows = await S.q(`SELECT query, queryKey, clicks, impressions, ctr, position FROM "${TR}" WHERE setId = ? AND position >= 4 AND position <= 20 AND impressions > 0 ORDER BY impressions DESC LIMIT ?`, set.id, limit);
  const have = new Set((await S.q(`SELECT phraseKey FROM "${TK}" WHERE siteId = ?`, siteId)).map((r) => r.phraseKey));
  return { set, items: rows.map((r) => ({ query: r.query, clicks: Math.round(Number(r.clicks)), impressions: Math.round(Number(r.impressions)), ctr: r.ctr == null ? null : Number(r.ctr), position: Math.round(Number(r.position) * 10) / 10, saved: have.has(r.queryKey), band: Number(r.position) <= 10 ? 'on the first page, lower down' : 'on the second page' })) };
}

// the snapshots and the opportunities of a site this login may see
async function queryView(u, siteId) {
  const site = await Sites.mine(u, siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  return { sets: await sets(site.id), ...(await opportunities(site.id, 20)) };
}

// ---- the client's list ------------------------------------------------------------------------------------------------------------------------------------------
const GROUPS = ['primary', 'secondary', 'longtail', 'local', 'brand', 'typed', 'query'];
async function save(u, siteId, b = {}) {
  if (!(await ensure())) return { error: 'The keywords could not be saved.', status: 500 };
  const site = await Sites.mine(u, siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  const list = (Array.isArray(b.phrases) ? b.phrases : []).slice(0, 100); if (!list.length) return { error: 'Choose at least one phrase to keep.', status: 400 };
  let added = 0; let had = 0; const F = Copy.facts({ name: Sites.factsOut(site.facts).name });
  for (const x of list) {
    const phrase = S.clip(typeof x === 'string' ? x : x && x.phrase, 90).replace(/\s+/g, ' '); if (phrase.length < 2) continue; const k = key(phrase);
    if ((await S.q(`SELECT id FROM "${TK}" WHERE siteId = ? AND phraseKey = ?`, site.id, k))[0]) { had += 1; continue; } // eslint-disable-line no-await-in-loop
    const grp = GROUPS.includes(x && x.group) ? x.group : 'typed'; const intent = INTENTS[x && x.intent] ? x.intent : intentOf(phrase, F.name);
    await S.run(`INSERT INTO "${TK}" (id, siteId, phrase, phraseKey, grp, intent, tracked, source, createdAt) VALUES (?,?,?,?,?,?,?,?,?)`, S.newId('skw'), site.id, phrase, k, grp, intent, b.tracked ? 1 : 0, S.clip(x && x.source, 20) || 'research', Date.now()); added += 1; // eslint-disable-line no-await-in-loop
  }
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: SEO keywords saved', entity: TK, entityId: site.id, toValue: `${site.clientName}: ${added} new` });
  return { added, alreadyThere: had };
}
// the saved phrases with the position in the newest snapshot and the one before (a lower number is a better position)
async function list(u, siteId) {
  if (!(await ensure())) return { error: 'The keywords could not be opened.', status: 500 };
  const site = await Sites.mine(u, siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  const ss = await sets(site.id, 2); const rows = await S.q(`SELECT * FROM "${TK}" WHERE siteId = ? ORDER BY tracked DESC, createdAt DESC LIMIT 500`, site.id);
  const at = async (set) => { const m = new Map(); if (!set) return m; for (const r of await S.q(`SELECT queryKey, clicks, impressions, ctr, position FROM "${TR}" WHERE setId = ?`, set.id)) m.set(r.queryKey, r); return m; };
  const now = await at(ss[0]); const before = await at(ss[1]);
  const items = rows.map((r) => { const a = now.get(r.phraseKey); const b = before.get(r.phraseKey); const pos = a && a.position != null ? Math.round(Number(a.position) * 10) / 10 : null; const prev = b && b.position != null ? Math.round(Number(b.position) * 10) / 10 : null;
    return { id: r.id, phrase: r.phrase, group: r.grp, intent: r.intent || 'local', tracked: S.num(r.tracked) === 1, source: r.source, volume: null, difficulty: null, position: pos, previous: prev, change: pos != null && prev != null ? Math.round((prev - pos) * 10) / 10 : null, clicks: a ? Math.round(Number(a.clicks)) : null, impressions: a ? Math.round(Number(a.impressions)) : null, inSnapshot: Boolean(a) }; });
  return { items, sets: ss, provider: PROVIDER, note: 'A position is what Search Console reported on average for the period of the export; "change" compares the two newest exports. A phrase with no row was not searched enough to appear.' };
}
async function setTracked(u, id, tracked) {
  if (!(await ensure())) return { error: 'The keyword could not be saved.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${TK}" WHERE id = ?`, S.clip(id, 60)))[0]; if (!r || !(await Sites.mine(u, r.siteId))) return { error: 'That keyword was not found.', status: 404 };
  await S.run(`UPDATE "${TK}" SET tracked = ? WHERE id = ?`, tracked ? 1 : 0, r.id); return { ok: true, tracked: !!tracked };
}
async function remove(u, id) {
  if (!(await ensure())) return { error: 'The keyword could not be removed.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${TK}" WHERE id = ?`, S.clip(id, 60)))[0]; if (!r || !(await Sites.mine(u, r.siteId))) return { error: 'That keyword was not found.', status: 404 };
  await S.run(`DELETE FROM "${TK}" WHERE id = ?`, r.id); return { ok: true };
}

// the phrases for a request: siteId (its facts) and/or typed facts; typed facts win. -> generate()
async function research(u, b = {}) {
  let base = {}; let industry = b.industry;
  if (b.siteId) { const site = await Sites.mine(u, b.siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 }; base = Sites.factsOut(site.facts); industry = industry || site.industry; }
  const f = b.facts && typeof b.facts === 'object' ? b.facts : {}; const merged = { ...base }; for (const k of Copy.FACT_KEYS) if (f[k] != null && String(f[k]).trim() !== '') merged[k] = f[k];
  const F = Copy.facts({ ...merged, industry }); const out = generate(F);
  if (b.siteId && !out.error) { const known = await opportunities(b.siteId, 8); out.known = known; }
  return out;
}

// the keyword part of the dashboard
async function dashboardPart(u, site) {
  if (!(await ensure())) return {};
  const c = (await S.q(`SELECT COUNT(*) AS n, SUM(tracked) AS t FROM "${TK}" WHERE siteId = ?`, site.id))[0] || {}; const l = S.num(c.n) ? await list(u, site.id) : { items: [] }; const tracked = (l.items || []).filter((k) => k.tracked || k.change != null);
  const opp = await opportunities(site.id, 5); const ss = await sets(site.id, 1);
  return { keywords: { saved: S.num(c.n), tracked: S.num(c.t), withPosition: (l.items || []).filter((k) => k.position != null).length, improved: tracked.filter((k) => k.change > 0).length, worse: tracked.filter((k) => k.change < 0).length, movers: tracked.filter((k) => k.change != null && k.change !== 0).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 5).map((k) => ({ phrase: k.phrase, position: k.position, previous: k.previous, change: k.change })), opportunities: opp.items, snapshot: ss[0] || null, provider: PROVIDER } };
}

module.exports = { ensure, generate, research, intentOf, parseQueries, importQueries, storeSnapshot, sets, opportunities, queryView, save, list, setTracked, remove, dashboardPart, PROVIDER, INTENTS };
