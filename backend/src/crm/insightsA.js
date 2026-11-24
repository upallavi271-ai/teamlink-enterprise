// ---------------------------------------------------------------------------
// CRM WAVE A - THE LEADERBOARD AND THE TRENDS (2026-11-24; 10.05 leaderboards / badges, 10.13 pipeline snapshots and cohorts).
//   LEADERBOARD  each salesperson for a period: deals won and their value, leads converted, calls / meetings / emails logged, follow-ups
//                done on time, % of the month's target - turned into POINTS (won deal 50, each ₹10,000 won 1, converted lead 10, logged work 1,
//                follow-up done on time 2) and a rank, with badges (Top closer, Most active, On-time star, Target hit, First win, Hot streak).
//                A Sales manager / Admin / Viewer sees the whole board; a salesperson sees their own line and rank (the whole board only
//                when an Admin turns on "Salespeople see the whole leaderboard": names, points and badges, never the money of others).
//   SNAPSHOTS    once a day the open pipeline per owner and stage is written down (CrmPipelineSnapshot); the trend reads the snapshots,
//                and for days before the first one it REBUILDS the pipeline from the stage moves on each deal's timeline (marked so).
//   COHORTS      leads by the month they came: how many were contacted, converted, and won (and for how much) since; deals by the month
//                they were added: won within 30 / 60 / 90 days.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const W = require('./waveSchema');
const S = require('./service');
const DB = require('./schema');

const OFF = 5.5 * 3600 * 1000;
const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const istYmd = (ms) => new Date(ms + OFF).toISOString().slice(0, 10);
const startIso = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - OFF).toISOString();
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const WORK = 'a."byId" IS NOT NULL AND COALESCE(a."subject", \'\') NOT LIKE \'Stage:%\' AND COALESCE(a."subject", \'\') NOT LIKE \'Follow-up moved:%\'';

