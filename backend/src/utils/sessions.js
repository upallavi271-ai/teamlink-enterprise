// ---------------------------------------------------------------------------
// SIGNED-IN DEVICES, SIGN-OUT HISTORY AND THE IDLE TIMEOUT (founder 2026-11-17, "Security first": the audit's "active sessions,
// per-device logout, logout history, idle timeout" gaps).
//
//   * Every sign-in (routes/auth.js finishSignIn) opens one row in "UserSession" - its id rides in the token as `sid`: when,
//     from which IP, which browser/device, last seen.
//   * Profile -> Signed-in devices: each open one with "Sign out", plus "Sign out all other devices"; the last 30 days'
//     sign-ins with how each ended (signed out / signed out from another device / by an administrator / idle / expired).
//   * Administrators open the same list for any login (Users -> Devices) and sign a device out.
//   * IDLE TIMEOUT (AppSetting security.idleMinutes, 0 = off, set by Super Admin / Admin on Profile): the browser signs the
//     person out after that many minutes with no mouse / keyboard; the server also refuses a session not seen for that long.
//   A token signed before this existed carries no `sid` and keeps working until it expires (8 hours) - nobody is thrown out.
//
// Raw table, created on first use (no Prisma migration). The middleware check is cached for 20 s per session and
// last-seen is written at most once a minute, so it costs nothing on a normal request.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const TTL = 20000;
const TOUCH_MS = 60000;
const cache = new Map(); // sid -> { at, row }
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "UserSession" (
        "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "createdAt" TEXT NOT NULL, "lastSeenAt" TEXT NOT NULL,
        "ip" TEXT, "userAgent" TEXT, "endedAt" TEXT, "endedReason" TEXT, "endedBy" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "UserSession_user" ON "UserSession" ("userId", "createdAt")');
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

// "Chrome on Windows" from a user-agent - enough for a person to recognise their own device
function deviceOf(ua) {
  const s = String(ua || '');
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iPhone / iPad' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'unknown device';
  return `${browser} on ${os}`;
}

async function open({ userId, ip, userAgent }) {
  await ensure();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe('INSERT INTO "UserSession" ("id","userId","createdAt","lastSeenAt","ip","userAgent") VALUES (?,?,?,?,?,?)',
    id, String(userId), now, now, ip ? String(ip).slice(0, 64) : null, userAgent ? String(userAgent).slice(0, 300) : null);
  return id;
}
async function get(sid) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "UserSession" WHERE "id" = ?', String(sid));
  return rows[0] || null;
}

const IDLE_KEY = 'security.idleMinutes';
let idleCache = { at: 0, v: 0 };
async function idleMinutes() {
  if (Date.now() - idleCache.at < TTL) return idleCache.v;
  const row = await prisma.appSetting.findUnique({ where: { key: IDLE_KEY } }).catch(() => null);
  const v = Math.max(0, Math.min(720, Number(row && row.value) || 0));
  idleCache = { at: Date.now(), v };
  return v;
}
async function setIdleMinutes(n) {
  const v = Math.max(0, Math.min(720, Math.round(Number(n) || 0)));
  await prisma.appSetting.upsert({ where: { key: IDLE_KEY }, create: { key: IDLE_KEY, value: String(v) }, update: { value: String(v) } });
  idleCache = { at: 0, v: 0 };
  return v;
}

async function end(sid, reason, by = null) {
  await ensure();
  await prisma.$executeRawUnsafe('UPDATE "UserSession" SET "endedAt" = ?, "endedReason" = ?, "endedBy" = ? WHERE "id" = ? AND "endedAt" IS NULL',
    new Date().toISOString(), String(reason), by, String(sid));
  cache.delete(String(sid));
}
async function endAllOf(userId, reason, { except = null, by = null } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT "id" FROM "UserSession" WHERE "userId" = ? AND "endedAt" IS NULL', String(userId));
  const ids = rows.map((r) => r.id).filter((id) => id !== except);
  for (const id of ids) await end(id, reason, by); // eslint-disable-line no-await-in-loop
  return ids.length;
}

// middleware/auth.js: null = fine; else { code, error } and the request is refused
async function checkClaims(claims) {
  if (!claims || !claims.sid || claims.viewAs || claims.actAs) return null;
  const sid = String(claims.sid);
  let c = cache.get(sid);
  if (!c || Date.now() - c.at > TTL) { c = { at: Date.now(), row: await get(sid) }; cache.set(sid, c); if (cache.size > 5000) cache.clear(); }
  const row = c.row;
  if (!row) return null; // a row lost to a restore: do not lock people out for it
  if (row.endedAt) {
    return {
      code: 'SESSION_ENDED',
      error: row.endedReason === 'admin' ? 'An administrator signed this device out. Please sign in again.'
        : row.endedReason === 'idle' ? 'You were signed out after a time with no activity. Please sign in again.'
          : 'This device was signed out. Please sign in again.',
    };
  }
  const idle = await idleMinutes();
  const seen = new Date(row.lastSeenAt).getTime();
  if (idle > 0 && Date.now() - seen > idle * 60000) {
    await end(sid, 'idle');
    return { code: 'SESSION_IDLE', error: 'You were signed out after a time with no activity. Please sign in again.' };
  }
  if (Date.now() - seen > TOUCH_MS) {
    const now = new Date().toISOString();
    row.lastSeenAt = now;
    prisma.$executeRawUnsafe('UPDATE "UserSession" SET "lastSeenAt" = ? WHERE "id" = ?', now, sid).catch(() => {});
  }
  return null;
}

// the list a person (or an admin) sees: open devices first, then the last 30 days
async function listOf(userId, currentSid = null) {
  await ensure();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "UserSession" WHERE "userId" = ? AND ("endedAt" IS NULL OR "createdAt" >= ?) ORDER BY "createdAt" DESC LIMIT 200', String(userId), since);
  const now = Date.now();
  return rows.map((r) => {
    // a session nobody ended whose 8-hour token has run out is "expired", not open
    const expired = !r.endedAt && now - new Date(r.createdAt).getTime() > 8 * 3600000;
    return {
      id: r.id, device: deviceOf(r.userAgent), ip: r.ip, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt,
      open: !r.endedAt && !expired, current: r.id === currentSid, endedAt: r.endedAt || (expired ? null : null),
      ended: r.endedAt ? r.endedReason : (expired ? 'expired' : null),
    };
  });
}

module.exports = {
  ensure, open, get, end, endAllOf, checkClaims, listOf, deviceOf, idleMinutes, setIdleMinutes,
};
