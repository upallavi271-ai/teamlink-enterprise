// ---------------------------------------------------------------------------
// THE PAYROLL CYCLE (user, 2026-10-12): "payroll monthly calculate Aug 16 to
// Sep 15 and Sep 16 to Oct 15, but the name of the payroll = Sep and Oct."
//
//   A payroll month runs from day [startDay] of the PREVIOUS month to day
//   [startDay - 1] of the month it is NAMED after (the month it ENDS in):
//     startDay 16 -> "Sep 2026" = 16 Aug 2026 - 15 Sep 2026 (31 days)
//                    "Oct 2026" = 16 Sep 2026 - 15 Oct 2026 (30 days)
//                    "Jan 2027" = 16 Dec 2026 - 15 Jan 2027 (31 days)
//   startDay 1 (the default) = the calendar month, exactly as before.
//
// The month KEY ('2026-09') is the payroll's identity everywhere (EmployeePayrollRun.month,
// Payslip.month, PayrollRun.month, vouchers ...). It never changes meaning in the
// database: only the DATES behind a key come from here. ONE module answers
// "which days is payroll month M?" and "which payroll month does date D belong
// to?" so no screen, report or voucher builds the range by itself.
//
// SETTINGS (AppSetting, no schema change):
//   payroll.cycle            { startDay, effectiveFrom }
//        startDay       1 = calendar month, 2..28 = the cycle above
//        effectiveFrom  the FIRST payroll month on the new cycle ('2026-09');
//                       earlier months keep the calendar definition, so history
//                       is never re-dated or recomputed.
//   payroll.lateRule         { every, days, effectiveFrom }     (founder 2026-11-25)
//        every          3 = every 3 late arrivals in a payroll month count as one LOP step
//        days           LOP days for each full group (1): 3 late = 1 LOP, 4 = 1, 5 = 1, 6 = 2
//        effectiveFrom  first payroll month the rule applies to; nothing saved = the old rule
//                       (free late arrivals of the Attendance policy, then half a day each)
//   payroll.unapprovedLeave  { days, effectiveFrom }             (founder 2026-11-25)
//        days           LOP days for each leave day that is NOT approved (2, like absent with no leave applied); one leave day a
//                       month is free whether approved or not; approved leave beyond it = 1 LOP (utils/payrollLeaveRule.js)
//        effectiveFrom  first payroll month the rule applies to; nothing saved = the old arithmetic
//   payroll.leaveCarry       { effectiveFrom }                  (founder 2026-11-25)
//        the unused monthly free leave day is SAVED and covers approved leave before any LOP is cut, until 31 Dec
//        (utils/payrollLeaveCarry.js); nothing saved = the free day is lost each month, as before
//   payroll.absentNoLeave    { days, halfDayDays, effectiveFrom }
//        days           LOP days for a working day ABSENT with NO leave applied (2)
//        halfDayDays    LOP days for a half day with no leave applied (1)
//        effectiveFrom  first payroll month the rule applies to ('2026-09')
// Nothing saved = calendar month and the old absent rule (nothing changes until
// Admin / Super Admin saves it on Payroll -> Payroll policy).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const CYCLE_KEY = 'payroll.cycle';
const ABSENT_KEY = 'payroll.absentNoLeave';
const LATE_KEY = 'payroll.lateRule';
const UNAPPROVED_KEY = 'payroll.unapprovedLeave';
const CARRY_KEY = 'payroll.leaveCarry';
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
const daysInMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
function daysBetween(from, to) { // inclusive
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dayMon = (date) => `${Number(date.slice(8, 10))} ${MON3[Number(date.slice(5, 7)) - 1]}`;
const dayMonYear = (date) => `${dayMon(date)} ${date.slice(0, 4)}`;

// ---- Settings ---------------------------------------------------------------
const CALENDAR = Object.freeze({ startDay: 1, effectiveFrom: null });
const NO_ABSENT_RULE = Object.freeze({ days: null, halfDayDays: 1, effectiveFrom: null });
const NO_LATE_RULE = Object.freeze({ every: null, days: 1, effectiveFrom: null });
const NO_UNAPPROVED_RULE = Object.freeze({ days: null, effectiveFrom: null });
const NO_CARRY_RULE = Object.freeze({ effectiveFrom: null });

function normaliseCycle(raw) {
  const startDay = Number(raw && raw.startDay);
  const ok = Number.isInteger(startDay) && startDay >= 1 && startDay <= 28;
  const eff = raw && isMonth(raw.effectiveFrom) ? raw.effectiveFrom : null;
  if (!ok || startDay === 1 || !eff) return { ...CALENDAR };
  // firstFrom (optional): the first payroll on the cycle starts on THIS date instead of
  // the usual start day, because the days before it were already paid (a shorter first period).
  const ff = raw && isDay(raw.firstFrom) ? raw.firstFrom : null;
  return ff ? { startDay, effectiveFrom: eff, firstFrom: ff } : { startDay, effectiveFrom: eff };
}
function normaliseAbsent(raw) {
  const days = Number(raw && raw.days);
  const half = raw && raw.halfDayDays != null && raw.halfDayDays !== '' ? Number(raw.halfDayDays) : 1;
  const eff = raw && isMonth(raw.effectiveFrom) ? raw.effectiveFrom : null;
  if (!eff || !Number.isFinite(days) || days <= 0) return { ...NO_ABSENT_RULE, halfDayDays: Number.isFinite(half) && half >= 0 ? half : 1 };
  return { days, halfDayDays: Number.isFinite(half) && half >= 0 ? half : 1, effectiveFrom: eff };
}

// every late arrivals = days LOP: a whole number from 2 to 10, LOP days above 0, from a payroll month
function normaliseLate(raw) {
  const every = Number(raw && raw.every);
  const days = raw && raw.days != null && raw.days !== '' ? Number(raw.days) : 1;
  const eff = raw && isMonth(raw.effectiveFrom) ? raw.effectiveFrom : null;
  if (!eff || !Number.isInteger(every) || every < 2 || every > 10 || !Number.isFinite(days) || days <= 0) return { ...NO_LATE_RULE };
  return { every, days, effectiveFrom: eff };
}

// LOP days for a leave day that is not approved: 1 to 5, in halves, from a payroll month
function normaliseUnapproved(raw) {
  const days = Number(raw && raw.days);
  const eff = raw && isMonth(raw.effectiveFrom) ? raw.effectiveFrom : null;
  if (!eff || !Number.isFinite(days) || days < 1 || days > 5 || (days * 2) % 1) return { ...NO_UNAPPROVED_RULE };
  return { days, effectiveFrom: eff };
}

function normaliseCarry(raw) {
  const eff = raw && isMonth(raw.effectiveFrom) ? raw.effectiveFrom : null;
  return eff ? { effectiveFrom: eff } : { ...NO_CARRY_RULE };
}

let cache = null;
let cacheAt = 0;
const TTL_MS = 3000;
const parse = (row) => { try { return row && row.value ? JSON.parse(row.value) : null; } catch { return null; } };

// { cycle, absent } as saved (a short cache: payroll reads it many times a request).
async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < TTL_MS) return cache;
  let rows = [];
  try { rows = await prisma.appSetting.findMany({ where: { key: { in: [CYCLE_KEY, ABSENT_KEY, LATE_KEY, UNAPPROVED_KEY, CARRY_KEY] } } }); } catch { rows = []; }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  cache = {
    cycle: normaliseCycle(parse(byKey.get(CYCLE_KEY))),
    absent: normaliseAbsent(parse(byKey.get(ABSENT_KEY))),
    late: normaliseLate(parse(byKey.get(LATE_KEY))),
    unapproved: normaliseUnapproved(parse(byKey.get(UNAPPROVED_KEY))),
    carry: normaliseCarry(parse(byKey.get(CARRY_KEY))),
    saved: { cycle: !!byKey.get(CYCLE_KEY), absent: !!byKey.get(ABSENT_KEY), late: !!byKey.get(LATE_KEY), unapproved: !!byKey.get(UNAPPROVED_KEY), carry: !!byKey.get(CARRY_KEY) },
    updatedBy: byKey.get(CYCLE_KEY) ? byKey.get(CYCLE_KEY).updatedByName : null,
  };
  cacheAt = Date.now();
  return cache;
}
const clearCache = () => { cache = null; };
// The settings as last read, for the few synchronous builders (voucher payloads): every
// async caller awaits getSettings() first. Nothing read yet = the calendar month.
const lastKnown = () => cache || { cycle: { ...CALENDAR }, absent: { ...NO_ABSENT_RULE }, late: { ...NO_LATE_RULE }, unapproved: { ...NO_UNAPPROVED_RULE }, carry: { ...NO_CARRY_RULE }, saved: { cycle: false, absent: false, late: false, unapproved: false, carry: false } };

