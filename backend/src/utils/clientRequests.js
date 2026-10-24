// ---------------------------------------------------------------------------
// CLIENT / JOB REQUESTS THAT A MANAGER OR ADMIN DECIDES (user spec 2026-10-10, BDE business workspace)
//
//   delete      BDE asks to delete a client    -> Admin approves -> SOFT delete (the client is Archived, every record kept)
//   deactivate  BDE asks to deactivate a client -> Manager of the department or Admin approves -> status Inactive
//   owner       BDE asks to give the client to another BDE -> Manager of the department or Admin approves -> Owner BDE changes
//   merge       BDE says "this client is a duplicate of ..." -> Admin approves (the Admin then merges on Duplicate clients)
//   approval    BDE submits a new client for approval -> Manager of the department or Admin approves / rejects
//   closejob    BDE asks to close a job (filled / client cancelled) -> Manager of the department or Admin approves -> job Closed
//
// STORE: one AuditLog row per request (no schema change), the same pattern as the pause request:
//   action  'Client delete requested' ...     entity 'Client' | 'Requirement'     entityId  the client / job
//   reason  the BDE's reason (required)       approvalStatus Pending -> Approved | Rejected
//   field / fromValue / toValue  what is being asked (see KINDS below), approvedByName / approvedAt the decision.
// The decision writes a SECOND audit row ('Client delete approved' ...) with the approver's note, user and time.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');
const { clientWhere, requirementWhere } = require('./scope');
const CL = require('./clientLifecycle');

const MIN_REASON = 3;
const TEST_RE = /zztest|example\.test/i;

// kind -> { action (the request row), entity, label (plain words), decider: 'admin' | 'lead' }
const KINDS = {
  delete: { action: 'Client delete requested', entity: 'Client', label: 'Delete client', decider: 'admin' },
  deactivate: { action: 'Client deactivate requested', entity: 'Client', label: 'Deactivate client', decider: 'lead' },
  owner: { action: 'Client owner change requested', entity: 'Client', label: 'Change client owner', decider: 'lead' },
  merge: { action: 'Client merge requested', entity: 'Client', label: 'Merge duplicate client', decider: 'admin' },
  approval: { action: 'Client approval requested', entity: 'Client', label: 'Client approval', decider: 'lead' },
  closejob: { action: 'Requirement close requested', entity: 'Requirement', label: 'Close requirement', decider: 'lead' },
  // The older pause request (routes/clientLifecycleRoutes.js decides it): listed here so My requests shows every kind.
  pause: { action: 'Client pause requested', entity: 'Client', label: 'Pause client', decider: 'lead', legacy: true },
};
const ACTIONS = Object.values(KINDS).map((k) => k.action);
const kindOfAction = (action) => Object.keys(KINDS).find((k) => KINDS[k].action === action) || null;

// Hooks that other modules register (the job close is applied by routes/jobLifecycleRoutes.js, which owns pushToPortal).
const hooks = { closeJob: null };

function reasonOf(v, label = 'reason') {
  const r = String(v || '').trim();
  if (r.length < MIN_REASON) return { error: `Give a ${label} (at least 3 letters). It is kept in the history of the ${label === 'reason' ? 'client' : 'record'}.` };
  if (r.length > 1000) return { error: 'Keep the reason under 1,000 characters.' };
  return { reason: r };
}

// ---- who decides ----------------------------------------------------------------------------------------
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
async function deciderIds(client, decider) {
  const users = await prisma.user.findMany({
    where: {
      status: 'Active',
      OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } },
        ...(decider === 'lead' ? [{ role: 'MANAGER' }, { atsRole: 'MANAGER' }] : [])],
    },
    select: {
      id: true, name: true, email: true, role: true, atsRole: true, atsScopeDepartments: true, atsDepartment: true, employee: { select: { department: true } },
    },
  });
  return users.filter((u) => {
    if (!process.env.TEST_MODE && TEST_RE.test(`${u.name} ${u.email}`)) return false;
    if ([u.role, u.atsRole].some((r) => r === 'SUPER_ADMIN' || r === 'ADMIN')) return true;
    const depts = csv(u.atsScopeDepartments).length ? csv(u.atsScopeDepartments) : [u.atsDepartment || (u.employee && u.employee.department)].filter(Boolean);
    return !!(client && client.ownerDepartment) && depts.includes(client.ownerDepartment);
  }).map((u) => u.id);
}

