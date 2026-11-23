// AI Marketing: the "give us access to your page" box on the client page (settings accessLogin / accessBusinessId, publicView access).
//   node backend/test-fixtures/mkClientAccess.test.js     (throw-away copy of prisma/sandbox.db; the social accounts and the publisher are stand-ins: nothing is posted anywhere)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-access-'));
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
  const setAccess = async (patch) => { const cur = await Cfg.getSettings(); const c = Cfg.cleanSettings(patch, cur); assert.ok(c.value, JSON.stringify(c)); await Cfg.saveSettings(c.value); return c; };
  const allow = (v) => setAccess({ autoPostAllowed: v });
  const viewOf = async (id) => (await P.publicView(P.tokenOf(id)));

  // 1. the two settings are cleaned: the login is trimmed and cut, the Business ID keeps digits only, a wrong ID is refused in words, empty clears
  let c = Cfg.cleanSettings({ accessLogin: `  TeamLink Digital ${'x'.repeat(200)}  `, accessBusinessId: ' 123 456 789 012 ' }, await Cfg.getSettings());
  assert.equal(c.value.accessLogin.length, 120); assert.ok(c.value.accessLogin.startsWith('TeamLink Digital x')); assert.equal(c.value.accessBusinessId, '123456789012');
  c = Cfg.cleanSettings({ accessBusinessId: '12345' }, await Cfg.getSettings()); assert.ok(c.error && /8 to 30 digits/.test(c.error), JSON.stringify(c));
  c = Cfg.cleanSettings({ accessBusinessId: 'abc' }, await Cfg.getSettings()); assert.ok(c.error, 'letters only is not an ID');
  c = Cfg.cleanSettings({ accessLogin: '', accessBusinessId: '' }, { ...(await Cfg.getSettings()), accessLogin: 'x', accessBusinessId: '123456789' }); assert.equal(c.value.accessLogin, ''); assert.equal(c.value.accessBusinessId, '');
  c = Cfg.cleanSettings({ aiDailyPerUser: 33 }, { ...(await Cfg.getSettings()), accessLogin: 'Keep Me', accessBusinessId: '987654321' }); assert.equal(c.value.accessLogin, 'Keep Me'); assert.equal(c.value.accessBusinessId, '987654321');
  console.log('PASS the login and the Business ID are cleaned, a wrong ID is refused in words, empty clears, other saves leave them alone');

  // 2. saved and read back
  await setAccess({ autoPostAllowed: true, accessLogin: 'TeamLink Digital', accessBusinessId: '112233445566778' });
  const got = await Cfg.getSettings(); assert.equal(got.accessLogin, 'TeamLink Digital'); assert.equal(got.accessBusinessId, '112233445566778'); assert.equal(got.autoPostAllowed, true);
  console.log('PASS saved and read back');

  // 3. what the client's page is told: only when posting is on AND something is written; only those two things
  const id = await ready('Access Co'); await P.send(admin, id, {}, SITE);
  let v = await viewOf(id); assert.deepEqual(v.access, { login: 'TeamLink Digital', businessId: '112233445566778' });
  await setAccess({ accessBusinessId: '' }); v = await viewOf(id); assert.deepEqual(v.access, { login: 'TeamLink Digital', businessId: '' });
  await setAccess({ accessLogin: '', accessBusinessId: '556677889900' }); v = await viewOf(id); assert.deepEqual(v.access, { login: '', businessId: '556677889900' });
  await setAccess({ accessBusinessId: '' }); v = await viewOf(id); assert.equal(v.access, null, 'nothing written: no box');
  await setAccess({ accessLogin: 'TeamLink Digital' }); await allow(false); v = await viewOf(id); assert.equal(v.access, null, 'posting switched off: no box');
  assert.ok(!JSON.stringify(v).includes('TeamLink Digital'), 'nothing of it leaks while it is off');
  console.log('PASS the page is told the login / Business ID only while posting is on and something is written');

  console.log('mkClientAccess: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
