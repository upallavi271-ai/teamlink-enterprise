// ---------------------------------------------------------------------------
// ANDROID PHONE LINK (founder 2026-11-24: "manual calling through the Android phone with the SIM 9032321414").
//
// Microsoft Phone Link has no public API, and Bluetooth pairing alone cannot start a call from a web page. So the phone runs OUR small
// companion app ("TeamLink Phone", android-phone-app/ in this repo) that:
//   1. pairs ONCE with a 6-digit code an Admin makes here (valid 10 minutes, one use) and gets its own device key (only its SHA-256 is stored);
//   2. keeps asking this server "anything for me?" (a long poll: GET /api/phone-link/device/poll, held up to 25 s) - that is also its heartbeat;
//   3. when a recruiter presses Call in TeamLink, the server checks the recruiter may call that candidate (the same rules as every manual call)
//      and queues the call for the phone; the app dials it from the phone's own SIM (Android ACTION_CALL) and reports what really happened.
//
// What Android tells an app about ITS OWN outgoing GSM call: "dialing started" (OFFHOOK) and "ended" (IDLE), plus, after the end, the phone's
// call log with the real talk time. It does NOT say "ringing" or "answered" for an outgoing call. So TeamLink never claims those live:
//   requested  -> the server queued it (Call Initiated)
//   initiated  -> the phone took it (Sent to phone)
//   calling    -> the phone is dialling / on the call (OFFHOOK)
//   completed  -> ended with talk time > 0 from the phone's call log (Call Completed - it was connected)
//   missed     -> ended with 0 talk time (Not Answered / Busy - Android cannot tell those two apart)
//   failed     -> the phone could not dial (no SIM, no permission, phone offline / did not take it in time)
//   cancelled  -> the recruiter cancelled before the phone dialled
// No recording (no RECORD_AUDIO permission in the app; Android 10+ blocks call recording anyway). No auto-dial: one call per Call press.
//
// TALK IN TEAMLINK ("bridge", founder 2026-11-24: "ring, talk, both sides - everything in the ATS, like the Synway; only the number is the phone's").
// Android never lets an app carry a GSM call's voice over the internet, so the phone joins two GSM calls instead:
//   1. the recruiter's browser calls the PHONE on the office Synway line (an ordinary browser call: recorded, transcribed, timed by Asterisk);
//   2. the app (set as the phone's default Phone app, so no dialer screen rings) answers that call by itself - only while TeamLink armed it;
//   3. it dials the candidate from its own SIM (the candidate sees the phone's number) and, when the candidate answers, merges the two calls
//      (an operator conference). The phone's own microphone is muted; the recruiter and the candidate talk through the browser.
//   Either side hanging up ends both. Two calls are billed (office SIM -> phone, phone -> candidate). Needs the operator's conference call.
//   The candidate's real talk time comes from the phone (bridgeTalkSec); the browser leg's times come from Asterisk as for every call.
// The call rows are ordinary BrowserCall rows (direction 'phone', lineId 'phone:<device id>'), so the candidate's call history, the reports and
// the scope rules already cover them. Tables are self-provisioned (raw SQL, CREATE TABLE IF NOT EXISTS). ADDITIVE ONLY.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('./schema');

const PREFIX = 'phone:';
const ONLINE_MS = 40000; // a poll at least every 25 s + network slack
const AWAY_MS = 120000; // after this the phone is "Device unavailable"
const PICK_MS = 30000; // a queued call the phone did not take within 30 s fails ("phone offline")
const CODE_MS = 10 * 60000;
const LIVE = ['requested', 'initiated', 'calling'];
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const oneLine = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(); // eslint-disable-line no-control-regex

