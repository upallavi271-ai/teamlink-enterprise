// ---------------------------------------------------------------------------
// AUTOMATIC STAGE MESSAGES - THE RULES (user, 2026-10-10: "schedule an AI
// message every time a candidate moves to the next step").
//
//   One rule per step (stage code). Stored in AppSetting "auto-messages" as
//   OVERRIDES of the built-in defaults, so the defaults can improve later and
//   nothing is written until a person saves:
//
//     defaults  = what the app does today: the 11 steps that already send a
//                 message are ON, right away, on every channel of their
//                 template, with the template's wording. Every other step is OFF.
//     goLiveAt  = set to NOW the first time anybody saves. Until then the OLD
//                 code path (utils/candidateComms.js) runs untouched. After it,
//                 only step moves made AFTER that moment are ever messaged.
//     killSwitch= one switch that stops every automatic stage message.
//
//   Per-job override   AppSetting "auto-messages.job.<requirementId>"
//                      { mode: off | approval }  (no row = follow the rules)
//   Per-person pause   AppSetting "auto-messages.pause.<candidateId>"
//
// Every change is audited (who, old -> new). Times are India time (IST).
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { ALL_STAGE_CODES, stageLabel } = require('./atsVocab');
const D = require('./autoMessageDefaults');
const { logAudit } = require('./audit');

const KEY = 'auto-messages';
const JOB_PREFIX = 'auto-messages.job.';
const PAUSE_PREFIX = 'auto-messages.pause.';
const CHANNELS = ['Email', 'WhatsApp', 'SMS'];
const WHEN_MODES = ['now', 'delay', 'working', 'approval'];
const WORDING = ['TEMPLATE', 'AI'];
const LANGS = ['Auto', 'English', 'Telugu', 'Hindi'];
const STRATEGIES = ['all', 'first'];
const URGENT_BY_DEFAULT = ['INTERVIEW_SCHEDULED', 'AI_INTERVIEW_SCHEDULED'];
const MAX_DELAY = 7 * 24 * 60;

const IST_MS = 330 * 60000;
const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// --- IST clock helpers ---------------------------------------------------------
function istParts(ms) {
  const d = new Date(ms + IST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), dow: d.getUTCDay() };
}
const istMs = (y, m, d, h, min) => Date.UTC(y, m, d, h, min, 0, 0) - IST_MS;
const hmOf = (s) => { const m = HM.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const minutesOfDay = (ms) => { const p = istParts(ms); return p.h * 60 + p.min; };
const dayStartIst = (ms) => { const p = istParts(ms); return istMs(p.y, p.m, p.d, 0, 0); };
const ymdIst = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);

// Is this moment inside quiet hours (they can wrap midnight: 21:00 -> 08:00)?
function inQuiet(ms, quiet) {
  if (!quiet || quiet.enabled === false) return false;
  const a = hmOf(quiet.from); const b = hmOf(quiet.to); const t = minutesOfDay(ms);
  if (a == null || b == null || a === b) return false;
  return a < b ? (t >= a && t < b) : (t >= a || t < b);
}
// The first moment at or after `ms` when quiet hours are over.
function quietEnd(ms, quiet) {
  if (!inQuiet(ms, quiet)) return ms;
  const b = hmOf(quiet.to); const t = minutesOfDay(ms);
  const base = dayStartIst(ms);
  // before the end time today -> today at the end time; otherwise -> tomorrow
  return base + (t < b ? b : b + 1440) * 60000;
}
// "Next working hour": inside working time (workStart .. quiet start, Monday to Saturday) it is now;
// otherwise the next working day's start (09:00 by default).
function nextWorking(ms, settings) {
  const start = hmOf(settings.workStart) == null ? 540 : hmOf(settings.workStart);
  const endQ = settings.quiet && settings.quiet.enabled !== false && hmOf(settings.quiet.from) != null ? hmOf(settings.quiet.from) : 1260;
  let t = ms;
  for (let i = 0; i < 9; i += 1) {
    const p = istParts(t);
    const mins = p.h * 60 + p.min;
    const base = dayStartIst(t);
    if (p.dow !== 0) {
      if (mins >= start && mins < endQ) return t;
      if (mins < start) return base + start * 60000;
    }
    t = base + 1440 * 60000; // midnight of the next day
  }
  return ms;
}

