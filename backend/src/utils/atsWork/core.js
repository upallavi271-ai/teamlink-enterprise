// ---------------------------------------------------------------------------
// ATS WORK - the shared base (founder ATS audit, round 3): the Admin switches and numbers, the raw tables, the small helpers.
// Everything that notifies real people or turns on an automation is OFF here until an Admin switches it on
// (Administration -> Step timing -> "Work allocation and automation"). Tables are created on first use, no migration.
// Settings live in the Integration table as an internal row (the pattern of utils/atsAlertSettings.js).
// ---------------------------------------------------------------------------
const prisma = require('../../db');

const STORE_ID = 'ats-work';
// New requirements need a recruiter before they are posted from this day on (older ones are never held back).
const REQUIRE_RECRUITER_FROM = '2026-11-18';

const DEFAULTS = {
  autoAssign: { enabled: false, count: 1 },
  requireRecruiter: { enabled: true, from: REQUIRE_RECRUITER_FROM },
  weights: { joinings: 40, submissions: 20, interviews: 15, activity: 15, eod: 10 },
  underperformer: { enabled: true, threshold: 50, weeks: 3 },
  leaderboard: { recruitersSee: true }, // founder 2026-11-18: ON by default; an Admin can turn it off
  aiShortlistApproval: { enabled: false },
  onHoldPause: { enabled: false },
  closeNotify: { enabled: false },
  payoutProposal: { enabled: false },
  eventDedupe: { enabled: true },
  autoRetry: { enabled: false },
  ownership: { validityDays: 90 },
  sla: { workingDaysOnly: false, businessHoursOnly: false, startHour: 9, endHour: 18 },
  joiningProof: { required: false },
};

const bool = (v, d) => (v === true || v === false ? v : d);
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };

function normalise(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const g = (k) => (v[k] && typeof v[k] === 'object' ? v[k] : {});
  const w = g('weights');
  const weights = {};
  Object.keys(DEFAULTS.weights).forEach((k) => { weights[k] = int(w[k], 0, 100, DEFAULTS.weights[k]); });
  const rr = g('requireRecruiter');
  return {
    autoAssign: { enabled: bool(g('autoAssign').enabled, false), count: int(g('autoAssign').count, 1, 5, 1) },
    requireRecruiter: { enabled: bool(rr.enabled, true), from: /^\d{4}-\d{2}-\d{2}$/.test(String(rr.from || '')) ? rr.from : REQUIRE_RECRUITER_FROM },
    weights,
    underperformer: { enabled: bool(g('underperformer').enabled, true), threshold: int(g('underperformer').threshold, 1, 100, 50), weeks: int(g('underperformer').weeks, 1, 12, 3) },
    leaderboard: { recruitersSee: bool(g('leaderboard').recruitersSee, true) },
    aiShortlistApproval: { enabled: bool(g('aiShortlistApproval').enabled, false) },
    onHoldPause: { enabled: bool(g('onHoldPause').enabled, false) },
    closeNotify: { enabled: bool(g('closeNotify').enabled, false) },
    payoutProposal: { enabled: bool(g('payoutProposal').enabled, false) },
    eventDedupe: { enabled: bool(g('eventDedupe').enabled, true) },
    autoRetry: { enabled: bool(g('autoRetry').enabled, false) },
    ownership: { validityDays: int(g('ownership').validityDays, 7, 730, 90) },
    sla: {
      workingDaysOnly: bool(g('sla').workingDaysOnly, false),
      businessHoursOnly: bool(g('sla').businessHoursOnly, false),
      startHour: int(g('sla').startHour, 0, 23, 9),
      endHour: int(g('sla').endHour, 1, 24, 18),
    },
    joiningProof: { required: bool(g('joiningProof').required, false) },
  };
}

let CACHE = { at: 0, settings: normalise(null) };
async function load({ maxAgeMs = 5000 } = {}) {
  if (Date.now() - CACHE.at < maxAgeMs) return CACHE.settings;
  const row = await prisma.integration.findUnique({ where: { id: STORE_ID } }).catch(() => null);
  let parsed = null;
  try { parsed = row && row.values ? JSON.parse(row.values) : null; } catch { parsed = null; }
  CACHE = { at: Date.now(), settings: normalise(parsed) };
  return CACHE.settings;
}
const now = () => CACHE.settings;

