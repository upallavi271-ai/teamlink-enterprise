// ---------------------------------------------------------------------------
// THE APPROVAL WORKFLOW ENGINE (§15/§16).
//
// One chain, one set of step states, one set of transitions — shared by every
// approval a record can climb:
//
//   Employee → TL → STL → Manager → Asst Manager → Admin → Super Admin
//
// LEAVE is wired to it today. Employee requests, ATS approvals, requirement
// approvals and Accounts approvals are the SAME shape, so adopting one means
// adding a WORKFLOWS entry (which record it hangs off, which employee the
// chain is resolved from, which permission feature guards it) and calling
// start() / act() from that router. Nothing in this file mentions leave
// outside the WORKFLOWS registry at the bottom.
//
// THIS IS NOT A SECOND PERMISSION SYSTEM. Every "may this login act?" question
// is answered by can() in utils/permissions.js, and every "may this login see
// the record?" question is answered by utils/scope.js — the workflow only adds
// the ORDERING rule (you may act when it is your turn) and the CHAIN-MEMBERSHIP
// rule (being named on a chain lets you watch the request you are part of).
//
// THERE IS NO SCHEDULER IN THIS APP. `pendingSince`, `pendingForHours`,
// `dueAt` and `overdue` are COMPUTED ON READ from activatedAt + the level's
// SLA hours. Nothing ages a row in the background; a step that blew its due
// date starts reading "Overdue" the next time somebody loads the screen.
// ---------------------------------------------------------------------------

const prisma = require('./../db');
const { can } = require('./permissions');
const { employeeInScope } = require('./scope');

// --- The chain -------------------------------------------------------------
// ONE ordered ladder. `seq` is stored on every step so the order a request
// climbed is a fact about that request, not something re-derived later from a
// list that may since have changed.
const LEVELS = [
  { level: 'EMPLOYEE', label: 'Employee', seq: 1, applicant: true },
  { level: 'TL', label: 'TL', seq: 2 },
  { level: 'STL', label: 'STL', seq: 3 },
  { level: 'MANAGER', label: 'Manager', seq: 4 },
  { level: 'ASSISTANT_MANAGER', label: 'Asst Manager', seq: 5 },
  { level: 'ADMIN', label: 'Admin', seq: 6 },
  { level: 'SUPER_ADMIN', label: 'Super Admin', seq: 7 },
];
const LEVEL_BY_ID = Object.fromEntries(LEVELS.map((l) => [l.level, l]));
const APPROVAL_LEVELS = LEVELS.filter((l) => !l.applicant);

// --- How a level is CONFIGURED --------------------------------------------
// "each level approval required aa / visibility-only aa separate ga define
// cheyyali" — every level is one of exactly two things:
//
//   REQUIRED   — the request STOPS here and waits for this person's decision.
//   VISIBILITY — this person SEES the request and is notified, and the request
//                never waits on them.
//
// A seven-step mandatory chain for a one-day casual leave would be absurd, so
// the chain is the MODEL and this is the POLICY. Rows live in
// ApprovalLevelConfig and are edited on Leave → Approval Workflow Levels.
const MODE_REQUIRED = 'required';
const MODE_VISIBILITY = 'visibility';
const MODES = [MODE_REQUIRED, MODE_VISIBILITY];

// --- Step states -----------------------------------------------------------
const ST = {
  APPLIED: 'Applied', // the employee's own row — the ✓ at the top
  PENDING: 'Pending', // ● the current owner
  APPROVED: 'Approved', // ✓
  REJECTED: 'Rejected', // ✗ — ends the workflow
  WAITING: 'Waiting', // ○ a required level further up the ladder
  VISIBILITY: 'Visibility', // ○ can see, never gates
  SKIPPED: 'Skipped', // ○ nobody holds this level here
};

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const named = (v) => (v && v !== 'NONE' ? v : null);

// ---------------------------------------------------------------------------
// RESOLVING THE CHAIN FROM REAL DATA.
//
// There is a real reporting structure in this database and the chain is read
// out of it, never invented:
//
//   TL      Employee.tl (the name HR typed on the employee record)
//           → else Employee.reportingManagerId when that person is a TL
//           → else a TL in the same department AND team
//           → else a TL in the same department
//   STL     Employee.stl → else an STL whose department or configured scope
//           covers this employee's department
//   Manager / Asst Manager
//           a login holding that role whose configured scope departments
//           (User.atsScopeDepartments — the same column utils/scope.js reads)
//           cover this employee's department, or who sits in it
//   Admin / Super Admin
//           the company-level logins, which are global by definition
//
// WHERE A LEVEL HAS NOBODY, THE STEP IS SKIPPED AND SAYS SO. A chain must
// never dead-end because an employee's department has no Assistant Manager.
// ---------------------------------------------------------------------------

