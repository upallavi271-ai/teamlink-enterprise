// AI Marketing: posting by itself needs the CLIENT'S TICK on the approve form (marketing/projects.js publicChoose, consentCovers, autoRun).
//   node backend/test-fixtures/mkClientConsent.test.js     (throw-away copy of prisma/sandbox.db; the social accounts and the publisher are stand-ins: nothing is posted anywhere)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-consent-'));
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

  // a project sent to the client (status awaiting_client) and, when `armed`, set to post by itself on the given accounts
  const sent = async (client, armed = ['a1']) => {
    const id = await ready(client);
    const out = await P.send(admin, id, {}, SITE); assert.ok(out.ok, JSON.stringify(out));
    if (armed) { const r = await P.setAutopost(admin, id, { enabled: true, accountIds: armed }, SITE); assert.ok(r.ok, JSON.stringify(r)); }
    return id;
  };
  const optOf = async (id) => (await P.get(admin, id)).options.find((o) => o.stage === 'presented').id;
  const choose = async (id, extra = {}) => { const out = await P.publicChoose(P.tokenOf(id), { optionId: await optOf(id), name: 'Ravi Kumar', ...extra }, '1.2.3.4'); assert.ok(out.ok, JSON.stringify(out)); return out; };
  const consentOf = async (id) => (await P.get(admin, id)).project.postConsent;

  // 1. the page asks only when posting is armed, and names the accounts (names only)
  let a = await sent('Consent Co');
  let v = await P.publicView(P.tokenOf(a));
  assert.deepEqual(v.posting, { accounts: [{ platform: 'facebook', name: 'Page a1' }] });
  assert.equal(v.project.postingHeld, false);
  const plain = await sent('Plain Co', null);
  assert.equal((await P.publicView(P.tokenOf(plain))).posting, null);
  console.log('PASS the client page is told the accounts only when posting is armed');

  // 2. the client approves WITHOUT the tick: approved, but NOT posted by itself, and the team is told why
  await choose(a);
  let p = await stateOf(a);
  assert.equal(p.status, 'approved'); assert.equal(p.autoState, 'consent'); assert.equal(p.postConsent, null);
  await new Promise((r) => setTimeout(r, 600)); assert.equal(posted.length, 0, 'it posted without the client tick');
  assert.ok(!(await kinds(a)).includes('post_consent'));
  assert.equal((await P.publicView(P.tokenOf(a))).project.postingHeld, true);
  console.log('PASS approve without the tick: held, nothing posted');

  // 3. a person's "Post now" still works (the team may have the client's permission another way)
  const now = await P.postNow(admin, a, { confirm: true }, SITE);
  assert.ok(!now.error, JSON.stringify(now)); assert.equal(posted.length, 1); assert.equal((await stateOf(a)).status, 'posted');
  console.log('PASS Post now by a person still posts');

  // 4. a WhatsApp / email button answer (clientApprove: no tick possible) is held the same way
  const b = await sent('Button Co');
  const opt = await optOf(b);
  assert.ok((await P.clientApprove(P.tokenOf(b), { optionId: opt, name: 'Ravi Kumar', via: 'WhatsApp button' })).ok);
  assert.equal((await stateOf(b)).autoState, 'consent');
  await new Promise((r) => setTimeout(r, 400)); assert.equal(posted.length, 1, 'a button answer posted without a tick');
  console.log('PASS an answer by a button (no tick) is held');

  // 5. the client approves WITH the tick: the permission is saved with name, time and accounts, and it is posted by itself
  const before = posted.length;
  const c = await sent('Ticked Co', ['a1', 'a2']);
  await choose(c, { allowPosting: true });
  assert.ok(await until(async () => (await stateOf(c)).status === 'posted'), 'it was not posted by itself after the tick');
  assert.equal(posted.length, before + 1); assert.deepEqual(posted[before].targets.map((t) => t.accountId), ['a1', 'a2']);
  const cons = await consentOf(c);
  assert.equal(cons.by, 'Ravi Kumar'); assert.deepEqual(cons.accountIds, ['a1', 'a2']); assert.ok(cons.at);
  assert.ok((await kinds(c)).includes('post_consent'));
  console.log('PASS ticked: saved with name, time and accounts, then posted by itself');

  // 6. the tick with suggestions: permission saved, but the team reads the suggestions first
  const d = await sent('Suggest Co');
  await choose(d, { allowPosting: true, comment: 'make the logo bigger' });
  p = await stateOf(d); assert.equal(p.autoState, 'review'); assert.ok(p.postConsent);
  await new Promise((r) => setTimeout(r, 500)); assert.equal(posted.length, before + 1, 'it posted although the client sent suggestions');
  console.log('PASS ticked with suggestions: waits for the team');

  // 7. only a real "true" counts (a string is not a tick)
  const e = await sent('String Co');
  await choose(e, { allowPosting: 'true' });
  assert.equal((await stateOf(e)).autoState, 'consent'); assert.equal((await stateOf(e)).postConsent, null);
  console.log('PASS a text value is not a tick');

  // 8. a project that was never armed: a tick changes nothing
  const f = await sent('Unarmed Co', null);
  await choose(f, { allowPosting: true });
  p = await stateOf(f); assert.equal(p.autoPost, false); assert.equal(p.postConsent, null);
  console.log('PASS not armed: the tick is ignored, nothing saved');

  // 9. arming an already approved project: only the accounts the client allowed go out by themselves
  const g = await sent('Late Co', null);
  await choose(g, { allowPosting: true });                       // approved (nothing armed, so no permission was recorded)
  let r = await P.setAutopost(admin, g, { enabled: true, accountIds: ['a1'] }, SITE);
  assert.ok(r.ok && /NOT post by itself/.test(r.ok), JSON.stringify(r)); assert.equal((await stateOf(g)).autoState, 'consent');
  // ... and with a permission that covers a1 only: arming a1 is fine, adding a2 is held
  const h = await sent('Cover Co', ['a1']);
  await choose(h, { allowPosting: true, comment: 'x' });          // approved with the tick for a1 (suggestions keep it from posting yet)
  r = await P.setAutopost(admin, h, { enabled: true, accountIds: ['a1'] }, SITE); assert.ok(r.ok && !/NOT post/.test(r.ok), JSON.stringify(r));
  r = await P.setAutopost(admin, h, { enabled: true, accountIds: ['a1', 'a2'] }, SITE); assert.ok(/NOT post by itself/.test(r.ok), JSON.stringify(r)); assert.equal((await stateOf(h)).autoState, 'consent');
  console.log('PASS arming after approval: only allowed accounts post by themselves');

  // 10. belt and braces: even if the state is forced to "scheduled", the run itself checks the permission
  const i = await sent('Forced Co');
  await choose(i);                                                // no tick
  await S.run('UPDATE "OmniMkProject" SET autoState = \'scheduled\' WHERE id = ?', i);
  const n0 = posted.length;
  const out = await P.autoRun(i);
  assert.ok(out.skipped, JSON.stringify(out)); assert.equal(posted.length, n0); assert.equal((await stateOf(i)).autoState, 'consent');
  console.log('PASS the post itself refuses without permission');

  console.log('mkClientConsent: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
