// ---------------------------------------------------------------------------
// DAILY REPORT E-MAILS (user spec 2026-10-03, C2): every day at 7 PM each TL
// gets their team's day; every week the Manager gets their area's week.
//
// SWITCHED OFF BY DEFAULT (orchestrator decision): nothing is sent until a
// Super Admin / Admin turns it on in Reports → ATS → Daily report → E-mails.
// With the setting off — or no setting saved at all — the sweep does nothing.
// The setting lives in the internal Integration row 'ats-daily-report-mail'
// (the same internal-settings store the follow-up rules use). In the TEST
// SANDBOX no timer runs at all (index.js), and mail there is fake anyway.
//
// Sent through utils/mailer.js sendMail() — the configured SMTP account — to
// the TL's / Manager's own login e-mail. Test logins (ZZTEST / example.test)
// never receive one (mailer also refuses reserved test domains).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const STORE = 'ats-daily-report-mail';
const DEFAULTS = {
  tlDaily: { on: false, time: '19:00' },
  managerWeekly: { on: false, weekday: 6, time: '19:00' }, // 6 = Saturday (end of the work week)
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isTestPerson = (u) => !!u && /zztest|example\.test/i.test(`${u.name || ''} ${u.email || ''}`);

const istNow = () => new Date(Date.now() + 330 * 60000); // read with getUTC*
const istDayOf = (d) => d.toISOString().slice(0, 10);
const hhmm = (d) => d.toISOString().slice(11, 16);

async function loadSettings() {
  const row = await prisma.integration.findUnique({ where: { id: STORE } });
  let v = {};
  try { v = row && row.values ? JSON.parse(row.values) : {}; } catch { v = {}; }
  return {
    tlDaily: { ...DEFAULTS.tlDaily, ...(v.tlDaily || {}) },
    managerWeekly: { ...DEFAULTS.managerWeekly, ...(v.managerWeekly || {}) },
    lastTlRun: v.lastTlRun || null,
    lastManagerRun: v.lastManagerRun || null,
    lastResult: v.lastResult || null,
    updatedAt: v.updatedAt || null,
    updatedBy: v.updatedBy || null,
    saved: !!row,
  };
}

async function writeSettings(values) {
  await prisma.integration.upsert({
    where: { id: STORE },
    create: { id: STORE, enabled: true, state: 'Internal', values: JSON.stringify(values) },
    update: { values: JSON.stringify(values) },
  });
}

function publicSettings(s) {
  return {
    tlDaily: s.tlDaily,
    managerWeekly: { ...s.managerWeekly, weekdayLabel: WEEKDAYS[s.managerWeekly.weekday] },
    weekdays: WEEKDAYS.map((label, value) => ({ value, label })),
    lastTlRun: s.lastTlRun,
    lastManagerRun: s.lastManagerRun,
    lastResult: s.lastResult,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
    status: (s.tlDaily.on || s.managerWeekly.on) ? 'On' : 'Off',
    note: 'Off until you switch it on. When on, each TL gets their team\'s day at the time set, and each Manager gets their area\'s week on the day set — sent from the company mail account to their login e-mail.',
  };
}

async function saveSettings(user, body = {}) {
  const cur = await loadSettings();
  const errs = [];
  const time = (v, fb) => {
    if (v === undefined) return fb;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) { errs.push('Time must look like 19:00'); return fb; }
    return String(v);
  };
  const tl = body.tlDaily || {};
  const mg = body.managerWeekly || {};
  const next = {
    tlDaily: { on: tl.on === undefined ? cur.tlDaily.on : !!tl.on, time: time(tl.time, cur.tlDaily.time) },
    managerWeekly: {
      on: mg.on === undefined ? cur.managerWeekly.on : !!mg.on,
      weekday: mg.weekday === undefined ? cur.managerWeekly.weekday : Number(mg.weekday),
      time: time(mg.time, cur.managerWeekly.time),
    },
  };
  if (!(next.managerWeekly.weekday >= 0 && next.managerWeekly.weekday <= 6)) errs.push('Pick a day of the week');
  if (errs.length) return { error: errs.join('; ') };
  const values = {
    ...next,
    lastTlRun: cur.lastTlRun,
    lastManagerRun: cur.lastManagerRun,
    lastResult: cur.lastResult,
    updatedAt: new Date().toISOString(),
    updatedBy: user.name || user.id,
  };
  await writeSettings(values);
  await logAudit({
    userId: user.id,
    actorName: user.name,
    action: 'Daily report e-mails changed',
    entity: 'Integration',
    entityId: STORE,
    fromValue: `TL daily ${cur.tlDaily.on ? 'on' : 'off'} ${cur.tlDaily.time}; Manager weekly ${cur.managerWeekly.on ? 'on' : 'off'}`,
    toValue: `TL daily ${next.tlDaily.on ? 'on' : 'off'} ${next.tlDaily.time}; Manager weekly ${next.managerWeekly.on ? 'on' : 'off'} ${WEEKDAYS[next.managerWeekly.weekday]} ${next.managerWeekly.time}`,
  });
  return { settings: publicSettings(await loadSettings()) };
}

// ---------------------------------------------------------------------------
// THE TEMPLATE — plain text (mailer sends text). Built from the same report
// the screen shows, as the recipient (so their scope applies).
// ---------------------------------------------------------------------------
const n = (v) => (v === null || v === undefined ? '—' : String(v));

