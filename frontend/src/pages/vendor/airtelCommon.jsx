import { day } from './vendorFormat.js';
// Money with 2 decimals (a bill is 22,118.70, not 22,118.7)
export const rs = (n) => (n == null || n === '' ? '-' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
import './airtelPortal.css';

// Small pieces shared by the three Airtel Bills Portal pages (2026-10-19). Plain words, the vendor portal's own classes (the Assets portal's look).
// The payment status is DERIVED by the server from Accounts' own records and the bank statement. A vendor cannot set it.
export const AIR_TONE = {
  Pending: 'yellow', 'Waiting for Accounts': 'yellow', Paid: 'green', 'Paid by Accounts': 'soft', 'Partially Paid': 'blue', Overdue: 'red', Reversed: 'red', Rejected: 'red',
};
export const STATUS_HELP = {
  Pending: 'Not paid yet.',
  'Waiting for Accounts': 'You sent this bill. Accounts has not booked it yet.',
  Paid: 'The money left the bank and the bank statement is matched to this bill.',
  'Paid by Accounts': 'Accounts says it is paid. It shows as Paid after the bank statement is matched to it.',
  'Partially Paid': 'Only a part has reached you. The rest is still to pay.',
  Overdue: 'The due date has passed and the bill is not fully paid.',
  Reversed: 'The bank payment came back. It does not count as paid.',
  Rejected: 'Accounts rejected this bill.',
};

export const NotRecorded = () => <span className="cell-muted">Not recorded</span>;
export const val = (v) => (v === null || v === undefined || v === '' ? <NotRecorded /> : v);
export const money = (v) => (v === null || v === undefined ? <NotRecorded /> : rs(v));
export const dateOr = (d) => (d ? day(d) : <NotRecorded />);

// The status chip. A late bill that is also part-paid shows both words.
export function AirTag({ pay }) {
  if (!pay) return <span className="vp-tag vp-grey">-</span>;
  return (
    <>
      <span className={`vp-tag ${pay.tone === 'soft' ? 'abp-soft' : `vp-${AIR_TONE[pay.status] || 'grey'}`}`} title={pay.note || STATUS_HELP[pay.status] || undefined}>{pay.status}</span>
      {pay.overdue && pay.status !== 'Overdue' ? <span className="vp-tag vp-red">Overdue</span> : null}
      {pay.dueSoon ? <span className="vp-tag vp-yellow">Due soon</span> : null}
    </>
  );
}
// "Paid 5,900 - balance 0 - paid on 16-10-2026 - ref ••••A005"
export function AirLine({ pay }) {
  if (!pay) return null;
  const bits = [];
  if (pay.paidAmount > 0) bits.push(`Paid ${rs(pay.paidAmount)}`);
  if (pay.balance > 0) bits.push(`to pay ${rs(pay.balance)}`);
  if (pay.paymentDate) bits.push(`on ${day(pay.paymentDate)}`);
  if (pay.reference) bits.push(`ref ${pay.reference}`);
  return <span className="cell-muted">{bits.join(' · ')}</span>;
}

// "Apr 2026" from "2026-04"
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthText = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(ym || ''); return m ? `${MON[Number(m[2]) - 1]} ${m[1]}` : (ym || ''); };

// Server alerts as a calm banner: red overdue, amber due soon, green payment confirmed. One line per bill (the server sends one per bill).
export function AlertBanner({ alerts, onOpen, limit = 4 }) {
  if (!alerts || !alerts.length) return null;
  const shown = alerts.slice(0, limit);
  return (
    <div className="abp-alerts" role="region" aria-label="Bills that need attention">
      {shown.map((a) => (
        <div key={a.key} className={`abp-alert abp-${a.kind}`}>
          <strong>{a.title}</strong>
          <span>{a.text}</span>
          {onOpen ? <button type="button" className="link-btn" onClick={() => onOpen(a.key)}>Open</button> : null}
        </div>
      ))}
      {alerts.length > limit ? <div className="cell-muted">and {alerts.length - limit} more. Use the Status filter to see them all.</div> : null}
    </div>
  );
}
