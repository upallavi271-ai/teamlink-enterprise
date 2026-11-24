// AI Marketing messages to a client leave from the "Digital Marketing" WhatsApp number (when there is one), and that number is the one shown first in the "Send from" list.
//   node backend/test-fixtures/mkSenderDigitalMarketing.test.js   (throw-away copy of prisma/sandbox.db)
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-sender-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
const S = require('../src/outreach/store');
const WN = require('../src/utils/waNumbers');
const Sender = require('../src/marketing/sender');
const admin = { id: 'u-admin', name: 'Test Admin', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' };
const now = new Date().toISOString();
const add = (id, label, digits, isDefault, status) => S.run('INSERT INTO "WaNumber" (id, label, displayNumber, displayDigits, phoneNumberId, active, isDefault, statusCode, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)', id, label, `+${digits}`, digits, `pn-${id}`, 1, isDefault ? 1 : 0, status, now, now);
(async () => {
  const real = await require('../src/db').user.findFirst({ select: { id: true } }); if (real) admin.id = real.id;
  await WN.ensure();
  await S.run('DELETE FROM "WaNumber"');
  await add('wn-med', 'Team Link Medical Consultants', '919000000011', true, 'verification_required');
  await add('wn-dm', 'TeamLink Digital Marketing', '919000000012', false, 'connected');
  await add('wn-job', 'Teamlink Careers', '919000000013', false, 'verification_required');
  WN.bust();
  const list = await Sender.numbersFor(admin);
  assert.equal(list.defaultId, 'wn-dm'); assert.equal(list.numbers[0].id, 'wn-dm'); assert.ok(list.numbers[0].isDefault && !list.numbers.find((n) => n.id === 'wn-med').isDefault);
  console.log('PASS  the Digital Marketing number is the first and the default in the "Send from" list');
  assert.ok(list.numbers.some((n) => n.id === 'wn-med')); console.log('PASS  the company default number is still in the list to pick');
  const p1 = await Sender.pick(admin, '');
  assert.equal(p1.numberId, 'wn-dm'); console.log('PASS  with nothing picked, a message to a client leaves from the Digital Marketing number');
  const p2 = await Sender.pick(admin, 'wn-med');
  assert.equal(p2.numberId, 'wn-med'); console.log('PASS  the company default number can still be picked');
  const anyone = { id: 'u-writer', name: 'Writer', role: 'EMPLOYEE', atsRole: 'EMPLOYEE' };
  const p3 = await Sender.pick(null, '', { trusted: true });
  assert.equal(p3.numberId, 'wn-dm'); console.log('PASS  automatic messages (reminders, meeting invites) use it too');
  // no Digital Marketing number: exactly as before
  await S.run('UPDATE "WaNumber" SET active = 0 WHERE id = ?', 'wn-dm'); WN.bust();
  const p4 = await Sender.pick(admin, '');
  assert.equal(p4.numberId, 'wn-med'); console.log('PASS  with that number switched off, the company default number is used as before');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* db open */ }
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); setTimeout(() => process.exit(1), 200); });
