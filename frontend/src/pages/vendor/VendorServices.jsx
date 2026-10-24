import { useCallback, useEffect, useState } from 'react';
import vendorApi, { vendorError } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import VendorShell, { openVendorFile } from './VendorShell.jsx';
import { inr, day } from './vendorFormat.js';

// /vendor/services - Services & Agreements, the fourth of the vendor's four modules. READ ONLY: only this vendor's own records.
//   Agreements          the agreement documents the company shared with this vendor
//   Services            what the vendor bills the company for (from its own bills, grouped by service / category)
//   Orders              purchase-order documents and orders the company placed with this vendor
//   Additional charges  extra charges and their approval (the app keeps no such record yet, so the section appears only when one exists)
// A section with nothing in it is not drawn; when there is nothing at all, one honest empty state says so. A vendor cannot approve a charge here.
const NA = <span className="vp-na">Not available</span>;

export default function VendorServices() {
  return (
    <VendorShell title="Services & Agreements" sub="Your agreements, the services you provide and the orders the company has given you.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const load = useCallback(() => {
    setError('');
    vendorApi.get('/records/services').then((r) => setD(r.data)).catch((e) => setError(vendorError(e, 'Could not load your services and agreements.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  async function openDoc(doc) {
    try { await openVendorFile({ kind: doc.kind, id: doc.id }); } catch (e) { setError(vendorError(e, 'Could not open the document.')); }
  }
  if (error && !d) return <div className="notice red"><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>;
  if (!d) return <div className="empty-mini">Loading&hellip;</div>;
  const none = !d.agreements.length && !d.services.length && !d.orders.length && !d.charges.length;
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      <div className="vp-actions-row"><button type="button" className="btn btn-sm" onClick={load}>Refresh</button></div>
      {none && (
        <div className="vp-empty">
          <h3>Nothing recorded yet</h3>
          <p>When the company shares an agreement with you, places an order, or books bills for a service of yours, it shows here.</p>
        </div>
      )}

      {d.agreements.length > 0 && (
        <section className="vp-section" aria-label="Agreements">
          <h3 className="vm-h3">Agreements</h3>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Agreement</th><th>Type</th><th>Effective</th><th>Expiry</th><th>Renewal</th><th>Status</th><th /></tr></thead>
              <tbody>
                {d.agreements.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.title}</strong>{a.sharedOn ? <small className="cell-muted"> shared {day(a.sharedOn)}</small> : null}</td>
                    <td>{a.type}</td>
                    <td>{a.effective ? day(a.effective) : NA}</td>
                    <td>{a.expiry ? day(a.expiry) : NA}</td>
                    <td>{a.renewal ? day(a.renewal) : NA}</td>
                    <td><span className="vp-tag vp-blue">{a.status}</span></td>
                    <td><button type="button" className="btn btn-sm" onClick={() => openDoc(a.document)}>View / download</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.services.length > 0 && (
        <section className="vp-section" aria-label="Services and subscriptions">
          <h3 className="vm-h3">Services &amp; subscriptions</h3>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Service</th><th>Billing period</th><th className="num">Bills</th><th>First bill</th><th>Last bill</th><th>Covered until</th><th className="num">Billed</th><th className="num">Outstanding</th></tr></thead>
              <tbody>
                {d.services.map((s) => (
                  <tr key={s.name}>
                    <td><strong>{s.name}</strong>{s.description ? <small className="cell-muted"> {s.description}</small> : null}</td>
                    <td>{s.billingPeriod || NA}</td>
                    <td className="num">{s.bills}</td>
                    <td>{s.firstBilled ? day(s.firstBilled) : NA}</td>
                    <td>{s.lastBilled ? day(s.lastBilled) : NA}{s.latestInvoice ? <small className="cell-muted"> ({s.latestInvoice})</small> : null}</td>
                    <td>{s.coveredUntil ? day(s.coveredUntil) : NA}</td>
                    <td className="num">{inr(s.billed)}</td>
                    <td className="num">{inr(s.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.orders.length > 0 && (
        <section className="vp-section" aria-label="Orders">
          <h3 className="vm-h3">Purchase &amp; service orders</h3>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Order no.</th><th>Order date</th><th>Details</th><th>Status</th><th /></tr></thead>
              <tbody>
                {d.orders.map((o) => (
                  <tr key={o.id} className="vp-row-click" onClick={() => setOpen(o.id)}>
                    <td><strong>{o.poNumber}</strong></td>
                    <td>{o.orderDate ? day(o.orderDate) : NA}</td>
                    <td>{o.description || NA}</td>
                    <td><span className="vp-tag vp-blue">{o.statusText}</span></td>
                    <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(o.id); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.charges.length > 0 && (
        <section className="vp-section" aria-label="Additional charges">
          <h3 className="vm-h3">Additional charges</h3>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Charge</th><th className="num">Amount</th><th>Related</th><th>Approval</th></tr></thead>
              <tbody>{d.charges.map((c) => <tr key={c.id}><td>{c.description}</td><td className="num">{inr(c.amount)}</td><td>{c.related || NA}</td><td>{c.approval}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function OrderDetail({ id, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { vendorApi.get(`/records/purchase-orders/${encodeURIComponent(id)}`).then((r) => setD(r.data.purchaseOrder)).catch((e) => setError(vendorError(e, 'Could not open this order.'))); }, [id]);
  async function openDoc(doc) {
    try { await openVendorFile({ kind: doc.kind, id: doc.id }); } catch (e) { setError(vendorError(e, 'Could not open the document.')); }
  }
  return (
    <Modal title={d ? `Order ${d.poNumber}` : 'Order'} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {!d && !error && <div className="empty-mini">Loading&hellip;</div>}
      {d && (
        <div className="vp-detail">
          <dl>
            <dt>Status</dt><dd><span className="vp-tag vp-blue">{d.statusText}</span></dd>
            <dt>Order date</dt><dd>{d.orderDate ? day(d.orderDate) : NA}</dd>
            <dt>Required date</dt><dd>{d.expectedDelivery ? day(d.expectedDelivery) : NA}</dd>
            {d.deliveredOn && (<><dt>Delivered on</dt><dd>{day(d.deliveredOn)}</dd></>)}
            <dt>Details</dt><dd>{d.description || NA}</dd>
          </dl>
          {d.items.length > 0 && (
            <div className="tbl-wrap vp-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Item</th><th className="num">Quantity</th></tr></thead>
                <tbody>{d.items.map((i, n) => <tr key={`${i.description}${n}`}><td>{i.description}</td><td className="num">{i.quantity}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <h4 style={{ margin: '12px 0 6px' }}>Documents</h4>
          {!d.documents.length ? <div className="vp-none">No documents.</div> : d.documents.map((doc) => (
            <div key={`${doc.kind}${doc.id}`} className="vm-row"><span>{doc.label}: {doc.name}</span><button type="button" className="btn btn-sm" onClick={() => openDoc(doc)}>Open</button></div>
          ))}
        </div>
      )}
    </Modal>
  );
}
