// ---------------------------------------------------------------------------
// FORMER EMPLOYEE ACCESS  (founder, 2026-10-15) - replaces "a person who has left cannot sign in".
//
//   "Relieved / Exited employees KEEP their login, with VERY LIMITED permissions: only to download their
//    payslips and offer letters (and the related own letters)."
//
// WHEN: the linked Employee status is Relieved / Exited / Terminated (utils/leftLogin.js decides "has left";
// a Super Admin / client / candidate is never judged). The login must still be Active (an Admin switching it
// off on the Users screen still works), the password still right, no lockout - none of that changes.
//
// WHAT THEY GET (ONE place, middleware/auth.js requireAuth calls it right after the identity is read and
// BEFORE any role check, the Internal-HR escalation, View-as or Act-as):
//   GET  /api/auth/me                 their own small profile (a limited payload, no nav, no permission matrix)
//   POST /api/auth/change-password
//   /api/former/*                     own payslips (list + PDF), own letters (list + download), own status
// EVERYTHING ELSE answers 403 'Your access has ended. You can only download your payslips and offer letters.'
// Their stored roles are neutralised (hrms/ats/accounts role = NONE, no products) for the request, so a stored
// TL / HR / Manager role can never leak through.
//
// ENDS WHEN (plain words, Administration -> Exit settings):
//   * the AppSetting 'former-access' limit passes (Forever [default] / 1 / 2 / 3 years after the last working day);
//   * Admin / Super Admin / HR switches THIS person's access off ('Switch off their access' on the profile).
// Then the old refusal returns: 401 / 403 code EMPLOYMENT_ENDED with a plain message.
// Nothing here writes at load or on a timer.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const leftLogin = require('./leftLogin');

const KEY = 'former-access';
const LIMITS = [
  { months: 0, label: 'Forever' },
  { months: 12, label: '1 year after the last working day' },
  { months: 24, label: '2 years after the last working day' },
  { months: 36, label: '3 years after the last working day' },
];
const MESSAGE = 'Your access has ended. You can only download your payslips and offer letters.';
const ENDED_MESSAGE = 'Your access has ended. Please contact HR if you think this is a mistake.';
const LETTER_TYPES = ['Offer Letter', 'Joining Letter', 'Experience Certificate'];
const LETTER_NAME = /letter|appointment|relieving|experience|offer|joining/i;
const iso = (v) => { try { return v ? new Date(v).toISOString().slice(0, 10) : null; } catch { return null; } };

function clean(v) {
  const o = v && typeof v === 'object' ? v : {};
  const m = Number(o.limitMonths);
  const seen = new Set();
  return {
    limitMonths: LIMITS.some((l) => l.months === m) ? m : 0,
    off: (Array.isArray(o.off) ? o.off : []).filter((x) => x && x.userId && !seen.has(x.userId) && seen.add(x.userId))
      .map((x) => ({ userId: String(x.userId), at: x.at || null, byName: x.byName || null, reason: x.reason || null })),
  };
}
async function settings() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    return clean(row ? JSON.parse(row.value) : {});
  } catch { return clean({}); }
}
async function save(next, user) {
  const value = JSON.stringify(clean(next));
  const who = user ? (user.name || user.email) : null;
  await prisma.appSetting.upsert({
    where: { key: KEY }, update: { value, updatedById: user ? user.id : null, updatedByName: who },
    create: { key: KEY, value, updatedById: user ? user.id : null, updatedByName: who },
  });
  return settings();
}

// identity (resolveIdentity) -> { former, allowed, code, message, lastWorkingDate, accessUntil }
async function evaluate(identity) {
  if (!leftLogin.hasLeft(identity)) return { former: false, allowed: true };
  const cfg = await settings();
  const out = { former: true, allowed: true, limitMonths: cfg.limitMonths, lastWorkingDate: null, accessUntil: null };
  const off = cfg.off.find((x) => x.userId === identity.id);
  if (off) return { ...out, allowed: false, reason: 'off', code: 'EMPLOYMENT_ENDED', message: ENDED_MESSAGE };
  let lwd = null;
  try {
    if (identity.employeeId) {
      const m = await require('./exitDate').exitDatesFor([identity.employeeId], { approvedOnly: false }); // eslint-disable-line global-require
      if (m.has(identity.employeeId)) lwd = m.get(identity.employeeId).date;
    }
  } catch { lwd = null; }
  out.lastWorkingDate = lwd;
  if (cfg.limitMonths && lwd) {
    const d = new Date(`${lwd}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + cfg.limitMonths);
    out.accessUntil = d.toISOString().slice(0, 10);
    const today = require('./positions').today(); // eslint-disable-line global-require
    if (today > out.accessUntil) return { ...out, allowed: false, reason: 'expired', code: 'EMPLOYMENT_ENDED', message: ENDED_MESSAGE };
  }
  return out;
}

// The allow-list. path is relative to nothing: the full request path with /api.
function pathAllowed(method, fullPath) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(fullPath || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (m === 'GET' && p === '/api/auth/me') return true;
  if (m === 'POST' && p === '/api/auth/change-password') return true;
  if (m === 'GET' && /^\/api\/former(\/|$)/.test(p)) return true;
  return false;
}

// Strip every stored right from this request's identity (a stored TL / HR / Manager role must not count).
function limit(identity, info) {
  identity.formerAccess = info;
  identity.hrmsRole = 'NONE';
  identity.atsRole = 'NONE';
  identity.accountsRole = 'NONE';
  identity.products = { hrms: false, ats: false, accounts: false };
  identity.productRoles = {};
  identity.scopeRoles = {};
  identity.workspaces = [];
  identity.hrSuper = undefined;
  return identity;
}

// What /auth/me and the sign-in answer for a former employee: no nav, no matrix.
async function sessionPayload(identity) {
  const info = identity.formerAccess || (await evaluate(identity));
  const emp = identity.employeeId ? await prisma.employee.findUnique({
    where: { id: identity.employeeId },
    select: { id: true, name: true, employeeCode: true, department: true, designation: true, dateOfJoining: true, employmentStatus: true },
  }).catch(() => null) : null;
  const pw = await prisma.user.findUnique({ where: { id: identity.id }, select: { passwordChangedAt: true } }).catch(() => null);
  return {
    id: identity.id, name: identity.name, email: identity.email, role: 'FORMER_EMPLOYEE',
    hrmsRole: 'NONE', atsRole: 'NONE', accountsRole: 'NONE', products: { hrms: false, ats: false, accounts: false }, workspaces: [],
    employeeId: identity.employeeId || null, employmentStatus: identity.employmentStatus,
    former: {
      message: MESSAGE,
      employeeCode: emp ? emp.employeeCode : null, department: emp ? emp.department : null, designation: emp ? emp.designation : null,
      dateOfJoining: emp ? iso(emp.dateOfJoining) : null, lastWorkingDate: info.lastWorkingDate || null, accessUntil: info.accessUntil || null,
      status: identity.employmentStatus,
    },
    passwordStatus: { changedAt: pw ? pw.passwordChangedAt : null },
  };
}

const isLetter = (d) => LETTER_TYPES.includes(d.docType) || (d.docType === 'Other Documents' && LETTER_NAME.test(d.docName || d.fileName || ''));

module.exports = {
  KEY, LIMITS, MESSAGE, ENDED_MESSAGE, LETTER_TYPES, settings, save, clean, evaluate, pathAllowed, limit, sessionPayload, isLetter,
};
