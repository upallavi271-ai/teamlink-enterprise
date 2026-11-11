#!/usr/bin/env node
/**
 * Employee Monitoring: the same key / button over and over (agent 2.5, utils/monitoringInput.js, POST /api/monitoring/input).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4074.
 *   node scripts/monitoring-input-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-mon-input-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4074;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', AI_VOICE_GATEWAY: '0', PORT: String(PORT), JWT_SECRET: 'mon-input', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const prisma = require('../src/db');
const M = require('../src/utils/monitoring');
const MI = require('../src/utils/monitoringInput');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  const emp = await prisma.employee.findFirst({ where: { employmentStatus: 'Active' } });
  const { token, device } = await M.registerDevice({ employeeId: emp.id, deviceName: 'ZZ test PC', os: 'Windows' });
  const s = await M.settings();
  await M.recordConsent(emp.id, s.policyVersion, '127.0.0.1', 'Test');
  console.log('employee:', emp.name);

  console.log('The notice says it');
  check('the notice tells about key and click counts', /keyboard and mouse are used/.test(s.policyText) && /never recorded/.test(s.policyText), s.policyText.slice(0, 200));

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${API}/health`).then((x) => x.ok).catch(() => false)) break; // eslint-disable-line no-await-in-loop
    await new Promise((x) => { setTimeout(x, 500); }); // eslint-disable-line no-await-in-loop
  }
  // today, 11:00 IST onwards: 15 minutes of Space, 5 minutes of left clicks (too short to show), one minute of something else
  const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const at = (hhmm) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
  const minutes = [];
  for (let m = 0; m < 15; m += 1) minutes.push({ at: at(`11:${String(m).padStart(2, '0')}`), kind: 'key', key: 'Space', count: 300 });
  for (let m = 0; m < 5; m += 1) minutes.push({ at: at(`12:${String(m).padStart(2, '0')}`), kind: 'click', key: 'Left click', count: 60 });
  minutes.push({ at: at('13:00'), kind: 'nonsense', key: 'x', count: 1 });
  const post = async (body, tok = token) => {
    const r = await fetch(`${API}/monitoring/input`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Device ${tok}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  console.log('The agent sends its flagged minutes');
  const r1 = await post({ minutes });
  check('saved the 20 real minutes, refused the unknown kind', r1.status === 200 && r1.body.saved === 20 && r1.body.skipped === 1, r1);
  const r2 = await post({ minutes: minutes.slice(0, 3) });
  check('the same minutes again are not saved twice', r2.status === 200 && r2.body.saved === 0, r2);
  const r3 = await post({ minutes }, 'not-a-token');
  check('an unknown PC is refused', r3.status === 401, r3.status);

  console.log('What HR sees');
  const st = (await MI.stretches([emp.id], day)).get(emp.id) || [];
  check('one stretch of 10+ minutes (the 5 clicks are too short)', st.length === 1 && st[0].minutes === 15 && st[0].kind === 'key' && st[0].key === 'Space', st);
  check('it reads plainly, with the time', /"Space" pressed again and again/.test(st[0] && st[0].label) && /11:00/.test(st[0] && st[0].fromTime) && /11:15/.test(st[0] && st[0].toTime), st[0]);
  const ov = await M.overview(day, null);
  const row = ov.rows.find((x) => x.employeeId === emp.id);
  check('the overview row carries it', row && row.repeat && row.repeat.minutes === 15 && /Space/.test(row.repeat.top), row && row.repeat);
  const det = await M.employeeDetail(emp.id, day, day);
  check('the day view lists it', det && det.repeats && det.repeats.length === 1 && det.repeats[0].presses === 4500, det && det.repeats);

  console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
