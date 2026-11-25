// ---------------------------------------------------------------------------
// PROBATION AND CONFIRMATION (founder 2026-11-25, from the HR audit questionnaire: "fill the gaps, change nothing that exists").
//
// ADDITIVE. Two new tables (ProbationRecord, ProbationEvent) and nothing else is touched: the Employee row, the "On Probation" status
// label, the Pause / Resume button, payroll, leave and attendance all stay exactly as they were. Everything here is OFF until HR
// switches probation tracking ON (AppSetting "probation.settings"): no record is made and nobody is reminded before that.
//
// WHAT IT DOES
//   sync()      once ON: every employee with a date of joining who has no record gets one. Joined within the probation length ->
//               "In probation" with an end date; joined earlier -> "Not tracked" (never shows as overdue). Nobody who has left is added.
//   remind()    once a day after 9 am IST: 30 days before, 7 days before, on the last day, and every 7 days while overdue, a bell
//               notice goes to the reviewer (the Team Lead) and to HR. Each reminder goes once.
//   review      the Team Lead (or anyone whose team scope covers the person) gives a score, notes and a recommendation.
//   confirm     HR: sets the confirmation date, makes the confirmation letter (same letterhead as the exit letters) and files it in the
//               employee's documents.
//   extend      HR: new months + a reason; the end date moves, reminders restart, the history keeps the old date.
//   endService  HR: records "Service ending" with a reason. It does NOT start the exit: HR opens Exit Center for that, as today.
//   reopen      HR: undoes a Confirmed / Service ending decision made by mistake.
//   track       HR: brings a "Not tracked" person into tracking from a date HR chooses.
//
// The test sandbox runs no timers (index.js); sweep() is exported for tests.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { withoutSystemAccounts } = require('./systemAccounts');
const { hrmsGlobal, employeeWhere } = require('./scope');

const SETTINGS_KEY = 'probation.settings';
const STATE_KEY = 'probation.sweep';
const OPEN = ['In probation', 'Extended'];
const GONE = ['Relieved', 'Exited', 'Terminated', 'Exit Process', 'Notice Period'];
const RECOMMENDATIONS = ['Confirm', 'Extend', 'End service'];
const LETTER_TYPE = 'Confirmation Letter';

const DEFAULT_LETTER = [
  'We are pleased to inform you that you have successfully completed your probation period with {{company}}, which began on {{startDate}}.',
  'Based on your performance and conduct during the probation period, your services are confirmed as {{designation}} with effect from {{confirmedOn}}.',
  'All other terms and conditions of your appointment remain unchanged. We congratulate you and look forward to your continued contribution.',
].join('\n\n');

// --- dates (a day is "YYYY-MM-DD" in India time; it is stored as that day at 00:00 UTC) ----------------------------------------
const IST = 330 * 60000;
const dayOfDate = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? new Date(d.getTime() + IST).toISOString().slice(0, 10) : null);
const istToday = (now = Date.now()) => new Date(now + IST).toISOString().slice(0, 10);
const istHour = (now = Date.now()) => new Date(now + IST).getUTCHours();
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
/** The LAST day of a probation that starts on `start` and lasts `months` months: joined 10 Nov, 3 months -> 9 Feb. */
const endFor = (start, months) => addDays(addMonths(start, months), -1);
const pretty = (day) => (day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const dmy = (day) => (day ? `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}` : '');

const cleanLine = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanText = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n);

// --- settings ------------------------------------------------------------------------------------------------------------------
async function getSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  // founder 2026-11-25: 6 months for everybody, Team Leads 3 months
  const months = Number.isInteger(v.months) && v.months >= 1 && v.months <= 12 ? v.months : (Number(process.env.PROBATION_MONTHS) || 6);
  const leadMonths = Number.isInteger(v.leadMonths) && v.leadMonths >= 1 && v.leadMonths <= 12 ? v.leadMonths : 3;
  return {
    enabled: v.enabled === true,
    months,
    leadMonths,
    letterText: cleanText(v.letterText, 4000) || DEFAULT_LETTER,
    defaultLetter: DEFAULT_LETTER,
    enabledAt: v.enabledAt || null,
    enabledByName: v.enabledByName || null,
  };
}

