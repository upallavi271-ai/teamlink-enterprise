// ---------------------------------------------------------------------------
// METRIC ALERTS (01.13, 2026-11-21) - "tell me when a number crosses my limit".
//
// Each person keeps their own rules ({ metric, above|below, threshold, days }). A metric is counted in THAT person's scope
// (core.ctxFor), so a rule can never tell anyone about work outside their area. The hourly check writes ONE note in the
// bell when a rule starts to hold (not every hour while it keeps holding) and re-arms when the number goes back.
// OFF BY DEFAULT: the check does nothing until an Admin switches "Metric alerts" on (core.switches().alerts). People can
// still save rules and press "Check now" to see the current numbers; nobody is notified while it is off.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');
const M = require('./metrics');

const METRICS = {
  stale_jobs: { label: 'Open requirements with nothing sent to the client in N days', usual: 'above', days: 5 },
  waiting_client: { label: 'People waiting for client feedback for more than N days', usual: 'above', days: 3 },
  open_jobs: { label: 'Open requirements', usual: 'above' },
  overdue_followups: { label: 'Overdue follow-ups', usual: 'above' },
  sent_week: { label: 'People sent to clients in the last 7 days', usual: 'below' },
  joinings_month: { label: 'Joinings this month', usual: 'below' },
  ttf_median: { label: 'Usual days to fill (last 90 days)', usual: 'above' },
};

function valueOf(metric, ctx, days) {
  const t0 = C.today();
  const n = Math.max(1, Math.min(60, Number(days) || METRICS[metric].days || 5));
  switch (metric) {
    case 'stale_jobs': {
      const lastSent = new Map();
      ctx.apps.forEach((x) => {
        const at = x.crossedAt && x.crossedAt.shared ? C.istDay(x.crossedAt.shared) : (x.reached('shared') ? C.istDay(x.a.createdAt) : null);
        if (at && (!lastSent.has(x.req.id) || at > lastSent.get(x.req.id))) lastSent.set(x.req.id, at);
      });
      return ctx.reqs.filter((r) => M.LIVE.includes(r.status) && C.dayDiff(lastSent.get(r.id) || C.istDay(r.createdAt), t0) >= n).length;
    }
    case 'waiting_client': return ctx.apps.filter((x) => x.inPipeline && x.pipe.id === 'client_review' && (x.daysInStage || 0) > n).length;
    case 'open_jobs': return ctx.reqs.filter((r) => M.LIVE.includes(r.status)).length;
    case 'overdue_followups': return ctx.followUps.filter((f) => !f.completedAt && f.dueDate && f.dueDate < t0).length;
    case 'sent_week': {
      const from = C.addDays(t0, -6);
      return ctx.apps.filter((x) => { const d = x.crossedAt && x.crossedAt.shared ? C.istDay(x.crossedAt.shared) : null; return d && d >= from; }).length;
    }
    case 'joinings_month': { const m = t0.slice(0, 7); return ctx.apps.filter((x) => { const d = C.joinDayOf(x); return d && d.slice(0, 7) === m; }).length; }
    case 'ttf_median': { const v = M.timeToFill(ctx, { days: 90 }).tiles.medianFill; return v === null ? null : v; }
    default: return null;
  }
}
const holds = (rule, v) => v !== null && v !== undefined && (rule.direction === 'below' ? v < rule.threshold : v > rule.threshold);

