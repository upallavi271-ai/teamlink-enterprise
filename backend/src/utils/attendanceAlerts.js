// ---------------------------------------------------------------------------
// ATTENDANCE ALERTS — late logins and missing punches, for TODAY only.
//
// Every few minutes (ATTENDANCE_ALERTS_INTERVAL_MS, default 5 min, 0 = off)
// the sweep looks at the current day and finds:
//   Late login         the first check-in is after shift start + grace minutes
//   Missing check-out  checked in, but no check-out by shift end + buffer
//   Missing check-in   no punch and no mark by shift start + N minutes, on a
//                      working day (not a holiday, weekly off or approved leave)
// The employee is told in-app and by email (each switch separately); their
// reporting manager and HR get ONE digest per day at the digest time.
//
// NEVER BACKFILLED. The moment the feature first runs is stored (goLiveAt);
// an event counts only if it happened after that moment (a late punch recorded
// after it, a threshold time that passed after it). Only the current day is
// ever looked at; imported punches (the old-HRMS CSVs) never count; relieved /
// exited employees, Super Admin (a system account) and test users
// (ZZTEST / example.test) are never alerted and never receive a digest.
//
// ONE ALERT PER PERSON PER EVENT PER DAY. The Notification rows themselves are
// the record: an alert whose title (event + date) already exists today for
// that person is not sent again. Email deliveries are logged as Notification
// rows on the Email channel (read, so they do not add to the bell count).
//
// Settings live on an Integration row (id 'attendance-alerts', values = JSON)
// — no schema change. The Integrations screen lists only its own catalogue,
// so this row does not appear there.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { sendMail, emailConfig } = require('./mailer');
const { logAudit } = require('./audit');
const { withoutSystemAccounts } = require('./systemAccounts');
const { daySplit, toMinutes } = require('./attendanceMath');
const D = require('./attendanceDays');

