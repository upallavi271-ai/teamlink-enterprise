// AI Marketing > Client plans > Onboarding (marketing/onboarding.js): the checklist for a new client, the steps that tick themselves, and the reminders at 7 and 14 days (planReminders.js).
//   node backend/test-fixtures/mkOnboarding.test.js     (throw-away copy of prisma/sandbox.db; the internet is a stand-in; nothing real is touched, nothing is sent: the bell is a test stub)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-onb-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; delete process.env.ALLOW_PRIVATE_FETCH;
const M = '../src/marketing/';
const Onb = require(`${M}onboarding`); const CS = require(`${M}clientServices`); const Site = require(`${M}siteCheck`); const Comp = require(`${M}competitors`); const Blog = require(`${M}blogPlanner`); const PR = require(`${M}planReminders`); const S = require('../src/outreach/store');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const ist = (s) => Date.parse(`${s}+05:30`);
const page = '<html lang="en"><head><title>A page for the onboarding test</title></head><body><h1>Page</h1><p>Hello</p></body></html>';
const mkFetch = (pages) => async (url) => { const hit = pages[url]; return { status: hit === undefined ? 404 : 200, url, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => (typeof hit === 'string' ? hit : '') }; };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet

  // 1. the checklist itself
  assert.equal(new Set(Onb.STEPS.map((s) => s.key)).size, Onb.STEPS.length, 'unique keys'); assert.equal(Onb.STEPS.length, 26);
  const groups = Onb.GROUPS.map((g) => g[0]); assert.ok(Onb.STEPS.every((s) => groups.includes(s.group) && s.text && (typeof s.hint === 'function' || s.hint) && ['client', 'team', 'both'].includes(s.who)), 'every step has a group, words, a hint and who does it');
  assert.deepEqual(Onb.STEPS.filter((s) => s.auto).map((s) => s.auto).sort(), ['audit', 'blogplan', 'competitors', 'sitecheck'], 'four steps tick themselves'); assert.ok(Onb.STEPS.filter((s) => s.auto).every((s) => s.group === 'tools' && s.who === 'team'));
  assert.deepEqual(Onb.STEPS.filter((s) => s.only).map((s) => [s.key, s.only]), [['blogplan', 'blogs'], ['medical', 'health'], ['patients', 'health']]);
  assert.ok(!/password/i.test(Onb.STEPS.map((s) => s.key).join()), 'no step asks for a password'); assert.ok(/Never share or write down a password/.test(Onb.STEPS.find((s) => s.key === 'manager').hint) && /stays the Owner/.test(Onb.STEPS.find((s) => s.key === 'manager').hint), 'the client stays the Owner, TeamLink is a Manager, a password is never written down');
  console.log('PASS the checklist: 26 steps in 5 groups, each with its words, hint and who does it, four tick themselves, healthcare / blog steps only where they apply, TeamLink is a Manager and never holds a password');

  // 2. a hospital on Premium and an IT company on Basic
  const hp = (await CS.createPlan(admin, { clientName: 'Onb Test Hospital', plan: 'premium', months: 3, startDate: '2026-11-01', industry: 'Multi-speciality hospital' })).plan;
  let o = (await Onb.get(admin, hp.id)).onboarding; const all = (x) => x.groups.flatMap((g) => g.items); const step = (x, k) => all(x).find((i) => i.key === k);
  assert.deepEqual([o.clientName, o.healthcare, o.industryLabel, o.summary.total, o.summary.coreTotal, o.summary.done, o.summary.coreLeft, o.summary.ready, o.groups.length], ['Onb Test Hospital', true, 'Hospital', 26, 17, 0, 17, false, 5]);
  assert.deepEqual(o.groups.map((g) => g.label), ['Get access to the Google profile', 'Collect the facts', 'Website and reporting', 'Run the TeamLink tools', 'Agree how we work']);
  assert.ok(/Hospital, Multi-specialty hospital, Emergency care service/.test(step(o, 'categories').hint) && /No patient in any picture/.test(step(o, 'photos').hint) && step(o, 'medical') && step(o, 'blogplan'), 'ideas for the categories from the industry pack; healthcare and blog steps are there');
  const ip = (await CS.createPlan(admin, { clientName: 'Onb Test IT', plan: 'basic', months: 3, startDate: '2026-11-01', industry: 'Software company' })).plan; const io = (await Onb.get(admin, ip.id)).onboarding;
  assert.deepEqual([io.healthcare, io.summary.total, io.summary.coreTotal], [false, 23, 16]); assert.ok(!step(io, 'medical') && !step(io, 'patients') && !step(io, 'blogplan') && !/patient/i.test(step(io, 'photos').hint), 'no healthcare or blog step for an IT company on Basic');
  const gp = (await CS.createPlan(admin, { clientName: 'Onb Test Clinic', plan: 'growth', months: 3, startDate: '2026-11-01', industry: 'Dental clinic' })).plan; assert.equal((await Onb.get(admin, gp.id)).onboarding.summary.total, 25, 'a clinic on Growth: healthcare steps, no blog step');
  assert.ok((await Onb.get(admin, 'nope')).error);
  console.log('PASS the lists: a hospital on Premium gets 26 steps (17 must-do) with the industry pack\'s category ideas, an IT company on Basic 23 (16), a clinic on Growth 25');

  // 3. ticking
  const tick = (k, b) => Onb.setStep(admin, hp.id, k, b);
  o = (await tick('consent', { done: true })).onboarding; let c = step(o, 'consent'); assert.deepEqual([c.done, c.doneBy, typeof c.doneAt, o.summary.done, o.summary.coreDone, o.summary.pct], [true, 'Test Admin', 'string', 1, 1, 4]); const at = c.doneAt;
  o = (await tick('consent', { done: true, note: 'Signed agreement filed' })).onboarding; c = step(o, 'consent'); assert.deepEqual([c.done, c.note, c.doneAt], [true, 'Signed agreement filed', at], 'ticking again keeps the first time; a note is kept');
  o = (await tick('hours', { note: 'Client will send after Diwali' })).onboarding; c = step(o, 'hours'); assert.deepEqual([c.done, c.note], [false, 'Client will send after Diwali'], 'a note without a tick');
  o = (await tick('consent', { done: false })).onboarding; c = step(o, 'consent'); assert.deepEqual([c.done, c.doneAt, c.doneBy, c.note, o.summary.done], [false, null, '', 'Signed agreement filed', 0], 'un-ticking clears who and when and keeps the note');
  for (const [k, b] of [['audit', { done: true }], ['sitecheck', { done: true }], ['nope', { done: true }]]) assert.ok((await tick(k, b)).error, `refused: ${k}`);
  assert.ok((await Onb.setStep(admin, ip.id, 'medical', { done: true })).error, 'a step that is not in this client\'s list is refused'); assert.ok((await Onb.setStep(admin, 'nope', 'consent', { done: true })).error);
  console.log('PASS ticking: who and when kept, a second tick keeps the first time, notes, un-ticking, the steps of the tools and steps of another kind of client refused');

  // 4. the steps that tick themselves
  o = (await Onb.get(admin, hp.id)).onboarding; for (const k of ['audit', 'sitecheck', 'competitors', 'blogplan']) assert.deepEqual([step(o, k).done, step(o, k).evidence], [false, 'Not saved yet.'], k);
  assert.ok((await CS.saveAudit(admin, { clientName: 'Onb Test Hospital', planId: hp.id, answers: { nameReal: 'yes' } })).audit);
  const web = { 'https://on.test/': page, 'https://rival.test/': page };
  assert.ok((await Site.check(admin, { url: 'on.test', save: true, clientName: 'onb test hospital' }, { fetchFn: mkFetch(web) })).id);
  assert.ok((await Comp.snapshot(admin, { client: { name: 'Onb Test Hospital', url: 'on.test' }, competitors: [{ name: 'Rival', url: 'rival.test' }], clientName: 'Onb Test Hospital', save: true }, { fetchFn: mkFetch(web) })).snapshot);
  assert.ok((await Blog.plan(admin, { planId: hp.id, name: 'Onb Test Hospital', city: 'Pune', services: 'heart care', save: true })).id);
  o = (await Onb.get(admin, hp.id)).onboarding; for (const k of ['audit', 'sitecheck', 'competitors', 'blogplan']) { assert.equal(step(o, k).done, true, k); assert.ok(/^Found: saved on \d{1,2} \w{3} \d{4}\.$/.test(step(o, k).evidence), `${k}: ${step(o, k).evidence}`); }
  assert.deepEqual([o.summary.done, o.summary.coreDone], [4, 2], 'two of the four are must-do'); assert.equal((await Onb.get(admin, ip.id)).onboarding.summary.done, 0, 'another client\'s work does not tick these');
  // must-do all done = ready to start
  for (const k of Onb.STEPS.filter((s) => s.core && !s.auto).map((s) => s.key)) await tick(k, { done: true }); o = (await Onb.get(admin, hp.id)).onboarding; assert.deepEqual([o.summary.coreLeft, o.summary.ready, o.summary.done], [0, true, 4 + 15], 'every must-do step done = ready to start');
  console.log('PASS the steps that tick themselves: a saved audit, website check, competitor snapshot and blog plan tick their step by name of the client; all must-do steps done = ready');

  // 5. the reminders: 7 and 14 days after the start, only while must-do steps are open
  const sent = []; const notify = async (to, m) => { sent.push({ to, ...m }); }; const tell = () => sent.splice(0);
  const pr = { notify, recipients: async () => [admin.id], force: true, skip: [] };
  // plans: IT (start 2026-11-01, nothing ticked) and hospital (ready). A fresh plan 'Fresh Co' starts on 2026-11-20.
  const dayOf = (d) => ist(`${d}T10:00:00`); const onb = (res) => res.filter((x) => /Onboarding not finished/.test(x.title));
  await CS.updatePlan(admin, gp.id, { status: 'ended' });
  const fresh = (await CS.createPlan(admin, { clientName: 'Fresh Co', plan: 'basic', months: 6, startDate: '2026-11-20', industry: 'Software company' })).plan;
  let d = await PR.due(admin, { now: dayOf('2026-11-24') }); assert.deepEqual(d.filter((x) => x.kind === 'onboarding').map((x) => x.clientName), ['Onb Test IT'], '23 days after the start with must-do steps open: shown; the hospital is ready; Fresh Co is only 4 days old');
  const it = d.find((x) => x.kind === 'onboarding'); assert.deepEqual([it.level, it.days, it.title], ['soon', 23, 'Onboarding not finished: Onb Test IT']); assert.ok(/16 of the 16 must-do steps are still open, 23 days after the Basic plan started/.test(it.message) && /Client plans > Onboarding/.test(it.message));
  await PR.sweep({ ...pr, now: dayOf('2026-11-24') }); let t = onb(tell()); assert.deepEqual(t.map((x) => x.title), ['Onboarding not finished: Onb Test IT'], 'one bell, covering the 7 and 14 day steps (first seen at 23 days)');
  await PR.sweep({ ...pr, now: dayOf('2026-11-25') }); assert.equal(onb(tell()).length, 0, 'not told again');
  assert.deepEqual((await S.q('SELECT stepKey FROM "OmniMkPlanReminder" WHERE kind = ? ORDER BY stepKey', 'onboarding')).map((x) => x.stepKey), ['14', '7']);
  await PR.sweep({ ...pr, now: dayOf('2026-11-26') }); assert.equal(onb(tell()).filter((x) => /Fresh Co/.test(x.title)).length, 0, 'Fresh Co is 6 days old: nothing yet');
  d = await PR.due(admin, { now: dayOf('2026-11-27'), skip: ['renew', 'report'] }); assert.deepEqual(d.filter((x) => x.kind === 'onboarding' && /Fresh/.test(x.clientName)).map((x) => [x.level, x.days]), [['notice', 7]], '7 days after the start: a notice');
  await PR.sweep({ ...pr, now: dayOf('2026-11-27') }); t = onb(tell()); assert.deepEqual(t.map((x) => x.title), ['Onboarding not finished: Fresh Co'], 'a bell at 7 days');
  await PR.sweep({ ...pr, now: dayOf('2026-12-04') }); t = onb(tell()); assert.deepEqual(t.map((x) => x.title), ['Onboarding not finished: Fresh Co'], 'and one more at 14 days'); await PR.sweep({ ...pr, now: dayOf('2026-12-06') }); assert.equal(onb(tell()).length, 0, 'then no more');
  for (const k of Onb.STEPS.filter((s) => s.core && !s.auto && !s.only).map((s) => s.key)) await Onb.setStep(admin, fresh.id, k, { done: true });
  assert.equal((await Onb.summarize({ id: fresh.id, plan: 'basic', industry: 'Software company', clientName: 'Fresh Co' })).coreLeft, 2, 'the audit and the website check are still to be saved');
  await Site.check(admin, { url: 'on.test', save: true, clientName: 'Fresh Co' }, { fetchFn: mkFetch(web) }); await CS.saveAudit(admin, { clientName: 'Fresh Co', planId: fresh.id, answers: { nameReal: 'yes' } });
  assert.equal((await Onb.summarize({ id: fresh.id, plan: 'basic', industry: 'Software company', clientName: 'Fresh Co' })).ready, true);
  assert.ok(!(await PR.due(admin, { now: dayOf('2026-12-10'), skip: ['renew', 'report'] })).some((x) => x.clientName === 'Fresh Co' && x.kind === 'onboarding'), 'ready: no reminder, nothing on the screen');
  assert.ok(!(await PR.due(admin, { now: dayOf('2027-02-10'), skip: ['renew', 'report'] })).some((x) => x.kind === 'onboarding'), 'after 60 days it is no longer reminded');
  assert.equal((await PR.due(admin, { now: dayOf('2026-11-24'), skip: ['onboarding'] })).filter((x) => x.kind === 'onboarding').length, 0, 'the skip option leaves it out');
  console.log('PASS reminders: shown and told 7 and 14 days after the start while must-do steps are open (one bell if first seen late), none before 7 days, after 60 days or when ready, nothing told twice');

  // 6. another department's client
  const dp = (await CS.createPlan(admin, { clientName: 'Sales Onb Co', plan: 'basic', months: 3, startDate: '2026-11-01', industry: 'Software company', department: 'Sales' })).plan; assert.ok(dp);
  const restricted = { id: 'u-restricted', name: 'Recruiter', role: 'RECRUITER', atsRole: 'RECRUITER', department: 'Recruitment' };
  assert.ok((await Onb.get(restricted, dp.id)).error && (await Onb.setStep(restricted, dp.id, 'consent', { done: true })).error, 'another department\'s client cannot be read or ticked'); assert.ok((await Onb.get(admin, dp.id)).onboarding);
  console.log('PASS departments: another department\'s onboarding cannot be read or ticked');

  console.log('onboarding tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
