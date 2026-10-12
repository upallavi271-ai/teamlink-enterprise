// ---------------------------------------------------------------------------
// CLIENT BUSINESS ACTIVITIES + THE BDE "MY BUSINESS WORKSPACE" NUMBERS (user spec 2026-10-10)
//
//   Follow-ups, client meetings and client feedback / hiring updates are small JSON rows in AppSetting
//   (key clientfu.<clientId>.<id>) - no schema change. Feedback and hiring updates are APPEND-ONLY history.
//   Reminders: a bell notice to the owner BDE on the day a follow-up / meeting is due (and when it is late),
//   sent once, the first time the workspace is read that day (no background worker needed).
//
//   workspaceFor(user)   My Clients / My Requirements / Follow-ups Due / Pending Approvals + the lists behind them
//   clientBusiness(...)  one client: onboarding steps, follow-ups, meetings, feedback, requests
//   addItem / markDone   write them (each writes an audit row: who, when, why)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');
const { clientWhere, scopeOf, isBdeTl, atsViewRole } = require('./scope');
const V = require('./atsVocab');
const CL = require('./clientLifecycle');
const CR = require('./clientRequests');
const profile = require('./clientProfile');

const PREFIX = 'clientfu.';
const TEST_RE = /zztest|example\.test/i;
const KINDS = {
  followup: { label: 'Follow-up', needsDate: true, audit: 'Client follow-up added' },
  meeting: { label: 'Meeting', needsDate: true, audit: 'Client meeting scheduled' },
  feedback: { label: 'Client feedback', needsDate: false, audit: 'Client feedback recorded' },
  hiring: { label: 'Hiring update', needsDate: false, audit: 'Client hiring update recorded' },
};
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;

const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const keyOf = (clientId, id) => `${PREFIX}${clientId}.${id}`;
function parse(row) {
  try { const v = JSON.parse(row.value); return v && typeof v === 'object' ? { ...v, _key: row.key } : null; } catch { return null; }
}
const publicItem = (it, today) => ({
  id: it.id, clientId: it.clientId, kind: it.kind, kindLabel: (KINDS[it.kind] || {}).label || it.kind,
  title: it.title || null, note: it.note || null, dueDate: it.dueDate || null, dueTime: it.dueTime || null, meetingLink: it.meetingLink || null,
  status: it.status, ownerName: it.ownerName || null, createdBy: it.createdByName || null, createdAt: it.createdAt,
  doneAt: it.doneAt || null, doneNote: it.doneNote || null,
  late: it.status === 'Open' && !!it.dueDate && it.dueDate < today,
  dueToday: it.status === 'Open' && it.dueDate === today,
});

async function itemsOfClients(clientIds, { kinds = null } = {}) {
  if (!clientIds.length) return [];
  const rows = await prisma.appSetting.findMany({ where: { OR: clientIds.map((id) => ({ key: { startsWith: `${PREFIX}${id}.` } })) } });
  return rows.map(parse).filter((x) => x && (!kinds || kinds.includes(x.kind)));
}

