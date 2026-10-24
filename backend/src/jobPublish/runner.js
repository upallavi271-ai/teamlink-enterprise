// ---------------------------------------------------------------------------
// THE RUNNER: takes ONE claimed queue entry and carries it to its outcome.
//   pre-checks (switches, login, job, mapping) -> adapter.run() -> outcome -> PortalPosting, queue state, credential
//   state, legacy by-hand bridge, audit, notification.
// Rules kept here:
//   * PUBLISHED only with an id/link AND a verified listing; anything less is NEEDS_CHECK (queue NEEDS_HUMAN).
//   * CAPTCHA / OTP / ... -> NEEDS_HUMAN, the portal is put on hold (no more attempts) and the by-hand task is kept.
//   * wrong password -> FAILED, the login is marked FAILED and posting stops until it is saved again.
//   * a failure after Submit is never retried by the queue.
//   * kill switch / pause / shutdown -> the entry goes back to the queue unchanged (no try used).
// ---------------------------------------------------------------------------
const { logAudit } = require('../utils/audit');
const Q = require('./queue');
const S = require('./settings');
const C = require('./constants');
const P = require('./portalPosting');
const Cred = require('./credentials');
const bridge = require('./legacyBridge');
const jobPayload = require('./jobPayload');
const L = require('./logs');
const { q1, ex } = require('./db');
const { createLogger } = require('../playwright/logger');
const { RunAborted } = require('../portals/base/errors');
const OTP = require('./otpBridge');
const guards = require('./guards');
const cfgLib = require('../portals/config');
const browserLib = require('../playwright/browser');

const HUMAN_BLOCK = ['CAPTCHA', 'OTP', 'TWO_FACTOR', 'UNUSUAL_ACTIVITY', 'EMAIL_VERIFY', 'BLOCKED'];
const PUBLISH_LIKE = ['PUBLISH', 'REPUBLISH', 'UPDATE'];

async function notify(userId, title, message) {
  if (!userId) return;
  try { await require('../utils/notify').notifyUsers([userId], { title, message }); } catch { /* a notice is a bonus */ } // eslint-disable-line global-require
}
const audit = (entry, action, detail) => logAudit({
  userId: entry.requestedBy || null, actorName: entry.requestedByName || 'TeamLink automation', action, entity: 'JobPublish', entityId: entry.requirementId || entry.portal,
  fromValue: `${C.portalName(entry.portal)} · ${entry.action}`, toValue: String(detail || '').slice(0, 400),
});

