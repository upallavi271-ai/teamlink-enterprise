// ---------------------------------------------------------------------------
// FIT SCORE HISTORY (checklist-168 #75, checklist-120 #65): every change of a person's Fit score for a requirement is kept - the score, the
// date, the version of the weights, and why it changed (added to the requirement, resume added, requirement changed, profile changed).
// The latest score is still the one on the application (Application.matchScore) and still drives everything; this table is the trail.
//
//   record({ applicationId, candidateId, requirementId, score, fitVersion, reason, user })   writes a row unless nothing changed
//   afterApplicationWrite(params, result)   Prisma hook (db.js): an application created / updated with a matchScore is recorded
//   historyOf(applicationId | candidateId)  newest first
//   rescoreCandidate(candidateId, reason)   after a resume is added / the profile changes: every open application is scored again
//   rescoreRequirementSoon(requirementId)   after a requirement's key fields change (debounced, in the background)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "FitScoreHistory" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "candidateId" TEXT NOT NULL, "requirementId" TEXT,
        "score" INTEGER, "fitVersion" INTEGER, "versionLabel" TEXT, "reason" TEXT NOT NULL, "at" TEXT NOT NULL, "byName" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "FitScoreHistory_app" ON "FitScoreHistory" ("applicationId","at")');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "FitScoreHistory_cand" ON "FitScoreHistory" ("candidateId","at")');
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const rm = () => require('./resumeMatch'); // eslint-disable-line global-require
const pending = new Map(); // applicationId -> { reason, byName } for the write that follows
const REASONS = {
  added: 'Added to the requirement', resume: 'Resume added', requirement: 'Requirement changed', profile: 'Profile changed', refreshed: 'Score recalculated', manual: 'Recalculated on request',
};

async function record({
  applicationId, candidateId, requirementId = null, score, fitVersion = null, reason, user = null,
}) {
  if (!applicationId || !candidateId || score == null || !Number.isFinite(Number(score))) return false;
  await ensure();
  const [last] = await prisma.$queryRawUnsafe('SELECT "score","fitVersion" FROM "FitScoreHistory" WHERE "applicationId" = ? ORDER BY "at" DESC, rowid DESC LIMIT 1', applicationId);
  const vn = Number(String(fitVersion == null ? '' : fitVersion).replace(/^fit-v/i, ''));
  const v = fitVersion != null && Number.isInteger(vn) && vn >= 1 ? vn : (rm().getActiveVersion ? rm().getActiveVersion() : null); // a stray value falls back to the active version
  if (last && Number(last.score) === Math.round(Number(score)) && (last.fitVersion == null ? null : Number(last.fitVersion)) === (v == null ? null : Number(v))) return false;
  let label = null;
  try { label = rm().versionLabel(v); } catch { label = v == null ? null : `v${v}`; }
  await prisma.$executeRawUnsafe('INSERT INTO "FitScoreHistory" ("id","applicationId","candidateId","requirementId","score","fitVersion","versionLabel","reason","at","byName") VALUES (?,?,?,?,?,?,?,?,?,?)',
    crypto.randomUUID(), applicationId, candidateId, requirementId, Math.round(Number(score)), v == null ? null : Number(v), label, String(reason || REASONS.refreshed).slice(0, 200), new Date().toISOString(), user ? user.name : null);
  return true;
}

// db.js hook. Never throws.
async function afterApplicationWrite(params, result) {
  try {
    if (!result || params.model !== 'Application') return;
    if (params.action !== 'create' && params.action !== 'update') return;
    const data = (params.args && params.args.data) || {};
    if (data.matchScore === undefined || data.matchScore === null || typeof data.matchScore === 'object') return;
    const p = pending.get(result.id);
    if (p) pending.delete(result.id);
    await record({
      applicationId: result.id, candidateId: result.candidateId, requirementId: result.requirementId, score: data.matchScore,
      fitVersion: data.matchVersion !== undefined ? data.matchVersion : null,
      reason: p ? p.reason : (params.action === 'create' ? REASONS.added : REASONS.refreshed), user: p ? { name: p.byName } : null,
    });
  } catch (e) { console.error('[score-history] hook:', e.message); } // eslint-disable-line no-console
}

