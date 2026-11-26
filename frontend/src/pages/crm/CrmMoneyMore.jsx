// THE CRM MONEY GAPS (2026-11-26, backend crm/moneyMore.js + crm/sequences.js). No new CRM module (the CRM stays at five): everything sits inside
// what is there - receipts / credit & debit notes / repeat on the invoice (Deals > a deal > Invoice, and the Invoices list), Commission as a view
// of Deals, Sequences as a tab of Leads (and on a lead's Follow-ups), the SLA hours on Customer support.
import { Fragment, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import { useCrm, errOf, money, dateOf, download, Pill, invoicePill, openInvoicePdf, GstBlock, PaymentLog, balanceOf } from './crmShared.jsx'; // eslint-disable-line import/no-cycle

const rupees = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const num = (v) => Number(String(v).replace(/[, ]/g, ''));

// ---- payment receipts ------------------------------------------------------------------------------------------------
export function ReceiptButtons({ inv, pay, canEdit }) {
  const { toast } = useCrm();
  const [mail, setMail] = useState(false);
  const base = `/crm/invoices/${inv.id}/payments/${pay.id}/receipt`;
  const pdf = () => download(base, `receipt-${inv.code || 'payment'}.pdf`, { open: true }).catch(() => toast('The receipt could not be opened.'));
  async function wa() {
    const w = window.open('', '_blank');
    try {
      const r = await api.post(`${base}/share`);
      if (w) w.location.href = r.data.waUrl; else window.open(r.data.waUrl, '_blank');
      toast(r.data.number ? `WhatsApp is open for +${r.data.number} with receipt ${r.data.receiptNo}. Press Send there.` : `Receipt ${r.data.receiptNo}: choose the chat in WhatsApp, the message is ready.`);
    } catch (e) { if (w) w.close(); toast(errOf(e, 'The receipt link could not be made.')); }
  }
  return (
    <>
      <button type="button" className="btn btn-sm" title="The payment receipt as a PDF" onClick={pdf}>Receipt</button>
      {canEdit && <button type="button" className="btn btn-sm" title="Send the receipt on WhatsApp (a link to the PDF); you press Send" aria-label="Send the receipt on WhatsApp" onClick={wa}>💬</button>}
      {canEdit && <button type="button" className="btn btn-sm" title="Email the receipt with the PDF attached" aria-label="Email the receipt" onClick={() => setMail(true)}>✉️</button>}
      {mail && <ReceiptMail base={base} onClose={() => setMail(false)} />}
    </>
  );
}
function ReceiptMail({ base, onClose }) {
  const { toast } = useCrm();
  const [f, setF] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api.get(`${base}/email-draft`).then((r) => setF(r.data)).catch((e) => setErr(errOf(e, 'The mail could not be prepared.'))); }, [base]);
  async function sendIt() {
    setBusy(true); setErr('');
    try { const r = await api.post(`${base}/email`, f); toast(`Receipt ${r.data.receiptNo} emailed to ${r.data.to}.`); onClose(); } catch (e) { setErr(errOf(e, 'The receipt was not sent.')); } finally { setBusy(false); }
  }
  return (
    <Modal title="Email the receipt" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !f} onClick={sendIt}>{busy ? 'Sending…' : 'Send email'}</button></>}>
      {!f && !err && <div className="small-muted">Loading…</div>}
      {f && (
        <>
          <div className="field"><label>To</label><input type="email" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To" /></div>
          <div className="field"><label>CC <span className="small-muted">optional, comma separated</span></label><input value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} aria-label="CC" /></div>
          <div className="field"><label>Subject</label><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} aria-label="Subject" /></div>
          <div className="field"><label>Message <span className="small-muted">the receipt PDF is attached</span></label><textarea rows={6} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} aria-label="Message" /></div>
        </>
      )}
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

