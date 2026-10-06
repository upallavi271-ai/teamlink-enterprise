// ---------------------------------------------------------------------------
// THE AGREEMENT LINK CARD (2026-10-05) — Super Admin / Admin.
//
//   no link yet   "Works for 14 days"  [🔗 Create agreement link]
//   link ready    the link · works until …   [Copy link] [Open WhatsApp] [Email to client]
//                 Make a new link · Stop this link
//
// The client opens the link without a login, reads the agreement, gets a code
// by email and presses "I agree and sign" (pages/AgreementSigning.jsx).
// Nothing is sent by making the link: WhatsApp opens the user's own WhatsApp
// with the message ready, and Email goes only when "Email to client" is
// pressed. GET / POST /agreement/:clientId/link (routes/agreementLinkRoutes.js)
// decide who may do this — the server refuses anyone else.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import './agreementLink.css';
import TeamLinkSignerNotice from './TeamLinkSignerNotice.jsx';

const DAY_CHOICES = [7, 14, 30];
function day(d) {
  return d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
}

async function copyText(text, input) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back below */ }
  try {
    if (input) { input.focus(); input.select(); }
    return document.execCommand('copy');
  } catch { return false; }
}

export default function AgreementLinkCard({ clientId, onChanged }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [days, setDays] = useState(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [inputEl, setInputEl] = useState(null);

  const load = useCallback(() => {
    api.get(`/agreement/${clientId}/link`)
      .then((r) => { setInfo(r.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the agreement link.'));
  }, [clientId]);
  useEffect(load, [load]);

  if (!info) return error ? <div className="agrlink"><div className="notice red">{error}</div></div> : null;
  const chosen = days || info.defaultDays || 14;
  const choices = [...new Set([...DAY_CHOICES, info.defaultDays || 14])].sort((a, b) => a - b);

  async function run(key, fn, ok) {
    setBusy(key); setError(''); setNote('');
    try {
      const r = await fn();
      if (r && r.data && r.data.status) setInfo(r.data);
      if (ok) setNote(typeof ok === 'function' ? ok(r) : ok);
      if (onChanged) onChanged();
      return r;
    } catch (err) {
      setError(err.response?.data?.error || 'That did not work. Please try again.');
      return null;
    } finally { setBusy(''); }
  }

  const make = () => run('make', () => api.post(`/agreement/${clientId}/link`, { days: chosen }), (r) => `Link ready. It works until ${day(r.data.expiresAt)}. Copy it or send it below.`);
  const copy = async () => {
    const done = await copyText(info.url, inputEl);
    setError(''); setNote(done ? 'Link copied. Paste it in a message to the client.' : 'Could not copy. Select the link and copy it.');
  };
  const whatsapp = () => {
    window.open(info.whatsappUrl, '_blank', 'noopener');
    setError(''); setNote(info.whatsappTo ? `WhatsApp opened with the message for ${info.whatsappTo}. Press send there.` : 'WhatsApp opened. Pick the client and press send there.');
  };
  const email = () => run('email', () => api.post(`/agreement/${clientId}/link/email`, {}), (r) => (r.data.sandbox
    ? `Test mode: email to ${info.emailTo} made, but not really sent.`
    : `Sent. The link was emailed to ${info.emailTo}.`));
  const stop = () => run('stop', () => api.post(`/agreement/${clientId}/link/revoke`, {}), 'Stopped. The old link no longer works. The agreement is back to Draft.').then(() => setConfirmStop(false));

  return (
    <div className="agrlink" aria-label="Agreement link">
      <div className="agrlink-head">🔗 Agreement link</div>
      <TeamLinkSignerNotice />
      {note && <div className="notice agrlink-note" role="status">{note}</div>}
      {error && <div className="notice red agrlink-note" role="alert">{error}</div>}

      {!info.live && info.blocked && <div className="small-muted">{info.blocked}</div>}

      {!info.live && !info.blocked && (
        <>
          {info.stoppedAt && <div className="agrlink-warn">{`The last link was stopped on ${day(info.stoppedAt)}.`}</div>}
          {info.expired && <div className="agrlink-warn">The last link ended. Make a new one.</div>}
          <div className="agrlink-lead">Make a safe link for the client. They open it, read the agreement and sign. No login needed.</div>
          <div className="agrlink-row">
            <label className="agrlink-days">
              <span>Works for</span>
              <select value={chosen} onChange={(e) => setDays(Number(e.target.value))}>
                {choices.map((d) => <option key={d} value={d}>{`${d} days`}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-primary agrlink-main" disabled={!!busy || !info.canMake} onClick={make}>
              {busy === 'make' ? 'Making…' : '🔗 Create agreement link'}
            </button>
          </div>
        </>
      )}

      {info.live && (
        <>
          <input
            ref={setInputEl}
            className="agrlink-url"
            readOnly
            value={info.url}
            onFocus={(e) => e.target.select()}
            aria-label="Agreement link"
          />
          <div className="small-muted agrlink-meta">
            {`Works until ${day(info.expiresAt)}`}
            {info.viewedAt ? ` · The client opened it on ${day(info.viewedAt)}` : ' · Not opened yet'}
          </div>
          <div className="agrlink-row">
            <button type="button" className="btn btn-primary agrlink-main" onClick={copy}>Copy link</button>
            <button type="button" className="btn agrlink-wa" onClick={whatsapp}>Open WhatsApp</button>
            <button type="button" className="btn" disabled={!!busy || !info.emailTo} title={info.emailTo ? `Email to ${info.emailTo}` : 'No email on this client'} onClick={email}>
              {busy === 'email' ? 'Sending…' : 'Email to client'}
            </button>
          </div>
          {info.emailTo && <div className="small-muted agrlink-meta">{`The code to sign goes to ${info.emailTo}.`}</div>}
          {!confirmStop ? (
            <div className="agrlink-row agrlink-small">
              <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={make}>{busy === 'make' ? 'Making…' : 'Make a new link'}</button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => setConfirmStop(true)}>Stop this link</button>
            </div>
          ) : (
            <div className="agrlink-confirm">
              <span>Stop this link? The client will not be able to open it.</span>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmStop(false)}>Keep it</button>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy === 'stop'} onClick={stop}>{busy === 'stop' ? 'Stopping…' : 'Stop link'}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
