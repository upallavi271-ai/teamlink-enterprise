// ---------------------------------------------------------------------------
// PENDING WORK -> THE TEAM LEAD (user, 2026-10-10: "when a recruiter has pending
// work, the TL must get a reminder").
//
// WHAT "PENDING" MEANS — nothing new is invented. It is the SAME rows the
// dashboard's Team snapshot counts (utils/atsHome.js pendingLoad, which feeds
// that snapshot): one row per live ATS application, attributed to a recruiter,
// with the ONE next action and due date of utils/nextAction.js.
//
//   Waiting     every live row of the person except "Not moving" (Stale) ones
//   Due today   Waiting rows whose due day is today
//   Late        Waiting rows whose due day has passed       (Late is part of Waiting)
//   Not moving  old imported backlog with nothing happening — never reminded
//   Follow-ups late / due today   open follow-ups the person owns (Follow-ups tab)
//   Jobs with no profile sent     live jobs, past the client's "first profiles within
//                                 N days" promise, with nobody sent to the client yet
//   By type     the step the row waits at: Check by recruiter · Team lead check ·
//               With the BDE · Client has not replied · Interview to fix / on · Interview
//               done (feedback) · Offer / joining · On hold  (atsAlertSettings STEP_GROUPS)
//
// WHO GETS TOLD — the recruiter's TL, resolved in this order:
//   1. the TL above the recruiter's seat / the TL on the employee record
//   2. the TL most of the recruiter's jobs name
//   3. the department's default TL (utils/defaultTeamLead.js)
//   4. nobody found: the department's STL, else its Managers (never lost)
//
// WHAT IS SENT (bell + e-mail through the existing notification / mail system):
//   * the DAILY DIGEST, once a day at the set time (default 10:30 IST), skipped on a
//     Sunday / holiday and when nothing is pending;
//   * the ESCALATION: a recruiter's own step later than N days (default 2) tells the TL
//     ONCE per item, and the STL / Managers once more when it passes a second limit;
//   * the "REMIND" button: one polite nudge to the recruiter (bell, plus WhatsApp / SMS
//     / mail when that channel is connected AND switched on here); once per recruiter
//     per item per day; logged.
//   * the BDE version for client work (utils/clientWork.js), copied to the BDE TL.
//
// ONE SWEEP, ONE DEDUPE. startSweep() is the same setInterval pattern as the other
// sweeps (real server only; the test sandbox runs no timers and tests call run*()).
// "Already sent today" is the AppSetting row pwr.sent.<IST day> (a small JSON), so
// nothing is sent twice and no schema change is needed. Settings: AppSetting
// pendingwork.settings. Test logins (ZZTEST / example.test) never receive anything
// from the real sweeps.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const NA = require('./nextAction');
const V = require('./atsVocab');
const AS = require('./atsAlertSettings');
const CS = require('./clientSla');
const { logAudit } = require('./audit');
const { canonicalDepartment } = require('./bdeDesk');
const M = require('./reportMailHtml');

const DAY_MS = 86400000;
const TEST_RE = /zztest|example\.test/i;
const isTest = (s) => TEST_RE.test(String(s || ''));
const SETTINGS_KEY = 'pendingwork.settings';
const SENT_PREFIX = 'pwr.sent.';
const ESC_KEY = 'pwr.escalated';

// ---------------------------------------------------------------------------
// TIME (IST)
// ---------------------------------------------------------------------------
const istShift = (now) => new Date((now || new Date()).getTime() + 330 * 60000);
const dayOfIst = (now) => istShift(now).toISOString().slice(0, 10);
const hhmmOfIst = (now) => istShift(now).toISOString().slice(11, 16);
const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function niceDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Sunday and the company's holidays (HRMS → Holidays; "Optional" ones do not count).
async function offDayReason(day) {
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) return 'Sunday';
  const rows = await prisma.holiday.findMany({ where: { date: day }, select: { name: true, type: true } }).catch(() => []);
  const h = rows.find((r) => !/optional/i.test(r.type || ''));
  return h ? `Holiday (${h.name})` : null;
}

// ---------------------------------------------------------------------------
// SETTINGS — Administration → Company Setup → Step timing (Super Admin / Admin / HR)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: false, // OFF until main / Super Admin / HR switches it on (Step timing → Reminders to team leads): nothing is sent by a timer on its own
  bell: true,
  email: true,
  digestTime: '10:30',
  // Who else gets a copy of a team lead's digest: the department's STL / its Managers.
  copyStl: true,
  copyManager: false,
  // A recruiter's own step later than afterDays tells the TL once; later than managerAfterDays tells the STL / Managers once.
  escalation: { enabled: true, afterDays: 2, managerAfterDays: 4 },
  // The BDE side (client work): the BDE gets the digest, the BDE TL a copy.
  bde: { enabled: true, feedbackDays: 3, copyBdeTl: true },
  // "Remind" sends a bell notice always; these add a message on the recruiter's own phone / mail when that channel is connected.
  nudge: { whatsapp: false, sms: false, email: false },
  // PENDING APPROVALS + OVERDUE FOLLOW-UPS -> EVERYONE ABOVE (utils/chainAlerts.js): level 0 the owner, then each level up
  // (TL, STL, Manager, Admin) after its own hours (0 = at once), repeated every working day until cleared.
  // tasks: overdue Tasks and personal to-dos of a recruiter (the Timesheet); steps: a recruiter's late next steps, interview feedback not
  // recorded, "check by recruiter" and (after the end-of-day time) calls due today that were not made. utils/missedItems.js.
  chain: { enabled: true, approvals: true, followUps: true, tasks: true, steps: true, repeatDaily: true, maxLevel: 4, levelHours: [0, 0, 0, 0, 0] },
  // "Also remind the person themselves" (user, 2026-10-12): what a recruiter missed goes to the recruiter as well as the team lead. ON once the
  // master switch is on. The bell always (when on here); e-mail / WhatsApp / SMS only when that channel is connected AND switched on here.
  // Nothing is sent before `time` (the morning after).
  self: { enabled: true, bell: true, email: true, whatsapp: false, sms: false, time: '09:30' },
  // The end-of-day report (utils/eodReport.js).
  eod: { enabled: true, time: '18:45', copyStl: true, copyManager: false, quiet: 'short', excel: true, offTls: [] },
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const bool = (v, fb) => (v === undefined ? fb : v === true || v === 'true');
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

function normalise(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULTS;
  const esc = v.escalation || {};
  const bde = v.bde || {};
  const nudge = v.nudge || {};
  const eod = v.eod || {};
  const chain = v.chain || {};
  const self = v.self || {};
  const afterDays = int(esc.afterDays, 0, 60) ?? d.escalation.afterDays;
  return {
    enabled: bool(v.enabled, d.enabled),
    bell: bool(v.bell, d.bell),
    email: bool(v.email, d.email),
    digestTime: HHMM.test(String(v.digestTime || '')) ? v.digestTime : d.digestTime,
    copyStl: bool(v.copyStl, d.copyStl),
    copyManager: bool(v.copyManager, d.copyManager),
    escalation: {
      enabled: bool(esc.enabled, d.escalation.enabled),
      afterDays,
      managerAfterDays: Math.max(int(esc.managerAfterDays, 0, 90) ?? d.escalation.managerAfterDays, afterDays),
    },
    bde: {
      enabled: bool(bde.enabled, d.bde.enabled),
      feedbackDays: int(bde.feedbackDays, 1, 60) ?? d.bde.feedbackDays,
      copyBdeTl: bool(bde.copyBdeTl, d.bde.copyBdeTl),
    },
    nudge: { whatsapp: bool(nudge.whatsapp, false), sms: bool(nudge.sms, false), email: bool(nudge.email, false) },
    chain: {
      enabled: bool(chain.enabled, d.chain.enabled),
      approvals: bool(chain.approvals, d.chain.approvals),
      followUps: bool(chain.followUps, d.chain.followUps),
      tasks: bool(chain.tasks, d.chain.tasks),
      steps: bool(chain.steps, d.chain.steps),
      repeatDaily: bool(chain.repeatDaily, d.chain.repeatDaily),
      maxLevel: int(chain.maxLevel, 1, 4) ?? d.chain.maxLevel,
      levelHours: d.chain.levelHours.map((fb, i) => (Array.isArray(chain.levelHours) ? int(chain.levelHours[i], 0, 720) : null) ?? fb),
    },
    self: {
      enabled: bool(self.enabled, d.self.enabled),
      bell: bool(self.bell, d.self.bell),
      email: bool(self.email, d.self.email),
      whatsapp: bool(self.whatsapp, d.self.whatsapp),
      sms: bool(self.sms, d.self.sms),
      time: HHMM.test(String(self.time || '')) ? self.time : d.self.time,
    },
    eod: {
      enabled: bool(eod.enabled, d.eod.enabled),
      time: HHMM.test(String(eod.time || '')) ? eod.time : d.eod.time,
      copyStl: bool(eod.copyStl, d.eod.copyStl),
      copyManager: bool(eod.copyManager, d.eod.copyManager),
      quiet: eod.quiet === 'skip' ? 'skip' : 'short',
      excel: bool(eod.excel, d.eod.excel),
      offTls: Array.isArray(eod.offTls) ? eod.offTls.map(String).filter(Boolean) : [],
    },
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
    updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null,
  };
}

