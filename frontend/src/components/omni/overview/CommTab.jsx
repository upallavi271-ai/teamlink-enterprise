import { useMemo, useState } from 'react';
import { Panel, StatusPill, Empty, fmtNum, fmtDate } from '../ui.jsx';

// ---------------------------------------------------------------------------
// Analytics > Communication Analytics (REAL numbers from GET /api/outreach/gs/analytics/comm):
//   5 cards, LIVE STATUS donut, CHANNEL BREAKDOWN bars, TOP FAILURE REASONS (click one to filter the table), Recent Communication Activity.
// "Engaged" = clicked the apply link or replied (no "read" receipt exists, so nothing says "read"). Rehearsed (Test mode) is shown apart.
// ---------------------------------------------------------------------------
const SLICES = [['delivered', 'Delivered', '#4d7ddb'], ['failed', 'Failed', '#de5c63'], ['engaged', 'Engaged', '#11985a'], ['sent', 'Sent', '#ef9b35'], ['rehearsed', 'Rehearsed (not really sent)', '#a9b4ae'], ['waiting', 'Waiting', '#e3c46a']];
const CARDS = [
  ['total', 'TOTAL MESSAGES', '📈', '#ef9b35', 'Messages made for the campaigns in this range (people who were skipped are not counted)'],
  ['sent', 'SUCCESS SENT', '✓', '#11985a', 'Really handed to the provider'],
  ['delivered', 'DELIVERED', '💬', '#4d7ddb', 'Confirmed by the provider (some providers never confirm)'],
  ['engaged', 'ENGAGED', '✔', '#11985a', 'The person clicked the apply link or replied'],
  ['failed', 'FAILED', '✕', '#de5c63', 'Could not be sent'],
];
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

