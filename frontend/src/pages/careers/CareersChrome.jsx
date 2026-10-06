import { Link, NavLink } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import './careers.css';

// ---------------------------------------------------------------------------
// THE TEAMLINK JOB PORTAL — BUILT IN (2026-10-05).
//
// The public job portal used to be a separate app on its own port
// (job-portal-app/, :4323) kept in step by a sync. It is now these pages of
// the main app, on the same site, reading the same database through
// /api/public/careers (backend routes/careersPublic.js):
//   /careers                  job list, search, filters   (CareersPortal.jsx)
//   /careers/:id              job detail + apply + resume  (CareersJob.jsx)
//   /careers/my-applications  sign in with a one-time code (MyApplications.jsx)
// Everything is scoped under .jp (careers.css) so nothing leaks into the app.
// ---------------------------------------------------------------------------

export const daysAgo = (d) => {
  if (!d) return '';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  if (days < 30) return `Posted ${days} days ago`;
  return `Posted on ${new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

export default function CareersChrome({ children }) {
  return (
    <div className="jp">
      <header className="jp-header">
        <div className="jp-wrap jp-header-in">
          <Link to="/careers" className="jp-brand" aria-label="TeamLink Job Portal — all jobs">
            <TeamLinkMark width={140} />
            <span className="jp-brand-tag">Jobs</span>
          </Link>
          <nav className="jp-nav" aria-label="Job portal">
            <NavLink to="/careers" end>All jobs</NavLink>
            <NavLink to="/careers/my-applications">My applications</NavLink>
          </nav>
        </div>
      </header>
      <div className="jp-body">{children}</div>
      <footer className="jp-footer">
        <div className="jp-wrap">
          <b>TeamLink Consultants</b>
          <span>Hyderabad, India · <a href="https://tmlink.in" target="_blank" rel="noreferrer">tmlink.in</a></span>
          <span className="jp-footer-note">TeamLink never asks you for money to get a job.</span>
        </div>
      </footer>
    </div>
  );
}
