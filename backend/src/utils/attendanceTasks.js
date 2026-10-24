// ---------------------------------------------------------------------------
// ATTENDANCE ISSUE TASKS (HRMS item 2, 2026-10-13):
// "Send notifications for late coming and missing check-in/check-out. Create tasks for
// responsible team members to resolve attendance issues."
//
// utils/attendanceAlerts.js tells people about TODAY (live). This engine looks at the COMPLETED
// working days just before today (never today, never a Sunday / holiday / leave day) and, for each
// unresolved issue, does two things:
//
//   1. TELLS  the employee (bell + the daily email) -  "You did not check out on 12-OCT-2026.
//             Please regularise."  - and the team lead (ONE grouped bell + daily email per TL per day).
//   2. TASKS  one Task per employee + date + kind, given to the employee's TL ("Resolve: <Name> missed
//             check-out on <date>"), due the NEXT WORKING DAY; a second task for HR only when the issue is
//             older than 2 working days. De-duplicated by a marker in the description; auto-closed the
//             moment the issue is gone (punch added, regularisation approved, late-coming approved, leave
//             approved) - closeFixed() runs on every sweep and right after those approvals.
//
// ISSUES (one rule, the day engine of utils/attendanceDays.js):
//   late         first check-in after the Late-after time (09:15) with NO late-coming request on it
//                (a pending / approved / rejected request is already "told")
//   missingIn    a working day with no punch, no mark, no leave and no request ("Absent: nothing recorded")
//                or a check-out with no check-in
//   missingOut   checked in, never checked out
//
// SAFE BY DEFAULT: the engine is OFF (settings.enabled false) - the sweep does nothing and nothing is
// written until Admin switches it on (Attendance -> Alerts -> "Attendance issue tasks"). Switching on stamps
// goLiveDate: nothing before that date is ever raised (never backfilled). Quiet on Sundays and holidays.
// Test logins (ZZTEST / example.test) are never touched by the real run; tests pass testMode + scope.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./attendanceDays');
const { sendMail } = require('./mailer');
const { logAudit } = require('./audit');
const hrmsNotify = require('./hrmsNotify');
const workflow = require('./approvalWorkflow');
const PW = require('./pendingWork');
const { withoutSystemAccounts } = require('./systemAccounts');

