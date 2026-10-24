// ---------------------------------------------------------------------------
// /api/ats - GOOGLE MEET LINK, INTERVIEW E-MAILS, START INTERVIEW (2026-10-14). See utils/interviewMeet.js.
//
//   GET  /interview-meet/settings               switches + default link (the default link only for people who book)
//   PUT  /interview-meet/settings               Super Admin / Admin
//   GET  /interviews/:id/mail                   who was e-mailed and what happened
//   POST /interviews/:id/mail/resend            { key? }  booking team: send again to one person / everyone not reached
//   PUT  /interviews/:id/meet-link              { meetingLink }  whoever may start the interview: paste / change the link
//   POST /interviews/:id/start                  Start interview (window rules, status Started, audit)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct } = require('../middleware/auth');
const { applicationWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const IM = require('../utils/interviewMeet');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const DENIED = { error: "This action isn't included in your role's permissions" };
const FULL = { candidate: true, requirement: { include: { client: true } } };

async function panelIds(app) {
  const rows = await prisma.interviewPanelist.findMany({ where: { applicationId: app.id, round: app.interviewRound || 1, userId: { not: null } }, select: { userId: true } }).catch(() => []);
  return rows.map((r) => r.userId);
}
// The interview, if this login may work with it: inside its area, OR named on the panel.
async function load(req, res) {
  const app = await prisma.application.findUnique({ where: { id: req.params.id }, include: FULL });
  if (!app || !app.interviewStatus) { res.status(404).json({ error: 'No interview on this application.' }); return null; }
  const inScope = await prisma.application.findFirst({ where: { id: app.id, ...applicationWhere(req.user) }, select: { id: true } });
  const ids = await panelIds(app);
  if (!inScope && !IM.isNamedInterviewer(req.user, app, ids)) { res.status(403).json({ error: 'This record is outside your access scope' }); return null; }
  return { app, ids };
}
const eventOf = (app, rec) => (rec && rec.event) || (app.interviewStatus === 'CANCELLED' ? 'cancelled' : (app.interviewStatus === 'RESCHEDULED' ? 'rescheduled' : 'scheduled'));

router.get('/interview-meet/settings', async (req, res, next) => {
  try {
    const ctx = await IM.startCtx(req.user);
    const s = await IM.loadSettings();
    const mayBook = ctx.admin || ctx.bdeTeam;
    const { emailConfig } = require('../utils/mailer'); // eslint-disable-line global-require
    const mail = await emailConfig().catch(() => ({ configured: false, reason: 'Mail is not set up.' }));
    const ML = require('../utils/meetingLinks'); // eslint-disable-line global-require
    const cal = await ML.setupReport().catch(() => null);
    res.json({
      canEdit: ctx.admin,
      settings: { ...s, defaultMeetLink: mayBook ? s.defaultMeetLink : '' },
      mailReady: !!mail.configured,
      mailProblem: mail.configured ? null : 'Mail is not set up. Ask your Admin: Administration > Integrations > Email.',
      calendarReady: !!(cal && (cal.configured || cal.ready)),
      sandbox: require('../utils/sandbox').isSandbox(), // eslint-disable-line global-require
    });
  } catch (err) { next(err); }
});

router.put('/interview-meet/settings', async (req, res, next) => {
  try {
    if (!IM.isAdminUser(req.user)) return res.status(403).json({ error: 'Only an Admin can change these settings.' });
    const out = await IM.saveSettings(req.body || {}, req.user);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Interview Meet and email settings changed', entity: 'AppSetting', entityId: IM.KEY, fromValue: JSON.stringify(out.before).slice(0, 900), toValue: JSON.stringify(out.settings).slice(0, 900) });
    return res.json({ settings: out.settings, message: 'Saved.' });
  } catch (err) { return next(err); }
});

router.get('/interviews/:id/mail', async (req, res, next) => {
  try {
    const got = await load(req, res);
    if (!got) return undefined;
    const ctx = await IM.startCtx(req.user);
    const status = await IM.mailStatus(got.app.id);
    return res.json({ ...status, canResend: ctx.admin || ctx.bdeTeam });
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/mail/resend', async (req, res, next) => {
  try {
    const got = await load(req, res);
    if (!got) return undefined;
    const ctx = await IM.startCtx(req.user);
    if (!(ctx.admin || ctx.bdeTeam)) return res.status(403).json(DENIED);
    if (!got.app.interviewAt) return res.status(400).json({ error: 'Book the interview first.' });
    const rec = await IM.readRecord(got.app.id);
    const key = req.body && req.body.key ? String(req.body.key) : null;
    // one person, or everybody who has not been reached
    const only = key ? [key] : rec.rows.filter((x) => x.status !== 'sent').map((x) => x.key);
    if (!key && !only.length && rec.rows.length) return res.json({ ok: true, message: 'Everyone has already received the email.', rows: rec.rows });
    const out = await IM.sendInvites(got.app.id, eventOf(got.app, rec), { actor: req.user, resend: true, only: only.length ? only : undefined, reason: null });
    return res.json({ ok: out.ok, message: out.message, notConfigured: out.notConfigured, rows: (await IM.mailStatus(got.app.id)).rows });
  } catch (err) { return next(err); }
});

router.put('/interviews/:id/meet-link', async (req, res, next) => {
  try {
    const got = await load(req, res);
    if (!got) return undefined;
    const ctx = await IM.startCtx(req.user);
    if (!IM.mayStart(ctx, req.user, got.app, got.ids)) return res.status(403).json(DENIED);
    if (!IM.STARTABLE.includes(got.app.interviewStatus)) return res.status(409).json({ error: 'This interview is over or cancelled, so the link cannot be changed.' });
    if (!IM.isOnline(got.app)) return res.status(409).json({ error: 'This interview is in person, so it needs no meeting link.' });
    const chk = IM.checkLink(req.body && req.body.meetingLink);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    const changed = got.app.interviewMeetingLink !== chk.url;
    if (changed) {
      await prisma.application.update({ where: { id: got.app.id }, data: { interviewMeetingLink: chk.url } });
      await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Interview Meet link set', entity: 'Application', entityId: got.app.id, fromValue: got.app.interviewMeetingLink ? 'a link' : '-', toValue: chk.kind === 'meet' ? 'Google Meet link' : 'other video link' });
    }
    // the people already e-mailed get the updated invite (same calendar entry)
    let mail = null;
    if (changed && (await IM.readRecord(got.app.id)).rows.length) mail = await IM.sendInvites(got.app.id, 'updated', { actor: req.user });
    return res.json({ ok: true, meetingLink: chk.url, kind: chk.kind, warning: chk.warning || null, mail: mail ? { message: mail.message, notConfigured: mail.notConfigured } : null, message: `Meet link saved.${mail && mail.message ? ` ${mail.message}` : ''}` });
  } catch (err) { return next(err); }
});

router.post('/interviews/:id/start', async (req, res, next) => {
  try {
    const got = await load(req, res);
    if (!got) return undefined;
    const { app } = got;
    const ctx = await IM.startCtx(req.user);
    if (!IM.mayStart(ctx, req.user, app, got.ids)) return res.status(403).json({ error: 'Only the interviewer, the client manager (BDE) team, the requirement\'s team lead or an Admin can start this interview.' });
    const st = IM.startState(ctx, req.user, app, got.ids);
    if (!st.show) return res.status(409).json({ error: `This interview is ${String(app.interviewStatus || '').toLowerCase().replace(/_/g, ' ')}, so it cannot be started.` });
    if (!st.can) return res.status(409).json({ error: st.reason, opensInMin: st.opensInMin });
    if (st.needsLink) return res.status(409).json({ error: 'Add the Meet link first.', needsLink: true });
    const online = IM.isOnline(app);
    const address = online ? null : (app.interviewLocation || null);
    let startedAt = app.interviewStartedAt;
    if (app.interviewStatus !== 'STARTED') {
      startedAt = new Date();
      await prisma.application.update({ where: { id: app.id }, data: { interviewStatus: 'STARTED', interviewStartedAt: startedAt } });
      const when = startedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
      await prisma.interviewEvent.create({ data: { applicationId: app.id, status: 'STARTED', by: req.user.name, reason: `Interview started by ${req.user.name} at ${when} IST` } });
      await logAudit({ userId: req.user.id, actorName: req.user.name, action: `Interview started by ${req.user.name}`, entity: 'Application', entityId: app.id, fromValue: app.interviewStatus, toValue: 'Started' });
    }
    return res.json({
      ok: true, status: 'STARTED', startedAt, online, meetingLink: online ? app.interviewMeetingLink : null, address,
      message: online ? 'Interview started. Meet is opening in a new tab.' : `Interview started${address ? `. Address: ${address}` : '.'}`,
    });
  } catch (err) { return next(err); }
});

module.exports = router;
