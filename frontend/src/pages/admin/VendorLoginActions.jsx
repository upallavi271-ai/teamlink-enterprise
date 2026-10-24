import { useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import './VendorLogins.css';

// ---------------------------------------------------------------------------
// ONE login's email status + actions (2026-10-19), shared by Administration > Vendors > Logins and the vendor window's "Vendor login"
// section (no second page). Plain words:
//   Account:     Waiting for activation  /  Active  /  Locked  /  Switched off     (the vendor has set a password = activated)
//   Invitation:  Invitation Pending / Sent / Failed / Expired   (+ attempts, last attempt, delivery)
//   "Sent" appears only after the mail server ACCEPTED the email; "Delivered" only when the mail provider confirmed it.
// Buttons: Send invitation / Resend invitation (until the vendor activates; EVERY click sends a new email with a new temporary password and
// a new link - the older ones stop working), Retry sending (after a failure), Send password reset (once activated), Edit email, Emails.
// The invitation always goes to the LOGIN email below, which is not the same thing as the vendor's contact email on the vendor record.
// The Admin never sees a password or a link here (a backup link appears only when email itself is not set up).
// ---------------------------------------------------------------------------
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const two = (n) => String(n).padStart(2, '0');
export const when = (s) => { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const newKey = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`);
const ACCOUNT_TONE = { waiting: 'yellow', active: 'green', locked: 'red', switched_off: 'grey', vendor_off: 'grey' };
const INV_TONE = { 'Invitation Pending': 'yellow', 'Invitation Sent': 'blue', 'Invitation Failed': 'red', 'Invitation Expired': 'grey', 'Account Active': 'green' };

// The status block of a login row.
export function LoginStatus({ row }) {
  const inv = row.invitation || {};
  const switchedOn = row.status === 'Active';
  return (
    <div className="vla-status">
      <div>
        <span className={`vp-tag vp-${ACCOUNT_TONE[row.accountStatus] || 'grey'}`}>{row.accountText}</span>{' '}
        <span className="cell-muted">{switchedOn ? 'Login switched on' : 'Login switched off'}</span>
        {row.activated && <div className="cell-muted">Activated {when(row.passwordChangedAt) !== '—' ? when(row.passwordChangedAt) : ''}</div>}
        {row.locked && <div className="cell-muted">locked until {when(row.lockedUntil)}</div>}
      </div>
      <div className="vla-inv">
        <span className={`vp-tag vp-${INV_TONE[inv.label] || 'grey'}`}>{inv.label || 'Invitation Pending'}</span>
        {!row.activated && (
          <div className="cell-muted">
            {inv.status === 'failed' && <div className="vla-red">{inv.reason}</div>}
            {inv.status === 'sent' || inv.status === 'delivered' ? <div>{inv.detail}</div> : null}
            {inv.status === 'expired' && <div>{inv.detail}</div>}
            {inv.status === 'not_sent' && <div>No invitation has been sent yet.</div>}
          </div>
        )}
        <div className="cell-muted">
          {row.emailAttempts ? `${row.emailAttempts} ${row.emailAttempts === 1 ? 'email' : 'emails'} sent or tried` : 'No email yet'}
          {row.lastAttempt ? ` · last attempt ${when(row.lastAttempt.at)}` : ''}
        </div>
        {row.lastDelivery && <div className="cell-muted">Delivery confirmed {when(row.lastDelivery.at)}</div>}
        {row.newestInvitation && <div className="cell-muted" title="Every Resend makes a new temporary password and a new link. The older ones stop working."><b>Newest invitation: #{row.newestInvitation.attemptNo}</b>, sent {when(row.newestInvitation.at)} to {row.newestInvitation.toEmail}.<br />Only this email&apos;s password works: older emails no longer do.</div>}
        {row.locked && !row.activated && <div className="cell-muted">The login is paused after wrong tries. <b>Resend invitation</b> (or Unlock) opens it at once.</div>}
      </div>
    </div>
  );
}

// The login email, and what is waiting to change.
export function LoginEmail({ row, contactEmail }) {
  return (
    <div className="vla-email">
      <div className="vla-mail" title="The email this vendor signs in with. The invitation goes here."><span className="cell-muted">Login email</span><br /><strong>{row.email}</strong></div>
      <div className="cell-muted">{row.emailStatusText}</div>
      {row.pendingEmail && (
        <div className="cell-muted">
          Change to <b>{row.pendingEmail.newEmail}</b> {row.pendingEmail.expired ? 'ran out (confirmation link expired)' : 'is waiting for the vendor to confirm'}. {row.email} still works.
        </div>
      )}
      {contactEmail !== undefined && contactEmail && contactEmail.toLowerCase() !== String(row.email).toLowerCase() && (
        <div className="cell-muted">Vendor contact email on the vendor record: {contactEmail}</div>
      )}
    </div>
  );
}

// The buttons. onDone(res.data) after a send (the parent shows the message, reloads, and shows a backup link when one comes back).
export function LoginActions({ row, vendorId, contactEmail, onDone, onError, onChanged }) {
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(null);
  const live = row.status === 'Active' && row.accountStatus !== 'vendor_off';

  // One click = one request with its own key; the button stays off while it is on its way (a double click cannot send twice).
  async function call(label, path, confirmText) {
    if (busy) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(label);
    try {
      const res = await api.post(`/vendor-logins/${row.id}/${path}`, {}, { headers: { 'Idempotency-Key': newKey() } });
      onDone(res.data);
    } catch (e) { onError(errText(e, 'Could not do that.')); } finally { setBusy(''); }
  }
  async function showHistory() {
    try { const r = await api.get(`/vendor-logins/${row.id}/emails`); setHistory(r.data.rows); } catch (e) { onError(errText(e, 'Could not load the emails.')); }
  }
  const failed = row.invitation && row.invitation.status === 'failed';
  const neverSent = !row.emailAttempts;
  return (
    <div className="vla-acts">
      {live && !row.activated && (failed
        ? <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => call('send', 'resend-invitation')}>{busy === 'send' ? 'Sending…' : 'Retry sending'}</button>
        : <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => call('send', 'resend-invitation')}>{busy === 'send' ? 'Sending…' : (neverSent ? 'Send invitation' : 'Resend invitation')}</button>)}
      {live && row.activated && (
        <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => call('reset', 'send-reset', `Email ${row.email} a link to choose a new password?`)}>{busy === 'reset' ? 'Sending…' : 'Send password reset'}</button>
      )}
      <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit email</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={showHistory}>Emails</button>
      {row.pendingEmail && <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => call('cancel', 'email-change/cancel')}>Cancel email change</button>}
      {editing && <EditEmail row={row} vendorId={vendorId} contactEmail={contactEmail} onClose={() => setEditing(false)} onDone={(d) => { setEditing(false); onDone(d); if (onChanged) onChanged(); }} onError={onError} />}
      {history && (
        <Modal title={`Emails sent to ${row.name}`} size="wide" onClose={() => setHistory(null)} footer={<button type="button" className="btn" onClick={() => setHistory(null)}>Close</button>}>
          {!history.length ? <div className="vp-none">No email has been sent for this login yet.</div> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>When</th><th>Email</th><th>Sent to</th><th>Result</th><th>By</th></tr></thead>
              <tbody>{history.map((h) => (
                <tr key={h.id}>
                  <td>{when(h.createdAt)}</td><td>{h.kindWord} #{h.attemptNo}</td><td>{h.toEmail}</td>
                  <td><b>{h.text}</b><div className="cell-muted">{h.detail}</div></td>
                  <td>{h.requestedByName || (h.requestedVia === 'vendor' ? 'The vendor' : 'System')}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Modal>
      )}
    </div>
  );
}

function EditEmail({ row, vendorId, contactEmail, onClose, onDone, onError }) {
  const [email, setEmail] = useState(row.email);
  const [alsoContact, setAlsoContact] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const clean = email.trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean);
  async function save() {
    if (busy) return;
    setErr('');
    if (!valid) { setErr('Enter a proper email address.'); return; }
    if (clean === String(row.email).toLowerCase()) { setErr('That is already the login email.'); return; }
    setBusy(true);
    try {
      const res = await api.patch(`/vendor-logins/${row.id}`, { email: clean, vendorId: row.vendorId, loginName: row.name }, { headers: { 'Idempotency-Key': newKey() } });
      let extra = '';
      if (alsoContact && vendorId) {
        try { await api.patch(`/vendor-master/${vendorId}`, { email: clean }); extra = ' The vendor contact email on the vendor record was updated too.'; } catch (e) { extra = ` The vendor record email was NOT changed: ${errText(e, 'it could not be saved')}.`; }
      }
      onDone({ ...res.data, message: `${res.data.message}${extra}` });
    } catch (e) { setErr(errText(e, 'Could not change the email.')); setBusy(false); }
  }
  return (
    <Modal title={`Edit login email · ${row.name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : (row.activated ? 'Ask the new address to confirm' : 'Change and send invitation')}</button></>}>
      <label htmlFor="vla-email">Login email (the vendor signs in with it)</label>
      <input id="vla-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
      <div className="small-muted" style={{ marginTop: 8 }}>
        {row.activated
          ? 'This vendor is active. We email the NEW address a confirmation link. The change counts only after the vendor opens it; until then the old email keeps working. The old address is told once the change is confirmed.'
          : 'This vendor has not activated yet. The same login moves to the new address, the old link and temporary password stop working, and a new invitation goes to the new address.'}
      </div>
      {contactEmail && contactEmail.toLowerCase() !== clean && (
        <label className="vl-switch" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={alsoContact} onChange={(e) => setAlsoContact(e.target.checked)} />
          <span>Also change the vendor&apos;s contact email on the vendor record<br /><span className="cell-muted">Now: {contactEmail}. Leave this unticked to change only the login email.</span></span>
        </label>
      )}
      {err && <div className="error-text" role="alert" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
