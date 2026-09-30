import './EmpMgmtExtras.css';

// ---------------------------------------------------------------------------
// TRANSFER HISTORY — seats held (from → to, dates, who they took over from)
// plus department / team / reporting / position changes from the audit trail,
// with who made each change. Built by the server (GET /employees/management/
// :id → transferHistory, utils/employeeAdmin.js transferHistoryOf), which has
// already scope-checked the record.
// ---------------------------------------------------------------------------
const when = (d) => {
  if (!d) return '—';
  const iso = String(d);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export default function TransferHistory({ entries, isLead }) {
  const list = entries || [];
  if (!list.length && !isLead) return null;
  return (
    <>
      <h4 style={{ margin: '14px 0 6px' }}>Transfer history</h4>
      {list.length === 0 ? (
        <div className="empty-mini">No seat, department, team or reporting changes are recorded for this employee yet.</div>
      ) : (
        <div className="tbl-wrap">
          <table className="emgx-th-table">
            <thead><tr><th>Date</th><th>Change</th><th>From</th><th>To</th><th>By</th></tr></thead>
            <tbody>
              {list.map((t, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{when(t.date)}</td>
                  <td><span className="emgx-kind">{t.kind}</span>{t.current ? <span className="small-muted"> · current</span> : null}</td>
                  <td className="cell-muted">{t.from || '—'}</td>
                  <td>
                    {t.to || '—'}
                    {t.detail && <div className="small-muted" style={{ fontSize: 11.5 }}>{t.detail}</div>}
                  </td>
                  <td className="cell-muted">{t.by || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
