// ---------------------------------------------------------------------------
// ATS INSIGHTS — the shared pieces of the "market wave" dashboard + reports work (2026-11-21).
//
//   access(user)     who may open what: the ATS Reports matrix (view / export), a recruiter's own-only rule
//                    (utils/ownOnly.js), Manager / Assistant Manager view only, the BDE team, money (reportsPlus.mayRevenue)
//   ctxFor(user, q)  the SAME scoped rows every ATS report is counted from (routes/atsReports.js packContext): a number
//                    here can never disagree with the report it sits beside, and nobody sees outside their scope
//   switches         the Admin switches of the automatic parts (metric alerts, scheduled mails, quality-of-hire surveys),
//                    all OFF until an Admin turns them on (AppSetting "insights.switches")
//   ensure()         the raw tables, created on first use (no migration)
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const { can } = require('../../middleware/auth');
const { atsScopeOf } = require('../scope');
const OWN = require('../ownOnly');

const DAY = 86400000;
const IST = 330 * 60000;
const istDay = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isNaN(t) ? null : new Date(t + IST).toISOString().slice(0, 10);
};
const isoDay = (s) => { const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(s || '')); return m && +m[1] >= 2015 && +m[1] <= 2100 ? String(s).slice(0, 10) : null; };
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const today = () => istDay(new Date());
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const median = (vals) => {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};
const average = (vals) => (vals.length ? Math.round((vals.reduce((n, v) => n + v, 0) / vals.length) * 10) / 10 : null);
const MAX_FILL_DAYS = 730;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => `${MONTHS[Number(String(ym).slice(5, 7)) - 1] || ''} ${String(ym).slice(0, 4)}`.trim();

const rolesOf = (u) => [u && u.role, u && u.atsRole, u && u.hrmsRole, u && u.accountsRole].filter(Boolean);
const VIEW_ONLY = ['MANAGER', 'ASSISTANT_MANAGER'];
function isBdeTeam(user) {
  try { const fl = require('../clientRedact').privacyFlagsFor(user); return !!(fl && fl.bde); } catch { return false; } // eslint-disable-line global-require
}
function mayRevenue(user) {
  try { return require('../reportsPlus').mayRevenue(user); } catch { return false; } // eslint-disable-line global-require
}

// What this login may do here. ok = may open the insights at all.
async function access(user) {
  const s = atsScopeOf(user);
  const role = s.atsRole || (user && user.role);
  const [view, exp] = await Promise.all([
    can(user, null, 'reports', 'ATS Reports', 'view'),
    can(user, null, 'reports', 'ATS Reports', 'export'),
  ]);
  const ownOnly = OWN.isOwnOnly(user);
  const client = role === 'CLIENT' || !!(user && user.clientId && !s.global);
  const admin = !!s.adminGlobal && !(user && user.viewAs);
  const viewOnly = !admin && rolesOf(user).some((r) => VIEW_ONLY.includes(r));
  const bde = isBdeTeam(user);
  const hr = role === 'HR' && !s.global;
  return {
    ok: !client && (view || ownOnly),
    view: !!view && !ownOnly,
    export: !!exp && !ownOnly && !client,
    ownOnly,
    admin,
    viewOnly,
    bde,
    hr,
    money: !client && mayRevenue(user),
    lead: admin || ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER', 'HR'].includes(role) || !!s.global,
    role,
  };
}

// The scoped rows (see the header). query: the report filters (department, clientId, range …).
async function ctxFor(user, query = {}, fresh = false) {
  const R = require('../../routes/atsReports'); // eslint-disable-line global-require
  const q = { ...query };
  if (OWN.isOwnOnly(user)) OWN.ownQuery(user, q);
  return R.packContext(user, q, 'createdAt', fresh);
}

// The day a joined application joined: the typed joining date, else when it was marked joined.
function joinDayOf(x) {
  if (!x.joined) return null;
  const d = isoDay(x.a.joiningDate) || istDay(x.a.joinedAt);
  if (d) return d;
  if (x.crossedAt && x.crossedAt.joined) return istDay(x.crossedAt.joined);
  const ev = [...(x.evs || [])].reverse().find((e) => ['JOINED', 'HIRED'].includes(e.toStage));
  return ev ? istDay(ev.createdAt) : null;
}

