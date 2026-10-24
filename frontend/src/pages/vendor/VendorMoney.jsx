import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import vendorApi, { vendorError, vendorDownload } from '../../vendorApi';
import VendorShell, { useVendorMe } from './VendorShell.jsx';
import './vendorModules.css';
import Combo from '../../components/Combo.jsx';

// The money screens of the vendor modules (2026-10-14): Monthly Bills, Invoices (the "send an invoice" panel on the
// Invoices page), Payments, Office, Expenses. Each is built ONCE and shown to any vendor that has the module.
const inr = (n) => (n == null || n === '' ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const two = (n) => String(n).padStart(2, '0');
const day = (s) => { if (!s) return '—'; const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s); return Number.isNaN(d.getTime()) ? String(s) : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`; };
const TONE = { Submitted: 'yellow', Approved: 'blue', Paid: 'green', Rejected: 'red' };
const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
const monthNow = () => new Date().toISOString().slice(0, 7);

// ---- invoices / monthly bills sent from the portal ---------------------------------
export function ModuleBillsPanel({ kind, orders = [], presetOrderId = '' }) {
  const me = useVendorMe();
  const readOnly = !!me.preview;
  const monthly = kind === 'monthly_bill';
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [open, setOpen] = useState(!!presetOrderId);
  const BLANK = useMemo(() => ({ billNumber: '', billDate: new Date().toISOString().slice(0, 10), period: monthNow(), dueDate: '', quantity: '', rate: '', amount: '', gst: '', orderId: presetOrderId || '', remarks: '', lines: '' }), [presetOrderId]);
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState('');
  const fileRef = useRef(null);
  const idem = useRef(newKey());
  const load = useCallback(() => {
    vendorApi.get('/module-bills', { params: { kind } }).then((r) => { setD(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your bills.')));
  }, [kind]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t); }, [toast]);

  const calc = !monthly && f.quantity !== '' && f.rate !== '' ? Math.round(Number(f.quantity) * Number(f.rate) * 100) / 100 : null;
  const total = (calc != null && !Number.isNaN(calc) ? calc : Number(f.amount || 0)) + Number(f.gst || 0);

  async function send(e) {
    e.preventDefault();
    setFieldErr('');
    const file = fileRef.current?.files?.[0];
    if (!file) { setFieldErr('Attach the file (PDF, JPG or PNG).'); return; }
    const lines = f.lines.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(.*?)[,\t ]+([\d.,]+)$/.exec(l); return m ? { number: m[1].trim(), amount: m[2].replace(/,/g, '') } : { number: l, amount: 0 }; });
    const fd = new FormData();
    fd.append('billNumber', f.billNumber);
    if (monthly) { fd.append('period', f.period); fd.append('dueDate', f.dueDate); fd.append('amount', f.amount); if (lines.length) fd.append('lines', JSON.stringify(lines)); } else {
      fd.append('billDate', f.billDate); fd.append('quantity', f.quantity); fd.append('rate', f.rate); fd.append('amount', f.amount); if (f.orderId) fd.append('orderId', f.orderId);
    }
    fd.append('gst', f.gst); fd.append('remarks', f.remarks); fd.append('file', file);
    setBusy(true);
    try {
      const r = await vendorApi.post(`/module-bills?kind=${kind}`, fd, { headers: { 'Idempotency-Key': idem.current } });
      setToast(r.data.message); setF(BLANK); if (fileRef.current) fileRef.current.value = ''; idem.current = newKey(); setOpen(false); load();
    } catch (err) { setFieldErr(vendorError(err, 'Could not send it.')); } finally { setBusy(false); }
  }
  const rows = d?.rows || [];
  const word = monthly ? 'monthly bill' : 'invoice';
  return (
    <div className="vm-panel">
      {toast && <div className="notice green" style={{ marginBottom: 10 }} role="status"><span>{toast}</span></div>}
      {error && <div className="notice red" style={{ marginBottom: 10 }} role="alert"><span>{error}</span></div>}
      {d?.canRaise && !open && <div style={{ margin: '4px 0 10px' }}><button type="button" className="btn btn-primary" disabled={readOnly} onClick={() => setOpen(true)}>{monthly ? 'Upload this month\'s bill' : 'Send an invoice'}</button>{readOnly && <span className="cell-muted"> Preview: view only.</span>}</div>}
      {d?.canRaise && open && (
        <form className="vm-form" onSubmit={send} noValidate>
          <h4>{monthly ? 'Upload a monthly bill' : 'Send an invoice'}</h4>
          <div className="vm-grid">
            <div><label htmlFor="mbNo">{monthly ? 'Bill number' : 'Invoice number'}</label><input id="mbNo" value={f.billNumber} maxLength={60} onChange={(e) => setF({ ...f, billNumber: e.target.value })} /></div>
            {monthly ? (
              <>
                <div><label htmlFor="mbPer">Bill month</label><input id="mbPer" type="month" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></div>
                <div><label htmlFor="mbDue">Due date</label><input id="mbDue" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></div>
                <div><label htmlFor="mbAmt">Amount before GST (₹)</label><input id="mbAmt" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
              </>
            ) : (
              <>
                <div><label htmlFor="mbDate">Invoice date</label><input id="mbDate" type="date" value={f.billDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setF({ ...f, billDate: e.target.value })} /></div>
                {orders.length > 0 && (
                  <div>
                    <label htmlFor="mbOrd">For which order (optional)</label>
                    <Combo id="mbOrd" value={f.orderId} onChange={(e) => setF({ ...f, orderId: e.target.value })}>
                      <option value="">Not for one order</option>
                      {orders.map((o) => <option key={o.id} value={o.id}>{o.orderCode} · {o.lineCount} cards</option>)}
                    </Combo>
                  </div>
                )}
                <div><label htmlFor="mbQty">Quantity</label><input id="mbQty" inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></div>
                <div><label htmlFor="mbRate">Rate (₹ each)</label><input id="mbRate" inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></div>
                <div><label htmlFor="mbAmt">Amount before GST (₹)</label><input id="mbAmt" inputMode="decimal" value={calc != null ? String(calc) : f.amount} readOnly={calc != null} onChange={(e) => setF({ ...f, amount: e.target.value })} aria-describedby="mbAmtH" /><div id="mbAmtH" className="cell-muted">{calc != null ? 'Quantity × rate.' : 'Or fill quantity and rate.'}</div></div>
              </>
            )}
            <div><label htmlFor="mbGst">GST (₹)</label><input id="mbGst" inputMode="decimal" value={f.gst} onChange={(e) => setF({ ...f, gst: e.target.value })} /></div>
            <div><label htmlFor="mbFile">{monthly ? 'Bill PDF' : 'Invoice file'} (PDF, JPG or PNG)</label><input id="mbFile" type="file" ref={fileRef} accept=".pdf,.jpg,.jpeg,.png" /></div>
          </div>
          {monthly && (
            <div>
              <label htmlFor="mbLines">Charge per number (optional)</label>
              <textarea id="mbLines" rows={3} value={f.lines} onChange={(e) => setF({ ...f, lines: e.target.value })} placeholder={'One line per number, like:\n9876543210, 499\n9876500000, 799'} />
            </div>
          )}
          <div><label htmlFor="mbRem">Remarks (optional)</label><input id="mbRem" value={f.remarks} maxLength={1000} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></div>
          <div className="small-muted">Total with GST: <b>{inr(total)}</b></div>
          <div className="error-text" role="alert" aria-live="assertive">{fieldErr}</div>
          <div className="vm-row" style={{ marginTop: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : `Send ${word}`}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setOpen(false); setFieldErr(''); }}>Cancel</button>
          </div>
        </form>
      )}
      {!d ? <div className="empty-mini">Loading…</div> : !rows.length ? (
        <div className="vp-empty"><h3>{monthly ? 'No monthly bills sent yet' : 'No invoices sent yet'}</h3><p>{monthly ? 'Upload the bill each month. You will see here whether it is Pending, Approved or Paid.' : 'Send an invoice and you will see here whether it is Submitted, Approved, Paid or Rejected.'}</p></div>
      ) : (
        <div className="tbl-wrap vp-table">
          <table>
            <thead><tr><th>{monthly ? 'Month' : 'Invoice no.'}</th><th>{monthly ? 'Bill no.' : 'Date'}</th><th>{monthly ? 'Due date' : 'Order'}</th><th className="num">Amount</th><th className="num">GST</th><th className="num">Total</th><th>Status</th><th>Paid</th><th /></tr></thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td><strong>{monthly ? b.periodLabel : b.billNumber}</strong><div className="cell-muted">{b.billCode}</div></td>
                  <td>{monthly ? b.billNumber : day(b.billDate)}</td>
                  <td>{monthly ? day(b.dueDate) : (orders.find((o) => o.id === b.orderId)?.orderCode || '—')}</td>
                  <td className="num">{inr(b.amount)}</td><td className="num">{inr(b.gst)}</td><td className="num"><strong>{inr(b.total)}</strong></td>
                  <td><span className={`vp-tag vp-${TONE[b.status] || 'grey'}`}>{b.statusText}</span>{b.rejectionReason && <div className="vp-why">{b.rejectionReason}</div>}</td>
                  <td>{b.status === 'Paid' ? <>{day(b.paidOn)}<div className="cell-muted">{b.paymentRef}</div></> : '—'}</td>
                  <td>{b.document && <button type="button" className="btn btn-sm" onClick={() => vendorDownload(`/module-bills/${b.id}/document`, b.document.name).catch((e) => setError(vendorError(e, 'Could not open the file.')))}>Open</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MonthlyBillsPage() {
  return (
    <VendorShell moduleKey="monthly_bills" title="Monthly bills" sub="Upload each month's bill and see whether it is Pending, Approved or Paid.">
      <ModuleBillsPanel kind="monthly_bill" />
    </VendorShell>
  );
}

// ---- payments ------------------------------------------------------------------------
export function PaymentsPage() {
  return (
    <VendorShell moduleKey="payments" title="Payments" sub="Every payment the company has made to you: date, amount and reference number.">
      <PaymentsBody />
    </VendorShell>
  );
}
function PaymentsBody() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { vendorApi.get('/payments').then((r) => { setD(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your payments.'))); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {!d ? <div className="empty-mini">Loading…</div> : !d.rows.length ? (
        <div className="vp-empty"><h3>No payments yet</h3><p>When the company pays a bill of yours it shows here with the date, amount and reference number.</p></div>
      ) : (
        <>
          <div className="vp-tiles"><div className="vp-tile green"><span>Paid to you</span><b>{inr(d.total)}</b></div><div className="vp-tile"><span>Payments</span><b>{d.rows.length}</b></div></div>
          <div className="tbl-wrap vp-table">
            <table>
              <thead><tr><th>Date</th><th className="num">Amount</th><th>Reference no.</th><th>For</th></tr></thead>
              <tbody>{d.rows.map((r) => <tr key={r.key}><td>{day(r.date)}</td><td className="num"><strong>{inr(r.amount)}</strong></td><td>{r.reference}</td><td>{r.for}{r.mode && <div className="cell-muted">{r.mode}</div>}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ---- expenses / office -----------------------------------------------------------------
function BillRows({ rows }) {
  return (
    <div className="tbl-wrap vp-table">
      <table>
        <thead><tr><th>Bill</th><th>Date</th><th className="num">Amount</th><th className="num">GST</th><th className="num">TDS</th><th className="num">You receive</th><th>Status</th><th>Paid on</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td><strong>{r.billNumber || r.billCode || '—'}</strong>{r.description && <div className="cell-muted">{r.description}</div>}</td>
              <td>{day(r.billDate)}</td><td className="num">{inr(r.amount)}</td><td className="num">{inr(r.gst)}</td><td className="num">{inr(r.tds)}</td><td className="num"><strong>{inr(r.netPayable)}</strong></td>
              <td><span className={`vp-tag vp-${r.paid ? 'green' : (r.status === 'REJECTED' ? 'red' : 'yellow')}`}>{r.statusText}</span></td>
              <td>{day(r.paymentDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function ExpensesPage() {
  return (
    <VendorShell moduleKey="expenses" title="Expenses" sub="What the company has booked against you, and whether it is paid.">
      <ListBody path="/expenses" empty="No expense entries yet" emptyText="When the company books a bill or expense against you it shows here, with its payment status." />
    </VendorShell>
  );
}
function ListBody({ path, empty, emptyText, extra }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { vendorApi.get(path).then((r) => { setD(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load this.'))); }, [path]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {!d ? <div className="empty-mini">Loading…</div> : (
        <>
          {extra && extra(d, load)}
          <div className="vp-tiles">
            <div className="vp-tile"><span>Billed (after TDS)</span><b>{inr(d.summary.invoiced)}</b></div>
            <div className="vp-tile green"><span>Paid to you</span><b>{inr(d.summary.paid)}</b></div>
            <div className="vp-tile orange"><span>Still to be paid</span><b>{inr(d.summary.outstanding)}</b></div>
          </div>
          {!d.rows.length ? <div className="vp-empty"><h3>{empty}</h3><p>{emptyText}</p></div> : <BillRows rows={d.rows} />}
        </>
      )}
    </>
  );
}

export function OfficePage() {
  return (
    <VendorShell moduleKey="office" title="Office" sub="Rent and office bills booked for your building, their payments, and your receipts.">
      <ListBody
        path="/office" empty="No office bills yet" emptyText="Rent and office bills booked by the company show here with their payment."
        extra={(d, reload) => <Receipts d={d} reload={reload} />}
      />
    </VendorShell>
  );
}
function Receipts({ d, reload }) {
  const me = useVendorMe();
  const readOnly = !!me.preview;
  const fileRef = useRef(null);
  const [remarks, setRemarks] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const idem = useRef(newKey());
  async function up(e) {
    e.preventDefault(); setErr(''); setMsg('');
    const file = fileRef.current?.files?.[0];
    if (!file) { setErr('Attach the receipt (PDF, JPG or PNG).'); return; }
    const fd = new FormData(); fd.append('file', file); fd.append('remarks', remarks);
    setBusy(true);
    try { const r = await vendorApi.post('/office/receipts', fd, { headers: { 'Idempotency-Key': idem.current } }); setMsg(r.data.message); setRemarks(''); if (fileRef.current) fileRef.current.value = ''; idem.current = newKey(); reload(); } catch (x) { setErr(vendorError(x, 'Could not send the receipt.')); } finally { setBusy(false); }
  }
  return (
    <section className="vm-block" style={{ marginBottom: 14 }}>
      <h4>Your receipts</h4>
      {d.canUpload && (
        <form onSubmit={up} noValidate className="vm-grid">
          <div><label htmlFor="rcFile">Receipt (PDF, JPG or PNG)</label><input id="rcFile" type="file" ref={fileRef} accept=".pdf,.jpg,.jpeg,.png" /></div>
          <div><label htmlFor="rcRem">Remark (optional)</label><input id="rcRem" value={remarks} maxLength={1000} onChange={(e) => setRemarks(e.target.value)} placeholder="e.g. October rent receipt" /></div>
          <div className="vm-row"><button type="submit" className="btn btn-primary" disabled={busy || readOnly}>{busy ? 'Sending…' : 'Upload receipt'}</button></div>
        </form>
      )}
      <div className="error-text" role="alert" aria-live="assertive">{err}</div>
      {msg && <div className="notice green" role="status"><span>{msg}</span></div>}
      {d.receipts.length ? d.receipts.map((r) => (
        <div key={r.id} className="vm-row"><span>{r.document?.name || r.billCode} · {day(r.createdAt)}{r.remarks ? ` · ${r.remarks}` : ''}</span><span className={`vp-tag vp-${r.status === 'Rejected' ? 'red' : 'green'}`}>{r.statusText}</span></div>
      )) : <div className="small-muted">No receipt uploaded yet.</div>}
    </section>
  );
}
