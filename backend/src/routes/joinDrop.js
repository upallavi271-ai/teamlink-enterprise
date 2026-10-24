// ---------------------------------------------------------------------------
// /api/join-drop  JOINING & DROP (staff side). The rules live in src/joindrop/*; this file only checks WHO and answers in plain words.
//
//   GET    /meta                                  the lists for the forms + what this login may do
//   GET    /list  /export  /report  /report/export  the Joining screen's "Joined and dropped" list, its CSV, the report, its CSV
//   GET    /application/:appId                    the candidate page panel: the record, its history, the journey, the buttons this login has
//   GET    /candidate/:candidateId                every joining record of a candidate
//   GET    /journey/:appId                        the milestone list alone
//   GET    /:id            /:id/people            one record (+ history, who was told) / who WOULD be told
//   POST   /application/:appId/record             record the joining (or fill what is missing: "Add details")
//   PATCH  /:id                                   correct the joining details (a reason when something already recorded changes)
//   POST   /:id/drop      PATCH /:id/drop         report a drop / correct it
//   POST   /:id/decision                          the client's replacement decision, entered by staff on the client's behalf
//   POST   /:id/replacement/link  /replacement/close
//   POST   /:id/replacement-task/cancel  /open    BDE / TL / Admin only
//   POST   /:id/reopen                            a drop reported by mistake
//   GET/POST /:id/candidate-notice                the manual drop notice to the candidate (preview + send)
//   GET    /open-for-job/:requirementId           dropped candidates of that job still waiting for a replacement
//   GET    /client-history/:clientId              the client's lifecycle history
//   GET/PUT /settings                             the Admin switches (Admin only)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { applicationWhere, clientWhere } = require('../utils/scope');
const Core = require('../joindrop/core');
const A = require('../joindrop/access');
const V = require('../joindrop/vocab');
const N = require('../joindrop/notify');
const SET = require('../joindrop/settings');
const R = require('../joindrop/report');
const JR = require('../joindrop/journey');
const CH = require('../joindrop/clientHistory');

const router = express.Router();
router.use(requireAuth);
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => fail(res, e));

