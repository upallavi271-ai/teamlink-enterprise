// ---------------------------------------------------------------------------
// /api/ats/work — recruiter work allocation, targets, performance and workflow automation (founder ATS audit, round 3).
// The logic is in utils/atsWork/*; this file only checks who may ask and answers. Every list is scoped on the server.
//
//   GET  /settings            the switches (Admin reads all; others the few that change their screens)     PUT /settings (Admin)
//   GET  /escalation          TL escalation state (utils/atsAlertSettings.js)                              POST /escalation/turn-on (Admin)
//   GET  /requirements/:id/suggest        the department's recruiters, best first, with the reason         POST /requirements/:id/assign-suggested
//   GET|POST /requirements/:id/match      the "Good fit" list worked out once
//   GET  /requirements/:id/close-list     POST /requirements/:id/close-and-notify
//   GET  /results?period=&date=   PUT /targets/:userId   GET /targets/:userId   GET /leaderboard   GET /underperformers
//   GET  /offer-ratio    GET /cost-revenue (Admin / Accounts)    GET /carry-over    GET /eod/me   POST /eod/confirm   GET /eod/compliance
//   GET  /payouts   POST /payouts/:id/decide (Accounts / Admin)         GET /failures   POST /failures/:id/retry|done
//   GET  /shortlist   POST /shortlist/decide
//   GET  /reassign/people   GET|POST /reassign/:userId        GET /ownership/:candidateId   POST /ownership/:candidateId/claim
//   GET|POST /disputes   POST /disputes/:id/decide            GET|POST /delegations   DELETE /delegations/:id
//   GET  /trail/requirement/:id   GET /trail/application/:id  POST /bulk-preview
//   GET  /joining-proof/:applicationId   POST /joining-proof/:applicationId   GET /joining-proof/:applicationId/file
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const S = require('../utils/scope');
const core = require('../utils/atsWork/core');
const alloc = require('../utils/atsWork/allocation');
const T = require('../utils/atsWork/targets');
const L = require('../utils/atsWork/lifecycle');
const P = require('../utils/atsWork/people');
const AS = require('../utils/atsAlertSettings');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAdmin = (u) => !!u && ['SUPER_ADMIN', 'ADMIN'].includes(u.role) && !u.viewAs;
const view = (u) => S.atsViewRole(u);
const LEADS = ['admin', 'mgmt', 'stl', 'tl'];
const internalAts = (u) => !['client', 'candidate', 'none'].includes(view(u));
const send = (res, out) => res.status(out.status || 200).json((({ status, ...rest }) => rest)(out));

router.use(requireAuth);
router.use((req, res, next) => (internalAts(req.user) || req.user.role === 'SUPER_ADMIN' || isAdmin(req.user) || S.accountsGlobal(req.user) ? next() : res.status(403).json({ error: 'This is for the TeamLink team.' })));

async function reqInScope(user, id) {
  const r = await prisma.requirement.findUnique({ where: { id } });
  if (!r) return { status: 404, error: 'Requirement not found' };
  if (!S.matches(r, S.requirementWhere(user))) return { status: 403, ...S.OUT_OF_SCOPE };
  return { r };
}

