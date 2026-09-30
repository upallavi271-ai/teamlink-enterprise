// ---------------------------------------------------------------------------
// REWARDS & RECOGNITION → NOMINATION (hrms-24 §13).
//
// A nomination is a REQUEST, not an award:
//
//   Nominated → Pending Review → Approved / Rejected → Awarded
//
// WHO DOES WHAT, and which engine action each one rides on:
//
//   NOMINATE  TL, STL, Manager, Assistant Manager, HR, Super Admin / Admin.
//             Asked as hrms / Performance & Development / create OR approve.
//             A Manager / AM is view-only (§3/§4) except APPROVE on the chain
//             features — and a nomination is exactly that kind of request: it
//             decides nothing, it is sent to review. So a nomination rides on
//             'approve' for them (the one action they hold here) and on
//             'create' for everyone else; no view-only rule is weakened.
//   REVIEW    HR, Super Admin / Admin, Manager, Assistant Manager — hrms /
//             Performance & Development / approve. Nobody reviews their own
//             nomination (a Super Admin may, and it is recorded as such).
//   AWARD     HR, Super Admin / Admin — hrms / Performance & Development /
//             create. Awarding WRITES the recognition (an EmployeeRecord of
//             type RECOGNITION, the feed and leaderboard's own row), which is
//             a create, so a view-only Manager / AM approves but does not award.
//
// SCOPE. Every nominee, every reference read and every decision is checked
// against utils/scope.js employeeWhere() in the database — a TL nominates and
// reads the performance of their team only; out-of-scope ids are refused.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, can } = require('../middleware/auth');
const { employeeWhere, OUT_OF_SCOPE } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const attachments = require('../utils/attachments');

const router = express.Router();
router.use(requireAuth);

const TYPES = [
  'Best Performer', 'Excellent Attendance', 'Outstanding Contribution', 'Client Appreciation',
  'Team Contribution', 'Innovation', 'Target Achievement', 'Leadership', 'Other',
];
const STATUSES = ['Nominated', 'Pending Review', 'Approved', 'Rejected', 'Awarded'];
const NOMINATOR_ROLES = ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR', 'SUPER_ADMIN', 'ADMIN'];
const REVIEWER_ROLES = ['HR', 'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER'];
const AWARDER_ROLES = ['HR', 'SUPER_ADMIN', 'ADMIN'];
const EXITED = ['Relieved', 'Exited', 'Exit Process'];
const DENIED = { error: "This isn't included in your role's permissions" };

const roleOf = (u) => u.hrmsRole || u.role;
const isSuper = (u) => ['SUPER_ADMIN'].includes(roleOf(u)) || u.role === 'SUPER_ADMIN';
const P = (u, action) => can(u, 'hrms', 'hrms', 'Performance & Development', action);

async function rights(user) {
  const role = roleOf(user);
  const [create, approve] = await Promise.all([P(user, 'create'), P(user, 'approve')]);
  return {
    nominate: NOMINATOR_ROLES.includes(role) && (create || approve),
    review: REVIEWER_ROLES.includes(role) && approve,
    award: AWARDER_ROLES.includes(role) && create,
  };
}

// The employee, if (and only if) this login's scope reaches them — asked of
// the database, so the seniority filter inside employeeWhere() applies too.
async function inScopeEmployee(user, id) {
  if (!id) return null;
  return prisma.employee.findFirst({ where: { AND: [{ id: String(id) }, employeeWhere(user)] } });
}

function parseHistory(raw) {
  try { const h = JSON.parse(raw || '[]'); return Array.isArray(h) ? h : []; } catch { return []; }
}
function withEvent(row, user, status, note) {
  const h = parseHistory(row && row.history);
  h.push({ at: new Date().toISOString(), by: user.name || user.email, byId: user.id, status, note: note || null });
  return JSON.stringify(h);
}
function present(n) {
  const { docFile, ...rest } = n;
  return { ...rest, hasDocument: !!docFile, history: parseHistory(n.history) };
}
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

