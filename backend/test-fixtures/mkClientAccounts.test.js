// The client's accounts ticked when the client is made are kept for the client, come back with the project, and unknown accounts are ignored.
//   node backend/test-fixtures/mkClientAccounts.test.js   (throw-away copy of prisma/sandbox.db; the list of connected accounts is a stub)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-acc-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
const SA = require('../src/utils/socialAccounts');
SA.list = async () => ({ facebook: [{ id: 'fb1', platform: 'facebook', name: 'Dr Rao Clinic Page', status: 'Connected' }], instagram: [{ id: 'ig1', platform: 'instagram', name: 'drrao_clinic', status: 'Connected', parentName: 'Dr Rao Clinic Page' }], x: [] });
const P = require('../src/marketing/projects');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  const base = { clientName: 'Dr Rao Clinic', contactName: 'Dr Rao', contactPhone: '+919000000005', contactEmail: 'rao@clientcheck.in', occasion: 'Skin care', brief: 'We are a dermatology clinic. We want skin care videos for patients.', deliverable: 'video', accept: true };
  const a = await P.create(admin, { ...base, postAccountIds: ['fb1', 'ig1', 'not-a-real-account'] });
  assert.ok(a.project, JSON.stringify(a));
  const d1 = await P.get(admin, a.project.id);
  assert.deepEqual(d1.clientAccountIds.sort(), ['fb1', 'ig1']); console.log('PASS  the accounts ticked when the client is made come back with the project (an unknown account is ignored)');
  // a second project of the same client opens with the same accounts, with nothing ticked again
  const b = await P.create(admin, { ...base, occasion: 'Hair care' });
  const d2 = await P.get(admin, b.project.id);
  assert.deepEqual(d2.clientAccountIds.sort(), ['fb1', 'ig1']); console.log('PASS  the next project of the same client already has those accounts');
  // changing them in the edit form
  const e = await P.update(admin, a.project.id, { ...base, postAccountIds: ['ig1'] });
  assert.ok(e.project, JSON.stringify(e));
  assert.deepEqual((await P.get(admin, a.project.id)).clientAccountIds, ['ig1']); console.log('PASS  the accounts can be changed when the request is edited');
  // nothing sent in the form = untouched
  await P.update(admin, a.project.id, { ...base });
  assert.deepEqual((await P.get(admin, a.project.id)).clientAccountIds, ['ig1']); console.log('PASS  a form that does not mention the accounts leaves them as they are');
  await P.update(admin, a.project.id, { ...base, postAccountIds: [] });
  assert.deepEqual((await P.get(admin, a.project.id)).clientAccountIds, []); console.log('PASS  unticking all of them clears them');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* db open */ }
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); setTimeout(() => process.exit(1), 200); });
