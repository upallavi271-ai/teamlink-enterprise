// ---------------------------------------------------------------------------
// A TL'S LEAVE IS APPROVED ONLY BY THE SUPER ADMIN (founder 2026-10-28: "tl's ki matram directga superadmin approval estey ne approve,
// hr echina pending ane ravali").
//
//   * WHO IS A TL HERE: the person's HRMS role (or account role) is TL or STL, or their designation says TL / Team Lead.
//     STL is a SENIOR TL (one rung above TL on the ladder), so a senior lead's leave is not easier to get than a TL's.
//     One list (LEAD_ROLES) to change if the founder wants TL only.
//   * HR (or an STL, Internal HR, an HR-super delegate - anybody who is not the real Super Admin) approving a TL's leave does NOT
//     grant it: their approval is recorded on their step and the request moves to the SUPER ADMIN step ("Sent to the Super Admin for
//     final approval"). The levels in between are shown as Visibility. The LeaveRequest stays Pending.
//   * Only a real Super Admin approval (their own turn, or directly from any step) makes it Approved.
//   * Rejecting is unchanged (the step-owner, HR or the Super Admin can reject as before).
// Used by routes/leave.js (/:id/decision) and scripts/tl-leaves-to-pending.js (yesterday's TL leaves put back to Pending).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const LEAD_ROLES = ['TL', 'STL'];
const LEAD_DESIGNATIONS = /^(s\.?\s?tl|tl|team\s*lead(er)?|senior\s*team\s*lead(er)?|sr\.?\s*team\s*lead(er)?|sr\.?\s*tl)$/i;
const SA_NOTE = "Final approval - a TL's leave is approved only by the Super Admin";
const VIS_NOTE = "Not needed - a TL's leave goes straight to the Super Admin. Shown for information.";
const SENT_MESSAGE = 'Sent to the Super Admin for final approval';

const named = (v) => (v && v !== 'NONE' ? v : null);

// The REAL Super Admin: an HR-super delegate (identity.hrSuper) looks like one on other screens but is HR here.
function isRealSuperAdmin(user) {
  return !!user && (user.role === 'SUPER_ADMIN' || named(user.hrmsRole) === 'SUPER_ADMIN') && !user.hrSuper;
}

// Is this employee a TL (team lead)? user = their login (optional; read when not given).
function isLeadSync(employee, user) {
  if (!employee) return false;
  if (user && (LEAD_ROLES.includes(named(user.hrmsRole)) || LEAD_ROLES.includes(user.role))) return true;
  const d = String(employee.designation || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  return !!d && LEAD_DESIGNATIONS.test(d);
}
async function isLeadEmployee(employee, user) {
  if (!employee) return false;
  let u = user;
  if (u === undefined && employee.userId) u = await prisma.user.findUnique({ where: { id: employee.userId }, select: { role: true, hrmsRole: true } }).catch(() => null);
  return isLeadSync(employee, u || null);
}

// The Super Admin who takes the request: the one already named on the chain, else the first active Super Admin login.
async function superAdminUser(saStep, applicantUserId) {
  if (saStep && saStep.approverUserId) {
    const u = await prisma.user.findUnique({ where: { id: saStep.approverUserId }, select: { id: true, name: true, role: true, status: true } });
    if (u && u.role === 'SUPER_ADMIN' && (u.status || 'Active') === 'Active') return u;
  }
  return prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', status: 'Active', NOT: { id: applicantUserId || '__none__' } },
    select: { id: true, name: true, role: true }, orderBy: { createdAt: 'asc' },
  });
}

// Move a request to the Super Admin step: everything else still open becomes Visibility, the Super Admin step becomes Pending.
// `by` = who approved just before (for the note). Returns the Super Admin step.
async function sendToSuperAdmin(workflowId, recordId, { by = null } = {}) {
  const steps = await prisma.approvalStep.findMany({ where: { workflow: workflowId, recordId }, orderBy: { seq: 'asc' } });
  const sa = steps.find((s) => s.level === 'SUPER_ADMIN') || null;
  const applied = steps.find((s) => s.status === 'Applied');
  const who = await superAdminUser(sa, applied ? applied.approverUserId : null);
  const open = steps.filter((s) => ['Pending', 'Waiting'].includes(s.status) && (!sa || s.id !== sa.id));
  if (open.length) {
    await prisma.approvalStep.updateMany({ where: { id: { in: open.map((s) => s.id) } }, data: { status: 'Visibility', note: VIS_NOTE } });
  }
  const now = new Date();
  const data = {
    status: 'Pending', mode: 'required', activatedAt: now, dueAt: null, actedAt: null, actedByUserId: null, actedByName: null, direct: false,
    approverUserId: who ? who.id : (sa ? sa.approverUserId : null),
    approverName: who ? who.name : (sa ? sa.approverName : 'Super Admin'),
    note: by ? `${SA_NOTE} (${by} approved before)` : SA_NOTE,
  };
  if (sa) return prisma.approvalStep.update({ where: { id: sa.id }, data });
  const top = steps.reduce((m, s) => Math.max(m, s.seq), 0);
  return prisma.approvalStep.create({ data: { workflow: workflowId, recordId, level: 'SUPER_ADMIN', seq: Math.max(top + 1, 7), ...data } });
}

module.exports = { LEAD_ROLES, SA_NOTE, VIS_NOTE, SENT_MESSAGE, isRealSuperAdmin, isLeadSync, isLeadEmployee, sendToSuperAdmin };
