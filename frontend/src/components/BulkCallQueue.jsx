import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal.jsx';
import Combo from './Combo.jsx';

// ---------------------------------------------------------------------------
// BULK CALL — a call queue over the selected candidates (user item 5).
//
// One candidate at a time: their number, a Call button that hands the number
// to this device's dialler (tel: — the phone itself on a mobile, Phone Link /
// Teams / a softphone on a desktop), then how it went, why, and notes.
// "Save & next" records it through the same POST /candidates/:id/contact the
// Contact panel uses (method Call), so it lands on the candidate's follow-up
// log and touches their open follow-up exactly like a single call.
//
// HONEST: no telephony provider is connected. The app does not place, record
// or time the call — it dials through your own device and logs what you tell
// it happened.
//
// items: [{ id, name, phone, latestApplicationId, requirementTitle, clientName }]
// ---------------------------------------------------------------------------

// Same number normalisation as ContactPanel: tel: wants the country code.
function intlDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}
const telHref = (phone) => `tel:+${intlDigits(phone)}`;

export default function BulkCallQueue({ items, onClose, onDone }) {
  const [vocab, setVocab] = useState(null);
  const [i, setI] = useState(0);
  const [purpose, setPurpose] = useState('');
  const [callResult, setCallResult] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [log, setLog] = useState([]); // { id, name, status: 'saved'|'skipped', result }

  useEffect(() => {
    api.get('/followups/statuses').then((r) => setVocab(r.data)).catch(() => setVocab(null));
  }, []);

  const total = items.length;
  const finished = i >= total;
  const cur = items[i] || null;
  const purposes = (vocab && vocab.templates && vocab.templates.candidate) || [];
  const results = (vocab && vocab.callResults) || [];

  function next(entry) {
    setLog((l) => [...l, entry]);
    setCallResult('');
    setNotes('');
    setError('');
    setI((x) => x + 1);
  }

  async function save() {
    if (!cur) return;
    setError('');
    if (!purpose) { setError('Choose why you are calling.'); return; }
    if (!callResult) { setError('Record how the call went.'); return; }
    setBusy(true);
    try {
      await api.post(`/candidates/${cur.id}/contact`, {
        method: 'Call', purpose, callResult, notes, applicationId: cur.latestApplicationId || undefined,
      });
      next({ id: cur.id, name: cur.name, status: 'saved', result: callResult });
    } catch (err) {
      setError(err.response?.data?.error || 'That call could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  const saved = log.filter((x) => x.status === 'saved').length;
  const close = () => { if (saved && onDone) onDone(); onClose(); };

  if (finished) {
    return (
      <Modal
        title="Call queue finished"
        onClose={close}
        footer={<button type="button" className="btn btn-primary" onClick={close}>Done</button>}
      >
        <div className="notice">
          <b>{saved}</b> call{saved === 1 ? '' : 's'} logged, <b>{log.length - saved}</b> skipped.
          Each logged call is on that candidate&apos;s follow-up log.
        </div>
        <div className="bcq-log">
          {log.map((x) => (
            <div key={x.id} className="bcq-log-row">
              <span>{x.name}</span>
              <span className={`status ${x.status === 'saved' ? 'active' : 'pending'}`}>
                {x.status === 'saved' ? x.result : 'Skipped'}
              </span>
            </div>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Call queue — ${i + 1} of ${total}`}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close}>Stop</button>
          <button type="button" className="btn" disabled={busy} onClick={() => next({ id: cur.id, name: cur.name, status: 'skipped' })}>Skip</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : (i + 1 < total ? 'Save & next →' : 'Save & finish')}
          </button>
        </>
      )}
    >
      <div className="bcq-progress" aria-hidden="true">
        <span style={{ width: `${Math.round((i / Math.max(total, 1)) * 100)}%` }} />
      </div>
      <div className="bcq-person">
        <div>
          <div className="bcq-name">{cur.name}</div>
          <div className="small-muted">
            {[cur.requirementTitle, cur.clientName, cur.stageLabel].filter(Boolean).join(' · ') || 'No application'}
          </div>
        </div>
        {cur.phone
          ? (
            <a className="btn btn-primary bcq-call" href={telHref(cur.phone)}>
              📞 Call {cur.phone}
            </a>
          )
          : <span className="status rejected">No phone on file</span>}
      </div>
      <div className="small-muted" style={{ marginBottom: 10 }}>
        Dials from your own phone or softphone — no telephony provider is connected, so the app logs the result you
        record here; it does not place or record the call.
      </div>
      <div className="grid-2">
        <label className="field">
          <span>Why are you calling? *</span>
          <Combo value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">Choose…</option>
            {purposes.map((p) => <option key={p} value={p}>{p}</option>)}
          </Combo>
        </label>
        <label className="field">
          <span>How did it go? *</span>
          <Combo value={callResult} onChange={(e) => setCallResult(e.target.value)}>
            <option value="">Choose…</option>
            {results.map((r) => <option key={r} value={r}>{r}</option>)}
          </Combo>
        </label>
      </div>
      <label className="field">
        <span>Notes</span>
        <textarea rows="3" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was said" />
      </label>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
