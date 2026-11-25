// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > EXTRA AUDIT FINDINGS (2026-11-25). What the 23-check website audit (siteCheck.js / siteCrawl.js) does not look at, added to every audit report as `report.extra`:
//   * the robots.txt file asks ALL robots to stay away from the whole site ("Disallow: /") and the X-Robots-Tag header says noindex: both stop a site from being found, and neither shows in the page's own tags;
//   * INTERNAL LINKING: a home page that links to no other page, pages that link to fewer than 3 pages (dead ends), pages read that no other page read links to, and vague link words ("click here");
//   * the social-card tags (Open Graph and Twitter card) that decide how a link looks when it is shared;
//   * the pictures without alternative text (which ones, not only how many) and the heading outline of each page read (H1, H2, H3), for the detailed report.
// These are FINDINGS, not marks: they do not change the 100-mark score, so the score stays comparable with every earlier saved check. They are read from the pages the audit already fetched (plus ONE extra
// request for robots.txt); nothing is posted or changed on the website. HONEST: "not linked from the pages read" says what was read (at most 10 pages), not that nobody links to the page.
// ---------------------------------------------------------------------------
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };
const pathKey = (href, base) => { // host + path of an address, so /about, /about/ and https://www.site/about#x are one page
  try { const u = new URL(href, base); if (!/^https?:$/.test(u.protocol)) return ''; let p = u.pathname.replace(/\/{2,}/g, '/').replace(/\/index\.(html?|php|aspx?)$/i, '/'); if (p.length > 1) p = p.replace(/\/$/, ''); return `${hostOf(u.href)}${p}`; } catch { return ''; }
};
const SKIP_HREF = /^(#|mailto:|tel:|javascript:|sms:|whatsapp:|data:)/i;
const GENERIC = /^(click here|here|read more|more|learn more|know more|details|link|this|click|view more|see more)$/i;
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const cap1 = (s) => s[0].toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// the internal links of a page: [keys of other pages of the SAME website]
function internalOf(page, home) {
  const host = hostOf(home); const me = pathKey(page.url, page.url); const out = new Set();
  for (const a of page.f.anchors || []) {
    if (SKIP_HREF.test(a.href)) continue; let u; try { u = new URL(a.href, page.url); } catch { continue; }
    if (hostOf(u.href) !== host) continue; const k = pathKey(u.href, page.url); if (k && k !== me) out.add(k);
  }
  return out;
}

// pure: pages = [{ url, path, f }] (f from siteCheck.scanHtml), ctx = { robotsText, xRobots } -> { findings, altImages, outlines }
// each finding: { key, area, gap, detail, fix, pages[], impact: 'high'|'medium'|'low', serious: bool }
function findings(pages, ctx = {}) {
  const out = []; const home = pages[0]; const f0 = home.f;
  const add = (o) => out.push({ area: 'SEO', detail: '', pages: [], serious: false, ...o });

  // 1 can search engines come in at all?
  const rules = require('./siteCrawl').disallowOf(ctx.robotsText || ''); // eslint-disable-line global-require
  if (rules.includes('/')) add({ key: 'robotsBlocksAll', impact: 'high', serious: true, gap: 'robots.txt asks every search engine to stay away from the whole website', detail: 'The file has "User-agent: *" followed by "Disallow: /".', fix: 'Remove "Disallow: /" from robots.txt (or change it to "Allow: /") unless the site is meant to be hidden. Until then it cannot be found in search.' });
  if (/noindex/i.test(ctx.xRobots || '')) add({ key: 'noindexHeader', impact: 'high', serious: true, gap: 'the server tells search engines not to index the home page (X-Robots-Tag header)', detail: `The header says: ${clip(ctx.xRobots, 120)}.`, fix: 'Ask the web person to remove "noindex" from the X-Robots-Tag header of the server (it is set in the server or the hosting settings, not in the page).' });

  // 2 internal linking
  const inner = pages.map((p) => ({ p, links: internalOf(p, home.url) }));
  if (pages.length === 1) {
    if (!inner[0].links.size && (f0.wordCount || 0) > 0) add({ key: 'noInternalLinks', impact: 'high', gap: 'the home page does not link to any other page of the website', fix: 'Link the home page to the main pages (services, about, contact, FAQ) with a menu and with links inside the text, so visitors and search engines can reach them.' });
  } else {
    const dead = inner.filter((x) => x.links.size < 3).map((x) => x.p.path);
    if (dead.length) add({ key: 'fewInternalLinks', impact: 'medium', gap: `${plural(dead.length, 'page')} link${dead.length === 1 ? 's' : ''} to fewer than 3 other pages`, pages: dead.slice(0, 8), fix: 'Give every page a menu and a few useful links to related pages (the service, the contact page, the FAQ) so a visitor is never at a dead end.' });
    const linked = new Set(); inner.forEach((x) => x.links.forEach((k) => linked.add(k)));
    const lone = pages.slice(1).filter((p) => !linked.has(pathKey(p.url, p.url))).map((p) => p.path);
    if (lone.length) add({ key: 'notLinked', impact: 'medium', gap: `${plural(lone.length, 'page')} read ${lone.length === 1 ? 'is' : 'are'} not linked from the other pages read`, detail: 'They were found in the sitemap. Only up to 10 pages are read, so a page can be linked from a page that was not read.', pages: lone.slice(0, 8), fix: 'Link each important page from the menu or from a related page. A page that nothing links to is hard for search engines and visitors to find.' });
  }
  const generic = pages.flatMap((p) => (p.f.anchors || []).filter((a) => GENERIC.test(a.text)).map(() => p.path));
  if (generic.length >= 3) add({ key: 'genericLinks', impact: 'low', gap: `${plural(generic.length, 'link')} say only "click here", "read more" or similar`, pages: [...new Set(generic)].slice(0, 8), fix: 'Write link words that say where the link goes ("Read about our cardiology department") so search engines and screen readers understand them.' });

  // 3 how a shared link looks
  const missing = []; if (!f0.ogTitle) missing.push('og:title'); if (!f0.ogDescription) missing.push('og:description'); if (!f0.ogImage) missing.push('og:image'); if (!f0.twitterCard) missing.push('twitter:card');
  if (missing.length) add({ key: 'socialCard', impact: 'low', gap: `the home page has no ${missing.length === 4 ? 'social-card tags' : `${missing.join(', ')} tag${missing.length === 1 ? '' : 's'}`}`, detail: `Missing: ${missing.join(', ')}.`, fix: 'Add the Open Graph and Twitter card tags to the page head so a link shared on WhatsApp, Facebook or LinkedIn shows a proper title, description and picture.' });

  // 4 for the detailed report
  const altImages = []; const outlines = [];
  for (const p of pages) {
    for (const i of p.f.images || []) if ((i.alt == null || !String(i.alt).trim()) && altImages.length < 15) altImages.push({ page: p.path, src: clip(i.src, 160) });
    outlines.push({ path: p.path, headings: (p.f.headings || []).slice(0, 25).map((h) => ({ level: h.level, text: clip(h.text, 90) })) });
  }
  return { findings: out, altImages, outlines: outlines.slice(0, 10) };
}

// the one network part: robots.txt (the audit only keeps "is there one"). NEVER throws: a failure gives no findings from robots.txt.
async function gather(pages, finalUrl, opts = {}) {
  try {
    const Site = require('./siteCheck'); const { fetchPublic } = require('../utils/safeFetch'); // eslint-disable-line global-require
    let robotsText = '';
    try { const r = await Site.rawGet(opts.fetchFn || fetchPublic, new URL('/robots.txt', new URL(finalUrl).origin).href, 6000); if (r.status === 200) robotsText = (await Site.readCapped(r, 300000)).slice(0, 20000); } catch { /* no robots.txt, or it did not answer */ }
    return findings(pages, { robotsText, xRobots: opts.xRobots || '' });
  } catch { return { findings: [], altImages: [], outlines: [] }; }
}

module.exports = { findings, gather, pathKey, cap1 };
