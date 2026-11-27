// The rest of the Premium plan's services (2026-11-27): trusted listings, the by-hand AI answers check, doctor / staff profiles, and Facebook / Instagram Story posting.
//   node backend/test-fixtures/mkPremiumRest.test.js     (throw-away copy of prisma/sandbox.db; Facebook and Instagram are a local stand-in: nothing is posted anywhere)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-rest-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.MK_PUBLISH_POLL_MS = '20';
process.env.UPLOAD_DIR = path.join(work, 'uploads'); fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });
const express = require('express');
const S = require('../src/outreach/store');
const CS = require('../src/marketing/clientServices');
const Listings = require('../src/marketing/listings');
const AiA = require('../src/marketing/aiAnswers');
const Geo = require('../src/marketing/geoTools');
const Mrep = require('../src/marketing/monthlyReport');
const Cfg = require('../src/marketing/settings');
const SA = require('../src/utils/socialAccounts');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const stranger = { id: 'u-stranger', name: 'Other Team', role: 'EMPLOYEE', atsRole: 'RECRUITER', department: 'No Such Department' };
const SITE = 'https://example-teamlink.test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let graph; let api;

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  const month = CS.istMonth();
  const made = await CS.createPlan(admin, { clientName: 'Rest Test Clinic', plan: 'premium', months: 1, startDate: CS.istDay(), industry: 'Clinic' }); assert.ok(made.plan, JSON.stringify(made)); const planId = made.plan.id;
  let rep = await Mrep.build(admin, planId, month); assert.ok(!/Trusted listings|AI answers checked/.test(rep.report.text), 'nothing recorded: no new sections');

  // 1. trusted listings
  let v = await Listings.view(admin, { industry: 'clinic' }); const keys = v.places.map((p) => p.key);
  assert.ok(['google', 'justdial', 'practo', 'nmc'].every((k) => keys.includes(k)) && !keys.includes('clutch') && !keys.includes('nabh') && !keys.includes('indiamart'), keys.join(','));
  assert.ok((await Listings.view(admin, { industry: 'it' })).places.some((p) => p.key === 'clutch'));
  assert.ok((await Listings.view(admin, { industry: 'hospital' })).places.some((p) => p.key === 'nabh' && p.register));
  assert.ok(Listings.PLACES.every((p) => /^https:\/\//.test(p.url)) && new Set(Listings.PLACES.map((p) => p.key)).size === Listings.PLACES.length);
  assert.equal((await Listings.save(admin, { place: 'google', status: 'ok' })).status, 400); assert.equal((await Listings.save(admin, { clientName: 'Rest Test Clinic', place: 'nope', status: 'ok' })).status, 400);
  assert.equal((await Listings.save(admin, { clientName: 'Rest Test Clinic', place: 'google', status: 'maybe' })).status, 400); assert.equal((await Listings.save(admin, { clientName: 'Rest Test Clinic', place: 'google', status: 'ok', url: 'javascript:alert(1)' })).status, 400);
  assert.ok((await Listings.save(admin, { clientName: 'Rest Test Clinic', place: 'google', status: 'ok', url: 'https://maps.example/x', department: 'Medical' })).ok);
  assert.ok((await Listings.save(admin, { clientName: 'rest test clinic ', place: 'justdial', status: 'wrong', note: 'old phone' })).ok); assert.ok((await Listings.save(admin, { clientName: 'Rest Test Clinic', place: 'practo', status: 'not' })).ok); assert.ok((await Listings.save(admin, { clientName: 'Rest Test Clinic', place: 'nmc', status: 'na' })).ok);
  assert.ok((await Listings.save(admin, { clientName: 'Rest Test Clinic', place: 'practo', status: 'not', note: 'again' })).ok, 'saving again updates the same row');
  assert.equal(S.num((await S.q('SELECT COUNT(*) AS n FROM "OmniMkListing"'))[0].n), 4);
  assert.equal((await Listings.save(stranger, { clientName: 'Rest Test Clinic', place: 'google', status: 'not' })).status, 403, 'another department cannot change it');
  v = await Listings.view(admin, { clientName: 'Rest Test Clinic', industry: 'clinic' }); assert.deepEqual([v.counts.checked, v.counts.same, v.counts.wrong, v.counts.missing], [3, ['Google Business Profile'], ['Justdial'], ['Practo']]);
  assert.equal(v.places.find((p) => p.key === 'google').url, 'https://maps.example/x');
  console.log('PASS trusted listings: the right places per kind of business, ticks saved once per place, bad input and other departments refused, counts');

  // 2. AI answers, checked by a person
  assert.equal(AiA.questions({ name: 'X' }).status, 400);
  const q = AiA.questions({ name: 'Rest Test Clinic', industry: 'clinic', city: 'Hyderabad', specialty: 'dental', services: 'root canal, dental implants' });
  assert.deepEqual(q.questions, ['Can you suggest a good dental clinic in Hyderabad?', 'Where can I get root canal treatment in Hyderabad?', 'Where can I get dental implants treatment in Hyderabad?', 'What do you know about Rest Test Clinic in Hyderabad?']);
  assert.ok(!AiA.questions({ name: 'N', industry: 'it', city: 'C' }).questions.some((x) => /\{/.test(x)), 'a question with a missing fact is left out');
  let c = AiA.check({ name: 'Rest Test Clinic', website: 'https://www.resttest.in/', phone: '+91 98765 43210', text: '1. Other Dental\n2. **Rest Test Clinic** (resttest.in), call 98765-43210.' }); assert.deepEqual(c, { named: true, site: true, phone: true });
  c = AiA.check({ name: 'Rest Test Clinic', website: 'resttest.in', phone: '9876543210', text: 'Try Best Test Clinics at myresttest.in or resttest.income.com' }); assert.deepEqual(c, { named: false, site: false, phone: false });
  assert.equal(AiA.check({ name: 'N', text: ' ' }).status, 400);
  assert.equal((await AiA.save(admin, { clientName: 'Rest Test Clinic', engine: 'chatgpt', question: 'Q' })).status, 400, 'named yes or no is needed');
  assert.equal((await AiA.save(admin, { clientName: 'Rest Test Clinic', engine: 'siri', question: 'Q', named: true })).status, 400);
  const one = await AiA.save(admin, { clientName: 'Rest Test Clinic', engine: 'chatgpt', question: q.questions[0], named: false, others: 'Other Dental, Smile Care', text: 'THE PASTED ANSWER' }); assert.ok(one.ok);
  assert.ok((await AiA.save(admin, { clientName: 'Rest Test Clinic', engine: 'gemini', question: q.questions[0], named: true, site: true, others: 'Smile Care' })).ok);
  const raw = JSON.stringify(await S.q('SELECT * FROM "OmniMkAiAnswer"'), (k, val) => (typeof val === 'bigint' ? Number(val) : val)); assert.ok(!/THE PASTED ANSWER/.test(raw), 'the pasted words are not saved');
  let l = await AiA.list(admin, { clientName: 'Rest Test Clinic', month }); assert.deepEqual([l.counts.asked, l.counts.named, l.counts.site, l.counts.others], [2, 1, 1, ['Smile Care', 'Other Dental']]);
  assert.equal((await AiA.list(admin, { clientName: 'Rest Test Clinic', month: '2020-01' })).items.length, 0);
  assert.equal((await AiA.remove(stranger, 'nope')).status, 404);
  console.log('PASS AI answers: questions from real facts, pasted answers matched by plain text and not saved, results counted per month');

  // 3. the monthly report carries both
  rep = await Mrep.build(admin, planId, month); const t = rep.report.text;
  assert.ok(t.includes('- Business named in the answer: 1 of 2') && t.includes('- Named in ChatGPT: 0 of 1') && t.includes('- Listed with wrong details: Justdial') && t.includes('- Not there yet: Practo'), t);
  assert.ok(rep.report.improve.includes('Correct the business details on: Justdial.') && rep.report.improve.some((x) => /named in 1 of 2 AI answers/.test(x)), rep.report.improve.join(' | '));
  assert.ok(rep.report.html.includes('not a ranking'));
  assert.ok((await AiA.remove(admin, one.id)).ok); assert.equal((await AiA.list(admin, { clientName: 'Rest Test Clinic', month })).items.length, 1);
  console.log('PASS monthly report: AI answers and listings with what to do next');

  // 4. doctor / staff profile
  assert.equal(Geo.profile({}).status, 400);
  const p = Geo.profile({ kind: 'doctor', name: 'Dr. Asha Rao', qualification: 'MBBS, MD', regNo: 'TSMC-12345', council: 'Telangana State Medical Council', specialty: 'Dermatology', services: 'acne, hair loss', languages: 'Telugu, English', place: 'Rest Test Clinic', since: '2012', profileUrl: 'https://resttest.in/asha', about: 'I see adults and children.</script><script>alert(1)</script>' });
  assert.ok(p.text.startsWith('Dr. Asha Rao, MBBS, MD') && p.text.includes('Consults for acne and hair loss.') && p.text.includes('Speaks Telugu and English.') && p.text.includes('Registration number: TSMC-12345 (Telangana State Medical Council).') && !/<script/i.test(p.text), p.text);
  assert.equal(p.schema['@type'], 'Person'); assert.equal(p.schema.hasCredential.length, 2); assert.equal(p.schema.identifier.value, 'TSMC-12345'); assert.equal(p.script.match(/<\/script>/g).length, 1, 'the schema block cannot be broken out of'); assert.deepEqual(p.missing, []);
  const bad = Geo.profile({ kind: 'doctor', name: 'Dr. X', about: 'The best doctor, 100% cure guaranteed.' }); assert.ok(bad.warnings.length && bad.missing.includes('registration number'), JSON.stringify(bad.warnings));
  const staff = Geo.profile({ kind: 'professional', name: 'Ravi', role: 'Accountant' }); assert.ok(staff.text.includes('Ravi is an Accountant.') && !staff.missing.includes('registration number') && !/doctor/i.test(staff.text + staff.note));
  console.log('PASS profiles: only typed facts, Person schema, risky words flagged, safe to paste');

  // 5. Stories: Facebook and Instagram stand-in
  const seen = [];
  const fake = express(); fake.use(express.urlencoded({ extended: false }));
  fake.all(/.*/, (req, res) => {
    const p2 = req.path.replace(/^\/g\//, ''); seen.push({ m: req.method, p: p2, body: { ...(req.body || {}) }, auth: req.headers.authorization, fileUrl: req.headers.file_url });
    if (p2 === 'PAGE1/photos') return res.json({ id: 'ph1' }); if (p2 === 'PAGE1/photo_stories') return res.json({ success: true, post_id: 'st1' });
    if (p2 === 'PAGE1/video_stories') return res.json(req.body.upload_phase === 'start' ? { video_id: 'v1', upload_url: `http://127.0.0.1:${graph.address().port}/up/v1` } : { success: true, post_id: 'st2' });
    if (p2 === 'PAGE2/video_stories') return res.json({ video_id: 'v2', upload_url: 'https://evil.example/upload' });
    if (p2 === '/up/v1') return res.json({ success: true }); if (p2 === 'v1') return res.json({ status: { video_status: 'ready', uploading_phase: { status: 'complete' } } });
    if (p2 === 'IG1/media') return res.json({ id: 'c1' }); if (p2 === 'c1') return res.json({ status_code: 'FINISHED' }); if (p2 === 'IG1/media_publish') return res.json({ id: 'm1' }); if (p2 === 'm1') return res.json({ permalink: 'https://instagram.example/s/1' });
    return res.status(404).json({ error: { message: `unexpected ${p2}` } });
  });
  graph = await new Promise((ok) => { const s = fake.listen(0, '127.0.0.1', () => ok(s)); }); process.env.TL_FACEBOOK_GRAPH_BASE = `http://127.0.0.1:${graph.address().port}/g`;
  const ACC = { fb1: ['facebook', 'PAGE1'], fb2: ['facebook', 'PAGE2'], ig1: ['instagram', 'IG1'], x1: ['x', 'X1'] };
  SA.withToken = async (id) => (ACC[id] ? { account: { platform: ACC[id][0], externalId: ACC[id][1], name: `Account ${id}` }, token: 'secret-token' } : null);
  const Pub = require('../src/marketing/publisher');
  let r = await Pub.publish([{ accountId: 'fb1' }, { accountId: 'ig1' }, { accountId: 'x1' }], { type: 'image', story: true, url: `${SITE}/p.png`, jpgUrl: `${SITE}/p.jpg` }, 'words that must not go');
  assert.deepEqual(r.map((x) => x.ok), [true, true, false], JSON.stringify(r)); assert.match(r[2].error, /Facebook and Instagram only/);
  assert.deepEqual(seen.map((x) => x.p), ['PAGE1/photos', 'PAGE1/photo_stories', 'IG1/media', 'c1', 'IG1/media_publish', 'm1']);
  assert.equal(seen[0].body.published, 'false'); assert.equal(seen[1].body.photo_id, 'ph1'); assert.deepEqual(seen[2].body, { media_type: 'STORIES', image_url: `${SITE}/p.jpg` }); assert.ok(!JSON.stringify(seen).includes('words that must not go'));
  seen.length = 0; r = await Pub.publish([{ accountId: 'fb1' }, { accountId: 'ig1' }], { type: 'video', story: true, url: `${SITE}/v.mp4` }, '');
  assert.deepEqual(r.map((x) => x.ok), [true, true], JSON.stringify(r));
  const up = seen.find((x) => x.p === '/up/v1'); assert.ok(up && up.auth === 'OAuth secret-token' && up.fileUrl === `${SITE}/v.mp4`, JSON.stringify(up));
  assert.deepEqual(seen.filter((x) => x.p === 'PAGE1/video_stories').map((x) => x.body.upload_phase), ['start', 'finish']); assert.deepEqual(seen.find((x) => x.p === 'IG1/media').body, { media_type: 'STORIES', video_url: `${SITE}/v.mp4` });
  seen.length = 0; r = await Pub.publish([{ accountId: 'fb2' }], { type: 'video', story: true, url: `${SITE}/v.mp4` }, ''); assert.equal(r[0].ok, false); assert.match(r[0].error, /safe upload address/); assert.equal(seen.length, 1, 'the token never goes to another host');
  seen.length = 0; r = await Pub.publish([{ accountId: 'ig1' }], { type: 'image', url: `${SITE}/p.png`, jpgUrl: `${SITE}/p.jpg` }, 'hello'); assert.deepEqual(seen[0].body, { image_url: `${SITE}/p.jpg`, caption: 'hello' }, 'an ordinary post is as before');
  console.log('PASS Stories: Facebook picture and video, Instagram picture and video, no words, other platforms refused, token only to Meta');

  // 6. the Post window's server side
  await require('../src/marketing/images').ensure(); const PI = require('../src/marketing/postItem'); await PI.ensure();
  await Cfg.saveSettings({ ...(await Cfg.getSettings()), autoPostAllowed: true });
  const item = async (aspect) => { const id = S.newId('im'); fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', `${id}.png`), PNG); await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, 'story pic', 'p', 'photo', aspect, `${id}.png`, 'image/png', PNG.length, 'approved', admin.id, admin.name, Date.now(), Date.now()); return id; };
  const square = await item('1:1'); const tall = await item('9:16');
  let o = await PI.postItem(admin, square, { accountIds: ['ig1'], asStory: true, confirm: true }, SITE); assert.match(o.error, /tall/);
  o = await PI.postItem(admin, tall, { accountIds: ['ig1', 'x1'], asStory: true, confirm: true }, SITE); assert.match(o.error, /Facebook and Instagram only/);
  o = await PI.postItem(admin, tall, { accountIds: ['ig1'], asStory: true }, SITE); assert.equal(o.code, 'confirm');
  seen.length = 0; o = await PI.postItem(admin, tall, { accountIds: ['ig1'], caption: 'ignored', asStory: true, confirm: true }, SITE); assert.ok(o.posted && /Posted as a Story on Account ig1/.test(o.ok), JSON.stringify(o));
  assert.equal(seen[0].body.media_type, 'STORIES'); const hist = await PI.posts(admin, tall); assert.deepEqual([hist.posts[0].accountName, hist.posts[0].caption, hist.posts[0].ok], ['Account ig1 (Story)', '', true]);
  console.log('PASS Story from the Post window: tall only, Facebook / Instagram only, confirmed, recorded as a Story');

  // 7. the signed-in routes
  const appx = express(); appx.use(express.json()); appx.use((req, _res, next) => { req.user = admin; next(); }); appx.use('/m', require('../src/routes/omniGsMarketing'));
  api = await new Promise((ok) => { const s = appx.listen(0, '127.0.0.1', () => ok(s)); }); const A = `http://127.0.0.1:${api.address().port}/m/visibility`;
  const send = (m, u, body) => fetch(`${A}${u}`, { method: m, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await send('GET', '/listings?industry=clinic&clientName=Rest%20Test%20Clinic')).status, 200); assert.equal((await send('PUT', '/listings', { clientName: 'Route Co', place: 'bing', status: 'ok' })).status, 200);
  assert.equal((await send('POST', '/profile', { name: 'R' })).status, 200); assert.equal((await send('POST', '/ai-answers/questions', { name: 'R', city: 'C', services: 's' })).status, 200); assert.equal((await send('POST', '/ai-answers/check', { name: 'R', text: 'R' })).status, 200);
  const s1 = await (await send('POST', '/ai-answers', { clientName: 'Route Co', engine: 'google', question: 'Q', named: true })).json(); assert.ok(s1.ok);
  assert.equal((await (await send('GET', '/ai-answers?clientName=Route%20Co')).json()).items.length, 1); assert.equal((await send('DELETE', `/ai-answers/${s1.id}`)).status, 200);
  console.log('PASS routes: listings, profile and AI answers work behind the sign-in');
  graph.close(); api.close(); console.log('ALL PASS'); process.exit(0);
})().catch((e) => { console.error(e); if (graph) graph.close(); if (api) api.close(); process.exit(1); });
