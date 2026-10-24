// ---------------------------------------------------------------------------
// A JOB CAN HAVE MORE THAN ONE TEAM LEAD (user, 2026-10-14).
//
// Requirement.tlId stays the PRIMARY (main) TL - every existing screen, report
// and rule keeps reading it. The EXTRA TLs ("also assigned") live in one
// AppSetting row per job (key `reqTls.<requirementId>`, value a JSON array of
// user ids), the same additive pattern as utils/reqDepartments.js, so no schema
// change is needed.
//
// Scope and filters are built synchronously (utils/scope.js), so the rows are
// held in a small in-memory index refreshed by a request middleware (at most
// every few seconds) and updated at once by every write here.
//
//   tlsOf(job)             [primary, ...extras] user ids
//   tlArm(userIds)         a Prisma where: the primary matches OR the job lists
//                          one of them as an extra TL
//   setExtras(id, primary, [ids])   save (empty list removes the row)
//   ensure() / middleware  load / refresh the index
// ---------------------------------------------------------------------------
const prisma = require('../db');

const PREFIX = 'reqTls.';
const TTL_MS = 4000;
const MAX_TLS = 10;

let byJob = new Map(); // jobId -> [userId, ...]
let loadedAt = 0;
let loading = null;

const clean = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean))];

async function load() {
  try {
    const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: PREFIX } }, select: { key: true, value: true } });
    const next = new Map();
    rows.forEach((r) => {
      try {
        const v = clean(JSON.parse(r.value));
        if (v.length) next.set(r.key.slice(PREFIX.length), v);
      } catch { /* bad row: ignore */ }
    });
    byJob = next;
  } catch { /* AppSetting not reachable: keep what we have */ }
  loadedAt = Date.now();
}

async function ensure(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  if (!loading) loading = load().finally(() => { loading = null; });
  await loading;
}

function middleware(req, res, next) {
  ensure().then(() => next(), () => next());
}

const extrasOf = (jobId) => byJob.get(String(jobId)) || [];

// [primary, ...extras] user ids for a row (primary may be blank).
function tlsOf(job) {
  if (!job) return [];
  return clean([job.tlId, ...extrasOf(job.id)]);
}

function idsForTl(userIds) {
  const want = new Set(clean(userIds));
  if (!want.size) return [];
  const out = [];
  byJob.forEach((list, id) => { if (list.some((u) => want.has(u))) out.push(id); });
  return out;
}

// The where for "this user (or one of these users) is a TL of the job".
function tlArm(userIds) {
  const list = clean(userIds);
  const ids = idsForTl(list);
  const primary = list.length === 1 ? { tlId: list[0] } : { tlId: { in: list } };
  if (!ids.length) return primary;
  return { OR: [primary, { id: { in: ids } }] };
}

async function setExtras(jobId, primary, extras) {
  const key = PREFIX + jobId;
  const list = clean(extras).filter((u) => u !== String(primary || '').trim());
  if (!list.length) {
    await prisma.appSetting.deleteMany({ where: { key } }).catch(() => {});
    byJob.delete(String(jobId));
    return [];
  }
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(list) },
    update: { value: JSON.stringify(list) },
  });
  byJob.set(String(jobId), list);
  return list;
}

async function removeJob(jobId) {
  await prisma.appSetting.deleteMany({ where: { key: PREFIX + jobId } }).catch(() => {});
  byJob.delete(String(jobId));
}

const allIds = () => [...byJob.keys()];

function extrasMap(ids) {
  const out = {};
  (ids || []).forEach((id) => { const e = extrasOf(id); if (e.length) out[id] = e; });
  return out;
}

// Open jobs each of these users is an EXTRA team lead on (primary jobs are
// counted by the caller's own groupBy on tlId). Returns Map(userId -> count).
async function extraLoad(userIds, liveStatuses) {
  const want = new Set(clean(userIds));
  const out = new Map();
  if (!want.size || !byJob.size) return out;
  const jobs = await prisma.requirement.findMany({ where: { id: { in: [...byJob.keys()] }, status: { in: liveStatuses } }, select: { id: true, tlId: true } });
  jobs.forEach((j) => {
    extrasOf(j.id).forEach((u) => { if (want.has(u) && u !== j.tlId) out.set(u, (out.get(u) || 0) + 1); });
  });
  return out;
}

module.exports = { allIds, MAX_TLS, ensure, middleware, extrasOf, tlsOf, idsForTl, tlArm, setExtras, removeJob, extrasMap, extraLoad, clean };
