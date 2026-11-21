// ---------------------------------------------------------------------------
// /api/ats-insights - the ATS dashboard insight cards and the Reports "Build & data" tabs (market wave, 2026-11-21).
// Everything is counted in the asking login's own scope (utils/insights/core.js ctxFor = the Reports rows).
//
//   GET  /access                       what this login may do here (+ the Admin switches for an Admin)
//   GET  /dashboard                    the dashboard cards: time to fill, closest to fill, forecast, leaderboard, alerts, charts
//   GET  /ttf  /readiness  /forecast  /openings  /bottlenecks  /leaderboard   the reports (?format=xlsx|csv to download)
//   POST /plan                         plan my day (AI-ranked, code fallback)
//   GET  /builder/schema · POST /builder/run · POST /builder/export · POST /ask     the report builder / ask for a chart
//   GET|POST /reports · DELETE /reports/:id · GET /reports/:id/run                  saved reports (private or team)
//   GET|POST /pins · DELETE /pins/:id                                                charts on my dashboard
//   GET|POST /alerts · PATCH|DELETE /alerts/:id · POST /alerts/check                 metric alerts
//   GET|POST /schedules · PATCH|DELETE /schedules/:id · GET /schedules/recipients    scheduled e-mails
//   GET /backdoor · POST /backdoor/mark · POST /backdoor/client-list                 backdoor hiring
//   GET /qoh · POST /qoh/link                                                         quality-of-hire surveys
//   GET /compliance (?format=xlsx)                                                    DPDP compliance pack (Admin / HR)
//   GET|POST /bi/keys · DELETE /bi/keys/:id                                           BI feed keys (Admin)
//   GET|PUT /switches · POST /run/:job                                               Admin switches (all OFF by default), run a check now
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const C = require('../utils/insights/core');
const M = require('../utils/insights/metrics');
const B = require('../utils/insights/builder');
const S = require('../utils/insights/saved');
const A = require('../utils/insights/alerts');
const SCH = require('../utils/insights/schedules');
const BD = require('../utils/insights/backdoor');
const Q = require('../utils/insights/qoh');
const P = require('../utils/insights/plan');
const CP = require('../utils/insights/compliance');
const BI = require('../utils/insights/bi');
const X = require('../utils/exportKit');
const { scopeLabel } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
const send = (res, r) => (r && r.status && r.error ? res.status(r.status).json({ error: r.error }) : res.json(r));
const NO_ACCESS = 'Insights are part of ATS Reports. Ask your admin if you need them.';

router.use(async (req, res, next) => {
  try {
    const acc = await C.access(req.user);
    if (!acc.ok) return res.status(403).json({ error: NO_ACCESS });
    req.acc = acc;
    return next();
  } catch (e) { return next(e); }
});
const adminOnly = (req, res, next) => (req.acc.admin ? next() : res.status(403).json({ error: 'Only a Super Admin or an Admin can do this.' }));
const writer = (req, res, next) => (req.viewAs ? res.status(403).json({ error: 'You are viewing as someone: nothing can be changed.' }) : next());

// ?format=xlsx|csv on a report: the sheets, audited (utils/exportKit.js).
async function maybeBook(req, res, name, what, sheets) {
  if (!req.query.format) return false;
  if (!req.acc.export) { res.status(403).json({ error: 'Downloading reports is not part of your role.' }); return true; }
  const format = X.formatOf(req.query) === 'csv' ? 'csv' : 'xlsx';
  await X.sendBook(req, res, { format, name, sheets, entity: 'AtsReport', what, scope: scopeLabel(req.user, 'ats') });
  return true;
}
const q = (req) => {
  const o = {};
  ['department', 'clientId'].forEach((k) => { if (req.query[k]) o[k] = String(req.query[k]); });
  return o;
};

router.get('/access', wrap(async (req, res) => {
  res.json({
    access: req.acc,
    switches: req.acc.admin ? await C.switches() : undefined,
    switchLabels: req.acc.admin ? C.SWITCHES : undefined,
    metrics: Object.entries(A.METRICS).map(([id, m]) => ({ id, ...m })),
  });
}));

