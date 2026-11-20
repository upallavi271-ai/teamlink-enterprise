#!/usr/bin/env node
/**
 * CALL LINES (utils/callLines.js, GET /api/messaging/call-lines, POST /api/messaging/call {line}) - founder 2026-11-16: the ATS Call window gets a dropdown:
 * API (calls & msgs), Dinstar (calls & msgs), SIP (call). Only API is connected so far; the other two are listed but refuse a call with a plain reason.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4061; nothing real is dialled.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/call-lines-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-call-lines-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" = 'telephony'");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" = 'telephony'"); // nothing connected to start with
dbx.close();

const net = require('net');
const AMI_PORT = 4062;
const asked = []; // every Originate the fake Asterisk was given
let amiAnswer = 'Success';
const fakeAmi = net.createServer((sock) => {
  sock.write('Asterisk Call Manager/5.0.1\r\n');
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
      const msg = Object.fromEntries(buf.slice(0, i).split('\r\n').map((l) => { const k = l.indexOf(': '); return [l.slice(0, k), l.slice(k + 2)]; }));
      buf = buf.slice(i + 4);
      if (msg.Action === 'Originate') asked.push(msg);
      const ok = msg.Action === 'Login' ? (msg.Secret === 'zz-ami-secret') : (msg.Action !== 'Originate' || amiAnswer === 'Success');
      sock.write(`Response: ${ok ? 'Success' : 'Error'}\r\nActionID: ${msg.ActionID}\r\nMessage: ${ok ? 'ok' : 'Originate failed'}\r\n\r\n`);
    }
  });
  sock.on('error', () => {});
});
fakeAmi.listen(AMI_PORT, '127.0.0.1');

const PORT = Number(process.env.TEST_PORT) || 4061;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'call-lines-test', INTEGRATION_SECRET_KEY: 'zz-call-lines-test-key', AI_VOICE_AMI_HOST: '127.0.0.1', AI_VOICE_AMI_PORT: String(AMI_PORT), AI_VOICE_AMI_USER: 'teamlink', AI_VOICE_AMI_SECRET: 'zz-ami-secret', AI_VOICE_SIP_TRUNK: 'teamlink-gw', AI_VOICE_PHONE_MODE: 'Test', AI_VOICE_TEST_NUMBERS: '9100654424', AI_VOICE_DIAL_FORMAT: '10', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let auth = {};
const call = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  fakeAmi.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  auth = { Authorization: `Bearer ${jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' })}` };

  console.log('1. The list the dropdown shows');
  const L = await call('GET', '/messaging/call-lines');
  const lines = (L.body && L.body.lines) || [];
  check('three lines, in this order: API, Dinstar, SIP', L.status === 200 && lines.map((x) => x.id).join(',') === 'api,dinstar,sip', L.body);
  check('they are worded as asked: "API (calls & msgs)", "Dinstar (calls & msgs)", "SIP (call)"', lines.map((x) => x.text).join(' | ') === 'API (calls & msgs) | Dinstar (calls & msgs) | SIP (call)', lines.map((x) => x.text));
  check('SIP is calls only; API and Dinstar carry messages too', lines[2].supports.join() === 'Calls' && lines[0].supports.includes('Messages') && lines[1].supports.includes('Messages'));
  check('Dinstar is not connected yet and says so plainly', !lines[1].ready && /Dinstar is not connected yet/.test(lines[1].reason), lines[1]);
  check('SIP is READY (the Asterisk login and the SIM gateway line are set on this server), whatever the AI phone mode is (the server here is in Test mode)', lines[2].ready === true && !/Test mode/.test(lines[2].note || ''), lines[2]);
  check('with the calling API not connected, SIP is the first ready line and the default', !lines[0].ready && L.body.default === 'sip', L.body);

  console.log('2. A call on a line that is not connected is refused with the reason (nothing is dialled)');
  const lib = require('../src/utils/callLines');
  const d = await lib.startCall('dinstar', { agent: '9000000001', to: '9000000002', ref: 'x', callbackBase: null });
  check('Dinstar: refused, notConfigured, with the Dinstar words', d.ok === false && d.notConfigured === true && /Dinstar is not connected yet/.test(d.error) && d.line === 'dinstar', d);
  const sipTest = await lib.startCall('sip', { agent: '9000000001', to: '9000000002', ref: 'x', callbackBase: null });
  check('a RECRUITER call on SIP is not held back by the AI phone Test mode: any valid number goes to Asterisk', sipTest.ok === true && asked.length === 1, [sipTest, asked.length]);
  const sipOk = await lib.startCall('sip', { agent: '9000000001', to: '9100654424', ref: 'x', callbackBase: null });
  check('SIP: the next call goes to Asterisk too', sipOk.ok === true && sipOk.line === 'sip' && asked.length === 2, sipOk);
  const o = asked[asked.length - 1] || {};
  check('Asterisk is asked to ring the CALLER first on the gateway trunk (PJSIP/<caller>@teamlink-gw)', o.Channel === 'PJSIP/9000000001@teamlink-gw', o);
  check('and, when answered, to dial the person on the same trunk (Application Dial, no dialplan change)', o.Application === 'Dial' && /^PJSIP\/9100654424@teamlink-gw,\d+$/.test(o.Data || ''), o);
  amiAnswer = 'Error';
  const sipRefused = await lib.startCall('sip', { agent: '9000000001', to: '9100654424', ref: 'x', callbackBase: null });
  check('Asterisk refusing the call is reported plainly, not pretended', sipRefused.ok === false && /Asterisk refused the call/.test(sipRefused.error), sipRefused);
  amiAnswer = 'Success';
  const sipBadAgent = await lib.startCall('sip', { agent: 'abc', to: '9100654424', ref: 'x', callbackBase: null });
  check('a caller number that is not a number is refused before Asterisk is asked', sipBadAgent.ok === false && sipBadAgent.invalid === true && asked.length === 3, sipBadAgent);
  const u = await lib.startCall('nonsense', { agent: '9000000001', to: '9000000002', ref: 'x', callbackBase: null });
  check('an unknown line is treated as the API line (never an error of its own)', u.line === 'api', u);
  const none = await lib.startCall(undefined, { agent: '9000000001', to: '9000000002', ref: 'x', callbackBase: null });
  check('no line given is the API line (the old behaviour, so the bulk call queue and old screens still work)', none.line === 'api', none);

  console.log('3. The route');
  const cand = await prisma.candidate.findFirst({ where: { phone: { not: null } }, select: { id: true } });
  if (cand) {
    await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false } });
    const r = await call('POST', '/messaging/call', { audience: 'candidates', id: cand.id, line: 'dinstar' });
    check('POST /messaging/call with line dinstar is refused, not pretended (409 with a reason)', [409, 403].includes(r.status) && !!(r.body && r.body.error), r);
  } else check('(no candidate with a number in this copy: route check skipped)', true);
  const noAuth = await fetch(`${API}/messaging/call-lines`);
  check('the list needs a login', noAuth.status === 401);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
