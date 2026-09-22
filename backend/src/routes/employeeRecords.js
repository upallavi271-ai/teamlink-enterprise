const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const attachments = require('../utils/attachments');


// Backs the ~11 similarly-shaped HRMS self-service areas (KT, Targets,
// Resignation, Recognition, Disciplinary, Shift Roster, Timesheet, Assets,
// Expense Claims, Helpdesk, Access Requests, Weekly Ideas) off one EmployeeRecord
// model, discriminated by `type`. Each router mounted from index.js is scoped
// to its own type so the frontend just sees a normal-looking REST resource.
// `createRoles: true` means only someone with HRMS Employee Management reach
// may raise this record type for another employee; the decision (approve/
// reject) always needs hrms/Employee Services/approve from the engine.
// `attachments: true` adds the bill/receipt upload + download pair, today only
// for EXPENSE claims (see utils/attachments.js).
function employeeRecordRouter(type, { createRoles = null, attachments: withFiles = false } = {}) {
  const router = express.Router();
  router.use(requireAuth);

  // The record, if this user may reach it at all — exactly the rule the list
  // and the free-form patch below already apply, in one place so the upload
  // and the download cannot drift from it.
  // DEPARTMENT-SCOPED, via the one rule in utils/scope.js: an HRMS lead reaches
  // their departments' records and nobody else's; everyone else reaches their
  // own. This covers KT, Targets, Recognition, Disciplinary, Shift Roster,
  // Timesheet, Assets, Expense Claims, Access Requests and Weekly Ideas at once.
  async function reachable(req, id) {
    const record = await prisma.employeeRecord.findUnique({ where: { id }, include: { employee: true } });
    if (!record || record.type !== type) return { error: 404 };
    if (!employeeInScope(req.user, record.employee)) return { error: 403 };
    return { record };
  }

  router.get('/', async (req, res) => {
    const where = { type, ...employeeRecordWhere(req.user) };
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.status) where.status = req.query.status;
    const records = await prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
    res.json(records);
  });

  router.post('/', async (req, res) => {
    // RAISING A RECORD FOR SOMEONE ELSE IS A WRITE, so it asks a write
    // permission. It used to ask caps.hrmsManage, which is Employee
    // Management/VIEW — so a view-only Manager (§3) could still set another
    // person's target, log a disciplinary case or hand out an asset. It asks
    // hrms/Employee Services/create now, which is the same action the
    // announcements, surveys and asset-inventory routes require.
    if (createRoles && !await can(req.user, 'hrms', 'hrms', 'Employee Services', 'create')) {
      return res.status(403).json({ error: "This isn't included in your role's permissions" });
    }
    const {
      title, detail, date, amount, hours, category, priority, progressPct, location,
      achieved, unit, fromName, toName, points,
    } = req.body;
    let employeeId = req.body.employeeId;
    if (req.user.caps.hrmsSelfOnly) {
      const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
      if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
      employeeId = own.id;
    }
    if (!employeeId || !title) return res.status(400).json({ error: 'employeeId and title are required' });
    if (!req.user.caps.hrmsSelfOnly) {
      const target = await prisma.employee.findUnique({ where: { id: employeeId } });
      if (!target) return res.status(404).json({ error: 'Employee not found' });
      if (!employeeInScope(req.user, target)) return res.status(403).json(OUT_OF_SCOPE);
    }

    const record = await prisma.employeeRecord.create({
      data: {
        type, employeeId, title, detail, date, category, priority, location,
        amount: amount != null ? Number(amount) : null,
        hours: hours != null ? Number(hours) : null,
        progressPct: progressPct != null ? Number(progressPct) : null,
        // Performance & Development extras (Targets, Recognition, KT,
        // Disciplinary). Ignored by the record types that do not use them.
        achieved: achieved != null ? Number(achieved) : null,
        unit: unit || null,
        // Recognition is peer-to-peer, so the giver is whoever is signed in.
        fromName: fromName || (type === 'RECOGNITION' ? (req.user.name || req.user.email) : null),
        toName: toName || null,
        points: points != null ? Number(points) : null,
        // Who logged the case — the prototype's Disciplinary "Raised By" column.
        raisedBy: type === 'DISCIPLINARY' ? (req.user.name || req.user.email) : null,
      },
    });
    await logAudit({ userId: req.user.id, action: `${type} created`, entity: 'EmployeeRecord', entityId: record.id });
    res.status(201).json(record);
  });

  router.patch('/:id/status', requirePerm(null, 'hrms', 'Employee Services', 'approve'), async (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const reach = await reachable(req, req.params.id);
    if (reach.error === 404) return res.status(404).json({ error: 'Record not found' });
    if (reach.error) return res.status(403).json(OUT_OF_SCOPE);
    const record = await prisma.employeeRecord.update({ where: { id: req.params.id }, data: { status } });
    await logAudit({ userId: req.user.id, action: `${type} status changed`, entity: 'EmployeeRecord', entityId: record.id, toValue: status });
    res.json(record);
  });

  // Free-form field patch (e.g. progress %) — for the record's own employee or HR.
  router.patch('/:id', async (req, res) => {
    const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Record not found' });
    if (req.user.caps.hrmsSelfOnly) {
      const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
      if (!own || existing.employeeId !== own.id) return res.status(403).json({ error: "This isn't included in your role's permissions" });
    }
    const { progressPct, detail, achieved, amount, unit } = req.body;
    const data = {};
    if (progressPct != null) data.progressPct = Number(progressPct);
    if (detail !== undefined) data.detail = detail;
    if (achieved != null) data.achieved = Number(achieved);
    if (amount != null) data.amount = Number(amount);
    if (unit !== undefined) data.unit = unit;
    const record = await prisma.employeeRecord.update({ where: { id: req.params.id }, data });
    res.json(record);
  });

  if (withFiles) {
    // --- Bill / receipt upload -------------------------------------------
    // No express.json() here: the body is multipart and is read straight off
    // the socket by utils/attachments.js, which aborts past the size cap.
    router.post('/:id/bill', async (req, res, next) => {
      try {
        const { record, error } = await reachable(req, req.params.id);
        if (error === 404) return res.status(404).json({ error: 'Record not found' });
        if (error === 403) return res.status(403).json({ error: "This isn't included in your role's permissions" });

        let parsed;
        try {
          parsed = await attachments.parseMultipart(req);
        } catch (err) {
          return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' });
        }
        let stored;
        try {
          stored = attachments.store(parsed.file);
        } catch (err) {
          return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not store the upload.' });
        }
        // Replacing a bill removes the old bytes rather than orphaning them.
        if (record.billFile) attachments.remove(record.billFile);
        const updated = await prisma.employeeRecord.update({ where: { id: record.id }, data: stored });
        await logAudit({
          userId: req.user.id, action: `${type} bill uploaded`,
          entity: 'EmployeeRecord', entityId: record.id, toValue: stored.billName,
        });
        return res.json(updated);
      } catch (err) { return next(err); }
    });

    // --- Bill / receipt download ------------------------------------------
    // Same scope check as the claim itself. The path is rebuilt from the
    // stored name only after utils/attachments.js has re-validated it, so the
    // id in the URL can never reach a file outside the upload directory.
    router.get('/:id/bill', async (req, res, next) => {
      try {
        const { record, error } = await reachable(req, req.params.id);
        if (error === 404) return res.status(404).json({ error: 'Record not found' });
        if (error === 403) return res.status(403).json({ error: "This isn't included in your role's permissions" });
        if (!record.billFile) return res.status(404).json({ error: 'No bill attached to this claim' });
        const full = attachments.resolveStored(record.billFile);
        if (!full) return res.status(404).json({ error: 'The attached file is no longer on the server' });
        res.setHeader('Content-Type', record.billMime || 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // `attachment` — a stored PDF or image is never rendered in-page.
        res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(record.billName)}"`);
        return res.sendFile(full);
      } catch (err) { return next(err); }
    });
  }

  return router;
}

module.exports = employeeRecordRouter;
