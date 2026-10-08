import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import {
  KpiRow, KpiTile, Panel, QuickActions, Avatar, Icon, fmtNum, pctChange,
} from '../atskit/AtsKit.jsx';
import { DATE_RANGES, rangeDates } from '../ui/PageFilterBar.jsx';
import { plainWords } from '../ui/Guide.jsx';
import { TrendLines, FunnelShape } from './charts.jsx';
import './reportsV4.css';

// ---------------------------------------------------------------------------
// REPORTS & ANALYTICS — the overview on top of Reports -> ATS Reports
// (redesign 2026-10-08). PRESENTATION over EXISTING endpoints only:
//
//   GET /ats-reports/recruitment            KPI tiles, Department-wise, Key insights
//                                           (+ ?compare=month when the period is This month)
//   GET /ats-reports/recruitment?groupBy=tl       Team performance
//   GET /ats-reports/recruitment?groupBy=location Location-wise (job location)
//   GET /ats-reports/recruiters             Top performing recruiters (+ recruiters per TL)
//   GET /ats-reports/funnel                 Hiring funnel
//   GET /insights/ats                       Application trend (applications per day/week/month)
//   GET /ats-daily/month                    Interviews scheduled per day (trend, ranges up to a month)
//   GET /ats-daily/day                      Recent activity (today's recorded work)
//
// The server scopes every one of them by role; this screen never widens it.
// Every number that the report can list opens its list (the page's DrillModal).
// ---------------------------------------------------------------------------

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function useGet(url, params, enabled = true) {
  const key = url && enabled ? `${url}|${JSON.stringify(params || {})}` : '';
  const [st, setSt] = useState({ data: null, error: '', loading: !!key });
  useEffect(() => {
    if (!key) { setSt({ data: null, error: '', loading: false }); return undefined; }
    let live = true;
    setSt((s) => ({ ...s, loading: true, error: '' }));
    api.get(url, params ? { params } : undefined)
      .then((r) => { if (live) setSt({ data: r.data, error: '', loading: false }); })
      .catch((e) => {
        if (live) setSt({ data: null, error: e.response?.status === 403 ? 'This is not part of your role.' : 'Could not load this — try again later.', loading: false });
      });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

// A section of a report response, read defensively (the owner's server may
// send more columns): get(row, 'joined') by column key.
function sectionOf(data, id) {
  const s = data && Array.isArray(data.sections) ? data.sections.find((x) => x.id === id) : null;
  if (!s) return null;
  const idx = Object.fromEntries((s.columns || []).map((c, i) => [c.key, i]));
  const get = (r, k) => (idx[k] === undefined || !r || !r.c ? null : r.c[idx[k]]);
  return { ...s, rows: s.rows || [], get, has: (k) => idx[k] !== undefined };
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctTxt = (v) => (v === null || v === undefined || v === '' ? '—' : `${v}%`);
const NOT_SET = '—';

// The trend's period for GET /insights/ats (it knows presets and custom
// ranges). "Any time" draws the last 12 months.
function trendParams(pf) {
  const map = { today: 'today', week: 'this_week', month: 'this_month' };
  const out = pf.department ? { department: pf.department } : {};
  if (map[pf.range]) return { ...out, range: map[pf.range] };
  if (pf.range === '30d' || pf.range === 'custom') {
    const d = rangeDates(pf.range, pf.from, pf.to);
    if (d.from && d.to) return { ...out, range: 'custom', from: d.from, to: d.to };
  }
  const now = new Date();
  return { ...out, range: 'custom', from: ymd(new Date(now.getFullYear(), now.getMonth() - 11, 1)), to: ymd(now), anyTime: '1' };
}

const KPIS = [
  { key: 'applications', label: 'Total applications', icon: 'file', tone: 'blue' },
  { key: 'pipeline', label: 'In pipeline', icon: 'users', tone: 'green' },
  { key: 'interview', label: 'Interviews', icon: 'calendar', tone: 'violet' },
  { key: 'selected', label: 'Selected', icon: 'check', tone: 'teal' },
  { key: 'joined', label: 'Joined', icon: 'handshake', tone: 'green' },
  { key: 'rejected', label: 'Rejected', icon: 'x', tone: 'red', bad: true },
  { key: 'hold', label: 'Hold', icon: 'pause', tone: 'slate', bad: true },
];

// Quick reports: existing report tabs only (card id rides along for the
// report's views switch).
const QUICK = [
  { tab: 'recruitment', card: 'people', icon: 'file', label: 'Applications report', sub: 'Every application, step by step' },
  { tab: 'clients', card: 'clientsjobs', icon: 'building', label: 'Client-wise report', sub: 'Jobs and joinings per client' },
  { tab: 'recruiters', card: 'team', icon: 'user', label: 'Recruiter performance', sub: 'Sent, interviews, joined' },
  { tab: 'departments', card: 'depts', icon: 'chart', label: 'Department report', sub: 'Open jobs to joined, per department' },
  { tab: 'daily', card: 'daily', icon: 'calendar', label: 'Daily & monthly summary', sub: 'What each recruiter did, day or month' },
  { tab: 'rejections', card: 'rejections', icon: 'x', label: 'Rejection analysis', sub: 'Who rejects people, and why' },
];

const ACT_ICON = {
  added: 'plus', calls: 'chat', mails: 'send', followUps: 'refresh', reviewed: 'file', sentTl: 'team', sentClient: 'send',
  interviews: 'calendar', attended: 'check', feedback: 'chat', offers: 'star', joined: 'handshake',
};
const ACT_TONE = ['violet', 'teal', 'amber', 'blue', 'pink', 'green'];

function NumBtn({ value, onClick, fmt = fmtNum }) {
  const v = num(value);
  if (!onClick || v <= 0) return <span>{value === null || value === undefined ? '—' : fmt(v)}</span>;
  return <button type="button" className="rv4-num-btn" onClick={onClick} title="Show who is behind this number">{fmt(v)}</button>;
}

function ExportMenu({ busy, onExport }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="rv4-export" ref={ref}>
      <button type="button" className="rv4-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!!busy}
        title="Download the applications report for this period (Excel, PDF or CSV)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
        {busy ? 'Preparing…' : 'Export report'}
      </button>
      {open && (
        <span className="rv4-export-menu" role="menu">
          {[['xlsx', 'Excel (.xlsx)'], ['pdf', 'PDF'], ['csv', 'CSV']].map(([f, l]) => (
            <button key={f} type="button" role="menuitem" onClick={() => { setOpen(false); onExport(f); }}>{l}</button>
          ))}
        </span>
      )}
    </span>
  );
}

export default function ReportsOverview({
  pf, setPf, queryFor, cat, canExport, busy, onExport, onDrill, onOpen, children,
}) {
  const allowed = !!(cat && cat.view);
  const [error, setError] = useState('');
  const doExport = async (format) => { setError(''); const msg = await onExport(format); if (msg) setError(msg); };
  const isMonth = pf.range === 'month';
  const otherFilters = !!(pf.clientId || pf.recruiterId || pf.bdeId);

  // --- data (every call an existing endpoint; the server scopes it) --------
  const qDept = queryFor(isMonth ? { compare: 'month' } : {});
  const qTl = queryFor({ groupBy: 'tl' });
  const qLoc = queryFor({ groupBy: 'location' });
  const qPlain = queryFor({});
  const dept = useGet(`/ats-reports/recruitment?${qDept}`, null, allowed);
  const tl = useGet(`/ats-reports/recruitment?${qTl}`, null, allowed);
  const loc = useGet(`/ats-reports/recruitment?${qLoc}`, null, allowed);
  const recs = useGet(`/ats-reports/recruiters?${qPlain}`, null, allowed);
  const fun = useGet(`/ats-reports/funnel?${qPlain}`, null, allowed);
  const tParams = useMemo(() => trendParams(pf), [pf]);
  const { anyTime, ...insightParams } = tParams;
  const trend = useGet('/insights/ats', insightParams, allowed);
  const dailyParams = pf.department ? { department: pf.department } : {};
  const today = useGet('/ats-daily/day', dailyParams, allowed);

  // Interviews scheduled per day (Daily report, month view) — only when the
  // trend is drawn day by day (a range of up to a month: one or two months).
  const trChart = trend.data && Array.isArray(trend.data.charts)
    ? (trend.data.charts.find((c) => c.id === 'ats-trend') || trend.data.charts.find((c) => c.kind === 'trend')) : null;
  const tr = trChart && Array.isArray(trChart.rows) ? { ...trChart, period: trend.data.period } : null;
  const dayMonths = tr && tr.bucket === 'day' ? [...new Set(tr.rows.map((r) => String(r.key).slice(0, 7)))].slice(0, 2) : [];
  const m1 = useGet('/ats-daily/month', { month: dayMonths[0], ...dailyParams }, allowed && dayMonths.length > 0);
  const m2 = useGet('/ats-daily/month', { month: dayMonths[1], ...dailyParams }, allowed && dayMonths.length > 1);

  const drill = (tab, query, section, row, col, title) => onDrill({ tab, query, section, row, col, title });

  // --- KPI tiles --------------------------------------------------------------
  const d = dept.data;
  const cmp = d && d.compare;
  const periodLabel = d ? (cmp ? cmp.label : (d.period && d.period.label)) : '';
  const tileSub = ((DATE_RANGES.find(([k]) => k === (pf.range || '')) || [])[1] || '').replace('Any time', 'All time') || undefined;
  const tileOf = (k) => (d && Array.isArray(d.tiles) ? d.tiles.find((t) => t.key === k) : null);

  // --- rows ------------------------------------------------------------------
  const deptSec = sectionOf(d, 'recruitment');
  const deptRows = deptSec ? [...deptSec.rows].sort((a, b) => num(deptSec.get(b, 'applications')) - num(deptSec.get(a, 'applications'))) : [];
  const recSec = sectionOf(recs.data, 'recruiters');
  const recRows = recSec ? recSec.rows.filter((r) => r.key !== NOT_SET && num(recSec.get(r, 'candidates')) > 0) : [];
  const topRecs = [...recRows].sort((a, b) => (num(recSec.get(b, 'joined')) - num(recSec.get(a, 'joined')))
    || (num(recSec.get(b, 'interviews')) - num(recSec.get(a, 'interviews')))
    || (num(recSec.get(b, 'candidates')) - num(recSec.get(a, 'candidates')))).slice(0, 5);
  const recsPerTl = useMemo(() => {
    const m = new Map();
    if (recSec && recSec.has('tl')) recRows.forEach((r) => { const t = recSec.get(r, 'tl'); if (t && t !== NOT_SET) m.set(t, (m.get(t) || 0) + 1); });
    return m;
  }, [recs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const tlSec = sectionOf(tl.data, 'recruitment');
  const tlRows = tlSec ? tlSec.rows.filter((r) => r.key !== NOT_SET).sort((a, b) => num(tlSec.get(b, 'applications')) - num(tlSec.get(a, 'applications'))).slice(0, 5) : [];
  const locSec = sectionOf(loc.data, 'recruitment');
  const locAll = locSec ? locSec.rows.filter((r) => num(locSec.get(r, 'applications')) > 0).sort((a, b) => num(locSec.get(b, 'applications')) - num(locSec.get(a, 'applications'))) : [];
  const locTotal = locAll.reduce((n, r) => n + num(locSec.get(r, 'applications')), 0);
  const locTop = locAll.slice(0, locAll.length > 5 ? 4 : 5);
  const locRest = locAll.slice(locTop.length).reduce((n, r) => n + num(locSec.get(r, 'applications')), 0);
  const funSec = sectionOf(fun.data, 'funnel');

  // --- key insights (from the same department rows) ----------------------------
  const named = deptRows.filter((r) => r.key !== NOT_SET);
  const best = (k, pred = () => true) => named.filter(pred).reduce((b, r) => (!b || num(deptSec.get(r, k)) > num(deptSec.get(b, k)) ? r : b), null);
  const hiConv = deptSec && best('conv', (r) => num(deptSec.get(r, 'applications')) > 0);
  const hiApps = deptSec && best('applications');
  const hiJoin = deptSec && best('joined');
  const hiRej = deptSec && deptSec.has('rejected') ? best('rejected') : null;
  const insight = (r, k, fmt) => (r && num(deptSec.get(r, k)) > 0 ? `${plainWords(String(r.c[0]))} (${fmt(deptSec.get(r, k))})` : null);

  // --- trend series ------------------------------------------------------------------
  const ivByDay = new Map();
  [m1.data, m2.data].forEach((m) => (m && Array.isArray(m.days) ? m.days : []).forEach((x) => ivByDay.set(x.date, num(x.interviews))));
  const trendLabels = tr ? tr.rows.map((r) => r.label) : [];
  const trendSeries = tr ? [
    { name: 'Applications', tone: 'blue', values: tr.rows.map((r) => num(r.values && r.values[0])) },
    ...(dayMonths.length && (m1.data || m2.data) ? [{ name: 'Interviews scheduled', tone: 'violet', values: tr.rows.map((r) => ivByDay.get(r.key) || 0) }] : []),
  ] : [];
  const trendEmpty = tr && trendSeries.every((s) => s.values.every((v) => !v));

  // --- recent activity (today's recorded work) ----------------------------------------
  const td = today.data;
  const actRows = td && Array.isArray(td.metrics) && td.totals
    ? td.metrics.filter((m) => !['pending', 'missed', 'whatsapp'].includes(m.key) && num(td.totals[m.key]) > 0)
      .map((m) => ({ ...m, value: num(td.totals[m.key]) })).sort((a, b) => b.value - a.value).slice(0, 5)
    : [];

  // --- header controls ------------------------------------------------------------------
  const dates = rangeDates(pf.range, pf.from, pf.to);
  const setDates = (patch) => {
    const next = { from: dates.from || '', to: dates.to || '', ...patch };
    setPf({ ...pf, range: 'custom', from: next.from, to: next.to });
  };
  const allRef = useRef(null);
  const toAll = () => allRef.current && allRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const quick = QUICK.filter(() => allowed).map((q) => ({
    key: q.tab, icon: q.icon, label: q.label, sub: q.sub, onClick: () => onOpen(q.tab, { card: q.card }),
  }));
  const loadingTxt = <div className="ak-empty">Loading…</div>;
  const errTxt = (st) => (st.error ? <div className="ak-empty">{st.error}</div> : null);

  return (
    <div className="rv4">
      <div className="ak-page-head rv4-head">
        <div>
          <h1>Reports &amp; Analytics</h1>
          <p>
            Track hiring performance, open any report and export it
            {cat && cat.scope ? <> — your area: <b>{cat.scope}</b></> : null}
            {periodLabel ? <> · {periodLabel}</> : null}
          </p>
        </div>
        <div className="ak-page-tools">
          <span className="rv4-dates" title="Pick any dates (a custom period)">
            <Icon name="calendar" size={17} />
            <input type="date" aria-label="From date" value={dates.from || ''} max={dates.to || undefined} onChange={(e) => setDates({ from: e.target.value })} />
            <span aria-hidden="true">→</span>
            <input type="date" aria-label="To date" value={dates.to || ''} min={dates.from || undefined} onChange={(e) => setDates({ to: e.target.value })} />
          </span>
          <select className="rv4-select" aria-label="Period" value={pf.range || ''}
            onChange={(e) => setPf({ ...pf, range: e.target.value, ...(e.target.value === 'custom' ? {} : { from: '', to: '' }) })}>
            {DATE_RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {canExport && allowed && <ExportMenu busy={busy} onExport={doExport} />}
        </div>
      </div>

      {(pf.department || otherFilters) && (
        <div className="rv4-filtered">
          Showing only: {[pf.department && `Department ${pf.department}`, pf.clientId && 'one client', (pf.recruiterId || pf.bdeId) && 'one person'].filter(Boolean).join(' · ')}
          <button type="button" className="ak-btn-sm" onClick={() => setPf({ ...pf, department: '', clientId: '', recruiterId: '', bdeId: '' })}>Clear</button>
        </div>
      )}
      {error && <div className="notice red" style={{ marginBottom: 10 }}>{error}</div>}

      {allowed && (
        <>
          <KpiRow className="rv4-kpis">
            {KPIS.map((k) => {
              const t = tileOf(k.key);
              const v = t ? t.value : null;
              const delta = cmp && t ? pctChange(t.value, t.prev) : null;
              return (
                <KpiTile
                  key={k.key}
                  icon={k.icon}
                  tone={k.tone}
                  label={k.label}
                  value={dept.error ? null : v}
                  loading={dept.loading && !d}
                  delta={delta}
                  deltaLabel="vs last month"
                  upIsGood={!k.bad}
                  sub={t && t.sub ? plainWords(t.sub) : tileSub}
                  onClick={t && t.drill && num(v) > 0 ? () => drill('recruitment', qDept, 'tiles', '', t.key, plainWords(t.label)) : undefined}
                  title={t && t.drill && num(v) > 0 ? 'Show who is behind this number' : undefined}
                />
              );
            })}
          </KpiRow>

          <div className="rv4-row rv4-r2">
            <Panel
              title="Application trend"
              sub={tr ? `${anyTime ? 'Last 12 months' : (tr.period && tr.period.label) || ''} · by ${tr.bucket}${otherFilters ? ' · client / person filters not applied' : ''}` : undefined}
              extra={trendSeries.length > 0 && (
                <span className="rv4-legend">
                  {trendSeries.map((s) => <span key={s.name}><i className={`rv4-dot rv4-dot-${s.tone}`} />{s.name}</span>)}
                </span>
              )}
            >
              {trend.loading && !tr ? loadingTxt : errTxt(trend) || (tr && !trendEmpty
                ? <TrendLines labels={trendLabels} series={trendSeries} />
                : <div className="ak-empty">No applications in this period.</div>)}
            </Panel>

            <Panel title="Department-wise performance" action={{ label: 'View details', onClick: () => onOpen('departments', { card: 'depts' }) }} flush>
              {dept.loading && !d ? loadingTxt : errTxt(dept) || (deptRows.length ? (
                <table className="ak-table rv4-table">
                  <thead><tr><th>Department</th><th className="num">Applications</th><th className="num">Conversion %</th><th className="num">Joined</th></tr></thead>
                  <tbody>
                    {deptRows.slice(0, 5).map((r) => (
                      <tr key={r.key}>
                        <td className="rv4-trunc" title={String(r.c[0])}>{r.key === NOT_SET ? 'Not set' : plainWords(String(r.c[0]))}</td>
                        <td className="num"><NumBtn value={deptSec.get(r, 'applications')} onClick={() => drill('recruitment', qDept, 'recruitment', r.key, 'applications', `${r.c[0]} · Applications`)} /></td>
                        <td className="num">{pctTxt(deptSec.get(r, 'conv'))}</td>
                        <td className="num"><NumBtn value={deptSec.get(r, 'joined')} onClick={() => drill('recruitment', qDept, 'recruitment', r.key, 'joined', `${r.c[0]} · Joined`)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="ak-empty">No data available</div>)}
              {deptRows.length > 5 && <div className="rv4-more">Top 5 of {fmtNum(deptRows.length)} by applications</div>}
            </Panel>

            <Panel title="Quick reports" action={{ label: 'All reports', onClick: toAll }} className="rv4-quick">
              <QuickActions items={quick} />
            </Panel>
          </div>

          <div className="rv4-row rv4-r3">
            <Panel title="Top performing recruiters" action={{ label: 'View all', onClick: () => onOpen('recruiters', { card: 'team' }) }} flush>
              {recs.loading && !recs.data ? loadingTxt : errTxt(recs) || (topRecs.length ? (
                <table className="ak-table rv4-table">
                  <thead><tr><th>#</th><th>Recruiter</th><th className="num">Applications</th><th className="num">Interviews</th><th className="num">Joined</th><th className="num">Conv. %</th></tr></thead>
                  <tbody>
                    {topRecs.map((r, i) => (
                      <tr key={r.key}>
                        <td className="rv4-rank">{i + 1}</td>
                        <td><span className="ak-person rv4-trunc" title={String(r.c[0])}><Avatar name={String(r.c[0])} size={26} /><span>{r.c[0]}</span></span></td>
                        <td className="num"><NumBtn value={recSec.get(r, 'candidates')} onClick={() => drill('recruiters', qPlain, 'recruiters', r.key, 'candidates', `${r.c[0]} · Candidates`)} /></td>
                        <td className="num"><NumBtn value={recSec.get(r, 'interviews')} onClick={() => drill('recruiters', qPlain, 'recruiters', r.key, 'interviews', `${r.c[0]} · Interviews`)} /></td>
                        <td className="num"><NumBtn value={recSec.get(r, 'joined')} onClick={() => drill('recruiters', qPlain, 'recruiters', r.key, 'joined', `${r.c[0]} · Joined`)} /></td>
                        <td className="num">{pctTxt(recSec.get(r, 'conv'))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="ak-empty">No recruiter work in this period.</div>)}
            </Panel>

            <Panel title="Team performance" sub="By team lead (TL)" action={{ label: 'View all', onClick: () => onOpen('recruitment', { card: 'people' }, 'tl') }} flush>
              {tl.loading && !tl.data ? loadingTxt : errTxt(tl) || (tlRows.length ? (
                <table className="ak-table rv4-table">
                  <thead><tr><th>Team lead</th><th className="num">Recruiters</th><th className="num">Applications</th><th className="num">Interview</th><th className="num">Joined</th><th className="num">Conv. %</th></tr></thead>
                  <tbody>
                    {tlRows.map((r) => (
                      <tr key={r.key}>
                        <td className="rv4-trunc rv4-tl" title={String(r.c[0])}>{r.c[0]}</td>
                        <td className="num">{recs.data ? fmtNum(recsPerTl.get(String(r.c[0])) || 0) : '—'}</td>
                        <td className="num"><NumBtn value={tlSec.get(r, 'applications')} onClick={() => drill('recruitment', qTl, 'recruitment', r.key, 'applications', `${r.c[0]} · Applications`)} /></td>
                        <td className="num"><NumBtn value={tlSec.get(r, 'interview')} onClick={() => drill('recruitment', qTl, 'recruitment', r.key, 'interview', `${r.c[0]} · Interview`)} /></td>
                        <td className="num"><NumBtn value={tlSec.get(r, 'joined')} onClick={() => drill('recruitment', qTl, 'recruitment', r.key, 'joined', `${r.c[0]} · Joined`)} /></td>
                        <td className="num">{pctTxt(tlSec.get(r, 'conv'))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="ak-empty">No team lead work in this period.</div>)}
            </Panel>

            <Panel title="Recent activity" sub={td ? `Today${td.selfOnly ? ' · your own work' : ''}` : undefined} action={{ label: 'View all', onClick: () => onOpen('daily', { card: 'daily' }) }}>
              {today.loading && !td ? loadingTxt : errTxt(today) || (
                <>
                  {actRows.length ? (
                    <ul className="rv4-activity">
                      {actRows.map((a, i) => (
                        <li key={a.key}>
                          <span className={`rv4-act-ic ak-t-${ACT_TONE[i % ACT_TONE.length]}`}><Icon name={ACT_ICON[a.key] || 'list'} size={16} /></span>
                          <span className="rv4-act-txt">
                            <span className="rv4-act-label">{plainWords(a.label)}</span>
                            {a.hint && <span className="rv4-act-sub">{plainWords(a.hint)}</span>}
                          </span>
                          <span className="rv4-act-n">{fmtNum(a.value)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="ak-empty">No work recorded in TeamLink today yet.</div>}
                  {td && td.totals && td.totals.pending !== null && td.totals.pending !== undefined && (
                    <div className="rv4-act-foot"><Icon name="clock" size={14} /> {fmtNum(num(td.totals.pending))} next actions waiting now</div>
                  )}
                </>
              )}
            </Panel>
          </div>

          <div className="rv4-row rv4-r4">
            <Panel title="Hiring funnel" action={{ label: 'View details', onClick: () => onOpen('funnel', { card: 'funnel' }) }}>
              {fun.loading && !fun.data ? loadingTxt : errTxt(fun) || (funSec && funSec.rows.length && num(funSec.get(funSec.rows[0], 'count')) > 0 ? (
                <FunnelShape
                  steps={funSec.rows.map((r) => ({
                    key: r.key,
                    label: plainWords(String(r.c[0]).replace(/\s*\(.*\)\s*$/, '')),
                    title: plainWords(String(r.c[0])),
                    value: funSec.get(r, 'count'),
                    pct: funSec.get(r, 'ofAll'),
                    onClick: () => drill('funnel', qPlain, 'funnel', r.key, 'count', String(r.c[0])),
                  }))}
                />
              ) : <div className="ak-empty">No applications in this period.</div>)}
            </Panel>

            <Panel title="Location-wise performance" sub="Applications by job location" action={{ label: 'View all', onClick: () => onOpen('recruitment', { card: 'people' }, 'location') }}>
              {loc.loading && !loc.data ? loadingTxt : errTxt(loc) || (locTop.length ? (
                <ul className="rv4-locs">
                  {[...locTop.map((r) => ({ key: r.key, label: r.key === NOT_SET ? 'Location not set' : String(r.c[0]), value: num(locSec.get(r, 'applications')), row: r })),
                    ...(locRest > 0 ? [{ key: '__others', label: 'Others', value: locRest }] : [])].map((x) => (
                    <li key={x.key}>
                      <Icon name="pin" size={15} className="rv4-pin" />
                      <span className="rv4-loc-label" title={x.label}>{x.label}</span>
                      <span className="rv4-loc-track"><span style={{ width: `${Math.max(3, (x.value / Math.max(1, num(locSec.get(locTop[0], 'applications')))) * 100)}%` }} /></span>
                      <span className="rv4-loc-val">
                        {x.row ? <NumBtn value={x.value} onClick={() => drill('recruitment', qLoc, 'recruitment', x.key, 'applications', `${x.label} · Applications`)} /> : fmtNum(x.value)}
                        <span className="rv4-loc-pct">({locTotal ? Math.round((x.value / locTotal) * 100) : 0}%)</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <div className="ak-empty">No data available</div>)}
            </Panel>

            <Panel title="Key insights" icon="bolt" iconTone="amber" sub="From the department numbers above" action={{ label: 'View all', onClick: () => onOpen('departments', { card: 'depts' }) }}>
              {dept.loading && !d ? loadingTxt : errTxt(dept) || (
                <div className="rv4-insights">
                  {[
                    { key: 'conv', icon: 'trend', tone: 'green', label: 'Highest conversion rate', text: insight(hiConv, 'conv', (v) => `${v}%`), none: 'No joinings yet', row: hiConv },
                    { key: 'apps', icon: 'file', tone: 'blue', label: 'Most applications', text: insight(hiApps, 'applications', fmtNum), none: 'No applications yet', row: hiApps },
                    { key: 'join', icon: 'handshake', tone: 'violet', label: 'Highest joined', text: insight(hiJoin, 'joined', fmtNum), none: 'No joinings yet', row: hiJoin },
                    { key: 'rej', icon: 'alert', tone: 'red', label: 'Needs attention — most rejected', text: insight(hiRej, 'rejected', (v) => `${fmtNum(num(v))} rejected`), none: 'No rejections', row: hiRej },
                  ].map((x) => (
                    <button
                      key={x.key}
                      type="button"
                      className="rv4-insight"
                      disabled={!x.text}
                      onClick={() => x.row && onOpen('departments', { card: 'depts', department: x.row.key })}
                      title={x.text ? 'Open the department report for this department' : undefined}
                    >
                      <span className={`rv4-ins-ic ak-t-${x.tone}`}><Icon name={x.icon} size={16} /></span>
                      <span className="rv4-ins-txt">
                        <span className="rv4-ins-label">{x.label}</span>
                        <span className="rv4-ins-val">{x.text || x.none}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}

      <section className="rv4-all" ref={allRef}>
        <div className="rv4-all-head">
          <h2>All reports</h2>
          <span>Every report opens with its own filters, drill-downs and Excel / PDF / CSV export.</span>
        </div>
        {children}
      </section>
    </div>
  );
}
