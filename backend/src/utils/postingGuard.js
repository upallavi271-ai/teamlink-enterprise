// ---------------------------------------------------------------------------
// POSTING A JOB IS NOT A RECRUITER'S (user, 2026-10-12: "Req post chesey option Recruiter ki undadu").
// One refusal, one plain sentence, used by every route that posts, publishes, syncs or writes the job text:
// the Recruiter is told who does it instead of being shown a bare "not included in your role".
// The decision itself is the permission engine's (utils/permissions.js: 'Job Posting' / 'Job Portal Workspace'
// are hard-locked for a Recruiter whatever Role Catalog says).
// ---------------------------------------------------------------------------
const { can } = require('./permissions');

const POSTING_REFUSAL = 'Posting requirements is done by your team lead or the client manager.';
const POSTING_BODY = { error: POSTING_REFUSAL, code: 'POSTING_NOT_YOURS' };

// Express guard: same signature as requirePerm(), but a refusal says it in plain words.
function requirePosting(product, moduleId, feature, action) {
  return async (req, res, next) => {
    try {
      if (!(await can(req.user, product, moduleId, feature, action))) return res.status(403).json(POSTING_BODY);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { POSTING_REFUSAL, POSTING_BODY, requirePosting };
