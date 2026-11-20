// ---------------------------------------------------------------------------
// TARGETS, CARRY-OVER, EOD COMPLIANCE, PERFORMANCE SCORE, LEADERBOARD, COST VS REVENUE
// (Audit 199 / 203 / 332 / 333 / 334 / 344 / 345 / 347 / 348 / 349 / 364, Extra P7.3).
//
// NO SECOND COUNT. Every "done" figure is the Daily report's own event (utils/dailyReport.js eventsIn: Calls, Added = profiles sourced,
// Profiles verified, Sent to client = submissions, Interviews, Joined). Joined is the joinings credited by utils/recruiterJoinings.js
// creditedJoinings (the dashboard card's function), so reports and the card always agree.
//
// TARGETS reuse the existing storage: the HRMS Monthly Targets (EmployeeRecord type TARGET, the rows the dashboard and Results vs target already
// read) stay the monthly source. A daily / weekly / monthly target a TL or Admin types here is kept in AtsWorkTarget; one rate per working day is
// worked out from whatever is set (daily wins, then weekly, then monthly) and scaled to the window shown, so the three views always agree.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const core = require('./core');
const cal = require('./calendar');
const DR = require('../dailyReport');
const { atsViewRole } = require('../scope');
const { logAudit } = require('../audit');

const METRICS = [
  { key: 'calls', label: 'Calls', src: 'calls' },
  { key: 'sourced', label: 'Profiles sourced', src: 'added' },
  { key: 'verified', label: 'Profiles verified', src: 'verified' },
  { key: 'submissions', label: 'Submissions', src: 'sentClient' },
  { key: 'interviews', label: 'Interviews', src: 'interviews' },
  { key: 'joinings', label: 'Joinings', src: 'joined' },
];
const PERIODS = ['DAILY', 'WEEKLY', 'MONTHLY'];
const HRMS_RULES = [
  { key: 'verified', re: /verif|screen/i }, { key: 'submissions', re: /submi|sent to client|shar|cv|profile/i }, { key: 'joinings', re: /join|placement|hire/i },
  { key: 'interviews', re: /interview/i }, { key: 'calls', re: /call/i }, { key: 'sourced', re: /add|sourc|candidate/i },
];
const LEAD_VIEWS = ['admin', 'mgmt', 'stl', 'tl'];
const WEEK_DAYS = 6; // a nominal working week, to turn a weekly target into a per-day rate

const today = () => DR.todayIst();
const plus = (d, n) => DR.addDays(d, n);
const mondayOf = (d) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return plus(d, -((w + 6) % 7)); };
const monthOf = (d) => d.slice(0, 7);
const monthBounds = (m) => { const [y, mo] = m.split('-').map(Number); return { from: `${m}-01`, to: `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}` }; };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function bounds(period, date) {
  const d = DAY_RE.test(String(date || '')) ? date : today();
  if (period === 'DAILY') return { from: d, to: d, label: d };
  if (period === 'WEEKLY') { const f = mondayOf(d); return { from: f, to: plus(f, 6), label: `Week of ${f}` }; }
  const m = monthBounds(monthOf(d));
  return { ...m, label: monthOf(d) };
}
const workdays = (from, to) => { let n = 0; for (let d = from; d <= to; d = plus(d, 1)) if (cal.isWorkingDay(d)) n += 1; return n; };

// ------------------------------------------------------------------ the targets themselves
async function setTargets(userId, period, values, by) {
  if (!PERIODS.includes(period)) return { error: 'Pick Daily, Weekly or Monthly.' };
  const user = await prisma.user.findUnique({ where: { id: String(userId) }, select: { id: true, name: true } });
  if (!user) return { error: 'Person not found.' };
  const saved = {};
  for (const m of METRICS) {
    if (!(m.key in (values || {}))) continue;
    const raw = values[m.key];
    if (raw === '' || raw === null) { await core.x('DELETE FROM "AtsWorkTarget" WHERE "userId" = ? AND "period" = ? AND "metric" = ?', user.id, period, m.key); saved[m.key] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > 100000) return { error: `${m.label}: write a number from 0 upward.` };
    await core.x('INSERT OR REPLACE INTO "AtsWorkTarget" ("userId","period","metric","value","setById","setByName","updatedAt") VALUES (?,?,?,?,?,?,?)', user.id, period, m.key, v, by.id, by.name, core.nowIso());
    saved[m.key] = v;
  }
  await logAudit({ userId: by.id, actorName: by.name, action: `${period.toLowerCase()} targets set`, entity: 'User', entityId: user.id, toValue: JSON.stringify(saved), reason: `For ${user.name}` });
  return { ok: true, userId: user.id, name: user.name, period, saved };
}

