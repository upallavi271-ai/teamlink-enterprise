import { cloneElement, isValidElement, useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { t as tr } from '../../i18n.jsx'; // Telugu / Hindi when chosen (ATS wave 2 Z, 13.06)

// ---------------------------------------------------------------------------
// Small shared pieces of the ATS PLUS screens (market wave, 2026-11-21): one way to load, show a message, draw a table and a switch,
// so every new tab looks like the rest of the ATS (card, btn, small-muted, tbl-wrap). Backend: /api/ats-plus (routes/atsPlus.js).
// ---------------------------------------------------------------------------
export const say = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
export const dmy = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—');
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
export const daysAgo = (n) => new Date(Date.now() + 330 * 60000 - n * 86400000).toISOString().slice(0, 10);
export const pctTxt = (v) => (v === null || v === undefined ? '—' : `${v}%`);

export function Notice({ children, tone }) {
  return children ? <div className={`notice${tone ? ` ${tone}` : ''}`} style={{ margin: '8px 0' }}>{children}</div> : null;
}

// GET a path; reload() reads it again. path = null loads nothing.
export function useLoad(path) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => {
    if (!path) return Promise.resolve(null);
    setBusy(true); setErr('');
    return api.get(path).then((r) => { setData(r.data); return r.data; })
      .catch((e) => { setErr(say(e, 'Could not load this.')); setData(null); return null; })
      .finally(() => setBusy(false));
  }, [path]);
  useEffect(() => { reload(); }, [reload]);
  return { data, err, busy, reload, setData };
}

// run a write, show its message, reload
export function useAction(reload) {
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, ok) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      if (reload) await reload();
      setMsg({ ok: true, text: typeof ok === 'function' ? ok(r && r.data) : (ok || 'Saved.') });
      return r && r.data;
    } catch (e) { setMsg({ ok: false, text: say(e, 'Could not save.') }); return null; } finally { setBusy(false); }
  }, [reload]);
  const flash = msg ? <Notice tone={msg.ok ? 'green' : 'red'}>{msg.text}</Notice> : null;
  return { run, busy, flash, setMsg };
}

export function Section({ title, note, children, right }) {
  return (
    <section className="card section" style={{ padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{typeof title === 'string' ? tr(title) : title}</h3>
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {note && <div className="small-muted" style={{ margin: '4px 0 10px' }}>{note}</div>}
      {children}
    </section>
  );
}

// cols: [{ key, label, render?(row) }]
export function Table({ cols, rows, empty = 'Nothing here yet.', rowKey = (r, i) => r.id || i }) {
  return (
    <div className="tbl-wrap" style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr>{cols.map((c) => <th key={c.key}>{typeof c.label === 'string' ? tr(c.label) : c.label}</th>)}</tr></thead>
        <tbody>
          {(!rows || rows.length === 0) && <tr><td colSpan={cols.length} className="cell-muted">{tr(empty)}</td></tr>}
          {(rows || []).map((r, i) => <tr key={rowKey(r, i)}>{cols.map((c) => <td key={c.key}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function Switch({ checked, onChange, label, note, disabled }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' }}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
      <span><b>{label}</b>{note && <div className="small-muted">{note}</div>}</span>
    </label>
  );
}

export function Pills({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      {options.map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${value === k ? ' btn-primary' : ''}`} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  );
}

export function Field({ label, children, hint }) {
  return (
    <div className="field" style={{ marginBottom: 8 }}>
      <label>{label}</label>
      {isValidElement(children) && !children.props['aria-label'] ? cloneElement(children, { 'aria-label': label }) : children}
      {hint && <div className="small-muted" style={{ fontSize: 12 }}>{hint}</div>}
    </div>
  );
}

export const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
