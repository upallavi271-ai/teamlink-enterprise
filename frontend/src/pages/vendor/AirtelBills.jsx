import { useCallback, useEffect, useState } from 'react';
import VendorBankPayments from './VendorBankPayments.jsx'; // payments from the bank statement (founder 2026-10-28)
import { useSearchParams } from 'react-router-dom';
import vendorApi, { vendorError } from '../../vendorApi';
import Modal from '../../components/Modal.jsx';
import VendorShell, { openVendorFile, useVendorMe } from './VendorShell.jsx';
import VendorPager from './VendorPager.jsx';
import { day, newKey } from './vendorFormat.js';
import { VendorIoBar } from './VendorIo.jsx';
import {
  AirTag, AirLine, AlertBanner, NotRecorded, val, money, dateOr, monthText, STATUS_HELP, rs,
} from './airtelCommon.jsx';
import './vendorModules.css';

// /vendor/airtel-portal/bills - Bills of the Airtel Bills Portal. The vendor's Airtel bills as Accounts holds them (plus a bill the vendor sent
// that Accounts has not booked yet), with the payment status DERIVED by the server from Accounts and the bank statement: Pending, Paid (the bank
// payment is matched to the bill), Paid by Accounts, Partially Paid, Overdue, Reversed. It cannot be changed here. "Not recorded" means the
// company's records do not hold that fact: nothing is guessed. The only thing a login may do is send a bill (when the company switched it on).
const SORTS = [['billDate', 'Bill date'], ['dueDate', 'Due date'], ['total', 'Amount'], ['balance', 'Still to pay'], ['status', 'Status'], ['invoiceNo', 'Invoice number']];

export default function AirtelBills() {
  return (
    <VendorShell title="Bills" sub="Your Airtel bills, when they are due and whether Accounts has paid them.">
      <Body />
      <VendorBankPayments />
    </VendorShell>
  );
}

