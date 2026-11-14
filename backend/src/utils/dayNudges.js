// ---------------------------------------------------------------------------
// MORNING / AFTERNOON / EVENING REMINDERS + "A COURSE WAS GIVEN TO YOU" (founder 2026-11-04: "add emails ki and notification andhariki
// theliselaga popup message ravali timesheet morning and evening and afternoon ala ga ... valla tasks gurinchi, lms kuda course assign
// ithey complete cheyali ani ravali").
//
// THREE TIMES A DAY (IST, working days only - no Sunday / company holiday): 10:00, 14:00 and 17:30 every working employee gets one
// note about THEIR day: open tasks (due today / late), courses still to complete, and what to write in Timesheet > Checklist.
// A COURSE ASSIGNED: within a few minutes of a course being given to someone, a note "complete this course".
// Each note goes three ways: the bell (In-App) and email through utils/hrmsNotify.js notify() (events 'dayNudge' / 'courseAssigned':
// Admin switches, the email master switch, one per person per title per day), and a POPUP that opens on the person's screen
// (a Notification row, channel 'Popup', status 'Waiting' -> 'Shown' when closed; routes/nudges.js, components/NudgePopup.jsx).
// People who left, inactive logins and test records get nothing. In the test sandbox nothing runs by itself.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const HN = require('./hrmsNotify');
const WD = require('./workingDays');
const { localDate, localTime } = require('./attendanceDays');

const SLOTS = [
  { key: 'morning', at: '10:00', label: 'Morning', lead: 'Good morning! Plan your day.' },
  { key: 'afternoon', at: '14:00', label: 'Afternoon', lead: 'Half the day is done. Write what you did so far.' },
  { key: 'evening', at: '17:30', label: 'Evening', lead: 'Before you leave, finish your Timesheet for today.' },
];
const OPEN = ['Not Started', 'In Progress', 'On Hold'];
const LEFT = ['Relieved', 'Exited'];
const TEST_RE = /zztest|example\.test/i;
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (iso) => `${Number(iso.slice(8, 10))} ${MON3[Number(iso.slice(5, 7)) - 1]}`;
const mins = (t) => { const m = /^(\d{2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };

// a popup for one person, once per title per day
async function popup(userId, title, message, now = new Date()) {
  if (!userId) return false;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const seen = await prisma.notification.findFirst({ where: { userId, title, channel: 'Popup', createdAt: { gte: start } }, select: { id: true } });
  if (seen) return false;
  // read: true keeps it out of the bell's unread count (the bell has its own In-App row)
  await prisma.notification.create({ data: { userId, title, message, channel: 'Popup', status: 'Waiting', read: true } });
  return true;
}

async function people() {
  const emps = await prisma.employee.findMany({
    where: { employmentStatus: { notIn: LEFT }, userId: { not: null } },
    select: { id: true, name: true, email: true, userId: true, user: { select: { id: true, status: true, email: true, name: true } } },
  });
  return emps.filter((e) => e.user && (e.user.status || 'Active') === 'Active' && !TEST_RE.test(`${e.name} ${e.email || ''} ${e.user.email || ''}`));
}

// JOINED candidates (client placements) whose CTC is not in the ATS: the BDE of the requirement gets a popup, in every slot of every working day, until the CTC is
// filled (founder 2026-11-14: "aa pop up BDE vallaki ravali, fill CTC to these candidates, vallu fill chese varaku"). Their invoices wait at a fee of 0 until then.
async function ctcPending(slot, now = new Date()) {
  const J = require('./joining'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({
    where: { stage: 'JOINED', OR: [{ offeredCtc: null }, { offeredCtc: 0 }], requirement: { bdeId: { not: null } } },
    select: { hiringType: true, joiningDate: true, candidate: { select: { name: true } }, requirement: { select: { bdeId: true, hiringType: true, internal: true, client: { select: { name: true } } } } },
  });
  const byBde = new Map();
  apps.filter((a) => !J.isInternalHire(a, a.requirement)).forEach((a) => {
    const k = a.requirement.bdeId; if (!byBde.has(k)) byBde.set(k, []);
    byBde.get(k).push(a);
  });
  let sent = 0;
  for (const [userId, list] of byBde) { // eslint-disable-line no-restricted-syntax
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true, email: true, name: true } }); // eslint-disable-line no-await-in-loop
    if (!user || (user.status || 'Active') !== 'Active' || TEST_RE.test(`${user.name} ${user.email || ''}`)) continue; // eslint-disable-line no-continue
    const title = `Fill the CTC for ${list.length} joined candidate${list.length === 1 ? '' : 's'} - ${slot.label.toLowerCase()} ${dmy(localDate(now))}`;
    const names = list.slice(0, 10).map((a) => `${a.candidate ? a.candidate.name : '?'} (${a.requirement.client ? a.requirement.client.name : ''}${a.joiningDate ? `, joined ${dmy(String(a.joiningDate).slice(0, 10))}` : ''})`);
    const message = [
      'These candidates have joined, but the ATS has no CTC for them. Accounts cannot work out the invoice fee until you enter it.',
      ...names, list.length > 10 ? `... and ${list.length - 10} more` : '',
      'Open ATS > Joining and fill the CTC of each candidate. This reminder comes three times a day until every CTC is filled.',
      'Open: /ats/joining',
    ].filter(Boolean).join('\n');
    try {
      if (await popup(userId, title, message, now)) sent += 1; // eslint-disable-line no-await-in-loop
    } catch (err) { console.error('[day-nudges] ctc', err.message); } // eslint-disable-line no-console
  }
  return { sent };
}

