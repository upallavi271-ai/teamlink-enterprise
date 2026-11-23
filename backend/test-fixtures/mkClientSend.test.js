// AI Marketing: sending a picture / video to a client on WhatsApp in one step, the swap to a number that can send the template, and the remembered client contacts.
//   node backend/test-fixtures/mkClientSend.test.js     (throw-away copy of prisma/sandbox.db; the social accounts and the publisher are stand-ins: nothing is posted anywhere)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-send-'));
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
  const CR = require('../src/marketing/clientReview');
  const Sender = require('../src/marketing/sender');
  const WN = require('../src/utils/waNumbers');
  const tplWaba = require('../src/outreach/tplWaba');
  const messaging = require('../src/utils/messaging');

  // stand-ins: the company has a default number (wD) and another one (wX) whose WhatsApp account has no template; nothing is sent to anybody
  WN.hasNumbers = async () => true;
  WN.defaultRow = async () => ({ id: 'wD', label: 'Default company', displayNumber: '+91 90000 00001', active: true });
  WN.getRow = async (id) => ({ id, label: id === 'wD' ? 'Default company' : 'Other number', displayNumber: '+91 90000 00002', active: true });
  WN.mayUse = async () => true;
  let approved = [{ id: 'wD', label: 'Default company' }]; // the numbers whose account has the template approved
  tplWaba.approvedNumbers = async () => approved;
  const calls = []; let closedWindow = false;
  messaging.send = async (channel, p) => {
    calls.push({ channel, kind: p.kind, numberId: p.numberId, hasMedia: !!p.media, text: p.text });
    if (channel === 'Email') return { ok: true };
    if (p.numberId === 'wX') return { ok: false, blocked: true, code: 'TEMPLATE_OTHER_ACCOUNT', templateName: 'tl_bulk_message', numberId: 'wX', error: '"tl_bulk_message" has not been sent to Meta for the WhatsApp account of "Other number" yet (error 132001).' };
    if (p.media && closedWindow) return { ok: false, code: 'WINDOW_CLOSED', error: 'outside the 24 hours' };
    return { ok: true, numberLabel: p.numberId === 'wX' ? 'Other number' : 'Default company', fromNumber: '+91 90000 00001' };
  };
  const reset = () => { calls.length = 0; };

  // 1. a number whose account cannot send the template: the same message goes from a number that can, and the answer says so
  let res = await Sender.send({ to: '919876543210', kind: 'bulk', text: 'hello', vars: ['hello'], numberId: 'wX', automatic: true });
  assert.equal(res.ok, true); assert.equal(res.fellBackTo, 'Default company');
  assert.deepEqual(calls.map((c) => c.numberId), ['wX', 'wD']);
  console.log('PASS a number that cannot send the template is swapped for one that can');

  // 2. nothing to swap to: the first answer (with its reason) comes back, nothing else is tried
  reset(); approved = [];
  res = await Sender.send({ to: '919876543210', kind: 'bulk', text: 'hello', vars: ['hello'], numberId: 'wX', automatic: true });
  assert.equal(res.ok, false); assert.equal(res.code, 'TEMPLATE_OTHER_ACCOUNT'); assert.equal(calls.length, 1);
  approved = [{ id: 'wD', label: 'Default company' }];
  console.log('PASS no other number can send: the reason is kept');

  // 3. a number that can send is not swapped
  reset();
  res = await Sender.send({ to: '919876543210', kind: 'bulk', text: 'hello', vars: ['hello'], numberId: 'wD', automatic: true });
  assert.equal(res.ok, true); assert.equal(res.fellBackTo, undefined); assert.equal(calls.length, 1);
  console.log('PASS a number that can send goes first, once');

  // 4. one step: picture -> private link ("client decides") + WhatsApp. The client is outside the 24 hours and there is no approval template, so the
  //    short note goes (from the number that can send) and it now carries the private link as well as the "reply YES"
  reset(); closedWindow = true;
  const item = await makeItem('Hiring poster');
  let out = await CR.sendToClient(admin, item, { clientName: 'Ravi Sweets', contactName: 'Ravi Kumar', contactPhone: '+91 98765 43210', contactEmail: 'ravi@example.test', numberId: 'wX' }, SITE);
  assert.ok(out.ok && /Sent by WhatsApp/.test(out.ok), JSON.stringify(out));
  assert.equal(out.review.mode, 'decide'); assert.equal(out.review.clientName, 'Ravi Sweets');
  const note = calls.filter((c) => c.kind === 'bulk').pop(); // the note that finally went out
  assert.ok(note, 'the short note was not sent'); assert.ok(/reply YES/i.test(note.text) && note.text.includes(`${SITE}/client-review/`), note.text);
  assert.equal(calls.filter((c) => c.channel === 'WhatsApp' && c.numberId === 'wX').length >= 1, true); // it did try the chosen number first
  assert.equal(note.numberId, 'wD'); // and the note left from the number that can send
  const it = (await S.q('SELECT status FROM "OmniMkImage" WHERE id = ?', item))[0]; assert.equal(it.status, 'waiting');
  console.log('PASS one step: link made, note with the private link sent from a number that can send');

  // 5. email too when asked and there is an address
  reset(); closedWindow = false;
  const item2 = await makeItem('Second poster');
  out = await CR.sendToClient(admin, item2, { clientName: 'Ravi Sweets', contactName: 'Ravi Kumar', contactPhone: '+91 98765 43210', contactEmail: 'ravi@example.test', email: true }, SITE);
  assert.ok(out.ok && /WhatsApp/.test(out.ok) && /Email/.test(out.ok), JSON.stringify(out));
  assert.ok(calls.some((c) => c.channel === 'Email'));
  console.log('PASS WhatsApp and email together when asked');

  // 6. mistakes are said plainly and a made link is kept
  let bad = await CR.sendToClient(admin, await makeItem('Third'), { clientName: 'X' }, SITE);
  assert.ok(bad.error && /client's name/i.test(bad.error), JSON.stringify(bad));
  bad = await CR.sendToClient(admin, await makeItem('Fourth'), { clientName: 'No Phone Co', contactName: 'Sita' }, SITE);
  assert.ok(bad.error && /WhatsApp number/i.test(bad.error) && bad.review && bad.review.id, JSON.stringify(bad));
  bad = await CR.sendToClient(admin, 'does-not-exist', { clientName: 'Ravi Sweets' }, SITE);
  assert.equal(bad.status, 404);
  console.log('PASS wrong input is refused in words; the link of a failed send is kept');

  // 7. remembered contacts: one per company, newest details, from sent items and from client projects
  const pr = await P.create(admin, { clientName: 'Project Co', contactName: 'Anil', contactPhone: '+91 91111 22222', contactEmail: 'anil@example.test', occasion: 'Diwali', brief: 'A Diwali offer poster for our shop', deliverable: 'image', platforms: ['facebook'] });
  assert.ok(pr.project, JSON.stringify(pr));
  const c = (await CR.contacts(admin)).contacts;
  const names = c.map((x) => x.name);
  assert.equal(names.filter((n) => n === 'Ravi Sweets').length, 1, JSON.stringify(names));
  const ravi = c.find((x) => x.name === 'Ravi Sweets');
  assert.equal(ravi.contactName, 'Ravi Kumar'); assert.ok(/9876543210/.test(ravi.contactPhone.replace(/\D/g, ''))); assert.equal(ravi.contactEmail, 'ravi@example.test');
  const proj = c.find((x) => x.name === 'Project Co'); assert.ok(proj && proj.contactName === 'Anil' && /9111122222/.test(proj.contactPhone.replace(/\D/g, '')));
  assert.equal(names[0], 'Project Co'); // the newest first
  const nobody = (await CR.contacts({ id: 'u-none', name: 'Nobody', role: 'CANDIDATE' })).contacts; assert.deepEqual(nobody, []);
  console.log('PASS remembered contacts: one per company, newest details, nothing for a login that may not use AI Marketing');

  console.log('mkClientSend: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