// --- dashboard ------------------------------------------------------------------------------------
async function leaderboardFor(user, period = 'MONTHLY') {
  const T = require('../utils/atsWork/targets'); // eslint-disable-line global-require
  const lb = await T.leaderboard(user, { period }).catch((e) => ({ status: 500, error: e.message }));
  if (!lb || lb.status !== 200) return { hidden: true, message: (lb && (lb.error || lb.message)) || 'No ranking yet.', rows: [] };
  if (lb.hidden) return { hidden: true, message: lb.message, rows: [] };
  const rows = lb.rows || [];
  // gamification: a badge for the top of each number this period (only among the people this login may rank)
  const top = (k) => { const best = rows.filter((r) => Number(r[k]) > 0).sort((a, b) => b[k] - a[k])[0]; return best ? best.name : null; };
  const badges = [
    rows[0] && rows[0].score != null ? { badge: 'Top scorer', name: rows[0].name, icon: '🏆' } : null,
    top('joinings') && { badge: 'Most joinings', name: top('joinings'), icon: '🎯' },
    top('submissions') && { badge: 'Most sent to clients', name: top('submissions'), icon: '📤' },
    top('interviews') && { badge: 'Most interviews', name: top('interviews'), icon: '🗓️' },
  ].filter(Boolean);
  return { period: lb.period, from: lb.from, to: lb.to, you: lb.you, scope: lb.scope, ranked: lb.ranked, rows: rows.slice(0, 10), badges, refreshedAt: new Date().toISOString() };
}
router.get('/dashboard', wrap(async (req, res) => {
  const ctx = await C.ctxFor(req.user, q(req));
  const ttf = M.timeToFill(ctx, { days: 90 });
  const rd = M.readiness(ctx, { limit: 6 });
  const fc = await M.forecast(ctx, { money: req.acc.money });
  const [lb, pins, alerts, sw] = await Promise.all([
    leaderboardFor(req.user), S.pins(req.user), A.list(req.user.id), C.switches(),
  ]);
  res.json({
    ttf: { tiles: ttf.tiles, byClient: ttf.byClient.slice(0, 5), byMonth: ttf.byMonth.slice(-6), window: ttf.window },
    readiness: rd,
    forecast: { expectedJoinings: fc.expectedJoinings, inPipeline: fc.inPipeline, byStep: fc.byStep, byMonth: fc.byMonth, revenue: fc.revenue },
    leaderboard: lb,
    alerts: { rules: alerts.length, firing: alerts.filter((a) => a.firing).length, on: sw.alerts },
    pins,
    asOf: new Date().toISOString(),
  });
}));
router.get('/leaderboard', wrap(async (req, res) => res.json(await leaderboardFor(req.user, ['WEEKLY', 'MONTHLY', 'DAILY'].includes(String(req.query.period || '').toUpperCase()) ? String(req.query.period).toUpperCase() : 'MONTHLY'))));

