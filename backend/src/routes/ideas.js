// ---------------------------------------------------------------------------
// IDEAS FOR THE R&D TEAM (founder, 2026-10-24):
//   "Every employee in HRMS must post 4 ideas a month for the R&D team. One person's idea must not be taken by
//    another - all the ideas must be unique."
//
//   GET   /api/ideas/mine?month=YYYY-MM   my own ideas (default: this month) + how many are left of the 4
//   POST  /api/ideas/check                is this idea already posted by somebody? (the screen asks while typing; says yes/no only)
//   POST  /api/ideas                      post one idea. Refused when 4 are already posted this month, or when it is a copy of an
//                                         idea anyone posted before (first to post owns the idea)
//   GET   /api/ideas/all?month=&status=&q=   R&D team, HR and Admin only: every idea with its author + who has posted how many
//   PATCH /api/ideas/:id                  R&D team, HR and Admin only: mark Looking at it / Accepted / Not now / Done, with a note
//
// PRIVACY: nobody sees another person's idea except the R&D team, HR and Admin. A "this is a copy" answer never carries the other
// idea's words or author - it only says that it exists. Every idea is audited (posted, reviewed).
// "Same idea" = same title, or the key words of the title + details overlap a lot (utils below: tokens / similar). Filler words and
// plurals do not count, so changing a word or two does not make an idea new.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { NOT_SYSTEM_EMPLOYEE } = require('../utils/systemAccounts');
const { SET } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth);

const QUOTA = 4; // ideas every employee posts in a calendar month (also the most they can post)
const RD_DEPARTMENT = 'R&D';
const STATUSES = ['New', 'Looking at it', 'Accepted', 'Not now', 'Done'];
const EXITED = ['Relieved', 'Exited', 'Exit Process'];
const MIN_TITLE = 5;
const MAX_TITLE = 120;
const MIN_DETAILS = 15;
const MAX_DETAILS = 2000;

// The office's calendar month (IST), the same clock attendance uses.
const monthNow = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
const validMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const named = (v) => (v && v !== 'NONE' ? v : null);
const isHrDesk = (u) => !!u && (SET.HR_DESK.includes(u.role) || SET.HR_DESK.includes(named(u.hrmsRole)));
const isRd = (u) => !!u && String(u.department || '').trim().toLowerCase() === RD_DEPARTMENT.toLowerCase();
const mayReview = (u) => isHrDesk(u) || isRd(u);
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const cleanBlock = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

// ---- "is it the same idea?" -------------------------------------------------------------------------------
const FILLER = new Set(('the and for with that this from have has had are was were will would can could should our your their them they you its into onto over under about than then also just more most some any all not but how what why when where who which use using used make making made give giving gave get getting need needs new idea ideas company team work working employee employees people please like want one two out off per via etc able allow allows').split(' '));
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}
function tokens(text) {
  const out = new Set();
  String(text || '').toLowerCase().replace(/[^a-z0-9ఀ-౿]+/g, ' ').split(' ').forEach((w) => {
    if (w.length < 3 || FILLER.has(w)) return;
    out.add(stem(w));
  });
  return [...out].sort();
}
const keyOf = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9ఀ-౿]+/g, '');
function overlap(a, b) {
  if (!a.length || !b.length) return { jaccard: 0, contain: 0 };
  const B = new Set(b);
  let both = 0;
  a.forEach((t) => { if (B.has(t)) both += 1; });
  return { jaccard: both / (a.length + b.length - both), contain: both / Math.min(a.length, b.length) };
}
// A copy when: the same title, or the title's key words are (nearly) the same, or the whole idea's key words overlap a lot.
function isCopy(cand, other) {
  if (cand.titleKey && cand.titleKey === other.titleKey) return true;
  const t = overlap(cand.titleTokens, other.titleTokens);
  if (cand.titleTokens.length >= 2 && other.titleTokens.length >= 2 && t.jaccard >= 0.8) return true;
  const all = overlap(cand.tokens, other.tokens);
  if (all.jaccard >= 0.6) return true;
  return Math.min(cand.tokens.length, other.tokens.length) >= 6 && all.contain >= 0.85;
}
function candidateOf(title, details) {
  return { titleKey: keyOf(title), titleTokens: tokens(title), tokens: tokens(`${title} ${details}`) };
}
function rowCandidate(r) {
  let toks = [];
  try { toks = JSON.parse(r.tokens || '[]'); } catch { toks = []; }
  return { titleKey: r.titleKey, titleTokens: tokens(r.title), tokens: toks };
}
// The first earlier idea this one copies (anybody's), or null.
async function findCopy(title, details) {
  const cand = candidateOf(title, details);
  if (!cand.tokens.length) return null;
  const rows = await prisma.employeeIdea.findMany({ select: { id: true, userId: true, title: true, titleKey: true, tokens: true }, orderBy: { createdAt: 'asc' } });
  for (const r of rows) if (isCopy(cand, rowCandidate(r))) return r;
  return null;
}

