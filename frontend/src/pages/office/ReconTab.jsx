// Section 6 — GST reconciliation: outward (from the invoicing module) against
// inward (these bills), the position, and the GST at risk bill by bill.
import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../../components/Modal.jsx';
import AddGstin from './AddGstin.jsx';
import { money, fmtD } from './officeUtil';

function Card({
  label, n, s, tone, children,
}) {
  return (
    <div className={`statitem oe-card${tone ? ` acct-${tone}` : ''}`}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
      {s && <div className="s">{s}</div>}
      {children}
    </div>
  );
}

export default function ReconTab({
  period, canManage, onShowAtRisk, onChanged, reloadKey,
}) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(null);
  const [clients, setClients] = useState(false);

  const load = useCallback(() => {
    api.get('/office-expenses/reconciliation', { params: { period } })
      .then((r) => { setD(r.data); setErr(''); })
      .catch((e) => setErr(e.response?.data?.error || 'The GST reconciliation could not be loaded.'));
  }, [period]);
  useEffect(load, [load, reloadKey]);

  if (err) return <div className="notice red"><span>{err}</span></div>;
  if (!d) return <div className="small-muted">Loading…</div>;
  const o = d.outward; const i = d.inward; const p = d.position;
  const top = d.riskVendors.slice(0, 3);
  const more = d.riskVendors.length - top.length;

  const head = [d.ourGstin || 'GSTIN not set', d.ourCompany, d.ourState].filter(Boolean).join(' · ');
  return (
    <>
      <div className="card oe-gcard">
        <h3>Under our GSTIN · {head} <span className="oe-gcard-sub">— what this period puts under that number</span></h3>
      <div className="oe-sec-h">Outward — what we billed clients <span>{d.period.label} · from Invoices</span></div>
      <div className="oe-cards">
        <Card label="Taxable value" n={money(o.taxable)} s="Fee before GST" />
        <Card label="GST charged" n={money(o.charged)} s="Collected for Government" />
        <Card label="Invoice value" n={money(o.value)} s="Before GST + GST" />
        <Card label="Invoices raised" n={o.invoices.toLocaleString('en-IN')} s={d.ourGstin ? `Under ${d.ourGstin}` : 'Under our GSTIN'}>
          {o.invoices > 0 && <button type="button" className="link-btn oe-card-link" onClick={() => setClients(true)}>who they went to →</button>}
        </Card>
      </div>

      <div className="oe-sec-h">Inward — what we bought</div>
      <div className="oe-cards">
        <Card label="Purchases with GST" n={money(i.purchases)} s={`${i.bills} bill(s)`} />
        <Card label="GST paid on them" n={money(i.gstPaid)} s="On vendor and office bills" />
        <Card label="Input credit you can claim" n={money(i.claimable)} s={`Vendor GSTIN on file (${i.claimableBills})`} tone="good" />
        <Card label="At risk" n={money(i.atRisk)} s={`No vendor GSTIN on ${i.atRiskBills} bill(s)`} tone={i.atRisk > 0.5 ? 'bad' : 'good'} />
      </div>
      </div>

      <div className="card oe-gcard">
        <h3>The Position</h3>
      <div className="oe-cards">
        <Card label="Total under this GSTIN" n={money(p.total)} s={`billed ${money(p.billed)} + bought ${money(p.bought)}`} />
        <Card label="Payable to Government" n={money(p.payable)} s={`charged ${money(o.charged)} − claimed ${money(i.claimable)}`} tone={p.payable > 0.5 ? 'bad' : 'good'} />
        <Card label="If the GSTINs are filled in" n={money(p.ifFilled)} s={`you would pay ${money(p.saving)} less`} />
        <Card label="Our GSTIN" n={<span className="oe-mono-sm">{d.ourGstin || 'not set'}</span>} s={d.ourGstin ? `${d.ourState || 'Unknown state code'}${d.ourStateCode ? ` · state code ${d.ourStateCode}` : ''}` : 'Add it under Business & portals'} />
      </div>
      </div>

      {i.atRisk > 0.5 && (
        <div className="notice amber oe-alert">
          <span className="oe-bell" aria-hidden="true">🔔</span>
          <span className="oe-alert-t">
            <b>{money(i.atRisk)}</b> of GST cannot be claimed until the vendor&apos;s GSTIN is on the bill —{' '}
            {top.map((v, ix) => (
              <span key={v.name}>
                {ix > 0 && (ix === top.length - 1 && more <= 0 ? ' and ' : ', ')}
                <b>{v.name}</b> {money(v.gst)}{v.bills.length ? ` (${v.bills.slice(0, 2).join(', ')}${v.bills.length > 2 ? '…' : ''})` : ''}
              </span>
            ))}
            {more > 0 && ` and ${more} more`}.
          </span>
          <button type="button" className="btn btn-sm btn-gold" onClick={onShowAtRisk}>Show me those {i.atRiskBills.toLocaleString('en-IN')} bill(s) in the table →</button>
        </div>
      )}

      {d.riskBills.length > 0 ? (
        <div className="card oe-risk">
          <h3>GST at risk, bill by bill</h3>
          <div className="small-muted" style={{ marginBottom: 8 }}>Add the vendor&apos;s GSTIN and the bill leaves this list — the credit is recalculated at once.</div>
          {d.riskBills.map((b) => (
            <div key={b.id} className="oe-risk-row">
              <div className="oe-risk-l">
                <b>{b.vendor || 'No vendor named'}</b>
                <div className="small-muted">{b.category} · {fmtD(b.date)}{b.billNo ? ` · ${b.billNo}` : ''}</div>
              </div>
              <div className="oe-risk-r">
                <span className="small-muted">before GST {money(b.base)}</span>
                <b className="oe-risk-gst">GST {money(b.gst)}</b>
                {canManage && adding !== b.id && <button type="button" className="btn btn-sm" onClick={() => setAdding(b.id)}>Add GSTIN</button>}
              </div>
              {adding === b.id && (
                <div className="oe-risk-add">
                  <AddGstin bill={b} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); load(); onChanged(); }} />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="notice"><span><b>Nothing at risk.</b> Every bill with GST in this period has a valid vendor GSTIN on file.</span></div>
      )}

      {clients && (
        <Modal title="Who the invoices went to" note={d.period.label} size="wide" onClose={() => setClients(false)}>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Client</th><th className="num">Invoices</th><th className="num">Taxable value</th><th className="num">GST</th><th className="num">Invoice value</th></tr></thead>
              <tbody>
                {o.clients.map((c) => (
                  <tr key={c.name}><td><b>{c.name}</b></td><td className="num">{c.n}</td><td className="num">{money(c.taxable)}</td><td className="num">{money(c.gst)}</td><td className="num">{money(c.value)}</td></tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>TOTAL</td><td className="num">{o.invoices}</td><td className="num">{money(o.taxable)}</td><td className="num">{money(o.charged)}</td><td className="num">{money(o.value)}</td></tr>
              </tfoot>
            </table>
          </div>
        </Modal>
      )}
    </>
  );
}