// ------------------------------------------------------------------ settings
router.get('/settings', wrap(async (req, res) => {
  const s = await core.load({ maxAgeMs: 0 });
  if (isAdmin(req.user)) return res.json({ settings: s, canEdit: true, defaults: core.DEFAULTS });
  return res.json({ canEdit: false, settings: { leaderboard: s.leaderboard, joiningProof: s.joiningProof, aiShortlistApproval: s.aiShortlistApproval, closeNotify: s.closeNotify, autoAssign: s.autoAssign, requireRecruiter: s.requireRecruiter, ownership: s.ownership } });
}));
router.put('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or an Admin changes these settings.' });
  const out = await core.save(req.body || {});
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Work allocation settings changed', entity: 'Setting', entityId: core.STORE_ID, fromValue: JSON.stringify(out.before), toValue: JSON.stringify(out.settings) });
  // the working-day switch changes every due date: tell the due-date caches (they key on the alert settings' version)
  if (req.body && req.body.sla) { await require('../utils/atsWork/calendar').refresh({ maxAgeMs: 0 }).catch(() => null); await AS.saveAlertSettings({}).catch(() => null); }
  return res.json({ settings: out.settings });
}));
router.get('/escalation', wrap(async (req, res) => {
  const st = await AS.loadAlertSettings({ maxAgeMs: 0 });
  res.json({ enabled: st.escalation.enabled, tlAfterDays: st.escalation.tlAfterDays, managerAfterDays: st.escalation.managerAfterDays, lastRunAt: st.escalation.lastRunAt || null, canEdit: isAdmin(req.user), note: 'When on, a task that is late is flagged to its owner, then to the team lead after the days below, then to the manager. In-app notices only.' });
}));
router.post('/escalation/turn-on', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or an Admin turns this on.' });
  const on = req.body && req.body.enabled === false ? false : true;
  const out = await AS.saveAlertSettings({ escalation: { enabled: on } });
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: `TL escalation turned ${on ? 'on' : 'off'}`, entity: 'Setting', entityId: AS.STORE_ID, fromValue: String(out.before.escalation.enabled), toValue: String(on) });
  res.json({ enabled: out.settings.escalation.enabled });
}));

// ------------------------------------------------------------------ requirement: suggest / assign / match / close
router.get('/requirements/:id/suggest', wrap(async (req, res) => {
  if (!LEADS.includes(view(req.user))) return res.status(403).json({ error: 'The recruiter suggestions are for team leads, managers and admins.' });
  const g = await reqInScope(req.user, req.params.id);
  if (g.error) return send(res, g);
  const s = await core.load();
  res.json({ autoAssign: s.autoAssign, waitsForRecruiter: await alloc.postingBlock(g.r), suggestions: await alloc.suggest(g.r, { limit: 8 }), match: await alloc.matchOf(g.r.id) });
}));
router.post('/requirements/:id/assign-suggested', wrap(async (req, res) => {
  if (view(req.user) === 'bde' || S.isBdeTl(req.user)) return res.status(403).json({ error: 'The team lead gives a requirement to recruiters.' });
  const g = await reqInScope(req.user, req.params.id);
  if (g.error) return send(res, g);
  if (!(await can(req.user, 'ats', 'requirements', 'Requirement Detail', 'assign'))) return res.status(403).json({ error: "Assigning recruiters isn't included in your role's permissions." });
  if (view(req.user) === 'bde' || S.isBdeTl(req.user)) return res.status(403).json({ error: 'The team lead gives a requirement to recruiters.' });
  const ids = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String))].slice(0, 5);
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one recruiter.' });
  const users = await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active', atsAccess: true, atsRole: 'RECRUITER' }, select: { id: true, name: true } });
  if (users.length !== ids.length) return res.status(400).json({ error: 'Pick active recruiters.' });
  const waited = await alloc.postingBlock(g.r);
  const updated = await alloc.giveTo(g.r, users.map((u) => ({ userId: u.id })), req.user);
  if (waited) { try { await require('../utils/jobPosting').autoPost(updated.id, { actorId: req.user.id, actorName: req.user.name, trigger: 'retry', background: true }); } catch { /* shown by the posting engine */ } }
  const match = await alloc.runMatch(updated.id);
  res.json({ ok: true, assigned: users.map((u) => u.name), match });
}));
router.get('/requirements/:id/match', wrap(async (req, res) => {
  const g = await reqInScope(req.user, req.params.id);
  if (g.error) return send(res, g);
  res.json({ match: await alloc.matchOf(g.r.id) });
}));
router.post('/requirements/:id/match', wrap(async (req, res) => {
  const g = await reqInScope(req.user, req.params.id);
  if (g.error) return send(res, g);
  if (!LEADS.includes(view(req.user)) && view(req.user) !== 'recruiter') return res.status(403).json({ error: 'Not for this login.' });
  send(res, { status: 200, match: await alloc.runMatch(g.r.id, { force: true }) });
}));
router.get('/requirements/:id/close-list', wrap(async (req, res) => {
  const g = await reqInScope(req.user, req.params.id);
  if (g.error) return send(res, g);
  if (!LEADS.includes(view(req.user)) && view(req.user) !== 'bde') return res.status(403).json({ error: 'Not for this login.' });
  const s = await core.load();
  send(res, { ...(await L.closeList(g.r.id)), enabled: s.closeNotify.enabled });
}));
router.post('/requirements/:id/close-and-notify', wrap(async (req, res) => {
  const g = await reqInScope(req.user, req.params.id);
  if (g.error) return send(res, g);
  if (!(await can(req.user, 'ats', 'requirements', 'Requirement Detail', 'approve'))) return res.status(403).json({ error: "Closing isn't included in your role's permissions." });
  send(res, await L.closeAndNotify(req.user, g.r.id));
}));

