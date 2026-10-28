// ---------------------------------------------------------------------------
// HRMS NOTIFICATIONS & EMAIL REMINDERS (HRMS changes, item 14).
//
// Reuses what exists: the Notification table (the bell) and utils/mailer.js
// (SMTP, faked in the sandbox). Nothing new is stored except one settings row.
//
// EVENTS, each with an Admin switch for in-app and for email:
//   leaveDecision    Leave approved / rejected          email at once
//   lateLogin        Late login                          daily email
//   earlyLogout      Early logout                        daily email
//   missingCheckIn   Missing check-in                    daily email
//   missingCheckOut  Missing check-out                   daily email
//   taskAssigned     A task was given to you             daily email
//   taskDue          A task is due (today / tomorrow)    daily email
//   taskLate         Tasks past their end date           daily email
//   goalNotMet       A monthly target was not reached    daily email
//
// NO FLOODS.
//   * In-app: one bell entry per person per event per day; late tasks and
//     missed targets are GROUPED into one entry ("3 tasks are late").
//   * Email: only a leave decision is mailed at once. Everything else waits
//     as a Notification row (channel Email, status WAITING) and goes out in
//     ONE daily email per person at the digest time.
//
// SENDING EMAIL IS OFF UNTIL ADMIN TURNS IT ON (emailsOn). Until then the
// email rows are still recorded (and wait), but nothing is handed to SMTP —
// so shipping this never mails real people before the user says so.
//
// Settings: Integration row 'hrms-notify' (JSON values) — no schema change.
// Test users (ZZTEST / example.test) are never notified by the real sweeps.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { sendMail } = require('./mailer');
const { logAudit } = require('./audit');
const { localDate, localTime } = require('./attendanceDays');

