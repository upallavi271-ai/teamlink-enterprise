// ONE CLIENT = ONE ROW (founder spec, 2026-10-14).
//
// <ClientInvoiceRows> draws, for each client invoice (invoices/clientInvoice.js),
// the 7-column list row  Invoice No · Invoice Date · Client · Billing · Total
// amount · Status · Actions  and, directly under it when it is open, the detail
// panel: the candidates, the money, the dates and papers, the payments and the
// four buttons.
//
// The row, the Invoice No and the ▸ arrow all call the SAME toggle(key). The
// action buttons stop the click, so they never also open the panel. Several panels
// can be open at once. Used by the Invoice list (Group by Invoice) and inside a
// client's rows (Group by Client).
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { money, money2, fmtD } from './invFormat';
import WaButton from '../../components/wa/WaButton.jsx'; // free WhatsApp quick chat (payment reminder)
import './clientInvoice.css';

// Founder spec 2026-10-15: 24 columns, Invoice No pinned left, Actions pinned right.
export const CI_HEADS = [
  ['inv', 'Invoice No'], ['date', 'Invoice Date'], ['client', 'Client'], ['btype', 'Billing Type'],
  ['cgstin', 'Client GSTIN'], ['dept', 'Department'], ['rec', 'Recruiter'], ['cands', 'Candidates'],
  ['payinggst', 'Client Paying GST'], ['before', 'Before GST'], ['gst', 'GST Amount'], ['after', 'After GST'],
  ['tds', 'TDS'], ['receivable', 'Receivable'], ['received', 'Received'], ['pending', 'Pending'],
  ['pays', 'Payments'], ['proof', 'Proof'], ['tdscert', 'TDS Cert'], ['status', 'Status'],
  ['due', 'Due Date'], ['age', 'Age'], ['sent', 'Sent'], ['act', 'Actions'],
];
export const CI_NUM = new Set(['before', 'gst', 'after', 'tds', 'receivable', 'received', 'pending', 'cands']);
export const ciHeadClass = (key) => [CI_NUM.has(key) ? 'num' : '', `c-${key}`, key === 'inv' ? 'stk-l1' : '', key === 'act' ? 'stk-r' : ''].filter(Boolean).join(' ');

const tdsWordOf = (g) => (g.tdsLines === 0 ? '—' : g.tdsInHand === g.tdsLines ? 'Received' : (g.tdsInHand ? `${g.tdsInHand} of ${g.tdsLines}` : 'Pending'));
const sentShort = (g) => (g.sentAll ? `${g.sentVia}${g.sentDate ? ` · ${fmtD(g.sentDate)}` : ''}` : (g.sentSome ? 'Some only' : 'Not sent'));
const modesOf = (g) => [...new Set(g.payments.map((p) => p.method).filter(Boolean))].join(', ') || '—';
const joinOrDash = (a) => (a && a.length ? a.join(', ') : '—');

const STATUS_CLASS = { Overdue: 'priority-high', Paid: 'priority-low', 'Partially Paid': 'priority-medium' };
const AGE_TONE = { Settled: 'priority-low', 'Not due yet': '', '0–30 days': 'priority-medium', '31–60 days': 'priority-medium', '61–90 days': 'priority-high', '90+ days': 'priority-high' };
const ageText = (a) => String(a || '—').replace(/–/g, '-');
const pctOf = (m) => {
  let p = m.feePercent;
  if (p == null && m.offeredCtc > 0 && m.billing > 0) p = (m.billing / m.offeredCtc) * 100;
  return p == null ? '—' : `${Number(Number(p).toFixed(2))}%`;
};

