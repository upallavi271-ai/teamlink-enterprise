// ---------------------------------------------------------------------------
// /api/weekly-ideas — Knowledge Transfer -> AI Weekly Idea Contribution.
//
// This replaces the generic employeeRecordRouter('WEEKLY_IDEA') mount. It is
// the SAME EmployeeRecord store (type: 'WEEKLY_IDEA'), so nothing already
// submitted is orphaned and there is no parallel idea table — it just adds the
// AI screening on write and the quota / leaderboard reads the screen needs.
//
// SCOPE. Weekly Compliance is a people list, so it is scoped like every other
// people list: employeeWhere() from utils/scope.js. An employee sees
// themselves, a TL/STL their department(s), HR and Admin everyone. The
// denominator on the "Met 3-Idea Quota" card is that number — the employees in
// the VIEWER's scope, never the company. Nothing is filtered in the browser.
//
// PERMISSION. One engine, one path: requirePerm on the router, and the same
// scope fragment spread into every query.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { employeeWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const ideaAi = require('../utils/ideaAi');

const TYPE = 'WEEKLY_IDEA';

const router = express.Router();
router.use(requireAuth);
// Knowledge Transfer lives under Performance & Development. Every member of
// staff holds 'view' on it (self-service); utils/scope.js decides WHOSE rows
// they then see.
router.use(requirePerm(null, 'hrms', 'Performance & Development', 'view'));

// Every idea whose employee is inside the viewer's scope.
function ideaWhere(user, extra = {}) {
  return { type: TYPE, employee: employeeWhere(user), ...extra };
}

const EMPLOYEE_SELECT = { id: true, name: true, employeeCode: true, department: true };

function shape(record) {
  return {
    ...record,
    // A convenience for the table: the five criteria in one place, or null.
    scores: record.scoreTotal == null ? null : {
      originality: record.scoreOriginality,
      usefulness: record.scoreUsefulness,
      impact: record.scoreImpact,
      clarity: record.scoreClarity,
      feasibility: record.scoreFeasibility,
      total: record.scoreTotal,
    },
  };
}

// --- Is AI scoring available? ----------------------------------------------
// The screen says so plainly rather than quietly showing blank score columns.
router.get('/ai-status', async (req, res) => {
  res.json(await ideaAi.aiStatus());
});

// --- All Ideas -------------------------------------------------------------
router.get('/', async (req, res) => {
  const where = ideaWhere(req.user, req.query.week ? { weekStart: String(req.query.week) } : {});
  const records = await prisma.employeeRecord.findMany({
    where,
    include: { employee: { select: EMPLOYEE_SELECT } },
    orderBy: { createdAt: 'desc' },
  });
  // The duplicate's original, resolved to a title, for the "duplicate of" cell.
  const originalIds = [...new Set(records.map((r) => r.aiDuplicateOf).filter(Boolean))];
  const originals = originalIds.length
    ? await prisma.employeeRecord.findMany({ where: { id: { in: originalIds } }, select: { id: true, title: true } })
    : [];
  const titleById = new Map(originals.map((o) => [o.id, o.title]));
  res.json(records.map((r) => ({ ...shape(r), duplicateOfTitle: r.aiDuplicateOf ? (titleById.get(r.aiDuplicateOf) || null) : null })));
});

// --- Weekly Compliance + the three stat cards ------------------------------
router.get('/compliance', async (req, res) => {
  const weekStart = req.query.week ? ideaAi.weekStartOf(String(req.query.week)) : ideaAi.weekStartOf(new Date());

  // THE DENOMINATOR: employees in the viewer's scope, from scope.js.
  const employees = await prisma.employee.findMany({
    where: employeeWhere(req.user),
    select: EMPLOYEE_SELECT,
    orderBy: { name: 'asc' },
  });

  const [weekIdeas, totalIdeas, ai] = await Promise.all([
    prisma.employeeRecord.findMany({
      where: ideaWhere(req.user, { weekStart }),
      select: { employeeId: true, aiDuplicate: true },
    }),
    prisma.employeeRecord.count({ where: ideaWhere(req.user) }),
    ideaAi.aiStatus(),
  ]);

  // Only UNIQUE ideas count toward the quota — a duplicate is on file but is
  // not a contribution.
  const uniqueByEmployee = new Map();
  weekIdeas.forEach((i) => {
    if (i.aiDuplicate) return;
    uniqueByEmployee.set(i.employeeId, (uniqueByEmployee.get(i.employeeId) || 0) + 1);
  });

  const rows = employees.map((e) => {
    const count = uniqueByEmployee.get(e.id) || 0;
    return {
      employeeId: e.id,
      name: e.name,
      employeeCode: e.employeeCode,
      department: e.department || '—',
      count,
      quota: ideaAi.QUOTA,
      met: count >= ideaAi.QUOTA,
    };
  });

  res.json({
    weekStart,
    quota: ideaAi.QUOTA,
    inScope: employees.length,
    met: rows.filter((r) => r.met).length,
    totalIdeas,
    ai,
    rows,
  });
});

