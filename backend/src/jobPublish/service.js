// ---------------------------------------------------------------------------
// JOB PUBLISHING SERVICE: what the API does. publish / republish / unpublish / update / bulk, status, dashboard,
// queue commands. Every command is audited (who, job, portal, outcome; never a secret).
// A portal that cannot be automated NEVER gets a queue entry: it gets (or keeps) the by-hand task instead.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const agreementPrivacy = require('../utils/agreementPrivacy');
const { requirementIsLive } = require('../utils/atsVocab');
const scope = require('../utils/scope');
const C = require('./constants');
const Q = require('./queue');
const S = require('./settings');
const P = require('./portalPosting');
const Cred = require('./credentials');
const Map_ = require('./mappings');
const bridge = require('./legacyBridge');
const jobPayload = require('./jobPayload');
const access = require('./access');
const cfgLib = require('../portals/config');
const guards = require('./guards');
const browserLib = require('../playwright/browser');
const {
  q, q1, ex, ms, iso, newId, supported,
} = require('./db');
const L = require('./logs');

const day = 86400000;
const audit = (user, action, requirementId, portal, detail) => logAudit({
  userId: user ? user.id : null, actorName: user ? user.name : null, action, entity: 'JobPublish', entityId: requirementId || portal,
  fromValue: portal ? C.portalName(portal) : null, toValue: String(detail || '').slice(0, 400),
});

function holdWords(user, r) {
  return agreementPrivacy.blindTo(user) ? agreementPrivacy.HOLD_MESSAGE : `This requirement is ${String(r.status).toLowerCase().replace(/_/g, ' ')}, so it cannot be posted yet.`;
}

