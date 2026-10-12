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

// ONLY THE MAIN FIELDS (user, 2026-10-09): what the client knows. TeamLink's BDE
// fills in the rest (description, qualification, notice period, posting sites...).
const EMPTY = { title: '', clientId: '', openings: 1, location: '', skills: '', experience: '', salaryMonthlyMin: '', salaryMonthlyMax: '', joinBy: '30', notes: '' };
const JOIN_BY = [['asap', 'As soon as possible'], ['15', 'Within 15 days'], ['30', 'Within a month'], ['later', 'No hurry']];

export default function RequestJobModal({ endpoint, clients = null, onClose, onSent }) {
  const [form, setForm] = useState({ ...EMPTY, clientId: clients && clients.length === 1 ? clients[0].id : '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // After Send: a plain "Sent to <BDE>. We'll confirm soon." screen (user, 2026-10-09).
  const [done, setDone] = useState(null);
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
        title="Request sent"
        onClose={finish}
        footer={<button type="button" className="btn btn-primary" onClick={finish}>Done</button>}
      >
        <div className="notice green" role="status" style={{ fontSize: 15 }}><b>{done.message || 'Request sent. We will confirm soon.'}</b></div>
        {clients ? (
          <ol style={{ margin: '12px 0 0', paddingLeft: 20, lineHeight: 1.7 }}>
            <li>Request <b>{done.reqCode}</b> is saved as a <b>Draft</b> in Jobs.</li>
            <li>The client&apos;s BDE and the BDE TL are told on screen.</li>
            <li>Open it from Jobs, fill in the rest and press <b>Save &amp; Post</b>.</li>
          </ol>
        ) : (
        <ol style={{ margin: '12px 0 0', paddingLeft: 20, lineHeight: 1.7 }}>
          <li>Your request <b>{done.reqCode}</b> is saved as <b>Waiting for confirmation</b>.</li>
          <li>{done.sentTo ? `${done.sentTo.name} (${done.sentTo.position || 'your TeamLink contact'}) checks it.` : 'TeamLink checks it.'}</li>
          <li>Then the job opens and we start finding people. You can follow it under <b>My Requirements</b>.</li>
        </ol>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title="Ask for a new job"
      note="Your TeamLink contact opens it"
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <label className="field">
          <span>Salary from (₹ per month)</span>
          <input className="input" type="number" min="0" value={form.salaryMonthlyMin} onChange={set('salaryMonthlyMin')} placeholder="e.g. 15000" />
        </label>
        <label className="field">
          <span>Salary up to (₹ per month)</span>
          <input className="input" type="number" min="0" value={form.salaryMonthlyMax} onChange={set('salaryMonthlyMax')} placeholder="e.g. 25000" />
        </label>
      </div>
      <label className="field">
        <span>Key skills</span>
        <input className="input" value={form.skills} onChange={set('skills')} placeholder="e.g. ICU, BLS" />
      </label>
      <div className="field">
        <span>When do you need them to join?</span>
        <div role="radiogroup" aria-label="When do you need them to join?" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {JOIN_BY.map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={form.joinBy === v}
              className={`btn btn-sm${form.joinBy === v ? ' btn-primary' : ''}`}
              onClick={() => setForm((f) => ({ ...f, joinBy: v }))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Anything else we should know</span>
        <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} />
      </label>
    </Modal>
  );
}
