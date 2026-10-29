// ---------------------------------------------------------------------------
// "CALL WITH AI (PHONE)" - a real phone call through our own SIP line, with the free voices (2026-10-28).
//
//   recruiter presses the button -> place() checks the same rules as every AI call (consent, opt-out, DND, calling hours,
//   daily limits) -> one AiCall row (initiatedVia 'sip', callSid = a new UUID) -> Asterisk is asked (AMI Originate) to dial
//   the candidate through the SIP trunk and, when they answer, to connect the call to the AI gateway (AudioSocket with that
//   UUID) -> gateway.js talks, saves the answers and the outcome like any AI call.
//
// Only the SIP minutes cost money; the voices, listening and the assistant are free and run on our server.
//
// Server settings (.env), all needed - the button stays hidden until they are there:
//   AI_VOICE_GATEWAY=1                      start the gateway with the backend
//   AI_VOICE_AMI_USER / AI_VOICE_AMI_SECRET Asterisk manager login (manager.conf); AI_VOICE_AMI_HOST/PORT default 127.0.0.1:5038
//   AI_VOICE_SIP_TRUNK                      the PJSIP endpoint of the provider (pjsip.conf), e.g. "provider"
//   AI_VOICE_PHONE_MODE                     Off | Test | Live (default Test: only AI_VOICE_TEST_NUMBERS are dialled)
//   AI_VOICE_TEST_NUMBERS                   comma list of mobiles that may be called in Test
//   AI_VOICE_DIAL_FORMAT                    how the provider wants the number: 10 (9876543210, default) | 0 (09876543210)
//                                           | 91 (919876543210) | e164 (+919876543210)
//   AI_VOICE_CALLER_ID                      the number the candidate sees (if the provider allows setting it)
//   AI_VOICE_GATEWAY_PORT                   default 9092
//
// AI_VOICE_DIAL_VIA=direct : no Asterisk - TeamLink asks the office SIM gateway itself (calling/voice/sipDirect.js). For a
//   TeamLink on the SAME network as the gateway (an office PC / localhost). Needs AI_VOICE_SYNWAY_HOST (e.g. 192.168.0.201)
//   and AI_VOICE_LOCAL_IP (this PC's address on that network, e.g. 192.168.0.103); the AMI / trunk settings are then unused.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { logAudit } = require('../../utils/audit');
const core = require('../../utils/messagingCore');
const DB = require('../schema');
const settingsStore = require('../settings');
const svc = require('../callService');
const P = require('../policy');
const S = require('../scripts');
const { Ami } = require('./ami');
const gateway = require('./gateway');

const RING_SEC = 35; // let it ring this long
const STUCK_MS = 90000; // dialled but never answered or reported: closed as not answered
const log = (...a) => console.log('[ai-phone]', ...a); // eslint-disable-line no-console

function config(env = process.env) {
  const mode = /^live/i.test(env.AI_VOICE_PHONE_MODE || '') ? 'Live' : /^off/i.test(env.AI_VOICE_PHONE_MODE || '') ? 'Off' : 'Test';
  const testNumbers = String(env.AI_VOICE_TEST_NUMBERS || '').split(',').map((x) => core.normalizeMobile(x.trim())).filter((m) => m.ok).map((m) => m.e164);
  const c = {
    on: env.AI_VOICE_GATEWAY === '1',
    ami: { host: env.AI_VOICE_AMI_HOST || '127.0.0.1', port: Number(env.AI_VOICE_AMI_PORT) || 5038, user: env.AI_VOICE_AMI_USER || '', secret: env.AI_VOICE_AMI_SECRET || '' },
    trunk: String(env.AI_VOICE_SIP_TRUNK || '').replace(/[^\w.-]/g, ''),
    via: /^direct$/i.test(env.AI_VOICE_DIAL_VIA || '') ? 'direct' : 'asterisk',
    synway: { host: String(env.AI_VOICE_SYNWAY_HOST || '').replace(/[^\w.-]/g, ''), port: Number(env.AI_VOICE_SYNWAY_PORT) || 5060 },
    localIp: String(env.AI_VOICE_LOCAL_IP || '').replace(/[^\d.]/g, ''),
    format: ['10', '0', '91', 'e164'].includes(env.AI_VOICE_DIAL_FORMAT) ? env.AI_VOICE_DIAL_FORMAT : '10',
    callerId: String(env.AI_VOICE_CALLER_ID || '').replace(/[^\d+]/g, ''),
    port: Number(env.AI_VOICE_GATEWAY_PORT) || 9092,
    mode,
    testNumbers,
  };
  const problems = [];
  if (!c.on) problems.push('The AI phone line is not switched on on this server (AI_VOICE_GATEWAY=1).');
  if (c.via === 'direct') {
    if (!c.synway.host) problems.push('The SIM gateway address is missing (AI_VOICE_SYNWAY_HOST).');
    if (!c.localIp) problems.push("This computer's address on the gateway's network is missing (AI_VOICE_LOCAL_IP).");
  } else {
    if (!c.ami.user || !c.ami.secret) problems.push('The Asterisk manager login is missing (AI_VOICE_AMI_USER / AI_VOICE_AMI_SECRET).');
    if (!c.trunk) problems.push('The SIP line is missing (AI_VOICE_SIP_TRUNK).');
  }
  if (c.mode === 'Off') problems.push('AI phone calls are switched off (AI_VOICE_PHONE_MODE=Off).');
  return { ...c, problems, ready: problems.length === 0 };
}