// ------------------------------------------------------------------ targets, results, performance
router.get('/results', wrap(async (req, res) => send(res, await T.results(req.user, { period: String(req.query.period || 'MONTHLY').toUpperCase(), date: req.query.date }))));
async function mayTarget(user, userId) {
  if (!LEADS.includes(view(user))) return false;
  return P.isLead(user) && (S.scopeOf(user).global || (await P.canReach(user, userId)));
}
router.get('/targets/:userId', wrap(async (req, res) => send(res, await T.targetsOf(req.user, req.params.userId))));
router.put('/targets/:userId', wrap(async (req, res) => {
  if (!(await mayTarget(req.user, req.params.userId))) return res.status(403).json({ error: 'Targets are set by the team lead, manager or an Admin, for people in their area.' });
  const out = await T.setTargets(req.params.userId, String(req.body.period || '').toUpperCase(), req.body.values || {}, { id: req.user.id, name: req.user.name });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(out);
}));
router.get('/leaderboard', wrap(async (req, res) => send(res, await T.leaderboard(req.user, { period: String(req.query.period || 'MONTHLY').toUpperCase(), date: req.query.date }))));
router.get('/underperformers', wrap(async (req, res) => send(res, await T.underperformers(req.user))));
router.get('/offer-ratio', wrap(async (req, res) => send(res, await T.offerToJoining(req.user, { period: String(req.query.period || 'MONTHLY').toUpperCase(), date: req.query.date }))));
router.get('/cost-revenue', wrap(async (req, res) => send(res, await T.costRevenue(req.user, { month: req.query.month }))));
router.get('/carry-over', wrap(async (req, res) => res.json(await T.carryOver(req.user))));
router.get('/eod/me', wrap(async (req, res) => res.json(await T.myEod(req.user, /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? req.query.day : undefined))));
router.post('/eod/confirm', wrap(async (req, res) => {
  const out = await T.confirmEod(req.user, req.body && req.body.day ? req.body.day : undefined, req.body && req.body.note);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));
router.get('/eod/compliance', wrap(async (req, res) => {
  if (!LEADS.includes(view(req.user))) return res.status(403).json({ error: 'The compliance list is for team leads, managers and admins.' });
  const out = await T.results(req.user, { period: String(req.query.period || 'MONTHLY').toUpperCase(), date: req.query.date });
  if (out.error) return send(res, out);
  const emps = await prisma.employee.findMany({ where: { userId: { in: out.rows.map((r) => r.userId) } }, select: { userId: true, tl: true, department: true } });
  const teamOf = new Map(emps.map((e) => [e.userId, e.tl ? `${e.tl}'s team` : (e.department || 'No team')]));
  const teams = new Map();
  out.rows.forEach((r) => {
    const t = teamOf.get(r.userId) || 'No team';
    const x = teams.get(t) || { team: t, due: 0, done: 0 }; x.due += r.eod.due; x.done += r.eod.done; teams.set(t, x);
  });
  res.json({ from: out.from, to: out.to, people: out.rows.map((r) => ({ userId: r.userId, name: r.name, team: teamOf.get(r.userId) || 'No team', ...r.eod })).sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101)),
    teams: [...teams.values()].map((t) => ({ ...t, pct: t.due ? Math.round((t.done * 100) / t.due) : null })) });
}));