// --- defaults -------------------------------------------------------------------
function candidateTemplates() {
  // eslint-disable-next-line global-require
  return require('./candidateComms').TEMPLATES;
}
function defaultRule(stage) {
  const T = candidateTemplates()[stage];
  if (T) {
    const channels = CHANNELS.filter((c) => T.channels.includes(c));
    return {
      on: true, channels, strategy: 'all', when: { mode: 'now', minutes: 0 },
      wording: 'TEMPLATE', instruction: '', templatePurpose: T.key, language: 'Auto', urgent: URGENT_BY_DEFAULT.includes(stage),
    };
  }
  return {
    on: false, channels: ['Email'], strategy: 'first', when: { mode: 'now', minutes: 0 },
    wording: 'TEMPLATE', instruction: '', templatePurpose: D.EXTRA_PURPOSE[stage] || null, language: 'Auto', urgent: false,
  };
}
// Steps that already send a message today (the only ones ON by default).
const sendsToday = (stage) => !!candidateTemplates()[stage];

const DEFAULT_SETTINGS = {
  killSwitch: false,
  goLiveAt: null,
  quiet: { enabled: true, from: '21:00', to: '08:00' },
  workStart: '09:00',
  supersedeMinutes: 10, // moving again within this time cancels the earlier waiting message
  dupHours: 24, // the same step message is not sent twice to one application inside this time
  maxAgeHours: 48, // a message that could not go for this long is dropped (stale news is worse than none)
  caps: { perCandidatePerDay: 3, perChannelPerDay: { Email: 300, WhatsApp: 200, SMS: 200 } },
  ai: { perDay: 50, timeoutSeconds: 25 },
  skipIfCalledToday: false,
  rules: {},
};

// --- settings store ---------------------------------------------------------------
let cache = null;
const CACHE_MS = 4000;
function invalidate() { cache = null; }

function cleanSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
  const q = s.quiet || {};
  const caps = s.caps || {};
  const per = caps.perChannelPerDay || {};
  const ai = s.ai || {};
  const rules = {};
  Object.keys(s.rules || {}).forEach((k) => { if (ALL_STAGE_CODES.includes(k) && s.rules[k] && typeof s.rules[k] === 'object') rules[k] = s.rules[k]; });
  return {
    killSwitch: s.killSwitch === true,
    goLiveAt: typeof s.goLiveAt === 'string' ? s.goLiveAt : null,
    quiet: {
      enabled: q.enabled !== false,
      from: hmOf(q.from) != null ? String(q.from) : DEFAULT_SETTINGS.quiet.from,
      to: hmOf(q.to) != null ? String(q.to) : DEFAULT_SETTINGS.quiet.to,
    },
    workStart: hmOf(s.workStart) != null ? String(s.workStart) : DEFAULT_SETTINGS.workStart,
    supersedeMinutes: num(s.supersedeMinutes, 10, 0, 1440),
    dupHours: num(s.dupHours, 24, 0, 720),
    maxAgeHours: num(s.maxAgeHours, 48, 1, 720),
    caps: {
      perCandidatePerDay: num(caps.perCandidatePerDay, 3, 1, 50),
      perChannelPerDay: {
        Email: num(per.Email, 300, 1, 20000), WhatsApp: num(per.WhatsApp, 200, 1, 20000), SMS: num(per.SMS, 200, 1, 20000),
      },
    },
    ai: { perDay: num(ai.perDay, 50, 0, 5000), timeoutSeconds: num(ai.timeoutSeconds, 25, 5, 120) },
    skipIfCalledToday: s.skipIfCalledToday === true,
    rules,
  };
}

