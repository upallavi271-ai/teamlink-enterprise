// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE ONE SHARED SERVICE.
//
// Admin, the ATS screens, the Recruiter module, the interview hooks, the reminder sweep and the Job Portal bridge ALL call this
// file. There is no second Exotel integration anywhere.
//
//   preview()       what would be said + whether the call is allowed (changes nothing)
//   createCalls()   confirmed calls -> rows (queued) -> started now when the rules allow
//   dispatch()      one attempt: re-checks every rule, asks Exotel to place the call
//   cancel() retry()
//   applyProviderEvent()   Exotel's status callback (idempotent, never goes backwards)
//   list() detail() history()
//
// A call is "completed" ONLY when Exotel says so. Starting is not success. A call NEVER changes a stage or an interview.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const core = require('../utils/messagingCore');
const { logAudit } = require('../utils/audit');
const X = require('./exotelConfig');
const DB = require('./schema');
const settingsStore = require('./settings');
const client = require('./exotelClient');
const AMI = () => require('./local/ami'); // eslint-disable-line global-require -- Self-hosted (Synway): Asterisk AMI
const P = require('./policy');
const S = require('./scripts');

let CLOCK = null;
const now = () => (CLOCK ? CLOCK() : new Date());
const setClock = (fn) => { CLOCK = typeof fn === 'function' ? fn : null; };
const iso = (d) => d.toISOString();
const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const AUDIT_ACTOR = 'AI assistant';
const ALLOWED_STATUS = ['queued', 'calling', 'completed', 'failed', 'busy', 'no-answer', 'cancelled'];

const fail = (status, code, error, extra) => ({ ok: false, status, code, error, ...(extra || {}) });

// --- a signed reference that travels to Exotel in CustomField and comes back in the bot's start event --------------------
async function secretFor() {
  const s = await settingsStore.load();
  return s.hook || 'no-secret';
}
async function customFor(callId) {
  const sig = crypto.createHmac('sha256', await secretFor()).update(callId).digest('hex').slice(0, 10);
  return `tl:${callId}:${sig}`;
}
async function callIdFromCustom(custom) {
  const m = /^tl:([\w]+):([0-9a-f]{10})$/.exec(String(custom || ''));
  if (!m) return null;
  const want = crypto.createHmac('sha256', await secretFor()).update(m[1]).digest('hex').slice(0, 10);
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(want)) ? m[1] : null;
}
// the Voicebot HTTP endpoint token: <callId>.<hmac>
async function botTokenFor(callId) {
  const sig = crypto.createHmac('sha256', `bot:${await secretFor()}`).update(callId).digest('hex').slice(0, 24);
  return `${callId}.${sig}`;
}
async function callIdFromBotToken(token) {
  const [id, sig] = String(token || '').split('.');
  if (!id || !sig || sig.length !== 24) return null;
  const want = crypto.createHmac('sha256', `bot:${await secretFor()}`).update(id).digest('hex').slice(0, 24);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? id : null;
}

// --- loading --------------------------------------------------------------------------------------------------------------------
async function loadContext(applicationId) {
  const app = await prisma.application.findUnique({
    where: { id: String(applicationId || '') },
    include: { candidate: true, requirement: { include: { client: { select: { id: true, name: true, location: true } } } } },
  });
  if (!app) return null;
  return { app, candidate: app.candidate, requirement: app.requirement };
}
async function jobSetting(requirementId) {
  if (!requirementId) return null;
  return DB.one('SELECT * FROM "AiCallJobSetting" WHERE "requirementId" = ?', requirementId);
}
async function languagePref(candidateId) {
  const r = await DB.one('SELECT "language" FROM "AiCallPref" WHERE "candidateId" = ?', candidateId);
  return r ? r.language : null;
}
function languageFor(s, candidate, saved, asked) {
  const ok = (l) => (S.LANGS.includes(l) && s.languages.includes(l) ? l : null);
  return ok(asked) || ok(saved) || ok(candidate && candidate.language) || ok(s.fallbackLanguage) || 'English';
}

