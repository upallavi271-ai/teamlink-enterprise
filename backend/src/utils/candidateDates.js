// ---------------------------------------------------------------------------
// WHEN DID THEY REALLY COME — the marker, and the repair of dates imports got wrong (founder 2026-11-20: "when I import back-dated candidates,
// today's date comes. Fix that.").
//
// TWO small raw-SQL tables (self-provisioned, additive; no Prisma model):
//
//   CandidateDateMark(candidateId PK, kind, at, byName, via)
//       kind 'sheet'    the import carried the person's own date: Candidate.createdAt IS that date ("From the sheet")
//       kind 'unknown'  the import carried no date, so createdAt is the day of the import: shown as
//                       "Imported on <date> (original date not known)", never as the day they came
//       People who were typed in, applied on the portal or self-registered have NO mark: their createdAt is a real, system-recorded moment.
//
//   CandidateDateFix(id PK, batchId, candidateId, ...old / new createdAt, old / new mark, first application + first stage event dates, by, at, undoneAt)
//       one row per person changed by "Fix came-on dates from a sheet", so a whole batch can be UNDONE and nothing is ever lost.
//
// The came-on rule (utils/cameOn.js) reads the marks through marksMap() (cached; version() changes whenever a mark does, so list caches know).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { istDay } = require('./nextAction');

