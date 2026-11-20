// ---------------------------------------------------------------------------
// THE COMPANY WEBSITE AS THE WHATSAPP AI'S KNOWLEDGE (founder 2026-11-20: "mana products gurinchi adigitheyy website loo chusii answer evvali").
// Pure helpers, no database: crawl a few pages of OUR OWN website, cut each page into small sections (a heading and the words under it) and hand them to the knowledge base
// (config.js kbImportWebsite) as question + answer. The AI answers about the products from these sections and from nothing else.
// ---------------------------------------------------------------------------
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|css|js|json|xml|pdf|zip|mp4|woff2?|ttf|txt)(\?|#|$)/i;
// the Telugu / Hindi copies of every page would only repeat the English words
const SKIP_PATH = /^\/(te|hi)(\/|$)/i;

const decode = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } });
const strip = (html) => decode(String(html || '')
  .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|li|div|tr|h\d|section)>/gi, '. ').replace(/<[^>]*>/g, ' '))
  .replace(/\s+/g, ' ').replace(/(\.\s*){2,}/g, '. ').trim();

/** The links of a page that stay on the same site and lead to another page (never a file, never the Telugu / Hindi copies). */
function linksOf(html, pageUrl) {
  const out = new Set();
  let base;
  try { base = new URL(pageUrl); } catch { return []; }
  for (const m of String(html || '').matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue; // eslint-disable-line no-continue
    let u;
    try { u = new URL(href, base); } catch { continue; } // eslint-disable-line no-continue
    if (u.origin !== base.origin || SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) continue; // eslint-disable-line no-continue
    u.hash = ''; u.search = '';
    u.pathname = u.pathname.replace(/\/index\.html$/i, '/'); // /index.html is the home page
    out.add(u.toString());
  }
  return [...out];
}

/** "services/digital-marketing.html" -> "Digital Marketing"; the home page -> "Home". */
function pageLabel(pageUrl) {
  try {
    const seg = new URL(pageUrl).pathname.split('/').filter(Boolean).pop() || '';
    const name = seg.replace(/\.html?$/i, '').replace(/^index$/i, '').replace(/[-_]+/g, ' ').trim();
    return name ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Home';
  } catch { return 'Home'; }
}

/** One page -> [{ question, answer }]: the page name, and each heading with the words under it; long sections are cut into parts. */
function sectionsOf(html, pageUrl) {
  const raw = String(html || '');
  const title = pageLabel(pageUrl);
  const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(raw) || [, raw])[1];
  const parts = body.split(/(<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>)/i);
  const out = [];
  let heading = title;
  const push = (text) => {
    const t = strip(text);
    if (t.length < 50) return; // a menu word or a button, not knowledge
    for (let i = 0, n = 1; i < t.length; i += 1100, n += 1) {
      out.push({ question: clip(heading === title ? title : `${title}: ${heading}`, 280) + (i ? ` (part ${n})` : ''), answer: clip(`${t.slice(i, i + 1100)} (Page: ${pageUrl})`, 1450) });
    }
  };
  for (const p of parts) {
    if (/^<h[1-3]\b/i.test(p)) { heading = strip(p) || heading; continue; } // eslint-disable-line no-continue
    push(p);
  }
  return out;
}

/**
 * Walk a site from its first address: the page itself and the pages it links to on the same site, at most `maxPages`, 15 seconds a page, HTML only.
 * -> { pages: [url], entries: [{ question, answer }], failed: [url] }. `fetchFn` is the test seam.
 */
async function crawl(startUrls, { maxPages = 30, fetchFn = fetch } = {}) {
  const queue = [...startUrls];
  const seen = new Set();
  const pages = []; const failed = []; const entries = [];
  const seenText = new Set();
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    if (seen.has(url)) continue; // eslint-disable-line no-continue
    seen.add(url);
    try {
      const res = await fetchFn(url, { headers: { 'user-agent': 'TeamLinkKnowledgeBot/1.0 (+https://tmlink.in)' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }); // eslint-disable-line no-await-in-loop
      const type = String(res.headers && res.headers.get ? res.headers.get('content-type') : 'text/html');
      if (!res.ok || !/html/i.test(type)) { failed.push(url); continue; } // eslint-disable-line no-continue
      const html = await res.text(); // eslint-disable-line no-await-in-loop
      pages.push(url);
      for (const e of sectionsOf(html, url)) {
        const key = e.answer.replace(/\s*\(Page: [^)]*\)\s*$/, '').slice(0, 160);
        if (!seenText.has(key)) { seenText.add(key); entries.push(e); }
      }
      for (const l of linksOf(html, url)) if (!seen.has(l)) queue.push(l);
    } catch { failed.push(url); }
  }
  return { pages, entries, failed };
}

module.exports = { crawl, sectionsOf, linksOf, strip };