// opts: { workerId, shutdown: { requested }, adapterFactory(portal,args) , inline }
async function processEntry(row, opts = {}) {
  const workerId = opts.workerId || row.lockedBy;
  const entry = Q.shape(row);
  const { portal, action } = entry;
  const rid = entry.requirementId;
  const log = createLogger({ queueId: entry.id, requirementId: rid, portal });
  const lim = await S.limits(portal);
  let killCache = { at: 0, v: null };
  const checkpoint = async (step) => {
    if (opts.shutdown && opts.shutdown.requested) throw new RunAborted('SHUTDOWN', 'The worker is shutting down.');
    if (Date.now() - killCache.at > 2000) killCache = { at: Date.now(), v: await S.killState(portal) };
    if (killCache.v.abort) throw new RunAborted('KILLED', killCache.v.reason);
    return step;
  };
  const beat = setInterval(() => { Q.heartbeat(entry.id, workerId).catch(() => {}); }, 15000);
  const end = (out) => { clearInterval(beat); return out; };
  const humanFail = async (code, message) => {
    // what a person must do next (shown on the Post step, the job page and the diagnostics screen)
    const help = helpFor(code, portal, message);
    await Q.needsHuman(entry.id, workerId, { code, message, result: help ? { help } : undefined });
    await log.warn('needs-human', message);
    if (action === 'VERIFY') await Cred.recordTest(portal, code, message).catch(() => {});
    return end({ state: 'NEEDS_HUMAN', code, message });
  };
  const hardFail = async (code, message, retryable = false, retryAfterMs = null) => {
    const st = await Q.fail(entry.id, workerId, { code, message, retryable });
    // a site that said "wait N seconds" (Telegram 429 retry_after) is not asked again before that
    if (st === 'QUEUED' && retryAfterMs) await ex('UPDATE "PostingQueue" SET "nextRunAt" = MAX("nextRunAt", ?) WHERE "id" = ?', Date.now() + retryAfterMs, entry.id).catch(() => {});
    await log.error('failed', `${code}: ${message}`);
    if (action === 'VERIFY') await Cred.recordTest(portal, code, message).catch(() => {});
    if (rid && PUBLISH_LIKE.includes(action) && (st === 'FAILED' || st === 'DEAD')) await P.set(rid, portal, { status: 'FAILED', lastError: message, lastQueueId: entry.id, lastAction: action }, entry.requestedBy);
    if (st === 'FAILED' || st === 'DEAD') { await audit(entry, st === 'DEAD' ? 'Publish gave up (dead letter)' : 'Publish failed', message); await notify(entry.requestedBy, `${C.portalName(portal)}: the requirement did not go through`, message); }
    return end({ state: st, code, message });
  };

  try {
    const ks = await S.killState(portal);
    if (ks.stopped) { await Q.release(entry.id, workerId, { reason: `Not started: ${ks.reason}`, delayMs: 5000 }); return end({ state: 'QUEUED', released: true }); }
    const meta = require('../portals/registry').meta(portal); // eslint-disable-line global-require
    if (!meta) return await hardFail('UNEXPECTED', `No adapter for ${portal}.`);

    // ---- the real-posting gate (also checked by the service and by BasePortal.run)
    if (meta.kind === 'browser' && !entry.dryRun) {
      const loaded = await cfgLib.load(portal);
      const gate = guards.realPostingGate({ strict: browserLib.strictLocal(loaded.cfg), verified: !!loaded.verified, action, dryRun: false });
      if (gate) {
        if (rid) await bridge.ensureHandTask(portal, rid, C.ERRORS[gate].words);
        if (rid && PUBLISH_LIKE.includes(action)) await P.set(rid, portal, { status: 'FAILED', lastError: C.ERRORS[gate].words, lastQueueId: entry.id, lastAction: action }, entry.requestedBy);
        return await humanFail(gate, `${C.ERRORS[gate].words} A by-hand task keeps the requirement.`);
      }
    }

    // ---- login for a browser portal
    let creds = null;
    if (meta.kind === 'browser') {
      const c = await Cred.read(portal);
      if (!c.ok) return await hardFail(c.code, C.ERRORS[c.code].words);
      if (action !== 'VERIFY' && !c.enabled) {
        await bridge.ensureHandTask(portal, rid, C.ERRORS.SWITCHED_OFF.words);
        return await humanFail('SWITCHED_OFF', `${C.ERRORS.SWITCHED_OFF.words} A by-hand task keeps the requirement.`);
      }
      if (action !== 'VERIFY' && c.status === 'FAILED') return await hardFail('WRONG_PASSWORD', C.ERRORS.WRONG_PASSWORD.words);
      creds = { username: c.username, password: c.password };
      log.addSecret(c.username); log.addSecret(c.password); if (c.secret) log.addSecret(c.secret);
    }
    // ---- token for an API portal (Telegram / Facebook). A Dry run needs no token and sends nothing.
    if (meta.kind === 'api' && !entry.dryRun) {
      const c = await Cred.read(portal);
      if (!c.ok) return await hardFail(c.code, C.ERRORS[c.code].words);
      if (action !== 'VERIFY' && !c.enabled) return await humanFail('SWITCHED_OFF', C.ERRORS.SWITCHED_OFF.words);
      if (action !== 'VERIFY' && c.status === 'FAILED') return await hardFail('BAD_TOKEN', C.ERRORS.BAD_TOKEN.words);
      creds = { username: c.username, password: c.password };
      log.addSecret(c.username); log.addSecret(c.password);
    }
    if (meta.automation === false) {
      await bridge.ensureHandTask(portal, rid, 'This site cannot be posted by TeamLink.');
      return await humanFail('MANUAL_ONLY', `${C.portalName(portal)} is posted by hand.`);
    }

    // ---- the job
    const job = { live: false };
    if (rid && action !== 'VERIFY') {
      const prev = await P.get(rid, portal);
      job.portalJobId = prev ? prev.portalJobId : null;
      job.live = !!prev && prev.status === 'PUBLISHED';
      if (PUBLISH_LIKE.includes(action)) {
        const built = await jobPayload.build(rid, portal);
        if (!built.ok) return await hardFail('PORTAL_REJECTED', built.blocked || 'The requirement cannot be posted.');
        if (!built.payload.live) return await hardFail('JOB_NOT_LIVE', C.ERRORS.JOB_NOT_LIVE.words);
        if (built.payload.internal && portal !== 'career') return await hardFail('JOB_NOT_LIVE', 'TeamLink internal hiring stays on the career page.');
        if (built.missing.length) return await hardFail('PORTAL_REJECTED', `Missing: ${built.missing.map((m) => m.label).join(', ')}. Fill these in on the requirement first.`);
        job.payload = built.payload; job.hash = built.hash;
        built.warnings.forEach((w) => { log.warn('mapping', w); });
        if (action === 'REPUBLISH' && !job.live) job.portalJobId = null;
      }
      if (action === 'UNPUBLISH' && !job.portalJobId && portal !== 'career') {
        await bridge.ensureHandTask(portal, rid, 'The portal job id is not known: take the requirement down by hand.');
        return await humanFail('NO_JOB_ID', 'No portal job id is known for this requirement, so it cannot be taken down automatically.');
      }
    }

    // ---- run the adapter
    const Adapter = opts.adapterFactory ? null : null; // (kept simple: registry decides; tests register fakes)
    void Adapter;
    const adapter = (opts.adapterFactory || require('../portals/registry').create)(portal, { creds, log, ctx: {} }); // eslint-disable-line global-require
    await Q.noteResult(entry.id, workerId, { help: null, screenshots: [], selectorDrift: 0 }).catch(() => {});
    // A person types the OTP: the run waits with its browser open (otpBridge.js). The code is only ever in memory.
    const requestHelp = async ({ kind, step }) => {
      if (kind !== 'OTP') return null;
      let port;
      try { port = await OTP.ensureServer(); } catch { return null; } // no secret key: the run stops as "needs a person"
      const since = Date.now();
      const until = since + lim.otpWaitMs;
      const words = `${C.portalName(portal)} asked for a one-time code (OTP). Type the code that was sent to the phone or e-mail of the ${C.portalName(portal)} account.`;
      await Q.setWaiting(entry.id, workerId, { kind: 'OTP', reason: words, since: new Date(since).toISOString(), until: new Date(until).toISOString(), port, step });
      await log.warn('needs-help', 'Needs your help: waiting for someone to type the OTP.');
      await notify(entry.requestedBy, `${C.portalName(portal)}: type the OTP`, 'The site sent a one-time code. Open the requirement and type it in the "Needs your help" box.');
      try {
        return await OTP.waitForCode(entry.id, { timeoutMs: lim.otpWaitMs, watch: () => checkpoint('otp-wait') });
      } finally { await Q.clearWaiting(entry.id, workerId).catch(() => {}); }
    };
    const actor = rid ? { id: entry.requestedBy, name: entry.requestedByName } : null;
    const result = await adapter.run(action, job, {
      queueId: entry.id, requirementId: rid, dryRun: entry.dryRun, headed: false, checkpoint, deadlineMs: lim.runDeadlineMs, actor, requestHelp,
      onSubmitStart: () => Q.markSubmitStarted(entry.id, workerId),
    });
    // Facts about THIS attempt, whatever happened: its pictures and the selector report (drift is flagged in diagnostics).
    try {
      const rep = (result && result.selectors) || [];
      const drift = rep.filter((x) => x.state === 'drift' || x.state === 'broken').length;
      await Q.noteResult(entry.id, workerId, { screenshots: result.screenshots || [], selectorDrift: drift, ...(result.apiStatus ? { apiStatus: result.apiStatus } : {}) });
      if (rep.length && meta.kind === 'browser') {
        const loaded = await cfgLib.load(portal);
        await S.recordSelectors(portal, rep, { version: loaded.version, verified: loaded.verified });
      }
    } catch { /* diagnostics are a bonus */ }
    return await outcome(entry, workerId, job, result, log, end, { humanFail, hardFail });
  } catch (err) {
    const msg = String((err && err.message) || err).split('\n')[0].slice(0, 200);
    await log.error('runner', `Unexpected: ${msg}`);
    return hardFail('UNEXPECTED', `Something went wrong while posting (${msg}).`, true);
  }
}

