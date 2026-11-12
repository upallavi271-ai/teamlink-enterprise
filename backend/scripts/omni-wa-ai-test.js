#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL > WHATSAPP WITH THE AI AGENT (founder 2026-11-05). NO REAL META, NO REAL MODEL, NO REAL DATABASE.
//   cd backend && node scripts/omni-wa-ai-test.js [path of a sandbox .db to copy; default prisma/sandbox.db]
// TEST_MODE=1: every WhatsApp send is reported as sent and never transmitted (utils/whatsappCloud.js). The language model is a stub Ollama on 127.0.0.1 that answers a script,
// so what is proved is everything AROUND the model: the rules, the tools, the states. The real model's language and judgement are NOT proved here.
// The copy of the database is deleted at the end.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const BACK = path.join(__dirname, '..');
const srcDb = process.argv[2] || path.join(BACK, 'prisma', 'sandbox.db');
const copy = path.join(os.tmpdir(), `tl-omniwa-${Date.now()}.db`);
let pass = 0; let fail = 0;
const check = (name, ok, info) => { if (ok) { pass += 1; console.log(`  PASS ${name}`); } else { fail += 1; console.log(`  FAIL ${name}`, info === undefined ? '' : JSON.stringify(info, (k, v) => (typeof v === 'bigint' ? Number(v) : v)).slice(0, 500)); } };

