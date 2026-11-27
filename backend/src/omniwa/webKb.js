// ---------------------------------------------------------------------------
// THE COMPANY WEBSITE AS THE WHATSAPP AI'S KNOWLEDGE (founder 2026-11-20: "mana products gurinchi adigitheyy website loo chusii answer evvali").
// Pure helpers, no database: crawl a few pages of OUR OWN website, cut each page into small sections (a heading and the words under it) and hand them to the knowledge base
// (config.js kbImportWebsite) as question + answer. The AI answers about the products from these sections and from nothing else.
// (2026-11-27) Public addresses only (utils/safeFetch.js checks the address and every redirect). A site that moves to www / https is followed; a move to another site is not read. The phone numbers,
// e-mail addresses and postal address the site itself publishes (phone / mail links, <address>, business data) become one "Contact details" entry, and the home page's own description one "about" entry.
// ---------------------------------------------------------------------------
const { fetchPublic } = require('../utils/safeFetch');
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|css|js|json|xml|pdf|zip|mp4|woff2?|ttf|txt)(\?|#|$)/i;
// the Telugu / Hindi copies of every page would only repeat the English words
const SKIP_PATH = /^\/((te|hi)(\/|$)|(wp-admin|wp-login|wp-json|cart|checkout|my-account|login|signin|sign-in|register|feed|tag|author)(\/|\.php|$))/i;
const PAGE_CAP = 2000000; // letters of one page that are read

const decode = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } });
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

// the business data blocks of a page (JSON-LD), flattened
function ldOf(html) {
  const out = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(walk); return; } out.push(n); Object.values(n).forEach((v) => { if (v && typeof v === 'object') walk(v); }); };
  for (const m of String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1].trim())); } catch { /* a broken block says nothing */ } }
  return out;
}
/** What a page itself publishes about reaching the business: its phone and mail links, an <address> block, its business data. Nothing is guessed from running text. */
function contactOf(html) {
  const raw = String(html || ''); const phones = new Map(); const emails = new Set(); const addresses = new Set();
  const phone = (v) => { let t = String(v || ''); try { t = decodeURIComponent(t); } catch { /* as it is */ } t = decode(t).replace(/[^\d+() -]/g, ' ').replace(/\s+/g, ' ').trim(); const d = t.replace(/\D/g, ''); if (d.length >= 8 && d.length <= 15 && !phones.has(d.slice(-10))) phones.set(d.slice(-10), t); };
  const email = (v) => { let t = String(v || '').split('?')[0]; try { t = decodeURIComponent(t); } catch { /* as it is */ } t = decode(t).trim().toLowerCase(); if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(t)) emails.add(t); };
  const address = (v) => { const t = String(v || '').replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/,(\s*,)+/g, ',').replace(/^[\s.,]+|[\s,]+$/g, ''); if (t.length >= 15 && t.length <= 300) addresses.add(t); };
  for (const m of raw.matchAll(/\bhref\s*=\s*["']\s*(tel|mailto):([^"']+)["']/gi)) (m[1].toLowerCase() === 'tel' ? phone : email)(m[2]);
  for (const m of raw.matchAll(/<address\b[^>]*>([\s\S]*?)<\/address>/gi)) address(decode(m[1].replace(/<a\b[^>]*(tel|mailto):[\s\S]*?<\/a>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li)>/gi, ', ').replace(/<[^>]*>/g, ' ')));
  for (const n of ldOf(raw)) {
    if (typeof n.telephone === 'string') phone(n.telephone);
    if (typeof n.email === 'string') email(n.email.replace(/^mailto:/i, ''));
    const a = n.address;
    if (a && typeof a === 'object' && !Array.isArray(a)) address([a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter((x) => typeof x === 'string' && x.trim()).join(', '));
  }
  return { phones: [...phones.values()], emails: [...emails], addresses: [...addresses] };
}
// what the page says about itself, in its own words
function descriptionOf(html) {
  for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    if (!/(name|property)\s*=\s*["'](description|og:description)["']/i.test(m[0])) continue; // eslint-disable-line no-continue
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[0]); const t = c ? decode(c[1] != null ? c[1] : c[2]).replace(/\s+/g, ' ').trim() : '';
    if (t) return t;
  }
  return '';
}
const CONTACT_TITLE = 'Contact details: phone number, email and address';
const bareHost = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

