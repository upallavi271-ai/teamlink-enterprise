// ---------------------------------------------------------------------------
// "ASK THE CLIENT MANAGER TO EDIT OR CLOSE THIS JOB" (user, 2026-10-13: editing and closing a job is the BDE team's and above).
// A TL / STL / Recruiter picks "Change something" or "Close it", types a short note, and the client manager (BDE) gets a bell
// (and a mail when company mail is connected). Only the job and the note are sent. POST /requirements/:id/ask-change.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

export default function AskChangeJobModal({ jobId, title, onClose }) {
  const [what, setWhat] = useState('edit');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  async function send() {
    if (what === 'edit' && notes.trim().length < 3) { setError('Say what should change, for example "openings 2 to 5".'); return; }
    setBusy(true); setError('');
    try {
      const res = await api.post(`/requirements/${jobId}/ask-change`, { what, notes: notes || undefined });
      setDone(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send. Please try again.');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <Modal title="Asked" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="notice green" role="status" style={{ fontSize: 15 }}><b>{done.message || 'Sent.'}</b></div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Ask the client manager to edit or close this requirement"
      note={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
        </>
      )}
    >
      {error && <div className="notice red">{error}</div>}
      <div className="field">
        <span>What do you need?</span>
        <div role="radiogroup" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[['edit', 'Change something'], ['close', 'Close this requirement']].map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={what === v} className={`btn btn-sm${what === v ? ' btn-primary' : ''}`} onClick={() => setWhat(v)}>{label}</button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>{what === 'edit' ? 'What should change?' : 'Why close it? (optional)'}</span>
        <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder={what === 'edit' ? 'e.g. openings 2 to 5' : 'e.g. the client filled it'} />
      </label>
    </Modal>
  );
}
