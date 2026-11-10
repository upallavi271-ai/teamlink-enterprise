// ---------------------------------------------------------------------------
// EMPLOYEE MONITORING - WHAT IT GIVES THE REST OF TEAMLINK (2026-11-05, module 12 and the daily flow of the founder's plan).
//
//   Attendance   a working day with PC activity but no attendance of any kind comes up as a SUGGESTION. HR approves it (Present or
//                Half Day) or dismisses it. It only ever fills an empty day: a mark, a punch or a leave is never changed.
//   Payroll      a reference for the month: working days, days on the PC, leave, days with neither. It deducts nothing;
//                HR decides. (A PC that was off is not proof of absence.)
//   ATS, Omni    the work a person did beside the PC time: profiles moved, profiles sent to the client, calls, messages.
//   The mail     a daily or weekly summary to the addresses HR typed, after work (off until HR switches it on).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const M = require('./monitoring');
const { logAudit } = require('./audit');

const IST = 330 * 60000;
const hmOf = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(11, 16);
const hrs = (sec) => Math.round((sec / 3600) * 100) / 100;
const DISMISS = 'monitoring.attdismiss.';
const SHARED = ['SHARED_WITH_CLIENT'];
const NOT_SENT = ['FAILED', 'NOT_SENT_BLOCKED'];
const eachDay = (a, b) => { const out = []; for (let d = a, n = 0; d <= b && n < 400; d = M.addDays(d, 1), n += 1) out.push(d); return out; };

// --- ATS and Omnichannel: the work beside the PC time ------------------------------------------------------------------------
async function workCounts(employeeIds, from, to) {
  const out = new Map(employeeIds.map((id) => [id, { moved: 0, submitted: 0, calls: 0, messages: 0 }]));
  if (!employeeIds.length) return out;
  const emps = await prisma.employee.findMany({ where: { id: { in: employeeIds }, userId: { not: null } }, select: { id: true, userId: true } });
  const byUser = new Map(emps.map((e) => [e.userId, e.id]));
  const users = [...byUser.keys()];
  if (!users.length) return out;
  const when = { gte: new Date(`${from}T00:00:00+05:30`), lte: new Date(`${to}T23:59:59+05:30`) };
  const [moves, msgs] = await Promise.all([
    prisma.applicationStageEvent.groupBy({ by: ['actorUserId', 'toStage'], where: { actorUserId: { in: users }, createdAt: when }, _count: { _all: true } }).catch(() => []),
    prisma.conversationMessage.groupBy({ by: ['senderUserId', 'channel'], where: { senderUserId: { in: users }, direction: 'OUT', createdAt: when, OR: [{ status: null }, { status: { notIn: NOT_SENT } }] }, _count: { _all: true } }).catch(() => []),
  ]);
  moves.forEach((r) => {
    const c = out.get(byUser.get(r.actorUserId));
    if (!c) return;
    c.moved += r._count._all;
    if (SHARED.includes(r.toStage)) c.submitted += r._count._all;
  });
  msgs.forEach((r) => {
    const c = out.get(byUser.get(r.senderUserId));
    if (!c) return;
    if (r.channel === 'Call') c.calls += r._count._all; else c.messages += r._count._all;
  });
  return out;
}

