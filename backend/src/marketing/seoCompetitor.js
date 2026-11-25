// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > WHAT COMPETITORS TARGET (2026-11-25). The part of the competitor analysis that the score comparison (competitors.js) does not show: from each competitor's PUBLIC home page
// and sitemap, what the site is ABOUT:
//   * its page title, meta description, main heading (H1) and sub-headings (H2), the kinds of structured data it uses and how long the page is;
//   * the words and two-word phrases its title and headings stress (the topics it targets): counted from those texts, minus common words and the business's own name;
//   * how the site is built: the number of pages in its sitemap, the biggest sections (/services, /blog ...), whether it has a blog, a FAQ and a pricing page;
//   * WHERE THE CLIENT CAN IMPROVE: the words and phrases a competitor stresses that the client's own home-page title, description and headings do not mention at all.
// HONEST BY DESIGN: this is public information read like a visitor. The words are what a page emphasises, NOT keywords with traffic: nothing says how many people search them or that they bring
// customers; they are ideas to check, worth using only where they are true for the client. BACKLINKS are not shown: no backlink data provider is connected and nothing is estimated. One page and the sitemap
// per site, through the safe fetch (public addresses only); nothing is logged in to and nothing is changed. Not saved: it is read again each time.
// ---------------------------------------------------------------------------
const Site = require('./siteCheck');
const Crawl = require('./siteCrawl');
const Sites = require('./seoSites');
const { fetchPublic } = require('../utils/safeFetch');

const MAX_COMPETITORS = 3;
const STOP = new Set(('a an and are as at be but by for from has have how in is it its of on or our that the their this to we with you your was were will can what who why when where which about all any more most not no yes new get one two near me us they them these those into over also than then there here such only own same so too very just home welcome page website official online best top contact call today now us if do does did been being am i my his her he she each every other some many much both either whether while during after before between under again once further').split(/\s+/));
const NO_BACKLINKS = 'Backlink data needs a backlink data provider. None is connected, so backlinks are not shown and nothing is estimated.';
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };
const tokens = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).map((t) => t.replace(/^['-]+|['-]+$/g, '')).filter(Boolean);
const pool = async (items, k, fn) => { const out = new Array(items.length); let i = 0; const w = async () => { while (i < items.length) { const j = i; i += 1; out[j] = await fn(items[j], j); } }; await Promise.all(Array.from({ length: Math.min(k, items.length) }, w)); return out; }; // eslint-disable-line no-await-in-loop

// the words and two-word phrases a page stresses. sources: [title, description, h1, ...h2]; own: words to leave out (the business's name and web address)
function termsOf(sources, own = []) {
  const skip = new Set(own); const uni = new Map(); const bi = new Map(); const ok = (t) => t.length >= 3 && !STOP.has(t) && !skip.has(t) && !/^\d+$/.test(t);
  for (const src of sources) {
    const toks = tokens(src); toks.forEach((t) => { if (ok(t)) uni.set(t, (uni.get(t) || 0) + 1); });
    for (let i = 0; i < toks.length - 1; i += 1) if (ok(toks[i]) && ok(toks[i + 1])) { const p = `${toks[i]} ${toks[i + 1]}`; bi.set(p, (bi.get(p) || 0) + 1); }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([term, count]) => ({ term, count }));
  return { words: top(uni, 10), phrases: top(bi, 8) };
}
function sitemapView(urls) {
  const sections = new Map(); let blog = false; let faq = false; let pricing = false;
  for (const u of urls) { let p = ''; try { p = new URL(u).pathname; } catch { continue; } const seg = p.split('/').filter(Boolean)[0] || ''; if (seg) sections.set(seg, (sections.get(seg) || 0) + 1); if (/\b(blog|news|articles|insights|resources)\b/i.test(p)) blog = true; if (/faq/i.test(p)) faq = true; if (/pric|fees|plans/i.test(p)) pricing = true; }
  return { pages: urls.length, sections: [...sections.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([section, pages]) => ({ section: `/${section}`, pages })), hasBlog: blog, hasFaq: faq, hasPricing: pricing };
}

