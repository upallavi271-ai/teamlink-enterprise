// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > WEBSITE CHECK, SEVERAL PAGES (2026-11-24). The same 23 checks and 100 marks as siteCheck.js, over the home page AND up to 9 more pages of the same website:
//   * which pages: the links on the home page (the menu) and the sitemap, same website only, pages the site's robots.txt asks robots to leave alone are skipped, files / log-in / cart / feed / tag pages are
//     never read, the pages that matter to a visitor first (about, contact, services, doctors / departments, FAQ, prices, blog), and at most 2 pages from the same section (so ten blog posts cannot fill the check);
//   * how: through the same safe fetch as the one-page check (public addresses only, redirects checked, size and time limits), 3 pages at a time, a time budget for the whole crawl (the pages not read in time
//     are said so, never guessed); nothing is posted or changed on the website;
//   * how it is marked: 10 checks belong to a PAGE (title, description, H1, heading order, canonical, language, mobile tag, indexable, picture text, server answer): the mark is the AVERAGE over the pages read;
//     4 belong to the SITE (https, sitemap, robots.txt, broken links): measured once; 9 are about what the website offers at all (FAQ, question headings, FAQ schema, answer-friendly text, business schema and
//     its details, name-address-phone, social profiles, About / Contact): they count when ANY page has them (the home page alone would say "no FAQ" for a site whose FAQ is on its own page);
//   * what it adds: a score for every page, the pages behind each finding, pages that share one title / description / main heading, short pages, and pages listed on the site that do not open.
// HONEST BY DESIGN: still TeamLink's OWN check of what is on the pages: no rankings, no traffic, no promise of a first-page position or an AI recommendation. Saved like a one-page check (siteCheck.check).
// ---------------------------------------------------------------------------
const Site = require('./siteCheck');
const { fetchPublic } = require('../utils/safeFetch');

const MAX_PAGES = 10;
const PAGE_KEYS = new Set(['title', 'description', 'h1', 'headingOrder', 'canonical', 'lang', 'viewport', 'indexable', 'altText', 'speed']);
const SITE_KEYS = new Set(['https', 'sitemap', 'robots', 'brokenLinks']);
const FR = Site.FR;
const cap1 = (s) => s[0].toUpperCase() + s.slice(1);
const r1 = (n) => Math.round(n * 10) / 10;

