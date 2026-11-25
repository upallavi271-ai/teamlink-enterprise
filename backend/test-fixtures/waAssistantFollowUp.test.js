// AI WhatsApp Marketing Assistant, phase 3 (omniwa/gate.js + followup.js): the one send gate and the follow-ups.
//   node backend/test-fixtures/waAssistantFollowUp.test.js     (throw-away copy of prisma/sandbox.db; TEST_MODE: nothing is sent, the WhatsApp send is a stand-in, no AI model is asked)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-follow-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret'; // the stop lists hash numbers with a server secret process.env.TEST_ALLOW_AI = '1'; process.env.WA_AI_FAST = '0';
const prisma = require('../src/db');
const A = require('../src/omniwa/assist');
const AL = require('../src/omniwa/assistLead');
const Cfg = require('../src/omniwa/config');
const Agent = require('../src/omniwa/agent');
const Gate = require('../src/omniwa/gate');
const FU = require('../src/omniwa/followup');
const S = require('../src/outreach/store');
const DB = require('../src/crm/schema');
const { ensure } = require('../src/omniwa/schema');
const HOUR = 3600000;
const J = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x));

(async () => {
  await ensure(); await DB.ensure();
  // the sandbox copy has no Outreach tables (they come with a migration on the server): the stop-list table the gate reads is made here, empty
  await S.run('CREATE TABLE IF NOT EXISTS "OutreachSuppression" ("addressHash" TEXT NOT NULL, "channel" TEXT NOT NULL, "reason" TEXT, "at" BIGINT, "source" TEXT, PRIMARY KEY ("addressHash", "channel"))');
  const ai = require('../src/utils/ai'); ai.chatJson = async () => { throw new Error('no model in this test'); };
  const messaging = require('../src/utils/messaging'); const sent = []; let n = 0;
  messaging.send = async (channel, o) => { n += 1; sent.push({ channel, ...o }); return { ok: true, outcome: 'sent', providerRef: `zzfu${n}` }; };
  const admin = await prisma.user.findFirst({ where: { OR: [{ role: { in: ['ADMIN', 'SUPER_ADMIN'] } }, { atsRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }] } });
  const adminMe = { ...(await require('../src/utils/identity').resolveIdentity(admin.id)), contact: true };
  const adminUser = { name: 'Test Admin' };
  await Cfg.save(adminUser, { enabled: true, systemPrompt: 'You help.', fallbackMessage: 'Our team will contact you soon.' });
  await Cfg.setMarketingNumber('zzn', true);
  await S.run('DELETE FROM "OmniWaKnowledge"');
  for (const [category, question, answer] of [['pricing', 'SEO plan', '₹10,000 per month + GST.'], ['hours', 'Working hours', 'Monday to Saturday, 9:30 am to 6:30 pm.']]) await Cfg.kbSave(adminUser, null, { category, question, answer, numberId: 'zzn' });
  await A.saveSettings(adminUser, { enabled: true, businessName: 'Acme Marketing', noAnswer: '', aiWording: true, collectLeads: true });
  const quiet = require('../src/utils/omniRules');
  await quiet.saveSettings(adminUser, { enabled: false }); // the clock must not decide these tests
  const SUF = String(Date.now()).slice(-7); let id = 0;
  const inbound = (from, text) => { id += 1; return Agent.onInbound({ channel: 'WhatsApp', from, text, id: `wamid.ZZF${SUF}${id}`, at: new Date(), name: 'ZZTEST Visitor', numberId: 'zzn' }, { personType: null, review: true, reason: 'none' }); };
  const run = () => Agent.tick(Date.now(), { force: true });
  const say = async (from, text) => { await inbound(from, text); const before = sent.length; await run(); return sent.length > before ? sent[sent.length - 1].vars[0] : null; };
  const ago = (e164, hours) => S.run('UPDATE "OmniWaConv" SET lastInboundAt = ?, lastAiAt = ? WHERE e164 = ?', Date.now() - hours * HOUR, Date.now() - hours * HOUR, e164);
  const rows = (convId) => S.q('SELECT * FROM "OmniWaFollowUp" WHERE convId = ? ORDER BY step, createdAt', convId);
  const bells = (like) => prisma.notification.count({ where: { title: { contains: like } } });

  // a real lead through the real chat: details complete, CRM lead, consent line
  const e1 = `9190${SUF}`;
  for (const t of ['How much is the SEO plan?', 'Ravi Kumar', 'We run a small hotel and need more online bookings', 'around 20k per month', 'tomorrow after 5 pm']) await say(e1, t);
  let conv = await Agent.convOf(e1); assert.ok(AL.leadOf(conv).done && AL.leadOf(conv).crmLeadId, 'the lead is saved');
  await S.run('UPDATE "OmniWaConv" SET state = \'active\', handoffReason = NULL WHERE id = ?', conv.id); // a person is not needed for what follows

  // 1. the gate
  let g = await Gate.check(conv, { template: null });
  assert.deepEqual([g.ok, g.via], [true, 'text'], 'inside the 24 hours: free text');
  await ago(e1, 30); conv = await Agent.convOf(e1);
  g = await Gate.check(conv, { template: null }); assert.deepEqual([g.ok, g.code], [false, 'NO_TEMPLATE'], 'outside the window with no template: refused');
  g = await Gate.check(conv, { template: { name: 'tl_followup', language: 'en', vars: ['Ravi'] } }); assert.deepEqual([g.ok, g.via], [true, 'template'], 'outside the window with a template and consent: the template');
  const stranger = await (async () => { const e = `9193${SUF}`; await inbound(e, 'hello'); const c = await Agent.convOf(e); await S.run('UPDATE "OmniWaConv" SET lastInboundAt = ? WHERE id = ?', Date.now() - 40 * HOUR, c.id); return Agent.convOf(e); })();
  g = await Gate.check(stranger, { template: { name: 'tl_followup', language: 'en', vars: [] } }); assert.deepEqual([g.ok, g.code], [false, 'NO_CONSENT'], 'no recorded consent: no template to somebody who only said hello');
  await S.run('INSERT OR IGNORE INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', e1, 'reply', 'STOP', Date.now());
  g = await Gate.check(conv, { template: { name: 'tl_followup', language: 'en', vars: [] } }); assert.deepEqual([g.ok, g.code], [false, 'OPTED_OUT'], 'a stop list always wins'); await S.run('DELETE FROM "OmniWaOptOut" WHERE e164 = ?', e1);
  await require('../src/crm/campaigns').optOut('whatsapp', `+${e1}`, { reason: 'test' });
  g = await Gate.check(conv, { template: { name: 'tl_followup', language: 'en', vars: [] } }); assert.deepEqual([g.ok, g.code], [false, 'OPTED_OUT'], 'the CRM opt-out list counts too');
  await prisma.$executeRawUnsafe('DELETE FROM "CrmOptOut"').catch(() => null);
  g = await Gate.check(conv, { template: { name: 'tl_followup', language: 'en', vars: [] } }); assert.equal(g.ok, true, 'the lists are clear again');
  const nowIst = new Date(Date.now() + 5.5 * HOUR); const hm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  await quiet.saveSettings(adminUser, { enabled: true, from: hm(new Date(nowIst.getTime() - 2 * HOUR)), to: hm(new Date(nowIst.getTime() + 2 * HOUR)) });
  g = await Gate.check(conv, { template: { name: 'tl_followup', language: 'en', vars: [] } }); assert.deepEqual([g.ok, g.code, g.defer], [false, 'QUIET_HOURS', true], 'quiet hours wait, they do not refuse');
  assert.equal((await Gate.check(conv, { template: { name: 'tl_followup', language: 'en', vars: [] }, quiet: false })).ok, true);
  await quiet.saveSettings(adminUser, { enabled: false });
  console.log('PASS the gate: text inside 24 hours, a template outside it (set + consent), a stop list or the CRM opt-out list always wins, quiet hours wait');

  // 2. the settings
  assert.equal((await FU.settings()).enabled, false, 'off until an Admin switches it on');
  assert.deepEqual(FU.clean({}).intervalsHours, [4, 48, 120]);
  assert.deepEqual(FU.clean({ intervalsHours: '2, 30, 90, 200, 300, 400, 500' }).intervalsHours, [2, 30, 90, 200, 300], 'at most five steps');
  assert.match((await FU.saveSettings(adminUser, { intervalsHours: [48, 24] })).error, /later than the one before/);
  assert.match((await FU.saveSettings(adminUser, { template: { name: 'Bad Name!' } })).error, /lowercase letters/);
  assert.equal((await FU.sweep(Date.now())).sandbox, true, 'never started in the test sandbox: only a test calls it with force');
  assert.equal((await FU.sweep(Date.now(), { force: true })).off, true);
  console.log('PASS settings: off by default, intervals checked, template name checked, never runs in the sandbox by itself');

  // 3. drafting at the intervals, approval, the three steps
  await FU.saveSettings(adminUser, { enabled: true, approval: true, intervalsHours: [4, 48, 120] });
  await ago(e1, 1); let r = await FU.sweep(Date.now(), { force: true });
  assert.equal(r.drafted, 0, 'one hour of silence is not enough'); assert.equal((await rows(conv.id)).length, 0);
  const bellsB = await bells('follow-up for');
  await ago(e1, 5); r = await FU.sweep(Date.now(), { force: true });
  assert.equal(r.drafted, 1); let d = await rows(conv.id); assert.equal(d.length, 1); assert.deepEqual([d[0].step, d[0].status], [1, 'approval']);
  assert.equal(d[0].body, 'Hello Ravi! We wanted to follow up on your SEO plan enquiry. Would you like us to share more information about SEO plan?\n\nReply STOP to stop messages from us.', 'the owner\'s example, filled from what he told the assistant');
  assert.ok(!/₹|discount|offer/i.test(d[0].body), 'nothing about money in a follow-up'); assert.equal((await bells('follow-up for')) - bellsB, 1, 'the team is told once that a draft waits');
  r = await FU.sweep(Date.now(), { force: true }); assert.equal(r.drafted, 0, 'one draft at a time'); assert.equal((await rows(conv.id)).length, 1);
  const before = sent.length;
  let dec = await FU.decide(adminMe, d[0].id, { approve: true });
  assert.ok(dec.ok && dec.result === 'sent', J(dec)); assert.equal(sent.length, before + 1);
  assert.equal(sent[sent.length - 1].vars[0], d[0].body); assert.equal(sent[sent.length - 1].template, undefined, 'inside the window: plain text, no template');
  d = await rows(conv.id); assert.deepEqual([d[0].status, d[0].mode, d[0].decidedByName === adminMe.name || !!d[0].decidedByName], ['sent', 'text', true]);
  conv = await Agent.convOf(e1); assert.equal(AL.leadOf(conv).followStep, 1);
  assert.equal((await S.q('SELECT template FROM "OmniWaMessage" WHERE providerMessageId = ?', d[0].providerMessageId))[0].template, 'Follow-up', 'the message is marked as a follow-up for the analytics');
  assert.ok((await DB.all('SELECT "subject" FROM "CrmActivity" WHERE "leadId" = ?', AL.leadOf(conv).crmLeadId)).some((a) => /^WhatsApp follow-up 1 sent/.test(a.subject)), 'on the CRM timeline');
  assert.equal((await FU.decide(adminMe, d[0].id, { approve: true })).status, 409, 'a draft is decided once');

  // step 2: 48 hours later the window is closed: no template set, so it cannot go; set the template and it goes as the template
  await S.run('UPDATE "OmniWaConv" SET lastInboundAt = ?, lastAiAt = ? WHERE id = ?', Date.now() - 60 * HOUR, Date.now() - 60 * HOUR, conv.id);
  await S.run('UPDATE "OmniWaConv" SET collected = ? WHERE id = ?', JSON.stringify({ ...JSON.parse((await Agent.convOf(e1)).collected), assistLead: { ...AL.leadOf(await Agent.convOf(e1)), followAt: Date.now() - 50 * HOUR } }), conv.id);
  r = await FU.sweep(Date.now(), { force: true }); assert.equal(r.drafted, 1); d = await rows(conv.id); const second = d.find((x) => x.step === 2);
  assert.match(second.body, /^Hello Ravi, just checking if you had a chance to think about your SEO plan enquiry\. We have noted that you prefer a call tomorrow after 5 pm\. Shall we arrange a call\?/);
  const b1 = sent.length; dec = await FU.decide(adminMe, second.id, { approve: true });
  assert.equal(dec.result, 'waiting'); assert.equal(dec.status, 409); assert.match(dec.error, /no follow-up template is set/); assert.equal(sent.length, b1, 'nothing was sent');
  assert.equal((await rows(conv.id)).find((x) => x.step === 2).status, 'approval', 'it waits, with the reason on it');
  await FU.saveSettings(adminUser, { template: { name: 'tl_followup', language: 'en', vars: ['name', 'service'] } });
  dec = await FU.decide(adminMe, second.id, { approve: true, text: 'Hello Ravi, shall we talk about the SEO plan this week?' });
  assert.equal(dec.result, 'sent', J(dec)); const tsend = sent[sent.length - 1];
  assert.deepEqual([tsend.template, tsend.vars, tsend.kind], [{ name: 'tl_followup', language: 'en' }, ['Ravi', 'SEO plan'], 'text'], 'outside the window: the approved template with the customer\'s name and service');
  assert.match(tsend.text, /shall we talk about the SEO plan this week\?\n\nReply STOP to stop messages from us\.$/, 'a person\'s edit is kept, and the STOP line is added back');
  const sent2 = (await rows(conv.id)).find((x) => x.step === 2); assert.deepEqual([sent2.status, sent2.mode], ['sent', 'template']);
  assert.equal((await S.q('SELECT template, aiGenerated FROM "OmniWaMessage" WHERE providerMessageId = ?', sent2.providerMessageId))[0].template, 'tl_followup');

  // step 3 is the last one; after it nothing more
  await S.run('UPDATE "OmniWaConv" SET lastInboundAt = ?, lastAiAt = ? WHERE id = ?', Date.now() - 200 * HOUR, Date.now() - 200 * HOUR, conv.id);
  await S.run('UPDATE "OmniWaConv" SET collected = ? WHERE id = ?', JSON.stringify({ ...JSON.parse((await Agent.convOf(e1)).collected), assistLead: { ...AL.leadOf(await Agent.convOf(e1)), followAt: Date.now() - 130 * HOUR } }), conv.id);
  r = await FU.sweep(Date.now(), { force: true }); assert.equal(r.drafted, 1); const third = (await rows(conv.id)).find((x) => x.step === 3);
  assert.match(third.body, /this is our last message about your SEO plan enquiry/);
  dec = await FU.decide(adminMe, third.id, { approve: true }); assert.equal(dec.result, 'sent');
  r = await FU.sweep(Date.now() + 1000 * HOUR, { force: true }); assert.equal(r.drafted, 0, 'after the last step: nothing more'); assert.equal((await rows(conv.id)).length, 3);
  console.log('PASS the three steps: nothing before the interval, the owner\'s example text, one draft at a time, approval sends it, a window-closed one waits with its reason and then goes as the approved template, the last one says so, then nothing');

  // 4. what stops a series
  const mk = async (suffix, lead, { hours = 5, extra = {} } = {}) => {
    const e = `9195${SUF}${suffix}`; const cid = S.newId('wac'); const t = Date.now();
    await S.run('INSERT INTO "OmniWaConv" (id, e164, personType, name, numberId, mode, state, aiTurns, collected, lastInboundAt, lastAiAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', cid, e, 'LEAD', 'Test Person', 'zzn', extra.mode || 'ai', extra.state || 'active', 2, JSON.stringify({ assistLead: { interestAt: t - 50 * HOUR, name: 'Meena', service: 'SEO plan', ...lead } }), t - hours * HOUR, t - hours * HOUR, t - 60 * HOUR, t);
    return { e, cid };
  };
  let c = await mk(1, { declined: true }); r = await FU.sweep(Date.now(), { force: true }); assert.equal((await rows(c.cid)).length, 0, 'said no: no follow-up');
  c = await mk(2, {}, { extra: { mode: 'paused' } }); await FU.sweep(Date.now(), { force: true }); assert.equal((await rows(c.cid)).length, 0, 'a person has the chat: no follow-up');
  c = await mk(3, {}); await S.run('INSERT INTO "OmniWaMessage" (id, e164, convId, direction, body, status, at, createdAt) VALUES (?,?,?,?,?,?,?,?)', S.newId('wam'), c.e, c.cid, 'IN', 'sorry, not interested, too costly', 'received', Date.now() - 6 * HOUR, Date.now());
  await FU.sweep(Date.now(), { force: true }); assert.equal((await rows(c.cid)).length, 0, 'said they are not interested in the chat: no follow-up'); assert.equal(AL.leadOf((await S.q('SELECT * FROM "OmniWaConv" WHERE id = ?', c.cid))[0]).followStop, true, 'and the series is ended for good');
  c = await mk(4, {}); await S.run('INSERT INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', c.e, 'reply', 'STOP', Date.now()); await FU.sweep(Date.now(), { force: true }); assert.equal((await rows(c.cid)).length, 0, 'a stop list: no follow-up');
  // a draft is waiting, then STOP arrives: it is not sent
  c = await mk(5, {}); await FU.sweep(Date.now(), { force: true }); let w = (await rows(c.cid))[0]; assert.ok(w && w.status === 'approval');
  await S.run('INSERT INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', c.e, 'reply', 'STOP', Date.now());
  const b2 = sent.length; dec = await FU.decide(adminMe, w.id, { approve: true }); assert.equal(dec.result, 'stopped'); assert.equal(sent.length, b2, 'STOP after the draft: nothing sent');
  // the customer writes back: the waiting draft is dropped and the count starts again
  c = await mk(6, { followStep: 1 }, { hours: 50 }); await FU.sweep(Date.now(), { force: true }); w = (await rows(c.cid))[0]; assert.ok(w && w.status === 'approval' && w.step === 2);
  await Agent.onInbound({ channel: 'WhatsApp', from: c.e, text: 'yes please call me', id: `wamid.ZZF${SUF}back`, at: new Date(), name: 'ZZTEST', numberId: 'zzn' }, { personType: null, review: true, reason: 'none' });
  assert.equal((await rows(c.cid))[0].status, 'stopped'); assert.equal((await rows(c.cid))[0].reason, 'They wrote back.'); assert.equal(AL.leadOf((await S.q('SELECT * FROM "OmniWaConv" WHERE id = ?', c.cid))[0]).followStep, 0, 'the count starts again');
  // a draft made, then the customer wrote before a person decided: deciding does not send
  c = await mk(7, {}); await FU.sweep(Date.now(), { force: true }); w = (await rows(c.cid))[0]; await S.run('UPDATE "OmniWaConv" SET lastInboundAt = ? WHERE id = ?', Date.now() + 5, c.cid);
  const b3 = sent.length; dec = await FU.decide(adminMe, w.id, { approve: true }); assert.equal(dec.result, 'stopped'); assert.equal(sent.length, b3);
  // the CRM lead is lost
  conv = await Agent.convOf(`9196${SUF}`); c = await mk(8, {}); const crmId = (await DB.one('SELECT "id" FROM "CrmLead" LIMIT 1')).id;
  await S.run('UPDATE "OmniWaConv" SET collected = ? WHERE id = ?', JSON.stringify({ assistLead: { interestAt: Date.now() - 50 * HOUR, name: 'Meena', service: 'SEO plan', crmLeadId: crmId } }), c.cid);
  const crmRow = await DB.one('SELECT "stage" FROM "CrmLead" WHERE "id" = ?', crmId); await DB.run('UPDATE "CrmLead" SET "stage" = \'Lost\' WHERE "id" = ?', crmId);
  await FU.sweep(Date.now(), { force: true }); assert.equal((await rows(c.cid)).length, 0, 'the CRM lead is Lost: no follow-up'); await DB.run('UPDATE "CrmLead" SET "stage" = ? WHERE "id" = ?', crmRow.stage, crmId);
  // skipping, and stopping all
  c = await mk(9, {}); await FU.sweep(Date.now(), { force: true }); w = (await rows(c.cid))[0];
  const recruiter = { id: 'nobody', name: 'Nobody', role: 'RECRUITER', atsRole: 'RECRUITER' };
  assert.equal((await FU.decide(recruiter, w.id, { approve: true })).status, 403, 'a login that does not own the lead cannot decide');
  dec = await FU.decide(adminMe, w.id, { approve: false, stopAll: true }); assert.equal(dec.result, 'skipped');
  assert.equal(AL.leadOf((await S.q('SELECT * FROM "OmniWaConv" WHERE id = ?', c.cid))[0]).followStop, true); await FU.sweep(Date.now() + 500 * HOUR, { force: true }); assert.equal((await rows(c.cid)).length, 1, 'stopped for this customer: no more drafts');
  // the assistant off: no drafts at all
  await A.saveSettings(adminUser, { enabled: false }); c = await mk(10, {}); await FU.sweep(Date.now(), { force: true }); assert.equal((await rows(c.cid)).length, 0, 'the assistant is off: no follow-ups'); await A.saveSettings(adminUser, { enabled: true });
  console.log('PASS what stops it: said no, a person has the chat, "not interested" in the chat, a stop list (also after the draft), they wrote back (the draft is dropped, the count restarts), the CRM lead lost, skip, stop all, a login without the lead cannot decide, assistant off');

  // 5. no approval: it goes by itself, still through the gate; quiet hours make it wait
  await FU.saveSettings(adminUser, { approval: false, template: { name: '' } });
  c = await mk(11, {}); const nowIst2 = new Date(Date.now() + 5.5 * HOUR);
  await quiet.saveSettings(adminUser, { enabled: true, from: hm(new Date(nowIst2.getTime() - 2 * HOUR)), to: hm(new Date(nowIst2.getTime() + 2 * HOUR)) });
  const toThem = () => sent.filter((x) => x.to === `+${c.e}`).length; // other waiting chats of this test may go in the same sweep: look at this one
  r = await FU.sweep(Date.now(), { force: true });
  assert.ok(r.drafted >= 1 && r.waiting >= 1); assert.equal(toThem(), 0, 'quiet hours: it waits'); w = (await rows(c.cid))[0]; assert.deepEqual([w.status, /Quiet hours/.test(w.reason)], ['ready', true]);
  await quiet.saveSettings(adminUser, { enabled: false }); r = await FU.sweep(Date.now(), { force: true });
  assert.ok(r.sent >= 1); assert.equal(toThem(), 1); assert.equal((await rows(c.cid))[0].status, 'sent');
  console.log('PASS no approval: the draft waits for the quiet hours to end and then goes by itself through the gate');

  // 6. the list a person sees, and the wiring
  await FU.saveSettings(adminUser, { approval: true });
  const list = await FU.list(adminMe, {}); assert.ok(list.rows.every((x) => ['approval', 'ready'].includes(x.status)) && list.counts.waiting === list.rows.length && list.rows.every((x) => x.canDecide));
  assert.ok((await FU.list(adminMe, { status: 'all' })).rows.some((x) => x.status === 'sent'), 'all = the history too');
  const routes = require('../src/routes/omniWa').stack.filter((l) => l.route).map((l) => [Object.keys(l.route.methods)[0], l.route.path, l.route.stack.length]);
  for (const [m, p, adminOnly] of [['get', '/followups', false], ['post', '/followups/:id/decide', false], ['get', '/followup-settings', true], ['put', '/followup-settings', true]]) { const hit = routes.find((x) => x[0] === m && x[1] === p); assert.ok(hit, `${m} ${p}`); if (adminOnly) assert.ok(hit[2] >= 2, `${m} ${p} is Admin only`); }
  const idx = fs.readFileSync(path.join(BACK, 'src/index.js'), 'utf8');
  assert.ok(/require\('\.\/omniwa\/followup'\)\.start\(\)/.test(idx) && idx.indexOf("omniwa/followup').start()") < idx.indexOf('if (sandbox.isSandbox()) { sandbox.banner'), 'the ticker is started with the agent');
  console.log('PASS the list, the Admin-only settings routes, the ticker is wired in');

  console.log('waAssistantFollowUp tests: all passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
