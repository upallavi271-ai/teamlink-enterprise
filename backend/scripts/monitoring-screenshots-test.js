#!/usr/bin/env node
/**
 * Employee Monitoring: SCREENSHOTS, HISTORY KEPT 1 YEAR, the WEBSITE ADD-ON's host (founder 2026-11-17, "build exactly this").
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4087. The screenshot upload / viewing / role tests go over
 * HTTP; the retention, 1-year-history and host-as-site tests call the utils directly on the same copy.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/monitoring-screenshots-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-shots-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4087;
const API = `http://localhost:${PORT}/api`;
const UPLOADS = path.join(os.tmpdir(), `zz-shots-up-${process.pid}`);
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'shots-test', UPLOAD_DIR: UPLOADS, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const M = require('../src/utils/monitoring');
const SH = require('../src/utils/monitoringScreenshots');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const P = process.pid;
const randTok = () => `zz${require('crypto').randomBytes(30).toString('base64url')}`; // >32 chars
const jpeg = (fill = 1200, pad = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(fill, pad), Buffer.from([0xff, 0xd9])]);
const callJson = async (method, url, token) => { const r = await fetch(API + url, { method, headers: { Authorization: `Bearer ${token}` } }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j }; };
const upload = async (token, buf, meta = {}) => fetch(`${API}/monitoring/agent/screenshot`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Device ${token}`, 'X-Shot-App': meta.app || 'chrome', 'X-Shot-Title': encodeURIComponent(meta.title || 'naukri.com'), 'X-Shot-At': meta.at || new Date().toISOString() }, body: new Uint8Array(buf) });

let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ } process.exit(code); }, 800);
}

(async () => {
  // --- two existing employees whose login is a plain EMPLOYEE (so they are NOT HR desk) ---
  const emps = await prisma.employee.findMany({ where: { employmentStatus: { notIn: ['Exited', 'Relieved', 'Terminated'] }, userId: { not: null } }, select: { id: true, userId: true, user: { select: { role: true, hrmsRole: true, status: true } } }, take: 200 });
  const plain = emps.filter((e) => e.user && e.user.status === 'Active' && e.user.role === 'EMPLOYEE' && String(e.user.hrmsRole || '').toUpperCase() !== 'HR');
  if (plain.length < 1) { console.log('no plain-employee login found in the sandbox; cannot run'); return stop(1); }
  const empA = plain[0];
  const empB = emps.find((e) => e.id !== empA.id) || plain[1] || empA;
  await prisma.user.update({ where: { id: empA.userId }, data: { status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), passwordResetRequired: false } }).catch(() => {});

  // --- the Super Admin (reused), a fresh HR login, a fresh team-lead login ---
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 10 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const hrUser = await prisma.user.create({ data: { name: `Zz hr ${P}`, email: `zz.hr.${P}@zz-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', hrmsAccess: true, hrmsRole: 'HR', passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const tlUser = await prisma.user.create({ data: { name: `Zz tl ${P}`, email: `zz.tl.${P}@zz-test.in`, passwordHash: 'x', status: 'Active', role: 'TL', hrmsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });

  // setup-time sanity: HR is HR desk, the employee / TL are not
  check('setup: HR login is HR desk, employee + TL are not', M.isMonitorAdmin(await resolveIdentity(hrUser.id)) && !M.isMonitorAdmin(await resolveIdentity(empA.userId)) && !M.isMonitorAdmin(await resolveIdentity(tlUser.id)));

  // --- devices + consent ---
  const TOKEN_A = randTok(); const TOKEN_B = randTok();
  const devA = await prisma.monitoringDevice.create({ data: { employeeId: empA.id, deviceName: `ZZ-SHOT-A ${P}`, tokenHash: M.hashToken(TOKEN_A), isActive: true, approved: true, lastSeenAt: new Date() } });
  await prisma.monitoringDevice.create({ data: { employeeId: empB.id, deviceName: `ZZ-SHOT-B ${P}`, tokenHash: M.hashToken(TOKEN_B), isActive: true, approved: true, lastSeenAt: new Date() } });
  // settings() migrates the notice ONCE and bumps the version; record empA's consent at the final version (empB never consents)
  const s0 = await M.settings();
  check('the notice now mentions screenshots, 1-year history and the website add-on', /screenshot/i.test(s0.policyText) && /1 year/i.test(s0.policyText) && /add-on/i.test(s0.policyText), s0.policyText.slice(0, 120));
  check('screenshots are ON by default, every 10 min, kept 30 days; history 1 year', s0.screenshotsEnabled === true && s0.screenshots.intervalMinutes === 10 && s0.screenshots.retentionDays === 30 && s0.historyDays === 365, { e: s0.screenshotsEnabled, i: s0.screenshots, h: s0.historyDays });
  await M.recordConsent(empA.id, s0.policyVersion, '127.0.0.1', 'test');

  // --- the server ---
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tAdmin = await tok(adminRow.id); const tHr = await tok(hrUser.id); const tTl = await tok(tlUser.id); const tEmp = await tok(empA.userId);

  console.log('Upload (the agent)');
  const up = await upload(TOKEN_A, jpeg(), { title: 'naukri.com' });
  const upBody = await up.json().catch(() => null);
  check('a valid device token uploads: a row + a file is stored', up.status === 201 && upBody && upBody.id, { s: up.status, b: upBody });
  const shotId = upBody && upBody.id;
  const onDisk = shotId ? await SH.openOne(shotId) : null;
  check('the file is on disk and the row points at it', !!onDisk && fs.existsSync(onDisk.path) && onDisk.employeeId === empA.id, onDisk && { p: onDisk.path });
  check('a bad device token is refused (401)', (await upload('x'.repeat(40), jpeg())).status === 401);
  check('an oversize screenshot is refused (not stored)', (await upload(TOKEN_A, jpeg(3 * 1024 * 1024))).status >= 400);
  check('no consent -> refused (412)', (await upload(TOKEN_B, jpeg())).status === 412);

  console.log('Who can see a screenshot');
  const today = M.todayIst();
  check('Admin can list', (await callJson('GET', `/monitoring/screenshots?employeeId=${empA.id}&day=${today}`, tAdmin)).status === 200);
  const hrList = await callJson('GET', `/monitoring/screenshots?employeeId=${empA.id}&day=${today}`, tHr);
  check('HR can list, and the shot is in it', hrList.status === 200 && (hrList.body.shots || []).some((x) => x.id === shotId), { s: hrList.status, n: hrList.body && (hrList.body.shots || []).length });
  check('a team lead cannot (403)', (await callJson('GET', `/monitoring/screenshots?employeeId=${empA.id}&day=${today}`, tTl)).status === 403);
  check('a normal employee cannot (403)', (await callJson('GET', `/monitoring/screenshots?employeeId=${empA.id}&day=${today}`, tEmp)).status === 403);
  // make empA's login an IT Admin and show it still cannot
  await prisma.monitoringSetting.update({ where: { id: 'default' }, data: { itAdminIds: empA.id } }).catch(async () => { await prisma.monitoringSetting.upsert({ where: { id: 'default' }, create: { id: 'default', itAdminIds: empA.id }, update: { itAdminIds: empA.id } }); });
  check('setup: empA login is now an IT Admin but not HR desk', M.isItIn(await M.settings(), await resolveIdentity(empA.userId)) && !M.isMonitorAdmin(await resolveIdentity(empA.userId)));
  check('an IT Admin cannot see screenshots (403)', (await callJson('GET', `/monitoring/screenshots?employeeId=${empA.id}&day=${today}`, tEmp)).status === 403);

  console.log('Opening an image is audited');
  const imgA = await fetch(`${API}/monitoring/screenshots/${shotId}`, { headers: { Authorization: `Bearer ${tAdmin}` } });
  check('Admin opens the image (200, image/jpeg, no-store)', imgA.status === 200 && /image\/jpeg/.test(imgA.headers.get('content-type') || '') && /no-store/.test(imgA.headers.get('cache-control') || ''), { s: imgA.status, ct: imgA.headers.get('content-type') });
  await imgA.arrayBuffer().catch(() => {});
  const imgHr = await fetch(`${API}/monitoring/screenshots/${shotId}`, { headers: { Authorization: `Bearer ${tHr}` } }); await imgHr.arrayBuffer().catch(() => {});
  const imgEmp = await fetch(`${API}/monitoring/screenshots/${shotId}`, { headers: { Authorization: `Bearer ${tEmp}` } });
  check('a normal employee cannot open the image (403)', imgEmp.status === 403);
  await new Promise((r) => { setTimeout(r, 600); });
  const rl = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ReadLog" WHERE "entity" = ? AND "entityId" = ?', 'Monitoring', shotId).catch(() => [{ n: 0 }]);
  check('every open is written in the read log', Number(rl[0].n) >= 1, rl[0]);

  console.log('The website add-on: the host is shown as the site');
  const yday = M.addDays(today, -1);
  const iso = (hm) => new Date(`${yday}T${hm}:00+05:30`).toISOString();
  const dev = { id: devA.id, employeeId: empA.id, approved: true, employee: { id: empA.id } };
  await M.ingest(dev, [{ appName: 'chrome', host: 'careers.example.com', windowTitle: 'Some page - Google Chrome', start: iso('12:00'), end: iso('12:04') }]);
  await M.ingest(dev, [{ appName: 'chrome', windowTitle: 'Jobs - Naukri Recruiter - Google Chrome', start: iso('12:10'), end: iso('12:14') }]);
  const det = await M.employeeDetail(empA.id, yday, yday);
  check('the add-on host is the exact website (careers.example.com)', det.apps.some((a) => a.name === 'careers.example.com' && a.kind === 'site'), det.apps.map((a) => a.name));
  check('with no host, the window title is still used (Naukri)', det.apps.some((a) => a.name === 'Naukri'), det.apps.map((a) => a.name));

  console.log('Retention: old screenshots (files + rows) go, recent ones stay');
  const oldShot = await SH.saveScreenshot(dev, jpeg(), { takenAt: new Date(Date.now() - 40 * 86400000).toISOString() });
  const newShot = await SH.saveScreenshot(dev, jpeg(), { takenAt: new Date().toISOString() });
  const oldPath = (await SH.openOne(oldShot.id)).path;
  const removed = await SH.cleanupShots(30);
  check('the 40-day-old screenshot is deleted, file and row', removed >= 1 && !(await SH.openOne(oldShot.id)) && !fs.existsSync(oldPath), { removed });
  check("today's screenshot is kept", !!(await SH.openOne(newShot.id)));

  console.log('History: per-day activity older than 1 year is deleted, newer is kept');
  const oldDay = M.addDays(today, -400); const keepDay = M.addDays(today, -10);
  const mk = (day, hm) => ({ deviceId: devA.id, employeeId: empA.id, appName: 'excel', windowTitle: null, startTime: new Date(`${day}T${hm}:00+05:30`), endTime: new Date(`${day}T${hm}:30+05:30`), durationSeconds: 1800, isIdle: false, isBreak: false, day });
  await prisma.activityLog.create({ data: mk(oldDay, '11:00') });
  await prisma.activityLog.create({ data: mk(keepDay, '11:00') });
  await M.purge();
  const oldLeft = await prisma.activityLog.count({ where: { employeeId: empA.id, day: oldDay } });
  const keepLeft = await prisma.activityLog.count({ where: { employeeId: empA.id, day: keepDay } });
  check('the 400-day-old row is gone', oldLeft === 0, { oldLeft });
  check('the 10-day-old row is kept', keepLeft >= 1, { keepLeft });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
