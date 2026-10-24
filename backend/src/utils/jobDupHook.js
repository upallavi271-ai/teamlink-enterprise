// ---------------------------------------------------------------------------
// THE JOB HOOK — installed once in db.js (a Prisma middleware), so EVERY door that creates or changes a job keeps the duplicate
// worklist fresh: Add job · request · copy · import · API · Job Portal. It only marks the cached worklist stale; the next time
// somebody opens Duplicate jobs (or saves a job) it is rebuilt. Cheap, never throws, nothing is written.
// ---------------------------------------------------------------------------
const WATCH = ['title', 'clientId', 'location', 'status', 'openings', 'specialisation', 'department', 'salary', 'experience', 'description', 'jobDescription', 'internal'];

function after(params) {
  const { model, action } = params;
  if (model !== 'Requirement' && model !== 'RequirementPosting') return;
  if (!['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'].includes(action)) return;
  if (model === 'Requirement' && (action === 'update' || action === 'updateMany')) {
    const data = params.args && params.args.data;
    if (data && typeof data === 'object' && !WATCH.some((f) => Object.prototype.hasOwnProperty.call(data, f))) return;
  }
  require('./jobDupes').bump(); // eslint-disable-line global-require
}

module.exports = { after };
