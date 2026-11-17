// ---------------------------------------------------------------------------
// WORK WHILE SOMEONE IS ON LEAVE (founder ATS audit 2026-11-17, Mandatory: "tasks auto-reassigned during leave").
// When a recruiter (any login) is on APPROVED leave today (HRMS LeaveRequest), their open follow-ups due on or before the last day
// of the leave, and their open tasks ending by then, go to whoever covers them:
//   1. the backup their team lead set for them (Follow-ups page > "Leave cover"), else
//   2. the TL named on the follow-up (the requirement's TL), else
//   3. their reporting manager (HRMS),
// as long as that person is an active login and not on leave today. Each move gets a note ("[Leave cover] ..." on the follow-up,
// a comment on the task) and one bell note per covering person. When the person is back (no approved leave today) every item still
// open and still with the cover goes back to them, with a note. Items done while covering stay done.
//
// IDEMPOTENT: every move is a row in the raw table "LeaveCover" (created on first use, no migration). An item with an open row is
// never moved again; a returned row is never returned twice. Running the sweep twice in a row changes nothing the second time.
//
//   run({ today })            one pass (today = 'YYYY-MM-DD', India time by default) -> { moved, returned }
//   startSweep()              a minute after start and every hour; the sandbox runs no timers
//   setBackup(userId, backupUserId, by)  / backupsOf(userIds) / openFor(userId)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const LEAVE_ON = ['Approved', 'Cancellation Requested']; // a cancellation that is only asked for: the leave still stands
const TASK_OPEN = ['Not Started', 'In Progress', 'On Hold'];
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const NOTE = '[Leave cover]';

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LeaveCover" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "entity" TEXT NOT NULL, "entityId" TEXT NOT NULL,
        "fromUserId" TEXT NOT NULL, "fromName" TEXT, "toUserId" TEXT NOT NULL, "toName" TEXT, "leaveId" TEXT, "leaveFrom" TEXT, "leaveTo" TEXT,
        "movedAt" TEXT NOT NULL, "returnedAt" TEXT, "returnNote" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "LeaveCover_open" ON "LeaveCover" ("returnedAt","entity","entityId")');
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LeaveBackup" ("userId" TEXT PRIMARY KEY, "backupUserId" TEXT NOT NULL, "backupName" TEXT,
        "setById" TEXT, "setByName" TEXT, "setAt" TEXT NOT NULL)`);
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

// userId -> { leaveId, from, to } for everyone on approved leave that day (the latest end when two leaves touch).
async function onLeaveOn(today) {
  const rows = await prisma.leaveRequest.findMany({
    where: { status: { in: LEAVE_ON }, fromDate: { lte: today }, toDate: { gte: today }, employee: { userId: { not: null } } },
    select: { id: true, fromDate: true, toDate: true, employee: { select: { userId: true } } },
  });
  const out = new Map();
  rows.forEach((l) => {
    const uid = l.employee && l.employee.userId;
    if (!uid) return;
    const was = out.get(uid);
    if (!was || String(l.toDate) > was.to) out.set(uid, { leaveId: l.id, from: String(l.fromDate).slice(0, 10), to: String(l.toDate).slice(0, 10) });
  });
  return out;
}

async function backupsOf(userIds) {
  await ensure();
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "LeaveBackup" WHERE "userId" IN (${ids.map(() => '?').join(',')})`, ...ids);
  return new Map(rows.map((r) => [r.userId, r]));
}
async function setBackup(userId, backupUserId, by) {
  await ensure();
  if (!backupUserId) {
    await prisma.$executeRawUnsafe('DELETE FROM "LeaveBackup" WHERE "userId" = ?', String(userId));
    return { ok: true, backup: null };
  }
  if (String(backupUserId) === String(userId)) return { error: 'A person cannot be their own backup.' };
  const b = await prisma.user.findUnique({ where: { id: String(backupUserId) }, select: { id: true, name: true, status: true, role: true } });
  if (!b || b.status !== 'Active' || ['CLIENT', 'CANDIDATE'].includes(b.role)) return { error: 'Pick an active TeamLink login as the backup.' };
  await prisma.$executeRawUnsafe(`INSERT INTO "LeaveBackup" ("userId","backupUserId","backupName","setById","setByName","setAt") VALUES (?,?,?,?,?,?)
    ON CONFLICT("userId") DO UPDATE SET "backupUserId" = excluded."backupUserId", "backupName" = excluded."backupName", "setById" = excluded."setById", "setByName" = excluded."setByName", "setAt" = excluded."setAt"`,
  String(userId), b.id, b.name, by && by.id, by && by.name, new Date().toISOString());
  return { ok: true, backup: { id: b.id, name: b.name } };
}

