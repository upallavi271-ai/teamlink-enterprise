// ---------------------------------------------------------------------------
// EMPLOYEE FIELD VISIBILITY (security fix 2026-10-13) - THE one place.
//
// Who sees the sensitive columns of an Employee row:
//
//   FULL     Super Admin, Admin, HR desk (HRMS role HR = SET.HR_DESK), and the
//            employee looking at their OWN record.
//   PAYROLL  Accountant: bank, PAN, UAN / PF / ESI and CTC in full; the personal
//            fields (DOB, address, emergency contact) hidden, Aadhaar masked.
//   MASKED   TL (own team), STL, Manager, Assistant Manager and every other
//            login that may open the employee list: ID numbers show the last
//            four characters only (XXXX1234), DOB shows day + month, address
//            shows the city only, emergency contact and CTC / salary are hidden.
//   HIDDEN   everyone else (Recruiter, BDE, BDE TL, ...): all of it removed.
//
// redactDeep() walks any JSON that is about to leave the server, finds the
// objects that look like an Employee row, and applies the level. routes/
// employees.js installs it on the whole router (res.json wrapper), and the
// file exports (list export, per-record sheet) use redactRow() / levelFor()
// directly, so the web screen, the CSV / XLSX / PDF files and the AI assistant
// can never disagree.
// ---------------------------------------------------------------------------
const FULL = 'FULL';
const PAYROLL = 'PAYROLL';
const MASKED = 'MASKED';
const HIDDEN = 'HIDDEN';

const FULL_ROLES = ['SUPER_ADMIN', 'ADMIN', 'HR'];
const MASK_ROLES = ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'];

const BANK_KEYS = ['bankAccountNumber', 'ifscCode'];
const ID_KEYS = ['panNumber', 'uanNumber', 'pfNumber', 'esiNumber'];
const AADHAAR_KEYS = ['aadhaarNumber', 'aadhaarLast4'];
const ADDRESS_KEYS = ['address', 'addressLine1', 'addressLine2', 'district', 'postalCode', 'state'];
const EMERGENCY_KEYS = ['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'];
const SALARY_KEYS = ['salaryStructure', 'salaryVersions', 'ctc', 'annualCtc', 'monthlyCtc', 'grossSalary', 'monthlyGross', 'currentCtc', 'netSalary'];
const SECRET_KEYS = ['biometricPin', 'verifyOtpHash', 'verifyTarget', 'verifyLast4', 'aadhaarVerifyRef'];
// field names (audit / pending-change rows) whose from / to values must be masked.
const SENSITIVE_FIELD_NAMES = new Set([...BANK_KEYS, ...ID_KEYS, ...AADHAAR_KEYS, ...ADDRESS_KEYS, ...EMERGENCY_KEYS, 'dateOfBirth', 'bankName', 'ctc', 'salary']);

const rolesOf = (user) => {
  if (!user) return [];
  let hr = []; let ac = [];
  try {
    const { rolesFor } = require('./permissions'); // eslint-disable-line global-require
    hr = rolesFor(user, 'hrms') || [];
    ac = rolesFor(user, 'accounts') || [];
  } catch { /* fall back to the stored names */ }
  return [...new Set([user.role, user.hrmsRole, user.accountsRole, ...hr, ...ac].filter(Boolean))];
};

// Level for the person asking. `viewer` is req.user (resolved identity).
function levelFor(viewer) {
  if (!viewer) return HIDDEN;
  const roles = rolesOf(viewer);
  const hrms = (() => { try { return require('./permissions').rolesFor(viewer, 'hrms') || []; } catch { return []; } })(); // eslint-disable-line global-require
  // SA / Admin hold FULL through any product; HR only through the HRMS role.
  if (['SUPER_ADMIN', 'ADMIN'].some((r) => roles.includes(r) && (r === viewer.role || hrms.includes(r)))) return FULL;
  if (hrms.includes('HR') || viewer.hrmsRole === 'HR') return FULL;
  if (roles.includes('ACCOUNTANT')) return PAYROLL;
  if (roles.some((r) => MASK_ROLES.includes(r)) || (viewer.caps && viewer.caps.hrmsManage)) return MASKED;
  return HIDDEN;
}

const lastN = (v, n = 4) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, '');
  if (!s) return v;
  return `XXXX${s.slice(-n)}`;
};

