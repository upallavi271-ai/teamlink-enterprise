// ---------------------------------------------------------------------------
// ADVANCED MESSAGE SCHEDULER (founder 2026-11-20: "not only one date & time: the recruiter must fully control on which date, how many times
// and at what interval messages go, to ONE candidate or MANY candidates" + automatic messages on ATS events + tracking of every message).
//
//   ONE ENGINE, TWO LEVELS
//     SCHEDULE    a row of the raw table "MessageSchedule": who (candidate, application, requirement, recruiter, interview), how (channel,
//                 subject, words), when (one-time | recurring: daily / weekly on weekdays / monthly on a day / every X hours, days or weeks;
//                 a count, an end date or until stopped; a time zone and a sending window), why (null = a person's own message, or an ATS
//                 trigger), its status (upcoming | active | paused | completed | cancelled | failed) and why it stopped.
//     OCCURRENCE  ONE MESSAGE = a row of the existing table "ScheduledReminder" (kind 'custom', the rows of utils/scheduledMessages.js), with
//                 its scheduleId, its number (seq) and an idempotency key "<scheduleId>#<seq>" (a unique index: the same message can never be
//                 planned twice). It is SENT by the existing worker (utils/scheduledReminders.run every 5 minutes on the real server) through
//                 the existing sender (utils/scheduledMessages.runRow -> utils/messaging.send: the WhatsApp 24-hour / template rule, credits +
//                 the Omni ledger, STOP / do-not-contact, 3 tries with back-off, the sandbox no-op). Sent = the provider ACCEPTED it; Delivered
//                 only when the provider's delivery report says so (utils/messageDelivery -> scheduledReminders.applyDeliveryStatus).
//
//   ROLLING WINDOW: the occurrences of a recurring schedule are planned the next 14 days / at most 20 at a time; the worker adds more as they
//   go (extendDue), so "until manually stopped" works without planning forever. A restart loses nothing: the rows are in the database; a row
//   left in 'sending' by a crash BEFORE the provider was called is put back to 'planned' (it never left), one left AFTER the call started is
//   never sent again by itself (it may have gone) - see scheduledReminders.run.
//
//   EXISTING one-time messages (made by the candidate tab before this) are adopted at start-up: each gets a one-time schedule around it
//   (guarded, idempotent: the row itself is not changed except for its scheduleId / seq / key, so nothing is lost or sent twice).
//
//   STOP RULES (only the related schedules; the reason is written on the schedule):
//     the candidate replied (an inbound WhatsApp / SMS / email, utils/conversations.recordIn) -> the no-response follow-ups of that candidate
//     rejected -> that application's interview confirmation / reminders are cancelled
//     withdrew / dropped (did not join) -> every schedule of that application stops
//     joined -> that application's joining reminders are completed
//     interview rescheduled -> the old interview messages are cancelled and new ones made for the new time (when the trigger is on)
//     documents received / client feedback in -> the document / feedback follow-ups are completed
//   Each trigger also re-checks its own condition when a message is due (gate), so a missed event can never send a stale message.
//
//   ATS TRIGGERS (Administration > Step timing): ALL OFF until the founder switches them on. The automatic interview / joining reminders of
//   utils/scheduledReminders.js keep working exactly as before and are not part of this.
//
//   WHO: recruiter - own candidates; TL / STL - the team; Manager / Admin - everyone (utils/scope candidateWhere); the BDE side sees only
//   counts (never words or numbers); client and candidate logins nothing.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');
const SR = require('./scheduledReminders');

const {
  q, x, nowIso, istDay, stamp, txt, MIN, HOUR, DAY, isAdminLogin, bdeSide,
} = SR.internals;

const CHANNELS = ['WhatsApp', 'SMS', 'Email'];
const KINDS = ['one-time', 'recurring'];
const FREQS = ['daily', 'weekly', 'monthly', 'custom'];
const UNITS = ['hours', 'days', 'weeks'];
const END_MODES = ['count', 'until', 'manual'];
const LIVE = ['upcoming', 'active'];
const OPEN = ['upcoming', 'active', 'paused'];
const STATUSES = ['upcoming', 'active', 'paused', 'completed', 'cancelled', 'failed'];
const OCC_STATUSES = ['planned', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'cancelled'];
const MAX_OCCURRENCES = 100; // 1-100 messages in one schedule
const MAX_PLANNED_CANDIDATE = 100; // max 100 planned occurrences per candidate (recurring)
const WINDOW_DAYS = 14; // the rolling window
const WINDOW_MAX = 20;
const MIN_AHEAD_MIN = 5;
const MAX_AHEAD_DAYS = 365;
const MAX_BULK = 200;
const TIMEZONES = [
  ['Asia/Kolkata', 'India (IST)'], ['Asia/Dubai', 'UAE (Dubai)'], ['Asia/Riyadh', 'Saudi Arabia (Riyadh)'], ['Asia/Qatar', 'Qatar (Doha)'],
  ['Asia/Kuwait', 'Kuwait'], ['Asia/Muscat', 'Oman (Muscat)'], ['Asia/Singapore', 'Singapore'], ['Europe/London', 'United Kingdom (London)'], ['America/New_York', 'USA East (New York)'],
];
const TZ_SHORT = { 'Asia/Kolkata': 'IST' };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const validHm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const validDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const hmMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const minHm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const who = (u) => (u && u.name) || 'System';
const intOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; };
const newSchedId = () => `ms_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
const newOccId = () => `rem_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