// --- Payroll: a reference, never a deduction ----------------------------------------------------------------------------------
async function payrollRows(from, to, department, access = null) {
  const today = M.todayIst();
  const a = from; const b = to > today ? today : to;
  const WD = require('./workingDays'); // eslint-disable-line global-require
  await WD.ready().catch(() => {});
  const within = access && access.ids ? { employeeId: { in: access.ids } } : {};
  const [cfg, idx, devices, logs, leaves, catOf] = await Promise.all([
    M.settings(), M.overrideIndex(),
    prisma.monitoringDevice.findMany({ where: { ...within }, select: { employeeId: true }, distinct: ['employeeId'] }),
    prisma.activityLog.findMany({ where: { day: { gte: a, lte: b }, ...within }, select: { employeeId: true, appName: true, windowTitle: true, startTime: true, endTime: true, durationSeconds: true, isIdle: true, isBreak: true, day: true } }),
    prisma.leaveRequest.findMany({ where: { status: 'Approved', fromDate: { lte: b }, toDate: { gte: a }, ...within }, select: { employeeId: true, fromDate: true, toDate: true } }),
    M.categoryIndex(),
  ]);
  const ids = [...new Set([...devices.map((d) => d.employeeId), ...logs.map((l) => l.employeeId)])];
  const emps = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employeeCode: true, department: true } });
  const days = eachDay(a, b).filter(WD.isWorking);
  const rows = emps.filter((e) => (!department || e.department === department) && !M.effective(cfg, idx, e).excluded).map((e) => {
    const mine = logs.filter((l) => l.employeeId === e.id);
    const pc = new Set(mine.map((l) => l.day));
    const off = new Set(); leaves.filter((l) => l.employeeId === e.id).forEach((l) => days.forEach((d) => { if (d >= l.fromDate && d <= l.toDate) off.add(d); }));
    const t = M.totalsOf(mine, catOf, e.department || '');
    return {
      key: e.id, employeeId: e.id, name: e.name, code: e.employeeCode || null, department: e.department || null, workingDays: days.length,
      pcDays: days.filter((d) => pc.has(d)).length, leaveDays: off.size, noPcDays: days.filter((d) => !pc.has(d) && !off.has(d)).length,
      activeHours: t.activeHours, idleHours: t.idleHours, productiveHours: hrs(t.productiveSeconds), productivity: t.productivity,
    };
  }).sort((p, q) => String(p.name).localeCompare(String(q.name)));
  return { from: a, to: b, view: 'payroll', rows, departments: [...new Set(emps.map((e) => e.department).filter(Boolean))].sort() };
}