// patch: { section: { key: value } }. Returns { settings, before } or { error }.
async function save(patch) {
  const before = await load({ maxAgeMs: 0 });
  const next = JSON.parse(JSON.stringify(before));
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.weights) {
    for (const [k, v] of Object.entries(p.weights)) {
      if (!(k in DEFAULTS.weights)) continue;
      if (int(v, 0, 100, null) === null) return { error: `${k}: write a number from 0 to 100.` };
    }
  }
  for (const [sec, vals] of Object.entries(p)) {
    if (!(sec in DEFAULTS) || !vals || typeof vals !== 'object') continue;
    next[sec] = { ...next[sec], ...vals };
  }
  const clean = normalise(next);
  if (Object.values(clean.weights).reduce((a, b) => a + b, 0) <= 0) return { error: 'At least one score weight must be above 0.' };
  await prisma.integration.upsert({
    where: { id: STORE_ID },
    create: { id: STORE_ID, enabled: true, state: 'Internal', values: JSON.stringify(clean) },
    update: { values: JSON.stringify(clean) },
  });
  CACHE = { at: Date.now(), settings: clean };
  return { settings: clean, before };
}

// ------------------------------------------------------------------ tables
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const run = (sql) => prisma.$executeRawUnsafe(sql);
      await run(`CREATE TABLE IF NOT EXISTS "AtsWorkTarget" ("userId" TEXT NOT NULL, "period" TEXT NOT NULL, "metric" TEXT NOT NULL, "value" REAL NOT NULL,
        "setById" TEXT, "setByName" TEXT, "updatedAt" TEXT NOT NULL, PRIMARY KEY ("userId","period","metric"))`);
      await run(`CREATE TABLE IF NOT EXISTS "AtsEodConfirm" ("userId" TEXT NOT NULL, "day" TEXT NOT NULL, "confirmedAt" TEXT NOT NULL, "note" TEXT, PRIMARY KEY ("userId","day"))`);
      await run(`CREATE TABLE IF NOT EXISTS "AtsEventDedupe" ("eventType" TEXT NOT NULL, "eventKey" TEXT NOT NULL, "createdAt" TEXT NOT NULL, PRIMARY KEY ("eventType","eventKey"))`);
      await run(`CREATE TABLE IF NOT EXISTS "AtsFailedStep" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "kind" TEXT NOT NULL, "refId" TEXT, "label" TEXT, "payload" TEXT,
        "error" TEXT, "tries" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'Failed', "nextTryAt" TEXT, "lastTryAt" TEXT, "createdAt" TEXT NOT NULL, "resolvedAt" TEXT)`);
      await run(`CREATE TABLE IF NOT EXISTS "AtsOwnershipDispute" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "candidateId" TEXT NOT NULL, "candidateName" TEXT, "claimantId" TEXT NOT NULL,
        "claimantName" TEXT, "holderId" TEXT, "holderName" TEXT, "evidence" TEXT, "status" TEXT NOT NULL DEFAULT 'Open', "winnerId" TEXT, "winnerName" TEXT, "decision" TEXT,
        "decidedById" TEXT, "decidedByName" TEXT, "decidedAt" TEXT, "createdAt" TEXT NOT NULL)`);
      await run(`CREATE TABLE IF NOT EXISTS "AtsPayoutProposal" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "applicationId" TEXT NOT NULL, "kind" TEXT NOT NULL, "personId" TEXT, "personName" TEXT,
        "candidateName" TEXT, "jobTitle" TEXT, "clientName" TEXT, "invoiceId" TEXT, "amount" REAL, "note" TEXT, "status" TEXT NOT NULL DEFAULT 'Pending', "decidedById" TEXT,
        "decidedByName" TEXT, "decidedAt" TEXT, "createdAt" TEXT NOT NULL)`);
      await run('CREATE UNIQUE INDEX IF NOT EXISTS "AtsPayoutProposal_one" ON "AtsPayoutProposal" ("applicationId","kind")');
      await run(`CREATE TABLE IF NOT EXISTS "AtsApprovalDelegation" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "fromUserId" TEXT NOT NULL, "toUserId" TEXT NOT NULL, "toName" TEXT,
        "fromDate" TEXT NOT NULL, "toDate" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "revokedAt" TEXT)`);
      await run('CREATE TABLE IF NOT EXISTS "AtsRequirementPause" ("requirementId" TEXT PRIMARY KEY, "pausedAt" TEXT NOT NULL, "pausedById" TEXT, "resumedAt" TEXT)');
      await run(`CREATE TABLE IF NOT EXISTS "AtsShortlistApproval" ("applicationId" TEXT PRIMARY KEY, "requirementId" TEXT, "candidateName" TEXT, "jobTitle" TEXT, "aiScore" INTEGER,
        "resumeScore" INTEGER, "reasons" TEXT, "status" TEXT NOT NULL DEFAULT 'Pending', "decidedById" TEXT, "decidedByName" TEXT, "decidedAt" TEXT, "createdAt" TEXT NOT NULL)`);
      await run('CREATE TABLE IF NOT EXISTS "AtsMatchRun" ("requirementId" TEXT PRIMARY KEY, "ranAt" TEXT NOT NULL, "goodFit" INTEGER, "total" INTEGER, "top" TEXT)');
      await run(`CREATE TABLE IF NOT EXISTS "AtsJoiningProof" ("applicationId" TEXT PRIMARY KEY, "fileName" TEXT, "mime" TEXT, "data" TEXT, "uploadedById" TEXT, "uploadedByName" TEXT, "uploadedAt" TEXT NOT NULL)`);
      await run(`CREATE TABLE IF NOT EXISTS "AtsReassignLog" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "fromUserId" TEXT, "fromName" TEXT, "toUserId" TEXT, "toName" TEXT, "what" TEXT,
        "count" INTEGER, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`);
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const q = async (sql, ...a) => { await ensure(); return prisma.$queryRawUnsafe(sql, ...a); };
const x = async (sql, ...a) => { await ensure(); return prisma.$executeRawUnsafe(sql, ...a); };
const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------ event dedupe (Audit 619)
// claimEvent(type, key) -> true the FIRST time, false when the same event was already processed. With the switch off it always says true.
async function claimEvent(type, key) {
  const s = await load();
  if (!s.eventDedupe.enabled) return true;
  try {
    const n = await x('INSERT OR IGNORE INTO "AtsEventDedupe" ("eventType","eventKey","createdAt") VALUES (?,?,?)', String(type), String(key), nowIso());
    return Number(n) > 0;
  } catch { return true; } // a guard that cannot answer never blocks the work
}
async function releaseEvent(type, key) {
  try { await x('DELETE FROM "AtsEventDedupe" WHERE "eventType" = ? AND "eventKey" = ?', String(type), String(key)); } catch { /* none */ }
}

