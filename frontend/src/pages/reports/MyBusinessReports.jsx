import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';

// ---------------------------------------------------------------------------
// MY BUSINESS REPORTS (BDE business workspace, 2026-10-10) - a tab of ATS Reports, never a sidebar entry.
// Three small reports for the BDE's own work: My clients, My requirements, My follow-ups. Each is a plain table with a
// search box; "Download" appears only when the Role Catalog tick "Export assigned data" is on (off by default).
// ---------------------------------------------------------------------------
const VIEWS = [
  ['clients', 'My clients', 'Every client that is yours and where it stands.'],
  ['requirements', 'My requirements', 'The requirements of your clients that are not closed.'],
  ['followups', 'My follow-ups', 'Your follow-ups and client meetings: coming, today, late and done.'],
];

export default function MyBusinessReports() {
  const [kind, setKind] = useState('clients');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setData(null); setError('');
    api.get(`/clients/my-reports/${kind}`).then((r) => setData(r.data)).catch((e) => setError(e.response?.status === 403 ? 'This report is not ticked for your role.' : 'Could not load this report. Please try again.'));
  }, [kind]);
  const about = VIEWS.find(([k]) => k === kind)[2];
  const rows = (data?.rows || []).filter((r) => !q.trim() || Object.values(r).some((v) => String(v).toLowerCase().includes(q.trim().toLowerCase())));
  async function download() {
    setBusy(true); setError('');
    try {
      const res = await api.get(`/clients/my-reports/${kind}`, { params: { format: 'csv' }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url; a.download = `${kind}.csv`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { setError('Could not download. Please try again.'); } finally { setBusy(false); }
  }
  const linkOf = (r, c) => {
    if (kind === 'clients' && c.key === 'name') return `/clients/${r.id}`;
    if (kind === 'requirements' && c.key === 'title') return `/requirements/${r.id}`;
    return null;
  };
  return (
    <div className="panel" style={{ padding: 14 }}>
      <div className="cbz-kinds" role="group" aria-label="Which report" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" className={`btn btn-sm${kind === k ? ' btn-primary' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
        ))}
      </div>
      <div className="small-muted" style={{ marginBottom: 8 }}>{about}</div>
      {error && <div className="error-text">{error}</div>}
      {data && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" style={{ maxWidth: 260 }} />
            <span className="small-muted">{`${rows.length} of ${data.total}`}</span>
            {data.canExport && <button type="button" className="btn btn-sm" disabled={busy} onClick={download}>⬇ Download</button>}
          </div>
          {!rows.length ? <div className="small-muted">{data.total ? 'Nothing matches your search.' : 'Nothing here yet. It fills in as you work.'}</div> : (
            <div className="tbl-wrap">
              <table>
                <thead><tr>{data.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      {data.columns.map((c) => {
                        const to = linkOf(r, c);
                        return <td key={c.key}>{to ? <Link to={to}>{r[c.key]}</Link> : String(r[c.key] ?? '')}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {!data && !error && <div className="small-muted">Loading…</div>}
    </div>
  );
}
