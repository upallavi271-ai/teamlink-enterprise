import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import vendorApi, { vendorError, vendorDownload } from '../../vendorApi';
import VendorShell, { useVendorMe } from './VendorShell.jsx';
import Modal from '../../components/Modal.jsx';
import './vendorModules.css';

// /vendor/m/id_card_orders - the ID Card Orders module (2026-10-14). The company orders cards for employees; the vendor
// sees ONLY its own orders, downloads the data (CSV) and photos (ZIP), moves the order one step at a time
// (Received -> Printing -> Ready -> Delivered), uploads a delivery challan / proof and leaves remarks.
const two = (n) => String(n).padStart(2, '0');
const day = (s) => { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`; };
const FLOW = ['New', 'Received', 'Printing', 'Ready', 'Delivered'];
const TONE = { New: 'yellow', Received: 'blue', Printing: 'blue', Ready: 'blue', Delivered: 'green' };
const NEXT_LABEL = { Received: 'Mark as Received', Printing: 'Start Printing', Ready: 'Mark as Ready', Delivered: 'Mark as Delivered' };

function Steps({ status }) {
  const at = FLOW.indexOf(status);
  return (
    <ol className="vm-steps" aria-label="Order progress">
      {FLOW.map((s, i) => <li key={s} className={i < at ? 'done' : (i === at ? 'now' : '')} aria-current={i === at ? 'step' : undefined}>{s}</li>)}
    </ol>
  );
}

export default function VendorIdCards() {
  return (
    <VendorShell moduleKey="id_card_orders" title="ID card orders" sub="Orders from the company: employee data and photos, then update the order as you print and deliver.">
      <Body />
    </VendorShell>
  );
}

function Body() {
  const me = useVendorMe();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState('');
  const load = useCallback(() => {
    vendorApi.get('/id-card-orders').then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your orders.')));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t); }, [toast]);
  const rows = data?.rows || [];
  return (
    <>
      {toast && <div className="notice green" style={{ marginBottom: 10 }} role="status"><span>{toast}</span></div>}
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {!data ? <div className="empty-mini">Loading…</div> : !rows.length ? (
        <div className="vp-empty"><h3>No ID card orders yet</h3><p>When the company orders ID cards from you, the order shows here with the employee data and photos.</p></div>
      ) : (
        <div className="tbl-wrap vp-table">
          <table>
            <thead><tr><th>Order</th><th>Placed</th><th className="num">Cards</th><th>Status</th><th>Next step</th><th /></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td><strong>{o.orderCode}</strong>{o.note && <div className="cell-muted">{o.note}</div>}</td>
                  <td>{day(o.createdAt)}</td>
                  <td className="num">{o.lineCount}</td>
                  <td><span className={`vp-tag vp-${TONE[o.status] || 'grey'}`}>{o.status}</span></td>
                  <td>{o.nextStatus || 'All done'}</td>
                  <td><button type="button" className="btn btn-sm btn-primary" onClick={() => setOpenId(o.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <OrderModal id={openId} readOnly={!!me.preview} onClose={() => { setOpenId(null); load(); }} onToast={setToast} onChanged={load} />}
    </>
  );
}

function OrderModal({ id, readOnly, onClose, onToast, onChanged }) {
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [proofRemarks, setProofRemarks] = useState('');
  const fileRef = useRef(null);
  const load = useCallback(() => {
    vendorApi.get(`/id-card-orders/${id}`).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(vendorError(e, 'Could not open the order.')));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const o = d?.order;

  async function advance() {
    setBusy(true); setErr('');
    try {
      const r = await vendorApi.post(`/id-card-orders/${id}/status`, { status: o.nextStatus, remarks });
      onToast(r.data.message); setRemarks(''); load(); onChanged();
    } catch (e) { setErr(vendorError(e, 'Could not update the order.')); } finally { setBusy(false); }
  }
  async function saveProof() {
    const file = fileRef.current?.files?.[0];
    if (!file && !proofRemarks.trim()) { setErr('Attach the challan or proof file, or write a remark.'); return; }
    setBusy(true); setErr('');
    const fd = new FormData();
    if (file) fd.append('file', file);
    fd.append('remarks', proofRemarks);
    try {
      const r = await vendorApi.post(`/id-card-orders/${id}/proof`, fd);
      onToast(r.data.message); setProofRemarks(''); if (fileRef.current) fileRef.current.value = ''; load();
    } catch (e) { setErr(vendorError(e, 'Could not save.')); } finally { setBusy(false); }
  }
  const dl = async (path, name) => { try { await vendorDownload(path, name); } catch (e) { setErr(vendorError(e, 'Could not download.')); } };

  return (
    <Modal title={o ? `Order ${o.orderCode}` : 'Order'} size="xwide" onClose={onClose}>
      {!d ? (err ? <div className="notice red"><span>{err}</span></div> : <div className="empty-mini">Loading…</div>) : (
        <div className="vm-order">
          <Steps status={o.status} />
          <div className="small-muted">{d.lines.length} {d.lines.length === 1 ? 'card' : 'cards'} · placed {day(o.createdAt)}{o.note ? ` · ${o.note}` : ''}</div>
          {err && <div className="notice red" role="alert"><span>{err}</span></div>}

          <section className="vm-block">
            <h4>What to do next</h4>
            {o.nextStatus && d.canUpdate ? (
              <>
                <label htmlFor="vmRem">Remark (optional)</label>
                <input id="vmRem" value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. photo unclear for 2 employees" />
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-primary" disabled={busy || readOnly} onClick={advance}>{NEXT_LABEL[o.nextStatus] || `Mark as ${o.nextStatus}`}</button>
                  {readOnly && <span className="cell-muted"> Preview: view only.</span>}
                </div>
              </>
            ) : <div className="small-muted">{o.nextStatus ? 'Your login cannot change the status.' : 'This order is delivered. Thank you.'}</div>}
          </section>

          {d.canDownload && (
            <section className="vm-block">
              <h4>Download</h4>
              <div className="vm-row">
                <button type="button" className="btn" onClick={() => dl(`/id-card-orders/${id}/lines.csv`, `${o.orderCode}.csv`)}>Employee data (CSV)</button>
                <button type="button" className="btn" onClick={() => dl(`/id-card-orders/${id}/photos.zip`, `${o.orderCode}.zip`)}>Photos + data (ZIP)</button>
              </div>
              <div className="cell-muted" style={{ marginTop: 4 }}>Only the people on this order. {d.lines.filter((l) => !l.hasPhoto).length ? `${d.lines.filter((l) => !l.hasPhoto).length} have no photo on file.` : 'Every person has a photo.'}</div>
            </section>
          )}

          <section className="vm-block">
            <h4>People on this order</h4>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Employee ID</th><th>Name</th><th>Designation</th><th>Department</th><th>Blood group</th><th>Card</th><th>Photo</th></tr></thead>
                <tbody>
                  {d.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.employeeCode || '—'}</td><td><strong>{l.employeeName}</strong></td><td>{l.designation || '—'}</td><td>{l.department || '—'}</td>
                      <td>{l.bloodGroup || '—'}</td><td>{l.cardType}</td><td>{l.hasPhoto ? 'Yes' : <span className="cell-muted">No photo</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {d.canProof && (
            <section className="vm-block">
              <h4>Delivery challan / proof and remarks</h4>
              {o.hasChallan && <div className="vm-row"><span>Uploaded: <strong>{o.challanName}</strong></span><button type="button" className="btn btn-sm" onClick={() => dl(`/id-card-orders/${id}/challan`, o.challanName)}>Open</button></div>}
              {o.vendorRemarks && <div className="small-muted">Your last remark: {o.vendorRemarks}</div>}
              <label htmlFor="vmFile">Challan or proof (PDF, JPG or PNG)</label>
              <input id="vmFile" type="file" ref={fileRef} accept=".pdf,.jpg,.jpeg,.png" />
              <label htmlFor="vmPR">Remark</label>
              <textarea id="vmPR" rows={2} value={proofRemarks} maxLength={800} onChange={(e) => setProofRemarks(e.target.value)} placeholder="e.g. photo unclear for 2 employees" />
              <div style={{ marginTop: 8 }}><button type="button" className="btn" disabled={busy || readOnly} onClick={saveProof}>Save challan / remark</button></div>
            </section>
          )}

          <section className="vm-block">
            <h4>Invoices for this order</h4>
            {d.bills.length ? d.bills.map((b) => <div key={b.id} className="vm-row"><span><strong>{b.billNumber}</strong> · ₹{Number(b.total).toLocaleString('en-IN')}</span><span className={`vp-tag vp-${b.status === 'Paid' ? 'green' : (b.status === 'Rejected' ? 'red' : 'yellow')}`}>{b.statusText}</span></div>) : <div className="small-muted">No invoice sent for this order yet.</div>}
            <div style={{ marginTop: 8 }}><button type="button" className="btn btn-sm" onClick={() => navigate(`/vendor/invoices?order=${id}`)}>Send an invoice for this order</button></div>
          </section>

          <section className="vm-block">
            <h4>History</h4>
            <ul className="vm-hist">
              {d.history.map((h) => <li key={h.id}><b>{h.to}</b>{h.from && h.from !== h.to ? ` (from ${h.from})` : ''} · {h.by} · {day(h.at)}{h.note ? ` · ${h.note}` : ''}</li>)}
              {!d.history.length && <li className="cell-muted">Nothing yet.</li>}
            </ul>
          </section>
        </div>
      )}
    </Modal>
  );
}