async function namesOf(candidateIds) {
  const ids = [...new Set((candidateIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidate.findMany({ where: { id: { in: ids.slice(i, i + 500) } }, select: { id: true, name: true } });
    rows.forEach((r) => out.set(r.id, r.name || '—'));
  }
  return out;
}

// --- The Admin switches (all OFF by default) ---------------------------------------------------
const SWITCH_KEY = 'insights.switches';
const SWITCHES = {
  alerts: 'Metric alerts: check every hour and put a note in the bell when a number crosses a person\'s limit',
  schedules: 'Scheduled e-mails: send the dashboards and saved reports people scheduled',
  qoh: 'Quality-of-hire surveys: e-mail the client a rating link 30, 60 and 90 days after a person joins',
};
async function switches() {
  const r = await prisma.appSetting.findUnique({ where: { key: SWITCH_KEY } }).catch(() => null);
  let v = {};
  try { v = r ? JSON.parse(r.value) : {}; } catch { v = {}; }
  return Object.fromEntries(Object.keys(SWITCHES).map((k) => [k, v[k] === true]));
}
async function setSwitches(user, patch = {}) {
  const cur = await switches();
  const next = { ...cur };
  Object.keys(SWITCHES).forEach((k) => { if (typeof patch[k] === 'boolean') next[k] = patch[k]; });
  await prisma.appSetting.upsert({
    where: { key: SWITCH_KEY },
    create: { key: SWITCH_KEY, value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name },
    update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name },
  });
  const { logAudit } = require('../audit'); // eslint-disable-line global-require
  const changed = Object.keys(SWITCHES).filter((k) => cur[k] !== next[k]);
  if (changed.length) {
    await logAudit({
      userId: user.id, actorName: user.name, action: 'ATS insights switches changed', entity: 'AppSetting', entityId: SWITCH_KEY,
      fromValue: changed.map((k) => `${k}: ${cur[k] ? 'on' : 'off'}`).join(', '), toValue: changed.map((k) => `${k}: ${next[k] ? 'on' : 'off'}`).join(', '),
    });
  }
  return next;
}

// --- The tables ---------------------------------------------------------------------------------
const DDL = [
  `CREATE TABLE IF NOT EXISTS "AtsSavedReport" ("id" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "ownerName" TEXT, "name" TEXT NOT NULL,
    "spec" TEXT NOT NULL, "shared" TEXT NOT NULL DEFAULT 'private', "teamKey" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "AtsSavedReport_owner" ON "AtsSavedReport" ("ownerId")',
  `CREATE TABLE IF NOT EXISTS "AtsDashPin" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "reportId" TEXT NOT NULL, "forTeam" INTEGER NOT NULL DEFAULT 0,
    "teamKey" TEXT, "position" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "AtsDashPin_user" ON "AtsDashPin" ("userId")',
  `CREATE TABLE IF NOT EXISTS "AtsMetricAlert" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "userName" TEXT, "metric" TEXT NOT NULL, "direction" TEXT NOT NULL,
    "threshold" REAL NOT NULL, "days" INTEGER, "active" INTEGER NOT NULL DEFAULT 1, "lastValue" REAL, "lastCheckedAt" TEXT, "firing" INTEGER NOT NULL DEFAULT 0,
    "lastFiredAt" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "AtsMetricAlert_user" ON "AtsMetricAlert" ("userId")',
  `CREATE TABLE IF NOT EXISTS "AtsReportSchedule" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "userName" TEXT, "kind" TEXT NOT NULL, "reportId" TEXT,
    "frequency" TEXT NOT NULL, "weekday" INTEGER, "monthDay" INTEGER, "hour" INTEGER NOT NULL DEFAULT 9, "recipientIds" TEXT NOT NULL, "active" INTEGER NOT NULL DEFAULT 1,
    "lastSentAt" TEXT, "lastStatus" TEXT, "nextDueAt" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "AtsReportSchedule_user" ON "AtsReportSchedule" ("userId")',
  `CREATE TABLE IF NOT EXISTS "AtsBackdoorFlag" ("id" TEXT PRIMARY KEY, "applicationId" TEXT, "candidateId" TEXT NOT NULL, "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL, "source" TEXT NOT NULL, "note" TEXT, "evidence" TEXT, "markedById" TEXT, "markedByName" TEXT, "createdAt" TEXT NOT NULL,
    "decidedById" TEXT, "decidedByName" TEXT, "decidedAt" TEXT)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "AtsBackdoorFlag_pair" ON "AtsBackdoorFlag" ("candidateId","clientId")',
  `CREATE TABLE IF NOT EXISTS "AtsQohSurvey" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "candidateId" TEXT, "requirementId" TEXT, "clientId" TEXT,
    "day" INTEGER NOT NULL, "dueOn" TEXT, "sentTo" TEXT, "sentAt" TEXT, "sendStatus" TEXT, "answeredAt" TEXT, "rating" INTEGER, "rehire" TEXT, "skills" INTEGER,
    "attendance" INTEGER, "comment" TEXT, "answeredBy" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "AtsQohSurvey_app_day" ON "AtsQohSurvey" ("applicationId","day")',
  `CREATE TABLE IF NOT EXISTS "AtsBiKey" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL, "keyHash" TEXT NOT NULL, "keyTail" TEXT, "feeds" TEXT,
    "createdById" TEXT, "createdByName" TEXT, "createdAt" TEXT NOT NULL, "revokedAt" TEXT, "revokedByName" TEXT, "lastUsedAt" TEXT, "uses" INTEGER NOT NULL DEFAULT 0)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "AtsBiKey_hash" ON "AtsBiKey" ("keyHash")',
];
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      for (const sql of DDL) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const newId = (p) => `${p}${Date.now().toString(36)}${require('crypto').randomBytes(5).toString('hex')}`; // eslint-disable-line global-require
const num = (v) => (v === null || v === undefined ? v : Number(v));

// The "team" a saved report is shared with / a team pin belongs to: the ATS department, else the HR team.
function teamKeyOf(user) {
  const s = atsScopeOf(user);
  return (user && (user.atsDepartment || user.team)) || (s.departments && s.departments[0]) || null;
}

// An ACTIVE login as the permission / scope code reads it (null for a login that is gone or switched off).
async function identityOf(userId) {
  const row = await prisma.user.findUnique({ where: { id: String(userId || '') }, select: { id: true, status: true } }).catch(() => null);
  if (!row || row.status !== 'Active') return null;
  return require('../identity').resolveIdentity(row.id).catch(() => null); // eslint-disable-line global-require
}

module.exports = {
  identityOf, DAY, istDay, isoDay, dayDiff, today, addDays, median, average, MAX_FILL_DAYS, monthLabel,
  access, ctxFor, joinDayOf, namesOf, switches, setSwitches, SWITCHES, ensure, newId, num, teamKeyOf, isBdeTeam, mayRevenue,
};
