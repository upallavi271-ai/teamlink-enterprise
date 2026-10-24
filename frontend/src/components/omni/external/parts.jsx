import { useEffect, useState } from 'react';
import { Btn, GsModal, Field, Banner } from '../ui.jsx';
import './external.css';

// ---------------------------------------------------------------------------
// Small building blocks shared by the nine external-service pages (the prototype's markup: card metric, gsPanel, gsTable, toggle, uiPrompt).
// ---------------------------------------------------------------------------

// the prototype's "card metric". dim = shown faded (the service is not connected yet)
export const Metric = ({ label, value, meta, tone, dim }) => (
  <div className="card metric" style={dim ? { opacity: 0.55 } : undefined}>
    <small>{label}</small><b>{value}</b>{meta ? <span className={`kpi-meta ${tone || 'neutral'}`}>{meta}</span> : null}
  </div>
);
export const Metrics = ({ children, first }) => <div className={`grid metric-grid ext-metrics${first ? ' first' : ''}`}>{children}</div>;

// the prototype's on / off switch, as a real button
export function Toggle({ on, onChange, disabled, label, title }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} title={title} disabled={disabled} className={`toggle ext-toggle${on ? ' on' : ''}`} onClick={() => onChange && onChange(!on)}><span /></button>
  );
}

// the prototype's gsTable: columns = ['Campaign', ...]; rows = arrays of cells; empty = the plain words shown when there is nothing
export function SimpleTable({ columns, rows, empty = 'Nothing here yet.' }) {
  return (
    <div className="table-scroll" style={{ marginTop: 14 }}>
      <table className="table">
        <thead><tr>{columns.map((c, i) => <th key={`${c}-${i}`}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={columns.length} style={{ textAlign: 'center', color: 'var(--muted)', padding: '24px 12px' }}>{empty}</td></tr>}
          {rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className="ext-cell-wrap">{cell}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

// a small form dialog: fields = [{ id, label, placeholder, hint, options: ['a','b'] (a tiny closed list -> native select), type }]; onSubmit(values) returns an error sentence or '' to close
export function FormModal({ title, sub, fields, initial = {}, okLabel = 'Save', onSubmit, onClose, note }) {
  const [v, setV] = useState(() => { const o = {}; fields.forEach((f) => { o[f.id] = initial[f.id] != null ? initial[f.id] : (f.options ? f.options[0] : ''); }); return o; });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try { const e = await onSubmit(v); if (e) setErr(e); } finally { setBusy(false); }
  };
  useEffect(() => { setErr(''); }, [v]);
  return (
    <GsModal title={title} sub={sub} width={440} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={busy} onClick={submit}>{busy ? 'Saving…' : okLabel}</Btn></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {fields.map((f, i) => (
          <div key={f.id} style={{ marginTop: i ? 12 : 0 }}>
            <Field label={f.label} hint={f.hint}>
              {f.options
                ? <select className="select" value={v[f.id]} onChange={(e) => setV({ ...v, [f.id]: e.target.value })}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                : <input autoFocus={i === 0} type={f.type || 'text'} inputMode={f.inputMode} placeholder={f.placeholder || ''} value={v[f.id]} onChange={(e) => setV({ ...v, [f.id]: e.target.value })} />}
            </Field>
          </div>
        ))}
        {note && <p className="ext-note">{note}</p>}
        {err && <div className="ext-err" role="alert">{err}</div>}
        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </GsModal>
  );
}

// "Not synced yet" cell
export const NotSynced = ({ children = 'Not synced yet' }) => <span style={{ color: 'var(--muted)' }}>{children}</span>;

export const LoadError = ({ error }) => (error ? <Banner tone="error">{error}</Banner> : null);

export const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
