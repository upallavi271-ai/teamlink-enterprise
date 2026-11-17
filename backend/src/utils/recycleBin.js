// ---------------------------------------------------------------------------
// RECYCLE BIN (ATS audit 7 / 153, founder 2026-11-17 "build what is not built"). Deleting a candidate (a duplicate or a wrong
// entry - the only deletes the app allows) used to remove it for good; the only way back was a database backup. Now the row and
// its applications are kept here for 90 days and an Admin restores them in one click (Administration -> Audit Logs -> Recycle bin),
// with the same ids, so links and history line up again. Raw table "RecycleBin" (created on first use, no migration).
//   put({ entity, entityId, name, data, user, reason })
//   list()                         the last 90 days
//   restore(id, user)              -> { ok, entity, entityId } | { error }
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const KEEP_DAYS = 90;
let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "RecycleBin" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "entity" TEXT NOT NULL, "entityId" TEXT NOT NULL,
      "name" TEXT, "data" TEXT NOT NULL, "deletedById" TEXT, "deletedByName" TEXT, "deletedAt" TEXT NOT NULL, "reason" TEXT, "restoredAt" TEXT, "restoredByName" TEXT)`)
      .catch((e) => { READY = null; throw e; });
  }
  return READY;
}
async function put({ entity, entityId, name, data, user, reason }) {
  await ensure();
  await prisma.$executeRawUnsafe('INSERT INTO "RecycleBin" ("entity","entityId","name","data","deletedById","deletedByName","deletedAt","reason") VALUES (?,?,?,?,?,?,?,?)',
    entity, String(entityId), name || null, JSON.stringify(data), user && user.id, user && user.name, new Date().toISOString(), reason || null);
}
async function list() {
  await ensure();
  const since = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
  const rows = await prisma.$queryRawUnsafe('SELECT "id","entity","entityId","name","deletedByName","deletedAt","reason","restoredAt","restoredByName" FROM "RecycleBin" WHERE "deletedAt" >= ? ORDER BY "id" DESC LIMIT 500', since);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
// Dates come back from JSON as strings; Prisma takes ISO strings for DateTime fields, so the scalars go back as they were.
const scalarsOf = (row, drop = []) => Object.fromEntries(Object.entries(row || {}).filter(([k, v]) => !drop.includes(k) && (v === null || typeof v !== 'object')));
async function restore(id, user) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "RecycleBin" WHERE "id" = ?', Number(id));
  if (!r) return { error: 'That item is not in the recycle bin.' };
  if (r.restoredAt) return { error: `Already restored on ${new Date(r.restoredAt).toLocaleDateString('en-GB')} by ${r.restoredByName || 'someone'}.` };
  const data = JSON.parse(r.data);
  if (r.entity === 'Candidate') {
    if (await prisma.candidate.findUnique({ where: { id: r.entityId }, select: { id: true } })) return { error: 'A candidate with this id is already back.' };
    await prisma.$transaction(async (tx) => {
      await tx.candidate.create({ data: scalarsOf(data.candidate) });
      for (const a of data.applications || []) {
        // eslint-disable-next-line no-await-in-loop
        await tx.application.create({ data: scalarsOf(a) });
      }
    });
    try { require('./candidateListCache').markCandidateDirty(r.entityId); } catch { /* the list catches up */ } // eslint-disable-line global-require
  } else return { error: `Restoring a ${r.entity} is not supported.` };
  await prisma.$executeRawUnsafe('UPDATE "RecycleBin" SET "restoredAt" = ?, "restoredByName" = ? WHERE "id" = ?', new Date().toISOString(), user && user.name, Number(id));
  await logAudit({ userId: user && user.id, action: `${r.entity} restored from the recycle bin`, entity: r.entity, entityId: r.entityId, toValue: r.name, reason: `Deleted ${new Date(r.deletedAt).toLocaleDateString('en-GB')} by ${r.deletedByName || '—'}` });
  return { ok: true, entity: r.entity, entityId: r.entityId, name: r.name };
}
async function prune() {
  await ensure();
  await prisma.$executeRawUnsafe('DELETE FROM "RecycleBin" WHERE "deletedAt" < ?', new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
}

module.exports = { put, list, restore, prune, KEEP_DAYS };