async function loadTargets(userIds, month) {
  const out = new Map(userIds.map((id) => [id, { explicit: { DAILY: {}, WEEKLY: {}, MONTHLY: {} }, hrms: {} }]));
  if (!userIds.length) return out;
  const rows = await core.q(`SELECT * FROM "AtsWorkTarget" WHERE "userId" IN (${userIds.map(() => '?').join(',')})`, ...userIds);
  rows.forEach((r) => { const o = out.get(r.userId); if (o && o.explicit[r.period]) o.explicit[r.period][r.metric] = Number(r.value); });
  const emps = await prisma.employee.findMany({ where: { userId: { in: userIds } }, select: { id: true, userId: true } });
  const byEmp = new Map(emps.map((e) => [e.id, e.userId]));
  if (emps.length) {
    const recs = await prisma.employeeRecord.findMany({ where: { type: 'TARGET', employeeId: { in: emps.map((e) => e.id) }, date: { startsWith: month } }, select: { employeeId: true, title: true, unit: true, amount: true } });
    recs.forEach((r) => {
      const rule = HRMS_RULES.find((t) => t.re.test(`${r.unit || ''} ${r.title || ''}`));
      if (!rule || !(Number(r.amount) > 0)) return;
      const o = out.get(byEmp.get(r.employeeId));
      if (o) o.hrms[rule.key] = (o.hrms[rule.key] || 0) + Number(r.amount);
    });
  }
  return out;
}

// target for a window: one rate per working day from what is set (daily, else weekly, else monthly), times the working days in the window.
function targetFor(t, metric, from, to) {
  if (!t) return { value: null, source: null };
  const wd = workdays(from, to);
  const ex = t.explicit;
  let rate = null; let source = null;
  if (ex.DAILY[metric] !== undefined) { rate = ex.DAILY[metric]; source = 'set daily'; }
  else if (ex.WEEKLY[metric] !== undefined) { rate = ex.WEEKLY[metric] / WEEK_DAYS; source = 'set weekly'; }
  else {
    const monthly = ex.MONTHLY[metric] !== undefined ? ex.MONTHLY[metric] : t.hrms[metric];
    if (monthly !== undefined) {
      const mb = monthBounds(monthOf(from));
      const mwd = Math.max(1, workdays(mb.from, mb.to));
      if (from === mb.from && to === mb.to) return { value: monthly, source: ex.MONTHLY[metric] !== undefined ? 'set monthly' : 'HRMS monthly target' };
      rate = monthly / mwd; source = 'worked out from the monthly target';
    }
  }
  if (rate === null) return { value: null, source: null };
  if (ex.DAILY[metric] !== undefined && from === to) return { value: wd ? rate : 0, source };
  if (ex.WEEKLY[metric] !== undefined && to === plus(from, 6) && new Date(`${from}T00:00:00Z`).getUTCDay() === 1) return { value: ex.WEEKLY[metric], source };
  return { value: Math.ceil(Math.round(rate * wd * 100) / 100), source };
}