// One portal for one job. -> a result row for the screen
async function one(user, r, portal, action, o) {
  const name = C.portalName(portal);
  const base = { portal, name, action };
  const meta = C.PORTALS[portal];
  if (!meta) return { ...base, ok: false, mode: 'refused', reason: `Unknown portal "${portal}".` };
  const kill = await S.killState(portal);
  if (kill.abort || kill.paused) return { ...base, ok: false, mode: 'refused', reason: `${kill.reason}. Nothing was queued.` };
  const posting = await P.get(r.id, portal);
  if (action !== 'UNPUBLISH' && !requirementIsLive(r.status)) return { ...base, ok: false, mode: 'refused', reason: holdWords(user, r) };
  if (r.internal && portal !== 'career' && action !== 'UNPUBLISH') return { ...base, ok: false, mode: 'refused', reason: 'TeamLink internal hiring stays on the career page.' };
  if (meta.kind === 'manual') {
    await bridge.ensureHandTask(portal, r.id, meta.note);
    return { ...base, ok: true, queued: false, mode: 'by_hand', reason: `${name} forbids automation: post by hand. A by-hand task keeps the requirement.`, handPath: bridge.handPath(portal, r.id) };
  }
  if (meta.kind === 'browser') {
    const c = await Cred.read(portal);
    const handReason = !c.ok ? `No ${name} login is saved.` : !c.enabled ? `Automatic posting to ${name} is switched off.` : c.status === 'FAILED' ? `The last sign-in to ${name} failed.` : null;
    if (handReason && !o.dryRun) {
      await bridge.ensureHandTask(portal, r.id, handReason);
      return { ...base, ok: true, queued: false, mode: 'by_hand', reason: `${handReason} A by-hand task was created instead.`, handPath: bridge.handPath(portal, r.id) };
    }
    if (handReason && o.dryRun) return { ...base, ok: false, mode: 'refused', reason: handReason };
    const cfg = await cfgLib.load(portal);
    if (!cfg.ok) return { ...base, ok: false, mode: 'refused', reason: `The ${name} page settings are not valid: ${cfg.problems.join('; ')}.` };
    // the real-posting gate: a REAL post needs TL_ALLOW_REAL_POSTING=1 on the worker computer AND verified page settings (a Dry run does not)
    const gate = guards.realPostingGate({ strict: browserLib.strictLocal(cfg.cfg), verified: !!cfg.verified, action, dryRun: !!o.dryRun });
    if (gate) {
      if (['PUBLISH', 'REPUBLISH', 'UPDATE'].includes(action)) {
        await bridge.ensureHandTask(portal, r.id, C.ERRORS[gate].words);
        return { ...base, ok: true, queued: false, mode: 'by_hand', gate, reason: `${C.ERRORS[gate].words} A by-hand task was created instead.`, handPath: bridge.handPath(portal, r.id) };
      }
      return { ...base, ok: false, mode: 'refused', gate, reason: C.ERRORS[gate].words };
    }
  }
  if (meta.kind === 'api') {
    // Telegram / Facebook: official API with a token. Nothing is sent unless an Admin saved the details AND switched the channel ON (a Dry run needs neither).
    if (!o.dryRun) {
      const c = await Cred.read(portal);
      if (!c.ok) return { ...base, ok: false, mode: 'refused', reason: `No ${name} details are saved yet. An Admin saves them under Integrations, Job portals.` };
      if (!c.enabled) return { ...base, ok: false, mode: 'refused', reason: `Posting to ${name} is switched off. An Admin switches it on in Integrations, Job portals. A Dry run still works.` };
      if (c.status === 'FAILED') return { ...base, ok: false, mode: 'refused', reason: `The last check of the ${name} token failed. An Admin saves a new one.` };
      // ONE post per job per channel: the same job is never posted twice; a change goes out only through "Post update".
      if (['PUBLISH', 'REPUBLISH'].includes(action) && posting && posting.status === 'PUBLISHED') {
        return { ...base, ok: true, queued: false, mode: 'already', reason: `Already posted on ${name}. Use "Post update" to change the message there.`, posting: P.view(posting) };
      }
    }
  }
  let hash = null;
  if (['PUBLISH', 'REPUBLISH', 'UPDATE'].includes(action)) {
    const built = await jobPayload.build(r.id, portal);
    if (!built.ok) return { ...base, ok: false, mode: 'refused', reason: built.blocked };
    if (built.missing.length) return { ...base, ok: false, mode: 'refused', reason: `Fill these in on the requirement first: ${built.missing.map((m) => m.label).join(', ')}.`, missing: built.missing };
    hash = built.hash;
    if (meta.kind === 'api') {
      const kit = await require('../jobDist/text').forPlatform(r.id, portal, { base: process.env.APP_BASE_URL || '' }); // eslint-disable-line global-require
      if (!kit) return { ...base, ok: false, mode: 'refused', reason: 'The message could not be built.' };
      if (kit.over) return { ...base, ok: false, mode: 'refused', reason: `The message is ${kit.chars} characters; ${name} allows ${kit.limit}. Shorten it on the Distribute tab.` };
      hash = require('../jobDist/text').hash(kit.text); // eslint-disable-line global-require
    }
    if (action === 'PUBLISH' && !o.dryRun && posting && posting.status === 'PUBLISHED' && posting.payloadHash === hash) {
      return { ...base, ok: true, queued: false, mode: 'already', reason: `Already live on ${name}. Use Republish to post it again.`, posting: P.view(posting) };
    }
    if ((action === 'UPDATE') && !(posting && posting.status === 'PUBLISHED')) return { ...base, ok: false, mode: 'refused', reason: `It is not live on ${name}, so there is nothing to update. Publish it.` };
  }
  if (action === 'UNPUBLISH' && !(posting && ['PUBLISHED', 'NEEDS_CHECK'].includes(posting.status))) {
    return { ...base, ok: true, queued: false, mode: 'nothing', reason: `It is not live on ${name}: nothing to take down.` };
  }
  const out = await Q.enqueue({
    requirementId: r.id, portal, action, payloadHash: hash || (posting && posting.portalJobId) || null, requestedBy: user.id, requestedByName: user.name,
    dryRun: !!o.dryRun, scheduledFor: o.scheduledFor || null, batchId: o.batchId || null, idempotencyKey: o.idempotencyKey ? `${o.idempotencyKey}` : null,
  });
  if (out.created && !o.dryRun) await P.set(r.id, portal, { status: 'QUEUED', lastQueueId: out.entry.id, lastAction: action, lastError: null }, user.id);
  if (out.created) await audit(user, `${action[0]}${action.slice(1).toLowerCase()} queued${o.dryRun ? ' (dry run)' : ''}`, r.id, portal, `queue ${out.entry.id}${o.scheduledFor ? ` at ${iso(o.scheduledFor)}` : ''}`);
  let entry = out.entry;
  // The career page needs no browser: it is done at once (a person pressed the button)
  if (out.created && portal === 'career' && !o.scheduledFor && process.env.TL_POSTING_NO_INLINE !== '1') entry = await runInline(entry.id);
  const hold = await S.humanHold(portal);
  return {
    ...base, ok: true, queued: true, duplicate: out.duplicate, mode: 'queued', queueId: entry.id, entry,
    reason: hold ? `Queued, but ${name} is waiting for a person (${hold.reason || 'open the portal session'}).` : (out.duplicate ? 'It is already waiting in the queue.' : 'Queued.'),
  };
}

