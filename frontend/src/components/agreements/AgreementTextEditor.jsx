// ---------------------------------------------------------------------------
// EDIT THE AGREEMENT TEXT (founder 2026-10-31: "idhi edit chese option kuda bde ki undali, endhukantey, client konni points vaddhu
// antaru, ledha add cheyyamantaru"). The words of an agreement not yet signed: remove a point, add one, change a line.
// PUT /api/clients/:id/agreement/text decides who may (BDE while it is with the BDE or with the client; BDE TL; Admin) and keeps
// the signature block. A DigiLocker copy eSigned on the earlier words stops counting: TeamLink eSigns the new version again.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

export default function AgreementTextEditor({ clientId, text, onSaved, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const start = () => { setDraft(text || ''); setReason(''); setErr(''); setOpen(true); };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.put(`/clients/${clientId}/agreement/text`, { text: draft, reason });
      setOpen(false);
      if (onSaved) onSaved(r.data && r.data.message);
    } catch (e) {
      setErr(e.response?.data?.error || 'The text could not be saved. Please try again.');
    } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={start}>Edit agreement text</button>
      {open && (
        <Modal
          title="Edit agreement text"
          size="wide"
          onClose={() => !busy && setOpen(false)}
          footer={(
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy || !draft.trim()} onClick={save}>{busy ? 'Saving…' : 'Save the new text'}</button>
            </>
          )}
        >
          <div className="small-muted" style={{ fontSize: 12.5, marginBottom: 8, lineHeight: 1.5 }}>
            Change, remove or add points as the client asked. Keep the first line &quot;Vendor Services Agreement&quot; and the signature block at the end
            (Name: / Designation: / Sign: / Date:). If TeamLink already eSigned the earlier words, TeamLink eSigns the new version again, then Send to client again.
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck
            style={{ width: '100%', minHeight: 420, fontFamily: 'inherit', fontSize: 13.5, lineHeight: 1.55, padding: 10, boxSizing: 'border-box' }}
            aria-label="Agreement text"
          />
          <label className="field" style={{ marginTop: 8 }}>
            <span>What changed and why (for the history)</span>
            <input value={reason} maxLength={300} placeholder="e.g. Client asked to remove point 3d" onChange={(e) => setReason(e.target.value)} />
          </label>
          {err && <div className="error-text" role="alert">{err}</div>}
        </Modal>
      )}
    </>
  );
}
