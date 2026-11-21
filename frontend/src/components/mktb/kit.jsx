import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import './mktb.css';

// ---------------------------------------------------------------------------
// MARKET WAVE B - small shared pieces of the hiring tools (backend: routes/mktB.js at /api/ats/mkt).
// ---------------------------------------------------------------------------
export const M = '/ats/mkt';
export const errText = (e, f = 'Something went wrong. Please try again.') => e?.response?.data?.error || f;
export const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
export const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');

// GET a url; { data, error, loading, reload }
export function useGet(url, deps = []) {
  const [state, setState] = useState({ data: null, error: '', loading: !!url });
  const load = useCallback(() => {
    if (!url) return;
    setState((s) => ({ ...s, loading: true }));
    api.get(url).then((r) => setState({ data: r.data, error: '', loading: false }))
      .catch((e) => setState({ data: null, error: errText(e, 'Could not load.'), loading: false }));
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load };
}

export function Flash({ msg }) {
  if (!msg) return null;
  return <div className={`mkb-flash ${msg.ok ? 'good' : 'bad'}`} role="status">{msg.text}</div>;
}

// run(fn, okText): busy flag + a flash line
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const run = async (fn, ok) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); if (ok) setMsg({ ok: true, text: typeof ok === 'function' ? ok(r) : ok }); return r; } catch (e) { setMsg({ ok: false, text: errText(e) }); return null; } finally { setBusy(false); }
  };
  return { busy, msg, setMsg, run };
}

export function Card({ title, note, children, right, testid }) {
  return (
    <section className="card section mkb-card" data-testid={testid}>
      <div className="mkb-card-head">
        <h3>{title}</h3>
        {right}
      </div>
      {note && <p className="small-muted mkb-note">{note}</p>}
      {children}
    </section>
  );
}

export function Chips({ items }) {
  if (!items || !items.length) return null;
  return <div className="mkb-chips">{items.map((c) => <span key={c.key || c.label} className="mkb-chip"><b>{c.label}</b> {c.value}</span>)}</div>;
}

// a PDF from the API (needs the login token, so not a plain link)
export async function downloadPdf(url, name) {
  const r = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

// "Flag this AI output" (09.03): every AI result on these screens carries it
export function FlagAi({ feature, refType, refId, output }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState('Wrong');
  const { busy, msg, run } = useRun();
  if (!open) return <button type="button" className="mkb-link" onClick={() => setOpen(true)} title="Tell the Admin this AI output is wrong, biased or unsafe">Flag AI output</button>;
  return (
    <div className="mkb-flag">
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="What is wrong">
        {['Wrong', 'Biased', 'Unsafe', 'Override'].map((k) => <option key={k}>{k}</option>)}
      </select>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is wrong?" aria-label="Reason" />
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${M}/gov/flags`, { feature, refType, refId, kind, reason, output: String(output || '').slice(0, 1500) }), 'Flagged. The Admin will look at it.').then((r) => { if (r) setOpen(false); })}>Send</button>
      <button type="button" className="mkb-link" onClick={() => setOpen(false)}>Cancel</button>
      <Flash msg={msg} />
    </div>
  );
}

export function Empty({ children }) { return <div className="small-muted mkb-empty">{children}</div>; }
