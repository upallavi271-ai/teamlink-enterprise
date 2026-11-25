// AI WhatsApp Marketing Assistant, phase 5 (omniwa/analytics.js + omniwa/services.js): analytics from real data only, and the services the AI Marketing Agent may call.
//   node backend/test-fixtures/waAssistantAnalytics.test.js     (throw-away copy of prisma/sandbox.db; nothing is sent: the WhatsApp send is a stand-in that must stay silent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-anal-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.TEST_ALLOW_AI = '1'; process.env.WA_AI_FAST = '0'; process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-0123456789abcdef';
const prisma = require('../src/db');
const A = require('../src/omniwa/assist');
const Cfg = require('../src/omniwa/config');
const Analytics = require('../src/omniwa/analytics');
const Services = require('../src/omniwa/services');
const S = require('../src/outreach/store');
const { ensure } = require('../src/omniwa/schema');
const MIN = 60000; const HOUR = 3600000; const DAY = 24 * HOUR;

(async () => {
  await ensure();
  await S.run('CREATE TABLE IF NOT EXISTS "OutreachSuppression" ("addressHash" TEXT NOT NULL, "channel" TEXT NOT NULL, "reason" TEXT, "at" BIGINT, "source" TEXT, PRIMARY KEY ("addressHash", "channel"))');
  const messaging = require('../src/utils/messaging'); const sent = []; messaging.send = async (channel, o) => { sent.push({ channel, ...o }); return { ok: true, providerRef: 'x' }; };
  const admin = await prisma.user.findFirst({ where: { OR: [{ role: { in: ['ADMIN', 'SUPER_ADMIN'] } }, { atsRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }] } });
  const adminMe = { ...(await require('../src/utils/identity').resolveIdentity(admin.id)), contact: true };
  const nobody = { id: 'nobody', name: 'Nobody', role: 'RECRUITER', atsRole: 'RECRUITER' };
  const adminUser = { name: 'Test Admin' };
  await Cfg.setMarketingNumber('zzn', true);
  const now = Date.now();
  const conv = (id, e164, numberId, createdAt, lead = null, extra = {}) => S.run('INSERT INTO "OmniWaConv" (id, e164, personType, name, numberId, mode, state, collected, lastInboundAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, e164, 'LEAD', 'x', numberId, 'ai', 'active', JSON.stringify(lead ? { assistLead: lead } : {}), extra.lastInboundAt || null, createdAt, createdAt);
  const E = { A: '919800000001', B: '919800000002', C: '919800000003', D: '919800000004', OLD: '919800000005', E: '919800000006', G: '919800000007', M: '919800000008', Z: '919800000099' };
  await conv('cA', E.A, 'zzn', now - 2 * DAY, { interestAt: now - 2 * DAY, crmLeadId: 'l1', createdAt: now - 2 * DAY, band: 'Hot', name: 'Ravi', service: 'SEO plan' }, { lastInboundAt: now - 10 * HOUR });
  await conv('cB', E.B, 'zzn', now - 8 * DAY, { interestAt: now - 8 * DAY, crmLeadId: 'l2', createdAt: now - 8 * DAY, band: 'Warm' }, { lastInboundAt: now - 8 * DAY });
  await conv('cD', E.D, 'zzn', now - 1 * DAY, { interestAt: now - 1 * DAY });
  await conv('cOld', E.OLD, 'zzn', now - 40 * DAY, { interestAt: now - 40 * DAY, crmLeadId: 'l3', createdAt: now - 40 * DAY, band: 'Hot' });
  await conv('cOther', E.C, 'other', now - 1 * DAY);
  await conv('cE', '919800000006', 'zzn', now - 2 * HOUR, { interestAt: now - 2 * HOUR, crmLeadId: 'l5', createdAt: now - 2 * HOUR, band: 'Warm' }, { lastInboundAt: now - 1 * HOUR });
  let k = 0;
  const msg = (e164, direction, at, o = {}) => { k += 1; return S.run('INSERT INTO "OmniWaMessage" (id, e164, convId, direction, body, template, status, providerMessageId, aiGenerated, campaignId, senderUserId, numberId, at, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', `m${k}`, e164, o.convId || null, direction, 'x', o.template || null, o.status || (direction === 'IN' ? 'received' : 'sent'), o.ref || null, o.ai === undefined ? 0 : o.ai, o.campaignId || null, o.by || null, o.numberId === undefined ? 'zzn' : o.numberId, at, at); };
  // customer A: answered by the assistant in 4 s, then a person in 5 minutes; a follow-up that failed; a campaign message (read); the customer replies later and is not answered
  const a0 = now - 2 * DAY;
  await msg(E.A, 'IN', a0); await msg(E.A, 'OUT', a0 + 4000, { ai: 1, status: 'read' });
  await msg(E.A, 'IN', a0 + MIN); await msg(E.A, 'OUT', a0 + MIN + 5 * MIN, { ai: 0, by: 'u1', status: 'delivered' });
  await msg(E.A, 'OUT', now - 1 * DAY, { ai: 1, template: 'Follow-up', status: 'failed' });
  await msg(E.A, 'OUT', now - 12 * HOUR, { ai: 1, template: 'tl_promo', campaignId: 'wmk:cx', ref: 'zzp1', status: 'read', numberId: null });
  await msg(E.A, 'IN', now - 10 * HOUR);
  // customer B (8 days ago): the assistant answers in 10 s and 20 s; a campaign message 3 days ago
  const b0 = now - 8 * DAY;
  await msg(E.B, 'IN', b0); await msg(E.B, 'OUT', b0 + 10000, { ai: 1, status: 'delivered' }); await msg(E.B, 'IN', b0 + HOUR); await msg(E.B, 'OUT', b0 + HOUR + 20000, { ai: 1, status: 'sent' });
  await msg(E.B, 'OUT', now - 3 * DAY, { ai: 1, template: 'tl_promo', campaignId: 'wmk:cx', ref: 'zzp2', status: 'delivered', numberId: null });
  // D and E wrote once each; G wrote 40 days ago and again yesterday (not a new customer in 30 days)
  await msg(E.D, 'IN', now - 1 * DAY); await msg(E.E, 'IN', now - 1 * HOUR);
  await msg(E.G, 'IN', now - 40 * DAY); await msg(E.G, 'IN', now - 1 * DAY);
  // M: the chat row is on a marketing number NOW, but everything this person wrote and every turn so far was on another number: none of it belongs here
  await conv('cM', E.M, 'zzn', now - 3 * DAY); await msg(E.M, 'IN', now - 3 * DAY, { numberId: 'other' }); await msg(E.M, 'OUT', now - 3 * DAY + 2000, { ai: 1, status: 'read', numberId: 'other' });
  // an old chat, and a chat on a number that is not a marketing number: the first only in 90 days, the second never
  await msg(E.OLD, 'IN', now - 40 * DAY); await msg(E.OLD, 'OUT', now - 40 * DAY + 3000, { ai: 1, status: 'delivered' });
  await msg(E.C, 'IN', now - 1 * DAY, { numberId: 'other' }); await msg(E.C, 'OUT', now - 1 * DAY + 1000, { ai: 1, status: 'read', numberId: 'other' });
  // the assistant's turns
  // each turn follows the customer's message that started it (a few seconds later)
  const run = (convId, e164, outcome, at) => S.run('INSERT INTO "OmniWaAiRun" (id, convId, e164, outcome, at) VALUES (?,?,?,?,?)', S.newId('war'), convId, e164, outcome, at);
  for (const [c, e, o, t] of [['cA', E.A, 'replied', a0 + 4000], ['cA', E.A, 'handoff_asked', a0 + MIN + 10000], ['cB', E.B, 'replied', b0 + 10000], ['cB', E.B, 'model_error', b0 + HOUR + 20000], ['cA', E.A, 'not_interested', now - 10 * HOUR + 5000], ['cA', E.A, 'skipped_off', now - 10 * HOUR + 5000], ['cOther', E.C, 'replied', now - 1 * DAY + 1000], ['cOld', E.OLD, 'replied', now - 40 * DAY + 3000],
    ['cM', E.M, 'replied', now - 3 * DAY + 1000], ['cM', E.M, 'replied', now - 3 * DAY + 2000], ['cM', E.M, 'replied', now - 3 * DAY + 3000], ['cM', E.M, 'replied', now - 3 * DAY + 4000], ['cM', E.M, 'replied', now - 3 * DAY + 5000]]) await run(c, e, o, t);
  // a stop after the campaign message
  await S.run('INSERT INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', E.A, 'reply', 'STOP', now - 5 * HOUR);
  await S.run('INSERT INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', E.Z, 'reply', 'STOP', now - 5 * HOUR); // somebody we never messaged: not counted
  // the campaign: two sent (zzp1 read, zzp2 delivered), one failed
  await S.run('INSERT INTO "OmniWaMktCampaign" (id, name, templateName, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)', 'cx', 'December offer', 'tl_promo', 'done', now - 3 * DAY, now - 3 * DAY);
  const rec = (e164, status, ref, at) => S.run('INSERT INTO "OmniWaMktRecipient" (id, campaignId, e164, name, status, providerMessageId, reason, sentAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', S.newId('wmr'), 'cx', e164, 'n', status, ref, status === 'failed' ? 'Template not approved' : null, at, now, now);
  await rec(E.A, 'sent', 'zzp1', now - 12 * HOUR); await rec(E.B, 'sent', 'zzp2', now - 3 * DAY); await rec(E.D, 'failed', null, null);

  // 1. thirty days
  let r = await Analytics.compute(adminMe, { days: 30, now });
  assert.equal(r.days, 30); assert.equal(r.empty, false);
  assert.deepEqual(r.messages, { sent: 7, byKind: { assistant: 3, followUp: 1, campaign: 2, team: 1 }, delivered: 5, read: 2, failed: 1, deliveredPct: 71.4, readPct: 28.6, failedPct: 14.3, awaitingReport: 1 }, 'counted from the messages that exist; the old chat and the other number are not in it');
  assert.deepEqual(r.enquiries, { newCustomers: 4, customersWhoWrote: 5, messagesReceived: 8 }, 'A, B, D and E wrote their first message in the window; G wrote 40 days ago first; M wrote only on another number');
  assert.deepEqual([r.responseTime.assistant.answered, r.responseTime.assistant.medianMs, r.responseTime.assistant.meanMs], [3, 10000, 11333]); assert.deepEqual([r.responseTime.team.answered, r.responseTime.team.medianMs], [1, 5 * MIN]);
  assert.deepEqual(r.leads, { saved: 3, Hot: 1, Warm: 2, Cold: 0, notScored: 0, qualified: 3, asked: 4 }, 'the old lead is outside the window');
  assert.deepEqual(r.handover, { answeredByAssistant: 3, passedToAPerson: 2, passedPct: 40 }, 'skipped turns, the other number and the five turns M had on another number do not count: the turns agree with the messages');
  assert.deepEqual(r.optOuts, { customersContacted: 2, optedOut: 1, ratePct: 50 }, 'a stop from somebody we never messaged is not counted');
  assert.equal(r.campaigns.count, 1); assert.deepEqual(r.campaigns.totals, { sent: 2, delivered: 2, read: 1, replied: 1, optedOut: 1, failed: 1, deliveredPct: 100, readPct: 50, repliedPct: 50, optedOutPct: 50 });
  assert.equal(r.campaigns.list[0].name, 'December offer'); assert.ok(r.notes.length === 4 && /floor/.test(r.notes[1]) && /nothing is estimated/.test(r.notes[3]));
  assert.ok(r.handover.answeredByAssistant <= r.messages.byKind.assistant + r.messages.byKind.team + r.messages.byKind.followUp + r.messages.byKind.campaign, 'turns answered never outnumber the messages sent');
  console.log('PASS thirty days: every figure counted from the rows that exist (sent by kind, delivered and read as Meta reported, failed, awaiting a report, new customers, response times, leads, hand-over, opt-outs, the campaign)');

  // 2. seven and ninety days
  r = await Analytics.compute(adminMe, { days: 7, now });
  assert.deepEqual([r.messages.sent, r.messages.byKind.assistant, r.enquiries.newCustomers, r.enquiries.customersWhoWrote, r.leads.saved, r.leads.asked], [5, 1, 3, 4, 2, 3], 'a customer\'s chat 8 days ago is outside seven days');
  assert.deepEqual([r.responseTime.assistant.answered, r.responseTime.assistant.medianMs], [1, 4000]);
  r = await Analytics.compute(adminMe, { days: 90, now });
  assert.deepEqual([r.messages.sent, r.enquiries.newCustomers, r.leads.saved, r.leads.Hot, r.leads.asked], [8, 6, 4, 2, 5], 'the old chat and lead are in ninety days'); assert.equal((await Analytics.compute(adminMe, { days: 5, now })).days, 30, 'any other period is thirty days');
  console.log('PASS seven, thirty and ninety days: the period decides what is counted');

  // 3. nothing to count: dashes, never zeros pretending to be percentages
  r = await Analytics.compute(adminMe, { days: 7, now: now - 400 * DAY });
  assert.equal(r.empty, true); assert.deepEqual([r.messages.sent, r.messages.deliveredPct, r.messages.readPct, r.messages.failedPct], [0, null, null, null]);
  assert.deepEqual([r.responseTime.assistant.medianMs, r.responseTime.assistant.meanMs, r.responseTime.team.medianMs], [null, null, null]); assert.deepEqual([r.optOuts.ratePct, r.handover.passedPct, r.campaigns.totals.deliveredPct], [null, null, null]);
  console.log('PASS nothing to count: no percentage and no time is made up');

  // 4. who may look
  assert.equal((await Analytics.compute(nobody, { days: 30, now })).status, 403);
  assert.equal(Analytics.kindOf({ campaignId: 'wmk:q', aiGenerated: 1 }), 'campaign'); assert.equal(Analytics.kindOf({ aiGenerated: 1, template: 'Follow-up' }), 'followUp'); assert.equal(Analytics.kindOf({ aiGenerated: 0 }), 'team'); assert.equal(Analytics.kindOf({ aiGenerated: 1 }), 'assistant');
  assert.equal(Analytics.median([3, 1, 2]), 2); assert.equal(Analytics.median([1, 2, 3, 4]), 3, 'the middle of an even list is rounded'); assert.equal(Analytics.median([]), null); assert.equal(Analytics.pct(1, 0), null);
  const routes = require('../src/routes/omniWa').stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`); assert.ok(routes.includes('get /analytics'));
  console.log('PASS access: Admin, team lead or campaign rights only; the route exists');

  // 5. the services for the AI Marketing Agent
  const list = Services.describe(); assert.deepEqual(list.map((s) => s.name).sort(), ['analytics.summary', 'assistant.answer', 'campaign.audience', 'campaign.create', 'campaign.preview', 'campaign.templates', 'followup.draft', 'lead.summary', 'message.canSend']);
  assert.ok(list.every((s) => s.risk === 'internal' && s.does && s.needs), 'every service is internal and says what it does and what it needs');
  const src = fs.readFileSync(path.join(BACK, 'src/omniwa/services.js'), 'utf8'); assert.ok(!/sendText|Sender\.send|messaging\.send|kbSave|kbImport|decide\(|approve\(/.test(src.replace(/\/\/.*$/gm, '')), 'no service sends, writes the knowledge base or approves anything');
  assert.equal((await Services.call(adminMe, 'nope')).status, 404); assert.equal((await Services.call(null, 'lead.summary')).status, 401);
  await S.run('DELETE FROM "OmniWaKnowledge"'); await Cfg.kbSave(adminUser, null, { category: 'pricing', question: 'SEO plan', answer: '₹10,000 per month + GST.', numberId: 'zzn' });
  let s = await Services.call(adminMe, 'assistant.answer', { question: 'How much is the SEO plan?', numberId: 'zzn' }); assert.deepEqual([s.kind, s.text], ['answer', 'SEO plan: ₹10,000 per month + GST.']);
  s = await Services.call(adminMe, 'assistant.answer', { question: 'price for hotel software', numberId: 'zzn' }); assert.deepEqual([s.kind, s.handover], ['none', true]); assert.equal((await Services.call(nobody, 'assistant.answer', { question: 'x' })).status, 403);
  s = await Services.call(adminMe, 'lead.summary', { crmLeadId: 'l1' }); assert.equal(s.crmLeadId, 'l1'); assert.ok(['Hot', 'Warm', 'Cold'].includes(s.band) && Array.isArray(s.reasons) && s.summary.next && s.fields.name === 'Ravi');
  assert.equal((await Services.call(adminMe, 'lead.summary', { crmLeadId: 'missing' })).status, 404); assert.equal((await Services.call(nobody, 'lead.summary', { crmLeadId: 'l1' })).status, 403, 'a chat outside the login\'s access is not read');
  s = await Services.call(adminMe, 'followup.draft', { crmLeadId: 'l1' }); assert.equal(s.step, 1); assert.equal(s.of, 3); assert.match(s.text, /^Hello Ravi! We wanted to follow up on your SEO plan enquiry\./); assert.match(s.text, /Reply STOP to stop messages from us\.$/); assert.equal(s.templateSet, false);
  s = await Services.call(adminMe, 'message.canSend', { crmLeadId: 'l1' }); assert.deepEqual([s.ok, s.code], [false, 'OPTED_OUT'], 'customer A wrote STOP: the gate says no whatever else is true');
  await require('../src/utils/omniRules').saveSettings(adminUser, { enabled: false }); // the clock must not decide this
  s = await Services.call(adminMe, 'message.canSend', { crmLeadId: 'l5' }); assert.deepEqual([s.ok, s.via], [true, 'text'], 'inside the 24 hours: text');
  s = await Services.call(adminMe, 'message.canSend', { crmLeadId: 'l2', templateName: 'tl_followup' }); assert.deepEqual([s.ok, s.code], [false, 'NO_CONSENT'], 'outside the window with no recorded consent: no');
  s = await Services.call(adminMe, 'message.canSend', { crmLeadId: 'l2' }); assert.deepEqual([s.ok, s.code], [false, 'NO_TEMPLATE']);
  s = await Services.call(adminMe, 'campaign.templates'); assert.ok(Array.isArray(s.templates)); assert.equal((await Services.call(nobody, 'campaign.templates')).status, 403);
  assert.equal((await Services.call(nobody, 'campaign.audience')).status, 403); assert.equal((await Services.call(nobody, 'campaign.preview', {})).status, 403); assert.equal((await Services.call(nobody, 'campaign.create', {})).status, 403);
  s = await Services.call(adminMe, 'campaign.preview', { name: 'x', templateId: 'none', varMap: [] }); assert.match(s.error, /approved WhatsApp template/);
  s = await Services.call(adminMe, 'campaign.create', { name: 'x', templateId: 'none', varMap: [] }); assert.ok(s.error, 'no template, no switch: nothing is saved');
  s = await Services.call(adminMe, 'analytics.summary', { days: 30 }); assert.equal(s.days, 30); assert.equal((await Services.call(nobody, 'analytics.summary', {})).status, 403);
  assert.equal(sent.length, 0, 'not one service call sent anything');
  console.log('PASS the services: nine internal services, answers from the knowledge base word for word, a lead\'s score and summary, a follow-up draft, whether a message could go and why not, campaign templates / audience / preview / create (never send), analytics; the same access checks as the screens; nothing was sent');

  console.log('waAssistantAnalytics tests: all passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
