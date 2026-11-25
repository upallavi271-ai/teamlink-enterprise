// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > WEBSITE CHECK (2026-11-24). The "website SEO audit", "AEO readiness" and "GEO readiness" of the services document, from a web address:
//   the page is fetched once (through utils/safeFetch.js: public addresses only, redirects checked, size and time limits), read with plain code (no library, no paid service, no AI), and 23 checks
//   are made, 50 marks for SEO (title, description, headings, canonical, language, mobile tag, indexable, image text, sitemap, robots, broken links, speed), 25 for AEO (a FAQ section, question
//   headings, FAQ schema, answer-friendly structure) and 25 for GEO (organisation / business schema, its details, name-address-phone on the page, social profiles, about and contact pages).
// HONEST BY DESIGN: this is TeamLink's OWN score of what is ON the page. It does not measure rankings, traffic or what an AI assistant says; it promises none. "Speed" is only how fast the
//   server answered here, not a full page-speed test. Nothing is posted or changed on the website.
// saved per client: table OmniMkSiteCheck; audit log "Omni-Channel AI Marketing: website check ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const { fetchPublic } = require('../utils/safeFetch');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkSiteCheck';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL DEFAULT '', "planId" TEXT, "url" TEXT NOT NULL, "score" INTEGER NOT NULL DEFAULT 0, "report" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_client" ON "${T}"("clientName", "createdAt")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); try { await S.run(`ALTER TABLE "${T}" ADD COLUMN "pages" INTEGER NOT NULL DEFAULT 1`); } catch { /* the column is already there */ } okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] site check schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

// ---- reading a page with plain code ------------------------------------------------------------------------------------------------------------------------------------
const ent = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const strip = (s) => ent(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag || ''); return m ? ent(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : null; };
const words = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const SOCIAL = /(facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|wa\.me|whatsapp\.com)/i;
const ORG_TYPES = /^(Organization|Corporation|LocalBusiness|Hospital|MedicalClinic|MedicalOrganization|Physician|Dentist|Pharmacy|ProfessionalService|EducationalOrganization|School|CollegeOrUniversity|Store|Restaurant|HealthAndBeautyBusiness|MedicalBusiness|LegalService|FinancialService|RealEstateAgent|EmploymentAgency|Place|MedicalCenter)$/i;

function flattenLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => flattenLd(n, out)); return; }
  if (node['@graph']) flattenLd(node['@graph'], out);
  if (node['@type']) out.push(node);
  Object.values(node).forEach((v) => { if (v && typeof v === 'object' && !node['@graph']) flattenLd(v, out); });
}
function scanHtml(html, pageUrl) {
  const src = String(html || '').slice(0, 2000000);
  const htmlTag = (/<html\b[^>]*>/i.exec(src) || [''])[0];
  const head = (/<head\b[\s\S]*?<\/head>/i.exec(src) || [src.slice(0, 20000)])[0];
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const meta = (n) => { for (const t of metas) if (String(attr(t, 'name') || attr(t, 'property') || '').toLowerCase() === n) return attr(t, 'content') || ''; return null; };
  const linkTags = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const canon = linkTags.find((t) => /canonical/i.test(attr(t, 'rel') || ''));
  const headings = [...src.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: strip(m[2]) })).filter((h) => h.text);
  const images = [...src.matchAll(/<img\b[^>]*>/gi)].map((m) => ({ alt: attr(m[0], 'alt'), src: attr(m[0], 'src') || '' }));
  const anchors = [...src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: attr(m[1], 'href') || '', text: strip(m[2]) })).filter((a) => a.href);
  const ld = []; for (const m of src.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { flattenLd(JSON.parse(m[1].trim()), ld); } catch { /* a broken block counts as no schema */ } }
  const body = strip((/<body\b[\s\S]*<\/body>/i.exec(src) || [src])[0]);
  const paras = [...src.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => strip(m[1])).filter(Boolean);
  const types = ld.flatMap((n) => [].concat(n['@type'])).map(String);
  const orgNode = ld.find((n) => [].concat(n['@type']).some((t) => ORG_TYPES.test(String(t))));
  const isQuestion = (t) => /\?\s*$/.test(t) || /^(what|how|when|why|which|who|where|can|do|does|is|are|should|will)\b/i.test(t);
  const phone = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\b0\d{2,4}[\s-]?\d{6,8}\b/.test(body);
  const address = /\b[1-9]\d{2}\s?\d{3}\b/.test(body) || /\b(road|street|nagar|colony|lane|avenue|plot no|door no|floor|opp\.?|near)\b/i.test(body);
  return {
    url: pageUrl, lang: attr(htmlTag, 'lang'), title: strip((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) || ['', ''])[1]), description: meta('description'), robotsMeta: meta('robots'), viewport: meta('viewport'),
    ogTitle: meta('og:title'), ogDescription: meta('og:description'), ogImage: meta('og:image'), twitterCard: meta('twitter:card'), canonical: canon ? attr(canon, 'href') : null, headings, h1: headings.filter((h) => h.level === 1), images, anchors, schemaTypes: types, orgNode: orgNode || null,
    faqHeading: headings.some((h) => /\bfaq|frequently asked|common questions/i.test(h.text)) || /<details\b/i.test(src), questionHeadings: headings.filter((h) => isQuestion(h.text) && h.level > 1).length,
    lists: /<(ul|ol|table)\b/i.test(src), paragraphs: paras.length, avgParaChars: paras.length ? Math.round(paras.reduce((s, p) => s + p.length, 0) / paras.length) : 0, wordCount: words(body), phone, address,
    sameAs: Boolean(orgNode && orgNode.sameAs && [].concat(orgNode.sameAs).length) || anchors.some((a) => SOCIAL.test(a.href)), aboutContact: anchors.some((a) => /(^|\/)(about|contact|contact-us|about-us)(\/|\.|$|\?|#)/i.test(a.href) || /^(about|contact)( us)?$/i.test(a.text)),
  };
}

