// ---------------------------------------------------------------------------
// THE REST OF THE ATTENDANCE / LEAVE POLICY (HRMS changes, items 2, 3, 6).
//
// HrConfig already holds the grace time, the half / full day hours and the
// missing check-in rule. The settings below are NEW and live, with no schema
// change, as JSON on one Integration row (id 'attendance-policy-extra') — the
// same pattern as utils/attendanceAlerts.js. GET /attendance/policy returns
// HrConfig merged with them and PUT /attendance/policy saves both, so Admin
// edits all of it on the one existing Attendance Policy screen.
//
//   workStartTime          09:00   the working day starts
//   workEndTime            18:00   the working day ends
//   halfDaySplit           13:30   first half 09:00-13:30, second half 13:30-18:00
//   earlyLogoutGraceMinutes  0     checking out more than this before the end
//                                  of the day is an Early Logout
//   earlyLogoutFrom        17:00   leaving from this time up to the end of the
//                                  day = Early Logout; leaving BEFORE it = Half
//                                  Day (user, 2026-10-05). 17:00 sharp = Early
//                                  Logout.
//   sandwichLeave         true    a holiday / weekly off between two leave
//                                  days counts as leave
//
// Nothing here is hard-coded anywhere else: every reader asks withExtras().
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { toMinutes } = require('./attendanceMath');

const STORE_ID = 'attendance-policy-extra';
const DEFAULTS = Object.freeze({
  workStartTime: '09:00',
  workEndTime: '18:00',
  halfDaySplit: '13:30',
  earlyLogoutFrom: '17:00',
  // YYYY-MM-DD from which EVERY reader (screens AND payroll / leave balance)
  // uses the 2026-10-05 day rule; days before it keep the old rule. Empty =
  // only the KPI screens show the new rule (utils/attendanceDays.js classifyDay).
  attendanceRulesFrom: '',
  earlyLogoutGraceMinutes: 0,
  sandwichLeave: true,
});
const KEYS = Object.keys(DEFAULTS);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// A short cache: loadDays() is called many times per request burst.
let cache = null;
let cacheAt = 0;
const TTL_MS = 5000;

async function readExtras() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  let values = {};
  try {
    const row = await prisma.integration.findUnique({ where: { id: STORE_ID } });
    values = row && row.values ? JSON.parse(row.values) : {};
  } catch { values = {}; }
  const out = { ...DEFAULTS };
  KEYS.forEach((k) => { if (values[k] !== undefined && values[k] !== null) out[k] = values[k]; });
  cache = out;
  cacheAt = Date.now();
  return out;
}

// HrConfig (or any cfg object) + the extra settings. Keys already on cfg win,
// so a test can pass its own values.
async function withExtras(cfg) {
  const extras = await readExtras();
  const base = cfg || {};
  const out = { ...extras, ...base };
  KEYS.forEach((k) => { if (base[k] === undefined || base[k] === null) out[k] = extras[k]; });
  return out;
}

// Validate + save a patch of the extra settings. Returns { extras } or { error }.
async function saveExtras(patch = {}) {
  const cur = await readExtras();
  const next = { ...cur };
  const errs = [];
  ['workStartTime', 'workEndTime', 'halfDaySplit', 'earlyLogoutFrom'].forEach((k) => {
    if (patch[k] === undefined) return;
    const v = String(patch[k]).trim();
    if (!HHMM.test(v)) errs.push(`${k} must be a 24-hour time like 09:00`);
    else next[k] = v;
  });
  if (patch.earlyLogoutGraceMinutes !== undefined) {
    const n = Number(patch.earlyLogoutGraceMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 240) errs.push('The early logout allowance must be 0 to 240 minutes');
    else next.earlyLogoutGraceMinutes = n;
  }
  if (patch.sandwichLeave !== undefined) next.sandwichLeave = !!patch.sandwichLeave;
  if (patch.attendanceRulesFrom !== undefined) {
    const v = String(patch.attendanceRulesFrom || '').trim();
    if (v && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) errs.push('"New attendance rules from" must be a date like 2026-10-01');
    else next.attendanceRulesFrom = v;
  }
  const s = toMinutes(next.workStartTime);
  const e = toMinutes(next.workEndTime);
  const h = toMinutes(next.halfDaySplit);
  if (!errs.length && !(s < h && h < e)) errs.push('The half-day split must be after the start and before the end of the working day');
  const el = toMinutes(next.earlyLogoutFrom);
  if (!errs.length && !(h <= el && el <= e)) errs.push('"Early logout from" must be between the half-day split and the end of the working day');
  if (errs.length) return { error: errs.join('. ') };
  const changed = KEYS.filter((k) => next[k] !== cur[k]);
  if (changed.length) {
    await prisma.integration.upsert({
      where: { id: STORE_ID },
      update: { values: JSON.stringify(next) },
      create: { id: STORE_ID, enabled: true, state: 'Internal', values: JSON.stringify(next) },
    });
    cache = null;
  }
  return { extras: next, changed };
}

module.exports = { STORE_ID, DEFAULTS, KEYS, readExtras, withExtras, saveExtras };