function fail(res, e) {
  if (e && (e instanceof Core.Bad || (e.status && e.message))) return res.status(e.status || 400).json({ error: e.message });
  console.error('[join-drop]', e); // eslint-disable-line no-console
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

const FROM = { admin: 'Admin', mgmt: 'Manager', bde: 'BDE', tl: 'TL', stl: 'TL', recruiter: 'Recruiter', hr: 'HR', accounts: 'Accounts', client: 'Client login' };
const fromOf = (rt) => FROM[rt.kind] || 'Staff';

// Joined is the one place people look first: make sure a one-time backfill has run (quiet, never blocks).
let backfillStarted = false;
function kickBackfill() {
  if (backfillStarted) return;
  backfillStarted = true;
  Core.backfillOnce().catch((e) => { backfillStarted = false; console.error('[join-drop] backfill:', e.message); }); // eslint-disable-line no-console
}

async function staffOnly(req, res) {
  const rt = await A.rights(req.user);
  if (rt.kind === 'client' || rt.kind === 'none') { res.status(403).json({ error: 'This is not part of your access.' }); return null; }
  return rt;
}

// The record, if this login may open it (404 for "not there", 403 for "not yours").
async function loadRec(req, res, rt) {
  await Core.ready();
  const rec = await Core.get(req.params.id);
  if (!rec) { res.status(404).json({ error: 'That joining record was not found.' }); return null; }
  if (!(await A.canSee(req.user, rec, rt))) { res.status(403).json({ error: 'That record is outside your access.' }); return null; }
  return rec;
}

// An event as this viewer may read it: nobody without the pay right reads a pay figure in the history.
function cleanEvent(e, rt) {
  const o = { ...e };
  if (!rt.seePay) {
    ['oldValue', 'newValue'].forEach((k) => {
      if (!o[k]) return;
      try { const j = JSON.parse(o[k]); delete j.offeredCtc; o[k] = JSON.stringify(j); } catch { /* keep */ }
    });
    o.summary = String(o.summary || '').split('; ').filter((p) => !/Pay \(CTC\)/.test(p)).join('; ').replace(/: $/, '');
  }
  return o;
}

async function recordPayload(rec, rt, user, { withNotices = true } = {}) {
  const tasks = await A.taskStates([rec.replacementTaskId]);
  const history = (await Core.history(rec.id)).map((e) => cleanEvent(e, rt));
  const told = withNotices && rt.kind !== 'client' ? await Core.notices(rec.id) : [];
  const emailsOn = (await require('../utils/hrmsNotify').getSettings()).emailsOn === true; // eslint-disable-line global-require
  const dropped = rec.status === 'Dropped';
  return {
    record: A.shape(rec, rt, { tasks }),
    history,
    told,
    emailsOn,
    rights: {
      correct: rt.record,
      report: rt.report && rec.status === 'Joined' && rec.hiringType !== 'TeamLink Internal Hire',
      correctDrop: rt.record && dropped,
      decide: rt.decide && dropped,
      reopen: rt.reopen && dropped,
      cancelTask: rt.cancelTask && dropped && rec.replacementTaskState === 'Open',
      openTask: rt.openTask && dropped && rec.replacementTaskState !== 'Open',
      link: rt.link && dropped && rec.replacementDecision === 'NEEDED' && rec.replacementStatus !== V.REPL.CLOSED,
      closeReplacement: rt.link && dropped && [V.REPL.REQUESTED, V.REPL.LINKED].includes(rec.replacementStatus),
      notice: rt.notice && dropped,
    },
  };
}

// ---- meta ---------------------------------------------------------------------------------------------------------------------------
router.get('/meta', wrap(async (req, res) => {
  const rt = await A.rights(req.user);
  if (rt.kind === 'none') return res.status(403).json({ error: 'This is not part of your access.' });
  const HN = require('../utils/hrmsNotify'); // eslint-disable-line global-require
  kickBackfill();
  res.json({
    reasons: V.DROP_REASONS, otherReason: V.OTHER_REASON,
    decisions: V.DECISION_KEYS.map((k) => ({ key: k, label: V.DECISIONS[k].label })),
    replacementStatuses: Object.values(V.REPL),
    rights: {
      kind: rt.kind, record: rt.record, report: rt.report, decide: rt.decide, reopen: rt.reopen, cancelTask: rt.cancelTask, notice: rt.notice, export: rt.export, seePay: rt.seePay, admin: rt.admin,
    },
    emailsOn: (await HN.getSettings()).emailsOn === true,
    defaultGuaranteeDays: rt.settings.defaultGuaranteeDays,
  });
}));

// ---- list / export / report -------------------------------------------------------------------------------------------------------------
router.get('/list', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  kickBackfill();
  await Core.ready();
  return res.json(await R.list(req.user, req.query || {}));
}));

router.get('/export', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.export) return res.status(403).json({ error: 'Downloading is not part of your access.' });
  await Core.ready();
  const out = await R.csvRows(req.user, req.query || {});
  await logAudit({ userId: req.user.id, action: 'Joining and drop list downloaded (CSV)', entity: 'JoiningRecord', entityId: 'list', toValue: `${out.count} rows`, reason: JSON.stringify({ ...req.query }).slice(0, 300) });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="joinings-and-drops.csv"');
  return res.send(`﻿${out.csv}`);
}));

router.get('/report', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  await Core.ready();
  return res.json(await R.report(req.user, req.query || {}));
}));
router.get('/report/export', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.export) return res.status(403).json({ error: 'Downloading is not part of your access.' });
  await Core.ready();
  const out = await R.reportCsv(req.user, req.query || {});
  await logAudit({ userId: req.user.id, action: 'Joining and drop report downloaded (CSV)', entity: 'JoiningRecord', entityId: 'report', reason: JSON.stringify({ ...req.query }).slice(0, 300) });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="joinings-and-drops-report.csv"');
  return res.send(`﻿${out.csv}`);
}));

