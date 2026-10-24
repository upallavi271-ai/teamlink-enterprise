import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Kpi, Kpis, Panel, Tag, StatusPill, Empty, Banner, fmtNum } from '../ui.jsx';
import FlowStrip from '../overview/FlowStrip.jsx';
import PerfChart from '../overview/PerfChart.jsx';
import DetailModal, { DetailRows } from '../overview/DetailModal.jsx';
import '../overview/overview.css';

// ---------------------------------------------------------------------------
// DASHBOARD ("Command center"): the Green Start prototype's first page, on REAL numbers (GET /api/outreach/gs/overview, outreach/overview.js).
//   greeting + 2 buttons, the "How it works" strip, 5 KPI cards (Reach, Engagement, Leads, Conversions, Campaigns), Performance overview chart,
//   Channel health, Recent campaigns, Actionable insights, and the popups (KPI card, channel row, insight).
// Nothing is invented: with no data the cards say 0 / "—" / "Not linked" and the panels say what to do. Test-mode rehearsals are never counted.
// ---------------------------------------------------------------------------
const RANGES = [['30d', 'Last 30 days'], ['7d', 'Last 7 days'], ['year', 'This year']];
const greeting = () => { const h = new Date().getHours(); return h >= 5 && h <= 11 ? 'Good morning' : (h >= 12 && h <= 16 ? 'Good afternoon' : (h >= 17 && h <= 20 ? 'Good evening' : 'Good night')); };
const ICON = { whatsapp: 'wa', sms: 'sms', email: 'mail', call: 'voice' };
const ARROW = { up: '↑', down: '↓', flat: '→' };

function Trend({ k, tail = 'vs last period' }) {
  return (
    <span className="ov-kpi-meta">
      {k.trend ? <span>{ARROW[k.trend.dir]} {k.trend.text} <span className="neutral">{tail}</span></span> : null}
      {k.sub ? <span className={`ov-kpi-sub${k.trend ? '' : ' first'}`}>{k.sub}</span> : null}
    </span>
  );
}
const trendTone = (k) => (k.trend ? (k.trend.dir === 'up' ? 'up' : (k.trend.dir === 'down' ? 'down' : 'flat')) : 'neutral');

function channelLine(c) {
  if (c.calls) return `${fmtNum(c.sent)} call${c.sent === 1 ? '' : 's'} logged in this period`;
  if (!c.connected) return c.why;
  if (!c.sent) return c.rehearsed ? `Nothing really sent (${fmtNum(c.rehearsed)} rehearsed in Test mode)` : 'Nothing sent in this period';
  return `${fmtNum(c.sent)} sent · ${c.delivered ? `${c.deliveredPct}% delivered` : `${c.engagePct}% engagement`}`;
}