let CACHE = { at: 0, settings: normalise(null) };
async function getSettings({ fresh = false } = {}) {
  if (!fresh && Date.now() - CACHE.at < 5000) return CACHE.settings;
  // A busy database must never read as "no settings" (= switched off, the defaults): keep what was last known.
  let row;
  try { row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }); } catch (err) {
    if (CACHE.at) return CACHE.settings;
    throw err;
  }
  let v = null;
  try { v = row && row.value ? JSON.parse(row.value) : null; } catch { v = null; }
  CACHE = { at: Date.now(), settings: normalise(v) };
  return CACHE.settings;
}

// patch: any part of the settings; returns { settings, before } or { error }.
async function saveSettings(patch, user) {
  const cur = await getSettings({ fresh: true });
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = JSON.parse(JSON.stringify(cur));
  const err = [];
  const time = (label, val) => { if (!HHMM.test(String(val))) { err.push(`${label}: write the time like 10:30.`); return null; } return String(val); };
  ['enabled', 'bell', 'email', 'copyStl', 'copyManager'].forEach((k) => { if (p[k] !== undefined) next[k] = p[k] === true || p[k] === 'true'; });
  if (p.digestTime !== undefined) next.digestTime = time('Digest time', p.digestTime) || next.digestTime;
  if (p.escalation && typeof p.escalation === 'object') {
    const e = p.escalation;
    if (e.enabled !== undefined) next.escalation.enabled = e.enabled === true || e.enabled === 'true';
    if (e.afterDays !== undefined) { const n = int(e.afterDays, 0, 60); if (n === null) err.push('Tell the team lead after: a number of days from 0 to 60.'); else next.escalation.afterDays = n; }
    if (e.managerAfterDays !== undefined) { const n = int(e.managerAfterDays, 0, 90); if (n === null) err.push('Tell the STL / Manager after: a number of days from 0 to 90.'); else next.escalation.managerAfterDays = n; }
    if (next.escalation.managerAfterDays < next.escalation.afterDays) err.push('The STL / Manager are told after the team lead: pick the same number of days or more.');
  }
  if (p.bde && typeof p.bde === 'object') {
    const b = p.bde;
    if (b.enabled !== undefined) next.bde.enabled = b.enabled === true || b.enabled === 'true';
    if (b.copyBdeTl !== undefined) next.bde.copyBdeTl = b.copyBdeTl === true || b.copyBdeTl === 'true';
    if (b.feedbackDays !== undefined) { const n = int(b.feedbackDays, 1, 60); if (n === null) err.push('Client feedback pending after: a number of days from 1 to 60.'); else next.bde.feedbackDays = n; }
  }
  if (p.nudge && typeof p.nudge === 'object') {
    ['whatsapp', 'sms', 'email'].forEach((k) => { if (p.nudge[k] !== undefined) next.nudge[k] = p.nudge[k] === true || p.nudge[k] === 'true'; });
  }
  if (p.chain && typeof p.chain === 'object') {
    const c = p.chain;
    ['enabled', 'approvals', 'followUps', 'tasks', 'steps', 'repeatDaily'].forEach((k) => { if (c[k] !== undefined) next.chain[k] = c[k] === true || c[k] === 'true'; });
    if (c.maxLevel !== undefined) { const n = int(c.maxLevel, 1, 4); if (n === null) err.push('Tell up to level: a number from 1 (the team lead) to 4 (the Admin).'); else next.chain.maxLevel = n; }
    if (Array.isArray(c.levelHours)) {
      c.levelHours.slice(0, 5).forEach((v, i) => { const n = int(v, 0, 720); if (n === null) err.push('Hours before telling a level: a number from 0 to 720.'); else next.chain.levelHours[i] = n; });
    }
  }
  if (p.self && typeof p.self === 'object') {
    const e = p.self;
    ['enabled', 'bell', 'email', 'whatsapp', 'sms'].forEach((k) => { if (e[k] !== undefined) next.self[k] = e[k] === true || e[k] === 'true'; });
    if (e.time !== undefined) next.self.time = time('Remind the person at', e.time) || next.self.time;
  }
  if (p.eod && typeof p.eod === 'object') {
    const e = p.eod;
    if (e.enabled !== undefined) next.eod.enabled = e.enabled === true || e.enabled === 'true';
    if (e.time !== undefined) next.eod.time = time('End-of-day report time', e.time) || next.eod.time;
    ['copyStl', 'copyManager', 'excel'].forEach((k) => { if (e[k] !== undefined) next.eod[k] = e[k] === true || e[k] === 'true'; });
    if (e.quiet !== undefined) next.eod.quiet = e.quiet === 'skip' ? 'skip' : 'short';
    if (Array.isArray(e.offTls)) next.eod.offTls = e.offTls.map(String).filter(Boolean);
  }
  if (err.length) return { error: err.join(' ') };
  next.updatedAt = new Date().toISOString();
  next.updatedBy = user ? (user.name || user.id) : null;
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    create: { key: SETTINGS_KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  CACHE = { at: Date.now(), settings: normalise(next) };
  return { settings: CACHE.settings, before: cur };
}

// ---------------------------------------------------------------------------
// "ALREADY SENT" — one small JSON row per IST day (pwr.sent.<day>), read and written
// one at a time so two overlapping sweeps can never both claim the same slot.
// ---------------------------------------------------------------------------
let QUEUE = Promise.resolve();
const locked = (fn) => { const run = QUEUE.then(fn, fn); QUEUE = run.catch(() => null); return run; };
const emptySent = () => ({ digest: {}, esc: {}, bde: {}, eod: {}, nudge: {}, copy: {} });
async function readSent(day) {
  const row = await prisma.appSetting.findUnique({ where: { key: `${SENT_PREFIX}${day}` } }).catch(() => null);
  let v = null;
  try { v = row && row.value ? JSON.parse(row.value) : null; } catch { v = null; }
  return { ...emptySent(), ...(v || {}) };
}
async function writeSent(day, sent) {
  const key = `${SENT_PREFIX}${day}`;
  const value = JSON.stringify(sent);
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}
// Claims bucket[id] for the day. Returns false when it was already claimed.
function claim(day, bucket, id, info = {}) {
  return locked(async () => {
    const sent = await readSent(day);
    if (sent[bucket][id]) return false;
    sent[bucket][id] = { at: new Date().toISOString(), ...info };
    await writeSent(day, sent);
    return true;
  });
}
function peek(day, bucket, id) {
  return readSent(day).then((s) => s[bucket][id] || null);
}
// Old day rows are dropped (kept 14 days).
async function pruneSent(day) {
  const cut = new Date(new Date(`${day}T00:00:00Z`).getTime() - 14 * DAY_MS).toISOString().slice(0, 10);
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: SENT_PREFIX } }, select: { key: true } }).catch(() => []);
  const old = rows.filter((r) => r.key.slice(SENT_PREFIX.length) < cut).map((r) => r.key);
  if (old.length) await prisma.appSetting.deleteMany({ where: { key: { in: old } } }).catch(() => null);
}

