// ---------------------------------------------------------------------------
// WHO COUNTS AS "JOINED" (founder 2026-11-19: "candidates who dropped are shown in the Dropped list, and they are ALSO shown again in the
// Joined list and counted under Joined. Many of them.")
//
// A candidate's step stays Joined after a drop (the step is history), and the Joining & Drop record (joindrop/*) says Dropped. THIS file is the
// one place that says what that means for every Joined list and number:
//
//   switch OFF (default)   AppSetting "ats.joinedCountsDropped" = off. A person whose record is Dropped is NOT in any Joined list or Joined number
//                          (ATS home card + list + month tables, My results, Daily report, Results vs target, the HRMS "3 of 4", Joining screen
//                          "Joined" tab, the client's joined totals, history): they are in the Dropped lists and Dropped numbers only.
//   switch ON              today's behaviour as it was: a drop never changes a Joined count.
//
// Withdrawing a drop ("Withdraw the drop", joindrop/core.js reopen) puts the record back to Joined and so the person back in Joined everywhere.
// Invoices and incentive decisions are never changed by any of this (they are stored facts); only the counts and lists move.
//
// atsVocab.leftAfterJoining(app) (the candidate lists' "Dropped" label) asks this file's droppedNow() too, so there is ONE definition of "left after joining".
//
// API
//   droppedAppIds()    async  Set of every application whose JoiningRecord says Dropped (cached ~20 s, invalidate() on any record change)
//   isDropped(appId)   async  boolean
//   excludeDropped()   async  true when the switch is OFF (the default): dropped people leave the Joined numbers
//   excludedIds()      async  the ids to leave out of Joined (the dropped set, or an empty set when the switch is ON)
//   refresh()          async  loads the above so the SYNC helpers below are current (atsHome calls it when it builds a page)
//   excluded(appId)    sync   true when this application must NOT be counted/listed as Joined (needs refresh() first)
//   dropInfo(appId)    sync   { droppedOn, reason, within } of a dropped application, or null
//   stateKey()         sync   a short string that changes whenever the answer can change (cache keys)
//   invalidate()       sync   a drop was reported / corrected / withdrawn, or the switch changed: forget it and every Joined cache that reads it
//   getSwitch / setSwitch     the Admin switch
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'ats.joinedCountsDropped';
// How long a load is trusted (a test shortens it with JOINED_RULE_TTL_MS). Nothing reads the sync helpers without a fresh load first: see refresh() and the
// express middleware in index.js (freshness is GUARANTEED, not hoped for: the first request after a start waits for the first load).
const TTL_MS = Math.max(0, Number(process.env.JOINED_RULE_TTL_MS)) || 20000;

let state = {
  at: 0, exclude: true, ids: new Set(), info: new Map(),
};
let version = 0;
let loading = null;
let loadingVersion = -1; // the invalidate() count the in-flight load started at
let seq = 0; // each load has a number; an older load never overwrites a newer answer
let applied = 0;
let loaded = false; // the first successful load has finished

async function readSwitch() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    if (!row) return false;
    const v = String(row.value || '').trim().toLowerCase();
    return v === 'true' || v === 'on' || v === '1' || v === 'yes';
  } catch { return false; }
}

async function readDropped() {
  const ids = new Set();
  const info = new Map();
  let ok = false;
  try {
    const S = require('../joindrop/schema'); // eslint-disable-line global-require
    if (await S.ensure()) {
      const got = await S.rows('SELECT "applicationId","droppedOn","dropReason","dropReasonDetail","dropWithinGuarantee" FROM "JoiningRecord" WHERE "status" = \'Dropped\'');
      got.forEach((r) => {
        ids.add(r.applicationId);
        info.set(r.applicationId, {
          droppedOn: r.droppedOn || null,
          reason: r.dropReason && /^other/i.test(r.dropReason) && r.dropReasonDetail ? r.dropReasonDetail : (r.dropReason || null),
          within: r.dropWithinGuarantee === 1 ? true : (r.dropWithinGuarantee === 0 ? false : null),
        });
      });
      ok = true;
    }
  } catch (err) { console.error('[joinedRule] dropped list failed:', err.message); } // eslint-disable-line no-console
  return { ids, info, ok };
}