// The reporting manager's login of each person (HRMS Employee.reportingManager).
async function managersOf(userIds) {
  const rows = await prisma.employee.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, reportingManager: { select: { userId: true } } },
  });
  return new Map(rows.map((e) => [e.userId, e.reportingManager ? e.reportingManager.userId : null]));
}

async function openRows() {
  await ensure();
  return prisma.$queryRawUnsafe('SELECT * FROM "LeaveCover" WHERE "returnedAt" IS NULL');
}

let RUNNING = false;
async function run({ today = istToday() } = {}) {
  if (RUNNING) return { moved: 0, returned: 0, skipped: 'already running' };
  RUNNING = true;
  try {
    await ensure();
    const away = await onLeaveOn(today);
    const open = await openRows();
    const openKey = new Set(open.map((r) => `${r.entity}:${r.entityId}`));
    const now = new Date().toISOString();
    let moved = 0;
    let returned = 0;
    const toldCover = new Map(); // cover userId -> { name, count, from: Set }

    // ---- 1. back from leave: everything still with the cover goes back
    const users = new Map((await prisma.user.findMany({
      where: { id: { in: [...new Set([...open.flatMap((r) => [r.fromUserId, r.toUserId]), ...away.keys()])] } },
      select: { id: true, name: true, status: true },
    })).map((u) => [u.id, u]));
    for (const r of open) {
      if (away.has(r.fromUserId)) continue; // eslint-disable-line no-continue
      const back = users.get(r.fromUserId);
      let note = 'returned';
      if (r.entity === 'FollowUp') {
        // eslint-disable-next-line no-await-in-loop
        const f = await prisma.applicationFollowUp.findUnique({ where: { id: r.entityId }, select: { id: true, ownerUserId: true, completedAt: true, notes: true } });
        if (!f) note = 'gone';
        else if (f.completedAt) note = 'done while covering';
        else if (f.ownerUserId !== r.toUserId) note = 'given to someone else meanwhile';
        else if (!back || back.status !== 'Active') note = 'kept: the person is no longer active';
        else {
          // eslint-disable-next-line no-await-in-loop
          await prisma.applicationFollowUp.update({
            where: { id: f.id },
            data: { ownerUserId: back.id, ownerName: back.name, notes: `${f.notes ? `${f.notes}\n` : ''}${NOTE} ${back.name} is back from leave; returned from ${r.toName || 'the cover'} on ${dmy(today)}.`.slice(-4000) },
          });
        }
      } else if (r.entity === 'Task') {
        // eslint-disable-next-line no-await-in-loop
        const t = await prisma.task.findUnique({ where: { id: r.entityId }, select: { id: true, assigneeId: true, status: true } });
        if (!t) note = 'gone';
        else if (!TASK_OPEN.includes(t.status)) note = 'done while covering';
        else if (t.assigneeId !== r.toUserId) note = 'given to someone else meanwhile';
        else if (!back || back.status !== 'Active') note = 'kept: the person is no longer active';
        else {
          // eslint-disable-next-line no-await-in-loop
          await prisma.task.update({ where: { id: t.id }, data: { assigneeId: back.id, assigneeName: back.name } });
          // eslint-disable-next-line no-await-in-loop
          await prisma.taskComment.create({ data: { taskId: t.id, authorId: r.toUserId, authorName: r.toName || 'TeamLink', text: `${NOTE} ${back.name} is back from leave; this task is theirs again.` } }).catch(() => {});
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('UPDATE "LeaveCover" SET "returnedAt" = ?, "returnNote" = ? WHERE "id" = ? AND "returnedAt" IS NULL', now, note, Number(r.id));
      if (note === 'returned') returned += 1;
    }

    // ---- 2. on leave today: their due follow-ups and tasks go to the cover
    if (away.size) {
      const awayIds = [...away.keys()];
      const [backups, managers] = await Promise.all([backupsOf(awayIds), managersOf(awayIds)]);
      const extra = new Set([...[...backups.values()].map((b) => b.backupUserId), ...managers.values()].filter(Boolean));
      const more = await prisma.user.findMany({ where: { id: { in: [...extra].filter((id) => !users.has(id)) } }, select: { id: true, name: true, status: true } });
      more.forEach((u) => users.set(u.id, u));
      const usable = (id, self) => !!id && id !== self && !away.has(id) && users.has(id) && users.get(id).status === 'Active';
      const coverOf = async (self, tlUserId) => {
        const b = backups.get(self);
        for (const id of [b && b.backupUserId, tlUserId, managers.get(self)]) {
          if (id && !users.has(id)) {
            // eslint-disable-next-line no-await-in-loop
            const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
            if (u) users.set(u.id, u);
          }
          if (usable(id, self)) return users.get(id);
        }
        return null;
      };
      const record = async (entity, entityId, self, leave, cover) => {
        await prisma.$executeRawUnsafe('INSERT INTO "LeaveCover" ("entity","entityId","fromUserId","fromName","toUserId","toName","leaveId","leaveFrom","leaveTo","movedAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
          entity, entityId, self.id, self.name, cover.id, cover.name, leave.leaveId, leave.from, leave.to, now);
        openKey.add(`${entity}:${entityId}`);
        moved += 1;
        const t = toldCover.get(cover.id) || { name: cover.name, count: 0, from: new Set() };
        t.count += 1; t.from.add(self.name);
        toldCover.set(cover.id, t);
      };
      for (const [uid, leave] of away) {
        const self = users.get(uid);
        if (!self) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const fus = await prisma.applicationFollowUp.findMany({
          where: { ownerUserId: uid, completedAt: null, dueDate: { not: null, lte: leave.to } },
          select: { id: true, tlUserId: true, notes: true },
        });
        for (const f of fus) {
          if (openKey.has(`FollowUp:${f.id}`)) continue; // eslint-disable-line no-continue
          // eslint-disable-next-line no-await-in-loop
          const cover = await coverOf(uid, f.tlUserId);
          if (!cover) continue; // eslint-disable-line no-continue
          // eslint-disable-next-line no-await-in-loop
          await prisma.applicationFollowUp.update({
            where: { id: f.id },
            data: { ownerUserId: cover.id, ownerName: cover.name, notes: `${f.notes ? `${f.notes}\n` : ''}${NOTE} ${self.name} is on leave ${dmy(leave.from)} to ${dmy(leave.to)}; ${cover.name} covers this until they are back.`.slice(-4000) },
          });
          // eslint-disable-next-line no-await-in-loop
          await record('FollowUp', f.id, self, leave, cover);
        }
        // eslint-disable-next-line no-await-in-loop
        const tasks = await prisma.task.findMany({
          where: { assigneeId: uid, status: { in: TASK_OPEN }, cancelledAt: null, endDate: { not: null, lte: leave.to } },
          select: { id: true },
        });
        for (const t of tasks) {
          if (openKey.has(`Task:${t.id}`)) continue; // eslint-disable-line no-continue
          // eslint-disable-next-line no-await-in-loop
          const cover = await coverOf(uid, null);
          if (!cover) continue; // eslint-disable-line no-continue
          // eslint-disable-next-line no-await-in-loop
          await prisma.task.update({ where: { id: t.id }, data: { assigneeId: cover.id, assigneeName: cover.name } });
          // eslint-disable-next-line no-await-in-loop
          await prisma.taskComment.create({ data: { taskId: t.id, authorId: cover.id, authorName: cover.name, text: `${NOTE} ${self.name} is on leave ${dmy(leave.from)} to ${dmy(leave.to)}; ${cover.name} covers this task until they are back.` } }).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await record('Task', t.id, self, leave, cover);
        }
      }
    }

    if (toldCover.size) {
      const { notifyUsers } = require('./notify'); // eslint-disable-line global-require
      for (const [id, t] of toldCover) {
        // eslint-disable-next-line no-await-in-loop
        await notifyUsers([id], { title: 'Covering for a colleague on leave', message: `${t.count} follow-up(s) / task(s) of ${[...t.from].join(', ')} are with you while they are on leave. They go back when the leave ends.` }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await logAudit({ userId: id, action: 'Leave cover: work handed over', entity: 'User', entityId: id, toValue: `${t.count} item(s) from ${[...t.from].join(', ')}` }).catch(() => {});
      }
    }
    return { moved, returned };
  } finally {
    RUNNING = false;
  }
}

// What one person is covering now (open rows given to them), and what of theirs is with someone else.
async function openFor(userId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "LeaveCover" WHERE "returnedAt" IS NULL AND ("toUserId" = ? OR "fromUserId" = ?) ORDER BY "id" DESC LIMIT 500', String(userId), String(userId));
  const fuIds = rows.filter((r) => r.entity === 'FollowUp').map((r) => r.entityId);
  const taskIds = rows.filter((r) => r.entity === 'Task').map((r) => r.entityId);
  const [fus, tasks] = await Promise.all([
    fuIds.length ? prisma.applicationFollowUp.findMany({ where: { id: { in: fuIds } }, select: { id: true, dueDate: true, nextAction: true, purpose: true, completedAt: true, applicationId: true, candidateId: true, application: { select: { candidate: { select: { name: true } }, requirement: { select: { title: true } } } } } }) : [],
    taskIds.length ? prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, name: true, endDate: true, status: true } }) : [],
  ]);
  const fuOf = new Map(fus.map((f) => [f.id, f]));
  const taskOf = new Map(tasks.map((t) => [t.id, t]));
  return rows.map((r) => {
    const f = r.entity === 'FollowUp' ? fuOf.get(r.entityId) : null;
    const t = r.entity === 'Task' ? taskOf.get(r.entityId) : null;
    return {
      id: Number(r.id), entity: r.entity, entityId: r.entityId, from: { id: r.fromUserId, name: r.fromName }, to: { id: r.toUserId, name: r.toName },
      leaveFrom: r.leaveFrom, leaveTo: r.leaveTo, movedAt: r.movedAt, mine: r.toUserId === String(userId),
      what: f ? [f.purpose || f.nextAction || 'Follow-up', f.application && f.application.candidate ? f.application.candidate.name : null, f.application && f.application.requirement ? f.application.requirement.title : null].filter(Boolean).join(' · ') : t ? t.name : '—',
      due: f ? f.dueDate : t ? t.endDate : null,
      candidateId: f ? f.candidateId : null,
      done: f ? !!f.completedAt : t ? !TASK_OPEN.includes(t.status) : false,
    };
  });
}

let TIMER = null;
function startSweep() {
  if (require('./sandbox').isSandbox() || TIMER) return; // eslint-disable-line global-require
  const tick = () => run().then((r) => { if (r.moved || r.returned) console.log(`[leave-cover] ${r.moved} handed to a cover, ${r.returned} given back`); }).catch((e) => console.error('[leave-cover]', e.message)); // eslint-disable-line no-console
  setTimeout(tick, 90000).unref?.();
  TIMER = setInterval(tick, 60 * 60000);
  if (TIMER.unref) TIMER.unref();
}

module.exports = { run, startSweep, setBackup, backupsOf, openFor, onLeaveOn, managersOf, istToday };
