// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > CONTENT (2026-11-25). SEO-friendly text for a client, WITHOUT an AI model for everything that can be written from facts:
//   * page title and meta description (with their lengths), main heading (H1), alt text for a picture, a product description, a location landing page (with FAQ and schema), the FAQ (with its schema), a
//     heading outline (H1 / H2): made by seoCopy.js from the facts TYPED for the client; a fact that is missing is asked for, never made up;
//   * THE CHECK: paste any text and a phrase to see the real numbers (words, sentence length, how often the phrase appears, headings) and the wording check: it tells when a phrase is repeated too often
//     (keyword stuffing) and never gives an invented "SEO score";
//   * ARTICLES: a full article is written ONLY when an AI model is ready (the shared AI layer of ai.js, with its usage log and limits): it is told to use only the given facts and to write
//     [CLIENT TO CONFIRM] where a fact is missing, and the result goes through the same check. It is a text for a person to read, change and approve: nothing is published and nothing is sent;
//   * LIBRARY: the texts the team keeps for a client (saved, then marked Used when they are on the website).
// HONEST BY DESIGN: no text claims a ranking, a result, a cure or a "best"; healthcare text carries the doctor-review rule. Nothing is posted: the client's web person pastes the text.
// saved: table OmniMkSeoContent; audit log "Omni-Channel AI Marketing: SEO content ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Sites = require('./seoSites');
const Copy = require('./seoCopy');
const Geo = require('./geoTools');
const AI = require('./ai');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkSeoContent';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL, "kind" TEXT NOT NULL, "title" TEXT NOT NULL, "body" TEXT, "status" TEXT NOT NULL DEFAULT 'ready', "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "usedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_site" ON "${T}"("siteId", "createdAt")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] seo content schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const KINDS = { meta: 'Page title and description', h1: 'Main heading', alt: 'Alt text', product: 'Product description', landing: 'Location page', faq: 'FAQ', outline: 'Heading outline', article: 'Article' };
const clean = Copy.clean;

// the facts of a request: the SEO site (siteId) and/or typed facts (typed ones win)
async function factsFor(u, b = {}) {
  let base = {}; let industry = b.industry; let site = null;
  if (b.siteId) { site = await Sites.mine(u, b.siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 }; base = Sites.factsOut(site.facts); industry = industry || site.industry; base.website = site.url; }
  const f = b.facts && typeof b.facts === 'object' ? b.facts : {}; const merged = { ...base }; for (const k of [...Copy.FACT_KEYS, 'website']) if (f[k] != null && String(f[k]).trim() !== '') merged[k] = f[k];
  return { F: Copy.facts({ ...merged, industry }), site };
}

// kind: meta | h1 | alt | product | landing | faq | outline. input: what the kind needs (topic, what, name, features, price, audience, location, service)
async function make(u, b = {}) {
  const kind = String(b.kind || ''); if (!KINDS[kind] || kind === 'article') return { error: 'Choose what to write.', status: 400 };
  const r = await factsFor(u, b); if (r.error) return r; const F = r.F; const i = b.input && typeof b.input === 'object' ? b.input : {}; const topic = clean(i.topic, 100);
  let out;
  if (kind === 'meta') { const t = Copy.titleOptions(F, { topic }); if (t.error) return t; out = { title: t, description: Copy.metaDescription(F, { topic }) }; }
  else if (kind === 'h1') out = Copy.h1Options(F, { topic });
  else if (kind === 'alt') out = Copy.altText(F, { what: i.what });
  else if (kind === 'product') out = Copy.productDescription(F, i);
  else if (kind === 'landing') out = Copy.landingPage(F, { location: i.location, service: i.service });
  else if (kind === 'outline') out = Copy.outline(F, { topic, kind: i.kind });
  else { const q = Copy.faqLines(F); if (!F.name) return { error: 'Write the business name first (Site and schedule).', status: 400 }; const ready = q.filter((x) => x.ready).map((x) => ({ question: x.question, answer: x.answer })); out = { faq: q.map((x) => ({ question: x.question, answer: x.answer, ready: x.ready })), schema: ready.length ? Geo.faqSchema(ready).script : '', notes: ['Answers are written only from the facts typed for the client. A question with no answer needs the client\'s own words.', 'The same questions and answers must be visible on the page before the schema is added.'] }; }
  if (out && out.error) return out;
  return { kind, label: KINDS[kind], result: out, healthcare: F.healthcare, factsUsed: ['name', 'city', 'services', 'phone', 'address', 'hours'].filter((k) => (Array.isArray(F[k]) ? F[k].length : F[k])) };
}
async function check(u, b = {}) {
  let industry = b.industry; if (b.siteId) { const site = await Sites.mine(u, b.siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 }; industry = industry || site.industry; }
  return Copy.checkText(b.text, b.phrase, { industry, title: b.title, description: b.description, article: b.article === true });
}

