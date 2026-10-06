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
  lateLogin: { label: 'Late login' },
  earlyLogout: { label: 'Early logout' },
  missingCheckIn: { label: 'Missing check-in' },
  missingCheckOut: { label: 'Missing check-out' },
  taskAssigned: { label: 'Task given to you' },
  taskDue: { label: 'Task due soon' },
  taskLate: { label: 'Tasks not finished on time' },
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
};
const EMAILS_OFF = 'Not sent — emails are off (Admin turns them on)';
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
    events[k] = { inApp: v.inApp !== undefined ? !!v.inApp : DEFAULTS.events[k].inApp, email: v.email !== undefined ? !!v.email : DEFAULTS.events[k].email };
  });
  return {
    events,
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
      next.events[k] = { inApp: v.inApp !== undefined ? !!v.inApp : cur.events[k].inApp, email: v.email !== undefined ? !!v.email : cur.events[k].email };
    });
  }
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
  if (patch.emailsOn !== undefined) next.emailsOn = !!patch.emailsOn;
  if (errs.length) return { error: errs.join('. ') };
  await prisma.integration.upsert({
    where: { id: STORE_ID },
    update: { values: JSON.stringify(next) },
    create: { id: STORE_ID, enabled: true, state: 'Internal', values: JSON.stringify(next) },
  });
  await logAudit({
    userId, action: 'HRMS notification settings updated', entity: 'Integration', entityId: STORE_ID,
    toValue: `emails ${next.emailsOn ? 'ON' : 'off'} · ${EVENT_KEYS.map((k) => `${EVENTS[k].label}: ${next.events[k].inApp ? 'app' : '-'}/${next.events[k].email ? 'email' : '-'}`).join(' · ')}`,
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

// One event for one person. Returns what happened, for tests and logs.
//   who: { userId, name, email }
async function notify(event, who, { title, message }, { now = new Date(), mailer = sendMail, settings = null } = {}) {
  const s = settings || await getSettings();
  const sw = s.events[event] || { inApp: false, email: false };
  const out = { inApp: false, email: null };
  if (!who || (!who.userId && !who.email)) return out;
  if (sw.inApp && who.userId && !await seenToday({ userId: who.userId, title, channel: 'In-App', now })) {
    await prisma.notification.create({ data: { userId: who.userId, title, message: message || null, channel: 'In-App', recipient: who.name || null, status: 'Delivered' } });
    out.inApp = true;
  }
  if (sw.email && who.email && !await seenToday({ userId: who.userId, recipient: who.email, title, channel: 'Email', now })) {
    if (EVENTS[event] && EVENTS[event].instant && !s.emailsOn) {
      await prisma.notification.create({ data: { userId: who.userId || null, title, message: message || null, channel: 'Email', recipient: who.email, status: EMAILS_OFF, read: true } });
      out.email = EMAILS_OFF;
    } else if (EVENTS[event] && EVENTS[event].instant) {
      const r = await mailer({ to: who.email, subject: `TeamLink — ${title}`, text: message || title, useEmployeeFrom: false });
      const status = r.ok ? 'Sent' : r.notConfigured ? 'Not sent — email is not set up' : `Not sent — ${String(r.error || '').slice(0, 150)}`;
      await prisma.notification.create({ data: { userId: who.userId || null, title, message: message || null, channel: 'Email', recipient: who.email, status, read: true } });
      out.email = status;
    } else {
      await prisma.notification.create({ data: { userId: who.userId || null, title, message: message || null, channel: 'Email', recipient: who.email, status: WAITING, read: true } });
      out.email = WAITING;
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

async function taskAssigned(task, by) {
  if (!task || !task.assigneeId || (by && task.assigneeId === by.id)) return null;
  const u = await prisma.user.findUnique({ where: { id: task.assigneeId }, select: { id: true, name: true, email: true } });
  if (!u) return null;
  const due = task.endDate ? ` Finish by ${dmy(task.endDate)}.` : '';
  return notify('taskAssigned', { userId: u.id, name: u.name, email: u.email }, {
    title: `New task: ${task.name}`,
    message: `${task.assignedByName || (by && by.name) || 'Someone'} gave you a task: ${task.name}.${due} Open My tasks to start it.`,
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
  // Late tasks: GROUPED, one entry per person per day.
  const late = new Map();
  open.filter((x) => x.endDate < today).forEach((t) => { if (!late.has(t.assigneeId)) late.set(t.assigneeId, []); late.get(t.assigneeId).push(t); });
  for (const [uid, list] of late) {
    const u = users.get(uid);
    if (!userOk(u)) continue;
    const lines = list.slice(0, 10).map((t) => `• ${t.name} (was due ${dmy(t.endDate)})`).join('\n');
    // eslint-disable-next-line no-await-in-loop
    const r = await notify('taskLate', { userId: u.id, name: u.name, email: u.email }, {
      title: `${list.length} task${list.length === 1 ? ' is' : 's are'} late — ${dmy(today)}`,
      message: `These tasks are past their end date and not finished:\n${lines}${list.length > 10 ? `\n…and ${list.length - 10} more` : ''}`,
    }, { now, settings: s, mailer });
    if (r.inApp || r.email) out.taskLate += 1;
  }
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
  const since = new Date(startOfDay(now).getTime() - 86400000);
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

// One pass, called by the attendance-alerts sweep (every few minutes on the
// real server; never in the sandbox, where tests call it themselves).
let lastReminderDay = null;
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
  return out;
}

// GET / PUT /api/attendance/notify-settings (Attendance & Time configure).
function registerRoutes(router, { requirePerm }) {
  const configure = requirePerm(null, 'hrms', 'Attendance & Time', 'configure');
  router.get('/notify-settings', configure, async (req, res) => {
    const s = await getSettings();
    const waiting = await prisma.notification.count({ where: { channel: 'Email', status: WAITING } });
    res.json({ settings: s, events: EVENT_KEYS.map((k) => ({ key: k, label: EVENTS[k].label, instant: !!EVENTS[k].instant })), waiting });
  });
  router.put('/notify-settings', configure, async (req, res) => {
    const r = await saveSettings(req.body || {}, req.user.id);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ settings: r.settings, events: EVENT_KEYS.map((k) => ({ key: k, label: EVENTS[k].label, instant: !!EVENTS[k].instant })) });
  });
}

module.exports = {
  STORE_ID, EVENTS, EVENT_KEYS, WAITING, ATTENDANCE_EVENT,
  getSettings, saveSettings, notify, leaveDecided, taskAssigned, reminders, sendDigests, run, registerRoutes, whoOfEmployee,
};
