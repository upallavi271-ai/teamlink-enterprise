// ---------------------------------------------------------------------------
// ATS DUE DATES & ALERTS — the Admin settings (spec 2026-10-03 §4 / §14).
//
//   dueDays          default days per STEP (Recruiter check 2, Team lead
//                    check 1, Client feedback 5 …). utils/nextAction.js reads
//                    them for every due date that comes from a step (an open
//                    follow-up's own date always wins).
//   startedOn        THE CLOCK START. Something that entered its step before
//                    this day (or whose entry day is only estimated — the
//                    imported backlog) is timed FROM this day, so switching
//                    the defaults on never turns thousands of old items Late
//                    at once. Old items with no activity for staleAfterDays
//                    go to the Stale bucket instead (Admin review / bulk close).
//   staleAfterDays   30 by default.
//   escalation       the 15-minute job (utils/atsEscalation.js): due date
//                    passed → owner, +tlAfterDays → TL, +managerAfterDays →
//                    Manager. OFF by default and IN-APP ONLY until the user
//                    approves decision #6 (email / WhatsApp / SMS are not
//                    offered here).
//   bellExpireDays   messages older than this stop counting in the bell.
//
// Kept in the existing Integration table as an internal row (the pattern of
// utils/portalSettings.js) — no schema change, no credentials here.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const STORE_ID = 'ats-alerts';
// The day the default due dates were introduced (dashboard review 2026-10-03).
const FIRST_START = '2026-10-03';

