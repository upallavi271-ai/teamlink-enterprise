// AI Marketing > Client plans > Monthly report > "Compared with last month" (marketing/monthCompare.js, used by monthlyReport.js).
//   node backend/test-fixtures/mkMonthCompare.test.js     (throw-away copy of prisma/sandbox.db; the internet is a stand-in; nothing real is touched, nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mom-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; delete process.env.ALLOW_PRIVATE_FETCH;
const M = '../src/marketing/';
const Cmp = require(`${M}monthCompare`); const Rep = require(`${M}monthlyReport`); const CS = require(`${M}clientServices`); const Site = require(`${M}siteCheck`); const S = require('../src/outreach/store');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const ist = (s) => Date.parse(`${s}+05:30`);
const mkFetch = (pages) => async (url) => { const hit = pages[url]; return { status: hit === undefined ? 404 : 200, url, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => (typeof hit === 'string' ? hit : '') }; };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet

  // 1. the small pure parts
  assert.deepEqual(['2026-11', '2027-01', '2026-03'].map(Cmp.prevMonthOf), ['2026-10', '2026-12', '2026-02']);
  let j = Cmp.judge('postsPublished', 10, 12); assert.deepEqual([j.delta, j.pct, j.direction, j.better, j.words, j.short], [2, 20, 'up', 'better', 'up 2 (20%)', '+2 (+20%)']);
  j = Cmp.judge('calls', 20, 15); assert.deepEqual([j.delta, j.pct, j.direction, j.better, j.words, j.short], [-5, 25, 'down', 'worse', 'down 5 (25%)', '−5 (−25%)']);
  j = Cmp.judge('rating', 4, 4.2); assert.deepEqual([j.delta, j.pct, j.better, j.words, j.short], [0.2, null, 'better', 'up 0.2', '+0.2'], 'a rating has no per cent');
  j = Cmp.judge('rating', 4.5, 4.1); assert.deepEqual([j.delta, j.better, j.short], [-0.4, 'worse', '−0.4']);
  j = Cmp.judge('ctr', 3, 3.75); assert.deepEqual([j.delta, j.pct, j.words, j.short], [0.75, null, 'up 0.75 percentage points', '+0.75 pp']);
  j = Cmp.judge('position', 9.6, 8.2); assert.deepEqual([j.delta, j.direction, j.better, j.words, j.short], [-1.4, 'down', 'better', 'better by 1.4 places', '−1.4 (better)'], 'a LOWER average position is better');
  j = Cmp.judge('position', 8, 9); assert.deepEqual([j.better, j.words], ['worse', 'worse by 1 place']);
  j = Cmp.judge('reach', 0, 5); assert.deepEqual([j.pct, j.words, j.short], [null, 'up 5', '+5'], 'from zero there is no per cent');
  j = Cmp.judge('reach', 7, 7); assert.deepEqual([j.better, j.words, j.short], ['same', 'no change', 'No change']);
  j = Cmp.judge('reach', 1000, 2500); assert.equal(j.words, 'up 1,500 (150%)');
  console.log('PASS the parts: up / down in words and in short form, per cent only where it means something, a lower search position is better, zero and no change');

  // 2. a client with two months of numbers
  const plan = (await CS.createPlan(admin, { clientName: 'MoM Test Co', plan: 'growth', months: 6, startDate: '2026-10-01', industry: 'Software company' })).plan;
  const seo = (clicks, impressions, ctr, position) => ({ clicks, impressions, ctr, position, rows: [{ label: 'a query', clicks, impressions, ctr, position }], source: 'Google Search Console CSV' });
  assert.ok((await Rep.save(admin, plan.id, { month: '2026-10', metrics: { social: { postsPublished: 10, reach: 1000, followersGained: 20 }, gbp: { calls: 20, rating: 4 }, business: { leads: 5, enquiries: 8 }, seo: seo(90, 3000, 3, 9.6) } })).report);
  assert.ok((await Rep.save(admin, plan.id, { month: '2026-11', metrics: { social: { postsPublished: 12, followersGained: 20 }, gbp: { calls: 15, rating: 4.2 }, business: { leads: 5 }, seo: seo(120, 3200, 3.75, 8.2) } })).report);
  await CS.setDelivery(admin, plan.id, { month: '2026-10', item: 'posts', count: 6 }); await CS.setDelivery(admin, plan.id, { month: '2026-11', item: 'posts', count: 8 });
  const nov = await Rep.build(admin, plan.id, '2026-11'); const c = nov.comparison;
  assert.deepEqual([c.hasPrev, c.metricsSaved, c.prevMonth, c.prevWords, c.nowWords], [true, true, '2026-10', 'October 2026', 'November 2026']);
  assert.deepEqual(c.rows.map((r) => [r.key, r.beforeText, r.nowText, r.short, r.better]), [
    ['postsPublished', '10', '12', '+2 (+20%)', 'better'], ['followersGained', '20', '20', 'No change', 'same'], ['calls', '20', '15', '−5 (−25%)', 'worse'], ['rating', '4 / 5', '4.2 / 5', '+0.2', 'better'], ['leads', '5', '5', 'No change', 'same'],
    ['clicks', '90', '120', '+30 (+33%)', 'better'], ['impressions', '3,000', '3,200', '+200 (+7%)', 'better'], ['ctr', '3%', '3.75%', '+0.75 pp', 'better'], ['position', '9.6', '8.2', '−1.4 (better)', 'better']], 'only numbers given for both months, in the report\'s order');
  assert.deepEqual(c.missing.map((m) => [m.label, m.why]), [['Reach', 'not provided for November 2026'], ['Enquiries received', 'not provided for November 2026']], 'a number missing in one month is listed, never turned into zero');
  assert.deepEqual([c.delivery.total.before.pct, c.delivery.total.now.pct, c.delivery.total.delta], [19, 25, 6], '6 of 32 items, then 8 of 32'); const dp = c.delivery.rows.find((r) => r.item === 'posts'); assert.deepEqual([dp.before, dp.now, dp.delta, dp.quota], [6, 8, 2, 12]);
  assert.deepEqual(c.worse.map((r) => r.key), ['calls']);
  console.log('PASS two months: the change in every number given for both, missing numbers listed, delivery against the plan in both months');

  // 3. the audit and website check scores at the end of each month (the newest saved up to then)
  const a1 = { nameReal: 'yes' }; const a2 = { nameReal: 'yes', catMain: 'yes', address: 'yes' };
  const x1 = (await CS.saveAudit(admin, { clientName: 'MoM Test Co', planId: plan.id, answers: a1 })).audit; const x2 = (await CS.saveAudit(admin, { clientName: 'MoM Test Co', planId: plan.id, answers: a2 })).audit;
  await S.run('UPDATE "OmniMkGbpAudit" SET createdAt = ? WHERE id = ?', ist('2026-10-15T10:00:00'), x1.id); await S.run('UPDATE "OmniMkGbpAudit" SET createdAt = ? WHERE id = ?', ist('2026-11-20T10:00:00'), x2.id);
  const bare = '<html><body><h1>Bare</h1><p>Hello</p></body></html>'; const good = '<html lang="en"><head><title>MoM Test Co: software for small business</title><meta name="description" content="MoM Test Co builds software for small businesses in Pune: apps, websites and support. Call us to plan your project today."><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://mom.test/"></head><body><h1>MoM Test Co</h1><p>Hello</p><a href="/about">About</a></body></html>';
  const s1 = await Site.check(admin, { url: 'mom.test', save: true, clientName: 'MoM Test Co' }, { fetchFn: mkFetch({ 'https://mom.test/': bare }) }); const s2 = await Site.check(admin, { url: 'mom.test', pages: 3, save: true, clientName: 'MoM Test Co' }, { fetchFn: mkFetch({ 'https://mom.test/': good, 'https://mom.test/about': good.replace('<h1>MoM Test Co', '<h1>About').replace('canonical" href="https://mom.test/', 'canonical" href="https://mom.test/about') }) });
  assert.ok(s1.id && s2.id); await S.run('UPDATE "OmniMkSiteCheck" SET createdAt = ? WHERE id = ?', ist('2026-10-12T10:00:00'), s1.id); await S.run('UPDATE "OmniMkSiteCheck" SET createdAt = ? WHERE id = ?', ist('2026-11-18T10:00:00'), s2.id);
  const withScores = (await Rep.build(admin, plan.id, '2026-11')).comparison; const au = withScores.scores.find((s) => s.key === 'audit'); const st = withScores.scores.find((s) => s.key === 'site');
  assert.deepEqual([au.before, au.now, au.delta, au.better], [CS.scoreGbp(a1).score, CS.scoreGbp(a2).score, CS.scoreGbp(a2).score - CS.scoreGbp(a1).score, 'better']); assert.ok(au.nowWhen > au.beforeWhen);
  assert.deepEqual([st.before, st.now, st.better], [s1.report.score, s2.report.score, 'better']); assert.ok(withScores.notes.some((n) => /covered a different number of pages \(1 and 2\), so their scores are not directly comparable/.test(n)), 'a check of one page and a check of two pages are not directly comparable');
  const dec = (await Rep.build(admin, plan.id, '2026-12')).comparison; assert.ok(dec.hasPrev && dec.rows.length === 0 && dec.missing.length > 5 && dec.scores.length === 0, 'December with no numbers saved: everything given for November is "not compared"'); assert.ok(dec.notes.some((n) => /Google profile audit score.*no new check was saved in this month/.test(n)) && dec.notes.some((n) => /Website check score.*no new check was saved in this month/.test(n)), 'no new check in December: said, not compared');
  const oct = (await Rep.build(admin, plan.id, '2026-10')).comparison; assert.equal(oct.hasPrev, false, 'a plan that began in October has nothing before October'); assert.deepEqual(oct.rows, []);
  console.log('PASS scores: the newest audit and website check saved by the end of each month side by side, a check of a different number of pages marked not comparable, a month without a new check says so, a first month has nothing to compare');

  // 4. the report itself (text, page, improvement plan)
  const rpt = nov.report; assert.ok(/COMPARED WITH OCTOBER 2026/.test(rpt.text) && /- Calls: 20 in October 2026, 15 in November 2026 \(down 5 \(25%\)\)\./.test(rpt.text) && /- Average search position: 9\.6 in October 2026, 8\.2 in November 2026 \(better by 1\.4 places\)\./.test(rpt.text), rpt.text.slice(rpt.text.indexOf('COMPARED'), rpt.text.indexOf('COMPARED') + 500));
  assert.ok(/Not compared, because a number is missing in one of the two months: Reach \(not provided for November 2026\); Enquiries received \(not provided for November 2026\)\./.test(rpt.text) && /Delivered against the plan: 19% in October 2026, 25% in November 2026\./.test(rpt.text));
  assert.ok(/<h2>Compared with October 2026<\/h2>/.test(rpt.html) && /<th>October 2026<\/th><th>November 2026<\/th><th>Change<\/th>/.test(rpt.html) && /color:#15803d;font-weight:700">\+2 \(\+20%\)/.test(rpt.html) && /color:#b91c1c;font-weight:700">−5 \(−25%\)/.test(rpt.html), 'the page shows a rise in green and a fall in red');
  assert.ok(/not a promise about next month/.test(rpt.html)); assert.ok(rpt.improve.some((x) => /^Calls went down from 20 in October 2026 to 15\. Find out why before next month/.test(x)) && rpt.improve.filter((x) => /went down/.test(x)).length === 1, 'a fall is asked about in the improvement plan');
  const full = (await Rep.build(admin, plan.id, '2026-11')).report.html; const at = (s) => full.indexOf(s); assert.ok(at('Business results') > 0 && at('Compared with October 2026') > at('Business results') && at('Google Business Profile quality audit') > at('Compared with October 2026') && at('Website check (') > at('Google Business Profile quality audit'), 'after the numbers, before the scores');
  console.log('PASS the report: a section in the text and the page, rises in green and falls in red, missing numbers named, a fall asked about in the improvement plan');

  // 5. nothing saved last month, and a first month
  const np = (await CS.createPlan(admin, { clientName: 'MoM NoPrev Co', plan: 'basic', months: 3, startDate: '2026-10-10', industry: 'Cafe' })).plan; await Rep.save(admin, np.id, { month: '2026-11', metrics: { social: { postsPublished: 4 } } });
  const nb = await Rep.build(admin, np.id, '2026-11'); assert.deepEqual([nb.comparison.hasPrev, nb.comparison.metricsSaved, nb.comparison.rows.length], [true, false, 0]);
  assert.ok(nb.comparison.notes.some((n) => /No numbers were saved for October 2026.*Choose October 2026 in "Month shown", open Monthly report and save its numbers/.test(n)) && nb.comparison.notes.some((n) => /started on 2026-10-10, so October 2026 was a part month/.test(n)), 'it says what to do and that October was a part month'); assert.ok(/Delivered against the plan: 0% in October 2026/.test(nb.report.text));
  const fp = (await CS.createPlan(admin, { clientName: 'MoM First Co', plan: 'basic', months: 3, startDate: '2026-11-01', industry: 'Cafe' })).plan; const fb = await Rep.build(admin, fp.id, '2026-11');
  assert.deepEqual([fb.comparison.hasPrev, fb.comparison.notes.length], [false, 1]); assert.ok(!/COMPARED WITH/.test(fb.report.text) && !/Compared with/.test(fb.report.html), 'a first month has no section');
  assert.ok(!fb.report.improve.some((x) => /went down/.test(x)));
  assert.ok((await Rep.build(admin, 'nope', '2026-11')).error, 'an unknown plan is still an error');
  console.log('PASS edge cases: no numbers saved last month (what to do, part month), a first month has no section, an unknown plan is an error');

  console.log('month-on-month tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
