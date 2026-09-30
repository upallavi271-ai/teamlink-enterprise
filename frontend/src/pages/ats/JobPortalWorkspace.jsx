import { Navigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// The old INTERNAL Job Portal workspace (a Jobs / Requirements tab) has been
// re-homed (2026-09-29, user decision: "Job Portal is a candidate-INTAKE
// workspace, not a Requirements tab"):
//
//   Applications & screening → Send to ATS
//       Candidates & Pipeline → Job Portal Candidates (/candidates?view=job-portal,
//       components/portal/JobPortalCandidates.jsx)
//   Publish / unpublish      → per requirement, the requirement's "Posted on"
//                               panel with Retry (RequirementDetail.jsx)
//   Sync status / errors / logs
//                            → Administration → Integrations → Job Portal
//                               (/admin/integrations?tab=jobportal, also /ats/job-portal)
//
// /requirements/job-portal redirects in App.jsx. This stub only keeps any
// stray import of the old page working by sending it to the same place.
// ---------------------------------------------------------------------------
export default function JobPortalWorkspace() {
  return <Navigate to="/candidates?view=job-portal" replace />;
}