function rangeOf(period) {
  const today = istYmd(Date.now());
  const [y, m] = today.split('-').map(Number);
  const first = (yy, mm) => new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  if (period === 'last_month') return { from: first(y, m - 2), to: first(y, m - 1), label: 'Last month', month: first(y, m - 2).slice(0, 7) };
  if (period === 'quarter') { const q = Math.floor((m - 1) / 3) * 3; return { from: first(y, q), to: first(y, q + 3), label: 'This quarter' }; }
  if (period === 'year') return { from: first(y, 0), to: first(y + 1, 0), label: 'This year' };
  if (period === 'week') { const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; const f = addDays(today, -dow); return { from: f, to: addDays(f, 7), label: 'This week' }; }
  return { from: first(y, m - 1), to: first(y, m), label: 'This month', month: today.slice(0, 7) };
}
const POINTS = { wonDeal: 50, per10k: 1, converted: 10, work: 1, onTime: 2 };
async function leaderboard(user, { period } = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  const rg = rangeOf(period);
  const f = startIso(rg.from); const t = startIso(rg.to);
  const people = await S.ownerOptions();
  const byId = new Map(people.map((p) => [p.id, { id: p.id, name: p.name, wonDeals: 0, wonValue: 0, converted: 0, work: 0, calls: 0, meetings: 0, onTime: 0, doneTasks: 0, newLeads: 0, target: null, activeDays: 0 }]));
  const row = (id, name) => { if (!byId.has(id)) byId.set(id, { id, name: name || '—', wonDeals: 0, wonValue: 0, converted: 0, work: 0, calls: 0, meetings: 0, onTime: 0, doneTasks: 0, newLeads: 0, target: null, activeDays: 0, former: true }); return byId.get(id); };
  (await DB.all('SELECT "ownerId", "ownerName", COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE "stage" = \'Won\' AND "wonAt" >= ? AND "wonAt" < ? AND "ownerId" IS NOT NULL GROUP BY "ownerId"', f, t)).forEach((x) => { const o = row(x.ownerId, x.ownerName); o.wonDeals = Number(x.n); o.wonValue = round(x.v); });
  (await DB.all('SELECT "ownerId", "ownerName", COUNT(*) AS "n" FROM "CrmLead" WHERE "convertedAt" >= ? AND "convertedAt" < ? AND "ownerId" IS NOT NULL GROUP BY "ownerId"', f, t)).forEach((x) => { row(x.ownerId, x.ownerName).converted = Number(x.n); });
  (await DB.all('SELECT "ownerId", "ownerName", COUNT(*) AS "n" FROM "CrmLead" WHERE "createdAt" >= ? AND "createdAt" < ? AND "ownerId" IS NOT NULL GROUP BY "ownerId"', f, t)).forEach((x) => { row(x.ownerId, x.ownerName).newLeads = Number(x.n); });
  (await DB.all(`SELECT a."byId", a."byName", COUNT(*) AS "n", SUM(CASE WHEN a."kind" = 'call' THEN 1 ELSE 0 END) AS "c", SUM(CASE WHEN a."kind" = 'meeting' THEN 1 ELSE 0 END) AS "m", COUNT(DISTINCT date(datetime(a."at", '+330 minutes'))) AS "days" FROM "CrmActivity" a WHERE ${WORK} AND a."at" >= ? AND a."at" < ? GROUP BY a."byId"`, f, t)).forEach((x) => { const o = row(x.byId, x.byName); o.work = Number(x.n); o.calls = Number(x.c) || 0; o.meetings = Number(x.m) || 0; o.activeDays = Number(x.days) || 0; });
  (await DB.all('SELECT "ownerId", "ownerName", COUNT(*) AS "n", SUM(CASE WHEN date(datetime("doneAt", \'+330 minutes\')) <= "dueDate" THEN 1 ELSE 0 END) AS "ok" FROM "CrmTask" WHERE "status" = \'Done\' AND "doneAt" >= ? AND "doneAt" < ? AND "ownerId" IS NOT NULL GROUP BY "ownerId"', f, t)).forEach((x) => { const o = row(x.ownerId, x.ownerName); o.doneTasks = Number(x.n); o.onTime = Number(x.ok) || 0; });
  if (rg.month) (await DB.all('SELECT "ownerId", "amount" FROM "CrmTarget" WHERE "month" = ?', rg.month)).forEach((x) => { if (byId.has(x.ownerId)) byId.get(x.ownerId).target = Number(x.amount) || null; });
  // the first win ever (in this period), and a streak: work logged on 5 of the last 7 days
  const firsts = new Set((await DB.all('SELECT "ownerId", MIN("wonAt") AS "first" FROM "CrmDeal" WHERE "stage" = \'Won\' AND "wonAt" IS NOT NULL GROUP BY "ownerId"')).filter((x) => x.first >= f && x.first < t).map((x) => x.ownerId));
  const streak = new Map((await DB.all(`SELECT a."byId", COUNT(DISTINCT date(datetime(a."at", '+330 minutes'))) AS "d" FROM "CrmActivity" a WHERE ${WORK} AND a."at" >= ? GROUP BY a."byId"`, startIso(addDays(istYmd(Date.now()), -6)))).map((x) => [x.byId, Number(x.d)]));
  let list = [...byId.values()].filter((o) => !o.former || o.wonDeals || o.work || o.converted || o.doneTasks);
  list.forEach((o) => {
    o.points = o.wonDeals * POINTS.wonDeal + Math.floor(o.wonValue / 10000) * POINTS.per10k + o.converted * POINTS.converted + o.work * POINTS.work + o.onTime * POINTS.onTime;
    o.targetPercent = o.target ? Math.round((o.wonValue / o.target) * 100) : null;
    o.onTimePercent = o.doneTasks ? Math.round((o.onTime / o.doneTasks) * 100) : null;
    o.badges = [];
  });
  const top = (k) => { const m = Math.max(0, ...list.map((o) => o[k])); return m > 0 ? list.filter((o) => o[k] === m) : []; };
  top('wonValue').forEach((o) => o.badges.push({ key: 'closer', label: 'Top closer', why: 'Most money won' }));
  top('work').forEach((o) => o.badges.push({ key: 'active', label: 'Most active', why: 'Most calls, meetings and emails logged' }));
  list.forEach((o) => {
    if (o.doneTasks >= 5 && o.onTimePercent >= 90) o.badges.push({ key: 'ontime', label: 'On-time star', why: `${o.onTimePercent}% of follow-ups done on time` });
    if (o.targetPercent != null && o.targetPercent >= 100) o.badges.push({ key: 'target', label: 'Target hit', why: `${o.targetPercent}% of the month's target` });
    if (firsts.has(o.id)) o.badges.push({ key: 'first', label: 'First win', why: 'The first deal they ever won' });
    if ((streak.get(o.id) || 0) >= 5) o.badges.push({ key: 'streak', label: 'Hot streak', why: 'Work logged on 5 of the last 7 days' });
  });
  list.sort((a, b) => b.points - a.points || b.wonValue - a.wonValue || String(a.name).localeCompare(String(b.name)));
  let rank = 0; let last = null;
  list.forEach((o, i) => { if (o.points !== last) { rank = i + 1; last = o.points; } o.rank = rank; });
  const sw = await W.switches();
  const meRow = list.find((o) => o.id === user.id) || null;
  if (!S.seesAll(r)) {
    if (!sw.repsSeeBoard) list = meRow ? [meRow] : [];
    else list = list.map((o) => (o.id === user.id ? o : { id: o.id, name: o.name, rank: o.rank, points: o.points, badges: o.badges, hidden: true }));
  }
  return S.okBody({ period: rg.label, from: rg.from, to: rg.to, points: POINTS, rows: list, me: meRow ? { rank: meRow.rank, points: meRow.points, of: byId.size } : null, full: S.seesAll(r) || sw.repsSeeBoard });
}