/** body: { enabled?, months?, leadMonths?, letterText? } -> { settings, sync? } | { error, status } */
async function saveSettings(body, user) {
  const cur = await getSettings();
  const b = body || {};
  const next = { enabled: cur.enabled, months: cur.months, leadMonths: cur.leadMonths, letterText: cur.letterText === DEFAULT_LETTER ? '' : cur.letterText, enabledAt: cur.enabledAt, enabledByName: cur.enabledByName };
  if (b.months !== undefined) {
    const m = Number(b.months);
    if (!Number.isInteger(m) || m < 1 || m > 12) return { error: 'The probation length is a whole number of months, 1 to 12.', status: 400 };
    next.months = m;
  }
  if (b.leadMonths !== undefined) {
    const m = Number(b.leadMonths);
    if (!Number.isInteger(m) || m < 1 || m > 12) return { error: 'The Team Lead probation length is a whole number of months, 1 to 12.', status: 400 };
    next.leadMonths = m;
  }
  if (b.letterText !== undefined) {
    const txt = cleanText(b.letterText, 4000);
    if (txt && txt.length < 20) return { error: 'The confirmation letter text is too short.', status: 400 };
    next.letterText = txt === DEFAULT_LETTER ? '' : txt;
  }
  let turnedOn = false;
  if (b.enabled !== undefined) {
    const on = b.enabled === true || b.enabled === 'true';
    if (on && !cur.enabled) { turnedOn = true; next.enabledAt = new Date().toISOString(); next.enabledByName = user ? user.name : null; }
    next.enabled = on;
  }
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next), ...who },
    update: { value: JSON.stringify(next), ...who },
  });
  await logAudit({ userId: user ? user.id : null, action: `Probation tracking settings saved${b.enabled !== undefined ? (next.enabled ? ' (switched ON)' : ' (switched OFF)') : ''}`, entity: 'Probation', entityId: SETTINGS_KEY, toValue: `${next.months} months, Team Leads ${next.leadMonths} months${b.reason ? ` (${cleanLine(b.reason, 160)})` : ''}` });
  const out = { settings: await getSettings() };
  if (turnedOn) out.sync = await sync({ by: user });
  return out;
}