// May THIS login decide a request of this kind on this client?
function mayDecideKind(user, kind, client) {
  const k = KINDS[kind];
  if (!k || !client) return false;
  if (k.decider === 'admin') return !!require('./scope').scopeOf(user).adminGlobal; // eslint-disable-line global-require
  return CL.mayDecide(user, client);
}

// ---- create ---------------------------------------------------------------------------------------------
// subject: { entity, id, client } ; ask: { field, fromValue, toValue }
async function createRequest({ user, kind, client, requirement = null, reason, ask }) {
  const k = KINDS[kind];
  const entityId = k.entity === 'Requirement' ? requirement.id : client.id;
  const pending = await prisma.auditLog.findFirst({
    where: { action: k.action, entity: k.entity, entityId, approvalStatus: 'Pending' }, select: { id: true, actorName: true },
  });
  if (pending) {
    return { status: 409, body: { error: `A ${k.label.toLowerCase()} request is already waiting for approval${pending.actorName ? ` (sent by ${pending.actorName})` : ''}.` } };
  }
  const row = await prisma.auditLog.create({
    data: {
      userId: user.id, actorName: user.name || null, action: k.action, entity: k.entity, entityId,
      reason, approvalStatus: 'Pending', field: ask.field || null, fieldLabel: ask.fieldLabel || k.label,
      fromValue: ask.fromValue == null ? null : String(ask.fromValue).slice(0, 500), toValue: ask.toValue == null ? null : String(ask.toValue).slice(0, 500),
    },
  });
  const ids = await deciderIds(client, k.decider);
  const subject = requirement ? `${requirement.title || 'a requirement'} (${client ? client.name : 'internal'})` : client.name;
  await notifyUsers(ids, {
    title: `${k.label} request — ${subject}`,
    message: `${user.name || 'A BDE'} asks: ${k.label.toLowerCase()} — ${subject}. Reason: ${reason}. Open Clients → My requests to approve or reject.`,
    exceptUserId: user.id,
  }).catch(() => null);
  return { status: 201, body: { ok: true, requestId: row.id, notified: ids.length, message: 'Sent for approval. You will see the answer under My requests.' } };
}

// ---- list -----------------------------------------------------------------------------------------------
async function listFor(user, { onlyMine = false, take = 150 } = {}) {
  const rows = await prisma.auditLog.findMany({ where: { action: { in: ACTIONS } }, orderBy: { createdAt: 'desc' }, take: 400 });
  const clientIds = [...new Set(rows.filter((r) => r.entity === 'Client').map((r) => r.entityId))];
  const reqIds = [...new Set(rows.filter((r) => r.entity === 'Requirement').map((r) => r.entityId))];
  const [reqs, scoped] = await Promise.all([
    reqIds.length ? prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, title: true, reqCode: true, clientId: true, status: true } }) : [],
    clientIds.length || reqIds.length ? prisma.client.findMany({ where: { AND: [clientWhere(user), { OR: [{ id: { in: clientIds } }, { requirements: { some: { id: { in: reqIds } } } }] }] }, select: { id: true } }) : [],
  ]);
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const allClientIds = [...new Set([...clientIds, ...reqs.map((r) => r.clientId).filter(Boolean)])];
  const clients = allClientIds.length ? await prisma.client.findMany({ where: { id: { in: allClientIds } }, select: { id: true, name: true, status: true, ownerDepartment: true, bdeOwner: true, clientType: true } }) : [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const inScope = new Set(scoped.map((c) => c.id));
  const out = [];
  for (const r of rows) {
    const kind = kindOfAction(r.action);
    const req = r.entity === 'Requirement' ? reqById.get(r.entityId) : null;
    const client = clientById.get(req ? req.clientId : r.entityId) || null;
    const mine = r.userId === user.id;
    const status = r.approvalStatus || 'Pending';
    const canDecide = status === 'Pending' && !mine && !!client && inScope.has(client.id) && mayDecideKind(user, kind, client);
    if (!(mine || canDecide)) continue; // eslint-disable-line no-continue
    if (onlyMine && !mine) continue; // eslint-disable-line no-continue
    out.push({
      id: r.id,
      kind,
      kindLabel: KINDS[kind].label,
      subjectType: r.entity,
      subjectId: r.entityId,
      clientId: client ? client.id : null,
      clientName: client ? client.name : '(deleted client)',
      jobTitle: req ? (req.reqCode ? `${req.reqCode} · ${req.title}` : req.title) : null,
      ownerDepartment: client ? client.ownerDepartment : null,
      ask: { field: r.field, from: r.fromValue, to: r.toValue },
      reason: r.reason,
      requestedBy: r.actorName,
      requestedAt: r.createdAt,
      status,
      decidedBy: r.approvedByName,
      decidedAt: r.approvedAt,
      mine,
      canDecide,
    });
    if (out.length >= take) break;
  }
  return out;
}

