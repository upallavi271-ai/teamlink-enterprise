// AI WhatsApp Marketing Assistant, phase 1 (omniwa/assist.js + config.js + guard.js + agent.js hook): answers from the knowledge base that never invent.
//   node backend/test-fixtures/waAssistant.test.js     (throw-away copy of prisma/sandbox.db; TEST_MODE: nothing is sent, the WhatsApp send and the language model are stand-ins)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-assist-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.TEST_ALLOW_AI = '1'; process.env.WA_AI_FAST = '0';
const A = require('../src/omniwa/assist');
const Cfg = require('../src/omniwa/config');
const G = require('../src/omniwa/guard');
const { ensure } = require('../src/omniwa/schema');
const S = require('../src/outreach/store');

const E = (id, category, question, answer) => ({ id, category, question, answer, confirmedAt: null });
const KB = [
  E('p1', 'pricing', 'SEO plan', '₹10,000 per month + GST. Includes keyword research and 4 blogs.'),
  E('p2', 'pricing', 'Social media plan', '₹7,500 per month + GST for 12 posts.'),
  E('h1', 'hours', 'Working hours', 'We are open Monday to Saturday, 9:30 am to 6:30 pm. Closed on Sundays.'),
  E('c1', 'contact', 'Contact', 'Call 9876543210 or write to hello@acme.in. Office: Road No 1, Hyderabad. Book a call: https://acme.in/book'),
  E('s1', 'services', 'SEO', 'Search engine optimisation: audit, keywords, content and links.'),
  E('s2', 'services', 'Social media marketing', 'Posts, reels and ad campaigns for your pages.'),
  E('s3', 'services', 'Google Business Profile', 'Setup, posts and review replies for your Google listing.'),
  E('o1', 'policies', 'Refund policy', 'Fees are not refundable once work has started.'),
  E('f1', 'faq', 'Do you work with small businesses?', 'Yes, most of our clients are small and medium businesses.'),
  E('w1', 'website', 'Home: Digital marketing', 'We grow businesses online with SEO, ads and content. Packages start at ₹5,000. (Page: https://acme.in/)'),
];
const ST = { enabled: true, businessName: 'Acme Marketing', greeting: '', noAnswer: '', aiWording: true, collectLeads: false }; // phase 1 is the knowledge base alone: lead capture is tested in waAssistantLeads.test.js
const ask = (q, entries = KB) => A.answer(q, { entries, settingsNow: ST });

