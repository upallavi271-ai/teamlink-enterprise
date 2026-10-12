// ---------------------------------------------------------------------------
// /api/pending-work — pending work → the TL (utils/pendingWork.js), the BDE's client work
// (utils/clientWork.js) and the end-of-day report (utils/eodReport.js).
//
//   GET  /settings                    the reminder settings (leads read; Super Admin / Admin / HR change)
//   PUT  /settings
//   GET  /team?department=&recruiter=&type=&lateness=   Team → Pending work (the caller's own screen)
//   POST /remind                      { recruiterId, applicationId?, note? }  once per person per item per day
//   GET  /digest/preview?tl=          today's digest, written, not sent
//   POST /digest/run                  { dryRun, force, only }   (settings managers)
//   POST /escalation/run              { dryRun, force }
//   GET  /bde/preview                 the caller's client-work digest (a BDE: own; BDE TL: the desk)
//   POST /bde/run                     { dryRun, force }
//   GET  /eod?tl=&day=                one end-of-day report (+ the days kept and the TLs the caller may read)
//   GET  /eod/xlsx?tl=&day=           the Excel file of that report
//   POST /eod/send                    { tl, day, toMe }  send now / send again
//   POST /eod/run                     { dryRun, force, only }  (settings managers)
//
// SCOPE IS THE SERVER'S. A TL reads / sends only their own team; an STL their departments'
// team leads; a Manager reads all (no sending); Super Admin / Admin everything; a recruiter or
// BDE none of it (their own pending work is the dashboard's "My tasks").
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { atsScopeOf, atsViewRole, isBdeTl } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const PW = require('../utils/pendingWork');
const CW = require('../utils/clientWork');
const EOD = require('../utils/eodReport');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
router.use(require('../utils/permissions').requireInternal);

const guarded = (fn) => async (req, res, next) => { try { return await fn(req, res); } catch (err) { return next(err); } };
const LEAD_VIEWS = ['admin', 'mgmt', 'stl', 'tl'];
const isLead = (user) => LEAD_VIEWS.includes(atsViewRole(user));
// Super Admin / Admin / HR manage the reminder settings and run the sweeps by hand.
function mayManage(user, req) {
  if (req && req.viewAs) return false;
  const s = atsScopeOf(user);
  return s.adminGlobal === true || s.atsRole === 'HR' || s.hrmsRole === 'HR';
}
const noViewAs = (req, res) => (req.viewAs ? (res.status(403).json({ error: 'You are looking at this as someone else. Switch back to send or change anything.' }), true) : false);

// Which team leads (and the BDE TL) this caller may read / send for.
async function visibleTls(user) {
  const view = atsViewRole(user);
  const all = await PW.recipients();
  const bde = (await CW.bdePeople()).filter((p) => p.isTl).map((p) => ({ id: p.user.id, name: p.user.name, department: 'BDE', recruiters: 0, bde: true }));
  const everyone = [...all, ...bde];
  if (['admin', 'mgmt'].includes(view)) return everyone;
  if (view === 'tl') return everyone.filter((t) => t.id === user.id);
  if (view === 'stl') {
    const TW = require('../utils/teamWorkload'); // eslint-disable-line global-require
    const world = await TW.teamWorld(user);
    const mine = new Set(world.people.filter((p) => p.role === 'TL').map((p) => p.id));
    return everyone.filter((t) => mine.has(t.id));
  }
  return [];
}

router.get('/settings', guarded(async (req, res) => {
  if (!isLead(req.user) && !mayManage(req.user, req)) return res.status(403).json({ error: 'Only team leads, managers, HR and admins see these settings.' });
  const settings = await PW.getSettings({ fresh: true });
  const MS = require('../utils/messaging'); // eslint-disable-line global-require
  const channels = await MS.channelStatus().catch(() => ({}));
  const tls = mayManage(req.user, req) ? [...await PW.recipients(), ...(await CW.bdePeople()).filter((p) => p.isTl).map((p) => ({ id: p.user.id, name: p.user.name, department: 'BDE', bde: true }))] : [];
  return res.json({
    settings,
    defaults: PW.DEFAULTS,
    canEdit: mayManage(req.user, req),
    channels: { Email: !!(channels.Email && channels.Email.configured), WhatsApp: !!(channels.WhatsApp && channels.WhatsApp.configured), SMS: !!(channels.SMS && channels.SMS.configured) },
    teamLeads: tls,
    types: PW.TYPES.map((t) => ({ id: t.id, label: t.label })),
    words: {
      late: 'Late = the due day has passed.',
      due_today: 'Due today = the due day is today.',
      waiting: 'Waiting = the next steps of the person\'s candidates, not counting "Not moving" ones. Late and Due today are part of it.',
    },
  });
}));

