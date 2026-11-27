// ---------------------------------------------------------------------------
// WHO APPROVES A LEAVE, BY THE PAY MONTH (founder 2026-11-25 / 27):
//   "In a month the TL gives approval for 2 days; more than that the Super Admin gives. If the employee puts 4 leaves in that month, the TL
//    approves 2 leaves and the Super Admin the remaining 2." His answers: counted PER MONTH; the days are SPLIT (the employee can end up
//    with only 2 approved); the days within the 2 need the Team Lead and then HR; STL and Manager only see them.
//
//   * The first `limit` leave days of a pay month (limit = the TL Approval Rule's number, 2)  ->  Team Lead, then HR. Both must approve.
//   * Every further leave day of that month                                                    ->  the Super Admin only.
//   "Month" = the PAY MONTH of utils/payrollCycle.js (16th to 15th when so set), the same month as the free leave day in payroll.
//   Days already applied in that month (waiting or approved, any leave type) use up the quota first; rejected and cancelled ones do not.
//   A half day counts 0.5. A day is within the quota only if it fits whole.
//
// HOW. Each stretch of an application with one kind of approval is saved as its own LeaveRequest row (usually one or two), so balances,
// attendance, the sandwich rule and the payroll rules (utils/payrollLeaveRule.js) work on them unchanged: an approved row is approved leave,
// a waiting row is waiting leave. Meta key leave.meta.<id>.split:
//   { group: <first id>, ids: [..], kinds: ['tl'|'sa'..], part: n, of: n, kind: 'tl'|'sa', limit, totalDays, fromDate, toDate (whole
//     application), months: [{ key, label, rangeText, usedBefore }] }
//
// NOT UNDER THIS RULE (the earlier routing applies unchanged): the setting is off; the TL rule is off or counts requests instead of days;
// a TL's / STL's own leave (utils/leadLeave.js: only the Super Admin, whole); somebody with no Team Lead and no HR above them on the chain
// (a Manager's own leave); a leave HR marked in attendance or one that came from Pulse. Requests raised before keep the routing they were
// raised with (no meta.split).
// Setting: AppSetting `leave.splitApproval` { enabled } - ON for TeamLink unless somebody switched it off. A second company running this
// code (COMPANY_KEY set, utils/companyGuard.js) starts OFF: its approvals do not change unless its own Super Admin switches it on.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const leaveMeta = require('./leaveMeta');
const leaveDays = require('./leaveDays');
const leaveText = require('./leaveText');
const PC = require('./payrollCycle');
const policy = require('./leavePolicy');
const leadRule = require('./leadLeave');

const KEY = 'leave.splitApproval';
const defaults = () => ({ enabled: !String(process.env.COMPANY_KEY || '').trim() });
const USES_QUOTA = ['Pending', 'Approved', 'Cancellation Requested'];
const LABEL = { TL: 'Team Lead', STL: 'STL', HR: 'HR', SUPER_ADMIN: 'Super Admin', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Assistant Manager' };

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const plural = (n) => `${n} day${Number(n) === 1 ? '' : 's'}`;
const day = (v) => String(v || '').slice(0, 10);
const dmy = (iso) => { const s = day(iso); return s ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : ''; };
const span = (from, to) => (to && day(to) !== day(from) ? `${dmy(from)} to ${dmy(to)}` : dmy(from));

const saNote = (limit) => `Beyond the first ${plural(limit)} of leave in the pay month - only the Super Admin approves or rejects these`;
const saVisNote = (limit) => `Not needed - leave beyond ${plural(limit)} in the pay month is decided by the Super Admin. Shown for information.`;
const tlVisNote = (limit) => `Not needed - the first ${plural(limit)} of leave in the pay month are approved by the Team Lead and HR. Shown for information.`;
const refusal = (split) => `These days are beyond the first ${plural(split.limit)} of leave in the pay month: only the Super Admin approves or rejects them.`;
// What the approver of one row is told, and what the Team Lead's screen says. hr === false: nobody holds HR on this leave's chain.
const explain = (split) => (split.kind === 'sa'
  ? `Beyond the first ${plural(split.limit)} of leave in this pay month: only the Super Admin approves.`
  : split.hr === false
    ? `Within the first ${plural(split.limit)} of leave in this pay month: the Team Lead approves (no HR approver is set for this department).`
    : `Within the first ${plural(split.limit)} of leave in this pay month: the Team Lead and then HR both approve.`);

async function getSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  try { return { ...defaults(), ...(row ? JSON.parse(row.value) : {}) }; } catch { return defaults(); }
}