(async () => {
  // 1. a price comes only from a pricing entry, word for word
  let r = await ask('What is the price of the SEO plan?');
  assert.equal(r.kind, 'answer'); assert.equal(r.category, 'pricing');
  assert.equal(r.text, 'SEO plan: ₹10,000 per month + GST. Includes keyword research and 4 blogs.'); assert.ok(!/7,500/.test(r.text), 'only the plan asked about');
  r = await ask('what are your prices');
  assert.equal(r.kind, 'answer'); assert.match(r.text, /• SEO plan: ₹10,000/); assert.match(r.text, /• Social media plan: ₹7,500/);
  r = await ask('How much does it cost?'); assert.match(r.text, /SEO plan/); assert.match(r.text, /Social media plan/);
  r = await ask('price for hotel management software');
  assert.equal(r.kind, 'none'); assert.ok(r.noPrice, 'no price entry names a hotel software: nothing is quoted, and the website text with "₹5,000" is not used');
  r = await ask('how much is SEO', KB.filter((e) => e.category !== 'pricing'));
  assert.equal(r.kind, 'none'); assert.ok(r.noPrice, 'no pricing entry at all: never a price from the website or any other entry');
  r = await ask('Do you give any discount?'); assert.equal(r.kind, 'none'); assert.ok(r.noPrice, 'a discount that no entry states is never made up');
  assert.match((await A.testQuestion('Do you give any discount?')).text, /discount|offer|price/i);
  console.log('PASS prices: only from a pricing entry, word for word; the asked plan only; all plans for a general question; none for something not listed; none from the website; no discount invented');

  // 2. other kinds of question
  r = await ask('Are you open on Sunday?'); assert.equal(r.category, 'hours'); assert.match(r.text, /Monday to Saturday/);
  r = await ask('What time do you close?'); assert.equal(r.category, 'hours');
  r = await ask('What is your phone number and address?'); assert.equal(r.category, 'contact'); assert.match(r.text, /9876543210/); assert.deepEqual(r.links, ['https://acme.in/book'], 'a link the business wrote is kept');
  r = await ask('What is your refund policy?'); assert.equal(r.category, 'policies'); assert.match(r.text, /not refundable/);
  r = await ask('Do you provide SEO services?'); assert.equal(r.category, 'services'); assert.match(r.text, /Search engine optimisation/); assert.ok(!/Social media/.test(r.text));
  r = await ask('What services do you offer?'); assert.equal(r.category, 'services'); assert.match(r.text, /• SEO:/); assert.match(r.text, /• Google Business Profile:/);
  r = await ask('Do you work with small businesses?'); assert.equal(r.category, 'faq'); assert.match(r.text, /small and medium/);
  r = await ask('tell me about your company', KB.filter((e) => e.category !== 'company')); assert.equal(r.kind, 'none');
  console.log('PASS other questions: hours, contact (with the business link), policy, services, FAQ; nothing found is said as nothing found');

  // 3. small talk is not a question the knowledge base fails
  r = await ask('hi'); assert.equal(r.kind, 'smalltalk'); assert.match(r.text, /Acme Marketing/); assert.match(r.text, /AI assistant/); assert.match(r.text, /our services, prices, working hours, how to reach us or our policies|our services/);
  assert.equal((await ask('hello', [])).text.includes('You can ask me about'), false, 'with an empty knowledge base it does not promise topics');
  r = await ask('thanks'); assert.equal(r.kind, 'smalltalk'); assert.match(r.text, /welcome/i);
  r = await ask('yes'); assert.equal(r.kind, 'smalltalk'); assert.match(r.text, /What would you like to know/);
  r = await A.answer('hi', { entries: KB, settingsNow: { ...ST, greeting: 'Namaste! Ask away.' } }); assert.equal(r.text, 'Namaste! Ask away.');
  console.log('PASS small talk: greeting names only the topics that have entries, thanks, yes; the business may write its own greeting');

  // 4. the safety check on anything the model writes
  const f = 'SEO plan: ₹10,000 per month + GST. Call 9876543210 or write to hello@acme.in. Open 9:30 to 6:30.';
  assert.equal(G.factsProblem('The SEO plan is Rs 10000 per month plus GST.', f), null);
  assert.match(G.factsProblem('The SEO plan costs ₹12,000 per month.', f), /12000/);
  assert.match(G.factsProblem('It takes 2 days.', f), /"2"/);
  assert.match(G.factsProblem('Call 9999999999.', f), /9999999999/);
  assert.equal(G.factsProblem('Call 98765 43210.', f), null, 'the same phone number written with a space');
  assert.match(G.factsProblem('Mail sales@other.com', f), /e-mail/);
  assert.match(G.factsProblem('We guarantee first page ranking.', f), /guarantee/i);
  assert.match(G.factsProblem('You get a 10% discount.', `${f} 10`), /discount/i);
  assert.match(G.factsProblem('Fees are refundable.', f), /refund/i);
  assert.equal(G.factsProblem('Feel free to ask. We are open 9:30 to 6:30.', f), null);
  assert.equal(G.factsProblem('1) SEO\n2) Social media', f), null, 'list numbers are not facts');
  assert.equal(G.factsProblem('You asked about 3 pages.', f, 'I need 3 pages'), null, 'a number the customer wrote may be repeated');
  console.log('PASS the check on model words: any number, phone, e-mail, discount, offer, guarantee, refund that the facts lack is stopped');

  // 5. reply(): what the agent gets back, with a stand-in model
  await ensure();
  const conv = { id: 'zzc1', numberId: 'zzn', e164: '919000000011' };
  let modelCalls = 0; let script = [];
  const model = async () => { modelCalls += 1; const n = script.shift(); if (n instanceof Error) throw n; return n; };
  const deps = (extra = {}) => ({ settings: ST, entries: KB, model, history: [], ...extra });
  let out = await A.reply(conv, 'What is the price of the SEO plan?', deps());
  assert.equal(modelCalls, 0, 'a clear match never asks the model'); assert.equal(out.written, true); assert.equal(out.marketing, true); assert.equal(out.ctx.handoff, null);
  assert.equal(out.reply, "Acme Marketing's AI assistant: SEO plan: ₹10,000 per month + GST. Includes keyword research and 4 blogs.", 'the first reply says it is an AI assistant');
  assert.equal(out.calls[0].tool, 'knowledge_answer'); assert.deepEqual(out.calls[0].result.entries, ['SEO plan']);
  await S.run('INSERT INTO "OmniWaMessage" (id, e164, convId, direction, body, status, aiGenerated, at, createdAt) VALUES (?,?,?,?,?,?,?,?,?)', 'zzm1', conv.e164, conv.id, 'OUT', 'x', 'sent', 1, Date.now(), Date.now());
  out = await A.reply(conv, 'And the social media plan price?', deps());
  assert.ok(!/AI assistant:/.test(out.reply) && /^Social media plan: ₹7,500/.test(out.reply), 'only the first reply carries the introduction');
  out = await A.reply(conv, 'What is the contact?', deps()); assert.deepEqual(out.trusted, ['https://acme.in/book']);

  out = await A.reply(conv, 'price for hotel management software', deps());
  assert.equal(modelCalls, 0, 'a price question that no entry answers never reaches the model'); assert.equal(out.reply, A.NO_PRICE); assert.match(out.ctx.handoff, /price/i);

  const vague = 'Do you run ad campaigns for restaurants outside India?';
  script = [{ reply: 'Yes, we run ad campaigns for your pages.', answered: true }];
  out = await A.reply(conv, vague, deps());
  assert.equal(modelCalls, 1); assert.equal(out.reply, 'Yes, we run ad campaigns for your pages.'); assert.equal(out.ctx.handoff, null); assert.equal(out.assist.how, 'ai_wording');
  script = [{ reply: 'Yes, and you get a 20% discount.', answered: true }];
  out = await A.reply(conv, vague, deps());
  assert.equal(out.reply, A.NO_ANSWER); assert.ok(out.ctx.handoff, 'a reply with a made-up discount is thrown away and a person is asked');
  script = [{ reply: '', answered: false }];
  out = await A.reply(conv, vague, deps()); assert.equal(out.reply, A.NO_ANSWER); assert.ok(out.ctx.handoff);
  script = [new Error('model down')];
  out = await A.reply(conv, vague, deps()); assert.equal(out.reply, A.NO_ANSWER); assert.ok(out.ctx.handoff, 'no model, no problem: the customer is told plainly');
  const before = modelCalls;
  out = await A.reply(conv, vague, deps({ settings: { ...ST, aiWording: false } }));
  assert.equal(modelCalls, before, 'AI wording off: the model is not asked'); assert.equal(out.reply, A.NO_ANSWER);
  out = await A.reply(conv, vague, deps({ model: null })); assert.equal(out.reply, A.NO_ANSWER);
  out = await A.reply(conv, vague, deps({ settings: { ...ST, noAnswer: 'We will check and reply.' }, model: null })); assert.equal(out.reply, 'We will check and reply.');
  console.log('PASS reply(): clear match = no model; price not listed = plain "no" + a person; model words checked (a made-up discount is dropped); model down or off = the same plain "no"; introduced once');

  // 6. the knowledge base itself: categories, price limits, confirmed date, lists, the old recruitment rows
  const admin = { name: 'Test Admin' };
  let k = await Cfg.kbSave(admin, null, { category: 'pricing', question: 'Growth plan', answer: '₹15,000 per month + GST.' }); assert.ok(k.ok);
  let rows = await Cfg.kbList(); let row = rows.find((x) => x.id === k.id);
  assert.equal(row.category, 'pricing'); assert.ok(row.confirmedAt > 0, 'saving a price confirms it');
  assert.equal((await Cfg.kbSave(admin, null, { category: 'pricing', question: 'Long', answer: 'x'.repeat(401) })).status, 400, 'a price entry is one short message');
  assert.equal((await Cfg.kbSave(admin, null, { category: 'pricing', question: 'y'.repeat(121), answer: '₹1' })).status, 400);
  k = await Cfg.kbSave(admin, k.id, { question: 'Growth plan', answer: '₹16,000 per month + GST.' }); assert.ok(k.ok);
  row = (await Cfg.kbList()).find((x) => x.id === k.id); assert.equal(row.category, 'pricing', 'an edit without a category keeps the category'); assert.match(row.answer, /16,000/);
  k = await Cfg.kbSave(admin, null, { question: 'Old style entry', answer: 'No category given.' }); row = (await Cfg.kbList()).find((x) => x.id === k.id); assert.equal(row.category, 'faq');
  const withPrice = await Cfg.kbSearch('Growth plan per month', 5, null); const noPrice = await Cfg.kbSearch('Growth plan per month', 5, null, { skip: ['pricing'] });
  assert.ok(withPrice.some((x) => /Growth plan/.test(x.question)) && !noPrice.some((x) => /Growth plan/.test(x.question)), 'the search the recruitment AI uses can leave prices out');
  assert.match(fs.readFileSync(path.join(BACK, 'src/omniwa/tools.js'), 'utf8'), /kbSearch\(a\.query, 3, conv\.numberId, \{ skip: \['pricing'\] \}\)/, 'and the recruitment AI tool does');
  const old = S.newId('wak');
  await S.run('INSERT INTO "OmniWaKnowledge" (id, question, answer, active, createdAt, updatedAt) VALUES (?,?,?,?,?,?)', old, 'How do I apply for the job?', 'Use the apply link.', 1, Date.now(), Date.now());
  assert.equal((await Cfg.kbList()).find((x) => x.id === old).category, 'faq', 'a row from before categories reads as a plain FAQ');
  let used = (await A.activeEntries('zzn')).map((e) => e.id); assert.ok(!used.includes(old), 'a recruitment FAQ shared by every number (no category) is not used by the marketing assistant');
  await S.run('UPDATE "OmniWaKnowledge" SET numberId = ? WHERE id = ?', 'zzn', old); used = (await A.activeEntries('zzn')).map((e) => e.id); assert.ok(used.includes(old), 'but one written for this number is');
  used = (await A.activeEntries('other')).map((e) => e.id); assert.ok(!used.includes(old), 'and never for another number');

  const list = ['category,question,answer', 'pricing,"Starter, monthly","₹3,000 per month + GST"', 'hours,Timings,Mon-Sat 9 to 6', 'bogus,X,Y', 'faq,Only a question,'].join('\n');
  const parsed = Cfg.parseKbList(list);
  assert.deepEqual(parsed.rows.map((x) => [x.category, x.question, x.answer]), [['pricing', 'Starter, monthly', '₹3,000 per month + GST'], ['hours', 'Timings', 'Mon-Sat 9 to 6']]);
  assert.equal(parsed.errors.length, 2); assert.match(parsed.errors[0].reason, /Unknown category "bogus"/); assert.equal(parsed.errors[0].line, 4); assert.match(parsed.errors[1].reason, /empty/);
  assert.deepEqual(Cfg.parseKbList('pricing | Pro plan | ₹9,000 | per month + GST').rows[0], { category: 'pricing', question: 'Pro plan', answer: '₹9,000 | per month + GST' });
  assert.equal(Cfg.parseKbList('Which hours? | Mon-Sat').rows[0].category, 'faq'); assert.ok(Cfg.parseKbList('   \n# nothing').errors.length);
  let imp = await Cfg.kbImportRows(admin, list, { numberId: 'zzn' }); assert.deepEqual([imp.added, imp.updated, imp.errors.length], [2, 0, 2]);
  imp = await Cfg.kbImportRows(admin, 'pricing,"Starter, monthly","₹3,500 per month + GST"', { numberId: 'zzn' }); assert.deepEqual([imp.added, imp.updated], [0, 1], 'the same entry is updated, never doubled');
  rows = (await Cfg.kbList()).filter((x) => x.question === 'Starter, monthly'); assert.equal(rows.length, 1); assert.match(rows[0].answer, /3,500/); assert.equal(rows[0].numberId, 'zzn');
  assert.equal((await Cfg.kbImportRows(admin, 'nothing useful here')).status, 400);
  console.log('PASS knowledge base: categories, price limits and confirmed date, the old recruitment rows stay out, pasted lists with line-by-line errors, no doubles');

  // 7. settings and the screen's calls
  let sv = await A.saveSettings(admin, { enabled: true, businessName: 'Zed Co', noAnswer: 'x'.repeat(400) });
  assert.equal(sv.settings.enabled, true); assert.equal(sv.settings.noAnswer.length, 300); assert.equal(sv.was.enabled, false);
  assert.equal(await A.isOn(), true); sv = await A.saveSettings(admin, { enabled: false }); assert.equal(sv.settings.businessName, 'Zed Co', 'a saved field is kept when the call does not mention it'); assert.equal(await A.isOn(), false);
  const ov = await A.overview(); assert.ok(ov.categories.some((c) => c.key === 'pricing') && ov.counts.pricing >= 1 && typeof ov.aiReady === 'boolean' && Array.isArray(ov.marketingNumbers));
  const routes = require('../src/routes/omniWa').stack.filter((l) => l.route).map((l) => [Object.keys(l.route.methods)[0], l.route.path, l.route.stack.length]);
  for (const [m, p] of [['get', '/assistant'], ['put', '/assistant'], ['put', '/assistant/numbers/:numberId'], ['post', '/assistant/ask'], ['post', '/knowledge/import']]) {
    const hit = routes.find((x) => x[0] === m && x[1] === p); assert.ok(hit, `${m} ${p} exists`); assert.ok(hit[2] >= 2, `${m} ${p} is Admin only`);
  }
  console.log('PASS settings and routes: saved fields kept, limits, overview, five Admin-only routes');

  // 8. through the real agent: stand-in WhatsApp send, stand-in model, the real rules around them
  const ai = require('../src/utils/ai'); let aiCalls = 0; ai.chatJson = async () => { aiCalls += 1; return { reply: 'Old marketing answer from the model.' }; };
  const messaging = require('../src/utils/messaging'); const sent = []; let n = 0;
  messaging.send = async (channel, o) => { n += 1; sent.push({ channel, ...o }); return { ok: true, outcome: 'sent', providerRef: `zzref${n}` }; };
  const Agent = require('../src/omniwa/agent'); const delivery = require('../src/utils/messageDelivery');
  const SUF = String(Date.now()).slice(-7);
  const e164 = `9190${SUF}`;
  let id = 0; const inbound = (text, from = e164) => { id += 1; return Agent.onInbound({ channel: 'WhatsApp', from, text, id: `wamid.ZZA${SUF}${id}`, at: new Date(), name: 'ZZTEST Visitor', numberId: 'zzn' }, { personType: null, review: true, reason: 'none' }); };
  const run = () => Agent.tick(Date.now(), { force: true });
  const lastSent = () => sent[sent.length - 1];
  await Cfg.save(admin, { enabled: true, systemPrompt: 'You help.', fallbackMessage: 'Our team will contact you soon.' });
  await Cfg.setMarketingNumber('zzn', true);
  await S.run('DELETE FROM "OmniWaKnowledge"');
  for (const e of KB.filter((x) => x.category !== 'website')) await Cfg.kbSave(admin, null, { category: e.category, question: e.question, answer: e.answer, numberId: 'zzn' });
  await A.saveSettings(admin, { enabled: true, businessName: 'Acme Marketing', noAnswer: '', aiWording: true, collectLeads: false });

  await inbound('What is the price of the SEO plan?'); await run();
  assert.equal(sent.length, 1, 'one reply'); assert.equal(aiCalls, 0, 'the model was not asked');
  assert.equal(lastSent().vars[0], "Acme Marketing's AI assistant: SEO plan: ₹10,000 per month + GST. Includes keyword research and 4 blogs.");
  assert.equal(lastSent().numberId, 'zzn');
  let cv = await Agent.convOf(e164); assert.equal(cv.state, 'active');

  await inbound('Do you make hotel software?'); await run();
  assert.equal(sent.length, 2); cv = await Agent.convOf(e164);
  assert.equal(cv.state, 'needs_human', 'what the knowledge base cannot answer goes to a person'); assert.match(cv.handoffReason, /knowledge base/);
  assert.ok([A.NO_ANSWER, A.NO_PRICE].includes(lastSent().vars[0]), lastSent().vars[0]);
  assert.ok(!/AI assistant:/.test(lastSent().vars[0]), 'introduced once');

  await inbound('What are your working hours?'); await run();
  assert.equal(sent.length, 3); assert.match(lastSent().vars[0], /^We are open Monday to Saturday/); cv = await Agent.convOf(e164);
  assert.equal(cv.state, 'active', 'a chat the AI passed on comes back with the next question');

  await inbound('Where can I book a call?'); await run();
  assert.match(lastSent().vars[0], /https:\/\/acme\.in\/book/, 'a link the business wrote in its own entry is not stripped');

  await inbound('I want to talk to someone'); await run();
  cv = await Agent.convOf(e164); assert.equal(cv.state, 'needs_human'); assert.equal(lastSent().vars[0], 'Our team will contact you soon.', 'asking for a person still works as before');
  const m0 = sent.length;
  await inbound('STOP'); await run();
  cv = await Agent.convOf(e164); assert.equal(cv.state, 'stopped'); assert.equal(sent.length, m0, 'STOP: nothing more is sent');
  assert.ok(await Agent.isBlocked(e164));

  // the assistant switched off: the marketing number answers the way it did before this phase
  await A.saveSettings(admin, { enabled: false });
  const e2 = `9191${SUF}`;
  await inbound('What is the price of the SEO plan?', e2); const k0 = sent.length; await run();
  assert.ok(aiCalls > 0 && sent.length === k0 + 1, 'assistant off: the old marketing answer (the model) is used'); assert.equal(lastSent().vars[0].includes('Old marketing answer'), true);
  console.log('PASS agent: price answered with no model, unknown goes to a person, comes back on the next question, own link kept, "talk to someone" and STOP as before, assistant off = old behaviour');

  console.log('waAssistant tests: all passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
