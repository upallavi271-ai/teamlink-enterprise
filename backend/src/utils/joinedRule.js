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
const TTL_MS = 20000;

let state = {
  at: 0, exclude: true, ids: new Set(), info: new Map(),
};
let version = 0;
let loading = null;

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
    }
  } catch (err) { console.error('[joinedRule] dropped list failed:', err.message); } // eslint-disable-line no-console
  return { ids, info };
}

async function refresh({ fresh = false } = {}) {
  if (!fresh && state.at && Date.now() - state.at < TTL_MS) return state;
  if (loading) return loading;
  const startedAt = version;
  loading = (async () => {
    const [sw, d] = await Promise.all([readSwitch(), readDropped()]);
    // an invalidate() that happened while we were reading makes this answer old: use it for this caller, but do not keep it
    state = {
      at: startedAt === version ? Date.now() : 0, exclude: !sw, ids: d.ids, info: d.info,
    };
    return state;
  })().finally(() => { loading = null; });
  return loading;
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
  try { require('./recruiterJoinings').invalidate(); } catch { /* not loaded yet */ } // eslint-disable-line global-require
  try { require('./atsHome').forgetBoards(); } catch { /* not loaded yet */ } // eslint-disable-line global-require
  try { require('./teamWorkload').forgetWorld(); } catch { /* not loaded yet */ } // eslint-disable-line global-require
}

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
  KEY, droppedAppIds, isDropped, excludeDropped, excludedIds, refresh, excluded, droppedNow, notInWhere, dropInfo, stateKey, invalidate, getSwitch, setSwitch,
};
