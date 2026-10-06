// ---------------------------------------------------------------------------
// THE INTERVIEW PANEL, EACH PERSON'S OWN SCORECARD (B4, 2026-10-06).
// Shows who is on the panel and what each one said. "Add feedback" opens a
// short scorecard for that person (yours, or one you note for an outside
// interviewer). The overall decision stays ONE — Decide on Interview Feedback.
// An old interview with one interviewer shows as a one-person panel; its
// feedback is the usual feedback form (onLegacyFeedback).
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import './panel.css';

const RECS = ['Selected', 'Rejected', 'Hold'];
const RATES = [['technical', 'Skills'], ['communication', 'Talking'], ['experience', 'Experience'], ['roleFit', 'Fit for the job']];

function Scorecard({ member, appId, onSaved, onCancel }) {
  const [f, setF] = useState({ technical: '', communication: '', experience: '', roleFit: '', overall: '', recommendation: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/ats/interviews/${appId}/panel/${member.id}/feedback`, f);
      onSaved(r.data);
    } catch (e) { setErr(e.response?.data?.error || 'Could not save. Please try again.'); } finally { setBusy(false); }
  }
  return (
    <div className="pnlv-form">
      <b>{`Feedback from ${member.name}`}</b>
      <div className="pnlv-rates">
        {RATES.map(([k, label]) => (
          <label key={k} className="small-muted">{`${label} (1-5)`}
            <select value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        ))}
      </div>
      <textarea rows="2" maxLength={4000} placeholder="How did it go? (a short note) *" value={f.overall} onChange={(e) => setF({ ...f, overall: e.target.value })} />
      <div className="pnlv-recs" role="radiogroup" aria-label="Their view">
        {RECS.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={f.recommendation === r} className={`btn btn-sm${f.recommendation === r ? ' is-on' : ''}`} onClick={() => setF({ ...f, recommendation: r })}>{r}</button>
        ))}
      </div>
      {err && <div className="error-text">{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !f.recommendation || f.overall.trim().length < 2} onClick={save}>{busy ? 'Saving…' : 'Save feedback'}</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function PanelView({ row, user, canAct, onChanged, onLegacyFeedback }) {
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState('');
  const panel = row.panel || [];
  if (!panel.length) return <div className="small-muted">No interviewer saved yet.</div>;
  const done = panel.filter((p) => p.feedback).length;
  return (
    <div className="pnlv">
      {panel.length > 1 && <div className="small-muted">{`${done} of ${panel.length} gave feedback. The final decision is one, on Interview Feedback → Decide.`}</div>}
      {msg && <div className="mlk-ok" role="status">{msg}</div>}
      {panel.map((p) => {
        const mine = p.userId && user && p.userId === user.id;
        const canAdd = !p.feedback && (mine || canAct);
        return (
          <div key={p.id || `legacy-${p.name}`} className="pnlv-row">
            <span className="pnlv-who">
              <b>{p.name}{mine ? ' (you)' : ''}</b>
              <span className="small-muted">{p.legacy ? 'Interviewer' : (p.external ? `Outside${p.email ? ` · ${p.email}` : ''}` : 'TeamLink')}</span>
            </span>
            {p.feedback ? <StatusChip status={p.feedback.recommendation} /> : <StatusChip status="Waiting" tone="amber" />}
            {canAdd && !p.legacy && open !== p.id && (
              <button type="button" className="btn btn-sm" onClick={() => setOpen(p.id)}>{mine ? 'Add my feedback' : 'Add feedback'}</button>
            )}
            {canAdd && p.legacy && onLegacyFeedback && <button type="button" className="btn btn-sm" onClick={onLegacyFeedback}>Add feedback</button>}
            {p.feedback && (
              <>
                <span className="pnlv-scores">
                  {RATES.map(([k, label]) => (p.feedback[k] ? `${label} ${p.feedback[k]}/5` : null)).filter(Boolean).join(' · ')}
                </span>
                {p.feedback.overall && <span className="pnlv-note">{p.feedback.overall}</span>}
              </>
            )}
            {open === p.id && (
              <div style={{ flexBasis: '100%' }}>
                <Scorecard
                  member={p}
                  appId={row.id}
                  onCancel={() => setOpen(null)}
                  onSaved={(fresh) => { setOpen(null); setMsg(fresh.message || 'Saved.'); if (onChanged) onChanged(fresh); }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
