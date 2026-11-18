import { useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// JOB PORTAL > WHO IMPORTED HOW MUCH (2026-11-20): one row per portal recruiter - how many imported candidates are theirs, the files and rows they
// brought in (new / merged / skipped), which way (spreadsheet, resumes, job-board mail ...) and when they last imported.
// Read from the portal (GET /api/portal-admin/imports); the same recruiter is named on each imported candidate in the portal's Talent Pool.
// ---------------------------------------------------------------------------
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export default function PortalImportsPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const load = () => api.get('/portal-admin/imports').then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(e.response?.data?.error || 'The imports could not be loaded.'));
  useEffect(() => { load(); }, []);
  const rows = ((d && d.recruiters) || []).filter((r) => !q.trim() || `${r.name} ${r.department}`.toLowerCase().includes(q.trim().toLowerCase()));
  const total = ((d && d.recruiters) || []).reduce((a, r) => a + r.candidates, 0);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row-actions" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Job Portal imports: who imported how much</h3>
        <span className="small-muted">{d ? `${total} imported candidates across ${(d.recruiters || []).filter((r) => r.candidates || r.files).length} recruiters${d.withoutOwner ? `, ${d.withoutOwner} with no owner` : ''}` : ''}</span>
        <input className="input" style={{ marginLeft: 'auto', maxWidth: 220 }} placeholder="Find a recruiter…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn-sm btn-ghost" onClick={load}>Refresh</button>
      </div>
      {err && <div className="small-muted" role="alert" style={{ color: '#9b1c1c', marginTop: 6 }}>{err}</div>}
      {!d && !err && <div className="small-muted">Loading…</div>}
      {d && (
        <div className="tbl-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>Recruiter</th><th>Department</th><th>Imported candidates</th><th>Files</th><th>Rows read</th><th>New</th><th>Merged</th><th>Skipped</th><th>By way</th><th>Last import</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td><td>{r.department || '—'}</td><td><b>{r.candidates}</b></td><td>{r.files}</td><td>{r.rowsRead}</td><td>{r.created}</td><td>{r.merged}</td><td>{r.skipped}</td>
                  <td style={{ whiteSpace: 'normal' }}>{Object.entries(r.bySource || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}</td>
                  <td>{when(r.lastImport)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={10} className="small-muted">No recruiter found.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
