// ---------------------------------------------------------------------------
// ATS TEAM TOOLS (founder ATS audit 2026-11-17, Mandatory items) - /api/ats/team-tools
//
//   GET  /compare?ids=a,b,c            2-4 applications of ONE requirement side by side (read-only): experience, current / expected
//                                      CTC, notice, location, skills against the requirement, fit score, stage, last feedback rating
//   POST /slot-check                   { applicationId, date, time, panel, interviewer } -> clashes + the panel's booked slots that day
//                                      (utils/interviewClash.js; the booking itself warns the same way)
//   GET  /shared-views?page=cand       saved filters shared with this login ("my team" / "everyone") + the ones this login shared
//   POST /shared-views                 { page, name, filters, share: team | everyone } share (or update) one of my saved filters
//   DELETE /shared-views/:id           stop sharing (the owner, or an Admin)
//   GET  /leave-cover                  what I cover for people on leave, what of mine is covered, my team's backups
//   PUT  /leave-cover/backup           { userId, backupUserId | null } the TL picks who covers a person on leave
//   POST /leave-cover/run              Admin: run the hourly leave-cover pass now (utils/leaveCover.js)
//
// Every answer stays inside the login's own scope (applicationWhere); the ATS response filter (utils/clientRedact.js) still cuts
// salary for logins without "Candidate Contact & Salary" and the internal scores for the BDE team. External logins get nothing here.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { applicationWhere, atsScopeOf } = require('../utils/scope');
const { isExternalLogin } = require('../utils/permissions');
const { stageLabelFor } = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
const wrap = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
const staffOnly = (req, res, next) => (isExternalLogin(req.user) ? res.status(403).json({ error: 'This is for TeamLink staff.' }) : next());
router.use(staffOnly);
const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role) || ['SUPER_ADMIN', 'ADMIN'].includes(u.atsRole) || !!atsScopeOf(u).global;
const lc = (s) => String(s || '').toLowerCase().trim();
const listOf = (...vals) => [...new Set(vals.flatMap((v) => String(v || '').split(/[,;|/\n]/)).map(lc).filter((x) => x.length >= 2))];