// --- who reviews, who is told ------------------------------------------------------------------------------------------------
async function peopleMaps() {
  const users = await prisma.user.findMany({ where: { status: 'Active' }, select: { id: true, name: true, role: true, hrmsRole: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const byName = new Map();
  users.forEach((u) => { const k = String(u.name || '').trim().toLowerCase(); if (k && !byName.has(k)) byName.set(k, u); });
  const hr = users.filter((u) => u.role === 'HR' || u.hrmsRole === 'HR');
  return { byId, byName, hr };
}
/** The Team Lead who reviews: the reporting manager's login, else the login named as TL, else as STL. -> { userId, name } */
function reviewerFrom(e, people) {
  const rm = e.reportingManager;
  if (rm && rm.userId && people.byId.has(rm.userId)) { const u = people.byId.get(rm.userId); return { userId: u.id, name: u.name }; }
  for (const nm of [e.tl, e.stl]) {
    const u = nm ? people.byName.get(String(nm).trim().toLowerCase()) : null;
    if (u) return { userId: u.id, name: u.name };
  }
  const name = (rm && rm.name) || e.tl || e.stl || null;
  return { userId: null, name };
}

const EMP_SELECT = { id: true, employeeCode: true, name: true, department: true, team: true, designation: true, dateOfJoining: true, tl: true, stl: true, employmentStatus: true, reportingManager: { select: { userId: true, name: true } }, user: { select: { role: true, hrmsRole: true } } };

/** A Team Lead is somebody whose login is a TL (STL stays on the usual length until the founder says otherwise). */
const isLead = (e) => !!(e && e.user && [e.user.role, e.user.hrmsRole].includes('TL'));
/** The probation length of one person: Team Leads have their own length, everybody else the usual one. */
const monthsFor = (e, st) => (isLead(e) ? st.leadMonths : st.months);

async function addEvent(recordId, kind, user, extra = {}) {
  return prisma.probationEvent.create({
    data: {
      recordId, kind, byUserId: user ? user.id : null, byName: user ? user.name : 'System',
      fromEnd: extra.fromEnd ? toDate(extra.fromEnd) : null, toEnd: extra.toEnd ? toDate(extra.toEnd) : null,
      score: extra.score === undefined ? null : extra.score, recommendation: extra.recommendation || null, note: extra.note ? cleanText(extra.note, 1000) : null,
    },
  });
}

// --- sync: a record for everybody who has none ------------------------------------------------------------------------------
/** -> { skipped } | { created, inProbation, notTracked, total } */
async function sync({ now = Date.now(), by = null, force = false } = {}) {
  const st = await getSettings();
  if (!st.enabled && !force) return { skipped: true, reason: 'Probation tracking is switched off.' };
  const today = istToday(now);
  const [have, emps, people] = await Promise.all([
    prisma.probationRecord.findMany({ select: { id: true, employeeId: true, status: true, reviewerUserId: true, department: true, team: true, designation: true, employeeName: true } }),
    prisma.employee.findMany({ where: withoutSystemAccounts({ dateOfJoining: { not: null }, employmentStatus: { notIn: GONE } }), select: EMP_SELECT }),
    peopleMaps(),
  ]);
  const byEmp = new Map(have.map((r) => [r.employeeId, r]));
  let inProbation = 0; let notTracked = 0;
  for (const e of emps) {
    const rec = byEmp.get(e.id);
    const rv = reviewerFrom(e, people);
    if (rec) {
      // keep the snapshot of an open record current (a transfer or a new Team Lead), and fill in a reviewer that was missing
      if (OPEN.includes(rec.status)) {
        const patch = {};
        if (e.department !== rec.department) patch.department = e.department || null;
        if (e.team !== rec.team) patch.team = e.team || null;
        if (e.designation !== rec.designation) patch.designation = e.designation || null;
        if (e.name !== rec.employeeName) patch.employeeName = e.name;
        if (rv.userId && rv.userId !== rec.reviewerUserId) { patch.reviewerUserId = rv.userId; patch.reviewerName = rv.name; }
        if (Object.keys(patch).length) await prisma.probationRecord.update({ where: { id: rec.id }, data: patch }); // eslint-disable-line no-await-in-loop
      }
      continue; // eslint-disable-line no-continue
    }
    const start = dayOfDate(e.dateOfJoining);
    if (!start) continue; // eslint-disable-line no-continue
    const months = monthsFor(e, st);
    const end = endFor(start, months);
    const tracked = end >= today;
    const created = await prisma.probationRecord.create({ // eslint-disable-line no-await-in-loop
      data: {
        employeeId: e.id, employeeCode: e.employeeCode, employeeName: e.name, department: e.department || null, team: e.team || null, designation: e.designation || null,
        startDate: toDate(start), months, endDate: toDate(end), originalEndDate: toDate(end),
        status: tracked ? 'In probation' : 'Not tracked', reviewerUserId: rv.userId, reviewerName: rv.name,
      },
    });
    await addEvent(created.id, 'Started', by, { toEnd: end, note: tracked ? `Probation of ${months} months from ${pretty(start)}.` : `Joined ${pretty(start)}, before probation tracking began. Not tracked.` }); // eslint-disable-line no-await-in-loop
    if (tracked) inProbation += 1; else notTracked += 1;
  }
  return { created: inProbation + notTracked, inProbation, notTracked, total: have.length + inProbation + notTracked };
}

// --- reminders --------------------------------------------------------------------------------------------------------------
function milestoneOf(left) {
  if (left < 0) return { kind: 'overdue', mark: `o${Math.floor(-left / 7)}` };
  if (left === 0) return { kind: 'today', mark: 'd0' };
  if (left <= 7) return { kind: 'soon', mark: 'd7' };
  if (left <= 30) return { kind: 'month', mark: 'd30' };
  return null;
}

/** One pass of reminders. `force` skips the once-a-day / after-9-am guard (tests, a manual run). -> { told: [...] } | { skipped } */
async function remind({ now = Date.now(), notify, force = false } = {}) {
  const st = await getSettings();
  if (!st.enabled) return { skipped: true, reason: 'Probation tracking is switched off.' };
  const today = istToday(now);
  let state = {};
  try { const r = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } }); state = r ? JSON.parse(r.value) : {}; } catch { state = {}; }
  if (!force && (state.lastRun === today || istHour(now) < 9)) return { told: [], skipped: true };
  const send = notify || require('./notify').notifyUsers; // eslint-disable-line global-require
  const recs = await prisma.probationRecord.findMany({ where: { status: { in: OPEN } } });
  const emps = await prisma.employee.findMany({ where: { id: { in: recs.map((r) => r.employeeId) } }, select: { id: true, employmentStatus: true } });
  const left = new Map(emps.map((e) => [e.id, GONE.includes(e.employmentStatus)]));
  const people = await peopleMaps();
  const told = [];
  for (const r of recs) {
    if (left.get(r.employeeId)) continue; // eslint-disable-line no-continue
    const end = dayOfDate(r.endDate);
    const days = daysBetween(today, end);
    const m = milestoneOf(days);
    if (!m) continue; // eslint-disable-line no-continue
    let marks = {};
    try { marks = r.remindState ? JSON.parse(r.remindState) : {}; } catch { marks = {}; }
    if (marks[m.mark]) continue; // eslint-disable-line no-continue
    const to = [...new Set([r.reviewerUserId, ...people.hr.map((u) => u.id)].filter(Boolean))];
    if (!to.length) continue; // eslint-disable-line no-continue
    const who = `${r.employeeName}${r.department ? ` (${r.department})` : ''}`;
    let title; let message;
    if (m.kind === 'overdue') {
      title = `⏰ Probation overdue: ${r.employeeName}`;
      message = `The probation of ${who} ended on ${pretty(end)} (${-days} day${-days === 1 ? '' : 's'} ago) and there is no decision yet. Team Lead: add the review. HR: confirm, extend or end service.`;
    } else if (m.kind === 'today') {
      title = `🌱 Probation ends today: ${r.employeeName}`;
      message = `The probation of ${who} ends today (${pretty(end)}). Team Lead: add the review. HR: confirm, extend or end service.`;
    } else {
      title = `🌱 Probation ends in ${days} day${days === 1 ? '' : 's'}: ${r.employeeName}`;
      message = `The probation of ${who} ends on ${pretty(end)}. Team Lead: add the review and your recommendation. HR: decide before that date.`;
    }
    await send(to, { title, message, open: '/probation' }).catch(() => null); // eslint-disable-line no-await-in-loop
    marks[m.mark] = today;
    await prisma.probationRecord.update({ where: { id: r.id }, data: { remindState: JSON.stringify(marks) } }); // eslint-disable-line no-await-in-loop
    told.push({ id: r.id, kind: m.kind, to });
  }
  const value = JSON.stringify({ lastRun: today });
  await prisma.appSetting.upsert({ where: { key: STATE_KEY }, update: { value }, create: { key: STATE_KEY, value } }).catch(() => null);
  return { told };
}

