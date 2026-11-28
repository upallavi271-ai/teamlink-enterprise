// ---------------------------------------------------------------------------
// CANDIDATE PROFILES FROM 2025 ON THE SCREENS (founder 2026-11-28: "agreements & reqs alaagey ippudu elaaga vunnayo, alaagey vundchu,
// candidate profiles matram 2025 nunchi vundali. anni depts vi" - then "Screens too").
//
// Every ATS screen shows a candidate's work (an Application) only when it was added on or after 1 January 2025 (IST), in every
// department and for every login. Clients, requirements and agreements are NOT narrowed. Nothing is deleted: the older work stays in
// the database, and the duplicate checks still see it (so nobody is added twice), only the screens leave it out.
//
//   ATS_PROFILES_FROM unset         TeamLink: 2025-01-01
//   ATS_PROFILES_FROM=2024-06-01    another start date
//   ATS_PROFILES_FROM=off           everything, as before
//   ATS_PROFILE=it-staffing         (the NISH copy) off unless ATS_PROFILES_FROM is set there
// ---------------------------------------------------------------------------
const AP = require('./atsProfile');

let memo;
function profilesFrom() {
  const raw = String(process.env.ATS_PROFILES_FROM == null ? '' : process.env.ATS_PROFILES_FROM).trim();
  if (memo && memo.raw === raw) return memo.at;
  let at = null;
  if (!/^(off|none|no|0|false|all)$/i.test(raw) && !(AP.itStaffing() && !raw)) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '2025-01-01';
    const d = new Date(`${day}T00:00:00+05:30`);
    at = Number.isNaN(d.getTime()) ? null : d;
  }
  memo = { raw, at };
  return at;
}

const ms = (v) => (v instanceof Date ? v.getTime() : (v == null ? NaN : new Date(v).getTime()));

// An application loaded without its createdAt is let through (the caller did not ask for the date; the list rules still apply).
function appInWindow(a) {
  const at = profilesFrom();
  if (!at || !a || a.createdAt === undefined) return true;
  const t = ms(a.createdAt);
  return Number.isNaN(t) || t >= at.getTime();
}

// Prisma `where` piece for Application (null when the rule is off).
function applicationWindowWhere() {
  const at = profilesFrom();
  return at ? { createdAt: { gte: at } } : null;
}

// Prisma `where` piece for Candidate: someone with work from the start date on, or with no work at all who was added since then.
function candidateWindowWhere() {
  const at = profilesFrom();
  if (!at) return null;
  return { OR: [{ applications: { some: { createdAt: { gte: at } } } }, { AND: [{ applications: { none: {} } }, { createdAt: { gte: at } }] }] };
}

// A where that already narrows (anything) AND the window.
function withApplicationWindow(where) {
  const w = applicationWindowWhere();
  if (!w) return where;
  if (!where || !Object.keys(where).length) return { ...w };
  return { AND: [where, w] };
}
function withCandidateWindow(where) {
  const w = candidateWindowWhere();
  if (!w) return where;
  if (!where || !Object.keys(where).length) return { AND: [w] };
  return { AND: [where, w] };
}

// The candidate-list snapshot (utils/candidateListCache.js) as the screens see it: each person with only their work from the start
// date on; a person with none of that is left out, unless they have no work at all and were added since then. Built once per
// snapshot version. The snapshot itself stays whole - the duplicate checks read it.
const VIEW = new WeakMap();
function viewOfState(st) {
  const at = profilesFrom();
  if (!at || !st) return st;
  const hit = VIEW.get(st);
  if (hit && hit.version === st.version && hit.at === at.getTime()) return hit.view;
  const from = at.getTime();
  const candidates = [];
  const byId = new Map();
  const apps = new Map();
  for (const c of st.candidates) {
    const list = c.applications || [];
    const keep = list.filter((a) => { const t = ms(a.createdAt); return Number.isNaN(t) || t >= from; });
    if (!keep.length && (list.length || !(ms(c.createdAt) >= from))) continue;
    const v = keep.length === list.length ? c : { ...c, applications: keep };
    candidates.push(v);
    byId.set(v.id, v);
    keep.forEach((a) => apps.set(a.id, a));
  }
  const view = { ...st, candidates, byId, apps, windowFrom: at };
  VIEW.set(st, { version: st.version, at: from, view });
  return view;
}

module.exports = { profilesFrom, appInWindow, applicationWindowWhere, candidateWindowWhere, withApplicationWindow, withCandidateWindow, viewOfState };