// Run one entry here (career page, or when TL_POSTING_INLINE=1 for a credential check). Never for a browser portal otherwise.
async function runInline(queueId) {
  const runner = require('./runner'); // eslint-disable-line global-require
  const workerId = `api-inline-${process.pid}`;
  const now = Date.now();
  const n = await ex('UPDATE "PostingQueue" SET "status"=\'RUNNING\',"lockedBy"=?,"lockedAt"=?,"startedAt"=?,"attempts"="attempts"+1,"updatedAt"=? WHERE "id"=? AND "status"=\'QUEUED\'', workerId, now, now, now, queueId);
  if (!n) return Q.shape(await Q.byId(queueId));
  await runner.processEntry(await Q.byId(queueId), { workerId, inline: true });
  return Q.shape(await Q.byId(queueId));
}

async function doJob(user, requirementId, portals, action, o = {}) {
  const r = await prisma.requirement.findUnique({ where: { id: requirementId } });
  if (!r) return { error: 'Requirement not found', status: 404 };
  if (!access.inScope(user, r)) return { error: 'This requirement is not in your area.', status: 403 };
  if (!(await access.mayPost(user, r))) return { error: 'Posting requirements is done by your team lead or the client manager.', code: 'POSTING_NOT_YOURS', status: 403 };
  const list = [...new Set((portals && portals.length ? portals : []).map(String))];
  if (!list.length) return { error: 'Choose at least one site.', status: 400 };
  const bad = list.filter((p) => !C.PORTALS[p]);
  if (bad.length) return { error: `Unknown site: ${bad.join(', ')}.`, status: 400 };
  if (o.scheduledFor && (ms(o.scheduledFor) == null)) return { error: 'The date to post at is not a valid date.', status: 400 };
  const results = [];
  for (const p of list) results.push(await one(user, r, p, action, o)); // eslint-disable-line no-await-in-loop
  return { requirementId, action, results, queued: results.filter((x) => x.queued).length };
}

const publish = (u, id, portals, o) => doJob(u, id, portals, 'PUBLISH', o);
const republish = (u, id, portals, o) => doJob(u, id, portals, 'REPUBLISH', o);
const unpublish = (u, id, portals, o) => doJob(u, id, portals, 'UNPUBLISH', o);
const update = (u, id, portals, o) => doJob(u, id, portals, 'UPDATE', o);

