// REQUEST A NEW JOB (per-role spec 2026-10-03).
//
// A BDE no longer creates a job and a client asks for new hiring from the
// portal; both send a REQUEST that TeamLink (a Manager / Admin) reviews and
// opens. The server saves it as a Draft requirement (utils/requirementRequest.js)
// — nothing here goes live by itself.
//
//   endpoint  POST /requirements/requests             (BDE — their own clients)
//             POST /portal/client/requirement-requests (client — own company)
//   clients   the picker list for a BDE; omitted for a client (own company).
import { useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

const EMPTY = { title: '', clientId: '', openings: 1, location: '', skills: '', experience: '', notes: '' };

export default function RequestJobModal({ endpoint, clients = null, onClose, onSent }) {
  const [form, setForm] = useState({ ...EMPTY, clientId: clients && clients.length === 1 ? clients[0].id : '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function send() {
    if (!form.title.trim()) { setError('Enter the job title you need.'); return; }
    if (clients && !form.clientId) { setError('Pick the client this job is for.'); return; }
    setBusy(true);
    setError('');
    try {
      const body = { ...form, openings: Number(form.openings) || 1 };
      if (!clients) delete body.clientId;
      const res = await api.post(endpoint, body);
      onSent?.(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Request a job"
      note="Reviewed and opened by TeamLink"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
        </>
      )}
    >
      {error && <div className="notice red">{error}</div>}
      <label className="field">
        <span>Job title *</span>
        <input className="input" value={form.title} onChange={set('title')} placeholder="e.g. Staff Nurse" />
      </label>
      {clients && (
        <label className="field">
          <span>Client *</span>
          <select className="input" value={form.clientId} onChange={set('clientId')}>
            <option value="">— Select —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <label className="field">
          <span>Openings</span>
          <input className="input" type="number" min="1" value={form.openings} onChange={set('openings')} />
        </label>
        <label className="field">
          <span>Location</span>
          <input className="input" value={form.location} onChange={set('location')} />
        </label>
        <label className="field">
          <span>Experience (years)</span>
          <input className="input" value={form.experience} onChange={set('experience')} placeholder="e.g. 2-5" />
        </label>
      </div>
      <label className="field">
        <span>Key skills</span>
        <input className="input" value={form.skills} onChange={set('skills')} placeholder="e.g. ICU, BLS" />
      </label>
      <label className="field">
        <span>Anything else we should know</span>
        <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} />
      </label>
    </Modal>
  );
}
