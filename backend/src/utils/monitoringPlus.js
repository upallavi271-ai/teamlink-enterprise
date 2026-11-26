// ---------------------------------------------------------------------------
// EMPLOYEE MONITORING - OVERTIME, TRENDS AND ALERT RULES (founder 2026-11-26, from the market comparison: "Overtime / after-hours,
// Trend charts, Custom alert rules").
//
// OVERTIME   Work done just outside the work hours was thrown away on arrival. Now the part of a record that falls in the overtime
//            window - up to `beforeMinutes` before work starts and `afterMinutes` after it ends (default 60 / 240) - is kept in its own
//            table "MonitoringOvertime": the app name and whether the PC was in use ONLY (no window title, no screenshot, no key counts).
//            The work-hours figures (ActivityLog) are untouched, so every existing total stays exactly as it was. Nothing is kept for a
//            person who clocked out, paused or is not monitored (the agent sends nothing then). It is recorded only while the monitoring
//            notice mentions overtime (the notice was updated and everyone accepts it once), and only from agent 3.5 (earlier agents stop
//            at the end of work hours).
// TRENDS     Week-by-week lines: active hours a day, productive %, idle hours a day and overtime hours a week, for a person, a department or
//            everyone the viewer may see, next to the company average (numbers only, no names).
// ALERT RULES Rules HR writes: "app or website X over N minutes a day", "unproductive over N minutes", "idle over N minutes", "overtime over
//            N minutes", "active after HH:MM". Checked with the other alerts every 5 minutes, at most once a day per person per rule, to the
//            person's team lead and HR (bell, and mail when alert mail is on). Kept in AppSetting (no schema change).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const OT_KEY = 'monitoring.overtime';
const RULES_KEY = 'monitoring.alertRules';
const OT_DEFAULT = { enabled: true, beforeMinutes: 60, afterMinutes: 240 };
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const METRICS = {
  app_minutes: 'App or website used over N minutes a day',
  unproductive_minutes: 'Unproductive apps over N minutes a day',
  idle_minutes: 'Idle over N minutes a day',
  overtime_minutes: 'Overtime over N minutes a day',
  active_after: 'Working after a time (HH:MM)',
};
const r2 = (n) => Math.round(n * 100) / 100;
const hrs = (sec) => r2(sec / 3600);