// ---- which addresses are worth reading ------------------------------------------------------------------------------------------------------------------------------------
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|mov|avi|css|js|json|xml|txt|rss|atom)$/i;
const SKIP_PATH = /^\/(wp-admin|wp-login\.php|wp-json|wp-content|wp-includes|cart|checkout|my-account|account|login|log-in|signin|sign-in|register|logout|feed|cdn-cgi)(\/|$)|\/(feed|tag|tags|author|attachment)(\/|$)/i;
const KEY_PATH = /(about|contact|service|treatment|department|doctor|speciali|faq|pricing|price|plans?|course|admission|product|team|location|appointment|book|blog|news|gallery|career)/i;
const siteHost = (h) => String(h).replace(/^www\./i, '').toLowerCase();
function norm(href, base, host) { // -> { href, path } for a page of THIS website, else null
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || siteHost(u.hostname) !== host) return null;
  u.hash = ''; for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
  const q = u.search; if (q && !/^\?(p|page_id)=\d+$/.test(q)) return null; // searches, filters and sort orders are not pages
  const p0 = u.pathname.replace(/\/{2,}/g, '/').replace(/\/index\.(html?|php|aspx?)$/i, '/'); if (SKIP_EXT.test(p0) || SKIP_PATH.test(p0)) return null; // /index.html is the same page as /
  const p = p0.length > 1 ? p0.replace(/\/$/, '') : p0;
  return { href: `${u.protocol}//${u.host}${p}${q}`, path: `${p}${q}` };
}
function pick(cands, n) { // the pages that matter first, at most 2 from one section
  const seg = (c) => c.path.split('/').filter(Boolean);
  const ranked = cands.map((c, i) => ({ c, s: (KEY_PATH.test(c.path) ? 0 : 1000) + seg(c).length * 100 + Math.min(i, 99) })).sort((a, b) => a.s - b.s).map((x) => x.c);
  const per = new Map(); const out = [];
  for (const c of ranked) { const k = seg(c)[0] || ''; if ((per.get(k) || 0) >= 2) continue; per.set(k, (per.get(k) || 0) + 1); out.push(c); if (out.length >= n) break; }
  for (const c of ranked) { if (out.length >= n) break; if (!out.includes(c)) out.push(c); } // a small site: fill up from what is left
  return out;
}
function disallowOf(txt) { // the simple Disallow rules (no wildcards) of the "all robots" group in robots.txt
  const out = []; let applies = false; let prevUa = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(raw.replace(/#.*/, '').trim()); if (!m) continue;
    const k = m[1].toLowerCase(); const v = m[2].trim();
    if (k === 'user-agent') { applies = (prevUa ? applies : false) || v === '*'; prevUa = true; continue; }
    prevUa = false; if (applies && k === 'disallow' && v && !/[*$]/.test(v)) out.push(v);
  }
  return out;
}
const locsOf = (xml) => [...String(xml || '').matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
async function readSitemap(origin, fetchFn) { // { urls, disallow }; nothing here is fatal: a site without a sitemap is read through its links
  const out = { urls: [], disallow: [] };
  const text = async (url, cap) => { try { const r = await Site.rawGet(fetchFn, new URL(url, origin).href, 6000); if (r.status !== 200) return ''; return await Site.readCapped(r, cap); } catch { return ''; } };
  const robots = await text('/robots.txt', 300000); out.disallow = disallowOf(robots);
  const listed = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  let xml = ''; for (const t of [...new Set(['/sitemap.xml', ...listed, '/sitemap_index.xml', '/wp-sitemap.xml'])].slice(0, 4)) { xml = await text(t, 1500000); if (/<urlset|<sitemapindex/i.test(xml)) break; xml = ''; } // eslint-disable-line no-await-in-loop
  if (!xml) return out;
  let urls = locsOf(xml);
  if (/<sitemapindex/i.test(xml)) { const kids = urls.slice(0, 2); urls = []; for (const k of kids) urls.push(...locsOf(await text(k, 1500000))); } // eslint-disable-line no-await-in-loop
  out.urls = urls.slice(0, 300); return out;
}
async function pool(items, k, fn) { const out = new Array(items.length); let i = 0; const w = async () => { while (i < items.length) { const j = i; i += 1; out[j] = await fn(items[j], j); } }; await Promise.all(Array.from({ length: Math.min(k, items.length) }, w)); return out; } // eslint-disable-line no-await-in-loop

// ---- the marks over several pages -------------------------------------------------------------------------------------------------------------------------------------------
function siteView(fs) { // what the website offers at all, as one page-like object for the content checks
  const rich = (o) => [o.name, o.telephone || o.email, o.address, o.url || o.sameAs].filter(Boolean).length;
  const orgs = fs.map((f) => f.orgNode).filter(Boolean).sort((a, b) => rich(b) - rich(a));
  const paras = fs.reduce((s, f) => s + f.paragraphs, 0); const chars = fs.reduce((s, f) => s + f.avgParaChars * f.paragraphs, 0); const any = (k) => fs.some((f) => f[k]);
  return { faqHeading: any('faqHeading'), questionHeadings: fs.reduce((s, f) => s + f.questionHeadings, 0), schemaTypes: fs.flatMap((f) => f.schemaTypes), orgNode: orgs[0] || null, lists: any('lists'), paragraphs: paras, avgParaChars: paras ? Math.round(chars / paras) : 0, phone: any('phone'), address: any('address'), sameAs: any('sameAs'), aboutContact: any('aboutContact'), headings: fs.flatMap((f) => f.headings) };
}
const pathOf = (url) => { try { const u = new URL(url); return `${u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : u.pathname}${u.search}`; } catch { return url; } };
function analyzeSite(pages, ctx) {
  const n = pages.length; const home = pages[0]; const view = siteView(pages.map((p) => p.f));
  let total = 0; const areas = { SEO: { got: 0, marks: 0 }, AEO: { got: 0, marks: 0 }, GEO: { got: 0, marks: 0 } }; const checks = []; const actions = [];
  for (const [key, area, pts, test, gap, fix] of Site.CHECKS) {
    let got; let result; let failing = [];
    if (PAGE_KEYS.has(key)) { const vals = pages.map((p) => test(p.f, { ms: p.ms })); const avg = vals.reduce((s, v) => s + FR[v], 0) / n; got = pts * avg; result = avg >= 1 ? 'yes' : avg <= 0 ? 'no' : 'partly'; failing = pages.filter((p, i) => vals[i] !== 'yes').map((p) => p.path); }
    else { result = test(SITE_KEYS.has(key) ? home.f : view, ctx); got = pts * FR[result]; }
    areas[area].got += got; areas[area].marks += pts; total += got;
    checks.push({ key, area, marks: pts, result, got: r1(got), ...(PAGE_KEYS.has(key) ? { badPages: failing.length } : {}) });
    if (result !== 'yes') actions.push({ key, area, lost: r1(pts - got), gap: PAGE_KEYS.has(key) && n > 1 ? `${cap1(gap)} (on ${failing.length} of ${n} pages)` : cap1(gap) + (result === 'partly' ? ' (partly)' : ''), fix, pages: failing.slice(0, 6) });
  }
  actions.sort((a, b) => b.lost - a.lost);
  const pageChecks = Site.CHECKS.filter((c) => PAGE_KEYS.has(c[0])); const pageMax = pageChecks.reduce((s, c) => s + c[2], 0);
  const rows = pages.map((p) => { let got = 0; const issues = []; for (const [key, , pts, test, gap, fix] of pageChecks) { const v = test(p.f, { ms: p.ms }); got += pts * FR[v]; if (v !== 'yes') issues.push({ key, gap: cap1(gap) + (v === 'partly' ? ' (partly)' : ''), fix }); } return { url: p.url, path: p.path, score: Math.round((got / pageMax) * 100), title: p.f.title || '', h1: (p.f.h1[0] && p.f.h1[0].text) || '', words: p.f.wordCount, ms: p.ms, issues }; });
  return { score: Math.round(total), areas, checks, actions, rows };
}
function crossFindings(pages, failed) {
  const out = [];
  const same = (key, label, pickFn, fix) => { const m = new Map(); for (const p of pages) { const t = String(pickFn(p.f) || '').trim().toLowerCase().replace(/\s+/g, ' '); if (!t) continue; if (!m.has(t)) m.set(t, []); m.get(t).push(p); } for (const a of [...m.values()].filter((x) => x.length > 1).slice(0, 3)) out.push({ key, gap: `${a.length} pages share the same ${label}`, detail: String(pickFn(a[0].f)).slice(0, 120), pages: a.map((p) => p.path).slice(0, 8), fix }); };
  same('dupTitle', 'title', (f) => f.title, 'Give every page its own title that says what that page is about.');
  same('dupDescription', 'meta description', (f) => f.description, 'Write a different description for each page, about what that page offers.');
  same('dupH1', 'main heading', (f) => f.h1[0] && f.h1[0].text, 'Give every page its own main heading (H1).');
  const thin = pages.filter((p) => p.f.wordCount > 0 && p.f.wordCount < 150); if (thin.length) out.push({ key: 'thin', gap: `${thin.length} short page${thin.length === 1 ? '' : 's'} (under 150 words)`, detail: '', pages: thin.map((p) => p.path).slice(0, 8), fix: 'Where a visitor needs more, add useful detail: what is offered, who it is for, prices or timings, and the next step. A contact page can stay short.' });
  const bad = failed.filter((f) => f.broken); if (bad.length) out.push({ key: 'pageError', gap: `${bad.length} page${bad.length === 1 ? '' : 's'} listed on the site did not open`, detail: '', pages: bad.map((f) => f.path).slice(0, 8), fix: 'Fix or redirect these pages, or take them out of the sitemap and the menu.' });
  return out;
}

// the whole multi-page check. input: the web address; max: how many pages in all (2 to 10); opts.fetchFn / opts.crawlMs let a test answer instead of the internet and the clock.
async function run(input, max, opts = {}) {
  const asked = Math.max(2, Math.min(MAX_PAGES, Math.round(Number(max) || 2)));
  const c = Site.cleanUrl(input); if (c.error) return c;
  const fetchFn = opts.fetchFn || fetchPublic;
  const homeRes = await Site.fetchPage(c.url, opts); if (homeRes.error) return homeRes;
  const f0 = Site.scanHtml(homeRes.html, homeRes.finalUrl); const origin = new URL(homeRes.finalUrl).origin; const host = siteHost(new URL(homeRes.finalUrl).hostname);
  const [ex, map] = await Promise.all([Site.extras(homeRes.finalUrl, f0, opts), readSitemap(origin, fetchFn)]);
  const seen = new Set([norm(homeRes.finalUrl, homeRes.finalUrl, host).href]); const cands = []; let fromLinks = 0; let byRobots = 0;
  const add = (href, base, from) => { const n = norm(href, base, host); if (!n || seen.has(n.href)) return; seen.add(n.href); if (map.disallow.some((d) => n.path.startsWith(d))) { byRobots += 1; return; } cands.push({ ...n, from }); if (from === 'links') fromLinks += 1; };
  f0.anchors.forEach((a) => add(a.href, homeRes.finalUrl, 'links')); map.urls.forEach((u) => add(u, origin, 'sitemap'));
  const chosen = pick(cands, asked - 1);
  const deadline = Date.now() + (opts.crawlMs != null ? opts.crawlMs : 35000);
  const got = await pool(chosen, 3, async (cand) => (Date.now() > deadline ? { cand, late: true } : { cand, res: await Site.fetchPage(cand.href, { ...opts, pageMs: 10000 }) }));
  const pages = [{ url: homeRes.finalUrl, path: pathOf(homeRes.finalUrl), f: f0, ms: homeRes.ms }]; const failed = []; let late = 0; const have = new Set(pages.map((p) => p.path));
  for (const g of got) {
    if (g.late) { late += 1; continue; }
    if (g.res.error) { const code = /\((\d{3})\)/.exec(g.res.error); failed.push({ path: g.cand.path, url: g.cand.href, reason: g.res.error, broken: !!code || /did not answer|could not be reached/i.test(g.res.error) }); continue; }
    const fin = g.res.finalUrl || g.cand.href; let fh = ''; try { fh = siteHost(new URL(fin).hostname); } catch { /* not an address */ }
    if (fh !== host) { failed.push({ path: g.cand.path, url: g.cand.href, reason: 'The page sends visitors to another website.', broken: false }); continue; }
    const p = pathOf(fin); if (have.has(p)) continue; have.add(p); // two addresses that end on the same page are one page
    pages.push({ url: fin, path: p, f: Site.scanHtml(g.res.html, fin), ms: g.res.ms });
  }
  const broken = { checked: ex.broken.checked + chosen.length, bad: ex.broken.bad, list: [...ex.broken.list] };
  for (const f of failed.filter((x) => x.broken)) { if (!broken.list.some((l) => l.startsWith(f.url))) { const code = /\((\d{3})\)/.exec(f.reason); broken.bad += 1; broken.list.push(`${f.url} (${code ? code[1] : 'no answer'})`); } }
  const ctx = { https: ex.https, robotsOk: ex.robotsOk, sitemapOk: ex.sitemapOk, broken };
  const a = analyzeSite(pages, ctx); const homeRep = Site.analyze(f0, { ...ctx, ms: homeRes.ms });
  return { report: {
    score: a.score, outOf: 100, areas: Object.entries(a.areas).map(([k, v]) => ({ key: k, label: Site.AREAS[k], got: r1(v.got), marks: v.marks })), checks: a.checks, actions: a.actions,
    disclaimer: `${Site.DISCLAIMER} With several pages, the page items (title, description, main heading and so on) are the average over the pages read; the answer-engine and local items count what is found on any page of the website.`,
    facts: homeRep.facts, url: homeRes.finalUrl, checkedAt: new Date().toISOString(), responseMs: homeRes.ms, links: broken, robotsOk: ex.robotsOk, sitemapOk: ex.sitemapOk,
    pages: a.rows, cross: crossFindings(pages, failed), extra: await require('./seoExtras').gather(pages, homeRes.finalUrl, { ...opts, xRobots: homeRes.xRobots }), // eslint-disable-line global-require
    crawl: { asked, found: cands.length, fromSitemap: map.urls.length, fromLinks, read: pages.length, failed: failed.map((f) => ({ path: f.path, reason: f.reason })), skippedByRobots: byRobots, notReadInTime: late, timeUp: late > 0 },
  } };
}

module.exports = { run, readSitemap, norm, pick, disallowOf, siteView, analyzeSite, crossFindings, PAGE_KEYS, SITE_KEYS, MAX_PAGES };
