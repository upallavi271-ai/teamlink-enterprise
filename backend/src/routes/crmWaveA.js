// ---------------------------------------------------------------------------
// CRM WAVE A ROUTES (2026-11-24), mounted INSIDE /api/crm at /a (every path below is /api/crm/a/...) (routes/crm.js: after the CRM access check, so only the CRM team reaches them).
// The screens are tabs of CRM > Dashboard (Automation, Report builder, My dashboard, Leaderboard, Trends) - no new sidebar item.
//
//   GET/PUT  /crm/wave/switches                     the Admin switches (everything that reaches outside or works by itself starts OFF)
//   GET      /crm/wave/apps                         the apps catalogue
//   GET      /crm/automation/meta|rules|runs        POST /crm/automation/rules   PUT/DELETE /crm/automation/rules/:id   POST .../:id/try {recordId}
//   POST     /crm/automation/tick                   run the due delays and date rules now
//   GET      /crm/automation/approvals[?status=all] POST /crm/automation/approvals/:id {decision: approve|reject, note}
//   GET/POST /crm/wave/webhooks   PUT/DELETE /crm/wave/webhooks/:id   POST /crm/wave/webhooks/:id/test
//   GET      /crm/wave/chat       POST /crm/wave/chat/test {tool: slack|teams}
//   GET/POST /crm/wave/api-keys   DELETE /crm/wave/api-keys/:id
//   GET      /crm/wave/mcp        POST /crm/wave/mcp/tokens {label}   DELETE /crm/wave/mcp/tokens/:id
//   GET      /crm/wave/calendar-feed   GET /crm/wave/contacts.vcf
//   GET      /crm/builder/meta    POST /crm/builder/preview   GET/POST /crm/builder/reports   PUT/DELETE /crm/builder/reports/:id
//   GET      /crm/builder/reports/:id/run   GET /crm/builder/reports/:id/xlsx
//   GET/POST /crm/builder/schedules   PUT/DELETE /crm/builder/schedules/:id   POST /crm/builder/schedules/:id/send-now
//   GET/PUT  /crm/my-dashboard
//   GET      /crm/leaderboard?period=   GET /crm/trends?weeks=&owner=   GET /crm/cohorts?months=&owner=   POST /crm/trends/snapshot
// ---------------------------------------------------------------------------
const express = require('express');
const AUTO = require('../crm/automationA');
const C = require('../crm/connectA');
const RB = require('../crm/reportBuilder');
const IN = require('../crm/insightsA');
const S = require('../crm/service');

const router = express.Router();
const send = (res, out) => res.status(out.status).json(out.body);
const wrap = (fn) => async (req, res, next) => { try { return send(res, await fn(req)); } catch (e) { return next(e); } };

router.get('/wave/switches', wrap((req) => C.getSwitches(req.user)));
router.put('/wave/switches', wrap((req) => C.setSwitches(req.user, req.body || {})));
router.get('/wave/apps', wrap((req) => C.apps(req.user)));

router.get('/automation/meta', wrap((req) => AUTO.meta(req.user)));
router.get('/automation/rules', wrap((req) => AUTO.listRules(req.user)));
router.post('/automation/rules', wrap((req) => AUTO.saveRule(req.user, null, req.body || {})));
router.put('/automation/rules/:id', wrap((req) => AUTO.saveRule(req.user, req.params.id, req.body || {})));
router.delete('/automation/rules/:id', wrap((req) => AUTO.removeRule(req.user, req.params.id)));
router.post('/automation/rules/:id/try', wrap((req) => AUTO.dryRun(req.user, req.params.id, req.body || {})));
router.get('/automation/runs', wrap((req) => AUTO.runs(req.user, { ruleId: req.query.ruleId, limit: req.query.limit })));
router.post('/automation/tick', wrap(async (req) => {
  const out = await AUTO.tickNow(req.user);
  if (out.status !== 200) return out;
  const mailed = await RB.runSchedules().catch(() => 0); // scheduled reports whose time came (only while their switch is on)
  return S.okBody({ ...out.body, mailed });
}));
router.get('/automation/approvals', wrap((req) => AUTO.approvals(req.user, { status: String(req.query.status || '') })));
router.post('/automation/approvals/:id', wrap((req) => AUTO.decide(req.user, req.params.id, req.body || {})));

router.get('/wave/webhooks', wrap((req) => C.listHooks(req.user)));
router.post('/wave/webhooks', wrap((req) => C.addHook(req.user, req.body || {}, { source: String((req.body || {}).source || 'manual') })));
router.put('/wave/webhooks/:id', wrap((req) => C.editHook(req.user, req.params.id, req.body || {})));
router.delete('/wave/webhooks/:id', wrap((req) => C.removeHook(req.user, req.params.id)));
router.post('/wave/webhooks/:id/test', wrap((req) => C.testHook(req.user, req.params.id)));
router.get('/wave/chat', wrap((req) => C.chatStatus(req.user)));
router.post('/wave/chat/test', wrap((req) => C.chatTest(req.user, String((req.body || {}).tool || ''))));
router.get('/wave/api-keys', wrap((req) => C.listKeys(req.user)));
router.post('/wave/api-keys', wrap((req) => C.createKey(req.user, req.body || {})));
router.delete('/wave/api-keys/:id', wrap((req) => C.revokeKey(req.user, req.params.id)));