const STORE_ID = 'hrms-notify';
const WAITING = 'Waiting for the daily email';
const EVENTS = {
  leaveDecision: { label: 'Leave approved / rejected', instant: true },
  latePermission: { label: 'Late coming asked / approved / rejected', instant: true },
  // 2026-10-13 (HRMS item 2): the approver whose turn it is hears at once (bell + email) about a new leave /
  // attendance-correction request, and about one handed over to them.
  approvalRaised: { label: 'A request is waiting for your decision (leave, attendance correction)', instant: true },
  // 2026-10-17 (Joining and drop): a candidate joined / a joined candidate dropped / the client decided about a replacement.
  // The per-person switches live in Administration -> Step timing -> Joinings and drops; email still needs the master switch below.
  joinNotice: { label: 'A candidate joined (client, recruiter, TL, BDE, HR told)', instant: true },
  dropNotice: { label: 'A joined candidate dropped (client, recruiter, TL, BDE, HR told)', instant: true },
  replacementDecision: { label: 'The client decided about a replacement (recruiter, TL, BDE, HR told)', instant: true },
  lateLogin: { label: 'Late login' },
  earlyLogout: { label: 'Early logout' },
  missingCheckIn: { label: 'Missing check-in' },
  missingCheckOut: { label: 'Missing check-out' },
  // 2026-10-13: yesterday's (or earlier) attendance problems to put right - the employee's own, and a team lead's grouped list (utils/attendanceTasks.js)
  attendanceIssue: { label: 'Attendance issue to resolve (yours, or your team)' },
  taskAssigned: { label: 'Task given to you' },
  taskChanged: { label: 'A task you were given was changed (new date, moved, cancelled)' },
  taskDone: { label: 'A task you gave was finished' },
  taskDue: { label: 'Task due soon' },
  taskLate: { label: 'Tasks not finished on time' },
  taskDayEnd: { label: 'End-of-day task report (Super Admin): completed, waiting for TL, partly done, in progress' },
  goalNotMet: { label: 'Monthly target not reached' },
};
const EVENT_KEYS = Object.keys(EVENTS);
// Spec: important HRMS activities send BOTH in-app and email.
const DEFAULTS = {
  events: Object.fromEntries(EVENT_KEYS.map((k) => [k, { inApp: true, email: true }])),
  digestTime: '19:00',
  reminderTime: '09:30',
  taskDueDays: 1,
  emailsOn: false,
  // 2026-10-15 (founder): attendance alert emails go AT ONCE, as separate emails (not parked for the daily email).
  mailMode: 'now',
};
// Attendance alert emails: Send at once (now) | Include in the daily email only (daily) | Do not email (off).
const MODES = ['now', 'daily', 'off'];
const ATTENDANCE_MAIL_EVENTS = ['lateLogin', 'earlyLogout', 'missingCheckIn', 'missingCheckOut'];
const EMAILS_OFF = 'Not sent: emails are switched off by Admin';
const LEGACY_OFF = 'Not sent — emails are off (Admin turns them on)';
const NOT_SET_UP = 'Not sent: mail is not set up';
const LEGACY_NOT_SET_UP = 'Not sent — email is not set up';
const NO_ADDRESS = 'Not sent: no email address';
const BEFORE_ON = 'Not sent: recorded before emails were switched on';
// A failed email is tried again 3 times, after 5, 20 and 80 minutes (counted from when the alert was made).
const RETRY_AFTER_MIN = [5, 20, 80];
const MAX_RETRIES = 3;
const TEST_RE = /zztest|example\.test/i;
const isTest = (...v) => TEST_RE.test(v.filter(Boolean).join(' '));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dmy = (iso) => `${iso.slice(8, 10)}-${MON3[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; };
const minutesOf = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// ---- settings ---------------------------------------------------------------
async function getSettings() {
  let values = {};
  try {
    const row = await prisma.integration.findUnique({ where: { id: STORE_ID } });
    values = row && row.values ? JSON.parse(row.values) : {};
  } catch { values = {}; }
  const events = {};
  EVENT_KEYS.forEach((k) => {
    const v = (values.events || {})[k] || {};
    events[k] = { inApp: v.inApp !== undefined ? !!v.inApp : DEFAULTS.events[k].inApp, email: v.email !== undefined ? !!v.email : DEFAULTS.events[k].email, mode: MODES.includes(v.mode) ? v.mode : '' };
  });
  return {
    events,
    mailMode: MODES.includes(values.mailMode) ? values.mailMode : DEFAULTS.mailMode,
    emailsOnAt: values.emailsOnAt || null,
    digestTime: HHMM.test(values.digestTime || '') ? values.digestTime : DEFAULTS.digestTime,
    reminderTime: HHMM.test(values.reminderTime || '') ? values.reminderTime : DEFAULTS.reminderTime,
    taskDueDays: Number.isInteger(values.taskDueDays) ? values.taskDueDays : DEFAULTS.taskDueDays,
    emailsOn: values.emailsOn === true,
  };
}

async function saveSettings(patch = {}, userId = null) {
  const cur = await getSettings();
  const next = { ...cur, events: { ...cur.events } };
  const errs = [];
  if (patch.events && typeof patch.events === 'object') {
    Object.entries(patch.events).forEach(([k, v]) => {
      if (!EVENTS[k] || !v || typeof v !== 'object') return;
      let mode = cur.events[k].mode;
      if (v.mode !== undefined) { if (v.mode === '' || MODES.includes(v.mode)) mode = v.mode; else errs.push('Choose Send at once, Include in the daily email only, or Do not email'); }
      next.events[k] = { inApp: v.inApp !== undefined ? !!v.inApp : cur.events[k].inApp, email: v.email !== undefined ? !!v.email : cur.events[k].email, mode };
    });
  }
  if (patch.mailMode !== undefined) { if (MODES.includes(patch.mailMode)) next.mailMode = patch.mailMode; else errs.push('Choose Send at once, Include in the daily email only, or Do not email'); }
  ['digestTime', 'reminderTime'].forEach((k) => {
    if (patch[k] === undefined) return;
    if (!HHMM.test(String(patch[k]))) errs.push(`${k === 'digestTime' ? 'Daily email time' : 'Reminder time'} must be a time like 19:00`);
    else next[k] = String(patch[k]);
  });
  if (patch.taskDueDays !== undefined) {
    const n = Number(patch.taskDueDays);
    if (!Number.isInteger(n) || n < 0 || n > 7) errs.push('Remind about tasks 0 to 7 days before they are due');
    else next.taskDueDays = n;
  }
  if (patch.emailsOn !== undefined) {
    next.emailsOn = !!patch.emailsOn;
    // The moment emails are switched ON is remembered: alerts made before it are never mailed by themselves (no flood).
    if (next.emailsOn && !cur.emailsOn) next.emailsOnAt = new Date().toISOString();
  }
  if (errs.length) return { error: errs.join('. ') };
  await prisma.integration.upsert({
    where: { id: STORE_ID },
    update: { values: JSON.stringify(next) },
    create: { id: STORE_ID, enabled: true, state: 'Internal', values: JSON.stringify(next) },
  });
  await logAudit({
    userId, action: 'HRMS notification settings updated', entity: 'Integration', entityId: STORE_ID,
    toValue: `emails ${next.emailsOn ? 'ON' : 'off'} · attendance alert emails: ${next.mailMode} · ${EVENT_KEYS.map((k) => `${EVENTS[k].label}: ${next.events[k].inApp ? 'app' : '-'}/${next.events[k].email ? 'email' : '-'}${next.events[k].mode ? `(${next.events[k].mode})` : ''}`).join(' · ')}`,
  });
  return { settings: next };
}

// ---- delivery -----------------------------------------------------------------
async function seenToday({ userId, recipient, title, channel, now }) {
  const or = [];
  if (userId) or.push({ userId });
  if (recipient) or.push({ recipient });
  if (!or.length) return false;
  return !!(await prisma.notification.findFirst({ where: { title, channel, createdAt: { gte: startOfDay(now) }, OR: or }, select: { id: true } }));
}

// How is this event's email sent? per-event choice, else: instant events at once, attendance alerts by the Admin choice, the rest daily.
function modeOf(s, event) {
  const ov = s.events[event] && s.events[event].mode;
  if (MODES.includes(ov)) return ov;
  if (EVENTS[event] && EVENTS[event].instant) return 'now';
  if (ATTENDANCE_MAIL_EVENTS.includes(event)) return s.mailMode || DEFAULTS.mailMode;
  return 'daily';
}
// What the mailer said, in plain words. retriesDone: how many retries already failed (0 = the first send).
function statusOfResult(r, retriesDone = 0, manual = false) {
  if (r.ok) return 'Sent';
  if (r.notConfigured) return NOT_SET_UP;
  const why = String(r.error || 'unknown error').replace(/\s+/g, ' ').slice(0, 150);
  if (manual || r.transient === false) return `Failed: ${why}`;
  const left = MAX_RETRIES - retriesDone;
  return left > 0 ? `Failed: ${why} (will retry, ${left} left)` : `Failed: ${why} (gave up after ${MAX_RETRIES} retries)`;
}
// The status a person reads in the log: honest about the master switch and about rows older than the switch-on moment.
function displayStatus(row, s) {
  const st = row.status;
  if (!st || row.channel !== 'Email') return st;
  if (!s.emailsOn && (st === WAITING || st === LEGACY_OFF)) return EMAILS_OFF;
  if (st === LEGACY_OFF) return EMAILS_OFF;
  if (st === LEGACY_NOT_SET_UP) return NOT_SET_UP;
  if (st === WAITING && s.emailsOnAt && new Date(row.createdAt) < new Date(s.emailsOnAt)) return BEFORE_ON;
  return st;
}

// One event for one person. Returns what happened, for tests and logs.
//   who: { userId, name, email }
async function notify(event, who, { title, message, html = null }, { now = new Date(), mailer = sendMail, settings = null } = {}) {
  const s = settings || await getSettings();
  const sw = s.events[event] || { inApp: false, email: false };
  const out = { inApp: false, email: null };
  if (!who || (!who.userId && !who.email)) return out;
  if (sw.inApp && who.userId && !await seenToday({ userId: who.userId, title, channel: 'In-App', now })) {
    await prisma.notification.create({ data: { userId: who.userId, title, message: message || null, channel: 'In-App', recipient: who.name || null, status: 'Delivered' } });
    out.inApp = true;
  }
  const mode = modeOf(s, event);
  if (sw.email && mode !== 'off') {
    const row = { userId: who.userId || null, title, message: message || null, channel: 'Email', read: true };
    if (!who.email) {
      // Only an email that was meant to go at once gets an honest "no address" line.
      if (mode === 'now' && who.userId && !await seenToday({ userId: who.userId, title, channel: 'Email', now })) {
        await prisma.notification.create({ data: { ...row, recipient: who.name || null, status: NO_ADDRESS } });
        out.email = NO_ADDRESS;
      }
    } else if (!await seenToday({ userId: who.userId, recipient: who.email, title, channel: 'Email', now })) {
      // One email per person per event per day: the Notification row is the record (title carries the date).
      if (mode === 'now' && !s.emailsOn) {
        await prisma.notification.create({ data: { ...row, recipient: who.email, status: EMAILS_OFF } });
        out.email = EMAILS_OFF;
      } else if (mode === 'now') {
        const r = await mailer({ to: who.email, subject: `TeamLink — ${title}`, text: message || title, ...(html ? { html } : {}), useEmployeeFrom: false });
        const status = statusOfResult(r, 0);
        await prisma.notification.create({ data: { ...row, recipient: who.email, status } });
        out.email = status;
      } else {
        // Daily email only. Attendance alerts say plainly when the master switch is off; others keep waiting as before.
        const off = !s.emailsOn && ATTENDANCE_MAIL_EVENTS.includes(event);
        await prisma.notification.create({ data: { ...row, recipient: who.email, status: off ? EMAILS_OFF : WAITING } });
        out.email = off ? EMAILS_OFF : WAITING;
      }
    }
  }
  return out;
}

async function whoOfEmployee(employee) {
  if (!employee) return null;
  const user = employee.userId ? await prisma.user.findUnique({ where: { id: employee.userId }, select: { id: true, name: true, email: true, status: true } }) : null;
  return { userId: user && user.status !== 'Inactive' ? user.id : null, name: employee.name, email: employee.email || (user && user.email) || null };
}

// ---- the events ---------------------------------------------------------------
async function leaveDecided({ leave, employee, by }) {
  const who = await whoOfEmployee(employee || await prisma.employee.findUnique({ where: { id: leave.employeeId } }));
  const when = leave.toDate && leave.toDate !== leave.fromDate ? `${dmy(leave.fromDate)} to ${dmy(leave.toDate)}` : dmy(leave.fromDate);
  const approved = leave.status === 'Approved';
  const title = `Leave ${approved ? 'approved' : 'rejected'} — ${leave.type}, ${when}`;
  const message = approved
    ? `Your ${leave.type} for ${when} (${leave.days ?? 1} day(s)) was approved by ${by ? by.name || by.email : 'your approver'}.`
    : `Your ${leave.type} for ${when} was rejected by ${by ? by.name || by.email : 'your approver'}. Reason: ${leave.rejectReason || '—'}`;
  return notify('leaveDecision', who, { title, message });
}

// LATE PERMISSION: the approver whose turn it is hears about a new request (bell), the employee hears the decision.
async function latePermissionRaised({ perm, employee, by }) {
  const steps = await prisma.approvalStep.findMany({ where: { workflow: 'latePermission', recordId: perm.id, status: 'Pending' } });
  const ids = [...new Set(steps.map((s) => s.approverUserId).filter(Boolean))].filter((id) => !by || id !== by.id);
  const explain = perm.kind === 'Explain';
  const title = `Late coming asked — ${employee.name}, ${dmy(perm.date)}`;
  const message = explain
    ? `${employee.name} came late on ${dmy(perm.date)} (at ${perm.arrivedAt || perm.expectedTime}) and says why. Reason: ${perm.reason}. Open Attendance → Late coming to approve or reject.