// ---- The pure core (settings in, answer out) --------------------------------
// Is `month` on the cycle (not the calendar)?
const cycleApplies = (month, cycle) => !!(cycle && cycle.startDay > 1 && cycle.effectiveFrom && String(month) >= cycle.effectiveFrom);

// cycleOf('2026-09', {startDay:16, effectiveFrom:'2026-09'}) ->
//   { key:'2026-09', name:'Sep', label:'Sep 2026', longLabel:'September 2026',
//     from:'2026-08-16', to:'2026-09-15', days:31, custom:true,
//     rangeText:'16 Aug – 15 Sep', fullRangeText:'16 Aug 2026 – 15 Sep 2026',
//     title:'Sep 2026 payroll', heading:'Sep 2026 payroll · 16 Aug – 15 Sep' }
function cycleOf(month, cycle = CALENDAR) {
  if (!isMonth(month)) throw new Error(`Not a payroll month: ${month}`);
  const [y, m] = month.split('-').map(Number);
  const custom = cycleApplies(month, cycle);
  let from;
  let to;
  if (custom) {
    to = `${month}-${pad(cycle.startDay - 1)}`;
    from = `${addMonths(month, -1)}-${pad(cycle.startDay)}`;
    if (cycle.firstFrom && month === cycle.effectiveFrom && cycle.firstFrom > from && cycle.firstFrom <= to) from = cycle.firstFrom;
  } else {
    from = `${month}-01`;
    to = `${month}-${pad(daysInMonth(month))}`;
  }
  const label = `${MON3[m - 1]} ${y}`;
  const rangeText = `${dayMon(from)} – ${dayMon(to)}`;
  return {
    key: month, name: MON3[m - 1], label, longLabel: `${MONTH_NAMES[m - 1]} ${y}`,
    from, to, days: daysBetween(from, to), custom, startDay: custom ? cycle.startDay : 1,
    rangeText, fullRangeText: `${dayMonYear(from)} – ${dayMonYear(to)}`,
    title: `${label} payroll`, heading: `${label} payroll · ${rangeText}`,
  };
}

