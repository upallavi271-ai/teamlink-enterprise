// ---------------------------------------------------------------------------
// /api/outreach/gs/analytics : Analytics & Reports (Communication Analytics, Social Media Analytics, Conversion Funnel). Read only.
//   GET /comm?from=YYYY-MM-DD&to=YYYY-MM-DD&preset=&dept=     totals, live-status donut, channel breakdown, top failure reasons, recent activity
//   GET /funnel?from&to&channel=whatsapp|sms|email&dept=      people -> sent -> delivered -> opened link -> replied -> applied -> interview -> offer -> joined
//   GET /social                                               the honest "no social account connected" state (nothing is faked)
//   GET /report.csv?from&to&dept=                             the export (Admin, Manager, Team Lead, BDE TL, Marketing); audited; numbers only
// Dates are India days. Every number is held to the campaigns this login may see (campaigns.visibleRows) and to ?dept=.
// ---------------------------------------------------------------------------
const express = require('express');
const { logAudit } = require('../utils/audit');
const A = require('../outreach/access');
const Chrome = require('../outreach/chrome');
const Ins = require('../outreach/insights');
const S = require('../outreach/store');

const router = express.Router();
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { next(e); } };
router.use((req, res, next) => (A.pagesFor(req.user).includes('analytics') ? next() : res.status(403).json({ error: 'Analytics is not for your login.' })));
const needReady = wrap(async (req, res, next) => ((await S.campaignsReady()) ? next() : res.json({ ready: false, error: 'Campaigns are being set up. Please try again in a little while.' })));
const q = (req) => ({ from: req.query.from, to: req.query.to, preset: req.query.preset, channel: req.query.channel, dept: Chrome.deptOf(req.user, req.query.dept) });

router.get('/comm', needReady, wrap(async (req, res) => res.json(await Ins.commAnalytics(req.user, q(req)))));
router.get('/funnel', needReady, wrap(async (req, res) => res.json(await Ins.funnelFull(req.user, q(req)))));
router.get('/social', wrap(async (req, res) => res.json({ connected: false, accounts: [], words: 'No social account is connected to Omni-Channel yet, so there are no posts and no numbers to show.' })));
router.get('/report.csv', needReady, wrap(async (req, res) => {
  if (!A.mayExportReport(req.user)) return res.status(403).json({ error: 'You cannot download reports.' });
  const rep = await Ins.commAnalytics(req.user, q(req));
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel analytics report downloaded', entity: 'OmniReport', entityId: 'analytics', toValue: `${rep.activity.length} campaigns, ${rep.range.from} to ${rep.range.to}` });
  res.set('Content-Disposition', 'attachment; filename="analytics_report.csv"');
  res.type('text/csv');
  return res.send(Ins.reportCsvFull(rep));
}));

module.exports = router;