async function bulk(user, jobIds, portals, o = {}) {
  const ids = [...new Set((jobIds || []).map(String))];
  if (!ids.length) return { error: 'Choose at least one requirement.', status: 400 };
  if (ids.length > 100) return { error: 'Choose at most 100 requirements at a time.', status: 400 };
  const batchId = newId('bt');
  const jobs = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const out = await doJob(user, id, portals, o.action || 'PUBLISH', { ...o, batchId, idempotencyKey: o.idempotencyKey ? `${o.idempotencyKey}:${id}` : null });
    jobs.push(out.error ? { requirementId: id, ok: false, reason: out.error, code: out.code || null } : { requirementId: id, ok: true, results: out.results, queued: out.queued });
  }
  const queued = jobs.reduce((n, j) => n + (j.queued || 0), 0);
  await audit(user, 'Bulk publish', null, null, `${ids.length} requirements x ${(portals || []).length} sites: ${queued} queued (batch ${batchId})`);
  return { batchId, jobs, summary: { jobs: ids.length, queued, refused: jobs.filter((j) => !j.ok).length } };
}

// ---- status of one job, portal by portal
async function jobStatus(user, r) {
  const canLogs = access.mayViewLogs(user);
  const posts = await P.forJob(r.id);
  const recent = await q('SELECT * FROM "PostingQueue" WHERE "requirementId" = ? ORDER BY "createdAt" DESC LIMIT 60', r.id);
  const rows = [];
  for (const portal of C.PORTAL_KEYS) {
    const meta = C.PORTALS[portal];
    const post = posts.find((x) => x.portal === portal);
    const last = recent.find((x) => x.portal === portal);
    const hold = await S.humanHold(portal);
    const logs = canLogs && last ? (await L.list({ queueId: last.id, pageSize: 8 })).rows : [];
    const v = post ? P.view(post) : { portal, portalName: meta.name, status: 'DRAFT', statusWords: C.PORTAL_WORDS.DRAFT, portalJobId: null, portalUrl: null };
    rows.push({
      ...v,
      mode: meta.kind === 'manual' ? 'manual' : 'auto',
      lastQueue: last ? Q.shape(last) : null,
      waitingForPerson: !!(hold && last && ['QUEUED', 'NEEDS_HUMAN'].includes(last.status)),
      byHand: bridge.legacyOf(portal) ? { path: bridge.handPath(portal, r.id) } : null,
      canRetry: !!(last && ['FAILED', 'DEAD', 'NEEDS_HUMAN'].includes(last.status)),
      logs: canLogs ? logs : undefined,
    });
  }
  return { requirementId: r.id, reqCode: r.reqCode || null, title: r.title, live: requirementIsLive(r.status), portals: rows, canPost: await access.mayPost(user, r), canViewLogs: canLogs };
}

