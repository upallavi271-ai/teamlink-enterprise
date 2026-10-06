import { useNavigate } from 'react-router-dom';
import StatCard, { StatRow } from '../ui/StatCard.jsx';
import { BarChart, DonutChart } from '../charts';
import { inr } from '../../utils/csv';
import './ccr.css';

// ---------------------------------------------------------------------------
// CLIENT PAGE → PERFORMANCE (ATS layout v3, 2026-10-03):
//   Sent to client vs Interviewed vs Joined (bar) · Why people were rejected
//   (donut) · Money (cards + billed per month) — money only when the server
//   sent amounts (Admin / Management / Accounts; a BDE gets status only, a TL
//   nothing — GET /clients/:id/overview decides, this only draws it).
// Every bar / slice opens its list: onList('candidates' | 'interviews' |
// 'selected' | 'invoices'), or the Candidates screen for the rejected people.
// ---------------------------------------------------------------------------
const monthKey = (d) => String(d || '').slice(0, 7);
const monthLabel = (k) => {
  const [y, m] = k.split('-').map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : k;
};

export default function ClientPerformance({ clientId, data, onList }) {
  const navigate = useNavigate();
  const s = data.summary || null;
  // Internal logins: the server's relationship numbers; a client login: its own lists.
  const sent = s ? s.candidatesSubmitted : (data.candidates || []).length;
  const interviewed = s ? s.clientInterviews : (data.interviews || []).length;
  const joined = s ? s.joinedCount : (data.joinings || []).length;
  const hasPipeline = sent !== undefined || interviewed !== undefined || joined !== undefined;
  const bars = [
    { label: 'Sent to client', value: sent || 0, tone: 'blue', onClick: () => onList('candidates') },
    { label: 'Interviewed', value: interviewed || 0, tone: 'blue', onClick: () => onList('interviews') },
    { label: 'Joined', value: joined || 0, tone: 'green', onClick: () => onList('selected') },
  ];
  const rej = data.rejections;
  const rejectedList = () => navigate(`/candidates?clientId=${encodeURIComponent(clientId)}&status=Rejected`);
  const reasons = rej ? rej.reasons.map((r) => ({ label: r.label, value: r.count, onClick: rejectedList })) : [];

  const amounts = data.invoiceMode === 'amounts';
  const inv = s && s.invoiceSummary && s.invoiceSummary.invoiced !== undefined ? s.invoiceSummary : null;
  const byMonth = new Map();
  if (amounts) {
    (data.invoices || []).forEach((i) => {
      if (i.status === 'Cancelled') return;
      const k = monthKey(i.invoiceDate);
      if (k) byMonth.set(k, (byMonth.get(k) || 0) + (Number(i.total ?? i.amount) || 0));
    });
  }
  const months = [...byMonth.keys()].sort().slice(-12).map((k) => ({ label: monthLabel(k), value: Math.round(byMonth.get(k)), onClick: () => onList('invoices') }));

  return (
    <>
      {amounts && inv && (
        <StatRow>
          <StatCard label="Billed" value={inv.invoiced} format={inr} tone="blue" zeroText="Nothing billed yet" onClick={() => onList('invoices')} />
          <StatCard label="Received" value={inv.received} format={inr} tone="green" zeroText="Nothing received yet" onClick={() => onList('invoices')} />
          <StatCard label="Still to come" value={inv.outstanding} format={inr} tone={inv.overdue ? 'red' : 'amber'} zeroText="Nothing owed" upIsGood={false} onClick={() => onList('invoices')} hint={inv.overdue ? `${inv.overdue} late` : undefined} />
        </StatRow>
      )}
      <div className="ccr-charts">
        {hasPipeline && (
          <div className="ccr-chart">
            <h3>Sent, interviewed, joined</h3>
            <div className="ccr-sub">Click a bar to see those people.</div>
            <BarChart data={bars} height={200} title="Sent to client, interviewed and joined" empty="Nobody sent to this client yet" />
          </div>
        )}
        {rej && (
          <div className="ccr-chart">
            <h3>Why people were rejected</h3>
            <div className="ccr-sub">{rej.total ? `${rej.total.toLocaleString('en-IN')} rejected. Click to see them.` : 'Nobody rejected yet.'}</div>
            <DonutChart data={reasons} title="Rejection reasons" centerValue={rej.total ? rej.total.toLocaleString('en-IN') : undefined} centerLabel="rejected" empty="Nobody rejected yet" />
          </div>
        )}
        {amounts && (
          <div className="ccr-chart">
            <h3>Billed per month</h3>
            <div className="ccr-sub">Invoices raised to this client. Click to see them.</div>
            <BarChart data={months} height={200} valueFormat={inr} title="Billed per month" empty="No invoices yet" />
          </div>
        )}
      </div>
    </>
  );
}
