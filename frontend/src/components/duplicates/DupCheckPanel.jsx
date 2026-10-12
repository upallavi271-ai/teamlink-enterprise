import { useEffect, useState } from 'react';
import api from '../../api';
import { protoDate } from '../../atsVocab';
import Modal from '../Modal.jsx';
import './Duplicates.css';

// ---------------------------------------------------------------------------
// "CHECK DUPLICATES" — the new profile and the one it looks like, side by side
// (user, 2026-10-10: "Duplicate profiles anni first stage lone verify avvali").
//
//   <DupCheckPanel candidateId onChanged />     everything about ONE person (drawer, page, the gate window)
//   <DupPairCard item onChanged />              ONE pair, with its buttons (also used by the worklist)
//
// Four separate buttons, no menu:
//   Merge into the existing profile  (a TL / Admin merges; a recruiter asks the TL)
//   Same person, different job       (adds the new application to the existing profile)
//   Not a duplicate                  (needs a reason; remembered)
//   Reject duplicate                 (rejects the new application, reason "Duplicate")
// What each login sees comes from the server: a profile outside your area is only "a profile exists with the same phone
// (owner: …)", and a BDE never gets a phone or e-mail value at all.
// ---------------------------------------------------------------------------
const err = (e, fallback) => e?.response?.data?.error || fallback;

export function levelClass(level) { return level === 'POSSIBLE' ? 'is-amber' : 'is-red'; }

function Row({ k, v, match }) {
  if (v === null || v === undefined || v === '') return null;
  return (<><dt>{k}</dt><dd className={match ? 'is-match' : ''}>{v}</dd></>);
}

export function ProfileBox({ p, tag, isNew, matched = [] }) {
  if (!p || p.gone) return <div className={`dupx-box ${isNew ? 'is-new' : 'is-other'}`}><div className="dupx-private">This profile no longer exists.</div></div>;
  if (!p.inScope) {
    return (
      <div className={`dupx-box ${isNew ? 'is-new' : 'is-other'}`}>
        <div className="dupx-box-tag">{tag}</div>
        <div className="dupx-private">{p.text}</div>
        {p.department && <div className="dupx-private">{`Team: ${p.department}`}</div>}
      </div>
    );
  }
  const hasPhone = matched.includes('phone');
  const hasEmail = matched.includes('email');
  return (
    <div className={`dupx-box ${isNew ? 'is-new' : 'is-other'}`}>
      <div className="dupx-box-tag">{tag}</div>
      <div className="dupx-box-name">{p.name}</div>
      <dl className="dupx-rows">
        <Row k="Step" v={p.stageLabel} />
        <Row k="Recruiter" v={p.owner} />
        <Row k="Source" v={p.source} />
        <Row k="Added" v={protoDate(p.createdAt)} />
        <Row k="Last activity" v={p.lastActivity ? protoDate(p.lastActivity) : null} />
        <Row k="Phone" v={p.phone} match={hasPhone} />
        <Row k="Email" v={p.email} match={hasEmail} />
        <Row k="City" v={p.location} />
        <Row k="Experience" v={p.experienceYears != null ? `${p.experienceYears} yrs` : null} />
        <Row k="Company" v={p.currentCompany} />
      </dl>
      {p.applications && p.applications.length > 0 && (
        <div className="dupx-apps">
          {p.applications.slice(0, 4).map((a) => (
            <div key={a.id}><span>{a.title || '—'}{a.client ? <span className="small-muted">{` · ${a.client}`}</span> : null}</span><span className="small-muted">{a.stageLabel}</span></div>
          ))}
          {p.applicationCount > 4 && <div className="small-muted">{`+${p.applicationCount - 4} more`}</div>}
          {p.otherAreaApplications > 0 && <div className="small-muted">{`${p.otherAreaApplications} more with another team`}</div>}
        </div>
      )}
      {p.applications && p.applications.length === 0 && <div className="dupx-apps small-muted">No job yet</div>}
    </div>
  );
}

