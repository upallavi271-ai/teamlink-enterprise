import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import './jobdup.css';

// ---------------------------------------------------------------------------
// "THIS LOOKS LIKE A JOB YOU ALREADY HAVE" — the card the Add job / Request a job / Open job forms show when the server answers
// 409 DUPLICATE_JOB (utils/jobDupGuard.js). `dup` = that 409 body (+ { kind }).
//
//   Open the existing job                  a link (new tab): look first
//   Add openings to the existing job       adds N openings to that job (audited) and opens it; nothing new is created
//   Create anyway (it is a different job)  a short reason (needed when the job is an exact twin), remembered as "Not a duplicate"
//   Cancel                                 back to the form, nothing saved
// The older single-job answer (the edit form) still works: the same card with one job.
// ---------------------------------------------------------------------------
const day = (v) => { try { return new Date(v).toISOString().slice(0, 10); } catch { return ''; } };
const plainStatus = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');

export default function DuplicateJobWarning({ dup, editing = false, onCancel, onCreateAnyway }) {
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [add, setAdd] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  if (!dup || !(dup.matches || dup.existing)) return null;
  const list = dup.matches && dup.matches.length ? dup.matches : [{ ...dup.existing, candidates: null, canAddOpenings: false }];
  const needs = dup.needsReason !== false;
  const ok = !needs || reason.trim().length >= 5;

  async function addOpenings(m) {
    setBusy(m.id); setError('');
    try {
      const r = await api.post('/job-duplicates/add-openings', { jobId: m.id, add: Number(add[m.id]) || 1 });
      navigate(`/requirements/${m.id}`, { state: { notice: r.data.message } });
    } catch (e) { setError(e.response?.data?.error || 'Could not add the openings.'); } finally { setBusy(''); }
  }

  return (
    <div className="jdup-card" role="alert">
      <b className="jdup-title">{editing ? 'This now looks like another requirement you already have.' : 'This looks like a requirement you already have.'}</b>
      {list.map((m) => (
        <div key={m.id} className="jdup-job">
          <div>
            <Link to={`/requirements/${m.id}`} target="_blank" rel="noreferrer"><b>{m.title}</b>{m.reqCode ? ` (${m.reqCode})` : ''}</Link>
            <span className="small-muted">
              {` · ${plainStatus(m.status)}`}
              {m.candidates != null ? ` · ${m.candidates} ${m.candidates === 1 ? 'person' : 'people'} on it` : ''}
              {m.createdAt ? ` · opened ${day(m.createdAt)}` : ''}
              {m.location ? ` · ${m.location}` : ''}
              {m.openings ? ` · ${m.openings} opening${m.openings === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          <div className="jdup-row">
            <Link className="btn btn-sm" to={`/requirements/${m.id}`} target="_blank" rel="noreferrer">Open the existing requirement</Link>
            {m.canAddOpenings && !editing && (
              <span className="jdup-add">
                <input type="number" min="1" max="500" aria-label="How many openings to add" value={add[m.id] || 1} onChange={(e) => setAdd((a) => ({ ...a, [m.id]: e.target.value }))} />
                <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => addOpenings(m)}>{busy === m.id ? 'Adding…' : 'Add openings to the existing requirement'}</button>
              </span>
            )}
          </div>
        </div>
      ))}
      <div className="small-muted" style={{ margin: '8px 0 6px' }}>
        {editing ? 'Save anyway only if this really is a second requirement.' : 'Only create it anyway if it really is a different requirement.'}{needs ? ' Say why, it is recorded.' : ''}
      </div>
      <div className="jdup-row">
        <input className="jdup-reason" maxLength={300} placeholder={needs ? 'Why a different requirement? e.g. another ward, second batch' : 'Why a different requirement? (optional)'} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="btn btn-sm" disabled={!ok} onClick={() => onCreateAnyway(reason.trim())}>{editing ? 'Save anyway (different requirement)' : 'Create anyway (different requirement)'}</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {error && <div className="notice red" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