// Everyone who may review, for the in-app "a nomination is waiting" prompt.
async function reviewerIds() {
  const users = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ hrmsRole: { in: ['HR', 'SUPER_ADMIN', 'ADMIN'] } }, { role: { in: ['SUPER_ADMIN', 'ADMIN'] } }] },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

// ---- What this login may do, and whom it may nominate -----------------------
router.get('/meta', async (req, res, next) => {
  try {
    const r = await rights(req.user);
    let nominees = [];
    if (r.nominate) {
      const rows = await prisma.employee.findMany({
        where: { AND: [employeeWhere(req.user), { employmentStatus: { notIn: EXITED } }] },
        select: { id: true, employeeCode: true, name: true, department: true, designation: true },
        orderBy: { name: 'asc' },
      });
      nominees = rows.filter((e) => e.id !== req.user.employeeId);
    }
    res.json({ types: TYPES, statuses: STATUSES, rights: r, nominees });
  } catch (err) { next(err); }
});

// ---- List --------------------------------------------------------------------
// Nominators and reviewers see the nominations about people in their scope
// (plus the ones they raised). A login with no HRMS scope sees only its OWN
// awarded nominations — a pending one is not the nominee's to read.
router.get('/', async (req, res, next) => {
  try {
    const r = await rights(req.user);
    const and = [];
    if (req.user.caps && req.user.caps.hrmsSelfOnly && !r.nominate && !r.review) {
      and.push({ nomineeId: req.user.employeeId || '__none__', status: 'Awarded' });
    } else {
      const where = employeeWhere(req.user);
      if (Object.keys(where).length) {
        const ids = (await prisma.employee.findMany({ where, select: { id: true } })).map((e) => e.id);
        and.push({ OR: [{ nomineeId: { in: ids } }, { nominatedById: req.user.id }] });
      }
    }
    const q = req.query;
    if (q.status) and.push({ status: String(q.status) });
    if (q.type) and.push({ recognitionType: String(q.type) });
    if (q.department) and.push({ nomineeDepartment: String(q.department) });
    if (q.mine === '1') and.push({ nominatedById: req.user.id });
    if (q.q) {
      const s = String(q.q);
      and.push({ OR: [{ nomineeName: { contains: s } }, { nomineeCode: { contains: s } }, { reason: { contains: s } }, { nominatedByName: { contains: s } }] });
    }
    const rows = await prisma.recognitionNomination.findMany({ where: and.length ? { AND: and } : {}, orderBy: { createdAt: 'desc' } });
    res.json({ rights: r, rows: rows.map(present) });
  } catch (err) { next(err); }
});