// ---------------------------------------------------------------------------
// THE TYPES — what a row is waiting for, in plain words (STEP_GROUPS of Step timing).
// ---------------------------------------------------------------------------
const TYPES = [
  { id: 'review', label: 'Check by recruiter', groups: ['new', 'ai', 'recruiter'], who: 'Recruiter' },
  { id: 'tl', label: 'Waiting for team lead check', groups: ['tl'], who: 'Team lead' },
  { id: 'bde', label: 'With the client manager (BDE)', groups: ['bde'], who: 'BDE' },
  { id: 'client', label: 'Client has not replied', groups: ['client'], who: 'Client' },
  { id: 'interview', label: 'Interview to fix or coming up', groups: ['schedule', 'interview'], who: 'BDE' },
  { id: 'feedback', label: 'Interview done, feedback not recorded', groups: ['feedback'], who: 'BDE' },
  { id: 'offer', label: 'Offer or joining', groups: ['selected', 'offer', 'join'], who: 'Recruiter' },
  { id: 'hold', label: 'On hold, look again', groups: ['hold'], who: 'Recruiter' },
];
const TYPE_OF_GROUP = Object.fromEntries(TYPES.flatMap((t) => t.groups.map((g) => [g, t])));
const typeOfStage = (stage) => {
  const r = AS.stageRule(stage);
  return (r && TYPE_OF_GROUP[r.group]) || TYPES[0];
};
const LATENESS = [
  { id: 'late', label: 'Late' },
  { id: 'due_today', label: 'Due today' },
  { id: 'later', label: 'Coming up' },
];

const CLIENT_CHAIN = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED',
  'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'];

// One dashboard row -> the small item the digest / reminders use.
function itemOf(x, today) {
  const r = (x.a && x.a.requirement) || {};
  const na = x.na || {};
  const daysLate = na.dueStatus === 'overdue' && na.dueAt ? Math.max(0, daysBetween(na.dueAt, today)) : 0;
  const t = typeOfStage(x.a.stage);
  return {
    applicationId: x.a.id,
    candidateId: x.a.candidateId,
    candidate: x.cand || '—',
    requirementId: x.a.requirementId,
    job: r.title || '—',
    client: x.internal ? 'TeamLink Internal' : ((r.client && r.client.name) || '—'),
    stage: x.a.stage,
    step: require('./atsHome').stepWord(x.a.stage), // eslint-disable-line global-require
    type: t.id,
    typeLabel: t.label,
    action: na.action || null,
    ownerRole: na.ownerRole || null,
    ownerUserId: na.ownerUserId || null,
    dueAt: na.dueAt || null,
    status: na.dueStatus === 'overdue' ? 'late' : na.dueStatus === 'due_today' ? 'due_today' : 'later',
    daysLate,
  };
}
const ORDER = { late: 0, due_today: 1, later: 2 };
const byUrgency = (a, b) => (ORDER[a.status] - ORDER[b.status]) || (b.daysLate - a.daysLate) || String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999'));
// The step is the recruiter's own (named owner, or the Recruiter / HR role) — what a nudge or an escalation is about.
const isOwnStep = (it, userId) => (it.ownerUserId ? it.ownerUserId === userId : ['Recruiter', 'HR'].includes(it.ownerRole));

const baseUrl = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const pathPending = (userId) => `/ats/team?view=pending&owner=${encodeURIComponent(userId)}`;
const pathWho = (userId) => `/ats/team?view=whohas${userId ? `&person=${encodeURIComponent(userId)}` : ''}`;
const absolute = (p) => (baseUrl() ? `${baseUrl()}${p}` : p);

// ---------------------------------------------------------------------------
// THE DIRECTORY — recruiters, their TL (the order in the header), STL, Managers.
// `viewer` is a Super Admin login (the company-wide reading); the real sweeps pick one.
// ---------------------------------------------------------------------------
// A test login (ZZTEST) calling the routes is read with a test Super Admin, so the fixtures are in the picture; everyone
// else with a real Super Admin (test people never take part in a real run).
async function viewerFor(user) {
  if (!user || !isTest(`${user.name || ''} ${user.email || ''}`)) return null;
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', name: { contains: 'ZZTEST' } }, select: { id: true } });
  return sa ? resolveIdentity(sa.id) : null;
}
async function pickViewer(viewer) {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  if (viewer) return viewer;
  const sas = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true, name: true, email: true }, orderBy: { createdAt: 'asc' }, take: 20 });
  const sa = sas.find((u) => !isTest(`${u.name} ${u.email}`));
  return sa ? resolveIdentity(sa.id) : null;
}

async function stlsAndManagers(department) {
  const dept = canonicalDepartment(department);
  const users = await prisma.user.findMany({
    where: { status: 'Active', atsAccess: true, atsRole: { in: ['STL', 'MANAGER', 'ASSISTANT_MANAGER'] } },
    select: { id: true, name: true, email: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true },
  });
  const deptsOf = (u) => [u.atsDepartment, ...String(u.atsScopeDepartments || '').split(',')].map((d) => canonicalDepartment(d)).filter(Boolean);
  const covers = (u) => (u.atsRole === 'MANAGER' && !deptsOf(u).length) || (dept && deptsOf(u).includes(dept));
  return {
    stls: users.filter((u) => u.atsRole === 'STL' && covers(u)),
    managers: users.filter((u) => ['MANAGER', 'ASSISTANT_MANAGER'].includes(u.atsRole) && covers(u)),
  };
}

async function directory(viewer) {
  const TW = require('./teamWorkload'); // eslint-disable-line global-require
  const DTL = require('./defaultTeamLead'); // eslint-disable-line global-require
  await DTL.prime();
  const world = await TW.teamWorld(viewer);
  const testViewer = isTest(`${viewer.name || ''} ${viewer.email || ''}`);
  const ok = (p) => testViewer || !isTest(p.name);
  const tlById = new Map(world.people.filter((p) => p.role === 'TL' && p.status === 'Active' && ok(p)).map((p) => [p.id, p]));
  const recruiters = world.people.filter((p) => p.roleGroup === 'RECRUITER' && p.status === 'Active' && ok(p));
  // The TL most of a person's jobs name.
  const jobTl = new Map();
  world.actions.forEach((a) => {
    if (!a.ownerUserId || !a.tlUserId) return;
    const m = jobTl.get(a.ownerUserId) || new Map();
    m.set(a.tlUserId, (m.get(a.tlUserId) || 0) + 1);
    jobTl.set(a.ownerUserId, m);
  });
  const resolved = recruiters.map((p) => {
    if (p.tlUserId && tlById.has(p.tlUserId)) return { p, tlId: p.tlUserId, how: 'seat or employee record' };
    const m = jobTl.get(p.id);
    if (m) {
      const best = [...m.entries()].filter(([id]) => tlById.has(id)).sort((a, b) => b[1] - a[1])[0];
      if (best) return { p, tlId: best[0], how: 'requirement team lead' };
    }
    const dflt = DTL.defaultFor(p.department);
    if (dflt && tlById.has(dflt.id)) return { p, tlId: dflt.id, how: 'department default TL' };
    return { p, tlId: null, how: 'none' };
  });
  return { world, tlById, resolved, testViewer };
}

// ---------------------------------------------------------------------------
// COLLECT — per recruiter: the numbers (= the dashboard's Team snapshot) and the items.
// ---------------------------------------------------------------------------
function emptyCounts() {
  return { waiting: 0, late: 0, dueToday: 0, notMoving: 0, followUpsLate: 0, followUpsToday: 0, jobsNoSubmission: 0, tasksLate: 0 };
}

// Follow-ups per owner (the Follow-ups tab's definition: open, owned, past due / due today).
async function followUpCounts(userIds, today) {
  const out = new Map(userIds.map((id) => [id, { late: 0, today: 0 }]));
  if (!userIds.length) return out;
  const rows = await prisma.applicationFollowUp.findMany({
    where: { completedAt: null, ownerUserId: { in: userIds }, dueDate: { lte: `${today}￿` }, application: { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] } } },
    select: { ownerUserId: true, dueDate: true },
  });
  rows.forEach((f) => {
    const due = String(f.dueDate || '').slice(0, 10);
    if (!due) return;
    const c = out.get(f.ownerUserId);
    if (due < today) c.late += 1; else if (due === today) c.today += 1;
  });
  return out;
}

// Tasks and personal to-dos past their end date, per assignee (the Timesheet's own rule: not finished, end date passed).
async function taskCounts(userIds, today) {
  const out = new Map(userIds.map((id) => [id, 0]));
  if (!userIds.length) return out;
  const rows = await prisma.task.findMany({
    where: { assigneeId: { in: userIds }, status: { in: ['Not Started', 'In Progress', 'On Hold'] }, endDate: { not: null, lt: today } },
    select: { assigneeId: true },
  }).catch(() => []);
  rows.forEach((t) => out.set(t.assigneeId, (out.get(t.assigneeId) || 0) + 1));
  return out;
}

