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

// ONE SWITCH (founder 2026-11-03: "test mode ani endhuku vasthundhi. proper ga set cheyyi"): the Test / Live switch in
// Administration > Integrations > AI Calling decides for the phone line too. The server's AI_VOICE_PHONE_MODE stays a kill
// switch (Off), and is only used when that screen is Off.
function lineMode(c, base) {
  if (c.mode === 'Off') return 'Off';
  return base && (base.mode === 'Live' || base.mode === 'Test') ? base.mode : c.mode;
}

function readiness() {
  const c = config();
  return { ready: c.ready, mode: c.mode, problems: c.problems, reachable: AMI_ERR ? AMI_ERR : null };
}

// --- recruiter: place one call -------------------------------------------------------------------------------------------------
async function place(user, input, deps = {}) {
  const c = { ...(deps.config || config()) };
  if (!c.ready) return svc.fail(409, 'not_ready', `AI phone calls are not ready: ${c.problems[0]}`, { steps: c.problems });
  const base = await settingsStore.load({ fresh: true });
  // the AI calling rules, with the phone line's own switch (Off / Test numbers / Live) instead of the Exotel one
  // test numbers: the server's list AND the ones the Admin saves in Integrations > AI Calling (founder 2026-11-03: "ey number ki
  // call chesina call velley laaga ... prathi sari, problem lekunda" - a number saved on that screen is always callable in Test)
  c.mode = lineMode(c, base);
  const s = { ...base, mode: c.mode, testNumbers: [...new Set([...c.testNumbers, ...(base.testNumbers || [])])] };
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
  const start = S.LANGS.includes(process.env.AI_VOICE_START_LANGUAGE) ? process.env.AI_VOICE_START_LANGUAGE : 'English'; // founder 2026-10-29: 'starting english lo matladali'
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

  // KAVYA (2026-11-12): the ATS phone button. Every rule has passed and the row is made; when Kavya is the engine for this purpose she takes the candidate.
  try {
    if (await require('../kavya/engine').handOver(await svc.getCall(id), ctx, verdict, { counted: true })) return { ok: true, callId: id, status: 'calling', language: lang }; // eslint-disable-line global-require
  } catch { /* the old line places the call */ }
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

// AI VOICE CAMPAIGNS (2026-11-04): the same phone line, for a call that is already a queued AiCall row (made when the campaign was created, with its
// consent / access checks done then for the person who made it). Everything place() does at dial time is done here too - consent, DND, test numbers, calling
// hours, daily limits, one call to a person at a time, the opening sentences made first, Asterisk or the SIM gateway - but the row is UPDATED (queued -> calling)
// instead of made. A call that is not allowed right now stays queued (hours, limits) or is cancelled for good (consent, DND, test numbers). place() is unchanged.
async function dialQueued(id, deps = {}) {
  const c = deps.config || config();
  if (!c.ready) return { status: 'queued', note: `AI phone calls are not ready: ${c.problems[0]}` };
  const row = await svc.getCall(id);
  if (!row || row.status !== 'queued') return { status: row ? row.status : 'missing' };
  const base = await settingsStore.load({ fresh: true });
  const cc = { ...c, mode: typeof lineMode === 'function' ? lineMode(c, base) : c.mode };
  const s = { ...base, mode: cc.mode, testNumbers: [...new Set([...c.testNumbers, ...(base.testNumbers || [])])] };
  const ctx = await svc.loadContext(row.applicationId);
  if (!ctx) { await svc.cancelWith(row, 'The application is no longer there.', null); return { status: 'cancelled' }; }
  const t = svc.now();
  const verdict = await P.personVerdict({ candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, purpose: row.purpose, s, now: t, jobSetting: await svc.jobSetting(ctx.requirement.id) });
  if (!verdict.ok) { await svc.cancelWith(row, verdict.reason || 'This candidate cannot be called.', null); return { status: 'cancelled', note: verdict.reason }; }
  const win = P.windowVerdict(t, s);
  if (!win.ok) {
    await svc.setRow(id, { nextAttemptAt: (win.until ? new Date(win.until) : new Date(t.getTime() + 30 * 60000)).toISOString(), waitReason: `Waiting for calling hours (${s.hoursFrom} to ${s.hoursTo} India time).` });
    return { status: 'queued', note: 'outside calling hours' };
  }
  const lim = await P.limitVerdict(t, s, row.initiatedById);
  if (!lim.ok) { await svc.setRow(id, { nextAttemptAt: new Date(t.getTime() + 60 * 60000).toISOString(), waitReason: lim.reason }); return { status: 'queued', note: lim.reason }; }
  const busy = await DB.one(`SELECT "id" FROM "AiCall" WHERE "initiatedVia" IN (?, 'campaign') AND "applicationId" = ? AND "status" = 'calling' AND "id" <> ?`, gateway.VIA, row.applicationId, id);
  if (busy) { await svc.setRow(id, { nextAttemptAt: new Date(t.getTime() + 5 * 60000).toISOString(), waitReason: 'A call to this candidate is going on right now.' }); return { status: 'queued', note: 'already on a call' }; }
  // KAVYA (2026-11-12): every rule has passed. When Kavya is the engine for this purpose she takes the candidate; otherwise (or on any problem) the old line rings.
  try { if (await require('../kavya/engine').handOver(row, ctx, verdict)) return { status: 'calling', note: 'with Kavya' }; } catch { /* the old line places the call */ } // eslint-disable-line global-require
  const lang = S.LANGS.includes(row.language) ? row.language : (S.LANGS.includes(process.env.AI_VOICE_START_LANGUAGE) ? process.env.AI_VOICE_START_LANGUAGE : 'English');
  const uuid = crypto.randomUUID();
  const stamp = t.toISOString();
  const attempt = (Number(row.attempts) || 0) + 1;
  await svc.setRow(id, { status: 'calling', initiatedVia: gateway.VIA, callSid: uuid, providerStatus: 'dialing', attempts: attempt, language: lang, lastAttemptAt: stamp, startedAt: stamp, nextAttemptAt: null, waitReason: null, failReason: null, endedAt: null });
  await DB.run('INSERT OR IGNORE INTO "AiCallEvent" ("id","callId","eventKey","kind","status","applied","receivedAt") VALUES (?,?,?,?,?,1,?)', svc.newId('aie'), id, `attempt:${id}:${attempt}`, 'attempt', 'attempt', stamp);
  if (deps.prepare !== false) {
    try {
      const d = await require('../webTalk').dialogueFor(await svc.getCall(id)); // eslint-disable-line global-require
      await Promise.race([gateway.prepare(gateway.engines(), [d.start().say], lang), new Promise((r) => { setTimeout(r, 8000); })]);
      gateway.prepareCall(gateway.engines(), d);
    } catch (e) { log('prepare failed:', e.message); }
  }
  const number = dialNumber(verdict.e164, c.format);
  if (c.via === 'direct') {
    const dial = deps.direct || require('./sipDirect').originate; // eslint-disable-line global-require
    dial({ host: c.synway.host, port: c.synway.port, number, uuid, gatewayPort: c.port, localIp: c.localIp, ringSec: RING_SEC })
      .then(async (r) => {
        if (r.ok) return;
        const cur = await svc.getCall(id);
        if (cur && cur.status === 'calling') await svc.setRow(id, { status: r.status, failReason: String(r.reason).slice(0, 250), providerStatus: `sip:${r.code || r.status}`, endedAt: new Date().toISOString() });
      })
      .catch((e) => log('direct dial failed:', e.message));
  } else {
    const actionId = `tl-${id}-${attempt}`;
    try {
      const a = deps.ami || await ami(c);
      WAIT.set(actionId, id);
      const r = await a.action({
        Action: 'Originate', ActionID: actionId, Channel: `PJSIP/${number}@${c.trunk}`, Application: 'AudioSocket', Data: `${uuid},127.0.0.1:${c.port}`,
        Timeout: RING_SEC * 1000, CallerID: c.callerId || undefined, Async: 'true',
      });
      if (r.Response !== 'Success') throw new Error(r.Message || 'Asterisk refused the call');
    } catch (e) {
      WAIT.delete(actionId);
      await svc.setRow(id, { status: 'failed', failReason: `Not dialled: ${e.message}`.slice(0, 250), providerStatus: 'sip:not-dialled', endedAt: new Date().toISOString() });
      return { status: 'failed', note: e.message };
    }
  }
  setTimeout(() => sweep().catch(() => {}), STUCK_MS + 2000).unref();
  await logAudit({ userId: row.initiatedById, action: 'AI phone call started (campaign)', entity: 'Application', entityId: ctx.app.id, toValue: `${row.purpose} (${lang}, ${c.mode}) via own SIP line, free voice`.slice(0, 200) });
  return { status: 'calling', language: lang };
}

// --- an Omni-Channel (Green Start) contact: a call to ANY phone number by the team's own script (calling/omniCalls.js) -----------------------
// Not an ATS candidate: no application, no job, no timeline. The same line, the same gateway and the same safety rules that do not need a
// candidate (calling hours, the Off / Test numbers / Live switch, the test-number list, "do not call me" and Do Not Disturb, the daily limit).
// The row is made already "calling": the caller (Green Start's campaign) only asks when it is time to dial, and does its own retries.
async function dialOmni(input, deps = {}) {
  const c = { ...(deps.config || config()) };
  if (!c.ready) return { ok: false, code: 'not_ready', reason: `AI phone calls are not ready: ${c.problems[0]}` };
  const base = await settingsStore.load({ fresh: true });
  c.mode = lineMode(c, base); // the Test / Live switch of Integrations > AI Calling decides, like for every phone call
  const s = { ...base, mode: c.mode, testNumbers: [...new Set([...(c.testNumbers || []), ...(base.testNumbers || [])])] };
  const m = core.normalizeMobile(input.toNumber);
  if (!m.ok) return { ok: false, code: 'no_phone', reason: `This number cannot be called (${m.reason}).` };
  if (s.mode === 'Off') return { ok: false, code: 'off', reason: 'AI phone calls are switched off.' };
  if (s.mode === 'Test' && !s.testNumbers.includes(m.e164)) return { ok: false, code: 'test_number', reason: 'Test mode is on, so only the saved test numbers can be called. An Admin switches AI Calling to Live.' };
  const sup = await P.suppression(m.e164);
  if (sup.some((x) => x.kind === 'optout' || x.kind === 'dnd') || await P.callOptOut(m.e164)) return { ok: false, code: 'opted_out', reason: 'This number asked not to be called, or is on the Do Not Disturb list.' };
  const t = svc.now();
  const win = P.windowVerdict(t, s);
  if (!win.ok) return { ok: false, code: 'outside_hours', reason: `Calls are placed only between ${s.hoursFrom} and ${s.hoursTo} India time.` };
  const lim = await P.limitVerdict(t, s, null);
  if (!lim.ok) return { ok: false, code: 'limit', reason: lim.reason };
  const busy = await DB.one(`SELECT "id" FROM "AiCall" WHERE "initiatedVia" = ? AND "toMask" = ? AND "status" = 'calling'`, gateway.VIA, core.maskMobile(m.e164));
  if (busy) return { ok: false, code: 'busy_line', reason: 'A call to this number is going on right now.' };
  const lang = S.LANGS.includes(input.language) ? input.language : (S.LANGS.includes(process.env.AI_VOICE_START_LANGUAGE) ? process.env.AI_VOICE_START_LANGUAGE : 'English');
  const id = svc.newId('aic');
  const uuid = crypto.randomUUID();
  const stamp = t.toISOString();
  await DB.run(
    `INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","campaignId","dedupeKey","language","scriptJson","initiatedByName","initiatedVia","toMask",
      "attempts","maxAttempts","callSid","providerStatus","lastAttemptAt","startedAt","createdAt","updatedAt")
     VALUES (?,?,?,'calling',NULL,?,NULL,NULL,?,?,?,?,?,?,1,1,?,'dialing',?,?,?,?)`,
    id, c.mode.toLowerCase(), 'Screening', `omni:${input.externalId}`, `omni:${input.externalId}`, lang, JSON.stringify(input.scriptJson), 'Omni-Channel', gateway.VIA, core.maskMobile(m.e164), uuid, stamp, stamp, stamp, stamp,
  );
  await DB.run('INSERT OR IGNORE INTO "AiCallEvent" ("id","callId","eventKey","kind","status","applied","receivedAt") VALUES (?,?,?,?,?,1,?)', svc.newId('aie'), id, `attempt:${id}:1`, 'attempt', 'attempt', stamp);
  if (deps.prepare !== false) {
    try {
      const d = await require('../webTalk').dialogueFor(await svc.getCall(id)); // eslint-disable-line global-require
      await Promise.race([gateway.prepare(gateway.engines(), [d.start().say], lang), new Promise((r) => { setTimeout(r, 8000); })]);
      gateway.prepareCall(gateway.engines(), d);
    } catch (e) { log('prepare failed:', e.message); }
  }
  const number = dialNumber(m.e164, c.format);
  if (c.via === 'direct') {
    const dial = deps.direct || require('./sipDirect').originate; // eslint-disable-line global-require
    dial({ host: c.synway.host, port: c.synway.port, number, uuid, gatewayPort: c.port, localIp: c.localIp, ringSec: RING_SEC })
      .then(async (r) => {
        if (r.ok) return;
        const cur = await svc.getCall(id);
        if (cur && cur.status === 'calling') await svc.setRow(id, { status: r.status, failReason: String(r.reason).slice(0, 250), providerStatus: `sip:${r.code || r.status}`, endedAt: new Date().toISOString() });
      })
      .catch((e) => log('direct dial failed:', e.message));
  } else {
    const actionId = `tl-${id}-1`;
    try {
      const a = deps.ami || await ami(c);
      WAIT.set(actionId, id);
      const r = await a.action({
        Action: 'Originate', ActionID: actionId, Channel: `PJSIP/${number}@${c.trunk}`, Application: 'AudioSocket', Data: `${uuid},127.0.0.1:${c.port}`,
        Timeout: RING_SEC * 1000, CallerID: c.callerId || undefined, Async: 'true',
      });
      if (r.Response !== 'Success') throw new Error(r.Message || 'Asterisk refused the call');
    } catch (e) {
      WAIT.delete(actionId);
      await svc.setRow(id, { status: 'failed', failReason: `Not dialled: ${e.message}`.slice(0, 250), providerStatus: 'sip:not-dialled', endedAt: new Date().toISOString() });
      return { ok: false, code: 'not_dialled', reason: e.message, id };
    }
  }
  setTimeout(() => sweep().catch(() => {}), STUCK_MS + 2000).unref();
  return { ok: true, id, language: lang };
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
      // (a call to an Omni-Channel contact that was cut by a restart is reported as dropped: Omni-Channel rings the person again)
      await svc.setRow(r.id, { status: 'failed', failReason: 'The call was cut off (the server restarted).', endedAt: new Date(now).toISOString(), ...(String(r.candidateId || '').startsWith('omni:') ? { nextAction: 'dropped' } : {}) }); // eslint-disable-line no-await-in-loop
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

module.exports = { config, readiness, lineMode, place, dialQueued, dialOmni, sweep, start, dialNumber, _originateResult: originateResult, _wait: WAIT };
