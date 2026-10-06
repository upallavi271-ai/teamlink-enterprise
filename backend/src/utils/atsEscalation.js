// ---------------------------------------------------------------------------
// LATE WORK REACHES THE NEXT BOSS (spec 2026-10-03 §14 "Automatic reminders").
//
// Every 15 minutes (startSweep, real server only — the test sandbox runs no
// timers, so tests call runEscalation() directly):
//   due date passed               → the OWNER of the step
//   late more than tlAfterDays    → also the TEAM LEAD of the job
//   late more than managerAfterDays → also the MANAGER of the department
// (tlAfterDays 1 / managerAfterDays 2 by default — Admin settings,
// utils/atsAlertSettings.js). Stale rows (the old backlog, nothing happening
// for 30+ days) are never escalated.
//
// SWITCHED OFF BY DEFAULT and IN-APP ONLY until the user approves decision
// #6: with the switch off the sweep does nothing; when on, it writes bell
// notifications only — no email, SMS or WhatsApp.
//
// GROUPED, NOT ONE PER ITEM: each person gets at most ONE notification per
// level per day ("4 tasks in your team are late"), updated in place on the
// next run (Notification.recipient carries the key ats-escalation|level|day).
// Test logins (ZZTEST / example.test) never receive one.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const NA = require('./nextAction');
const V = require('./atsVocab');
const AS = require('./atsAlertSettings');

const CLOSED = ['REJECTED', 'JOINED', 'HIRED'];
const DAY = 86400000;
const isTest = (s) => /zztest|example\.test/i.test(String(s || ''));
const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY);
const KEY = (level, day) => `ats-escalation|${level}|${day}`;

const WORDS = {
  owner: (n) => ({ title: n === 1 ? '⏰ 1 of your tasks is late' : `⏰ ${n} of your tasks are late`, lead: 'Please finish these first:' }),
  tl: (n) => ({ title: `⏰ ${n} task${n === 1 ? '' : 's'} in your team ${n === 1 ? 'is' : 'are'} late`, lead: 'Late for more than the set days:' }),
  manager: (n) => ({ title: `⏰ ${n} task${n === 1 ? '' : 's'} in your area ${n === 1 ? 'is' : 'are'} late`, lead: 'Late for more than the set days:' }),
};

// Managers and the departments they look after.
async function managers() {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const { atsScopeOf } = require('./scope'); // eslint-disable-line global-require
  const us = await prisma.user.findMany({ where: { status: 'Active', atsRole: { in: ['MANAGER', 'ASSISTANT_MANAGER'] } }, select: { id: true, name: true, email: true, atsRole: true } });
  const out = [];
  for (const u of us.filter((x) => !isTest(`${x.name} ${x.email}`))) {
    // eslint-disable-next-line no-await-in-loop
    const id = await resolveIdentity(u.id).catch(() => null);
    if (!id) continue;
    const s = atsScopeOf(id);
    out.push({ id: u.id, name: u.name, role: u.atsRole, global: !!s.global, departments: new Set(s.departments || []) });
  }
  return out;
}

