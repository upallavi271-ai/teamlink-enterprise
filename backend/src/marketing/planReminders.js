// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PLANS > REMINDERS (2026-11-24). Nobody should have to remember when a client's plan ends or that the month's report is still to be made:
//   * RENEWAL  a bell to whoever started the plan when it ends in 30, 14 and 7 days, on its last day, and once when it has ended and is still running;
//   * REPORT   a bell in the last 3 days of the month for a plan that has no numbers saved in its monthly report yet;
//   * ONBOARDING  a bell 7 days and 14 days after the plan started if must-do steps of its onboarding checklist (onboarding.js) are still open (nothing after 60 days).
// Each reminder goes ONCE (table OmniMkPlanReminder): a plan that is first seen with 10 days left gets one bell, not two. The same facts are shown on the Client plans screen ("Needs attention", due()), so they
// are seen even when nobody looks at the bell. The bell goes to the person who started the plan (the Admins if that person is no longer active). A plan the team has ended is never reminded.
// A daily job (start(), every 6 hours, India time days; never in the sandbox). Nothing is sent outside TeamLink: no email, no WhatsApp, nothing to the client.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const CS = require('./clientServices');
const Onb = require('./onboarding');

const T = 'OmniMkPlanReminder';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "planId" TEXT NOT NULL, "kind" TEXT NOT NULL, "stepKey" TEXT NOT NULL, "at" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${T}_one" ON "${T}"("planId", "kind", "stepKey")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] plan reminder schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const STEPS = [30, 14, 7, 0];
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
const monthWords = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayWords = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// does the plan end soon? -> null, or the words of the reminder and which steps it covers ('30', '14', '7', '0' or 'overdue')
function renewalOf(view, today) {
  const days = dayDiff(view.endDate, today); if (days > 30) return null;
  const who = `${view.planLabel} plan of ${view.clientName}`;
  if (days < 0) return { kind: 'renew', keys: ['overdue'], level: 'overdue', days, title: `Client plan ended: ${view.clientName}`, message: `The ${who} ended ${plural(-days, 'day')} ago (${dayWords(view.endDate)}) and is still running here. Renew it with the client, or end the plan in AI Marketing > Client plans.` };
  const keys = STEPS.filter((s) => s >= days).map(String);
  return { kind: 'renew', keys, level: days <= 7 ? 'soon' : 'notice', days, title: days === 0 ? `Client plan ends today: ${view.clientName}` : `Client plan ends in ${plural(days, 'day')}: ${view.clientName}`,
    message: `The ${who} ends on ${dayWords(view.endDate)}. Talk to the client about renewing, or end the plan in AI Marketing > Client plans when it is over.` };
}
// the month whose report is near its end: the last `lead` days of the month (3 for the bell, 7 for the screen)
function reportMonth(today, lead) { const [y, m, d] = today.split('-').map(Number); const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); return d >= dim - (lead - 1) ? `${y}-${String(m).padStart(2, '0')}` : null; }
const runsIn = (view, month) => view.startDate <= `${month}-31` && view.endDate >= `${month}-01`;
async function reportSaved(planId, month) { // numbers saved in the monthly report (monthlyReport.js table); an empty save does not count
  try { const r = (await S.q('SELECT metrics FROM "OmniMkMonthlyMetrics" WHERE planId = ? AND month = ?', planId, month))[0]; if (!r) return false; const m = S.parse(r.metrics, {}); return Object.values(m).some((g) => g && typeof g === 'object' && Object.keys(g).length > 0); } catch { return false; }
}
function reportOf(view, month) { return { kind: 'report', keys: [month], level: 'notice', title: `Monthly report due: ${view.clientName}`, message: `The report for ${monthWords(month)} of ${view.clientName} has no numbers saved yet. Open AI Marketing > Client plans > Monthly report, type or import the real numbers, and save.` }; }

// ONBOARDING (onboarding.js): a plan that started 7 to 60 days ago and still has must-do steps open: a bell at 7 days and at 14 days
async function onboardingEvent(raw, view, today, skip) {
  if ((skip || []).includes('onboarding')) return null;
  const days = dayDiff(today, view.startDate); if (days < 7 || days > 60) return null;
  const sum = await Onb.summarize(raw); if (!sum.coreLeft) return null;
  return { kind: 'onboarding', keys: days >= 14 ? ['7', '14'] : ['7'], level: days >= 14 ? 'soon' : 'notice', days, title: `Onboarding not finished: ${view.clientName}`,
    message: `${sum.coreLeft} of the ${sum.coreTotal} must-do steps are still open, ${plural(days, 'day')} after the ${view.planLabel} plan started. Open AI Marketing > Client plans > Onboarding.` };
}

