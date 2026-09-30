// ---------------------------------------------------------------------------
// EMPLOYEE ID — the one rule for the next code and for a changed one.
//
// "Last employee ID TL516 — new employee add chesthey TL517 automatic ga
// ravali." The company numbers people TL001, TL002 … so the next code is the
// highest TL<n> on file plus one, zero-padded the way the existing codes are
// (TL036 … TL516 — three digits). Codes that are not in that series (EMP-0360,
// '000', '172') are ignored when counting but can never be handed out twice.
//
// Every path that creates an employee without a typed code asks this file:
// Add Employee, Bulk Import and the internal-hire hand-over. Uniqueness is
// case-insensitive everywhere (tl517 and TL517 are the same person).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const PREFIX = 'TL';
const SERIES = /^TL(\d+)$/i;
const ALLOWED = /^[A-Za-z0-9._\-/]{1,30}$/;

// The next free code, given every code already on file (and any extra codes
// the caller has reserved in this same batch).
function nextFrom(codes, reserved = []) {
  const taken = new Set([...codes, ...reserved].map((c) => String(c || '').trim().toLowerCase()));
  let max = 0;
  const widths = {};
  codes.forEach((c) => {
    const m = SERIES.exec(String(c || '').trim());
    if (!m) return;
    max = Math.max(max, Number(m[1]));
    widths[m[1].length] = (widths[m[1].length] || 0) + 1;
  });
  // The padding most of the series uses (3 for TL036 … TL516).
  const width = Number(Object.entries(widths).sort((a, b) => b[1] - a[1])[0]?.[0] || 3);
  let n = max + 1;
  let code = `${PREFIX}${String(n).padStart(width, '0')}`;
  while (taken.has(code.toLowerCase())) {
    n += 1;
    code = `${PREFIX}${String(n).padStart(width, '0')}`;
  }
  return code;
}

async function allCodes(db = prisma) {
  return (await db.employee.findMany({ select: { employeeCode: true } })).map((e) => e.employeeCode);
}

async function nextEmployeeCode(db = prisma, reserved = []) {
  return nextFrom(await allCodes(db), reserved);
}

// The employee (other than `exceptId`) already holding this code, any case.
async function codeHolder(code, exceptId = null, db = prisma) {
  const want = String(code || '').trim().toLowerCase();
  if (!want) return null;
  const rows = await db.$queryRaw`SELECT id, name, employeeCode FROM Employee WHERE lower(trim(employeeCode)) = ${want}`;
  return rows.find((r) => r.id !== exceptId) || null;
}

// { error } when the code cannot be used at all, { warning } when it can but
// does not follow the TL<nnn> series, {} when it is fine.
function checkFormat(code) {
  const c = String(code || '').trim();
  if (!c) return { error: 'Enter an Employee ID.' };
  if (!ALLOWED.test(c)) return { error: `"${c}" is not a valid Employee ID — letters, digits, - _ . / only, at most 30.` };
  if (!/^TL\d{3,}$/.test(c)) return { warning: `${c} does not follow the company series (TL followed by at least three digits, e.g. TL517).` };
  return {};
}

// Prisma's unique-constraint error on Employee.employeeCode.
const isCodeClash = (err) => !!(err && err.code === 'P2002'
  && String((err.meta && err.meta.target) || '').includes('employeeCode'));

module.exports = {
  PREFIX, SERIES, nextFrom, nextEmployeeCode, codeHolder, checkFormat, isCodeClash, allCodes,
};
