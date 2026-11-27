// ---------------------------------------------------------------------------
// AN APPROVER WHO LEFT: THE REQUESTS WAITING ON THEM MOVE BY THEMSELVES (founder 2026-11-27, after an exited Education Team Lead
// kept 20 leave / late coming requests that nobody could take over: "move waiting approvals automatically when a lead exits").
//
// utils/approvalWorkflow.js already re-checks a step when it BECOMES current (activateNext), so a request that has not reached the
// leaver yet finds the current holder by itself. A step that was ALREADY Pending on them stayed there for ever. This sweep handles
// exactly that.
//
// WHO HAS "LEFT": the approver's employment is Exited / Relieved / Terminated (utils/leftLogin.js - those people cannot sign in), or
// their login is switched off / gone. A person who is on notice, in exit process, on leave or whose role changed still holds their
// requests: nothing is taken from somebody who can still act.
//
// WHERE A REQUEST GOES, in this order:
//   1. whoever holds that level for the applicant NOW (the same resolveChain a new request uses: their own TL, else another active TL
//      of the department, and so on), unless that person already acted or is waiting elsewhere on this request;
//   2. nobody holds the level: the step is Skipped with the reason and the next required level takes it;
//   3. no next level either: it is left as it is (a Super Admin can decide any request directly). A request is NEVER approved, rejected
//      or completed by this file.
// Closed requests are not touched. Every move is written to the audit log and each new approver gets ONE bell note with the count.
//
//   run({ dryRun })   one pass; returns { moved, skipped, kept, items }
//   startSweep()      45 seconds after start, then every 5 minutes (APPROVER_LEFT_SWEEP_MS; 0 = off). The test sandbox runs no timers.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const workflow = require('./approvalWorkflow');
const { LEFT } = require('./leftLogin');
const { logAudit } = require('./audit');
const { pushNotification } = require('./notify');

const ACTOR = 'System (approver has left)';
const ENTITY = { leave: 'LeaveRequest', regularization: 'AttendanceRegularization', latePermission: 'LatePermission', resignation: 'EmployeeRecord' };

// Why this login can no longer act, or null when it still can.
function whyGone(user) {
  if (!user) return 'the login no longer exists';
  if (user.role !== 'SUPER_ADMIN' && user.employee && LEFT.includes(user.employee.employmentStatus)) return 'has left';
  if ((user.status || 'Active') !== 'Active') return 'the login is switched off';
  return null;
}

// Every Pending step whose approver can no longer act.
async function stuckSteps() {
  const pending = await prisma.approvalStep.findMany({ where: { status: 'Pending', approverUserId: { not: null } }, orderBy: [{ workflow: 'asc' }, { recordId: 'asc' }, { seq: 'asc' }] });
  if (!pending.length) return [];
  const ids = [...new Set(pending.map((s) => s.approverUserId))];
  const users = [];
  for (let i = 0; i < ids.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    users.push(...await prisma.user.findMany({ where: { id: { in: ids.slice(i, i + 400) } }, select: { id: true, status: true, role: true, employee: { select: { employmentStatus: true } } } }));
  }
  const byId = new Map(users.map((u) => [u.id, u]));
  return pending.map((step) => ({ step, why: whyGone(byId.get(step.approverUserId)) })).filter((x) => x.why);
}

// A step left behind on a request that is already finished is not anybody's work: it is not moved.
async function isClosed(step) {
  if (step.workflow === 'leave') {
    const l = await prisma.leaveRequest.findUnique({ where: { id: step.recordId }, select: { status: true } });
    return !l || ['Approved', 'Rejected', 'Cancelled', 'Withdrawn'].includes(l.status);
  }
  if (step.workflow === 'regularization') {
    const r = await prisma.attendanceRegularization.findUnique({ where: { id: step.recordId }, select: { status: true } });
    return !r || r.status !== 'Pending';
  }
  if (step.workflow === 'latePermission') {
    const r = await prisma.latePermission.findUnique({ where: { id: step.recordId }, select: { status: true } });
    return !r || r.status !== 'Pending';
  }
  return false;
}

// Whose request it is: the Applied row of the chain, else the record's own employee.
async function applicantOf(step, steps) {
  const applied = steps.find((s) => s.status === 'Applied' && s.approverUserId);
  if (applied) {
    const e = await prisma.employee.findUnique({ where: { userId: applied.approverUserId } });
    if (e) return e;
  }
  const table = { leave: 'leaveRequest', regularization: 'attendanceRegularization', latePermission: 'latePermission', resignation: 'employeeRecord' }[step.workflow];
  if (!table) return null;
  const row = await prisma[table].findUnique({ where: { id: step.recordId }, select: { employeeId: true } });
  return row && row.employeeId ? prisma.employee.findUnique({ where: { id: row.employeeId } }) : null;
}

// What should happen to one stuck step. Reads only.
async function planFor({ step, why }, lad) {
  const base = { step, why };
  if (await isClosed(step)) return { ...base, action: 'keep', reason: 'the request is already closed' };
  if (!lad.byLevel[step.level]) return { ...base, action: 'keep', reason: 'this level is not in the Organization Structure' };
  const steps = await prisma.approvalStep.findMany({ where: { workflow: step.workflow, recordId: step.recordId }, orderBy: { seq: 'asc' } });
  const applicant = await applicantOf(step, steps);
  if (!applicant) return { ...base, action: 'keep', reason: 'whose request this is could not be read' };
  const taken = new Set(steps.filter((s) => s.id !== step.id && ['Applied', 'Approved', 'Pending'].includes(s.status)).map((s) => s.approverUserId).filter(Boolean));
  const person = (await workflow.resolveChain(applicant, lad))[step.level];
  if (person && person.user && person.user.id !== step.approverUserId && !taken.has(person.user.id)) return { ...base, applicant, action: 'move', person };
  const later = steps.some((s) => s.status === 'Waiting' && s.mode === workflow.MODE_REQUIRED && s.seq > step.seq);
  if (later) return { ...base, applicant, action: 'skip' };
  return { ...base, applicant, action: 'keep', reason: 'nobody else holds this level and there is no later level' };
}