// The HRMS role a candidate approver holds. The HRMS role is the right one:
// approving a colleague's leave is HRMS work, and an HRMS Employee who is an
// ATS TL does not approve leave.
function hrmsRoleOf(user) {
  if (!user) return null;
  return named(user.hrmsRole) || user.role || null;
}

function scopeDepartmentsOf(candidate) {
  const fromUser = csv(candidate.user && candidate.user.atsScopeDepartments);
  if (fromUser.length) return fromUser;
  return candidate.department ? [candidate.department] : [];
}

async function candidateApprovers() {
  const rows = await prisma.employee.findMany({
    where: { employmentStatus: { not: 'Relieved' }, NOT: { userId: null } },
    include: {
      user: {
        select: {
          id: true, name: true, email: true, role: true, hrmsRole: true,
          atsScopeDepartments: true, atsScopeTeams: true, status: true, hrmsAccess: true,
        },
      },
    },
    orderBy: { name: 'asc' },
  });
  return rows.filter((e) => e.user && (e.user.status || 'Active') === 'Active');
}

function pick(list, predicates) {
  for (const p of predicates) {
    const hit = list.find(p);
    if (hit) return hit;
  }
  return null;
}

// The seven resolved people (or nulls) for one applicant.
async function resolveChain(employee) {
  const all = await candidateApprovers();
  const dept = employee.department || null;
  const team = employee.team || null;
  // Never your own approver.
  const others = all.filter((e) => e.id !== employee.id);
  const byRole = (role) => others.filter((e) => hrmsRoleOf(e.user) === role);
  const sameName = (name) => (e) => name && e.name && e.name.toLowerCase() === String(name).toLowerCase();
  const covers = (e) => !dept || scopeDepartmentsOf(e).includes(dept) || e.department === dept;

  const tls = byRole('TL');
  const stls = byRole('STL');

  const tl = pick(tls, [sameName(employee.tl)])
    || (employee.reportingManagerId
      ? others.find((e) => e.id === employee.reportingManagerId && hrmsRoleOf(e.user) === 'TL')
      : null)
    || pick(tls, [
      (e) => e.department === dept && !!team && e.team === team,
      (e) => e.department === dept,
      (e) => covers(e),
    ]);

  const stl = pick(stls, [sameName(employee.stl)])
    || pick(stls, [(e) => e.department === dept, (e) => covers(e)]);

  // DEPARTMENT ISOLATION REACHES THE CHAIN TOO. A Manager whose configured
  // scope does not cover this employee's department is not this employee's
  // manager, and the level is SKIPPED rather than filled with the wrong
  // person — which is exactly what an Assistant Manager scoped to IT and
  // Manufacturing gets on a Medical employee's leave.
  const manager = pick(byRole('MANAGER'), [(e) => covers(e)]);
  const asstManager = pick(byRole('ASSISTANT_MANAGER'), [(e) => covers(e)]);
  // Admin and Super Admin are company-level by definition — the account-level
  // role decides, exactly as GLOBAL_SCOPE_ROLES does in utils/scope.js.
  const admin = others.find((e) => e.user.role === 'ADMIN') || null;
  const superAdmin = others.find((e) => e.user.role === 'SUPER_ADMIN') || null;

  return {
    TL: tl, STL: stl, MANAGER: manager, ASSISTANT_MANAGER: asstManager,
    ADMIN: admin, SUPER_ADMIN: superAdmin,
  };
}