/**
 * Walk a site from its first address: the page itself and the pages it links to on the same site, at most `maxPages`, 15 seconds a page, HTML only.
 * It stops starting new pages after `maxMs`.
 * -> { pages: [url], entries: [{ question, answer }], failed: [url] }. `fetchFn` is the test seam.
 */
async function crawl(startUrls, { maxPages = 30, maxMs = 45000, fetchFn = fetchPublic } = {}) {
  const queue = [...startUrls];
  const seen = new Set();
  const pages = []; const failed = []; const entries = [];
  const seenText = new Set();
  const contact = { phones: new Map(), emails: new Set(), addresses: new Set() };
  let about = null; const t0 = Date.now();
  while (queue.length && pages.length < maxPages && Date.now() - t0 < maxMs) {
    const url = queue.shift();
    if (seen.has(url)) continue; // eslint-disable-line no-continue
    seen.add(url);
    try {
      const res = await fetchFn(url, { headers: { 'user-agent': 'TeamLinkKnowledgeBot/1.0 (+https://tmlink.in)' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }); // eslint-disable-line no-await-in-loop
      const type = String(res.headers && res.headers.get ? res.headers.get('content-type') : 'text/html');
      if (!res.ok || !/html/i.test(type)) { failed.push(url); continue; } // eslint-disable-line no-continue
      const at = res.url || url; // where it really came from (a redirect to www or https is followed)
      if (bareHost(at) !== bareHost(url)) { failed.push(url); continue; } // eslint-disable-line no-continue
      if (at !== url && seen.has(at)) continue; // eslint-disable-line no-continue
      seen.add(at);
      const html = String(await res.text()).slice(0, PAGE_CAP); // eslint-disable-line no-await-in-loop
      pages.push(at);
      const c = contactOf(html); c.phones.forEach((p) => { const k = p.replace(/\D/g, '').slice(-10); if (!contact.phones.has(k)) contact.phones.set(k, p); }); c.emails.forEach((x) => contact.emails.add(x)); c.addresses.forEach((x) => contact.addresses.add(x));
      if (pages.length === 1) { const d = descriptionOf(html); if (d.length >= 50) about = { question: 'Home: about us', answer: clip(`${d} (Page: ${at})`, 1450) }; }
      for (const e of sectionsOf(html, at)) {
        const key = e.answer.replace(/\s*\(Page: [^)]*\)\s*$/, '').slice(0, 160);
        if (!seenText.has(key)) { seenText.add(key); entries.push(e); }
      }
      for (const l of linksOf(html, at)) if (!seen.has(l)) queue.push(l);
    } catch { failed.push(url); }
  }
  const first = [];
  const said = [contact.phones.size ? `Phone: ${[...contact.phones.values()].slice(0, 4).join(', ')}.` : '', contact.emails.size ? `Email: ${[...contact.emails].slice(0, 4).join(', ')}.` : '', contact.addresses.size ? `Address: ${[...contact.addresses].slice(0, 2).join('; ')}.` : ''].filter(Boolean).join(' ');
  if (said) first.push({ question: CONTACT_TITLE, answer: clip(`${said} (Page: ${pages[0]})`, 1450) });
  if (about && !seenText.has(about.answer.replace(/\s*\(Page: [^)]*\)\s*$/, '').slice(0, 160))) first.push(about);
  return { pages, entries: [...first, ...entries], failed };
}

module.exports = { crawl, sectionsOf, linksOf, contactOf, strip, CONTACT_TITLE };
