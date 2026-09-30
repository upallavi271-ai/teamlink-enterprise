// FINANCIAL OVERVIEW (v2 §2) — one compact row of eight figures for the page
// period, all from GET /office-expenses/overview (routes/office.js
// officeFacts(), the one helper every figure on the page comes from). These
// eight are not repeated anywhere else on the page.
import {
  money, MONTH_FULL, monthOfSel, monthSel,
} from './officeUtil';

// The Month / Year quick pick the old month bar had (‹ September 2026 ›); it
// sets the same period selection the period picker does.
export function MonthPick({ period, setPeriod }) {
  const ym = monthOfSel(period);
  const now = new Date();
  const [y, m0] = ym || [now.getFullYear(), now.getMonth()];
  const pick = (yy, mm) => setPeriod(monthSel(yy, mm));
  const step = (k) => { const d = new Date(y, m0 + k, 1); pick(d.getFullYear(), d.getMonth()); };
  const years = [];
  for (let yy = now.getFullYear() - 6; yy <= now.getFullYear() + 1; yy += 1) years.push(yy);
  return (
    <span className="oe-mb-ctl">
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => step(-1)} aria-label="Previous month">‹</button>
      <select className={`oe-sel${ym ? ' set' : ''}`} value={ym ? m0 : ''} aria-label="Month"
        onChange={(e) => { if (e.target.value !== '') pick(y, Number(e.target.value)); }}>
        {!ym && <option value="">— month —</option>}
        {MONTH_FULL.map((mn, i) => <option key={mn} value={i}>{mn}</option>)}
      </select>
      <select className={`oe-sel${ym ? ' set' : ''}`} value={y} aria-label="Year" onChange={(e) => pick(Number(e.target.value), m0)}>
        {years.map((yy) => <option key={yy} value={yy}>{yy}</option>)}
      </select>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => step(1)} aria-label="Next month">›</button>
    </span>
  );
}

export default function FinancialOverview({ facts }) {
  if (!facts) return <div className="small-muted"><span className="oe-spin oe-spin-sm" aria-hidden="true" /> Loading…</div>;
  const o = facts.overview;
  const c = o.counts;
  const net = o.netGst;
  const items = [
    ['Total Expenses', money(o.totalExpenses), `${c.bills} bill${c.bills === 1 ? '' : 's'} · taxable + GST`, 'Every live bill in the period: before GST + GST (rejected bills and hand loans are left out)'],
    ['Taxable Expenses', money(o.taxableExpenses), 'before GST', 'The same bills before GST — the Taxable Amount column, summed'],
    ['GST Paid', money(o.gstPaid), `${c.billsWithGst} bill${c.billsWithGst === 1 ? '' : 's'} with GST`, 'GST charged to us on those bills'],
    ['Input GST Credit', money(o.inputCredit), c.atRiskBills ? `${c.atRiskBills} bill${c.atRiskBills === 1 ? '' : 's'} lack a GSTIN` : 'vendor GSTINs on file', 'GST on the bills whose vendor GSTIN passes the checksum — what can be claimed', c.atRiskBills ? 'bad' : ''],
    ['Client Billing', money(o.clientBilling), `${c.invoices} invoice${c.invoices === 1 ? '' : 's'} · before GST`, 'Taxable value of the invoices raised in the period (from Invoices; cancelled ones left out)'],
    ['GST Collected', money(o.gstCollected), 'on those invoices', 'GST charged to clients on those invoices'],
    [net >= 0 ? 'Net GST Payable' : 'Net GST Receivable', money(Math.abs(net)), 'collected − input credit', 'GST Collected − Input GST Credit. Positive is payable to Government; negative is credit carried forward.', net > 0.5 ? 'bad' : 'good'],
    ['Outstanding Amount', money(o.outstanding), 'still to be received', 'On the period\'s invoices: invoice value − TDS − what has been received', o.outstanding > 0.5 ? 'bad' : ''],
  ];
  return (
    <>
      <div className="oe-fo" role="list">
        {items.map(([l, v, s, t, tone]) => (
          <div key={l} className={`oe-fo-i${tone ? ` ${tone}` : ''}`} role="listitem" title={t}>
            <div className="oe-fo-l">{l}</div>
            <div className="oe-fo-v">{v}</div>
            <div className="oe-fo-s">{s}</div>
          </div>
        ))}
      </div>
      <div className="oe-fo-note">{facts.period.label} · hover a figure for how it is worked out · the GST Reconciliation below shows the working.</div>
    </>
  );
}