let READY = null;
let counter = 0;
let cache = null; // Map candidateId -> kind
const TABLES = [
  `CREATE TABLE IF NOT EXISTS "CandidateDateMark" ("candidateId" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "at" TEXT NOT NULL, "byName" TEXT, "via" TEXT)`,
  `CREATE TABLE IF NOT EXISTS "CandidateDateFix" ("id" TEXT PRIMARY KEY, "batchId" TEXT NOT NULL, "candidateId" TEXT NOT NULL,
    "oldCreatedAt" TEXT NOT NULL, "newCreatedAt" TEXT NOT NULL, "oldKind" TEXT, "oldDay" TEXT, "newDay" TEXT, "oldMark" TEXT,
    "appId" TEXT, "oldAppCreatedAt" TEXT, "newAppCreatedAt" TEXT, "eventId" TEXT, "oldEventAt" TEXT, "newEventAt" TEXT,
    "overwrote" INTEGER NOT NULL DEFAULT 0, "byUserId" TEXT, "byName" TEXT, "fileName" TEXT, "at" TEXT NOT NULL, "undoneAt" TEXT, "undoneByName" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "CandidateDateFix_batch" ON "CandidateDateFix" ("batchId")',
  'CREATE INDEX IF NOT EXISTS "CandidateDateFix_candidate" ON "CandidateDateFix" ("candidateId")',
];
function ensure() {
  if (!READY) {
    READY = (async () => {
      for (const sql of TABLES) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
      return true;
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const version = () => counter;
const now = () => new Date().toISOString();

// Every mark, as a Map (kept until a mark changes). Never throws: no marks = the old behaviour.
async function marksMap() {
  if (cache) return cache;
  try {
    await ensure();
    const rows = await prisma.$queryRawUnsafe('SELECT "candidateId", "kind" FROM "CandidateDateMark"');
    cache = new Map(rows.map((r) => [r.candidateId, r.kind]));
  } catch { return new Map(); }
  return cache;
}
const touched = () => { counter += 1; cache = null; };

async function mark(candidateId, kind, { byName = null, via = 'import' } = {}) {
  if (!candidateId || !['sheet', 'unknown'].includes(kind)) return false;
  try {
    await ensure();
    await prisma.$executeRawUnsafe(
      'INSERT OR REPLACE INTO "CandidateDateMark" ("candidateId","kind","at","byName","via") VALUES (?,?,?,?,?)',
      String(candidateId), kind, now(), byName ? String(byName).slice(0, 120) : null, String(via).slice(0, 40),
    );
    touched();
    try { require('./candidateListCache').markCandidateDirty(candidateId); } catch { /* the list reads it on its next refresh */ } // eslint-disable-line global-require
    return true;
  } catch (e) { console.error(`[candidateDates] mark not written for ${candidateId}: ${e.message}`); return false; }
}
async function unmark(candidateId) {
  try {
    await ensure();
    await prisma.$executeRawUnsafe('DELETE FROM "CandidateDateMark" WHERE "candidateId" = ?', String(candidateId));
    touched();
    return true;
  } catch { return false; }
}

const PORTAL_WORDS = new Set(['teamlink job portal', 'job portal']);
const isPortalSource = (v) => PORTAL_WORDS.has(String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase());
const chunks = (arr, n = 500) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// Who has a GENUINE date: typed in by a person, self-registered, referred, a partner submission, or applied on the job portal.
// Anyone with a mark is an import by definition (the mark says so).
async function genuineSet(ids, marks) {
  const out = new Set();
  const m = marks || await marksMap();
  const pool = ids.filter((id) => !m.has(id));
  for (const part of chunks(pool)) {
    // eslint-disable-next-line no-await-in-loop
    const logs = await prisma.auditLog.findMany({
      where: { entity: 'Candidate', entityId: { in: part }, OR: [{ action: { startsWith: 'Candidate created' } }, { action: { startsWith: 'Candidate self-registered' } }, { action: { startsWith: 'Candidate added' } }] },
      select: { entityId: true },
    });
    logs.forEach((l) => out.add(l.entityId));
    // eslint-disable-next-line no-await-in-loop
    const apps = await prisma.application.findMany({ where: { candidateId: { in: part } }, select: { candidateId: true, source: true } });
    apps.forEach((a) => { if (isPortalSource(a.source)) out.add(a.candidateId); });
  }
  return out;
}

// The first application of a person and whether an import made it (no first event by a login, and not a portal application).
async function firstApplicationOf(candidateId) {
  const apps = await prisma.application.findMany({ where: { candidateId }, orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true, updatedAt: true, source: true }, take: 1 });
  const app = apps[0];
  if (!app) return null;
  const events = await prisma.applicationStageEvent.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' }, select: { id: true, fromStage: true, actorUserId: true, actorName: true, createdAt: true }, take: 5 });
  const first = events.find((e) => e.fromStage == null) || null;
  const byLogin = !!(first && first.actorUserId);
  return { app, firstEvent: first, importMade: !byLogin && !isPortalSource(app.source) };
}

// ---- the repair ---------------------------------------------------------------
// rows: [{ row, id, email, phone, date: parseCameDate result }]; overwrite: also fix people with a genuine date.
async function plan(rows, user, { overwrite = false } = {}) {
  const CAME = require('./cameOn'); // eslint-disable-line global-require
  const candidateKeys = require('./candidateDedupe'); // eslint-disable-line global-require
  const marks = await marksMap();
  const all = await prisma.candidate.findMany({ select: { id: true, name: true, email: true, phone: true, createdAt: true } });
  const byId = new Map(all.map((c) => [c.id, c]));
  const byEmail = new Map();
  const byPhone = new Map();
  const push = (map, k, id) => { if (!map.has(k)) map.set(k, []); map.get(k).push(id); };
  all.forEach((c) => {
    const e = candidateKeys.emailKey(c.email); if (e) push(byEmail, e, c.id);
    candidateKeys.phoneKeys(c.phone).forEach((k) => push(byPhone, k, c.id));
  });
  const bulk = CAME.bulkDaysOf(all);
  const scope = require('./scope'); // eslint-disable-line global-require
  const s = scope.atsScopeOf(user);
  let allowed = null;
  if (!s.global) allowed = new Set((await prisma.candidate.findMany({ where: scope.candidateWhere(user), select: { id: true } })).map((c) => c.id));

  const out = [];
  const seenCand = new Map();
  const want = [];
  for (const r of rows) {
    const base = { row: r.row, key: r.id || r.email || r.phone || '' };
    if (r.date.ok === null) { out.push({ ...base, status: 'nodate', message: 'no date on this row' }); continue; }
    if (!r.date.ok) { out.push({ ...base, status: 'bad', message: r.date.message }); continue; }
    let hits = [];
    let by = '';
    if (r.id && byId.has(String(r.id).trim())) { hits = [String(r.id).trim()]; by = 'candidate ID'; }
    if (!hits.length) {
      const e = candidateKeys.emailKey(r.email);
      if (e && byEmail.has(e)) { hits = [...new Set(byEmail.get(e))]; by = 'email'; }
    }
    if (!hits.length) {
      const ph = candidateKeys.phoneKeys(r.phone);
      const set = new Set();
      ph.forEach((k) => (byPhone.get(k) || []).forEach((id) => set.add(id)));
      if (set.size) { hits = [...set]; by = 'phone'; }
    }
    if (!hits.length) { out.push({ ...base, status: 'notfound', message: r.id || r.email || r.phone ? 'nobody on file has this ID / email / phone' : 'the row has no candidate ID, email or phone' }); continue; }
    if (hits.length > 1) { out.push({ ...base, status: 'ambiguous', message: `${hits.length} people share this ${by}: ${hits.slice(0, 3).map((id) => byId.get(id).name).join(', ')} — nothing changed; use the candidate ID` }); continue; }
    const id = hits[0];
    if (allowed && !allowed.has(id)) { out.push({ ...base, status: 'notfound', name: byId.get(id).name, message: 'this person is outside your area — ask their own lead or an Admin' }); continue; }
    if (seenCand.has(id)) { out.push({ ...base, name: byId.get(id).name, status: 'duplicate', message: `the same person is on row ${seenCand.get(id)} of this file — that row is used` }); continue; }
    seenCand.set(id, r.row);
    want.push({ r, id, base, by });
  }
  // the people to fix: their applications (for the current came-on) and who is genuine
  const ids = want.map((w) => w.id);
  const appsBy = new Map();
  for (const part of chunks(ids)) {
    // eslint-disable-next-line no-await-in-loop
    const apps = await prisma.application.findMany({ where: { candidateId: { in: part } }, select: { id: true, candidateId: true, createdAt: true, source: true } });
    apps.forEach((a) => { if (!appsBy.has(a.candidateId)) appsBy.set(a.candidateId, []); appsBy.get(a.candidateId).push(a); });
  }
  const genuine = await genuineSet(ids, marks);
  for (const { r, id, base, by } of want) {
    const c = byId.get(id);
    const before = CAME.cameOnOf({ id, createdAt: c.createdAt }, appsBy.get(id) || [], bulk, marks);
    const isGenuine = genuine.has(id);
    const row = {
      ...base, candidateId: id, name: c.name, matchedBy: by, oldDay: before.day, oldKind: before.kind, newDay: r.date.day, newAt: r.date.at, genuine: isGenuine,
    };
    if (isGenuine && !overwrite) { out.push({ ...row, status: 'protected', message: 'this date was recorded by TeamLink itself (typed in, applied or registered) — kept. Tick "Overwrite" to change it anyway.' }); continue; }
    if (before.day === r.date.day && marks.get(id) === 'sheet') { out.push({ ...row, status: 'nochange', message: 'already shows this date' }); continue; }
    if (before.day === r.date.day && !marks.has(id) && !isGenuine && before.kind !== 'imported') { out.push({ ...row, status: 'nochange', message: 'already shows this date' }); continue; }
    const first = await firstApplicationOf(id); // eslint-disable-line no-await-in-loop
    row.firstApplication = first && first.importMade && first.app.createdAt > r.date.at ? first : null;
    out.push({ ...row, status: 'fix', message: isGenuine ? 'will be changed (Overwrite is ticked)' : 'will be changed' });
  }
  out.sort((a, b) => a.row - b.row);
  const n = (st) => out.filter((x) => x.status === st).length;
  const totals = {
    rows: rows.length, fix: n('fix'), notFound: n('notfound'), ambiguous: n('ambiguous'), bad: n('bad'), protected: n('protected'), noChange: n('nochange'), noDate: n('nodate'), duplicate: n('duplicate'),
  };
  return { totals, rows: out };
}

async function apply(rows, user, { overwrite = false, fileName = null } = {}) {
  const p = await plan(rows, user, { overwrite });
  const batchId = `df-${crypto.randomBytes(5).toString('hex')}`;
  await ensure();
  let changed = 0;
  for (const r of p.rows.filter((x) => x.status === 'fix')) {
    // eslint-disable-next-line no-await-in-loop
    const cand = await prisma.candidate.findUnique({ where: { id: r.candidateId }, select: { createdAt: true } });
    if (!cand) continue;
    const marks = await marksMap(); // eslint-disable-line no-await-in-loop
    const oldMark = marks.get(r.candidateId) || null;
    const fa = r.firstApplication || null;
    const newAt = new Date(r.newAt);
    const rec = {
      id: crypto.randomUUID(), batchId, candidateId: r.candidateId, oldCreatedAt: cand.createdAt.toISOString(), newCreatedAt: newAt.toISOString(),
      oldKind: r.oldKind, oldDay: r.oldDay, newDay: r.newDay, oldMark,
      appId: fa ? fa.app.id : null, oldAppCreatedAt: fa ? fa.app.createdAt.toISOString() : null, newAppCreatedAt: fa ? newAt.toISOString() : null,
      eventId: fa && fa.firstEvent ? fa.firstEvent.id : null, oldEventAt: fa && fa.firstEvent ? fa.firstEvent.createdAt.toISOString() : null, newEventAt: fa && fa.firstEvent ? newAt.toISOString() : null,
    };
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(
      `INSERT INTO "CandidateDateFix" ("id","batchId","candidateId","oldCreatedAt","newCreatedAt","oldKind","oldDay","newDay","oldMark","appId","oldAppCreatedAt","newAppCreatedAt","eventId","oldEventAt","newEventAt","overwrote","byUserId","byName","fileName","at")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rec.id, batchId, rec.candidateId, rec.oldCreatedAt, rec.newCreatedAt, rec.oldKind, rec.oldDay, rec.newDay, rec.oldMark, rec.appId, rec.oldAppCreatedAt, rec.newAppCreatedAt,
      rec.eventId, rec.oldEventAt, rec.newEventAt, r.genuine ? 1 : 0, user.id, user.name || null, fileName ? String(fileName).slice(0, 200) : null, now(),
    );
    // eslint-disable-next-line no-await-in-loop
    await prisma.candidate.update({ where: { id: r.candidateId }, data: { createdAt: newAt } });
    if (fa) {
      // updatedAt is kept: this is a correction of WHEN they came, not a movement of the application (ageing and due dates must not restart)
      // eslint-disable-next-line no-await-in-loop
      await prisma.application.update({ where: { id: fa.app.id }, data: { createdAt: newAt, updatedAt: fa.app.updatedAt } });
      // eslint-disable-next-line no-await-in-loop
      if (fa.firstEvent) await prisma.applicationStageEvent.update({ where: { id: fa.firstEvent.id }, data: { createdAt: newAt } });
    }
    // eslint-disable-next-line no-await-in-loop
    await mark(r.candidateId, 'sheet', { byName: user.name, via: 'date fix' });
    changed += 1;
  }
  try { require('./candidateListCache').forceRebuild(); } catch { /* the next 10-minute rebuild picks it up */ } // eslint-disable-line global-require
  return { batchId, changed, totals: p.totals };
}