// The date of joining of one candidate: shown as "31 Aug 2026"; when the ATS has none,
// "—" with a small Add link (for logins that may edit joining dates). Saving writes the
// candidate's ATS application, then the panel refreshes.
function JoiningCell({ m, canJoin, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    if (!val) { setErr('Pick the date.'); return; }
    setBusy(true); setErr('');
    try {
      await api.patch(`/invoices/${m.id}/joining-date`, { joiningDate: val });
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e.response?.data?.error || 'That did not save.');
    }
    setBusy(false);
  };
  if (m.joiningDate) return <span>{fmtD(m.joiningDate)}</span>;
  if (editing) {
    return (
      <span className="ci-join-edit">
        <input type="date" value={val} onChange={(e) => setVal(e.target.value)} aria-label={`Date of joining of ${m.candidateName || 'the candidate'}`} />
        <button type="button" className="btn btn-sm btn-gold" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="link-btn" onClick={() => { setEditing(false); setErr(''); }}>Cancel</button>
        {err && <span className="inv-err">{err}</span>}
      </span>
    );
  }
  return (
    <span>
      —
      {canJoin && m.applicationId && <> <button type="button" className="link-btn ci-add" onClick={() => setEditing(true)} title="Add the date this candidate joined (saved on the candidate's record)">Add</button></>}
    </span>
  );
}