// ---------------------------------------------------------------------------
// LEVEL CONFIGURATION. Created lazily from the workflow's defaults the first
// time it is read, the way leave balances are, so adopting a workflow needs no
// backfill migration.
// ---------------------------------------------------------------------------
async function levelConfig(workflowId) {
  const wf = WORKFLOWS[workflowId];
  if (!wf) throw new Error(`Unknown approval workflow "${workflowId}"`);
  let rows = await prisma.approvalLevelConfig.findMany({ where: { workflow: workflowId } });
  const have = new Set(rows.map((r) => r.level));
  const missing = APPROVAL_LEVELS
    .filter((l) => !have.has(l.level))
    .map((l) => ({
      workflow: workflowId,
      level: l.level,
      seq: l.seq,
      mode: (wf.defaults[l.level] || {}).mode || MODE_VISIBILITY,
      slaHours: (wf.defaults[l.level] || {}).slaHours ?? null,
      active: true,
    }));
  if (missing.length) {
    await prisma.approvalLevelConfig.createMany({ data: missing });
    rows = await prisma.approvalLevelConfig.findMany({ where: { workflow: workflowId } });
  }
  return Object.fromEntries(rows.map((r) => [r.level, r]));
}

async function levelConfigList(workflowId) {
  const cfg = await levelConfig(workflowId);
  return APPROVAL_LEVELS.map((l) => ({
    level: l.level,
    label: l.label,
    seq: l.seq,
    mode: cfg[l.level] ? cfg[l.level].mode : MODE_VISIBILITY,
    slaHours: cfg[l.level] ? cfg[l.level].slaHours : null,
    active: cfg[l.level] ? cfg[l.level].active : true,
  }));
}

