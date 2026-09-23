// ---------------------------------------------------------------------------
// POSITIONS — the seats, who has sat in them, and what was done from them.
//
//   GET    /positions                 the seats, with who holds each one now
//   POST   /positions                 create a seat
//   PUT    /positions/:id             rename / move / retire a seat
//   GET    /positions/:id             one seat: tenures + work history
//   POST   /positions/:id/assign      put somebody in it (ends the current tenure)
//   POST   /positions/:id/vacate      end the current tenure, leave it empty
//   GET    /positions/employee/:id    one PERSON's seat history
//
// THE POINT OF THE WHOLE THING is the last two reads. When the person in MED-1
// resigns and somebody else takes the desk, three questions have to stay
// answerable, and they are three different questions:
//
//   what has this SEAT done          -> GET /positions/:id
//   what has this PERSON done        -> GET /positions/employee/:id
//   who was on this seat in March    -> the tenure list on both
//
// Work is attributed by the SNAPSHOTTED CODE, not by a join to the current
// holder. A follow-up made under MED-1 in March stays MED-1 work even after
// MED-1 is renamed, reassigned or retired — which is the only way a history
// is worth reading.
// ---------------------------------------------------------------------------

const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { tenuresOf, positionOfEmployee, today } = require('../utils/positions');
const { employeeWhere, scopeOf } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);

// Seats are part of how the company is set up, so they are held to the same
// permission as the rest of the employee master rather than a new one.
const VIEW = requirePerm(null, 'hrms', 'Employee Management', 'view');
const MANAGE = requirePerm(null, 'hrms', 'Employee Management', 'configure');

// --- the list --------------------------------------------------------------
router.get('/', VIEW, async (req, res, next) => {
  try {
    const where = {};
    if (req.query.department) where.department = req.query.department;
    if (req.query.active === 'true') where.active = true;
    if (req.query.active === 'false') where.active = false;

    const positions = await prisma.position.findMany({ where, orderBy: [{ department: 'asc' }, { code: 'asc' }] });

    // Current holder and tenure count for each, in two queries rather than
    // two per row.
    const ids = positions.map((p) => p.id);
    const assignments = ids.length
      ? await prisma.positionAssignment.findMany({
        where: { positionId: { in: ids } },
        include: { employee: { select: { id: true, name: true, employeeCode: true } } },
        orderBy: { fromDate: 'desc' },
      })
      : [];
    const byPosition = new Map();
    assignments.forEach((a) => {
      if (!byPosition.has(a.positionId)) byPosition.set(a.positionId, []);
      byPosition.get(a.positionId).push(a);
    });

    // How much work carries each seat's code. Counted on the SNAPSHOT, so a
    // retired seat still shows what it did.
    const codes = positions.map((p) => p.code);
    const [reqCounts, evCounts, fuCounts] = await Promise.all([
      prisma.requirement.groupBy({ by: ['positionCode'], _count: true, where: { positionCode: { in: codes } } }),
      prisma.applicationStageEvent.groupBy({ by: ['actorPositionCode'], _count: true, where: { actorPositionCode: { in: codes } } }),
      prisma.applicationFollowUp.groupBy({ by: ['ownerPositionCode'], _count: true, where: { ownerPositionCode: { in: codes } } }),
    ]);
    const n = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r._count]));
    const reqN = n(reqCounts, 'positionCode');
    const evN = n(evCounts, 'actorPositionCode');
    const fuN = n(fuCounts, 'ownerPositionCode');

    res.json(positions.map((p) => {
      const list = byPosition.get(p.id) || [];
      const current = list.find((a) => !a.toDate) || null;
      return {
        ...p,
        holder: current && current.employee
          ? { id: current.employee.id, name: current.employee.name, employeeCode: current.employee.employeeCode, since: current.fromDate }
          : null,
        vacant: !current,
        tenureCount: list.length,
        work: {
          requirements: reqN[p.code] || 0,
          stageMoves: evN[p.code] || 0,
          followUps: fuN[p.code] || 0,
        },
      };
    }));
  } catch (err) { return next(err); }
  return undefined;
});