async function loadSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let row = null;
  try { row = await prisma.appSetting.findUnique({ where: { key: KEY } }); } catch { row = null; }
  let raw = {};
  try { raw = row ? JSON.parse(row.value) : {}; } catch { raw = {}; }
  const value = { ...cleanSettings(raw), updatedByName: row ? row.updatedByName : null, updatedAt: row ? row.updatedAt : null };
  cache = { at: Date.now(), value };
  return value;
}

// The effective rule: built-in default + the saved override.
function effectiveRule(stage, settings) {
  const base = defaultRule(stage);
  const o = (settings && settings.rules && settings.rules[stage]) || {};
  const when = { ...base.when, ...(o.when || {}) };
  return {
    on: o.on === undefined ? base.on : o.on === true,
    channels: Array.isArray(o.channels) ? o.channels.filter((c) => CHANNELS.includes(c)) : base.channels,
    strategy: STRATEGIES.includes(o.strategy) ? o.strategy : base.strategy,
    when: { mode: WHEN_MODES.includes(when.mode) ? when.mode : 'now', minutes: Math.min(MAX_DELAY, Math.max(0, Math.round(Number(when.minutes) || 0))) },
    wording: WORDING.includes(o.wording) ? o.wording : base.wording,
    instruction: typeof o.instruction === 'string' ? o.instruction.slice(0, 300) : base.instruction,
    templatePurpose: o.templatePurpose === undefined ? base.templatePurpose : (o.templatePurpose || null),
    language: LANGS.includes(o.language) ? o.language : base.language,
    urgent: o.urgent === undefined ? base.urgent : o.urgent === true,
  };
}
const isEdited = (stage, settings) => !!(settings && settings.rules && settings.rules[stage] && Object.keys(settings.rules[stage]).length);

function allRules(settings) {
  return ALL_STAGE_CODES.map((stage) => ({
    stage, label: stageLabel(stage), rule: effectiveRule(stage, settings), defaultRule: defaultRule(stage), edited: isEdited(stage, settings), sendsToday: sendsToday(stage),
  }));
}

// Is the new scheduler running? (Not before the first save. The old path runs until then.)
const started = (settings) => !!(settings && settings.goLiveAt);

// --- permissions ------------------------------------------------------------------
const rolesOf = (u) => [u && u.role, u && u.atsRole].filter(Boolean);
const external = (u) => rolesOf(u).some((r) => ['CLIENT', 'CANDIDATE'].includes(r));
const canManage = (u) => !!u && !u.viewAs && !external(u) && rolesOf(u).some((r) => ['SUPER_ADMIN', 'ADMIN', 'HR'].includes(r));
const canAct = (u) => !!u && !u.viewAs && !external(u) && rolesOf(u).some((r) => ['SUPER_ADMIN', 'ADMIN', 'HR', 'TL', 'STL', 'RECRUITER'].includes(r));
const canView = (u) => !!u && !external(u);

