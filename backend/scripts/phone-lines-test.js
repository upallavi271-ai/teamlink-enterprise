#!/usr/bin/env node
/**
 * PHONE LINES for manual calling (founder 2026-11-23: "call through ViciDial, Synway, Dinstar and by IP address").
 * Every line type both ways (registers to us / by IP), the exact generated Asterisk text, secrets encrypted and never sent back, the server
 * choosing the line of a call (unknown / switched off / role not allowed / full refused, the default line works), the Call window list,
 * Test mode and test calls, BDE and Manager refused.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database; the "Asterisk" files go to a temp folder (no phone system is touched).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4321 node scripts/phone-lines-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-lines-${process.pid}.db`);
const ETC = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-lines-etc-'));
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4321;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'lines-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  INTEGRATION_SECRET_KEY: 'phone-lines-test-key', BROWSER_CALL_LINES_PJSIP_FILE: path.join(ETC, 'pjsip_tl_lines.conf'), BROWSER_CALL_LINES_DIALPLAN_FILE: path.join(ETC, 'extensions_tl_lines.conf'),
  BROWSER_CALL_PJSIP_MAIN: path.join(ETC, 'pjsip.conf'), BROWSER_CALL_RELOAD_CMD: path.join(ETC, 'no-asterisk-here'), BROWSER_CALL_AMI_USER: '', BROWSER_CALL_AMI_SECRET: '',
  AI_VOICE_AMI_USER: '', AI_VOICE_AMI_SECRET: '', AI_VOICE_SIP_TRUNK: '', AI_VOICE_DIAL_VIA: '',
};
Object.assign(process.env, env);
fs.writeFileSync(env.BROWSER_CALL_PJSIP_MAIN, '; test\n');
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
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

(async () => {
  const mk = (tag, data) => prisma.user.create({ data: { name: `Pl ${tag} ${P}`, email: `pl.${tag}.${P}@pl-test.in`, passwordHash: 'x', status: 'Active', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const admin = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' });
  const bde = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE' });
  const mgr = await mk('mgr', { role: 'EMPLOYEE', atsRole: 'MANAGER' });
  const phone = `9${String(P).padStart(9, '7').slice(-9)}`;
  const other = `8${String(P).padStart(9, '3').slice(-9)}`;
  const cand = await prisma.candidate.create({ data: { name: `Pl Person ${P}`, phone, email: `pl.person.${P}@pl-test.in` } });
  const cand2 = await prisma.candidate.create({ data: { name: `Pl Other ${P}`, phone: other } });
  const client = await prisma.client.create({ data: { name: `Pl Client ${P}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Pl Job ${P}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `PL-${P}`.slice(0, 14), openings: 1 } });
  await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });

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
  const tA = await tok(admin.id); const tR = await tok(rec.id); const tB = await tok(bde.id); const tM = await tok(mgr.id);
  const S = require('../src/browsercall/schema');
  const L = require('../src/browsercall/lines');

  // ---- switch on Test mode with the candidate's number as the Admin's test number
  const cf = await call('PUT', '/browser-calling/admin/config', { mode: 'Test', testNumbers: phone, kinds: ['admin', 'tl', 'recruiter', 'hr'] }, tA);
  check('setup: browser calling in Test mode', cf.status === 200 && cf.body.mode === 'Test', cf.body);

  // ---- who may manage lines
  check('a recruiter cannot see the phone lines setup', (await call('GET', '/browser-calling/admin/lines', null, tR)).status === 403);
  check('a recruiter cannot add a line', (await call('POST', '/browser-calling/admin/lines', { name: 'x', type: 'ip', connect: 'ip', host: '10.1.1.1' }, tR)).status === 403);
  check('a BDE cannot add a line', (await call('POST', '/browser-calling/admin/lines', { name: 'x', type: 'ip', connect: 'ip', host: '10.1.1.1' }, tB)).status === 403);
  check('a Manager cannot add a line', (await call('POST', '/browser-calling/admin/lines', { name: 'x', type: 'ip', connect: 'ip', host: '10.1.1.1' }, tM)).status === 403);

  // ---- the built-in line
  const l0 = await call('GET', '/browser-calling/admin/lines', null, tA);
  const builtIn = l0.body && l0.body.lines && l0.body.lines[0];
  check('the office Synway is the built-in first line (teamlink-gw, not editable)', l0.status === 200 && builtIn.id === 'default' && builtIn.name === 'Office Synway (SIM)' && builtIn.endpoint === 'teamlink-gw' && builtIn.builtIn === true, l0.body);
  check('the built-in line cannot be edited here', (await call('PUT', '/browser-calling/admin/lines/default', { name: 'x' }, tA)).status === 400);
  check('the setup says what a device registers to: 72.61.233.104 port 5160 UDP', l0.body.register.server === '72.61.233.104' && l0.body.register.port === 5160 && l0.body.register.transport === 'UDP', l0.body.register);

  // ---- validation
  const bad = async (b) => (await call('POST', '/browser-calling/admin/lines', b, tA)).status;
  check('refused: no name', await bad({ type: 'ip', connect: 'ip', host: '10.1.1.1' }) === 400);
  check('refused: unknown type', await bad({ name: 'A', type: 'avaya', connect: 'ip', host: '10.1.1.1' }) === 400);
  check('refused: IP line without an address', await bad({ name: 'A', type: 'ip', connect: 'ip' }) === 400);
  check('refused: a bad address', await bad({ name: 'A', type: 'ip', connect: 'ip', host: '10.1.1.1;evil' }) === 400);
  check('refused: a password that would break the config (;)', await bad({ name: 'A', type: 'ip', connect: 'ip', host: '10.1.1.1', username: 'u', password: 'ab;c' }) === 400);
  check('refused: a prefix with letters', await bad({ name: 'A', type: 'vicidial', connect: 'ip', host: '10.1.1.1', prefix: '9x' }) === 400);
  check('refused: port 70000', await bad({ name: 'A', type: 'ip', connect: 'ip', host: '10.1.1.1', port: 70000 }) === 400);
  check('refused: the built-in name', await bad({ name: 'Office Synway 2', type: 'synway', connect: 'register' }) === 400);
  check('refused: "accept from this IP only" on a registering device without its IP', await bad({ name: 'A', type: 'dinstar', connect: 'register', acceptFromIpOnly: true }) === 400);
  check('refused: an unknown role', await bad({ name: 'A', type: 'ip', connect: 'ip', host: '10.1.1.1', kinds: ['root'] }) === 400);

  // ---- every type, both ways
  const made = {};
  const passwords = [];
  for (const type of ['synway', 'dinstar', 'vicidial', 'ip']) {
    for (const connect of ['register', 'ip']) {
      const body = connect === 'register'
        ? { name: `${type} reg ${P}`, type, connect }
        : { name: `${type} ip ${P}`, type, connect, host: `10.20.${['synway', 'dinstar', 'vicidial', 'ip'].indexOf(type)}.5`, port: 5060 };
      // eslint-disable-next-line no-await-in-loop
      const r = await call('POST', '/browser-calling/admin/lines', body, tA);
      made[`${type}-${connect}`] = r.body;
      if (r.body && r.body.setup) passwords.push(r.body.setup.password);
      check(`${type} line, ${connect === 'register' ? 'registers to us' : 'by IP'}: saved`, r.status === 201 && r.body.line.type === type && r.body.line.connect === connect && (connect === 'register' ? !!(r.body.setup && r.body.setup.password && r.body.setup.username === r.body.line.endpoint && r.body.setup.server === '72.61.233.104' && r.body.setup.port === 5160) : !r.body.setup), r.body);
    }
  }
  // a fuller ViciDial line by IP: prefix 9, 0 + 10 digits, far-end username/password, accept from this IP only, 2 calls at once
  const VP = `Vici${P}pass`;
  const vici = await call('POST', '/browser-calling/admin/lines', { name: `ViciDial main ${P}`, type: 'vicidial', connect: 'ip', host: '203.0.113.7', port: 5060, transport: 'udp', username: 'teamlink', password: VP, acceptFromIpOnly: true, dialFormat: '0', prefix: '9', callerId: '04012345678', maxCalls: 2 }, tA);
  check('ViciDial by IP with prefix, format, login, caller ID and a call limit: saved', vici.status === 201 && vici.body.line.prefix === '9' && vici.body.line.dialFormat === '0' && vici.body.line.hasPassword === true && vici.body.line.maxCalls === 2, vici.body);
  check('the far end\'s password is not in the answer', !vici.text.includes(VP));
  // a Dinstar that registers, only from its office IP
  const din = await call('POST', '/browser-calling/admin/lines', { name: `Dinstar office ${P}`, type: 'dinstar', connect: 'register', host: '183.82.4.247', acceptFromIpOnly: true, dialFormat: '91', maxCalls: 8 }, tA);
  const DP = din.body && din.body.setup && din.body.setup.password;
  check('Dinstar that registers to us: the password is shown once with the values to type in', din.status === 201 && /^[A-Za-z0-9]{20}$/.test(DP || '') && din.body.setup.username === din.body.line.endpoint, din.body);
  // other SIP by IP over TCP, +91 format
  const tcp = await call('POST', '/browser-calling/admin/lines', { name: `Trunk tcp ${P}`, type: 'ip', connect: 'ip', host: 'sip.example.net', port: 5080, transport: 'tcp', dialFormat: 'e164', acceptFromIpOnly: false }, tA);
  check('other SIP by host name over TCP: saved', tcp.status === 201 && tcp.body.line.transport === 'tcp' && tcp.body.line.host === 'sip.example.net', tcp.body);
  check('the config was written to the phone-system folder (Asterisk reload reported as not done here)', vici.body.config && vici.body.config.pbx === true && vici.body.config.written === true && vici.body.config.reloaded === false && /did not reload/.test(vici.body.config.error || ''), vici.body.config);

  // ---- secrets: encrypted at rest, never returned
  const list = await call('GET', '/browser-calling/admin/lines', null, tA);
  check('the lines list never carries a password', list.status === 200 && ![...passwords, DP, VP].some((x) => list.text.includes(x)) && !/secretEnc|password"/.test(list.text), list.text.slice(0, 300));
  const dbRows = await S.all('SELECT "secretEnc" FROM "BrowserCallLine"');
  check('secrets are encrypted in the database', dbRows.filter((r) => r.secretEnc).length >= 6 && dbRows.filter((r) => r.secretEnc).every((r) => r.secretEnc.startsWith('enc:v1:') && ![...passwords, DP, VP].some((x) => r.secretEnc.includes(x))), dbRows.map((r) => String(r.secretEnc).slice(0, 12)));
  const st0 = await call('GET', '/browser-calling/status', null, tA);
  check('the status answer carries no secret either', ![...passwords, DP, VP].some((x) => st0.text.includes(x)));

  // ---- exact generated text
  const pj = read(env.BROWSER_CALL_LINES_PJSIP_FILE);
  const dp = read(env.BROWSER_CALL_LINES_DIALPLAN_FILE);
  const v = vici.body.line; const d = din.body.line; const t = tcp.body.line;
  const viciPj = [`; Line "ViciDial main ${P} (ViciDial server)" - we send calls to 203.0.113.7:5060 (UDP)`, `[${v.endpoint}-auth]`, 'type=auth', 'auth_type=userpass', 'username=teamlink', `password=${VP}`, '',
    `[${v.endpoint}]`, 'type=aor', 'contact=sip:203.0.113.7:5060', 'qualify_frequency=30', '', `[${v.endpoint}]`, 'type=endpoint', 'transport=transport-udp', 'context=from-provider', 'disallow=all', 'allow=alaw,ulaw',
    `aors=${v.endpoint}`, `outbound_auth=${v.endpoint}-auth`, 'from_user=teamlink', 'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes', '', `[${v.endpoint}-ip]`, 'type=identify', `endpoint=${v.endpoint}`, 'match=203.0.113.7'].join('\n');
  check('pjsip: the ViciDial IP line exactly (aor contact, outbound auth, identify)', pj.includes(viciPj), pj.slice(0, 1500));
  const dinPj = [`; Line "Dinstar office ${P} (Dinstar SIM gateway)" - the device registers to us (UDP 5160)`, `[${d.endpoint}-auth]`, 'type=auth', 'auth_type=userpass', `username=${d.endpoint}`, `password=${DP}`, '',
    `[${d.endpoint}]`, 'type=aor', 'max_contacts=1', 'remove_existing=yes', 'qualify_frequency=30', '', `[${d.endpoint}]`, 'type=endpoint', 'transport=transport-gw', 'context=from-provider', 'disallow=all', 'allow=alaw,ulaw',
    `auth=${d.endpoint}-auth`, `aors=${d.endpoint}`, 'identify_by=username,auth_username', 'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes', 'deny=0.0.0.0/0.0.0.0', 'permit=183.82.4.247/255.255.255.255'].join('\n');
  check('pjsip: the registering Dinstar exactly (auth, aor max_contacts=1, transport-gw, only its IP)', pj.includes(dinPj), pj.slice(0, 1500));
  check('pjsip: the TCP line uses transport-tcp and ;transport=tcp', pj.includes(`[${t.endpoint}]\ntype=aor\ncontact=sip:sip.example.net:5080;transport=tcp\nqualify_frequency=30\n\n[${t.endpoint}]\ntype=endpoint\ntransport=transport-tcp\n`));
  check('pjsip: the built-in teamlink-gw is never written', !/\[teamlink-gw\]/.test(pj));
  check('pjsip: every one of the 11 lines is in the file', (pj.match(/type=endpoint/g) || []).length === 11, (pj.match(/type=endpoint/g) || []).length);
  const viciDp = [`exten => ${v.header},1,NoOp(TeamLink line: ViciDial main ${P})`, ` same => n,Set(GROUP(tllines)=${v.header})`, ` same => n,GotoIf($[\${GROUP_COUNT(${v.header}@tllines)} > 2]?full)`,
    ' same => n,Set(CALLERID(num)=04012345678)', ` same => n,Dial(PJSIP/90\${ARG1}@${v.endpoint},45)`, ' same => n,Return()', ' same => n(full),NoOp(All 2 calls of this line are in use)', ' same => n,Hangup(34)'].join('\n');
  check('dialplan: the ViciDial line exactly (prefix 9 + 0 + number, caller ID, 2 at once)', dp.includes(viciDp), dp.slice(0, 1500));
  check('dialplan: "default" is the office Synway (teamlink-gw), as before', dp.includes('[tl-line-route]\nexten => default,1,NoOp(TeamLink line: Office Synway SIM)\n same => n,Dial(PJSIP/${ARG1}@teamlink-gw,45)\n same => n,Return()')); // eslint-disable-line no-template-curly-in-string
  check('dialplan: 91 format and +91 format', dp.includes(`Dial(PJSIP/91\${ARG1}@${d.endpoint},45)`) && dp.includes(`Dial(PJSIP/+91\${ARG1}@${t.endpoint},45)`));
  check('pjsip file is not readable by everyone (0640)', process.platform === 'win32' || (fs.statSync(env.BROWSER_CALL_LINES_PJSIP_FILE).mode & 0o007) === 0);

  // ---- new password for a registering device
  const np = await call('POST', `/browser-calling/admin/lines/${d.id}/new-password`, null, tA);
  const pj2 = read(env.BROWSER_CALL_LINES_PJSIP_FILE);
  check('new password: shown once, written, the old one is gone', np.status === 200 && np.body.setup.password !== DP && pj2.includes(`password=${np.body.setup.password}`) && !pj2.includes(`password=${DP}`), np.body);
  check('an IP line has no TeamLink password to renew', (await call('POST', `/browser-calling/admin/lines/${v.id}/new-password`, null, tA)).status === 400);
  // ---- edit: the connect way stays
  const ed = await call('PUT', `/browser-calling/admin/lines/${t.id}`, { name: `Trunk tcp renamed ${P}`, connect: 'register' }, tA);
  check('edit: renamed, and it still connects by IP', ed.status === 200 && ed.body.line.name === `Trunk tcp renamed ${P}` && ed.body.line.connect === 'ip', ed.body);

  // ---- which lines a person sees
  const sA = await call('GET', '/browser-calling/status', null, tA);
  check('Admin: "Call using" lists the office Synway first, then the lines', sA.status === 200 && sA.body.canCall && sA.body.lines[0].id === 'default' && sA.body.lines.some((l) => l.id === v.id) && sA.body.defaultLine === 'default', sA.body);
  const adminOnly = await call('POST', '/browser-calling/admin/lines', { name: `Admins only ${P}`, type: 'ip', connect: 'ip', host: '10.9.9.9', kinds: ['admin'] }, tA);
  const sR = await call('GET', '/browser-calling/status', null, tR);
  check('recruiter: sees the lines open to recruiters, not the Admin-only one', sR.status === 200 && sR.body.canCall && sR.body.lines.some((l) => l.id === v.id) && !sR.body.lines.some((l) => l.id === adminOnly.body.line.id), sR.body);
  const sB = await call('GET', '/browser-calling/status', null, tB);
  const sM = await call('GET', '/browser-calling/status', null, tM);
  check('BDE and Manager: cannot call and see no lines', !sB.body.canCall && sB.body.lines.length === 0 && !sM.body.canCall && sM.body.lines.length === 0, { b: sB.body, m: sM.body });

  // ---- the server decides the line of a call
  for (const u of [admin, rec]) await S.run('INSERT INTO "BrowserCallExtension" ("id","userId","extension","secretEnc","active","createdAt") VALUES (?,?,?,?,1,?)', `pl-ext-${u.id}`, u.id, String(7900 + [admin, rec].indexOf(u)), 'x', S.nowIso()); // eslint-disable-line no-await-in-loop
  const closeAll = () => S.run('UPDATE "BrowserCall" SET "status"=\'completed\' WHERE "status" IN (\'initiated\',\'calling\',\'ringing\',\'connected\')');
  const c1 = await call('POST', '/browser-calling/calls', { candidateId: cand.id, lineId: v.id }, tA);
  const row1 = c1.body && await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', c1.body.callId);
  check('a call on the ViciDial line: the header value comes from the server and the row records the line', c1.status === 200 && c1.body.line.header === v.header && row1.lineId === v.id && row1.lineName === `ViciDial main ${P}`, c1.body);
  await closeAll();
  const c2 = await call('POST', '/browser-calling/calls', { candidateId: cand.id }, tA);
  check('no line given: the office Synway ("default")', c2.status === 200 && c2.body.line.header === 'default' && c2.body.line.name === 'Office Synway (SIM)', c2.body);
  await closeAll();
  check('an unknown line is refused', (await call('POST', '/browser-calling/calls', { candidateId: cand.id, lineId: 'nope-1234' }, tA)).status === 404);
  await call('PUT', `/browser-calling/admin/lines/${t.id}`, { active: false }, tA);
  const off = await call('POST', '/browser-calling/calls', { candidateId: cand.id, lineId: t.id }, tA);
  check('a switched-off line is refused with the reason', off.status === 409 && /switched off/.test(off.body.error), off.body);
  check('...and it is gone from the Asterisk files', !read(env.BROWSER_CALL_LINES_PJSIP_FILE).includes(`[${t.endpoint}]`) && !read(env.BROWSER_CALL_LINES_DIALPLAN_FILE).includes(`exten => ${t.header},`));
  const notMine = await call('POST', '/browser-calling/calls', { candidateId: cand.id, lineId: adminOnly.body.line.id }, tR);
  check('a recruiter on an Admin-only line is refused', notMine.status === 403, notMine.body);
  const recOk = await call('POST', '/browser-calling/calls', { candidateId: cand.id, lineId: v.id }, tR);
  check('a recruiter on an open line works', recOk.status === 200 && recOk.body.line.header === v.header, recOk.body);
  // the line is full: 2 calls at once
  await S.run('UPDATE "BrowserCall" SET "status"=\'ringing\' WHERE "id"=?', recOk.body && recOk.body.callId);
  const fake = await S.one('SELECT * FROM "BrowserCall" WHERE "id"=?', recOk.body && recOk.body.callId);
  await S.run('INSERT INTO "BrowserCall" ("id","token","candidateId","userId","toNumber","extension","status","startAt","createdAt","updatedAt","lineId","lineName") VALUES (?,?,?,?,?,?,\'connected\',?,?,?,?,?)', `pl-full-${P}`, `tok-full-${P}`, cand2.id, tl.id, other, '7999', S.nowIso(), S.nowIso(), S.nowIso(), v.id, fake.lineName);
  const full = await call('POST', '/browser-calling/calls', { candidateId: cand.id, lineId: v.id }, tA);
  check('the line\'s 2 calls are in use: a third is refused', full.status === 409 && full.body.code === 'LINE_FULL', full.body);
  await closeAll();
  // Test mode and BDE / Manager
  const notTest = await call('POST', '/browser-calling/calls', { candidateId: cand2.id, lineId: v.id }, tA);
  check('Test mode: a number that is not a test number is refused on any line', notTest.status === 403 && notTest.body.code === 'TEST_MODE', notTest.body);
  check('a BDE cannot call on any line', (await call('POST', '/browser-calling/calls', { candidateId: cand.id, lineId: v.id }, tB)).status === 403);
  check('a Manager cannot call on any line', (await call('POST', '/browser-calling/calls', { candidateId: cand.id, lineId: v.id }, tM)).status === 403);

  // ---- test call on a line
  const tc0 = await call('POST', `/browser-calling/admin/lines/${v.id}/test-call`, { number: other }, tA);
  check('test call: only to one of the Test numbers', tc0.status === 403 && tc0.body.code === 'TEST_MODE', tc0.body);
  const tc = await call('POST', `/browser-calling/admin/lines/${v.id}/test-call`, { number: phone }, tA);
  check('test call to the Admin\'s test number on the line: started with that line', tc.status === 200 && tc.body.number === phone && tc.body.line.header === v.header, tc.body);
  await closeAll();
  const tcd = await call('POST', '/browser-calling/admin/lines/default/test-call', { number: phone }, tA);
  check('test call on the built-in office line', tcd.status === 200 && tcd.body.line.header === 'default', tcd.body);
  await closeAll();
  check('a recruiter cannot make a line test call', (await call('POST', `/browser-calling/admin/lines/${v.id}/test-call`, { number: phone }, tR)).status === 403);
  const rp = await call('GET', '/browser-calling/report', null, tA);
  check('the report shows the line of each call and a line-wise count; the test call is named', rp.status === 200 && rp.body.calls.some((c) => c.lineName === `ViciDial main ${P}` && c.candidateName === 'Test call') && rp.body.lines.some((l) => l.lineName === `ViciDial main ${P}`), rp.body.lines);
  const hist = await call('GET', `/browser-calling/candidates/${cand.id}/calls`, null, tA);
  check('the candidate\'s call history carries the line name', hist.status === 200 && hist.body.rows.some((r) => r.lineName === `ViciDial main ${P}`) && hist.body.rows.some((r) => r.lineName === 'Office Synway (SIM)'), hist.body.rows && hist.body.rows.map((r) => r.lineName));
  check('Test mode off: test calls refused when browser calling is Off', await (async () => { await call('PUT', '/browser-calling/admin/config', { mode: 'Off' }, tA); const r = await call('POST', `/browser-calling/admin/lines/${v.id}/test-call`, { number: phone }, tA); await call('PUT', '/browser-calling/admin/config', { mode: 'Test' }, tA); return r.status === 403; })());

  // ---- the Call window list (utils/callLines.js)
  const cl = await call('GET', '/messaging/call-lines', null, tA);
  const ids = (cl.body && cl.body.lines || []).map((l) => l.id);
  check('Call window: API first, then every active phone line as line:<id>', cl.status === 200 && ids[0] === 'api' && ids.includes(`line:${v.id}`) && ids.includes(`line:${d.id}`) && !ids.includes(`line:${t.id}`), ids);
  check('Call window: Dinstar no longer says "not connected" (its placeholder is replaced by the Dinstar line)', !ids.includes('dinstar') && cl.body.lines.some((l) => l.id === `line:${d.id}` && /^Dinstar: /.test(l.text)), cl.body.lines.map((l) => l.text));
  check('Call window: a phone line is not ready on a server without the Asterisk manager login, with the reason', cl.body.lines.filter((l) => l.phoneLine).every((l) => !l.ready && /cannot place click-to-call/.test(l.reason)));
  const clR = await call('GET', '/messaging/call-lines', null, tR);
  check('Call window: a recruiter does not see the Admin-only line', clR.status === 200 && !clR.body.lines.some((l) => l.id === `line:${adminOnly.body.line.id}`) && clR.body.lines.some((l) => l.id === `line:${v.id}`), clR.body.lines && clR.body.lines.map((l) => l.id));
  const CL = require('../src/utils/callLines');
  const uR = await resolveIdentity(rec.id); const uA = await resolveIdentity(admin.id);
  const s1 = await CL.startCall(`line:${v.id}`, { agent: '9876543210', to: phone });
  check('click-to-call on a phone line without knowing who calls is refused', !s1.ok && s1.notConfigured, s1);
  const s2 = await CL.startCall(`line:${adminOnly.body.line.id}`, { agent: '9876543210', to: phone, user: uR });
  check('click-to-call: a recruiter on an Admin-only line is refused', !s2.ok && /may not call/.test(s2.error), s2);
  const s3 = await CL.startCall(`line:${v.id}`, { agent: '9876543210', to: phone, user: uA });
  check('click-to-call on a phone line here: refused with the plain reason (no manager login), never pretends to dial', !s3.ok && s3.notConfigured && /ViciDial main/.test(s3.error), s3);
  const s4 = await CL.startCall('dinstar', { agent: '9876543210', to: phone, user: uA });
  check('a saved "Dinstar" choice now goes to the Dinstar line', !s4.ok && /dinstar/i.test(s4.error) && String(s4.line).startsWith('line:'), s4);

  // ---- live state
  const ls = await call('GET', '/browser-calling/admin/lines/status', null, tA);
  check('line status on a test copy: says plainly it cannot be read here', ls.status === 200 && ls.body.reachable === false && !!ls.body.reason, ls.body);
  check('a recruiter cannot read the line status', (await call('GET', '/browser-calling/admin/lines/status', null, tR)).status === 403);
  const cli = L.parseContactsCli(['  Contact:  <Aor/ContactUri..> <Hash> <Status> <RTT(ms)..>', '==========', `  Contact:  ${d.endpoint}/sip:${d.endpoint}@183.82.4.247:5060;ob 1a2b3c4d5e Avail        23.456`, `  Contact:  ${v.endpoint}/sip:203.0.113.7:5060 9f8e7d6c5b Unavail         nan`, '  Contact:  teamlink-gw/sip:teamlink-gw@183.82.4.247:5160 aa11bb22cc Avail 41.2'].join('\n'));
  const stD = L.stateOf(d, cli); const stV = L.stateOf(v, cli); const stG = L.stateOf(L.DEFAULT_LINE, cli);
  check('status from Asterisk: Registered with round trip / Unreachable / the office Synway Registered', stD.state === 'Registered' && stD.rttMs === 23 && stV.state === 'Unreachable' && stG.state === 'Registered' && stG.rttMs === 41, { stD, stV, stG });
  check('status: a registering device with no contact is "Not registered"; an IP line Reachable', L.stateOf(made['synway-register'].line, cli).state === 'Not registered' && L.stateOf(v, L.contactsFromAmiEvents([{ Event: 'ContactList', ObjectName: `${v.endpoint};@abc`, Status: 'Reachable', RoundtripUsec: '15000' }])).state === 'Reachable');

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
