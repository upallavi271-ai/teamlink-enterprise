// ---------------------------------------------------------------------------
// A PERSON WHO HAS LEFT CANNOT SIGN IN  (founder, 2026-10-14; diagnosis: 7 Exited employees still had
// an Active login). Server side, in two places: at sign-in (routes/auth.js) and on every request with
// an existing session (middleware/auth.js requireAuth), which signs them out (401).
// Only the employment status decides; a Super Admin account, a client or a candidate is never judged here.
// ---------------------------------------------------------------------------
const LEFT = ['Exited', 'Relieved', 'Terminated'];
const MESSAGE = 'Your employment has ended, so this login is closed. Please contact HR if you think this is a mistake.';
const CODE = 'EMPLOYMENT_ENDED';

// identity (resolveIdentity) or { role, employmentStatus }
function hasLeft(identity) {
  if (!identity) return false;
  if (['SUPER_ADMIN', 'CLIENT', 'CANDIDATE'].includes(identity.role)) return false;
  return LEFT.includes(identity.employmentStatus);
}

module.exports = { LEFT, MESSAGE, CODE, hasLeft };
