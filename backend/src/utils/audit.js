const prisma = require('../db');

// ---------------------------------------------------------------------------
// The audit trail.
//
// NEVER THROWS. An audit write is a side effect of the thing the user asked
// for, not the thing itself: a foreign-key violation on `userId` (a login that
// has since been deleted) used to reject inside an async Express handler,
// which Express 4 does not catch, which becomes an unhandled rejection, which
// exits the process. Failing to record history must not take the API down, so
// the write is guarded and a failure is logged to stderr instead.
//
// FIELD-LEVEL ROWS (empmgmt)
// `field` / `fieldLabel` / `reason` / `approvalStatus` turn the log into the
// per-field history the lifecycle asks for:
//   Employee · Field · Old Value · New Value · Changed By · Changed At ·
//   Reason · Approval Status
// A row written when the employee SUBMITS carries approvalStatus 'Pending';
// resolveFieldApprovals() below stamps the approver onto it afterwards.
// ---------------------------------------------------------------------------

async function logAudit({
  userId, action, entity, entityId, fromValue, toValue,
  field, fieldLabel, reason, approvalStatus, approvedByName, approvedAt, actorName,
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId, action, entity, entityId, fromValue, toValue,
        field, fieldLabel, reason, approvalStatus, approvedByName, approvedAt, actorName,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] could not record "%s" on %s/%s: %s', action, entity, entityId, err && err.message);
  }
}

// One row per changed field, written when an employee submits their profile.
// Same guarantee: a failure here never propagates to the caller.
async function logFieldChanges({ userId, actorName, entity, entityId, action, changes, approvalStatus = 'Pending', reason = null }) {
  if (!Array.isArray(changes) || !changes.length) return;
  try {
    await prisma.auditLog.createMany({
      data: changes.map((c) => ({
        userId: userId || null,
        actorName: actorName || null,
        action,
        entity,
        entityId,
        field: c.field || null,
        fieldLabel: c.label || c.field || null,
        fromValue: c.from === undefined || c.from === null ? '' : String(c.from),
        toValue: c.to === undefined || c.to === null ? '' : String(c.to),
        approvalStatus,
        reason,
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] could not record field changes on %s/%s: %s', entity, entityId, err && err.message);
  }
}

// Stamps HR's verdict onto the field rows that were waiting for it. Called by
// the approve and reject handlers, so the trail shows Approval Status and the
// approver rather than leaving every row 'Pending' for ever.
async function resolveFieldApprovals({ entity, entityId, approvalStatus, approvedByName, reason }) {
  try {
    await prisma.auditLog.updateMany({
      where: { entity, entityId, approvalStatus: 'Pending' },
      data: { approvalStatus, approvedByName: approvedByName || null, approvedAt: new Date(), reason: reason || null },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] could not resolve field approvals on %s/%s: %s', entity, entityId, err && err.message);
  }
}

module.exports = { logAudit, logFieldChanges, resolveFieldApprovals };
