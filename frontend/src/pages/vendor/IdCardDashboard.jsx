import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell from './VendorShell.jsx';
import { StatusTag, Photo } from './idCardCommon.jsx';
import { day } from './vendorFormat.js';
import './idCardPortal.css';
import './vendorModules.css';

// /vendor/idcard-portal/dashboard - the Dashboard of the ID Card Vendor Portal. The four cards come from ONE server call (/idcard-portal/overview)
// that counts only this vendor's own requests (taken from the session), from the same rows the four module lists read.
export default function IdCardDashboard() {
  return (
    <VendorShell title="Dashboard" sub="Your ID card requests at a glance.">
      <Body />
    </VendorShell>
  );
}

const Tile = ({ to, label, value, tone }) => <Link to={to} className={`vp-tile${tone ? ` ${tone}` : ''}`} aria-label={`${label}: ${value}`}><span>{label}</span><b>{value}</b></Link>;

function Body() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    vendorApi.get('/idcard-portal/overview').then((r) => setD(r.data)).catch((e) => setError(vendorError(e, 'Could not load your dashboard.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (error) return <div className="notice red" role="alert"><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>;
  if (!d) return <div className="vp-tiles" aria-busy="true" aria-label="Loading">{[1, 2, 3, 4].map((n) => <div key={n} className="vp-tile"><div className="idc-skel" style={{ width: '60%' }} /><div className="idc-skel idc-tile-skel" style={{ marginTop: 8 }} /></div>)}</div>;
  return (
    <>
      {!d.total && <div className="vp-empty" style={{ marginBottom: 14 }}><h3>No ID card requests yet</h3><p>When the company orders ID cards from you, the requests show here.</p></div>}
      <div className="vp-tiles">
        <Tile to="/vendor/idcard-portal/requests" label="Total assigned requests" value={d.total} />
        <Tile to="/vendor/idcard-portal/pending" label="Pending" value={d.pending} tone="orange" />
        <Tile to="/vendor/idcard-portal/completed" label="Completed" value={d.completed} />
        <Tile to="/vendor/idcard-portal/delivered" label="Delivered" value={d.delivered} tone="green" />
      </div>
      <h3 className="vm-h3">Latest requests</h3>
      {!d.recent.length ? <div className="vp-none">No requests yet.</div> : (
        <div className="idc-wrap"><table className="idc-table">
          <thead><tr><th>Photo</th><th>Employee ID</th><th>Name</th><th>Department</th><th>Requested</th><th>ID card status</th></tr></thead>
          <tbody>{d.recent.map((r) => (
            <tr key={r.id}><td><Photo row={r} /></td><td>{r.employeeCode || '-'}</td><td><strong>{r.name}</strong></td><td>{r.department || '-'}</td><td>{day(r.requestDate)}</td><td><StatusTag status={r.status} /></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
