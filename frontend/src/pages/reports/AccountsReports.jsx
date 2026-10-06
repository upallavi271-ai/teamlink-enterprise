import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { BarList, Meter } from '../../components/Chart.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { downloadCsv } from '../../utils/csv.js';
import { canExportReports, can } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
// Client revenue (ATS change list §17): invoiced / received / late per client, compare periods.
import AtsReports from './AtsReports.jsx';
// B2 — Placement margin (fee − credit notes − incentive − partner payouts) per placement / client / recruiter / month.
import PlacementMargin from './PlacementMargin.jsx';

const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
const RECV_SORTS = [
  ['pending', 'Pending high → low', (a, b) => b.pending - a.pending],
  ['invoiced', 'Invoiced high → low', (a, b) => b.invoiced - a.invoiced],
  ['name', 'Client A–Z', (a, b) => String(a.client).localeCompare(String(b.client))],
];

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export default function AccountsReports() {
  const { user } = useAuth();
  const canExport = canExportReports(user, 'Accounts Reports');
  // The margin reads the invoice register — only for logins that hold Invoices.
  const canMargin = can(user, 'accounts', 'accounts', 'Invoices', 'view');
  // Two views: this page's receivables, and the Client revenue report (§17).
  const [view, setView] = useState('ledger');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // Search + Client narrow the client tables here; the Date range is asked of
  // the API (invoice date / bill date / statement date) and narrows every figure.
  const [client, setClient] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('pending');

  useEffect(() => {
    setError('');
    const params = {};
    if (from) params.from = from;
    if (to) params.to = to;
    api.get('/reports/accounts', { params })
      .then((res) => setData(res.data))
      .catch((e) => setError(e.response?.data?.error || 'The report could not be loaded.'));
  }, [from, to]);

  const clientNames = useMemo(() => [...new Set([...(data?.receivables || []), ...(data?.byClient || [])].map((r) => r.client))]
    .sort((a, b) => a.localeCompare(b)), [data]);

  if (!data) return error ? <div className="notice red"><span>{error}</span></div> : <div className="small-muted">Loading…</div>;

  const needle = q.trim().toLowerCase();
  const keepClient = (r) => (!client || r.client === client) && (!needle || String(r.client).toLowerCase().includes(needle));
  const cmp = (RECV_SORTS.find(([k]) => k === sort) || RECV_SORTS[0])[2];
  const receivables = data.receivables.filter(keepClient).sort(cmp);
  const byClient = data.byClient.filter(keepClient);
  const on = !!(client || needle || from || to);
  const clearAll = () => { setClient(''); setQ(''); setFrom(''); setTo(''); };
  const chips = [
    needle && { key: 'q', label: 'Search', value: q.trim(), onRemove: () => setQ('') },
    client && { key: 'client', label: 'Client', value: client, onRemove: () => setClient('') },
    (from || to) && { key: 'date', label: 'Date range', value: from && to ? `${dmy(from)} → ${dmy(to)}` : from ? `from ${dmy(from)}` : `to ${dmy(to)}`, onRemove: () => { setFrom(''); setTo(''); } },
  ].filter(Boolean);
  const noMatch = (cols) => (
    <tr>
      <td colSpan={cols}>
        {on
          ? <EmptyState compact icon="🔍" title="No clients match these filters." hint="Remove a filter chip above, or clear all filters." action={<button type="button" className="btn btn-sm" onClick={clearAll}>Clear filters</button>} />
          : <span className="small-muted">Nothing outstanding.</span>}
      </td>
    </tr>
  );

  const viewSwitch = (
    <div className="report-groupby" style={{ margin: '0 0 12px' }} role="tablist" aria-label="Accounts reports">
      {[['ledger', 'Receivables'], ['revenue', 'Client revenue'], ...(canMargin ? [['margin', 'Placement margin']] : [])].map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={view === id} className={`report-tab${view === id ? ' is-on' : ''}`} onClick={() => setView(id)}>{label}</button>
      ))}
    </div>
  );
  if (view === 'revenue') return <div>{viewSwitch}<AtsReports fixedTab="revenue" /></div>;
  if (view === 'margin') return <div>{viewSwitch}<PlacementMargin canExport={canExport} /></div>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Accounts Reports</h1>
          <div className="page-sub">Receivables &amp; billing</div>
        </div>
      </div>
      {viewSwitch}

      {error && <div className="notice red"><span>{error}</span></div>}
      <MoreFilters
        onClearAll={on ? clearAll : undefined}
        primary={(
          <>
            <input type="search" value={q} placeholder="Search client…" onChange={(e) => setQ(e.target.value)} aria-label="Search" style={{ minWidth: 200 }} />
            <Combo value={client} title="Client" onChange={(e) => setClient(e.target.value)}>
              <option value="">All clients</option>
              {clientNames.map((c) => <option key={c} value={c}>{c}</option>)}
            </Combo>
            <span className="small-muted">Date range</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Date range from" title="Invoice / bill / statement date from" />
            <span aria-hidden="true">→</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Date range to" title="Invoice / bill / statement date to" />
          </>
        )}
        extra={(
          <label className="small-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {RECV_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        )}
      />
      <FilterChips filters={chips} onClearAll={on ? clearAll : undefined} />
      <div className="filter-row">
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
            {receivables.length === 0 && noMatch(4)}
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
        {/* An invoice has exactly one status, so these parts do sum to the
            whole and a share meter says something true. */}
        <div style={{ margin: "4px 0 16px" }}>
          <Meter
            rows={data.byStatus.map((r) => ({ label: r.status, value: r.count }))}
            format={(v) => v.toLocaleString("en-IN")}
          />
        </div>
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
        {/* Left in bucket order, not sorted by size: the order IS the
            meaning here — money moving rightwards is money going bad. */}
        <div style={{ margin: "4px 0 16px" }}>
          <BarList
            rows={data.ageing.map((r) => ({ label: r.bucket, value: r.outstanding }))}
            format={money}
            empty="Nothing outstanding."
          />
        </div>
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
        {byClient.length > 0 && (
          <div style={{ margin: "4px 0 16px" }}>
            <BarList
              rows={[...byClient]
                .sort((a, b) => b.outstanding - a.outstanding)
                .slice(0, 8)
                .map((r) => ({ label: r.client, value: r.outstanding }))}
              format={money}
            />
          </div>
        )}
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Client</th><th>Open invoices</th><th>Outstanding</th></tr></thead>
            <tbody>
              {byClient.map((r) => (
                <tr key={r.client}><td>{r.client}</td><td>{r.count}</td><td>{money(r.outstanding)}</td></tr>
              ))}
              {byClient.length === 0 && noMatch(3)}
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