// --- validation + save ---------------------------------------------------------------
function readRulePatch(stage, input, current) {
  const errs = [];
  const out = {};
  const inp = input || {};
  if (inp.on !== undefined) out.on = inp.on === true;
  if (inp.channels !== undefined) {
    const list = (Array.isArray(inp.channels) ? inp.channels : []).filter((c, i, a) => CHANNELS.includes(c) && a.indexOf(c) === i);
    out.channels = list;
  }
  if (inp.strategy !== undefined) {
    if (!STRATEGIES.includes(inp.strategy)) errs.push('Choose how to use the channels: all of them, or the first one that works.');
    else out.strategy = inp.strategy;
  }
  if (inp.when !== undefined) {
    const w = inp.when || {};
    if (!WHEN_MODES.includes(w.mode)) errs.push('Choose when the message goes.');
    else {
      const minutes = Math.round(Number(w.minutes) || 0);
      if (w.mode === 'delay' && (minutes < 1 || minutes > MAX_DELAY)) errs.push(`"After ... minutes" must be between 1 and ${MAX_DELAY}.`);
      out.when = { mode: w.mode, minutes: w.mode === 'delay' ? minutes : 0 };
    }
  }
  if (inp.wording !== undefined) {
    if (!WORDING.includes(inp.wording)) errs.push('Choose "Use the template" or "AI writes it".');
    else out.wording = inp.wording;
  }
  if (inp.instruction !== undefined) out.instruction = String(inp.instruction || '').trim().slice(0, 300);
  if (inp.templatePurpose !== undefined) out.templatePurpose = inp.templatePurpose ? String(inp.templatePurpose).slice(0, 80) : null;
  if (inp.language !== undefined) {
    if (!LANGS.includes(inp.language)) errs.push('Choose English, Telugu, Hindi or "Candidate\'s own".');
    else out.language = inp.language;
  }
  if (inp.urgent !== undefined) out.urgent = inp.urgent === true;
  const next = { ...current, ...out };
  if (next.on && !next.channels.length) errs.push(`${stageLabel(stage)}: tick at least one way to send (Email, WhatsApp or SMS), or switch the step off.`);
  return { errs, out };
}

function patchSettings(user, cur, patch) {
  const errs = [];
  const next = JSON.parse(JSON.stringify({ ...cur, updatedByName: undefined, updatedAt: undefined }));
  const p = patch || {};
  if (p.killSwitch !== undefined) next.killSwitch = p.killSwitch === true;
  if (p.quiet !== undefined) {
    const q = p.quiet || {};
    if (q.from !== undefined && hmOf(q.from) == null) errs.push('Quiet hours: type the start like 21:00.');
    else if (q.to !== undefined && hmOf(q.to) == null) errs.push('Quiet hours: type the end like 08:00.');
    else next.quiet = { enabled: q.enabled === undefined ? next.quiet.enabled : q.enabled === true, from: q.from || next.quiet.from, to: q.to || next.quiet.to };
  }
  if (p.workStart !== undefined) { if (hmOf(p.workStart) == null) errs.push('Working day starts: type the time like 09:00.'); else next.workStart = String(p.workStart); }
  const numField = (k, lo, hi, label) => {
    if (p[k] === undefined) return;
    const n = Math.round(Number(p[k]));
    if (!Number.isFinite(n) || n < lo || n > hi) errs.push(`${label} must be between ${lo} and ${hi}.`); else next[k] = n;
  };
  numField('supersedeMinutes', 0, 1440, 'Cancel earlier waiting message if they move again within (minutes)');
  numField('dupHours', 0, 720, 'Do not repeat the same message within (hours)');
  numField('maxAgeHours', 1, 720, 'Drop a message that could not go within (hours)');
  if (p.caps !== undefined) {
    const c = p.caps || {};
    if (c.perCandidatePerDay !== undefined) {
      const n = Math.round(Number(c.perCandidatePerDay));
      if (!Number.isFinite(n) || n < 1 || n > 50) errs.push('Messages per person per day must be between 1 and 50.'); else next.caps.perCandidatePerDay = n;
    }
    Object.keys(c.perChannelPerDay || {}).forEach((ch) => {
      if (!CHANNELS.includes(ch)) return;
      const n = Math.round(Number(c.perChannelPerDay[ch]));
      if (!Number.isFinite(n) || n < 1 || n > 20000) errs.push(`${ch}: messages per day must be between 1 and 20000.`); else next.caps.perChannelPerDay[ch] = n;
    });
  }
  if (p.ai !== undefined) {
    const a = p.ai || {};
    if (a.perDay !== undefined) { const n = Math.round(Number(a.perDay)); if (!Number.isFinite(n) || n < 0 || n > 5000) errs.push('AI messages per day must be between 0 and 5000.'); else next.ai.perDay = n; }
    if (a.timeoutSeconds !== undefined) { const n = Math.round(Number(a.timeoutSeconds)); if (!Number.isFinite(n) || n < 5 || n > 120) errs.push('AI waiting time must be between 5 and 120 seconds.'); else next.ai.timeoutSeconds = n; }
  }
  if (p.skipIfCalledToday !== undefined) next.skipIfCalledToday = p.skipIfCalledToday === true;
  if (p.rules !== undefined) {
    Object.keys(p.rules || {}).forEach((stage) => {
      if (!ALL_STAGE_CODES.includes(stage)) { errs.push(`"${stage}" is not a step.`); return; }
      const cur0 = effectiveRule(stage, next);
      const { errs: e, out } = readRulePatch(stage, p.rules[stage], cur0);
      errs.push(...e);
      // only keep what differs from the built-in default, so the override list stays honest
      const base = defaultRule(stage);
      const merged = { ...(next.rules[stage] || {}), ...out };
      Object.keys(merged).forEach((k) => { if (JSON.stringify(merged[k]) === JSON.stringify(base[k])) delete merged[k]; });
      if (Object.keys(merged).length) next.rules[stage] = merged; else delete next.rules[stage];
    });
  }
  return { errs, next };
}