// ---- credit / debit notes ----------------------------------------------------------------------------------------------
const KIND_WORD = { credit: 'Credit note', debit: 'Debit note' };
export function NotesBox({ inv, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null); const [adding, setAdding] = useState(null);
  const load = () => api.get(`/crm/invoices/${inv.id}/notes`).then((r) => setD(r.data)).catch(() => setD({ notes: [], canIssue: false }));
  useEffect(() => { load(); }, [inv.id, inv.status, inv.paidAmount, inv.creditAmount, inv.debitAmount]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d || (!d.notes.length && !d.canIssue)) return null;
  async function cancel(n) {
    if (!window.confirm(`Cancel ${KIND_WORD[n.kind].toLowerCase()} ${n.code} (${rupees(n.total)})? The invoice balance goes back to what it was without it.`)) return;
    try { await api.post(`/crm/invoices/${inv.id}/notes/${n.id}/cancel`); toast(`${n.code} cancelled.`); load(); onChanged(); } catch (e) { toast(errOf(e, 'The note could not be cancelled.')); }
  }
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div className="section-label" style={{ margin: 0 }}>Credit / debit notes</div>
        {(inv.creditAmount > 0 || inv.debitAmount > 0) && <span className="small-muted" style={{ fontSize: 12 }}>invoice {money(inv.total)}{inv.creditAmount > 0 ? ` − ${money(inv.creditAmount)} credited` : ''}{inv.debitAmount > 0 ? ` + ${money(inv.debitAmount)} debited` : ''} = {money(inv.netTotal)}</span>}
        {d.canIssue && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            {balanceOf(inv) > 0 && <button type="button" className="btn btn-sm" title="Lower what the customer owes (a discount agreed later, a position not filled ...)" onClick={() => setAdding('credit')}>+ Credit note</button>}
            <button type="button" className="btn btn-sm" title="Charge the customer more on this invoice" onClick={() => setAdding('debit')}>+ Debit note</button>
          </span>
        )}
      </div>
      {!d.notes.length && <div className="small-muted" style={{ fontSize: 12.5, marginTop: 6 }}>None. A Sales manager issues one when the amount owed has to change after the invoice was sent.</div>}
      {d.notes.map((n) => (
        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid var(--line, #eef0f4)', opacity: n.status === 'Cancelled' ? 0.55 : 1 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}><b>{n.code}</b><span>{KIND_WORD[n.kind]}</span><b>{n.kind === 'credit' ? '−' : '+'}{money(n.total)}</b><span className="small-muted">{dateOf(n.noteDate)}</span>{n.status === 'Cancelled' && <Pill v="Cancelled" />}</div>
            <div className="small-muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{n.reason} · {money(n.amount)} + GST {money(n.taxAmount)}{n.byName ? ` · by ${n.byName}` : ''}</div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => download(`/crm/invoices/${inv.id}/notes/${n.id}/pdf`, `${n.code}.pdf`, { open: true }).catch(() => toast('The PDF could not be opened.'))}>PDF</button>
          {d.canIssue && n.status === 'Issued' && <button type="button" className="btn btn-sm" onClick={() => cancel(n)}>Cancel</button>}
        </div>
      ))}
      {adding && <NoteDialog inv={inv} kind={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); load(); onChanged(); }} />}
    </div>
  );
}
function NoteDialog({ inv, kind, onClose, onSaved }) {
  const { toast } = useCrm();
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const rate = Number(inv.taxPercent) || 0;
  const a = num(amount) || 0; const tax = Math.round(a * rate) / 100; const total = Math.round((a + tax) * 100) / 100;
  const left = balanceOf(inv);
  async function save() {
    if (!(a > 0)) { setErr('Write the value before GST.'); return; }
    if (reason.trim().length < 3) { setErr('Write the reason (it is printed on the note).'); return; }
    if (kind === 'credit' && total > left + 0.005) { setErr(`Only ${rupees(left)} is still unpaid: a credit note can be at most that, with GST.`); return; }
    setBusy(true); setErr('');
    try { const r = await api.post(`/crm/invoices/${inv.id}/notes`, { kind, amount: a, reason }); toast(`${r.data.note.code} issued. ${rupees(r.data.invoice.balance)} is now left on ${inv.code}.`); onSaved(); } catch (e) { setErr(errOf(e, 'The note could not be issued.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${KIND_WORD[kind]} on ${inv.code}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Issuing…' : `Issue ${KIND_WORD[kind].toLowerCase()}`}</button></>}>
      <div className="small-muted" style={{ marginBottom: 8 }}>{kind === 'credit' ? 'Lowers what the customer owes on this invoice. The invoice itself stays as it was sent; the note is a document of its own with its own number.' : 'Charges the customer more on this invoice, as a document of its own with its own number.'} Still unpaid now: {rupees(left)}.</div>
      <div className="field"><label>Value before GST</label><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Value before GST" /></div>
      <div className="small-muted" style={{ marginBottom: 8 }}>GST {rate}% {rupees(tax)} · note total <b>{rupees(total)}</b></div>
      <div className="field"><label>Reason <span className="small-muted">printed on the note</span></label><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-label="Reason" /></div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

// ---- repeating invoices ------------------------------------------------------------------------------------------------
const EVERY = [['month', 'Every month'], ['quarter', 'Every quarter'], ['year', 'Every year']];
export function RepeatBox({ inv, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null); const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/invoices/${inv.id}/repeat`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { load(); }, [inv.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  if (d.madeFrom) return <div className="small-muted" style={{ fontSize: 12, marginTop: 8 }}>🔁 Made from the repeat of invoice {d.madeFrom.code}.</div>;
  const rep = d.repeat && d.repeat.active ? d.repeat : null;
  if (!rep && !d.canEdit) return null;
  async function next() {
    setBusy(true);
    try { const r = await api.post(`/crm/invoices/${inv.id}/repeat/next`); toast(`Invoice ${r.data.invoice.code} is made as a Draft (${dateOf(r.data.invoice.issueDate)}). Check it and send it from Invoices.`); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The next invoice could not be made.')); } finally { setBusy(false); }
  }
  async function stopIt() {
    if (!window.confirm('Stop repeating this invoice? Invoices already made stay.')) return;
    try { await api.put(`/crm/invoices/${inv.id}/repeat`, { active: false }); toast('It no longer repeats.'); load(); } catch (e) { toast(errOf(e, 'This could not be changed.')); }
  }
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div className="section-label" style={{ margin: 0 }}>Repeat</div>
        {rep ? <span style={{ fontSize: 13 }}>🔁 {rep.everyWord} · next on <b>{dateOf(rep.nextDate)}</b>{rep.untilDate ? ` · until ${dateOf(rep.untilDate)}` : ''}{rep.made ? ` · ${rep.made} made` : ''}</span> : <span className="small-muted" style={{ fontSize: 12.5 }}>Does not repeat.</span>}
        {d.canEdit && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
            {rep && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={next}>{busy ? 'Making…' : 'Make the next one now'}</button>}
            {inv.status !== 'Cancelled' && <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>{rep ? 'Change' : 'Repeat this invoice'}</button>}
            {rep && <button type="button" className="btn btn-sm" onClick={stopIt}>Stop</button>}
          </span>
        )}
      </div>
      {rep && !d.autoOn && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>Repeating invoices are switched off, so nothing is made by itself: press "Make the next one now" when it is due. A Sales manager switches them on in Deals › Commission › Rules.</div>}
      {rep && d.autoOn && <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>On {dateOf(rep.nextDate)} the next invoice is made as a Draft and its owner is told, to check and send it.</div>}
      {d.made.length > 0 && <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>Made: {d.made.map((m) => `${m.code} (${dateOf(m.issueDate)}, ${m.status})`).join(' · ')}</div>}
      {editing && <RepeatDialog inv={inv} rep={rep} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </div>
  );
}
function RepeatDialog({ inv, rep, onClose, onSaved }) {
  const { toast } = useCrm();
  const [every, setEvery] = useState(rep ? rep.every : 'month'); const [nextDate, setNextDate] = useState(rep ? rep.nextDate : ''); const [untilDate, setUntil] = useState(rep && rep.untilDate ? rep.untilDate : '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try { const r = await api.put(`/crm/invoices/${inv.id}/repeat`, { every, nextDate: nextDate || undefined, untilDate: untilDate || undefined }); toast(`${inv.code} repeats ${r.data.repeat.everyWord}; next on ${dateOf(r.data.repeat.nextDate)}.`); onSaved(); } catch (e) { setErr(errOf(e, 'The repeat could not be saved.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Repeat ${inv.code}`} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="small-muted" style={{ marginBottom: 8 }}>Each repeat is a Draft copy of this invoice (the same lines, customer and amount) with its own number and date. Somebody checks it and sends it, as with any invoice.</div>
      <div className="field"><label>How often</label><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{EVERY.map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${every === k ? ' btn-primary' : ''}`} onClick={() => setEvery(k)}>{l}</button>)}</div></div>
      <div className="field"><label>Next invoice on <span className="small-muted">empty: the same day, one period after this invoice</span></label><input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} aria-label="Next invoice date" /></div>
      <div className="field"><label>Last one on <span className="small-muted">optional: empty repeats until stopped</span></label><input type="date" value={untilDate} onChange={(e) => setUntil(e.target.value)} aria-label="Last invoice date" /></div>
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

// ---- an invoice without a deal (a repeat): its own window from the Invoices list ----------------------------------------------
export function InvoiceWindow({ id, onClose, onChanged }) {
  const { toast, me } = useCrm();
  const [inv, setInv] = useState(null); const [err, setErr] = useState('');
  const load = () => api.get(`/crm/invoices/${id}`).then((r) => setInv(r.data.invoice)).catch((e) => setErr(errOf(e, 'The invoice could not be read.')));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { load(); if (onChanged) onChanged(); };
  return (
    <Modal title={inv ? `Invoice ${inv.code}` : 'Invoice'} size="wide" onClose={onClose}>
      {!inv && (err ? <div className="notice" role="alert">{err}</div> : <div className="small-muted">Loading…</div>)}
      {inv && (
        <div style={{ fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{inv.accountName || '—'}</b> <Pill v={invoicePill(inv)} />
            <span className="small-muted" style={{ fontSize: 11.5 }}>issued {dateOf(inv.issueDate)}{inv.dueDate ? ` · due ${dateOf(inv.dueDate)}` : ''}</span>
            <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => openInvoicePdf(inv, toast)}>PDF</button>
          </div>
          <GstBlock inv={inv} />
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
            <div><div className="small-muted" style={{ fontSize: 11 }}>Total</div><b>{money(inv.netTotal)}</b></div>
            <div><div className="small-muted" style={{ fontSize: 11 }}>Received</div><b>{money(inv.paidAmount)}</b></div>
            <div><div className="small-muted" style={{ fontSize: 11 }}>Balance</div><b>{money(balanceOf(inv))}</b></div>
          </div>
          {inv.status === 'Draft' ? <div className="small-muted" style={{ marginTop: 8 }}>A Draft: edit and send it from the Invoices list (✏️ / ✉️ / 💬); payments are recorded once it is sent.</div> : <PaymentLog inv={inv} canEdit={me.canEdit} onChanged={changed} />}
          <NotesBox inv={inv} onChanged={changed} />
          <RepeatBox inv={inv} onChanged={changed} />
        </div>
      )}
    </Modal>
  );
}

// ---- commission (Deals > Commission) -------------------------------------------------------------------------------------
const monthNow = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 7);
const monthBefore = () => { const d = new Date(Date.now() + 5.5 * 3600000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
export function CommissionView() {
  const { toast } = useCrm();
  const [month, setMonth] = useState(monthBefore());
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [lines, setLines] = useState(null); const [rules, setRules] = useState(false);
  const load = () => api.get('/crm/commission', { params: { month } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The statement could not be read.')));
  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(path, row, extra = {}, done = '') {
    try { const r = await api.post(`/crm/commission/${path}`, { month, ownerId: row.ownerId, ...extra }); setD(r.data); if (done) toast(done); } catch (e) { toast(errOf(e, 'This could not be done.')); }
  }
  function paid(row) {
    const ref = window.prompt(`Mark ${rupees(row.amount)} paid to ${row.ownerName} for ${month}.\nReference (salary month, UTR …), optional:`, '');
    if (ref == null) return;
    act('paid', row, { reference: ref }, 'Marked paid.');
  }
  return (
    <div>
      <div className="filter-row" style={{ alignItems: 'center' }}>
        <label className="small-muted" htmlFor="com-month">Month</label>
        <input id="com-month" type="month" value={month} max={monthNow()} onChange={(e) => setMonth(e.target.value || monthBefore())} style={{ width: 170 }} />
        <span className="small-muted" style={{ fontSize: 12.5 }}>Commission is worked on the money collected in the month, before GST, on each person's invoices.</span>
        {d && d.canApprove && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setRules(true)}>Rules</button>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {!d && !err && <div className="small-muted">Loading…</div>}
      {d && (
        <>
          {!d.finished && <div className="notice" style={{ marginBottom: 8 }}>This month is not over: the figures still move, and it is approved once it is over.</div>}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Salesperson</th><th style={{ textAlign: 'right' }}>Payments</th><th style={{ textAlign: 'right' }}>Collected</th><th style={{ textAlign: 'right' }}>Before GST</th><th style={{ textAlign: 'right' }}>%</th><th style={{ textAlign: 'right' }}>Commission</th><th>Status</th><th /></tr></thead>
              <tbody>
                {!d.rows.length && <tr><td colSpan={8}><div className="empty"><h3>Nothing collected</h3>No payment was recorded in {month}.</div></td></tr>}
                {d.rows.map((x) => (
                  <tr key={x.ownerId} className="row-link" onClick={() => api.get('/crm/commission/lines', { params: { month, ownerId: x.ownerId } }).then((r) => setLines({ row: x, rows: r.data.rows })).catch(() => toast('The payments could not be read.'))}>
                    <td><b>{x.ownerName}</b>{x.changedSince && <div className="small-muted" style={{ fontSize: 11, color: 'var(--amber, #b45309)' }}>payments changed after it was approved</div>}</td>
                    <td style={{ textAlign: 'right' }}>{x.payments}</td>
                    <td style={{ textAlign: 'right' }}>{money(x.collected)}</td>
                    <td style={{ textAlign: 'right' }}>{money(x.base)}</td>
                    <td style={{ textAlign: 'right' }}>{x.percent}%</td>
                    <td style={{ textAlign: 'right' }}><b>{rupees(x.amount)}</b></td>
                    <td><Pill v={x.status} />{x.status === 'Paid' && <div className="small-muted" style={{ fontSize: 11 }}>{dateOf(x.paidOn)}{x.paidRef ? ` · ${x.paidRef}` : ''}</div>}{x.approvedByName && x.status !== 'Not approved' && <div className="small-muted" style={{ fontSize: 11 }}>by {x.approvedByName}</div>}</td>
                    <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      {d.canApprove && d.finished && x.status === 'Not approved' && <button type="button" className="btn btn-sm btn-primary" disabled={!(x.percent > 0)} title={x.percent > 0 ? 'Freeze these figures for paying' : 'Set a % for this person in Rules first'} onClick={() => act('approve', x, {}, `${x.ownerName}: ${rupees(x.amount)} approved.`)}>Approve</button>}
                      {d.canApprove && x.status === 'Approved' && <><button type="button" className="btn btn-sm btn-primary" onClick={() => paid(x)}>Mark paid</button> <button type="button" className="btn btn-sm" onClick={() => act('undo', x, {}, 'Approval undone.')}>Undo</button></>}
                    </td>
                  </tr>
                ))}
              </tbody>
              {d.rows.length > 0 && <tfoot><tr><td><b>Total</b></td><td /><td style={{ textAlign: 'right' }}><b>{money(d.totals.collected)}</b></td><td /><td /><td style={{ textAlign: 'right' }}><b>{rupees(d.totals.amount)}</b></td><td colSpan={2} /></tr></tfoot>}
            </table>
          </div>
        </>
      )}
      {lines && (
        <Modal title={`${lines.row.ownerName} · ${month}`} size="wide" onClose={() => setLines(null)}>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Mode</th><th style={{ textAlign: 'right' }}>Received</th><th style={{ textAlign: 'right' }}>Before GST</th></tr></thead>
            <tbody>{lines.rows.map((p) => <tr key={p.id}><td>{dateOf(p.paidOn)}</td><td>{p.invoice}</td><td>{p.account || '—'}</td><td>{p.mode || '—'}{p.reference ? ` · ${p.reference}` : ''}</td><td style={{ textAlign: 'right' }}>{money(p.amount)}</td><td style={{ textAlign: 'right' }}>{money(p.base)}</td></tr>)}</tbody>
          </table></div>
        </Modal>
      )}
      {rules && <MoneyRules onClose={() => setRules(false)} onSaved={() => { setRules(false); load(); }} />}
    </div>
  );
}
function MoneyRules({ onClose, onSaved }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api.get('/crm/money-settings').then((r) => setD({ ...r.data, f: { recurringOn: r.data.settings.recurringOn, percent: String(r.data.settings.commission.percent || ''), byUser: Object.fromEntries(Object.entries(r.data.settings.commission.byUser || {}).map(([k, v]) => [k, String(v)])) } })).catch((e) => setErr(errOf(e, 'The rules could not be read.'))); }, []);
  async function save() {
    setBusy(true); setErr('');
    const byUser = Object.fromEntries(Object.entries(d.f.byUser).filter(([, v]) => String(v).trim() !== '').map(([k, v]) => [k, num(v)]));
    try { await api.put('/crm/money-settings', { recurringOn: d.f.recurringOn, commission: { percent: num(d.f.percent) || 0, byUser } }); toast('Rules saved.'); onSaved(); } catch (e) { setErr(errOf(e, 'The rules could not be saved.')); } finally { setBusy(false); }
  }
  const setF = (patch) => setD({ ...d, f: { ...d.f, ...patch } });
  return (
    <Modal title="Commission and repeating invoices" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy || !d || !d.canChange} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {!d && !err && <div className="small-muted">Loading…</div>}
      {d && (
        <>
          <div className="field"><label>Commission % for everybody <span className="small-muted">0 = none</span></label><input inputMode="decimal" value={d.f.percent} onChange={(e) => setF({ percent: e.target.value })} style={{ width: 120 }} aria-label="Commission percent for everybody" /></div>
          <div className="field"><label>Per person <span className="small-muted">empty = the % above</span></label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 6, alignItems: 'center' }}>
              {(d.team || []).map((o) => <Fragment key={o.id}><span>{o.name}</span><input inputMode="decimal" value={d.f.byUser[o.id] || ''} placeholder={d.f.percent || '0'} onChange={(e) => setF({ byUser: { ...d.f.byUser, [o.id]: e.target.value } })} aria-label={`Commission percent for ${o.name}`} /></Fragment>)}
            </div>
          </div>
          <label className="mkt-switch" style={{ marginTop: 10 }}><input type="checkbox" checked={d.f.recurringOn} onChange={(e) => setF({ recurringOn: e.target.checked })} /><span><b>Repeating invoices made by themselves</b><br /><span className="small-muted">On the date, the next invoice of each repeat is made as a Draft and its owner is told. Off: only "Make the next one now" makes them.</span></span></label>
        </>
      )}
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
    </Modal>
  );
}

// ---- SLA hours (Customer support) -----------------------------------------------------------------------------------------
export function SlaHoursButton() {
  const { me, toast } = useCrm();
  const [open, setOpen] = useState(false); const [f, setF] = useState(null); const [err, setErr] = useState('');
  if (!me.canAssign) return null;
  const start = () => { setOpen(true); api.get('/crm/money-settings').then((r) => setF({ ...r.data.settings.slaHours })).catch((e) => setErr(errOf(e, 'The SLA could not be read.'))); };
  async function save() {
    try { await api.put('/crm/money-settings', { slaHours: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, num(v)])) }); toast('SLA hours saved. New tickets (and a changed priority) follow them.'); setOpen(false); } catch (e) { setErr(errOf(e, 'The SLA could not be saved.')); }
  }
  return (
    <>
      <button type="button" className="btn" onClick={start} title="How many hours a ticket has, per priority">SLA hours</button>
      {open && (
        <Modal title="SLA: hours to answer a ticket" onClose={() => setOpen(false)} foot={<><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn btn-primary" disabled={!f} onClick={save}>Save</button></>}>
          {f && ['Urgent', 'High', 'Medium', 'Low'].map((p) => <div key={p} className="field"><label>{p}</label><input inputMode="numeric" value={f[p]} onChange={(e) => setF({ ...f, [p]: e.target.value })} style={{ width: 120 }} aria-label={`${p} SLA hours`} /> <span className="small-muted">hours</span></div>)}
          <div className="small-muted">Between 1 and 720 hours. Tickets already open keep the time they were given.</div>
          {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)' }}>{err}</div>}
        </Modal>
      )}
    </>
  );
}

// ---- sales sequences (Leads > Sequences, and on a lead) ----------------------------------------------------------------------
const CH_WORD = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', task: 'Follow-up' };
export function SequencesView() {
  const [d, setD] = useState(null); const [err, setErr] = useState(''); const [edit, setEdit] = useState(null);
  const load = () => api.get('/crm/sequences').then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The sequences could not be read.')));
  useEffect(() => { load(); }, []);
  return (
    <div>
      <div className="filter-row" style={{ alignItems: 'center' }}>
        <span className="small-muted" style={{ fontSize: 12.5 }}>A sequence is a set of mails, messages and follow-ups over days that you put a lead on (from the lead, Follow-ups tab). It stops by itself when the lead replies, is won, lost or opted out. Nothing goes in quiet hours.</span>
        {d && d.canChange && <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setEdit({})}>+ Sequence</button>}
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {d && !d.sequences.length && <div className="empty"><h3>No sequences yet</h3>{d.canChange ? 'Make one: for example a mail today, a WhatsApp on day 2, a call follow-up on day 4.' : 'A Sales manager makes them.'}</div>}
      {d && d.sequences.map((s) => (
        <div key={s.id} className="card" style={{ padding: 12, marginBottom: 10, opacity: s.active ? 1 : 0.6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{s.name}</b>{!s.active && <Pill v="Off" />}<span className="small-muted" style={{ fontSize: 12 }}>{s.steps.length} steps · {s.running} lead{s.running === 1 ? '' : 's'} on it now</span>
            {d.canChange && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setEdit(s)}>Edit</button>}
          </div>
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>{s.steps.map((st, i) => <span key={i} className="small-muted" style={{ fontSize: 12, border: '1px solid var(--line, #e5e7eb)', borderRadius: 6, padding: '2px 6px' }}>Day {st.afterDays}: {CH_WORD[st.channel]}{st.subject ? ` · ${st.subject}` : ''}</span>)}</div>{/* eslint-disable-line react/no-array-index-key */}
        </div>
      ))}
      {edit && <SequenceDialog seq={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}
function SequenceDialog({ seq, onClose, onSaved }) {
  const { toast } = useCrm();
  const [name, setName] = useState(seq.name || '');
  const [active, setActive] = useState(seq.id ? seq.active : true);
  const [steps, setSteps] = useState(seq.steps && seq.steps.length ? seq.steps.map((s) => ({ ...s, afterDays: String(s.afterDays) })) : [{ channel: 'email', afterDays: '0', subject: 'Hello {name}', body: 'Hello {name},\n\n' }]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const setStep = (i, patch) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  async function save() {
    setBusy(true); setErr('');
    const body = { name, active, steps: steps.map((s) => ({ ...s, afterDays: Number(s.afterDays) })) };
    try { await (seq.id ? api.put(`/crm/sequences/${seq.id}`, body) : api.post('/crm/sequences', body)); toast('Sequence saved.'); onSaved(); } catch (e) { setErr(errOf(e, 'The sequence could not be saved.')); } finally { setBusy(false); }
  }
  return (
    <Modal title={seq.id ? `Edit ${seq.name}` : 'New sequence'} size="wide" onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="field"><label>Name</label><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Sequence name" /></div>
      <div className="small-muted" style={{ marginBottom: 6 }}>{'{name}'} is the person's name, {'{company}'} the company, {'{owner}'} the salesperson. Day 0 goes when the lead is put on it.{seq.id ? ' Leads already on it keep the steps they were given.' : ''}</div>
      {steps.map((s, i) => (
        <div key={i} className="card" style={{ padding: 8, marginBottom: 6 }}>{/* eslint-disable-line react/no-array-index-key */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>Step {i + 1}</b>
            <span className="small-muted">day</span><input inputMode="numeric" value={s.afterDays} onChange={(e) => setStep(i, { afterDays: e.target.value })} style={{ width: 60 }} aria-label={`Step ${i + 1} day`} />
            <select value={s.channel} onChange={(e) => setStep(i, { channel: e.target.value })} style={{ width: 'auto' }} aria-label={`Step ${i + 1} channel`}>{Object.entries(CH_WORD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {steps.length > 1 && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</button>}
          </div>
          {s.channel === 'email' && <input value={s.subject || ''} placeholder="Subject" onChange={(e) => setStep(i, { subject: e.target.value })} style={{ marginTop: 6 }} aria-label={`Step ${i + 1} subject`} />}
          <textarea rows={s.channel === 'email' ? 4 : 2} value={s.body} placeholder={s.channel === 'task' ? 'What the owner should do, e.g. Call and ask about the proposal' : 'The message'} onChange={(e) => setStep(i, { body: e.target.value })} style={{ marginTop: 6 }} aria-label={`Step ${i + 1} text`} />
        </div>
      ))}
      {steps.length < 10 && <button type="button" className="btn btn-sm" onClick={() => setSteps([...steps, { channel: 'whatsapp', afterDays: String(Number((steps[steps.length - 1] || {}).afterDays || 0) + 2), subject: '', body: '' }])}>+ Step</button>}
      {seq.id && <label className="mkt-switch" style={{ marginTop: 10 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><span>Switched on (leads can be put on it)</span></label>}
      {err && <div className="small-muted" role="alert" style={{ color: 'var(--red)', marginTop: 6 }}>{err}</div>}
    </Modal>
  );
}
export function LeadSequenceBox({ lead, onChanged }) {
  const { toast } = useCrm();
  const [d, setD] = useState(null); const [seqs, setSeqs] = useState([]); const [pick, setPick] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => api.get(`/crm/leads/${lead.id}/sequences`).then((r) => setD(r.data)).catch(() => setD(null));
  useEffect(() => { load(); api.get('/crm/sequences').then((r) => setSeqs(r.data.sequences.filter((s) => s.active))).catch(() => setSeqs([])); }, [lead.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  const cur = d.enrolments.find((e) => e.status === 'active');
  async function enrol() {
    setBusy(true);
    try { const r = await api.post(`/crm/leads/${lead.id}/sequences`, { sequenceId: pick }); toast(r.data.warn || 'Put on the sequence. The first step goes now (outside quiet hours).'); setPick(''); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'The lead could not be put on it.')); } finally { setBusy(false); }
  }
  async function stopIt() {
    try { await api.post(`/crm/leads/${lead.id}/sequences/stop`); toast('Sequence stopped.'); load(); if (onChanged) onChanged(); } catch (e) { toast(errOf(e, 'It could not be stopped.')); }
  }
  if (!cur && !d.canEnrol && !d.enrolments.length) return null;
  return (
    <div className="card" style={{ padding: 10, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="section-label" style={{ margin: 0 }}>Sequence</div>
        {cur ? <span style={{ fontSize: 13 }}>On <b>{cur.name}</b> · {cur.steps.filter((s) => s.status === 'sent').length} of {cur.steps.length} done</span> : <span className="small-muted" style={{ fontSize: 12.5 }}>Not on a sequence.</span>}
        {cur && d.canEnrol && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={stopIt}>Stop</button>}
        {!cur && d.canEnrol && seqs.length > 0 && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: 'auto' }} aria-label="Sequence to put the lead on"><option value="">Pick a sequence…</option>{seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <button type="button" className="btn btn-sm btn-primary" disabled={!pick || busy} onClick={enrol}>Put on it</button>
          </span>
        )}
        {!cur && d.canEnrol && !seqs.length && <span className="small-muted" style={{ fontSize: 12 }}>No sequence is made yet (Leads › Sequences).</span>}
      </div>
      {cur && <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>{cur.steps.map((s) => `${s.status === 'waiting' ? `due ${dateOf(s.dueAt)}` : s.status}${s.result ? ` (${s.result})` : ''}`).map((t, i) => `Step ${i + 1}: ${t}`).join(' · ')}</div>}
      {!cur && d.enrolments[0] && <div className="small-muted" style={{ fontSize: 12, marginTop: 4 }}>Last: {d.enrolments[0].name} — {d.enrolments[0].status}{d.enrolments[0].stopWhy ? ` (${d.enrolments[0].stopWhy})` : ''}</div>}
    </div>
  );
}