// --- Attendance from the PC: present / half day / absent by the active hours ---------------------------------------------------
// founder 2026-11-10: "emp yokka active hours count cheskoni, present / absent raavali, including percentage". Out of the day's work
// time (9 am - 6 pm less the lunch and the 15-minute personal break: 8 h), the ACTIVE time decides. A reference beside HR's own
// attendance: nothing is written; the suggestions below are still how a day is filled.
const PRESENT_PCT = 75; // 6 h of 8
const HALF_PCT = 50; // 4 h of 8
const pcMark = (pct) => (pct >= PRESENT_PCT ? 'Present' : pct >= HALF_PCT ? 'Half day' : 'Absent');
async function pcAttendance(from, to, access = null) {
  const today = M.todayIst();
  const b = M.validDay(to) && to < today ? to : today;
  let a = M.validDay(from) ? from : `${b.slice(0, 8)}01`;
  if (a > b) a = b;
  if (M.addDays(a, 62) < b) a = M.addDays(b, -62);
  const WD = require('./workingDays'); // eslint-disable-line global-require
  await WD.ready().catch(() => {});
  const within = access && access.ids ? { employeeId: { in: access.ids } } : {};
  const [cfg, idx, devices, logs, leaves] = await Promise.all([
    M.settings(), M.overrideIndex(),
    prisma.monitoringDevice.findMany({ where: { isActive: true, ...within }, select: { employeeId: true, registeredAt: true } }),
    prisma.activityLog.groupBy({ by: ['employeeId', 'day'], where: { day: { gte: a, lte: b }, isIdle: false, isBreak: false, ...within }, _sum: { durationSeconds: true }, _min: { startTime: true }, _max: { endTime: true } }),
    prisma.leaveRequest.findMany({ where: { status: 'Approved', fromDate: { lte: b }, toDate: { gte: a }, ...within }, select: { employeeId: true, fromDate: true, toDate: true } }),
  ]);
  const since = new Map();
  devices.forEach((d) => { const day = M.istDay ? M.istDay(d.registeredAt) : new Date(new Date(d.registeredAt).getTime() + IST).toISOString().slice(0, 10); if (!since.has(d.employeeId) || day < since.get(d.employeeId)) since.set(d.employeeId, day); });
  logs.forEach((l) => { if (!since.has(l.employeeId) || l.day < since.get(l.employeeId)) since.set(l.employeeId, l.day); });
  const ids = [...since.keys()];
  const emps = await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employeeCode: true, department: true, team: true, employmentStatus: true } });
  const act = new Map(logs.map((l) => [`${l.employeeId}|${l.day}`, l]));
  const days = eachDay(a, b).filter(WD.isWorking);
  const dayRows = []; const people = [];
  emps.filter((e) => !M.effective(cfg, idx, e).excluded).forEach((e) => {
    const mine = M.effective(cfg, idx, e);
    const sum = { present: 0, half: 0, absent: 0, leave: 0, activeSeconds: 0, workSeconds: 0, days: 0 };
    days.filter((d) => d >= since.get(e.id)).forEach((d) => {
      const l = act.get(`${e.id}|${d}`);
      const onLeave = leaves.some((v) => v.employeeId === e.id && d >= v.fromDate && d <= v.toDate);
      const wd = M.workDayOf(d, mine);
      const active = l ? l._sum.durationSeconds || 0 : 0;
      const pct = wd.workSeconds ? Math.min(100, Math.round((active / wd.workSeconds) * 100)) : 0;
      const running = d === today;
      let mark = onLeave ? 'On leave' : pcMark(pct);
      if (running && !onLeave) mark = 'Day not over'; // today is judged once it is over
      if (!running) {
        sum.days += 1; sum.workSeconds += onLeave ? 0 : wd.workSeconds; sum.activeSeconds += onLeave ? 0 : active;
        if (onLeave) sum.leave += 1; else if (mark === 'Present') sum.present += 1; else if (mark === 'Half day') sum.half += 1; else sum.absent += 1;
      }
      dayRows.push({
        key: `${e.id}|${d}`, employeeId: e.id, day: d, name: e.name, code: e.employeeCode || null, department: e.department || null,
        first: l ? hmOf(l._min.startTime) : null, last: l ? hmOf(l._max.endTime) : null, activeHours: hrs(active), workHours: hrs(wd.workSeconds), pct, mark, running,
      });
    });
    people.push({
      key: e.id, employeeId: e.id, name: e.name, code: e.employeeCode || null, department: e.department || null, team: e.team || null,
      days: sum.days, present: sum.present, halfDays: sum.half, absent: sum.absent, leave: sum.leave,
      activeHours: hrs(sum.activeSeconds), workHours: hrs(sum.workSeconds), pct: sum.workSeconds ? Math.round((sum.activeSeconds / sum.workSeconds) * 100) : null,
      attendancePct: sum.days - sum.leave > 0 ? Math.round(((sum.present + sum.half / 2) / (sum.days - sum.leave)) * 100) : null,
    });
  });
  people.sort((p, q) => (q.pct || 0) - (p.pct || 0) || String(p.name).localeCompare(String(q.name)));
  dayRows.sort((p, q) => q.day.localeCompare(p.day) || q.pct - p.pct || String(p.name).localeCompare(String(q.name)));
  return { from: a, to: b, presentPct: PRESENT_PCT, halfPct: HALF_PCT, people, days: dayRows };
}

