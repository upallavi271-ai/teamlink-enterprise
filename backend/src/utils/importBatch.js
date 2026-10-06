// ---------------------------------------------------------------------------
// IMPORT BATCHES — "every import gets a BATCH ID and can be UNDONE within 24
// hours" (spec 2026-10-03 §B).
//
// HOW THE RECORDS OF ONE IMPORT ARE KNOWN. An import runs inside
// runInBatch(); while it runs, a Prisma middleware notes every create /
// update / upsert on the ATS tables below that THIS async chain makes (an
// AsyncLocalStorage context, so a colleague saving a candidate at the same
// moment is never mistaken for part of the import). For an update it reads
// the row first and keeps the before-values of exactly the fields the import
// wrote. The importers themselves are not touched — whatever they write is
// caught, including the stage-history rows they add on the side.
//
// WHERE IT IS KEPT. No schema change: one AuditLog row per batch (entity
// 'ImportBatch', entityId = the batch id, toValue = a short summary) is the
// index, and utils/atsIoStore.js batches/<id>.json the manifest:
//   { id, kind, label, file, userId, actorName, at, entries: [
//       { op: 'create', model, id, hash },
//       { op: 'update', model, id, before: { field: value }, hash } ] }
// `hash` is the row as the import LEFT it.
//
// UNDO. Within 24 hours, by the person who imported (or a Super Admin /
// Admin). Refused — nothing is changed — when any record of the batch was
// changed since (its row no longer hashes the same) or something outside
// the batch now depends on a record it created (an application added later
// on an imported candidate …). Otherwise, in reverse order: created rows are
// deleted, updated rows get their before-values back. The audit trail of
// the import itself is kept; the undo adds its own row.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const store = require('./atsIoStore');
const { logAudit } = require('./audit');

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
const ENTITY = 'ImportBatch';

// The tables an ATS import writes. Audit and notification rows are the
// trail, not the data — never undone.
const TRACKED = new Set([
  'Client', 'Requirement', 'Candidate', 'Application', 'ApplicationStageEvent', 'ApplicationFollowUp',
  'InterviewFeedback', 'InterviewEvent', 'CandidateDocument', 'CandidateNote',
]);

const als = new AsyncLocalStorage();
const delegate = (model) => prisma[model.charAt(0).toLowerCase() + model.slice(1)];

// Field types per model, to bring dates back to life on restore.
const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
function revive(model, data) {
  const m = MODELS.get(model);
  const out = { ...data };
  if (!m) return out;
  m.fields.forEach((f) => {
    if (f.kind === 'scalar' && f.type === 'DateTime' && typeof out[f.name] === 'string') out[f.name] = new Date(out[f.name]);
  });
  return out;
}
function scalarKeys(model) {
  const m = MODELS.get(model);
  return m ? m.fields.filter((f) => f.kind === 'scalar').map((f) => f.name) : null;
}

function rowHash(row) {
  if (!row) return null;
  const keys = Object.keys(row).sort();
  const norm = keys.map((k) => {
    const v = row[k];
    return [k, v instanceof Date ? v.toISOString() : v];
  });
  return crypto.createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}

// ---- the middleware -----------------------------------------------------------
let installed = false;
function install() {
  if (installed || typeof prisma.$use !== 'function') return;
  installed = true;
  prisma.$use(async (params, next) => {
    const ctx = als.getStore();
    if (!ctx || !TRACKED.has(params.model)) return next(params);
    const { action, model, args } = params;
    if (action === 'create') {
      const result = await next(params);
      if (result && result.id) ctx.entries.push({ op: 'create', model, id: result.id });
      return result;
    }
    if (action === 'update' || action === 'upsert') {
      let before = null;
      try { before = args && args.where ? await delegate(model).findUnique({ where: args.where }) : null; } catch { before = null; }
      const result = await next(params);
      if (!result || !result.id) return result;
      if (!before) {
        ctx.entries.push({ op: 'create', model, id: result.id });
      } else if (!ctx.entries.some((e) => e.model === model && e.id === result.id)) {
        // The first write in this batch decides the before-values; a later
        // write to the same row in the same batch adds its fields.
        const data = action === 'upsert' ? (args.update || {}) : (args.data || {});
        const fields = Object.keys(data).filter((k) => k in before);
        const prev = {};
        fields.forEach((k) => { prev[k] = before[k]; });
        ctx.entries.push({ op: 'update', model, id: result.id, before: prev });
      } else {
        const e = ctx.entries.find((x) => x.model === model && x.id === result.id && x.op === 'update');
        if (e) {
          const data = action === 'upsert' ? (args.update || {}) : (args.data || {});
          Object.keys(data).filter((k) => k in before && !(k in e.before)).forEach((k) => { e.before[k] = before[k]; });
        }
      }
      return result;
    }
    if (['createMany', 'updateMany', 'deleteMany', 'delete'].includes(action)) ctx.untracked.push(`${model}.${action}`);
    return next(params);
  });
}
install();

