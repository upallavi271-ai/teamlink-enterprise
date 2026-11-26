// ---------------------------------------------------------------------------
// TL PARTNERS (founder 2026-11-26: "usha ki enni reqs add ayyi vunnayo, anni reqs sirisha ki kuda add avvali. further lo kuda em ayina req
// assign cheyyali anukunte, education team ki, both tls ki assign cheyyali").
//
// A group = a department and the TLs who share its requirements. When a requirement of that department has ANY of them as a TL
// (main or "also assigned"), the others are added as "also assigned" TLs (utils/reqTeamLeads.js). It runs on every save of a
// requirement (db.js hook) and inside RT.setExtras, so a job made or re-assigned from any screen ends with the whole group.
// Nothing is ever removed: taking a TL off a job stays the person's own choice on that job.
//
// The groups live in one AppSetting row, key `tlPartnerGroups`, value JSON: [{ "department": "Education", "tls": ["<userId>", ...] }]
// No row = no groups = nothing happens (Nish and any other copy are untouched unless they add one).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'tlPartnerGroups';
const TTL_MS = 15000;
let groups = [];
let loadedAt = 0;
let loading = null;

const norm = (s) => String(s || '').trim().toLowerCase();

async function load() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    const list = row ? JSON.parse(row.value || '[]') : [];
    groups = (Array.isArray(list) ? list : []).map((g) => ({
      department: norm(g && g.department),
      tls: [...new Set(((g && g.tls) || []).map((x) => String(x || '').trim()).filter(Boolean))],
    })).filter((g) => g.department && g.tls.length > 1);
  } catch { /* keep what we had */ }
  loadedAt = Date.now();
}
async function ensure(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  if (!loading) loading = load().finally(() => { loading = null; });
  await loading;
}

// The partner TLs a job of `department` with these TLs is missing (active TL logins only).
async function missingFor(department, tlIds) {
  await ensure();
  if (!groups.length) return [];
  const have = new Set((tlIds || []).filter(Boolean).map(String));
  const dep = norm(department);
  const want = new Set();
  groups.forEach((g) => {
    if (g.department !== dep) return;
    if (!g.tls.some((t) => have.has(t))) return;
    g.tls.forEach((t) => { if (!have.has(t)) want.add(t); });
  });
  if (!want.size) return [];
  const live = await prisma.user.findMany({ where: { id: { in: [...want] }, status: 'Active' }, select: { id: true } }).catch(() => []);
  return live.map((u) => u.id);
}

// Bring one requirement up to its group: add the missing partners as "also assigned". Returns the ids added.
async function syncJob(jobId) {
  if (!jobId) return [];
  await ensure();
  if (!groups.length) return [];
  const RT = require('./reqTeamLeads'); // eslint-disable-line global-require
  const job = await prisma.requirement.findUnique({ where: { id: String(jobId) }, select: { id: true, tlId: true, department: true } }).catch(() => null);
  if (!job) return [];
  await RT.ensure();
  const extras = RT.extrasOf(job.id);
  const add = await missingFor(job.department, [job.tlId, ...extras]);
  if (!add.length) return [];
  await RT.setExtras(job.id, job.tlId, [...extras, ...add], { skipPartners: true });
  return add;
}

async function setGroups(list) {
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(list) }, update: { value: JSON.stringify(list) } });
  await ensure(true);
}

module.exports = { KEY, ensure, missingFor, syncJob, setGroups };