// ------------------------------------------------------------------ time zones (exact, through Intl; India is a fixed +05:30)
const fmtCache = new Map();
function partsOf(ms, tz) {
  if (tz === 'Asia/Kolkata') {
    const t = new Date(ms + 330 * MIN);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), wd: t.getUTCDay() };
  }
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const o = {};
  f.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute), wd: WD.indexOf(o.weekday) };
}
// a wall-clock date and time in a zone -> the moment (ms)
function zoned(ymd, hm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = (t) => { const p = partsOf(t, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - t; };
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}
const localDay = (ms, tz) => { const p = partsOf(ms, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const localHm = (ms, tz) => { const p = partsOf(ms, tz); return `${pad(p.h)}:${pad(p.mi)}`; };
const localMin = (ms, tz) => { const p = partsOf(ms, tz); return p.h * 60 + p.mi; };
const dayAdd = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const tzLabel = (tz) => (TZ_SHORT[tz] ? `${TZ_SHORT[tz]} (${tz})` : (TIMEZONES.find((t) => t[0] === tz) || [tz, tz])[1]);
function longDate(ms, tz) { const p = partsOf(ms, tz); return `${p.d} ${MONTHS_LONG[p.m - 1]} ${p.y}`; }
function timeWords(ms, tz) { const p = partsOf(ms, tz); return `${p.h % 12 === 0 ? 12 : p.h % 12}:${pad(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`; }
const whenWords = (ms, tz) => `${WD[partsOf(ms, tz).wd]} ${longDate(ms, tz)}, ${timeWords(ms, tz)}${tz === 'Asia/Kolkata' ? '' : ` (${tzLabel(tz)})`}`;

// ------------------------------------------------------------------ the pattern (pure)
// spec: { kind, frequency, weekdays[], monthDay, intervalValue, intervalUnit, startMs, endMode, totalCount, endDate, timezone, windowStart, windowEnd }
// yields the moments (ms) after `afterMs`, in order. Every-X-hours times outside the sending window are left out (not counted).
function* timesOf(spec, afterMs = -Infinity) {
  const tz = spec.timezone;
  const start = spec.startMs;
  if (spec.kind !== 'recurring') { if (start > afterMs) yield start; return; }
  const hm = localHm(start, tz);
  const day0 = localDay(start, tz);
  const f = spec.frequency;
  let guard = 0;
  if (f === 'custom' && spec.intervalUnit === 'hours') {
    const step = spec.intervalValue * HOUR;
    const lo = hmMin(spec.windowStart);
    const hi = hmMin(spec.windowEnd);
    let i = afterMs > start ? Math.max(0, Math.floor((afterMs - start) / step) - 1) : 0;
    while (guard < 200000) {
      guard += 1;
      const t = start + i * step;
      i += 1;
      if (t <= afterMs) continue; // eslint-disable-line no-continue
      const lm = localMin(t, tz);
      if (lm < lo || lm > hi) continue; // eslint-disable-line no-continue
      yield t;
    }
    return;
  }
  const afterDay = afterMs > start ? localDay(afterMs, tz) : day0;
  if (f === 'daily' || f === 'custom') {
    const stepDays = f === 'daily' ? 1 : (spec.intervalUnit === 'weeks' ? 7 * spec.intervalValue : spec.intervalValue);
    let i = Math.max(0, Math.floor(daysBetween(day0, afterDay) / stepDays) - 1);
    while (guard < 50000) {
      guard += 1;
      const t = zoned(dayAdd(day0, i * stepDays), hm, tz);
      i += 1;
      if (t <= afterMs || t < start) continue; // eslint-disable-line no-continue
      yield t;
    }
    return;
  }
  if (f === 'weekly') {
    let day = afterDay > day0 ? dayAdd(afterDay, -1) : day0;
    while (guard < 50000) {
      guard += 1;
      if (spec.weekdays.includes(weekdayOf(day))) {
        const t = zoned(day, hm, tz);
        if (t > afterMs && t >= start) yield t;
      }
      day = dayAdd(day, 1);
    }
    return;
  }
  if (f === 'monthly') {
    let [y, m] = day0.split('-').map(Number);
    if (afterDay > day0) {
      const [ay, am] = afterDay.split('-').map(Number);
      y = ay; m = am - 1;
      if (m < 1) { m = 12; y -= 1; }
      if (`${y}-${pad(m)}` < day0.slice(0, 7)) [y, m] = day0.split('-').map(Number);
    }
    while (guard < 5000) {
      guard += 1;
      const dd = Math.min(spec.monthDay, lastDayOf(y, m));
      const t = zoned(`${y}-${pad(m)}-${pad(dd)}`, hm, tz);
      if (t > afterMs && t >= start) yield t;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }
}
// the moments of a whole plan, as the engine will plan them (at most `cap` + 1, to tell "too many")
function planTimes(spec, cap = MAX_OCCURRENCES) {
  const out = [];
  for (const t of timesOf(spec)) {
    if (spec.kind === 'recurring' && spec.endMode === 'until' && localDay(t, spec.timezone) > spec.endDate) break;
    out.push(t);
    if (spec.kind !== 'recurring') break;
    if (spec.endMode === 'count' && out.length >= spec.totalCount) break;
    if (out.length > cap) break;
  }
  return out;
}

function frequencyWords(s) {
  if (s.kind !== 'recurring') return 'One-time';
  if (s.frequency === 'daily') return 'Daily';
  if (s.frequency === 'weekly') return `Weekly on ${(s.weekdays || []).map((d) => WD[d]).join(', ')}`;
  if (s.frequency === 'monthly') return `Monthly on day ${s.monthDay}`;
  const u = s.intervalUnit;
  return `Every ${s.intervalValue} ${s.intervalValue === 1 ? u.replace(/s$/, '') : u}`;
}
// "Daily x 5", "Weekly x 4", "One-time", "Every 2 days until 30 Nov 2026", "Daily (until stopped)"
function frequencyLabel(s) {
  if (s.kind !== 'recurring') return 'One-time';
  const base = s.frequency === 'weekly' ? 'Weekly' : s.frequency === 'monthly' ? 'Monthly' : frequencyWords(s);
  if (s.endMode === 'count') return `${base} x ${s.totalCount}`;
  if (s.endMode === 'until') return `${base} until ${s.endDate ? longDate(Date.parse(`${s.endDate}T12:00:00Z`), 'UTC').replace(/ \d{4}$/, '') : '?'}`;
  return `${base} (until stopped)`;
}

// the "Schedule summary" of the screen: exactly the moments the engine will use
function summaryOf(spec) {
  const tz = spec.timezone;
  const times = planTimes(spec);
  const manual = spec.kind === 'recurring' && spec.endMode === 'manual';
  const total = manual ? null : times.length;
  const first = times[0] || null;
  const last = manual ? null : times[times.length - 1] || null;
  const notes = [];
  if (spec.kind === 'recurring' && spec.frequency === 'monthly' && spec.monthDay > 28) {
    const short = times.find((t) => partsOf(t, tz).d !== spec.monthDay);
    notes.push(`In a month with fewer than ${spec.monthDay} days it goes on the last day of that month${short ? ` (for example ${longDate(short, tz)})` : ''}.`);
  }
  if (spec.kind === 'recurring' && spec.frequency === 'custom' && spec.intervalUnit === 'hours') notes.push(`Times outside the sending window (${spec.windowStart}-${spec.windowEnd}) are left out and not counted.`);
  if (manual) notes.push(`It goes on until you stop it. The next ${WINDOW_MAX} messages (or the next ${WINDOW_DAYS} days) are planned at a time and more are added as they go.`);
  const lines = [];
  if (first) {
    lines.push(['Start', longDate(first, tz)], ['Time', timeWords(first, tz)], ['Frequency', frequencyWords(spec)]);
    lines.push(['Total', manual ? 'Until you stop it' : `${total} message${total === 1 ? '' : 's'}`]);
    if (!manual && last) lines.push(['Last message', longDate(last, tz)]);
    lines.push(['Timezone', tzLabel(tz)]);
  }
  return {
    first: first ? new Date(first).toISOString() : null, last: last ? new Date(last).toISOString() : null, total, manual,
    frequency: frequencyWords(spec), label: frequencyLabel(spec), timezone: tz, timezoneLabel: tzLabel(tz), lines, notes,
    times: times.slice(0, manual ? 5 : MAX_OCCURRENCES).map((t) => ({ at: new Date(t).toISOString(), words: whenWords(t, tz) })),
  };
}

// ------------------------------------------------------------------ reading the screen's choices
function cleanSpec(b = {}, settings, base = null) {
  const pick = (k, d) => (b[k] !== undefined ? b[k] : (base && base[k] !== undefined ? base[k] : d));
  const kind = KINDS.includes(pick('kind', 'one-time')) ? pick('kind', 'one-time') : 'one-time';
  const timezone = TIMEZONES.some((t) => t[0] === pick('timezone', 'Asia/Kolkata')) ? pick('timezone', 'Asia/Kolkata') : 'INVALID';
  const lo = settings ? `${pad(settings.earliestHour)}:00` : '07:00';
  const hi = settings ? `${pad(Math.min(23, settings.latestHour))}:${settings.latestHour >= 24 ? '59' : '00'}` : '20:00';
  let startMs = null;
  const sd = b.startDate !== undefined ? b.startDate : null;
  const st = b.startTime !== undefined ? b.startTime : null;
  if (sd || st) startMs = validDay(sd) && validHm(st) && timezone !== 'INVALID' ? zoned(sd, st, timezone) : NaN;
  else if (b.startAt !== undefined || b.sendAt !== undefined) { const t = Date.parse(b.startAt !== undefined ? b.startAt : b.sendAt); startMs = Number.isNaN(t) ? NaN : t; } else if (base && base.startAt) startMs = Date.parse(base.startAt);
  let weekdays = pick('weekdays', []);
  if (typeof weekdays === 'string') weekdays = weekdays.split(',').filter((v) => v !== '');
  weekdays = [...new Set((Array.isArray(weekdays) ? weekdays : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  return {
    kind,
    frequency: kind === 'recurring' ? (FREQS.includes(pick('frequency', 'daily')) ? pick('frequency', 'daily') : 'INVALID') : null,
    weekdays,
    monthDay: intOr(pick('monthDay', null), null),
    intervalValue: intOr(pick('intervalValue', null), null),
    intervalUnit: pick('intervalUnit', 'days'),
    startMs,
    endMode: kind === 'recurring' ? (END_MODES.includes(pick('endMode', 'count')) ? pick('endMode', 'count') : 'INVALID') : 'count',
    totalCount: kind === 'recurring' ? intOr(pick('totalCount', null), null) : 1,
    endDate: pick('endDate', null) || null,
    timezone,
    windowStart: validHm(pick('windowStart', null)) ? pick('windowStart', null) : lo,
    windowEnd: validHm(pick('windowEnd', null)) ? pick('windowEnd', null) : hi,
    _adminLo: lo,
    _adminHi: hi,
    _windowGiven: { s: pick('windowStart', null), e: pick('windowEnd', null) },
  };
}

// -> { spec, summary } or { status, error }
function validateSpec(spec, { now = new Date(), used = 0, startUnchanged = false } = {}) {
  const bad = (error) => ({ status: 400, error });
  if (spec.timezone === 'INVALID') return bad('Pick a time zone from the list.');
  const ws = spec._windowGiven.s; const we = spec._windowGiven.e;
  if ((ws && !validHm(ws)) || (we && !validHm(we))) return bad('Write the sending window as HH:MM, for example 07:00 and 20:00.');
  if (hmMin(spec.windowStart) >= hmMin(spec.windowEnd)) return bad('The sending window must end after it starts.');
  if (hmMin(spec.windowStart) < hmMin(spec._adminLo) || hmMin(spec.windowEnd) > hmMin(spec._adminHi)) return bad(`The sending window must be inside ${spec._adminLo}-${spec._adminHi} (the company's sending hours).`);
  if (spec.startMs === null || Number.isNaN(spec.startMs)) return bad('Pick the start date and time.');
  if (!startUnchanged) {
    if (spec.startMs < now.getTime() + MIN_AHEAD_MIN * MIN) return bad(`The start must be at least ${MIN_AHEAD_MIN} minutes from now (no past dates).`);
    if (spec.startMs > now.getTime() + MAX_AHEAD_DAYS * DAY) return bad('Pick a start within the next year.');
  }
  const sm = localMin(spec.startMs, spec.timezone);
  if (sm < hmMin(spec.windowStart) || sm > hmMin(spec.windowEnd)) return bad(`The start time must be inside the sending window (${spec.windowStart}-${spec.windowEnd}, ${tzLabel(spec.timezone)}).`);
  if (spec.kind === 'recurring') {
    if (spec.frequency === 'INVALID') return bad('Pick how often: daily, weekly, monthly or custom.');
    if (spec.endMode === 'INVALID') return bad('Pick how many times: a number of messages, until a date, or until you stop it.');
    if (spec.frequency === 'weekly' && !spec.weekdays.length) return bad('Pick at least one weekday.');
    if (spec.frequency === 'monthly' && !(Number.isInteger(spec.monthDay) && spec.monthDay >= 1 && spec.monthDay <= 31)) return bad('Pick the day of the month: 1 to 31.');
    if (spec.frequency === 'custom') {
      if (!UNITS.includes(spec.intervalUnit)) return bad('Pick hours, days or weeks.');
      const maxV = { hours: 168, days: 90, weeks: 12 }[spec.intervalUnit];
      if (!(Number.isInteger(spec.intervalValue) && spec.intervalValue >= 1 && spec.intervalValue <= maxV)) return bad(`Write how often: every 1 to ${maxV} ${spec.intervalUnit}.`);
    }
    if (spec.endMode === 'count') {
      if (!(Number.isInteger(spec.totalCount) && spec.totalCount >= 1 && spec.totalCount <= MAX_OCCURRENCES)) return bad(`Write how many messages: 1 to ${MAX_OCCURRENCES}.`);
      if (used && spec.totalCount <= used) return bad(`${used} message${used === 1 ? ' has' : 's have'} already gone or been handled: the total must be more than ${used}.`);
    }
    if (spec.endMode === 'until') {
      if (!validDay(spec.endDate)) return bad('Pick the end date.');
      if (spec.endDate < localDay(spec.startMs, spec.timezone)) return bad('The end date must be on or after the start date.');
    }
  }
  const summary = summaryOf(spec);
  if (!summary.first) return bad('No message falls between the start and the end date. Change the dates or the weekdays.');
  if (summary.total !== null && summary.total > MAX_OCCURRENCES) return bad(`This would send more than ${MAX_OCCURRENCES} messages. Pick an earlier end date or a longer gap.`);
  return { spec, summary };
}

// ------------------------------------------------------------------ the tables
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await SR.ensure();
      await x(`CREATE TABLE IF NOT EXISTS "MessageSchedule" (
        "id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "applicationId" TEXT, "requirementId" TEXT, "recruiterId" TEXT, "interviewId" TEXT,
        "channel" TEXT NOT NULL, "subject" TEXT, "body" TEXT NOT NULL, "language" TEXT NOT NULL DEFAULT 'en',
        "kind" TEXT NOT NULL, "frequency" TEXT, "weekdays" TEXT, "monthDay" INTEGER, "intervalValue" INTEGER, "intervalUnit" TEXT,
        "startAt" TEXT NOT NULL, "endMode" TEXT NOT NULL DEFAULT 'count', "totalCount" INTEGER, "endDate" TEXT,
        "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata', "windowStart" TEXT NOT NULL DEFAULT '07:00', "windowEnd" TEXT NOT NULL DEFAULT '20:00',
        "trigger" TEXT, "triggerAnchor" TEXT, "status" TEXT NOT NULL DEFAULT 'upcoming', "stopReason" TEXT, "stoppedAt" TEXT, "stoppedBy" TEXT,
        "exhausted" INTEGER NOT NULL DEFAULT 0, "lastGeneratedAt" TEXT,
        "createdById" TEXT, "createdBy" TEXT, "editedById" TEXT, "editedBy" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL,
        "idemKey" TEXT, "history" TEXT, "sourceRowId" TEXT)`);
      await x('CREATE UNIQUE INDEX IF NOT EXISTS "MessageSchedule_idem" ON "MessageSchedule" ("idemKey") WHERE "idemKey" IS NOT NULL');
      await x('CREATE INDEX IF NOT EXISTS "MessageSchedule_cand" ON "MessageSchedule" ("candidateId","status")');
      await x('CREATE INDEX IF NOT EXISTS "MessageSchedule_app" ON "MessageSchedule" ("applicationId","trigger")');
      await x('CREATE INDEX IF NOT EXISTS "MessageSchedule_status" ON "MessageSchedule" ("status","kind")');
      // the occurrence columns on the existing rows (utils/scheduledReminders.js "ScheduledReminder")
      for (const [col, type] of [['scheduleId', 'TEXT'], ['seq', 'INTEGER'], ['idemKey', 'TEXT'], ['deliveredAt', 'TEXT'], ['claimedAt', 'TEXT'], ['providerCallAt', 'TEXT']]) {
        // eslint-disable-next-line no-await-in-loop
        await x(`ALTER TABLE "ScheduledReminder" ADD COLUMN "${col}" ${type}`).catch((e) => { if (!/duplicate column/i.test(String(e && e.message))) throw e; });
      }
      await x('CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledReminder_idem" ON "ScheduledReminder" ("idemKey") WHERE "idemKey" IS NOT NULL');
      await x('CREATE INDEX IF NOT EXISTS "ScheduledReminder_sched" ON "ScheduledReminder" ("scheduleId","status")');
      await migrateExisting().catch((e) => console.error('[messageSchedules] adopting the existing messages:', e.message)); // eslint-disable-line no-console
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

// a status for a one-time schedule, from its one message
const statusFromRow = (st) => ({ planned: 'upcoming', sending: 'upcoming', sent: 'completed', delivered: 'completed', failed: 'failed', skipped: 'failed', cancelled: 'cancelled' }[st] || 'upcoming');

// THE START-UP ADOPTION: every manual message made before this (kind 'custom', no schedule) gets a one-time schedule around it.
// Guarded and idempotent: the schedule's id and key come from the row's id (INSERT OR IGNORE), and only rows with no scheduleId are touched.
async function migrateExisting() {
  const rows = await q('SELECT * FROM "ScheduledReminder" WHERE "kind" = \'custom\' AND "scheduleId" IS NULL ORDER BY "createdAt" LIMIT 20000');
  let n = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await adoptRow(r)) n += 1;
  }
  if (n) console.log(`[messageSchedules] ${n} existing scheduled message(s) adopted as one-time schedules`); // eslint-disable-line no-console
  return n;
}
async function adoptRow(rowOrId, extra = {}) {
  const r = typeof rowOrId === 'string' ? (await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', rowOrId))[0] : rowOrId;
  if (!r || r.kind !== 'custom' || r.scheduleId) return null;
  const sid = `ms_m_${r.id}`;
  let reqId = null; let recruiterId = null;
  if (r.applicationId) {
    const app = await prisma.application.findUnique({ where: { id: String(r.applicationId) }, select: { requirementId: true, ownerRecruiterId: true, requirement: { select: { recruiterId: true } } } }).catch(() => null);
    if (app) { reqId = app.requirementId; recruiterId = app.ownerRecruiterId || (app.requirement && app.requirement.recruiterId) || null; }
  }
  const t = nowIso();
  const status = statusFromRow(r.status);
  const hist = JSON.stringify([{ at: t, by: 'System', text: extra.note || 'One-time schedule (kept from the message scheduled before)' }]);
  await x(`INSERT OR IGNORE INTO "MessageSchedule" ("id","candidateId","applicationId","requirementId","recruiterId","channel","subject","body","language","kind","startAt","endMode","totalCount",
    "timezone","windowStart","windowEnd","status","exhausted","lastGeneratedAt","createdById","createdBy","createdAt","updatedAt","idemKey","history","sourceRowId","stopReason")
    VALUES (?,?,?,?,?,?,?,?,?,'one-time',?,'count',1,'Asia/Kolkata','07:00','20:00',?,1,?,?,?,?,?,?,?,?,?)`,
  sid, r.candidateId, r.applicationId || null, reqId, recruiterId || r.createdById || null, r.channel, r.subject || null, r.body || r.message || '', r.language || 'en', r.sendAt, status, r.sendAt,
  r.createdById || null, r.createdBy || null, r.createdAt || t, t, extra.idemKey || `row:${r.id}`, hist, r.id, status === 'cancelled' ? (r.reason || 'Cancelled') : null);
  const done = await x('UPDATE "ScheduledReminder" SET "scheduleId" = ?, "seq" = 1, "idemKey" = ? WHERE "id" = ? AND "scheduleId" IS NULL', sid, `${sid}#1`, r.id);
  return done ? sid : null;
}

// ------------------------------------------------------------------ rows
const getSched = async (id) => (await q('SELECT * FROM "MessageSchedule" WHERE "id" = ?', String(id)))[0] || null;
const occOf = (sid) => q('SELECT * FROM "ScheduledReminder" WHERE "scheduleId" = ? ORDER BY "sendAt", "seq"', String(sid));
function specOfRow(s) {
  return {
    kind: s.kind, frequency: s.frequency, weekdays: String(s.weekdays || '').split(',').filter((v) => v !== '').map(Number), monthDay: s.monthDay == null ? null : Number(s.monthDay),
    intervalValue: s.intervalValue == null ? null : Number(s.intervalValue), intervalUnit: s.intervalUnit, startMs: Date.parse(s.startAt), endMode: s.endMode,
    totalCount: s.totalCount == null ? null : Number(s.totalCount), endDate: s.endDate, timezone: s.timezone || 'Asia/Kolkata', windowStart: s.windowStart || '07:00', windowEnd: s.windowEnd || '20:00',
  };
}
function addHist(s, by, text) {
  let h = [];
  try { h = JSON.parse(s.history || '[]'); } catch { h = []; }
  h.push({ at: nowIso(), by: by || 'System', text: txt(text, 300) });
  return JSON.stringify(h.slice(-60));
}
function countsOf(occ) {
  const c = { total: occ.length, planned: 0, sent: 0, delivered: 0, failed: 0, skipped: 0, cancelled: 0 };
  occ.forEach((o) => {
    if (['planned', 'sending'].includes(o.status)) c.planned += 1;
    else if (o.status === 'sent') c.sent += 1;
    else if (o.status === 'delivered') { c.sent += 1; c.delivered += 1; } else if (o.status in c) c[o.status] += 1;
  });
  return c;
}

// one schedule per line: the 13 things of the founder's table (text only for those who may read it)
function shapeSchedule(s, occ, extra = {}, full = true) {
  const c = countsOf(occ);
  const spec = specOfRow(s);
  const planned = occ.filter((o) => ['planned', 'sending'].includes(o.status)).sort((a, b) => a.sendAt.localeCompare(b.sendAt));
  const sentRows = occ.filter((o) => o.sentAt).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  const totalPlanned = s.kind !== 'recurring' ? 1 : (s.endMode === 'count' ? Number(s.totalCount) : (s.endMode === 'until' ? (summaryOf(spec).total || occ.length) : null));
  const done = c.sent + c.failed + c.skipped;
  return {
    id: s.id, candidateId: s.candidateId, applicationId: s.applicationId || null, requirementId: s.requirementId || null, recruiterId: s.recruiterId || null, interviewId: s.interviewId || null,
    candidate: extra.candidate || null, requirement: extra.requirement || null, recruiter: extra.recruiter || null,
    channel: s.channel, kind: s.kind, frequency: s.frequency, frequencyLabel: frequencyLabel(spec), frequencyWords: frequencyWords(spec),
    weekdays: spec.weekdays, monthDay: spec.monthDay, intervalValue: spec.intervalValue, intervalUnit: s.intervalUnit, endMode: s.endMode, totalCount: s.totalCount == null ? null : Number(s.totalCount), endDate: s.endDate,
    timezone: spec.timezone, windowStart: spec.windowStart, windowEnd: spec.windowEnd, startAt: s.startAt,
    trigger: s.trigger || null, triggerLabel: s.trigger ? ((TRIGGERS.find((t) => t.key === s.trigger) || {}).label || s.trigger) : null, automatic: !!s.trigger,
    status: s.status, stopReason: s.stopReason || null, stoppedAt: s.stoppedAt || null, stoppedBy: s.stoppedBy || null,
    firstAt: occ.length ? occ.map((o) => o.sendAt).sort()[0] : s.startAt,
    nextAt: planned.length && s.status !== 'paused' ? planned[0].sendAt : null,
    totalPlanned, progress: { done, sent: c.sent, total: totalPlanned },
    counts: c, lastSentAt: sentRows.length ? sentRows[0].sentAt : null,
    createdBy: s.createdBy, createdById: s.createdById, createdAt: s.createdAt, editedBy: s.editedBy || null, updatedAt: s.updatedAt,
    ...(full ? { subject: s.subject || '', body: s.body || '' } : {}),
  };
}
function shapeOcc(o, full = true) {
  return {
    id: o.id, scheduleId: o.scheduleId, seq: o.seq == null ? null : Number(o.seq), scheduledAt: o.sendAt, sentAt: o.sentAt || null,
    deliveredAt: o.deliveredAt || (o.status === 'delivered' && o.deliveryStatus && o.deliveryStatus !== 'Sent' ? o.updatedAt : null),
    providerMessageId: full ? (o.providerRef || null) : null, status: o.status === 'sending' ? 'sending' : o.status, deliveryStatus: o.deliveryStatus || null,
    failureReason: full ? (o.reason || null) : (o.status === 'failed' ? 'Not sent' : null), attempts: Number(o.attempts) || 0, nextAttemptAt: o.nextAttemptAt || null, channel: o.channel,
    ...(full ? { text: o.message || null } : {}),
  };
}

// ------------------------------------------------------------------ status, the rolling window
const locks = new Map();
async function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release;
  const p = new Promise((r) => { release = r; });
  locks.set(id, prev.then(() => p));
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(id) === p || locks.size > 500) locks.delete(id); }
}

// the schedule's status from its messages (paused / cancelled stay as they are)
async function refresh(sid) {
  const s = await getSched(sid);
  if (!s || ['paused', 'cancelled'].includes(s.status)) return s;
  if (s.status === 'completed' && s.stopReason) return s;
  const occ = await occOf(sid);
  const c = countsOf(occ);
  let status;
  if (c.planned) status = (c.sent + c.failed + c.skipped) ? 'active' : 'upcoming';
  else if (Number(s.exhausted) === 1 || s.kind !== 'recurring') status = c.sent ? 'completed' : (c.failed + c.skipped ? 'failed' : (c.cancelled ? 'cancelled' : 'completed'));
  else status = (c.sent + c.failed + c.skipped) ? 'active' : 'upcoming';
  if (status !== s.status) await x('UPDATE "MessageSchedule" SET "status" = ?, "updatedAt" = ? WHERE "id" = ?', status, nowIso(), sid);
  return { ...s, status };
}

// plan the next messages of a live schedule: at most 20 waiting (until stopped: also only the next 14 days); the idempotency key makes a second call harmless
async function extend(sid, { now = new Date() } = {}) {
  return withLock(sid, async () => {
    const s = await getSched(sid);
    if (!s || !LIVE.includes(s.status) || Number(s.exhausted) === 1) return 0;
    const spec = specOfRow(s);
    const occ = await occOf(sid);
    let used = occ.length;
    let planned = occ.filter((o) => ['planned', 'sending'].includes(o.status)).length;
    const maxRow = occ.reduce((m, o) => Math.max(m, Date.parse(o.sendAt)), -Infinity);
    let after = Math.max(maxRow, spec.startMs - 1, s.kind === 'recurring' ? now.getTime() : -Infinity);
    const horizon = now.getTime() + WINDOW_DAYS * DAY;
    let made = 0;
    let exhausted = false;
    const it = timesOf(spec, after);
    while (planned < WINDOW_MAX) {
      if (s.kind !== 'recurring' && used >= 1) { exhausted = true; break; }
      if (s.endMode === 'count' && used >= Number(s.totalCount)) { exhausted = true; break; }
      const nx = it.next();
      if (nx.done) { exhausted = true; break; }
      const t = nx.value;
      if (s.endMode === 'until' && localDay(t, spec.timezone) > s.endDate) { exhausted = true; break; }
      // until stopped: only the next 14 days (and at most 20); a schedule with a count or an end date is planned 20 at a time
      if (s.endMode === 'manual' && t > horizon && planned >= 1) break;
      used += 1;
      // eslint-disable-next-line no-await-in-loop
      const ok = await insertOcc(s, used, t);
      if (ok) { made += 1; planned += 1; }
      after = t;
    }
    const lastGen = Number.isFinite(after) && after > 0 ? new Date(after).toISOString() : s.lastGeneratedAt;
    await x('UPDATE "MessageSchedule" SET "exhausted" = ?, "lastGeneratedAt" = ?, "updatedAt" = ? WHERE "id" = ?', exhausted ? 1 : 0, lastGen, nowIso(), sid);
    await refresh(sid);
    return made;
  });
}
async function insertOcc(s, seq, atMs) {
  const t = nowIso();
  const iso = new Date(atMs).toISOString();
  const notify = [...new Set([s.createdById, s.recruiterId].filter(Boolean))].join(',');
  const hist = JSON.stringify([{ at: t, by: 'System', text: `Planned: message ${seq}${s.kind === 'recurring' && s.endMode === 'count' ? ` of ${s.totalCount}` : ''} for ${stamp(iso)}` }]);
  const n = await x(`INSERT OR IGNORE INTO "ScheduledReminder" ("id","applicationId","candidateId","kind","eventAt","sendAt","channel","templateKey","language","status","stepKey","createdById","createdBy","createdAt","updatedAt","notifyIds","history","subject","body","scheduleId","seq","idemKey")
    VALUES (?,?,?,'custom',?,?,?,'custom',?,'planned','MSG',?,?,?,?,?,?,?,?,?,?,?)`,
  newOccId(), s.applicationId || '', s.candidateId, iso, iso, s.channel, s.language || 'en', s.createdById || null, s.createdBy || null, t, t, notify, hist,
  s.channel === 'Email' ? (s.subject || require('./scheduledMessages').DEFAULT_SUBJECT) : null, s.body, s.id, seq, `${s.id}#${seq}`); // eslint-disable-line global-require
  return n > 0;
}
// the worker's pass (scheduledReminders.run): every live recurring schedule whose window runs short is topped up
async function extendDue(now = new Date()) {
  await ensure();
  const cut = new Date(now.getTime() + (WINDOW_DAYS - 1) * DAY).toISOString();
  const rows = await q('SELECT "id" FROM "MessageSchedule" WHERE "status" IN (\'upcoming\',\'active\') AND "kind" = \'recurring\' AND "exhausted" = 0 AND ("lastGeneratedAt" IS NULL OR "lastGeneratedAt" < ?) LIMIT 300', cut);
  let n = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    n += await extend(r.id, { now }).catch(() => 0);
  }
  return n;
}
// the planned messages that never started are taken out (pause, edit); sent / failed / sending ones stay
async function dropPlanned(sid) {
  return x('DELETE FROM "ScheduledReminder" WHERE "scheduleId" = ? AND "status" = \'planned\'', sid);
}
// a schedule stops (cancelled / completed): its waiting messages are cancelled with the reason (kept, so the history shows them)
async function stopOne(s, status, reason, by = 'System', byId = null) {
  if (!s || !OPEN.includes(s.status)) return false;
  const t = nowIso();
  const done = await x('UPDATE "MessageSchedule" SET "status" = ?, "stopReason" = ?, "stoppedAt" = ?, "stoppedBy" = ?, "editedById" = COALESCE(?, "editedById"), "updatedAt" = ?, "history" = ? WHERE "id" = ? AND "status" IN (\'upcoming\',\'active\',\'paused\')',
    status, txt(reason, 300), t, by, byId, t, addHist(s, by, `${status === 'completed' ? 'Completed' : 'Stopped'}: ${reason}`), s.id);
  if (!done) return false;
  const occ = await q('SELECT * FROM "ScheduledReminder" WHERE "scheduleId" = ? AND "status" = \'planned\'', s.id);
  for (const o of occ) {
    // eslint-disable-next-line no-await-in-loop
    await x('UPDATE "ScheduledReminder" SET "status" = \'cancelled\', "reason" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ? AND "status" = \'planned\'', txt(reason, 300), t, SR.internals.addHistory(o, by, `Cancelled: ${reason}`), o.id);
  }
  return true;
}

// ------------------------------------------------------------------ who may
async function scopeOf(user) {
  const P = require('./permissions'); // eslint-disable-line global-require
  if (!user || P.isExternalLogin(user)) return { status: 403, error: 'Not available to this login.' };
  const admin = isAdminLogin(user);
  if (!admin && bdeSide(user)) return { level: 'count', canCreate: false };
  const role = P.stageRoleOf(user);
  if (admin || ['TL', 'STL', 'RECRUITER', 'MANAGER'].includes(role)) return { level: 'full', canCreate: true, scope: admin || role === 'MANAGER' ? 'all' : (['TL', 'STL'].includes(role) ? 'team' : 'own') };
  return { status: 403, error: 'Scheduled messages are for recruiters and team leads.' };
}
// the candidate ids of a list this login may see
async function visibleCandidates(user, ids) {
  const { candidateWhere } = require('./scope'); // eslint-disable-line global-require
  const ok = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    (await prisma.candidate.findMany({ where: { AND: [candidateWhere(user), { id: { in: list.slice(i, i + 400) } }] }, select: { id: true, name: true, phone: true, email: true } })).forEach((c) => ok.set(c.id, c));
  }
  return ok;
}

// ------------------------------------------------------------------ creating (one or many candidates)
// the remaining messages already planned for a candidate (one-time waiting + what the live schedules still owe)
async function plannedFor(candidateId) {
  const live = await q('SELECT * FROM "MessageSchedule" WHERE "candidateId" = ? AND "status" IN (\'upcoming\',\'active\',\'paused\')', String(candidateId));
  let n = 0;
  for (const s of live) {
    // eslint-disable-next-line no-await-in-loop
    const occ = await occOf(s.id);
    const c = countsOf(occ);
    if (s.kind !== 'recurring') n += c.planned;
    else if (s.endMode === 'count') n += Math.max(0, Number(s.totalCount) - (c.sent + c.failed + c.skipped + c.cancelled));
    else if (s.endMode === 'until') { const all = summaryOf(specOfRow(s)).total || 0; n += Math.max(c.planned, all - (c.sent + c.failed + c.skipped + c.cancelled)); } else n += Math.max(c.planned, WINDOW_MAX);
  }
  const loose = await q('SELECT COUNT(*) AS n FROM "ScheduledReminder" WHERE "kind" = \'custom\' AND "candidateId" = ? AND "status" IN (\'planned\',\'sending\') AND "scheduleId" IS NULL', String(candidateId));
  return n + Number(loose[0].n);
}

// b: { candidateIds[] | candidateId, applicationIds{}, applicationId, channel, subject, body, kind, frequency, weekdays, monthDay, intervalValue, intervalUnit,
//      startDate, startTime | startAt, endMode, totalCount, endDate, timezone, windowStart, windowEnd, idempotencyKey }
async function create(user, b = {}, { now = new Date() } = {}) {
  await ensure();
  const acc = await scopeOf(user);
  if (acc.error) return acc;
  if (!acc.canCreate) return { status: 403, error: 'Your team sees only the number of scheduled messages. The recruiter or the team lead schedules them.' };
  const ids = [...new Set((Array.isArray(b.candidateIds) ? b.candidateIds : [b.candidateId]).map((v) => String(v || '').trim()).filter(Boolean))];
  if (!ids.length) return { status: 400, error: 'Pick at least one candidate.' };
  if (ids.length > MAX_BULK) return { status: 400, error: `At most ${MAX_BULK} candidates at a time.` };
  const settings = await SR.loadSettings();
  const spec = cleanSpec(b, settings);
  const v = validateSpec(spec, { now });
  if (v.error) return v;
  const SM = require('./scheduledMessages'); // eslint-disable-line global-require
  const channel = b.channel;
  if (!CHANNELS.includes(channel)) return { status: 400, error: 'Pick WhatsApp, SMS or Email.' };
  const created = [];
  const refused = [];
  const skipped = [];
  const newCount = v.summary.manual ? WINDOW_MAX : v.summary.total;
  const key = txt(b.idempotencyKey, 80);
  for (const cid of ids) {
    // eslint-disable-next-line no-await-in-loop
    const one = await createOne(user, cid, { b, spec, summary: v.summary, settings, channel, SM, newCount, key, now });
    if (one.created) created.push(one.created);
    else if (one.refused) refused.push(one.refused);
    else if (one.skipped) skipped.push(one.skipped);
  }
  const status = created.length ? 201 : (ids.length === 1 ? (refused[0] ? refused[0].status : (skipped[0] ? skipped[0].status : 409)) : 409);
  const out = { status, created, refused, skipped, summary: v.summary };
  if (!created.length && ids.length === 1) out.error = (refused[0] || skipped[0] || {}).reason || 'Not scheduled.';
  if (ids.length > 1) out.message = `${created.length} scheduled${skipped.length ? `, ${skipped.length} skipped` : ''}${refused.length ? `, ${refused.length} refused` : ''}.`;
  return out;
}
async function createOne(user, cid, ctx) {
  const { b, spec, summary, settings, channel, SM, newCount, key } = ctx;
  const acc = await SM.accessOf(user, cid);
  if (acc.error) return { refused: { candidateId: cid, status: acc.status === 404 ? 403 : acc.status, reason: acc.status === 404 ? 'Not one of your candidates (outside your scope), so nothing was scheduled.' : acc.error } };
  if (!acc.canCreate) return { refused: { candidateId: cid, name: acc.cand.name, status: 403, reason: 'Your team sees only the number of scheduled messages.' } };
  const { cand } = acc;
  const m = await SM.checkMessage(cand, { channel, subject: b.subject, body: b.body }, settings);
  if (m.error) {
    const hard = m.status === 400;
    return hard ? { refused: { candidateId: cid, name: cand.name, status: 400, reason: m.error } } : { skipped: { candidateId: cid, name: cand.name, status: m.status, reason: m.error } };
  }
  const idem = key ? `req:${key}:${cid}` : null;
  if (idem) {
    const had = (await q('SELECT * FROM "MessageSchedule" WHERE "idemKey" = ?', idem))[0];
    if (had) return { created: { candidateId: cid, name: cand.name, scheduleId: had.id, repeated: true } };
  }
  // duplicate prevention: the same candidate + way + words + first time, still live
  const firstIso = summary.first;
  const dup = await q('SELECT "id" FROM "MessageSchedule" WHERE "candidateId" = ? AND "channel" = ? AND "body" = ? AND "status" IN (\'upcoming\',\'active\',\'paused\') AND "startAt" = ? LIMIT 1', cand.id, channel, m.text, firstIso);
  const dupRow = await q('SELECT "id" FROM "ScheduledReminder" WHERE "kind" = \'custom\' AND "candidateId" = ? AND "channel" = ? AND "sendAt" = ? AND "body" = ? AND "status" IN (\'planned\',\'sending\') LIMIT 1', cand.id, channel, firstIso, m.text);
  if (dup.length || dupRow.length) return { refused: { candidateId: cid, name: cand.name, status: 409, reason: 'This same message is already scheduled for this candidate at that first time.' } };
  const already = await plannedFor(cand.id);
  if (already + newCount > MAX_PLANNED_CANDIDATE) return { refused: { candidateId: cid, name: cand.name, status: 409, reason: `${cand.name} already has ${already} messages planned: the most is ${MAX_PLANNED_CANDIDATE} per candidate. Cancel some or plan fewer.` } };
  if (spec.kind !== 'recurring') {
    const one = await q('SELECT COUNT(*) AS n FROM "ScheduledReminder" r LEFT JOIN "MessageSchedule" s ON s."id" = r."scheduleId" WHERE r."kind" = \'custom\' AND r."candidateId" = ? AND r."status" IN (\'planned\',\'sending\') AND (s."id" IS NULL OR s."kind" = \'one-time\')', cand.id);
    if (Number(one[0].n) >= SM.MAX_PLANNED) return { refused: { candidateId: cid, name: cand.name, status: 409, reason: `There are already ${SM.MAX_PLANNED} messages waiting for this candidate. Cancel one or wait until some are sent.` } };
  }
  // the application: the one given (must be this candidate's and in scope), else the latest one in scope
  const { applicationWhere } = require('./scope'); // eslint-disable-line global-require
  const wantApp = (b.applicationIds && b.applicationIds[cid]) || (b.candidateIds && b.candidateIds.length > 1 ? null : b.applicationId) || null;
  let app = null;
  if (wantApp) {
    app = await prisma.application.findFirst({ where: { id: String(wantApp), candidateId: cand.id, ...applicationWhere(user) }, select: { id: true, requirementId: true, ownerRecruiterId: true, requirement: { select: { recruiterId: true } } } });
    if (!app) return { refused: { candidateId: cid, name: cand.name, status: 400, reason: 'That application is not one of this candidate\'s.' } };
  } else {
    app = await prisma.application.findFirst({ where: { candidateId: cand.id, ...applicationWhere(user) }, orderBy: { createdAt: 'desc' }, select: { id: true, requirementId: true, ownerRecruiterId: true, requirement: { select: { recruiterId: true } } } });
  }
  const sid = newSchedId();
  const t = nowIso();
  const recruiterId = (app && (app.ownerRecruiterId || (app.requirement && app.requirement.recruiterId))) || user.id;
  const hist = JSON.stringify([{ at: t, by: who(user), text: `Scheduled: ${summary.label}, first ${stamp(summary.first)} by ${channel}` }]);
  const subject = channel === 'Email' ? (m.subj || SM.DEFAULT_SUBJECT) : null;
  try {
    await x(`INSERT INTO "MessageSchedule" ("id","candidateId","applicationId","requirementId","recruiterId","interviewId","channel","subject","body","language","kind","frequency","weekdays","monthDay","intervalValue","intervalUnit",
      "startAt","endMode","totalCount","endDate","timezone","windowStart","windowEnd","status","exhausted","createdById","createdBy","createdAt","updatedAt","idemKey","history")
      VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'upcoming',0,?,?,?,?,?,?)`,
    sid, cand.id, app ? app.id : null, app ? app.requirementId : null, recruiterId, channel, subject, m.text, ['en', 'te'].includes(b.language) ? b.language : 'en', spec.kind,
    spec.kind === 'recurring' ? spec.frequency : null, spec.kind === 'recurring' && spec.frequency === 'weekly' ? spec.weekdays.join(',') : null,
    spec.kind === 'recurring' && spec.frequency === 'monthly' ? spec.monthDay : null, spec.kind === 'recurring' && spec.frequency === 'custom' ? spec.intervalValue : null,
    spec.kind === 'recurring' && spec.frequency === 'custom' ? spec.intervalUnit : null, new Date(spec.startMs).toISOString(), spec.kind === 'recurring' ? spec.endMode : 'count',
    spec.kind === 'recurring' ? (spec.endMode === 'count' ? spec.totalCount : null) : 1, spec.kind === 'recurring' && spec.endMode === 'until' ? spec.endDate : null,
    spec.timezone, spec.windowStart, spec.windowEnd, user.id, who(user), t, t, idem, hist);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message)) && idem) { const had = (await q('SELECT * FROM "MessageSchedule" WHERE "idemKey" = ?', idem))[0]; if (had) return { created: { candidateId: cid, name: cand.name, scheduleId: had.id, repeated: true } }; }
    throw e;
  }
  await extend(sid, { now: ctx.now });
  await logAudit({ userId: user.id, actorName: who(user), action: 'Message schedule created', entity: 'Candidate', entityId: cand.id, toValue: `${summary.label} by ${channel}, first ${stamp(summary.first)}: ${m.text.slice(0, 100)}`.slice(0, 300) }).catch(() => {});
  return { created: { candidateId: cid, name: cand.name, scheduleId: sid } };
}

