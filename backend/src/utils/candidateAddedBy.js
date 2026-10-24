// ---------------------------------------------------------------------------
// WHO ADDED THIS PERSON (founder, 2026-10-23: a candidate typed in by hand must show up, on top, and be found by search).
//
// A recruiter / TL reaches a candidate only through an application on a requirement in their scope. A person added by hand (or by a
// resume upload) and NOT yet put on any requirement has no application, so the person who just added them could not see them
// anywhere - not in the list, not in search, not even on their profile. This remembers who added each person; that login keeps seeing
// them (and may open them, edit them and put them on a requirement) until an application exists. Nobody else's reach changes.
//
// Self-provisioned raw-SQL table (no Prisma model, no `prisma generate`), created on first use, ADDITIVE ONLY:
//   CandidateAddedBy(candidateId PRIMARY KEY, userId, userName, via, createdAt)
// ensure() never throws; every function answers "nothing" if the table cannot be used, so the old behaviour is the fallback.
// ---------------------------------------------------------------------------
const prisma = require('../db');

let ready = null;
let counter = 0;
const cache = new Map(); // userId -> { at, ids:Set }
const TTL_MS = 30000;

async function ensure() {
  if (ready) return ready;
  ready = (async () => {
    try {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CandidateAddedBy" (
        "candidateId" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL,
        "userName" TEXT,
        "via" TEXT,
        "createdAt" TEXT NOT NULL
      )`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "CandidateAddedBy_user" ON "CandidateAddedBy" ("userId")');
      return true;
    } catch (e) {
      console.error(`[candidateAddedBy] table not available: ${e.message}`);
      ready = null;
      return false;
    }
  })();
  return ready;
}

// Bumped on every record(): part of the list cache keys, so a person added a moment ago is in the very next list.
const version = () => counter;

async function record(candidateId, user, via = 'manual') {
  if (!candidateId || !user || !user.id) return false;
  if (!(await ensure())) return false;
  try {
    await prisma.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "CandidateAddedBy" ("candidateId","userId","userName","via","createdAt") VALUES (?,?,?,?,?)',
      String(candidateId), String(user.id), String(user.name || '').slice(0, 120), String(via).slice(0, 40), new Date().toISOString(),
    );
    counter += 1;
    cache.delete(String(user.id));
    return true;
  } catch (e) {
    console.error(`[candidateAddedBy] not recorded for ${candidateId}: ${e.message}`);
    return false;
  }
}

// The ids this login added (a short memo; record() drops it at once).
async function idsOf(userId) {
  const key = String(userId || '');
  if (!key) return new Set();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  if (!(await ensure())) return new Set();
  try {
    const rows = await prisma.$queryRawUnsafe('SELECT "candidateId" FROM "CandidateAddedBy" WHERE "userId" = ?', key);
    const ids = new Set(rows.map((r) => r.candidateId));
    cache.set(key, { at: Date.now(), ids });
    return ids;
  } catch { return new Set(); }
}

async function addedBy(userId, candidateId) {
  return (await idsOf(userId)).has(String(candidateId));
}

module.exports = { ensure, record, idsOf, addedBy, version };