// the MCP server's own token, made here so a CRM person needs no ATS screen (utils/mktb/mcp.js)
router.get('/wave/mcp', wrap(async (req) => {
  const MK = require('../utils/mktb/store'); // eslint-disable-line global-require
  const MCP = require('../utils/mktb/mcp'); // eslint-disable-line global-require
  const T = require('../crm/mcpTools'); // eslint-disable-line global-require
  return { status: 200, body: { serverOn: !!(await MK.setting('mcp.on')), tools: (await T.toolsFor(req.user)).map((t) => ({ name: t.name, description: t.description })), tokens: await MCP.tokens(req.user), endpoint: '/api/mcp' } };
}));
router.post('/wave/mcp/tokens', wrap(async (req) => {
  const MK = require('../utils/mktb/store'); // eslint-disable-line global-require
  const MCP = require('../utils/mktb/mcp'); // eslint-disable-line global-require
  if (!(await MK.setting('mcp.on'))) return S.fail(409, 'The MCP server is switched off. An Admin turns it on in Administration > AI governance.');
  const out = await MCP.createToken(req.user, (req.body || {}).label || 'CRM AI tool');
  await S.audit(req.user, 'MCP token made (CRM)', 'MktMcpToken', out.id, (req.body || {}).label || 'CRM AI tool');
  return { status: 201, body: out };
}));
router.delete('/wave/mcp/tokens/:id', wrap(async (req) => {
  const MCP = require('../utils/mktb/mcp'); // eslint-disable-line global-require
  const out = await MCP.revoke(req.params.id, req.user);
  return out.error ? S.fail(out.status || 400, out.error) : S.okBody({ ok: true });
}));
router.get('/wave/calendar-feed', wrap((req) => C.myFeed(req.user)));
router.get('/wave/contacts.vcf', async (req, res, next) => {
  try {
    const out = await C.contactsVcf(req.user);
    if (!out.text) return send(res, out);
    res.set('Content-Type', 'text/vcard; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${out.name}"`);
    return res.send(out.text);
  } catch (e) { return next(e); }
});

router.get('/builder/meta', wrap((req) => RB.meta(req.user)));
router.post('/builder/preview', wrap((req) => RB.preview(req.user, req.body || {})));
router.get('/builder/reports', wrap((req) => RB.list(req.user)));
router.post('/builder/reports', wrap((req) => RB.save(req.user, null, req.body || {})));
router.put('/builder/reports/:id', wrap((req) => RB.save(req.user, req.params.id, req.body || {})));
router.delete('/builder/reports/:id', wrap((req) => RB.remove(req.user, req.params.id)));
router.get('/builder/reports/:id/run', wrap((req) => RB.runSaved(req.user, req.params.id)));
router.get('/builder/reports/:id/xlsx', async (req, res, next) => {
  try {
    const out = await RB.exportSaved(req.user, req.params.id);
    if (!out.buffer) return send(res, out);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${out.name}"`);
    return res.send(out.buffer);
  } catch (e) { return next(e); }
});
router.get('/builder/schedules', wrap((req) => RB.schedules(req.user)));
router.post('/builder/schedules', wrap((req) => RB.saveSchedule(req.user, null, req.body || {})));
router.put('/builder/schedules/:id', wrap((req) => RB.saveSchedule(req.user, req.params.id, req.body || {})));
router.delete('/builder/schedules/:id', wrap((req) => RB.removeSchedule(req.user, req.params.id)));
router.post('/builder/schedules/:id/send-now', wrap((req) => RB.sendNow(req.user, req.params.id)));
router.get('/my-dashboard', wrap((req) => RB.myDashboard(req.user)));
router.put('/my-dashboard', wrap((req) => RB.saveDashboard(req.user, req.body || {})));

router.get('/leaderboard', wrap((req) => IN.leaderboard(req.user, { period: String(req.query.period || '') })));
router.get('/trends', wrap((req) => IN.trends(req.user, { weeks: req.query.weeks, owner: req.query.owner })));
router.get('/cohorts', wrap((req) => IN.cohorts(req.user, { months: req.query.months, owner: req.query.owner })));
router.post('/trends/snapshot', wrap(async (req) => (['admin', 'tl'].includes(S.roleOf(req.user)) ? S.okBody(await IN.takeSnapshot()) : S.fail(403, 'Only a Sales manager or an Admin.'))));

// the clock (never in a test server): delays and date rules every minute, scheduled reports every 5 minutes, the pipeline snapshot once a day
if (!process.env.TEST_MODE && process.env.NODE_ENV !== 'test') {
  setInterval(() => { AUTO.tick().catch((e) => console.error('[crm] rules tick:', e.message)); }, 60 * 1000).unref(); // eslint-disable-line no-console
  setInterval(() => { RB.runSchedules().catch((e) => console.error('[crm] scheduled reports:', e.message)); }, 5 * 60 * 1000).unref(); // eslint-disable-line no-console
  setInterval(() => { IN.takeSnapshot().catch((e) => console.error('[crm] pipeline snapshot:', e.message)); }, 60 * 60 * 1000).unref(); // eslint-disable-line no-console
}

module.exports = router;
