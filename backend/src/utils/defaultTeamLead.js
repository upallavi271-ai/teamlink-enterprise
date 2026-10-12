const prisma = require('../db');
const { canonicalDepartment } = require('./bdeDesk');

// ---------------------------------------------------------------------------
// THE DEFAULT TEAM LEAD (user, 2026-10-09).
//
// "Medical jobs have ONE team lead (Keerthana). Nobody should be asked to
//  'assign a team lead' for them."
//
// RULE: a job of a department that has exactly ONE active recruiting team lead
// belongs to THAT team lead automatically. A department with several team leads
// (Education: two) or none (IT) is NOT auto-assigned — somebody picks.
//
//   active recruiting team lead = a login with the TL role, ATS access, status
//     Active, an employee record that has not left or been suspended, not a
//     test login (ZZTEST / example.test), NOT the BDE team lead (the BDE TL
//     works clients, not jobs) and not an R&D TL (R&D has no ATS).
//   department of a TL = the login's ATS department, else the employee's;
//     both sides go through the same aliases as utils/bdeDesk.js
//     (Education / EDU, Medical / MED, Manufacturing / MFG ...).
//
// A manual choice always wins: this only fills an EMPTY team lead (on create,
// and when the department of a job still held by the old department's own
// default TL is changed). Who set it is in the audit trail
// ("Default team lead set" = automatic).
//
//   await prime();                        // before using the sync helpers below
//   defaultFor('Medical')  -> { id, name } | null        (exactly one TL)
//   tlsOf('Education')     -> [{ id, name, dept }, ...]
//   singleDepartmentNames()-> ['Medical', 'Manufacturing', ...] raw spellings in use
//   await applyDefault(data) -> sets data.tlId / data.tl when empty
// ---------------------------------------------------------------------------
const GONE = /exit|relieved|terminat|resign|suspend|abscond/i;
const TEST_USER = [{ name: { contains: 'zztest' } }, { email: { contains: 'example.test' } }];
const TTL_MS = 20 * 1000;

let snap = { at: 0, byDept: new Map(), singles: new Map(), rawSingles: [], all: [] };
let loading = null;

async function load() {
  const users = await prisma.user.findMany({
    where: { atsAccess: true, status: 'Active', atsRole: 'TL', NOT: TEST_USER },
    select: {
      id: true, name: true, atsDepartment: true,
      employee: { select: { department: true, employmentStatus: true } },
    },
    orderBy: { name: 'asc' },
  });
  const byDept = new Map();
  const all = [];
  users.forEach((u) => {
    if (u.employee && GONE.test(u.employee.employmentStatus || '')) return;
    const raw = u.atsDepartment || (u.employee && u.employee.department) || '';
    const dept = canonicalDepartment(raw);
    if (!dept || dept === 'BDE' || dept === 'R&D') return;
    const tl = { id: u.id, name: u.name, dept };
    all.push(tl);
    if (!byDept.has(dept)) byDept.set(dept, []);
    byDept.get(dept).push(tl);
  });
  const singles = new Map();
  byDept.forEach((list, dept) => { if (list.length === 1) singles.set(dept, list[0]); });
  // The spellings of those departments that are actually on requirements, for SQL.
  const used = await prisma.requirement.groupBy({ by: ['department'], _count: { _all: true } }).catch(() => []);
  const rawSingles = used.map((x) => x.department).filter((d) => d && singles.has(canonicalDepartment(d)));
  snap = { at: Date.now(), byDept, singles, rawSingles, all };
  return snap;
}

// Load (or reuse for 20 s) the team leads. { fresh: true } always reads again.
async function prime({ fresh = false } = {}) {
  if (!fresh && Date.now() - snap.at < TTL_MS) return snap;
  if (!loading) loading = load().finally(() => { loading = null; });
  return loading;
}
const clear = () => { snap = { ...snap, at: 0 }; };

const deptKey = (department) => canonicalDepartment(department);

// The department's ONE team lead, or null (none, or several).
function defaultFor(department) {
  const k = deptKey(department);
  return k ? (snap.singles.get(k) || null) : null;
}
// Every recruiting TL of a department (canonical match).
function tlsOf(department) {
  const k = deptKey(department);
  return k ? (snap.byDept.get(k) || []).slice() : [];
}
const singleDepartmentNames = () => snap.rawSingles.slice();
// The department spellings this TL is the ONE team lead of (for a "jobs of this TL" filter).
function departmentsOfSingleTl(tlId) {
  return snap.rawSingles.filter((d) => { const t = snap.singles.get(canonicalDepartment(d)); return t && t.id === tlId; });
}
const directory = () => ({ byDept: snap.byDept, singles: snap.singles, all: snap.all });

// Fill an EMPTY team lead on a job's data (create / copy / request / import).
// Returns the TL it put there, or null. Never touches a TL already named.
async function applyDefault(data) {
  if (!data || data.tlId) return null;
  await prime();
  const tl = defaultFor(data.department);
  if (!tl) return null;
  data.tlId = tl.id;
  data.tl = tl.name;
  return tl;
}

// The department of a job is being changed: the TL to put on it, or undefined
// to leave it alone. The old department's own default TL moves with the job to
// the new department's default (or off it, if the new department has none);
// any other TL — a manual choice — stays.
function tlAfterDepartmentChange(job, newDepartment) {
  const old = job.tlId ? defaultFor(job.department) : null;
  if (!job.tlId) {
    const next = defaultFor(newDepartment);
    return next ? { tlId: next.id, tl: next.name, auto: true } : undefined;
  }
  if (old && old.id === job.tlId) {
    const next = defaultFor(newDepartment);
    return next ? { tlId: next.id, tl: next.name, auto: true } : { tlId: null, tl: null, auto: true };
  }
  return undefined;
}

module.exports = { prime, clear, defaultFor, tlsOf, singleDepartmentNames, departmentsOfSingleTl, directory, applyDefault, tlAfterDepartmentChange };
