import { useRef, useState } from 'react';
import api from '../api';
import { JobPickerCombo } from './JobPicker.jsx';
import { protoDate } from '../atsVocab';
import { usePairCheck, AlreadyAppliedNotice } from './applications/AlreadyApplied.jsx';

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
  matches, possible, defaultRequirementId, canApply, onOpen, onApplied, onCreateNew,
}) {
  const [reqFor, setReqFor] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState({});

  const lock = useRef(false);
  async function addTo(m) {
    const requirementId = reqFor[m.id] || defaultRequirementId;
    if (!requirementId) { setError('Choose the requirement to add them to.'); return; }
    if (lock.current) return; // double click: one application only
    lock.current = true;
    setBusy(m.id);
    setError('');
    try {
      await api.post('/applications', { candidateId: m.id, requirementId, comment: 'Added from Add Candidate — the person was already on file' });
      setDone((d) => ({ ...d, [m.id]: true }));
      if (onApplied) onApplied(m);
    } catch (err) {
      // 'Already on this job': the box on screen says where; nothing more to show here.
      if (!err.alreadyApplied) setError(err.response?.data?.error || 'Could not add them to this requirement.');
    } finally {
      lock.current = false;
      setBusy('');
    }
  }

  return (
    <div className="cdup-exists">
      {matches.length > 0 && (
        <>
          <div className="cdup-exists-title">This person is already on file</div>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            One person keeps one profile. Open it, or add them to a requirement — no second profile is made.
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
                  {m.heldBy && (
                    <div className="cdup-heldby">
                      {`Already with ${m.heldBy.name || 'a team'}${m.heldBy.department ? ` (${m.heldBy.department})` : ''}`}
                      {m.archived ? ' · archived' : ''}
                    </div>
                  )}
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
                {m.inScope && <button type="button" className="btn btn-sm" onClick={() => onOpen(m)}>Open profile</button>}
                {canApply && !done[m.id] && (
                  <>
                    <JobPickerCombo
                      value={reqFor[m.id] || defaultRequirementId || ''}
                      onChange={(e) => setReqFor((x) => ({ ...x, [m.id]: e.target.value }))}
                      blank="Choose a requirement…"
                      disabledIds={m.applications.map((a) => a.requirementId)}
                    />
                    <AddButton m={m} requirementId={reqFor[m.id] || defaultRequirementId || ''} busy={busy === m.id} onAdd={() => addTo(m)} />
                  </>
                )}
                {done[m.id] && <span className="status active">Added to the requirement</span>}
              </div>
            </div>
          ))}
          {onCreateNew && (
            <div className="cdup-exists-foot">
              <span className="small-muted">Admin only: a really different person with the same phone or email?</span>
              <button type="button" className="btn btn-sm btn-danger" onClick={onCreateNew}>Create a second profile</button>
            </div>
          )}
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

// The Add button + the 'already on this job' notice, shown BEFORE the click (one pair-check per picked job).
function AddButton({ m, requirementId, busy, onAdd }) {
  const check = usePairCheck(m.id, requirementId);
  const stop = check.exists || !!check.blocked;
  return (
    <>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy || stop} onClick={onAdd}>
        {busy ? 'Adding...' : 'Add an application'}
      </button>
      <div style={{ flexBasis: '100%' }}><AlreadyAppliedNotice check={check} name={m.name} /></div>
    </>
  );
}