const KEY = 'attendance.issueTasks.settings';
const LEFT = ['Relieved', 'Exited', 'Exit Process', 'Terminated', 'Inactive'];
const DONE_TASK = ['Completed', 'Cancelled', 'Closed'];
const TEST_RE = /zztest|example\.test/i;
const MARK = '[auto-attendance';
const KIND = {
  late: { label: 'came late', title: 'Late coming', event: 'lateLogin' },
  missingIn: { label: 'missed check-in', title: 'Missing check-in', event: 'missingCheckIn' },
  missingOut: { label: 'missed check-out', title: 'Missing check-out', event: 'missingCheckOut' },
};
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dmy = (iso) => `${iso.slice(8, 10)}-${MON3[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isTestEmp = (e) => TEST_RE.test([e.name, e.employeeCode, e.email, e.user && e.user.email, e.user && e.user.name].join(' '));

const DEFAULTS = { enabled: false, goLiveDate: null, lookbackWorkingDays: 5, hrAfterWorkingDays: 2, notifyEmployee: true, notifyTl: true, late: true, missingIn: true, missingOut: true };

async function getSettings() {
  let v = {};
  try { const row = await prisma.appSetting.findUnique({ where: { key: KEY } }); v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  const int = (x, lo, hi, d) => (Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  return {
    enabled: v.enabled === true,
    goLiveDate: /^\d{4}-\d{2}-\d{2}$/.test(v.goLiveDate || '') ? v.goLiveDate : null,
    lookbackWorkingDays: int(v.lookbackWorkingDays, 1, 15, DEFAULTS.lookbackWorkingDays),
    hrAfterWorkingDays: int(v.hrAfterWorkingDays, 0, 10, DEFAULTS.hrAfterWorkingDays),
    notifyEmployee: v.notifyEmployee !== false,
    notifyTl: v.notifyTl !== false,
    late: v.late !== false, missingIn: v.missingIn !== false, missingOut: v.missingOut !== false,
  };
}
async function saveSettings(patch = {}, user = null) {
  const cur = await getSettings();
  const next = { ...cur };
  const errs = [];
  ['notifyEmployee', 'notifyTl', 'late', 'missingIn', 'missingOut'].forEach((k) => { if (patch[k] !== undefined) next[k] = !!patch[k]; });
  [['lookbackWorkingDays', 1, 15], ['hrAfterWorkingDays', 0, 10]].forEach(([k, lo, hi]) => {
    if (patch[k] === undefined) return;
    const n = Number(patch[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) errs.push(`${k} must be a whole number from ${lo} to ${hi}`); else next[k] = n;
  });
  if (patch.enabled !== undefined) {
    next.enabled = !!patch.enabled;
    // Switching ON stamps today as the go-live date: nothing before it is ever raised.
    if (next.enabled && !cur.enabled) next.goLiveDate = D.localDate();
  }
  if (errs.length) return { error: errs.join('. ') };
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null }, create: { key: KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null } });
  await logAudit({ userId: user ? user.id : null, action: 'Attendance issue tasks settings changed', entity: 'AppSetting', entityId: KEY, fromValue: JSON.stringify(cur), toValue: value });
  return { settings: next };
}

async function nextWorkingDay(from) {
  let d = from;
  for (let i = 0; i < 14; i += 1) {
    d = addDays(d, 1);
    // eslint-disable-next-line no-await-in-loop
    if (!await PW.offDayReason(d)) return d;
  }
  return addDays(from, 1);
}

// Unresolved issues on the completed days before `today`.
//   [{ employee, date, type, time, workingDaysAgo }]
async function scan({ now = new Date(), settings, testMode = false, scope = null }) {
  const today = D.localDate(now);
  const goLive = settings.goLiveDate;
  const cfg = await require('./attendancePolicy').withExtras((await prisma.hrConfig.findFirst()) || {}); // eslint-disable-line global-require
  const all = await prisma.employee.findMany({
    where: withoutSystemAccounts({ employmentStatus: { notIn: LEFT } }),
    include: { user: { select: { id: true, name: true, email: true, status: true } } },
  });
  const employees = all.filter((e) => (testMode ? isTestEmp(e) && (!scope || scope.employeeIds.includes(e.id)) : !isTestEmp(e)));
  if (!employees.length) return { today, issues: [] };
  const from = addDays(today, -(settings.lookbackWorkingDays * 2 + 4));
  const to = addDays(today, -1);
  const loaded = await D.loadDays(prisma, { employees, from, to, cfg });
  const issues = [];
  employees.forEach((e) => {
    const rows = loaded.days(e).slice().sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
    let ago = 0;
    for (const row of rows) {
      if (['Holiday', 'Weekly Off', 'Not Joined', 'Left', 'Upcoming'].includes(row.status)) continue; // eslint-disable-line no-continue
      if (row.status === 'On Leave' && !row.checkIn && !row.checkOut) continue; // eslint-disable-line no-continue
      ago += 1; // working days ago: 1 = the last working day
      if (ago > settings.lookbackWorkingDays) break;
      if (goLive && row.date < goLive) continue; // eslint-disable-line no-continue
      const type = issueOf(row);
      if (type && settings[type]) issues.push({ employee: e, date: row.date, type, time: type === 'late' ? row.checkIn : null, workingDaysAgo: ago });
    }
  });
  return { today, issues };
}

// The one place that says "this day row holds an attendance issue".
function issueOf(row) {
  if (!row) return null;
  if (row.status === 'Missing Check-Out') return 'missingOut';
  if (row.status === 'Missing Check-In' || (row.status === 'Absent' && row.noRecord && !row.checkIn && !row.checkOut)) return 'missingIn';
  if (row.late && !row.lateExcused && (row.lateState === 'none' || row.lateState === undefined || row.lateState === null) && row.checkIn) return 'late';
  return null;
}

async function tlOf(employee, lad) {
  try {
    const chain = await workflow.resolveChain(employee, lad);
    const pick = ['TL', 'STL', 'HR', 'ASSISTANT_MANAGER', 'MANAGER'].map((l) => chain[l]).find((p) => p && p.user && p.user.id && p.user.id !== employee.userId);
    const hr = chain.HR && chain.HR.user && chain.HR.user.id !== employee.userId ? chain.HR : null;
    return { tl: pick ? pick.user : null, hr: hr ? hr.user : null };
  } catch { return { tl: null, hr: null }; }
}

const markerOf = (e, date, type, hr) => `${MARK} ${e.id} ${date} ${type}${hr ? ' HR' : ''}]`;

async function ensureTask({ employee, date, type, user, hr, due, dryRun }) {
  const marker = markerOf(employee, date, type, hr);
  const have = await prisma.task.findFirst({ where: { description: { contains: marker } }, select: { id: true, status: true } });
  if (have) return { created: false, id: have.id };
  if (dryRun) return { created: true, dry: true };
  const name = `Resolve: ${employee.name} ${KIND[type].label} on ${dmy(date)}`;
  const t = await prisma.task.create({
    data: {
      name,
      department: employee.department || 'HR',
      description: `${marker}\n${employee.name} (${employee.employeeCode || '-'}): ${KIND[type].title.toLowerCase()} on ${dmy(date)}. Check with them, then fix it: add the punch / approve the correction (Attendance -> Regularization) or the late-coming request. This task closes by itself when the day is fixed.`,
      status: 'Not Started', priority: 'Medium',
      startDate: D.localDate(), endDate: due,
      assigneeId: user.id, assignedById: user.id, assigneeName: user.name, assignedByName: 'TeamLink (attendance check)',
    },
  });
  await logAudit({ userId: null, actorName: 'TeamLink (attendance check)', action: 'Attendance issue task created', entity: 'Task', entityId: t.id, toValue: `${t.name} -> ${user.name}`, reason: hr ? 'Older than the HR limit' : null });
  return { created: true, id: t.id };
}

let running = false;
async function run({ now = new Date(), dryRun = false, testMode = false, scope = null, mailer = sendMail, force = false } = {}) {
  if (testMode && !scope) throw new Error('testMode needs a scope { employeeIds, userIds }');
  const settings = await getSettings();
  const out = { enabled: settings.enabled, dryRun, today: D.localDate(now), issues: 0, tasksCreated: 0, tasksClosed: 0, employeeBells: 0, tlBells: 0, hrTasks: 0, skipped: null, list: [] };
  if (!settings.enabled && !force) return { ...out, skipped: 'Attendance issue tasks are switched off.' };
  const offToday = await PW.offDayReason(out.today);
  if (offToday && !force) return { ...out, skipped: `Nothing today (${offToday}).` };
  if (!dryRun && !testMode) { if (running) return { ...out, skipped: 'already running' }; running = true; }
  try {
    const s = force && !settings.goLiveDate ? { ...settings } : settings;
    const { issues } = await scan({ now, settings: s, testMode, scope });
    out.issues = issues.length;
    const lad = await workflow.ladder();
    const due = await nextWorkingDay(out.today);
    const settingsN = await hrmsNotify.getSettings();
    const perTl = new Map(); // userId -> { user, lines[] }
    const dayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; })();
    for (const is of issues) {
      const e = is.employee;
      // eslint-disable-next-line no-await-in-loop
      const { tl, hr } = await tlOf(e, lad);
      out.list.push({ employee: e.name, date: is.date, type: is.type, tl: tl ? tl.name : null });
      if (dryRun) continue; // eslint-disable-line no-continue
      const k = KIND[is.type];
      // 1. the employee (bell + daily email), once per day per issue
      if (settings.notifyEmployee && e.user && e.user.status !== 'Inactive') {
        const title = `${k.title} on ${dmy(is.date)} - please regularise`;
        const text = is.type === 'missingOut'
          ? `You did not check out on ${dmy(is.date)}. Please regularise (Attendance -> Regularization).\nOpen: /attendance?tab=regularization`
          : is.type === 'missingIn'
            ? `No check-in was recorded for you on ${dmy(is.date)}. If you were at work, please regularise (Attendance -> Regularization).\nOpen: /attendance?tab=regularization`
            : `You checked in at ${String(is.time).slice(0, 5)} on ${dmy(is.date)}, after the Late-after time. Please tell why (Attendance -> Late coming).\nOpen: /attendance?tab=late`;
        // eslint-disable-next-line no-await-in-loop
        const r = await hrmsNotify.notify(k.event, { userId: e.user.id, name: e.name, email: e.email || e.user.email }, { title, message: text }, { now, mailer, settings: settingsN });
        if (r.inApp) out.employeeBells += 1;
      }
      // 2. the TL's task (and HR's, when older than the limit)
      if (tl) {
        // eslint-disable-next-line no-await-in-loop
        const t = await ensureTask({ employee: e, date: is.date, type: is.type, user: tl, hr: false, due, dryRun });
        if (t.created) out.tasksCreated += 1;
        if (settings.notifyTl) {
          const g = perTl.get(tl.id) || { user: tl, lines: [] };
          g.lines.push(`- ${e.name}: ${k.label} on ${dmy(is.date)}`);
          perTl.set(tl.id, g);
        }
      }
      if (hr && is.workingDaysAgo > settings.hrAfterWorkingDays && (!tl || hr.id !== tl.id)) {
        // eslint-disable-next-line no-await-in-loop
        const t = await ensureTask({ employee: e, date: is.date, type: is.type, user: hr, hr: true, due, dryRun });
        if (t.created) { out.tasksCreated += 1; out.hrTasks += 1; }
        if (settings.notifyTl) {
          const g = perTl.get(hr.id) || { user: hr, lines: [] };
          g.lines.push(`- ${e.name}: ${k.label} on ${dmy(is.date)} (more than ${settings.hrAfterWorkingDays} working days ago)`);
          perTl.set(hr.id, g);
        }
      }
    }
    // the TL / HR: one grouped bell + daily email per person per day
    if (!dryRun) {
      for (const g of perTl.values()) {
        const title = `${g.lines.length} attendance issue${g.lines.length === 1 ? '' : 's'} to resolve`;
        const message = `${g.lines.slice(0, 10).join('\n')}${g.lines.length > 10 ? `\n... and ${g.lines.length - 10} more` : ''}\nA task was created for each one (due ${dmy(due)}).\nOpen: /employee-services?tab=timesheet`;
        // eslint-disable-next-line no-await-in-loop
        const r = await hrmsNotify.notify('attendanceIssue', { userId: g.user.id, name: g.user.name, email: g.user.email }, { title, message }, { now, mailer, settings: settingsN });
        if (r.inApp) out.tlBells += 1;
      }
      out.tasksClosed = (await closeFixed({ now, testMode, scope, settings })).closed;
    }
    void dayStart;
    return out;
  } finally {
    if (!dryRun && !testMode) running = false;
  }
}

// Close every open auto task whose issue is gone. employeeIds (optional) narrows to some people.
async function closeFixed({ now = new Date(), testMode = false, scope = null, settings = null, employeeIds = null } = {}) {
  const open = await prisma.task.findMany({ where: { description: { contains: MARK }, status: { notIn: DONE_TASK } }, select: { id: true, description: true, name: true } });
  const items = open.map((t) => {
    const m = /\[auto-attendance (\S+) (\d{4}-\d{2}-\d{2}) (late|missingIn|missingOut)( HR)?\]/.exec(t.description || '');
    return m ? { task: t, employeeId: m[1], date: m[2], type: m[3] } : null;
  }).filter(Boolean).filter((x) => (!employeeIds || employeeIds.includes(x.employeeId)) && (!testMode || (scope && scope.employeeIds.includes(x.employeeId))));
  const out = { closed: 0, checked: items.length };
  if (!items.length) return out;
  const cfg = await require('./attendancePolicy').withExtras((await prisma.hrConfig.findFirst()) || {}); // eslint-disable-line global-require
  const emps = await prisma.employee.findMany({ where: { id: { in: [...new Set(items.map((x) => x.employeeId))] } }, include: { user: { select: { id: true, name: true, email: true, status: true } } } });
  const byId = new Map(emps.map((e) => [e.id, e]));
  for (const it of items) {
    const e = byId.get(it.employeeId);
    let fixed = false; let why = 'The day is fixed';
    if (!e || LEFT.includes(e.employmentStatus)) { fixed = true; why = 'The employee is no longer on the rolls'; } else {
      // eslint-disable-next-line no-await-in-loop
      const loaded = await D.loadDays(prisma, { employees: [e], from: it.date, to: it.date, cfg });
      const row = loaded.days(e)[0];
      if (issueOf(row) !== it.type) fixed = true;
    }
    if (!fixed) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await prisma.task.update({ where: { id: it.task.id }, data: { status: 'Completed', completedAt: new Date(), reviewState: 'Approved', reviewedByName: 'TeamLink (auto)', reviewedAt: new Date(), reviewNote: why } });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ userId: null, actorName: 'TeamLink (attendance check)', action: 'Attendance issue task closed', entity: 'Task', entityId: it.task.id, toValue: it.task.name, reason: why });
    out.closed += 1;
  }
  void now; void settings;
  return out;
}

// Right after an approval (leave, regularisation, late coming) the person's tasks close at once.
function closeFixedFor(employeeId) {
  return closeFixed({ employeeIds: [employeeId] }).catch((e) => { console.error('[attendanceTasks] close failed', e.message); return null; }); // eslint-disable-line no-console
}

let timer = null;
function startSweep() {
  if (timer) return;
  const everyMs = Number(process.env.ATTENDANCE_TASKS_INTERVAL_MS || 30 * 60 * 1000);
  if (!everyMs || everyMs <= 0) return;
  // INERT until the setting is switched on: run() returns at once when settings.enabled is false.
  const tick = () => run().then((o) => { if (o && !o.skipped && (o.tasksCreated || o.tasksClosed)) console.log(`[attendance-tasks] ${o.tasksCreated} task(s) created, ${o.tasksClosed} closed`); }).catch((e) => console.error('[attendance-tasks]', e.message)); // eslint-disable-line no-console
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
}

async function openCount() {
  return prisma.task.count({ where: { description: { contains: MARK }, status: { notIn: DONE_TASK } } });
}

function registerRoutes(router, { requirePerm }) {
  const configure = requirePerm(null, 'hrms', 'Attendance & Time', 'configure');
  router.get('/issue-tasks', configure, async (req, res) => {
    const settings = await getSettings();
    const preview = await run({ dryRun: true, force: true }).catch((e) => ({ error: e.message }));
    res.json({ settings, openTasks: await openCount(), preview: { issues: preview.issues, list: (preview.list || []).slice(0, 30) } });
  });
  router.put('/issue-tasks', configure, async (req, res) => {
    const r = await saveSettings(req.body || {}, req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ settings: r.settings, openTasks: await openCount() });
  });
}

module.exports = { KEY, MARK, getSettings, saveSettings, scan, issueOf, run, closeFixed, closeFixedFor, startSweep, registerRoutes, nextWorkingDay };
