// ---------------------------------------------------------------------------
// DOCUMENT EXPIRY, NDAs AND POLICY VERSIONS (founder 2026-11-25). Logic: utils/docRegister.js and utils/policyRegister.js.
// ADDITIVE: it reads Employee, EmployeeDocument, PolicyDocument and Acknowledgment and writes only its own four tables.
//
// HR / Admin (company-wide scope, utils/scope.js hrmsGlobal):
//   GET  /api/doc-register/overview                       numbers for the top of the page
//   GET  /api/doc-register/settings   PUT .../settings    reminders on / off, "due soon" days, remind the employee too
//   POST /api/doc-register/sweep                          run the reminders now
//   GET  /api/doc-register/items?bucket=&q=&kind=         tracked documents and agreements
//   GET  /api/doc-register/items/export?format=&bucket=   the same as a file (audited)
//   GET  /api/doc-register/items/no-nda?q=                people with no NDA on record
//   POST /api/doc-register/items                          add one
//   PUT  /api/doc-register/items/:id                      edit name, dates, note, linked file
//   POST /api/doc-register/items/:id/renew                new expiry date
//   DELETE /api/doc-register/items/:id                    remove from the tracker (the history is kept)
//   GET  /api/doc-register/people?q=                      employee picker
//   GET  /api/doc-register/people/:employeeId/documents   that person's uploaded files, to link one
//   GET  /api/doc-register/policies?bucket=&q=            policy register
//   GET  /api/doc-register/policies/:id                   versions, review plan, history, who accepted which version
//   GET  /api/doc-register/policies/:id/people?format=    that last list as a file (audited)
//   POST /api/doc-register/policies/:id/version           record a new version
//   PUT  /api/doc-register/policies/:id/review            set the review plan
//   POST /api/doc-register/policies/:id/reviewed          mark as reviewed today
// Any logged-in employee (their own record only):
//   GET  /api/doc-register/my-policies                    policies with a newer version to accept again
//   POST /api/doc-register/policies/:id/reack             accept the current version
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { hrmsGlobal } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { toCsv, toXlsx } = require('../utils/tabularExport');
const DR = require('../utils/docRegister');
const PR = require('../utils/policyRegister');

const router = express.Router();
router.use(requireAuth);

const hrOnly = (req, res, next) => (hrmsGlobal(req.user) ? next() : res.status(403).json({ error: 'Only HR and Admin can do this.' }));
const reply = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

async function sendFile(req, res, { base, headers, rows, sheet, auditAction, auditId }) {
  const format = String(req.query.format || 'xlsx').toLowerCase();
  if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'format must be csv or xlsx.' });
  await logAudit({ userId: req.user.id, action: `${auditAction} (${format})`, entity: 'DocRegister', entityId: auditId, toValue: `${rows.length} rows` });
  const name = base.replace(/[^A-Za-z0-9 ._()-]+/g, '').slice(0, 90).trim() || 'Export';
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(`﻿${toCsv(headers, rows)}`);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  return res.send(toXlsx(headers, rows, sheet));
}

// ---- employee side (any login, own record) -------------------------------------------------------------------------------
router.get('/my-policies', wrap(async (req, res) => { res.json(await PR.myPending(req.user)); }));
router.post('/policies/:id/reack', wrap(async (req, res) => { reply(res, await PR.reack(req.user, req.params.id)); }));

// ---- HR / Admin -------------------------------------------------------------------------------------------------------------
router.use(hrOnly);

router.get('/overview', wrap(async (req, res) => {
  const [items, policies, settings] = await Promise.all([DR.list({ bucket: 'all' }), PR.overview(), DR.getSettings()]);
  res.json({ settings, items: items.counts, policies });
}));
router.get('/settings', wrap(async (req, res) => { res.json(await DR.getSettings()); }));
router.put('/settings', wrap(async (req, res) => { reply(res, await DR.saveSettings(req.body, req.user)); }));
router.post('/sweep', wrap(async (req, res) => {
  const out = await DR.sweep({ force: true });
  await logAudit({ userId: req.user.id, action: 'Document and policy reminders run by hand', entity: 'DocRegister', entityId: 'sweep', toValue: out.skipped ? 'switched off' : `${(out.expiry.told || []).length} expiry, ${(out.reviews.told || []).length} review` });
  res.json(out);
}));

