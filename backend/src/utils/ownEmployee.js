// ---------------------------------------------------------------------------
// WHICH EMPLOYEE IS THIS LOGIN? (founder, 2026-10-23: "No employee record is linked to this login, so there is no attendance to record" on My Attendance.)
// The link is Employee.userId. Normally it is set when the login is made from the employee. When it is missing (a login made first, an employee
// imported later), the person has no attendance, no leave, no payslip. This finds the employee the SAME way a person would: the employee record that has
// THIS login's e-mail address as its e-mail (case ignored), and only when exactly ONE employee has it and that employee is not linked to another login.
// It links them (audited) and answers with the employee. Anything less certain answers null: it never guesses by name.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const NO_LINK_MESSAGE = 'No employee record is linked to this login, so there is no attendance to record. If this is your own login, ask HR to link it to your employee record (Employee Management > your record).';

async function ownEmployeeOf(user) {
  if (!user || !user.id) return null;
  const linked = await prisma.employee.findUnique({ where: { userId: user.id } });
  if (linked) return linked;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  // SQLite compares text case-sensitively with equals; contains (LIKE) ignores case, then the exact match is checked here
  const same = (await prisma.employee.findMany({ where: { email: { contains: email } }, select: { id: true, userId: true, name: true, email: true } })).filter((e) => String(e.email || '').trim().toLowerCase() === email);
  const free = same.filter((e) => !e.userId);
  if (same.length !== 1 || free.length !== 1) return null; // none, several, or already another login's
  try {
    const out = await prisma.employee.update({ where: { id: free[0].id }, data: { userId: user.id } });
    await logAudit({ userId: user.id, actorName: user.name || user.email, action: 'Login linked to its employee record (same e-mail)', entity: 'Employee', entityId: free[0].id, toValue: `${free[0].name} <- ${email}` }).catch(() => {});
    return out;
  } catch { return null; } // a race (another request linked it first) or a unique clash: leave it
}

module.exports = { ownEmployeeOf, NO_LINK_MESSAGE };
