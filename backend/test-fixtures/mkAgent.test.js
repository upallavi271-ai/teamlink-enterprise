// AI Marketing > AI Agent (marketing/agent.js, agentPlanner.js, agentContext.js, agentTools.js): goal -> questions -> plan + preview -> ONE approval -> real steps through the existing services.
//   node backend/test-fixtures/mkAgent.test.js     (throw-away copy of prisma/sandbox.db; the internet is a stand-in; nothing real is touched, nothing is posted or sent: the bell is a test stub)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-agent-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; delete process.env.ALLOW_PRIVATE_FETCH;
const M = '../src/marketing/';
const Agent = require(`${M}agent`); const Ctx = require(`${M}agentContext`); const P = require(`${M}agentPlanner`); const Tools = require(`${M}agentTools`);
const Cfg = require(`${M}settings`); const C = require(`${M}content`); const Img = require(`${M}images`); const CS = require(`${M}clientServices`); const S = require('../src/outreach/store');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const other = { id: 'u-other', name: 'Other Marketer', role: 'MARKETING', atsRole: 'MARKETING' };
const nobody = { id: 'u-none', name: 'Plain Employee', role: 'EMPLOYEE', atsRole: 'EMPLOYEE' };
const NOW = Date.parse('2026-11-25T10:00:00+05:30');
const notices = []; const notify = async (to, m) => { notices.push({ to, ...m }); };
const page = '<html lang="en"><head><title>Agent test site</title></head><body><h1>Agent test</h1><p>Hello</p></body></html>';
const fetchFn = async (url) => ({ status: url.startsWith('https://agent.test') ? 200 : 404, url, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => page, arrayBuffer: async () => Buffer.from(page) });
const base = { actorFor: async () => admin, notify, fetchFn };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet
  Agent.config.backoff = [5, 5]; Agent.config.taskMs = 20000; Agent.config.imageMs = 20000;
  await Agent.ensure(); await C.ensure(); await Img.ensure(); await require(`${M}siteCheck`).ensure(); // (the tables of the other modules are made when first used)

  // 1. reading a goal: the six goals of the founder's list
  const kinds = { 'Promote my recruitment consultancy': ['promote', 7], 'Increase enquiries for my digital marketing services': ['enquiries', 7], 'Create a 7-day Instagram campaign': ['instagram', 7], 'Generate promotional videos for my business': ['videos', 3], 'Plan a complete marketing strategy for my new product': ['strategy', 7], "Improve my website's SEO": ['seo', 0], 'Promote TeamLink Consultants for seven days': ['promote', 7], 'Run a 10-day Facebook and LinkedIn push': ['promote', 10] };
  for (const [text, [intent, days]] of Object.entries(kinds)) { const p = P.parse(text); assert.equal(p.intent, intent, text); assert.equal(p.days, days, text); }
  assert.deepEqual(P.parse('Create a 7-day Instagram campaign').platforms, ['instagram']); assert.deepEqual(P.parse('Run a 10-day Facebook and LinkedIn push').platforms, ['facebook', 'linkedin']);
  assert.equal(P.parse('Promote my recruitment consultancy').hint, 'recruitment consultancy'); assert.equal(P.parse('Increase enquiries for my digital marketing services').hint, 'digital marketing'); assert.equal(P.parse('Generate promotional videos for my business').hint, ''); assert.equal(P.parse("Improve my website's SEO").hint, '');
  assert.deepEqual([P.parse('Promote us for 30 days').days, P.parse('Promote us for 30 days').clamped], [14, true], 'more than 14 days is cut and said');
  assert.equal(P.parse('a two week campaign').days, 14);
  console.log('PASS reading goals: the six goals of the list and "Promote ... for seven days" give the right kind, days and platforms; the industry hint comes only from "my <business>"; more than 14 days is cut and said');

  // 2. the plan: the owner's example (intro, four services, why, contact), only the saved facts, deterministic
  const ctx = { name: 'TeamLink Consultants', industry: 'Recruitment consultancy', services: ['Permanent recruitment', 'Contract staffing', 'HR consulting', 'Payroll support'], audience: 'Companies hiring in Hyderabad', locations: ['Hyderabad'], contactLine: 'Call 040 1234 5678 or WhatsApp us', website: 'https://teamlinks.in', hashtags: ['#Hiring'], colors: { primary: '#0f766e', secondary: '#134e4a' }, language: 'English', skips: [] };
  const built = P.build('Promote TeamLink Consultants for seven days', ctx, {}, NOW);
  assert.equal(built.plan.days.length, 7); assert.deepEqual(built.plan.days.map((d) => d.theme), ['intro', 'service', 'service', 'service', 'service', 'why', 'contact']);
  assert.deepEqual(built.plan.days.map((d) => d.date), ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'], 'starts tomorrow (India time), one day each');
  assert.deepEqual(built.plan.days.map((d) => d.service).filter(Boolean), ctx.services, 'one day per saved service, main ones first');
  assert.deepEqual(built.questions.map((q) => q.key), ['about'], 'only the optional about-fact is still unknown');
  for (const d of built.plan.days) {
    for (const k of ['objective', 'audience', 'contentType', 'mediaPrompt', 'label', 'headline']) assert.ok(d[k] && String(d[k]).length > 3, `day ${d.n} has ${k}`);
    assert.ok(d.metrics.length >= 4 && d.metrics.every((m) => m.label && m.how && [true, false, 'manual'].includes(m.live)), 'metrics say how and whether TeamLink can measure them');
    assert.deepEqual(Object.keys(d.texts).sort(), ['facebook', 'instagram']); assert.ok(d.texts.instagram.length <= 2200 && d.hashtags.length > 0);
    assert.ok(/040 1234 5678/.test(d.texts.instagram) === (d.theme !== 'intro' && d.theme !== 'audience' && d.theme !== 'message' && d.theme !== 'location'), `day ${d.n} (${d.theme}) carries the contact line where a call to action belongs`);
  }
  // nothing is invented: every number, price-like word and year in any caption comes from the saved facts
  const factsText = JSON.stringify(ctx); const allText = built.plan.days.map((d) => Object.values(d.texts).join(' ')).join(' ');
  for (const num of allText.match(/\d[\d ,.]*\d|\d/g) || []) assert.ok(factsText.includes(num.trim()), `the number "${num}" is in the saved facts`);
  assert.ok(!/guarantee|100%|best in|no\.\s?1|#1|result|rank|₹|rs\.?\s?\d|award|years of/i.test(allText), 'no guarantee, ranking, price, award or experience claim is made up');
  assert.deepEqual(P.build('Promote TeamLink Consultants for seven days', ctx, {}, NOW), built, 'the same facts give the same plan');
  // metrics never carry a target number
  assert.ok(!JSON.stringify(built.plan.metrics).match(/\d+\s?%|\+\d/), 'no target numbers');
  // the specific themes
  assert.ok(/^Meet TeamLink Consultants, a recruitment consultancy in Hyderabad\./.test(built.plan.days[0].texts.facebook)); assert.equal(built.plan.days[5].headline, 'Why people use a recruitment consultancy'); assert.equal(built.plan.days[6].headline, 'Talk to TeamLink Consultants');
  assert.ok(built.plan.days[0].mediaPrompt.includes('#0f766e') && /no faces of real people/.test(built.plan.days[0].mediaPrompt), 'the picture prompt uses the brand colours and never asks for real faces');
  // an X post fits 280 letters, LinkedIn only 3 tags
  const wide = P.build('Promote us on x and linkedin for 3 days', ctx, { platforms: ['x', 'linkedin'] }, NOW).plan; assert.ok(wide.days.every((d) => d.texts.x.length <= 280 && d.hashtags.length <= 5));
  console.log('PASS the plan: the founder\'s example week (introduction, four services, why, contact), one clear message a day with objective, audience, content type, caption, hashtags, picture prompt, schedule and honest metrics; only saved facts are used; same facts, same plan');

  // 3. what is missing is asked once; a skip is remembered; a service-less business cannot be planned
  const bare = P.build('Promote my business', { name: 'Bare Co', skips: [], language: 'English' }, {}, NOW);
  assert.equal(bare.plan, null); assert.deepEqual(bare.questions.filter((q) => q.required).map((q) => q.key), ['services', 'audience', 'contactLine']);
  assert.deepEqual(bare.questions.filter((q) => q.required).map((q) => q.skippable), [false, true, true], 'services can never be skipped');
  const skipped = P.build('Promote my business', { name: 'Bare Co', services: ['Tax filing'], skips: ['audience', 'contactLine'], language: 'English' }, {}, NOW);
  assert.ok(skipped.plan && skipped.plan.gaps.some((g) => /Who you want to reach not saved/.test(g)) && skipped.plan.gaps.some((g) => /How people reach you/.test(g)), 'a skipped fact becomes a gap in the plan, not an invention');
  assert.ok(/Send us a message/.test(skipped.plan.days[6].texts.instagram) && !/\d{3,}/.test(skipped.plan.days[6].texts.instagram), 'no contact line: "Send us a message", no invented number');
  const hosp = P.build('Promote my clinic', { name: 'Care Clinic', industry: 'Dental clinic', services: ['Teeth cleaning'], audience: 'Families nearby', contactLine: 'Call 99999 11111', language: 'Telugu', skips: [] }, {}, NOW).plan;
  assert.ok(hosp.healthcare && hosp.gaps.some((g) => /doctor/.test(g)) && hosp.assumptions.some((a) => /Telugu/.test(a)), 'healthcare needs a medical reviewer; a non-English business is told captions are English');
  const seo = P.build("Improve my website's SEO", { name: 'Site Co', skips: [] }, {}, NOW); assert.deepEqual(seo.questions.filter((q) => q.required).map((q) => q.key), ['website']);
  const seoPlan = P.build("Improve my website's SEO", { name: 'Site Co', website: 'https://agent.test', skips: [] }, {}, NOW).plan; assert.deepEqual(P.taskSpecs(seoPlan).map((t) => t.tool), ['seo.sitecheck', 'seo.blogplan', 'manual.note']);
  const strat = P.build('Plan a complete marketing strategy for my new product', ctx, {}, NOW).plan; assert.ok(strat.strategy && strat.strategy.length === 6 && strat.days.length === 7);
  const vids = P.build('Generate promotional videos for my business', ctx, {}, NOW).plan; assert.deepEqual([vids.days.length, vids.days[0].kind, vids.days[1].date], [3, 'video', '2026-11-28']); assert.ok(/Scene 1 \(hook\)/.test(vids.days[0].mediaPrompt));
  assert.ok(P.taskSpecs(vids).some((t) => t.tool === 'manual.video'));
  const specs = P.taskSpecs(built.plan); assert.equal(specs.length, 28); assert.deepEqual(specs.slice(0, 4).map((t) => t.tool), ['content.draft', 'image.banner', 'approval.request', 'manual.post']); assert.deepEqual(specs[2].deps, [1]); assert.deepEqual(specs[3].deps, [3]);
  assert.equal(P.taskSpecs(P.build('Promote us', ctx, { creative: 'none' }, NOW).plan).filter((t) => t.tool.startsWith('image.')).length, 0);
  console.log('PASS asking: required facts are asked once (services never skippable), a skip is remembered and shown as a gap, healthcare / language notes, SEO needs a website, strategy has six sections, videos have scenes and a person\'s step, steps are draft -> picture -> approval -> person');

  // 4. the business context: the brand kit for our own company, typed facts win, a client's personal contact is never taken
  const bc = Cfg.cleanBrand({ brandName: 'TeamLink Consultants', about: 'We help companies hire.', audience: 'Hiring managers', website: 'https://teamlinks.in', contact: 'Call 040 1234 5678', tagline: 'People first', colors: { primary: '#0f766e' }, hashtags: '#Hiring', language: 'English' });
  assert.ok(!bc.error, bc.error); await Cfg.saveBrand(bc.value, admin);
  let own = await Ctx.resolve(admin, 'own');
  assert.deepEqual([own.name, own.context.audience, own.context.contactLine, own.context.website, own.sources.audience, own.sources.name], ['TeamLink Consultants', 'Hiring managers', 'Call 040 1234 5678', 'https://teamlinks.in', 'the brand kit', 'the brand kit']);
  assert.ok(!own.context.services.length && !own.sources.services, 'no services are invented: they are asked');
  const sv = await Ctx.save(admin, 'own', { services: 'Permanent recruitment\nContract staffing; HR consulting', locations: 'Hyderabad, Pune', audience: 'Companies hiring in Hyderabad' });
  assert.deepEqual(sv.context.services, ['Permanent recruitment', 'Contract staffing', 'HR consulting']); assert.equal(sv.context.audience, 'Companies hiring in Hyderabad', 'typed facts win over the brand kit'); assert.equal(sv.sources.audience, 'typed by Test Admin'); assert.equal(sv.sources.about, 'the brand kit');
  assert.ok((await Ctx.save(nobody, 'own', { about: 'x' })).error, 'a login that may not use AI Marketing cannot save facts');
  assert.ok((await Ctx.save(admin, 'own', { website: 'not a web address with spaces' })).error); assert.ok((await Ctx.save(admin, 'own', { colors: { primary: 'red' } })).error);
  assert.deepEqual((await Ctx.save(admin, 'own', { website: 'teamlinks.in' })).context.website, 'https://teamlinks.in', 'https:// is added');
  // a client: its industry comes from its plan, its personal contact never does
  await CS.createPlan(admin, { clientName: 'Context Test Clinic', plan: 'basic', months: 3, startDate: '2026-11-01', industry: 'Dental clinic', contactName: 'Dr Secret Person', contactPhone: '9876543210' });
  const cl = await Ctx.resolve(admin, 'Context Test Clinic');
  assert.deepEqual([cl.key, cl.name, cl.context.industry, cl.sources.industry], ['c:context-test-clinic', 'Context Test Clinic', 'Dental clinic', 'the client plan']); assert.ok(!JSON.stringify(cl).includes('9876543210') && !JSON.stringify(cl).includes('Secret'), 'the client\'s personal contact is never copied');
  assert.ok(!cl.context.contactLine, 'the line captions use is typed by a person, not taken from the client plan');
  const list = await Ctx.businesses(admin); assert.ok(list[0].own && list.some((b) => b.key === 'c:context-test-clinic' && b.name === 'Context Test Clinic'), 'the picker lists our company and the clients');
  await Ctx.save(admin, 'c:context-test-clinic', { services: ['Check-ups'], skips: ['audience'] }); assert.deepEqual((await Ctx.resolve(admin, 'c:context-test-clinic')).context.skips, ['audience']);
  await Ctx.save(admin, 'c:context-test-clinic', { audience: 'Families nearby' }); assert.deepEqual((await Ctx.resolve(admin, 'c:context-test-clinic')).context.skips, [], 'a fact that is then given is no longer skipped');
  console.log('PASS business context: our own company starts from the brand kit, typed facts win and say who typed them, nothing is invented, a client\'s name and industry come from its plan but its personal contact never does, skips are remembered');

  // 5. the conversation: goal -> questions -> answer -> plan, then NOTHING runs until the button
  let r = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for seven days', business: 'own' }, { now: NOW });
  const id = r.run.id; // (the facts saved above already hold services: the plan is ready at once)
  assert.equal(r.run.status, 'preview'); assert.equal(r.run.plan.days.length, 7); assert.equal(r.tasks.length, 28); assert.ok(r.tasks.every((t) => t.status === 'planned'));
  assert.ok(r.messages[0].role === 'user' && /Promote TeamLink/.test(r.messages[0].text) && r.messages[1].role === 'agent' && /Nothing happens until you press "Approve and run"/.test(r.messages[1].text) && /brand kit|business name/i.test(r.messages[1].text), 'the agent says what it understood and what it already knows');
  r = await Agent.talk(admin, id, 'yes, approve it and run now'); assert.equal(r.run.status, 'preview', 'typed words never approve'); assert.ok(/never start from typed words/.test(r.messages[r.messages.length - 1].text));
  r = await Agent.talk(admin, id, 'make it 5 days'); assert.equal(r.run.plan.days.length, 5, 'a plain change in words re-plans'); r = await Agent.talk(admin, id, 'only instagram'); assert.deepEqual(r.run.plan.days[0].platforms, ['instagram']);
  r = await Agent.changePlan(admin, id, { days: 3, platforms: ['instagram', 'facebook'], creative: 'banner', time: '09:30' }, { now: NOW }); assert.deepEqual([r.run.plan.days.length, r.run.plan.days[0].time, r.tasks.length], [3, '09:30', 12]);
  const asked = (await Agent.startRun(admin, { goal: 'Promote my business', business: 'Needs Info Co' }, { now: NOW }));
  assert.equal(asked.run.status, 'needs_info'); assert.ok(asked.run.questions.some((q) => q.key === 'services' && q.required)); assert.equal(asked.tasks.length, 0); assert.ok(/I need \d+ things? from you/.test(asked.messages[1].text));
  assert.ok((await Agent.approve(admin, asked.run.id)).error, 'no plan, no approval');
  let a2 = await Agent.talk(admin, asked.run.id, 'x'); assert.equal(a2.run.status, 'needs_info');
  a2 = await Agent.answer(admin, asked.run.id, { answers: { services: 'Tax filing\nAudit', audience: 'Small shops', contactLine: 'Call 90000 00000' } }, { now: NOW }); assert.equal(a2.run.status, 'preview'); assert.equal(a2.run.plan.days.length, 7);
  const again = await Agent.startRun(admin, { goal: 'Create a 7-day Instagram campaign', business: 'c:needs-info-co' }, { now: NOW }); assert.equal(again.run.status, 'preview', 'the facts were saved: the second goal for the same business asks nothing'); assert.equal(again.run.businessName, 'Needs Info Co');
  assert.ok((await Agent.startRun(admin, { goal: 'hi', business: 'own' })).error && (await Agent.startRun(nobody, { goal: 'Promote my business', business: 'own' })).status === 403);
  const day2 = await Agent.editDay(admin, id, 2, { texts: { instagram: 'We guarantee 100% results! Call 040 1234 5678' }, time: '18:15', date: '2026-11-27' });
  assert.ok(day2.run.plan.days[1].flags.some((f) => f.level === 'stop') && day2.run.plan.days[1].label.endsWith('18:15 IST'), 'an edited caption is checked again for guarantees'); assert.ok((await Agent.editDay(admin, id, 2, { texts: { instagram: 'x'.repeat(2300) } })).error && (await Agent.editDay(admin, id, 9, {})).status === 404 && (await Agent.editDay(admin, id, 2, { time: '25:00' })).error);
  assert.ok(day2.preflight.warnings.some((w) => /wording check says/.test(w)), 'the preview warns about the flagged wording');
  await Agent.editDay(admin, id, 2, { texts: { instagram: 'Contract staffing with TeamLink Consultants. Call 040 1234 5678' } });
  console.log('PASS the conversation: understood + known facts, questions asked, answers saved (the second goal asks nothing), plain changes re-plan, typed "yes" never approves, edited captions are re-checked, a short or forbidden request is refused');

  // 6. approve -> the steps run in the background through the real services; nothing is posted or sent
  const before = { content: S.num((await S.q('SELECT COUNT(*) AS n FROM "OmniMkContent"'))[0].n), image: S.num((await S.q('SELECT COUNT(*) AS n FROM "OmniMkImage"'))[0].n) };
  assert.ok((await Agent.approve(other, id)).error, 'somebody else\'s plan cannot be approved'); assert.equal((await Agent.approve(nobody, id)).status, 404, 'a stranger does not even learn that the run exists');
  r = await Agent.approve(admin, id, base); assert.equal(r.run.status, 'running'); assert.equal(r.run.approvedByName, 'Test Admin');
  assert.ok((await Agent.answer(admin, id, { answers: { about: 'x' } })).status === 409 && (await Agent.changePlan(admin, id, { days: 4 })).status === 409, 'an approved plan cannot be changed');
  await Agent.drain(); r = await Agent.detail(admin, id);
  assert.equal(r.run.status, 'attention', 'the person\'s steps (post it) are still waiting');
  const by = (t) => r.tasks.filter((x) => x.tool === t);
  assert.deepEqual([by('content.draft').length, by('image.banner').length, by('approval.request').length, by('manual.post').length], [3, 3, 3, 3]);
  assert.ok(by('content.draft').every((t) => t.status === 'done' && t.refs[0].kind === 'content') && by('image.banner').every((t) => t.status === 'done') && by('approval.request').every((t) => t.status === 'done'), r.tasks.filter((t) => t.status === 'failed').map((t) => t.error).join('; '));
  assert.ok(by('manual.post').every((t) => t.status === 'waiting' && t.scheduledAt), 'posting waits for a person and keeps its time');
  assert.deepEqual([S.num((await S.q('SELECT COUNT(*) AS n FROM "OmniMkContent"'))[0].n) - before.content, S.num((await S.q('SELECT COUNT(*) AS n FROM "OmniMkImage"'))[0].n) - before.image], [3, 3], 'three real drafts in AI Content and three real banners in AI Images');
  const item = by('content.draft')[1]; const row = (await S.q('SELECT * FROM "OmniMkContent" WHERE id = ?', item.refs[0].id))[0];
  assert.deepEqual([row.status, JSON.parse(row.channels), JSON.parse(row.meta).provider], ['waiting', ['instagram', 'facebook'], 'plain code'], 'the draft was SENT FOR APPROVAL (waiting), written by plain code'); assert.ok(/040 1234 5678/.test(JSON.parse(row.texts).instagram));
  assert.equal(by('approval.request')[0].status, 'done'); assert.ok(/waiting|approval/i.test(by('approval.request')[0].summary));
  assert.ok(r.events.some((e) => e.kind === 'approved') && r.events.filter((e) => e.kind === 'task_done').length === 9 && r.events.every((e) => !/\bpassword|secret\b/i.test(e.text)), 'the history has the approval and each step');
  assert.ok(r.messages[r.messages.length - 1].text.includes('Nothing was posted, sent, called or spent by the agent.') && /3 drafts in AI Content and 3 pictures in AI Images/.test(r.messages[r.messages.length - 1].text), 'the summary says only what really happened');
  assert.equal(r.live.numbers.approval.waiting, 6); assert.equal(r.live.numbers.outward, 0);
  assert.ok(notices.some((n) => /AI Agent needs you/.test(n.title) && n.to[0] === admin.id), 'the person who gave the goal is told');
  console.log('PASS running: after the approval three real drafts (sent for approval) and three real banners were made by the existing services, as the approver; posting waits for a person; the summary and history say only what happened; the person is told');

  // 7. the person's step can only be marked done after the content is APPROVED
  const post1 = by('manual.post')[0];
  let m = await Agent.markManual(admin, post1.id, { action: 'done' }); assert.equal(m.code, 'not_approved'); assert.ok(m.error && /Only approved content is posted/.test(m.error), 'not approved yet: it cannot be marked as posted');
  const draftIds = by('content.draft').map((t) => t.refs[0].id); const picIds = by('image.banner').map((t) => t.refs[0].id);
  assert.ok(!(await C.approve(admin, draftIds[0])).error, 'the team approves the draft (an Admin may approve their own while the Admin switch allows)'); assert.ok(!(await Img.approve(admin, picIds[0])).error);
  m = await Agent.markManual(admin, post1.id, { action: 'done', url: 'https://facebook.com/x/posts/1', note: 'posted by hand' }); assert.ok(!m.error, m.error);
  assert.ok((await Agent.markManual(admin, by('manual.post')[1].id, { action: 'done', url: 'javascript:alert(1)' })).error, 'only web addresses'); assert.ok((await Agent.markManual(admin, post1.id, { action: 'done' })).error, 'a step is marked once');
  assert.ok((await Agent.markManual(admin, by('content.draft')[0].id, {})).error, 'a step the agent runs is not a person\'s step');
  r = await Agent.detail(admin, id); assert.ok(/Posted: 1 of 3/.test(r.live.lines.join(' ')) && /Approval right now: 2 approved, 4 waiting/.test(r.live.lines.join(' ')), r.live.lines.join(' | '));
  r = await Agent.addResult(admin, id, { label: 'Enquiries received', value: '5', note: 'WhatsApp' }); assert.ok(/Enquiries received: 5 \(Test Admin\)/.test(r.live.lines.join(' ')), 'a typed result is shown with who typed it');
  assert.ok((await Agent.addResult(admin, id, { label: 'Enquiries', value: 'lots' })).error && (await Agent.addResult(admin, id, { label: '', value: '3' })).error);
  console.log('PASS the person\'s step: "posted" is refused until the draft and picture are approved, it takes only web links, results typed in show with the typist\'s name');

  // 8. cancel: waiting steps are cancelled, finished ones are kept and listed; the run then finishes
  const post2 = by('manual.post')[1]; r = await Agent.cancelTask(admin, post2.id); assert.equal(r.tasks.find((t) => t.id === post2.id).status, 'cancelled'); assert.ok((await Agent.cancelTask(admin, post2.id)).error);
  r = await Agent.cancelRun(admin, id, 'plan changed'); assert.equal(r.run.status, 'cancelled'); assert.ok(r.tasks.filter((t) => t.status === 'waiting').length === 0 && r.tasks.filter((t) => t.status === 'done').length >= 9);
  assert.ok(r.events.some((e) => e.kind === 'cancelled' && /stay in AI Content/.test(e.text)), 'it says what was kept'); assert.ok((await Agent.cancelRun(admin, id)).error && (await Agent.approve(admin, id)).error);
  assert.ok((await Agent.cancelRun(other, id)).error, 'somebody else cannot cancel it'); assert.equal((await Agent.detail(other, id)).status, 404, 'and cannot even see it');
  console.log('PASS cancel: a waiting step and then the whole run are cancelled, finished work is kept and listed, strangers cannot see or touch a run');

  // 9. failure, automatic retry for busy errors, manual retry, skipped dependants
  const flaky = (failTimes, err) => { let n = 0; return { ...require(`${M}content`), create: async (...a) => { n += 1; if (n <= failTimes) return err; return require(`${M}content`).create(...a); }, calls: () => n }; };
  const g1 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 2 days', business: 'own', params: { creative: 'none' } }, { now: NOW });
  // a retryable error (code busy) is tried again by itself
  const svcBusy = { C: flaky(1, { error: 'busy', code: 'busy', status: 409 }) };
  await Agent.approve(admin, g1.run.id, { ...base, svc: svcBusy }); await Agent.drain(); r = await Agent.detail(admin, g1.run.id);
  assert.equal(r.tasks.filter((t) => t.tool === 'content.draft' && t.status === 'done').length, 2, 'a busy error is retried by itself and then works'); assert.equal(r.tasks.find((t) => t.tool === 'content.draft').attempts, 2); assert.ok(r.events.some((e) => e.kind === 'task_retry'));
  const g2 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 2 days', business: 'own', params: { creative: 'none' } }, { now: NOW });
  const svcDown = { C: flaky(99, { error: 'The database is not answering.', status: 500 }) };
  await Agent.approve(admin, g2.run.id, { ...base, svc: svcDown }); await Agent.drain(); r = await Agent.detail(admin, g2.run.id);
  const failed = r.tasks.filter((t) => t.status === 'failed'); assert.equal(failed.length, 2); assert.ok(failed.every((t) => /database is not answering/.test(t.error) && t.attempts === 1), 'a normal failure is not retried by itself');
  assert.ok(r.tasks.filter((t) => t.tool === 'approval.request').every((t) => t.status === 'skipped') && r.tasks.filter((t) => t.tool === 'manual.post').every((t) => t.status === 'waiting'), 'steps that need a failed step are skipped');
  assert.equal(r.run.status, 'attention'); assert.ok(r.live.lines[0].includes('2 failed')); assert.ok((await Agent.dashboard(admin)).failures.length >= 2);
  r = await Agent.retryTask(admin, failed[0].id, { ...base, svc: {} }); await Agent.drain(); r = await Agent.detail(admin, g2.run.id);
  assert.equal(r.tasks.find((t) => t.id === failed[0].id).status, 'done'); assert.equal(r.tasks.find((t) => t.id === failed[0].id).attempts, 2);
  assert.equal(r.tasks.filter((t) => t.tool === 'approval.request' && t.status === 'done').length, 1, 'the skipped step that needed it ran after the retry'); assert.ok((await Agent.retryTask(admin, failed[0].id)).error, 'only a failed step can be retried');
  console.log('PASS failures: a busy error is retried twice by itself, a normal failure waits for a person (and the steps that need it are skipped), Retry runs it and the skipped ones again, the dashboard lists failures');

  // 10. the safety rule: a step that reaches outside TeamLink never runs without its OWN approval
  const g3 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { creative: 'none' } }, { now: NOW });
  let sent = 0; Tools.TOOLS['test.outward'] = { label: 'Send to the world', module: 'Test', page: '', risk: 'outward', auto: true, cost: { kind: 'free', unit: 'x', rupees: 0, note: '' }, does: () => 'x', build: () => ({}), async run() { sent += 1; return { summary: 'sent', refs: [], data: {} }; } };
  await S.run(`INSERT INTO "OmniMkAgentTask" (id, runId, n, day, tool, title, status, deps, input, attempts, createdAt, updatedAt) VALUES ('t-out', ?, 99, NULL, 'test.outward', 'Publish to the world', 'planned', '[]', '{}', 0, ?, ?)`, g3.run.id, Date.now(), Date.now());
  await Agent.approve(admin, g3.run.id, base); await Agent.drain(); r = await Agent.detail(admin, g3.run.id);
  assert.equal(sent, 0, 'the plan\'s approval does NOT cover an outward step'); assert.equal(r.tasks.find((t) => t.id === 't-out').status, 'awaiting_approval'); assert.equal(r.run.status, 'attention');
  assert.equal((await Agent.dashboard(admin)).pendingApprovals.outward.length, 1); assert.equal((await Agent.markManual(admin, 't-out', {})).status, 409);
  await Agent.approveTask(other, 't-out'); assert.equal(sent, 0, 'somebody else cannot approve it'); await Agent.approveTask(admin, 't-out', {}, base); await Agent.drain();
  assert.equal(sent, 1); r = await Agent.detail(admin, g3.run.id); assert.equal(r.tasks.find((t) => t.id === 't-out').status, 'done'); assert.ok(r.events.some((e) => e.kind === 'task_approved') && /1 outward action went outside TeamLink, each with its own approval/.test(r.live.lines.join(' ')));
  delete Tools.TOOLS['test.outward'];
  console.log('PASS the outward-step rule: the plan\'s approval does not cover a step that reaches outside TeamLink; it waits for its own approval by the owner of the run and only then runs once');

  // 11. permission lost, restart recovery, reminders
  const g4 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { creative: 'none' } }, { now: NOW });
  await Agent.approve(admin, g4.run.id, { ...base, actorFor: async () => null }); await Agent.drain(); r = await Agent.detail(admin, g4.run.id);
  assert.ok(r.tasks.filter((t) => t.tool === 'content.draft').every((t) => t.status === 'failed' && /can no longer use AI Marketing/.test(t.error)), 'a person who lost the right stops the steps');
  const g5 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { creative: 'none' } }, { now: NOW });
  await Agent.approve(admin, g5.run.id, base); await Agent.drain();
  const t5 = (await Agent.detail(admin, g5.run.id)).tasks.find((t) => t.tool === 'content.draft'); await S.run(`UPDATE "OmniMkAgentTask" SET status = 'running' WHERE id = ?`, t5.id); await S.run(`UPDATE "OmniMkAgentRun" SET status = 'running' WHERE id = ?`, g5.run.id);
  const rec = await Agent.recover(base); await Agent.drain(); assert.equal(rec.interrupted, 1);
  r = await Agent.detail(admin, g5.run.id); const t5b = r.tasks.find((t) => t.id === t5.id); assert.ok(t5b.status === 'failed' && t5b.errorCode === 'interrupted' && /Press Retry only if nothing was made|press Retry/i.test(t5b.error), 'an interrupted step is never silently run twice'); assert.equal(r.tasks.filter((t) => t.tool === 'content.draft').length, 1);
  const g6 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { creative: 'none', startDate: '2026-11-26', time: '10:00' } }, { now: NOW });
  await Agent.approve(admin, g6.run.id, base); await Agent.drain(); notices.length = 0;
  let sw = await Agent.sweep({ now: Date.parse('2026-11-26T09:00:00+05:30'), notify, force: true }); assert.equal(sw.reminded, 0, 'not yet time'); sw = await Agent.sweep({ now: Date.parse('2026-11-26T10:30:00+05:30'), notify, force: true }); assert.ok(sw.reminded >= 1, 'every due step of an approved, running run is reminded'); assert.ok((await S.q(`SELECT remindedAt FROM "OmniMkAgentTask" WHERE runId = ? AND tool = 'manual.post'`, g6.run.id))[0].remindedAt, 'the step of this run was reminded');
  assert.ok(/Time for a step/.test(notices[0].title) && notices[0].to[0] === admin.id); sw = await Agent.sweep({ now: Date.parse('2026-11-26T11:30:00+05:30'), notify, force: true }); assert.equal(sw.reminded, 0, 'one reminder only');
  assert.deepEqual(await Agent.sweep({ notify }), { sandbox: true }, 'the timer does nothing in the sandbox');
  console.log('PASS keeping time: a person who lost the right stops the steps, an interrupted step is marked "press Retry" (never run twice), one bell when a "post it" step is due, nothing runs in the sandbox timer');

  // 12. SEO goal through the real website check (stand-in internet) and blog planner, the AI picture path, and the dashboard
  await Ctx.save(admin, 'c:seo-test-co', { name: 'SEO Test Co', website: 'agent.test', services: ['Heart check-ups'], industry: 'Hospital', locations: ['Pune'] });
  const s1 = await Agent.startRun(admin, { goal: "Improve my website's SEO", business: 'c:seo-test-co' }, { now: NOW });
  assert.equal(s1.run.status, 'preview'); assert.deepEqual(s1.tasks.map((t) => t.tool), ['seo.sitecheck', 'seo.blogplan', 'manual.note']); assert.ok(/nothing on the website is changed|Nothing on the website is changed/i.test(JSON.stringify(s1.run.plan.assumptions)));
  await Agent.approve(admin, s1.run.id, base); await Agent.drain(); r = await Agent.detail(admin, s1.run.id);
  assert.deepEqual(r.tasks.map((t) => t.status), ['done', 'done', 'waiting'], r.tasks.map((t) => t.error).join('; ')); assert.ok(/Website check saved: \d+\/100/.test(r.tasks[0].summary) && /Blog plan saved: \d+ briefs?/.test(r.tasks[1].summary)); assert.ok(Number.isInteger(r.live.numbers.siteScore) && r.live.numbers.blogBriefs > 0);
  assert.ok((await S.q(`SELECT 1 FROM "OmniMkSiteCheck" WHERE clientName = 'SEO Test Co'`)).length === 1, 'a real website check was saved for the client');
  const i1 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { creative: 'ai' } }, { now: NOW });
  assert.equal(i1.preflight.blockers.length, 0, i1.preflight.blockers.join()); await Agent.approve(admin, i1.run.id, base); await Agent.drain(); r = await Agent.detail(admin, i1.run.id);
  assert.ok(r.tasks.find((t) => t.tool === 'image.ai').status === 'done' && /test sample/.test(r.tasks.find((t) => t.tool === 'image.ai').summary), r.tasks.map((t) => t.error).join('; '));
  const dash = await Agent.dashboard(admin);
  assert.ok(dash.counts.runsTotal >= 8 && dash.counts.doneMonth > 10 && dash.counts.tasksFailed >= 1 && dash.counts.needYou >= 1); assert.equal(dash.usage.totalRupees, 0); assert.ok(/₹0/.test(dash.usage.note)); assert.ok(dash.usage.month.every((u) => u.rupees === 0 && u.kind !== 'paid')); assert.ok(dash.usage.month.some((u) => u.tool === 'image.ai' && u.kind === 'free-tier'));
  assert.ok(dash.pendingApprovals.items.length >= 1 && dash.pendingApprovals.items.every((x) => x.label && x.page), 'items waiting for approval are listed'); assert.ok(dash.recent.length > 0 && dash.performance.length > 0 && dash.performance[0].lines.length > 2);
  assert.equal(dash.usage.aiModelCalls, 0, 'the planner makes no AI model call');
  const mine = await Agent.dashboard(other); assert.equal(mine.counts.runsTotal, 0, 'a login sees only its own runs'); assert.equal((await Agent.listRuns(other)).runs.length, 0); assert.ok((await Agent.listRuns(admin)).runs.length >= 8);
  const bv = await Agent.businessView(admin, 'own'); assert.ok(bv.history.length >= 3 && bv.history[0].goal && bv.fields.length > 10 && bv.canEdit, 'the Business tab shows the saved facts and the previous goals');
  assert.ok((await Agent.discard(admin, asked.run.id)).ok && !(await Agent.listRuns(admin)).runs.some((x) => x.id === asked.run.id));
  console.log('PASS SEO and pictures: the website check (stand-in internet) and blog plan were really saved, an AI picture is made in the test sandbox; the dashboard adds up real counts and a ₹0 cost with the free-tier use shown, and a login sees only its own runs');

  // 14. PHASE 2 planning: the posting and client steps appear only when asked for, and only for what TeamLink can post to
  const ps = (params, bk = 'own', text = 'Promote us for 2 days') => { const pl = P.build(text, ctx, params, NOW).plan; pl.businessKey = bk; return P.taskSpecs(pl); };
  const tools = (sp) => sp.map((t) => t.tool);
  assert.deepEqual(tools(ps({ publish: 'agent' })).slice(0, 5), ['content.draft', 'image.banner', 'approval.request', 'social.post', 'content.draft'], 'agent posting: a social.post step replaces "post by hand"');
  assert.deepEqual(ps({ publish: 'agent' })[3].deps, [3, 2], 'the post needs the approval step and the picture');
  assert.equal(tools(ps({ publish: 'manual' })).filter((x) => x === 'social.post').length, 0, 'by hand stays the default'); assert.equal(tools(ps({})).filter((x) => x === 'social.post').length, 0);
  assert.equal(tools(ps({ publish: 'agent', creative: 'none' })).filter((x) => x === 'social.post').length, 0, 'no picture, nothing to post: by hand');
  assert.deepEqual(tools(ps({ publish: 'agent', platforms: ['instagram', 'linkedin'] })).slice(2, 6), ['approval.request', 'social.post', 'manual.post', 'content.draft'], 'LinkedIn cannot be posted from TeamLink: that part stays by hand');
  assert.deepEqual(tools(ps({ publish: 'agent', platforms: ['linkedin'] })).slice(2, 4), ['approval.request', 'manual.post']);
  assert.deepEqual(tools(ps({ approver: 'client' }, 'c:acme')).slice(0, 4), ['content.draft', 'image.banner', 'client.review', 'manual.post'], 'a client business: the client decides on the picture'); assert.deepEqual(ps({ approver: 'client' }, 'c:acme')[2].deps, [1, 2]);
  assert.equal(tools(ps({ approver: 'client' }, 'own')).filter((x) => x === 'client.review').length, 0, 'our own company has no client to ask'); assert.equal(tools(ps({ approver: 'client', creative: 'none' }, 'c:acme')).filter((x) => x === 'client.review').length, 0);
  assert.deepEqual([P.paramsFor(P.parse('x'), {}).publish, P.paramsFor(P.parse('x'), {}).approver, P.paramsFor(P.parse('x'), { publish: 'agent', approver: 'client' }).publish, P.paramsFor(P.parse('x'), { publish: 'yes please' }).publish], ['manual', 'team', 'agent', 'manual'], 'anything but an exact choice falls back to the safe one');
  const cat2 = Tools.catalog().filter((t) => t.risk === 'outward').map((t) => t.id).sort(); assert.deepEqual(cat2, ['client.review', 'social.post']);
  console.log('PASS phase 2 planning: posting and client steps only when chosen, only for Facebook / Instagram / X (LinkedIn stays by hand), never without a picture, and any odd choice falls back to the safe one');

  // 15. social.post: waits for the picture to be approved, for the person's accounts, and for its time; posts as that person, once per account
  const CLOCK0 = Date.parse('2026-11-25T12:00:00+05:30'); const CLOCK1 = Date.parse('2026-11-26T10:05:00+05:30');
  Agent.config.clock = () => CLOCK0;
  const posted = []; const actors = []; let prior = []; let failIg = false;
  const accounts = [{ id: 'fb1', platform: 'facebook', name: 'Test Page', status: 'Connected' }, { id: 'ig1', platform: 'instagram', name: 'test_ig', status: 'Connected' }, { id: 'li1', platform: 'linkedin', name: 'Not postable' }];
  let allowed = true;
  const postSvc = { accounts: async () => ({ allowed, accounts }), Post: { posts: async () => ({ posts: prior }), postItem: async (u, itemId, b, base) => { posted.push({ u: u.id, itemId, ...b, base }); const res = b.accountIds.map((id) => { const a = accounts.find((x) => x.id === id); const ok = !(failIg && id === 'ig1'); return { accountId: id, platform: a.platform, name: a.name, ok, url: ok ? `https://social.test/${id}` : '', error: ok ? '' : 'The Instagram sign-in has expired.' }; }); return { ok: 'x', results: res, posted: res.some((x) => x.ok) }; } } };
  const pbase = { ...base, svc: postSvc, actorFor: async (run, uid) => { actors.push(uid || null); return admin; } };
  const pg = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 2 days', business: 'own', params: { publish: 'agent', platforms: ['instagram', 'facebook'] } }, { ...pbase, now: NOW });
  assert.equal(pg.run.plan.params.publish, 'agent'); assert.ok(pg.preflight.warnings.some((w) => /nothing goes public until you approve each post/.test(w)), 'the preview says nothing goes public without each approval');
  assert.equal(pg.tasks.filter((t) => t.tool === 'social.post').length, 2); assert.ok(pg.tasks.find((t) => t.tool === 'social.post').outward && pg.tasks.find((t) => t.tool === 'social.post').scheduledAt);
  await Agent.approve(admin, pg.run.id, pbase); await Agent.drain(); r = await Agent.detail(admin, pg.run.id);
  const posts = r.tasks.filter((t) => t.tool === 'social.post');
  assert.deepEqual(posts.map((t) => t.status), ['awaiting_approval', 'awaiting_approval'], 'the plan\'s approval does not post anything'); assert.equal(posted.length, 0); assert.equal(r.run.status, 'attention');
  let pr = await Agent.prepareTask(admin, posts[0].id, pbase); assert.equal(pr.ready, false); assert.ok(/The picture is still waiting for approval/.test(pr.reason), pr.reason);
  let ap = await Agent.approveTask(admin, posts[0].id, { accountIds: ['fb1'] }, { ...pbase, base: 'https://tl.test' }); assert.equal(ap.code, 'not_ready', 'an unapproved picture cannot be approved for posting');
  const pics = r.tasks.filter((t) => t.tool === 'image.banner').map((t) => t.refs[0].id); assert.ok(!(await Img.approve(admin, pics[0])).error);
  pr = await Agent.prepareTask(admin, posts[0].id, pbase); assert.equal(pr.ready, true); assert.deepEqual(pr.accounts.map((a) => a.id), ['fb1', 'ig1'], 'only the connected accounts of the platforms in the plan, not LinkedIn');
  assert.ok(pr.captions.instagram && pr.captions.facebook && pr.media.status === 'approved' && /Fri|Nov/.test(pr.scheduledLabel), 'the dialog shows the exact captions, the picture and the time');
  assert.ok((await Agent.approveTask(admin, posts[0].id, {}, { ...pbase, base: 'https://tl.test' })).error, 'no account picked'); assert.ok((await Agent.approveTask(admin, posts[0].id, { accountIds: ['li1'] }, { ...pbase, base: 'https://tl.test' })).error, 'LinkedIn is not one of the choices');
  assert.ok((await Agent.approveTask(admin, posts[0].id, { accountIds: ['fb1'] }, { ...pbase, base: 'http://tl.test' })).error, 'Facebook needs the https site address');
  assert.ok((await Agent.approveTask(other, posts[0].id, { accountIds: ['fb1'] }, { ...pbase, base: 'https://tl.test' })).error, 'somebody else cannot approve it'); assert.equal(posted.length, 0);
  allowed = false; assert.equal((await Agent.approveTask(admin, posts[0].id, { accountIds: ['fb1'] }, { ...pbase, base: 'https://tl.test' })).code, 'not_ready', 'posting switched off by the Admin'); allowed = true;
  ap = await Agent.approveTask(admin, posts[0].id, { accountIds: ['fb1', 'ig1'] }, { ...pbase, base: 'https://tl.test' }); assert.ok(!ap.error, ap.error); await Agent.drain();
  r = await Agent.detail(admin, pg.run.id); const p0 = r.tasks.find((t) => t.id === posts[0].id);
  assert.equal(p0.status, 'queued', 'approved, but its time has not come: it waits'); assert.equal(posted.length, 0); assert.ok(r.events.some((e) => e.kind === 'task_approved' && /Facebook: Test Page and Instagram: test_ig/.test(e.text) && /scheduled time/.test(e.text)));
  assert.equal(r.run.status, 'running', 'the run keeps waiting for the scheduled post'); assert.ok(!JSON.stringify(r).includes('https://tl.test'), 'the site address is not shown back');
  Agent.config.clock = () => CLOCK1; await Agent.sweep({ ...pbase, force: true, notify, now: CLOCK1 }); await Agent.drain(); r = await Agent.detail(admin, pg.run.id);
  assert.equal(r.tasks.find((t) => t.id === posts[0].id).status, 'done', JSON.stringify(r.tasks.find((t) => t.id === posts[0].id).error));
  assert.deepEqual(posted.map((x) => x.accountIds), [['ig1'], ['fb1']], 'one call per platform'); assert.ok(posted.every((x) => x.confirm === true && x.base === 'https://tl.test' && x.u === admin.id)); assert.deepEqual([posted[0].caption, posted[1].caption], [r.run.plan.days[0].texts.instagram, r.run.plan.days[0].texts.facebook], 'each platform gets its own caption of that day');
  assert.deepEqual(actors.slice(-2).filter(Boolean), [admin.id], 'the post ran as the person who approved that step'); assert.ok(r.tasks.find((t) => t.id === posts[0].id).refs.some((x) => x.kind === 'link' && /social\.test/.test(x.id)));
  assert.ok(/Posted: 1 of 2 posting steps \(1 by the agent after your approval of each post/.test(r.live.lines.join(' ')) && /1 outward action went outside TeamLink, each with its own approval/.test(r.live.lines.join(' ')), r.live.lines.join(' | '));
  assert.equal(r.tasks.find((t) => t.id === posts[1].id).status, 'awaiting_approval', 'the other day is still waiting for its own approval');
  // a failure: retry needs a fresh approval, and an account that already got it is not posted to twice
  assert.ok(!(await Img.approve(admin, pics[1])).error); failIg = true; posted.length = 0;
  await Agent.approveTask(admin, posts[1].id, { accountIds: ['ig1', 'fb1'] }, { ...pbase, base: 'https://tl.test' }); Agent.config.clock = () => Date.parse('2026-11-27T10:05:00+05:30'); await Agent.sweep({ ...pbase, force: true, notify }); await Agent.drain(); r = await Agent.detail(admin, pg.run.id);
  const p1 = r.tasks.find((t) => t.id === posts[1].id); assert.equal(p1.status, 'failed'); assert.ok(/Posted on Test Page, but test_ig: The Instagram sign-in has expired\./.test(p1.error), p1.error); assert.equal(p1.attempts, 1, 'an outward step is never retried by itself');
  failIg = false; prior = [{ accountId: 'fb1', ok: true }]; posted.length = 0;
  r = await Agent.retryTask(admin, posts[1].id, pbase); assert.equal(r.tasks.find((t) => t.id === posts[1].id).status, 'awaiting_approval', 'a retry asks again'); assert.equal(posted.length, 0); await Agent.drain(); assert.equal(posted.length, 0, 'nothing posted by the retry request itself');
  await Agent.approveTask(admin, posts[1].id, { accountIds: ['ig1', 'fb1'] }, { ...pbase, base: 'https://tl.test' }); await Agent.sweep({ ...pbase, force: true, notify }); await Agent.drain();
  assert.deepEqual(posted.map((x) => x.accountIds), [['ig1']], 'Test Page already had it, so only Instagram was posted'); r = await Agent.detail(admin, pg.run.id); assert.equal(r.tasks.find((t) => t.id === posts[1].id).status, 'done');
  // cancel a queued, approved post before its time
  const pg2 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { publish: 'agent', platforms: ['facebook'] } }, { ...pbase, now: NOW }); Agent.config.clock = () => CLOCK0;
  await Agent.approve(admin, pg2.run.id, pbase); await Agent.drain(); r = await Agent.detail(admin, pg2.run.id); const sp = r.tasks.find((t) => t.tool === 'social.post'); assert.ok(!(await Img.approve(admin, r.tasks.find((t) => t.tool === 'image.banner').refs[0].id)).error);
  posted.length = 0; await Agent.approveTask(admin, sp.id, { accountIds: ['fb1'] }, { ...pbase, base: 'https://tl.test' }); r = await Agent.cancelTask(admin, sp.id); assert.equal(r.tasks.find((t) => t.id === sp.id).status, 'cancelled'); Agent.config.clock = () => CLOCK1; await Agent.sweep({ ...pbase, force: true, notify }); await Agent.drain(); assert.equal(posted.length, 0, 'a cancelled post never goes out');
  Agent.config.clock = () => Date.now();
  console.log('PASS social.post: the plan\'s approval posts nothing; the step waits for the picture to be approved, the Admin switch, the person\'s accounts (connected ones of the plan\'s platforms only, https site) and its scheduled time; it posts as the approver, one call per platform with that platform\'s caption, never twice to an account; a failure needs a fresh approval; a cancelled post never goes out');

  // 16. client.review: the client is messaged only after the person confirms who it goes to; the number is never shown back
  await CS.createPlan(admin, { clientName: 'Review Test Clinic', plan: 'basic', months: 3, startDate: '2026-11-01', industry: 'Dental clinic' });
  await Ctx.save(admin, 'c:review-test-clinic', { name: 'Review Test Clinic', services: ['Check-ups', 'Cleaning'], audience: 'Families nearby', contactLine: 'Call 99999 11111' });
  const sentTo = []; let crFail = false;
  const crSvc = { CR: { contacts: async () => ({ contacts: [{ name: 'review test clinic', contactName: 'Dr Earlier', contactPhone: '9876501234', contactEmail: '', clientId: '' }] }), sendToClient: async (u, itemId, b, base) => { sentTo.push({ u: u.id, itemId, ...b, base }); return crFail ? { error: 'The WhatsApp message could not be sent.', status: 502 } : { ok: 'Sent by WhatsApp (the picture itself, with the link).', review: { id: 'rv-test' } }; } } };
  const cbase = { ...base, svc: crSvc };
  const cr = await Agent.startRun(admin, { goal: 'Promote Review Test Clinic for 3 days', business: 'c:review-test-clinic', params: { approver: 'client' } }, { ...cbase, now: NOW });
  assert.equal(cr.run.plan.params.approver, 'client'); assert.equal(cr.tasks.filter((t) => t.tool === 'client.review').length, 3); assert.equal(cr.tasks.filter((t) => t.tool === 'approval.request').length, 0); assert.ok(cr.preflight.warnings.some((w) => /sent to the client on WhatsApp only after you approve that step/.test(w)));
  await Agent.approve(admin, cr.run.id, cbase); await Agent.drain(); r = await Agent.detail(admin, cr.run.id); const reviews = r.tasks.filter((t) => t.tool === 'client.review');
  assert.deepEqual(reviews.map((t) => t.status), ['awaiting_approval', 'awaiting_approval', 'awaiting_approval']); assert.equal(sentTo.length, 0, 'nobody is messaged by the plan\'s approval');
  const cp = await Agent.prepareTask(admin, reviews[0].id, cbase); assert.equal(cp.ready, true); assert.deepEqual([cp.defaults.clientName, cp.defaults.contactName, cp.defaults.contactPhone], ['review test clinic', 'Dr Earlier', '9876501234'], 'the client details typed on an earlier send are offered'); assert.ok(/Caption:/.test(cp.message) && cp.message.length <= 400);
  const site = { ...cbase, base: 'https://tl.test' };
  assert.ok((await Agent.approveTask(admin, reviews[0].id, { clientName: 'Review Test Clinic', contactPhone: '123' }, site)).error, 'a number that is not a number is refused'); assert.ok((await Agent.approveTask(admin, reviews[0].id, { clientName: 'Review Test Clinic', contactPhone: '9876501234' }, { ...cbase, base: '' })).error, 'the link needs the site address'); assert.equal(sentTo.length, 0);
  assert.ok((await Agent.approveTask(admin, reviews[0].id, { clientName: 'R', contactPhone: '9876501234' }, site)).error && (await Agent.approveTask(admin, reviews[0].id, { clientName: 'Review Test Clinic', contactPhone: '9876501234', contactEmail: 'not-an-email' }, site)).error);
  const many = await Agent.approveSteps(admin, cr.run.id, 'client.review', { clientName: 'Review Test Clinic', contactName: 'Dr Earlier', contactPhone: '9876501234' }, site); assert.equal(many.approved, 3, many.error); await Agent.drain();
  assert.equal(sentTo.length, 3); assert.ok(sentTo.every((x) => x.clientName === 'Review Test Clinic' && x.contactPhone === '9876501234' && x.base === 'https://tl.test' && x.u === admin.id && x.message.length <= 400)); assert.equal(new Set(sentTo.map((x) => x.itemId)).size, 3, 'one message per picture'); assert.equal(new Set(sentTo.map((x) => x.message)).size, 3, 'each message carries the caption of its own day'); assert.ok(sentTo.every((x) => /Day \d of the plan\. Caption: /.test(x.message)));
  r = await Agent.detail(admin, cr.run.id); assert.deepEqual(r.tasks.filter((t) => t.tool === 'client.review').map((t) => t.status), ['done', 'done', 'done']); assert.ok(/Sent to the client to approve: 3 pictures/.test(r.live.lines.join(' ')), r.live.lines.join(' | '));
  const shown = JSON.stringify(r) + JSON.stringify(await Agent.dashboard(admin)); assert.ok(!shown.includes('9876501234') && !shown.includes('987650'), 'the client\'s number is never shown back (task views, history, summary, dashboard)'); assert.ok(r.tasks.find((t) => t.tool === 'client.review').input.contactPhone.includes('•') || /\*|•|X/.test(r.tasks.find((t) => t.tool === 'client.review').input.contactPhone), 'a masked number');
  assert.ok(r.events.some((e) => e.kind === 'task_approved' && /send the picture to Review Test Clinic on WhatsApp/.test(e.text)));
  // a failed send asks again; an already approved picture has nothing for the client to decide
  const cr2 = await Agent.startRun(admin, { goal: 'Promote Review Test Clinic for 1 days', business: 'c:review-test-clinic', params: { approver: 'client' } }, { ...cbase, now: NOW }); await Agent.approve(admin, cr2.run.id, cbase); await Agent.drain(); crFail = true; sentTo.length = 0;
  r = await Agent.detail(admin, cr2.run.id); const rv = r.tasks.find((t) => t.tool === 'client.review'); await Agent.approveTask(admin, rv.id, { clientName: 'Review Test Clinic', contactPhone: '9876501234' }, site); await Agent.drain(); r = await Agent.detail(admin, cr2.run.id);
  assert.equal(r.tasks.find((t) => t.id === rv.id).status, 'failed'); assert.ok(/could not be sent/.test(r.tasks.find((t) => t.id === rv.id).error)); assert.equal(sentTo.length, 1, 'one try only'); crFail = false;
  r = await Agent.retryTask(admin, rv.id, cbase); assert.equal(r.tasks.find((t) => t.id === rv.id).status, 'awaiting_approval'); await Agent.drain(); assert.equal(sentTo.length, 1, 'a retry request sends nothing');
  await S.run(`UPDATE "OmniMkImage" SET status = 'approved' WHERE id = ?`, r.tasks.find((t) => t.tool === 'image.banner').refs[0].id); assert.ok(/already approved/.test((await Agent.prepareTask(admin, rv.id, cbase)).reason), 'nothing left for the client to decide');
  console.log('PASS client.review: nobody is messaged by the plan\'s approval; the person confirms the client and number (checked, https site), approves one or all of the week\'s sends, the number is shown back nowhere, a failed send asks again, an approved picture is not sent');

  // 17. the run is honest about what went outside
  const dash2 = await Agent.dashboard(admin); assert.ok(dash2.usage.month.every((u) => u.rupees === 0) && dash2.usage.month.some((u) => u.tool === 'social.post') && dash2.usage.month.some((u) => u.tool === 'client.review'), 'posts and client messages are counted in the usage list'); assert.ok(dash2.pendingApprovals.outward.length >= 1 && dash2.pendingApprovals.outward.every((x) => x.title));
  console.log('PASS the dashboard counts the posts and client messages and lists the steps still waiting for their own approval');

  // 13. every tool is listed with its cost and risk: two outward tools, each behind its own approval
  const cat = Tools.catalog(); assert.ok(cat.length >= 8 && cat.every((t) => t.cost.word && ['internal', 'outward'].includes(t.risk))); assert.deepEqual(cat.filter((t) => t.risk === 'outward').map((t) => t.id).sort(), ['client.review', 'social.post'], 'only the two Phase 2 outward tools exist: bulk WhatsApp, calls and ad spend are not tools');
  assert.ok(!cat.some((t) => t.cost.kind === 'paid') && cat.every((t) => t.cost.rupees === 0));
  console.log('PASS the tool list: each tool with its cost and risk, two outward (post, ask the client), none paid');
  console.log('\nALL AGENT CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