function arc(cx, cy, R, r, s, e) {
  const xy = (a, rad) => { const rr = ((a - 90) * Math.PI) / 180; return [cx + rad * Math.cos(rr), cy + rad * Math.sin(rr)]; };
  const end = Math.min(e, s + 359.99);
  const [x1, y1] = xy(s, R); const [x2, y2] = xy(end, R); const [x3, y3] = xy(end, r); const [x4, y4] = xy(s, r);
  const big = end - s > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${R} ${R} 0 ${big} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${big} 0 ${x4} ${y4} Z`;
}

function Donut({ slices, total }) {
  const parts = SLICES.map(([k, label, color]) => ({ k, label, color, value: slices[k] || 0 }));
  let acc = 0;
  return (
    <>
      <div style={{ position: 'relative' }}>
        <svg viewBox="0 0 180 180" width="170" height="170" role="img" aria-label={`Live status of ${fmtNum(total)} messages`}>
          {total === 0 && <circle cx="90" cy="90" r="64" fill="none" stroke="#eef2f0" strokeWidth="32" />}
          {parts.filter((p) => p.value > 0).map((p) => {
            const s = (acc / total) * 360; acc += p.value;
            const pc = Math.round((p.value / total) * 100);
            return <path key={p.k} d={arc(90, 90, 80, 48, s, (acc / total) * 360)} fill={p.color} stroke="#fff" strokeWidth="2" style={{ cursor: 'pointer' }}><title>{p.label}: {fmtNum(p.value)} ({pc}%)</title></path>;
          })}
          <text x="90" y="86" textAnchor="middle" fontSize="10" fill="#89938d">Total</text>
          <text x="90" y="102" textAnchor="middle" fontSize="16" fontWeight="900" fill="var(--ink)">{fmtNum(total)}</text>
        </svg>
      </div>
      <div className="donut-legend" style={{ marginTop: 10 }}>{parts.filter((p) => p.value > 0 || ['delivered', 'failed', 'engaged', 'sent'].includes(p.k)).map((p) => <span key={p.k}><i style={{ background: p.color }} />{p.label} {fmtNum(p.value)}</span>)}</div>
    </>
  );
}

function Bars({ channels }) {
  const max = Math.max(1, ...channels.map((c) => c.total));
  const step = 340 / channels.length;
  return (
    <svg viewBox="0 0 400 225" width="100%" height="210" role="img" aria-label="Messages by way">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => { const y = 195 - f * 170; return <g key={f}><text x="30" y={y + 3} textAnchor="end" fontSize="8" fill="#b0b8b4">{fmtNum(Math.round(max * f))}</text><line x1="34" y1={y} x2="390" y2={y} stroke="#eef2f0" strokeDasharray="4" /></g>; })}
      {channels.map((c, i) => {
        const h = Math.max(Math.round((c.total / max) * 170), c.total ? 3 : 1); const x = 44 + i * step + (step - 36) / 2;
        return (
          <g key={c.id}>
            <defs><linearGradient id={`anCh${c.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c.color} /><stop offset="100%" stopColor={c.color} stopOpacity=".5" /></linearGradient></defs>
            <rect x={x} y={195 - h} width="36" height={h} rx="4" fill={`url(#anCh${c.id})`} style={{ cursor: 'pointer' }}><title>{c.label}: {fmtNum(c.total)}{c.calls ? ' calls logged' : ''}</title></rect>
            <text x={x + 18} y="212" textAnchor="middle" fontSize="8" fill="#89938d" fontWeight="700">{c.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function CommTab({ data, go }) {
  const [failKey, setFailKey] = useState(null);
  const [all, setAll] = useState(false);
  const fail = data.failures.find((f) => f.key === failKey) || null;
  const rows = useMemo(() => (fail ? data.activity.filter((a) => fail.campaignIds.includes(a.id)) : data.activity), [data, fail]);
  const shown = all ? rows : rows.slice(0, 8);
  const t = data.totals; const maxF = Math.max(1, ...data.failures.map((f) => f.count));
  const CHC = { whatsapp: '#11985a', sms: '#4d7ddb', email: '#ef9b35', call: '#7867d9' };
  return (
    <div>
      <div className="an-metrics">
        {CARDS.map(([k, label, icon, color, hint]) => (
          <div key={k} className="card metric an-metric" style={{ '--c': color, '--cs': hexA(color, 0.2) }} title={hint}>
            <small>{label}</small><b style={{ fontSize: 20 }}>{fmtNum(t[k])}</b><span className="an-ico">{icon}</span>
          </div>
        ))}
      </div>
      <div className="an-note">
        {t.rehearsed > 0 && <>{fmtNum(t.rehearsed)} rehearsed in Test mode (made, but not really sent). </>}
        {t.waiting > 0 && <>{fmtNum(t.waiting)} still waiting to go. </>}
        {t.skipped > 0 && <>{fmtNum(t.skipped)} {t.skipped === 1 ? 'person was' : 'people were'} skipped (for example no permission): they are not failures. </>}
        Engaged means the person clicked the apply link or replied.
      </div>
      <div className="an-three">
        <div className="card panel"><div className="panel-title">LIVE STATUS</div><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 14 }}><Donut slices={data.slices} total={t.total} /></div></div>
        <div className="card panel"><div className="panel-title">CHANNEL BREAKDOWN</div><div style={{ marginTop: 14 }}><Bars channels={data.channels} /></div></div>
        <div className="card panel">
          <div className="panel-title" style={{ color: 'var(--accent)' }}>TOP FAILURE REASONS</div>
          <div style={{ marginTop: 8 }}>
            {data.failures.length === 0 && <div style={{ fontSize: 10, color: 'var(--muted)', padding: '18px 0' }}>No message failed in this range.</div>}
            {data.failures.map((f) => (
              <div key={f.key}>
                <div className={`fail-bar-row${failKey === f.key ? ' on' : ''}`} style={{ gridTemplateColumns: '1fr auto' }} role="button" tabIndex={0} title={`${f.desc}\nCount: ${fmtNum(f.count)}\nClick to show only the campaigns with this reason`} onClick={() => { setFailKey(failKey === f.key ? null : f.key); setAll(false); }} onKeyDown={(e) => { if (e.key === 'Enter') setFailKey(failKey === f.key ? null : f.key); }}>
                  <span style={{ fontSize: 10, overflowWrap: 'anywhere' }}>{f.words}</span><b style={{ color: f.color }}>{fmtNum(f.count)}</b>
                </div>
                <div className="fail-bar-track" style={{ marginBottom: 8 }}><span className="fail-bar-fill" style={{ width: `${Math.round((f.count / maxF) * 100)}%`, background: `linear-gradient(90deg,${f.color},${f.color}bb)` }} /></div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="card panel an-wide">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 14 }}>Recent Communication Activity</b>
          <button type="button" className="link-btn" onClick={() => go('campaigns')}>View All Campaigns →</button>
        </div>
        {fail && <div className="an-filter-chip" style={{ marginTop: 10 }}>Only campaigns with: {fail.words}<button type="button" aria-label="Show every campaign again" onClick={() => setFailKey(null)}>×</button></div>}
        {rows.length === 0 ? (
          <Empty title="No campaigns to show">{data.campaignsInRange === 0 ? 'No campaign started in this date range.' : 'No campaign matches this filter.'}</Empty>
        ) : (
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="table"><thead><tr><th>CAMPAIGN</th><th>CHANNEL</th><th>STATUS</th><th>DATE</th><th>ACTION</th></tr></thead><tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td className="campaign-name">{a.name}</td>
                  <td><span className="an-pill" style={{ background: `${CHC[a.channel] || '#11985a'}22`, color: CHC[a.channel] || '#11985a', borderColor: `${CHC[a.channel] || '#11985a'}55` }}>{a.channelWords.toUpperCase()}</span>{a.rehearsal && <span className="tag" style={{ marginLeft: 6 }} title="Test mode: nothing was really sent">Rehearsal</span>}</td>
                  <td><StatusPill status={a.status} words={a.statusWords} /></td>
                  <td>{fmtDate(a.at)}</td>
                  <td><button type="button" className="link-btn" onClick={() => go('campaigns', { open: a.id })}>View Details →</button></td>
                </tr>
              ))}
            </tbody></table>
            {rows.length > 8 && <div style={{ textAlign: 'center', marginTop: 10 }}><button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button></div>}
          </div>
        )}
      </div>
      <div className="an-note">{data.notes.join(' ')}</div>
    </div>
  );
}
