// ---------------------------------------------------------------------------
// STARTING (SEED / DEMO) PASSWORDS (security fix 2026-10-13).
//
// A login that has never changed its password (passwordChangedAt is empty) AND
// whose stored hash still matches one of the well-known starting passwords is
// "on a starting password": the app makes its owner choose a new one before
// anything else (middleware/auth.js answers 403 PASSWORD_CHANGE_REQUIRED on
// every API except /api/auth/*, and the browser shows a plain "Change your
// password now" screen). Super Admin sees "N accounts still use a starting
// password" (names only) on the Users screen.
//
// The password itself is never printed, logged or returned: the list below only
// exists to be compared against stored bcrypt hashes. Extra values can be added
// with TL_SEED_PASSWORDS (comma list) without touching the code.
//
// Verdicts are cached per hash (the comparison is slow on purpose) and a
// per-user answer is cached for a few seconds.
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const prisma = require('../db');

const KNOWN = ['password123', 'Password@123', 'Password123', 'TeamLink@123', 'admin123'];
const extra = () => String(process.env.TL_SEED_PASSWORDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const hashVerdict = new Map(); // hash -> boolean
async function hashIsStarting(hash) {
  const h = String(hash || '');
  if (!/^\$2[aby]\$/.test(h)) return false; // not a bcrypt hash (fixtures, unguessable placeholders): not a starting password
  if (hashVerdict.has(h)) return hashVerdict.get(h);
  let hit = false;
  for (const pw of [...KNOWN, ...extra()]) {
    // eslint-disable-next-line no-await-in-loop
    try { if (await bcrypt.compare(pw, h)) { hit = true; break; } } catch { /* ignore */ }
  }
  if (hashVerdict.size > 2000) hashVerdict.clear();
  hashVerdict.set(h, hit);
  return hit;
}

const TTL = 8000;
const perUser = new Map(); // userId -> { at, v }
function forget(userId) { if (userId) perUser.delete(userId); else perUser.clear(); }

// true when this login must choose a new password now.
async function mustChange(userId) {
  if (!userId) return false;
  const c = perUser.get(userId);
  if (c && Date.now() - c.at < TTL) return c.v;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true, passwordChangedAt: true, role: true } }).catch(() => null);
  const v = !!(u && !u.passwordChangedAt && !['CLIENT', 'CANDIDATE'].includes(u.role) && await hashIsStarting(u.passwordHash));
  if (perUser.size > 5000) perUser.clear();
  perUser.set(userId, { at: Date.now(), v });
  return v;
}

// Names only, for the Super Admin banner.
async function accountsOnStartingPassword() {
  const rows = await prisma.user.findMany({
    where: { passwordChangedAt: null, status: 'Active', role: { notIn: ['CLIENT', 'CANDIDATE'] } },
    select: { id: true, name: true, role: true, passwordHash: true },
  });
  const out = [];
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await hashIsStarting(r.passwordHash)) out.push({ id: r.id, name: r.name, role: r.role });
  }
  return out;
}

module.exports = { mustChange, forget, accountsOnStartingPassword, hashIsStarting };
