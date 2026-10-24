// ---------------------------------------------------------------------------
// SUPER ADMIN "VIEW AS" — see utils/viewAs.js for the whole design.
//
//   GET  /api/admin/view-as/people   the picker: every active login a Super
//                                    Admin may view as, grouped by role, with
//                                    department / section / seat
//   POST /api/admin/view-as/exit     end the current View-as session (called
//                                    WITH the View-as token; allow-listed)
//   POST /api/admin/view-as/:userId  start: a 60-minute read-only token for
//                                    the target
//
// Super Admin only — Admin, Manager and everybody else get 403. The target's
// own session, tokens and password are never touched.
// ---------------------------------------------------------------------------
const express = require('express');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveIdentity, tokenPayload } = require('../utils/identity');
const { scopeLabel } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const { isStrictSystemAccount: isSystemAccount } = require('../utils/systemAccounts'); // the ROLE test: a Super Admin is never viewed as, whatever counts as an employee
const va = require('../utils/viewAs');
const actAs = require('../utils/actAs');
const { ipOf } = require('../utils/clientIp');

const router = express.Router();

const named = (v) => (v && v !== 'NONE' ? v : null);

// The picker's groups, in the order the screen lists them.
const GROUPS = [
  ['MANAGER', 'Manager'], ['ASSISTANT_MANAGER', 'Assistant Manager'], ['STL', 'STL'], ['TL', 'TL'],
  ['RECRUITER', 'Recruiter'], ['BDE', 'BDE'], ['HR', 'HR'], ['ACCOUNTANT', 'Accountant'], ['ADMIN', 'Admin'],
  ['EMPLOYEE', 'Employee'], ['CLIENT', 'Client login'], ['CANDIDATE', 'Candidate login'],
];
const GROUP_LABEL = Object.fromEntries(GROUPS);

// The ONE working role a login is filed under in the picker.
function groupOf(identity) {
  if (identity.role === 'CLIENT' || identity.atsRole === 'CLIENT') return 'CLIENT';
  if (identity.role === 'CANDIDATE' || identity.atsRole === 'CANDIDATE') return 'CANDIDATE';
  if (identity.role === 'ADMIN') return 'ADMIN';
  const ats = named((identity.scopeRoles && identity.scopeRoles.ats) || identity.atsRole);
  if (['MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'RECRUITER', 'BDE', 'HR'].includes(ats)) return ats;
  const hrms = named((identity.scopeRoles && identity.scopeRoles.hrms) || identity.hrmsRole);
  const acc = named((identity.scopeRoles && identity.scopeRoles.accounts) || identity.accountsRole);
  if (acc === 'ACCOUNTANT' || hrms === 'ACCOUNTANT' || identity.role === 'ACCOUNTANT') return 'ACCOUNTANT';
  if (hrms === 'HR' || identity.role === 'HR') return 'HR';
  if (['MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL'].includes(hrms)) return hrms;
  return 'EMPLOYEE';
}

function superAdminOnly(req, res, next) {
  if (req.viewAs) return res.status(403).json({ error: va.readOnlyMessage(req.user.name), viewAsReadOnly: true });
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only a Super Admin can use View as.' });
  }
  return next();
}

// Why a login cannot be viewed as, or null when it can.
function refusalFor(user) {
  if (!user) return { status: 404, error: 'That login does not exist.' };
  if (isSystemAccount(user)) return { status: 403, error: 'A Super Admin login cannot be viewed as.' };
  if ((user.status || 'Active') !== 'Active') return { status: 403, error: `That login is ${String(user.status).toLowerCase()} — only an active login can be viewed as.` };
  return null;
}

router.use(requireAuth);

// ---- the picker ------------------------------------------------------------
router.get('/people', superAdminOnly, async (req, res) => {
  const users = await prisma.user.findMany({
    where: { status: 'Active', NOT: { id: req.user.id } },
    orderBy: { name: 'asc' },
  });
  const candidates = users.filter((u) => !isSystemAccount(u));
  const employees = await prisma.employee.findMany({
    where: { userId: { in: candidates.map((u) => u.id) } },
    select: {
      id: true, userId: true, employeeCode: true, department: true, team: true, designation: true,
      positionAssignments: {
        where: { toDate: null },
        select: { position: { select: { code: true, name: true, department: true, team: true } } },
      },
    },
  }).catch(async () => prisma.employee.findMany({
    where: { userId: { in: candidates.map((u) => u.id) } },
    select: { id: true, userId: true, employeeCode: true, department: true, team: true, designation: true },
  }));
  const empByUser = new Map(employees.map((e) => [e.userId, e]));
  const clientIds = [...new Set(candidates.map((u) => u.clientId).filter(Boolean))];
  const clients = clientIds.length
    ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } })
    : [];
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const people = [];
  for (const u of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const identity = await resolveIdentity(u.id, u).catch(() => null);
    if (!identity) continue;
    const external = ['CLIENT', 'CANDIDATE'].includes(identity.role);
    if (!external && !identity.products.hrms && !identity.products.ats && !identity.products.accounts) continue;
    const emp = empByUser.get(u.id);
    const seats = ((emp && emp.positionAssignments) || []).map((a) => a.position).filter(Boolean);
    const group = groupOf(identity);
    let scope = '';
    try { scope = scopeLabel(identity, identity.products.ats ? 'ats' : undefined); } catch { scope = ''; }
    people.push({
      id: u.id,
      name: u.name,
      email: u.email,
      group,
      groupLabel: GROUP_LABEL[group],
      designation: identity.designation || null,
      employeeCode: identity.employeeCode || null,
      department: identity.department || null,
      section: identity.team || null,
      seats: seats.map((s) => ({ code: s.code, name: s.name, department: s.department, team: s.team })),
      client: u.clientId ? (clientName.get(u.clientId) || null) : null,
      scope,
      landingPath: identity.landingPath,
    });
  }
  res.json({ groups: GROUPS.map(([code, label]) => ({ code, label })), people });
});