// ---- the article (only when an AI model is ready) ---------------------------------------------------------------------------------------------------------------------------
async function aiStatus() { try { const s = (await AI.status()).text; return { ready: Boolean(s.ready), provider: s.provider || null, model: s.model || null, reason: s.ready ? '' : (s.reason || 'The AI model is not ready.'), demo: Boolean(s.demo) }; } catch (e) { return { ready: false, provider: null, model: null, reason: e.message || 'The AI model is not ready.', demo: false }; } }
const SYSTEM = 'You write SEO-friendly website articles for a small business in India, in plain, clear English for ordinary readers. Use ONLY the facts given in the brief. If a fact you need is not given, write [CLIENT TO CONFIRM] instead of making it up. Never promise rankings, traffic, results or cures. No guarantees, no "best", "No. 1" or "100%" claims, no medical advice, no named patients or customers. Use the focus phrase naturally (about 1% of the words, never more than 2%) and the services and city only where they fit. Structure: one H1 written as "# ", then 4 to 6 sections written as "## " with short paragraphs, and one short FAQ section with 3 to 5 questions. Answer with JSON only: {"title":"","metaTitle":"at most 60 characters","metaDescription":"at most 155 characters","markdown":"the article"}.';
async function article(u, b = {}) {
  const topic = clean(b.topic, 140); if (!topic) return { error: 'Write the topic of the article.', status: 400 };
  const r = await factsFor(u, b); if (r.error) return r; const F = r.F; if (!F.name) return { error: 'Write the business name first (Site and schedule).', status: 400 };
  const phrase = clean(b.phrase, 100) || topic.toLowerCase(); const words = Math.max(300, Math.min(1200, Math.round(Number(b.words)) || 700)); const notes = clean(b.notes, 600);
  const prompt = ['Facts about the business (use only these):', `- Business: ${F.name}`, `- Kind: ${F.kind}`, F.city ? `- City: ${F.city}${F.state ? `, ${F.state}` : ''}` : '', F.areas.length ? `- Areas served: ${F.areas.join(', ')}` : '', F.services.length ? `- Services: ${F.services.join(', ')}` : '', F.specialty ? `- Specialty: ${F.specialty}` : '', F.audience ? `- Who it is for: ${F.audience}` : '', F.phone ? `- Phone: ${F.phone}` : '', F.address ? `- Address: ${F.address}` : '', F.hours ? `- Hours: ${F.hours}` : '', F.since ? `- Serving since: ${F.since}` : '',
    '', `Topic: ${topic}`, `Focus phrase: ${phrase}`, `Length: about ${words} words.`, notes ? `Notes from the team: ${notes}` : '', F.healthcare ? 'This is healthcare: no medical advice, no claim of a cure or of no risk; say that a doctor should be consulted.' : ''].filter((x) => x !== '').join('\n');
  let g;
  try {
    g = await AI.generate({ user: u, module: 'seo', task: 'article', system: SYSTEM, prompt, json: true, fast: { own: true, maxTokens: 3500, ms: 45000 }, quickMs: 55000, department: r.site ? r.site.department : undefined,
      demo: () => ({ title: `SAMPLE: ${topic}`, metaTitle: `${topic} | ${F.name}`.slice(0, 60), metaDescription: `SAMPLE (test mode, not written by AI) about ${topic} at ${F.name}.`.slice(0, 155), markdown: `# SAMPLE (test mode, not written by AI): ${topic}\n\n## What to know\n${F.name} is a ${F.kind}${F.city ? ` in ${F.city}` : ''}. [CLIENT TO CONFIRM]\n\n## Questions\nWhat does ${F.name} offer? [CLIENT TO CONFIRM]` }) });
  } catch (e) { return { error: e.message, status: e.status || 503, code: e.code || 'ai' }; }
  const x = g.result && typeof g.result === 'object' ? g.result : {}; const md = String(x.markdown || x.article || x.text || '').slice(0, 20000); if (md.trim().length < 40) return { error: 'The AI did not write an article this time. Try again.', status: 502, code: 'empty' };
  const metaTitle = clean(x.metaTitle, 90); const metaDescription = clean(x.metaDescription, 220); const checks = Copy.checkText(md, phrase, { industry: F.industry, title: metaTitle, description: metaDescription, article: true });
  const confirm = (md.match(/\[CLIENT TO CONFIRM\]/gi) || []).length;
  return { article: { title: clean(x.title, 160) || topic, metaTitle, metaDescription, markdown: md, phrase, confirm }, checks, ai: { provider: g.provider, model: g.model, demo: g.demo }, healthcare: F.healthcare,
    notes: ['Written by AI: read every line and check every fact before it is used. TeamLink did not check the facts in it.', confirm ? `${confirm} place${confirm === 1 ? '' : 's'} marked [CLIENT TO CONFIRM] need the client's own words.` : 'Nothing is marked [CLIENT TO CONFIRM]: still check each statement against the client\'s real facts.', ...(F.healthcare ? ['Healthcare: a doctor or a qualified medical reviewer approves it before it is published.'] : [])] };
}

