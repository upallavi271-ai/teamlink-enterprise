#!/usr/bin/env node
/**
 * ONE SIM NUMBER PER RECRUITER (founder 2026-11-25): an Admin lists the Synway GSM ports (port, SIM number, operator, on/off) and gives each
 * to at most one person; with "Port prefix routing" ON a person's browser call on the office Synway goes out as Dial(PJSIP/<prefix><number>@teamlink-gw);
 * a call back to that SIM rings the person's browser extension ([tl-from-gateway], generated); a missed one leaves a bell notice, a row in the
 * candidate's call history and (Admin switch) a "Call back" follow-up; a TL sees the missed calls of their team.
 * Covers: port CRUD + one-to-one assignment, the exact generated dialplan (prefix routing OFF / ON, the inbound context), the server picking the
 * recruiter's prefix, an unassigned recruiter unchanged, inbound lookup by the called number -> the right extension, caller -> candidate (scoped),
 * the missed-call notice + history + optional task, the report, roles refused.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database; the "Asterisk" files go to a temp folder (no phone system is touched).
 * Asterisk's AMI events are fed to browsercall/events.js inside this process (same database copy).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4321 node scripts/sim-per-recruiter-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-sims-${process.pid}.db`);
const ETC = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-sims-etc-'));
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4321;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'sims-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'sims-test-key', BROWSER_CALL_LINES_PJSIP_FILE: path.join(ETC, 'pjsip_tl_lines.conf'), BROWSER_CALL_LINES_DIALPLAN_FILE: path.join(ETC, 'extensions_tl_lines.conf'),
  BROWSER_CALL_PJSIP_FILE: path.join(ETC, 'pjsip_browser_users.conf'), BROWSER_CALL_PJSIP_MAIN: path.join(ETC, 'pjsip.conf'), BROWSER_CALL_RELOAD_CMD: path.join(ETC, 'no-asterisk-here'),
  BROWSER_CALL_AMI_USER: '', BROWSER_CALL_AMI_SECRET: '', AI_VOICE_AMI_USER: '', AI_VOICE_AMI_SECRET: '', AI_VOICE_SIP_TRUNK: '', AI_VOICE_DIAL_VIA: '',
  BROWSER_CALL_REC_DIR: path.join(ETC, 'monitor'), UPLOAD_DIR: path.join(ETC, 'uploads'), FFMPEG_PATH: path.join(ETC, 'no-ffmpeg-here'),
  BROWSER_CALL_FAKE_STT: '', BROWSER_CALL_FAKE_AI: '1', GROQ_API_KEY: '', AI_VOICE_WHISPER_URL: '',
};
delete env.BROWSER_CALL_SIMS_DIALPLAN_FILE; // the default: next to extensions_tl_lines.conf
fs.mkdirSync(path.join(ETC, 'monitor'), { recursive: true });
Object.assign(process.env, env);
delete process.env.BROWSER_CALL_SIMS_DIALPLAN_FILE;
fs.writeFileSync(env.BROWSER_CALL_PJSIP_MAIN, '; test\n');
const SIMS_FILE = path.join(ETC, 'extensions_tl_sims.conf');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* none */ } return { status: r.status, body: j, text };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.rmSync(ETC, { recursive: true, force: true }); } catch { /* none */ } process.exit(code); }, 800);
}
const P = process.pid;
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const has = (text, lines) => { const t = text.split('\n'); let i = -1; for (const l of lines) { const j = t.indexOf(l, i + 1); if (j < 0) return l; i = j; } return true; };