// +919876543210 -> what the provider expects
function dialNumber(e164, format) {
  const ten = String(e164).replace(/\D/g, '').slice(-10);
  return { 10: ten, 0: `0${ten}`, 91: `91${ten}`, e164: `+91${ten}` }[format] || ten;
}

// --- the Asterisk manager connection (one, re-made when it drops) ----------------------------------------------------------------
let AMI = null; let AMI_ERR = null; const WAIT = new Map(); // ActionID -> callId
async function ami(c) {
  if (AMI && AMI.ready) return AMI;
  const a = new Ami(c.ami);
  try { await a.connect(); } catch (e) { AMI_ERR = e.message; throw new Error(`Asterisk is not reachable: ${e.message}`); }
  AMI_ERR = null;
  a.on('event', (e) => { if (e.Event === 'OriginateResponse') originateResult(e).catch((err) => log('result failed:', err.message)); });
  a.on('close', () => { if (AMI === a) AMI = null; });
  AMI = a;
  return a;
}

// Asterisk's answer to "dial": answered (the gateway takes over), or why it did not connect.
async function originateResult(e) {
  const id = WAIT.get(e.ActionID);
  if (!id) return;
  WAIT.delete(e.ActionID);
  if (e.Response === 'Success') return; // answered: gateway.js has the call
  const reason = Number(e.Reason);
  const status = reason === 5 ? 'busy' : reason === 3 || reason === 1 ? 'no-answer' : 'failed';
  const words = { busy: 'The line was busy.', 'no-answer': 'The candidate did not answer.', failed: 'The call could not be connected.' }[status];
  const row = await svc.getCall(id);
  if (!row || row.status !== 'calling') return;
  await svc.setRow(id, { status, failReason: words, providerStatus: `originate:${reason}`, endedAt: new Date().toISOString() });
}

function readiness() {
  const c = config();
  return { ready: c.ready, mode: c.mode, problems: c.problems, reachable: AMI_ERR ? AMI_ERR : null };
}

