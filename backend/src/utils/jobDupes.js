// ---------------------------------------------------------------------------
// DUPLICATE JOBS — detection (user, 2026-10-13: "Req lo duplicates unte remove cheyyu ... same clients ki ela aithe
// duplicates detect chesavo, alage REQUIREMENTS ni kuda detect cheyyu").
//
// The same idea as the candidate and client duplicates, for jobs (requirements). A job is compared ONLY with the other
// jobs of the SAME client (so a save is one indexed read, never a full scan), by utils/jobFingerprint.js:
//
//   CERTAIN   same external job id / URL on a job board · same client + same role (title + specialisation) + same city +
//             same openings, both still open · an identical row (same title, city, openings, pay, description) made together
//   LIKELY    same role + same city but different openings · same role in another city opened close in time (or with the
//             same description) · same role with no city on either job, opened close in time · a very alike title + description
//   POSSIBLE  a similar title with similar skills / description (never when the specialisations differ)
//
//   Never a match: different specialisations ('Assistant Professor — Pathology' vs '— Anatomy'), two closed jobs, internal
//   TeamLink openings, drafts (a draft is not a job yet). A different city is never CERTAIN. A pair somebody marked
//   "Not a duplicate" is never offered again.
//
// Everything here answers "nothing" (never throws) when the three small tables of the migration
// 20261013140000_job_duplicates are missing, except detection itself, which needs no table at all.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const FP = require('./jobFingerprint');

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const q = async (sql, ...p) => (await prisma.$queryRawUnsafe(sql, ...p)).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = num(r[k]); }); return o; });
const ex = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const DAY = 86400000;
const LEVELS = ['CERTAIN', 'LIKELY', 'POSSIBLE'];
const LEVEL_RANK = { CERTAIN: 3, LIKELY: 2, POSSIBLE: 1 };
const TEST_MARK = /zztest|example\.test/i;

// --- the tables -------------------------------------------------------------------------
let tableOk = null; let tableAt = 0;
async function supported() {
  if (tableOk === true) return true;
  if (tableOk === false && Date.now() - tableAt < 20000) return false;
  try {
    const r = await q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('JobDupDecision','JobMergeLog','JobAlias')");
    tableOk = r.length === 3;
  } catch { tableOk = false; }
  tableAt = Date.now();
  return tableOk;
}
function forgetSupport() { tableOk = null; }

// --- settings (AppSetting "job-duplicates") ------------------------------------------------
//   undoDays   how long a merge can be undone (default 7)
//   openings   'max' (default) | 'sum' — what the kept job's openings become
let SET = { at: 0, v: null };
async function settings() {
  if (SET.v && Date.now() - SET.at < 15000) return SET.v;
  let v = {};
  try { const r = await q("SELECT value FROM AppSetting WHERE key = 'job-duplicates'"); v = r[0] ? json(r[0].value, {}) : {}; } catch { v = {}; }
  SET = { at: Date.now(), v: { undoDays: Math.min(60, Math.max(1, Number(v.undoDays) || 7)), openings: v.openings === 'sum' ? 'sum' : 'max' } };
  return SET.v;
}
async function saveSettings(patch, user) {
  const next = { ...(await settings()), ...patch };
  await ex(`INSERT INTO AppSetting (key, value, updatedById, updatedByName, updatedAt) VALUES ('job-duplicates', ?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedById = excluded.updatedById, updatedByName = excluded.updatedByName, updatedAt = excluded.updatedAt`,
  JSON.stringify(next), user ? user.id : null, user ? user.name : null, Date.now());
  SET = { at: 0, v: null };
  return next;
}