// ---- the checks: [key, area, marks, test -> 'yes' | 'partly' | 'no', what is wrong, what to do] ------------------------------------------------------------------
const lenIn = (s, a, b) => s.length >= a && s.length <= b;
const CHECKS = [
  ['https', 'SEO', 4, (f, c) => (c.https ? 'yes' : 'no'), 'the site is not on https', 'Serve the whole site on https (a free certificate is enough) and redirect http to https.'],
  ['title', 'SEO', 7, (f) => (!f.title ? 'no' : lenIn(f.title, 15, 65) ? 'yes' : 'partly'), 'page title missing or the wrong length', 'Write a clear title of about 15 to 65 characters with what the business is and where.'],
  ['description', 'SEO', 6, (f) => (!f.description ? 'no' : lenIn(f.description, 70, 170) ? 'yes' : 'partly'), 'meta description missing or the wrong length', 'Write a meta description of about 70 to 170 characters: what the page offers and one reason to click.'],
  ['h1', 'SEO', 6, (f) => (f.h1.length === 1 ? 'yes' : f.h1.length > 1 ? 'partly' : 'no'), 'no single main heading (H1)', 'Give the page exactly one H1 that says what the page is about.'],
  ['headingOrder', 'SEO', 2, (f) => (f.headings.every((h, i) => i === 0 || h.level <= f.headings[i - 1].level + 1) ? 'yes' : 'partly'), 'headings skip levels', 'Keep headings in order (H1, then H2, then H3) without jumping a level.'],
  ['canonical', 'SEO', 3, (f) => (f.canonical ? 'yes' : 'no'), 'no canonical link', 'Add a canonical link so search engines know the main address of the page.'],
  ['lang', 'SEO', 2, (f) => (f.lang ? 'yes' : 'no'), 'page language not declared', 'Add the language to the html tag (for example lang="en").'],
  ['viewport', 'SEO', 4, (f) => (f.viewport ? 'yes' : 'no'), 'no mobile viewport tag', 'Add the viewport meta tag so the page fits a phone screen.'],
  ['indexable', 'SEO', 3, (f) => (/noindex/i.test(f.robotsMeta || '') ? 'no' : 'yes'), 'the page tells search engines not to index it', 'Remove the noindex tag from pages that should be found.'],
  ['altText', 'SEO', 5, (f) => { const n = f.images.length; if (!n) return 'yes'; const bad = f.images.filter((i) => i.alt == null || !String(i.alt).trim()).length; return bad === 0 ? 'yes' : bad / n <= 0.25 ? 'partly' : 'no'; }, 'images without alternative text', 'Describe each real picture in its alt text (decorative ones can be left empty on purpose).'],
  ['sitemap', 'SEO', 2, (f, c) => (c.sitemapOk ? 'yes' : 'no'), 'no sitemap found', 'Publish a sitemap.xml and list it in robots.txt.'],
  ['robots', 'SEO', 1, (f, c) => (c.robotsOk ? 'yes' : 'no'), 'no robots.txt', 'Add a robots.txt file at the top of the site.'],
  ['brokenLinks', 'SEO', 3, (f, c) => { const b = c.broken; if (!b || !b.checked) return 'yes'; return b.bad === 0 ? 'yes' : b.bad <= 2 ? 'partly' : 'no'; }, 'broken links on the page', 'Fix or remove the links that do not open.'],
  ['speed', 'SEO', 2, (f, c) => (c.ms == null ? 'yes' : c.ms < 1500 ? 'yes' : c.ms < 3500 ? 'partly' : 'no'), 'the server answers slowly', 'Speed up the server answer (caching, a lighter page, better hosting). This only measures the first answer, not the whole page.'],
  ['faqSection', 'AEO', 7, (f) => (f.faqHeading ? 'yes' : 'no'), 'no FAQ section', 'Add a Frequently Asked Questions section with the real questions customers ask.'],
  ['questionHeadings', 'AEO', 5, (f) => (f.questionHeadings >= 3 ? 'yes' : f.questionHeadings >= 1 ? 'partly' : 'no'), 'few headings written as questions', 'Write some headings as the question a customer would type, with a short clear answer under each.'],
  ['faqSchema', 'AEO', 8, (f) => (f.schemaTypes.includes('FAQPage') ? 'yes' : 'no'), 'no FAQ schema', 'Add FAQPage structured data (the FAQ & schema tool makes it) matching the questions shown on the page.'],
  ['structure', 'AEO', 5, (f) => (f.lists && f.avgParaChars <= 600 ? 'yes' : f.lists || f.headings.length >= 3 ? 'partly' : 'no'), 'text is not broken into short, answer-friendly parts', 'Use short paragraphs, lists and tables so an answer can be read at a glance.'],
  ['orgSchema', 'GEO', 8, (f) => (f.orgNode ? 'yes' : 'no'), 'no organisation or business schema', 'Add Organization or LocalBusiness structured data (the FAQ & schema tool makes it).'],
  ['orgDetails', 'GEO', 4, (f) => { const o = f.orgNode; if (!o) return 'no'; const n = [o.name, o.telephone || o.email, o.address, o.url || o.sameAs].filter(Boolean).length; return n >= 4 ? 'yes' : n >= 2 ? 'partly' : 'no'; }, 'the business schema is thin', 'Fill the schema with the name, phone, address and website, and the social profiles.'],
  ['nap', 'GEO', 5, (f) => (f.phone && f.address ? 'yes' : f.phone || f.address ? 'partly' : 'no'), 'name, address and phone are not all on the page', 'Show the business name, full address and phone number on the page, written the same way as on Google.'],
  ['sameAs', 'GEO', 4, (f) => (f.sameAs ? 'yes' : 'no'), 'no links to the social profiles', 'Link the real social profiles from the site (and list them in the schema as sameAs).'],
  ['aboutContact', 'GEO', 4, (f) => (f.aboutContact ? 'yes' : 'no'), 'no About or Contact page linked', 'Link an About page (who runs the business, with credentials) and a Contact page.'],
];
const FR = { yes: 1, partly: 0.5, no: 0 };
const AREAS = { SEO: 'Search engine optimisation (SEO)', AEO: 'Answer engine optimisation (AEO)', GEO: 'Generative engine optimisation (GEO)' };
const DISCLAIMER = "This is TeamLink's own check of what is on the page. It does not measure rankings or traffic, does not show what any AI assistant says about the business, and does not guarantee a first-page ranking or an AI recommendation.";

