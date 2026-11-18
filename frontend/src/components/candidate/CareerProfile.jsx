// ---------------------------------------------------------------------------
// THE CAREER TAB of the candidate profile (founder audit 2026-11-17): profile summary (AI or from the fields), tags, the education
// list, the employment history with the standard title next to the typed one, gaps of more than 3 months, the career progression
// line, the Admin-defined custom fields and the resume parse check. TeamLink logins only (the server refuses anyone else).
// Data: GET /api/candidates/:id/profile-depth (backend routes/candidateProfileDepth.js).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import {
  PersonalCard, VerifyCard, HistoryCard, ScoreHistoryCard,
} from './CareerData.jsx'; // round 3: personal details, verify flags, applications before, score history
import './CandidateRecord.css';

const errText = (err, fallback) => err?.response?.data?.error || fallback;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const month = (ym) => { if (!ym) return ''; const [y, m] = String(ym).split('-').map(Number); return m ? `${MON[m - 1]} ${y}` : String(y); };
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const TREND = { up: '↑ going up', flat: '→ flat', down: '↓ going down', mixed: '↕ up and down' };

function Flash({ msg }) {
  if (!msg) return null;
  return <div className={`crx-flash ${msg.bad ? 'bad' : ''}`} role="status">{msg.text}</div>;
}

// --- summary --------------------------------------------------------------------------------------------------------
function SummaryCard({ id, d, canEdit, reload }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function write(useAi) {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post(`/candidates/${id}/profile-summary`, { useAi });
      setMsg(r.data.aiNote ? { bad: false, text: r.data.aiNote } : null);
      reload();
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not write the summary.') }); } finally { setBusy(false); }
  }
  const s = d.summary;
  return (
    <section className="c360t-card">
      <div className="crx-title">
        <div className="c360t-label">Profile summary</div>
        {canEdit && (
          <span className="crx-row">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => write(true)}>{busy ? 'Writing…' : (s ? '✨ Rewrite with AI' : '✨ AI summary')}</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => write(false)} title="Built from the profile fields, education, history and skills - no AI">From the fields</button>
          </span>
        )}
      </div>
      {s ? (
        <>
          <div className="crx-line" style={{ whiteSpace: 'pre-wrap' }}>{s.summary}</div>
          <div className="crx-sub">{`${s.source === 'ai' ? 'Written by AI' : 'Built from the profile fields'} · ${s.createdByName || '—'} · ${day(s.createdAt)}`}</div>
        </>
      ) : <div className="small-muted">No summary yet. Press the button to write one.</div>}
      <Flash msg={msg} />
    </section>
  );
}