const audit = (step, from, to, why) => logAudit({
  actorName: ACTOR, action: 'Approver changed', entity: ENTITY[step.workflow] || step.workflow, entityId: step.recordId,
  fromValue: `${from} (${step.level})`, toValue: to, reason: `${from} ${why}`,
});

let RUNNING = false;
async function run({ dryRun = false } = {}) {
  const out = { moved: 0, skipped: 0, kept: 0, items: [] };
  if (RUNNING) return out;
  RUNNING = true;
  try {
    const stuck = await stuckSteps();
    if (!stuck.length) return out;
    const lad = await workflow.ladder();
    const bells = new Map(); // new approver -> { count, from: Set }
    for (const item of stuck) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const plan = await planFor(item, lad);
        const { step, why, person } = plan;
        const from = step.approverName || 'The approver';
        const line = { stepId: step.id, workflow: step.workflow, recordId: step.recordId, level: step.level, from, why, action: plan.action, to: person ? person.name : null, applicant: plan.applicant ? `${plan.applicant.employeeCode} ${plan.applicant.name}` : null, reason: plan.reason || null };
        out.items.push(line);
        if (plan.action === 'keep') { out.kept += 1; continue; } // eslint-disable-line no-continue
        if (dryRun) { if (plan.action === 'move') out.moved += 1; else out.skipped += 1; continue; } // eslint-disable-line no-continue
        // only while it is still waiting on that same person: somebody may have decided or reassigned it a moment ago
        const mine = { id: step.id, status: 'Pending', approverUserId: step.approverUserId };
        const now = new Date();
        if (plan.action === 'move') {
          const note = [step.note, `Moved from ${from} (${why}) to ${person.name}`].filter(Boolean).join(' | ');
          // eslint-disable-next-line no-await-in-loop
          const r = await prisma.approvalStep.updateMany({
            where: mine,
            data: {
              approverUserId: person.user.id, approverName: person.name, approverDepartment: person.department || null, note,
              activatedAt: now, dueAt: step.slaHours == null ? null : new Date(now.getTime() + Number(step.slaHours) * 3600000),
            },
          });
          if (!r.count) continue; // eslint-disable-line no-continue
          out.moved += 1;
          const b = bells.get(person.user.id) || { count: 0, from: new Set() };
          b.count += 1; b.from.add(from); bells.set(person.user.id, b);
          await audit(step, from, `${person.name} (${step.level})`, why); // eslint-disable-line no-await-in-loop
        } else {
          const label = workflow.labelFor(step.level).label;
          // eslint-disable-next-line no-await-in-loop
          const r = await prisma.approvalStep.updateMany({ where: mine, data: { status: 'Skipped', note: `Skipped — nobody active holds ${label} now (${from} ${why})` } });
          if (!r.count) continue; // eslint-disable-line no-continue
          const next = await workflow.activateNext(step.workflow, step.recordId); // eslint-disable-line no-await-in-loop
          if (!next) {
            // nobody left to take it: put the step back rather than complete the request silently
            await prisma.approvalStep.update({ where: { id: step.id }, data: { status: 'Pending', note: step.note } }); // eslint-disable-line no-await-in-loop
            line.action = 'keep'; line.reason = 'no later level could take it'; out.kept += 1;
            continue; // eslint-disable-line no-continue
          }
          line.to = next.approverName || workflow.labelFor(next.level).label;
          out.skipped += 1;
          if (next.approverUserId) { const b = bells.get(next.approverUserId) || { count: 0, from: new Set() }; b.count += 1; b.from.add(from); bells.set(next.approverUserId, b); }
          await audit(step, from, `${line.to} (${next.level})`, why); // eslint-disable-line no-await-in-loop
        }
      } catch (err) {
        console.error('[approver-left] step %s: %s', item.step.id, err.message); // eslint-disable-line no-console
      }
    }
    for (const [userId, b] of bells) {
      // eslint-disable-next-line no-await-in-loop
      await pushNotification({
        userId,
        title: 'Approvals moved to you',
        message: `${b.count} request${b.count === 1 ? '' : 's'} that ${b.count === 1 ? 'was' : 'were'} waiting for ${[...b.from].join(', ')} ${b.count === 1 ? 'is' : 'are'} now waiting for you, because they can no longer approve.`,
      }).catch(() => {});
    }
    return out;
  } finally {
    RUNNING = false;
  }
}

let TIMER = null;
function startSweep() {
  if (require('./sandbox').isSandbox() || TIMER) return; // eslint-disable-line global-require
  const raw = process.env.APPROVER_LEFT_SWEEP_MS;
  const every = raw === undefined || raw === '' ? 5 * 60000 : Number(raw);
  if (!(every > 0)) return;
  const tick = () => run()
    .then((r) => { if (r.moved || r.skipped) console.log(`[approver-left] ${r.moved} approval(s) moved to the current approver, ${r.skipped} passed to the next level`); }) // eslint-disable-line no-console
    .catch((e) => console.error('[approver-left]', e.message)); // eslint-disable-line no-console
  setTimeout(tick, 45000).unref?.();
  TIMER = setInterval(tick, every);
  if (TIMER.unref) TIMER.unref();
}

module.exports = { run, startSweep, whyGone, stuckSteps, planFor };