async function outcome(entry, workerId, job, res, log, end, { humanFail, hardFail }) {
  const { portal, action } = entry;
  const rid = entry.requirementId;
  const shots = res.screenshots || [];
  if (res.aborted) {
    await Q.release(entry.id, workerId, { reason: `Stopped: ${res.reason}`, delayMs: 5000 });
    return end({ state: 'QUEUED', released: true });
  }
  if (res.ok && res.dryRun) {
    await Q.succeed(entry.id, workerId, { dryRun: true, note: res.note, screenshots: shots, ...(res.preview ? { preview: String(res.preview).slice(0, 5000) } : {}) });
    await audit(entry, 'Dry run finished', res.note);
    return end({ state: 'SUCCEEDED', dryRun: true });
  }
  if (res.ok && action === 'VERIFY') {
    await Cred.recordCheck(portal, 'CONNECTED', null);
    await Cred.recordTest(portal, null, null).catch(() => {});
    await S.clearHumanHold(portal);
    await Q.succeed(entry.id, workerId, { verified: true, note: res.note });
    await audit(entry, 'Portal login check: connected', res.note);
    return end({ state: 'SUCCEEDED' });
  }
  // Telegram / Facebook: closing a job sends nothing (or one closing note when an Admin switched that on). The earlier post stays
  // where it is, so the status is NOT changed to "Taken down": it would be a lie.
  if (res.ok && action === 'UNPUBLISH' && res.keepStatus) {
    await Q.succeed(entry.id, workerId, { note: res.note, ...(res.apiStatus ? { apiStatus: res.apiStatus } : {}) });
    await audit(entry, 'Closing: the post stays', res.note);
    return end({ state: 'SUCCEEDED' });
  }
  if (res.ok && action === 'UNPUBLISH') {
    if (!res.confirmed && portal !== 'career') {
      await P.set(rid, portal, { lastError: res.note || 'The site did not confirm the requirement was closed.', lastQueueId: entry.id, lastAction: action }, entry.requestedBy);
      return humanFail('UNVERIFIED', `${C.portalName(portal)} did not confirm the requirement was closed. Check on the site.`);
    }
    await P.set(rid, portal, { status: 'UNPUBLISHED', lastError: null, lastQueueId: entry.id, lastAction: action }, entry.requestedBy);
    await bridge.onRemoved(portal, rid, { byName: entry.requestedByName });
    await Q.succeed(entry.id, workerId, { portalJobId: job.portalJobId || null });
    await audit(entry, 'Unpublished', `${C.portalName(portal)}: taken down`);
    return end({ state: 'SUCCEEDED' });
  }
  if (res.ok && res.verified && (res.portalJobId || res.portalUrl)) {
    const now = Date.now();
    await P.set(rid, portal, {
      status: 'PUBLISHED', portalJobId: res.portalJobId || null, portalUrl: res.portalUrl || null, publishedAt: now, verifiedAt: now, lastError: null, lastQueueId: entry.id, lastAction: action, payloadHash: job.hash || null,
    }, entry.requestedBy);
    if (meta(portal).kind === 'browser') await Cred.recordCheck(portal, 'CONNECTED', null);
    await bridge.onPublished(portal, rid, { portalJobId: res.portalJobId, portalUrl: res.portalUrl, byName: entry.requestedByName });
    await Q.succeed(entry.id, workerId, { portalJobId: res.portalJobId || null, portalUrl: res.portalUrl || null, verified: true, note: res.note });
    await audit(entry, action === 'PUBLISH' ? 'Published' : `${action[0]}${action.slice(1).toLowerCase()}ed`, `${C.portalName(portal)}: live${res.portalJobId ? `, id ${res.portalJobId}` : ''}`);
    await notify(entry.requestedBy, `${C.portalName(portal)}: the requirement is live`, res.portalUrl || `Job id ${res.portalJobId || ''}`);
    // also tell the job's team lead and recruiter: '<Job> is live on Naukri' (2026-10-13)
    try {
      const jr = await require('../db').requirement.findUnique({ where: { id: rid }, select: { title: true, tlId: true, recruiterId: true } }); // eslint-disable-line global-require
      const others = [jr && jr.tlId, jr && jr.recruiterId].filter((x) => x && x !== entry.requestedBy);
      if (others.length) await require('../utils/notify').notifyUsers([...new Set(others)], { title: `${jr.title} is live on ${C.portalName(portal)}`, message: res.portalUrl || 'Open the requirement to see the link.' }); // eslint-disable-line global-require
    } catch { /* a notice is a bonus */ }
    return end({ state: 'SUCCEEDED', portalJobId: res.portalJobId });
  }
  // ---- not live, not a plain failure: a person must look
  if (res.needsHuman || (res.ok && !res.verified)) {
    const code = res.code || 'UNVERIFIED';
    const reason = res.reason || C.ERRORS.UNVERIFIED.words;
    if (rid && PUBLISH_LIKE.includes(action)) {
      await P.set(rid, portal, {
        status: 'NEEDS_CHECK', lastError: reason, lastQueueId: entry.id, lastAction: action, ...(res.portalJobId ? { portalJobId: res.portalJobId } : {}), ...(res.portalUrl ? { portalUrl: res.portalUrl } : {}),
      }, entry.requestedBy);
    }
    if (HUMAN_BLOCK.includes(code)) {
      await S.setHumanHold(portal, { reason, queueId: entry.id, code });
      if (action === 'VERIFY') await Cred.recordCheck(portal, 'NEEDS_HUMAN', reason); else await Cred.recordCheck(portal, 'NEEDS_HUMAN', reason);
      if (rid) await bridge.ensureHandTask(portal, rid, reason);
    }
    await audit(entry, 'Needs a person', `${code}: ${reason}`);
    await notify(entry.requestedBy, `${C.portalName(portal)}: a person is needed`, reason);
    return humanFail(code, reason);
  }
  // ---- plain failure
  if (['WRONG_PASSWORD', 'BAD_TOKEN'].includes(res.code)) await Cred.recordCheck(portal, 'FAILED', res.reason);
  return hardFail(res.code || 'UNEXPECTED', res.reason || 'It did not go through.', !!res.retryable, res.retryAfterMs || null);
}
const meta = (portal) => require('../portals/registry').meta(portal) || {}; // eslint-disable-line global-require