// ---- decide ---------------------------------------------------------------------------------------------
// Returns { status, body }. `apply` runs only on approve.
async function decide({ user, id, approve, note }) {
  const row = await prisma.auditLog.findUnique({ where: { id } });
  const kind = row ? kindOfAction(row.action) : null;
  if (!row || !kind) return { status: 404, body: { error: 'Request not found.' } };
  const k = KINDS[kind];
  if (k.legacy) return { status: 400, body: { error: 'Use the pause request buttons.', legacy: true } };
  if ((row.approvalStatus || 'Pending') !== 'Pending') {
    return { status: 409, body: { error: `This request was already ${String(row.approvalStatus).toLowerCase()}.` } };
  }
  if (row.userId === user.id) return { status: 403, body: { error: 'You cannot decide your own request.' } };
  let requirement = null;
  let clientId = row.entityId;
  if (k.entity === 'Requirement') {
    requirement = await prisma.requirement.findUnique({ where: { id: row.entityId } });
    if (!requirement) return { status: 404, body: { error: 'The requirement of this request no longer exists.' } };
    clientId = requirement.clientId;
  }
  const client = clientId ? await prisma.client.findFirst({ where: { AND: [{ id: clientId }, clientWhere(user)] } }) : null;
  if (!client) return { status: 404, body: { error: 'This request is not in your area.' } };
  if (!mayDecideKind(user, kind, client)) {
    return { status: 403, body: { error: k.decider === 'admin' ? 'Only an Admin decides this request.' : 'Only an Admin, or the Manager of this client\'s department, decides this request.' } };
  }
  const n = String(note || '').trim().slice(0, 500);
  if (!approve) {
    const r = reasonOf(n, 'reason for rejecting');
    if (r.error) return { status: 400, body: { error: r.error } };
  }
  const subject = requirement ? `${requirement.title} (${client.name})` : client.name;
  let message = approve ? 'Approved.' : 'Rejected.';
  if (approve) {
    const done = await applyApproved({ user, kind, row, client, requirement, note: n });
    if (done.error) return { status: done.status || 409, body: { error: done.error } };
    message = done.message || message;
  }
  await prisma.auditLog.update({
    where: { id: row.id },
    data: { approvalStatus: approve ? 'Approved' : 'Rejected', approvedByName: user.name || null, approvedAt: new Date() },
  });
  await logAudit({
    userId: user.id, actorName: user.name || null, action: `${k.label} ${approve ? 'approved' : 'rejected'}`, entity: k.entity, entityId: row.entityId,
    reason: n || (approve ? 'Approved' : null), fromValue: row.reason, toValue: approve ? 'Approved' : 'Rejected',
  });
  await notifyUsers([row.userId], {
    title: `${k.label} ${approve ? 'approved' : 'rejected'} — ${subject}`,
    message: `${user.name || 'An approver'} ${approve ? 'approved' : 'rejected'} your request (${k.label.toLowerCase()}: ${subject})${n ? `: ${n}` : '.'}`,
    exceptUserId: user.id,
  }).catch(() => null);
  return { status: 200, body: { ok: true, message } };
}

