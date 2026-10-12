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
async function remind({ open, users, today, notify, settings, mailer, now, userOk, testMode = false }) {
  const due = open
    .filter((t) => t.endDate && t.endDate < today)
    .sort((a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || a.endDate.localeCompare(b.endDate));
  const out = { overdue: due.length, reminded: 0, skipped: 0, alreadyToday: 0 };
  for (const t of due) {
    if (t.overdueRemindedOn === today) { out.alreadyToday += 1; continue; }
    const u = users.get(t.assigneeId);
    if (!userOk(u)) { out.skipped += 1; continue; }
    const late = daysBetween(t.endDate, today);
    const title = `Task overdue: ${t.name} (was due ${dmy(t.endDate)})`;
    const message = `Your task "${t.name}" is ${late} day${late === 1 ? '' : 's'} late. It was due ${dmy(t.endDate)}. Priority: ${t.priority || 'Medium'}. Status: ${t.status}. Please finish it or ask ${t.assignedByName || 'your manager'} to move the date.`;
    // eslint-disable-next-line no-await-in-loop
    const r = await notify('taskLate', { userId: u.id, name: u.name, email: u.email }, { title, message }, { now, settings, mailer });
    // eslint-disable-next-line no-await-in-loop
    await prisma.task.update({ where: { id: t.id }, data: { overdueRemindedOn: today } }).catch(() => {});
    if (r.inApp || r.email) out.reminded += 1;
  }
  if (!testMode && out.reminded && !settings.emailsOn) {
    // eslint-disable-next-line no-console
    console.log(`[tasks] ${out.reminded} overdue-task reminder(s) were put in the bell; emails are OFF (Admin turns them on), so nothing was mailed.`);
  }
  return out;
}

module.exports = { remind };
