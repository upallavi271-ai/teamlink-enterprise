// ---------------------------------------------------------------------------
// WHO RECEIVES THE RESPONSES OF A JOB (founder 2026-11-20, the requirement flow step 4: "the department TL ticks the response
// recipients and posts it"). Kept APART from the assigned recruiters: the assigned recruiters work the job and source for it, as
// before; the response recipients are the recruiters of the TL's team who get the people who answer the job by themselves - the Job
// Portal, the careers page, the job boards' apply links (Naukri, Indeed, LinkedIn ...), WhatsApp / AI apply links, a mailbox response.
//
//   Data      RequirementResponseRecipient (one row per job: the user ids, who set them, when, the last reason) and
//             RequirementResponseRecipientHistory (every change: from -> to, by, when, reason). Raw SQL, made here (no migration).
//   Posting   a job created after this went live is not posted (Post window, post-everywhere, own sites, Naukri / Shine by hand)
//             until at least one recipient is ticked: postingRefusal(). Older jobs keep today's behaviour.
//   Routing   a new inbound application of a job with recipients gets an owner from them: the one with the fewest open new
//             responses on that job, ties by name (route(), called by the owner_ hook in db.js / utils/applicationOwner.js); the
//             recipient gets a bell. No recipients -> today's rule (the main recruiter / "share equally").
//   Leaving   a recipient taken off the list, or who leaves (status not Active / employment ended), hands their unworked new
//             responses (stage NEW, not sent to the ATS yet) to the remaining recipients, one by one in the same turn order.
//   Scope     utils/scope.js reads the in-memory index (recipientArm / isRecipient): a recipient who is not assigned still sees
//             the job and works the responses given to them (and only those - the recruiter "own candidates" rule is unchanged).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const T = 'RequirementResponseRecipient';
const H = 'RequirementResponseRecipientHistory';
const SINCE_KEY = 'respRecipients.since';
const LEFT = ['Exited', 'Relieved', 'Terminated'];
const INBOUND_SOURCES = ['TeamLink Job Portal', 'Job Portal'];
const INBOUND_METHODS = ['Auto-Apply', 'Email Response'];
const MAX = 40;
const TTL_MS = 4000;
const CODE = 'RESPONSE_RECIPIENTS_NEEDED';
const NEED_MSG = 'Choose who receives the responses first: tick at least one recruiter under "Who receives the responses" in the Post window (or on the requirement\'s Team tab), then post.';

const clean = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, MAX);
const parse = (v) => { try { return clean(JSON.parse(v || '[]')); } catch { return []; } };

let READY = null;
let since = null; // Date: jobs created before it are "older jobs"
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${T}" ("requirementId" TEXT PRIMARY KEY, "userIds" TEXT NOT NULL,
        "setById" TEXT, "setByName" TEXT, "setAt" TEXT, "reason" TEXT)`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${H}" ("id" TEXT PRIMARY KEY, "requirementId" TEXT NOT NULL,
        "fromIds" TEXT, "toIds" TEXT, "fromNames" TEXT, "toNames" TEXT, "kind" TEXT, "reason" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "${H}_req" ON "${H}" ("requirementId", "at")`);
      const row = await prisma.appSetting.findUnique({ where: { key: SINCE_KEY } }).catch(() => null);
      if (row && row.value) since = new Date(row.value);
      else {
        since = new Date();
        await prisma.appSetting.upsert({ where: { key: SINCE_KEY }, create: { key: SINCE_KEY, value: since.toISOString() }, update: {} }).catch(() => {});
      }
      startSweeper();
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

// ---- the in-memory index (utils/scope.js is synchronous) ------------------
let byJob = new Map(); // jobId -> [userId]
let loadedAt = 0;
let loading = null;
async function load() {
  try {
    await ensure();
    const rows = await prisma.$queryRawUnsafe(`SELECT "requirementId", "userIds" FROM "${T}"`);
    const next = new Map();
    rows.forEach((r) => { const ids = parse(r.userIds); if (ids.length) next.set(String(r.requirementId), ids); });
    byJob = next;
  } catch { /* keep what we have */ }
  loadedAt = Date.now();
}
async function refresh(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  if (!loading) loading = load().finally(() => { loading = null; });
  await loading;
}
function middleware(req, res, next) { refresh().then(() => next(), () => next()); }

