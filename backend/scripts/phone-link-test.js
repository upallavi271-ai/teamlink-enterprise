#!/usr/bin/env node
/**
 * ANDROID PHONE LINK (founder 2026-11-24: manual calling through the Android phone with the SIM 9032321414, browsercall/phoneLink.js).
 * An Admin makes a one-use 6-digit pairing code; the TeamLink Phone app pairs with it and gets its own device key; it long-polls the server;
 * a recruiter's Call on "Mobile <number>" is queued for the phone; the phone reports dialing / ended (talk time from its call log) / failed;
 * the recruiter saves the call notes (status, remarks, follow-up date, next action) and a follow-up lands on the application.
 * Covers: roles, pairing (wrong / reused / expired code, rate limit), device key, Connected / Disconnected / Reconnecting / Device unavailable,
 * the call life cycle (completed, not answered, failed, cancelled, hang up from TeamLink), one call at a time, the long poll waking at once,
 * expiry of a call the phone never took, scope and Test-mode rules, the notes and follow-up, history and the TL's team report, unpairing.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database (no phone is touched; the "phone" is this script).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4321 node scripts/phone-link-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-phone-${process.pid}.db`);
const ETC = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-phone-etc-'));
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4321;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'phone-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'phone-test-key', BROWSER_CALL_LINES_PJSIP_FILE: path.join(ETC, 'pjsip_tl_lines.conf'), BROWSER_CALL_LINES_DIALPLAN_FILE: path.join(ETC, 'extensions_tl_lines.conf'),
  BROWSER_CALL_PJSIP_FILE: path.join(ETC, 'pjsip_browser_users.conf'), BROWSER_CALL_PJSIP_MAIN: path.join(ETC, 'pjsip.conf'), BROWSER_CALL_RELOAD_CMD: path.join(ETC, 'no-asterisk-here'),
  BROWSER_CALL_AMI_USER: '', BROWSER_CALL_AMI_SECRET: '', AI_VOICE_AMI_USER: '', AI_VOICE_AMI_SECRET: '', AI_VOICE_SIP_TRUNK: '', AI_VOICE_DIAL_VIA: '',
  BROWSER_CALL_REC_DIR: path.join(ETC, 'monitor'), UPLOAD_DIR: path.join(ETC, 'uploads'), FFMPEG_PATH: path.join(ETC, 'no-ffmpeg-here'), GROQ_API_KEY: '',
};
fs.mkdirSync(path.join(ETC, 'monitor'), { recursive: true });
Object.assign(process.env, env);
fs.writeFileSync(env.BROWSER_CALL_PJSIP_MAIN, '; test\n');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* none */ } return { status: r.status, body: j, text };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.rmSync(ETC, { recursive: true, force: true }); } catch { /* none */ } process.exit(code); }, 800);
}
const P = process.pid;
const ist = (days) => new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);