// ---- Performance reference for ONE nominee (in scope only) -----------------
router.get('/reference/:employeeId', async (req, res, next) => {
  try {
    const r = await rights(req.user);
    if (!r.nominate && !r.review) return res.status(403).json(DENIED);
    const e = await inScopeEmployee(req.user, req.params.employeeId);
    if (!e) return res.status(403).json(OUT_OF_SCOPE);
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const [targets, tasks, timesheets, attendance, lms, recognitions, nominations, reviews] = await Promise.all([
      prisma.employeeRecord.findMany({
        where: { employeeId: e.id, type: 'TARGET' }, orderBy: { createdAt: 'desc' }, take: 8,
        select: { id: true, title: true, amount: true, achieved: true, unit: true, progressPct: true, status: true, date: true },
      }),
      e.userId ? prisma.task.findMany({
        where: { assigneeId: e.userId }, select: { status: true, reviewState: true, endDate: true, completedAt: true },
      }) : [],
      prisma.employeeRecord.findMany({ where: { employeeId: e.id, type: 'TIMESHEET', date: { gte: since } }, select: { hours: true } }),
      prisma.attendance.findMany({ where: { employeeId: e.id, date: { gte: since } }, select: { status: true } }),
      prisma.courseAssignment.findMany({
        where: { employeeId: e.id }, select: { completed: true, completedAt: true, score: true, course: { select: { title: true } } },
      }),
      prisma.employeeRecord.findMany({
        where: { employeeId: e.id, type: 'RECOGNITION' }, orderBy: { createdAt: 'desc' }, take: 10,
        select: { title: true, points: true, date: true, fromName: true },
      }),
      prisma.recognitionNomination.findMany({
        where: { nomineeId: e.id }, orderBy: { createdAt: 'desc' }, take: 10,
        select: { id: true, recognitionType: true, status: true, nominationDate: true, nominatedByName: true },
      }),
      prisma.performanceReview.findMany({
        where: { employeeId: e.id }, orderBy: { createdAt: 'desc' }, take: 4,
        select: { period: true, score: true, band: true, recommendation: true, approvalStatus: true },
      }),
    ]);
    const count = (rows, key) => rows.reduce((m, x) => { const k = x[key] || '—'; m[k] = (m[k] || 0) + 1; return m; }, {});
    const done = tasks.filter((t) => t.status === 'Completed');
    res.json({
      employee: { id: e.id, employeeCode: e.employeeCode, name: e.name, department: e.department, designation: e.designation },
      windowFrom: since,
      targets,
      tasks: {
        total: tasks.length,
        completed: done.length,
        approved: tasks.filter((t) => t.reviewState === 'Approved').length,
        open: tasks.filter((t) => ['Not Started', 'In Progress', 'On Hold'].includes(t.status)).length,
        onTime: done.filter((t) => t.endDate && t.completedAt && new Date(t.completedAt).toISOString().slice(0, 10) <= t.endDate).length,
      },
      timesheet: { entries: timesheets.length, hours: timesheets.reduce((s, t) => s + (Number(t.hours) || 0), 0) },
      attendance: { days: attendance.length, byStatus: count(attendance, 'status') },
      lms: {
        assigned: lms.length,
        completed: lms.filter((c) => c.completed).length,
        recent: lms.filter((c) => c.completed).slice(0, 5).map((c) => ({ course: c.course && c.course.title, completedAt: c.completedAt, score: c.score })),
      },
      recognitions,
      nominations,
      reviews,
    });
  } catch (err) { next(err); }
});

// ---- One nomination ------------------------------------------------------------
async function reachable(req, id) {
  const n = await prisma.recognitionNomination.findUnique({ where: { id } });
  if (!n) return { status: 404, body: { error: 'Nomination not found' } };
  if (n.nominatedById === req.user.id) return { n };
  const e = await inScopeEmployee(req.user, n.nomineeId);
  if (e) {
    const r = await rights(req.user);
    if (r.nominate || r.review || (n.nomineeId === req.user.employeeId && n.status === 'Awarded')) return { n };
  }
  return { status: 403, body: OUT_OF_SCOPE };
}

router.get('/:id', async (req, res, next) => {
  try {
    const found = await reachable(req, req.params.id);
    if (!found.n) return res.status(found.status).json(found.body);
    res.json(present(found.n));
  } catch (err) { next(err); }
});

// ---- Nominate ------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const r = await rights(req.user);
    if (!r.nominate) return res.status(403).json(DENIED);
    const b = req.body || {};
    const e = await inScopeEmployee(req.user, b.nomineeId);
    if (!e) return res.status(403).json({ error: 'That employee is outside your scope — you can nominate only people you look after.' });
    if (e.id === req.user.employeeId) return res.status(400).json({ error: 'You cannot nominate yourself.' });
    if (EXITED.includes(e.employmentStatus)) return res.status(400).json({ error: `${e.name} has left the company.` });
    if (!TYPES.includes(b.recognitionType)) return res.status(400).json({ field: 'recognitionType', error: 'Pick a recognition type.' });
    const reason = String(b.reason || '').trim();
    if (reason.length < 10) return res.status(400).json({ field: 'reason', error: 'Give the reason for the nomination (at least 10 characters).' });
    if (b.recognitionType === 'Other' && !String(b.otherType || '').trim()) {
      return res.status(400).json({ field: 'otherType', error: 'Say what the recognition is for.' });
    }
    const date = ymd(b.nominationDate) || new Date().toISOString().slice(0, 10);
    const now = new Date();
    const first = withEvent(null, req.user, 'Nominated', null);
    const history = withEvent({ history: first }, req.user, 'Pending Review', 'Sent for review');
    const n = await prisma.recognitionNomination.create({
      data: {
        nomineeId: e.id,
        nomineeCode: e.employeeCode,
        nomineeName: e.name,
        nomineeDepartment: e.department,
        nomineeDesignation: e.designation,
        recognitionType: b.recognitionType === 'Other' ? `Other — ${String(b.otherType).trim().slice(0, 80)}` : b.recognitionType,
        reason: reason.slice(0, 4000),
        achievements: String(b.achievements || '').trim().slice(0, 4000) || null,
        nominationDate: date,
        comments: String(b.comments || '').trim().slice(0, 4000) || null,
        recommendedReward: String(b.recommendedReward || '').trim().slice(0, 200) || null,
        status: 'Pending Review',
        nominatedById: req.user.id,
        nominatedByName: req.user.name || req.user.email,
        history,
        createdAt: now,
      },
    });
    await logAudit({
      userId: req.user.id, action: 'Recognition nomination submitted', entity: 'RecognitionNomination', entityId: n.id,
      toValue: `${n.nomineeName} · ${n.recognitionType}`,
    });
    await notifyUsers(await reviewerIds(), {
      title: `Nomination to review — ${n.nomineeName}`,
      message: `${n.nominatedByName} nominated ${n.nomineeName} (${n.nomineeDepartment || '—'}) for ${n.recognitionType}.`,
      exceptUserId: req.user.id,
    });
    res.status(201).json(present(n));
  } catch (err) { next(err); }
});