/** The nightly job: new joiners get a record, then the reminders. */
async function sweep(opts = {}) {
  const st = await getSettings();
  if (!st.enabled) return { skipped: true };
  const made = await sync(opts);
  const r = await remind(opts);
  return { sync: made, remind: r };
}

let timer = null;
function startSchedule() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const tick = () => { sweep().catch((e) => console.error('[probation]', e.message)); }; // eslint-disable-line no-console
  setTimeout(tick, 3 * 60 * 1000);
  timer = setInterval(tick, 60 * 60 * 1000); // hourly; it reminds once a day after 9 am
  if (timer.unref) timer.unref();
}

// --- reading -----------------------------------------------------------------------------------------------------------------
function shape(r, today = istToday()) {
  const end = dayOfDate(r.endDate);
  const open = OPEN.includes(r.status);
  const left = open && end ? daysBetween(today, end) : null;
  return {
    id: r.id, employeeId: r.employeeId, employeeCode: r.employeeCode, name: r.employeeName, department: r.department, team: r.team, designation: r.designation,
    status: r.status, months: r.months, startDate: dayOfDate(r.startDate), endDate: end, originalEndDate: dayOfDate(r.originalEndDate),
    daysLeft: left, overdue: open && left < 0, dueSoon: open && left >= 0 && left <= 30,
    reviewer: r.reviewerName || null, hasReviewer: !!r.reviewerUserId,
    review: r.reviewedAt ? { score: r.reviewScore, recommendation: r.reviewRecommendation, note: r.reviewNote, at: r.reviewedAt.toISOString(), by: r.reviewedByName } : null,
    confirmedOn: dayOfDate(r.confirmedOn), decisionNote: r.decisionNote || null, decidedBy: r.decidedByName || null, decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    hasLetter: !!r.letterDocumentId,
  };
}

const BUCKETS = {
  inProbation: (s) => OPEN.includes(s.status),
  due30: (s) => s.dueSoon,
  overdue: (s) => s.overdue,
  extended: (s) => s.status === 'Extended',
  confirmed: (s) => s.status === 'Confirmed',
  ending: (s) => s.status === 'Service ending',
  notTracked: (s) => s.status === 'Not tracked',
  all: () => true,
};

