// AI WhatsApp Marketing Assistant, phase 4 (omniwa/campaign.js + the gate for a campaign + the opt-in question): promotion campaigns that never go to anyone who did not agree.
//   node backend/test-fixtures/waAssistantCampaign.test.js     (throw-away copy of prisma/sandbox.db; TEST_MODE: nothing is sent, the WhatsApp send is a stand-in)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-camp-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.TEST_ALLOW_AI = '1'; process.env.WA_AI_FAST = '0'; process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-0123456789abcdef';
const prisma = require('../src/db');
const A = require('../src/omniwa/assist');
const AL = require('../src/omniwa/assistLead');
const Cfg = require('../src/omniwa/config');
const Agent = require('../src/omniwa/agent');
const Gate = require('../src/omniwa/gate');
const Camp = require('../src/omniwa/campaign');
const Promo = require('../src/omniwa/promo');
const S = require('../src/outreach/store');
const DB = require('../src/crm/schema');
const CS = require('../src/crm/service');
const { ensure } = require('../src/omniwa/schema');
const HOUR = 3600000; const DAY = 24 * HOUR;

(async () => {
  await ensure(); await DB.ensure(); await require('../src/crm/plusSchema').ensure(); await require('../src/marketing/leadgen').ensureColumns();
  // the sandbox copy has no Outreach tables (they come with a migration on the server): the two this feature reads are made here
  await S.run('CREATE TABLE IF NOT EXISTS "OutreachSuppression" ("addressHash" TEXT NOT NULL, "channel" TEXT NOT NULL, "reason" TEXT, "at" BIGINT, "source" TEXT, PRIMARY KEY ("addressHash", "channel"))');
  await S.run('CREATE TABLE IF NOT EXISTS "OutreachTemplate" ("id" TEXT PRIMARY KEY, "name" TEXT, "channel" TEXT, "body" TEXT, "waTemplateName" TEXT, "waLanguage" TEXT, "waApprovalStatus" TEXT, "status" TEXT DEFAULT \'active\', "updatedAt" BIGINT)');
  const tpl = (id, name, channel, meta, status) => S.run('INSERT INTO "OutreachTemplate" (id, name, channel, body, waTemplateName, waLanguage, waApprovalStatus, status, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)', id, name, channel, 'Hello {{1}}, {{2}} has news about {{3}}. Reply STOP to stop messages from us.', meta, 'en', status, 'active', Date.now());
  await tpl('t1', 'Promo news', 'whatsapp', 'tl_promo', 'approved'); await tpl('t2', 'Not yet', 'whatsapp', 'tl_pending', 'pending'); await tpl('t3', 'A mail', 'email', null, null); await tpl('t4', 'No meta name', 'whatsapp', null, 'approved');

  const messaging = require('../src/utils/messaging'); const sent = []; let n = 0; let failFor = null;
  messaging.send = async (channel, o) => { if (failFor && String(o.to).endsWith(failFor)) return { ok: false, error: 'Template not approved for this number' }; n += 1; sent.push({ channel, ...o }); return { ok: true, outcome: 'sent', providerRef: `zzmk${n}` }; };
  const admin = await prisma.user.findFirst({ where: { OR: [{ role: { in: ['ADMIN', 'SUPER_ADMIN'] } }, { atsRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }] } });
  const adminMe = { ...(await require('../src/utils/identity').resolveIdentity(admin.id)), contact: true };
  const nobody = { id: 'nobody', name: 'Nobody', role: 'RECRUITER', atsRole: 'RECRUITER' };
  const adminUser = { name: 'Test Admin' };
  const quiet = require('../src/utils/omniRules'); await quiet.saveSettings(adminUser, { enabled: false });
  await A.saveSettings(adminUser, { enabled: true, businessName: 'Acme Marketing', campaignsOn: false });

  // the leads: who agreed, who did not
  const LI = require('../src/crm/plus/leadIn'); const SUF = String(Date.now()).slice(-6);
  const SUF8 = String(Date.now()).slice(-8); const phone = (k) => `+919${SUF8}${k}`; // a valid 10-digit Indian mobile after the 91
  const mkLead = async (k, name, over = {}) => { const out = await LI.createCaptured('whatsapp', { name, company: name, phone: phone(k), notes: 'test' }); const id = out.body.id; await CS.update('CrmLead', id, { ...over }); return id; };
  const ids = {
    ravi: await mkLead(1, 'Ravi Kumar', { leadBand: 'Hot' }), sita: await mkLead(2, 'Sita Rao', { leadBand: 'Warm' }), meena: await mkLead(3, 'Meena Das'), anil: await mkLead(4, 'Anil Reddy'),
    kiran: await mkLead(5, 'Kiran Rao'), lata: await mkLead(6, 'Lata Devi'), dev: await mkLead(7, 'Dev Lost', { stage: 'Lost' }), badnum: await mkLead(8, 'Bad Number'),
  };
  await CS.update('CrmLead', ids.badnum, { phone: '12345' });
  const Consent = require('../src/crm/consent');
  const PROMO = 'Newsletters and campaigns';
  const row = (leadId, status, at) => DB.run('INSERT INTO "CrmConsent" ("id","kind","recordId","purpose","status","channel","source","noticeVersion","note","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?)', S.newId('cns'), 'lead', leadId, PROMO, status, 'WhatsApp', 'test', '1', 'test', 'test', at);
  const t0 = new Date(Date.now() - 5 * DAY).toISOString(); const t1 = new Date(Date.now() - 2 * DAY).toISOString();
  for (const k of ['ravi', 'sita', 'kiran', 'lata', 'dev', 'badnum']) await row(ids[k], 'Given', t0);
  await row(ids.anil, 'Given', t0); await row(ids.anil, 'Withdrawn', t1);
  // an enquiry consent (sales / WhatsApp) does NOT count as promotion consent
  await Consent.fromWhatsApp(ids.meena, { note: 'enquiry only' });
  await S.run('INSERT INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', phone(5).slice(1), 'reply', 'STOP', Date.now());
  const e = (k) => phone(k).slice(1);
  await S.run('INSERT INTO "OmniWaMktRecipient" (id, campaignId, crmLeadId, e164, name, status, sentAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)', S.newId('wmr'), 'old', ids.lata, e(6), 'Lata Devi', 'sent', Date.now() - 2 * DAY, Date.now(), Date.now());
  // what the assistant learned about two of them
  const learned = (leadId, e164, lead) => S.run('INSERT INTO "OmniWaConv" (id, e164, personType, name, numberId, mode, state, collected, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', S.newId('wac'), e164, 'LEAD', 'x', 'zzn', 'ai', 'active', JSON.stringify({ assistLead: { crmLeadId: leadId, ...lead } }), Date.now(), Date.now());
  await learned(ids.ravi, e(1), { service: 'SEO plan', callback: 'after 5 pm' });

  // 1. the approved templates
  const tpls = await Camp.templates();
  assert.deepEqual(tpls.map((t) => [t.metaName, t.blanks]), [['tl_promo', 3]], 'only an approved WhatsApp template with its Meta name');
  console.log('PASS templates: only approved WhatsApp templates that have their Meta name');

  // 2. the audience: only who agreed
  let au = await Camp.audience({}); 
  assert.deepEqual(au.people.map((p) => p.name).sort(), ['Ravi Kumar', 'Sita Rao'], 'only the two who agreed to promotions and are reachable');
  assert.equal(au.skipped['no recorded consent for promotions'], 2, 'Meena (only an enquiry consent) and Anil (withdrawn)');
  assert.equal(au.skipped['asked us to stop (or the stop lists could not be read)'], 1); assert.equal(au.skipped['no usable WhatsApp number'], 1); assert.equal(au.skipped.lost, 1);
  assert.equal(au.skipped['already got a campaign message in the last 7 days'], 1);
  assert.ok(au.samples['no recorded consent for promotions'].includes('Meena Das') && au.samples['no recorded consent for promotions'].includes('Anil Reddy'));
  assert.ok(au.people.every((p) => /^\+91 •••••\d{4}$/.test(p.phoneHint)), 'numbers are shown masked');
  au = await Camp.audience({ bands: ['Hot'] }); assert.deepEqual(au.people.map((p) => p.name), ['Ravi Kumar']); assert.equal(au.skipped['outside the chosen Hot / Warm / Cold'], 3, 'Sita is Warm; Kiran and Lata have no band');
  au = await Camp.audience({ max: 1 }); assert.equal(au.people.length, 1); assert.equal(au.skipped['over the limit for one campaign'], 1);
  console.log('PASS the audience: only people with recorded promotion consent; an enquiry consent, a withdrawn one, a stop list, a bad number, a lost lead and a recent campaign message all keep a person out, each with its reason');

  // 3. the words
  const r1 = Camp.render('Hello {{1}}, {{2}} has news about {{3}}.', ['name', 'business', 'service'], { name: 'Ravi Kumar', service: 'SEO plan' }, 'Acme Marketing');
  assert.equal(r1.text, 'Hello Ravi, Acme Marketing has news about SEO plan.'); assert.deepEqual(r1.vars, ['Ravi', 'Acme Marketing', 'SEO plan']);
  assert.equal(Camp.render('Hi {{1}} {{2}}', ['name', 'service'], { name: '', service: null }, '').text, 'Hi there our services', 'a missing fact has a plain fallback, never an empty blank');
  console.log('PASS the words: blanks filled from the lead\'s own facts, plain fallbacks');

  // 4. the preview: every person with the exact words, nothing saved
  const draft = { name: 'December news', templateId: 't1', varMap: ['name', 'business', 'service'], audience: { bands: [] } };
  let pv = await Camp.preview(nobody, draft); assert.equal(pv.status, 403, 'only campaign rights');
  assert.match((await Camp.preview(adminMe, { ...draft, templateId: 't2' })).error, /approved WhatsApp template/, 'an unapproved template is refused');
  assert.match((await Camp.preview(adminMe, { ...draft, templateId: 't3' })).error, /approved WhatsApp template/, 'an email template is not a WhatsApp template');
  assert.match((await Camp.preview(adminMe, { ...draft, varMap: ['name'] })).error, /3 blanks/);
  assert.match((await Camp.preview(adminMe, { ...draft, varMap: ['name', 'business', 'price'] })).error, /name, the service, the business or the call time/, 'a blank is never filled with anything but those facts');
  const before = (await S.q('SELECT COUNT(*) AS n FROM "OmniWaMktCampaign"'))[0].n;
  pv = await Camp.preview(adminMe, draft);
  assert.deepEqual(pv.people.map((p) => p.text).sort(), ['Hello Ravi, Acme Marketing has news about SEO plan. Reply STOP to stop messages from us.', 'Hello Sita, Acme Marketing has news about our services. Reply STOP to stop messages from us.']);
  assert.equal(pv.template.metaName, 'tl_promo'); assert.ok(pv.skipped && pv.considered >= 8); assert.equal(Number((await S.q('SELECT COUNT(*) AS n FROM "OmniWaMktCampaign"'))[0].n), Number(before), 'a preview saves nothing');
  console.log('PASS the preview: every person with the exact words, who is left out and why, an unapproved or e-mail template refused, nothing saved');

  // 5. making it, and approving it
  let made = await Camp.create(adminMe, draft); assert.equal(made.status, 409, 'switched off: no campaign can be made'); assert.match(made.error, /switched off/);
  await A.saveSettings(adminUser, { campaignsOn: true });
  assert.equal((await Camp.create(nobody, draft)).status, 403); assert.match((await Camp.create(adminMe, { ...draft, name: '' })).error, /name/);
  assert.equal((await Camp.create(adminMe, { ...draft, audience: { bands: ['Cold'] } })).status, 409, 'nobody would receive it: nothing is saved');
  made = await Camp.create(adminMe, draft); assert.ok(made.ok && made.people === 2, JSON.stringify(made));
  let rec = await S.q('SELECT name, body, status FROM "OmniWaMktRecipient" WHERE campaignId = ? ORDER BY name', made.id);
  assert.deepEqual(rec.map((x) => x.body).sort(), pv.people.map((p) => p.text).sort(), 'what was saved is what the preview showed'); assert.ok(rec.every((x) => x.status === 'queued'));
  assert.equal((await Camp.get(adminMe, made.id)).campaign.status, 'ready');
  assert.equal((await Camp.approve(nobody, made.id)).status, 403);
  assert.match((await Camp.approve(adminMe, made.id, { at: Date.now() + 1000 })).error, /between one minute and thirty days/); assert.match((await Camp.approve(adminMe, made.id, { at: Date.now() + 40 * DAY })).error, /between one minute and thirty days/);
  assert.equal((await Camp.sweep(Date.now())).sandbox, true, 'never started in the test sandbox by itself');
  assert.equal(sent.length, 0, 'nothing is sent before a person approves');
  await Camp.sweep(Date.now(), { force: true }); assert.equal(sent.length, 0, 'a campaign that is only "ready" is not sent');
  // a STOP arrives after the preview: that person is not sent to
  await S.run('INSERT INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', e(2), 'reply', 'STOP', Date.now());
  const ap = await Camp.approve(adminMe, made.id); assert.deepEqual([ap.ok, ap.status], [true, 'sending']);
  assert.equal((await Camp.approve(adminMe, made.id)).status, 409, 'approved once');
  // quiet hours: it waits
  const nowIst = new Date(Date.now() + 5.5 * HOUR); const hm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  await quiet.saveSettings(adminUser, { enabled: true, from: hm(new Date(nowIst.getTime() - 2 * HOUR)), to: hm(new Date(nowIst.getTime() + 2 * HOUR)) });
  let sw = await Camp.sweep(Date.now(), { force: true }); assert.equal(sent.length, 0, 'quiet hours: nothing goes'); assert.equal(sw.waiting, 1); assert.match((await Camp.get(adminMe, made.id)).campaign.note, /Quiet hours/);
  await quiet.saveSettings(adminUser, { enabled: false });
  sw = await Camp.sweep(Date.now(), { force: true });
  assert.deepEqual([sw.sent, sw.done], [1, 1]); assert.equal(sent.length, 1); // Sita was already skipped in the sweep that waited for the quiet hours: a stop list is looked at before the clock
  const m = sent[0]; assert.deepEqual([m.to, m.kind, m.template, m.vars], [`+${e(1)}`, 'text', { name: 'tl_promo', language: 'en' }, ['Ravi', 'Acme Marketing', 'SEO plan']], 'an approved template, with the blanks, never free text');
  assert.equal(m.text, 'Hello Ravi, Acme Marketing has news about SEO plan. Reply STOP to stop messages from us.');
  rec = await S.q('SELECT name, status, reason FROM "OmniWaMktRecipient" WHERE campaignId = ? ORDER BY name', made.id);
  assert.deepEqual(rec.map((x) => [x.name, x.status]), [['Ravi Kumar', 'sent'], ['Sita Rao', 'skipped']]); assert.match(rec[1].reason, /stop/i);
  const msg = (await S.q('SELECT * FROM "OmniWaMessage" WHERE campaignId = ?', `wmk:${made.id}`)); assert.equal(msg.length, 1); assert.deepEqual([msg[0].direction, Number(msg[0].aiGenerated), msg[0].template, msg[0].status], ['OUT', 1, 'tl_promo', 'sent']);
  assert.equal((await Camp.get(adminMe, made.id)).campaign.status, 'done');
  console.log('PASS making and sending: needs the switch, needs campaign rights, nothing before approval, the preview is what is saved, a STOP after the preview is respected, quiet hours wait, the message is the approved template with its blanks, kept like every WhatsApp message');

  // 6. results come from what really happened
  await Promo.onStatus({ providerRef: 'zzmk1', status: 'delivered' }); await Promo.onStatus({ providerRef: 'zzmk1', status: 'read' });
  let st = await Camp.stats(made.id); assert.deepEqual([st.total, st.sent, st.skipped, st.delivered, st.read, st.replied, st.optedOut], [2, 1, 1, 1, 1, 0, 0]);
  const sentAt = Number((await S.q('SELECT sentAt FROM "OmniWaMktRecipient" WHERE campaignId = ? AND status = \'sent\'', made.id))[0].sentAt);
  await S.run('INSERT INTO "OmniWaMessage" (id, e164, direction, body, status, at, createdAt) VALUES (?,?,?,?,?,?,?)', S.newId('wam'), e(1), 'IN', 'Interested, call me', 'received', sentAt + 2 * HOUR, Date.now());
  await S.run('INSERT INTO "OmniWaMessage" (id, e164, direction, body, status, at, createdAt) VALUES (?,?,?,?,?,?,?)', S.newId('wam'), e(1), 'IN', 'old message', 'received', sentAt - 2 * HOUR, Date.now());
  st = await Camp.stats(made.id); assert.equal(st.replied, 1, 'a reply after the message counts, an earlier one does not'); assert.equal(st.repliedPct, 100); assert.equal(st.readPct, 100);
  await S.run('INSERT OR REPLACE INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', e(1), 'reply', 'STOP', sentAt + 5 * HOUR); st = await Camp.stats(made.id); assert.equal(st.optedOut, 1); assert.equal(st.optedOutPct, 100, 'a STOP within three days is counted against the campaign');
  await S.run('INSERT OR REPLACE INTO "OmniWaOptOut" (e164, source, text, at) VALUES (?,?,?,?)', e(1), 'reply', 'STOP', sentAt + 5 * DAY); st = await Camp.stats(made.id); assert.equal(st.optedOut, 0, 'later than three days is not');
  await S.run('DELETE FROM "OmniWaOptOut" WHERE e164 = ?', e(1)); await S.run('DELETE FROM "OmniWaOptOut" WHERE e164 = ?', e(2)); await S.run('DELETE FROM "OmniWaMktRecipient" WHERE campaignId = ?', 'old');
  const noData = await Camp.stats('nope'); assert.deepEqual([noData.total, noData.deliveredPct, noData.readPct, noData.repliedPct], [0, null, null, null], 'with nothing sent no percentage is made up');
  // a failure shows its reason
  failFor = e(2).slice(-4); await row(ids.sita, 'Given', t1); // (still consenting)
  const c2 = await Camp.create(adminMe, { ...draft, name: 'Second', audience: { bands: [], gapDays: 1 } }); assert.ok(c2.ok, JSON.stringify(c2));
  await Camp.approve(adminMe, c2.id); sw = await Camp.sweep(Date.now(), { force: true });
  assert.equal(sw.failed, 1); st = await Camp.stats(c2.id); assert.deepEqual(st.failures, { 'Template not approved for this number': 1 }); failFor = null;
  console.log('PASS the results: sent, delivered and read from Meta\'s reports, replied and opted out only within three days after the message, no percentage invented, a failure with its reason');

  // 7. stopping one, scheduling one
  const c3 = await Camp.create(adminMe, { ...draft, name: 'Third', audience: { bands: [], gapDays: 1 } }); assert.ok(c3.ok, JSON.stringify(c3));
  assert.ok((await Camp.approve(adminMe, c3.id, { at: Date.now() + 3 * HOUR })).ok); assert.equal((await Camp.get(adminMe, c3.id)).campaign.status, 'scheduled');
  const b = sent.length; await Camp.sweep(Date.now(), { force: true }); assert.equal(sent.length, b, 'a scheduled campaign waits for its time');
  assert.equal((await Camp.cancel(nobody, c3.id)).status, 403); assert.ok((await Camp.cancel(adminMe, c3.id)).ok);
  assert.equal((await S.q('SELECT status FROM "OmniWaMktRecipient" WHERE campaignId = ?', c3.id)).every((x) => x.status === 'skipped'), true, 'stopped: nobody is sent to'); assert.equal((await Camp.cancel(adminMe, c3.id)).status, 409);
  const list = await Camp.list(adminMe); assert.ok(list.canManage && list.rows.length >= 3 && list.rows.every((x) => x.stats && typeof x.stats.total === 'number')); assert.deepEqual(await Camp.list(nobody), { rows: [], canManage: false });
  console.log('PASS scheduling and stopping: a scheduled campaign waits, stopping sends to nobody, only people with campaign rights see or change campaigns');

  // 8. the gate for a campaign: always a template, always the consent for promotions
  const conv = { e164: e(1), numberId: null, collected: JSON.stringify({ assistLead: { crmLeadId: ids.ravi } }), lastInboundAt: Date.now() };
  let g = await Gate.check(conv, { purpose: 'campaign', template: null }); assert.deepEqual([g.ok, g.code], [false, 'NO_TEMPLATE'], 'no free text for a campaign, even with the window open');
  g = await Gate.check(conv, { purpose: 'campaign', template: { name: 'tl_promo', language: 'en', vars: [] } }); assert.deepEqual([g.ok, g.via], [true, 'template']);
  const enquiryOnly = { ...conv, e164: e(3), collected: JSON.stringify({ assistLead: { crmLeadId: ids.meena } }) };
  g = await Gate.check(enquiryOnly, { purpose: 'campaign', template: { name: 'tl_promo', language: 'en', vars: [] } }); assert.deepEqual([g.ok, g.code], [false, 'NO_CONSENT'], 'consent for the enquiry is not consent for promotions');
  g = await Gate.check(enquiryOnly, { purpose: 'followup', template: null }); assert.equal(g.ok, true, 'but the follow-up of that enquiry is still fine inside the window (the enquiry consent counts for it)');
  console.log('PASS the gate for a campaign: only a template, only with the promotions consent; an enquiry consent does not count');

  // 9. the opt-in question, through the real chat
  const messaging2 = messaging; // the same stand-in
  const ai = require('../src/utils/ai'); ai.chatJson = async () => { throw new Error('no model'); };
  await Cfg.save(adminUser, { enabled: true, systemPrompt: 'You help.', fallbackMessage: 'Our team will contact you soon.' }); await Cfg.setMarketingNumber('zzn', true);
  await S.run('DELETE FROM "OmniWaKnowledge"'); await Cfg.kbSave(adminUser, null, { category: 'pricing', question: 'SEO plan', answer: '₹10,000 per month + GST.', numberId: 'zzn' });
  let idn = 0; const inbound = (from, text) => { idn += 1; return Agent.onInbound({ channel: 'WhatsApp', from, text, id: `wamid.ZZC${SUF}${idn}`, at: new Date(), name: 'ZZTEST', numberId: 'zzn' }, { personType: null, review: true, reason: 'none' }); };
  const say = async (from, text) => { await inbound(from, text); const b0 = sent.length; await Agent.tick(Date.now(), { force: true }); return sent.length > b0 ? sent[sent.length - 1].vars[0] : null; };
  const talk = async (from, who) => { for (const t of ['How much is the SEO plan?', who, 'We need more bookings for our small hotel', 'around 20k per month']) await say(from, t); return say(from, 'tomorrow after 5 pm'); };
  await A.saveSettings(adminUser, { askOptIn: false });
  let last = await talk(`918${SUF8}1`, 'Asha Rao'); assert.ok(!/offers and updates/.test(last), 'the question is not asked unless the Admin switched it on');
  await A.saveSettings(adminUser, { askOptIn: true });
  const eY = `918${SUF8}2`; last = await talk(eY, 'Vikram Shah');
  assert.match(last, /A team member will contact you[^]*\n\nWould you like to get our offers and updates here on WhatsApp from time to time\? Reply YES to agree\. You can write STOP at any time\.$/);
  let cv = await Agent.convOf(eY); const leadY = AL.leadOf(cv); assert.equal(leadY.pendingOptIn, true);
  let promoRows = async (leadId) => DB.all('SELECT "purpose", "status", "channel", "note" FROM "CrmConsent" WHERE "recordId" = ? AND "purpose" LIKE ?', leadId, '%campaign%');
  assert.equal((await promoRows(leadY.crmLeadId)).length, 0, 'the enquiry consent does not include promotions');
  assert.ok(!(await Camp.audience({})).people.some((p) => p.leadId === leadY.crmLeadId), 'not in a campaign yet');
  last = await say(eY, 'yes'); assert.match(last, /^Thank you\. You will get our offers and updates here from time to time\. Write STOP at any time/);
  const pr = await promoRows(leadY.crmLeadId); assert.deepEqual(pr.map((x) => [x.status, x.channel]), [['Given', 'WhatsApp']]); assert.equal(pr[0].note, 'They replied: "yes"', 'their own words are the evidence');
  assert.ok((await Camp.audience({})).people.some((p) => p.leadId === leadY.crmLeadId), 'now they can be in a campaign');
  const eN = `918${SUF8}3`; await talk(eN, 'Neha Roy'); last = await say(eN, 'no thanks'); assert.match(last, /^No problem\. We will not send you offers/);
  assert.equal((await promoRows(AL.leadOf(await Agent.convOf(eN)).crmLeadId)).length, 0); assert.equal(AL.leadOf(await Agent.convOf(eN)).optIn, 'no');
  const eO = `918${SUF8}4`; await talk(eO, 'Omar Khan'); last = await say(eO, 'what are your timings?'); assert.ok(!/offers and updates/.test(last || ''), 'another message drops the question, it is never repeated'); assert.equal(AL.leadOf(await Agent.convOf(eO)).pendingOptIn, false);
  assert.equal((await promoRows(AL.leadOf(await Agent.convOf(eO)).crmLeadId)).length, 0);
  console.log('PASS the opt-in question: only when switched on, asked once after the details, YES records the consent with their own words, NO is kept, anything else drops it');

  // 10. the wiring
  const routes = require('../src/routes/omniWa').stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
  for (const r of ['get /campaign-templates', 'get /campaigns', 'post /campaigns/preview', 'post /campaigns', 'get /campaigns/:id', 'post /campaigns/:id/send', 'post /campaigns/:id/cancel']) assert.ok(routes.includes(r), r);
  const idx = fs.readFileSync(path.join(BACK, 'src/index.js'), 'utf8'); assert.ok(/require\('\.\/omniwa\/campaign'\)\.start\(\)/.test(idx) && idx.indexOf("omniwa/campaign').start()") < idx.indexOf('if (sandbox.isSandbox()) { sandbox.banner'));
  assert.equal((await A.settings()).campaignsOn, true); await A.saveSettings(adminUser, { campaignsOn: false }); assert.equal((await Camp.sweep(Date.now(), { force: true })).off, true, 'switched off: the sender does nothing');
  console.log('PASS the wiring: seven routes, the ticker is started with the agent, switched off = nothing is sent');

  console.log('waAssistantCampaign tests: all passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