const STORE_ID = 'attendance-alerts';
const LEFT = ['Relieved', 'Exited', 'Exit Process'];
const TYPES = {
  late: 'Late login',
  missingOut: 'Missing check-out',
  missingIn: 'Missing check-in',
};
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const dmy = (iso) => `${iso.slice(8, 10)}-${MON3[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const TEST_RE = /zztest|example\.test/i;
const isTestEmployee = (e) => TEST_RE.test([e.name, e.employeeCode, e.email, e.user && e.user.email, e.user && e.user.name].join(' '));
const isTestUser = (u) => TEST_RE.test([u.name, u.email].join(' '));

// ---- settings ---------------------------------------------------------------
async function defaults() {
  const cfg = (await prisma.hrConfig.findFirst()) || {};
  // The "Late" rule elsewhere is "after the grace clock time" (09:30 against a
  // 09:00 start), so the default grace here is that same gap.
  const g = toMinutes(cfg.graceTime || '09:30');
  return {
    inApp: true,
    email: true,
    graceMinutes: g != null && g >= 540 ? g - 540 : Number(cfg.graceTimeMinutes || 15),
    checkOutBufferMinutes: 60,
    missingCheckInAfterMinutes: 120,
    digestTime: '19:00',
  };
}

async function loadStore() {
  let row = await prisma.integration.findUnique({ where: { id: STORE_ID } });
  if (!row) {
    // The first run is the go-live moment: nothing before it is ever alerted.
    const values = { ...(await defaults()), goLiveAt: new Date().toISOString() };
    row = await prisma.integration.create({ data: { id: STORE_ID, enabled: true, state: 'Internal', values: JSON.stringify(values) } });
  }
  let values = {};
  try { values = JSON.parse(row.values || '{}'); } catch { values = {}; }
  return { row, settings: { ...(await defaults()), ...values } };
}

async function saveSettings(patch, userId) {
  const { settings } = await loadStore();
  const next = { ...settings };
  const errs = [];
  ['inApp', 'email'].forEach((k) => { if (patch[k] !== undefined) next[k] = !!patch[k]; });
  [['graceMinutes', 0, 240], ['checkOutBufferMinutes', 0, 480], ['missingCheckInAfterMinutes', 15, 720]].forEach(([k, lo, hi]) => {
    if (patch[k] === undefined) return;
    const n = Number(patch[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) errs.push(`${k} must be a whole number of minutes from ${lo} to ${hi}`);
    else next[k] = n;
  });
  if (patch.digestTime !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.digestTime))) errs.push('digestTime must be HH:MM (24-hour)');
    else next.digestTime = String(patch.digestTime);
  }
  if (errs.length) return { error: errs.join('; ') };
  await prisma.integration.update({ where: { id: STORE_ID }, data: { values: JSON.stringify(next) } });
  await logAudit({
    userId, action: 'Attendance alert settings updated', entity: 'Integration', entityId: STORE_ID,
    toValue: `in-app ${next.inApp ? 'on' : 'off'} · email ${next.email ? 'on' : 'off'} · grace ${next.graceMinutes} min · check-out buffer ${next.checkOutBufferMinutes} min · missing check-in after ${next.missingCheckInAfterMinutes} min · digest ${next.digestTime}`,
  });
  return { settings: next };
}

// ---- shifts -----------------------------------------------------------------
// "General (9:00 AM – 6:00 PM)" -> { start: 540, end: 1080 }; a ShiftPattern
// named like the shift's first word next; 09:00–18:00 otherwise.
function clockToMin(h, m, ap) {
  let hh = Number(h);
  if (ap) { const u = ap.toUpperCase(); if (u === 'PM' && hh !== 12) hh += 12; if (u === 'AM' && hh === 12) hh = 0; }
  return hh * 60 + Number(m);
}
function shiftOf(employee, patterns) {
  const s = String(employee.shift || '');
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[–—-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s);
  if (m) return { name: s, start: clockToMin(m[1], m[2], m[3]), end: clockToMin(m[4], m[5], m[6]) };
  const word = s.split(/[\s(]/)[0].toLowerCase();
  const p = word && patterns.find((x) => x.active && x.name.toLowerCase() === word);
  if (p && toMinutes(p.startTime) != null && toMinutes(p.endTime) != null) return { name: p.name, start: toMinutes(p.startTime), end: toMinutes(p.endTime) };
  return { name: 'General', start: 540, end: 1080 };
}

// ---- detection --------------------------------------------------------------
// testMode: ONLY test employees / recipients (the test script); otherwise test
// users are excluded everywhere.
// scope (tests only): { employeeIds, userIds } — nobody outside them is looked at.
async function detect({ now = new Date(), testMode = false, settings, scope = null }) {
  const today = D.localDate(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const goLive = new Date(settings.goLiveAt);
  const at = (min) => new Date(`${today}T${hhmm(min)}:00`); // local time today
  const cfg = (await prisma.hrConfig.findFirst()) || await prisma.hrConfig.create({ data: {} });
  const [all, patterns] = await Promise.all([
    prisma.employee.findMany({
      where: withoutSystemAccounts({ employmentStatus: { notIn: LEFT } }),
      include: {
        user: { select: { id: true, name: true, email: true, status: true } },
        reportingManager: { select: { id: true, name: true, email: true, employmentStatus: true, user: { select: { id: true, name: true, email: true, status: true } } } },
      },
    }),
    prisma.shiftPattern.findMany(),
  ]);
  const employees = all.filter((e) => (testMode ? isTestEmployee(e) && (!scope || scope.employeeIds.includes(e.id)) : !isTestEmployee(e)));
  const ids = employees.map((e) => e.id);
  const [punches, records, loaded] = await Promise.all([
    // Imported (old-HRMS) punches never raise an alert.
    prisma.attendancePunch.findMany({ where: { employeeId: { in: ids }, date: today, NOT: { source: 'PulseHRM import' } } }),
    prisma.attendance.findMany({ where: { employeeId: { in: ids }, date: today }, select: { employeeId: true, status: true } }),
    D.loadDays(prisma, { employees, from: today, to: today, cfg }),
  ]);
  const punchesOf = new Map();
  punches.forEach((p) => { if (!punchesOf.has(p.employeeId)) punchesOf.set(p.employeeId, []); punchesOf.get(p.employeeId).push(p); });
  const marked = new Set(records.map((r) => r.employeeId));
  // FEED GUARD: when not one punch has arrived today from anyone (the device
  // or its sync is down), missing check-ins are not raised — otherwise every
  // employee would be told they had not checked in.
  const feedSilent = punches.length === 0;
  const events = [];
  employees.forEach((e) => {
    const day = loaded.days(e)[0];
    if (['Holiday', 'Weekly Off', 'On Leave', 'Not Joined', 'Left', 'Upcoming'].includes(day.status)) return;
    const sh = shiftOf(e, patterns);
    const ps = punchesOf.get(e.id) || [];
    const split = daySplit(ps);
    const base = { employee: e, shift: sh, date: today };
    if (split.checkIn) {
      const t = toMinutes(split.checkIn.time);
      const limit = sh.start + settings.graceMinutes;
      if (t != null && t > limit && new Date(split.checkIn.createdAt) >= goLive) {
        events.push({ ...base, type: 'late', time: split.checkIn.time, limit: hhmm(limit) });
      }
      const outLimit = sh.end + settings.checkOutBufferMinutes;
      if (!split.checkOut && sh.end > sh.start && nowMin >= outLimit && at(outLimit) >= goLive) {
        events.push({ ...base, type: 'missingOut', time: split.checkIn.time, limit: hhmm(outLimit) });
      }
    } else if (!feedSilent && !ps.length && !marked.has(e.id)) {
      const inLimit = sh.start + settings.missingCheckInAfterMinutes;
      if (nowMin >= inLimit && at(inLimit) >= goLive) events.push({ ...base, type: 'missingIn', limit: hhmm(inLimit) });
    }
  });
  return { today, events, employees, feedSilent };
}

function employeeText(ev) {
  const d = dmy(ev.date);
  const start = hhmm(ev.shift.start);
  const end = hhmm(ev.shift.end);
  const fix = 'If this is not right, raise a regularization under Attendance → Regularization.';
  if (ev.type === 'late') return `Your first check-in today (${d}) was at ${ev.time}, after your shift start ${start} plus the grace period (late after ${ev.limit}). ${fix}`;
  if (ev.type === 'missingOut') return `You checked in at ${ev.time} today (${d}), but no check-out has been recorded (shift ended ${end}). Please check out on the device, or raise a regularization. ${fix}`;
  return `No check-in has been recorded for you today (${d}); your shift started at ${start}. If you are at work, check in on the device now. ${fix}`;
}

const startOfToday = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; };
async function alreadyAlerted({ title, userId, recipient, now }) {
  const or = [];
  if (userId) or.push({ userId });
  if (recipient) or.push({ recipient });
  if (!or.length) return false;
  return !!(await prisma.notification.findFirst({ where: { title, createdAt: { gte: startOfToday(now) }, OR: or }, select: { id: true } }));
}

// Deliver one message to one person: in-app and/or email, per the settings.
async function deliver({ settings, userId, name, email, title, text, mailer, dryRun, out }) {
  if (dryRun) return;
  if (settings.inApp && userId) {
    await prisma.notification.create({ data: { userId, title, message: text, channel: 'In-App', recipient: name || null, status: 'Delivered' } });
    out.inApp += 1;
  }
  if (settings.email && email) {
    const r = await mailer({ to: email, subject: `TeamLink — ${title}`, text, useEmployeeFrom: false });
    const status = r.ok ? 'Sent' : r.notConfigured ? 'Not sent — email is not configured' : `Failed — ${String(r.error || '').slice(0, 150)}`;
    await prisma.notification.create({ data: { userId: userId || null, title, message: text, channel: 'Email', recipient: email, status, read: true } });
    if (r.ok) out.emails += 1; else out.emailsNotSent += 1;
  }
}

// ---- one sweep --------------------------------------------------------------
let running = false;
async function run({ now = new Date(), dryRun = false, testMode = false, mailer = sendMail, override = null, scope = null } = {}) {
  // A test run must say exactly whom it may touch.
  if (testMode && !scope) throw new Error('testMode needs a scope { employeeIds, userIds }');
  // Only real (writing) sweeps take the lock; a dry run writes nothing.
  const locks = !testMode && !dryRun;
  if (locks) { if (running) return { skipped: 'already running' }; running = true; }
  try {
    const stored = (await loadStore()).settings;
    // Test runs may try other settings (e.g. an earlier go-live); never saved.
    const settings = testMode && override ? { ...stored, ...override } : stored;
    const { today, events, feedSilent } = await detect({ now, testMode, settings, scope });
    const out = {
      today, dryRun, goLiveAt: settings.goLiveAt, events: events.length, feedSilent,
      byType: Object.fromEntries(Object.keys(TYPES).map((k) => [k, events.filter((x) => x.type === k).length])),
      inApp: 0, emails: 0, emailsNotSent: 0, duplicates: 0, digests: 0, list: [],
    };
    const channelsOn = settings.inApp || settings.email;
    for (const ev of events) {
      const e = ev.employee;
      const title = `${TYPES[ev.type]} — ${dmy(today)}`;
      const email = e.email || (e.user && e.user.email) || null;
      out.list.push({ employeeCode: e.employeeCode, name: e.name, type: TYPES[ev.type], time: ev.time || null, limit: ev.limit });
      if (!channelsOn) continue;
      if (await alreadyAlerted({ title, userId: e.user && e.user.id, recipient: email, now })) { out.duplicates += 1; continue; }
      await deliver({ settings, userId: e.user && e.user.id, name: e.name, email, title, text: employeeText(ev), mailer, dryRun, out });
    }

    // The digest: one per recipient per day, at or after the digest time.
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const digestMin = toMinutes(settings.digestTime);
    if (channelsOn && events.length && digestMin != null && nowMin >= digestMin) {
      const recipients = new Map(); // key -> { userId, name, email, events[] }
      const add = (key, who, ev) => {
        if (!recipients.has(key)) recipients.set(key, { ...who, events: [] });
        recipients.get(key).events.push(ev);
      };
      const hrUsers = (await prisma.user.findMany({
        where: { hrmsRole: 'HR', status: 'Active' }, select: { id: true, name: true, email: true },
      })).filter((u) => (testMode ? isTestUser(u) && scope.userIds.includes(u.id) : !isTestUser(u)));
      events.forEach((ev) => {
        const m = ev.employee.reportingManager;
        if (m && !LEFT.includes(m.employmentStatus)) {
          const u = m.user && m.user.status === 'Active' ? m.user : null;
          const who = { userId: u ? u.id : null, name: m.name, email: m.email || (u && u.email) || null };
          const test = TEST_RE.test([m.name, who.email].join(' '));
          if (testMode ? test && (!u || scope.userIds.includes(u.id)) && scope.employeeIds.includes(m.id) : !test) add(u ? `u:${u.id}` : `e:${m.id}`, who, ev);
        }
        hrUsers.forEach((u) => add(`u:${u.id}`, { userId: u.id, name: u.name, email: u.email }, ev));
      });
      const title = `Attendance alerts digest — ${dmy(today)}`;
      for (const r of recipients.values()) {
        if (await alreadyAlerted({ title, userId: r.userId, recipient: r.email, now })) { out.duplicates += 1; continue; }
        const lines = r.events.map((ev) => `• ${ev.employee.employeeCode} ${ev.employee.name} — ${TYPES[ev.type]}${ev.time ? ` (${ev.time})` : ''}`);
        const text = `Attendance alerts for ${dmy(today)} (${r.events.length}):\n${lines.join('\n')}\n\nOpen Attendance → Biometric Attendance List for the day.`;
        await deliver({ settings, userId: r.userId, name: r.name, email: r.email, title, text, mailer, dryRun, out });
        if (!dryRun) out.digests += 1;
      }
      out.digestRecipients = recipients.size;
    }
    if (!dryRun && !testMode) await prisma.integration.update({ where: { id: STORE_ID }, data: { lastSync: now } }).catch(() => {});
    return out;
  } finally {
    if (locks) running = false;
  }
}

async function status() {
  const { row, settings } = await loadStore();
  const cfg = await emailConfig().catch(() => ({ configured: false }));
  return {
    settings,
    goLiveAt: settings.goLiveAt,
    lastRun: row.lastSync,
    intervalMinutes: Math.round(intervalMs() / 60000),
    emailConfigured: !!cfg.configured,
  };
}

function intervalMs() {
  const v = process.env.ATTENDANCE_ALERTS_INTERVAL_MS;
  return v === undefined || v === '' ? 5 * 60 * 1000 : Number(v) || 0;
}

let timer = null;
function startSweep() {
  if (timer || intervalMs() <= 0) return;
  const real = () => run().then((o) => {
    if (o && (o.inApp || o.emails || o.digests)) console.log(`[attendance-alerts] ${o.today}: ${o.inApp} in-app, ${o.emails} email(s) sent, ${o.emailsNotSent} not sent, ${o.digests} digest(s)`);
  }).catch((e) => console.error('[attendance-alerts]', e.message));
  // On startup: a DRY RUN first, printed to the log, then the real sweeps.
  setTimeout(() => {
    run({ dryRun: true }).then((o) => {
      console.log(`[attendance-alerts] dry run for ${o.today} (live since ${o.goLiveAt}): ${o.events} event(s) — late ${o.byType.late}, missing check-out ${o.byType.missingOut}, missing check-in ${o.byType.missingIn}; ${o.duplicates} already alerted${o.feedSilent ? '; no punches received today yet, so missing check-ins are held back' : ''}${o.digestRecipients ? `; digest to ${o.digestRecipients} recipient(s)` : ''}.`);
    }).catch((e) => console.error('[attendance-alerts dry run]', e.message)).finally(() => {
      real();
      timer = setInterval(real, intervalMs());
      if (timer.unref) timer.unref();
    });
  }, 20000);
}

// Routes, registered onto routes/attendance.js's router (so /api/attendance/alerts…).
function registerRoutes(router, { requirePerm }) {
  const configure = requirePerm(null, 'hrms', 'Attendance & Time', 'configure');
  router.get('/alerts', configure, async (req, res) => {
    const s = await status();
    const preview = await run({ dryRun: true });
    res.json({ ...s, preview });
  });
  router.put('/alerts', configure, async (req, res) => {
    const r = await saveSettings(req.body || {}, req.user.id);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(await status());
  });
}

module.exports = { TYPES, STORE_ID, loadStore, saveSettings, shiftOf, detect, run, status, startSweep, registerRoutes, isTestEmployee };
