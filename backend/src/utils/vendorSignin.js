// ---------------------------------------------------------------------------
// VENDOR SIGN-IN: WHAT TO SAY WHEN IT DOES NOT WORK (2026-10-19).
//
// THE FOUNDER'S BUG: "Vendor login details are correct but it says incorrect." What really happened (see the evidence in the hand-over notes):
//   * every Resend / Retry / Edit-email makes a NEW temporary password and kills the old one, but the emails looked the same, so the vendor
//     typed the password of an OLDER email -> "Invalid credentials.";
//   * five such tries locked the login for 30 minutes, and while locked even the RIGHT password got the same "Invalid credentials.";
//   * Edit email on a waiting login changes the Login ID itself: the Login ID in the first emails no longer exists.
// The sign-in itself (hash, case, trimming of the email) was sound. What was missing was an honest answer. This module gives it, without
// weakening anything:
//   * a stranger, an unknown login ID and a wrong password all still get the SAME answer (same words, same status, about the same time);
//   * a state is named only to somebody who proves they hold a real credential of that login (the exact old temporary password, or the
//     right password): "replaced by a newer email", "login ID changed", "already chose your own password", "expired", "switched off";
//   * the lock message is the same for a real login and for an unknown one (an unknown ID is locked in memory after the same number of
//     tries), and it does not depend on whether the password typed was right, so it tells a guesser nothing.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const VC = require('./vendorConfig');
const MAIL = require('./vendorMail');
const DB = require('./vmDb');
const prisma = require('../db');

const INVALID = 'Invalid credentials.';
const HINT = 'Check your login ID (the email the invitation came to) and use the password from the NEWEST email. After 5 wrong tries the login pauses for 30 minutes.';

const minutesLeft = (until) => Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const when = (d) => MAIL.whenText(d);

function lockedBody(minutes) {
  return {
    error: `Too many wrong tries. This login is paused for ${plural(minutes, 'more minute')}. Wait, then try again with the password from the NEWEST email. Or ask your contact at the company to unlock it now.`,
    code: 'LOCKED', minutes,
  };
}
const invalidBody = () => ({ error: INVALID, code: 'INVALID', hint: HINT });

// ---- an unknown login ID is "locked" in memory with the same count and the same time, so a lock proves nothing -------------------------
const ghost = new Map(); // loginId -> { n, until }
function ghostMinutes(loginId) {
  const g = ghost.get(loginId);
  if (g && g.until && g.until > Date.now()) return minutesLeft(g.until);
  if (g && g.until) ghost.delete(loginId);
  return 0;
}
// -> minutes locked NOW (0 = not locked by this try)
function ghostFail(loginId) {
  const g = ghost.get(loginId) || { n: 0, until: 0 };
  g.n += 1;
  if (g.n >= VC.CFG.maxFailed) { g.n = 0; g.until = Date.now() + VC.CFG.lockMinutes * 60000; }
  ghost.set(loginId, g);
  if (ghost.size > 5000) ghost.clear();
  return g.until && g.until > Date.now() ? minutesLeft(g.until) : 0;
}
const ghostReset = () => ghost.clear();

// ---- "the password you typed is one we really issued, but it is not the current one" ------------------------------------------------
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const shorten = (e) => {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  return u.length <= 4 ? `${u.slice(0, 1)}***@${d}` : `${u.slice(0, 2)}${'*'.repeat(Math.min(6, u.length - 4))}${u.slice(-2)}@${d}`;
};

// vu = the login found by the typed ID (or null: the ID may be an OLD one). -> { why, body } or null (nothing to add: generic answer).
async function recognise({ loginId, vu, rawPassword }) {
  let rows = [];
  try {
    await MAIL.ensure();
    rows = vu
      ? await DB.q('SELECT "vendorUserId","attemptNo","createdAt","toEmail","credMark" FROM "VendorMailLog" WHERE "vendorUserId" = ? AND "kind" = \'invite\' AND "credMark" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 40', [vu.id])
      : await DB.q('SELECT "vendorUserId","attemptNo","createdAt","toEmail","credMark" FROM "VendorMailLog" WHERE LOWER("toEmail") = ? AND "kind" = \'invite\' AND "credMark" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 40', [loginId]);
  } catch { return null; }
  if (!rows.length) return null;
  const tries = VC.passwordCandidates(rawPassword, { temp: true });
  const hit = rows.find((r) => tries.some((p) => safeEq(MAIL.credMark(r.vendorUserId, p), r.credMark)));
  if (!hit) return null;
  const user = vu || await prisma.vendorUser.findUnique({ where: { id: hit.vendorUserId } });
  if (!user || user.deletedAt) return null;
  const latest = await MAIL.latest(user.id, 'invite');
  const activated = MAIL.isActivated(user);
  if (!vu && user.email !== loginId) {
    return {
      why: 'old login ID', body: {
        error: `Your login ID was changed. Sign in with ${shorten(user.email)} (the address the NEWEST email came to) and the password in that newest email.`,
        code: 'LOGIN_ID_CHANGED',
      },
    };
  }
  if (activated) {
    return {
      why: 'temporary password already replaced', body: {
        error: 'That was the temporary password from an invitation email. You have already chosen your own password, so sign in with that. If you forgot it, press "Forgot your password?".',
        code: 'ALREADY_ACTIVE',
      },
    };
  }
  if (latest && Number(hit.attemptNo) < Number(latest.attemptNo)) {
    return {
      why: `old password (invitation #${hit.attemptNo}, newest is #${latest.attemptNo})`, body: {
        error: `This password was replaced by a newer email (it was from invitation #${hit.attemptNo}). Open the NEWEST email (invitation #${latest.attemptNo}, sent ${when(latest.createdAt)}) and use the password in it. Older passwords stop working.`,
        code: 'OLD_PASSWORD', newest: Number(latest.attemptNo),
      },
    };
  }
  return null;
}

// The answers for a login whose ID and password are RIGHT but which cannot be used now (so naming the reason gives nothing away).
const reasonBody = {
  switchedOff: () => ({ error: 'This login is switched off. Please contact the company.', code: 'SWITCHED_OFF' }),
  vendorOff: () => ({ error: 'This vendor account is switched off. Please contact the company.', code: 'VENDOR_OFF' }),
  tempExpired: () => ({ error: 'This temporary password has expired. Ask your contact at the company to send you a new invitation.', code: 'TEMP_EXPIRED' }),
};

module.exports = { INVALID, HINT, invalidBody, lockedBody, reasonBody, ghostMinutes, ghostFail, ghostReset, recognise, minutesLeft };
