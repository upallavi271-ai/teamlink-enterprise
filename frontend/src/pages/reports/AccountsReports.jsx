import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { downloadCsv } from '../../utils/csv.js';
import { canExportReports } from '../../permissions';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export default function AccountsReports() {
  const { user } = useAuth();
  const canExport = canExportReports(user, 'Accounts Reports');
  const [data, setData] = useState(null);
  const [client, setClient] = useState('');
  const [pick, setPick] = useState('');

  useEffect(() => {
    api.get('/reports/accounts').then((res) => setData(res.data));
  }, []);

  if (!data) return <div className="small-muted">Loading…</div>;

  const receivables = client ? data.receivables.filter((r) => r.client === client) : data.receivables;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Accounts Reports</h1>
          <div className="page-sub">Receivables &amp; billing</div>
        </div>
      </div>

      <div className="filter-row">
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">All clients</option>
          {data.receivables.map((r) => <option key={r.client}>{r.client}</option>)}
        </select>
        <button className="btn btn-sm btn-primary" onClick={() => setClient(pick)}>Apply</button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setPick(''); setClient(''); }}>Clear</button>
        {canExport
          ? (
            <button
              className="btn btn-sm"
              onClick={() => downloadCsv('accounts-report.csv', ['Client', 'Invoiced', 'Paid', 'Pending'],
                receivables.map((r) => [r.client, r.invoiced, r.paid, r.pending]))}
            >
              Export CSV
            </button>
          )
          : <span className="small-muted">Export isn&apos;t included in your role&apos;s permissions</span>}
      </div>

      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Client</th><th>Invoiced</th><th>Paid</th><th>Pending</th></tr></thead>
          <tbody>
            {receivables.map((r) => (
              <tr key={r.client}>
                <td>{r.client}</td><td>{money(r.invoiced)}</td><td>{money(r.paid)}</td><td>{money(r.pending)}</td>
              </tr>
            ))}
            {receivables.length === 0 && <tr><td colSpan="4" className="small-muted" style={{ padding: 16 }}>No data for this filter.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="small-muted" style={{ margin: '16px 0 8px' }}>
        Invoiced is amount + GST − TDS and Paid is the money actually received, so a part-paid invoice reads correctly.
      </div>

      <div className="statbar">
        <Stat n={money(data.profitAndLoss.incomeNet)} l="Income (excl. GST)" />
        <Stat n={money(data.profitAndLoss.spendNet)} l="Spend (excl. GST)" />
        <Stat n={money(data.profitAndLoss.profit)} l="Profit" />
        <Stat n={money(data.tdsDeducted)} l="TDS deducted" />
        <Stat n={data.reconciliation.unmatched} l="Unmatched bank lines" />
      </div>

      <div className="card section">
        <h3>Invoices by status</h3>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Status</th><th>Count</th><th>Total</th><th>Outstanding</th></tr></thead>
            <tbody>
              {data.byStatus.map((r) => (
                <tr key={r.status}><td>{r.status}</td><td>{r.count}</td><td>{money(r.amount)}</td><td>{money(r.outstanding)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section">
        <h3>Receivables ageing</h3>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Bucket</th><th>Invoices</th><th>Outstanding</th></tr></thead>
            <tbody>
              {data.ageing.map((r) => (
                <tr key={r.bucket}><td>{r.bucket}</td><td>{r.count}</td><td>{money(r.outstanding)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section">
        <h3>Outstanding by client</h3>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Client</th><th>Open invoices</th><th>Outstanding</th></tr></thead>
            <tbody>
              {data.byClient.map((r) => (
                <tr key={r.client}><td>{r.client}</td><td>{r.count}</td><td>{money(r.outstanding)}</td></tr>
              ))}
              {data.byClient.length === 0 && <tr><td colSpan="3" className="small-muted">Nothing outstanding.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid-2">
        <div className="card section">
          <h3>GST position</h3>
          <div className="kv"><span className="k">Charged to clients</span><span>{money(data.gstPosition.charged)}</span></div>
          <div className="kv"><span className="k">Paid to vendors</span><span>− {money(data.gstPosition.paid)}</span></div>
          <div className="kv">
            <span className="k">{data.gstPosition.payable >= 0 ? 'Payable' : 'Credit carried'}</span>
            <span style={{ fontWeight: 700 }}>{money(Math.abs(data.gstPosition.payable))}</span>
          </div>
        </div>
        <div className="card section">
          <h3>Reconciliation position</h3>
          <div className="kv"><span className="k">Statement lines</span><span>{data.reconciliation.total}</span></div>
          <div className="kv"><span className="k">Unmatched</span><span>{data.reconciliation.unmatched}</span></div>
          <div className="kv"><span className="k">Matched, not reconciled</span><span>{data.reconciliation.matched}</span></div>
          <div className="kv"><span className="k">Reconciled</span><span>{data.reconciliation.reconciled}</span></div>
          <div className="kv"><span className="k">Ignored</span><span>{data.reconciliation.ignored}</span></div>
        </div>
      </div>
    </div>
  );
}

function Stat({ n, l }) {
  return <div className="statitem"><div className="n">{n}</div><div className="l">{l}</div></div>;
}
