// ---------------------------------------------------------------------------
// EMPLOYEE MONITORING - ALERTS (2026-11-05, module 6 of the founder's plan). Off until HR switches them on (Settings).
//
//   Long idle       the PC has been idle this long without a break        (default 30 minutes)
//   Agent stopped   the employee pressed Stop recording in work hours
//   No signal       the PC was working today and has gone silent           (default 15 minutes)
//                   or nothing came from it an hour into the work day. It cannot tell a PC switched off from an agent removed:
//                   the alert says so, and the person looks.
//   Low activity    after work: active hours under the limit               (default 4 hours)
//   Unauthorized    an app or website on HR's list was used                (Settings; the list starts empty)
//
// Who hears: the employee's team lead (the approval chain) and HR, by the bell, and by mail when HR switched that on and company mail
// is connected. Agent stopped and No signal go to the IT Admins too. Each kind at most once a day per person. Nothing on a holiday or
// weekly off, on approved leave, in the lunch break, for someone who clocked out, is on a break or is not monitored. Each person is
// checked against their own rules: a department's or their own work hours, and a night shift counts as the day it started on.
// Runs every 5 minutes (startSweep); the sandbox runs no timers.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const M = require('./monitoring');

const WORD = { idle: 'Long idle', stopped: 'Agent stopped', offline: 'No signal', low: 'Low activity', unauthorized: 'Unauthorized app' };
const DEVICE_KINDS = ['stopped', 'offline'];

// the idle time at the very end of the day's records (a break or real work ends it)
function trailingIdleSeconds(logs) {
  let sec = 0;
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    if (!logs[i].isIdle || logs[i].isBreak) break;
    sec += logs[i].durationSeconds;
  }
  return sec;
}

async function recipients(employee, lad) {
  const workflow = require('./approvalWorkflow'); // eslint-disable-line global-require
  try {
    const chain = await workflow.resolveChain(employee, lad);
    const lead = ['TL', 'STL', 'ASSISTANT_MANAGER', 'MANAGER'].map((l) => chain[l]).find((p) => p && p.user && p.user.id && p.user.id !== employee.userId);
    const hr = chain.HR && chain.HR.user && chain.HR.user.id !== employee.userId ? chain.HR.user.id : null;
    return [lead && lead.user.id, hr].filter(Boolean);
  } catch { return []; }
}

