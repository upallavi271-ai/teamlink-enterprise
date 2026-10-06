// ---------------------------------------------------------------------------
// CLIENT LIFECYCLE ROUTES — mounted on the /api/clients router by
// routes/clients.js (so its auth, product gate, Client List view guard and the
// router.param('id') SCOPE CHECK all apply to every /:id route below).
//
//   POST   /clients/:id/pause            {reason}      SA · Admin · Manager (own depts)
//   POST   /clients/:id/reactivate       {reason}      same
//   POST   /clients/:id/pause-request    {reason}      BDE — a request, not a pause
//   GET    /clients/pause-requests                     the requests this login decides / sent
//   POST   /clients/pause-requests/:rid/approve {note}  -> applies the pause
//   POST   /clients/pause-requests/:rid/reject  {reason}
//   POST   /clients/:id/archive          {reason}      SA · Admin
//   POST   /clients/:id/unarchive        {reason}      SA · Admin
//   GET    /clients/:id/delete-check                   what blocks a permanent delete
//   DELETE /clients/:id  {confirmName, reason}          Super Admin only, empty clients only
//
// Every change writes an AuditLog row (who · when · why). A pause REQUEST is
// itself an AuditLog row (action 'Client pause requested', approvalStatus
// Pending → Approved / Rejected) — no schema change.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { clientWhere } = require('../utils/scope');
const { findClientDuplicates } = require('../utils/clientDuplicates');
const {
  lifecycleOf, baseRights, rightsFor, pauseApproverIds,
} = require('../utils/clientLifecycle');

const REQUEST_ACTION = 'Client pause requested';
const MIN_REASON = 3;

function reasonOf(body, label = 'reason') {
  const r = String((body && (body.reason ?? body.note)) || '').trim();
  if (r.length < MIN_REASON) return { error: `Give a ${label} — it is recorded in the client's audit log.` };
  if (r.length > 1000) return { error: 'Keep the reason under 1,000 characters.' };
  return { reason: r };
}

const actor = (req) => ({ userId: req.user.id, actorName: req.user.name || null });

async function setStatus(req, client, to, action, reason, extra = {}) {
  const updated = await prisma.client.update({ where: { id: client.id }, data: { status: to } });
  await logAudit({
    ...actor(req), action, entity: 'Client', entityId: client.id,
    field: 'status', fieldLabel: 'Status',
    fromValue: client.status || 'Active', toValue: to, reason, ...extra,
  });
  return updated;
}

// Pending requests on a client are settled by a direct pause.
async function settlePendingRequests(clientId, byName, note) {
  await prisma.auditLog.updateMany({
    where: { action: REQUEST_ACTION, entity: 'Client', entityId: clientId, approvalStatus: 'Pending' },
    data: { approvalStatus: 'Approved', approvedByName: byName || null, approvedAt: new Date(), toValue: note },
  });
}

