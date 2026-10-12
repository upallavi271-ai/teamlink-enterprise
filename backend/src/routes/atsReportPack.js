// ---------------------------------------------------------------------------
// /api/ats-report-pack — TEAM-WISE and PERSON-WISE reports with their exports
// (ATS Reports -> "Team & person" tab). All the rules live in utils/reportPack.js;
// this file only turns requests into responses.
//
//   GET  /meta                         what this login may open (reports, views, buttons)
//   GET  /report?report=&view=&range=&from=&to=&group=&department=&team=&person=&people=
//   GET  /export?format=xlsx|pdf|csv&<same>      ONE report, exactly as the screen shows it
//   GET  /export-all?<same>            every report of the period in one workbook (leads)
//   GET  /export-people?<same>         one sheet per person (individual packs, leads)
//   POST /email  { kind: report|all|people, ...same }   the file, to the caller's OWN
//                                      address, only when e-mail is connected
//
// Scope is enforced inside utils/reportPack.js on every call: a recruiter gets only
// themselves, a TL their team, a BDE only client-wise numbers, Accounts only cash.
// Every download is written to the audit log (who, what, filters, rows).
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const RP = require('../utils/reportPack');
const EX = require('../utils/reportPackExport');

const router = express.Router();
router.use(requireAuth);

const guarded = (fn) => async (req, res, next) => {
  try { return await fn(req, res); } catch (err) {
    if (err instanceof RP.HttpError) return res.status(err.status).json({ error: err.message });
    if (err && err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
};

router.get('/meta', guarded(async (req, res) => res.json(await RP.meta(req.user))));

router.get('/report', guarded(async (req, res) => res.json(await RP.screenReport(req.user, req.query || {}))));

function send(res, out) {
  res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
  res.setHeader('Content-Type', out.type);
  res.setHeader('X-Export-Rows', String(out.rows));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows');
  if (out.pdf) {
    EX.toPdf(out.table, out.meta, res);
    return undefined;
  }
  return res.send(Buffer.isBuffer(out.body) ? out.body : Buffer.from(out.body));
}

const formatOf = (q) => {
  const f = String(q.format || 'xlsx').toLowerCase();
  if (f === 'excel') return 'xlsx';
  return ['xlsx', 'pdf', 'csv'].includes(f) ? f : 'xlsx';
};

router.get('/export', guarded(async (req, res) => send(res, await RP.exportReport(req.user, req.query || {}, formatOf(req.query || {})))));
router.get('/export-all', guarded(async (req, res) => send(res, await RP.exportAll(req.user, req.query || {}))));
router.get('/export-people', guarded(async (req, res) => send(res, await RP.exportPeople(req.user, req.query || {}))));

// "Send to my email": only to the caller's own address, only when e-mail is really connected.
router.post('/email', guarded(async (req, res) => {
  const body = req.body || {};
  const mailer = require('../utils/mailer'); // eslint-disable-line global-require
  const cfg = await mailer.emailConfig();
  if (!cfg.configured) return res.status(409).json({ error: 'E-mail is not connected yet, so nothing was sent. Download the file instead.', sent: false });
  if (!req.user.email) return res.status(409).json({ error: 'Your login has no e-mail address, so nothing was sent.', sent: false });
  const kind = ['all', 'people'].includes(body.kind) ? body.kind : 'report';
  const out = kind === 'all' ? await RP.exportAll(req.user, body)
    : kind === 'people' ? await RP.exportPeople(req.user, body)
      : await RP.exportReport(req.user, body, 'xlsx');
  const r = await mailer.sendMail({
    to: req.user.email,
    subject: `TeamLink report - ${out.name.replace(/\.xlsx$/, '')}`,
    text: 'Your TeamLink report is attached. It has the same numbers you saw on the screen.',
    attachments: [{ filename: out.name, content: out.body }],
    useEmployeeFrom: false,
    fromName: 'TeamLink Reports',
  });
  if (!r.ok) return res.status(502).json({ error: r.notConfigured ? 'E-mail is not connected yet, so nothing was sent.' : `The e-mail was not sent: ${String(r.error || '').slice(0, 160)}`, sent: false });
  return res.json({ sent: true, to: req.user.email, file: out.name });
}));

module.exports = router;
