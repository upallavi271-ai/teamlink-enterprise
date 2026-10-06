import { useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// B9.2 — CLIENT PROMISES (per-client SLA) on the Client page.
//   Feedback within N days          the client's answer on a profile we sent
//   Send first profiles within N    from the job being raised to the first
//                                   profile sent
// Blank = the Step-timing default (Administration → Company Setup → Step
// timing). Used by the Late calculation and ATS Reports → Late & waiting →
// "Client promises". Edit needs the Commercial Terms permission.
// GET / PUT /clients/:id/sla.
// ---------------------------------------------------------------------------
export default function ClientSlaCard({ clientId, initial = null, canEdit = false }) {
  const [sla, setSla] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ feedbackDays: '', firstProfilesDays: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (initial) { setSla(initial); return undefined; }
    let on = true;
    api.get(`/clients/${clientId}/sla`).then((r) => { if (on) setSla(r.data); }).catch(() => {});
    return () => { on = false; };
  }, [clientId, initial]);

  if (!sla) return null;
  const own = (k) => sla[k] !== null && sla[k] !== undefined;
  const line = (label, k) => (
    <div className="kv">
      <span className="k">{label}</span>
      <span>
        <b>{sla.effective[k]} day{sla.effective[k] === 1 ? '' : 's'}</b>
        <span className="small-muted">{own(k) ? ' · this client\'s own' : ` · default (Step timing)`}</span>
      </span>
    </div>
  );

  async function save() {
    setBusy(true); setMsg('');
    try {
      const body = {
        feedbackDays: draft.feedbackDays === '' ? null : Number(draft.feedbackDays),
        firstProfilesDays: draft.firstProfilesDays === '' ? null : Number(draft.firstProfilesDays),
      };
      const r = await api.put(`/clients/${clientId}/sla`, body);
      setSla(r.data); setEditing(false); setMsg('Saved. Late and the SLA report use these from now.');
    } catch (err) { setMsg(err.response?.data?.error || 'Could not save.'); } finally { setBusy(false); }
  }

  return (
    <div className="card section" style={{ marginTop: 12 }}>
      <h3 style={{ fontSize: 13, marginBottom: 10, display: 'flex', alignItems: 'center' }}>
        Client promises (SLA)
        {canEdit && !editing && (
          <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => { setDraft({ feedbackDays: own('feedbackDays') ? String(sla.feedbackDays) : '', firstProfilesDays: own('firstProfilesDays') ? String(sla.firstProfilesDays) : '' }); setEditing(true); setMsg(''); }}>Edit</button>
        )}
      </h3>
      {!editing ? (
        <>
          {line('Feedback within', 'feedbackDays')}
          {line('Send first profiles within', 'firstProfilesDays')}
          <div className="small-muted" style={{ marginTop: 6 }}>Profiles with this client past the feedback days show as Late. Jobs with no profile sent inside the first-profiles days show in Reports → Late &amp; waiting → Client promises.</div>
        </>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <label className="field"><span>Feedback within (days) — blank = default {sla.defaults.feedbackDays}</span>
            <input type="number" min="0" max="90" value={draft.feedbackDays} onChange={(e) => setDraft({ ...draft, feedbackDays: e.target.value })} placeholder={String(sla.defaults.feedbackDays)} />
          </label>
          <label className="field"><span>Send first profiles within (days) — blank = default {sla.defaults.firstProfilesDays}</span>
            <input type="number" min="0" max="90" value={draft.firstProfilesDays} onChange={(e) => setDraft({ ...draft, firstProfilesDays: e.target.value })} placeholder={String(sla.defaults.firstProfilesDays)} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
      {msg && <div className="small-muted" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}