// ---- settings ---------------------------------------------------------------------------------------------------------------------------
router.get('/settings', wrap(async (req, res) => {
  const rt = await A.rights(req.user);
  if (!rt.admin) return res.status(403).json({ error: 'Only an Admin can see these switches.' });
  const HN = require('../utils/hrmsNotify'); // eslint-disable-line global-require
  const settings = await SET.get();
  const emps = await prisma.employee.findMany({ where: { userId: { not: null }, employmentStatus: { notIn: ['Relieved', 'Exited'] } }, select: { employeeCode: true, name: true, department: true }, orderBy: { name: 'asc' }, take: 800 });
  const nameOf = new Map(emps.map((e) => [String(e.employeeCode).toUpperCase(), e.name]));
  const known = await prisma.employee.findMany({ where: { employeeCode: { in: settings.hrPeople.length ? settings.hrPeople : ['-'] } }, select: { employeeCode: true, name: true } });
  known.forEach((e) => nameOf.set(String(e.employeeCode).toUpperCase(), e.name));
  return res.json({
    hrPeopleNames: settings.hrPeople.map((c) => ({ code: c, name: nameOf.get(c) || null })),
    peopleOptions: emps.map((e) => ({ code: e.employeeCode, name: e.name, department: e.department })),
    settings, parties: SET.PARTIES, partyWords: SET.PARTY_WORDS, momentWords: SET.MOMENT_WORDS, ways: { candidate: SET.waysOf('candidate'), other: SET.waysOf('x') },
    emailsOn: (await HN.getSettings()).emailsOn === true,
  });
}));
router.put('/settings', wrap(async (req, res) => {
  const rt = await A.rights(req.user);
  if (!rt.admin) return res.status(403).json({ error: 'Only an Admin can change these switches.' });
  return res.json({ settings: await SET.save(req.body || {}, req.user) });
}));

// ---- by application / candidate / journey ---------------------------------------------------------------------------------------------------
async function appInScope(req, rt, appId) {
  const hit = await prisma.application.findFirst({ where: { id: appId, ...applicationWhere(req.user) }, select: { id: true, stage: true, candidateId: true, requirementId: true } });
  if (hit) return hit;
  // HR (switch ON) and Admin: the application exists, the record decides
  if (rt.kind === 'hr' && rt.hrOn) {
    const rec = await Core.byApplication(appId);
    if (rec && (await A.canSee(req.user, rec, rt))) return prisma.application.findUnique({ where: { id: appId }, select: { id: true, stage: true, candidateId: true, requirementId: true } });
  }
  return null;
}

router.get('/application/:appId', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  await Core.ready();
  const app = await appInScope(req, rt, req.params.appId);
  if (!app) {
    const exists = await prisma.application.findUnique({ where: { id: req.params.appId }, select: { id: true } });
    return res.status(exists ? 403 : 404).json({ error: exists ? 'That candidate is outside your access.' : 'Application not found.' });
  }
  let rec = await Core.byApplication(app.id);
  if (!rec && Core.JOINED_STAGES.includes(app.stage)) rec = await Core.ensureForApplication(app.id);
  const journey = await JR.journey(app.id, { forBde: rt.kind === 'bde' });
  if (!rec) {
    return res.json({ record: null, history: [], told: [], rights: { record: false }, journey, canRecord: false });
  }
  const p = await recordPayload(rec, rt, req.user);
  return res.json({ ...p, journey });
}));

router.get('/journey/:appId', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  const app = await appInScope(req, rt, req.params.appId);
  if (!app) return res.status(403).json({ error: 'That candidate is outside your access.' });
  return res.json({ journey: await JR.journey(app.id, { forBde: rt.kind === 'bde' }) });
}));

router.get('/candidate/:candidateId', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  await Core.ready();
  const S = require('../joindrop/schema'); // eslint-disable-line global-require
  const rows = await S.rows('SELECT * FROM "JoiningRecord" WHERE "candidateId" = ? ORDER BY COALESCE("joinedOn", \'\') DESC', req.params.candidateId);
  const vis = await A.visible(req.user, rows, rt);
  const tasks = await A.taskStates(vis.map((r) => r.replacementTaskId));
  return res.json({ records: vis.map((r) => A.shape(r, rt, { tasks })) });
}));

// ---- one record --------------------------------------------------------------------------------------------------------------------------
router.get('/open-for-job/:requirementId', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  await Core.ready();
  const S = require('../joindrop/schema'); // eslint-disable-line global-require
  const rows = await S.rows('SELECT * FROM "JoiningRecord" WHERE "requirementId" = ? AND "status" = ? AND "replacementDecision" = ? AND COALESCE("replacementStatus", \'\') NOT IN (?, ?)', req.params.requirementId, 'Dropped', 'NEEDED', V.REPL.CLOSED, V.REPL.LINKED);
  const vis = await A.visible(req.user, rows, rt);
  return res.json({ records: vis.map((r) => ({ id: r.id, candidateName: r.candidateName, droppedOn: r.droppedOn, dropReason: r.dropReason })) });
}));