// ---------------------------------------------------------------------------
// COMPARE CANDIDATES FOR ONE JOB
// ---------------------------------------------------------------------------
const avg = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
router.get('/compare', requireProduct('ats'), wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'candidates', 'Applications', 'view'))) return res.status(403).json({ error: 'Seeing applications is not part of your role.' });
  const ids = [...new Set(String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (ids.length < 2 || ids.length > 4) return res.status(400).json({ error: 'Pick 2 to 4 candidates to compare.' });
  const apps = await prisma.application.findMany({
    where: { AND: [{ id: { in: ids } }, applicationWhere(req.user)] },
    select: {
      id: true, stage: true, requirementId: true, matchScore: true, resumeScore: true, interviewRound: true, interviewStatus: true, interviewAt: true, hiringType: true,
      candidate: { select: { id: true, name: true, experienceYears: true, relevantExperienceYears: true, currentSalary: true, expectedSalary: true, noticePeriod: true, location: true, preferredLocation: true, skills: true, technicalSkills: true, goodToHaveSkills: true, specialization: true, currentDesignation: true, currentCompany: true } },
    },
  });
  if (apps.length !== ids.length) return res.status(403).json({ error: 'One or more of these candidates is not in your list.' });
  const reqIds = [...new Set(apps.map((a) => a.requirementId))];
  if (reqIds.length !== 1) return res.status(400).json({ error: 'Compare candidates of one requirement at a time.' });
  const r = await prisma.requirement.findUnique({
    where: { id: reqIds[0] },
    select: { id: true, title: true, reqCode: true, skills: true, goodToHaveSkills: true, experience: true, location: true, specialisation: true, internal: true },
  });
  const mand = listOf(r.skills).length ? listOf(r.skills) : listOf(r.specialisation).slice(0, 1);
  const good = listOf(r.goodToHaveSkills);
  const bde = require('../utils/scope').clientViewRole(req.user) === 'bde'; // eslint-disable-line global-require
  // The last feedback: the newest of the saved feedback (Internal / Client), every round's history, and the panel's scorecards.
  const fbs = await prisma.interviewFeedback.findMany({ where: { applicationId: { in: ids } }, select: { applicationId: true, kind: true, technical: true, communication: true, experience: true, roleFit: true, recommendation: true, updatedAt: true } });
  const pans = await prisma.interviewPanelist.findMany({ where: { applicationId: { in: ids }, feedbackAt: { not: null } }, select: { applicationId: true, round: true, name: true, technical: true, communication: true, experience: true, roleFit: true, recommendation: true, feedbackAt: true } }).catch(() => []);
  let hist = [];
  try {
    const FH = require('../utils/feedbackHistory'); // eslint-disable-line global-require
    hist = (await Promise.all(ids.map((id) => FH.forApplication(id).catch(() => [])))).flat();
  } catch { hist = []; }
  const lastOf = (appId) => {
    const all = [
      ...fbs.filter((f) => f.applicationId === appId).map((f) => ({ kind: f.kind, round: null, by: null, s: [f.technical, f.communication, f.experience, f.roleFit], recommendation: f.recommendation, at: f.updatedAt })),
      ...hist.filter((h) => h && h.applicationId === appId).map((h) => ({ kind: h.kind, round: h.round == null ? null : Number(h.round), by: h.byName || null, s: [h.technical, h.communication, h.experience, h.roleFit].map((x) => (x == null ? null : Number(x))), recommendation: h.recommendation, at: h.at })),
      ...pans.filter((p) => p.applicationId === appId).map((p) => ({ kind: 'Internal', round: p.round, by: p.name, s: [p.technical, p.communication, p.experience, p.roleFit], recommendation: p.recommendation, at: p.feedbackAt })),
    ].filter((x) => !bde || x.kind === 'Client');
    if (!all.length) return null;
    const x = all.sort((a, b) => new Date(b.at) - new Date(a.at))[0];
    return { side: x.kind, round: x.round, by: x.by, rating: avg(x.s), outOf: 5, recommendation: x.recommendation || null, at: x.at };
  };
  const order = new Map(ids.map((id, i) => [id, i]));
  const rows = apps.sort((a, b) => order.get(a.id) - order.get(b.id)).map((a) => {
    const c = a.candidate;
    const have = listOf(c.skills, c.technicalSkills, c.goodToHaveSkills, c.specialization);
    const haveText = have.join(' | ');
    const has = (s) => have.includes(s) || haveText.includes(s);
    const matched = mand.filter(has);
    const goodHit = good.filter(has);
    return {
      applicationId: a.id,
      candidateId: c.id,
      name: c.name,
      currentDesignation: c.currentDesignation || null,
      currentCompany: c.currentCompany || null,
      experienceYears: c.experienceYears ?? null,
      relevantExperienceYears: c.relevantExperienceYears ?? null,
      currentSalary: c.currentSalary || null,
      expectedSalary: c.expectedSalary || null,
      noticePeriod: c.noticePeriod || null,
      location: c.location || null,
      preferredLocation: c.preferredLocation || null,
      skills: c.skills || null,
      skillsMatch: {
        matched, missing: mand.filter((s) => !has(s)), goodToHave: goodHit,
        of: mand.length, pct: mand.length ? Math.round((matched.length / mand.length) * 100) : null,
      },
      matchScore: a.matchScore ?? a.resumeScore ?? null,
      stage: a.stage,
      stageLabel: require('../utils/atsVocab').stepShown(a, stageLabelFor(a.stage, { internal: !!r.internal })), // eslint-disable-line global-require
      ...(require('../utils/atsVocab').leftAfterJoining(a) ? { left: true } : {}), // eslint-disable-line global-require
      interviewRound: a.interviewStatus ? (a.interviewRound || 1) : null,
      lastFeedback: lastOf(a.id),
    };
  });
  return res.json({
    requirement: { id: r.id, title: r.title, reqCode: r.reqCode, skills: mand, goodToHave: good, experience: r.experience || null, location: r.location || null },
    rows,
  });
}));

