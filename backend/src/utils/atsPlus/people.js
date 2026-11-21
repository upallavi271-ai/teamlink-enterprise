// ---------------------------------------------------------------------------
// RECRUITER INSIGHTS (market benchmark 05.08 / 05.09 / 05.10 / 05.11 / 05.12) - ATS -> Reports & Team -> ATS Reports -> "Recruiter insights",
// and Administration -> ATS settings -> Branches. Mounted at /api/ats-plus (routes/atsPlus.js).
//
// NO SECOND COUNT: every figure is the Daily report's own event (utils/dailyReport.js eventsIn - Sent to client, Interviews, Offers,
// Joined ...), counted in the viewer's own world, so these ratios agree with the Daily report and the leaderboard (utils/atsWork/targets.js).
//
//   GET  /insights/ratios?from&to            05.10  submission : interview : offer : join per recruiter + the team line
//   GET  /insights/coaching?from&to&userId    05.09  each ratio against the team, what to work on (rules written in code)
//   GET  /insights/calls?days                05.08  recorded calls (AI calls + recruiter calls through the phone gateway): listen + transcript
//   PUT  /insights/calls/:source/:id/transcript { text }   paste / correct the transcript (the AI call keeps its own)
//   GET  /insights/ai-activity?userId&days   05.12  what the AI did, for whom and when (own rows; Admin: anyone)
//   GET  /branches  PUT /branches { branches }   POST /branches/assign { entity, ids, branch }   GET /branches/report?branch   05.11
// A recruiter / BDE sees their own row with the team line beside it; TL / STL / Admin / Manager see everyone in their scope.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../../db');
const DR = require('../dailyReport');
const { requirementWhere, clientWhere, atsViewRole } = require('../scope');
const { logAudit } = require('../audit');
const S = require('./store');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pct = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : null);
function range(q) {
  const to = DAY.test(String(q.to || '')) ? q.to : DR.todayIst();
  const from = DAY.test(String(q.from || '')) ? q.from : DR.addDays(to, -89);
  return from > to ? { from: to, to: from } : { from, to };
}

// ------------------------------------------------------------------ 05.10 ratios
const KEYS = ['sentClient', 'interviews', 'offers', 'joined', 'calls', 'added', 'followUps'];
async function counts(viewer, from, to) {
  const acc = DR.access(viewer);
  if (!acc.ok) return { error: acc.error };
  let world = await DR.worldFor(viewer);
  let events = await DR.eventsIn(viewer, world, from, to);
  let team = null;
  if (acc.selfOnly) {
    // a recruiter's own row, and the line of everyone (the same events, read through a Super Admin's world)
    const sys = await require('../atsWork/targets').systemViewer(); // eslint-disable-line global-require
    if (sys) {
      const w2 = await DR.worldFor(sys);
      team = tally(await DR.eventsIn(sys, w2, from, to), w2);
    }
  }
  const per = tally(events, world);
  let rows = [...per.values()];
  if (acc.selfOnly) rows = rows.filter((r) => r.userId === viewer.id);
  world = null; events = null;
  return { rows, team: team ? [...team.values()] : rows, selfOnly: acc.selfOnly };
}
function tally(events, world) {
  const per = new Map();
  events.forEach((e) => {
    if (!KEYS.includes(e.metric) || !e.person || !String(e.person.key || '').startsWith('u:')) return;
    const p = world.people.get(e.person.key) || {};
    if (p.former) return;
    const r = per.get(e.person.key) || { userId: e.person.key.slice(2), name: p.label || e.person.label, ...Object.fromEntries(KEYS.map((k) => [k, 0])) };
    r[e.metric] += 1; per.set(e.person.key, r);
  });
  return per;
}
function ratiosOf(r) {
  return {
    submissions: r.sentClient, interviews: r.interviews, offers: r.offers, joinings: r.joined,
    line: `${r.sentClient} : ${r.interviews} : ${r.offers} : ${r.joined}`,
    subToInterview: pct(r.interviews, r.sentClient), interviewToOffer: pct(r.offers, r.interviews), offerToJoin: pct(r.joined, r.offers),
    subToJoin: pct(r.joined, r.sentClient), submissionsPerJoining: r.joined ? Math.round((r.sentClient / r.joined) * 10) / 10 : null,
  };
}
function teamLine(rows) {
  const t = Object.fromEntries(KEYS.map((k) => [k, rows.reduce((a, r) => a + (r[k] || 0), 0)]));
  return { people: rows.length, ...ratiosOf(t), calls: t.calls, added: t.added, followUps: t.followUps, perPerson: Object.fromEntries(KEYS.map((k) => [k, rows.length ? Math.round((t[k] / rows.length) * 10) / 10 : 0])) };
}
async function ratios(viewer, q) {
  const { from, to } = range(q);
  const c = await counts(viewer, from, to);
  if (c.error) return { status: 403, error: c.error };
  const rows = c.rows.filter((r) => r.sentClient || r.interviews || r.offers || r.joined)
    .map((r) => ({ userId: r.userId, name: r.name, ...ratiosOf(r) }))
    .sort((a, b) => b.joinings - a.joinings || b.submissions - a.submissions || a.name.localeCompare(b.name));
  return { status: 200, from, to, rows, team: teamLine(c.team), selfOnly: c.selfOnly, note: 'Sent to client : interviews : offers : joinings, counted the way the Daily report counts them.' };
}

