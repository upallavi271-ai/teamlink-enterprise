#!/usr/bin/env node
// ---------------------------------------------------------------------------
// RECRUITER WHATSAPP CHAT - acceptance test (2026-10-21).
//   cd backend && node scripts/recruiter-wa-chat-test.js
//
// SAFE BY CONSTRUCTION (same rules as scripts/wa-multi-number-test.js)
//   * the real database is only OPENED READ-ONLY to take a VACUUM INTO copy in the OS temp folder; every test runs on that copy (deleted at the end)
//   * the app under test is a SECOND server on a free port between 4061 and 4099 (never 4010, never 4045) with TEST_MODE=1
//   * "Meta" is a LOCAL FAKE Graph API (scripts/lib/waFakeMeta.js, loopback). Nothing is sent to a real WhatsApp number, mail address or Meta server
//   * every fixture is named ZZTEST and lives only in the copy
//
// PHASES
//   A  one (old) WhatsApp connection: inbound text / image / PDF / voice -> the chat list, unread (per login), the chat, replying, ticks, failed reason,
//      24-hour rule, STOP, follow-up on the same screen, "candidate replied" flag, stage change, reply tag, bell (10-minute rule), polling, permissions
//   B  several numbers: the chat keeps its number, WhatsApp number access filters chats, replies leave from the right phone id
//   C  Admin test tools: pretend reply (Test mode only), real-sending refusal, remove test messages
//   D  sweeps: no token / phone number in logs, masked viewer, indexes
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { startFake, signedWebhook, inboundPayload, statusPayload } = require('./lib/waFakeMeta');

const BACK = path.resolve(__dirname, '..');
const SRC_DB = path.join(BACK, 'prisma', 'dev.db');
const RUN = Date.now().toString(36);
const TAG = 'ZZTEST WAC';
let pass = 0; let fail = 0;
const failed = [];
const check = (n, ok, d) => {
  if (ok) pass += 1; else { fail += 1; failed.push(n); }
  const shown = !ok && d != null ? String(typeof d === 'string' ? d : JSON.stringify(d)).replace(/\+?\d[\d\s]{9,}\d/g, '[number]').slice(0, 600) : ''; // never print a phone number
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${shown ? `  -> ${shown}` : ''}`);
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(150); } };

// ---- the copy ---------------------------------------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-chat-'));
const COPY = path.join(TMP, 'copy.db');
let raw0 = null;
if (/dev\.db$/i.test(COPY)) { console.error('Refusing: the test database must not be dev.db'); process.exit(2); }
{
  const ro = new DatabaseSync(SRC_DB, { readOnly: true });
  ro.exec('PRAGMA busy_timeout = 30000');
  ro.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
  ro.close();
  raw0 = new DatabaseSync(COPY);
  raw0.exec('PRAGMA busy_timeout = 30000');
}
// the copy may already hold WhatsApp numbers the company added: start from the OLD single connection (the numbers are tested in phase B)
for (const t of ['WaMessageMap', 'WaThread', 'WaNumberAccess', 'WaNumber']) { try { raw0.exec(`DELETE FROM "${t}"`); } catch { /* no such table */ } }
raw0.close();
const DBURL = `file:${COPY.split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DBURL;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DBURL;
process.env.MESSAGE_JOB_DIR = path.join(TMP, 'jobs');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
const raw = new DatabaseSync(COPY);
raw.exec('PRAGMA busy_timeout = 30000');
const one = (sql, ...p) => raw.prepare(sql).get(...p);
const all = (sql, ...p) => raw.prepare(sql).all(...p);
const run = (sql, ...p) => raw.prepare(sql).run(...p);

function portFree(port) {
  return new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.once('listening', () => s.close(() => resolve(true))); s.listen(port, '127.0.0.1'); });
}
async function freePort(skip = []) {
  for (let p = 4061; p <= 4099; p += 1) {
    if (p === 4045 || skip.includes(p)) continue; // eslint-disable-line no-continue
    if ((await portFree(p)) && (await portFree(p))) return p;
  }
  throw new Error('No free port between 4061 and 4099');
}
const servers = [];
async function startServer(port, env) {
  const log = { text: '' };
  const proc = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, ...env, PORT: String(port) } });
  proc.stdout.on('data', (d) => { log.text += d; });
  proc.stderr.on('data', (d) => { log.text += d; });
  const api = `http://127.0.0.1:${port}`;
  servers.push({ proc, log });
  for (let i = 0; i < 90; i += 1) {
    try { const r = await fetch(`${api}/api/health`); if (r.ok) return { api, proc, log }; } catch { /* not yet */ }
    await sleep(1000);
  }
  return null;
}
const bodies = [];
let API = '';
async function callAt(api, method, p, token, body, headers) {
  const res = await fetch(`${api}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  bodies.push(text);
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, text };
}
const call = (method, p, token, body, headers) => callAt(API, method, p, token, body, headers);
async function getBytes(p, token) {
  const res = await fetch(`${API}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, type: res.headers.get('content-type'), disp: res.headers.get('content-disposition'), buf: Buffer.from(await res.arrayBuffer()) };
}