router.put('/settings', guarded(async (req, res) => {
  if (!mayManage(req.user, req)) return res.status(403).json({ error: 'Only a Super Admin, Admin or HR can change these settings.' });
  const out = await PW.saveSettings(req.body || {}, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  const brief = (s) => JSON.stringify({ enabled: s.enabled, bell: s.bell, email: s.email, digestTime: s.digestTime, copyStl: s.copyStl, copyManager: s.copyManager, escalation: s.escalation, bde: s.bde, nudge: s.nudge, chain: s.chain, eod: s.eod });
  if (brief(out.before) !== brief(out.settings)) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Changed pending-work reminders', entity: 'Settings', entityId: PW.SETTINGS_KEY, fromValue: brief(out.before).slice(0, 900), toValue: brief(out.settings).slice(0, 900) }).catch(() => null);
  }
  return res.json({ settings: out.settings });
}));

router.get('/team', guarded(async (req, res) => {
  const out = await PW.teamView(req.user, req.query || {});
  return res.status(out.status).json(out.body);
}));

router.post('/remind', guarded(async (req, res) => {
  if (noViewAs(req, res)) return undefined;
  const b = req.body || {};
  const out = await PW.remind(req.user, { recruiterId: b.recruiterId, applicationId: b.applicationId || null, note: b.note || null });
  return res.status(out.status).json(out.body);
}));

router.get('/digest/preview', guarded(async (req, res) => {
  const view = atsViewRole(req.user);
  if (!LEAD_VIEWS.includes(view)) return res.status(403).json({ error: 'Only team leads, managers and admins see the digest.' });
  const tls = await visibleTls(req.user);
  const tlId = String(req.query.tl || (view === 'tl' ? req.user.id : (tls[0] && tls[0].id) || ''));
  if (!tls.some((t) => t.id === tlId)) return res.status(403).json({ error: 'That team is not in your area.' });
  const bde = tls.find((t) => t.id === tlId).bde;
  if (bde) {
    const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
    const p = await CW.bdePending(await resolveIdentity(tlId));
    return res.json({ bde: true, totals: { total: p.total }, counts: p.counts, note: 'The BDE TL gets one combined copy of every BDE digest.' });
  }
  const out = await PW.previewFor(tlId);
  if (out.error) return res.status(400).json({ error: out.error });
  return res.json({ ...out, teamLeads: tls });
}));

router.post('/digest/run', guarded(async (req, res) => {
  if (!mayManage(req.user, req)) return res.status(403).json({ error: 'Only a Super Admin, Admin or HR can run this.' });
  const b = req.body || {};
  const out = await PW.runDigest({ dryRun: !!b.dryRun, force: !!b.force, only: b.only || null });
  if (!b.dryRun) await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Pending-work digest run by hand', entity: 'Settings', entityId: PW.SETTINGS_KEY, toValue: `sent ${out.sent}, copies ${out.copies}` }).catch(() => null);
  return res.json(out);
}));

router.post('/escalation/run', guarded(async (req, res) => {
  if (!mayManage(req.user, req)) return res.status(403).json({ error: 'Only a Super Admin, Admin or HR can run this.' });
  const b = req.body || {};
  return res.json(await PW.runEscalation({ dryRun: !!b.dryRun, force: !!b.force }));
}));

router.get('/bde/preview', guarded(async (req, res) => {
  const view = atsViewRole(req.user);
  const s = atsScopeOf(req.user);
  if (!(s.atsRole === 'BDE' || isBdeTl(req.user) || s.adminGlobal)) return res.status(403).json({ error: 'The client-work digest is for the client managers (BDE).' });
  const p = await CW.bdePending(req.user);
  void view;
  return res.json({ ...p, types: CW.BDE_TYPES, content: CW.bdeDigestContent({ to: req.user, pending: p, day: PW.dayOfIst(new Date()) }) });
}));

router.post('/bde/run', guarded(async (req, res) => {
  if (!mayManage(req.user, req)) return res.status(403).json({ error: 'Only a Super Admin, Admin or HR can run this.' });
  const b = req.body || {};
  return res.json(await CW.runBdeDigest({ dryRun: !!b.dryRun, force: !!b.force }));
}));