const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function diffAudit(cur, next) {
  const rows = [];
  const flat = (o, pre, acc) => {
    Object.keys(o || {}).forEach((k) => {
      if (['rules', 'updatedByName', 'updatedAt', 'goLiveAt'].includes(k)) return;
      if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) flat(o[k], `${pre}${k}.`, acc); else acc[`${pre}${k}`] = o[k];
    });
    return acc;
  };
  const a = flat(cur, '', {}); const b = flat(next, '', {});
  Object.keys(b).forEach((k) => { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) rows.push({ field: k, label: `Automatic messages: ${k}`, from: short(a[k]), to: short(b[k]) }); });
  ALL_STAGE_CODES.forEach((stage) => {
    const ra = effectiveRule(stage, cur); const rb = effectiveRule(stage, next);
    Object.keys(rb).forEach((k) => {
      if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) rows.push({ field: `${stage}.${k}`, label: `${stageLabel(stage)}: ${k}`, from: short(ra[k]), to: short(rb[k]) });
    });
  });
  return rows;
}

async function saveSettings(user, patch) {
  const cur = await loadSettings({ fresh: true });
  const { errs, next } = patchSettings(user, cur, patch);
  if (errs.length) return { error: errs.join(' '), status: 400 };
  const first = !cur.goLiveAt;
  if (first) next.goLiveAt = new Date().toISOString();
  const changes = diffAudit(cur, next);
  const value = JSON.stringify({ ...next });
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value, updatedById: user.id, updatedByName: user.name },
    update: { value, updatedById: user.id, updatedByName: user.name },
  });
  invalidate();
  if (first) {
    await logAudit({
      userId: user.id, actorName: user.name, action: 'Automatic messages started', entity: 'AppSetting', entityId: KEY,
      toValue: `From ${next.goLiveAt}. Only step moves after this moment are messaged.`,
    });
  }
  for (const c of changes) {
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      userId: user.id, actorName: user.name, action: 'Automatic message rule changed', entity: 'AppSetting', entityId: KEY,
      field: c.field, fieldLabel: c.label, fromValue: c.from == null ? null : String(c.from).slice(0, 500), toValue: c.to == null ? null : String(c.to).slice(0, 500),
    });
  }
  return { settings: await loadSettings({ fresh: true }), changed: changes.length, started: first };
}

// The change history shown on the screen (from the audit log).
async function history(limit = 30) {
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'AppSetting', entityId: KEY },
    orderBy: { createdAt: 'desc' }, take: limit,
  }).catch(() => []);
  return rows.map((r) => ({
    id: r.id, at: r.createdAt, by: r.actorName || null, action: r.action, what: r.fieldLabel || r.action, from: r.fromValue, to: r.toValue,
  }));
}

