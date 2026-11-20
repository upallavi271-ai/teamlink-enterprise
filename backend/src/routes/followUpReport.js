// /api/followup-report - THE TEAM FOLLOW-UP REPORT (founder 2026-11-20). One place for a TL to read all their recruiters'
// daily / weekly / monthly follow-ups; a recruiter reads only their own. WHO is in the picture is decided by ONE function
// (utils/followUpScope.js) and every endpoint below, the Excel file included, asks it; the counting is utils/followUpReport.js.
//   GET /options                                          who I am for this report + the pickers (TL, department, team)
//   GET /summary?from&to&period&leadId&department&team&imported&kind   one row per person, the totals, the day / week / month columns
//   GET /person?personId&from&to&period                   one person's column-by-column table
//   GET /list?from&to&leadId&personId&q&kind&type&status&outcome&imported&limit&offset   the follow-ups, each once
//   GET /export?format=xlsx|csv&(the same filters)        Excel: the table, the day-by-day table and the full list; audited
const express = require('express');
const { requireAuth, requireProduct } = require('../middleware/auth');
const FS = require('../utils/followUpScope');
const FR = require('../utils/followUpReport');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

async function scoped(req, res) {
  const scope = await FS.resolve(req.user, req.query || {});
  if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return null; }
  return scope;
}
const send = (res, out) => res.status(out.status).json(out.body);

router.get('/options', async (req, res, next) => {
  try {
    const scope = await FS.resolve(req.user, {});
    if (!scope.ok) return res.status(scope.status).json({ error: scope.error });
    return res.json({
      kind: scope.kind, mode: scope.mode, label: scope.label, today: FR.today(),
      leads: scope.leads, departments: scope.departments, teams: scope.teams,
      people: scope.mode === 'team' ? scope.members.map((m) => ({ id: m.id, name: m.name, role: m.role, former: m.former })) : [],
    });
  } catch (e) { return next(e); }
});
router.get('/summary', async (req, res, next) => {
  try { const scope = await scoped(req, res); if (scope) send(res, await FR.summary(scope, req.query || {})); } catch (e) { next(e); }
});
router.get('/person', async (req, res, next) => {
  try { const scope = await scoped(req, res); if (scope) send(res, await FR.person(scope, req.query || {})); } catch (e) { next(e); }
});
router.get('/list', async (req, res, next) => {
  try { const scope = await scoped(req, res); if (scope) send(res, await FR.list(scope, req.query || {})); } catch (e) { next(e); }
});
router.get('/export', async (req, res, next) => {
  try {
    const KIT = require('../utils/exportKit'); // eslint-disable-line global-require
    const scope = await scoped(req, res);
    if (!scope) return undefined;
    const format = ['csv', 'xlsx'].includes(KIT.formatOf(req.query)) ? KIT.formatOf(req.query) : 'xlsx';
    const q = req.query || {};
    const s = await FR.summary(scope, q);
    if (s.status !== 200) return send(res, s);
    const l = await FR.list(scope, q, { all: true });
    if (l.status !== 200) return send(res, l);
    const b = s.body;
    const days = {
      name: 'Day by day',
      headers: ['Recruiter', ...b.buckets.map((x) => x.long || x.label), 'Total'],
      rows: [
        ...b.rows.map((r) => [`${r.name}${r.former ? ' (left)' : ''}`, ...r.trend, r.activity]),
        ...(scope.mode === 'team' ? [['Total', ...b.total.trend, b.total.activity]] : []),
      ],
    };
    return KIT.sendBook(req, res, {
      format, name: `follow-up-report-${b.from}-to-${b.to}`,
      sheets: [
        { name: 'Report', headers: b.table.headers, rows: b.table.rows },
        days,
        { name: 'Follow-ups', headers: FR.LIST_HEAD, rows: FR.listRows(l.body.rows) },
      ],
      entity: 'FollowUp', what: 'Follow-up report', scope: scope.mode === 'mine' ? 'own follow-ups' : scope.label, period: { from: b.from, to: b.to }, screen: 'Follow-up report',
    });
  } catch (e) { return next(e); }
});

