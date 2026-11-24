// AI Marketing > Client plans: delivery counted from approved work (marketing/clientServices.js autoCounts) and the plan reminders (marketing/planReminders.js).
//   node backend/test-fixtures/mkPlanAutoCount.test.js     (runs on a throw-away copy of prisma/sandbox.db; nothing real is touched, nothing is sent: the bell is a test stub)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-autocount-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
const S = require('../src/outreach/store');
const CS = require('../src/marketing/clientServices');
const PR = require('../src/marketing/planReminders');
const Mrep = require('../src/marketing/monthlyReport');
const P = require('../src/marketing/projects');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const ist = (s) => Date.parse(`${s}+05:30`);
(async () => {
  const prisma = require('../src/db');
  const real = await prisma.user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet
  await require('../src/marketing/images').ensure();
  const mkProject = async (clientName) => { const r = await P.create(admin, { clientName, occasion: 'Diwali', brief: 'A Diwali post with our logo', deliverable: 'both' }); assert.ok(r.project, JSON.stringify(r)); return r.project; };
  const img = (pid, o = {}) => S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, status, createdById, createdByName, createdAt, updatedAt, projectId, decidedAt, deletedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    S.newId('im'), o.title || 'Work', 'p', o.style || 'photo', o.aspect || '1:1', 'x', o.mime || 'image/png', o.status || 'approved', admin.id, admin.name, Date.now(), Date.now(), pid, o.decidedAt == null ? null : o.decidedAt, o.deletedAt || null);

  // ---- 1. delivery counted from approved work ---------------------------------------------------------------------------------------------------------------------
  const plan = (await CS.createPlan(admin, { clientName: 'Auto Count Hospital', plan: 'growth', months: 6, startDate: '2026-11-01', industry: 'Hospital' })).plan; assert.ok(plan);
  const pj = await mkProject('auto count hospital'); const pj2 = await mkProject('Auto Count Hospital'); const other = await mkProject('Auto Count Hospital Group');
  await img(pj.id, { title: 'Square post', decidedAt: ist('2026-11-05T10:00:00') });                                   // a post
  await img(pj.id, { title: 'Story art', aspect: '9:16', decidedAt: ist('2026-11-06T10:00:00') });                      // a story
  await img(pj.id, { title: 'Tall video', aspect: '9:16', mime: 'video/mp4', decidedAt: ist('2026-11-07T10:00:00') });  // a Reel
  await img(pj.id, { title: 'Wide video', aspect: '16:9', mime: 'video/mp4', decidedAt: ist('2026-11-08T10:00:00') });  // a post
  await img(pj.id, { title: 'Last second', aspect: '4:5', decidedAt: ist('2026-11-30T23:59:59') });                     // still November in India
  await img(pj2.id, { title: 'Second project', decidedAt: ist('2026-11-13T10:00:00') });                                // every project of the client counts
  await img(pj.id, { title: 'Before', decidedAt: ist('2026-10-31T23:59:59') });                                         // October
  await img(pj.id, { title: 'After', decidedAt: ist('2026-12-01T00:00:00') });                                          // December
  await img(pj.id, { title: 'Raw clip', style: 'clip', aspect: '9:16', mime: 'video/mp4', decidedAt: ist('2026-11-09T10:00:00') }); // a raw stock clip is not made work
  for (const status of ['draft', 'waiting', 'changes', 'rejected']) await img(pj.id, { title: `Not approved (${status})`, status, decidedAt: ist('2026-11-10T10:00:00') });
  await img(pj.id, { title: 'Deleted', decidedAt: ist('2026-11-11T10:00:00'), deletedAt: Date.now() });
  await img(other.id, { title: 'Another client', decidedAt: ist('2026-11-12T10:00:00') });                              // a name that only starts the same
  let au = await CS.autoCounts('Auto Count Hospital', '2026-11');
  assert.deepEqual([au.posts, au.reels, au.stories, au.items.length], [4, 1, 1, 6], 'posts: square, wide video, last second, second project; one Reel; one story');
  assert.deepEqual(au.items.map((x) => x.title), ['Square post', 'Story art', 'Tall video', 'Wide video', 'Second project', 'Last second'], 'listed in the order they were approved');
  assert.deepEqual(au.items.map((x) => x.kind), ['posts', 'stories', 'reels', 'posts', 'posts', 'posts']);
  assert.equal((await CS.autoCounts('  AUTO count HOSPITAL ', '2026-11')).posts, 4, 'the client name is matched without capitals or spaces');
  assert.equal((await CS.autoCounts('Auto Count Hospital', '2026-10')).posts, 1, 'the last second of October stays in October');
  assert.equal((await CS.autoCounts('Auto Count Hospital', '2026-12')).posts, 1, 'the first second of December counts in December');
  for (const n of ['', 'Nobody Co']) { const z = await CS.autoCounts(n, '2026-11'); assert.deepEqual([z.posts, z.reels, z.stories, z.items.length], [0, 0, 0, 0]); }
  assert.equal((await CS.autoCounts('Auto Count Hospital', 'soon')).posts, 0, 'a bad month counts nothing');
  let p = (await CS.getPlan(admin, plan.id, '2026-11')).plan; const row = (k) => p.progress.find((x) => x.item === k);
  assert.deepEqual([row('posts').auto, row('posts').manual, row('posts').done, row('posts').counted], [4, 0, 4, 'work']);
  assert.deepEqual([row('reels').auto, row('stories').auto, row('gbpPosts').auto, row('gbpPosts').counted], [1, 1, 0, 'hand'], 'GBP posts and blogs stay counted by hand');
  assert.equal(p.autoItems.length, 6);
  p = (await CS.setDelivery(admin, plan.id, { month: '2026-11', item: 'posts', delta: 2 })).plan; assert.deepEqual([row('posts').auto, row('posts').manual, row('posts').done, row('posts').left], [4, 2, 6, 6], 'the team adds to the counted work');
  assert.ok((await CS.setDelivery(admin, plan.id, { month: '2026-11', item: 'posts', delta: -3 })).error, 'the buttons cannot take away work that was counted by itself');
  p = (await CS.setDelivery(admin, plan.id, { month: '2026-11', item: 'gbpPosts', delta: 5 })).plan; assert.equal(row('gbpPosts').done, 5);
  const lp = (await CS.listPlans(admin, { month: '2026-11' })).items.find((x) => x.id === plan.id);
  assert.equal(lp.autoItems.length, 6); assert.equal(lp.deliveredPct, Math.round(((6 + 1 + 1 + 5) / 32) * 100), 'the share counts both the work and the hand count, at most the plan quantity per item');
  assert.equal((await CS.getPlan(admin, plan.id, '2026-12')).plan.progress[0].auto, 1, 'each month counts its own work');
  console.log('PASS auto count: approved pictures and videos counted per month in India time, post / story / Reel by size and type, raw clips + drafts + deleted + other clients left out, the hand count added on top');

  // ---- 2. the words of a reminder (no database) -------------------------------------------------------------------------------------------------------------------
  const v = (end) => ({ endDate: end, planLabel: 'Basic', clientName: 'X Co' });
  assert.equal(PR.renewalOf(v('2027-01-01'), '2026-11-20'), null, 'more than 30 days: nothing');
  assert.deepEqual([PR.renewalOf(v('2026-12-20'), '2026-11-20').keys, PR.renewalOf(v('2026-12-04'), '2026-11-20').keys, PR.renewalOf(v('2026-11-27'), '2026-11-20').keys, PR.renewalOf(v('2026-11-20'), '2026-11-20').keys], [['30'], ['30', '14'], ['30', '14', '7'], ['30', '14', '7', '0']]);
  assert.equal(PR.renewalOf(v('2026-11-21'), '2026-11-20').title, 'Client plan ends in 1 day: X Co'); assert.equal(PR.renewalOf(v('2026-11-20'), '2026-11-20').title, 'Client plan ends today: X Co');
  const od = PR.renewalOf(v('2026-11-17'), '2026-11-20'); assert.deepEqual([od.keys, od.level, od.title], [['overdue'], 'overdue', 'Client plan ended: X Co']); assert.ok(/ended 3 days ago/.test(od.message));
  assert.deepEqual(['2026-02-25', '2026-02-26', '2028-02-26', '2028-02-27', '2026-12-28', '2026-12-29', '2026-11-27', '2026-11-28'].map((d) => PR.reportMonth(d, 3)), [null, '2026-02', null, '2028-02', null, '2026-12', null, '2026-11'], 'the last 3 days of the month, leap years included');
  assert.equal(PR.reportMonth('2026-11-24', 7), '2026-11'); assert.equal(PR.reportMonth('2026-11-23', 7), null);
  console.log('PASS the words: 30 / 14 / 7 / today / ended steps, "1 day", the last days of the month incl. February and leap years');

  // ---- 3. the sandbox never sends, a missing recipient is not marked as sent -------------------------------------------------------------------------------------------
  const sent = []; const notify = async (to, m) => { sent.push({ to, ...m }); }; const tell = () => sent.splice(0);
  const sb = await PR.sweep({ notify, now: ist('2026-11-20T10:00:00') }); assert.equal(sb.sandbox, true); assert.equal(sent.length, 0, 'in the sandbox nothing is sent');
  assert.equal(PR.start(), undefined, 'the daily job does not start in the sandbox');
  const C = (await CS.createPlan(admin, { clientName: 'Orphan Co', plan: 'basic', months: 1, startDate: '2026-11-01' })).plan; // ends 2026-12-01
  const now1 = ist('2026-11-20T10:00:00');
  let s = await PR.sweep({ notify, now: now1, force: true, skip: ['onboarding'], recipients: async () => [] }); // the onboarding bells have their own test (mkOnboarding.test.js)
  assert.deepEqual([s.sent, s.noRecipient], [0, 1]); assert.equal(sent.length, 0);
  assert.equal((await S.q('SELECT stepKey FROM "OmniMkPlanReminder" WHERE planId = ?', C.id)).length, 0, 'nobody was told, so it is not marked as sent');
  s = await PR.sweep({ notify, now: now1, force: true, skip: ['onboarding'], recipients: async () => ['u1'] });
  assert.deepEqual([s.sent, s.noRecipient], [1, 0]); assert.deepEqual(tell().map((x) => [x.to, x.title]), [[['u1'], 'Client plan ends in 11 days: Orphan Co']]);
  await CS.updatePlan(admin, C.id, { status: 'ended' });
  console.log('PASS sandbox + recipients: nothing is sent in the sandbox, the daily job stays off there, no recipient = not marked as sent, tried again at the next sweep');

  // ---- 4. the reminders over a month: each once, the right words ------------------------------------------------------------------------------------------------------
  const pr = { notify, recipients: async () => [admin.id], force: true, skip: ['onboarding'] };
  const A = (await CS.createPlan(admin, { clientName: 'Renew Test Co', plan: 'basic', months: 1, startDate: '2026-11-01' })).plan; assert.equal(A.endDate, '2026-12-01');
  s = await PR.sweep({ ...pr, now: ist('2026-11-20T10:00:00') }); assert.equal(s.sent, 1); let t = tell(); assert.equal(t.length, 1);
  assert.equal(t[0].title, 'Client plan ends in 11 days: Renew Test Co'); assert.ok(/Basic plan of Renew Test Co/.test(t[0].message) && /2026/.test(t[0].message) && /renew/i.test(t[0].message)); assert.deepEqual(t[0].to, [admin.id]);
  assert.deepEqual((await S.q('SELECT stepKey FROM "OmniMkPlanReminder" WHERE planId = ? AND kind = ? ORDER BY stepKey', A.id, 'renew')).map((x) => x.stepKey), ['14', '30'], 'seen with 11 days left: the 30 and 14 day steps are used up together, one bell');
  s = await PR.sweep({ ...pr, now: ist('2026-11-20T16:00:00') }); assert.deepEqual([s.sent, s.skipped], [0, 1]); assert.equal(tell().length, 0, 'the same day again: no second bell');
  s = await PR.sweep({ ...pr, now: ist('2026-11-24T10:00:00') }); t = tell(); assert.deepEqual(t.map((x) => x.title), ['Client plan ends in 7 days: Renew Test Co']);
  // the screen: what needs attention on 24 Nov (7 days left, and the report window of the last 7 days is open)
  const dueOn = (day, u = admin) => PR.due(u, { now: ist(`${day}T11:00:00`), skip: ['onboarding'] });
  const rowsNow = async () => Number((await S.q('SELECT COUNT(*) AS n FROM "OmniMkPlanReminder"'))[0].n); const rowsBefore = await rowsNow();
  let d = await dueOn('2026-11-24'); assert.deepEqual(d.map((x) => [x.kind, x.clientName, x.level]), [['renew', 'Renew Test Co', 'soon'], ['report', 'Auto Count Hospital', 'notice'], ['report', 'Renew Test Co', 'notice']], JSON.stringify(d));
  assert.equal((await dueOn('2026-11-23')).filter((x) => x.kind === 'report').length, 0, 'before the last 7 days of the month there is no report line');
  assert.equal(await rowsNow(), rowsBefore, 'the screen reads only: it writes nothing');
  // a plan of another department is not shown to a login that may not see it
  const D = (await CS.createPlan(admin, { clientName: 'Sales Dept Co', plan: 'premium', months: 12, startDate: '2026-11-01', department: 'Sales' })).plan;
  const restricted = { id: 'u-restricted', name: 'Recruiter', role: 'RECRUITER', atsRole: 'RECRUITER', department: 'Recruitment' };
  assert.equal((await dueOn('2026-11-24')).filter((x) => x.clientName === 'Sales Dept Co').length, 1); assert.equal((await dueOn('2026-11-24', restricted)).filter((x) => x.clientName === 'Sales Dept Co').length, 0, 'another department\'s client is not listed');
  await CS.updatePlan(admin, D.id, { status: 'ended' });
  // numbers saved in the monthly report: a real save stops the reminder, an empty one does not
  assert.ok((await Mrep.save(admin, A.id, { month: '2026-11', metrics: {} })).report, 'an empty save');
  assert.ok((await Mrep.save(admin, plan.id, { month: '2026-11', metrics: { social: { postsPublished: 14 }, gbp: { calls: 31 } } })).report, 'a save with numbers');
  d = await dueOn('2026-11-24'); assert.deepEqual(d.filter((x) => x.kind === 'report').map((x) => x.clientName), ['Renew Test Co'], 'Auto Count Hospital has numbers now; the empty save of Renew Test Co does not count');
  s = await PR.sweep({ ...pr, now: ist('2026-11-27T10:00:00') }); assert.equal(s.sent, 0, '3 days left on 27 Nov is still the step already used, and it is not yet the last 3 days of the month');
  s = await PR.sweep({ ...pr, now: ist('2026-11-28T10:00:00') }); t = tell(); assert.deepEqual(t.map((x) => x.title), ['Monthly report due: Renew Test Co'], 'one bell, only for the plan whose report is still empty');
  assert.ok(/November 2026/.test(t[0].message) && /no numbers saved/.test(t[0].message));
  s = await PR.sweep({ ...pr, now: ist('2026-11-30T10:00:00') }); assert.equal(s.sent, 0, 'the report bell goes once for the month');
  s = await PR.sweep({ ...pr, now: ist('2026-12-01T10:00:00') }); assert.deepEqual(tell().map((x) => x.title), ['Client plan ends today: Renew Test Co']);
  const B = (await CS.createPlan(admin, { clientName: 'Late Seen Co', plan: 'basic', months: 1, startDate: '2026-11-10' })).plan; assert.equal(B.endDate, '2026-12-10');
  s = await PR.sweep({ ...pr, now: ist('2026-12-04T10:00:00') }); t = tell();
  assert.deepEqual(t.map((x) => x.title).sort(), ['Client plan ended: Renew Test Co', 'Client plan ends in 6 days: Late Seen Co'], 'a plan first seen with 6 days left gets one bell, not three');
  assert.ok(/ended 3 days ago/.test(t.find((x) => /ended:/.test(x.title)).message));
  s = await PR.sweep({ ...pr, now: ist('2026-12-06T10:00:00') }); assert.equal(s.sent, 0, 'ended: said once');
  await CS.updatePlan(admin, A.id, { status: 'ended' }); s = await PR.sweep({ ...pr, now: ist('2026-12-20T10:00:00') }); assert.equal(tell().filter((x) => /Renew Test Co/.test(x.title)).length, 0, 'a plan the team ended is never reminded');
  assert.equal((await PR.due(admin, { now: ist('2026-12-20T10:00:00'), skip: ['onboarding'] })).filter((x) => x.clientName === 'Renew Test Co').length, 0);
  console.log('PASS reminders: each step once, a late-seen plan gets one bell, the empty report is reminded and a saved one is not, ended plans are quiet, other departments are not shown, the screen only reads');

  // ---- 5. who is told ------------------------------------------------------------------------------------------------------------------------------------------------------
  const active = await prisma.user.findFirst({ where: { status: 'Active' }, select: { id: true } });
  if (active) assert.deepEqual(await PR.recipients({ createdById: active.id }), [active.id], 'whoever started the plan, when still active');
  const admins = await PR.recipients({ createdById: 'a-person-who-left' }); assert.ok(Array.isArray(admins) && admins.length <= 10, 'else the active Admins');
  const anyAdmin = await prisma.user.findFirst({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true } });
  if (anyAdmin) assert.ok(admins.includes(anyAdmin.id) || admins.length === 10);
  console.log('PASS recipients: the person who started the plan, else the active Admins');

  console.log('plan auto count + reminders tests: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
