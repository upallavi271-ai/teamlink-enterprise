// ---------------------------------------------------------------------------
// PROBATION AND CONFIRMATION (founder 2026-11-25). Logic: utils/probation.js. ADDITIVE: it reads Employee and writes only its own two tables.
//
//   GET  /api/probation/summary?bucket=&dept=&q=   the list for the screen + counts per tab + whether tracking is ON
//   GET  /api/probation/export?format=csv|xlsx&bucket=&dept=&q=   the same list as a file (audited)
//   GET  /api/probation/by-employee/:employeeId    one person's record (or null), for an employee card
//   GET  /api/probation/settings                   switch, probation length, confirmation letter text      (HR / Admin)
//   PUT  /api/probation/settings                   save them; switching ON makes the records of today's staff   (HR / Admin)
//   POST /api/probation/sync                       "check for new joiners now"                                   (HR / Admin)
//   GET  /api/probation/:id                        one record with its history
//   POST /api/probation/:id/review                 the Team Lead's score, notes and recommendation (anyone whose team scope covers the person)
//   POST /api/probation/:id/confirm | extend | end | reopen | track                                              (HR / Admin)
//   GET  /api/probation/:id/letter[?on=YYYY-MM-DD] the confirmation letter as a PDF to look at (nothing is filed)   (HR / Admin)
//   POST /api/probation/:id/letter                 make the letter again and file it in the employee's documents     (HR / Admin)
//
// WHO: HR and Admin with company-wide scope (utils/scope.js hrmsGlobal) see everyone and make every decision. Anybody else sees only the
// people inside their own team scope (never themselves) and can only add a review.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { hrmsGlobal } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const P = require('../utils/probation');

const router = express.Router();
router.use(requireAuth);

const hrOnly = (req, res, next) => (hrmsGlobal(req.user) ? next() : res.status(403).json({ error: 'Only HR and Admin can do this.' }));
const reply = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

router.get('/summary', wrap(async (req, res) => {
  res.json(await P.list(req.user, { bucket: String(req.query.bucket || 'inProbation'), dept: String(req.query.dept || ''), q: String(req.query.q || '') }));
}));

router.get('/export', wrap(async (req, res) => {
  const format = String(req.query.format || 'xlsx').toLowerCase();
  if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'format must be csv or xlsx.' });
  const out = await P.list(req.user, { bucket: String(req.query.bucket || 'inProbation'), dept: String(req.query.dept || ''), q: String(req.query.q || '') });
  const headers = ['Code', 'Name', 'Department', 'Team', 'Designation', 'Status', 'Start', 'End', 'Days left', 'Team Lead', 'Review score', 'Recommendation', 'Confirmed on'];
  const rows = out.rows.map((r) => [r.employeeCode || '', r.name, r.department || '', r.team || '', r.designation || '', r.status, r.startDate || '', r.endDate || '', r.daysLeft === null ? '' : r.daysLeft, r.reviewer || '', r.review && r.review.score !== null ? r.review.score : '', r.review ? r.review.recommendation : '', r.confirmedOn || '']);
  await logAudit({ userId: req.user.id, action: `Probation list exported (${format})`, entity: 'Probation', entityId: out.bucket, toValue: `${rows.length} rows` });
  const base = `Probation - ${out.bucket}`;
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(`﻿${toCsv(headers, rows)}`);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  return res.send(toXlsx(headers, rows, 'Probation'));
}));

router.get('/by-employee/:employeeId', wrap(async (req, res) => { res.json(await P.byEmployee(req.user, req.params.employeeId)); }));

router.get('/settings', hrOnly, wrap(async (req, res) => { res.json(await P.getSettings()); }));
router.put('/settings', hrOnly, wrap(async (req, res) => { reply(res, await P.saveSettings(req.body, req.user)); }));
router.post('/sync', hrOnly, wrap(async (req, res) => {
  const out = await P.sync({ by: req.user });
  await logAudit({ userId: req.user.id, action: 'Probation: checked for new joiners', entity: 'Probation', entityId: 'sync', toValue: out.skipped ? 'switched off' : `${out.created} new` });
  reply(res, out);
}));

router.get('/:id', wrap(async (req, res) => { reply(res, await P.detail(req.user, req.params.id)); }));
router.post('/:id/review', wrap(async (req, res) => { reply(res, await P.review(req.user, req.params.id, req.body)); }));
router.post('/:id/confirm', hrOnly, wrap(async (req, res) => { reply(res, await P.confirm(req.user, req.params.id, req.body)); }));
router.post('/:id/extend', hrOnly, wrap(async (req, res) => { reply(res, await P.extend(req.user, req.params.id, req.body)); }));
router.post('/:id/end', hrOnly, wrap(async (req, res) => { reply(res, await P.endService(req.user, req.params.id, req.body)); }));
router.post('/:id/reopen', hrOnly, wrap(async (req, res) => { reply(res, await P.reopen(req.user, req.params.id, req.body)); }));
router.post('/:id/track', hrOnly, wrap(async (req, res) => { reply(res, await P.track(req.user, req.params.id, req.body)); }));
router.get('/:id/letter', hrOnly, wrap(async (req, res) => {
  const out = await P.letterPreview(req.params.id, req.query.on);
  if (out.error) return reply(res, out);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${out.fileName.replace(/[^A-Za-z0-9 ._()-]+/g, '')}"`);
  return res.send(out.pdf);
}));
router.post('/:id/letter', hrOnly, wrap(async (req, res) => { reply(res, await P.letterFile(req.user, req.params.id)); }));

module.exports = router;