// ---- who is posting ---------------------------------------------------------------------------------------
// An idea belongs to an employee: a login with no employee record (a client, the developer login) has none to post.
async function posterOf(me) {
  if (!me || !me.employeeId) return null;
  const e = await prisma.employee.findFirst({
    where: { AND: [{ id: me.employeeId }, { employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE] },
    select: { id: true, name: true, department: true },
  });
  return e || null;
}
const shapeMine = (r) => ({ id: r.id, title: r.title, details: r.details, month: r.month, status: r.status, rdNote: r.rdNote || null, postedAt: r.createdAt });

function validate(body) {
  const title = clean(body && body.title, MAX_TITLE + 20);
  const details = cleanBlock(body && body.details, MAX_DETAILS + 200);
  if (title.length < MIN_TITLE) return { error: `Give your idea a short name (at least ${MIN_TITLE} letters).`, field: 'title' };
  if (title.length > MAX_TITLE) return { error: `Keep the name under ${MAX_TITLE} letters.`, field: 'title' };
  if (details.length < MIN_DETAILS) return { error: 'Explain the idea in a few words: what is it and how will it help?', field: 'details' };
  if (details.length > MAX_DETAILS) return { error: `Keep the explanation under ${MAX_DETAILS} letters.`, field: 'details' };
  return { title, details };
}

// ---- mine -------------------------------------------------------------------------------------------------
router.get('/mine', async (req, res, next) => {
  try {
    const month = validMonth(req.query.month) ? String(req.query.month) : monthNow();
    const poster = await posterOf(req.user);
    const [rows, thisMonth] = await Promise.all([
      prisma.employeeIdea.findMany({ where: { userId: req.user.id, month }, orderBy: { createdAt: 'desc' } }),
      prisma.employeeIdea.count({ where: { userId: req.user.id, month: monthNow() } }),
    ]);
    res.json({
      month, current: monthNow(), quota: QUOTA, canPost: !!poster, posted: thisMonth, left: Math.max(0, QUOTA - thisMonth),
      mayReview: mayReview(req.user), statuses: STATUSES, ideas: rows.map(shapeMine),
    });
  } catch (err) { next(err); }
});

// ---- is it already taken? ---------------------------------------------------------------------------------
router.post('/check', async (req, res, next) => {
  try {
    const v = validate(req.body);
    if (v.error) return res.json({ ok: false, copy: false });
    const hit = await findCopy(v.title, v.details);
    return res.json({ ok: true, copy: !!hit, own: !!(hit && hit.userId === req.user.id) });
  } catch (err) { return next(err); }
});

// ---- post -------------------------------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const poster = await posterOf(req.user);
    if (!poster) return res.status(403).json({ error: 'Ideas are posted by employees. This login has no employee record.' });
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error, field: v.field });
    const month = monthNow();
    const have = await prisma.employeeIdea.count({ where: { userId: req.user.id, month } });
    if (have >= QUOTA) return res.status(409).json({ error: `You have already posted your ${QUOTA} ideas for this month. Come back next month.`, quotaReached: true });
    const hit = await findCopy(v.title, v.details);
    if (hit) {
      const own = hit.userId === req.user.id;
      return res.status(409).json({
        duplicate: true, own,
        error: own
          ? 'You have already posted an idea like this one. Please post a different idea.'
          : 'Somebody has already posted an idea like this one. Please post a different idea of your own.',
        field: 'title',
      });
    }
    const cand = candidateOf(v.title, v.details);
    const row = await prisma.employeeIdea.create({
      data: {
        userId: req.user.id, employeeId: poster.id, authorName: poster.name, department: poster.department || null,
        title: v.title, details: v.details, month, titleKey: cand.titleKey, tokens: JSON.stringify(cand.tokens),
      },
    });
    await logAudit({ userId: req.user.id, action: 'Idea posted', entity: 'EmployeeIdea', entityId: row.id, toValue: row.title, reason: `${have + 1} of ${QUOTA} for ${month}` });
    // The R&D team is told (in the app). A notice never fails the post.
    try {
      const team = await prisma.employee.findMany({
        where: { AND: [{ department: RD_DEPARTMENT }, { userId: { not: null } }, { employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE] },
        select: { userId: true },
      });
      for (const t of team) {
        if (t.userId === req.user.id) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        await prisma.notification.create({ data: { userId: t.userId, title: `New idea: ${row.title}`.slice(0, 120), message: `${poster.name}${poster.department ? ` (${poster.department})` : ''} posted a new idea. Open Timesheet, Ideas to read it.`, channel: 'In-App', recipient: `idea|${row.id}|${t.userId}`, status: 'Delivered' } });
      }
    } catch (e) { console.error('[ideas] notice failed', e && e.message); } // eslint-disable-line no-console
    return res.status(201).json({ idea: shapeMine(row), posted: have + 1, left: Math.max(0, QUOTA - have - 1), quota: QUOTA });
  } catch (err) { return next(err); }
});

