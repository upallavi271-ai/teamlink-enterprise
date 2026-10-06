import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import {
  statusClass, money, money2, fmtD, Stat, invoiceDocumentHtml,
} from './Invoices.jsx';
import { canManageAccounts, can } from '../permissions';
import Combo from '../components/Combo.jsx';
import ClientAccountModal from './invoices/ClientAccountModal.jsx';
// P4 — GST & TDS: the invoice summary block and its edit form.
import TaxEditModal from './invoices/TaxEditModal.jsx';
import {
  pct as pctTxt, gstSplitText, GST_TYPE_FROM, tdsStatusClass,
} from './invoices/invTax';
import './invoices/invTax.css';
// B2 — credit / debit notes on this invoice, and its placement margin.
import NoteModal, { openNotePdf } from './invoices/NoteModal.jsx';
import { CancelNote, RefundPaid } from './invoices/CreditNotesPanel.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthOf = (d) => (d ? `${MONTHS[Number(String(d).slice(5, 7)) - 1]} ${String(d).slice(0, 4)}` : '—');

const PAY_METHODS = ['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Other'];

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The email / WhatsApp text the application writes for you.
function invoiceMessage(d, invoice, user) {
  const who = invoice.client?.contactName || invoice.client?.name || 'Sir / Madam';
  const co = d.company;
  const lines = d.lines.map((l) => `• ${l.description} — ${money2(l.rate)}`).join('\n');
  const bank = [
    co.bank.accountName && `Account name: ${co.bank.accountName}`,
    co.bank.bankName && `Bank: ${co.bank.bankName}${co.bank.branch ? `, ${co.bank.branch}` : ''}`,
    co.bank.accountNumber && `A/c no: ${co.bank.accountNumber}`,
    co.bank.ifsc && `IFSC: ${co.bank.ifsc}`,
  ].filter(Boolean).join('\n');
  const subject = `Invoice ${d.invoiceNumber} — ${co.legalName} — ${money2(d.totals.receivable)}`;
  const body = `Dear ${who},

Please find our invoice for the recruitment services rendered.

Invoice no   : ${d.invoiceNumber}
Invoice date : ${fmtD(d.invoiceDate)}
Due date     : ${d.dueDate ? fmtD(d.dueDate) : 'On presentation'}
Candidate(s) :
${lines}

Taxable value    : ${money2(d.totals.subTotal)}
GST              : ${d.totals.gst > 0 ? money2(d.totals.gst) : 'Not applicable'}
Invoice value    : ${money2(d.totals.invoiceValue)}
${d.totals.tds > 0 ? `Less TDS @ ${d.tdsPct}% : ${money2(d.totals.tds)}\n` : ''}Amount receivable: ${money2(d.totals.receivable)}
${d.totals.paid > 0 ? `Received to date : ${money2(d.totals.paid)}\nBalance due      : ${money2(d.totals.balance)}\n` : ''}
${bank ? `Payment details:\n${bank}\n\n` : ''}The signed invoice copy is attached. Kindly confirm receipt and share Form 16A after TDS deduction.

Thank you for your continued association.

Regards,
${user?.name || 'Accounts'}
${co.legalName}`;
  return { subject, body };
}