// ---- exit (called with the View-as token) -------------------------------------
router.post('/exit', async (req, res) => {
  if (!req.viewAs) return res.json({ ok: true, wasViewingAs: false });
  const { byUserId, byName, sid } = req.viewAs;
  const blocked = va.takeBlocked(sid);
  va.markEnded(sid);
  await va.withWrites(() => logAudit({
    userId: byUserId, actorName: byName, action: 'View as ended', entity: 'User', entityId: req.user.id,
    toValue: `${req.user.name} — ${blocked} write attempt${blocked === 1 ? '' : 's'} blocked`,
    reason: va.sessionReason(sid),
  }));
  res.json({ ok: true, wasViewingAs: true, blocked });
});

// ---- ACT AS (the edit twin, utils/actAs.js) -----------------------------------
// Opens an Act-as session for `target`, answers with the token. `viewer` = the
// real Super Admin user row. Audit writes go through va.withWrites so the same
// helper works from inside a View-as session (switch-to-act).
async function openActSession(req, res, viewer, target, extra = '') {
  const identity = await resolveIdentity(target.id, target);
  const refusal = actAs.refusalFor(identity, target);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });
  if (!identity.products.hrms && !identity.products.ats && !identity.products.accounts) {
    return res.status(400).json({ error: 'This login has no product access yet — there is nothing to act on.' });
  }
  const sid = va.newSid();
  const { token, exp } = actAs.signActToken(identity, tokenPayload, viewer, sid);
  va.markLive(sid);
  const group = groupOf(identity);
  await va.withWrites(() => logAudit({
    userId: viewer.id, actorName: viewer.name, action: 'Act as started', entity: 'User', entityId: target.id,
    field: 'onBehalfOf', fieldLabel: target.name, fromValue: ipOf(req),
    toValue: `${target.name} · ${GROUP_LABEL[group]}${identity.department ? ` · ${identity.department}` : ''} (real changes, ${actAs.ACT_AS_MINUTES} min)${extra}`,
    reason: va.sessionReason(sid),
  }));
  return res.json({
    token,
    mode: 'act',
    expiresAt: new Date(exp * 1000).toISOString(),
    target: { id: target.id, name: target.name, role: GROUP_LABEL[group], landingPath: identity.landingPath },
  });
}

// Is the real person behind this request an active Super Admin? (row, or null)
async function realSuperAdmin(userId) {
  const u = await prisma.user.findUnique({ where: { id: String(userId || '') } }).catch(() => null);
  return u && u.role === 'SUPER_ADMIN' && (u.status || 'Active') === 'Active' ? u : null;
}

// The "Acted as" list on Administration -> Users (Super Admin only).
router.get('/act-history', superAdminOnly, async (req, res) => {
  res.json({ sessions: await actAs.history({ days: Math.min(365, Math.max(1, Number(req.query.days) || 90)) }) });
});

// From a View-as session (called WITH the View-as token): the same person, now editable.
router.post('/switch-to-act', async (req, res) => {
  if (!req.viewAs) return res.status(400).json({ error: 'Start View as first, then switch to Act as.' });
  const viewer = await realSuperAdmin(req.viewAs.byUserId);
  if (!viewer) return res.status(403).json({ error: 'Only a Super Admin can use Act as.' });
  const target = await prisma.user.findUnique({ where: { id: req.user.id } });
  const refusal = actAs.refusalFor(await resolveIdentity(target.id, target), target);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });
  va.markEnded(req.viewAs.sid);
  await va.withWrites(() => logAudit({
    userId: viewer.id, actorName: viewer.name, action: 'View as ended', entity: 'User', entityId: target.id,
    toValue: `${target.name} — switched to Act as`, reason: va.sessionReason(req.viewAs.sid),
  }));
  return openActSession(req, res, viewer, target, ' — switched from View as');
});