// --- tags -------------------------------------------------------------------------------------------------------------
function TagsCard({ id, d, canEdit, reload }) {
  const [tag, setTag] = useState('');
  const [msg, setMsg] = useState(null);
  async function add(e) {
    e.preventDefault();
    if (!tag.trim()) return;
    try { await api.post(`/candidates/${id}/tags`, { tag }); setTag(''); setMsg(null); reload(); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not add the tag.') }); }
  }
  async function remove(t) {
    try { await api.post(`/candidates/${id}/tags/remove`, { tag: t }); reload(); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not remove the tag.') }); }
  }
  return (
    <section className="c360t-card">
      <div className="c360t-label">Tags</div>
      <div className="crx-choice" style={{ margin: '4px 0' }}>
        {d.tags.length === 0 && <span className="small-muted">No tags. Tags help you find people again (the Candidates list filters by tag).</span>}
        {d.tags.map((t) => (
          <span key={t.tag} className="skillpill" title={`Added by ${t.createdByName || '—'} on ${day(t.createdAt)}`}>
            {t.tag}
            {canEdit && <button type="button" className="link-btn" aria-label={`Remove tag ${t.tag}`} style={{ marginLeft: 6 }} onClick={() => remove(t.tag)}>×</button>}
          </span>
        ))}
      </div>
      {canEdit && (
        <form className="crx-row" onSubmit={add}>
          <input className="crx-input" style={{ maxWidth: 240 }} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. Night shift OK, Hot, Relocate" maxLength={40} aria-label="New tag" />
          <button type="submit" className="btn btn-sm">+ Add tag</button>
        </form>
      )}
      <Flash msg={msg} />
    </section>
  );
}

// --- education --------------------------------------------------------------------------------------------------------
const EDU_EMPTY = { degree: '', specialisation: '', institute: '', year: '', score: '' };
function EducationForm({ id, row, onDone }) {
  const [f, setF] = useState(row ? { ...EDU_EMPTY, ...row } : EDU_EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      if (row) await api.put(`/candidates/${id}/education/${row.id}`, f); else await api.post(`/candidates/${id}/education`, f);
      onDone(true);
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); } finally { setBusy(false); }
  }
  return (
    <form className="crx-form crx-grid" onSubmit={save}>
      <label className="field"><span>Degree</span><input value={f.degree || ''} onChange={set('degree')} placeholder="e.g. B.Tech" /></label>
      <label className="field"><span>Specialisation</span><input value={f.specialisation || ''} onChange={set('specialisation')} placeholder="e.g. CSE" /></label>
      <label className="field"><span>Institute</span><input value={f.institute || ''} onChange={set('institute')} placeholder="e.g. JNTU Hyderabad" /></label>
      <label className="field"><span>Year</span><input value={f.year || ''} onChange={set('year')} placeholder="2019" inputMode="numeric" maxLength={4} /></label>
      <label className="field"><span>Score</span><input value={f.score || ''} onChange={set('score')} placeholder="e.g. 72% or 8.1 CGPA" /></label>
      <div className="crx-row crx-span">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-sm" onClick={() => onDone(false)}>Cancel</button>
      </div>
      <Flash msg={msg} />
    </form>
  );
}
function EducationCard({ id, d, canEdit, reload }) {
  const [edit, setEdit] = useState(null); // 'new' | row
  const done = (saved) => { setEdit(null); if (saved) reload(); };
  async function remove(r) {
    if (!window.confirm(`Remove ${r.degree || r.institute}?`)) return;
    await api.delete(`/candidates/${id}/education/${r.id}`).catch(() => {}); reload();
  }
  return (
    <section className="c360t-card">
      <div className="crx-title">
        <div className="c360t-label">{d.education.length ? `Education (${d.education.length})` : 'Education'}</div>
        {canEdit && !edit && <button type="button" className="btn btn-sm" onClick={() => setEdit('new')}>+ Add education</button>}
      </div>
      {edit === 'new' && <EducationForm id={id} onDone={done} />}
      {d.education.length === 0 && !edit && <div className="small-muted">No education rows yet (the profile&apos;s single Education field is still shown on Overview).</div>}
      {d.education.map((r) => (edit && edit.id === r.id ? <EducationForm key={r.id} id={id} row={r} onDone={done} /> : (
        <div key={r.id} className="crx-item">
          <div className="crx-main">
            <b>{[r.degree, r.specialisation].filter(Boolean).join(' · ') || '—'}</b>
            <span className="small-muted">{[r.institute, r.year, r.score && `Score ${r.score}`].filter(Boolean).join(' · ')}</span>
          </div>
          {canEdit && <span className="crx-row"><button type="button" className="btn btn-sm" onClick={() => setEdit(r)}>Edit</button><button type="button" className="btn btn-sm" onClick={() => remove(r)}>Remove</button></span>}
        </div>
      )))}
    </section>
  );
}