// ------------------------------------------------------------------ EOD
async function eodConfirmed(userIds, from, to) {
  if (!userIds.length) return new Map();
  const rows = await core.q(`SELECT "userId","day","confirmedAt" FROM "AtsEodConfirm" WHERE "userId" IN (${userIds.map(() => '?').join(',')}) AND "day" >= ? AND "day" <= ?`, ...userIds, from, to);
  const m = new Map();
  rows.forEach((r) => { if (!m.has(r.userId)) m.set(r.userId, new Map()); m.get(r.userId).set(r.day, r.confirmedAt); });
  return m;
}
// { due, done, pct } for a window: working days that are over (today only once it is confirmed)
function eodStat(map, userId, from, to) {
  const last = to < today() ? to : plus(today(), -1);
  let due = 0; let done = 0;
  const mine = map.get(userId) || new Map();
  for (let d = from; d <= last; d = plus(d, 1)) { if (cal.isWorkingDay(d)) { due += 1; if (mine.has(d)) done += 1; } }
  if (mine.has(today()) && today() >= from && today() <= to) { due += 1; done += 1; }
  return { due, done, pct: due ? Math.round((done * 100) / due) : null };
}

async function myEod(user, day = today()) {
  const out = await DR.dayReport(user, { day });
  const body = out.body || {};
  const [row] = await core.q('SELECT * FROM "AtsEodConfirm" WHERE "userId" = ? AND "day" = ?', user.id, day);
  const mine = (body.people || []).find((p) => p.key === `u:${user.id}`) || {};
  const totals = {};
  DR.METRICS.filter((m) => m.key !== 'pending').forEach((m) => { totals[m.key] = mine[m.key] || 0; });
  return { day, totals, labels: Object.fromEntries(DR.METRICS.map((m) => [m.key, m.label])), confirmedAt: row ? row.confirmedAt : null, canConfirm: !row && day <= today() };
}
async function confirmEod(user, day = today(), note = null) {
  if (!DAY_RE.test(String(day)) || day > today()) return { error: 'Pick today or an earlier day.' };
  const first = await core.x('INSERT OR IGNORE INTO "AtsEodConfirm" ("userId","day","confirmedAt","note") VALUES (?,?,?,?)', user.id, day, core.nowIso(), note ? String(note).slice(0, 300) : null);
  const eod = await myEod(user, day);
  if (Number(first) > 0) {
    try {
      const emp = await prisma.employee.findFirst({ where: { userId: user.id }, select: { tl: true } });
      const tl = emp && emp.tl ? await prisma.user.findFirst({ where: { name: emp.tl, status: 'Active' }, select: { id: true } }) : null;
      if (tl) await require('../notify').notifyUsers([tl.id], { title: `${user.name} sent the end-of-day report`, message: `Day ${day}: ${eod.totals.calls || 0} calls, ${eod.totals.sentClient || 0} sent to client, ${eod.totals.interviews || 0} interviews.` });
    } catch { /* the confirmation is saved; a bell that did not ring is not a failure */ }
  }
  return { ok: true, already: Number(first) === 0, ...eod };
}

// ------------------------------------------------------------------ the results context
async function loadCtx(viewer, from, to) {
  const acc = DR.access(viewer);
  if (!acc.ok) return { error: acc.error };
  const world = await DR.worldFor(viewer);
  const last = to > today() ? today() : to;
  const events = from > today() ? [] : await DR.eventsIn(viewer, world, from, last);
  let keys = acc.selfOnly ? [`u:${viewer.id}`] : [...world.people.keys()];
  keys = keys.filter((k) => k.startsWith('u:') && !((world.people.get(k) || {}).former));
  return { world, events, keys, acc };
}

async function rowsFor(ctx, from, to, period, { eodMap, tmap, only = null } = {}) {
  const month = monthOf(from);
  const mine = ctx.events.filter((e) => e.day >= from && e.day <= to);
  const per = new Map();
  mine.forEach((e) => {
    if (!per.has(e.person.key)) per.set(e.person.key, {});
    const c = per.get(e.person.key); c[e.metric] = (c[e.metric] || 0) + 1;
  });
  const targets = tmap || await loadTargets(ctx.keys.map((k) => k.slice(2)), month);
  const hasTarget = (id) => { const t = targets.get(id); return !!t && (Object.values(t.explicit).some((o) => Object.keys(o).length) || Object.keys(t.hrms).length); };
  let keys = ctx.keys.filter((k) => per.has(k) || hasTarget(k.slice(2)));
  if (only) keys = keys.filter((k) => only.has(k));
  const ids = keys.map((k) => k.slice(2));
  const weights = (await core.load()).weights;
  const eod = eodMap || await eodConfirmed(ids, from, to);
  const rows = keys.map((k) => {
    const id = k.slice(2); const c = per.get(k) || {};
    const metrics = {};
    METRICS.forEach((m) => {
      const t = targetFor(targets.get(id), m.key, from, to);
      const done = c[m.src] || 0;
      metrics[m.key] = { done, target: t.value, source: t.source, pct: t.value ? Math.min(999, Math.round((done * 100) / t.value)) : null };
    });
    const e = eodStat(eod, id, from, to);
    const score = scoreOf(metrics, e, weights);
    return { key: k, userId: id, name: (ctx.world.people.get(k) || {}).label || id, metrics, offers: c.offers || 0, eod: e, score: score.score, scoreParts: score.parts };
  });
  return rows;
}