// --- "not a duplicate" memory ---------------------------------------------------------------
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
let DEC = { at: 0, set: null };
async function decisions() {
  if (DEC.set && Date.now() - DEC.at < 20000) return DEC.set;
  let set = new Set();
  try { if (await supported()) set = new Set((await q("SELECT pairKey FROM JobDupDecision WHERE kind = 'NOT_DUPLICATE'")).map((r) => r.pairKey)); } catch { /* none */ }
  DEC = { at: Date.now(), set };
  return set;
}
async function rememberNotDuplicate(aId, bId, { reason, user, door } = {}) {
  if (!(await supported())) return false;
  const k = pairKey(aId, bId);
  await ex(`INSERT INTO JobDupDecision (id, pairKey, jobAId, jobBId, kind, reason, door, decidedById, decidedByName, createdAt)
            VALUES (?, ?, ?, ?, 'NOT_DUPLICATE', ?, ?, ?, ?, ?) ON CONFLICT(pairKey) DO UPDATE SET reason = excluded.reason, decidedById = excluded.decidedById, decidedByName = excluded.decidedByName, createdAt = excluded.createdAt`,
  newId('jd'), k, aId, bId, String(reason || '').slice(0, 300), door || null, user ? user.id : null, user ? user.name : null, Date.now());
  DEC = { at: 0, set: null };
  bump({ hard: true });
  return true;
}
async function forgetDecision(aId, bId) {
  if (!(await supported())) return;
  await ex('DELETE FROM JobDupDecision WHERE pairKey = ?', pairKey(aId, bId));
  DEC = { at: 0, set: null };
  bump({ hard: true });
}

// --- reading jobs ------------------------------------------------------------------------------
const COLS = ['id', 'reqCode', 'title', 'clientId', 'department', 'specialisation', 'status', 'openings', 'location', 'experience', 'employmentType',
  'salary', 'skills', 'description', 'jobDescription', 'createdAt', 'updatedAt', 'internal', 'bdeId', 'tlId', 'recruiterId', 'closingDate', 'hiringType'];
const SELECT = Object.fromEntries(COLS.map((c) => [c, true]));

const isClosed = (s) => s === 'CLOSED';
const isDraft = (s) => s === 'DRAFT';
const isOpen = (s) => !isClosed(s) && !isDraft(s);
const ts = (v) => (v instanceof Date ? v.getTime() : (v ? new Date(v).getTime() : 0));

// The compact, compared form of one job.
function prep(j, ext) {
  const titleT = FP.titleTokens(j.title);
  const parts = FP.titleParts(j.title);
  let specT = FP.specTokens(j.specialisation);
  if (!specT.length && parts.tail) specT = FP.specTokens(parts.tail);
  const id = new Set([...titleT, ...FP.specTokens(j.specialisation)]);
  const body = `${j.jobDescription || ''} ${j.description || ''}`;
  const text = FP.textTokens(body);
  // a description that is only the title carries no information
  const textOk = text.size >= 15;
  return {
    j, id, role: new Set(titleT), spec: new Set(specT), specKnown: specT.length > 0,
    city: j.location || '', exp: FP.expBand(j.experience), sal: FP.salaryBand(j.salary), emp: FP.employmentKey(j.employmentType),
    text, textOk, skills: FP.skillTokens(j.skills), created: ts(j.createdAt), open: isOpen(j.status), closed: isClosed(j.status),
    ext: ext || [], dept: String(j.department || '').toLowerCase().trim(),
    sig: FP.sha([FP.titleKey(j.title), FP.cityTokens(j.location).join(','), j.openings, FP.salaryBand(j.salary), FP.expBand(j.experience), [...text].slice(0, 80).sort().join(' ')].join('|')),
  };
}

const RANKS = ['senior', 'junior', 'assistant', 'associate', 'chief', 'head', 'principal', 'trainee', 'intern', 'lead', 'deputy', 'executive', 'manager', 'director', 'vice'];
const rankOf = (tokens) => RANKS.filter((r) => tokens.has(r)).join(',');
const bandsConflict = (a, b) => {
  if (!a || !b) return false;
  const [al, ah] = a.split('-'); const [bl, bh] = b.split('-');
  const A = [Number(al), ah === '' ? Infinity : Number(ah)]; const B = [Number(bl), bh === '' ? Infinity : Number(bh)];
  return A[1] < B[0] || B[1] < A[0];
};
const sameNum = (a, b) => Number(a || 1) === Number(b || 1);