// --- reports ----------------------------------------------------------------------------------------
router.get('/ttf', wrap(async (req, res) => {
  const ctx = await C.ctxFor(req.user, q(req));
  const out = M.timeToFill(ctx, { days: Number(req.query.days) || 0, clientId: req.query.client ? String(req.query.client) : '' });
  if (await maybeBook(req, res, 'time-to-fill', 'Time to fill by requirement and client', [
    { name: 'By requirement', headers: ['Requirement', 'Client', 'Department', 'Openings', 'Joined', 'Usual days to fill', 'Average days to fill', 'Fastest', 'Slowest', 'Usual days to hire'], rows: out.byJob.map((r) => [r.requirement, r.client, r.department, r.openings, r.joined, r.medianFill, r.avgFill, r.fastestFill, r.slowestFill, r.medianHire]) },
    { name: 'By client', headers: ['Client', 'Requirements', 'Joined', 'Usual days to fill', 'Average days to fill', 'Usual days to hire', 'Average days to hire'], rows: out.byClient.map((r) => [r.client, r.requirements, r.joined, r.medianFill, r.avgFill, r.medianHire, r.avgHire]) },
    { name: 'By month', headers: ['Month', 'Joined', 'Usual days to fill', 'Usual days to hire'], rows: out.byMonth.map((r) => [r.label, r.joined, r.medianFill, r.medianHire]) },
  ])) return;
  res.json(out);
}));
router.get('/readiness', wrap(async (req, res) => {
  const out = M.readiness(await C.ctxFor(req.user, q(req)));
  if (await maybeBook(req, res, 'closest-to-fill', 'Closest to fill', [{ name: 'Closest to fill', headers: ['Requirement', 'Client', 'Openings', 'Filled', 'Left', 'Ready %', 'Days open', 'Next step'], rows: out.rows.map((r) => [r.requirement, r.client, r.openings, r.filled, r.left, r.readiness, r.ageDays, r.next]) }])) return;
  res.json(out);
}));
router.get('/forecast', wrap(async (req, res) => {
  const out = await M.forecast(await C.ctxFor(req.user, q(req)), { money: req.acc.money });
  if (await maybeBook(req, res, 'pipeline-forecast', 'Pipeline forecast', [
    { name: 'By step', headers: ['Step', 'People', 'Chance of joining %', 'Expected joinings'], rows: out.byStep.map((r) => [r.label, r.people, r.chance, r.expected]) },
    { name: 'By client', headers: ['Client', 'People', 'Expected joinings', ...(out.revenue ? ['Expected fee (Rs)'] : [])], rows: out.byClient.map((r) => [r.client, r.people, r.expected, ...(out.revenue ? [r.revenue] : [])]) },
    { name: 'By month', headers: ['Month', 'Expected joinings', ...(out.revenue ? ['Expected fee (Rs)'] : [])], rows: out.byMonth.map((r) => [r.label, r.expected, ...(out.revenue ? [r.revenue] : [])]) },
  ])) return;
  res.json(out);
}));
router.get('/openings', wrap(async (req, res) => {
  const out = await M.openings(await C.ctxFor(req.user, q(req)), { multiOnly: req.query.all !== '1', status: ['live', 'closed', 'all'].includes(req.query.status) ? req.query.status : 'live' });
  if (await maybeBook(req, res, 'per-opening', 'Per-opening report', [{
    name: 'Openings',
    headers: ['Requirement', 'Client', 'Status', 'Opening', 'Opening status', 'Filled by', 'Filled on', 'Days to fill', 'Days open'],
    rows: out.rows.flatMap((r) => r.seats.map((s) => [r.requirement, r.client, r.status, s.opening, s.status, s.person || '', s.filledOn || '', s.daysToFill ?? '', s.daysOpen ?? ''])),
  }])) return;
  res.json(out);
}));
router.get('/bottlenecks', wrap(async (req, res) => {
  const out = M.bottlenecks(await C.ctxFor(req.user, q(req)), { days: Math.max(30, Math.min(730, Number(req.query.days) || 180)) });
  if (await maybeBook(req, res, 'bottlenecks-forecast', 'Bottlenecks and hiring forecast', [
    { name: 'Steps', headers: ['From', 'To', 'People', 'Moved on', 'Rate %'], rows: out.steps.map((s) => [s.from, s.to, s.people, s.moved, s.rate]) },
    { name: 'Waiting now', headers: ['Step', 'People', 'Usual days', 'Over 7 days', 'Over 15 days'], rows: out.waiting.map((w) => [w.step, w.people, w.usualDays, w.over7, w.over15]) },
    { name: 'Forecast', headers: ['Month', 'Requirements', 'Openings', 'Joined'], rows: [...out.trend.map((t) => [t.label, t.requirements, t.openings, t.joined]), [`${out.nextMonth.label} (forecast)`, out.nextMonth.requirements, out.nextMonth.openings, out.nextMonth.joined]] },
  ])) return;
  res.json(out);
}));

// --- plan my day ----------------------------------------------------------------------------------------
router.post('/plan', wrap(async (req, res) => res.json(await P.plan(req.user, { ai: (req.body || {}).ai !== false }))));

