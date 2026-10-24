// ---------------------------------------------------------------------------
// "ASK THE CLIENT MANAGER TO ADD A JOB" (user, 2026-10-13: creating a job is the BDE team's and above).
//
// A team lead (TL / STL) or a recruiter does not create a job. They tell the client manager (BDE) what they need:
// the job title, the client if they know it, and a short note. The client manager gets a bell (and a mail when company
// mail is connected) with those three things and nothing else. One press sends one request; the same request twice in
// a day says "already asked". POST /requirements/ask-add (backend utils/jobAsk.js).
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import useClientLabel from '../clients/useClientLabel.js'; // one company, many locations: "Name - Location" for same-name clients (2026-10-22)

export default function AskAddJobModal({ clients = [], onClose, onSent }) {
  const clientLabel = useClientLabel();
  const [form, setForm] = useState({ title: '', clientId: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function send() {
    if (form.title.trim().length < 2) { setError('Type the requirement you need, for example "Staff Nurse".'); return; }
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/requirements/ask-add', { title: form.title, clientId: form.clientId || undefined, notes: form.notes || undefined });
      setDone(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const finish = () => onSent?.(done);
    return (
      <Modal
        title="Asked"
        onClose={finish}
        footer={<button type="button" className="btn btn-primary" onClick={finish}>Done</button>}
      >
        <div className="notice green" role="status" style={{ fontSize: 15 }}><b>{done.message || 'Sent.'}</b></div>
        <p className="small-muted" style={{ marginTop: 10 }}>
          The client manager adds the requirement and gives it to your team lead. You will see it in Requirements when it is open.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Ask the client manager to add a requirement"
      note="The client manager (BDE) creates requirements"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
        </>
      )}
    >
      {error && <div className="notice red">{error}</div>}
      <label className="field">
        <span>Which requirement do you need?</span>
        <input className="input" value={form.title} onChange={set('title')} placeholder="e.g. Staff Nurse" maxLength={160} />
      </label>
      <label className="field">
        <span>Client (if you know it)</span>
        <Combo className="input" value={form.clientId} onChange={set('clientId')}>
          <option value="">I do not know</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{clientLabel(c)}</option>)}
        </Combo>
      </label>
      <label className="field">
        <span>Anything they should know? (optional)</span>
        <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} placeholder="e.g. 3 openings, needed by next month" maxLength={500} />
      </label>
    </Modal>
  );
}