/** Who may see which records: HR / Admin everyone; everybody else the people in their own team scope (the same scope the employee lists use), never themselves. */
async function scopeFor(user) {
  if (hrmsGlobal(user)) return { all: true };
  const own = await prisma.employee.findFirst({ where: { userId: user.id }, select: { id: true } });
  const emps = await prisma.employee.findMany({ where: employeeWhere(user), select: { id: true } }).catch(() => []);
  const ids = new Set(emps.map((e) => e.id));
  if (own) ids.delete(own.id);
  return { all: false, ids, userId: user.id, ownId: own ? own.id : null };
}
const inScope = (sc, rec) => sc.all || (rec.employeeId !== sc.ownId && (sc.ids.has(rec.employeeId) || (!!rec.reviewerUserId && rec.reviewerUserId === sc.userId)));

/** -> { enabled, canDecide, months, counts, rows } */
async function list(user, { bucket = 'inProbation', dept = '', q = '' } = {}) {
  const st = await getSettings();
  const sc = await scopeFor(user);
  const today = istToday();
  const recs = await prisma.probationRecord.findMany({ orderBy: [{ endDate: 'asc' }, { employeeName: 'asc' }] });
  const mine = recs.filter((r) => inScope(sc, r)).map((r) => shape(r, today));
  const counts = Object.fromEntries(Object.entries(BUCKETS).map(([k, fn]) => [k, mine.filter(fn).length]));
  const pick = BUCKETS[bucket] || BUCKETS.inProbation;
  const needle = cleanLine(q, 80).toLowerCase();
  const depts = [...new Set(mine.map((s) => s.department).filter(Boolean))].sort();
  const rows = mine.filter(pick)
    .filter((s) => !dept || s.department === dept)
    .filter((s) => !needle || `${s.name} ${s.employeeCode || ''}`.toLowerCase().includes(needle));
  return { enabled: st.enabled, canDecide: hrmsGlobal(user), months: st.months, counts, departments: depts, bucket: BUCKETS[bucket] ? bucket : 'inProbation', rows };
}

async function loadOne(id) {
  return prisma.probationRecord.findUnique({ where: { id }, include: { events: { orderBy: { at: 'desc' } } } });
}
/** One record with its history. -> { record, events } | { error, status } */
async function detail(user, id) {
  const rec = await loadOne(id);
  if (!rec) return { error: 'There is no such probation record.', status: 404 };
  const sc = await scopeFor(user);
  if (!inScope(sc, rec)) return { error: 'This person is not in your team.', status: 403 };
  return {
    record: shape(rec),
    events: rec.events.map((e) => ({ id: e.id, kind: e.kind, at: e.at.toISOString(), by: e.byName, fromEnd: dayOfDate(e.fromEnd), toEnd: dayOfDate(e.toEnd), score: e.score, recommendation: e.recommendation, note: e.note })),
    canDecide: hrmsGlobal(user),
  };
}
async function byEmployee(user, employeeId) {
  const rec = await prisma.probationRecord.findUnique({ where: { employeeId: String(employeeId) } });
  if (!rec) return { record: null };
  const sc = await scopeFor(user);
  if (!inScope(sc, rec)) return { record: null };
  return { record: shape(rec) };
}

