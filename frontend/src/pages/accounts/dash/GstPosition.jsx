import { useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from './DataTable.jsx';
import { money, fmtD } from '../../invoices/invFormat';

// 5. GST POSITION (Accounts spec S8.6). Output GST off the invoices, input
// GST off the office bills. Input credit counts only with a valid vendor
// GSTIN AND the vendor's tax invoice on file — credit with the document
// missing is shown on its own and NOT counted as claimable.
export default function GstPosition({ g, peopleFilter }) {
  const [open, setOpen] = useState(false);
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
          <div className="acd-kv"><span className="k">GST collected</span><b style={{ color: 'var(--green)' }}>{money(g.collected)}</b></div>
          <div className="acd-kv"><span className="k">GST pending from clients</span><b style={{ color: g.pendingFromClients > 0.5 ? 'var(--amber)' : undefined }}>{money(g.pendingFromClients)}</b></div>
          {g.pendingByClient.slice(0, 3).map((c) => <div className="acd-kv" key={c.client}><span className="k">· {c.client} ({c.invoices})</span><b>{money(c.amount)}</b></div>)}
          {g.pendingRows.length > 0 && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setOpen((x) => !x)}>{open ? 'Hide invoices' : `See ${g.pendingRows.length} invoice${g.pendingRows.length === 1 ? '' : 's'}`}</button>}
        </div>
        <div className="acd-card">
          <div className="acd-cl">To vendors (input GST / ITC)</div>
          <div className="acd-kv"><span className="k">GST paid to vendors</span><b>{money(g.paidToVendors)}</b></div>
          <div className="acd-kv"><span className="k">Eligible ({it.eligibleBills} bill{it.eligibleBills === 1 ? '' : 's'})</span><b style={{ color: 'var(--green)' }}>{money(it.eligible)}</b></div>
          <div className="acd-kv"><span className="k">Claimed</span><b>{it.claimed != null ? money(it.claimed) : 'not entered'}</b></div>
          <div className="acd-kv"><span className="k">Available</span><b>{money(it.available)}</b></div>
          <div className="acd-kv"><span className="k">Pending — vendor not paid yet</span><b>{money(it.pendingVendorPayment)}</b></div>
          <div className="acd-kv"><span className="k">Proof missing ({it.missingProofBills}) — not counted</span><b style={{ color: it.missingProof > 0.5 ? 'var(--red)' : undefined }}>{money(it.missingProof)}</b></div>
          <div className="acd-kv"><span className="k">Not claimable — no GSTIN ({it.notClaimableBills})</span><b style={{ color: it.notClaimable > 0.5 ? 'var(--red)' : undefined }}>{money(it.notClaimable)}</b></div>
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
      {open && (
        <div style={{ marginTop: 10 }}>
          <DataTable columns={cols} rows={g.pendingRows} search={(r) => `${r.client} ${r.invoiceNumber}`} placeholder="Search client or invoice no…" noun="invoices" foot initialSort={{ key: 'pending', dir: 'desc' }} />
        </div>
      )}
    </section>
  );
}
