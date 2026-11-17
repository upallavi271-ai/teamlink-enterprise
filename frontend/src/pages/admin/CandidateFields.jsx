import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../../components/Combo.jsx';
import '../../components/candidate/CandidateRecord.css';

// ---------------------------------------------------------------------------
// Administration → Company Setup → CANDIDATE FIELDS (founder audit 2026-11-17): the extra fields every candidate profile shows on its
// Career tab. Super Admin / Admin define them: label, type (text, number, date, a pick list), required or not. A field is switched off,
// never deleted, so the values already typed stay in the history. Backend: routes/candidateProfileDepth.js (/candidates/profile-fields).
// ---------------------------------------------------------------------------
const TYPE_LABEL = { text: 'Text', number: 'Number', date: 'Date', select: 'Pick list' };
const errText = (e, f) => e?.response?.data?.error || f;
const EMPTY = { label: '', type: 'text', options: '', required: false };

function FieldForm({ row, onDone }) {
  const [f, setF] = useState(row ? { ...row, options: (row.options || []).join(', ') } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('');
    const body = { label: f.label, type: f.type, options: String(f.options || '').split(','), required: !!f.required };
    try {
      if (row) await api.put(`/candidates/profile-fields/${row.id}`, body); else await api.post('/candidates/profile-fields', body);
      onDone(true);
    } catch (x) { setErr(errText(x, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <form className="crx-form crx-grid" onSubmit={save}>
      <label className="field"><span>Label</span><input value={f.label} onChange={set('label')} placeholder="e.g. Languages spoken" required maxLength={60} /></label>
      <label className="field"><span>Type</span>
        <Combo value={f.type} onChange={set('type')}>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Combo>
      </label>
      {f.type === 'select' && <label className="field crx-span"><span>Options (comma between them)</span><input value={f.options} onChange={set('options')} placeholder="e.g. Yes, No, Maybe" /></label>}
      <label className="crx-inline"><input type="checkbox" checked={!!f.required} onChange={set('required')} /> Required</label>
      <div className="crx-row crx-span">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save field'}</button>
        <button type="button" className="btn btn-sm" onClick={() => onDone(false)}>Cancel</button>
      </div>
      {err && <div className="crx-flash bad">{err}</div>}
    </form>
  );
}

export default function CandidateFields() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(null);
  const load = useCallback(() => {
    api.get('/candidates/profile-fields', { params: { all: '1' } }).then((r) => { setData(r.data); setError(''); }).catch((e) => setError(errText(e, 'Could not load the fields.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  const done = (saved) => { setEdit(null); if (saved) load(); };
  async function toggle(f) {
    try { await api.put(`/candidates/profile-fields/${f.id}`, { active: !f.active }); load(); } catch (e) { setError(errText(e, 'Could not change it.')); }
  }
  if (error && !data) return <div className="notice">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="crx-title">
        <h2 style={{ margin: 0 }}>Candidate fields</h2>
        {data.canDefine && !edit && <button type="button" className="btn btn-sm btn-primary" onClick={() => setEdit('new')}>+ Add field</button>}
      </div>
      <p className="small-muted">Extra fields on every candidate profile (the Career tab). Recruiters fill them; a required field shows as &quot;Required, not filled&quot; until it is.</p>
      {!data.canDefine && <div className="notice">Only a Super Admin or Admin can add or change these fields.</div>}
      {error && <div className="crx-flash bad">{error}</div>}
      {edit === 'new' && <FieldForm onDone={done} />}
      {data.fields.length === 0 && edit !== 'new' && <div className="small-muted">No fields yet.</div>}
      {data.fields.map((f) => (edit && edit.id === f.id ? <FieldForm key={f.id} row={f} onDone={done} /> : (
        <div key={f.id} className="crx-item" style={f.active ? undefined : { opacity: 0.55 }}>
          <div className="crx-main">
            <b>{f.label}</b>
            <span className="small-muted">{[TYPE_LABEL[f.type] || f.type, f.type === 'select' && f.options.join(' / '), f.required && 'Required', !f.active && 'Switched off'].filter(Boolean).join(' · ')}</span>
          </div>
          {data.canDefine && (
            <span className="crx-row">
              <button type="button" className="btn btn-sm" onClick={() => setEdit(f)}>Edit</button>
              <button type="button" className="btn btn-sm" onClick={() => toggle(f)}>{f.active ? 'Switch off' : 'Switch on'}</button>
            </span>
          )}
        </div>
      )))}
    </div>
  );
}