function Body() {
  const me = useVendorMe();
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [ov, setOv] = useState(null);
  const [f, setF] = useState({ q: params.get('q') || '', status: params.get('status') || '', period: '', sim: '', sort: 'billDate', dir: 'desc', page: 1 });
  const [qDeb, setQDeb] = useState(params.get('q') || '');
  const [simDeb, setSimDeb] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => { const t = setTimeout(() => setQDeb(f.q), 250); return () => clearTimeout(t); }, [f.q]);
  useEffect(() => { const t = setTimeout(() => setSimDeb(f.sim), 350); return () => clearTimeout(t); }, [f.sim]);
  const load = useCallback(() => {
    vendorApi.get('/airtel-portal/bills', { params: { q: qDeb || undefined, status: f.status || undefined, period: f.period || undefined, sim: simDeb || undefined, sort: f.sort, dir: f.dir, page: f.page } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load your bills.')));
    vendorApi.get('/airtel-portal/overview').then((r) => setOv(r.data)).catch(() => {});
  }, [qDeb, simDeb, f.status, f.period, f.sort, f.dir, f.page]);
  useEffect(() => { load(); }, [load]);
  const set = (patch) => setF((x) => ({ ...x, page: 1, ...patch }));
  const rows = data?.rows || [];
  const filtered = !!(f.q || f.status || f.period || f.sim);
  const s = data?.summary;
  const b = ov?.bills;
  return (
    <>
      {toast && <div className="notice green" style={{ marginBottom: 10 }}><span>{toast}</span></div>}
      {error && <div className="notice red" style={{ marginBottom: 10 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      <AlertBanner alerts={ov?.alerts} onOpen={(key) => setOpen(key)} />
      {s && (
        <div className="vp-tiles">
          <div className="vp-tile"><span>Bills in Accounts</span><b>{s.count}</b></div>
          <div className="vp-tile orange"><span>Still to be paid</span><b>{rs(s.outstanding)}</b></div>
          <div className="vp-tile green"><span>Paid so far</span><b>{rs(s.paid)}</b></div>
          <div className="vp-tile"><span>Overdue</span><b>{b ? b.overdue : '-'}</b></div>
          <div className="vp-tile"><span>Due in 7 days</span><b>{b ? b.dueSoon : '-'}</b></div>
        </div>
      )}
      <VendorIoBar list="bills" params={{ ...f, q: qDeb, sim: simDeb }} importKey="bills" onImported={load} />
      <div className="vp-filters" role="search">
        <input className="vp-search" type="search" placeholder="Search invoice number, Accounts reference or SIM number" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        <select aria-label="Payment status" value={f.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">Any payment status</option>
          {(data?.facets.status || []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
        </select>
        <select aria-label="Bill month" value={f.period} onChange={(e) => set({ period: e.target.value })}>
          <option value="">Any bill month</option>
          {(data?.facets.month || []).map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
        </select>
        <input type="search" placeholder="One SIM: number or SIM ID" value={f.sim} onChange={(e) => set({ sim: e.target.value })} aria-label="One SIM (10-digit number or SIM ID)" style={{ maxWidth: 210 }} />
        <select aria-label="Sort by" value={f.sort} onChange={(e) => set({ sort: e.target.value })}>{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
        <button type="button" className="btn btn-sm" onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}>{f.dir === 'asc' ? 'Oldest first' : 'Newest first'}</button>
        {filtered && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setF({ q: '', status: '', period: '', sim: '', sort: 'billDate', dir: 'desc', page: 1 })}>Clear</button>}
        {data?.canSend && !me?.preview && <button type="button" className="btn btn-primary btn-sm" onClick={() => setSending(true)}>Send a bill</button>}
      </div>
      {data?.simFilterNote && <p className="abp-note">{data.simFilterNote}</p>}
      {data?.numberNote && <p className="abp-note" role="status">{data.numberNote}</p>}
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty">{data.all ? <><h3>No bill matches</h3><p>Clear the search to see all {data.all}.</p></> : <><h3>No bills yet</h3><p>When Accounts records your Airtel bill, it shows here.</p></>}</div>
      ) : (
        <>
          <div className="tbl-wrap vp-scroll">
            <table>
              <thead><tr><th>Invoice number</th><th>Bill date</th><th>Bill month</th><th>Due date</th><th className="num">Total payable</th><th>Payment</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="vp-row-click" onClick={() => setOpen(r.key)}>
                    <td className="abp-inv"><strong>{r.invoiceNo || <NotRecorded />}</strong>{r.accountsRef ? <div className="cell-muted">{r.accountsRef}</div> : (r.billCode ? <div className="cell-muted">{r.billCode}</div> : null)}{r.source === 'Sent by you' ? <div className="cell-muted">Sent by you</div> : null}{r.duplicateOf ? <div className="vp-why">Same as {r.duplicateOf}</div> : null}</td>
                    <td>{dateOr(r.billDate)}</td>
                    <td>{r.billMonth ? monthText(r.billMonth) : <NotRecorded />}</td>
                    <td>{dateOr(r.dueDate)}</td>
                    <td className="num"><strong>{rs(r.payable)}</strong></td>
                    <td className="abp-wrap-cell"><AirTag pay={r.payment} /><div><AirLine pay={r.payment} /></div></td>
                    <td><button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(r.key); }}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <VendorPager data={data} onPage={(page) => setF((x) => ({ ...x, page }))} />
        </>
      )}
      {open && <BillDetail bkey={open} onClose={() => setOpen(null)} />}
      {sending && <SendBill onClose={() => setSending(false)} onSent={(msg) => { setSending(false); setToast(msg); load(); }} />}
    </>
  );
}

function BillDetail({ bkey, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { vendorApi.get(`/airtel-portal/bills/${encodeURIComponent(bkey)}`).then((r) => setD(r.data)).catch((e) => setError(vendorError(e, 'Could not open this bill.'))); }, [bkey]);
  const r = d?.bill;
  const p = r?.payment;
  return (
    <Modal title={r ? `Bill ${r.invoiceNo || '(no number recorded)'}` : 'Bill'} size="wide" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      {!d && !error && <div className="empty-mini">Loading&hellip;</div>}
      {r && (
        <div className="vp-detail">
          <div style={{ marginBottom: 8 }}><AirTag pay={p} /> <span className="cell-muted abp-wrap">{p.note || STATUS_HELP[p.status]}</span></div>
          <h4 className="vm-h3">The bill</h4>
          <dl>
            <dt>Provider</dt><dd>{r.provider}</dd>
            <dt>Invoice number</dt><dd>{val(r.invoiceNo)}</dd>
            <dt>Accounts reference</dt><dd>{val(r.accountsRef)}</dd>
            {r.billCode ? (<><dt>Your bill code</dt><dd>{r.billCode}</dd></>) : null}
            <dt>Billing period</dt><dd>{r.period ? monthText(r.period) : <NotRecorded />}</dd>
            <dt>Bill month</dt><dd>{r.billMonth ? <>{monthText(r.billMonth)} <span className="cell-muted">(from the {r.billMonthFrom})</span></> : <NotRecorded />}</dd>
            <dt>Bill date</dt><dd>{dateOr(r.billDate)}</dd>
            <dt>Due date</dt><dd>{dateOr(r.dueDate)}</dd>
            <dt>Number of SIMs on the bill</dt><dd>{r.simCount ? r.simCount : <NotRecorded />}</dd>
            <dt>Where it is held</dt><dd>{r.source === 'Accounts' ? 'Accounts has this bill' : 'You sent this bill. Accounts has not booked it yet.'}</dd>
          </dl>
          <h4 className="vm-h3">The money</h4>
          <dl>
            <dt>Amount before tax</dt><dd>{money(r.amount)}</dd>
            <dt>Tax (GST)</dt><dd>{money(r.tax)}</dd>
            <dt>Additional charges</dt><dd>{money(r.additionalCharges)}</dd>
            <dt>Total of the bill</dt><dd>{rs(r.total)}</dd>
            {r.tds > 0 ? (<><dt>Tax cut at source</dt><dd>{rs(r.tds)}</dd></>) : null}
            <dt>Total payable</dt><dd><strong>{rs(r.payable)}</strong></dd>
          </dl>
          <h4 className="vm-h3">The payment</h4>
          <dl>
            <dt>Payment status</dt><dd><AirTag pay={p} /></dd>
            <dt>Paid</dt><dd>{rs(p.paidAmount)}</dd>
            <dt>Still to pay</dt><dd>{rs(p.balance)}</dd>
            <dt>Payment date</dt><dd>{p.paymentDate ? <>{day(p.paymentDate)} {p.verified ? <span className="cell-muted">(confirmed by the bank statement)</span> : null}</> : <NotRecorded />}</dd>
            <dt>Payment reference</dt><dd>{p.reference ? <>{p.reference} <span className="cell-muted">(only the last 4 characters are shown)</span></> : <NotRecorded />}</dd>
          </dl>
          {r.lines && r.lines.length > 0 && (
            <>
              <h4 className="vm-h3">Charges per number</h4>
              <div className="tbl-wrap vp-scroll"><table>
                <thead><tr><th>Number</th><th>What</th><th className="num">Amount</th></tr></thead>
                <tbody>{r.lines.map((l, i) => <tr key={i}><td>{l.number || <NotRecorded />}{l.simRef ? <div className="cell-muted">{l.simRef}</div> : null}</td><td className="abp-wrap-cell">{val(l.description)}</td><td className="num">{money(l.amount)}</td></tr>)}</tbody>
              </table></div>
            </>
          )}
          {r.remarks ? (<><h4 className="vm-h3">Your note</h4><p className="abp-wrap">{r.remarks}</p></>) : null}
          <h4 className="vm-h3">Bill copy</h4>
          {r.hasDocument
            ? <button type="button" className="btn btn-sm" onClick={() => openVendorFile({ kind: 'airtel-bill', id: r.key }).catch((e) => setError(vendorError(e, 'Could not open the file.')))}>Open the bill copy</button>
            : <NotRecorded />}
          <h4 className="vm-h3">What happened to this bill</h4>
          {!d.history.length ? <div className="vp-none">Nothing has been recorded yet.</div> : (
            <ul className="vm-hist">{d.history.map((h, i) => <li key={i}><strong>{h.by}</strong> {h.what} <span className="cell-muted">&middot; {day(String(h.at).slice(0, 10))}</span></li>)}</ul>
          )}
        </div>
      )}
    </Modal>
  );
}

// SEND A BILL: the company's existing monthly-bill upload. It does not mark anything paid and does not create an expense: Accounts checks it and books it.
function SendBill({ onClose, onSent }) {
  const [v, setV] = useState({ billNumber: '', period: new Date().toISOString().slice(0, 7), billDate: '', dueDate: '', amount: '', gst: '', remarks: '' });
  const [perNumber, setPerNumber] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(() => newKey().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60).padEnd(10, 'x'));
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));
  async function send() {
    setError('');
    if (!file) { setError('Choose the bill file (PDF, JPG or PNG).'); return; }
    // optional list, one SIM per line: "9876543210  450.00" (the number, then the charge). It links the bill to those SIMs.
    const lines = [];
    for (const raw of perNumber.split('\n').map((x) => x.trim()).filter(Boolean)) {
      const parts = raw.split(/[\s,;]+/).filter(Boolean);
      const num = (parts[0] || '').replace(/\D/g, '');
      const amt = Number((parts[parts.length - 1] || '').replace(/,/g, ''));
      if (num.length < 10 || parts.length < 2 || !Number.isFinite(amt) || amt < 0) { setError(`Check this line: "${raw}". Write the 10-digit number, a space, then the charge.`); return; }
      lines.push({ number: num.slice(-10), amount: amt });
    }
    const fd = new FormData();
    if (lines.length) fd.append('lines', JSON.stringify(lines));
    Object.entries(v).forEach(([k, x]) => { if (String(x).trim() !== '') fd.append(k, x); });
    fd.append('file', file);
    setBusy(true);
    try {
      const r = await vendorApi.post('/airtel-portal/bills', fd, { headers: { 'Idempotency-Key': key } });
      onSent(r.data.message || 'Sent. Accounts will check it.');
    } catch (e) { setError(vendorError(e, 'Could not send the bill.')); } finally { setBusy(false); }
  }
  return (
    <Modal title="Send a bill" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={send}>{busy ? 'Sending...' : 'Send the bill'}</button></>}>
      <p className="abp-note">Accounts will check your bill and pay it. Sending a bill does not mark it paid. If Accounts already has this bill, you will be told.</p>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error}</span></div>}
      <div className="abp-form">
        <div className="abp-row2">
          <label>Bill number<input type="text" value={v.billNumber} maxLength={60} onChange={set('billNumber')} /></label>
          <label>Bill month<input type="month" value={v.period} onChange={set('period')} /></label>
        </div>
        <div className="abp-row2">
          <label>Bill date<input type="date" value={v.billDate} max={new Date().toISOString().slice(0, 10)} onChange={set('billDate')} /></label>
          <label>Due date<input type="date" value={v.dueDate} onChange={set('dueDate')} /></label>
        </div>
        <div className="abp-row2">
          <label>Amount before GST (rupees)<input type="number" min="0" step="0.01" value={v.amount} onChange={set('amount')} /></label>
          <label>GST (rupees)<input type="number" min="0" step="0.01" value={v.gst} onChange={set('gst')} /></label>
        </div>
        <label>Charge for each SIM (optional): one SIM on each line, the number then the charge<textarea rows={3} placeholder={'9876543210 450.00\n9876543211 399.00'} value={perNumber} onChange={(e) => setPerNumber(e.target.value)} /></label>
        <label>Note (optional)<textarea rows={2} maxLength={1000} value={v.remarks} onChange={set('remarks')} /></label>
        <label>Bill file<input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files && e.target.files[0])} /></label>
      </div>
    </Modal>
  );
}