// ------------------------------------------------------------------ one schedule: read, pause, resume, edit, cancel
async function loadFor(user, id, { needEdit = true } = {}) {
  await ensure();
  const acc = await scopeOf(user);
  if (acc.error) return acc;
  const s = await getSched(id);
  if (!s) return { status: 404, error: 'That schedule is not there.' };
  const ok = await visibleCandidates(user, [s.candidateId]);
  if (!ok.has(s.candidateId)) return { status: 404, error: 'That schedule is not there.' };
  if (needEdit && !acc.canCreate) return { status: 403, error: 'Your team sees only the number of scheduled messages.' };
  return { s, acc, cand: ok.get(s.candidateId) };
}
async function names(rows) {
  const reqIds = [...new Set(rows.map((r) => r.requirementId).filter(Boolean))];
  const userIds = [...new Set(rows.map((r) => r.recruiterId).filter(Boolean))];
  const reqs = new Map((reqIds.length ? await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, title: true, reqCode: true } }) : []).map((r) => [r.id, r]));
  const users = new Map((userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  return { reqs, users };
}
async function getOne(user, id) {
  const got = await loadFor(user, id, { needEdit: false });
  if (got.error) return got;
  const { s, acc, cand } = got;
  const occ = await occOf(s.id);
  const full = acc.level === 'full';
  const { reqs, users } = await names([s]);
  let history = [];
  try { history = JSON.parse(s.history || '[]'); } catch { history = []; }
  return {
    status: 200, access: acc.level,
    schedule: shapeSchedule(s, occ, {
      candidate: full ? { id: cand.id, name: cand.name, phone: cand.phone || null, email: cand.email || null } : { id: cand.id, name: cand.name },
      requirement: s.requirementId && reqs.get(s.requirementId) ? reqs.get(s.requirementId).title : null, recruiter: users.get(s.recruiterId) || null,
    }, full),
    occurrences: occ.map((o) => shapeOcc(o, full)), history: full ? history : [], summary: full ? summaryOf(specOfRow(s)) : null,
  };
}
async function pause(user, id, reason) {
  const got = await loadFor(user, id);
  if (got.error) return got;
  const { s } = got;
  if (!LIVE.includes(s.status)) return { status: 409, error: s.status === 'paused' ? 'This schedule is already paused.' : 'This schedule has ended, so it cannot be paused.' };
  await withLock(s.id, async () => {
    await x('UPDATE "MessageSchedule" SET "status" = \'paused\', "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?', user.id, who(user), nowIso(), addHist(s, who(user), `Paused${reason ? `: ${txt(reason, 200)}` : ''}`), s.id);
    await dropPlanned(s.id);
  });
  await logAudit({ userId: user.id, actorName: who(user), action: 'Message schedule paused', entity: 'Candidate', entityId: s.candidateId, reason: txt(reason, 200) || undefined, toValue: frequencyLabel(specOfRow(s)) }).catch(() => {});
  return getOne(user, s.id);
}
async function resume(user, id, { now = new Date() } = {}) {
  const got = await loadFor(user, id);
  if (got.error) return got;
  const { s } = got;
  if (s.status !== 'paused') return { status: 409, error: 'This schedule is not paused.' };
  const cand = await prisma.candidate.findUnique({ where: { id: s.candidateId }, select: { doNotContact: true, consentStatus: true, name: true } });
  if (cand && (cand.doNotContact || cand.consentStatus === 'WITHDRAWN')) return { status: 409, error: `${cand.name} asked not to be contacted, so the schedule cannot go on.` };
  await x('UPDATE "MessageSchedule" SET "status" = \'upcoming\', "exhausted" = 0, "lastGeneratedAt" = NULL, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?', user.id, who(user), nowIso(), addHist(s, who(user), 'Resumed'), s.id);
  // the next messages after now (the ones whose time passed while paused are not sent late)
  await extend(s.id, { now: new Date(Math.max(now.getTime(), Date.now()) + MIN_AHEAD_MIN * MIN) });
  await refresh(s.id);
  const fresh = await getSched(s.id);
  if (fresh && Number(fresh.exhausted) === 1 && !(await occOf(s.id)).some((o) => o.status === 'planned')) await stopOne(fresh, 'completed', 'Nothing was left to send after the pause.', who(user), user.id);
  await logAudit({ userId: user.id, actorName: who(user), action: 'Message schedule resumed', entity: 'Candidate', entityId: s.candidateId, toValue: frequencyLabel(specOfRow(s)) }).catch(() => {});
  return getOne(user, s.id);
}
async function cancel(user, id, reason) {
  const got = await loadFor(user, id);
  if (got.error) return got;
  const { s } = got;
  if (!OPEN.includes(s.status)) return { status: 409, error: 'This schedule has already ended.' };
  const why = txt(reason, 200);
  const ok = await withLock(s.id, () => stopOne(s, 'cancelled', `Cancelled by ${who(user)}${why ? `: ${why}` : ''}`, who(user), user.id));
  if (!ok) return { status: 409, error: 'This schedule has just ended.' };
  await logAudit({ userId: user.id, actorName: who(user), action: 'Message schedule cancelled', entity: 'Candidate', entityId: s.candidateId, reason: why || undefined, toValue: frequencyLabel(specOfRow(s)) }).catch(() => {});
  return getOne(user, s.id);
}
// edit: the words, the way, the timing. The messages already sent stay; the waiting ones are planned again from the new settings.
async function edit(user, id, b = {}, { now = new Date() } = {}) {
  const got = await loadFor(user, id);
  if (got.error) return got;
  const { s } = got;
  if (!OPEN.includes(s.status)) return { status: 409, error: 'This schedule has ended and cannot be changed. Make a new one instead.' };
  if (s.trigger) return { status: 409, error: 'An automatic message follows its ATS trigger: pause or cancel it here, or change the trigger on Administration > Step timing.' };
  const settings = await SR.loadSettings();
  const SM = require('./scheduledMessages'); // eslint-disable-line global-require
  const cand = await prisma.candidate.findUnique({ where: { id: s.candidateId }, select: { id: true, name: true, phone: true, email: true, doNotContact: true, consentStatus: true } });
  const channel = b.channel !== undefined ? b.channel : s.channel;
  const m = await SM.checkMessage(cand, { channel, subject: b.subject !== undefined ? b.subject : s.subject, body: b.body !== undefined ? b.body : s.body }, settings);
  if (m.error) return m;
  const base = { ...s, weekdays: String(s.weekdays || '').split(',').filter((v) => v !== '').map(Number) };
  const startGiven = b.startDate !== undefined || b.startTime !== undefined || b.startAt !== undefined;
  const spec = cleanSpec({ ...b, ...(startGiven ? {} : { startAt: s.startAt }) }, settings, base);
  if (s.kind === 'one-time' && spec.kind === 'recurring' && (await occOf(s.id)).some((o) => o.status !== 'planned')) return { status: 409, error: 'This message has already been handled. Make a new schedule instead.' };
  const occ = await occOf(s.id);
  const used = occ.filter((o) => o.status !== 'planned').length;
  const startUnchanged = !startGiven || spec.startMs === Date.parse(s.startAt);
  const v = validateSpec(spec, { now, used, startUnchanged });
  if (v.error) return v;
  if (startUnchanged && s.kind === 'one-time' && Date.parse(s.startAt) < now.getTime() + MIN) return { status: 400, error: 'The time of this message has come: pick a new time to change it.' };
  const notes = [];
  if (channel !== s.channel) notes.push(`Way changed to ${channel}`);
  if (m.text !== s.body) notes.push('Words changed');
  if (!startUnchanged) notes.push(`Start changed to ${stamp(new Date(spec.startMs))}`);
  const newLabel = frequencyLabel(spec);
  if (newLabel !== frequencyLabel(specOfRow(s))) notes.push(`Now ${newLabel}`);
  if (spec.timezone !== s.timezone || spec.windowStart !== s.windowStart || spec.windowEnd !== s.windowEnd) notes.push(`Window ${spec.windowStart}-${spec.windowEnd} ${tzLabel(spec.timezone)}`);
  if (channel === 'Email' && (m.subj || SM.DEFAULT_SUBJECT) !== (s.subject || '')) notes.push('Subject changed');
  if (!notes.length) return { status: 400, error: 'Nothing to change.' };
  await withLock(s.id, async () => {
    await dropPlanned(s.id);
    await x(`UPDATE "MessageSchedule" SET "channel" = ?, "subject" = ?, "body" = ?, "kind" = ?, "frequency" = ?, "weekdays" = ?, "monthDay" = ?, "intervalValue" = ?, "intervalUnit" = ?, "startAt" = ?, "endMode" = ?, "totalCount" = ?, "endDate" = ?,
      "timezone" = ?, "windowStart" = ?, "windowEnd" = ?, "status" = CASE WHEN "status" = 'paused' THEN 'paused' ELSE 'upcoming' END, "exhausted" = 0, "lastGeneratedAt" = NULL, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?`,
    channel, channel === 'Email' ? (m.subj || SM.DEFAULT_SUBJECT) : null, m.text, spec.kind, spec.kind === 'recurring' ? spec.frequency : null, spec.kind === 'recurring' && spec.frequency === 'weekly' ? spec.weekdays.join(',') : null,
    spec.kind === 'recurring' && spec.frequency === 'monthly' ? spec.monthDay : null, spec.kind === 'recurring' && spec.frequency === 'custom' ? spec.intervalValue : null, spec.kind === 'recurring' && spec.frequency === 'custom' ? spec.intervalUnit : null,
    new Date(spec.startMs).toISOString(), spec.kind === 'recurring' ? spec.endMode : 'count', spec.kind === 'recurring' ? (spec.endMode === 'count' ? spec.totalCount : null) : 1, spec.kind === 'recurring' && spec.endMode === 'until' ? spec.endDate : null,
    spec.timezone, spec.windowStart, spec.windowEnd, user.id, who(user), nowIso(), addHist(s, who(user), notes.join('; ')), s.id);
  });
  const fresh = await getSched(s.id);
  if (fresh.status !== 'paused') await extend(s.id, { now });
  await logAudit({ userId: user.id, actorName: who(user), action: 'Message schedule changed', entity: 'Candidate', entityId: s.candidateId, toValue: notes.join('; ').slice(0, 300) }).catch(() => {});
  return getOne(user, s.id);
}

// ------------------------------------------------------------------ the page: list, counts, filters, export
const csvList = (v) => String(v || '').split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean);
function rangeOf(qs, now = new Date()) {
  const today = istDay(now);
  const r = String(qs.range || '');
  const map = {
    today: [today, today], tomorrow: [dayAdd(today, 1), dayAdd(today, 1)], next_7: [today, dayAdd(today, 6)], next_30: [today, dayAdd(today, 29)],
    last_7: [dayAdd(today, -6), today], '30d': [dayAdd(today, -29), today], week: [dayAdd(today, -((weekdayOf(today) + 6) % 7)), dayAdd(today, 6 - ((weekdayOf(today) + 6) % 7))],
    month: [`${today.slice(0, 7)}-01`, `${today.slice(0, 7)}-${pad(lastDayOf(Number(today.slice(0, 4)), Number(today.slice(5, 7))))}`],
  };
  if (map[r]) return { from: map[r][0], to: map[r][1] };
  const from = validDay(qs.from) ? qs.from : null;
  const to = validDay(qs.to) ? qs.to : null;
  return from || to ? { from, to } : null;
}
async function listAll(user, qs = {}, { exportAll = false, now = new Date() } = {}) {
  await ensure();
  const acc = await scopeOf(user);
  if (acc.error) return acc;
  const all = await q('SELECT * FROM "MessageSchedule" ORDER BY "createdAt" DESC LIMIT 20000');
  const ok = await visibleCandidates(user, all.map((s) => s.candidateId));
  let mine = all.filter((s) => ok.has(s.candidateId));
  const ids = mine.map((s) => s.id);
  const occBy = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    (await q(`SELECT * FROM "ScheduledReminder" WHERE "scheduleId" IN (${part.map(() => '?').join(',')})`, ...part)).forEach((o) => { const l = occBy.get(o.scheduleId) || []; l.push(o); occBy.set(o.scheduleId, l); });
  }
  const occOfS = (s) => occBy.get(s.id) || [];
  const { reqs, users } = await names(mine);
  // the filters (each a comma list: several values at a time)
  const fRec = csvList(qs.recruiter);
  const fReq = csvList(qs.requirement);
  const fCh = csvList(qs.channel);
  const fSt = csvList(qs.status);
  const fKind = csvList(qs.kind);
  const qText = String(qs.candidate || qs.q || '').trim().toLowerCase();
  const range = rangeOf(qs, now);
  const inRange = (s) => {
    if (!range) return true;
    const lo = range.from ? Date.parse(`${range.from}T00:00:00+05:30`) : -Infinity;
    const hi = range.to ? Date.parse(`${range.to}T00:00:00+05:30`) + DAY : Infinity;
    const times = [Date.parse(s.startAt), ...occOfS(s).map((o) => Date.parse(o.sendAt))];
    return times.some((t) => t >= lo && t < hi);
  };
  const base = mine.filter((s) => (!fRec.length || fRec.includes(s.recruiterId || ''))
    && (!fReq.length || fReq.includes(s.requirementId || ''))
    && (!fCh.length || fCh.includes(s.channel))
    && (!fKind.length || fKind.includes(s.trigger ? 'automatic' : s.kind))
    && (!qText || (ok.get(s.candidateId).name || '').toLowerCase().includes(qText) || (acc.level === 'full' && qText.replace(/\D/g, '').length >= 4 && String(ok.get(s.candidateId).phone || '').replace(/\D/g, '').includes(qText.replace(/\D/g, '')))) // a phone match needs 4+ digits typed ("Sa c2" is a name, not a number)
    && inRange(s));
  const counts = { total: base.length };
  STATUSES.forEach((st) => { counts[st] = base.filter((s) => s.status === st).length; });
  const tab = STATUSES.includes(qs.tab) ? qs.tab : 'all';
  mine = base.filter((s) => (tab === 'all' || s.status === tab) && (!fSt.length || fSt.includes(s.status)));
  const facets = {
    recruiter: [...new Set(base.map((s) => s.recruiterId).filter(Boolean))].map((id) => ({ value: id, label: users.get(id) || 'Unknown', count: base.filter((s) => s.recruiterId === id).length })),
    requirement: [...new Set(base.map((s) => s.requirementId).filter(Boolean))].map((id) => ({ value: id, label: (reqs.get(id) || {}).title || 'Unknown', count: base.filter((s) => s.requirementId === id).length })),
    channel: CHANNELS.map((c) => ({ value: c, label: c, count: base.filter((s) => s.channel === c).length })),
    status: STATUSES.map((st) => ({ value: st, label: st[0].toUpperCase() + st.slice(1), count: base.filter((s) => s.status === st).length })),
    kind: [['one-time', 'One-time'], ['recurring', 'Recurring'], ['automatic', 'Automatic (ATS trigger)']].map(([value, label]) => ({ value, label, count: base.filter((s) => (s.trigger ? 'automatic' : s.kind) === value).length })),
  };
  if (acc.level === 'count') return { status: 200, access: 'count', countOnly: true, counts, note: 'Your team sees only the numbers. The recruiter and the team lead see the messages.' };
  const limit = exportAll ? 20000 : Math.min(500, Math.max(1, intOr(qs.limit, 200)));
  const rows = mine.slice(0, limit).map((s) => {
    const c = ok.get(s.candidateId);
    return shapeSchedule(s, occOfS(s), {
      candidate: { id: c.id, name: c.name, phone: c.phone || null, email: c.email || null }, requirement: s.requirementId && reqs.get(s.requirementId) ? reqs.get(s.requirementId).title : null, recruiter: users.get(s.recruiterId) || null,
    }, true);
  });
  return { status: 200, access: 'full', countOnly: false, scope: acc.scope, counts, rows, total: mine.length, facets, tab, canCreate: acc.canCreate };
}
const EXPORT_HEADERS = ['Candidate', 'Mobile', 'Email', 'Requirement / job', 'Assigned recruiter', 'Channel', 'Frequency', 'Status', 'First scheduled', 'Next scheduled', 'Total planned', 'Sent', 'Delivered', 'Failed', 'Last sent', 'Created by', 'Automatic trigger', 'Stopped because', 'Message'];
const xlTime = (iso) => (iso ? `${istDay(iso)} ${new Date(Date.parse(iso) + 330 * MIN).toISOString().slice(11, 16)}` : '');
function exportRows(rows) {
  return rows.map((r) => [r.candidate.name, r.candidate.phone || '', r.candidate.email || '', r.requirement || '', r.recruiter || '', r.channel, r.frequencyLabel, r.status, xlTime(r.firstAt), xlTime(r.nextAt),
    r.totalPlanned == null ? 'Until stopped' : r.totalPlanned, r.counts.sent, r.counts.delivered, r.counts.failed, xlTime(r.lastSentAt), r.createdBy || '', r.triggerLabel || '', r.stopReason || '', r.body || '']);
}