// --- create / edit ---------------------------------------------------------
router.post('/', MANAGE, async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'A position code is required — MED-1, Non IT-03, EDU BDE 1.' });
    const clash = await prisma.position.findUnique({ where: { code } });
    if (clash) return res.status(409).json({ error: `Position ${code} already exists.` });
    const row = await prisma.position.create({
      data: {
        code,
        name: req.body.name || null,
        department: req.body.department || null,
        team: req.body.team || null,
        notes: req.body.notes || null,
      },
    });
    await logAudit({ userId: req.user.id, action: `Position ${code} created`, entity: 'Position', entityId: row.id });
    return res.status(201).json(row);
  } catch (err) { return next(err); }
});

router.put('/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.position.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Position not found' });
    const data = {};
    ['name', 'department', 'team', 'notes'].forEach((f) => {
      if (req.body[f] !== undefined) data[f] = req.body[f] || null;
    });
    if (req.body.active !== undefined) data.active = !!req.body.active;
    // THE CODE IS NOT EDITABLE HERE. Every work record carries it as a
    // snapshot; renaming the seat would leave that history pointing at a name
    // that no longer exists on any seat. Retire it and make a new one.
    if (req.body.code && req.body.code !== existing.code) {
      return res.status(400).json({
        error: `A position code cannot be changed once work is recorded against it — ${existing.code} is stamped on every requirement, stage move and follow-up made from this seat. Retire this position and create the new one.`,
      });
    }
    const row = await prisma.position.update({ where: { id: existing.id }, data });
    await logAudit({ userId: req.user.id, action: `Position ${existing.code} updated`, entity: 'Position', entityId: row.id });
    return res.json(row);
  } catch (err) { return next(err); }
});

