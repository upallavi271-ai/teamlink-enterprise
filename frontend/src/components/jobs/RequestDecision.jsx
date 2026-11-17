// ---------------------------------------------------------------------------
// REJECT / RE-SUBMIT A REQUIREMENT REQUEST (founder ATS audit 2026-11-17).
//   <RejectRequestButton r onDone />   the BDE TL / a Manager / an Admin: a reason from the list + a note ("Other" needs one)
//   <RejectedBanner r onDone />        "Rejected: <reason>" on the request; the BDE edits it and presses Re-submit
// Server: POST /requirements/:id/reject-request, POST /requirements/:id/resubmit-request (routes/requirements.js).
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';

const errText = (e, f) => (e && e.response && e.response.data && e.response.data.error) || f;
// Who decides on a request (the server checks again): the BDE TL, a Manager / Asst Manager, Super Admin / Admin.
export function mayDecideRequest(user) {
  if (!user) return false;
  if (['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return true;
  if (['MANAGER', 'ASSISTANT_MANAGER'].includes(user.atsRole)) return true;
  return !!(user.workflow && user.workflow.bdeTl);
}

export function RejectRequestButton({ r, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reasons = r.requestRejectReasons || [];
  const ready = !!reason && (reason !== 'Other' || note.trim().length >= 3);
  async function go() {
    setBusy(true); setError('');
    try {
      await api.post(`/requirements/${r.id}/reject-request`, { reason, note });
      setOpen(false);
      onDone(`Rejected: ${reason}. The BDE is told and can edit and re-submit it.`);
    } catch (e) { setError(errText(e, 'Could not reject it. Please try again.')); } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className="btn btn-sm btn-danger" onClick={() => setOpen(true)}>Reject request</button>
      {open && (
        <Modal
          title={`Reject request — ${r.reqCode || r.title}`}
          onClose={() => setOpen(false)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-danger" disabled={busy || !ready} onClick={go}>{busy ? 'Saving…' : 'Reject'}</button>
            </>
          )}
        >
          <label className="field"><span>Reason</span>
            <Combo value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Pick a reason</option>
              {reasons.map((x) => <option key={x} value={x}>{x}</option>)}
            </Combo>
          </label>
          <label className="field" style={{ marginTop: 8 }}>
            <span>{reason === 'Other' ? 'Note (needed)' : 'Note (what should change)'}</span>
            <textarea rows="3" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Salary band not given" />
          </label>
          <div className="small-muted">The BDE gets a bell with your reason. The request stays; they edit it and re-submit it.</div>
          {error && <div className="error-text">{error}</div>}
        </Modal>
      )}
    </>
  );
}

export function RejectedBanner({ r, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rj = r.requestRejection;
  if (!rj) return null;
  async function resubmit() {
    setBusy(true); setError('');
    try {
      await api.post(`/requirements/${r.id}/resubmit-request`, { note });
      onDone('Re-submitted. It waits for the BDE TL again.');
    } catch (e) { setError(errText(e, 'Could not re-submit it.')); } finally { setBusy(false); }
  }
  return (
    <div className="notice amber" role="status" style={{ marginBottom: 10, display: 'block' }}>
      <b>{rj.text}</b>
      <span className="small-muted">{` · by ${rj.byName || '—'}${rj.at ? ` on ${new Date(rj.at).toLocaleDateString('en-GB')}` : ''}`}</span>
      {r.requestCanResubmit && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <span>Edit the request (Edit requirement), then re-submit it.</span>
          <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="What changed (optional after an edit)" style={{ minWidth: 220 }} />
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={resubmit}>{busy ? 'Sending…' : 'Re-submit'}</button>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