// -> null | { level, reasons: [plain words], codes: [short], score }
function compare(A, B) {
  if (A.j.id === B.j.id) return null;
  if (A.j.clientId !== B.j.clientId) return null;
  if (A.j.internal || B.j.internal) return null;
  // two closed jobs are history; a draft is not a job yet
  if (!A.open && !B.open) return null;
  if (isDraft(A.j.status) || isDraft(B.j.status)) return null;
  const bothOpen = A.open && B.open;

  // 1. the same external job id / URL on a board: the same job published twice
  if (A.ext.length && B.ext.length && (A.open || B.open)) {
    const set = new Set(A.ext);
    const hit = B.ext.find((x) => set.has(x));
    if (hit) return { level: 'CERTAIN', reasons: ['Posted with the same job id / link on a job site'], codes: ['external-id'], score: 100 };
  }
  if (!bothOpen) return null; // everything below needs both jobs still open

  const dept = A.dept && B.dept && A.dept !== B.dept;
  if (dept) return null;
  const specConflict = A.specKnown && B.specKnown
    && FP.jaccard(A.spec, B.spec) < 0.6 && FP.containment(A.spec, B.spec) < 1;
  if (specConflict) return null;

  const idSim = FP.jaccard(A.id, B.id);
  const eq = idSim === 1 && A.id.size > 0;
  const loc = FP.sameLocation(A.city, B.city);
  const gapDays = Math.abs(A.created - B.created) / DAY;
  const sameOpen = sameNum(A.j.openings, B.j.openings);
  const textSim = A.textOk && B.textOk ? FP.jaccard(A.text, B.text) : null;
  const expBad = bandsConflict(A.exp, B.exp);
  const salBad = bandsConflict(A.sal, B.sal);
  const empBad = A.emp && B.emp && A.emp !== B.emp;
  const differ = expBad || salBad || empBad; // a different level / pay / type: probably a different job

  const out = (level, reasons, codes, score) => {
    let lv = level;
    if (differ && level !== 'POSSIBLE') {
      lv = level === 'CERTAIN' ? 'LIKELY' : 'POSSIBLE';
      reasons.push(expBad ? 'but the experience asked is different' : salBad ? 'but the pay is different' : 'but the requirement type is different');
    }
    return { level: lv, reasons, codes, score: score - (differ ? 20 : 0) };
  };

  if (eq) {
    const same = ['Same requirement title'];
    if (A.specKnown && B.specKnown) same.push('same specialisation');
    if (A.sig === B.sig && gapDays <= 7) return out('CERTAIN', ['An identical requirement (same title, city, openings, pay and description)'], ['identical-row'], 96);
    if (loc === 'same' && sameOpen) return out('CERTAIN', [...same, 'same city', 'both still open'], ['same-role', 'same-city', 'both-open'], 95);
    if (loc === 'same') return out('LIKELY', [...same, 'same city', `different openings (${A.j.openings} and ${B.j.openings})`], ['same-role', 'same-city', 'openings-differ'], 80);
    if (loc === 'unknown') {
      // neither job names a city: a batch saved twice is certain; an old repeat is only a hunch
      if (sameOpen && gapDays <= 3 && !(A.city || B.city)) return out('CERTAIN', [...same, 'no city on either requirement', 'saved within 3 days', 'same openings'], ['same-role', 'close-in-time'], 92);
      if (gapDays <= 30 || (textSim != null && textSim >= 0.8)) return out('LIKELY', [...same, A.city || B.city ? 'only one requirement names a city' : 'no city on either requirement', gapDays <= 30 ? 'opened within 30 days' : 'same description'], ['same-role', 'close-in-time'], 70);
      return out('POSSIBLE', [...same, 'no city given, opened far apart'], ['same-role'], 40);
    }
    // a different city
    if (gapDays <= 30 || (textSim != null && textSim >= 0.8)) return out('LIKELY', [...same, 'but a different city', gapDays <= 30 ? 'opened within 30 days' : 'same description'], ['same-role', 'other-city'], 65);
    return out('POSSIBLE', [...same, 'but a different city'], ['same-role', 'other-city'], 35);
  }

  // not the same words: a very alike title AND description, or only a similar title with similar skills
  if (loc === 'different') return null;
  // a different level is a different job (Senior / Junior / Assistant / Associate / Chief / Head ...): never a fuzzy match
  if (rankOf(A.role) !== rankOf(B.role)) return null;
  const skillSim = A.skills.size && B.skills.size ? FP.jaccard(A.skills, B.skills) : null;
  if (idSim >= 0.75 && textSim != null && textSim >= 0.7) return out('LIKELY', ['A very alike title', `description ${Math.round(textSim * 100)}% alike`], ['alike-title', 'alike-text'], 68);
  const roleSim = FP.jaccard(A.role, B.role);
  const contained = FP.containment(A.id, B.id) === 1 && Math.min(A.id.size, B.id.size) >= 2;
  if ((idSim >= 0.6 || (roleSim >= 0.75 && !(A.specKnown && B.specKnown)) || contained) && ((skillSim != null && skillSim >= 0.5) || (textSim != null && textSim >= 0.5))) {
    return out('POSSIBLE', ['A similar title', skillSim != null && skillSim >= 0.5 ? 'similar skills' : 'similar description'], ['similar-title'], 30 + Math.round(idSim * 10));
  }
  return null;
}

