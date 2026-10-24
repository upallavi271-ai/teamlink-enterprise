// ---------------------------------------------------------------------------
// WHO MAY CREATE A JOB (user, 2026-10-13: "Create Req option evariki undakudadu, only for BDE Team & higher").
//
// The option to create a job (Add job / New requirement / Request a job / Copy job / Import jobs / the AI
// assistant's "add a job") exists ONLY for the BDE team and the roles above it:
//
//   Super Admin, Admin   create a job directly (live or draft, as before)
//   BDE, BDE TL          REQUEST a job: it is saved as a DRAFT that a lead opens (utils/requirementRequest.js)
//   Manager, Asst Mgr    the same request path, for a client of their area; a lead still opens it
//   HR                   INTERNAL hiring jobs only (TeamLink's own openings: no client, no BDE)
//
//   Nobody else: TL, STL, Recruiter, Accountant, Employee, and every portal login other than the client's own
//   "ask for a job" in the client portal (routes/portal.js, unchanged). A TL still edits, assigns and posts the jobs
//   of their team; for a new job they press "Ask the client manager to add a job" (utils/jobAsk.js).
//
// ONE rule, used by every route (routes/requirements.js), the AI tool, the Role Catalog's fixed-off boxes and the
// permission engine's hard lock (utils/permissions.js hardLocksFor / hardDenied), so nothing can disagree.
// A login that behaves like one of these roles (a custom role, utils/roleRegistry.js) is held to the same rule.
// ---------------------------------------------------------------------------
const REFUSAL = 'Requirements are created by the client manager (BDE) team. Ask them to add this requirement.';
const BODY = { error: REFUSAL, code: 'JOB_CREATE_NOT_YOURS' };

// The system roles whose Role Catalog boxes are fixed off, and which boxes (utils/permissions.js hardLocksFor).
const NO_CREATE_ROLES = ['TL', 'STL', 'RECRUITER', 'ACCOUNTANT', 'EMPLOYEE'];
const REQUEST_ROLES = ['BDE', 'MANAGER', 'ASSISTANT_MANAGER'];
const ASK_ROLES = ['TL', 'STL', 'RECRUITER'];

const scope = () => require('./scope'); // eslint-disable-line global-require

// What this login behaves like for creating a job.
//   'admin' | 'bde' | 'bdeTl' | 'manager' | 'am' | 'hr' | 'external' | role code of anyone else
function kindOf(user) {
  if (!user || !user.id) return 'none';
  const S = scope();
  const s = S.atsScopeOf(user);
  const role = s.atsRole;
  if (['CLIENT', 'CANDIDATE'].includes(role) || ['CLIENT', 'CANDIDATE'].includes(s.role)) return 'external';
  if (s.global) return 'admin';
  if (role === 'HR') return 'hr';
  if (S.isBdeTl(user)) return 'bdeTl';
  if (role === 'BDE') return 'bde';
  if (role === 'MANAGER') return 'manager';
  if (role === 'ASSISTANT_MANAGER') return 'am';
  return role || 'none';
}

// -> { allowed, mode: 'direct' | 'request' | 'internal' | null, kind }
//   direct   the job is created as sent (Super Admin / Admin)
//   request  the job is saved as a DRAFT request that a lead opens (BDE, BDE TL, Manager, Asst Manager)
//   internal HR creates TeamLink's OWN job (no client); a client job is refused
function canCreateJob(user, { internal = false } = {}) {
  const kind = kindOf(user);
  if (kind === 'admin') return { allowed: true, mode: 'direct', kind };
  if (kind === 'hr') return internal ? { allowed: true, mode: 'internal', kind } : { allowed: false, mode: null, kind };
  // 2026-10-13 (user: "BDE ki complete access undali, except delete"): the BDE team creates DIRECTLY; Manager / Asst Manager request.
  if (['bde', 'bdeTl'].includes(kind)) return { allowed: true, mode: 'direct', kind };
  if (['manager', 'am'].includes(kind)) return { allowed: true, mode: 'request', kind };
  return { allowed: false, mode: null, kind };
}

// A login the "Ask the client manager to add a job" button is for: it works jobs but cannot create one.
function mayAskToAdd(user) {
  const kind = kindOf(user);
  return ASK_ROLES.includes(kind);
}

// For the permission engine: is (feature, action) one of the create boxes this login must never hold?
//   'Create Requirement' / create  and  'Bulk Import' / create  = DIRECT creation: Super Admin / Admin, and HR (internal only)
//   'Requirement Request' / create = asking for a job: admins, BDE, BDE TL, Manager, Asst Manager (and the client's own portal)
//   'Bulk Import' / view           = sending a sheet of jobs (as requests): not for TL / STL / Recruiter / Accountant / Employee
function deniedFor(user, feature, action) {
  const kind = kindOf(user);
  if (kind === 'none' || kind === 'external' || kind === 'admin') return false;
  if (feature === 'Create Requirement' && action === 'create') return !['hr', 'bde', 'bdeTl'].includes(kind);
  if (feature === 'Bulk Import' && action === 'create') return !['hr', 'bde', 'bdeTl'].includes(kind);
  if (feature === 'Requirement Request' && action === 'create') return !['bde', 'bdeTl', 'manager', 'am'].includes(kind);
  if (feature === 'Bulk Import' && action === 'view') return NO_CREATE_ROLES.includes(kind);
  return false;
}