Open: /attendance?tab=late`
    : `${employee.name} asks to come in late on ${dmy(perm.date)} (by ${perm.expectedTime}). Reason: ${perm.reason}. Open Attendance → Late coming to decide.
Open: /attendance?tab=late`;
  for (const id of ids) {
    const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true } });
    if (u) await notify('latePermission', { userId: u.id, name: u.name, email: u.email }, { title, message });
  }
}
async function latePermissionDecided({ perm, employee, by }) {
  const who = await whoOfEmployee(employee || await prisma.employee.findUnique({ where: { id: perm.employeeId } }));
  const approved = perm.status === 'Approved';
  const title = `Late coming ${approved ? 'approved' : 'rejected'} — ${dmy(perm.date)}`;
  const message = approved
    ? `Your late coming on ${dmy(perm.date)} (${perm.kind === 'Explain' ? 'came' : 'arrive by'} ${perm.expectedTime}) was approved by ${by ? by.name || by.email : 'your approver'}. It is not counted as a late arrival.
Open: /attendance?tab=late`
    : `Your late coming on ${dmy(perm.date)} was rejected by ${by ? by.name || by.email : 'your approver'}. Reason: ${perm.decisionNote || '—'}. It still counts as late.
Open: /attendance?tab=late`;
  return notify('latePermission', who, { title, message });
}

// ---- a request is waiting for the approver (leave, attendance correction) ----------------------------------
// ONE bell + ONE email to the person whose step is Pending (the first approver on the chain: TL, or the next rung
// when the TL is missing / the applicant is a TL). Plain words, a button to the approval card, no private details
// (the leave reason is never sent). opts.also: extra text lines (the early-logout check).
const KIND_WORDS = { leave: 'leave', regularization: 'an attendance correction' };
async function approvalRaised({ workflow = 'leave', recordId, employee, title, line, openPath, also = [], reassignedBy = null, toUserId = null, now = new Date(), mailer = sendMail }) {
  const where = toUserId ? { workflow, recordId, approverUserId: toUserId, status: 'Pending' } : { workflow, recordId, status: 'Pending' };
  const steps = await prisma.approvalStep.findMany({ where });
  const ids = [...new Set(steps.map((s) => s.approverUserId).filter(Boolean))].filter((id) => !employee || id !== employee.userId);
  const out = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, status: true } });
    if (!u || u.status === 'Inactive') continue; // eslint-disable-line no-continue
    const link = require('./pendingWork').absolute(openPath); // eslint-disable-line global-require
    const message = [line, ...also.filter(Boolean), reassignedBy ? `Handed to you by ${reassignedBy}.` : null, 'Approve or reject in TeamLink.', `Open: ${openPath}`].filter(Boolean).join(String.fromCharCode(10));
    const M = require('./reportMailHtml'); // eslint-disable-line global-require
    const html = M.page(title, M.p(line) + also.filter(Boolean).map((t) => M.p(t)).join('') + (reassignedBy ? M.p(`Handed to you by ${reassignedBy}.`) : '') + M.button(link, 'Approve or reject'));
    // eslint-disable-next-line no-await-in-loop
    out.push({ userId: u.id, ...(await notify('approvalRaised', { userId: u.id, name: u.name, email: u.email }, { title, message, html }, { now, mailer })) });
  }
  return out;
}
const dayName = (iso) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${iso}T00:00:00Z`).getUTCDay()];
// Leave: "<Name> applied for <type> from <date> to <date> (<days> days)".
async function leaveRaised({ leave, employee, early = null, reassignedBy = null, toUserId = null, mailer = sendMail }) {
  const e = employee || await prisma.employee.findUnique({ where: { id: leave.employeeId } });
  const from = String(leave.fromDate).slice(0, 10);
  const to = String(leave.toDate || leave.fromDate).slice(0, 10);
  const n = leave.days ?? 1;
  const when = to !== from ? `from ${dmy(from)} to ${dmy(to)}` : `on ${dmy(from)}`;
  const half = /First Half|Second Half/.exec(String(leave.reason || ''));
  const line = `${e.name} applied for ${leave.type}${half ? ` (${half[0]})` : ''} ${when} (${n} day${Number(n) === 1 ? '' : 's'}).`;
  const title = `${reassignedBy ? 'Leave request handed to you' : 'Leave request'} — ${e.name}, ${leave.type}, ${dmy(from)}${to !== from ? ` to ${dmy(to)}` : ''}`;
  return approvalRaised({ workflow: 'leave', recordId: leave.id, employee: e, title, line, openPath: `/leave?tab=requests&open=${leave.id}`, also: [early && early.text], reassignedBy, toUserId, mailer });
}
async function regularizationRaised({ reg, employee, mailer = sendMail }) {
  const e = employee || await prisma.employee.findUnique({ where: { id: reg.employeeId } });
  const date = String(reg.date).slice(0, 10);
  const line = `${e.name} asks to correct attendance for ${dmy(date)}.`;
  return approvalRaised({ workflow: 'regularization', recordId: reg.id, employee: e, title: `Attendance correction — ${e.name}, ${dmy(date)}`, line, openPath: '/attendance?tab=regularization', mailer });
}