// ---- write ------------------------------------------------------------------------------------------
async function addItem(user, client, body) {
  const kind = KINDS[body.kind] ? body.kind : 'followup';
  const def = KINDS[kind];
  const title = String(body.title || '').trim().slice(0, 200);
  const note = String(body.note || '').trim().slice(0, 2000);
  if (def.needsDate) {
    if (title.length < 3) return { status: 400, body: { error: `Say what the ${def.label.toLowerCase()} is about (at least 3 letters).` } };
    const dueDate = String(body.dueDate || '').trim();
    if (!YMD.test(dueDate)) return { status: 400, body: { error: 'Pick the date.' } };
    if (dueDate < istToday()) return { status: 400, body: { error: 'The date must be today or later.' } };
    if (body.dueTime && !HM.test(String(body.dueTime))) return { status: 400, body: { error: 'Write the time like 15:30.' } };
  } else if (note.length < 3) {
    return { status: 400, body: { error: 'Write what the client said (at least 3 letters).' } };
  }
  const id = crypto.randomBytes(6).toString('hex');
  const item = {
    id, clientId: client.id, kind, title: title || null, note: note || null,
    dueDate: def.needsDate ? String(body.dueDate).trim() : null, dueTime: def.needsDate && body.dueTime ? String(body.dueTime) : null,
    meetingLink: kind === 'meeting' && body.meetingLink ? String(body.meetingLink).trim().slice(0, 500) : null,
    status: def.needsDate ? 'Open' : 'Recorded', remind: body.remind !== false,
    ownerId: user.id, ownerName: user.name || null, createdById: user.id, createdByName: user.name || null, createdAt: new Date().toISOString(),
  };
  await prisma.appSetting.create({ data: { key: keyOf(client.id, id), value: JSON.stringify(item), updatedById: user.id, updatedByName: user.name || null } });
  await logAudit({
    userId: user.id, actorName: user.name || null, action: def.audit, entity: 'Client', entityId: client.id,
    fieldLabel: def.label, toValue: item.dueDate ? `${item.dueDate}${item.dueTime ? ` ${item.dueTime}` : ''}` : null, reason: (title || note).slice(0, 500),
  });
  // somebody else (an Admin) set it for the client's BDE: the BDE hears about it
  if (client.bdeOwner && def.needsDate) {
    const owner = await prisma.user.findFirst({ where: { name: client.bdeOwner, status: 'Active' }, select: { id: true } });
    if (owner && owner.id !== user.id) {
      await notifyUsers([owner.id], { title: `${def.label} set — ${client.name}`, message: `${user.name || 'Someone'} set a ${def.label.toLowerCase()} for ${client.name} on ${item.dueDate}: ${title}.`, exceptUserId: user.id });
    }
  }
  return { status: 201, body: { ok: true, item: publicItem(item, istToday()), message: def.needsDate ? `${def.label} saved for ${item.dueDate}. You will get a reminder that day.` : 'Saved in the client history.' } };
}

async function markDone(user, fid, note) {
  const row = await prisma.appSetting.findFirst({ where: { key: { startsWith: PREFIX, endsWith: `.${String(fid).replace(/[^a-f0-9]/gi, '')}` } } });
  const it = row ? parse(row) : null;
  if (!it) return { status: 404, body: { error: 'Follow-up not found.' } };
  const client = await prisma.client.findFirst({ where: { AND: [{ id: it.clientId }, clientWhere(user)] } });
  if (!client) return { status: 403, body: { error: 'This client is outside your area.' } };
  if (!CL.ownsClient(user, client) && it.ownerId !== user.id) return { status: 403, body: { error: 'This client is not yours.' } };
  if (it.status !== 'Open') return { status: 409, body: { error: 'This was already finished.' } };
  const next = { ...it }; delete next._key;
  next.status = 'Done'; next.doneAt = new Date().toISOString(); next.doneNote = String(note || '').trim().slice(0, 500) || null; next.doneBy = user.name || null;
  await prisma.appSetting.update({ where: { key: row.key }, data: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name || null } });
  await logAudit({ userId: user.id, actorName: user.name || null, action: `Client ${it.kind === 'meeting' ? 'meeting' : 'follow-up'} done`, entity: 'Client', entityId: client.id, reason: (next.doneNote || it.title || '').slice(0, 500), fromValue: it.dueDate, toValue: 'Done' });
  return { status: 200, body: { ok: true, message: 'Done. Saved in the client history.' } };
}

