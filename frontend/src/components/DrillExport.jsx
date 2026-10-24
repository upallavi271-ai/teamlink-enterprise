import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useAtsIoAccess } from './AtsDataTools.jsx';
import { can, isAdmin } from '../permissions';
import { downloadCsv } from '../utils/csv';

// ---------------------------------------------------------------------------
// THE EXPORT BUTTON UNDER EVERY DASHBOARD NUMBER (founder, 2026-10-24: "every drill-down must have an export option").
//
// One clear button, no dropdown. It builds the file from the SAME rows the list on the screen shows (with the search / filters the person
// picked) and saves a CSV, which Excel opens. `build()` returns { headers, rows, note? } - sync or async (a list that is paged on the server
// loops its pages inside build()). `note` is shown after the download, e.g. "the list is cut at 500".
//
//   <DrillExport name="Open requirements" allowed={right} build={() => ({ headers, rows })} />
//
// WHO may export is never decided here: `allowed` comes from the same right the dashboard's own Export button uses (useDrillRight below).
// ---------------------------------------------------------------------------
const slug = (s) => String(s || 'list').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'list';
const today = () => new Date().toISOString().slice(0, 10);
export const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cell).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
};

// The right to export, by dashboard area. Same rights as each dashboard's own Export button.
//   ats      the ATS dashboard export right (GET /api/ats-io/access -> exports.dashboard)
//   accounts Accounts Dashboard - export     hrms HRMS Dashboard - export     admin  Super Admin / Admin boards
export function useDrillRight(area) {
  const { user } = useAuth();
  const ats = useAtsIoAccess();
  if (!user) return false;
  if (area === 'ats') return !!(ats && (ats.exports || {}).dashboard);
  if (area === 'accounts') return !!can(user, 'accounts', 'accounts', 'Accounts Dashboard', 'export');
  if (area === 'hrms') return !!can(user, 'hrms', 'hrms', 'HRMS Dashboard', 'export');
  if (area === 'admin') return !!isAdmin(user);
  return false;
}

// The board served by this list address belongs to one area.
export const areaOfList = (url) => (/accounts/.test(url || '') ? 'accounts' : /admin-desk|control-tower/.test(url || '') ? 'admin' : 'ats');

export default function DrillExport({ name, build, allowed = true, disabled = false, label = 'Export', className = 'btn btn-sm', title }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (!allowed) return null;
  async function run() {
    setBusy(true); setMsg(null);
    try {
      const t = await build();
      if (!t || !t.rows || !t.rows.length) { setMsg({ ok: false, text: 'There is nothing to export in this list.' }); return; }
      const file = `${slug(name)}-${today()}.csv`;
      downloadCsv(file, t.headers, t.rows.map((r) => r.map(cell)));
      setMsg({ ok: true, text: `Downloaded ${file} - ${t.rows.length.toLocaleString('en-IN')} rows.${t.note ? ` ${t.note}` : ''}` });
    } catch (e) {
      setMsg({ ok: false, text: (e && e.response && e.response.data && e.response.data.error) || 'The file could not be made. Please try again.' });
    } finally { setBusy(false); }
  }
  return (
    <span className="drill-export" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className={className} disabled={busy || disabled} onClick={run} title={title || 'Download this list as a file (opens in Excel)'}>
        <span aria-hidden="true">⬇</span> {busy ? 'Preparing…' : label}
      </button>
      {msg && <span className={msg.ok ? 'small-muted' : 'error-text'} role="status">{msg.text}</span>}
    </span>
  );
}
