import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

// ---------------------------------------------------------------------------
// The employee's own profile state, said out loud.
//
// A new employee used to sign in for the first time and land on a dashboard
// with no indication that anything was expected of them — the profile form was
// a sidebar entry they had to find. This is the call to action, and it is
// rendered both on the HRMS landing page (where they arrive) and at the top of
// My Profile (where they act), from ONE component so the two can never say
// different things.
//
// It states only what the server already decided: `profileStatus` comes from
// routes/employees.js profileStatusOf(). Nothing here re-derives the state, so
// the banner cannot promise an edit the server will refuse.
// ---------------------------------------------------------------------------

export const STATUS_BADGE = {
  'Profile Incomplete': 'pending',
  'Pending Review': 'review',
  Approved: 'approved',
  Locked: 'approved',
  'Change Requested': 'rejected',
  'Edit Access Granted': 'new',
};

export function statusLabel(status) {
  return status === 'Locked' ? '🔒 Locked' : (status || '—');
}

// `variant`:
//   'landing' — on a dashboard: a card with a button through to the form.
//   'page'    — at the top of My Profile: the same words, no button, because
//               they are already there.
//   'shell'   — everywhere, but ONLY for the states that need them to act
//               (Profile Incomplete, Change Requested). A Recruiter lands on
//               the ATS dashboard and an Accountant on Accounts, so a banner
//               that lived on the HRMS dashboard alone would never be seen by
//               most new employees.
export default function ProfileStatusBanner({ variant = 'landing', employee: given = null }) {
  const [employee, setEmployee] = useState(given);
  const [loaded, setLoaded] = useState(!!given);

  useEffect(() => {
    if (given) { setEmployee(given); setLoaded(true); return; }
    let alive = true;
    api.get('/employees/me')
      .then((res) => { if (alive) { setEmployee(res.data); setLoaded(true); } })
      // A login with no employee record behind it (a client, a candidate, an
      // admin service account) simply gets no banner.
      .catch(() => { if (alive) { setEmployee(null); setLoaded(true); } });
    return () => { alive = false; };
  }, [given]);

  if (!loaded || !employee) return null;
  const status = employee.profileStatus || employee.profileStage;
  const onForm = variant === 'page';
  const SHELL_STATES = ['Profile Incomplete', 'Change Requested'];
  if (variant === 'shell' && !SHELL_STATES.includes(status)) return null;
  // The shell already carries the two states that need action, so a dashboard
  // copy would say the same thing twice on the same screen.
  if (variant === 'landing' && SHELL_STATES.includes(status)) return null;

  if (status === 'Profile Incomplete') {
    return (
      <div className="card section" style={{ borderColor: 'var(--amber)', marginBottom: 16 }}>
        <h3>Complete Your Employee Profile</h3>
        <div className="small-muted" style={{ marginTop: 4 }}>
          Your employee profile is incomplete. Please complete and submit it for HR review.
          {employee.profileCompletionPct !== undefined && ` It is ${employee.profileCompletionPct}% filled in.`}
        </div>
        {!onForm && (
          <Link className="btn btn-primary btn-sm" to="/my-profile" style={{ marginTop: 10 }}>
            Complete Your Employee Profile
          </Link>
        )}
      </div>
    );
  }

  if (status === 'Change Requested') {
    return (
      <div className="card section" style={{ borderColor: 'var(--red)', marginBottom: 16 }}>
        <h3>HR sent your profile back for edit</h3>
        <div className="small-muted" style={{ marginTop: 4 }}>
          {employee.reviewNote ? `Reason: ${employee.reviewNote}` : 'Please correct the details and submit again.'}
          {employee.reviewedByName ? ` — ${employee.reviewedByName}` : ''}
        </div>
        {!onForm && <Link className="btn btn-primary btn-sm" to="/my-profile" style={{ marginTop: 10 }}>Update and resubmit</Link>}
      </div>
    );
  }

  if (status === 'Pending Review') {
    return (
      <div className="notice amber">
        Your employee profile has been submitted and is awaiting HR review
        {employee.pendingChanges ? ` (${employee.pendingChanges.length} field(s))` : ''}.
        {!onForm && <> <Link to="/my-profile">View what you submitted</Link>.</>}
      </div>
    );
  }

  if (status === 'Edit Access Granted') {
    const until = employee.unlockExpiresAt ? new Date(employee.unlockExpiresAt).toLocaleString('en-GB') : null;
    return (
      <div className="notice">
        🔓 HR has granted you edit access
        {employee.unlockGrantSection && employee.unlockGrantSection !== 'All fields' ? ` to ${employee.unlockGrantSection}` : ''}
        {until ? ` until ${until}` : ''}
        {employee.unlockedByName ? ` (${employee.unlockedByName})` : ''}.
        Submitting your changes closes the window; so does the deadline, whichever comes first.
        {!onForm && <> <Link to="/my-profile">Edit your profile</Link>.</>}
      </div>
    );
  }

  if (status === 'Locked' || status === 'Approved') {
    return (
      <div className="notice">
        Your employee profile has been approved and locked
        {employee.reviewedByName ? ` by ${employee.reviewedByName}` : ''}
        {employee.reviewedAt ? ` on ${new Date(employee.reviewedAt).toLocaleString('en-GB')}` : ''}.
        {!onForm && <> Need a correction? <Link to="/my-profile">Request edit access</Link>.</>}
      </div>
    );
  }

  return null;
}