// one slot for everybody -> { sent }
async function runSlot(slot, now = new Date()) {
  const day = localDate(now);
  const list = await people();
  if (!list.length) return { sent: 0 };
  const userIds = list.map((e) => e.userId);
  const [tasks, courses, checks] = await Promise.all([
    prisma.task.findMany({ where: { assigneeId: { in: userIds }, status: { in: OPEN } }, select: { assigneeId: true, name: true, endDate: true } }),
    prisma.courseAssignment.findMany({ where: { employeeId: { in: list.map((e) => e.id) }, completed: false, course: { approvalStatus: 'Approved' } }, select: { employeeId: true, dueDate: true, course: { select: { title: true } } } }),
    prisma.timesheetChecklist.groupBy({ by: ['employeeId'], where: { date: day, employeeId: { in: list.map((e) => e.id) } }, _count: true }).catch(() => []),
  ]);
  const checkOf = new Map(checks.map((c) => [c.employeeId, c._count]));
  const settings = await HN.getSettings();
  let sent = 0;
  for (const e of list) { // eslint-disable-line no-restricted-syntax
    const mine = tasks.filter((t) => t.assigneeId === e.userId);
    const late = mine.filter((t) => t.endDate && t.endDate < day);
    const today = mine.filter((t) => t.endDate === day);
    const myCourses = courses.filter((c) => c.employeeId === e.id);
    const written = checkOf.get(e.id) || 0;
    const lines = [slot.lead];
    lines.push(mine.length
      ? `Tasks open: ${mine.length}${today.length ? ` (${today.length} due today)` : ''}${late.length ? ` - ${late.length} late` : ''}. ${mine.slice(0, 3).map((t) => t.name).join(', ')}${mine.length > 3 ? ' ...' : ''}`
      : 'No open tasks right now.');
    if (myCourses.length) lines.push(`Courses to complete: ${myCourses.length} - ${myCourses.slice(0, 3).map((c) => c.course.title).join(', ')}${myCourses.length > 3 ? ' ...' : ''}`);
    lines.push(written ? `Checklist today: ${written} ${written === 1 ? 'entry' : 'entries'} written.` : 'Checklist today: nothing written yet - add what you did in Timesheet > Checklist.');
    lines.push('Open: /employee-services?tab=timesheet');
    const title = `${slot.label} reminder - ${dmy(day)}`;
    const message = lines.join('\n');
    const who = { userId: e.userId, name: e.name, email: e.email || e.user.email || null };
    try {
      await HN.notify('dayNudge', who, { title, message }, { now, settings }); // eslint-disable-line no-await-in-loop
      if (await popup(e.userId, title, message, now)) sent += 1; // eslint-disable-line no-await-in-loop
    } catch (err) { console.error('[day-nudges]', err.message); } // eslint-disable-line no-console
  }
  try { const c = await ctcPending(slot, now); sent += c.sent; } catch (err) { console.error('[day-nudges] ctc', err.message); } // eslint-disable-line no-console
  return { sent };
}