const idsOf = (jobId) => byJob.get(String(jobId)) || [];
const isRecipient = (jobId, userId) => !!userId && idsOf(jobId).includes(userId);
function jobsOf(userId) {
  const out = [];
  if (!userId) return out;
  byJob.forEach((ids, jobId) => { if (ids.includes(userId)) out.push(jobId); });
  return out;
}
// a Prisma where arm: the jobs this login receives the responses of (null = none)
function recipientArm(userId) {
  const ids = jobsOf(userId);
  return ids.length ? { id: { in: ids } } : null;
}

// ---- reading / writing -----------------------------------------------------
async function get(jobId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${T}" WHERE "requirementId" = ?`, String(jobId));
  if (!rows.length) return null;
  const r = rows[0];
  return { ids: parse(r.userIds), setById: r.setById || null, setByName: r.setByName || null, setAt: r.setAt || null, reason: r.reason || null };
}
async function history(jobId, limit = 50) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "${H}" WHERE "requirementId" = ? ORDER BY "at" DESC LIMIT ?`, String(jobId), Number(limit) || 50);
  return rows.map((r) => ({
    at: r.at, kind: r.kind || 'set', reason: r.reason || null, by: r.byName || 'TeamLink',
    from: parse(r.fromIds), to: parse(r.toIds), fromNames: r.fromNames || '', toNames: r.toNames || '',
  }));
}
const namesOf = async (ids) => {
  const list = clean(ids);
  if (!list.length) return new Map();
  return new Map((await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
};
const joinNames = (ids, names) => ids.map((id) => names.get(id) || 'a recruiter').join(', ');

// who of these may still receive responses: an Active login whose employment has not ended
async function stillHere(ids) {
  const list = clean(ids);
  if (!list.length) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: list }, status: 'Active' },
    select: { id: true, name: true, employee: { select: { employmentStatus: true } } },
  });
  return users.filter((u) => !(u.employee && LEFT.includes(u.employee.employmentStatus))).map((u) => ({ id: u.id, name: u.name }));
}

/** Save the list. kind: set (first time) | change | left | removed. Writes the history row and the requirement's audit trail. */
async function save(job, ids, { by = null, reason = null, kind = null } = {}) {
  await ensure();
  const before = await get(job.id);
  const from = before ? before.ids : [];
  const to = clean(ids);
  const names = await namesOf([...from, ...to]);
  const k = kind || (from.length ? 'change' : 'set');
  const at = new Date().toISOString();
  if (to.length) {
    await prisma.$executeRawUnsafe(`INSERT INTO "${T}" ("requirementId","userIds","setById","setByName","setAt","reason") VALUES (?,?,?,?,?,?)
      ON CONFLICT("requirementId") DO UPDATE SET "userIds" = excluded."userIds", "setById" = excluded."setById", "setByName" = excluded."setByName", "setAt" = excluded."setAt", "reason" = excluded."reason"`,
    String(job.id), JSON.stringify(to), by ? by.id : null, by ? by.name : 'TeamLink', at, reason ? String(reason).slice(0, 500) : null);
    byJob.set(String(job.id), to);
  } else {
    await prisma.$executeRawUnsafe(`DELETE FROM "${T}" WHERE "requirementId" = ?`, String(job.id));
    byJob.delete(String(job.id));
  }
  await prisma.$executeRawUnsafe(`INSERT INTO "${H}" ("id","requirementId","fromIds","toIds","fromNames","toNames","kind","reason","byId","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    crypto.randomUUID(), String(job.id), JSON.stringify(from), JSON.stringify(to), joinNames(from, names), joinNames(to, names), k,
    reason ? String(reason).slice(0, 500) : null, by ? by.id : null, by ? by.name : 'TeamLink', at);
  const ACTION = { set: 'Response recipients set', change: 'Response recipients changed', left: 'Response recipient left: responses moved', removed: 'Response recipients removed' };
  await require('./audit').logAudit({ // eslint-disable-line global-require
    userId: by ? by.id : null, actorName: by ? by.name : 'TeamLink', action: ACTION[k] || ACTION.change, entity: 'Requirement', entityId: job.id,
    field: 'responseRecipients', fieldLabel: 'Responses go to',
    fromValue: from.length ? joinNames(from, names) : 'Not set', toValue: to.length ? joinNames(to, names) : 'Not set', reason: reason ? String(reason).slice(0, 300) : null,
  }).catch(() => {});
  return { from, to, names, kind: k };
}

