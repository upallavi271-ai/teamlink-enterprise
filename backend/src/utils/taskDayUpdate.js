// ---------------------------------------------------------------------------
// TIMESHEET DAILY TRACKING (founder 2026-11-10: "Timesheet lo daily tracking undali, eroju kani complete cheyapothey adhi emaindhi ani
// notification povali, adhi entha daka vachindhi ani tracking undali").
//
//   Today's update   On any open task the person it is FOR writes, once a day (they may change it the same day): how far it got
//                    (0-100 %), what they did today and - when it is not finished - why. Task.progress keeps the latest figure;
//                    every day stays as its own line (TaskDayUpdate), so anyone who can open the task sees how it moved day by day.
//   18:00 ask        Working days. Everybody with an open task that was due TODAY or is already late, and no update for it today,
//                    gets ONE note (bell + email + popup): "not finished today - what happened?", with the list and where to answer.
//   19:00 report     Whoever GAVE those tasks (not to themselves) gets ONE note: each task, how far it got today and the reason,
//                    or "no update given". A task someone gave themselves goes to their reporting manager (their TL) instead.
// Both run through utils/hrmsNotify.js notify() (Admin's per-event switches, the email master switch, one note per title per day) and
// the popup of utils/dayNudges.js. People who left, inactive logins and test records get nothing. The sandbox runs no timers.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const HN = require('./hrmsNotify');
const WD = require('./workingDays');
const { localDate, localTime } = require('./attendanceDays');

