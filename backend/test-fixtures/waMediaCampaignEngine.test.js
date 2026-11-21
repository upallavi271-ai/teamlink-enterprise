// WhatsApp media campaign through the REAL campaign engine: create -> plan/preview -> send -> runner -> WhatsApp sender (sandbox) -> delivery status -> retry of failed only.
//   node backend/test-fixtures/waMediaCampaignEngine.test.js   (throw-away copy of prisma/sandbox.db; Meta is never called; every number below is fake)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-eng-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');

const S = require('../src/outreach/store');
const Contacts = require('../src/outreach/contacts');
const Seg = require('../src/outreach/segments');
const T = require('../src/outreach/templates');
const Camp = require('../src/outreach/campaigns');
const Run = require('../src/outreach/runner');
const CM = require('../src/outreach/campaignMedia');
const waMod = require('../src/utils/whatsappCloud');
const messaging = require('../src/utils/messaging');
const sharp = require('sharp');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const ok = (n) => { pass += 1; console.log(`PASS  ${n}`); };

(async () => {
  const real = await require('../src/db').user.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { id: true, name: true, role: true } }) || await require('../src/db').user.findFirst({ select: { id: true, name: true, role: true } });
  if (real) { admin.id = real.id; admin.name = real.name || admin.name; admin.role = real.role || admin.role; admin.atsRole = 'SUPER_ADMIN'; }
  // WhatsApp looks connected; the sender is the sandbox one (builds the Cloud API body, transmits nothing)
  const simCfg = { configured: true, phoneId: '100', wabaId: '', display: '+91 90000 00000', token: 't', appSecret: '', verifyToken: '', language: 'en', templates: { link: '', otp: '', bulk: 'tl_general' }, base: 'https://graph.facebook.com', testMode: true };
  waMod.legacyConfig = async () => simCfg; waMod.whatsappConfig = async () => simCfg;
  await S.putKey('outreach.settings', { master: true, emailTestMode: false, waDailyCap: 1000, waPerMinute: 600, internalHrMaySend: true });

  // three fake people who agreed to WhatsApp, in one internal group
  const people = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await Contacts.createManual(admin, { contactType: 'internal', name: `Media Tester ${i + 1}`, city: 'ZZMediaCity', phone: `+9190000001${10 + i}` }, { declared: true, source: 'test', evidence: 'test fixture', textVersion: 'v1' });
    assert.ok(r.contact, JSON.stringify(r)); people.push(r.contact);
  }
  const seg = await Seg.create(admin, { name: `ZZ media group ${Date.now().toString(36)}`, contactType: 'internal', rules: { cities: ['zzmediacity'] } });
  assert.ok(seg.segment, JSON.stringify(seg));
  // an approved WhatsApp template with a PICTURE header, one without a header, one with a VIDEO header
  const mkTpl = async (name, headerType, waName) => {
    const t = await T.create(admin, { name, channel: 'whatsapp', audience: 'internal', promotional: true, body: 'Hello {{name}}, our new offer is here. Reply STOP to opt out.', waTemplateName: waName, waLanguage: 'en', waApprovalStatus: 'approved', extra: { headerType, headerMedia: { name: 'sample' } } });
    assert.ok(t.template, JSON.stringify(t)); return t.template;
  };
  const tImg = await mkTpl(`ZZ offer picture ${Date.now().toString(36)}`, 'image', 'zz_offer_picture');
  const tTxt = await mkTpl(`ZZ offer text ${Date.now().toString(36)}`, 'none', 'zz_offer_text');
  const tVid = await mkTpl(`ZZ offer video ${Date.now().toString(36)}`, 'video', 'zz_offer_video');
  assert.equal(tImg.extra.headerType, 'image'); ok('the template keeps its picture header type');

  const png = await sharp({ create: { width: 48, height: 48, channels: 3, background: '#1d4ed8' } }).png().toBuffer();
  const up = await CM.upload(admin, png, 'image/png', 'offer.png'); assert.ok(up.ok);
  const base = { type: 'internal', channel: 'whatsapp', segmentIds: [seg.segment.id], name: 'ZZ media campaign' };

  // ---- the rules, through the engine ----
  const noFile = await Camp.plan(admin, { ...base, templateId: tImg.id });
  assert.ok(noFile.error && /picture header/.test(noFile.error) && noFile.code === 'media_missing'); ok('a template with a picture header and no picture is refused (Meta would reject every message)');
  const wrongHdr = await Camp.plan(admin, { ...base, templateId: tVid.id, media: { id: up.media.id, mode: 'template' } });
  assert.ok(wrongHdr.error && /video header/.test(wrongHdr.error)); ok('a picture with a video-header template is refused');
  const noHdr = await Camp.plan(admin, { ...base, templateId: tTxt.id, media: { id: up.media.id, mode: 'template' } });
  assert.ok(noHdr.error && /no picture header/.test(noHdr.error)); ok('a picture with a text-only template is refused');
  const textOnly = await Camp.plan(admin, { ...base, templateId: tTxt.id });
  assert.ok(textOnly.ok && !textOnly.preview.media && /Hello Anita|Hello/.test(textOnly.preview.body)); ok('an existing TEXT campaign plans exactly as before (no media)');

  // ---- preview ----
  const plan = await Camp.plan(admin, { ...base, templateId: tImg.id, media: { id: up.media.id, mode: 'template' } });
  assert.ok(plan.ok, JSON.stringify(plan));
  console.log('plan', plan.people, plan.willGet, JSON.stringify(plan.reasons)); assert.equal(plan.preview.media.kind, 'image'); assert.equal(plan.preview.media.name, 'offer.png'); assert.ok(/Hello/.test(plan.preview.body)); assert.equal(plan.willGet, 3); ok('the plan carries the picture + the template words for the phone preview, 3 people will get it');

  // ---- create + send + run ----
  const made = await Camp.create(admin, { ...base, templateId: tImg.id, media: { id: up.media.id, mode: 'template' } });
  assert.ok(made.id || made.campaign, JSON.stringify(made));
  const cid = made.id || made.campaign.id;
  const view = (await Camp.get(admin, cid)).campaign;
  assert.equal(view.media.id, up.media.id); ok('the campaign keeps its media block');
  const sent = []; const failFor = new Set();
  const messageSender = async (channel, opts) => {
    const num = String(opts.to);
    if (failFor.has(num)) { const fres = { ok: false, outcome: 'Failed', error: 'WhatsApp HTTP 400: (#131026) Message undeliverable', transient: false }; sent.push({ opts, res: fres }); return fres; }
    const res = await messaging.send(channel, opts); sent.push({ opts, res });
    return res;
  };
  const started = await Camp.send(admin, cid, { when: 'now' });
  assert.ok(!started.error, JSON.stringify(started));
  // make the SECOND person fail so a retry has something to do (a real refusal from Meta)
  const contacts = await S.q('SELECT id, phoneE164 FROM "OutreachContact" WHERE id IN (?,?,?)', ...people);
  const second = contacts.find((c) => c.id === people[1]); failFor.add(String(second.phoneE164));
  for (let i = 0; i < 6; i += 1) { await Run.tick({ ignoreSwitch: true, messageSender, maxMessages: 10 }); await sleep(50); }
  const msgs = await S.q('SELECT status, providerRef, error, contactId FROM "OutreachMessage" WHERE campaignId = ?', cid);
  const good = msgs.filter((m) => m.status === 'sent'); const bad = msgs.filter((m) => m.status === 'failed');
  assert.equal(good.length, 2, JSON.stringify(msgs)); assert.equal(bad.length, 1); ok('2 sent, 1 failed (Meta refused it)');
  assert.ok(good.every((m) => /^sandbox-wa-/.test(m.providerRef))); assert.ok(bad[0].error && /131026/.test(bad[0].error)); ok('the Meta message id is stored for sent ones and the Meta error for the failed one');
  const wa = sent.filter((x) => x.res && x.res.ok);
  assert.equal(wa.length, 2);
  const body = wa[0].res.payload;
  assert.equal(body.type, 'template'); assert.equal(body.template.name, 'zz_offer_picture'); assert.equal(body.template.components[0].parameters[0].type, 'image'); ok('what went to WhatsApp is the approved template with the picture as its header');
  assert.equal(body.template.components.length, 2); assert.equal(body.template.components[1].parameters[0].text, 'Media'); ok('the {{name}} variable is filled per person');

  // ---- delivery / read reports ----
  const Ev = require('../src/outreach/events');
  const target = good[0];
  await Ev.applyDelivery({ providerRef: target.providerRef, event: 'delivered', at: Date.now() });
  await Ev.applyDelivery({ providerRef: target.providerRef, event: 'read', at: Date.now() });
  const dm = (await S.q('SELECT status, deliveredAt, readAt FROM "OutreachMessage" WHERE providerRef = ?', target.providerRef))[0];
  assert.ok(dm.status === 'delivered' && dm.deliveredAt && dm.readAt, JSON.stringify(dm)); ok('delivered and read reports are recorded against the message');


  // ---- retry: only the failed one goes again, the two sent ones are not repeated ----
  failFor.clear();
  const before = sent.filter((x) => x.res && x.res.ok).length;
  const re = await Camp.resendFailed(admin, cid);
  assert.equal(re.requeued, 1, JSON.stringify(re));
  for (let i = 0; i < 4; i += 1) { await Run.tick({ ignoreSwitch: true, messageSender, maxMessages: 10 }); await sleep(50); }
  const after = await S.q('SELECT status FROM "OutreachMessage" WHERE campaignId = ?', cid);
  assert.equal(after.filter((m) => ['sent', 'delivered'].includes(m.status)).length, 3); assert.equal(sent.filter((x) => x.res && x.res.ok).length, before + 1); ok('retry sent ONLY the failed message; the two already sent were not sent again');

  await Ev.applyDelivery({ providerRef: good[1].providerRef, event: 'failed', code: '131047', text: 'Re-engagement message', at: Date.now() });
  const fm = (await S.q('SELECT status, error FROM "OutreachMessage" WHERE providerRef = ?', good[1].providerRef))[0];
  assert.ok(fm.status === 'failed' && /131047/.test(fm.error), JSON.stringify(fm)); ok('a failed report from Meta keeps the Meta error code and words');

  // ---- caption mode: a free message needs people inside the 24 hours ----
  const up2 = await CM.upload(admin, Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n'), 'application/pdf', 'brochure.pdf');
  const cp = await Camp.plan(admin, { ...base, media: { id: up2.media.id, mode: 'caption', caption: 'Hi {{name}}, our brochure' } });
  assert.ok(cp.ok && /^Hi (Media|Anita), our brochure$/.test(cp.preview.body) && cp.preview.media.kind === 'document'); ok('a caption-mode document campaign needs no template and previews with its caption');
  const made2 = await Camp.create(admin, { ...base, name: 'ZZ caption campaign', media: { id: up2.media.id, mode: 'caption', caption: 'Hi {{name}}, our brochure' } });
  assert.ok(made2.id || made2.campaign, JSON.stringify(made2));
  const cid2 = made2.id || made2.campaign.id;
  assert.ok(!(await Camp.send(admin, cid2, { when: 'now' })).error);
  const sent2 = []; const sender2 = async (c, o) => { const r = await messaging.send(c, o); sent2.push(r); return r; };
  for (let i = 0; i < 4; i += 1) { await Run.tick({ ignoreSwitch: true, messageSender: sender2, maxMessages: 10 }); await sleep(50); }
  const m2 = await S.q('SELECT status, error FROM "OutreachMessage" WHERE campaignId = ?', cid2);
  assert.ok(m2.every((m) => m.status === 'failed') && m2.every((m) => /24 hours/.test(m.error || '')), JSON.stringify(m2)); ok('outside the 24 hours the free caption message is NOT sent: failed with the Meta rule in plain words (retry works once they write to you)');

  console.log(`\n${pass} checks passed`);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* the database file may still be open */ }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