// ---- Supporting document (multipart; utils/attachments.js) -------------------
router.post('/:id/document', async (req, res, next) => {
  try {
    const found = await reachable(req, req.params.id);
    if (!found.n) return res.status(found.status).json(found.body);
    const n = found.n;
    if (n.nominatedById !== req.user.id && !isSuper(req.user)) return res.status(403).json({ error: 'Only the nominator can attach the supporting document.' });
    if (!['Nominated', 'Pending Review'].includes(n.status)) return res.status(400).json({ error: 'The nomination has already been decided.' });
    let parsed;
    try { parsed = await attachments.parseMultipart(req); } catch (err) {
      return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' });
    }
    let stored;
    try { stored = attachments.store(parsed.file); } catch (err) {
      return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not store the upload.' });
    }
    if (n.docFile) attachments.remove(n.docFile);
    const updated = await prisma.recognitionNomination.update({
      where: { id: n.id },
      data: { docFile: stored.billFile, docName: stored.billName, docMime: stored.billMime, docSize: stored.billSize },
    });
    await logAudit({ userId: req.user.id, action: 'Nomination document attached', entity: 'RecognitionNomination', entityId: n.id, toValue: stored.billName });
    res.json(present(updated));
  } catch (err) { next(err); }
});

router.get('/:id/document', async (req, res, next) => {
  try {
    const found = await reachable(req, req.params.id);
    if (!found.n) return res.status(found.status).json(found.body);
    const n = found.n;
    if (!n.docFile) return res.status(404).json({ error: 'No document attached' });
    const full = attachments.resolveStored(n.docFile);
    if (!full) return res.status(404).json({ error: 'The attached file is no longer on the server' });
    res.setHeader('Content-Type', n.docMime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(n.docName)}"`);
    return res.sendFile(full);
  } catch (err) { return next(err); }
});

