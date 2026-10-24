// ---------------------------------------------------------------------------
// INTERNAL HR  (user, 2026-10-10, confirmed 2026-10-13)  --  the FLOOR-HR department.
//
//   "Create one department, like an HR role, like FLOOR HR: take the floor's
//    ATTENDANCE and LEAVES data, collect it, and do LEAVE APPROVALS like a
//    Super Admin, but the DELETE options are not available."
//
// Whoever sits in the DEPARTMENT "Internal HR" (employee.department) gets, in
// HRMS only, on top of the role they already hold (their own role is NOT changed):
//
//   * every department's ATTENDANCE and LEAVE data: see it, collect it, import
//     it, enter / correct it, and approve / reject / reassign leave,
//     regularizations and late-coming requests at ANY step of the chain (like a
//     Super Admin; nobody approves their own request);
//   * the employee directory (view only, masked like a TL's: utils/employeeRedact.js)
//     and the Helpdesk (view);
//   * NEVER any delete (INTERNAL_HR_BLOCKED, one list) and never settings
//     (policies, leave types, check-in rules ...).
//
// NOT included (stays as today): payroll, payslips, salary, Accounts, ATS client data,
// Role Catalog, Integrations, Users / roles, exit final approval, company settings.
//
// A DEPARTMENT rule: moving into the department gives it, moving out removes it.
// Company Setup -> Departments carries the switch (AppSetting 'internal-hr-access'):
// on / off for the whole department, and a short list of employee IDs held to VIEW
// ONLY (e.g. TL309).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { sourceOf } = require('./roleAccess');

const DEPARTMENT = 'Internal HR';
// Seat codes (the first word decides the department): IHR-TL, IHR-1 ...;
// "Internal HR TL" is read the same way.
const SEAT_TOKENS = ['IHR', 'INTERNAL'];
const SETTINGS_KEY = 'internal-hr-access';
const DEFAULTS = { enabled: true, viewOnly: [] };

// ---------------------------------------------------------------------------
// WHAT INTERNAL HR CAN NEVER DO. One list; add a row to block more.
//   area    the legacy HRMS area the permission guards use ('Employee Management')
//   action  the engine action ('delete')    (area omitted = every area)
// can() and effectiveMatrix() refuse these for an Internal HR login whatever the
// Role Catalog says, so the button is not drawn either. Delete ROUTES that are
// guarded by another action (a holiday is deleted with `edit`) use blockRoute().
// ---------------------------------------------------------------------------
const INTERNAL_HR_BLOCKED = [
  { id: 'delete', action: 'delete', label: 'Delete anything', message: 'Only Super Admin can delete. You can cancel or close with a reason instead.' },
  { id: 'employee.delete', area: 'Employee Management', action: 'delete', label: 'Delete an employee', message: 'Only Super Admin can delete an employee.' },
  { id: 'settings', label: 'Change settings', message: 'Settings are for the Super Admin.' },
];

// THE ALLOWLIST: the HRMS features Internal HR gets on top of its own role.
//   write   actions given on every feature of the module (admin mode)
//   read    actions given in view-only mode and on read-only features
//   configure   features that may also `configure` (the import screens)
//   readOnly    features given the read actions only (admin mode too)
const READ = ['view', 'export'];
const WRITE = ['view', 'export', 'create', 'edit', 'approve', 'assign'];
const ALLOW = {
  hrms_attendance: { features: '*', readOnlyFeatures: ['Attendance Policy', 'Check-in Alerts', 'Shift Patterns'], configure: ['Import History'] },
  hrms_leave: { features: '*', readOnlyFeatures: ['Leave Policy'], configure: ['Leave Balances'] },
  hrms_dashboard: { features: '*', readOnlyFeatures: ['HRMS Dashboard'], configure: [] },
  hrms_employees: { features: ['Employee List', 'TL-wise View'], readOnlyFeatures: ['Employee List', 'TL-wise View'], configure: [] },
  hrms_services: { features: ['Helpdesk'], readOnlyFeatures: ['Helpdesk'], configure: [] },
};
// The approval chains Internal HR may decide DIRECTLY (out of turn), like a Super Admin.
const DIRECT_WORKFLOWS = ['leave', 'regularization', 'latePermission'];