// ---- routing ---------------------------------------------------------------
// A response is what came in by itself: the apply forms (Job Portal, careers page, job-board / WhatsApp / AI apply links, the
// candidate portal) stamp applicationMethod 'Auto-Apply', a mailbox response 'Email Response'. A person keyed in is 'Manual'.
const INBOUND_WHERE = { applicationMethod: { in: INBOUND_METHODS } };
const UNWORKED_WHERE = { stage: 'NEW', portalImportedAt: null };
/** Is this new application a response (it came in by itself), and not one a recruiter keyed in? */
function isInbound(data) {
  if (!data) return false;
  const came = INBOUND_METHODS.includes(String(data.applicationMethod || ''));
  // an owner given by the caller stays, except a mailbox response (it follows the mailbox's seat unless the job has recipients)
  return came && (!data.ownerRecruiterId || data.applicationMethod === 'Email Response');
}
// open new responses per recipient on this job
async function openCounts(client, jobId, ids) {
  const rows = await client.application.groupBy({
    by: ['ownerRecruiterId'], where: { requirementId: jobId, ownerRecruiterId: { in: ids }, ...UNWORKED_WHERE, ...INBOUND_WHERE }, _count: { _all: true },
  }).catch(() => []);
  return new Map(rows.map((r) => [r.ownerRecruiterId, r._count._all]));
}
// fewest open new responses first, ties by name
const nextOf = (people, counts) => people.slice().sort((a, b) => ((counts.get(a.id) || 0) - (counts.get(b.id) || 0)) || String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id))[0] || null;

/** The owner for a new inbound application of this job, from its recipients; null = no recipients (today's rule applies). */
async function route(client, jobId, data) {
  let rows;
  try { rows = await client.$queryRawUnsafe(`SELECT "userIds" FROM "${T}" WHERE "requirementId" = ?`, String(jobId)); } catch { return null; } // table not made yet
  const ids = rows && rows.length ? parse(rows[0].userIds) : [];
  if (!ids.length) return null;
  if (data && data.ownerRecruiterId && ids.includes(data.ownerRecruiterId)) return null; // the mailbox's recruiter is a recipient: theirs
  const people = await stillHere(ids);
  if (!people.length) return null;
  const pick = nextOf(people, await openCounts(client, jobId, people.map((p) => p.id)));
  return pick ? pick.id : null;
}
/** After the application is saved (outside any transaction): the bell for the recipient who got it. */
function afterRouted(result, info) {
  if (!result || !result.id || !info || !info.owner) return;
  setTimeout(async () => {
    try {
      const app = await prisma.application.findUnique({
        where: { id: result.id },
        select: { id: true, ownerRecruiterId: true, firstSource: true, source: true, candidate: { select: { name: true } }, requirement: { select: { id: true, reqCode: true, title: true } } },
      });
      if (!app || app.ownerRecruiterId !== info.owner) return;
      const job = app.requirement || {};
      await require('./notify').notifyUsers([info.owner], { // eslint-disable-line global-require
        title: `New response — ${job.reqCode || job.title || 'a requirement'}`,
        message: `${(app.candidate && app.candidate.name) || 'Someone'} responded to ${job.title || 'the requirement'}${app.firstSource && app.firstSource !== app.source ? ` (from ${app.firstSource})` : ''}. It is yours to check: Candidates, New from job portal.`,
        open: '/candidates?view=job-portal',
      });
    } catch { /* the response is still theirs; only the bell is missed */ }
  }, 150);
}

