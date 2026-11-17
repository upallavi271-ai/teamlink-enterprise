// ---------------------------------------------------------------------------
// OFFER ON HOLD (ATS audit 126, founder 2026-11-17): the candidate or the client asks to wait -> the offer is put ON HOLD with the reason (offer status unchanged).
// The offer keeps its status (every count still adds up); the hold, its reason, who and when are shown on the Offers row
// (`offerHold`), audited on and off. Raw table "OfferHold" (no migration).
// ---------------------------------------------------------------------------
const prisma = require('../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "OfferHold" ("applicationId" TEXT PRIMARY KEY, "reason" TEXT NOT NULL, "byName" TEXT, "at" TEXT NOT NULL)')
      .catch((e) => { READY = null; throw e; });
  }
  return READY;
}
async function mapOf(ids) {
  await ensure();
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "OfferHold" WHERE "applicationId" IN (${list.map(() => '?').join(',')})`, ...list);
  return new Map(rows.map((r) => [r.applicationId, { reason: r.reason, byName: r.byName, at: r.at }]));
}
async function of(id) { return (await mapOf([id])).get(id) || null; }
async function put(id, reason, byName) {
  await ensure();
  await prisma.$executeRawUnsafe('INSERT INTO "OfferHold" ("applicationId","reason","byName","at") VALUES (?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "reason"=excluded."reason","byName"=excluded."byName","at"=excluded."at"',
    String(id), String(reason).trim().slice(0, 500), byName || null, new Date().toISOString());
}
async function release(id) {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "OfferHold" WHERE "applicationId" = ?', String(id));
}
async function heldIds() {
  await ensure();
  return new Set((await prisma.$queryRawUnsafe('SELECT "applicationId" FROM "OfferHold"')).map((r) => r.applicationId));
}

module.exports = { ensure, mapOf, of, put, release, heldIds };
