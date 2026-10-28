import { useCallback, useEffect, useState } from 'react';
import vendorApi, { vendorError } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import VendorShell, { openVendorFile } from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { day } from './vendorFormat.js';
import { rs, when, PayTag, PayLine } from './assetPortalCommon.jsx';
import { VendorIoBar } from './VendorIo.jsx';
import './vendorModules.css';

// /vendor/asset-portal/orders - Orders in the Assets Vendor Portal: the orders the company placed with THIS vendor (the app keeps ID-card
// orders and shared purchase-order documents; there is no other order table, and nothing is made up). The vendor moves an order one
// step at a time (the same rule as always); every change is written to the order's history.
const SORTS = [['orderDate', 'Order date'], ['poNumber', 'Order number'], ['status', 'Delivery status']];

export default function AssetPortalOrders() {
  return (
    <VendorShell title="Orders" sub="The orders the company has given you, and where each one stands.">
      <Body />
    </VendorShell>
  );
}

// Also the "Orders" tab of Invoices & Payments (27 Oct 2026)
export function OrdersBody() { return <Body />; }

function Body() {
  const [data, setData] = useState(null);
  const [f, setF] = useState({ q: '', status: '', from: '', to: '', sort: 'orderDate', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  const load = useCallback(() => {
    vendorApi.get('/asset-portal/orders', { params: { q: qDeb || undefined, status: f.status || undefined, from: f.from || undefined, to: f.to || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your orders.')));
  }, [qDeb, f.status, f.from, f.to, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.status || f.from || f.to);
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {data && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>Orders</span><b>{data.summary.count}</b></div>
          {data.summary.byStatus.map((s) => <div key={s.status} className="vp-tile"><span>{s.status}</span><b>{s.count}</b></div>)}
        </div>
      )}
      <VendorIoBar list="orders" params={{ ...f, q: qDeb }} importKey="order-status" onImported={load} />
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search order number or details" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        {data && data.statuses.length > 0 && (
          <select aria-label="Delivery status" value={f.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Any delivery status</option>
            {data.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <div className="vp-dates">
          <input type="date" aria-label="From date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          <span className="vp-to">to</span>
          <input type="date" aria-label="To date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', status: '', from: '', to: '', sort: 'orderDate', dir: 'desc', page: 1 })}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">
          {data.all ? <><h3>No order matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No orders yet</h3><p>When the company places an order with you, it shows here.</p></>}
        </div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Order</th><th>Type</th><th>Order date</th><th>Details</th><th className="num">Quantity</th><th className="num">Amount</th><th>Delivery status</th><th>Payment</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="vp-row-click" onClick={() => setOpen(r.id)}>
                    <td><strong>{r.orderNo}</strong></td>
                    <td>{r.kindText}</td>
                    <td>{day(r.orderDate)}</td>
                    <td>{r.description || '-'}</td>
                    <td className="num">{r.quantity == null ? '-' : r.quantity}</td>
                    <td className="num">{rs(r.amount)}</td>
                    <td><span className={`vp-tag vp-${r.status === 'Delivered' ? 'green' : 'blue'}`}>{r.deliveryStatus}</span></td>
                    <td><PayTag pay={r.payment} /></td>
                    <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function OrderDetail({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const url = `/asset-portal/orders/${encodeURIComponent(id)}`;
  useEffect(() => { vendorApi.get(url).then((r) => setD(r.data)).catch((e) => setError(vendorError(e, 'Could not open this order.'))); }, [url]);
  async function move(next) {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await vendorApi.post(`${url}/status`, { status: next, remarks: remarks || undefined });
      setD(r.data); setMsg(r.data.message || 'Saved.'); setRemarks(''); onChanged();
    } catch (e) { setError(vendorError(e, 'Could not change the status.')); } finally { setBusy(false); }
  }
  async function openDoc(doc) {
    try { await openVendorFile({ kind: doc.kind, id: doc.id }); } catch (e) { setError(vendorError(e, 'Could not open the document.')); }
  }
  const o = d?.order;
  return (
    <Modal title={o ? `Order ${o.orderNo}` : 'Order'} size="wide" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {msg && <div className="notice green" style={{ marginBottom: 8 }}><span>{msg}</span></div>}
      {!d && !error && <div className="empty-mini">Loading&hellip;</div>}
      {d && (
        <div className="vp-detail">
          {o.updatable && (
            <ol className="vm-steps" aria-label="Delivery steps">
              {d.steps.map((s, i) => { const at = d.steps.indexOf(o.status); return <li key={s} className={i < at ? 'done' : (i === at ? 'now' : '')}>{s}</li>; })}
            </ol>
          )}
          <dl>
            <dt>Delivery status</dt><dd><span className={`vp-tag vp-${o.status === 'Delivered' ? 'green' : 'blue'}`}>{o.deliveryStatus}</span></dd>
            <dt>Type</dt><dd>{o.kindText}</dd>
            <dt>Order date</dt><dd>{day(o.orderDate)}</dd>
            <dt>Expected delivery</dt><dd>{day(o.expectedDelivery)}</dd>
            {o.deliveredOn && (<><dt>Delivered on</dt><dd>{day(o.deliveredOn)}</dd></>)}
            <dt>Details</dt><dd>{o.description || '-'}</dd>
            <dt>Quantity</dt><dd>{o.quantity == null ? '-' : o.quantity}</dd>
            <dt>Payment</dt><dd><PayTag pay={o.payment} /> <PayLine pay={o.payment} /></dd>
            <dt>Amount</dt><dd>{rs(o.amount)}</dd>
          </dl>
          {o.items.length > 0 && (
            <div className="tbl-wrap vp-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Item</th><th className="num">Quantity</th></tr></thead>
                <tbody>{o.items.map((i, n) => <tr key={`${i.description}${n}`}><td>{i.description}</td><td className="num">{i.quantity}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {o.updatable && o.nextStatus && d.canEdit && (
            <div className="vm-form" style={{ marginTop: 12 }}>
              <h4>Update the delivery status</h4>
              <p className="cell-muted" style={{ marginTop: 0 }}>One step at a time. The next step is <strong>{o.nextStatus}</strong>.</p>
              <input type="text" value={remarks} maxLength={500} placeholder="A short remark (optional)" onChange={(e) => setRemarks(e.target.value)} aria-label="Remark" style={{ width: '100%', marginBottom: 8 }} />
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => move(o.nextStatus)}>{busy ? 'Saving...' : `Mark as ${o.nextStatus}`}</button>
            </div>
          )}
          {o.updatable && !d.canEdit && <p className="cell-muted">Your login can only look at orders. Ask the company if you need to update them.</p>}
          <h4 style={{ margin: '12px 0 6px' }}>Order history</h4>
          {!d.history.length ? <div className="vp-none">No change yet.</div> : (
            <ul className="vm-hist">{d.history.map((h) => <li key={h.id}><strong>{h.by}</strong> changed the status from <em>{h.from}</em> to <em>{h.to}</em>{h.note ? <> &ndash; {h.note}</> : null} <span className="cell-muted">&middot; {when(h.at)}</span></li>)}</ul>
          )}
          {o.documents.length > 0 && (
            <>
              <h4 style={{ margin: '12px 0 6px' }}>Documents</h4>
              {o.documents.map((doc) => <div key={`${doc.kind}${doc.id}`} className="vm-row"><span>{doc.label}: {doc.name}</span><button type="button" className="btn btn-sm" onClick={() => openDoc(doc)}>Open</button></div>)}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