// --- the review (Team Lead) -------------------------------------------------------------------------------------------------
async function review(user, id, body) {
  const rec = await loadOne(id);
  if (!rec) return { error: 'There is no such probation record.', status: 404 };
  const sc = await scopeFor(user);
  if (!inScope(sc, rec)) return { error: 'This person is not in your team.', status: 403 };
  if (!OPEN.includes(rec.status)) return { error: 'This probation is already decided.', status: 409 };
  const b = body || {};
  const recommendation = String(b.recommendation || '');
  if (!RECOMMENDATIONS.includes(recommendation)) return { error: 'Choose a recommendation: Confirm, Extend or End service.', status: 400 };
  let score = null;
  if (b.score !== undefined && b.score !== null && b.score !== '') {
    score = Number(b.score);
    if (!Number.isInteger(score) || score < 0 || score > 100) return { error: 'The score is a whole number from 0 to 100.', status: 400 };
  }
  const note = cleanText(b.note, 1000);
  if (recommendation !== 'Confirm' && note.length < 3) return { error: 'Please write the reason for this recommendation.', status: 400 };
  await prisma.probationRecord.update({
    where: { id },
    data: { reviewScore: score, reviewRecommendation: recommendation, reviewNote: note || null, reviewedAt: new Date(), reviewedByName: user.name },
  });
  await addEvent(id, 'Review', user, { score, recommendation, note });
  await logAudit({ userId: user.id, action: 'Probation review added', entity: 'Probation', entityId: id, toValue: `${rec.employeeName}: ${recommendation}${score === null ? '' : `, score ${score}`}` });
  try {
    const people = await peopleMaps();
    await require('./notify').notifyUsers(people.hr.map((u) => u.id), { // eslint-disable-line global-require
      title: `📝 Probation review: ${rec.employeeName}`,
      message: `${user.name} recommends: ${recommendation}${score === null ? '' : ` (score ${score}/100)`}. HR can now decide.`,
      exceptUserId: user.id, open: '/probation',
    });
  } catch { /* the review is saved either way */ }
  return { record: shape(await prisma.probationRecord.findUnique({ where: { id } })) };
}

// --- the confirmation letter -------------------------------------------------------------------------------------------------
const fill = (text, facts) => String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (facts[k] === undefined ? m : facts[k]));

async function letterFor(rec, onDay) {
  const employee = await prisma.employee.findUnique({ where: { id: rec.employeeId } });
  if (!employee) throw new Error('The employee record is missing.');
  const EL = require('./exitLetters'); // eslint-disable-line global-require
  const signatory = await EL.loadSettings();
  const company = require('./companyContact').forLetter(await prisma.company.findFirst().catch(() => null)); // eslint-disable-line global-require
  const cfg = await getSettings();
  const facts = {
    name: rec.employeeName, employeeCode: rec.employeeCode || '', designation: employee.designation || rec.designation || 'your position', department: rec.department || '',
    company: company.name, startDate: pretty(dayOfDate(rec.startDate)), endDate: pretty(dayOfDate(rec.endDate)), confirmedOn: pretty(onDay),
  };
  const paras = cfg.letterText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => [{ b: false, t: fill(p.replace(/\n/g, ' '), facts) }]);
  const place = [employee.branch || employee.location || employee.city, employee.state].filter(Boolean).join(', ');
  const model = {
    kind: 'confirmation', title: 'CONFIRMATION LETTER', company, date: dmy(onDay), dateAlign: 'right',
    to: [rec.employeeName, rec.employeeCode ? `Employee Code: ${rec.employeeCode}` : null, place || null].filter(Boolean),
    heading: null, subject: 'Subject: Confirmation of employment', salutation: `Dear ${rec.employeeName},`, paras,
    sign: { company: company.name, name: signatory.signatoryName, title: signatory.signatoryTitle },
    fileName: `${LETTER_TYPE} - ${rec.employeeName}${rec.employeeCode ? ` (${rec.employeeCode})` : ''}.pdf`,
  };
  return { employee, pdf: await EL.renderPdf(model), fileName: model.fileName };
}

/** The letter as a PDF to look at (nothing is filed). `on` = the confirmation date, today when empty. -> { pdf, fileName } | { error, status } */
async function letterPreview(id, on) {
  const rec = await prisma.probationRecord.findUnique({ where: { id } });
  if (!rec) return { error: 'There is no such probation record.', status: 404 };
  const day = on ? String(on).slice(0, 10) : (dayOfDate(rec.confirmedOn) || istToday());
  if (!isDay(day)) return { error: 'The date is not valid.', status: 400 };
  try { const l = await letterFor(rec, day); return { pdf: l.pdf, fileName: l.fileName }; } catch (e) { return { error: `The letter could not be made: ${e.message}`, status: 500 }; }
}
/** Make the letter again and file it in the employee's documents (a newer one replaces the one TeamLink made before). */
async function letterFile(user, id) {
  const rec = await prisma.probationRecord.findUnique({ where: { id } });
  if (!rec) return { error: 'There is no such probation record.', status: 404 };
  if (rec.status !== 'Confirmed') return { error: 'The letter is made when the person is confirmed.', status: 409 };
  try {
    const l = await letterFor(rec, dayOfDate(rec.confirmedOn) || istToday());
    const { fileDocument } = require('./internalOnboarding'); // eslint-disable-line global-require
    const doc = await fileDocument(l.employee.id, LETTER_TYPE, l.pdf, l.fileName, user ? user.id : null);
    await prisma.probationRecord.update({ where: { id }, data: { letterDocumentId: doc.id } });
    await logAudit({ userId: user ? user.id : null, action: 'Confirmation letter generated', entity: 'Employee', entityId: l.employee.id, toValue: `${rec.employeeName} (${rec.employeeCode || ''})` });
    return { record: shape(await prisma.probationRecord.findUnique({ where: { id } })) };
  } catch (e) { return { error: `The letter could not be made: ${e.message}`, status: 500 }; }
}

