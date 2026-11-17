import { useEffect, useState } from 'react';
import api from '../../api';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { PAGE_SIZES } from '../../components/Pager.jsx';
import HrSuperAccess from './HrSuperAccess.jsx';

// Audit Logs — the prototype's auditView() (line 10587). Column order is its
// own: User, Action, Entity, Date, Previous, New; the page subtitle is the
// recorded-action count.
//
// SERVER-SIDE PAGED + FILTERED. The trail is thousands of rows long, so the
// page asks GET /admin/audit?page=… (the paged mode of that route) with the
// filter values, and the server returns one page plus the option lists
// (`facets`) for the filter bar. Without ?page the route still answers with
// its old bare array of the latest 200.

const SORTS = [
  { key: 'new', label: 'Newest first' },
  { key: 'old', label: 'Oldest first' },
];

// TAMPER CHECK (backend utils/auditSeal.js): every audit row is sealed into a hash chain; this walks it.
function SealCheck() {
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <button type="button" className="btn btn-sm" disabled={busy} title="Proves no audit row was changed or deleted after it was recorded"
        onClick={async () => { setBusy(true); try { setOut((await api.post('/admin/audit/verify')).data); } catch (e) { setOut({ error: e.response?.data?.error || 'The check could not run.' }); } finally { setBusy(false); } }}>
        {busy ? 'Checking…' : '🔒 Check for tampering'}
      </button>
      {out && (out.error ? <span className="error-text">{out.error}</span>
        : out.ok ? (
          <span className="small-muted" style={{ color: 'var(--success, #157f3b)' }}>
            ✓ Untouched: the newest {Number(out.checked).toLocaleString('en-IN')} of {Number(out.sealed).toLocaleString('en-IN')} sealed rows checked now, none changed or deleted.
            {out.full ? ` Full check of every row ${new Date(out.full.at).toLocaleDateString('en-GB')}: ${out.full.ok ? 'OK' : 'BROKEN'}.` : ' The full check of every row runs tonight.'}
          </span>
        )
          : <span className="error-text">✗ Row {out.brokenAt.seq}: {out.brokenAt.why}{out.brokenAt.action ? ` (${out.brokenAt.action}, ${new Date(out.brokenAt.at).toLocaleString('en-GB')})` : ''}</span>)}
    </span>
  );
}