async function saveSettings({ enabled }, actor = null) {
  if (typeof enabled !== 'boolean') return { error: 'Say whether it is on or off.' };
  const before = await getSettings();
  const settings = { ...before, enabled };
  const value = JSON.stringify(settings);
  const who = { updatedById: actor ? actor.id : null, updatedByName: actor ? actor.name : null };
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value, ...who }, create: { key: KEY, value, ...who } });
  return { before, settings };
}

// What the settings screen says: on / off, the day limit (the TL rule's), and why it does nothing when it does not.
async function status() {
  const [settings, rule] = await Promise.all([getSettings(), policy.getTlRule()]);
  let blockedBy = null;
  if (!rule.enabled) blockedBy = 'The TL Approval Rule is switched off, so a TL may approve a leave of any length.';
  else if (rule.mode !== 'days') blockedBy = 'The TL Approval Rule counts requests per month, not days.';
  else if (!(rule.limit >= 1)) blockedBy = 'The TL day limit is 0.';
  return { enabled: !!settings.enabled, limit: rule.limit, applies: !!settings.enabled && !blockedBy, blockedBy };
}

// The days of from..to that a leave really uses (no Sundays / week offs / company holidays).
async function countedDates(fromDate, toDate) {
  const c = await leaveDays.countFor(fromDate, toDate);
  const skip = new Set(c.skipped.map((s) => s.date));
  const out = [];
  const d = new Date(`${day(fromDate)}T00:00:00Z`);
  for (let i = 0; i < c.calendarDays; i += 1) {
    const iso = d.toISOString().slice(0, 10);
    if (!skip.has(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// A request's days laid on its dates: [{ date, amount }] - whole days in date order, a half day 0.5.
async function daysOnDates({ fromDate, toDate, days, halfDay = null }) {
  const dates = halfDay ? [day(fromDate)] : await countedDates(fromDate, toDate || fromDate);
  let left = Number(days != null ? days : dates.length);
  return dates.map((date) => {
    const amount = r2(Math.max(0, Math.min(halfDay ? 0.5 : 1, left)));
    left = r2(left - amount);
    return { date, amount };
  }).filter((x) => x.amount > 0);
}

// Leave days this employee has already applied (waiting or approved) in each of these pay months. -> Map(monthKey -> days)
async function usedInMonths(employeeId, monthKeys, cycle, excludeId = null) {
  const used = new Map(monthKeys.map((k) => [k, 0]));
  if (!monthKeys.length) return used;
  const ranges = monthKeys.map((k) => PC.cycleOf(k, cycle));
  const from = ranges.map((r) => r.from).sort()[0];
  const to = ranges.map((r) => r.to).sort().pop();
  const rows = await prisma.leaveRequest.findMany({
    where: { employeeId, status: { in: USES_QUOTA }, fromDate: { lte: to }, toDate: { gte: from }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { fromDate: true, toDate: true, days: true, reason: true },
  });
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const laid = await daysOnDates({ fromDate: r.fromDate, toDate: r.toDate, days: r.days, halfDay: leaveText.halfOf(r) }); // eslint-disable-line no-await-in-loop
    laid.forEach((x) => {
      const m = PC.monthOfDate(x.date, cycle);
      if (m && used.has(m.month)) used.set(m.month, r2(used.get(m.month) + x.amount));
    });
  }
  return used;
}

// THE LAST 3 MONTHS (founder 2026-11-27: "leave history last 3 months must be seen on the approve / reject tab itself"): the running pay
// month and the 3 before it, with the days approved / waiting / rejected in each; `ids` = the requests that touch that window (or come
// after it). A request's days are laid on its dates, so one crossing two pay months is counted in both.
const RECENT_MONTHS = 3;
const BUCKET = { Approved: 'approved', 'Cancellation Requested': 'approved', Pending: 'pending', Rejected: 'rejected' };
const todayIst = (now = Date.now()) => new Date(now + 330 * 60000).toISOString().slice(0, 10);

async function recentMonths(rows, today = todayIst()) {
  const { cycle } = await PC.getSettings();
  const current = PC.monthOfDate(today, cycle).month;
  const empty = () => ({ approved: 0, pending: 0, rejected: 0 });
  const months = Array.from({ length: RECENT_MONTHS + 1 }, (_, i) => { // newest first
    const c = PC.cycleOf(PC.addMonths(current, -i), cycle);
    return { key: c.key, label: c.label, rangeText: c.rangeText, from: c.from, current: i === 0, ...empty() };
  });
  const since = months[months.length - 1].from;
  const later = empty(); // already applied for a pay month after the running one
  const recent = rows.filter((r) => day(r.toDate || r.fromDate) >= since);
  for (const r of recent) { // eslint-disable-line no-restricted-syntax
    const bucket = BUCKET[r.status]; // a cancelled leave is listed but counts nowhere
    if (bucket) {
      const laid = await daysOnDates({ fromDate: r.fromDate, toDate: r.toDate, days: r.days ?? 1, halfDay: leaveText.halfOf(r) }); // eslint-disable-line no-await-in-loop
      // days that sit on no working date (a Sunday counted by the sandwich rule) go with the leave's last date
      const rest = r2(Number(r.days ?? 1) - laid.reduce((n, x) => n + x.amount, 0));
      if (rest > 0) laid.push({ date: laid.length ? laid[laid.length - 1].date : day(r.fromDate), amount: rest });
      laid.filter((x) => x.date >= since).forEach((x) => {
        const key = PC.monthOfDate(x.date, cycle).month;
        const into = key > current ? later : months.find((m) => m.key === key);
        if (into) into[bucket] = r2(into[bucket] + x.amount);
      });
    }
  }
  return { since, months, later: later.approved + later.pending + later.rejected > 0 ? later : null, ids: recent.map((r) => r.id) };
}

// How would this application be approved? -> null (not under this rule) or
// { limit, totalDays, months: [{ key, label, rangeText, usedBefore }], parts: [{ kind: 'tl'|'sa', fromDate, toDate, days }] }
// excludeId: the application itself when it is already saved, so it is not counted as used before.
async function plan({ employee, fromDate, toDate, days, halfDay = null, excludeId = null }) {
  if (!employee || !(Number(days) > 0)) return null;
  const s = await status();
  if (!s.applies) return null;
  if (await leadRule.isLeadEmployee(employee)) return null;
  const laid = await daysOnDates({ fromDate, toDate, days, halfDay });
  if (!laid.length) return null;
  const { cycle } = await PC.getSettings();
  laid.forEach((x) => { x.month = PC.monthOfDate(x.date, cycle).month; });
  const keys = [...new Set(laid.map((x) => x.month))];
  const before = await usedInMonths(employee.id, keys, cycle, excludeId);
  const used = new Map(before);
  laid.forEach((x) => {
    const had = used.get(x.month) || 0;
    x.kind = had + x.amount <= s.limit + 1e-9 ? 'tl' : 'sa';
    used.set(x.month, r2(had + x.amount));
  });
  const groups = [];
  laid.forEach((x) => {
    const last = groups[groups.length - 1];
    if (last && last[0].kind === x.kind) last.push(x); else groups.push([x]);
  });
  return {
    limit: s.limit,
    totalDays: r2(days),
    months: keys.map((k) => { const c = PC.cycleOf(k, cycle); return { key: k, label: c.label, rangeText: c.rangeText, usedBefore: before.get(k) || 0 }; }),
    parts: groups.map((g, i) => ({
      kind: g[0].kind,
      fromDate: i === 0 ? day(fromDate) : g[0].date,
      toDate: i === groups.length - 1 ? day(toDate || fromDate) : g[g.length - 1].date,
      days: r2(g.reduce((n, x) => n + x.amount, 0)),
    })),
  };
}

// Save the plan on the request: the saved row (the whole application) becomes the first part and the other parts are added. All rows and
// their meta are written together: a failure leaves the one whole request exactly as it was, which the earlier routing then handles.
async function divide(leave, p) {
  const whole = { fromDate: leave.fromDate, toDate: leave.toDate };
  return prisma.$transaction(async (tx) => {
    const [head, ...tail] = p.parts;
    const rows = [await tx.leaveRequest.update({ where: { id: leave.id }, data: p.parts.length > 1 ? { toDate: head.toDate, days: head.days } : {} })];
    for (const part of tail) { // eslint-disable-line no-restricted-syntax
      rows.push(await tx.leaveRequest.create({ // eslint-disable-line no-await-in-loop
        data: { employeeId: leave.employeeId, type: leave.type, fromDate: part.fromDate, toDate: part.toDate, days: part.days, reason: leave.reason },
      }));
    }
    const shared = {
      group: leave.id, ids: rows.map((r) => r.id), kinds: p.parts.map((x) => x.kind), of: rows.length, limit: p.limit, totalDays: p.totalDays,
      months: p.months, ...whole,
    };
    for (let i = 0; i < rows.length; i += 1) {
      const key = leaveMeta.KEY(rows[i].id);
      const cur = await tx.appSetting.findUnique({ where: { key } }); // eslint-disable-line no-await-in-loop
      let old = {};
      try { old = cur ? JSON.parse(cur.value) : {}; } catch { old = {}; }
      const value = JSON.stringify({ ...old, split: { ...shared, part: i + 1, kind: p.parts[i].kind } });
      await tx.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } }); // eslint-disable-line no-await-in-loop
    }
    return rows;
  });
}

// A LEAVE ALREADY WAITING WHEN THIS RULE STARTED (founder 2026-11-27: "the TL gives approval for 2 days only - it is not taking it").
// It keeps the routing it was applied with until the Team Lead / Super Admin presses "Split by the 2-day rule" on its screen; only then is
// it divided like a new application. -> the plan, or null when it cannot be moved: not waiting, already split or decided by somebody,
// within the day limit (the TL may already approve it), a TL's own leave, one from Pulse or marked in attendance, days already counted on
// import, or no day of the month left for the Team Lead.
async function movable(leave, employee) {
  if (!leave || !employee || leave.status !== 'Pending') return null;
  const meta = await leaveMeta.getMeta(leave.id);
  if (meta && (meta.split || (meta.source && meta.source !== 'TeamLink'))) return null;
  if (/Marked as Leave in attendance|Pulse HRM sync/i.test(String(leave.reason || ''))) return null;
  const steps = await prisma.approvalStep.findMany({ where: { workflow: 'leave', recordId: leave.id }, orderBy: { seq: 'asc' } });
  if (steps.some((s) => s.mode !== 'applicant' && ['Approved', 'Rejected'].includes(s.status))) return null;
  if (!firstApprovers(steps).length) return null;
  if (await prisma.auditLog.count({ where: { entityId: leave.id, action: policy.PRECOUNTED } })) return null;
  const p = await plan({
    employee, fromDate: leave.fromDate, toDate: leave.toDate, days: leave.days, halfDay: leaveText.halfOf(leave), excludeId: leave.id,
  });
  if (!p || !(Number(leave.days) > p.limit) || !p.parts.some((x) => x.kind === 'tl')) return null;
  return p;
}

// The split record of one request, or null (an ordinary request).
async function of(id) {
  const m = await leaveMeta.getMeta(id);
  return (m && m.split) || null;
}

const toSuperAdmin = (recordId, limit) => leadRule.sendToSuperAdmin('leave', recordId, { saNote: saNote(limit), visNote: saVisNote(limit) });

// The two approvers of the month's first days on a chain: the Team Lead (the STL only where there is no Team Lead step) and HR.
function firstApprovers(steps) {
  const usable = (s) => !!s.approverUserId && !['Applied', 'Skipped'].includes(s.status);
  const lead = (steps || []).find((s) => s.level === 'TL' && usable(s)) || (steps || []).find((s) => s.level === 'STL' && usable(s)) || null;
  const hr = (steps || []).find((s) => s.level === 'HR' && usable(s)) || null;
  return [lead, hr].filter(Boolean);
}

// Team Lead, then HR; everybody else on the chain only sees it. With neither on the chain (a chain laid down later for somebody who has
// no approver below the Super Admin) the Super Admin decides.
async function toLeadThenHr(recordId, limit) {
  const steps = await prisma.approvalStep.findMany({ where: { workflow: 'leave', recordId }, orderBy: { seq: 'asc' } });
  const keep = firstApprovers(steps);
  if (!keep.length) return toSuperAdmin(recordId, limit);
  const cur = await of(recordId); // remembered for the labels: is there an HR to approve after the Team Lead?
  if (cur) await leaveMeta.setMeta(recordId, { split: { ...cur, hr: keep.some((s) => s.level === 'HR') } });
  const ids = new Set(keep.map((s) => s.id));
  const others = steps.filter((s) => !ids.has(s.id) && ['Pending', 'Waiting'].includes(s.status));
  if (others.length) await prisma.approvalStep.updateMany({ where: { id: { in: others.map((s) => s.id) } }, data: { status: 'Visibility', note: tlVisNote(limit) } });
  const now = new Date();
  for (let i = 0; i < keep.length; i += 1) {
    const s = keep[i];
    const data = i === 0
      ? { status: 'Pending', mode: 'required', activatedAt: s.activatedAt || now, dueAt: s.dueAt || (s.slaHours ? new Date(now.getTime() + s.slaHours * 3600000) : null) }
      : { status: 'Waiting', mode: 'required', activatedAt: null, dueAt: null };
    await prisma.approvalStep.update({ where: { id: s.id }, data }); // eslint-disable-line no-await-in-loop
  }
  return keep[0];
}

// Lay the approvers of one part on its chain (the chain has just been started).
const shapeChain = (recordId, split) => (split.kind === 'sa' ? toSuperAdmin(recordId, split.limit) : toLeadThenHr(recordId, split.limit));

// Who decided (or is to decide) each of these requests, level by level. -> Map(id -> [{ level, label, name, status, at, direct, note }])
async function approvalsFor(ids, { open = false } = {}) {
  const out = new Map(ids.map((i) => [i, []]));
  if (!ids.length) return out;
  const steps = await prisma.approvalStep.findMany({
    where: { workflow: 'leave', recordId: { in: ids }, mode: { not: 'applicant' }, status: { in: open ? ['Approved', 'Rejected', 'Pending', 'Waiting'] : ['Approved', 'Rejected'] } },
    orderBy: { seq: 'asc' },
  });
  steps.forEach((s) => {
    if (['Pending', 'Waiting'].includes(s.status) && s.mode !== 'required') return;
    const done = ['Approved', 'Rejected'].includes(s.status);
    out.get(s.recordId).push({
      level: s.level, label: LABEL[s.level] || s.level, name: (done && s.actedByName) || s.approverName || null, status: s.status,
      at: done ? s.actedAt : null, direct: !!s.direct, note: done ? s.note || null : null,
    });
  });
  return out;
}

// Every part of the same application with its approvals, for the screen and the messages.
async function parts(split) {
  if (!split) return [];
  const rows = await prisma.leaveRequest.findMany({ where: { id: { in: split.ids } } });
  const approvals = await approvalsFor(split.ids, { open: true });
  const withHr = new Set((await prisma.approvalStep.findMany({
    where: { workflow: 'leave', recordId: { in: split.ids }, level: 'HR', approverUserId: { not: null }, mode: 'required' }, select: { recordId: true },
  })).map((s) => s.recordId));
  return split.ids.map((id, i) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return { id, part: i + 1, kind: split.kinds[i], deleted: true };
    const steps = (approvals.get(id) || []).filter((s) => row.status === 'Pending' || ['Approved', 'Rejected'].includes(s.status));
    const waiting = row.status === 'Pending' ? steps.find((s) => s.status === 'Pending') : null;
    return {
      id, part: i + 1, kind: split.kinds[i], hr: withHr.has(id), fromDate: row.fromDate, toDate: row.toDate, days: row.days, status: row.status,
      waitingFor: waiting ? (waiting.name || waiting.label) : null, waitingLevel: waiting ? waiting.label : null,
      decidedBy: row.decidedBy || null, decidedAt: row.decidedAt || null, comment: row.rejectReason || row.approvalReason || null,
      approvals: steps,
    };
  });
}

// The lines the approver of one part gets with the notification.
function noticeFor(split) {
  const which = split.of > 1 ? `This is part ${split.part} of ${split.of} of a ${plural(split.totalDays)} leave (${span(split.fromDate, split.toDate)}). ` : '';
  return `${which}${explain(split)}`;
}

module.exports = {
  KEY, getSettings, saveSettings, status, plan, countedDates, usedInMonths, recentMonths, divide, movable, of, firstApprovers, shapeChain, approvalsFor, parts, noticeFor, explain, refusal,
};