// Live, past-promise jobs of each recruiter with nobody sent to the client yet.
function jobsWithoutProfile(world, today) {
  const sentJobs = new Set();
  world.rows.forEach((x) => { if (CLIENT_CHAIN.includes(x.a.stage) || x.evs.some((e) => CLIENT_CHAIN.includes(e.to))) sentJobs.add(x.a.requirementId); });
  const bulk = NA.snapshot().bulkDays || new Set();
  const out = new Map();
  world.reqs.forEach((r) => {
    if (!V.REQUIREMENT_LIVE_STATUSES.includes(r.status) || r.internal || sentJobs.has(r.id)) return;
    const made = new Date(r.createdAt).getTime();
    if (Number.isNaN(made) || bulk.has(NA.istDay(made)) || made < Date.now() - 30 * DAY_MS) return; // imported / old backlog is not today's work
    const promise = CS.firstProfilesDaysNow(r.clientId);
    if (daysBetween(NA.istDay(made), today) <= promise) return;
    const ids = [r.recruiterId, ...String(r.recruiterIds || '').split(',')].map((s) => String(s || '').trim()).filter(Boolean);
    [...new Set(ids)].forEach((id) => {
      const list = out.get(id) || [];
      list.push({ requirementId: r.id, job: r.title, client: (r.client && r.client.name) || '—', daysOpen: daysBetween(NA.istDay(made), today) });
      out.set(id, list);
    });
  });
  return out;
}

// A person's block from a pendingLoad() group (or nothing).
function blockOf(person, group, load, extras, today, { notMoving = 0 } = {}) {
  const items = group ? group.pending.map((x) => itemOf(x, today)).sort(byUrgency) : [];
  const counts = emptyCounts();
  counts.waiting = items.length;
  counts.late = items.filter((i) => i.status === 'late').length;
  counts.dueToday = items.filter((i) => i.status === 'due_today').length;
  counts.notMoving = notMoving;
  const fu = extras.fu.get(person.id) || { late: 0, today: 0 };
  counts.followUpsLate = fu.late;
  counts.followUpsToday = fu.today;
  counts.tasksLate = extras.tasks ? (extras.tasks.get(person.id) || 0) : 0;
  const jobs = extras.jobs.get(person.id) || [];
  counts.jobsNoSubmission = jobs.length;
  const byType = TYPES.map((t) => {
    const list = items.filter((i) => i.type === t.id);
    return { id: t.id, label: t.label, who: t.who, n: list.length, late: list.filter((i) => i.status === 'late').length, due: list.filter((i) => i.status === 'due_today').length };
  }).filter((t) => t.n);
  return {
    userId: person.id,
    name: person.name,
    department: person.department || null,
    seat: person.seat || null,
    counts,
    byType,
    items,
    jobs,
    mine: items.filter((i) => isOwnStep(i, person.id)).length,
    link: pathPending(person.id),
  };
}

// Everything the digest / the Pending-work tab need, per resolved TL.
//   returns { today, teams: Map(tlId -> { tl, blocks[] }), unrouted: [{ block, department }] , all: block[] }
// `people` (tests): only these recruiter logins are looked at, nobody else is read or told.
async function collectTeams({ viewer, only = null, people = null, fresh = false } = {}) {
  const AH = require('./atsHome'); // eslint-disable-line global-require
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const dir = await directory(viewer);
  const adminLoad = await AH.pendingLoad(viewer, { fresh });
  const today = adminLoad.today;
  const adminBy = new Map(adminLoad.people.filter((e) => e.userId).map((e) => [e.userId, e]));
  const adminNotMoving = (id) => adminLoad.notMoving.get(`u:${id}`) || 0;
  if (people) dir.resolved = dir.resolved.filter((r) => people.includes(r.p.id));
  const ids = dir.resolved.map((r) => r.p.id);
  const extras = { fu: await followUpCounts(ids, today), tasks: await taskCounts(ids, today), jobs: jobsWithoutProfile(adminLoad.world, today) };
  const teams = new Map();
  const unrouted = [];
  const all = [];
  const byTl = new Map();
  dir.resolved.forEach((r) => {
    if (!r.tlId) { unrouted.push(r); return; }
    if (only && only !== r.tlId) return;
    const list = byTl.get(r.tlId) || [];
    list.push(r);
    byTl.set(r.tlId, list);
  });
  for (const [tlId, list] of byTl.entries()) {
    const tlPerson = dir.tlById.get(tlId);
    // eslint-disable-next-line no-await-in-loop
    const tlViewer = await resolveIdentity(tlId).catch(() => null);
    // The TL's own screen: the same world, so his Team snapshot and this digest agree.
    // eslint-disable-next-line no-await-in-loop
    const load = tlViewer ? await AH.pendingLoad(tlViewer, { fresh }).catch(() => null) : null;
    const by = load ? new Map(load.people.filter((e) => e.userId).map((e) => [e.userId, e])) : new Map();
    const blocks = list.map((r) => {
      const inScreen = by.has(r.p.id);
      const group = inScreen ? by.get(r.p.id) : adminBy.get(r.p.id);
      const nm = inScreen ? ((load.notMoving.get(`u:${r.p.id}`)) || 0) : adminNotMoving(r.p.id);
      return { ...blockOf(r.p, group, load || adminLoad, extras, today, { notMoving: nm }), how: r.how };
    }).sort((a, b) => b.counts.late - a.counts.late || b.counts.dueToday - a.counts.dueToday || b.counts.waiting - a.counts.waiting || a.name.localeCompare(b.name));
    teams.set(tlId, { tl: { id: tlId, name: tlPerson.name, department: tlPerson.department }, blocks });
    all.push(...blocks);
  }
  const unroutedBlocks = unrouted.map((r) => ({ block: { ...blockOf(r.p, adminBy.get(r.p.id), adminLoad, extras, today, { notMoving: adminNotMoving(r.p.id) }), how: 'none' }, department: r.p.department }));
  return { today, teams, unrouted: unroutedBlocks, all, dir };
}

const nothingPending = (blocks) => !blocks.some((b) => b.counts.waiting || b.counts.followUpsLate || b.counts.jobsNoSubmission || b.counts.tasksLate);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// THE DIGEST TEXT / HTML — one block per recruiter: counts, types, the 5 most urgent.
// ---------------------------------------------------------------------------
function totalsOf(blocks) {
  const t = emptyCounts();
  blocks.forEach((b) => Object.keys(t).forEach((k) => { t[k] += b.counts[k] || 0; }));
  return t;
}
function dueWords(i) {
  if (i.status === 'late') return `${plural(i.daysLate, 'day', 'days')} late`;
  if (i.status === 'due_today') return 'due today';
  return i.dueAt ? `due ${i.dueAt}` : 'coming up';
}
const itemLine = (i) => `${i.candidate} — ${i.job}${i.client && i.client !== '—' ? ` (${i.client})` : ''}: ${i.step}, ${dueWords(i)}`;
function countsLine(c) {
  const parts = [];
  if (c.late) parts.push(`Late ${c.late}`);
  if (c.dueToday) parts.push(`Due today ${c.dueToday}`);
  parts.push(`Waiting ${c.waiting}`);
  if (c.followUpsLate) parts.push(`Follow-ups late ${c.followUpsLate}`);
  if (c.tasksLate) parts.push(`Tasks late ${c.tasksLate}`);
  if (c.jobsNoSubmission) parts.push(`Requirements with no profile sent ${c.jobsNoSubmission}`);
  return parts.join(' · ');
}