// What a person has to do after the run stopped for a check it must never do itself. Plain words + the exact command.
function helpFor(code, portal) {
  const name = C.portalName(portal);
  const command = `npm run portal-session -- ${portal}`;
  if (code === 'CAPTCHA') return { kind: 'CAPTCHA', title: 'Solve the CAPTCHA in the browser window', how: `TeamLink never solves a CAPTCHA. On the computer that runs the posting helper, type the command below. A Chrome window opens on ${name}: sign in and solve the CAPTCHA yourself, then close the window. Then press "I did it, try again".`, command };
  if (code === 'OTP') return { kind: 'OTP', title: 'The OTP was not typed in time', how: 'The run closed because nobody typed the one-time code. Press "Try again" and type the code when the box appears, or sign in yourself with the command below.', command };
  if (['TWO_FACTOR', 'UNUSUAL_ACTIVITY', 'EMAIL_VERIFY', 'BLOCKED'].includes(code)) return { kind: code, title: 'Sign in yourself in the browser window', how: `${name} wants a check TeamLink must not do. On the computer that runs the posting helper, type the command below, sign in yourself, then close the window and press "I did it, try again".`, command };
  if (['REAL_POSTING_OFF', 'SELECTORS_UNVERIFIED'].includes(code)) return { kind: code, title: code === 'REAL_POSTING_OFF' ? 'Real posting is not switched on for this computer' : 'The page settings are not verified yet', how: C.ERRORS[code].words, command: null };
  return null;
}

module.exports = { processEntry, outcome, helpFor, q1, L };