async function batches() {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "batchId", MIN("at") AS "at", MAX("byName") AS "byName", MAX("fileName") AS "fileName", MAX("byUserId") AS "byUserId", COUNT(*) AS "people",
            SUM(CASE WHEN "undoneAt" IS NULL THEN 0 ELSE 1 END) AS "undone", SUM("overwrote") AS "overwrote"
     FROM "CandidateDateFix" GROUP BY "batchId" ORDER BY MIN("at") DESC LIMIT 50`,
  );
  return rows.map((r) => ({
    id: r.batchId, at: r.at, by: r.byName, byUserId: r.byUserId, file: r.fileName, people: Number(r.people), overwrote: Number(r.overwrote || 0), undone: Number(r.undone) >= Number(r.people),
  }));
}

async function undo(batchId, user) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "CandidateDateFix" WHERE "batchId" = ?', String(batchId));
  if (!rows.length) { const e = new Error('That batch was not found.'); e.status = 404; throw e; }
  if (rows.every((r) => r.undoneAt)) { const e = new Error('That batch has already been undone.'); e.status = 409; throw e; }
  let restored = 0;
  for (const r of rows.filter((x) => !x.undoneAt)) {
    // eslint-disable-next-line no-await-in-loop
    const cand = await prisma.candidate.findUnique({ where: { id: r.candidateId }, select: { id: true } });
    if (cand) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.candidate.update({ where: { id: r.candidateId }, data: { createdAt: new Date(r.oldCreatedAt) } });
      if (r.appId) {
        // eslint-disable-next-line no-await-in-loop
        const app = await prisma.application.findUnique({ where: { id: r.appId }, select: { updatedAt: true } });
        // eslint-disable-next-line no-await-in-loop
        if (app) await prisma.application.update({ where: { id: r.appId }, data: { createdAt: new Date(r.oldAppCreatedAt), updatedAt: app.updatedAt } });
      }
      // eslint-disable-next-line no-await-in-loop
      if (r.eventId) await prisma.applicationStageEvent.update({ where: { id: r.eventId }, data: { createdAt: new Date(r.oldEventAt) } }).catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      if (r.oldMark) await mark(r.candidateId, r.oldMark, { byName: user.name, via: 'date fix undone' }); else await unmark(r.candidateId); // eslint-disable-line no-await-in-loop
      try { require('./candidateListCache').markCandidateDirty(r.candidateId); } catch { /* none */ } // eslint-disable-line global-require
      restored += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe('UPDATE "CandidateDateFix" SET "undoneAt" = ?, "undoneByName" = ? WHERE "id" = ?', now(), user.name || null, r.id);
  }
  try { require('./candidateListCache').forceRebuild(); } catch { /* none */ } // eslint-disable-line global-require
  return { restored, total: rows.length };
}

module.exports = { ensure, marksMap, mark, unmark, version, genuineSet, plan, apply, batches, undo, istDay };