// ---------------------------------------------------------------------------
// INTERVIEW CLASH CHECK (the booking window asks before booking)
// ---------------------------------------------------------------------------
router.post('/slot-check', requireProduct('ats'), wrap(async (req, res) => {
  const b = req.body || {};
  const out = await require('../utils/interviewClash').check({ // eslint-disable-line global-require
    user: req.user, applicationId: b.applicationId, date: String(b.date || '').slice(0, 10), time: String(b.time || '').slice(0, 5), panel: b.panel, interviewer: b.interviewer,
  });
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  return res.json(out);
}));

// ---------------------------------------------------------------------------
// SHARED SAVED FILTERS. Saved filters live in the browser (components/SavedViews.jsx); one shared with the team is copied here.
// A filter is only a filter: whoever opens a shared one still sees only their own records (the lists scope every row).
//   team      = the owner's team (User.team), else their ATS department; seen by that team and by anyone whose scope covers it
//   everyone  = every TeamLink login
// Raw table "SharedSavedView" (created on first use, no migration).
// ---------------------------------------------------------------------------
let SV_READY = null;
function svEnsure() {
  if (!SV_READY) {
    SV_READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SharedSavedView" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "pageKey" TEXT NOT NULL, "name" TEXT NOT NULL,
        "filters" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "ownerName" TEXT, "share" TEXT NOT NULL, "teamKey" TEXT, "teamLabel" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`);
      await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "SharedSavedView_owner" ON "SharedSavedView" ("pageKey","ownerId","name")');
    })().catch((e) => { SV_READY = null; throw e; });
  }
  return SV_READY;
}
const teamOf = (u) => (u.team ? { key: `team:${lc(u.team)}`, label: u.team } : u.atsDepartment ? { key: `dept:${lc(u.atsDepartment)}`, label: u.atsDepartment } : { key: `user:${u.id}`, label: 'only me' });
function teamKeysSeenBy(u) {
  const keys = new Set([teamOf(u).key]);
  if (u.team) keys.add(`team:${lc(u.team)}`);
  if (u.atsDepartment) keys.add(`dept:${lc(u.atsDepartment)}`);
  String(u.atsScopeTeams || '').split(',').map(lc).filter(Boolean).forEach((t) => keys.add(`team:${t}`));
  String(u.atsScopeDepartments || '').split(',').map(lc).filter(Boolean).forEach((d) => keys.add(`dept:${d}`));
  return keys;
}
const PAGE_RE = /^[a-z0-9_-]{1,30}$/;
const svOut = (r, me) => {
  let filters = {};
  try { filters = JSON.parse(r.filters); } catch { filters = {}; }
  return { id: Number(r.id), page: r.pageKey, name: r.name, filters, share: r.share, teamLabel: r.teamLabel, by: r.ownerName, mine: r.ownerId === me, updatedAt: r.updatedAt };
};
router.get('/shared-views', wrap(async (req, res) => {
  const page = String(req.query.page || '');
  if (!PAGE_RE.test(page)) return res.status(400).json({ error: 'Which page?' });
  await svEnsure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "SharedSavedView" WHERE "pageKey" = ? ORDER BY "updatedAt" DESC LIMIT 500', page);
  const me = req.user.id;
  const admin = isAdmin(req.user);
  const keys = teamKeysSeenBy(req.user);
  const mine = rows.filter((r) => r.ownerId === me).map((r) => svOut(r, me));
  const shared = rows.filter((r) => r.ownerId !== me && (r.share === 'everyone' || (r.share === 'team' && (admin || keys.has(r.teamKey))))).map((r) => svOut(r, me));
  return res.json({ mine, shared, myTeam: teamOf(req.user).label });
}));
router.post('/shared-views', wrap(async (req, res) => {
  const b = req.body || {};
  const page = String(b.page || '');
  const name = String(b.name || '').trim().slice(0, 60);
  const share = ['team', 'everyone'].includes(b.share) ? b.share : null;
  if (!PAGE_RE.test(page)) return res.status(400).json({ error: 'Which page?' });
  if (!name) return res.status(400).json({ error: 'Give the filter a name.' });
  if (!share) return res.status(400).json({ error: 'Share with my team or with everyone?' });
  if (!b.filters || typeof b.filters !== 'object' || Array.isArray(b.filters)) return res.status(400).json({ error: 'There are no filters to share.' });
  const filters = JSON.stringify(b.filters);
  if (filters.length > 8000) return res.status(400).json({ error: 'These filters are too long to share.' });
  await svEnsure();
  const t = teamOf(req.user);
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(`INSERT INTO "SharedSavedView" ("pageKey","name","filters","ownerId","ownerName","share","teamKey","teamLabel","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT("pageKey","ownerId","name") DO UPDATE SET "filters" = excluded."filters", "share" = excluded."share", "teamKey" = excluded."teamKey", "teamLabel" = excluded."teamLabel", "ownerName" = excluded."ownerName", "updatedAt" = excluded."updatedAt"`,
  page, name, filters, req.user.id, req.user.name || null, share, t.key, t.label, now, now);
  const [row] = await prisma.$queryRawUnsafe('SELECT * FROM "SharedSavedView" WHERE "pageKey" = ? AND "ownerId" = ? AND "name" = ?', page, req.user.id, name);
  return res.status(201).json({ ok: share === 'team' ? `Shared with your team (${t.label}).` : 'Shared with everyone.', view: svOut(row, req.user.id) });
}));
router.delete('/shared-views/:id', wrap(async (req, res) => {
  await svEnsure();
  const [row] = await prisma.$queryRawUnsafe('SELECT * FROM "SharedSavedView" WHERE "id" = ?', Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: 'That shared filter is not there.' });
  if (row.ownerId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Only the person who shared it can stop sharing it.' });
  await prisma.$executeRawUnsafe('DELETE FROM "SharedSavedView" WHERE "id" = ?', Number(row.id));
  return res.json({ ok: 'No longer shared.' });
}));