const attain = (m) => (m && m.target > 0 ? Math.min(1, m.done / m.target) : null);
function scoreOf(metrics, eod, weights) {
  const mean = (list) => { const v = list.filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const comps = [
    { key: 'joinings', label: 'Joinings', weight: weights.joinings, v: attain(metrics.joinings) },
    { key: 'submissions', label: 'Submissions', weight: weights.submissions, v: attain(metrics.submissions) },
    { key: 'interviews', label: 'Interviews', weight: weights.interviews, v: attain(metrics.interviews) },
    { key: 'activity', label: 'Calls and sourcing', weight: weights.activity, v: mean([attain(metrics.calls), attain(metrics.sourced), attain(metrics.verified)]) },
    { key: 'eod', label: 'End-of-day reports', weight: weights.eod, v: eod && eod.pct !== null ? eod.pct / 100 : null },
  ];
  const used = comps.filter((c) => c.v !== null && c.weight > 0);
  const wsum = used.reduce((a, c) => a + c.weight, 0);
  const score = wsum ? Math.round((used.reduce((a, c) => a + c.weight * c.v, 0) / wsum) * 100) : null;
  return { score, parts: comps.map((c) => ({ key: c.key, label: c.label, weight: c.weight, pct: c.v === null ? null : Math.round(c.v * 100) })) };
}

// ------------------------------------------------------------------ the screen: results vs target (+ score)
async function results(viewer, { period = 'MONTHLY', date = null } = {}) {
  const P = PERIODS.includes(period) ? period : 'MONTHLY';
  await cal.refresh().catch(() => null);
  const b = bounds(P, date);
  const ctx = await loadCtx(viewer, b.from, b.to);
  if (ctx.error) return { status: 403, error: ctx.error };
  const rows = await rowsFor(ctx, b.from, b.to, P);
  const ids = rows.map((r) => r.userId);
  const reviews = ids.length ? await prisma.performanceReview.findMany({ where: { employee: { userId: { in: ids } } }, orderBy: { createdAt: 'desc' }, select: { score: true, period: true, employee: { select: { userId: true } } } }) : [];
  const typed = new Map();
  reviews.forEach((r) => { if (!typed.has(r.employee.userId)) typed.set(r.employee.userId, { score: r.score, period: r.period }); });
  rows.forEach((r) => { r.reviewerScore = typed.get(r.userId) || null; });
  rows.sort((a, b2) => (b2.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b2.name));
  const set = ctx.acc.selfOnly ? [] : rows.filter((r) => Object.values(r.metrics).every((m) => m.target === null)).length;
  return {
    status: 200, period: P, ...b, metrics: METRICS.map(({ key, label }) => ({ key, label })), rows, selfOnly: ctx.acc.selfOnly,
    noTargetCount: set, canSet: LEAD_VIEWS.includes(atsViewRole(viewer)),
    note: 'Done = the Daily report\'s own counts (Joinings = the joinings credited by the dashboard card). A target is the one set for this view, else worked out from the daily / weekly / monthly one.',
  };
}

async function targetsOf(viewer, userId) {
  const view = atsViewRole(viewer);
  if (!LEAD_VIEWS.includes(view) && userId !== viewer.id) return { status: 403, error: 'Targets are set by the team lead or an Admin.' };
  const t = (await loadTargets([userId], monthOf(today()))).get(userId);
  return { status: 200, userId, explicit: t.explicit, hrms: t.hrms, metrics: METRICS.map(({ key, label }) => ({ key, label })) };
}

// ------------------------------------------------------------------ underperformers (Audit 347)
async function lastWeeks(n) { const m0 = mondayOf(today()); return Array.from({ length: n }, (_, i) => { const f = plus(m0, -7 * (n - i)); return { from: f, to: plus(f, 6) }; }); }
async function weeklyTable(viewer, weeksN, only = null) {
  await cal.refresh().catch(() => null);
  const weeks = await lastWeeks(weeksN);
  const ctx = await loadCtx(viewer, weeks[0].from, weeks[weeks.length - 1].to);
  if (ctx.error) return { error: ctx.error };
  const out = new Map();
  for (const w of weeks) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await rowsFor(ctx, w.from, w.to, 'WEEKLY', { only });
    rows.forEach((r) => { if (!out.has(r.key)) out.set(r.key, { key: r.key, userId: r.userId, name: r.name, weeks: [] }); out.get(r.key).weeks.push({ from: w.from, score: r.score }); });
  }
  return { weeks, people: [...out.values()], ctx };
}
async function underperformers(viewer) {
  const view = atsViewRole(viewer);
  if (!LEAD_VIEWS.includes(view)) return { status: 403, error: 'The underperformer list is for team leads, managers and admins.' };
  const s = (await core.load()).underperformer;
  if (!s.enabled) return { status: 200, enabled: false, rows: [], settings: s };
  const t = await weeklyTable(viewer, s.weeks);
  if (t.error) return { status: 403, error: t.error };
  const rows = t.people.filter((p) => p.weeks.length === s.weeks && p.weeks.every((w) => w.score !== null && w.score < s.threshold))
    .map((p) => ({ userId: p.userId, name: p.name, weeks: p.weeks, average: Math.round(p.weeks.reduce((a, w) => a + w.score, 0) / p.weeks.length) }));
  rows.sort((a, b) => a.average - b.average);
  return { status: 200, enabled: true, settings: s, weeksChecked: t.weeks, rows };
}

