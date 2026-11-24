// "Create from your content" posts as professional banners: the server designs the showcase banner and puts a free stock photo as its hero picture when words are given.
//   node backend/test-fixtures/mkBannerHero.test.js   (throw-away copy of prisma/sandbox.db; the stock source is a stub)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ban-hero-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
const sharp = require('sharp');
const Stock = require('../src/marketing/stockclips');
const Img = require('../src/marketing/images');
const AS = require('../src/marketing/autostudio');
const P = require('../src/marketing/projects');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  await Img.ensure();
  const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#d94f70' } }).jpeg().toBuffer();
  const asked = []; Stock.photo = async (u, q) => { asked.push(q); return { buf: photo, mime: 'image/jpeg' }; };
  const spec = { headline: 'Healthy skin starts', headline2: 'with small habits', size: '1:1', layout: 'showcase', services: ['Acne and pimples', 'Hair fall and dandruff', 'Skin allergies'], servicesTitle: 'What we cover', audienceTitle: 'Who it is for:', audience: 'people who care about their skin', chip: 'drrao.in', companyName: 'Dr Rao Skin Clinic' };
  const plain = await Img.createBanner(admin, spec);
  assert.ok(plain.item, JSON.stringify(plain)); assert.equal(asked.length, 0); console.log('PASS  a showcase banner is designed from the words, icons and who-it-is-for (no search without words)');
  const hero = await Img.createBanner(admin, { ...spec, heroSearch: 'dermatologist clinic', heroN: 2 });
  assert.ok(hero.item); assert.equal(asked.length, 1); assert.equal(asked[0].q, 'dermatologist clinic'); assert.equal(asked[0].n, 2); assert.equal(asked[0].shape, 'portrait'); console.log('PASS  with words for a hero picture, a free stock photo is asked for (square = portrait crop, the n-th result)');
  assert.notEqual(hero.item.bytes, plain.item.bytes); console.log('PASS  the banner with the photo is a different picture from the one without');
  Stock.photo = async () => ({ error: 'No photo', status: 404 });
  const none = await Img.createBanner(admin, { ...spec, heroSearch: 'nothing found' });
  assert.ok(none.item); console.log('PASS  when no photo is found the banner is still made (no hero picture)');
  assert.equal(hero.item.style, 'banner'); console.log('PASS  it is saved like any picture, as a banner');
  // the plan tells who it is for
  const pr = (await P.create(admin, { clientName: 'Dr Rao Skin Clinic', contactName: 'Dr Rao', contactPhone: '+919000000007', occasion: 'Skin care', brief: 'We are a dermatology clinic. Videos and posts for patients.', deliverable: 'both', accept: true })).project;
  const pl = await AS.plan(admin, { projectId: pr.id, kind: 'post', scenes: 2, prompt: 'Skin care tips for monsoon, for patients of our clinic' });
  assert.ok(pl.plan && /skin/i.test(pl.plan.audience), JSON.stringify(pl.plan && pl.plan.audience)); console.log('PASS  the plan carries who the post is for (read from the client)');
  assert.ok(/dermatolog|skin/i.test(pl.plan.heroArt) && /dermatologist/i.test(pl.plan.scenes[0].search)); console.log('PASS  a post for a skin clinic gets skin-clinic hero artwork words and skin-clinic photo words');
  const dr = (await P.create(admin, { clientName: 'Rao Hospital', contactName: 'Dr Rao', contactPhone: '+919000000008', occasion: 'Dental care', brief: 'We are a dental clinic. Posts for families about teeth.', deliverable: 'both', accept: true })).project;
  const dp = await AS.plan(admin, { projectId: dr.id, kind: 'post', scenes: 2, prompt: 'A healthy smile starts with daily care for our patients' });
  assert.ok(/dental/i.test(dp.plan.heroArt) && /dentist|teeth/i.test(dp.plan.scenes[0].search)); console.log('PASS  a dental clinic post gets dentist photos and dental artwork, not any clinic');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* db open */ }
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); setTimeout(() => process.exit(1), 200); });
