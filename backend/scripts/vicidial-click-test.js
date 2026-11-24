#!/usr/bin/env node
/**
 * VICIDIAL "CLICK TO DIAL" (2026-11-24): the Admin card (server, API user, encrypted password, On/Off, agent IDs), the "ViciDial" choice in
 * "Call using" (not connected yet while Off / without an agent ID), the dial answer (the one link, the number from the candidate record,
 * the right ViciDial agent API parameters), Test mode, BDE / Manager refused, scope, the call row in the history + the outcome, and the
 * password never in any other answer, never in the server's log, never in the audit.
 * The office ViciDial is NEVER contacted: a local HTTP stub on a random port stands in for it, and the sandbox server refuses to hand out a
 * dial link to any non-local address.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4321 node scripts/vicidial-click-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-vici-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4421;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'vici-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'vicidial-click-test-key', BROWSER_CALL_AMI_USER: '', BROWSER_CALL_AMI_SECRET: '', AI_VOICE_AMI_USER: '', AI_VOICE_AMI_SECRET: '',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const seen = []; // every answer text, except the one dial answer, is checked for the password
const call = async (method, url, body, token, { dial = false } = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* none */ }
  if (!(dial && r.status === 200)) seen.push({ url, text });
  return { status: r.status, body: j, text, headers: r.headers };
};
let server; let stub; let logs = '';
async function stop(code) {
  if (server) server.kill();
  if (stub) stub.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const PASS = `Vp#${P}-s3cret!x`; // a password with characters that must be URL-encoded

(async () => {
  // the ViciDial stand-in: records what reached it, answers like ViciDial's agent API
  const hits = [];
  stub = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('SUCCESS: external_dial function set - stub'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const STUB = `http://127.0.0.1:${stub.address().port}`;

  const mk = (tag, data) => prisma.user.create({ data: { name: `Vc ${tag} ${P}`, email: `vc.${tag}.${P}@vc-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const admin = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec2 = await mk('rectwo', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const mgr = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER' });
  const phone = `9${String(P).padStart(9, '7').slice(-9)}`;
  const other = `8${String(P).padStart(9, '3').slice(-9)}`;
  const cand = await prisma.candidate.create({ data: { name: `Vc Person ${P}`, phone, email: `vc.person.${P}@vc-test.in` } });
  const cand2 = await prisma.candidate.create({ data: { name: `Vc Other ${P}`, phone: other } });
  const client = await prisma.client.create({ data: { name: `Vc Client ${P}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Vc Job ${P}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `VC-${P}`.slice(0, 14), openings: 1 } });
  await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  await prisma.application.create({ data: { candidateId: cand2.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  // a candidate on another department's job: outside the IT recruiter's scope
  const clientX = await prisma.client.create({ data: { name: `Vc ClientX ${P}`, ownerDepartment: 'Non IT', agreementStatus: 'ACTIVE' } });
  const reqX = await prisma.requirement.create({ data: { title: `Vc JobX ${P}`, clientId: clientX.id, department: 'Non IT', status: 'RECRUITER_ASSIGNED', reqCode: `VX-${P}`.slice(0, 14), openings: 1 } });
  const candX = await prisma.candidate.create({ data: { name: `Vc Outside ${P}`, phone: `7${String(P).padStart(9, '5').slice(-9)}` } });
  await prisma.application.create({ data: { candidateId: candX.id, requirementId: reqX.id, stage: 'NEW' } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (b) => { logs += b.toString(); if (process.env.TEST_DEBUG) process.stdout.write(b); });
  server.stderr.on('data', (b) => { logs += b.toString(); if (process.env.TEST_DEBUG) process.stderr.write(b); });
  let up = false;
  for (let i = 0; i < 200 && !up; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    up = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    // eslint-disable-next-line no-await-in-loop
    if (!up) await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log(`FAIL  the sandbox server did not answer on port ${PORT} (set TEST_PORT)`); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 800); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(admin.id); const tR = await tok(rec.id); const tR2 = await tok(rec2.id); const tB = await tok(bde.id); const tM = await tok(mgr.id);

  // browser calling in Test mode, the candidate's number is the test number; BDE and Manager are even allowed to browser-call here (ViciDial still refuses them)
  const cf = await call('PUT', '/browser-calling/admin/config', { mode: 'Test', testNumbers: phone, kinds: ['admin', 'tl', 'recruiter', 'hr', 'bde', 'view'] }, tA);
  check('setup: browser calling in Test mode', cf.status === 200 && cf.body.mode === 'Test', cf.body);

  // ---- the card: Admin only
  check('a recruiter cannot open the ViciDial card', (await call('GET', '/browser-calling/vicidial/admin', null, tR)).status === 403);
  check('a recruiter cannot change the ViciDial card', (await call('PUT', '/browser-calling/vicidial/admin', { enabled: true }, tR)).status === 403);
  check('a recruiter cannot set an agent ID', (await call('PUT', `/browser-calling/vicidial/admin/agents/${rec.id}`, { agentUser: '1001' }, tR)).status === 403);
  const v0 = await call('GET', '/browser-calling/vicidial/admin', null, tA);
  check('the card starts Off, empty server, phone code 91, no password', v0.status === 200 && v0.body.settings.enabled === false && v0.body.settings.server === '' && v0.body.settings.phoneCode === '91' && v0.body.settings.hasPassword === false, v0.body && v0.body.settings);
  check('the card says the API user needs only the agent-API permission (external_dial)', /Agent API Access/.test(v0.body.settings.note) && /external_dial/.test(v0.body.settings.note));
  const pr0 = (v0.body.people || []).find((p) => p.userId === rec.id);
  check('the people list shows the recruiter with no agent ID ("not set")', pr0 && pr0.agentUser === null && pr0.mayCall === true, pr0);

  // ---- Off: shown "not connected yet", refused
  const st0 = await call('GET', '/browser-calling/status', null, tR);
  const vl0 = (st0.body.lines || []).find((l) => l.id === 'vicidial');
  check('Off: the call bar lists ViciDial, not pickable, "not connected yet"', vl0 && vl0.ready === false && /not connected yet/.test(vl0.reason), st0.body.lines);
  const cl0 = await call('GET', '/messaging/call-lines', null, tR);
  const cv0 = (cl0.body.lines || []).find((l) => l.id === 'vicidial');
  check('Off: the Call window lists ViciDial, not connected yet', cv0 && cv0.ready === false && /not connected yet/.test(cv0.reason || ''), cl0.body);
  const d0 = await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand.id }, tR);
  check('Off: a dial is refused (not connected yet)', d0.status === 409 && d0.body.code === 'VICIDIAL_OFF' && /not connected yet/.test(d0.body.error), d0.body);

  // ---- validation, switching on
  check('switching on with nothing filled in is refused', (await call('PUT', '/browser-calling/vicidial/admin', { enabled: true }, tA)).status === 400);
  check('a bad server address is refused', (await call('PUT', '/browser-calling/vicidial/admin', { server: 'http://198.51.100.7/agc/api.php?x=1' }, tA)).status === 400);
  check('a server address without http is refused', (await call('PUT', '/browser-calling/vicidial/admin', { server: '198.51.100.7' }, tA)).status === 400);
  check('a bad API user is refused', (await call('PUT', '/browser-calling/vicidial/admin', { apiUser: 'a b;c' }, tA)).status === 400);
  check('a bad phone code is refused', (await call('PUT', '/browser-calling/vicidial/admin', { phoneCode: '91x' }, tA)).status === 400);
  const sv = await call('PUT', '/browser-calling/vicidial/admin', { server: `${STUB}/`, apiUser: 'teamlinkapi', apiPass: PASS, phoneCode: '91' }, tA);
  check('the Admin saves server, API user and password: the answer has no password, only "stored"', sv.status === 200 && sv.body.settings.server === STUB && sv.body.settings.apiUser === 'teamlinkapi' && sv.body.settings.hasPassword === true && !sv.text.includes(PASS), sv.body && sv.body.settings);
  const rowPass = await prisma.$queryRawUnsafe('SELECT "value" FROM "ViciDialSetting" WHERE "key"=\'apiPass\'');
  check('the password is stored encrypted (enc:v1:), never in plain text', rowPass[0] && String(rowPass[0].value).startsWith('enc:v1:') && !String(rowPass[0].value).includes(PASS));
  const on = await call('PUT', '/browser-calling/vicidial/admin', { enabled: true }, tA);
  check('the Admin switches ViciDial On', on.status === 200 && on.body.settings.enabled === true, on.body);

  // ---- On, but no agent ID
  const st1 = await call('GET', '/browser-calling/status', null, tR);
  const vl1 = (st1.body.lines || []).find((l) => l.id === 'vicidial');
  check('On, no agent ID: still not pickable, "Ask an Admin to set your ViciDial agent ID"', vl1 && vl1.ready === false && /Ask an Admin to set your ViciDial agent ID/i.test(vl1.reason), vl1);
  const d1 = await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand.id }, tR);
  check('On, no agent ID: a dial is refused with "ask an Admin to set your ViciDial agent ID"', d1.status === 409 && d1.body.code === 'NO_AGENT_ID' && /ask an Admin to set your ViciDial agent ID/i.test(d1.body.error), d1.body);

  // ---- agent IDs
  check('a bad agent ID is refused', (await call('PUT', `/browser-calling/vicidial/admin/agents/${rec.id}`, { agentUser: '10 01;' }, tA)).status === 400);
  const ag = await call('PUT', `/browser-calling/vicidial/admin/agents/${rec.id}`, { agentUser: '1012' }, tA);
  check('the Admin sets the recruiter\'s agent ID 1012', ag.status === 200 && ag.body.agentUser === '1012', ag.body);
  const dup = await call('PUT', `/browser-calling/vicidial/admin/agents/${rec2.id}`, { agentUser: '1012' }, tA);
  check('the same agent ID for a second person is refused (one agent ID, one person)', dup.status === 409 && /already set for/.test(dup.body.error), dup.body);
  await call('PUT', `/browser-calling/vicidial/admin/agents/${rec2.id}`, { agentUser: '1013' }, tA);
  await call('PUT', `/browser-calling/vicidial/admin/agents/${bde.id}`, { agentUser: '2001' }, tA);
  await call('PUT', `/browser-calling/vicidial/admin/agents/${mgr.id}`, { agentUser: '2002' }, tA);
  const v1 = await call('GET', '/browser-calling/vicidial/admin', null, tA);
  check('the card lists the recruiter with 1012', (v1.body.people || []).some((p) => p.userId === rec.id && p.agentUser === '1012'));

  // ---- On + agent ID: pickable, the dial link
  const st2 = await call('GET', '/browser-calling/status', null, tR);
  const vl2 = (st2.body.lines || []).find((l) => l.id === 'vicidial');
  check('On + agent ID: ViciDial is pickable in the call bar', vl2 && vl2.ready === true, vl2);
  const cl2 = await call('GET', '/messaging/call-lines', null, tR);
  check('On + agent ID: ViciDial is pickable in the Call window', (cl2.body.lines || []).some((l) => l.id === 'vicidial' && l.ready === true), cl2.body.lines);
  const d2 = await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand.id, number: '9000000001', phone: '9000000001', to: '9000000001' }, tR, { dial: true });
  check('the dial answer: a call id and the dial link', d2.status === 200 && !!d2.body.callId && typeof d2.body.dialUrl === 'string', d2.body && { ...d2.body, dialUrl: d2.body.dialUrl ? '(link)' : null });
  check('the dial answer is never cached', /no-store/.test(d2.headers.get('cache-control') || ''));
  let u = null; try { u = new URL(d2.body.dialUrl); } catch { u = null; }
  const qp = u ? Object.fromEntries(u.searchParams.entries()) : {};
  check('the link goes to <server>/agc/api.php', u && `${u.origin}` === STUB && u.pathname === '/agc/api.php', d2.body.dialUrl && d2.body.dialUrl.replace(/pass=[^&]*/, 'pass=•••'));
  check('the link has ViciDial\'s agent API parameters: source, user, pass, agent_user, function=external_dial, phone_code, search/preview/focus',
    qp.source === 'teamlink' && qp.user === 'teamlinkapi' && qp.pass === PASS && qp.agent_user === '1012' && qp.function === 'external_dial' && qp.phone_code === '91' && qp.search === 'YES' && qp.preview === 'NO' && qp.focus === 'YES', { ...qp, pass: qp.pass === PASS ? '(right)' : '(wrong)' });
  check('the number is the candidate\'s, from the record (not the one the browser sent)', qp.value === phone && d2.body.number === phone, { value: qp.value });
  check('the answer says it is recorded in ViciDial', /Recorded in ViciDial/.test(d2.body.recording || ''));
  // the browser opening the link (here: the test itself) reaches the stand-in with the same parameters
  const sr = await fetch(d2.body.dialUrl).then((r) => r.text());
  const hit = hits.length ? new URL(hits[hits.length - 1], STUB) : null;
  check('the stand-in "ViciDial" got function=external_dial for agent 1012 and the candidate\'s number', /SUCCESS/.test(sr) && hit && hit.pathname === '/agc/api.php' && hit.searchParams.get('function') === 'external_dial' && hit.searchParams.get('agent_user') === '1012' && hit.searchParams.get('value') === phone);

  // ---- the call row + history + outcome
  const S = require('../src/browsercall/schema');
  const row = await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', d2.body.callId);
  check('the call row is written: line ViciDial, requested, by the recruiter, nothing recorded here', row && row.lineId === 'vicidial' && row.lineName === 'ViciDial' && row.status === 'requested' && row.userId === rec.id && row.toNumber === phone && row.recordingStatus === 'none' && row.recordingNote === 'Recorded in ViciDial' && !!row.processedAt, row);
  const h1 = await call('GET', `/browser-calling/candidates/${cand.id}/calls`, null, tR);
  const hr1 = (h1.body.rows || []).find((r) => r.id === d2.body.callId);
  check('the call is on the candidate\'s call history (ViciDial, requested by the recruiter, with the time)', hr1 && hr1.vicidial === true && hr1.lineName === 'ViciDial' && hr1.userName === rec.name && hr1.status === 'requested' && !!hr1.startAt, hr1);
  check('an outcome that is not in the list is refused', (await call('POST', `/browser-calling/vicidial/calls/${d2.body.callId}/outcome`, { outcome: 'Great' }, tR)).status === 400);
  check('another recruiter cannot set the outcome of this call', (await call('POST', `/browser-calling/vicidial/calls/${d2.body.callId}/outcome`, { outcome: 'Busy' }, tR2)).status === 404);
  const oc = await call('POST', `/browser-calling/vicidial/calls/${d2.body.callId}/outcome`, { outcome: 'Connected', note: 'Interested, sends CV today' }, tR);
  check('the recruiter sets the outcome: Connected + note', oc.status === 200 && oc.body.call.status === 'completed' && oc.body.call.outcomeNote === 'Connected · Interested, sends CV today', oc.body);
  const h2 = await call('GET', `/browser-calling/candidates/${cand.id}/calls`, null, tR);
  check('the history shows the outcome and the note', (h2.body.rows || []).some((r) => r.id === d2.body.callId && r.status === 'completed' && /Interested, sends CV today/.test(r.outcomeNote || '')));
  const d3 = await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand.id }, tR, { dial: true });
  const oc2 = await call('POST', `/browser-calling/vicidial/calls/${d3.body.callId}/outcome`, { outcome: 'Wrong number' }, tR);
  check('Wrong number is saved as a failed call with "Wrong number"', oc2.status === 200 && oc2.body.call.status === 'failed' && oc2.body.call.outcomeNote === 'Wrong number', oc2.body);
  check('the report counts the ViciDial line', ((await call('GET', '/browser-calling/report', null, tR)).body.lines || []).some((l) => l.lineName === 'ViciDial'));

  // ---- the rules
  const tm = await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand2.id }, tR);
  check('Test mode: a number that is not a test number is refused', tm.status === 403 && tm.body.code === 'TEST_MODE', tm.body);
  const sc = await call('POST', '/browser-calling/vicidial/dial', { candidateId: candX.id }, tR);
  check('a candidate outside the recruiter\'s scope is not found', sc.status === 404, sc.body);
  const db = await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand.id }, tB);
  check('a BDE is refused (limited view), even with an agent ID', db.status === 403 && !db.body.dialUrl, db.body);
  const dm = await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand.id }, tM);
  check('a Manager is refused (view only), even with an agent ID', dm.status === 403 && !dm.body.dialUrl, dm.body);
  const sB = await call('GET', '/browser-calling/status', null, tB);
  check('a BDE never sees ViciDial as pickable', !(sB.body.lines || []).some((l) => l.id === 'vicidial' && l.ready));
  const mc = await call('POST', '/messaging/call', { audience: 'candidates', id: cand.id, line: 'vicidial' }, tR);
  check('the server-side Call through TeamLink does not dial ViciDial (it is dialled from the browser)', mc.status >= 400 && !mc.text.includes(PASS), mc.body);
  // switched Off again: refused at once
  await call('PUT', '/browser-calling/vicidial/admin', { enabled: false }, tA);
  check('Off again: the dial is refused', (await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand.id }, tR)).status === 409);
  // the sandbox never hands out a link to a non-local ViciDial (a documentation address: nothing is contacted - this server never calls ViciDial)
  await call('PUT', '/browser-calling/vicidial/admin', { server: 'http://198.51.100.7', enabled: true }, tA);
  const sbx = await call('POST', '/browser-calling/vicidial/dial', { candidateId: cand.id }, tR);
  check('sandbox: no dial link for a non-local ViciDial address', sbx.status === 409 && sbx.body.code === 'SANDBOX' && !sbx.text.includes('198.51.100.7/agc'), sbx.body);
  await call('PUT', '/browser-calling/vicidial/admin', { server: STUB }, tA);

  // ---- the password: never in another answer, never in the log, never in the audit
  for (const x of [['GET', '/browser-calling/vicidial/admin'], ['GET', '/browser-calling/status'], ['GET', '/messaging/call-lines'], ['GET', `/browser-calling/candidates/${cand.id}/calls`], ['GET', `/browser-calling/calls/${d2.body.callId}`], ['GET', '/browser-calling/report']]) await call(x[0], x[1], null, tA); // eslint-disable-line no-await-in-loop
  const leaks = seen.filter((s) => s.text.includes(PASS) || s.text.includes(encodeURIComponent(PASS)));
  check(`the password is in no other answer (${seen.length} answers checked)`, leaks.length === 0, leaks.map((l) => l.url));
  const audits = await prisma.auditLog.findMany({ where: { OR: [{ action: { startsWith: 'ViciDial' } }] }, orderBy: { createdAt: 'asc' } });
  check('audit: "ViciDial dial requested" is written', audits.some((a) => a.action === 'ViciDial dial requested' && a.entityId === cand.id && /agent 1012/.test(a.toValue || '')), audits.map((a) => a.action));
  check('audit: settings and agent IDs are audited', audits.some((a) => a.action === 'ViciDial settings saved') && audits.some((a) => a.action === 'ViciDial agent ID set'));
  check('audit: the password is in no audit row', !audits.some((a) => `${a.fromValue || ''} ${a.toValue || ''}`.includes(PASS) || `${a.fromValue || ''} ${a.toValue || ''}`.includes(encodeURIComponent(PASS))));
  check('audit: the full number is not in the dial audit (masked)', !audits.some((a) => a.action === 'ViciDial dial requested' && (a.toValue || '').includes(phone)));
  await new Promise((r) => { setTimeout(r, 500); });
  check(`the server log never has the password (${logs.length} characters of log)`, !logs.includes(PASS) && !logs.includes(encodeURIComponent(PASS)));
  const VD = require('../src/browsercall/vicidial');
  check('maskUrl hides the password in a dial link', VD.maskUrl(d2.body.dialUrl).includes('pass=•••') && !VD.maskUrl(d2.body.dialUrl).includes(encodeURIComponent(PASS)));
  check('the local stand-in received the dial (the only "ViciDial" this test ever talks to)', hits.length >= 1 && hits.every((h) => h.startsWith('/agc/api.php?')));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
