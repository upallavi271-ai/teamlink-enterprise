import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// INTERVIEW ROUNDS (audit 232 / 242 / 244 / 247 / 248 / 250). One panel for one interview, inside the calendar's detail window:
//   round history       every round: type, date, how, link, interviewers, ratings, recommendation (old rounds are read in as they were)
//   typed feedback      Technical (skills), HR (attitude, expectations, notice, CTC), Management (culture fit, leadership), Client / Other
//   files and links     notes, recording links, uploads (20 MB at most)
//   interviewer rating  the recruiter / TL rates each interviewer of a round 1-5
//   suggested decision  from the ratings; the stage owner presses to accept (the stage never moves by itself)
// Backend: routes/interviewRounds.js, utils/interviewRounds.js.
// ---------------------------------------------------------------------------
const err = (e, f) => e?.response?.data?.error || f;
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'not set');
const REC_TONE = { Selected: 'green', Rejected: 'red', Hold: 'orange' };
const Stars = ({ n }) => <span aria-label={`${n} of 5`}>{'★'.repeat(Math.round(n))}{'☆'.repeat(5 - Math.round(n))}</span>;

function Rate({ label, value, onChange }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 14 }}>
      <span className="small-muted">{label}</span>
      <select value={value || ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} aria-label={label}>
        <option value="">-</option>
        {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

function FeedbackForm({ applicationId, round, type, existing, current, onSaved, onCancel }) {
  const d = (existing && existing.details) || {};
  const [f, setF] = useState(() => ({
    overall: (existing && existing.overall) || '', recommendation: (existing && existing.recommendation) || 'Selected',
    technical: existing?.technical || '', communication: existing?.communication || '', experience: existing?.experience || '', roleFit: existing?.roleFit || '',
    skills: d.skills && d.skills.length ? d.skills : [{ name: '', rating: '' }], problemSolving: d.problemSolving || '',
    attitude: d.attitude || '', expectationsMatch: d.expectationsMatch || '', noticePeriod: d.noticePeriod || '', currentCtc: d.currentCtc || '', expectedCtc: d.expectedCtc || '',
    cultureFit: d.cultureFit || '', leadership: d.leadership || '', fitForTeam: d.fitForTeam || '', finalNote: d.finalNote || '',
  }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (p) => setF((x) => ({ ...x, ...p }));
  async function save() {
    setBusy(true); setMsg('');
    try {
      const body = { ...f, roundType: type, skills: f.skills.filter((s) => s.name && s.rating) };
      if (current) { // the live round goes the usual way (it also moves the interview to "Feedback submitted")
        await api.post(`/ats/interviews/${applicationId}/feedback`, { ...body, feedback: f.overall, result: f.recommendation });
        onSaved(null);
      } else {
        const r = await api.put(`/ats/interviews/${applicationId}/rounds/${round}/feedback`, body);
        onSaved(r.data);
      }
    } catch (e) { setMsg(err(e, 'Could not save the feedback.')); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ padding: 12, margin: '8px 0' }}>
      <b>{`Round ${round} feedback — ${type}`}</b>
      {type === 'Technical' && (
        <div style={{ margin: '8px 0' }}>
          <div className="small-muted">Skills (name and 1-5)</div>
          {f.skills.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <input placeholder="Skill, e.g. Java" value={s.name} aria-label="Skill" onChange={(e) => set({ skills: f.skills.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <select value={s.rating || ''} aria-label="Skill rating" onChange={(e) => set({ skills: f.skills.map((x, j) => (j === i ? { ...x, rating: e.target.value ? Number(e.target.value) : '' } : x)) })}>
                <option value="">-</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ skills: [...f.skills, { name: '', rating: '' }] })}>+ Add a skill</button>
          <div style={{ marginTop: 6 }}><Rate label="Problem solving" value={f.problemSolving} onChange={(v) => set({ problemSolving: v })} /><Rate label="Communication" value={f.communication} onChange={(v) => set({ communication: v })} /></div>
        </div>
      )}
      {type === 'HR' && (
        <div style={{ margin: '8px 0' }}>
          <Rate label="Attitude" value={f.attitude} onChange={(v) => set({ attitude: v })} />
          <Rate label="Communication" value={f.communication} onChange={(v) => set({ communication: v })} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <select value={f.expectationsMatch} aria-label="Expectations match" onChange={(e) => set({ expectationsMatch: e.target.value })}>
              <option value="">Expectations match?</option><option>Yes</option><option>Partly</option><option>No</option>
            </select>
            <input placeholder="Notice period" value={f.noticePeriod} onChange={(e) => set({ noticePeriod: e.target.value })} />
            <input placeholder="Current CTC" value={f.currentCtc} onChange={(e) => set({ currentCtc: e.target.value })} />
            <input placeholder="Expected CTC" value={f.expectedCtc} onChange={(e) => set({ expectedCtc: e.target.value })} />
          </div>
        </div>
      )}
      {type === 'Management' && (
        <div style={{ margin: '8px 0' }}>
          <Rate label="Culture fit" value={f.cultureFit} onChange={(v) => set({ cultureFit: v })} />
          <Rate label="Leadership" value={f.leadership} onChange={(v) => set({ leadership: v })} />
          <select value={f.fitForTeam} aria-label="Fit for the team" onChange={(e) => set({ fitForTeam: e.target.value })}><option value="">Fit for the team?</option><option>Yes</option><option>No</option></select>
          <input style={{ display: 'block', width: '100%', marginTop: 6 }} placeholder="Final note" value={f.finalNote} onChange={(e) => set({ finalNote: e.target.value })} />
        </div>
      )}
      {(type === 'Client' || type === 'Other') && (
        <div style={{ margin: '8px 0' }}>
          <Rate label="Technical" value={f.technical} onChange={(v) => set({ technical: v })} />
          <Rate label="Communication" value={f.communication} onChange={(v) => set({ communication: v })} />
          <Rate label="Experience" value={f.experience} onChange={(v) => set({ experience: v })} />
          <Rate label="Role fit" value={f.roleFit} onChange={(v) => set({ roleFit: v })} />
        </div>
      )}
      <textarea rows={3} style={{ width: '100%' }} placeholder="Overall feedback" aria-label="Overall feedback" value={f.overall} onChange={(e) => set({ overall: e.target.value })} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <select value={f.recommendation} aria-label="Recommendation" onChange={(e) => set({ recommendation: e.target.value })}><option>Selected</option><option>Hold</option><option>Rejected</option></select>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save feedback'}</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {msg && <div className="error-text" role="alert">{msg}</div>}
    </div>
  );
}

function Files({ applicationId, round, items, canAdd, onChanged, mayRemove, me }) {
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const run = async (fn) => { setMsg(''); try { const r = await fn(); onChanged(r.data.rounds); setLink(''); setNote(''); } catch (e) { setMsg(err(e, 'Could not save.')); } };
  const upload = (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('file', file); fd.append('title', file.name);
    run(() => api.post(`/ats/interviews/${applicationId}/rounds/${round}/attachments`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }));
    e.target.value = '';
  };
  const download = async (a) => {
    try {
      const r = await api.get(`/ats/interview-attachments/${a.id}/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data); const el = document.createElement('a'); el.href = url; el.download = a.fileName || 'attachment'; el.click(); URL.revokeObjectURL(url);
    } catch (er) { setMsg(err(er, 'Could not open the file.')); }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small-muted">Notes, recordings and files</div>
      {items.length === 0 && <div className="small-muted">Nothing attached.</div>}
      {items.map((a) => (
        <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
          <span>{a.kind === 'link' ? <a href={a.url} target="_blank" rel="noreferrer">{a.title || a.url}</a> : a.kind === 'file' ? <button type="button" className="link-btn" onClick={() => download(a)}>{a.title || a.fileName}</button> : <span title={a.note}>{a.title || 'Note'}: {a.note}</span>}</span>
          <span className="small-muted">{a.byName} · {when(a.at)}</span>
          {mayRemove(a) && <button type="button" className="link-btn" onClick={() => run(() => api.delete(`/ats/interview-attachments/${a.id}`).then(() => api.get(`/ats/interviews/${applicationId}/rounds`)))}>Remove</button>}
        </div>
      ))}
      {canAdd && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          <input type="url" placeholder="Recording / notes link (https://…)" value={link} aria-label="Link" onChange={(e) => setLink(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={!link.trim()} onClick={() => run(() => api.post(`/ats/interviews/${applicationId}/rounds/${round}/attachments`, { kind: 'link', url: link.trim() }))}>Add link</button>
          <input placeholder="A note" value={note} aria-label="Note" onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={!note.trim()} onClick={() => run(() => api.post(`/ats/interviews/${applicationId}/rounds/${round}/attachments`, { kind: 'note', note: note.trim() }))}>Add note</button>
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>Upload a file<input type="file" hidden onChange={upload} accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.mp4,.webm" /></label>
        </div>
      )}
      {msg && <div className="error-text" role="alert">{msg}</div>}
    </div>
  );
}

function RateInterviewers({ applicationId, round, people, ratings, onDone }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState({});
  const [msg, setMsg] = useState('');
  if (!people.length) return null;
  async function send(p) {
    const v = vals[p.name] || {};
    setMsg('');
    try { await api.post(`/ats/interviews/${applicationId}/rounds/${round}/rate-interviewer`, { userId: p.userId || undefined, name: p.name, rating: v.rating, comment: v.comment }); setMsg(`Thank you. ${p.name} rated.`); onDone(); } catch (e) { setMsg(err(e, 'Could not save the rating.')); }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" className="link-btn" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Rate the interviewers'}</button>
      {open && people.map((p) => (
        <div key={p.name} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0', flexWrap: 'wrap' }}>
          <b style={{ minWidth: 140 }}>{p.name}</b>
          <Rate label="Rating" value={(vals[p.name] || {}).rating} onChange={(rating) => setVals((x) => ({ ...x, [p.name]: { ...(x[p.name] || {}), rating } }))} />
          <input placeholder="Comment (optional)" value={(vals[p.name] || {}).comment || ''} onChange={(e) => setVals((x) => ({ ...x, [p.name]: { ...(x[p.name] || {}), comment: e.target.value } }))} />
          <button type="button" className="btn btn-sm" disabled={!(vals[p.name] || {}).rating} onClick={() => send(p)}>Rate</button>
          {ratings.filter((r) => r.name === p.name).length > 0 && <span className="small-muted">{`rated ${ratings.filter((r) => r.name === p.name).map((r) => r.rating).join(', ')}`}</span>}
        </div>
      ))}
      {msg && <div className="small-muted" role="status">{msg}</div>}
    </div>
  );
}

// onDecide(decision, suggestionText): the stage owner's one-click accept; the caller runs the existing decision (a rejection opens its own dialog).
export default function InterviewRounds({ applicationId, user, canDecide, onDecide, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(null); // { round, type }
  const [typeFor, setTypeFor] = useState({});
  const load = useCallback(() => api.get(`/ats/interviews/${applicationId}/rounds`).then((r) => { setData(r.data); setError(''); }).catch((e) => setError(err(e, 'The rounds could not be loaded.'))), [applicationId]);
  useEffect(() => { load(); }, [load]);
  if (error) return <div className="small-muted">{error}</div>;
  if (!data) return <div className="small-muted">Loading the rounds…</div>;
  const isLead = data.mayReadRatings;
  const setType = async (round, roundType) => {
    try { await api.put(`/ats/interviews/${applicationId}/rounds/${round}`, { roundType }); setTypeFor((x) => ({ ...x, [round]: roundType })); load(); } catch (e) { setError(err(e, 'Could not change the round type.')); }
  };
  const apply = (resp) => { setEdit(null); if (resp && resp.rounds) setData((d) => ({ ...d, rounds: resp.rounds, suggested: resp.suggested !== undefined ? resp.suggested : d.suggested })); else load(); if (onChanged) onChanged(); };
  return (
    <div className="ivx-sec" style={{ marginTop: 10 }}>
      <b>Rounds</b>
      {data.suggested && (
        <div className="notice" style={{ margin: '6px 0' }}>
          <b>Suggested decision: {data.suggested.decision}</b>{data.suggested.average != null && <> · average {data.suggested.average}/5</>}
          <div className="small-muted">{data.suggested.why}</div>
          {canDecide && ['Selected', 'Hold', 'Rejected'].includes(data.suggested.decision) && (
            <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 4 }} onClick={() => onDecide(data.suggested.decision, `Accepted the suggestion: ${data.suggested.why}`)}>
              {data.suggested.decision === 'Rejected' ? 'Reject… (asks the reason)' : `Accept: ${data.suggested.decision}`}
            </button>
          )}
        </div>
      )}
      {data.rounds.map((r) => {
        const type = typeFor[r.round] || r.roundType;
        const peopleOf = r.panel.length ? r.panel.map((p) => ({ userId: p.userId, name: p.name })) : r.interviewers.map((n) => ({ userId: null, name: n }));
        return (
          <div key={r.round} className="card" style={{ padding: 10, margin: '8px 0' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <b>Round {r.round}{r.current ? ' (current)' : ''}</b>
              {data.canSchedule ? (
                <select value={type || ''} aria-label={`Round ${r.round} type`} onChange={(e) => setType(r.round, e.target.value)}>
                  <option value="">Type…</option>{data.roundTypes.map((t) => <option key={t}>{t}</option>)}
                </select>
              ) : <span className="status active">{type || 'Type not set'}</span>}
              <span className="small-muted">{when(r.scheduledAt)}{r.mode ? ` · ${r.mode}` : ''}{r.location ? ` · ${r.location}` : ''}</span>
              {r.meetingLink && <a href={r.meetingLink} target="_blank" rel="noreferrer">{r.linkProvider || 'Meeting'} link</a>}
            </div>
            {peopleOf.length > 0 && <div className="small-muted">Interviewers: {peopleOf.map((p) => p.name).join(', ')}</div>}
            {isLead && peopleOf.length > 0 && <InterviewerAverages people={peopleOf} />}
            {r.feedback ? (
              <div style={{ margin: '6px 0' }}>
                <span className={`status ${REC_TONE[r.feedback.recommendation] || ''}`}>{r.feedback.recommendation}</span>{' '}
                {r.feedback.average != null && <><Stars n={r.feedback.average} /> <span className="small-muted">{r.feedback.average}/5</span></>}
                {r.feedback.legacy && <span className="small-muted"> · earlier record</span>}
                <div>{r.feedback.overall}</div>
                {r.feedback.details && r.feedback.details.skills && r.feedback.details.skills.length > 0 && <div className="small-muted">Skills: {r.feedback.details.skills.map((s) => `${s.name} ${s.rating}/5`).join(', ')}</div>}
                {r.feedback.details && r.feedback.details.attitude != null && <div className="small-muted">Attitude {r.feedback.details.attitude}/5{r.feedback.details.expectationsMatch ? ` · expectations: ${r.feedback.details.expectationsMatch}` : ''}{r.feedback.details.noticePeriod ? ` · notice ${r.feedback.details.noticePeriod}` : ''}{r.feedback.details.currentCtc ? ` · CTC ${r.feedback.details.currentCtc} → ${r.feedback.details.expectedCtc || '?'}` : ''}</div>}
                {r.feedback.details && r.feedback.details.cultureFit != null && <div className="small-muted">Culture fit {r.feedback.details.cultureFit}/5{r.feedback.details.leadership ? ` · leadership ${r.feedback.details.leadership}/5` : ''}{r.feedback.details.fitForTeam ? ` · fit for team: ${r.feedback.details.fitForTeam}` : ''}{r.feedback.details.finalNote ? ` · ${r.feedback.details.finalNote}` : ''}</div>}
                <div className="small-muted">{r.feedback.byName || '—'} · {when(r.feedback.updatedAt)}</div>
              </div>
            ) : <div className="small-muted" style={{ margin: '6px 0' }}>No feedback for this round yet.</div>}
            {data.canFeedback && (edit && edit.round === r.round
              ? <FeedbackForm applicationId={applicationId} round={r.round} current={r.current && !['CANCELLED', 'NO_SHOW'].includes(r.status)} type={edit.type} existing={r.feedback && r.feedback.roundType === edit.type ? r.feedback : null} onSaved={apply} onCancel={() => setEdit(null)} />
              : <button type="button" className="btn btn-sm" onClick={() => setEdit({ round: r.round, type: type || 'Other' })}>{r.feedback ? 'Edit feedback' : `Give ${type ? type.toLowerCase() : ''} feedback`}</button>)}
            <Files applicationId={applicationId} round={r.round} items={r.attachments} canAdd={data.canFeedback} onChanged={(rounds) => (rounds ? setData((d) => ({ ...d, rounds })) : load())} mayRemove={(a) => a.byName === user?.name || isLead} me={user} />
            {data.canRate && <RateInterviewers applicationId={applicationId} round={r.round} people={peopleOf} ratings={r.interviewerRatings} onDone={load} />}
          </div>
        );
      })}
    </div>
  );
}

// TL / Admin only: the average rating each interviewer of the round has had so far (the server refuses everyone else).
function InterviewerAverages({ people }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/ats/interviewer-ratings').then((r) => setRows(r.data.rows)).catch(() => setRows(null)); }, []);
  if (!rows) return null;
  const keyOf = (p) => (p.userId ? `u:${p.userId}` : `n:${String(p.name).toLowerCase().replace(/\s+/g, ' ').trim()}`);
  const got = people.map((p) => ({ p, r: rows.find((x) => x.key === keyOf(p)) })).filter((x) => x.r);
  if (!got.length) return null;
  return <div className="small-muted">Interviewer ratings so far: {got.map(({ p, r }) => `${p.name} ${r.average}/5 (${r.count})`).join(' · ')}</div>;
}

// Admin / TL: how interviewers rate (average and last comments), for an interviewer's profile.
export function InterviewerRatings({ userId, name }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/ats/interviewer-ratings', { params: { userId, name } }).then((r) => setRows(r.data.rows)).catch(() => setRows(null)); }, [userId, name]);
  if (!rows) return null;
  if (!rows.length) return <div className="small-muted">No interviewer ratings yet.</div>;
  return rows.map((r) => (
    <div key={r.key}><b>{r.name}</b> <Stars n={r.average} /> {r.average}/5 from {r.count} rating{r.count === 1 ? '' : 's'}{r.recent[0] && r.recent[0].comment ? <span className="small-muted"> · “{r.recent[0].comment}”</span> : null}</div>
  ));
}
