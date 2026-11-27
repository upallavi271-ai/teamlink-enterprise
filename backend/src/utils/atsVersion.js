// ---------------------------------------------------------------------------
// "ATS DATA CHANGED" (founder 2026-11-27: "ats lo updates ayina prathi saari, annitlo update avvali. search bar lo kuda, including joinings, rejections
// etc... anni... yeppatikappudu modify avvali").
//
// One number that goes up whenever ATS data is written - by any screen, an import, the job-portal sync, the client portal, a bulk move - through a
// Prisma hook (db.js). Two things follow from it:
//   * the caches that held results back are cleared at once: who joined / who is credited (utils/recruiterJoinings.js, kept 2 minutes), who left after
//     joining (utils/joinedRule.js, 20 s) and the rejection index (utils/rejections.js). Before, only a few screens cleared them, so a joining or a drop
//     made through an import, a bulk move or the portal showed late in the histories and the search.
//   * GET /api/ats/history/version answers it: an open history window or the search page asks every 20 s and loads its numbers again when ATS data
//     changed (at most once a minute, and at once when the person comes back to the tab) - frontend/src/utils/useAtsLive.js.
// Never throws, never slows a write.
// ---------------------------------------------------------------------------
const ATS_MODELS = /^(Application|Requirement|Client|Candidate|JoiningRecord|StageEvent|InterviewEvent|InterviewFeedback|ApplicationFollowUp|Invoice|DropRecord|Replacement\w*)$/;
const WRITES = /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;
// the fields whose change can move a joining / a drop / a rejection
const JOIN_FIELDS = ['joiningStatus', 'joiningDate', 'joinedAt', 'offeredCtc', 'ownerRecruiterId', 'requirementId', 'leftAt', 'dropReason'];

const JOIN_STAGES = ['JOINED', 'HIRED', 'REJECTED', 'OFFER_ACCEPTED', 'SELECTED', 'OFFER'];

let version = Date.now();
let clearJoins = false;
let clearRejects = false;
let timer = null;

function clearSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const j = clearJoins; const r = clearRejects;
    clearJoins = false; clearRejects = false;
    if (j) {
      try { require('./recruiterJoinings').invalidate(); } catch { /* next read refreshes */ } // eslint-disable-line global-require
      try { require('./joinedRule').invalidate(); } catch { /* next read refreshes */ } // eslint-disable-line global-require
    }
    if (r) { try { require('./rejections').invalidate(); } catch { /* next read refreshes */ } } // eslint-disable-line global-require
  }, 1000);
  if (timer.unref) timer.unref();
}

function noteWrite(params) {
  if (!params || !params.model || !WRITES.test(params.action) || !ATS_MODELS.test(params.model)) return;
  version = Date.now();
  const data = (params.args && (params.args.data || params.args.update || params.args.create)) || {};
  const keys = Array.isArray(data) ? Object.keys(data[0] || {}) : Object.keys(data);
  const stage = Array.isArray(data) ? null : (data.stage && typeof data.stage === 'object' ? data.stage.set : data.stage);
  if (params.model === 'JoiningRecord' || /^(DropRecord|Replacement)/.test(params.model)
    || (params.model === 'Application' && (params.action.startsWith('delete') || keys.some((k) => JOIN_FIELDS.includes(k))
      // a step move counts for joinings only when it is (or may be) a joining step - an ordinary move does not recount the month
      || (keys.includes('stage') && (typeof stage !== 'string' || JOIN_STAGES.includes(stage)))))) clearJoins = true;
  if (params.model === 'Application' && (params.action.startsWith('delete') || stage === 'REJECTED' || keys.some((k) => /^reject/i.test(k)) || (keys.includes('stage') && stage !== 'REJECTED'))) clearRejects = true;
  if (clearJoins || clearRejects) clearSoon();
}
function prismaHook() {
  return async (params, next) => {
    const result = await next(params);
    try { noteWrite(params); } catch { /* never breaks a write */ }
    return result;
  };
}
const current = () => version;

module.exports = { prismaHook, current, noteWrite };