// --------------------------------------------------------------------------------------------------------- overtime settings
function cleanOt(v) {
  const x = v && typeof v === 'object' ? v : {};
  const n = (k, lo, hi) => { const m = Math.round(Number(x[k])); return Number.isFinite(m) && m >= lo && m <= hi ? m : OT_DEFAULT[k]; };
  return { enabled: x.enabled === undefined ? OT_DEFAULT.enabled : x.enabled === true, beforeMinutes: n('beforeMinutes', 0, 240), afterMinutes: n('afterMinutes', 0, 480) };
}
async function otSettings() {
  try { const r = await prisma.appSetting.findUnique({ where: { key: OT_KEY } }); return cleanOt(r && r.value ? JSON.parse(r.value) : {}); } catch { return { ...OT_DEFAULT }; }
}
async function saveOtSettings(body) {
  const cur = await otSettings();
  const next = cleanOt({ ...cur, ...(body || {}) });
  await prisma.appSetting.upsert({ where: { key: OT_KEY }, create: { key: OT_KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
  return next;
}
// overtime is recorded only while it is on AND the notice people accepted says so
const otLive = (ot, policyText) => !!(ot && ot.enabled && (ot.beforeMinutes || ot.afterMinutes) && /overtime/i.test(String(policyText || '')));

// --------------------------------------------------------------------------------------------------------- the table
let ready = null;
function ensureTable() {
  if (!ready) {
    ready = (async () => {
      await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "MonitoringOvertime" ("id" TEXT PRIMARY KEY, "employeeId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "day" TEXT NOT NULL, "startTime" TEXT NOT NULL, "endTime" TEXT NOT NULL, "seconds" INTEGER NOT NULL, "appName" TEXT NOT NULL, "isIdle" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL)');
      await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "MonitoringOvertime_piece" ON "MonitoringOvertime" ("deviceId", "startTime", "appName")');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "MonitoringOvertime_day" ON "MonitoringOvertime" ("day", "employeeId")');
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// The overtime parts of one record [st, en] (ms) for a day whose work window is [ws, we] (ms): before work and after work, inside the window.
function otParts(st, en, ws, we, ot) {
  const out = [];
  if (ot.beforeMinutes) { const x = Math.max(st, ws - ot.beforeMinutes * 60000); const y = Math.min(en, ws); if (y - x >= 1000) out.push([x, y]); }
  if (ot.afterMinutes) { const x = Math.max(st, we); const y = Math.min(en, we + ot.afterMinutes * 60000); if (y - x >= 1000) out.push([x, y]); }
  return out;
}

// pieces: [{ start, end (ms), appName, isIdle, day }] -> rows written (a piece sent twice counts once)
async function savePieces(device, pieces) {
  if (!pieces.length) return 0;
  await ensureTable();
  let n = 0;
  const now = new Date().toISOString();
  for (const p of pieces) {
    // eslint-disable-next-line no-await-in-loop
    const k = await prisma.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "MonitoringOvertime" ("id","employeeId","deviceId","day","startTime","endTime","seconds","appName","isIdle","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
      crypto.randomUUID(), device.employeeId, device.id, p.day, new Date(p.start).toISOString(), new Date(p.end).toISOString(), Math.round((p.end - p.start) / 1000), String(p.appName).slice(0, 120), p.isIdle ? 1 : 0, now,
    );
    n += Number(k) || 0;
  }
  return n;
}

// --------------------------------------------------------------------------------------------------------- overtime read
async function pieces(from, to, ids = null) {
  await ensureTable();
  const args = [from, to];
  let sql = 'SELECT "employeeId","day","startTime","endTime","seconds","appName","isIdle" FROM "MonitoringOvertime" WHERE "day" >= ? AND "day" <= ?';
  if (ids) { if (!ids.length) return []; sql += ` AND "employeeId" IN (${ids.map(() => '?').join(',')})`; args.push(...ids); }
  return prisma.$queryRawUnsafe(sql, ...args);
}
function sumPieces(list) {
  let active = 0; let idle = 0; let first = null; let last = null; const apps = new Map();
  list.forEach((p) => {
    const s = Number(p.seconds) || 0;
    if (Number(p.isIdle)) idle += s; else { active += s; apps.set(p.appName, (apps.get(p.appName) || 0) + s); }
    if (!first || p.startTime < first) first = p.startTime;
    if (!last || p.endTime > last) last = p.endTime;
  });
  return { activeSeconds: active, idleSeconds: idle, activeHours: hrs(active), idleHours: hrs(idle), first, last, topApps: [...apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, sec]) => ({ name, minutes: Math.round(sec / 60) })) };
}
// The Overtime tab: one row per person (days with overtime, hours) and, with ?employeeId, the person's days.
async function overtimeReport(from, to, access, department = '', employeeId = null) {
  const ids = access && access.ids ? access.ids : null;
  if (employeeId && ids && !ids.includes(employeeId)) return { status: 403, error: 'This person is not in your team.' };
  const rows = await pieces(from, to, employeeId ? [employeeId] : ids);
  const empIds = [...new Set(rows.map((r) => r.employeeId))];
  const emps = empIds.length ? await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, name: true, employeeCode: true, department: true } }) : [];
  const E = new Map(emps.map((e) => [e.id, e]));
  const kept = rows.filter((r) => !department || ((E.get(r.employeeId) || {}).department || '') === department);
  const by = new Map(); kept.forEach((r) => { if (!by.has(r.employeeId)) by.set(r.employeeId, []); by.get(r.employeeId).push(r); });
  const people = [...by.entries()].map(([id, list]) => {
    const e = E.get(id) || {};
    const days = [...new Set(list.map((p) => p.day))].sort().reverse().map((day) => ({ day, ...sumPieces(list.filter((p) => p.day === day)) })).filter((d) => d.activeSeconds > 0 || d.idleSeconds > 0);
    const t = sumPieces(list);
    return { employeeId: id, name: e.name || 'Employee', code: e.employeeCode || null, department: e.department || null, daysWithOvertime: days.filter((d) => d.activeSeconds >= 600).length, activeHours: t.activeHours, idleHours: t.idleHours, latestEnd: t.last, topApps: t.topApps, days: employeeId ? days : undefined };
  }).sort((a, b) => b.activeHours - a.activeHours);
  const ot = await otSettings();
  return { from, to, settings: ot, totalActiveHours: r2(people.reduce((s, p) => s + p.activeHours, 0)), rows: people };
}
// today's overtime minutes (active) per person, for the alert rules
async function overtimeMinutesOn(day) {
  const rows = await pieces(day, day).catch(() => []);
  const m = new Map();
  rows.forEach((r) => { if (!Number(r.isIdle)) m.set(r.employeeId, (m.get(r.employeeId) || 0) + (Number(r.seconds) || 0) / 60); });
  return m;
}
async function lastActiveOn(day) {
  const rows = await pieces(day, day).catch(() => []);
  const m = new Map();
  rows.forEach((r) => { if (!Number(r.isIdle) && (!m.get(r.employeeId) || r.endTime > m.get(r.employeeId))) m.set(r.employeeId, r.endTime); });
  return m;
}

// --------------------------------------------------------------------------------------------------------- trends
function weekStart(ymd) { // Monday of the week, yyyy-mm-dd
  const d = new Date(`${ymd}T00:00:00Z`); const w = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - ((w + 6) % 7)); return d.toISOString().slice(0, 10);
}
function series(daily, otRows, weeks) {
  const by = new Map(weeks.map((w) => [w, { week: w, personDays: 0, active: 0, idle: 0, productive: 0, overtimeSec: 0 }]));
  daily.forEach((r) => { const w = by.get(weekStart(r.day)); if (!w || r.dayType) return; w.personDays += 1; w.active += r.activeHours || 0; w.idle += r.idleHours || 0; w.productive += r.productiveHours || 0; });
  otRows.forEach((p) => { const w = by.get(weekStart(p.day)); if (w && !Number(p.isIdle)) w.overtimeSec += Number(p.seconds) || 0; });
  const people = (rows) => new Set(rows.map((r) => r.employeeId)).size || 1;
  return weeks.map((wk) => {
    const w = by.get(wk);
    const n = people(daily.filter((r) => weekStart(r.day) === wk));
    return {
      week: wk,
      activeHoursPerDay: w.personDays ? r2(w.active / w.personDays) : null,
      idleHoursPerDay: w.personDays ? r2(w.idle / w.personDays) : null,
      productivity: w.active ? Math.round((w.productive / w.active) * 100) : null,
      overtimeHoursPerPerson: r2(w.overtimeSec / 3600 / n),
    };
  });
}
async function trends(query, access) {
  const M = require('./monitoring'); // eslint-disable-line global-require
  const nWeeks = Math.min(26, Math.max(2, Math.round(Number(query.weeks) || 8)));
  const today = M.todayIst();
  const thisWeek = weekStart(today);
  const weeks = []; for (let i = nWeeks - 1; i >= 0; i -= 1) weeks.push(M.addDays(thisWeek, -7 * i));
  const from = weeks[0]; const to = today;
  const employeeId = query.employeeId ? String(query.employeeId) : null;
  const department = query.department ? String(query.department) : '';
  if (employeeId && access && access.ids && !access.ids.includes(employeeId)) return { status: 403, error: 'This person is not in your team.' };
  const mine = (await M.reportRows(from, to, department, access, 'daily')).rows.filter((r) => !employeeId || r.employeeId === employeeId);
  const everyone = (await M.reportRows(from, to, '', null, 'daily')).rows; // numbers only, for the company line
  const allOt = await pieces(from, to);
  const mineIds = new Set(mine.map((r) => r.employeeId)); if (employeeId) mineIds.add(employeeId);
  const label = employeeId ? ((mine[0] && mine[0].name) || 'This person') : (department || (access && access.ids ? 'Your team' : 'Everyone'));
  return {
    weeks, label,
    selection: series(mine, allOt.filter((p) => mineIds.has(p.employeeId)), weeks),
    company: series(everyone, allOt, weeks),
  };
}

// --------------------------------------------------------------------------------------------------------- alert rules
function cleanRule(r) {
  const x = r && typeof r === 'object' ? r : {};
  const metric = METRICS[x.metric] ? x.metric : null;
  if (!metric) return { error: 'Choose what the rule watches.' };
  const name = String(x.name || '').trim().slice(0, 60);
  if (!name) return { error: 'Give the rule a name.' };
  const out = { id: String(x.id || crypto.randomUUID()), name, metric, enabled: x.enabled !== false, departments: (Array.isArray(x.departments) ? x.departments : String(x.departments || '').split(',')).map((d) => String(d).trim()).filter(Boolean).slice(0, 30) };
  if (metric === 'active_after') {
    if (!HM.test(String(x.time || ''))) return { error: 'Write the time like 21:00.' };
    out.time = String(x.time);
  } else {
    const n = Math.round(Number(x.minutes));
    if (!(n >= 5 && n <= 720)) return { error: 'Minutes must be between 5 and 720.' };
    out.minutes = n;
  }
  if (metric === 'app_minutes') {
    const t = String(x.target || '').trim().slice(0, 60);
    if (!t) return { error: 'Write the app or website, for example youtube.' };
    out.target = t;
  }
  return { rule: out };
}
async function listRules() {
  try { const r = await prisma.appSetting.findUnique({ where: { key: RULES_KEY } }); const v = r && r.value ? JSON.parse(r.value) : []; return (Array.isArray(v) ? v : []).map((x) => cleanRule(x).rule).filter(Boolean); } catch { return []; }
}
async function writeRules(list) {
  await prisma.appSetting.upsert({ where: { key: RULES_KEY }, create: { key: RULES_KEY, value: JSON.stringify(list) }, update: { value: JSON.stringify(list) } });
  return list;
}
async function saveRule(body) {
  const c = cleanRule(body);
  if (c.error) return { status: 400, error: c.error };
  const list = await listRules();
  const i = list.findIndex((r) => r.id === c.rule.id);
  if (i >= 0) list[i] = c.rule; else { if (list.length >= 50) return { status: 400, error: 'At most 50 rules.' }; list.push(c.rule); }
  await writeRules(list);
  return { rule: c.rule, rules: list };
}
async function removeRule(id) {
  const list = (await listRules()).filter((r) => r.id !== id);
  await writeRules(list);
  return { rules: list };
}
const ruleKind = (r) => `rule:${r.id}`;
const ruleWord = async (kind) => { if (!String(kind).startsWith('rule:')) return null; const r = (await listRules()).find((x) => ruleKind(x) === kind); return r ? r.name : 'Alert rule'; };

// Evaluated inside monitoringAlerts.scan for one person: ctx = { employeeId, department, day, mine (today's work-hour logs), catOf, totalsOf,
// otMinutes (Map), otLast (Map), now }. Returns [{ kind, detail }].
function evalRules(rules, ctx) {
  const out = [];
  const minsOf = (list) => list.reduce((s, l) => s + (l.durationSeconds || 0), 0) / 60;
  rules.filter((r) => r.enabled && (!r.departments.length || r.departments.includes(ctx.department || ''))).forEach((r) => {
    const add = (detail) => out.push({ kind: ruleKind(r), detail: `${r.name}: ${detail}` });
    if (r.metric === 'app_minutes') {
      const t = r.target.toLowerCase();
      const used = minsOf(ctx.mine.filter((l) => !l.isIdle && !l.isBreak && (String(l.appName).toLowerCase().includes(t) || String(l.windowTitle || '').toLowerCase().includes(t))));
      if (used >= r.minutes) add(`${r.target} used for ${Math.round(used)} minutes today (the limit is ${r.minutes}).`);
    } else if (r.metric === 'unproductive_minutes' || r.metric === 'idle_minutes') {
      if (!ctx.mine.length) return;
      const t = ctx.totalsOf(ctx.mine, ctx.catOf, ctx.department || '');
      const v = Math.round((r.metric === 'idle_minutes' ? t.idleSeconds : t.unproductiveSeconds) / 60);
      if (v >= r.minutes) add(`${r.metric === 'idle_minutes' ? 'Idle' : 'Unproductive apps'} for ${v} minutes today (the limit is ${r.minutes}).`);
    } else if (r.metric === 'overtime_minutes') {
      const v = Math.round(ctx.otMinutes.get(ctx.employeeId) || 0);
      if (v >= r.minutes) add(`Worked ${v} minutes outside work hours today (the limit is ${r.minutes}).`);
    } else if (r.metric === 'active_after') {
      const last = ctx.otLast.get(ctx.employeeId);
      if (last) {
        const hm = new Date(new Date(last).getTime() + 330 * 60000).toISOString().slice(11, 16);
        if (hm >= r.time) add(`Was working at ${hm}, after ${r.time}.`);
      }
    }
  });
  return out;
}

module.exports = {
  OT_KEY, RULES_KEY, OT_DEFAULT, METRICS, otSettings, saveOtSettings, otLive, otParts, savePieces, ensureTable, overtimeReport, overtimeMinutesOn, lastActiveOn,
  trends, weekStart, listRules, saveRule, removeRule, evalRules, ruleWord, cleanRule,
};