// --- Attendance: suggestions HR approves ----------------------------------------------------------------------------------------
async function suggestions(from, to, access = null) {
  const yesterday = M.addDays(M.todayIst(), -1); // a day still running is not suggested
  const b = M.validDay(to) && to < yesterday ? to : yesterday;
  let a = M.validDay(from) ? from : M.addDays(b, -13);
  if (M.addDays(a, 62) < b) a = M.addDays(b, -62);
  const WD = require('./workingDays'); // eslint-disable-line global-require
  await WD.ready().catch(() => {});
  const within = access && access.ids ? { employeeId: { in: access.ids } } : {};
  const logs = await prisma.activityLog.groupBy({ by: ['employeeId', 'day'], where: { day: { gte: a, lte: b }, isBreak: false, ...within }, _min: { startTime: true }, _max: { endTime: true }, _sum: { durationSeconds: true } });
  if (!logs.length) return { from: a, to: b, rows: [] };
  const ids = [...new Set(logs.map((l) => l.employeeId))];
  const [marks, punches, leaves, gone, emps] = await Promise.all([
    prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: { gte: a, lte: b } }, select: { employeeId: true, date: true } }),
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: { gte: a, lte: b } }, select: { employeeId: true, date: true } }),
    prisma.leaveRequest.findMany({ where: { employeeId: { in: ids }, status: 'Approved', fromDate: { lte: b }, toDate: { gte: a } }, select: { employeeId: true, fromDate: true, toDate: true } }),
    prisma.appSetting.findMany({ where: { key: { startsWith: DISMISS } }, select: { key: true } }),
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, employeeCode: true, department: true } }),
  ]);
  const taken = new Set([...marks.map((m) => `${m.employeeId}|${m.date}`), ...punches.map((p) => `${p.employeeId}|${p.date}`), ...gone.map((g) => g.key.slice(DISMISS.length))]);
  const byId = new Map(emps.map((e) => [e.id, e]));
  const rows = logs.filter((l) => WD.isWorking(l.day) && !taken.has(`${l.employeeId}|${l.day}`) && !leaves.some((v) => v.employeeId === l.employeeId && l.day >= v.fromDate && l.day <= v.toDate))
    .map((l) => {
      const e = byId.get(l.employeeId) || {};
      const span = (new Date(l._max.endTime).getTime() - new Date(l._min.startTime).getTime()) / 3600000;
      return {
        key: `${l.employeeId}|${l.day}`, employeeId: l.employeeId, day: l.day, name: e.name || 'Employee', code: e.employeeCode || null, department: e.department || null,
        checkIn: hmOf(l._min.startTime), checkOut: hmOf(l._max.endTime), hours: Math.round(span * 100) / 100, activeHours: hrs(l._sum.durationSeconds || 0), suggested: span >= 6 ? 'Present' : 'Half Day',
      };
    }).sort((p, q) => q.day.localeCompare(p.day) || String(p.name).localeCompare(String(q.name)));
  return { from: a, to: b, rows };
}

async function approveSuggestion(user, access, employeeId, day, status) {
  if (!M.validDay(day) || !employeeId) return { status: 400, error: 'Pick the day.' };
  if (!['Present', 'Half Day'].includes(status)) return { status: 400, error: 'Pick Present or Half Day.' };
  if (access && access.ids && !access.ids.includes(employeeId)) return { status: 403, error: 'This employee is outside your access.' };
  const row = (await suggestions(day, day, access)).rows.find((r) => r.employeeId === employeeId);
  if (!row) return { status: 409, error: 'This day already has attendance, or there is no PC activity to go by. Nothing was changed.' };
  const pay = await require('./exitDate').payrollStatusOn(day).catch(() => null); // eslint-disable-line global-require
  if (pay && pay.closed) return { status: 409, error: `Payroll for ${day.slice(0, 7)} is closed, so this day cannot be filled now.` };
  try {
    await prisma.attendance.create({ data: { employeeId, date: day, status, checkIn: row.checkIn, checkOut: row.checkOut, timesSetBy: `PC activity, approved by ${user.name || 'HR'}`.slice(0, 120), timesSetAt: new Date() } });
  } catch (e) {
    if (e.code === 'P2002') return { status: 409, error: 'This day already has attendance. Nothing was changed.' };
    throw e;
  }
  await logAudit({ userId: user.id, actorName: user.name, action: 'Monitoring: attendance approved from PC activity', entity: 'Monitoring', entityId: employeeId, toValue: `${row.name} · ${day} · ${status} · ${row.checkIn} to ${row.checkOut}` }).catch(() => {});
  return { status: 200, message: `${row.name}: ${day} marked ${status}.` };
}

