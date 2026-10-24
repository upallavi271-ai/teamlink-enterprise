import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Banner, Btn, Pill } from '../ui.jsx';
import MessageLogsModal from './MessageLogsModal.jsx';
import { CH_COLOR, n0, saveBlob } from './shared.jsx';

const R = 90; const r = 52; const cx = 100; const cy = 100;
function arc(a0, a1) {
  const xy = (ang, rad) => { const rr = ((ang - 90) * Math.PI) / 180; return [cx + rad * Math.cos(rr), cy + rad * Math.sin(rr)]; };
  const [x1, y1] = xy(a0, R); const [x2, y2] = xy(a1, R); const [x3, y3] = xy(a1, r); const [x4, y4] = xy(a0, r);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${large} 0 ${x4} ${y4} Z`;
}

// the analytics page of one campaign: six tiles, the delivery donut, the message preview and why messages failed or were left out. Real numbers only.
export default function CampaignAnalytics({ campaignKey, onBack }) {
  const { toast, go } = useOmni();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [logs, setLogs] = useState(false);
  const [tip, setTip] = useState(null);
  const load = useCallback(async () => { try { setD(await omni.get(`/gs/campaigns/campaign/${campaignKey}/analytics`)); setErr(''); } catch (e) { setErr(errOf(e, 'The analytics could not be loaded.')); } }, [campaignKey]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && !logs) onBack(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [logs, onBack]);

  if (err) return <div><button type="button" className="ca-back" onClick={onBack}>← Back to Campaigns</button><Banner tone="error">{err}</Banner></div>;
  if (!d) return <div className="card panel">Loading…</div>;
  const c = d.campaign; const t = d.tiles;
  const exportCsv = async () => {
    if (!d.hasData) { toast('No delivery data yet to export'); return; }
    try { saveBlob(await omni.blob(`/gs/campaigns/campaign/${campaignKey}/analytics.csv`), `${campaignKey}_analytics.csv`); toast('Analytics downloaded'); } catch (e) { toast(errOf(e, 'The file could not be made.')); }
  };
  const head = (
    <div className="ca-head" style={{ padding: '0 0 18px', marginBottom: 18 }}>
      <div>
        <button type="button" className="ca-back" onClick={onBack}>← Back to Campaigns</button>
        <div className="ca-title" style={{ overflowWrap: 'anywhere' }}>{c.name}</div>
        <div className="ca-meta"><span>{c.channels.map((x) => x.words).join(' · ')}</span><span>•</span><span>{c.objective}</span><span>•</span><Pill tone={c.statusTone}>{c.statusWords}</Pill></div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="icon-btn" aria-label="Refresh" onClick={() => { load(); toast('Analytics refreshed'); }}>↻</button>
        <Btn onClick={exportCsv}>⬇ Export CSV</Btn>
        <Btn primary onClick={() => { if (!d.hasData) { toast('No delivery data yet for this campaign'); return; } setLogs(true); }}>☰ View Detailed Logs</Btn>
        <Btn onClick={() => go('campaigns', { c: campaignKey })}>Open command center</Btn>
      </div>
    </div>
  );
  if (!d.hasData) {
    return <div>{head}<div className="ca-empty"><div style={{ fontSize: 30, marginBottom: 10 }}>📭</div><b>No delivery data yet</b><p style={{ fontSize: 11, marginTop: 6 }}>Analytics will appear here once this campaign has been sent.</p></div></div>;
  }
  const tiles = [
    { l: 'Total Messages', v: t.total, i: '📈', bg: '#fff3da' },
    { l: t.labels.sent, v: t.sent, i: '📈', bg: '#fff3da' },
    { l: t.labels.delivered, v: t.delivered, i: '✓', bg: '#e7f6ed' },
    { l: t.labels.readAnswered, v: t.readAnswered, i: '✔✔', bg: '#e7f6ed' },
    { l: 'Failed', v: t.failed, i: '✕', bg: '#fbe9e9' },
    { l: 'Responses', v: t.responses, i: '💬', bg: '#eef2ff', click: true },
  ];
  const total = d.slices.reduce((a, s) => a + s.value, 0) || 1;
  let acc = 0;
  const arcs = d.slices.filter((s) => s.value > 0).map((s) => { const a0 = (acc / total) * 360; acc += s.value; const a1 = (acc / total) * 360 - (acc === total && a0 === 0 ? 0.01 : 0); return { ...s, a0, a1, pct: Math.round((s.value / total) * 100) }; });
  const maxReason = Math.max(...d.reasons.map((x) => x.count), 1);
  const p = d.preview; const col = (p && CH_COLOR[p.channel]) || '#11985a';
  return (
    <div>
      {head}
      {d.rehearsal && <Banner tone="test"><b>Rehearsal.</b> Test mode was ON when this was sent: the rows were made and logged, but nothing was really sent to anybody. Numbers marked Sent here are rehearsed messages.</Banner>}
      <div className="ca-body">
        <div className="ca-metrics">
          {tiles.map((x) => (
            <div key={x.l} className="ca-metric" style={x.click ? { cursor: 'pointer' } : undefined} onClick={x.click ? () => go('campaigns', { c: campaignKey, dt: 'replies' }) : undefined} role={x.click ? 'button' : undefined} title={x.click ? 'Open the replies' : undefined}>
              <span className="ca-metric-icon" style={{ background: x.bg }}>{x.i}</span><small>{x.l}</small><b>{n0(x.v)}</b>
            </div>
          ))}
        </div>
        <div className="ca-grid">
          <div className="ca-panel">
            <b style={{ fontSize: 12 }}>Delivery Status Distribution</b>
            <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <svg viewBox="0 0 200 200" width="150" height="150" role="img" aria-label="Delivery status distribution">
                {arcs.map((s) => <path key={s.label} d={arc(s.a0, s.a1)} fill={s.color} className="donut-arc" onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY, a: s.label, b: `${n0(s.value)} messages (${s.pct}%)` })} onMouseLeave={() => setTip(null)} />)}
              </svg>
            </div>
            <div className="donut-legend">{d.slices.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label} {n0(s.value)}</span>)}</div>
          </div>
          <div className="ca-panel">
            {p ? (
              <>
                <small style={{ color: 'var(--muted)', fontSize: 9 }}>Template Name:</small>
                <div style={{ fontWeight: 800, fontSize: 11, marginTop: 2, overflowWrap: 'anywhere' }}>{p.templateName || p.words}</div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>{p.category && <span className="pill scheduled">{p.category}</span>}{p.language && <span className="pill draft">{p.language}</span>}<span className="pill draft">{p.words}</span></div>
                <div className="phone" style={{ width: 200, minHeight: 360, margin: '12px auto 0', transform: 'scale(.78)', transformOrigin: 'top center' }}>
                  <div className="phone-top"><span>{p.words}</span><span>sample</span></div>
                  {p.channel === 'call'
                    ? <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: 8 }}><div style={{ width: 46, height: 46, borderRadius: '50%', background: `${col}22`, display: 'grid', placeItems: 'center', fontSize: 17 }}>🎙</div><div style={{ fontSize: 8, lineHeight: 1.5, color: 'var(--muted)', maxWidth: 170 }}>{p.body}</div></div>
                    : <div className="bubble" style={{ background: `${col}22`, whiteSpace: 'pre-wrap' }}>{p.subject ? `${p.subject}\n\n` : ''}{p.body}{p.cta ? <><br /><br /><span style={{ display: 'inline-block', background: '#fff', padding: '4px 7px', borderRadius: 6, fontWeight: 850, color: col }}>{p.cta}</span></> : null}</div>}
                </div>
              </>
            ) : <div style={{ fontSize: 11, color: 'var(--muted)' }}>No message words are saved with this campaign yet.</div>}
          </div>
        </div>
        <div className="ca-panel" style={{ position: 'relative', marginTop: 14 }}>
          <b style={{ fontSize: 12 }}>Failure Reasons Analysis</b>
          <div style={{ fontSize: 10, color: 'var(--muted)', margin: '3px 0 8px' }}>Why a message failed, or why a person was left out (counts of people).</div>
          {!d.reasons.length && <div style={{ fontSize: 11, color: 'var(--muted)' }}>Nothing failed and nobody was left out.</div>}
          {d.reasons.map((x) => (
            <div key={x.reason} className="fail-bar-row" onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY, a: x.label, b: `${x.desc} Count: ${x.count}` })} onMouseLeave={() => setTip(null)}>
              <span>{x.label}</span>
              <div className="fail-bar-track"><span className="fail-bar-fill" style={{ width: `${Math.round((x.count / maxReason) * 100)}%`, background: x.color }} /></div>
              <b>{n0(x.count)}</b>
            </div>
          ))}
        </div>
      </div>
      {tip && <div className="cmp-tooltip" style={{ position: 'fixed', left: tip.x + 12, top: tip.y + 12 }}><b>{tip.a}</b><br />{tip.b}</div>}
      {logs && <MessageLogsModal campaignKey={campaignKey} name={c.name} onClose={() => setLogs(false)} />}
    </div>
  );
}
