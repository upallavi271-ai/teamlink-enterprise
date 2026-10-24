import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { Banner } from '../ui.jsx';
import Combo from '../../Combo.jsx';
import './admin.css';

// Small helpers shared by the Administration pages (Team & Roles, Billing, Super Admin, Settings, the organisation modal).

// load something, keep the answer, say plainly when it failed:  const { data, err, loading, reload } = useLoad(() => omni.get('/x'), [dep])
export function useLoad(loader, deps = []) {
  const [state, setState] = useState({ data: null, err: '', loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return loader().then((d) => setState({ data: d, err: '', loading: false })).catch((e) => setState({ data: null, err: errOf(e, 'This could not be loaded.'), loading: false }));
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

// download a file the server makes (CSV); tells the page plainly when it was refused
export async function downloadFile(path, params, name) {
  const blob = await omni.blob(path, params);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthWords = (m) => { const x = /^(\d{4})-(\d{2})$/.exec(String(m || '')); return x ? `${MONTHS[Number(x[2]) - 1]} ${x[1]}` : ''; };
export const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

// the prototype's toggle switch
export const Switch = ({ on, onChange, disabled, label }) => (
  <label className="sw" title={label}><input type="checkbox" checked={!!on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} /><span /></label>
);
// a settings row: bold label, small plain note, a control on the right
export const SwitchRow = ({ label, note, on, onChange, disabled, children }) => (
  <div className="adm-row">
    <div className="adm-row-main"><b>{label}</b>{note && <small>{note}</small>}{children}</div>
    <Switch on={on} onChange={onChange} disabled={disabled} label={label} />
  </div>
);
export const Err = ({ text }) => (text ? <Banner tone="error">{text}</Banner> : null);
export const Ok = ({ text }) => (text ? <Banner tone="ok">{text}</Banner> : null);

// a month chooser (the server sends the last six months)
export function MonthPick({ value, months, onChange }) {
  return (
    <Combo className="select" aria-label="Month" value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 150 }}>
      {(months && months.length ? months : [value]).map((m) => <option key={m} value={m}>{monthWords(m)}</option>)}
    </Combo>
  );
}
