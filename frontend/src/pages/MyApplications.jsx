import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

// Public "My Applications" page (/careers/my-applications) for someone who
// applied through the job portal.
//
// It USED to look applications up by email with no login, which let anyone
// who knew an address read that person's applications and employers. Now the
// candidate gets their OWN LOGIN instead (user notes #4, point 4): they type
// the email they applied with and a single-use, expiring "set your password"
// link is MAILED to that address (POST /api/portal/public/claim). Nothing
// about the applications is ever shown on this public page. After signing in
// they land on their candidate portal (/my-applications).
export default function MyApplications() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');

  async function claim(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/portal/public/claim', { email });
      setDone(res.data.message);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the link right now — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="careers-shell">
      <header className="careers-header">
        <div className="logo-lockup">
          <div className="mark">TL</div>
          <div>
            <div style={{ fontWeight: 600 }}>TeamLink Consultants</div>
            <div className="small-muted">My Applications</div>
          </div>
        </div>
      </header>
      <main className="careers-content" style={{ maxWidth: 560 }}>
        <Link className="small-muted" to="/careers/classic">← Back to open positions</Link>
        <h1 style={{ marginTop: 10 }}>See your applications</h1>
        <p className="small-muted">
          Already have a password? <Link to="/login">Sign in</Link> to see every application, its status,
          your interview details and offers — and to update your profile and resume.
        </p>
        <div className="card section">
          <h3 style={{ marginTop: 0 }}>First time here?</h3>
          <p className="small-muted">
            Enter the email address you applied with. We will email you a link to set your password.
            The link works once and expires in 48 hours.
          </p>
          {done ? (
            <div className="notice"><span>{done}</span></div>
          ) : (
            <form className="filter-row" onSubmit={claim}>
              <input
                style={{ flex: 1, minWidth: 0 }}
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email you applied with"
              />
              <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Get my sign-in link'}
              </button>
            </form>
          )}
          {error && <div className="error-text">{error}</div>}
        </div>
      </main>
    </div>
  );
}