// --- employment -------------------------------------------------------------------------------------------------------
const JOB_EMPTY = { company: '', title: '', fromMonth: '', toMonth: '', isCurrent: false, ctc: '', notes: '' };
function EmploymentForm({ id, row, onDone }) {
  const [f, setF] = useState(row ? { ...JOB_EMPTY, ...row, fromMonth: row.fromMonth || '', toMonth: row.toMonth || '' } : JOB_EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      if (row) await api.put(`/candidates/${id}/employment/${row.id}`, f); else await api.post(`/candidates/${id}/employment`, f);
      onDone(true);
    } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); } finally { setBusy(false); }
  }
  return (
    <form className="crx-form crx-grid" onSubmit={save}>
      <label className="field"><span>Company</span><input value={f.company || ''} onChange={set('company')} placeholder="e.g. Infotech Pvt Ltd" /></label>
      <label className="field"><span>Job title</span><input value={f.title || ''} onChange={set('title')} placeholder="e.g. Sr. Java Developer" /></label>
      <label className="field"><span>From</span><input type="month" value={f.fromMonth || ''} onChange={set('fromMonth')} /></label>
      <label className="field"><span>To</span><input type="month" value={f.isCurrent ? '' : (f.toMonth || '')} onChange={set('toMonth')} disabled={f.isCurrent} /></label>
      <label className="crx-inline"><input type="checkbox" checked={!!f.isCurrent} onChange={set('isCurrent')} /> Works here now</label>
      <label className="field"><span>CTC (optional)</span><input value={f.ctc || ''} onChange={set('ctc')} placeholder="e.g. 6.5 LPA" /></label>
      <label className="field crx-span"><span>Notes</span><input value={f.notes || ''} onChange={set('notes')} placeholder="Reason for leaving, team size …" /></label>
      <div className="crx-row crx-span">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-sm" onClick={() => onDone(false)}>Cancel</button>
      </div>
      <Flash msg={msg} />
    </form>
  );
}
function EmploymentCard({ id, d, canEdit, reload }) {
  const [edit, setEdit] = useState(null);
  const done = (saved) => { setEdit(null); if (saved) reload(); };
  async function remove(r) {
    if (!window.confirm(`Remove ${r.company || r.title}?`)) return;
    await api.delete(`/candidates/${id}/employment/${r.id}`).catch(() => {}); reload();
  }
  const p = d.progression;
  return (
    <section className="c360t-card">
      <div className="crx-title">
        <div className="c360t-label">{d.employment.length ? `Employment history (${d.employment.length})` : 'Employment history'}</div>
        {canEdit && !edit && <button type="button" className="btn btn-sm" onClick={() => setEdit('new')}>+ Add job</button>}
      </div>
      {p && p.jobs > 0 && (
        <div className="crx-line" style={{ margin: '2px 0 8px' }}>
          <b>Career: </b>{p.line}
          {p.jobs > 1 && p.trend && <span className="small-muted">{` · ${TREND[p.trend] || p.trend}`}</span>}
          {p.shortStints > 0 && <span className="small-muted">{` · ${p.shortStints} job${p.shortStints === 1 ? '' : 's'} under 1 year`}</span>}
        </div>
      )}
      {edit === 'new' && <EmploymentForm id={id} onDone={done} />}
      {d.employment.length === 0 && !edit && <div className="small-muted">No jobs added yet. Add each job to see gaps and career progression.</div>}
      {d.employment.map((r) => (edit && edit.id === r.id ? <EmploymentForm key={r.id} id={id} row={r} onDone={done} /> : (
        <div key={r.id} className="crx-item">
          <div className="crx-main">
            <b>{r.title || '—'}</b>
            {r.normalisedTitle && r.normalisedTitle !== r.title && <span className="small-muted" title="The standard title (tidied by the title rules)">{` → ${r.normalisedTitle}`}</span>}
            <span className="small-muted">{[r.company, `${month(r.fromMonth) || '?'} – ${r.isCurrent ? 'now' : (month(r.toMonth) || '?')}`, r.ctc && `CTC ${r.ctc}`].filter(Boolean).join(' · ')}</span>
            {r.notes && <span className="crx-sub">{r.notes}</span>}
          </div>
          {canEdit && <span className="crx-row"><button type="button" className="btn btn-sm" onClick={() => setEdit(r)}>Edit</button><button type="button" className="btn btn-sm" onClick={() => remove(r)}>Remove</button></span>}
        </div>
      )))}
      <div className="c360t-label" style={{ marginTop: 10 }}>{d.gaps.length ? `Gaps (${d.gaps.length})` : 'Gaps'}</div>
      {d.gaps.length === 0 ? <div className="small-muted">{d.employment.length ? 'No gap of more than 3 months.' : 'Add jobs (and education years) to check for gaps.'}</div> : (
        d.gaps.map((g) => <div key={`${g.kind}-${g.from}`} className="notice amber" style={{ margin: '4px 0' }}><b>{`${g.kind}: `}</b>{g.text}</div>)
      )}
      <div className="crx-sub">{d.gapRule}</div>
    </section>
  );
}