// Which payroll month does a date belong to? { month, months:[...all that contain it] }.
// During the switch-over a date can sit inside two cycles (16-31 Aug are in the calendar
// "Aug" AND in the cycle "Sep"): `month` is the earliest, `months` lists both.
function monthOfDate(date, cycle = CALENDAR) {
  if (!isDay(date)) return null;
  const base = date.slice(0, 7);
  const hits = [addMonths(base, -1), base, addMonths(base, 1)].filter((mk) => {
    const c = cycleOf(mk, cycle);
    return date >= c.from && date <= c.to;
  });
  return { month: hits[0] || base, months: hits.length ? hits : [base] };
}

// The payroll months around today for a month picker, newest first.
function monthList(cycle = CALENDAR, { from, to } = {}) {
  const out = [];
  let mk = from;
  while (mk && mk <= to && out.length < 240) { out.push(cycleOf(mk, cycle)); mk = addMonths(mk, 1); }
  return out.reverse();
}

// Days two cycles have in common (0 = none).
function overlapDays(a, b) {
  const from = a.from > b.from ? a.from : b.from;
  const to = a.to < b.to ? a.to : b.to;
  return to >= from ? daysBetween(from, to) : 0;
}

// The rule for an absent working day with no leave applied, for one payroll month:
// { active, days, halfDayDays } (active only from its effective month).
function absentRuleFor(month, absent = NO_ABSENT_RULE) {
  const active = !!(absent && absent.days && absent.effectiveFrom && String(month) >= absent.effectiveFrom);
  return { active, days: active ? Number(absent.days) : 1, halfDayDays: active ? Number(absent.halfDayDays) : 0.5, effectiveFrom: absent ? absent.effectiveFrom : null };
}

