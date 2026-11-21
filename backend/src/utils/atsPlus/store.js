// ---------------------------------------------------------------------------
// ATS PLUS - the shared store of the "market wave" features (founder 2026-11-21: "the whole ATS must be 90 to 99 percent
// complete compared with the market"). Raw tables, created on first use (no Prisma migration), the pattern of
// utils/recycleBin.js:
//
//   AtsPlusSetting  key -> JSON value          Admin switches and lists (every switch that tells people something starts OFF)
//   AtsPlusItem     one row per record of a kind: prospects, clauses, checklists, API keys, webhooks, consent records,
//                   privacy requests, breaches, connector orders, onboarding packs ... `kind` says which; the indexed
//                   columns (refType/refId, ownerId, status) are what the lists filter on, the rest is in `data` (JSON).
//   AtsPlusUptime   one row per health sample (the public status page, utils/atsPlus/status.js)
//
//   settings.get(key, defaults)   settings.set(key, value, user)
//   items.create(kind, fields, user)  items.update(id, patch, user)  items.get(id, kind)  items.list(kind, where, opts)  items.remove(id)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const sql = [
        `CREATE TABLE IF NOT EXISTS "AtsPlusSetting" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" TEXT NOT NULL, "updatedByName" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "AtsPlusItem" ("id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "refType" TEXT, "refId" TEXT, "ownerId" TEXT,
          "status" TEXT, "title" TEXT, "data" TEXT NOT NULL DEFAULT '{}', "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL,
          "createdById" TEXT, "createdByName" TEXT)`,
        'CREATE INDEX IF NOT EXISTS "AtsPlusItem_kind_ref" ON "AtsPlusItem"("kind", "refType", "refId")',
        'CREATE INDEX IF NOT EXISTS "AtsPlusItem_kind_owner" ON "AtsPlusItem"("kind", "ownerId")',
        'CREATE INDEX IF NOT EXISTS "AtsPlusItem_kind_status" ON "AtsPlusItem"("kind", "status")',
        `CREATE TABLE IF NOT EXISTS "AtsPlusUptime" ("at" TEXT PRIMARY KEY, "ok" INTEGER NOT NULL, "ms" INTEGER, "note" TEXT)`,
      ];
      for (const s of sql) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const now = () => new Date().toISOString();
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const newId = (p = 'ap') => `${p}_${crypto.randomBytes(9).toString('hex')}`;

const cache = new Map(); // key -> { at, value }
const settings = {
  async get(key, defaults = {}) {
    const hit = cache.get(key);
    let value;
    if (hit && Date.now() - hit.at < 5000) value = hit.value;
    else {
      await ensure();
      const [row] = await prisma.$queryRawUnsafe('SELECT "value" FROM "AtsPlusSetting" WHERE "key" = ?', key);
      value = parse(row && row.value, null);
      cache.set(key, { at: Date.now(), value });
    }
    if (Array.isArray(defaults)) return Array.isArray(value) ? value : defaults;
    return { ...defaults, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) };
  },
  async raw(key) {
    await ensure();
    const [row] = await prisma.$queryRawUnsafe('SELECT "value" FROM "AtsPlusSetting" WHERE "key" = ?', key);
    return parse(row && row.value, null);
  },
  async set(key, value, user) {
    await ensure();
    await prisma.$executeRawUnsafe(`INSERT INTO "AtsPlusSetting" ("key","value","updatedAt","updatedByName") VALUES (?,?,?,?)
      ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt", "updatedByName" = excluded."updatedByName"`,
    key, JSON.stringify(value), now(), (user && user.name) || null);
    cache.delete(key);
    return value;
  },
};