export default function InvoiceDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canManage = canManageAccounts(user);
  const canEditTax = can(user, 'accounts', 'accounts', 'Invoices', 'edit');
  const [editTax, setEditTax] = useState(false);
  const [saidTax, setSaidTax] = useState('');
  const [invoice, setInvoice] = useState(null);
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null); // 'client' | 'internal'
  const [send, setSend] = useState(null);
  const [showAccount, setShowAccount] = useState(false);
  const canNote = can(user, 'accounts', 'accounts', 'Invoices', 'create');
  const [noteFor, setNoteFor] = useState(null); // null | { kind } | { draft }
  const [cancelNote, setCancelNote] = useState(null);
  const [refundNote, setRefundNote] = useState(null);
  const [saidNote, setSaidNote] = useState('');
  const [form, setForm] = useState({
    amount: '', date: today(), method: 'Bank Transfer', reference: '', notes: '',
  });

  const location = useLocation();
  const load = useCallback(() => {
    api.get(`/invoices/${id}`).then((res) => setInvoice(res.data))
      .catch((e) => setError(e.response?.data?.error || 'This invoice could not be loaded.'));
    api.get(`/invoices/${id}/document`).then((res) => setDoc(res.data)).catch(() => setDoc(null));
  }, [id]);
  useEffect(load, [load]);
  // /invoices/:id#proof and #tds (the register's Proof and TDS Cert links)
  // land on their own section once the invoice has loaded.
  const loaded = !!invoice;
  useEffect(() => {
    if (!loaded || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }, [loaded, location.hash]);

  // The Form 16A file — upload, view (fetched with the login's token), remove.
  const uploadTdsCert = (file) => run(async () => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) throw new Error('That file is larger than 5MB.');
    const fd = new FormData();
    fd.append('file', file);
    await api.post(`/invoices/${id}/tds-certificate/file`, fd);
  });
  const viewTdsCert = async () => {
    try {
      const res = await api.get(`/invoices/${id}/tds-certificate/file`, { params: { inline: 1 }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      setError('The TDS certificate file could not be opened.');
    }
  };

  async function run(fn) {
    setError('');
    try {
      await fn();
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'That did not work.');
    }
  }

  const addPayment = (e) => {
    e.preventDefault();
    run(async () => {
      await api.post(`/invoices/${id}/payments`, { ...form, amount: Number(form.amount) });
      setForm({ amount: '', date: today(), method: 'Bank Transfer', reference: '', notes: '' });
    });
  };

  if (!invoice) {
    return error
      ? <div><Link className="small-muted" to="/invoices">← Back to invoices</Link><div className="notice red" style={{ marginTop: 10 }}><span>{error}</span></div></div>
      : <div className="small-muted">Loading…</div>;
  }

  const payments = invoice.payments || [];
  const billing = Number(invoice.amount || 0);
  const gst = Number(invoice.gst || 0);
  const tds = Number(invoice.tds || 0);
  const invoiceValue = billing + gst;
  const receivable = Number(invoice.total || 0);
  const received = Number(invoice.receivedAmount || 0);
  const pending = Number(invoice.outstanding || 0);
  const pct = receivable ? Math.round((received / receivable) * 100) : 0;
  const gstPct = invoice.gstPercent ?? invoice.client?.gstPercent ?? null;
  const tdsPct = invoice.tdsPercent ?? invoice.client?.tdsPercent ?? null;
  const modes = [...new Set(payments.map((p) => p.method || '—'))];
  const noProof = payments.filter((p) => !p.reference);
  const proofLines = invoice.proofLines || [];
  // Where the invoice stands by what has been matched against it.
  const settleWord = invoice.status === 'Cancelled' ? 'Cancelled'
    : pending <= 0.5 ? 'Settled' : (received > 0 ? 'Partially paid' : 'Pending');
  const settleTone = settleWord === 'Settled' ? 'priority-low' : settleWord === 'Partially paid' ? 'priority-medium' : '';

  const printDoc = (mode) => {
    if (!doc) return;
    const { style, inner } = invoiceDocumentHtml(doc, mode);
    const w = window.open('', '_blank');
    if (!w) { setError('Allow pop-ups to print'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.invoiceNumber)} — ${esc(doc.client.name)}</title><style>${style}</style></head><body>${inner}</body></html>`);
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch { /* blocked */ } }, 450);
  };

  const msg = doc ? invoiceMessage(doc, invoice, user) : { subject: '', body: '' };
  // P4 — the GST / TDS reading (older servers without it fall back to the stored figures).
  const tax = invoice.tax || null;
  const tx = tax || {
    base: billing, gst, gross: invoiceValue, tds, net: receivable, received, balance: pending, gstApplicable: gst > 0.005, gstPercent: gstPct || 0, gstTypeLabel: '', gstType: 'CGST_SGST', cgstPercent: (gstPct || 0) / 2, sgstPercent: (gstPct || 0) / 2, cgst: Math.round((gst / 2) * 100) / 100, sgst: Math.round((gst - Math.round((gst / 2) * 100) / 100) * 100) / 100, tdsApplicable: tds > 0.005, tdsPercent: tdsPct || 0, tdsBase: 'base', tdsStatus: tds > 0.5 ? 'Pending' : 'Not Applicable',
  };

  return (
    <div>
      <Link className="small-muted" to="/invoices">← Back to invoices</Link>
      <div className="page-head" style={{ marginTop: 10 }}>
        <div>
          <h1>Invoice {invoice.invoiceNumber || invoice.id.slice(-6)}</h1>
          <div className="page-sub">
            {invoice.client?.name} · raised {fmtD(invoice.invoiceDate)}
            {invoice.dueDate ? ` · due ${fmtD(invoice.dueDate)}` : ''} · {invoice.candidate ? 1 : 0} candidate(s)
          </div>
        </div>
        <div className="qa-row">
          {invoice.clientId && <button type="button" className="btn btn-sm" onClick={() => setShowAccount(true)}>Client account</button>}
          <button className="btn btn-sm" onClick={() => setPreview('client')} disabled={!doc}>👁 View invoice</button>
          {canManage && <button className="btn btn-sm" onClick={() => setSend('email')} disabled={!doc}>✉ Send invoice</button>}
        </div>
      </div>

      {error && <div className="card section error-text" style={{ marginBottom: 12 }}>{error}</div>}

      {/* The invoice account, exactly as the accounting application opens it. */}
      <div className="statbar">
        <Stat n={money(invoiceValue)} l="Invoice amount" s="After GST — what was billed" />
        <Stat n={money(received)} l="Total received" s={`${payments.length} payment${payments.length === 1 ? '' : 's'}`} tone="good" />
        <Stat n={money(pending)} l="Remaining" s={pending > 0.5 ? 'Still to come' : 'Fully settled'} tone={pending > 0.5 ? 'bad' : 'good'} />
        <Stat n={invoice.status} l="Status" s={`${pct}% collected`} tone={invoice.status === 'Paid' ? 'good' : (invoice.status === 'Overdue' ? 'bad' : undefined)} />
      </div>

      {saidTax && <div className="notice" role="status" style={{ marginBottom: 12 }}><span>{saidTax}</span></div>}
      <div className="grid-2">
        {/* P4 — THE INVOICE SUMMARY: every step of the calculation on its own
            line, from the stored figures (utils/invoiceTax.js taxView). */}
        <div className="card section" id="summary">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>Invoice summary</h3>
            {canEditTax && invoice.status !== 'Cancelled' && tax && !(invoice.creditNotes || []).some((n) => n.status === 'Issued') && (
              <button type="button" className="btn btn-sm" onClick={() => { setSaidTax(''); setEditTax(true); }}>Edit GST / TDS</button>
            )}
          </div>
          <table className="invx-sum" style={{ marginTop: 8 }}>
            <tbody>
              <tr><td className="op" /><td>Amount before GST</td><td className="n">{money2(tx.base)}</td></tr>
              <tr>
                <td className="op">+</td>
                <td>GST charged {tx.gstApplicable ? <>@ {pctTxt(tx.gstPercent)} <span className="small-muted">· {tx.gstTypeLabel}</span></> : <span className="small-muted">· not applicable</span>}</td>
                <td className="n">{money2(tx.gst)}</td>
              </tr>
              {tx.gstApplicable && tx.gstType === 'CGST_SGST' && (
                <>
                  <tr className="sub"><td className="op" /><td>CGST @ {pctTxt(tx.cgstPercent)}</td><td className="n">{money2(tx.cgst)}</td></tr>
                  <tr className="sub"><td className="op" /><td>SGST @ {pctTxt(tx.sgstPercent)}</td><td className="n">{money2(tx.sgst)}</td></tr>
                </>
              )}
              {tx.gstApplicable && tx.gstType === 'IGST' && (
                <tr className="sub"><td className="op" /><td>IGST @ {pctTxt(tx.igstPercent)}</td><td className="n">{money2(tx.igst)}</td></tr>
              )}
              <tr className="tot"><td className="op">=</td><td>Amount after GST (gross)</td><td className="n">{money2(tx.gross)}</td></tr>
              <tr>
                <td className="op">−</td>
                <td>TDS deducted {tx.tdsApplicable ? <>@ {pctTxt(tx.tdsPercent)} <span className="small-muted">· on the amount {tx.tdsBase === 'gross' ? 'after' : 'before'} GST</span></> : <span className="small-muted">· not applicable</span>}</td>
                <td className="n">{tx.tds > 0 ? `(${money2(tx.tds)})` : money2(0)}</td>
              </tr>
              <tr className="net"><td className="op">=</td><td>Net receivable</td><td className="n">{money2(tx.net)}</td></tr>
              <tr><td className="op">−</td><td>Received</td><td className="n">{money2(tx.received)}</td></tr>
              {tx.credited > 0.005 && <tr><td className="op">−</td><td>Credit notes <span className="small-muted">· set against the balance</span></td><td className="n">{money2(tx.credited)}</td></tr>}
              {tx.debited > 0.005 && <tr><td className="op">+</td><td>Debit notes</td><td className="n">{money2(tx.debited)}</td></tr>}
              <tr className={`bal ${tx.balance > 0.5 ? 'due' : 'ok'}`}><td className="op">=</td><td>Balance</td><td className="n">{money2(Math.max(0, tx.balance))}</td></tr>
            </tbody>
          </table>
          <div className="invx-line">
            {money2(tx.base)} + {money2(tx.gst)} = {money2(tx.gross)} − {money2(tx.tds)} = <b>{money2(tx.net)}</b> to receive
          </div>
          <div className="invx-kv">
            <span>GST type</span>
            <span>{tx.gstApplicable ? `${gstSplitText(tx)} · ${GST_TYPE_FROM[tx.gstTypeFrom] || ''}` : 'No GST'}</span>
            {tx.tdsApplicable && <><span>TDS section</span><span>{tx.tdsSection ? `u/s ${tx.tdsSection}` : 'not set (194J printed)'}</span></>}
            {tx.tdsApplicable && <><span>TDS deducted on</span><span>{tx.tdsDeductedOn ? fmtD(tx.tdsDeductedOn) : '—'}</span></>}
            {tx.tdsApplicable && <><span>Certificate / reference</span><span>{tx.tdsCertRef || '—'}</span></>}
            <span>TDS status</span>
            <span><span className={`status ${tdsStatusClass(tx.tdsStatus)}`}>{tx.tdsStatus}</span></span>
          </div>
          {tx.gstApplicable && tx.gstTypeFrom === 'assumed' && (
            <div className="small-muted" style={{ marginTop: 8 }}>{tx.supply?.why}. Use Edit GST / TDS to set IGST if the client is in another state.</div>
          )}
          {tx.check?.level === 'mismatch' && (
            <div className="notice amber invx-warn">
              <span>
                <b>These stored figures do not match their own %</b> — nothing was changed automatically:
                {' '}{tx.check.issues.filter((x) => x.level === 'mismatch').map((x) => x.text).join(' · ')}
              </span>
            </div>
          )}
        </div>

        <div className="card section">
          <h3>What has come in</h3>
          <div className="kv"><span className="k">Number of payments</span><span>{payments.length}</span></div>
          <div className="kv"><span className="k">Payment modes used</span><span>{payments.length ? modes.join(', ') : '—'}</span></div>
          <div className="kv"><span className="k">First payment</span><span>{payments.length ? fmtD(payments[0].date) : '—'}</span></div>
          <div className="kv"><span className="k">Last payment</span><span>{payments.length ? fmtD(payments[payments.length - 1].date) : '—'}</span></div>
          <div className="kv"><span className="k">Total received</span><span>{money2(received)}</span></div>
          <div className="kv" style={{ fontWeight: 700 }}><span className="k">Remaining / pending</span><span>{money2(pending)}</span></div>
          <div className="small-muted" style={{ marginTop: 8 }}>
            {pct}% of the receivable collected · <span className={`status ${statusClass(invoice.status)}`}>{invoice.status}</span>
          </div>
          {noProof.length > 0 && (
            <div className="notice" style={{ marginTop: 12 }}>
              <span>
                <span className="status priority-high">Proof pending</span>{' '}
                {noProof.length} of {payments.length} payment(s) on this invoice have no reference recorded against them.
              </span>
            </div>
          )}
          {noProof.length === 0 && payments.length > 0 && (
            <div className="notice" style={{ marginTop: 12 }}>
              <span><span className="status priority-low">Proof attached</span> Every payment on this invoice has a reference behind it.</span>
            </div>
          )}
        </div>
      </div>

      {/* B2 — credit / debit notes against this invoice (Draft → Issued by
          another Accounts approver), and the placement's margin. */}
      {invoice.notesReady && (
        <div className="grid-2">
          <div className="card section" id="notes">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>Credit &amp; debit notes</h3>
              {canNote && invoice.status !== 'Cancelled' && (
                <div className="qa-row" style={{ marginTop: 0 }}>
                  <button type="button" className="btn btn-sm" onClick={() => setNoteFor({ kind: 'debit' })}>+ Debit note</button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => setNoteFor({ kind: 'credit' })}>+ Credit note</button>
                </div>
              )}
            </div>
            {saidNote && <div className="notice" role="status" style={{ marginTop: 8 }}><span>{saidNote}</span></div>}
            {(invoice.creditNotes || []).length === 0 && <div className="small-muted" style={{ marginTop: 8 }}>No credit or debit note on this invoice.</div>}
            {(invoice.creditNotes || []).map((n) => {
              const mine = n.createdById === user?.id;
              return (
                <div key={n.id} className="kv" style={{ alignItems: 'flex-start' }}>
                  <span className="k">
                    <b className="inv-mono">{n.displayNumber}</b> · {n.kindLabel} · <span className={`cn-chip ${n.status}`}>{n.status}</span>
                    <div className="small-muted">{fmtD(n.noteDate)} · {n.reasonLabel}{n.reasonText ? ` — ${n.reasonText}` : ''}</div>
                    {n.refundOpen > 0.005 && <div><span className="cn-chip refund">Refund due {money2(n.refundOpen)}</span></div>}
                    {n.refundPaidOn && <div className="small-muted">Refund paid {fmtD(n.refundPaidOn)}</div>}
                  </span>
                  <span style={{ textAlign: 'right' }}>
                    <b>{n.kind === 'debit' ? '+' : '−'} {money2(n.net)}</b>
                    <div className="small-muted">{money2(n.amount)} + GST {money2(n.gst)} − TDS {money2(n.tds)}</div>
                    <div className="cn-acts" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
                      <button type="button" className="btn btn-sm" onClick={() => openNotePdf(n.id, setError)}>PDF</button>
                      {n.status === 'Draft' && invoice.canApproveNotes && !mine && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => run(async () => { const r = await api.post(`/invoices/credit-notes/${n.id}/issue`); setSaidNote(r.data.said); })}>Issue</button>
                      )}
                      {n.status === 'Draft' && mine && <span className="small-muted">Another approver issues it</span>}
                      {n.status === 'Draft' && (mine || invoice.canApproveNotes) && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => setNoteFor({ draft: n })}>Change</button>
                          <button type="button" className="btn btn-sm" onClick={() => run(async () => { await api.delete(`/invoices/credit-notes/${n.id}`); setSaidNote('Draft removed.'); })}>Remove</button>
                        </>
                      )}
                      {n.refundOpen > 0.005 && canManage && <button type="button" className="btn btn-sm" onClick={() => setRefundNote(n)}>Refund paid</button>}
                      {n.status === 'Issued' && invoice.canApproveNotes && !n.refundPaidOn && <button type="button" className="btn btn-sm" onClick={() => setCancelNote(n)}>Cancel note</button>}
                    </div>
                  </span>
                </div>
              );
            })}
          </div>
          {invoice.margin && (
            <div className="card section" id="margin">
              <h3>Placement margin</h3>
              <div className="cn-margin-row">
                <span>Fee billed (before GST)</span><span className="n">{money2(invoice.margin.fee)}</span>
                {invoice.margin.debit > 0.005 && <><span>+ Debit notes</span><span className="n">{money2(invoice.margin.debit)}</span></>}
                {invoice.margin.credit > 0.005 && <><span>− Credit notes</span><span className="n">({money2(invoice.margin.credit)})</span></>}
                <span>− Recruiter incentive <span className="small-muted">· {invoice.margin.incentiveStatus}</span></span><span className="n">({money2(invoice.margin.incentive)})</span>
                <span>− Partner payout <span className="small-muted">· {invoice.margin.payout > 0.005 ? 'fee before GST owed to the agency / freelancer' : 'no partner on this placement'}</span></span><span className="n">({money2(invoice.margin.payout)})</span>
                <span className="tot">= Margin{invoice.margin.marginPct != null ? ` · ${invoice.margin.marginPct}% of the fee` : ''}</span><span className="n tot">{money2(invoice.margin.margin)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card section">
        <h3>Payments / instalments</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {payments.length} payment(s) · {money2(received)}
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th><th>Payment date</th><th>Month</th><th className="num">Payment amount</th>
                <th>Payment mode</th><th>Reference</th><th className="num">Balance after</th><th>Payment proof</th>
                <th>Recorded by</th>{canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {(() => {
                let run2 = 0;
                return payments.map((p, i) => {
                  run2 += Number(p.amount || 0);
                  return (
                    <tr key={p.id}>
                      <td className="num">{i + 1}</td>
                      <td>{fmtD(p.date)}</td>
                      <td>{monthOf(p.date)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{money2(p.amount)}</td>
                      <td>{p.method || '—'}</td>
                      <td>{p.reference || '—'}</td>
                      <td className="num">{money2(Math.max(0, receivable - run2))}</td>
                      <td>{p.reference ? <span className="status priority-low">reference on file</span> : <span className="status priority-high">no proof</span>}</td>
                      <td>{p.recordedBy || '—'}</td>
                      {canManage && (
                        <td>
                          {/* A receipt that came from a reconciled bank line is undone
                              on the bank screen, so the two never drift apart. */}
                          {p.bankTxnId
                            ? <span className="small-muted">From bank</span>
                            : <button className="btn btn-sm" onClick={() => run(() => api.delete(`/invoices/${id}/payments/${p.id}`))}>Remove</button>}
                        </td>
                      )}
                    </tr>
                  );
                });
              })()}
              {payments.length === 0 && (
                <tr><td colSpan={canManage ? 10 : 9} className="small-muted">No payment recorded against this invoice yet.</td></tr>
              )}
            </tbody>
            {payments.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan="3">TOTAL RECEIVED</td>
                  <td className="num" style={{ fontWeight: 700 }}>{money2(received)}</td>
                  <td colSpan="2" />
                  <td className="num" style={{ fontWeight: 700 }}>{money2(pending)}</td>
                  <td>{noProof.length ? <span className="status priority-high">{noProof.length} pending</span> : <span className="status priority-low">all attached</span>}</td>
                  <td colSpan={canManage ? 2 : 1} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {canManage && pending > 0.5 && invoice.status !== 'Cancelled' && (
          <form onSubmit={addPayment} style={{ marginTop: 14 }}>
            <div className="small-muted" style={{ marginBottom: 8 }}>
              {payments.length
                ? 'Record only what came in now — the balance stays pending and you record the next part when it arrives.'
                : 'First payment on this invoice. If the client is paying in parts, record only what came in now — the balance stays pending and you record the next part when it arrives.'}
            </div>
            <div className="grid-3">
              <label className="field"><span>Payment date *</span>
                <input required type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </label>
              <label className="field"><span>Received amount * (₹)</span>
                <input required type="number" step="0.01" max={pending} placeholder={pending.toFixed(2)} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </label>
              <label className="field"><span>Payment method</span>
                <Combo value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                  {PAY_METHODS.map((m) => <option key={m}>{m}</option>)}
                </Combo>
              </label>
              <label className="field"><span>Transaction / reference ID</span>
                <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
              </label>
              <label className="field" style={{ gridColumn: 'span 2' }}><span>Notes</span>
                <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </label>
            </div>
            <div className="qa-row">
              <button className="btn btn-primary btn-sm" type="submit">Record payment</button>
              <button className="btn btn-sm" type="button" onClick={() => run(() => api.patch(`/invoices/${id}/pay`))}>Settle in full</button>
              {received === 0 && (
                <button className="btn btn-sm" type="button" onClick={() => run(() => api.patch(`/invoices/${id}/cancel`))}>Cancel invoice</button>
              )}
            </div>
          </form>
        )}
      </div>

      {/* The bank statement lines that prove the money arrived — linked on
          Bank & Reconciliation, automatically when the narration names this
          invoice or client clearly, otherwise once someone confirms it. */}
      <div className="card section" id="proof">
        <h3>Bank statement proof</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>
          {proofLines.length
            ? `${proofLines.length} statement line(s) · ${money2(proofLines.reduce((s, l) => s + Number(l.applied || 0), 0))} applied to this invoice · `
            : 'No bank statement line is linked to this invoice yet · '}
          <span className={`status ${settleTone}`}>{settleWord}</span>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Statement date</th><th>Reference</th><th className="num">Line amount</th>
                <th className="num">Applied to this invoice</th><th>Bank</th><th>Narration</th>
              </tr>
            </thead>
            <tbody>
              {proofLines.map((l) => (
                <tr key={l.txnId}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtD(l.date)}</td>
                  <td className="inv-mono">{l.reference || '—'}</td>
                  <td className="num">{money2(l.amount)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {money2(l.applied)}
                    {l.linkedOnly && <div className="small-muted">linked to a receipt recorded by hand</div>}
                  </td>
                  <td className="small-muted">{l.bank || '—'}</td>
                  <td className="small-muted" style={{ maxWidth: 420 }}>{String(l.description || '').slice(0, 160)}</td>
                </tr>
              ))}
              {!proofLines.length && (
                <tr>
                  <td colSpan="6" className="small-muted">
                    When a bank statement is imported, a credit that names this invoice number or this client (with an amount that fits)
                    is linked here automatically; anything less certain waits under “Possible matches” on Bank &amp; Reconciliation.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section">
        <h3>Candidates on this invoice</h3>
        <div className="small-muted" style={{ marginBottom: 10 }}>{invoice.candidate ? 1 : 0} line(s)</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate no.</th><th>Candidate</th><th>Recruiter</th><th>Joined</th>
                <th className="num">Before GST</th><th className="num">GST</th><th className="num">After GST</th><th className="num">TDS</th>
              </tr>
            </thead>
            <tbody>
              {invoice.candidate
                ? (
                  <tr>
                    <td>{invoice.candidate.candidateCode || invoice.candidate.id.slice(-6)}</td>
                    <td><Link to={`/candidates/${invoice.candidate.id}`}>{invoice.candidate.name}</Link></td>
                    <td className="small-muted">{invoice.requirement?.title || '—'}</td>
                    <td>{fmtD(invoice.joiningDate || invoice.invoiceDate)}</td>
                    <td className="num">{money(billing)}</td>
                    <td className="num">{money(gst)}</td>
                    <td className="num">{money(invoiceValue)}</td>
                    <td className="num">{money(tds)}</td>
                  </tr>
                )
                : <tr><td colSpan="8" className="small-muted">No candidate is linked to this invoice.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* The two things that stay open after an invoice is raised: getting it
          to the client, and getting Form 16A back for the TDS they deducted. */}
      <div className="card section">
        <h3>Dates &amp; papers</h3>
        <div className="kv"><span className="k">Invoice date</span><span>{fmtD(invoice.invoiceDate)}</span></div>
        <div className="kv"><span className="k">Payment due</span><span>{fmtD(invoice.dueDate)}</span></div>
        <div className="kv"><span className="k">Payment terms</span><span>{invoice.paymentTerms || '—'}</span></div>
        <div className="kv">
          <span className="k">Sent to client</span>
          <span>
            {invoice.sentVia
              ? <span className="status priority-low">{invoice.sentVia} · {fmtD(invoice.sentDate)}</span>
              : <span className="status">Not sent</span>}
            {canManage && (
              <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => run(() => api.patch(`/invoices/${id}/sent`, { via: 'Email' }))}>
                {invoice.sentVia ? 'Send again' : 'Mark sent'}
              </button>
            )}
          </span>
        </div>
        <div className="kv" id="tds">
          <span className="k">TDS certificate (Form 16A)</span>
          <span>
            {tds <= 0.5
              ? <span className="small-muted">No TDS was deducted on this invoice</span>
              : (
                <>
                  <span className={`status ${invoice.tdsCertReceived ? 'priority-low' : 'priority-high'}`}>
                    {invoice.tdsCertReceived ? `${money2(tds)} in hand${invoice.tdsCertRef ? ` · ${invoice.tdsCertRef}` : ''}` : `${money2(tds)} to collect`}
                  </span>
                  {canManage && (
                    <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => run(() => api.patch(`/invoices/${id}/tds-certificate`, { received: !invoice.tdsCertReceived }))}>
                      {invoice.tdsCertReceived ? 'Undo' : 'Got it'}
                    </button>
                  )}
                </>
              )}
          </span>
        </div>
        {tds > 0.5 && (
          <div className="kv">
            <span className="k">Certificate file</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {invoice.tdsCertHasFile
                ? (
                  <>
                    <button type="button" className="btn btn-sm" onClick={viewTdsCert}>View {invoice.tdsCertName || 'file'}</button>
                    {canManage && <button type="button" className="btn btn-sm" onClick={() => run(() => api.delete(`/invoices/${id}/tds-certificate/file`))}>Remove file</button>}
                  </>
                )
                : <span className="small-muted">No file uploaded</span>}
              {canManage && (
                <label className="btn btn-sm" style={{ margin: 0, cursor: 'pointer' }}>
                  {invoice.tdsCertHasFile ? 'Replace file' : 'Upload Form 16A'}
                  <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => { uploadTdsCert(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              )}
            </span>
          </div>
        )}
      </div>

      {invoice.candidate && (
        <div className="card section">
          <h3>Linked candidate journey</h3>
          <div><Link to={`/candidates/${invoice.candidate.id}`}>View candidate in ATS →</Link></div>
          {invoice.requirement && (
            <div style={{ marginTop: 8 }}>
              <Link to={`/requirements/${invoice.requirement.id}`}>View requirement in ATS →</Link>
            </div>
          )}
        </div>
      )}

      {preview && doc && (
        <div className="overlay show" onClick={() => setPreview(null)}>
          <div className="modal xwide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>Invoice {doc.invoiceNumber}</h3>
                <div className="small-muted">
                  {doc.client.name} · {fmtD(doc.invoiceDate)} — before GST {money2(doc.totals.subTotal)} · GST {money2(doc.totals.gst)}
                  {' '}· after GST {money2(doc.totals.invoiceValue)} · TDS {money2(doc.totals.tds)} · receivable {money2(doc.totals.receivable)}
                  {' '}· pending {money2(pending)}
                </div>
              </div>
              <button className="close-x" onClick={() => setPreview(null)}>×</button>
            </div>
            <div className="modal-body">
              <div className="qa-row" style={{ marginBottom: 12 }}>
                <button className={`btn btn-sm ${preview === 'client' ? 'btn-primary' : ''}`} title="What the client receives — no recruiter, no department" onClick={() => setPreview('client')}>📄 Client copy</button>
                <button className={`btn btn-sm ${preview === 'internal' ? 'btn-primary' : ''}`} title="Adds the recruiter position and department for your own records" onClick={() => setPreview('internal')}>🏛 Internal copy</button>
                <span style={{ flex: 1 }} />
                <span className="small-muted">
                  {preview === 'client' ? 'This is the copy that gets emailed or sent on WhatsApp.' : 'For the office only — never send this one out.'}
                </span>
              </div>
              {!doc.company.gstin && (
                <div className="notice" style={{ marginBottom: 10 }}>
                  <span><b>No company GSTIN is saved</b> — that is why the invoice prints without one. Fill the company profile in once and every invoice carries it.</span>
                </div>
              )}
              <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'auto', background: '#fff', padding: 16 }}>
                <iframe
                  title="Invoice preview"
                  style={{ width: '100%', height: 640, border: 0, background: '#fff' }}
                  srcDoc={(() => { const { style, inner } = invoiceDocumentHtml(doc, preview); return `<style>${style}</style>${inner}`; })()}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setPreview(null)}>Close</button>
              <button className="btn btn-primary" onClick={() => printDoc(preview)}>🖨 Print / Save as PDF</button>
            </div>
          </div>
        </div>
      )}

      {editTax && tax && (
        <TaxEditModal
          invoice={invoice}
          onClose={() => setEditTax(false)}
          onSaved={(said) => { setEditTax(false); setSaidTax(said); load(); }}
        />
      )}

      {noteFor && (
        <NoteModal
          kind={noteFor.kind || 'credit'}
          invoiceId={invoice.id}
          draft={noteFor.draft || null}
          onClose={() => setNoteFor(null)}
          onSaved={(note, msg) => { setNoteFor(null); setSaidNote(msg); load(); }}
        />
      )}
      {cancelNote && <CancelNote note={cancelNote} onClose={() => setCancelNote(null)} onDone={(msg) => { setCancelNote(null); setSaidNote(msg); load(); }} />}
      {refundNote && <RefundPaid note={{ ...refundNote, client: invoice.client?.name }} onClose={() => setRefundNote(null)} onDone={(msg) => { setRefundNote(null); setSaidNote(msg); load(); }} />}

      {showAccount && (
        <ClientAccountModal clientId={invoice.clientId} clientName={invoice.client?.name} onClose={() => setShowAccount(false)} />
      )}

      {send && doc && (
        <SendInvoice
          doc={doc}
          invoice={invoice}
          message={msg}
          onPrint={() => printDoc('client')}
          onClose={() => setSend(null)}
          onSent={(via) => run(async () => { await api.patch(`/invoices/${id}/sent`, { via }); setSend(null); })}
        />
      )}
    </div>
  );
}

// The send screen. Browsers cannot attach a file to an email for you, so the
// application writes the message and hands the PDF to you to attach.
function SendInvoice({ doc, invoice, message, onPrint, onClose, onSent }) {
  const [to, setTo] = useState(invoice.client?.contactEmail || '');
  const [cc, setCc] = useState('');
  const [wa, setWa] = useState(invoice.client?.contactWhatsApp || invoice.client?.contactPhone || '');
  const [subject, setSubject] = useState(message.subject);
  const [body, setBody] = useState(message.body);
  const [note, setNote] = useState('');

  const copy = () => {
    const text = `${subject}\n\n${body}`;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => setNote('Message copied'), () => setNote('Could not copy'));
    else setNote('Select the message and copy it');
  };
  const openEmail = () => {
    if (!to.trim()) { setNote('Add an email address — or save one in the Client Master.'); return; }
    window.open(`mailto:${encodeURIComponent(to.trim())}?${cc.trim() ? `cc=${encodeURIComponent(cc.trim())}&` : ''}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
    onSent('Email');
  };
  const openWhatsApp = () => {
    let num = String(wa || '').replace(/\D/g, '');
    if (!num) { setNote('Add a WhatsApp number — or save one in the Client Master.'); return; }
    if (num.length === 10) num = `91${num}`;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(body)}`, '_blank');
    onSent('WhatsApp');
  };

  return (
    <div className="overlay show" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>Send invoice {doc.invoiceNumber}</h3>
            <div className="small-muted">{doc.client.name} · {money2(doc.totals.receivable)} receivable</div>
          </div>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="notice" style={{ marginBottom: 14 }}>
            <span>Contact details come from the Client Master. Edit them here for this send, or open the client to save them permanently.</span>
          </div>
          <div className="grid-2">
            <label className="field"><span>Email to</span>
              <input value={to} placeholder="accounts@client.com" onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="field"><span>CC (optional)</span>
              <input value={cc} onChange={(e) => setCc(e.target.value)} />
            </label>
            <label className="field"><span>WhatsApp number</span>
              <input value={wa} placeholder="91XXXXXXXXXX" onChange={(e) => setWa(e.target.value)} />
            </label>
            <label className="field" style={{ gridColumn: 'span 2' }}><span>Subject</span>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </label>
            <label className="field" style={{ gridColumn: 'span 2' }}><span>Message</span>
              <textarea rows="14" style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
          </div>
          <div className="notice" style={{ marginTop: 12 }}>
            <span>
              <b>Attaching the PDF:</b> browsers cannot attach a file to an email for you. Click <b>Save client copy PDF</b> first —
              the print dialog opens, choose “Save as PDF” — then attach that file in your mail app or WhatsApp. The message text is
              already written for you.
            </span>
          </div>
          {invoice.sentVia && (
            <div className="notice" style={{ marginTop: 10 }}>
              <span>Previously sent: {invoice.sentVia} on {fmtD(invoice.sentDate)}</span>
            </div>
          )}
          {note && <div className="small-muted" style={{ marginTop: 10 }}>{note}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={copy}>⧉ Copy message</button>
          <button className="btn" onClick={onPrint}>🖨 Save client copy PDF</button>
          <button className="btn" onClick={openWhatsApp}>💬 Open WhatsApp</button>
          <button className="btn btn-primary" onClick={openEmail}>✉ Open email</button>
        </div>
      </div>
    </div>
  );
}