// --- per-job and per-person overrides -----------------------------------------------------
async function readJson(key) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return null;
  try { return { ...JSON.parse(row.value), byName: row.updatedByName, at: row.updatedAt }; } catch { return null; }
}
async function jobOverride(requirementId) {
  if (!requirementId) return null;
  const v = await readJson(`${JOB_PREFIX}${requirementId}`);
  return v && ['off', 'approval'].includes(v.mode) ? v : null;
}
async function setJobOverride(user, requirementId, mode, note) {
  const req = await prisma.requirement.findUnique({ where: { id: requirementId }, select: { id: true, title: true } });
  if (!req) return { error: 'No such requirement.', status: 404 };
  const key = `${JOB_PREFIX}${requirementId}`;
  const before = await jobOverride(requirementId);
  if (!['inherit', 'off', 'approval'].includes(mode)) return { error: 'Choose: follow the rules, switch off for this requirement, or ask the recruiter first.', status: 400 };
  if (mode === 'inherit') await prisma.appSetting.delete({ where: { key } }).catch(() => {});
  else {
    const value = JSON.stringify({ mode, note: String(note || '').slice(0, 200) });
    await prisma.appSetting.upsert({ where: { key }, create: { key, value, updatedById: user.id, updatedByName: user.name }, update: { value, updatedById: user.id, updatedByName: user.name } });
  }
  const label = { inherit: 'Follow the rules', off: 'No automatic messages', approval: 'Recruiter approves first' };
  await logAudit({
    userId: user.id, actorName: user.name, action: 'Automatic messages: requirement setting changed', entity: 'Requirement', entityId: requirementId,
    fromValue: label[before ? before.mode : 'inherit'], toValue: `${label[mode]} (${req.title})`,
  });
  return { mode };
}
async function pauseOf(candidateId) {
  if (!candidateId) return null;
  return readJson(`${PAUSE_PREFIX}${candidateId}`);
}
async function setPause(user, candidateId, paused, reason) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { id: true, name: true } });
  if (!c) return { error: 'No such person.', status: 404 };
  const key = `${PAUSE_PREFIX}${candidateId}`;
  if (paused) {
    const value = JSON.stringify({ reason: String(reason || '').slice(0, 200) });
    await prisma.appSetting.upsert({ where: { key }, create: { key, value, updatedById: user.id, updatedByName: user.name }, update: { value, updatedById: user.id, updatedByName: user.name } });
  } else await prisma.appSetting.delete({ where: { key } }).catch(() => {});
  await logAudit({
    userId: user.id, actorName: user.name, action: paused ? 'Automatic messages paused for a person' : 'Automatic messages resumed for a person',
    entity: 'Candidate', entityId: candidateId, toValue: c.name,
  });
  return { paused: !!paused };
}
async function pausedIds() {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: PAUSE_PREFIX } }, select: { key: true } }).catch(() => []);
  return rows.map((r) => r.key.slice(PAUSE_PREFIX.length));
}
async function jobOverrides() {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: JOB_PREFIX } } }).catch(() => []);
  const out = {};
  rows.forEach((r) => { try { out[r.key.slice(JOB_PREFIX.length)] = { ...JSON.parse(r.value), byName: r.updatedByName }; } catch { /* skip */ } });
  return out;
}

module.exports = {
  KEY, CHANNELS, WHEN_MODES, WORDING, LANGS, STRATEGIES, IST_MS,
  istParts, istMs, hmOf, minutesOfDay, dayStartIst, ymdIst, inQuiet, quietEnd, nextWorking,
  defaultRule, sendsToday, DEFAULT_SETTINGS, loadSettings, invalidate, effectiveRule, allRules, started, isEdited,
  canManage, canAct, canView, saveSettings, history, patchSettings,
  jobOverride, setJobOverride, pauseOf, setPause, pausedIds, jobOverrides,
};
