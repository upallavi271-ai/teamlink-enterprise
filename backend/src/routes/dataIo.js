// ---------------------------------------------------------------------------
// /api/io — per-module EXPORT, SAMPLE and IMPORT for every HRMS module that
// holds employee data (utils/moduleIo.js has the contract; src/io/*.js the
// modules). Every export and import tells the Super Admin
// (utils/dataIoNotify.js).
//
//   GET  /api/io/modules                  what THIS caller may do, per module
//   GET  /api/io/employees                the employees in the caller's scope (per-employee export picker)
//   GET  /api/io/:key/sample?format=xlsx|csv   the compulsory sample file
//   GET  /api/io/:key/export?format=&employeeId=&…   global / per-employee export (scoped)
//   POST /api/io/:key/preview?fileName=   raw file body -> row-wise check, writes nothing
//   POST /api/io/:key/import?fileName=    raw file body -> writes the valid rows
//   POST /api/io/:key/request?fileName=   view-only callers (where the module allows it): an IMPORT REQUEST
//   GET  /api/io/requests                 Super Admin: every request · others: their own
//   GET  /api/io/requests/:id
//   POST /api/io/requests/:id/approve     Super Admin only — re-checks and applies
//   POST /api/io/requests/:id/reject      Super Admin only
//
// IMPORT REQUESTS are stored as AuditLog rows (entity 'DataImportRequest',
// approvalStatus Pending → Approved | Rejected) — no schema change. The row
// carries only the rows that passed the check under the REQUESTER's scope,
// so approving can never reach further than the requester could.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const io = require('../utils/moduleIo');
const { formatOf, sendTable } = require('../utils/exportKit');
const { scopeLabel } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyDataIo } = require('../utils/dataIoNotify');
const { pushNotification } = require('../utils/notify');

const router = express.Router();
router.use(requireAuth);

const REQUEST_ENTITY = 'DataImportRequest';
const rawUpload = express.raw({
  type: ['application/octet-stream', 'text/csv', 'text/plain', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  limit: '15mb',
});

const guarded = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isSuperAdmin = (u) => !!u && (u.role === 'SUPER_ADMIN' || u.hrmsRole === 'SUPER_ADMIN');

async function context(req) {
  return { req, user: req.user, employees: await io.employeeIndex(req) };
}

async function specAndCaps(req, res) {
  const spec = io.getSpec(req.params.key);
  if (!spec) { res.status(404).json({ error: 'Unknown module' }); return {}; }
  const caps = await io.capsOf(spec, req.user);
  return { spec, caps };
}

function fileOf(req) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return { error: 'Upload the filled-in sample file (.xlsx or .csv).' };
  return { buffer: req.body, fileName: String(req.query.fileName || 'upload.xlsx').slice(0, 200) };
}

async function checkFile(req, spec) {
  const f = fileOf(req);
  if (f.error) return { error: f.error };
  const parsed = io.parseFile(spec, f.buffer, f.fileName);
  if (parsed.error) return { error: parsed.error, headerMismatch: parsed.headerMismatch };
  const ctx = await context(req);
  const validated = await spec.validate(parsed.rows, ctx);
  return { parsed, validated, ctx, fileName: f.fileName, preview: io.previewOf(spec, validated, parsed) };
}

const isGood = (v) => (!v.errors || !v.errors.length) && ['create', 'update'].includes(v.action);

// ---- what may I do ------------------------------------------------------------
router.get('/modules', guarded(async (req, res) => {
  const out = await Promise.all(io.allSpecs().map(async (spec) => {
    const caps = await io.capsOf(spec, req.user);
    return {
      key: spec.key,
      label: spec.label,
      module: spec.module,
      hasExport: typeof spec.exportRows === 'function',
      exportVia: spec.exportVia || null,
      columns: spec.columns.map((c) => ({ key: c.key, label: c.label, required: !!c.required, readOnly: !!c.readOnly })),
      ...caps,
    };
  }));
  res.json({ modules: out, superAdmin: isSuperAdmin(req.user) });
}));

router.get('/employees', guarded(async (req, res) => {
  const idx = await io.employeeIndex(req);
  res.json({
    scope: scopeLabel(req.user),
    employees: idx.list.map((e) => ({
      id: e.id, code: e.employeeCode, name: e.name, department: e.department, status: e.employmentStatus,
    })),
  });
}));