// the candidate tab / profile: the recurring + automatic schedules of one candidate, and every message of every schedule (communication history)
async function forCandidate(user, candidateId) {
  await ensure();
  const acc = await scopeOf(user);
  if (acc.error) return acc;
  const ok = await visibleCandidates(user, [candidateId]);
  if (!ok.has(String(candidateId))) return { status: 404, error: 'Candidate not found.' };
  const rows = await q('SELECT * FROM "MessageSchedule" WHERE "candidateId" = ? ORDER BY "createdAt" DESC', String(candidateId));
  const occ = await q('SELECT * FROM "ScheduledReminder" WHERE "candidateId" = ? AND "scheduleId" IS NOT NULL ORDER BY "sendAt" DESC', String(candidateId));
  const by = new Map();
  occ.forEach((o) => { const l = by.get(o.scheduleId) || []; l.push(o); by.set(o.scheduleId, l); });
  const { reqs, users } = await names(rows);
  const full = acc.level === 'full';
  const shaped = rows.map((s) => shapeSchedule(s, by.get(s.id) || [], { requirement: s.requirementId && reqs.get(s.requirementId) ? reqs.get(s.requirementId).title : null, recruiter: users.get(s.recruiterId) || null }, full));
  const label = new Map(shaped.map((s) => [s.id, s]));
  return {
    status: 200, access: acc.level,
    schedules: shaped,
    occurrences: full ? occ.map((o) => ({ ...shapeOcc(o, true), scheduleLabel: (label.get(o.scheduleId) || {}).frequencyLabel || '', trigger: (label.get(o.scheduleId) || {}).triggerLabel || null, of: (label.get(o.scheduleId) || {}).totalPlanned })) : [],
    counts: countsOf(occ),
  };
}