// --- who may use AI calling ---------------------------------------------------------------------------------------------------
// The Admin's role list + the Contact right (the BDE team's phone is masked, so it never calls) + the record's scope.
async function accessVerdict(user, ctx, s, { bulk = false } = {}) {
  if (!user || !user.id) return fail(401, 'login', 'Please sign in.');
  if (!(user.products || {}).ats) return fail(403, 'role', 'Your login does not include the recruitment (ATS) area.');
  if (!P.roleAllows(user, s, bulk)) {
    return fail(403, 'role', bulk ? 'Your role is not allowed to place bulk AI call campaigns. An Admin can change this in Administration > Integrations > AI Calling.'
      : 'Your role is not allowed to place AI calls. An Admin can change this in Administration > Integrations > AI Calling.');
  }
  const CA = require('../utils/contactAccess'); // eslint-disable-line global-require
  const rule = await CA.ruleFor(user, 'candidates');
  if (!rule.allowed) return fail(403, 'contact', rule.reason || 'Your role does not contact candidates.');
  if (rule.mode !== 'direct') return fail(403, 'contact', 'Your role does not see candidate phone numbers, so it cannot place AI calls. Ask the recruiter.');
  if (bulk && !(await CA.bulkAllowed(user, 'candidates'))) return fail(403, 'bulk', 'Your role cannot send to many candidates at once.');
  if (ctx) {
    const { applicationInScope } = require('../utils/scope'); // eslint-disable-line global-require
    if (!applicationInScope(user, { ...ctx.app, requirement: ctx.requirement })) return fail(404, 'scope', 'Application not found.');
  }
  return { ok: true };
}

// --- the script (verified data only) ------------------------------------------------------------------------------------------
async function scriptFor(ctx, purpose, language, fieldsIn, s) {
  const fields = S.cleanFields(fieldsIn);
  const err = S.checkFields(fields);
  const IM = require('../utils/interviewMeet'); // eslint-disable-line global-require
  const linkOk = !!(ctx.app.interviewMeetingLink && IM.checkLink(ctx.app.interviewMeetingLink).ok);
  const data = S.buildData({ candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, link: linkOk });
  const lines = S.preview(purpose, language, data, fields, { recordingNotice: s.recording || s.keepTranscripts });
  return { fields, data, lines, error: err };
}

// --- preview ----------------------------------------------------------------------------------------------------------------------
async function preview(user, { applicationId, purpose, language, fields }) {
  const s = await settingsStore.load({ fresh: true });
  const ctx = await loadContext(applicationId);
  if (!ctx) return fail(404, 'scope', 'Application not found.');
  const acc = await accessVerdict(user, ctx, s);
  if (!acc.ok) return acc;
  const t = now();
  const lang = languageFor(s, ctx.candidate, await languagePref(ctx.candidate.id), language);
  const verdict = await P.personVerdict({ candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, purpose, s, now: t, jobSetting: await jobSetting(ctx.requirement.id) });
  const script = await scriptFor(ctx, purpose, lang, fields, s);
  const version = S.PURPOSES.includes(purpose) && purpose.startsWith('Interview') ? P.scheduleVersionOf(ctx.app) : null;
  const dup = purpose && S.PURPOSES.includes(purpose)
    ? await DB.one('SELECT "id", "status" FROM "AiCall" WHERE "dedupeKey" = ? AND "status" <> \'cancelled\'', P.dedupeKey({ candidateId: ctx.candidate.id, requirementId: ctx.requirement.id, campaignId: '', purpose, scheduleVersion: version, slot: '' }))
    : null;
  const win = P.windowVerdict(t, s);
  return {
    ok: true,
    allowed: verdict.ok && !script.error && !dup && s.configured,
    verdict: verdict.ok ? { ok: true } : { ok: false, code: verdict.code, reason: verdict.reason },
    duplicate: dup ? { id: dup.id, status: dup.status } : null,
    notReady: s.configured ? null : s.problems,
    window: win.ok ? { open: true } : { open: false, until: win.until ? iso(win.until) : null, refuse: s.outside === 'Refuse' },
    language: lang,
    languages: s.languages,
    mode: s.mode,
    lines: script.lines,
    fields: script.fields,
    fieldError: script.error,
    candidate: { name: ctx.candidate.name, phoneMask: core.maskMobile(ctx.candidate.phone), stage: ctx.app.stage, job: ctx.requirement.title },
    requirement: { code: ctx.requirement.reqCode || null, title: ctx.requirement.title, client: ctx.requirement.internal ? 'TeamLink' : ((ctx.requirement.client && ctx.requirement.client.name) || null) },
    scheduleVersion: version,
  };
}