// The steps in plain words, in workflow order, and the stages each covers.
// `anchor`: the due date is that date of the application + days (the
// interview day / the joining day); without it, days after the step began.
// One row per STEP as the whole app words it (utils/atsHome.js STEP_WORDS,
// utils/followupVisibility.js STEP_WORD) — the Admin "Step timing" screen.
const STEP_GROUPS = [
  { id: 'new', label: 'New', stages: ['NEW'], days: 2 },
  { id: 'ai', label: 'AI interview', stages: ['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED'], days: 2 },
  { id: 'recruiter', label: 'Waiting for recruiter review', stages: ['AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'], days: 2 },
  { id: 'tl', label: 'Waiting for team lead review', stages: ['TL_REVIEW'], days: 1 },
  { id: 'bde', label: 'Check by client manager (BDE)', stages: ['WITH_BDE', 'BDE_APPROVED'], days: 1 },
  { id: 'client', label: 'Sent to client (client feedback)', stages: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'], days: 5 },
  { id: 'schedule', label: 'Client shortlisted (fix the interview)', stages: ['CLIENT_SHORTLISTED'], days: 2 },
  { id: 'interview', label: 'Interview fixed', stages: ['INTERVIEW_SCHEDULED'], days: 0, anchor: 'interviewAt', hint: 'days after the interview date' },
  { id: 'feedback', label: 'Interview done (feedback)', stages: ['INTERVIEW_COMPLETED'], days: 2 },
  { id: 'selected', label: 'Selected', stages: ['SELECTED'], days: 3 },
  { id: 'offer', label: 'Offer', stages: ['OFFER'], days: 3 },
  { id: 'join', label: 'Waiting to join', stages: ['OFFER_ACCEPTED'], days: 1, anchor: 'joiningDate', hint: 'days after the joining date' },
  { id: 'hold', label: 'On hold — look again', stages: ['HOLD'], days: 5 },
];
const GROUP_OF_STAGE = Object.fromEntries(STEP_GROUPS.flatMap((g) => g.stages.map((s) => [s, g])));

const DEFAULTS = {
  dueDays: Object.fromEntries(STEP_GROUPS.map((g) => [g.id, g.days])),
  startedOn: FIRST_START,
  staleAfterDays: 30,
  escalation: { enabled: false, tlAfterDays: 1, managerAfterDays: 2 },
  bellExpireDays: 14,
};

const intIn = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function normalise(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const dueDays = { ...DEFAULTS.dueDays };
  Object.keys(dueDays).forEach((k) => {
    const n = v.dueDays ? intIn(v.dueDays[k], 0, 60) : null;
    if (n !== null) dueDays[k] = n;
  });
  const esc = v.escalation && typeof v.escalation === 'object' ? v.escalation : {};
  const tl = intIn(esc.tlAfterDays, 0, 30);
  const mgr = intIn(esc.managerAfterDays, 0, 60);
  return {
    dueDays,
    startedOn: typeof v.startedOn === 'string' && ISO.test(v.startedOn) ? v.startedOn : DEFAULTS.startedOn,
    staleAfterDays: intIn(v.staleAfterDays, 7, 365) ?? DEFAULTS.staleAfterDays,
    escalation: {
      enabled: esc.enabled === true,
      tlAfterDays: tl ?? DEFAULTS.escalation.tlAfterDays,
      managerAfterDays: Math.max(mgr ?? DEFAULTS.escalation.managerAfterDays, tl ?? DEFAULTS.escalation.tlAfterDays),
      lastRunAt: typeof esc.lastRunAt === 'string' ? esc.lastRunAt : null,
      lastRun: esc.lastRun && typeof esc.lastRun === 'object' ? esc.lastRun : null,
    },
    bellExpireDays: intIn(v.bellExpireDays, 1, 90) ?? DEFAULTS.bellExpireDays,
  };
}

// In-memory copy so utils/nextAction.js can read it synchronously; refreshed
// (cheaply) whenever nextAction refreshes its snapshot, and at once on save.
let CACHE = { at: 0, settings: normalise(null), version: 'default' };

async function readRow() {
  return prisma.integration.findUnique({ where: { id: STORE_ID } }).catch(() => null);
}
function parse(row) {
  try { return row && row.values ? JSON.parse(row.values) : null; } catch { return null; }
}

async function loadAlertSettings({ maxAgeMs = 5000 } = {}) {
  if (Date.now() - CACHE.at < maxAgeMs) return CACHE.settings;
  const row = await readRow();
  const settings = normalise(parse(row));
  CACHE = { at: Date.now(), settings, version: row && row.updatedAt ? String(new Date(row.updatedAt).getTime()) : 'default' };
  return settings;
}
const alertSettingsNow = () => CACHE.settings;
const alertSettingsVersion = () => CACHE.version;

// Days for one stage + its anchor (null = the stage has no default).
function stageRule(stage, settings = CACHE.settings) {
  const g = GROUP_OF_STAGE[stage];
  if (!g) return null;
  const days = settings.dueDays[g.id];
  return { group: g.id, days: Number.isFinite(days) ? days : g.days, anchor: g.anchor || null };
}

// What the Admin screen edits. Returns { settings, before } or { error }.
async function saveAlertSettings(patch, { system = false } = {}) {
  const row = await readRow();
  const cur = normalise(parse(row));
  const next = JSON.parse(JSON.stringify(cur));
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.dueDays && typeof p.dueDays === 'object') {
    for (const [k, v] of Object.entries(p.dueDays)) {
      if (!(k in next.dueDays)) continue;
      const n = intIn(v, 0, 60);
      if (n === null) return { error: `${(STEP_GROUPS.find((g) => g.id === k) || {}).label || k}: write a number of days from 0 to 60.` };
      next.dueDays[k] = n;
    }
  }
  if (p.staleAfterDays !== undefined) {
    const n = intIn(p.staleAfterDays, 7, 365);
    if (n === null) return { error: 'Stale after: write a number of days from 7 to 365.' };
    next.staleAfterDays = n;
  }
  if (p.bellExpireDays !== undefined) {
    const n = intIn(p.bellExpireDays, 1, 90);
    if (n === null) return { error: 'Bell keeps messages for: write a number of days from 1 to 90.' };
    next.bellExpireDays = n;
  }
  if (p.escalation && typeof p.escalation === 'object') {
    const e = p.escalation;
    if (e.enabled !== undefined) next.escalation.enabled = e.enabled === true;
    if (e.tlAfterDays !== undefined) {
      const n = intIn(e.tlAfterDays, 0, 30);
      if (n === null) return { error: 'Tell the team lead after: write a number of days from 0 to 30.' };
      next.escalation.tlAfterDays = n;
    }
    if (e.managerAfterDays !== undefined) {
      const n = intIn(e.managerAfterDays, 0, 60);
      if (n === null) return { error: 'Tell the manager after: write a number of days from 0 to 60.' };
      next.escalation.managerAfterDays = n;
    }
    if (next.escalation.managerAfterDays < next.escalation.tlAfterDays) {
      return { error: 'The manager is told after the team lead — pick the same number of days or more.' };
    }
    if (system && e.lastRunAt !== undefined) next.escalation.lastRunAt = e.lastRunAt;
    if (system && e.lastRun !== undefined) next.escalation.lastRun = e.lastRun;
  }
  const values = JSON.stringify(next);
  const saved = await prisma.integration.upsert({
    where: { id: STORE_ID },
    create: { id: STORE_ID, enabled: true, state: 'Internal', values },
    update: { values },
  });
  CACHE = { at: Date.now(), settings: normalise(next), version: String(new Date(saved.updatedAt).getTime()) };
  return { settings: CACHE.settings, before: cur };
}

module.exports = {
  STORE_ID, STEP_GROUPS, DEFAULTS, FIRST_START,
  loadAlertSettings, alertSettingsNow, alertSettingsVersion, stageRule, saveAlertSettings,
};