// ------------------------------------------------------------------ the gate of one due message (utils/scheduledMessages.runRow, before it is claimed)
// -> null (not part of a schedule) | { window: { tz, lo, hi } } | { stop: true, status, reason }
async function gate(r, now = new Date()) {
  if (!r.scheduleId) return null;
  await ensure();
  const s = await getSched(r.scheduleId);
  if (!s) return null;
  const win = { tz: s.timezone || 'Asia/Kolkata', lo: hmMin(s.windowStart || '07:00'), hi: hmMin(s.windowEnd || '20:00') };
  if (s.status === 'paused') return { stop: true, status: 'cancelled', reason: 'The schedule is paused.' };
  if (['cancelled', 'completed', 'failed'].includes(s.status)) return { stop: true, status: 'cancelled', reason: s.stopReason || `The schedule is ${s.status}.` };
  if (s.trigger) {
    const t = await triggerState(s);
    if (t.stop) {
      await stopOne(s, t.status || 'cancelled', t.reason);
      return { stop: true, status: 'cancelled', reason: t.reason };
    }
  }
  return { window: win, schedule: s };
}
// after a message of a schedule was handled: its status, and the next ones of the window
async function after(r, now = new Date()) {
  if (!r || !r.scheduleId) return;
  try {
    const s = await getSched(r.scheduleId);
    if (s && s.kind === 'recurring' && LIVE.includes(s.status)) await extend(s.id, { now });
    await refresh(r.scheduleId);
  } catch (e) { console.error('[messageSchedules] after:', e.message); } // eslint-disable-line no-console
}
// the one-time message of the candidate tab was changed / cancelled there (utils/scheduledMessages.edit / cancel): its schedule follows
async function syncFromRow(rowId, user) {
  try {
    await ensure();
    const [r] = await q('SELECT * FROM "ScheduledReminder" WHERE "id" = ?', String(rowId));
    if (!r) return;
    if (!r.scheduleId) { await adoptRow(r); return; }
    const s = await getSched(r.scheduleId);
    if (!s || s.kind !== 'one-time') { await refresh(r.scheduleId); return; }
    if (r.status === 'cancelled') { await stopOne(s, 'cancelled', r.reason || 'Cancelled', who(user), user ? user.id : null); return; }
    await x('UPDATE "MessageSchedule" SET "channel" = ?, "subject" = ?, "body" = ?, "startAt" = ?, "lastGeneratedAt" = ?, "editedById" = ?, "editedBy" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
      r.channel, r.subject || null, r.body || '', r.sendAt, r.sendAt, user ? user.id : null, user ? who(user) : null, nowIso(), addHist(s, who(user), 'Changed on the candidate tab'), s.id);
    await refresh(s.id);
  } catch (e) { console.error('[messageSchedules] syncFromRow:', e.message); } // eslint-disable-line no-console
}