router.get('/client-history/:clientId', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  const ok = rt.kind === 'admin' || rt.kind === 'hr' ? await prisma.client.findUnique({ where: { id: req.params.clientId }, select: { id: true } }) : await prisma.client.findFirst({ where: { id: req.params.clientId, ...clientWhere(req.user) }, select: { id: true } });
  if (!ok) return res.status(404).json({ error: 'That client was not found.' });
  await Core.ready();
  const kind = CH.kindFor(req.user, rt);
  return res.json(await CH.build(req.user, req.params.clientId, { kind }));
}));

router.get('/:id', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const p = await recordPayload(rec, rt, req.user);
  return res.json({ ...p, journey: await JR.journey(rec.applicationId, { forBde: rt.kind === 'bde' }) });
}));

router.get('/:id/people', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const moment = ['join', 'drop', 'decision'].includes(req.query.moment) ? req.query.moment : 'drop';
  return res.json(await N.preview(rec, moment));
}));

// ---- writes ---------------------------------------------------------------------------------------------------------------------------------
router.post('/application/:appId/record', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.record) return res.status(403).json({ error: 'Recording a joining is for the recruiter, team lead, BDE team and Admin.' });
  await Core.ready();
  const app = await appInScope(req, rt, req.params.appId);
  if (!app) return res.status(403).json({ error: 'That candidate is outside your access.' });
  const b = req.body || {};
  const have = await Core.byApplication(app.id);
  if (!have && !Core.JOINED_STAGES.includes(app.stage)) return res.status(409).json({ error: 'This candidate has not reached "Joined" yet. Mark them joined on the Joining screen first.' });
  if (!V.isDay(b.joinedOn)) return res.status(400).json({ error: 'Enter the day the candidate joined.' });
  if (!V.clean(b.location, 120)) return res.status(400).json({ error: 'Enter the place (city or branch) where the candidate joined.' });
  if (have) {
    const patch = { joinedOn: b.joinedOn, location: b.location, designation: b.designation, employmentType: b.employmentType, reportingPerson: b.reportingPerson, reportingContact: b.reportingContact, notes: b.notes };
    Object.keys(patch).forEach((k) => { if (patch[k] === undefined) delete patch[k]; });
    const out = await Core.correctJoining(have.id, patch, req.user, { from: fromOf(rt), reason: b.reason });
    return res.json({ ok: true, message: 'Saved. The joining details are updated.', ...(await recordPayload(out.record, rt, req.user)) });
  }
  const J = require('../utils/joining'); // eslint-disable-line global-require
  const yr = J.dateYearProblem(b.joinedOn, 'joining day');
  if (yr) return res.status(400).json({ error: yr });
  if (b.joinedOn > V.todayIst()) return res.status(400).json({ error: 'The joining day cannot be a day that has not come yet.' });
  const out = await Core.recordJoined({ applicationId: app.id, actor: req.user, info: b, via: 'Joining and drop panel' });
  return res.json({ ok: true, message: 'Saved. The joining is recorded and the team has been told.', ...(await recordPayload(out.record, rt, req.user)), told: undefined });
}));

router.patch('/:id', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.record) return res.status(403).json({ error: 'Correcting a joining is for the recruiter, team lead, BDE team and Admin.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const b = req.body || {};
  const patch = {};
  ['joinedOn', 'location', 'designation', 'employmentType', 'reportingPerson', 'reportingContact', 'notes', 'offeredCtc'].forEach((k) => { if (b[k] !== undefined) patch[k] = b[k]; });
  if (patch.offeredCtc !== undefined && !rt.seePay) return res.status(403).json({ error: 'Your role does not see or change the pay.' });
  const out = await Core.correctJoining(rec.id, patch, req.user, { from: fromOf(rt), reason: b.reason });
  return res.json({ ok: true, message: 'Saved. The change is kept in the history.', ...(await recordPayload(out.record, rt, req.user)) });
}));

const toldWords = (told) => {
  if (!told) return '';
  const bits = [];
  if (told.bells) bits.push(`${told.bells} bell${told.bells === 1 ? '' : 's'}`);
  const sent = (told.emails || []).filter((e) => e.status === 'Sent').length;
  if (sent) bits.push(`${sent} email${sent === 1 ? '' : 's'} sent`);
  if (told.emailsOn === false) bits.push('emails are switched off, so no email left (the bells and tasks still happened)');
  return bits.length ? `People told: ${bits.join(', ')}.` : '';
};