async function taskAssigned(task, by) {
  if (!task || !task.assigneeId || (by && task.assigneeId === by.id)) return null;
  const u = await prisma.user.findUnique({ where: { id: task.assigneeId }, select: { id: true, name: true, email: true } });
  if (!u) return null;
  const from = task.assignedByName || (by && by.name) || 'Someone';
  const due = task.endDate ? ` (due ${dmy(task.endDate)})` : '';
  const pri = task.priority && task.priority !== 'Medium' ? ` Priority: ${task.priority}.` : '';
  return notify('taskAssigned', { userId: u.id, name: u.name, email: u.email }, {
    title: `New task from ${from}: ${task.name}${due}`,
    message: `${from} gave you a task: ${task.name}.${task.endDate ? ` Finish by ${dmy(task.endDate)}.` : ''}${pri} Open Timesheet to start it and add your hours.\nOpen: /employee-services?tab=timesheet`,
  });
}

// The person who GAVE a task hears when it is finished.
async function taskDone(task, by) {
  if (!task || !task.assignedById || task.assignedById === task.assigneeId || (by && task.assignedById === by.id)) return null;
  const u = await prisma.user.findUnique({ where: { id: task.assignedById }, select: { id: true, name: true, email: true } });
  if (!u) return null;
  return notify('taskDone', { userId: u.id, name: u.name, email: u.email }, {
    title: `Task finished: ${task.name} (${task.assigneeName})`,
    message: `${task.assigneeName} marked "${task.name}" as done and sent it to you to check. Open Timesheet, then Tasks I gave.\nOpen: /employee-services?tab=timesheet`,
  });
}

