// ---------------------------------------------------------------------------
// SIGN-IN SESSIONS (2026-10-09) — server-side sign-out and the inactivity
// timeout that HRMS and the Job Portal share.
//
// The JWT used to be the whole session: eight hours, no way to end it early,
// no idea whether anybody was still there. Each sign-in now has an AuthSession
// row and the token carries its id as `sid`. middleware/auth.js checks it on
// every request:
//
//   revoked (Sign Out here, Sign Out in the Job Portal)        -> 401
//   lastSeenAt older than SESSION_IDLE_MINUTES (default 30)   -> 401, revoked
//
// ACTIVITY IS WHAT THE USER DID, NOT WHAT THE PAGE POLLED. Several screens
// refresh themselves every minute (tasks, alerts, the AI status dot); counting
// those would keep a session alive forever on an unattended screen. The
// browser sends `x-tl-idle-ms` — milliseconds since the person last touched
// the page — and activity is `now - idle`. A request without the header (an
// old tab, a script) counts as activity, which is what it always was.
//
// The Job Portal is the other half of the same session: routes/sso.js lets it
// ask "is <sid> alive?" (passing the user's last activity there) and lets it
// end <sid> when the user signs out of the portal.
//
// A token WITHOUT a sid (issued before this existed) keeps working until its
// own eight-hour expiry; it simply has no idle timeout and cannot open the
// Job Portal.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const idleMs = () => Math.max(1, parseInt(process.env.SESSION_IDLE_MINUTES, 10) || 30) * 60000;
// lastSeenAt is written at most this often per session.
const TOUCH_EVERY_MS = 15000;

function newSid() { return crypto.randomUUID(); }

async function create(userId) {
  const id = newSid();
  await prisma.authSession.create({ data: { id, userId } });
  return id;
}

/** When the user last touched the page, from the x-tl-idle-ms header. */
function activityAt(req, now = Date.now()) {
  const raw = req && req.headers ? req.headers['x-tl-idle-ms'] : undefined;
  if (raw === undefined || raw === '') return now;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) return now;
  return now - Math.min(ms, 7 * 86400000);
}

async function revoke(sid, reason) {
  if (!sid) return 0;
  const r = await prisma.authSession.updateMany({
    where: { id: String(sid), revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: String(reason || 'signed out').slice(0, 80) },
  });
  return r.count;
}

/**
 * The check on every request. `seenAt` is this request's activity time.
 * Returns { ok: true, session } or { ok: false, reason }.
 * The idle rule is judged on what was STORED before this request: a click on
 * a screen left open for two hours does not bring the session back.
 */
async function checkAndTouch(sid, seenAt = Date.now(), now = Date.now()) {
  const s = await prisma.authSession.findUnique({ where: { id: String(sid) } });
  if (!s) return { ok: false, reason: 'unknown' };
  if (s.revokedAt) return { ok: false, reason: 'revoked' };
  const last = new Date(s.lastSeenAt).getTime();
  if (now - last > idleMs()) {
    await revoke(sid, 'idle timeout');
    return { ok: false, reason: 'idle' };
  }
  const next = Math.min(Math.max(last, seenAt), now);
  if (next - last >= TOUCH_EVERY_MS) {
    await prisma.authSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date(next) } });
    s.lastSeenAt = new Date(next);
  }
  return { ok: true, session: s };
}

/**
 * The Job Portal asking about a session (routes/sso.js), passing when the user
 * was last active there. The portal's activity counts for both apps; the same
 * stored-first idle rule applies.
 */
async function partnerCheck(sid, partnerActiveAt, now = Date.now()) {
  const s = await prisma.authSession.findUnique({ where: { id: String(sid) } });
  if (!s || s.revokedAt) return { active: false };
  const last = new Date(s.lastSeenAt).getTime();
  const theirs = Number.isFinite(partnerActiveAt) ? Math.min(partnerActiveAt, now) : 0;
  const seen = Math.max(last, theirs);
  if (now - seen > idleMs()) {
    await revoke(sid, 'idle timeout');
    return { active: false };
  }
  if (seen - last >= TOUCH_EVERY_MS) {
    await prisma.authSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date(seen) } });
  }
  return { active: true, lastSeenAt: new Date(seen).toISOString(), userId: s.userId };
}

module.exports = { idleMs, newSid, create, activityAt, revoke, checkAndTouch, partnerCheck };
