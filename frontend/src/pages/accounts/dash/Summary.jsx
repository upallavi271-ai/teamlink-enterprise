import { useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from './DataTable.jsx';
import { SeeList, DrillPanel } from './Drill.jsx';
import { money, fmtD } from '../../invoices/invFormat';

// 3. MAIN FINANCIAL SUMMARY (Accounts spec S8.4) — six cards. The figures
// are the Invoices page's and the Office page's own (utils/accountsControl.js
// reconciles them); GST collected is never profit.
const days = (n) => (n == null ? '—' : `${n} day${n === 1 ? '' : 's'}`);

// invoices / bills = the rows these figures add up (Drill.jsx): every number opens its list.
export default function Summary({ s, peopleFilter, invoices = [], bills = [] }) {
  const [overdueOpen, setOverdueOpen] = useState(false);
  const [drill, setDrill] = useState(null);
  const show = (key, title, kind, rows, note) => setDrill((d) => (d && d.key === key ? null : { key, title, kind, rows, note }));
  const isOpen = (key) => !!drill && drill.key === key;
  const overpaid = invoices.filter((r) => r.pending < -0.5);
  const pendingRows = invoices.filter((r) => r.pending > 0.5 || r.pending < -0.5);
  const billsBy = (test) => bills.filter(test);
  const { total, received, pending, overdue, expenses, profit } = s;
  const overdueCols = [
    { key: 'client', label: 'Client', render: (r) => <b>{r.client}</b> },
    { key: 'invoiceNumber', label: 'Invoice no', render: (r) => <Link to={`/invoices/${r.id}`}>{r.invoiceNumber}</Link> },
    { key: 'invoiceDate', label: 'Date', render: (r) => fmtD(r.invoiceDate) },
    { key: 'dueDate', label: 'Due', render: (r) => fmtD(r.dueDate) },
    { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount), foot: (l) => money(l.reduce((a, r) => a + r.amount, 0)) },
    { key: 'received', label: 'Received', num: true, render: (r) => money(r.received), foot: (l) => money(l.reduce((a, r) => a + r.received, 0)) },
    { key: 'pending', label: 'Pending', num: true, render: (r) => <b style={{ color: 'var(--red)' }}>{money(r.pending)}</b>, foot: (l) => money(l.reduce((a, r) => a + r.pending, 0)) },
    { key: 'daysOverdue', label: 'Days late', num: true, render: (r) => <span className="acd-pill red">{days(r.daysOverdue)}</span> },
    { key: 'assigned', label: 'Assigned employee', render: (r) => r.assigned || '—' },
    { key: 'lastPayment', label: 'Last payment', render: (r) => (r.lastPayment ? fmtD(r.lastPayment) : 'never') },
  ];

  return (
    <section className="acd-sec" id="summary">
      <h2><span className="acd-n">3</span> Money summary</h2>
      <p className="acd-q">How much did we bill, how much came in, who still owes, and what is left after costs?</p>
      <div className="acd-cards">
        <div className="acd-card">
          <div className="acd-cl">Total amount · {total.invoices} invoice{total.invoices === 1 ? '' : 's'}</div>
          <div className="acd-cv">{money(total.invoiceValue)}</div>
          <div className="acd-kv"><span className="k">Before GST (our fee)</span><b>{money(total.billing)}</b></div>
          <div className="acd-kv"><span className="k">GST on top</span><b>{money(total.gst)}</b></div>
          <div className="acd-kv"><span className="k">After GST (invoiced)</span><b>{money(total.invoiceValue)}</b></div>
          <div className="acd-kv"><span className="k">Less TDS by clients</span><b>{money(total.tds)}</b></div>
          <div className="acd-kv"><span className="k">To receive</span><b>{money(total.receivable)}</b></div>
          <SeeList open={isOpen('total')} onClick={() => show('total', `All ${invoices.length} invoices`, 'inv', invoices, 'Before GST + GST = After GST. Less TDS = To receive.')}>See the {invoices.length} invoice{invoices.length === 1 ? '' : 's'}</SeeList>
        </div>
        <div className="acd-card green">
          <div className="acd-cl">Received</div>
          <div className="acd-cv">{money(received.amount)}</div>
          <div className="acd-cs">{received.collectedPct}% of {money(total.receivable)} · {received.receipts} payment{received.receipts === 1 ? '' : 's'} recorded on {received.invoices} invoice{received.invoices === 1 ? '' : 's'}</div>
          <SeeList open={isOpen('received')} onClick={() => show('received', 'Invoices with money received', 'inv', invoices.filter((r) => r.received > 0.005))}>See the invoices</SeeList>
        </div>
        <div className="acd-card amber">
          <div className="acd-cl">Pending · {pending.count} invoice{pending.count === 1 ? '' : 's'}</div>
          <div className="acd-cv">{money(pending.amount)}</div>
          <div className="acd-cs">{pending.clients} client{pending.clients === 1 ? '' : 's'} owe us · next due {pending.nextDue ? fmtD(pending.nextDue) : 'not set'} · oldest {days(pending.oldestDays)}</div>
          {pending.whoOwes.map((w) => <div className="acd-kv" key={w.client}><span className="k">{w.client}</span><b>{money(w.amount)}</b></div>)}
          <SeeList
            open={isOpen('pending')}
            onClick={() => show('pending', 'Invoices that still have money to come', 'inv', pendingRows, overpaid.length ? `${overpaid.length} invoice${overpaid.length === 1 ? ' was' : 's were'} received for more than billed (shown below zero) — the Pending total sets that off.` : null)}
          >
            See the invoices
          </SeeList>
        </div>
        <div className={`acd-card ${overdue.count ? 'red' : 'green'}`}>
          <div className="acd-cl">Late invoices</div>
          <div className="acd-cv">{overdue.count ? money(overdue.amount) : 'None late'}</div>
          <div className="acd-cs">{overdue.count ? `${overdue.count} invoice${overdue.count === 1 ? '' : 's'} past the due date` : 'No invoice is past its due date with money still owed.'}</div>
          {overdue.count > 0 && (
            <>
              <div className="acd-strip">
                {overdue.buckets.map((b) => <span key={b.bucket} className={`acd-pill ${b.count ? 'red' : 'grey'}`}>{b.bucket} · {b.count} · {money(b.amount)}</span>)}
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setOverdueOpen((x) => !x)}>{overdueOpen ? 'Hide the list' : 'Who has to pay TeamLink?'}</button>
            </>
          )}
        </div>
        <div className={`acd-card ${expenses.overdue > 0.5 ? 'red' : 'amber'}`}>
          <div className="acd-cl">Office expenses · {expenses.count} bill{expenses.count === 1 ? '' : 's'}</div>
          <div className="acd-cv">{money(expenses.total)}</div>
          <div className="acd-kv"><span className="k">Paid</span><b style={{ color: 'var(--green)' }}>{money(expenses.paid)}</b></div>
          <div className="acd-kv"><span className="k">To be paid</span><b style={{ color: 'var(--amber)' }}>{money(expenses.pending)}</b></div>
          <div className="acd-kv"><span className="k">Late</span><b style={{ color: expenses.overdue > 0.5 ? 'var(--red)' : undefined }}>{money(expenses.overdue)}</b></div>
          <div className="acd-kv"><span className="k">Paid with proof missing</span><b style={{ color: expenses.missingProof ? 'var(--red)' : undefined }}>{expenses.missingProof} bill{expenses.missingProof === 1 ? '' : 's'}</b></div>
          <div className="acd-cs">Amount paid to vendors: before GST + GST − TDS</div>
          <div className="acd-strip">
            <SeeList open={isOpen('exp-all')} onClick={() => show('exp-all', `All ${bills.length} office bills`, 'bill', bills)}>All bills</SeeList>
            <SeeList open={isOpen('exp-paid')} onClick={() => show('exp-paid', 'Office bills paid', 'bill', billsBy((e) => e.paid > 0))}>Paid</SeeList>
            <SeeList open={isOpen('exp-pend')} onClick={() => show('exp-pend', 'Office bills still to be paid', 'bill', billsBy((e) => e.pending > 0))}>To be paid</SeeList>
            <SeeList open={isOpen('exp-late')} onClick={() => show('exp-late', 'Office bills that are late', 'bill', billsBy((e) => e.overdue))}>Late</SeeList>
            <SeeList open={isOpen('exp-proof')} onClick={() => show('exp-proof', 'Bills paid with the proof missing', 'bill', billsBy((e) => e.proofMissing))}>Proof missing</SeeList>
          </div>
        </div>
        <div className={`acd-card ${profit.amount >= 0 ? 'green' : 'red'}`}>
          <div className="acd-cl">Profit after expenses</div>
          <div className="acd-cv">{money(profit.amount)}</div>
          <div className="acd-calc">{money(profit.income)} income before GST − {money(profit.tds)} TDS − {money(profit.expensesBeforeGst)} office costs before GST = {money(profit.amount)}</div>
          <div className="acd-cs" style={{ marginTop: 4 }}>GST collected is the Government&apos;s money — never profit.{peopleFilter ? ' Office costs are company-wide (a bill has no client or employee).' : ''}</div>
          <div className="acd-strip">
            <SeeList open={isOpen('profit-inc')} onClick={() => show('profit-inc', 'Income: the invoices (before GST)', 'inv', invoices)}>Income: invoices</SeeList>
            <SeeList open={isOpen('profit-exp')} onClick={() => show('profit-exp', 'Office costs: the bills (before GST)', 'bill', bills)}>Costs: bills</SeeList>
          </div>
        </div>
      </div>
      {drill && <div style={{ marginTop: 12 }}><DrillPanel drill={drill} onClose={() => setDrill(null)} /></div>}
      {overdueOpen && overdue.count > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 13.5, margin: '0 0 4px' }}>Who has to pay TeamLink?</h3>
          <DataTable
            columns={overdueCols}
            rows={overdue.rows}
            search={(r) => `${r.client} ${r.invoiceNumber} ${r.assigned || ''}`}
            placeholder="Search client or invoice no…"
            noun="late invoices"
            foot
            initialSort={{ key: 'daysOverdue', dir: 'desc' }}
          />
        </div>
      )}
    </section>
  );
}