// ---- merge: choose what to keep, field by field -----------------------------------------------------------
function MergeDialog({ item, mode, onClose, onDone }) {
  const flag = item.flag;
  const [masterId, setMasterId] = useState(flag.requestMasterId || flag.matchCandidateId);
  const [pv, setPv] = useState(null);
  const [choices, setChoices] = useState(flag.requestChoices || {});
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    setPv(null);
    api.get(`/candidate-duplicates/flags/${flag.id}/preview`, { params: { masterId } })
      .then((r) => setPv(r.data))
      .catch((e) => setError(err(e, 'Could not load the comparison.')));
  }, [flag.id, masterId]);

  const rows = pv ? pv.fields.filter((f) => showAll || f.differs) : [];
  const pickOf = (f) => choices[f.field] || f.keep;
  const set = (field, v) => setChoices((c) => ({ ...c, [field]: v }));

  async function go() {
    setBusy(true); setError('');
    const fieldChoices = {};
    (pv ? pv.fields : []).forEach((f) => { const v = pickOf(f); if (v === 'donor') fieldChoices[f.field] = 'donor'; });
    try {
      const url = mode === 'request' ? 'request-merge' : 'merge';
      const r = await api.post(`/candidate-duplicates/flags/${flag.id}/${url}`, { masterId, fieldChoices, note: note || undefined, confirm: true });
      onDone(r.data);
    } catch (e) { setError(err(e, 'Could not do this. Please try again.')); setBusy(false); }
  }
  const keepName = (id) => (id === flag.matchCandidateId ? item.existing : item.newer);

  return (
    <Modal
      title={mode === 'request' ? 'Ask your TL to merge these two' : 'Merge these two profiles'}
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !pv} onClick={go}>
            {busy ? 'Working…' : (mode === 'request' ? 'Send to my TL' : 'Merge now')}
          </button>
        </>
      )}
    >
      <div className="dupx-merge">
        <div className="small-muted" style={{ marginBottom: 8 }}>
          One person keeps one profile. Pick the profile to keep. Everything else (jobs, notes, documents, messages) moves to it. {mode !== 'request' && 'You can undo a merge for 7 days.'}
        </div>
        <div className="dupx-keep" role="radiogroup" aria-label="Which profile to keep">
          {[flag.matchCandidateId, flag.candidateId].map((id, i) => {
            const p = keepName(id);
            return (
              <label key={id} className={masterId === id ? 'is-on' : ''}>
                <input type="radio" name="keep" checked={masterId === id} onChange={() => { setMasterId(id); setChoices({}); }} />
                <span><b>{i === 0 ? 'Keep the existing profile' : 'Keep the new profile'}</b><br /><span className="small-muted">{p && p.inScope ? p.name : 'Another team’s profile'}</span></span>
              </label>
            );
          })}
        </div>
        {!pv && !error && <div className="small-muted">Loading the comparison…</div>}
        {pv && (
          <>
            {pv.hiddenValues && <div className="small-muted" style={{ marginBottom: 6 }}>Phone, email and pay are not shown to your role.</div>}
            <table className="dupx-fields">
              <thead><tr><th>Detail</th><th>Kept profile</th><th>Other profile</th></tr></thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.field} className={f.differs ? 'is-diff' : ''}>
                    <td>{f.label}</td>
                    <td>
                      <label><input type="radio" name={`f-${f.field}`} checked={pickOf(f) === 'master'} onChange={() => set(f.field, 'master')} />
                        <span className={f.master == null ? 'is-blank' : ''}>{f.master == null ? 'empty' : String(f.master)}</span></label>
                    </td>
                    <td>
                      <label><input type="radio" name={`f-${f.field}`} checked={pickOf(f) === 'donor'} onChange={() => set(f.field, 'donor')} disabled={f.donor == null || f.donor === '(hidden)' || f.donor === '(other team)'} />
                        <span className={f.donor == null ? 'is-blank' : ''}>{f.donor == null ? 'empty' : String(f.donor)}</span></label>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={3} className="small-muted">The details are the same on both profiles.</td></tr>}
              </tbody>
            </table>
            <button type="button" className="link-btn" style={{ marginTop: 6 }} onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show only the details that differ' : 'Show every detail'}
            </button>
            <ul className="dupx-moves">
              <li>{`${pv.plan.counts.applications} job application(s) move to the kept profile`}</li>
              {pv.plan.counts.conflicts > 0 && <li>{`${pv.plan.counts.conflicts} job where both applied — the one further ahead is kept`}</li>}
              <li>{`${pv.plan.counts.notes} note(s), ${pv.plan.counts.documents} document(s), ${pv.plan.counts.messages} message(s), ${pv.plan.counts.followUps} follow-up(s) move too`}</li>
              <li>The old profile’s link keeps working — it opens the kept profile.</li>
            </ul>
          </>
        )}
        {mode === 'request' && (
          <div className="dupx-ask">
            <label className="small-muted" htmlFor="dupx-note">Note for your TL (optional)</label>
            <input id="dupx-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="For example: same person, I spoke to him today" />
          </div>
        )}
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}