// --- custom fields ------------------------------------------------------------------------------------------------------
function CustomFieldsCard({ id, d, canEdit, reload }) {
  const [vals, setVals] = useState({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { setVals(Object.fromEntries(d.customFields.map((f) => [f.id, f.value || '']))); }, [d.customFields]);
  if (!d.customFields.length) {
    return d.canDefineFields ? (
      <section className="c360t-card"><div className="c360t-label">More fields</div><div className="small-muted">No custom fields yet. Add them in Administration → Company Setup → Candidate fields.</div></section>
    ) : null;
  }
  async function save(e) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { await api.put(`/candidates/${id}/custom-fields`, { values: vals }); setEditing(false); setMsg({ bad: false, text: 'Saved.' }); reload(); } catch (err) { setMsg({ bad: true, text: errText(err, 'Could not save.') }); } finally { setBusy(false); }
  }
  const missing = d.customFields.filter((f) => f.required && !f.value);
  return (
    <section className="c360t-card">
      <div className="crx-title">
        <div className="c360t-label">More fields</div>
        {canEdit && !editing && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {!editing && missing.length > 0 && <div className="notice amber" style={{ margin: '4px 0' }}>{`Required, not filled: ${missing.map((f) => f.label).join(', ')}`}</div>}
      {!editing ? (
        <div className="crx-grid">
          {d.customFields.map((f) => (
            <div key={f.id}><div className="crx-sub">{`${f.label}${f.required ? ' *' : ''}`}</div><div className="crx-line">{f.value || '—'}</div></div>
          ))}
        </div>
      ) : (
        <form className="crx-form crx-grid" onSubmit={save}>
          {d.customFields.map((f) => {
            const set = (e) => setVals({ ...vals, [f.id]: e.target.value });
            const label = `${f.label}${f.required ? ' *' : ''}`;
            if (f.type === 'select') {
              return (
                <label key={f.id} className="field"><span>{label}</span>
                  <Combo value={vals[f.id] || ''} onChange={set}>
                    <option value="">—</option>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </Combo>
                </label>
              );
            }
            return <label key={f.id} className="field"><span>{label}</span><input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={vals[f.id] || ''} onChange={set} required={f.required} /></label>;
          })}
          <div className="crx-row crx-span">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn btn-sm" onClick={() => { setEditing(false); setMsg(null); }}>Cancel</button>
          </div>
        </form>
      )}
      <Flash msg={msg} />
    </section>
  );
}

// --- parse check ------------------------------------------------------------------------------------------------------
function ParseCheckCard({ d }) {
  const pc = d.parseCheck;
  if (!pc) return null;
  return (
    <section className="c360t-card">
      <div className="c360t-label">{`Resume read vs profile now${pc.accuracyPct != null ? ` — ${pc.accuracyPct}% kept` : ''}`}</div>
      <div className="crx-sub">{`From ${pc.fileName || 'the resume'} (${day(pc.readAt)}). "Corrected by recruiter" = the profile now says something different from what the parser read.`}</div>
      <div className="tbl-wrap" style={{ marginTop: 6 }}><table>
        <thead><tr><th>Field</th><th>Parser read</th><th>Profile now</th><th>Result</th></tr></thead>
        <tbody>
          {pc.rows.map((r) => <tr key={r.field}><td>{r.field}</td><td>{r.read || '—'}</td><td>{r.now || '—'}</td><td>{r.status}</td></tr>)}
        </tbody>
      </table></div>
      {(pc.languages || []).some((l) => l !== 'English') && (
        <div className="notice" style={{ marginTop: 6 }}>{`The resume has ${pc.languages.filter((l) => l !== 'English').join(' and ')} text: only e-mail, phone and name lines are read by the free parser. The AI pass translates the full resume.`}</div>
      )}
    </section>
  );
}

export default function CareerProfile({ c }) {
  const id = c && c.id;
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!id) return;
    api.get(`/candidates/${id}/profile-depth`).then((r) => { setD(r.data); setError(''); }).catch((err) => setError(errText(err, 'Could not load the career details.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error) return <div className="notice">{error}</div>;
  if (!d) return <div className="small-muted">Loading…</div>;
  const props = { id, d, canEdit: d.canEdit, reload: load };
  return (
    <div className="crx-docs">
      {d.currentTitle && d.currentTitle.standard && d.currentTitle.standard !== d.currentTitle.raw && (
        <div className="small-muted">{`Current designation: ${d.currentTitle.raw} → standard title: ${d.currentTitle.standard}`}</div>
      )}
      <VerifyCard id={id} onChanged={load} />
      <SummaryCard {...props} />
      <TagsCard {...props} />
      <PersonalCard id={id} />
      <EmploymentCard {...props} />
      <EducationCard {...props} />
      <CustomFieldsCard {...props} />
      <ParseCheckCard d={d} />
      <HistoryCard id={id} />
      <ScoreHistoryCard id={id} />
    </div>
  );
}
