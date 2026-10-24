import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { BarList, Meter } from '../../components/Chart.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { downloadCsv } from '../../utils/csv.js';
import { canExportReports, can } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import { clientAliasText } from '../../components/searchMatch.js'; // old client names find a row (matching only)
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
// Client revenue (ATS change list §17): invoiced / received / late per client, compare periods.
import AtsReports from './AtsReports.jsx';
import TeamReports from './TeamReports.jsx';
// B2 — Placement margin (fee − credit notes − incentive − partner payouts) per placement / client / recruiter / month.
import PlacementMargin from './PlacementMargin.jsx';
// Every number opens its list (reconciliation 2026-10-06): the same list component the Accounts Dashboard uses.
import { DrillPanel } from '../accounts/dash/Drill.jsx';
import '../accounts/dash/accDash.css';

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
  // The list behind a number, opened right under the block it was clicked in.
  const [drill, setDrill] = useState(null);

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
  const keepClient = (r) => (!client || r.client === client) && (!needle || `${r.client} ${clientAliasText(r.client)}`.toLowerCase().includes(needle));
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

  const D = data.drill || { invoices: [], bills: [], bank: [] };
  const show = (where, title, kind, rows, note) => setDrill((d) => (d && d.title === title ? null : { where, title, kind, rows, note }));
  const panel = (where) => (drill && drill.where === where ? <div className="acd" style={{ margin: '10px 0' }}><DrillPanel drill={drill} onClose={() => setDrill(null)} /></div> : null);
  // A figure that opens its list.
  const Num = ({ where, title, kind = 'inv', rows, note, children }) => (
    <button type="button" className="link-btn" style={{ font: 'inherit', textDecoration: 'underline dotted', cursor: 'pointer', padding: 0 }} title="Click to see the list" onClick={() => show(where, title, kind, rows, note)}>{children}</button>
  );
  const ofClient = (name) => D.invoices.filter((i) => i.client === name);
  const owing = (i) => i.pending > 0.5 || i.pending < -0.5;

  const viewSwitch = (
    <div className="report-groupby" style={{ margin: '0 0 12px' }} role="tablist" aria-label="Accounts reports">
      {[['ledger', 'Receivables'], ['revenue', 'Client revenue'], ['teamcash', 'Team-wise cash'], ...(canMargin ? [['margin', 'Placement margin']] : [])].map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={view === id} className={`report-tab${view === id ? ' is-on' : ''}`} onClick={() => setView(id)}>{label}</button>
      ))}
    </div>
  );
  if (view === 'revenue') return <div>{viewSwitch}<AtsReports fixedTab="revenue" /></div>;
  // Billed / collected / still to come for each team and person, with Excel + PDF (server-scoped; read-only).
  if (view === 'teamcash') return <div>{viewSwitch}<TeamReports fixedReport="cash" embedded /></div>;
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
            <Combo value={sort} onChange={(e) => setSort(e.target.value)}>
              {RECV_SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Combo>
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
                <td>{r.client}</td>
                <td><Num where="recv" title={`${r.client} — invoices`} rows={ofClient(r.client)}>{money(r.invoiced)}</Num></td>
                <td><Num where="recv" title={`${r.client} — invoices with money received`} rows={ofClient(r.client).filter((i) => i.received > 0.005)}>{money(r.paid)}</Num></td>
                <td><Num where="recv" title={`${r.client} — invoices with money still to come`} rows={ofClient(r.client).filter(owing)}>{money(r.pending)}</Num></td>
              </tr>
            ))}
            {receivables.length === 0 && noMatch(4)}
          </tbody>
        </table>
      </div>

      {panel('recv')}
      <div className="small-muted" style={{ margin: '16px 0 8px' }}>
        Invoiced is amount + GST − TDS and Paid is the money actually received, so a part-paid invoice reads correctly.
      </div>

      <div className="statbar">
        <Stat n={<Num where="stat" title="Income: the invoices (before GST)" rows={D.invoices}>{money(data.profitAndLoss.incomeNet)}</Num>} l="Income (excl. GST)" />
        <Stat n={<Num where="stat" title="Spend: the office bills (before GST)" kind="bill" rows={D.bills}>{money(data.profitAndLoss.spendNet)}</Num>} l="Spend (excl. GST)" />
        <Stat n={money(data.profitAndLoss.profit)} l="Profit = income − spend" />
        <Stat n={<Num where="stat" title="TDS deducted: the invoices" rows={D.invoices.filter((i) => i.tds > 0.005)}>{money(data.tdsDeducted)}</Num>} l="TDS deducted" />
        <Stat n={<Num where="stat" title="Unmatched bank lines" kind="bank" rows={D.bank.filter((t) => t.state === 'Unmatched')}>{data.reconciliation.unmatched}</Num>} l="Unmatched bank lines" />
      </div>
      {panel('stat')}

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
                <tr key={r.status}><td>{r.status}</td><td><Num where="status" title={`${r.status} invoices`} rows={D.invoices.filter((i) => i.status === r.status)}>{r.count}</Num></td><td>{money(r.amount)}</td><td>{money(r.outstanding)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {panel('status')}
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
                <tr key={r.bucket}><td>{r.bucket}</td><td><Num where="ageing" title={`Open invoices — ${r.bucket}`} rows={D.invoices.filter((i) => i.bucket === r.bucket)}>{r.count}</Num></td><td>{money(r.outstanding)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {panel('ageing')}
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
                <tr key={r.client}><td>{r.client}</td><td><Num where="client" title={`${r.client} — open invoices`} rows={ofClient(r.client).filter((i) => i.status !== 'Paid')}>{r.count}</Num></td><td>{money(r.outstanding)}</td></tr>
              ))}
              {byClient.length === 0 && noMatch(3)}
            </tbody>
          </table>
        </div>
      </div>

      {panel('client')}
      <div className="grid-2">
        <div className="card section">
          <h3>GST position</h3>
          <div className="kv"><span className="k">Charged to clients</span><span><Num where="gst" title="Invoices that carry GST" rows={D.invoices.filter((i) => i.gst > 0.005)}>{money(data.gstPosition.charged)}</Num></span></div>
          <div className="kv"><span className="k">Paid to vendors</span><span>− <Num where="gst" title="Bills that carry GST" kind="bill" rows={D.bills.filter((b) => b.gst > 0.005)}>{money(data.gstPosition.paid)}</Num></span></div>
          <div className="kv">
            <span className="k">{data.gstPosition.payable >= 0 ? 'Payable' : 'Credit carried'}</span>
            <span style={{ fontWeight: 700 }}>{money(Math.abs(data.gstPosition.payable))}</span>
          </div>
        </div>
        <div className="card section">
          <h3>Reconciliation position</h3>
          <div className="kv"><span className="k">Statement lines</span><span><Num where="recon" title="All statement lines" kind="bank" rows={D.bank}>{data.reconciliation.total}</Num></span></div>
          <div className="kv"><span className="k">Unmatched</span><span><Num where="recon" title="Unmatched statement lines" kind="bank" rows={D.bank.filter((t) => t.state === 'Unmatched')}>{data.reconciliation.unmatched}</Num></span></div>
          <div className="kv"><span className="k">Matched, not reconciled</span><span><Num where="recon" title="Matched statement lines" kind="bank" rows={D.bank.filter((t) => t.state === 'Matched')}>{data.reconciliation.matched}</Num></span></div>
          <div className="kv"><span className="k">Reconciled</span><span><Num where="recon" title="Reconciled statement lines" kind="bank" rows={D.bank.filter((t) => t.state === 'Reconciled')}>{data.reconciliation.reconciled}</Num></span></div>
          <div className="kv"><span className="k">Ignored</span><span><Num where="recon" title="Ignored statement lines" kind="bank" rows={D.bank.filter((t) => t.state === 'Ignored')}>{data.reconciliation.ignored}</Num></span></div>
        </div>
      </div>
      {panel('gst')}
      {panel('recon')}
    </div>
  );
}

function Stat({ n, l }) {
  return <div className="statitem"><div className="n">{n}</div><div className="l">{l}</div></div>;
}
