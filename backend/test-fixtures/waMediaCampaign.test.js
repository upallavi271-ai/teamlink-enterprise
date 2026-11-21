// WhatsApp media campaigns: upload rules, template-header rules, the Cloud API bodies (picture / video / document, template header or free caption), media-id reuse.
//   node backend/test-fixtures/waMediaCampaign.test.js     (throw-away copy of prisma/sandbox.db; Meta is never called: its HTTP door is replaced by a recorder)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');

const CM = require('../src/outreach/campaignMedia');
const cloud = require('../src/channels/cloud');
const waMod = require('../src/utils/whatsappCloud');
const core = require('../src/utils/messagingCore');
const sharp = require('sharp');

const admin = { id: 'u-admin', name: 'Test Admin' };
const PHONE = '+919000000001'; // fake
const png = (w = 32) => sharp({ create: { width: w, height: w, channels: 3, background: '#0a8f4d' } }).png().toBuffer();
const mp4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(64)]);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  let pass = 0; const ok = (n) => { pass += 1; console.log(`PASS  ${n}`); };

  // ---- 1. upload rules (WhatsApp's own limits) ----
  const up1 = await CM.upload(admin, await png(), 'image/png', 'Diwali banner.png');
  assert.ok(up1.ok && up1.media.kind === 'image'); ok('a PNG banner uploads as a picture');
  const up2 = await CM.upload(admin, mp4, 'video/mp4', 'promo.mp4');
  assert.ok(up2.ok && up2.media.kind === 'video'); ok('an MP4 uploads as a video');
  const up3 = await CM.upload(admin, pdf, 'application/pdf', 'brochure.pdf');
  assert.ok(up3.ok && up3.media.kind === 'document'); ok('a PDF uploads as a document');
  const bad1 = await CM.upload(admin, Buffer.from('GIF89a......'), 'image/gif', 'x.gif');
  assert.ok(bad1.error && /not one of them/.test(bad1.error)); ok('a GIF is refused with plain words');
  const bad2 = await CM.upload(admin, Buffer.alloc(5 * 1024 * 1024 + 1, 1), 'image/jpeg', 'big.jpg');
  assert.ok(bad2.error && /at most 5 MB/.test(bad2.error) && bad2.status === 413); ok('a picture over 5 MB is refused');
  const bad3 = await CM.upload(admin, Buffer.alloc(16 * 1024 * 1024 + 1, 1), 'video/mp4', 'big.mp4');
  assert.ok(bad3.error && /at most 16 MB/.test(bad3.error)); ok('a video over 16 MB is refused');
  const bad4 = await CM.upload(admin, Buffer.from('this is not a png at all'), 'image/png', 'fake.png');
  assert.ok(bad4.error && /do not match/.test(bad4.error)); ok('a file whose bytes do not match its type is refused');
  const f1 = await CM.fileOf(up1.media.id);
  assert.ok(f1 && fs.existsSync(f1.path) && !f1.path.includes('..') && f1.path.startsWith(path.resolve(process.env.UPLOAD_DIR))); ok('the file is kept in the private upload folder');

  // ---- 2. template-header rules ----
  const tplImg = { extra: { headerType: 'image' } }; const tplVid = { extra: { headerType: 'video' } }; const tplTxt = { extra: { headerType: 'text' } };
  assert.ok((await CM.check(admin, { id: up1.media.id, mode: 'template' }, { channel: 'whatsapp', template: tplImg })).media); ok('picture + a template with a picture header is accepted');
  const e1 = await CM.check(admin, { id: up1.media.id, mode: 'template' }, { channel: 'whatsapp', template: tplVid });
  assert.ok(e1.error && /video header/.test(e1.error)); ok('picture + a video-header template is refused, saying which header it has');
  const e2 = await CM.check(admin, { id: up1.media.id, mode: 'template' }, { channel: 'whatsapp', template: tplTxt });
  assert.ok(e2.error && /no picture header/.test(e2.error)); ok('picture + a text-only template is refused');
  const e3 = await CM.check(admin, { id: up1.media.id, mode: 'template' }, { channel: 'sms', template: tplImg });
  assert.ok(e3.error && /only be sent on WhatsApp/.test(e3.error)); ok('media on SMS / email is refused');
  assert.deepEqual(await CM.check(admin, null, { channel: 'whatsapp' }), { media: null }); ok('a text campaign is untouched (no media block = nothing changes)');
  const cap = await CM.check(admin, { id: up3.media.id, mode: 'caption', caption: 'Our brochure' }, { channel: 'whatsapp', template: null });
  assert.ok(cap.media && cap.media.mode === 'caption' && cap.media.caption === 'Our brochure'); ok('a caption-mode document needs no template');

  // ---- 3. the Cloud API bodies (sandbox: built, not transmitted) ----
  const simCfg = { configured: true, phoneId: '100', wabaId: '', display: '+91 90000 00000', token: 't', appSecret: '', verifyToken: '', language: 'en', templates: { link: '', otp: '', bulk: 'tl_general' }, base: 'https://graph.facebook.com', testMode: true };
  waMod.legacyConfig = async () => simCfg; waMod.whatsappConfig = async () => simCfg;
  const base = { to: PHONE, kind: 'bulk', numberId: undefined };
  const file = (f) => [{ path: f.path, mime: f.mime, name: f.name }];
  const t1 = await cloud.sendWithMedia({ ...base, text: '', vars: [], media: file(f1), forceTemplate: true, mediaTemplate: { name: 'diwali_offer', language: 'en' } });
  assert.ok(t1.ok && t1.viaTemplate && t1.payload.type === 'template'); ok('a campaign picture goes through the approved template');
  const comps = t1.payload.template.components;
  assert.equal(comps[0].type, 'header'); assert.equal(comps[0].parameters[0].type, 'image'); assert.ok(comps[0].parameters[0].image.id);
  assert.ok(!comps.some((c) => c.type === 'body')); ok('the picture is the template HEADER parameter; a template with no variables gets no body parameters');
  const f3 = await CM.fileOf(up3.media.id);
  const t2 = await cloud.sendWithMedia({ ...base, text: '', vars: ['Anita'], media: file(f3), forceTemplate: true, mediaTemplate: { name: 'brochure_doc', language: 'en' } });
  assert.equal(t2.payload.template.components[0].parameters[0].document.filename, 'brochure.pdf'); assert.equal(t2.payload.template.components[1].parameters[0].text, 'Anita'); ok('a document header carries the file name; variables go to the body');
  const f2 = await CM.fileOf(up2.media.id);
  const t3 = await cloud.sendWithMedia({ ...base, text: '', vars: [], media: file(f2), forceTemplate: true, mediaTemplate: { name: 'promo_video', language: 'en' } });
  assert.equal(t3.payload.template.components[0].parameters[0].type, 'video'); ok('a video goes as a VIDEO header');
  // a free message with a caption is only for people inside the 24 hours: none of ours is
  const w1 = await cloud.sendWithMedia({ ...base, text: 'Hello Anita', media: file(f1) });
  assert.ok(!w1.ok && /24 hours/.test(w1.error)); ok('a free caption message outside the 24 hours is refused in plain words (Meta rule), nothing sent');
  const delivery = require('../src/utils/messageDelivery');
  const realOpen = delivery.windowOpen; delivery.windowOpen = async () => true;
  const w2 = await cloud.sendWithMedia({ ...base, text: 'Hello Anita', media: file(f1) });
  delivery.windowOpen = realOpen;
  assert.ok(w2.ok && w2.payload.type === 'image' && w2.payload.image.caption === 'Hello Anita'); ok('inside the 24 hours a picture goes as a picture with the caption under it');

  // ---- 4. the media id is uploaded ONCE per number and reused; an expired id is replaced ----
  const liveCfg = { ...simCfg, testMode: false, base: 'https://graph.example-meta.test' };
  waMod.legacyConfig = async () => liveCfg; waMod.whatsappConfig = async () => liveCfg;
  const realSimulated = waMod.simulated; waMod.simulated = () => false;
  const calls = []; let expireNext = false; let n = 0;
  const realHttp = core.httpJson; const realAcquire = core.acquire;
  core.acquire = async () => {};
  core.httpJson = async (url, opts) => {
    calls.push(url.endsWith('/media') ? 'upload' : 'message');
    if (url.endsWith('/media')) return { ok: true, status: 200, json: { id: `MEDIA_${(n += 1)}` } };
    const body = JSON.parse(opts.body);
    if (expireNext && /^MEDIA_1$/.test(JSON.stringify(body).match(/MEDIA_\d+/)[0])) { expireNext = false; return { ok: false, status: 400, json: { error: { code: 100, message: 'Media ID is invalid' } } }; }
    return { ok: true, status: 200, json: { messages: [{ id: `wamid.${calls.length}` }] } };
  };
  const cache = CM.waCache(up1.media.id);
  const send1 = () => cloud.sendWithMedia({ ...base, text: '', vars: [], media: file(f1), forceTemplate: true, mediaTemplate: { name: 'diwali_offer', language: 'en' }, mediaCache: cache });
  const a = await send1(); const b = await send1(); const c = await send1();
  assert.ok(a.ok && b.ok && c.ok); assert.deepEqual(calls, ['upload', 'message', 'message', 'message']); assert.equal(a.mediaReused, false); assert.equal(c.mediaReused, true); ok('three people, ONE upload to WhatsApp: the media id is reused');
  assert.notEqual(a.providerRef, b.providerRef); ok('every person gets their own Meta message id');
  calls.length = 0; expireNext = true;
  const d = await send1();
  assert.ok(d.ok && !d.mediaReused); assert.deepEqual(calls, ['message', 'upload', 'message']); ok('an expired media id is dropped and the file uploaded again, once');
  core.httpJson = realHttp; core.acquire = realAcquire; waMod.simulated = realSimulated;

  console.log(`\n${pass} checks passed`);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* the database file may still be open */ }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
