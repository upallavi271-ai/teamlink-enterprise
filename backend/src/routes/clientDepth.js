// ---------------------------------------------------------------------------
// /api/ats-clients - CLIENT DEPTH (audit 2026-11-18). Rules and tables: utils/clientDepth.js. TeamLink logins with ATS only (a client login has its own
// two portal routes at the bottom). Every client / requirement is checked against the login's scope first.
//
//   GET  /settings                         the three switches (Admin sees how they stand)     PUT /settings   { deskBdeSees, clientApproval, renewalReminders }  Admin
//   GET  /clients/:id/contacts             POST /clients/:id/contacts   PUT|DELETE /contacts/:cid    (unlimited contacts, role picklist)
//   GET  /clients/:id/credit               PUT /clients/:id/credit { creditDays, creditLimit }
//   GET  /clients/:id/portal-usage ?days   what the client's logins view and do (BDE / BDE TL / Manager / Admin)
//   GET  /requirements/:id/positions       PUT { positions:[{id?,title,count,ctcMin,ctcMax}] }    PUT /applications/:id/position { positionId|null }
//   GET  /requirements/:id/client-approval
//   GET  /renewals ?status=                PUT /renewals/:clientId/assign { bdeId }    POST /renewals/:clientId/renew { newStart,newEnd,note }    POST /renewals/run  Admin
//   Client portal:  GET /api/portal/client/requirement-approvals   POST /api/portal/client/requirement-approvals/:id/decide { approve, note }
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { clientWhere, applicationWhere, atsScopeOf, isBdeTl } = require('../utils/scope');
const { requirementWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const CD = require('../utils/clientDepth');

const router = express.Router();
const portalRouter = express.Router();
const DENIED = { error: "This action isn't included in your role's permissions" };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
const isClientUser = (u) => [u.role, u.atsRole].includes('CLIENT') || [u.role, u.atsRole].includes('CANDIDATE');
const levelOf = (u) => require('../utils/clientRedact').clientLevelFor(u); // eslint-disable-line global-require

router.use(requireAuth);
router.use(requireProduct('ats'));
router.use((req, res, next) => (isClientUser(req.user) ? res.status(403).json(DENIED) : next()));

async function clientOf(req, res) {
  const c = await prisma.client.findFirst({ where: { AND: [{ id: req.params.id }, clientWhere(req.user)] }, select: { id: true, name: true, bdeOwner: true } });
  if (!c) { res.status(404).json({ error: 'Client not found' }); return null; }
  return c;
}
async function requirementOf(req, res) {
  const r = await prisma.requirement.findFirst({ where: { AND: [{ id: req.params.id }, requirementWhere(req.user)] }, select: { id: true, title: true, clientId: true, internal: true, openings: true, status: true } });
  if (!r) { res.status(404).json({ error: 'Requirement not found' }); return null; }
  return r;
}

// ------------------------------------------------------------ settings
async function settingsPayload(user) {
  const [desk, approval, renewals] = [await CD.deskMode(), await CD.getSetting('clientApproval', { fresh: true }), await CD.getSetting('renewals', { fresh: true })];
  return {
    deskBdeSees: desk, deskNote: CD.DESK_NOTE[desk], deskChoices: [{ value: 'desk', label: 'All clients of their desk', note: CD.DESK_NOTE.desk }, { value: 'assigned', label: 'Only their assigned clients', note: CD.DESK_NOTE.assigned }],
    clientApproval: !!approval.enabled, renewalReminders: !!renewals.enabled, mayEdit: isAdmin(user),
  };
}
router.get('/settings', wrap(async (req, res) => res.json(await settingsPayload(req.user))));
router.put('/settings', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can change these switches.' });
  const b = req.body || {};
  if (b.deskBdeSees !== undefined && !['desk', 'assigned'].includes(b.deskBdeSees)) return res.status(400).json({ error: 'Desk BDEs see: choose "desk" or "assigned".' });
  for (const k of ['clientApproval', 'renewalReminders']) if (b[k] !== undefined && typeof b[k] !== 'boolean') return res.status(400).json({ error: `${k} must be true or false.` });
  const log = (name, from, to) => logAudit({ userId: req.user.id, action: `Setting changed: ${name}`, entity: 'AppSetting', entityId: name, fromValue: String(from), toValue: String(to) });
  if (b.deskBdeSees !== undefined) { const r = await CD.setSetting('desk', { mode: b.deskBdeSees }, req.user); await log('Desk BDEs see', r.before.mode, b.deskBdeSees); }
  if (b.clientApproval !== undefined) { const r = await CD.setSetting('clientApproval', { enabled: b.clientApproval }, req.user); await log('Client approval of a requirement', r.before.enabled, b.clientApproval); }
  if (b.renewalReminders !== undefined) { const r = await CD.setSetting('renewals', { enabled: b.renewalReminders }, req.user); await log('Renewal reminders', r.before.enabled, b.renewalReminders); }
  res.json(await settingsPayload(req.user));
}));