router.get('/items', wrap(async (req, res) => { res.json(await DR.list({ bucket: String(req.query.bucket || 'expired'), q: String(req.query.q || ''), kind: String(req.query.kind || '') })); }));
router.get('/items/no-nda', wrap(async (req, res) => { res.json(await DR.noNda({ q: String(req.query.q || '') })); }));
router.get('/items/export', wrap(async (req, res) => {
  const bucket = String(req.query.bucket || 'expired');
  if (bucket === 'noNda') {
    const out = await DR.noNda({ q: String(req.query.q || '') });
    return sendFile(req, res, { base: 'No NDA on record', headers: ['Code', 'Name', 'Department', 'Designation', 'Joined'], rows: out.rows.map((r) => [r.employeeCode || '', r.name, r.department || '', r.designation || '', r.joined || '']), sheet: 'No NDA', auditAction: 'No-NDA list exported', auditId: 'no-nda' });
  }
  const out = await DR.list({ bucket, q: String(req.query.q || ''), kind: String(req.query.kind || '') });
  return sendFile(req, res, {
    base: `Document expiry - ${out.bucket}`, sheet: 'Expiry',
    headers: ['Code', 'Name', 'Department', 'Kind', 'Title', 'Issued', 'Expires', 'Days left', 'Status', 'File', 'Note'],
    rows: out.rows.map((r) => [r.employeeCode || '', r.name, r.department || '', r.kind, r.title, r.issuedOn || '', r.expiresOn || '', r.daysLeft === null ? '' : r.daysLeft, r.status, r.file ? r.file.fileName : '', r.note || '']),
    auditAction: 'Document expiry list exported', auditId: out.bucket,
  });
}));
router.post('/items', wrap(async (req, res) => { reply(res, await DR.createItem(req.user, req.body)); }));
router.put('/items/:id', wrap(async (req, res) => { reply(res, await DR.updateItem(req.user, req.params.id, req.body)); }));
router.post('/items/:id/renew', wrap(async (req, res) => { reply(res, await DR.renewItem(req.user, req.params.id, req.body)); }));
router.delete('/items/:id', wrap(async (req, res) => { reply(res, await DR.removeItem(req.user, req.params.id, req.body)); }));

router.get('/people', wrap(async (req, res) => { res.json(await DR.peopleFind(String(req.query.q || ''))); }));
router.get('/people/:employeeId/documents', wrap(async (req, res) => { res.json(await DR.documentsOf(req.params.employeeId)); }));

router.get('/policies', wrap(async (req, res) => { res.json(await PR.listPolicies({ bucket: String(req.query.bucket || 'all'), q: String(req.query.q || '') })); }));
router.get('/policies/:id', wrap(async (req, res) => { reply(res, await PR.detail(req.params.id)); }));
router.get('/policies/:id/people', wrap(async (req, res) => {
  const out = await PR.detail(req.params.id);
  if (out.error) return reply(res, out);
  return sendFile(req, res, {
    base: `Policy acceptance - ${out.policy.title}`, sheet: 'Acceptance',
    headers: ['Code', 'Name', 'Department', 'Status', 'Version read', 'Accepted on'],
    rows: out.people.map((p) => [p.employeeCode || '', p.name, p.department || '', p.state, p.versionRead || '', p.acknowledgedOn ? p.acknowledgedOn.slice(0, 10) : '']),
    auditAction: 'Policy acceptance list exported', auditId: out.policy.id,
  });
}));
router.post('/policies/:id/version', wrap(async (req, res) => { reply(res, await PR.recordVersion(req.user, req.params.id, req.body)); }));
router.put('/policies/:id/review', wrap(async (req, res) => { reply(res, await PR.setReview(req.user, req.params.id, req.body)); }));
router.post('/policies/:id/reviewed', wrap(async (req, res) => { reply(res, await PR.markReviewed(req.user, req.params.id, req.body)); }));

module.exports = router;
