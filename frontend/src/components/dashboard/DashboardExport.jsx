// ---------------------------------------------------------------------------
// DashboardExport — the ONE "Export" button in a dashboard's header
// (user, 2026-10-09: "dashboard lo export button"). A single plain button, no
// menu: one click downloads an Excel file of what is on the screen for the
// filters picked (tiles, chart numbers, panels and the lists behind them).
//
//   <DashboardExport url="/dashboard/ats/home/export" params={params} />
//
// The server builds the file from the same data the page shows, checks the
// Export right again and writes the audit row; this only asks for it. Show it
// only when the page's payload says mayExport (the server decides, not the UI).
// ---------------------------------------------------------------------------
import { useState } from 'react';
import api from '../../api';
import './dashboardExport.css';

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
  if (data instanceof Blob) { try { return JSON.parse(await data.text()).error || ''; } catch { return ''; } }
  return data?.error || '';
}

export default function DashboardExport({
  url, params = {}, label = 'Export', className = 'btn btn-sm', title = 'Download what you see on this page, with the filters you picked, as an Excel file',
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  async function run() {
    setBusy(true); setMsg(null);
    try {
      const clean = Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));
      const res = await api.get(url, { params: { ...clean, format: 'xlsx' }, responseType: 'blob' });
      const name = saveBlob(res, 'dashboard.xlsx');
      const rows = res.headers?.['x-export-rows'];
      setMsg({ ok: true, text: `Downloaded ${name}${rows ? ` - ${Number(rows).toLocaleString('en-IN')} rows` : ''}.` });
    } catch (err) {
      setMsg({ ok: false, text: (await errorOf(err)) || 'The file could not be made. Please try again.' });
    } finally { setBusy(false); }
  }
  return (
    <span className="dxp">
      <button type="button" className={className} disabled={busy} onClick={run} title={title}>
        <span aria-hidden="true">⬇</span> {busy ? 'Preparing…' : label}
      </button>
      {msg && (
        <span className={`dxp-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">
          {msg.text}
          <button type="button" className="dxp-x" aria-label="Dismiss" onClick={() => setMsg(null)}>×</button>
        </span>
      )}
    </span>
  );
}