// ---- pipeline snapshots ----------------------------------------------------------------------------------------------------------
async function takeSnapshot({ day } = {}) {
  const d = day || istYmd(Date.now());
  const have = await W.one('SELECT "id" FROM "CrmPipelineSnapshot" WHERE "day" = ? LIMIT 1', d);
  if (have) return { day: d, taken: false };
  const rows = await DB.all('SELECT "ownerId", MAX("ownerName") AS "ownerName", "stage", COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v", COALESCE(SUM("value" * "probability" / 100.0), 0) AS "w" FROM "CrmDeal" WHERE "stage" NOT IN (\'Won\', \'Lost\') GROUP BY "ownerId", "stage"');
  const t = new Date().toISOString();
  for (const x of rows) {
    // eslint-disable-next-line no-await-in-loop
    await W.run('INSERT OR IGNORE INTO "CrmPipelineSnapshot" ("id", "day", "ownerId", "ownerName", "stage", "count", "value", "weighted", "takenAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('snap'), d, x.ownerId || '', x.ownerName || null, x.stage, Number(x.n), round(x.v), round(x.w), t);
  }
  // an empty pipeline is a snapshot too (one marker row)
  if (!rows.length) await W.run('INSERT OR IGNORE INTO "CrmPipelineSnapshot" ("id", "day", "ownerId", "ownerName", "stage", "count", "value", "weighted", "takenAt") VALUES (?, ?, \'\', NULL, \'(none)\', 0, 0, 0, ?)', newId('snap'), d, t);
  return { day: d, taken: true, rows: rows.length };
}
// the open pipeline as it stood at the end of `day`, rebuilt from each deal's stage moves ("Stage: A → B" on its timeline)
function rebuild(deals, moves, day, who) {
  const end = startIso(addDays(day, 1));
  const out = {};
  for (const d of deals) {
    if (who && d.ownerId !== who) continue;
    if (d.createdAt >= end) continue;
    const mv = moves.get(d.id) || [];
    let stage = d.stage;
    const before = mv.filter((m) => m.at < end);
    if (before.length) stage = before[before.length - 1].to;
    else if (mv.length) stage = mv[0].from;
    if (d.wonAt && d.wonAt < end) stage = 'Won';
    if (d.lostAt && d.lostAt < end) stage = 'Lost';
    if (stage === 'Won' || stage === 'Lost') continue;
    const o = out[stage] || (out[stage] = { stage, count: 0, value: 0, weighted: 0 });
    o.count += 1; o.value += Number(d.value) || 0; o.weighted += ((Number(d.value) || 0) * (Number(d.probability) || 0)) / 100;
  }
  return Object.values(out).map((x) => ({ ...x, value: round(x.value), weighted: round(x.weighted) }));
}
async function trends(user, { weeks, owner } = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  if (S.seesAll(r) && !(['admin', 'tl'].includes(r) || S.can(user, 'reports'))) return S.fail(403, 'Your CRM rights do not include team reports.');
  await takeSnapshot().catch(() => null);
  const n = Math.max(4, Math.min(52, Math.round(Number(weeks) || 12)));
  const who = S.seesAll(r) ? (S.clip(owner, 60) || null) : user.id;
  const today = istYmd(Date.now());
  const days = Array.from({ length: n }, (_, i) => addDays(today, -7 * (n - 1 - i)));
  const deals = await DB.all(`SELECT "id", "stage", "value", "probability", "ownerId", "createdAt", "wonAt", "lostAt" FROM "CrmDeal"${who ? ' WHERE "ownerId" = ?' : ''}`, ...(who ? [who] : []));
  const acts = await DB.all(`SELECT a."dealId", a."subject", a."at" FROM "CrmActivity" a WHERE a."dealId" IS NOT NULL AND a."leadId" IS NULL AND a."subject" LIKE 'Stage:%' ORDER BY a."at"`);
  const moves = new Map();
  for (const a of acts) {
    const m = /^Stage:\s*(.+?)\s*→\s*(.+)$/.exec(a.subject || '');
    if (!m || !S.STAGES.includes(m[1].trim()) || !S.STAGES.includes(m[2].trim())) continue; // a converted lead's own stage moves are on the deal too: not deal stages
    if (!moves.has(a.dealId)) moves.set(a.dealId, []);
    moves.get(a.dealId).push({ from: m[1].trim(), to: m[2].trim(), at: a.at });
  }
  const snaps = await W.all(`SELECT "day", "stage", SUM("count") AS "count", SUM("value") AS "value", SUM("weighted") AS "weighted" FROM "CrmPipelineSnapshot" WHERE "day" IN (${days.map(() => '?').join(',')})${who ? ' AND "ownerId" = ?' : ''} GROUP BY "day", "stage"`, ...days, ...(who ? [who] : []));
  const snapDays = new Set(snaps.map((s) => s.day));
  const series = days.map((day) => {
    const fromSnap = snapDays.has(day);
    const stages = fromSnap ? snaps.filter((s) => s.day === day && s.stage !== '(none)').map((s) => ({ stage: s.stage, count: Number(s.count), value: round(s.value), weighted: round(s.weighted) })) : rebuild(deals, moves, day, who);
    return { day, source: fromSnap ? 'snapshot' : 'rebuilt', stages, count: stages.reduce((a, s) => a + s.count, 0), value: round(stages.reduce((a, s) => a + s.value, 0)), weighted: round(stages.reduce((a, s) => a + s.weighted, 0)) };
  });
  const first = await W.one('SELECT MIN("day") AS "d" FROM "CrmPipelineSnapshot"');
  return S.okBody({ weeks: n, series, stages: S.STAGES.filter((s) => s !== 'Won' && s !== 'Lost'), firstSnapshot: first && first.d, scope: who ? 'owner' : 'all' });
}
async function cohorts(user, { months, owner } = {}) {
  const r = S.roleOf(user);
  if (!r) return S.fail(403, 'No CRM access.');
  if (S.seesAll(r) && !(['admin', 'tl'].includes(r) || S.can(user, 'reports'))) return S.fail(403, 'Your CRM rights do not include team reports.');
  const n = Math.max(3, Math.min(24, Math.round(Number(months) || 6)));
  const who = S.seesAll(r) ? (S.clip(owner, 60) || null) : user.id;
  const ym = istYmd(Date.now()).slice(0, 7);
  const addM = (x, k) => { const [y, m] = x.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); };
  const first = addM(ym, -(n - 1));
  const from = startIso(`${first}-01`);
  const own = who ? ' AND l."ownerId" = ?' : '';
  const leads = await DB.all(`SELECT substr(date(datetime(l."createdAt", '+330 minutes')), 1, 7) AS "m", COUNT(*) AS "leads",
      SUM(CASE WHEN l."status" IN ('Contacted', 'Qualified', 'Converted') OR (l."stage" IS NOT NULL AND l."stage" NOT IN ('New')) THEN 1 ELSE 0 END) AS "contacted",
      SUM(CASE WHEN l."status" = 'Converted' THEN 1 ELSE 0 END) AS "converted",
      SUM(CASE WHEN d."stage" = 'Won' THEN 1 ELSE 0 END) AS "won", COALESCE(SUM(CASE WHEN d."stage" = 'Won' THEN COALESCE(d."finalValue", d."value") ELSE 0 END), 0) AS "wonValue"
    FROM "CrmLead" l LEFT JOIN "CrmDeal" d ON d."id" = l."dealId" WHERE l."createdAt" >= ?${own} GROUP BY 1 ORDER BY 1`, from, ...(who ? [who] : []));
  const deals = await DB.all(`SELECT substr(date(datetime(d."createdAt", '+330 minutes')), 1, 7) AS "m", COUNT(*) AS "deals",
      SUM(CASE WHEN d."stage" = 'Won' AND julianday(d."wonAt") - julianday(d."createdAt") <= 30 THEN 1 ELSE 0 END) AS "w30",
      SUM(CASE WHEN d."stage" = 'Won' AND julianday(d."wonAt") - julianday(d."createdAt") <= 60 THEN 1 ELSE 0 END) AS "w60",
      SUM(CASE WHEN d."stage" = 'Won' AND julianday(d."wonAt") - julianday(d."createdAt") <= 90 THEN 1 ELSE 0 END) AS "w90",
      SUM(CASE WHEN d."stage" = 'Won' THEN 1 ELSE 0 END) AS "won", SUM(CASE WHEN d."stage" = 'Lost' THEN 1 ELSE 0 END) AS "lost"
    FROM "CrmDeal" d WHERE d."createdAt" >= ?${who ? ' AND d."ownerId" = ?' : ''} GROUP BY 1 ORDER BY 1`, from, ...(who ? [who] : []));
  const pct = (a, b) => (b ? Math.round((Number(a) / Number(b)) * 100) : null);
  const monthsList = Array.from({ length: n }, (_, i) => addM(first, i));
  return S.okBody({
    leads: monthsList.map((m) => { const x = leads.find((l) => l.m === m) || {}; return { month: m, leads: Number(x.leads) || 0, contacted: Number(x.contacted) || 0, converted: Number(x.converted) || 0, won: Number(x.won) || 0, wonValue: round(x.wonValue), contactedPct: pct(x.contacted, x.leads), convertedPct: pct(x.converted, x.leads), wonPct: pct(x.won, x.leads) }; }),
    deals: monthsList.map((m) => { const x = deals.find((l) => l.m === m) || {}; return { month: m, deals: Number(x.deals) || 0, won30: Number(x.w30) || 0, won60: Number(x.w60) || 0, won90: Number(x.w90) || 0, won: Number(x.won) || 0, lost: Number(x.lost) || 0, won90Pct: pct(x.w90, x.deals) }; }),
    scope: who ? 'owner' : 'all',
  });
}

module.exports = { leaderboard, takeSnapshot, trends, cohorts, rebuild, POINTS };
