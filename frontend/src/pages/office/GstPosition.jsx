// GST POSITION (Accounts spec S1.7) — what the period puts under our GSTIN:
// OUTWARD (what we billed clients), INWARD (what we bought) and THE POSITION,
// the GST that cannot be claimed yet with the bills behind it, and Add GSTIN.
// Every figure is live from GET /office-expenses/overview (routes/office.js
// officeFacts()), following the page period and the page filters (the
// invoice side follows the period only). This replaces the old "GST
// Reconciliation" with its invoice-level and purchase-level reconciliation
// lists (removed by S1.5).
import { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import ScrollSync from '../../components/accounts/ScrollSync.jsx';
import AddGstin from './AddGstin.jsx';
import { money, fmtD } from './officeUtil';
import './gstposition.css';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function Card({
  label, value, sub, tone = 'blue', mono = false, onClick,
}) {
  return (
    <div className={`gp-card gp-${tone}`}>
      <div className="gp-card-l">{label}</div>
      <div className={`gp-card-v${mono ? ' gp-mono-s' : ''}`}>{value}</div>
      {onClick ? <button type="button" className="gp-card-link" onClick={onClick}>{sub}</button> : <div className="gp-card-s">{sub}</div>}
    </div>
  );
}

function ClientsModal({ clients, onClose }) {
  const t = clients.reduce((a, c) => ({ n: a.n + c.n, taxable: a.taxable + c.taxable, gst: a.gst + c.gst, value: a.value + c.value }), {
    n: 0, taxable: 0, gst: 0, value: 0,
  });
  return (
    <Modal title="Who the invoices went to" note={plural(clients.length, 'client')} onClose={onClose} size="wide"
      footer={<button type="button" className="btn btn-primary" onClick={onClose} autoFocus>Close</button>}>
      <ScrollSync className="gp-tbl">
        <table>
          <thead>
            <tr><th>Client</th><th className="num">Invoices</th><th className="num">Before GST</th><th className="num">GST amount</th><th className="num">After GST</th></tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.name}><td><b>{c.name}</b></td><td className="num">{c.n}</td><td className="num">{money(c.taxable)}</td><td className="num">{money(c.gst)}</td><td className="num">{money(c.value)}</td></tr>
            ))}
            {clients.length === 0 && <tr><td colSpan={5} className="empty-mini">No invoices in this period.</td></tr>}
          </tbody>
          {clients.length > 0 && (
            <tfoot>
              <tr><td>Total</td><td className="num">{t.n}</td><td className="num">{money(t.taxable)}</td><td className="num">{money(t.gst)}</td><td className="num">{money(t.value)}</td></tr>
            </tfoot>
          )}
        </table>
      </ScrollSync>
    </Modal>
  );
}

