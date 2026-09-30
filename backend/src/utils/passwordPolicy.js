// ---------------------------------------------------------------------------
// PASSWORD POLICY + PASSWORD STATUS (hrms-24 §12).
//
// One place for:
//   * the strength rule every password path applies (self-service change,
//     admin / HR reset, the set-password link);
//   * the columns a password event stamps on the User row — WHEN it changed,
//     whether a reset is outstanding, and the lockout counters. Never the
//     password: it is only ever bcrypt-hashed, never stored, logged or echoed;
//   * the status HR sees on Employee Management / Administration → Users.
// ---------------------------------------------------------------------------

const MIN_LENGTH = 8;
// Sign-in lockout: this many wrong passwords in a row locks the login for
// LOCK_MINUTES. The counter resets on a successful sign-in or a new password.
const MAX_FAILED_LOGINS = Number(process.env.MAX_FAILED_LOGINS || 5);
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 15);

// null when the password is acceptable, otherwise the sentence to show.
function strengthError(password, { email, name } = {}) {
  const pw = String(password || '');
  if (pw.length < MIN_LENGTH) return `Choose a password of at least ${MIN_LENGTH} characters.`;
  if (pw.length > 128) return 'That password is too long (128 characters at most).';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use at least one letter and one number.';
  if (/^(.)\1+$/.test(pw)) return 'That password is a single repeated character.';
  const lower = pw.toLowerCase();
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Do not use your email address in the password.';
  const first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
  if (first && first.length >= 4 && lower.includes(first)) return 'Do not use your name in the password.';
  if (['password', 'password1', 'password123', '12345678', 'qwerty123', 'teamlink1', 'welcome1', 'admin123'].includes(lower)) {
    return 'That password is too common.';
  }
  return null;
}

// The User columns a password event writes, besides the new hash.
//   self      — the person changed it themselves: nothing outstanding.
//   link      — set through the single-use set-password link: likewise.
//   admin     — HR / an administrator typed it: they know it, so the owner
//               must change it (passwordResetRequired).
//   initial   — HR typed a first password on Add Employee: same as admin.
function passwordEventData(kind, now = new Date()) {
  return {
    passwordChangedAt: now,
    passwordResetRequired: kind === 'admin' || kind === 'initial',
    failedLoginCount: 0,
    lockedUntil: null,
  };
}

const isLocked = (u, now = new Date()) => !!(u && u.lockedUntil && new Date(u.lockedUntil) > now);

// The status line HR sees. Built from timestamps and flags only.
function passwordStatusOf(u, now = new Date()) {
  if (!u) return null;
  const locked = isLocked(u, now);
  const linkPending = !!(u.setPasswordTokenHash && !u.setPasswordUsedAt
    && u.setPasswordExpiresAt && new Date(u.setPasswordExpiresAt) > now);
  let password;
  if (u.passwordResetRequired) password = 'Reset Required';
  else if (u.passwordChangedAt) password = 'Password Changed';
  else if (linkPending && !u.lastLoginAt) password = 'Awaiting First Password';
  else password = 'Password Set';
  return {
    password,
    passwordChangedAt: u.passwordChangedAt || null,
    passwordResetRequired: !!u.passwordResetRequired,
    resetLinkPending: linkPending,
    resetLinkExpiresAt: linkPending ? u.setPasswordExpiresAt : null,
    account: locked ? 'Locked' : ((u.status || 'Active') === 'Active' ? 'Active' : u.status),
    lockedUntil: locked ? u.lockedUntil : null,
    failedLoginCount: u.failedLoginCount || 0,
  };
}

module.exports = {
  MIN_LENGTH, MAX_FAILED_LOGINS, LOCK_MINUTES, strengthError, passwordEventData, isLocked, passwordStatusOf,
};
