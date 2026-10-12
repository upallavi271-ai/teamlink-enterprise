// ---------------------------------------------------------------------------
// INTERNAL HR  (user, 2026-10-10)  --  the floor-HR department.
//
//   "Internal HR is the same as Super Admin, but not all the actions: they can
//    do everything except delete the employee."
//
// Whoever sits in the DEPARTMENT "Internal HR" (employee.department) gets, in
// HRMS only:
//   * every department's employees, attendance, leave, documents (the role they
//     already hold is lifted to the HR desk role for HRMS: utils/identity.js),
//   * plus every HRMS action a Super Admin has (utils/permissions.js can() and
//     effectiveMatrix() read overlayAllows() below),
//   * EXCEPT the actions listed in INTERNAL_HR_BLOCKED  (ONE list, one place).
//
// It is a DEPARTMENT rule, not a hand-assigned role: a person who moves into
// the department gets it, a person who moves out loses it, and nothing else
// (ATS, Accounts, Administration, Role Catalog, Users) is touched. The same
// person keeps their ATS / Accounts roles on the same login.
//
// Company Setup -> Departments carries the switches (stored in AppSetting
// 'internal-hr-access'): on/off for the whole department, "may see salary, bank,
// PAN and Aadhaar" (defaults to ON, which is what a Super Admin sees), and a
// short list of employee IDs held to VIEW ONLY (e.g. TL309), which maps them to
// the existing view-only Manager rule instead of the HR desk rule.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { sourceOf } = require('./roleAccess');

const DEPARTMENT = 'Internal HR';
// Seat codes (the first word decides the department): IHR-TL, IHR-1 ...;
// "Internal HR TL" is read the same way.
const SEAT_TOKENS = ['IHR', 'INTERNAL'];
const SETTINGS_KEY = 'internal-hr-access';
const DEFAULTS = { enabled: true, money: true, viewOnly: [] };

// ---------------------------------------------------------------------------
// WHAT INTERNAL HR CAN NEVER DO. One list; add a row to block more.
//   area    the legacy HRMS area the permission guards use ('Employee Management')
//   action  the engine action ('delete')
//   message what the screen says
// utils/permissions.js can() and effectiveMatrix() refuse these for an Internal
// HR login whatever the Role Catalog says, so the button is not drawn either.
// ---------------------------------------------------------------------------
const INTERNAL_HR_BLOCKED = [
  { id: 'employee.delete', area: 'Employee Management', action: 'delete', label: 'Delete an employee', message: 'Only Super Admin can delete an employee.' },
];
// Logins Internal HR can never change (password, login, role, record): the
// top accounts. Enforced where a record is opened for a change (routes/employees.js assertInScope).
const PROTECTED_ROLES = ['SUPER_ADMIN', 'ADMIN'];
// Roles an Internal HR person is never LOWERED from (already at or above the HR desk).
const KEEP_ROLES = ['SUPER_ADMIN', 'ADMIN', 'HR', 'NONE'];

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
    money: o.money !== false,
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
// employee: the login's Employee row. Returns null (not a member / switched off)
// or { mode: 'admin' | 'view', money, department, blocked }.
async function resolveFor(employee, user, products) {
  if (!employee || !user) return null;
  if (!isInternalHrName(employee.department)) return null;
  if (['Relieved', 'Exited'].includes(employee.employmentStatus)) return null;
  if (!products || !products.hrms) return null;
  if (['CLIENT', 'CANDIDATE'].includes(user.role)) return null;
  const cfg = await settings();
  if (!cfg.enabled) return null;
  const viewOnly = cfg.viewOnly.includes(String(employee.employeeCode || '').toUpperCase());
  return {
    member: true,
    mode: viewOnly ? 'view' : 'admin',
    money: cfg.money,
    department: DEPARTMENT,
    blocked: INTERNAL_HR_BLOCKED.map((b) => ({ id: b.id, label: b.label, message: b.message })),
  };
}

// The HRMS role this person acts as. null = leave their own role alone.
function liftedHrmsRole(ih, currentRole) {
  if (!ih) return null;
  if (KEEP_ROLES.includes(currentRole)) return null;
  return ih.mode === 'view' ? 'MANAGER' : 'HR';
}

// ---- the permission overlay (read by permissions.js) ----------------------
function blockedBy(moduleId, feature, action) {
  const area = sourceOf(moduleId, feature);
  return INTERNAL_HR_BLOCKED.find((b) => b.action === action && (!b.area || b.area === area)) || null;
}
// True when this Internal HR login must be REFUSED this (module, feature, action).
function denies(ih, moduleId, feature, action) {
  if (!ih) return false;
  if (blockedBy(moduleId, feature, action)) return true;
  // Salary / payroll switched off: payroll is view (own payslip) only.
  if (!ih.money && moduleId === 'hrms_payroll' && action !== 'view') return true;
  return false;
}
// True when the overlay GRANTS it on top of the HR desk role: every HRMS action
// a Super Admin has (admin mode only), minus what denies() refuses.
function overlayAllows(ih, moduleId, feature, action) {
  if (!ih || ih.mode !== 'admin') return false;
  return !denies(ih, moduleId, feature, action);
}
function messageFor(id) {
  const b = INTERNAL_HR_BLOCKED.find((x) => x.id === id);
  return b ? b.message : 'This action is not available to Internal HR.';
}
// Express guard for a route that must never run for Internal HR (the message is plain).
function blockRoute(id) {
  return (req, res, next) => {
    if (req.user && req.user.internalHr) return res.status(403).json({ error: messageFor(id) });
    return next();
  };
}

// ---- hiding money / ID fields when the switch is off ----------------------
const SENSITIVE_KEYS = new Set([
  'bankName', 'bankAccountNumber', 'ifscCode', 'panNumber', 'aadhaarNumber', 'aadhaarLast4', 'aadhaarVerifyRef',
  'uanNumber', 'pfNumber', 'esiNumber', 'salaryStructure', 'salaryStructures', 'ctc', 'grossSalary', 'netSalary',
  'netPay', 'grossPay', 'monthlyCtc', 'monthlySalary', 'biometricPin',
]);
function strip(value, user, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 12) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => strip(v, user, depth + 1));
  const own = (user && user.id && value.userId === user.id)
    || (user && user.employeeId && value.employeeCode && value.id === user.employeeId);
  const out = {};
  Object.keys(value).forEach((k) => {
    if (!own && SENSITIVE_KEYS.has(k)) return;
    out[k] = strip(value[k], user, depth + 1);
  });
  return out;
}
// Wrap res.json for a login whose money switch is off (called by middleware/auth.js).
function installRedaction(res, user) {
  const original = res.json.bind(res);
  res.json = (body) => original(strip(body, user));
}

module.exports = {
  DEPARTMENT,
  SEAT_TOKENS,
  SETTINGS_KEY,
  DEFAULTS,
  INTERNAL_HR_BLOCKED,
  PROTECTED_ROLES,
  isInternalHrName,
  settings,
  saveSettings,
  invalidate,
  clean,
  resolveFor,
  liftedHrmsRole,
  denies,
  overlayAllows,
  messageFor,
  blockRoute,
  installRedaction,
  strip,
};