// ------------------------------------------------------------------ 05.09 coaching
const TIPS = {
  subToInterview: 'Fewer of the profiles you send get an interview than the team. Before sharing, check the requirement\'s must-haves and the share checklist, and read the client\'s rejection reasons for this job.',
  interviewToOffer: 'Fewer interviews turn into offers than the team. Send the interview preparation link, brief the person on the client and the role, and collect feedback after each round.',
  offerToJoin: 'More of your offers do not reach joining than the team. Stay in touch through the notice period (follow-ups every week), confirm the joining date twice and watch for counter-offers.',
  calls: 'You make fewer calls than the team average. More conversations usually mean more submissions.',
  submissions: 'You send fewer profiles to clients than the team average. Pick the open jobs with the most interviews left and source for them first.',
  followUps: 'You close fewer follow-ups than the team. Clear the Follow-ups list each morning.',
};
const STRENGTH = {
  subToInterview: 'Your profiles get interviews more often than the team: share how you screen.',
  interviewToOffer: 'Your interviews turn into offers more often than the team.',
  offerToJoin: 'Your offers reach joining more often than the team.',
};
function coachOne(r, team) {
  const mine = ratiosOf(r);
  const out = { userId: r.userId, name: r.name, ratios: mine, activity: { calls: r.calls, added: r.added, followUps: r.followUps }, work: [], strengths: [] };
  ['subToInterview', 'interviewToOffer', 'offerToJoin'].forEach((k) => {
    const base = { subToInterview: 'submissions', interviewToOffer: 'interviews', offerToJoin: 'offers' }[k];
    if (mine[k] === null || team[k] === null || (mine[base] || 0) < 3) return; // too few to judge
    const gap = Math.round((mine[k] - team[k]) * 10) / 10;
    if (gap <= -10) out.work.push({ key: k, yours: mine[k], team: team[k], gap, tip: TIPS[k] });
    else if (gap >= 10) out.strengths.push({ key: k, yours: mine[k], team: team[k], gap, tip: STRENGTH[k] });
  });
  [['calls', 'calls'], ['submissions', 'sentClient'], ['followUps', 'followUps']].forEach(([k, src]) => {
    const avg = team.perPerson[src] || 0;
    if (avg >= 5 && (r[src] || 0) < avg * 0.6) out.work.push({ key: k, yours: r[src] || 0, team: avg, gap: Math.round(((r[src] || 0) - avg) * 10) / 10, tip: TIPS[k] });
  });
  out.summary = out.work.length ? `Work on: ${out.work.map((w) => ({ subToInterview: 'profile to interview', interviewToOffer: 'interview to offer', offerToJoin: 'offer to joining', calls: 'calls', submissions: 'submissions', followUps: 'follow-ups' }[w.key])).join(', ')}.`
    : (mine.submissions < 3 ? 'Not enough submissions in this period to compare yet.' : 'In line with the team or better. Keep it up.');
  return out;
}
async function coaching(viewer, q) {
  const { from, to } = range(q);
  const c = await counts(viewer, from, to);
  if (c.error) return { status: 403, error: c.error };
  const team = teamLine(c.team);
  let rows = c.rows;
  if (q.userId) rows = rows.filter((r) => r.userId === String(q.userId));
  return { status: 200, from, to, team, rows: rows.map((r) => coachOne(r, team)).sort((a, b) => b.work.length - a.work.length || a.name.localeCompare(b.name)), selfOnly: c.selfOnly };
}

