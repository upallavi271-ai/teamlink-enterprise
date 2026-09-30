// Password / account status (hrms-24 §12) — flags and dates from the server,
// never a password. Used on Employee Management and Administration → Users.
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export function passwordLine(ps) {
  if (!ps) return 'No login';
  if (ps.password === 'Password Changed') return `Password Changed · ${fmt(ps.passwordChangedAt)}`;
  if (ps.password === 'Reset Required') return ps.resetLinkPending ? 'Reset Required · link sent' : 'Reset Required';
  return ps.password;
}

// The compact badge for a table cell: the account state wins when locked.
export function PasswordBadge({ ps }) {
  if (!ps) return null;
  if (ps.account === 'Locked') {
    return <span className="status rejected" title={`Locked until ${new Date(ps.lockedUntil).toLocaleString()}`}>Account Locked</span>;
  }
  const cls = ps.password === 'Reset Required' ? 'pending'
    : ps.password === 'Awaiting First Password' ? 'new' : 'active';
  return <span className={`status ${cls}`} title={ps.passwordChangedAt ? `Last changed ${new Date(ps.passwordChangedAt).toLocaleString()}` : ''}>{passwordLine(ps)}</span>;
}

// The View drawer's rows.
export function PasswordStatusRows({ ps }) {
  if (!ps) return null;
  return (
    <>
      <div className="kv"><span className="k">Password</span><span>{ps.password}</span></div>
      <div className="kv"><span className="k">Last password change</span><span>{ps.passwordChangedAt ? new Date(ps.passwordChangedAt).toLocaleString() : 'Never changed'}</span></div>
      <div className="kv"><span className="k">Password reset required</span><span>{ps.passwordResetRequired ? `Yes${ps.resetLinkPending ? ' — reset link sent' : ''}` : 'No'}</span></div>
      <div className="kv"><span className="k">Account</span>
        <span>{ps.account === 'Locked' ? `Locked until ${new Date(ps.lockedUntil).toLocaleString()}` : ps.account}</span></div>
    </>
  );
}
