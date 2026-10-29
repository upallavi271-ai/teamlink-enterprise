import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../api';

// ---------------------------------------------------------------------------
// /sso/job-portal (founder 2026-10-29: "job portal kuda elane hrms logins to direct login avali recruiters ni separate logins adagakudadhu"):
// opens the Job Portal already signed in with this TeamLink login. TeamLink signs a 60 s single-use ticket
// (POST /api/sso/job-portal/launch, backend/src/utils/jobPortalSso.js) and the portal's own /jobs/hrms-sso.html opens its session.
// The sidebar "Job Portal" opens this page; the portal itself sends a signed-out recruiter page here too (?next=#/recruiter/...).
// A login without Job Portal staff pages goes to the public portal.
// ---------------------------------------------------------------------------

// The same rule as the backend's portalRoleOf: Super Admin / Admin, or an ATS Recruiter / TL / STL.
export function canOpenJobPortalStaff(user) {
  const role = String((user && user.role) || '').toUpperCase();
  const ats = String((user && user.atsRole) || '').toUpperCase();
  return role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'RECRUITER' || ['RECRUITER', 'TL', 'STL'].includes(ats);
}

export default function JobPortalLaunch() {
  const { search } = useLocation();
  const [msg, setMsg] = useState('');
  useEffect(() => {
    document.title = 'Job Portal';
    const next = new URLSearchParams(search).get('next') || '';
    api.post('/sso/job-portal/launch', { next })
      .then((r) => { window.location.replace(r.data.url); })
      .catch((e) => {
        const d = (e.response && e.response.data) || {};
        if (d.code === 'NO_ACCESS') { window.location.replace('/jobs/'); return; }
        setMsg(d.error || 'The Job Portal could not be opened. Please try again in a minute.');
      });
  }, [search]);
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, color: '#123' }} role="status">
      {msg ? (
        <>
          <p>{msg}</p>
          <p><a href="/jobs/">Open the public Job Portal</a> · <a href="/">Back to TeamLink</a></p>
        </>
      ) : <p>Opening the Job Portal…</p>}
    </div>
  );
}
