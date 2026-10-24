import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell from './VendorShell.jsx';
import { StepTag, PayTag, rs } from './assetPortalCommon.jsx';
import { day } from './vendorFormat.js';
import './vendorModules.css';

// /vendor/asset-portal/dashboard - the Dashboard of the Assets Vendor Portal. Every number comes from ONE server call
// (/asset-portal/overview) that reads only this vendor's own assets, orders and repairs, taken from the session.
export default function AssetPortalDashboard() {
  return (
    <VendorShell title="Dashboard" sub="Your assets, orders and repairs at a glance.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    vendorApi.get('/asset-portal/overview').then((r) => setD(r.data)).catch((e) => setError(vendorError(e, 'Could not load your dashboard.')));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="notice red"><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>;
  if (!d) return <div className="empty-mini">Loading&hellip;</div>;
  const nothing = !d.assets.total && !d.orders.total && !d.repairs.total;
  const stage = (v) => (d.repairs.byStage.find((s) => s.value === v) || {}).count || 0;
  return (
    <>
      {nothing && <div className="vp-empty" style={{ marginBottom: 14 }}><h3>Nothing here yet</h3><p>When the company gives you assets, orders or repairs, they show here.</p></div>}
      <div className="vp-tiles">
        <Link to="/vendor/asset-portal/assets" className="vp-tile"><span>Assets with you</span><b>{d.assets.total}</b></Link>
        <Link to="/vendor/asset-portal/repairs" className="vp-tile orange"><span>Repairs open</span><b>{d.repairs.open}</b></Link>
        <Link to="/vendor/asset-portal/repairs?stage=Completed" className="vp-tile green"><span>Repairs done</span><b>{stage('Completed') + stage('Returned')}</b></Link>
        <Link to="/vendor/asset-portal/orders" className="vp-tile"><span>Orders</span><b>{d.orders.total}</b></Link>
        <Link to="/vendor/asset-portal/orders" className="vp-tile orange"><span>Orders still to deliver</span><b>{d.orders.open}</b></Link>
        <Link to="/vendor/asset-portal/repairs" className="vp-tile"><span>Repair estimates</span><b>{rs(d.repairs.estimateTotal)}</b></Link>
        <Link to="/vendor/asset-portal/repairs" className="vp-tile green"><span>Final repair cost</span><b>{rs(d.repairs.finalTotal)}</b></Link>
        <Link to="/vendor/asset-portal/invoices" className="vp-tile orange"><span>Waiting to be paid</span><b>{rs(d.payments.outstanding)}</b></Link>
        <Link to="/vendor/asset-portal/invoices" className="vp-tile green"><span>Paid to you</span><b>{rs(d.payments.paidTotal)}</b></Link>
        <Link to="/vendor/asset-portal/invoices" className="vp-tile"><span>Invoices overdue</span><b>{d.payments.overdue}</b></Link>
      </div>

      <div className="vp-two-col">
        <section>
          <h3 className="vm-h3">Repairs by step</h3>
          <div className="vp-seg">
            {d.repairs.byStage.filter((s) => s.count > 0).map((s) => (
              <Link key={s.value} to={`/vendor/asset-portal/repairs?stage=${encodeURIComponent(s.value)}`} className="vp-chip">{s.value} ({s.count})</Link>
            ))}
            {!d.repairs.total && <div className="vp-none">No repairs yet.</div>}
          </div>
        </section>
        <section>
          <h3 className="vm-h3">Your assets by status</h3>
          <div className="vp-seg">
            {d.assets.byStatus.map((s) => <Link key={s.value} to={`/vendor/asset-portal/assets?status=${encodeURIComponent(s.value)}`} className="vp-chip">{s.value} ({s.count})</Link>)}
            {!d.assets.total && <div className="vp-none">No assets yet.</div>}
          </div>
        </section>
      </div>

      <h3 className="vm-h3">Latest repairs</h3>
      {!d.recentRepairs.length ? <div className="vp-none">No repairs yet.</div> : (
        <div className="tbl-wrap vp-scroll"><table>
          <thead><tr><th>Repair</th><th>Asset</th><th>Problem</th><th>Reported</th><th>Repair step</th><th>Payment</th></tr></thead>
          <tbody>{d.recentRepairs.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/vendor/asset-portal/repairs?open=${encodeURIComponent(r.id)}`}><strong>{r.repairNo}</strong></Link></td>
              <td>{r.assetCode} &middot; {r.assetName}</td>
              <td>{r.issue || '-'}</td>
              <td>{day(r.dateReported)}</td>
              <td><StepTag step={r.stage} /></td>
              <td><PayTag pay={r.payment} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
