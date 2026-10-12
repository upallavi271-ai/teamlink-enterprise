import { useEffect, useState } from 'react';
import vendorApi, { vendorError } from '../../vendorApi';
import VendorShell from './VendorShell.jsx';

// /vendor/profile - the vendor's own details as the company holds them (read
// only: to change them, the vendor asks the company).
export default function VendorProfile() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    vendorApi.get('/profile').then((r) => setD(r.data)).catch((e) => setError(vendorError(e, 'Could not load your details.')));
  }, []);
  const v = d?.vendor;
  const rows = v ? [
    ['Vendor ID', v.vendorCode], ['Name', v.name], ['Company', v.companyName], ['Contact person', v.contactPerson], ['Email', v.email], ['Phone', v.phone],
    ['GSTIN', v.gstin], ['PAN', v.pan], ['Category', v.category], ['Payment terms', v.paymentTerms], ['Address', v.address],
  ] : [];
  return (
    <VendorShell title="Your details" sub="This is what the company has on file for you.">
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {!d ? <div className="empty-mini">Loading…</div> : (
        <>
          <div className="vp-card">
            <dl className="vp-dl">{rows.map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{x || '—'}</dd></div>)}</dl>
          </div>
          <div className="vp-card">
            <dl className="vp-dl">
              <div><dt>Your login name</dt><dd>{d.login.name}</dd></div>
              <div><dt>Your login email</dt><dd>{d.login.email}</dd></div>
            </dl>
          </div>
          <p className="vp-invnote">{d.note}</p>
        </>
      )}
    </VendorShell>
  );
}