// ---- running an import as a batch ---------------------------------------------
// fn runs with the batch context; returns { batch, result }. The manifest is
// written only when the batch wrote something.
async function runInBatch(meta, fn) {
  const ctx = { entries: [], untracked: [] };
  const result = await als.run(ctx, fn);
  if (!ctx.entries.length) return { batch: null, result };
  return { batch: await saveBatch(meta, ctx), result };
}

// A record written outside the async chain (a loopback call) is added by hand.
function recordCreate(model, id) {
  const ctx = als.getStore();
  if (ctx && id) ctx.entries.push({ op: 'create', model, id });
}

async function saveBatch(meta, ctx) {
  const id = store.newId('b-');
  const entries = [];
  for (const e of ctx.entries) {
    // eslint-disable-next-line no-await-in-loop
    const row = await delegate(e.model).findUnique({ where: { id: e.id } }).catch(() => null);
    entries.push({ ...e, hash: rowHash(row) });
  }
  const manifest = {
    id,
    kind: meta.kind,
    label: meta.label,
    module: meta.module || null,
    file: meta.file || null,
    userId: meta.user.id,
    actorName: meta.user.name || meta.user.email,
    requestId: meta.requestId || null,
    at: new Date().toISOString(),
    untracked: ctx.untracked,
    entries,
  };
  store.writeJson('batches', id, manifest);
  const created = entries.filter((e) => e.op === 'create').length;
  const updated = entries.filter((e) => e.op === 'update').length;
  await logAudit({
    userId: meta.user.id,
    actorName: manifest.actorName,
    action: `Import batch — ${meta.label}: ${meta.counts ? `${meta.counts.create} created, ${meta.counts.update} updated` : `${created} row(s) written`}`,
    entity: ENTITY,
    entityId: id,
    fromValue: meta.file || null,
    toValue: JSON.stringify({
      kind: meta.kind, label: meta.label, module: meta.module || null, records: entries.length, created, updated,
      counts: meta.counts || null, requestId: meta.requestId || null,
    }),
  });
  return { id, at: manifest.at, records: entries.length, undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString() };
}

// ---- listing and undo -----------------------------------------------------------
const isAdminLike = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].some((r) => [u.role, u.atsRole, u.hrmsRole].includes(r));

function view(row) {
  let info = {};
  try { info = JSON.parse(row.toValue || '{}'); } catch { info = {}; }
  const age = Date.now() - new Date(row.createdAt).getTime();
  const undone = row.approvalStatus === 'Undone';
  return {
    id: row.entityId,
    label: info.label || row.action,
    kind: info.kind || null,
    module: info.module || null,
    file: row.fromValue,
    by: row.actorName,
    byId: row.userId,
    at: row.createdAt,
    records: info.records || 0,
    created: info.created || 0,
    updated: info.updated || 0,
    counts: info.counts || null,
    undone,
    undoneAt: undone ? row.approvedAt : null,
    undoneBy: undone ? row.approvedByName : null,
    undoUntil: new Date(new Date(row.createdAt).getTime() + UNDO_WINDOW_MS).toISOString(),
    canUndo: !undone && age < UNDO_WINDOW_MS,
  };
}

async function listBatches(user, { days = 7 } = {}) {
  const where = { entity: ENTITY, createdAt: { gte: new Date(Date.now() - days * 86400000) } };
  if (!isAdminLike(user)) where.userId = user.id;
  const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  return rows.map(view);
}

// Children a created record has that the batch did not make — an undo would
// orphan them (or fail on the foreign key), so it is refused.
const CHILD_CHECKS = {
  Candidate: (id) => [['Application', { candidateId: id }]],
  Requirement: (id) => [['Application', { requirementId: id }], ['Invoice', { requirementId: id }]],
  Client: (id) => [['Requirement', { clientId: id }], ['Invoice', { clientId: id }]],
  Application: (id) => [['ApplicationFollowUp', { applicationId: id }], ['ApplicationStageEvent', { applicationId: id }], ['InterviewFeedback', { applicationId: id }]],
};