// --- one seat: tenures + what was done from it ----------------------------
router.get('/:id', VIEW, async (req, res, next) => {
  try {
    const position = await prisma.position.findUnique({ where: { id: req.params.id } });
    if (!position) return res.status(404).json({ error: 'Position not found' });
    const tenures = await tenuresOf(position.id);

    // Attributed by the SNAPSHOT, so a renamed or retired seat keeps its work.
    const [requirements, stageEvents, followUps] = await Promise.all([
      prisma.requirement.findMany({
        where: { positionCode: position.code },
        select: { id: true, reqCode: true, title: true, status: true, createdAt: true, client: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.applicationStageEvent.findMany({
        where: { actorPositionCode: position.code },
        select: {
          id: true, toStage: true, action: true, actorName: true, createdAt: true,
          candidate: { select: { id: true, name: true } },
          requirementTitle: true, clientName: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.applicationFollowUp.findMany({
        where: { ownerPositionCode: position.code },
        // ApplicationFollowUp has no `status` column — whether it is done is
        // `completedAt`, and what is owed is `nextAction`. Asking for a field
        // the model does not have is what made this endpoint 500.
        select: {
          id: true, dueDate: true, completedAt: true, nextAction: true,
          outcome: true, contactMode: true, ownerName: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);

    // WHO DID EACH THING. The row carries the actor's name where one was
    // recorded; where it did not, the tenure that covers the date answers it.
    const whoOn = (date) => {
      const d = String(date || '').slice(0, 10);
      const t = tenures.find((x) => !x.vacant && x.fromDate <= d && (!x.toDate || x.toDate >= d));
      return t ? t.employeeName : null;
    };

    return res.json({
      position,
      tenures,
      holder: tenures.find((t) => t.current) || null,
      work: {
        requirements: requirements.map((r) => ({ ...r, byWhom: whoOn(r.createdAt) })),
        stageEvents: stageEvents.map((e) => ({ ...e, byWhom: e.actorName || whoOn(e.createdAt) })),
        followUps: followUps.map((f) => ({ ...f, byWhom: f.ownerName || whoOn(f.createdAt) })),
      },
      totals: {
        requirements: requirements.length,
        stageMoves: stageEvents.length,
        followUps: followUps.length,
      },
    });
  } catch (err) { return next(err); }
});

// --- put somebody in the seat ---------------------------------------------
router.post('/:id/assign', MANAGE, async (req, res, next) => {
  try {
    const position = await prisma.position.findUnique({ where: { id: req.params.id } });
    if (!position) return res.status(404).json({ error: 'Position not found' });
    const employeeId = String(req.body.employeeId || '').trim();
    if (!employeeId) return res.status(400).json({ error: 'Choose the employee taking this position.' });
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const fromDate = String(req.body.fromDate || today()).slice(0, 10);

    // ONE SEAT, ONE OCCUPANT. Whoever is in it is moved out on the day the
    // next person moves in, so the two tenures meet rather than overlap and
    // "who was on MED-1 in March" has exactly one answer.
    const current = await prisma.positionAssignment.findFirst({
      where: { positionId: position.id, toDate: null },
      include: { employee: { select: { name: true } } },
    });
    if (current) {
      if (current.employeeId === employeeId) {
        return res.status(409).json({ error: `${employee.name} already holds ${position.code}.` });
      }
      await prisma.positionAssignment.update({
        where: { id: current.id },
        data: { toDate: fromDate, note: current.note || `Handed over to ${employee.name}` },
      });
    }

    const row = await prisma.positionAssignment.create({
      data: { positionId: position.id, employeeId, fromDate, note: req.body.note || null },
    });
    await logAudit({
      userId: req.user.id,
      action: `${employee.name} assigned to position ${position.code}`,
      entity: 'PositionAssignment',
      entityId: row.id,
      fromValue: current ? (current.employee && current.employee.name) : 'vacant',
      toValue: employee.name,
    });
    return res.status(201).json(row);
  } catch (err) { return next(err); }
});

// --- empty the seat --------------------------------------------------------
router.post('/:id/vacate', MANAGE, async (req, res, next) => {
  try {
    const position = await prisma.position.findUnique({ where: { id: req.params.id } });
    if (!position) return res.status(404).json({ error: 'Position not found' });
    const current = await prisma.positionAssignment.findFirst({
      where: { positionId: position.id, toDate: null },
      include: { employee: { select: { name: true } } },
    });
    if (!current) return res.status(409).json({ error: `${position.code} is already vacant.` });
    const toDate = String(req.body.toDate || today()).slice(0, 10);
    if (toDate < current.fromDate) {
      return res.status(400).json({ error: `They took this position on ${current.fromDate}; it cannot end before that.` });
    }
    const row = await prisma.positionAssignment.update({
      where: { id: current.id },
      data: { toDate, note: req.body.note || current.note },
    });
    await logAudit({
      userId: req.user.id,
      action: `Position ${position.code} vacated`,
      entity: 'PositionAssignment',
      entityId: row.id,
      fromValue: current.employee && current.employee.name,
      toValue: 'vacant',
    });
    return res.json(row);
  } catch (err) { return next(err); }
});

// --- one person's history across seats ------------------------------------
router.get('/employee/:employeeId', VIEW, async (req, res, next) => {
  try {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.employeeId },
      select: { id: true, name: true, employeeCode: true, department: true, employmentStatus: true },
    });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    // Scoped like every other employee read: a Medical TL does not browse an
    // IT recruiter's history.
    const s = scopeOf(req.user);
    if (!s.global) {
      const allowed = await prisma.employee.findFirst({
        where: { AND: [employeeWhere(req.user), { id: employee.id }] },
        select: { id: true },
      });
      if (!allowed) return res.status(403).json({ error: 'This record is outside your access scope' });
    }

    const assignments = await prisma.positionAssignment.findMany({
      where: { employeeId: employee.id },
      include: { position: true },
      orderBy: { fromDate: 'desc' },
    });

    // Everything done from any seat this person has held, counted on the
    // snapshot so a seat they left still shows the work they did in it.
    const codes = [...new Set(assignments.map((a) => a.position && a.position.code).filter(Boolean))];
    const work = codes.length
      ? await Promise.all([
        prisma.requirement.count({ where: { positionCode: { in: codes } } }),
        prisma.applicationStageEvent.count({ where: { actorPositionCode: { in: codes } } }),
        prisma.applicationFollowUp.count({ where: { ownerPositionCode: { in: codes } } }),
      ])
      : [0, 0, 0];

    return res.json({
      employee,
      current: await positionOfEmployee(employee.id),
      history: assignments.map((a) => ({
        assignmentId: a.id,
        code: a.position ? a.position.code : null,
        name: a.position ? a.position.name : null,
        department: a.position ? a.position.department : null,
        fromDate: a.fromDate,
        toDate: a.toDate,
        current: !a.toDate,
        note: a.note,
      })),
      // Work across every seat they have held. NOT the same as "work by this
      // person" — a seat's totals include whoever else sat in it — so the
      // screen labels it as the seats' figures, not theirs.
      seatTotals: { codes, requirements: work[0], stageMoves: work[1], followUps: work[2] },
    });
  } catch (err) { return next(err); }
});

module.exports = router;