// ------------------------------------------------------------------ failed steps (Audit 618)
const KINDS = { 'resume-ai': 'Resume AI', matching: 'Candidate matching', posting: 'Posting', message: 'Message', other: 'Step' };
async function recordFailure({ kind = 'other', refId = null, label = null, payload = null, error = null }) {
  try {
    const hit = (await q('SELECT "id" FROM "AtsFailedStep" WHERE "kind" = ? AND "refId" IS ? AND "status" = \'Failed\' LIMIT 1', kind, refId))[0];
    if (hit) {
      await x('UPDATE "AtsFailedStep" SET "error" = ?, "lastTryAt" = ? WHERE "id" = ?', String(error || '').slice(0, 500), nowIso(), Number(hit.id));
      return Number(hit.id);
    }
    await x('INSERT INTO "AtsFailedStep" ("kind","refId","label","payload","error","tries","status","nextTryAt","createdAt") VALUES (?,?,?,?,?,0,\'Failed\',?,?)',
      kind, refId, label || KINDS[kind] || kind, payload ? JSON.stringify(payload) : null, String(error || '').slice(0, 500), new Date(Date.now() + 15 * 60000).toISOString(), nowIso());
    const [row] = await q('SELECT last_insert_rowid() AS id');
    return Number(row.id);
  } catch { return null; }
}

module.exports = {
  STORE_ID, DEFAULTS, REQUIRE_RECRUITER_FROM, KINDS, load, now, save, normalise, ensure, q, x, nowIso, claimEvent, releaseEvent, recordFailure,
};
