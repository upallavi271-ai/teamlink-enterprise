import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell from './VendorShell.jsx';
import { inr, day, TONE } from './vendorFormat.js';
import './vendorModules.css';

// /vendor/dashboard - the Dashboard, the first of the vendor's four modules (Dashboard, Bills & Invoices, Payments & Outstanding, Services & Agreements).
// Every number comes from ONE server call (/records/overview) that reads only this vendor's own invoices, payments and orders from the session,
// with the same rules as the Bills & Invoices and Payments & Outstanding screens (so the figures always agree and nothing is counted twice).
// Cards link only inside the four modules. Nothing about the company's other business is shown here.
const PAY_TONE = { Paid: 'green', 'Partially Paid': 'yellow', Overdue: 'red', Unpaid: 'blue', 'Pending Verification': 'yellow' };

export default function VendorDashboard() {
  return (
    <VendorShell title="Dashboard" sub="Your bills, payments and services at a glance.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(''); setBusy(true);
    vendorApi.get('/records/overview').then((r) => setD(r.data)).catch((e) => setError(vendorError(e, 'Could not load your dashboard.'))).finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error && !d) return <div className="notice red"><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>;
  if (!d) return <div className="empty-mini">Loading&hellip;</div>;
  const i = d.invoices;
  const nothing = !i.total && !d.payments.count && !d.purchaseOrders.count && !(d.services && d.services.agreements);
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      <div className="vp-actions-row"><button type="button" className="btn btn-sm" disabled={busy} onClick={load}>{busy ? 'Refreshing…' : 'Refresh'}</button></div>
      {nothing && <div className="vp-empty" style={{ marginBottom: 14 }}><h3>Nothing here yet</h3><p>When the company records a bill, a payment or an order for you, it shows here.</p></div>}

      {d.actions && d.actions.length > 0 && (
        <section className="vp-section" aria-label="Needs your attention">
          <h3 className="vm-h3">Needs your attention</h3>
          <ul className="vp-list-simple">{d.actions.map((a) => <li key={a.text}><Link to={a.to}>{a.text}</Link></li>)}</ul>
        </section>
      )}

      <div className="vp-tiles">
        <Link to="/vendor/invoices" className="vp-tile"><span>Total invoices</span><b>{i.total}</b></Link>
        <Link to="/vendor/invoices?status=paid" className="vp-tile green"><span>Paid invoices</span><b>{i.paid}</b></Link>
        <Link to="/vendor/invoices?status=pending" className="vp-tile orange"><span>Pending invoices</span><b>{d.pendingPayment ? d.pendingPayment.count : i.pending}</b></Link>
        <Link to="/vendor/invoices?status=overdue" className="vp-tile red"><span>Overdue invoices</span><b>{d.overdue ? d.overdue.count : 0}</b><small>{inr(d.overdue ? d.overdue.amount : 0)}</small></Link>
        <Link to="/vendor/invoices" className="vp-tile"><span>Total invoice amount</span><b>{inr(i.billed)}</b></Link>
        <Link to="/vendor/payments" className="vp-tile green"><span>Total payments</span><b>{inr(d.payments.received)}</b></Link>
        <Link to="/vendor/payments" className="vp-tile orange"><span>Outstanding balance</span><b>{inr(i.outstanding)}</b></Link>
        <Link to="/vendor/services" className="vp-tile"><span>Orders</span><b>{d.purchaseOrders.count}</b></Link>
      </div>

      <div className="vp-two-col">
        <section>
          <h3 className="vm-h3">Upcoming due dates</h3>
          {!d.upcoming || !d.upcoming.length ? <div className="vp-none">No payment is due in the next 30 days.</div> : (
            <div className="tbl-wrap vp-scroll"><table>
              <thead><tr><th>Invoice</th><th>Due</th><th className="num">To be paid</th></tr></thead>
              <tbody>{d.upcoming.map((u) => <tr key={u.key}><td>{u.invoiceNo}</td><td>{day(u.dueDate)} <small className="cell-muted">({u.daysLeft === 0 ? 'today' : `in ${u.daysLeft} day${u.daysLeft === 1 ? '' : 's'}`})</small></td><td className="num"><strong>{inr(u.outstanding)}</strong></td></tr>)}</tbody>
            </table></div>
          )}
        </section>
        <section>
          <h3 className="vm-h3">Pending bills</h3>
          {!d.pendingBills || !d.pendingBills.length ? <div className="vp-none">No pending bills.</div> : (
            <div className="tbl-wrap vp-scroll"><table>
              <thead><tr><th>Invoice</th><th>Status</th><th className="num">Outstanding</th></tr></thead>
              <tbody>{d.pendingBills.map((b) => <tr key={b.key}><td>{b.invoiceNo}</td><td><span className={`vp-tag vp-${PAY_TONE[b.payStatus] || 'grey'}`}>{b.payStatus}</span></td><td className="num"><strong>{inr(b.outstanding)}</strong></td></tr>)}</tbody>
            </table></div>
          )}
          <p><Link to="/vendor/payments">All outstanding</Link></p>
        </section>
      </div>

      <div className="vp-two-col">
        <section>
          <h3 className="vm-h3">Recent payments</h3>
          {!d.payments.recent.length ? <div className="vp-none">No payments yet.</div> : (
            <div className="tbl-wrap vp-scroll"><table>
              <thead><tr><th>Date</th><th>Invoice</th><th className="num">Amount</th></tr></thead>
              <tbody>{d.payments.recent.map((p) => <tr key={p.key}><td>{day(p.date)}</td><td>{p.invoiceNo}</td><td className="num"><strong>{inr(p.amount)}</strong></td></tr>)}</tbody>
            </table></div>
          )}
          <p><Link to="/vendor/payments">All payments</Link></p>
        </section>
        <section>
          <h3 className="vm-h3">Services &amp; orders</h3>
          {!d.purchaseOrders.byStatus.length && !(d.services && d.services.agreements) ? <div className="vp-none">No orders or agreements yet.</div> : (
            <>
              {d.services && d.services.agreements > 0 && <p><Link to="/vendor/services">{d.services.agreements} agreement{d.services.agreements === 1 ? '' : 's'} shared with you</Link></p>}
              <div className="vp-seg">{d.purchaseOrders.byStatus.map((s) => <Link key={s.status} to="/vendor/services" className="vp-chip">{s.status} ({s.count})</Link>)}</div>
            </>
          )}
          <p><Link to="/vendor/services">Services &amp; Agreements</Link></p>
        </section>
      </div>

      <h3 className="vm-h3">Recent invoices</h3>
      {!d.recentInvoices.length ? <div className="vp-none">No invoices yet.</div> : (
        <div className="tbl-wrap vp-scroll"><table>
          <thead><tr><th>Invoice</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
          <tbody>{d.recentInvoices.map((r) => (
            <tr key={r.key}><td><strong>{r.invoiceNo}</strong></td><td>{day(r.date)}</td><td className="num">{inr(r.netPayable)}</td><td><span className={`vp-tag vp-${PAY_TONE[r.payStatus] || TONE[r.status] || 'grey'}`}>{r.payStatus || r.statusText}</span></td></tr>
          ))}</tbody>
        </table></div>
      )}

      {d.activity.length > 0 && (
        <>
          <h3 className="vm-h3">Recent account activity</h3>
          <ul className="vm-hist">{d.activity.map((a, n) => <li key={`${a.kind}${n}`}><Link to={a.to}>{a.text}</Link> <span className="cell-muted">{`· ${day(a.at)}${a.amount != null ? ` · ${inr(a.amount)}` : ''}`}</span></li>)}</ul>
        </>
      )}
    </>
  );
}