// ------------------------------------------------------------------ leaderboard (Audit 348)
let SYSTEM_VIEWER = null;
async function systemViewer() {
  if (SYSTEM_VIEWER && Date.now() - SYSTEM_VIEWER.at < 600000) return SYSTEM_VIEWER.user;
  const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true } });
  const user = sa ? await require('../identity').resolveIdentity(sa.id) : null;
  SYSTEM_VIEWER = { at: Date.now(), user };
  return user;
}
async function peersOf(userId) {
  const emp = await prisma.employee.findFirst({ where: { userId }, select: { tl: true, department: true } });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { atsDepartment: true } });
  const dept = (u && u.atsDepartment) || (emp && emp.department) || null;
  const tl = emp && emp.tl ? emp.tl : null;
  const mates = await prisma.employee.findMany({
    where: { userId: { not: null }, ...(tl ? { tl } : (dept ? { department: dept } : { userId: userId })) }, select: { userId: true },
  });
  return new Set([userId, ...mates.map((m) => m.userId)].map((id) => `u:${id}`));
}
async function leaderboard(viewer, { period = 'MONTHLY', date = null } = {}) {
  const view = atsViewRole(viewer);
  const s = await core.load();
  const P = PERIODS.includes(period) ? period : 'MONTHLY';
  const b = bounds(P, date);
  await cal.refresh().catch(() => null);
  let ctxViewer = viewer; let only = null; let limited = false;
  if (!LEAD_VIEWS.includes(view)) {
    if (!['recruiter'].includes(view)) return { status: 403, error: 'The leaderboard is for the recruitment team.' };
    if (!s.leaderboard.recruitersSee) return { status: 200, hidden: true, message: 'The leaderboard is switched off for recruiters.', rows: [] };
    ctxViewer = await systemViewer();
    if (!ctxViewer) return { status: 200, rows: [], message: 'No ranking yet.' };
    only = await peersOf(viewer.id); limited = true;
  }
  const ctx = await loadCtx(ctxViewer, b.from, b.to);
  if (ctx.error) return { status: 403, error: ctx.error };
  let rows = await rowsFor(ctx, b.from, b.to, P, { only });
  if (limited) rows = rows.filter((r) => only.has(r.key));
  rows.sort((a, c) => (c.score ?? -1) - (a.score ?? -1) || c.metrics.joinings.done - a.metrics.joinings.done || c.metrics.submissions.done - a.metrics.submissions.done || a.name.localeCompare(c.name));
  let rank = 0; let prev = null;
  rows.forEach((r, i) => { const sig = `${r.score}|${r.metrics.joinings.done}`; if (sig !== prev) { rank = i + 1; prev = sig; } r.rank = rank; });
  const mine = rows.find((r) => r.userId === viewer.id) || null;
  const shape = (r) => (limited
    ? { rank: r.rank, name: r.name, score: r.score, joinings: r.metrics.joinings.done, you: r.userId === viewer.id }
    : { rank: r.rank, userId: r.userId, name: r.name, score: r.score, joinings: r.metrics.joinings.done, submissions: r.metrics.submissions.done, interviews: r.metrics.interviews.done, you: r.userId === viewer.id });
  return {
    status: 200, period: P, ...b, ranked: rows.length, you: mine ? { rank: mine.rank, score: mine.score, of: rows.length } : null,
    scope: limited ? 'Your team' : 'Everyone you can see', rows: rows.map(shape),
  };
}

