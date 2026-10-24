// ---------------------------------------------------------------------------
// /api/role-performance - HRMS -> Performance & Development -> Monthly Targets ->
// "Recruitment performance by role" (user spec 2026-10-13). READ-ONLY dashboard:
// the only write is the Super Admin's "who gets the credit" switch (AppSetting).
// All counting, scoping and access rules live in utils/rolePerformance.js.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { toXlsxBook } = require('../utils/tabularExport');
const RP = require('../utils/rolePerformance');
const D = require('../utils/rolePerformanceData');

const router = express.Router();
router.use(requireAuth);

const guarded = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    // eslint-disable-next-line no-console
    console.error('[role-performance]', e);
    return res.status(500).json({ error: 'Something went wrong loading the performance numbers. Please try again.' });
  }
  return undefined;
};

router.get('/options', guarded(async (req, res) => { res.json(await RP.options(req.user, req.query)); }));
router.get('/report', guarded(async (req, res) => { res.json(await RP.report(req.user, req.query)); }));
router.get('/drill', guarded(async (req, res) => { res.json(await RP.drill(req.user, req.query)); }));

router.get('/export', guarded(async (req, res) => {
  const book = await RP.sheets(req.user, req.query);
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Role performance exported (XLSX)', entity: 'RolePerformance',
    toValue: `${book.count} row(s)`,
  });
  res.setHeader('Content-Disposition', 'attachment; filename="role-performance.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(toXlsxBook(book.sheets));
}));

// Who gets the credit for a selection / joining (one switch, one function: utils/rolePerformanceData.js creditFor).
router.get('/attribution', guarded(async (req, res) => {
  const mode = await D.attributionMode();
  res.json({ mode, text: D.MODE_TEXT[mode], modes: D.MODES.map((m) => ({ id: m, text: D.MODE_TEXT[m] })), canChange: RP.viewerOf(req.user).setting });
}));
router.put('/attribution', guarded(async (req, res) => {
  if (!RP.viewerOf(req.user).setting) return res.status(403).json({ error: 'Only the Super Admin can change who gets the credit.' });
  const mode = String((req.body && req.body.mode) || '');
  if (!D.MODES.includes(mode)) return res.status(400).json({ error: 'Pick one of the listed ways.' });
  const before = await D.attributionMode();
  await prisma.appSetting.upsert({
    where: { key: D.SETTING_KEY },
    create: { key: D.SETTING_KEY, value: JSON.stringify(mode), updatedById: req.user.id, updatedByName: req.user.name },
    update: { value: JSON.stringify(mode), updatedById: req.user.id, updatedByName: req.user.name },
  });
  D.invalidate();
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Role performance credit rule changed', entity: 'AppSetting', entityId: D.SETTING_KEY,
    fromValue: before, toValue: mode,
  });
  return res.json({ mode, text: D.MODE_TEXT[mode], saved: true });
}));

module.exports = router;
