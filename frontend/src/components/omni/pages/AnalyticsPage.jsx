import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Tabs, Banner, Empty } from '../ui.jsx';
import DateRangeMenu from '../overview/DateRangeMenu.jsx';
import CommTab from '../overview/CommTab.jsx';
import FunnelTab from '../overview/FunnelTab.jsx';
import SocialTab from '../overview/SocialTab.jsx';
import { presetRange, fmtDay, countDays, downloadText } from '../overview/dateRange.js';
import '../overview/overview.css';

const LegacyViews = lazy(() => import('../overview/LegacyViews.jsx'));

// ---------------------------------------------------------------------------
// ANALYTICS & REPORTS (the Green Start prototype's page, on REAL numbers; GET /api/outreach/gs/analytics/*, outreach/insights.js):
//   Communication Analytics | Social Media Analytics | Conversion Funnel      (date-range button: presets + two-month calendar, India days)
//   + the staff's earlier views as extra tabs: Team performance | ROI | Reports | My activity  (same role rules as before: hubs.insights / myActivity)
// ?tab=comm|social|funnel|performance|roi|reports|mine   (old Insights links land here)
// ---------------------------------------------------------------------------
const BASE = [['comm', 'Communication Analytics'], ['social', 'Social Media Analytics'], ['funnel', 'Conversion Funnel']];
const initialRange = () => ({ ...presetRange('Last 30 days'), preset: 'Last 30 days' });

export default function AnalyticsPage() {
  const { acc, go, toast } = useOmni();
  const [sp, setSp] = useSearchParams();
  const hubs = (acc && acc.hubs) || {};
  const extra = useMemo(() => {
    const ins = Array.isArray(hubs.insights) ? hubs.insights : [];
    const out = [];
    if (ins.includes('performance')) out.push(['performance', 'Team performance']);
    if (ins.includes('roi')) out.push(['roi', 'ROI']);
    if (ins.includes('reports')) out.push(['reports', 'Reports']);
    if (hubs.myActivity) out.push(['mine', 'My activity']);
    return out;
  }, [hubs.insights, hubs.myActivity]);
  const tabs = useMemo(() => [...BASE, ...extra], [extra]);
  const want = sp.get('tab');
  const tab = tabs.some(([id]) => id === want) ? want : 'comm';
  const setTab = (id) => setSp(id === 'comm' ? {} : { tab: id });

  const [range, setRange] = useState(initialRange);
  const [channel, setChannel] = useState('');
  const [comm, setComm] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const applied = useRef(false);

  const loadComm = useCallback(() => {
    setBusy(true); setErr('');
    return omni.get('/gs/analytics/comm', { from: range.from, to: range.to, preset: range.preset })
      .then((d) => { setComm(d); if (applied.current) { applied.current = false; toast(`${range.preset} applied — ${countDays(range.from, range.to)} day${countDays(range.from, range.to) === 1 ? '' : 's'}, ${d.campaignsInRange || 0} campaign${d.campaignsInRange === 1 ? '' : 's'}`); } })
      .catch((e) => { setComm(null); setErr(errOf(e, 'The numbers could not be loaded.')); }).finally(() => setBusy(false));
  }, [range, toast]);
  const loadFunnel = useCallback(() => {
    setBusy(true); setErr('');
    return omni.get('/gs/analytics/funnel', { from: range.from, to: range.to, channel })
      .then((d) => setFunnel(d)).catch((e) => { setFunnel(null); setErr(errOf(e, 'The funnel could not be loaded.')); }).finally(() => setBusy(false));
  }, [range, channel]);
  useEffect(() => { if (tab === 'comm') loadComm(); }, [tab, loadComm]);
  useEffect(() => { if (tab === 'funnel') loadFunnel(); }, [tab, loadFunnel]);

  const onApply = (r) => { applied.current = true; setRange(r); };
  const exportReport = async () => {
    setExporting(true);
    try {
      const blob = await omni.blob('/gs/analytics/report.csv', { from: range.from, to: range.to });
      const text = await blob.text();
      downloadText(text.replace(/^﻿/, ''), 'analytics_report.csv');
      toast('analytics_report.csv downloaded');
    } catch { toast('The report could not be made. You may not be allowed to download it.'); } finally { setExporting(false); }
  };

  const dated = tab === 'comm' || tab === 'funnel';
  const showNote = tab === 'comm' && comm && comm.ready !== false && !err;
  return (
    <div>
      <PageHead eyebrow="Measure every interaction" title="Analytics & Reports" lead="Track performance across all your marketing channels.">
        {acc && acc.canExportReport && <Btn disabled={exporting} onClick={exportReport}>⬇ Export report</Btn>}
      </PageHead>
      <div className="an-top">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        {dated && <DateRangeMenu value={range} onApply={onApply} />}
      </div>

      {err && <Banner tone="error">{err} <button type="button" className="ov-banner-link" onClick={tab === 'funnel' ? loadFunnel : loadComm}>Try again</button></Banner>}
      {showNote && (
        <>
          <div className="dr-note"><b>{comm.campaignsInRange}</b> of {comm.campaignsTotal} campaign{comm.campaignsTotal === 1 ? '' : 's'} fall in {range.preset.toLowerCase()} ({fmtDay(range.from)} – {fmtDay(range.to)}, {countDays(range.from, range.to)} day{countDays(range.from, range.to) === 1 ? '' : 's'}). A campaign counts on the day it started.</div>
          {comm.campaignsInRange === 0 && (
            <div className="dr-empty"><b>{comm.campaignsTotal === 0 ? 'No campaigns yet' : 'No campaigns in this date range'}</b>{comm.campaignsTotal === 0 ? 'Campaigns you are allowed to see will be counted here once they exist.' : 'Widen the range, or pick a preset like Last 30 days.'}</div>
          )}
        </>
      )}
      {tab === 'comm' && !comm && !err && <div className="card panel" style={{ fontSize: 11, color: 'var(--muted)' }}>{busy ? 'Loading the numbers…' : ' '}</div>}
      {tab === 'comm' && comm && comm.ready === false && <Banner tone="warn">{comm.error}</Banner>}
      {tab === 'comm' && comm && comm.ready !== false && <CommTab data={comm} go={go} />}

      {tab === 'social' && <SocialTab go={go} />}

      {tab === 'funnel' && !funnel && !err && <div className="card panel" style={{ fontSize: 11, color: 'var(--muted)' }}>{busy ? 'Loading the funnel…' : ' '}</div>}
      {tab === 'funnel' && funnel && funnel.ready === false && <Banner tone="warn">Campaigns are being set up.</Banner>}
      {tab === 'funnel' && funnel && funnel.ready !== false && <FunnelTab data={funnel} channel={channel} setChannel={setChannel} toast={toast} />}

      {extra.some(([id]) => id === tab) && (
        <Suspense fallback={<div className="card panel" style={{ fontSize: 11 }}>Loading…</div>}>
          <div className="card panel" style={{ overflowX: 'auto' }}><LegacyViews which={tab} acc={acc} /></div>
        </Suspense>
      )}
      {!tabs.length && <Empty title="Nothing to show">Analytics is not available for your login.</Empty>}
    </div>
  );
}