// --- Leaderboard -----------------------------------------------------------
// Contributors ranked by their SCORED ideas. With no key configured nothing is
// scored, so the score columns read "—" and the ranking falls back to unique
// ideas contributed — which is a real number, not an invented one.
router.get('/leaderboard', async (req, res) => {
  const [records, ai] = await Promise.all([
    prisma.employeeRecord.findMany({
      where: ideaWhere(req.user),
      include: { employee: { select: EMPLOYEE_SELECT } },
    }),
    ideaAi.aiStatus(),
  ]);

  const byEmployee = new Map();
  records.forEach((r) => {
    if (!r.employee) return;
    let row = byEmployee.get(r.employee.id);
    if (!row) {
      row = {
        employeeId: r.employee.id,
        name: r.employee.name,
        employeeCode: r.employee.employeeCode,
        department: r.employee.department || '—',
        ideas: 0, unique: 0, duplicates: 0, scored: 0, totalScore: 0, avgScore: null, weeks: new Set(),
      };
      byEmployee.set(r.employee.id, row);
    }
    row.ideas += 1;
    if (r.aiDuplicate) row.duplicates += 1; else row.unique += 1;
    if (r.weekStart) row.weeks.add(r.weekStart);
    if (r.scoreTotal != null) { row.scored += 1; row.totalScore += r.scoreTotal; }
  });

  const rows = [...byEmployee.values()].map((r) => ({
    ...r,
    weeks: r.weeks.size,
    // Out of 50 (five criteria, 1-10 each). Null when nothing is scored — the
    // UI prints "—" rather than a zero.
    avgScore: r.scored ? Math.round((r.totalScore / r.scored) * 10) / 10 : null,
    totalScore: r.scored ? r.totalScore : null,
  }));

  rows.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)
    || b.unique - a.unique
    || String(a.name).localeCompare(String(b.name)));
  rows.forEach((r, i) => { r.rank = i + 1; });

  res.json({ ai, maxScore: ideaAi.CRITERIA.length * 10, rows });
});

// --- Submit an idea --------------------------------------------------------
// One employee = one user = one login: an idea is always the signed-in user's
// own contribution, whatever their role.
router.post('/', async (req, res) => {
  const employee = req.user.employeeId
    ? await prisma.employee.findUnique({ where: { id: req.user.employeeId }, select: EMPLOYEE_SELECT })
    : null;
  if (!employee) {
    return res.status(400).json({ error: 'No employee record is linked to this login, so an idea cannot be submitted against it.' });
  }

  const title = String(req.body.title || '').trim();
  const detail = String(req.body.detail || '').trim();
  if (!title) return res.status(400).json({ error: 'Enter the idea.' });

  const date = String(req.body.date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const weekStart = ideaAi.weekStartOf(date);

  // THE AI STEP. Duplicate screening + the five scores, or the deterministic
  // fallback when no key is configured. Either way the idea is stored.
  const result = await ideaAi.screen({
    user: req.user,
    idea: { title, detail },
    department: employee.department,
    weekStart,
  });

  const record = await prisma.employeeRecord.create({
    data: {
      type: TYPE,
      employeeId: employee.id,
      title,
      detail: detail || null,
      date,
      weekStart,
      ...ideaAi.toRecordFields(result),
    },
    include: { employee: { select: EMPLOYEE_SELECT } },
  });

  await logAudit({
    userId: req.user.id,
    action: `${TYPE} submitted (${result.method}${result.duplicate ? ', duplicate' : ''})`,
    entity: 'EmployeeRecord',
    entityId: record.id,
  });

  res.status(201).json({
    ...shape(record),
    screening: {
      method: result.method,
      duplicate: result.duplicate,
      similarity: result.similarity,
      note: result.note,
      // Why the fallback ran, when it ran. Never contains key material.
      reason: result.reason || null,
    },
  });
});

module.exports = router;