async function buildMail(recipient, kind, { day } = {}) {
  // eslint-disable-next-line global-require
  const DR = require('./dailyReport');
  // eslint-disable-next-line global-require
  const { resolveIdentity } = require('./identity');
  const viewer = resolveIdentity ? await resolveIdentity(recipient.id) : recipient;
  const today = day || DR.todayIst();
  const lines = [];
  if (kind === 'tl') {
    const r = await DR.dayReport(viewer, { day: today });
    if (r.status !== 200) return null;
    const b = r.body;
    lines.push(`Hi ${recipient.name},`, '', `Your team's work on ${today}:`, '');
    lines.push('Person | Added | Calls | Mails | Follow-ups | Sent to TL | Sent to client | Interviews | Joined | Pending');
    b.people.forEach((p) => {
      lines.push([p.label, p.added, p.calls, p.mails, p.followUps, p.sentTl, p.sentClient, p.interviews, p.joined, n(p.pending)].join(' | '));
    });
    if (!b.people.length) lines.push('No work was recorded today.');
    const t = b.totals;
    lines.push('', `Team total: ${t.calls} calls, ${t.mails} mails, ${t.followUps} follow-ups, ${t.sentClient} sent to client, ${t.interviews} interviews, ${t.joined} joined.`);
    if (t.missed) lines.push(`Missed follow-ups: ${t.missed}.`);
    return { subject: `Team daily report — ${today}`, text: lines.join('\n') };
  }
  // Manager weekly: the last 7 days.
  const from = DR.addDays(today, -6);
  const r = await DR.monthReport(viewer, { month: today.slice(0, 7) });
  const r2 = from.slice(0, 7) !== today.slice(0, 7) ? await DR.monthReport(viewer, { month: from.slice(0, 7) }) : null;
  if (r.status !== 200) return null;
  const days = [...(r2 ? r2.body.days : []), ...r.body.days].filter((d) => d.date >= from && d.date <= today);
  const sum = (k) => days.reduce((s, d) => s + (Number(d[k]) || 0), 0);
  lines.push(`Hi ${recipient.name},`, '', `Your area's week, ${from} to ${today}:`, '');
  lines.push('Date | Added | Calls | Mails | Follow-ups | Sent to TL | Sent to client | Interviews | Joined');
  days.forEach((d) => lines.push([d.date, d.added, d.calls, d.mails, d.followUps, d.sentTl, d.sentClient, d.interviews, d.joined].map(n).join(' | ')));
  lines.push('', `Week total: ${sum('calls')} calls, ${sum('mails')} mails, ${sum('followUps')} follow-ups, ${sum('sentClient')} sent to client, ${sum('interviews')} interviews, ${sum('joined')} joined.`);
  return { subject: `Weekly report — ${from} to ${today}`, text: lines.join('\n') };
}

async function recipients(kind) {
  const roles = kind === 'tl' ? ['TL', 'STL'] : ['MANAGER', 'ASSISTANT_MANAGER'];
  const users = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ atsRole: { in: roles } }, ...(kind === 'manager' ? [{ role: { in: roles } }] : [])] },
    select: { id: true, name: true, email: true },
  });
  return users.filter((u) => u.email && !isTestPerson(u));
}

async function sendRun(kind, day) {
  // eslint-disable-next-line global-require
  const { sendMail } = require('./mailer');
  const list = await recipients(kind);
  const result = { kind, day, at: new Date().toISOString(), sent: 0, failed: 0, errors: [] };
  for (const u of list) {
    // eslint-disable-next-line no-await-in-loop
    const mail = await buildMail(u, kind, { day }).catch(() => null);
    if (!mail) { result.failed += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    const out = await sendMail({ to: u.email, subject: mail.subject, text: mail.text, useEmployeeFrom: false, fromName: 'TeamLink Reports' });
    if (out.ok) result.sent += 1;
    else { result.failed += 1; if (result.errors.length < 5) result.errors.push(`${u.name}: ${out.error}`); }
  }
  return result;
}

let RUNNING = false;
async function sweep() {
  if (RUNNING) return;
  RUNNING = true;
  try {
    const s = await loadSettings();
    if (!s.saved || (!s.tlDaily.on && !s.managerWeekly.on)) return; // OFF — the default
    const now = istNow();
    const day = istDayOf(now);
    const t = hhmm(now);
    let changed = false;
    const values = { tlDaily: s.tlDaily, managerWeekly: s.managerWeekly, lastTlRun: s.lastTlRun, lastManagerRun: s.lastManagerRun, lastResult: s.lastResult, updatedAt: s.updatedAt, updatedBy: s.updatedBy };
    if (s.tlDaily.on && t >= s.tlDaily.time && s.lastTlRun !== day) {
      values.lastTlRun = day; // claimed first, so a crash cannot send twice
      await writeSettings(values);
      values.lastResult = await sendRun('tl', day);
      changed = true;
    }
    if (s.managerWeekly.on && now.getUTCDay() === Number(s.managerWeekly.weekday) && t >= s.managerWeekly.time && s.lastManagerRun !== day) {
      values.lastManagerRun = day;
      await writeSettings(values);
      values.lastResult = await sendRun('manager', day);
      changed = true;
    }
    if (changed) await writeSettings(values);
  } catch (err) {
    console.error('[dailyReportMail]', err.message);
  } finally {
    RUNNING = false;
  }
}

let TIMER = null;
function startSweep() {
  const ms = Number(process.env.DAILY_REPORT_MAIL_SWEEP_MS || 5 * 60000);
  if (!ms || TIMER) return;
  TIMER = setInterval(sweep, ms);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  STORE, loadSettings, saveSettings, publicSettings, buildMail, startSweep, sweep,
};