// The late-coming rule for one payroll month: { active, every, days, effectiveFrom } (active only from its effective month).
//   active: every `every` late arrivals of the payroll month = `days` LOP (floor(lates / every) x days), replacing the old
//   "free allowance, then half a day each". Not active = the old rule, exactly as before.
function lateRuleFor(month, late = NO_LATE_RULE) {
  const active = !!(late && late.every && late.effectiveFrom && String(month) >= late.effectiveFrom);
  return { active, every: active ? Number(late.every) : null, days: active ? Number(late.days) : null, effectiveFrom: late ? late.effectiveFrom : null };
}

// The rule for leave that is not approved, for one payroll month: { active, days, effectiveFrom } (active only from its effective month).
function unapprovedRuleFor(month, u = NO_UNAPPROVED_RULE) {
  const active = !!(u && u.days && u.effectiveFrom && String(month) >= u.effectiveFrom);
  return { active, days: active ? Number(u.days) : null, effectiveFrom: u ? u.effectiveFrom : null };
}

// Carry-forward leave for one payroll month: { active, effectiveFrom } (active only from its effective month).
function carryRuleFor(month, c = NO_CARRY_RULE) {
  const active = !!(c && c.effectiveFrom && String(month) >= c.effectiveFrom);
  return { active, effectiveFrom: c ? c.effectiveFrom : null };
}

// ---- Async conveniences -----------------------------------------------------
async function cycleFor(month) {
  const s = await getSettings();
  return cycleOf(month, s.cycle);
}
async function monthOf(date) {
  const s = await getSettings();
  return monthOfDate(date, s.cycle);
}
async function lateRule(month) {
  const s = await getSettings();
  return lateRuleFor(month, s.late);
}
async function absentRule(month) {
  const s = await getSettings();
  return absentRuleFor(month, s.absent);
}
const cycleSync = (month) => cycleOf(month, lastKnown().cycle);
const voucherDateSync = (month) => cycleSync(month).to;
// " (16 Aug – 15 Sep)" on a cycle month, "" on a calendar month - added to voucher narrations.
const rangeTail = (month) => { const c = cycleSync(month); return c.custom ? ` (${c.rangeText})` : ''; };
// Voucher / journal date of a payroll month = the LAST day of its period (the
// rule was "last day of the month" for a calendar month; the period's last day
// is the same rule for a cycle: 15 Sep for the Sep payroll).
async function voucherDate(month) { return (await cycleFor(month)).to; }

// "Sep 2026 payroll · 16 Aug – 15 Sep" for any month key.
async function headingFor(month) { return (await cycleFor(month)).heading; }