async function undoBatch(batchId, user) {
  const row = await prisma.auditLog.findFirst({ where: { entity: ENTITY, entityId: String(batchId) } });
  if (!row) return { status: 404, error: 'Import batch not found.' };
  if (!isAdminLike(user) && row.userId !== user.id) return { status: 403, error: 'Only the person who imported it (or an Admin) can undo this import.' };
  if (row.approvalStatus === 'Undone') return { status: 409, error: 'This import was already undone.' };
  if (Date.now() - new Date(row.createdAt).getTime() > UNDO_WINDOW_MS) {
    return { status: 409, error: 'Undo is available for 24 hours after an import — this one is older. Change the records one by one instead.' };
  }
  const manifest = store.readJson('batches', row.entityId);
  if (!manifest || !Array.isArray(manifest.entries)) return { status: 410, error: 'The record list of this import is no longer on the server, so it cannot be undone automatically.' };
  if ((manifest.untracked || []).length) {
    return { status: 409, error: `This import also made bulk changes that cannot be reversed automatically (${manifest.untracked.join(', ')}).` };
  }

  // 1. Has anything been changed since? Nothing is touched unless every
  //    record is exactly as the import left it.
  const changed = [];
  const ours = new Set(manifest.entries.map((e) => `${e.model}:${e.id}`));
  for (const e of manifest.entries) {
    // eslint-disable-next-line no-await-in-loop
    const cur = await delegate(e.model).findUnique({ where: { id: e.id } }).catch(() => null);
    if (!cur) {
      if (e.op === 'update') changed.push({ model: e.model, id: e.id, why: 'deleted since' });
      continue; // a created row already gone is fine
    }
    if (rowHash(cur) !== e.hash) changed.push({ model: e.model, id: e.id, why: 'edited since', name: cur.name || cur.title || cur.reqCode || null });
    if (e.op === 'create' && CHILD_CHECKS[e.model]) {
      for (const [child, where] of CHILD_CHECKS[e.model](e.id)) {
        // eslint-disable-next-line no-await-in-loop
        const kids = await delegate(child).findMany({ where, select: { id: true } }).catch(() => []);
        const foreign = kids.filter((k) => !ours.has(`${child}:${k.id}`));
        if (foreign.length) changed.push({ model: e.model, id: e.id, why: `${foreign.length} ${child} record(s) added to it since`, name: cur.name || cur.title || null });
      }
    }
  }
  if (changed.length) {
    return {
      status: 409,
      error: `This import cannot be undone: ${changed.length} of its records changed after the import. Nothing was undone.`,
      changed: changed.slice(0, 50),
    };
  }

  // 2. Reverse order: the last write first.
  let removed = 0;
  let restored = 0;
  const entries = [...manifest.entries].reverse();
  for (const e of entries) {
    if (e.op === 'create') {
      // eslint-disable-next-line no-await-in-loop
      const r = await delegate(e.model).deleteMany({ where: { id: e.id } });
      removed += r.count;
    } else {
      const keys = scalarKeys(e.model);
      const data = revive(e.model, Object.fromEntries(Object.entries(e.before || {}).filter(([k]) => !keys || keys.includes(k))));
      delete data.id;
      // eslint-disable-next-line no-await-in-loop
      if (Object.keys(data).length) { await delegate(e.model).update({ where: { id: e.id }, data }); restored += 1; }
    }
  }
  (manifest.files || []).forEach((f) => { try { require('./attachments').remove(f); } catch { /* ignore */ } });
  await prisma.auditLog.update({
    where: { id: row.id },
    data: { approvalStatus: 'Undone', approvedByName: user.name || user.email, approvedAt: new Date() },
  });
  await logAudit({
    userId: user.id,
    actorName: user.name || user.email,
    action: `Import undone — ${manifest.label}: ${removed} record(s) removed, ${restored} restored`,
    entity: ENTITY,
    entityId: row.entityId,
    toValue: JSON.stringify({ removed, restored }),
  });
  return { status: 200, removed, restored, batch: view(await prisma.auditLog.findUnique({ where: { id: row.id } })) };
}

// A file (e.g. a stored resume) to delete if the batch is undone.
function addFileToBatch(batchId, storedName) {
  const m = store.readJson('batches', batchId);
  if (!m) return;
  m.files = [...(m.files || []), storedName];
  store.writeJson('batches', batchId, m);
}

module.exports = {
  UNDO_WINDOW_MS, ENTITY, TRACKED, runInBatch, recordCreate, listBatches, undoBatch, addFileToBatch, rowHash,
};