/** Hand the unworked new responses of `fromIds` on this job to `toPeople` ([{id,name}]) in the turn order. -> moved count */
async function reassignUnworked(job, fromIds, toPeople, { by = null, kind = 'response recipient changed', reason = null } = {}) {
  const from = clean(fromIds);
  if (!from.length || !toPeople || !toPeople.length) return 0;
  const apps = await prisma.application.findMany({
    where: { requirementId: job.id, ownerRecruiterId: { in: from }, ...UNWORKED_WHERE, ...INBOUND_WHERE },
    select: { id: true, candidateId: true, ownerRecruiterId: true, stage: true }, orderBy: { createdAt: 'asc' },
  });
  if (!apps.length) return 0;
  const counts = await openCounts(prisma, job.id, toPeople.map((p) => p.id));
  const HO = require('./handover'); // eslint-disable-line global-require
  const got = new Map();
  for (const a of apps) {
    const to = nextOf(toPeople, counts);
    // eslint-disable-next-line no-await-in-loop
    const moved = await HO.moveOwner({ apps: [a], to, by, kind, reason: reason || `${job.reqCode || job.title || 'The requirement'}: responses go to the recipients now` });
    if (moved.length) { counts.set(to.id, (counts.get(to.id) || 0) + 1); got.set(to.id, (got.get(to.id) || 0) + 1); }
  }
  const N = require('./notify'); // eslint-disable-line global-require
  for (const [uid, n] of got) {
    // eslint-disable-next-line no-await-in-loop
    await N.notifyUsers([uid], {
      title: `${n} response${n === 1 ? '' : 's'} handed to you — ${job.reqCode || job.title}`,
      message: `${n} new response${n === 1 ? '' : 's'} of ${job.title || 'the requirement'} ${n === 1 ? 'is' : 'are'} yours now (${kind}). Check them in Candidates, New from job portal.`,
      open: '/candidates?view=job-portal', exceptUserId: by ? by.id : null,
    }).catch(() => {});
  }
  return [...got.values()].reduce((s, n) => s + n, 0);
}

/** Recipients who left (or whose login is no longer Active): off the list, their unworked new responses to the others. */
async function sweepLeft(jobId = null, by = null) {
  await ensure();
  const rows = jobId
    ? await prisma.$queryRawUnsafe(`SELECT "requirementId", "userIds" FROM "${T}" WHERE "requirementId" = ?`, String(jobId))
    : await prisma.$queryRawUnsafe(`SELECT "requirementId", "userIds" FROM "${T}"`);
  let moved = 0;
  for (const r of rows) {
    const ids = parse(r.userIds);
    // eslint-disable-next-line no-await-in-loop
    const here = await stillHere(ids);
    const gone = ids.filter((id) => !here.some((p) => p.id === id));
    if (!gone.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const job = await prisma.requirement.findUnique({ where: { id: r.requirementId }, select: { id: true, reqCode: true, title: true, recruiterId: true, recruiterIds: true } });
    if (!job) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const names = await namesOf(gone);
    const why = `${joinNames(gone, names)} left, so ${gone.length === 1 ? 'is' : 'are'} off the list`;
    // eslint-disable-next-line no-await-in-loop
    await save(job, here.map((p) => p.id), { by, reason: why, kind: 'left' });
    let to = here;
    if (!to.length) { // nobody left on the list: the job's own recruiter (today's rule) takes them
      const main = job.recruiterId || String(job.recruiterIds || '').split(',').map((x) => x.trim()).filter(Boolean)[0];
      // eslint-disable-next-line no-await-in-loop
      to = main ? await stillHere([main]) : [];
    }
    // eslint-disable-next-line no-await-in-loop
    moved += await reassignUnworked(job, gone, to, { by, kind: 'response recipient left', reason: why });
  }
  return moved;
}
let sweeper = null;
function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => { sweepLeft().catch(() => {}); }, 10 * 60 * 1000);
  if (sweeper.unref) sweeper.unref();
}

// ---- posting ---------------------------------------------------------------
/** null = may post; otherwise { error, code } - a job created after this went live with no recipient ticked. */
async function postingRefusal(jobOrId) {
  await ensure();
  const job = typeof jobOrId === 'object' && jobOrId && jobOrId.createdAt
    ? jobOrId
    : await prisma.requirement.findUnique({ where: { id: String((jobOrId && jobOrId.id) || jobOrId) }, select: { id: true, createdAt: true } });
  if (!job) return null;
  if (since && new Date(job.createdAt) < since) return null; // an older job: today's behaviour
  const row = await get(job.id);
  if (row && row.ids.length) return null;
  return { error: NEED_MSG, code: CODE };
}
const sinceDate = () => since;

module.exports = {
  CODE, NEED_MSG, INBOUND_SOURCES, INBOUND_METHODS, INBOUND_WHERE, UNWORKED_WHERE, ensure, refresh, middleware, idsOf, isRecipient, jobsOf, recipientArm,
  get, history, save, stillHere, isInbound, route, afterRouted, reassignUnworked, sweepLeft, postingRefusal, sinceDate, clean, namesOf, nextOf, openCounts,
};