async function list(userId) {
  await C.ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "AtsMetricAlert" WHERE "userId" = ? ORDER BY "createdAt"', userId);
  return rows.map((r) => ({ ...r, threshold: Number(r.threshold), days: C.num(r.days), active: !!Number(r.active), firing: !!Number(r.firing), lastValue: C.num(r.lastValue), label: (METRICS[r.metric] || {}).label || r.metric }));
}
async function create(user, body = {}) {
  await C.ensure();
  const metric = String(body.metric || '');
  if (!METRICS[metric]) return { error: 'Pick a number to watch.' };
  const threshold = Number(body.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100000) return { error: 'Give the limit as a number (0 or more).' };
  const direction = body.direction === 'below' ? 'below' : 'above';
  const days = METRICS[metric].days ? Math.max(1, Math.min(60, Math.round(Number(body.days) || METRICS[metric].days))) : null;
  const n = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "AtsMetricAlert" WHERE "userId" = ?', user.id))[0];
  if (Number(n.n) >= 20) return { error: 'You can keep 20 alerts. Remove one first.' };
  const id = C.newId('mal');
  await prisma.$executeRawUnsafe('INSERT INTO "AtsMetricAlert" ("id","userId","userName","metric","direction","threshold","days","active","createdAt") VALUES (?,?,?,?,?,?,?,1,?)',
    id, user.id, user.name || null, metric, direction, threshold, days, new Date().toISOString());
  return { ok: true, id };
}
async function update(user, id, body = {}) {
  await C.ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsMetricAlert" WHERE "id" = ? AND "userId" = ?', String(id), user.id);
  if (!r) return { status: 404, error: 'That alert is not yours or is gone.' };
  if (typeof body.active === 'boolean') await prisma.$executeRawUnsafe('UPDATE "AtsMetricAlert" SET "active" = ?, "firing" = 0 WHERE "id" = ?', body.active ? 1 : 0, r.id);
  if (body.threshold !== undefined && Number.isFinite(Number(body.threshold))) await prisma.$executeRawUnsafe('UPDATE "AtsMetricAlert" SET "threshold" = ?, "firing" = 0 WHERE "id" = ?', Number(body.threshold), r.id);
  return { ok: true };
}
async function remove(user, id) {
  await C.ensure();
  const n = await prisma.$executeRawUnsafe('DELETE FROM "AtsMetricAlert" WHERE "id" = ? AND "userId" = ?', String(id), user.id);
  return n ? { ok: true } : { status: 404, error: 'That alert is not yours or is gone.' };
}

// Count one person's rules now. notify: write the bell notes (only when the Admin switch is on).
async function checkUser(user, { notify = false } = {}) {
  const rules = (await list(user.id)).filter((r) => r.active);
  if (!rules.length) return [];
  const ctx = await C.ctxFor(user, {}, true);
  const { pushNotification } = require('../notify'); // eslint-disable-line global-require
  const out = [];
  for (const r of rules) {
    const v = valueOf(r.metric, ctx, r.days);
    const now = holds(r, v);
    let fired = false;
    if (now && !r.firing && notify) {
      // eslint-disable-next-line no-await-in-loop
      await pushNotification({
        userId: user.id,
        title: `Alert: ${METRICS[r.metric].label.replace(' N ', ` ${r.days || ''} `)}`,
        message: `It is ${v} now - your limit is ${r.direction} ${r.threshold}.`,
        open: '/dashboard',
      });
      fired = true;
    }
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe('UPDATE "AtsMetricAlert" SET "lastValue" = ?, "lastCheckedAt" = ?, "firing" = ?, "lastFiredAt" = COALESCE(?, "lastFiredAt") WHERE "id" = ?',
      v, new Date().toISOString(), notify ? (now ? 1 : 0) : (r.firing ? 1 : 0), fired ? new Date().toISOString() : null, r.id);
    out.push({ id: r.id, metric: r.metric, label: r.label, value: v, direction: r.direction, threshold: r.threshold, crossed: now, notified: fired });
  }
  return out;
}

// The hourly check over everyone with an active rule. Does nothing while the switch is off.
async function sweep() {
  const sw = await C.switches();
  if (!sw.alerts) return { skipped: 'Metric alerts are switched off.' };
  await C.ensure();
  const users = await prisma.$queryRawUnsafe('SELECT DISTINCT "userId" FROM "AtsMetricAlert" WHERE "active" = 1');
  let checked = 0; let notified = 0;
  for (const u of users) {
    // eslint-disable-next-line no-await-in-loop
    const who = await C.identityOf(u.userId);
    if (!who) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const res = await checkUser(who, { notify: true }).catch(() => []);
    checked += 1; notified += res.filter((x) => x.notified).length;
  }
  return { checked, notified };
}
let TIMER = null;
function startSweep() {
  if (TIMER || require('../sandbox').isSandbox()) return; // eslint-disable-line global-require
  TIMER = setInterval(() => { sweep().catch((e) => console.error('[insights alerts]', e.message)); }, 60 * 60000); // eslint-disable-line no-console
  if (TIMER.unref) TIMER.unref();
}

module.exports = { METRICS, valueOf, list, create, update, remove, checkUser, sweep, startSweep };
