// "Send email from TeamLink" on a video for the client: the client's email can be typed in the send box, is kept on the link, and the email carries the video + Approve / Reject links.
//   node backend/test-fixtures/mkReviewEmail.test.js   (throw-away copy of prisma/sandbox.db; the mailer is replaced by a recorder, nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-rev-mail-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });
const S = require('../src/outreach/store');
const CR = require('../src/marketing/clientReview');
const messaging = require('../src/utils/messaging');
const sent = [];
messaging.send = async (channel, opts) => { sent.push({ channel, opts }); return { ok: true, outcome: 'Sent', sandbox: true }; };
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  await require('../src/marketing/images').ensure(); await CR.ensure();
  const id = S.newId('im'); const file = `${id}.mp4`;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', file), Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(4096, 3)]));
  await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, 'Skin video', 'p', 'video', '9:16', file, 'video/mp4', 4100, 'draft', admin.id, admin.name, Date.now(), Date.now());
  const rev = await CR.create(admin, { kind: 'image', itemId: id, clientName: 'Mail Test Co', contactName: 'Ravi', contactPhone: '+919000000004', mode: 'decide', days: 7 });
  assert.ok(rev.review, JSON.stringify(rev));
  const base = 'https://example-teamlink.test';
  // no email on the link and none typed: the answer says so in plain words, nothing is sent
  const none = await CR.tell(admin, rev.review.id, { ways: ['email'] }, base);
  assert.ok(none.error && /email/i.test(none.error) && !sent.length); console.log('PASS  with no email on the link and none typed, nothing is sent and the words say why');
  // a wrong address is refused BEFORE it is saved
  const bad = await CR.tell(admin, rev.review.id, { ways: ['email'], email: 'not-an-email' }, base);
  assert.ok(bad.error && bad.status === 400 && !sent.length); console.log('PASS  a wrong email address is refused and not saved');
  // the typed address is used, kept on the link, and the video goes attached with Approve / Reject links
  const ok = await CR.tell(admin, rev.review.id, { ways: ['email'], email: 'ravi@clientcheck.in' }, base);
  assert.ok(ok.ok, JSON.stringify(ok)); const m = sent.find((x) => x.channel === 'Email'); assert.ok(m, 'an email was sent');
  assert.equal(m.opts.to, 'ravi@clientcheck.in'); console.log('PASS  the typed address gets the email');
  assert.ok(Array.isArray(m.opts.attachments) && m.opts.attachments.length === 1 && /\.mp4$/i.test(m.opts.attachments[0].filename)); console.log('PASS  the video itself is attached (not only a link)');
  assert.ok(/do=approve/.test(m.opts.text) && /do=reject/.test(m.opts.text)); console.log('PASS  the email has the Approve and Reject links');
  const saved = (await S.q('SELECT contactEmail FROM "OmniMkClientReview" WHERE id = ?', rev.review.id))[0];
  assert.equal(saved.contactEmail, 'ravi@clientcheck.in'); console.log('PASS  the address is kept on the link for next time');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* db open */ }
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); setTimeout(() => process.exit(1), 200); });
