// ---------------------------------------------------------------------------
// ExportMenu — the ONE Export button (hrms-24 §3): Excel / CSV / PDF.
//
// It asks the SERVER for the file; the server runs the screen's own scoped
// query, checks the `export` permission (or pins the file to the caller's own
// data), and audit-logs the export. Nothing is assembled in the browser, so a
// file can never hold a row the screen's scope would not.
//
//   <ExportMenu url="/insights/leave/export" params={{ range, department }} />
//   <ExportMenu url={(fmt) => `/employees/export.${fmt}`} formats={['xlsx','csv','pdf']} />
//
// `url` is a path (the format goes in ?format=) or a function of the format.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../api';
import './ExportMenu.css';

const LABELS = { xlsx: 'Excel (.xlsx)', csv: 'CSV (.csv)', pdf: 'PDF (.pdf)' };

function saveBlob(res, fallback) {
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  const name = (m && m[1]) || fallback;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(href), 2000);
  return name;
}

// A refused export comes back as a JSON blob; read its message.
async function errorOf(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text()).error || ''; } catch { return ''; }
  }
  return data?.error || '';
}

export default function ExportMenu({
  url, params = {}, formats = ['xlsx', 'csv', 'pdf'], label = 'Export', note, disabled, size = 'sm', align = 'right', onDone,
  // Optional: the screen's state, POSTed as JSON (sent as text/plain so a
  // long list of visible row ids is not refused by the app-wide 100 kB JSON
  // limit). An object, or a function returning one at click time.
  body,
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  async function run(format) {
    setOpen(false); setBusy(format); setMsg(null);
    try {
      const path = typeof url === 'function' ? url(format) : url;
      const clean = Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));
      const query = typeof url === 'function' ? clean : { ...clean, format };
      const payload = typeof body === 'function' ? body() : body;
      const res = payload
        ? await api.post(path, JSON.stringify(payload), { params: query, responseType: 'blob', headers: { 'Content-Type': 'text/plain' } })
        : await api.get(path, { params: query, responseType: 'blob' });
      const name = saveBlob(res, `export.${format}`);
      const rows = res.headers?.['x-export-rows'];
      setMsg({ ok: true, text: `Downloaded ${name}${rows ? ` — ${rows} row(s)` : ''}.` });
      if (onDone) onDone(format);
    } catch (err) {
      const text = await errorOf(err);
      setMsg({ ok: false, text: text || 'The export could not be produced.' });
    } finally { setBusy(''); }
  }

  return (
    <span className={`xm xm-${align}`} ref={ref}>
      <button
        type="button"
        className={`btn btn-${size} btn-primary`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || !!busy}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? `Exporting ${busy.toUpperCase()}…` : label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <span className="xm-menu" role="menu">
          {formats.map((f) => (
            <button key={f} type="button" role="menuitem" className="xm-item" onClick={() => run(f)}>{LABELS[f] || f}</button>
          ))}
          {note && <span className="xm-note">{note}</span>}
        </span>
      )}
      {msg && (
        <span className={`xm-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">
          {msg.text}
          <button type="button" className="xm-x" aria-label="Dismiss" onClick={() => setMsg(null)}>×</button>
        </span>
      )}
    </span>
  );
}
