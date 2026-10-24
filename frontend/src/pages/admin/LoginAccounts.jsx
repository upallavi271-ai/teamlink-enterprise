import { useState } from 'react';

// Administration -> Users: the small pieces for SEPARATE LOGINS ON ONE EMAIL (founder, 2026-10-21).
// Plain words, no required marks, nothing new in the sidebar: these sit inside the existing Users page.

const MONO = { fontFamily: 'Consolas, "Courier New", monospace' };

export function CopyButton({ text, label = 'Copy', small = true }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`btn${small ? ' btn-sm' : ''}`}
      style={{ marginLeft: 6 }}
      onClick={() => {
        const finish = () => { setDone(true); setTimeout(() => setDone(false), 1800); };
        try { navigator.clipboard.writeText(text).then(finish).catch(() => {}); } catch { /* clipboard blocked */ }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

// "Several logins on one email: ON / OFF" with the one button a Super Admin needs.
export function MultiLoginBanner({ status, isSuper, onSwitchOn, busy }) {
  const [asking, setAsking] = useState(false);
  if (!status) return null;
  if (status.multiLoginOn) {
    return (
      <div className="small-muted" style={{ margin: '0 0 10px' }} data-testid="multi-login-on">
        Several logins on one email: <b style={{ color: 'var(--green, #15803d)' }}>ON</b>
        {status.sharedEmailGroups > 0 ? ` · ${status.sharedEmailGroups} email${status.sharedEmailGroups === 1 ? '' : 's'} used by more than one login` : ''}
      </div>
    );
  }
  return (
    <div className="notice amber" style={{ display: 'block', marginBottom: 12 }} data-testid="multi-login-off">
      <b>Several logins on one email: OFF.</b> Right now one email can have only one login.
      {status.canSwitchOn && isSuper && !asking && (
        <> <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => setAsking(true)}>Switch ON</button></>
      )}
      {status.canSwitchOn && !isSuper && <div style={{ marginTop: 4 }}>A Super Admin can switch it on here.</div>}
      {status.needsCommand && <div style={{ marginTop: 4 }}>This needs a one-time command from your developer. Nothing is lost.</div>}
      {asking && (
        <div style={{ marginTop: 8 }}>
          A backup copy of the database is made first. No login is deleted and no password changes.
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={async () => { await onSwitchOn(); setAsking(false); }}>
              {busy ? 'Switching on…' : 'Yes, switch it on'}
            </button>{' '}
            <button type="button" className="btn btn-sm" onClick={() => setAsking(false)}>Not now</button>
          </div>
        </div>
      )}
    </div>
  );
}

// What the Admin sees under the Email box: the logins that are already there (Admin only), and the tick.
export function ExistingLogins({ lookup, checked, onCheck, onPickEmployee, hasEmployee }) {
  if (!lookup) return null;
  const suggest = !hasEmployee ? (lookup.employeesWithEmail || [])[0] : null;
  if (!lookup.count && !suggest) return null;
  return (
    <div className="card section" style={{ borderColor: 'var(--warn, #d97706)', marginBottom: 12 }} data-testid="existing-logins">
      {lookup.count > 0 && (
        <>
          <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>
            {lookup.sameEmail > 0
              ? `This email already has ${lookup.sameEmail} login${lookup.sameEmail === 1 ? '' : 's'}`
              : `This employee already has ${lookup.count} login${lookup.count === 1 ? '' : 's'}`}
          </h4>
          <div className="tbl-wrap" style={{ marginBottom: 8 }}>
            <table>
              <thead><tr><th>Role</th><th>Department</th><th>Employee</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {lookup.accounts.map((a) => (
                  <tr key={a.id}>
                    <td><b>{a.role}</b></td>
                    <td>{a.department || '—'}</td>
                    <td>{a.employeeName ? `${a.employeeName} (${a.employeeCode})` : '—'}</td>
                    <td>{a.status}</td>
                    <td>{a.createdAt ? new Date(a.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Each login has its own password and its own access. Only the email is shared.
            No second employee record is made.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!checked} onChange={(e) => onCheck(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} />
            <span><b>Create another separate login on this email</b></span>
          </label>
          {!lookup.multiLoginOn && checked && (
            <div className="error-text" style={{ marginTop: 6 }}>
              This email is still locked to one login. A Super Admin must switch on “Several logins on one email” (the banner above) first.
            </div>
          )}
        </>
      )}
      {suggest && (
        <div className="small-muted" style={{ marginTop: lookup.count ? 8 : 0 }}>
          This email belongs to employee <b>{suggest.name}</b> ({suggest.employeeCode}).{' '}
          <button type="button" className="link-btn" onClick={() => onPickEmployee(suggest.id)}>Use this employee</button>
        </div>
      )}
    </div>
  );
}

// Shown once, right after a login is made: which login it is, and what happened to the activation mail.
export function CreatedLogin({ info, onDone }) {
  if (!info) return null;
  const act = info.activation;
  return (
    <div className="card section" style={{ borderColor: 'var(--green, #15803d)' }} data-testid="created-login">
      <h3 style={{ fontSize: 14, marginTop: 0 }}>Login created for {info.name}</h3>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{info.roleLabel}{info.department ? ` · ${info.department}` : ''}</div>
      <div className="small-muted" style={{ marginTop: 4 }}>Signs in with {info.email}</div>
      {act ? (
        <div style={{ marginTop: 10 }}>
          <div className={act.sent ? 'notice' : 'error-text'} style={{ display: 'block' }}>
            {act.sent
              ? `A mail with a link to choose a password was sent to ${info.email}. It names this login by its role.`
              : `The mail could not be sent (${act.status}). Pass this one-time link to the person yourself:`}
          </div>
          {!act.sent && act.link && (
            <div style={{ ...MONO, fontSize: 12, wordBreak: 'break-all', background: 'var(--bg-soft, #f3f4f6)', padding: 8, borderRadius: 6, marginTop: 6 }}>
              {act.link}<CopyButton text={act.link} label="Copy link" />
            </div>
          )}
          <div className="small-muted" style={{ marginTop: 6 }}>You never see the password. The person chooses it.</div>
        </div>
      ) : (
        <div className="small-muted" style={{ marginTop: 10 }}>Give the person the temporary password you typed. They must change it at the first sign-in.</div>
      )}
      <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={onDone}>Done</button>
    </div>
  );
}
