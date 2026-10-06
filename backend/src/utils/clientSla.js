// ---------------------------------------------------------------------------
// PER-CLIENT SLA (ATS-100 B9.2) — two promises a client can have of its own:
//
//   feedbackDays        "Feedback within N days": how long the client may sit
//                       on a profile we sent (the Sent to client / Client
//                       feedback step) before it shows as Late.
//   firstProfilesDays   "Send first profiles within N days": from the day a
//                       job is raised to the first profile sent to the client.
//
// Both default to Administration → Company Setup → Step timing
// (utils/atsAlertSettings.js dueDays): feedback = the "Sent to client" step,
// first profiles = New + Recruiter review + TL review + BDE check added up.
// A client's own numbers win; blank = the default. Kept in the existing
// AppSetting table (key client-sla:<clientId>) — no schema change.
//
// Readers:
//   utils/nextAction.js      the due date of the Sent-to-client step (Late)
//   routes/atsReports.js     SLA & Aging → "Client promises" section
//   routes/clients.js        GET / PUT /clients/:id/sla, GET /clients/:id (.sla)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const AS = require('./atsAlertSettings');

const KEY = (clientId) => `client-sla:${clientId}`;
const MAX_DAYS = 90;

const intIn = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= MAX_DAYS ? n : undefined; // undefined = invalid
};

// The global defaults, from Step timing (fallback when a client has none).
function defaults(settings = AS.alertSettingsNow()) {
  const d = (settings && settings.dueDays) || {};
  const n = (k, fb) => (Number.isFinite(d[k]) ? d[k] : fb);
  return {
    feedbackDays: n('client', 5),
    firstProfilesDays: n('new', 2) + n('recruiter', 2) + n('tl', 1) + n('bde', 1),
  };
}

function parse(row) {
  try { return row && row.value ? JSON.parse(row.value) : null; } catch { return null; }
}

// In-memory copy so the due-date engine can read it synchronously.
let CACHE = { at: 0, map: new Map() };
const CACHE_MS = 60 * 1000;

async function refresh({ maxAgeMs = CACHE_MS } = {}) {
  if (Date.now() - CACHE.at < maxAgeMs) return CACHE.map;
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: 'client-sla:' } } }).catch(() => []);
  const map = new Map();
  rows.forEach((r) => {
    const v = parse(r);
    if (!v) return;
    map.set(r.key.slice('client-sla:'.length), {
      feedbackDays: intIn(v.feedbackDays) ?? null,
      firstProfilesDays: intIn(v.firstProfilesDays) ?? null,
      updatedAt: r.updatedAt, updatedByName: r.updatedByName || null,
    });
  });
  CACHE = { at: Date.now(), map };
  return map;
}
const invalidate = () => { CACHE = { at: 0, map: CACHE.map }; };

// The client's own numbers (null = default), with the effective values.
function shape(clientId, own) {
  const d = defaults();
  const o = own || { feedbackDays: null, firstProfilesDays: null };
  return {
    clientId,
    feedbackDays: o.feedbackDays, // own value or null
    firstProfilesDays: o.firstProfilesDays,
    effective: {
      feedbackDays: o.feedbackDays ?? d.feedbackDays,
      firstProfilesDays: o.firstProfilesDays ?? d.firstProfilesDays,
    },
    defaults: d,
    updatedAt: o.updatedAt || null,
    updatedByName: o.updatedByName || null,
  };
}

async function slaOf(clientId) {
  const map = await refresh();
  return shape(clientId, map.get(clientId));
}

// Synchronous readers for the due-date engine (null = use the global step default).
function feedbackDaysNow(clientId) {
  const o = clientId ? CACHE.map.get(clientId) : null;
  return o && o.feedbackDays != null ? o.feedbackDays : null;
}
function firstProfilesDaysNow(clientId) {
  const o = clientId ? CACHE.map.get(clientId) : null;
  return o && o.firstProfilesDays != null ? o.firstProfilesDays : defaults().firstProfilesDays;
}
// Every client with its own numbers (for the report): clientId -> own.
const allNow = () => CACHE.map;

// Save (blank / null = back to the default). Returns { sla } or { error }.
async function save(clientId, patch, user) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = {};
  for (const k of ['feedbackDays', 'firstProfilesDays']) {
    if (!(k in p)) continue;
    const n = intIn(p[k]);
    if (n === undefined) return { error: `${k === 'feedbackDays' ? 'Feedback within' : 'Send first profiles within'}: whole days between 0 and ${MAX_DAYS}.` };
    next[k] = n;
  }
  const cur = (await refresh({ maxAgeMs: 0 })).get(clientId) || {};
  const value = { feedbackDays: cur.feedbackDays ?? null, firstProfilesDays: cur.firstProfilesDays ?? null, ...next };
  await prisma.appSetting.upsert({
    where: { key: KEY(clientId) },
    update: { value: JSON.stringify(value), updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    create: { key: KEY(clientId), value: JSON.stringify(value), updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  invalidate();
  await refresh({ maxAgeMs: 0 });
  return { sla: await slaOf(clientId), before: cur };
}

module.exports = {
  MAX_DAYS, defaults, refresh, invalidate, slaOf, save, feedbackDaysNow, firstProfilesDaysNow, allNow,
};
