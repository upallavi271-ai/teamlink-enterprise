// ---------------------------------------------------------------------------
// WHO MAY DO WHAT (server side; the screens hide buttons, this refuses).
//
//   POST (publish / republish / unpublish / update / bulk / retry / cancel / discard)
//       the ones who may post a job: TL, BDE, BDE TL, Admin, Super Admin  (feature 'Job Posting' / edit, the same
//       permission as Save & Post, and the same record rule: on the job's own chain, or the BDE TL for a client job,
//       or an Admin). A Recruiter, Manager, Assistant Manager and STL can look, never post (utils/postingGuard.js).
//   VIEW status / queue / dashboard
//       only the jobs in the viewer's own area (utils/scope.js requirementWhere): an Admin / Super Admin / Manager sees
//       all, a TL their team's, a BDE their clients'. A Recruiter sees the status of a job assigned to them: no logs,
//       no queue list, no credentials.
//   LOGS / QUEUE LIST / DEAD LETTERS
//       admin, manager, assistant manager, BDE, BDE TL, TL, STL (their own area); never a Recruiter, HR, Accounts.
//   CREDENTIALS, SWITCHES, KILL SWITCH, MAPPINGS (edit), LIMITS
//       Super Admin and Admin only (Role Catalog feature 'Job Portal Credentials').
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { can } = require('../utils/permissions');
const scope = require('../utils/scope');
const { isSuperAdmin } = require('../utils/clientLifecycle');

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const isClientLogin = (user) => [user.role, user.atsRole].some((r) => ['CLIENT', 'CANDIDATE'].includes(r));

// May this login post THIS job? (Same rule as routes/requirements.js requirementPermissions().share.)
async function mayPost(user, r) {
  if (!user || isClientLogin(user)) return false;
  if (!(await can(user, 'ats', 'requirements', 'Job Posting', 'edit'))) return false;
  const s = scope.atsScopeOf(user);
  const chain = s.global || scope.isAssignedTo(user, r);
  const bdeTlOwns = !!r && !r.internal && scope.isBdeTl(user);
  return !!(chain || bdeTlOwns);
}
// Is the job inside the viewer's own area?
function inScope(user, r) {
  if (!user || !r || isClientLogin(user)) return false;
  return scope.matches(r, scope.requirementWhere(user));
}
async function mayViewJob(user, r) {
  if (!inScope(user, r)) return false;
  return !!(await can(user, 'ats', 'requirements', 'Requirement Detail', 'view'));
}
// the logs, the queue list, the dead letters
function viewRole(user) { return scope.atsViewRole(user); }
function mayViewLogs(user) {
  if (!user || isClientLogin(user)) return false;
  return ['admin', 'mgmt', 'bde', 'tl', 'stl'].includes(viewRole(user));
}
// May this login SAVE the first login of a portal and test it? The same people who may post a job (TL, BDE, BDE TL, Admin,
// Super Admin): feature 'Job Posting' / edit. They may NOT read, replace, delete or switch on (that stays with isCredentialAdmin).
async function isPoster(user) {
  if (!user || isClientLogin(user)) return false;
  if (isSuperAdmin(user)) return true;
  return !!(await can(user, 'ats', 'requirements', 'Job Posting', 'edit').catch(() => false));
}
// the Admin screens: credentials, switches, kill switch, mappings edit, limits
async function isCredentialAdmin(user) {
  if (!user || isClientLogin(user)) return false;
  if (isSuperAdmin(user)) return true;
  return !!(await can(user, null, 'administration', 'Job Portal Credentials', 'configure').catch(() => false));
}

// The requirement ids this login may see (null = every job).
async function scopedIds(user, { limit = 5000 } = {}) {
  const where = scope.requirementWhere(user);
  if (!where || Object.keys(where).length === 0) return null;
  const rows = await prisma.requirement.findMany({ where, select: { id: true }, take: limit });
  return rows.map((r) => r.id);
}

// Can a Recruiter see the status of a job assigned to them (read only)?
async function mayViewStatus(user, r) {
  if (await mayViewJob(user, r)) return true;
  return false;
}

module.exports = {
  mayPost, inScope, mayViewJob, mayViewLogs, isCredentialAdmin, isPoster, scopedIds, mayViewStatus, viewRole, csv, isClientLogin,
};