(async () => {
  const RUN = `${P}`;
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Sm ${tag} ${RUN}`, email: `sm.${tag}.${RUN}@sm-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `SM-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const admin = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name });
  const rec2 = await mk('rec2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name });
  const rec3 = await mk('rec3', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'FIN', atsScopeDepartments: 'FIN' }, { department: 'FIN', tl: 'Somebody Else' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const mgr = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER' });
  const num = (lead, fill) => `${lead}${String(P).padStart(9, fill).slice(-9)}`;
  const phone = num(9, '7'); const phoneB = num(8, '3'); const phoneOut = num(7, '5');
  const SIM1 = num(9, '1'); const SIM2 = num(8, '2'); const SIM3 = num(7, '4');
  const cand = await prisma.candidate.create({ data: { name: `Sm Person ${RUN}`, phone, email: `sm.p.${RUN}@sm-test.in` } });
  const candB = await prisma.candidate.create({ data: { name: `Sm Other ${RUN}`, phone: phoneB } });
  const candOut = await prisma.candidate.create({ data: { name: `Sm Hidden ${RUN}`, phone: phoneOut } });
  const client = await prisma.client.create({ data: { name: `Sm Client ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Sm Java Job ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `SM-${RUN}`.slice(0, 14), openings: 1 } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  const reqB = await prisma.requirement.create({ data: { title: `Sm Tester Job ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec2.id, reqCode: `SB-${RUN}`.slice(0, 14), openings: 1 } });
  await prisma.application.create({ data: { candidateId: candB.id, requirementId: reqB.id, ownerRecruiterId: rec2.id, stage: 'NEW' } });
  const clientF = await prisma.client.create({ data: { name: `Sm FinClient ${RUN}`, ownerDepartment: 'FIN', agreementStatus: 'ACTIVE' } });
  const reqF = await prisma.requirement.create({ data: { title: `Sm Fin Job ${RUN}`, clientId: clientF.id, department: 'FIN', status: 'RECRUITER_ASSIGNED', recruiterId: rec3.id, reqCode: `SF-${RUN}`.slice(0, 14), openings: 1 } });
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
  const L = require('../src/browsercall/lines');
  const SIMS = require('../src/browsercall/sims');
  const events = require('../src/browsercall/events');
  const REC = require('../src/browsercall/recording');

  const cf = await call('PUT', '/browser-calling/admin/config', { mode: 'Test', testNumbers: `${phone}, ${phoneB}`, kinds: ['admin', 'tl', 'recruiter', 'hr'] }, tA);
  check('setup: browser calling in Test mode (the candidate numbers are the test numbers)', cf.status === 200 && cf.body.mode === 'Test', cf.body);

  // ---- roles
  for (const [who, t] of [['a recruiter', tR], ['a TL', tT], ['a BDE', tB], ['a Manager', tM]]) {
    // eslint-disable-next-line no-await-in-loop
    const a = await call('GET', '/browser-calling/admin/sims', null, t); const b = await call('POST', '/browser-calling/admin/sims', { port: 9, simNumber: SIM3 }, t);
    check(`${who} cannot see or add SIM ports (Admin only)`, a.status === 403 && b.status === 403, [a.status, b.status]);
  }
  check('a recruiter cannot change the SIM settings', (await call('PUT', '/browser-calling/admin/sims-settings', { prefixRouting: true }, tR)).status === 403);

  // ---- port CRUD + validation
  const v0 = await call('GET', '/browser-calling/admin/sims', null, tA);
  check('Admin: the SIM list starts empty, prefix routing OFF, "Call back" task OFF, no fallback', v0.status === 200 && v0.body.sims.length === 0 && v0.body.settings.prefixRouting === false && v0.body.settings.missedTask === false && !v0.body.settings.fallbackUserId && v0.body.portMax === 16, v0.body && v0.body.settings);
  const bad = async (b) => (await call('POST', '/browser-calling/admin/sims', b, tA)).status;
  check('refused: port 0', await bad({ port: 0, simNumber: SIM1 }) === 400);
  check('refused: port 17 (an SMG4016 has 16)', await bad({ port: 17, simNumber: SIM1 }) === 400);
  check('refused: not a mobile number', await bad({ port: 1, simNumber: '12345' }) === 400);
  check('refused: a dial prefix with letters', await bad({ port: 1, simNumber: SIM1, dialPrefix: '0a#' }) === 400);
  check('refused: a port tag that starts with a digit', await bad({ port: 1, simNumber: SIM1, matchBy: 'tag', tag: '1port' }) === 400);
  check('refused: an unknown match kind', await bad({ port: 1, simNumber: SIM1, matchBy: 'imsi' }) === 400);
  // ---- 2026-11-24: a port can be given before its SIM number is known (matched by its port tag)
  const n14 = await call('POST', '/browser-calling/admin/sims', { port: 14, simNumber: '', operator: 'Airtel', matchBy: 'number' }, tA);
  const n15 = await call('POST', '/browser-calling/admin/sims', { port: 15, operator: 'Airtel' }, tA);
  const s14 = n14.body && n14.body.sims && n14.body.sims.find((x) => x.port === 14);
  check('a port without its SIM number is saved, matched by its port tag', n14.status === 201 && n15.status === 201 && s14 && s14.simNumber === null && s14.matchBy === 'tag' && s14.tag === 'port14' && s14.dialPrefix === '14#', n14.body);
  const r14 = await call('GET', '/browser-calling/admin/sims/route?called=port14', null, tA);
  check('...a call to "port14" finds port 14', r14.status === 200 && r14.body.port === 14, r14.body);
  for (const x of (n15.body.sims || []).filter((y) => y.port >= 14)) await call('DELETE', `/browser-calling/admin/sims/${x.id}`, null, tA);
  const c1 = await call('POST', '/browser-calling/admin/sims', { port: 1, simNumber: `+91 ${SIM1}`, operator: 'Jio' }, tA);
  const p1 = c1.body && c1.body.sims && c1.body.sims.find((x) => x.port === 1);
  check('Admin adds port 1: number kept as 10 digits, defaults prefix "01#", tag "port01", matched by SIM number, on', c1.status === 201 && p1 && p1.simNumber === SIM1 && p1.dialPrefix === '01#' && p1.tag === 'port01' && p1.matchBy === 'number' && p1.active === true && p1.operator === 'Jio', c1.body);
  check('refused: the same port twice', await bad({ port: 1, simNumber: SIM2 }) === 409);
  check('refused: the same SIM number on two ports', await bad({ port: 3, simNumber: SIM1 }) === 409);
  const c2 = await call('POST', '/browser-calling/admin/sims', { port: 2, simNumber: SIM2, operator: 'Airtel', matchBy: 'tag' }, tA);
  const p2 = c2.body && c2.body.sims.find((x) => x.port === 2);
  check('Admin adds port 2 matched by its tag (port02)', c2.status === 201 && p2 && p2.matchBy === 'tag' && p2.tag === 'port02' && p2.dialPrefix === '02#', c2.body);
  const c3 = await call('POST', '/browser-calling/admin/sims', { port: 3, simNumber: SIM3, operator: 'Vi', dialPrefix: '9903' }, tA);
  const p3 = c3.body && c3.body.sims.find((x) => x.port === 3);
  check('Admin adds port 3 with its own dial prefix 9903', c3.status === 201 && p3 && p3.dialPrefix === '9903');
  check('refused: a tag already used by another port', (await call('PUT', `/browser-calling/admin/sims/${p3.id}`, { matchBy: 'tag', tag: 'port02' }, tA)).status === 409);

  // ---- one-to-one assignment
  const a1 = await call('PUT', `/browser-calling/admin/sims/${p1.id}`, { userId: rec.id }, tA);
  const recExt = (await S.one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=?', rec.id) || {}).extension;
  check('port 1 -> the recruiter; their browser extension is made for it', a1.status === 200 && a1.body.sims.find((x) => x.port === 1).userId === rec.id && /^\d{4,}$/.test(String(recExt)) && a1.body.sims.find((x) => x.port === 1).extension === recExt, a1.body);
  const a2 = await call('PUT', `/browser-calling/admin/sims/${p2.id}`, { userId: rec.id }, tA);
  check('refused: a second port for the same recruiter (one SIM per person)', a2.status === 409 && /already has port 1/.test(a2.body.error), a2.body);
  const a3 = await call('PUT', `/browser-calling/admin/sims/${p2.id}`, { userId: rec2.id }, tA);
  check('port 2 -> another recruiter', a3.status === 200);
  check('refused: a BDE never gets a SIM', (await call('PUT', `/browser-calling/admin/sims/${p3.id}`, { userId: bde.id }, tA)).status === 400);
  check('refused: a Manager (view only) never gets a SIM', (await call('PUT', `/browser-calling/admin/sims/${p3.id}`, { userId: mgr.id }, tA)).status === 400);
  check('refused: an unknown person', (await call('PUT', `/browser-calling/admin/sims/${p3.id}`, { userId: 'nobody-here' }, tA)).status === 400);
  const rec2Ext = (await S.one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=?', rec2.id) || {}).extension;
  const audit = await prisma.auditLog.findMany({ where: { action: { in: ['SIM port added', 'SIM port assigned'] }, userId: admin.id } }).catch(() => []);
  check('the audit log has the ports added and assigned, without the full SIM number', audit.length >= 4 && audit.every((x) => !String(x.toValue || '').includes(SIM1) && !String(x.toValue || '').includes(SIM2)), audit.map((x) => x.toValue));

  // ---- the generated files: prefix routing OFF
  const plain = L.renderDialplan([], { record: true });
  const dpOff = read(env.BROWSER_CALL_LINES_DIALPLAN_FILE);
  check('prefix routing OFF: extensions_tl_lines.conf is exactly today\'s text (no p01, default dials teamlink-gw)', dpOff.replace(/\r/g, '') === plain && !/exten => p01/.test(dpOff) && dpOff.includes(' same => n,Dial(PJSIP/${ARG1}@teamlink-gw,45)'), dpOff.slice(0, 900));
  const inb = read(SIMS_FILE);
  const inLines = [
    '[tl-from-gateway]',
    `exten => ${SIM1},1,Goto(tl-sim-ring,p01,1)`, `exten => 0${SIM1},1,Goto(tl-sim-ring,p01,1)`, `exten => 91${SIM1},1,Goto(tl-sim-ring,p01,1)`, `exten => +91${SIM1},1,Goto(tl-sim-ring,p01,1)`,
    'exten => port02,1,Goto(tl-sim-ring,p02,1)',
    'exten => _X.,1,Goto(tl-sim-ring,other,1)', 'exten => _+X.,1,Goto(tl-sim-ring,other,1)', 'exten => _[a-z].,1,Goto(tl-sim-ring,other,1)', 'exten => s,1,Goto(tl-sim-ring,other,1)',
    '[tl-sim-ring]',
    `exten => p01,1,NoOp(TeamLink SIM port 01 - Sm rec ${RUN})`, ' same => n,Set(TLPORT=01)', ` same => n,Set(TLEXT=${recExt})`, ' same => n,Goto(ring,1)',
    `exten => p02,1,NoOp(TeamLink SIM port 02 - Sm rec2 ${RUN})`, ' same => n,Set(TLPORT=02)', ` same => n,Set(TLEXT=${rec2Ext})`, ' same => n,Goto(ring,1)',
    'exten => other,1,NoOp(TeamLink: unknown number or a port with nobody on it - hang up as before)', ' same => n,Hangup()',
    'exten => ring,1,GotoIf($["${CHANNEL(endpoint)}"!="teamlink-gw"]?nobody,1)',
    ' same => n,Set(TLTOKEN=in${FILTER(0-9,${UNIQUEID})})',
    ' same => n,UserEvent(TLInbound,Token: ${TLTOKEN},Port: ${TLPORT},Ext: ${TLEXT})',
    ' same => n,Set(CALLERID(name)=TeamLink)', ' same => n,Set(CALLERID(num)=${TLTOKEN})',
    ` same => n,MixMonitor(${env.BROWSER_CALL_REC_DIR.replace(/[^A-Za-z0-9/._-]/g, '')}/\${FILTER(a-z0-9,\${TLTOKEN})}.wav,b)`,
    ' same => n,Dial(PJSIP/${TLEXT},30)',
    ' same => n,UserEvent(TLInbound,Token: ${TLTOKEN},Missed: 1,DialStatus: ${DIALSTATUS})',
    ' same => n,Hangup()',
    'exten => nobody,1,NoOp(TeamLink: not from the office Synway - hang up as before)', ' same => n,Hangup()',
  ];
  const hi = has(inb.replace(/\r/g, ''), inLines);
  check('the inbound context [tl-from-gateway] + [tl-sim-ring] is written with the exact lines (number variants, tag, ring 30 s, silent MixMonitor, missed event)', hi === true, { missing: hi, file: inb.slice(0, 1600) });
  check('...port 3 (nobody on it) is not routed: a call to it hangs up as before', !inb.includes(SIM3) && !/exten => p03/.test(inb));
  check('...no full SIM number of port 3, and no AI (Stasis) app in the generated file', !/Stasis/.test(inb));

  // ---- the server picks the recruiter's port
  const st0 = await call('GET', '/browser-calling/status', null, tR);
  check('status: the recruiter sees "Your calling number" (their SIM, port 01), routing OFF', st0.status === 200 && st0.body.sim && st0.body.sim.number === SIM1 && st0.body.sim.portLabel === '01' && st0.body.sim.routing === false, st0.body.sim);
  check('status: a BDE has no SIM', (await call('GET', '/browser-calling/status', null, tB)).body.sim == null);
  const endCall = (id) => S.run('UPDATE "BrowserCall" SET "status"=\'failed\', "endAt"=? WHERE "id"=?', S.nowIso(), id);
  const off1 = await call('POST', '/browser-calling/calls', { candidateId: cand.id }, tR);
  check('routing OFF: the recruiter\'s call goes on "default" exactly as today', off1.status === 200 && off1.body.line.header === 'default' && off1.body.line.name === 'Office Synway (SIM)', off1.body);
  if (off1.body && off1.body.callId) await endCall(off1.body.callId);
  const on = await call('PUT', '/browser-calling/admin/sims-settings', { prefixRouting: true }, tA);
  check('Admin switches Port prefix routing ON', on.status === 200 && on.body.settings.prefixRouting === true, on.body);
  const dpOn = read(env.BROWSER_CALL_LINES_DIALPLAN_FILE).replace(/\r/g, '');
  const rd = env.BROWSER_CALL_REC_DIR.replace(/[^A-Za-z0-9/._-]/g, '');
  const onLines = [
    '[tl-line-route]', 'exten => default,1,NoOp(TeamLink line: Office Synway SIM)',
    'exten => p01,1,NoOp(TeamLink SIM port 01: out on its own SIM)', ` same => n,GotoIf($["\${CHANNEL(endpoint)}"!="${recExt}"]?default,1)`, ` same => n,MixMonitor(${rd}/\${FILTER(a-z0-9,\${TLTOKEN})}.wav,b)`, ' same => n,Dial(PJSIP/01#${ARG1}@teamlink-gw,45)', ' same => n,Return()',
    'exten => p02,1,NoOp(TeamLink SIM port 02: out on its own SIM)', ` same => n,GotoIf($["\${CHANNEL(endpoint)}"!="${rec2Ext}"]?default,1)`, ` same => n,MixMonitor(${rd}/\${FILTER(a-z0-9,\${TLTOKEN})}.wav,b)`, ' same => n,Dial(PJSIP/02#${ARG1}@teamlink-gw,45)', ' same => n,Return()',
    '[tl-c2c-answer]',
  ];
  const ho = has(dpOn, onLines);
  check('routing ON: [tl-line-route] has p01 / p02 with the exact lines (only that person\'s extension, prefix + number to teamlink-gw)', ho === true, { missing: ho, file: dpOn.slice(0, 1500) });
  check('...the "default" extension is unchanged', dpOn.includes('exten => default,1,NoOp(TeamLink line: Office Synway SIM)\n same => n,MixMonitor(') && dpOn.includes(' same => n,Dial(PJSIP/${ARG1}@teamlink-gw,45)'));
  const on1 = await call('POST', '/browser-calling/calls', { candidateId: cand.id }, tR);
  check('routing ON: the SERVER picks the recruiter\'s port (header p01, line "Office Synway (SIM) · port 01")', on1.status === 200 && on1.body.line.header === 'p01' && on1.body.line.name === 'Office Synway (SIM) · port 01', on1.body);
  const row1 = on1.body && await S.one('SELECT "lineName","lineId" FROM "BrowserCall" WHERE "id"=?', on1.body.callId);
  check('...the call row says the port (line-wise report)', row1 && row1.lineId === 'default' && row1.lineName === 'Office Synway (SIM) · port 01', row1);
  if (on1.body && on1.body.callId) await endCall(on1.body.callId);
  check('routing ON, Test mode still refuses a number that is not a test number', (await call('POST', '/browser-calling/calls', { candidateId: candOut.id }, tR)).status !== 200);
  await require('../src/browsercall/provision').extensionFor(rec3.id);
  const un = await call('POST', '/browser-calling/calls', { candidateId: candOut.id }, tR3);
  check('routing ON: a recruiter without a SIM is unchanged (Test mode refuses this non-test number, no SIM involved)', un.status === 403 && /Test mode/.test(un.body.error), un.body);
  await call('PUT', '/browser-calling/admin/config', { testNumbers: `${phone}, ${phoneB}, ${phoneOut}` }, tA);
  const un2 = await call('POST', '/browser-calling/calls', { candidateId: candOut.id }, tR3);
  check('routing ON: a recruiter without a SIM still goes on "default"', un2.status === 200 && un2.body.line.header === 'default', un2.body);
  if (un2.body && un2.body.callId) await endCall(un2.body.callId);
  const swOff = await call('PUT', `/browser-calling/admin/sims/${p1.id}`, { active: false }, tA);
  const off2 = await call('POST', '/browser-calling/calls', { candidateId: cand.id }, tR);
  check('a port switched off: the recruiter goes on "default" and the port leaves both files', swOff.status === 200 && off2.body.line.header === 'default' && !read(env.BROWSER_CALL_LINES_DIALPLAN_FILE).includes('exten => p01') && !read(SIMS_FILE).includes(`exten => ${SIM1},`), off2.body);
  if (off2.body && off2.body.callId) await endCall(off2.body.callId);
  await call('PUT', `/browser-calling/admin/sims/${p1.id}`, { active: true }, tA);
  check('routing ON: the recruiter\'s status says routing is on', (await call('GET', '/browser-calling/status', null, tR)).body.sim.routing === true);

  // ---- inbound: by the called number
  const rt = async (c) => (await call('GET', `/browser-calling/admin/sims/route?called=${encodeURIComponent(c)}`, null, tA)).body;
  const r1 = await rt(SIM1); const r1b = await rt(`+91${SIM1}`); const r1c = await rt(`0${SIM1}`);
  check('inbound: a call to port 1\'s SIM number rings the recruiter\'s extension (10 digits, +91, 0 forms)', r1.port === 1 && r1.extension === recExt && r1.userId === rec.id && r1b.extension === recExt && r1c.extension === recExt, [r1, r1b]);
  const r2 = await rt('port02'); const r2n = await rt(SIM2);
  check('inbound: port 2 is matched by its tag port02 (its number alone does not match)', r2.port === 2 && r2.extension === rec2Ext && r2n.nobody === true, [r2, r2n]);
  check('inbound: an unknown number / a port with nobody on it rings nobody (as before)', (await rt('9000000001')).nobody === true && (await rt(SIM3)).nobody === true);
  check('refused: a BDE as the fallback person', (await call('PUT', '/browser-calling/admin/sims-settings', { fallbackUserId: bde.id }, tA)).status === 400);
  await require('../src/browsercall/provision').extensionFor(tl.id);
  const tlExt = (await S.one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=?', tl.id)).extension;
  const fb = await call('PUT', '/browser-calling/admin/sims-settings', { fallbackUserId: tl.id }, tA);
  const fbr = await rt('9000000001');
  const fbFile = read(SIMS_FILE).replace(/\r/g, '');
  check('with a fallback person: unknown numbers ring them (and the file says so)', fb.status === 200 && fbr.fallback === true && fbr.extension === tlExt && has(fbFile, ['exten => other,1,NoOp(TeamLink: unknown number or a port with nobody on it - the Admin\'s fallback)', ' same => n,Set(TLPORT=00)', ` same => n,Set(TLEXT=${tlExt})`, ' same => n,Goto(ring,1)']) === true, [fbr, fbFile.slice(-900)]);
  await call('PUT', '/browser-calling/admin/sims-settings', { fallbackUserId: '' }, tA);
  check('fallback removed: unknown numbers hang up again', (await rt('9000000001')).nobody === true && read(SIMS_FILE).includes('hang up as before)\n') || read(SIMS_FILE).includes('hang up as before)\r\n'));
  const pv = await call('GET', '/browser-calling/admin/sims/preview', null, tA);
  check('Admin: the generated phone-system text can be shown on the screen', pv.status === 200 && pv.body.inbound.includes('[tl-from-gateway]') && pv.body.route.includes('exten => p01'));

  // ---- incoming calls (Asterisk's AMI events fed to events.js)
  let seq = 100;
  const uid = () => { seq += 1; return `1764000000.${seq}`; };
  const ring = async ({ port, ext, from }) => { const u = uid(); const token = `in${u.replace(/\D/g, '')}`; await events.onEvent({ Event: 'UserEvent', UserEvent: 'TLInbound', Token: token, Port: port, Ext: ext, Uniqueid: u, Linkedid: u, CallerIDNum: from, Channel: 'PJSIP/teamlink-gw-0001' }); return { u, token }; };
  const hang = async (u, cause = 16) => events.onEvent({ Event: 'Hangup', Uniqueid: u, Cause: String(cause), 'Cause-txt': 'Normal Clearing', CallerIDNum: 'x' });
  const c1r = await ring({ port: '01', ext: recExt, from: `+91${phone}` });
  const in1 = await S.one('SELECT * FROM "BrowserCall" WHERE "token"=?', c1r.token);
  check('an incoming call on port 1 makes a row: inbound, for the recruiter, matched to their candidate and the application', in1 && in1.direction === 'inbound' && in1.userId === rec.id && in1.candidateId === cand.id && in1.applicationId === app.id && in1.status === 'ringing' && in1.lineName === 'Office Synway (SIM) · port 01' && in1.extension === recExt, in1);
  const pop = await call('GET', `/browser-calling/incoming/${c1r.token}`, null, tR);
  check('the ringing popup gets the candidate (name + current requirement) and only a masked number', pop.status === 200 && pop.body.candidate && pop.body.candidate.name === cand.name && /Sm Java Job/.test(pop.body.candidate.requirement || '') && pop.body.number === `${phone.slice(0, 2)}XXXXXX${phone.slice(-2)}` && !pop.text.includes(phone), pop.body);
  check('...another recruiter cannot read that incoming call', (await call('GET', `/browser-calling/incoming/${c1r.token}`, null, tR2)).status === 404);
  await events.onEvent({ Event: 'UserEvent', UserEvent: 'TLInbound', Token: c1r.token, Missed: '1', DialStatus: 'CHANUNAVAIL', Uniqueid: c1r.u, CallerIDNum: c1r.token });
  await hang(c1r.u);
  const m1 = await S.one('SELECT * FROM "BrowserCall" WHERE "token"=?', c1r.token);
  check('not registered: the call is MISSED - "Missed - called back the recruiter\'s number (TeamLink was not open ...)"', m1.status === 'missed' && m1.hangupReason === 'Missed - called back the recruiter\'s number (TeamLink was not open on the recruiter\'s computer)' && m1.endAt, m1);
  const n1 = await prisma.notification.findMany({ where: { userId: rec.id, title: 'Missed call' } });
  check('the recruiter gets a bell notice "Missed call from <candidate>" that opens the profile', n1.length === 1 && n1[0].message.startsWith(`Missed call from ${cand.name} on your SIM`) && n1[0].message.includes(`Open: /candidates/${cand.id}`), n1.map((x) => x.message));
  check('...no "Call back" task while the Admin switch is off', (await prisma.applicationFollowUp.count({ where: { applicationId: app.id, purpose: 'Missed call' } })) === 0);
  const h1 = await call('GET', `/browser-calling/candidates/${cand.id}/calls`, null, tR);
  const hr1 = h1.body && h1.body.rows.find((x) => x.id === m1.id);
  check('the candidate\'s call history has the missed incoming call (direction inbound, masked number)', hr1 && hr1.direction === 'inbound' && hr1.status === 'missed' && /Missed - called back the recruiter's number/.test(hr1.hangupReason) && hr1.number === `${phone.slice(0, 2)}XXXXXX${phone.slice(-2)}`, hr1);
  const evs = await S.all('SELECT "payload" FROM "BrowserCallEvent" WHERE "callId"=?', m1.id);
  check('the kept Asterisk events of the incoming call have no full phone number', evs.length >= 2 && evs.every((x) => !String(x.payload).includes(phone)), evs.map((x) => x.payload.slice(0, 200)));
  await REC.drain(5000);

  const mt = await call('PUT', '/browser-calling/admin/sims-settings', { missedTask: true }, tA);
  check('Admin switches on the "Call back" task for missed calls', mt.status === 200 && mt.body.settings.missedTask === true);
  const c2r = await ring({ port: '01', ext: recExt, from: phone });
  await events.onEvent({ Event: 'DialBegin', Uniqueid: c2r.u, DestUniqueid: `${c2r.u}9` });
  await events.onEvent({ Event: 'DialEnd', Uniqueid: c2r.u, DialStatus: 'NOANSWER' });
  await hang(c2r.u);
  const m2 = await S.one('SELECT * FROM "BrowserCall" WHERE "token"=?', c2r.token);
  const fu = await prisma.applicationFollowUp.findMany({ where: { applicationId: app.id, purpose: 'Missed call' } });
  const istDay = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  check('no answer in 30 s: missed ("not answered in 30 seconds")', m2.status === 'missed' && /not answered in 30 seconds/.test(m2.hangupReason), m2);
  check('...and a "Call back" follow-up, due now, for the recruiter', fu.length === 1 && fu[0].nextAction === 'Call back' && fu[0].ownerUserId === rec.id && fu[0].dueDate === istDay && /^\d\d:\d\d$/.test(fu[0].dueTime || '') && fu[0].completedAt === null, fu);
  const c2b = await ring({ port: '01', ext: recExt, from: phone });
  await hang(c2b.u);
  check('...a second missed call does not stack a second open "Call back"', (await prisma.applicationFollowUp.count({ where: { applicationId: app.id, purpose: 'Missed call', completedAt: null } })) === 1);

  // caller -> candidate, scoped: a number of a candidate this recruiter may not see stays unknown (masked)
  const c3r = await ring({ port: '01', ext: recExt, from: phoneOut });
  const in3 = await S.one('SELECT * FROM "BrowserCall" WHERE "token"=?', c3r.token);
  const pop3 = await call('GET', `/browser-calling/incoming/${c3r.token}`, null, tR);
  check('caller -> candidate is scoped: a candidate outside the recruiter\'s scope is not shown (unknown, masked number)', in3 && in3.candidateId === 'unknown' && pop3.status === 200 && pop3.body.candidate === null && !pop3.text.includes(phoneOut), [in3 && in3.candidateId, pop3.body]);
  await hang(c3r.u);
  const n3 = await prisma.notification.findFirst({ where: { userId: rec.id, title: 'Missed call', message: { contains: `${phoneOut.slice(0, 2)}XXXXXX${phoneOut.slice(-2)}` } } });
  check('...its missed-call notice says only the masked number', !!n3 && !n3.message.includes(phoneOut) && !n3.message.includes(candOut.name), n3 && n3.message);

  // answered: the same pipeline as an outbound call, direction inbound, no missed notice
  const before = await prisma.notification.count({ where: { userId: rec2.id } });
  const c4r = await ring({ port: '02', ext: rec2Ext, from: phoneB });
  await events.onEvent({ Event: 'DialBegin', Uniqueid: c4r.u, DestUniqueid: `${c4r.u}9` });
  await events.onEvent({ Event: 'DialEnd', Uniqueid: c4r.u, DialStatus: 'ANSWER' });
  await new Promise((r) => { setTimeout(r, 1100); });
  await hang(c4r.u);
  await REC.drain(8000);
  const a4 = await S.one('SELECT * FROM "BrowserCall" WHERE "token"=?', c4r.token);
  check('an answered incoming call is "completed" with talk time, inbound, for the port\'s recruiter, no missed notice', a4 && a4.status === 'completed' && a4.direction === 'inbound' && a4.userId === rec2.id && a4.candidateId === candB.id && a4.answerAt && a4.talkSec >= 1 && (await prisma.notification.count({ where: { userId: rec2.id } })) === before, a4);
  check('...the after-call job ran on it (recording looked for, the candidate\'s activity says "Incoming call to ...")', a4.processedAt && ['missing', 'done'].includes(a4.recordingStatus) && !!(await prisma.candidateMessage.findFirst({ where: { providerRef: a4.id, statusDetail: { startsWith: `Incoming call to ${rec2.name}` } } })), [a4.recordingStatus, a4.processedAt]);

  // a TLInbound for an extension that is not the port's person is not trusted; an unknown port is ignored
  const bogus = await ring({ port: '01', ext: rec2Ext, from: phone });
  check('a TLInbound whose extension is not the port\'s person makes no row', !(await S.one('SELECT "id" FROM "BrowserCall" WHERE "token"=?', bogus.token)));
  const bogus2 = await ring({ port: '03', ext: recExt, from: phone });
  check('a TLInbound on a port with nobody on it makes no row', !(await S.one('SELECT "id" FROM "BrowserCall" WHERE "token"=?', bogus2.token)));

  // a missed call of a recruiter outside the TL's team
  await require('../src/browsercall/provision').extensionFor(rec3.id);
  await call('PUT', `/browser-calling/admin/sims/${p3.id}`, { userId: rec3.id }, tA);
  const rec3Ext = (await S.one('SELECT "extension" FROM "BrowserCallExtension" WHERE "userId"=?', rec3.id)).extension;
  const c5r = await ring({ port: '03', ext: rec3Ext, from: phoneOut });
  await hang(c5r.u);
  const m5 = await S.one('SELECT * FROM "BrowserCall" WHERE "token"=?', c5r.token);
  check('port 3 -> a recruiter of another department: their missed call is theirs, with their own candidate', m5 && m5.status === 'missed' && m5.userId === rec3.id && m5.candidateId === candOut.id, m5);

  // ---- the report: own / TL's team / Admin all
  const repR = await call('GET', '/browser-calling/report', null, tR);
  const repT = await call('GET', '/browser-calling/report', null, tT);
  const repA = await call('GET', '/browser-calling/report', null, tA);
  const ids = (r) => (r.body && r.body.missed ? r.body.missed.map((x) => x.userId) : []);
  check('report: the recruiter sees their own missed calls only', repR.status === 200 && repR.body.missedScope === 'own' && ids(repR).length >= 4 && ids(repR).every((x) => x === rec.id), repR.body && repR.body.missed);
  check('report: the TL sees the missed calls of their team, not of another team', repT.status === 200 && repT.body.missedScope === 'team' && ids(repT).includes(rec.id) && !ids(repT).includes(rec3.id), repT.body && repT.body.missed);
  check('report: the Admin sees every missed call', repA.body.missedScope === 'all' && ids(repA).includes(rec.id) && ids(repA).includes(rec3.id));
  check('report: missed-call numbers are masked and a candidate outside the viewer\'s scope has no name', repT.body.missed.every((x) => !/\d{10}/.test(x.number || '')) && !repT.body.missed.some((x) => x.candidateName === candOut.name));
  check('report: missed calls are listed with the reason', repR.body.missed.some((x) => /called back the recruiter's number/.test(x.reason || '')));

  // ---- a person who may no longer hold a SIM (became a BDE): their port leaves the files, their calls back are not recorded as theirs
  await prisma.user.update({ where: { id: rec2.id }, data: { atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' } });
  await call('PUT', '/browser-calling/admin/sims-settings', { missedTask: true }, tA);
  check('a SIM holder who became a BDE: their port leaves [tl-from-gateway] and [tl-line-route]', !read(SIMS_FILE).includes('exten => port02,') && !read(env.BROWSER_CALL_LINES_DIALPLAN_FILE).includes('exten => p02,'));
  const c6r = await ring({ port: '02', ext: rec2Ext, from: phoneB });
  check('...and a TLInbound for them makes no row', !(await S.one('SELECT "id" FROM "BrowserCall" WHERE "token"=?', c6r.token)));

  // ---- remove
  const del = await call('DELETE', `/browser-calling/admin/sims/${p3.id}`, null, tA);
  check('Admin removes port 3: it leaves the list and the files', del.status === 200 && !del.body.sims.some((x) => x.port === 3) && !read(SIMS_FILE).includes('exten => p03'));
  check('a recruiter cannot remove a port', (await call('DELETE', `/browser-calling/admin/sims/${p2.id}`, null, tR)).status === 403);
  const take = await call('PUT', `/browser-calling/admin/sims/${p1.id}`, { userId: '' }, tA);
  check('Admin takes port 1 back: the recruiter has no SIM, calls go on "default"', take.status === 200 && (await call('GET', '/browser-calling/status', null, tR)).body.sim === null);

  // ---- a table made before 2026-11-24 ("simNumber" NOT NULL) is rebuilt once, its rows kept
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "BrowserCallSimOld"');
  await prisma.$executeRawUnsafe('CREATE TABLE "BrowserCallSimOld" AS SELECT * FROM "BrowserCallSim"');
  const nBefore = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "BrowserCallSim"'))[0].n;
  await prisma.$executeRawUnsafe('DROP TABLE "BrowserCallSim"');
  await prisma.$executeRawUnsafe(`CREATE TABLE "BrowserCallSim" ("id" TEXT NOT NULL PRIMARY KEY, "port" INTEGER NOT NULL, "simNumber" TEXT NOT NULL, "operator" TEXT, "active" INTEGER NOT NULL DEFAULT 1, "userId" TEXT, "dialPrefix" TEXT NOT NULL, "matchBy" TEXT NOT NULL DEFAULT 'number', "tag" TEXT NOT NULL, "note" TEXT, "createdById" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`);
  await prisma.$executeRawUnsafe('INSERT INTO "BrowserCallSim" SELECT * FROM "BrowserCallSimOld"');
  await prisma.$executeRawUnsafe('DROP TABLE "BrowserCallSimOld"');
  delete require.cache[require.resolve('../src/browsercall/schema')];
  await require('../src/browsercall/schema').ensure();
  const col = (await prisma.$queryRawUnsafe('PRAGMA table_info("BrowserCallSim")')).find((x) => x.name === 'simNumber');
  const nAfter = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "BrowserCallSim"'))[0].n;
  const idx = (await prisma.$queryRawUnsafe('PRAGMA index_list("BrowserCallSim")')).map((x) => x.name);
  check('an old SIM table is rebuilt: SIM number optional, rows and unique indexes kept', Number(col.notnull) === 0 && Number(nAfter) === Number(nBefore) && Number(nBefore) > 0 && ['BrowserCallSim_port', 'BrowserCallSim_number', 'BrowserCallSim_tag', 'BrowserCallSim_user'].every((x) => idx.includes(x)), { col, nBefore, nAfter, idx });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
