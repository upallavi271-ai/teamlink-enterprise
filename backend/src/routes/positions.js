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
//   GET    /positions/history         every seat of a department, holder by holder
//   GET    /positions/structure       the org tree: Department -> Team -> TL -> recruiters
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
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { tenuresOf, positionOfEmployee, today } = require('../utils/positions');
const { employeeWhere, scopeOf, hrmsGlobal } = require('../utils/scope');
const { descendants } = require('../utils/positionScope');

// YYYY-MM-DD minus one day, in UTC so no timezone can move it.
function dayBefore(iso) {
  const t = new Date(`${iso}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

const router = express.Router();
router.use(requireAuth);

// Seats are part of how the company is set up, so they are held to the same
// permission as the rest of the employee master rather than a new one.
const VIEW = requirePerm(null, 'hrms', 'Employee Management', 'view');
const MANAGE = requirePerm(null, 'hrms', 'Employee Management', 'configure');

// --- structure fields ------------------------------------------------------
// kind + reportsToId are what the ATS scope engine reads (utils/
// positionScope.js), so a bad value is refused here rather than silently
// widening or narrowing somebody's scope.
const KINDS = ['TL', 'RECRUITER', 'STL', 'OTHER'];
async function structureFields(body, existing = null) {
  const data = {};
  if (body.kind !== undefined) {
    const kind = String(body.kind || 'OTHER').toUpperCase();
    if (!KINDS.includes(kind)) return { error: `Kind must be one of ${KINDS.join(', ')}.` };
    data.kind = kind;
  }
  if (body.reportsToId !== undefined) {
    const to = body.reportsToId || null;
    if (to) {
      if (existing && to === existing.id) return { error: 'A position cannot report to itself.' };
      const parent = await prisma.position.findUnique({ where: { id: to } });
      if (!parent) return { error: 'The position it reports to no longer exists.' };
      if (!['TL', 'STL'].includes(parent.kind)) return { error: `${parent.code} is not a TL or STL position, so nothing can report to it.` };
      if (existing) {
        // No loops: the new parent must not sit underneath this seat.
        const all = await prisma.position.findMany({ select: { id: true, reportsToId: true } });
        if (descendants([existing.id], all).has(to)) return { error: `${parent.code} already reports to ${existing.code} — that would be a loop.` };
      }
    }
    data.reportsToId = to;
  }
  return { data };
}

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
    const structure = await structureFields(req.body);
    if (structure.error) return res.status(400).json({ error: structure.error });
    const row = await prisma.position.create({
      data: {
        code,
        name: req.body.name || null,
        department: req.body.department || null,
        team: req.body.team || null,
        notes: req.body.notes || null,
        ...structure.data,
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
    const structure = await structureFields(req.body, existing);
    if (structure.error) return res.status(400).json({ error: structure.error });
    Object.assign(data, structure.data);
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

// ---------------------------------------------------------------------------
// SEAT HISTORY — per department, every seat's holders in order: who sat in
// MED-1 from when to when, who replaced them, and what each did while there
// (applications they worked, and how many of those joined). The same answer
// for HRMS (Employee Management) and ATS (Recruiter & BDE), so this read is
// open to either permission.
// ---------------------------------------------------------------------------
async function SEAT_HISTORY_VIEW(req, res, next) {
  try {
    const ok = (await can(req.user, null, 'hrms', 'Employee Management', 'view'))
      || (await can(req.user, 'ats', 'recruiterbde', 'Team View', 'view'));
    if (!ok) return res.status(403).json({ error: "This isn't included in your role's permissions" });
    return next();
  } catch (err) { return next(err); }
}

router.get('/history', SEAT_HISTORY_VIEW, async (req, res, next) => {
  try {
    const s = scopeOf(req.user);
    const where = { active: true };
    if (req.query.department) where.department = String(req.query.department);
    // A department-scoped lead sees their own departments' seats only.
    if (!s.global && s.departments.length) {
      where.department = req.query.department && s.departments.includes(req.query.department)
        ? req.query.department : { in: s.departments };
    }
    // A seat-holder (recruiter / TL) sees only the seats in their own scope —
    // their own seat, a TL their team's — never the whole department. HR and
    // the HRMS-wide roles are not narrowed; anyone else without a seat sees none.
    if (!s.global && !hrmsGlobal(req.user)) {
      const role = s.atsRole || s.hrmsRole;
      if (s.positions) where.code = { in: s.positions.positionCodes };
      else if (!['STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(role)) where.id = '__none__';
    }
    const positions = await prisma.position.findMany({ where, orderBy: [{ department: 'asc' }, { code: 'asc' }] });
    const ids = positions.map((p) => p.id);
    const [assignments, followUps] = await Promise.all([
      prisma.positionAssignment.findMany({
        where: { positionId: { in: ids } },
        include: { employee: { select: { id: true, name: true, employeeCode: true, employmentStatus: true } } },
        orderBy: { fromDate: 'asc' },
      }),
      // What was worked from each seat, dated by when it was worked.
      prisma.applicationFollowUp.findMany({
        where: { ownerPositionCode: { in: positions.map((p) => p.code) } },
        select: { ownerPositionCode: true, createdAt: true, applicationId: true, application: { select: { stage: true } } },
      }),
    ]);
    const workBy = new Map();
    followUps.forEach((f) => {
      if (!workBy.has(f.ownerPositionCode)) workBy.set(f.ownerPositionCode, []);
      workBy.get(f.ownerPositionCode).push(f);
    });
    // A TL seat's work is its TEAM's: every application worked under that TL
    // while they held the seat.
    const isTlSeat = (p) => p.kind === 'TL' || /(^|[\s-])TL$/i.test(p.code);
    const tlNames = [...new Set(assignments.filter((a) => isTlSeat(positions.find((p) => p.id === a.positionId) || {}))
      .map((a) => a.employee?.name).filter(Boolean))];
    const teamWork = tlNames.length
      ? await prisma.applicationFollowUp.findMany({
        where: { tlName: { in: tlNames } },
        select: { tlName: true, createdAt: true, applicationId: true, application: { select: { stage: true } } },
      })
      : [];
    const todayIso = today();
    const days = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1);
    const seats = positions.map((p) => {
      // A seat opened and closed on the same day was never really held.
      const tenures = assignments.filter((a) => a.positionId === p.id && !(a.toDate && a.toDate <= a.fromDate)).map((a) => {
        const to = a.toDate || todayIso;
        const pool = isTlSeat(p) ? teamWork.filter((f) => f.tlName === a.employee?.name) : (workBy.get(p.code) || []);
        const worked = pool.filter((f) => {
          const d = f.createdAt.toISOString().slice(0, 10);
          return d >= a.fromDate && d <= to;
        });
        const appIds = new Set(worked.map((f) => f.applicationId));
        const joined = new Set(worked.filter((f) => f.application && ['JOINED', 'HIRED'].includes(f.application.stage)).map((f) => f.applicationId));
        return {
          employeeId: a.employee?.id || null,
          name: a.employee?.name || '—',
          employeeCode: a.employee?.employeeCode || null,
          employmentStatus: a.employee?.employmentStatus || null,
          from: a.fromDate,
          to: a.toDate,
          current: !a.toDate,
          days: days(a.fromDate, to),
          applications: appIds.size,
          joined: joined.size,
          note: a.note || null,
        };
      });
      return { id: p.id, code: p.code, name: p.name, department: p.department, tenures };
    });
    res.json({ seats, departments: [...new Set(positions.map((p) => p.department))].sort() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// THE STRUCTURE — Department -> Team -> TL seat -> recruiter seats -> holder,
// with every previous holder of every seat. The same kind / reportsToId the
// ATS scope engine reads, so what this tree shows IS who sees what.
//
//   GET /positions/structure
//   { departments: [{ department, stls: [{ ...seat, teams: [...] }],
//                     teams: [{ team, tl: seat, recruiters: [seat] }],
//                     outside: [seat], other: [seat], retired: [seat] }] }
// ---------------------------------------------------------------------------
router.get('/structure', VIEW, async (req, res, next) => {
  try {
    const positions = await prisma.position.findMany({ orderBy: [{ department: 'asc' }, { code: 'asc' }] });
    const ids = positions.map((p) => p.id);
    const codes = positions.map((p) => p.code);
    const [assignments, reqCounts, evCounts, fuCounts] = await Promise.all([
      prisma.positionAssignment.findMany({
        where: { positionId: { in: ids } },
        include: { employee: { select: { id: true, name: true, employeeCode: true, employmentStatus: true, userId: true } } },
        orderBy: [{ fromDate: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.requirement.groupBy({ by: ['positionCode'], _count: true, where: { positionCode: { in: codes } } }),
      prisma.applicationStageEvent.groupBy({ by: ['actorPositionCode'], _count: true, where: { actorPositionCode: { in: codes } } }),
      prisma.applicationFollowUp.groupBy({ by: ['ownerPositionCode'], _count: true, where: { ownerPositionCode: { in: codes } } }),
    ]);
    const n = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r._count]));
    const reqN = n(reqCounts, 'positionCode');
    const evN = n(evCounts, 'actorPositionCode');
    const fuN = n(fuCounts, 'ownerPositionCode');
    const byPosition = new Map();
    assignments.forEach((a) => {
      if (!byPosition.has(a.positionId)) byPosition.set(a.positionId, []);
      byPosition.get(a.positionId).push(a);
    });
    const person = (a) => ({
      assignmentId: a.id,
      employeeId: a.employee ? a.employee.id : a.employeeId,
      name: a.employee ? a.employee.name : '—',
      employeeCode: a.employee ? a.employee.employeeCode : null,
      employmentStatus: a.employee ? a.employee.employmentStatus : null,
      hasLogin: !!(a.employee && a.employee.userId),
      from: a.fromDate,
      to: a.toDate,
      note: a.note || null,
    });
    const node = (p) => {
      const list = byPosition.get(p.id) || [];
      const current = list.find((a) => !a.toDate) || null;
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        kind: p.kind,
        department: p.department,
        team: p.team,
        active: p.active,
        notes: p.notes,
        reportsToId: p.reportsToId,
        holder: current ? person(current) : null,
        vacant: !current,
        previous: list.filter((a) => a.toDate).map(person),
        work: { requirements: reqN[p.code] || 0, stageMoves: evN[p.code] || 0, followUps: fuN[p.code] || 0 },
      };
    };

    const childrenOf = (id) => positions.filter((p) => p.reportsToId === id);
    const placed = new Set();
    const teamOf = (tl) => {
      placed.add(tl.id);
      const recruiters = childrenOf(tl.id).filter((p) => p.kind !== 'TL' && p.kind !== 'STL');
      recruiters.forEach((r) => placed.add(r.id));
      return { team: tl.team || null, tl: node(tl), recruiters: recruiters.map(node) };
    };

    const departments = [...new Set(positions.map((p) => p.department || '—'))].sort();
    const out = departments.map((department) => {
      const inDept = positions.filter((p) => (p.department || '—') === department);
      const stls = inDept.filter((p) => p.kind === 'STL').map((stl) => {
        placed.add(stl.id);
        return { ...node(stl), teams: childrenOf(stl.id).filter((p) => p.kind === 'TL').map(teamOf) };
      });
      const teams = inDept.filter((p) => p.kind === 'TL' && !placed.has(p.id)).map(teamOf)
        .sort((a, b) => String(a.team || '').localeCompare(String(b.team || '')));
      const rest = inDept.filter((p) => !placed.has(p.id));
      return {
        department,
        stls,
        teams,
        // Held or open seats that are meant to be in a team but report to
        // nobody — the ones that need a decision.
        outside: rest.filter((p) => p.active && ['RECRUITER', 'TL', 'STL'].includes(p.kind)).map(node),
        // Seats that are not part of a team structure at all (BDE, HR, …).
        other: rest.filter((p) => p.active && !['RECRUITER', 'TL', 'STL'].includes(p.kind)).map(node),
        retired: rest.filter((p) => !p.active).map(node),
      };
    });
    // Structured departments first, then the rest alphabetically.
    out.sort((a, b) => (Number(!!(b.teams.length || b.stls.length)) - Number(!!(a.teams.length || a.stls.length)))
      || a.department.localeCompare(b.department));
    return res.json({ departments: out });
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return res.status(400).json({ error: 'Pick the date the new person takes the position.' });

    // THE HANDOVER. "Employees are replaceable, positions are not."
    //
    // ONE SEAT, ONE OCCUPANT, NO OVERLAP. The outgoing holder's tenure ends
    // the DAY BEFORE the new holder's begins, so "who was on MED-1 on the
    // 12th" has exactly one answer and a record dated that day is attributed
    // to one person. Nobody is deleted and nothing is re-attributed: the
    // outgoing person's follow-ups, stage moves and requirements keep the
    // seat code and their name exactly as they were recorded, and what is
    // recorded from the handover date on carries the new holder.
    const current = await prisma.positionAssignment.findFirst({
      where: { positionId: position.id, toDate: null },
      include: { employee: { select: { name: true } } },
    });
    if (current && current.employeeId === employeeId) {
      return res.status(409).json({ error: `${employee.name} already holds ${position.code}.` });
    }
    if (current && fromDate < current.fromDate) {
      return res.status(400).json({
        error: `${current.employee ? current.employee.name : 'The current holder'} took ${position.code} on ${current.fromDate}; the handover cannot be dated before that.`,
      });
    }
    // The day before, or the same day when the outgoing tenure began that
    // very day (a same-day correction).
    const closeOn = (startedOn) => (fromDate > startedOn ? dayBefore(fromDate) : startedOn);

    const closed = [];
    await prisma.$transaction(async (tx) => {
      if (current) {
        await tx.positionAssignment.update({
          where: { id: current.id },
          data: { toDate: closeOn(current.fromDate), note: current.note || `Handed over to ${employee.name}` },
        });
        closed.push({ code: position.code, name: current.employee && current.employee.name, toDate: closeOn(current.fromDate) });
      }
      // A person sits in one seat at a time: moving them here ends the seat
      // they are leaving (optional — "endOtherSeats": false keeps it).
      if (req.body.endOtherSeats !== false) {
        const others = await tx.positionAssignment.findMany({
          where: { employeeId, toDate: null, positionId: { not: position.id } },
          include: { position: { select: { code: true } } },
        });
        for (const o of others) {
          // eslint-disable-next-line no-await-in-loop
          await tx.positionAssignment.update({
            where: { id: o.id },
            data: { toDate: fromDate > o.fromDate ? dayBefore(fromDate) : o.fromDate, note: o.note || `Moved to ${position.code}` },
          });
          closed.push({ code: o.position && o.position.code, name: employee.name, toDate: fromDate > o.fromDate ? dayBefore(fromDate) : o.fromDate });
        }
      }
    });

    const row = await prisma.positionAssignment.create({
      data: { positionId: position.id, employeeId, fromDate, note: req.body.note || null },
    });
    await logAudit({
      userId: req.user.id,
      action: `${employee.name} assigned to position ${position.code} from ${fromDate}`,
      entity: 'PositionAssignment',
      entityId: row.id,
      fromValue: current ? (current.employee && current.employee.name) : 'vacant',
      toValue: employee.name,
    });
    return res.status(201).json({ ...row, closed });
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
