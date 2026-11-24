// AI Marketing > Client plans (marketing/clientServices.js): the three plans and offers of the services document, clients on a plan with delivery counters, and the 100-mark GBP Quality Audit.
//   node backend/test-fixtures/mkClientServices.test.js     (runs on a throw-away copy of prisma/sandbox.db; nothing real is touched, nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-plans-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
const CS = require('../src/marketing/clientServices');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet

  // 1. the price table of the document (rounded to the nearest rupee), for every plan and every offer
  const table = { basic: { 3: 11397, 6: 21595, 9: 30592, 12: 43989 }, growth: { 3: 22797, 6: 43195, 9: 61192, 12: 87989 }, premium: { 3: 42747, 6: 80995, 9: 114742, 12: 164989 } };
  for (const [plan, row] of Object.entries(table)) for (const [m, total] of Object.entries(row)) assert.equal(CS.quote(plan, Number(m)).total, total, `${plan} ${m} months`);
  assert.equal(CS.quote('basic', 1).total, 3999); assert.equal(CS.quote('growth', 2).total, 15998, 'two months have no offer');
  let q = CS.quote('premium', 12); assert.deepEqual([q.offPercent, q.freeMonths, q.saved], [0, 1, 14999], 'the annual offer is 11 + 1 month free');
  q = CS.quote('basic', 6); assert.deepEqual([q.offPercent, q.gross, q.saved], [10, 23994, 2399]);
  assert.ok(CS.quote('gold', 3).error && CS.quote('basic', 0).error && CS.quote('basic', 99).error && CS.quote('basic', 'x').error, 'a wrong plan or number of months is refused');
  assert.deepEqual(Object.values(CS.PLANS).map((p) => p.price), [3999, 7999, 14999]);
  assert.deepEqual(CS.PLANS.basic.quotas, { posts: 8, reels: 2, stories: 4, gbpPosts: 4, blogs: 0 }); assert.deepEqual(CS.PLANS.growth.quotas, { posts: 12, reels: 4, stories: 8, gbpPosts: 8, blogs: 0 }); assert.deepEqual(CS.PLANS.premium.quotas, { posts: 16, reels: 8, stories: 12, gbpPosts: 12, blogs: 4 });
  console.log('PASS prices: all 12 rupee amounts of the document, the 11 + 1 offer, no offer for other months, wrong input refused; the quantities of the three plans');

  // 2. the audit marks are the document's marks and add up to 100
  assert.deepEqual(CS.GBP_AREAS.map((a) => a.marks), [15, 15, 10, 10, 10, 10, 15, 10, 5]); assert.equal(CS.GBP_AREAS.reduce((s, a) => s + a.marks, 0), 100);
  for (const a of CS.GBP_AREAS) assert.equal(a.checks.reduce((s, c) => s + c.pts, 0), a.marks, `${a.label}: the checks add up to the marks`);
  assert.equal(new Set(CS.CHECKS.map((c) => c.key)).size, CS.CHECKS.length, 'check keys are unique');
  const all = (v) => Object.fromEntries(CS.CHECKS.map((c) => [c.key, v]));
  let r = CS.scoreGbp(all('yes')); assert.deepEqual([r.score, r.band, r.complete, r.actions.length], [100, 'Strong', true, 0]);
  r = CS.scoreGbp(all('no')); assert.deepEqual([r.score, r.band, r.complete], [0, 'Needs a lot of work', true]); assert.equal(r.actions.length, CS.CHECKS.length);
  r = CS.scoreGbp(all('partly')); assert.equal(r.score, 50);
  r = CS.scoreGbp({}); assert.deepEqual([r.score, r.asked, r.complete, r.recommendation], [0, 0, false, 'Tick each check first.']);
  r = CS.scoreGbp({ nameReal: 'yes', catMain: 'banana', catMore: null }); assert.equal(r.asked, 1, 'only yes / partly / no count as an answer'); assert.equal(r.score, 5);
  console.log('PASS audit marks: 15 / 15 / 10 / 10 / 10 / 10 / 15 / 10 / 5 = 100, every area adds up, all yes = 100, all no = 0, partly = half, a half-filled audit is not rounded up');

  // 3. a profile like the document's example: the findings and the order of the actions
  const prof = all('yes'); Object.assign(prof, { svcText: 'no', photoNew: 'no', revReply: 'partly', postRecent: 'no', postGood: 'partly', address: 'partly', linkAct: 'no' });
  r = CS.scoreGbp(prof); assert.equal(r.score, 79, '100 - 3 - 4 - 3 - 5 - 1.5 - 3 - 2 = 78.5, shown as 79'); assert.equal(r.band, 'Good, with clear gaps');
  assert.ok(r.findings.includes('Service descriptions missing') && r.findings.includes('Business photos outdated') && r.findings.includes('Customer reviews waiting for a reply (partly done)') && r.findings.includes('Limited recent profile posts'), r.findings.join(' | '));
  assert.deepEqual(r.actions.map((a) => a.key).slice(0, 3), ['postRecent', 'photoNew', 'address'], 'the biggest losses first');
  assert.ok(r.recommendation.startsWith('Start with: limited recent profile posts; business photos;'), r.recommendation);
  assert.ok(/not an official Google score/i.test(r.disclaimer) && /does not invent/i.test(r.disclaimer));
  assert.equal(r.areas.find((a) => a.key === 'reviews').got, 12, 'reviews: 15 - 3');
  console.log('PASS the report: score, band, findings in plain words, biggest losses first, the "own score, not Google" line');

  // 4. clients on a plan
  const made = await CS.createPlan(admin, { clientName: 'Plan Test Hospital', plan: 'growth', months: 6, startDate: '2026-11-01', industry: 'Hospital', contactName: 'Dr Test', contactPhone: '9999900000' });
  assert.ok(made.plan, JSON.stringify(made)); let p = made.plan;
  assert.deepEqual([p.planLabel, p.months, p.pricePaid, p.endDate, p.status], ['Growth', 6, 43195, '2027-05-01', 'active']);
  assert.deepEqual(p.progress.map((x) => [x.item, x.quota, x.done]), [['posts', 12, 0], ['reels', 4, 0], ['stories', 8, 0], ['gbpPosts', 8, 0]], 'Growth has no SEO blogs');
  p = (await CS.setDelivery(admin, p.id, { month: '2026-11', item: 'posts', delta: 3 })).plan; assert.deepEqual(p.progress[0], { item: 'posts', label: 'Social media posts / creatives', quota: 12, done: 3, left: 9, over: 0, pct: 25, manual: 3, auto: 0, counted: 'work' }); assert.equal(p.progress[3].counted, 'hand', 'GBP posts are counted by hand only');
  p = (await CS.setDelivery(admin, p.id, { month: '2026-11', item: 'posts', count: 14 })).plan; assert.deepEqual([p.progress[0].done, p.progress[0].left, p.progress[0].over, p.progress[0].pct], [14, 0, 2, 100], 'more than the plan is shown as over, never hidden');
  p = (await CS.setDelivery(admin, p.id, { month: '2026-11', item: 'reels', delta: 2 })).plan;
  assert.ok((await CS.setDelivery(admin, p.id, { month: '2026-11', item: 'reels', delta: -5 })).error, 'never below 0');
  assert.ok((await CS.setDelivery(admin, p.id, { month: '2026-11', item: 'tweets', delta: 1 })).error && (await CS.setDelivery(admin, p.id, { month: '2026-11', item: 'posts', count: 5000 })).error && (await CS.setDelivery(admin, 'nope', { item: 'posts', delta: 1 })).error);
  const other = (await CS.getPlan(admin, p.id, '2026-12')).plan; assert.equal(other.progress[0].done, 0, 'each month counts on its own');
  const list = await CS.listPlans(admin, { month: '2026-11' }); const row = list.items.find((x) => x.id === p.id); assert.ok(row); assert.equal(row.deliveredPct, Math.round(((12 + 2) / (12 + 4 + 8 + 8)) * 100), 'the delivered share counts at most the plan quantity per item');
  assert.ok(CS.istMonth() && /^\d{4}-\d{2}$/.test(CS.istMonth()));
  p = (await CS.updatePlan(admin, p.id, { plan: 'premium', months: 12 })).plan; assert.deepEqual([p.planLabel, p.pricePaid, p.progress.length], ['Premium', 164989, 5], 'a changed plan has its own quantities and price');
  p = (await CS.updatePlan(admin, p.id, { status: 'ended' })).plan; assert.deepEqual([p.status, p.renewal], ['ended', 'ended']);
  assert.ok((await CS.createPlan(admin, { clientName: '', plan: 'basic', months: 3 })).error && (await CS.createPlan(admin, { clientName: 'X', plan: 'basic', months: 3, startDate: 'tomorrow' })).error && (await CS.createPlan(admin, { clientName: 'X', plan: 'diamond', months: 3 })).error, 'bad input refused');
  console.log('PASS clients: price kept at the start, quantities per plan, counted by month, over-delivery shown, never below 0, plan change, ended plans, bad input refused');

  // 5. saved audits
  assert.ok((await CS.saveAudit(admin, { clientName: 'Plan Test Hospital', answers: {} })).error && (await CS.saveAudit(admin, { clientName: '', answers: prof })).error, 'an empty audit or no client is refused');
  const sv = await CS.saveAudit(admin, { clientName: 'Plan Test Hospital', planId: p.id, answers: { ...prof, junk: 'yes' } }); assert.ok(sv.audit, JSON.stringify(sv));
  assert.equal(sv.audit.score, 79); assert.equal(sv.audit.report.score, 79); assert.equal(sv.audit.planId, p.id); assert.ok(!('junk' in sv.audit.answers), 'only known checks are kept');
  const ls = await CS.listAudits(admin, { clientName: 'plan test hospital' }); assert.equal(ls.items.length, 1); assert.ok(!('answers' in ls.items[0]));
  assert.equal((await CS.listAudits(admin, { planId: 'zzz' })).items.length, 0);
  assert.ok((await CS.getAudit(admin, 'nope')).error);
  const cat = CS.catalog(); assert.equal(cat.plans.length, 3); assert.equal(cat.gbp.areas.length, 9); assert.equal(cat.offerTerms.length, 7); assert.equal(cat.weeks.length, 5);
  console.log('PASS audits: saved with the score, only known checks kept, listed per client, shown again as a full report; the catalogue the screen reads');

  console.log('client plans tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