// --- the decisions (HR) -----------------------------------------------------------------------------------------------------
async function openRecord(id) {
  const rec = await loadOne(id);
  if (!rec) return { error: 'There is no such probation record.', status: 404 };
  return { rec };
}
const finish = async (id) => ({ record: shape(await prisma.probationRecord.findUnique({ where: { id } })) });
async function tell(rec, user, title, message) {
  try { if (rec.reviewerUserId) await require('./notify').notifyUsers([rec.reviewerUserId], { title, message, exceptUserId: user.id, open: '/probation' }); } catch { /* the decision is saved either way */ } // eslint-disable-line global-require
}

async function confirm(user, id, body) {
  const { rec, error, status } = await openRecord(id);
  if (error) return { error, status };
  if (!OPEN.includes(rec.status)) return { error: 'Only a person who is in probation can be confirmed.', status: 409 };
  const b = body || {};
  const on = b.confirmedOn ? String(b.confirmedOn).slice(0, 10) : istToday();
  if (!isDay(on)) return { error: 'The confirmation date is not valid.', status: 400 };
  if (on < dayOfDate(rec.startDate)) return { error: 'The confirmation date is before the probation began.', status: 400 };
  const note = cleanText(b.note, 1000);
  let letterId = rec.letterDocumentId; let letterNote = null;
  if (b.makeLetter !== false) {
    try {
      const l = await letterFor({ ...rec, confirmedOn: toDate(on) }, on);
      const { fileDocument } = require('./internalOnboarding'); // eslint-disable-line global-require
      letterId = (await fileDocument(l.employee.id, LETTER_TYPE, l.pdf, l.fileName, user.id)).id;
    } catch (e) { letterNote = `Confirmed, but the letter could not be made (${cleanLine(e.message, 120)}). Use "Make the letter again" on the person.`; }
  }
  await prisma.probationRecord.update({
    where: { id }, data: { status: 'Confirmed', confirmedOn: toDate(on), decisionNote: note || null, decidedByName: user.name, decidedAt: new Date(), letterDocumentId: letterId, remindState: null },
  });
  await addEvent(id, 'Confirmed', user, { note: note || `Confirmed with effect from ${pretty(on)}.` });
  await logAudit({ userId: user.id, action: 'Probation confirmed', entity: 'Probation', entityId: id, toValue: `${rec.employeeName} with effect from ${on}` });
  await tell(rec, user, `✅ Probation confirmed: ${rec.employeeName}`, `HR confirmed ${rec.employeeName} with effect from ${pretty(on)}.`);
  return { ...(await finish(id)), letterNote };
}

async function extend(user, id, body) {
  const { rec, error, status } = await openRecord(id);
  if (error) return { error, status };
  if (!OPEN.includes(rec.status)) return { error: 'Only a person who is in probation can be extended.', status: 409 };
  const b = body || {};
  const months = Number(b.months);
  if (!Number.isInteger(months) || months < 1 || months > 12) return { error: 'Extend by a whole number of months, 1 to 12.', status: 400 };
  const reason = cleanText(b.reason, 1000);
  if (reason.length < 3) return { error: 'Please write the reason for the extension.', status: 400 };
  const from = dayOfDate(rec.endDate);
  const to = addMonths(from, months);
  await prisma.probationRecord.update({ where: { id }, data: { status: 'Extended', endDate: toDate(to), remindState: null, decisionNote: reason, decidedByName: user.name, decidedAt: new Date() } });
  await addEvent(id, 'Extended', user, { fromEnd: from, toEnd: to, note: `${months} month${months === 1 ? '' : 's'}: ${reason}` });
  await logAudit({ userId: user.id, action: 'Probation extended', entity: 'Probation', entityId: id, fromValue: from, toValue: `${rec.employeeName} until ${to}` });
  await tell(rec, user, `🔁 Probation extended: ${rec.employeeName}`, `The probation of ${rec.employeeName} now ends on ${pretty(to)}. Reason: ${reason}`);
  return finish(id);
}