// ---- everything (R&D team, HR, Admin) -----------------------------------------------------------------------
router.get('/all', async (req, res, next) => {
  try {
    if (!mayReview(req.user)) return res.status(403).json({ error: 'Only the R&D team and HR can read everybody\'s ideas.' });
    const month = req.query.month === 'all' ? 'all' : (validMonth(req.query.month) ? String(req.query.month) : monthNow());
    const where = month === 'all' ? {} : { month };
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const q = clean(req.query.q, 80).toLowerCase();
    const [rowsAll, months, people] = await Promise.all([
      prisma.employeeIdea.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000 }),
      prisma.employeeIdea.groupBy({ by: ['month'], _count: { _all: true }, orderBy: { month: 'desc' } }),
      prisma.employee.findMany({
        where: { AND: [{ userId: { not: null } }, { employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE, { user: { is: { status: 'Active' } } }] },
        select: { id: true, userId: true, name: true, employeeCode: true, department: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const counts = new Map();
    if (month !== 'all') rowsAll.forEach((r) => counts.set(r.userId, (counts.get(r.userId) || 0) + 1));
    const rows = rowsAll
      .filter((r) => (!status || r.status === status) && (!q || `${r.title} ${r.details} ${r.authorName} ${r.department || ''}`.toLowerCase().includes(q)))
      .map((r) => ({ ...shapeMine(r), author: r.authorName, department: r.department || '', reviewedBy: r.reviewedBy || null, reviewedAt: r.reviewedAt || null }));
    const byStatus = {};
    rowsAll.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
    res.json({
      month, current: monthNow(), quota: QUOTA, statuses: STATUSES, total: rowsAll.length, byStatus,
      months: months.map((m) => ({ month: m.month, count: m._count._all })),
      rows,
      // who has posted how many in the chosen month (only for one month, not "all")
      people: month === 'all' ? null : people.map((p) => ({
        name: p.name, employeeCode: p.employeeCode || '', department: p.department || '', posted: counts.get(p.userId) || 0,
        missing: Math.max(0, QUOTA - (counts.get(p.userId) || 0)),
      })),
    });
  } catch (err) { next(err); }
});

// ---- review (R&D team, HR, Admin) -----------------------------------------------------------------------------
router.patch('/:id', async (req, res, next) => {
  try {
    if (!mayReview(req.user)) return res.status(403).json({ error: 'Only the R&D team and HR can mark an idea.' });
    const row = await prisma.employeeIdea.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'That idea was not found.' });
    const status = req.body && req.body.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Pick one of: ${STATUSES.join(', ')}.` });
    const note = clean(req.body && req.body.note, 400);
    const data = { status, reviewedBy: req.user.name || req.user.email, reviewedAt: new Date() };
    if (req.body && req.body.note !== undefined) data.rdNote = note || null;
    const out = await prisma.employeeIdea.update({ where: { id: row.id }, data });
    await logAudit({ userId: req.user.id, action: 'Idea reviewed', entity: 'EmployeeIdea', entityId: row.id, fromValue: row.status, toValue: status, reason: note || undefined });
    if (row.userId !== req.user.id && row.status !== status) {
      await prisma.notification.create({ data: { userId: row.userId, title: `Your idea: ${status}`, message: `"${row.title}" is now marked "${status}" by the R&D team.${note ? ` Note: ${note}` : ''}`, channel: 'In-App', recipient: `idea|${row.id}|${row.userId}|${status}`, status: 'Delivered' } }).catch(() => null);
    }
    return res.json({ ...shapeMine(out), author: out.authorName, department: out.department || '', reviewedBy: out.reviewedBy, reviewedAt: out.reviewedAt });
  } catch (err) { return next(err); }
});

module.exports = router;
module.exports.tokens = tokens;
module.exports.isCopy = isCopy;
module.exports.candidateOf = candidateOf;
module.exports.QUOTA = QUOTA;