function digestContent({ tl, blocks, day, unroutedNote = null, copyOf = null }) {
  const t = totalsOf(blocks);
  const shown = blocks.filter((b) => b.counts.waiting || b.counts.followUpsLate || b.counts.jobsNoSubmission || b.counts.tasksLate);
  const title = `Pending work in your team — ${niceDay(day)}`;
  const head = copyOf ? `Copy of ${copyOf}'s digest.` : `Hi ${tl.name},`;
  const intro = t.late
    ? `${plural(shown.filter((b) => b.counts.late).length, 'recruiter has', 'recruiters have')} late work: ${t.late} late, ${t.dueToday} due today, ${t.waiting} waiting in total.`
    : `${t.waiting} waiting in total, nothing late. ${t.dueToday} due today.`;
  const lines = [head, '', intro, ''];
  shown.forEach((b) => {
    lines.push(`${b.name} — ${countsLine(b.counts)}`);
    if (b.byType.length) lines.push(`  By step: ${b.byType.map((x) => `${x.label} ${x.n}`).join(' · ')}`);
    b.items.slice(0, 5).forEach((i) => lines.push(`  • ${itemLine(i)}`));
    if (b.items.length > 5) lines.push(`  … and ${b.items.length - 5} more`);
    b.jobs.slice(0, 3).forEach((j) => lines.push(`  • Requirement with no profile sent yet: ${j.job} (${j.client}), open ${plural(j.daysOpen, 'day', 'days')}`));
    lines.push(`  Open: ${absolute(b.link)}`, '');
  });
  if (unroutedNote) lines.push(unroutedNote, '');
  lines.push(`See everyone: ${absolute('/ats/team?view=whohas')}`);
  const text = lines.join('\n');

  const rows = shown.map((b) => [
    { html: `<b>${M.esc(b.name)}</b>${b.department ? `<div style="color:#6b7280;font-size:11px">${M.esc(b.department)}</div>` : ''}` },
    { html: b.counts.late ? M.pill(b.counts.late, 'red') : '0' },
    b.counts.dueToday || '0',
    b.counts.waiting,
    b.counts.followUpsLate || '0',
  ]);
  const detail = shown.map((b) => `${M.h2(b.name)}${b.byType.length ? M.p(`By step: ${b.byType.map((x) => `${x.label} ${x.n}`).join(' · ')}`) : ''}${M.table(['Candidate and requirement', 'Where it is', 'When'], b.items.slice(0, 5).map((i) => [
    { html: `<b>${M.esc(i.candidate)}</b><div style="color:#6b7280;font-size:11px">${M.esc(i.job)}${i.client && i.client !== '—' ? ` · ${M.esc(i.client)}` : ''}</div>` },
    i.step,
    { html: M.pill(dueWords(i), i.status === 'late' ? 'red' : i.status === 'due_today' ? 'orange' : 'grey') },
  ]))}${b.items.length > 5 ? M.p(`… and ${b.items.length - 5} more.`) : ''}${M.button(absolute(b.link), `Open ${b.name}'s pending work`)}`).join('');
  const html = M.page(title, `${M.p(head)}${M.p(intro)}${M.stats([
    { label: 'Late', value: t.late, tone: t.late ? 'red' : 'green' },
    { label: 'Due today', value: t.dueToday, tone: t.dueToday ? 'orange' : 'green' },
    { label: 'Waiting', value: t.waiting, tone: 'blue' },
  ])}${M.table(['Recruiter', 'Late', 'Due today', 'Waiting', 'Follow-ups late'], rows, { right: [1, 2, 3, 4] })}${detail}${unroutedNote ? M.p(unroutedNote) : ''}${M.button(absolute('/ats/team?view=whohas'), 'See everyone')}`);
  const bell = `${t.late} late · ${t.dueToday} due today · ${t.waiting} waiting. ${shown.slice(0, 3).map((b) => `${b.name}: ${b.counts.late} late, ${b.counts.waiting} waiting`).join('; ')}${shown.length > 3 ? ` and ${shown.length - 3} more` : ''}.`;
  return { title, subject: `TeamLink — ${title}`, text, html, bell, totals: t, people: shown.length };
}

// ---------------------------------------------------------------------------
// DELIVERY — bell + e-mail, each only if its switch is on. The e-mail row is logged as a
// Notification on the Email channel (read, so it does not add to the bell count).
// ---------------------------------------------------------------------------
async function deliver({ settings, user, title, bell, text, html, attachments, openPath, key, mailer, dryRun, testMode, out }) {
  const res = { bell: false, email: null };
  if (!user) return res;
  const test = isTest(`${user.name} ${user.email}`);
  if (test && !testMode) { res.email = 'test login — nothing sent'; return res; }
  if (dryRun) return res;
  if (settings.bell) {
    await prisma.notification.create({ data: { userId: user.id, title, message: `${bell}${openPath ? `\nOpen: ${openPath}` : ''}`, channel: 'In-App', recipient: key || null, status: 'Delivered' } });
    res.bell = true;
    if (out) out.bell = (out.bell || 0) + 1;
  }
  if (settings.email) {
    if (!user.email) res.email = 'no e-mail address';
    else {
      const send = mailer || require('./mailer').sendMail; // eslint-disable-line global-require
      const r = await send({ to: user.email, subject: `TeamLink — ${title}`, text, html, attachments, useEmployeeFrom: false, fromName: 'TeamLink Reports' });
      res.email = r.ok ? 'sent' : (r.notConfigured ? 'not sent — e-mail is not set up' : `not sent — ${String(r.error || '').slice(0, 120)}`);
      await prisma.notification.create({ data: { userId: user.id, title, message: text.slice(0, 1500), channel: 'Email', recipient: user.email, status: r.ok ? 'Sent' : res.email, read: true } });
      if (out) { if (r.ok) out.emails = (out.emails || 0) + 1; else out.emailsNotSent = (out.emailsNotSent || 0) + 1; }
    }
  }
  return res;
}

async function usersById(ids) {
  const list = await prisma.user.findMany({ where: { id: { in: [...new Set(ids.filter(Boolean))] } }, select: { id: true, name: true, email: true, status: true, atsRole: true } });
  return new Map(list.map((u) => [u.id, u]));
}

// ---------------------------------------------------------------------------
// THE DAILY DIGEST
// ---------------------------------------------------------------------------
let DIGEST_RUNNING = false;
async function runDigest({ now = new Date(), viewer = null, dryRun = false, force = false, only = null, people = null, mailer = null, testMode = false } = {}) {
  const settings = await getSettings({ fresh: true });
  const day = dayOfIst(now);
  const out = { day, dryRun, sent: 0, bell: 0, emails: 0, emailsNotSent: 0, duplicates: 0, skippedEmpty: 0, copies: 0, unrouted: 0, teams: [] };
  if (!settings.enabled && !force) return { ...out, skipped: 'The pending-work reminders are switched off.' };
  const off = await offDayReason(day);
  if (off && !force) return { ...out, skipped: `${off}: no digest today.` };
  if (DIGEST_RUNNING && !dryRun) return { ...out, skipped: 'already running' };
  DIGEST_RUNNING = !dryRun;
  try {
    const vw = await pickViewer(viewer);
    if (!vw) return { ...out, skipped: 'No Super Admin login to read the company with.' };
    const c = await collectTeams({ viewer: vw, only, people });
    const tlUsers = await usersById([...c.teams.keys()]);
    const copyFor = async (tlId, dept) => {
      const { stls, managers } = await stlsAndManagers(dept);
      return [...(settings.copyStl ? stls : []), ...(settings.copyManager ? managers : [])].filter((u) => testMode || !isTest(`${u.name} ${u.email}`));
    };
    for (const [tlId, team] of c.teams.entries()) {
      const tl = tlUsers.get(tlId);
      const row = { tl: team.tl.name, recruiters: team.blocks.length, late: 0, waiting: 0, status: '' };
      out.teams.push(row);
      if (!tl) { row.status = 'no login'; continue; } // eslint-disable-line no-continue
      const totals = totalsOf(team.blocks);
      row.late = totals.late; row.waiting = totals.waiting; row.dueToday = totals.dueToday;
      if (nothingPending(team.blocks)) { row.status = 'nothing pending'; out.skippedEmpty += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (!dryRun && !force && !(await claim(day, 'digest', tlId, { people: team.blocks.length }))) { row.status = 'already sent today'; out.duplicates += 1; continue; } // eslint-disable-line no-continue
      const content = digestContent({ tl, blocks: team.blocks, day });
      row.status = dryRun ? 'would send' : 'sent';
      row.preview = dryRun ? { subject: content.subject, text: content.text } : undefined;
      // eslint-disable-next-line no-await-in-loop
      const r = await deliver({ settings, user: tl, title: content.title, bell: content.bell, text: content.text, html: content.html, openPath: '/ats/team?view=whohas', key: `pwr|digest|${day}`, mailer, dryRun, testMode, out });
      row.delivered = r;
      if (!dryRun) out.sent += 1;
      // eslint-disable-next-line no-await-in-loop
      for (const cu of await copyFor(tlId, team.tl.department)) {
        if (cu.id === tlId) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        if (!dryRun && !force && !(await claim(day, 'copy', `${tlId}>${cu.id}`))) continue; // eslint-disable-line no-continue
        const copy = digestContent({ tl: cu, blocks: team.blocks, day, copyOf: team.tl.name });
        // eslint-disable-next-line no-await-in-loop
        await deliver({ settings, user: cu, title: `Copy: ${team.tl.name}'s team — ${content.title}`, bell: copy.bell, text: copy.text, html: copy.html, openPath: '/ats/team?view=whohas', key: `pwr|digest-copy|${day}`, mailer, dryRun, testMode, out });
        if (!dryRun) out.copies += 1;
      }
    }
    // Recruiters nobody could be found for go to the department's STL, else its Managers.
    const byDept = new Map();
    c.unrouted.forEach((u) => { const k = u.department || '—'; byDept.set(k, [...(byDept.get(k) || []), u.block]); });
    for (const [dept, blocks] of byDept.entries()) {
      if (nothingPending(blocks)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const { stls, managers } = await stlsAndManagers(dept);
      const to = (stls.length ? stls : managers).filter((u) => testMode || !isTest(`${u.name} ${u.email}`));
      out.unrouted += blocks.length;
      for (const u of to) {
        // eslint-disable-next-line no-await-in-loop
        if (!dryRun && !force && !(await claim(day, 'digest', `unrouted:${dept}>${u.id}`))) continue; // eslint-disable-line no-continue
        const content = digestContent({ tl: u, blocks, day, unroutedNote: `These recruiters have no team lead set in ${dept}. Please set one (Team → Departments & teams).` });
        // eslint-disable-next-line no-await-in-loop
        await deliver({ settings, user: u, title: content.title, bell: content.bell, text: content.text, html: content.html, openPath: '/ats/team?view=whohas', key: `pwr|digest|${day}`, mailer, dryRun, testMode, out });
        if (!dryRun) out.sent += 1;
      }
    }
    if (!dryRun) await pruneSent(day).catch(() => null);
    return out;
  } finally {
    if (!dryRun) DIGEST_RUNNING = false;
  }
}

// ---------------------------------------------------------------------------
// THE ESCALATION — a recruiter's own step that is late beyond the limit tells the TL ONCE;
// beyond the second limit the department's STL / Managers once more. Grouped: one notice per
// person per run, listing the newly crossed items. The pwr.escalated row remembers
// (application + due day) per level, and forgets items that are no longer late.
// ---------------------------------------------------------------------------
let ESC_RUNNING = false;
async function runEscalation({ now = new Date(), viewer = null, dryRun = false, force = false, people = null, mailer = null, testMode = false } = {}) {
  const settings = await getSettings({ fresh: true });
  const day = dayOfIst(now);
  const out = { day, dryRun, tlNotified: 0, managersNotified: 0, itemsTl: 0, itemsManager: 0, bell: 0, emails: 0, emailsNotSent: 0, list: [] };
  if (!(settings.enabled && settings.escalation.enabled) && !force) return { ...out, skipped: 'Escalation is switched off.' };
  const off = await offDayReason(day);
  if (off && !force) return { ...out, skipped: `${off}: no escalation today.` };
  if (ESC_RUNNING && !dryRun) return { ...out, skipped: 'already running' };
  ESC_RUNNING = !dryRun;
  try {
    const vw = await pickViewer(viewer);
    if (!vw) return { ...out, skipped: 'No Super Admin login to read the company with.' };
    const c = await collectTeams({ viewer: vw, people });
    const reg = await locked(async () => {
      const row = await prisma.appSetting.findUnique({ where: { key: ESC_KEY } }).catch(() => null);
      try { return row && row.value ? JSON.parse(row.value) : {}; } catch { return {}; }
    });
    const stillLate = new Set();
    const tlCross = new Map(); // tlId -> items
    const mgrCross = new Map(); // `${dept}` -> items
    const addTo = (m, k, v) => { m.set(k, [...(m.get(k) || []), v]); };
    const consider = (b, tlId, dept) => {
      b.items.filter((i) => i.status === 'late' && isOwnStep(i, b.userId)).forEach((i) => {
        const k = `${i.applicationId}|${i.dueAt}`;
        stillLate.add(k);
        const seen = reg[k] || {};
        const item = { ...i, who: b.name, userId: b.userId };
        if (i.daysLate > settings.escalation.afterDays && !seen.tl && tlId) addTo(tlCross, tlId, { ...item, key: k });
        if (i.daysLate > settings.escalation.managerAfterDays && !seen.mgr) addTo(mgrCross, dept || '—', { ...item, key: k, tlId });
      });
    };
    c.teams.forEach((team, tlId) => team.blocks.forEach((b) => consider(b, tlId, team.tl.department)));
    c.unrouted.forEach((u) => consider(u.block, null, u.department));
    const users = await usersById([...tlCross.keys()]);
    const notify = async (user, title, list, kindWord) => {
      list.sort((a, b) => b.daysLate - a.daysLate);
      const lines = list.slice(0, 8).map((i) => `• ${i.who}: ${i.candidate} — ${i.job}: ${i.step}, ${plural(i.daysLate, 'day', 'days')} late`);
      const text = [`${kindWord}`, '', ...lines, ...(list.length > 8 ? [`… and ${list.length - 8} more`] : []), '', `Open: ${absolute('/ats/team?view=whohas')}`].join('\n');
      const html = M.page(title, `${M.p(kindWord)}${M.table(['Recruiter', 'Candidate and requirement', 'Late'], list.slice(0, 15).map((i) => [i.who, { html: `<b>${M.esc(i.candidate)}</b><div style="color:#6b7280;font-size:11px">${M.esc(i.job)} · ${M.esc(i.step)}</div>` }, { html: M.pill(plural(i.daysLate, 'day', 'days'), 'red') }]))}${M.button(absolute('/ats/team?view=whohas'), 'Open pending work')}`);
      return deliver({ settings, user, title, bell: `${kindWord} ${lines.slice(0, 3).join(' ')}`, text, html, openPath: '/ats/team?view=whohas', key: `pwr|esc|${day}`, mailer, dryRun, testMode, out });
    };
    const marks = [];
    for (const [tlId, list] of tlCross.entries()) {
      const tl = users.get(tlId);
      out.list.push({ level: 'tl', to: tl ? tl.name : tlId, items: list.length });
      out.itemsTl += list.length;
      if (!tl) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await notify(tl, `${plural(list.length, 'task is', 'tasks are')} more than ${settings.escalation.afterDays} days late in your team`, list, `${plural(list.length, 'step is', 'steps are')} more than ${settings.escalation.afterDays} days late:`);
      out.tlNotified += 1;
      list.forEach((i) => marks.push([i.key, 'tl']));
    }
    for (const [dept, list] of mgrCross.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const { stls, managers } = await stlsAndManagers(dept);
      const to = [...(settings.copyStl ? stls : []), ...(settings.copyManager ? managers : [])].filter((u) => testMode || !isTest(`${u.name} ${u.email}`));
      out.itemsManager += list.length;
      out.list.push({ level: 'manager', department: dept, to: to.map((u) => u.name), items: list.length });
      for (const u of to) {
        // eslint-disable-next-line no-await-in-loop
        await notify(u, `${plural(list.length, 'task is', 'tasks are')} more than ${settings.escalation.managerAfterDays} days late in ${dept}`, list, `${plural(list.length, 'step is', 'steps are')} more than ${settings.escalation.managerAfterDays} days late in ${dept}:`);
        out.managersNotified += 1;
      }
      list.forEach((i) => marks.push([i.key, 'mgr']));
    }
    if (!dryRun) {
      await locked(async () => {
        const next = {};
        Object.entries(reg).forEach(([k, v]) => { if (stillLate.has(k)) next[k] = v; });
        marks.forEach(([k, lvl]) => { next[k] = { ...(next[k] || {}), [lvl]: new Date().toISOString() }; });
        const value = JSON.stringify(next);
        await prisma.appSetting.upsert({ where: { key: ESC_KEY }, update: { value }, create: { key: ESC_KEY, value } });
      });
    }
    return out;
  } finally {
    if (!dryRun) ESC_RUNNING = false;
  }
}

// ---------------------------------------------------------------------------
// "REMIND THE RECRUITER" — one polite nudge. The caller is a TL (own team), an STL (own
// departments) or Admin; a Manager only views. Once per recruiter per item per day.
// ---------------------------------------------------------------------------
async function remind(user, { recruiterId, applicationId = null, note = null }, { now = new Date(), mailer = null } = {}) {
  const { atsViewRole } = require('./scope'); // eslint-disable-line global-require
  const TW = require('./teamWorkload'); // eslint-disable-line global-require
  const AH = require('./atsHome'); // eslint-disable-line global-require
  const view = atsViewRole(user);
  if (!['admin', 'tl', 'stl'].includes(view)) {
    return { status: 403, body: { error: view === 'mgmt' ? 'Managers look at the pending work. Ask the team lead to send the reminder.' : 'Only a team lead, STL or admin can remind a recruiter.' } };
  }
  const settings = await getSettings();
  const world = await TW.teamWorld(user);
  const person = world.peopleById.get(String(recruiterId || ''));
  if (!person || !['RECRUITER', 'BDE'].includes(person.roleGroup)) return { status: 403, body: { error: 'This person is not in your team.' } };
  if (person.roleGroup === 'BDE') return remindBde(user, person, { applicationId, note }, { now, mailer, settings });
  const load = await AH.pendingLoad(user, { by: 'recruiter' });
  const today = load.today;
  const group = load.people.find((e) => e.userId === person.id);
  let items = group ? group.pending.map((x) => itemOf(x, today)) : [];
  if (applicationId) {
    items = items.filter((i) => i.applicationId === applicationId);
    if (!items.length) return { status: 404, body: { error: 'That item is not waiting on this person any more.' } };
  } else {
    items = items.filter((i) => isOwnStep(i, person.id) || person.roleGroup === 'BDE');
    if (!items.length) {
      const others = group ? group.pending.length : 0;
      return { status: 409, body: { error: others ? `Nothing is waiting on ${person.name} themselves: ${others} step${others === 1 ? ' is' : 's are'} waiting for the team lead, the BDE or the client.` : `${person.name} has no pending work.` } };
    }
  }
  items.sort(byUrgency);
  const day = dayOfIst(now);
  const itemKey = applicationId || 'all';
  const k = `${person.id}|${itemKey}`;
  const got = await claim(day, 'nudge', k, { by: user.id, byName: user.name });
  if (!got) {
    const was = await peek(day, 'nudge', k);
    const at = was && was.at ? hhmmOfIst(new Date(was.at)) : '';
    return { status: 429, body: { error: `${person.name} was already reminded about ${applicationId ? 'this' : 'their pending work'} today${at ? ` at ${at}` : ''}${was && was.byName ? ` by ${was.byName}` : ''}. One reminder a day is enough.` , alreadyAt: was && was.at } };
  }
  const target = await prisma.user.findUnique({ where: { id: person.id }, select: { id: true, name: true, email: true, employee: { select: { phone: true } } } });
  const late = items.filter((i) => i.status === 'late').length;
  const top = items.slice(0, 5);
  const lines = top.map((i) => `• ${i.candidate} — ${i.job}: ${i.step}, ${dueWords(i)}`);
  const lead = applicationId
    ? `${user.name} asks you to look at this today:`
    : `${user.name} asks you to look at your pending work${late ? ` (${late} late)` : ''}:`;
  const text = [lead, ...lines, ...(items.length > 5 ? [`… and ${items.length - 5} more`] : []), ...(note ? ['', `Note: ${String(note).slice(0, 300)}`] : []), '', `Open: ${applicationId ? `/candidates` : '/ats/dashboard'}`].join('\n');
  const result = { bell: false, email: null, whatsapp: null, sms: null };
  await prisma.notification.create({ data: { userId: person.id, title: applicationId ? 'A reminder from your team lead' : `Reminder: ${plural(items.length, 'item is', 'items are')} waiting for you`, message: text, channel: 'In-App', recipient: `pwr|nudge|${day}|${k}`, status: 'Delivered' } });
  result.bell = true;
  const MS = require('./messaging'); // eslint-disable-line global-require
  const status = await MS.channelStatus().catch(() => ({}));
  const test = isTest(`${target.name} ${target.email}`);
  const short = `${lead} ${top.slice(0, 3).map((i) => `${i.candidate} (${i.step})`).join(', ')}.`.slice(0, 300);
  if (settings.nudge.email && target.email && status.Email && status.Email.configured && !test) {
    const send = mailer || require('./mailer').sendMail; // eslint-disable-line global-require
    const r = await send({ to: target.email, subject: 'TeamLink — a reminder from your team lead', text, useEmployeeFrom: false, fromName: 'TeamLink Reports' });
    result.email = r.ok ? 'sent' : `not sent — ${String(r.error || '').slice(0, 100)}`;
  } else result.email = settings.nudge.email ? 'not connected' : 'off';
  const phone = target.employee && target.employee.phone;
  for (const [ch, key] of [['WhatsApp', 'whatsapp'], ['SMS', 'sms']]) {
    if (!settings.nudge[key]) { result[key] = 'off'; continue; } // eslint-disable-line no-continue
    if (!(status[ch] && status[ch].configured)) { result[key] = 'not connected'; continue; } // eslint-disable-line no-continue
    if (!phone) { result[key] = 'no phone on the profile'; continue; } // eslint-disable-line no-continue
    if (test) { result[key] = 'test login — nothing sent'; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const r = await MS.send(ch, { to: phone, kind: 'staff', text: short });
    result[key] = r.ok ? 'sent' : `not sent — ${String(r.error || r.outcome || '').slice(0, 100)}`;
  }
  await logAudit({
    userId: user.id, actorName: user.name, action: 'Reminder sent to recruiter', entity: 'User', entityId: person.id,
    toValue: `${person.name}: ${applicationId ? `1 item (${items[0].candidate})` : plural(items.length, 'item', 'items')}`, reason: note ? String(note).slice(0, 300) : undefined,
  }).catch(() => null);
  return { status: 200, body: { ok: true, name: person.name, items: items.length, late, channels: result, message: `Reminder sent to ${person.name}.` } };
}

// A BDE's reminder is about the CLIENT WORK waiting on them (utils/clientWork.js), once per BDE per day.
async function remindBde(user, person, { note }, { now = new Date(), settings }) {
  const CW = require('./clientWork'); // eslint-disable-line global-require
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const id = await resolveIdentity(person.id);
  const p = await CW.bdePending(id, { settings });
  if (!p.total) return { status: 409, body: { error: `${person.name} has no client work waiting.` } };
  const day = dayOfIst(now);
  const k = `${person.id}|all`;
  if (!(await claim(day, 'nudge', k, { by: user.id, byName: user.name }))) {
    const was = await peek(day, 'nudge', k);
    return { status: 429, body: { error: `${person.name} was already reminded today${was && was.at ? ` at ${hhmmOfIst(new Date(was.at))}` : ''}${was && was.byName ? ` by ${was.byName}` : ''}. One reminder a day is enough.`, alreadyAt: was && was.at } };
  }
  const lines = CW.topLines(p, 2).map((l) => `• ${l}`);
  const text = [`${user.name} asks you to look at the client work waiting for you:`, ...lines, ...(note ? ['', `Note: ${String(note).slice(0, 300)}`] : []), '', 'Open: /ats/dashboard'].join('\n');
  await prisma.notification.create({ data: { userId: person.id, title: `Reminder: ${plural(p.total, 'client item is', 'client items are')} waiting for you`, message: text, channel: 'In-App', recipient: `pwr|nudge|${day}|${k}`, status: 'Delivered' } });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Reminder sent to recruiter', entity: 'User', entityId: person.id, toValue: `${person.name}: ${plural(p.total, 'client item', 'client items')}`, reason: note ? String(note).slice(0, 300) : undefined }).catch(() => null);
  return { status: 200, body: { ok: true, name: person.name, items: p.total, late: 0, channels: { bell: true, email: 'off', whatsapp: 'off', sms: 'off' }, message: `Reminder sent to ${person.name}.` } };
}

// ---------------------------------------------------------------------------
// THE PENDING-WORK TAB (Team → Pending work): the viewer's own screen, filters with counts.
// ---------------------------------------------------------------------------
async function teamView(user, q = {}) {
  const { atsViewRole } = require('./scope'); // eslint-disable-line global-require
  const TW = require('./teamWorkload'); // eslint-disable-line global-require
  const AH = require('./atsHome'); // eslint-disable-line global-require
  const view = atsViewRole(user);
  if (!['admin', 'mgmt', 'stl', 'tl'].includes(view)) return { status: 403, body: { error: 'This table is for team leads, managers and admins.' } };
  const bdeTl = require('./scope').isBdeTl(user); // eslint-disable-line global-require
  if (bdeTl) return require('./clientWork').teamView(user, q); // eslint-disable-line global-require
  const [world, load] = await Promise.all([TW.teamWorld(user), AH.pendingLoad(user, { fresh: q.fresh === '1' })]);
  const today = load.today;
  const testViewer = isTest(`${user.name || ''} ${user.email || ''}`);
  const people = world.people.filter((p) => p.roleGroup === 'RECRUITER' && p.status === 'Active' && (testViewer || !isTest(p.name)));
  const ids = people.map((p) => p.id);
  const extras = { fu: await followUpCounts(ids, today), tasks: await taskCounts(ids, today), jobs: jobsWithoutProfile(load.world, today) };
  const by = new Map(load.people.filter((e) => e.userId).map((e) => [e.userId, e]));
  const day = dayOfIst(new Date());
  const sent = await readSent(day);
  const blocks = people.map((p) => ({
    ...blockOf(p, by.get(p.id), load, extras, today, { notMoving: load.notMoving.get(`u:${p.id}`) || 0 }),
    tl: p.tl || null,
    reminded: sent.nudge[`${p.id}|all`] ? { at: sent.nudge[`${p.id}|all`].at, by: sent.nudge[`${p.id}|all`].byName } : null,
  }));
  // Filters (cascading): department · recruiter · type · lateness; each option counted over the items the OTHER filters keep.
  const f = { department: String(q.department || ''), recruiter: String(q.recruiter || ''), type: String(q.type || ''), lateness: String(q.lateness || '') };
  const itemOk = (b, i, skip) => (skip === 'type' || !f.type || i.type === f.type) && (skip === 'lateness' || !f.lateness || i.status === f.lateness);
  const blockOk = (b, skip) => (skip === 'department' || !f.department || b.department === f.department) && (skip === 'recruiter' || !f.recruiter || b.userId === f.recruiter);
  const facet = (skip, keyOf, labelOf) => {
    const m = new Map();
    blocks.forEach((b) => {
      if (!blockOk(b, skip)) return;
      b.items.forEach((i) => {
        if (!itemOk(b, i, skip)) return;
        const k = keyOf(b, i);
        if (!k) return;
        const e = m.get(k) || { value: k, label: labelOf(b, i), count: 0 };
        e.count += 1;
        m.set(k, e);
      });
    });
    return [...m.values()].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
  };
  const facets = {
    department: facet('department', (b) => b.department, (b) => b.department),
    recruiter: facet('recruiter', (b) => b.userId, (b) => b.name),
    type: facet('type', (b, i) => i.type, (b, i) => i.typeLabel),
    lateness: facet('lateness', (b, i) => i.status, (b, i) => (LATENESS.find((l) => l.id === i.status) || {}).label),
  };
  const anyItemFilter = !!(f.type || f.lateness);
  const rows = blocks.filter((b) => blockOk(b)).map((b) => {
    if (!anyItemFilter) return b;
    const items = b.items.filter((i) => itemOk(b, i));
    const counts = { ...b.counts, waiting: items.length, late: items.filter((i) => i.status === 'late').length, dueToday: items.filter((i) => i.status === 'due_today').length };
    return { ...b, items, counts };
  }).filter((b) => !anyItemFilter || b.items.length);
  const canRemind = ['admin', 'tl', 'stl'].includes(view);
  const t = totalsOf(rows);
  return {
    status: 200,
    body: {
      today,
      canRemind,
      audience: 'recruiter',
      filters: f,
      facets,
      types: TYPES.map((x) => ({ id: x.id, label: x.label, who: x.who })),
      totals: t,
      rows: rows.map((b) => ({ ...b, items: b.items.slice(0, 25), moreItems: Math.max(0, b.items.length - 25) })),
      note: 'Waiting = the next steps of this person\'s candidates that are not "Not moving". Late and Due today are part of Waiting. The numbers are the same as the Team snapshot on the dashboard.',
    },
  };
}

// ---------------------------------------------------------------------------
// WHAT THE ADMIN SEES BEFORE SWITCHING ON: today's digest for one team lead, written, not sent.
// ---------------------------------------------------------------------------
async function previewFor(tlId, { viewer = null } = {}) {
  const vw = await pickViewer(viewer);
  if (!vw) return { error: 'No Super Admin login to read the company with.' };
  const c = await collectTeams({ viewer: vw, only: tlId });
  const team = c.teams.get(tlId);
  if (!team) return { error: 'That team lead has no recruiters.' };
  const tl = (await usersById([tlId])).get(tlId) || { id: tlId, name: team.tl.name };
  const content = digestContent({ tl, blocks: team.blocks, day: dayOfIst(new Date()) });
  return { subject: content.subject, text: content.text, html: content.html, totals: content.totals, empty: nothingPending(team.blocks) };
}

// The team leads that would get a digest (for the settings screen).
async function recipients({ viewer = null } = {}) {
  const vw = await pickViewer(viewer);
  if (!vw) return [];
  const dir = await directory(vw);
  const m = new Map();
  dir.resolved.forEach((r) => { if (r.tlId) m.set(r.tlId, (m.get(r.tlId) || 0) + 1); });
  return [...m.entries()].map(([id, n]) => ({ id, name: dir.tlById.get(id).name, department: dir.tlById.get(id).department, recruiters: n }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// THE SWEEP — every few minutes: the digest (at its time), the escalation, the BDE digest, the
// end-of-day report (at its time). Each is idempotent for the day, so a restart or two
// overlapping ticks never send twice.
// ---------------------------------------------------------------------------
let LAST_ESC = 0;
async function tick({ now = new Date(), viewer = null, mailer = null, testMode = false } = {}) {
  const settings = await getSettings({ fresh: true });
  const res = {};
  if (!settings.enabled) return { skipped: 'off' };
  const hhmm = hhmmOfIst(now);
  const day = dayOfIst(now);
  // Pending approvals and overdue follow-ups tell the chain above at every tick (not at a set time).
  if (settings.chain.enabled) {
    try { res.chain = await require('./chainAlerts').run({ now, viewer, mailer, testMode, quiet: true }); } catch (e) { res.chain = { error: e.message }; } // eslint-disable-line global-require
  }
  if (hhmm >= settings.digestTime) {
    const dig = await peek(day, 'digest', '__run');
    if (!dig) {
      res.digest = await runDigest({ now, viewer, mailer, testMode });
      if (!res.digest.skipped) await claim(day, 'digest', '__run');
      else if (/Sunday|Holiday/.test(res.digest.skipped)) await claim(day, 'digest', '__run', { skipped: res.digest.skipped });
      if (settings.bde.enabled) {
        try { res.bde = await require('./clientWork').runBdeDigest({ now, viewer, mailer, testMode }); } catch (e) { res.bde = { error: e.message }; } // eslint-disable-line global-require
      }
    }
    // The escalation reads the whole company: at most every 15 minutes (tests pass now explicitly).
    if (testMode || !LAST_ESC || Date.now() - LAST_ESC > 14 * 60000) {
      LAST_ESC = Date.now();
      res.escalation = await runEscalation({ now, viewer, mailer, testMode });
    }
  }
  if (settings.eod.enabled && hhmm >= settings.eod.time) {
    try { res.eod = await require('./eodReport').runAll({ now, viewer, mailer, testMode }); } catch (e) { res.eod = { error: e.message }; } // eslint-disable-line global-require
  }
  return res;
}

let TIMER = null;
let TICKING = false;
function startSweep() {
  const ms = Number(process.env.PENDING_WORK_SWEEP_MS || 5 * 60000);
  if (!ms || TIMER) return;
  TIMER = setInterval(async () => {
    if (TICKING) return;
    TICKING = true;
    try {
      const r = await tick();
      if (r && (r.digest || r.eod || r.bde || r.escalation) && process.env.PENDING_WORK_LOG !== '0') {
        console.log(`[pending-work] ${JSON.stringify({ digest: r.digest && { sent: r.digest.sent, dup: r.digest.duplicates, skipped: r.digest.skipped }, esc: r.escalation && { tl: r.escalation.tlNotified }, bde: r.bde && { sent: r.bde.sent }, eod: r.eod && { sent: r.eod.sent } })}`); // eslint-disable-line no-console
      }
    } catch (err) { console.error('[pending-work]', err.message); } finally { TICKING = false; } // eslint-disable-line no-console
  }, ms);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  SETTINGS_KEY, DEFAULTS, TYPES, LATENESS, TEST_RE,
  getSettings, saveSettings, normalise,
  dayOfIst, hhmmOfIst, niceDay, offDayReason, daysBetween,
  claim, peek, readSent, locked, pruneSent, SENT_PREFIX,
  itemOf, byUrgency, isOwnStep, blockOf, totalsOf, emptyCounts, countsLine, dueWords, plural, typeOfStage,
  viewerFor, pickViewer, directory, collectTeams, followUpCounts, taskCounts, jobsWithoutProfile, stlsAndManagers, usersById,
  digestContent, deliver, absolute,
  runDigest, runEscalation, remind, teamView, previewFor, recipients, tick, startSweep,
};
