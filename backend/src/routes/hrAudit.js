// ---------------------------------------------------------------------------
// HR AUDIT CHECKS (founder 2026-11-24). READ-ONLY: it lists what looks wrong in data the app already keeps; it changes nothing.
//
//   GET /api/hr-audit/summary[?refresh=1]       the headline HR numbers + every check with its count
//   GET /api/hr-audit/checks/:key               the rows of one check          { check, columns, rows }
//   GET /api/hr-audit/checks/:key?format=csv    the same as a CSV file    (audited)
//   GET /api/hr-audit/checks/:key?format=xlsx   the same as an Excel file (audited)
//
// WHO: HR and Admin with company-wide scope (utils/scope.js hrmsGlobal). Anyone else gets 403: the lists name people across all teams
// and include pay and access facts. Logic and the 19 checks live in utils/hrAuditChecks.js.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { hrmsGlobal } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const checks = require('../utils/hrAuditChecks');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (hrmsGlobal(req.user)) return next();
  return res.status(403).json({ error: 'The HR audit checks are for HR and Admin only.' });
});

router.get('/summary', async (req, res, next) => {
  try {
    res.json(await checks.summary({ refresh: req.query.refresh === '1' }));
  } catch (e) { next(e); }
});

router.get('/checks/:key', async (req, res, next) => {
  try {
    const out = await checks.detail(req.params.key);
    if (!out) return res.status(404).json({ error: 'There is no such check.' });
    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'json') return res.json(out);
    if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'format must be json, csv or xlsx.' });
    const headers = out.columns;
    const rows = out.rows.map((r) => [r.name, r.code, r.department, r.designation, r.detail]);
    await logAudit({ userId: req.user.id, action: `HR audit check exported (${format})`, entity: 'HrAudit', entityId: out.check.key, toValue: `${rows.length} rows` });
    const base = `HR audit - ${out.check.title}`.replace(/[^A-Za-z0-9 ._-]+/g, '').slice(0, 90).trim() || 'HR audit';
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      return res.send(`﻿${toCsv(headers, rows)}`);
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    return res.send(toXlsx(headers, rows, 'Audit check'));
  } catch (e) { return next(e); }
});

module.exports = router;
