// CRM wave B (2026-11-24): small pieces the new screens share - sub tabs, a loader hook, a switch-off notice, a copy box.
import { useCallback, useEffect, useState } from 'react';
import api from '../../../api';
import { errOf } from '../crmShared.jsx';

export function SubTabs({ tabs, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 12px' }} role="tablist">
      {tabs.map(([k, l, n]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} className={`btn btn-sm${value === k ? ' btn-primary' : ''}`} onClick={() => onChange(k)}>
          {l}{n ? <span style={{ marginLeft: 6, padding: '0 6px', borderRadius: 9, fontSize: 11, fontWeight: 700, background: value === k ? 'rgba(255,255,255,.25)' : 'var(--line-soft, #e8ebf0)' }}>{n}</span> : null}
        </button>
      ))}
    </div>
  );
}

// GET a path; reload() again; data null while loading, err the plain words of a failure
export function useLoad(path, params, deps = []) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const key = JSON.stringify(params || {});
  const reload = useCallback(() => {
    if (!path) return Promise.resolve();
    return api.get(path, { params }).then((r) => { setData(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'This could not be read.')));
  }, [path, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); reload(); }, [reload, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, err, reload, setData };
}

export function OffNote({ on, what }) {
  if (on) return null;
  return <div className="notice" role="status" style={{ marginBottom: 10, fontSize: 13, borderColor: 'var(--amber, #d97706)' }}>{what} is switched <b>off</b>. An Admin switches it on in CRM &gt; Dashboard &gt; ⚙ Settings &gt; Email, phone, marketing and portal.</div>;
}

export function CopyBox({ label, value, rows = 2 }) {
  const [done, setDone] = useState(false);
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        <textarea readOnly rows={rows} value={value || ''} style={{ fontFamily: 'monospace', fontSize: 12 }} aria-label={label || 'Copy this'} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn btn-sm" onClick={() => { try { navigator.clipboard.writeText(value || ''); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* select and copy by hand */ } }}>{done ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

export const Empty = ({ title, children }) => <div className="empty" style={{ padding: 18 }}><h3>{title}</h3>{children}</div>;
export const ago = (iso) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
// a local date-time input value (YYYY-MM-DDTHH:mm) -> ISO
export const localToIso = (v) => { if (!v) return ''; const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); };
export const inHour = () => { const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