async function dismissSuggestion(user, employeeId, day) {
  if (!M.validDay(day) || !employeeId) return { status: 400, error: 'Pick the day.' };
  await prisma.appSetting.upsert({ where: { key: `${DISMISS}${employeeId}|${day}` }, create: { key: `${DISMISS}${employeeId}|${day}`, value: '1', updatedById: user.id, updatedByName: user.name || null }, update: { value: '1' } });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Monitoring: attendance suggestion dismissed', entity: 'Monitoring', entityId: employeeId, toValue: day }).catch(() => {});
  return { status: 200, message: 'Dismissed.' };
}

// --- the scheduled mail ----------------------------------------------------------------------------------------------------------
const SEND_AT = '19:00';
const csvCell = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
async function sendScheduled(now = Date.now()) {
  const s = await M.settings();
  if (!s.reportEnabled || !String(s.reportEmails || '').trim()) return { sent: false };
  const day = M.istDay(now);
  if (hmOf(now) < SEND_AT || s.reportLastDay === day) return { sent: false };
  const WD = require('./workingDays'); // eslint-disable-line global-require
  await WD.ready().catch(() => {});
  const weekly = s.reportFrequency === 'weekly';
  if (weekly ? new Date(`${day}T00:00:00Z`).getUTCDay() !== 6 : !WD.isWorking(day)) return { sent: false };
  // one mail, even when two sweeps meet
  const once = await prisma.monitoringSetting.updateMany({ where: { id: 'default', OR: [{ reportLastDay: null }, { reportLastDay: { not: day } }] }, data: { reportLastDay: day } });
  if (!once.count) return { sent: false };
  const from = weekly ? M.addDays(day, -6) : day;
  const r = await M.reportRows(from, day, '', null, 'employee');
  const lines = r.rows.map((x) => `${x.name}${x.department ? ` (${x.department})` : ''}: active ${x.activeHours} h, idle ${x.idleHours} h${x.productivity === null ? '' : `, score ${x.productivity}%`}`);
  const head = ['Employee', 'Code', 'Department', 'Days', 'Active hours', 'Idle hours', 'Break hours', 'Productive hours', 'Score'];
  const csv = [head, ...r.rows.map((x) => [x.name, x.code, x.department, x.days, x.activeHours, x.idleHours, x.breakHours, x.productiveHours, x.productivity === null ? '' : `${x.productivity}%`])].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const period = weekly ? `${from} to ${day}` : day;
  const mail = await require('./mailer').sendMail({ // eslint-disable-line global-require
    to: s.reportEmails, subject: `TeamLink: PC activity, ${period}`, useEmployeeFrom: false, fromName: 'TeamLink',
    text: `PC activity for ${period}.\n\n${lines.join('\n') || 'No activity was recorded.'}\n\nThe full table is attached. More detail: HRMS -> Employee Monitoring -> Reports.`,
    attachments: [{ filename: `pc-activity-${from}-to-${day}.csv`, content: `﻿${csv}` }],
  }).catch((e) => ({ ok: false, error: e.message }));
  await logAudit({ action: 'Monitoring: scheduled report mailed', entity: 'ActivityLog', toValue: `${period} · ${r.rows.length} people · ${String(s.reportEmails).slice(0, 200)}${mail && mail.ok === false ? ` · failed: ${mail.error}` : ''}` }).catch(() => {});
  return { sent: !(mail && mail.ok === false), people: r.rows.length };
}

module.exports = {
  pcAttendance,
  workCounts, payrollRows, suggestions, approveSuggestion, dismissSuggestion, sendScheduled,
};
