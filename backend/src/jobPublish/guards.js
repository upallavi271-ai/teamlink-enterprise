// ---------------------------------------------------------------------------
// THE REAL-POSTING GATE. One function, used by the service (before a job is queued), the runner (before the adapter
// starts) and BasePortal.run (before a browser opens), so no path can skip it.
//
// A REAL post, update or take-down on a real job site needs ALL of:
//   1. TL_ALLOW_REAL_POSTING=1 in the environment of the computer that runs the worker
//   2. the site's own switch is ON (checked by the service / runner: PortalCredential.enabled, default OFF)
//   3. the entry is not a Dry run
//   4. the site's page settings are marked "verified": true (a person checked them against the real site: CALIBRATION.md)
// A Dry run, a login check and everything against the local MOCK portal (strict-local mode) are not "real posting".
// ---------------------------------------------------------------------------
const REAL_ACTIONS = ['PUBLISH', 'REPUBLISH', 'UPDATE', 'UNPUBLISH'];

const realPostingAllowed = () => process.env.TL_ALLOW_REAL_POSTING === '1';

// -> null (allowed) | 'REAL_POSTING_OFF' | 'SELECTORS_UNVERIFIED'
function realPostingGate({
  strict = false, verified = false, action, dryRun = false,
}) {
  if (strict || dryRun || !REAL_ACTIONS.includes(action)) return null;
  if (!realPostingAllowed()) return 'REAL_POSTING_OFF';
  if (!verified) return 'SELECTORS_UNVERIFIED';
  return null;
}

module.exports = { realPostingGate, realPostingAllowed, REAL_ACTIONS };