const DDL = [
  `CREATE TABLE IF NOT EXISTS "PhoneLinkDevice" (
    "id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "number" TEXT NOT NULL, "userIds" TEXT, "tokenHash" TEXT NOT NULL,
    "model" TEXT, "appVersion" TEXT, "paused" INTEGER NOT NULL DEFAULT 0, "reconnectAt" TEXT, "lastSeenAt" TEXT, "lastState" TEXT,
    "pairedById" TEXT, "pairedAt" TEXT NOT NULL, "revokedAt" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "PhoneLinkDevice_token" ON "PhoneLinkDevice"("tokenHash")',
  `CREATE TABLE IF NOT EXISTS "PhoneLinkPairCode" (
    "codeHash" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "number" TEXT NOT NULL, "userIds" TEXT, "createdById" TEXT,
    "expiresAt" TEXT NOT NULL, "createdAt" TEXT NOT NULL)`,
];
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await S.ensure();
      for (const s of DDL) await S.run(s); // eslint-disable-line no-await-in-loop
      try { await S.run('ALTER TABLE "PhoneLinkDevice" ADD COLUMN "bridge" INTEGER NOT NULL DEFAULT 0'); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
async function all(sql, ...p) { await ensure(); return S.all(sql, ...p); }
async function one(sql, ...p) { return (await all(sql, ...p))[0] || null; }
async function run(sql, ...p) { await ensure(); return S.run(sql, ...p); }

const ids = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
const ago = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);

/** Connected / Reconnecting / Disconnected / Device unavailable - from the last poll, the app's own state and the ATS switch. */
function statusOf(d) {
  if (!d || d.revokedAt) return { code: 'disconnected', word: 'Disconnected', why: 'Not paired.' };
  if (d.paused) return { code: 'disconnected', word: 'Disconnected', why: 'Disconnected from TeamLink (press Connect to take calls again).' };
  let st = {}; try { st = JSON.parse(d.lastState || '{}'); } catch { st = {}; }
  const a = ago(d.lastSeenAt);
  if (a <= ONLINE_MS) {
    if (st.appPaused) return { code: 'disconnected', word: 'Disconnected', why: 'Switched off in the phone app.' };
    if (st.missing && st.missing.length) return { code: 'unavailable', word: 'Device unavailable', why: `The phone app is missing a permission: ${st.missing.join(', ')}.` };
    if (st.simReady === false) return { code: 'unavailable', word: 'Device unavailable', why: 'The phone has no working SIM right now.' };
    return { code: 'connected', word: 'Connected', why: null };
  }
  if (a <= AWAY_MS || (d.reconnectAt && ago(d.reconnectAt) < AWAY_MS)) return { code: 'reconnecting', word: 'Reconnecting', why: 'The phone stopped answering a moment ago; it reconnects by itself.' };
  return { code: 'unavailable', word: 'Device unavailable', why: d.lastSeenAt ? 'The phone has not been in touch for a while (switched off, no internet, or the app was closed).' : 'The phone has not connected yet: open the TeamLink Phone app.' };
}
function shape(d, extra = {}) {
  const s = statusOf(d);
  let st = {}; try { st = JSON.parse(d.lastState || '{}'); } catch { st = {}; }
  return {
    id: d.id, lineId: `${PREFIX}${d.id}`, name: d.name, number: d.number, userIds: ids(d.userIds), model: d.model || null, appVersion: d.appVersion || null,
    paused: !!d.paused, lastSeenAt: d.lastSeenAt || null, status: s.code, statusWord: s.word, statusWhy: s.why, battery: st.battery == null ? null : st.battery,
    pairedAt: d.pairedAt, bridge: !!d.bridge, ...extra,
  };
}

// ---------------------------------------------------------------------------- Admin: pairing codes and devices
async function validNumber(v) {
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const n = core.normalizeMobile(v);
  if (!n.ok || n.cc !== '91') return null;
  return n.national;
}
/** May this person be given the phone: an active ATS login of a role that calls candidates (never BDE / BDE TL / Manager view-only). */
async function mayUse(userId) {
  const { resolveIdentity } = require('../utils/identity'); // eslint-disable-line global-require
  const access = require('../outreach/access'); // eslint-disable-line global-require
  let u = null;
  try { u = await resolveIdentity(userId); } catch { u = null; }
  if (!u || (u.status && u.status !== 'Active')) return { error: 'That person was not found (or is not active).' };
  const k = access.kind(u);
  if (!['admin', 'tl', 'recruiter', 'hr'].includes(k)) return { error: `${u.name || 'This person'} cannot use the phone: BDEs, BDE team leads and Managers (view only) never call candidates from TeamLink.` };
  return { user: u };
}
async function cleanUserIds(list) {
  const out = [];
  for (const id of (Array.isArray(list) ? list : []).map((x) => clip(x, 60)).filter(Boolean).slice(0, 50)) { // eslint-disable-line no-restricted-syntax
    const m = await mayUse(id); // eslint-disable-line no-await-in-loop
    if (m.error) return { error: m.error };
    if (!out.includes(id)) out.push(id);
  }
  return { ids: out };
}
async function makePairCode(admin, b) {
  const name = oneLine(b && b.name).slice(0, 60) || 'Android phone';
  const number = await validNumber(b && b.number);
  if (!number) return { status: 400, error: "Type the phone's 10-digit SIM number (like 9032321414)." };
  const u = await cleanUserIds(b && b.userIds);
  if (u.error) return { status: 400, error: u.error };
  await run('DELETE FROM "PhoneLinkPairCode" WHERE "expiresAt"<?', S.nowIso());
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + CODE_MS).toISOString();
  await run('INSERT INTO "PhoneLinkPairCode" ("codeHash","name","number","userIds","createdById","expiresAt","createdAt") VALUES (?,?,?,?,?,?,?)', sha(code), name, number, JSON.stringify(u.ids), admin.id, expiresAt, S.nowIso());
  return { code, expiresAt, name, number };
}
async function devices() { return all('SELECT * FROM "PhoneLinkDevice" WHERE "revokedAt" IS NULL ORDER BY "pairedAt"'); }
async function byId(id) { return one('SELECT * FROM "PhoneLinkDevice" WHERE "id"=? AND "revokedAt" IS NULL', clip(id, 60)); }
async function update(id, b) {
  const d = await byId(id);
  if (!d) return { status: 404, error: 'That phone is not paired.' };
  const name = b.name !== undefined ? (oneLine(b.name).slice(0, 60) || d.name) : d.name;
  let userIds = d.userIds;
  if (b.userIds !== undefined) { const u = await cleanUserIds(b.userIds); if (u.error) return { status: 400, error: u.error }; userIds = JSON.stringify(u.ids); }
  const bridge = b.bridge !== undefined ? (b.bridge ? 1 : 0) : (d.bridge ? 1 : 0);
  await run('UPDATE "PhoneLinkDevice" SET "name"=?, "userIds"=?, "bridge"=?, "updatedAt"=? WHERE "id"=?', name, userIds, bridge, S.nowIso(), d.id);
  return { device: await byId(d.id), before: d };
}
async function unpair(id) {
  const d = await byId(id);
  if (!d) return { status: 404, error: 'That phone is not paired.' };
  await run('UPDATE "PhoneLinkDevice" SET "revokedAt"=?, "tokenHash"=?, "updatedAt"=? WHERE "id"=?', S.nowIso(), `revoked:${d.id}`, S.nowIso(), d.id);
  await failOpen(d.id, 'The phone was unpaired.');
  return { device: d };
}

// ---------------------------------------------------------------------------- the phone app
const tries = new Map(); // wrong codes per address: 10 per 10 minutes
async function pair(b, ip) {
  const key = clip(ip || 'x', 60); const now = Date.now();
  const t = (tries.get(key) || []).filter((x) => now - x < CODE_MS);
  if (t.length >= 10) return { status: 429, error: 'Too many wrong codes. Wait 10 minutes and ask the Admin for a new code.' };
  const code = String((b && b.code) || '').replace(/\D/g, '');
  const row = code.length === 6 ? await one('SELECT * FROM "PhoneLinkPairCode" WHERE "codeHash"=? AND "expiresAt">?', sha(code), S.nowIso()) : null;
  if (!row) { t.push(now); tries.set(key, t); return { status: 400, error: 'That code is wrong or has expired. Ask the Admin for a new one.' }; }
  // claim the code atomically: several taps on Pair at once must give ONE phone, not one each (seen live 2026-11-24: 6 rows)
  const claimed = await run('DELETE FROM "PhoneLinkPairCode" WHERE "codeHash"=?', row.codeHash);
  if (Number(claimed) !== 1) return { status: 409, error: 'This code was just used. If the phone shows Paired, you are done; otherwise ask the Admin for a new code.' };
  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomUUID(); const ts = S.nowIso();
  await run('INSERT INTO "PhoneLinkDevice" ("id","name","number","userIds","tokenHash","model","appVersion","paused","lastSeenAt","pairedById","pairedAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)',
    id, row.name, row.number, row.userIds, sha(token), oneLine(b && b.model).slice(0, 80) || null, oneLine(b && b.appVersion).slice(0, 20) || null, ts, row.createdById, ts, ts, ts);
  return { token, device: await byId(id) };
}
async function deviceByToken(token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  return one('SELECT * FROM "PhoneLinkDevice" WHERE "tokenHash"=? AND "revokedAt" IS NULL', sha(t));
}
async function touch(d, state) {
  const st = {};
  if (state && typeof state === 'object') {
    if (state.battery != null && Number.isFinite(Number(state.battery))) st.battery = Math.max(0, Math.min(100, Math.round(Number(state.battery))));
    if (state.simReady !== undefined) st.simReady = !!state.simReady;
    if (state.appPaused !== undefined) st.appPaused = !!state.appPaused;
    if (Array.isArray(state.missing)) st.missing = state.missing.map((x) => oneLine(x).slice(0, 40)).filter(Boolean).slice(0, 6);
    if (state.appVersion) st.appVersion = oneLine(state.appVersion).slice(0, 20);
  }
  let old = {}; try { old = JSON.parse(d.lastState || '{}'); } catch { old = {}; }
  await run('UPDATE "PhoneLinkDevice" SET "lastSeenAt"=?, "lastState"=?, "appVersion"=COALESCE(?, "appVersion"), "reconnectAt"=NULL, "updatedAt"=? WHERE "id"=?', S.nowIso(), JSON.stringify({ ...old, ...st }), st.appVersion || null, S.nowIso(), d.id);
}

// waiting polls, so a queued call reaches the phone at once (one server process; the poll also reads the table, so nothing is lost without it)
const waiters = new Map();
function wake(deviceId) { const w = waiters.get(deviceId); if (w) { waiters.delete(deviceId); w(); } }

/** Calls the phone took too long to take, or that stayed open far too long, end plainly. */
async function expire() {
  const now = S.nowIso();
  await run('UPDATE "BrowserCall" SET "status"=\'failed\', "endAt"=?, "durationSec"=0, "talkSec"=0, "hangupReason"=\'The phone did not take the call in time (offline, no internet, or the app was closed).\', "updatedAt"=? WHERE "direction"=\'phone\' AND "status"=\'requested\' AND "startAt"<?', now, now, new Date(Date.now() - PICK_MS).toISOString());
  await run('UPDATE "BrowserCall" SET "status"=\'failed\', "endAt"=?, "hangupReason"=\'The phone took the call but never said it dialled.\', "updatedAt"=? WHERE "direction"=\'phone\' AND "status"=\'initiated\' AND "startAt"<?', now, now, new Date(Date.now() - 90000).toISOString());
  await run('UPDATE "BrowserCall" SET "status"=\'failed\', "endAt"=?, "hangupReason"=\'Closed: the phone never said the call ended.\', "updatedAt"=? WHERE "direction"=\'phone\' AND "status"=\'calling\' AND "startAt"<?', now, now, new Date(Date.now() - 3 * 3600000).toISOString());
}
async function expireBridges() {
  const now = S.nowIso();
  await run(`UPDATE "BrowserCall" SET "bridgeStatus"='failed', "bridgeNote"=?, "updatedAt"=? WHERE "bridgeStatus" IN ('arming','armed') AND "startAt"<?`,
    "The phone did not answer the office line call in time (offline, or TeamLink Phone is not the phone's Phone app).", now, new Date(Date.now() - 75000).toISOString());
  await run(`UPDATE "BrowserCall" SET "bridgeStatus"='ended', "updatedAt"=? WHERE "bridgeStatus" IN ('answered','dialing','connected','merged') AND "status" IN ('completed','failed','missed','busy','cancelled') AND "updatedAt"<?`, now, new Date(Date.now() - 120000).toISOString());
}
/** Is the phone busy with a bridge call (one call at a time on one SIM)? */
async function bridgeBusy(deviceId) {
  return one(`SELECT "id","userName" FROM "BrowserCall" WHERE "bridgeDeviceId"=? AND "bridgeStatus" IN ('arming','armed','answered','dialing','connected','merged') AND "status" NOT IN ('completed','failed','missed','busy','cancelled') AND "startAt">?`, deviceId, new Date(Date.now() - 3 * 3600000).toISOString());
}
/** The browser call row of a bridge exists (routes/browserCalling.js place()); mark it as a bridge and tell the phone to expect it. */
async function armBridge(rowId, d, candidateNumber, lineName) {
  await run(`UPDATE "BrowserCall" SET "toNumber"=?, "lineName"=?, "bridgeDeviceId"=?, "bridgeStatus"='arming', "updatedAt"=? WHERE "id"=?`, candidateNumber, lineName, d.id, S.nowIso(), rowId);
  wake(d.id);
}
/** May this bridge go now: the phone is connected, set to bridge, and free. */
async function bridgeReady(d) {
  const st = statusOf(d);
  if (st.code !== 'connected') return { status: 409, error: `The phone ${d.number} is ${st.word.toLowerCase()}: ${st.why || ''}`.trim(), code: `PHONE_${st.code.toUpperCase()}` };
  if (!d.bridge) return { status: 409, error: 'This phone is not set to "Talk in TeamLink". An Admin switches it on in Android phones.', code: 'NOT_BRIDGE' };
  await expireBridges();
  const b = (await bridgeBusy(d.id)) || (await one(`SELECT "id","userName" FROM "BrowserCall" WHERE "lineId"=? AND "status" IN ('requested','initiated','calling')`, `${PREFIX}${d.id}`));
  if (b) return { status: 409, error: `The phone ${d.number} is on another call${b.userName ? ` (${b.userName})` : ''}. Try again when it ends.`, code: 'PHONE_BUSY' };
  return { ok: true };
}

async function failOpen(deviceId, why) {
  const now = S.nowIso();
  await run(`UPDATE "BrowserCall" SET "status"='failed', "endAt"=?, "hangupReason"=?, "updatedAt"=? WHERE "lineId"=? AND "status" IN ('requested','initiated')`, now, why, now, `${PREFIX}${deviceId}`);
}

/** What the phone should do now: dial a queued call, hang one up, reconnect, or nothing. */
async function nextFor(d) {
  await expire();
  const hang = await all(`SELECT "id" FROM "BrowserCall" WHERE "lineId"=? AND "status"='calling' AND "hangupReason"='hangup-requested'`, `${PREFIX}${d.id}`);
  if (hang.length) return { hangup: hang.map((h) => h.id) };
  if (d.paused) return {};
  await expireBridges();
  const br = await one(`SELECT * FROM "BrowserCall" WHERE "bridgeDeviceId"=? AND "bridgeStatus"='arming' ORDER BY "startAt" LIMIT 1`, d.id);
  if (br) {
    const took = await S.run(`UPDATE "BrowserCall" SET "bridgeStatus"='armed', "updatedAt"=? WHERE "id"=? AND "bridgeStatus"='arming'`, S.nowIso(), br.id);
    if (took) return { bridge: { id: br.id, number: br.toNumber, name: firstName(br.userName), answerWithinSec: 60 } };
  }
  const q = await one(`SELECT * FROM "BrowserCall" WHERE "lineId"=? AND "status"='requested' ORDER BY "startAt" LIMIT 1`, `${PREFIX}${d.id}`);
  if (!q) return {};
  const took = await S.run(`UPDATE "BrowserCall" SET "status"='initiated', "updatedAt"=? WHERE "id"=? AND "status"='requested'`, S.nowIso(), q.id);
  if (!took) return {};
  return { call: { id: q.id, number: q.toNumber, name: firstName(q.userName) } };
}
const firstName = (n) => (oneLine(n).split(' ')[0] || '').slice(0, 30); // who asked for the call (the recruiter), never the candidate's name

async function poll(d, waitMs, state) {
  await touch(d, state);
  const fresh = await byId(d.id);
  let out = await nextFor(fresh);
  if (out.call || out.hangup || !waitMs) return out;
  await new Promise((resolve) => {
    const t = setTimeout(() => { waiters.delete(d.id); resolve(); }, waitMs);
    if (t.unref) t.unref();
    const prev = waiters.get(d.id); if (prev) prev();
    waiters.set(d.id, () => { clearTimeout(t); resolve(); });
  });
  const again = await byId(d.id);
  if (!again) return { unpaired: true };
  await touch(again, null);
  out = await nextFor(again);
  if (again.reconnectAt) out.reconnect = true;
  return out;
}

const BRIDGE_EVENTS = ['bridge-answered', 'candidate-answered', 'merged'];
const PHONE_EVENTS = ['dialing', 'ended', 'failed', ...BRIDGE_EVENTS];
const BRIDGE_NEXT = { 'bridge-answered': ['answered', ['armed', 'arming']], dialing: ['dialing', ['answered', 'armed']], 'candidate-answered': ['connected', ['dialing', 'answered']], merged: ['merged', ['connected', 'dialing', 'answered']] };
/** What the phone says about a bridge: only the bridge fields change; the browser leg's own status stays Asterisk's. */
async function bridgeEvent(d, r, ev, b) {
  await touch(d, b && b.state);
  const now = S.nowIso();
  if (BRIDGE_NEXT[ev]) {
    const [to, from] = BRIDGE_NEXT[ev];
    await run(`UPDATE "BrowserCall" SET "bridgeStatus"=?, "updatedAt"=? WHERE "id"=? AND "bridgeStatus" IN (${from.map(() => '?').join(',')})`, to, now, r.id, ...from);
  } else if (ev === 'failed') {
    const why = oneLine(b && b.reason).slice(0, 200) || 'The phone could not connect the candidate.';
    await run(`UPDATE "BrowserCall" SET "bridgeStatus"='failed', "bridgeNote"=?, "updatedAt"=? WHERE "id"=? AND "bridgeStatus" NOT IN ('ended','failed')`, `Phone: ${why}`, now, r.id);
  } else if (ev === 'ended') {
    const max = Math.max(0, Math.round((Date.now() - Date.parse(r.startAt)) / 1000));
    let talk = Math.round(Number(b && b.durationSec));
    talk = Number.isFinite(talk) && talk > 0 ? Math.min(talk, max) : 0;
    const note = talk > 0 ? null : (r.bridgeStatus === 'dialing' || r.bridgeStatus === 'answered' ? 'The candidate did not answer / was busy.' : null);
    await run(`UPDATE "BrowserCall" SET "bridgeStatus"='ended', "bridgeTalkSec"=?, "bridgeNote"=COALESCE("bridgeNote", ?), "updatedAt"=? WHERE "id"=? AND "bridgeStatus" NOT IN ('ended','failed')`, talk, note, now, r.id);
  }
  return { call: await one('SELECT * FROM "BrowserCall" WHERE "id"=?', r.id) };
}
/** The phone says what happened to a call it took. */
async function event(d, b) {
  const ev = String((b && b.event) || '');
  if (!PHONE_EVENTS.includes(ev)) return { status: 400, error: `event must be one of ${PHONE_EVENTS.join(', ')}` };
  const br = BRIDGE_EVENTS.includes(ev) || (b && b.bridge) ? await one('SELECT * FROM "BrowserCall" WHERE "id"=? AND "bridgeDeviceId"=?', clip(b && b.callId, 60), d.id) : null;
  if (br) return bridgeEvent(d, br, ev, b);
  const r = await one('SELECT * FROM "BrowserCall" WHERE "id"=? AND "lineId"=?', clip(b && b.callId, 60), `${PREFIX}${d.id}`);
  if (!r) return { status: 404, error: 'Call not found for this phone.' };
  const now = S.nowIso();
  await touch(d, b && b.state);
  if (ev === 'dialing') {
    await run(`UPDATE "BrowserCall" SET "status"='calling', "updatedAt"=? WHERE "id"=? AND "status" IN ('requested','initiated')`, now, r.id);
  } else if (ev === 'failed') {
    const why = oneLine(b && b.reason).slice(0, 200) || 'The phone could not dial.';
    await run(`UPDATE "BrowserCall" SET "status"='failed', "endAt"=?, "durationSec"=0, "talkSec"=0, "hangupReason"=?, "updatedAt"=? WHERE "id"=? AND "status" IN ('requested','initiated','calling')`, now, `Phone: ${why}`, now, r.id);
  } else {
    // ended: the talk time comes from the phone's own call log (0 = never connected). Never more than the time since we queued it.
    const max = Math.max(0, Math.round((Date.now() - Date.parse(r.startAt)) / 1000));
    let talk = Math.round(Number(b && b.durationSec));
    talk = Number.isFinite(talk) && talk > 0 ? Math.min(talk, max) : 0;
    const known = b && b.fromCallLog !== false;
    const status = talk > 0 ? 'completed' : 'missed';
    const why = talk > 0 ? null : (known ? 'Not answered / busy (the phone log shows no talk time)' : 'Ended; the phone could not read its call log, so talk time is unknown');
    await run(`UPDATE "BrowserCall" SET "status"=?, "endAt"=?, "answerAt"=?, "talkSec"=?, "durationSec"=?, "hangupReason"=?, "updatedAt"=? WHERE "id"=? AND "status" IN ('requested','initiated','calling')`,
      status, now, talk > 0 ? new Date(Date.now() - talk * 1000).toISOString() : null, talk, max, why, now, r.id);
  }
  return { call: await one('SELECT * FROM "BrowserCall" WHERE "id"=?', r.id) };
}

// ---------------------------------------------------------------------------- recruiters (the ATS side)
async function usableBy(user, isAdmin) {
  await expire();
  const list = await devices();
  return list.filter((d) => isAdmin || ids(d.userIds).includes(user.id));
}
/** A call on the phone: the number comes from the candidate record (the route checks scope); one call at a time per phone and per person. */
async function queueCall(user, d, { candidateId, applicationId, number, mode }) {
  const st = statusOf(d);
  if (st.code !== 'connected') return { status: 409, error: `The phone ${d.number} is ${st.word.toLowerCase()}: ${st.why || ''}`.trim(), code: 'PHONE_' + st.code.toUpperCase() };
  const busyPhone = (await one(`SELECT "id","userName" FROM "BrowserCall" WHERE "lineId"=? AND "status" IN ('requested','initiated','calling')`, `${PREFIX}${d.id}`)) || (await bridgeBusy(d.id));
  if (busyPhone) return { status: 409, error: `The phone ${d.number} is on another call${busyPhone.userName ? ` (${busyPhone.userName})` : ''}. Try again when it ends.`, code: 'PHONE_BUSY' };
  const mine = await one(`SELECT "id" FROM "BrowserCall" WHERE "userId"=? AND "direction"='phone' AND "status" IN ('requested','initiated','calling')`, user.id);
  if (mine) return { status: 409, error: 'You already have a phone call in progress.' };
  const id = crypto.randomUUID(); const token = crypto.randomBytes(12).toString('hex'); const now = S.nowIso();
  await run('INSERT INTO "BrowserCall" ("id","token","candidateId","applicationId","userId","userName","toNumber","extension","direction","mode","status","startAt","createdAt","updatedAt","lineId","lineName","recordingStatus","recordingNote","processedAt") VALUES (?,?,?,?,?,?,?,?,\'phone\',?,\'requested\',?,?,?,?,?,\'none\',?,?)',
    id, token, candidateId, applicationId || null, user.id, clip(user.name, 80), number, clip(`phone:${d.number}`, 60), mode || null, now, now, now, `${PREFIX}${d.id}`, `Mobile ${d.number}`, 'Not recorded (call on the Android phone)', now);
  wake(d.id);
  return { id, device: d };
}
async function hangup(user, isAdmin, callId) {
  const r = await one('SELECT * FROM "BrowserCall" WHERE "id"=? AND "direction"=\'phone\'', clip(callId, 60));
  if (!r || (r.userId !== user.id && !isAdmin)) return { status: 404, error: 'Call not found.' };
  const now = S.nowIso();
  if (['requested', 'initiated'].includes(r.status)) {
    await run(`UPDATE "BrowserCall" SET "status"='cancelled', "endAt"=?, "durationSec"=0, "talkSec"=0, "hangupReason"='Cancelled in TeamLink before the phone dialled', "updatedAt"=? WHERE "id"=?`, now, now, r.id);
  } else if (r.status === 'calling') {
    await run(`UPDATE "BrowserCall" SET "hangupReason"='hangup-requested', "updatedAt"=? WHERE "id"=?`, now, r.id);
  }
  wake(String(r.lineId || '').slice(PREFIX.length));
  return { call: await one('SELECT * FROM "BrowserCall" WHERE "id"=?', r.id) };
}
/** Connect / Disconnect / Reconnect from the ATS (people the phone is given to, or an Admin). */
async function setLink(user, isAdmin, id, action) {
  const d = await byId(id);
  if (!d || (!isAdmin && !ids(d.userIds).includes(user.id))) return { status: 404, error: 'That phone is not yours to use.' };
  if (!['connect', 'disconnect', 'reconnect'].includes(action)) return { status: 400, error: 'Unknown action.' };
  if (action === 'disconnect') { await run('UPDATE "PhoneLinkDevice" SET "paused"=1, "updatedAt"=? WHERE "id"=?', S.nowIso(), d.id); await failOpen(d.id, 'The phone was disconnected in TeamLink.'); }
  if (action === 'connect') await run('UPDATE "PhoneLinkDevice" SET "paused"=0, "updatedAt"=? WHERE "id"=?', S.nowIso(), d.id);
  if (action === 'reconnect') await run('UPDATE "PhoneLinkDevice" SET "paused"=0, "reconnectAt"=?, "updatedAt"=? WHERE "id"=?', S.nowIso(), S.nowIso(), d.id);
  wake(d.id);
  return { device: await byId(d.id) };
}

// after the call: what the recruiter writes down (and a follow-up on the application when a date is given)
const NEXT = ['Call again', 'Send details on WhatsApp', 'Schedule interview', 'Share with client', 'Not interested', 'Wrong number', 'Other'];
const OUTCOME = { Connected: 'completed', 'Not Answered': 'missed', Busy: 'busy', 'Call Failed': 'failed' };
async function saveOutcome(user, isAdmin, callId, b) {
  const r = await one('SELECT * FROM "BrowserCall" WHERE "id"=? AND "direction"=\'phone\'', clip(callId, 60));
  if (!r || (r.userId !== user.id && !isAdmin)) return { status: 404, error: 'Call not found.' };
  if (LIVE.includes(r.status)) return { status: 409, error: 'The call is still going on. Save after it ends.' };
  const remarks = oneLine(b && b.remarks).slice(0, 500);
  const nextAction = b && b.nextAction ? oneLine(b.nextAction).slice(0, 60) : '';
  if (nextAction && !NEXT.includes(nextAction)) return { status: 400, error: `Pick the next action from the list: ${NEXT.join(', ')}.` };
  const fu = String((b && b.followUpDate) || '').trim();
  if (fu && !/^\d{4}-\d{2}-\d{2}$/.test(fu)) return { status: 400, error: 'The follow-up date must be a date (YYYY-MM-DD).' };
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  if (fu && fu < today) return { status: 400, error: 'The follow-up date cannot be in the past.' };
  const pick = b && b.outcome ? String(b.outcome) : '';
  if (pick && !OUTCOME[pick]) return { status: 400, error: `Pick the call status: ${Object.keys(OUTCOME).join(', ')}.` };
  // the recruiter's word on a call the phone reported: kept beside the phone's own result, never replacing the talk time
  const status = pick && r.status !== 'completed' && OUTCOME[pick] !== 'completed' ? OUTCOME[pick] : r.status;
  await run('UPDATE "BrowserCall" SET "status"=?, "remarks"=?, "nextAction"=?, "followUpAt"=?, "outcome"=?, "updatedAt"=? WHERE "id"=?', status, remarks || null, nextAction || null, fu || null, pick || null, S.nowIso(), r.id);
  let followUp = null;
  if (fu && r.applicationId) {
    const prisma = require('../db'); // eslint-disable-line global-require
    const app = await prisma.application.findUnique({ where: { id: r.applicationId }, select: { id: true, candidateId: true, requirementId: true } }).catch(() => null);
    if (app) {
      const made = await prisma.applicationFollowUp.create({ data: {
        applicationId: app.id, candidateId: app.candidateId, requirementId: app.requirementId, ownerUserId: user.id, ownerName: user.name, ownerRole: 'Recruiter',
        nextAction: nextAction || 'Call again', purpose: 'Phone call', dueDate: fu, dueTime: '10:00', notes: remarks || `After a call on ${r.lineName || 'the Android phone'}.`,
        autoCreated: false, createdById: user.id, createdByName: user.name,
      } }).catch((e) => { console.error('[phone-link] follow-up:', clip(e.message, 160)); return null; });
      followUp = made ? { id: made.id, dueDate: fu } : null;
    }
  }
  return { call: await one('SELECT * FROM "BrowserCall" WHERE "id"=?', r.id), followUp, followUpSkipped: fu && !followUp ? 'No follow-up was added: this call is not linked to an application (open the candidate from a requirement to link it).' : null };
}

module.exports = {
  PREFIX, NEXT, OUTCOME: Object.keys(OUTCOME), LIVE, ensure, statusOf, shape, ids,
  makePairCode, devices, byId, update, unpair, pair, deviceByToken, poll, event, touch,
  usableBy, queueCall, hangup, setLink, saveOutcome, expire, mayUse, _waiters: waiters,
  armBridge, bridgeReady, bridgeBusy, expireBridges, BRIDGE_EVENTS,
};