// ------------------------------------------------------------------ offer-to-joining (Audit 364)
async function offerToJoining(viewer, { period = 'MONTHLY', date = null } = {}) {
  const P = PERIODS.includes(period) ? period : 'MONTHLY';
  const b = bounds(P, date);
  const ctx = await loadCtx(viewer, b.from, b.to);
  if (ctx.error) return { status: 403, error: ctx.error };
  const keys = new Set(ctx.keys);
  const mine = ctx.events.filter((e) => e.day >= b.from && e.day <= b.to && keys.has(e.person.key));
  const per = new Map();
  mine.forEach((e) => {
    if (e.metric !== 'offers' && e.metric !== 'joined') return;
    const r = per.get(e.person.key) || { name: e.person.label, offers: 0, joined: 0 }; r[e.metric] += 1; per.set(e.person.key, r);
  });
  const rows = [...per.values()].map((r) => ({ ...r, ratio: r.offers ? Math.round((r.joined * 100) / r.offers) : null }));
  const offers = rows.reduce((a, r) => a + r.offers, 0); const joined = rows.reduce((a, r) => a + r.joined, 0);
  return { status: 200, ...b, offers, joined, ratio: offers ? Math.round((joined * 100) / offers) : null, rows: rows.sort((a, c) => c.offers - a.offers) };
}

