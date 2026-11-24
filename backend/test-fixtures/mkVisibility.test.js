// AI Marketing > SEO & visibility (marketing/siteCheck.js, geoTools.js, industryPacks.js, contentGuard.js, reviewReply.js, openverse.js, monthlyReport.js): the services of the document, built with plain code.
//   node backend/test-fixtures/mkVisibility.test.js     (throw-away copy of prisma/sandbox.db; the internet is a stand-in: nothing real is called, nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-vis-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; delete process.env.ALLOW_PRIVATE_FETCH;
const M = '../src/marketing/';
const Site = require(`${M}siteCheck`); const Geo = require(`${M}geoTools`); const Packs = require(`${M}industryPacks`); const Guard = require(`${M}contentGuard`); const Rev = require(`${M}reviewReply`); const Ov = require(`${M}openverse`); const Rep = require(`${M}monthlyReport`); const CS = require(`${M}clientServices`);
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };

const GOOD = `<!doctype html><html lang="en"><head><title>Test Hospital in Hyderabad: departments and appointments</title><meta name="description" content="Test Hospital in Hyderabad offers cardiology, neurology and emergency care. See departments, doctors and how to book an appointment.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://good.test/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Hospital","name":"Test Hospital","telephone":"+91 98765 43210","url":"https://good.test/","address":{"@type":"PostalAddress","streetAddress":"1 Test Road","postalCode":"500001"},"sameAs":["https://facebook.com/testhospital"]},{"@type":"FAQPage","mainEntity":[]}]}</script></head>
<body><h1>Test Hospital</h1><p>We are a hospital at 1 Test Road, Hyderabad 500001. Call +91 98765 43210.</p><h2>What services does Test Hospital provide?</h2><p>Cardiology, neurology and emergency care.</p><ul><li>Cardiology</li><li>Neurology</li></ul>
<h2>How do I book an appointment?</h2><p>Call us or use the form.</p><h2>Frequently asked questions</h2><h3>Is parking available?</h3><p>Yes.</p><img src="a.jpg" alt="Main entrance"><a href="/about">About us</a> <a href="/contact">Contact</a> <a href="https://facebook.com/testhospital">Facebook</a></body></html>`;
const BAD = '<html><body><p>Hello</p></body></html>';
const LINKS = `${GOOD.replace('</body>', '<a href="/gone">old</a><a href="/gone2">old2</a><a href="/gone3">old3</a></body>')}`;
const ok = { robotsOk: true, sitemapOk: true, https: true, broken: { checked: 0, bad: 0 }, ms: 300 };
const mkFetch = (pages) => async (url) => { const hit = pages[url]; const status = hit === undefined ? 404 : typeof hit === 'number' ? hit : 200; const body = typeof hit === 'string' ? hit : ''; return { status, url, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? (String(url).endsWith('.xml') || String(url).endsWith('.txt') ? 'text/plain' : 'text/html') : null) }, text: async () => body }; };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet

  // 1. the page reader and the 100 marks
  assert.equal(Site.CHECKS.reduce((s, c) => s + c[2], 0), 100); for (const [a, n] of [['SEO', 50], ['AEO', 25], ['GEO', 25]]) assert.equal(Site.CHECKS.filter((c) => c[1] === a).reduce((s, c) => s + c[2], 0), n, a);
  let f = Site.scanHtml(GOOD, 'https://good.test/'); let r = Site.analyze(f, ok);
  assert.equal(r.score, 100, JSON.stringify(r.actions)); assert.equal(f.h1.length, 1); assert.ok(f.schemaTypes.includes('Hospital') && f.schemaTypes.includes('FAQPage')); assert.equal(f.questionHeadings, 3); assert.ok(f.faqHeading && f.phone && f.address && f.sameAs && f.aboutContact);
  f = Site.scanHtml(BAD, 'https://bad.test/'); r = Site.analyze(f, { ...ok, robotsOk: false, sitemapOk: false });
  assert.equal(r.score, 19, 'a bare page keeps only what it cannot fail'); assert.equal(r.actions[0].key, 'faqSchema'); assert.ok(r.actions.every((a) => a.fix && a.gap)); assert.ok(/not measure rankings/.test(r.disclaimer) && /does not guarantee/.test(r.disclaimer));
  r = Site.analyze(Site.scanHtml(GOOD.replace('<h1>Test Hospital</h1>', '<h1>A</h1><h1>B</h1>').replace(' alt="Main entrance"', ''), 'x'), ok); assert.ok(r.actions.some((a) => a.key === 'h1' && /partly/.test(a.gap)) && r.actions.some((a) => a.key === 'altText'), 'two H1 = partly; a picture without alt text is found');
  r = Site.analyze(Site.scanHtml(GOOD.replace('"@type":"FAQPage"', '"@type":"Thing"'), 'x'), { ...ok, ms: 5000 }); assert.ok(r.actions.some((a) => a.key === 'faqSchema') && r.actions.some((a) => a.key === 'speed'));
  r = Site.analyze(Site.scanHtml('<html><head><meta name="robots" content="noindex"></head></html>', 'x'), ok); assert.ok(r.actions.some((a) => a.key === 'indexable'));
  console.log('PASS website check: 50 + 25 + 25 marks, a full page scores 100, a bare page 19, the findings (H1, alt text, schema, noindex, speed)');

  // 2. the whole check with a stand-in for the internet; the guard for private addresses and wrong input
  const pages = { 'https://good.test/': GOOD, 'https://good.test/robots.txt': 'User-agent: *\nSitemap: https://good.test/sitemap.xml', 'https://good.test/sitemap.xml': '<urlset></urlset>', 'https://good.test/about': 'x', 'https://good.test/contact': 'x', 'https://links.test/': LINKS.replace(/good\.test/g, 'links.test'), 'https://links.test/about': 'x', 'https://links.test/contact': 'x' };
  let run = await Site.runCheck('good.test', { fetchFn: mkFetch(pages) }); assert.ok(run.report, JSON.stringify(run)); assert.equal(run.report.score, 100); assert.equal(run.report.url, 'https://good.test/'); assert.equal(run.report.sitemapOk, true); assert.equal(run.report.links.checked, 2);
  run = await Site.runCheck('https://links.test/', { fetchFn: mkFetch({ ...pages }) }); assert.equal(run.report.links.bad, 3); assert.ok(run.report.actions.some((a) => a.key === 'brokenLinks' && /^Broken links on the page$/.test(a.gap)), '3 broken links = none of the marks');
  assert.ok((await Site.runCheck('https://gone.test/', { fetchFn: mkFetch({}) })).error, 'a site that answers 404 is an error, not a score');
  assert.ok((await Site.runCheck('http://localhost:3000/')).error && (await Site.runCheck('http://127.0.0.1/')).error && (await Site.runCheck('http://169.254.169.254/latest/meta-data/')).error, 'private addresses are refused by the shared guard');
  assert.ok((await Site.runCheck('ftp://x.test/')).error && (await Site.runCheck('')).error && (await Site.runCheck('https://user:pw@x.test/')).error && (await Site.runCheck('not a url at all')).error, 'wrong input refused');
  assert.equal(Site.cleanUrl('example.com').url, 'https://example.com/');
  const sv = await Site.check(admin, { url: 'good.test', save: true, clientName: 'Vis Test Hospital' }, { fetchFn: mkFetch(pages) }); assert.ok(sv.id && sv.report.score === 100);
  assert.ok((await Site.check(admin, { url: 'good.test', save: true }, { fetchFn: mkFetch(pages) })).error, 'saving needs a client name');
  const ls = await Site.list(admin, { clientName: 'vis test hospital' }); assert.equal(ls.items.length, 1); assert.equal((await Site.get(admin, sv.id)).report.score, 100); assert.ok((await Site.get(admin, 'nope')).error);
  console.log('PASS the check end to end: sitemap and links read, a broken-link page loses its marks, errors are errors, localhost / 127.0.0.1 / metadata refused, saved per client');

  // 3. schema, FAQ, description, address matching
  let g = Geo.businessSchema({ industry: 'hospital', name: 'Test Hospital', website: 'https://good.test', phone: '+91 98765 43210', street: '1 Test Road', city: 'Hyderabad', state: 'Telangana', pin: '500001', hours: 'Mon-Sat 9:00-18:00; Sun closed', services: 'Cardiology, Neurology', specialty: 'Multispeciality', social: 'https://facebook.com/x https://instagram.com/x' });
  assert.equal(g.schema['@type'], 'Hospital'); assert.equal(g.schema.address.postalCode, '500001'); assert.deepEqual(g.schema.openingHoursSpecification[0].dayOfWeek, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']); assert.deepEqual([g.schema.openingHoursSpecification[0].opens, g.schema.openingHoursSpecification[0].closes], ['09:00', '18:00']);
  assert.equal(g.schema.sameAs.length, 2); assert.equal(g.schema.medicalSpecialty, 'Multispeciality'); assert.ok(g.script.startsWith('<script type="application/ld+json">')); assert.doesNotThrow(() => JSON.parse(g.json)); assert.deepEqual(g.missing, []);
  g = Geo.businessSchema({ industry: 'it', name: 'Soft Co', hours: 'Mon-Fri 9am-5pm; whenever we feel like it' }); assert.equal(g.schema['@type'], 'ProfessionalService'); assert.deepEqual([g.schema.openingHoursSpecification[0].opens, g.schema.openingHoursSpecification[0].closes], ['09:00', '17:00']); assert.deepEqual(g.unreadHours, ['whenever we feel like it']); assert.ok(!('telephone' in g.schema) && !('address' in g.schema), 'an empty fact is left out, never guessed'); assert.ok(g.missing.includes('phone') && g.missing.includes('address'));
  assert.ok(Geo.businessSchema({ industry: 'it' }).error);
  let fq = Geo.faqSchema([{ question: 'Where is it?', answer: '<b>At 1 Test Road.</b>' }, { question: 'No answer yet?', answer: '' }, { question: '', answer: 'orphan' }]); assert.equal(fq.count, 1); assert.deepEqual(fq.skipped, ['No answer yet?']); assert.equal(fq.schema.mainEntity[0].acceptedAnswer.text, 'At 1 Test Road.'); assert.ok(Geo.faqSchema([]).error);
  const d = Geo.describe({ industry: 'hospital', name: 'Test Hospital', city: 'Hyderabad', state: 'Telangana', services: 'Cardiology, Neurology, Emergency care', hours: 'Mon-Sat 9-6', since: 1998, phone: '9876543210', street: '1 Test Road', pin: '500001' });
  assert.ok(d.description.startsWith('Test Hospital is a hospital in Hyderabad, Telangana.') && /Cardiology, Neurology and Emergency care/.test(d.description) && /since 1998/.test(d.description)); assert.ok(!/Phone:/.test(d.gbp) && d.gbpLength <= 750 && !/https?:/.test(d.gbp));
  const long = Geo.describe({ industry: 'other', name: 'X', services: Array.from({ length: 40 }, (_, i) => `service number ${i}`).join(','), hours: 'h'.repeat(190), street: 's'.repeat(190) }); assert.ok(long.gbpLength <= 750);
  let nap = Geo.napCheck([{ place: 'Website', name: 'Test Hospital', address: '1 Test Rd, Hyderabad', phone: '+91 98765 43210' }, { place: 'Google', name: 'Test Hospital', address: '1 Test Road Hyderabad', phone: '9876543210' }]); assert.equal(nap.consistent, true, JSON.stringify(nap.issues));
  nap = Geo.napCheck([{ place: 'Website', name: 'Test Hospital', address: '1 Test Road', phone: '9876543210' }, { place: 'Justdial', name: 'Test Hospitals Pvt', address: '2 Other Road', phone: '9000000000' }]); assert.deepEqual(nap.issues.map((x) => x.field), ['name', 'address', 'phone']); assert.ok(Geo.napCheck([{ place: 'a', name: 'x' }]).error);
  console.log('PASS schema and text tools: hospital / IT schema from real facts only, opening hours read (and the unreadable one listed), FAQ schema without empty answers, a 750-character profile text with no links, address matching');

  // 4. industry packs
  let p = Packs.buildPack('hospital', { name: 'Test Hospital', city: 'Hyderabad', address: '1 Test Road', phone: '9876543210', hours: 'Mon-Sat 9-6', services: 'Cardiology, Neurology', specialty: 'Cardiology' });
  assert.equal(p.healthcare, true); assert.equal(p.schemaType, 'Hospital'); assert.equal(p.posts.length, 30); assert.ok(p.faq.length >= 12);
  const byQ = (q) => p.faq.find((x) => x.question.includes(q)); assert.deepEqual([byQ('Where is').ready, byQ('Where is').answer], [true, 'Test Hospital is at 1 Test Road.']); assert.equal(byQ('opening hours').answer, 'Test Hospital is open Mon-Sat 9-6.'); assert.equal(byQ('What documents are required').answer, '', 'an answer the client must write stays empty'); assert.equal(byQ('What documents are required').askClient, true);
  assert.ok(p.keywords.includes('Cardiology hospital in Hyderabad') && p.keywords.every((k) => !/[{}]/.test(k))); assert.ok(p.rules.some((x) => /medical reviewer/i.test(x)));
  p = Packs.buildPack('other', {}); assert.equal(p.faq[0].ready, false); assert.ok(p.faq[0].needs.length >= 1); assert.equal(p.healthcare, false); assert.ok(Packs.buildPack('moon', {}).error);
  assert.deepEqual(Packs.INDUSTRIES.map((x) => x.key), ['doctor', 'clinic', 'hospital', 'it', 'manufacturing', 'education', 'other']); assert.deepEqual(Packs.INDUSTRIES.filter((x) => x.healthcare).map((x) => x.key), ['doctor', 'clinic', 'hospital']);
  console.log('PASS industry packs: 7 kinds, 30 post ideas, FAQ answered only from the facts given, search phrases without gaps, healthcare rules');

  // 5. the wording check and the medical reviewer's sign-off
  const lv = (t, o) => Guard.check(t, o); const ids = (c) => c.findings.map((x) => x.id);
  let c = lv('We guarantee first page of Google in 30 days'); assert.equal(c.level, 'stop'); assert.ok(ids(c).includes('rank-promise') && ids(c).includes('guarantee'));
  c = lv('We give no guarantee of results, and we never promise a ranking.'); assert.ok(!ids(c).includes('guarantee'), 'a sentence that says there is NO guarantee is fine'); assert.equal(c.verdict, 'No problems found by this checklist');
  c = lv('100% satisfaction, the best agency in India'); assert.equal(c.level, 'review'); assert.ok(ids(c).includes('hundred') && ids(c).includes('superlative'));
  c = lv('Our hospital cures diabetes permanently', { industry: 'hospital' }); assert.equal(c.level, 'stop'); assert.ok(ids(c).includes('cure-serious')); assert.equal(c.needsSignoff, true);
  c = lv('Our software cures your diabetes', { industry: 'it' }); assert.ok(!ids(c).includes('cure-serious'), 'health rules are only for healthcare clients');
  c = lv('Painless, risk-free and no side effects', { industry: 'clinic' }); assert.equal(c.level, 'stop'); assert.ok(ids(c).includes('miracle'));
  c = lv('Patient Ramesh was happy with your surgery. You visited us last week.', { industry: 'doctor' }); assert.ok(['patient-name', 'your-treatment', 'visit'].every((x) => ids(c).includes(x)), ids(c).join());
  c = lv('Free consultation camp, before and after photos and patient testimonials, endorsed by a celebrity', { industry: 'clinic' }); assert.deepEqual(['inducement', 'before-after', 'testimonial', 'endorsement'].filter((x) => !ids(c).includes(x)), []); assert.equal(c.level, 'review');
  c = lv('Thank you for your feedback. Please call us on 9876543210.', { industry: 'hospital' }); assert.equal(c.level, 'ok'); assert.ok(Guard.check('').error);
  assert.ok((await Guard.signoff(admin, { text: 'Painless cure for cancer', reviewerName: 'Dr Test', clientName: 'Vis Test Hospital', industry: 'hospital' })).error, 'a sign-off is refused while the words still say "change it"');
  assert.ok((await Guard.signoff(admin, { text: 'Our departments are open Monday to Saturday.', reviewerName: '', clientName: 'Vis Test Hospital' })).error && (await Guard.signoff(admin, { text: '', reviewerName: 'Dr Test', clientName: 'X' })).error);
  const so = await Guard.signoff(admin, { text: 'Our departments are open Monday to Saturday.', reviewerName: 'Dr Test', reviewerRole: 'Medical reviewer', note: 'Read and agreed', clientName: 'Vis Test Hospital', industry: 'hospital' }); assert.ok(so.id && so.reviewerName === 'Dr Test');
  assert.equal((await Guard.signoffs(admin, { clientName: 'vis test hospital' })).items.length, 1); assert.equal((await Guard.signoffs(admin, { text: '  our departments are OPEN monday to saturday. ' })).items.length, 1, 'the same words (any spacing or capitals) find their sign-off'); assert.equal((await Guard.signoffs(admin, { text: 'Different words' })).items.length, 0);
  console.log('PASS wording check: ranking and guarantee promises, "no guarantee" allowed, superlatives, cure of serious conditions, no-risk claims, patient names and treatment talk, offers / before-after / testimonials / endorsements, sign-off recorded only when no "change it" is left');

  // 6. review replies
  let rv = Rev.draft({ rating: 5, text: 'Wonderful, helpful staff', reviewerName: 'Anita Rao', industry: 'hospital', contact: '9876543210' }); assert.equal(rv.band, 'positive'); assert.equal(rv.drafts.length, 3); assert.ok(rv.drafts.every((x) => !/Dear/.test(x.text) && x.flags.length === 0), 'a hospital reply never uses the name and never trips the wording check'); assert.ok(rv.themes.includes('staff') && rv.notes.some((n) => /approval/.test(n)));
  rv = Rev.draft({ rating: 1, text: 'We waited 3 hours and the staff was rude. Call me on 9999999999', reviewerName: 'Ravi', industry: 'it', contact: '9876543210' }); assert.equal(rv.band, 'negative'); assert.deepEqual(rv.themes.slice(0, 2), ['wait', 'staff']); assert.ok(rv.drafts.every((x) => /9876543210/.test(x.text) && /^Dear Ravi, /.test(x.text) && !/9999999999/.test(x.text))); assert.ok(rv.notes.some((n) => /Do not argue/.test(n)) && rv.notes.some((n) => /do not repeat it/.test(n)));
  rv = Rev.draft({ rating: 2, text: 'bad', industry: 'clinic' }); assert.ok(rv.notes.some((n) => /how to reach us/.test(n))); rv = Rev.draft({ rating: 3, text: '', industry: 'other' }); assert.equal(rv.band, 'mixed'); assert.ok(Rev.draft({ rating: 9 }).error && Rev.draft({}).error);
  console.log('PASS review replies: three careful drafts per review, no name or treatment talk for healthcare, themes found, contact invited, phone number in the review not repeated, advice notes');

  // 7. Openverse (a stand-in answers)
  let called = 0; const seen = []; const api = async (url) => { called += 1; seen.push(url); return { status: 200, json: async () => ({ result_count: 2, page_count: 1, results: [{ id: 'a', title: 'Hospital corridor', creator: 'Jane', license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', url: 'https://img.test/y.jpg', thumbnail: 'https://img.test/t.jpg', foreign_landing_url: 'https://flickr.test/1', source: 'flickr', attribution: '"Hospital corridor" by Jane is licensed under CC BY 4.0.' }, { id: 'b', license: 'cc0', url: 'http://insecure.test/p.jpg', thumbnail: '' }] }) }; };
  let ov = await Ov.search('hospital corridor', { shape: 'wide' }, api); assert.equal(ov.items.length, 1, 'a result with no https picture is left out'); assert.deepEqual([ov.items[0].license, ov.items[0].needsCredit, ov.items[0].credit], ['CC BY 4.0', true, '"Hospital corridor" by Jane is licensed under CC BY 4.0.']);
  assert.ok(/license_type=commercial/.test(seen[0]) && /mature=false/.test(seen[0]) && /aspect_ratio=wide/.test(seen[0]) && /^https:\/\/api\.openverse\.org\/v1\/images\//.test(seen[0]));
  await Ov.search('hospital corridor', { shape: 'wide' }, api); assert.equal(called, 1, 'the same search is answered from memory');
  assert.ok((await Ov.search('a', {}, api)).error); assert.equal((await Ov.search('busy one', {}, async () => ({ status: 429 }))).status, 429); assert.ok((await Ov.search('down one', {}, async () => { throw new Error('x'); })).error);
  const nz = Ov.normalise({ id: 'z', license: 'cc0', title: 'T', url: 'https://i/z.jpg' }); assert.deepEqual([nz.license, nz.needsCredit], ['CC0 (public domain)', false]);
  console.log('PASS Openverse: commercial licences only, each photo with its licence and credit line, results without a safe picture left out, kept for 10 minutes, a busy or broken answer in words');

  // 8. the monthly report
  const csv = 'Top queries,Clicks,Impressions,CTR,Position\r\nbest hospital hyderabad,120,"4,000",3%,8.2\r\n"clinic, near me",30,1000,3%,12.5\r\n'; assert.deepEqual(Rep.parseCsv(csv)[2], ['clinic, near me', '30', '1000', '3%', '12.5']);
  const sc = Rep.parseSearchConsole(csv); assert.ok(sc.seo, JSON.stringify(sc)); assert.deepEqual([sc.seo.clicks, sc.seo.impressions, sc.seo.ctr, sc.seo.position, sc.seo.rows[1].label], [150, 5000, 3, 9.1, 'clinic, near me']); assert.ok(Rep.parseSearchConsole('a,b\n1,2').error && Rep.parseSearchConsole('x').error);
  const cm = Rep.cleanMetrics({ social: { postsPublished: '5', reach: '1,200', reelViews: 'lots' }, gbp: { rating: 9, calls: -3, profileViews: 40 }, junk: { a: 1 } }); assert.deepEqual(cm.social, { postsPublished: 5, reach: 1200 }); assert.deepEqual(cm.gbp, { profileViews: 40 }, 'a bad number, a negative one and a rating above 5 are dropped, never turned into zero');
  const plan = (await CS.createPlan(admin, { clientName: 'Vis Test Hospital', plan: 'growth', months: 6, startDate: '2026-11-01', industry: 'Hospital' })).plan; await CS.setDelivery(admin, plan.id, { month: '2026-11', item: 'posts', count: 9 });
  await CS.saveAudit(admin, { clientName: 'Vis Test Hospital', planId: plan.id, answers: { nameReal: 'yes', catMain: 'no', postRecent: 'no' } });
  let rpt = await Rep.build(admin, plan.id, '2026-11'); assert.ok(rpt.report, JSON.stringify(rpt)); assert.equal(rpt.saved, false); assert.ok(/Not provided/.test(rpt.report.html) && /9 of 12/.test(rpt.report.html) && /Google Business Profile quality audit/.test(rpt.report.html) && /not an official Google score/.test(rpt.report.html), 'no number was given, so nothing is invented');
  assert.ok(/guaranteed rankings or guaranteed leads/.test(rpt.report.html) && /Website check/.test(rpt.report.html), 'the promise line is there and the saved website check is included');
  const sv2 = await Rep.save(admin, plan.id, { month: '2026-11', metrics: { social: { postsPublished: 7, reach: 1500 }, gbp: { calls: 12, rating: 4.6 }, seo: sc.seo, business: { enquiries: 4 } }, notes: 'Great month <script>alert(1)</script>' });
  assert.equal(sv2.saved, true); assert.ok(sv2.report.html.includes('1,500') && sv2.report.html.includes('4.6 / 5') && sv2.report.html.includes('Search clicks') && sv2.report.html.includes('best hospital hyderabad')); assert.ok(!sv2.report.html.includes('<script>alert') && sv2.report.html.includes('&lt;script&gt;'), 'the team note is escaped');
  assert.ok(sv2.report.improve.some((x) => /still to deliver/.test(x)) && sv2.report.improve.some((x) => /Google profile/.test(x)) && !sv2.report.improve.some((x) => /^Website/.test(x)), 'the saved website check scored 100, so it adds nothing to the improvement plan'); assert.ok(/Search clicks: 150/.test(sv2.report.text));
  assert.ok((await Rep.save(admin, plan.id, { month: 'nov', metrics: {} })).error && (await Rep.build(admin, 'nope', '2026-11')).error);
  const again = await Rep.save(admin, plan.id, { month: '2026-11', metrics: { social: { postsPublished: 8 } } }); assert.ok(/Posts published<\/td><td class="">8</.test(again.report.html) && !again.report.html.includes('1,500') && !again.report.html.includes('Search clicks'), 'saving again replaces the numbers of that month'); assert.ok(/Not provided/.test(again.report.html));
  console.log('PASS monthly report: Search Console CSV read (quotes, thousands, weighted position), bad numbers dropped, "Not provided" instead of zeros, delivery + audit + website check + improvement plan, team note escaped, saved per month');

  console.log('visibility tests: all passed'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
