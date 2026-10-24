// ---------------------------------------------------------------------------
// A JOB CAN BELONG TO MORE THAN ONE DEPARTMENT (user, 2026-10-13).
//
// Requirement.department stays the PRIMARY department - every existing filter,
// report and seat rule keeps reading it. The EXTRA departments live in one
// AppSetting row per job (key `reqDepts.<requirementId>`, value a JSON array),
// so no schema change is needed.
//
// Scope and filters are built synchronously (utils/scope.js), so the rows are
// held in a small in-memory index that is refreshed by a request middleware
// (at most once every few seconds) and updated at once by every write here.
//
//   deptArm(departments)        a Prisma where: the primary department matches
//                               OR the job lists one of them as an extra
//   departmentsOf(job)          [primary, ...extras] for a row
//   setExtras(id, primary, [d]) save (empty list removes the row)
//   ensure()                    load / refresh the index (await before reads)
//   middleware                  express: await ensure() on each request
// ---------------------------------------------------------------------------
const prisma = require('../db');

const PREFIX = 'reqDepts.';
const TTL_MS = 4000;

let byJob = new Map(); // jobId -> ['Medical', ...]
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

// [primary, ...extras] for a row (primary may be blank).
function departmentsOf(job) {
  if (!job) return [];
  return clean([job.department, ...extrasOf(job.id)]);
}

function idsForDepartments(departments) {
  const want = new Set(clean(departments).map((d) => d.toLowerCase()));
  if (!want.size) return [];
  const out = [];
  byJob.forEach((list, id) => { if (list.some((d) => want.has(d.toLowerCase()))) out.push(id); });
  return out;
}

// The where for "this job is in one of these departments".
function deptArm(departments) {
  const list = clean(departments);
  const ids = idsForDepartments(list);
  if (!ids.length) return { department: { in: list } };
  return { OR: [{ department: { in: list } }, { id: { in: ids } }] };
}

async function setExtras(jobId, primary, extras) {
  const key = PREFIX + jobId;
  const list = clean(extras).filter((d) => d.toLowerCase() !== String(primary || '').trim().toLowerCase());
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

// Fresh extras for a set of jobs (list rows), straight from the index.
function extrasMap(ids) {
  const out = {};
  (ids || []).forEach((id) => { const e = extrasOf(id); if (e.length) out[id] = e; });
  return out;
}

const allIds = () => [...byJob.keys()];

module.exports = { allIds, ensure, middleware, extrasOf, departmentsOf, idsForDepartments, deptArm, setExtras, removeJob, extrasMap, clean };
