// ---------------------------------------------------------------------------
// The "biometric machine is late" notice (utils/biometricNotice.js, GET /api/attendance/device-notice).
// Runs on a COPY of the database (VACUUM INTO a temp file - the real one is only read): the machine's last-contact time and its
// punch log are set up to look like a healthy day, a silent machine and a machine that delivers punches minutes late, and the real
// router is asked what the Attendance screen should say.
//   node scripts/biometric-notice-test.js
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { PrismaClient } = require('@prisma/client');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
// "2026-11-18 09:16:14" as the machine writes it (IST)
const ist = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bionotice-'));
  const copy = path.join(tmp, 'copy.db').split(path.sep).join('/');
  const real = new PrismaClient();
  await real.$executeRawUnsafe(`VACUUM INTO '${copy}'`);
  await real.$disconnect();
  process.env.DATABASE_URL = `file:${copy}`;
  process.env.TEST_MODE = '1';
  const prisma = require('../src/db');
  const { deviceNotice } = require('../src/utils/biometricNotice');

  stub('../src/middleware/auth', {
    ...require('../src/middleware/auth'),
    requireAuth: (req, _res, next) => { req.user = { id: 'test', name: 'Test', role: 'SUPER_ADMIN' }; next(); },
    requirePerm: () => (_req, _res, next) => next(),
  });
  const app = express(); app.use(express.json());
  app.use('/api/attendance', require('../src/routes/attendance'));
  const server = app.listen(0);
  const get = async () => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/attendance/device-notice`); return { status: r.status, body: await r.json() }; };

  try {
    const device = await prisma.biometricDevice.findFirst();
    if (!device) { console.log('the copy has no biometric device to test with'); process.exit(1); }
    const now = Date.now();
    const clean = () => prisma.biometricPunchLog.deleteMany({ where: { createdAt: { gte: new Date(now - 3 * 3600000) } } });
    const setDevice = (data) => prisma.biometricDevice.update({ where: { id: device.id }, data: { status: 'Active', ...data } });
    const punch = (pin, pressedAt, receivedAt) => prisma.biometricPunchLog.create({ data: { deviceSerial: device.serialNumber, pin, punchAt: ist(pressedAt), statusCode: '0', verifyCode: '1', createdAt: new Date(receivedAt) } });
    await clean();

    // 1. a healthy day: it called a few seconds ago, punches arrive in 3 seconds -> nothing is shown
    await setDevice({ lastSeenAt: new Date(now - 4000) });
    await punch('T1', now - 60000 - 3000, now - 60000); await punch('T2', now - 20000 - 2000, now - 20000);
    let n = await deviceNotice(new Date(now));
    ok('Healthy machine (called 4 s ago, punches 2-3 s old): no notice', n.show === false, JSON.stringify(n));

    // 2. the machine has gone quiet
    await setDevice({ lastSeenAt: new Date(now - 12 * 60000) });
    n = await deviceNotice(new Date(now));
    ok('Silent for 12 minutes: "not reporting", says when it last called and what to check', n.show && n.kind === 'offline' && /12 minutes ago/.test(n.message) && /network cable|power/i.test(n.message) && /Not in yet/.test(n.message), n.message && n.message.slice(0, 90));
    await setDevice({ lastSeenAt: new Date(now - 4 * 60000) });
    n = await deviceNotice(new Date(now));
    ok('Called 4 minutes ago is still within the normal gap: no notice', n.show === false);
    await setDevice({ lastSeenAt: new Date(now - 9 * 3600000) });
    n = await deviceNotice(new Date(now));
    ok('Silent for 9 hours reads in hours', n.show && n.kind === 'offline' && /9 hours ago/.test(n.message), n.message && n.message.slice(0, 80));

    // 3. punches arrive late: it is calling, but a thumb pressed at 09:16 reached TeamLink 7 minutes later (the 18 Nov case)
    await setDevice({ lastSeenAt: new Date(now - 5000) });
    await punch('T3', now - 8 * 60000, now - 60000); // pressed 8 min ago, received 1 min ago = 7 min late
    n = await deviceNotice(new Date(now));
    ok('Punches arriving late: "arriving late", with the thumb time, the receive time and the minutes', n.show && n.kind === 'late' && n.worstLagMinutes === 7 && /7 minutes later/.test(n.message) && /nothing is lost/i.test(n.message), n.message && n.message.slice(0, 110));
    ok('Late notice counts the late punches', n.lateCount === 1, `${n.lateCount}`);

    // 4. an old late arrival clears by itself
    await clean();
    await punch('T4', now - 70 * 60000, now - 45 * 60000); // received 45 minutes ago, 25 minutes late
    n = await deviceNotice(new Date(now));
    ok('A late arrival older than 30 minutes no longer shows (the notice clears by itself)', n.show === false);

    // 5. not set up / switched off
    await clean();
    await setDevice({ lastSeenAt: null });
    n = await deviceNotice(new Date(now));
    ok('A machine that never called (not set up yet): no notice', n.show === false);
    await setDevice({ lastSeenAt: new Date(now - 30 * 60000), status: 'Inactive' });
    await prisma.biometricDevice.update({ where: { id: device.id }, data: { status: 'Inactive' } });
    n = await deviceNotice(new Date(now));
    ok('A machine switched off on Integrations (Inactive): no notice', n.show === false);

    // 6. the real route
    await setDevice({ lastSeenAt: new Date(now - 15 * 60000) });
    let r = await get();
    ok('GET /api/attendance/device-notice answers 200 with the notice', r.status === 200 && r.body.show === true && r.body.kind === 'offline' && r.body.title, JSON.stringify(r.body).slice(0, 100));
    await setDevice({ lastSeenAt: new Date(Date.now() - 2000) });
    r = await get();
    ok('...and { show: false } when the machine is fine', r.status === 200 && r.body.show === false, JSON.stringify(r.body));
    const noPunchesWrote = await prisma.attendancePunch.count({ where: { date: ist(now).slice(0, 10), method: 'Biometric', employee: { biometricPin: { in: ['T1', 'T2', 'T3', 'T4'] } } } });
    ok('Reading the notice writes no attendance (it only looks)', noPunchesWrote === 0);
  } catch (err) {
    fail += 1; console.log('FAIL  test run crashed:', (err && err.stack) || err);
  } finally {
    server.close();
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