// Role Catalog: the boxes fixed OFF for a system role in the Jobs module ({ feature: [actions] } or null).
function locksForRole(role) {
  if (NO_CREATE_ROLES.includes(role)) {
    return { 'Create Requirement': ['create'], 'Requirement Request': ['create'], 'Bulk Import': ['create', 'view'], 'Requirement Detail': ['edit', 'approve'], 'Pause Requirement': ['edit'], 'Resume Requirement': ['edit'], 'Close Request': ['create'] };
  }
  if (role === 'HR') return { 'Requirement Request': ['create'] };
  // 2026-10-16: the BDE team deletes a job of their own area too, so delete is not locked off for the BDE.
  // The BDE (and, by the same row, the BDE team lead) CREATES a requirement and imports a sheet of requirements directly
  // (canCreateJob / deniedFor: the BDE team is allowed both), so nothing is fixed off for the BDE row. Only the Manager and the
  // Asst Manager still go through a request.
  if (role === 'BDE') return null;
  if (REQUEST_ROLES.includes(role)) return { 'Create Requirement': ['create'], 'Bulk Import': ['create'] };
  return null;
}

// The plain reason shown above the Role Catalog boxes of this role (empty string when none).
function lockNoteFor(role) {
  if (NO_CREATE_ROLES.includes(role)) {
    return 'Creating a requirement is only for the client manager (BDE) team and the roles above it. For this role the create boxes stay off whatever is ticked; the team lead asks the client manager to add a requirement instead. Changing or closing a requirement is also the client manager (BDE) team: Edit, Pause, Resume and Close stay off; assigning people and posting are not affected.';
  }
  if (role === 'HR') return 'HR adds TeamLink\'s own openings (internal hiring) only. Client requirements are created by the client manager (BDE) team, so "Create a request" stays off.';
  if (role === 'BDE') return 'The client manager (BDE) has complete access to a requirement: create, edit, hold, assign, post, close and reopen. Delete is theirs too, for requirements of their own area (never a requirement that has people or invoices on it).';
  if (REQUEST_ROLES.includes(role)) return 'This role asks for a requirement with "Create (a request a lead opens)"; a lead opens the requirement before it goes live. The direct create and import boxes stay off.';
  return '';
}

// Express guard for the routes that create a job. `needs` is 'direct' (only a login that creates the job as sent:
// Admin, HR for internal) or 'any' (any allowed mode, a request included). A refusal is the one plain sentence.
function requireJobCreate({ needs = 'any', internalOf = null } = {}) {
  return (req, res, next) => {
    try {
      const internal = typeof internalOf === 'function' ? !!internalOf(req) : false;
      const out = canCreateJob(req.user, { internal });
      req.jobCreate = out;
      if (!out.allowed) return res.status(403).json(BODY);
      if (needs === 'direct' && out.mode === 'request') return res.status(403).json(BODY);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// EDIT AND CLOSE A JOB are the BDE team's and above too (user, 2026-10-13: "oka req ni EDIT, CLOSE chesey option kuda BDE team ki undali").
//   Edit the job's details (title, description, skills, salary, openings, location, priority, hold / resume / activate / close)
//   = 'Requirement Detail' edit / approve, 'Pause Requirement' / 'Resume Requirement' edit, 'Close Request' create.
//   NOT affected: assigning people (TL / recruiter: 'assign'), viewing, candidates, posting the job text (a TL still posts).
//   Super Admin / Admin: directly. Manager: closes / holds directly (approve), as before. Asst Manager: hold only, as before.
//   BDE, BDE TL: edit own clients' jobs; a desk BDE ASKS to close (a Manager / Admin approves), as built.
//   TL, STL, Recruiter, Accountant, Employee: none; the TL / STL / Recruiter press "Ask the client manager to edit or close this job".
// ---------------------------------------------------------------------------
const MANAGE_REFUSAL = 'Requirements are changed or closed by the client manager (BDE) team. Ask them.';
const MANAGE_BODY = { error: MANAGE_REFUSAL, code: 'JOB_CHANGE_NOT_YOURS' };
const MANAGE_BOXES = { 'Requirement Detail': ['edit', 'approve'], 'Pause Requirement': ['edit'], 'Resume Requirement': ['edit'], 'Close Request': ['create'] };

// can this login change or close a job at all (the rule, before any record check)?
function mayManageJobs(user) {
  const kind = kindOf(user);
  return !NO_CREATE_ROLES.includes(kind);
}
// permission engine: is this edit / close box one this login must never hold?
function manageDeniedFor(user, feature, action) {
  if (!(MANAGE_BOXES[feature] || []).includes(action)) return false;
  const kind = kindOf(user);
  if (kind === 'none' || kind === 'external') return false;
  return NO_CREATE_ROLES.includes(kind);
}
function manageLocksForRole(role) {
  return NO_CREATE_ROLES.includes(role) ? MANAGE_BOXES : null;
}
const MANAGE_NOTE = ' Changing or closing a requirement is also the client manager (BDE) team: Edit, Pause, Resume and Close stay off; assigning people and posting are not affected.';
// Express guard: the plain sentence for a TL / STL / Recruiter ... before any other check.
function requireJobManage() {
  return (req, res, next) => (mayManageJobs(req.user) ? next() : res.status(403).json(MANAGE_BODY));
}

module.exports = {
  MANAGE_REFUSAL, MANAGE_BODY, MANAGE_BOXES, MANAGE_NOTE, mayManageJobs, manageDeniedFor, manageLocksForRole, requireJobManage,
  REFUSAL, BODY, NO_CREATE_ROLES, REQUEST_ROLES, ASK_ROLES,
  kindOf, canCreateJob, mayAskToAdd, deniedFor, locksForRole, lockNoteFor, requireJobCreate,
};
