#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL AI MARKETING > PLANS MEETING TEST (2026-11-17): the signed link, the team's side (make / list / settings / remove), the client's public side (view / start / events) and the public router.
// IN-PROCESS and SANDBOX ONLY: it copies prisma/sandbox.db to a temporary file and works on the copy, so no real data is touched. Nothing is sent (the WhatsApp step is only checked to fail cleanly).
//   cd backend && node scripts/omni-mk-meeting-test.js
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const SRC = path.join(BACK, 'prisma', 'sandbox.db');
if (!fs.existsSync(SRC)) { console.error('Refusing: this test needs prisma/sandbox.db (npm run sandbox creates it).'); process.exit(2); }
const TMP = path.join(os.tmpdir(), `mk-meeting-test-${Date.now().toString(36)}.db`);
process.env.MK_MEETING_VOICE_DIR = path.join(os.tmpdir(), `mk-meeting-voice-test-${Date.now().toString(36)}`); // the saved sentences of this run only
fs.copyFileSync(SRC, TMP);
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${TMP.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TL_SANDBOX = process.env.TL_SANDBOX || '1';
const express = require(path.join(BACK, 'node_modules/express'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity } = require(path.join(BACK, 'src/utils/identity'));
const M = require(path.join(BACK, 'src/marketing/meeting'));

const S0 = require(path.join(BACK, 'src/outreach/store'));
const S0q = async (id) => (await S0.q('SELECT * FROM "OmniMkMeeting" WHERE id = ?', id))[0];
const S0run = async (id) => S0.run('UPDATE "OmniMkMeeting" SET summaryAt = NULL WHERE id = ?', id);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };

(async () => {
  try {
    const saRow = await prisma.user.findFirst({ where: { status: 'Active', role: 'SUPER_ADMIN' } });
    check('0 the sandbox copy has a Super Admin', !!saRow);
    const sa = await resolveIdentity(saRow.id);

    // the signed link
    const t1 = M.tokenOf('abcd1234abcd1234');
    check('1 a token is "<id>.<32 characters>" and reads back to its id', /^abcd1234abcd1234\.[A-Za-z0-9_-]{32}$/.test(t1) && M.idOfToken(t1) === 'abcd1234abcd1234', t1);
    check('1b a changed signature, a changed id, junk and nothing are all refused', M.idOfToken(`${t1.slice(0, -1)}${t1.endsWith('A') ? 'B' : 'A'}`) === null && M.idOfToken(t1.replace('abcd1234abcd1234', 'abcd1234abcd1235')) === null && M.idOfToken('hello') === null && M.idOfToken('') === null && M.idOfToken(null) === null);

    // making a link
    const bad = await M.create(sa, { name: 'Ravi', phone: 'abc', language: 'te' });
    check('2 a phone number that is not a number is refused', bad.status === 400 && /does not look right/.test(bad.error || ''), bad);
    const made = await M.create(sa, { name: 'ZZ Test Ravi', phone: '9876543210', language: 'te', note: 'test note' });
    check('2b a good link is made with a token, the language and a masked number to show', !!(made.meeting && made.meeting.token && made.meeting.language === 'te' && made.meeting.phoneMasked && !/9876543210/.test(made.meeting.phoneMasked)), made);
    const lang = await M.create(sa, { name: 'ZZ No Phone', language: 'zz' });
    check('2c no number is allowed (it can be typed when sending) and an unknown language becomes English', !!(lang.meeting && lang.meeting.language === 'en' && lang.meeting.phone === ''), lang);
    const m = made.meeting;

    let list = await M.list(sa);
    const mine = (list.items || []).find((x) => x.id === m.id);
    check('3 the list shows it as "Not opened" and counts it', !!mine && mine.interest === 'Not opened' && list.counts.notOpened >= 2 && list.counts.total >= 2, list.counts);

    // the client opens it
    const v = await M.publicView(m.token);
    check('4 the client page gets the language, the first name, the spots and no private data', v.session && v.session.language === 'te' && v.session.firstName === 'ZZ' && v.session.hasPhone === true && v.spotsLeft === 10 && !/9876543210|createdBy|note/.test(JSON.stringify(v)), v);
    check('4b the numbers slide gets proof only when there is real finished work', v.proof === null || (v.proof.n >= 1 && v.proof.hours >= 1), v.proof);
    check('4c a wrong or made-up link gets the plain "does not work" answer', (await M.publicView('abcd1234abcd1234.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status === 404 && (await M.publicView('nonsense')).status === 404);
    list = await M.list(sa);
    check('4d it now counts as opened (Cold)', (list.items.find((x) => x.id === m.id) || {}).interest === 'Cold' && list.items.find((x) => x.id === m.id).views === 1);

    // what the client does
    check('5 start saves the language', (await M.publicEvent(m.token, { type: 'start', language: 'hi' })).ok === true && (await M.list(sa)).items.find((x) => x.id === m.id).language === 'hi');
    await M.publicEvent(m.token, { type: 'slide', slide: 3 });
    await M.publicEvent(m.token, { type: 'slide', slide: 6 });
    await M.publicEvent(m.token, { type: 'slide', slide: 2 });
    let row = (await M.list(sa)).items.find((x) => x.id === m.id);
    check('5b slides: the furthest is kept, the last is the latest, and "Warm" after slide 5', row.maxSlide === 6 && row.lastSlide === 2 && row.interest === 'Warm' && !row.finishedAt, row);
    await M.publicEvent(m.token, { type: 'slide', slide: 99 });
    row = (await M.list(sa)).items.find((x) => x.id === m.id);
    check('5c a slide number past the end is held at the last slide and marks the meeting finished', row.maxSlide === 11 && !!row.finishedAt, row);
    check('5d a question is saved with its answer id; an empty one is refused', (await M.publicEvent(m.token, { type: 'ask', q: 'How much does it cost?', faq: 'F1' })).ok === true && (await M.publicEvent(m.token, { type: 'ask', q: '   ' })).status === 400 && (await M.publicEvent(m.token, { type: 'ask', q: 'something odd', faq: '<script>' })).ok === true);
    row = (await M.list(sa)).items.find((x) => x.id === m.id);
    check('5e the questions are on the row (the odd answer id is dropped)', row.questions.length === 2 && row.questions[0].id === 'F1' && row.questions[1].id === '', row.questions);
    check('5f an unknown event or choice is refused', (await M.publicEvent(m.token, { type: 'hack' })).status === 400 && (await M.publicEvent(m.token, { type: 'choice', choice: 'free-money', phone: '9876543210' })).status === 400);
    check('5g a wrong phone number is refused before anything is saved', (await M.publicEvent(m.token, { type: 'handover', phone: '12', window: 'asap' })).status === 400);
    const ho = await M.publicEvent(m.token, { type: 'handover', name: 'Ravi Kumar', phone: '9123456780', window: 'evening' });
    row = (await M.list(sa)).items.find((x) => x.id === m.id);
    check('6 a call request saves the name, the number, the time and makes the lead Hot', ho.ok === true && row.interest === 'Hot' && row.choice === 'team' && row.callbackWindow === 'evening' && row.name === 'Ravi Kumar' && !!row.handoverAt, row);
    const ch = await M.publicEvent(m.token, { type: 'choice', choice: 'growth', phone: '9123456780', window: 'nonsense' });
    row = (await M.list(sa)).items.find((x) => x.id === m.id);
    check('6b choosing a plan is saved (an unknown time becomes "as soon as possible")', ch.ok === true && row.choice === 'growth' && row.callbackWindow === 'asap', row);
    const bell = await prisma.notification.findFirst({ where: { userId: saRow.id, title: { contains: 'Plans meeting: Ravi Kumar asked for a call' } }, orderBy: { createdAt: 'desc' } });
    check('6c the person who made the link got a bell for the call request, with the time to call', !!bell && /evening/.test(bell.message || ''), bell);

    // a page opened with no link
    const open = await M.publicStart('hi');
    check('7 a page opened with no link starts its own session with a valid token', !!(open.token && M.idOfToken(open.token) && open.session.language === 'hi' && open.spotsLeft === 10), open);
    check('7b its events work, and it is in the Admin list only', (await M.publicEvent(open.token, { type: 'slide', slide: 1 })).ok === true && !!(await M.list(sa)).items.find((x) => x.source === 'open'));

    // spots left
    const bad2 = await M.saveSettings(sa, { spotsLeft: -1 }); const bad3 = await M.saveSettings(sa, { spotsLeft: 'x' });
    check('8 the first-ten spots: -1 and letters are refused', bad2.status === 400 && bad3.status === 400);
    const ok0 = await M.saveSettings(sa, { spotsLeft: 0 });
    check('8b 0 is saved and the client page then gets 0', !!ok0.ok && (await M.publicView(m.token)).spotsLeft === 0, ok0);
    await M.saveSettings(sa, { spotsLeft: 10 });

    // sending: nothing real goes out; it must fail cleanly and leave "sent" empty
    const noSite = await M.tell(sa, m.id, {}, '');
    check('9 sending without the site address is refused', noSite.status === 400 && /https address/.test(noSite.error || ''), noSite);
    const wrongNo = await M.tell(sa, m.id, { phone: 'abc' }, 'https://teamlink.test');
    check('9b a wrong number typed in the send box is refused and does not replace the saved one', wrongNo.status === 400 && (await M.list(sa)).items.find((x) => x.id === m.id).phoneMasked === row.phoneMasked, wrongNo);
    const sent = await M.tell(sa, m.id, {}, 'https://teamlink.test');
    row = (await M.list(sa)).items.find((x) => x.id === m.id);
    check('9c in the sandbox the WhatsApp step answers (error or sent) and "sent" is set only if it really went', sent.error ? !row.sentAt : !!row.sentAt, sent);
    const text = M.inviteText('te', 'Ravi', 'https://x/y');
    check('9d the invite words exist in all three languages and carry the link', ['en', 'te', 'hi'].every((l) => M.inviteText(l, 'Ravi', 'https://x/y').includes('https://x/y')) && /Ravi/.test(text));

    // the public router
    const app = express(); app.use(express.json()); app.use('/api/public/mk-meeting', require(path.join(BACK, 'src/routes/mkMeetingPublic')));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api/public/mk-meeting`;
    const get = await fetch(`${base}/${m.token}`);
    const gj = await get.json();
    check('10 GET with the link answers 200, never cached, never indexed', get.status === 200 && /no-store/.test(get.headers.get('cache-control') || '') && /noindex/.test(get.headers.get('x-robots-tag') || '') && gj.session.language === 'hi', { s: get.status, h: [...get.headers.keys()] });
    const g404 = await fetch(`${base}/not-a-token`);
    check('10b GET with a made-up link answers 404 with a plain error', g404.status === 404 && !!(await g404.json()).error);
    const pe = await fetch(`${base}/${m.token}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'slide', slide: 4 }) });
    check('10c POST event answers 200', pe.status === 200 && (await pe.json()).ok === true);
    const ps = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'te' }) });
    const pj = await ps.json();
    check('10d POST with no link starts a session', ps.status === 200 && !!pj.token && pj.session.language === 'te');
    await new Promise((r) => srv.close(r));

    // the server voice (marketing/meetingVoice.js): only the meeting's own sentences, once each, from the engines the AI calls use. A FAKE engine here: nothing is spoken for real.
    const Gen = require(path.join(BACK, 'scripts/make-meeting-sentences'));
    const fresh = await Gen.build();
    const onDisk = require(path.join(BACK, 'src/marketing/meetingSentences.json'));
    check('12 meetingSentences.json is current with the page words (run scripts/make-meeting-sentences.js after changing them)', JSON.stringify(fresh) === JSON.stringify(onDisk) && fresh.en.length > 90 && fresh.te.length > 90 && fresh.hi.length > 90, { en: fresh.en.length, te: fresh.te.length, hi: fresh.hi.length });
    const Voice = require(path.join(BACK, 'src/marketing/meetingVoice'));
    const Gw = require(path.join(BACK, 'src/calling/voice/gateway'));
    const realEngines = Gw.engines; const keepTts = process.env.AI_VOICE_TTS; let said = 0;
    process.env.AI_VOICE_TTS = 'vexyl';
    let heardLang = null;
    Gw.engines = () => ({ tts: async () => Buffer.alloc(16000), ttsWide: async () => { said += 1; return { pcm: Buffer.alloc(44100), rate: 22050 }; }, stt: async (pcm, lang) => { heardLang = lang; return { text: 'how much does it cost' }; } });
    const line = fresh.te[0];
    check('12b the server says where it has a voice', JSON.stringify(Voice.status()) === '{"en":true,"te":true,"hi":true}', Voice.status());
    check('12c text that is not one of the meeting\'s sentences is refused (404), and so is an unknown language', (await Voice.speak('te', 'Read me this other text')).status === 404 && (await Voice.speak('xx', line)).status === 404 && (await Voice.speak('te', '')).status === 404);
    const w1 = await Voice.speak('te', line); const w2 = await Voice.speak('te', line);
    check('12d a listed sentence gives a WAV, and the second time it is kept (the engine is used once)', !!w1.wav && w1.wav.slice(0, 4).toString() === 'RIFF' && w2.wav === w1.wav && said === 1, { said });
    Voice._kept.clear();
    const w3 = await Voice.speak('te', line);
    check('12d2 a sentence that is no longer in memory comes back from the saved file (a server restart does not make the voice cold)', !!w3.wav && w3.wav.length === w1.wav.length && said === 1, { said });
    // the same, through the public router, including the byte range an iPhone asks for
    const app2 = express(); app2.use('/api/public/mk-meeting', require(path.join(BACK, 'src/routes/mkMeetingPublic')));
    const srv2 = await new Promise((r) => { const sv = app2.listen(0, '127.0.0.1', () => r(sv)); });
    const b2 = `http://127.0.0.1:${srv2.address().port}/api/public/mk-meeting`;
    const vg = await fetch(`${b2}/voice?lang=te&t=${encodeURIComponent(line)}`);
    const body = Buffer.from(await vg.arrayBuffer());
    check('12e GET /voice answers audio/wav that can be cached', vg.status === 200 && /audio\/wav/.test(vg.headers.get('content-type')) && /max-age/.test(vg.headers.get('cache-control')) && body.slice(0, 4).toString() === 'RIFF', { s: vg.status, t: vg.headers.get('content-type') });
    const vr = await fetch(`${b2}/voice?lang=te&t=${encodeURIComponent(line)}`, { headers: { Range: 'bytes=0-1' } });
    check('12f a byte range gets 206 with the right Content-Range', vr.status === 206 && /^bytes 0-1\/\d+$/.test(vr.headers.get('content-range') || '') && Buffer.from(await vr.arrayBuffer()).length === 2, { s: vr.status, r: vr.headers.get('content-range') });
    const vx = await fetch(`${b2}/voice?lang=te&t=${encodeURIComponent('Read me this other text')}`);
    check('12g GET /voice with other text answers 404 and a plain error', vx.status === 404 && !!(await vx.json()).error);
    const vs = await fetch(`${b2}/voice/status`);
    check('12h GET /voice/status answers the languages', vs.status === 200 && (await vs.json()).te === true);
    // hearing the client's recorded question (marketing/meetingHear.js), with a FAKE listener
    const Hear = require(path.join(BACK, 'src/marketing/meetingHear')); const RE = require(path.join(BACK, 'src/calling/voice/engines'));
    const wav1s = RE.pcmToWav(Buffer.alloc(8000 * 2), 8000);
    const h1 = await Hear.hear('te', wav1s);
    check('12j a recorded sound is turned into words by the right listener (Telugu here)', h1.text === 'how much does it cost' && heardLang === 'Telugu', { h1, heardLang });
    check('12k too short, an unknown language and too long are refused', (await Hear.hear('te', Buffer.alloc(10))).status === 400 && (await Hear.hear('xx', wav1s)).status === 400 && (await Hear.hear('te', Buffer.alloc(3 * 1024 * 1024))).status === 413);
    const hp = await fetch(`${b2}/hear?lang=hi`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wav1s });
    check('12l POST /hear answers { text } and keeps nothing', hp.status === 200 && (await hp.json()).text === 'how much does it cost' && heardLang === 'Hindi', { s: hp.status, heardLang });
    const hb = await fetch(`${b2}/hear?lang=hi`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(20) });
    check('12m a sound that is too short answers 400 with a plain error', hb.status === 400 && !!(await hb.json()).error);
    await new Promise((r) => srv2.close(r));
    Gw.engines = () => null;
    check('12i2 with no listener hearing is refused with 503 and a plain error', (await Hear.hear('te', wav1s)).status === 503);
    check('12i with no engine the server says it has no voice and refuses with 503', JSON.stringify(Voice.status()) === '{"en":false,"te":false,"hi":false}' && (await Voice.speak('hi', fresh.hi[1])).status === 503);
    Gw.engines = realEngines; if (keepTts === undefined) delete process.env.AI_VOICE_TTS; else process.env.AI_VOICE_TTS = keepTts;

    // what the meeting answers (the page's own logic, imported as the browser has it): a budget, a named plan, the usual answers
    const FE = await Gen.loadFrontend(['meetingContent', 'meetingLogic', 'meetingBudget', 'meetingPlans']);
    const { budgetOf, planFor, budgetReply } = FE.meetingBudget; const { planAnswer } = FE.meetingPlans; const { matchFaq } = FE.meetingLogic;
    check('13 a budget is read from what people type: 30L, 15k, 6000, Rs 4,800, Hindi digits; not from "999 trial" or "10 posts"',
      budgetOf('my budget is upto 30L') === 3000000 && budgetOf('budget 15k per month') === 15000 && budgetOf('my budget is 6000') === 6000 && budgetOf('Rs 4,800 a month') === 4800 && budgetOf('बजट ₹ ६०००') === 6000 && budgetOf('what is the 999 trial') === null && budgetOf('I need 10 posts') === null,
      [budgetOf('my budget is upto 30L'), budgetOf('budget 15k per month'), budgetOf('Rs 4,800 a month'), budgetOf('what is the 999 trial')]);
    check('13b the plan that fits a budget follows the prices with GST (4,719 / 11,799 / 23,599, rounded up to 4,800 / 11,800 / 23,600)', planFor(1000) === 'low' && planFor(1200) === 'trial' && planFor(4799) === 'trial' && planFor(4800) === 'starter' && planFor(11799) === 'starter' && planFor(11800) === 'growth' && planFor(23599) === 'growth' && planFor(23600) === 'premium');
    const big = budgetReply(3000000, 'en');
    check('13c a 30 lakh budget gets Premium, shows the number it understood, and is not the "which plan" answer again', big.plan === 'premium' && /30,00,000/.test(big.shown) && /Premium fits/.test(big.text) && big.text !== FE.meetingContent.FAQ.find((f) => f.id === 'F3').answer.en);
    const asked = (q, lang = 'en') => { const u = matchFaq(q, FE.meetingContent.FAQ); return planAnswer(q, lang, u ? u.id : null); };
    const sp = asked('starter plan with gst final cost');
    check('14 "starter plan with GST final cost" gets Starter\'s own total: 3,999 + 720 = 4,719', !!sp && /four thousand seven hundred nineteen/.test(sp.text) && /₹3,999 \+ ₹720 GST \(18%\) = ₹4,719/.test(sp.shown) && sp.faq === 'F1', sp);
    check('14b the same question in Telugu and Hindi gets the answer in that language', /నాలుగు వేల ఏడు వందల పంతొమ్మిది/.test((asked('స్టార్టర్ ప్లాన్ జీఎస్టీతో ఎంత', 'te') || {}).text || '') && /चार हज़ार सात सौ उन्नीस/.test((asked('स्टार्टर प्लान जीएसटी के साथ कितना', 'hi') || {}).text || ''));
    check('14c the totals are right for all three plans (price + 18% GST, rounded to the rupee)', [[3999, 720, 4719, 'starter'], [9999, 1800, 11799, 'growth'], [19999, 3600, 23599, 'premium']].every(([a, g, t, p]) => Math.round(a * 0.18) === g && a + g === t && new RegExp(String.raw`₹${a.toLocaleString('en-IN')} \+ ₹${g.toLocaleString('en-IN')} GST \(18%\) = ₹${t.toLocaleString('en-IN')}`).test(asked(`${p} price with gst`).shown)));
    check('14d "what does Premium include" and "Starter vs Growth" get the plan sheet and the comparison', /weekly report/.test((asked('what does premium include') || {}).text || '') && /double the content of Starter/.test((asked('starter vs growth') || {}).text || '') && /thirty pictures and eight videos instead of sixteen and four/.test((asked('growth vs premium difference') || {}).text || ''));
    check('14e questions that are not about a plan\'s numbers keep their own answer ("can I cancel Growth", "which plan is right for me")', asked('can i cancel growth plan') === null && asked('which plan is right for me') === null && asked('is gst included') === null);
    check('14f the budget bands on slide 6 are the same as the budget answer (4,800 / 11,800 / 23,600)', FE.meetingContent.SLIDES[6].screen.en.join(' ').includes('4,800') && FE.meetingContent.SLIDES[6].screen.en.join(' ').includes('11,800') && FE.meetingContent.SLIDES[6].screen.en.join(' ').includes('23,600') && !/24,000/.test(JSON.stringify(FE.meetingContent.SLIDES[6])));

    // the call button and the WhatsApp alert (founder 2026-11-17). FAKE telephony and WhatsApp here: nothing is dialled or sent.
    const CL = require(path.join(BACK, 'src/utils/callLines')); const MC = require(path.join(BACK, 'src/utils/messageChannels')); const MG = require(path.join(BACK, 'src/utils/messaging'));
    const realStart = CL.startCall; const realOwn = MC.ownContact; const realSend = MG.send;
    const m2 = (await M.create(sa, { name: 'ZZ Call Test', language: 'en' })).meeting;
    const noPhone = await M.call(sa, m2.id, { line: 'api' });
    check('15 calling a meeting with no number is refused', noPhone.status === 400 && /phone number/.test(noPhone.error || ''), noPhone);
    await M.tell(sa, m2.id, { phone: '9123456780' }, '').catch(() => null); // saves nothing without a site; the number is typed below through a handover instead
    await M.publicEvent(m2.token, { type: 'ask', q: 'hello' });
    await M.publicEvent(m2.token, { type: 'handover', name: 'ZZ Call Test', phone: '9123456780', window: 'morning' });
    MC.ownContact = async () => ({ phone: null, name: 'Test' });
    const noOwn = await M.call(sa, m2.id, { line: 'api' });
    check('15b with no phone on the caller\'s employee profile the call is refused with the reason (and a hint to use "Dial it myself")', noOwn.status === 409 && /employee profile/.test(noOwn.error || '') && /Dial it myself/.test(noOwn.error || ''), noOwn);
    let asked1 = null;
    MC.ownContact = async () => ({ phone: '9000000001', name: 'Test Caller' });
    CL.startCall = async (line, args) => { asked1 = { line, args }; return { ok: true, callSid: 'fake-1', line: line || 'api' }; };
    const called = await M.call(sa, m2.id, { line: 'sip' });
    const rowC = (await M.list(sa)).items.find((x) => x.id === m2.id);
    check('15c a call rings the caller first, dials the client on the picked line, and is saved on the row', !!called.ok && asked1 && asked1.line === 'sip' && asked1.args.agent === '9000000001' && asked1.args.to === '9123456780' && /mkmeeting:/.test(asked1.args.ref) && !!rowC.calledAt && rowC.calledByName === sa.name && rowC.callLine === 'sip', { called, asked1, rowC });
    check('15d once called after the request, the client no longer counts as waiting for a call', rowC.calledAt >= rowC.handoverAt && (await M.list(sa)).counts.waiting === (await M.list(sa)).items.filter((x) => x.handoverAt && (!x.calledAt || x.calledAt < x.handoverAt)).length);
    CL.startCall = async () => ({ ok: false, notConfigured: true, error: 'Calling is not connected yet.' });
    const nc = await M.call(sa, m2.id, { line: 'api' });
    check('15e a line that is not connected gives its reason, not a crash', nc.status === 409 && /not connected/.test(nc.error || ''), nc);
    const rowAfter = (await M.list(sa)).items.find((x) => x.id === m2.id);
    check('15f a failed call does not change who called last', rowAfter.callLine === 'sip');
    CL.startCall = realStart; MC.ownContact = realOwn;

    // WhatsApp alert
    const badAlert = await M.saveAlert(sa, { on: true, phone: 'abc' });
    check('16 an alert needs a real WhatsApp number', badAlert.status === 400, badAlert);
    const goodAlert = await M.saveAlert(sa, { on: true, phone: '8919239827' });
    check('16b the alert is saved for this person and shown masked in the message', !!goodAlert.ok && /9827/.test(goodAlert.ok) && !/8919239827/.test(goodAlert.ok) && goodAlert.alert.on === true, goodAlert);
    check('16c the spots setting keeps the alert when it is saved (and the alert number is never in the public view)', !!(await M.saveSettings(sa, { spotsLeft: 7 })).ok && (await M.myAlert(sa)).on === true && !/8919239827/.test(JSON.stringify(await M.publicView(m2.token))) && !/8919239827/.test(JSON.stringify((await M.list(sa)).settings)));
    // no phone on the employee profile, but the person saved their own number: it rings first
    const mR = (await M.create(sa, { name: 'ZZ Ring Test', phone: '9123456780', language: 'en' })).meeting;
    let ringArgs = null;
    MC.ownContact = async () => ({ phone: null, name: 'Test Caller' });
    CL.startCall = async (line, args) => { ringArgs = args; return { ok: true, callSid: 'fake-2', line: line || 'api' }; };
    const viaSaved = await M.call(sa, mR.id, { line: 'sip' });
    check('16i with no phone on the employee profile the number saved in "Calls and alerts" rings first (shown masked in the message)', !!viaSaved.ok && ringArgs && ringArgs.agent === '8919239827' && /9827/.test(viaSaved.ok) && !/8919239827/.test(viaSaved.ok), { viaSaved, ringArgs });
    await M.saveAlert(sa, { on: false, phone: '8919239827' });
    check('16j the number can be saved with the alert off, and it still rings first', (await M.myAlert(sa)).on === false && (await M.myAlert(sa)).phone === '8919239827' && !!(await M.call(sa, mR.id, { line: 'sip' })).ok);
    await M.saveAlert(sa, { on: true, phone: '8919239827' });
    // the client's number is the caller's own number (how the founder tested): refused with the reason, no call made
    const mSame = (await M.create(sa, { name: 'ZZ Same Test', phone: '8919239827', language: 'en' })).meeting;
    let dialled = false; CL.startCall = async () => { dialled = true; return { ok: true, callSid: 'fake-3', line: 'sip' }; };
    const same = await M.call(sa, mSame.id, { line: 'sip' });
    check('16k a client number that is the same as the phone that rings first is refused with the reason and nothing is dialled', same.status === 400 && /same as the phone that rings first/.test(same.error || '') && /colleague/.test(same.error || '') && dialled === false && !/8919239827/.test(same.error), same);
    await M.remove(sa, mSame.id);
    CL.startCall = realStart; MC.ownContact = realOwn;
    await M.remove(sa, mR.id);
    const sentTo = [];
    MG.send = async (channel, o) => { sentTo.push({ channel, to: o.to, text: o.text, vars: o.vars }); return { ok: true }; };
    const m3 = (await M.create(sa, { name: 'ZZ Alert Test', phone: '9123456780', language: 'en' })).meeting;
    await M.publicEvent(m3.token, { type: 'handover', name: 'Ravi', phone: '9123456780', window: 'afternoon' });
    check('16d a call request sends one WhatsApp to the person who made the link, with the name, the number and when to call, on one line', sentTo.length === 1 && sentTo[0].channel === 'WhatsApp' && sentTo[0].to === '918919239827' && /Ravi/.test(sentTo[0].text) && /9123456780/.test(sentTo[0].text) && /afternoon/.test(sentTo[0].text) && !/\n/.test(sentTo[0].text) && sentTo[0].vars[0] === sentTo[0].text, sentTo);
    await M.publicEvent(m3.token, { type: 'handover', name: 'Ravi', phone: '9123456780', window: 'afternoon' });
    check('16e the same client asking again within 3 minutes does not alert again', sentTo.length === 1, sentTo.length);
    const open2 = await M.publicStart('en');
    await M.publicEvent(open2.token, { type: 'handover', name: 'Walk-in', phone: '9123456781', window: 'asap' });
    check('16f a page opened with no link (nobody made it) alerts everyone who switched alerts on', sentTo.length === 2 && sentTo[1].to === '918919239827' && /Walk-in/.test(sentTo[1].text), sentTo);
    await M.saveAlert(sa, { on: false });
    const open3 = await M.publicStart('en');
    await M.publicEvent(open3.token, { type: 'handover', name: 'Nobody', phone: '9123456782', window: 'asap' });
    check('16g with the alert switched off no WhatsApp goes (the bell still does)', sentTo.length === 2 && (await M.myAlert(sa)).on === false, sentTo.length);
    MG.send = async () => { throw new Error('WhatsApp down'); };
    await M.saveAlert(sa, { on: true, phone: '8919239827' });
    const open4 = await M.publicStart('en');
    const ev4 = await M.publicEvent(open4.token, { type: 'handover', name: 'Still saved', phone: '9123456783', window: 'asap' });
    check('16h if the alert cannot be sent the client\'s request is still saved and answered', ev4.ok === true && (await M.list(sa)).items.find((x) => x.id === (M.idOfToken(open4.token))).handoverAt > 0);
    MG.send = realSend;
    await M.saveAlert(sa, { on: false });
    for (const x of [m2, m3]) await M.remove(sa, x.id);

    // what the phone's recogniser mishears (the founder said "list of the plans" and it wrote "list of the plants")
    const idOf = (q) => { const m = matchFaq(q, FE.meetingContent.FAQ); return m ? m.id : null; };
    check('14g "list of the plans", the misheard "list of the plants" and "what plants do you have" all give the prices (F1), in Telugu and Hindi too', ['list of the plans', 'list of the plants', 'what plants do you have', 'show me all plans', 'ప్లాన్లు ఏమిటి', 'सभी प्लान बताइए'].every((q) => idOf(q) === 'F1'), ['list of the plans', 'list of the plants', 'what plants do you have', 'ప్లాన్లు ఏమిటి', 'सभी प्लान बताइए'].map((q) => `${q}=${idOf(q)}`));
    check('14g2 "can i know the best plan" and "which is the best" ask for plan advice (F3); "best price" is still the price', idOf('can i know the best plan') === 'F3' && idOf('which is the best') === 'F3' && idOf('what is the best price') === 'F1', ['can i know the best plan', 'which is the best', 'what is the best price'].map((q) => `${q}=${idOf(q)}`));
    check('14h one wrong letter is forgiven only in longer words: nothing answers noise, "again and again" or "paid maid", and "which plan is right for me" is still the plan advice', idOf('asdf qwerty zzz') === null && idOf('again and again') === null && idOf('paid maid') === null && idOf('a') === null && idOf('which plan is right for me') === 'F3' && idOf('can i change my plans') === 'F8');
    // ---- the ideas: the CRM lead, the questions with no answer and the answers the team adds, the plans on WhatsApp by the client's tap, the short link ----
    const CRMDB = require(path.join(BACK, 'src/crm/schema'));
    const mI = (await M.create(sa, { name: 'ZZ Ideas Test', phone: '9123456799', language: 'en' })).meeting; // a phone no earlier test used (the same phone is the same CRM lead)
    check('17 the short address /m/<id> gives the full link behind it; a made-up one does not', (await M.publicShort(mI.id)).token === M.tokenOf(mI.id) && (await M.publicShort('0123456789abcdef')).status === 404 && (await M.publicShort('nonsense')).status === 404);

    // questions with no answer
    await M.publicEvent(mI.token, { type: 'ask', q: 'Do you provide logo design?', faq: '' });
    await M.publicEvent(mI.token, { type: 'ask', q: 'do you provide logo design', faq: '' });
    await M.publicEvent(mI.token, { type: 'ask', q: 'how much does it cost', faq: 'F1' });
    let L = await M.list(sa);
    const un = L.unanswered.find((e) => /logo design/i.test(e.q));
    check('17b a question with no answer is listed once, with how often it was asked; an answered one is not listed', !!un && un.count === 2 && !L.unanswered.some((e) => /how much does it cost/i.test(e.q)), L.unanswered);
    check('17c an answer needs a question, and words in at least one language', (await M.saveAnswer(sa, { q: '', answer: { en: 'Yes' } })).status === 400 && (await M.saveAnswer(sa, { q: 'Do you provide logo design?', answer: {} })).status === 400);
    const saved = await M.saveAnswer(sa, { q: 'Do you provide logo design?', answer: { en: 'Yes. Our team can make your logo. Please ask for a call.', te: '' , hi: '' }, keywords: 'logo, branding' });
    const ans = (saved.answers || [])[0];
    check('17d the answer is saved with words that find it (the question, its main words and the extra ones)', !!saved.ok && ans && ans.id === 'C1' && ans.keywords.includes('logo') && ans.keywords.includes('design') && ans.keywords.includes('branding') && ans.keywords.includes('do you provide logo design'), saved);
    L = await M.list(sa);
    check('17e once answered, the question leaves the list and the answer is on the team page', !L.unanswered.some((e) => /logo design/i.test(e.q)) && L.answers.length === 1);
    const vw = await M.publicView(mI.token);
    check('17f the client page gets the answer and its words, not who wrote it or the question behind it', vw.custom.length === 1 && vw.custom[0].id === 'C1' && vw.custom[0].answer.en.startsWith('Yes.') && !/by|fromQ|"q"/.test(JSON.stringify(vw.custom)), vw.custom);
    check('17g a question answered by an added answer is saved with its id (C1), not as unanswered', (await M.publicEvent(mI.token, { type: 'ask', q: 'logo design', faq: 'C1' })).ok === true && (await M.list(sa)).items.find((i) => i.id === mI.id).questions.slice(-1)[0].id === 'C1');
    // the server voice speaks a sentence of an added answer, and still nothing else
    process.env.AI_VOICE_TTS = 'vexyl'; Gw.engines = () => ({ tts: async () => Buffer.alloc(16000), ttsWide: async () => ({ pcm: Buffer.alloc(44100), rate: 22050 }) });
    const vOk = await Voice.speak('en', 'Yes.'); const vNo = await Voice.speak('en', 'Please read this other text.');
    check('17h the voice speaks a sentence of an added answer (and still refuses any other text)', !!vOk.wav && vNo.status === 404, { vOk: !!vOk.wav, vNo: vNo.status });
    Gw.engines = realEngines; if (keepTts === undefined) delete process.env.AI_VOICE_TTS; else process.env.AI_VOICE_TTS = keepTts;
    check('17i an answer can be removed', !!(await M.removeAnswer(sa, 'C1')).ok && (await M.list(sa)).answers.length === 0 && (await M.removeAnswer(sa, 'C1')).status === 404);

    // the CRM lead
    MG.send = async () => ({ ok: true });
    await M.publicEvent(mI.token, { type: 'handover', name: 'Ideas Client', phone: '9123456799', window: 'morning' });
    const leads = await CRMDB.all('SELECT * FROM "CrmLead" WHERE "source" = ?', 'Plans meeting');
    const lead = leads.find((l) => /Ideas Client/.test(l.company));
    const rowI = (await S0q(mI.id));
    check('18 a call request becomes a CRM lead (source "Plans meeting", Hot, owned by the person who made the link) and the meeting keeps its id', !!lead && lead.rating === 'Hot' && lead.ownerId === sa.id && /asked for a call/.test(lead.notes || '') && rowI && rowI.crmLeadId === lead.id, { lead: !!lead, leads: leads.length, crm: rowI && rowI.crmLeadId, owner: rowI && rowI.createdById });
    await M.publicEvent(mI.token, { type: 'choice', choice: 'growth', phone: '9123456799', window: 'asap' });
    const leads2 = (await CRMDB.all('SELECT "id" FROM "CrmLead" WHERE "source" = ?', 'Plans meeting')).filter((l) => l.id === lead.id);
    const acts = await CRMDB.all('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ?', lead.id);
    check('18b asking again does not make a second lead: it adds a note to the first', leads2.length === 1 && (await CRMDB.all('SELECT "id" FROM "CrmLead" WHERE "phone" = ?', '9123456799')).length === 1 && acts.length >= 1, { n: leads2.length, acts: acts.length });

    // the plans on WhatsApp, only by the client's tap
    const sent2 = [];
    MG.send = async (channel, o) => { sent2.push({ channel, to: o.to, text: o.text }); return { ok: true }; };
    const mS = (await M.create(sa, { name: 'ZZ Summary Test', language: 'te' })).meeting;
    const noNo = await M.publicEvent(mS.token, { type: 'summary' }, 'https://teamlink.test');
    const badNo = await M.publicEvent(mS.token, { type: 'summary', phone: '12' }, 'https://teamlink.test');
    check('19 the plans are not sent without a number, or to a wrong one', noNo.status === 400 && badNo.status === 400 && sent2.length === 0, { noNo, badNo });
    const okS = await M.publicEvent(mS.token, { type: 'summary', phone: '9123456782' }, 'https://teamlink.test');
    check('19b a tap sends ONE WhatsApp to that number, in the client\'s language, with the totals and the short link', okS.ok === true && sent2.length === 1 && sent2[0].to === '919123456782' && /₹4,719/.test(sent2[0].text) && /₹23,599/.test(sent2[0].text) && new RegExp(`https://teamlink.test/m/${mS.id}`).test(sent2[0].text) && /జీఎస్టీ/.test(sent2[0].text) && !/\n[^\n]*\n[^\n]*Reply STOP/.test('') , { okS, text: sent2[0] && sent2[0].text.slice(0, 80) });
    const again = await M.publicEvent(mS.token, { type: 'summary', phone: '9123456782' }, 'https://teamlink.test');
    check('19c tapping again within five minutes sends nothing more', again.ok === true && again.already === true && sent2.length === 1);
    MG.send = async () => ({ ok: false, error: 'down' });
    await S0run(mS.id);
    const failS = await M.publicEvent(mS.token, { type: 'summary', phone: '9123456782' }, 'https://teamlink.test');
    check('19d if WhatsApp cannot send, the client is told plainly and nothing is marked as sent', failS.status === 502 && /try again/i.test(failS.error || ''), failS);
    check('19e the plans text exists in all three languages with the same totals', ['en', 'te', 'hi'].every((l) => /4,719/.test(M.summaryText(l, 'Ravi', 'https://x/m/1')) && /11,799/.test(M.summaryText(l, '', 'https://x/m/1')) && /https:\/\/x\/m\/1/.test(M.summaryText(l, '', 'https://x/m/1'))));
    MG.send = realSend;
    for (const z of [mI, mS]) await M.remove(sa, z.id);

    // ---- exact call times: 30-minute slots, 9 am to 7 pm India time, Monday to Saturday, today and three more days, never sooner than 30 minutes, one list for the team ----
    const wed = Date.parse('2026-11-18T10:10:00+05:30'); const fri = Date.parse('2026-11-20T10:10:00+05:30');
    const sl = M.allowedSlots(wed);
    const dates = [...new Set(sl.map((z) => z.date))];
    check('20 the slots: from 11:00 today (30 minutes ahead of 10:10), to 18:30, then 9:00 to 18:30 on the next three days: 76 in all', sl[0].at === Date.parse('2026-11-18T11:00:00+05:30') && sl.length === 76 && dates.join() === '2026-11-18,2026-11-19,2026-11-20,2026-11-21' && sl.every((z) => z.min % 30 === 0 && z.min >= 540 && z.min <= 1110), { n: sl.length, first: new Date(sl[0].at).toISOString(), dates });
    check('20b Sunday has no slots (from Friday: Fri, Sat, Mon)', M.allowedSlots(fri).map((z) => z.date).filter((d, i, a) => a.indexOf(d) === i).join() === '2026-11-20,2026-11-21,2026-11-23');
    check('20c after hours nothing is offered for today (Wednesday 8 pm: tomorrow on)', M.allowedSlots(Date.parse('2026-11-18T20:00:00+05:30'))[0].date === '2026-11-19');
    check('20d a slot is written in India time', /Wed.*18.*Nov.*11:00\s?am/i.test(M.istText(Date.parse('2026-11-18T11:00:00+05:30'))), M.istText(Date.parse('2026-11-18T11:00:00+05:30')));

    const sentS = [];
    MG.send = async (channel, o) => { sentS.push({ channel, to: o.to, text: o.text }); return { ok: true }; };
    await M.saveAlert(sa, { on: true, phone: '8919239827' });
    const mA = (await M.create(sa, { name: 'ZZ Slot A', phone: '9123456811', language: 'en' })).meeting;
    const mB = (await M.create(sa, { name: 'ZZ Slot B', phone: '9123456812', language: 'en' })).meeting;
    const offA = await M.publicSlots(mA.token);
    const s1 = offA.days[0].slots[0].at; const s2 = offA.days[0].slots[1].at;
    check('21 a client is offered the free slots by day', offA.days.length >= 1 && offA.days.every((d) => d.slots.length > 0 && /^\d{4}-\d\d-\d\d$/.test(d.date)) && offA.tz === 'Asia/Kolkata' && (await M.publicSlots('nonsense')).status === 404);
    check('21b a time that is not on the list is refused', (await M.publicEvent(mA.token, { type: 'handover', name: 'A', phone: '9123456811', slot: s1 + 1000 })).status === 400 && (await M.publicEvent(mA.token, { type: 'handover', name: 'A', phone: '9123456811', slot: Date.now() })).status === 400);
    const bookA = await M.publicEvent(mA.token, { type: 'handover', name: 'Slot A', phone: '9123456811', slot: s1 });
    const rowA = (await M.list(sa)).items.find((i) => i.id === mA.id);
    check('22 booking a time saves it on the row (shown in India time) as the call time', bookA.ok === true && rowA.slotAt === s1 && rowA.callbackWindow === 'slot' && /\d/.test(rowA.slotText) && rowA.handoverAt > 0, rowA);
    check('22b the bell and the WhatsApp alert say the exact time, not a broad one', sentS.length >= 1 && sentS[sentS.length - 1].text.includes(M.istText(s1)) && !/as soon as possible|afternoon/.test(sentS[sentS.length - 1].text), sentS.map((z) => z.text.slice(0, 120)));
    const bell2 = await prisma.notification.findFirst({ where: { userId: saRow.id, title: { contains: 'Plans meeting: Slot A' } }, orderBy: { createdAt: 'desc' } });
    check('22c the owner\'s bell carries the time too', !!bell2 && bell2.message.includes(M.istText(s1)), bell2 && bell2.message);
    const offB = await M.publicSlots(mB.token);
    check('23 that slot is gone for the next client, but the client who holds it still sees it', !offB.days.some((d) => d.slots.some((z) => z.at === s1)) && (await M.publicSlots(mA.token)).days.some((d) => d.slots.some((z) => z.at === s1)));
    const clash = await M.publicEvent(mB.token, { type: 'handover', name: 'B', phone: '9123456812', slot: s1 });
    check('23b a second client asking for the same time is told it was just taken, and nothing of theirs is saved', clash.status === 409 && /just taken/.test(clash.error || '') && !(await M.list(sa)).items.find((i) => i.id === mB.id).handoverAt, clash);
    const bookB = await M.publicEvent(mB.token, { type: 'handover', name: 'Slot B', phone: '9123456812', slot: s2 });
    check('23c another time is fine', bookB.ok === true && (await M.list(sa)).items.find((i) => i.id === mB.id).slotAt === s2);
    const ctask = await CRMDB.all('SELECT * FROM "CrmTask" WHERE "title" LIKE ?', '%Slot A%');
    const istIso = new Date(s1 + 19800000).toISOString();
    check('24 the CRM gets a call follow-up at exactly that time (India time), with a reminder 15 minutes before', ctask.length === 1 && ctask[0].dueDate === istIso.slice(0, 10) && ctask[0].dueTime === istIso.slice(11, 16) && ctask[0].type === 'Call' && Number(ctask[0].remindBefore) === 15, ctask);
    // asking for a call "as soon as possible" afterwards gives the slot back
    await M.publicEvent(mA.token, { type: 'handover', name: 'Slot A', phone: '9123456811', window: 'asap' });
    const rowA2 = (await M.list(sa)).items.find((i) => i.id === mA.id);
    check('25 asking again for "as soon as possible" gives the slot back to the others', rowA2.slotAt === null && rowA2.callbackWindow === 'asap' && (await M.publicSlots(mB.token)).days.some((d) => d.slots.some((z) => z.at === s1)));
    // the reminder ten minutes before
    sentS.length = 0;
    await S0.run('UPDATE "OmniMkMeeting" SET slotAt = ?, slotRemindedAt = NULL WHERE id = ?', Date.now() + 5 * 60000, mB.id);
    const due1 = await M.runSlotReminders();
    const bell3 = await prisma.notification.findFirst({ where: { userId: saRow.id, title: { contains: 'Call due in' } }, orderBy: { createdAt: 'desc' } });
    check('26 ten minutes before a booked call the owner gets a bell and a WhatsApp, once', due1 === 1 && !!bell3 && /Slot B/.test(bell3.title) && sentS.length === 1 && /Call due in/.test(sentS[0].text) && (await M.runSlotReminders()) === 0, { due1, bell: bell3 && bell3.title, sent: sentS.length });
    await S0.run('UPDATE "OmniMkMeeting" SET slotAt = ?, slotRemindedAt = NULL, calledAt = ? WHERE id = ?', Date.now() + 4 * 60000, Date.now() + 1000, mB.id);
    check('26b a client who was already called is not reminded about', (await M.runSlotReminders()) === 0);
    check('26c a call more than ten minutes away is not reminded yet', await (async () => { await S0.run('UPDATE "OmniMkMeeting" SET slotAt = ?, slotRemindedAt = NULL, calledAt = NULL WHERE id = ?', Date.now() + 40 * 60000, mB.id); return (await M.runSlotReminders()) === 0; })());
    MG.send = realSend;
    for (const z of [mA, mB]) await M.remove(sa, z.id);

    // ---- the demo offered by itself: a NEW person writes to a ticked company number (or fills the website form about marketing) and is sent their own link; everything off until an Admin switches it on ----
    const OF = require(path.join(BACK, 'src/marketing/meetingOffer')); const WNm = require(path.join(BACK, 'src/utils/waNumbers')); const realGetRow = WNm.getRow;
    WNm.getRow = async (id) => ({ numDM: { id: 'numDM', label: 'Digital Marketing', active: true }, numOff: { id: 'numOff', label: 'Switched off', active: false } }[id] || null);
    const keepBase = process.env.APP_BASE_URL; process.env.APP_BASE_URL = 'https://teamlink.test';
    const sentO = [];
    MG.send = async (channel, o) => { sentO.push({ channel, ...o }); return { ok: true }; };
    const madeIds = [];
    const stranger = (n, text, extra) => ({ info: { channel: 'WhatsApp', from: `91900001${n}`, text, name: 'Anil Kumar', numberId: 'numDM', ...(extra || {}) }, out: { stored: false, stop: false, candidateId: null } });
    const enq = async (n, text, extra, out) => { const s = stranger(n, text, extra); return OF.onInbound(s.info, out || s.out); };
    const sources = async () => (await S0.q(`SELECT * FROM "OmniMkMeeting" WHERE source IN ('inbound', 'website') AND deletedAt IS NULL ORDER BY createdAt ASC`));

    const offer0 = (await M.list(sa)).offer;
    check('30 the automatic demo is OFF by default (no number ticked, website off)', offer0.on === false && offer0.website === false && offer0.numberIds.length === 0 && offer0.canEdit === true, offer0);
    check('30b a stranger writing while it is off gets nothing and makes no row', (await enq('1111', 'Hi, I need social media marketing')) === null && sentO.length === 0 && (await sources()).length === 0);
    check('30c only an Admin can switch it on', (await M.saveOffer({ id: 'x', name: 'Not Admin', role: 'EMPLOYEE' }, { on: true, numberIds: ['numDM'] })).status === 403);
    check('31 switching on with no number ticked, an unknown number or a switched-off number is refused in words', (await M.saveOffer(sa, { on: true, numberIds: [] })).status === 400 && (await M.saveOffer(sa, { on: true, numberIds: ['nope'] })).status === 400 && (await M.saveOffer(sa, { on: true, numberIds: ['numOff'] })).status === 409);
    delete process.env.APP_BASE_URL;
    check('31b without the site\'s own https address nothing can be switched on (a link could not be made)', (await M.saveOffer(sa, { on: true, numberIds: ['numDM'] })).status === 409);
    process.env.APP_BASE_URL = 'https://teamlink.test';
    const on1 = await M.saveOffer(sa, { on: true, numberIds: ['numDM'], website: false });
    check('31c an Admin ticks the Digital Marketing number and switches it on', !!on1.ok && on1.offer.on === true && on1.offer.numberIds.join() === 'numDM' && (await OF.handles('numDM')) === true && (await OF.handles('numOther')) === false && (await OF.handles(null)) === false, on1);

    const r1 = await enq('1111', 'Hi, I need social media marketing');
    const rows1 = await sources();
    check('32 a new person writing to the ticked number is sent ONE message from that number, in the 24-hour window (free text), with their own short link', r1 && r1.sent === true && sentO.length === 1 && sentO[0].kind === 'text' && sentO[0].numberId === 'numDM' && sentO[0].automatic === true && sentO[0].to === '+919000011111' && /^Hello Anil!/.test(sentO[0].text) && new RegExp(`https://teamlink.test/m/${r1.id}`).test(sentO[0].text) && /Reply STOP/.test(sentO[0].text), { r1, sent: sentO.map((z) => z.text && z.text.slice(0, 90)) });
    const rowO = rows1[0] || {};
    check('32b the row is made by TeamLink itself (source "inbound", no person as its maker), keeps their number, name and first words, and is marked sent', rows1.length === 1 && rowO.source === 'inbound' && !rowO.createdById && rowO.createdByName === 'WhatsApp (automatic)' && /9000011111$/.test(rowO.phone) && rowO.name === 'Anil Kumar' && /social media/.test(rowO.note || '') && S0.num(rowO.sentAt) > 0 && rowO.sentVia === 'whatsapp (automatic)', rowO);
    const bellO = await prisma.notification.findFirst({ where: { title: { contains: 'New WhatsApp enquiry' } }, orderBy: { createdAt: 'desc' } });
    check('32c the team\'s bell rings with who wrote', !!bellO && /Anil Kumar/.test(bellO.title + bellO.message), bellO && bellO.title);
    const listO = await M.list(sa);
    check('32d the Plans meeting page lists it (the page tells TeamLink-made ones by their "WhatsApp (automatic)" maker) and counts it in the last 30 days', !!listO.items.find((x) => x.id === r1.id && x.createdByName === 'WhatsApp (automatic)') && listO.offer.last30.offered === 1, listO.offer);
    madeIds.push(r1.id);

    check('33 the same person writing again gets nothing more (once in 30 days)', (await enq('1111', 'Hello? Are you there')) === null && sentO.length === 1 && (await sources()).length === 1);
    const before = sentO.length;
    check('33b a number that is not ticked, STOP, a person TeamLink already knows, a message waiting for review and a STOP flag all get nothing', (await enq('2222', 'Need marketing', { numberId: 'numElse' })) === null && (await enq('2222', 'STOP')) === null && (await enq('2222', 'marketing', {}, { stored: true, stop: false })) === null && (await enq('2222', 'marketing', {}, { stored: false, review: true })) === null && (await enq('2222', 'marketing', {}, { stored: false, stop: true })) === null && sentO.length === before && (await sources()).length === 1);
    const rTe = await enq('3333', 'నాకు సోషల్ మీడియా మార్కెటింగ్ కావాలి', { name: 'Ravi' });
    check('33c a message in Telugu is answered in Telugu (and Hindi in Hindi), and the row remembers the language', rTe && rTe.sent === true && /నమస్కారం Ravi గారు/.test(sentO[sentO.length - 1].text) && (await S0q(rTe.id)).language === 'te', sentO[sentO.length - 1].text.slice(0, 40));
    const rHi = await enq('4444', 'मुझे मार्केटिंग चाहिए', { name: 'Sunita' });
    check('33d Hindi too', rHi && rHi.sent === true && /नमस्ते Sunita जी/.test(sentO[sentO.length - 1].text) && (await S0q(rHi.id)).language === 'hi');
    madeIds.push(rTe.id, rHi.id);
    const both = await Promise.all([enq('5555', 'Hi'), enq('5555', 'I want marketing plans')]);
    check('33e two messages from the same new person arriving together make ONE offer', both.filter(Boolean).length === 1 && (await sources()).filter((x) => /9000015555$/.test(x.phone)).length === 1, both);
    madeIds.push(...both.filter(Boolean).map((x) => x.id));

    // when WhatsApp cannot send: the row stays (the team can send the link by hand) and says why
    MG.send = async () => ({ ok: false, error: 'WhatsApp is down' });
    const rBad = await enq('6666', 'marketing please');
    const badRow = await S0q(rBad.id);
    check('34 if WhatsApp cannot send, nothing is marked as sent and the row says why', rBad.sent === false && !badRow.sentAt && /not sent: WhatsApp is down/.test(badRow.note || ''), badRow);
    madeIds.push(rBad.id);
    MG.send = async (channel, o) => { sentO.push({ channel, ...o }); return { ok: true }; };

    // the client opens it, asks for a call: the same alerts and CRM lead as any link, owner = nobody (every Admin is told, everyone with alerts on is WhatsApped)
    const tokO = M.tokenOf(r1.id);
    sentO.length = 0;
    const askO = await M.publicEvent(tokO, { type: 'handover', name: 'Anil Kumar', phone: '9000011111', window: 'asap' });
    const crmO = (await CRMDB.all('SELECT * FROM "CrmLead" WHERE "source" = ?', 'Plans meeting')).find((l) => /Anil Kumar/.test(l.company));
    check('35 the person who got the offer can ask for a call: a Hot CRM lead is made and the alert goes to the people who switched alerts on', askO.ok === true && !!crmO && crmO.rating === 'Hot' && sentO.some((z) => z.to === '918919239827' || /8919239827/.test(String(z.to))), { askO, crm: !!crmO, sent: sentO.map((z) => z.to) });

    // the cap: at most 150 in 24 hours
    const capIds = []; for (let i = 0; i < 150; i += 1) capIds.push((await M.createOffered({ name: `cap ${i}`, phone: `9110${String(i).padStart(6, '0')}`, source: 'inbound' })).id);
    sentO.length = 0;
    check('36 after 150 demos in 24 hours nothing more is sent by itself', (await enq('7777', 'marketing')) === null && sentO.length === 0);
    for (const id of capIds) await S0.run('DELETE FROM "OmniMkMeeting" WHERE id = ?', id); // really gone (a removed row would still count toward the day\'s cap, on purpose)

    // the recruitment assistant stays quiet on a ticked number (omniwa/agent.js asks handles()); off = it answers again
    check('37 the ticked number is the one the job-seeker assistant stays quiet on, and only while the switch is on', (await OF.handles('numDM')) === true && (await M.saveOffer(sa, { on: false, numberIds: ['numDM'] })).offer.on === false && (await OF.handles('numDM')) === false && (await enq('8888', 'marketing')) === null);

    // website-form leads: only when the second switch is on, only a real mobile, only about marketing (not HRMS/ATS), only once
    await M.saveOffer(sa, { on: false, website: false, numberIds: ['numDM'] });
    const wlead = (extra) => ({ id: 'lead_x', company: 'Sita Boutique', contactName: 'Sita Rao', phone: '9000022222', notes: '', ownerId: null, ...(extra || {}) });
    sentO.length = 0;
    check('38 a website lead gets nothing while the website switch is off', (await OF.onWebsiteLead(wlead(), { text: 'I need instagram marketing and reels' })) === null && sentO.length === 0);
    const onW = await M.saveOffer(sa, { on: false, website: true, numberIds: ['numDM'] });
    check('38b switching only the website on works without ticking the WhatsApp enquiries', !!onW.ok && onW.offer.website === true && onW.offer.on === false && (await OF.handles('numDM')) === false, onW);
    check('38c a lead who wrote about the HR products, about nothing in our line, or with no real mobile number gets nothing', (await OF.onWebsiteLead(wlead(), { text: 'I need instagram marketing', products: 'HRMS' })) === null && (await OF.onWebsiteLead(wlead(), { text: 'Need an HRMS and payroll for 40 staff, also marketing' })) === null && (await OF.onWebsiteLead(wlead(), { text: 'Please call me about pricing' })) === null && (await OF.onWebsiteLead(wlead({ phone: '12345' }), { text: 'instagram marketing' })) === null && sentO.length === 0);
    const wl = await OF.onWebsiteLead(wlead(), { text: 'I need instagram marketing and reels' });
    const wRow = wl && (await S0q(wl.id));
    check('38d a lead who wrote about marketing is sent the invite by the approved template from the company number, and the row says "website"', wl && wl.sent === true && sentO.length === 1 && sentO[0].kind === 'bulk' && sentO[0].to === '919000022222' && new RegExp(`https://teamlink.test/m/${wl.id}`).test(sentO[0].text) && /Reply STOP/.test(sentO[0].text) && wRow.source === 'website' && wRow.createdByName === 'Website form' && S0.num(wRow.sentAt) > 0, { wl, sent: sentO.map((z) => ({ kind: z.kind, to: z.to })) });
    check('38e the same lead again gets nothing', (await OF.onWebsiteLead(wlead(), { text: 'instagram marketing again' })) === null && sentO.length === 1);
    madeIds.push(wl.id);
    const PD = require(path.join(BACK, 'src/crm/productDeals'));
    const noSend = { sendMail: async () => ({ ok: true }), sendWa: async () => ({ ok: true }) }; // the HR product demo must not really send from this test
    const skipPD = await PD.onNewLead({ id: 'lead_y', source: 'Website', company: 'Rao Studio', phone: '9000033333', notes: '' }, { text: 'I need instagram marketing and a logo' }, noSend);
    const keepPD = await PD.onNewLead({ id: 'lead_z', source: 'Website', company: 'Rao Staffing', phone: '9000044444', notes: '' }, { text: 'I need an HRMS and payroll' }, noSend);
    check('38f the HR product demo steps aside for that marketing lead (the plans demo goes instead) but not for a lead who asked about HR', !!skipPD && /plans demo goes instead/.test(skipPD.skip || '') && !(keepPD && /plans demo goes instead/.test(keepPD.skip || '')), { skipPD, keepPD });

    // clean up: switched off again, the test rows removed, the stand-ins put back
    await M.saveOffer(sa, { on: false, website: false, numberIds: [] });
    for (const id of madeIds) await M.remove(sa, id);
    check('39 everything is switched off again and the list is clean', ((await M.list(sa)).offer.on === false) && (await sources()).length === 0);
    WNm.getRow = realGetRow; MG.send = realSend; if (keepBase === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = keepBase;

    // removing
    const rm = await M.remove(sa, m.id);
    check('11 removing makes the link stop working and leave the list', !!rm.ok && (await M.publicView(m.token)).status === 404 && !(await M.list(sa)).items.find((x) => x.id === m.id), rm);
    check('11b an unknown id cannot be removed', (await M.remove(sa, 'ffffffffffffffff')).status === 404);
  } catch (e) { check('the test ran without an exception', false, e && e.message); console.error(String((e && e.stack) || e).split(String.fromCharCode(10)).filter((l) => /backend[\\/](src|scripts)/.test(l)).slice(0, 10).join(String.fromCharCode(10))); }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { await prisma.$disconnect(); fs.unlinkSync(TMP); } catch { /* the temp copy stays in the temp folder */ }
  process.exit(fail ? 1 : 0);
})();
