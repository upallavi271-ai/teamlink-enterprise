// AI Marketing: post an APPROVED picture / video on the connected Facebook, Instagram and X accounts (marketing/postItem.js).
//   node backend/test-fixtures/mkPostItem.test.js     (throw-away copy of prisma/sandbox.db; the social accounts and the publisher are stand-ins: nothing is posted anywhere)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-post-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });

const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');
const Cfg = require('../src/marketing/settings');
const SA = require('../src/utils/socialAccounts');
const Pub = require('../src/marketing/publisher');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const SITE = 'https://example-teamlink.test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// stand-ins: every account id is "connected" except 'gone'; the publisher only records what it was asked to post
SA.withToken = async (id) => (id === 'gone' ? null : { account: { platform: 'facebook', name: `Page ${id}` }, token: 't' });
const posted = [];
Pub.publish = async (targets, media, caption) => { posted.push({ targets, media, caption }); return targets.map((t) => ({ accountId: t.accountId, ok: true, name: t.name, platform: t.platform, url: `https://facebook.test/${t.accountId}` })); };

const allow = async (autoPostAllowed) => Cfg.saveSettings({ ...(await Cfg.getSettings()), autoPostAllowed });
const kinds = async (id) => (await S.q('SELECT kind FROM "OmniMkProjectEvent" WHERE projectId = ? ORDER BY at ASC', id)).map((x) => x.kind);
const stateOf = async (id) => (await P.get(admin, id)).project;
async function makeItem(title) {
  const id = S.newId('im'); const file = `${id}.png`;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', file), PNG);
  await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, title, 'p', 'photo', '1:1', file, 'image/png', PNG.length, 'draft', admin.id, admin.name, Date.now(), Date.now());
  return id;
}
// a project with one option, accepted and ready to send (no phone and no email: nothing is ever sent to a person)
async function ready(clientName) {
  const r = await P.create(admin, { clientName, occasion: 'Diwali offer', brief: 'A Diwali offer poster for our sweet shop', deliverable: 'image', platforms: ['facebook'] });
  assert.ok(r.project, JSON.stringify(r));
  const id = r.project.id;
  assert.ok((await P.accept(admin, id)).ok);
  assert.ok((await P.setOptions(admin, id, { items: [{ itemId: await makeItem('pic') }] })).ok);
  return id;
}
const send = async (id, body = {}) => { const out = await P.send(admin, id, body, SITE); assert.ok(out.ok, JSON.stringify(out)); return stateOf(id); };
const approve = async (id, comment = '') => {
  const opt = (await P.get(admin, id)).options.find((o) => o.stage === 'presented');
  const out = await P.clientApprove(P.tokenOf(id), { optionId: opt.id, name: 'Ravi Kumar', comment, via: 'test' });
  assert.ok(out.ok, JSON.stringify(out));
};
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet
  await require('../src/marketing/images').ensure(); await P.ensure();
  const PI = require('../src/marketing/postItem'); await PI.ensure();
  const Pub2 = require('../src/marketing/publisher');
  // stand-ins: three connected accounts and one that is of another kind; the publisher records what it is asked to post and posts NOTHING anywhere
  const KIND = { fb1: 'facebook', ig1: 'instagram', x1: 'x', li1: 'linkedin', fb2: 'facebook' };
  SA.withToken = async (id) => (KIND[id] ? { account: { platform: KIND[id], name: `Account ${id}` }, token: 't' } : null);
  const asked = []; let delay = 0; let failIds = [];
  Pub2.publish = async (targets, media, caption) => { asked.push({ targets, media, caption }); if (delay) await new Promise((r) => setTimeout(r, delay)); return targets.map((t) => (failIds.includes(t.accountId) ? { accountId: t.accountId, platform: KIND[t.accountId], name: `Account ${t.accountId}`, ok: false, url: '', error: 'Meta said no.' } : { accountId: t.accountId, platform: KIND[t.accountId], name: `Account ${t.accountId}`, ok: true, url: `https://social.test/${t.accountId}/post1`, error: '' })); };
  const allow = async (v) => Cfg.saveSettings({ ...(await Cfg.getSettings()), autoPostAllowed: v });
  const approve = async (id, over = {}) => S.run('UPDATE "OmniMkImage" SET status = ?, decidedByName = ? WHERE id = ?', over.status || 'approved', 'The Client', id);
  const body = (over = {}) => ({ accountIds: ['fb1'], caption: 'Hiring freshers!', confirm: true, ...over });
  await allow(true);
  const a = await makeItem('Hiring poster'); await approve(a);

  // 1. who may
  let r = await PI.postItem({ id: 'u-none', name: 'Nobody', role: 'CANDIDATE' }, a, body(), SITE); assert.equal(r.status, 403);
  r = await PI.postItem(admin, 'does-not-exist', body(), SITE); assert.equal(r.status, 404);
  const other = { id: 'u-other', name: 'Other Member', role: 'MEMBER', atsRole: 'MEMBER' };
  r = await PI.postItem(other, a, body(), SITE); assert.ok(r.status === 403 || r.status === 404, JSON.stringify(r));
  r = await PI.posts({ id: 'u-none', name: 'Nobody', role: 'CANDIDATE' }, a); assert.equal(r.status, 403);
  console.log('PASS only a login with AI Marketing, and only the maker or an Admin, may post');

  // 2. only an approved picture or video, never a raw clip
  const d = await makeItem('A draft'); r = await PI.postItem(admin, d, body(), SITE); assert.equal(r.status, 409); assert.ok(/approved/i.test(r.error), r.error);
  const clip = await makeItem('A clip'); await approve(clip); await S.run('UPDATE "OmniMkImage" SET style = ? WHERE id = ?', 'clip', clip); r = await PI.postItem(admin, clip, body(), SITE); assert.equal(r.status, 400); assert.ok(/raw footage/.test(r.error), r.error);
  console.log('PASS a draft and a raw clip are refused');

  // 3. the checks before anything goes public
  r = await PI.postItem(admin, a, body({ confirm: false }), SITE); assert.equal(r.code, 'confirm');
  await allow(false); r = await PI.postItem(admin, a, body(), SITE); assert.equal(r.code, 'auto_off'); await allow(true);
  r = await PI.postItem(admin, a, body({ accountIds: [] }), SITE); assert.equal(r.status, 400);
  r = await PI.postItem(admin, a, body({ accountIds: ['gone'] }), SITE); assert.equal(r.status, 404);
  r = await PI.postItem(admin, a, body({ accountIds: ['li1'] }), SITE); assert.equal(r.status, 400); assert.ok(/by hand/.test(r.error), r.error);
  r = await PI.postItem(admin, a, body({ accountIds: ['fb1', 'x1'], caption: 'x'.repeat(281) }), SITE); assert.equal(r.status, 400); assert.ok(/280/.test(r.error), r.error);
  r = await PI.postItem(admin, a, body({ accountIds: ['fb1'] }), 'http://insecure.test'); assert.equal(r.status, 400); assert.ok(/https/.test(r.error), r.error);
  assert.equal(asked.length, 0, 'nothing was posted by any refused call');
  console.log('PASS no confirm, switch off, no account, unknown account, other kind, X over 280, no https: all refused and nothing was posted');

  // 4. the real post: the picture's public address, the words, both accounts; the result is kept
  r = await PI.postItem(admin, a, body({ accountIds: ['fb1', 'ig1'], caption: '  Hiring freshers!  ' }), SITE);
  assert.ok(r.ok && r.posted && /Posted on Account fb1, Account ig1/.test(r.ok), JSON.stringify(r));
  assert.equal(asked.length, 1); const q = asked[0];
  assert.deepEqual(q.targets.map((t) => t.accountId), ['fb1', 'ig1']); assert.equal(q.caption, 'Hiring freshers!');
  assert.equal(q.media.type, 'image'); assert.ok(q.media.url.startsWith(`${SITE}/api/mk-image/${a}/`) && q.media.url.endsWith('.png'), q.media.url);
  assert.ok(/\.jpg$/.test(q.media.jpgUrl), q.media.jpgUrl); // Instagram takes a JPEG: a PNG is offered as one
  const list = (await PI.posts(admin, a)).posts; assert.equal(list.length, 2); assert.ok(list.every((x) => x.ok && /^https:\/\/social\.test\//.test(x.url) && x.byName === admin.name));
  console.log('PASS posted: the right accounts, the picture\'s public address (a JPEG for Instagram), the words trimmed, and each post is kept');

  // 5. a failure is kept with its reason; one good and one bad is said so
  failIds = ['fb2']; r = await PI.postItem(admin, a, body({ accountIds: ['fb2'] }), SITE); assert.ok(!r.posted && /could not be posted/.test(r.ok), JSON.stringify(r));
  r = await PI.postItem(admin, a, body({ accountIds: ['fb1', 'fb2'] }), SITE); assert.ok(r.posted && /Some accounts were posted/.test(r.ok), r.ok); failIds = [];
  const all = (await PI.posts(admin, a)).posts; assert.ok(all.some((x) => !x.ok && x.error === 'Meta said no.')); assert.equal(all.length, 5);
  console.log('PASS a failure is kept with its reason; a partly good result says so');

  // 6. a video goes as a video
  const v = await makeItem('A video'); await approve(v); await S.run('UPDATE "OmniMkImage" SET mime = ? WHERE id = ?', 'video/mp4', v);
  asked.length = 0; r = await PI.postItem(admin, v, body({ accountIds: ['ig1'] }), SITE); assert.ok(r.posted, JSON.stringify(r)); assert.equal(asked[0].media.type, 'video'); assert.ok(asked[0].media.url.endsWith('.mp4'), asked[0].media.url);
  console.log('PASS an approved video is posted as a video');

  // 7. two clicks at once: the second is told it is being posted (no double post)
  const c = await makeItem('Double click'); await approve(c); delay = 300; asked.length = 0;
  const [r1, r2] = await Promise.all([PI.postItem(admin, c, body(), SITE), PI.postItem(admin, c, body(), SITE)]);
  const codes = [r1, r2].map((x) => (x.error ? x.status : 200)).sort(); assert.deepEqual(codes, [200, 409], JSON.stringify([r1, r2])); assert.equal(asked.length, 1); delay = 0;
  console.log('PASS two clicks at once post once');

  console.log('mkPostItem: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
