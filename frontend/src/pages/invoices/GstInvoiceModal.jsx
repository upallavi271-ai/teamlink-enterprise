// The printable GST invoice, in a modal. Everything on it comes from
// GET /invoices/:id/document — the same payload the pop-up copy prints — so the
// paper can never disagree with the register:
//   * CGST + SGST (half the rate each, 9% + 9% at 18%) within the state, IGST
//     when the client's state (its GSTIN, else its address) differs from ours
//     (the Company GSTIN, else the Company state);
//   * SAC 998512 against the line, the amount in words in lakh / crore;
//   * the letterhead, GSTIN and bank details from the Company row — the one
//     Office & Expenses → Business details edits.
// The modal is portalled to <body> and invoices.css hides everything else when
// printing, so Print sends the invoice sheet and nothing around it.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../api';
import { money2, fmtD } from './invFormat';

const n2 = (v) => money2(v).replace('₹', '');

export default function GstInvoiceModal({ invoiceId, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.get(`/invoices/${invoiceId}/document`)
      .then((r) => { if (live) setD(r.data); })
      .catch((e) => { if (live) setErr(e.response?.data?.error || 'The invoice could not be loaded.'); });
    return () => { live = false; };
  }, [invoiceId]);

  useEffect(() => {
    document.body.classList.add('inv-printing');
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('inv-printing');
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const co = d?.company;
  const gst = d ? Number(d.totals.gst || 0) : 0;
  const missing = [];
  if (co && !co.gstin) missing.push('our GSTIN');
  if (co && !co.bank.accountNumber) missing.push('the bank account');
  if (d && !d.client.gstin && gst > 0.5) missing.push("the client's GSTIN");

  const sheet = d && (
    <div className="inv-sheet">
      <div className="inv-sh-top">
        <div className="inv-sh-co">
          <div className="inv-sh-logo">{co.logoUrl ? <img src={co.logoUrl} alt="" /> : 'TL'}</div>
          <div>
            <div className="inv-sh-coname">{co.legalName}</div>
            {co.addressLines.map((a) => <div key={a}>{a}</div>)}
            <div>
              GSTIN <b>{co.gstin || '—'}</b>
              {co.pan ? <> · PAN {co.pan}</> : null}
            </div>
            {(co.email || co.phone) && <div>{[co.email, co.phone].filter(Boolean).join(' · ')}</div>}
          </div>
        </div>
        <div className="inv-sh-title">
          <div className="inv-sh-doc">{d.title}</div>
          <div className="inv-sh-copy">Original for recipient</div>
        </div>
      </div>

      <div className="inv-sh-meta">
        <div className="inv-sh-billto">
          <div className="inv-sh-lbl">Bill to</div>
          <b>{d.client.name}</b>
          {d.client.addressLines.map((a) => <div key={a}>{a}</div>)}
          <div>GSTIN: <b>{d.client.gstin || 'Not registered'}</b></div>
          <div>State: {d.clientState || d.placeOfSupply || '—'}</div>
        </div>
        <table className="inv-sh-kv">
          <tbody>
            <tr><th>Invoice no.</th><td className="inv-mono">{d.invoiceNumber}</td></tr>
            <tr><th>Invoice date</th><td>{fmtD(d.invoiceDate)}</td></tr>
            <tr><th>Payment due</th><td>{fmtD(d.dueDate)}{d.terms ? ` · ${d.terms}` : ''}</td></tr>
            <tr><th>Place of supply</th><td>{d.placeOfSupply || '—'}</td></tr>
            <tr><th>Supply type</th><td>{d.supplyType}</td></tr>
            <tr><th>Billing type</th><td>{d.billingType}</td></tr>
            <tr><th>Reverse charge</th><td>No</td></tr>
          </tbody>
        </table>
      </div>

      <table className="inv-sh-items">
        <thead>
          <tr>
            <th style={{ width: 26 }}>#</th>
            <th style={{ width: '32%' }}>Description of service</th>
            <th>HSN/SAC</th>
            <th className="n">Salary (₹)</th>
            <th className="n">Rate</th>
            <th className="n">Taxable value (₹)</th>
            {gst > 0.5 && (d.inter
              ? <th className="n">IGST {d.gstPct}% (₹)</th>
              : <><th className="n">CGST {d.halfPct}% (₹)</th><th className="n">SGST {d.halfPct}% (₹)</th></>)}
            <th className="n">Amount (₹)</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.n}>
              <td>{l.n}</td>
              <td>
                <b>Recruitment &amp; placement fee</b>
                <div className="d">
                  {[l.candidate || l.description, l.role].filter(Boolean).join(' — ')}
                  {l.joiningDate ? ` · joined ${fmtD(l.joiningDate)}` : ''}
                </div>
              </td>
              <td>{l.sac}</td>
              <td className="n">{l.offeredCtc != null ? n2(l.offeredCtc) : '—'}</td>
              <td className="n">{l.feePercent != null ? `${l.feePercent}%` : '—'}</td>
              <td className="n">{n2(l.rate)}</td>
              {gst > 0.5 && (d.inter
                ? <td className="n">{n2(l.gst)}</td>
                : <><td className="n">{n2(l.cgst)}</td><td className="n">{n2(l.sgst)}</td></>)}
              <td className="n"><b>{n2(Number(l.rate || 0) + Number(l.gst || 0))}</b></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="inv-sh-bottom">
        <div className="inv-sh-left">
          <div className="inv-sh-box">
            <div className="inv-sh-lbl">Invoice total in words</div>
            <div className="inv-sh-words">{d.words.total}</div>
            {d.words.netAfterTds && (
              <>
                <div className="inv-sh-lbl" style={{ marginTop: 8 }}>Net payable after TDS in words</div>
                <div className="inv-sh-words">{d.words.netAfterTds}</div>
              </>
            )}
          </div>
          <div className="inv-sh-box">
            <div className="inv-sh-lbl">Bank details for NEFT / RTGS</div>
            <table className="inv-sh-bank">
              <tbody>
                <tr><td>Account name</td><td>{co.bank.accountName || '—'}</td></tr>
                <tr><td>Bank &amp; branch</td><td>{[co.bank.bankName, co.bank.branch].filter(Boolean).join(', ') || '—'}</td></tr>
                <tr><td>Account no.</td><td className="inv-mono">{co.bank.accountNumber || '—'}</td></tr>
                <tr><td>IFSC</td><td className="inv-mono">{co.bank.ifsc || '—'}</td></tr>
                {co.bank.accountType && <tr><td>Account type</td><td>{co.bank.accountType}</td></tr>}
                {co.bank.upi && <tr><td>UPI</td><td>{co.bank.upi}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="inv-sh-note">
            {gst > 0.5 ? '' : 'GST not charged on this bill. '}
            {d.totals.tds > 0 ? `TDS @ ${d.tdsPct}% under section 194J applies on the fee before GST (${money2(d.totals.subTotal)} → ${money2(d.totals.tds)}). Please share Form 16A each quarter. ` : ''}
            SAC {co.sac}: permanent placement services.
          </div>
        </div>
        <table className="inv-sh-totals">
          <tbody>
            <tr><td>Sub-total (taxable value)</td><td>{money2(d.totals.subTotal)}</td></tr>
            {gst > 0.5 && (d.inter
              ? <tr><td>IGST @ {d.gstPct}%</td><td>{money2(d.totals.gst)}</td></tr>
              : (
                <>
                  <tr><td>CGST @ {d.halfPct}%</td><td>{money2(d.totals.cgst)}</td></tr>
                  <tr><td>SGST @ {d.halfPct}%</td><td>{money2(d.totals.sgst)}</td></tr>
                </>
              ))}
            <tr className="t-strong"><td>Invoice total</td><td>{money2(d.totals.invoiceValue)}</td></tr>
            {d.totals.tds > 0 && <tr><td>Less: TDS @ {d.tdsPct}% u/s 194J</td><td>− {money2(d.totals.tds)}</td></tr>}
            {d.totals.paid > 0 && <tr><td>Less: received</td><td>− {money2(d.totals.paid)}</td></tr>}
            {d.totals.credited > 0 && <tr><td>Less: credit notes</td><td>− {money2(d.totals.credited)}</td></tr>}
            {d.totals.debited > 0 && <tr><td>Add: debit notes</td><td>{money2(d.totals.debited)}</td></tr>}
            <tr className="t-due"><td>Balance due</td><td>{money2(d.totals.balance)}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="inv-sh-foot">
        <div className="inv-sh-terms">
          <div className="inv-sh-lbl">Terms</div>
          <ol>
            <li>Payment due by {fmtD(d.dueDate)}{d.terms ? ` (${d.terms})` : ''}.</li>
            <li>Please quote invoice no. {d.invoiceNumber} with your payment.</li>
            {d.totals.tds > 0 && <li>TDS is deductible on the professional fee only, not on GST.</li>}
          </ol>
        </div>
        <div className="inv-sh-sign">
          <div>For {co.legalName}</div>
          <div className="inv-sh-signline" />
          <div><b>Authorised Signatory</b></div>
        </div>
      </div>
      <div className="inv-sh-center">This is a computer-generated invoice from TeamLink Accounts.</div>
    </div>
  );

  return createPortal(
    <div className="overlay show inv-print-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal inv-print-modal" role="dialog" aria-modal="true" aria-label="Printable invoice">
        <div className="modal-head">
          <div>
            <h3 style={{ fontSize: 15, margin: 0 }}>Printable invoice</h3>
            <div className="small-muted">{d ? `${d.invoiceNumber} · ${d.client.name}` : 'Loading…'}</div>
          </div>
          <div className="qa-row" style={{ marginTop: 0 }}>
            <button type="button" className="btn btn-sm btn-gold" disabled={!d} onClick={() => window.print()}>Print</button>
            <button type="button" className="close-x" aria-label="Close" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="modal-body">
          {err && <div className="notice red"><span>{err}</span></div>}
          {!d && !err && <div className="small-muted">Loading…</div>}
          {missing.length > 0 && (
            <div className="notice amber inv-print-warn">
              <span>Not on file yet: {missing.join(', ')}. Add ours in Office &amp; Expenses → Business &amp; portals, and the client&apos;s in Client Master — the invoice prints “—” until then.</span>
            </div>
          )}
          {sheet && <div className="inv-print-scroll">{sheet}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