// ------------------------------------------------------------------ payouts, failures, shortlist
const mayAccounts = (u) => isAdmin(u) || S.accountsGlobal(u);
router.get('/payouts', wrap(async (req, res) => {
  if (!mayAccounts(req.user)) return res.status(403).json({ error: 'Payout approvals are for Accounts and Admin.' });
  res.json({ rows: await L.payouts(String(req.query.status || 'Pending')) });
}));
router.post('/payouts/:id/decide', wrap(async (req, res) => {
  if (!mayAccounts(req.user)) return res.status(403).json({ error: 'Payout approvals are for Accounts and Admin.' });
  send(res, await L.decidePayout(req.params.id, req.user, req.body.decision, req.body.amount, req.body.note));
}));
router.get('/failures', wrap(async (req, res) => {
  if (!isAdmin(req.user) && !LEADS.includes(view(req.user))) return res.status(403).json({ error: 'Failed steps are for team leads, managers and admins.' });
  res.json({ rows: await L.failures(req.query.status ? String(req.query.status) : null) });
}));
router.post('/failures/:id/retry', wrap(async (req, res) => {
  if (!isAdmin(req.user) && !LEADS.includes(view(req.user))) return res.status(403).json({ error: 'Not for this login.' });
  send(res, await L.retryStep(req.params.id, req.user));
}));
router.post('/failures/:id/done', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin marks a failed step done.' });
  send(res, await L.markDone(req.params.id, req.user));
}));
router.get('/shortlist', wrap(async (req, res) => {
  const s = await core.load();
  if (!['recruiter', ...LEADS].includes(view(req.user))) return res.status(403).json({ error: 'Not for this login.' });
  const rows = await L.shortlistList(req.user);
  let scoped = rows;
  if (!S.scopeOf(req.user).global && rows.length) {
    const ok = new Set((await prisma.application.findMany({ where: { AND: [{ id: { in: rows.map((r) => r.applicationId) } }, S.applicationWhere(req.user)] }, select: { id: true } })).map((a) => a.id));
    scoped = rows.filter((r) => ok.has(r.applicationId));
  }
  res.json({ enabled: s.aiShortlistApproval.enabled, rows: scoped });
}));
router.post('/shortlist/decide', wrap(async (req, res) => {
  if (!['recruiter', ...LEADS].includes(view(req.user))) return res.status(403).json({ error: 'Not for this login.' });
  const ids = (Array.isArray(req.body.applicationIds) ? req.body.applicationIds : []).map(String);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one candidate.' });
  if (!S.scopeOf(req.user).global) {
    const ok = new Set((await prisma.application.findMany({ where: { AND: [{ id: { in: ids } }, S.applicationWhere(req.user)] }, select: { id: true } })).map((a) => a.id));
    if (ids.some((i) => !ok.has(i))) return res.status(403).json(S.OUT_OF_SCOPE);
  }
  send(res, await L.shortlistDecide(req.user, ids, req.body.decision, req.body.note));
}));

