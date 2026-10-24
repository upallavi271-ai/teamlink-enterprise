// ---------------------------------------------------------------------------
// UPLOADS THAT CLIMB THE APPROVAL CHAIN (founder, 2026-10-24):
//   "whatever TLs or HR upload in LMS or Documents takes approvals hierarchy-wise, up to the Super Admin."
//
// A Document, a new course and a course material each start Pending when somebody other than the Admin / Super Admin uploads them, and
// are shown to employees / learners only after the last approver (the Super Admin) says yes. The ladder is the same one every other
// request climbs (utils/approvalWorkflow.js): TL -> STL -> HR -> Assistant Manager -> Manager -> Super Admin, starting one rung ABOVE
// the person who uploaded, so nobody approves their own upload.
//
// WHO SKIPS THE CHAIN: a real Super Admin / Admin (utils/hrSuper.js isRealTop). An HR "super access" delegate looks like a Super Admin to
// the permission engine but is still an HR login in the database, so HIS uploads climb the chain like any other HR upload.
//
// FAIL CLOSED: if the chain cannot be laid down (an error, not "nobody above"), the upload is NOT published. The caller removes it and
// says so. A chain problem must never become a back door that publishes without approval.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const chain = require('./chainRoute');
const { isRealTop } = require('./hrSuper');

// The person the upload is raised "as". A login with no employee record (the shared HR desk login, for one) still has a rung: its
// stored HRMS role says where it sits, so it is raised as a department-less applicant instead of being let through.
async function applicantFor(user) {
  const emp = await prisma.employee.findUnique({ where: { userId: user.id } }).catch(() => null);
  if (emp) return emp;
  return {
    id: null, userId: user.id, name: user.name || user.email || 'Unknown', department: user.department || null, team: user.team || null,
    employeeCode: null, email: user.email || null, tl: null, stl: null, reportingManagerId: null,
  };
}

// { direct: true }                      the uploader is a real Super Admin / Admin: publish now
// { pending: true,  summary }           the chain is climbing: keep the record Pending
// { pending: false, summary: null }     nobody sits above the uploader: publish now
// { failed: true }                      the chain could not be laid down: publish nothing
async function raiseUpload(wf, user, recordId) {
  if (isRealTop(user)) return { direct: true, pending: false, summary: null };
  const applicant = await applicantFor(user);
  const out = await chain.raise(wf, { recordId, employee: applicant, applicantUserId: user.id, applicantName: applicant.name });
  if (!out.steps || !out.steps.length) return { failed: true, pending: false, summary: null };
  return { direct: false, pending: out.pending, summary: out.summary };
}

const FAILED_MESSAGE = 'The approval chain could not be started, so nothing was published. Please try again, or ask the Super Admin.';

module.exports = { raiseUpload, applicantFor, FAILED_MESSAGE };
