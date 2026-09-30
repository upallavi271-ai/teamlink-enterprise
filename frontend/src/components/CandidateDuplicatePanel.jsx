import { useState } from 'react';
import api from '../api';
import Combo from './Combo.jsx';
import { protoDate } from '../atsVocab';

// ---------------------------------------------------------------------------
// "CANDIDATE ALREADY EXISTS" (review #2 §12) — shown on the Add Candidate form
// when the phone or email typed belongs to somebody already on file.
//
//   [Open Candidate]      the existing profile (only if this login may see it)
//   [Add to Requirement]  a new APPLICATION for the existing person — one
//                         Candidate Master, many applications
//   [Create New Profile]  an explicit, audit-logged override
//
// `possible` (name-only resemblance) is listed as a hint underneath; it never
// blocks the save.
// ---------------------------------------------------------------------------
const WHY = { phone: 'same phone', email: 'same email', name: 'same name' };

export default function CandidateDuplicatePanel({
  matches, possible, requirements, defaultRequirementId, canApply, onOpen, onApplied, onCreateNew,
}) {
  const [reqFor, setReqFor] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState({});

  async function addTo(m) {
    const requirementId = reqFor[m.id] || defaultRequirementId;
    if (!requirementId) { setError('Choose the requirement to add them to.'); return; }
    setBusy(m.id);
    setError('');
    try {
      await api.post('/applications', { candidateId: m.id, requirementId, comment: 'Added from Add Candidate — the person was already on file' });
      setDone((d) => ({ ...d, [m.id]: true }));
      if (onApplied) onApplied(m);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add them to this requirement.');
    } finally {
      setBusy('');
    }
  }

  const open = (requirements || []).filter((r) => r.status !== 'CLOSED');
  return (
    <div className="cdup-exists">
      {matches.length > 0 && (
        <>
          <div className="cdup-exists-title">Candidate already exists</div>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            One person keeps one profile — add them to the requirement instead of creating a second record.
          </div>
          {matches.map((m) => (
            <div key={m.id} className="cdup-exists-card">
              <div className="cdup-exists-head">
                <div style={{ minWidth: 0 }}>
                  <b>{m.name}</b>
                  <span className="small-muted">{` · ${[m.phone, m.email, m.location].filter(Boolean).join(' · ')}`}</span>
                  <div className="cdup-exists-why">
                    {m.reasons.map((r) => <span key={r} className={`cdup-why cdup-why-${r}`}>{WHY[r] || r}</span>)}
                    <span className="small-muted">{`on file since ${protoDate(m.createdAt)}`}</span>
                  </div>
                </div>
              </div>
              {m.inScope ? (
                <div className="cdup-exists-apps">
                  {m.applications.length === 0 && <div className="small-muted">No applications yet.</div>}
                  {m.applications.slice(0, 5).map((a) => (
                    <div key={a.id} className="cdup-exists-app">
                      <span>{a.requirementTitle || '—'}<span className="small-muted">{` · ${a.clientName || '—'}`}</span></span>
                      <span className="small-muted">{`${a.stageLabel} · ${protoDate(a.createdAt)}`}</span>
                    </div>
                  ))}
                  {m.applications.length > 5 && <div className="small-muted">{`+${m.applications.length - 5} more`}</div>}
                  {m.otherTeamApplications > 0 && <div className="small-muted">{`${m.otherTeamApplications} more application(s) with another team.`}</div>}
                </div>
              ) : (
                <div className="small-muted cdup-exists-apps">
                  {`This profile sits with another team (${m.applicationCount} application${m.applicationCount === 1 ? '' : 's'}). You can still add them to one of your requirements.`}
                </div>
              )}
              <div className="cdup-exists-actions">
                {m.inScope && <button type="button" className="btn btn-sm" onClick={() => onOpen(m)}>Open Candidate</button>}
                {canApply && !done[m.id] && (
                  <>
                    <Combo value={reqFor[m.id] || defaultRequirementId || ''} onChange={(e) => setReqFor((x) => ({ ...x, [m.id]: e.target.value }))}>
                      <option value="">Choose requirement…</option>
                      {open.map((r) => (
                        <option key={r.id} value={r.id} disabled={m.applications.some((a) => a.requirementId === r.id)}>
                          {`${r.title} — ${r.internal ? 'TeamLink Internal' : r.client?.name || '—'}`}
                        </option>
                      ))}
                    </Combo>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy === m.id} onClick={() => addTo(m)}>
                      {busy === m.id ? 'Adding…' : 'Add to Requirement'}
                    </button>
                  </>
                )}
                {done[m.id] && <span className="status active">Added to the requirement</span>}
              </div>
            </div>
          ))}
          <div className="cdup-exists-foot">
            <span className="small-muted">A genuinely different person with the same phone or email?</span>
            <button type="button" className="btn btn-sm btn-danger" onClick={onCreateNew}>Create New Profile</button>
          </div>
        </>
      )}
      {possible && possible.length > 0 && (
        <div className="cdup-possible">
          <b>Possible match (same name only — not blocking):</b>
          {possible.map((m) => (
            <div key={m.id} className="small-muted">
              {`${m.name} · ${[m.phone, m.email].filter(Boolean).join(' · ') || 'no contact on file'}`}
              {m.inScope && <> · <button type="button" className="link-btn" onClick={() => onOpen(m)}>open</button></>}
            </div>
          ))}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