// one website, read once. -> { name, url, title, description, h1, h2, schemaTypes, words, lang, terms, sitemap } or { name, url, error }
async function read(name, url, opts) {
  const fetchFn = opts.fetchFn || fetchPublic; const page = await Site.fetchPage(url, opts); if (page.error) return { name, url, error: page.error };
  const f = Site.scanHtml(page.html, page.finalUrl); let map = { urls: [] }; try { map = await Crawl.readSitemap(new URL(page.finalUrl).origin, fetchFn); } catch { /* a site with no sitemap is read through its page only */ }
  const h1 = f.h1.map((h) => clean(h.text, 140)).slice(0, 3); const h2 = f.headings.filter((h) => h.level === 2).map((h) => clean(h.text, 120)).slice(0, 15); const host = hostOf(page.finalUrl);
  const own = [...tokens(name), ...host.split('.').slice(0, -1).flatMap((x) => x.split('-')).filter((x) => x.length >= 3)];
  return { name, url: page.finalUrl, title: clean(f.title, 160), description: clean(f.description, 300), h1, h2, schemaTypes: [...new Set(f.schemaTypes)].slice(0, 10), words: f.wordCount, lang: f.lang || '', terms: termsOf([f.title, f.description, ...h1, ...h2], own), sitemap: sitemapView(map.urls || []), ownText: [f.title, f.description, ...f.headings.map((h) => h.text)].join(' ').toLowerCase() };
}

// b: { siteId?, client: web address, clientName, competitors: [web addresses] }; opts.fetchFn lets a test answer instead of the internet
async function topics(u, b = {}, opts = {}) {
  let clientUrl = b.client; let comps = Array.isArray(b.competitors) ? b.competitors : []; let clientName = clean(b.clientName, 80);
  if (b.siteId) { const site = await Sites.mine(u, b.siteId); if (!site) return { error: 'That SEO site was not found.', status: 404 }; clientUrl = clientUrl || site.url; if (!comps.some((c) => clean(c, 300))) comps = Sites.rowOut(site).competitors; clientName = clientName || site.clientName; }
  const list = [{ name: clientName || 'The client', raw: clientUrl }, ...comps.filter((c) => clean(c, 300)).slice(0, MAX_COMPETITORS).map((c, i) => ({ name: `Competitor ${i + 1}`, raw: c }))];
  if (list.length < 2) return { error: 'Add at least one competitor website.', status: 400 };
  for (let i = 0; i < list.length; i += 1) { const c = Site.cleanUrl(list[i].raw); if (c.error) return { error: `${i === 0 ? 'The client website' : `Competitor ${i}`}: ${c.error}`, status: 400 }; list[i].url = c.url; list[i].name = i === 0 ? list[i].name : (hostOf(c.url) || list[i].name); }
  const hosts = list.map((p) => hostOf(p.url)); if (new Set(hosts).size !== hosts.length) return { error: 'The same website is listed twice. Each business needs its own address.', status: 400 };
  const parties = await pool(list, 2, (p) => read(p.name, p.url, opts)); const me = parties[0]; const rivals = parties.slice(1);
  if (!rivals.some((p) => !p.error)) return { error: `None of the competitor websites could be read (${rivals.map((p) => `${p.name}: ${p.error}`).join('; ')}).`, status: 502 };
  const gaps = me.error ? [] : rivals.filter((p) => !p.error).map((p) => ({ competitor: p.name, words: p.terms.words.filter((w) => !me.ownText.split(/[^\p{L}\p{N}'-]+/u).includes(w.term)).slice(0, 8), phrases: p.terms.phrases.filter((w) => !me.ownText.includes(w.term)).slice(0, 6) }));
  const strip = (p) => { if (p.error) return p; const { ownText, ...rest } = p; return rest; };
  return { parties: parties.map(strip), gaps, backlinks: { available: false, note: NO_BACKLINKS }, comparedAt: new Date().toISOString(),
    notes: me.error ? [`The client's website could not be read (${me.error}), so there is no comparison with it. The competitors are shown on their own.`] : ['"Where the client can improve" lists words and phrases a competitor stresses that the client\'s home-page title, description and headings do not mention.', 'These are what a page emphasises, not keywords with traffic: nothing here says how many people search them. Use one only if it is true for the client.', 'Read like a visitor: one page and the sitemap per site. Nothing is logged in to or changed.'] };
}

module.exports = { topics, termsOf, sitemapView, MAX_COMPETITORS, NO_BACKLINKS };