// --- create ---------------------------------------------------------------------------------------------------------------------------
// input: { items:[applicationId], purpose, language, fields, confirm, campaignName, slot, via, scheduleVersion, auto }
async function createOne(user, applicationId, input, s, campaignId) {
  const ctx = await loadContext(applicationId);
  if (!ctx) return fail(404, 'scope', 'Application not found.');
  const system = input.auto === true;
  if (!system) {
    const acc = await accessVerdict(user, ctx, s, { bulk: !!input.bulk });
    if (!acc.ok) return acc;
  }
  const t = now();
  const purpose = input.purpose;
  if (!s.configured) return fail(409, 'not_ready', 'AI calling is not ready yet, so no call can be started.', { steps: s.problems });
  const jset = await jobSetting(ctx.requirement.id);
  const verdict = await P.personVerdict({ candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, purpose, s, now: t, jobSetting: jset });
  if (!verdict.ok) {
    await logAudit({ userId: user ? user.id : null, actorName: user ? undefined : AUDIT_ACTOR, action: 'AI call refused', entity: 'Application', entityId: ctx.app.id, toValue: `${purpose}: ${verdict.code}`.slice(0, 200) });
    return fail(403, verdict.code, verdict.reason);
  }
  const lang = languageFor(s, ctx.candidate, await languagePref(ctx.candidate.id), input.language);
  const fields = S.cleanFields(input.fields);
  const fe = S.checkFields(fields);
  if (fe) return fail(400, 'script', fe);
  const version = purpose.startsWith('Interview') ? P.scheduleVersionOf(ctx.app) : null;
  const key = P.dedupeKey({ candidateId: ctx.candidate.id, requirementId: ctx.requirement.id, campaignId, purpose, scheduleVersion: version, slot: input.slot || '' });
  const dup = await DB.one('SELECT "id", "status" FROM "AiCall" WHERE "dedupeKey" = ? AND "status" <> \'cancelled\'', key);
  if (dup) {
    const retryable = ['failed', 'busy', 'no-answer'].includes(dup.status);
    return fail(409, 'duplicate', retryable
      ? 'This candidate was already called for this job and purpose, and it did not connect. Use Retry on that call.'
      : `This candidate already has a ${dup.status === 'completed' ? 'finished' : 'waiting'} AI call for this job and purpose.`, { callId: dup.id, existingStatus: dup.status });
  }
  const id = newId('aic');
  const stamp = iso(t);
  try {
    await DB.run(
      `INSERT INTO "AiCall" ("id","mode","purpose","status","applicationId","candidateId","requirementId","campaignId","dedupeKey","scheduleVersion","slot","language","scriptJson",
        "initiatedById","initiatedByName","initiatedVia","toMask","confirmedAt","confirmedById","attempts","maxAttempts","nextAttemptAt","stageAtCall","createdAt","updatedAt")
       VALUES (?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
      id, s.mode.toLowerCase(), purpose, ctx.app.id, ctx.candidate.id, ctx.requirement.id, campaignId || null, key, version, input.slot || null, lang, JSON.stringify({ fields }),
      user ? user.id : null, user ? user.name : null, input.via || 'recruiter', verdict.mask || null, stamp, user ? user.id : null, s.attempts, stamp, ctx.app.stage, stamp, stamp,
    );
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) return fail(409, 'duplicate', 'This candidate already has an AI call for this job and purpose.');
    throw err;
  }
  // The language a person chose becomes the candidate's saved language for the next call (the ATS has no such field of its own).
  if (input.language && S.LANGS.includes(input.language) && s.languages.includes(input.language)) {
    await DB.run('INSERT OR REPLACE INTO "AiCallPref" ("candidateId","language","source","updatedAt") VALUES (?,?,?,?)', ctx.candidate.id, input.language, 'recruiter', stamp);
  }
  await logAudit({
    userId: user ? user.id : null, actorName: user ? undefined : AUDIT_ACTOR, action: 'AI call requested', entity: 'Application', entityId: ctx.app.id,
    toValue: `${purpose} (${lang}, ${s.mode})${input.via && input.via !== 'recruiter' ? ` via ${input.via}` : ''}`.slice(0, 200),
  });
  return { ok: true, id, status: 'queued' };
}

async function createCalls(user, input) {
  const s = await settingsStore.load({ fresh: true });
  const ids = [...new Set((Array.isArray(input.items) ? input.items : []).map((x) => String(x && x.applicationId ? x.applicationId : x)).filter(Boolean))];
  if (!ids.length) return fail(400, 'items', 'Pick at least one candidate.');
  if (!S.PURPOSES.includes(input.purpose)) return fail(400, 'purpose', 'Pick what the call is for.');
  if (input.auto !== true && input.confirm !== true) return fail(400, 'confirm', 'Please confirm the call first. No call is placed without your confirmation.');
  const bulk = ids.length > 1;
  if (bulk && ids.length > s.maxBulk) return fail(400, 'too_many', `A campaign can have at most ${s.maxBulk} candidates.`);
  if (bulk && input.auto !== true) {
    const acc = await accessVerdict(user, null, s, { bulk: true });
    if (!acc.ok) return acc;
  }
  let campaignId = input.campaignId || null;
  if (bulk && !campaignId) {
    campaignId = newId('aicamp');
    const first = await loadContext(ids[0]);
    await DB.run('INSERT INTO "AiCallCampaign" ("id","name","purpose","requirementId","createdById","createdByName","total","createdAt") VALUES (?,?,?,?,?,?,?,?)',
      campaignId, S.clean(input.campaignName, 80) || `${input.purpose} ${iso(now()).slice(0, 10)}`, input.purpose, first ? first.requirement.id : null, user ? user.id : null, user ? user.name : null, ids.length, iso(now()));
  }
  const results = [];
  for (const applicationId of ids) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const r = await createOne(user, applicationId, { ...input, bulk }, s, campaignId);
    if (r.ok && input.dispatch !== false) {
      // eslint-disable-next-line no-await-in-loop
      const d = await dispatch(r.id);
      results.push({ applicationId, ok: true, callId: r.id, status: d.status, note: d.note || null });
    } else results.push({ applicationId, ok: !!r.ok, callId: r.id || r.callId || null, status: r.status === 'queued' ? 'queued' : undefined, code: r.code, error: r.error, httpStatus: r.status, steps: r.steps });
  }
  return { ok: true, campaignId, results, started: results.filter((x) => x.ok).length, refused: results.filter((x) => !x.ok).length };
}

// --- one attempt -----------------------------------------------------------------------------------------------------------------------
async function setRow(id, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  await DB.run(`UPDATE "AiCall" SET ${cols.map((c) => `"${c}" = ?`).join(', ')}, "updatedAt" = ? WHERE "id" = ?`, ...cols.map((c) => patch[c]), iso(now()), id);
}
async function getCall(id) { return DB.one('SELECT * FROM "AiCall" WHERE "id" = ?', id); }

async function cancelWith(row, reason, who) {
  await setRow(row.id, { status: 'cancelled', failReason: String(reason).slice(0, 300), nextAttemptAt: null, waitReason: null, endedAt: iso(now()) });
  await logAudit({ userId: who ? who.id : null, actorName: who ? undefined : AUDIT_ACTOR, action: 'AI call cancelled', entity: 'Application', entityId: row.applicationId, toValue: String(reason).slice(0, 200) });
  try { await require('./outcomes').notifyCancelled(row, reason); } catch { /* a notice problem never blocks */ } // eslint-disable-line global-require
}

function gapFor(s, attemptsDone) {
  const g = s.gaps;
  return g[Math.min(Math.max(attemptsDone - 1, 0), g.length - 1)] * 60000;
}

async function dispatch(id, { force = false } = {}) {
  const row = await getCall(id);
  if (!row) return { status: 'missing' };
  const retryable = ['busy', 'no-answer', 'failed'].includes(row.status);
  if (row.status !== 'queued' && !(retryable && row.nextAttemptAt)) return { status: row.status, note: 'not waiting' };
  const s = await settingsStore.load({ fresh: true });
  const t = now();
  if (row.nextAttemptAt && new Date(row.nextAttemptAt).getTime() > t.getTime() && !force) return { status: row.status, note: 'not yet due' };
  if (!s.configured) {
    await setRow(row.id, { status: 'failed', failReason: `AI calling is not ready: ${s.problems[0]}`, nextAttemptAt: null });
    return { status: 'failed', note: 'not configured' };
  }
  const ctx = await loadContext(row.applicationId);
  if (!ctx) { await cancelWith(row, 'The application no longer exists.'); return { status: 'cancelled' }; }
  // The rules again, at the moment of the call (consent can be withdrawn, an interview can move).
  const verdict = await P.personVerdict({ candidate: ctx.candidate, app: ctx.app, requirement: ctx.requirement, purpose: row.purpose, s, now: t, jobSetting: await jobSetting(ctx.requirement.id) });
  if (!verdict.ok) { await cancelWith(row, `Not called: ${verdict.reason}`); return { status: 'cancelled', note: verdict.code }; }
  if (row.purpose.startsWith('Interview') && P.scheduleVersionOf(ctx.app) !== row.scheduleVersion) {
    await cancelWith(row, 'The interview details changed, so this older call was dropped. The updated details are used for the new call.');
    return { status: 'cancelled', note: 'superseded' };
  }
  const win = P.windowVerdict(t, s);
  if (!win.ok) {
    if (win.wait) { await setRow(row.id, { status: 'queued', nextAttemptAt: iso(win.until), waitReason: win.reason.slice(0, 250) }); return { status: 'queued', note: 'outside hours' }; }
    await cancelWith(row, win.reason); return { status: 'cancelled', note: 'outside hours' };
  }
  const lim = await P.limitVerdict(t, s, row.initiatedVia === 'recruiter' ? row.initiatedById : null);
  if (!lim.ok) {
    if (lim.wait) { await setRow(row.id, { status: 'queued', nextAttemptAt: iso(lim.until), waitReason: lim.reason.slice(0, 250) }); return { status: 'queued', note: lim.code }; }
    await cancelWith(row, lim.reason); return { status: 'cancelled', note: lim.code };
  }
  // Place the call.
  const n = row.attempts + 1;
  const stamp = iso(t);
  await DB.run('INSERT OR IGNORE INTO "AiCallEvent" ("id","callId","eventKey","kind","status","applied","receivedAt") VALUES (?,?,?,?,?,1,?)', newId('aie'), row.id, `attempt:${row.id}:${n}`, 'attempt', 'attempt', stamp);
  await setRow(row.id, { attempts: n, lastAttemptAt: stamp, status: 'calling', nextAttemptAt: null, waitReason: null, failReason: null, startedAt: stamp, endedAt: null, providerStatus: 'queued' });
  let r;
  const synway = s.provider === 'synway';
  if (synway) {
    // Self-hosted (Synway): OUR id is the call's id. It is saved BEFORE dialling, because the AudioSocket bridge looks the call
    // up by it the moment the candidate answers (AICALL_UUID = AiCall.callSid). Asterisk's result comes back through onResult.
    const uuid = crypto.randomUUID();
    await setRow(row.id, { callSid: uuid });
    r = await AMI().startCall(s, { to: verdict.e164, uuid, onResult: (ev) => applyLocalEvent(uuid, ev) });
  } else {
    const cb = s.publicBase ? `${s.publicBase}${X.WEBHOOK.statusPath}?${X.WEBHOOK.keyParam}=${encodeURIComponent(s.hook)}` : null;
    r = await client.startCall(s, { to: verdict.e164, statusCallback: cb, custom: await customFor(row.id), record: s.recording });
  }
  if (r.ok) {
    await setRow(row.id, { callSid: r.callSid, providerStatus: r.status });
    await logAudit({ userId: row.initiatedById, actorName: row.initiatedById ? undefined : AUDIT_ACTOR, action: 'AI call started', entity: 'Application', entityId: row.applicationId, toValue: `${row.purpose} attempt ${n} (${s.mode}, ${synway ? 'Self-hosted (Synway)' : 'Exotel'})` });
    return { status: 'calling' };
  }
  const why = (synway ? AMI() : client).clean(r.error, s);
  if (synway) await DB.run('INSERT OR IGNORE INTO "AiCallEvent" ("id","callId","eventKey","kind","status","note","applied","receivedAt") VALUES (?,?,?,?,?,?,1,?)', newId('aie'), row.id, `ami-refused:${row.id}:${n}`, 'asterisk', 'failed', why.slice(0, 500), stamp);
  if (r.transient && n < row.maxAttempts) {
    await setRow(row.id, { status: 'failed', failReason: why, nextAttemptAt: iso(new Date(t.getTime() + gapFor(s, n))), waitReason: `${synway ? 'The phone system (Asterisk)' : 'Exotel'} had a problem. Trying again (attempt ${n + 1} of ${row.maxAttempts}).` });
    return { status: 'failed', note: 'will retry' };
  }
  await setRow(row.id, { status: 'failed', failReason: why, nextAttemptAt: null, endedAt: stamp });
  try { await require('./outcomes').attemptFailed(await getCall(row.id), why, true); } catch { /* record is best effort */ } // eslint-disable-line global-require
  return { status: 'failed', note: 'gave up' };
}

// --- cancel / retry ----------------------------------------------------------------------------------------------------------------------
async function visibleRow(user, id) {
  const row = await getCall(id);
  if (!row) return null;
  const ctx = row.applicationId ? await loadContext(row.applicationId) : null;
  if (!ctx) return null;
  const { applicationInScope } = require('../utils/scope'); // eslint-disable-line global-require
  if (!applicationInScope(user, { ...ctx.app, requirement: ctx.requirement })) return null;
  return row;
}
async function cancel(user, id) {
  const s = await settingsStore.load();
  const row = await visibleRow(user, id);
  if (!row) return fail(404, 'scope', 'Call not found.');
  const acc = await accessVerdict(user, null, s);
  if (!acc.ok) return acc;
  const waiting = row.status === 'queued' || (['busy', 'no-answer', 'failed'].includes(row.status) && row.nextAttemptAt);
  if (!waiting) return fail(409, 'state', row.status === 'calling' ? 'This call is already on the phone and cannot be cancelled here.' : 'Only a waiting call can be cancelled.');
  await cancelWith(row, `Cancelled by ${user.name}.`, user);
  return { ok: true, status: 'cancelled' };
}
async function retry(user, id) {
  const s = await settingsStore.load({ fresh: true });
  const row = await visibleRow(user, id);
  if (!row) return fail(404, 'scope', 'Call not found.');
  const acc = await accessVerdict(user, null, s);
  if (!acc.ok) return acc;
  if (!['failed', 'busy', 'no-answer'].includes(row.status)) return fail(409, 'state', 'Only a call that did not connect (failed, busy or no answer) can be retried.');
  if (row.initiatedVia === 'sip') return fail(409, 'state', 'This was a call from our own phone line. Press "Call with AI (phone)" on the candidate again for a new call.');
  if (row.attempts >= row.maxAttempts) return fail(409, 'limit', `The most attempts for this call (${row.maxAttempts}) is reached. Call the candidate yourself.`);
  await setRow(row.id, { status: 'queued', nextAttemptAt: iso(now()), failReason: null, waitReason: null });
  await logAudit({ userId: user.id, action: 'AI call retry', entity: 'Application', entityId: row.applicationId, toValue: `${row.purpose} attempt ${row.attempts + 1}` });
  const d = await dispatch(row.id);
  return { ok: true, status: d.status, note: d.note || null };
}

// --- Exotel's status callback ---------------------------------------------------------------------------------------------------------------
const pick = (body, names) => { for (const n of names) if (body && body[n] != null && body[n] !== '') return body[n]; return null; };
function parseCallback(body) {
  const b = body && typeof body === 'object' ? body : {};
  const dur = Number(pick(b, X.CALLBACK.duration));
  return {
    sid: pick(b, X.CALLBACK.sid) ? String(pick(b, X.CALLBACK.sid)).slice(0, 80) : null,
    statusRaw: pick(b, X.CALLBACK.status),
    status: X.normalStatus(pick(b, X.CALLBACK.status)),
    duration: Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : null,
    recording: pick(b, X.CALLBACK.recording) ? String(pick(b, X.CALLBACK.recording)).slice(0, 500) : null,
    custom: pick(b, X.CALLBACK.custom) ? String(pick(b, X.CALLBACK.custom)).slice(0, 200) : null,
    updated: pick(b, X.CALLBACK.updated) ? String(pick(b, X.CALLBACK.updated)).slice(0, 40) : null,
  };
}

async function applyProviderEvent(body) {
  return applyEvent(parseCallback(body));
}

// SELF-HOSTED (SYNWAY): what Asterisk said about a call (calling/local/ami.js OriginateResponse) goes through the SAME rules as an
// Exotel callback: in order, once, retries for busy / no answer / failed, the outcome at the end. "completed" is written by the
// AudioSocket bridge when the conversation ends. An answered call whose bridge never starts is not left "calling": the watchdog
// fails it with the reason (Asterisk AudioSocket / AI_CALL_AUDIOSOCKET_PORT).
const BRIDGE_WAIT_MS = Number(process.env.AI_CALL_BRIDGE_WAIT_MS) || 45000;
async function applyLocalEvent(callSid, ev) {
  const status = X.normalStatus(ev && ev.status);
  const out = await applyEvent({
    sid: callSid, statusRaw: ev && ev.status, status, duration: null, recording: null, custom: null,
    updated: `${Date.now()}`, detail: ev && ev.detail ? String(ev.detail).slice(0, 200) : null, reason: ev && ev.reason != null ? ev.reason : null,
  });
  if (status === 'in-progress') {
    setTimeout(async () => {
      try {
        const row = await DB.one('SELECT * FROM "AiCall" WHERE "callSid" = ?', callSid);
        if (!row || row.status !== 'calling') return;
        const bridged = await DB.one('SELECT "id" FROM "AiCallEvent" WHERE "callId" = ? AND "kind" = \'audiosocket\' LIMIT 1', row.id);
        if (bridged) return;
        await applyEvent({ sid: callSid, statusRaw: 'failed', status: 'failed', duration: null, recording: null, custom: null, updated: `${Date.now()}:watchdog`, detail: 'The candidate answered, but the AI did not join the call: Asterisk did not open AudioSocket to TeamLink (check the [teamlink-ai] dialplan and AI_CALL_AUDIOSOCKET_PORT).' });
      } catch (err) { console.error('[ai-calling] bridge watchdog:', err.message); } // eslint-disable-line no-console
    }, BRIDGE_WAIT_MS).unref();
  }
  return out;
}

async function applyEvent(ev) {
  const t = now();
  const eventKey = `prov:${crypto.createHash('sha256').update([ev.sid, ev.status, ev.duration, ev.updated, ev.custom].join('|')).digest('hex').slice(0, 40)}`;
  let callId = ev.custom ? await callIdFromCustom(ev.custom) : null;
  let row = null;
  if (ev.sid) row = await DB.one('SELECT * FROM "AiCall" WHERE "callSid" = ?', ev.sid);
  if (!row && callId) row = await getCall(callId);
  callId = row ? row.id : null;
  const scrubbed = JSON.stringify({ sid: ev.sid, status: ev.statusRaw, duration: ev.duration, updated: ev.updated, hasRecording: !!ev.recording, ...(ev.detail ? { detail: ev.detail } : {}), ...(ev.reason != null ? { reason: ev.reason } : {}) });
  const added = await DB.run('INSERT OR IGNORE INTO "AiCallEvent" ("id","callId","callSid","eventKey","kind","status","payload","applied","receivedAt") VALUES (?,?,?,?,?,?,?,0,?)',
    newId('aie'), callId, ev.sid, eventKey, ev.detail !== undefined ? 'asterisk' : 'provider', ev.status || String(ev.statusRaw || '').slice(0, 30), scrubbed, iso(t));
  if (!added) return { ok: true, duplicate: true };
  const note = async (n, applied) => { await DB.run('UPDATE "AiCallEvent" SET "note" = ?, "applied" = ? WHERE "eventKey" = ?', n, applied ? 1 : 0, eventKey); };
  if (!ev.status) { await note('unknown status word', false); return { ok: true, ignored: 'unknown status' }; }
  if (!row) { await note('unknown call id: stored, not applied', false); return { ok: true, unknown: true }; }
  const s = await settingsStore.load();
  const rank = X.STATUS_RANK[ev.status];
  const haveRank = X.STATUS_RANK[row.providerStatus] == null ? -1 : X.STATUS_RANK[row.providerStatus];
  if (row.endedAt && row.status !== 'queued' && row.status !== 'calling') { await note('after the final result: ignored', false); return { ok: true, ignored: 'final already' }; }
  if (row.status === 'cancelled') { await note('call was cancelled: ignored', false); return { ok: true, ignored: 'cancelled' }; }
  if (!X.FINAL.has(ev.status)) {
    if (rank < haveRank) { await note('older than what we already know: ignored', false); return { ok: true, ignored: 'out of order' }; }
    await setRow(row.id, { providerStatus: ev.status });
    await note('progress', true);
    return { ok: true, applied: 'progress' };
  }
  // a final result
  const bot = row.botStateJson ? safeJson(row.botStateJson) : null;
  const botTalked = !!(bot && bot.turns > 0);
  let final = ev.status === 'canceled' ? 'failed' : ev.status;
  if (final === 'completed' && !(ev.duration > 0) && !botTalked) final = 'no-answer'; // connected for 0 seconds = nobody answered
  const patch = {
    status: final, providerStatus: ev.status, endedAt: iso(t), durationSec: ev.duration == null ? row.durationSec : ev.duration,
    waitReason: null, nextAttemptAt: null,
  };
  if (ev.recording && s.recording) { patch.recordingUrl = ev.recording; patch.purgeAt = iso(new Date(t.getTime() + s.recordingDays * 86400000)); }
  if (final === 'completed') {
    await setRow(row.id, { ...patch, failReason: null });
    await note('completed', true);
    const fresh = await getCall(row.id);
    try { await require('./outcomes').afterCompleted(fresh); } catch (err) { console.error('[ai-calling] outcome:', err.message); } // eslint-disable-line global-require, no-console
    return { ok: true, applied: 'completed' };
  }
  // busy / no-answer / failed: retry or give up
  const n = row.attempts;
  const why = ev.detail || (final === 'busy' ? 'The candidate\'s phone was busy.' : final === 'no-answer' ? 'The candidate did not answer.' : 'The call failed at the telephone network.');
  if (n < row.maxAttempts) {
    const next = new Date(t.getTime() + gapFor(s, n));
    await setRow(row.id, { ...patch, failReason: why, nextAttemptAt: iso(next), waitReason: `Trying again (attempt ${n + 1} of ${row.maxAttempts}).` });
    await note(final, true);
    try { await require('./outcomes').attemptFailed(await getCall(row.id), why, false); } catch { /* best effort */ } // eslint-disable-line global-require
    return { ok: true, applied: final, retryAt: iso(next) };
  }
  await setRow(row.id, { ...patch, failReason: why });
  await note(final, true);
  try { await require('./outcomes').attemptFailed(await getCall(row.id), why, true); } catch { /* best effort */ } // eslint-disable-line global-require
  return { ok: true, applied: final, gaveUp: true };
}

const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

// --- reading ------------------------------------------------------------------------------------------------------------------------------------
function shape(r, { withDetail = false } = {}) {
  const o = {
    id: r.id, mode: r.mode, purpose: r.purpose, status: r.status, applicationId: r.applicationId, candidateId: r.candidateId, requirementId: r.requirementId, campaignId: r.campaignId,
    language: r.language, initiatedByName: r.initiatedByName, initiatedVia: r.initiatedVia, phoneMask: r.toMask, attempts: r.attempts, maxAttempts: r.maxAttempts,
    nextAttemptAt: r.nextAttemptAt, waitReason: r.waitReason, startedAt: r.startedAt, endedAt: r.endedAt, durationSec: r.durationSec, outcome: r.outcome,
    interest: r.interest, summary: r.summary, rescheduleWish: r.rescheduleWish, humanFollowUp: !!r.humanFollowUp, nextAction: r.nextAction, followUpDate: r.followUpDate,
    failReason: r.failReason, scheduleVersion: r.scheduleVersion, slot: r.slot, stageAtCall: r.stageAtCall, createdAt: r.createdAt, callSid: r.callSid,
    hasTranscript: !!r.transcript, hasRecording: !!r.recordingUrl,
  };
  o.answers = safeJson(r.answersJson) || {};
  if (withDetail) {
    o.written = safeJson(r.written) || {};
  }
  return o;
}

// Rows the person may see: the application must be in their scope.
async function scopedIds(user, rows) {
  if (!rows.length) return new Set();
  const { applicationWhere } = require('../utils/scope'); // eslint-disable-line global-require
  const appIds = [...new Set(rows.map((r) => r.applicationId).filter(Boolean))];
  const ok = await prisma.application.findMany({ where: { AND: [{ id: { in: appIds } }, applicationWhere(user)] }, select: { id: true } });
  return new Set(ok.map((a) => a.id));
}

async function list(user, q = {}) {
  const s = await settingsStore.load();
  const acc = await accessVerdict(user, null, s);
  if (!acc.ok && !(await viewOnly(user))) return acc;
  const where = ['1=1']; const args = [];
  const eq = (col, v) => { if (v) { where.push(`"${col}" = ?`); args.push(String(v)); } };
  eq('status', q.status); eq('purpose', q.purpose); eq('requirementId', q.requirementId); eq('campaignId', q.campaignId); eq('candidateId', q.candidateId); eq('applicationId', q.applicationId); eq('initiatedById', q.userId); eq('mode', q.mode);
  if (q.from) { where.push('"createdAt" >= ?'); args.push(new Date(`${String(q.from).slice(0, 10)}T00:00:00+05:30`).toISOString()); }
  if (q.to) { where.push('"createdAt" < ?'); args.push(new Date(new Date(`${String(q.to).slice(0, 10)}T00:00:00+05:30`).getTime() + 86400000).toISOString()); }
  const rows = await DB.all(`SELECT * FROM "AiCall" WHERE ${where.join(' AND ')} ORDER BY "createdAt" DESC LIMIT ${Math.min(Number(q.limit) || 200, 500)}`, ...args);
  const okIds = await scopedIds(user, rows);
  const names = await namesOf(rows.filter((r) => okIds.has(r.applicationId)));
  return { ok: true, rows: rows.filter((r) => okIds.has(r.applicationId)).map((r) => ({ ...shape(r), ...names.get(r.id) })) };
}
// Managers may read the numbers and history without placing calls.
async function viewOnly(user) {
  const r = String((user && (user.atsRole || user.role)) || '').toUpperCase();
  return !!(user && (user.products || {}).ats && ['MANAGER', 'ASSISTANT_MANAGER'].includes(r));
}
async function namesOf(rows) {
  const out = new Map();
  if (!rows.length) return out;
  const cands = await prisma.candidate.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.candidateId))] } }, select: { id: true, name: true } });
  const reqs = await prisma.requirement.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.requirementId).filter(Boolean))] } }, select: { id: true, title: true } });
  const cm = new Map(cands.map((c) => [c.id, c.name])); const rm = new Map(reqs.map((r) => [r.id, r.title]));
  rows.forEach((r) => out.set(r.id, { candidateName: cm.get(r.candidateId) || '', jobTitle: rm.get(r.requirementId) || '' }));
  return out;
}

async function detail(user, id) {
  const row = await visibleRow(user, id);
  if (!row) return fail(404, 'scope', 'Call not found.');
  const s = await settingsStore.load();
  const acc = await accessVerdict(user, null, s);
  const mayRead = acc.ok || await viewOnly(user);
  if (!mayRead) return acc;
  const names = await namesOf([row]);
  const out = { ...shape(row, { withDetail: true }), ...names.get(row.id) };
  // The transcript is read only by roles that may place calls (never by the BDE team or other roles) and is never in a list.
  if (acc.ok && row.transcript && !row.deletedAt) out.transcript = safeJson(row.transcript) || [];
  const events = await DB.all('SELECT "kind","status","note","receivedAt" FROM "AiCallEvent" WHERE "callId" = ? ORDER BY "receivedAt" ASC LIMIT 50', row.id);
  out.events = events;
  return { ok: true, call: out };
}

async function history(user, { candidateId, applicationId }) {
  const r = await list(user, { candidateId, applicationId, limit: 100 });
  return r.ok ? { ok: true, rows: r.rows } : r;
}

module.exports = {
  setClock, now, preview, createCalls, dispatch, cancel, retry, applyProviderEvent, applyLocalEvent, applyEvent, parseCallback, list, detail, history, shape, getCall, setRow, loadContext, accessVerdict,
  scriptFor, languageFor, languagePref, jobSetting, customFor, callIdFromCustom, botTokenFor, callIdFromBotToken, cancelWith, createOne, newId, safeJson, gapFor, viewOnly, fail, ALLOWED_STATUS,
};
