import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// BILLING TOOLS on Invoices (audit 386 / 389 / 394 / 410): payments waiting for approval, client-wise profitability (with the recruiter's salary
// cost where the HRMS has it) and the freelancer revenue vs cost report. Backend: routes/billingDepth.js, utils/billingDepth.js.
// ---------------------------------------------------------------------------
const err = (e, f) => e?.response?.data?.error || f;
const inr = (n) => (n == null ? '—' : `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`);
const pct = (n) => (n == null ? '—' : `${n}%`);

function Approvals() {
  const [data, setData] = useState(null);
  const [state, setState] = useState('Pending');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/ats-billing/payment-approvals', { params: { state } }).then((r) => setData(r.data)).catch((e) => setMsg(err(e, 'Could not load.'))), [state]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <div className="small-muted">{msg || 'Loading…'}</div>;
  const act = async (fn) => { setMsg(''); try { await fn(); await load(); } catch (e) { setMsg(err(e, 'That did not work.')); } };
  return (
    <div>
      {!data.enabled && <div className="small-muted">Payment approval is OFF: every receipt is recorded at once. An Admin switches it on in Administration, Pipeline &amp; checks.</div>}
      <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>{['Pending', 'Approved', 'Rejected'].map((s) => <button key={s} type="button" className={`btn btn-sm${state === s ? ' btn-primary' : ''}`} onClick={() => setState(s)}>{s}</button>)}</div>
      <div className="tbl-wrap"><table>
        <thead><tr><th>Invoice</th><th>Client</th><th>Amount</th><th>Paid on</th><th>Method / ref</th><th>Recorded by</th><th /></tr></thead>
        <tbody>
          {data.rows.length === 0 && <tr><td colSpan={7} className="empty-mini">Nothing here.</td></tr>}
          {data.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.invoiceNumber || '—'}</td><td>{r.client || '—'}</td><td>{inr(r.amount)}</td><td>{r.date}</td><td>{r.method}{r.reference ? ` · ${r.reference}` : ''}</td>
              <td className="cell-muted">{r.requestedByName}{r.state !== 'Pending' ? ` → ${r.state} by ${r.decidedByName || '—'}${r.reason ? ` (${r.reason})` : ''}` : ''}</td>
              <td>{r.state === 'Pending' && data.mayDecide && (
                <>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => act(() => api.post(`/ats-billing/payment-approvals/${r.id}/approve`))}>Approve</button>{' '}
                  <button type="button" className="btn btn-sm" onClick={() => { const reason = window.prompt('Why is it rejected?'); if (reason) act(() => api.post(`/ats-billing/payment-approvals/${r.id}/reject`, { reason })); }}>Reject</button>
                </>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {msg && <div className="error-text" role="alert">{msg}</div>}
    </div>
  );
}

function Profitability() {
  const [data, setData] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/ats-billing/client-profitability', { params: { from: from || undefined, to: to || undefined } }).then((r) => setData(r.data)).catch((e) => setMsg(err(e, 'Could not load.'))), [from, to]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <div className="small-muted">{msg || 'Loading…'}</div>;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
        <label className="small-muted">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small-muted">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="small-muted" style={{ marginBottom: 6 }}>{data.salaryNote}</div>
      <div className="tbl-wrap"><table>
        <thead><tr><th>Client</th><th>Placements</th><th>Fee (net of notes)</th><th>Incentive</th><th>Partner payout</th><th>Margin</th><th>Recruiter salary</th><th>Margin after salary</th><th>%</th></tr></thead>
        <tbody>
          {data.rows.length === 0 && <tr><td colSpan={9} className="empty-mini">No placements billed.</td></tr>}
          {data.rows.map((r) => (
            <tr key={r.clientId}><td>{r.client}</td><td>{r.placements}</td><td>{inr(r.net)}</td><td>{inr(r.incentive)}</td><td>{inr(r.payout)}</td><td>{inr(r.margin)}</td><td title={r.salaryCoverage}>{inr(r.recruiterCost)}</td><td>{inr(r.marginAfterSalary)}</td><td>{pct(r.marginPct)}</td></tr>
          ))}
          {data.rows.length > 0 && <tr><td><b>Total</b></td><td><b>{data.totals.placements}</b></td><td><b>{inr(data.totals.net)}</b></td><td><b>{inr(data.totals.incentive)}</b></td><td><b>{inr(data.totals.payout)}</b></td><td><b>{inr(data.totals.margin)}</b></td><td><b>{inr(data.totals.recruiterCost)}</b></td><td><b>{inr(data.totals.marginAfterSalary)}</b></td><td /></tr>}
        </tbody>
      </table></div>
    </div>
  );
}

function Freelancers() {
  const [data, setData] = useState(null);
  const [type, setType] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/ats-billing/freelancer-report', { params: { type: type || undefined } }).then((r) => setData(r.data)).catch((e) => setMsg(err(e, 'Could not load.'))), [type]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <div className="small-muted">{msg || 'Loading…'}</div>;
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>{[['', 'All partners'], ['Freelancer', 'Freelancers'], ['Agency', 'Agencies']].map(([k, l]) => <button key={k} type="button" className={`btn btn-sm${type === k ? ' btn-primary' : ''}`} onClick={() => setType(k)}>{l}</button>)}</div>
      <div className="tbl-wrap"><table>
        <thead><tr><th>Partner</th><th>Type</th><th>Submitted</th><th>Joined</th><th>Revenue</th><th>Cost (payouts)</th><th>Margin</th><th>%</th></tr></thead>
        <tbody>
          {data.rows.length === 0 && <tr><td colSpan={8} className="empty-mini">No partners yet.</td></tr>}
          {data.rows.map((r) => <tr key={r.partnerId}><td>{r.name}{r.code ? <div className="small-muted">{r.code}</div> : null}</td><td>{r.type}</td><td>{r.submissions}</td><td>{r.joined}</td><td>{inr(r.revenue)}</td><td>{inr(r.cost)}</td><td>{inr(r.margin)}</td><td>{pct(r.marginPct)}</td></tr>)}
          {data.rows.length > 0 && <tr><td><b>Total</b></td><td /><td><b>{data.totals.submissions}</b></td><td><b>{data.totals.joined}</b></td><td><b>{inr(data.totals.revenue)}</b></td><td><b>{inr(data.totals.cost)}</b></td><td><b>{inr(data.totals.margin)}</b></td><td /></tr>}
        </tbody>
      </table></div>
    </div>
  );
}

export default function BillingTools({ onClose }) {
  const [tab, setTab] = useState('approvals');
  return (
    <div className="card section" style={{ margin: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="iv4-seg" role="tablist" aria-label="Billing tools">
          {[['approvals', 'Payments to approve'], ['profit', 'Client profitability'], ['freelancers', 'Freelancer report']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
      </div>
      {tab === 'approvals' && <Approvals />}
      {tab === 'profit' && <Profitability />}
      {tab === 'freelancers' && <Freelancers />}
    </div>
  );
}