function shape(r) {
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, refType: r.refType, refId: r.refId, ownerId: r.ownerId, status: r.status, title: r.title,
    ...parse(r.data, {}), createdAt: r.createdAt, updatedAt: r.updatedAt, createdById: r.createdById, createdByName: r.createdByName,
  };
}
const COLS = ['refType', 'refId', 'ownerId', 'status', 'title'];
function split(fields) {
  const cols = {}; const data = {};
  Object.entries(fields || {}).forEach(([k, v]) => {
    if (COLS.includes(k)) cols[k] = v === undefined ? null : (v === null ? null : String(v));
    else if (!['id', 'kind', 'createdAt', 'updatedAt', 'createdById', 'createdByName'].includes(k)) data[k] = v;
  });
  return { cols, data };
}
const items = {
  async create(kind, fields, user, { id } = {}) {
    await ensure();
    const { cols, data } = split(fields);
    const rid = id || newId(kind.slice(0, 3));
    const t = now();
    await prisma.$executeRawUnsafe(`INSERT INTO "AtsPlusItem" ("id","kind","refType","refId","ownerId","status","title","data","createdAt","updatedAt","createdById","createdByName")
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, rid, kind, cols.refType || null, cols.refId || null, cols.ownerId || null, cols.status || null, cols.title || null,
    JSON.stringify(data), t, t, (user && user.id) || null, (user && user.name) || null);
    return items.get(rid);
  },
  async get(id, kind) {
    await ensure();
    const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsPlusItem" WHERE "id" = ?', String(id || ''));
    if (!r || (kind && r.kind !== kind)) return null;
    return shape(r);
  },
  async update(id, patch) {
    const cur = await items.get(id);
    if (!cur) return null;
    const { cols, data } = split(patch);
    const [r] = await prisma.$queryRawUnsafe('SELECT "data" FROM "AtsPlusItem" WHERE "id" = ?', String(id));
    const merged = { ...parse(r && r.data, {}), ...data };
    const sets = ['"data" = ?', '"updatedAt" = ?']; const vals = [JSON.stringify(merged), now()];
    Object.entries(cols).forEach(([k, v]) => { sets.push(`"${k}" = ?`); vals.push(v); });
    await prisma.$executeRawUnsafe(`UPDATE "AtsPlusItem" SET ${sets.join(', ')} WHERE "id" = ?`, ...vals, String(id));
    return items.get(id);
  },
  // where: { refType, refId, ownerId, status } (a value or an array); opts: { limit, order: 'asc' | 'desc' }
  async list(kind, where = {}, { limit = 2000, order = 'desc' } = {}) {
    await ensure();
    const cond = ['"kind" = ?']; const vals = [kind];
    Object.entries(where || {}).forEach(([k, v]) => {
      if (!COLS.includes(k) || v === undefined) return;
      if (Array.isArray(v)) {
        if (!v.length) { cond.push('1 = 0'); return; }
        cond.push(`"${k}" IN (${v.map(() => '?').join(',')})`); vals.push(...v.map(String));
      } else if (v === null) cond.push(`"${k}" IS NULL`);
      else { cond.push(`"${k}" = ?`); vals.push(String(v)); }
    });
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "AtsPlusItem" WHERE ${cond.join(' AND ')} ORDER BY "createdAt" ${order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${Math.min(Math.max(Number(limit) || 2000, 1), 20000)}`, ...vals);
    return rows.map(shape);
  },
  async remove(id) {
    await ensure();
    await prisma.$executeRawUnsafe('DELETE FROM "AtsPlusItem" WHERE "id" = ?', String(id));
  },
  async count(kind, where = {}) { return (await items.list(kind, where, { limit: 20000 })).length; },
};

// ---------------------------------------------------------------- shared role helpers (the same words every ATS plus route uses)
const { atsViewRole } = require('../scope');

const isAdmin = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
const viewOnly = (u) => atsViewRole(u) === 'mgmt'; // Manager / Assistant Manager: VIEW ONLY in the ATS
const viewRole = (u) => atsViewRole(u);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ADMIN_ONLY = { error: 'Only a Super Admin or an Admin can change this.' };
function adminOnly(req, res, next) {
  if (!isAdmin(req.user) || req.viewAs) return res.status(403).json(ADMIN_ONLY);
  return next();
}
// any internal ATS login that may write (not a client / candidate, not Manager / Assistant Manager, not View As)
function writer(req, res, next) {
  const v = atsViewRole(req.user);
  if (req.viewAs) return res.status(403).json({ error: 'View As is read-only.' });
  if (v === 'mgmt') return res.status(403).json({ error: 'Managers and Assistant Managers see the ATS but do not change it.' });
  if (['client', 'candidate', 'none'].includes(v)) return res.status(403).json({ error: 'This is not part of your access.' });
  return next();
}
function internal(req, res, next) {
  const v = atsViewRole(req.user);
  if (['client', 'candidate', 'none'].includes(v)) return res.status(403).json({ error: 'This is not part of your access.' });
  return next();
}
const sandbox = () => require('../sandbox').isSandbox(); // eslint-disable-line global-require

module.exports = { ensure, settings, items, newId, now, parse, isAdmin, viewOnly, viewRole, wrap, adminOnly, writer, internal, sandbox, ADMIN_ONLY };