// End Act as (called WITH the Act-as token).
async function endActSession(req, note) {
  const { sid, byUserId, byName } = req.actingAs;
  va.markEnded(sid);
  const changes = await prisma.auditLog.count({
    where: { action: 'Acted as: change', reason: { startsWith: va.sessionReason(sid) } },
  });
  await logAudit({
    userId: byUserId, actorName: byName, action: 'Act as ended', entity: 'User', entityId: req.user.id,
    field: 'onBehalfOf', fieldLabel: req.user.name, fromValue: ipOf(req),
    toValue: `${req.user.name} — ${changes} change${changes === 1 ? '' : 's'}${note || ''}`, reason: va.sessionReason(sid),
  });
  return changes;
}
router.post('/act-exit', async (req, res) => {
  if (!req.actingAs) return res.json({ ok: true, wasActing: false });
  const changes = await endActSession(req);
  return res.json({ ok: true, wasActing: true, changes });
});
// "Back to read-only view": end Act as, hand back a View-as token for the same person.
router.post('/back-to-read-only', async (req, res) => {
  if (!req.actingAs) return res.status(400).json({ error: 'You are not acting as anyone.' });
  const viewer = await realSuperAdmin(req.actingAs.byUserId);
  if (!viewer) return res.status(403).json({ error: 'Only a Super Admin can use View as.' });
  const target = await prisma.user.findUnique({ where: { id: req.user.id } });
  const identity = await resolveIdentity(target.id, target);
  await endActSession(req, ' — went back to read-only View as');
  const sid = va.newSid();
  const viewAs = { byUserId: viewer.id, byName: viewer.name, readOnly: true, sid };
  const token = jwt.sign({ ...tokenPayload(identity), viewAs }, process.env.JWT_SECRET, { expiresIn: `${va.VIEW_AS_MINUTES}m` });
  const { exp } = jwt.decode(token);
  va.markLive(sid);
  const group = groupOf(identity);
  await va.withWrites(() => logAudit({
    userId: viewer.id, actorName: viewer.name, action: 'View as started', entity: 'User', entityId: target.id,
    toValue: `${target.name} · ${GROUP_LABEL[group]}${identity.department ? ` · ${identity.department}` : ''} (read-only, ${va.VIEW_AS_MINUTES} min)`,
    reason: va.sessionReason(sid),
  }));
  return res.json({
    token, mode: 'view', expiresAt: new Date(exp * 1000).toISOString(),
    target: { id: target.id, name: target.name, role: GROUP_LABEL[group], landingPath: identity.landingPath },
  });
});

// Start Act as straight from the picker (Super Admin only; no View as needed first).
router.post('/:userId/act', superAdminOnly, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.userId) } });
  if (target && target.id === req.user.id) return res.status(400).json({ error: 'You are already signed in as yourself.' });
  if (!target) return res.status(404).json({ error: 'That login does not exist.' });
  return openActSession(req, res, req.user, target);
});

// ---- start ---------------------------------------------------------------
router.post('/:userId', superAdminOnly, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.userId) } });
  if (target && target.id === req.user.id) return res.status(400).json({ error: 'You are already signed in as yourself.' });
  const refusal = refusalFor(target);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });
  const identity = await resolveIdentity(target.id, target);
  const external = ['CLIENT', 'CANDIDATE'].includes(identity.role);
  if (!external && !identity.products.hrms && !identity.products.ats && !identity.products.accounts) {
    return res.status(400).json({ error: 'This login has no product access yet — there is nothing to view.' });
  }
  const sid = va.newSid();
  const viewAs = { byUserId: req.user.id, byName: req.user.name, readOnly: true, sid };
  const token = jwt.sign({ ...tokenPayload(identity), viewAs }, process.env.JWT_SECRET, { expiresIn: `${va.VIEW_AS_MINUTES}m` });
  const { exp } = jwt.decode(token);
  va.markLive(sid);
  const group = groupOf(identity);
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'View as started', entity: 'User', entityId: target.id,
    toValue: `${target.name} · ${GROUP_LABEL[group]}${identity.department ? ` · ${identity.department}` : ''} (read-only, ${va.VIEW_AS_MINUTES} min)`,
    reason: va.sessionReason(sid),
  });
  res.json({
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
    target: { id: target.id, name: target.name, role: GROUP_LABEL[group], landingPath: identity.landingPath },
  });
});

module.exports = router;
module.exports.groupOf = groupOf;