(async () => {
  const fake = await startFake({ run: RUN });
  const FAKE = `http://127.0.0.1:${fake.port}`;
  process.env.TL_DEV_MESSAGING_BASE_URL = FAKE;
  process.env.TL_TEST_FAKE_GRAPH = '1';
  const guardedFetch = globalThis.fetch;
  globalThis.fetch = function netGuard(input, init) {
    const u = new URL(typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url));
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return Promise.reject(new TypeError(`TEST BLOCKED outbound to ${u.hostname}`));
    return guardedFetch(input, init);
  };
  const port = await freePort();
  const prisma = require(path.join(BACK, 'src/db'));
  const CAT = require(path.join(BACK, 'src/utils/adminCatalog'));
  const { writeValues } = require(path.join(BACK, 'src/utils/integrationStore'));
  const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
  const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));

  const T0 = `EAAZZLEGACY${RUN}${'x'.repeat(24)}`; const T1 = `EAAZZEDU${RUN}${'e'.repeat(26)}`; const T2 = `EAAZZMED${RUN}${'m'.repeat(26)}`;
  const SECRET0 = `zz-legacy-secret-${RUN}`; const VERIFY0 = `zz-legacy-verify-${RUN}`; const SECRET_MED = `zz-med-secret-${RUN}`;
  const P0 = '100000000000001'; const P1 = '100000000000011'; const P2 = '100000000000022';
  const W0 = '200000000000001'; const W1 = '200000000000002';
  const okMeta = (display, name) => ({ display_phone_number: display, verified_name: name, quality_rating: 'GREEN', code_verification_status: 'VERIFIED', name_status: 'APPROVED', status: 'CONNECTED', messaging_limit_tier: 'TIER_1K' });
  fake.phones[P0] = { token: T0, meta: okMeta('+91 90000 00000', 'ZZ Main') };
  fake.phones[P1] = { token: T1, meta: okMeta('+91 90000 10001', 'ZZ Education') };
  fake.phones[P2] = { token: T2, meta: okMeta('+91 90000 10002', 'ZZ Medical') };
  fake.wabas[W0] = [P0]; fake.wabas[W1] = [P1, P2];
  const D0 = '+91 90000 00000';

  const setWhatsAppRow = async () => {
    const w = await writeValues('whatsapp', {
      [CAT.WA_FIELDS.display]: D0, [CAT.WA_FIELDS.phoneId]: P0, [CAT.WA_FIELDS.wabaId]: W0, [CAT.WA_FIELDS.token]: T0,
      [CAT.WA_FIELDS.language]: 'en', [CAT.WA_FIELDS.appSecret]: SECRET0, [CAT.WA_FIELDS.verifyToken]: VERIFY0,
    });
    await prisma.integration.upsert({ where: { id: 'whatsapp' }, create: { id: 'whatsapp', values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected' }, update: { values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected', error: null } });
  };
  await setWhatsAppRow();

  // ---- fixtures (all ZZTEST, only in the copy) ----
  const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
  const mkUser = async (tag, extra) => {
    const u = await prisma.user.create({ data: { ...base, name: `${TAG} ${tag} ${RUN}`, email: `zz-wac-${tag}-${RUN}@example.test`, username: `zz-wac-${tag}-${RUN}@example.test`, ...extra } });
    await prisma.employee.create({ data: { employeeCode: `ZZTEST-WAC-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, email: u.email, phone: '9000000002', designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null } });
    return u;
  };
  const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const uEdu = await mkUser('edu', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const uEdu2 = await mkUser('edu2', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const uMed = await mkUser('med', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
  const uBoth = await mkUser('both', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
  const uNone = await mkUser('none', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' }); // a department the company gives no WhatsApp number
  const uAcc = await mkUser('acc', { role: 'EMPLOYEE', atsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT', accountsAccess: true });
  const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '3h' });
  const T = { admin: await mint(uAdmin), edu: await mint(uEdu), edu2: await mint(uEdu2), med: await mint(uMed), both: await mint(uBoth), tl: await mint(uTl), bde: await mint(uBde), acc: await mint(uAcc), none: await mint(uNone) };
  const client = await prisma.client.create({ data: { name: `${TAG} Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client' } });
  const reqEdu = await prisma.requirement.create({ data: { title: `${TAG} Job Edu ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uEdu.id, recruiterIds: uBoth.id, tlId: uTl.id, bdeId: uBde.id, openings: 9 } });
  const reqEdu2 = await prisma.requirement.create({ data: { title: `${TAG} Job Edu Two ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uEdu2.id, tlId: uTl.id, bdeId: uBde.id, openings: 9 } });
  const reqMed = await prisma.requirement.create({ data: { title: `${TAG} Job Med ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: uMed.id, recruiterIds: uBoth.id, bdeId: uBde.id, openings: 9 } });
  const reqMfg = await prisma.requirement.create({ data: { title: `${TAG} Job Mfg ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Manufacturing', recruiterId: uNone.id, openings: 9 } });
  let phoneSeq = 21000;
  const mkCand = async (n, req, stage = 'NEW') => {
    phoneSeq += 1;
    const c = await prisma.candidate.create({ data: { name: `${TAG} Cand ${n} ${RUN}`, email: `zz-wac-c${n}-${RUN}@zz-wac-sandbox.in`, phone: `90000${phoneSeq}`, location: 'ZZ' } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage } });
    return { ...c, appId: a.id, e164: `91${c.phone}`, first: `${TAG} Cand ${n} ${RUN}` };
  };
  const cA = await mkCand('A', reqEdu); // the main character (recruiter uEdu)
  const cZ = await mkCand('Z', reqEdu); // a second chat, to see ordering
  const cS = await mkCand('S', reqEdu); // STOP
  const cO = await mkCand('O', reqEdu2); // a candidate of ANOTHER Education recruiter
  const cM = await mkCand('M', reqMed); // Medical
  const cN = await mkCand('N', reqMfg); // a Manufacturing candidate (the recruiter of that department has no WhatsApp number)
  const cB = await mkCand('B', reqEdu, 'SHARED_WITH_CLIENT'); // a BDE can see this one (masked)
  const IN = require(path.join(BACK, 'src/utils/interviewNotices'));
  await prisma.appSetting.upsert({ where: { key: IN.SETTINGS_KEY }, update: { value: JSON.stringify({ enabled: true }) }, create: { key: IN.SETTINGS_KEY, value: JSON.stringify({ enabled: true }) } });

  const SERVER_ENV = {
    TEST_MODE: '1', TL_TEST_FAKE_GRAPH: '1', TL_DEV_MESSAGING_BASE_URL: FAKE, TEST_MOCK_PORTS: String(fake.port), DATABASE_URL: DBURL,
    TEAMLINK_SANDBOX_FILES: path.join(TMP, 'files'), MESSAGE_JOB_DIR: path.join(TMP, 'jobs'), UPLOAD_DIR: path.join(TMP, 'uploads'), TL_COMM_SEND_LIMIT: '400', MSG_RATE_WHATSAPP: '50', TL_WA_MEDIA_WAIT: '1',
  };
  const s1 = await startServer(port, SERVER_ENV);
  check('0 the test server (copy database, fake Meta, TEST_MODE) is up', !!s1, '');
  if (!s1) { await finish(1); return; }
  API = s1.api;
  const serverLog = () => servers.map((s) => s.log.text).join('\n');

  const inbound = (cand, message, id, phoneId = P0, display = D0, secret = SECRET0) => signedWebhook(API, inboundPayload(phoneId, display, cand.e164, message, id || `wamid.in.${RUN}.${Math.random().toString(36).slice(2, 9)}`), secret);
  const textIn = (cand, text, id, phoneId, display, secret) => inbound(cand, { type: 'text', text }, id, phoneId, display, secret);
  const sentTo = (cand, from = 0) => fake.received.slice(from).filter((r) => r.kind === 'messages' && r.accepted && r.body && r.body.to === cand.e164);
  const list = async (token, q = '') => (await call('GET', `/api/wa-chats${q}`, token)).body;
  const rowOf = (l, cand) => (l && l.rows ? l.rows.find((r) => r.personId === cand.id) : null);
  const chat = (token, cand) => call('GET', `/api/wa-chats/person/candidates/${cand.id}`, token);
  const sendText = (token, cand, text, key, extra) => call('POST', `/api/wa-chats/person/candidates/${cand.id}/send`, token, { text, ...(extra || {}) }, key ? { 'idempotency-key': key } : undefined);
  const newKey = () => `k${RUN}${Math.random().toString(36).slice(2, 12)}`;

  try {
    // ===================================================================================================================
    // A: ONE WHATSAPP CONNECTION (the old form)
    // ===================================================================================================================
    const cfgR = await call('GET', '/api/wa-chats/config', T.edu);
    check('A1 config for a recruiter: WhatsApp connected, old single number, no Admin tools', cfgR.status === 200 && cfgR.body.channel.configured && cfgR.body.numbers.legacy === true && cfgR.body.simulate.available === false && cfgR.body.allowed === true, cfgR.body);
    const cfgA = await call('GET', '/api/wa-chats/config', T.admin);
    check('A1b config for the Admin: the pretend-reply tool is available (Test mode) and the webhook path is named', cfgA.body.simulate.available === true && cfgA.body.test.mode === true && cfgA.body.webhook.path === '/api/webhooks/whatsapp' && cfgA.body.isAdmin === true, cfgA.body);
    check('A1c a Candidate / no login are refused', (await call('GET', '/api/wa-chats/config', null)).status === 401);
    const emptyList = await list(T.edu);
    check('A2 before anybody wrote: the list is empty and the badge is 0', emptyList.rows.length === 0 && (await call('GET', '/api/wa-chats/unread-count', T.edu)).body.chats === 0, emptyList);

    // an open follow-up for A (so the "candidate replied" flag has something to flag)
    const fu0 = await call('POST', '/api/followups', T.edu, { applicationId: cA.appId, dueDate: '2099-01-05', nextAction: 'ZZTEST call about the interview', contactMode: 'Call', notes: 'first call' });
    check('A3 fixture: the recruiter has an open follow-up on candidate A', fu0.status === 201, fu0.body);
    const fuId = fu0.body.id;

    // --- 1. the first reply
    const idA1 = `wamid.in.${RUN}.A1`;
    const w1 = await textIn(cA, 'Hello, I am interested. When is the interview? ZZ', idA1);
    check('A4 a signed webhook with the candidate\'s reply is accepted', w1.status === 200 && w1.body.replies === 1, w1);
    const msgRows = all("select * from CandidateMessage where candidateId = ? and channel = 'WhatsApp'", cA.id);
    check('A4b exactly one RECEIVED row for the right candidate with the words', msgRows.length === 1 && msgRows[0].status === 'RECEIVED' && /interview/.test(msgRows[0].body) && msgRows[0].providerRef === idA1, msgRows.length);
    const l1 = await list(T.edu);
    const rA = rowOf(l1, cA);
    check('A5 the recruiter\'s chat list shows the chat: name, requirement, client, step, preview, unread 1, needs reply', !!rA && rA.name === cA.first && rA.unread === 1 && rA.needsReply && rA.last.direction === 'in' && /interview/.test(rA.last.text) && rA.requirement && rA.requirement.title === reqEdu.title && rA.requirement.client === client.name && rA.step && rA.step.label, rA);
    check('A5b the badge API says 1 chat, 1 message', (await call('GET', '/api/wa-chats/unread-count', T.edu)).body.chats === 1);
    check('A5c the owner is the recruiter of the requirement; "Sending from" is the old Main number', rA.ownerUserId === uEdu.id && rA.sendingFrom === null, [rA.ownerUserId, rA.sendingFrom]);
    // a second chat moves to the top
    await sleep(30);
    await textIn(cZ, 'Hi from Z');
    const l2 = await list(T.edu);
    check('A6 a newer reply from another candidate moves to the TOP; two unread chats', l2.rows[0].personId === cZ.id && l2.rows[1].personId === cA.id && l2.unreadChats === 2, l2.rows.map((r) => r.name));
    await sleep(30);
    await textIn(cA, 'Also please confirm the venue');
    const l3 = await list(T.edu);
    check('A6b and A comes back to the top with 2 unread messages in ONE chat', l3.rows[0].personId === cA.id && rowOf(l3, cA).unread === 2 && l3.unreadMessages === 3, [l3.rows[0].name, rowOf(l3, cA).unread, l3.unreadMessages]);

    // --- 2. permissions on a chat nobody may see
    const o1 = await chat(T.med, cA);
    check('A7 another recruiter (Medical) cannot open the chat (403) and does not see it in the list', o1.status === 403 && !rowOf(await list(T.med), cA), o1.status);
    const o2 = await call('GET', `/api/wa-chats/person/candidates/${cA.id}/messages`, T.med);
    const o3 = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/read`, T.med, {});
    const o4 = await sendText(T.med, cA, 'ZZTEST should not go');
    const o5 = await call('GET', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.med);
    check('A7b ...nor read its messages, mark it read, send into it or see its follow-up (all 403)', [o2, o3, o4, o5].every((x) => x.status === 403), [o2.status, o3.status, o4.status, o5.status]);
    const oE2 = await chat(T.edu2, cA);
    check('A7c a recruiter of the SAME department but not on this requirement is refused too (the candidate scope engine decides)', oE2.status === 403 && !rowOf(await list(T.edu2), cA), oE2.status);
    check('A7d an Accountant (no candidate contact) is refused', (await call('GET', '/api/wa-chats/person/candidates/' + cA.id, T.acc)).status === 403);
    check('A7e a made-up person id is refused, and a made-up media id is 404', (await chat(T.edu, { id: 'nope' })).status === 403 && (await call('GET', '/api/wa-chats/media/nope', T.edu)).status === 404);

    // --- 3. the team lead sees the team, and reading it does not clear the recruiter's unread
    const lTl = await list(T.tl);
    check('A8 the team lead sees the team\'s chats (A and Z) with their own unread', !!rowOf(lTl, cA) && !!rowOf(lTl, cZ) && rowOf(lTl, cA).unread === 2, lTl.rows.map((r) => [r.name, r.unread]));
    check('A8b the team lead does not see another Education recruiter\'s candidate chat (none yet) nor Medical', !rowOf(lTl, cM));
    const tlRead = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/read`, T.tl, {});
    check('A8c the lead opens A: the lead\'s unread for A is 0 ...', tlRead.status === 200 && rowOf(await list(T.tl), cA).unread === 0);
    check('A8d ... and the RECRUITER\'S unread is still 2 (read state is per login)', rowOf(await list(T.edu), cA).unread === 2 && (await call('GET', '/api/wa-chats/unread-count', T.edu)).body.messages === 3);
    check('A8e the shared Inbox counter is untouched by the lead (the lead is not the owner)', one('select unread from Conversation where personId = ?', cA.id).unread === 2);

    // --- 4. open the chat
    const c1 = await chat(T.edu, cA);
    check('A9 the chat: header facts, the two replies in time order, window open, nothing blocks sending', c1.status === 200 && c1.body.person.name === cA.first && c1.body.messages.length === 2 && c1.body.messages[0].direction === 'in' && c1.body.window.open === true && c1.body.canSend === true && c1.body.sender.legacy === true && c1.body.sender.label === 'Main number', c1.body);
    check('A9b the direct role gets the phone for the header; a hint exists too', typeof c1.body.person.phone === 'string' && c1.body.person.phone.length >= 10 && !!c1.body.person.phoneHint);
    const rd = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/read`, T.edu, {});
    check('A10 opening marks it read FOR THIS LOGIN: unread 0, badge down by 2, the shared Inbox counter cleared (the owner read it)', rd.body.ok && rowOf(await list(T.edu), cA).unread === 0 && rd.body.unreadMessages === 1 && one('select unread from Conversation where personId = ?', cA.id).unread === 0, rd.body);
    const flagged = await prisma.applicationFollowUp.findUnique({ where: { id: fuId } });
    check('A11 the open follow-up got the flag "Candidate replied" and was NOT completed', /^Candidate replied on WhatsApp: review/.test(flagged.nextAction) && !flagged.completedAt && /ZZTEST call about the interview/.test(flagged.nextAction), flagged);

    // --- 5. the bell
    const bells = () => all("select * from Notification where userId = ? and title like 'New WhatsApp reply from%'", uEdu.id);
    check('A12 the owner got ONE bell "New WhatsApp reply from <name>" for the two quick replies of A (10-minute rule)', bells().filter((b) => b.title.includes(cA.first)).length === 1, bells().map((b) => b.title));
    check('A12b ...and one for Z', bells().filter((b) => b.title.includes(cZ.first)).length === 1);
    run('update WaChatBell set lastBellAt = lastBellAt - ? where userId = ? and personId = ?', 11 * 60000, uEdu.id, cA.id);
    run('update WaChatRead set readAt = readAt - ? where userId = ? and personId = ?', 5 * 60000, uEdu.id, cA.id);
    await textIn(cA, 'Are you there?');
    check('A12c eleven minutes later a new reply rings again (a second bell for A)', bells().filter((b) => b.title.includes(cA.first)).length === 2, bells().map((b) => b.title));
    await textIn(cA, 'Hello??');
    check('A12d ...but not for every message: still 2', bells().filter((b) => b.title.includes(cA.first)).length === 2);
    // idempotent webhook
    const before = all("select id from CandidateMessage where candidateId = ? and channel = 'WhatsApp'", cA.id).length;
    await textIn(cA, 'Hello??', `wamid.in.${RUN}.DUP`);
    await textIn(cA, 'Hello??', `wamid.in.${RUN}.DUP`);
    check('A13 the same Meta message id twice is ONE message (webhook idempotency), and no extra bell', all("select id from CandidateMessage where candidateId = ? and channel = 'WhatsApp'", cA.id).length === before + 1 && bells().filter((b) => b.title.includes(cA.first)).length === 2);
    await call('POST', `/api/wa-chats/person/candidates/${cA.id}/read`, T.edu, {});

    // --- 6. reply from the chat
    let mark = fake.received.length;
    const k1 = newKey();
    const s1r = await sendText(T.edu, cA, 'ZZTEST Interview is on Monday 10 AM', k1);
    check('A14 the recruiter answers from the chat: 200 ok', s1r.status === 200 && s1r.body.ok === true && !!s1r.body.id, s1r);
    const got = sentTo(cA, mark);
    check('A14b the fake Meta got ONE plain text message to the candidate\'s number from the right phone id with the right token', got.length === 1 && got[0].phone === P0 && got[0].body.type === 'text' && /Monday 10 AM/.test(got[0].body.text.body), got.map((g) => g.body));
    const c2 = await until(async () => { const r = await chat(T.edu, cA); return r.body.messages.some((m) => m.direction === 'out') ? r : null; });
    const outMsg = c2 && c2.body.messages.filter((m) => m.direction === 'out').pop();
    check('A14c the message is in the chat as OUTGOING with one tick (sent) and the sender\'s name', !!outMsg && outMsg.state === 'sent' && outMsg.who === uEdu.name && /Monday/.test(outMsg.text), outMsg);
    // double click = one message
    mark = fake.received.length;
    const k2 = newKey();
    const dbl = await Promise.all([sendText(T.edu, cA, 'ZZTEST double click', k2), sendText(T.edu, cA, 'ZZTEST double click', k2)]);
    check('A15 a double click (same key twice at once) sends ONE message', dbl.every((x) => x.status === 200) && sentTo(cA, mark).length === 1 && dbl.filter((x) => x.body.duplicateRequest).length === 1, dbl.map((x) => [x.status, x.body && x.body.duplicateRequest]));
    check('A15b an empty message is refused (400); a very long one too', (await sendText(T.edu, cA, '   ')).status === 400 && (await sendText(T.edu, cA, 'x'.repeat(4001))).status === 400);

    // ticks from signed status webhooks
    const wamid = got[0] && (fake.received.indexOf(got[0]) >= 0 ? `wamid.${RUN}.${fake.received.indexOf(got[0]) + 1}` : null);
    const row0 = all("select providerRef from CandidateMessage where candidateId = ? and channel = 'WhatsApp' and status in ('SENT','DELIVERED','READ') order by createdAt asc", cA.id)[0];
    const ref0 = row0 && row0.providerRef;
    void wamid;
    const since0 = (await chat(T.edu, cA)).body.cursor;
    await signedWebhook(API, statusPayload(P0, D0, ref0, 'delivered', cA.e164), SECRET0);
    const poll1 = await call('GET', `/api/wa-chats/person/candidates/${cA.id}/messages?since=${since0}`, T.edu);
    const u1 = (poll1.body.updates || []).find((u) => u.state === 'delivered');
    check('A16 a signed "delivered" report: the polling answer carries the new tick (delivered)', !!u1, poll1.body.updates);
    await signedWebhook(API, statusPayload(P0, D0, ref0, 'read', cA.e164), SECRET0);
    const c3 = await chat(T.edu, cA);
    check('A16b a signed "read" report: the message shows read (blue ticks)', c3.body.messages.some((m) => m.ref === ref0 && m.state === 'read'), c3.body.messages.map((m) => [m.ref, m.state]));
    await sleep(30);
    mark = fake.received.length;
    await sendText(T.edu, cA, 'ZZTEST this one will fail');
    const ref1 = (all("select providerRef from CandidateMessage where candidateId = ? and channel = 'WhatsApp' and status = 'SENT' order by createdAt desc", cA.id)[0] || {}).providerRef;
    await signedWebhook(API, statusPayload(P0, D0, ref1, 'failed', cA.e164, [{ code: 131026, title: 'Message undeliverable' }]), SECRET0);
    const c4 = await chat(T.edu, cA);
    const failedMsg = c4.body.messages.find((m) => m.ref === ref1);
    check('A17 a signed "failed" report (131026): the message shows Not delivered with a PLAIN reason', failedMsg && failedMsg.state === 'failed' && /not on WhatsApp/i.test(failedMsg.failure) && !/131026/.test(failedMsg.failure), failedMsg);

    // --- 7. the 24-hour rule
    // a template that Meta approved (Admin makes it in Message templates)
    const tpl = await call('POST', '/api/messaging/templates', T.admin, { channel: 'WhatsApp', audience: 'candidate', purposeLabel: `ZZTEST Follow up ${RUN}`, body: 'Hello {{firstName}}, we are waiting for your reply ZZ.', waTemplateName: 'zz_follow_up', waLanguageCode: 'en', waStatus: 'Approved', waVars: ['firstName'] });
    check('A18 fixture: an approved WhatsApp template exists in the shared library', tpl.status === 201, tpl.body);
    run("update AppSetting set value = ? where key = ?", new Date(Date.now() - 25 * 3600 * 1000).toISOString(), `wa.window.${cA.e164}`);
    const c5 = await chat(T.edu, cA);
    check('A19 25 hours after their last message the chat says the window is CLOSED (needs a template)', c5.body.window.open === false && c5.body.window.until < Date.now(), c5.body.window);
    mark = fake.received.length;
    const out24 = await sendText(T.edu, cA, 'ZZTEST free words after a day');
    check('A19b free text is refused with a plain 409 (OUTSIDE_24H) and nothing reaches Meta', out24.status === 409 && out24.body.code === 'OUTSIDE_24H' && /More than 24 hours since they wrote/.test(out24.body.error) && sentTo(cA, mark).length === 0 && !fake.received.slice(mark).some((r) => r.kind === 'messages'), out24);
    const usable = await call('GET', '/api/messaging/templates/usable?audience=candidate&channel=WhatsApp', T.edu);
    const tplRow = (usable.body.templates || []).find((t) => t.waTemplateName === 'zz_follow_up');
    check('A19c the approved template is in the picker list the composer uses', !!tplRow && tplRow.waStatus === 'Approved', usable.body.templates && usable.body.templates.length);
    mark = fake.received.length;
    const tSend = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/send`, T.edu, { purposeKey: tplRow.purpose, templateId: tplRow.id }, { 'idempotency-key': newKey() });
    const tGot = sentTo(cA, mark);
    check('A19d a TEMPLATE send is accepted outside the window: Meta receives a template message with the approved name', tSend.status === 200 && tGot.length === 1 && tGot[0].body.type === 'template' && tGot[0].body.template.name === 'zz_follow_up', [tSend.status, tSend.body, tGot.map((g) => g.body && g.body.type)]);
    const resumeOut = await sendText(T.edu, cA, 'ZZTEST here', undefined, { attachResume: true });
    check('A19e a resume (file) outside the window is refused the same way', resumeOut.status === 409 && resumeOut.body.code === 'OUTSIDE_24H', resumeOut);
    // reopen the window with a reply
    await textIn(cA, 'Sorry for the late reply');
    check('A20 a new reply opens the window again: free text is accepted', (await chat(T.edu, cA)).body.window.open === true && (await sendText(T.edu, cA, 'ZZTEST welcome back', newKey())).status === 200);
    await call('POST', `/api/wa-chats/person/candidates/${cA.id}/read`, T.edu, {});

    // --- 8. STOP
    await textIn(cS, 'hello');
    check('A21 candidate S wrote hello: send works', (await sendText(T.edu, cS, 'ZZTEST hi S', newKey())).status === 200);
    await textIn(cS, 'STOP');
    const cs = await chat(T.edu, cS);
    mark = fake.received.length;
    const stopSend = await sendText(T.edu, cS, 'ZZTEST after stop', newKey());
    check('A21b after STOP the chat says opted out, sending is blocked (409 OPTED_OUT) and Meta gets nothing', cs.body.optedOut === true && cs.body.canSend === false && cs.body.blockedCode === 'OPTED_OUT' && stopSend.status === 409 && stopSend.body.code === 'OPTED_OUT' && sentTo(cS, mark).length === 0, [cs.body.blockedCode, stopSend.status, stopSend.body]);
    check('A21c the STOP message is marked in the chat', cs.body.messages.some((m) => m.stop === true));

    // --- 9. media (picture, PDF, voice note, a file type we refuse, a fake picture)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const pdf = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 1)]);
    fake.media[`m.png.${RUN}`] = { mime: 'image/png', bytes: png };
    fake.media[`m.pdf.${RUN}`] = { mime: 'application/pdf', bytes: pdf };
    fake.media[`m.ogg.${RUN}`] = { mime: 'audio/ogg', bytes: ogg };
    fake.media[`m.html.${RUN}`] = { mime: 'text/html', bytes: Buffer.from('<script>alert(1)</script>') };
    fake.media[`m.fake.${RUN}`] = { mime: 'image/png', bytes: Buffer.from('this is not a picture at all') };
    await inbound(cA, { type: 'image', mediaId: `m.png.${RUN}`, mime: 'image/png', caption: 'My certificate ZZ' });
    await inbound(cA, { type: 'document', mediaId: `m.pdf.${RUN}`, mime: 'application/pdf', filename: 'My Resume.pdf' });
    await inbound(cA, { type: 'audio', mediaId: `m.ogg.${RUN}`, mime: 'audio/ogg', voice: true });
    await inbound(cA, { type: 'document', mediaId: `m.html.${RUN}`, mime: 'text/html', filename: 'evil.html' });
    await inbound(cA, { type: 'image', mediaId: `m.fake.${RUN}`, mime: 'image/png' });
    const c6 = await chat(T.edu, cA);
    const withMedia = c6.body.messages.filter((m) => m.media && m.media.length);
    const mk = (kind) => withMedia.map((m) => m.media[0]).find((x) => x.kind === kind);
    check('A22 the picture is stored and shown with its caption; the PDF as a document with its name; the voice note as a voice note', mk('image') && mk('image').status === 'stored' && withMedia.find((m) => m.media[0].kind === 'image' && m.text === 'My certificate ZZ') && mk('document') && mk('document').name === 'My Resume.pdf' && mk('voice') && mk('voice').status === 'stored', withMedia.map((m) => [m.text, m.media]));
    const png1 = await getBytes(`/api/wa-chats/media/${mk('image').id}`, T.edu);
    check('A22b the picture is served to the owner as inline image/png with the same bytes and nosniff', png1.status === 200 && png1.type === 'image/png' && /^inline/.test(png1.disp) && png1.buf.equals(png), [png1.status, png1.type, png1.disp]);
    const pdf1 = await getBytes(`/api/wa-chats/media/${mk('document').id}`, T.edu);
    check('A22c the PDF is served as an ATTACHMENT (download) with the same bytes', pdf1.status === 200 && pdf1.type === 'application/pdf' && /^attachment/.test(pdf1.disp) && pdf1.buf.equals(pdf), [pdf1.status, pdf1.disp]);
    const voice1 = await getBytes(`/api/wa-chats/media/${mk('voice').id}`, T.tl);
    check('A22d the voice note (audio/ogg) plays for the team lead too (same team)', voice1.status === 200 && voice1.type === 'audio/ogg' && voice1.buf.equals(ogg), [voice1.status, voice1.type]);
    check('A22e IDOR: another recruiter (403), a login that is not signed in (401) cannot fetch the file; a made-up id is 404', (await getBytes(`/api/wa-chats/media/${mk('image').id}`, T.med)).status === 403 && (await getBytes(`/api/wa-chats/media/${mk('image').id}`, null)).status === 401 && (await getBytes(`/api/wa-chats/media/${mk('image').id}x`, T.edu)).status === 404);
    const htmlRow = one("select * from WaChatMedia where providerRef like '%' and mime = 'text/html' and personId = ?", cA.id);
    const fakeRow = one("select * from WaChatMedia where personId = ? and status = 'blocked' and mime = 'image/png'", cA.id);
    check('A23 an HTML file is NOT kept (blocked with a plain note) and is never served; a fake "picture" is not kept either', htmlRow && htmlRow.status === 'blocked' && !htmlRow.stored && (await getBytes(`/api/wa-chats/media/${htmlRow.id}`, T.edu)).status === 409 && fakeRow && !fakeRow.stored, [htmlRow, fakeRow]);
    const filesOnDisk = fs.existsSync(path.join(TMP, 'uploads', 'wa-media')) ? fs.readdirSync(path.join(TMP, 'uploads', 'wa-media')) : [];
    check('A23b only the three good files are on disk, under random names (never the sender\'s name)', filesOnDisk.length === 3 && filesOnDisk.every((f) => /^[a-f0-9]{32}\.(png|pdf|ogg)$/.test(f)), filesOnDisk);
    check('A23c Meta was asked for the media with the right token (lookup + download accepted)', fake.received.some((r) => r.kind === 'media_lookup' && r.accepted) && fake.received.some((r) => r.kind === 'media_download' && r.accepted));
    const lm = await list(T.edu);
    check('A24 the list preview of a file-only reply says what it is (not a bare bracket)', ['Photo', 'Voice note', 'Document', 'My certificate'].some((w) => (rowOf(lm, cA).last.text || '').includes(w)) || /Photo|Document|Voice/.test(rowOf(lm, cA).last.text), rowOf(lm, cA).last);
    await call('POST', `/api/wa-chats/person/candidates/${cA.id}/read`, T.edu, {});

    // --- 10. follow-up on the same screen
    const f1 = await call('GET', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.edu);
    const fa = f1.body.applications.find((x) => x.applicationId === cA.appId);
    check('A25 the follow-up panel: the open follow-up with the "Candidate replied" mark (time), quick buttons and the choices for Mark done', f1.status === 200 && fa && fa.open && fa.open.id === fuId && fa.open.repliedAt > 0 && fa.canRecord === true && f1.body.quick.length === 3 && f1.body.outcomes.includes('Interested'), f1.body);
    const snz = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/followup/${fuId}/snooze`, T.edu, { quick: 'tomorrow10' });
    const ist = new Date(Date.now() + 330 * 60000 + 86400000).toISOString().slice(0, 10);
    check('A26 Snooze "Tomorrow 10:00": the SAME follow-up moves to tomorrow 10:00 (India time)', snz.status === 200 && snz.body.followUp.id === fuId && snz.body.followUp.dueDate === ist && snz.body.followUp.dueTime === '10:00', snz.body);
    const fl = await call('GET', `/api/followups?applicationId=${cA.appId}`, T.edu);
    const inList = (fl.body || []).find((r) => r.applicationId === cA.appId);
    check('A26b the normal Follow-ups API shows the new date/time (the Follow-ups screens and reminders read the same row)', inList && inList.dueDate === ist && inList.dueTime === '10:00', inList);
    const sched = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.edu, { applicationId: cA.appId, quick: 'in3days', note: 'Ask about the notice period' });
    check('A27 "Schedule" while one is open moves it (200, moved) instead of making a second one', sched.status === 200 && sched.body.moved === true && sched.body.followUp.id === fuId && sched.body.followUp.notes === 'Ask about the notice period', sched.body);
    const custom = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.edu, { applicationId: cA.appId, dueDate: '2099-03-04', dueTime: '16:30', note: 'custom' });
    check('A27b a custom date and time works; a bad date / time is refused with plain words', custom.status === 200 && custom.body.followUp.dueDate === '2099-03-04' && custom.body.followUp.dueTime === '16:30' && (await call('POST', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.edu, { applicationId: cA.appId, dueDate: 'tomorrow' })).status === 400 && (await call('POST', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.edu, { applicationId: cA.appId, dueDate: '2099-03-04', dueTime: '25:99' })).status === 400);
    check('A27c another recruiter cannot schedule / snooze on this application (403)', (await call('POST', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.med, { applicationId: cA.appId, quick: 'in3days' })).status === 403 && (await call('POST', `/api/wa-chats/person/candidates/${cA.id}/followup/${fuId}/snooze`, T.med, { quick: 'in3days' })).status === 403);
    check('A27d the team lead (who is not on the assignment chain as recorder) is judged by the same ownership rule as the Follow-ups screen: it may read the panel', (await call('GET', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.tl)).status === 200);
    // Mark done through the normal route (the chat uses it)
    const done = await call('POST', `/api/followups/${fuId}/complete`, T.edu, { outcome: 'Interested', nextStep: 'Schedule interview', nextFollowUpAt: '2099-04-01', nextFollowUpTime: '11:00', note: 'Told them Monday' });
    check('A28 "Mark done" completes the follow-up and the next one starts by itself (normal Follow-up rows)', done.status === 200 && done.body.completedAt && done.body.nextFollowUp && done.body.nextFollowUp.dueDate === '2099-04-01', done.body);
    const f2 = (await call('GET', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.edu)).body.applications.find((x) => x.applicationId === cA.appId);
    check('A28b the panel now shows the new open follow-up (no reply mark yet) and the finished one in the history', f2.open && f2.open.id === done.body.nextFollowUp.id && !f2.open.repliedAt && f2.history.some((h) => h.id === fuId && h.outcome === 'Interested'), f2);
    await textIn(cA, 'One more question please');
    const f3 = (await call('GET', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.edu)).body.applications.find((x) => x.applicationId === cA.appId);
    check('A28c a new reply flags the NEW open follow-up again, still without completing it', f3.open.repliedAt > 0 && !f3.open.completedAt && /^Candidate replied/.test(f3.open.nextAction), f3.open);
    const dash = await call('GET', '/api/followups/dashboard', T.edu);
    check('A28d the Follow-ups dashboard still works and lists the candidate\'s follow-up (counts come from the same rows)', dash.status === 200 && (dash.body.mine.rows || []).some((r) => r.applicationId === cA.appId), dash.status);
    // the list says "today's follow-ups"
    await call('POST', `/api/wa-chats/person/candidates/${cA.id}/followup`, T.edu, { applicationId: cA.appId, dueDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10), dueTime: '09:00' });
    const lf = await list(T.edu, '?state=followups');
    check('A29 the filter "Today\'s follow-ups" lists the chat whose follow-up is due or late', lf.rows.length === 1 && lf.rows[0].personId === cA.id && lf.rows[0].followUp.due === true, lf.rows.map((r) => r.name));

    // a candidate who has NO follow-up yet: scheduling from the chat makes a normal Follow-up row
    const noFu = await call('GET', `/api/followups/application/${cZ.appId}`, T.edu);
    const mkFu = await call('POST', `/api/wa-chats/person/candidates/${cZ.id}/followup`, T.edu, { applicationId: cZ.appId, quick: 'tomorrow10', note: 'Ask about joining date' });
    const afterFu = await call('GET', `/api/followups/application/${cZ.appId}`, T.edu);
    check('A29b with no follow-up open, "Schedule" creates a normal Follow-up row (201) with the note, WhatsApp as the way, due tomorrow 10:00, visible in the Follow-ups API of that application', noFu.body.current === null && mkFu.status === 201 && mkFu.body.moved === false && afterFu.body.current && afterFu.body.current.id === mkFu.body.followUp.id && afterFu.body.current.contactMode === 'WhatsApp' && afterFu.body.current.dueTime === '10:00' && /Ask about joining/.test(afterFu.body.current.notes || ''), [noFu.body.current, mkFu.status, afterFu.body.current]);
    const lfZ = await call('GET', `/api/followups?applicationId=${cZ.appId}`, T.edu);
    check('A29c ...and it is in the main Follow-ups list too (the same row)', (lfZ.body || []).some((r) => r.applicationId === cZ.appId && r.followUpId === mkFu.body.followUp.id), lfZ.status);

    // --- 11. reply tag
    const it1 = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/intent`, T.edu, { intent: 'call_back' });
    check('A30 the reply tag "Call back" is saved, shows in the list and the chat; a made-up tag is refused; clearing works', it1.status === 200 && rowOf(await list(T.edu), cA).intent === 'call_back' && (await chat(T.edu, cA)).body.intent === 'call_back' && (await call('POST', `/api/wa-chats/person/candidates/${cA.id}/intent`, T.edu, { intent: 'hacker' })).status === 400 && (await call('POST', `/api/wa-chats/person/candidates/${cA.id}/intent`, T.edu, { intent: null })).status === 200 && rowOf(await list(T.edu), cA).intent === null);
    check('A30b another recruiter cannot tag it (403)', (await call('POST', `/api/wa-chats/person/candidates/${cA.id}/intent`, T.med, { intent: 'interested' })).status === 403);

    // --- 12. stage change from the chat obeys the pipeline rules
    const steps = await call('GET', `/api/wa-chats/person/candidates/${cA.id}/steps`, T.edu);
    const sa = steps.body.applications.find((x) => x.applicationId === cA.appId);
    check('A31 the steps the recruiter may move to are offered (and Rejected / Hold are left to the profile page)', steps.status === 200 && sa.moves.length > 0 && sa.moves.some((m) => m.code === 'RECRUITER_REVIEW') && !sa.moves.some((m) => ['REJECTED', 'HOLD'].includes(m.code)) && !sa.moves.some((m) => m.code === 'SHARED_WITH_CLIENT'), sa.moves.map((m) => m.code));
    const mvOk = await call('PATCH', `/api/applications/${cA.appId}/stage`, T.edu, { stage: 'RECRUITER_REVIEW', comment: 'Moved from the WhatsApp chat' });
    check('A31b the move to an allowed step works through the normal pipeline route', mvOk.status === 200, mvOk.body);
    const mvNo = await call('PATCH', `/api/applications/${cA.appId}/stage`, T.edu, { stage: 'SHARED_WITH_CLIENT', comment: 'not allowed' });
    check('A31c a step the recruiter may not take is refused by the pipeline (403) - the chat has no back door', mvNo.status === 403, [mvNo.status, mvNo.body]);
    check('A31d the list now shows the new step name', rowOf(await list(T.edu), cA).step.code === 'RECRUITER_REVIEW');

    // --- 13. filters + search
    await textIn(cZ, 'ZZ question for search');
    const lu = await list(T.edu, '?state=unread');
    check('A32 filter Unread: only chats with unread (Z); Needs reply and Waiting give different sets', lu.rows.length >= 1 && lu.rows.every((r) => r.unread > 0) && lu.rows.some((r) => r.personId === cZ.id), lu.rows.map((r) => [r.name, r.unread]));
    const lnr = await list(T.edu, '?state=needsReply'); const lw = await list(T.edu, '?state=waiting');
    check('A32b Needs reply = last message is theirs; Waiting for the candidate = last message is ours', lnr.rows.every((r) => r.last.direction === 'in') && lw.rows.every((r) => r.last.direction === 'out') && lnr.counts.needsReply + lw.counts.waiting === lnr.counts.all, [lnr.counts, lw.counts]);
    const bySearch = await list(T.edu, `?q=${encodeURIComponent('Cand Z')}`);
    const byDigits = await list(T.edu, `?q=${cA.phone.slice(-5)}`);
    check('A33 search by name and by the last digits of the phone', bySearch.rows.length === 1 && bySearch.rows[0].personId === cZ.id && byDigits.rows.length === 1 && byDigits.rows[0].personId === cA.id, [bySearch.rows.length, byDigits.rows.length]);
    const byReq = await list(T.edu, `?requirementId=${reqEdu.id}`);
    const byReqNone = await list(T.edu, `?requirementId=${reqEdu2.id}`);
    check('A34 filter by requirement; the choices list names the requirement with counts', byReq.rows.length >= 2 && byReqNone.rows.length === 0 && byReq.requirements.some((r) => r.id === reqEdu.id && r.count >= 2), [byReq.rows.length, byReq.requirements]);

    // --- 14. polling is cheap
    await sleep(5700); // the cursor looks 5 seconds back, so a message that was saved a moment late is never missed
    const t0 = (await call('GET', '/api/wa-chats/changes?since=0', T.edu)).body.now;
    const quiet = await call('GET', `/api/wa-chats/changes?since=${t0 + 1}`, T.edu);
    check('A35 polling the list with a cursor when nothing changed: tiny answer (< 250 bytes), changed 0', quiet.status === 200 && quiet.body.changed === 0 && quiet.text.length < 250, quiet.text);
    await sleep(20);
    await textIn(cO, 'ZZ from the other recruiter\'s candidate');
    const lc = await call('GET', `/api/wa-chats/changes?since=${quiet.body.now}`, T.edu2);
    check('A35b ...and says "changed 1" for the recruiter who owns the changed chat, "0" for one who does not', lc.body.changed === 1 && (await call('GET', `/api/wa-chats/changes?since=${quiet.body.now}`, T.edu)).body.changed === 0, [lc.body, ]);
    const cur = (await chat(T.edu, cA)).body.cursor;
    await sleep(20);
    await textIn(cA, 'ZZ poll me');
    const pm = await call('GET', `/api/wa-chats/person/candidates/${cA.id}/messages?since=${cur}`, T.edu);
    check('A36 polling the open chat with its cursor returns ONLY the new message (not the whole chat) in a small answer', pm.body.messages.length === 1 && /poll me/.test(pm.body.messages[0].text) && pm.text.length < 2500, [pm.body.messages.length, pm.text.length]);
    const pmOld = await call('GET', `/api/wa-chats/person/candidates/${cA.id}/messages?before=${Date.now()}&limit=3`, T.edu);
    check('A36b older messages come page by page with "before" and a limit', pmOld.body.messages.length === 3 && pmOld.body.hasOlder === true, pmOld.body.messages.length);
    const plan = all("explain query plan select candidateId from CandidateMessage where channel = 'WhatsApp' and createdAt > 1").map((r) => r.detail).join(' | ');
    check('A36c the "WhatsApp messages after the cursor" query uses an index (no table scan)', /USING (COVERING )?INDEX/i.test(plan) && !/SCAN CandidateMessage\s*$/i.test(plan), plan);

    // --- 15. reassign (a lead) / masked BDE
    const asg403 = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/assign`, T.edu, { userId: uEdu2.id });
    check('A37 a recruiter cannot give the chat away (403, only a lead)', asg403.status === 403, asg403.body);
    const peopleR = await call('GET', `/api/wa-chats/person/candidates/${cA.id}/assignees`, T.tl);
    const asgOk = await call('POST', `/api/wa-chats/person/candidates/${cA.id}/assign`, T.tl, { userId: uEdu.id });
    check('A37b the team lead sees the people list and can give the chat to a person of the area', peopleR.status === 200 && peopleR.body.people.length > 0 && asgOk.status === 200 && asgOk.body.owner.userId === uEdu.id, [peopleR.status, asgOk.body]);
    check('A37c ...but not to someone outside the area (403)', (await call('POST', `/api/wa-chats/person/candidates/${cA.id}/assign`, T.tl, { userId: uMed.id })).status === 403);
    await textIn(cB, 'my number is 9876543210 and mail me at zz@test.in');
    const bdeList = await list(T.bde);
    const bRow = rowOf(bdeList, cB);
    check('A38 the BDE sees the chat of a candidate shared with their client, with the phone HIDDEN (hint only) and numbers in the text scrubbed', !!bRow && bRow.phoneHint && !/9876543210/.test(bRow.last.text) && /number hidden/.test(bRow.last.text) && !JSON.stringify(bdeList).includes(cB.phone), bRow);
    const bdeChat = await chat(T.bde, cB);
    check('A38b the BDE chat header has no phone, the messages are scrubbed, and BDE cannot see a candidate not shared with the client', bdeChat.status === 200 && bdeChat.body.person.phone === null && bdeChat.body.masked === true && !bdeChat.text.includes(cB.phone) && !/9876543210/.test(bdeChat.text) && (await chat(T.bde, cA)).status === 403, [bdeChat.status, bdeChat.body.person]);
    const bdeSearch = await list(T.bde, `?q=${cB.phone.slice(-5)}`);
    check('A38c a masked role cannot find a chat by phone digits (search by number is off for it)', bdeSearch.rows.length === 0);

    await textIn(cN, 'Hello from the Manufacturing candidate');
    // --- 16. a client contact and an unknown number
    const cl = { id: client.id, name: `${TAG} Client ${RUN}`, e164: '919000099001', phone: '9000099001' };
    await prisma.client.update({ where: { id: client.id }, data: { contactPhone: cl.phone, contactName: 'ZZ Contact' } });
    await signedWebhook(API, inboundPayload(P0, D0, cl.e164, { type: 'text', text: 'Please send two more profiles ZZ' }, `wamid.in.${RUN}.CL1`), SECRET0);
    const clList = await call('GET', '/api/wa-chats', T.bde);
    const clRow = (clList.body.rows || []).find((r) => r.personId === client.id);
    check('A39 a CLIENT contact WhatsApp reply shows in the client manager (BDE) chat list, unread, as a Client chat', !!clRow && clRow.personType === 'CLIENT' && clRow.unread === 1 && /two more profiles/.test(clRow.last.text), clList.body.rows && clList.body.rows.map((r) => r.personType));
    check('A39b ...a recruiter does not get client chats (no contact right for clients), and cannot open it', !(await list(T.edu)).rows.some((r) => r.personType === 'CLIENT') && (await call('GET', `/api/wa-chats/person/clients/${client.id}`, T.edu)).status === 403);
    const clChat = await call('GET', `/api/wa-chats/person/clients/${client.id}`, T.bde);
    const clRead = await call('POST', `/api/wa-chats/person/clients/${client.id}/read`, T.bde, {});
    check('A39c the BDE opens the client chat (messages, window open), reads it (unread 0 for the BDE)', clChat.status === 200 && clChat.body.messages.length === 1 && clChat.body.window.open === true && clRead.status === 200 && (await call('GET', '/api/wa-chats', T.bde)).body.rows.find((r) => r.personId === client.id).unread === 0, clChat.status);
    const needBefore = (await call('GET', '/api/wa-chats/config', T.admin)).body.needsReview;
    await signedWebhook(API, inboundPayload(P0, D0, '919777700001', { type: 'text', text: 'Who is this? ZZ stranger' }, `wamid.in.${RUN}.STR1`), SECRET0);
    const cfgN = await call('GET', '/api/wa-chats/config', T.admin);
    check('A40 a reply from a number nobody knows goes to the Needs review queue (not into any chat); the Admin sees the count, a recruiter sees 0', cfgN.body.needsReview === needBefore + 1 && (await call('GET', '/api/wa-chats/config', T.edu)).body.needsReview === 0 && !(await list(T.admin)).rows.some((r) => /stranger/.test(r.last.text)), [needBefore, cfgN.body.needsReview]);

    // ===================================================================================================================
    // B: SEVERAL NUMBERS
    // ===================================================================================================================
    const edu = { label: 'Education desk', displayNumber: '+91 90000 10001', phoneNumberId: P1, wabaId: W1, tokenMode: 'own', token: T1, language: 'en' };
    const med = { label: 'Medical desk', displayNumber: '+91 90000 10002', phoneNumberId: P2, wabaId: W1, tokenMode: 'own', token: T2, appSecret: SECRET_MED, language: 'en' };
    const eC = await call('POST', '/api/wa-numbers', T.admin, edu);
    const mC = await call('POST', '/api/wa-numbers', T.admin, med);
    check('B1 fixture: two numbers added (Education, Medical)', eC.status === 200 && mC.status === 200, [eC.body, mC.body]);
    const nEdu = eC.body.id; const nMed = mC.body.id;
    const accE = await call('PUT', `/api/wa-numbers/${nEdu}/access`, T.admin, { departments: ['Education'], userIds: [], roles: [], everyone: false });
    const accM = await call('PUT', `/api/wa-numbers/${nMed}/access`, T.admin, { departments: ['Medical'], userIds: [], roles: [], everyone: false });
    const mainRow = (await call('GET', '/api/wa-numbers', T.admin)).body.numbers.find((n) => n.isMain);
    await call('PUT', `/api/wa-numbers/${mainRow.id}/access`, T.admin, { departments: ['Accounts'], userIds: [], roles: [], everyone: false });
    check('B1b access: Education desk -> Education, Medical desk -> Medical, Main -> Accounts only', accE.status === 200 && accM.status === 200);
    const cfgB = await call('GET', '/api/wa-chats/config', T.edu);
    check('B2 config: the recruiter sees the list of numbers (not the old single form) and only his own', cfgB.body.numbers.legacy === false && cfgB.body.numbers.numbers.length === 1 && cfgB.body.numbers.numbers[0].label === 'Education desk', cfgB.body.numbers);
    // chats on numbers
    await textIn(cA, 'Hello on the Education number', undefined, P1, '+91 90000 10001', SECRET0);
    await textIn(cM, 'Hello on the Medical number', undefined, P2, '+91 90000 10002', SECRET_MED);
    const lb = await list(T.edu);
    const rbA = rowOf(lb, cA);
    check('B3 the chat of A (written to the Education desk) says "Sending from Education desk" and has a number chip', rbA && rbA.sendingFrom === 'Education desk' && rbA.numbers.some((n) => n.label === 'Education desk'), rbA && rbA.numbers);
    check('B3b the Education recruiter sees no chat of the Medical number', !rowOf(lb, cM));
    const lboth = await list(T.both);
    check('B4 WaNumberAccess: a recruiter who is on the Medical requirement but is NOT given the Medical number does NOT see that chat (and cannot open it)', !rowOf(lboth, cM) && (await chat(T.both, cM)).status === 403, lboth.rows.map((r) => r.name));
    const lmed = await list(T.med);
    check('B4b the Medical recruiter sees it, sending from Medical desk; the number filter lists only his number', rowOf(lmed, cM) && rowOf(lmed, cM).sendingFrom === 'Medical desk' && lmed.numbers.length === 1 && lmed.numbers[0].label === 'Medical desk', lmed.numbers);
    const lnf = await list(T.admin, `?numberId=${nEdu}`);
    check('B4c the number filter (Admin): only chats on that number', lnf.rows.length >= 1 && lnf.rows.every((r) => r.numbers.some((n) => n.id === nEdu)) && !rowOf(lnf, cM), lnf.rows.map((r) => r.name));
    mark = fake.received.length;
    const sendB = await sendText(T.edu, cA, 'ZZTEST answer on the same number', newKey());
    const gotB = fake.received.slice(mark).filter((r) => r.kind === 'messages' && r.accepted && r.body.to === cA.e164);
    check('B5 the answer leaves from the chat\'s own number: the fake Meta saw phone id P1 (Education) with the Education token', sendB.status === 200 && gotB.length === 1 && gotB[0].phone === P1 && sendB.body.sentFrom === 'Education desk', [sendB.status, gotB.map((g) => g.phone)]);
    const sendBad = await sendText(T.edu, cA, 'ZZTEST from the Medical number', newKey(), { waNumberId: nMed });
    check('B5b choosing a number he is not given is refused (403) and nothing is sent', sendBad.status === 403 && !fake.received.slice(mark).some((r) => r.phone === P2 && r.kind === 'messages'), [sendBad.status, sendBad.body]);
    const mediaOnMed = (() => { fake.media[`m.med.${RUN}`] = { mime: 'image/png', bytes: png }; return true; })();
    void mediaOnMed;
    await inbound(cM, { type: 'image', mediaId: `m.med.${RUN}`, mime: 'image/png' }, undefined, P2, '+91 90000 10002', SECRET_MED);
    const medMedia = one("select * from WaChatMedia where personId = ? and status = 'stored'", cM.id);
    check('B6 a picture that came on the Medical number is stored and downloaded with the MEDICAL token; the Education recruiter cannot fetch it', medMedia && (await getBytes(`/api/wa-chats/media/${medMedia.id}`, T.med)).status === 200 && (await getBytes(`/api/wa-chats/media/${medMedia.id}`, T.both)).status === 403, medMedia);
    // 24-hour window belongs to the number
    run('update WaThread set lastInboundAt = ? where numberId = ? and contact = ?', new Date(Date.now() - 25 * 3600 * 1000).toISOString(), nEdu, cA.e164);
    const cb = await chat(T.edu, cA);
    const out24b = await sendText(T.edu, cA, 'ZZTEST late on number', newKey());
    check('B7 with several numbers the 24-hour window is the number\'s: closed after 25 h, free text refused (409), the chat says so', cb.body.window.open === false && out24b.status === 409 && out24b.body.code === 'OUTSIDE_24H', [cb.body.window, out24b.status]);
    await textIn(cA, 'back again', undefined, P1, '+91 90000 10001', SECRET0);
    check('B7b a reply on that number opens it again', (await chat(T.edu, cA)).body.window.open === true);
    // the shared Inbox's number rule and the chat's: the admin sees everything
    const ladmin = await list(T.admin);
    check('B8 the Admin sees the chats of every number', !!rowOf(ladmin, cA) && !!rowOf(ladmin, cM));
    // replies on a number nobody added never route
    const unk = await signedWebhook(API, inboundPayload('999999999999999', '+91 99999 99999', cZ.e164, { type: 'text', text: 'ZZ to a number nobody added' }, `wamid.in.${RUN}.UNK`), SECRET0);
    check('B9 a reply to a phone id nobody added is kept as an unknown-number event and shown in NO chat', unk.status === 200 && !(await chat(T.edu, cZ)).body.messages.some((m) => /nobody added/.test(m.text)));

    // a login that was given no WhatsApp number at all (the chat started before the numbers list existed, so it sits on no number)
    const nCfg = await call('GET', '/api/wa-chats/config', T.none);
    const nChat = await chat(T.none, cN);
    const nSend = await sendText(T.none, cN, 'ZZTEST no number for me', newKey());
    check('B10 a login with no WhatsApp number: the config says so (empty list), the chat shows the plain reason, sending is refused (409 NO_WHATSAPP_NUMBER) and Meta gets nothing', nCfg.body.numbers.legacy === false && nCfg.body.numbers.numbers.length === 0 && nChat.status === 200 && nChat.body.canSend === false && nChat.body.blockedCode === 'NO_WHATSAPP_NUMBER' && /No WhatsApp number is assigned to you yet/.test(nChat.body.blocked) && nSend.status === 409 && nSend.body.code === 'NO_WHATSAPP_NUMBER' && !fake.received.some((r) => r.kind === 'messages' && r.accepted && r.body && r.body.to === cN.e164), [nCfg.body.numbers, nChat.status, nChat.body.blockedCode, nSend.status, nSend.body]);

    // ===================================================================================================================
    // C: ADMIN TEST TOOLS
    // ===================================================================================================================
    const st = await call('GET', '/api/wa-chats/test/status', T.admin);
    check('C1 test status (Admin): available in Test mode; a recruiter gets 403', st.status === 200 && st.body.available === true && st.body.testMode === true && (await call('GET', '/api/wa-chats/test/status', T.edu)).status === 403, st.body);
    check('C1b a recruiter / TL / BDE cannot pretend a reply (403)', (await call('POST', '/api/wa-chats/test/simulate-reply', T.bde, { personId: cZ.id, text: 'x' })).status === 403 && (await call('POST', '/api/wa-chats/test/simulate-reply', T.edu, { personId: cZ.id, text: 'x' })).status === 403 && (await call('POST', '/api/wa-chats/test/simulate-reply', T.tl, { personId: cZ.id, text: 'x' })).status === 403);
    const realBefore = {
      msgs: one("select count(*) n from CandidateMessage where providerRef not like 'testsim.%'").n,
      conv: all('select personId, unread, lastSnippet, lastMessageAt from Conversation order by personId'),
      fu: all('select id, nextAction, dueDate from ApplicationFollowUp order by id'),
      windows: all("select key, value from AppSetting where key like 'wa.window.%' order by key"),
    };
    const sim = await call('POST', '/api/wa-chats/test/simulate-reply', T.admin, { personId: cZ.id, text: 'TEST: I can join next week', numberId: nEdu });
    check('C2 the Admin\'s pretend reply goes through the SAME inbound pipeline: stored as an ordinary reply (id starts "testsim."), unread for the owner, on top of the list', sim.status === 200 && sim.body.ok && /^testsim\./.test(sim.body.id) && sim.body.result.replies === 1, sim);
    const lsim = await list(T.edu);
    check('C2b ...it shows in the recruiter\'s list as new and unread', lsim.rows[0].personId === cZ.id && lsim.rows[0].unread > 0 && /join next week/.test(lsim.rows[0].last.text), lsim.rows[0]);
    const simImg = await call('POST', '/api/wa-chats/test/simulate-reply', T.admin, { personId: cZ.id, kind: 'image', text: 'TEST photo', numberId: nEdu });
    const simDoc = await call('POST', '/api/wa-chats/test/simulate-reply', T.admin, { personId: cZ.id, kind: 'document', numberId: nEdu });
    const cz = await chat(T.edu, cZ);
    check('C2c a pretend picture and a pretend PDF are stored as media and shown', simImg.status === 200 && simDoc.status === 200 && cz.body.messages.some((m) => m.test && m.media.some((x) => x.kind === 'image' && x.status === 'stored')) && cz.body.messages.some((m) => m.test && m.media.some((x) => x.kind === 'document' && x.status === 'stored')), cz.body.messages.filter((m) => m.test).map((m) => [m.text, m.media]));
    check('C2d test messages are marked test in the chat', cz.body.messages.some((m) => m.test === true));
    const simStop = await call('POST', '/api/wa-chats/test/simulate-reply', T.admin, { personId: cS.id, stop: true, numberId: nEdu });
    check('C2e a pretend STOP is honoured like a real one (the chat of S says opted out)', simStop.status === 200 && (await chat(T.edu, cS)).body.optedOut === true);
    check('C3 a candidate that does not exist -> 404; the bad input is refused', (await call('POST', '/api/wa-chats/test/simulate-reply', T.admin, { personId: 'nope', text: 'x' })).status === 404);
    const stN = await call('GET', '/api/wa-chats/test/status', T.admin);
    check('C4 test status counts the pretend messages', stN.body.testMessages >= 4, stN.body);
    // a server where real sending is ON must refuse
    const port2 = await freePort([port]);
    const s2 = await startServer(port2, { ...SERVER_ENV, TL_WA_CHATS_ASSUME_REAL: '1' });
    check('C5 (second server, "real sending is on") starts', !!s2);
    if (s2) {
      const sim2 = await callAt(s2.api, 'POST', '/api/wa-chats/test/simulate-reply', T.admin, { personId: cZ.id, text: 'must not be allowed' });
      const cfg2 = await callAt(s2.api, 'GET', '/api/wa-chats/config', T.admin);
      const st2 = await callAt(s2.api, 'GET', '/api/wa-chats/test/status', T.admin);
      check('C5b with real sending on, the pretend reply is REFUSED by the server (403), the config says unavailable, nothing was written', sim2.status === 403 && cfg2.body.simulate.available === false && st2.body.available === false && !all("select id from CandidateMessage where body = 'must not be allowed'").length, [sim2.status, sim2.body, cfg2.body.simulate]);
      const rm2 = await callAt(s2.api, 'POST', '/api/wa-chats/test/remove', T.edu, {});
      check('C5c a recruiter cannot remove test messages either (403)', rm2.status === 403);
      try { s2.proc.kill(); } catch { /* done */ }
    }
    // a person who only ever "wrote" in the test: after the removal everything is as it was
    const cT = await mkCand('T', reqEdu);
    const fuT = await call('POST', '/api/followups', T.edu, { applicationId: cT.appId, dueDate: '2099-02-02', nextAction: 'ZZTEST original action', contactMode: 'Call' });
    await call('POST', '/api/wa-chats/test/simulate-reply', T.admin, { personId: cT.id, text: 'TEST hello', numberId: nEdu });
    await call('POST', '/api/wa-chats/test/simulate-reply', T.admin, { personId: cT.id, stop: true, numberId: nEdu });
    const fuFlag = await prisma.applicationFollowUp.findUnique({ where: { id: fuT.body.id } });
    check('C4b a pretend reply flags the open follow-up, a pretend STOP blocks sending', /^Candidate replied/.test(fuFlag.nextAction) && (await chat(T.edu, cT)).body.optedOut === true);
    const rem = await call('POST', '/api/wa-chats/test/remove', T.admin, {});
    check('C6 "Remove test messages": the pretend messages, their files and events are gone', rem.status === 200 && rem.body.removed.candidateMessages >= 4 && !all("select id from CandidateMessage where providerRef like 'testsim.%'").length && !all("select id from WaChatMedia where providerRef like 'testsim.%'").length && !all("select id from OmniProviderEvent where providerEventId like 'testsim.%'").length, rem.body);
    const realAfter = {
      msgs: one("select count(*) n from CandidateMessage where providerRef not like 'testsim.%'").n,
      fu: all('select id, nextAction, dueDate from ApplicationFollowUp order by id'),
    };
    check('C6b the real messages were not touched by the removal', realAfter.msgs === realBefore.msgs, [realAfter.msgs, realBefore.msgs]);
    check('C6c the REAL STOP of S (sent before the pretend one) is still honoured after the removal', (await chat(T.edu, cS)).body.optedOut === true);
    const diskAfter = fs.readdirSync(path.join(TMP, 'uploads', 'wa-media'));
    check('C6d only the real pictures / files stay on disk (3 + 1 on the Medical number)', diskAfter.length === 4, diskAfter.length);
    const rem2 = await call('POST', '/api/wa-chats/test/remove', T.admin, {});
    const fuBack = await prisma.applicationFollowUp.findUnique({ where: { id: fuT.body.id } });
    const cTchat = await chat(T.edu, cT);
    check('C6d2 a person who only "wrote" in the test: the follow-up text is back, no STOP, no open window, no conversation row, no unread', fuBack.nextAction === 'ZZTEST original action' && cTchat.body.optedOut === false && cTchat.body.window.open === false && !one('select id from Conversation where personId = ?', cT.id) && cTchat.body.messages.length === 0, [fuBack.nextAction, cTchat.body.optedOut, cTchat.body.window]);
    check('C6e removing again is harmless (nothing left)', rem2.status === 200 && rem2.body.removed.candidateMessages === 0);

    // ===================================================================================================================
    // D: SWEEPS
    // ===================================================================================================================
    const logText = serverLog();
    const secrets = { T0, T1, T2, SECRET0, SECRET_MED, VERIFY0 };
    const leaks = Object.entries(secrets).filter(([, v]) => logText.includes(v) || bodies.join('\n').includes(v)).map(([k]) => k);
    check('D1 no token / app secret / verify token in any API answer or in the server log', leaks.length === 0, leaks);
    const phones = [cA, cZ, cS, cB, cM, cO, cN].map((c) => c.phone);
    const phoneInLog = phones.filter((p) => logText.includes(p));
    check('D2 no candidate phone number in the server log', phoneInLog.length === 0, phoneInLog);
    const bdeAnswers = [];
    for (const p of ['', `?state=unread`]) bdeAnswers.push((await call('GET', `/api/wa-chats${p}`, T.bde)).text);
    bdeAnswers.push((await chat(T.bde, cB)).text, (await call('GET', `/api/wa-chats/person/candidates/${cB.id}/messages?since=0`, T.bde)).text, (await call('GET', `/api/wa-chats/person/candidates/${cB.id}/followup`, T.bde)).text);
    check('D3 no answer to the BDE ever contains the candidate\'s phone number', bdeAnswers.every((t) => !t.includes(cB.phone) && !t.includes(cB.e164)), bdeAnswers.map((t) => t.length));
    const idx = all("select name from sqlite_master where type='index' and name in ('CandidateMessage_channel_created','WaChatMedia_ref','WaChatFlag_person')").map((r) => r.name);
    check('D4 the additive indexes exist', idx.length === 3, idx);
    const tbl = all("select name from sqlite_master where type='table' and name like 'WaChat%'").map((r) => r.name).sort();
    check('D5 the five additive tables exist and nothing else was created', tbl.join(',') === 'WaChatBell,WaChatFlag,WaChatMedia,WaChatMeta,WaChatRead', tbl);
    const reqTexts = ['/api/wa-chats/config', '/api/wa-chats', '/api/wa-chats/unread-count'];
    const noAuth = await Promise.all(reqTexts.map((p) => call('GET', p, null)));
    check('D6 every route needs a login (401 without)', noAuth.every((r) => r.status === 401), noAuth.map((r) => r.status));
  } catch (e) {
    check('FATAL test error', false, `${e && e.stack}`.slice(0, 1200));
  }
  await finish(0);

  async function finish(code) {
    servers.forEach((s) => { try { s.proc.kill(); } catch { /* done */ } });
    try { fake.srv.close(); } catch { /* done */ }
    try { raw.close(); } catch { /* done */ }
    try { await prisma.$disconnect(); } catch { /* done */ }
    await sleep(600);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
    console.log(`\n${pass} passed, ${fail} failed${failed.length ? `\nFailed: ${failed.join(' | ')}` : ''}`);
    process.exit(fail || code ? 1 : 0);
  }
})().catch((e) => { console.error('crash', e); process.exit(1); });
