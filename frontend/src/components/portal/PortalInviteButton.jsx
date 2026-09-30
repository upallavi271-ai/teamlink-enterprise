import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import '../../pages/portal/portal.css';

// ---------------------------------------------------------------------------
// "Invite to portal" — gives a client contact or a candidate their OWN login
// (user notes #4, point 4). <PortalInviteButton kind="client" id={client.id} />
// or kind="candidate".
//
// Renders nothing unless GET /api/portal/access/:kind/:id answers 200, i.e.
// unless this login may invite (client: SA / Admin / the client's BDE;
// candidate: whoever edits the candidate, in scope). The login gets a
// single-use, expiring set-password link — never a password. Nothing is sent
// unless the inviter ticks "Email the link now".
// ---------------------------------------------------------------------------
export default function PortalInviteButton({ kind, id }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [send, setSend] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!id) return;
    api.get(`/portal/access/${kind}/${id}`)
      .then((r) => { setInfo(r.data); setEmail(r.data.login.exists ? r.data.login.email : (r.data.suggestedEmail || '')); })
      .catch(() => setInfo(null));
  }, [kind, id]);
  useEffect(load, [load]);

  if (!info) return null;
  const { login } = info;

  function invite() {
    setBusy(true); setError(''); setResult(null);
    api.post(`/portal/invite/${kind}/${id}`, { email, send })
      .then((r) => { setResult(r.data); load(); })
      .catch((e) => setError(e.response?.data?.error || 'The invite could not be created.'))
      .finally(() => setBusy(false));
  }

  return (
    <span className="tlp-invite">
      <button
        type="button"
        className={`btn btn-sm${info.recommended ? ' btn-primary' : ''}`}
        title={login.exists ? `Portal login: ${login.email} — ${login.state}` : 'No portal login yet'}
        onClick={() => { setOpen(true); setResult(null); setError(''); }}
      >
        {login.exists ? '🔑 Portal login' : '🔑 Invite to portal'}
      </button>
      {login.exists && <span className="tlp-invite-state">{login.state}</span>}
      {open && (
        <Modal
          title={kind === 'client' ? 'Client portal login' : 'Candidate portal login'}
          onClose={() => setOpen(false)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>
              {!result && (
                <button type="button" className="btn btn-primary" disabled={busy || !email} onClick={invite}>
                  {busy ? 'Working…' : (login.exists ? 'Send a new sign-in link' : 'Create login & invite')}
                </button>
              )}
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 10 }}>
            {kind === 'client'
              ? 'The client contact will see their company profile, requirements, the candidates you share with them (and give decisions), interviews, selected / joined candidates and their agreement. Never your internal notes or other clients.'
              : 'The candidate will see their applications with plain-language status, interview details, offers, and can update their profile, upload a resume and apply to open jobs. Never internal comments or scores.'}
          </div>
          {login.exists && (
            <div className="notice" style={{ marginBottom: 10 }}>
              <span>Login exists: <b>{login.email}</b> — {login.state}{login.lastLoginAt ? ` (last sign-in ${new Date(login.lastLoginAt).toLocaleDateString('en-GB')})` : ''}.</span>
            </div>
          )}
          <label className="field">
            <span>Email for the login</span>
            <input type="email" value={email} disabled={login.exists} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
            Email the sign-in link now
          </label>
          <div className="small-muted" style={{ marginTop: 6 }}>
            They get a one-time link to choose their own password (valid 48 hours). Passwords are never emailed.
          </div>
          {error && <div className="notice red" style={{ marginTop: 10 }}><span>{error}</span></div>}
          {result && (
            <div style={{ marginTop: 10 }}>
              <div className="notice"><span>{result.created ? 'Login created. ' : 'New link issued. '}{result.status}</span></div>
              {result.link && (
                <div className="tlp-invite-link">
                  Pass this link on yourself (shown once):<br />
                  <b>{result.link}</b>
                  <div style={{ marginTop: 6 }}>
                    <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard && navigator.clipboard.writeText(result.link)}>Copy link</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </span>
  );
}