async function endService(user, id, body) {
  const { rec, error, status } = await openRecord(id);
  if (error) return { error, status };
  if (!OPEN.includes(rec.status)) return { error: 'Only a person who is in probation can be marked for end of service.', status: 409 };
  const note = cleanText((body || {}).note, 1000);
  if (note.length < 3) return { error: 'Please write the reason.', status: 400 };
  await prisma.probationRecord.update({ where: { id }, data: { status: 'Service ending', decisionNote: note, decidedByName: user.name, decidedAt: new Date(), remindState: null } });
  await addEvent(id, 'Service ending', user, { note });
  await logAudit({ userId: user.id, action: 'Probation: service to end', entity: 'Probation', entityId: id, toValue: `${rec.employeeName}: ${note.slice(0, 200)}` });
  await tell(rec, user, `Probation: service to end for ${rec.employeeName}`, `HR decided that the service of ${rec.employeeName} will end. Reason: ${note}`);
  return { ...(await finish(id)), next: 'This only records the decision. Open Exit Center to start the exit for this person.' };
}

async function reopen(user, id, body) {
  const { rec, error, status } = await openRecord(id);
  if (error) return { error, status };
  if (!['Confirmed', 'Service ending'].includes(rec.status)) return { error: 'Only a Confirmed or Service ending decision can be undone.', status: 409 };
  const note = cleanText((body || {}).note, 1000);
  if (note.length < 3) return { error: 'Please write why the decision is undone.', status: 400 };
  const back = dayOfDate(rec.endDate) !== dayOfDate(rec.originalEndDate) ? 'Extended' : 'In probation';
  await prisma.probationRecord.update({ where: { id }, data: { status: back, confirmedOn: null, decisionNote: null, decidedByName: null, decidedAt: null, remindState: null } });
  await addEvent(id, 'Reopened', user, { note: `${rec.status} undone: ${note}` });
  await logAudit({ userId: user.id, action: 'Probation decision undone', entity: 'Probation', entityId: id, fromValue: rec.status, toValue: `${rec.employeeName}: ${note.slice(0, 200)}` });
  return finish(id);
}

async function track(user, id, body) {
  const { rec, error, status } = await openRecord(id);
  if (error) return { error, status };
  if (rec.status !== 'Not tracked') return { error: 'This person is already tracked.', status: 409 };
  const st = await getSettings();
  const b = body || {};
  const start = b.startDate ? String(b.startDate).slice(0, 10) : dayOfDate(rec.startDate);
  if (!isDay(start)) return { error: 'The start date is not valid.', status: 400 };
  const emp = await prisma.employee.findUnique({ where: { id: rec.employeeId }, select: EMP_SELECT });
  const months = b.months === undefined || b.months === '' ? (emp ? monthsFor(emp, st) : st.months) : Number(b.months);
  if (!Number.isInteger(months) || months < 1 || months > 12) return { error: 'The probation length is a whole number of months, 1 to 12.', status: 400 };
  const end = endFor(start, months);
  const people = await peopleMaps();
  const rv = emp ? reviewerFrom(emp, people) : { userId: rec.reviewerUserId, name: rec.reviewerName };
  await prisma.probationRecord.update({
    where: { id }, data: { status: 'In probation', startDate: toDate(start), months, endDate: toDate(end), originalEndDate: toDate(end), reviewerUserId: rv.userId || rec.reviewerUserId, reviewerName: rv.name || rec.reviewerName, remindState: null },
  });
  await addEvent(id, 'Tracking started', user, { toEnd: end, note: `Probation of ${months} months from ${pretty(start)}.` });
  await logAudit({ userId: user.id, action: 'Probation tracking started for a person', entity: 'Probation', entityId: id, toValue: `${rec.employeeName} until ${end}` });
  return finish(id);
}

module.exports = {
  OPEN, GONE, RECOMMENDATIONS, DEFAULT_LETTER, LETTER_TYPE,
  getSettings, saveSettings, sync, remind, sweep, startSchedule,
  list, detail, byEmployee, review, confirm, extend, endService, reopen, track, letterPreview, letterFile,
  // for tests
  addMonths, endFor, milestoneOf, shape, istToday, isLead, monthsFor,
};
