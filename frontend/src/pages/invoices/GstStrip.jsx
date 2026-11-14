// GST FOR WHAT IS SELECTED (founder 2026-11-14: "clients / vendors / months select chesinappudu ... GST ... manam antha pay cheyyali").
// Over the invoices the filters leave (the same `rows` as the cards and the table): the taxable value, the GST charged,
// how much of that GST the clients have paid us already, and what we have to pay the Government after the input credit
// (GST on our own vendor / office bills for the same dates, from Office). Read only; nothing here changes a record.
import { useEffect, useState } from 'react';
import api from '../../api';
import { money } from './invFormat';

const sum = (list, f) => list.reduce((s, r) => s + (Number(f(r)) || 0), 0);

export default function GstStrip({ rows, period, periodOn, clientsOn }) {
  const [inward, setInward] = useState(null); // { claimable, gstPaid, bills } | null
  const sel = periodOn && period?.from && period?.to ? `C:${period.from}:${period.to}` : 'all';

  useEffect(() => {
    let live = true;
    setInward(null);
    api.get('/office-expenses/overview', { params: { period: sel } })
      .then((r) => { if (live) setInward(r.data?.recon?.inward || {}); })
      .catch(() => { if (live) setInward({}); });
    return () => { live = false; };
  }, [sel]);

  const live = rows.filter((r) => r.status !== 'Cancelled');
  const taxable = sum(live, (r) => r.billing);
  const charged = sum(live, (r) => r.gst);
  const gotBack = sum(live, (r) => {
    const rec = Number(r.receivable) || 0;
    return rec > 0 ? Number(r.gst || 0) * Math.min(1, Number(r.received || 0) / rec) : 0;
  });
  const claim = inward ? Number(inward.claimable || 0) : 0;
  const payable = charged - claim;
  const credit = payable < 0;

  const Cell = ({ l, v, s, tone, title }) => (
    <div className={`inv-stat${tone ? ` ${tone}` : ''}`} title={title}>
      <div className="inv-stat-l">{l}</div>
      <div className="inv-stat-v">{v}</div>
      <div className="small-muted">{s}</div>
    </div>
  );

  return (
    <section className="inv-stats" aria-label="GST for the invoices shown">
      <Cell l="Taxable value" v={money(taxable)} s={`${live.length} invoice${live.length === 1 ? '' : 's'} shown`} title="Fee before GST, over the invoices the filters leave" />
      <Cell l="GST charged" v={money(charged)} s="collected for Government" title="GST on the invoices shown" />
      <Cell l="GST clients paid us" v={money(gotBack)} s={`${money(Math.max(0, charged - gotBack))} still to come`} tone="good" title="The part of the GST that sits in the money clients have already paid" />
      <Cell
        l="Input credit"
        v={inward ? money(claim) : '…'}
        s={`GST on our vendor bills, ${periodOn ? 'same dates' : 'all time'}${clientsOn ? ' (whole period, not per client)' : ''}`}
        title="GST on office and vendor bills whose vendor GSTIN is on file"
      />
      <Cell
        l={credit ? 'Credit carried forward' : 'We pay Government'}
        v={inward ? money(Math.abs(payable)) : '…'}
        s={`charged ${money(charged)} − credit ${money(claim)}`}
        tone={credit ? 'good' : 'bad'}
        title="GST charged minus the input credit. GST is due on the invoice, even if the client has not paid yet."
      />
    </section>
  );
}