function Panel({
  g, canPay, canJoin, onPay, onAccount, onView, onChanged, onClose,
}) {
  const payable = canPay && g.pending > 0.5 && g.status !== 'Cancelled';
  const tdsWord = g.tdsLines === 0 ? '—' : g.tdsInHand === g.tdsLines ? 'Received' : (g.tdsInHand ? `${g.tdsInHand} of ${g.tdsLines} received` : 'Pending');
  const sentWord = g.sentAll ? `${g.sentVia}${g.sentDate ? ` · ${fmtD(g.sentDate)}` : ''}` : (g.sentSome ? 'Sent for some candidates only' : 'Not sent');
  const row = (k, v, cls) => (<div className={`ci-kv${cls ? ` ${cls}` : ''}`}><span>{k}</span><b>{v}</b></div>);
  return (
    <div className="ci-panel-in">
      <section className="ci-sec">
        <h4>Candidates in this invoice</h4>
        {g.hiddenByFilters > 0 && (
          <div className="ci-note">Showing {g.candidates} of {g.candidates + g.hiddenByFilters} candidates — your filters hide the rest, and the amounts below add up only these.</div>
        )}
        <div className="ci-tw">
          <table className="ci-cands">
            <thead>
              <tr>
                <th>#</th><th>Candidate name</th><th>Date of joining</th><th>Role / Designation</th>
                <th className="num">Salary (CTC)</th><th className="num">Billing %</th><th className="num">Fee before GST</th><th className="num">GST</th><th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {g.members.map((m, i) => (
                <tr key={m.id}>
                  <td>{i + 1}</td>
                  <td>
                    {m.candidateName
                      ? <Link to={`/invoices/${m.id}`} title={`Open ${m.invoiceNumber} — GST, TDS, credit note, certificate`}>{m.candidateName}</Link>
                      : <Link to={`/invoices/${m.id}`}>(no candidate linked)</Link>}
                    <div className="small-muted">{m.invoiceNumber}{m.recruiter ? ` · ${m.recruiter}` : ''}</div>
                  </td>
                  <td><JoiningCell m={m} canJoin={canJoin} onChanged={onChanged} /></td>
                  <td>{m.role || '—'}</td>
                  <td className="num">{m.offeredCtc != null ? money(m.offeredCtc) : '—'}</td>
                  <td className="num">{pctOf(m)}</td>
                  <td className="num">{money2(m.billing)}</td>
                  <td className="num">{money2(m.gst)}</td>
                  <td className="num"><b>{money2(m.invoiceValue)}</b></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}><b>Total</b> <span className="small-muted">{g.candidates} candidate{g.candidates === 1 ? '' : 's'}</span></td>
                <td className="num">{money2(g.billing)}</td>
                <td className="num">{money2(g.gst)}</td>
                <td className="num"><b>{money2(g.invoiceValue)}</b></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="ci-more small-muted">
          {g.gstins.length ? `Client GSTIN ${g.gstins.join(', ')}` : 'Client GSTIN not on file'}
          {g.departments.length ? ` · Department ${g.departments.join(', ')}` : ''}
          {g.billingTypes.length ? ` · Billing ${g.billingTypes.join(' / ')}` : ''}
        </div>
      </section>

      <div className="ci-cards">
        <section className="ci-card">
          <h4>What this invoice is made of</h4>
          {row('Fee before GST', money2(g.billing))}
          {row('GST charged', money2(g.gst))}
          {row('Invoice value after GST', money2(g.invoiceValue))}
          {row('Less TDS deducted by client', money2(g.tds))}
          {row('Amount receivable', money2(g.receivable))}
          {row('Received so far', money2(g.received), 'ci-green')}
          {row('Still pending', money2(g.pending), g.pending > 0.5 ? 'ci-red' : '')}
        </section>
        <section className="ci-card">
          <h4>Dates &amp; papers</h4>
          {row('Invoice date', fmtD(g.invoiceDate))}
          {row('Payment due', <>{fmtD(g.dueDate)}{g.pending > 0.5 && g.daysOverdue > 0 ? <span className="status priority-high ci-gap">{g.daysOverdue} days late</span> : null}</>)}
          {row('Age', <span className={`status ${AGE_TONE[g.age] || ''}`}>{ageText(g.age)}</span>)}
          {row('Sent to client', sentWord)}
          {row('TDS certificate', tdsWord)}
        </section>
      </div>

      <section className="ci-sec">
        <h4>Payments against this invoice</h4>
        {g.payments.length === 0 ? (
          <p className="small-muted ci-none">No payment recorded against this invoice yet.</p>
        ) : (
          <div className="ci-tw">
            <table className="ci-pays">
              <thead><tr><th>Date</th><th className="num">Amount</th><th>Mode</th><th>Reference</th><th>Proof</th></tr></thead>
              <tbody>
                {g.payments.map((p) => (
                  <tr key={p.id} title={p.lines > 1 ? `One payment shared across ${p.lines} candidate lines` : undefined}>
                    <td>{p.date ? fmtD(p.date) : 'date not recorded'}</td>
                    <td className="num">{money2(p.amount)}</td>
                    <td>{p.method || '—'}</td>
                    <td>{p.reference || p.bankLineReference || '—'}</td>
                    <td>
                      {p.proof === 'bank statement'
                        ? <Link to={`/invoices/${p.invoiceId}#proof`}>Bank statement</Link>
                        : (p.proof || <span className="small-muted">—</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="ci-btns">
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        {g.clientId && <button type="button" className="btn btn-sm btn-primary" onClick={onAccount}><span aria-hidden="true">₹ </span>Full account</button>}
        <button type="button" className="btn btn-sm" onClick={onView}>Printable invoice</button>
        {payable && <button type="button" className="btn btn-sm btn-gold" onClick={onPay}>Record a payment</button>}
      </div>
    </div>
  );
}

// One client invoice: its list row and, when open, the panel under it.
export function ClientInvoiceRow({
  g, open, toggle, hot, canPay, canJoin, onPay, onAccount, onView, onChanged, wa = null,
}) {
  const toggleMe = () => toggle(g.key);
  const stop = (e) => e.stopPropagation();
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleMe(); }
  };
  const payable = canPay && g.pending > 0.5 && g.status !== 'Cancelled';
  return (
    <Fragment>
      <tr data-inv={g.id} tabIndex={-1} className={`inv-row ci-row${open ? ' is-open' : ''}${hot ? ' hot' : ''}`} onClick={toggleMe}>
        <td className="ci-no stk-l1">
          {wa && g.status !== 'Cancelled' && g.ids && g.ids[0] && (
            <input type="checkbox" className="ci-watick" style={{ marginRight: 6 }} aria-label={`Select ${g.invoiceNumber} for WhatsApp`} checked={wa.sel.has(g.ids[0])} onClick={(e) => e.stopPropagation()} onChange={() => wa.toggle(g.ids[0])} />
          )}
          <span
            role="button"
            tabIndex={0}
            className="ci-toggle"
            aria-expanded={open}
            aria-label={`${g.invoiceNumber} — ${open ? 'hide' : 'show'} the candidates and payments`}
            onKeyDown={onKey}
          >
            <span className="ci-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
            <span className="inv-mono ci-numtxt">{g.invoiceNumber}</span>
          </span>
          {g.status === 'Cancelled' && <div className="small-muted">cancelled</div>}
        </td>
        <td>{fmtD(g.invoiceDate)}</td>
        <td title={g.client}><div className="inv-cell-ellip ci-client">{g.client}</div></td>
        <td title={g.billingTypes.join('\n') || undefined}><div className="inv-cell-ellip inv-ell-bt">{g.billingType}</div></td>
        <td title={g.gstins.join('\n') || undefined}>{joinOrDash(g.gstins)}</td>
        <td><div className="inv-cell-ellip inv-ell-bt" title={g.departments.join(', ') || undefined}>{joinOrDash(g.departments)}</div></td>
        <td><div className="inv-cell-ellip inv-ell-rec" title={g.recruiters.join(', ') || undefined}>{joinOrDash(g.recruiters)}</div></td>
        <td className="num">{g.candidates}</td>
        <td>{g.gstOn ? 'Yes' : 'No'}</td>
        <td className="num">{money2(g.billing)}</td>
        <td className="num">{money2(g.invoiceValue - g.billing)}</td>
        <td className="num" title="After GST, before TDS — the sum of all its candidates">{money2(g.invoiceValue)}</td>
        <td className="num">{money2(g.tds)}</td>
        <td className="num">{money2(g.receivable)}</td>
        <td className="num">{money2(g.received)}</td>
        <td className="num">{money2(g.pending)}</td>
        <td>{modesOf(g)}</td>
        <td>{g.proofCount > 0 ? `${g.proofCount} bank line${g.proofCount === 1 ? '' : 's'}` : '—'}</td>
        <td>{tdsWordOf(g)}</td>
        <td>
          <span className={`status ${STATUS_CLASS[g.status] || ''}`}>{g.status}</span>
          {g.payNote && <div className={`ci-paynote ci-paynote-${g.payNoteTone || 'amber'}`} title={g.payNoteWhy || ''}>{g.payNote}</div>}
        </td>
        <td>{g.dueDate ? fmtD(g.dueDate) : '—'}</td>
        <td><span className={`status ${AGE_TONE[g.age] || ''}`}>{ageText(g.age)}</span></td>
        <td>{sentShort(g)}</td>
        <td className="ci-act stk-r" onClick={stop}>
          <div className="inv-acts">
            {g.clientId && <button type="button" className="btn btn-sm" title={`${g.client} — every invoice and receipt, as a ledger`} onClick={onAccount}><span aria-hidden="true">₹ </span>Account</button>}
            <button type="button" className="btn btn-sm" title="See the invoice as the client gets it" onClick={onView}><span aria-hidden="true">👁 </span>View</button>
            {g.status !== 'Cancelled' && g.ids && g.ids[0] && <WaButton entityType="invoice" id={g.ids[0]} name={`${g.client} ${g.invoiceNumber}`} />}
            {payable && <button type="button" className="btn btn-sm btn-gold" title={g.proofOnlyCount ? 'Proof is attached but no payment is recorded yet - record what was received' : undefined} onClick={onPay}>+ Payment</button>}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="ci-panel">
          <td colSpan={CI_HEADS.length}>
            <Panel g={g} canPay={canPay} canJoin={canJoin} onPay={onPay} onAccount={onAccount} onView={onView} onChanged={onChanged} onClose={toggleMe} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// A list of client invoices as <tr> pairs (for the tbody of the caller's table).
export default function ClientInvoiceRows({ groups, open, toggle, hot, handlers }) {
  return groups.map((g) => (
    <ClientInvoiceRow
      key={g.key}
      g={g}
      open={open.has(g.key)}
      toggle={toggle}
      hot={hot === g.id || (hot && g.ids.includes(hot))}
      canPay={handlers.canPay}
      canJoin={handlers.canJoin}
      onPay={() => handlers.onPay(g)}
      onAccount={() => handlers.onAccount(g)}
      onView={() => handlers.onView(g)}
      onChanged={handlers.onChanged}
      wa={handlers.wa || null}
    />
  ));
}
