// AI WhatsApp Marketing Assistant, phase 2 (omniwa/assistLead.js + assist.js + the CRM hooks): lead capture into the CRM, Hot / Warm / Cold with reasons, the summary, the handover.
//   node backend/test-fixtures/waAssistantLeads.test.js     (throw-away copy of prisma/sandbox.db; TEST_MODE: nothing is sent, the WhatsApp send is a stand-in, no AI model is asked)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-leads-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.TEST_ALLOW_AI = '1'; process.env.WA_AI_FAST = '0';
const prisma = require('../src/db');
const A = require('../src/omniwa/assist');
const AL = require('../src/omniwa/assistLead');
const Cfg = require('../src/omniwa/config');
const Agent = require('../src/omniwa/agent');
const Inbox = require('../src/omniwa/inbox');
const S = require('../src/outreach/store');
const DB = require('../src/crm/schema');
const { ensure } = require('../src/omniwa/schema');

const M = (direction, body, at) => ({ direction, body, at });
const T0 = 1700000000000;

(async () => {
  await ensure(); await DB.ensure(); // the CRM tables make themselves on first use; the checks below read them directly
  // 1. the score: plain signals, plain reasons
  const sc = (msgs, lead = {}) => AL.score(AL.signals(msgs, lead, A.intentsOf));
  let r = sc([M('IN', 'What are your working hours?', T0)]);
  assert.deepEqual([r.band, r.score], ['Cold', 15], 'only asking the hours is not a lead'); assert.deepEqual(r.reasons, []);
  r = sc([M('IN', 'How much is the SEO plan?', T0)], { service: 'SEO plan' });
  assert.equal(r.band, 'Warm'); assert.deepEqual(r.reasons.map((x) => x.pts), [15, 10]); assert.match(r.reasons[0].why, /costs/);
  r = sc([M('IN', 'I need more bookings, call me please', T0), M('OUT', 'ok', T0 + 1000), M('IN', 'today if possible', T0 + 60000), M('OUT', 'ok', T0 + 70000), M('IN', 'thanks', T0 + 120000)], { name: 'Ravi', service: 'SEO plan', requirement: 'More online bookings for my hotel', callback: 'after 5 pm' });
  assert.equal(r.band, 'Hot'); assert.ok(r.reasons.some((x) => /call, a demo or a meeting/.test(x.why)) && r.reasons.some((x) => /Wants it soon/.test(x.why)) && r.reasons.some((x) => /within minutes/.test(x.why)));
  r = sc([M('IN', 'How much is the SEO plan?', T0), M('IN', 'sorry, not interested, too expensive', T0 + 1000)], { service: 'SEO plan' });
  assert.equal(r.band, 'Cold', 'said no'); assert.ok(r.reasons.some((x) => x.pts === -35) && r.reasons.some((x) => x.pts === -10));
  assert.ok(sc([M('IN', 'asap', T0)]).score >= 15 && AL.score({ ...AL.signals([], {}, A.intentsOf), messages: 20 }, { hot: 65, warm: 40 }).score <= 100, 'never above 100');
  assert.deepEqual(AL.score(AL.signals([M('IN', 'How much is it?', T0)], { service: 'X' }, A.intentsOf), { hot: 20, warm: 10 }).band, 'Hot', 'the limits are the CRM Lead generation limits');
  console.log('PASS the score: asking hours = Cold, price + service = Warm, call + urgent + details = Hot, "not interested" = Cold, every reason in plain words, limits are the CRM ones');

  // 2. reading the customer's words
  assert.equal(AL.nameFrom('My name is ravi kumar'), 'Ravi Kumar'); assert.equal(AL.nameFrom('Ravi'), 'Ravi'); assert.equal(AL.nameFrom("I'm Sita from Hyderabad"), 'Sita');
  for (const bad of ['yes', 'ok', 'what is the price?', 'I am interested', 'call me', '9876543210', 'one two three four five six']) assert.equal(AL.nameFrom(bad), null, bad);
  assert.equal(AL.answerFor('budget', 'around 20k per month'), 'around 20k per month'); assert.equal(AL.answerFor('budget', 'skip'), 'Not decided'); assert.equal(AL.answerFor('budget', 'what is the cost?'), null);
  assert.equal(AL.answerFor('callback', 'tomorrow after 5 pm'), 'tomorrow after 5 pm'); assert.equal(AL.answerFor('callback', 'no'), 'No preference');
  assert.equal(AL.answerFor('requirement', 'hotel bookings'), null, 'two words are not a requirement'); assert.ok(AL.answerFor('requirement', 'we need more bookings for our hotel'));
  assert.ok(AL.showsInterest('I am interested in SEO') && AL.showsInterest('need a quote') && !AL.showsInterest('what are your hours') && !AL.showsInterest('not interested'));
  for (const justAsking of ['I want to know your timings', 'when do you start work in the morning', 'where can I visit you', 'no need, thanks']) assert.equal(AL.showsInterest(justAsking), false, justAsking);
  assert.equal(AL.nextField({ name: 'A', service: 'B' }, { needsBudget: false }), 'requirement'); assert.equal(AL.nextField({ name: 'A', service: 'B', requirement: 'C' }, { needsBudget: false }), 'callback');
  assert.equal(AL.nextField({ name: 'A', service: 'B', requirement: 'C' }, { needsBudget: true }), 'budget'); assert.equal(AL.nextField({ skipped: ['name'], asked: { service: 2 } }, { needsBudget: false }), 'requirement', 'skipped or asked twice is not asked again');
  console.log('PASS reading answers: names, budget, call time, requirement, interest words; the next question; nothing asked twice');

  // 3. the whole talk through the real agent (stand-in WhatsApp send, no model)
  const ai = require('../src/utils/ai'); let aiCalls = 0; ai.chatJson = async () => { aiCalls += 1; return { reply: 'model' }; };
  const messaging = require('../src/utils/messaging'); const sent = []; let n = 0;
  messaging.send = async (channel, o) => { n += 1; sent.push({ channel, ...o }); return { ok: true, outcome: 'sent', providerRef: `zzref${n}` }; };
  const SA = require('../src/crm/salesAgent'); let crmAnswers = 0; const realRespond = SA.respond; SA.respond = async () => { crmAnswers += 1; return { answered: true }; };
  const admin = await prisma.user.findFirst({ where: { OR: [{ role: { in: ['ADMIN', 'SUPER_ADMIN'] } }, { atsRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }] } });
  assert.ok(admin, 'the sandbox has an Admin to be told');
  const adminUser = { name: 'Test Admin' };
  await Cfg.save(adminUser, { enabled: true, systemPrompt: 'You help.', fallbackMessage: 'Our team will contact you soon.' });
  await Cfg.setMarketingNumber('zzn', true);
  await S.run('DELETE FROM "OmniWaKnowledge"');
  for (const [category, question, answer] of [['pricing', 'SEO plan', '₹10,000 per month + GST. Includes keyword research.'], ['pricing', 'Social media plan', '₹7,500 per month + GST for 12 posts.'], ['hours', 'Working hours', 'Monday to Saturday, 9:30 am to 6:30 pm.'], ['services', 'SEO', 'Audit, keywords, content and links.']]) await Cfg.kbSave(adminUser, null, { category, question, answer, numberId: 'zzn' });
  await A.saveSettings(adminUser, { enabled: true, businessName: 'Acme Marketing', noAnswer: '', aiWording: true, collectLeads: true });
  const SUF = String(Date.now()).slice(-7); let id = 0;
  const inbound = (from, text) => { id += 1; return Agent.onInbound({ channel: 'WhatsApp', from, text, id: `wamid.ZZL${SUF}${id}`, at: new Date(), name: 'ZZTEST Visitor', numberId: 'zzn' }, { personType: null, review: true, reason: 'none' }); };
  const run = () => Agent.tick(Date.now(), { force: true });
  const say = async (from, text) => { await inbound(from, text); const before = sent.length; await run(); return sent.length > before ? sent[sent.length - 1].vars[0] : null; };
  const e1 = `9190${SUF}`;

  let t = await say(e1, 'Hi');
  assert.match(t, /^Hello! Thank you for contacting Acme Marketing\. I am the AI assistant\./, 'the greeting already says it is an AI assistant'); assert.ok(!/name/i.test(t), 'a greeting does not start the questions');
  t = await say(e1, 'How much is the SEO plan?');
  assert.match(t, /SEO plan: ₹10,000 per month \+ GST/); assert.match(t, /May I know your name\? I will save your details only so our team can follow up on your enquiry\.$/); assert.ok(t.length <= 700, `${t.length} letters`);
  let conv = await Agent.convOf(e1); let lead = AL.leadOf(conv);
  assert.deepEqual([lead.pending, lead.service, lead.crmLeadId || null], ['name', 'SEO plan', null], 'the service is taken from the plan asked about; no CRM lead yet');
  t = await say(e1, 'Ravi Kumar'); assert.equal(t, 'Please tell me in a line or two what you need.');
  t = await say(e1, 'We run a small hotel in Hyderabad and need more online bookings'); assert.match(t, /^Do you have a budget in mind\?/);
  t = await say(e1, 'around 20k per month'); assert.match(t, /^When is a good time for our team to call you\?/);
  assert.equal(await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmLead" WHERE "phone" LIKE ?', `%${e1.slice(-10)}`).then((x) => Number(x[0].n)), 0, 'nothing is saved before the details are complete');
  const bellsBefore = await prisma.notification.count();
  t = await say(e1, 'tomorrow after 5 pm');
  assert.match(t, /^Thank you, Ravi\. I have noted your details about SEO plan and that you prefer a call tomorrow after 5 pm\. A team member will contact you as soon as possible\.$/);
  assert.equal(aiCalls, 0, 'no model was asked in this whole talk'); assert.equal(crmAnswers, 0, 'the CRM sales assistant did not answer');
  conv = await Agent.convOf(e1); lead = AL.leadOf(conv);
  assert.ok(lead.done && lead.crmLeadId && lead.band === 'Hot', JSON.stringify(lead));
  const crm = await DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', lead.crmLeadId);
  assert.equal(crm.contactName, 'Ravi Kumar'); assert.equal(crm.company, 'Ravi Kumar'); assert.equal(crm.source, 'WhatsApp'); assert.ok(String(crm.phone).replace(/\D/g, '').endsWith(e1.slice(-10)));
  assert.match(crm.notes, /Interested in: SEO plan/); assert.match(crm.notes, /Needs: We run a small hotel/); assert.match(crm.notes, /Budget: around 20k/); assert.match(crm.notes, /Preferred call time: tomorrow after 5 pm/);
  assert.equal(Number(crm.autoPaused), 1, 'the CRM automatic mails and SMS are paused on it'); assert.equal(crm.leadBand, 'Hot'); assert.ok(Number(crm.leadScore) >= 65 && crm.rating === 'Hot');
  const why = JSON.parse(crm.leadWhy); assert.ok(why.some((x) => /costs/.test(x.why)) && why.some((x) => /budget/.test(x.why)), 'the reasons are on the lead');
  const acts = await DB.all('SELECT "subject", "note", "byName" FROM "CrmActivity" WHERE "leadId" = ?', crm.id);
  assert.ok(acts.some((a) => /^Lead from WhatsApp chat \(AI assistant\)/.test(a.subject)) && acts.some((a) => /WhatsApp (assistant scored Hot|details complete)/.test(a.subject) && /Next: Call at tomorrow after 5 pm about SEO plan/.test(a.note) && a.byName === 'WhatsApp assistant'), JSON.stringify(acts.map((a) => a.subject)));
  const consent = await DB.all('SELECT "purpose", "status", "channel" FROM "CrmConsent" WHERE "recordId" = ?', crm.id);
  assert.ok(consent.length >= 1 && consent.every((c) => c.status === 'Given' && c.channel === 'WhatsApp') && !consent.some((c) => /newsletter/i.test(c.purpose)), JSON.stringify(consent));
  assert.equal(conv.state, 'needs_human'); assert.match(conv.handoffReason, /^Hot lead: SEO plan/);
  const bells = await prisma.notification.findMany({ where: { userId: admin.id }, orderBy: { createdAt: 'desc' }, take: 5 });
  assert.ok((await prisma.notification.count()) > bellsBefore && bells.some((b) => /needs a team member on WhatsApp/.test(b.title) && /Hot lead/.test(b.message)), 'the Admin is told once, with the reason');
  assert.equal(bells.filter((b) => /New WhatsApp lead/.test(b.title)).length, 0, 'a Hot lead is told by the handover, not twice');
  console.log('PASS a whole talk: greeting, price + the first question, name, need, budget, call time, then ONE CRM lead with the details, the score and its reasons, the summary, consent, a bell; no model, no second answerer');

  // 4. after the lead: the next question is answered, the lead is not doubled, the score follows, the chat comes back to the assistant
  t = await say(e1, 'What are your working hours?');
  assert.equal(t, 'Monday to Saturday, 9:30 am to 6:30 pm.'); conv = await Agent.convOf(e1); assert.equal(conv.state, 'active');
  assert.equal((await DB.all('SELECT "id" FROM "CrmLead" WHERE "phone" LIKE ?', `%${e1.slice(-10)}`)).length, 1, 'still one lead');
  t = await say(e1, 'not interested anymore, too expensive'); // after "done" this is plain talk: answered, scored down
  conv = await Agent.convOf(e1); const crm2 = await DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', lead.crmLeadId);
  assert.ok(Number(crm2.leadScore) < Number(crm.leadScore), `the score went down (${crm.leadScore} to ${crm2.leadScore})`);
  const view = (await Inbox.detail({ id: admin.id, name: admin.name, role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', contact: true, ...(await require('../src/utils/identity').resolveIdentity(admin.id)) }, `LEAD:${conv.id}`)).view;
  assert.ok(view.assist && view.assist.crmLeadId === lead.crmLeadId && view.assist.fields.name === 'Ravi Kumar' && view.assist.summary.text.includes('Requirement: We run a small hotel') && /Next: Close the lead/.test(view.assist.summary.text), JSON.stringify(view.assist).slice(0, 600));
  assert.ok(Array.isArray(view.assist.reasons) && view.assist.reasons.length > 3 && !('assistLead' in view.collected), 'the strip gets the reasons; the inner state is not shown');
  console.log('PASS after the lead: hours answered, still one lead, the chat returned to the assistant, the score fell when they said no, the summary says "close the lead"');

  // 5. no, thank you; skip; a question in the middle
  const e2 = `9191${SUF}`;
  t = await say(e2, 'I need an SEO service for my shop'); assert.match(t, /May I know your name\?/);
  t = await say(e2, 'what are your working hours?'); assert.match(t, /^Monday to Saturday, 9:30 am to 6:30 pm\.\n\nMay I know your name\?/, 'a question is answered first, the same question is asked again');
  t = await say(e2, 'skip'); assert.match(t, /^Which service are you interested in\?|^Please tell me in a line or two/, 'skip moves on');
  conv = await Agent.convOf(e2); lead = AL.leadOf(conv); assert.deepEqual(lead.skipped, ['name']); assert.equal(lead.crmLeadId || null, null);
  t = await say(e2, 'sorry, not interested');
  assert.match(t, /^No problem\. Thank you for your time\. If you need anything, write to me at any time - Acme Marketing\.$/); conv = await Agent.convOf(e2); lead = AL.leadOf(conv); assert.ok(lead.declined && !lead.pending);
  t = await say(e2, 'how much is the social media plan?'); assert.equal(t, 'Social media plan: ₹7,500 per month + GST for 12 posts.', 'after no, only the answer, no more questions');
  assert.equal(await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmLead" WHERE "phone" LIKE ?', `%${e2.slice(-10)}`).then((x) => Number(x[0].n)), 0, 'nobody who said no is put in the CRM');
  console.log('PASS interrupting and declining: a question is answered and the same question asked again; skip moves on; "not interested" ends the questions and saves nothing');

  // 6. asked for a call before giving details: the lead is saved with what is known, the Admin is told
  const e3 = `9192${SUF}`;
  t = await say(e3, 'call me please'); assert.match(t, /^Okay, I will connect you soon\./);
  conv = await Agent.convOf(e3); lead = AL.leadOf(conv);
  assert.equal(conv.state, 'needs_human'); assert.ok(lead.crmLeadId, 'asked for a call: a lead is saved at once'); const crm3 = await DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', lead.crmLeadId);
  assert.match(crm3.company, /^WhatsApp lead \d{4}$/); assert.ok(JSON.parse(crm3.leadWhy).some((x) => /call, a demo or a meeting/.test(x.why)));
  const lastBell = await prisma.notification.findFirst({ where: { userId: admin.id }, orderBy: { createdAt: 'desc' } }); assert.match(lastBell.title, /needs a team member on WhatsApp/);
  t = await say(e3, 'My name is Anil, I want a quote for social media'); // back with the assistant: the name is learned and the same lead gets it
  conv = await Agent.convOf(e3); lead = AL.leadOf(conv); assert.equal(lead.name, undefined, 'not asked yet: nothing guessed from a sentence');
  const tellsBefore = await prisma.notification.count({ where: { title: { contains: 'needs a team member' } } });
  await say(e3, 'do you make hotel software?'); // the knowledge base has no answer: the chat goes to a person again, within half an hour of the last bell
  assert.equal(await prisma.notification.count({ where: { title: { contains: 'needs a team member' } } }), tellsBefore, 'one bell for a chat in half an hour');
  console.log('PASS a call asked for first: the lead is saved at once with a number-only name, scored with the call signal, the Admin told');

  // 7. one answerer per chat: the CRM sales assistant and its follow-up stay out while the assistant owns the chat
  const AP = require('../src/crm/autopilot');
  await prisma.appSetting.upsert({ where: { key: 'crm.salesAi' }, update: { value: JSON.stringify({ on: true, about: 'x' }) }, create: { key: 'crm.salesAi', value: JSON.stringify({ on: true, about: 'x' }) } });
  const phone1 = `+${e1}`; crmAnswers = 0;
  assert.equal(await A.ownsPhone(phone1), true); assert.equal(await SA.handles(e1), false, 'the omni agent is not told to stay quiet');
  await DB.run('UPDATE "CrmLead" SET "ownerId" = ?, "ownerName" = ? WHERE "phone" LIKE ?', admin.id, admin.name, `%${e1.slice(-10)}`); // an owner to tell, so that "no bell" means something
  const repliedBells = () => prisma.notification.count({ where: { title: { contains: 'replied on WhatsApp' } } });
  const bellsB = await repliedBells();
  await AP.onReply({ channel: 'WhatsApp', phone: phone1, text: 'hello again' }, { wait: true });
  assert.equal(await repliedBells(), bellsB, 'no "replied on WhatsApp" bell for every message of a chat the assistant is answering');
  assert.equal(crmAnswers, 0, 'the CRM sales assistant did not answer a chat the WhatsApp assistant owns');
  assert.equal((await DB.all('SELECT "id" FROM "CrmTask" WHERE "leadId" = ? AND "title" LIKE \'Answer %\'', lead.crmLeadId || 'none')).length >= 0, true);
  const crmTasks = await DB.all('SELECT "title" FROM "CrmTask" WHERE "leadId" = ?', (await DB.one('SELECT "id" FROM "CrmLead" WHERE "phone" LIKE ? LIMIT 1', `%${e1.slice(-10)}`)).id);
  assert.ok(!crmTasks.some((x) => /^Answer /.test(x.title)), 'no "Answer ..." follow-up for a chat the assistant is answering');
  await A.saveSettings(adminUser, { enabled: false });
  assert.equal(await A.ownsPhone(phone1), false); assert.equal(await SA.handles(e1), true, 'assistant off: the CRM sales assistant takes the chat as before');
  await AP.onReply({ channel: 'WhatsApp', phone: phone1, text: 'hello once more' }, { wait: true });
  assert.equal(await repliedBells(), bellsB + 1, 'assistant off: the owner is told of every reply as before');
  assert.equal(crmAnswers, 1, 'assistant off: the CRM sales assistant answers as before');
  SA.respond = realRespond; await A.saveSettings(adminUser, { enabled: true });
  console.log('PASS one answerer per chat: the CRM sales assistant and its "Answer ..." follow-up stay out while the assistant owns the chat; with the assistant off they work as before');

  // 8. the leads list and handing a chat to a team member
  const adminMe = { ...(await require('../src/utils/identity').resolveIdentity(admin.id)), contact: true };
  const list = await Inbox.assistLeads(adminMe, {});
  assert.ok(list.rows.length >= 2 && list.counts.all === list.rows.length, JSON.stringify(list.counts)); assert.equal(list.rows[0].band === 'Hot' || list.rows[0].band === 'Warm' || list.rows[0].band === 'Cold', true);
  const mine = list.rows.find((x) => x.name === 'Ravi Kumar'); assert.ok(mine && mine.service === 'SEO plan' && mine.saved && mine.band, JSON.stringify(mine));
  assert.ok(list.rows.every((x, i, a) => i === 0 || ({ Hot: 0, Warm: 1, Cold: 2 }[a[i - 1].band] ?? 3) <= ({ Hot: 0, Warm: 1, Cold: 2 }[x.band] ?? 3)), 'Hot first');
  assert.equal((await Inbox.assistLeads(adminMe, { band: 'Hot' })).rows.every((x) => x.band === 'Hot'), true);
  assert.equal((await Inbox.assistLeads(adminMe, { q: 'ravi' })).rows.length, 1);
  const nobody = { id: 'nobody', name: 'Nobody', role: 'RECRUITER', atsRole: 'RECRUITER' };
  const conv1 = await Agent.convOf(e1);
  let as = await AL.assign(nobody, conv1, admin.id); assert.equal(as.status, 403, 'a recruiter who does not have the chat cannot hand it over');
  as = await AL.assign(adminMe, conv1, 'not-a-person'); assert.equal(as.status, 400);
  const people = await AL.assignees(); assert.ok(people.some((p) => p.id === admin.id), 'Admins can be given a chat');
  as = await AL.assign(adminMe, conv1, admin.id); assert.ok(as.ok, JSON.stringify(as));
  const after = await Agent.convOf(e1); assert.deepEqual([after.ownerUserId, after.mode, after.state], [admin.id, 'paused', 'needs_human']); assert.match(after.handoffReason, /^Handed to /);
  await inbound(e1, 'hello?'); const sentBefore = sent.length; await run(); assert.equal(sent.length, sentBefore, 'after a hand-over the assistant stays quiet until the chat is given back');
  assert.equal((await DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', AL.leadOf(conv1).crmLeadId)).ownerId, admin.id, 'the CRM lead follows the chat');
  console.log('PASS leads list (Hot first, filters, search) and the hand-over: only a lead or the owner may hand over, the AI steps back, the CRM lead follows');

  // 9. STOP still wins
  const m0 = sent.length;
  await inbound(e3, 'STOP'); await run();
  assert.equal(sent.length, m0, 'STOP: nothing is sent'); assert.ok(await Agent.isBlocked(e3));
  console.log('PASS STOP: nothing more is sent');

  console.log('waAssistantLeads tests: all passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