// The plan: who gets told about what. Writes nothing.
async function planEscalation({ today = NA.todayIst(), settings = null } = {}) {
  const st = settings || await AS.loadAlertSettings({ maxAgeMs: 0 });
  // fresh: people are told about late work — never from a snapshot that is
  // still being replaced (utils/nextAction.js).
  await NA.ensureNextActionContext({ fresh: true });
  const users = NA.snapshot().activeUsers || new Map();
  const apps = await prisma.application.findMany({
    where: { stage: { notIn: CLOSED } },
    select: {
      id: true, candidateId: true, requirementId: true, stage: true, createdAt: true, updatedAt: true, source: true, portalImportedAt: true,
      hiringType: true, interviewAt: true, interviewStatus: true, joiningDate: true,
      candidate: { select: { name: true } },
      requirement: { select: { title: true, department: true, recruiterId: true, recruiterIds: true, tlId: true, stlId: true, bdeId: true, internal: true, hiringType: true, client: { select: { name: true, bdeOwner: true } } } },
    },
  });
  const mgrs = await managers();
  const plan = new Map(); // `${userId}|${level}` -> { userId, level, items: [] }
  const add = (userId, level, item) => {
    if (!userId || !users.has(userId) || isTest(users.get(userId))) return;
    const k = `${userId}|${level}`;
    if (!plan.has(k)) plan.set(k, { userId, name: users.get(userId), level, items: [] });
    plan.get(k).items.push(item);
  };
  let late = 0;
  apps.forEach((a) => {
    if (V.isPreAtsApplication(a) || isTest(a.candidate && a.candidate.name)) return;
    const na = NA.nextActionFor(a, { today });
    if (na.dueStatus !== 'overdue' || !na.dueAt) return;
    late += 1;
    const daysLate = daysBetween(na.dueAt, today);
    const r = a.requirement || {};
    const item = { applicationId: a.id, candidateId: a.candidateId, candidate: a.candidate ? a.candidate.name : '—', job: r.title || '—', action: na.action, dueAt: na.dueAt, daysLate };
    add(na.ownerUserId, 'owner', item);
    if (daysLate > st.escalation.tlAfterDays) {
      const tl = r.tlId || r.stlId;
      if (tl && tl !== na.ownerUserId) add(tl, 'tl', item);
    }
    if (daysLate > st.escalation.managerAfterDays) {
      mgrs.filter((m) => m.global || (r.department && m.departments.has(r.department)))
        .forEach((m) => { if (m.id !== na.ownerUserId) add(m.id, 'manager', item); });
    }
  });
  return { today, checked: apps.length, late, groups: [...plan.values()] };
}

// One run. `force` runs even with the switch off (Admin "Run now" / tests);
// `dryRun` returns the plan and writes nothing.
async function runEscalation({ today = NA.todayIst(), force = false, dryRun = false } = {}) {
  const st = await AS.loadAlertSettings({ maxAgeMs: 0 });
  if (!st.escalation.enabled && !force) return { skipped: true, reason: 'The switch is off.' };
  const p = await planEscalation({ today, settings: st });
  let created = 0;
  let updated = 0;
  if (!dryRun) {
    for (const g of p.groups) {
      g.items.sort((x, y) => y.daysLate - x.daysLate);
      const n = g.items.length;
      const w = WORDS[g.level](n);
      const list = g.items.slice(0, 3).map((it) => `${it.candidate} — ${it.job} (${it.daysLate} day${it.daysLate === 1 ? '' : 's'} late)`).join('; ');
      const message = `${w.lead} ${list}${n > 3 ? ` and ${n - 3} more` : ''}. Open My tasks on the dashboard.`;
      const key = KEY(g.level, today);
      // eslint-disable-next-line no-await-in-loop
      const cur = await prisma.notification.findFirst({ where: { userId: g.userId, recipient: key } });
      if (cur) {
        if (cur.title !== w.title || cur.message !== message) {
          // eslint-disable-next-line no-await-in-loop
          await prisma.notification.update({ where: { id: cur.id }, data: { title: w.title, message, read: cur.read && cur.title === w.title } });
          updated += 1;
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        await prisma.notification.create({ data: { userId: g.userId, title: w.title, message, channel: 'In-App', recipient: key, status: 'Sent' } });
        created += 1;
      }
    }
    const summary = { at: new Date().toISOString(), late: p.late, people: p.groups.length, created, updated };
    await AS.saveAlertSettings({ escalation: { lastRunAt: summary.at, lastRun: summary } }, { system: true }).catch(() => null);
  }
  return {
    today: p.today, checked: p.checked, late: p.late, created, updated, dryRun: !!dryRun,
    groups: p.groups.map((g) => ({ userId: g.userId, name: g.name, level: g.level, count: g.items.length })),
  };
}

let TIMER = null;
let RUNNING = false;
function startSweep() {
  const ms = Number(process.env.ATS_ESCALATION_SWEEP_MS || 15 * 60000);
  if (!ms || TIMER) return;
  TIMER = setInterval(async () => {
    if (RUNNING) return;
    RUNNING = true;
    try { await runEscalation(); } catch (err) { console.error('[atsEscalation]', err.message); } finally { RUNNING = false; } // eslint-disable-line no-console
  }, ms);
  if (TIMER.unref) TIMER.unref();
}

module.exports = { planEscalation, runEscalation, startSweep, KEY };
