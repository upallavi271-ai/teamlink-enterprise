const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');


// Backs the ~11 similarly-shaped HRMS self-service areas (KT, Targets,
// Resignation, Recognition, Disciplinary, Shift Roster, Timesheet, Assets,
// Expense Claims, Helpdesk, Access Requests, Weekly Ideas) off one EmployeeRecord
// model, discriminated by `type`. Each router mounted from index.js is scoped
// to its own type so the frontend just sees a normal-looking REST resource.
// `createRoles: true` means only someone with HRMS Employee Management reach
// may raise this record type for another employee; the decision (approve/
// reject) always needs hrms/Employee Services/approve from the engine.
function employeeRecordRouter(type, { createRoles = null } = {}) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const where = { type };
    if (req.user.caps.hrmsSelfOnly) {
      const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
      if (!own) return res.json([]);
      where.employeeId = own.id;
    } else if (req.query.employeeId) {
      where.employeeId = req.query.employeeId;
    }
    if (req.query.status) where.status = req.query.status;
    const records = await prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
    res.json(records);
  });

  router.post('/', async (req, res) => {
    if (createRoles && !req.user.caps.hrmsManage) {
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

  return router;
}

module.exports = employeeRecordRouter;
