// ---------------------------------------------------------------------------
// ONE PIPELINE PER INDUSTRY (ATS audit 2026-11-18, Q8 / Q171 / Q173-Q176 / Q178).
//
// The stage CODES stay fixed (permissions, offers, joining, reports and workers key on them: utils/atsFlowConfig.js says why), but each
// DEPARTMENT (Medical, Education, Manufacturing, IT, BDE ...) now has its own pipeline settings, set by a Super Admin / Admin in
// Administration > Company Setup > Pipeline & checks > "Industry pipelines":
//
//   USED / NOT USED   A step an industry does not use (Medical does not run the AI interview, Manufacturing has no BDE step) is switched
//                     off for that department only. A candidate of that department cannot be moved INTO it ("Medical does not use ...");
//                     the screens do not offer it. Candidates already standing on it are left alone and can move on.
//   APPROVAL          A step can need approval from a TL / STL / Manager / Admin. Anyone below that level who tries to move a candidate
//                     into it is stopped, and the approvers (the requirement's TL / STL, or every Manager / Admin login) get a notice
//                     "X asks to move NAME to STEP: you can move it". The approver then moves the candidate (that move is the approval).
//   NOT CHANGEABLE    The steps the offer, joining, client and invoice flows depend on are always used: New, Sent to client, Interview
//                     booked, Selected, Offer, Offer accepted, Joined, Hired. Hold and Rejected are always possible.
//   DEFAULT           Nothing is configured = every department uses every step with no extra approval = how it worked before.
//
// Raw table, created on first use (the atsFlowConfig.js pattern). Every change is audited by the route.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const V = require('./atsVocab');
const { canonicalDepartment } = require('./bdeDesk');
const { notifyUsers } = require('./notify');

const MANDATORY = ['NEW', 'SHARED_WITH_CLIENT', 'INTERVIEW_SCHEDULED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];
const OPTIONAL = V.STAGE_CODES.filter((c) => !MANDATORY.includes(c));
const APPROVERS = ['TL', 'STL', 'MANAGER', 'ADMIN'];
const RANK = { RECRUITER: 1, BDE: 1, TL: 2, STL: 3, ASSISTANT_MANAGER: 4, MANAGER: 5, ADMIN: 6, SUPER_ADMIN: 7 };
const APPROVER_RANK = { TL: 2, STL: 3, MANAGER: 5, ADMIN: 6 };
const rankOf = (user) => Math.max(0, ...[user && user.atsRole, user && user.role].filter(Boolean).map((r) => RANK[r] || 0));

let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "AtsDeptPipeline" ("department" TEXT NOT NULL, "stage" TEXT NOT NULL, "enabled" INTEGER NOT NULL DEFAULT 1, "approverRole" TEXT, "byName" TEXT, "at" TEXT NOT NULL, PRIMARY KEY ("department", "stage"))')
      .catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const deptKey = (name) => canonicalDepartment(name) || null;

let cache = null; let cachedAt = 0;
// -> { [department]: { [stage]: { enabled, approverRole } } }  (only rows that differ from the default exist)
async function all({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 15000) return cache;
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT "department","stage","enabled","approverRole" FROM "AtsDeptPipeline"');
  const out = {};
  rows.forEach((r) => { (out[r.department] = out[r.department] || {})[r.stage] = { enabled: Number(r.enabled) !== 0, approverRole: r.approverRole || null }; });
  cache = out; cachedAt = Date.now();
  return out;
}

async function departments() {
  const names = new Set(Object.keys(await all()));
  const rows = await prisma.requirement.findMany({ distinct: ['department'], select: { department: true }, take: 200 }).catch(() => []);
  rows.forEach((r) => { const k = deptKey(r.department); if (k) names.add(k); });
  return [...names].sort();
}

// raw department spelling on a requirement -> the department name the settings are kept under (Educational -> Education ...)
async function aliases() {
  const out = {};
  const rows = await prisma.requirement.findMany({ distinct: ['department'], select: { department: true }, take: 200 }).catch(() => []);
  rows.forEach((r) => { const k = deptKey(r.department); if (k && r.department !== k) out[r.department] = k; });
  return out;
}

// the settings of one department, with the defaults filled in, for the Admin screen and the web app
function view(cfg) {
  const stages = {};
  V.STAGE_CODES.forEach((c) => {
    const row = cfg && cfg[c];
    stages[c] = { enabled: row ? row.enabled : true, approverRole: row ? row.approverRole : null, mandatory: MANDATORY.includes(c) };
  });
  return stages;
}

async function save(department, input, user) {
  const dept = deptKey(department);
  if (!dept) return { error: 'Pick a department.' };
  await ensure();
  const bad = [];
  const rows = [];
  Object.entries(input && typeof input === 'object' ? input : {}).forEach(([code, v]) => {
    if (!V.STAGE_CODES.includes(code)) return;
    const enabled = !(v && (v.enabled === false || v.enabled === 0 || v.enabled === 'false'));
    const approverRole = v && APPROVERS.includes(v.approverRole) ? v.approverRole : null;
    if (!enabled && MANDATORY.includes(code)) { bad.push(V.STAGE_LABELS[code] || code); return; }
    if (enabled && !approverRole) return; // the default: no row
    rows.push({ code, enabled, approverRole });
  });
  if (bad.length) return { error: `These steps are used by the offer, joining and client flows and cannot be switched off: ${bad.join(', ')}.` };
  const at = new Date().toISOString();
  await prisma.$executeRawUnsafe('DELETE FROM "AtsDeptPipeline" WHERE "department" = ?', dept);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe('INSERT INTO "AtsDeptPipeline" ("department","stage","enabled","approverRole","byName","at") VALUES (?,?,?,?,?,?)', dept, r.code, r.enabled ? 1 : 0, r.approverRole, user ? user.name || null : null, at);
  }
  cache = null;
  return { department: dept, stages: view((await all({ fresh: true }))[dept]) };
}