router.post('/:id/drop', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.report) return res.status(403).json({ error: 'Reporting a drop is for the recruiter, team lead, BDE, HR and Admin.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.reportDrop(rec.id, req.body || {}, req.user, { from: fromOf(rt) });
  return res.json({
    ok: true, message: `Saved. The drop is recorded. ${toldWords(out.told)}`.trim(), tasks: out.tasks, problems: out.told && out.told.problems,
    afterIncentive: out.afterIncentive, ...(await recordPayload(out.record, rt, req.user)),
  });
}));

router.patch('/:id/drop', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.record) return res.status(403).json({ error: 'Correcting a drop is for the recruiter, team lead, BDE team and Admin.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.correctDrop(rec.id, req.body || {}, req.user, { from: fromOf(rt) });
  return res.json({ ok: true, message: 'Saved. The correction is kept in the history.', ...(await recordPayload(out.record, rt, req.user)) });
}));

router.post('/:id/decision', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.decide) return res.status(403).json({ error: 'Only the BDE team, a team lead or an Admin can enter the client\'s answer for them.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.decide(rec.id, req.body || {}, req.user, { from: fromOf(rt), onBehalf: true });
  return res.json({ ok: true, message: `Saved, marked "entered by ${req.user.name} on the client's behalf". ${toldWords(out.told)}`.trim(), tasks: out.tasks, ...(await recordPayload(out.record, rt, req.user)) });
}));

router.post('/:id/replacement/link', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.link) return res.status(403).json({ error: 'Linking a replacement is for the recruiter, team lead, BDE team and Admin.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.linkReplacement(rec.id, (req.body || {}).applicationId, req.user, { from: fromOf(rt) });
  return res.json({ ok: true, message: 'Saved. The new candidate is linked as the replacement.', ...(await recordPayload(out.record, rt, req.user)) });
}));
router.post('/:id/replacement/close', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.link) return res.status(403).json({ error: 'Closing a replacement is for the recruiter, team lead, BDE team and Admin.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.closeReplacement(rec.id, (req.body || {}).note, req.user, { from: fromOf(rt) });
  return res.json({ ok: true, message: 'Saved. The replacement is closed.', ...(await recordPayload(out.record, rt, req.user)) });
}));

router.post('/:id/replacement-task/cancel', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.cancelTask) return res.status(403).json({ error: 'Only the BDE team, a team lead or an Admin can cancel the replacement task. A recruiter cannot cancel it alone.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.cancelReplacementTask(rec.id, (req.body || {}).reason, req.user, { from: fromOf(rt) });
  return res.json({ ok: true, message: `The replacement task is cancelled. ${toldWords(out.told)}`.trim(), ...(await recordPayload(out.record, rt, req.user)) });
}));
router.post('/:id/replacement-task/open', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.openTask) return res.status(403).json({ error: 'Only the BDE team, a team lead or an Admin can open a replacement task by hand.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.openReplacementTask(rec.id, req.user, { from: fromOf(rt) });
  return res.json({ ok: true, message: 'The replacement task is open for the recruiter.', ...(await recordPayload(out.record, rt, req.user)) });
}));

router.post('/:id/reopen', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.reopen) return res.status(403).json({ error: 'Only the BDE team, a team lead or an Admin can withdraw a drop.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.reopen(rec.id, (req.body || {}).reason, req.user, { from: fromOf(rt) });
  return res.json({ ok: true, message: `Saved. The drop is withdrawn. ${toldWords(out.told)}`.trim(), ...(await recordPayload(out.record, rt, req.user)) });
}));

router.get('/:id/candidate-notice', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.notice) return res.status(403).json({ error: 'Sending the candidate notice is for HR, the BDE team, a team lead and Admin.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  if (rec.status !== 'Dropped') return res.status(409).json({ error: 'There is no drop to tell the candidate about.' });
  return res.json(await N.noticePreview(rec));
}));
router.post('/:id/candidate-notice', wrap(async (req, res) => {
  const rt = await staffOnly(req, res); if (!rt) return undefined;
  if (!rt.notice) return res.status(403).json({ error: 'Sending the candidate notice is for HR, the BDE team, a team lead and Admin.' });
  const rec = await loadRec(req, res, rt); if (!rec) return undefined;
  const out = await Core.sendCandidateNotice(rec.id, req.body || {}, req.user, { from: fromOf(rt) });
  const said = (out.result || []).map((r) => `${r.channel}: ${r.status}`).join('; ');
  return res.json({ ok: true, message: said ? `Done. ${said}.` : 'Nothing could be sent.', result: out.result, problems: out.problems, ...(await recordPayload(out.record, rt, req.user)) });
}));

module.exports = router;
