// ---------------------------------------------------------------------------
// ONE REAL PUNCH, NEVER TWO. The rules every way of punching shares (web / phone
// face check-in, HR entering a reading, the biometric device):
//
//   * a check-in while the day is already open  -> "Already checked in at HH:MM"
//     (the existing punch is returned; nothing new is written);
//   * a check-out when there is no open check-in -> a plain message;
//   * a repeat of the same direction within the minimum gap (AppSetting
//     "attendance.minPunchGapSec", default 60 s) is the same punch;
//   * face + manual + biometric for the SAME minute are ONE punch, and the
//     strongest way of proving it is the one kept (device > face > GPS > typed);
//   * the day's first check-in / last check-out are still worked out from the
//     punches by utils/attendanceMath.daySplit, so nothing here counts twice.
//
// Writes go through withLock() so two requests for one person cannot both pass
// the check and both insert (one Node process serves the API).
// ---------------------------------------------------------------------------

const prisma = require('../db');

const DEFAULT_GAP_SEC = 60;
let gapCache = { at: 0, value: DEFAULT_GAP_SEC };

async function minGapSec() {
  if (Date.now() - gapCache.at < 30000) return gapCache.value;
  let value = DEFAULT_GAP_SEC;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'attendance.minPunchGapSec' } });
    const n = row ? Number(JSON.parse(row.value)) : NaN;
    if (Number.isFinite(n)) value = Math.max(0, Math.min(3600, Math.round(n)));
  } catch { /* keep the default */ }
  gapCache = { at: Date.now(), value };
  return value;
}
const resetGapCache = () => { gapCache = { at: 0, value: DEFAULT_GAP_SEC }; };

const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// 0 typed in by HR · 1 other · 2 verified face on web/phone · 3 the device itself.
function strengthOf(p) {
  if (!p) return -1;
  if (p.method === 'Biometric' || p.source === 'Biometric device') return 3;
  if (p.verificationStatus === 'Verified') return 2;
  if (p.source === 'Manual entry') return 0;
  return 1;
}

const byClock = (a, b) => String(a.time).localeCompare(String(b.time)) || new Date(a.createdAt) - new Date(b.createdAt);

async function dayPunches(db, employeeId, date) {
  const rows = await db.attendancePunch.findMany({ where: { employeeId, date } });
  return rows.sort(byClock);
}

// The same person, day and direction within the minimum gap.
async function nearDuplicate(db, { employeeId, date, direction, time }) {
  const gap = await minGapSec();
  const window = Math.max(1, Math.ceil(gap / 60));
  const t = toMin(time);
  if (t == null) return null;
  const rows = await dayPunches(db, employeeId, date);
  return rows.find((p) => p.direction === direction && Math.abs(toMin(p.time) - t) <= window) || null;
}

// Strongest method kept. `data` is the new punch's column values.
async function mergeStronger(db, existing, data) {
  if (strengthOf({ ...data }) > strengthOf(existing)) {
    const keep = {};
    ['method', 'source', 'location', 'verificationStatus', 'verificationScore', 'livenessStatus', 'imageFile', 'latitude', 'longitude',
      'accuracyM', 'locationAt', 'locationStatus', 'distanceM', 'deviceState', 'deviceVerify', 'clockTime', 'userAgent'].forEach((k) => {
      if (data[k] !== undefined) keep[k] = data[k];
    });
    const punch = await db.attendancePunch.update({ where: { id: existing.id }, data: keep });
    return { punch, merged: true, upgraded: true };
  }
  return { punch: existing, merged: true, upgraded: false };
}

const clock12 = (t) => {
  const m = toMin(t);
  if (m == null) return String(t || '');
  const h = Math.floor(m / 60); const mm = String(m % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${mm} ${h >= 12 ? 'PM' : 'AM'}`;
};

// Web / phone check-in: may this person punch In / Out right now?
//   { ok:true } | { ok:false, duplicate:true, punch, code, message } | { ok:false, code, message }
// THE DAY LOCKS AT THE CHECK-OUT (founder 2026-10-26: "once the check-in is frozen only the Super Admin can unfreeze it"). After the
// person's own check-out (web / phone / HR - not a device punch, whose direction is settled from the day) nothing re-opens the day:
// a new check-in is refused until the Super Admin unlocks that day (AppSetting attendance.unlock.<employeeId>.<date>, written by
// POST /api/attendance/day-unlock). One unlock = one more check-in; the next check-out locks the day again.
const unlockKey = (employeeId, date) => `attendance.unlock.${employeeId}.${date}`;
async function unlockedSince(db, employeeId, date) {
  try {
    const row = await db.appSetting.findUnique({ where: { key: unlockKey(employeeId, date) } });
    const v = row ? JSON.parse(row.value) : null;
    return v && v.at ? new Date(v.at) : null;
  } catch { return null; }
}

async function webPunchGuard(db, employeeId, date, direction) {
  const rows = await dayPunches(db, employeeId, date);
  const last = rows[rows.length - 1];
  if (direction === 'In') {
    if (last && last.direction === 'In') {
      return { ok: false, duplicate: true, punch: last, code: 'ALREADY_IN', message: `Already checked in at ${clock12(last.time)}.` };
    }
    const ownOut = [...rows].reverse().find((p) => p.direction === 'Out' && p.method !== 'Biometric');
    if (ownOut && last === ownOut) {
      const at = await unlockedSince(db, employeeId, date);
      if (!at || at < new Date(ownOut.createdAt)) {
        return { ok: false, code: 'DAY_LOCKED', message: `You checked out at ${clock12(ownOut.time)}, so today's attendance is locked. Only the Super Admin can unlock it.` };
      }
    }
    return { ok: true };
  }
  if (!last) {
    return { ok: false, code: 'NOT_CHECKED_IN', message: 'You have not checked in today, so there is nothing to check out. If you forgot to check in, ask your TL or HR to correct the day.' };
  }
  // A CHECK-OUT COUNTS WHICHEVER WAY IT IS DONE (founder 2026-10-26: "check-out web check, biometric methods nunchi vesina thisukovali").
  // A device punch reads "Out" only because it is the latest one so far (a lunch break looks like that until the person comes back), so it
  // never blocks a web check-out: the web check-out is recorded, the device punch becomes an interval (utils/biometricDevice.js
  // settledDirections) and the day's check-out is the web one. Only the person's own earlier web / phone / HR check-out is "already out".
  if (last.direction === 'Out' && last.method !== 'Biometric') {
    return { ok: false, duplicate: true, punch: last, code: 'ALREADY_OUT', message: `Already checked out at ${clock12(last.time)}.` };
  }
  return { ok: true };
}

// One at a time per key (a person), in this process.
const tails = new Map();
function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

module.exports = { minGapSec, resetGapCache, strengthOf, dayPunches, nearDuplicate, mergeStronger, webPunchGuard, withLock, clock12, toMin, unlockKey };
