import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import { useSpecTree } from '../../utils/specMaster';
import SpecPicker from '../SpecPicker.jsx';

// ---------------------------------------------------------------------------
// The candidate's Qualification · Specialization (spec D, 2026-10-03) — one
// line on the profile Overview, with a small Edit. Until it is set, the old
// free text shows as "old value" and the app's guess (old value, current
// job, resume) is offered with one click — nothing is saved until then.
//   GET /api/specialisations/candidate/:id/suggest   current + suggestion
//   PUT /api/specialisations/candidate/:id           save (candidate edit right)
// ---------------------------------------------------------------------------
export default function SpecialisationLine({ candidateId, onChanged }) {
  const { user } = useAuth();
  const canEdit = can(user, 'ats', 'candidates', 'Candidate Master', 'edit');
  const tree = useSpecTree();
  const [info, setInfo] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ department: '', qualificationId: '', specialisationId: '' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get(`/specialisations/candidate/${candidateId}/suggest`)
    .then((r) => setInfo(r.data)).catch(() => setInfo({ failed: true }));
  useEffect(() => { setInfo(null); load(); }, [candidateId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!msg || msg.bad) return undefined;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  if (!info || info.failed) return null;
  const cur = info.current || {};
  const sug = info.suggestion;
  const depts = (tree?.departments || []).filter((d) => d.specialisations.length);
  const save = async (body, text) => {
    setBusy(true);
    try {
      await api.put(`/specialisations/candidate/${candidateId}`, body);
      setEditing(false);
      setMsg({ text });
      await load();
      onChanged?.();
    } catch (e) {
      setMsg({ text: e?.response?.data?.error || 'Could not save. Try again.', bad: true });
    } finally { setBusy(false); }
  };
  const startEdit = () => {
    setForm({
      department: cur.department || sug?.department || depts[0]?.name || '',
      qualificationId: cur.qualificationId || '',
      specialisationId: cur.specialisationId || '',
    });
    setEditing(true);
  };
  const shown = [cur.qualification, cur.specialisation].filter(Boolean).join(' · ');

  return (
    <div className="c360t-card spl-line">
      <div className="c360t-kv">
        <span>Specialization</span>
        <b>
          {shown || (cur.oldValue ? `Not set · old value "${cur.oldValue}"` : 'Not set')}
          {canEdit && !editing && (
            <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={startEdit}>Edit</button>
          )}
        </b>
      </div>
      {!cur.specialisationId && sug && canEdit && !editing && (
        <div className="small-muted" style={{ marginTop: 4 }}>
          {`Looks like: ${[sug.qualification, sug.specialisation].filter(Boolean).join(' · ')} `}
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => save({ qualificationId: sug.qualificationId, specialisationId: sug.specialisationId }, `Saved: ${sug.specialisation}.`)}
          >
            Use it
          </button>
        </div>
      )}
      {editing && (
        <div style={{ marginTop: 8 }}>
          <label className="field">
            <span>Department</span>
            <select value={form.department} onChange={(e) => setForm({ department: e.target.value, qualificationId: '', specialisationId: '' })}>
              {depts.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
          </label>
          <SpecPicker
            department={form.department}
            qualificationId={form.qualificationId}
            specialisationId={form.specialisationId}
            oldValue={cur.oldValue || ''}
            onChange={(v) => setForm((f) => ({ ...f, ...v }))}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => save({ qualificationId: form.qualificationId || null, specialisationId: form.specialisationId || null }, 'Saved.')}
            >
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div className={msg.bad ? 'error-text' : 'small-muted'} style={{ marginTop: 4 }} role="status">{msg.text}</div>}
    </div>
  );
}