// ------------------------------------------------------------------ cost vs revenue (Audit 344) - Admin and Accounts only
async function costRevenue(viewer, { month = null } = {}) {
  const sc = require('../scope').scopeOf(viewer);
  const allowed = sc.global || ['SUPER_ADMIN', 'ADMIN'].includes(viewer.role) || sc.accountsRole === 'ACCOUNTANT';
  if (!allowed) return { status: 403, error: 'Cost and revenue per employee is for Admin and Accounts only.' };
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : monthOf(today());
  const sysViewer = await systemViewer();
  const RJ = require('../recruiterJoinings');
  const cj = await RJ.creditedJoinings(sysViewer || viewer, { month: m, level: 'all', fresh: true });
  const apps = cj.appIds.length ? await prisma.application.findMany({ where: { id: { in: cj.appIds } }, select: { id: true, candidateId: true, requirementId: true } }) : [];
  const inv = apps.length ? await prisma.invoice.findMany({ where: { status: { not: 'Cancelled' }, requirementId: { in: [...new Set(apps.map((a) => a.requirementId))] }, candidateId: { in: [...new Set(apps.map((a) => a.candidateId))] } }, select: { candidateId: true, requirementId: true, amount: true } }) : [];
  const revOfApp = new Map();
  apps.forEach((a) => { revOfApp.set(a.id, inv.filter((i) => i.candidateId === a.candidateId && i.requirementId === a.requirementId).reduce((s, i) => s + (Number(i.amount) || 0), 0)); });
  const per = new Map();
  cj.list.forEach((a) => {
    const c = a.creditedTo || {}; if (!c.userId) return;
    const r = per.get(c.userId) || { userId: c.userId, name: c.name, joinings: 0, revenue: 0 };
    r.joinings += 1; r.revenue += revOfApp.get(a.id) || 0; per.set(c.userId, r);
  });
  const ids = [...per.keys()];
  const sal = ids.length ? await prisma.salaryStructure.findMany({ where: { employee: { userId: { in: ids } } }, select: { payMode: true, ctc: true, stipend: true, employee: { select: { userId: true } } } }) : [];
  const costOf = new Map(sal.map((s) => [s.employee.userId, s.payMode === 'Stipend' ? Number(s.stipend) || 0 : (Number(s.ctc) || 0) / 12]));
  const rows = [...per.values()].map((r) => {
    const cost = costOf.has(r.userId) && costOf.get(r.userId) > 0 ? Math.round(costOf.get(r.userId)) : null;
    return { ...r, revenue: Math.round(r.revenue), cost, costNote: cost === null ? 'cost not set' : null, net: cost === null ? null : Math.round(r.revenue - cost), ratio: cost ? Math.round((r.revenue / cost) * 10) / 10 : null };
  }).sort((a, b) => b.revenue - a.revenue);
  return { status: 200, month: m, rows, note: 'Revenue = placement invoices (before GST) of the joinings credited to the person that month. Cost = one month of the salary the HRMS payroll holds (CTC / 12, or the stipend).' };
}

// ------------------------------------------------------------------ carry-over (Audit 203)
async function carryOver(user) {
  await cal.refresh().catch(() => null);
  const t = today();
  let prev = plus(t, -1); let guard = 0;
  while (!cal.isWorkingDay(prev) && guard < 15) { prev = plus(prev, -1); guard += 1; }
  const paused = new Set((await core.q('SELECT "requirementId" FROM "AtsRequirementPause" WHERE "resumedAt" IS NULL')).map((r) => r.requirementId));
  const fus = await prisma.applicationFollowUp.findMany({
    where: { ownerUserId: user.id, completedAt: null, dueDate: { lte: prev } }, orderBy: { dueDate: 'asc' }, take: 100,
    select: { id: true, nextAction: true, dueDate: true, applicationId: true },
  });
  const appIds = [...new Set(fus.map((f) => f.applicationId))];
  const apps = appIds.length ? await prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, requirementId: true, stage: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } } }) : [];
  const appOf = new Map(apps.map((a) => [a.id, a]));
  const followUps = fus.filter((f) => { const a = appOf.get(f.applicationId); return a && !paused.has(a.requirementId) && !['REJECTED', 'JOINED', 'HIRED'].includes(a.stage); })
    .map((f) => { const a = appOf.get(f.applicationId); return { id: f.id, applicationId: f.applicationId, what: f.nextAction || 'Follow-up', due: f.dueDate, candidate: a.candidate && a.candidate.name, job: a.requirement && a.requirement.title }; });
  const startToday = new Date(`${t}T00:00:00+05:30`);
  const review = await prisma.application.findMany({
    where: { ownerRecruiterId: user.id, stage: { in: ['RECRUITER_REVIEW', 'AI_INTERVIEW_COMPLETED'] }, updatedAt: { lt: startToday }, requirement: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'] } } },
    select: { id: true, requirementId: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } }, take: 100,
  });
  const toReview = review.filter((a) => !paused.has(a.requirementId)).map((a) => ({ applicationId: a.id, candidate: a.candidate && a.candidate.name, job: a.requirement && a.requirement.title }));
  return { since: prev, count: followUps.length + toReview.length, followUps, toReview, label: 'Carried over from yesterday' };
}

module.exports = {
  METRICS, PERIODS, bounds, setTargets, targetsOf, loadTargets, targetFor, results, myEod, confirmEod, eodConfirmed, eodStat, underperformers, weeklyTable,
  leaderboard, offerToJoining, costRevenue, carryOver, scoreOf, systemViewer, LEAD_VIEWS,
};
