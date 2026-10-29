// ---------------------------------------------------------------------------
// EVERY HRMS RECRUITER / TL / STL HAS A JOB PORTAL RECRUITER LOGIN (founder 2026-10-29: "jobportal mail responses import
// cheyadaniki select chesteuntey exist ina employee kanipistunaru kanni ahh positions lo new ga add ina employee kanipinchadamledhu").
//
// The Job Portal finds a recruiter by EMAIL (its mailbox list, its sign-in from TeamLink - utils/jobPortalSso.js) and never makes
// one by itself. ensure() sends the CURRENT holders of TeamLink's Recruiter / TL / STL seats (HRMS positions, see people()) to the
// portal's TeamLink door (job-portal-app/embed/teamlink-integration.mjs POST .../recruiters/ensure); one without a portal login of
// the same email gets one there (the portal's own Recruiters -> Add, a random password nobody types: they come in from TeamLink).
// An existing portal recruiter gets the seat's department and employee id (HRMS decides); nothing else of theirs changes, nobody is
// removed, history (imported candidates, mailboxes) stays. An email that signs in to the portal as something else (a candidate) is
// left alone and reported as a clash.
// Runs: on every Job Portal full sync (startup, hourly, "Sync now" - utils/jobPortalBridge.js), before the mailbox screen lists
// the recruiters (routes/portalMailboxes.js), and by hand: node scripts/sync-job-portal-recruiters.js [--apply].
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ROLES = ['RECRUITER', 'TL', 'STL'];
const LEFT = ['Exited', 'Relieved', 'Terminated'];
const WORD = { RECRUITER: 'Recruiter', TL: 'Team Lead', STL: 'Senior Team Lead' };
const today = () => new Date().toISOString().slice(0, 10);
const realTenure = (a) => !(a.toDate && a.toDate <= a.fromDate); // the same rule as utils/invoiceHierarchy.js
const holdsOn = (a, day) => realTenure(a) && a.fromDate <= day && (!a.toDate || a.toDate >= day);
// The seat code's first word decides the department (EDU-5, MED TL, MFG-2 - the seat-code rule); the position's own department
// field only when the code says nothing (founder 2026-10-29: "shravya is education" - the portal's stored department is not used).
const CODE_DEPT = { MED: 'Medical', EDU: 'Education', MFG: 'Manufacturing' };
const deptOf = (p) => CODE_DEPT[String(p.code || '').trim().split(/[\s-]+/)[0].toUpperCase()] || p.department || undefined;
const emailOf = (e) => String((e && ((e.user && e.user.email) || e.email)) || '').trim().toLowerCase();

// HRMS IS THE SOURCE (founder 2026-10-29: "hrms lo employee bati jobportal kanni ats kanni ominichannel work avuthundhi exist ina
// employee chupichakudadhu valla positions lo new employee automatic ga ravali"): the people are the CURRENT holders of the
// Recruiter / TL / STL seats (Position + PositionAssignment, the same tenure rule as invoiceHierarchy.holderOn), never someone
// who left the company or was moved off the seat. One person on two seats is one entry (first seat's department).
async function seatData() {
  return prisma.position.findMany({
    where: { kind: { in: ROLES } },
    select: {
      id: true, code: true, kind: true, department: true, active: true,
      assignments: { select: { fromDate: true, toDate: true, employee: { select: { id: true, name: true, email: true, employeeCode: true, phone: true, designation: true, employmentStatus: true, user: { select: { email: true } } } } } },
    },
    orderBy: { code: 'asc' },
  });
}
async function people(positions = null) {
  const day = today();
  const byEmail = new Map();
  for (const p of positions || await seatData()) {
    if (!p.active) continue; // eslint-disable-line no-continue
    const now = p.assignments.filter((a) => holdsOn(a, day));
    if (now.length !== 1) continue; // empty seat, or two tenures overlapping: nobody is guessed // eslint-disable-line no-continue
    const e = now[0].employee;
    const email = emailOf(e);
    if (!email || LEFT.includes(e.employmentStatus)) continue; // eslint-disable-line no-continue
    const had = byEmail.get(email);
    if (had) { had.seats.push(p.code); continue; } // eslint-disable-line no-continue
    byEmail.set(email, {
      name: e.name, email, employeeId: e.employeeCode || undefined, mobile: e.phone || undefined,
      department: deptOf(p), designation: e.designation || WORD[p.kind] || 'Recruiter',
      atsRole: p.kind, seats: [p.code], employeeDbId: e.id,
    });
  }
  return [...byEmail.values()];
}

// A person who no longer holds a seat: the seat they held last, and who holds it now (for "Reassign to <new holder>").
async function successorOf(email, positions = null) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return null;
  const list = positions || await seatData();
  const day = today();
  let last = null;
  for (const p of list) {
    for (const a of p.assignments) {
      if (emailOf(a.employee) !== want || !realTenure(a)) continue; // eslint-disable-line no-continue
      const end = a.toDate || '9999-12-31';
      if (!last || end > last.end) last = { end, p };
    }
  }
  if (!last) return null;
  const now = last.p.assignments.filter((a) => holdsOn(a, day));
  const e = now.length === 1 ? now[0].employee : null;
  return { seat: last.p.code, department: deptOf(last.p) || null, holder: e && !LEFT.includes(e.employmentStatus) && emailOf(e) ? { name: e.name, email: emailOf(e) } : null };
}

// apply=false: only says who would get a login. Returns { dryRun, results: [{ email, name, atsRole, result, reason? }] }.
async function ensure({ apply = false } = {}) {
  const list = await people();
  const { portalFetch } = require('./jobPortalBridge'); // eslint-disable-line global-require
  const res = await portalFetch('/integrations/teamlink/recruiters/ensure', {
    method: 'POST', timeoutMs: 60000, body: { people: list.map(({ atsRole, seats, employeeDbId, ...p }) => p), dryRun: !apply },
  });
  const by = new Map(list.map((p) => [p.email, p]));
  return {
    dryRun: !!(res && res.dryRun),
    results: ((res && res.results) || []).map((r) => { const p = by.get(String(r.email || '').toLowerCase()) || {}; return { ...r, name: p.name, atsRole: p.atsRole, seats: p.seats, department: p.department }; }),
  };
}

// For the automatic runs: never throws, logs only a count (no emails).
let running = null;
function ensureQuietly() {
  if (running) return running;
  running = ensure({ apply: true })
    .then((out) => {
      const made = out.results.filter((r) => r.result === 'created').length;
      if (made) console.log(`[job-portal] ${made} Recruiter / TL login(s) added to the Job Portal`);
      return out;
    })
    .catch(() => null)
    .finally(() => { running = null; });
  return running;
}

module.exports = { people, seatData, successorOf, ensure, ensureQuietly, ROLES };
