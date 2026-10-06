import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../../api';
import DeskBoard from '../../../components/dashboard/DeskBoard.jsx';
import OutflowCard from '../../office/OutflowCard.jsx';
import { money, fmtD } from '../../invoices/invFormat';

// The rest of the earlier Accounts dashboard, kept (spec S8: "no removals"):
// today's Accounts desk, the salary + office outflow, the month-by-month
// summary and the bank lines still to deal with. Closed by default and loaded
// only when opened; these are NOT narrowed by the filters above (they say so).
export default function MoreTools() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open || data) return;
    api.get('/dashboard/accounts', { params: { period: 'all' } })
      .then((r) => setData(r.data))
      .catch((e) => setErr(e.response?.data?.error || 'This part could not be loaded.'));
  }, [open, data]);

  return (
    <details className="acd-sec acd-more" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>More: today&apos;s Accounts desk, month by month, salary outflow, bank lines</summary>
      {open && (
        <>
          <div className="notice"><span>These lists are the whole business — the filters above do not narrow them.</span></div>
          <DeskBoard url="/dashboard/accounts/desk" title="Accounts desk — today" sub="Every number opens its list" />
          <OutflowCard period={`M:${new Date().toISOString().slice(0, 7)}`} />
          {err && <div className="notice red"><span>{err}</span></div>}
          {!data && !err && <div className="small-muted">Loading…</div>}
          {data && (
            <>
              <h3 style={{ fontSize: 13.5, margin: '12px 0 6px' }}>Month by month (every month on record)</h3>
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Month</th><th className="num">Invoices</th><th className="num">Before GST</th><th className="num">GST</th>
                      <th className="num">After GST</th><th className="num">TDS</th><th className="num">Received</th><th className="num">Pending</th>
                      <th className="num">Cash in (by payment date)</th><th className="num">Office spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byMonth.map((r) => (
                      <tr key={r.month}>
                        <td><b>{r.label}</b></td>
                        <td className="num">{r.invoices}</td>
                        <td className="num">{money(r.billing)}</td>
                        <td className="num">{money(r.gst)}</td>
                        <td className="num">{money(r.invoiceValue)}</td>
                        <td className="num">{money(r.tds)}</td>
                        <td className="num">{money(r.received)}</td>
                        <td className="num">{money(r.pending)}</td>
                        <td className="num">{money(r.cash)}</td>
                        <td className="num">{money(r.spend)}</td>
                      </tr>
                    ))}
                    {!data.byMonth.length && <tr><td colSpan="10" className="small-muted">No invoices on record yet.</td></tr>}
                  </tbody>
                </table>
              </div>
              <h3 style={{ fontSize: 13.5, margin: '14px 0 6px' }}>Bank lines still to deal with</h3>
              {data.unreconciledTransactions.map((t) => (
                <div className="acd-kv" key={t.id}>
                  <span className="k">{fmtD(t.date)} · {t.description}</span>
                  <b>{money(t.amount)} <span className="small-muted">({t.state})</span></b>
                </div>
              ))}
              {!data.unreconciledTransactions.length && <div className="small-muted">All bank lines are dealt with.</div>}
              <div style={{ marginTop: 8 }}><Link to="/bank">Open Bank &amp; Reconciliation →</Link></div>
            </>
          )}
        </>
      )}
    </details>
  );
}