// The person a task was given to hears when it changes under them: a new due
// date, moved to someone else, or cancelled. `short` heads the bell entry; `what` is a plain sentence.
async function taskChanged(task, by, short, what, userId) {
  const id = userId || (task && task.assigneeId);
  if (!task || !id || (by && id === by.id)) return null;
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true } });
  if (!u) return null;
  const who = (by && by.name) || task.assignedByName || 'Your lead';
  return notify('taskChanged', { userId: u.id, name: u.name, email: u.email }, {
    title: `${short}: ${task.name}`,
    message: `${who}: ${what}\nOpen: /employee-services?tab=timesheet`,
  });
}

// Attendance events come from utils/attendanceAlerts.js (one per person per day).
const ATTENDANCE_EVENT = { late: 'lateLogin', missingOut: 'missingCheckOut', missingIn: 'missingCheckIn', earlyOut: 'earlyLogout' };

// ---- daily reminders: tasks and targets -----------------------------------------
const DONE_TASK = ['Completed', 'Cancelled', 'Closed'];
function addDays(iso, n) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function reminders({ now = new Date(), testMode = false, scope = null, settings = null, mailer = sendMail } = {}) {
  const s = settings || await getSettings();
  const today = localDate(now);
  const out = { taskDue: 0, taskLate: 0, goalNotMet: 0 };
  const userOk = (u) => u && u.status !== 'Inactive' && (testMode ? scope && scope.userIds.includes(u.id) : !isTest(u.name, u.email));

  // Tasks due today .. today + taskDueDays, not done: one entry per task.
  const open = await prisma.task.findMany({ where: { status: { notIn: DONE_TASK }, endDate: { not: null } } });
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(open.map((t) => t.assigneeId))] } }, select: { id: true, name: true, email: true, status: true } })).map((u) => [u.id, u]));
  const until = addDays(today, s.taskDueDays);
  for (const t of open.filter((x) => x.endDate >= today && x.endDate <= until)) {
    const u = users.get(t.assigneeId);
    if (!userOk(u)) continue;
    const when = t.endDate === today ? 'today' : `on ${dmy(t.endDate)}`;
    // eslint-disable-next-line no-await-in-loop
    const r = await notify('taskDue', { userId: u.id, name: u.name, email: u.email }, { title: `Task due ${t.endDate === today ? 'today' : 'soon'}: ${t.name}`, message: `Your task "${t.name}" is due ${when}. Status: ${t.status}.` }, { now, settings: s, mailer });
    if (r.inApp || r.email) out.taskDue += 1;
  }
  // OVERDUE tasks (2026-10-09): one reminder PER TASK, once a day at most, in
  // the bell and in the person's daily email (utils/taskOverdue.js). It used to
  // be one grouped line per person; the user asked for the task itself.
  // A recruiter's overdue tasks are told in the pending-work reminders ("You missed N things") when those and "Also remind the person
  // themselves" are on; then the per-task bell is not sent twice. Off (the default) = exactly as before.
  let skipAssignee = null;
  try {
    const pw = await require('./pendingWork').getSettings(); // eslint-disable-line global-require
    if (pw.enabled && pw.chain.enabled && pw.chain.tasks && pw.self.enabled) {
      const recs = new Set((await prisma.user.findMany({ where: { atsRole: 'RECRUITER', status: 'Active', id: { in: [...users.keys()] } }, select: { id: true } })).map((x) => x.id));
      skipAssignee = (u) => !!u && recs.has(u.id);
    }
  } catch { skipAssignee = null; }
  const od = await require('./taskOverdue').remind({ open, users, today, notify, settings: s, mailer, now, userOk, testMode, skipAssignee });
  out.taskLate += od.reminded;
  // Targets of a FINISHED month that were not reached: grouped per person,
  // and only in the first 7 days of the next month.
  if (Number(today.slice(8, 10)) <= 7) {
    const prev = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    const targets = await prisma.employeeRecord.findMany({ where: { type: 'TARGET', date: prev }, include: { employee: { select: { id: true, name: true, email: true, userId: true, employmentStatus: true } } } });
    const missed = targets.filter((t) => Number(t.amount) > 0 && Number(t.achieved || 0) < Number(t.amount) && !['Relieved', 'Exited'].includes(t.employee.employmentStatus));
    const byEmp = new Map();
    missed.forEach((t) => { if (!byEmp.has(t.employeeId)) byEmp.set(t.employeeId, []); byEmp.get(t.employeeId).push(t); });
    for (const list of byEmp.values()) {
      // eslint-disable-next-line no-await-in-loop
      const who = await whoOfEmployee(list[0].employee);
      // eslint-disable-next-line no-await-in-loop
      const u = who && who.userId ? await prisma.user.findUnique({ where: { id: who.userId }, select: { id: true, name: true, email: true, status: true } }) : null;
      if (!userOk(u)) continue;
      const lines = list.map((t) => `• ${t.title}: ${t.achieved || 0} of ${t.amount}${t.unit ? ` ${t.unit}` : ''}`).join('\n');
      const title = `Target${list.length === 1 ? '' : 's'} not reached — ${prev}`;
      // Once per month, not every day of the first week.
      // eslint-disable-next-line no-await-in-loop
      const already = await prisma.notification.findFirst({ where: { title, OR: [{ userId: u.id }, { recipient: who.email || '-' }], createdAt: { gte: new Date(`${today.slice(0, 7)}-01T00:00:00`) } }, select: { id: true } });
      if (already) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await notify('goalNotMet', who, { title, message: `Last month's target${list.length === 1 ? ' was' : 's were'} not reached:\n${lines}` }, { now, settings: s, mailer });
      if (r.inApp || r.email) out.goalNotMet += 1;
    }
  }
  return out;
}