function analyze(f, c = {}) {
  let total = 0; const areas = { SEO: { got: 0, marks: 0 }, AEO: { got: 0, marks: 0 }, GEO: { got: 0, marks: 0 } }; const checks = []; const actions = [];
  for (const [key, area, pts, test, gap, fix] of CHECKS) {
    const v = test(f, c); const got = pts * FR[v];
    areas[area].got += got; areas[area].marks += pts; total += got;
    checks.push({ key, area, marks: pts, result: v, got });
    if (v !== 'yes') actions.push({ key, area, lost: pts - got, gap: gap[0].toUpperCase() + gap.slice(1) + (v === 'partly' ? ' (partly)' : ''), fix });
  }
  actions.sort((a, b) => b.lost - a.lost);
  const score = Math.round(total);
  return { score, outOf: 100, areas: Object.entries(areas).map(([k, v]) => ({ key: k, label: AREAS[k], got: Math.round(v.got * 10) / 10, marks: v.marks })), checks, actions, disclaimer: DISCLAIMER,
    facts: { title: f.title, description: f.description, h1: f.h1.map((h) => h.text).slice(0, 3), headings: f.headings.length, images: f.images.length, imagesNoAlt: f.images.filter((i) => i.alt == null || !String(i.alt).trim()).length, schemaTypes: [...new Set(f.schemaTypes)].slice(0, 12), words: f.wordCount, lang: f.lang || '' } };
}

