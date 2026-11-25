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
  const seoPlan = P.build("Improve my website's SEO", { name: 'Site Co', website: 'https://agent.test', skips: [] }, {}, NOW).plan; assert.deepEqual(P.taskSpecs(seoPlan).map((t) => t.tool), ['seo.audit', 'seo.keywords', 'seo.content', 'seo.blogplan', 'manual.note']);
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
  assert.equal(s1.run.status, 'preview'); assert.deepEqual(s1.tasks.map((t) => t.tool), ['seo.audit', 'seo.keywords', 'seo.content', 'seo.blogplan', 'manual.note']); assert.ok(/nothing on the website is changed|Nothing on the website is changed/i.test(JSON.stringify(s1.run.plan.assumptions)));
  await Agent.approve(admin, s1.run.id, base); await Agent.drain(); r = await Agent.detail(admin, s1.run.id);
  assert.deepEqual(r.tasks.map((t) => t.status), ['done', 'done', 'done', 'done', 'waiting'], r.tasks.map((t) => t.error).join('; ')); assert.ok(/Website audit saved: \d+\/100/.test(r.tasks[0].summary) && /Blog plan saved: \d+ briefs?/.test(r.tasks[3].summary)); assert.ok(Number.isInteger(r.live.numbers.siteScore) && r.live.numbers.blogBriefs > 0);
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
  assert.equal(sentTo.length, 3, JSON.stringify((await Agent.detail(admin, cr.run.id)).tasks.filter((t) => t.tool === 'client.review').map((t) => [t.status, t.error, t.attempts, t.approvedAt]))); assert.ok(sentTo.every((x) => x.clientName === 'Review Test Clinic' && x.contactPhone === '9876501234' && x.base === 'https://tl.test' && x.u === admin.id && x.message.length <= 400)); assert.equal(new Set(sentTo.map((x) => x.itemId)).size, 3, 'one message per picture'); assert.equal(new Set(sentTo.map((x) => x.message)).size, 3, 'each message carries the caption of its own day'); assert.ok(sentTo.every((x) => /Day \d of the plan\. Caption: /.test(x.message)));
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

  // 18. PHASE 3 SEO: the agent calls the SEO assistant (audit, keywords, texts); the same site is never started twice
  const Sites = require(`${M}seoSites`); const Kw = require(`${M}seoKeywords`); const SeoText = require(`${M}seoContent`); const Tasks = require(`${M}seoTasks`);
  const seoSite = (await Sites.list(admin)).items.find((x) => x.clientName === 'SEO Test Co'); assert.ok(seoSite, 'the SEO assistant now has a site for the client (started by the agent from the saved facts)'); assert.deepEqual([seoSite.schedule, seoSite.facts.services, seoSite.facts.city, seoSite.url], ['off', 'Heart check-ups', 'Pune', 'https://agent.test/'], 'audits stay off: nothing is scheduled by itself');
  assert.equal((await Sites.list(admin)).items.filter((x) => x.clientName === 'SEO Test Co').length, 1);
  const sd = await Agent.detail(admin, s1.run.id); const auditTask = sd.tasks.find((t) => t.tool === 'seo.audit');
  assert.ok(/Website audit saved: \d+\/100; \d+ open recommendations? kept for SEO Test Co/.test(auditTask.summary) && auditTask.data.siteId === seoSite.id && auditTask.refs[0].page === 'mkseo', auditTask.summary);
  assert.ok(((await Tasks.list(admin, { siteId: seoSite.id })).items || []).length > 0, 'the audit\'s findings are kept as recommendation tasks of the SEO assistant');
  const kws = await Kw.list(admin, seoSite.id); assert.ok(kws.items.length >= 3 && kws.items.every((k) => k.source === 'agent' && k.volume === null && k.difficulty === null), 'keyword ideas were kept, with no search volume or difficulty invented'); assert.ok(sd.tasks.find((t) => t.tool === 'seo.keywords').data.top.length > 0);
  const texts = await SeoText.list(admin, seoSite.id); assert.ok((texts.items || texts).length >= 1, 'the home page texts were kept'); assert.ok(/kept in the SEO assistant for SEO Test Co/.test(sd.tasks.find((t) => t.tool === 'seo.content').summary));
  assert.ok(/Keyword ideas kept in the SEO assistant: \d+ new \(no search volumes/.test(sd.live.lines.join(' ')) && /Texts for the website kept in the SEO assistant: \d+ texts? \(nothing was changed on the website\)/.test(sd.live.lines.join(' ')), sd.live.lines.join(' | '));
  // a second SEO goal for the same client: the same site is used, the audit has a score to compare with, the summary says so
  const s2 = await Agent.startRun(admin, { goal: "Improve my website's SEO", business: 'c:seo-test-co' }, { ...base, now: NOW }); await Agent.approve(admin, s2.run.id, base); await Agent.drain();
  assert.equal((await Sites.list(admin)).items.filter((x) => x.clientName === 'SEO Test Co').length, 1, 'no second SEO site'); const sd2 = await Agent.detail(admin, s2.run.id);
  assert.deepEqual(sd2.tasks.map((t) => t.status), ['done', 'done', 'done', 'done', 'waiting'], sd2.tasks.map((t) => t.error).join('; ')); assert.ok(/\(was \d+\)/.test(sd2.tasks[0].summary), 'the second audit says what the score was before');
  assert.ok(/Website score: \d+\/100 now, \d+\/100 before this plan/.test(sd2.live.lines.join(' ')), sd2.live.lines.join(' | '));
  console.log('PASS the SEO assistant: the agent starts the client\'s SEO site once from the saved facts, audits it (findings kept as recommendations), keeps keyword ideas with no invented volumes and the home page texts, and a second goal compares with the earlier score');

  // 19. PHASE 3 WhatsApp: a message is PREPARED and approved here; the agent never sends it
  const wp = P.build('Promote TeamLink Consultants for 2 days on WhatsApp and Instagram', ctx, { publish: 'manual' }, NOW).plan; assert.deepEqual(wp.params.platforms, ['instagram', 'whatsapp']);
  assert.ok(wp.days.every((d) => /\n\nReply STOP to opt out$/.test(d.texts.whatsapp) && d.texts.whatsapp.length <= 1024 && !/#/.test(d.texts.whatsapp) && /#/.test(d.texts.instagram)), 'every WhatsApp text ends with the opt-out line, has no hashtags and fits'); assert.ok(wp.assumptions.some((a) => /never sends it from the agent/.test(a)));
  const wspec = P.taskSpecs({ ...wp, businessKey: 'own' }); assert.deepEqual(wspec.slice(2, 6).map((t) => t.tool), ['approval.request', 'manual.post', 'manual.whatsapp', 'content.draft'], 'a post by hand for Instagram and a WhatsApp send by a person'); assert.ok(/Instagram/.test(wspec[3].title) && !/WhatsApp/.test(wspec[3].title));
  const longCtx = { ...ctx, services: ['x'.repeat(58), 'y'.repeat(58), 'z'.repeat(58), 'w'.repeat(58)], about: 'a'.repeat(390) }; assert.ok(P.build('Promote us for 3 days on whatsapp', longCtx, {}, NOW).plan.days.every((d) => d.texts.whatsapp.length <= 1024 && d.texts.whatsapp.endsWith('Reply STOP to opt out')), 'a long text is cut so the opt-out line still fits');
  assert.deepEqual(Tools.catalog().filter((t) => /whatsapp/i.test(t.id) && t.risk === 'outward'), [], 'there is no tool that sends WhatsApp');
  const wg = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days on WhatsApp', business: 'own', params: { platforms: ['whatsapp'], waCampaign: false } }, { ...base, now: NOW });
  assert.equal(wg.run.plan.days[0].contentType, 'WhatsApp message with a picture'); assert.ok(wg.preflight.warnings.length >= 0 && wg.tasks.some((t) => t.tool === 'manual.whatsapp') && !wg.tasks.some((t) => t.tool === 'manual.post' || t.tool === 'social.post'));
  await Agent.approve(admin, wg.run.id, base); await Agent.drain(); r = await Agent.detail(admin, wg.run.id);
  const wdraft = r.tasks.find((t) => t.tool === 'content.draft'); const wrow = (await S.q('SELECT * FROM "OmniMkContent" WHERE id = ?', wdraft.refs[0].id))[0];
  assert.deepEqual([wrow.status, JSON.parse(wrow.channels)], ['waiting', ['whatsapp']], 'the WhatsApp text is in AI Content, sent for approval'); assert.ok(/Reply STOP to opt out$/.test(JSON.parse(wrow.texts).whatsapp));
  const wstep = r.tasks.find((t) => t.tool === 'manual.whatsapp'); assert.equal(wstep.status, 'waiting'); assert.ok(/never sends WhatsApp/.test(wstep.does));
  m = await Agent.markManual(admin, wstep.id, { action: 'done' }); assert.equal(m.code, 'not_approved'); assert.ok(/marked as sent yet/.test(m.error) && /Only approved content is sent/.test(m.error), m.error);
  assert.ok(!(await C.approve(admin, wdraft.refs[0].id)).error); m = await Agent.markManual(admin, wstep.id, { action: 'done', note: 'sent from Campaigns' }); assert.ok(!m.error, m.error);
  r = await Agent.detail(admin, wg.run.id); assert.ok(/WhatsApp messages sent: 1 of 1 \(a person sends them from Campaigns after approval: the agent never sends WhatsApp\)/.test(r.live.lines.join(' ')), r.live.lines.join(' | ')); assert.equal(r.run.status, 'done', 'every step is done: the run is finished');
  console.log('PASS WhatsApp: the message is written with the opt-out line (no hashtags, 1024 letters), saved in AI Content and sent for approval; a person\'s "sent" step needs the words approved; there is no tool that sends WhatsApp');

  // 20. PHASE 3 performance: real counts from the posting records, the clients' answers, the CRM and the saved audits
  await require(`${M}postItem`).ensure(); await require(`${M}clientReview`).ensure(); // (the posting and review tables are made when first used: the stand-ins above never made them)
  const perfRun = pg.run.id; const pd0 = await Agent.detail(admin, perfRun); const perfPics = pd0.tasks.filter((t) => t.tool === 'image.banner').map((t) => t.refs[0].id); const startMs = Date.parse(pd0.run.startedAt);
  await S.run(`INSERT INTO "OmniMkItemPost" (id, itemId, accountId, platform, accountName, ok, url, error, caption, byId, byName, at) VALUES ('ip-a', ?, 'fb1', 'facebook', 'Test Page', 1, 'https://social.test/a', NULL, 'x', 'u', 'U', ?)`, perfPics[0], startMs + 1000);
  await S.run(`INSERT INTO "OmniMkItemPost" (id, itemId, accountId, platform, accountName, ok, url, error, caption, byId, byName, at) VALUES ('ip-b', ?, 'ig1', 'instagram', 'test_ig', 0, NULL, 'expired', 'x', 'u', 'U', ?)`, perfPics[0], startMs + 2000);
  for (const [i, [id, st]] of [[perfPics[0], 'approved'], [perfPics[1], 'changes']].entries()) await S.run(`INSERT INTO "OmniMkClientReview" (id, kind, itemId, itemTitle, clientName, snapshot, status, createdAt, updatedAt, mode) VALUES (?, 'image', ?, 'x', 'C', 's', ?, ?, ?, 'decide')`, `rv-perf-${i}`, id, st, startMs + 3000, startMs + 3000);
  const leadList = [{ createdAt: new Date(startMs - 86400000).toISOString(), band: 'Hot', source: 'Website' }, { createdAt: new Date(startMs + 5000).toISOString(), band: 'Hot', source: 'WhatsApp' }, { createdAt: new Date(startMs + 6000).toISOString(), band: 'Warm', source: 'Facebook Ads' }];
  Agent.kick(perfRun, { svc: { ...postSvc, Lead: { overview: async () => ({ leads: leadList }) } } }); await Agent.drain();
  r = await Agent.detail(admin, perfRun); const pl = r.live.lines.join(' | ');
  assert.ok(/Posts recorded on the accounts for these pictures: 1 went public, 1 failed\./.test(pl), pl); assert.ok(/Clients' answers: 1 approved, 1 asked for changes, 0 still waiting \(of 2 pictures sent\)\./.test(pl), pl);
  assert.ok(/New CRM leads since the plan started: 2 \(1 hot, 1 warm, 0 cold; 1 through the WhatsApp assistant\)\. They come from every source: TeamLink cannot tell which came from these posts\./.test(pl), pl);
  assert.deepEqual([r.live.numbers.performance.posts.total, r.live.numbers.performance.clients.sent, r.live.numbers.performance.leads.total, r.live.numbers.performance.leads.bySource.length], [1, 2, 2, 2]); assert.equal(r.live.numbers.performance.posts.items[0].url, 'https://social.test/a');
  Agent.kick(perfRun, { svc: { ...postSvc, Lead: { overview: async () => ({ error: 'Your login is not on the CRM list.' }) } } }); await Agent.drain(); r = await Agent.detail(admin, perfRun);
  assert.ok(/CRM leads: not shown \(Your login is not on the CRM list\.\)/.test(r.live.lines.join(' ')) && !/New CRM leads since/.test(r.live.lines.join(' ')), 'a login that cannot read the CRM gets a reason, not a zero');
  const dp = (await Agent.dashboard(admin)).performance.find((x) => x.runId === perfRun); assert.ok(dp && dp.lines.some((l) => /Posts recorded on the accounts/.test(l)), 'the dashboard shows the same real numbers');
  assert.ok(P.METRICS.leads.live === true && /cannot tell which lead came from which post/.test(P.METRICS.leads.how), 'the leads metric is honest about attribution');
  const noLeadsForSeo = (await Agent.detail(admin, s1.run.id)).live.numbers.performance; assert.equal(noLeadsForSeo.leads, null, 'an SEO goal does not claim leads');
  console.log('PASS performance: posts recorded, clients\' answers, new CRM leads (by band and source, WhatsApp assistant counted, never claimed as caused by the plan) and the score before / after come from the records; a login that cannot read the CRM gets a reason');

  // 21. PHASE 4 video: one picture per SCENE, all sent for approval; free stock clips only when asked and only when the source is set up
  const vplan = P.build('Generate promotional videos for my business', ctx, { count: 2, clips: true }, NOW).plan;
  assert.ok(vplan.days.every((d) => d.scenes.length >= 4 && d.scenes[0].label === 'hook' && d.scenes[d.scenes.length - 1].label === 'call to action' && d.scenes.every((x) => x.headline.length >= 3 && x.headline.length <= 90 && x.sub.length <= 80)), 'every video has a hook, who / what, services and a call to action, each with its picture words');
  assert.ok(vplan.days.every((d) => !/\.\./.test(d.mediaPrompt) && /Join them in AI Video/.test(d.mediaPrompt)), 'the scene text reads cleanly');
  const vspec = P.taskSpecs({ ...vplan, businessKey: 'own' }); const nScenes = vplan.days.reduce((a, d) => a + d.scenes.length, 0);
  assert.equal(vspec.filter((t) => t.tool === 'image.banner').length, nScenes, 'one picture per scene'); assert.deepEqual(vspec.filter((t) => t.tool === 'image.banner' && t.day === 1).map((t) => t.args.scene), vplan.days[0].scenes.map((_, k) => k));
  assert.deepEqual(vspec.filter((t) => t.tool === 'video.clips').map((t) => t.day), [1, 2], 'stock clips only because they were asked for'); assert.ok(vspec.filter((t) => t.tool === 'manual.video').every((t) => /join the scene pictures/.test(t.title)));
  assert.equal(P.taskSpecs({ ...P.build('Generate promotional videos for my business', ctx, { count: 2 }, NOW).plan, businessKey: 'own' }).filter((t) => t.tool === 'video.clips').length, 0, 'no stock clips by default');
  assert.equal(P.taskSpecs({ ...P.build('Generate promotional videos for my business', ctx, { count: 2, creative: 'none' }, NOW).plan, businessKey: 'own' }).filter((t) => t.tool === 'video.clips' || /^image\./.test(t.tool)).length, 0, 'no pictures, no scene pictures, no clips');
  // run it: the pictures are real, each one carries its scene's words, and the approval request covers ALL of them
  const vg = await Agent.startRun(admin, { goal: 'Generate promotional videos for my business', business: 'own', params: { count: 2 } }, { ...base, now: NOW });
  await Agent.approve(admin, vg.run.id, base); await Agent.drain(); r = await Agent.detail(admin, vg.run.id);
  const vpics = r.tasks.filter((t) => t.tool === 'image.banner'); assert.equal(vpics.length, vg.run.plan.days.reduce((a, d) => a + d.scenes.length, 0)); assert.ok(vpics.every((t) => t.status === 'done'), vpics.map((t) => t.error).join('; '));
  assert.ok(/scene 1/.test((await S.q('SELECT title FROM "OmniMkImage" WHERE id = ?', vpics[0].refs[0].id))[0].title), 'the picture is named after its scene');
  assert.equal(vpics[0].input.headline, vg.run.plan.days[0].scenes[0].headline, 'scene 1 carries the hook as its headline'); assert.equal(vpics[0].input.size, '9:16');
  const vstat = await S.q(`SELECT status FROM "OmniMkImage" WHERE id IN (${vpics.map(() => '?').join(',')})`, ...vpics.map((t) => t.refs[0].id)); assert.ok(vstat.every((x) => x.status === 'waiting'), 'every scene picture was sent for approval, not just the first');
  assert.equal(r.tasks.filter((t) => t.tool === 'approval.request').every((t) => t.refs.filter((x) => x.kind === 'image').length >= 4), true); assert.ok(/Picture 1: .*Picture 2/.test(r.tasks.find((t) => t.tool === 'approval.request').summary), r.tasks.find((t) => t.tool === 'approval.request').summary);
  assert.ok(r.tasks.filter((t) => t.tool === 'manual.video').every((t) => t.status === 'waiting')); assert.ok(/join the scene pictures/.test(r.tasks.find((t) => t.tool === 'manual.video').title) && /scene pictures made for this video/.test(r.tasks.find((t) => t.tool === 'manual.video').does));
  // stock clips: refused while the source is not set up (a blocker, like AI pictures), made when it is
  let cv = await Agent.startRun(admin, { goal: 'Generate promotional videos for my business', business: 'own', params: { count: 1, clips: true } }, { ...base, now: NOW });
  assert.ok(cv.preflight.blockers.some((b) => /Find free stock clips/.test(b)), 'the preview says the stock source is not ready'); assert.equal((await Agent.approve(admin, cv.run.id, base)).code, 'blocked');
  const stockCalls = []; let stockReady = true; let stockFail = false;
  const stock = { status: async () => (stockReady ? { ready: true } : { ready: false, reason: 'No stock-clip key yet.' }), search: async (u, q) => { stockCalls.push(['search', q.q, q.orientation]); return stockFail ? { error: 'Too many searches in a few minutes.', status: 429 } : { items: [{ id: '101' }, { id: '102' }, { id: '103' }] }; }, importClip: async (u, b) => { stockCalls.push(['import', b.id]); return { item: { id: `clip-${b.id}`, title: `Stock: ${b.query}` } }; } };
  const stockBase = { ...base, svc: { Stock: stock } }; cv = await Agent.startRun(admin, { goal: 'Generate promotional videos for my business', business: 'own', params: { count: 1, clips: true } }, { ...stockBase, now: NOW });
  assert.equal(cv.preflight.blockers.length, 0, cv.preflight.blockers.join()); await Agent.approve(admin, cv.run.id, stockBase); await Agent.drain(); r = await Agent.detail(admin, cv.run.id);
  const ct = r.tasks.find((t) => t.tool === 'video.clips'); assert.equal(ct.status, 'done', ct.error); assert.deepEqual(stockCalls.filter((x) => x[0] === 'import').map((x) => x[1]), ['101', '102'], 'the best two are saved'); assert.equal(stockCalls[0][2], 'portrait'); assert.ok(/2 stock clips saved in AI Images/.test(ct.summary) && ct.data.clips.length === 2);
  assert.ok(/Stock clips saved: 2 \(raw footage in AI Images: approve before use\)/.test(r.live.lines.join(' ')), r.live.lines.join(' | '));
  stockFail = true; stockCalls.length = 0; const cv2 = await Agent.startRun(admin, { goal: 'Generate promotional videos for my business', business: 'own', params: { count: 1, clips: true } }, { ...stockBase, now: NOW }); await Agent.approve(admin, cv2.run.id, stockBase); await Agent.drain(); r = await Agent.detail(admin, cv2.run.id);
  assert.equal(r.tasks.find((t) => t.tool === 'video.clips').status, 'failed'); assert.ok(/Too many searches/.test(r.tasks.find((t) => t.tool === 'video.clips').error)); assert.equal(r.tasks.find((t) => t.tool === 'approval.request').status, 'done', 'a missing clip never blocks the approval of the pictures'); stockFail = false;
  console.log('PASS video: one picture per scene (hook, who / what, services, call to action) each named after its scene, all sent for approval; stock clips only when asked, a blocker while the source is not set up, the best two saved as raw footage, a failed search never blocks the rest; joining them stays a person\'s step in AI Video');

  // 22. PHASE 4 voice: a CALL SHEET for a person; the agent never calls and never uses AI Calling
  assert.deepEqual(Tools.catalog().filter((t) => /call/i.test(t.id) && t.risk === 'outward'), [], 'there is no tool that places a call');
  const csPlan = P.build('Promote TeamLink Consultants for 2 days', ctx, { callSheet: true }, NOW).plan; const csSpec = P.taskSpecs({ ...csPlan, businessKey: 'own' });
  assert.deepEqual(csSpec.slice(-2).map((t) => t.tool), ['calling.sheet', 'manual.calls']); assert.equal(csSpec[csSpec.length - 2].at, Date.parse('2026-11-28T10:00:00+05:30'), 'the sheet is built the day after the last day, 10:00'); assert.deepEqual(csSpec[csSpec.length - 1].deps, [csSpec[csSpec.length - 2].n]);
  assert.ok(csPlan.assumptions.some((a) => /does not call anyone: your team calls from the CRM/.test(a) && /AI Calling is built for job candidates with a recorded consent/.test(a) && /Do-Not-Disturb/.test(a)), 'the plan says who calls and what is not checked'); assert.equal(P.taskSpecs({ ...P.build('Promote us for 2 days', ctx, {}, NOW).plan, businessKey: 'own' }).filter((t) => t.tool === 'calling.sheet').length, 0, 'off by default');
  const startAt = Date.now() + 3600000; const isoAt = (ms) => new Date(ms).toISOString(); let crmOk = true; const waCalls = [];
  const leadsFor = () => ({ leads: [
    { id: 'L-old', company: 'Old Co', contactName: 'Old', band: 'Hot', score: 90, why: ['an old lead'], source: 'Website', status: 'New', stage: '', phone: '+91 ••••• ••011', ownerName: 'Ravi', createdAt: isoAt(Date.now() - 3 * 86400000) },
    { id: 'L-warm', company: 'Warm Co', contactName: 'Wendy', band: 'Warm', score: 55, why: ['asked about a service', 'works in a target city'], source: 'Facebook Ads', status: 'New', stage: '', phone: '+91 ••••• ••022', ownerName: 'Asha', createdAt: isoAt(startAt + 2000) },
    { id: 'L-hot', company: 'Hot Co', contactName: 'Hari', band: 'Hot', score: 88, why: ['asked for a call', 'gave a budget'], source: 'WhatsApp', status: 'New', stage: '', phone: '+91 ••••• ••033', ownerName: 'Asha', createdAt: isoAt(startAt + 3000) },
    { id: 'L-cold', company: 'Cold Co', contactName: 'Cora', band: 'Cold', score: 10, why: [], source: 'Website', status: 'New', stage: '', phone: '+91 ••••• ••044', ownerName: '', createdAt: isoAt(startAt + 4000) },
    { id: 'L-lost', company: 'Lost Co', contactName: 'Lou', band: 'Hot', score: 80, why: ['was keen'], source: 'Website', status: 'Lost', stage: '', phone: '+91 ••••• ••055', ownerName: '', createdAt: isoAt(startAt + 5000) },
  ] });
  const callSvc = { Lead: { overview: async () => (crmOk ? leadsFor() : { error: 'Your login is not on the CRM list.' }) }, WA: { call: async (u, name, input) => { waCalls.push([name, input.crmLeadId]); return input.crmLeadId === 'L-hot' ? { band: 'Hot', fields: { requirement: 'Hiring 5 nurses', callback: 'after 5 pm' }, next: 'Call this evening' } : { error: 'There is no chat for this lead.', status: 404 }; } } };
  const callBase = { ...base, svc: callSvc }; Agent.config.clock = () => Date.now();
  const cg = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { callSheet: true, creative: 'none', startDate: '2026-11-26' } }, { ...callBase, now: NOW });
  assert.ok(cg.preflight.warnings.some((w) => /Call sheet: built when the plan ends/.test(w)), 'the preview explains the call sheet'); assert.ok(cg.tasks.find((t) => t.tool === 'calling.sheet').scheduledAt && cg.tasks.find((t) => t.tool === 'calling.sheet').scheduled);
  await Agent.approve(admin, cg.run.id, callBase); await Agent.drain(); r = await Agent.detail(admin, cg.run.id); const sheetT = r.tasks.find((t) => t.tool === 'calling.sheet');
  assert.equal(sheetT.status, 'queued', 'the sheet waits for its day'); assert.equal(r.run.status, 'running'); assert.equal(waCalls.length, 0);
  assert.equal((await Agent.runNow(admin, r.tasks.find((t) => t.tool === 'manual.calls').id, callBase)).status, 409, 'a person\'s step cannot be run'); assert.equal((await Agent.runNow(other, sheetT.id, callBase)).status, 404);
  Agent.kick(cg.run.id, callBase); r = await Agent.runNow(admin, sheetT.id, callBase); await Agent.drain(); r = await Agent.detail(admin, cg.run.id);
  const sheetDone = r.tasks.find((t) => t.tool === 'calling.sheet'); assert.equal(sheetDone.status, 'done', sheetDone.error); const sh = sheetDone.data.sheet;
  assert.deepEqual(sh.rows.map((x) => x.leadId), ['L-hot', 'L-warm'], 'Hot first, then Warm; Cold, Lost and old leads are left out'); assert.deepEqual([sh.total, sh.hot, sh.warm], [3, 1, 1]);
  assert.deepEqual([sh.rows[0].asked, sh.rows[0].bestTime, sh.rows[0].note, sh.rows[1].asked, sh.rows[1].bestTime], ['Hiring 5 nurses', 'after 5 pm', 'Call this evening', null, null], 'a WhatsApp lead has what the customer told the assistant; the others have no such detail, nothing is invented');
  assert.ok(sh.rows.every((x) => /•/.test(x.phone) && !/\d{8}/.test(x.phone)), 'phone numbers stay masked'); assert.ok(sh.script.length >= 4 && sh.rules.some((x) => /Do-Not-Disturb/.test(x)) && sh.rules.some((x) => /does not call anyone/.test(x)));
  assert.ok(/Call sheet ready: 2 leads to call \(1 hot, 1 warm of 3 new since the plan started\)\. Nobody is called by the agent\./.test(sheetDone.summary), sheetDone.summary); assert.ok(waCalls.every((c) => c[0] === 'lead.summary'), 'only the WhatsApp assistant\'s read-only service was used');
  const mc = r.tasks.find((t) => t.tool === 'manual.calls'); assert.equal(mc.status, 'waiting'); assert.equal(r.run.status, 'attention');
  m = await Agent.markManual(admin, mc.id, { action: 'done', note: 'called 2 leads' }); assert.ok(!m.error, m.error); r = await Agent.detail(admin, cg.run.id);
  assert.ok(/Call sheet: 2 leads to call/.test(r.live.lines.join(' ')) && /Calls made by your team: 1 of 1 \(marked by a person\)\./.test(r.live.lines.join(' ')) && /Nothing was posted, sent, called or spent by the agent\./.test(r.live.lines.join(' ')), r.live.lines.join(' | '));
  // a login the CRM does not know: a plain reason, and a retry works once it does
  crmOk = false; const cg2 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { callSheet: true, creative: 'none', startDate: '2026-11-26' } }, { ...callBase, now: NOW }); await Agent.approve(admin, cg2.run.id, callBase); await Agent.drain();
  await Agent.runNow(admin, (await Agent.detail(admin, cg2.run.id)).tasks.find((t) => t.tool === 'calling.sheet').id, callBase); await Agent.drain(); r = await Agent.detail(admin, cg2.run.id); const bad = r.tasks.find((t) => t.tool === 'calling.sheet');
  assert.equal(bad.status, 'failed'); assert.ok(/cannot be read for your login \(Your login is not on the CRM list\.\)/.test(bad.error)); crmOk = true; await Agent.retryTask(admin, bad.id, callBase); await Agent.drain(); assert.equal((await Agent.detail(admin, cg2.run.id)).tasks.find((t) => t.tool === 'calling.sheet').status, 'done');
  // on its day the sweep builds it by itself
  const cg3 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { callSheet: true, creative: 'none', startDate: '2026-11-26' } }, { ...callBase, now: NOW }); Agent.config.clock = () => Date.parse('2026-11-25T12:00:00+05:30'); await Agent.approve(admin, cg3.run.id, callBase); await Agent.drain();
  await Agent.sweep({ ...callBase, force: true }); await Agent.drain(); assert.equal((await Agent.detail(admin, cg3.run.id)).tasks.find((t) => t.tool === 'calling.sheet').status, 'queued', 'before its day nothing is built');
  Agent.config.clock = () => Date.parse('2026-11-28T10:05:00+05:30'); await Agent.sweep({ ...callBase, force: true }); await Agent.drain(); assert.equal((await Agent.detail(admin, cg3.run.id)).tasks.find((t) => t.tool === 'calling.sheet').status, 'done', 'on its day the sweep builds it'); Agent.config.clock = () => Date.now();
  assert.ok(((await S.q(`PRAGMA table_info("OmniMkAgentTask")`)).some((c) => c.name === 'args')), 'the tasks table has its args column');
  console.log('PASS the call sheet: built the day after the plan (or on "Build it now"), Hot then Warm leads that came in since the plan started, WhatsApp leads with what they asked and when to call, numbers masked, the rules said; the agent calls nobody and there is no calling tool; a login the CRM does not know gets a reason and a retry; the sweep builds it on its day');

  // 23. the WhatsApp assistant's campaign: the agent PREPARES it (saved as READY), a person still presses Send; every refusal says why and the by-hand step stays
  const waP = (params, bk = 'own') => { const pl = P.build('Promote us for 1 days on WhatsApp', ctx, params, NOW).plan; pl.businessKey = bk; return P.taskSpecs(pl).map((t) => t.tool); };
  assert.deepEqual(waP({}).slice(-2), ['manual.whatsapp', 'whatsapp.campaign'], 'our own company: the campaign step comes with the WhatsApp message'); assert.ok(!waP({}, 'c:acme').includes('whatsapp.campaign'), 'not for a client: the assistant is our own marketing number'); assert.ok(!waP({ waCampaign: false }).includes('whatsapp.campaign'), 'it can be switched off');
  assert.ok(!P.taskSpecs({ ...P.build('Promote us for 1 days', ctx, {}, NOW).plan, businessKey: 'own' }).some((t) => t.tool === 'whatsapp.campaign'), 'no WhatsApp in the plan, no campaign step');
  const tplOne = { id: 'T1', name: 'Promo hello', metaName: 'promo_hello', language: 'en', body: 'Hi {{1}}, thanks for asking about {{2}}. Reply STOP to opt out.', blanks: 2 };
  const waNames = []; const previews = []; const creates = []; let waSwitch = true; let waTpls = [tplOne]; let waPeople = 2; let createErr = null;
  const WAS = { waSettings: async () => ({ campaignsOn: waSwitch }), WA: { call: async (u, name, input) => {
    waNames.push(name);
    if (name === 'campaign.templates') return { templates: waTpls };
    if (name === 'campaign.preview') { previews.push(input); const t = waTpls.find((x) => x.id === input.templateId); if (!t || (input.varMap || []).length < t.blanks) return { error: `This template has ${t ? t.blanks : 0} blanks ({{1}} ...): say what fills each one.`, status: 400 }; return { template: { id: t.id, name: t.name, metaName: t.metaName, body: t.body }, people: Array.from({ length: waPeople }, (_, i) => ({ leadId: `LD${i}`, name: ['Hari', 'Ravi'][i] || `P${i}`, phoneHint: `+91 •••••${1000 + i}`, band: i ? 'Warm' : 'Hot', text: t.body.replace('{{1}}', ['Hari', 'Ravi'][i]).replace('{{2}}', input.varMap[1] === 'business' ? 'TeamLink' : 'recruitment') })), skipped: { 'asked us to stop': 1 }, samples: {}, considered: waPeople + 1 }; }
    if (name === 'campaign.create') { creates.push(input); return createErr ? { error: createErr, status: 409 } : { ok: true, id: 'wmk-test', people: waPeople, skipped: {} }; }
    throw new Error(`the agent called a WhatsApp service it must not: ${name}`);
  } } };
  const waBase = { ...base, svc: WAS };
  const wc = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days on WhatsApp', business: 'own', params: { platforms: ['whatsapp'], creative: 'none' } }, { ...waBase, now: NOW });
  assert.ok(wc.preflight.warnings.some((w) => /WhatsApp campaign: the agent only saves it as ready after you pick the template/.test(w)), 'the preview says what the step does'); assert.ok(wc.run.plan.assumptions.some((a) => /prepare the campaign itself, through the WhatsApp assistant/.test(a) && /a person sends the approved message by hand/.test(a)));
  waSwitch = false; assert.ok((await Agent.detail(admin, wc.run.id, waBase)).preflight.warnings.some((w) => /WhatsApp promotions are switched off .* cannot be approved yet; a person sends the approved message by hand/.test(w)), 'with promotions off the preview says so'); waSwitch = true;
  await Agent.approve(admin, wc.run.id, waBase); await Agent.drain(); r = await Agent.detail(admin, wc.run.id, waBase); const camp = r.tasks.find((t) => t.tool === 'whatsapp.campaign');
  assert.equal(camp.status, 'awaiting_approval', 'the plan\'s approval prepares nothing'); assert.equal(creates.length, 0); assert.ok(camp.gated && !camp.outward && camp.needsDetails, 'it waits for its own approval, though it reaches nobody'); assert.ok(r.events.some((e) => e.kind === 'needs_approval' && /freezes who a message will go to and its words/.test(e.text)));
  assert.equal(r.tasks.find((t) => t.tool === 'manual.whatsapp').status, 'waiting', 'the by-hand step is there whatever happens to the campaign');
  // what the dialog shows: the templates, the blanks, every person and the exact words
  pr = await Agent.prepareTask(admin, camp.id, { ...waBase, query: {} }); assert.equal(pr.ready, true, pr.reason); assert.deepEqual([pr.templates.length, pr.choice.templateId, pr.choice.varMap, pr.choice.bands, pr.choice.gapDays], [1, 'T1', ['name', 'service'], [], 7]);
  assert.deepEqual([pr.preview.total, pr.preview.people[0].text, pr.preview.people[1].band, pr.preview.skipped], [2, 'Hi Hari, thanks for asking about recruitment. Reply STOP to opt out.', 'Warm', { 'asked us to stop': 1 }], 'every person with the exact words'); assert.ok(pr.preview.people.every((x) => /•/.test(x.phoneHint) && !('e164' in x)), 'numbers stay masked');
  pr = await Agent.prepareTask(admin, camp.id, { ...waBase, query: { templateId: 'T1', varMap: 'name,business', bands: 'Hot,Cold,Nonsense', gapDays: '3' } }); assert.deepEqual(previews[previews.length - 1], { templateId: 'T1', varMap: ['name', 'business'], audience: { bands: ['Hot', 'Cold'], gapDays: 3 } }, 'the person\'s choices reach the preview (an unknown band is dropped)'); assert.ok(/about TeamLink\./.test(pr.preview.people[0].text));
  // every refusal says why, and nothing is created
  const refuse = async (why, re) => { const x = await Agent.prepareTask(admin, camp.id, { ...waBase, query: {} }); assert.equal(x.ready, false, why); assert.ok(re.test(x.reason), `${why}: ${x.reason}`); const a = await Agent.approveTask(admin, camp.id, { campaignName: 'Week 1 promo' }, waBase); assert.equal(a.code, 'not_ready', why); assert.ok(re.test(a.error), a.error); assert.equal(creates.length, 0, why); };
  waSwitch = false; await refuse('promotions off', /WhatsApp promotions are switched off\. An Admin switches them on in Settings > WhatsApp AI > Marketing assistant\. Until then a person sends the approved message by hand/); waSwitch = true;
  waTpls = []; await refuse('no approved template', /no WhatsApp template approved by Meta.*a person sends the approved message by hand/); waTpls = [tplOne];
  waPeople = 0; await refuse('nobody agreed', /Nobody would receive this campaign: nobody in the audience has agreed to promotions on WhatsApp yet\. Until then a person sends the approved message by hand/); waPeople = 2;
  pr = await Agent.prepareTask(admin, camp.id, { ...waBase, query: { varMap: 'name' } }); assert.equal(pr.ready, false); assert.ok(/blanks .* say what fills each one/.test(pr.reason), 'too few blanks: the assistant\'s own message');
  assert.equal((await Agent.approveTask(other, camp.id, { campaignName: 'x campaign' }, waBase)).status, 404, 'a stranger cannot approve it'); assert.ok((await Agent.approveTask(admin, camp.id, { campaignName: 'xx' }, waBase)).error, 'the campaign needs a name');
  // approved: saved as READY through the service, once, as the draft the person chose; nothing is sent
  ap = await Agent.approveTask(admin, camp.id, { campaignName: 'Week 1 promo', templateId: 'T1', varMap: 'name,service', bands: '', gapDays: 7 }, waBase); assert.ok(!ap.error, ap.error); await Agent.drain(); r = await Agent.detail(admin, wc.run.id, waBase);
  const cdone = r.tasks.find((t) => t.tool === 'whatsapp.campaign'); assert.equal(cdone.status, 'done', cdone.error); assert.equal(creates.length, 1); assert.deepEqual(creates[0], { name: 'Week 1 promo', templateId: 'T1', varMap: ['name', 'service'], audience: { bands: [], gapDays: 7 } });
  assert.ok(/saved as READY for 2 customers\. Nothing was sent: open WhatsApp > Campaigns/.test(cdone.summary) && cdone.refs[0].page === 'whatsapp' && cdone.data.campaignId === 'wmk-test', cdone.summary); assert.ok(/approved by Test Admin to save the WhatsApp campaign "Week 1 promo" as ready with the template "Promo hello" for 2 customers/.test(r.events.find((e) => e.kind === 'task_approved').text), r.events.find((e) => e.kind === 'task_approved').text);
  assert.ok(/WhatsApp campaign prepared: 2 customers who agreed to promotions, saved as READY in WhatsApp > Campaigns\. Nothing was sent: a person presses Send\./.test(r.live.lines.join(' ')) && /Nothing was posted, sent, called or spent by the agent\./.test(r.live.lines.join(' ')), r.live.lines.join(' | '));
  assert.ok(waNames.every((n) => ['campaign.templates', 'campaign.preview', 'campaign.create'].includes(n)), `only the campaign services were used: ${[...new Set(waNames)]}`); assert.deepEqual(Tools.catalog().filter((t) => t.needsApproval).map((t) => t.id).sort(), ['client.review', 'social.post', 'whatsapp.campaign']); assert.deepEqual(Tools.catalog().filter((t) => t.risk === 'outward').map((t) => t.id).sort(), ['client.review', 'social.post'], 'it is not an outward tool: nothing leaves TeamLink');
  // a failure keeps the reason; a retry asks again; cancelling the step leaves the by-hand step to finish the run
  const wc2 = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days on WhatsApp', business: 'own', params: { platforms: ['whatsapp'], creative: 'none' } }, { ...waBase, now: NOW }); await Agent.approve(admin, wc2.run.id, waBase); await Agent.drain();
  const c2 = (await Agent.detail(admin, wc2.run.id, waBase)).tasks.find((t) => t.tool === 'whatsapp.campaign'); createErr = 'WhatsApp promotions are switched off. An Admin switches them on in Settings > WhatsApp AI > Marketing assistant.';
  await Agent.approveTask(admin, c2.id, { campaignName: 'Second try' }, waBase); await Agent.drain(); r = await Agent.detail(admin, wc2.run.id, waBase); assert.equal(r.tasks.find((t) => t.id === c2.id).status, 'failed'); assert.ok(/WhatsApp promotions are switched off/.test(r.tasks.find((t) => t.id === c2.id).error), 'the reason is plain');
  createErr = null; const cBefore = creates.length; r = await Agent.retryTask(admin, c2.id, waBase); assert.equal(r.tasks.find((t) => t.id === c2.id).status, 'awaiting_approval', 'a retry asks again'); assert.equal(creates.length, cBefore, 'a retry request creates nothing');
  r = await Agent.cancelTask(admin, c2.id); assert.equal(r.tasks.find((t) => t.id === c2.id).status, 'cancelled'); const wman = r.tasks.find((t) => t.tool === 'manual.whatsapp'); const wdr = r.tasks.find((t) => t.tool === 'content.draft'); assert.ok(!(await C.approve(admin, wdr.refs[0].id)).error);
  m = await Agent.markManual(admin, wman.id, { action: 'done', note: 'sent from Campaigns by hand' }); assert.ok(!m.error, m.error); r = await Agent.detail(admin, wc2.run.id, waBase); assert.equal(r.run.status, 'done', 'with the campaign step cancelled the person\'s step finishes the run, as before');
  console.log('PASS the WhatsApp campaign: our own company\'s WhatsApp plans get a step that saves a campaign as READY through the WhatsApp assistant\'s services after the person picks the Meta-approved template and sees every person and the exact words; promotions off, no approved template, nobody who agreed, too few blanks: each says why and creates nothing; only the three campaign services are used, nothing is sent; a failure asks again, and the by-hand step remains');

  // 24. a step approved just as the run is being closed up is never lost (a race that left the last approved step "queued" for good): a run that still has work queued is worked on whatever state it is in
  const rg = await Agent.startRun(admin, { goal: 'Promote TeamLink Consultants for 1 days', business: 'own', params: { creative: 'none', platforms: ['instagram'] } }, { ...base, now: NOW }); await Agent.approve(admin, rg.run.id, base); await Agent.drain();
  let rd = await Agent.detail(admin, rg.run.id); assert.equal(rd.run.status, 'attention'); const draftT = rd.tasks.find((t) => t.tool === 'content.draft'); assert.equal(draftT.status, 'done');
  await S.run(`UPDATE "OmniMkAgentTask" SET status = 'queued', output = NULL, finishedAt = NULL WHERE id = ?`, draftT.id); // the stale state: a step queued while the run says "needs you"
  Agent.kick(rg.run.id, base); await Agent.drain(); rd = await Agent.detail(admin, rg.run.id); assert.equal(rd.tasks.find((t) => t.id === draftT.id).status, 'done', 'a queued step of a run that said "needs you" is worked on'); assert.equal(rd.run.status, 'attention', 'and the run is closed up again afterwards');
  await S.run(`UPDATE "OmniMkAgentTask" SET status = 'queued', output = NULL, finishedAt = NULL WHERE id = ?`, draftT.id); await Agent.sweep({ ...base, force: true }); await Agent.drain(); assert.equal((await Agent.detail(admin, rg.run.id)).tasks.find((t) => t.id === draftT.id).status, 'done', 'the sweep finds it too');
  console.log('PASS the lost-approval race: a run that still has a step queued is worked on even when it said "needs you", the sweep finds it, and the run is closed up again afterwards');

  // 13. every tool is listed with its cost and risk: two outward tools, each behind its own approval
  const cat = Tools.catalog(); assert.ok(cat.length >= 8 && cat.every((t) => t.cost.word && ['internal', 'outward'].includes(t.risk))); assert.deepEqual(cat.filter((t) => t.risk === 'outward').map((t) => t.id).sort(), ['client.review', 'social.post'], 'only the two Phase 2 outward tools exist: bulk WhatsApp, calls and ad spend are not tools');
  assert.ok(!cat.some((t) => t.cost.kind === 'paid') && cat.every((t) => t.cost.rupees === 0));
  console.log('PASS the tool list: each tool with its cost and risk, two outward (post, ask the client), none paid');
  console.log('\nALL AGENT CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