// ---- the daily email -------------------------------------------------------------
// Every WAITING email row from the last 2 days, one email per address.
async function sendDigests({ now = new Date(), mailer = sendMail, testMode = false, scope = null, settings = null } = {}) {
  const s = settings || await getSettings();
  // Emails off: the rows keep waiting (only the last 2 days are ever sent).
  if (!s.emailsOn && !testMode) return { emails: 0, items: 0, notSent: 0, off: true };
  let since = new Date(startOfDay(now).getTime() - 86400000);
  // Nothing recorded before emails were switched ON is mailed by itself (the "Send the waiting ones now" button is for that).
  if (!testMode && s.emailsOnAt && new Date(s.emailsOnAt) > since) since = new Date(s.emailsOnAt);
  const rows = await prisma.notification.findMany({ where: { channel: 'Email', status: WAITING, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } });
  const byAddr = new Map();
  rows.forEach((r) => {
    if (!r.recipient) return;
    if (testMode ? !(scope && scope.userIds.includes(r.userId)) : isTest(r.recipient)) return;
    const k = r.recipient.toLowerCase();
    if (!byAddr.has(k)) byAddr.set(k, []);
    byAddr.get(k).push(r);
  });
  const out = { emails: 0, items: 0, notSent: 0 };
  for (const [to, list] of byAddr) {
    const text = [`Your TeamLink summary for ${dmy(localDate(now))} (${list.length}):`, '',
      ...list.map((r) => `• ${r.title}${r.message ? `\n  ${String(r.message).replace(/\n/g, '\n  ')}` : ''}`), '',
      'Open TeamLink to see the details. You get one email like this a day.'].join('\n');
    // eslint-disable-next-line no-await-in-loop
    const res = await mailer({ to, subject: `TeamLink — your daily summary (${list.length})`, text, useEmployeeFrom: false });
    const status = res.ok ? `Sent in the daily email ${localTime(now)}` : res.notConfigured ? 'Not sent — email is not set up' : `Not sent — ${String(res.error || '').slice(0, 150)}`;
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.updateMany({ where: { id: { in: list.map((r) => r.id) } }, data: { status } });
    if (res.ok) { out.emails += 1; out.items += list.length; } else out.notSent += 1;
  }
  return out;
}