// Request paths where Internal HR sees EVERY employee (scope). Everything else (payroll,
// LMS, tasks ...) keeps the person's own scope.
const SCOPE_PREFIXES = [
  '/api/attendance', '/api/leave', '/api/late-permissions', '/api/employees', '/api/helpdesk',
  '/api/hrms/dashboard', '/api/insights', '/api/io', '/api/approvals', '/api/auth', '/api/employee-fields',
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const isInternalHrName = (d) => ['internalhr', 'ihr'].includes(norm(d));

// ---- switches -------------------------------------------------------------
let cache = null;
let cacheAt = 0;
const CACHE_MS = 8000;
function invalidate() { cache = null; }

function clean(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    enabled: o.enabled !== false,
    viewOnly: Array.isArray(o.viewOnly) ? [...new Set(o.viewOnly.map((x) => String(x).trim().toUpperCase()).filter(Boolean))] : [],
  };
}
async function settings() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  let v = {};
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    v = row ? JSON.parse(row.value) : {};
  } catch { v = {}; }
  cache = clean(v);
  cacheAt = Date.now();
  return cache;
}
async function saveSettings(next, user) {
  const value = JSON.stringify(clean(next));
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  invalidate();
  return settings();
}

// ---- who is Internal HR ---------------------------------------------------
// Returns null (not a member / switched off) or { member, mode: 'admin' | 'view', scopeAll }.
async function resolveFor(employee, user, products) {
  if (!employee || !user) return null;
  if (!isInternalHrName(employee.department)) return null;
  if (['Relieved', 'Exited'].includes(employee.employmentStatus)) return null;
  if (!products || !products.hrms) return null;
  if (['CLIENT', 'CANDIDATE', 'SUPER_ADMIN', 'ADMIN'].includes(user.role)) return null;
  const cfg = await settings();
  if (!cfg.enabled) return null;
  const viewOnly = cfg.viewOnly.includes(String(employee.employeeCode || '').toUpperCase());
  return {
    member: true,
    mode: viewOnly ? 'view' : 'admin',
    department: DEPARTMENT,
    // set per request by middleware/auth.js (setScopeFor)
    scopeAll: false,
    blocked: INTERNAL_HR_BLOCKED.map((b) => ({ id: b.id, label: b.label, message: b.message })),
  };
}
// Per request: is this the kind of request where Internal HR sees every employee?
function setScopeFor(ih, req) {
  if (!ih) return;
  const url = String((req && (req.baseUrl || req.originalUrl)) || '');
  ih.scopeAll = SCOPE_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
}
const scopeAll = (user) => !!(user && user.internalHr && user.internalHr.scopeAll);

// ---- the permission overlay (read by permissions.js) ----------------------
function blockedBy(moduleId, feature, action) {
  const area = sourceOf(moduleId, feature);
  return INTERNAL_HR_BLOCKED.find((b) => b.action && b.action === action && (!b.area || b.area === area)) || null;
}
// True when this Internal HR login must be REFUSED this (module, feature, action).
function denies(ih, moduleId, feature, action) {
  if (!ih) return false;
  return !!blockedBy(moduleId, feature, action);
}
// True when the overlay GRANTS it on top of the person's own role.
function overlayAllows(ih, moduleId, feature, action) {
  if (!ih) return false;
  const rule = ALLOW[moduleId];
  if (!rule) return false;
  if (rule.features !== '*' && !rule.features.includes(feature)) return false;
  if (denies(ih, moduleId, feature, action)) return false;
  if (READ.includes(action)) return true;
  if (ih.mode !== 'admin') return false;
  if ((rule.readOnlyFeatures || []).includes(feature)) return false;
  if (action === 'configure') return (rule.configure || []).includes(feature);
  return WRITE.includes(action);
}

// May this login decide a request of this chain at ANY step (out of turn)?
// The caller still refuses the person's own request.
function mayDecideDirect(user, workflowId) {
  return !!(user && user.internalHr && user.internalHr.mode === 'admin' && DIRECT_WORKFLOWS.includes(workflowId));
}

function messageFor(id) {
  const b = INTERNAL_HR_BLOCKED.find((x) => x.id === id);
  return b ? b.message : 'This action is not available to Internal HR.';
}
// Express guard for a route Internal HR must never run (a delete guarded by `edit`, a settings change).
function blockRoute(id) {
  return (req, res, next) => {
    if (req.user && req.user.internalHr) return res.status(403).json({ error: messageFor(id) });
    return next();
  };
}

module.exports = {
  DEPARTMENT,
  SEAT_TOKENS,
  SETTINGS_KEY,
  DEFAULTS,
  INTERNAL_HR_BLOCKED,
  ALLOW,
  DIRECT_WORKFLOWS,
  isInternalHrName,
  settings,
  saveSettings,
  invalidate,
  clean,
  resolveFor,
  setScopeFor,
  scopeAll,
  denies,
  overlayAllows,
  mayDecideDirect,
  messageFor,
  blockRoute,
};
