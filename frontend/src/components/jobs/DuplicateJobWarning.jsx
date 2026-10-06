import { useState } from 'react';
import { Link } from 'react-router-dom';

// ---------------------------------------------------------------------------
// B9.1 — DUPLICATE JOB WARNING (Add job / Edit job).
// The server answered 409 DUPLICATE_JOB: the same client already has this
// job open. Show that job, and offer "Create anyway" with a reason (the
// reason goes into the audit trail). `dup` = the 409 body + { kind }.
// ---------------------------------------------------------------------------
export default function DuplicateJobWarning({ dup, editing = false, onCancel, onCreateAnyway }) {
  const [reason, setReason] = useState('');
  if (!dup || !dup.existing) return null;
  const x = dup.existing;
  const ok = reason.trim().length >= 5;
  return (
    <div className="notice amber" role="alert" style={{ flex: '1 1 100%', margin: '0 0 8px', textAlign: 'left' }}>
      <b>This job is already open for this client.</b>
      <div style={{ margin: '4px 0' }}>
        <Link to={`/requirements/${x.id}`} target="_blank" rel="noreferrer">{x.reqCode || 'Open job'} · {x.title}{x.location ? ` · ${x.location}` : ''}</Link>
        {x.openings ? <span className="small-muted"> · {x.openings} opening{x.openings === 1 ? '' : 's'}</span> : null}
      </div>
      <div className="small-muted" style={{ marginBottom: 6 }}>
        {editing ? 'Save anyway only if this really is a second job.' : 'Add people to that job instead, or create anyway only if this really is a second job.'} Say why — it is recorded.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ flex: '1 1 220px' }}
          maxLength={300}
          placeholder="Why a second job? e.g. second batch, different shift"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="button" className="btn btn-sm" onClick={onCancel}>Go back</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!ok} onClick={() => onCreateAnyway(reason.trim())}>
          {editing ? 'Save anyway' : 'Create anyway'}
        </button>
      </div>
    </div>
  );
}
