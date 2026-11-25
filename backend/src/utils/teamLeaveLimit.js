// ---------------------------------------------------------------------------
// THE TEAM LEAVE LIMIT (founder 2026-11-25: "in a team, if 2 people are on leave, another employee cannot apply; Education Team A
// (5 people) shows only Team A's block, Education Team B is separate - show it team-wise").
//
//   * A TEAM = the same department AND the same team name (Employee.department + Employee.team, e.g. Education / Team-A).
//     Somebody with no team is in no team: the limit does not apply to them (they still get the old department reminder).
//   * At most `limit` people (default 2) of one team may be on leave on the same day. Approved, waiting (Pending) and
//     cancellation-requested leaves all hold a slot; Rejected and Cancelled ones do not; a half day holds a slot too.
//   * Checked DAY BY DAY over the dates asked for: A on 2-3 Mar and B on 4-5 Mar leave a slot free for C on 2-5 Mar.
//     Sundays and company holidays are not leave days (utils/leaveDays.js) and are skipped.
//   * It replaces the older "just a reminder" for the team (founder 2026-10-26 had made it a reminder only); the department
//     reminder (who-else) stays.
//   * Switch + number: AppSetting 'leave.teamLimit' { enabled, limit } (default on, 2), edited on Leave -> Leave policy by
//     whoever has Leave & Holidays / configure. The same people may apply beyond it on purpose (overrideTeamLimit), audit-logged.
// Reads only. The check never throws into the caller's flow except through the route that asked for it.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'leave.teamLimit';
const DEFAULTS = Object.freeze({ enabled: true, limit: 2 });
const LIVE = ['Approved', 'Pending', 'Cancellation Requested'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (d) => `${Number(d.slice(8, 10))} ${MON3[Number(d.slice(5, 7)) - 1]}`;

function eachDay(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length < 400) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function normalise(raw) {
  const limit = Number(raw && raw.limit);
  return {
    enabled: raw && typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    limit: Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : DEFAULTS.limit,
  };
}
async function getSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let raw = null;
  try { raw = row ? JSON.parse(row.value) : null; } catch { raw = null; }
  return normalise(raw);
}
// patch: { enabled?, limit? } -> { settings } | { error }
async function saveSettings(patch, actor) {
  const cur = await getSettings();
  const next = { ...cur };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { error: 'Say on or off (enabled: true / false).' };
    next.enabled = patch.enabled;
  }
  if (patch.limit !== undefined) {
    const n = Number(patch.limit);
    if (!Number.isInteger(n) || n < 1 || n > 20) return { error: 'The team limit must be a whole number from 1 to 20 people.' };
    next.limit = n;
  }
  const value = JSON.stringify(next);
  const meta = { updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null };
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value, ...meta }, create: { key: KEY, value, ...meta } });
  return { settings: next, before: cur };
}

// What a request of `employee` for fromDate..toDate would meet in their team. null = the limit does not apply
// (switched off, or the person is in no team). Otherwise:
//   { limit, teamName, department, teamSize, days: [{ date, taken, left, full, people: [{ name, status }] }], fullDates, blocked, message }
async function check(employee, fromDate, toDate) {
  const s = await getSettings();
  const team = employee && employee.team ? String(employee.team).trim() : '';
  if (!s.enabled || !employee || !employee.department || !team) return null;
  const from = String(fromDate).slice(0, 10);
  const to = String(toDate || fromDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return null;
  const mates = await prisma.employee.findMany({
    where: { department: employee.department, team: employee.team, id: { not: employee.id }, employmentStatus: { notIn: ['Relieved', 'Exited'] } },
    select: { id: true, name: true },
  });
  const off = new Set(); // Sundays and company holidays are not leave days
  try {
    const counted = await require('./leaveDays').countFor(from, to); // eslint-disable-line global-require
    (counted.skipped || []).forEach((x) => off.add(x.date));
  } catch { /* count every day */ }
  const leaves = mates.length ? await prisma.leaveRequest.findMany({
    where: { employeeId: { in: mates.map((m) => m.id) }, status: { in: LIVE }, fromDate: { lte: to }, toDate: { gte: from } },
    select: { employeeId: true, fromDate: true, toDate: true, status: true },
  }) : [];
  const nameOf = new Map(mates.map((m) => [m.id, m.name]));
  const days = [];
  eachDay(from, to).forEach((date) => {
    if (off.has(date)) return;
    const who = new Map();
    leaves.forEach((l) => {
      if (String(l.fromDate).slice(0, 10) <= date && String(l.toDate).slice(0, 10) >= date) {
        who.set(l.employeeId, { name: nameOf.get(l.employeeId) || 'A colleague', status: l.status === 'Pending' ? 'asked' : 'on leave' });
      }
    });
    days.push({ date, taken: who.size, left: Math.max(0, s.limit - who.size), full: who.size >= s.limit, people: [...who.values()] });
  });
  const fullDates = days.filter((d) => d.full).map((d) => d.date);
  const blocked = fullDates.length > 0;
  const teamName = `${employee.department} ${team}`;
  let message = null;
  if (blocked) {
    const first = days.find((d) => d.full);
    const shown = fullDates.slice(0, 4).map(dm).join(', ');
    message = `Your team (${teamName}) is full on ${shown}${fullDates.length > 4 ? ` and ${fullDates.length - 4} more day(s)` : ''}: ${s.limit} people are already on leave or have asked for it (${first.people.map((p) => p.name).join(', ')}), and only ${s.limit} of a team can be away at the same time. Please choose other dates.`;
  }
  return { limit: s.limit, teamName, team, department: employee.department, teamSize: mates.length + 1, days, fullDates, blocked, message };
}

module.exports = { KEY, DEFAULTS, LIVE, getSettings, saveSettings, check };