// --- recruiter: place one call -------------------------------------------------------------------------------------------------
async function place(user, input, deps = {}) {
  const c = deps.config || config();
  if (!c.ready) return svc.fail(409, 'not_ready', `AI phone calls are not ready: ${c.problems[0]}`, { steps: c.problems });
  const base = await settingsStore.load({ fresh: true });
  // the AI calling rules, with the phone line's own switch (Off / Test numbers / Live) instead of the Exotel one
  const s = { ...base, mode: c.mode, testNumbers: c.testNumbers };
  const ctx = await svc.loadContext(input.applicationId);
  if (!ctx) return svc.fail(404, 'scope', 'Application not found.');
  const acc = await svc.accessVerdict(user, ctx, s);
  if (!acc.ok) return acc;
  const purpose = input.purpose;
  if (!S.PURPOSES.includes(purpose)) return svc.fail(400, 'purpose', 'Pick what the call is for.');
  const t = svc.now();
  const verdict = await P.personVerdict({ candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, purpose, s, now: t, jobSetting: await svc.jobSetting(ctx.requirement.id) });
  if (!verdict.ok) {
    await logAudit({ userId: user.id, action: 'AI phone call refused', entity: 'Application', entityId: ctx.app.id, toValue: `${purpose}: ${verdict.code}`.slice(0, 200) });
    return svc.fail(403, verdict.code, verdict.reason);
  }
  const win = P.windowVerdict(t, s);
  if (!win.ok) return svc.fail(403, 'outside_hours', `Calls are placed only between ${s.hoursFrom} and ${s.hoursTo} India time. Try again inside those hours.`);
  const lim = await P.limitVerdict(t, s, user.id);
  if (!lim.ok) return svc.fail(429, lim.code, lim.reason);
  const busy = await DB.one(`SELECT "id" FROM "AiCall" WHERE "initiatedVia" = ? AND "applicationId" = ? AND "status" = 'calling'`, gateway.VIA, ctx.app.id);
  if (busy) return svc.fail(409, 'duplicate', 'An AI phone call to this candidate is going on right now.', { callId: busy.id });
  const fields = S.cleanFields(input.fields);
  const fe = S.checkFields(fields);
  if (fe) return svc.fail(400, 'script', fe);
  // The call starts in the language this person spoke last time, else AI_VOICE_START_LANGUAGE (Telugu); from the first
  // sentence on, the assistant follows whatever language they speak (gateway.js + Whisper) - no choosing needed (user, 2026-10-28).
  const start = S.LANGS.includes(process.env.AI_VOICE_START_LANGUAGE) ? process.env.AI_VOICE_START_LANGUAGE : 'Telugu';
  // Every call opens in Telugu (2026-10-29: a call that opened in English from an earlier test confused the person); from the
  // first answer on it follows the language they speak.
  const lang = S.LANGS.includes(input.language) ? input.language : start;

  const id = svc.newId('aic');
  const uuid = crypto.randomUUID();
  const stamp = t.toISOString();
  await DB.run(
    `INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","campaignId","dedupeKey","scheduleVersion","slot","language","scriptJson",
      "initiatedById","initiatedByName","initiatedVia","toMask","confirmedAt","confirmedById","attempts","maxAttempts","nextAttemptAt","stageAtCall","callSid","providerStatus","lastAttemptAt","createdAt","updatedAt")
     VALUES (?,?,?,'calling',?,?,?,NULL,?,NULL,NULL,?,?,?,?,?,?,?,?,1,1,NULL,?,?,'dialing',?,?,?)`,
    id, c.mode.toLowerCase(), purpose, ctx.app.id, ctx.candidate.id, ctx.requirement.id, `sip:${id}`, lang, JSON.stringify({ fields }),
    user.id, user.name || null, gateway.VIA, verdict.mask || null, stamp, user.id, ctx.app.stage, uuid, stamp, stamp, stamp,
  );
  // counts towards the daily limits like every AI call
  await DB.run('INSERT OR IGNORE INTO "AiCallEvent" ("id","callId","eventKey","kind","status","applied","receivedAt") VALUES (?,?,?,?,?,1,?)', svc.newId('aie'), id, `attempt:${id}:1`, 'attempt', 'attempt', stamp);

  // the first sentences are made before dialling, so the candidate hears the assistant the moment they answer
  if (deps.prepare !== false) {
    try {
      const d = await require('../webTalk').dialogueFor(await svc.getCall(id)); // eslint-disable-line global-require
      await Promise.race([gateway.prepare(gateway.engines(), [d.start().say], lang), new Promise((r) => { setTimeout(r, 8000); })]);
      gateway.prepareCall(gateway.engines(), d); // the rest while the phone rings (not awaited)
    } catch (e) { log('prepare failed:', e.message); }
  }

  if (c.via === 'direct') {
    // no Asterisk: TeamLink rings the gateway itself; the answer (or why not) comes later, the recruiter does not wait
    const dial = deps.direct || require('./sipDirect').originate; // eslint-disable-line global-require
    dial({ host: c.synway.host, port: c.synway.port, number: dialNumber(verdict.e164, c.format), uuid, gatewayPort: c.port, localIp: c.localIp, ringSec: RING_SEC })
      .then(async (r) => {
        if (r.ok) return;
        const row = await svc.getCall(id);
        if (row && row.status === 'calling') await svc.setRow(id, { status: r.status, failReason: String(r.reason).slice(0, 250), providerStatus: `sip:${r.code || r.status}`, endedAt: new Date().toISOString() });
      })
      .catch((e) => log('direct dial failed:', e.message));
  }
  const actionId = `tl-${id}`;
  if (c.via !== 'direct') try { // eslint-disable-line curly
    const a = deps.ami || await ami(c);
    WAIT.set(actionId, id);
    const r = await a.action({
      Action: 'Originate',
      ActionID: actionId,
      Channel: `PJSIP/${dialNumber(verdict.e164, c.format)}@${c.trunk}`,
      Application: 'AudioSocket',
      Data: `${uuid},127.0.0.1:${c.port}`,
      Timeout: RING_SEC * 1000,
      CallerID: c.callerId || undefined,
      Async: 'true',
    });
    if (r.Response !== 'Success') throw new Error(r.Message || 'Asterisk refused the call');
  } catch (e) {
    WAIT.delete(actionId);
    await svc.setRow(id, { status: 'failed', failReason: `Not dialled: ${e.message}`.slice(0, 250), endedAt: new Date().toISOString() });
    return svc.fail(502, 'dial_failed', `The call could not be placed: ${e.message}`, { callId: id });
  }
  setTimeout(() => sweep().catch(() => {}), STUCK_MS + 2000).unref();
  if (input.language && S.LANGS.includes(input.language)) {
    await DB.run('INSERT OR REPLACE INTO "AiCallPref" ("candidateId","language","source","updatedAt") VALUES (?,?,?,?)', ctx.candidate.id, input.language, 'recruiter', stamp);
  }
  await logAudit({ userId: user.id, action: 'AI phone call started', entity: 'Application', entityId: ctx.app.id, toValue: `${purpose} (${lang}, ${c.mode}) via own SIP line, free voice`.slice(0, 200) });
  return { ok: true, callId: id, status: 'calling', language: lang };
}