(async () => {
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(srcDb, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.replace(/\\/g, '/')}'`);
  src.close();
  process.env.DATABASE_URL = `file:${copy.replace(/\\/g, '/')}`;
  process.env.TEST_MODE = '1';
  process.env.TEST_ALLOW_AI = '1';
  process.env.AI_PROVIDER = 'ollama';

  // stub Ollama: answers the next line of the script; a function may look at the request
  const stub = { script: [], calls: [], down: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      stub.calls.push(body);
      if (stub.down) { res.writeHead(500); return res.end('{"error":"down"}'); }
      const next = stub.script.shift();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: { content: typeof next === 'string' ? next : JSON.stringify(next || { reply: '' }) } }));
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.address().port}`;

  const prisma = require(path.join(BACK, 'src/db'));
  const S = require(path.join(BACK, 'src/outreach/store'));
  const delivery = require(path.join(BACK, 'src/utils/messageDelivery'));
  const Agent = require(path.join(BACK, 'src/omniwa/agent'));
  const Cfg = require(path.join(BACK, 'src/omniwa/config'));
  const Inbox = require(path.join(BACK, 'src/omniwa/inbox'));
  const Promo = require(path.join(BACK, 'src/omniwa/promo'));
  const G = require(path.join(BACK, 'src/omniwa/guard'));
  const Live = require(path.join(BACK, 'src/omniwa/live'));
  const { ensure } = require(path.join(BACK, 'src/omniwa/schema'));

  const SUFFIX = String(Date.now()).slice(-8);
  const phoneOf = (n) => `919${String(n).padStart(2, '0')}${SUFFIX.slice(-7)}`; // 91 + 10 digits, fresh on every run
  let provider = 0;
  const inbound = (from, text, name = 'ZZTEST Sender') => { provider += 1; return delivery.applyInbound({ channel: 'WhatsApp', from, text, id: `wamid.ZZ${SUFFIX}${provider}`, at: new Date(), name }); };
  const run = () => Agent.tick(Date.now(), { force: true });
  const convAt = (e164) => Agent.convOf(e164);
  const aiMsgs = (candidateId) => prisma.candidateMessage.findMany({ where: { candidateId, template: 'AI' }, orderBy: { createdAt: 'asc' } });
  const LINK = /https?:\/\/\S+#\/job\/tl_/;

  try {
    await ensure();
    const admin = await prisma.user.findFirst({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
    const other = await prisma.user.findFirst({ where: { role: { notIn: ['ADMIN', 'SUPER_ADMIN', 'CLIENT', 'CANDIDATE'] } } }).catch(() => null);
    const client = await prisma.client.findFirst();
    const job = await prisma.requirement.create({ data: { title: 'ZZTEST Physics Lecturer', clientId: client.id, status: 'OPEN', portalPublished: true, location: 'Hyderabad', experience: '2-6 years', salary: '8 LPA', skills: 'Physics', description: 'ZZTEST We need a physics lecturer who can teach degree students in Hyderabad, full time.' } });
    const mkCandidate = async (n, name) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST ${name}`, phone: `+${phoneOf(n)}` } });
      await prisma.application.create({ data: { candidateId: c.id, requirementId: job.id, ownerRecruiterId: other ? other.id : null } });
      return c;
    };
    const promote = (c, n, campaign = `zzjob${n}${SUFFIX}`, withJob = false) => Promo.logBulk({
      id: campaign, kind: 'bulk', audience: 'candidates', purpose: 'ZZTEST job promotion', requirementId: withJob ? job.id : null, templates: { WhatsApp: { name: 'job_update' } }, sender: { senderUserId: other ? other.id : admin.id, senderName: 'ZZTEST Recruiter' },
    }, [{ channel: 'WhatsApp', status: 'sent', address: `+${phoneOf(n)}`, text: 'ZZTEST We have a job', entityId: c.id, providerRef: `zzout${n}${SUFFIX}`, sentAt: new Date() }]);

    // ---- 1. off by default
    console.log('\n-- off until an Admin switches it on');
    const a = await mkCandidate(1, 'Asha');
    await promote(a, 1);
    const off = await Cfg.read();
    await inbound(phoneOf(1), 'Hi');
    stub.calls.length = 0;
    await run();
    check('AI is OFF by default: nothing sent, the model is not asked', off.enabled === false && stub.calls.length === 0 && (await aiMsgs(a.id)).length === 0);

    const saved = await Cfg.save(admin, { enabled: true, systemPrompt: 'You help candidates.', fallbackMessage: 'Our team will contact you soon.' });
    check('settings are saved', saved.ok && saved.config.enabled);
    await Cfg.kbSave(admin, null, { question: 'What are your office timings?', answer: 'Our office is open 9:30 to 6:30, Monday to Saturday.' });

    // ---- 2. the promised test: promotion -> interested -> AI collects, sends the link -> talk to someone -> handoff
    console.log('\n-- promotion, interested, details, apply link, then a person');
    const conv0 = await convAt(phoneOf(1));
    check('the reply is tied to the promotion: job, campaign, owner', conv0.requirementId === job.id && !!conv0.campaignId && !!conv0.promoAt && !!conv0.ownerUserId, conv0);
    await inbound(phoneOf(1), 'sounds good to me');
    stub.script = [{ tool: 'get_candidate_profile', args: {} }, { tool: 'save_candidate_data', args: { interested: true, location: 'Hyderabad' } }, { reply: 'Great! When can you join, and what is your expected salary?' }];
    await run();
    let sent = await aiMsgs(a.id);
    const sys = stub.calls[stub.calls.length - 1].messages[0].content;
    check('AI answers once through the WhatsApp send, logged on the candidate like any message', sent.length === 1 && /expected salary/.test(sent[0].body) && sent[0].senderName === 'AI assistant' && !!sent[0].providerRef, [sent, (await Inbox.runs({ limit: 2 })).map((r) => [r.outcome, r.error])]);
    check('the model got the rules, the tools and the job, and NOT the client name', /Answer only from the job data/.test(sys) && /get_job_details/.test(sys) && /ZZTEST Physics Lecturer/.test(sys) && !sys.includes(client.name), sys.slice(-300));
    check('the location was saved, and the interest is on the chat', JSON.parse((await convAt(phoneOf(1))).collected).interested === true && (await prisma.candidate.findUnique({ where: { id: a.id } })).location === 'Hyderabad');
    await inbound(phoneOf(1), '30 days notice, expecting 8 LPA');
    stub.script = [{ tool: 'save_candidate_data', args: { notice_period: '30 days', expected_salary: '8 LPA' } }, { tool: 'send_apply_link', args: {} }, { reply: 'Thank you. Please apply here.' }];
    await run();
    sent = await aiMsgs(a.id);
    check('apply link: TeamLink adds the real link to the reply, and without a login it opens registration first (tl_apply=1)', sent.length === 2 && LINK.test(sent[1].body) && /src=whatsapp/.test(sent[1].body) && /tl_apply=1/.test(sent[1].body), sent[1] && sent[1].body);
    stub.calls.length = 0;
    // founder 2026-11-09: asked again = answered again, never "you already have it"
    await inbound(phoneOf(1), 'please send the apply link again');
    await run();
    sent = await aiMsgs(a.id);
    check('the apply link asked for again: sent again, not "you already have it"', sent.length === 3 && LINK.test(sent[2].body) && !/already/i.test(sent[2].body) && stub.calls.length === 0, sent[2] && sent[2].body);
    stub.calls.length = 0;
    await inbound(phoneOf(1), 'I want to talk to someone');
    await run();
    let conv = await convAt(phoneOf(1));
    sent = await aiMsgs(a.id);
    check('talk to someone: a person is called in, the person is told, the model is not even asked', conv.state === 'needs_human' && stub.calls.length === 0 && sent[sent.length - 1].body === 'Our team will contact you soon.', conv);
    const { resolveIdentity } = require(path.join(BACK, 'src/utils/identity'));
    const adminMe = { ...(await resolveIdentity(admin.id)), contact: true };
    const viewAdmin = await Inbox.list(adminMe, { filter: 'human' });
    check('the handoff shows in the inbox under Needs human', viewAdmin.rows.some((r) => r.personId === a.id && r.ai.badge === 'needs_human'), viewAdmin.counts);
    await inbound(phoneOf(1), 'hello?');
    stub.calls.length = 0;
    await run();
    check('after a handoff the AI stays quiet', stub.calls.length === 0 && (await aiMsgs(a.id)).length === sent.length);

    // ---- 3. debounce + idempotent
    console.log('\n-- quick messages and repeats');
    const b = await mkCandidate(2, 'Bala');
    await promote(b, 2, undefined, true);
    await inbound(phoneOf(2), 'Hello');
    await inbound(phoneOf(2), 'is the job open?');
    const waiting = await Agent.tick(Date.now());
    check('inside the debounce time nothing runs', (waiting.ran || []).length === 0);
    stub.script = [{ reply: 'Yes, it is open.' }];
    await run();
    check('two quick messages get ONE reply', (await aiMsgs(b.id)).length === 1);
    const id = `wamid.ZZdup${SUFFIX}`;
    await delivery.applyInbound({ channel: 'WhatsApp', from: phoneOf(2), text: 'same one', id, at: new Date() });
    await delivery.applyInbound({ channel: 'WhatsApp', from: phoneOf(2), text: 'same one', id, at: new Date() });
    const dup = await S.q('SELECT COUNT(*) AS n FROM "OmniWaMessage" WHERE providerMessageId = ?', id);
    stub.script = [{ reply: 'Okay.' }];
    await run();
    check('the same provider message id is handled once', Number(dup[0].n) === 1 && (await aiMsgs(b.id)).length === 2);

    // ---- 4. the guard
    console.log('\n-- what the model may not do');
    await inbound(phoneOf(2), 'how much is the bonus?');
    stub.script = [{ reply: 'You get a salary of 15 LPA with a joining bonus.' }];
    await run();
    conv = await convAt(phoneOf(2));
    const lastB = (await aiMsgs(b.id)).pop();
    check('an invented salary never leaves: the fallback goes, a recruiter is called', conv.state === 'needs_human' && lastB.body === 'Our team will contact you soon.' && !(await aiMsgs(b.id)).some((m) => /15 LPA/.test(m.body)), lastB.body);
    const blocked = (await Inbox.runs({ limit: 20 })).find((r) => r.outcome === 'blocked_by_guard');
    check('the blocked draft is in the run log with the reason', !!blocked && /15 LPA/.test(blocked.output) && !!blocked.error, blocked);
    check('8 LPA from the job is allowed; a benefit that is not in the job is not', G.promiseProblem('The salary is 8 LPA.', '{"salary":"8 LPA"}') === null && !!G.promiseProblem('You also get free insurance.', '{"salary":"8 LPA"}'));
    check('a link typed by the model is taken out, the real one stays', G.stripLinks('See https://evil.example/x and https://ok.example/a', ['https://ok.example/a']) === 'See and https://ok.example/a');
    await Agent.resume(conv);
    const backed = await convAt(phoneOf(2));
    check('Give back to AI: the chat is the AI\'s again', backed.state === 'active' && backed.mode === 'ai');

    const c = await mkCandidate(3, 'Chitra');
    await promote(c, 3);
    await inbound(phoneOf(3), 'not interested, thanks');
    stub.script = [{ tool: 'save_candidate_data', args: { interested: false } }, { reply: 'Thank you for your time.' }];
    await run();
    conv = await convAt(phoneOf(3));
    await inbound(phoneOf(3), 'ok');
    stub.calls.length = 0;
    await run();
    check('not interested: marked, thanked once, no more messages', conv.state === 'not_interested' && (await aiMsgs(c.id)).length === 1 && stub.calls.length === 0);
    await inbound(phoneOf(3), 'Yes');
    await run();
    check('a person who said no and then says Yes is answered again', (await convAt(phoneOf(3))).state === 'active' && (await aiMsgs(c.id)).length === 2);

    stub.down = true;
    const d = await mkCandidate(4, 'Deepa');
    await promote(d, 4);
    await inbound(phoneOf(4), 'can you help me please');
    await run();
    stub.down = false;
    conv = await convAt(phoneOf(4));
    check('the model is down: the fallback goes and a recruiter is called', conv.state === 'needs_human' && (await aiMsgs(d.id))[0].body === 'Our team will contact you soon.', conv);
    await inbound(phoneOf(4), 'are you there?');
    stub.script = [{ reply: 'Yes, I am here.' }];
    await run();
    conv = await convAt(phoneOf(4));
    check('no button needed: the person writes again and the AI answers by itself', conv.state === 'active' && (await aiMsgs(d.id)).length === 2 && conv.handoffReason === null, conv);

    // ---- 5. STOP
    console.log('\n-- stop');
    const e = await mkCandidate(5, 'Esha');
    await promote(e, 5);
    await inbound(phoneOf(5), 'STOP');
    stub.calls.length = 0;
    await run();
    conv = await convAt(phoneOf(5));
    const supp = await S.q('SELECT 1 AS x FROM "OutreachSuppression" WHERE addressHash = ?', S.hashAddress('phone', `+${phoneOf(5)}`));
    check('STOP: blocked at once on every list, no AI, no reply', conv.state === 'stopped' && stub.calls.length === 0 && (await aiMsgs(e.id)).length === 0 && await delivery.optedOut('WhatsApp', phoneOf(5)) && supp.length === 1, [conv.state, supp.length]);
    const tried = await Agent.sendText(conv, 'hello');
    check('nothing can be sent to that number afterwards', tried.ok === false && tried.code === 'OPTED_OUT');
    await inbound(phoneOf(5), 'ఆపండి');
    check('a Telugu stop word counts too', G.isStop('ఆపండి') && G.isStop('please unsubscribe') === false ? true : G.isStop('ఆపండి'));

    const free = await Agent.unblock(phoneOf(5), admin, 'ZZTEST asked to hear from us again');
    const stateAfter = await Agent.blockState(phoneOf(5));
    await promote(e, 5, `zzback${SUFFIX}`);
    conv = await convAt(phoneOf(5));
    await inbound(phoneOf(5), 'I am interested again');
    stub.script = [{ reply: 'Welcome back.' }];
    await run();
    check('an Admin can unblock with a reason: off every list, and the AI answers again', free.ok && stateAfter.blocked === false && !(await delivery.optedOut('WhatsApp', phoneOf(5))) && conv.state === 'active' && (await aiMsgs(e.id)).length === 1, [free, stateAfter, conv.state]);
    check('no reason, no unblock', (await Agent.unblock(phoneOf(5), admin, 'x')).status === 400);

    // ---- 6. leads
    console.log('\n-- a number we do not know');
    const unknown = phoneOf(77);
    await inbound(unknown, 'Do you have jobs?', 'ZZTEST New Person');
    stub.calls.length = 0;
    await run();
    conv = await convAt(unknown);
    const contact = conv && conv.leadContactId ? (await S.q('SELECT contactType FROM "OutreachContact" WHERE id = ?', conv.leadContactId))[0] : null;
    check('an unknown number becomes a Lead and the AI answers them, TeamLink\'s own words first', conv && conv.personType === 'LEAD' && conv.state === 'active' && stub.calls.length === 0 && !!conv.lastAiAt && contact && contact.contactType === 'candidate_lead', conv);
    const hiNo = phoneOf(96);
    await inbound(hiNo, 'Hiii', 'ZZTEST Hello Person');
    stub.calls.length = 0;
    await run();
    const hiConv = await convAt(hiNo);
    const hiMsgs = await Inbox.leadMessages(hiConv.id);
    check('hi from anybody: answered at once, the model is not asked', stub.calls.length === 0 && /looking for a job/.test(hiMsgs[hiMsgs.length - 1].text), hiMsgs);
    const Tg = require(path.join(BACK, 'src/omniwa/tools'));
    check('a stretched yes or no is still a yes or no; a sentence is not', ['yesssssssssss', 'Yes', 'yess sir', 'okkk', 'yaa', 'Interested'].every(Tg.isYes) && ['noooo', 'No', 'vaddu'].every(Tg.isNo) && !['yes but salary?', 'yesterday', 'not now', 'nothing'].some((x) => Tg.isYes(x) || Tg.isNo(x)));
    check('bye and thanks close a talk, a yes does not', ['bye', 'Byeee', 'thank you', 'ok thanks', 'thanks sir'].every(Tg.isClosing) && !['yes', 'Yes please', 'hi'].some(Tg.isClosing));
    check('an answer must fit its question', !Tg.answerFits('If working, which company are you currently working with?', 'yes')
      && Tg.answerFits('If working, which company are you currently working with?', 'Apollo Hospitals')
      && !Tg.answerFits('What is your total work experience?', 'yes') && Tg.answerFits('What is your total work experience?', '3 years') && Tg.answerFits('What is your total work experience?', 'fresher')
      && !Tg.answerFits('Which date and time would be convenient for you?', 'yes') && Tg.answerFits('Which date and time would be convenient for you?', 'tomorrow 11 am')
      && !Tg.answerFits('Have you already applied for this position, or are you exploring new opportunities?', 'yes') && Tg.answerFits('Have you already applied for this position, or are you exploring new opportunities?', 'exploring')
      && Tg.answerFits('Are you comfortable with the job shift and working hours?', 'yes') && Tg.answerFits('Are you currently working or not working?', 'no'));
    check('a working person is not told "answer in numbers" again and again: "already in job" gets a follow-up about changing jobs and the notice period',
      ['already im in job', 'im already doing job', 'I am currently working', 'i have a job'].every((x) => Tg.employedStatement(x) && !Tg.answerFits('If selected, how soon can you join?', x))
      && !Tg.employedStatement('I have been working for 3 years') && !Tg.employedStatement('30 days') && !Tg.employedStatement('yes')
      && /Are you looking to change your job/.test(Tg.employedFollowUp('If selected, how soon can you join?')) && /notice period/.test(Tg.employedFollowUp('What is your current notice period?'))
      && /how soon you can join/.test(Tg.employedYesText('If selected, how soon can you join?')) && Tg.questionKind('If selected, how soon can you join?') === 'number');
    check('"not looking" answers a joining or notice question; real answers and a bare yes behave as before',
      ['not looking', 'Not interested in change', 'no plan to change'].every((x) => Tg.notLooking(x) && Tg.answerFits('If selected, how soon can you join?', x))
      && Tg.answerFits('If selected, how soon can you join?', '30 days') && Tg.answerFits('What is your current notice period?', 'immediate') && !Tg.answerFits('If selected, how soon can you join?', 'yes'));
    check('a question is known without a "?"; an answer is not a question', Tg.isQuestion('what is the job role') && Tg.isQuestion('salary entha') && Tg.isQuestion('Is it full time?') && !Tg.isQuestion('exploring')
      && !Tg.isQuestion('Not working') && !Tg.isQuestion('3 years') && !Tg.isQuestion('Apollo Hospitals') && Tg.aboutThisJob('what is the job role') && !Tg.aboutThisJob('any nursing jobs'));
    check('joining time: days, weeks, months and immediate are read; later than the job is a gap', Tg.daysOf('30 days') === 30 && Tg.daysOf('2 weeks') === 14 && Tg.daysOf('1 month') === 30 && Tg.daysOf('immediate') === 0 && Tg.daysOf('Within 15 Days') === 15
      && !!Tg.joiningGap({ joining: 'Within 15 Days' }, '30 days') && !Tg.joiningGap({ joining: 'Within 15 Days' }, '10 days') && !Tg.joiningGap({ joining: '' }, '30 days'));
    check('a greeting is a greeting, a sentence is not', ['hi', 'Hii', 'HELLO', 'hi sir', 'Good morning', 'hey!'].every(Tg.isGreeting) && !['hi i need a job', 'high salary', 'hello any vacancy?'].some(Tg.isGreeting));
    await Cfg.save(admin, { testNumbers: ['919000000001'] });
    check('with only test numbers on, the bots keep the other chats', (await Agent.ownsChat({ e164: phoneOf(95) })) === false && (await Agent.ownsChat({ e164: '919000000001' })) === true);
    await Cfg.save(admin, { testNumbers: [] });
    const aList = await Inbox.list(adminMe, {});
    check('Admin sees the lead in the list', aList.rows.some((r) => r.personType === 'LEAD' && r.personId === conv.id));
    if (other) {
      const oList = await Inbox.list(other, {});
      const refused = await Inbox.detail(other, `LEAD:${conv.id}`);
      check('a recruiter who does not own it does not', !oList.rows.some((r) => r.personId === conv.id) && refused.status === 403, refused);
    }
    const leadSend = await Agent.sendText(conv, 'Hello, tell me your skills.', { user: admin, ai: false });
    const leadMsgs = await Inbox.leadMessages(conv.id);
    check('a person can answer a lead inside 24 hours and the chat keeps both messages', leadSend.ok && leadMsgs.length === 3 && leadMsgs[2].by === admin.name, leadSend);

    // ---- 6a. the first live test: no job in the chat
    console.log('\n-- no job in the chat');
    check('with no job, words about what is open or filled are stopped; a plain question passes', !!G.jobClaim('We have a few staff nurse positions available, but they are currently filled.') && !!G.jobClaim("Sorry, we couldn't find any job openings.") && G.jobClaim('Which city do you want to work in?') === null);
    const noJobNo = phoneOf(79);
    await inbound(noJobNo, 'Can you help me please', 'ZZTEST No Job');
    await S.run('UPDATE "OmniWaConv" SET aiStartedAt = ?, state = \'active\', handoffReason = NULL, pendingAt = ? WHERE e164 = ?', Date.now(), Date.now() - 60000, noJobNo);
    await S.run('UPDATE "OmniWaMessage" SET consumedAt = NULL WHERE e164 = ?', noJobNo);
    stub.script = [{ reply: 'The staff nurse positions are currently filled.' }];
    stub.calls.length = 0;
    await run();
    conv = await convAt(noJobNo);
    const sysNoJob = stub.calls[0] ? stub.calls[0].messages[0].content : '';
    const leadOut = await Inbox.leadMessages(conv.id);
    check('the model is told there is no job and who it talks to; the invented line never leaves, a recruiter takes over', /NO JOB is linked/.test(sysNoJob) && /not you/.test(sysNoJob) && conv.state === 'needs_human' && !leadOut.some((m) => /filled/.test(m.text)), [conv.state, leadOut]);

    // ---- 6a2. open job search
    console.log('\n-- open jobs');
    await prisma.requirement.update({ where: { id: job.id }, data: { portalPublished: true } });
    await S.run('UPDATE "OmniWaConv" SET aiStartedAt = ? WHERE e164 = ?', Date.now(), phoneOf(80)).catch(() => {});
    const seekNo = phoneOf(80);
    await inbound(seekNo, 'hi', 'ZZTEST Job Seeker');
    await S.run('UPDATE "OmniWaConv" SET aiStartedAt = ?, state = \'active\', handoffReason = NULL WHERE e164 = ?', Date.now(), seekNo);
    await inbound(seekNo, 'I am looking for physics lecturer position');
    stub.script = [];
    stub.calls.length = 0;
    await run();
    conv = await convAt(seekNo);
    let seekMsgs = await Inbox.leadMessages(conv.id);
    const listText = seekMsgs[seekMsgs.length - 1].text;
    check('they ask for a job: TeamLink writes the list from the database, the model is not asked, no client name', stub.calls.length === 0 && /These jobs are open now/.test(listText) && /1\. .*Physics Lecturer/.test(listText) && !listText.includes(client.name) && conv.state === 'active', [conv.state, listText]);
    await inbound(seekNo, '1.physics');
    stub.calls.length = 0;
    await run();
    conv = await convAt(seekNo);
    seekMsgs = await Inbox.leadMessages(conv.id);
    const card = seekMsgs[seekMsgs.length - 1].text;
    check('they pick it: the chat is tied to that job and TeamLink sends its details from the ATS, no client name', conv.requirementId === job.id && stub.calls.length === 0 && /Physics Lecturer/.test(card) && /Location: Hyderabad/.test(card) && /Salary: 8 LPA/.test(card) && /Do you want to apply/.test(card) && !card.includes(client.name), card);
    await inbound(seekNo, 'what is the salary?');
    await run();
    seekMsgs = await Inbox.leadMessages(conv.id);
    check('a question about the job is answered from the ATS, the model is not asked', stub.calls.length === 0 && seekMsgs[seekMsgs.length - 1].text === 'The salary: 8 LPA.', seekMsgs.slice(-1));
    await inbound(seekNo, 'do you need a passport');
    stub.script = [{ reply: 'Please ask our recruiter about that.' }];
    await run();
    await inbound(seekNo, 'I want to apply');
    await run();
    conv = await convAt(seekNo);
    seekMsgs = await Inbox.leadMessages(conv.id);
    check('apply: the real link goes, and they are marked interested', LINK.test(seekMsgs[seekMsgs.length - 1].text) && JSON.parse(conv.collected).interested === true, seekMsgs.slice(-1));
    const T = require(path.join(BACK, 'src/omniwa/tools'));
    const bare = { title: 'Nursing', openings: 1 };
    check('a detail the ATS does not have is said plainly, never guessed', T.quickAnswer(bare, 'salary entha').missing === 'salary' && T.quickAnswer(bare, 'hello') === null && T.quickAnswer(bare, 'yes', { justShown: true }).apply === true && T.quickAnswer(bare, 'yes') === null);
    await inbound(seekNo, 'is there any vaccancy for astronaut job');
    stub.calls.length = 0;
    await run();
    seekMsgs = await Inbox.leadMessages(conv.id);
    check('a chat on one job asking for another: the search answers, not the model', stub.calls.length === 0 && /could not find an open job/.test(seekMsgs[seekMsgs.length - 1].text), seekMsgs.slice(-1));
    check('the guard stops a job the model made up, and lets it speak of its own job', !!G.jobClaim('We have a vacancy for a Senior HR Recruiter.', 'Physics Lecturer') && G.jobClaim('The Physics Lecturer position is open.', 'Physics Lecturer') === null);
    const T2 = require(path.join(BACK, 'src/omniwa/tools'));
    check('"nurseing" finds "Nursing"', T2.titleHas('Nursing', 'staff nurseing job'));
    const eduJob = await prisma.requirement.create({ data: { title: 'ZZTEST Faculty requirement', clientId: client.id, status: 'OPEN', department: 'ZZEducation', location: 'Warangal', experience: '1-3 years', description: 'ZZTEST faculty for an engineering college in Warangal, teaching degree students, full time.' } });
    const T3 = require(path.join(BACK, 'src/omniwa/tools'));
    const byDept = await T3.searchJobs('is there any job vaccncies rewlated to zzeducation');
    check('the founder words find the department jobs, though the title says Faculty', byDept.jobs.some((j) => /Faculty requirement/.test(j.title)), byDept);
    const byCity = await T3.searchJobs('faculty job in warangal');
    check('a place counts too, and the best fit comes first', /ZZTEST Faculty/.test((byCity.jobs[0] || {}).title || ''), byCity);
    const anyJob = await T3.searchJobs('any jobs?', { department: 'ZZEducation' });
    check('"any jobs?" on a number of one department lists that department; "Yes" lists nothing', anyJob.jobs.length === 1 && (await T3.searchJobs('Yes', { department: 'ZZEducation' })).searched === false, anyJob);
    await prisma.requirement.delete({ where: { id: eduJob.id } });
    const liveJob = await prisma.requirement.create({ data: { title: 'ZZTEST Zzstaff Nurses', clientId: client.id, status: 'RECRUITER_ASSIGNED', department: 'Medical', description: 'ZZTEST staff nurses for a hospital in Hyderabad, day and night shifts, full time.' } });
    const assigned = await T3.searchJobs('any vacancy for zzstaff nurse');
    check('a job with a recruiter on it is still open and is found', assigned.jobs.some((j) => /Zzstaff/.test(j.title)), assigned);
    await prisma.requirement.delete({ where: { id: liveJob.id } });
    const none = await require(path.join(BACK, 'src/omniwa/tools')).searchJobs('zzqqxx astronaut');
    const empty = await require(path.join(BACK, 'src/omniwa/tools')).searchJobs('I am looking for a job');
    check('nothing matches: an honest empty list; only "a job" with no kind: no search', none.searched === true && none.jobs.length === 0 && empty.searched === false);

    // ---- 5b. a new template replaces the old job (founder 2026-11-09: MBBS template, reply about a Java job)
    const mb = await mkCandidate(93, 'Meghana');
    await promote(mb, 93, `zzjava${SUFFIX}`, true);
    await inbound(phoneOf(93), 'YES');
    await run();
    await Promo.logBulk({ id: `zzmbbs${SUFFIX}`, kind: 'individual', audience: 'candidates', purpose: 'MBBS doctors needed', requirementId: null, templates: { WhatsApp: { name: 'mbbs_openings' } }, sender: {} },
      [{ channel: 'WhatsApp', status: 'sent', address: `+${phoneOf(93)}`, text: 'ZZTEST MBBS openings', entityId: mb.id, providerRef: `zzmb${SUFFIX}`, sentAt: new Date(Date.now() + 1000) }]);
    await inbound(phoneOf(93), 'Yes');
    await run();
    const mbConv = await convAt(phoneOf(93));
    const mbLast = (await aiMsgs(mb.id)).pop();
    check('a template sent to one candidate is the new promotion: the old job is not named any more', !mbConv.requirementId && /zzmbbs/.test(String(mbConv.campaignId)) && !new RegExp(job.title).test(mbLast.body), [mbConv.requirementId, mbConv.campaignId, mbLast.body]);

    // ---- 5c. "can we talk on call": OK, I will connect you soon, and the number our template gave (founder 2026-11-09)
    const cl = await mkCandidate(92, 'Chaitanya');
    await Promo.logBulk({ id: `zzcall${SUFFIX}`, kind: 'bulk', audience: 'candidates', purpose: 'ZZTEST call', requirementId: null, templates: { WhatsApp: { name: 'mbbs_openings' } }, sender: {} },
      [{ channel: 'WhatsApp', status: 'sent', address: `+${phoneOf(92)}`, text: 'ZZTEST Interview this week. Contact: +91 90323 21414', entityId: cl.id, providerRef: `zzcl${SUFFIX}`, sentAt: new Date() }]);
    await inbound(phoneOf(92), 'Can we talk on call?');
    stub.calls.length = 0;
    await run();
    const clLast = (await aiMsgs(cl.id)).pop();
    const clConv = await convAt(phoneOf(92));
    check('a call request: "I will connect you soon" with the number from our template, a recruiter is told, the model is not asked', /connect you soon/.test(clLast.body) && /90323 21414/.test(clLast.body) && clConv.handoffReason === 'They asked for a call' && stub.calls.length === 0, [clLast.body, clConv.handoffReason]);
    const Gd = require(path.join(BACK, 'src/omniwa/guard'));
    check('call words: English and Telugu-English; an ordinary sentence is not one', ['call me', 'please call', 'connect on call', 'call cheyandi', 'can we talk', 'phone cheyandi'].every(Gd.wantsCall) && !['I called yesterday', 'what is the salary', 'yes'].some(Gd.wantsCall));

    // ---- 5d. the apply link follows the template we sent (founder 2026-11-09)
    const Tl = require(path.join(BACK, 'src/omniwa/tools'));
    const linkFor = async (n, text, requirementId, campaign) => {
      const c = await mkCandidate(n, `ZZ Apply ${n}`);
      await Promo.logBulk({ id: campaign, kind: 'bulk', audience: 'candidates', purpose: 'ZZTEST apply', requirementId, templates: { WhatsApp: { name: 'zz_apply' } }, sender: {} },
        [{ channel: 'WhatsApp', status: 'sent', address: `+${phoneOf(n)}`, text, entityId: c.id, providerRef: `zzap${n}${SUFFIX}`, sentAt: new Date() }]);
      const ctx = { links: [] };
      const out = await Tl.run('send_apply_link', {}, { id: `zzconv${n}`, e164: phoneOf(n), candidateId: c.id, campaignId: campaign, requirementId, collected: '{}' }, ctx);
      return { out, ctx };
    };
    await prisma.requirement.update({ where: { id: job.id }, data: { portalPublished: true } });
    const viaPortal = await linkFor(60, 'ZZTEST Physics lecturer needed. Contact 90323 21414', job.id, `zzapA${SUFFIX}`);
    check('a job on our Job Portal: its page, with registration first for someone without a login', viaPortal.out.how === 'portal' && viaPortal.ctx.links.length === 1 && LINK.test(viaPortal.ctx.links[0]) && /tl_apply=1/.test(viaPortal.ctx.links[0]), viaPortal);
    const viaClient = await linkFor(61, 'ZZTEST MBBS doctors needed. Apply: https://careers.zzclient.example/jobs/mbbs-42. Contact 90323 21414', null, `zzapB${SUFFIX}`);
    check("the client's own link in our template: that job's link goes", viaClient.out.how === 'client' && viaClient.ctx.links[0] === 'https://careers.zzclient.example/jobs/mbbs-42', viaClient);
    const viaNumber = await linkFor(62, 'ZZTEST Nurses needed in Hyderabad. Contact +91 90323 21414', null, `zzapC${SUFFIX}`);
    check('no job link: "apply through this number" with the template\'s number, and our Job Portal registration; a recruiter is told', viaNumber.out.how === 'number' && /90323 21414/.test(viaNumber.ctx.links[0]) && /#\/register\/candidate$/.test(viaNumber.ctx.links[1]) && /not on the Job Portal/.test(viaNumber.ctx.handoff || '')
      && /apply through this number/.test(Tl.applyWords(viaNumber.out, 'x')) && Tl.applyWords(viaPortal.out, 'Please apply here:') === 'Please apply here:', viaNumber);
    check('a WhatsApp or map link in a template is not a job link', Tl.templateLink(['Chat https://wa.me/919000000000 map https://maps.google.com/x']) === null);

    // ---- 6a. an employee's number is answered too (founder 2026-11-09)
    const empNo = phoneOf(94);
    await Agent.onInbound({ channel: 'WhatsApp', from: empNo, text: 'hi', id: `wamid.ZZemp${SUFFIX}`, at: new Date(), name: 'ZZTEST Staff' }, { stored: true, personType: 'EMPLOYEE', personId: 'zz-emp' });
    stub.calls.length = 0;
    await run();
    const empConv = await convAt(empNo);
    const empMsgs = empConv ? await Inbox.leadMessages(empConv.id) : [];
    check('an employee who writes gets an answer too, and no CRM lead is made for them', !!empConv && !empConv.leadContactId && /looking for a job/.test((empMsgs[empMsgs.length - 1] || {}).text || ''), [empConv, empMsgs.slice(-1)]);

    // ---- 6b. one number on a candidate and an employee
    console.log('\n-- a number shared with an employee');
    const s1 = await mkCandidate(20, 'Sravya');
    await promote(s1, 20);
    await Agent.onInbound({ channel: 'WhatsApp', from: phoneOf(20), text: 'Yes I am interested', id: `wamid.ZZs${SUFFIX}`, at: new Date() }, { review: true, reason: 'ambiguous', possible: [{ type: 'CANDIDATE', id: s1.id }, { type: 'EMPLOYEE', id: 'e1' }] });
    stub.script = [{ reply: 'Glad to hear it.' }];
    stub.calls.length = 0;
    await run();
    const sentS = stub.calls[0] ? JSON.stringify(stub.calls[0].messages.slice(1)) : '';
    check('one candidate + an employee on a number: the AI answers as that candidate and sees the message', (await aiMsgs(s1.id)).length === 1 && sentS.includes('Yes I am interested'), sentS.slice(0, 200));
    await Agent.onInbound({ channel: 'WhatsApp', from: phoneOf(21), text: 'Yes', id: `wamid.ZZt${SUFFIX}`, at: new Date() }, { review: true, reason: 'ambiguous', possible: [{ type: 'CANDIDATE', id: 'a' }, { type: 'CANDIDATE', id: 'b' }] });
    const twoConv = await convAt(phoneOf(21));
    check('two candidates on a number: answered, but on neither record (the AI does not guess whose) and no CRM lead', !!twoConv && !twoConv.candidateId && !twoConv.leadContactId, twoConv);

    // ---- 7. human takeover
    console.log('\n-- a person takes over');
    const f = await mkCandidate(6, 'Farah');
    await promote(f, 6);
    await inbound(phoneOf(6), 'Hi');
    stub.script = [{ reply: 'Hello.' }];
    await run();
    await Agent.noteHumanSend('CANDIDATE', f.id, 'ZZTEST Recruiter');
    conv = await convAt(phoneOf(6));
    await inbound(phoneOf(6), 'one more thing');
    stub.calls.length = 0;
    await run();
    check('a recruiter\'s message pauses the AI at once', conv.mode === 'paused' && conv.pausedByName === 'ZZTEST Recruiter' && stub.calls.length === 0);
    await Agent.resume(await convAt(phoneOf(6)));
    await prisma.candidateMessage.create({ data: { candidateId: f.id, channel: 'WhatsApp', template: 'MANUAL', trigger: 'Manual', recipient: `+${phoneOf(6)}`, body: 'ZZTEST from another screen', status: 'SENT', senderUserId: admin.id, senderName: admin.name, createdAt: new Date(Date.now() + 2000) } });
    await inbound(phoneOf(6), 'hello again');
    stub.calls.length = 0;
    await run();
    conv = await convAt(phoneOf(6));
    check('a message sent from any other screen pauses it too, before the next answer', conv.mode === 'paused' && stub.calls.length === 0, conv);
    // a template sent to one candidate (Send Message) is a promotion, not someone answering
    const kiran = await mkCandidate(97, 'Kiran');
    await inbound(phoneOf(97), 'Hi');
    await run();
    await prisma.candidateMessage.create({ data: { candidateId: kiran.id, channel: 'WhatsApp', template: 'MANUAL', templateLabel: 'Interview invitation', trigger: 'Manual', recipient: `+${phoneOf(97)}`, body: 'ZZTEST template to one', status: 'SENT', senderUserId: admin.id, senderName: 'Developer Team', createdAt: new Date(Date.now() + 1000) } });
    await inbound(phoneOf(97), 'Yes');
    stub.calls.length = 0;
    await run();
    let kConv = await convAt(phoneOf(97));
    check('a template sent to one candidate does not stop the AI', kConv.mode === 'ai' && !!kConv.lastAiAt, kConv);
    await prisma.candidateMessage.create({ data: { candidateId: kiran.id, channel: 'WhatsApp', template: 'INTERVIEW_SCHEDULED', templateLabel: 'Interview scheduled', trigger: 'Stage', recipient: `+${phoneOf(97)}`, body: 'ZZTEST stage message', status: 'SENT', senderUserId: admin.id, senderName: 'Developer Team', createdAt: new Date(Date.now() + 1500) } });
    await inbound(phoneOf(97), 'ok');
    await run();
    check('an automatic stage message does not stop the AI either', (await convAt(phoneOf(97))).mode === 'ai');
    // a chat the old, wider rule paused comes back to the AI with the next message
    await S.run('UPDATE "OmniWaConv" SET mode = \'paused\', pausedByName = \'Developer Team\' WHERE id = ?', kConv.id);
    await S.run('INSERT INTO "OmniWaAiRun" (id, convId, e164, input, outcome, output, at) VALUES (?,?,?,?,?,?,?)', `war-zz${SUFFIX}`, kConv.id, kConv.e164, 'Yes', 'paused', 'Developer Team is answering this chat.', Date.now() + 2000);
    await inbound(phoneOf(97), 'hello');
    await run();
    kConv = await convAt(phoneOf(97));
    check('a chat paused by a template send takes the AI back with the next message', kConv.mode === 'ai', kConv);

    // ---- 8. limits and settings
    console.log('\n-- limits');
    const g = await mkCandidate(7, 'Gita');
    await promote(g, 7);
    await Cfg.save(admin, { maxTurns: 1 });
    await inbound(phoneOf(7), 'Hi');
    stub.script = [{ reply: 'Hello.' }];
    await run();
    await inbound(phoneOf(7), 'And then?');
    stub.calls.length = 0;
    await run();
    conv = await convAt(phoneOf(7));
    check('after the most AI replies a person takes over', conv.state === 'needs_human' && stub.calls.length === 0 && /limit/.test(conv.handoffReason));
    await Cfg.save(admin, { maxTurns: 12, testNumbers: [phoneOf(9)] });
    const h = await mkCandidate(8, 'Hari');
    await promote(h, 8);
    await inbound(phoneOf(8), 'Hi');
    stub.calls.length = 0;
    await run();
    check('with test numbers only those numbers are answered', stub.calls.length === 0 && (await aiMsgs(h.id)).length === 0);
    await Cfg.save(admin, { testNumbers: [] });
    check('working hours: inside and outside (India time), over midnight too', G.insideHours({ hoursOn: true, hoursFrom: '09:00', hoursTo: '18:00' }, Date.UTC(2026, 10, 5, 6, 0)) === true && G.insideHours({ hoursOn: true, hoursFrom: '09:00', hoursTo: '18:00' }, Date.UTC(2026, 10, 5, 15, 0)) === false && G.insideHours({ hoursOn: true, hoursFrom: '22:00', hoursTo: '06:00' }, Date.UTC(2026, 10, 5, 18, 0)) === true);

    // ---- 8b. a campaign sent inside Omni-Channel (Green Start): not in TeamLink's log, the replies come here
    console.log('\n-- a campaign sent from Green Start');
    const gsSeen = [];
    const gs = { found: null, broken: false };
    const gsThread = [];
    const gsPosts = [];
    const gsServer = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          const has = req.headers['x-workspace-id'] === 'ws2';
          gsPosts.push(req.headers['x-workspace-id']);
          if (has) gsThread.push({ url: req.url, body: JSON.parse(raw) });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { stored: has } }));
        });
        return undefined;
      }
      if (req.url.startsWith('/api/v1/conversations?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const items = req.headers['x-workspace-id'] === 'ws2' ? [{ lastMessageAt: new Date().toISOString() }] : req.headers['x-workspace-id'] === 'ws1' ? [{ lastMessageAt: new Date(Date.now() - 86400000).toISOString() }] : [];
        return res.end(JSON.stringify({ success: true, data: { items } }));
      }
      gsSeen.push({ url: req.url, ws: req.headers['x-workspace-id'], auth: req.headers.authorization });
      res.writeHead(gs.broken ? 500 : 200, { 'Content-Type': 'application/json' });
      if (gs.broken) return res.end('{"message":"down"}');
      const hit = req.headers['x-workspace-id'] === 'ws2' && gs.found;
      return res.end(JSON.stringify({ success: true, data: hit ? { found: true, campaignId: 'c9', campaignName: 'ZZTEST Nurses', sentAt: new Date().toISOString() } : { found: false } }));
    });
    await new Promise((r) => { gsServer.listen(0, '127.0.0.1', r); });
    process.env.GREENSTART_API_PORT = String(gsServer.address().port);
    const GI = require(path.join(BACK, 'src/utils/greenStartIntegrations'));
    const GC = require(path.join(BACK, 'src/omniwa/gsCampaign'));
    GI.signIn = async () => ({ token: 'zz-gs-token' });
    GI.workspacesOf = async () => [{ id: 'ws1', name: 'Medical' }, { id: 'ws2', name: 'Education' }];
    GC.reset();
    const i = await mkCandidate(10, 'Indu');
    await inbound(phoneOf(10), 'Hi');
    stub.calls.length = 0;
    await run();
    check('a candidate no campaign reached: Green Start is asked (every workspace, this number), and they get the hello', gsSeen.length === 2 && gsSeen.every((x) => x.url.includes(`phone=${phoneOf(10)}`) && x.auth === 'Bearer zz-gs-token') && stub.calls.length === 0 && /looking for a job/.test((await aiMsgs(i.id))[0].body), gsSeen);
    gs.found = true;
    await inbound(phoneOf(10), 'sounds good to me');
    stub.script = [{ reply: 'Thank you, let me help.' }];
    await run();
    conv = await convAt(phoneOf(10));
    check('reply to a Green Start campaign: the AI answers, and the chat shows that campaign', (await aiMsgs(i.id)).length === 2 && conv.campaignName === 'ZZTEST Nurses' && conv.campaignId === 'gs:c9' && !!conv.aiStartedAt, conv);
    await new Promise((r) => { setTimeout(r, 400); });
    const mirrored = gsThread.find((x) => x.body.text === 'Thank you, let me help.');
    check('the AI reply is shown in the Green Start thread too: same words and Meta id, in the workspace that has the thread, nothing sent again', !!mirrored && mirrored.url === '/api/v1/conversations/import-outbound' && mirrored.body.phone === phoneOf(10) && !!mirrored.body.providerMessageId, gsThread);
    gsSeen.length = 0;
    await inbound(phoneOf(10), 'one more');
    stub.script = [{ reply: 'Okay.' }];
    await run();
    check('a running chat on the same campaign carries on (a new campaign would change it)', (await aiMsgs(i.id)).length === 3 && (await convAt(phoneOf(10))).campaignId === 'gs:c9');
    // one number, one workspace: an old thread in another workspace never takes the chat (founder 2026-11-06)
    const mapBefore = GI.readWaMap;
    GI.readWaMap = async () => ({ 'zz-edu2': { workspaceId: 'ws2' }, 'zz-med': { workspaceId: 'ws1' } });
    gsPosts.length = 0;
    await GC.mirror(phoneOf(10), 'ZZTEST from Education 2', 'zz-ref-1', 'zz-edu2');
    check('the AI reply goes only to the workspace of the number they wrote to', gsPosts.length >= 1 && gsPosts.every((w) => w === 'ws2'), gsPosts); // a retry of an earlier reply may land here too: still ws2 only
    gsPosts.length = 0;
    await GC.mirror(phoneOf(10), 'ZZTEST number not in the map', 'zz-ref-2', 'zz-not-mapped');
    check('a number the map does not name: the reply goes to the workspace where their message just landed, nowhere else', gsPosts.length === 1 && gsPosts[0] === 'ws2', gsPosts);
    gsSeen.length = 0;
    const edu = await GC.recentSend(phoneOf(10), 7, 'zz-edu2');
    const med = await GC.recentSend(phoneOf(10), 7, 'zz-med');
    check('a campaign counts only in the workspace of that number', !!edu && edu.campaignId === 'gs:c9' && med === null && gsSeen.map((x) => x.ws).join() === 'ws2,ws1', gsSeen.map((x) => x.ws));
    await S.run('UPDATE "OmniWaConv" SET numberId = ? WHERE e164 = ?', 'zz-med', phoneOf(10));
    await Agent.onInbound({ from: phoneOf(10), text: 'hello other number', id: `wamid.ZZ${SUFFIX}move`, at: new Date(), numberId: 'zz-edu2' }, { candidateId: i.id });
    const moved = await convAt(phoneOf(10));
    check('writing to another company number: the last promotion stays behind', moved.numberId === 'zz-edu2' && !moved.campaignId && !moved.promoAt, [moved.numberId, moved.campaignId]);
    await S.run('UPDATE "OmniWaConv" SET pendingAt = NULL WHERE e164 = ?', phoneOf(10));
    GI.readWaMap = mapBefore;
    const leadNo = phoneOf(78);
    await inbound(leadNo, 'Tell me more', 'ZZTEST Campaign Lead');
    stub.script = [{ reply: 'Sure, what would you like to know?' }];
    await run();
    conv = await convAt(leadNo);
    check('a number with no candidate that answered a Green Start campaign is a Lead AND gets the AI', conv.personType === 'LEAD' && conv.state === 'active' && !!conv.aiStartedAt, conv);
    gs.found = false; gs.broken = true;
    GC.reset();
    const j = await mkCandidate(11, 'Jaya');
    await inbound(phoneOf(11), 'Hi');
    stub.calls.length = 0;
    await run();
    check('Green Start not answering: nothing breaks, they get the hello, the model is not asked', stub.calls.length === 0 && (await aiMsgs(j.id)).length === 1);
    gsServer.close();

    // ---- 8b1. YES to a promotion: the details are asked in order
    console.log('\n-- YES: the details');
    const q = await mkCandidate(41, 'Queen');
    await promote(q, 41, undefined, true);
    await inbound(phoneOf(41), 'YES');
    stub.calls.length = 0;
    await run();
    await inbound(phoneOf(41), 'YES');
    await run();
    let qSent = await aiMsgs(q.id);
    check('YES: thanks and the first question of the list, the model is not asked', stub.calls.length === 0 && /looking for a job change/.test(qSent[qSent.length - 1].body), qSent.map((x) => x.body));
    const say = async (t) => { await inbound(phoneOf(41), t); await run(); };
    await say('job change');
    qSent = await aiMsgs(q.id);
    check('an answer with job words in it is an answer, not a search', /applied|interested/i.test(qSent[qSent.length - 1].body) && !/could not find/.test(qSent[qSent.length - 1].body), qSent.slice(-1).map((x) => x.body));
    await say('Yes interested');
    await say('exploring');
    await say('Not working');
    qSent = await aiMsgs(q.id);
    check('someone not working is not asked which company', !qSent.some((m) => /which company/i.test(m.body) || /designation/.test(m.body)) && /total work experience/.test(qSent[qSent.length - 1].body), qSent.slice(-1).map((x) => x.body));
    // founder 2026-11-09: "what is the job role" inside the questions was saved as the answer and the next question came
    const atBefore = JSON.parse((await convAt(phoneOf(41))).collected).intakeAt;
    await say('what is the job role');
    qSent = await aiMsgs(q.id);
    const midAsk = JSON.parse((await convAt(phoneOf(41))).collected);
    const lastQ = qSent[qSent.length - 1].body;
    check('a question inside the questions, with no "?": answered from the ATS, then the same question again, and it is not saved as an answer', /The job role: ZZTEST Physics Lecturer/.test(lastQ) && /Now my question again: .*total work experience/i.test(lastQ)
      && midAsk.intakeAt === atBefore && !Object.values(midAsk.answers || {}).some((v) => /job role/i.test(String(v))), [lastQ, atBefore, midAsk.intakeAt]);
    for (const t of ['yes', 'yes', 'yes']) await say(t);
    qSent = await aiMsgs(q.id);
    check('"yes" to the experience question, again and again: the same question again, with a plain request', qSent.slice(-3).every((m) => /correct answer/.test(m.body) && /total work experience/.test(m.body)), qSent.slice(-3).map((x) => x.body));
    await say('3 years');
    await say('2 years');
    qSent = await aiMsgs(q.id);
    check('a line with a value the requirement has shows it from the ATS', /Hyderabad/.test(qSent[qSent.length - 1].body), qSent.slice(-1).map((x) => x.body));
    // joining: the job needs 15 days, they say 30, the AI asks them nicely to manage 15, they agree
    for (const a of ['yes', 'yes', 'yes', 'yes', '30 days']) await say(a);
    qSent = await aiMsgs(q.id);
    check('joining later than the job: the AI explains it helps their chance and asks for the time the job needs, it does not just hand over', /needs joining within 15 days/.test(qSent[qSent.length - 1].body) && /better chance/.test(qSent[qSent.length - 1].body), qSent.slice(-1).map((x) => x.body));
    for (const a of ['yes', '30 days', 'yes', 'tomorrow 10 am', 'yes', 'no']) await say(a);
    conv = await convAt(phoneOf(41));
    const got = JSON.parse(conv.collected);
    qSent = await aiMsgs(q.id);
    check('each answer is kept under its question, the closing message goes, a recruiter is told', got.answers['What is your current notice period?'] === '30 days' && got.notice_period === '30 days' && got.experience === '3 years' && conv.state === 'needs_human' && /Thank you for your time/.test(qSent[qSent.length - 1].body), [Object.keys(got.answers).length, conv.state, qSent.slice(-1).map((x) => x.body)]);
    check('questions from TeamLink do not use up the AI replies', Number(conv.aiTurns) === 0, conv.aiTurns);

    // ---- 8b2. a promotion with no job linked (no REQ code in the campaign name): the answers come from our own message, never made up
    console.log('\n-- no job linked: answers from our message');
    const nj = await prisma.candidate.create({ data: { name: 'ZZTEST Nojob', phone: `+${phoneOf(43)}` } });
    await Promo.logBulk({ id: `zznojob${SUFFIX}`, kind: 'bulk', audience: 'candidates', purpose: 'ZZTEST promotion with no job', requirementId: null, templates: { WhatsApp: { name: 'job_update' } }, sender: { senderUserId: admin.id, senderName: 'ZZTEST Recruiter' } },
      [{ channel: 'WhatsApp', status: 'sent', address: `+${phoneOf(43)}`, text: 'ZZTEST Hiring Staff Nurses\nSalary: 25,000 per month\nLocation: Vijayawada', entityId: nj.id, providerRef: `zzout43${SUFFIX}`, sentAt: new Date() }]);
    const sayNj = async (t) => { await inbound(phoneOf(43), t); await run(); const m = await aiMsgs(nj.id); return m.length ? m[m.length - 1].body : ''; };
    stub.calls.length = 0;
    const njRole = await sayNj('what is the job role');
    const njPay = await sayNj('salary entha');
    check('no job linked: "what is the job role" and "salary entha" are answered from our own message, the model is not asked', /details from our message/.test(njRole) && /Staff Nurses/.test(njRole) && /Salary: 25,000 per month/.test(njPay) && stub.calls.length === 0, [njRole, njPay, stub.calls.length]);
    const njShift = await sayNj('what are the shift timings');
    const njConv = await convAt(phoneOf(43));
    check('no job linked and our message does not say it: said plainly, a recruiter is told, nothing guessed', /not in our message/.test(njShift) && njConv.state === 'needs_human', [njShift, njConv.state]);
    const edited = await Cfg.saveQuestions({ list: '1. Are you a nurse?\n2) Which city?', closing: 'Bye.' });
    const T5 = require(path.join(BACK, 'src/omniwa/tools'));
    check('an Admin can change the list; numbers typed in front are taken off; [Salary] with no value is skipped', edited.list[0] === 'Are you a nurse?' && edited.list.length === 2 && T5.nextQuestion(['The pay is [Salary]', 'Next?'], 0, { title: 'X' }).text === 'Next?');
    await prisma.appSetting.deleteMany({ where: { key: 'omni.wa.questions' } });
    const nope = await mkCandidate(42, 'Nope');
    await promote(nope, 42);
    await inbound(phoneOf(42), 'No');
    await run();
    conv = await convAt(phoneOf(42));
    check('NO: thanked, marked not interested', conv.state === 'not_interested' && /Thank you for your time/.test((await aiMsgs(nope.id)).pop().body), conv.state);

    // ---- 8b2. only what was promoted
    console.log('\n-- only what was promoted');
    const pr = await mkCandidate(40, 'Pavan');
    await promote(pr, 40, undefined, true);
    await inbound(phoneOf(40), 'Yes');
    stub.calls.length = 0;
    await run();
    const prSent = await aiMsgs(pr.id);
    check('a reply to a promotion of one job gets THAT job\'s details first, from the ATS', stub.calls.length === 0 && prSent.length === 1 && /Physics Lecturer/.test(prSent[0].body) && /Do you want to apply/.test(prSent[0].body), prSent.map((x) => x.body));
    await inbound(phoneOf(40), 'is there any job for nurse');
    await run();
    let prNow = (await aiMsgs(pr.id)).pop().body;
    check('another job is not offered: it says what it can help with', /the job in our message/.test(prNow) && !/These jobs are open/.test(prNow), prNow);
    await inbound(phoneOf(40), 'salary entha');
    await run();
    prNow = (await aiMsgs(pr.id)).pop().body;
    check('a question about the promoted job is answered', /8 LPA/.test(prNow), prNow);
    const T4 = require(path.join(BACK, 'src/omniwa/tools'));
    await prisma.requirement.update({ where: { id: job.id }, data: { reqCode: `REQ-${SUFFIX.slice(-6)}` } });
    check('a Green Start campaign names its job with the code in its name', await T4.jobOfCampaign(`Nurses ${`req ${SUFFIX.slice(-6)}`}`) === job.id && await T4.jobOfCampaign('Summer promo') === null);

    // ---- 8c. each WhatsApp number its own instructions and knowledge
    console.log('\n-- each number its own instructions');
    const WN = require(path.join(BACK, 'src/utils/waNumbers'));
    const nums = (await WN.listRows()).filter((n) => !n.removedAt);
    check('the test database has two numbers', nums.length >= 2, nums.length);
    const [nA, nB] = nums;
    const onNumber = (numberId, from, text) => { provider += 1; return delivery.applyInbound({ channel: 'WhatsApp', from, text, id: `wamid.ZZn${SUFFIX}${provider}`, at: new Date(), name: 'ZZTEST', numberId }); };
    await Cfg.saveProfile(admin, nA.id, { enabled: true, systemPrompt: 'ZZMEDICAL assistant instructions', fallbackMessage: 'ZZ medical team will call you.' });
    await Cfg.saveProfile(admin, nB.id, { enabled: false });
    await Cfg.kbSave(admin, null, { question: 'What are the hostel charges?', answer: 'ZZ medical hostel answer', numberId: nA.id });
    await Cfg.kbSave(admin, null, { question: 'What are the hostel charges for education?', answer: 'ZZ education hostel answer', numberId: nB.id });
    const k = await mkCandidate(30, 'Kiran');
    await promote(k, 30);
    await onNumber(nA.id, phoneOf(30), 'Hi there');
    stub.script = [{ tool: 'search_knowledge_base', args: { query: 'hostel charges' } }, { reply: 'Okay.' }];
    stub.calls.length = 0;
    await run();
    const sysA = stub.calls[0] ? stub.calls[0].messages[0].content : '';
    const toolAnswer = stub.calls[1] ? JSON.stringify(stub.calls[1].messages) : '';
    check('a chat on a number uses THAT number\'s instructions, TeamLink\'s rules stay, the default prompt does not', /ZZMEDICAL assistant/.test(sysA) && /Answer only from the job data/.test(sysA) && !/You help candidates\./.test(sysA), sysA.slice(0, 200));
    check('the knowledge base gives that number\'s entries, not another number\'s', toolAnswer.includes('ZZ medical hostel answer') && !toolAnswer.includes('ZZ education hostel answer'), toolAnswer.slice(-300));
    const m = await mkCandidate(31, 'Mani');
    await promote(m, 31);
    await onNumber(nB.id, phoneOf(31), 'Hello');
    stub.calls.length = 0;
    await run();
    check('a number switched off: no AI on it, even with AI on for the others', stub.calls.length === 0 && (await aiMsgs(m.id)).length === 0);
    await Cfg.removeProfile(nA.id); await Cfg.removeProfile(nB.id);
    check('Use the default takes the number back to the shared settings', (await Cfg.profiles()).length === 0 && (await Cfg.forNumber({ systemPrompt: 'x' }, nA.id)).systemPrompt === 'x');

    const doc = '# EDUCATION DEPARTMENT \u2013 WHATSAPP AI FALLBACK MESSAGES\n\n*1. Unknown Question*\n\n"Thank you for your message. I\'ll check this information with our team and get back to you shortly."\n\n*2. Question Not Understood*\n\n"Sorry, I could not understand your question."';
    check('a whole document saved as the fallback: the candidate gets only its first message', Cfg.oneFallback(doc) === "Thank you for your message. I'll check this information with our team and get back to you shortly." && Cfg.oneFallback('Short and fine.') === 'Short and fine.' && Cfg.oneFallback(`# ${'x'.repeat(500)}`) === Cfg.DEFAULT_FALLBACK);
    const refused = await Cfg.saveProfile(admin, nums[0].id, { enabled: true, fallbackMessage: doc });
    check('and a new one like that is refused in plain words', refused.status === 400 && /one short message/.test(refused.error), refused);

    // ---- 8d. the chatbot in Omni-Channel's Bot Builder (founder 2026-11-09): the settings, read and saved from Green Start
    console.log('\n-- the chatbot in Bot Builder');
    const GB = require(path.join(BACK, 'src/omniwa/gsBot'));
    const botMapBefore = await prisma.appSetting.findUnique({ where: { key: 'omni.gs.waMap' } });
    await prisma.appSetting.upsert({ where: { key: 'omni.gs.waMap' }, update: { value: JSON.stringify({ [nA.id]: { workspaceId: 'zzws-med' }, [nB.id]: { workspaceId: 'zzws-edu' } }) }, create: { key: 'omni.gs.waMap', value: JSON.stringify({ [nA.id]: { workspaceId: 'zzws-med' }, [nB.id]: { workspaceId: 'zzws-edu' } }) } });
    const v1 = await GB.view('zzws-med');
    check('Bot Builder sees the company settings, the questions, and ONLY this workspace\'s number; no secret', v1.ok && v1.numbers.length === 1 && v1.numbers[0].id === nA.id && v1.company.questions.length > 0 && typeof v1.company.enabled === 'boolean'
      && !/token|accessToken|testNumbers/.test(JSON.stringify(v1)), v1);
    const deptTry = await GB.save('zzws-med', { by: 'ZZ dept', company: { systemPrompt: 'ZZ changed by a department' } }, false);
    check('a department login cannot change the settings every number uses', deptTry.ok === false && deptTry.status === 403 && (await Cfg.read()).systemPrompt !== 'ZZ changed by a department', deptTry);
    const otherTry = await GB.save('zzws-med', { by: 'ZZ dept', numbers: [{ id: nB.id, aiOn: false }] }, false);
    check('nor another workspace\'s number', otherTry.ok === false && otherTry.status === 403);
    const own = await GB.save('zzws-med', { by: 'ZZ dept', numbers: [{ id: nA.id, aiOn: false, systemPrompt: 'ZZ medical own words', fallbackMessage: '' }] }, false);
    check('its own number: AI off and its own instructions, saved in TeamLink', own.ok && own.numbers[0].aiOn === false && own.numbers[0].systemPrompt === 'ZZ medical own words' && (await Cfg.forNumber(await Cfg.read(), nA.id)).numberOff === true, own.numbers);
    const longOld = `ZZ old long fallback ${'x'.repeat(400)}`;
    await S.run('UPDATE "OmniWaAiProfile" SET fallbackMessage = ? WHERE numberId = ?', longOld, nA.id);
    const onlySwitch = await GB.save('zzws-med', { by: 'ZZ dept', numbers: [{ id: nA.id, aiOn: true }] }, false);
    check('only the switch is sent: AI back on, an old long fallback and the own instructions stay as saved', onlySwitch.ok && onlySwitch.numbers[0].aiOn === true && onlySwitch.numbers[0].fallbackMessage === longOld && onlySwitch.numbers[0].systemPrompt === 'ZZ medical own words', onlySwitch);
    const newLong = await GB.save('zzws-med', { by: 'ZZ dept', numbers: [{ id: nA.id, fallbackMessage: `ZZ new long ${'y'.repeat(400)}` }] }, false);
    check('a NEW long fallback is still refused', newLong.ok === false && newLong.status === 400, newLong);
    // a Bot Builder bot's Handover step set to "WhatsApp AI": the AI takes the chat on a number whose AI is off
    await GB.save('zzws-med', { by: 'ZZ dept', numbers: [{ id: nA.id, aiOn: false }] }, false);
    const hb = await mkCandidate(63, 'Harika');
    await onNumber(nA.id, phoneOf(63), 'Talk to us');
    stub.calls.length = 0;
    await run();
    const beforeTake = (await aiMsgs(hb.id)).length;
    const wrongWs = await GB.take('zzws-edu', { phone: phoneOf(63), bot: 'ZZ bot' });
    const took = await GB.take('zzws-med', { phone: phoneOf(63), bot: 'ZZ Medical bot' });
    stub.script = [{ reply: 'ZZ the AI took over this chat' }];
    await run();
    const afterTake = await aiMsgs(hb.id);
    check('the number\'s AI is off: silent; the bot hands over: the AI answers the last message, only for this workspace\'s chat', beforeTake === 0 && wrongWs.status === 403 && took.ok && afterTake.length === 1, [beforeTake, wrongWs, took, afterTake.map((m) => m.body)]);
    await onNumber(nA.id, phoneOf(63), 'What is the salary?');
    stub.script = [{ reply: 'ZZ second AI answer' }];
    await run();
    check('and keeps answering in that chat after the hand-over', (await aiMsgs(hb.id)).length === 2);
    const cfgBefore = await Cfg.read(); const qBefore = await Cfg.questions();
    const co = await GB.save('zzws-med', { by: 'ZZ company', company: { maxTurns: 9, questions: ['ZZ question one?', 'ZZ question two?'], closing: 'ZZ thanks' } }, true);
    check('the company login changes the shared settings and questions', co.ok && co.company.maxTurns === 9 && co.company.questions.length === 2 && co.company.closing === 'ZZ thanks', co.company);
    const bad = await GB.save('zzws-med', { company: { questions: [] } }, true);
    check('an empty question list is refused in plain words', bad.ok === false && bad.status === 400 && /at least one question/i.test(bad.error), bad);
    await Cfg.save(admin, { maxTurns: cfgBefore.maxTurns }); await Cfg.saveQuestions({ list: qBefore.list, closing: qBefore.closing });
    await Cfg.removeProfile(nA.id);
    if (botMapBefore) await prisma.appSetting.update({ where: { key: 'omni.gs.waMap' }, data: { value: botMapBefore.value } }); else await prisma.appSetting.delete({ where: { key: 'omni.gs.waMap' } });

    // ---- 9. promotions, already contacted, the push, the other responders
    console.log('\n-- promotions and the screen');
    await Promo.onStatus({ providerRef: `zzout2${SUFFIX}`, status: 'delivered' });
    await Promo.onStatus({ providerRef: `zzout2${SUFFIX}`, status: 'read' });
    await Promo.onStatus({ providerRef: `zzout2${SUFFIX}`, status: 'delivered' });
    await Promo.onStatus({ providerRef: `zzout3${SUFFIX}`, status: 'failed', error: 'ZZTEST number has no WhatsApp' });
    const log = await Inbox.promotions(adminMe, {});
    const rowB = log.rows.find((r) => r.candidateId === b.id); const rowC = log.rows.find((r) => r.candidateId === c.id);
    check('each promotion keeps candidate, job, campaign, template, recruiter and the true status (never backwards)', rowB && rowB.status === 'read' && rowB.jobTitle === job.title && !!rowB.campaignName && rowB.template === 'job_update' && rowB.senderName === 'ZZTEST Recruiter' && rowC.status === 'failed', rowB);
    await prisma.candidateMessage.create({ data: { candidateId: g.id, channel: 'WhatsApp', template: 'MANUAL', trigger: 'Manual', recipient: `+${phoneOf(7)}`, body: 'ZZTEST', status: 'SENT', senderUserId: admin.id, senderName: 'ZZTEST Other Recruiter' } });
    const seen = await Inbox.recentContact({ id: 'someone-else' }, [g.id]);
    const notMe = await Inbox.recentContact({ id: admin.id }, [g.id]);
    check('already contacted: another recruiter in the last 7 days shows, your own message does not', seen.get(g.id) && seen.get(g.id).byName === 'ZZTEST Other Recruiter' && !notMe.has(g.id));
    let pushed = null;
    const off2 = Live.subscribe((...args) => { pushed = args; });
    await inbound(phoneOf(8), 'push');
    off2();
    check('the inbox is told at once, and the push carries no name and no words', Array.isArray(pushed) && pushed.length === 0);
    await prisma.candidateMessage.updateMany({ where: { candidateId: { in: [b.id] } }, data: {} });
    check('the keyword bot and the campaign auto-reply stay quiet in a chat the AI answers', await Agent.ownsChat({ candidateId: b.id }) === true && await Agent.ownsChat({ candidateId: a.id }) === false);
    const counts = (await S.q('SELECT COUNT(*) AS n FROM "OmniWaAiRun"'))[0];
    check('every run is logged', Number(counts.n) > 5);
    const js = JSON.stringify(await Inbox.runs({ limit: 300 }));
    check('no WhatsApp secret in the log', !/access_token|Bearer /.test(js));
  } catch (err) {
    fail += 1; console.log('  ERROR', err && err.stack);
  } finally {
    server.close();
    await prisma.$disconnect().catch(() => {});
    for (const x of [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`]) { try { fs.unlinkSync(x); } catch { /* gone */ } }
    console.log(`\nOmni-Channel WhatsApp AI: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