// --- loading every job once (cached) --------------------------------------------------------
let CACHE = { at: 0, version: -1, data: null, building: null };
let VERSION = 1;
let HARD = false;
function bump(opts) { VERSION += 1; if (opts && opts.hard) HARD = true; }
const version = () => VERSION;

let EXT = { at: 0, map: null };
async function externalIds() {
  if (EXT.map && Date.now() - EXT.at < 30000) return EXT.map;
  const map = new Map();
  try {
    const rows = await prisma.requirementPosting.findMany({
      where: { OR: [{ externalJobId: { not: null } }, { externalUrl: { not: null } }], status: { not: 'Removed' } },
      select: { requirementId: true, source: true, externalJobId: true, externalUrl: true },
    });
    rows.forEach((r) => {
      const keys = [];
      // our own sites use the job id itself as the external id: that is not evidence
      if (r.externalJobId && String(r.externalJobId).length > 3 && r.externalJobId !== r.requirementId) keys.push(`${r.source}#${String(r.externalJobId).trim().toLowerCase()}`);
      if (r.externalUrl && !String(r.externalUrl).includes(r.requirementId)) keys.push(`url#${String(r.externalUrl).trim().toLowerCase().replace(/[?#].*$/, '')}`);
      if (keys.length) map.set(r.requirementId, [...(map.get(r.requirementId) || []), ...keys]);
    });
  } catch { /* none */ }
  EXT = { at: Date.now(), map };
  return map;
}

async function loadAll() {
  const rows = await prisma.requirement.findMany({ where: { internal: false, status: { not: 'DRAFT' } }, select: SELECT });
  const ext = await externalIds();
  return rows.map((j) => prep(j, ext.get(j.id)));
}