const OPEN = ['Not Started', 'In Progress', 'On Hold'];
const LEFT = ['Relieved', 'Exited'];
const TEST_RE = /zztest|example\.test/i;
const ASK_AT = '18:00';
const REPORT_AT = '19:00';
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (iso) => `${Number(iso.slice(8, 10))} ${MON3[Number(iso.slice(5, 7)) - 1]}`;
const mins = (t) => { const m = /^(\d{2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
const OPEN_LINK = 'Open: /employee-services?tab=timesheet';

/** Checks a daily update. Returns { error } or the clean values. */
function check(body, task, day) {
  const progress = Math.round(Number(body.progress));
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) return { error: 'Pick how far it got: 0 to 100 %.' };
  const done = String(body.done || '').trim().slice(0, 1000);
  const why = String(body.why || '').trim().slice(0, 1000);
  if (!done) return { error: 'Write what you did on it today (even "nothing today, because ...").' };
  const dueNow = !!task.endDate && task.endDate <= day;
  if (progress < 100 && dueNow && !why) return { error: `"${task.name}" was due ${task.endDate === day ? 'today' : dmy(task.endDate)}. Write why it is not finished.` };
  return { progress, done, why };
}

/** Saves today's update for the task (one per day; a second save the same day replaces it). Only the person the task is for. */
async function save(me, task, body, day = localDate(new Date())) {
  if (task.assigneeId !== me.id) return { status: 403, error: `Only ${task.assigneeName} can give the daily update on this task.` };
  if (!OPEN.includes(task.status)) return { status: 400, error: task.status === 'Completed' ? 'This task is already marked done.' : 'This task is cancelled.' };
  const c = check(body || {}, task, day);
  if (c.error) return { status: 400, error: c.error };
  const data = { progress: c.progress, done: c.done, why: c.progress >= 100 ? '' : c.why, byId: me.id, byName: me.name || '' };
  const row = await prisma.taskDayUpdate.upsert({
    where: { taskId_date: { taskId: task.id, date: day } },
    create: { taskId: task.id, date: day, ...data },
    update: data,
  });
  // Giving an update means the work has started.
  await prisma.task.update({
    where: { id: task.id },
    data: { progress: c.progress, ...(task.status === 'Not Started' && c.progress > 0 ? { status: 'In Progress', startedAt: task.startedAt || new Date() } : {}) },
  });
  return { update: row, progress: c.progress, finishHint: c.progress >= 100 ? 'It says 100 %. Press "Mark as done" so your TL can approve it.' : '' };
}

/** Every day's update of one task, newest first. */
function history(taskId) {
  return prisma.taskDayUpdate.findMany({ where: { taskId }, orderBy: { date: 'desc' }, take: 120 });
}

/** Today's update for a set of tasks: Map taskId -> row. */
async function todayOf(taskIds, day = localDate(new Date())) {
  if (!taskIds.length) return new Map();
  const rows = await prisma.taskDayUpdate.findMany({ where: { taskId: { in: taskIds }, date: day } });
  return new Map(rows.map((r) => [r.taskId, r]));
}

// ---- the evening notes ----
async function activeUsers(ids) {
  const emps = await prisma.employee.findMany({
    where: { userId: { in: [...new Set(ids)] }, employmentStatus: { notIn: LEFT } },
    select: { name: true, email: true, userId: true, reportingManager: { select: { userId: true } }, user: { select: { status: true, email: true, name: true } } },
  });
  return new Map(emps
    .filter((e) => e.user && (e.user.status || 'Active') === 'Active' && !TEST_RE.test(`${e.name} ${e.email || ''} ${e.user.email || ''}`))
    .map((e) => [e.userId, { userId: e.userId, name: e.name, email: e.email || e.user.email || null, tl: e.reportingManager ? e.reportingManager.userId : null }]));
}

/** The open tasks that should have been finished by today (due today or late). */
function dueTasks(day) {
  return prisma.task.findMany({
    where: { status: { in: OPEN }, endDate: { not: null, lte: day } },
    select: { id: true, name: true, endDate: true, progress: true, status: true, assigneeId: true, assigneeName: true, assignedById: true },
    orderBy: { endDate: 'asc' },
  });
}

const popup = (...a) => require('./dayNudges').popup(...a); // eslint-disable-line global-require

/** 18:00 - "not finished today, what happened?" to each person who has not answered yet. */
async function ask(now = new Date()) {
  const day = localDate(now);
  const tasks = await dueTasks(day);
  const answered = await todayOf(tasks.map((t) => t.id), day);
  const waiting = tasks.filter((t) => !answered.has(t.id));
  const users = await activeUsers(waiting.map((t) => t.assigneeId));
  const settings = await HN.getSettings();
  let sent = 0;
  for (const [userId, u] of users) { // eslint-disable-line no-restricted-syntax
    const mine = waiting.filter((t) => t.assigneeId === userId);
    if (!mine.length) continue; // eslint-disable-line no-continue
    const lines = mine.slice(0, 8).map((t) => `- ${t.name} (${t.endDate === day ? 'due today' : `due ${dmy(t.endDate)}, late`}, ${t.progress || 0}% so far)`);
    if (mine.length > 8) lines.push(`... and ${mine.length - 8} more`);
    const title = `${mine.length === 1 ? 'A task is' : `${mine.length} tasks are`} not finished today - what happened? (${dmy(day)})`;
    const message = [
      'These were due by today and are not finished:', ...lines,
      'Open Timesheet, press "Today\'s update" on each one: how far it got, what you did today and why it is not finished.',
      'If it is finished, press "Mark as done".', OPEN_LINK,
    ].join('\n');
    try {
      await HN.notify('taskDayAsk', u, { title, message }, { now, settings }); // eslint-disable-line no-await-in-loop
      await popup(userId, title, message, now); // eslint-disable-line no-await-in-loop
      sent += 1;
    } catch (err) { console.error('[task-day] ask', err.message); } // eslint-disable-line no-console
  }
  return { due: tasks.length, waiting: waiting.length, sent };
}

/** 19:00 - to whoever gave the tasks (or the TL for a task someone gave themselves): how far each got today and why. */
async function report(now = new Date()) {
  const day = localDate(now);
  const tasks = await dueTasks(day);
  const answered = await todayOf(tasks.map((t) => t.id), day);
  const people = await activeUsers(tasks.map((t) => t.assigneeId));
  const byBoss = new Map();
  tasks.forEach((t) => {
    const self = !t.assignedById || t.assignedById === t.assigneeId;
    const boss = self ? (people.get(t.assigneeId) || {}).tl : t.assignedById;
    if (!boss || boss === t.assigneeId) return;
    if (!byBoss.has(boss)) byBoss.set(boss, []);
    byBoss.get(boss).push(t);
  });
  const bosses = await activeUsers([...byBoss.keys()]);
  const settings = await HN.getSettings();
  let sent = 0;
  for (const [bossId, list] of byBoss) { // eslint-disable-line no-restricted-syntax
    const b = bosses.get(bossId);
    if (!b) continue; // eslint-disable-line no-continue
    const lines = list.slice(0, 15).map((t) => {
      const u = answered.get(t.id);
      const when = t.endDate === day ? 'due today' : `due ${dmy(t.endDate)}, late`;
      return u
        ? `- ${t.assigneeName}: ${t.name} (${when}) - ${u.progress}% done. Today: ${u.done}${u.why ? ` Why not finished: ${u.why}` : ''}`
        : `- ${t.assigneeName}: ${t.name} (${when}) - ${t.progress || 0}% so far. No update given today.`;
    });
    if (list.length > 15) lines.push(`... and ${list.length - 15} more`);
    const missing = list.filter((t) => !answered.has(t.id)).length;
    const title = `${list.length} task${list.length === 1 ? '' : 's'} not finished today${missing ? ` (${missing} without an update)` : ''} - ${dmy(day)}`;
    const message = ['Tasks that were due by today and are not finished:', ...lines, OPEN_LINK].join('\n');
    try {
      await HN.notify('taskDayReport', b, { title, message }, { now, settings }); // eslint-disable-line no-await-in-loop
      sent += 1;
    } catch (err) { console.error('[task-day] report', err.message); } // eslint-disable-line no-console
  }
  return { due: tasks.length, bosses: sent };
}

const lastRun = {};
async function tick(now = new Date()) {
  const day = localDate(now);
  await WD.ready().catch(() => {});
  if (!WD.isWorking(day)) return;
  const t = mins(localTime(now));
  for (const [key, at, fn] of [['ask', ASK_AT, ask], ['report', REPORT_AT, report]]) { // eslint-disable-line no-restricted-syntax
    // once a day, from its time until 90 minutes later (a server that was off at 18:00 still asks at 18:20)
    if (lastRun[key] === day || t < mins(at) || t > mins(at) + 90) continue; // eslint-disable-line no-continue
    lastRun[key] = day;
    // eslint-disable-next-line no-await-in-loop
    const r = await fn(now).catch((e) => ({ error: e.message }));
    console.log(`[task-day] ${key} ${day}:`, JSON.stringify(r)); // eslint-disable-line no-console
  }
}

function start() {
  if (process.env.NODE_ENV === 'test' || require('./sandbox').isSandbox() || process.env.TASK_DAY_NOTES === '0') return; // eslint-disable-line global-require
  const every = setInterval(() => tick().catch(() => {}), 5 * 60 * 1000);
  const first = setTimeout(() => tick().catch(() => {}), 90 * 1000);
  if (every.unref) every.unref();
  if (first.unref) first.unref();
}

module.exports = { check, save, history, todayOf, ask, report, tick, start, ASK_AT, REPORT_AT };