// ------------------------------------------------------------------ ATS TRIGGERS (Candidate Follow-up Scheduler) - six ON by default (defaultOn), the rest OFF;
// an Admin's saved choice always wins (founder 2026-11-20)
const TRIGGER_KEY = 'message-triggers';
// mode: after (once, a delay after the event) | repeat (a delay, then every X, at most N, until the condition ends) | before (offsets before the interview / joining)
const TRIGGERS = [
  { key: 'application_received', label: 'Application received', event: 'When a candidate is added to a requirement', mode: 'after', delay: { value: 0, unit: 'minutes' }, group: 'application',
    body: 'Hi {name}, thank you for your interest in {requirement}. {recruiter} from {company} is looking at your profile and will be in touch soon.' },
  { key: 'application_followup', label: 'Initial follow-up', event: 'After the candidate is added, until the candidate replies', mode: 'repeat', delay: { value: 1, unit: 'days' }, every: { value: 2, unit: 'days' }, count: 2, noResponse: true, group: 'application',
    body: 'Hi {name}, {recruiter} from {company} here about {requirement}. Please reply to this message or call me back when you are free.' },
  { key: 'response_followup', defaultOn: true, label: 'Candidate response follow-up', event: 'When the client shortlists the candidate: until the candidate replies with their availability', mode: 'repeat', delay: { value: 2, unit: 'hours' }, every: { value: 1, unit: 'days' }, count: 3, noResponse: true, group: 'application', stage: 'CLIENT_SHORTLISTED',
    body: 'Hi {name}, good news: you are shortlisted for {requirement}. Please reply with the days and times you are free for the interview. - {recruiter}, {company}' },
  { key: 'interview_confirmation', defaultOn: true, label: 'Interview confirmation', event: 'When an interview is booked or moved', mode: 'after', delay: { value: 0, unit: 'minutes' }, group: 'interview',
    body: 'Hi {name}, your interview for {requirement} is booked for {interview_date} at {interview_time}. Please reply YES to confirm. - {recruiter}, {company}' },
  { key: 'interview_reminder', label: 'Interview reminder', event: 'Before the interview', mode: 'before', offsets: [{ value: 1, unit: 'days' }, { value: 1, unit: 'hours' }], group: 'interview',
    body: 'Hi {name}, a reminder: your interview for {requirement} is on {interview_date} at {interview_time}. All the best! - {recruiter}, {company}' },
  { key: 'interview_followup', defaultOn: true, label: 'Interview completed follow-up', event: 'After the interview is done', mode: 'after', delay: { value: 1, unit: 'days' }, noResponse: true, group: 'feedback', stage: 'INTERVIEW_COMPLETED',
    body: 'Hi {name}, thank you for attending the interview for {requirement}. How did it go? Please reply and tell me. - {recruiter}, {company}' },
  { key: 'client_feedback', defaultOn: true, label: 'Client feedback pending', event: 'After the interview is done, while the client\'s feedback is awaited', mode: 'repeat', delay: { value: 2, unit: 'days' }, every: { value: 2, unit: 'days' }, count: 3, group: 'feedback', stage: 'INTERVIEW_COMPLETED',
    body: 'Hi {name}, we are still waiting for the feedback on your interview for {requirement}. I will tell you as soon as we hear back. - {recruiter}, {company}' },
  { key: 'document_request', defaultOn: true, label: 'Document request', event: 'After the offer is accepted, until the documents are received', mode: 'repeat', delay: { value: 1, unit: 'days' }, every: { value: 2, unit: 'days' }, count: 5, group: 'documents', stage: 'OFFER_ACCEPTED',
    body: 'Hi {name}, for {requirement} please send your documents: ID proof, education and experience certificates and the last salary slips. - {recruiter}, {company}' },
  { key: 'selection', defaultOn: true, label: 'Selection message', event: 'When the candidate is selected', mode: 'after', delay: { value: 0, unit: 'minutes' }, group: 'selection', stage: 'SELECTED',
    body: 'Hi {name}, congratulations! You are selected for {requirement}. {recruiter} will call you about the next steps. - {company}' },
  { key: 'joining_reminder', label: 'Joining reminder', event: 'Before the joining date', mode: 'before', offsets: [{ value: 2, unit: 'days' }, { value: 1, unit: 'days' }], group: 'joining',
    body: 'Hi {name}, a reminder: you join {requirement} on {joining_date}. Please bring your ID proof and documents. - {recruiter}, {company}' },
];
const TRIGGER_TOKENS = ['interview_date', 'interview_time', 'joining_date'];
const INTERVIEW_TRIGGERS = ['interview_confirmation', 'interview_reminder'];
const NO_RESPONSE = TRIGGERS.filter((t) => t.noResponse).map((t) => t.key);
const DELAY_UNITS = ['minutes', 'hours', 'days'];

