import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import {
  statusClass, money, money2, fmtD, Stat,
} from './Invoices.jsx';

export { money };

// The Accounts dashboard as the accounting application draws it: a period you
// pick (financial year, half, quarter or month), the money columns for exactly
// those dates, and then office spend, the GST position, client-by-client
// collections and the collection position underneath. Net profit is
// billing − TDS; GST collected is payable to Government, so it is never
// counted as profit. Dropped candidates are excluded from every money column.
export default function AccountsDashboard() {
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState('');
  const [f, setF] = useState({ client: 'All', department: 'All', status: 'All', q: '' });

  const load = useCallback(() => {
    api.get('/dashboard/accounts', { params: { ...(period ? { period } : {}), ...f } })
      .then((res) => setData(res.data))
      .catch(() => setData(null));
  }, [period, f]);
  useEffect(load, [load]);

  if (!data) return null;
  const m = data.money;
  const g = data.gstPosition;
  const p = data.period;
  const pm = data.pendingMatrix || { months: [], monthLabels: [], clients: [], rows: [] };

  const owing = data.byClient.filter((c) => !c.settled);
  const settled = data.byClient.filter((c) => c.settled && c.received > 0);
  const totalReceivable = data.byClient.reduce((s, c) => s + c.receivable, 0);
  const totalReceived = data.byClient.reduce((s, c) => s + c.received, 0);
  const totalPending = owing.reduce((s, c) => s + c.pending, 0);
  const missingProof = data.byClient.reduce((s, c) => s + (c.noProof || 0), 0);

  const clientRow = (c) => (
    <tr key={c.client}>
      <td><b>{c.client}</b>{c.parts > 1 ? <span className="status" style={{ marginLeft: 6 }}>{c.parts} part payments</span> : null}</td>
      <td className="small-muted">{c.department || '—'}</td>
      <td className="num" style={{ fontWeight: 600 }}>{money(c.billing)}</td>
      <td className="num">{money(c.invoiceValue)}</td>
      <td className="num">{money(c.receivable)}</td>
      <td className="num">{c.received ? money(c.received) : '—'}</td>
      <td className="num" style={{ fontWeight: 700 }}>{c.pending > 0.5 ? money(c.pending) : 'settled'}</td>
      <td className="num">{c.collectedPct}%</td>
      <td>{c.lastPayment ? fmtD(c.lastPayment) : <span className="small-muted">never</span>}</td>
      <td>{c.parts ? (c.noProof ? <span className="status priority-high">{c.noProof} missing</span> : <span className="status priority-low">ok</span>) : <span className="small-muted">—</span>}</td>
    </tr>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounts Dashboard</h1>
          <div className="page-sub">
            Income before and after GST, TDS, collections and net profit for the financial year,
            half, quarter or month you pick. Dropped candidates are excluded from every money column.
          </div>
        </div>
      </div>

      <div className="filter-row">
        <label className="field"><span>Client · {data.filterOptions.clients.length} of {data.filterOptions.clientsEver}</span>
          <select value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })}>
            <option>All</option>{data.filterOptions.clients.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 230 }}><span>Period</span>
          <select value={period || p.sel} onChange={(e) => setPeriod(e.target.value)}>
            {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="field"><span>Department</span>
          <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>
            <option>All</option>{data.filterOptions.departments.map((d) => <option key={d}>{d}</option>)}
          </select>
        </label>
        <label className="field"><span>Status</span>
          <select title="Received and Paid mean the same thing — the whole invoice is in" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            {data.filterOptions.statuses.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 220 }}><span>Search anything</span>
          <input value={f.q} placeholder="Client, invoice no, GSTIN…" onChange={(e) => setF({ ...f, q: e.target.value })} />
        </label>
        {(f.client !== 'All' || f.department !== 'All' || f.status !== 'All' || f.q.trim())
          && <button className="btn btn-sm" onClick={() => setF({ client: 'All', department: 'All', status: 'All', q: '' })}>Reset all</button>}
        <span className="small-muted">showing <b>{data.showing.invoices}</b> of {data.showing.of} invoices</span>
      </div>

      <div className="notice">
        <span>
          <b>{p.label}</b> — {p.all ? 'every month on record' : `${fmtD(p.from)} to ${fmtD(p.to)}`}. Every figure on
          this page is for those dates. The financial year runs April to March and rolls over on its own.
        </span>
      </div>

      <div className="statbar">
        <Stat n={m.candidates} l="Total candidates" s={`${m.candidates} billed · no drops`} />
        <Stat n={money(m.billing)} l="Income before GST" s="Fee earned — this is your income" />
        <Stat n={money(m.invoiceValue)} l="Income after GST" s="What the client is invoiced" />
        <Stat n={money(m.gst)} l="GST on top" s="Collected for Govt — never income" />
        <Stat n={money(m.tds)} l="TDS deducted" s="By clients" />
        <Stat n={money(m.profit)} l="Net profit" s="Billing − TDS" tone="good" />
        <Stat n={money(m.received)} l="Amount received" s={`${m.collectedPct}% of ${money(m.receivable)} receivable`} tone="good" />
        <Stat n={money(m.pending)} l="Pending amount" s={`${m.openRows} open row(s)`} tone="bad" />
        <Stat n={m.overdueInvoices} l="Overdue invoices" s="Past payment due date" tone="bad" />
        {/* Office expenses is cash already out, and profit after expenses nets
            off that same figure — money not yet paid is not spent. */}
        <Stat n={money(m.expensePaid)} l="Office expenses" s={`${m.expenseCount} entr${m.expenseCount === 1 ? 'y' : 'ies'}${m.expensePending ? ` · ${money(m.expensePending)} pending` : ''}`} />
        <Stat
          n={money(m.profitAfterExpenses)}
          l="Profit after expenses"
          s="Open Profit & Loss for the full picture"
          tone={m.profitAfterExpenses >= 0 ? 'good' : 'bad'}
        />
      </div>

      <div className="card section">
        <h3>Office spend</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>{p.label} — where the money goes, by category</div>
        {data.spendByCategory.map((c) => (
          <div className="kv" key={c.category}>
            <span className="k">{c.category} <span className="small-muted">({c.count})</span></span>
            <span>{money(c.net)}</span>
          </div>
        ))}
        {data.spendByCategory.length === 0 && <div className="small-muted">Nothing spent in this period.</div>}
        <div style={{ marginTop: 10 }}><Link to="/office">Office &amp; Accounts →</Link></div>
      </div>

      <div className="card section">
        <h3>GST position</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {p.label} — what clients pay us against what we pay others
        </div>
        <div className="statbar">
          <Stat n={money(g.charged)} l="GST clients pay us" s="Charged on our invoices" />
          <Stat n={money(g.collected)} l="Of that, collected" s={`${g.collectedPct}% is actually in the bank`} tone="good" />
          <Stat n={money(g.stillToCome)} l="Still to come" s="Rides on the pending invoices" tone="bad" />
          <Stat n={money(g.paid)} l="GST we pay others" s="Vendor and office bills" />
          <Stat
            n={money(g.unclaimableValue)}
            l="Cannot be claimed yet"
            s={g.unclaimableCount ? `${g.unclaimableCount} bill(s) with no vendor GSTIN` : 'every bill has a GSTIN'}
            tone={g.unclaimableValue > 0.5 ? 'bad' : 'good'}
          />
          <Stat
            n={money(Math.abs(g.payable))}
            l={g.payable >= 0 ? 'Payable to Government' : 'Credit carried'}
            s={`charged ${money(g.charged)} − paid ${money(g.paid)}`}
            tone={g.payable >= 0 ? 'bad' : 'good'}
          />
        </div>
        <div className="notice">
          <span>
            GST is never income and never an expense — it is collected on Government&apos;s behalf and paid
            across after setting off what we already paid our vendors.
          </span>
        </div>
      </div>

      {/* Pending & received, client by client — the clients still owing first,
          then the ones that have settled. */}
      <div className="card section">
        <h3>Pending &amp; received, client by client</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {owing.length} client(s) still owe money · click a client for the instalment history
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th><th>Department</th><th className="num">Before GST</th><th className="num">After GST</th>
                <th className="num">Receivable</th><th className="num">Received</th><th className="num">Pending</th>
                <th className="num">Collected</th><th>Last payment</th><th>Proof</th>
              </tr>
            </thead>
            <tbody>
              {owing.map(clientRow)}
              {owing.length === 0 && <tr><td colSpan="10" className="small-muted">Nothing outstanding.</td></tr>}
              {settled.length > 0 && (
                <tr><td colSpan="10" className="section-label">Fully settled · {settled.length} client(s)</td></tr>
              )}
              {settled.map(clientRow)}
            </tbody>
            <tfoot>
              <tr>
                <td>TOTAL</td><td />
                <td className="num">{money(data.byClient.reduce((s, c) => s + c.billing, 0))}</td>
                <td className="num">{money(data.byClient.reduce((s, c) => s + c.invoiceValue, 0))}</td>
                <td className="num">{money(totalReceivable)}</td>
                <td className="num">{money(totalReceived)}</td>
                <td className="num" style={{ fontWeight: 700 }}>{money(totalPending)}</td>
                <td className="num">{totalReceivable ? Math.round((totalReceived / totalReceivable) * 100) : 0}%</td>
                <td />
                <td>{missingProof ? <span className="status priority-high">{missingProof} missing</span> : null}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card section">
        <h3>Collection position</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>{p.label}</div>
        <div className="kv"><span className="k">Invoice value</span><span>{money(m.invoiceValue)}</span></div>
        <div className="kv"><span className="k">Less TDS deducted</span><span>({money(m.tds)})</span></div>
        <div className="kv"><span className="k">Amount receivable</span><span>{money(m.receivable)}</span></div>
        <div className="kv"><span className="k">Received</span><span>{money(m.received)}</span></div>
        <div className="kv" style={{ fontWeight: 700 }}><span className="k">Pending</span><span>{money(m.pending)}</span></div>
        <div className="small-muted" style={{ marginTop: 8 }}>{m.collectedPct}% collected against receivable</div>
        <div className="notice" style={{ marginTop: 12 }}>
          <span>Net profit is <b>billing − TDS</b>. GST collected is payable to Government, so it is never counted as profit.</span>
        </div>
      </div>

      {/* The pending matrix: every client that still owes, month by month. */}
      <div className="statbar">
        <Stat n={money(pm.total)} l="Total pending" s={`${pm.clients.length} client(s)`} tone="bad" />
        <Stat n={pm.openRows} l="Open rows" s="Awaiting payment" />
        <Stat n={pm.oldest != null ? `${pm.oldest} days` : '—'} l="Oldest invoice" s="Since invoice date" />
        <Stat n={pm.largest ? money(pm.largest.total) : '—'} l="Largest pending" s={pm.largest ? pm.largest.client : ''} tone="bad" />
      </div>

      <div className="card section">
        <h3>Client × month pending</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          Before GST, GST, after GST and TDS for every client · month columns are invoice months
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th><th>Department</th><th className="num">Before GST</th><th className="num">GST</th>
                <th className="num">After GST</th><th className="num">TDS</th><th className="num">Receivable</th>
                <th className="num">Paid so far</th><th className="num">Total pending</th>
                {pm.monthLabels.map((l) => <th key={l} className="num">{l}</th>)}
                <th className="num">Oldest</th>
              </tr>
            </thead>
            <tbody>
              {pm.clients.map((c) => (
                <tr key={c.client}>
                  <td><b>{c.client}</b></td>
                  <td>{c.department}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{money(c.billing)}</td>
                  <td className="num">{money(c.gst)}</td>
                  <td className="num">{money(c.invoiceValue)}</td>
                  <td className="num">{money(c.tds)}</td>
                  <td className="num">{money(c.receivable)}</td>
                  <td className="num">{c.paid ? money(c.paid) : '—'}{c.parts > 1 ? <div className="small-muted">{c.parts} parts</div> : null}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{money(c.total)}</td>
                  {pm.months.map((mk) => <td key={mk} className="num">{c.cells[mk] ? money(c.cells[mk]) : '—'}</td>)}
                  <td className="num">{c.oldest ? `${c.oldest}d` : '—'}</td>
                </tr>
              ))}
              {pm.clients.length === 0 && (
                <tr><td colSpan={10 + pm.months.length} className="small-muted">Nothing pending for these filters.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td>ALL CLIENTS TOTAL</td><td />
                <td className="num">{money(pm.clients.reduce((s, c) => s + c.billing, 0))}</td>
                <td className="num">{money(pm.clients.reduce((s, c) => s + c.gst, 0))}</td>
                <td className="num">{money(pm.clients.reduce((s, c) => s + c.invoiceValue, 0))}</td>
                <td className="num">{money(pm.clients.reduce((s, c) => s + c.tds, 0))}</td>
                <td className="num">{money(pm.clients.reduce((s, c) => s + c.receivable, 0))}</td>
                <td className="num">{money(pm.clients.reduce((s, c) => s + c.paid, 0))}</td>
                <td className="num">{money(pm.total)}</td>
                {pm.months.map((mk) => <td key={mk} className="num">{money(pm.clients.reduce((s, c) => s + (c.cells[mk] || 0), 0))}</td>)}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card section">
        <h3>Row-level pending</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>Oldest invoice first</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate</th><th>Client</th><th>Recruiter</th><th>Invoice</th><th>Invoice date</th>
                <th className="num">Age</th><th className="num">Before GST</th><th className="num">GST</th>
                <th className="num">After GST</th><th className="num">TDS</th><th className="num">Receivable</th>
                <th className="num">Received</th><th>Last paid</th><th className="num">Pending</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pm.rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.candidate}</b></td>
                  <td>{r.client}</td>
                  <td>{r.recruiter || <span className="status priority-medium">not assigned</span>}</td>
                  <td><Link to={`/invoices/${r.id}`}>{r.invoiceNumber}</Link></td>
                  <td>{fmtD(r.invoiceDate)}</td>
                  <td className="num">{r.age != null ? `${r.age}d` : '—'}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{money(r.billing)}</td>
                  <td className="num">{money(r.gst)}</td>
                  <td className="num">{money(r.invoiceValue)}</td>
                  <td className="num">{money(r.tds)}</td>
                  <td className="num">{money(r.receivable)}</td>
                  <td className="num">{money(r.received)}</td>
                  <td>
                    {r.lastPaid
                      ? (
                        <>
                          <b>{fmtD(r.lastPaid.date)}</b>
                          <div className="small-muted">{money2(r.lastPaid.amount)}{r.lastPaid.parts > 1 ? ` · ${r.lastPaid.parts} parts` : ''}</div>
                          <div>{r.lastPaid.proof ? <span className="status priority-low">proof</span> : <span className="status priority-high">no proof</span>}</div>
                        </>
                      )
                      : <span className="small-muted">never</span>}
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>{money(r.pending)}</td>
                  <td><span className={`status ${statusClass(r.status)}`}>{r.status}</span></td>
                </tr>
              ))}
              {pm.rows.length === 0 && <tr><td colSpan="15" className="small-muted">Nothing pending for these filters.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section">
        <h3>Monthly summary</h3>
        <div className="small-muted" style={{ marginBottom: 8 }}>{p.label} — billing, GST, TDS, collections and profit</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th><th className="num">Invoices</th><th className="num">Before GST</th><th className="num">GST</th>
                <th className="num">After GST</th><th className="num">TDS</th><th className="num">Receivable</th>
                <th className="num">Received</th><th className="num">Pending</th><th className="num">Net profit</th>
                <th className="num">Cash collected</th><th className="num">Office spend</th>
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
                  <td className="num">{money(r.receivable)}</td>
                  <td className="num">{money(r.received)}</td>
                  <td className="num">{money(r.pending)}</td>
                  <td className="num">{money(r.netProfit)}</td>
                  <td className="num">{money(r.cash)}</td>
                  <td className="num">{money(r.spend)}</td>
                </tr>
              ))}
              {data.byMonth.length === 0 && <tr><td colSpan="12" className="small-muted">No data.</td></tr>}
            </tbody>
            <tfoot>
              <tr>
                <td>TOTAL</td>
                <td className="num">{data.byMonth.reduce((s, r) => s + r.invoices, 0)}</td>
                <td className="num">{money(m.billing)}</td>
                <td className="num">{money(m.gst)}</td>
                <td className="num">{money(m.invoiceValue)}</td>
                <td className="num">{money(m.tds)}</td>
                <td className="num">{money(m.receivable)}</td>
                <td className="num">{money(m.received)}</td>
                <td className="num">{money(m.pending)}</td>
                <td className="num">{money(m.profit)}</td>
                <td className="num">{money(data.byMonth.reduce((s, r) => s + r.cash, 0))}</td>
                <td className="num">{money(data.byMonth.reduce((s, r) => s + r.spend, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="small-muted" style={{ marginTop: 8 }}>
          &quot;Received&quot; is grouped by invoice month; &quot;Cash collected&quot; is grouped by the actual payment
          date — same as the workbook.
        </div>
      </div>

      <div className="card section">
        <h3>Invoices needing attention</h3>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Invoice</th><th>Client</th><th>Due</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {data.needsAttention.map((i) => (
                <tr key={i.id}>
                  <td><Link to={`/invoices/${i.id}`}>{i.invoiceNumber || i.id.slice(-6)}</Link></td>
                  <td>{i.client}</td>
                  <td>{fmtD(i.dueDate)}</td>
                  <td className="num">{money(i.outstanding)}</td>
                  <td><span className={`status ${statusClass(i.status)}`}>{i.status}</span></td>
                </tr>
              ))}
              {data.needsAttention.length === 0 && <tr><td colSpan="5" className="small-muted">Nothing pending.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section">
        <h3>Bank lines still to deal with</h3>
        {data.unreconciledTransactions.map((t) => (
          <div className="kv" key={t.id}>
            <span className="k">{fmtD(t.date)} · {t.description}</span>
            <span>{money(t.amount)} <span className="small-muted">({t.state})</span></span>
          </div>
        ))}
        {data.unreconciledTransactions.length === 0 && <div className="small-muted">All caught up.</div>}
        <div style={{ marginTop: 10 }}><Link to="/bank">Open Bank &amp; Reconciliation →</Link></div>
      </div>
    </>
  );
}

export { Stat };
