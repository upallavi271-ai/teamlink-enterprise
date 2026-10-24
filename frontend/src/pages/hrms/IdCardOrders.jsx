import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Combo from '../../components/Combo.jsx';
import '../vendor/vendorPortal.css';
import '../vendor/vendorModules.css';

// ---------------------------------------------------------------------------
// EMPLOYEE MANAGEMENT -> "ID card orders" tab (2026-10-14). HR / Admin place an order with the ID card vendor: pick the
// employees (type to search) and the card type (New / Replacement / Lost). Every line keeps the employee's name, ID,
// designation, department, blood group and photo as they are today. The vendor moves the order
// New -> Received -> Printing -> Ready -> Delivered in its portal and this screen shows every step.
// Server: routes/idCardOrders.js. Not a sidebar entry.
// ---------------------------------------------------------------------------
const two = (n) => String(n).padStart(2, '0');
const day = (s) => { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? '—' : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`; };
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const TONE = { New: 'yellow', Received: 'blue', Printing: 'blue', Ready: 'blue', Delivered: 'green' };
const FLOW = ['New', 'Received', 'Printing', 'Ready', 'Delivered'];
const CARD = ['New', 'Replacement', 'Lost'];

export default function IdCardOrders() {
  const [d, setD] = useState(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api.get('/id-card-orders', { params: { status: status || undefined } }).then((r) => { setD(r.data); setErr(''); })
      .catch((e) => setErr(e.response?.status === 503 ? 'ID card orders are not switched on in the database yet. Ask the company to finish the setup.' : errText(e, 'Could not load the orders.')));
  }, [status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!msg) return undefined; const t = setTimeout(() => setMsg(''), 5000); return () => clearTimeout(t); }, [msg]);
  const rows = (d?.rows || []).filter((o) => !q || [o.orderCode, o.vendorName].some((x) => String(x || '').toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="vm-wrap">
      <div className="small-muted" style={{ marginBottom: 10 }}>Order ID cards from your ID card vendor. They see the employee data and photos in their portal and update each step here.</div>
      {msg && <div className="notice green" style={{ marginBottom: 10 }}><span>{msg}</span></div>}
      {err && <div className="notice red" style={{ marginBottom: 10 }}><span>{err} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search order or vendor" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search orders" />
        <Combo value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All steps</option>
          {FLOW.map((s) => <option key={s} value={s}>{s}</option>)}
        </Combo>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>+ New order</button>
      </div>
      {!d ? (err ? null : <div className="empty-mini">Loading…</div>) : !rows.length ? (
        <div className="vp-empty"><h3>No ID card orders yet</h3><p>Press “+ New order”, pick the employees and the card type.</p></div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Order</th><th>Vendor</th><th className="num">Cards</th><th>Step</th><th>Placed</th><th>By</th><th /></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td><strong>{o.orderCode}</strong>{o.vendorRemarks && <div className="cell-muted">Vendor: {o.vendorRemarks}</div>}</td>
                  <td>{o.vendorName}</td><td className="num">{o.lineCount}</td>
                  <td><span className={`vp-tag vp-${TONE[o.status] || 'grey'}`}>{o.status}</span></td>
                  <td>{day(o.createdAt)}</td><td>{o.createdByName || '—'}</td>
                  <td><button type="button" className="btn btn-sm btn-primary" onClick={() => setOpenId(o.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <NewOrder onClose={() => setAdding(false)} onDone={(m) => { setAdding(false); setMsg(m); load(); }} />}
      {openId && <OrderView id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function NewOrder({ onClose, onDone }) {
  const [vendors, setVendors] = useState(null);
  const [vendorId, setVendorId] = useState('');
  const [cardType, setCardType] = useState('New');
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [picked, setPicked] = useState(new Map()); // employeeId -> { emp, cardType }
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/id-card-orders/vendors').then((r) => { setVendors(r.data.vendors); if (r.data.vendors.length === 1) setVendorId(r.data.vendors[0].id); }).catch((e) => setErr(errText(e, 'Could not load the vendors.'))); }, []);
  useEffect(() => {
    const t = setTimeout(() => { api.get('/id-card-orders/employees', { params: { q } }).then((r) => setFound(r.data.employees)).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const tick = (e, on) => setPicked((m) => { const n = new Map(m); if (on) n.set(e.id, { emp: e, cardType }); else n.delete(e.id); return n; });
  async function save() {
    setErr('');
    if (!vendorId) { setErr('Pick the ID card vendor.'); return; }
    if (!picked.size) { setErr('Pick at least one employee.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/id-card-orders', { vendorId, cardType, note, lines: [...picked.values()].map((p) => ({ employeeId: p.emp.id, cardType: p.cardType })) });
      onDone(r.data.message);
    } catch (e) { setErr(errText(e, 'Could not place the order.')); setBusy(false); }
  }
  return (
    <Modal
      title="New ID card order" size="xwide" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Placing…' : `Place order (${picked.size})`}</button></>}
    >
      <div className="vp-form">
        <div className="vp-two">
          <div>
            <label htmlFor="icoV">ID card vendor</label>
            <Combo id="icoV" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">{vendors ? 'Pick the vendor…' : 'Loading…'}</option>
              {(vendors || []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.hasPortal ? '' : ' (no portal login yet)'}</option>)}
            </Combo>
            {vendors && !vendors.length && <div className="cell-muted">No ID card vendor yet. Add one in Administration → Company Setup → Vendors with the category “ID Cards”, then give it a login.</div>}
          </div>
          <div>
            <div className="vp-lbl">Card type for new picks</div>
            <div className="vp-choice" role="radiogroup" aria-label="Card type">
              {CARD.map((c) => <button type="button" key={c} role="radio" aria-checked={cardType === c} className={`vp-chip${cardType === c ? ' on' : ''}`} onClick={() => setCardType(c)}>{c}</button>)}
            </div>
          </div>
        </div>
        <label htmlFor="icoQ">Find employees (name, ID, designation or department)</label>
        <input id="icoQ" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search" />
        <div className="vl-pick" style={{ maxHeight: 260 }}>
          {found.map((e) => (
            <label key={e.id} className="vl-pick-row">
              <input type="checkbox" checked={picked.has(e.id)} onChange={(ev) => tick(e, ev.target.checked)} />
              <span><strong>{e.name}</strong> <span className="cell-muted">{e.employeeCode} · {e.designation || 'no designation'} · {e.department || 'no department'} · {e.bloodGroup || 'blood group not set'} · {e.hasPhoto ? 'photo on file' : 'no photo'}</span></span>
            </label>
          ))}
          {!found.length && <div className="cell-muted" style={{ padding: 8 }}>No employee matches.</div>}
        </div>
        {picked.size > 0 && (
          <>
            <div className="vp-lbl">On this order ({picked.size})</div>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Name</th><th>ID</th><th>Designation</th><th>Department</th><th>Blood group</th><th>Photo</th><th>Card</th><th /></tr></thead>
                <tbody>
                  {[...picked.values()].map(({ emp, cardType: ct }) => (
                    <tr key={emp.id}>
                      <td><strong>{emp.name}</strong></td><td>{emp.employeeCode}</td><td>{emp.designation || '—'}</td><td>{emp.department || '—'}</td><td>{emp.bloodGroup || '—'}</td>
                      <td>{emp.hasPhoto ? 'Yes' : <span className="cell-muted">None</span>}</td>
                      <td style={{ minWidth: 140 }}>
                        <Combo value={ct} onChange={(e) => setPicked((m) => { const n = new Map(m); n.set(emp.id, { emp, cardType: e.target.value }); return n; })} aria-label={`Card type for ${emp.name}`}>
                          {CARD.map((c) => <option key={c} value={c}>{c}</option>)}
                        </Combo>
                      </td>
                      <td><button type="button" className="btn btn-sm btn-ghost" onClick={() => tick(emp, false)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <label htmlFor="icoN">Note for the vendor (optional)</label>
        <input id="icoN" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        {err && <div className="error-text" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      </div>
    </Modal>
  );
}

function OrderView({ id, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/id-card-orders/${id}`).then((r) => setD(r.data)).catch((e) => setErr(errText(e, 'Could not open the order.'))); }, [id]);
  async function challan() {
    try {
      const res = await api.get(`/id-card-orders/${id}/challan`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setErr(errText(e, 'Could not open the challan.')); }
  }
  const o = d?.order;
  const at = o ? FLOW.indexOf(o.status) : 0;
  return (
    <Modal title={o ? `Order ${o.orderCode} · ${o.vendorName}` : 'Order'} size="xwide" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {!d ? (err ? <div className="notice red"><span>{err}</span></div> : <div className="empty-mini">Loading…</div>) : (
        <div className="vm-order">
          <ol className="vm-steps" aria-label="Order progress">{FLOW.map((s, i) => <li key={s} className={i < at ? 'done' : (i === at ? 'now' : '')}>{s}</li>)}</ol>
          {err && <div className="notice red"><span>{err}</span></div>}
          {o.note && <div className="small-muted">Your note: {o.note}</div>}
          {o.vendorRemarks && <div className="notice amber"><span>Vendor remark: {o.vendorRemarks}</span></div>}
          {o.hasChallan && <div className="vm-row"><span>Delivery challan / proof: <strong>{o.challanName}</strong></span><button type="button" className="btn btn-sm" onClick={challan}>Open</button></div>}
          <section className="vm-block">
            <h4>People ({d.lines.length})</h4>
            <div className="tbl-wrap"><table>
              <thead><tr><th>ID</th><th>Name</th><th>Designation</th><th>Department</th><th>Blood group</th><th>Card</th><th>Photo</th></tr></thead>
              <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.employeeCode}</td><td><strong>{l.employeeName}</strong></td><td>{l.designation || '—'}</td><td>{l.department || '—'}</td><td>{l.bloodGroup || '—'}</td><td>{l.cardType}</td><td>{l.hasPhoto ? 'Yes' : 'None'}</td></tr>)}</tbody>
            </table></div>
          </section>
          {d.bills.length > 0 && <section className="vm-block"><h4>Invoices for this order</h4>{d.bills.map((b) => <div key={b.id} className="vm-row"><span><strong>{b.billNumber}</strong> · {b.billCode} · ₹{Number(b.total).toLocaleString('en-IN')}</span><span className="vp-tag vp-yellow">{b.status}</span></div>)}</section>}
          <section className="vm-block">
            <h4>History</h4>
            <ul className="vm-hist">{d.history.map((h) => <li key={h.id}><b>{h.to}</b> · {h.by} ({h.kind}) · {day(h.at)}{h.note ? ` · ${h.note}` : ''}</li>)}</ul>
          </section>
        </div>
      )}
    </Modal>
  );
}