function cleanTrigger(def, v = {}) {
  const o = v && typeof v === 'object' ? v : {};
  const unitOk = (u, list, d) => (list.includes(u) ? u : d);
  const out = {
    key: def.key, enabled: o.enabled === undefined ? !!def.defaultOn : o.enabled === true, channel: CHANNELS.includes(o.channel) ? o.channel : 'WhatsApp',
    subject: txt(o.subject, 150) || `${def.label}: {requirement}`, body: String(o.body == null ? def.body : o.body).replace(/\r/g, '').trim().slice(0, 1000) || def.body,
  };
  if (def.mode !== 'before') out.delay = { value: Math.max(0, Math.min(720, intOr(o.delay && o.delay.value, def.delay.value))), unit: unitOk(o.delay && o.delay.unit, DELAY_UNITS, def.delay.unit) };
  if (def.mode === 'repeat') {
    out.every = { value: Math.max(1, Math.min(90, intOr(o.every && o.every.value, def.every.value))), unit: unitOk(o.every && o.every.unit, ['hours', 'days'], def.every.unit) };
    out.count = Math.max(1, Math.min(10, intOr(o.count, def.count)));
  }
  if (def.mode === 'before') {
    const list = Array.isArray(o.offsets) ? o.offsets : def.offsets;
    out.offsets = list.slice(0, 3).map((f) => ({ value: Math.max(1, Math.min(30, intOr(f && f.value, 1))), unit: unitOk(f && f.unit, ['hours', 'days'], 'days') }));
    if (!out.offsets.length) out.offsets = def.offsets;
  }
  return out;
}
async function loadTriggers() {
  const row = await prisma.appSetting.findUnique({ where: { key: TRIGGER_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  const out = {};
  TRIGGERS.forEach((d) => { out[d.key] = cleanTrigger(d, v[d.key]); });
  return { triggers: out, updatedByName: row ? row.updatedByName : null, updatedAt: row ? row.updatedAt : null };
}
async function saveTriggers(user, patch = {}) {
  if (!isAdminLogin(user)) return { status: 403, error: 'Only an Admin can change the automatic messages.' };
  const cur = (await loadTriggers()).triggers;
  const next = {};
  const SM = require('./scheduledMessages'); // eslint-disable-line global-require
  const known = new Set([...SM.PLACEHOLDERS.map((p) => p[0]), ...TRIGGER_TOKENS]);
  for (const d of TRIGGERS) {
    const p = patch && patch[d.key];
    next[d.key] = cleanTrigger(d, p ? { ...cur[d.key], ...p } : cur[d.key]);
    const bad = [...`${next[d.key].body} ${next[d.key].subject}`.matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1].toLowerCase()).filter((n) => !known.has(n));
    if (bad.length) return { status: 400, error: `${d.label}: these placeholders are not known: ${[...new Set(bad)].map((b) => `{${b}}`).join(', ')}.` };
  }
  await prisma.appSetting.upsert({ where: { key: TRIGGER_KEY }, create: { key: TRIGGER_KEY, value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name }, update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name } });
  const on = TRIGGERS.filter((d) => next[d.key].enabled).map((d) => d.label);
  await logAudit({ userId: user.id, actorName: who(user), action: 'Automatic candidate messages changed', entity: 'AppSetting', entityId: TRIGGER_KEY, toValue: (on.length ? `On: ${on.join(', ')}` : 'All off').slice(0, 300) }).catch(() => {});
  return { status: 200, ...(await loadTriggers()), message: on.length ? `Saved. On: ${on.join(', ')}.` : 'Saved. All automatic messages are off.' };
}

const unitMs = (u) => ({ minutes: MIN, hours: HOUR, days: DAY, weeks: 7 * DAY }[u] || DAY);
// the nearest moment inside the window at or after t (India time: the triggers follow the company's hours)
function clampForward(t, lo, hi, tz = 'Asia/Kolkata') {
  const m = localMin(t, tz);
  if (m >= lo && m <= hi) return t;
  const day = localDay(t, tz);
  return m < lo ? zoned(day, minHm(lo), tz) : zoned(dayAdd(day, 1), minHm(lo), tz);
}
function clampSameDay(t, lo, hi, tz = 'Asia/Kolkata') {
  const m = localMin(t, tz);
  if (m >= lo && m <= hi) return t;
  return zoned(localDay(t, tz), minHm(Math.min(hi, Math.max(lo, m))), tz);
}
const APP_SEL = { candidate: true, requirement: { include: { client: true } } };
async function loadAppFull(applicationId) { return prisma.application.findUnique({ where: { id: String(applicationId) }, include: APP_SEL }).catch(() => null); }
function anchorOf(def, app, settings, info) {
  if (def.group === 'interview') return app.interviewAt ? new Date(app.interviewAt) : null;
  if (def.group === 'joining') {
    const ev = SR.eventOf(app, 'joining', settings, info);
    return ev.live ? ev.eventAt : null;
  }
  return null;
}
function tokenText(body, app, settings, info) {
  const tz = 'Asia/Kolkata';
  const iv = app.interviewAt ? Date.parse(app.interviewAt) : null;
  const jv = SR.eventOf(app, 'joining', settings, info);
  const vals = {
    interview_date: iv ? `${WD_LONG[partsOf(iv, tz).wd]} ${longDate(iv, tz)}` : 'the date we shared',
    interview_time: iv ? timeWords(iv, tz) : 'the time we shared',
    joining_date: jv.live ? `${WD_LONG[partsOf(jv.eventAt.getTime(), tz).wd]} ${longDate(jv.eventAt.getTime(), tz)}` : (app.joiningDate ? longDate(Date.parse(`${String(app.joiningDate).slice(0, 10)}T12:00:00Z`), 'UTC') : 'your joining date'),
  };
  return String(body || '').replace(/\{(interview_date|interview_time|joining_date)\}/gi, (m, n) => vals[n.toLowerCase()]);
}

// fire one trigger for one application. Idempotent: the key is trigger + application + anchor (+ offset).
async function fire(key, app, { actor = null, now = new Date(), settings: st, triggers } = {}) {
  const def = TRIGGERS.find((t) => t.key === key);
  if (!def || !app) return [];
  const tr = (triggers || (await loadTriggers()).triggers)[key];
  if (!tr || !tr.enabled) return [];
  const cand = app.candidate;
  if (!cand || cand.doNotContact || cand.consentStatus === 'WITHDRAWN') return [];
  if (/zztest|example\.test/i.test(`${cand.name} ${cand.email}`) && !SR.internals.sandboxOn()) return [];
  const settings = st || await SR.loadSettings();
  const lo = settings.earliestHour * 60;
  const hi = Math.min(23 * 60 + 59, settings.latestHour * 60);
  const core = require('./messagingCore'); // eslint-disable-line global-require
  if (tr.channel === 'Email' ? !(cand.email && core.validEmail(cand.email)) : !(cand.phone && core.normalizeMobile(cand.phone).ok)) return [];
  if (tr.channel !== 'Email' && await require('./messageDelivery').optedOut(tr.channel, core.normalizeMobile(cand.phone).e164)) return []; // eslint-disable-line global-require
  const info = def.group === 'joining' ? await SR.infoOf(app.id, 'joining').catch(() => null) : null;
  const anchor = anchorOf(def, app, settings, info);
  if (['interview', 'joining'].includes(def.group) && !anchor) return [];
  const t0 = now.getTime();
  const anchorIso = anchor ? anchor.toISOString() : null;
  const plans = [];
  if (def.mode === 'before') {
    tr.offsets.forEach((f, i) => {
      const at = clampSameDay(anchor.getTime() - f.value * unitMs(f.unit), lo, hi);
      if (at > t0 + MIN && at < anchor.getTime() - 10 * MIN) plans.push({ i, kind: 'one-time', at, label: `${f.value} ${f.value === 1 ? f.unit.replace(/s$/, '') : f.unit} before` });
    });
  } else {
    // "after" counts from the event (now)
    let at = clampForward(t0 + tr.delay.value * unitMs(tr.delay.unit), lo, hi);
    if (at < t0 + MIN) at = t0 + MIN;
    if (def.group === 'interview' && anchor && at >= anchor.getTime() - 10 * MIN) return [];
    if (def.mode === 'repeat') plans.push({ i: 0, kind: 'recurring', at, every: tr.every, count: tr.count });
    else plans.push({ i: 0, kind: 'one-time', at });
  }
  const made = [];
  const recruiterId = app.ownerRecruiterId || (app.requirement && app.requirement.recruiterId) || (actor && actor.id) || null;
  for (const p of plans) {
    const idem = `trg|${key}|${app.id}|${anchorIso || app.id}|${p.i}`;
    // eslint-disable-next-line no-await-in-loop
    const had = await q('SELECT "id" FROM "MessageSchedule" WHERE "idemKey" = ?', idem);
    if (had.length) continue; // eslint-disable-line no-continue
    const sid = newSchedId();
    const ts = nowIso();
    const win = { s: minHm(lo), e: minHm(hi) };
    const body = tokenText(tr.body, app, settings, info);
    const subject = tr.channel === 'Email' ? tokenText(tr.subject, app, settings, info) : null;
    const hist = JSON.stringify([{ at: ts, by: 'System', text: `Made by the ATS trigger "${def.label}"${p.label ? ` (${p.label})` : ''}${actor && actor.name ? ` after ${actor.name}'s action` : ''}` }]);
    const recurring = p.kind === 'recurring';
    // eslint-disable-next-line no-await-in-loop
    await x(`INSERT OR IGNORE INTO "MessageSchedule" ("id","candidateId","applicationId","requirementId","recruiterId","interviewId","channel","subject","body","language","kind","frequency","intervalValue","intervalUnit",
      "startAt","endMode","totalCount","timezone","windowStart","windowEnd","trigger","triggerAnchor","status","exhausted","createdById","createdBy","createdAt","updatedAt","idemKey","history")
      VALUES (?,?,?,?,?,?,?,?,?,'en',?,?,?,?,?,'count',?,'Asia/Kolkata',?,?,?,?,'upcoming',0,?,?,?,?,?,?)`,
    sid, app.candidateId, app.id, app.requirementId, recruiterId, def.group === 'interview' && anchorIso ? `${app.id}@${anchorIso}` : null, tr.channel, subject, body,
    recurring ? 'recurring' : 'one-time', recurring ? 'custom' : null, recurring ? p.every.value : null, recurring ? p.every.unit : null, new Date(p.at).toISOString(), recurring ? p.count : 1,
    win.s, win.e, key, anchorIso, recruiterId, `Automatic: ${def.label}`, ts, ts, idem, hist);
    // eslint-disable-next-line no-await-in-loop
    await extend(sid, { now });
    made.push(sid);
  }
  return made;
}

// is the reason for this automatic schedule still true? -> { stop, status, reason }
async function triggerState(s) {
  const def = TRIGGERS.find((t) => t.key === s.trigger);
  if (!def) return { stop: false };
  const tr = (await loadTriggers()).triggers[s.trigger];
  if (!tr || !tr.enabled) return { stop: true, status: 'cancelled', reason: `An Admin switched the automatic "${def.label}" message off.` };
  const app = s.applicationId ? await loadAppFull(s.applicationId) : null;
  if (!app) return { stop: true, status: 'cancelled', reason: 'The application is not there any more.' };
  if (app.joiningStatus === 'Dropped') return { stop: true, status: 'cancelled', reason: 'The candidate dropped (did not join).' };
  if (def.noResponse && await repliedSince(s.candidateId, s.createdAt)) return { stop: true, status: 'completed', reason: 'The candidate replied.' };
  const stage = app.stage;
  const settings = await SR.loadSettings();
  switch (s.trigger) {
    case 'interview_confirmation':
    case 'interview_reminder': {
      if (stage === 'REJECTED') return { stop: true, status: 'cancelled', reason: 'The candidate was rejected.' };
      const ev = SR.eventOf(app, 'interview', settings, null);
      if (!ev.live) return { stop: true, status: 'cancelled', reason: ev.reason };
      if (s.triggerAnchor && ev.eventAt.toISOString() !== s.triggerAnchor) return { stop: true, status: 'cancelled', reason: 'The interview was moved to another time.' };
      return { stop: false };
    }
    case 'joining_reminder': {
      if (['JOINED', 'HIRED'].includes(stage) || app.joiningStatus === 'Joined') return { stop: true, status: 'completed', reason: 'The candidate joined.' };
      const info = await SR.infoOf(app.id, 'joining').catch(() => null);
      const ev = SR.eventOf(app, 'joining', settings, info);
      if (!ev.live) return { stop: true, status: 'cancelled', reason: ev.reason };
      if (s.triggerAnchor && ev.eventAt.toISOString() !== s.triggerAnchor) return { stop: true, status: 'cancelled', reason: 'The joining date changed.' };
      return { stop: false };
    }
    case 'document_request':
      if (['Submitted', 'Verified'].includes(app.documentsStatus)) return { stop: true, status: 'completed', reason: `The documents were received (${app.documentsStatus}).` };
      if (!['OFFER_ACCEPTED'].includes(stage)) return { stop: true, status: 'completed', reason: 'The candidate moved on from waiting for documents.' };
      return { stop: false };
    case 'client_feedback':
      if (stage !== 'INTERVIEW_COMPLETED') return { stop: true, status: 'completed', reason: 'The client\'s feedback is in (the candidate moved on).' };
      return { stop: false };
    case 'response_followup':
      if (stage !== 'CLIENT_SHORTLISTED') return { stop: true, status: 'completed', reason: 'The candidate moved on from the shortlist.' };
      return { stop: false };
    case 'interview_followup':
      if (stage === 'REJECTED') return { stop: true, status: 'cancelled', reason: 'The candidate was rejected.' };
      return { stop: false };
    case 'application_received':
    case 'application_followup':
      if (stage === 'REJECTED') return { stop: true, status: 'cancelled', reason: 'The candidate was rejected for this requirement.' };
      return { stop: false };
    case 'selection':
      if (!['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(stage)) return { stop: true, status: 'cancelled', reason: 'The candidate is not selected any more.' };
      return { stop: false };
    default: return { stop: false };
  }
}
async function repliedSince(candidateId, sinceIso) {
  const since = new Date(sinceIso);
  const n = await prisma.candidateMessage.count({ where: { candidateId: String(candidateId), status: 'RECEIVED', OR: [{ sentAt: { gt: since } }, { sentAt: null, createdAt: { gt: since } }] } }).catch(() => 0);
  return n > 0;
}

// stop the related live schedules. where: { candidateId?, applicationId?, triggers?: [], manualToo?: bool, anchorNot?: iso }
async function stopWhere(where, status, reason, actor = null) {
  await ensure();
  const conds = ['"status" IN (\'upcoming\',\'active\',\'paused\')'];
  const args = [];
  if (where.candidateId) { conds.push('"candidateId" = ?'); args.push(String(where.candidateId)); }
  if (where.applicationId) { conds.push('"applicationId" = ?'); args.push(String(where.applicationId)); }
  if (!where.candidateId && !where.applicationId) return 0;
  const rows = await q(`SELECT * FROM "MessageSchedule" WHERE ${conds.join(' AND ')}`, ...args);
  let n = 0;
  for (const s of rows) {
    if (where.triggers && !(s.trigger && where.triggers.includes(s.trigger))) continue; // eslint-disable-line no-continue
    if (!where.triggers && !s.trigger && !where.manualToo) continue; // eslint-disable-line no-continue
    if (where.anchorNot && s.triggerAnchor === where.anchorNot) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if (await withLock(s.id, () => stopOne(s, status, reason, actor ? who(actor) : 'System', actor ? actor.id : null))) n += 1;
  }
  if (n) await logAudit({ userId: actor && actor.id, actorName: actor ? who(actor) : 'System', action: 'Message schedules stopped', entity: where.applicationId ? 'Application' : 'Candidate', entityId: where.applicationId || where.candidateId, toValue: `${n} schedule(s): ${reason}`.slice(0, 300) }).catch(() => {});
  return n;
}

// stop the given schedules (a sequence that ended: utils/mkt/comms.js) -> how many stopped
async function stopIds(ids, status, reason) {
  await ensure();
  let n = 0;
  for (const id of ids || []) {
    // eslint-disable-next-line no-await-in-loop
    const s = await getSched(id);
    // eslint-disable-next-line no-await-in-loop
    if (s && await withLock(s.id, () => stopOne(s, status, reason, 'System', null))) n += 1;
  }
  return n;
}

// THE CANDIDATE REPLIED (utils/conversations.recordIn): the no-response follow-ups of that candidate stop
async function onCandidateReply(candidateId, channel) {
  try {
    if (!candidateId) return 0;
    // the multi-step candidate sequences (market wave 2026-11-21, utils/mkt/comms.js) stop on a reply too
    await require('./mkt/comms').onCandidateReply(candidateId, channel).catch(() => 0); // eslint-disable-line global-require
    return await stopWhere({ candidateId, triggers: NO_RESPONSE }, 'completed', `The candidate replied${channel ? ` on ${channel}` : ''}.`);
  } catch (e) { console.error('[messageSchedules] reply:', e.message); return 0; } // eslint-disable-line no-console
}

// a candidate was added to a requirement (routes/applications.js addApplication)
async function onApplicationCreated(application, actor) {
  try {
    await ensure();
    const { triggers } = await loadTriggers();
    if (!triggers.application_received.enabled && !triggers.application_followup.enabled) return [];
    const app = await loadAppFull(application.id);
    const out = [];
    out.push(...await fire('application_received', app, { actor, triggers }));
    out.push(...await fire('application_followup', app, { actor, triggers }));
    return out;
  } catch (e) { console.error('[messageSchedules] application:', e.message); return []; } // eslint-disable-line no-console
}

// EVERY STAGE MOVE (utils/candidateComms.recordStageCommunications): the stop rules and the stage triggers
const isWithdrawal = (ev) => !!ev && (ev.actorSide === 'Candidate' || /withdr|not interested|declin|backed out|did not join|no.?show/i.test(`${ev.reasonCategory || ''} ${ev.reasonDetail || ''}`));
async function onStageMove({ application, toStage, fromStage, user }) {
  try {
    if (!application || !application.id || !toStage || toStage === fromStage) return;
    await ensure();
    if (toStage === 'REJECTED') {
      const ev = await prisma.applicationStageEvent.findFirst({ where: { applicationId: application.id, toStage: 'REJECTED' }, orderBy: { createdAt: 'desc' } }).catch(() => null);
      if (isWithdrawal(ev)) await stopWhere({ applicationId: application.id, manualToo: true }, 'cancelled', 'The candidate withdrew from this requirement.', user);
      else await stopWhere({ applicationId: application.id, triggers: INTERVIEW_TRIGGERS }, 'cancelled', 'The candidate was rejected.', user);
      return;
    }
    if (['JOINED', 'HIRED'].includes(toStage)) { await stopWhere({ applicationId: application.id, triggers: ['joining_reminder'] }, 'completed', 'The candidate joined.', user); return; }
    const { triggers } = await loadTriggers();
    const keys = TRIGGERS.filter((t) => t.stage === toStage && triggers[t.key].enabled).map((t) => t.key);
    if (!keys.length) return;
    const app = await loadAppFull(application.id);
    for (const k of keys) await fire(k, app, { actor: user, triggers }); // eslint-disable-line no-await-in-loop
  } catch (e) { console.error('[messageSchedules] stage:', e.message); } // eslint-disable-line no-console
}

// the ATS routes with their own events (mounted on /api/ats, like scheduledReminders.autoSyncMiddleware): after a success the rules run
const ROUTE_EVENTS = [
  [/^\/interviews\/([^/]+)\/book$/, 'interview_booked'], [/^\/interviews\/([^/]+)\/reschedule$/, 'interview_rescheduled'], [/^\/interviews\/([^/]+)\/(cancel|no-show)$/, 'interview_cancelled'],
  [/^\/interviews\/([^/]+)\/(decision|client-feedback)$/, 'client_feedback'], [/^\/offers\/([^/]+)\/documents$/, 'documents'], [/^\/joining\/([^/]+)\/schedule$/, 'joining_scheduled'],
  [/^\/joining\/([^/]+)\/not-joined$/, 'joining_dropped'], [/^\/joining\/([^/]+)\/joined$/, 'joined'],
];
async function onAtsEvent(applicationId, event, actor) {
  try {
    await ensure();
    const app = await loadAppFull(applicationId);
    if (!app) return;
    const { triggers } = await loadTriggers();
    if (event === 'interview_booked' || event === 'interview_rescheduled') {
      const iso = app.interviewAt ? new Date(app.interviewAt).toISOString() : null;
      // the old interview messages (another time) are cancelled; the new time gets its own (if the triggers are on)
      await stopWhere({ applicationId: app.id, triggers: INTERVIEW_TRIGGERS, anchorNot: iso }, 'cancelled', event === 'interview_rescheduled' ? 'The interview was rescheduled: new messages follow the new time.' : 'The interview was booked again for another time.', actor);
      if (iso && ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'].includes(app.interviewStatus)) {
        for (const k of INTERVIEW_TRIGGERS) await fire(k, app, { actor, triggers }); // eslint-disable-line no-await-in-loop
      }
      return;
    }
    if (event === 'interview_cancelled') { await stopWhere({ applicationId: app.id, triggers: INTERVIEW_TRIGGERS }, 'cancelled', app.interviewStatus === 'NO_SHOW' ? 'The candidate did not attend the interview.' : 'The interview was cancelled.', actor); return; }
    if (event === 'client_feedback') { if (app.stage !== 'INTERVIEW_COMPLETED') await stopWhere({ applicationId: app.id, triggers: ['client_feedback'] }, 'completed', 'The client\'s feedback is in.', actor); return; }
    if (event === 'documents') {
      if (['Submitted', 'Verified'].includes(app.documentsStatus)) await stopWhere({ applicationId: app.id, triggers: ['document_request'] }, 'completed', `The documents were received (${app.documentsStatus}).`, actor);
      else if (app.documentsStatus === 'Pending' || !app.documentsStatus) await fire('document_request', app, { actor, triggers });
      return;
    }
    if (event === 'joining_scheduled') {
      const info = await SR.infoOf(app.id, 'joining').catch(() => null);
      const ev = SR.eventOf(app, 'joining', await SR.loadSettings(), info);
      await stopWhere({ applicationId: app.id, triggers: ['joining_reminder'], anchorNot: ev.live ? ev.eventAt.toISOString() : '~' }, 'cancelled', 'The joining date changed: new reminders follow the new date.', actor);
      await fire('joining_reminder', app, { actor, triggers });
      return;
    }
    if (event === 'joining_dropped') { await stopWhere({ applicationId: app.id, manualToo: true }, 'cancelled', 'The candidate dropped (did not join).', actor); return; }
    if (event === 'joined') await stopWhere({ applicationId: app.id, triggers: ['joining_reminder'] }, 'completed', 'The candidate joined.', actor);
  } catch (e) { console.error('[messageSchedules] event:', e.message); } // eslint-disable-line no-console
}
function eventMiddleware(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return next();
  const hit = ROUTE_EVENTS.map(([re, ev]) => [re.exec(req.path), ev]).find(([m]) => !!m);
  if (!hit) return next();
  const [m, event] = hit;
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 300 || res.__msDone) return orig(body);
    res.__msDone = true;
    return onAtsEvent(decodeURIComponent(m[1]), event, req.user).catch(() => null).then(() => orig(body));
  };
  return next();
}

// ------------------------------------------------------------------ the options of the screens
async function options(user) {
  await ensure();
  const acc = await scopeOf(user);
  if (acc.error) return acc;
  const SM = require('./scheduledMessages'); // eslint-disable-line global-require
  const settings = await SR.loadSettings();
  const st = await require('./messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
  return {
    status: 200, access: acc.level, canCreate: acc.canCreate,
    channels: CHANNELS.map((c) => ({ channel: c, ready: !!(st[c] && st[c].configured), reason: st[c] && !st[c].configured ? (st[c].reason || 'Not connected') : '' })),
    templates: SM.TEMPLATES, placeholders: SM.PLACEHOLDERS.map(([key, label]) => ({ key, label })), footer: SM.FOOTER, timezones: TIMEZONES.map(([value, label]) => ({ value, label })),
    hours: { earliest: settings.earliestHour, latest: settings.latestHour, windowStart: `${pad(settings.earliestHour)}:00`, windowEnd: `${pad(Math.min(23, settings.latestHour))}:${settings.latestHour >= 24 ? '59' : '00'}` },
    limits: { maxOccurrences: MAX_OCCURRENCES, maxPlannedPerCandidate: MAX_PLANNED_CANDIDATE, maxOneTime: SM.MAX_PLANNED, maxBulk: MAX_BULK, minAheadMinutes: MIN_AHEAD_MIN, windowDays: WINDOW_DAYS, windowMax: WINDOW_MAX },
    maxLength: SM.MAX_BODY,
  };
}
// the live "Schedule summary": the engine's own computation, never a guess of the screen
async function preview(user, b = {}, { now = new Date() } = {}) {
  const acc = await scopeOf(user);
  if (acc.error) return acc;
  const settings = await SR.loadSettings();
  const v = validateSpec(cleanSpec(b, settings), { now });
  if (v.error) return { status: 200, ok: false, error: v.error };
  return { status: 200, ok: true, summary: v.summary };
}

module.exports = {
  stopIds,
  CHANNELS, TIMEZONES, TRIGGERS, TRIGGER_KEY, STATUSES, OCC_STATUSES, MAX_OCCURRENCES, MAX_PLANNED_CANDIDATE, WINDOW_DAYS, WINDOW_MAX, EXPORT_HEADERS, NO_RESPONSE,
  ensure, migrateExisting, adoptRow, timesOf, planTimes, summaryOf, cleanSpec, validateSpec, frequencyLabel,
  create, getOne, pause, resume, cancel, edit, listAll, exportRows, forCandidate, options, preview,
  extend, extendDue, refresh, gate, after, syncFromRow, stopWhere,
  loadTriggers, saveTriggers, fire, triggerState, onCandidateReply, onApplicationCreated, onStageMove, onAtsEvent, eventMiddleware,
  internals: { zoned, partsOf, localDay, localMin, clampForward, clampSameDay, getSched, occOf, plannedFor },
};