// ---- import requests (before /:key so "requests" is never read as a key) -------
function requestView(row, { full = false } = {}) {
  let payload = {};
  try { payload = JSON.parse(row.toValue || '{}'); } catch { payload = {}; }
  return {
    id: row.id,
    key: row.entityId,
    module: payload.module || null,
    label: payload.label || null,
    fileName: row.fromValue,
    status: row.approvalStatus,
    requestedBy: row.actorName,
    requestedById: row.userId,
    requestedAt: row.createdAt,
    decidedBy: row.approvedByName,
    decidedAt: row.approvedAt,
    note: row.reason,
    counts: payload.preview ? {
      rows: payload.preview.rowCount, valid: payload.preview.validCount, invalid: payload.preview.invalidCount,
      create: payload.preview.willCreate, update: payload.preview.willUpdate, unchanged: payload.preview.unchanged,
    } : null,
    result: payload.result || null,
    ...(full ? { preview: payload.preview || null } : {}),
  };
}

router.get('/requests', guarded(async (req, res) => {
  const where = { entity: REQUEST_ENTITY };
  if (!isSuperAdmin(req.user)) where.userId = req.user.id;
  if (req.query.status) where.approvalStatus = String(req.query.status);
  if (req.query.key) where.entityId = String(req.query.key);
  const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ requests: rows.map((r) => requestView(r)), superAdmin: isSuperAdmin(req.user) });
}));

router.get('/requests/:id', guarded(async (req, res) => {
  const row = await prisma.auditLog.findUnique({ where: { id: req.params.id } });
  if (!row || row.entity !== REQUEST_ENTITY) return res.status(404).json({ error: 'Import request not found' });
  if (!isSuperAdmin(req.user) && row.userId !== req.user.id) return res.status(403).json({ error: 'Not your request' });
  return res.json(requestView(row, { full: true }));
}));

router.post('/requests/:id/approve', guarded(async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin can approve an import request.' });
  const row = await prisma.auditLog.findUnique({ where: { id: req.params.id } });
  if (!row || row.entity !== REQUEST_ENTITY) return res.status(404).json({ error: 'Import request not found' });
  if (row.approvalStatus !== 'Pending') return res.status(409).json({ error: `This request is already ${String(row.approvalStatus).toLowerCase()}.` });
  const spec = io.getSpec(row.entityId);
  if (!spec) return res.status(400).json({ error: 'That module no longer accepts imports.' });
  let payload = {};
  try { payload = JSON.parse(row.toValue || '{}'); } catch { payload = {}; }
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  // CLAIM IT FIRST, so two Super Admins pressing Approve at once apply it once.
  const claimed = await prisma.auditLog.updateMany({
    where: { id: row.id, approvalStatus: 'Pending' },
    data: { approvalStatus: 'Approving', approvedByName: req.user.name || req.user.email, approvedAt: new Date() },
  });
  if (!claimed.count) return res.status(409).json({ error: 'Somebody else is deciding this request.' });
  try {
    const ctx = await context(req);
    ctx.request = { id: row.id, requestedBy: row.actorName, requestedById: row.userId };
    const validated = await spec.validate(rows, ctx);
    const good = validated.filter(isGood);
    const result = good.length ? await spec.apply(good, ctx) : { created: 0, updated: 0, skipped: 0, failed: [] };
    const stillBad = validated.filter((v) => v.errors && v.errors.length).map((v) => ({ line: v.line, reason: v.errors.map((e) => `${e.field}: ${e.message}`).join(' | ') }));
    const finalResult = { ...result, failed: [...(result.failed || []), ...stillBad] };
    await prisma.auditLog.update({
      where: { id: row.id },
      data: {
        approvalStatus: 'Approved',
        approvedByName: req.user.name || req.user.email,
        approvedAt: new Date(),
        reason: req.body && req.body.note ? String(req.body.note).slice(0, 500) : row.reason,
        toValue: JSON.stringify({ ...payload, result: finalResult }),
      },
    });
    await notifyDataIo(req, {
      kind: 'import-approved', module: spec.module, created: finalResult.created, updated: finalResult.updated,
      what: spec.what, entityId: row.id, detail: `request by ${row.actorName}; file ${row.fromValue}`,
    });
    if (row.userId) {
      await pushNotification({
        userId: row.userId,
        title: `Import request approved — ${spec.module}`,
        message: `${req.user.name || 'The Super Admin'} approved your import (${row.fromValue}): created ${finalResult.created || 0}, updated ${finalResult.updated || 0}${finalResult.failed.length ? `, ${finalResult.failed.length} row(s) failed` : ''}.`,
      });
    }
    return res.json({ ...requestView(await prisma.auditLog.findUnique({ where: { id: row.id } })), result: finalResult });
  } catch (err) {
    await prisma.auditLog.update({ where: { id: row.id }, data: { approvalStatus: 'Pending', approvedByName: null, approvedAt: null } }).catch(() => {});
    throw err;
  }
}));