// ------------------------------------------------------------ contacts
router.get('/clients/:id/contacts', wrap(async (req, res) => {
  const c = await clientOf(req, res); if (!c) return;
  const level = levelOf(req.user);
  res.json({ clientId: c.id, roles: CD.ROLES, level, rows: await CD.listContacts(c.id, level), canEdit: level === 'full' && await can(req.user, 'ats', 'clients', 'Client Detail', 'edit') });
}));
async function mayEditContacts(req, res) {
  if (levelOf(req.user) !== 'full' || !(await can(req.user, 'ats', 'clients', 'Client Detail', 'edit'))) { res.status(403).json(DENIED); return false; }
  return true;
}
router.post('/clients/:id/contacts', wrap(async (req, res) => {
  if (!(await mayEditContacts(req, res))) return;
  const c = await clientOf(req, res); if (!c) return;
  const v = CD.cleanContact(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const out = await CD.addContact(c.id, v.value, req.user.name);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Client contact added', entity: 'Client', entityId: c.id, toValue: `${v.value.role}: ${v.value.name || v.value.email || v.value.phone}` });
  res.status(201).json({ id: out.id, rows: await CD.listContacts(c.id, 'full') });
}));
async function contactClient(req, res) {
  await CD.ensure();
  const [row] = await prisma.$queryRawUnsafe('SELECT "clientId" FROM "ClientContact" WHERE "id" = ?', String(req.params.cid));
  if (!row) { res.status(404).json({ error: 'Contact not found' }); return null; }
  const c = await prisma.client.findFirst({ where: { AND: [{ id: row.clientId }, clientWhere(req.user)] }, select: { id: true } });
  if (!c) { res.status(404).json({ error: 'Contact not found' }); return null; }
  return c;
}
router.put('/contacts/:cid', wrap(async (req, res) => {
  if (!(await mayEditContacts(req, res))) return;
  const c = await contactClient(req, res); if (!c) return;
  const v = CD.cleanContact(req.body || {}, true);
  if (v.error) return res.status(400).json({ error: v.error });
  const out = await CD.updateContact(req.params.cid, v.value, req.user.name);
  await logAudit({ userId: req.user.id, action: 'Client contact changed', entity: 'Client', entityId: c.id, fromValue: `${out.before.role}: ${out.before.name || ''}`, toValue: JSON.stringify(v.value).slice(0, 300) });
  res.json({ rows: await CD.listContacts(c.id, 'full') });
}));
router.delete('/contacts/:cid', wrap(async (req, res) => {
  if (!(await mayEditContacts(req, res))) return;
  const c = await contactClient(req, res); if (!c) return;
  const gone = await CD.removeContact(req.params.cid);
  await logAudit({ userId: req.user.id, action: 'Client contact removed', entity: 'Client', entityId: c.id, fromValue: `${gone.role}: ${gone.name || gone.email || gone.phone}` });
  res.json({ rows: await CD.listContacts(c.id, 'full') });
}));

// ------------------------------------------------------------ credit
router.get('/clients/:id/credit', wrap(async (req, res) => {
  const c = await clientOf(req, res); if (!c) return;
  if (!['full', 'billing'].includes(levelOf(req.user))) return res.status(403).json(DENIED);
  res.json({ clientId: c.id, ...(await CD.getCredit(c.id)), canEdit: levelOf(req.user) === 'full' && await can(req.user, 'ats', 'clients', 'Client Detail', 'edit') });
}));
router.put('/clients/:id/credit', wrap(async (req, res) => {
  if (levelOf(req.user) !== 'full' || !(await can(req.user, 'ats', 'clients', 'Client Detail', 'edit'))) return res.status(403).json(DENIED);
  const c = await clientOf(req, res); if (!c) return;
  const out = await CD.setCredit(c.id, req.body || {}, req.user.name);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Client credit terms changed', entity: 'Client', entityId: c.id, fromValue: `${out.before.creditDays == null ? 'none' : `${out.before.creditDays} days`}, limit ${out.before.creditLimit == null ? 'none' : out.before.creditLimit}`, toValue: `${out.after.creditDays == null ? 'none' : `${out.after.creditDays} days`}, limit ${out.after.creditLimit == null ? 'none' : out.after.creditLimit}` });
  res.json({ clientId: c.id, ...out.after, canEdit: true });
}));

// ------------------------------------------------------------ portal usage
router.get('/clients/:id/portal-usage', wrap(async (req, res) => {
  const s = atsScopeOf(req.user);
  const allowed = s.global || isBdeTl(req.user) || ['BDE', 'MANAGER'].includes(s.atsRole) || isAdmin(req.user);
  if (!allowed) return res.status(403).json({ error: 'Portal usage is for the BDE team, Managers and Admins.' });
  const c = await clientOf(req, res); if (!c) return;
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json({ clientId: c.id, client: c.name, ...(await CD.portalUsage(c.id, days)) });
}));

// ------------------------------------------------------------ positions
router.get('/requirements/:id/positions', wrap(async (req, res) => {
  const r = await requirementOf(req, res); if (!r) return;
  const positions = await CD.listPositions(r.id);
  res.json({ requirementId: r.id, headcount: r.openings, positions, total: positions.reduce((a, p) => a + p.count, 0), canEdit: await can(req.user, 'ats', 'requirements', 'Requirement Detail', 'edit') });
}));
router.put('/requirements/:id/positions', wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'requirements', 'Requirement Detail', 'edit'))) return res.status(403).json(DENIED);
  const r = await requirementOf(req, res); if (!r) return;
  const out = await CD.savePositions(r.id, (req.body || {}).positions);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Requirement positions changed', entity: 'Requirement', entityId: r.id, fromValue: `headcount ${r.openings}`, toValue: `${out.positions.length} position(s), headcount ${out.total}` });
  res.json({ requirementId: r.id, headcount: out.total, positions: out.positions, total: out.total });
}));
router.put('/applications/:id/position', wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'requirements', 'Requirement Detail', 'edit'))) return res.status(403).json(DENIED);
  const a = await prisma.application.findFirst({ where: { AND: [{ id: req.params.id }, applicationWhere(req.user)] }, select: { id: true, requirementId: true } });
  if (!a) return res.status(404).json({ error: 'Candidate not found' });
  const out = await CD.tagApplication(a.id, a.requirementId, (req.body || {}).positionId || null);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Candidate placed against a position', entity: 'Application', entityId: a.id, toValue: String((req.body || {}).positionId || 'none') });
  res.json({ ok: true, positions: await CD.listPositions(a.requirementId) });
}));