async function setLevelConfig(workflowId, level, patch) {
  if (!LEVEL_BY_ID[level] || LEVEL_BY_ID[level].applicant) {
    const err = new Error('Unknown approval level');
    err.status = 400;
    throw err;
  }
  if (patch.mode != null && !MODES.includes(patch.mode)) {
    const err = new Error(`mode must be one of ${MODES.join(' | ')}`);
    err.status = 400;
    throw err;
  }
  await levelConfig(workflowId); // make sure the row exists
  return prisma.approvalLevelConfig.update({
    where: { workflow_level: { workflow: workflowId, level } },
    data: {
      mode: patch.mode != null ? patch.mode : undefined,
      slaHours: patch.slaHours !== undefined ? (patch.slaHours == null || patch.slaHours === '' ? null : Number(patch.slaHours)) : undefined,
      active: patch.active != null ? !!patch.active : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// START — lay the chain down against one record.
// ---------------------------------------------------------------------------
const hoursFrom = (at, hours) => (hours == null ? null : new Date(new Date(at).getTime() + Number(hours) * 3600000));

async function start({ workflow, recordId, employee, applicantUserId, applicantName }) {
  const cfg = await levelConfig(workflow);
  const chain = await resolveChain(employee);
  const now = new Date();
  const used = new Set();

  const data = [{
    workflow,
    recordId,
    level: 'EMPLOYEE',
    seq: 1,
    mode: 'applicant',
    approverUserId: applicantUserId || null,
    approverName: applicantName || employee.name,
    status: ST.APPLIED,
    actedAt: now,
    actedByName: applicantName || employee.name,
    activatedAt: now,
  }];
  if (applicantUserId) used.add(applicantUserId);

  APPROVAL_LEVELS.forEach((l) => {
    const c = cfg[l.level] || {};
    const mode = c.mode || MODE_VISIBILITY;
    const person = chain[l.level];
    const base = {
      workflow, recordId, level: l.level, seq: l.seq, mode,
      slaHours: c.slaHours ?? null,
      approverUserId: person ? person.user.id : null,
      approverName: person ? person.name : null,
      approverDepartment: person ? person.department : null,
    };
    if (c.active === false) {
      data.push({ ...base, status: ST.SKIPPED, note: `${l.label} is switched off for this workflow` });
      return;
    }
    if (!person) {
      // SKIP, never dead-end — and record that it was skipped and why.
      data.push({ ...base, status: ST.SKIPPED, note: `Skipped — no ${l.label} configured for ${employee.department || 'this employee'}` });
      return;
    }
    if (used.has(person.user.id)) {
      data.push({ ...base, status: ST.SKIPPED, note: `Skipped — ${person.name} already holds an earlier step` });
      return;
    }
    used.add(person.user.id);
    data.push({ ...base, status: mode === MODE_REQUIRED ? ST.WAITING : ST.VISIBILITY });
  });

  await prisma.approvalStep.createMany({ data });
  await activateNext(workflow, recordId);
  return loadSteps(workflow, recordId);
}

function loadSteps(workflow, recordId) {
  return prisma.approvalStep.findMany({ where: { workflow, recordId }, orderBy: { seq: 'asc' } });
}

// Turn the first WAITING required step into the current owner. Returns the
// activated step, or null when the chain has no required step left (= done).
async function activateNext(workflow, recordId) {
  const steps = await loadSteps(workflow, recordId);
  const next = steps.find((s) => s.status === ST.WAITING && s.mode === MODE_REQUIRED);
  if (!next) return null;
  const now = new Date();
  return prisma.approvalStep.update({
    where: { id: next.id },
    data: { status: ST.PENDING, activatedAt: now, dueAt: hoursFrom(now, next.slaHours) },
  });
}

// ---------------------------------------------------------------------------
// READING THE WORKFLOW — the shape every screen renders.
// ---------------------------------------------------------------------------
const TERMINAL = [ST.APPROVED, ST.REJECTED, ST.APPLIED];

function stateOf(steps) {
  if (!steps.length) return null;
  if (steps.some((s) => s.status === ST.REJECTED)) return 'Rejected';
  if (steps.some((s) => s.status === ST.PENDING)) return 'Pending';
  return 'Approved';
}

// pending-since / overdue, COMPUTED ON READ. No scheduler, no cron, no job.
function ageOf(step, now = Date.now()) {
  if (!step || !step.activatedAt) return { pendingSince: null, pendingForHours: null, dueAt: null, overdue: false };
  const since = new Date(step.activatedAt);
  return {
    pendingSince: since.toISOString(),
    pendingForHours: Math.max(0, Math.round(((now - since.getTime()) / 3600000) * 10) / 10),
    dueAt: step.dueAt ? new Date(step.dueAt).toISOString() : null,
    overdue: !!(step.dueAt && now > new Date(step.dueAt).getTime()),
  };
}

function viewStep(step, now) {
  const l = LEVEL_BY_ID[step.level] || { label: step.level };
  const age = step.status === ST.PENDING ? ageOf(step, now) : { pendingSince: null, pendingForHours: null, dueAt: step.dueAt ? new Date(step.dueAt).toISOString() : null, overdue: false };
  return {
    id: step.id,
    level: step.level,
    label: l.label,
    seq: step.seq,
    mode: step.mode,
    status: step.status,
    approverUserId: step.approverUserId,
    approverName: step.approverName,
    approverDepartment: step.approverDepartment,
    actedAt: step.actedAt ? new Date(step.actedAt).toISOString() : null,
    actedByName: step.actedByName,
    note: step.note,
    slaHours: step.slaHours,
    ...age,
  };
}

// The one object the API returns and the UI renders. Everything §15 asks to
// surface is on it: Current Owner · Current Status · Next Approver ·
// Previous Approvers · Pending Since · Due Date.
async function view(workflowId, recordId, user, { canAct = false } = {}) {
  const steps = await loadSteps(workflowId, recordId);
  if (!steps.length) return null;
  const now = Date.now();
  const current = steps.find((s) => s.status === ST.PENDING) || null;
  const next = current
    ? steps.find((s) => s.seq > current.seq && s.status === ST.WAITING && s.mode === MODE_REQUIRED) || null
    : null;
  const previous = steps
    .filter((s) => [ST.APPLIED, ST.APPROVED, ST.REJECTED].includes(s.status))
    .map((s) => ({
      level: s.level,
      label: (LEVEL_BY_ID[s.level] || {}).label || s.level,
      name: s.actedByName || s.approverName,
      decision: s.status,
      actedAt: s.actedAt ? new Date(s.actedAt).toISOString() : null,
    }));
  const age = ageOf(current, now);
  return {
    workflow: workflowId,
    label: (WORKFLOWS[workflowId] || {}).label || workflowId,
    state: stateOf(steps),
    currentLevel: current ? current.level : null,
    currentLabel: current ? (LEVEL_BY_ID[current.level] || {}).label : null,
    currentOwner: current ? { userId: current.approverUserId, name: current.approverName, level: current.level, label: (LEVEL_BY_ID[current.level] || {}).label } : null,
    currentStatus: current ? 'Pending Approval' : (stateOf(steps) === 'Rejected' ? 'Rejected' : 'Fully approved'),
    nextApprover: next ? { userId: next.approverUserId, name: next.approverName, level: next.level, label: (LEVEL_BY_ID[next.level] || {}).label } : null,
    previousApprovers: previous,
    ...age,
    // "Computed on read" is a fact the screen states out loud, so nobody
    // assumes a background job is chasing these.
    ageComputedAt: new Date(now).toISOString(),
    canAct,
    steps: steps.map((s) => viewStep(s, now)),
  };
}

// The compact form a LIST row carries — no steps, so /leave stays cheap.
function summarize(steps, now = Date.now()) {
  if (!steps.length) return null;
  const current = steps.find((s) => s.status === ST.PENDING) || null;
  const next = current ? steps.find((s) => s.seq > current.seq && s.status === ST.WAITING && s.mode === MODE_REQUIRED) || null : null;
  const age = ageOf(current, now);
  return {
    state: stateOf(steps),
    currentLevel: current ? current.level : null,
    currentLabel: current ? (LEVEL_BY_ID[current.level] || {}).label : null,
    currentOwnerName: current ? current.approverName : null,
    currentOwnerUserId: current ? current.approverUserId : null,
    nextLabel: next ? (LEVEL_BY_ID[next.level] || {}).label : null,
    nextName: next ? next.approverName : null,
    approvedCount: steps.filter((s) => s.status === ST.APPROVED).length,
    requiredCount: steps.filter((s) => s.mode === MODE_REQUIRED).length,
    ...age,
  };
}

// Steps for many records at once, keyed by recordId — for list endpoints.
async function summariesFor(workflowId, recordIds) {
  if (!recordIds.length) return {};
  const steps = await prisma.approvalStep.findMany({
    where: { workflow: workflowId, recordId: { in: recordIds } },
    orderBy: { seq: 'asc' },
  });
  const now = Date.now();
  const grouped = {};
  steps.forEach((s) => { (grouped[s.recordId] = grouped[s.recordId] || []).push(s); });
  return Object.fromEntries(Object.entries(grouped).map(([id, list]) => [id, summarize(list, now)]));
}

// Every record of this workflow that names `userId` anywhere on its chain.
// This is the CHAIN-MEMBERSHIP half of visibility: everyone above in the chain
// can see the request, whether they gate it or only watch it.
async function recordIdsForParticipant(workflowId, userId) {
  if (!userId) return [];
  const rows = await prisma.approvalStep.findMany({
    where: { workflow: workflowId, approverUserId: userId },
    select: { recordId: true },
  });
  return [...new Set(rows.map((r) => r.recordId))];
}

async function isParticipant(workflowId, recordId, userId) {
  if (!userId) return false;
  const hit = await prisma.approvalStep.findFirst({
    where: { workflow: workflowId, recordId, approverUserId: userId },
    select: { id: true },
  });
  return !!hit;
}

// ---------------------------------------------------------------------------
// PERMISSION — both halves, both from the ONE engine.
//
//   ACCESS    can(user, product, module, feature, <act action>)
//   OWNERSHIP the pending step's resolved approver is this login, OR the
//             matrix grants this login the workflow's OVERRIDE action.
//
// NO ROLE NAME IS TESTED HERE. A Manager who is made view-only by taking
// `approve` off their Role Catalog row fails the access half and gets no
// buttons; a Manager who is granted it back gets them. An Admin's override is
// the `configure` action on the same feature — the action Role Catalog already
// uses for "may run this policy area", which is what an out-of-turn
// intervention is.
// ---------------------------------------------------------------------------
async function permissionFor(workflowId, user) {
  const wf = WORKFLOWS[workflowId];
  const [mayAct, override] = await Promise.all([
    can(user, wf.product, wf.module, wf.feature, wf.actAction),
    can(user, wf.product, wf.module, wf.feature, wf.overrideAction),
  ]);
  return { mayAct: mayAct || override, override };
}

// May this login SEE the record? Scope OR chain membership.
async function canSee(workflowId, recordId, user, employee) {
  if (employee && employeeInScope(user, employee)) return true;
  if (employee && user.employeeId && employee.id === user.employeeId) return true;
  return isParticipant(workflowId, recordId, user.id);
}

const DENY = {
  notFound: { status: 404, body: { error: 'Approval workflow not found for this record' } },
  finished: { status: 409, body: { error: 'This request is no longer awaiting approval' } },
  noPerm: { status: 403, body: { error: "This action isn't included in your role's permissions" } },
};

// ---------------------------------------------------------------------------
// ACT — the only transition. Approving OUT OF TURN IS REFUSED HERE, by the
// API, and not merely hidden in the browser.
// ---------------------------------------------------------------------------
async function act(workflowId, recordId, user, { decision, note }) {
  if (!['Approved', 'Rejected'].includes(decision)) {
    return { error: { status: 400, body: { error: 'decision must be Approved or Rejected' } } };
  }
  const steps = await loadSteps(workflowId, recordId);
  if (!steps.length) return { error: DENY.notFound };
  const current = steps.find((s) => s.status === ST.PENDING);
  if (!current) return { error: DENY.finished };

  const { mayAct, override } = await permissionFor(workflowId, user);
  if (!mayAct) return { error: DENY.noPerm };

  const isOwner = current.approverUserId && current.approverUserId === user.id;
  if (!isOwner && !override) {
    // The out-of-turn refusal. A login further UP the chain gets told where
    // the request actually sits rather than a flat "denied".
    const onChain = steps.some((s) => s.approverUserId === user.id);
    const label = (LEVEL_BY_ID[current.level] || {}).label || current.level;
    return {
      error: {
        status: 403,
        body: {
          error: onChain
            ? `This request is with ${label}${current.approverName ? ` (${current.approverName})` : ''}. It reaches you after they act.`
            : 'You are not an approver on this request',
          currentLevel: current.level,
          currentOwner: current.approverName || null,
        },
      },
    };
  }

  const now = new Date();
  await prisma.approvalStep.update({
    where: { id: current.id },
    data: {
      status: decision === 'Approved' ? ST.APPROVED : ST.REJECTED,
      actedAt: now,
      actedByUserId: user.id,
      actedByName: user.name || user.email,
      note: note || (override && !isOwner ? `Actioned by ${user.name || user.email} using an administrative override` : null),
    },
  });

  if (decision === 'Rejected') {
    // A rejection ends the chain. Everything still waiting is closed out so
    // the trail reads honestly instead of leaving phantom "Waiting" rows.
    await prisma.approvalStep.updateMany({
      where: { workflow: workflowId, recordId, status: { in: [ST.WAITING, ST.PENDING] } },
      data: { status: ST.SKIPPED, note: 'Not reached — the request was rejected earlier in the chain' },
    });
    return { complete: true, outcome: 'Rejected', level: current.level };
  }

  const activated = await activateNext(workflowId, recordId);
  return {
    complete: !activated,
    outcome: activated ? 'Pending' : 'Approved',
    level: current.level,
    nextLevel: activated ? activated.level : null,
  };
}

// ---------------------------------------------------------------------------
// THE REGISTRY. One entry per workflow. Leave is the only one wired today;
// the other four in §16 are the same four lines plus two calls in their
// router (start() on create, act() on decide).
// ---------------------------------------------------------------------------
const WORKFLOWS = {
  leave: {
    id: 'leave',
    label: 'Leave Approval',
    product: 'hrms',
    module: 'hrms',
    feature: 'Leave & Holidays',
    // Which matrix ACTION lets a login take their turn, and which one lets an
    // administrator step in out of turn. Both are read from the engine.
    actAction: 'approve',
    overrideAction: 'configure',
    // The policy a fresh install starts with: a leave gates at the TL and the
    // STL, and everybody above simply watches. Editable per level on the
    // Leave screen — that is the whole point of the required/visibility split.
    defaults: {
      TL: { mode: MODE_REQUIRED, slaHours: 24 },
      STL: { mode: MODE_REQUIRED, slaHours: 48 },
      MANAGER: { mode: MODE_VISIBILITY, slaHours: null },
      ASSISTANT_MANAGER: { mode: MODE_VISIBILITY, slaHours: null },
      ADMIN: { mode: MODE_VISIBILITY, slaHours: null },
      SUPER_ADMIN: { mode: MODE_VISIBILITY, slaHours: null },
    },
  },
};

module.exports = {
  LEVELS,
  APPROVAL_LEVELS,
  LEVEL_BY_ID,
  MODE_REQUIRED,
  MODE_VISIBILITY,
  MODES,
  STEP_STATUS: ST,
  WORKFLOWS,
  resolveChain,
  levelConfig,
  levelConfigList,
  setLevelConfig,
  start,
  act,
  view,
  loadSteps,
  summarize,
  summariesFor,
  stateOf,
  ageOf,
  recordIdsForParticipant,
  isParticipant,
  canSee,
  permissionFor,
};
