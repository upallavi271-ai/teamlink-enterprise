// ---------------------------------------------------------------------------
// JOB PUBLISHING SETTINGS (AppSetting rows, no new table).
//
//   jobpublish.killAll                 { on, reason, by, at }  every portal stops: no run starts, a run in progress
//                                                              stops at its next safe step and goes back to the queue
//   jobpublish.pauseAll                { on, by, at }          quiet pause: nothing new starts, nothing is reported
//   jobpublish.portal.<key>.kill       { on, reason, by, at }  the same, for one portal
//   jobpublish.portal.<key>.humanHold  { at, reason, queueId } set when a portal asked for a CAPTCHA / OTP / ...: that
//                                                              portal's queue waits until a person opens the session
//   jobpublish.limits                  { globalConcurrency, minGapSeconds, maxGapSeconds, perHour, perDay, maxAttempts,
//                                        pollMs, staleLockMs, runDeadlineMs }
//   jobpublish.portal.<key>.limits     the same keys, for one portal (overrides the global values)
//   jobpublish.worker.heartbeat        { at, pid, host, current } written by the worker so the screen can say "worker running"
//   jobpublish.selectorsDir            a folder with <portal>.json files that override the built-in page settings
//   jobpublish.screenshotRetentionDays a number (default 30): pictures and page snapshots older than this are deleted
//   jobpublish.screenshotSweepAt       ISO time of the last sweep (the worker sweeps about once an hour)
//   jobpublish.portal.<key>.selectorStatus { version, verified, lastRunAt, steps: { <step>: { state: ok|drift|broken, usedIndex, kind, used, main, at } } }
//   jobpublish.portal.<key>.lastTest   { state, code, reason, at }  the result of the last Test connection (never a secret)
//
// Every read goes to the database (no cache): a switch must work on the very next run.
// ---------------------------------------------------------------------------
const { prisma, json, ms } = require('./db');
const { DEFAULTS } = require('./constants');

const LIMIT_KEYS = ['globalConcurrency', 'minGapSeconds', 'maxGapSeconds', 'perHour', 'perDay', 'maxAttempts', 'pollMs', 'staleLockMs', 'runDeadlineMs', 'otpWaitMs'];
const K = {
  killAll: 'jobpublish.killAll',
  pauseAll: 'jobpublish.pauseAll',
  limits: 'jobpublish.limits',
  heartbeat: 'jobpublish.worker.heartbeat',
  selectorsDir: 'jobpublish.selectorsDir',
  retention: 'jobpublish.screenshotRetentionDays',
  sweepAt: 'jobpublish.screenshotSweepAt',
  selectorStatus: (p) => `jobpublish.portal.${p}.selectorStatus`,
  lastTest: (p) => `jobpublish.portal.${p}.lastTest`,
  kill: (p) => `jobpublish.portal.${p}.kill`,
  hold: (p) => `jobpublish.portal.${p}.humanHold`,
  portalLimits: (p) => `jobpublish.portal.${p}.limits`,
};

async function get(key) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  return row ? { value: json(row.value, null), at: row.updatedAt, by: row.updatedByName || null } : null;
}
async function put(key, value, user = null) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    update: { value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
}
const del = (key) => prisma.appSetting.deleteMany({ where: { key } }).catch(() => {});

// ---- switches ------------------------------------------------------------------
async function killState(portal) {
  const [all, one, pause] = await Promise.all([get(K.killAll), portal ? get(K.kill(portal)) : null, get(K.pauseAll)]);
  const killedAll = !!(all && all.value && all.value.on);
  const killedOne = !!(one && one.value && one.value.on);
  const paused = !!(pause && pause.value && pause.value.on);
  return {
    killedAll, killedOne, paused,
    // anything that stops a run from STARTING
    stopped: killedAll || killedOne || paused,
    reason: killedAll ? (all.value.reason || 'All posting is switched off') : killedOne ? (one.value.reason || 'Posting to this site is switched off') : paused ? 'Posting is paused' : null,
    // only a kill (not a quiet pause) also stops a run that is in progress
    abort: killedAll || killedOne,
  };
}
async function setKill(portal, on, reason, user) {
  const key = portal ? K.kill(portal) : K.killAll;
  const was = await get(key);
  await put(key, { on: !!on, reason: String(reason || '').slice(0, 200), by: user ? user.name : null, at: new Date().toISOString() }, user);
  return { was: !!(was && was.value && was.value.on), now: !!on };
}
async function setPause(on, user) {
  await put(K.pauseAll, { on: !!on, by: user ? user.name : null, at: new Date().toISOString() }, user);
}

