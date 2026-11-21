import { useEffect, useState } from 'react';
import api from '../../api';
import { Notice, useLoad, useAction, row } from './kit.jsx';

// ---------------------------------------------------------------------------
// "MORE DETAILS" on a job / client page: the sections and fields an Admin added (market wave 13.02, Administration -> ATS settings ->
// Forms & workflows). Nothing is drawn while no field is set up. Backend: /api/ats-plus/forms/:entity/:id (utils/atsPlus/admin.js).
// And CurrencyNote (13.07): an amount in another currency with its rupee value.
// ---------------------------------------------------------------------------
export function MoreDetails({ entity, id, canEdit = true }) {
  const { data, reload } = useLoad(id ? `/ats-plus/forms/${entity}/${id}` : null);
  const { run, busy, flash } = useAction(reload);
  const [edit, setEdit] = useState(false); const [vals, setVals] = useState({});
  useEffect(() => { if (data) setVals({ ...data.values }); }, [data]);
  if (!data || !data.form.sections.some((s) => s.fields.length)) return null;
  const input = (f) => {
    const v = vals[f.key] ?? '';
    const on = (x) => setVals({ ...vals, [f.key]: x });
    if (f.type === 'select') return <select aria-label={f.label} value={v} onChange={(e) => on(e.target.value)}><option value="">—</option>{(f.options || []).map((o) => <option key={o}>{o}</option>)}</select>;
    if (f.type === 'yesno') return <select aria-label={f.label} value={v} onChange={(e) => on(e.target.value)}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>;
    if (f.type === 'textarea') return <textarea aria-label={f.label} rows={2} value={v} onChange={(e) => on(e.target.value)} />;
    return <input aria-label={f.label} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={v} onChange={(e) => on(e.target.value)} />;
  };
  return (
    <div className="card section" style={{ padding: 12, marginTop: 12 }}>
      <div style={row}><b>More details</b>{data.missing.length > 0 && <span className="small-muted">Still to fill: {data.missing.join(', ')}</span>}<span style={{ flex: 1 }} />
        {canEdit && !edit && <button type="button" className="btn btn-sm" onClick={() => setEdit(true)}>Edit</button>}</div>
      {flash}
      {data.form.sections.map((s) => (
        <div key={s.title} style={{ marginTop: 8 }}>
          <div className="small-muted" style={{ fontWeight: 600 }}>{s.title}</div>
          {s.fields.map((f) => (
            <div key={f.key} className="kv"><span className="k">{f.label}{f.required ? ' *' : ''}</span>{edit ? input(f) : <span>{data.values[f.key] === undefined ? '—' : String(data.values[f.key] === 'yes' ? 'Yes' : data.values[f.key] === 'no' ? 'No' : data.values[f.key])}</span>}</div>
          ))}
        </div>
      ))}
      {edit && <div style={{ ...row, marginTop: 8 }}><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put(`/ats-plus/forms/${entity}/${id}`, { values: vals }), 'Saved.').then((d) => { if (d) setEdit(false); })}>Save</button><button type="button" className="btn btn-sm" onClick={() => { setEdit(false); setVals({ ...data.values }); }}>Cancel</button></div>}
      {data.updatedAt && <div className="small-muted" style={{ marginTop: 4 }}>Last change by {data.updatedBy}.</div>}
    </div>
  );
}

const cache = { at: 0, p: null };
export function CurrencyNote({ amount, currency }) {
  const [v, setV] = useState(null);
  const cur = String(currency || 'INR').toUpperCase();
  const n = Number(String(amount || '').replace(/[^\d.]/g, ''));
  useEffect(() => {
    if (cur === 'INR' || !(n > 0)) return;
    if (!cache.p || Date.now() - cache.at > 60000) { cache.at = Date.now(); cache.p = api.get('/ats-plus/currency').then((r) => r.data).catch(() => null); }
    cache.p.then((c) => { if (c && c.rates[cur]) setV(Math.round(n * c.rates[cur])); });
  }, [cur, n]);
  if (v === null) return null;
  return <span className="small-muted"> ≈ ₹{v.toLocaleString('en-IN')} (at ₹ rate of the day set by the Admin)</span>;
}
