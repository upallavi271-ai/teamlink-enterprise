// A client project's stage follows what happens to ITS video: sent to the client (card button), approved / rejected by the client, posted (Post button). Regression: "we posted on the client's page but it says Being made".
//   node backend/test-fixtures/mkProjectStageFromItems.test.js   (throw-away copy of prisma/sandbox.db)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-stage-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1'; process.env.UPLOAD_DIR = path.join(work, 'uploads');
fs.mkdirSync(path.join(process.env.UPLOAD_DIR, 'mk-images'), { recursive: true });
const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');
const CR = require('../src/marketing/clientReview');
const PI = require('../src/marketing/postItem');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  await require('../src/marketing/images').ensure(); await CR.ensure(); await PI.ensure();
  const mkProject = async (name) => (await P.create(admin, { clientName: name, contactName: 'Ravi', contactPhone: '+919000000006', contactEmail: 'ravi@clientcheck.in', occasion: 'Skin care', brief: 'We are a dermatology clinic. We want skin care videos.', deliverable: 'video', accept: true })).project;
  const mkVideo = async (projectId, title) => { const id = S.newId('im'); const file = `${id}.mp4`; fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'mk-images', file), Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(2048, 3)])); await S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, bytes, status, createdById, createdByName, createdAt, updatedAt, projectId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, title, 'p', 'video', '9:16', file, 'video/mp4', 2100, 'draft', admin.id, admin.name, Date.now(), Date.now(), projectId); return id; };
  const stage = async (id) => (await P.get(admin, id)).project.stage;
  const tabCount = async (k) => (await P.list(admin, {})).counts[k] || 0;

  const p = await mkProject('Stage Test Clinic');
  assert.equal(await stage(p.id), 'accepted'); console.log('PASS  a new project that nothing was made for is "accepted"');
  const vid = await mkVideo(p.id, 'Skin video');
  assert.equal(await stage(p.id), 'making'); console.log('PASS  with a video made it is "being made"');
  const rev = await CR.create(admin, { kind: 'image', itemId: vid, clientName: 'Stage Test Clinic', contactPhone: '+919000000006', mode: 'decide', days: 7 });
  assert.equal(await stage(p.id), 'sent'); console.log('PASS  after the video is sent to the client from its card the project is "with the client"');
  assert.ok((await P.list(admin, { status: 'awaiting_client' })).projects.some((x) => x.id === p.id)); console.log('PASS  and it is in the "With the client" tab');
  await S.run(`UPDATE "OmniMkClientReview" SET status = 'changes', comment = 'bigger logo', decidedAt = ? WHERE id = ?`, Date.now(), rev.review.id);
  assert.equal(await stage(p.id), 'rejected'); console.log('PASS  a rejection by the client shows as rejected');
  await S.run(`UPDATE "OmniMkClientReview" SET status = 'approved' WHERE id = ?`, rev.review.id);
  assert.equal(await stage(p.id), 'approved'); console.log('PASS  the client approving the video makes the project approved');
  assert.ok((await P.list(admin, { status: 'approved' })).projects.some((x) => x.id === p.id)); console.log('PASS  and it is in the Approved tab');
  // the Post button of the video: one post that went out
  await S.run('INSERT INTO "OmniMkItemPost" (id, itemId, accountId, platform, accountName, ok, url, caption, byId, byName, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', S.newId('ip'), vid, 'fb1', 'facebook', 'Clinic Page', 1, 'https://facebook.com/x/1', 'caption', admin.id, admin.name, Date.now());
  assert.equal(await stage(p.id), 'posted'); console.log('PASS  after the video is posted the project says "posted" (not "being made")');
  const row = (await S.q('SELECT status, postedAt FROM "OmniMkProject" WHERE id = ?', p.id))[0];
  assert.equal(row.status, 'posted'); assert.ok(row.postedAt); console.log('PASS  the status is saved as posted (once), with the time');
  assert.ok((await P.list(admin, { status: 'posted' })).projects.some((x) => x.id === p.id) && (await tabCount('posted')) >= 1); console.log('PASS  it is in the Posted tab and the tab count follows');
  const ev = (await P.get(admin, p.id)).events.filter((e) => e.kind === 'posted'); assert.equal(ev.length, 1); console.log('PASS  the timeline says so once');
  // a failed post does not finish the project
  const q = await mkProject('Failed Post Clinic'); const v2 = await mkVideo(q.id, 'Another');
  await S.run('INSERT INTO "OmniMkItemPost" (id, itemId, accountId, platform, accountName, ok, error, caption, byId, byName, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', S.newId('ip'), v2, 'fb1', 'facebook', 'Clinic Page', 0, 'expired token', 'caption', admin.id, admin.name, Date.now());
  assert.equal(await stage(q.id), 'making'); console.log('PASS  a post that failed does not make the project posted');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* db open */ }
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); setTimeout(() => process.exit(1), 200); });