// --- builder / ask ----------------------------------------------------------------------------------------
router.get('/builder/schema', wrap(async (req, res) => res.json(B.schema())));
router.post('/builder/run', wrap(async (req, res) => {
  const { spec, dropped } = B.clean((req.body || {}).spec);
  res.json({ spec, dropped, result: await B.run(req.user, spec) });
}));
async function exportRun(req, res, spec, name) {
  if (!req.acc.export) return res.status(403).json({ error: 'Downloading reports is not part of your role.' });
  const out = await B.run(req.user, spec);
  const format = X.formatOf({ format: (req.body && req.body.format) || req.query.format }) === 'csv' ? 'csv' : 'xlsx';
  const sheets = [];
  if (out.groups) sheets.push({ name: 'Chart', headers: [out.groupBy.label, out.measure.label], rows: out.groups.map((g) => [g.label, g.value]) });
  sheets.push({ name: 'Rows', headers: out.columns.map((c) => c.label), rows: out.rows });
  return X.sendBook(req, res, { format, name: name || 'custom-report', sheets, entity: 'AtsReport', what: `Custom report: ${out.title}`, scope: scopeLabel(req.user, 'ats') });
}
router.post('/builder/export', wrap(async (req, res) => { const { spec } = B.clean((req.body || {}).spec); return exportRun(req, res, spec, (req.body || {}).name); }));
router.post('/ask', wrap(async (req, res) => {
  const question = String((req.body || {}).question || '').trim();
  if (question.length < 4) return res.status(400).json({ error: 'Type a question, for example "joinings by client this year".' });
  const { raw, viaAi, note } = await B.specFromQuestion(question);
  let { spec, dropped } = B.clean(raw);
  let usedNote = note;
  // an AI answer that names nothing we know falls back to the words of the question
  if (viaAi && dropped.length && !spec.groupBy) { ({ spec, dropped } = B.clean(B.parseQuestion(B.maskPii(question)))); usedNote = 'Built from the words of the question'; }
  return res.json({ question, spec, dropped, via: viaAi ? 'ai' : 'words', note: usedNote, result: await B.run(req.user, spec) });
}));

// --- saved reports + pins ----------------------------------------------------------------------------------------
router.get('/reports', wrap(async (req, res) => res.json({ reports: await S.visible(req.user), team: C.teamKeyOf(req.user) })));
router.post('/reports', writer, wrap(async (req, res) => send(res, await S.save(req.user, req.body || {}))));
router.delete('/reports/:id', writer, wrap(async (req, res) => send(res, await S.remove(req.user, req.params.id))));
router.get('/reports/:id/run', wrap(async (req, res) => {
  const r = await S.get(req.user, req.params.id);
  if (!r) return res.status(404).json({ error: 'That report is not yours or shared with you.' });
  const { spec } = B.clean(r.spec);
  if (req.query.format) { req.body = { format: req.query.format }; return exportRun(req, res, spec, r.name); }
  return res.json({ report: r, result: await B.run(req.user, spec) });
}));
router.get('/pins', wrap(async (req, res) => res.json({ pins: await S.pins(req.user) })));
router.post('/pins', writer, wrap(async (req, res) => send(res, await S.pin(req.user, req.body || {}))));
router.delete('/pins/:id', writer, wrap(async (req, res) => send(res, await S.unpin(req.user, req.params.id))));

// --- alerts ----------------------------------------------------------------------------------------
router.get('/alerts', wrap(async (req, res) => res.json({ alerts: await A.list(req.user.id), on: (await C.switches()).alerts, metrics: Object.entries(A.METRICS).map(([id, m]) => ({ id, ...m })) })));
router.post('/alerts', writer, wrap(async (req, res) => { const r = await A.create(req.user, req.body || {}); return r.error ? res.status(400).json(r) : res.status(201).json(r); }));
router.patch('/alerts/:id', writer, wrap(async (req, res) => send(res, await A.update(req.user, req.params.id, req.body || {}))));
router.delete('/alerts/:id', writer, wrap(async (req, res) => send(res, await A.remove(req.user, req.params.id))));
router.post('/alerts/check', wrap(async (req, res) => res.json({ values: await A.checkUser(req.user, { notify: false }) })));

// --- schedules ----------------------------------------------------------------------------------------
router.get('/schedules', wrap(async (req, res) => res.json({ schedules: await SCH.list(req.user), on: (await C.switches()).schedules })));
router.get('/schedules/recipients', wrap(async (req, res) => res.json({ people: (await SCH.mayRecipients(req.user)).map((u) => ({ id: u.id, name: u.name })) })));
router.post('/schedules', writer, wrap(async (req, res) => { const r = await SCH.create(req.user, req.body || {}); return r.error ? res.status(r.status || 400).json({ error: r.error }) : res.status(201).json(r); }));
router.patch('/schedules/:id', writer, wrap(async (req, res) => send(res, await SCH.update(req.user, req.params.id, req.body || {}))));
router.delete('/schedules/:id', writer, wrap(async (req, res) => send(res, await SCH.remove(req.user, req.params.id))));