// ---- retries, waiting ones, resend ----------------------------------------------------------------------------
const retriesDoneOf = (st) => { const m = /will retry, (\d) left/.exec(String(st || '')); return m ? MAX_RETRIES - Number(m[1]) : null; };
const testFilter = (r, testMode, scope) => (testMode ? !!scope && (scope.userIds.includes(r.userId) || /zz-am-/i.test(r.recipient || '')) : !isTest(r.recipient));
async function sendRow(row, { mailer, retriesDone = 0, manual = false }) {
  const r = await mailer({ to: row.recipient, subject: `TeamLink — ${row.title}`, text: row.message || row.title, useEmployeeFrom: false });
  const status = statusOfResult(r, retriesDone, manual);
  await prisma.notification.update({ where: { id: row.id }, data: { status } });
  return status;
}
// Failed emails that said "will retry": try again when their backoff time has come.
async function retryFailed({ now = new Date(), mailer = sendMail, testMode = false, scope = null, settings = null } = {}) {
  const s = settings || await getSettings();
  const out = { tried: 0, sent: 0, failed: 0 };
  if (!s.emailsOn) return out;
  const rows = await prisma.notification.findMany({ where: { channel: 'Email', status: { startsWith: 'Failed:' }, createdAt: { gte: new Date(startOfDay(now).getTime() - 86400000) } }, orderBy: { createdAt: 'asc' }, take: 200 });
  for (const row of rows) {
    const done = retriesDoneOf(row.status);
    if (done === null || !row.recipient || !testFilter(row, testMode, scope)) continue; // eslint-disable-line no-continue
    if (now.getTime() < row.createdAt.getTime() + RETRY_AFTER_MIN[done] * 60000) continue; // eslint-disable-line no-continue
    out.tried += 1;
    // eslint-disable-next-line no-await-in-loop
    const st = await sendRow(row, { mailer, retriesDone: done + 1 });
    if (st === 'Sent') out.sent += 1; else out.failed += 1;
  }
  return out;
}
// The alerts that never went out (emails were off, or mail was not set up), from yesterday and today only.
async function waitingOnes({ now = new Date(), testMode = false, scope = null, settings = null } = {}) {
  const s = settings || await getSettings();
  const since = new Date(startOfDay(now).getTime() - 86400000);
  const rows = await prisma.notification.findMany({
    where: { channel: 'Email', createdAt: { gte: since }, status: { in: [EMAILS_OFF, LEGACY_OFF, NOT_SET_UP, LEGACY_NOT_SET_UP, WAITING] } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.filter((r) => r.recipient && testFilter(r, testMode, scope)
    && (r.status !== WAITING || !s.emailsOn || (s.emailsOnAt && r.createdAt < new Date(s.emailsOnAt))));
}
const SEND_WAITING_CAP = 100;
async function sendWaiting({ now = new Date(), mailer = sendMail, testMode = false, scope = null, cap = SEND_WAITING_CAP, by = null } = {}) {
  const s = await getSettings();
  if (!s.emailsOn) return { error: 'Notification emails are OFF. Switch them on first.' };
  const all = await waitingOnes({ now, testMode, scope, settings: s });
  const batch = all.slice(0, cap);
  const out = { sent: 0, failed: 0, left: all.length - batch.length, total: all.length };
  for (const row of batch) {
    // eslint-disable-next-line no-await-in-loop
    const st = await sendRow(row, { mailer, manual: true });
    if (st === 'Sent') out.sent += 1; else out.failed += 1;
  }
  await logAudit({ userId: by, action: 'Waiting notification emails sent', entity: 'Integration', entityId: STORE_ID, toValue: `${out.sent} sent, ${out.failed} not sent, ${out.left} still waiting` });
  return out;
}
async function resend(id, { mailer = sendMail, by = null } = {}) {
  const s = await getSettings();
  const row = await prisma.notification.findUnique({ where: { id } });
  if (!row || row.channel !== 'Email' || !row.recipient) return { error: 'That email was not found.', code: 404 };
  if (!/^(Failed|Not sent)/.test(String(row.status || '')) || row.status === NO_ADDRESS) return { error: 'This email does not need a resend.', code: 400 };
  if (!s.emailsOn) return { error: 'Notification emails are OFF. Switch them on first.', code: 400 };
  const status = await sendRow(row, { mailer, manual: true });
  await logAudit({ userId: by, action: 'Notification email resent', entity: 'Notification', entityId: id, toValue: status });
  return { status };
}

// One pass, called by the attendance-alerts sweep (every few minutes on the
// real server; never in the sandbox, where tests call it themselves).
let lastReminderDay = null;
let lastDayEndDay = null;
async function sendDayEnd({ now = new Date(), settings = null, mailer = sendMail } = {}) {
  const day = localDate(now);
  const r = await require('../routes/tasks').dayEndReport({ day }); // eslint-disable-line global-require
  if (!r.total) return { sent: 0, total: 0 };
  const c = r.counts;
  const head = `Completed ${c.completed} · Waiting for TL approval ${c.waiting} · Partly done ${c.partial} · In progress ${c.inprogress + c.onhold} · Not started ${c.notstarted}${c.sentback ? ` · Sent back ${c.sentback}` : ''}${r.late ? ` · Late ${r.late}` : ''}`;
  const lines = r.people.slice(0, 40).map((p) => `${p.name}${p.tl ? ` (TL ${p.tl})` : ''}: ${p.tasks.map((t) => `${t.name} - ${t.label}${t.late ? ' (late)' : ''}`).join('; ')}`);
  const admins = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: 'SUPER_ADMIN' }, { hrmsRole: 'SUPER_ADMIN' }] }, select: { id: true, name: true, email: true } });
  let sent = 0;
  for (const u of admins) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const o = await notify('taskDayEnd', { userId: u.id, name: u.name, email: u.email }, { title: `Tasks today (${day}): ${head}`.slice(0, 190), message: `${lines.join('\n')}${r.people.length > 40 ? `\n... and ${r.people.length - 40} more people` : ''}\nOpen: /employee-services?tab=timesheet (End of day)` }, { now, settings, mailer });
    if (o.inApp || o.email) sent += 1;
  }
  return { sent, total: r.total };
}
async function run({ now = new Date(), mailer = sendMail, testMode = false, scope = null, force = false } = {}) {
  const s = await getSettings();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out = { reminders: null, digests: null };
  const day = localDate(now);
  if (force || (nowMin >= minutesOf(s.reminderTime) && lastReminderDay !== day)) {
    out.reminders = await reminders({ now, testMode, scope, settings: s, mailer });
    if (!testMode) lastReminderDay = day;
  }
  if (force || nowMin >= minutesOf(s.digestTime)) out.digests = await sendDigests({ now, mailer, testMode, scope, settings: s });
  // END OF DAY (founder 2026-10-27): at the daily-email time, every Super Admin gets the day's task states (once a day - notify() keeps it to one)
  if (force || (nowMin >= minutesOf(s.digestTime) && lastDayEndDay !== day)) {
    out.dayEnd = await sendDayEnd({ now, settings: s, mailer }).catch((e) => ({ error: String(e.message).slice(0, 200) }));
    if (!testMode) lastDayEndDay = day;
  }
  out.retries = await retryFailed({ now, mailer, testMode, scope, settings: s });
  return out;
}

