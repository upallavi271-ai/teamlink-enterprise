// AI Marketing: the first picture options made by themselves from a client's request (marketing/autocreate.js).
//   node backend/test-fixtures/mkAutoCreate.test.js     (throw-away copy of prisma/sandbox.db + the sandbox picture maker: no AI call leaves the machine, nothing real is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-auto-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });

const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');
const Cfg = require('../src/marketing/settings');
const AC = require('../src/marketing/autocreate');
const Img = require('../src/marketing/images');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const SITE = 'https://example-teamlink.test';
const setMode = async (autoMake) => Cfg.saveSettings({ ...(await Cfg.getSettings()), autoMake });
const kinds = async (id) => (await S.q('SELECT kind FROM "OmniMkProjectEvent" WHERE projectId = ? ORDER BY at ASC', id)).map((x) => x.kind);
const stateOf = async (id) => (await P.get(admin, id)).project;
// a request exactly as the client leaves it: no phone and no email, so nothing is ever sent from this test
const request = async (b = {}) => { const r = await P.create(admin, { clientName: 'Auto Test Co', occasion: 'Diwali offer', brief: 'A Diwali offer poster for our sweet shop, 20 percent off', deliverable: 'image', platforms: ['facebook'], ...b }); assert.ok(r.project, JSON.stringify(r)); return r.project; };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet
  await Img.ensure(); await P.ensure();
  const realCreate = Img.create;

  // 1. OFF (the default): nothing is made, the request waits for the team as before
  assert.equal((await Cfg.getSettings()).autoMake, 'off');
  let p = await request();
  assert.deepEqual(await AC.work(p.id), { skipped: 'off' });
  p = await stateOf(p.id); assert.equal(p.status, 'request'); assert.deepEqual(p.counts, { images: 0, videos: 0 });

  // 2. a value that is not one of the three is read as off
  await Cfg.saveSettings({ ...(await Cfg.getSettings()), autoMake: 'whatever' });
  assert.equal((await Cfg.getSettings()).autoMake, 'off');
  assert.equal(Cfg.cleanSettings({ autoMake: 'nonsense' }, await Cfg.getSettings()).value.autoMake, 'off');

  // 3. 'options': three pictures are made, the request is accepted, the pictures are the options and they WAIT for the team (nothing goes to the client)
  await setMode('options'); delete process.env.APP_BASE_URL;
  p = await request();
  const out = await AC.work(p.id);
  assert.equal(out.ok, true, JSON.stringify(out)); assert.equal(out.options, 3); assert.equal(out.sent, false);
  p = await stateOf(p.id);
  assert.equal(p.status, 'working'); assert.equal(p.counts.images, 3); assert.ok(p.ownerName, 'it has an owner once accepted');
  assert.equal(S.num((await S.q('SELECT COUNT(*) AS n FROM "OmniMkProjectOption" WHERE projectId = ? AND round = 1', p.id))[0].n), 3);
  const k = await kinds(p.id);
  assert.ok(k.includes('accepted') && k.includes('auto_made'), JSON.stringify(k));
  assert.ok(!k.includes('options_sent'), 'the options must not have gone to the client');

  // 4. 'send' with the site's https address: the options go to the client by themselves (state: waiting for the client)
  await setMode('send'); process.env.APP_BASE_URL = SITE;
  p = await request({ occasion: 'Independence Day' });
  assert.equal((await AC.work(p.id)).sent, true);
  p = await stateOf(p.id); assert.equal(p.status, 'awaiting_client'); assert.equal(p.stage, 'sent'); assert.equal(p.round, 1);
  assert.ok((await kinds(p.id)).includes('options_sent'));

  // 5. 'send' but the site's address is unknown: the options are made and wait for the team, who is told; nothing is sent
  delete process.env.APP_BASE_URL;
  p = await request({ occasion: 'Holi' });
  const noSite = await AC.work(p.id); assert.equal(noSite.ok, true); assert.equal(noSite.sent, false);
  assert.equal((await stateOf(p.id)).status, 'working');

  // 6. a request for a VIDEO is left to the team
  p = await request({ deliverable: 'video', occasion: 'Diwali video' });
  assert.deepEqual(await AC.work(p.id), { skipped: 'video' });
  p = await stateOf(p.id); assert.equal(p.status, 'request'); assert.deepEqual(p.counts, { images: 0, videos: 0 });
  assert.ok((await kinds(p.id)).includes('auto_skipped'));

  // 7. the picture maker fails: the request stays NEW, the reason is on the timeline, the team is told, nothing half-done is sent
  Img.create = async () => ({ error: 'AI pictures are not ready: test', status: 503, code: 'not_ready' });
  p = await request({ occasion: 'Sankranti' });
  const bad = await AC.work(p.id); assert.ok(bad.error && /not ready/.test(bad.error), JSON.stringify(bad));
  p = await stateOf(p.id); assert.equal(p.status, 'request');
  assert.ok((await kinds(p.id)).includes('auto_failed'));
  Img.create = realCreate;

  // 8. the team took the request while the pictures were being made: they stay in Drafts, the project is left to the team
  const taker = request({ occasion: 'Ugadi' }).then(async (q) => {
    const orig = Img.create;
    Img.create = async (...a) => { const r = await orig(...a); await P.accept(admin, q.id); return r; }; // the team accepts right after the first picture
    const o = await AC.work(q.id); Img.create = orig; return { q, o };
  });
  const { q, o } = await taker;
  assert.deepEqual(o, { skipped: 'taken' });
  assert.ok((await kinds(q.id)).includes('auto_stopped'));

  // 9. only a request that is still NEW is touched
  assert.deepEqual(await AC.work(q.id), { skipped: 'not a new request' });
  assert.deepEqual(await AC.work('does-not-exist'), { skipped: 'not a new request' });

  console.log('mkAutoCreate: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
