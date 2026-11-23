// A client project's page lists everything sent to the client (what, when, to which number, the client's answer).
//   node backend/test-fixtures/mkSentList.test.js   (throw-away copy of prisma/sandbox.db; nothing is sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-sent-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });
const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');
const CR = require('../src/marketing/clientReview');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  await require('../src/marketing/images').ensure(); await CR.ensure();
  const r = await P.create(admin, { clientName: 'Sent List Co', contactName: 'Ravi Kumar', contactPhone: '+919000000003', contactEmail: 'ravi@clientcheck.in', occasion: 'Diwali', brief: 'A Diwali video with our logo', deliverable: 'video', accept: true });
  const p = r.project;
  const id = S.newId('im'); const file = `${id}.mp4`;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', file), Buffer.from('00000018667479706d703432', 'hex'));
  await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt, projectId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, 'Diwali video', 'p', 'video', '9:16', file, 'video/mp4', 100, 'draft', admin.id, admin.name, Date.now(), Date.now(), p.id);
  let d = await P.get(admin, p.id);
  assert.deepEqual(d.sent, []); console.log('PASS  nothing sent yet: the list is empty');
  const rev = await CR.create(admin, { kind: 'image', itemId: id, clientName: 'Sent List Co', contactName: 'Ravi Kumar', contactPhone: '+919000000003', contactEmail: 'ravi@clientcheck.in', mode: 'decide', days: 7 });
  assert.ok(rev.review, JSON.stringify(rev));
  d = await P.get(admin, p.id);
  assert.equal(d.sent.length, 1); const x = d.sent[0];
  assert.equal(x.kind, 'video'); assert.equal(x.itemTitle, 'Diwali video'); assert.equal(x.status, 'sent'); assert.ok(x.to && !x.to.includes('9000000003')); assert.ok(x.createdAt);
  console.log('PASS  a video sent to the client is listed with its kind, title, time and a MASKED number');
  assert.ok(!JSON.stringify(d.sent).includes('9000000003') && !JSON.stringify(d.sent).includes('ravi@clientcheck.in')); console.log('PASS  the full number and email are never in the list');
  await S.run(`UPDATE "OmniMkClientReview" SET status = 'changes', comment = ?, decidedAt = ?, decidedByName = ? WHERE id = ?`, 'Make the logo bigger', Date.now(), 'Ravi Kumar', rev.review.id);
  d = await P.get(admin, p.id);
  assert.equal(d.sent[0].status, 'changes'); assert.equal(d.sent[0].comment, 'Make the logo bigger'); console.log('PASS  the client\'s rejection and reason show in the list');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* db open */ }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
