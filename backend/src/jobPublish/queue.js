// ---------------------------------------------------------------------------
// THE QUEUE (PostingQueue). A database queue with the semantics a BullMQ queue would have given us, with no Redis:
//
//   enqueue       idempotency key (unique) + "already in flight" check: the same request twice is one entry
//   claim         ONE atomic UPDATE ... WHERE status='QUEUED' AND nextRunAt<=now ... RETURNING: two workers can never
//                 get the same entry. Concurrency: 1 per portal and a global cap (default 1: one browser at a time).
//   heartbeat     the worker refreshes lockedAt while it works; recoverStale() takes back an entry whose lock is old
//   complete/fail exponential backoff with jitter (attempt 1: ~30 s, 2: ~60 s ...), maxAttempts (default 3), then DEAD
//   NEEDS_HUMAN   a CAPTCHA / OTP / unconfirmed post: never retried by the queue; a person decides
//   dead letters  DEAD entries: a person presses Retry or Discard
//   rate limits   min gap between posts on one portal (30-45 s by default), max per hour and per day per account
//   scheduler     scheduledFor = the entry's first nextRunAt ("publish at 6 pm")
//   switches      kill (global / per portal) and pause-all are checked at every claim
//
// Every function here is a plain async function; nothing starts by itself.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { q, q1, ex, ms, iso, json, newId } = require('./db');
const C = require('./constants');
const S = require('./settings');
const { backoffMs } = require('../playwright/retry');
const L = require('./logs');

const PUBLISH_LIKE = ['PUBLISH', 'REPUBLISH', 'UPDATE'];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function shape(r) {
  if (!r) return null;
  const result = json(r.resultJson, null);
  return {
    id: r.id, requirementId: r.requirementId, portal: r.portal, portalName: C.portalName(r.portal), action: r.action,
    status: r.status, statusWords: C.QUEUE_WORDS[r.status] || r.status,
    attempts: r.attempts, maxAttempts: r.maxAttempts,
    nextRunAt: iso(r.nextRunAt), scheduledFor: iso(r.scheduledFor), lockedBy: r.lockedBy || null, lockedAt: iso(r.lockedAt),
    startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), dryRun: !!r.dryRun, batchId: r.batchId || null,
    requestedBy: r.requestedBy || null, requestedByName: r.requestedByName || null,
    errorCode: r.errorCode || null, errorMessage: r.errorMessage || null, retryable: !!r.retryable,
    payloadHash: r.payloadHash || null,
    result: result ? { portalJobId: result.portalJobId || null, portalUrl: result.portalUrl || null, dryRun: !!result.dryRun, verified: !!result.verified, note: result.note || null, apiStatus: result.apiStatus || null } : null,
    // 'Needs your help' while the run is open and waiting for a person's OTP (never the port or any code), and what a person must do after a CAPTCHA etc.
    waiting: r.status === 'RUNNING' && result && result.waiting ? { kind: result.waiting.kind, reason: result.waiting.reason, since: result.waiting.since, until: result.waiting.until } : null,
    help: result && result.help ? result.help : null,
    screenshots: result && Array.isArray(result.screenshots) ? result.screenshots.length : 0,
    selectorDrift: result && result.selectorDrift ? result.selectorDrift : 0,
    createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  };
}

const byId = async (id) => q1('SELECT * FROM "PostingQueue" WHERE "id" = ?', id);

