// ---------------------------------------------------------------------------
// JOININGS / AGREEMENTS IMPORT 2026-10-17 - THE LEDGER.
//
// The importer first PLANS everything in memory and only then writes. Every planned write goes through this ledger:
//   create(model, data)           a new row (its id is made here, so the undo list is known before anything is written)
//   update(model, id, set, now)   a change to a row that already exists: only the fields in `set`; the old values are kept
//   patchCreate(id, set)          a change to a row this same run is creating (merged into the create, no extra write)
// The dry run and the real run use the same plan, so the dry-run counts are exactly what the real run writes.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

// creates are written parents-first, whatever order they were planned in
const RANK = {
  client: 1, clientAlias: 2, requirement: 3, candidate: 4, application: 5,
  applicationStageEvent: 6, applicationFollowUp: 7, candidateNote: 8, clientDocument: 9, appSetting: 10, auditLog: 11,
};
const PK = { appSetting: 'key' };

const stamp = Date.now().toString(36);
let counter = 0;
const newId = (tag = 'jn') => `${tag}${stamp}${(counter += 1).toString(36).padStart(4, '0')}${crypto.randomBytes(4).toString('hex')}`;

class Ledger {
  constructor() {
    this.creates = []; // { model, id, data }
    this.updates = new Map(); // `${model}|${id}` -> { model, id, set, before }
    this.created = new Map(); // id -> create record
    this.rawCreates = []; // { table, row } rows of the self-provisioned tables (no Prisma model), e.g. JoiningRecord
  }

  rawCreate(table, row) { this.rawCreates.push({ table, row }); return row.id; }

  create(model, data, idOverride) {
    if (!(model in RANK)) throw new Error(`ledger: unknown model ${model}`);
    const pk = PK[model] || 'id';
    const id = idOverride || data[pk] || newId();
    const rec = { model, id, data: { ...data, [pk]: id } };
    this.creates.push(rec);
    this.created.set(`${model}|${id}`, rec);
    return id;
  }

  patchCreate(model, id, set) {
    const rec = this.created.get(`${model}|${id}`);
    if (!rec) return false;
    Object.assign(rec.data, set);
    return true;
  }

  // `current` = the row as it is now (to keep the old values). Several updates of one row are merged; the FIRST old value is kept.
  update(model, id, set, current) {
    if (this.patchCreate(model, id, set)) return;
    const key = `${model}|${id}`;
    const u = this.updates.get(key) || { model, id, set: {}, before: {} };
    Object.keys(set).forEach((f) => {
      if (!(f in u.before)) u.before[f] = current && f in current ? current[f] : null;
      u.set[f] = set[f];
    });
    // Prisma bumps updatedAt on every update; keep the old one so an undo can put it back
    if (current && current.updatedAt && !('updatedAt' in u.before)) u.before.updatedAt = current.updatedAt;
    this.updates.set(key, u);
  }

  counts() {
    const c = { created: {}, updated: {} };
    this.creates.forEach((r) => { c.created[r.model] = (c.created[r.model] || 0) + 1; });
    [...this.updates.values()].forEach((u) => { c.updated[u.model] = (c.updated[u.model] || 0) + 1; });
    return c;
  }

  orderedCreates() {
    return this.creates.map((r, i) => [r, i]).sort((a, b) => RANK[a[0].model] - RANK[b[0].model] || a[1] - b[1]).map((x) => x[0]);
  }
}

// JSON that keeps Dates (for the undo manifest)
const toJson = (v) => JSON.stringify(v, (k, x) => x);
const dateReplacer = (k, v) => v;
function serialise(obj) {
  return JSON.stringify(obj, function r(key, value) {
    const raw = this[key];
    if (raw instanceof Date) return { $date: raw.toISOString() };
    if (typeof raw === 'bigint') return Number(raw);
    return value;
  }, 1);
}
function revive(obj) {
  return JSON.parse(typeof obj === 'string' ? obj : JSON.stringify(obj), (k, v) => (v && typeof v === 'object' && v.$date ? new Date(v.$date) : v));
}

module.exports = { Ledger, newId, RANK, PK, serialise, revive, toJson, dateReplacer };