// ---- IMPORT: follow-ups kept in a sheet before TeamLink (utils/followUpImport.js). Preview first, Apply, Undo. ----------------------------------
//   GET  /import/template                 the .xlsx with the columns and two example rows
//   POST /import/preview                  multipart: file (+ mapping JSON, sheet) -> every row Ready / Needs a choice / Refused; nothing written
//   POST /import/check   { batchId, choices }   the preview again with the choices
//   POST /import/apply   { batchId, choices }   writes the Ready rows; audited
//   GET  /import/batches                  the recent imports (an Admin: everybody's)
//   POST /import/batches/:id/undo         removes that batch's rows nobody edited since; the importer or an Admin; audited
const FI = require('../utils/followUpImport');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');

const guard = (fn) => async (req, res, next) => {
  try { return await fn(req, res); } catch (e) {
    if (e instanceof FI.ImportError) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
    return next(e);
  }
};
const refuseUnless = (req) => { if (!FI.mayImport(req.user)) throw new FI.ImportError(403, 'Importing follow-ups is for the recruiting team: Admin, Manager, STL, TL, and recruiters for their own follow-ups.'); };

router.get('/import/template', guard(async (req, res) => {
  refuseUnless(req);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="teamlink-follow-ups-import-template.xlsx"');
  return res.send(FI.template());
}));
router.post('/import/preview', guard(async (req, res) => {
  refuseUnless(req);
  let upload;
  try {
    upload = await attachments.parseMultipart(req, { maxBytes: FI.MAX_BYTES });
  } catch (err) {
    if (err.code === 'TOO_LARGE') throw new FI.ImportError(413, 'That file is over 5 MB. Split it into smaller files.');
    throw new FI.ImportError(400, 'Send the sheet as a file upload.');
  }
  const { file, fields = {} } = upload;
  if (!file || !file.data || !file.data.length) throw new FI.ImportError(400, 'Choose the sheet to import.');
  let mapping = null;
  if (fields.mapping) { try { mapping = JSON.parse(fields.mapping); } catch { mapping = null; } }
  return res.json(await FI.preview(req.user, file, { mapping, sheet: fields.sheet || null }));
}));
router.post('/import/check', guard(async (req, res) => res.json(await FI.check(req.user, (req.body || {}).batchId, (req.body || {}).choices))));
router.post('/import/apply', guard(async (req, res) => {
  const out = await FI.apply(req.user, (req.body || {}).batchId, (req.body || {}).choices);
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Follow-ups imported from a sheet: ${out.created} (batch ${out.batchId})`, entity: 'FollowUpImport', entityId: out.batchId,
    toValue: JSON.stringify({ file: out.fileName, created: out.created, skipped: out.skipped.length, people: out.people, days: out.days }).slice(0, 900),
  });
  return res.json({ ...out, message: `${out.created} follow-up${out.created === 1 ? '' : 's'} imported. They count in the report on the dates in the sheet. You can undo this import.` });
}));
router.get('/import/batches', guard(async (req, res) => res.json({ batches: await FI.batches(req.user) })));
router.post('/import/batches/:id/undo', guard(async (req, res) => {
  const out = await FI.undo(req.user, req.params.id);
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Follow-up import undone: ${out.removed} removed${out.kept ? `, ${out.kept} kept (edited since)` : ''} (batch ${out.batchId})`, entity: 'FollowUpImport', entityId: out.batchId,
    toValue: JSON.stringify({ file: out.fileName, importedBy: out.byName, removed: out.removed, kept: out.kept, keptRows: out.keptRows }).slice(0, 900),
  });
  return res.json({ ...out, message: `${out.removed} imported follow-up${out.removed === 1 ? '' : 's'} removed.${out.kept ? ` ${out.kept} kept because somebody changed ${out.kept === 1 ? 'it' : 'them'} after the import.` : ''}` });
}));

module.exports = router;
