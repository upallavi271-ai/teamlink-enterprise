import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import '../../pages/portal/portal.css';

// ---------------------------------------------------------------------------
// "Invite to portal" for a CANDIDATE (spec B2, 2026-10-03).
// <PortalInviteButton kind="candidate" id={candidate.id} />
//
// Shows only for the candidate's own recruiter, their TL or the Admin
// (GET /api/portal/access/candidate/:id answers 200), and only once an
// application in their area is at Interview, Offer or Joining. The invite
// goes ONLY to the email on the candidate's record; the link opens nothing
// until the candidate types the one-time code we email them. No password is
// ever made or shown. (Client logins live on Client 360 -> Portal access.)
// ---------------------------------------------------------------------------
export default function PortalInviteButton({ kind, id }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!id || kind !== 'candidate') return;
    api.get(`/portal/access/candidate/${id}`)
      .then((r) => setInfo(r.data))
      .catch(() => setInfo(null));
  }, [kind, id]);
  useEffect(load, [load]);

  if (!info) return null;
  const { login } = info;
  if (!info.eligible && !login.exists) return null;

  function invite() {
    setBusy(true); setError(''); setResult(null);
    api.post(`/portal/invite/candidate/${id}`, {})
      .then((r) => { setResult(r.data); load(); })
      .catch((e) => setError(e.response?.data?.error || 'The invite could not be sent.'))
      .finally(() => setBusy(false));
  }

  return (
    <span className="tlp-invite">
      <button
        type="button"
        className={`btn btn-sm${info.recommended ? ' btn-primary' : ''}`}
        onClick={() => { setOpen(true); setResult(null); setError(''); }}
      >
        {login.exists ? 'Portal login' : 'Invite to portal'}
      </button>
      {login.exists && <span className="tlp-invite-state">{login.state}</span>}
      {open && (
        <Modal
          title="Candidate portal"
          onClose={() => setOpen(false)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>
              {!result && info.eligible && info.email && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={invite}>
                  {busy ? 'Sending…' : (login.exists ? 'Send the link again' : 'Send invite')}
                </button>
              )}
            </>
          )}
        >
          <div className="small-muted" style={{ marginBottom: 10 }}>
            The candidate sees their applications in simple words, interview details, can upload documents and accept the offer.
            Never your notes, scores or internal steps.
          </div>
          {info.email
            ? <div>The link goes to <b>{info.email}</b> (their own email). They confirm it with a code we send, then can choose a password. The link works once, for 48 hours.</div>
            : <div className="notice amber"><span>Add the candidate&apos;s email first — the invite goes only to their own email.</span></div>}
          {login.exists && (
            <div className="notice" style={{ marginTop: 10 }}>
              <span>Login: <b>{login.email}</b> — {login.state}{login.lastLoginAt ? ` (last sign-in ${new Date(login.lastLoginAt).toLocaleDateString('en-GB')})` : ''}.</span>
            </div>
          )}
          {error && <div className="notice red" style={{ marginTop: 10 }}><span>{error}</span></div>}
          {result && (
            <div style={{ marginTop: 10 }}>
              <div className="notice"><span>{result.sent ? `Invite sent to ${result.email}.` : result.status}</span></div>
              {result.link && (
                <div className="tlp-invite-link">
                  The email did not go out. Send this link to the candidate&apos;s own email yourself — it only works with the code we email them:<br />
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
