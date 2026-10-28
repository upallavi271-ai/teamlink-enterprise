import { day } from './vendorFormat.js';

// Small pieces shared by the four Assets Vendor Portal pages (2026-10-19). Plain words, no new styling system: the vendor portal's own classes.
export const STEPS = ['Awaiting repair', 'Sent for repair', 'Under repair', 'Completed', 'Returned'];
export const STEP_TONE = { 'Awaiting repair': 'yellow', 'Sent for repair': 'blue', 'Under repair': 'blue', Completed: 'green', Returned: 'green', Cancelled: 'grey' };
// What each step means, in words a shop-floor person uses.
export const STEP_HELP = {
  'Awaiting repair': 'The company has told you about the problem. The asset has not reached you yet.',
  'Sent for repair': 'The asset has reached you.',
  'Under repair': 'You are working on it.',
  Completed: 'The repair is done.',
  Returned: 'You have handed the asset back to the company.',
  Cancelled: 'The company cancelled this repair.',
};

// PAYMENT is a different thing from the repair STEP: a repair can be Completed while its invoice is Pending. The status is DERIVED by the server from
// Accounts' own records and the bank statement; the vendor cannot set it. Always text, never colour alone.
export const PAY_TONE = { Pending: 'yellow', 'Waiting for Accounts': 'yellow', Paid: 'green', 'Partially Paid': 'blue', Overdue: 'red', Reversed: 'red', Rejected: 'red', 'Not sent to Accounts': 'grey', 'No invoice yet': 'grey' };
export function PayTag({ pay }) {
  if (!pay) return <span className="vp-tag vp-grey">-</span>;
  return <span className={`vp-tag vp-${PAY_TONE[pay.status] || 'grey'}`} title={pay.note || undefined}>{pay.status}</span>;
}
// "Paid ₹1,000 · balance ₹500 · last payment 05-10-2026"
export function PayLine({ pay }) {
  if (!pay) return null;
  const bits = [];
  if (pay.paidAmount > 0) bits.push(`Paid ${rs(pay.paidAmount)}`);
  if (pay.balance > 0) bits.push(`balance ${rs(pay.balance)}`);
  if (pay.lastPaymentDate) bits.push(`last payment ${day(pay.lastPaymentDate)}`);
  if (pay.dueDate && pay.status !== 'Paid') bits.push(`due ${day(pay.dueDate)}`);
  // every bank payment of this invoice: "Paid on 26-09-2026: Rs 7,434" (founder 2026-10-28)
  const list = Array.isArray(pay.payments) ? pay.payments : [];
  if (list.length) {
    return (
      <span className="cell-muted">
        {list.map((p, i) => <span key={`${p.date}-${i}`} style={{ display: 'block' }}>Paid on <strong>{day(p.date)}</strong>: {rs(p.amount)}{p.reference ? ` (ref ${p.reference})` : ''}</span>)}
        {pay.balance > 0 ? <span style={{ display: 'block' }}>Balance {rs(pay.balance)}</span> : null}
      </span>
    );
  }
  return <span className="cell-muted">{bits.join(' \u00b7 ') || pay.note || ''}</span>;
}

// Warranty chip: the server says the words ("In warranty (40 days left)", "Expired 12 days ago", "No warranty recorded"); colour is never the only signal.
export function WarrantyTag({ w }) {
  if (!w) return <span className="cell-muted">-</span>;
  return <span className={`vp-tag vio-wt vp-${w.tone || 'grey'}`} title={w.until ? `Warranty until ${day(w.until)}` : undefined}>{w.status}</span>;
}
// Amount of an asset: "Not recorded" when the company has none (never 0); GST and total under it when recorded.
export function AmountCell({ r }) {
  if (r.amountHidden) return null;
  if (r.amount == null) return <span className="cell-muted">Not recorded</span>;
  return <>{rs(r.amount)}{r.gst != null ? <div className="cell-muted">GST {rs(r.gst)} &middot; total {rs(r.amountTotal)}</div> : null}</>;
}

export function StepTag({ step }) {
  return <span className={`vp-tag vp-${STEP_TONE[step] || 'grey'}`}>{step}</span>;
}

// The five steps as a row of pills: done, now, to come.
export function StepRow({ step }) {
  const now = STEPS.indexOf(step);
  return (
    <ol className="vm-steps" aria-label="Repair steps">
      {STEPS.map((s, i) => <li key={s} className={i < now ? 'done' : (i === now ? 'now' : '')}>{s}</li>)}
    </ol>
  );
}

// Money with the rupee sign; "-" when nothing was entered.
export const rs = (n) => (n == null || n === '' ? '-' : `\u20b9${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

// "12:30" style time for the history list.
export function when(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return `${day(d.toISOString().slice(0, 10))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// One line of a history list: "You changed Final cost from 2000 to 2500".
export function HistoryList({ rows, showRepair }) {
  if (!rows || !rows.length) return <div className="vp-none">Nothing has been changed yet.</div>;
  return (
    <ul className="vm-hist">
      {rows.map((e) => (
        <li key={e.id}>
          <strong>{e.by}</strong>{' '}
          {e.note && !e.field ? e.note : (e.kind === 'remark'
            ? <>added a remark: &ldquo;{e.to}&rdquo;</>
            : <>changed {e.field || e.kind}{e.from != null || e.to != null ? <> from <em>{e.from == null || e.from === '' ? 'nothing' : e.from}</em> to <em>{e.to == null || e.to === '' ? 'nothing' : e.to}</em></> : null}{e.note && e.kind === 'status' ? <> &ndash; {e.note}</> : null}</>)}
          {showRepair && e.repairNo ? <span className="cell-muted"> ({e.repairNo})</span> : null}
          {' '}<span className="cell-muted">&middot; {when(e.at)}</span>
        </li>
      ))}
    </ul>
  );
}

// Shows the words a vendor typed into a number box ("1,500", "₹1500") as the clean string the server expects.
export const clean = (v) => String(v ?? '').trim();

// Only the fields that really changed (so a Save never re-sends what was not touched).
export function changedFields(form, base, keys) {
  const out = {};
  keys.forEach((k) => {
    const a = clean(form[k]);
    const b = base[k] == null ? '' : clean(base[k]);
    if (a !== b) out[k] = a === '' ? null : a;
  });
  return out;
}