// WHO VIEWED (backend utils/readLog.js): candidate / employee records and documents opened, newest first.
function WhoViewed() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [f, setF] = useState({ entity: '', from: '', to: '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    const params = { page, size: 50, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) };
    api.get('/admin/read-log', { params }).then((r) => { setRows(r.data.rows || []); setTotal(r.data.total || 0); }).catch(() => setErr('Could not load.'));
  }, [page, f]);
  const set = (k) => (e) => { setPage(1); setF((x) => ({ ...x, [k]: e.target.value })); };
  const pages = Math.max(1, Math.ceil(total / 50));
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <select value={f.entity} onChange={set('entity')} style={{ width: 'auto' }}>
          <option value="">Everything opened</option><option value="Candidate">Candidates</option><option value="Employee">Employees</option><option value="Application">Client portal resumes</option>
        </select>
        <label className="small-muted">From <input type="date" value={f.from} onChange={set('from')} style={{ width: 'auto' }} /></label>
        <label className="small-muted">To <input type="date" value={f.to} onChange={set('to')} style={{ width: 'auto' }} /></label>
        <span className="small-muted">{total.toLocaleString('en-IN')} views (the same record by the same person within 10 minutes counts once)</span>
        <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={async () => {
          const r = await api.get('/admin/read-log', { params: { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), format: 'csv' }, responseType: 'blob' });
          const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `who-viewed-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
        }}>⬇ Download CSV</button>
      </div>
      {err && <div className="error-text">{err}</div>}
      <div className="tbl-wrap tbl-fit">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Opened</th><th>Record</th><th>IP</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.at).toLocaleString('en-GB')}</td>
                <td>{r.userName || '—'}{r.viewAsBy ? <span className="small-muted"> (View as by {r.viewAsBy})</span> : null}</td>
                <td>{r.what}</td>
                <td>{r.recordName || r.entityId}</td>
                <td>{r.ip || '—'}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="small-muted">Nothing recorded yet. Views are recorded from today.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="small-muted">Page {page} of {pages}</span>
          <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

export default function AuditLogs() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState({ users: [], actions: [], entities: [], approvalStatuses: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZES[0]);
  // Tabs inside this page (no sidebar entry): all activity / HR sensitive actions (Internal HR delete, export, import) / who has that access.
  const [view, setView] = useState('all');

  const lf = useListFilters(logs, [
    { key: 'q', type: 'search', placeholder: 'Search action, record, value or person…', minWidth: 260 },
    { key: 'userId', label: 'User', allLabel: 'All users', options: facets.users, primary: true },
    { key: 'entity', label: 'Record type', allLabel: 'All record types', options: facets.entities, primary: true },
    { key: 'action', label: 'Action', allLabel: 'All actions', options: facets.actions, primary: true },
    { key: 'date', type: 'daterange', label: 'Date range', primary: true },
    { key: 'approvalStatus', label: 'Approval status', allLabel: 'All approval statuses', options: facets.approvalStatuses },
  ], { server: true, sorts: SORTS });

  // A new filter or sort starts again at page 1.
  useEffect(() => { setPage(1); }, [lf.paramsKey, lf.sort, size, view]);

  useEffect(() => {
    let alive = true;
    // The date range goes as from / to, which is what the route reads.
    const { dateFrom, dateTo, ...rest } = lf.params;
    const params = { ...rest, page, pageSize: size, sort: lf.sort };
    if (view === 'hr') params.entity = 'HrSensitive';
    if (view === 'access' || view === 'viewed') return undefined;
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    setError('');
    api.get('/admin/audit', { params })
      .then((res) => {
        if (!alive) return;
        setLogs(res.data.rows || []);
        setTotal(res.data.total || 0);
        if (res.data.facets) setFacets(res.data.facets);
        setLoaded(true);
      })
      .catch(() => { if (alive) { setError('Could not load the audit trail.'); setLoaded(true); } });
    return () => { alive = false; };
  }, [lf.paramsKey, lf.sort, page, size, view]);

  const pages = Math.max(1, Math.ceil(total / size));
  const pager = {
    total, pages, size, setSize, page: Math.min(page, pages), setPage,
    from: total === 0 ? 0 : (page - 1) * size + 1,
    to: Math.min(page * size, total),
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>Audit Logs</h1>
          <div className="page-sub">
            {lf.activeCount
              ? `${total.toLocaleString('en-IN')} recorded actions match these filters`
              : `${total.toLocaleString('en-IN')} recorded actions`}
          </div></div>
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '6px 0 10px', flexWrap: 'wrap' }}>
        <button className={`btn btn-sm ${view === 'all' ? 'btn-primary' : ''}`} onClick={() => setView('all')}>All activity</button>
        <button className={`btn btn-sm ${view === 'hr' ? 'btn-primary' : ''}`} onClick={() => setView('hr')}>HR sensitive actions</button>
        <button className={`btn btn-sm ${view === 'access' ? 'btn-primary' : ''}`} onClick={() => setView('access')}>Who has Internal HR access</button>
        <button className={`btn btn-sm ${view === 'viewed' ? 'btn-primary' : ''}`} onClick={() => setView('viewed')} title="Who opened which candidate / employee record or document">Who viewed</button>
        <SealCheck />
        {view !== 'access' && view !== 'viewed' && (
          <button
            className="btn btn-sm"
            style={{ marginLeft: 'auto' }}
            title="Downloads the rows these filters pick (up to 50,000) as a CSV file"
            onClick={async () => {
              const { dateFrom, dateTo, ...rest } = lf.params;
              const params = { ...rest };
              if (view === 'hr') params.entity = 'HrSensitive';
              if (dateFrom) params.from = dateFrom;
              if (dateTo) params.to = dateTo;
              try {
                const r = await api.get('/admin/audit/export', { params, responseType: 'blob' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(r.data);
                a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(a.href);
              } catch { setError('The audit trail could not be downloaded.'); }
            }}
          >
            ⬇ Download CSV
          </button>
        )}
      </div>
      {view === 'viewed' ? <WhoViewed /> : view === 'access' ? <HrSuperAccess /> : (<>
      <ListFilterBar lf={lf} storageKey="admin-audit" />
      {error && <div className="error-text">{error}</div>}

      <div className="tbl-wrap tbl-fit">
        <table>
          <thead><tr><th>User</th><th>Action</th><th>Entity</th><th>Date</th><th>Previous</th><th>New</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{l.user?.name || l.actorName || 'System'}</td>
                <td>{l.action}{l.fieldLabel ? <div className="small-muted" style={{ fontSize: 11.5 }}>{l.fieldLabel}</div> : null}</td>
                <td>{l.entity}</td>
                <td className="cell-muted">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="cell-muted">{l.fromValue || '—'}</td>
                <td className="cell-muted">{l.toValue || '—'}</td>
              </tr>
            ))}
            {!loaded && (
              <tr><td colSpan="6" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>
            )}
            {loaded && logs.length === 0 && (
              <tr><td colSpan="6"><ListEmpty lf={lf} noun="audit entries" title="No activity yet." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={pager} noun="audit entries" />
      </>)}
    </div>
  );
}
