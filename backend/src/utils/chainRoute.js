// ---------------------------------------------------------------------------
// WIRING A ROUTER TO THE APPROVAL CHAIN.
//
// utils/approvalWorkflow.js is the ENGINE — it resolves who approves, lays the
// steps down and moves a request up the ladder. This file is the three things
// every ROUTER has to do around it, written once instead of five times:
//
//   raise()   lay the chain down when the request is created
//   ensure()  lay it down lazily for a record raised before the chain shipped
//   decide()  take one step, refusing anything out of turn
//
// Leave was wired by hand first (routes/leave.js) and keeps its own copy: it
// has rules nothing else has — a balance to draw down, an approval-reason
// threshold, a cancellation path that is deliberately NOT a chain step. The
// other four workflows have none of that, and copying a hundred lines of
// leave-shaped code four times to find out is how the chain would drift apart.
//
// NOTHING HERE DECIDES POLICY. Which levels gate is ApprovalLevelConfig; who
// sits on each rung is resolveChain(); whether a login may act at all is still
// the permission matrix via requirePerm() in the router. This is plumbing.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const workflow = require('./approvalWorkflow');
const { employeeInScope, OUT_OF_SCOPE } = require('./scope');

// A chain problem must never lose the user's request or take a screen down —
// an unhandled rejection has exited this process before. Everything below that
// touches the engine on a READ path is wrapped; the one place a throw is
// allowed to surface is decide(), where silence would mean pretending a
// refused approval succeeded.
async function quietly(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[chain:${label}]`, err.message);
    return fallback;
  }
}

// Has this record got a chain already?
async function hasChain(wf, recordId) {
  const existing = await prisma.approvalStep.findFirst({
    where: { workflow: wf, recordId }, select: { id: true },
  });
  return Boolean(existing);
}

// ---------------------------------------------------------------------------
// RAISE — lay the chain down the moment the request is created, so "where does
// this sit and who has acted" has an answer from second zero.
//
// Returns { pending, steps, summary }. `pending` is the ONE THING THE CALLER
// NEEDS: true means the request is climbing and its record must stay in a
// waiting state; false means the ladder had no rung above the person who
// raised it — a Super Admin's own request, or an employee whose department has
// nobody configured — and the caller applies the effect immediately, exactly
// as it did before any of this existed.
// ---------------------------------------------------------------------------
async function raise(wf, { recordId, employee, applicantUserId, applicantName }) {
  const steps = await quietly('raise', () => workflow.start({
    workflow: wf,
    recordId,
    employee,
    applicantUserId: applicantUserId || employee.userId || null,
    applicantName: applicantName || employee.name,
  }), []);
  return {
    steps,
    pending: (steps || []).some((s) => s.status === workflow.STEP_STATUS.PENDING),
    summary: steps && steps.length ? workflow.summarize(steps) : null,
  };
}

// ENSURE — the same lazy materialisation leave uses. A request raised before
// this shipped shows a real chain on its next read rather than a blank, and
// because it only ever fires on a record that is still open it can never take
// a decided request back to Pending.
async function ensure(wf, { recordId, employee, open }) {
  if (!open || !employee) return null;
  return quietly('ensure', async () => {
    if (await hasChain(wf, recordId)) return null;
    return workflow.start({
      workflow: wf,
      recordId,
      employee,
      applicantUserId: employee.userId || null,
      applicantName: employee.name,
    });
  });
}

// ---------------------------------------------------------------------------
// MAY THIS LOGIN TOUCH THIS RECORD AT ALL?
//
// Scope, OR being named on this record's own chain. The second half matters:
// an approver two rungs up whose department scope does not cover the applicant
// is still that request's approver, and refusing them would strand it.
// ---------------------------------------------------------------------------
async function mayTouch(wf, recordId, user, employee) {
  if (employeeInScope(user, employee)) return true;
  return workflow.isParticipant(wf, recordId, user.id);
}

// ---------------------------------------------------------------------------
// DECIDE — take ONE step.
//
// APPROVING OUT OF TURN IS REFUSED HERE, BY THE API, however the browser is
// persuaded to send the request: workflow.act() reads the pending step and
// answers 403 to anyone who is not its owner.
//
// Returns one of:
//   { error }              -> send error.status / error.body and stop
//   { chained: false }     -> no chain on this record; caller keeps the
//                             single-step path it always had
//   { chained: true, result, view }
//                          -> result.complete false = still climbing, the
//                             record stays in its waiting state and the caller
//                             returns `view`; true = the ladder is finished and
//                             the caller applies the outcome.
// ---------------------------------------------------------------------------
async function decide(wf, recordId, user, { decision, note }) {
  const steps = await workflow.loadSteps(wf, recordId);
  const pending = steps.find((s) => s.status === workflow.STEP_STATUS.PENDING);
  if (!pending) return { chained: false };

  // §20 — A REJECTION ALWAYS CARRIES A REASON. Rejecting somebody's request
  // with a blank is the thing this rule exists to stop.
  if (decision === 'Rejected' && !String(note || '').trim()) {
    return { error: { status: 400, body: { error: 'A rejection reason is required.' } } };
  }

  const result = await workflow.act(wf, recordId, user, {
    decision,
    note: note ? String(note).trim() : null,
  });
  if (result.error) return { error: result.error };

  const view = await quietly('view', () => workflow.view(wf, recordId, user, { canAct: false }));
  return { chained: true, result, view };
}

// Attach each record's chain summary to a list, for the "waiting on X" column.
// Cheap enough to do on every list read: one query for the whole page.
async function decorate(wf, rows, idOf = (r) => r.id) {
  if (!rows || !rows.length) return rows;
  const summaries = await quietly('decorate', () => workflow.summariesFor(wf, rows.map(idOf)), {});
  if (!summaries) return rows;
  return rows.map((r) => ({ ...r, workflow: summaries[idOf(r)] || null }));
}

module.exports = { raise, ensure, decide, mayTouch, decorate, hasChain, OUT_OF_SCOPE };
