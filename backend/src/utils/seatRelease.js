// ---------------------------------------------------------------------------
// A SEAT IS FREED WHEN ITS HOLDER LEAVES (user, 2026-10-10).
//
// "When a person exits, that position is free to assign any new employee."
//
// A seat (Position) outlives the person in it. The moment an employee becomes
// Relieved / Exited (any path: the Edit form, a resignation marked Relieved,
// the offboarding checklist, an import, a bulk update) their open
// PositionAssignment is ENDED — toDate + a note that says why — and the seat is
// vacant: every seat picker lists it and nobody counts the leaver as its holder.
//
//   * Nothing is deleted. The ended tenure is the seat history ("Tulasi Peddi,
//     23 Sep -> 28 Sep, Exited"), kept by the existing SeatHistory screens.
//   * The END DATE is evidence, never a guess: the last working day from the
//     resignation, else the day the status was changed (audit trail), else the
//     last day they were marked present, else the day the record last changed.
//     Today only when a status is being changed right now (the change IS today)
//     or nothing at all is known.
//   * NOTICE PERIOD still holds the seat. PositionAssignment has no "incoming"
//     (future-dated) state that the readers of toDate=null understand, so the
//     seat is NOT pre-assigned: it shows "frees on <date>" and is assignable the
//     day after the last working day (sweepDueExits ends the tenure then).
//   * RE-HIRE: a returning employee simply takes a vacant seat; their old ended
//     tenure stays in history.
//
// HOW IT IS WIRED (one place, so no exit path can be missed):
//   - a Prisma middleware watches Employee writes that set employmentStatus to a
//     leaving state and ends the seat at once (installed when this file loads);
//   - sweepDueExits() is the safety net (imports inside a transaction, scripts,
//     notice periods whose last working day has passed). It runs daily, at
//     start-up and — throttled to once a minute — before the seat screens read.
//
// There is no schema change: the reason lives in PositionAssignment.note
// ("Exited (Relieved) ...") and the end date in toDate.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');
const prisma = require('../db');
const { hasLeft, today } = require('./positions');
const sandbox = require('./sandbox');

const als = new AsyncLocalStorage();
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const iso = (v) => { try { return v ? new Date(v).toISOString().slice(0, 10) : null; } catch { return null; } };

// Who is acting, so the audit row names a person instead of "System". Mounted
// after requireAuth on the routers that change an employee's status.
function actorScope(req, res, next) {
  const u = req && req.user;
  if (!u) return next();
  return als.run({ userId: u.id || null, name: u.name || u.email || null }, next);
}
const actor = () => als.getStore() || {};

const NOTICE_STATUSES = ['notice period'];
const isNotice = (status) => NOTICE_STATUSES.includes(String(status || '').trim().toLowerCase());

