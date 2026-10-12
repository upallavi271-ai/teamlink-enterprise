import { useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from './DataTable.jsx';
import { SeeList, DrillPanel } from './Drill.jsx';
import { money, fmtD } from '../../invoices/invFormat';

// 5. GST POSITION (Accounts spec S8.6). Output GST off the invoices, input
// GST off the office bills. Input credit counts only with a valid vendor
// GSTIN AND the vendor's tax invoice on file — credit with the document
// missing is shown on its own and NOT counted as claimable.
// invoices / bills = the rows these figures add up (Drill.jsx): every number opens its list.
const collectedOf = (r) => (r.receivable > 0 ? r.gst * Math.min(1, r.received / r.receivable) : 0);
const COLLECTED_COL = { key: 'gstCollected', label: 'GST collected', num: true, get: collectedOf, render: (r) => money(collectedOf(r)), foot: (l) => money(l.reduce((a, r) => a + collectedOf(r), 0)) };
export default function GstPosition({ g, peopleFilter, invoices = [], bills = [] }) {
  const [open, setOpen] = useState(false);
  const [drill, setDrill] = useState(null);
  const show = (key, title, kind, rows, note) => setDrill((d) => (d && d.key === key ? null : { key, title, kind, rows, note }));
  const isOpen = (key) => !!drill && drill.key === key;
  const withGst = bills.filter((e) => e.gst > 0.5);
  const eligible = withGst.filter((e) => e.gstinOnFile && e.taxInvoiceOnFile);
  const it = g.itc;
  const cols = [
    { key: 'client', label: 'Client', render: (r) => <b>{r.client}</b> },
    { key: 'invoiceNumber', label: 'Invoice no', render: (r) => <Link to={`/invoices/${r.id}`}>{r.invoiceNumber}</Link> },
    { key: 'dueDate', label: 'Due', render: (r) => fmtD(r.dueDate) },
    { key: 'gst', label: 'GST charged', num: true, render: (r) => money(r.gst), foot: (l) => money(l.reduce((a, r) => a + r.gst, 0)) },
    { key: 'pending', label: 'GST still to come', num: true, render: (r) => <b>{money(r.pending)}</b>, foot: (l) => money(l.reduce((a, r) => a + r.pending, 0)) },
    { key: 'daysOverdue', label: 'Late', num: true, render: (r) => (r.daysOverdue ? <span className="acd-pill red">{r.daysOverdue} days</span> : '—') },
  ];
  return (
    <section className="acd-sec" id="gst">
      <h2><span className="acd-n">5</span> GST position</h2>
      <p className="acd-q">How much GST did we charge and collect, how much did we pay vendors, and what do we owe the Government?</p>
      <div className="acd-gst">
        <div className="acd-card">
          <div className="acd-cl">From clients (output GST)</div>
          <div className="acd-kv"><span className="k">GST clients have to pay us</span><b>{money(g.charged)}</b></div>
          <SeeList open={isOpen('charged')} onClick={() => show('charged', 'Invoices that carry GST', 'inv', invoices.filter((r) => r.gst > 0.005))}>See the invoices</SeeList>
          <div className="acd-kv"><span className="k">GST collected</span><b style={{ color: 'var(--green)' }}>{money(g.collected)}</b></div>
          <SeeList open={isOpen('collected')} onClick={() => show('collected', 'GST collected, invoice by invoice', 'inv', invoices.filter((r) => collectedOf(r) > 0.005), 'GST collected = the invoice GST × the share of the invoice already received.')}>See the invoices</SeeList>
          <div className="acd-kv"><span className="k">GST pending from clients</span><b style={{ color: g.pendingFromClients > 0.5 ? 'var(--amber)' : undefined }}>{money(g.pendingFromClients)}</b></div>
          {g.pendingByClient.slice(0, 3).map((c) => <div className="acd-kv" key={c.client}><span className="k">· {c.client} ({c.invoices})</span><b>{money(c.amount)}</b></div>)}
          {g.pendingRows.length > 0 && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setOpen((x) => !x)}>{open ? 'Hide invoices' : `See ${g.pendingRows.length} invoice${g.pendingRows.length === 1 ? '' : 's'}`}</button>}
        </div>
        <div className="acd-card">
          <div className="acd-cl">To vendors (input GST / ITC)</div>
          <div className="acd-kv"><span className="k">GST paid to vendors</span><b>{money(g.paidToVendors)}</b></div>
          <SeeList open={isOpen('paid')} onClick={() => show('paid', `Bills that carry GST (${withGst.length})`, 'bill', withGst)}>See the bills</SeeList>
          <div className="acd-kv"><span className="k">Eligible ({it.eligibleBills} bill{it.eligibleBills === 1 ? '' : 's'})</span><b style={{ color: 'var(--green)' }}>{money(it.eligible)}</b></div>
          <SeeList open={isOpen('eligible')} onClick={() => show('eligible', 'Eligible input GST: vendor GSTIN and tax invoice on file', 'bill', eligible)}>See the bills</SeeList>
          <div className="acd-kv"><span className="k">Claimed</span><b>{it.claimed != null ? money(it.claimed) : 'not entered'}</b></div>
          <div className="acd-kv"><span className="k">Available</span><b>{money(it.available)}</b></div>
          <div className="acd-kv"><span className="k">Pending — vendor not paid yet</span><b>{money(it.pendingVendorPayment)}</b></div>
          <SeeList open={isOpen('unpaid')} onClick={() => show('unpaid', 'Eligible GST on bills not paid yet', 'bill', eligible.filter((e) => e.pending > 0))}>See the bills</SeeList>
          <div className="acd-kv"><span className="k">Proof missing ({it.missingProofBills}) — not counted</span><b style={{ color: it.missingProof > 0.5 ? 'var(--red)' : undefined }}>{money(it.missingProof)}</b></div>
          <SeeList open={isOpen('noproof')} onClick={() => show('noproof', 'GST bills with the vendor tax invoice missing', 'bill', withGst.filter((e) => e.gstinOnFile && !e.taxInvoiceOnFile))}>See the bills</SeeList>
          <div className="acd-kv"><span className="k">Not claimable — no GSTIN ({it.notClaimableBills})</span><b style={{ color: it.notClaimable > 0.5 ? 'var(--red)' : undefined }}>{money(it.notClaimable)}</b></div>
          <SeeList open={isOpen('nogstin')} onClick={() => show('nogstin', 'GST bills with no vendor GSTIN', 'bill', withGst.filter((e) => !e.gstinOnFile))}>See the bills</SeeList>
        </div>
        <div className={`acd-card ${g.payable > 0.5 ? 'red' : 'green'}`}>
          <div className="acd-cl">GST payable to Government</div>
          <div className="acd-cv">{money(Math.abs(g.payable))}{g.payable < -0.5 ? ' credit' : ''}</div>
          <div className="acd-calc">{money(g.charged)} output GST − {money(it.eligible)} eligible input GST = {money(g.payable)}</div>
          {it.missingProof > 0.5 && <div className="acd-cs" style={{ marginTop: 4 }}>With the missing vendor invoices attached it would be {money(g.payableIfProofsAttached)}.</div>}
          <div className="acd-kv" style={{ marginTop: 8 }}><span className="k">TeamLink GSTIN</span><b>{g.ourGstin || <Link to="/office">Not set — add it on Office &amp; Accounts</Link>}</b></div>
        </div>
      </div>
      <div className="acd-explain">
        GST collected from clients is tax collected on behalf of the Government. Eligible input GST paid to vendors may be adjusted according to applicable rules. The remaining payable amount is shown as GST payable.
        {peopleFilter ? ' Vendor GST is company-wide — it is not split by client or employee.' : ''}
      </div>
      {drill && <div style={{ marginTop: 10 }}><DrillPanel drill={drill} onClose={() => setDrill(null)} extraCols={drill.key === 'collected' ? [COLLECTED_COL] : []} /></div>}
      {open && (
        <div style={{ marginTop: 10 }}>
          <DataTable columns={cols} rows={g.pendingRows} search={(r) => `${r.client} ${r.invoiceNumber}`} placeholder="Search client or invoice no…" noun="invoices" foot initialSort={{ key: 'pending', dir: 'desc' }} />
        </div>
      )}
    </section>
  );
}