async function historyOf({ applicationId = null, candidateId = null, appIds = null, limit = 100 }) {
  await ensure();
  let where = ''; const args = [];
  if (applicationId) { where = 'WHERE h."applicationId" = ?'; args.push(applicationId); } else if (appIds) {
    if (!appIds.length) return [];
    where = `WHERE h."applicationId" IN (${appIds.map(() => '?').join(',')})`; args.push(...appIds);
  } else if (candidateId) { where = 'WHERE h."candidateId" = ?'; args.push(candidateId); }
  const rows = await prisma.$queryRawUnsafe(`SELECT h.* FROM "FitScoreHistory" h ${where} ORDER BY h."at" DESC, h.rowid DESC LIMIT ?`, ...args, limit);
  const reqIds = [...new Set(rows.map((r) => r.requirementId).filter(Boolean))];
  const reqs = reqIds.length ? await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, reqCode: true, title: true } }) : [];
  const byReq = new Map(reqs.map((r) => [r.id, r]));
  return rows.map((r) => ({
    id: r.id, applicationId: r.applicationId, requirementId: r.requirementId, reqCode: byReq.get(r.requirementId) ? byReq.get(r.requirementId).reqCode : null,
    title: byReq.get(r.requirementId) ? byReq.get(r.requirementId).title : null, score: r.score, versionLabel: r.versionLabel, fitVersion: r.fitVersion, reason: r.reason, at: r.at, byName: r.byName,
  }));
}

const CLOSED = ['REJECTED', 'JOINED', 'HIRED', 'OFFER_ACCEPTED'];
async function rescoreApplications(where, reason, user = null) {
  const apps = await prisma.application.findMany({ where: { ...where, stage: { notIn: CLOSED } }, select: { id: true, candidateId: true, requirementId: true, matchScore: true }, take: 400 });
  if (!apps.length) return 0;
  const R = rm();
  await R.loadFitSettings().catch(() => null);
  const candIds = [...new Set(apps.map((a) => a.candidateId))];
  const reqIds = [...new Set(apps.map((a) => a.requirementId))];
  const [cands, reqs, evidence] = await Promise.all([
    prisma.candidate.findMany({ where: { id: { in: candIds } } }),
    prisma.requirement.findMany({ where: { id: { in: reqIds } } }),
    R.currentResumeEvidence(candIds),
  ]);
  const cMap = new Map(cands.map((c) => [c.id, c])); const rMap = new Map(reqs.map((r) => [r.id, r]));
  let changed = 0;
  for (const a of apps) {
    const c = cMap.get(a.candidateId); const r = rMap.get(a.requirementId);
    if (!c || !r) continue; // eslint-disable-line no-continue
    let score;
    try { score = R.threeNumbers(c, r, evidence.get(c.id)).overall; } catch { continue; } // eslint-disable-line no-continue
    if (score == null || Math.round(score) === Math.round(a.matchScore == null ? -1 : a.matchScore)) continue; // eslint-disable-line no-continue
    pending.set(a.id, { reason, byName: user ? user.name : null });
    const data = { matchScore: Math.round(score) };
    try { if (R.versionFields && R.versionFields()) data.matchVersion = R.versionCode(); } catch { /* the score alone is saved */ } // "fit-v2": the weights version the score was made with
    // eslint-disable-next-line no-await-in-loop
    await prisma.application.update({ where: { id: a.id }, data });
    changed += 1;
  }
  return changed;
}
const rescoreCandidate = (candidateId, reason = REASONS.resume, user = null) => rescoreApplications({ candidateId }, reason, user);
const rescoreRequirement = (requirementId, reason = REASONS.requirement, user = null) => rescoreApplications({ requirementId }, reason, user);

const timers = new Map();
function rescoreRequirementSoon(requirementId, delay = 4000) {
  if (process.env.TEST_NO_RESCORE === '1') return;
  clearTimeout(timers.get(requirementId));
  const t = setTimeout(() => { timers.delete(requirementId); rescoreRequirement(requirementId).catch(() => {}); }, delay);
  if (t.unref) t.unref();
  timers.set(requirementId, t);
}
// the fields of a requirement that move a Fit score
const REQUIREMENT_FIT_FIELDS = ['skills', 'goodToHaveSkills', 'experience', 'location', 'education', 'salary', 'salaryType', 'workMode', 'employmentType', 'specialisation', 'specialisationId', 'minFit'];
function afterRequirementWrite(params, result) {
  try {
    if (!result || params.model !== 'Requirement' || params.action !== 'update') return;
    const data = (params.args && params.args.data) || {};
    if (REQUIREMENT_FIT_FIELDS.some((f) => data[f] !== undefined)) rescoreRequirementSoon(result.id);
  } catch { /* the Fit catches up on the next change */ }
}

module.exports = {
  ensure, record, afterApplicationWrite, afterRequirementWrite, historyOf, rescoreCandidate, rescoreRequirement, rescoreRequirementSoon, REASONS, pending,
};
