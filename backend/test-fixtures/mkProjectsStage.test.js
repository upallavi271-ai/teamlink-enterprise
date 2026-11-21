// AI Marketing > Client projects: the stage of a request and the pictures / videos made for it (marketing/projects.js stageOf, countsFor).
//   node backend/test-fixtures/mkProjectsStage.test.js        (runs on a throw-away copy of prisma/sandbox.db; nothing real is touched or sent)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mk-stage-')), 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
const S = require('../src/outreach/store');
const P = require('../src/marketing/projects');

const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id; // a real id keeps the audit log quiet
  const mk = async (b) => { const r = await P.create(admin, { clientName: 'Stage Test Co', occasion: 'Diwali', brief: 'A Diwali video with our logo', deliverable: 'both', ...b }); assert.ok(r.project, JSON.stringify(r)); return r.project; };
  const add = async (pid, mime, style = 'photo') => S.run('INSERT INTO "OmniMkImage" (id, title, prompt, style, aspect, file, mime, status, createdById, createdByName, createdAt, updatedAt, projectId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', S.newId('im'), 't', 'p', style, '1:1', 'x', mime, 'draft', admin.id, admin.name, Date.now(), Date.now(), pid);
  await require('../src/marketing/images').ensure();

  let p = await mk({});
  assert.equal(p.stage, 'new'); assert.equal(p.stageLabel, 'New request'); assert.deepEqual(p.counts, { images: 0, videos: 0 });
  await P.accept(admin, p.id);
  p = (await P.get(admin, p.id)).project; assert.equal(p.stage, 'accepted'); assert.equal(p.stageLabel, 'Accepted');
  await add(p.id, 'image/png'); await add(p.id, 'image/png'); await add(p.id, 'video/mp4'); await add(p.id, 'video/mp4', 'clip'); // a raw clip is not counted
  p = (await P.get(admin, p.id)).project;
  assert.equal(p.stage, 'making'); assert.deepEqual(p.counts, { images: 2, videos: 1 });
  const listed = (await P.list(admin, {})).projects.find((x) => x.id === p.id);
  assert.equal(listed.stage, 'making'); assert.deepEqual(listed.counts, { images: 2, videos: 1 });
  // the client's answer decides approved / rejected
  const T = 'OmniMkProject';
  await S.run(`UPDATE "${T}" SET status = 'awaiting_client' WHERE id = ?`, p.id);
  assert.equal((await P.get(admin, p.id)).project.stage, 'sent');
  await S.run(`UPDATE "${T}" SET status = 'working', clientAnswer = 'rejected', clientAnswerNote = 'logo too small' WHERE id = ?`, p.id);
  p = (await P.get(admin, p.id)).project; assert.equal(p.stage, 'rejected'); assert.equal(p.clientAnswerNote, 'logo too small');
  await S.run(`UPDATE "${T}" SET status = 'approved' WHERE id = ?`, p.id);
  assert.equal((await P.get(admin, p.id)).project.stage, 'approved');
  await S.run(`UPDATE "${T}" SET status = 'posted' WHERE id = ?`, p.id);
  assert.equal((await P.get(admin, p.id)).project.stageLabel, 'Posted');
  const inv = (await P.invite(admin, { clientName: 'Invited Co' })).project; assert.equal(inv.stage, 'waiting');
  console.log('mkProjectsStage: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