async function applyApproved({ user, kind, row, client, requirement, note }) {
  const stamp = `${row.reason || ''} (asked by ${row.actorName || 'BDE'}, approved by ${user.name || 'approver'}${note ? `: ${note}` : ''})`.slice(0, 900);
  if (kind === 'delete' || kind === 'deactivate') {
    const to = kind === 'delete' ? 'Archived' : 'Inactive';
    await prisma.client.update({ where: { id: client.id }, data: { status: to } });
    await logAudit({
      userId: user.id, actorName: user.name || null, action: kind === 'delete' ? 'Client deleted (soft delete, approved)' : 'Client deactivated (approved)', entity: 'Client', entityId: client.id,
      field: 'status', fieldLabel: 'Status', fromValue: client.status || 'Active', toValue: to, reason: stamp, approvalStatus: 'Approved', approvedByName: user.name || null, approvedAt: new Date(),
    });
    return { message: kind === 'delete' ? `${client.name} is deleted from the lists (archived). Every record is kept.` : `${client.name} is deactivated.` };
  }
  if (kind === 'owner') {
    const newOwner = row.toValue;
    const { bdeDirectory, bdeDepartmentProblem } = require('./bdeSeats'); // eslint-disable-line global-require
    const dir = await bdeDirectory();
    const problem = bdeDepartmentProblem(dir, newOwner, client.ownerDepartment, 'The new owner');
    if (problem) return { error: problem, status: 400 };
    const prev = client.bdeOwner;
    await prisma.client.update({ where: { id: client.id }, data: { bdeOwner: newOwner } });
    await logAudit({
      userId: user.id, actorName: user.name || null, action: 'Client owner changed (approved)', entity: 'Client', entityId: client.id,
      field: 'bdeOwner', fieldLabel: 'Owner BDE', fromValue: prev || '—', toValue: newOwner, reason: stamp, approvalStatus: 'Approved', approvedByName: user.name || null, approvedAt: new Date(),
    });
    // tell the new and the old owner
    const names = [newOwner, prev].filter(Boolean).map((x) => x.toLowerCase());
    const people = names.length ? await prisma.user.findMany({ where: { status: 'Active', atsRole: 'BDE' }, select: { id: true, name: true } }) : [];
    await notifyUsers(people.filter((p) => names.includes(String(p.name || '').toLowerCase())).map((p) => p.id), {
      title: `Client owner changed — ${client.name}`, message: `${client.name} now belongs to ${newOwner}${prev ? ` (was ${prev})` : ''}.`, exceptUserId: user.id,
    }).catch(() => null);
    return { message: `${client.name} now belongs to ${newOwner}.` };
  }
  if (kind === 'merge') {
    return { message: 'Approved. Open Duplicate clients to merge the two clients.' };
  }
  if (kind === 'approval') {
    await logAudit({
      userId: user.id, actorName: user.name || null, action: 'Client approved', entity: 'Client', entityId: client.id, fromValue: 'Submitted', toValue: 'Approved', reason: stamp,
      approvalStatus: 'Approved', approvedByName: user.name || null, approvedAt: new Date(),
    });
    return { message: `${client.name} is approved.` };
  }
  if (kind === 'closejob') {
    if (!hooks.closeJob) return { error: 'Closing requirements is not ready. Please try again.', status: 503 };
    const outcome = row.toValue && /cancel/i.test(row.toValue) ? 'Cancelled' : 'Filled';
    const res = await hooks.closeJob({ user, requirement, outcome, reason: stamp });
    if (res && res.error) return res;
    return { message: `${requirement.title} is closed (${outcome.toLowerCase()}).` };
  }
  return { error: 'Unknown request.', status: 400 };
}

module.exports = {
  KINDS, ACTIONS, hooks, reasonOf, createRequest, listFor, decide, mayDecideKind, deciderIds, kindOfAction,
};
// (requirementWhere is exported by scope; imported here for callers that need a scoped job lookup)
void requirementWhere;
