// ---------------------------------------------------------------------------
// INDEXES FOR THE ATS FILTERS (2026-11-18). CREATE INDEX IF NOT EXISTS only: no table or column changes, safe to run on every start,
// and a missing table / column (an older database) is skipped. The candidate lists filter an in-memory copy; these serve the
// database-backed lists (requirements, clients, interviews, offers, joinings, follow-ups) and the side indexes the candidate filters read.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const INDEXES = [
  ['fx_cand_location', 'Candidate', 'location'],
  ['fx_cand_exp', 'Candidate', 'experienceYears'],
  ['fx_cand_status', 'Candidate', 'profileStatus'],
  ['fx_app_stage', 'Application', 'stage'],
  ['fx_app_req_stage', 'Application', 'requirementId, stage'],
  ['fx_app_cand', 'Application', 'candidateId'],
  ['fx_app_interview', 'Application', 'interviewAt'],
  ['fx_app_offer', 'Application', 'offerStatus'],
  ['fx_app_owner', 'Application', 'ownerRecruiterId'],
  ['fx_req_client', 'Requirement', 'clientId'],
  ['fx_req_status', 'Requirement', 'status, createdAt'],
  ['fx_req_dept', 'Requirement', 'department'],
  ['fx_req_recruiter', 'Requirement', 'recruiterId'],
  ['fx_evt_stage', 'ApplicationStageEvent', 'toStage, applicationId'],
  ['fx_client_status', 'Client', 'status'],
  ['fx_inv_cand', 'Invoice', 'candidateId, requirementId'],
];
let done = null;
function ensure() {
  if (done) return done;
  done = (async () => {
    for (const [name, table, cols] of INDEXES) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" (${cols.split(',').map((c) => `"${c.trim()}"`).join(', ')})`);
      } catch { /* the table or column is not in this database: skipped */ }
    }
  })();
  return done;
}
module.exports = { ensure, INDEXES };
