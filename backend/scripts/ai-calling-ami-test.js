#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SELF-HOSTED (SYNWAY) CALLING - ASTERISK AMI TESTS (2026-10-28). NO REAL CALL, NO REAL ASTERISK.
//   cd backend && node scripts/ai-calling-ami-test.js            makes its own VACUUM INTO copy of prisma/dev.db (read-only) and deletes it
//
// WHAT THIS IS - AND IS NOT: "Asterisk" here is a SIMULATOR in this script that speaks the AMI protocol over a real TCP socket
// on 127.0.0.1 (banner, Login, Ping, CoreSettings, ModuleCheck, PJSIPShowEndpoint, ShowDialPlan, Originate + OriginateResponse).
// It proves TeamLink's side: what is sent, how every answer is read, the statuses, retries, logs and the secret handling.
// It does NOT prove a real call: that needs the real Asterisk + Synway gateway + a SIM, and the first call goes only to the
// founder's own number with his OK (Admin > AI Calling, Test mode). scripts/ai-calling-ami-check.js checks a REAL Asterisk (no call).
//
//   A  connection test (read only, NEVER an Originate): all good -> Connected; wrong secret; trunk at another IP; AudioSocket
//      module missing; no dialplan; a public address refused before any connection; the secret never in a text
//   B  number formats (10 digits / 0 + 10 / +91)
//   C  a real dispatch() on the DB copy (consent, hours, Test-mode number checks all run): the call id is saved BEFORE dialling and
//      sent as AICALL_UUID, Channel PJSIP/<number>@synway, Context teamlink-ai -> busy = retry planned; no answer; answered + the AI
//      bridge joins = stays on the call; answered but no bridge = failed with the reason (watchdog); Asterisk down = retry
//      "the phone system had a problem"; wrong AMI secret = given up, secret not leaked; every step in the call's event log
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const BACK = path.resolve(__dirname, '..');
const REAL = path.join(BACK, 'prisma', 'dev.db');
const COPY = path.join(os.tmpdir(), `zz-ami-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${COPY.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`;
process.env.TEST_MODE = '1'; // sandbox: only a loopback Asterisk may be contacted
process.env.AI_CALL_AUDIOSOCKET_PORT = '9092';
process.env.AI_CALL_STT_URL = 'ws://127.0.0.1:8090';
process.env.AI_CALL_TTS_URL = 'ws://127.0.0.1:8092';
process.env.AI_CALL_BRIDGE_WAIT_MS = '1500';
if (!process.env.INTEGRATION_SECRET_KEY) process.env.INTEGRATION_SECRET_KEY = crypto.randomBytes(32).toString('hex');

const prisma = require(path.join(BACK, 'src/db'));
const AMI = require(path.join(BACK, 'src/calling/local/ami'));
const settingsStore = require(path.join(BACK, 'src/calling/settings'));
const X = require(path.join(BACK, 'src/calling/exotelConfig'));
const DB = require(path.join(BACK, 'src/calling/schema'));
const svc = require(path.join(BACK, 'src/calling/callService'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = `zz-ami-secret-${crypto.randomBytes(6).toString('hex')}`;

// ---- the AMI simulator ------------------------------------------------------------------------------------------------------
function simulator() {
  const st = {
    actions: [], secret: SECRET, user: 'teamlink', version: '20.5.2', modules: ['res_audiosocket', 'app_audiosocket'], trunk: 'synway', contact: 'sip:192.168.1.20:5060',
    dialplan: true, outcome: { response: 'Failure', reason: 5 }, refuseOriginate: false,
  };
  const srv = net.createServer((sock) => {
    let buf = '';
    let authed = false;
    const send = (o) => sock.write(`${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    sock.write('Asterisk Call Manager/9.0.0\r\n');
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 4);
        const m = {}; raw.split('\r\n').forEach((l) => { const k = l.indexOf(':'); if (k > 0) m[l.slice(0, k).trim()] = l.slice(k + 1).trim(); });
        st.actions.push(m);
        const id = m.ActionID;
        const a = String(m.Action || '').toLowerCase();
        if (a === 'login') { authed = m.Username === st.user && m.Secret === st.secret; send(authed ? { Response: 'Success', ActionID: id, Message: 'Authentication accepted' } : { Response: 'Error', ActionID: id, Message: 'Authentication failed' }); continue; }
        if (a === 'logoff') { send({ Response: 'Goodbye', ActionID: id || '' }); sock.end(); continue; }
        if (!authed) { send({ Response: 'Error', ActionID: id, Message: 'Permission denied' }); continue; }
        if (a === 'ping') send({ Response: 'Success', ActionID: id, Ping: 'Pong' });
        else if (a === 'coresettings') send({ Response: 'Success', ActionID: id, AsteriskVersion: st.version });
        else if (a === 'modulecheck') send(st.modules.includes(m.Module) ? { Response: 'Success', ActionID: id, Version: '' } : { Response: 'Error', ActionID: id, Message: 'Module not loaded' });
        else if (a === 'pjsipshowendpoint') {
          if (m.Endpoint !== st.trunk) { send({ Response: 'Error', ActionID: id, Message: `Unable to retrieve endpoint ${m.Endpoint}` }); continue; }
          send({ Response: 'Success', ActionID: id, EventList: 'start', Message: 'Following are Events for each object associated with the Endpoint' });
          send({ Event: 'EndpointDetail', ActionID: id, ObjectName: st.trunk, DeviceState: 'Not in use' });
          send({ Event: 'ContactStatusDetail', ActionID: id, URI: st.contact, Status: 'Reachable' });
          send({ Event: 'EndpointDetailComplete', ActionID: id, EventList: 'Complete', ListItems: '2' });
        } else if (a === 'showdialplan') {
          if (!st.dialplan) { send({ Response: 'Error', ActionID: id, Message: `Did not find context ${m.Context}` }); continue; }
          send({ Response: 'Success', ActionID: id, EventList: 'start', Message: 'DialPlan list will follow' });
          send({ Event: 'ListDialplan', ActionID: id, Context: m.Context, Extension: 's', Priority: '4', Application: 'AudioSocket', AppData: '${AICALL_UUID},127.0.0.1:9092' });
          send({ Event: 'ShowDialPlanComplete', ActionID: id, EventList: 'Complete', ListItems: '1' });
        } else if (a === 'originate') {
          if (st.refuseOriginate) { send({ Response: 'Error', ActionID: id, Message: 'Originate failed' }); continue; }
          send({ Response: 'Success', ActionID: id, Message: 'Originate successfully queued' });
          const o = st.outcome;
          setTimeout(() => send({ Event: 'OriginateResponse', ActionID: id, Response: o.response, Channel: `PJSIP/${m.Channel}-0001`, Context: m.Context, Exten: 's', Reason: String(o.reason), Uniqueid: '1700000000.1' }), 150);
        } else send({ Response: 'Error', ActionID: id, Message: 'Invalid/unknown command' });
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, port: srv.address().port })));
}

const madeCalls = [];
(async () => {
  const SIM = await simulator();
  const base = {
    provider: 'synway', amiHost: '127.0.0.1', amiHostPrivate: true, amiPort: SIM.port, amiUser: 'teamlink', amiSecret: SECRET, trunk: 'synway', gatewayIp: '192.168.1.20',
    dialFormat: 'ten', dialContext: 'teamlink-ai', ringSeconds: 20,
  };
  const originates = () => SIM.st.actions.filter((a) => /^originate$/i.test(a.Action || '')).length;
  try {
    // ================================================= A. the read-only connection test
    let r = await AMI.testConnection(base);
    check('A1 all set up: Connected, every check passes (AMI, login, ping, version, both AudioSocket modules, trunk at the gateway IP, dialplan)', r.ok && r.checks.length >= 8 && r.checks.every((c) => c.ok), r);
    check('A2 the connection test sends NO Originate (never phones anybody)', originates() === 0, SIM.st.actions.map((a) => a.Action));
    r = await AMI.testConnection({ ...base, amiSecret: 'wrong-secret-123' });
    check('A3 a wrong AMI secret: not connected, says so, the secret is not in any text', !r.ok && /user name \/ secret/.test(r.message) && !JSON.stringify(r).includes('wrong-secret-123'), r);
    SIM.st.contact = 'sip:192.168.1.99:5060';
    r = await AMI.testConnection(base);
    check('A4 the trunk points at another address than the gateway IP in the settings: not connected, names both', !r.ok && /192\.168\.1\.99/.test(r.message) && /192\.168\.1\.20/.test(r.message), r.message);
    SIM.st.contact = 'sip:192.168.1.20:5060'; SIM.st.modules = ['app_audiosocket'];
    r = await AMI.testConnection(base);
    check('A5 res_audiosocket not loaded: not connected, says how to load it', !r.ok && /res_audiosocket/.test(r.message), r.message);
    SIM.st.modules = ['res_audiosocket', 'app_audiosocket']; SIM.st.dialplan = false;
    r = await AMI.testConnection(base);
    check('A6 no [teamlink-ai] dialplan: not connected, says what to copy', !r.ok && /teamlink-ai/.test(r.message), r.message);
    SIM.st.dialplan = true;
    const before = SIM.st.actions.length;
    r = await AMI.testConnection({ ...base, amiHost: '8.8.8.8', amiHostPrivate: false });
    check('A7 a public address is refused before anything is sent', !r.ok && /not a private address/.test(r.message) && SIM.st.actions.length === before, r.message);
    r = await AMI.testConnection({ ...base, amiHost: '192.168.1.50', amiHostPrivate: true });
    check('A8 on a test copy a real (non-loopback) Asterisk is never contacted', !r.ok && /TEST MODE/.test(r.message), r.message);

    // ================================================= B. number formats
    check('B1 number formats: 10 digits / 0 + 10 digits / +91', AMI.dialString('919848012345', 'ten') === '9848012345' && AMI.dialString('919848012345', 'zero') === '09848012345' && AMI.dialString('919848012345', 'e164') === '+919848012345');

    // ================================================= C. a real dispatch() through the AMI simulator, on the DB copy
    await DB.ensure();
    // an application the call rules allow (not Rejected / Joined / Hired), on the COPY only
    const app = await prisma.application.findFirst({ where: { candidate: { phone: { not: null } }, stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] } }, include: { candidate: true, requirement: true } });
    if (!app) throw new Error('the database copy has no application with a phone number');
    const phone = '9848012345';
    await prisma.candidate.update({ where: { id: app.candidateId }, data: { phone, consentStatus: 'GIVEN', consentPurposes: 'recruitment', doNotContact: false } }).catch(async () => prisma.candidate.update({ where: { id: app.candidateId }, data: { phone } }));
    await prisma.requirement.update({ where: { id: app.requirementId }, data: { status: 'OPEN' } }).catch(() => {});
    const F = X.F;
    await settingsStore.save({
      [F.mode]: 'Test', [F.provider]: 'Self-hosted (Synway)', [F.amiHost]: '127.0.0.1', [F.amiPort]: String(SIM.port), [F.amiUser]: 'teamlink', [F.amiSecret]: SECRET, [F.trunk]: 'synway',
      [F.gatewayIp]: '192.168.1.20', [F.dialFormat]: '10 digits', [F.dialContext]: 'teamlink-ai', [F.ringSeconds]: '20', [F.testNumbers]: phone, [F.hoursFrom]: '00:00', [F.hoursTo]: '23:59',
      [F.attempts]: '3', [F.gaps]: '30,120', [F.dailyLimit]: '1000', [F.consentApplied]: 'Yes',
    }, { id: null, name: 'ZZTEST AMI' });
    const s = await settingsStore.load({ fresh: true });
    check('C0 the Synway settings are read back: provider synway, private host, ready (nothing missing), the secret kept encrypted', s.provider === 'synway' && s.amiHostPrivate && s.configured && s.amiSecret === SECRET && !JSON.stringify(await settingsStore.publicView()).includes(SECRET), s.problems);

    const mkCall = async () => {
      const id = `aic_zzami_${crypto.randomBytes(4).toString('hex')}`;
      await DB.run('INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","dedupeKey","language","initiatedVia","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        id, 'test', 'Screening', 'queued', app.id, app.candidateId, app.requirementId, `zz-ami-${id}`, 'English', 'test', new Date().toISOString(), new Date().toISOString());
      madeCalls.push(id);
      return id;
    };
    const rowOf = (id) => DB.one('SELECT * FROM "AiCall" WHERE "id" = ?', id);
    const eventsOf = (id) => DB.all('SELECT * FROM "AiCallEvent" WHERE "callId" = ? ORDER BY "receivedAt"', id);

    // C1 busy
    SIM.st.outcome = { response: 'Failure', reason: 5 };
    const c1 = await mkCall();
    const n0 = originates();
    let d = await svc.dispatch(c1, { force: true });
    const r1a = await rowOf(c1);
    const orig = SIM.st.actions.filter((a) => /^originate$/i.test(a.Action || '')).pop() || {};
    check('C1 dispatch: on the phone ("calling"), ONE Originate with Channel PJSIP/9848012345@synway, Context teamlink-ai, Exten s, Async', d.status === 'calling' && originates() === n0 + 1 && orig.Channel === 'PJSIP/9848012345@synway' && orig.Context === 'teamlink-ai' && orig.Exten === 's' && orig.Async === 'true', [d, orig]);
    check('C2 the call id is saved on the call and sent as AICALL_UUID (what the AudioSocket bridge looks up)', r1a.callSid && orig.Variable === `AICALL_UUID=${r1a.callSid}` && /^[0-9a-f-]{36}$/.test(r1a.callSid), [r1a.callSid, orig.Variable]);
    await sleep(600);
    const r1 = await rowOf(c1);
    check('C3 Asterisk says busy (Reason 5): status busy, a retry is planned, the reason is in plain words', r1.status === 'busy' && !!r1.nextAttemptAt && /busy/i.test(r1.failReason) && /attempt 2 of 3/.test(r1.waitReason || ''), [r1.status, r1.failReason, r1.waitReason]);
    const ev1 = await eventsOf(c1);
    check('C4 the call\'s event log has the attempt and Asterisk\'s answer (kind asterisk, reason 5)', ev1.some((e) => e.kind === 'attempt') && ev1.some((e) => e.kind === 'asterisk' && e.status === 'busy' && /"reason":5/.test(e.payload || '')), ev1.map((e) => [e.kind, e.status]));

    // C5 no answer
    SIM.st.outcome = { response: 'Failure', reason: 3 };
    const c2 = await mkCall();
    await svc.dispatch(c2, { force: true }); await sleep(600);
    const r2 = await rowOf(c2);
    check('C5 it rang and nobody answered (Reason 3): status no-answer, retry planned', r2.status === 'no-answer' && !!r2.nextAttemptAt, [r2.status, r2.failReason]);

    // C6 answered, the AI bridge joins
    SIM.st.outcome = { response: 'Success', reason: 4 };
    const c3 = await mkCall();
    await svc.dispatch(c3, { force: true }); await sleep(500);
    const r3row = await rowOf(c3);
    await DB.run('INSERT INTO "AiCallEvent" ("id","callId","eventKey","kind","status","note","applied","receivedAt") VALUES (?,?,?,?,?,?,0,?)', `aie_zz_${crypto.randomBytes(4).toString('hex')}`, c3, `bridge-start:${c3}:1`, 'audiosocket', 'in-progress', 'AudioSocket connected (simulated)', new Date().toISOString());
    await sleep(1800);
    const r3 = await rowOf(c3);
    check('C6 answered (Reason 4) and the AI bridge joined: still on the call (in progress), not failed by the watchdog', r3row.providerStatus === 'in-progress' && r3.status === 'calling', [r3row.providerStatus, r3.status, r3.failReason]);

    // C7 answered, but the bridge never starts
    const c4 = await mkCall();
    await svc.dispatch(c4, { force: true }); await sleep(2400);
    const r4 = await rowOf(c4);
    check('C7 answered but the AI never joined (no AudioSocket): the call is not left "calling" - failed, with the reason to check', r4.status === 'failed' && /AudioSocket/.test(r4.failReason || ''), [r4.status, r4.failReason]);

    // C8 Asterisk refuses the Originate
    SIM.st.refuseOriginate = true;
    const c5 = await mkCall();
    d = await svc.dispatch(c5, { force: true });
    const r5 = await rowOf(c5);
    check('C8 Asterisk refuses the call: failed with Asterisk\'s words, logged in the call\'s events', d.status === 'failed' && /refused the call/i.test(r5.failReason || '') && (await eventsOf(c5)).some((e) => e.kind === 'asterisk'), [d, r5.failReason]);
    SIM.st.refuseOriginate = false;

    // C9 Asterisk not reachable (a closed port) -> a problem of the phone system, tried again later
    const closed = await new Promise((res) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => res(p)); }); });
    await settingsStore.save({ [F.amiPort]: String(closed) }, { id: null, name: 'ZZTEST AMI' });
    settingsStore.dropCache();
    const c6 = await mkCall();
    d = await svc.dispatch(c6, { force: true });
    const r6 = await rowOf(c6);
    check('C9 Asterisk is down: failed for now, tried again later ("The phone system (Asterisk) had a problem")', r6.status === 'failed' && !!r6.nextAttemptAt && /phone system \(Asterisk\)/.test(r6.waitReason || ''), [d, r6.status, r6.waitReason, r6.failReason]);

    // C10 wrong secret -> not retried, secret nowhere
    await settingsStore.save({ [F.amiPort]: String(SIM.port), [F.amiSecret]: 'zz-not-the-secret-999' }, { id: null, name: 'ZZTEST AMI' });
    settingsStore.dropCache();
    const c7 = await mkCall();
    d = await svc.dispatch(c7, { force: true });
    const r7 = await rowOf(c7);
    const leak = JSON.stringify([await rowOf(c7), await eventsOf(c7), await prisma.auditLog.findMany({ where: { entityId: app.id }, orderBy: { createdAt: 'desc' }, take: 20 })]);
    check('C10 a wrong AMI secret: failed and NOT retried (a setup problem), says to check manager.conf', r7.status === 'failed' && !r7.nextAttemptAt && /manager\.conf/.test(r7.failReason || ''), [r7.status, r7.nextAttemptAt, r7.failReason]);
    check('C11 no AMI secret (right or wrong) in the call row, its events or the audit log', !leak.includes(SECRET) && !leak.includes('zz-not-the-secret-999'));
    check('C12 every call started is in the audit log with the provider ("Self-hosted (Synway)")', (await prisma.auditLog.count({ where: { entityId: app.id, action: 'AI call started', toValue: { contains: 'Self-hosted (Synway)' } } })) >= 4);
  } catch (err) { fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try { SIM.srv.close(); } catch { /* closed */ }
    try { await prisma.$disconnect(); } catch { /* gone */ }
    await sleep(300);
    for (const sfx of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(COPY + sfx); } catch { /* still open or gone */ } }
    console.log(`\n${pass} passed, ${fail} failed  (an AMI SIMULATOR, not a real Asterisk: no real call was placed or verified)`);
    process.exit(fail ? 1 : 0);
  }
})();
