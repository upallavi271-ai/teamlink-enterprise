// AI Marketing > SEO & visibility > Blog planner (marketing/blogPlanner.js) and the SEO blogs counted on a client's plan (clientServices.js autoCounts).
//   node backend/test-fixtures/mkBlogPlanner.test.js     (throw-away copy of prisma/sandbox.db; the internet is a stand-in: nothing real is called, nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-blog-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; delete process.env.ALLOW_PRIVATE_FETCH;
const M = '../src/marketing/';
const Blog = require(`${M}blogPlanner`); const CS = require(`${M}clientServices`); const Rep = require(`${M}monthlyReport`); const Site = require(`${M}siteCheck`); const Guard = require(`${M}contentGuard`); const S = require('../src/outreach/store');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const mkFetch = (pages) => async (url) => { const hit = pages[url]; return { status: hit === undefined ? 404 : 200, url, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => (typeof hit === 'string' ? hit : '') }; };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet

  // 1. the topic shapes and the kind-of-business guess
  for (const [label, set] of [['business', Blog.BIZ], ['healthcare', Blog.HEALTH]]) {
    assert.equal(new Set(set.map((t) => t.key)).size, set.length, `${label}: unique keys`);
    for (const t of set) { assert.ok(t.outline.length >= 3 && t.faq.length >= 1 && t.needs.length >= 1 && t.schema.includes('Article') && t.meta && t.title && t.phrase && t.words, `${label}/${t.key}: a complete shape`); }
  }
  assert.ok(Blog.HEALTH.filter((t) => t.key !== 'book').every((t) => /doctor|approved|reviewed/i.test(`${t.title} ${t.outline.join(' ')} ${t.needs.join(' ')} ${t.meta}`)), 'every healthcare shape except the booking-and-timings one leaves the medical words to the doctor');
  assert.deepEqual(['Multi-speciality hospital', 'Dental clinic', 'Cardiologist (doctor)', 'Software company', 'Steel manufacturing unit', 'Junior college', '', 'Cafe'].map(Blog.guessIndustry), ['hospital', 'clinic', 'doctor', 'it', 'manufacturing', 'education', 'other', 'other']);
  console.log('PASS the shapes: complete, doctor-reviewed wording for healthcare, kind of business guessed from a plan\'s "kind of business"');

  // 2. a healthcare plan from the client's own facts
  const cp = (await CS.createPlan(admin, { clientName: 'Blog Test Hospital', plan: 'premium', months: 3, startDate: '2026-11-01', industry: 'Multi-speciality hospital' })).plan; assert.ok(cp);
  const facts = { planId: cp.id, month: '2026-11', name: 'Blog Test Hospital', city: 'Hyderabad', services: 'heart check-ups, ECG, cardiac rehab', specialty: 'cardiology', phone: '+91 98765 43210', website: 'https://bt.test', count: 4 };
  let r = await Blog.plan(admin, facts); assert.ok(r.plan, JSON.stringify(r)); let p = r.plan;
  assert.deepEqual([p.industry, p.healthcare, p.asked, p.made, p.clientName, p.month], ['hospital', true, 4, 4, 'Blog Test Hospital', '2026-11']); assert.equal((await Blog.plan(admin, { ...facts, count: undefined })).plan.asked, 4, 'the number of blogs defaults to the plan\'s quantity (Premium: 4)');
  assert.equal(new Set(p.briefs.map((b) => b.title.toLowerCase())).size, 4, 'four different titles'); assert.equal(new Set(p.briefs.map((b) => b.topicKey)).size, 4);
  assert.ok(new Set(p.briefs.map((b) => b.topicKey.split(':')[1])).size >= 3, 'the services take turns: not four posts about one service');
  for (const b of p.briefs) {
    assert.ok(b.metaTitle.length > 10 && b.metaTitle.length <= 60, `page title: ${b.metaTitle.length}`); assert.ok(b.metaDescription.length > 40 && b.metaDescription.length <= 155 && /[.!?]$/.test(b.metaDescription), `page description: ${b.metaDescription.length} ${b.metaDescription}`);
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug) && b.slug.length <= 60 && !/reviewed|approved/.test(b.slug), 'a short web address without the "(doctor reviewed)" tail'); assert.ok(b.outline.length >= 3 && b.faq.length >= 1 && b.needs.length >= 1 && b.links.length >= 2 && b.schema.includes('Article'));
    assert.ok(b.review && /doctor/i.test(b.review), 'healthcare: the doctor\'s review is named'); assert.deepEqual([b.status, b.publishedAt, b.url], ['idea', null, '']); assert.ok(b.text.startsWith(`Blog ${b.n} of 4: ${b.title}`) && b.text.includes(`Web address: /blog/${b.slug}`) && b.text.includes('Before publishing:') && b.text.includes('Facts the client must give'), 'the brief as plain text');
    const g = Guard.check(`${b.title}. ${b.outline.join('. ')}. ${b.faq.join(' ')} ${b.metaDescription}`, { industry: p.industry }); assert.equal(g.stops + g.reviews, 0, `the wording check finds nothing in "${b.title}": ${JSON.stringify(g.findings.map((f) => f.id))}`);
  }
  assert.ok(!/\{\w+\}|undefined|\bnull\b/.test(JSON.stringify(p.briefs).replace(/"publishedAt":null/g, '')), 'no placeholder or "undefined" is left in any brief'); assert.ok(p.briefs.every((b) => /^[A-Z]/.test(b.title)), 'titles start with a capital'); assert.deepEqual(p.briefs.map((b) => b.n), [1, 2, 3, 4]);
  assert.ok(p.briefs[0].links.includes('Blog 2 of this plan') && p.briefs[1].links.includes('Blog 1 of this plan') && p.briefs[1].links.includes('Blog 3 of this plan'), 'the posts of a plan link to each other');
  assert.ok(p.notes.some((n) => /doctor/.test(n)) && p.notes.some((n) => /cannot show how many people search/.test(n)) && /not know how many people search/.test(p.disclaimer) && /does not promise rankings/.test(p.disclaimer));
  console.log('PASS a healthcare plan: 4 briefs from the plan\'s quantity, the services in turn, titles, phrases, page title <= 60 and description <= 155, doctor review on each, nothing in it for the wording check to stop, no placeholder left');

  // 3. other businesses, a missing city, too few services, wrong input
  r = await Blog.plan(admin, { name: 'Pixel Works', industry: 'it', services: 'web apps', count: 12 }); p = r.plan;
  assert.deepEqual([p.healthcare, p.made, p.asked], [false, 9, 12], '9 shapes for one service'); assert.ok(p.notes.some((n) => /Only 9 different topics/.test(n)) && p.notes.some((n) => /No city was given/.test(n)));
  assert.ok(p.briefs.every((b) => b.review === '' && !/\bin\b\s*[?:.,]|in $/.test(b.title)) && !/\{\w+\}/.test(JSON.stringify(p.briefs)), 'no city: nothing like "in ?" is left'); assert.ok(p.briefs.every((b) => b.cta === 'Contact Pixel Works'), 'no phone: the ending says contact the business');
  assert.equal((await Blog.plan(admin, { name: 'Pixel Works', industry: 'it', services: 'web apps, mobile apps, cloud hosting', city: 'Pune', count: 12 })).plan.made, 12);
  assert.ok((await Blog.plan(admin, { name: '', services: 'x' })).error && (await Blog.plan(admin, { name: 'X Co' })).error && (await Blog.plan(admin, { name: 'X Co', services: 'a', planId: 'nope' })).error, 'a name and a service are needed; an unknown plan is refused');
  assert.equal((await Blog.plan(admin, { name: 'X Co', services: 'a', industry: 'banana' })).plan.industry, 'other'); assert.equal((await Blog.plan(admin, { name: 'X Co', services: 'a', count: 99 })).plan.asked, 12); assert.equal((await Blog.plan(admin, { name: 'X Co', services: 'a', count: 0 })).plan.asked, 4);
  assert.ok((await Blog.plan(admin, { name: 'X Co', services: 'a', save: true })).error, 'saving needs a client name');
  console.log('PASS other businesses: 9 shapes for one service and a note, no city = no local phrase and no gap in a title, the ending without a phone, input checked');

  // 4. real data: Search Console queries and the website check
  assert.ok((await Rep.save(admin, cp.id, { month: '2026-10', metrics: { seo: { clicks: 50, impressions: 900, ctr: 5.5, position: 8, rows: [
    { label: 'heart specialist near me', clicks: 3, impressions: 120, ctr: 2.5, position: 9.2 }, { label: 'ecg test cost hyderabad', clicks: 1, impressions: 80, ctr: 1.2, position: 14 }, { label: 'https://bt.test/page', clicks: 5, impressions: 400, ctr: 1.3, position: 6 },
    { label: 'blog test hospital', clicks: 30, impressions: 500, ctr: 6, position: 1.5 }, { label: 'far away query', clicks: 0, impressions: 900, ctr: 0, position: 45 }] } } })).report);
  p = (await Blog.plan(admin, facts)).plan; assert.deepEqual(p.sources, { searchConsole: 2, siteCheck: false });
  assert.deepEqual(p.briefs.slice(0, 2).map((b) => [b.source, b.phrase]), [['searchConsole', 'heart specialist near me'], ['searchConsole', 'ecg test cost hyderabad']], 'queries at position 4 to 20, the most seen first; a web address, the top result and a far-away query are left out');
  assert.ok(/position 9\.2, 120 impressions, 3 clicks/.test(p.briefs[0].why) && /not a guarantee/.test(p.briefs[0].why) && p.briefs[0].title === 'Heart specialist near me: a clear guide' && p.briefs[0].review, 'the real numbers, no promise, the doctor\'s review');
  const bare = '<html><body><h1>B</h1><p>Hello</p></body></html>'; const web = { 'https://bt.test/': bare };
  assert.ok((await Site.check(admin, { url: 'bt.test', save: true, clientName: 'Blog Test Hospital' }, { fetchFn: mkFetch(web) })).id);
  p = (await Blog.plan(admin, facts)).plan; assert.deepEqual(p.sources, { searchConsole: 2, siteCheck: true }); assert.equal(p.briefs[2].source, 'siteCheck'); assert.ok(/no FAQ/.test(p.briefs[2].why) && /frequently asked questions/i.test(p.briefs[2].title), 'the website check found no FAQ: the FAQ post comes next');
  const words = 'Our team looks after patients with care and keeps the waiting time short. '.repeat(25); const web2 = { 'https://bt2.test/': `<html lang="en"><head><title>B2</title></head><body><h1>B2</h1><p>${words}</p><a href="/about">About</a></body></html>`, 'https://bt2.test/about': '<html><body><h1>About</h1><p>Short.</p></body></html>' };
  assert.ok((await Site.check(admin, { url: 'bt2.test', pages: 5, save: true, clientName: 'Thin Site Co' }, { fetchFn: mkFetch(web2) })).id);
  p = (await Blog.plan(admin, { name: 'Thin Site Co', industry: 'it', services: 'web apps', city: 'Pune', count: 3 })).plan; assert.ok(p.briefs.some((b) => b.source === 'siteCheck' && /short pages/.test(b.why) && /^Web apps explained/.test(b.title)), 'the website check found short pages: a full guide comes next');
  console.log('PASS real data: Search Console queries at position 4 to 20 become topics with their real numbers and no promise, the website check\'s gaps (no FAQ, short pages) become the post that fixes them');

  // 5. saved plans, topics not given twice, the list
  r = await Blog.plan(admin, { ...facts, save: true }); assert.ok(r.id && r.plan.id === r.id, JSON.stringify(r).slice(0, 200)); const saved = r.plan; const keys1 = saved.briefs.map((b) => b.topicKey);
  const next = (await Blog.plan(admin, { ...facts, month: '2026-12' })).plan; assert.ok(next.briefs.length === 4 && next.briefs.every((b) => !keys1.includes(b.topicKey)), 'a topic already given to this client is not given again'); assert.ok(next.notes.some((n) => /not given again/.test(n)));
  const ls = await Blog.list(admin, { clientName: 'blog test hospital' }); assert.deepEqual(ls.items.map((x) => [x.month, x.count, x.published, x.writing]), [['2026-11', 4, 0, 0]]);
  const back = (await Blog.get(admin, saved.id)).plan; assert.deepEqual([back.briefs.length, back.clientName, back.healthcare, back.inputs.city, back.inputs.services.length, back.industryLabel], [4, 'Blog Test Hospital', true, 'Hyderabad', 3, 'Hospital']); assert.ok(back.notes.length && back.disclaimer && back.briefs[0].text);
  assert.ok((await Blog.get(admin, 'nope')).error);
  console.log('PASS saved: kept per client with its facts and notes, a topic is never given twice, listed with how many posts are written / published');

  // 6. moving a post along; the posts marked Published are the SEO blogs counted on the plan
  const set = (n, b) => Blog.setItem(admin, saved.id, n, b); const one = (x) => x.plan.briefs.find((b) => b.n === 1);
  let u = await set(1, { status: 'writing' }); assert.deepEqual([one(u).status, one(u).publishedAt], ['writing', null]);
  u = await set(1, { status: 'published', url: 'https://bt.test/blog/heart' }); assert.deepEqual([one(u).status, one(u).url, typeof one(u).publishedAt], ['published', 'https://bt.test/blog/heart', 'number']); const at = one(u).publishedAt;
  u = await set(1, { note: 'Dr Rao approved on the 24th', title: 'Heart check-ups: a clear guide for families' }); assert.deepEqual([one(u).note, one(u).title, one(u).publishedAt], ['Dr Rao approved on the 24th', 'Heart check-ups: a clear guide for families', at], 'a note and a better title do not change the time it was published');
  u = await set(2, { status: 'published' }); assert.equal((await Blog.list(admin, { clientName: 'Blog Test Hospital' })).items[0].published, 2);
  for (const [n, b] of [[1, { status: 'done' }], [1, { url: 'not a web address' }], [1, { url: 'ftp://x.test/a' }], [1, { title: '   ' }], [9, { status: 'idea' }], ['x', { status: 'idea' }]]) assert.ok((await set(n, b)).error, `refused: ${JSON.stringify(b)}`);
  assert.ok((await Blog.setItem(admin, 'nope', 1, { status: 'idea' })).error);
  const nowMonth = CS.istMonth(); let au = await CS.autoCounts('Blog Test Hospital', nowMonth);
  assert.equal(au.blogs, 2); assert.deepEqual(au.items.filter((x) => x.kind === 'blogs').map((x) => x.title).sort(), ['Heart check-ups: a clear guide for families', saved.briefs[1].title].sort(), 'the counted posts are listed by title');
  assert.equal((await CS.autoCounts('  BLOG test hospital ', nowMonth)).blogs, 2, 'the client name is matched without capitals or spaces'); assert.equal((await CS.autoCounts('Blog Test Hospital', '2020-01')).blogs, 0, 'a post counts in the month it was published');
  assert.equal((await CS.autoCounts('Some Other Client', nowMonth)).blogs, 0, 'another client\'s posts are not counted');
  let pl = (await CS.getPlan(admin, cp.id, nowMonth)).plan; const row = (k) => pl.progress.find((x) => x.item === k); assert.deepEqual([row('blogs').auto, row('blogs').manual, row('blogs').done, row('blogs').quota, row('blogs').counted], [2, 0, 2, 4, 'work'], 'the plan shows 2 of 4 SEO blogs by itself');
  pl = (await CS.setDelivery(admin, cp.id, { month: nowMonth, item: 'blogs', delta: 1 })).plan; assert.deepEqual([row('blogs').auto, row('blogs').manual, row('blogs').done], [2, 1, 3], 'the team adds blogs made elsewhere on top'); assert.ok((await CS.setDelivery(admin, cp.id, { month: nowMonth, item: 'blogs', delta: -2 })).error, 'the − button cannot take away a published post');
  assert.equal(pl.autoItems.filter((x) => x.kind === 'blogs').length, 2);
  u = await set(2, { status: 'idea' }); assert.deepEqual([u.plan.briefs.find((b) => b.n === 2).publishedAt, (await CS.autoCounts('Blog Test Hospital', nowMonth)).blogs], [null, 1], 'taking a post back to Idea stops counting it');
  console.log('PASS statuses + count: Idea / Being written / Published with the live address, a note and a better title kept, bad input refused, the posts marked Published are counted as the plan\'s SEO blogs (by month, by client), the team adds on top, never below the published ones');

  // 7. another department's plans are not shown
  const dp = (await Blog.plan(admin, { clientName: 'Sales Dept Co', name: 'Sales Dept Co', industry: 'it', services: 'crm setup', city: 'Pune', department: 'Sales', save: true })).plan; assert.ok(dp.id);
  const restricted = { id: 'u-restricted', name: 'Recruiter', role: 'RECRUITER', atsRole: 'RECRUITER', department: 'Recruitment' };
  assert.equal((await Blog.list(admin, { clientName: 'Sales Dept Co' })).items.length, 1); assert.equal((await Blog.list(restricted, { clientName: 'Sales Dept Co' })).items.length, 0); assert.ok((await Blog.get(restricted, dp.id)).error && (await Blog.setItem(restricted, dp.id, 1, { status: 'writing' })).error, 'another department\'s plan cannot be read or changed');
  assert.ok((await Blog.plan(restricted, { name: 'X', services: 'a', department: 'Sales', save: true, clientName: 'X' })).error, 'a plan cannot be saved into a department that is not yours');
  console.log('PASS departments: another department\'s plans are not listed, read or changed, and cannot be saved into');

  console.log('blog planner tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