// ---------------------------------------------------------------------------
// ENQUEUE
// ---------------------------------------------------------------------------
// -> { entry, created, duplicate }
async function enqueue(o) {
  const {
    requirementId = null, portal, action, payloadHash = null, requestedBy = null, requestedByName = null, dryRun = false,
    scheduledFor = null, batchId = null, idempotencyKey = null, maxAttempts = null,
  } = o;
  if (!portal || !C.ACTIONS.includes(action)) throw new Error('enqueue: portal and a valid action are required');
  const now = Date.now();
  const lim = await S.limits(portal);
  const max = Number(maxAttempts) > 0 ? Number(maxAttempts) : lim.maxAttempts;
  const when = ms(scheduledFor);
  const nextRunAt = when && when > now ? when : now;

  // 1. the caller's own key: the same key is the same request, always.
  let key;
  if (idempotencyKey) {
    key = `ext:${String(idempotencyKey).slice(0, 120)}:${requirementId || '-'}:${portal}:${action}`;
    const hit = await q1('SELECT * FROM "PostingQueue" WHERE "idempotencyKey" = ?', key);
    if (hit) return { entry: shape(hit), created: false, duplicate: true };
  }
  // 2. the same job + portal + action + content already waiting or running: that IS this request.
  const base = `${requirementId || '-'}:${portal}:${action}:${payloadHash || '-'}:${dryRun ? 'dry' : 'live'}`;
  const inFlight = await q1(
    'SELECT * FROM "PostingQueue" WHERE "requirementId" IS ? AND "portal" = ? AND "action" = ? AND "dryRun" = ? AND "status" IN (\'QUEUED\',\'RUNNING\') ORDER BY "createdAt" DESC LIMIT 1',
    requirementId, portal, action, dryRun ? 1 : 0,
  );
  if (inFlight && (inFlight.payloadHash || null) === (payloadHash || null)) return { entry: shape(inFlight), created: false, duplicate: true };
  // 3. a new key (the n-th time this exact request is made; each one is its own entry)
  if (!key) {
    const seq = ((await q1('SELECT COUNT(*) n FROM "PostingQueue" WHERE "idempotencyKey" LIKE ?', `${base}:%`)) || {}).n || 0;
    key = `${base}:${seq}`;
  }
  const id = newId('pq');
  try {
    await ex(
      `INSERT INTO "PostingQueue" ("id","requirementId","portal","action","status","attempts","maxAttempts","nextRunAt","scheduledFor","payloadHash","idempotencyKey","dryRun","batchId","requestedBy","requestedByName","createdBy","updatedBy","createdAt","updatedAt")
       VALUES (?,?,?,?, 'QUEUED', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, requirementId, portal, action, max, nextRunAt, when && when > now ? when : null, payloadHash, key, dryRun ? 1 : 0, batchId,
      requestedBy, requestedByName, requestedBy, requestedBy, now, now,
    );
  } catch (err) {
    // two requests raced to the same key: the second one gets the first one's entry
    if (/unique|constraint/i.test(String(err && err.message))) {
      const again = await q1('SELECT * FROM "PostingQueue" WHERE "idempotencyKey" = ?', key);
      if (again) return { entry: shape(again), created: false, duplicate: true };
    }
    throw err;
  }
  await L.write({ queueId: id, requirementId, portal, step: 'queued', message: `${action}${dryRun ? ' (dry run)' : ''} queued${when && when > now ? ` for ${new Date(when).toISOString()}` : ''}` });
  return { entry: shape(await byId(id)), created: true, duplicate: false };
}

// ---------------------------------------------------------------------------
// RATE LIMITS (per portal / per account)
// ---------------------------------------------------------------------------
async function accountLimits(portal) {
  return (await q1('SELECT "dailyLimit","hourlyLimit","minGapSeconds" FROM "PortalCredential" WHERE "portal" = ? ORDER BY "updatedAt" DESC LIMIT 1', portal)) || {};
}
// -> { ok, waitMs, until, reason }
async function rateCheck(portal, now = Date.now()) {
  const lim = await S.limits(portal);
  const acc = await accountLimits(portal);
  const minGap = acc.minGapSeconds != null ? Number(acc.minGapSeconds) : lim.minGapSeconds;
  const maxGap = Math.max(minGap, lim.maxGapSeconds);
  const perHour = acc.hourlyLimit != null ? Number(acc.hourlyLimit) : lim.perHour;
  const perDay = acc.dailyLimit != null ? Number(acc.dailyLimit) : lim.perDay;
  const acts = "'PUBLISH','REPUBLISH','UPDATE','UNPUBLISH'";
  if (minGap > 0) {
    const last = (await q1(`SELECT MAX(COALESCE("finishedAt","startedAt")) t FROM "PostingQueue" WHERE "portal" = ? AND "action" IN (${acts}) AND "startedAt" IS NOT NULL`, portal)) || {};
    if (last.t) {
      const gap = (minGap + (Math.floor(last.t / 1000) % (maxGap - minGap + 1))) * 1000; // a fixed value inside the window
      if (last.t + gap > now) return { ok: false, waitMs: last.t + gap - now, until: last.t + gap, reason: `At least ${Math.round(gap / 1000)} seconds between two posts on ${C.portalName(portal)}` };
    }
  }
  const liveActs = "'PUBLISH','REPUBLISH','UPDATE'";
  const windows = [[3600000, perHour, 'hour'], [86400000, perDay, 'day']];
  for (const [span, cap, label] of windows) {
    if (!cap || cap <= 0) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const rows = await q(`SELECT "startedAt" t FROM "PostingQueue" WHERE "portal" = ? AND "action" IN (${liveActs}) AND "dryRun" = 0 AND "startedAt" >= ? ORDER BY "startedAt" ASC`, portal, now - span);
    if (rows.length >= cap) {
      const until = rows[rows.length - cap].t + span;
      return { ok: false, waitMs: Math.max(1000, until - now), until, reason: `${C.portalName(portal)} limit reached: ${cap} posts per ${label}` };
    }
  }
  return { ok: true, waitMs: 0 };
}

// ---------------------------------------------------------------------------
// STALE LOCKS
// ---------------------------------------------------------------------------
// A RUNNING entry whose lock is older than staleLockMs lost its worker. If the run had already pressed Submit
// (resultJson.submitStartedAt) it is NOT put back (it may be live): it needs a person. Otherwise it is tried again.
async function recoverStale(now = Date.now(), staleMs = null) {
  const lim = await S.limits(null);
  const cutoff = now - (staleMs || lim.staleLockMs);
  const stale = await q('SELECT * FROM "PostingQueue" WHERE "status" = \'RUNNING\' AND COALESCE("lockedAt",0) < ?', cutoff);
  const out = [];
  for (const r of stale) {
    const submitted = String(r.resultJson || '').includes('"submitStartedAt"');
    let to; let code; let msg;
    if (submitted) { to = 'NEEDS_HUMAN'; code = 'UNVERIFIED'; msg = `The worker stopped just after pressing Submit on ${C.portalName(r.portal)}. Check the site: the requirement may already be live.`; }
    else if (r.attempts >= r.maxAttempts) { to = 'DEAD'; code = 'STALE_LOCK'; msg = 'The worker stopped and all tries are used up.'; }
    else { to = 'QUEUED'; code = 'STALE_LOCK'; msg = 'The worker stopped; the requirement was put back in the queue.'; }
    // eslint-disable-next-line no-await-in-loop
    const n = await ex(
      'UPDATE "PostingQueue" SET "status" = ?, "lockedBy" = NULL, "lockedAt" = NULL, "errorCode" = ?, "errorMessage" = ?, "finishedAt" = ?, "nextRunAt" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = \'RUNNING\' AND COALESCE("lockedAt",0) < ?',
      to, code, msg, to === 'QUEUED' ? null : now, now, now, r.id, cutoff,
    );
    if (n) {
      out.push({ id: r.id, to });
      // eslint-disable-next-line no-await-in-loop
      await L.write({ queueId: r.id, requirementId: r.requirementId, portal: r.portal, step: 'stale-lock', level: 'WARN', message: `Stale lock recovered (worker ${r.lockedBy || '?'}): ${to}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLAIM: one atomic statement
// ---------------------------------------------------------------------------
// -> { entry, blocked: [{ portal, reason, until }] }   entry = null when nothing may start now
async function claim({ workerId, now = Date.now(), onlyPortals = null } = {}) {
  const lim = await S.limits(null);
  await recoverStale(now);
  const due = await q('SELECT DISTINCT "portal" FROM "PostingQueue" WHERE "status" = \'QUEUED\' AND "nextRunAt" <= ?', now);
  const blocked = [];
  const skip = [];
  for (const { portal } of due) {
    if (onlyPortals && !onlyPortals.includes(portal)) { skip.push(portal); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const ks = await S.killState(portal);
    if (ks.stopped) { blocked.push({ portal, reason: ks.reason, until: null, kind: ks.paused ? 'pause' : 'kill' }); skip.push(portal); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const hold = await S.humanHold(portal);
    if (hold) { blocked.push({ portal, reason: `${C.portalName(portal)} needs a person: ${hold.reason || 'open the portal session'}`, until: null, kind: 'human' }); skip.push(portal); continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const rc = await rateCheck(portal, now);
    if (!rc.ok) { blocked.push({ portal, reason: rc.reason, until: iso(rc.until), kind: 'rate' }); skip.push(portal); }
  }
  const staleCut = now - lim.staleLockMs;
  const notIn = skip.length ? `AND qq."portal" NOT IN (${skip.map(() => '?').join(',')})` : '';
  const rows = await q(
    `UPDATE "PostingQueue" SET "status" = 'RUNNING', "lockedBy" = ?, "lockedAt" = ?, "startedAt" = ?, "attempts" = "attempts" + 1, "errorCode" = NULL, "errorMessage" = NULL, "finishedAt" = NULL, "updatedAt" = ?
     WHERE "id" = (
       SELECT qq."id" FROM "PostingQueue" qq
       WHERE qq."status" = 'QUEUED' AND qq."nextRunAt" <= ? ${notIn}
         AND NOT EXISTS (SELECT 1 FROM "PostingQueue" r WHERE r."status" = 'RUNNING' AND r."portal" = qq."portal" AND COALESCE(r."lockedAt",0) >= ?)
         AND (SELECT COUNT(*) FROM "PostingQueue" r2 WHERE r2."status" = 'RUNNING' AND COALESCE(r2."lockedAt",0) >= ?) < ?
       ORDER BY CASE qq."action" WHEN 'VERIFY' THEN 0 WHEN 'UNPUBLISH' THEN 1 ELSE 2 END, qq."nextRunAt" ASC, qq."createdAt" ASC
       LIMIT 1)
     AND "status" = 'QUEUED'
     RETURNING *`,
    workerId, now, now, now, now, ...skip, staleCut, staleCut, lim.globalConcurrency,
  );
  if (!rows.length) return { entry: null, blocked };
  return { entry: rows[0], blocked };
}

async function heartbeat(id, workerId, now = Date.now()) {
  return ex('UPDATE "PostingQueue" SET "lockedAt" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = \'RUNNING\' AND "lockedBy" = ?', now, now, id, workerId);
}
// The run pressed Submit: from here the entry is never put back automatically (it may be live).
async function markSubmitStarted(id, workerId) {
  const row = await byId(id);
  const res = json(row && row.resultJson, {}) || {};
  res.submitStartedAt = new Date().toISOString();
  return ex('UPDATE "PostingQueue" SET "resultJson" = ?, "updatedAt" = ? WHERE "id" = ? AND "lockedBy" = ?', JSON.stringify(res), Date.now(), id, workerId);
}

// The run is open and waits for a person (OTP). Only the run that holds the lock may write it. `info` holds no secret.
async function setWaiting(id, workerId, info) {
  const row = await byId(id);
  const res = json(row && row.resultJson, {}) || {};
  res.waiting = info;
  return ex('UPDATE "PostingQueue" SET "resultJson" = ?, "updatedAt" = ? WHERE "id" = ? AND "lockedBy" = ?', JSON.stringify(res), Date.now(), id, workerId);
}
async function clearWaiting(id, workerId) {
  const row = await byId(id);
  const res = json(row && row.resultJson, {}) || {};
  if (!res.waiting) return 0;
  delete res.waiting;
  return ex('UPDATE "PostingQueue" SET "resultJson" = ?, "updatedAt" = ? WHERE "id" = ? AND "lockedBy" = ?', JSON.stringify(res), Date.now(), id, workerId);
}
// Add facts about this attempt (pictures, selector drift) to the entry's result, whatever the outcome.
async function noteResult(id, workerId, patch) {
  const row = await byId(id);
  const res = { ...((json(row && row.resultJson, {}) || {})), ...patch };
  return ex('UPDATE "PostingQueue" SET "resultJson" = ?, "updatedAt" = ? WHERE "id" = ? AND "lockedBy" = ?', JSON.stringify(res), Date.now(), id, workerId);
}

// ---------------------------------------------------------------------------
// FINISH (every writer is fenced on lockedBy, so a recovered / duplicate worker cannot overwrite a newer state)
// ---------------------------------------------------------------------------
async function finish(id, workerId, status, f = {}) {
  const now = Date.now();
  const row = await byId(id);
  const prev = json(row && row.resultJson, {}) || {};
  const result = f.result ? { ...prev, ...f.result } : prev;
  delete result.waiting; // an open OTP wait never outlives the run
  const n = await ex(
    'UPDATE "PostingQueue" SET "status" = ?, "finishedAt" = ?, "lockedBy" = NULL, "lockedAt" = NULL, "errorCode" = ?, "errorMessage" = ?, "retryable" = ?, "resultJson" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = \'RUNNING\' AND "lockedBy" = ?',
    status, now, f.errorCode || null, f.errorMessage ? String(f.errorMessage).slice(0, 500) : null, f.retryable ? 1 : 0, Object.keys(result).length ? JSON.stringify(result) : null, now, id, workerId,
  );
  return !!n;
}
const succeed = (id, workerId, result) => finish(id, workerId, 'SUCCEEDED', { result });
const needsHuman = (id, workerId, { code, message, result }) => finish(id, workerId, 'NEEDS_HUMAN', { errorCode: code, errorMessage: message, result });

// A failed run: back to QUEUED with backoff while tries remain (and the failure is retryable), else DEAD / FAILED.
// -> 'QUEUED' | 'DEAD' | 'FAILED' | null (lost the lock)
async function fail(id, workerId, { code, message, retryable, result }) {
  const row = await byId(id);
  if (!row || row.status !== 'RUNNING' || row.lockedBy !== workerId) return null;
  const now = Date.now();
  if (retryable && row.attempts < row.maxAttempts) {
    const wait = backoffMs(row.attempts);
    const n = await ex(
      'UPDATE "PostingQueue" SET "status" = \'QUEUED\', "nextRunAt" = ?, "lockedBy" = NULL, "lockedAt" = NULL, "errorCode" = ?, "errorMessage" = ?, "retryable" = 1, "updatedAt" = ? WHERE "id" = ? AND "status" = \'RUNNING\' AND "lockedBy" = ?',
      now + wait, code || null, String(message || '').slice(0, 500), now, id, workerId,
    );
    if (n) await L.write({ queueId: id, requirementId: row.requirementId, portal: row.portal, step: 'retry', level: 'WARN', message: `Try ${row.attempts} of ${row.maxAttempts} failed (${code}); next try in ${Math.round(wait / 1000)} s` });
    return n ? 'QUEUED' : null;
  }
  const to = retryable ? 'DEAD' : 'FAILED';
  const ok = await finish(id, workerId, to, { errorCode: code, errorMessage: message, retryable: false, result });
  if (ok) await L.write({ queueId: id, requirementId: row.requirementId, portal: row.portal, step: to === 'DEAD' ? 'dead-letter' : 'failed', level: 'ERROR', message: `${to === 'DEAD' ? `Gave up after ${row.attempts} tries` : 'Failed, not retried'}: ${message}` });
  return ok ? to : null;
}
// Put it back without using up a try (a kill / pause / rate wait / worker shutdown).
async function release(id, workerId, { reason, delayMs = 0 } = {}) {
  const now = Date.now();
  const n = await ex(
    'UPDATE "PostingQueue" SET "status" = \'QUEUED\', "attempts" = MAX(0, "attempts" - 1), "nextRunAt" = ?, "lockedBy" = NULL, "lockedAt" = NULL, "updatedAt" = ? WHERE "id" = ? AND "status" = \'RUNNING\' AND "lockedBy" = ?',
    now + delayMs, now, id, workerId,
  );
  if (n && reason) { const row = await byId(id); await L.write({ queueId: id, requirementId: row && row.requirementId, portal: row && row.portal, step: 'released', level: 'WARN', message: reason }); }
  return !!n;
}

// ---------------------------------------------------------------------------
// PEOPLE'S COMMANDS
// ---------------------------------------------------------------------------
// Retry: FAILED / DEAD / NEEDS_HUMAN / CANCELLED go back to QUEUED with a fresh set of tries.
async function retryEntry(id, user) {
  const row = await byId(id);
  if (!row) return { error: 'No such queue entry', status: 404 };
  if (!['FAILED', 'DEAD', 'NEEDS_HUMAN', 'CANCELLED'].includes(row.status)) return { error: `This entry is ${(C.QUEUE_WORDS[row.status] || row.status).toLowerCase()}: nothing to retry.`, status: 409 };
  const now = Date.now();
  await ex(
    'UPDATE "PostingQueue" SET "status" = \'QUEUED\', "attempts" = 0, "nextRunAt" = ?, "lockedBy" = NULL, "lockedAt" = NULL, "finishedAt" = NULL, "errorCode" = NULL, "errorMessage" = NULL, "retryable" = 0, "updatedBy" = ?, "updatedAt" = ? WHERE "id" = ?',
    now, user ? user.id : null, now, id,
  );
  await L.write({ queueId: id, requirementId: row.requirementId, portal: row.portal, step: 'retry-requested', message: `Retry pressed${user ? ` by ${user.name}` : ''} (was ${row.status})` });
  return { entry: shape(await byId(id)), was: row };
}
// Cancel: only an entry that has not started (QUEUED) or one that waits for a person.
async function cancelEntry(id, user, why = 'Cancelled') {
  const row = await byId(id);
  if (!row) return { error: 'No such queue entry', status: 404 };
  if (!['QUEUED', 'NEEDS_HUMAN'].includes(row.status)) {
    return { error: row.status === 'RUNNING' ? 'It is posting right now. It cannot be cancelled until it stops.' : `This entry is ${(C.QUEUE_WORDS[row.status] || row.status).toLowerCase()}: nothing to cancel.`, status: 409 };
  }
  const now = Date.now();
  const n = await ex(
    'UPDATE "PostingQueue" SET "status" = \'CANCELLED\', "finishedAt" = ?, "errorCode" = \'CANCELLED\', "errorMessage" = ?, "updatedBy" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" IN (\'QUEUED\',\'NEEDS_HUMAN\')',
    now, `${why}${user ? ` by ${user.name}` : ''}`, user ? user.id : null, now, id,
  );
  if (!n) return { error: 'It just started, so it cannot be cancelled.', status: 409 };
  await L.write({ queueId: id, requirementId: row.requirementId, portal: row.portal, step: 'cancelled', message: `${why}${user ? ` by ${user.name}` : ''}` });
  return { entry: shape(await byId(id)), was: row };
}
// Discard: a dead letter (or a failed / waiting entry) is closed for good. The row stays for the history.
async function discardEntry(id, user) {
  const row = await byId(id);
  if (!row) return { error: 'No such queue entry', status: 404 };
  if (!['DEAD', 'FAILED', 'NEEDS_HUMAN', 'CANCELLED'].includes(row.status)) return { error: `This entry is ${(C.QUEUE_WORDS[row.status] || row.status).toLowerCase()}: it cannot be discarded.`, status: 409 };
  const now = Date.now();
  await ex(
    'UPDATE "PostingQueue" SET "status" = \'CANCELLED\', "errorCode" = \'DISCARDED\', "errorMessage" = ?, "finishedAt" = COALESCE("finishedAt", ?), "updatedBy" = ?, "updatedAt" = ? WHERE "id" = ?',
    `Discarded${user ? ` by ${user.name}` : ''}`, now, user ? user.id : null, now, id,
  );
  await L.write({ queueId: id, requirementId: row.requirementId, portal: row.portal, step: 'discarded', message: `Discarded${user ? ` by ${user.name}` : ''} (was ${row.status})` });
  return { entry: shape(await byId(id)), was: row };
}

// ---------------------------------------------------------------------------
// READING
// ---------------------------------------------------------------------------
// filters: status, portal, requirementId, requirementIds (scope), batchId, action, from, to, page, pageSize, search
async function list(f = {}) {
  const where = []; const p = [];
  const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (f.status) { const a = arr(f.status); where.push(`"status" IN (${a.map(() => '?').join(',')})`); p.push(...a); }
  if (f.portal) { const a = arr(f.portal); where.push(`"portal" IN (${a.map(() => '?').join(',')})`); p.push(...a); }
  if (f.action) { const a = arr(f.action); where.push(`"action" IN (${a.map(() => '?').join(',')})`); p.push(...a); }
  if (f.requirementId) { where.push('"requirementId" = ?'); p.push(f.requirementId); }
  if (f.batchId) { where.push('"batchId" = ?'); p.push(f.batchId); }
  if (f.from) { where.push('"createdAt" >= ?'); p.push(ms(f.from)); }
  if (f.to) { where.push('"createdAt" <= ?'); p.push(ms(f.to)); }
  if (Array.isArray(f.requirementIds)) {
    if (!f.requirementIds.length) return { rows: [], total: 0, page: 1, pageSize: Number(f.pageSize) || 25 };
    where.push(`"requirementId" IN (${f.requirementIds.map(() => '?').join(',')})`); p.push(...f.requirementIds);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(200, Math.max(1, Number(f.pageSize) || 25));
  const page = Math.max(1, Number(f.page) || 1);
  const total = ((await q1(`SELECT COUNT(*) n FROM "PostingQueue" ${w}`, ...p)) || {}).n || 0;
  const rows = await q(`SELECT * FROM "PostingQueue" ${w} ORDER BY "createdAt" DESC, "id" DESC LIMIT ? OFFSET ?`, ...p, pageSize, (page - 1) * pageSize);
  return { total, page, pageSize, rows: rows.map(shape) };
}

async function counts() {
  const rows = await q('SELECT "status", COUNT(*) n FROM "PostingQueue" GROUP BY "status"');
  const out = Object.fromEntries(C.QUEUE_STATUS.map((s) => [s, 0]));
  rows.forEach((r) => { out[r.status] = r.n; });
  return out;
}

module.exports = {
  shape, byId, enqueue, claim, heartbeat, markSubmitStarted, setWaiting, clearWaiting, noteResult, succeed, needsHuman, fail, release, finish, recoverStale, rateCheck,
  retryEntry, cancelEntry, discardEntry, list, counts, PUBLISH_LIKE, sha,
};