// GET / PUT /api/attendance/notify-settings (Attendance & Time configure).
function registerRoutes(router, { requirePerm }) {
  const configure = requirePerm(null, 'hrms', 'Attendance & Time', 'configure');
  // The HR desk (and Admin) sees the emails that did not go out and can Resend one; changing settings stays Admin-only.
  const deskPerm = requirePerm(null, 'hrms', 'Attendance & Time', 'edit');
  const desk = [deskPerm, (req, res, next) => (['HR', 'ADMIN', 'SUPER_ADMIN'].includes(req.user.hrmsRole) || ['ADMIN', 'SUPER_ADMIN'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Only the HR desk or an Admin can do this.' }))];
  router.get('/notify-settings', configure, async (req, res) => {
    const s = await getSettings();
    const waiting = await prisma.notification.count({ where: { channel: 'Email', status: WAITING } });
    const cfg = await require('./mailer').emailConfig().catch(() => ({ configured: false, reason: 'Mail could not be checked.' })); // eslint-disable-line global-require
    const eventsList = EVENT_KEYS.map((k) => ({ key: k, label: EVENTS[k].label, instant: !!EVENTS[k].instant, attendance: ATTENDANCE_MAIL_EVENTS.includes(k), mode: modeOf(s, k) }));
    res.json({ settings: s, events: eventsList, waiting, mail: { configured: !!cfg.configured, reason: cfg.configured ? '' : (cfg.reason || 'Mail is not set up.') }, waitingOnes: (await waitingOnes({ settings: s })).length });
  });
  // The people whose email did not go out: failed ones (with Resend) and the waiting ones (with the one button).
  router.get('/notify-queue', desk, async (req, res) => {
    const s = await getSettings();
    const since = new Date(startOfDay(new Date()).getTime() - 3 * 86400000);
    const failed = await prisma.notification.findMany({ where: { channel: 'Email', createdAt: { gte: since }, OR: [{ status: { startsWith: 'Failed' } }, { status: NOT_SET_UP }] }, orderBy: { createdAt: 'desc' }, take: 50 });
    const waiting = await waitingOnes({ settings: s });
    const pick = (r) => ({ id: r.id, recipient: r.recipient, title: r.title, status: displayStatus(r, s), createdAt: r.createdAt });
    res.json({ emailsOn: s.emailsOn, cap: SEND_WAITING_CAP, failed: failed.filter((r) => r.recipient && !isTest(r.recipient)).map(pick), waitingCount: waiting.length, waitingSample: waiting.slice(0, 20).map(pick) });
  });
  router.post('/notify-send-waiting', configure, async (req, res) => {
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'Please confirm first.' });
    const r = await sendWaiting({ by: req.user.id });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r);
  });
  router.post('/notify-resend/:id', desk, async (req, res) => {
    const r = await resend(req.params.id, { by: req.user.id });
    if (r.error) return res.status(r.code || 400).json({ error: r.error });
    res.json(r);
  });
  // "Send a test email to me": proves the mail setup end to end (to the signed-in person's own address).
  router.post('/notify-test-mail', configure, async (req, res) => {
    const to = req.user.email;
    if (!to) return res.status(400).json({ error: 'Your login has no email address.' });
    const r = await sendMail({ to, subject: 'TeamLink — test email', text: 'This is a test email from TeamLink (Attendance → Check-in Methods → Who gets told, and how). If you can read it, alert emails will reach people.', useEmployeeFrom: false });
    if (r.ok) return res.json({ ok: true, message: `A test email was sent to ${to}.` });
    res.status(r.notConfigured ? 409 : 502).json({ ok: false, notConfigured: !!r.notConfigured, error: r.notConfigured ? `Mail is not set up: ${r.error}` : `The test email failed: ${r.error}` });
  });
  router.put('/notify-settings', configure, async (req, res) => {
    const r = await saveSettings(req.body || {}, req.user.id);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ settings: r.settings, events: EVENT_KEYS.map((k) => ({ key: k, label: EVENTS[k].label, instant: !!EVENTS[k].instant, attendance: ATTENDANCE_MAIL_EVENTS.includes(k), mode: modeOf(r.settings, k) })) });
  });
}

module.exports = {
  STORE_ID, EVENTS, EVENT_KEYS, WAITING, ATTENDANCE_EVENT,
  MODES, ATTENDANCE_MAIL_EVENTS, EMAILS_OFF, NOT_SET_UP, NO_ADDRESS, modeOf, displayStatus, retryFailed, waitingOnes, sendWaiting, resend,
  getSettings, saveSettings, notify, approvalRaised, leaveRaised, regularizationRaised, dayName, KIND_WORDS, leaveDecided, latePermissionRaised, latePermissionDecided, taskAssigned, taskDone, taskChanged, reminders, sendDigests, run, registerRoutes, whoOfEmployee, sendDayEnd,
};