// ---- dashboard
async function dashboard(user) {
  const ids = await access.scopedIds(user);
  const inList = (col) => (ids ? `${col} IN (${ids.length ? ids.map(() => '?').join(',') : "'__none__'"})` : '1=1');
  const p = ids || [];
  const live = require('../utils/atsVocab').REQUIREMENT_LIVE_STATUSES;
  const jobsWhere = { ...(ids ? { id: { in: ids } } : {}) };
  const total = await prisma.requirement.count({ where: jobsWhere });
  const liveJobs = await prisma.requirement.count({ where: { ...jobsWhere, status: { in: live } } });
  const byStatus = await q(`SELECT "status", COUNT(DISTINCT "requirementId") n FROM "PortalPosting" WHERE ${inList('"requirementId"')} GROUP BY "status"`, ...p);
  const n = (s) => (byStatus.find((x) => x.status === s) || {}).n || 0;
  const published = ((await q1(`SELECT COUNT(DISTINCT "requirementId") n FROM "PortalPosting" WHERE "status"='PUBLISHED' AND ${inList('"requirementId"')}`, ...p)) || {}).n || 0;
  const everPosted = ((await q1(`SELECT COUNT(DISTINCT "requirementId") n FROM "PortalPosting" WHERE ${inList('"requirementId"')}`, ...p)) || {}).n || 0;
  const perPortal = await q(`SELECT "portal", "status", COUNT(*) n FROM "PortalPosting" WHERE ${inList('"requirementId"')} GROUP BY "portal","status"`, ...p);
  const since = Date.now() - 6 * day;
  const trend = await q(`SELECT "createdAt" t, "status" s FROM "PostingQueue" WHERE "createdAt" >= ? AND ${inList('"requirementId"')} AND "action" != 'VERIFY'`, since - day, ...p);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.now() - (6 - i) * day); d.setHours(0, 0, 0, 0); return d; });
  const trendOut = days.map((d) => {
    const from = d.getTime(); const to = from + day;
    const rows = trend.filter((x) => x.t >= from && x.t < to);
    return { date: d.toISOString().slice(0, 10), queued: rows.length, succeeded: rows.filter((x) => x.s === 'SUCCEEDED').length, failed: rows.filter((x) => ['FAILED', 'DEAD'].includes(x.s)).length, needsHuman: rows.filter((x) => x.s === 'NEEDS_HUMAN').length };
  });
  const qc = await q(`SELECT "status", COUNT(*) n FROM "PostingQueue" WHERE ${inList('"requirementId"')} GROUP BY "status"`, ...p);
  const qn = (s) => (qc.find((x) => x.status === s) || {}).n || 0;
  return {
    totals: {
      totalJobs: total, liveJobs, published, pendingQueued: qn('QUEUED') + qn('RUNNING'), failed: n('FAILED'), needsHuman: n('NEEDS_CHECK') + qn('NEEDS_HUMAN') - 0, draft: Math.max(0, liveJobs - everPosted),
    },
    queue: Object.fromEntries(C.QUEUE_STATUS.map((s) => [s, qn(s)])),
    portals: C.PORTAL_KEYS.map((k) => ({ portal: k, name: C.portalName(k), ...Object.fromEntries(C.PORTAL_STATUS.map((s) => [s, (perPortal.find((x) => x.portal === k && x.status === s) || {}).n || 0])) })),
    trend: trendOut,
  };
}

// ---- queue commands (post rights on the job; an Admin for a credential check)
async function command(user, id, kind) {
  const row = await Q.byId(id);
  if (!row) return { error: 'No such queue entry', status: 404 };
  if (row.requirementId) {
    const r = await prisma.requirement.findUnique({ where: { id: row.requirementId } });
    if (!r || !access.inScope(user, r)) return { error: 'This requirement is not in your area.', status: 403 };
    if (!(await access.mayPost(user, r))) return { error: 'Posting requirements is done by your team lead or the client manager.', code: 'POSTING_NOT_YOURS', status: 403 };
  } else if (!(await access.isCredentialAdmin(user))) return { error: 'Only an Admin can do this.', status: 403 };
  const out = await Q[`${kind}Entry`](id, user);
  if (out.error) return out;
  // "I did it, try again": the person who pressed Retry on a "needs a person" entry lifts that site's hold (they chose to).
  if (kind === 'retry' && row.status === 'NEEDS_HUMAN') {
    const hold = await S.humanHold(row.portal);
    if (hold && (!hold.queueId || hold.queueId === id)) await S.clearHumanHold(row.portal);
  }
  await audit(user, `Queue ${kind}`, row.requirementId, row.portal, `queue ${id}: was ${row.status}`);
  if (kind === 'retry' && row.requirementId) await P.set(row.requirementId, row.portal, { status: 'QUEUED', lastQueueId: id, lastError: null }, user.id);
  if (['cancel', 'discard'].includes(kind) && row.requirementId) {
    const p = await P.get(row.requirementId, row.portal);
    if (p && ['QUEUED', 'DRAFT'].includes(p.status)) await P.set(row.requirementId, row.portal, { status: 'DRAFT', lastError: null }, user.id);
  }
  return { ok: true, entry: out.entry };
}

