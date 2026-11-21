// AI Marketing: a client request from "new" to approved / rejected, sent to the client as the REAL video / picture with Approve and Reject buttons (never a link-only message).
//   node backend/test-fixtures/mkApprovalFlow.test.js     (throw-away copy of prisma/sandbox.db + the sandbox senders: nothing real is sent; the number below is a fake)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-appr-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });

const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');
const AS = require('../src/marketing/approvalSend');
const messaging = require('../src/utils/messaging');
const delivery = require('../src/utils/messageDelivery');
const sharp = require('sharp');

const PHONE = '+919000000001'; // fake
const sent = []; // every message that would leave: what the tests read
const realSend = messaging.send;
messaging.send = async (channel, opts) => {
  // a file goes through the REAL WhatsApp media code (sandbox: built, not transmitted); plain text has no Meta keys in this copy, so it is simply reported as sent
  const res = channel === 'WhatsApp' && !(opts.media && opts.media.length) ? { ok: true, outcome: 'Sent', sandbox: true, provider: 'SANDBOX' } : await realSend(channel, opts); sent.push({ channel, opts, res }); return res; };
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };

async function makeItem(kind, title) {
  const id = S.newId('im'); const mime = kind === 'video' ? 'video/mp4' : 'image/png'; const file = `${id}.${kind === 'video' ? 'mp4' : 'png'}`;
  const dst = path.join(process.env.UPLOAD_DIR, 'mk-images', file);
  if (kind === 'video') fs.writeFileSync(dst, Buffer.from('00000018667479706d703432', 'hex')); // a tiny MP4 header: enough for the sandbox sender
  else await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0a8f4d' } }).png().toFile(dst);
  await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, title, 'p', 'photo', '16:9', file, mime, 100, 'draft', admin.id, admin.name, Date.now(), Date.now());
  return id;
}
const waSent = () => sent.filter((x) => x.channel === 'WhatsApp' && x.res && x.res.ok); // only what really went (a refused try, like a file outside the 24 hours, is not a message)
const mailSent = () => sent.filter((x) => x.channel === 'Email');

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  await require('../src/marketing/images').ensure(); await AS.ensure();
  // WhatsApp must look connected to the sandbox sender
  const waMod = require('../src/utils/whatsappCloud');
  const fakeCfg = { configured: true, phoneId: '100', wabaId: '', display: '+91 90000 00000', token: 't', appSecret: '', verifyToken: '', language: 'en', templates: { link: '', otp: '', bulk: 'tl_general' }, base: 'https://graph.facebook.com', testMode: false, problems: [] };
  waMod.legacyConfig = async () => fakeCfg; waMod.whatsappConfig = async () => fakeCfg; // the copy has no WhatsApp keys: a connected-looking number, still only the sandbox sender

  // ---- one project, two options (a video and a picture), sent while the client's 24 hours are CLOSED ----
  const mk = async (b = {}) => { const r = await P.create(admin, { clientName: 'Approval Test Co', contactName: 'Ravi Kumar', contactPhone: PHONE, contactEmail: 'ravi@clientcheck.in', occasion: 'Diwali', brief: 'A Diwali video with our logo', deliverable: 'both', accept: true, ...b }); assert.ok(r.project, JSON.stringify(r)); return r.project; };
  let p = await mk();
  const vid = await makeItem('video', 'Diwali video'); const pic = await makeItem('image', 'Diwali picture');
  assert.ok((await P.setOptions(admin, p.id, { items: [{ itemId: vid }, { itemId: pic }] })).ok);
  let r1 = await P.send(admin, p.id, { ways: ['whatsapp', 'email'] }, 'https://example-teamlink.test');
  assert.ok(r1.ok, JSON.stringify(r1));

  // 1. NO message to the client is only a link: the WhatsApp ones carry no URL, the email has the files attached
  for (const m of waSent()) assert.ok(!/https?:\/\//i.test(String(m.opts.text || '')), `a WhatsApp message carries a link: ${m.opts.text}`);
  const held = waSent().find((x) => x.opts.kind === 'bulk');
  assert.ok(held, 'outside the 24 hours a short note (no link) goes first');
  assert.ok(/reply yes/i.test(held.opts.text));
  assert.equal(waSent().filter((x) => x.opts.media && x.opts.media.length).length, 0, 'the files wait for the reply when the window is closed and no template is set');
  const mail = mailSent()[0];
  assert.ok(mail && mail.opts.attachments && mail.opts.attachments.length === 2, 'the email carries both files as attachments');
  assert.match(mail.opts.text, /APPROVE: https:\/\/example-teamlink\.test\/client-project\/.+\?o=.+&do=approve/);
  assert.match(mail.opts.html, />Approve</); assert.match(mail.opts.html, />Reject</);
  assert.equal((await P.get(admin, p.id)).project.stage, 'sent');

  // 2. the client replies "YES": the window opens, the video and the picture go as media with Approve / Reject buttons
  sent.length = 0;
  await delivery.applyInbound({ channel: 'WhatsApp', from: PHONE.replace('+', ''), text: 'YES', id: `wamid.${Date.now()}`, at: new Date() });
  const hand = await AS.onInbound({ from: PHONE.replace('+', ''), text: 'YES', buttonId: '' });
  assert.ok(hand.handled, JSON.stringify(hand));
  const media = waSent().filter((x) => x.opts.media && x.opts.media.length);
  assert.equal(media.length, 2, `the two files go with buttons (got ${media.length})`);
  for (const m of media) {
    assert.equal(m.opts.buttons.length, 2); assert.deepEqual(m.opts.buttons.map((b) => b.title), ['Approve', 'Reject']);
    assert.ok(/^mkp\|a\|/.test(m.opts.buttons[0].id) && /^mkp\|r\|/.test(m.opts.buttons[1].id));
    assert.ok(!/https?:\/\//i.test(m.opts.text), 'no link in the caption');
    if (m.res.payload) { assert.equal(m.res.payload.type, 'interactive'); assert.ok(['video', 'image'].includes(m.res.payload.interactive.header.type)); assert.equal(m.res.payload.interactive.action.buttons.length, 2); }
  }
  assert.ok(media.some((m) => m.opts.media[0].mime === 'video/mp4') && media.some((m) => m.opts.media[0].mime === 'image/jpeg'), 'a real video and a real picture');
  const optA = media[0].opts.buttons[0].id.split('|')[2];

  // 3. a tap from a stranger's number does nothing; the client's Approve tap approves
  const stranger = await AS.onInbound({ from: '919000099999', text: '', buttonId: `mkp|a|${optA}` });
  assert.ok(/ignored/.test(stranger.note || ''));
  assert.equal((await P.get(admin, p.id)).project.stage, 'sent');
  await AS.onInbound({ from: PHONE.replace('+', ''), text: '', buttonId: `mkp|a|${optA}` });
  p = (await P.get(admin, p.id)).project;
  assert.equal(p.stage, 'approved'); assert.equal(p.clientAnswer, 'approved'); assert.equal(p.status, 'approved');
  assert.ok(waSent().some((x) => /recorded your approval/.test(x.opts.text || '')), 'the client gets a thank-you');

  // 4. ANOTHER project: two options, the client rejects one (the project stays with them), then the other with a reason that follows by text
  const p2 = await mk({ clientName: 'Reject Test Co' });
  const v2 = await makeItem('video', 'Second video'); const v3 = await makeItem('video', 'Third video');
  await P.setOptions(admin, p2.id, { items: [{ itemId: v2 }, { itemId: v3 }] });
  await P.send(admin, p2.id, { ways: ['whatsapp'] }, 'https://example-teamlink.test'); // window is open now: the files go straight away
  const direct = waSent().filter((x) => x.opts.media && x.opts.media.length && /^mkp\|/.test(x.opts.buttons[0].id));
  assert.ok(direct.length >= 2, 'inside the 24 hours the media goes at once');
  const ids2 = (await S.q('SELECT id FROM "OmniMkProjectOption" WHERE projectId = ? ORDER BY sortNo', p2.id)).map((x) => x.id);
  await AS.onInbound({ from: PHONE.replace('+', ''), text: '', buttonId: `mkp|r|${ids2[0]}` });
  assert.equal((await P.get(admin, p2.id)).project.stage, 'sent', 'one option rejected, one still with the client');
  await AS.onInbound({ from: PHONE.replace('+', ''), text: '', buttonId: `mkp|r|${ids2[1]}` });
  let q2 = (await P.get(admin, p2.id)).project;
  assert.equal(q2.stage, 'rejected'); assert.equal(q2.clientAnswer, 'rejected');
  assert.ok(waSent().some((x) => /few words on what you would like changed/.test(x.opts.text || '')), 'the client is asked for the reason');
  const why = await AS.onInbound({ from: PHONE.replace('+', ''), text: 'The logo is too small and use blue', buttonId: '' });
  assert.ok(why.handled);
  q2 = (await P.get(admin, p2.id)).project;
  assert.match(q2.clientAnswerNote, /logo is too small/); assert.equal(q2.stage, 'rejected');
  const tl = (await P.get(admin, p2.id)).events.map((e) => e.text).join(' | ');
  assert.match(tl, /Reason for the rejection/);

  // 5. the page / email Reject button needs a reason; Approve works through the page path too
  const p3 = await mk({ clientName: 'Page Test Co' });
  const v4 = await makeItem('image', 'Only picture');
  await P.setOptions(admin, p3.id, { items: [{ itemId: v4 }] }); await P.send(admin, p3.id, { ways: [] }, 'https://example-teamlink.test');
  const tok = P.tokenOf(p3.id); const opt3 = (await S.q('SELECT id FROM "OmniMkProjectOption" WHERE projectId = ?', p3.id))[0].id;
  assert.equal((await P.publicReject(tok, { optionId: opt3, name: 'Ravi', comment: '' })).status, 400);
  assert.ok((await P.publicReject(tok, { optionId: opt3, name: 'Ravi', comment: 'Please change the colours' })).ok);
  assert.equal((await P.get(admin, p3.id)).project.stage, 'rejected');
  // made again and sent again, then approved on the page
  await P.setOptions(admin, p3.id, { items: [{ itemId: await makeItem('image', 'Second try') }] }); await P.send(admin, p3.id, { ways: [] }, 'https://example-teamlink.test');
  const opt3b = (await S.q('SELECT id FROM "OmniMkProjectOption" WHERE projectId = ? AND round = 2', p3.id))[0].id;
  assert.ok((await P.clientApprove(tok, { optionId: opt3b, name: 'Ravi' })).ok);
  assert.equal((await P.get(admin, p3.id)).project.stage, 'approved');

  // 6. the media template path: outside the 24 hours with an approved "video to approve" template the file goes AS a template with a video header and two quick-reply buttons
  const CL = require('../src/channels/cloud');
  assert.equal(CL.modeOf('video/mp4'), 'video');
  const vf = path.join(process.env.UPLOAD_DIR, 'mk-images', 'tpl.mp4'); fs.writeFileSync(vf, Buffer.from('00000018667479706d703432', 'hex'));
  const base = { to: '+919000000002', text: 'Hello Ravi, here is your creative.', vars: ['Ravi', 'Diwali'], media: [{ path: vf, name: 'v.mp4', mime: 'video/mp4' }], buttons: [{ id: 'mkp|a|opt1', title: 'Approve' }, { id: 'mkp|r|opt1', title: 'Reject' }] };
  const closed = await CL.sendWithMedia(base);
  assert.equal(closed.code, 'WINDOW_CLOSED'); // a closed window and no template: nothing goes, and it says why
  const viaTpl = await CL.sendWithMedia({ ...base, mediaTemplate: { name: 'tl_approve', language: 'en' } });
  assert.ok(viaTpl.ok && viaTpl.viaTemplate, JSON.stringify(viaTpl));
  const tp = viaTpl.payload;
  assert.equal(tp.type, 'template'); assert.equal(tp.template.name, 'tl_approve');
  assert.equal(tp.template.components[0].type, 'header'); assert.equal(tp.template.components[0].parameters[0].type, 'video');
  const qr = tp.template.components.filter((c) => c.type === 'button');
  assert.equal(qr.length, 2); assert.equal(qr[0].sub_type, 'quick_reply'); assert.equal(qr[0].parameters[0].payload, 'mkp|a|opt1'); assert.equal(qr[1].parameters[0].payload, 'mkp|r|opt1');
  console.log('mkApprovalFlow: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
