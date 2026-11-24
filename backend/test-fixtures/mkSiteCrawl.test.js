// AI Marketing > SEO & visibility > Website check over SEVERAL pages (marketing/siteCrawl.js, reached through siteCheck.check with `pages`).
//   node backend/test-fixtures/mkSiteCrawl.test.js     (throw-away copy of prisma/sandbox.db; the internet is a stand-in: nothing real is called, nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-crawl-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; delete process.env.ALLOW_PRIVATE_FETCH;
const Site = require('../src/marketing/siteCheck'); const Crawl = require('../src/marketing/siteCrawl');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };

const BODY = Array(7).fill('<p>Our team looks after patients with care and keeps the waiting time short. Visitors can ask for help at the front desk at any hour.</p>').join('');
const DESC = 'Medical care, appointments and departments at M Hospital in Hyderabad, with doctors you can book online.';
const mk = (o) => `<!doctype html><html lang="en"><head><title>${o.title}</title>${o.desc === null ? '' : `<meta name="description" content="${DESC} Page: ${o.h1}.">`}<meta name="viewport" content="width=device-width, initial-scale=1">${o.canon === null ? '' : `<link rel="canonical" href="https://m.test${o.path}">`}${o.ld || ''}</head><body><h1>${o.h1}</h1>${o.body === undefined ? BODY : o.body}</body></html>`;
const ORG = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Hospital","name":"M Hospital","telephone":"+91 98765 43210","url":"https://m.test/","address":{"@type":"PostalAddress","streetAddress":"1 Test Road","postalCode":"500001"},"sameAs":["https://facebook.com/mhospital"]}</script>';
const FAQLD = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>';
const LINKS = '<img src="a.jpg" alt="Front"><a href="/index.html">Home</a> <a href="/about">About</a> <a href="/about/">About again</a> <a href="/about#team">Team</a> <a href="/services">Services</a> <a href="/contact">Contact</a> <a href="/blog/a">A</a> <a href="/blog/b">B</a> <a href="/blog/c">C</a> <a href="/brochure.pdf">Brochure</a> <a href="/wp-admin/">Admin</a> <a href="https://other.test/x">Other</a> <a href="mailto:a@b.test">Mail</a> <a href="/gone">Gone</a> <a href="/shop?color=red">Filter</a>';
const SITE = {
  'https://m.test/': mk({ path: '/', title: 'M Hospital in Hyderabad: departments and appointments', h1: 'M Hospital', ld: ORG, body: BODY + LINKS }),
  'https://m.test/robots.txt': 'User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /private\nSitemap: https://m.test/sitemap.xml',
  'https://m.test/sitemap.xml': '<urlset><url><loc>https://m.test/faq</loc></url><url><loc>https://m.test/doctors</loc></url><url><loc>https://m.test/old-gone</loc></url><url><loc>https://m.test/private/secret</loc></url><url><loc>https://m.test/about</loc></url></urlset>',
  'https://m.test/about': mk({ path: '/about', title: 'About M Hospital: our story and our doctors', h1: 'About us' }),
  'https://m.test/about/': mk({ path: '/about', title: 'About M Hospital: our story and our doctors', h1: 'About us' }),
  'https://m.test/services': mk({ path: '/services', title: 'Services at M Hospital in Hyderabad', h1: 'Services', desc: null, canon: null }), // no description, no canonical
  'https://m.test/contact': mk({ path: '/contact', title: 'About M Hospital: our story and our doctors', h1: 'Contact', body: '<p>Call us on +91 98765 43210. M Hospital, 1 Test Road, Hyderabad 500001.</p>' }), // the same title as About; short; the phone and address live only here
  'https://m.test/faq': mk({ path: '/faq', title: 'Frequently asked questions at M Hospital', h1: 'Questions', ld: FAQLD, body: `<h2>Frequently asked questions</h2><h2>What are the visiting hours?</h2><p>Every day.</p><h2>How do I book an appointment?</h2><p>Call or use the form.</p><h2>Is parking free?</h2><p>Yes.</p>${BODY}` }),
  'https://m.test/doctors': mk({ path: '/doctors', title: 'Doctors at M Hospital in Hyderabad', h1: 'Doctors', body: `<ul><li>Cardiology</li><li>Neurology</li></ul>${BODY}` }),
  'https://m.test/blog/a': mk({ path: '/blog/a', title: 'Blog: the first post from M Hospital', h1: 'Post A' }),
  'https://m.test/blog/b': mk({ path: '/blog/b', title: 'Blog: the second post from M Hospital', h1: 'Post B' }),
  'https://m.test/blog/c': mk({ path: '/blog/c', title: 'Blog: the third post from M Hospital', h1: 'Post C' }),
  'https://m.test/brochure.pdf': 'pdf',
};
SITE['https://m.test/index.html'] = SITE['https://m.test/']; // the same page under a second address
const mkFetch = (pages, log) => async (url, init) => { if (log) log.push(`${(init && init.method) || 'GET'} ${url}`); const hit = pages[url]; const status = hit === undefined ? 404 : typeof hit === 'number' ? hit : 200; const body = typeof hit === 'string' ? hit : ''; return { status, url, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? (String(url).endsWith('.xml') || String(url).endsWith('.txt') ? 'text/plain' : 'text/html') : null) }, text: async () => body }; };
const slow = (f, ms) => async (u, i) => { await new Promise((r) => setTimeout(r, ms)); return f(u, i); };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet

  // 1. the small pure parts
  const sum = (set, inSet) => Site.CHECKS.filter((c) => set.has(c[0]) === inSet).reduce((s, c) => s + c[2], 0);
  assert.deepEqual([sum(Crawl.PAGE_KEYS, true), sum(Crawl.SITE_KEYS, true), Site.CHECKS.reduce((s, c) => s + c[2], 0)], [40, 10, 100], 'page items 40 + site items 10 + website items 50 = 100');
  assert.deepEqual(Site.CHECKS.filter((c) => !Crawl.PAGE_KEYS.has(c[0]) && !Crawl.SITE_KEYS.has(c[0])).map((c) => c[1]).filter((a) => a === 'SEO'), [], 'every SEO item is a page or a site item; AEO and GEO are about what the website offers');
  const nm = (h) => Crawl.norm(h, 'https://www.m.test/a/', 'm.test');
  assert.equal(nm('/x/').href, 'https://www.m.test/x'); assert.equal(nm('/x#top').href, 'https://www.m.test/x'); assert.equal(nm('/index.html').href, 'https://www.m.test/', '/index.html is the home page'); assert.equal(nm('/shop/index.php').href, 'https://www.m.test/shop', 'a folder\'s index page is the folder'); assert.equal(nm('https://m.test/y?utm_source=a&fbclid=1').href, 'https://m.test/y'); assert.equal(nm('/post?p=12').path, '/post?p=12');
  for (const bad of ['https://other.test/x', 'mailto:a@b.test', 'tel:123', 'javascript:void(0)', '/file.PDF', '/img/a.jpg', '/wp-admin/x', '/cart', '/blog/tag/news', '/search?q=a', '/shop?color=red']) assert.equal(nm(bad), null, bad);
  assert.deepEqual(Crawl.disallowOf('User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /a\nDisallow: /b*\nDisallow:\nAllow: /a/ok\n# Disallow: /c'), ['/a']); assert.deepEqual(Crawl.disallowOf('User-agent: x\nUser-agent: *\nDisallow: /m'), ['/m']); assert.deepEqual(Crawl.disallowOf(''), []);
  const cands = ['/blog/1', '/blog/2', '/blog/3', '/about', '/zebra', '/contact', '/a/b/c/d'].map((p) => ({ href: `https://m.test${p}`, path: p }));
  assert.deepEqual(Crawl.pick(cands, 4).map((c) => c.path), ['/about', '/contact', '/blog/1', '/blog/2'], 'pages that matter first, two from one section at most'); assert.equal(Crawl.pick(cands, 7).length, 7, 'a small site is filled up from what is left');
  console.log('PASS the parts: 40 + 10 + 50 marks, addresses worth reading (same website only; no files, log-in, cart, tags, searches), robots.txt rules, the pages that matter first');

  // 2. a whole website
  const log = []; const f = mkFetch(SITE, log);
  const run = await Site.check(admin, { url: 'm.test', pages: 10 }, { fetchFn: f }); assert.ok(run.report, JSON.stringify(run)); const r = run.report;
  assert.deepEqual([r.crawl.asked, r.crawl.found, r.crawl.fromSitemap, r.crawl.fromLinks, r.crawl.read, r.crawl.skippedByRobots, r.crawl.timeUp], [10, 10, 5, 7, 8, 1, false]);
  assert.deepEqual(r.pages.map((p) => p.path).sort(), ['/', '/about', '/blog/a', '/blog/b', '/contact', '/doctors', '/faq', '/services'], 'the home page, the pages that matter and two blog posts; not the third post, not the files, not the pages robots.txt closes');
  assert.deepEqual(r.crawl.failed.map((x) => x.path).sort(), ['/gone', '/old-gone']);
  for (const never of ['/private/secret', '/wp-admin', 'other.test', '/shop', 'mailto']) assert.ok(!log.some((u) => u.includes(never)), `never asked for ${never}`);
  assert.equal(log.filter((u) => u === 'GET https://m.test/about').length, 1, 'About, About/ and About#team are one page, read once'); assert.ok(!log.includes('GET https://m.test/blog/c') && !log.includes('GET https://m.test/brochure.pdf'), 'the third blog post and the brochure file are never read as pages');
  const svc = r.pages.find((p) => p.path === '/services'); assert.deepEqual([svc.score, svc.issues.map((i) => i.key).sort()], [78, ['canonical', 'description']], '40 page marks: 6 + 3 lost = 31 of 40 = 78');
  assert.equal(r.pages.filter((p) => p.score === 100).length, 7); assert.equal(r.pages[0].path, '/'); assert.equal(r.pages[0].url, 'https://m.test/');
  const act = (k) => r.actions.find((a) => a.key === k);
  assert.ok(/\(on 1 of 8 pages\)$/.test(act('description').gap) && /\(on 1 of 8 pages\)$/.test(act('canonical').gap) && act('description').pages.join() === '/services', 'a page finding says on how many pages and which');
  for (const k of ['faqSection', 'faqSchema', 'questionHeadings', 'nap', 'orgSchema', 'structure']) assert.ok(!act(k), `${k}: the website has it on some page (the FAQ page, the contact page), so the home page alone is not blamed`);
  assert.equal(act('brokenLinks').gap, 'Broken links on the page (partly)'); assert.equal(r.links.bad, 2); assert.deepEqual(r.links.list.map((l) => l.replace(/^https:\/\/m\.test/, '')).sort(), ['/gone (404)', '/old-gone (404)']);
  assert.equal(r.score, 97, `100 - 0.75 (description) - 0.375 (canonical) - 1.5 (two broken pages, partly) = 97.375: ${JSON.stringify(r.actions.map((a) => [a.key, a.lost]))}`);
  assert.deepEqual(r.areas.map((a) => [a.key, a.marks]), [['SEO', 50], ['AEO', 25], ['GEO', 25]]); assert.ok(/average over the pages read/.test(r.disclaimer) && /does not guarantee/.test(r.disclaimer));
  assert.deepEqual(r.cross.map((c) => c.key), ['dupTitle', 'thin', 'pageError']); assert.deepEqual(r.cross[0].pages, ['/about', '/contact']); assert.deepEqual(r.cross[1].pages, ['/contact']); assert.deepEqual(r.cross[2].pages, ['/gone', '/old-gone']);
  const one = (await Site.check(admin, { url: 'm.test' }, { fetchFn: f })).report; assert.equal(one.crawl, undefined); assert.equal(one.pages, undefined); assert.ok(one.score < r.score, `one page alone is blamed for what other pages have: ${one.score} < ${r.score}`); assert.ok(one.actions.some((a) => a.key === 'faqSection'));
  console.log('PASS a website: 8 pages read of 10 found, the findings with their pages, the FAQ and contact details found on other pages, duplicate titles, a short page, two pages that do not open, robots.txt and files left alone, the score arithmetic');

  // 3. time, small sites, redirects, limits
  const late = (await Site.check(admin, { url: 'm.test', pages: 10 }, { fetchFn: slow(mkFetch(SITE), 40), crawlMs: 25 })).report;
  assert.deepEqual([late.crawl.timeUp, late.crawl.read, late.crawl.notReadInTime], [true, 4, 6], 'out of time: the pages not read are said so, the rest is still checked');
  assert.equal((await Site.check(admin, { url: 'm.test', pages: 99 }, { fetchFn: mkFetch(SITE) })).report.crawl.asked, 10, 'more than 10 is 10'); assert.equal((await Site.check(admin, { url: 'm.test', pages: 'x' }, { fetchFn: mkFetch(SITE) })).report.crawl, undefined, 'not a number: the home page only'); assert.equal((await Site.check(admin, { url: 'm.test', pages: 3 }, { fetchFn: mkFetch(SITE) })).report.crawl.read, 3);
  const tiny = { 'https://t.test/': mk({ path: '/', title: 'A tiny site for a small clinic', h1: 'Tiny', body: `${BODY}<a href="/x">x</a>` }) }; // its only link is a page that does not open
  const small = (await Site.check(admin, { url: 't.test', pages: 5 }, { fetchFn: mkFetch(tiny) })).report; assert.deepEqual([small.crawl.read, small.crawl.failed.length], [1, 1]); assert.ok(small.actions.every((a) => !/of 1 pages/.test(a.gap)), 'one page read: the words are those of a one-page check');
  const R = { 'https://r.test/': mk({ path: '/', title: 'Redirect test site for a clinic', h1: 'R', body: `${BODY}<a href="/about">a</a> <a href="/about-us">b</a> <a href="/leave">c</a>` }), 'https://r.test/about': mk({ path: '/about', title: 'About the redirect test clinic', h1: 'About' }), 'https://r.test/leave': '<html></html>' };
  const rf = mkFetch(R); const redirect = async (u, i) => { const x = await rf(u === 'https://r.test/about-us' ? 'https://r.test/about' : u, i); if (u === 'https://r.test/about-us') return { ...x, url: 'https://r.test/about' }; if (u === 'https://r.test/leave') return { ...x, url: 'https://elsewhere.test/' }; return x; };
  const rd = (await Site.check(admin, { url: 'r.test', pages: 5 }, { fetchFn: redirect })).report; assert.deepEqual(rd.pages.map((p) => p.path), ['/', '/about'], 'two addresses that end on the same page are one page'); assert.deepEqual(rd.crawl.failed.map((x) => [x.path, /another website/.test(x.reason)]), [['/leave', true]]); assert.ok(!rd.cross.some((c) => c.key === 'pageError'), 'a page that leaves the site is not called a broken page');
  assert.ok((await Site.check(admin, { url: '', pages: 5 })).error && (await Site.check(admin, { url: 'http://127.0.0.1/', pages: 5 })).error && (await Site.check(admin, { url: 'http://169.254.169.254/', pages: 5 })).error && (await Site.check(admin, { url: 'https://gone.test/', pages: 5 }, { fetchFn: mkFetch({}) })).error, 'wrong input, private addresses and a website that does not answer are errors, as for one page');
  console.log('PASS limits: the time budget is honest, 10 at most, a tiny site and a failing link, redirects to the same page / to another website, private addresses refused');

  // 4. saved and shown again
  const sv1 = await Site.check(admin, { url: 'm.test', save: true, clientName: 'Crawl Test Co' }, { fetchFn: f }); assert.ok(sv1.id);
  await new Promise((res) => setTimeout(res, 5)); // the newest saved check is the one the monthly report shows
  const sv = await Site.check(admin, { url: 'm.test', pages: 10, save: true, clientName: 'Crawl Test Co' }, { fetchFn: f }); assert.ok(sv.id, JSON.stringify(sv).slice(0, 200));
  const ls = await Site.list(admin, { clientName: 'crawl test co' }); assert.deepEqual(ls.items.map((x) => x.pages).sort(), [1, 8], 'the list says how many pages each check read');
  const back = await Site.get(admin, sv.id); assert.equal(back.report.crawl.read, 8); assert.equal(back.report.pages.length, 8); assert.equal(back.report.score, 97);
  const Rep = require('../src/marketing/monthlyReport'); const CS = require('../src/marketing/clientServices');
  const plan = (await CS.createPlan(admin, { clientName: 'Crawl Test Co', plan: 'basic', months: 3, startDate: '2026-11-01' })).plan; const rpt = await Rep.build(admin, plan.id, '2026-11');
  assert.ok(/WEBSITE CHECK \(WHAT IS ON 8 PAGES\)/.test(rpt.report.text) && rpt.report.text.includes("Score 97/100. TeamLink's own check of 8 pages of the website.") && /what is on 8 pages/i.test(rpt.report.html), 'the monthly report says the check covered 8 pages');
  console.log('PASS saved: pages kept with the check and listed per client, shown again in full');

  console.log('website check (several pages) tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