// ---- schedule (a person chose it): expiry + auto-republish. Nothing is scheduled by default.
async function setSchedule(user, requirementId, portal, { expiresAt, autoRepublish }) {
  const r = await prisma.requirement.findUnique({ where: { id: requirementId } });
  if (!r) return { error: 'Requirement not found', status: 404 };
  if (!access.inScope(user, r) || !(await access.mayPost(user, r))) return { error: 'Posting requirements is done by your team lead or the client manager.', code: 'POSTING_NOT_YOURS', status: 403 };
  if (!C.PORTALS[portal]) return { error: 'Unknown portal', status: 404 };
  const at = expiresAt ? ms(expiresAt) : null;
  if (expiresAt && !at) return { error: 'The expiry date is not valid.', status: 400 };
  const v = await P.set(requirementId, portal, { expiresAt: at, autoRepublish: !!autoRepublish }, user.id);
  await audit(user, 'Expiry scheduled', requirementId, portal, `${at ? iso(at) : 'cleared'}${autoRepublish ? ', republish by itself' : ''}`);
  return { ok: true, posting: v };
}

// The worker's sweep: ONLY rows a person scheduled. -> { expired, republished }
async function sweepExpiry(now = Date.now()) {
  if (!(await supported())) return { expired: 0, republished: 0 };
  const due = await q('SELECT * FROM "PortalPosting" WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= ? AND "status" = \'PUBLISHED\'', now);
  let expired = 0; let republished = 0;
  for (const d of due) {
    await P.set(d.requirementId, d.portal, { status: 'EXPIRED', lastError: 'The expiry date you set has passed.' });
    expired += 1;
    if (d.autoRepublish) {
      const r = await prisma.requirement.findUnique({ where: { id: d.requirementId } });
      if (r && requirementIsLive(r.status)) {
        const out = await Q.enqueue({ requirementId: d.requirementId, portal: d.portal, action: 'REPUBLISH', payloadHash: `exp:${d.expiresAt}`, requestedBy: d.updatedBy, requestedByName: 'Scheduled republish' });
        if (out.created) { republished += 1; await P.set(d.requirementId, d.portal, { status: 'QUEUED', expiresAt: null, lastQueueId: out.entry.id }); }
      }
    } else {
      try { await require('../utils/notify').notifyUsers([d.updatedBy], { title: `${C.portalName(d.portal)}: the requirement expired`, message: 'The expiry date you set has passed. Republish it if it is still open.' }); } catch { /* a notice */ } // eslint-disable-line global-require
    }
  }
  return { expired, republished };
}

async function portalsOverview(user) {
  const admin = await access.isCredentialAdmin(user);
  const worker = await S.workerState();
  const kill = await S.killState(null);
  const out = [];
  for (const portal of C.PORTAL_KEYS) {
    const meta = C.PORTALS[portal];
    const cfg = meta.kind === 'browser' ? await cfgLib.load(portal) : null;
    const lim = await S.limits(portal);
    out.push({
      portal, name: meta.name, kind: meta.kind, manualOnly: meta.kind === 'manual', note: meta.note,
      settings: cfg ? { ok: cfg.ok, problems: cfg.problems, version: cfg.version || null, verified: !!cfg.verified, from: cfg.origin, label: cfg.verified ? 'Verified' : 'Unverified: not yet checked against the real site' } : null,
      limits: { minGapSeconds: lim.minGapSeconds, maxGapSeconds: lim.maxGapSeconds, perHour: lim.perHour, perDay: lim.perDay },
      credential: admin ? await Cred.one(portal) : await Cred.posterView(portal),
    });
  }
  return { portals: out, worker, killAll: kill.killedAll, paused: kill.paused, canAdmin: admin, realPostingAllowed: guards.realPostingAllowed() };
}

module.exports = {
  publish, republish, unpublish, update, bulk, jobStatus, dashboard, command, setSchedule, sweepExpiry, portalsOverview, runInline, one, audit,
};
