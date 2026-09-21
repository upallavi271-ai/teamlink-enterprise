import { useEffect } from 'react';

// ---------------------------------------------------------------------------
// TeamLink Job Portal — the stable entry point.
//
// The portal is the customer's own self-contained single-file app, shipped
// verbatim as a static asset at frontend/public/job-portal/index.html and
// served at /job-portal/. It is NOT a React page: it has its own shell, its
// own hash router (#/jobs, #/candidate/home, #/recruiter/jobs, …) and keeps
// its state in localStorage under tl_job_portal_state_v1.
//
// This component exists only so that /job-portal (no trailing slash) and
// /careers always land on it, even when the request has fallen through to the
// SPA history fallback — which is what a plain static host does in production.
// In dev the Vite plugin in vite.config.js redirects first and this never
// renders. index.html is targeted rather than the directory so there is no way
// to bounce between the fallback and this component.
//
// Deliberately a hard document navigation (not react-router): the portal is a
// whole separate document, not a route inside this SPA.
// ---------------------------------------------------------------------------
export const JOB_PORTAL_URL = '/job-portal/';
const JOB_PORTAL_FILE = '/job-portal/index.html';

export default function JobPortalRedirect() {
  useEffect(() => {
    // From /careers, aim at the pretty directory URL. From /job-portal itself
    // that would risk bouncing back here on a host that does not resolve the
    // directory, so go straight at the file.
    const onPortalPath = window.location.pathname.replace(/\/+$/, '') === '/job-portal';
    window.location.replace(onPortalPath ? JOB_PORTAL_FILE : JOB_PORTAL_URL);
  }, []);

  return (
    <div className="careers-shell">
      <main className="careers-content">
        <div className="small-muted">Opening the TeamLink Job Portal…</div>
        <p className="small-muted">
          If nothing happens, <a href={JOB_PORTAL_FILE}>open the Job Portal</a>.
        </p>
      </main>
    </div>
  );
}