// ---- pending approvals / overdue follow-ups -> everyone above -------------------------------------
// What waits on the caller and on the people under them (the dashboard's "Pending on my team").
router.get('/chain', guarded(async (req, res) => {
  const CA = require('../utils/chainAlerts'); // eslint-disable-line global-require
  const out = await CA.chainView(req.user, { fresh: req.query.fresh === '1' });
  return res.json(out);
}));
router.post('/chain/run', guarded(async (req, res) => {
  if (!mayManage(req.user, req)) return res.status(403).json({ error: 'Only a Super Admin, Admin or HR can run this.' });
  const b = req.body || {};
  return res.json(await require('../utils/chainAlerts').run({ dryRun: !!b.dryRun, force: !!b.force })); // eslint-disable-line global-require
}));

// ---- end of day --------------------------------------------------------------
router.get('/eod', guarded(async (req, res) => {
  const view = atsViewRole(req.user);
  if (!LEAD_VIEWS.includes(view)) return res.status(403).json({ error: 'The end-of-day report is for team leads, managers and admins.' });
  const tls = await visibleTls(req.user);
  if (!tls.length) return res.json({ teamLeads: [], tl: null, days: [], report: null, canSend: false });
  const tlId = String(req.query.tl || (view === 'tl' ? req.user.id : tls[0].id));
  if (!tls.some((t) => t.id === tlId)) return res.status(403).json({ error: 'That team is not in your area.' });
  const today = PW.dayOfIst(new Date());
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? req.query.day : today;
  const days = await EOD.listDays(tlId);
  let report = null;
  let note = null;
  if (day > today) note = 'That day has not happened yet.';
  else {
    const snap = await EOD.readSnapshot(tlId, day);
    if (snap) report = snap;
    else if (req.query.build === '1' || day === today) {
      report = await EOD.loadOrBuild({ tlId, day, fresh: true });
      if (report.error) { note = report.error; report = null; } else if (day !== today) note = 'This day was not reported at the time. It is rebuilt from the records; the pending numbers are not known for a past day.';
    } else note = 'No report was made for this day. Press "Build this day" to make one from the records.';
  }
  return res.json({
    teamLeads: tls.map((t) => ({ id: t.id, name: t.name, department: t.department, bde: !!t.bde })),
    tl: tlId, day, today, days, report, note,
    canSend: ['admin', 'tl'].includes(view) || (view === 'stl'),
    canManage: mayManage(req.user, req),
  });
}));

router.get('/eod/xlsx', guarded(async (req, res) => {
  const view = atsViewRole(req.user);
  if (!LEAD_VIEWS.includes(view)) return res.status(403).json({ error: 'The end-of-day report is for team leads, managers and admins.' });
  const tls = await visibleTls(req.user);
  const tlId = String(req.query.tl || (view === 'tl' ? req.user.id : (tls[0] && tls[0].id) || ''));
  if (!tls.some((t) => t.id === tlId)) return res.status(403).json({ error: 'That team is not in your area.' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? req.query.day : PW.dayOfIst(new Date());
  const report = (await EOD.readSnapshot(tlId, day)) || await EOD.loadOrBuild({ tlId, day, fresh: day === PW.dayOfIst(new Date()) });
  if (report.error) return res.status(400).json({ error: report.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'End-of-day report downloaded', entity: 'Report', entityId: tlId, toValue: day }).catch(() => null);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="end-of-day-${day}-${String(report.tl.name).replace(/[^A-Za-z0-9]+/g, '-')}.xlsx"`);
  return res.send(EOD.toXlsx(report));
}));

router.post('/eod/send', guarded(async (req, res) => {
  if (noViewAs(req, res)) return undefined;
  const view = atsViewRole(req.user);
  if (!['admin', 'tl', 'stl'].includes(view)) return res.status(403).json({ error: 'Only a team lead, STL or admin sends the report. Managers look at it.' });
  const b = req.body || {};
  const tls = await visibleTls(req.user);
  const tlId = String(b.tl || (view === 'tl' ? req.user.id : ''));
  if (!tlId || !tls.some((t) => t.id === tlId)) return res.status(403).json({ error: 'That team is not in your area.' });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || '')) ? b.day : null;
  const out = await EOD.sendNow({ tlId, day, toSelfOnly: !!b.toMe && tlId !== req.user.id, requester: { id: req.user.id, name: req.user.name, email: req.user.email } });
  if (out.status === 200) await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'End-of-day report sent now', entity: 'Report', entityId: tlId, toValue: `${out.body.day} to ${out.body.sentTo}` }).catch(() => null);
  return res.status(out.status).json(out.body);
}));

router.post('/eod/run', guarded(async (req, res) => {
  if (!mayManage(req.user, req)) return res.status(403).json({ error: 'Only a Super Admin, Admin or HR can run this.' });
  const b = req.body || {};
  return res.json(await EOD.runAll({ dryRun: !!b.dryRun, force: !!b.force, only: b.only || null }));
}));

module.exports = router;