// ---- Review: Approve / Reject ------------------------------------------------
router.post('/:id/decision', async (req, res, next) => {
  try {
    const r = await rights(req.user);
    if (!r.review) return res.status(403).json(DENIED);
    const found = await reachable(req, req.params.id);
    if (!found.n) return res.status(found.status).json(found.body);
    const n = found.n;
    // The nominee must be in the REVIEWER's scope, not merely the nominator's.
    if (!(await inScopeEmployee(req.user, n.nomineeId))) return res.status(403).json(OUT_OF_SCOPE);
    const decision = String((req.body || {}).decision || '');
    if (!['Approved', 'Rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be Approved or Rejected' });
    const remarks = String((req.body || {}).remarks || '').trim();
    if (decision === 'Rejected' && remarks.length < 3) return res.status(400).json({ field: 'remarks', error: 'Say why the nomination is rejected.' });
    if (!['Nominated', 'Pending Review'].includes(n.status)) return res.status(400).json({ error: `This nomination is already ${n.status}.` });
    const own = n.nominatedById === req.user.id;
    if (own && !isSuper(req.user)) return res.status(403).json({ error: 'You cannot review your own nomination.' });
    const note = own ? `${remarks || ''}${remarks ? ' · ' : ''}Super Admin decided their own nomination (override)` : (remarks || null);
    const updated = await prisma.recognitionNomination.update({
      where: { id: n.id },
      data: {
        status: decision, decision, remarks: remarks || null, reviewedAt: new Date(),
        reviewerId: req.user.id, reviewerName: req.user.name || req.user.email,
        history: withEvent(n, req.user, decision, note),
      },
    });
    await logAudit({
      userId: req.user.id, action: `Recognition nomination ${decision.toLowerCase()}`, entity: 'RecognitionNomination', entityId: n.id,
      fromValue: n.status, toValue: decision, reason: remarks || null,
    });
    await notifyUsers([n.nominatedById], {
      title: `Nomination ${decision.toLowerCase()} — ${n.nomineeName}`,
      message: `${req.user.name || 'A reviewer'} ${decision.toLowerCase()} your ${n.recognitionType} nomination${remarks ? `: ${remarks}` : '.'}`,
      exceptUserId: req.user.id,
    });
    res.json(present(updated));
  } catch (err) { next(err); }
});

// ---- Award ---------------------------------------------------------------------
router.post('/:id/award', async (req, res, next) => {
  try {
    const r = await rights(req.user);
    if (!r.award) return res.status(403).json(DENIED);
    const found = await reachable(req, req.params.id);
    if (!found.n) return res.status(found.status).json(found.body);
    const n = found.n;
    if (!(await inScopeEmployee(req.user, n.nomineeId))) return res.status(403).json(OUT_OF_SCOPE);
    if (n.status !== 'Approved') return res.status(400).json({ error: 'Only an Approved nomination can be awarded.' });
    const b = req.body || {};
    const awardDate = ymd(b.awardDate) || new Date().toISOString().slice(0, 10);
    const points = Number.isFinite(Number(b.points)) && b.points !== '' && b.points != null ? Math.max(0, Math.round(Number(b.points))) : null;
    const note = String(b.remarks || '').trim() || null;
    const result = await prisma.$transaction(async (tx) => {
      // THE AWARD IS A RECOGNITION ROW — the feed and leaderboard read it
      // unchanged, exactly as a Give Recognition would have written it.
      const rec = await tx.employeeRecord.create({
        data: {
          type: 'RECOGNITION',
          employeeId: n.nomineeId,
          title: n.recognitionType,
          detail: `${n.reason}${n.recommendedReward ? ` · Reward: ${n.recommendedReward}` : ''}`,
          date: awardDate,
          points,
          fromName: `${n.nominatedByName} (nominated) · awarded by ${req.user.name || req.user.email}`,
          status: 'Open',
        },
      });
      const updated = await tx.recognitionNomination.update({
        where: { id: n.id },
        data: {
          status: 'Awarded', awardedAt: new Date(`${awardDate}T12:00:00`), awardedById: req.user.id,
          awardedByName: req.user.name || req.user.email, awardRecordId: rec.id,
          history: withEvent(n, req.user, 'Awarded', note),
        },
      });
      return updated;
    });
    await logAudit({
      userId: req.user.id, action: 'Recognition awarded from nomination', entity: 'RecognitionNomination', entityId: n.id,
      fromValue: 'Approved', toValue: 'Awarded',
    });
    const nominee = await prisma.employee.findUnique({ where: { id: n.nomineeId }, select: { userId: true } });
    await notifyUsers([nominee && nominee.userId, n.nominatedById], {
      title: `Recognition awarded — ${n.recognitionType}`,
      message: `${n.nomineeName} has been awarded ${n.recognitionType}${n.recommendedReward ? ` (${n.recommendedReward})` : ''}.`,
      exceptUserId: req.user.id,
    });
    res.json(present(result));
  } catch (err) { next(err); }
});

module.exports = router;