// ---- the last working day of somebody on notice ----------------------------
async function lastWorkingDayOf(employeeId) {
  try {
    const r = await prisma.resignationDetail.findFirst({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      select: { approvedLastWorkingDate: true, requestedLastWorkingDate: true },
    });
    const d = r && (r.approvedLastWorkingDate || r.requestedLastWorkingDate);
    if (d && ISO.test(String(d).slice(0, 10))) return { date: String(d).slice(0, 10), source: 'last working day on the resignation' };
  } catch { /* fall through */ }
  try {
    const rec = await prisma.employeeRecord.findFirst({
      where: { employeeId, type: 'RESIGNATION', status: { notIn: ['Withdrawn', 'Rejected'] }, date: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { date: true },
    });
    if (rec && rec.date && ISO.test(String(rec.date).slice(0, 10))) return { date: String(rec.date).slice(0, 10), source: 'last working day on the resignation record' };
  } catch { /* fall through */ }
  return null;
}

// The day this holder's tenure should end, with the evidence in words.
//   live = the status is being changed right now, so "today" is the evidence.
async function endDateFor(employee, assignment, { live = false } = {}) {
  const t = today();
  // A tenure never ends before it began. When the evidence is older than the seat itself (the
  // person was last present before they were put in it) the tenure ends the day it began.
  const pick = (d, source) => (d < assignment.fromDate
    ? { date: assignment.fromDate, source: `${source} (${d}) - before this seat began, so the tenure ends the day it began` }
    : { date: d, source });
  const lwd = await lastWorkingDayOf(employee.id);
  if (lwd) {
    // Early release: marked relieved before the agreed last day -> today.
    return live && lwd.date > t ? pick(t, 'relieved before the last working day') : pick(lwd.date, lwd.source);
  }
  if (live) return pick(t, 'the day their status changed');
  // Not live: the audit trail knows when the status was changed.
  try {
    const au = await prisma.auditLog.findFirst({
      where: { entity: 'Employee', entityId: employee.id, field: 'employmentStatus', toValue: { in: ['Relieved', 'Exited', 'Exit Process', 'Terminated'] } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (au) return pick(iso(au.createdAt), 'the day their status was changed');
  } catch { /* fall through */ }
  try {
    const att = await prisma.attendance.findFirst({
      where: { employeeId: employee.id, status: { in: ['Present', 'Half Day', 'Late', 'On Time'] } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    const d = att && att.date ? String(att.date).slice(0, 10) : null;
    if (d && ISO.test(d)) return pick(d, 'their last day marked present');
  } catch { /* fall through */ }
  if (employee.updatedAt) return pick(iso(employee.updatedAt), 'the day their record last changed');
  return pick(t, 'today (nothing else on record)');
}

// ---- END THE SEAT(S) OF ONE PERSON -----------------------------------------
// Ends every open tenure of this employee. Returns [{ code, fromDate, toDate, source }].
// `onlyIfLeft` (default) does nothing unless the person's status is a leaving one.
async function releaseSeatsOf(employeeId, {
  live = false, onlyIfLeft = true, date = null, source = null, reason = 'Exited', userId = null, actorName = null,
} = {}) {
  if (!employeeId) return [];
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, name: true, employeeCode: true, employmentStatus: true, updatedAt: true },
  });
  if (!employee) return [];
  if (onlyIfLeft && !hasLeft(employee.employmentStatus)) return [];
  const open = await prisma.positionAssignment.findMany({
    where: { employeeId, toDate: null },
    include: { position: { select: { id: true, code: true } } },
  });
  const out = [];
  for (const a of open) {
    // eslint-disable-next-line no-await-in-loop
    const end = date ? { date: date < a.fromDate ? a.fromDate : date, source: source || 'chosen date' } : await endDateFor(employee, a, { live });
    const note = `${reason} - now ${employee.employmentStatus}. Seat freed ${end.date}, from ${end.source}.${a.note ? ` ${a.note}` : ''}`.slice(0, 500);
    // eslint-disable-next-line no-await-in-loop
    await prisma.positionAssignment.update({ where: { id: a.id }, data: { toDate: end.date, note } });
    const who = userId || actor().userId || null;
    const whoName = actorName || actor().name || 'System';
    // eslint-disable-next-line no-await-in-loop
    await prisma.auditLog.createMany({
      data: [
        {
          userId: who, actorName: whoName, action: `Seat ${a.position.code} is vacant - ${employee.name} is ${employee.employmentStatus}`,
          entity: 'Position', entityId: a.position.id, fromValue: employee.name, toValue: `vacant from ${end.date}`, reason: end.source,
        },
        {
          userId: who, actorName: whoName, action: `Seat ${a.position.code} ended - ${employee.employmentStatus}`,
          entity: 'Employee', entityId: employee.id, field: 'position', fieldLabel: 'Position',
          fromValue: a.position.code, toValue: `(none) from ${end.date}`, reason: end.source,
        },
      ],
    }).catch(() => {});
    out.push({ code: a.position.code, fromDate: a.fromDate, toDate: end.date, source: end.source });
  }
  return out;
}

// ---- THE SAFETY NET --------------------------------------------------------
// 1) holders who have already left but still hold a tenure  - the BACKLOG;
// 2) notice periods whose last working day is behind us (tenure ends on that day).
//
// The BACKLOG (people who left BEFORE this feature existed and still sit in a seat) is real
// history: on the real database it is fixed ONLY by scripts/free-exited-seats.js (dry run ->
// approval -> backup -> --apply -> --undo), never silently by a request. Until then the seat
// screens already treat such a holder as gone (hasLeft) - they show the seat vacant and offer it.
// Everything that happens AFTER the feature is live is event-driven (the middleware below) and
// rule 2. The sandbox and tests may sweep the backlog too (backlog = true).
const sweepsBacklog = () => process.env.SEAT_SWEEP_BACKLOG === '1' || sandbox.isSandbox();
async function sweepDueExits({ backlog = sweepsBacklog() } = {}) {
  const open = await prisma.positionAssignment.findMany({
    where: { toDate: null },
    include: { employee: { select: { id: true, name: true, employmentStatus: true } } },
  });
  const freed = [];
  const ids = new Set();
  if (backlog) {
    for (const a of open) {
      if (!a.employee) continue;
      if (hasLeft(a.employee.employmentStatus)) ids.add(a.employee.id);
    }
  }
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    freed.push(...(await releaseSeatsOf(id)).map((r) => ({ ...r, employeeId: id })));
  }
  const t = today();
  const noticeIds = [...new Set(open.filter((a) => a.employee && isNotice(a.employee.employmentStatus)).map((a) => a.employee.id))];
  for (const id of noticeIds) {
    // eslint-disable-next-line no-await-in-loop
    const lwd = await lastWorkingDayOf(id);
    if (lwd && lwd.date < t) {
      // eslint-disable-next-line no-await-in-loop
      freed.push(...(await releaseSeatsOf(id, { onlyIfLeft: false, date: lwd.date, source: lwd.source, reason: 'Notice ended' })).map((r) => ({ ...r, employeeId: id })));
    }
  }
  return freed;
}

let lastSweep = 0;
let sweeping = null;
// Cheap, throttled: call before reading seats so the screen never shows a
// holder who has already left. Never throws.
async function ensureFresh(maxAgeMs = 60 * 1000) {
  if (Date.now() - lastSweep < maxAgeMs) return;
  if (!sweeping) {
    sweeping = sweepDueExits()
      .catch((e) => { console.error('[seatRelease] sweep failed:', e && e.message); }) // eslint-disable-line no-console
      .finally(() => { lastSweep = Date.now(); sweeping = null; });
  }
  await sweeping;
}

let timer = null;
function startSweep() {
  if (timer || process.env.SEAT_SWEEP_MS === '0') return;
  const every = Number(process.env.SEAT_SWEEP_MS) || 6 * 60 * 60 * 1000;
  setTimeout(() => ensureFresh(0), 20 * 1000).unref();
  timer = setInterval(() => ensureFresh(0), every);
  timer.unref();
}

// ---- WHO HOLDS A SEAT, AS THE PICKERS SEE IT -------------------------------
// For one open tenure: is the seat really taken, or is it free / about to be?
//   { state: 'held' | 'vacant' | 'notice', freesOn }
async function seatStateOf(assignment) {
  const e = assignment && assignment.employee;
  if (!assignment || assignment.toDate) return { state: 'vacant', freesOn: null };
  if (!e) return { state: 'held', freesOn: null };
  if (hasLeft(e.employmentStatus)) return { state: 'vacant', freesOn: null };
  if (isNotice(e.employmentStatus)) {
    const lwd = await lastWorkingDayOf(e.id);
    return { state: 'notice', freesOn: lwd ? lwd.date : null };
  }
  return { state: 'held', freesOn: null };
}

// ---- THE MIDDLEWARE: any Employee write that sets a leaving status ---------
function statusIn(data) {
  if (!data || data.employmentStatus === undefined) return undefined;
  const v = data.employmentStatus;
  return typeof v === 'object' && v !== null ? v.set : v;
}
let installed = false;
function install() {
  if (installed || typeof prisma.$use !== 'function') return;
  installed = true;
  prisma.$use(async (params, next) => {
    if (params.model !== 'Employee' || !['update', 'updateMany', 'upsert'].includes(params.action)) return next(params);
    const args = params.args || {};
    const st = statusIn(params.action === 'upsert' ? args.update : args.data);
    if (st === undefined || !hasLeft(st)) return next(params);
    // updateMany: remember who is hit, before the write.
    let ids = [];
    if (params.action === 'updateMany') {
      try { ids = (await prisma.employee.findMany({ where: args.where || {}, select: { id: true } })).map((x) => x.id); } catch { ids = []; }
    }
    const result = await next(params);
    if (params.action !== 'updateMany' && result && result.id) ids = [result.id];
    if (!ids.length) return result;
    if (params.runInTransaction) {
      // A transaction holds the database; ending seats from here would wait on it. Exactly
      // these people are freed a few seconds on (not the whole backlog).
      setTimeout(async () => {
        for (const id of ids) {
          try { await releaseSeatsOf(id, { live: true }); } catch (e) { console.error('[seatRelease] could not free the seat of %s: %s', id, e && e.message); } // eslint-disable-line no-console
        }
      }, 3000).unref();
      return result;
    }
    for (const id of ids) {
      try { await releaseSeatsOf(id, { live: true }); } catch (e) { console.error('[seatRelease] could not free the seat of %s: %s', id, e && e.message); } // eslint-disable-line no-console
    }
    return result;
  });
}
install();

module.exports = {
  actorScope, releaseSeatsOf, sweepDueExits, ensureFresh, startSweep, seatStateOf,
  lastWorkingDayOf, endDateFor, isNotice, install,
};