async function reset(department) {
  const dept = deptKey(department);
  if (!dept) return { error: 'Pick a department.' };
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "AtsDeptPipeline" WHERE "department" = ?', dept);
  cache = null;
  return { department: dept, stages: view(null) };
}

// ---- the gate every stage move passes (routes/applications.js applyStageMove) --------------------------------------------------
const asked = new Map(); // "applicationId|stage|userId" -> time of the last notice (one an hour)
async function gate(existing, toStage, user, { viaFlow = false } = {}) {
  try {
    if (viaFlow || !toStage || ['HOLD', 'REJECTED'].includes(toStage) || existing.stage === toStage) return null;
    // A CLIENT'S OWN PIPELINE (market wave B 02.09, utils/mktb/jobs.js) is checked first: when the client has a rule for this step it decides.
    const byClient = await require('./mktb/jobs').clientGate(existing, toStage, user, { viaFlow }); // eslint-disable-line global-require
    if (byClient) return byClient.pass ? null : byClient;
    const dept = deptKey(existing.requirement && existing.requirement.department);
    if (!dept) return null;
    const cfg = (await all())[dept];
    const row = cfg && cfg[toStage];
    if (!row) return null;
    const exempt = require('./permissions').stageGlobal(user); // eslint-disable-line global-require
    const label = V.STAGE_LABELS[toStage] || toStage;
    if (row.enabled === false && !MANDATORY.includes(toStage) && !exempt) {
      return { status: 409, body: { error: `${dept} does not use the "${label}" step. Move the candidate to the next step ${dept} uses.`, code: 'PIPELINE_STAGE_OFF', stage: toStage, department: dept } };
    }
    if (row.approverRole && !exempt && rankOf(user) < (APPROVER_RANK[row.approverRole] || 99)) {
      const who = existing.candidate ? existing.candidate.name : 'a candidate';
      const key = `${existing.id}|${toStage}|${user.id}`;
      let notified = false;
      if (!asked.has(key) || Date.now() - asked.get(key) > 3600000) {
        asked.set(key, Date.now());
        const r = existing.requirement || {};
        let ids = [r.tlId, r.stlId].filter(Boolean);
        if (['MANAGER', 'ADMIN'].includes(row.approverRole)) {
          const people = await prisma.user.findMany({ where: { OR: [{ role: { in: ['MANAGER', 'ADMIN', 'SUPER_ADMIN'] } }, { atsRole: { in: ['MANAGER', 'ADMIN', 'SUPER_ADMIN'] } }] }, select: { id: true, name: true, email: true } }).catch(() => []);
          ids = [...ids, ...people.filter((p) => !/zztest|example\.test/i.test(`${p.name} ${p.email}`)).map((p) => p.id)];
        }
        await notifyUsers(ids, { title: `Approval asked: ${label}`, message: `${user.name || 'A recruiter'} asks to move ${who} (${r.title || 'a requirement'}) to "${label}" in ${dept}. ${row.approverRole} approval is needed: open the candidate and move it if you agree.`, exceptUserId: user.id }).catch(() => {});
        notified = true;
      }
      return { status: 403, body: { error: `In ${dept}, moving a candidate to "${label}" needs ${row.approverRole === 'TL' ? 'a TL' : `a ${row.approverRole.toLowerCase()}`} (or above). ${notified ? 'Your approvers have been told.' : 'Your approvers were already told.'}`, code: 'APPROVAL_REQUIRED', stage: toStage, department: dept, approverRole: row.approverRole } };
    }
    return null;
  } catch (err) {
    console.error('[dept-pipelines]', err.message); // eslint-disable-line no-console
    return null; // a settings problem never blocks a move
  }
}

module.exports = { MANDATORY, OPTIONAL, APPROVERS, all, departments, aliases, view, save, reset, gate, deptKey };