// ---- one client -----------------------------------------------------------------------------------------
async function clientBusiness(user, client, rights) {
  const today = istToday();
  const [items, reqCount, audits] = await Promise.all([
    itemsOfClients([client.id]),
    prisma.requirement.count({ where: { clientId: client.id, internal: false } }),
    prisma.auditLog.findMany({ where: { entity: 'Client', entityId: client.id, action: { in: ['Client approval requested', 'Client approved', 'Client approval requested rejected'] } }, orderBy: { createdAt: 'asc' } }),
  ]);
  const sub = audits.filter((a) => a.action === 'Client approval requested');
  const lastSub = sub[sub.length - 1] || null;
  const missing = profile.missingRequired(client);
  const agr = V.normalizeAgreementStatus(client.agreementStatus);
  const steps = [
    { key: 'added', label: 'Client added', done: true, when: client.createdAt },
    { key: 'details', label: 'Details complete', done: missing.length === 0, note: missing.length ? `Still needed: ${missing.slice(0, 4).map((m) => m.label).join(', ')}${missing.length > 4 ? '…' : ''}` : null },
    { key: 'submitted', label: 'Submitted for approval', done: !!lastSub, when: lastSub ? lastSub.createdAt : null },
    {
      key: 'approved', label: 'Approved', done: !!lastSub && lastSub.approvalStatus === 'Approved', when: lastSub && lastSub.approvalStatus === 'Approved' ? lastSub.approvedAt : null,
      rejected: !!lastSub && lastSub.approvalStatus === 'Rejected', note: lastSub && lastSub.approvalStatus === 'Rejected' ? 'Not approved - see My requests' : (lastSub && lastSub.approvalStatus === 'Pending' ? 'Waiting for the Manager / Admin' : null),
    },
    { key: 'agreement-sent', label: 'Agreement sent', done: agr !== 'DRAFT' },
    { key: 'agreement-signed', label: 'Agreement signed', done: V.agreementIsSigned(client.agreementStatus) },
    { key: 'agreement-active', label: 'Agreement active', done: V.agreementIsActive(client.agreementStatus) },
    { key: 'first-job', label: 'First job raised', done: reqCount > 0 },
  ];
  const firstTodo = steps.findIndex((s) => !s.done);
  steps.forEach((s, i) => { s.state = s.done ? 'done' : (s.rejected ? 'rejected' : (i === firstTodo ? 'current' : 'todo')); });
  const asc = (a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
  const open = items.filter((x) => x.status === 'Open').sort(asc);
  const history = items.filter((x) => x.status !== 'Open').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const mineReq = (await CR.listFor(user, { take: 300 })).filter((r) => r.clientId === client.id).slice(0, 10);
  return {
    clientId: client.id,
    onboarding: { steps, percent: Math.round((steps.filter((s) => s.done).length / steps.length) * 100) },
    open: open.map((x) => publicItem(x, today)),
    history: history.map((x) => publicItem(x, today)),
    requests: mineReq,
    rights: {
      followUp: rights ? true : false,
      requestDelete: !!(rights && rights.requestDelete), requestDeactivate: !!(rights && rights.requestDeactivate), deactivate: !!(rights && rights.deactivate),
      requestOwner: !!(rights && rights.requestOwner), requestMerge: !!(rights && rights.requestMerge), submitApproval: !!(rights && rights.submitApproval),
    },
  };
}

// ---- the workspace ------------------------------------------------------------------------------------
async function workspaceFor(user) {
  const s = scopeOf(user);
  const today = istToday();
  const tl = isBdeTl(user);
  const testViewer = TEST_RE.test(`${user.name || ''} ${user.email || ''}`) || !!process.env.TEST_MODE;
  const own = new Set(s.bdeOwnClientIds || []);
  const where = (s.global || tl || atsViewRole(user) !== 'bde') ? clientWhere(user) : { AND: [clientWhere(user), { id: { in: [...own] } }] };
  const clients = (await prisma.client.findMany({
    where, select: { id: true, name: true, status: true, ownerDepartment: true, agreementStatus: true, clientType: true, createdAt: true }, orderBy: { name: 'asc' },
  })).filter((c) => testViewer || !TEST_RE.test(c.name));
  const ids = clients.map((c) => c.id);
  const reqs = ids.length || user.id ? (await prisma.requirement.findMany({
    where: { internal: false, status: { notIn: ['CLOSED'] }, OR: [{ bdeId: user.id }, ...(ids.length ? [{ clientId: { in: ids } }] : [])] },
    select: { id: true, title: true, reqCode: true, status: true, clientId: true, client: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 400,
  })).filter((r) => testViewer || !TEST_RE.test(r.client ? r.client.name : '')) : [];
  const live = reqs.filter((r) => r.status !== 'DRAFT');
  const items = await itemsOfClients(ids, { kinds: ['followup', 'meeting'] });
  const open = items.filter((x) => x.status === 'Open').sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const due = open.filter((x) => x.dueDate <= today);
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  // candidate chases that are the BDE's own (the same follow-ups the dashboard lists)
  const chase = await prisma.applicationFollowUp.count({ where: { ownerUserId: user.id, completedAt: null, dueDate: { lte: today } } }).catch(() => 0);
  const mine = await CR.listFor(user, { onlyMine: true, take: 300 });
  const pause = await prisma.auditLog.count({ where: { action: 'Client pause requested', userId: user.id, approvalStatus: 'Pending' } }).catch(() => 0);
  const imports = await prisma.auditLog.count({ where: { entity: 'AtsImportRequest', userId: user.id, approvalStatus: 'Pending' } }).catch(() => 0);
  const pendingReq = mine.filter((r) => r.status === 'Pending');
  // once-a-day reminders (bell) for the follow-ups / meetings that are due or late
  const toRemind = due.filter((x) => x.remind !== false && x.reminded !== today && (x.ownerId === user.id));
  for (const x of toRemind) {
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers([user.id], {
      title: `${x.kind === 'meeting' ? 'Meeting' : 'Follow-up'} ${x.dueDate < today ? 'late' : 'today'} — ${nameOf.get(x.clientId) || 'client'}`,
      message: `${x.title || ''}${x.dueDate < today ? ` (was due ${x.dueDate})` : ''}`,
    }).catch(() => null);
    const next = { ...x }; delete next._key; next.reminded = today;
    // eslint-disable-next-line no-await-in-loop
    await prisma.appSetting.update({ where: { key: x._key }, data: { value: JSON.stringify(next) } }).catch(() => null);
  }
  const base = await CL.baseRights(user);
  return {
    today,
    scope: tl ? 'all' : 'mine',
    counts: {
      clients: clients.length,
      requirements: live.length,
      requirementsPaused: live.filter((r) => r.status === 'ON_HOLD').length,
      followUpsDue: due.length + chase,
      followUpsClient: due.length,
      followUpsPeople: chase,
      pending: pendingReq.length + pause + imports,
    },
    clients: clients.map((c) => ({ id: c.id, name: c.name, lifecycle: CL.lifecycleOf(c.status), department: c.ownerDepartment || null })),
    requirements: reqs.map((r) => ({ id: r.id, title: r.title, code: r.reqCode || null, status: r.status, clientId: r.clientId, clientName: r.client ? r.client.name : null })),
    followUps: open.slice(0, 40).map((x) => ({ ...publicItem(x, today), clientName: nameOf.get(x.clientId) || null })),
    requests: mine.slice(0, 30),
    can: {
      addClient: await require('../middleware/auth').can(user, 'ats', 'clients', 'Add Client', 'create'), // eslint-disable-line global-require
      createRequirement: await require('../middleware/auth').can(user, 'ats', 'requirements', 'Requirement Request', 'create'), // eslint-disable-line global-require
      pause: !!(base.pauseEdit || base.resumeEdit),
      followUp: await require('../middleware/auth').can(user, 'ats', 'clients', 'Client Follow-ups', 'create'), // eslint-disable-line global-require
      submitApproval: !!base.approvalSubmit,
    },
  };
}

module.exports = { addItem, markDone, clientBusiness, workspaceFor, itemsOfClients, istToday, publicItem, KINDS };
