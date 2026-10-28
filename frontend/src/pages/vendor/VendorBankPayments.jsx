import { useCallback, useEffect, useState } from 'react';
import vendorApi, { vendorError } from '../../vendorApi';
import { day } from './vendorFormat.js';

// PAYMENTS FROM THE BANK STATEMENT (founder 2026-10-28: "ee date roju entha pay chesaru ani vendors portal lo" - every vendor portal).
// Every bank statement line that paid this vendor: the date, the amount, the payment reference and which bills it paid. Read only.
// Server: GET /api/vendor-portal/bank-payments (backend/src/utils/vendorBankPayments.js). No bank account, no balance, no other line.
const rs = (n) => (n == null ? '-' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);

export default function VendorBankPayments({ title = 'Payments from the bank statement' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const load = useCallback(() => {
    vendorApi.get('/bank-payments', { params: { from: from || undefined, to: to || undefined } })
      .then((r) => { setData(r.data); setError(''); }).catch((e) => setError(vendorError(e, 'Could not load the payments.')));
  }, [from, to]);
  useEffect(() => { load(); }, [load]);
  const rows = data?.rows || [];
  return (
    <section style={{ marginTop: 6 }}>
      <h3 style={{ fontSize: 15, margin: '4px 0 4px' }}>{title}</h3>
      <p className="cell-muted" style={{ marginTop: 0 }}>Every payment the company made to you, as it shows in the company&apos;s bank statement: the date and the amount.</p>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
      {data && (
        <div className="vp-tiles">
          <div className="vp-tile green"><span>Paid to you till now</span><b>{rs(data.total)}</b></div>
          <div className="vp-tile"><span>Payments</span><b>{data.count}</b></div>
          <div className="vp-tile"><span>Last payment</span><b>{data.lastDate ? day(data.lastDate) : '-'}</b></div>
          <div className="vp-tile"><span>First payment</span><b>{data.firstDate ? day(data.firstDate) : '-'}</b></div>
        </div>
      )}
      <div className="vp-filters" role="search">
        <div className="vp-dates">
          <input type="date" aria-label="Paid from" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <span className="vp-to">to</span>
          <input type="date" aria-label="Paid to" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        {(from || to) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setFrom(''); setTo(''); }}>Clear</button>}
      </div>
      {!data ? <div className="empty-mini">Loading&hellip;</div> : !rows.length ? (
        <div className="vp-empty"><h3>No payments found</h3><p>{data.count ? 'No payment in these dates.' : 'When the company pays you and the bank statement is added, each payment shows here with its date and amount.'}</p></div>
      ) : (
        <div className="tbl-wrap vp-scroll">
          <table>
            <thead><tr><th>Paid on</th><th className="num">Amount</th><th>Payment reference</th><th>For</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.key}>
                <td><strong>{day(r.date)}</strong></td>
                <td className="num"><strong>{rs(r.amount)}</strong></td>
                <td>{r.reference || '-'}</td>
                <td style={{ whiteSpace: 'normal' }}>{r.forBills.length ? r.forBills.join(', ') : <span className="cell-muted">Not linked to a bill</span>}</td>
                <td>{r.status === 'Reversed' ? <span className="vp-tag vp-red">Reversed (money came back)</span> : r.status === 'Under Review' ? <span className="vp-tag vp-yellow">Accounts is checking</span> : <span className="vp-tag vp-green">Paid</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