// ---------------------------------------------------------------------------
// LEAVE COVER (utils/leaveCover.js)
// ---------------------------------------------------------------------------
const LC = () => require('../utils/leaveCover'); // eslint-disable-line global-require
// The people whose backup this login sets: an Admin - every active staff login; anyone else - the people who report to them
// in HRMS (Employee.reportingManager), and a TL / STL also the people of their own team.
async function teamOfLead(u) {
  const base = { status: 'Active', role: { notIn: ['CLIENT', 'CANDIDATE'] }, id: { not: u.id } };
  if (isAdmin(u)) return prisma.user.findMany({ where: { ...base, atsAccess: true }, select: { id: true, name: true, atsRole: true, team: true }, orderBy: { name: 'asc' }, take: 400 });
  const or = [{ employee: { reportingManager: { userId: u.id } } }];
  if (['TL', 'STL'].includes(u.atsRole) && u.team) or.push({ team: u.team });
  return prisma.user.findMany({ where: { ...base, OR: or }, select: { id: true, name: true, atsRole: true, team: true }, orderBy: { name: 'asc' }, take: 400 });
}
router.get('/leave-cover', wrap(async (req, res) => {
  const L = LC();
  const today = L.istToday();
  const [items, team, away] = await Promise.all([L.openFor(req.user.id), teamOfLead(req.user), L.onLeaveOn(today)]);
  const backups = await L.backupsOf(team.map((m) => m.id));
  return res.json({
    today,
    covering: items.filter((i) => i.mine),
    coveredForMe: items.filter((i) => !i.mine),
    team: team.map((m) => ({
      id: m.id, name: m.name, role: m.atsRole, team: m.team,
      onLeave: away.has(m.id) ? { from: away.get(m.id).from, to: away.get(m.id).to } : null,
      backup: backups.has(m.id) ? { id: backups.get(m.id).backupUserId, name: backups.get(m.id).backupName } : null,
    })),
    canSetBackup: team.length > 0,
  });
}));
router.put('/leave-cover/backup', wrap(async (req, res) => {
  const b = req.body || {};
  const userId = String(b.userId || '');
  const team = await teamOfLead(req.user);
  if (!team.some((m) => m.id === userId)) return res.status(403).json({ error: 'You can set a backup only for the people in your team.' });
  const out = await LC().setBackup(userId, b.backupUserId ? String(b.backupUserId) : null, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  return res.json(out);
}));
router.post('/leave-cover/run', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can run this now (it runs by itself every hour).' });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String((req.body || {}).today || '')) && process.env.TEST_MODE === '1' ? String(req.body.today) : undefined;
  return res.json(await LC().run(today ? { today } : {}));
}));

module.exports = router;
