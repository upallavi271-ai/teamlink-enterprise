import { useEffect, useState } from 'react';
import api from '../../api';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { PAGE_SIZES } from '../../components/Pager.jsx';

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

export default function AuditLogs() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState({ users: [], actions: [], entities: [], approvalStatuses: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZES[0]);

  const lf = useListFilters(logs, [
    { key: 'q', type: 'search', placeholder: 'Search action, record, value or person…', minWidth: 260 },
    { key: 'userId', label: 'User', allLabel: 'All users', options: facets.users, primary: true },
    { key: 'entity', label: 'Record type', allLabel: 'All record types', options: facets.entities, primary: true },
    { key: 'action', label: 'Action', allLabel: 'All actions', options: facets.actions, primary: true },
    { key: 'date', type: 'daterange', label: 'Date range', primary: true },
    { key: 'approvalStatus', label: 'Approval status', allLabel: 'All approval statuses', options: facets.approvalStatuses },
  ], { server: true, sorts: SORTS });

  // A new filter or sort starts again at page 1.
  useEffect(() => { setPage(1); }, [lf.paramsKey, lf.sort, size]);

  useEffect(() => {
    let alive = true;
    // The date range goes as from / to, which is what the route reads.
    const { dateFrom, dateTo, ...rest } = lf.params;
    const params = { ...rest, page, pageSize: size, sort: lf.sort };
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
  }, [lf.paramsKey, lf.sort, page, size]);

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
    </div>
  );
}