export default function GstPosition({
  facts, canManage, onChanged, onShowAtRisk, onCompany,
}) {
  const [adding, setAdding] = useState(null);
  const [clientsOpen, setClientsOpen] = useState(false);
  if (!facts) return <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</div>;
  const d = facts.recon;
  const o = d.outward; const i = d.inward; const p = d.position;
  const top = d.riskVendors.slice(0, 3);
  const more = Math.max(0, d.riskVendors.length - top.length);
  const shown = d.riskBills.slice(0, 12);
  const rest = d.riskBills.length - shown.length;
  const credit = p.payable < 0;

  return (
    <div className="gp">
      <div className="gp-main">
        <div className="gp-hd">
          <div className="gp-hd-t">
            <b>Under our GSTIN · <span className="gp-mono">{d.ourGstin || 'not set'}</span></b>
            <div className="gp-hd-s">
              {[d.ourCompany, d.ourState].filter(Boolean).join(' · ') || 'Company details not filled in'} — what this period puts under that number
            </div>
          </div>
          {onCompany && <button type="button" className="btn btn-sm gp-out" onClick={onCompany}>Company details →</button>}
        </div>

        <div className="gp-band">Outward — what we billed clients</div>
        <div className="gp-cards">
          <Card label="Taxable value" value={money(o.taxable)} sub="Fee before GST" />
          <Card label="GST charged" value={money(o.charged)} sub="Collected for Government" tone="gold" />
          <Card label="Invoice value" value={money(o.value)} sub="Before GST + GST" />
          <Card label="Invoices raised" value={o.invoices} sub="Under this GSTIN · who they went to →" onClick={() => setClientsOpen(true)} />
        </div>

        <div className="gp-band">Inward — what we bought</div>
        <div className="gp-cards">
          <Card label="Purchases with GST" value={money(i.purchases)} sub={plural(i.bills, 'bill')} />
          <Card label="GST paid on them" value={money(i.gstPaid)} sub="On vendor and office bills" tone="gold" />
          <Card label="Input credit you can claim" value={money(i.claimable)} sub={`Vendor GSTIN on file (${i.claimableBills})`} tone="green" />
          <Card label="At risk" value={money(i.atRisk)} sub={`No vendor GSTIN on ${plural(i.atRiskBills, 'bill')}`} tone="red" />
        </div>

        <div className="gp-band">The position</div>
        <div className="gp-cards">
          <Card label="Total under this GSTIN" value={money(p.total)} sub={`billed ${money(p.billed)} + bought ${money(p.bought)}`} />
          <Card label={credit ? 'Credit carried forward' : 'Payable to Government'} value={money(Math.abs(p.payable))}
            sub={`charged ${money(o.charged)} − claimed ${money(i.claimable)}`} tone={credit ? 'green' : 'red'} />
          <Card label="If the GSTINs are filled in" value={money(p.ifFilled)} sub={`you would pay ${money(p.saving)} less`} tone="green" />
          <Card label="Our GSTIN" value={d.ourGstin || 'Not set'} sub={d.ourState || 'Add it in Company details'} mono />
        </div>
      </div>

      {i.atRisk > 0.5 && (
        <>
          <div className="gp-warn" role="note">
            <span className="gp-bell" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="18" height="18"><path d="M10 2.5a5 5 0 0 0-5 5v3.2L3.6 13.4a.8.8 0 0 0 .7 1.2h11.4a.8.8 0 0 0 .7-1.2L15 10.7V7.5a5 5 0 0 0-5-5Zm-2 13.3a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
            </span>
            <span>
              <b>{money(i.atRisk)}</b> of GST cannot be claimed until the vendor&apos;s GSTIN is on the bill —{' '}
              {top.map((v, ix) => (
                <span key={v.name}>
                  {ix > 0 && (ix === top.length - 1 && more === 0 ? ' and ' : ', ')}
                  <b>{v.name}</b> <b>{money(v.gst)}</b>{v.bills.length ? ` (${v.bills.slice(0, 2).join(', ')}${v.bills.length > 2 ? '…' : ''})` : ''}
                </span>
              ))}
              {more > 0 && ` and ${more} more`}.
            </span>
          </div>
          <div className="gp-warn-act">
            {onShowAtRisk && (
              <button type="button" className="gp-goldbtn" onClick={onShowAtRisk}>
                Show me those {plural(i.atRiskBills, 'bill')} in the table →
              </button>
            )}
          </div>

          <div className="gp-list" role="list">
            {shown.map((b) => (
              <div key={b.id} className="gp-row" role="listitem">
                <div className="gp-row-l">
                  <b>{b.vendor || 'No vendor named'}</b>
                  <div className="gp-row-s">{[b.category, b.billNo ? `Bill ${b.billNo}` : 'No bill no', fmtD(b.date)].filter(Boolean).join(' · ')}</div>
                </div>
                <div className="gp-row-r">
                  <span className="gp-row-b">before GST <span className="gp-mono">{money(b.base)}</span></span>
                  <b className="gp-row-g">GST <span className="gp-mono">{money(b.gst)}</span></b>
                  {canManage && adding !== b.id && <button type="button" className="btn btn-sm gp-out" onClick={() => setAdding(b.id)}>Add GSTIN</button>}
                </div>
                {adding === b.id && (
                  <div className="gp-row-add">
                    <AddGstin bill={b} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); onChanged(); }} />
                  </div>
                )}
              </div>
            ))}
            {rest > 0 && <div className="gp-more">...and {rest} more — press the button above to see them all.</div>}
          </div>
        </>
      )}
      {i.atRisk <= 0.5 && i.bills > 0 && (
        <div className="gp-ok">Every bill with GST in this period has a valid vendor GSTIN — all {money(i.gstPaid)} can be claimed.</div>
      )}
      {clientsOpen && <ClientsModal clients={o.clients} onClose={() => setClientsOpen(false)} />}
    </div>
  );
}
