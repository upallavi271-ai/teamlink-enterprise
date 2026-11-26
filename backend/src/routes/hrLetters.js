// HR LETTERS (utils/hrLetters.js): list, preview and send the letters of one employee. HR desk only (the same people as the exit letters),
// within the employees they may see, and only with the right to edit employee records.
const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { employeeInScope } = require('../utils/scope');
const exitDate = require('../utils/exitDate');
const attachments = require('../utils/attachments');
const hrLetters = require('../utils/hrLetters');

const router = express.Router();
router.use(requireAuth);

async function employeeFor(req, res) {
  const refuse = (status, error) => { res.status(status).json({ error }); return null; };
  if (!exitDate.isHrDesk(req.user)) return refuse(403, 'Only HR can make or send employee letters.');
  const employee = await prisma.employee.findUnique({ where: { id: req.params.employeeId } });
  if (!employee) return refuse(404, 'Employee not found');
  if (!employeeInScope(req.user, employee) || !await can(req.user, 'hrms', 'hrms', 'Employee Management', 'edit')) return refuse(403, "This isn't included in your role's permissions");
  return employee;
}

router.get('/:employeeId', async (req, res, next) => {
  try {
    const employee = await employeeFor(req, res); if (!employee) return undefined;
    return res.json(await hrLetters.listFor(employee.id));
  } catch (err) { return next(err); }
});

// body: { fields } -> the PDF, nothing saved and nothing sent
router.post('/:employeeId/:kind/preview', async (req, res, next) => {
  try {
    const employee = await employeeFor(req, res); if (!employee) return undefined;
    const out = await hrLetters.pdfFor(employee.id, req.params.kind, req.body && req.body.fields);
    if (out.error) return res.status(out.status || 409).json({ error: out.error });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${attachments.safeDisplayName(out.fileName)}"`);
    return res.send(out.pdf);
  } catch (err) { return next(err); }
});

// body: { fields, to } -> a person presses this; nothing sends by itself
router.post('/:employeeId/:kind/send', async (req, res, next) => {
  try {
    const employee = await employeeFor(req, res); if (!employee) return undefined;
    const body = req.body || {};
    const out = await hrLetters.send(employee.id, req.params.kind, body.fields, req.user, { to: body.to });
    if (out.state !== 'SENT') return res.status(409).json({ error: out.message });
    return res.json({ ...out, message: `The letter was emailed to ${out.to}.` });
  } catch (err) { return next(err); }
});

module.exports = router;
