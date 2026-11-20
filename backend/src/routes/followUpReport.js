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

module.exports = router;