// Calls that were dialled but never answered or reported (Asterisk restarted, a lost event), and calls a restart cut off.
async function sweep(now = Date.now()) {
  const rows = await DB.all(`SELECT * FROM "AiCall" WHERE "initiatedVia" = ? AND "status" = 'calling'`, gateway.VIA);
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const at = new Date(r.updatedAt || r.createdAt).getTime();
    const dialing = r.providerStatus === 'dialing';
    if (dialing && now - at > STUCK_MS) {
      await svc.setRow(r.id, { status: 'no-answer', failReason: 'The candidate did not answer.', endedAt: new Date(now).toISOString() }); // eslint-disable-line no-await-in-loop
    } else if (!dialing && now - at > 30 * 60000) {
      await svc.setRow(r.id, { status: 'failed', failReason: 'The call was cut off (the server restarted).', endedAt: new Date(now).toISOString() }); // eslint-disable-line no-await-in-loop
    }
  }
}

// index.js: started with the backend when AI_VOICE_GATEWAY=1.
async function start() {
  const c = config();
  if (!c.on) return null;
  // calling/local (the other self-hosted bridge) may listen for Asterisk too: never both on one port
  if (Number(process.env.AI_CALL_AUDIOSOCKET_PORT) === c.port) { log(`not started: port ${c.port} is AI_CALL_AUDIOSOCKET_PORT (calling/local). Use one of the two.`); return null; }
  const server = await gateway.start({ port: c.port });
  setTimeout(() => gateway.prepareFixed(gateway.engines(), S), 20000).unref(); // the fixed replies, once, after start-up
  await sweep(Date.now() + STUCK_MS * 100).catch(() => {}); // after a restart nothing is still dialling
  if (c.ready && c.via === 'direct') log(`dialling straight to the SIM gateway ${c.synway.host} from ${c.localIp}`);
  else if (c.ready) ami(c).then(() => log('Asterisk manager connected')).catch((e) => log(e.message));
  else log('not ready:', c.problems.join(' '));
  return server;
}

module.exports = { config, readiness, place, sweep, start, dialNumber, _originateResult: originateResult, _wait: WAIT };