// ONE in-flight load is shared by every concurrent caller. A load that started before the latest invalidate() is not shared (it would hand out the old
// answer): a new one starts. A load that FAILED is never trusted (the old answer stays, the next caller tries again), so an empty set is never cached
// by mistake.
async function refresh({ fresh = false } = {}) {
  if (!fresh && state.at && Date.now() - state.at < TTL_MS) return state;
  if (loading && loadingVersion === version) return loading;
  const startedAt = version;
  const mine = seq + 1;
  seq = mine;
  const job = (async () => {
    const [sw, d] = await Promise.all([readSwitch(), readDropped()]);
    const next = {
      // an invalidate() that happened while we were reading makes this answer old: use it for this caller, but do not keep it
      at: d.ok && startedAt === version ? Date.now() : 0, exclude: !sw, ids: d.ids, info: d.info,
    };
    if (!d.ok) return state; // keep what we knew; the next caller retries
    if (mine > applied) { applied = mine; state = next; loaded = true; }
    return mine === applied ? state : next;
  })().finally(() => { if (loading === job) loading = null; });
  loading = job;
  loadingVersion = startedAt;
  return job;
}
const isLoaded = () => loaded;

// EXPRESS MIDDLEWARE (mounted early on /api in index.js): every request waits for a FRESH dropped-people set before any route runs, so the sync helpers
// below (excluded / droppedNow / dropInfo / notInWhere) are never read empty - not on the very first request after a start, not after the TTL ran out, not
// when ten requests arrive together (they share one load). It costs one small query at most every TTL_MS. It never fails a request: when the load errors
// the request goes on with what is known (and the next request tries again).
function middleware() {
  return (req, res, next) => {
    if (req.path === '/health') { next(); return; }
    refresh().then(() => next(), () => next());
  };
}

const droppedAppIds = async (opts) => (await refresh(opts)).ids;
const isDropped = async (appId) => (await refresh()).ids.has(appId);
const excludeDropped = async () => (await refresh()).exclude;
async function excludedIds() { const s = await refresh(); return s.exclude ? s.ids : new Set(); }

// true for ANY dropped application, whatever the switch (Accounts' "Left after joining" tag); needs refresh() first
// a Prisma where fragment that leaves the dropped people out of a Joined count: {} (switch ON) or { id: { notIn: [...] } }; needs refresh() first
const notInWhere = () => (state.exclude && state.ids.size ? { id: { notIn: [...state.ids] } } : {});
const droppedNow = (appId) => state.ids.has(appId);
const excluded = (appId) => state.exclude && state.ids.has(appId);
const dropInfo = (appId) => state.info.get(appId) || null;
const stateKey = () => `${version}:${state.exclude ? 'x' : 'i'}:${state.ids.size}`;

// Forget the answer and every cache that was built from it (the credited joinings, the report copy of the data, the home boards).
function invalidate() {
  version += 1;
  state = { ...state, at: 0 };
  // keep the SYNC readers (atsVocab.leftAfterJoining, dropInfo) current for every screen that does not await refresh() itself
  setImmediate(() => { refresh({ fresh: true }).catch(() => null); });
  try { require('./recruiterJoinings').invalidate(); } catch { /* not loaded yet */ } // eslint-disable-line global-require
  try { require('./atsHome').forgetBoards(); } catch { /* not loaded yet */ } // eslint-disable-line global-require
  try { require('./teamWorkload').forgetWorld(); } catch { /* not loaded yet */ } // eslint-disable-line global-require
}

// warm at start, so a screen that reads the sync helpers first (a list, an export, a message) already knows who dropped
setTimeout(() => { refresh().catch(() => null); }, 1500).unref();

async function getSwitch() { return { joinedCountsDropped: !(await excludeDropped()) }; }
async function setSwitch(on, user) {
  const value = on ? 'true' : 'false';
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value, ...who }, update: { value, ...who } });
  invalidate();
  try {
    await require('./audit').logAudit({ // eslint-disable-line global-require
      userId: user ? user.id : null, action: 'Joined count rule changed', entity: 'AppSetting', entityId: KEY,
      toValue: on ? 'People who left after joining ARE counted as Joined' : 'People who left after joining are NOT counted as Joined (shown under Dropped)',
    });
  } catch { /* audit is a bonus */ }
  return getSwitch();
}

module.exports = {
  KEY, isLoaded, middleware, droppedAppIds, isDropped, excludeDropped, excludedIds, refresh, excluded, droppedNow, notInWhere, dropInfo, stateKey, invalidate, getSwitch, setSwitch,
};
