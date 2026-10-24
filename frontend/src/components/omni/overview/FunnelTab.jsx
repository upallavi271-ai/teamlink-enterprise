import { Btn, Banner, fmtNum } from '../ui.jsx';
import { downloadText } from './dateRange.js';

// ---------------------------------------------------------------------------
// Analytics > Conversion Funnel (REAL: GET /api/outreach/gs/analytics/funnel). People -> Sent -> Delivered -> Opened the link -> Replied -> Applied ->
// Interview -> Offer -> Joined. The last four are linked to a campaign only by a proven phone / email match; where that cannot be proven they say "Not linked".
// Bars are drawn as a share of the people in the campaigns. There is no revenue figure (revenue is company-wide invoices, not per campaign).
// ---------------------------------------------------------------------------
const CHANNELS = [['', 'All channels'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']];
// a drop is shown only where a stage really is a part of the one before (opened / replied are not parts of delivered)
const NESTED = { sent: 'people', delivered: 'sent', interview: 'applied', offer: 'interview', joined: 'offer' };
const slug = (s) => (s || 'all-channels').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const rs = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function FunnelTab({ data, channel, setChannel, toast }) {
  const steps = data.steps; const base = steps[0].n || 0;
  const exp = () => {
    const lines = ['Stage,Count,Share of people'];
    steps.forEach((s) => lines.push(`${s.label},${s.n === null ? 'not linked' : s.n},${s.n === null || !base ? '' : `${Math.round((s.n / base) * 1000) / 10}%`}`));
    downloadText(lines.join('\r\n'), `funnel-${slug(CHANNELS.find(([v]) => v === channel)[1])}.csv`);
    toast('Funnel exported');
  };
  const t = data.tiles;
  return (
    <div className="card panel">
      <div className="panel-top">
        <div><div className="panel-title">Conversion funnel</div><div className="panel-sub">Where people fall out between a message and a joining. Campaigns that started {data.range.from === data.range.to ? 'on that day' : 'in the dates above'}: {fmtNum(data.campaigns)}.</div></div>
        <select className="select" aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>{CHANNELS.map(([v, l]) => <option key={v || 'all'} value={v}>{l}</option>)}</select>
      </div>
      {data.rehearsed > 0 && <Banner tone="test">{fmtNum(data.rehearsed)} message{data.rehearsed === 1 ? ' was' : 's were'} only rehearsed (Test mode). They are counted in "People" but never as sent.</Banner>}
      {data.campaigns === 0 && <Banner tone="info">No campaign started in this date range, so the funnel is empty. Widen the dates above.</Banner>}
      <div className="funnel">
        {steps.map((s, i) => {
          const prevStep = NESTED[s.id] ? steps.find((x) => x.id === NESTED[s.id]) : null; const prev = prevStep ? prevStep.n : null;
          const share = s.n !== null && base ? Math.round((s.n / base) * 1000) / 10 : null;
          const drop = s.n !== null && prev && prev >= s.n ? Math.round(((prev - s.n) / prev) * 1000) / 10 : null;
          return (
            <div className="fn-row" key={s.id}>
              <div className="fn-label"><b>{s.label}</b><small>{s.note}</small></div>
              <div className={`fn-track${s.n === null ? ' na' : ''}`}><span style={{ width: `${s.n === null ? 0 : Math.max(share || 0, s.n ? 2 : 0)}%` }} /><em>{s.n === null ? 'Not linked' : fmtNum(s.n)}</em></div>
              <div className="fn-pct">{share === null ? '—' : `${share}%`}<small>{i === 0 ? 'of the people' : (drop !== null ? `−${drop}% from ${prevStep.label}` : (s.n === null ? 'cannot be proven yet' : 'of the people'))}</small></div>
            </div>
          );
        })}
      </div>
      <div className="fn-foot">
        <div><small>Reply rate</small><b>{t.replyRate === null ? '—' : `${t.replyRate}%`}</b></div>
        <div><small>Apply rate</small><b>{t.applyRate === null ? 'Not linked' : `${t.applyRate}%`}</b></div>
        <div><small>Joined per 100 sent</small><b>{t.joinedPer100 === null ? 'Not linked' : t.joinedPer100}</b></div>
        <div><small>Cost per joining</small><b>{t.perJoining === null ? (t.cost ? `${rs(t.cost)} spent, no joining yet` : 'Not worked out') : rs(t.perJoining)}</b></div>
        <div><Btn onClick={exp}>⬇ Export</Btn></div>
      </div>
      <div className="an-note">{data.notes.join(' ')} Cost uses the unit costs typed in Configuration (they start at 0).</div>
    </div>
  );
}