// ---- the library ------------------------------------------------------------------------------------------------------------------------------------------------------
async function saveItem(u, siteId, b = {}) {
  if (!(await ensure())) return { error: 'The text could not be saved.', status: 500 };
  const site = await Sites.mine(u, siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  const kind = String(b.kind || ''); if (!KINDS[kind]) return { error: 'Choose what kind of text this is.', status: 400 }; const body = typeof b.body === 'string' ? b.body : JSON.stringify(b.body || ''); if (!body || body.length < 2) return { error: 'There is no text to keep.', status: 400 };
  const title = clean(b.title, 160) || KINDS[kind]; const id = S.newId('sct');
  await S.run(`INSERT INTO "${T}" (id, siteId, kind, title, body, status, createdById, createdByName, createdAt) VALUES (?,?,?,?,?,'ready',?,?,?)`, id, site.id, kind, title, body.slice(0, 40000), u.id, S.clip(u.name, 80), Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: SEO content saved', entity: T, entityId: id, toValue: `${site.clientName}: ${KINDS[kind]}: ${title}` });
  return { id };
}
const itemOut = (r) => ({ id: r.id, kind: r.kind, kindLabel: KINDS[r.kind] || r.kind, title: r.title, body: r.body || '', status: r.status, createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt), usedAt: S.num(r.usedAt) ? S.iso(r.usedAt) : null });
async function list(u, siteId) {
  if (!(await ensure())) return { error: 'The texts could not be opened.', status: 500 };
  const site = await Sites.mine(u, siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 };
  return { items: (await S.q(`SELECT * FROM "${T}" WHERE siteId = ? ORDER BY createdAt DESC LIMIT 200`, site.id)).map(itemOut), kinds: KINDS };
}
async function setStatus(u, id, status) {
  if (!(await ensure())) return { error: 'The text could not be saved.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, S.clip(id, 60)))[0]; if (!r || !(await Sites.mine(u, r.siteId))) return { error: 'That text was not found.', status: 404 };
  if (!['ready', 'used'].includes(status)) return { error: 'Choose Ready or Used.', status: 400 };
  await S.run(`UPDATE "${T}" SET status = ?, usedAt = ? WHERE id = ?`, status, status === 'used' ? Date.now() : 0, r.id); return { ok: true, status };
}
async function remove(u, id) {
  if (!(await ensure())) return { error: 'The text could not be removed.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, S.clip(id, 60)))[0]; if (!r || !(await Sites.mine(u, r.siteId))) return { error: 'That text was not found.', status: 404 };
  await S.run(`DELETE FROM "${T}" WHERE id = ?`, r.id); return { ok: true };
}

// the content part of the dashboard: the texts kept, and how far the content findings of the audit are (titles, descriptions, headings, picture text)
async function dashboardPart(u, site) {
  if (!(await ensure())) return {};
  const rows = await S.q(`SELECT kind, status, COUNT(*) AS n FROM "${T}" WHERE siteId = ? GROUP BY kind, status`, site.id); const byKind = {}; let ready = 0; let used = 0;
  for (const r of rows) { byKind[r.kind] = (byKind[r.kind] || 0) + S.num(r.n); if (r.status === 'used') used += S.num(r.n); else ready += S.num(r.n); }
  let fix = { open: 0, done: 0, verified: 0 }; try { for (const r of await S.q(`SELECT status, COUNT(*) AS n FROM "OmniMkSeoTask" WHERE siteId = ? AND issue IN ('title','description','h1','altText','cross:dupTitle','cross:dupDescription','cross:dupH1','cross:thin','faqSection','questionHeadings') GROUP BY status`, site.id)) if (fix[r.status] != null) fix[r.status] = S.num(r.n); } catch { /* no task table yet */ }
  return { content: { ready, used, byKind, fix, ai: await aiStatus() } };
}

module.exports = { ensure, make, check, article, aiStatus, saveItem, list, setStatus, remove, dashboardPart, factsFor, KINDS };