// The alerts due now, without writing anything: [{ employeeId, kind, day, detail }]
async function scan(now = Date.now(), s = null) {
  const cfg = s || await M.settings();
  const WD = require('./workingDays'); // eslint-disable-line global-require
  await WD.ready().catch(() => {});
  const today = M.istDay(now);
  const yesterday = M.addDays(today, -1);
  const [devices, logs, leaves, catOf, rules] = await Promise.all([
    prisma.monitoringDevice.findMany({ where: { isActive: true, approved: true, employee: { employmentStatus: { notIn: ['Exited', 'Relieved', 'Terminated'] } } }, select: { employeeId: true, lastSeenAt: true, pausedState: true, employee: { select: { id: true, department: true } } } }),
    prisma.activityLog.findMany({ where: { day: { in: [yesterday, today] } }, orderBy: { startTime: 'asc' }, select: { employeeId: true, appName: true, windowTitle: true, durationSeconds: true, isIdle: true, isBreak: true, startTime: true, endTime: true, day: true } }),
    // leave still waiting for approval counts too: somebody who applied for today is not "missing" (founder 2026-11-14)
    prisma.leaveRequest.findMany({ where: { status: { in: ['Approved', 'Pending'] }, fromDate: { lte: today }, toDate: { gte: yesterday } }, select: { employeeId: true, fromDate: true, toDate: true } }),
    M.categoryIndex(), M.overrideIndex(),
  ]);
  const banned = String(cfg.unauthorizedApps || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const latest = new Map();
  devices.forEach((d) => { const c = latest.get(d.employeeId); if (!c || new Date(d.lastSeenAt || 0) > new Date(c.lastSeenAt || 0)) latest.set(d.employeeId, d); });
  const out = [];
  latest.forEach((d, employeeId) => {
    const mineRules = M.effective(cfg, rules, d.employee);
    if (mineRules.excluded) return;
    const day = M.shiftDay(now, mineRules);
    if (!WD.isWorking(day)) return;
    if (leaves.some((l) => l.employeeId === employeeId && day >= l.fromDate && day <= l.toDate)) return;
    const ws = M.atShift(day, mineRules.workStart, mineRules).getTime();
    const we = M.atShift(day, mineRules.workEnd, mineRules).getTime();
    if (now < ws) return;
    const hm = M.hmOf(now);
    const lunch = M.inBreakNow(mineRules, day, hm); // the lunch break, or the weekly (Saturday) break: no stopped / offline / idle alert while it lasts
    const mine = logs.filter((l) => l.employeeId === employeeId && l.day === day);
    const seen = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
    const seenToday = seen >= ws;
    const add = (kind, detail) => out.push({ employeeId, kind, day, detail });
    if (now < we && !lunch) {
      if (d.pausedState === 'stopped' && seenToday) add('stopped', `Recording was stopped on the PC at ${M.istTime(seen)}.`);
      else if (!d.pausedState) {
        const silent = Math.round((now - seen) / 60000);
        if (seenToday && silent >= cfg.offlineMinutes) add('offline', `No signal from the PC since ${M.istTime(seen)}. The PC may be off, or the agent may have stopped.`);
        else if (!seenToday && now - ws >= 3600000) add('offline', 'No signal from the PC today. The PC may be off, or the agent may have stopped.');
        const idleMin = Math.round(trailingIdleSeconds(mine) / 60);
        if (idleMin >= cfg.longIdleMinutes) add('idle', `Idle for ${idleMin} minutes.`);
      }
    }
    if (banned.length) {
      const hit = mine.find((l) => !l.isIdle && !l.isBreak && banned.some((w) => String(l.appName).toLowerCase().includes(w) || String(l.windowTitle || '').toLowerCase().includes(w)));
      if (hit) add('unauthorized', `Used ${banned.find((w) => String(hit.appName).toLowerCase().includes(w) || String(hit.windowTitle || '').toLowerCase().includes(w))} at ${M.istTime(hit.startTime)}.`);
    }
    if (now >= we && mine.length) {
      const t = M.totalsOf(mine, catOf, d.employee.department || '');
      if (t.activeHours < cfg.lowActivityHours) add('low', `Active for ${t.activeHours} hours today (the limit is ${cfg.lowActivityHours}).`);
    }
  });
  return out;
}

// Writes the new alerts and rings the bell. A person's alert of a kind comes once a day (the table's unique key).
async function run(now = Date.now()) {
  const s = await M.settings();
  if (!s.alertsEnabled) return { created: 0, off: true };
  const due = await scan(now, s);
  if (!due.length) return { created: 0 };
  const have = await prisma.monitoringAlert.findMany({ where: { day: { in: [...new Set(due.map((a) => a.day))] } }, select: { employeeId: true, kind: true, day: true } });
  const seen = new Set(have.map((a) => `${a.employeeId}|${a.kind}|${a.day}`));
  const fresh = due.filter((a) => !seen.has(`${a.employeeId}|${a.kind}|${a.day}`));
  if (!fresh.length) return { created: 0 };
  const lad = await require('./approvalWorkflow').ladder().catch(() => null); // eslint-disable-line global-require
  const { notifyUsers } = require('./notify'); // eslint-disable-line global-require
  const itIds = String(s.itAdminIds || '').split(',').filter(Boolean);
  const itUsers = itIds.length ? (await prisma.employee.findMany({ where: { id: { in: itIds }, userId: { not: null } }, select: { userId: true } })).map((e) => e.userId) : [];
  let created = 0;
  for (const a of fresh) {
    // eslint-disable-next-line no-await-in-loop
    const emp = await prisma.employee.findUnique({ where: { id: a.employeeId } });
    if (!emp) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const row = await prisma.monitoringAlert.create({ data: { id: crypto.randomUUID(), employeeId: a.employeeId, kind: a.kind, day: a.day, detail: a.detail } }).catch(() => null);
    if (!row) continue; // eslint-disable-line no-continue
    created += 1;
    // eslint-disable-next-line no-await-in-loop
    const to = [...new Set([...(await recipients(emp, lad)), ...(DEVICE_KINDS.includes(a.kind) ? itUsers : [])])];
    const title = `🖥️ ${WORD[a.kind]}: ${emp.name}`;
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(to, { title, message: `${a.detail}\nOpen: /monitoring?tab=alerts` }).catch(() => {});
    if (s.alertEmail && to.length) {
      // eslint-disable-next-line no-await-in-loop
      const people = await prisma.user.findMany({ where: { id: { in: to }, status: 'Active' }, select: { email: true } });
      const list = people.map((u) => u.email).filter(Boolean);
      // eslint-disable-next-line no-await-in-loop
      if (list.length) await require('./mailer').sendMail({ to: list.join(', '), subject: `TeamLink: ${WORD[a.kind]}, ${emp.name}`, text: `${emp.name}: ${a.detail}\n\nHRMS -> Employee Monitoring -> Alerts.`, useEmployeeFrom: false, fromName: 'TeamLink' }).catch(() => {}); // eslint-disable-line global-require
    }
  }
  return { created };
}

// The Alerts tab
async function list(from, to, access = null) {
  const rows = await prisma.monitoringAlert.findMany({
    where: { day: { gte: from, lte: to }, ...(access && access.ids ? { employeeId: { in: access.ids } } : {}) },
    orderBy: { createdAt: 'desc' }, take: 1000,
    select: { id: true, kind: true, day: true, detail: true, createdAt: true, employee: { select: { id: true, name: true, employeeCode: true, department: true } } },
  });
  return { from, to, kinds: WORD, rows: rows.map((r) => ({ id: r.id, kind: r.kind, word: WORD[r.kind] || r.kind, day: r.day, detail: r.detail, at: r.createdAt, employeeId: r.employee.id, name: r.employee.name, code: r.employee.employeeCode, department: r.employee.department })) };
}

let TIMER = null;
function startSweep() {
  if (require('./sandbox').isSandbox() || TIMER) return; // eslint-disable-line global-require
  const tick = () => run().then((r) => { if (r.created) console.log(`[monitoring] ${r.created} alert(s)`); }).catch((e) => console.error('[monitoring alerts]', e.message)) // eslint-disable-line no-console
    .then(() => require('./monitoringLinks').sendScheduled()).catch((e) => console.error('[monitoring mail]', e.message)); // eslint-disable-line global-require, no-console
  TIMER = setInterval(tick, 5 * 60000);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  WORD, trailingIdleSeconds, scan, run, list, startSweep,
};