// ------------------------------------------------------------ client approval status
router.get('/requirements/:id/client-approval', wrap(async (req, res) => {
  const r = await requirementOf(req, res); if (!r) return;
  res.json({ enabled: !!(await CD.getSetting('clientApproval')).enabled, applies: !r.internal, approval: await CD.approvalOf(r.id) });
}));

// ------------------------------------------------------------ renewals
const mayRenew = async (u) => isAdmin(u) || isBdeTl(u) || (await can(u, 'ats', 'clients', 'Agreement Lifecycle', 'edit'));
router.get('/renewals', wrap(async (req, res) => {
  if (!(await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'view')) && !isBdeTl(req.user)) return res.status(403).json(DENIED);
  const status = ['Upcoming', 'Due', 'Expired', 'Renewed'].includes(req.query.status) ? req.query.status : 'all';
  const out = await CD.renewalRows(clientWhere(req.user), { filter: status });
  res.json({ ...out, windows: { upcomingDays: CD.UPCOMING_DAYS, dueDays: CD.DUE_DAYS }, canEdit: await mayRenew(req.user), remindersOn: !!(await CD.getSetting('renewals')).enabled });
}));
router.get('/bdes', wrap(async (req, res) => {
  if (!(await mayRenew(req.user)) && !(await can(req.user, 'ats', 'clients', 'Agreement Lifecycle', 'view'))) return res.status(403).json(DENIED);
  const rows = await prisma.user.findMany({ where: { status: 'Active', OR: [{ atsRole: 'BDE' }, { role: 'BDE' }, { atsRole: 'TL', atsDepartment: 'BDE' }] }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 200 });
  res.json({ rows: rows.filter((u) => !/zztest|example\.test/i.test(u.name)) });
}));
router.put('/renewals/:clientId/assign', wrap(async (req, res) => {
  if (!(await mayRenew(req.user))) return res.status(403).json(DENIED);
  const c = await prisma.client.findFirst({ where: { AND: [{ id: req.params.clientId }, clientWhere(req.user)] }, select: { id: true } });
  if (!c) return res.status(404).json({ error: 'Client not found' });
  const out = await CD.assignRenewal(c.id, (req.body || {}).bdeId || null, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Agreement renewal assigned', entity: 'Client', entityId: c.id, toValue: out.assignedBdeName || 'nobody' });
  res.json(out);
}));
router.post('/renewals/:clientId/renew', wrap(async (req, res) => {
  if (!(await mayRenew(req.user))) return res.status(403).json(DENIED);
  const c = await prisma.client.findFirst({ where: { AND: [{ id: req.params.clientId }, clientWhere(req.user)] }, select: { id: true } });
  if (!c) return res.status(404).json({ error: 'Client not found' });
  const out = await CD.markRenewed(c.id, req.body || {}, req.user);
  if (out.error) return res.status(400).json({ error: out.error });
  await logAudit({ userId: req.user.id, action: 'Agreement renewed', entity: 'Client', entityId: c.id, fromValue: `${out.prev.start || '-'} to ${out.prev.end}`, toValue: `${out.next.start} to ${out.next.end}` });
  res.json(out);
}));
router.post('/renewals/run', wrap(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin can run the reminders now.' });
  res.json(await CD.runRenewalReminders({ dryRun: !!(req.body || {}).dryRun }));
}));

