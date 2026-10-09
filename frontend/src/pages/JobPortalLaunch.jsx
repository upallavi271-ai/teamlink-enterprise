import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';

// ---------------------------------------------------------------------------
// /sso/job-portal — open the TeamLink Job Portal, already signed in.
//
// The sidebar's "Job Portal" item comes here (same tab). The backend signs a
// 60-second, single-use token for THIS sign-in (routes/sso.js) and answers the
// portal address with the token in its fragment; the browser goes straight
// there and the portal opens its own session. ?next=#/recruiter/… opens a
// particular portal page — the portal sends people here, with the page they
// wanted, when its session has ended; signed out of HRMS, ProtectedRoute sends
// them to the login first and back here after it.
//
// A role without Job Portal access (anything but Recruiter / Admin) gets
// "Access denied" and a way back.
// ---------------------------------------------------------------------------
export default function JobPortalLaunch() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.post('/sso/job-portal/launch', { next: params.get('next') || '' })
      .then((res) => { window.location.replace(res.data.url); })
      .catch((err) => {
        const status = err.response?.status;
        const data = err.response?.data || {};
        if (status === 401) return; // api.js has already gone to the login
        setError({
          denied: status === 403,
          message: data.error || 'The Job Portal could not be opened. Please try again.',
        });
      });
  }, [params]);

  const back = () => navigate(user?.landingPath || '/', { replace: true });

  if (!error) {
    return (
      <div className="card" style={{ maxWidth: 460, margin: '40px auto', textAlign: 'center' }}>
        <div style={{ fontSize: 30, marginBottom: 8 }} aria-hidden="true">💼</div>
        <h2 style={{ margin: '0 0 6px' }}>Opening the Job Portal…</h2>
        <div className="small-muted">Signing you in with your HRMS login.</div>
      </div>
    );
  }
  return (
    <div className="card" style={{ maxWidth: 460, margin: '40px auto', textAlign: 'center' }} role="alert">
      <div style={{ fontSize: 30, marginBottom: 8 }} aria-hidden="true">{error.denied ? '🔒' : '⚠️'}</div>
      <h2 style={{ margin: '0 0 6px' }}>{error.denied ? 'Access denied' : 'Job Portal unavailable'}</h2>
      <div className="small-muted" style={{ marginBottom: 18 }}>{error.message}</div>
      <button type="button" className="btn btn-primary" onClick={back}>← Back to HRMS</button>
    </div>
  );
}