module.exports = function mountClientLifecycle(router, { shapeFor, executionFiles, dropExecutionFiles }) {
  async function respond(req, res, client, message) {
    const base = await baseRights(req.user);
    const out = await shapeFor(req, client);
    out.lifecycleActions = rightsFor(req.user, client, base);
    return res.json({ ok: true, message, client: out });
  }

  // ---- pause requests (listed / decided before any /:id route) -------------
  router.get('/pause-requests', async (req, res) => {
    const base = await baseRights(req.user);
    if (!base.pauseEdit && !base.pauseRequest) return res.json({ canDecide: false, requests: [] });
    const scoped = await prisma.client.findMany({ where: clientWhere(req.user), select: { id: true } });
    const ids = scoped.map((c) => c.id);
    const where = {
      action: REQUEST_ACTION, entity: 'Client', entityId: { in: ids },
      OR: [{ approvalStatus: 'Pending' }, { userId: req.user.id }],
    };
    const rows = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    const clients = await prisma.client.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.entityId))] } },
      select: { id: true, name: true, status: true, ownerDepartment: true, clientType: true },
    });
    const byId = new Map(clients.map((c) => [c.id, c]));
    const out = rows.map((r) => {
      const c = byId.get(r.entityId) || null;
      const rights = c ? rightsFor(req.user, c, base) : null;
      return {
        id: r.id,
        clientId: r.entityId,
        clientName: c ? c.name : '(deleted client)',
        ownerDepartment: c ? c.ownerDepartment : null,
        clientStatus: c ? lifecycleOf(c.status) : null,
        reason: r.reason,
        requestedBy: r.actorName,
        requestedById: r.userId,
        requestedAt: r.createdAt,
        status: r.approvalStatus || 'Pending',
        decidedBy: r.approvedByName,
        decidedAt: r.approvedAt,
        decisionNote: r.approvalStatus && r.approvalStatus !== 'Pending' ? r.toValue : null,
        mine: r.userId === req.user.id,
        // Approve / Reject: whoever may pause THIS client directly.
        canDecide: (r.approvalStatus || 'Pending') === 'Pending' && !!(rights && (rights.pause || rights.reactivate)),
      };
    }).filter((r) => r.mine || r.canDecide);
    return res.json({ canDecide: base.pauseEdit, requests: out });
  });

  async function loadRequest(req, res) {
    const row = await prisma.auditLog.findUnique({ where: { id: req.params.rid } });
    if (!row || row.action !== REQUEST_ACTION || row.entity !== 'Client') {
      res.status(404).json({ error: 'Pause request not found' });
      return null;
    }
    if ((row.approvalStatus || 'Pending') !== 'Pending') {
      res.status(409).json({ error: `This request was already ${String(row.approvalStatus).toLowerCase()}.` });
      return null;
    }
    const client = await prisma.client.findFirst({ where: { AND: [{ id: row.entityId }, clientWhere(req.user)] } });
    if (!client) {
      res.status(404).json({ error: 'The client of this request is not in your scope any more.' });
      return null;
    }
    const rights = rightsFor(req.user, client, await baseRights(req.user));
    if (!rights.pause && !rights.reactivate) {
      res.status(403).json({ error: 'Only an Admin, or the Manager of this client\'s department, can decide a pause request.' });
      return null;
    }
    return { row, client, rights };
  }

  router.post('/pause-requests/:rid/approve', async (req, res) => {
    const ctx = await loadRequest(req, res);
    if (!ctx) return undefined;
    const { row, client, rights } = ctx;
    if (!rights.pause) {
      return res.status(409).json({ error: `${client.name} is already ${lifecycleOf(client.status).toLowerCase()} — reject this request instead.` });
    }
    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
    await prisma.auditLog.update({
      where: { id: row.id },
      data: {
        approvalStatus: 'Approved', approvedByName: req.user.name || null, approvedAt: new Date(),
        toValue: note || 'Approved',
      },
    });
    const updated = await setStatus(
      req, client, 'Paused', 'Client paused',
      `${row.reason || 'Pause requested'} — requested by ${row.actorName || 'BDE'}, approved by ${req.user.name || 'approver'}${note ? ` (${note})` : ''}`,
      { approvalStatus: 'Approved', approvedByName: req.user.name || null, approvedAt: new Date() },
    );
    await settlePendingRequests(client.id, req.user.name, 'Approved with another request');
    if (row.userId) {
      await notifyUsers([row.userId], {
        title: `Pause approved — ${client.name}`,
        message: `${req.user.name || 'An approver'} approved your request: ${client.name} is now paused. No new requirements or submissions until it is reactivated.`,
        exceptUserId: req.user.id,
      });
    }
    return respond(req, res, updated, `${client.name} is paused.`);
  });

  router.post('/pause-requests/:rid/reject', async (req, res) => {
    const r = reasonOf(req.body, 'reason for rejecting');
    if (r.error) return res.status(400).json({ error: r.error });
    const ctx = await loadRequest(req, res);
    if (!ctx) return undefined;
    const { row, client } = ctx;
    await prisma.auditLog.update({
      where: { id: row.id },
      data: {
        approvalStatus: 'Rejected', approvedByName: req.user.name || null, approvedAt: new Date(), toValue: r.reason,
      },
    });
    await logAudit({
      ...actor(req), action: 'Client pause request rejected', entity: 'Client', entityId: client.id,
      reason: r.reason, fromValue: row.reason || null,
    });
    if (row.userId) {
      await notifyUsers([row.userId], {
        title: `Pause request rejected — ${client.name}`,
        message: `${req.user.name || 'An approver'} rejected your request to pause ${client.name}: ${r.reason}`,
        exceptUserId: req.user.id,
      });
    }
    return res.json({ ok: true, message: 'Request rejected.' });
  });

  // ---- pause / reactivate ---------------------------------------------------
  router.post('/:id/pause', async (req, res) => {
    const client = req.client;
    const rights = rightsFor(req.user, client, await baseRights(req.user));
    if (!rights.pause) {
      if (lifecycleOf(client.status) === 'Paused') return res.status(409).json({ error: `${client.name} is already paused.` });
      if (lifecycleOf(client.status) === 'Archived') return res.status(409).json({ error: `${client.name} is archived — un-archive it first.` });
      return res.status(403).json({
        error: rights.requestPause || (await baseRights(req.user)).pauseRequest
          ? 'You cannot pause a client directly — send a pause request; an Admin or the department Manager approves it.'
          : 'Pausing a client is for Super Admin, Admin, or the Manager of the client\'s department.',
        code: 'PAUSE_NOT_ALLOWED',
      });
    }
    const r = reasonOf(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const updated = await setStatus(req, client, 'Paused', 'Client paused', r.reason);
    await settlePendingRequests(client.id, req.user.name, `Paused directly by ${req.user.name || 'an approver'}`);
    return respond(req, res, updated, `${client.name} is paused.`);
  });

  router.post('/:id/reactivate', async (req, res) => {
    const client = req.client;
    const rights = rightsFor(req.user, client, await baseRights(req.user));
    if (!rights.reactivate) {
      if (lifecycleOf(client.status) === 'Active') return res.status(409).json({ error: `${client.name} is already active.` });
      if (lifecycleOf(client.status) === 'Archived') return res.status(409).json({ error: `${client.name} is archived — un-archive it instead.` });
      return res.status(403).json({ error: 'Reactivating a client is for Super Admin, Admin, or the Manager of the client\'s department.' });
    }
    const r = reasonOf(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const updated = await setStatus(req, client, 'Active', 'Client reactivated', r.reason);
    return respond(req, res, updated, `${client.name} is active again.`);
  });

  router.post('/:id/pause-request', async (req, res) => {
    const client = req.client;
    const base = await baseRights(req.user);
    const rights = rightsFor(req.user, client, base);
    if (!rights.requestPause) {
      if (rights.pause) return res.status(409).json({ error: 'You can pause this client directly — use Pause.' });
      if (lifecycleOf(client.status) !== 'Active') return res.status(409).json({ error: `${client.name} is ${lifecycleOf(client.status).toLowerCase()} — nothing to request.` });
      return res.status(403).json({ error: 'Your role cannot request a client pause.' });
    }
    const r = reasonOf(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const pending = await prisma.auditLog.findFirst({
      where: { action: REQUEST_ACTION, entity: 'Client', entityId: client.id, approvalStatus: 'Pending' },
      select: { id: true, actorName: true },
    });
    if (pending) return res.status(409).json({ error: `A pause request for ${client.name} is already waiting for approval${pending.actorName ? ` (sent by ${pending.actorName})` : ''}.` });
    const row = await prisma.auditLog.create({
      data: {
        ...actor(req), action: REQUEST_ACTION, entity: 'Client', entityId: client.id,
        reason: r.reason, approvalStatus: 'Pending', fromValue: client.status || 'Active', toValue: 'Paused (requested)',
      },
    });
    const approvers = await pauseApproverIds(client);
    await notifyUsers(approvers, {
      title: `Pause request — ${client.name}`,
      message: `${req.user.name || 'A BDE'} asks to pause ${client.name}: ${r.reason}. Approve or reject it on Clients → Pause requests.`,
      exceptUserId: req.user.id,
    });
    return res.status(201).json({ ok: true, requestId: row.id, notified: approvers.length, message: 'Pause request sent for approval.' });
  });

  // ---- archive / un-archive -------------------------------------------------
  router.post('/:id/archive', async (req, res) => {
    const client = req.client;
    const rights = rightsFor(req.user, client, await baseRights(req.user));
    if (!rights.archive) {
      if (lifecycleOf(client.status) === 'Archived') return res.status(409).json({ error: `${client.name} is already archived.` });
      return res.status(403).json({ error: 'Archiving a client is for Super Admin and Admin.' });
    }
    const r = reasonOf(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const updated = await setStatus(req, client, 'Archived', 'Client archived', r.reason);
    await settlePendingRequests(client.id, req.user.name, `Archived by ${req.user.name || 'an admin'}`);
    return respond(req, res, updated, `${client.name} is archived — hidden from the default lists; every record is kept.`);
  });

  router.post('/:id/unarchive', async (req, res) => {
    const client = req.client;
    const rights = rightsFor(req.user, client, await baseRights(req.user));
    if (!rights.unarchive) {
      if (lifecycleOf(client.status) !== 'Archived') return res.status(409).json({ error: `${client.name} is not archived.` });
      return res.status(403).json({ error: 'Un-archiving a client is for Super Admin and Admin.' });
    }
    const r = reasonOf(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    // Back to what it was before the archive (a paused client stays paused).
    const last = await prisma.auditLog.findFirst({
      where: { action: 'Client archived', entity: 'Client', entityId: client.id },
      orderBy: { createdAt: 'desc' }, select: { fromValue: true },
    });
    const to = last && lifecycleOf(last.fromValue) === 'Paused' ? 'Paused' : 'Active';
    const updated = await setStatus(req, client, to, 'Client un-archived', r.reason);
    return respond(req, res, updated, `${client.name} is back${to === 'Paused' ? ' (still paused)' : ''}.`);
  });

  // ---- permanent delete -----------------------------------------------------
  // Every record that ties a client to the business. ANY of them blocks the
  // delete — Archive (or Merge, for a duplicate) is the answer then.
  async function deleteBlockers(client) {
    const id = client.id;
    const [reqs, apps, invoices, payments, users, feedback, events, bank, expenses, merges] = await Promise.all([
      prisma.requirement.count({ where: { clientId: id } }),
      prisma.application.count({ where: { requirement: { clientId: id } } }),
      prisma.invoice.count({ where: { clientId: id } }),
      prisma.invoicePayment.count({ where: { invoice: { clientId: id } } }).catch(() => 0),
      prisma.user.count({ where: { clientId: id } }),
      prisma.interviewFeedback.count({ where: { clientId: id } }),
      prisma.applicationStageEvent.count({ where: { clientId: id } }),
      prisma.bankTransaction.count({ where: { clientName: client.name } }),
      prisma.officeExpense.count({ where: { billableClient: client.name } }),
      prisma.clientMerge.count({ where: { OR: [{ primaryId: id }, { donorIds: { contains: id } }] } }),
    ]);
    const signed = !!(client.agreementSignedAt || client.agreementClientSealedAt || client.agreementVerifiedAt
      || client.agreementActivatedAt || ['SIGNED', 'ACTIVE', 'CONFIRMED'].includes(String(client.agreementStatus || '').toUpperCase()));
    const list = [
      ['requirements', 'requirement(s)', reqs],
      ['applications', 'candidate application(s)', apps],
      ['invoices', 'invoice(s)', invoices],
      ['payments', 'payment(s) received', payments],
      ['portalUsers', 'client portal login(s)', users],
      ['feedback', 'client interview feedback record(s)', feedback],
      ['stageEvents', 'pipeline history event(s)', events],
      ['bank', 'bank transaction(s) matched to this client', bank],
      ['expenses', 'expense(s) billable to this client', expenses],
      ['merges', 'duplicate-merge record(s)', merges],
      ['agreement', 'signed / active service agreement', signed ? 1 : 0],
    ];
    return list.filter(([, , n]) => n > 0).map(([key, label, count]) => ({ key, label, count }));
  }

  router.get('/:id/delete-check', async (req, res) => {
    const client = req.client;
    const rights = rightsFor(req.user, client, await baseRights(req.user));
    if (!rights.delete) return res.status(403).json({ error: 'Only a Super Admin can permanently delete a client.' });
    const blockers = await deleteBlockers(client);
    const dup = await findClientDuplicates(
      { name: client.name, gst: client.gst, pan: client.pan },
      { excludeId: client.id },
    ).catch(() => ({ matches: [] }));
    const aliases = await prisma.clientAlias.count({ where: { clientId: client.id } });
    // A signed agreement ALONE (no jobs, invoices, logins…) no longer blocks:
    // the Super Admin ticks "Delete the signed agreement too" (user, 2026-10-05).
    const hard = blockers.filter((b) => b.key !== 'agreement');
    return res.json({
      name: client.name,
      canDelete: hard.length === 0,
      needsAgreementConfirm: hard.length === 0 && blockers.some((b) => b.key === 'agreement'),
      blockers: hard.length ? blockers : [],
      aliases,
      duplicates: (dup.matches || []).slice(0, 5).map((m) => ({ id: m.id || m.clientId, name: m.name })),
    });
  });

  router.delete('/:id', async (req, res) => {
    const client = req.client;
    const rights = rightsFor(req.user, client, await baseRights(req.user));
    if (!rights.delete) {
      return res.status(403).json({ error: 'Only a Super Admin can permanently delete a client. Archive it instead — data and accounting records stay intact.' });
    }
    const body = req.body || {};
    const typed = String(body.confirmName ?? '').trim();
    if (typed !== String(client.name).trim()) {
      return res.status(400).json({ error: 'Type the client\'s exact name to confirm the permanent delete.', code: 'CONFIRM_NAME_MISMATCH' });
    }
    const r = reasonOf(body);
    if (r.error) return res.status(400).json({ error: r.error });
    const all = await deleteBlockers(client);
    const hasAgreement = all.some((b) => b.key === 'agreement');
    const blockers = all.filter((b) => b.key !== 'agreement');
    if (hasAgreement && !blockers.length && body.confirmSignedAgreement !== true) {
      return res.status(409).json({
        error: `${client.name} has a signed agreement. Tick "Delete the signed agreement too" to confirm.`,
        code: 'CONFIRM_SIGNED_AGREEMENT',
        blockers: all,
      });
    }
    if (blockers.length) {
      return res.status(409).json({
        error: `${client.name} cannot be deleted — it has ${blockers.map((b) => (b.key === 'agreement' ? b.label : `${b.count} ${b.label}`)).join(', ')}. Archive it instead (hidden, data kept); if it is a duplicate, use Merge Duplicates.`,
        code: 'CLIENT_HAS_RECORDS',
        blockers,
      });
    }
    // The audit snapshot: the whole row as it was, minus secrets and the long
    // agreement text.
    const snap = { ...client };
    ['esignToken', 'agreementOtpHash', 'agreementOtpExpiresAt', 'agreementOtpAttempts'].forEach((k) => { delete snap[k]; });
    // A signed agreement is a legal record: its full text stays in the audit
    // row and its signature / stamp / PDF files stay on disk.
    if (snap.agreementDocument && !hasAgreement) snap.agreementDocument = `${String(snap.agreementDocument).slice(0, 500)}…`;
    const aliases = await prisma.clientAlias.findMany({ where: { clientId: client.id }, select: { alias: true } });
    snap.aliases = aliases.map((a) => a.alias);
    const files = executionFiles(client);
    await prisma.$transaction([
      prisma.clientAlias.deleteMany({ where: { clientId: client.id } }),
      prisma.client.delete({ where: { id: client.id } }),
    ]);
    if (!hasAgreement) dropExecutionFiles(files);
    await logAudit({
      ...actor(req), action: 'Client deleted (permanent)', entity: 'Client', entityId: client.id,
      fromValue: JSON.stringify(snap), toValue: 'Deleted', reason: r.reason,
    });
    return res.json({ ok: true, id: client.id, message: `${client.name} was permanently deleted.` });
  });
};