// --- backdoor ----------------------------------------------------------------------------------------
router.get('/backdoor', wrap(async (req, res) => {
  const out = await BD.report(req.user, { status: ['suspected', 'confirmed', 'dismissed'].includes(req.query.status) ? req.query.status : '' });
  if (await maybeBook(req, res, 'backdoor-hires', 'Backdoor hiring report', [{ name: 'Backdoor', headers: ['Candidate', 'Client', 'Requirement', 'Sent on', 'Outcome', 'Why', 'Status', 'Note', ...(req.acc.money ? ['Fee at risk'] : [])], rows: out.rows.map((r) => [r.candidate, r.client, r.requirement, r.sentOn, r.outcome, r.signals.join('; '), r.statusLabel, r.note || '', ...(req.acc.money ? [r.feeAtRisk || ''] : [])]) }])) return;
  res.json(out);
}));
router.post('/backdoor/mark', writer, wrap(async (req, res) => send(res, await BD.mark(req.user, req.body || {}))));
router.post('/backdoor/client-list', writer, wrap(async (req, res) => send(res, await BD.clientList(req.user, req.body || {}))));

// --- quality of hire ----------------------------------------------------------------------------------------
router.get('/qoh', wrap(async (req, res) => {
  const out = await Q.report(req.user);
  if (await maybeBook(req, res, 'quality-of-hire', 'Quality-of-hire surveys', [
    { name: 'Answers', headers: ['Candidate', 'Requirement', 'Client', 'Recruiter', 'Day', 'Answered on', 'Rating', 'Skills', 'Attendance', 'Would rehire', 'Comment'], rows: out.rows.map((r) => [r.candidate, r.requirement, r.client, r.recruiter, r.day, (r.answeredAt || '').slice(0, 10), r.rating, r.skills, r.attendance, r.rehire, r.comment]) },
    { name: 'By client', headers: ['Client', 'Answers', 'Average rating', 'Would rehire %'], rows: out.byClient.map((r) => [r.name, r.answers, r.rating, r.rehire]) },
    { name: 'By recruiter', headers: ['Recruiter', 'Answers', 'Average rating', 'Would rehire %'], rows: out.byRecruiter.map((r) => [r.name, r.answers, r.rating, r.rehire]) },
  ])) return;
  res.json(out);
}));
router.post('/qoh/link', writer, wrap(async (req, res) => send(res, await Q.createLink(req, req.body || {}))));

// --- compliance (Admin / HR) ----------------------------------------------------------------------------------------
router.get('/compliance', wrap(async (req, res) => {
  const rolesOf = [req.user.role, req.user.atsRole, req.user.hrmsRole].filter(Boolean);
  if (!req.acc.admin && !rolesOf.includes('HR')) return res.status(403).json({ error: 'The compliance pack is for Admins and HR.' });
  const p = await CP.pack({ days: Number(req.query.days) || 30 });
  if (await maybeBook(req, res, 'compliance-dpdp', 'Compliance pack (DPDP)', CP.sheets(p))) return;
  res.json(p);
}));

// --- BI keys (Admin) ----------------------------------------------------------------------------------------
router.get('/bi/keys', adminOnly, wrap(async (req, res) => res.json({ keys: await BI.list(), feeds: BI.FEEDS, limit: BI.LIMIT })));
router.post('/bi/keys', adminOnly, writer, wrap(async (req, res) => { const r = await BI.create(req.user, req.body || {}); return r.error ? res.status(r.status || 400).json({ error: r.error }) : res.status(201).json(r); }));
router.delete('/bi/keys/:id', adminOnly, writer, wrap(async (req, res) => send(res, await BI.revoke(req.user, req.params.id))));

// --- Admin switches + run now ----------------------------------------------------------------------------------------
router.get('/switches', adminOnly, wrap(async (req, res) => res.json({ switches: await C.switches(), labels: C.SWITCHES })));
router.put('/switches', adminOnly, writer, wrap(async (req, res) => res.json({ switches: await C.setSwitches(req.user, req.body || {}) })));
router.post('/run/:job', adminOnly, writer, wrap(async (req, res) => {
  const job = { alerts: A.sweep, schedules: SCH.sweep, qoh: Q.sweep }[req.params.job];
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  return res.json(await job());
}));

router.startSweeps = () => { A.startSweep(); SCH.startSweep(); Q.startSweep(); };
module.exports = router;
