// AI Marketing > SEO assistant, phase 1C: automatic audits and bell alerts (seoSchedule.js).
//   node backend/test-fixtures/mkSeoSchedule.test.js     (throw-away copy of prisma/sandbox.db; the internet and the bell are stand-ins: nothing real is called, nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-seo-sched-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; delete process.env.ALLOW_PRIVATE_FETCH;
const M = '../src/marketing/';
const Sched = require(`${M}seoSchedule`); const Sites = require(`${M}seoSites`); const Tasks = require(`${M}seoTasks`); const Ev = require(`${M}seoEvents`); const Dash = require(`${M}seoDashboard`); const S = require('../src/outreach/store');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const DAY = 86400000;

const web = {};
const fakeFetch = async (url) => { const hit = web[url]; return { status: hit === undefined ? 404 : 200, url, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => (typeof hit === 'string' ? hit : '') }; };
const LD = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const good = (host, withDescription = true) => `<!doctype html><html lang="en"><head><title>${host} clinic in Hyderabad: dental implants and root canal</title>${withDescription ? '<meta name="description" content="A clinic in Hyderabad offering dental implants and root canal. Call to book an appointment today with our team.">' : ''}<meta name="viewport" content="width=device-width"><link rel="canonical" href="https://${host}/"><meta property="og:title" content="x"><meta property="og:description" content="x"><meta property="og:image" content="https://${host}/i.jpg"><meta name="twitter:card" content="summary">${LD({ '@context': 'https://schema.org', '@type': 'MedicalClinic', name: 'Clinic', telephone: '+91 98765 43210', address: { '@type': 'PostalAddress', streetAddress: 'Plot 12' }, url: `https://${host}/`, sameAs: ['https://facebook.com/x'] })}${LD({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [] })}</head><body><h1>Dental implants in Hyderabad</h1><h2>Frequently asked questions</h2><h3>What is a root canal?</h3><h3>How much does an implant cost?</h3><h3>Where is the clinic?</h3><ul><li>x</li></ul><p>Call 9876543210. Plot 12, Road No 3, Banjara Hills, Hyderabad 500034</p><img src="/i.jpg" alt="Dentist at work"><a href="/about">About us</a><a href="/contact">Contact</a><a href="/services">Our services</a><a href="https://facebook.com/x">Facebook</a></body></html>`;
const BARE = '<html><body><h1>Clinic</h1><h1>Second</h1><p>Hello</p><img src="/i.jpg"><a href="/about">click here</a></body></html>';
const setWeb = (host, html, robots) => { Object.keys(web).forEach((k) => { if (k.startsWith(`https://${host}/`)) delete web[k]; }); web[`https://${host}/`] = html; web[`https://${host}/robots.txt`] = robots; web[`https://${host}/sitemap.xml`] = '<urlset></urlset>'; for (const p of ['about', 'contact', 'services']) web[`https://${host}/${p}`] = '<html lang="en"><head><title>x</title></head><body><p>y</p></body></html>'; };
const OK = 'User-agent: *\nAllow: /\nSitemap: https://x/sitemap.xml'; const BLOCK = 'User-agent: *\nDisallow: /';

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  const bells = []; const notify = async (to, m) => { bells.push({ to, ...m }); }; const recipients = async () => ['u-bell'];
  const run = (now, extra = {}) => Sched.sweep({ force: true, now, notify, recipients, fetchFn: fakeFetch, ...extra });

  // 1. the sandbox never runs it by itself
  assert.deepEqual(await Sched.sweep({ notify }), { due: 0, audited: 0, failed: 0, bells: 0, noRecipient: 0, sandbox: true }); assert.equal(Sched.start(), undefined, 'start() does nothing in the sandbox');
  assert.equal((await Sched.recipients({ createdById: 'nobody-here' })).every((x) => typeof x === 'string'), true);

  // 2. the words of the bell
  const al = Sched.alertsOf({ clientName: 'Words Co', alertDrop: 5 }, { prev: 80, score: 70, delta: -10, tasks: { serious: ['Robots.txt asks every search engine to stay away from the whole website'] } });
  assert.deepEqual(al.map((a) => a.kind), ['drop', 'serious']); assert.ok(/went from 80 to 70 out of 100 \(-10 points\)/.test(al[0].message) && /not a ranking/.test(al[0].message) && /Robots\.txt asks every search engine/.test(al[1].message), JSON.stringify(al));
  assert.deepEqual(Sched.alertsOf({ clientName: 'X', alertDrop: 5 }, { prev: 80, score: 77, delta: -3, tasks: { serious: [] } }), [], 'a small drop is not an alert'); assert.deepEqual(Sched.alertsOf({ clientName: 'X', alertDrop: 5 }, { prev: null, score: 50, delta: null, tasks: { serious: [] } }), [], 'a first audit has nothing to drop from');
  console.log('PASS alert words: a drop of the site\'s size or more (with the numbers and "not a ranking"), a serious new problem; a small drop and a first audit are no alert');

  // 3. a weekly site: first audit, nothing due, a good week, a bad week
  setWeb('sched.test', BARE, BLOCK); const site = (await Sites.save(admin, { clientName: 'Sched Clinic', url: 'sched.test', industry: 'clinic', schedule: 'weekly', pages: 1, alertDrop: 10, facts: { name: 'Sched Clinic', city: 'Hyderabad', services: 'Dental implants' } })).site;
  const t0 = Date.now(); let r = await run(t0 + 1000); assert.deepEqual([r.due, r.audited, r.failed], [1, 1, 0], JSON.stringify(r)); assert.equal(bells.length, 1, 'a serious problem in the first audit rings once'); assert.ok(/^Serious SEO problem: Sched Clinic/.test(bells[0].title) && /stay away from the whole website/i.test(bells[0].message) && JSON.stringify(bells[0].to) === '["u-bell"]');
  let raw = await Sites.raw(site.id); assert.ok(S.num(raw.lastScore) < 40 && raw.lastCheckId && Math.abs(S.num(raw.nextRunAt) - (t0 + 1000 + 7 * DAY)) < 2 * DAY, 'the audit is saved and the next one is a week away'); assert.equal(S.num(raw.fails), 0);
  r = await run(t0 + 2000); assert.equal(r.due, 0, 'nothing is due before the week is over'); assert.equal(bells.length, 1);
  setWeb('sched.test', good('sched.test'), OK); r = await run(t0 + 8 * DAY + 5000); assert.deepEqual([r.due, r.audited, r.bells], [1, 1, 0], 'a better score rings no bell'); raw = await Sites.raw(site.id); assert.ok(S.num(raw.lastScore) >= 85);
  const feed = await Ev.recent(site.id, 20); assert.ok(feed.some((e) => e.kind === 'fixed' && e.level === 'good') && feed.some((e) => e.kind === 'audit' && /to \d+ \(\+\d+ points\)/.test(e.title)), 'improvements are in the feed, not in the bell');
  setWeb('sched.test', good('sched.test', false), OK); r = await run(t0 + 16 * DAY); assert.deepEqual([r.audited, r.bells], [1, 0], 'a drop of 6 is under this site\'s alert size of 10: no bell'); assert.ok(S.num((await Sites.raw(site.id)).lastScore) >= 80);
  await Sites.save(admin, { id: site.id, alertDrop: 5 }); setWeb('sched.test', good('sched.test'), OK); await run(t0 + 24 * DAY); bells.length = 0; setWeb('sched.test', good('sched.test', false), OK); r = await run(t0 + 32 * DAY); assert.equal(bells.length, 1, 'with an alert size of 5 the same drop rings'); assert.ok(/^SEO score dropped: Sched Clinic/.test(bells[0].title) && /\(-6 points\)/.test(bells[0].message), bells[0].message);
  bells.length = 0; setWeb('sched.test', BARE, BLOCK); r = await run(t0 + 40 * DAY); assert.deepEqual(bells.map((b) => b.title.split(':')[0]), ['SEO score dropped', 'Serious SEO problem'], 'a big drop and a serious problem that came back: two bells, once each'); const f2 = await Ev.recent(site.id, 30); assert.ok(f2.some((e) => e.kind === 'drop' && e.level === 'warn') && f2.some((e) => e.kind === 'serious' && e.level === 'bad'));
  const t = (await Tasks.list(admin, { siteId: site.id })).items; assert.ok(t.length > 5 && new Set(t.map((x) => x.issue)).size === t.length, 'the audits fed the recommendations without duplicates');
  assert.ok((await Dash.overview(admin, { siteId: site.id })).site.audits === 6 && (await require(`${M}siteCheck`).list(admin, { clientName: 'Sched Clinic' })).items.every((x) => x.pages === 1), 'every scheduled audit is a saved check');
  console.log('PASS a weekly site: the first audit (a serious problem rings once), nothing due before the week is over, the next audit a week later, a better score is in the feed and rings no bell, a drop under the alert size rings nothing and the same drop over it rings, a big drop and a returning serious problem ring once each, the recommendations follow');

  // 4. a website that cannot be reached
  Object.keys(web).filter((k) => k.startsWith('https://down.test/')).forEach((k) => delete web[k]); const dsite = (await Sites.save(admin, { clientName: 'Down Co', url: 'down.test', schedule: 'monthly', pages: 1 })).site; bells.length = 0;
  const d0 = Date.now() + 100 * DAY; r = await run(d0); assert.deepEqual([r.due >= 1, r.failed >= 1], [true, true]); raw = await Sites.raw(dsite.id); assert.equal(S.num(raw.fails), 1); assert.ok(Math.abs(S.num(raw.nextRunAt) - (d0 + DAY)) < 1000, 'tried again the next day'); assert.equal(bells.filter((b) => /Down Co/.test(b.title)).length, 0, 'no bell after the first miss');
  r = await run(d0 + DAY + 1000); raw = await Sites.raw(dsite.id); assert.equal(S.num(raw.fails), 2); assert.deepEqual(bells.filter((b) => /Down Co/.test(b.title)).map((b) => b.title), ['Website could not be reached: Down Co'], 'a bell after the second miss in a row'); assert.ok(/failed twice in a row/.test(bells.find((b) => /Down Co/.test(b.title)).message));
  r = await run(d0 + 2 * DAY + 2000); assert.equal(S.num((await Sites.raw(dsite.id)).fails), 3); assert.equal(bells.filter((b) => /Down Co/.test(b.title)).length, 1, 'no second bell for the same outage');
  const ev = await Ev.recent(dsite.id, 10); assert.ok(ev.filter((e) => e.kind === 'unreachable').length === 3 && ev[0].level === 'bad' && /could not be audited \(3 times in a row\)/.test(ev[0].title));
  setWeb('down.test', good('down.test'), OK); r = await run(d0 + 3 * DAY + 3000); raw = await Sites.raw(dsite.id); assert.equal(S.num(raw.fails), 0, 'back up: the count starts again'); assert.ok(raw.lastScore != null && S.num(raw.nextRunAt) > d0 + 3 * DAY + 20 * DAY, 'monthly again');
  console.log('PASS an unreachable website: tried again every day, no bell after the first miss, one bell after the second, none for the same outage, a feed line each time, the count starts again when it is back');

  // 5. who gets the bell, departments, limits, off
  const noBody = await Sites.save(admin, { clientName: 'No Recipient Co', url: 'nor.test', schedule: 'weekly', pages: 1 }); setWeb('nor.test', BARE, BLOCK); const before = bells.length; r = await Sched.sweep({ force: true, now: Date.now() + 200 * DAY, notify, recipients: async () => [], fetchFn: fakeFetch, limit: 50 }); assert.ok(r.noRecipient >= 1 && bells.length === before, 'nobody to tell: counted, not sent');
  setWeb('dep.test', good('dep.test'), OK); const dep = (await Sites.save(admin, { clientName: 'Sales Sched Co', url: 'dep.test', schedule: 'weekly', pages: 1, department: 'Sales' })).site; r = await run(Date.now() + 300 * DAY, { limit: 50 }); assert.ok(r.audited >= 1 && S.num((await Sites.raw(dep.id)).lastScore) > 0, 'a department\'s site is audited by the scheduler');
  await Sites.save(admin, { clientName: 'Off Co', url: 'off.test', schedule: 'off' }); const offRaw = (await S.q('SELECT * FROM "OmniMkSeoSite" WHERE clientName = ?', 'Off Co'))[0]; assert.equal(S.num(offRaw.nextRunAt), 0); assert.ok(!(await Sites.dueSites(Date.now() + 999 * DAY, 100)).some((x) => x.clientName === 'Off Co'), 'a site that is not automatic is never due');
  await Sites.remove(admin, noBody.site.id); assert.ok(!(await Sites.dueSites(Date.now() + 999 * DAY, 100)).some((x) => x.id === noBody.site.id), 'a removed site is never due'); assert.equal((await Sites.dueSites(Date.now() + 999 * DAY, 2)).length <= 2, true, 'a sweep takes few sites');
  console.log('PASS limits: nobody to tell is counted and nothing is sent, a department\'s site is audited, "not automatic" and removed sites are never due, a sweep takes at most the limit');

  console.log('SEO assistant phase 1C tests: all passed'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