// courses given in the last 30 minutes -> "complete this course"
async function coursesGiven(now = new Date()) {
  const since = new Date(now.getTime() - 30 * 60 * 1000);
  const rows = await prisma.courseAssignment.findMany({
    where: { assignedAt: { gte: since }, completed: false, course: { approvalStatus: 'Approved' } },
    select: { dueDate: true, employee: { select: { id: true, name: true, email: true, userId: true, employmentStatus: true, user: { select: { status: true, email: true } } } }, course: { select: { title: true } } },
  });
  const settings = await HN.getSettings();
  let sent = 0;
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const e = r.employee;
    if (!e || !e.userId || LEFT.includes(e.employmentStatus) || (e.user && e.user.status && e.user.status !== 'Active') || TEST_RE.test(`${e.name} ${e.email || ''}`)) continue; // eslint-disable-line no-continue
    const due = r.dueDate ? ` by ${dmy(new Date(r.dueDate).toISOString().slice(0, 10))}` : '';
    const title = `Course to complete: ${r.course.title}`.slice(0, 190);
    const message = `A course was given to you: "${r.course.title}". Please complete it${due} - watch the videos, read the documents and take the assessment.\nOpen: /performance?tab=lms`;
    try {
      await HN.notify('courseAssigned', { userId: e.userId, name: e.name, email: e.email || (e.user && e.user.email) || null }, { title, message }, { now, settings }); // eslint-disable-line no-await-in-loop
      if (await popup(e.userId, title, message, now)) sent += 1; // eslint-disable-line no-await-in-loop
    } catch (err) { console.error('[day-nudges] course', err.message); } // eslint-disable-line no-console
  }
  return { sent };
}

const lastRun = {}; // slot key -> YYYY-MM-DD
async function tick(now = new Date()) {
  await coursesGiven(now).catch((e) => console.error('[day-nudges] courses', e.message)); // eslint-disable-line no-console
  const day = localDate(now);
  await WD.ready().catch(() => {});
  if (!WD.isWorking(day)) return;
  const t = mins(localTime(now));
  for (const s of SLOTS) { // eslint-disable-line no-restricted-syntax
    // a slot runs once a day, from its time until 90 minutes later (a server that was off at 10:00 still sends at 10:20)
    if (lastRun[s.key] === day || t < mins(s.at) || t > mins(s.at) + 90) continue; // eslint-disable-line no-continue
    lastRun[s.key] = day;
    // eslint-disable-next-line no-await-in-loop
    const r = await runSlot(s, now).catch((e) => ({ error: e.message }));
    console.log(`[day-nudges] ${s.key} ${day}:`, JSON.stringify(r)); // eslint-disable-line no-console
  }
}

function start() {
  if (process.env.NODE_ENV === 'test' || require('./sandbox').isSandbox() || process.env.DAY_NUDGES === '0') return; // eslint-disable-line global-require
  const every = setInterval(() => tick().catch(() => {}), 5 * 60 * 1000);
  const first = setTimeout(() => tick().catch(() => {}), 60 * 1000);
  if (every.unref) every.unref();
  if (first.unref) first.unref();
}

module.exports = { SLOTS, runSlot, ctcPending, coursesGiven, tick, start, popup };