// ---- Saving (Admin / Super Admin, checked by the route) ---------------------
async function saveCycle({ startDay, effectiveFrom, firstFrom = null }, actor) {
  const sd = Number(startDay);
  if (!Number.isInteger(sd) || sd < 1 || sd > 28) return { error: 'The cycle start day must be a whole day from 1 to 28 (1 = the normal calendar month).' };
  if (sd > 1 && !isMonth(effectiveFrom)) return { error: 'Pick the first payroll month on the new cycle (for example 2026-09).' };
  if (sd > 1 && firstFrom && !isDay(firstFrom)) return { error: 'The first period start date must be a real date like 2026-10-01.' };
  const value = sd === 1 ? { startDay: 1, effectiveFrom: null } : { startDay: sd, effectiveFrom, ...(firstFrom ? { firstFrom } : {}) };
  await prisma.appSetting.upsert({
    where: { key: CYCLE_KEY },
    update: { value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
    create: { key: CYCLE_KEY, value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
  });
  clearCache();
  return { cycle: normaliseCycle(value) };
}
async function saveAbsentRule({ days, halfDayDays, effectiveFrom }, actor) {
  const d = Number(days);
  const h = halfDayDays == null || halfDayDays === '' ? 1 : Number(halfDayDays);
  if (!Number.isFinite(d) || d < 1 || d > 5) return { error: 'Absent without leave must count between 1 and 5 LOP days.' };
  if (!Number.isFinite(h) || h < 0.5 || h > d) return { error: 'A half day without leave must count between 0.5 and the full-day figure.' };
  if (!isMonth(effectiveFrom)) return { error: 'Pick the first payroll month this rule applies to (for example 2026-09).' };
  const value = { days: d, halfDayDays: h, effectiveFrom };
  await prisma.appSetting.upsert({
    where: { key: ABSENT_KEY },
    update: { value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
    create: { key: ABSENT_KEY, value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
  });
  clearCache();
  return { absent: normaliseAbsent(value) };
}

// Late-coming rule (founder 2026-11-25). { off: true } (or no "every") switches it off: the old rule applies again.
async function saveLateRule({ every, days, effectiveFrom, off }, actor) {
  if (off || every === null || every === '' || every === undefined) {
    await prisma.appSetting.deleteMany({ where: { key: LATE_KEY } });
    clearCache();
    return { late: { ...NO_LATE_RULE }, off: true };
  }
  const n = Number(every);
  const d = days == null || days === '' ? 1 : Number(days);
  if (!Number.isInteger(n) || n < 2 || n > 10) return { error: 'Late arrivals per LOP step must be a whole number from 2 to 10 (3 = every 3 late arrivals).' };
  if (!Number.isFinite(d) || d < 0.5 || d > 5 || (d * 2) % 1) return { error: 'LOP days for each step must be from 0.5 to 5, in halves.' };
  if (!isMonth(effectiveFrom)) return { error: 'Pick the first payroll month this rule applies to (for example 2026-12).' };
  const value = { every: n, days: d, effectiveFrom };
  await prisma.appSetting.upsert({
    where: { key: LATE_KEY },
    update: { value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
    create: { key: LATE_KEY, value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
  });
  clearCache();
  return { late: normaliseLate(value) };
}

// Leave-not-approved rule (founder 2026-11-25). { off: true } (or no "days") switches it off: the old arithmetic applies again.
async function saveUnapprovedRule({ days, effectiveFrom, off }, actor) {
  if (off || days === null || days === '' || days === undefined) {
    await prisma.appSetting.deleteMany({ where: { key: UNAPPROVED_KEY } });
    clearCache();
    return { unapproved: { ...NO_UNAPPROVED_RULE }, off: true };
  }
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1 || d > 5 || (d * 2) % 1) return { error: 'A leave that is not approved must count between 1 and 5 LOP days, in halves.' };
  if (!isMonth(effectiveFrom)) return { error: 'Pick the first payroll month this rule applies to (for example 2026-12).' };
  const value = { days: d, effectiveFrom };
  await prisma.appSetting.upsert({
    where: { key: UNAPPROVED_KEY },
    update: { value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
    create: { key: UNAPPROVED_KEY, value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
  });
  clearCache();
  return { unapproved: normaliseUnapproved(value) };
}

// Carry-forward leave (founder 2026-11-25). { off: true } (or no month) switches it off: the free day is lost every month again.
async function saveCarryRule({ effectiveFrom, off }, actor) {
  if (off || !effectiveFrom) {
    await prisma.appSetting.deleteMany({ where: { key: CARRY_KEY } });
    clearCache();
    return { carry: { ...NO_CARRY_RULE }, off: true };
  }
  if (!isMonth(effectiveFrom)) return { error: 'Pick the first payroll month this rule applies to (for example 2026-12).' };
  const value = { effectiveFrom };
  await prisma.appSetting.upsert({
    where: { key: CARRY_KEY },
    update: { value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
    create: { key: CARRY_KEY, value: JSON.stringify(value), updatedById: actor && actor.id || null, updatedByName: actor && actor.name || null },
  });
  clearCache();
  return { carry: normaliseCarry(value) };
}

module.exports = {
  CYCLE_KEY, ABSENT_KEY, LATE_KEY, UNAPPROVED_KEY, CARRY_KEY, CALENDAR, NO_ABSENT_RULE, NO_LATE_RULE, NO_UNAPPROVED_RULE, NO_CARRY_RULE, MON3, MONTH_NAMES,
  isMonth, isDay, addMonths, addDays, daysBetween, daysInMonth, dayMon, dayMonYear,
  normaliseCycle, normaliseAbsent, normaliseLate, normaliseUnapproved, normaliseCarry, getSettings, clearCache, cycleApplies, cycleOf, monthOfDate, monthList, overlapDays,
  absentRuleFor, lateRuleFor, unapprovedRuleFor, carryRuleFor, cycleSync, voucherDateSync, rangeTail, lastKnown, cycleFor, monthOf, absentRule, lateRule, voucherDate, headingFor, saveCycle, saveAbsentRule, saveLateRule, saveUnapprovedRule, saveCarryRule,
};