function dayMonth(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

// Redact ONE employee-like object in place-copy. Returns a new object.
function redactRow(row, level, { own = false } = {}) {
  if (!row || typeof row !== 'object' || own || level === FULL) return row;
  const out = { ...row };
  const has = (k) => Object.prototype.hasOwnProperty.call(out, k);
  const payroll = level === PAYROLL;
  const masked = level === MASKED;
  const hidden = level === HIDDEN;
  const cut = (keys) => keys.forEach((k) => { if (has(k)) out[k] = null; });
  const mask = (keys) => keys.forEach((k) => { if (has(k) && out[k]) out[k] = lastN(out[k]); });

  SECRET_KEYS.forEach((k) => { if (has(k)) delete out[k]; });
  if (hidden) { cut([...BANK_KEYS, ...ID_KEYS, ...AADHAAR_KEYS, ...ADDRESS_KEYS, ...EMERGENCY_KEYS, 'bankName', 'dateOfBirth', 'addressType']); SALARY_KEYS.forEach((k) => { if (has(k)) delete out[k]; }); }
  if (masked) {
    mask([...BANK_KEYS, ...ID_KEYS, ...AADHAAR_KEYS]);
    cut([...ADDRESS_KEYS, ...EMERGENCY_KEYS, 'addressType']);
    if (has('dateOfBirth')) { out.dateOfBirthDayMonth = dayMonth(out.dateOfBirth); out.dateOfBirth = null; }
    SALARY_KEYS.forEach((k) => { if (has(k)) delete out[k]; });
  }
  if (payroll) {
    mask(AADHAAR_KEYS);
    cut([...ADDRESS_KEYS, ...EMERGENCY_KEYS, 'dateOfBirth', 'addressType']);
  }
  out.fieldAccess = hidden ? 'hidden' : (payroll ? 'payroll' : 'masked');
  return out;
}

const looksLikeEmployee = (o) => o && typeof o === 'object' && !Array.isArray(o) && (
  'employeeCode' in o
  && ['bankAccountNumber', 'ifscCode', 'panNumber', 'uanNumber', 'pfNumber', 'esiNumber', 'dateOfBirth', 'aadhaarLast4', 'aadhaarNumber', 'emergencyContactName', 'address', 'addressLine1', 'salaryStructure', 'biometricPin'].some((k) => k in o)
);

const isOwn = (o, viewer) => !!(viewer && (
  (o.userId && o.userId === viewer.id) || (o.user && o.user.id === viewer.id) || (viewer.employeeId && o.id === viewer.employeeId)
));

// audit / pending-change rows {field, from, to} or {field, fromValue, toValue}
function redactChangeRow(o, level) {
  if (level === FULL || !o || typeof o.field !== 'string' || !SENSITIVE_FIELD_NAMES.has(o.field)) return o;
  const out = { ...o };
  const f = (v) => (v == null || v === '' ? v : (level === MASKED && /number|ifsc|pan|uan|pf|esi|aadhaar/i.test(o.field) ? lastN(v) : '(hidden)'));
  ['from', 'to', 'fromValue', 'toValue', 'oldValue', 'newValue'].forEach((k) => { if (k in out) out[k] = f(out[k]); });
  return out;
}

// Walk any JSON-able value and redact employee-like objects. Cycles are not expected (JSON).
// `ownCtx`: inside the viewer's OWN employee record - its change rows (what they submitted: pendingChanges, sentBack) are
// theirs too and stay readable (founder 2026-10-30: after Submit an employee saw "(hidden)" for their own phone, bank,
// address ... and could not tell what they had filled)
function redactDeep(value, viewer, level = levelFor(viewer), depth = 0, ownCtx = false) {
  if (level === FULL || value == null || typeof value !== 'object' || depth > 12) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, viewer, level, depth + 1, ownCtx));
  let obj = value;
  let own = ownCtx;
  if (looksLikeEmployee(obj)) { own = isOwn(obj, viewer); obj = redactRow(obj, level, { own }); } else if (typeof obj.field === 'string' && !ownCtx) obj = redactChangeRow(obj, level);
  const out = {};
  Object.keys(obj).forEach((k) => { out[k] = redactDeep(obj[k], viewer, level, depth + 1, own); });
  return out;
}

// Express middleware: every JSON answer of this router is redacted for the caller.
function redactMiddleware(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    try {
      const viewer = req.user;
      if (viewer) body = redactDeep(body, viewer);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[employeeRedact] failed, answering with nothing sensitive:', e && e.message);
      body = { error: 'Could not prepare this record.' };
    }
    return json(body);
  };
  next();
}

module.exports = { FULL, PAYROLL, MASKED, HIDDEN, levelFor, redactRow, redactDeep, redactMiddleware, isOwn, lastN, dayMonth, SENSITIVE_FIELD_NAMES };