router.post('/requests/:id/reject', guarded(async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin can reject an import request.' });
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Say why the request is rejected — the requester is told.' });
  const row = await prisma.auditLog.findUnique({ where: { id: req.params.id } });
  if (!row || row.entity !== REQUEST_ENTITY) return res.status(404).json({ error: 'Import request not found' });
  if (row.approvalStatus !== 'Pending') return res.status(409).json({ error: `This request is already ${String(row.approvalStatus).toLowerCase()}.` });
  await prisma.auditLog.update({
    where: { id: row.id },
    data: { approvalStatus: 'Rejected', approvedByName: req.user.name || req.user.email, approvedAt: new Date(), reason },
  });
  const spec = io.getSpec(row.entityId);
  await notifyDataIo(req, { kind: 'import-rejected', module: spec ? spec.module : row.entityId, entityId: row.id, detail: reason, email: false });
  if (row.userId) {
    await pushNotification({
      userId: row.userId,
      title: `Import request rejected — ${spec ? spec.module : row.entityId}`,
      message: `${req.user.name || 'The Super Admin'} rejected your import (${row.fromValue}): ${reason}`,
    });
  }
  return res.json(requestView(await prisma.auditLog.findUnique({ where: { id: row.id } })));
}));

// ---- per module -----------------------------------------------------------------
router.get('/:key/sample', guarded(async (req, res) => {
  const { spec, caps } = await specAndCaps(req, res);
  if (!spec) return undefined;
  if (!caps.canView && !caps.canImport && !caps.canExport) return res.status(403).json({ error: "This isn't included in your role's permissions" });
  const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const buf = await io.sampleFile(spec, await context(req), format);
  const name = `${spec.key}-import-sample.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(buf);
}));

router.get('/:key/export', guarded(async (req, res) => {
  const { spec, caps } = await specAndCaps(req, res);
  if (!spec) return undefined;
  if (typeof spec.exportRows !== 'function') return res.status(404).json({ error: `${spec.label} is exported from its own screen.` });
  if (!caps.canExport && !caps.selfExport) return res.status(403).json({ error: 'Export is not included in your role’s permissions.' });
  const format = formatOf(req.query);
  if (!format) return res.status(400).json({ error: 'format must be xlsx, csv or pdf' });
  const ctx = await context(req);
  let employeeIds = null;
  const asked = req.query.employeeId ? String(req.query.employeeId) : null;
  if (!caps.canExport) {
    if (asked && asked !== req.user.employeeId) return res.status(403).json({ error: 'Without export rights you can export only your own records.' });
    employeeIds = [req.user.employeeId];
  } else if (asked) {
    if (!ctx.employees.byId.has(asked)) return res.status(403).json({ error: 'That employee is outside your scope.' });
    employeeIds = [asked];
  } else {
    employeeIds = ctx.employees.list.map((e) => e.id);
  }
  const rows = await spec.exportRows(ctx, { employeeIds, filters: req.query });
  const cols = spec.exportColumns || spec.columns;
  const one = employeeIds && employeeIds.length === 1 && asked ? ctx.employees.byId.get(asked) : null;
  return sendTable(req, res, {
    format,
    name: `${spec.key}${one ? `-${one.employeeCode}` : ''}`,
    title: `${spec.module} — ${spec.label}${one ? ` — ${one.name} (${one.employeeCode})` : ''}`,
    headers: cols.map((c) => c.label),
    rows: rows.map((r) => cols.map((c) => (r[c.key] === undefined ? '' : r[c.key]))),
    sheet: spec.sheet || spec.label,
    entity: spec.entity || 'EmployeeRecord',
    what: spec.label,
    screen: spec.module,
    scope: !caps.canExport ? 'Own data' : (one ? `${one.name} (${one.employeeCode})` : scopeLabel(req.user)),
  });
}));

router.post('/:key/preview', rawUpload, guarded(async (req, res) => {
  const { spec, caps } = await specAndCaps(req, res);
  if (!spec) return undefined;
  if (!caps.canImport && !caps.allowRequest) return res.status(403).json({ error: caps.importBlockedReason || 'Import is not included in your role’s permissions.' });
  const checked = await checkFile(req, spec);
  if (checked.error) return res.status(400).json({ error: checked.error, headerMismatch: checked.headerMismatch });
  return res.json({ ...checked.preview, preview: true, mode: caps.canImport ? 'direct' : 'request' });
}));

router.post('/:key/import', rawUpload, guarded(async (req, res) => {
  const { spec, caps } = await specAndCaps(req, res);
  if (!spec) return undefined;
  if (!caps.canImport) {
    return res.status(403).json({
      error: caps.allowRequest
        ? 'Your role cannot import directly — submit it as an import request; the Super Admin approves it.'
        : (caps.importBlockedReason || 'Import is not included in your role’s permissions.'),
      requestInstead: !!caps.allowRequest,
    });
  }
  const checked = await checkFile(req, spec);
  if (checked.error) return res.status(400).json({ error: checked.error, headerMismatch: checked.headerMismatch });
  const good = checked.validated.filter(isGood);
  const result = good.length ? await spec.apply(good, checked.ctx) : { created: 0, updated: 0, skipped: 0, failed: [] };
  const failed = [
    ...(result.failed || []),
    ...checked.validated.filter((v) => v.errors && v.errors.length).map((v) => ({ line: v.line, reason: v.errors.map((e) => `${e.field}: ${e.message}`).join(' | ') })),
  ];
  await notifyDataIo(req, {
    kind: 'import', module: spec.module, count: checked.validated.length, created: result.created, updated: result.updated,
    skipped: (result.skipped || 0) + checked.preview.unchanged, what: spec.what,
    detail: `file ${checked.fileName}; ${failed.length} row(s) not imported`,
  });
  return res.json({
    ...checked.preview,
    imported: true,
    created: result.created || 0,
    updated: result.updated || 0,
    skipped: (result.skipped || 0),
    failed,
    message: `${spec.label}: created ${result.created || 0}, updated ${result.updated || 0}, unchanged ${checked.preview.unchanged}${failed.length ? `, ${failed.length} row(s) not imported` : ''}.`,
  });
}));

router.post('/:key/request', rawUpload, guarded(async (req, res) => {
  const { spec, caps } = await specAndCaps(req, res);
  if (!spec) return undefined;
  if (!caps.allowRequest) {
    return res.status(403).json({ error: caps.canImport ? 'You can import directly — use Import.' : (caps.importBlockedReason || 'Import requests are not available for this module.') });
  }
  const checked = await checkFile(req, spec);
  if (checked.error) return res.status(400).json({ error: checked.error, headerMismatch: checked.headerMismatch });
  const good = checked.validated.filter(isGood);
  if (!good.length) return res.status(422).json({ error: 'Nothing in this file would change anything — no request was created.', ...checked.preview });
  const keepLines = new Set(good.map((v) => v.line));
  const rows = checked.parsed.rows.filter((r) => keepLines.has(r.line));
  const note = String(req.query.note || '').slice(0, 500) || null;
  const created = await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      actorName: req.user.name || req.user.email,
      action: `Import request — ${spec.module}`,
      entity: REQUEST_ENTITY,
      entityId: spec.key,
      fromValue: checked.fileName,
      toValue: JSON.stringify({ module: spec.module, label: spec.label, rows, preview: checked.preview }),
      approvalStatus: 'Pending',
      reason: note,
    },
  });
  await notifyDataIo(req, {
    kind: 'import-request', module: spec.module, count: good.length, what: spec.what, entityId: created.id,
    detail: `file ${checked.fileName}; create ${checked.preview.willCreate}, update ${checked.preview.willUpdate}`,
  });
  return res.status(201).json({ ...requestView(created), preview: checked.preview, message: 'Import request sent to the Super Admin. Nothing changes until it is approved.' });
}));

// Written for the audit trail of the framework itself (never throws).
router.use((err, req, res, next) => {
  logAudit({ userId: req.user && req.user.id, action: 'Data I/O error', entity: 'DataIO', toValue: String(err && err.message).slice(0, 300) });
  next(err);
});

module.exports = router;
