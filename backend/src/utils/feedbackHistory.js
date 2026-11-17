// ---------------------------------------------------------------------------
// INTERVIEW FEEDBACK, EVERY ROUND (ATS audit P5.8 / 77 / Q99, founder 2026-11-17 "build what is not built"). InterviewFeedback keeps one
// row per application per side (Internal / Client), so round 2's feedback overwrote round 1's, and an edit overwrote the first answer.
// Every save is now also written here (round, scores, overall, recommendation, who, when) and never changed, so the calendar shows
// each round's feedback and every edit. Raw table "InterviewFeedbackHistory" (created on first use, no migration).
// ---------------------------------------------------------------------------
const prisma = require('../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "InterviewFeedbackHistory" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "applicationId" TEXT NOT NULL,
        "kind" TEXT NOT NULL, "round" INTEGER, "technical" INTEGER, "communication" INTEGER, "experience" INTEGER, "roleFit" INTEGER,
        "overall" TEXT, "recommendation" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "IFH_app" ON "InterviewFeedbackHistory" ("applicationId","at")');
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
async function record(applicationId, kind, round, data, user) {
  await ensure();
  const n = (v) => (v == null || v === '' ? null : Number(v));
  await prisma.$executeRawUnsafe('INSERT INTO "InterviewFeedbackHistory" ("applicationId","kind","round","technical","communication","experience","roleFit","overall","recommendation","byId","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    String(applicationId), kind, round == null ? null : Number(round), n(data.technical), n(data.communication), n(data.experience), n(data.roleFit),
    data.overall || null, data.recommendation || null, user && user.id, user && user.name, new Date().toISOString());
}
async function forApplication(applicationId, { client = false } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "InterviewFeedbackHistory" WHERE "applicationId" = ? ORDER BY "id" ASC', String(applicationId));
  return rows.filter((r) => !client || r.kind === 'Client').map((r) => ({ ...r, id: Number(r.id), round: r.round == null ? null : Number(r.round) }));
}

module.exports = { record, forApplication };