// ---- human hold (a CAPTCHA / OTP / ... was shown) -----------------------------------
async function humanHold(portal) { const r = await get(K.hold(portal)); return r && r.value ? r.value : null; }
async function setHumanHold(portal, info) { await put(K.hold(portal), { at: new Date().toISOString(), ...info }); }
async function clearHumanHold(portal) { await del(K.hold(portal)); }

// ---- limits ----------------------------------------------------------------------
async function limits(portal) {
  const [g, p] = await Promise.all([get(K.limits), portal ? get(K.portalLimits(portal)) : null]);
  const pick = (o, k) => (o && o.value && Number.isFinite(Number(o.value[k])) && Number(o.value[k]) >= 0 ? Number(o.value[k]) : undefined);
  const out = {};
  LIMIT_KEYS.forEach((k) => {
    const v = pick(p, k);
    out[k] = v !== undefined ? v : (pick(g, k) !== undefined ? pick(g, k) : DEFAULTS[k]);
  });
  if (out.maxGapSeconds < out.minGapSeconds) out.maxGapSeconds = out.minGapSeconds;
  if (out.globalConcurrency < 1) out.globalConcurrency = 1;
  return out;
}
async function setLimits(portal, values, user) {
  const key = portal ? K.portalLimits(portal) : K.limits;
  const cur = (await get(key));
  const next = { ...((cur && cur.value) || {}) };
  LIMIT_KEYS.forEach((k) => {
    if (values[k] === undefined) return;
    if (values[k] === null || values[k] === '') { delete next[k]; return; }
    const n = Number(values[k]);
    if (Number.isFinite(n) && n >= 0) next[k] = Math.floor(n);
  });
  await put(key, next, user);
  return limits(portal);
}

// ---- worker heartbeat ------------------------------------------------------------------
async function beat(info) { await put(K.heartbeat, { at: new Date().toISOString(), ...info }); }
async function workerState() {
  const r = await get(K.heartbeat);
  if (!r || !r.value) return { running: false, lastSeenAt: null };
  const at = ms(r.value.at);
  return { running: !!at && Date.now() - at < 30000, lastSeenAt: r.value.at, pid: r.value.pid || null, host: r.value.host || null, current: r.value.current || null };
}
async function selectorsDir() {
  if (process.env.TL_PORTAL_SELECTORS_DIR) return process.env.TL_PORTAL_SELECTORS_DIR;
  const r = await get(K.selectorsDir);
  return r && typeof r.value === 'string' ? r.value : null;
}


// ---- screenshot retention, selector status, last connection test ----------------------------------
const RETENTION_MIN = 1;
const RETENTION_MAX = 365;
async function retentionDays() {
  const r = await get(K.retention);
  const n = r && Number(r.value);
  return Number.isFinite(n) && n >= RETENTION_MIN ? Math.min(RETENTION_MAX, Math.floor(n)) : 30;
}
async function setRetentionDays(days, user) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < RETENTION_MIN || n > RETENTION_MAX) return { error: `Choose a number of days from ${RETENTION_MIN} to ${RETENTION_MAX}.` };
  await put(K.retention, n, user);
  return { days: n };
}
async function selectorStatus(portal) { const r = await get(K.selectorStatus(portal)); return r && r.value ? r.value : null; }
// report = [{ key, state, usedIndex, kind, used, main }] from one run; states of steps this run did not touch are kept.
async function recordSelectors(portal, report, meta = {}) {
  if (!Array.isArray(report) || !report.length) return null;
  const cur = (await selectorStatus(portal)) || { steps: {} };
  const steps = { ...(cur.steps || {}) };
  const at = new Date().toISOString();
  report.slice(0, 80).forEach((r) => { steps[r.key] = { state: r.state, usedIndex: r.usedIndex == null ? null : r.usedIndex, kind: r.kind || null, used: r.used || null, main: r.main || null, at }; });
  const next = { version: meta.version || null, verified: !!meta.verified, lastRunAt: at, steps };
  await put(K.selectorStatus(portal), next);
  return next;
}
async function clearSelectorStatus(portal) { await del(K.selectorStatus(portal)); }
async function lastTest(portal) { const r = await get(K.lastTest(portal)); return r && r.value ? r.value : null; }
async function setLastTest(portal, info) { await put(K.lastTest(portal), { at: new Date().toISOString(), ...info }); }

module.exports = {
  retentionDays, setRetentionDays, selectorStatus, recordSelectors, clearSelectorStatus, lastTest, setLastTest, LIMIT_KEYS,
  K, get, put, del, killState, setKill, setPause, humanHold, setHumanHold, clearHumanHold, limits, setLimits, beat, workerState, selectorsDir,
};