// ------------------------------------------------------------------ 05.08 call recordings
async function tableExists(name) {
  const r = await prisma.$queryRawUnsafe('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?', name).catch(() => []);
  return r.length > 0;
}
async function calls(viewer, q) {
  const view = atsViewRole(viewer);
  if (['client', 'candidate', 'none', 'accounts'].includes(view)) return { status: 403, error: 'Call recordings are for the recruitment team.' };
  const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000);
  const self = ['recruiter', 'bde', 'hr'].includes(view);
  const reqIds = self ? null : new Set((await prisma.requirement.findMany({ where: requirementWhere(viewer), select: { id: true } })).map((r) => r.id));
  const out = [];
  if (await tableExists('AiCall')) {
    const rows = await prisma.$queryRawUnsafe(`SELECT "id","candidateId","requirementId","initiatedById","initiatedByName","startedAt","durationSec","outcome","summary","transcript","recordingUrl","createdAt"
      FROM "AiCall" WHERE "createdAt" >= ? AND "deletedAt" IS NULL AND ("recordingUrl" IS NOT NULL OR "transcript" IS NOT NULL) ORDER BY "createdAt" DESC LIMIT 500`, since.toISOString()).catch(() => []);
    rows.filter((r) => (self ? r.initiatedById === viewer.id : (!r.requirementId || reqIds.has(r.requirementId) || r.initiatedById === viewer.id)))
      .forEach((r) => out.push({ source: 'ai', id: r.id, candidateId: r.candidateId, requirementId: r.requirementId, by: r.initiatedByName || 'AI caller', at: r.startedAt || r.createdAt, seconds: r.durationSec, outcome: r.outcome, summary: r.summary, recordingUrl: r.recordingUrl, transcript: r.transcript, transcriptBy: 'AI call' }));
  }
  const msgs = await prisma.candidateMessage.findMany({
    where: { channel: 'Call', createdAt: { gte: since }, body: { contains: 'Recording' }, ...(self ? { senderUserId: viewer.id } : {}) },
    select: { id: true, candidateId: true, applicationId: true, senderName: true, senderUserId: true, createdAt: true, statusDetail: true, body: true },
    orderBy: { createdAt: 'desc' }, take: 500,
  });
  const appReq = new Map((await prisma.application.findMany({ where: { id: { in: msgs.map((m) => m.applicationId).filter(Boolean) } }, select: { id: true, requirementId: true } })).map((a) => [a.id, a.requirementId]));
  msgs.forEach((m) => {
    const rid = appReq.get(m.applicationId) || null;
    if (!self && rid && !reqIds.has(rid) && m.senderUserId !== viewer.id) return;
    const url = (String(m.body || '').match(/Recording:\s*(\S+)/) || [])[1] || null;
    if (!url) return;
    out.push({ source: 'call', id: m.id, candidateId: m.candidateId, requirementId: rid, by: m.senderName || 'Recruiter', at: m.createdAt, outcome: m.statusDetail, recordingUrl: url, transcript: null });
  });
  const tx = await S.items.list('call-transcript', { refId: out.map((c) => `${c.source}:${c.id}`) });
  const txOf = new Map(tx.map((t) => [t.refId, t]));
  const cands = new Map((await prisma.candidate.findMany({ where: { id: { in: [...new Set(out.map((c) => c.candidateId).filter(Boolean))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  out.forEach((c) => {
    const t = txOf.get(`${c.source}:${c.id}`);
    if (t) { c.transcript = t.text; c.transcriptBy = `${t.updatedByName || t.createdByName || 'someone'} (typed)`; }
    c.candidate = cands.get(c.candidateId) || null;
  });
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { status: 200, days, rows: out, note: 'Recorded calls: the AI calls, and recruiter calls made through the phone gateway when recording is switched on there. Paste or correct a transcript on any call.' };
}
async function saveTranscript(viewer, source, id, text) {
  if (!['ai', 'call'].includes(source)) return { status: 400, error: 'Unknown call.' };
  const t = String(text || '').trim();
  if (t.length < 5) return { status: 400, error: 'Paste the transcript (at least a few words).' };
  const list = await calls(viewer, { days: 365 });
  if (list.error) return list;
  if (!list.rows.some((c) => c.source === source && c.id === id)) return { status: 404, error: 'That call is not in your list.' };
  const refId = `${source}:${id}`;
  const [cur] = await S.items.list('call-transcript', { refId });
  if (cur) await S.items.update(cur.id, { text: t.slice(0, 50000), updatedByName: viewer.name });
  else await S.items.create('call-transcript', { refType: 'Call', refId, text: t.slice(0, 50000), updatedByName: viewer.name }, viewer);
  await logAudit({ userId: viewer.id, action: 'Call transcript saved', entity: 'Call', entityId: refId, toValue: `${t.length} characters` });
  return { status: 200, ok: true };
}

// ------------------------------------------------------------------ 05.12 AI activity log
const AI_RE = /(^AI[ _]|\bAI\b|AI_AGENT|Kavya|voice ?bot)/i;
async function aiActivity(viewer, q) {
  const view = atsViewRole(viewer);
  if (['client', 'candidate', 'none'].includes(view)) return { status: 403, error: 'Not part of your access.' };
  const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000);
  const userId = S.isAdmin(viewer) && q.userId ? String(q.userId) : (S.isAdmin(viewer) && q.all ? null : viewer.id);
  const rows = await prisma.auditLog.findMany({
    where: { createdAt: { gte: since }, ...(userId ? { userId } : {}), OR: [{ action: { contains: 'AI' } }, { action: { startsWith: 'AI_AGENT' } }] },
    select: { id: true, userId: true, actorName: true, action: true, entity: true, entityId: true, toValue: true, reason: true, createdAt: true },
    orderBy: { createdAt: 'desc' }, take: 1000,
  });
  const out = rows.filter((r) => AI_RE.test(r.action)).map((r) => ({
    at: r.createdAt, by: r.actorName || '—', userId: r.userId, what: r.action === 'AI_AGENT_ACTION' ? `AI agent: ${(r.toValue || '').slice(0, 160)}` : r.action,
    on: r.entity, onId: r.entityId, detail: r.action === 'AI_AGENT_ACTION' ? (r.reason || null) : (r.toValue || r.reason || null), source: 'audit',
  }));
  if (await tableExists('AiCall')) {
    const c = await prisma.$queryRawUnsafe(`SELECT "id","candidateId","initiatedById","initiatedByName","purpose","status","outcome","createdAt" FROM "AiCall" WHERE "createdAt" >= ?${userId ? ' AND "initiatedById" = ?' : ''} ORDER BY "createdAt" DESC LIMIT 500`, since.toISOString(), ...(userId ? [userId] : [])).catch(() => []);
    const names = new Map((await prisma.candidate.findMany({ where: { id: { in: [...new Set(c.map((x) => x.candidateId).filter(Boolean))] } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    c.forEach((x) => out.push({ at: x.createdAt, by: x.initiatedByName || 'Automatic', userId: x.initiatedById, what: `AI call (${x.purpose || 'call'}): ${x.status}${x.outcome ? ` - ${x.outcome}` : ''}`, on: 'Candidate', onId: x.candidateId, onName: names.get(x.candidateId) || null, source: 'ai-call' }));
  }
  out.sort((a, b) => String(new Date(b.at).toISOString()).localeCompare(String(new Date(a.at).toISOString())));
  const people = S.isAdmin(viewer) ? await prisma.user.findMany({ where: { status: 'Active', role: { notIn: ['CLIENT', 'CANDIDATE'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 1000 }) : [];
  return { status: 200, days, userId, rows: out.slice(0, 1000), people, canPick: S.isAdmin(viewer) };
}

// ------------------------------------------------------------------ 05.11 branches
const BRANCH_KEY = 'branches';
async function branchList() { return (await S.settings.get(BRANCH_KEY, { list: [] })).list || []; }
async function branchOf(entity, ids) {
  const rows = await S.items.list('branch-link', { refType: entity, ...(ids ? { refId: ids } : {}) }, { limit: 20000 });
  return new Map(rows.map((r) => [r.refId, r.status]));
}
async function assignBranch(user, entity, ids, branch) {
  const names = (await branchList()).map((b) => b.name);
  if (branch && !names.includes(branch)) return { status: 400, error: 'Add the branch first (Branches list).' };
  const list = [...new Set((ids || []).map(String))].slice(0, 2000);
  if (!list.length) return { status: 400, error: 'Pick at least one.' };
  if (entity === 'User') {
    await prisma.user.updateMany({ where: { id: { in: list } }, data: { branch: branch || null } });
  } else if (['Client', 'Requirement'].includes(entity)) {
    const cur = await S.items.list('branch-link', { refType: entity, refId: list }, { limit: 20000 });
    for (const c of cur) await S.items.remove(c.id); // eslint-disable-line no-await-in-loop
    if (branch) for (const id of list) await S.items.create('branch-link', { refType: entity, refId: id, status: branch }, user); // eslint-disable-line no-await-in-loop
  } else return { status: 400, error: 'Pick people, clients or requirements.' };
  await logAudit({ userId: user.id, action: `Branch set: ${branch || 'none'}`, entity, entityId: list.slice(0, 5).join(','), toValue: `${list.length} record(s)` });
  return { status: 200, ok: true, count: list.length };
}
async function branchReport(viewer, q) {
  const list = await branchList();
  const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : DR.todayIst().slice(0, 7);
  const clients = await prisma.client.findMany({ where: clientWhere(viewer), select: { id: true, name: true } });
  const reqs = await prisma.requirement.findMany({ where: requirementWhere(viewer), select: { id: true, title: true, clientId: true, status: true } });
  const cB = await branchOf('Client'); const rB = await branchOf('Requirement');
  const users = await prisma.user.findMany({ where: { status: 'Active', role: { notIn: ['CLIENT', 'CANDIDATE'] } }, select: { id: true, name: true, branch: true } });
  const branchOfReq = (r) => rB.get(r.id) || cB.get(r.clientId) || null; // a job follows its client's branch unless set itself
  const start = new Date(`${month}-01T00:00:00+05:30`); const end = new Date(start); end.setMonth(end.getMonth() + 1);
  const apps = reqs.length ? await prisma.applicationStageEvent.findMany({ where: { createdAt: { gte: start, lt: end }, toStage: { in: ['SHARED_WITH_CLIENT', 'JOINED'] }, application: { requirementId: { in: reqs.map((r) => r.id) } } }, select: { toStage: true, application: { select: { requirementId: true } } } }) : [];
  const reqOf = new Map(reqs.map((r) => [r.id, r]));
  const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
  const rows = [...list.map((b) => b.name), null].map((name) => {
    const rq = reqs.filter((r) => branchOfReq(r) === name);
    const ev = apps.filter((e) => branchOfReq(reqOf.get(e.application.requirementId) || {}) === name);
    return {
      branch: name || 'No branch', people: users.filter((u) => (u.branch || null) === name).length, clients: clients.filter((c) => (cB.get(c.id) || null) === name).length,
      liveJobs: rq.filter((r) => LIVE.includes(r.status)).length, jobs: rq.length,
      submissions: ev.filter((e) => e.toStage === 'SHARED_WITH_CLIENT').length, joinings: ev.filter((e) => e.toStage === 'JOINED').length,
    };
  });
  const pick = q.branch ? String(q.branch) : null;
  const detail = pick ? {
    branch: pick,
    people: users.filter((u) => u.branch === pick).map((u) => ({ id: u.id, name: u.name })),
    clients: clients.filter((c) => cB.get(c.id) === pick).map((c) => ({ id: c.id, name: c.name })),
    jobs: reqs.filter((r) => branchOfReq(r) === pick).map((r) => ({ id: r.id, title: r.title, status: r.status })),
  } : null;
  return { status: 200, month, branches: list, rows, detail };
}
// the ids a "Branch" filter keeps (any list can ask): clients, jobs and people of one branch
async function branchScope(viewer, branch) {
  const cB = await branchOf('Client'); const rB = await branchOf('Requirement');
  const reqs = await prisma.requirement.findMany({ where: requirementWhere(viewer), select: { id: true, clientId: true } });
  return {
    clientIds: [...cB.entries()].filter(([, b]) => b === branch).map(([id]) => id),
    requirementIds: reqs.filter((r) => (rB.get(r.id) || cB.get(r.clientId)) === branch).map((r) => r.id),
    userIds: (await prisma.user.findMany({ where: { branch }, select: { id: true } })).map((u) => u.id),
  };
}

// ------------------------------------------------------------------ routes
const router = express.Router();
const send = (res, r) => res.status(r.status || 200).json(r);
router.get('/insights/ratios', S.internal, S.wrap(async (req, res) => send(res, await ratios(req.user, req.query))));
router.get('/insights/coaching', S.internal, S.wrap(async (req, res) => send(res, await coaching(req.user, req.query))));
router.get('/insights/calls', S.internal, S.wrap(async (req, res) => send(res, await calls(req.user, req.query))));
router.put('/insights/calls/:source/:id/transcript', S.writer, S.wrap(async (req, res) => send(res, await saveTranscript(req.user, req.params.source, req.params.id, (req.body || {}).text))));
router.get('/insights/ai-activity', S.internal, S.wrap(async (req, res) => send(res, await aiActivity(req.user, req.query))));

router.get('/branches', S.internal, S.wrap(async (req, res) => res.json({ branches: await branchList(), canEdit: S.isAdmin(req.user) && !req.viewAs })));
router.put('/branches', S.adminOnly, S.wrap(async (req, res) => {
  const raw = Array.isArray((req.body || {}).branches) ? req.body.branches : [];
  const seen = new Set();
  const list = raw.map((b) => ({ name: String((b && b.name) || '').trim().slice(0, 60), city: String((b && b.city) || '').trim().slice(0, 60), company: String((b && b.company) || '').trim().slice(0, 80) }))
    .filter((b) => b.name && !seen.has(b.name.toLowerCase()) && seen.add(b.name.toLowerCase()));
  await S.settings.set(BRANCH_KEY, { list }, req.user);
  await logAudit({ userId: req.user.id, action: 'Branches saved', entity: 'AtsPlusSetting', entityId: BRANCH_KEY, toValue: list.map((b) => b.name).join(', ').slice(0, 300) });
  res.json({ ok: true, branches: list });
}));
router.post('/branches/assign', S.adminOnly, S.wrap(async (req, res) => { const b = req.body || {}; send(res, await assignBranch(req.user, b.entity, b.ids, b.branch ? String(b.branch) : null)); }));
router.get('/branches/report', S.internal, S.wrap(async (req, res) => send(res, await branchReport(req.user, req.query))));
// the people an Admin picks from (branch, seats): active staff logins only
router.get('/people-pick', S.adminOnly, S.wrap(async (req, res) => res.json({ people: await prisma.user.findMany({ where: { status: 'Active', role: { notIn: ['CLIENT', 'CANDIDATE'] } }, select: { id: true, name: true, branch: true, role: true, atsRole: true }, orderBy: { name: 'asc' }, take: 3000 }) })));
router.get('/branches/scope', S.internal, S.wrap(async (req, res) => res.json(await branchScope(req.user, String(req.query.branch || '')))));

module.exports = { router, ratios, coaching, calls, aiActivity, branchReport, branchScope, branchOf, branchList };
