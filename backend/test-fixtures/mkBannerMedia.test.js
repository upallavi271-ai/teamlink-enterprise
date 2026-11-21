// AI Marketing banners and campaign media: a designed banner is made, approved, stored, offered to a campaign with a public link, counted when a campaign carries it.
//   node backend/test-fixtures/mkBannerMedia.test.js     (throw-away copy of prisma/sandbox.db; nothing real is touched)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ban-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
const S = require('../src/outreach/store');
const Img = require('../src/marketing/images');
const MU = require('../src/marketing/mediaUse');
const sharp = require('sharp');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  await Img.ensure(); await MU.ensure();
  // a banner is DESIGNED: the right size, a real PNG, saved as a draft banner
  const r = await Img.createBanner(admin, { headline: 'Diwali offer: 30% off all hiring plans', sub: 'Verified candidates, delivered faster', cta: 'Book a free demo', badge: '30% OFF', footer: 'www.example-teamlink.in | +91 90000 00000', size: '16:9', layout: 'bold' });
  assert.ok(r.item, JSON.stringify(r));
  const b = r.item;
  assert.equal(b.style, 'banner'); assert.equal(b.status, 'draft'); assert.equal(b.aspect, '16:9');
  const file = Img.rawFile(await Img.rawRow(b.id));
  const meta = await sharp(file.path).metadata();
  assert.equal(meta.width, 1920); assert.equal(meta.height, 1080); assert.equal(meta.format, 'png');
  // every size and layout works, with a picture inside too
  const pic = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2563eb' } }).png().toBuffer();
  const picId = S.newId('im'); fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', `${picId}.png`), pic);
  await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', picId, 'Product photo', 'p', 'photo', '4:3', `${picId}.png`, 'image/png', pic.length, 'approved', admin.id, admin.name, Date.now(), Date.now());
  for (const [size, layout, w, h] of [['1:1', 'split', 1080, 1080], ['4:5', 'overlay', 1080, 1350], ['9:16', 'offer', 1080, 1920], ['16:9', 'split', 1920, 1080]]) {
    const x = await Img.createBanner(admin, { headline: 'Festival sale', sub: 'Everything on offer', cta: 'Shop now', badge: '20% OFF', size, layout, photoItemId: picId });
    assert.ok(x.item, `${size}/${layout}: ${JSON.stringify(x)}`);
    const m = await sharp(Img.rawFile(await Img.rawRow(x.item.id)).path).metadata(); assert.equal(m.width, w); assert.equal(m.height, h);
  }
  assert.equal((await Img.createBanner(admin, { headline: '' })).status, 400);
  assert.equal((await Img.createBanner(admin, { headline: 'Uses a video', photoItemId: 'nope' })).status, 404);

  // not approved: NOT offered to a campaign. Approved: offered with a public https link
  const site = 'https://teamlink.example-site.test';
  assert.ok(!(await MU.approvedMedia(site)).some((x) => x.id === b.id), 'a draft banner is never offered');
  await S.run(`UPDATE "OmniMkImage" SET status = 'approved', decidedAt = ? WHERE id = ?`, Date.now(), b.id);
  const vid = S.newId('vid'); fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', `${vid}.mp4`), Buffer.from('00000018667479706d703432', 'hex'));
  await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', vid, 'Diwali video', 'p', 'video', '9:16', `${vid}.mp4`, 'video/mp4', 12, 'approved', admin.id, admin.name, Date.now(), Date.now());
  const clip = S.newId('clp'); await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', clip, 'Raw clip', 'p', 'clip', '9:16', `${clip}.mp4`, 'video/mp4', 12, 'approved', admin.id, admin.name, Date.now(), Date.now());
  const offered = await MU.approvedMedia(site);
  const ob = offered.find((x) => x.id === b.id); const ov = offered.find((x) => x.id === vid);
  assert.ok(ob && ov, 'the approved banner and video are offered');
  assert.equal(ob.kind, 'banner'); assert.equal(ov.kind, 'video'); assert.ok(!offered.some((x) => x.id === clip), 'raw clips are never offered');
  assert.match(ob.url, /^https:\/\/teamlink\.example-site\.test\/api\/mk-image\/.+\.png$/); assert.match(ob.jpegUrl, /\.jpg$/);
  assert.ok(ov.whatsappReady);
  // the public link serves the banner (signature checked)
  const sig = ob.url.split('/').pop().replace(/\.png$/, '');
  assert.ok(await Img.publicFile(b.id, sig, 'png'), 'the signed link works');
  assert.equal(await Img.publicFile(b.id, 'wrong', 'png'), null);
  // counted: a campaign carried the banner and the video to people
  assert.ok((await MU.recordUse({ itemIds: [b.id, vid], campaignId: 'cmp1', campaignName: 'Diwali blast', channel: 'whatsapp', recipients: 120 })).ok);
  await MU.recordUse({ itemIds: [b.id], campaignId: 'cmp2', campaignName: 'Diwali email', channel: 'email', recipients: 80 });
  await MU.recordUse({ itemIds: [b.id], campaignId: 'cmp2', campaignName: 'Diwali email', channel: 'email', recipients: 80 }); // the same campaign twice is one use
  const after = (await MU.approvedMedia(site)).find((x) => x.id === b.id);
  assert.deepEqual(after.uses, { campaigns: 2, recipients: 200 });
  assert.deepEqual(await MU.totals(), { items: 2, campaigns: 2, recipients: 320 });
  assert.deepEqual((await MU.countsFor([b.id]))[b.id], { campaigns: 2, recipients: 200 });
  console.log('mkBannerMedia: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
