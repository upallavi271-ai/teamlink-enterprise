// ---------------------------------------------------------------------------
// CLIENT LIFECYCLE — Pause / Reactivate · Archive / Un-archive · Delete
// (user's spec 2026-10-03, list-layout-io-spec §A — binding).
//
//   Status model (Client.status is a plain string — no schema change):
//     Active    normal
//     Paused    reversible stop: NO new requirement and NO new submission to
//               the client; everything already on file is untouched
//     Archived  hidden from the default lists, data and accounting intact;
//               blocks new work exactly like Paused
//   Legacy values are DISPLAY-mapped, never rewritten:
//     Suspended -> Paused   (same meaning)
//     Inactive  -> Inactive (kept as its own legacy state: it never blocked
//                  work before this change and real clients still carry open
//                  requirements under it — Reactivate turns it into Active)
//
//   Who (permissions.js Role Catalog features, exact names):
//     'Pause / Reactivate Client'  edit = pause / reactivate directly,
//                                  create = send a pause REQUEST only
//     'Archive Client'             edit = archive / un-archive
//     'Delete Client'              delete = permanent delete (Super Admin ONLY,
//                                  and only an empty client)
//   A Manager / Assistant Manager pauses only clients of their own
//   department(s) (Client.ownerDepartment).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { can } = require('./permissions');
const { scopeOf, atsViewRole } = require('./scope');

const FEATURE_PAUSE = 'Pause / Reactivate Client';
const FEATURE_ARCHIVE = 'Archive Client';
const FEATURE_DELETE = 'Delete Client';

const LIFECYCLES = ['Active', 'Paused', 'Archived'];

function lifecycleOf(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'paused' || s === 'suspended') return 'Paused';
  if (s === 'archived') return 'Archived';
  if (s === 'inactive') return 'Inactive';
  return 'Active';
}
const isPaused = (status) => lifecycleOf(status) === 'Paused';
const isArchived = (status) => lifecycleOf(status) === 'Archived';
// Paused and Archived both stop NEW work for the client.
const blocksNewWork = (status) => ['Paused', 'Archived'].includes(lifecycleOf(status));

// The one refusal every "new work" path answers with (409).
function newWorkRefusal(client, what = 'new work') {
  if (!client || client.clientType === 'Internal' || !blocksNewWork(client.status)) return null;
  const lc = lifecycleOf(client.status);
  return {
    error: lc === 'Paused'
      ? `Client paused — reactivate first. ${client.name} is paused, so ${what} cannot be added for it until it is reactivated.`
      : `Client archived — un-archive first. ${client.name} is archived, so ${what} cannot be added for it.`,
    code: lc === 'Paused' ? 'CLIENT_PAUSED' : 'CLIENT_ARCHIVED',
    clientStatus: lc,
  };
}
async function newWorkRefusalFor(clientId, what) {
  if (!clientId) return null;
  const client = await prisma.client.findUnique({
    where: { id: clientId }, select: { id: true, name: true, status: true, clientType: true },
  });
  return newWorkRefusal(client, what);
}

// --- who may do what ---------------------------------------------------------
// THE ROLE CATALOG IS THE ONE SOURCE (2026-10-03): 'Pause / Reactivate
// Client', 'Archive Client' and 'Delete Client' are features of the clients
// module (utils/roleAccess.js) with their defaults in utils/permissions.js
// DEFAULT_RULES — SA all three · Admin pause + archive · Manager pause (own
// departments, departmentOk below) · BDE request only · everyone else none.

function heldRoles(user) {
  const u = user || {};
  const sr = u.scopeRoles || {};
  return [u.role, u.atsRole, u.hrmsRole, u.accountsRole, sr.ats, sr.hrms, sr.accounts].filter(Boolean);
}
const isSuperAdmin = (user) => heldRoles(user).includes('SUPER_ADMIN');

async function allows(user, feature, action) {
  return can(user, null, 'clients', feature, action);
}

// Manager / Assistant Manager: only clients of their own department(s).
function departmentOk(user, client) {
  if (atsViewRole(user) !== 'mgmt') return true;
  const depts = scopeOf(user).departments || [];
  return !!(client && client.ownerDepartment && depts.includes(client.ownerDepartment));
}

// The role-level answers, once per request.
async function baseRights(user) {
  const [pauseEdit, pauseRequest, archive, del] = await Promise.all([
    allows(user, FEATURE_PAUSE, 'edit'),
    allows(user, FEATURE_PAUSE, 'create'),
    allows(user, FEATURE_ARCHIVE, 'edit'),
    allows(user, FEATURE_DELETE, 'delete'),
  ]);
  return {
    pauseEdit, pauseRequest, archive,
    // DELETE IS SUPER ADMIN ONLY (binding) — whatever a catalog row says.
    delete: del && isSuperAdmin(user),
    fallback: false,
  };
}

// The buttons for ONE client, from the base rights (cheap — no query).
function rightsFor(user, client, base) {
  const lc = lifecycleOf(client && client.status);
  const internal = client && client.clientType === 'Internal';
  const pauseOk = base.pauseEdit && departmentOk(user, client);
  return {
    lifecycle: lc,
    pause: !internal && pauseOk && (lc === 'Active' || lc === 'Inactive'),
    reactivate: pauseOk && (lc === 'Paused' || lc === 'Inactive'),
    // A request is for those who cannot pause directly (the BDE).
    requestPause: !internal && !pauseOk && base.pauseRequest && lc === 'Active',
    archive: !internal && base.archive && lc !== 'Archived',
    unarchive: base.archive && lc === 'Archived',
    delete: !internal && base.delete,
  };
}

async function lifecycleRights(user, client) {
  return rightsFor(user, client, await baseRights(user));
}

// --- who hears about a pause request ------------------------------------------
// Admins (Super Admin / Admin) and the Manager(s) of the client's department.
// Never a test login (agent rules: approver resolvers exclude ZZTEST /
// example.test users).
const NOT_TEST = [
  { name: { contains: 'zztest' } },
  { email: { contains: 'example.test' } },
];
async function pauseApproverIds(client) {
  const users = await prisma.user.findMany({
    where: {
      status: 'Active',
      NOT: NOT_TEST,
      OR: [
        { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
        { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } },
        { role: 'MANAGER' },
        { atsRole: 'MANAGER' },
      ],
    },
    select: {
      id: true, role: true, atsRole: true, atsScopeDepartments: true, atsDepartment: true,
      employee: { select: { department: true } },
    },
  });
  const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  return users.filter((u) => {
    const r = [u.role, u.atsRole];
    if (r.includes('SUPER_ADMIN') || r.includes('ADMIN')) return true;
    const depts = csv(u.atsScopeDepartments).length
      ? csv(u.atsScopeDepartments)
      : [u.atsDepartment || (u.employee && u.employee.department)].filter(Boolean);
    return !!client.ownerDepartment && depts.includes(client.ownerDepartment);
  }).map((u) => u.id);
}

module.exports = {
  FEATURE_PAUSE,
  FEATURE_ARCHIVE,
  FEATURE_DELETE,
  LIFECYCLES,
  lifecycleOf,
  isPaused,
  isArchived,
  blocksNewWork,
  newWorkRefusal,
  newWorkRefusalFor,
  isSuperAdmin,
  departmentOk,
  baseRights,
  rightsFor,
  lifecycleRights,
  pauseApproverIds,
};
