import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import Combo from '../Combo.jsx';
import { PRIORITY_CHOICES, priorityLabel } from './reqFormat.jsx';

// ---------------------------------------------------------------------------
// BULK ACTIONS on selected requirements (ATS review #2 §21), also used by the
// quick drawer's "Assign Recruiter" with a single row:
//   assign-recruiter   Assign Recruiter    Requirement Detail / assign
//   assign-tl          Assign TL           Requirement Detail / assign
//   priority           Change Priority     Requirement Detail / approve
// Every row goes through POST /requirements/bulk, which checks the permission
// once and then each row's scope and assignment on its own, and reports each
// row. (Export is the ordinary export with the selected ids — see
// Requirements.jsx.)
//
// items: [{ id, reqCode, title }]
// ---------------------------------------------------------------------------
const BATCH = 100;
const TITLES = {
  'assign-recruiter': 'Assign recruiter',
  'assign-tl': 'Assign TL',
  priority: 'Change priority',
};

export default function RequirementBulk({ kind, items, onClose, onDone }) {
  const [people, setPeople] = useState(null);
  const [userId, setUserId] = useState('');
  const [priority, setPriority] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (kind === 'priority') return;
    const role = kind === 'assign-tl' ? 'TL' : 'RECRUITER';
    api.get('/requirements/assignable-people')
      .then((r) => setPeople((r.data || []).filter((p) => (p.atsRole || p.role) === role)))
      .catch(() => { setPeople([]); setError('Could not load the people you can assign.'); });
  }, [kind]);

  const ready = kind === 'priority' ? !!priority : !!userId;
  const one = items.length === 1;

  async function run() {
    setError('');
    setBusy(true);
    const all = [];
    try {
      for (let i = 0; i < items.length; i += BATCH) {
        const ids = items.slice(i, i + BATCH).map((x) => x.id);
        // eslint-disable-next-line no-await-in-loop
        const res = await api.post('/requirements/bulk', kind === 'priority' ? { action: kind, ids, priority } : { action: kind, ids, userId });
        all.push(...(res.data.results || []));
      }
      setResult(all);
      if (all.some((x) => x.ok) && onDone) onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'The action could not be completed.');
      if (all.length) setResult(all);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const okRows = result.filter((x) => x.ok);
    const bad = result.filter((x) => !x.ok);
    return (
      <Modal
        title={`${TITLES[kind]} — done`}
        onClose={onClose}
        footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}
      >
        <div className={`notice${bad.length ? ' amber' : ''}`}>
          <span>
            <b>{okRows.length}</b>
            {` of ${result.length} changed.`}
            {bad.length > 0 && <>{' '}<b>{bad.length}</b> not changed — reasons below.</>}
          </span>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="reqbulk-results">
          {result.map((x) => (
            <div key={x.id} className="reqbulk-row">
              <span><b>{x.reqCode || x.id.slice(0, 8)}</b>{x.title ? ` · ${x.title}` : ''}</span>
              <span className={`status ${x.ok ? 'active' : x.skipped ? 'pending' : 'rejected'}`}>
                {x.ok ? (kind === 'priority' ? `→ ${priorityLabel(x.to)}` : `→ ${x.to}`) : x.error}
              </span>
            </div>
          ))}
        </div>
      </Modal>
    );
  }

  const label = kind === 'assign-tl' ? 'TL' : 'Recruiter';
  const lower = kind === 'assign-tl' ? 'TL' : 'recruiter';
  return (
    <Modal
      title={`${TITLES[kind]} — ${one ? (items[0].reqCode || items[0].title) : `${items.length} requirements`}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={run}>
            {busy ? 'Working…' : `${TITLES[kind]}${one ? '' : ` (${items.length})`}`}
          </button>
        </>
      )}
    >
      {kind === 'priority' ? (
        <label className="field">
          <span>Priority *</span>
          <Combo value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">Choose…</option>
            {PRIORITY_CHOICES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Combo>
        </label>
      ) : (
        <label className="field">
          <span>{`${label} *`}</span>
          <Combo value={userId} onChange={(e) => setUserId(e.target.value)} disabled={people === null}>
            <option value="">{people === null ? 'Loading…' : people.length ? 'Choose…' : `No ${lower} on your team`}</option>
            {(people || []).map((p) => (
              <option key={p.id} value={p.id}>
                {`${p.name}${p.seat ? ` · ${p.seat.code || p.seat}` : ''}${p.atsDepartment ? ` · ${p.atsDepartment}` : ''}`}
              </option>
            ))}
          </Combo>
        </label>
      )}
      <div className="small-muted" style={{ marginBottom: 8 }}>
        {kind === 'priority'
          ? 'Each change is written to the requirement’s activity trail. Requirements you can view but are not assigned to are skipped and listed.'
          : `Each requirement is checked on its own: ones outside your access, or assigned to someone else, are skipped and listed with the reason. Only people on your own team are offered — and accepted by the server. The new ${lower} is notified in the app.`}
      </div>
      {!one && (
        <div className="reqbulk-results" style={{ maxHeight: 160 }}>
          {items.map((x) => <div key={x.id} className="reqbulk-row"><span><b>{x.reqCode || x.id.slice(0, 8)}</b>{x.title ? ` · ${x.title}` : ''}</span></div>)}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}