// ---- fetching (the only part that touches the network) ----------------------------------------------------------------------------------------------------------------
const UA = { 'user-agent': 'TeamLinkSiteCheck/1.0 (+website audit for our client)', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
async function get(fetchFn, url, ms, init = {}) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetchFn(url, { ...init, headers: { ...UA, ...(init.headers || {}) }, signal: ctl.signal }); } finally { clearTimeout(timer); }
}
const readCapped = async (res, cap) => { const len = Number(res.headers && res.headers.get && res.headers.get('content-length')); if (len > cap) throw Object.assign(new Error('That page is too big to check (over 3 MB).'), { code: 'TOO_BIG' }); const t = await res.text(); return t.length > cap ? t.slice(0, cap) : t; };
function cleanUrl(input) {
  let s = String(input || '').trim(); if (!s) return { error: 'Write the website address.', status: 400 };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u; try { u = new URL(s); } catch { return { error: 'That is not a web address.', status: 400 }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'Only http and https addresses can be checked.', status: 400 };
  if (u.username || u.password) return { error: 'Leave the user name and password out of the address.', status: 400 };
  return { url: u.href };
}
async function fetchPage(url, opts = {}) {
  const fetchFn = opts.fetchFn || fetchPublic; const t0 = Date.now();
  let res; try { res = await get(fetchFn, url, opts.pageMs || 12000); } catch (e) { return { error: e.code && /^SSRF/.test(e.code) ? e.message : (e.name === 'AbortError' ? 'The website did not answer in time.' : 'The website could not be reached.'), status: 502 }; }
  const ms = Date.now() - t0; if (res.status >= 400) return { error: `The website answered with an error (${res.status}).`, status: 502 };
  const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || ''); if (type && !/html|xml/i.test(type)) return { error: 'That address is not a web page.', status: 400 };
  let html; try { html = await readCapped(res, 3000000); } catch (e) { return { error: e.message, status: 502 }; }
  return { html, ms, finalUrl: res.url || url, xRobots: String((res.headers && res.headers.get && res.headers.get('x-robots-tag')) || '') }; // xRobots: the X-Robots-Tag header, read by seoExtras.js
}
async function extras(base, f, opts = {}) {
  const fetchFn = opts.fetchFn || fetchPublic; const origin = new URL(base).origin; const out = { https: new URL(base).protocol === 'https:', robotsOk: false, sitemapOk: false, broken: { checked: 0, bad: 0, list: [] } };
  const probe = async (path, test) => { try { const r = await get(fetchFn, new URL(path, origin).href, 6000); if (r.status !== 200) return false; const t = (await readCapped(r, 300000)).slice(0, 4000); return test(t); } catch { return false; } };
  const [robots, sitemap] = await Promise.all([probe('/robots.txt', (t) => /user-agent|sitemap|disallow/i.test(t)), probe('/sitemap.xml', (t) => /<urlset|<sitemapindex/i.test(t))]);
  out.robotsOk = robots; out.sitemapOk = sitemap;
  if (!sitemap && robots) out.sitemapOk = await probe('/robots.txt', (t) => /^\s*sitemap:/im.test(t));
  const seen = new Set(); const todo = [];
  for (const a of f.anchors) { try { if (/^(#|mailto:|tel:|javascript:|sms:|whatsapp:)/i.test(a.href)) continue; const u = new URL(a.href, base); if (u.origin !== origin) continue; u.hash = ''; if (seen.has(u.href) || u.href === base) continue; seen.add(u.href); todo.push(u.href); } catch { /* not a link */ } if (todo.length >= 8) break; }
  let i = 0; const work = async () => { while (i < todo.length) { const url = todo[i]; i += 1; out.broken.checked += 1; try { let r = await get(fetchFn, url, 6000, { method: 'HEAD' }); if (r.status === 405 || r.status === 403 || r.status === 501) r = await get(fetchFn, url, 6000); if (r.status >= 400) { out.broken.bad += 1; out.broken.list.push(`${url} (${r.status})`); } } catch { out.broken.bad += 1; out.broken.list.push(`${url} (no answer)`); } } }; // eslint-disable-line no-await-in-loop
  await Promise.all([work(), work(), work()]);
  return out;
}
// the whole check for a web address. opts.fetchFn lets a test answer instead of the internet.
async function runCheck(input, opts = {}) {
  const c = cleanUrl(input); if (c.error) return c;
  const page = await fetchPage(c.url, opts); if (page.error) return page;
  const f = scanHtml(page.html, page.finalUrl); const ex = await extras(page.finalUrl, f, opts);
  const rep = analyze(f, { ...ex, ms: page.ms });
  const extra = await require('./seoExtras').gather([{ url: page.finalUrl, path: '/', f }], page.finalUrl, { ...opts, xRobots: page.xRobots }); // eslint-disable-line global-require
  return { report: { ...rep, url: page.finalUrl, checkedAt: new Date().toISOString(), responseMs: page.ms, links: ex.broken, robotsOk: ex.robotsOk, sitemapOk: ex.sitemapOk, extra } };
}

// ---- saved checks, per client ------------------------------------------------------------------------------------------------------------------------------------------
// b.pages: 1 (default) = the home page only; 2 to 10 = the home page and more pages of the same website (siteCrawl.js)
const pagesAsked = (b) => Math.max(1, Math.min(10, Math.round(Number(b && b.pages)) || 1));
async function check(u, b = {}, opts = {}) {
  const n = pagesAsked(b);
  const r = n > 1 ? await require('./siteCrawl').run(b.url, n, opts) : await runCheck(b.url, opts); if (r.error) return r; // eslint-disable-line global-require
  if (!b.save) return r;
  if (!(await ensure())) return { error: 'The checks could not be saved.', status: 500 };
  const clientName = S.clip(b.clientName, 120); if (!clientName) return { error: 'Write the client name to save the check.', status: 400 };
  const dept = S.clip(b.department, 60) || null; if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const id = S.newId('sck');
  const read = r.report.crawl ? r.report.crawl.read : 1;
  await S.run(`INSERT INTO "${T}" (id, clientName, planId, url, score, report, department, createdById, createdByName, createdAt, pages) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, clientName, b.planId ? S.clip(b.planId, 60) : null, r.report.url, r.report.score, JSON.stringify(r.report), dept, u.id, S.clip(u.name, 80), Date.now(), read);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: website check saved', entity: T, entityId: id, toValue: `${clientName}: ${r.report.url} ${r.report.score}/100${read > 1 ? ` (${read} pages)` : ''}` });
  return { ...r, id };
}
async function list(u, o = {}) {
  if (!(await ensure())) return { error: 'The checks could not be opened.', status: 500 };
  const rows = (await S.q(`SELECT id, clientName, planId, url, score, pages, department, createdByName, createdAt FROM "${T}" ORDER BY createdAt DESC LIMIT 300`)).filter((r) => A.mayDepartment(u, r.department || '')).filter((r) => !o.clientName || r.clientName.toLowerCase() === String(o.clientName).toLowerCase());
  return { items: rows.map((r) => ({ id: r.id, clientName: r.clientName, planId: r.planId || null, url: r.url, score: S.num(r.score), pages: S.num(r.pages) || 1, createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt) })) };
}
async function get1(u, id) {
  if (!(await ensure())) return { error: 'The checks could not be opened.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, id))[0]; if (!r || !A.mayDepartment(u, r.department || '')) return { error: 'That check was not found.', status: 404 };
  return { id: r.id, clientName: r.clientName, createdAt: S.iso(r.createdAt), report: S.parse(r.report, null) };
}
// a Google PageSpeed run (the small version from marketing/pagespeed.js) kept with the saved check, so the monthly report can show it
async function attachPageSpeed(u, id, ps) {
  if (!(await ensure())) return { error: 'The check could not be opened.', status: 500 };
  const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, id))[0]; if (!r || !A.mayDepartment(u, r.department || '')) return { error: 'That check was not found.', status: 404 };
  const rep = S.parse(r.report, null) || {}; rep.pagespeed = ps; await S.run(`UPDATE "${T}" SET report = ? WHERE id = ?`, JSON.stringify(rep), id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: PageSpeed result kept with a website check', entity: T, entityId: id, toValue: r.clientName });
  return { ok: true };
}
async function latestFor(u, clientName) { const l = await list(u, { clientName }); return l.items && l.items[0] ? l.items[0] : null; }

module.exports = { ensure, scanHtml, analyze, runCheck, check, list, get: get1, latestFor, attachPageSpeed, cleanUrl, CHECKS, DISCLAIMER, MAX_PAGES: 10, FR, AREAS, rawGet: get, readCapped, fetchPage, extras }; // the last six are shared with siteCrawl.js (several pages)