// ---- one pair with its buttons ---------------------------------------------------------------------------------
const QUICK_REASONS = ['Different people', 'Family member shares the phone', 'Same phone, different person'];

export function DupPairCard({ item, onChanged, selectable = false, selected = false, onSelect, compact = false }) {
  const { flag, caps } = item;
  const [ask, setAsk] = useState(null); // 'not' | 'reject' | 'decline'
  const [reason, setReason] = useState('');
  const [merge, setMerge] = useState(null); // 'merge' | 'request'
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const open = ['OPEN', 'MERGE_REQUESTED'].includes(flag.status);
  const requested = flag.status === 'MERGE_REQUESTED';
  const matched = (item.matchedOn || []).map((m) => m.kind);
  const isNew = item.role === 'new' || item.role === undefined;

  async function call(path, body, label) {
    setBusy(label); setError('');
    try {
      const r = await api.post(`/candidate-duplicates/flags/${flag.id}/${path}`, body || {});
      setDone(r.data); setAsk(null); setReason('');
      if (onChanged) onChanged(r.data);
    } catch (e) { setError(err(e, 'Could not do this. Please try again.')); } finally { setBusy(''); }
  }
  async function undo(logId) {
    try { await api.post(`/candidate-duplicates/merges/${logId}/undo`); setDone({ message: 'Undone. Both profiles are back as they were.' }); if (onChanged) onChanged({ undone: true }); } catch (e) { setError(err(e, 'Could not undo.')); }
  }

  return (
    <div className={`dupx-pair ${levelClass(flag.level)}${open ? '' : ' is-done'}`}>
      <div className="dupx-pair-head">
        {selectable && open && caps && (caps.canResolve || caps.canMerge) && (
          <input type="checkbox" className="dupx-sel" aria-label="Select" checked={selected} onChange={(e) => onSelect && onSelect(e.target.checked)} />
        )}
        <span className={`dupx-level ${levelClass(flag.level)}`}>{item.levelText}</span>
        {item.holds && isNew && <span className="dupx-hold">Held at the first step until this is sorted out</span>}
        {!open && <span className="dupx-chip is-blue">{flag.statusText}</span>}
        {requested && <span className="dupx-chip is-amber">{`Merge asked by ${flag.requestedByName || 'a recruiter'}`}</span>}
      </div>
      <div className="dupx-why" aria-label="What matched">
        {(item.matchedOn || []).map((m) => (
          <span key={m.kind}>{m.label}{m.value ? <> · <i>{m.value}</i></> : null}</span>
        ))}
      </div>
      {!isNew && <div className="small-muted" style={{ marginBottom: 8 }}>This is the older profile. A newer one looks like the same person.</div>}
      <div className="dupx-sides">
        <ProfileBox p={item.newer} tag="New profile" isNew matched={matched} />
        <ProfileBox p={item.existing} tag="Already on file" matched={matched} />
      </div>

      {done && (
        <div className="dupx-ok" role="status" style={{ marginTop: 10 }}>
          <span>{done.message}</span>
          {done.mergeLogId && done.undoDays ? <button type="button" className="btn btn-sm" onClick={() => undo(done.mergeLogId)}>Undo</button> : null}
        </div>
      )}

      {open && caps && !done && (caps.canResolve || caps.canMerge) && (
        <>
          <div className="dupx-actions">
            {caps.canMerge && (
              <button type="button" className="btn btn-primary" onClick={() => setMerge('merge')} title="Keeps one profile and moves everything onto it">
                {requested ? 'Approve the merge' : 'Merge into the existing profile'}
              </button>
            )}
            {!caps.canMerge && caps.canRequestMerge && (
              <button type="button" className="btn btn-primary" onClick={() => setMerge('request')} title="Your TL approves, then it is merged">Ask TL to merge</button>
            )}
            {caps.canMerge && requested && (
              <button type="button" className="btn" onClick={() => setAsk(ask === 'decline' ? null : 'decline')}>Not approved</button>
            )}
            {caps.canResolve && !requested && (
              <button type="button" className="btn" disabled={!!busy} onClick={() => call('same-person', {}, 'same')} title="Adds the new job application to the existing profile">Same person – different job</button>
            )}
            {caps.canResolve && (
              <button type="button" className="btn" onClick={() => setAsk(ask === 'not' ? null : 'not')} title="They are two different people">Not a duplicate</button>
            )}
            {caps.canResolve && !requested && (
              <button type="button" className="btn" onClick={() => setAsk(ask === 'reject' ? null : 'reject')} title="Rejects the new application as a duplicate">Reject duplicate</button>
            )}
          </div>
          {requested && !caps.canMerge && <div className="dupx-note">Waiting for your TL to approve the merge.</div>}
          {ask && (
            <div className="dupx-ask">
              <label className="small-muted" htmlFor={`dupx-r-${flag.id}`}>
                {ask === 'not' ? 'Why are they different people?' : ask === 'decline' ? 'Why is the merge not approved?' : 'Reason (saved with the rejection)'}
              </label>
              <input id={`dupx-r-${flag.id}`} value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="A few words" />
              {ask === 'not' && (
                <div className="dupx-quick">{QUICK_REASONS.map((q) => <button key={q} type="button" className="btn btn-sm" onClick={() => setReason(q)}>{q}</button>)}</div>
              )}
              <div className="dupx-ask-row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!!busy || (ask !== 'reject' && reason.trim().length < 3)}
                  onClick={() => call(ask === 'not' ? 'not-duplicate' : ask === 'decline' ? 'decline' : 'reject', ask === 'decline' ? { note: reason } : { reason }, ask)}
                >
                  {busy ? 'Saving…' : (ask === 'not' ? 'Save: not a duplicate' : ask === 'decline' ? 'Send back' : 'Reject as duplicate')}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => { setAsk(null); setReason(''); }}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
      {open && caps && !caps.canResolve && !caps.canMerge && !compact && (
        <div className="dupx-note">You can look at this one. The recruiter on the profile or their TL decides.</div>
      )}
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      {merge && (
        <MergeDialog
          item={item}
          mode={merge}
          onClose={() => setMerge(null)}
          onDone={(r) => { setMerge(null); setDone(r); if (onChanged) onChanged(r); }}
        />
      )}
    </div>
  );
}

// ---- the panel for one person ---------------------------------------------------------------------------------------
export default function DupCheckPanel({ candidateId, onChanged, onLoaded, showDone = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api.get(`/candidate-duplicates/candidate/${candidateId}`, { params: showDone ? { all: 1 } : {} })
      .then((r) => { setData(r.data); setError(''); if (onLoaded) onLoaded(r.data); })
      .catch((e) => setError(err(e, 'Could not check for duplicates. Please try again.')));
  }
  useEffect(() => { setData(null); load(); }, [candidateId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function again() {
    setBusy(true);
    try { await api.post(`/candidate-duplicates/recheck/${candidateId}`); await load(); } catch (e) { setError(err(e, 'Could not check again.')); } finally { setBusy(false); }
  }
  const changed = async (r) => { await load(); if (onChanged) onChanged(r); };

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="small-muted">Checking for duplicates…</div>;
  if (!data.supported) return <div className="dupx-empty">Duplicate checking is not switched on yet.</div>;
  return (
    <div className="dupx-panel">
      {data.portal && <div className="dupx-banner is-amber" style={{ marginBottom: 10 }}><span><b>{data.portal.text}</b> — the portal applicant was added to this existing profile, no second profile was made.</span></div>}
      {data.items.length === 0 && (
        <div className="dupx-empty">
          <b>No other profile looks like this person.</b>
          We compared the phone, email, name with birth date, resume file and resume text.
          <div style={{ marginTop: 10 }}><button type="button" className="btn btn-sm" disabled={busy} onClick={again}>{busy ? 'Checking…' : 'Check again'}</button></div>
        </div>
      )}
      {data.items.map((it) => <DupPairCard key={it.flag.id} item={it} onChanged={changed} />)}
    </div>
  );
}
