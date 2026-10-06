import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import Section from './Section.jsx';
import '../vendor/vendorPortal.css';
import './VendorBillsReview.css';

// ---------------------------------------------------------------------------
// OFFICE & ACCOUNTS → "BILLS FROM VENDORS" (P3, 2026-10-05).
// Bills vendors sent through the Vendor Portal. They are NOT expenses yet:
// Pending Review → (Verified) → Approved books ONE ordinary expense (Pending
// to pay) that then follows the normal Pending → Paid flow; Rejected keeps the
// reason, which the vendor sees. Inserted in pages/Office.jsx with one line.
// Hidden when no vendor ever sent a bill. Server: routes/vendorBills.js.
// ---------------------------------------------------------------------------
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const two = (n) => String(n).padStart(2, '0');
const day = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? String(s) : `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`;
};
const errText = (e, f) => (e?.response ? e.response.data?.error || f : 'Cannot reach the server. Try again.');
const TONE = { PENDING_REVIEW: 'yellow', VERIFIED: 'blue', APPROVED: 'green', PAID: 'green', REJECTED: 'red', WITHDRAWN: 'grey' };
const STATUS_ORDER = [['PENDING_REVIEW', 'Pending Review'], ['VERIFIED', 'Verified'], ['APPROVED', 'Approved'], ['PAID', 'Paid'], ['REJECTED', 'Rejected'], ['WITHDRAWN', 'Withdrawn']];