// ------------------------------------------------------------------ people and cases
router.get('/reassign/people', wrap(async (req, res) => send(res, await P.reassignPeople(req.user))));
router.get('/reassign/:userId', wrap(async (req, res) => send(res, await P.reassignPreview(req.user, req.params.userId))));
router.post('/reassign/:userId', wrap(async (req, res) => send(res, await P.reassignDo(req.user, req.params.userId, String(req.body.toUserId || ''), req.body.what))));
router.get('/ownership/:candidateId', wrap(async (req, res) => {
  const a = await prisma.application.count({ where: { AND: [{ candidateId: req.params.candidateId }, S.applicationWhere(req.user)] } });
  if (!a && !S.scopeOf(req.user).global) return res.status(403).json(S.OUT_OF_SCOPE);
  res.json(await P.ownershipOf(req.params.candidateId));
}));
router.post('/ownership/:candidateId/claim', wrap(async (req, res) => {
  if (!['recruiter', ...LEADS].includes(view(req.user))) return res.status(403).json({ error: 'Not for this login.' });
  send(res, await P.claimExpired(req.user, req.params.candidateId));
}));
router.post('/disputes', wrap(async (req, res) => {
  if (!['recruiter', ...LEADS].includes(view(req.user))) return res.status(403).json({ error: 'Not for this login.' });
  send(res, await P.openDispute(req.user, req.body.candidateId, req.body.evidence));
}));
router.get('/disputes', wrap(async (req, res) => send(res, await P.disputes(req.user, { candidateId: req.query.candidateId ? String(req.query.candidateId) : null, status: req.query.status ? String(req.query.status) : null }))));
router.post('/disputes/:id/decide', wrap(async (req, res) => send(res, await P.decideDispute(req.user, req.params.id, String(req.body.winnerId || ''), req.body.reason))));
router.get('/delegations', wrap(async (req, res) => res.json({ rows: await P.myDelegations(req.user) })));
router.post('/delegations', wrap(async (req, res) => send(res, await P.delegate(req.user, req.body || {}))));
router.delete('/delegations/:id', wrap(async (req, res) => send(res, await P.revokeDelegation(req.user, req.params.id))));
router.get('/delegation-people', wrap(async (req, res) => {
  const users = await prisma.user.findMany({ where: { status: 'Active', atsAccess: true, atsRole: { in: ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'] }, id: { not: req.user.id } }, select: { id: true, name: true, atsRole: true, atsDepartment: true }, orderBy: { name: 'asc' }, take: 300 });
  res.json({ people: users.filter((u) => process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX || !/zztest|example\.test/i.test(u.name)) });
}));

// ------------------------------------------------------------------ trail, preview, proof
router.get('/trail/requirement/:id', wrap(async (req, res) => {
  if (!internalAts(req.user)) return res.status(403).json({ error: 'Not for this login.' });
  const g = await reqInScope(req.user, req.params.id);
  if (g.error) return send(res, g);
  send(res, await P.trailOf({ requirementId: g.r.id }));
}));
router.get('/trail/application/:id', wrap(async (req, res) => {
  const a = await prisma.application.findUnique({ where: { id: req.params.id }, include: { requirement: { include: { client: true, recruiter: true, bde: true } } } });
  if (!a) return res.status(404).json({ error: 'Application not found' });
  if (!S.applicationInScope(req.user, a)) return res.status(403).json(S.OUT_OF_SCOPE);
  send(res, await P.trailOf({ applicationId: a.id }));
}));
router.post('/bulk-preview', wrap(async (req, res) => {
  if ([S.scopeOf(req.user).role, S.scopeOf(req.user).atsRole].some((r) => ['CLIENT', 'CANDIDATE'].includes(r))) return res.status(403).json({ error: 'Bulk actions are not available to this login' });
  send(res, await P.bulkPreview(req.user, req.body || {}));
}));
router.get('/joining-proof/:applicationId', wrap(async (req, res) => {
  const a = await prisma.application.findUnique({ where: { id: req.params.applicationId }, include: { requirement: { include: { client: true, recruiter: true, bde: true } } } });
  if (!a) return res.status(404).json({ error: 'Application not found' });
  if (!S.applicationInScope(req.user, a)) return res.status(403).json(S.OUT_OF_SCOPE);
  res.json({ ...(await P.proofOf(a.id)), billingStatus: a.billingStatus || null });
}));
router.post('/joining-proof/:applicationId', wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'interviews', 'Joining', 'edit'))) return res.status(403).json({ error: "Joining isn't included in your role's permissions." });
  const A = require('../utils/attachments');
  let parsed;
  try { parsed = await A.parseMultipart(req); } catch (e) { return res.status(400).json({ error: e.code === 'TOO_LARGE' ? 'The file is too big.' : 'Send the proof as a file upload.' }); }
  send(res, await P.saveProof(req.user, req.params.applicationId, parsed.file));
}));
router.get('/joining-proof/:applicationId/file', wrap(async (req, res) => {
  const a = await prisma.application.findUnique({ where: { id: req.params.applicationId }, include: { requirement: { include: { client: true, recruiter: true, bde: true } } } });
  if (!a) return res.status(404).json({ error: 'Application not found' });
  if (!S.applicationInScope(req.user, a)) return res.status(403).json(S.OUT_OF_SCOPE);
  const [p] = await core.q('SELECT * FROM "AtsJoiningProof" WHERE "applicationId" = ?', a.id);
  const full = p ? require('../utils/attachments').resolveStored(p.data) : null;
  if (!full) return res.status(404).json({ error: 'No proof uploaded.' });
  res.set('Content-Type', p.mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${String(p.fileName || 'joining-proof').replace(/[^\w.\- ]/g, '_')}"`);
  return res.sendFile(full);
}));

module.exports = router;
