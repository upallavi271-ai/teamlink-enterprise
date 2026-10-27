// ---------------------------------------------------------------------------
// OVERDUE TASK REMINDERS (HRMS spec 2026-10-09, point 7).
//
// A task is OVERDUE when its End Date has passed and it is not finished (Not
// Started / In Progress / On Hold) - routes/tasks.js isOverdue(), worked out
// whenever it is read, so it needs no stored flag and clears by itself.
//
// REMINDER: every overdue task reminds its assignee ONCE A DAY AT MOST
// (Task.overdueRemindedOn holds the last day it was done), in the bell (in-app
// notification) AND by email. It rides on the existing HRMS notification
// engine (utils/hrmsNotify.js notify() and its queue):
//   * in-app: one bell entry per task per day;
//   * email: one row per task in the notification queue, collected into the
//     person's ONE daily email at the digest time (no flood of mails);
//   * emails are OFF until Admin turns them on (Attendance & Time -> notify
//     settings); the rows are still recorded, marked "Not sent - emails are
//     off", and a line is written to the server log saying so;
//   * email not set up (no SMTP): the daily email marks them "Not sent -
//     email is not set up" - never a fake "Sent".
// The sweep itself is hrmsNotify.run(), called by utils/attendanceAlerts.js
// startSweep (real server only; the sandbox runs no timers).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const RANK = { High: 0, Medium: 1, Low: 2 };
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dmy = (iso) => `${iso.slice(8, 10)}-${MON3[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// open: the not-finished tasks with an end date. users: Map userId -> user.
// notify / userOk are hrmsNotify's own (passed in, so this file stays free of
// a circular require). Returns { overdue, reminded, skipped }.
// skipAssignee(user) -> true: the person is told by the pending-work reminders instead (a recruiter's grouped "You missed N things" notice,
// utils/chainAlerts.js), so the per-task bell is not repeated. The giver below is still told. Null when those reminders are off.
async function remind({ open, users, today, notify, settings, mailer, now, userOk, testMode = false, skipAssignee = null }) {
  const due = open
    .filter((t) => t.endDate && t.endDate < today)
    .sort((a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || a.endDate.localeCompare(b.endDate));
  const out = { overdue: due.length, reminded: 0, skipped: 0, alreadyToday: 0 };
  const byGiver = new Map();
  for (const t of due) {
    if (t.overdueRemindedOn === today) { out.alreadyToday += 1; continue; }
    const u = users.get(t.assigneeId);
    if (!userOk(u)) { out.skipped += 1; continue; }
    const late = daysBetween(t.endDate, today);
    const title = `Task overdue: ${t.name} (was due ${dmy(t.endDate)})`;
    const message = `Your task "${t.name}" is ${late} day${late === 1 ? '' : 's'} late. It was due ${dmy(t.endDate)}. Priority: ${t.priority || 'Medium'}. Status: ${t.status}. Please finish it, or open the Timesheet and tap "Ask for more time": write why it is late and the new day.`;
    // eslint-disable-next-line no-await-in-loop
    const r = skipAssignee && skipAssignee(u) ? { inApp: false, email: false } : await notify('taskLate', { userId: u.id, name: u.name, email: u.email }, { title, message }, { now, settings, mailer });
    // eslint-disable-next-line no-await-in-loop
    await prisma.task.update({ where: { id: t.id }, data: { overdueRemindedOn: today } }).catch(() => {});
    if (r.inApp || r.email) out.reminded += 1;
    if (t.assignedById && t.assignedById !== t.assigneeId) {
      if (!byGiver.has(t.assignedById)) byGiver.set(t.assignedById, []);
      byGiver.get(t.assignedById).push({ t, late, who: u.name });
    }
  }
  // THE PERSON WHO GAVE THE TASK hears too: ONE bell entry a day listing their late tasks (2026-10-12).
  out.givers = 0;
  for (const [giverId, list] of byGiver) {
    // eslint-disable-next-line no-await-in-loop
    const g = await prisma.user.findUnique({ where: { id: giverId }, select: { id: true, name: true, email: true, status: true } });
    if (!userOk(g)) continue;
    const lines = list.map((x) => `- ${x.t.name} (${x.who}, ${x.late} day${x.late === 1 ? '' : 's'} late, was due ${dmy(x.t.endDate)})`).join('\n');
    const title = `${list.length} task${list.length === 1 ? '' : 's'} you gave ${list.length === 1 ? 'is' : 'are'} late`;
    // eslint-disable-next-line no-await-in-loop
    const r2 = await notify('taskLate', { userId: g.id, name: g.name, email: g.email }, { title, message: `${lines}\nOpen: /employee-services?tab=timesheet` }, { now, settings, mailer });
    if (r2.inApp || r2.email) out.givers += 1;
  }
  if (!testMode && out.reminded && !settings.emailsOn) {
    // eslint-disable-next-line no-console
    console.log(`[tasks] ${out.reminded} overdue-task reminder(s) were put in the bell; emails are OFF (Admin turns them on), so nothing was mailed.`);
  }
  return out;
}

module.exports = { remind };