export default function OverviewPage() {
  const { acc, go, toast } = useOmni();
  const [range, setRange] = useState('30d');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [popup, setPopup] = useState(null); // { type: 'kpi' | 'channel' | 'insight', key }
  const [hello, setHello] = useState(greeting());
  const load = useCallback(() => {
    setErr('');
    return omni.get('/gs/overview', { range }).then((d) => setData(d)).catch((e) => { setData(null); setErr(errOf(e, 'The dashboard could not be loaded.')); });
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setHello(greeting()), 60000); return () => clearInterval(t); }, []);

  const dismiss = async (i) => {
    try { await omni.post(`/gs/overview/insights/${i.key}/dismiss`); setData((d) => ({ ...d, insights: d.insights.filter((x) => x.key !== i.key) })); toast('Hidden for 7 days'); } catch (e) { toast(errOf(e, 'It could not be hidden.')); }
    setPopup(null);
  };
  const openAnalytics = () => go('analytics');

  const head = (
    <PageHead eyebrow="Command center" title={`${hello} 👋`} lead="One workspace to create, publish, automate and understand every customer interaction.">
      {acc && acc.canSettings && <Btn onClick={() => go('settings')}>Manage Workspace</Btn>}
      {acc && acc.canCampaign && <Btn primary onClick={() => go('campaigns', { new: '1' })}>＋ New Campaign</Btn>}
    </PageHead>
  );
  if (err) return <div>{head}<Banner tone="error">{err} <button type="button" className="ov-banner-link" onClick={load}>Try again</button></Banner></div>;
  if (!data) return <div>{head}<FlowStrip /><div className="card panel" style={{ fontSize: 11, color: 'var(--muted)' }}>Loading the numbers…</div></div>;
  if (!data.ready) return <div>{head}<Banner tone="warn">Omni-Channel is being set up. Please try again in a little while.</Banner></div>;

  const k = data.kpis;
  const rangeLabel = (RANGES.find(([v]) => v === range) || RANGES[0])[1];
  const pop = popup && popup.type === 'kpi' ? data.details[popup.key] : null;
  const chan = popup && popup.type === 'channel' ? data.channels.find((c) => c.id === popup.key) : null;
  const ins = popup && popup.type === 'insight' ? data.insights.find((i) => i.key === popup.key) : null;

  return (
    <div>
      {head}
      {data.testMode && <Banner tone="test"><b>Test mode is ON.</b> Campaigns are only rehearsed: nothing goes to real people, and rehearsals are never counted in Reach or Engagement.</Banner>}
      <FlowStrip />
      <div className="ov-range-note">Numbers on this page are for: <b>{rangeLabel}</b> (change it in the chart below)</div>
      <Kpis>
        <Kpi label="Reach" icon="↗" value={fmtNum(k.reach.value)} meta={<Trend k={k.reach} />} tone={trendTone(k.reach)} onClick={() => setPopup({ type: 'kpi', key: 'reach' })} hint="People who were really sent a message" />
        <Kpi label="Engagement" icon="◎" value={k.engagement.value === null ? '—' : `${k.engagement.value}%`} meta={<Trend k={k.engagement} />} tone={trendTone(k.engagement)} onClick={() => setPopup({ type: 'kpi', key: 'engagement' })} hint="Link taps and replies as a share of the messages sent" />
        <Kpi label="Leads" icon="◉" value={fmtNum(k.leads.value)} meta={<Trend k={k.leads} />} tone={trendTone(k.leads)} onClick={() => setPopup({ type: 'kpi', key: 'leads' })} hint="New contacts plus applications that came from campaigns" />
        <Kpi label="Conversions" icon="✓" value={k.conversions.value === null ? <span className="kpi-value small">Not linked</span> : fmtNum(k.conversions.value)} meta={<Trend k={k.conversions} />} tone={trendTone(k.conversions)} onClick={() => setPopup({ type: 'kpi', key: 'conversions' })} hint="Applications linked to a campaign, and how far they went" />
        <Kpi label="Campaigns" icon="◈" value={fmtNum(k.campaigns.value)} meta={<Trend k={k.campaigns} />} tone="neutral" onClick={() => setPopup({ type: 'kpi', key: 'campaigns' })} hint="Every campaign you may see" />
      </Kpis>

      <div className="grid dashboard-grid">
        <Panel title="Performance overview" sub="People reached and people who clicked or replied, by the day the message was sent"
          right={<select className="select" aria-label="Period" value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}>
          <PerfChart series={data.series} onOpen={openAnalytics} />
          <div className="chart-hint">Hover a point for details · click the chart to open full Analytics</div>
          <div className="legend"><span><i style={{ background: '#11985a' }} />Reach</span><span><i style={{ background: '#4d7ddb' }} />Engagement</span></div>
        </Panel>
        <Panel title="Channel health" sub="Connected channels and delivery status" right={acc && acc.canSettings ? <Btn onClick={() => go('settings')}>Manage</Btn> : null}>
          <div className="health-list">
            {data.channels.map((c) => (
              <div className="health" key={c.id} role="button" tabIndex={0} onClick={() => setPopup({ type: 'channel', key: c.id })} onKeyDown={(e) => { if (e.key === 'Enter') setPopup({ type: 'channel', key: c.id }); }}>
                <div className={`h-icon ${ICON[c.id]}`}>{c.short}</div>
                <div><strong>{c.name}</strong><small>{channelLine(c)}</small></div>
                <div className={`status-dot${c.state === 'connected' ? '' : ` ov-s-${c.state}`}`}><i />{c.stateWords}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid dashboard-bottom">
        <Panel title="Recent campaigns" sub="Latest activity across your workspace" right={<Btn onClick={() => go('campaigns')}>View all</Btn>}>
          {data.recent.length === 0 ? (
            <Empty title="No campaigns yet" action={acc && acc.canCampaign ? <Btn primary onClick={() => go('campaigns', { new: '1' })}>＋ New Campaign</Btn> : null}>Campaigns you are allowed to see will appear here.</Empty>
          ) : (
            <div className="table-scroll"><table className="table"><thead><tr><th>Campaign</th><th>Channel</th><th>Status</th><th>Engagement</th><th>Conversion</th></tr></thead><tbody>
              {data.recent.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => go('campaigns', { open: r.id })}>
                  <td className="campaign-name">{r.name}</td>
                  <td><div className="channel-tags"><Tag green>{r.channelName}</Tag>{r.rehearsal && <Tag title="Test mode: nothing was really sent">Rehearsal</Tag>}</div></td>
                  <td><StatusPill status={r.status} words={r.statusWords} /></td>
                  <td>{r.engagePct === null ? '—' : `${r.engagePct}%`}</td>
                  <td>{r.conversion === null ? (r.conversionNote || '—') : fmtNum(r.conversion)}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Panel>
        <Panel title="Actionable insights" sub="What to do next">
          {data.insights.length === 0 ? (
            <Empty title="Nothing needs your attention">Tips and problems appear here when the numbers show them.</Empty>
          ) : (
            <div className="insights">
              {data.insights.map((i) => (
                <div className="insight" key={i.key} role="button" tabIndex={0} onClick={() => setPopup({ type: 'insight', key: i.key })} onKeyDown={(e) => { if (e.key === 'Enter') setPopup({ type: 'insight', key: i.key }); }}>
                  <div className="insight-head"><strong>{i.title}</strong><span>{i.tag}</span></div>
                  <p>{i.text}</p>
                  <div className="mini-progress"><span style={{ width: `${Math.max(3, i.score)}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {pop && (
        <DetailModal title={pop.title} subtitle={pop.subtitle} onClose={() => setPopup(null)} foot={<><Btn onClick={() => setPopup(null)}>Close</Btn><Btn primary onClick={() => { setPopup(null); openAnalytics(); }}>Open full analytics</Btn></>}>
          <p className="dd-note">{pop.note}</p>
          {pop.rows.length === 0 && <p style={{ fontSize: 11, color: 'var(--muted)' }}>Nothing to break down yet.</p>}
          <DetailRows rows={pop.rows} />
        </DetailModal>
      )}
      {chan && (
        <DetailModal title={`${chan.name} channel health`} subtitle={`${chan.stateWords}${chan.connected ? '' : ''}`} onClose={() => setPopup(null)}
          foot={<><Btn onClick={() => setPopup(null)}>Close</Btn>{acc && acc.canSettings && <Btn primary onClick={() => { setPopup(null); go('settings'); }}>Manage channel</Btn>}</>}>
          {chan.calls ? (
            <DetailRows rows={[{ label: 'Calls logged', value: fmtNum(chan.sent), pct: 100 }]} />
          ) : (
            <DetailRows rows={[
              { label: 'Sent / Reach', value: fmtNum(chan.sent), pct: chan.sent ? 100 : 0 },
              { label: 'Delivered', value: chan.sent ? (chan.delivered ? `${chan.deliveredPct}%` : 'Not confirmed') : '—', pct: chan.deliveredPct || 0 },
              { label: 'Engagement', value: chan.engagePct === null ? '—' : `${chan.engagePct}%`, pct: Math.min(100, (chan.engagePct || 0) * 4) },
              { label: 'Failed', value: fmtNum(chan.failed), pct: chan.sent + chan.failed ? Math.round((chan.failed / (chan.sent + chan.failed)) * 100) : 0 },
            ]} />
          )}
          <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 14 }}><b style={{ color: 'var(--ink)' }}>Connection:</b> {chan.why}</p>
          {!chan.calls && <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 6 }}><b style={{ color: 'var(--ink)' }}>Top campaign:</b> {chan.topCampaign ? `${chan.topCampaign.name} (${fmtNum(chan.topCampaign.sent)} sent)` : 'No campaign really sent on this way in this period.'}</p>}
          <p style={{ fontSize: 10, color: 'var(--muted)', marginTop: 8, lineHeight: 1.6 }}>{chan.tip}</p>
        </DetailModal>
      )}
      {ins && (
        <DetailModal title={ins.title} subtitle="Actionable insight" onClose={() => setPopup(null)}
          foot={<><Btn onClick={() => dismiss(ins)}>Dismiss</Btn><Btn primary onClick={() => { setPopup(null); go(ins.action.page, ins.action.params); }}>{ins.action.label}</Btn></>}>
          <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>{ins.body}</p>
          <p style={{ fontSize: 9, color: '#8b968f' }}>Dismiss hides this tip for 7 days, for you only.</p>
        </DetailModal>
      )}
    </div>
  );
}