// what needs attention, for the screen (no side effect): [{ planId, clientName, kind, level, title, message }]; opts.skip: kinds to leave out (a test answers it)
async function due(u, opts = {}) {
  const today = CS.istDay(opts.now || Date.now()); const out = [];
  for (const { raw, view } of await CS.activePlans()) {
    if (u && !CS.mayDept(u, raw.department)) continue;
    const onb = await onboardingEvent(raw, view, today, opts.skip); if (onb) out.push({ planId: raw.id, clientName: view.clientName, kind: 'onboarding', level: onb.level, days: onb.days, title: onb.title, message: onb.message }); // eslint-disable-line no-await-in-loop
    const ren = renewalOf(view, today); if (ren) out.push({ planId: raw.id, clientName: view.clientName, kind: 'renew', level: ren.level, days: ren.days, title: ren.title, message: ren.message });
    const month = reportMonth(today, 7);
    if (month && runsIn(view, month) && !(await reportSaved(raw.id, month))) { const r = reportOf(view, month); out.push({ planId: raw.id, clientName: view.clientName, kind: 'report', level: r.level, month, title: r.title, message: r.message }); } // eslint-disable-line no-await-in-loop
  }
  const rank = { overdue: 0, soon: 1, notice: 2 }; return out.sort((a, b) => rank[a.level] - rank[b.level] || a.clientName.localeCompare(b.clientName));
}

async function recipients(raw) { // whoever started the plan, if still active; else the active Admins
  try {
    const prisma = require('../db'); // eslint-disable-line global-require
    if (raw.createdById) { const u = await prisma.user.findFirst({ where: { id: raw.createdById, status: 'Active' }, select: { id: true } }); if (u) return [u.id]; }
    return (await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true }, take: 10 })).map((a) => a.id);
  } catch { return []; }
}
// opts: { now, notify, recipients (a test answers these two), force (run in the sandbox), skip (kinds to leave out, for a test) }
async function sweep(opts = {}) {
  const out = { plans: 0, sent: 0, skipped: 0, noRecipient: 0 };
  if (!opts.force && require('../utils/sandbox').isSandbox()) return { ...out, sandbox: true }; // eslint-disable-line global-require
  if (!(await ensure())) return out;
  const now = opts.now || Date.now(); const today = CS.istDay(now); const notify = opts.notify || require('../utils/notify').notifyUsers; // eslint-disable-line global-require
  for (const { raw, view } of await CS.activePlans()) { // eslint-disable-line no-await-in-loop
    out.plans += 1; const events = [];
    const ren = renewalOf(view, today); if (ren) events.push(ren);
    const onb = await onboardingEvent(raw, view, today, opts.skip); if (onb) events.push(onb); // eslint-disable-line no-await-in-loop
    const month = reportMonth(today, 3); if (month && runsIn(view, month) && !(await reportSaved(raw.id, month))) events.push(reportOf(view, month)); // eslint-disable-line no-await-in-loop
    for (const ev of events) {
      const sent = new Set((await S.q(`SELECT stepKey FROM "${T}" WHERE planId = ? AND kind = ?`, raw.id, ev.kind)).map((r) => r.stepKey)); // eslint-disable-line no-await-in-loop
      if (ev.keys.every((k) => sent.has(k))) { out.skipped += 1; continue; }
      const to = await (opts.recipients || recipients)(raw); // eslint-disable-line no-await-in-loop
      if (!to.length) { out.noRecipient += 1; continue; } // nobody to tell: try again at the next sweep, do not mark it as sent
      await notify(to, { title: ev.title, message: ev.message }); // eslint-disable-line no-await-in-loop
      for (const k of ev.keys) if (!sent.has(k)) { try { await S.run(`INSERT INTO "${T}" (id, planId, kind, stepKey, at) VALUES (?,?,?,?,?)`, S.newId('prm'), raw.id, ev.kind, k, now); } catch { /* it was recorded by another sweep */ } } // eslint-disable-line no-await-in-loop
      out.sent += 1;
    }
  }
  return out;
}
let timer = null;
function start() {
  if (timer || require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  setTimeout(() => sweep().catch(() => {}), 90 * 1000).unref();
  timer = setInterval(() => { sweep().catch(() => {}); }, 6 * 3600 * 1000); if (timer.unref) timer.unref();
}
module.exports = { ensure, due, sweep, start, renewalOf, reportMonth, recipients, onboardingEvent, STEPS };
