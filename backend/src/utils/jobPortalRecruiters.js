// ---------------------------------------------------------------------------
// EVERY HRMS RECRUITER / TL / STL HAS A JOB PORTAL RECRUITER LOGIN (founder 2026-10-29: "jobportal mail responses import
// cheyadaniki select chesteuntey exist ina employee kanipistunaru kanni ahh positions lo new ga add ina employee kanipinchadamledhu").
//
// The Job Portal finds a recruiter by EMAIL (its mailbox list, its sign-in from TeamLink - utils/jobPortalSso.js) and never makes
// one by itself. ensure() sends TeamLink's active Recruiters / TLs / STLs (a login with that ATS role, Active, not left) to the
// portal's TeamLink door (job-portal-app/embed/teamlink-integration.mjs POST .../recruiters/ensure); one without a portal login of
// the same email gets one there (the portal's own Recruiters -> Add, a random password nobody types: they come in from TeamLink).
// Nothing that already exists is changed, nothing is removed. An email that signs in to the portal as something else (a
// candidate) is left alone and reported as a clash.
// Runs: on every Job Portal full sync (startup, hourly, "Sync now" - utils/jobPortalBridge.js), before the mailbox screen lists
// the recruiters (routes/portalMailboxes.js), and by hand: node scripts/sync-job-portal-recruiters.js [--apply].
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ROLES = ['RECRUITER', 'TL', 'STL'];
const LEFT = ['Exited', 'Relieved', 'Terminated'];
const WORD = { RECRUITER: 'Recruiter', TL: 'Team Lead', STL: 'Senior Team Lead' };

async function people() {
  const users = await prisma.user.findMany({
    where: { atsRole: { in: ROLES }, status: 'Active' },
    select: { name: true, email: true, atsRole: true, employee: { select: { name: true, employeeCode: true, phone: true, department: true, designation: true, employmentStatus: true } } },
  });
  return users
    .filter((u) => u.email && !(u.employee && LEFT.includes(u.employee.employmentStatus)))
    .map((u) => ({
      name: (u.employee && u.employee.name) || u.name,
      email: String(u.email).trim().toLowerCase(),
      employeeId: (u.employee && u.employee.employeeCode) || undefined,
      mobile: (u.employee && u.employee.phone) || undefined,
      department: (u.employee && u.employee.department) || undefined,
      designation: (u.employee && u.employee.designation) || WORD[u.atsRole] || 'Recruiter',
      atsRole: u.atsRole,
    }));
}

// apply=false: only says who would get a login. Returns { dryRun, results: [{ email, name, atsRole, result, reason? }] }.
async function ensure({ apply = false } = {}) {
  const list = await people();
  const { portalFetch } = require('./jobPortalBridge'); // eslint-disable-line global-require
  const res = await portalFetch('/integrations/teamlink/recruiters/ensure', {
    method: 'POST', timeoutMs: 60000, body: { people: list.map(({ atsRole, ...p }) => p), dryRun: !apply },
  });
  const by = new Map(list.map((p) => [p.email, p]));
  return {
    dryRun: !!(res && res.dryRun),
    results: ((res && res.results) || []).map((r) => ({ ...r, name: (by.get(String(r.email || '').toLowerCase()) || {}).name, atsRole: (by.get(String(r.email || '').toLowerCase()) || {}).atsRole })),
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

module.exports = { people, ensure, ensureQuietly, ROLES };
