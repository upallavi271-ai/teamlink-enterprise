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
fs.copyFileSync(SRC, TMP);
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${TMP.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TL_SANDBOX = process.env.TL_SANDBOX || '1';
const express = require(path.join(BACK, 'node_modules/express'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity } = require(path.join(BACK, 'src/utils/identity'));
const M = require(path.join(BACK, 'src/marketing/meeting'));

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

    // removing
    const rm = await M.remove(sa, m.id);
    check('11 removing makes the link stop working and leave the list', !!rm.ok && (await M.publicView(m.token)).status === 404 && !(await M.list(sa)).items.find((x) => x.id === m.id), rm);
    check('11b an unknown id cannot be removed', (await M.remove(sa, 'ffffffffffffffff')).status === 404);
  } catch (e) { check('the test ran without an exception', false, e && e.stack); }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { await prisma.$disconnect(); fs.unlinkSync(TMP); } catch { /* the temp copy stays in the temp folder */ }
  process.exit(fail ? 1 : 0);
})();
