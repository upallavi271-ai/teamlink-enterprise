// ---------------------------------------------------------------------------
// THE ENTRY-DOOR HOOK — one place that makes EVERY way a candidate can come in (or change) get its duplicate check.
// Installed once in db.js as a Prisma middleware, so a door written tomorrow is covered too:
//   Add candidate · resume upload / upload-to-fill · Excel / data import · Job Portal bridge · portal intake ·
//   careers / public apply · Naukri / Shine e-mail intake · self-registration · partner / referral submissions.
//
//   Candidate create                      -> fingerprints + check against the index (utils/candidateDupes.js reindex)
//   Candidate update of phone / e-mail / name / date of birth / city / college / company -> the same
//   CandidateResume / CandidateDocument stored with a file hash or text -> the same (resume keys)
//   Candidate delete                      -> its keys and open flags go
//
// Inline (awaited) when the write is a plain call, so the flag exists before the request answers and the application
// that follows is already held. Inside a transaction it is deferred a moment (never a nested write on SQLite's single
// writer). A burst of creates (an import) is raised silently — flagged, nobody notified. NEVER throws.
// ---------------------------------------------------------------------------
const WATCH = ['name', 'phone', 'email', 'dob', 'location', 'institute', 'currentCompany'];
let burst = []; // times of recent creates
const pending = new Map();

function isBurst() {
  const now = Date.now();
  burst = burst.filter((t) => now - t < 3000);
  burst.push(now);
  return burst.length > 5;
}
const touches = (data) => !!data && typeof data === 'object' && WATCH.some((f) => Object.prototype.hasOwnProperty.call(data, f));

function schedule(id, opts) {
  const DUP = require('./candidateDupes'); // eslint-disable-line global-require
  return DUP.reindex(id, opts);
}
function defer(id, opts) {
  if (pending.has(id)) return;
  const t = setTimeout(() => { pending.delete(id); schedule(id, opts).catch(() => null); }, 400);
  if (t.unref) t.unref();
  pending.set(id, t);
}

async function after(params, result) {
  const { model, action } = params;
  if (!model || !result) return;
  const inTx = !!params.runInTransaction;
  if (model === 'Candidate') {
    if (action === 'create' && result.id) {
      const opts = { door: result.source || 'Add candidate', quiet: isBurst() || undefined };
      if (inTx) defer(result.id, opts); else await schedule(result.id, opts);
      return;
    }
    if ((action === 'update' || action === 'upsert') && result.id && (action === 'upsert' || touches(params.args && params.args.data))) {
      const opts = { door: 'Details changed', quiet: true };
      if (inTx) defer(result.id, opts); else await schedule(result.id, opts);
      return;
    }
    if (action === 'delete' && result.id) {
      await require('./candidateDupes').removeCandidate(result.id); // eslint-disable-line global-require
    }
    // any bulk delete (or a delete inside a transaction): sweep the keys / flags of profiles that are gone
    if (action === 'deleteMany' || action === 'delete') require('./candidateDupes').sweepSoon(); // eslint-disable-line global-require
    return;
  }
  if ((model === 'CandidateResume' || model === 'CandidateDocument') && ['create', 'update'].includes(action) && result.candidateId) {
    const hasHash = result.sha256 || (model === 'CandidateResume' && result.text);
    const hideChange = action === 'update';
    if (!hasHash && !hideChange) return;
    const opts = { door: 'Resume stored', quiet: false };
    if (inTx) defer(result.candidateId, opts); else await schedule(result.candidateId, opts);
  }
}

module.exports = { after };