(async () => {
  const RUN = `${P}`;
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Pl ${tag} ${RUN}`, email: `pl.${tag}.${RUN}@pl-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `PL-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const admin = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name });
  const rec2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name });
  const rec3 = await mk('rec3', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'FIN', atsScopeDepartments: 'FIN' }, { department: 'FIN', tl: 'Somebody Else' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const mgr = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER' });
  const num = (lead, fill) => `${lead}${String(P).padStart(9, fill).slice(-9)}`;
  const phone = num(9, '7'); const phoneB = num(8, '3'); const phoneOut = num(7, '5'); const phoneNotTest = num(6, '8');
  const cand = await prisma.candidate.create({ data: { name: `Pl Person ${RUN}`, phone, email: `pl.p.${RUN}@pl-test.in` } });
  const candB = await prisma.candidate.create({ data: { name: `Pl Other ${RUN}`, phone: phoneB } });
  const candOut = await prisma.candidate.create({ data: { name: `Pl Hidden ${RUN}`, phone: phoneOut } });
  const candNT = await prisma.candidate.create({ data: { name: `Pl NotTest ${RUN}`, phone: phoneNotTest } });
  const client = await prisma.client.create({ data: { name: `Pl Client ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Pl Java Job ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `PL-${RUN}`.slice(0, 14), openings: 1 } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  await prisma.application.create({ data: { candidateId: candB.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  await prisma.application.create({ data: { candidateId: candNT.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  const clientF = await prisma.client.create({ data: { name: `Pl FinClient ${RUN}`, ownerDepartment: 'FIN', agreementStatus: 'ACTIVE' } });
  const reqF = await prisma.requirement.create({ data: { title: `Pl Fin Job ${RUN}`, clientId: clientF.id, department: 'FIN', status: 'RECRUITER_ASSIGNED', recruiterId: rec3.id, reqCode: `PF-${RUN}`.slice(0, 14), openings: 1 } });
  await prisma.application.create({ data: { candidateId: candOut.id, requirementId: reqF.id, ownerRecruiterId: rec3.id, stage: 'NEW' } });

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
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
  const tA = await tok(admin.id); const tT = await tok(tl.id); const tR = await tok(rec.id); const tR2 = await tok(rec2.id); const tR3 = await tok(rec3.id); const tB = await tok(bde.id); const tM = await tok(mgr.id);
  const S = require('../src/browsercall/schema');

  const cf = await call('PUT', '/browser-calling/admin/config', { mode: 'Test', testNumbers: `${phone}, ${phoneB}, ${phoneOut}`, kinds: ['admin', 'tl', 'recruiter', 'hr'] }, tA);
  check('setup: browser calling in Test mode (the candidate numbers are the test numbers)', cf.status === 200 && cf.body.mode === 'Test', cf.body);

  // ---- roles on the Admin screen
  for (const [who, t] of [['a recruiter', tR], ['a TL', tT], ['a BDE', tB], ['a Manager', tM]]) {
    // eslint-disable-next-line no-await-in-loop
    check(`${who} cannot open Android phones (Admin)`, (await call('GET', '/browser-calling/phone/admin', null, t)).status === 403);
  }
  const v0 = await call('GET', '/browser-calling/phone/admin', null, tA);
  check('Admin: no phone yet; the people list has recruiters and never a BDE or a Manager', v0.status === 200 && v0.body.devices.length === 0 && v0.body.people.some((p) => p.userId === rec.id) && !v0.body.people.some((p) => [bde.id, mgr.id].includes(p.userId)), v0.body && v0.body.people && v0.body.people.length);

  // ---- pairing code
  check('refused: a pairing code for a number that is not a mobile', (await call('POST', '/browser-calling/phone/admin/pair-code', { name: 'X', number: '12345', userIds: [rec.id] }, tA)).status === 400);
  const badU = await call('POST', '/browser-calling/phone/admin/pair-code', { name: 'X', number: '9032321414', userIds: [bde.id] }, tA);
  check('refused: giving the phone to a BDE', badU.status === 400 && /BDE/.test(badU.body.error), badU.body);
  check('a recruiter cannot make a pairing code', (await call('POST', '/browser-calling/phone/admin/pair-code', { name: 'X', number: '9032321414' }, tR)).status === 403);
  const pc = await call('POST', '/browser-calling/phone/admin/pair-code', { name: 'Office Android', number: '+91 90323 21414', userIds: [rec.id, tl.id] }, tA);
  check('Admin makes a 6-digit pairing code, valid ~10 minutes', pc.status === 200 && /^\d{6}$/.test(pc.body.code) && pc.body.number === '9032321414' && Date.parse(pc.body.expiresAt) - Date.now() > 9 * 60000, pc.body);
  const codeRow = await S.all('SELECT * FROM "PhoneLinkPairCode"');
  check('the code itself is not stored (only its hash)', codeRow.length >= 1 && !JSON.stringify(codeRow).includes(pc.body.code));

  // ---- the phone pairs
  const wrong = await call('POST', '/phone-link/pair', { code: pc.body.code === '000000' ? '111111' : '000000' });
  check('pair: a wrong code is refused', wrong.status === 400, wrong.body);
  const pr = await call('POST', '/phone-link/pair', { code: pc.body.code, model: 'realme RMX3231 (Android 11)', appVersion: '1.0' });
  check('pair: the right code gives the phone its own 64-hex device key', pr.status === 200 && /^[a-f0-9]{64}$/.test(pr.body.token) && pr.body.device.number === '9032321414', pr.body);
  const DK = pr.body.token; const devId = pr.body.device.id;
  check('pair: the code works only once', (await call('POST', '/phone-link/pair', { code: pc.body.code })).status === 400);
  const devRow = await S.all('SELECT * FROM "PhoneLinkDevice"');
  check('the device key is not stored (only its hash)', devRow.length === 1 && !JSON.stringify(devRow).includes(DK));
  check('a wrong device key is refused (401, UNPAIRED)', (await call('POST', '/phone-link/device/poll', { wait: 0 }, 'f'.repeat(64))).status === 401);

  // ---- several taps on Pair at once give ONE phone (seen live 2026-11-24: 6 rows)
  const pc2 = await call('POST', '/browser-calling/phone/admin/pair-code', { name: 'Burst', number: '9032321415', userIds: [] }, tA);
  const burst = await Promise.all([1, 2, 3, 4, 5, 6].map(() => call('POST', '/phone-link/pair', { code: pc2.body.code })));
  const okN = burst.filter((x) => x.status === 200).length;
  const burstRows = await S.all('SELECT "id" FROM "PhoneLinkDevice" WHERE "number"=\'9032321415\' AND "revokedAt" IS NULL');
  check('six taps on Pair at once: exactly one phone is paired', okN === 1 && burstRows.length === 1, { okN, rows: burstRows.length, codes: burst.map((x) => x.status) });
  await call('DELETE', `/browser-calling/phone/admin/devices/${burstRows[0] && burstRows[0].id}`, null, tA);

  // ---- status, lines
  const st0 = await call('POST', '/phone-link/device/poll', { wait: 0, state: { battery: 81, simReady: true, appPaused: false, missing: [], appVersion: '1.0' } }, DK);
  check('the phone polls: nothing to do yet', st0.status === 200 && !st0.body.call && st0.body.number === '9032321414' && st0.body.paused === false, st0.body);
  const adm = await call('GET', '/browser-calling/phone/admin', null, tA);
  const d0 = adm.body.devices[0];
  check('Admin sees the phone Connected, with model, battery and who may call', d0 && d0.status === 'connected' && d0.statusWord === 'Connected' && d0.battery === 81 && /realme/.test(d0.model) && d0.userNames.length === 2, d0);
  const sR = await call('GET', '/browser-calling/status', null, tR);
  const lineR = (sR.body.lines || []).find((l) => l.phone);
  check('the recruiter given the phone sees "Mobile 9032321414" in Call using, ready', lineR && lineR.name === 'Mobile 9032321414' && lineR.ready === true && lineR.phoneStatus === 'connected', sR.body.lines);
  const sR2 = await call('GET', '/browser-calling/status', null, tR2);
  check('a recruiter not given the phone does not see it', !(sR2.body.lines || []).some((l) => l.phone));
  const LINE = lineR.id;

  // ---- calls: scope / Test mode / not given
  check('refused: a candidate outside the recruiter\'s scope (404)', (await call('POST', '/browser-calling/phone/calls', { candidateId: candOut.id, lineId: LINE }, tR)).status === 404);
  const nt = await call('POST', '/browser-calling/phone/calls', { candidateId: candNT.id, lineId: LINE }, tR);
  check('refused in Test mode: a number not in the test list', nt.status === 403 && nt.body.code === 'TEST_MODE', nt.body);
  const ng = await call('POST', '/browser-calling/phone/calls', { candidateId: candB.id, lineId: LINE }, tR2);
  check('refused: a recruiter the phone is not given to', ng.status === 404 && ng.body.code === 'NO_PHONE', ng.body);
  check('refused: a BDE', (await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, lineId: LINE }, tB)).status === 403);

  // ---- 1) a completed call, the long poll waking at once
  const waitStart = Date.now();
  const pollP = call('POST', '/phone-link/device/poll', { wait: 20 }, DK);
  await new Promise((r) => { setTimeout(r, 700); });
  const c1 = await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, applicationId: app.id, lineId: LINE }, tR);
  check('recruiter presses Call on Mobile 9032321414: the call is queued (Call initiated)', c1.status === 200 && c1.body.callId && c1.body.line.name === 'Mobile 9032321414' && c1.body.number === phone, c1.body);
  const p1 = await pollP;
  check('the waiting poll answers at once with the call (number only, no candidate name)', p1.status === 200 && p1.body.call && p1.body.call.id === c1.body.callId && p1.body.call.number === phone && Date.now() - waitStart < 6000 && !JSON.stringify(p1.body).includes(cand.name), { ms: Date.now() - waitStart, body: p1.body });
  const r1a = await call('GET', `/browser-calling/calls/${c1.body.callId}`, null, tR);
  check('the call row: "Sent to the phone" (initiated), direction phone, not recorded', r1a.body.call.status === 'initiated' && r1a.body.call.direction === 'phone' && r1a.body.call.phone === true && r1a.body.call.recordingStatus === 'none', r1a.body.call);
  const busy = await call('POST', '/browser-calling/phone/calls', { candidateId: candB.id, lineId: LINE }, tT);
  check('one call at a time: the TL cannot use the phone while it is on a call', busy.status === 409 && busy.body.code === 'PHONE_BUSY', busy.body);
  check('the same recruiter cannot start a second phone call', (await call('POST', '/browser-calling/phone/calls', { candidateId: candB.id, lineId: LINE }, tR)).status === 409);
  check('notes cannot be saved while the call is on', (await call('POST', `/browser-calling/phone/calls/${c1.body.callId}/outcome`, { outcome: 'Connected' }, tR)).status === 409);
  const e1 = await call('POST', '/phone-link/device/event', { callId: c1.body.callId, event: 'dialing' }, DK);
  check('the phone says dialing: "On the phone" (calling)', e1.status === 200 && e1.body.status === 'calling', e1.body);
  check('another phone\'s key cannot report on this call', (await call('POST', '/phone-link/device/event', { callId: c1.body.callId, event: 'ended', durationSec: 9 }, 'a'.repeat(64))).status === 401);
  await S.run('UPDATE "BrowserCall" SET "startAt"=? WHERE "id"=?', new Date(Date.now() - 120000).toISOString(), c1.body.callId); // the call took 2 minutes
  const e2 = await call('POST', '/phone-link/device/event', { callId: c1.body.callId, event: 'ended', durationSec: 42, fromCallLog: true }, DK);
  const r1 = (await call('GET', `/browser-calling/calls/${c1.body.callId}`, null, tR)).body.call;
  check('ended with 42 s in the phone log: Call completed, talk time 42, answer time set', e2.status === 200 && r1.status === 'completed' && r1.talkSec === 42 && !!r1.answerAt, r1);
  const e2b = await call('POST', '/phone-link/device/event', { callId: c1.body.callId, event: 'ended', durationSec: 999 }, DK);
  const r1b = (await call('GET', `/browser-calling/calls/${c1.body.callId}`, null, tR)).body.call;
  check('a repeated "ended" does not change a finished call', e2b.status === 200 && r1b.talkSec === 42);
  // notes
  check('notes: an unknown next action is refused', (await call('POST', `/browser-calling/phone/calls/${c1.body.callId}/outcome`, { outcome: 'Connected', nextAction: 'Dance' }, tR)).status === 400);
  check('notes: a follow-up date in the past is refused', (await call('POST', `/browser-calling/phone/calls/${c1.body.callId}/outcome`, { outcome: 'Connected', followUpDate: ist(-2) }, tR)).status === 400);
  check('notes: another recruiter cannot save notes on this call', (await call('POST', `/browser-calling/phone/calls/${c1.body.callId}/outcome`, { outcome: 'Connected' }, tR2)).status === 404);
  const n1 = await call('POST', `/browser-calling/phone/calls/${c1.body.callId}/outcome`, { outcome: 'Not Answered', remarks: 'Interested, wants 6 LPA', followUpDate: ist(1), nextAction: 'Schedule interview' }, tR);
  check('notes saved: remarks, next action, follow-up date; a completed call stays completed whatever is picked', n1.status === 200 && n1.body.call.status === 'completed' && n1.body.call.remarks === 'Interested, wants 6 LPA' && n1.body.call.nextAction === 'Schedule interview' && n1.body.call.followUpAt === ist(1), n1.body);
  const fu = await prisma.applicationFollowUp.findFirst({ where: { applicationId: app.id, purpose: 'Phone call' } });
  check('a follow-up is added on the application for that date, owned by the recruiter', fu && fu.dueDate === ist(1) && fu.ownerUserId === rec.id && fu.nextAction === 'Schedule interview', fu);
  const hist = await call('GET', `/browser-calling/candidates/${cand.id}/calls`, null, tR);
  const h1 = hist.body.rows.find((x) => x.id === c1.body.callId);
  check('the candidate\'s call history shows the phone call with its notes', h1 && h1.lineName === 'Mobile 9032321414' && h1.talkSec === 42 && h1.remarks === 'Interested, wants 6 LPA', h1);

  // ---- 2) not answered
  const c2 = await call('POST', '/browser-calling/phone/calls', { candidateId: candB.id, lineId: LINE }, tR);
  const p2 = await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  await call('POST', '/phone-link/device/event', { callId: c2.body.callId, event: 'dialing' }, DK);
  await call('POST', '/phone-link/device/event', { callId: c2.body.callId, event: 'ended', durationSec: 0, fromCallLog: true }, DK);
  const r2 = (await call('GET', `/browser-calling/calls/${c2.body.callId}`, null, tR)).body.call;
  check('0 s in the phone log: Not answered / busy (missed), no talk time, never "connected"', p2.body.call && r2.status === 'missed' && r2.talkSec === 0 && !r2.answerAt && /Not answered/.test(r2.hangupReason), r2);
  const n2 = await call('POST', `/browser-calling/phone/calls/${c2.body.callId}/outcome`, { outcome: 'Busy', remarks: 'Line busy', followUpDate: ist(2) }, tR);
  check('notes on an unanswered call: Busy is kept; no application linked -> no follow-up, said plainly', n2.status === 200 && n2.body.call.status === 'busy' && !n2.body.followUp && /not linked/.test(n2.body.followUpSkipped || ''), n2.body);

  // ---- 3) the phone could not dial
  const c3 = await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, lineId: LINE }, tR);
  await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  await call('POST', '/phone-link/device/event', { callId: c3.body.callId, event: 'failed', reason: 'The app has no permission to make calls.' }, DK);
  const r3 = (await call('GET', `/browser-calling/calls/${c3.body.callId}`, null, tR)).body.call;
  check('the phone could not dial: Call failed with the phone\'s reason', r3.status === 'failed' && /no permission/.test(r3.hangupReason), r3);

  // ---- 4) cancelled before the phone took it; hang up from TeamLink while on the call
  const c4 = await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, lineId: LINE }, tR);
  const h4 = await call('POST', `/browser-calling/phone/calls/${c4.body.callId}/hangup`, null, tR);
  const p4 = await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  check('Cancel before the phone took it: cancelled, and the phone never gets it', h4.body.call.status === 'cancelled' && !p4.body.call, { h4: h4.body, p4: p4.body });
  const c5 = await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, lineId: LINE }, tR);
  await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  await call('POST', '/phone-link/device/event', { callId: c5.body.callId, event: 'dialing' }, DK);
  const h5 = await call('POST', `/browser-calling/phone/calls/${c5.body.callId}/hangup`, null, tR);
  const p5 = await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  check('Hang up while on the call: the phone is told to end that call', h5.status === 200 && Array.isArray(p5.body.hangup) && p5.body.hangup.includes(c5.body.callId), p5.body);
  await S.run('UPDATE "BrowserCall" SET "startAt"=? WHERE "id"=?', new Date(Date.now() - 60000).toISOString(), c5.body.callId);
  await call('POST', '/phone-link/device/event', { callId: c5.body.callId, event: 'ended', durationSec: 12 }, DK);
  const r5 = (await call('GET', `/browser-calling/calls/${c5.body.callId}`, null, tR)).body.call;
  check('...and its end comes from the phone (completed, 12 s)', r5.status === 'completed' && r5.talkSec === 12, r5);

  // ---- 5) a call the phone never took expires
  const c6 = await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, lineId: LINE }, tR);
  await S.run('UPDATE "BrowserCall" SET "startAt"=? WHERE "id"=?', new Date(Date.now() - 45000).toISOString(), c6.body.callId);
  const r6 = (await call('GET', '/browser-calling/phone/mine', null, tR)) && (await call('GET', `/browser-calling/calls/${c6.body.callId}`, null, tR)).body.call;
  check('a call the phone did not take within 30 s fails plainly ("did not take the call in time")', r6.status === 'failed' && /did not take the call in time/.test(r6.hangupReason), r6);

  // ---- 6) Disconnect / Connect / Reconnect from the ATS
  check('a recruiter the phone is not given to cannot disconnect it', (await call('POST', `/browser-calling/phone/devices/${devId}/disconnect`, null, tR2)).status === 404);
  const dc = await call('POST', `/browser-calling/phone/devices/${devId}/disconnect`, null, tR);
  check('Disconnect: the phone shows Disconnected', dc.status === 200 && dc.body.device.status === 'disconnected' && dc.body.device.statusWord === 'Disconnected', dc.body);
  const c7 = await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, lineId: LINE }, tR);
  check('...a call while disconnected is refused, with the reason', c7.status === 409 && /disconnected/i.test(c7.body.error), c7.body);
  const p7 = await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  check('...and the phone hears it is paused', p7.body.paused === true);
  const cn = await call('POST', `/browser-calling/phone/devices/${devId}/connect`, null, tR);
  check('Connect: back to Connected', cn.body.device.status === 'connected', cn.body);
  const rc = await call('POST', `/browser-calling/phone/devices/${devId}/reconnect`, null, tR);
  check('Reconnect is accepted', rc.status === 200 && rc.body.device.paused === false);
  check('an unknown action is refused', (await call('POST', `/browser-calling/phone/devices/${devId}/explode`, null, tR)).status === 400);

  // ---- 7) the states the phone reports
  await call('POST', '/phone-link/device/poll', { wait: 0, state: { missing: ['Call log (talk time)'], simReady: true } }, DK);
  const m1 = (await call('GET', '/browser-calling/phone/mine', null, tR)).body.devices[0];
  check('a missing permission on the phone: Device unavailable, naming it', m1.status === 'unavailable' && /Call log/.test(m1.statusWhy), m1);
  await call('POST', '/phone-link/device/poll', { wait: 0, state: { missing: [], simReady: false } }, DK);
  const m2 = (await call('GET', '/browser-calling/phone/mine', null, tR)).body.devices[0];
  check('no working SIM: Device unavailable', m2.status === 'unavailable' && /SIM/.test(m2.statusWhy), m2);
  await call('POST', '/phone-link/device/poll', { wait: 0, state: { simReady: true, appPaused: true } }, DK);
  const m3 = (await call('GET', '/browser-calling/phone/mine', null, tR)).body.devices[0];
  check('switched off in the phone app: Disconnected', m3.status === 'disconnected' && /phone app/.test(m3.statusWhy), m3);
  await call('POST', '/phone-link/device/poll', { wait: 0, state: { appPaused: false } }, DK);
  await S.run('UPDATE "PhoneLinkDevice" SET "lastSeenAt"=? WHERE "id"=?', new Date(Date.now() - 70000).toISOString(), devId);
  const m4 = (await call('GET', '/browser-calling/phone/mine', null, tR)).body.devices[0];
  check('no poll for 70 s: Reconnecting', m4.status === 'reconnecting', m4);
  await S.run('UPDATE "PhoneLinkDevice" SET "lastSeenAt"=? WHERE "id"=?', new Date(Date.now() - 10 * 60000).toISOString(), devId);
  const m5 = (await call('GET', '/browser-calling/phone/mine', null, tR)).body.devices[0];
  const c8 = await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, lineId: LINE }, tR);
  check('no poll for 10 min: Device unavailable, and a call is refused', m5.status === 'unavailable' && c8.status === 409 && /unavailable/i.test(c8.body.error), { m5, c8: c8.body });
  const sR5 = await call('GET', '/browser-calling/status', null, tR);
  const l5 = sR5.body.lines.find((l) => l.phone);
  check('Call using shows the phone greyed with the reason', l5 && l5.ready === false && /Device unavailable/.test(l5.reason), l5);
  await call('POST', '/phone-link/device/poll', { wait: 0, state: { simReady: true } }, DK);

  // ---- 8) reports: TL sees the team, recruiter own, Admin all
  const rT = await call('GET', '/browser-calling/report', null, tT);
  const rR = await call('GET', '/browser-calling/report', null, tR);
  const rR3 = await call('GET', '/browser-calling/report', null, tR3);
  const rA = await call('GET', '/browser-calling/report', null, tA);
  check('report: the TL sees the phone calls of their team', rT.status === 200 && rT.body.calls.some((c) => c.id === c1.body.callId), rT.body && rT.body.calls && rT.body.calls.length);
  check('report: the recruiter sees their own phone calls', rR.body.calls.some((c) => c.id === c1.body.callId) && rR.body.calls.every((c) => c.userId === rec.id));
  check('report: a recruiter of another team does not', !rR3.body.calls.some((c) => c.id === c1.body.callId));
  check('report: the Admin sees them, line "Mobile 9032321414" in the line totals', rA.body.calls.some((c) => c.id === c1.body.callId) && rA.body.lines.some((l) => l.lineName === 'Mobile 9032321414'));

  // ---- 8b) TALK IN TEAMLINK (bridge): the browser calls the phone on the office line, the phone answers, dials the candidate, merges
  await require('../src/browsercall/provision').extensionFor(rec.id); // the recruiter's browser extension (made when they open TeamLink)
  const nb = await call('POST', '/browser-calling/phone/bridge-calls', { candidateId: cand.id, applicationId: app.id, lineId: LINE }, tR);
  check('bridge refused while the phone is not set to "Talk in TeamLink"', nb.status === 409 && nb.body.code === 'NOT_BRIDGE', nb.body);
  check('a recruiter cannot switch "Talk in TeamLink" on', (await call('PUT', `/browser-calling/phone/admin/devices/${devId}`, { bridge: true }, tR)).status === 403);
  const bOn = await call('PUT', `/browser-calling/phone/admin/devices/${devId}`, { bridge: true }, tA);
  check('Admin switches "Talk in TeamLink" on for the phone', bOn.status === 200 && bOn.body.devices[0].bridge === true, bOn.body.devices && bOn.body.devices[0]);
  const lB = (await call('GET', '/browser-calling/status', null, tR)).body.lines.find((l) => l.phone);
  check('Call using shows the phone as "talk in TeamLink"', lB && lB.bridge === true && lB.typeLabel === 'talk in TeamLink' && lB.ready === true, lB);
  const b1 = await call('POST', '/browser-calling/phone/bridge-calls', { candidateId: cand.id, applicationId: app.id, lineId: LINE }, tR);
  check('bridge call: the browser is told to dial the PHONE on the office line, with a call token; the candidate number never reaches the browser', b1.status === 200 && b1.body.number === '9032321414' && /^[a-f0-9]{24}$/.test(b1.body.token) && b1.body.bridge === true && !JSON.stringify(b1.body).includes(phone), b1.body);
  const rb0 = (await call('GET', `/browser-calling/calls/${b1.body.callId}`, null, tR)).body.call;
  check('the call row: the candidate\'s number, an office-line call (recorded like office calls), bridge arming', rb0.number === phone && rb0.lineId === 'default' && rb0.bridge === true && rb0.bridgeStatus === 'arming' && rb0.lineName === 'Mobile 9032321414 (talk in TeamLink)' && rb0.recordingStatus !== 'none', rb0);
  check('one call at a time: a second bridge while this one runs is refused', (await call('POST', '/browser-calling/phone/bridge-calls', { candidateId: candB.id, lineId: LINE }, tT)).body.code === 'PHONE_BUSY');
  check('...and a phone call while it runs is refused too', (await call('POST', '/browser-calling/phone/calls', { candidateId: candB.id, lineId: LINE }, tT)).status === 409);
  const pb = await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  check('the phone hears "a bridge is coming": the call id and the candidate number to dial, answer within 60 s', pb.body.bridge && pb.body.bridge.id === b1.body.callId && pb.body.bridge.number === phone && pb.body.bridge.answerWithinSec === 60 && !JSON.stringify(pb.body).includes(cand.name), pb.body);
  const stepB = async (ev, extra = {}) => { await call('POST', '/phone-link/device/event', { callId: b1.body.callId, event: ev, bridge: true, ...extra }, DK); return (await call('GET', `/browser-calling/calls/${b1.body.callId}`, null, tR)).body.call; };
  check('the phone answered the office call: "answered"', (await stepB('bridge-answered')).bridgeStatus === 'answered');
  check('it dials the candidate: "dialing"', (await stepB('dialing')).bridgeStatus === 'dialing');
  check('the candidate answered: "connected"', (await stepB('candidate-answered')).bridgeStatus === 'connected');
  check('the two calls are joined: "merged"', (await stepB('merged')).bridgeStatus === 'merged');
  check('a bridge event cannot go backwards ("dialing" after "merged" is ignored)', (await stepB('dialing')).bridgeStatus === 'merged');
  check('the browser leg\'s own status is left to the phone system (not touched by the phone)', (await call('GET', `/browser-calling/calls/${b1.body.callId}`, null, tR)).body.call.status === 'initiated');
  await S.run('UPDATE "BrowserCall" SET "startAt"=? WHERE "id"=?', new Date(Date.now() - 180000).toISOString(), b1.body.callId);
  const be = await stepB('ended', { durationSec: 95 });
  check('ended: the candidate\'s talk time from the phone (95 s), bridge ended', be.bridgeStatus === 'ended' && be.bridgeTalkSec === 95, be);
  const legEnds = (id) => S.run('UPDATE "BrowserCall" SET "status"=\'completed\', "endAt"=? WHERE "id"=?', new Date().toISOString(), id); // the browser leg ends (Asterisk's Hangup event)
  await legEnds(b1.body.callId);
  // a bridge the candidate did not answer, then one the phone never picked up
  const b2 = await call('POST', '/browser-calling/phone/bridge-calls', { candidateId: cand.id, lineId: LINE }, tR);
  await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  for (const ev of ['bridge-answered', 'dialing']) await call('POST', '/phone-link/device/event', { callId: b2.body.callId, event: ev, bridge: true }, DK); // eslint-disable-line no-await-in-loop
  await call('POST', '/phone-link/device/event', { callId: b2.body.callId, event: 'ended', bridge: true, durationSec: 0 }, DK);
  const rb2 = (await call('GET', `/browser-calling/calls/${b2.body.callId}`, null, tR)).body.call;
  await legEnds(b2.body.callId);
  check('candidate did not answer: ended, 0 talk time, said plainly', b2.status === 200 && rb2.bridgeStatus === 'ended' && rb2.bridgeTalkSec === 0 && /did not answer/.test(rb2.bridgeNote || ''), rb2);
  const b3 = await call('POST', '/browser-calling/phone/bridge-calls', { candidateId: cand.id, lineId: LINE }, tR);
  await call('POST', '/phone-link/device/event', { callId: b3.body.callId, event: 'failed', bridge: true, reason: 'The SIM did not join the two calls (conference call is not available on this SIM / network).' }, DK);
  const rb3 = (await call('GET', `/browser-calling/calls/${b3.body.callId}`, null, tR)).body.call;
  await legEnds(b3.body.callId);
  check('the SIM cannot merge: failed with the phone\'s reason', rb3.bridgeStatus === 'failed' && /conference/.test(rb3.bridgeNote), rb3);
  const b4 = await call('POST', '/browser-calling/phone/bridge-calls', { candidateId: cand.id, lineId: LINE }, tR);
  await S.run('UPDATE "BrowserCall" SET "startAt"=? WHERE "id"=?', new Date(Date.now() - 90000).toISOString(), b4.body.callId);
  await call('GET', '/browser-calling/phone/mine', null, tR);
  await call('POST', '/phone-link/device/poll', { wait: 0 }, DK);
  const rb4 = (await call('GET', `/browser-calling/calls/${b4.body.callId}`, null, tR)).body.call;
  check('a bridge the phone never answered fails after ~75 s, saying why', b4.status === 200 && rb4.bridgeStatus === 'failed' && /did not answer the office line call/.test(rb4.bridgeNote), rb4);
  check('the phone\'s own number cannot be the candidate', (await prisma.candidate.update({ where: { id: candB.id }, data: { phone: '9032321414' } }).then(() => call('POST', '/browser-calling/phone/bridge-calls', { candidateId: candB.id, lineId: LINE }, tR))).status !== 200);
  await prisma.candidate.update({ where: { id: candB.id }, data: { phone: phoneB } });
  const bOff = await call('PUT', `/browser-calling/phone/admin/devices/${devId}`, { bridge: false }, tA);
  check('Admin switches "Talk in TeamLink" off again', bOff.body.devices[0].bridge === false);

  // ---- 9) Admin edits who may call, then unpairs
  const ed = await call('PUT', `/browser-calling/phone/admin/devices/${devId}`, { userIds: [rec2.id] }, tA);
  check('Admin gives the phone to another recruiter', ed.status === 200 && ed.body.devices[0].userIds.join() === rec2.id);
  check('...the first recruiter no longer sees it', !(await call('GET', '/browser-calling/status', null, tR)).body.lines.some((l) => l.phone));
  const c9 = await call('POST', '/browser-calling/phone/calls', { candidateId: cand.id, lineId: LINE }, tA); // an Admin may use any paired phone
  const un = await call('DELETE', `/browser-calling/phone/admin/devices/${devId}`, null, tA);
  const r9 = (await call('GET', `/browser-calling/calls/${c9.body.callId}`, null, tA)).body.call || { c9: c9.body };
  check('Unpair: the phone leaves the list and its queued call fails ("unpaired")', un.status === 200 && un.body.devices.length === 0 && r9.status === 'failed' && /unpaired/.test(r9.hangupReason), { un: un.body, r9 });
  check('...and its key stops working at once (401)', (await call('POST', '/phone-link/device/poll', { wait: 0 }, DK)).status === 401);

  // ---- 10) wrong codes are rate-limited
  let last = null;
  for (let i = 0; i < 11; i += 1) last = await call('POST', '/phone-link/pair', { code: String(100000 + i) }); // eslint-disable-line no-await-in-loop
  check('pairing: after 10 wrong codes from one address, it waits (429)', last.status === 429, last.body);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