// every pair of one client's jobs that share a level -> edges
function edgesFor(list) {
  const edges = [];
  const open = list.filter((p) => p.open);
  const others = list.filter((p) => !p.open);
  // blocking by identity word so a client with hundreds of jobs stays fast: two jobs can only match when they share a word
  // (a shared external id is the other way in)
  const byWord = new Map();
  list.forEach((p, i) => p.id.forEach((w) => { if (!byWord.has(w)) byWord.set(w, []); byWord.get(w).push(i); }));
  const byExt = new Map();
  list.forEach((p, i) => p.ext.forEach((x) => { if (!byExt.has(x)) byExt.set(x, []); byExt.get(x).push(i); }));
  const seen = new Set();
  const tryPair = (i, k) => {
    if (i === k) return;
    const key = i < k ? `${i}:${k}` : `${k}:${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    const r = compare(list[i], list[k]);
    if (r) edges.push({ a: list[i], b: list[k], ...r });
  };
  byWord.forEach((idx) => {
    if (idx.length > 400) return; // a word every job has (e.g. 'faculty' at a big college): the other words decide
    for (let x = 0; x < idx.length; x += 1) for (let y = x + 1; y < idx.length; y += 1) tryPair(idx[x], idx[y]);
  });
  byExt.forEach((idx) => { for (let x = 0; x < idx.length; x += 1) for (let y = x + 1; y < idx.length; y += 1) tryPair(idx[x], idx[y]); });
  // a very common word (a college with 400 'faculty' jobs) is skipped above; its jobs are still compared on their rarer words
  void open; void others;
  return edges;
}

// union-find clusters, highest level first; a job sits in at most one cluster
function clustersOf(edges, decided) {
  const out = [];
  const taken = new Set();
  const live = edges.filter((e) => !decided.has(pairKey(e.a.j.id, e.b.j.id)));
  for (const level of LEVELS) {
    const es = live.filter((e) => e.level === level && !taken.has(e.a.j.id) && !taken.has(e.b.j.id));
    const parent = new Map();
    const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let c = x; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
    es.forEach((e) => { [e.a.j.id, e.b.j.id].forEach((x) => { if (!parent.has(x)) parent.set(x, x); }); parent.set(find(e.a.j.id), find(e.b.j.id)); });
    const groups = new Map();
    es.forEach((e) => { const r = find(e.a.j.id); if (!groups.has(r)) groups.set(r, { ids: new Set(), edges: [] }); const g = groups.get(r); g.ids.add(e.a.j.id); g.ids.add(e.b.j.id); g.edges.push(e); });
    groups.forEach((g) => {
      g.ids.forEach((id) => taken.add(id));
      const jobs = [...g.ids];
      const best = g.edges.reduce((m, e) => (e.score > m ? e.score : m), 0);
      const reasons = [...new Set(g.edges.flatMap((e) => e.reasons))].slice(0, 6);
      out.push({ level, clientId: g.edges[0].a.j.clientId, jobIds: jobs, score: best, reasons, codes: [...new Set(g.edges.flatMap((e) => e.codes))], edges: g.edges.map((e) => ({ a: e.a.j.id, b: e.b.j.id, level: e.level, reasons: e.reasons })) });
    });
  }
  return out;
}

// All clusters on file, cached.
//   hard bump  (our own actions: merge, undo, Not a duplicate, add openings, close the extra) -> the next ask rebuilds and waits
//   soft bump  (any other job being saved) -> the cache is served while a rebuild runs in the background (at most once a minute)
//   a cold start builds once (about 3-5 s on 4,300 jobs); the red count on the tab never waits for it
async function rebuild() {
  if (CACHE.building) return CACHE.building;
  CACHE.building = (async () => {
    const t0 = Date.now();
    const v = VERSION;
    const list = await loadAll();
    const decided = await decisions();
    const byClient = new Map();
    list.forEach((p) => { if (!byClient.has(p.j.clientId)) byClient.set(p.j.clientId, []); byClient.get(p.j.clientId).push(p); });
    const edges = [];
    byClient.forEach((l) => { if (l.length > 1) edges.push(...edgesFor(l)); });
    const clusters = clustersOf(edges, decided);
    const byId = new Map(list.map((p) => [p.j.id, p]));
    const data = { clusters, byId, jobs: list.length, edges: edges.length, ms: Date.now() - t0, at: Date.now() };
    CACHE = { at: Date.now(), version: v, data, building: null };
    if (v === VERSION) HARD = false; // a hard bump that arrived during the build keeps the next ask rebuilding
    return data;
  })().catch((e) => { CACHE.building = null; throw e; });
  return CACHE.building;
}
async function everything({ force = false } = {}) {
  if (force) { EXT = { at: 0, map: null }; DEC = { at: 0, set: null }; HARD = true; }
  if (HARD && CACHE.building) await CACHE.building.catch(() => null); // a build that began before the change is not the answer
  if (CACHE.data && !HARD) {
    const age = Date.now() - CACHE.at;
    if (CACHE.version === VERSION && age < 600000) return CACHE.data;
    if (age < 1800000) { if (age > 60000 && !CACHE.building) rebuild().catch(() => null); return CACHE.data; }
  }
  return rebuild();
}
// what is cached right now (null on a cold start; a build is started in the background)
function peek() {
  const age = CACHE.data ? Date.now() - CACHE.at : Infinity;
  if (!CACHE.building && (!CACHE.data || (CACHE.version !== VERSION && age > 60000) || age > 600000)) rebuild().catch(() => null);
  return CACHE.data;
}
const isHard = () => HARD;
function clusterOfJob(data, id) { return data.clusters.find((c) => c.jobIds.includes(id)) || null; }

// --- is THIS new job already on file? (creation; one indexed read by client) ----------------
// draft = { clientId, title, specialisation, location, openings, experience, salary, employmentType, skills, jobDescription, description, department }
// -> [{ level, reasons, job }]  best first; closed jobs come back with level 'CLOSED' (information, never blocks)
async function matchesForNew(draft, { excludeId = null } = {}) {
  if (!draft || !draft.clientId || !String(draft.title || '').trim() || draft.internal) return [];
  const rows = await prisma.requirement.findMany({
    where: { clientId: draft.clientId, internal: false, status: { not: 'DRAFT' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: SELECT, orderBy: { createdAt: 'desc' }, take: 800,
  });
  if (!rows.length) return [];
  const ext = rows.length ? await externalIds() : new Map();
  const fresh = prep({ ...draft, id: '__new__', status: 'OPEN', createdAt: new Date(), internal: false }, []);
  const decided = await decisions();
  const out = [];
  for (const r of rows) {
    // a cheap look first (the words of the title and specialisation); the full comparison only for jobs that could be twins
    const rt = new Set([...FP.titleTokens(r.title), ...FP.specTokens(r.specialisation)]);
    const hasExt = (ext.get(r.id) || []).length > 0;
    if (!hasExt && FP.jaccard(fresh.id, rt) < 0.5 && FP.containment(fresh.id, rt) < 1) continue;
    const p = prep(r, ext.get(r.id));
    if (decided.has(pairKey('__new__', r.id))) continue;
    const c = compare(fresh, p);
    if (c) { out.push({ level: c.level, reasons: c.reasons, score: c.score, job: r }); continue; }
    if (isClosed(r.status) && fresh.id.size && FP.jaccard(fresh.id, p.id) === 1) {
      const loc = FP.sameLocation(fresh.city, p.city);
      const recently = Date.now() - ts(r.updatedAt) < 45 * DAY;
      if (loc !== 'different' && recently) out.push({ level: 'CLOSED', reasons: ['Same requirement, closed recently'], score: 5, job: r });
    }
  }
  out.sort((a, b) => (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0) || b.score - a.score);
  return out.slice(0, 5);
}

module.exports = {
  LEVELS, LEVEL_RANK, TEST_MARK, supported, forgetSupport, settings, saveSettings, decisions, rememberNotDuplicate, forgetDecision, pairKey,
  everything, peek, isHard, clusterOfJob, matchesForNew, compare, prep, bump, version, newId, q, ex, json, isOpen, isClosed, SELECT, ts, DAY,
};