async function download(url, name) {
  const res = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = name || 'bill'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export default function VendorBillsReview({ onChanged }) {
  const [d, setD] = useState(null);
  const [status, setStatus] = useState('PENDING_REVIEW');
  const [vendorId, setVendorId] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.get('/vendor-bills', { params: { status: status || undefined, vendorId: vendorId || undefined, q: q || undefined } })
      .then((r) => { setD(r.data); setErr(''); })
      .catch((e) => { if (e.response?.status !== 403) setErr(errText(e, 'Could not load the vendor bills.')); });
  }, [status, vendorId, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (!msg) return undefined; const t = setTimeout(() => setMsg(''), 4000); return () => clearTimeout(t); }, [msg]);

  if (!d) return null;
  const total = Object.values(d.counts || {}).reduce((s, n) => s + n, 0);
  if (!total) return null; // no vendor has sent a bill yet: nothing to show
  const waiting = d.pending ?? ((d.counts.PENDING_REVIEW || 0) + (d.counts.VERIFIED || 0));
  const statusCount = Object.fromEntries((d.facets.status || []).map((x) => [x.value, x.count]));

  return (
    <Section
      id="vendorbills"
      title="Bills from vendors"
      info="Bills vendors sent from the Vendor Portal. They are not in any total until you approve them. Approve books the bill as an expense (Pending to pay); Reject sends your reason back to the vendor."
      sub={waiting ? <><span className="vb-badge">{waiting}</span> waiting for your check</> : 'Nothing waiting — every bill is checked'}
      right={d.access?.canManageLogins ? <Link className="btn btn-sm" to="/admin/vendor-logins">Vendor logins</Link> : null}
    >
      {msg && <div className="notice green" style={{ marginBottom: 8 }}><span>{msg}</span></div>}
      {err && <div className="notice red" style={{ marginBottom: 8 }}><span>{err}</span></div>}
      <div className="vb-bar">
        <div className="vb-status">
          {STATUS_ORDER.map(([k, label]) => (
            <button type="button" key={k} className={`vb-chip vb-${TONE[k]}${status === k ? ' on' : ''}`} onClick={() => setStatus(status === k ? '' : k)}>
              {label} <b>{statusCount[k] || 0}</b>
            </button>
          ))}
        </div>
        <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} aria-label="Vendor">
          <option value="">All vendors</option>
          {(d.facets.vendor || []).map((v) => <option key={v.value} value={v.value}>{v.label} ({v.count})</option>)}
        </select>
        <input type="search" placeholder="Search bill no., asset, vendor" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search vendor bills" />
      </div>
      {!d.rows.length ? (
        <div className="empty-mini">{status ? `No bills are ${STATUS_ORDER.find(([k]) => k === status)?.[1].toLowerCase()} right now.` : 'No bill matches.'}</div>
      ) : (
        <div className="tbl-wrap vb-table">
          <table>
            <thead>
              <tr>
                <th>Bill no.</th><th>Vendor</th><th>Asset</th><th>Bill date</th>
                <th className="num">Amount</th><th className="num">GST</th><th className="num">TDS</th><th className="num">Total</th>
                <th>Document</th><th>Sent by</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {d.rows.map((b) => (
                <tr key={b.id}>
                  <td className="vb-nowrap"><strong>{b.billNumber}</strong><div className="cell-muted">{b.billCode}{b.version > 1 ? ` · v${b.version}` : ''}</div><span className="vb-src">{b.source}</span></td>
                  <td>{b.vendorName}</td>
                  <td>{b.assetCode}<div className="cell-muted">{b.assetName}</div></td>
                  <td>{day(b.billDate)}</td>
                  <td className="num">{inr(b.amount)}</td>
                  <td className="num">{inr(b.gst)}</td>
                  <td className="num">{b.tds ? inr(b.tds) : '—'}</td>
                  <td className="num"><strong>{inr(b.total)}</strong>{b.originalValues && <div className="cell-muted" title="Changed by Accounts; the vendor's figures are kept">edited</div>}</td>
                  <td>{b.document ? <button type="button" className="link-btn" onClick={() => download(`/vendor-bills/${b.id}/document`, b.document.name).catch((e) => setErr(errText(e, 'Could not download.')))}>Open</button> : '—'}</td>
                  <td>{b.submittedBy}<div className="cell-muted">{day(b.submittedAt)}</div></td>
                  <td><span className={`vp-tag vp-${TONE[b.status]}`}>{b.statusText}</span>{b.expenseCode && <div className="cell-muted">{b.expenseCode}</div>}</td>
                  <td><button type="button" className="btn btn-sm" onClick={() => setOpen(b)}>{['PENDING_REVIEW', 'VERIFIED'].includes(b.status) && d.access?.canReview ? 'Check' : 'View'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <BillReview
          bill={open}
          access={d.access || {}}
          onClose={() => setOpen(null)}
          onDone={(m, booked) => { setOpen(null); setMsg(m); load(); if (booked && onChanged) onChanged(); }}
        />
      )}
    </Section>
  );
}

const MODES = ['Bank Transfer', 'UPI', 'Cash', 'Credit Card', 'Debit Card', 'Cheque', 'Other'];

function BillReview({ bill, access, onClose, onDone }) {
  const isOpen = ['PENDING_REVIEW', 'VERIFIED'].includes(bill.status);
  const [b, setB] = useState(bill);
  const [step, setStep] = useState(''); // '' | approve | reject | edit
  const [cats, setCats] = useState([]);
  const [ap, setAp] = useState({ category: '', paymentMode: 'Bank Transfer', dueDate: '', remarks: bill.reviewRemarks || '' });
  const [reason, setReason] = useState('');
  const [ed, setEd] = useState({ billNumber: bill.billNumber, billDate: bill.billDate, amount: bill.amount, gst: bill.gst, tds: bill.tds });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (step !== 'approve' || cats.length) return;
    api.get('/office-expenses/categories').then((r) => {
      const list = (r.data || []).map((c) => c.name);
      setCats(list);
      const guess = list.find((n) => /repair|maint/i.test(n)) || list.find((n) => /asset/i.test(n)) || '';
      setAp((x) => ({ ...x, category: x.category || guess }));
    }).catch(() => {});
  }, [step, cats.length]);

  async function act(path, body, booked) {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/vendor-bills/${b.id}/${path}`, body);
      onDone(r.data.message, booked);
    } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  async function saveEdit() {
    setBusy(true); setError('');
    try {
      const r = await api.patch(`/vendor-bills/${b.id}`, ed);
      setB(r.data.bill); setStep('');
    } catch (e) { setError(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }

  let foot;
  if (step === 'approve') {
    foot = (<><button type="button" className="btn" onClick={() => setStep('')}>Back</button><button type="button" className="btn btn-primary" disabled={busy || !ap.category} onClick={() => act('approve', ap, true)}>{busy ? 'Approving…' : 'Approve and book'}</button></>);
  } else if (step === 'reject') {
    foot = (<><button type="button" className="btn" onClick={() => setStep('')}>Back</button><button type="button" className="btn btn-danger" disabled={busy || reason.trim().length < 3} onClick={() => act('reject', { reason })}>{busy ? 'Rejecting…' : 'Reject bill'}</button></>);
  } else if (step === 'edit') {
    foot = (<><button type="button" className="btn" onClick={() => setStep('')}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={saveEdit}>Save</button></>);
  } else if (isOpen && access.canReview) {
    foot = (
      <>
        {access.canEdit && <button type="button" className="btn" onClick={() => setStep('edit')}>Fix amounts</button>}
        {b.status === 'PENDING_REVIEW' && <button type="button" className="btn" disabled={busy} onClick={() => act('verify', {})}>Mark verified</button>}
        <button type="button" className="btn btn-danger" onClick={() => setStep('reject')}>Reject</button>
        <button type="button" className="btn btn-primary" onClick={() => setStep('approve')}>Approve</button>
      </>
    );
  } else {
    foot = <button type="button" className="btn" onClick={onClose}>Close</button>;
  }

  return (
    <Modal title={`Vendor bill ${b.billNumber}`} note={`${b.billCode} · Source: Vendor Portal`} size="wide" onClose={onClose} footer={foot}>
      <div className="vb-detail">
        <dl className="vp-dl">
          <dt>Vendor</dt><dd>{b.vendorName}</dd>
          <dt>Asset</dt><dd>{b.assetCode} · {b.assetName}</dd>
          <dt>Bill date</dt><dd>{day(b.billDate)}</dd>
          <dt>Amount before GST</dt><dd>{inr(b.amount)}</dd>
          <dt>GST</dt><dd>{inr(b.gst)}</dd>
          <dt>After GST</dt><dd>{inr(b.afterGst)}</dd>
          <dt>TDS we cut</dt><dd>{b.tds ? inr(b.tds) : '—'}</dd>
          <dt>To pay the vendor</dt><dd><strong>{inr(b.total)}</strong> <span className="cell-muted">(amount + GST − TDS)</span></dd>
          <dt>Vendor's remarks</dt><dd className="vp-pre">{b.remarks || '—'}</dd>
          <dt>Sent by</dt><dd>{b.submittedBy} · {day(b.submittedAt)}</dd>
          <dt>Status</dt><dd><span className={`vp-tag vp-${TONE[b.status]}`}>{b.statusText}</span>{b.reviewedByName ? ` by ${b.reviewedByName} · ${day(b.reviewedAt)}` : ''}{b.expenseStatus && b.status === 'APPROVED' ? ' · not paid yet' : ''}</dd>
          {b.rejectionReason && <><dt>Why rejected</dt><dd className="vb-red">{b.rejectionReason}</dd></>}
          {b.withdrawnAt && <><dt>Withdrawn</dt><dd>by the vendor · {day(b.withdrawnAt)}</dd></>}
          {b.parentSubmissionId && <><dt>Version</dt><dd>{b.version} — a corrected bill after a rejection</dd></>}
          {b.originalValues && <><dt>Vendor's own figures</dt><dd className="cell-muted">Bill {b.originalValues.billNumber} · {day(b.originalValues.billDate)} · {inr(b.originalValues.amount)} + GST {inr(b.originalValues.gst)} − TDS {inr(b.originalValues.tds)} = {inr(b.originalValues.total)} (kept; your edits are in the audit)</dd></>}
          {b.expenseCode && <><dt>Booked as</dt><dd>{b.expenseCode} (in Expenses &amp; Bills)</dd></>}
          <dt>Files</dt>
          <dd className="vb-files">
            {b.document && <button type="button" className="link-btn" onClick={() => download(`/vendor-bills/${b.id}/document`, b.document.name)}>Bill: {b.document.name}</button>}
            {b.supporting.map((s) => <button type="button" key={s.index} className="link-btn" onClick={() => download(`/vendor-bills/${b.id}/supporting/${s.index}`, s.name)}>{s.name}</button>)}
          </dd>
        </dl>

        {step === 'approve' && (
          <div className="vp-form vb-step">
            <div className="small-muted">Approving books this bill as an expense, <strong>Pending to pay</strong>. Then mark it paid as usual.</div>
            <div className="vp-two">
              <div>
                <label htmlFor="vbC">Category</label>
                <select id="vbC" value={ap.category} onChange={(e) => setAp({ ...ap, category: e.target.value })}>
                  <option value="">Pick…</option>
                  {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="vbM">Payment mode</label>
                <select id="vbM" value={ap.paymentMode} onChange={(e) => setAp({ ...ap, paymentMode: e.target.value })}>
                  {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <label htmlFor="vbD">Pay by (optional)</label>
            <input id="vbD" type="date" value={ap.dueDate} onChange={(e) => setAp({ ...ap, dueDate: e.target.value })} />
            <label htmlFor="vbR">Remarks (optional)</label>
            <textarea id="vbR" rows={2} value={ap.remarks} onChange={(e) => setAp({ ...ap, remarks: e.target.value })} />
          </div>
        )}
        {step === 'reject' && (
          <div className="vp-form vb-step">
            <label htmlFor="vbX">Why is it rejected? The vendor will see this.</label>
            <textarea id="vbX" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. GST number missing on the bill" />
          </div>
        )}
        {step === 'edit' && (
          <div className="vp-form vb-step">
            <div className="vp-two">
              <div><label htmlFor="vbN">Bill no.</label><input id="vbN" value={ed.billNumber} onChange={(e) => setEd({ ...ed, billNumber: e.target.value })} /></div>
              <div><label htmlFor="vbBD">Bill date</label><input id="vbBD" type="date" value={ed.billDate} onChange={(e) => setEd({ ...ed, billDate: e.target.value })} /></div>
            </div>
            <div className="vp-three">
              <div><label htmlFor="vbA">Amount before GST</label><input id="vbA" inputMode="decimal" value={ed.amount} onChange={(e) => setEd({ ...ed, amount: e.target.value })} /></div>
              <div><label htmlFor="vbG">GST</label><input id="vbG" inputMode="decimal" value={ed.gst} onChange={(e) => setEd({ ...ed, gst: e.target.value })} /></div>
              <div><label htmlFor="vbT">TDS</label><input id="vbT" inputMode="decimal" value={ed.tds} onChange={(e) => setEd({ ...ed, tds: e.target.value })} /></div>
            </div>
          </div>
        )}
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </Modal>
  );
}
