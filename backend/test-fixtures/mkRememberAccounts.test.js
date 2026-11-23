// AI Marketing: posting by itself after the client approves, with the client's accounts REMEMBERED (marketing/projects.js armPosting).
//   node backend/test-fixtures/mkRememberAccounts.test.js     (throw-away copy of prisma/sandbox.db; the social accounts and the publisher are stand-ins: nothing is posted anywhere)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-rem-'));
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
  await allow(true);

  // 1. accounts ticked in the Send box and REMEMBERED: this project is armed to post by itself after the client approves
  let a = await ready('Remember Test Co');
  let p = await send(a, { autoAccountIds: ['a1'], remember: true });
  assert.equal(p.status, 'awaiting_client'); assert.equal(p.autoPost, true); assert.deepEqual(p.autoTargets.map((t) => t.accountId), ['a1']); assert.equal(p.autoState, 'scheduled');
  assert.deepEqual(p.autoTargets.length, 1);
  assert.deepEqual((await Cfg.getClientAccounts())['n:remember test co'].accountIds, ['a1']);
  assert.deepEqual((await P.get(admin, a)).clientAccountIds, ['a1']);
  assert.ok((await kinds(a)).includes('autopost_remembered'));
  assert.equal(posted.length, 0, 'nothing is posted before the client approves');

  // 2. the client approves (page, WhatsApp or email button all end here): it is posted by itself, right away
  await approve(a);
  assert.ok(await until(async () => (await stateOf(a)).status === 'posted'), 'it was not posted by itself');
  assert.equal(posted.length, 1); assert.equal(posted[0].targets[0].accountId, 'a1'); assert.equal(posted[0].media.type, 'image'); assert.ok(posted[0].media.url.startsWith(SITE));
  p = await stateOf(a); assert.equal(p.postUrl, 'https://facebook.test/a1');

  // 3. the NEXT project of the same client is armed by itself when it is sent: nobody picks the accounts again
  const b = await ready('Remember Test Co');
  p = await send(b, {});
  assert.equal(p.autoPost, true); assert.deepEqual(p.autoTargets.map((t) => t.accountId), ['a1']);

  // 4. another client never gets this client's accounts
  const other = await ready('Other Co');
  p = await send(other, {}); assert.equal(p.autoPost, false); assert.equal(p.status, 'awaiting_client');

  // 5. an empty list means "none for this project" (the remembered ones stay for the next)
  const c = await ready('Remember Test Co');
  p = await send(c, { autoAccountIds: [] }); assert.equal(p.autoPost, false);
  assert.deepEqual((await P.get(admin, c)).clientAccountIds, ['a1']);

  // 6. the client adds SUGGESTIONS with the choice: nothing is posted by itself, the team reads them first
  const before = posted.length;
  await approve(b, 'please use the green logo');
  p = await stateOf(b); assert.equal(p.status, 'approved'); assert.equal(p.autoState, 'review');
  await new Promise((r) => setTimeout(r, 500)); assert.equal(posted.length, before, 'it posted although the client sent suggestions');

  // 7. an account that is not connected any more: the options still go to the client, the reason is on the timeline, the team is told
  await Cfg.saveClientAccounts({ ...(await Cfg.getClientAccounts()), 'n:remember test co': { accountIds: ['gone'], by: 't', at: new Date().toISOString() } });
  const d = await ready('Remember Test Co');
  p = await send(d, {}); assert.equal(p.status, 'awaiting_client'); assert.equal(p.autoPost, false);
  assert.ok((await kinds(d)).includes('autopost_skipped'));

  // 8. an Admin has not allowed posting by itself: nothing is armed, the project is sent as usual, and the timeline says why
  await Cfg.saveClientAccounts({ ...(await Cfg.getClientAccounts()), 'n:remember test co': { accountIds: ['a1'], by: 't', at: new Date().toISOString() } });
  await allow(false);
  const e = await ready('Remember Test Co');
  p = await send(e, {}); assert.equal(p.status, 'awaiting_client'); assert.equal(p.autoPost, false);
  assert.ok((await kinds(e)).includes('autopost_skipped'));

  // 9. untick everything AND remember = forget the client's accounts
  await allow(true);
  const f = await ready('Remember Test Co');
  p = await send(f, { autoAccountIds: [], remember: true }); assert.equal(p.autoPost, false);
  assert.equal((await Cfg.getClientAccounts())['n:remember test co'], undefined);
  const g = await ready('Remember Test Co');
  p = await send(g, {}); assert.equal(p.autoPost, false);

  console.log('mkRememberAccounts: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