// ------------------------------------------------------------ the client's own side (mounted on /api/portal/client, ahead of routes/portal.js)
const clientLogin = (req, res, next) => (([req.user.role, req.user.atsRole].includes('CLIENT') && req.user.clientId) ? next() : res.status(403).json({ error: 'The client portal is for client logins.' }));
portalRouter.get('/requirement-approvals', requireAuth, clientLogin, wrap(async (req, res) => {
  res.json({ rows: (await CD.getSetting('clientApproval')).enabled ? await CD.pendingApprovalsFor(req.user.clientId) : [] });
}));
portalRouter.post('/requirement-approvals/:id/decide', requireAuth, clientLogin, wrap(async (req, res) => {
  const r = await prisma.requirement.findFirst({ where: { id: req.params.id, clientId: req.user.clientId, internal: false }, select: { id: true, title: true, bdeId: true, clientId: true, tlId: true } });
  const a = r && await CD.approvalOf(r.id);
  if (!r || !a || a.state !== 'pending') return res.status(404).json({ error: 'There is nothing waiting for you to confirm here.' });
  const approve = (req.body || {}).approve === true;
  if (!approve && !String((req.body || {}).note || '').trim()) return res.status(400).json({ error: 'Tell us what to change.' });
  await CD.decideApproval(r.id, approve, req.user, (req.body || {}).note);
  await logAudit({ userId: req.user.id, action: approve ? 'Client confirmed a requirement' : 'Client declined a requirement', entity: 'Requirement', entityId: r.id, toValue: String((req.body || {}).note || '').slice(0, 200) });
  const BD = require('../utils/clientBdes'); // eslint-disable-line global-require
  await notifyUsers([...(await BD.ownerBdeIds({ bdeId: r.bdeId, clientId: r.clientId })), ...(await BD.bdeTlIds()), r.tlId], { title: `${approve ? 'Client confirmed' : 'Client declined'}: ${r.title}`, message: approve ? 'You can now activate the requirement.' : `The client asked for changes: ${String((req.body || {}).note || '').slice(0, 200)}` }).catch(() => null);
  res.json({ ok: true, state: approve ? 'approved' : 'declined' });
}));

module.exports = router;
module.exports.portalRouter = portalRouter;
