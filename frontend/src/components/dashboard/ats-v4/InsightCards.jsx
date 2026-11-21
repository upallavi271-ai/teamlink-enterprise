import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../../api';
import { Panel } from '../../atskit/AtsKit.jsx';
import { ResultChart, errText, inr } from '../../../pages/reports/InsightBits.jsx';
import { AskChart } from '../../../pages/reports/InsightReports.jsx';
import '../../../pages/reports/InsightReports.css';

// ---------------------------------------------------------------------------
// THE ATS DASHBOARD INSIGHT CARDS (market wave 2026-11-21; backend GET /api/ats-insights/dashboard):
//   Time to fill (01.03) · Closest to fill (01.10) · Pipeline forecast (01.09)
//   Leaderboard (01.07, refreshed every minute) · Plan my day (01.11, AI-ranked) · Ask for a chart (01.12)
//   My charts (01.15): the saved reports this person (or their team lead, for the team) put on the dashboard
// Each is a card of AtsV4's own layout, so Customise moves / hides them and the layout is saved per person.
// A login the insights refuse (or "Dashboard of" someone, read-only) gets no cards at all.
// ---------------------------------------------------------------------------
const REPORTS = '/reports/ats?tab=';
const Tile = ({ v, l }) => <div className="ins-tile"><b>{v === null || v === undefined ? '—' : v}</b><span>{l}</span></div>;

function Leaderboard({ initial }) {
  const [lb, setLb] = useState(initial);
  useEffect(() => { setLb(initial); }, [initial]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') api.get('/ats-insights/leaderboard').then((x) => setLb(x.data)).catch(() => {}); }, 60000);
    return () => clearInterval(t);
  }, []);
  if (!lb || lb.hidden) return <div className="small-muted">{(lb && lb.message) || 'No ranking yet.'}</div>;
  return (
    <>
      {lb.you && <div className="small-muted">You are <b>#{lb.you.rank}</b> of {lb.you.of} this {String(lb.period || 'month').toLowerCase().replace('ly', '')}.</div>}
      {!!(lb.badges || []).length && <div className="ins-badges">{lb.badges.map((b) => <span key={b.badge} className="ins-badge" title={b.badge}>{b.icon} {b.badge}: <b>{b.name}</b></span>)}</div>}
      <table className="ins-lb"><tbody>
        {(lb.rows || []).slice(0, 5).map((r) => (
          <tr key={`${r.rank}-${r.name}`} className={r.you ? 'is-you' : ''}><td>#{r.rank}</td><td>{r.name}{r.you ? ' (you)' : ''}</td><td className="num">{r.score ?? '—'}</td><td className="num" title="Joinings">{r.joinings} joined</td></tr>
        ))}
      </tbody></table>
      <div className="small-muted">{lb.scope} · updates every minute</div>
    </>
  );
}

function PlanMyDay() {
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { const x = await api.post('/ats-insights/plan', {}); setP(x.data); } catch (e) { setErr(errText(e, 'Could not make the plan.')); } finally { setBusy(false); }
  }
  return (
    <>
      {!p && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={go}>{busy ? 'Planning…' : 'Plan my day'}</button>}
      {err && <div className="notice red"><span>{err}</span></div>}
      {p && (
        <>
          {!p.tasks.length ? <div className="small-muted">Nothing is due. A good time to source for your open requirements.</div> : (
            <ol className="ins-dash-list">
              {p.tasks.slice(0, 6).map((t) => (
                <li key={t.id}><span><b>{t.label}</b>{t.who ? ` · ${t.who}` : ''} · <Link to={t.open}>{t.job}</Link></span><span className="ins-why">{t.detail} - {t.why}</span></li>
              ))}
            </ol>
          )}
          <div className="small-muted">{p.via}{p.total > 6 ? ` · ${p.total - 6} more` : ''} · <button type="button" className="link-btn" onClick={go}>Again</button></div>
        </>
      )}
    </>
  );
}

function PinnedChart({ pin }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get(`/ats-insights/reports/${pin.reportId}/run`).then((x) => setR(x.data.result)).catch((e) => setErr(errText(e, 'Could not load this chart.'))); }, [pin.reportId]);
  if (err) return <div className="small-muted">{err}</div>;
  if (!r) return <div className="small-muted">Loading…</div>;
  if (!r.groups) return <div><b>{r.total}</b> <span className="small-muted">row(s) · <Link to={`${REPORTS}builder`}>open in the builder</Link></span></div>;
  return <ResultChart result={r} height={180} max={10} />;
}

// -> { sections: [...] } for AtsV4 (each section: { id, label, row, cards: [{ id, label, node, flex }] })
export function useInsightCards({ enabled, card }) {
  const [d, setD] = useState(null);
  const load = useCallback(() => {
    if (!enabled) { setD(null); return; }
    api.get('/ats-insights/dashboard').then((x) => setD(x.data)).catch(() => setD(null));
  }, [enabled]);
  useEffect(load, [load]);
  if (!enabled || !d) return [];
  const t = d.ttf.tiles;
  const fc = d.forecast;
  return [
    {
      id: 'insights',
      label: 'Insights row',
      row: 'av4-row av4-row3',
      cards: [
        card('ins:closest', 'Closest to fill', (
          <Panel title="Closest to fill" icon="briefcase" iconTone="green" action={{ label: 'All', to: `${REPORTS}readiness` }}>
            {!d.readiness.rows.length ? <div className="small-muted">No open requirement is waiting for people.</div> : (
              <ul className="ins-dash-list">
                {d.readiness.rows.map((r) => (
                  <li key={r.requirementId}><span><Link to={`/requirements/${r.requirementId}`}>{r.requirement}</Link> · <b>{r.readiness}%</b> ready · {r.left} left</span><span className="ins-why">{r.next}</span></li>
                ))}
              </ul>
            )}
          </Panel>
        )),
        card('ins:ttf', 'Time to fill', (
          <Panel title="Time to fill" sub="last 90 days" icon="clock" iconTone="blue" action={{ label: 'By job & client', to: `${REPORTS}ttfjob` }}>
            <div className="ins-tiles"><Tile v={t.medianFill} l="usual days to fill" /><Tile v={t.medianHire} l="usual days to hire" /><Tile v={t.joined} l="joined" /></div>
            {d.ttf.byClient.slice(0, 4).map((c) => <div key={c.client} className="small-muted">{c.client}: usually {c.medianFill ?? '—'} days ({c.joined} joined)</div>)}
          </Panel>
        )),
        card('ins:forecast', 'Pipeline forecast', (
          <Panel title="Pipeline forecast" icon="chart" iconTone="purple" action={{ label: 'Details', to: `${REPORTS}forecast` }}>
            <div className="ins-tiles"><Tile v={fc.expectedJoinings} l="expected joinings" /><Tile v={fc.inPipeline} l="people in process" />{fc.revenue && <Tile v={inr(fc.revenue.expected)} l="expected fee" />}</div>
            {fc.byStep.filter((s) => s.people).slice(0, 4).map((s) => <div key={s.step} className="small-muted">{s.label}: {s.people} people · {s.chance}% usually join</div>)}
          </Panel>
        )),
      ],
    },
    {
      id: 'insights2',
      label: 'Plan and leaderboard row',
      row: 'av4-row av4-row3',
      cards: [
        card('ins:plan', 'Plan my day', (
          <Panel title="Plan my day" icon="bolt" iconTone="orange" action={d.alerts.rules ? { label: `${d.alerts.firing ? `🔔 ${d.alerts.firing} crossed` : 'Alerts'}`, to: `${REPORTS}schedules` } : { label: 'Set an alert', to: `${REPORTS}schedules` }}>
            <PlanMyDay />
          </Panel>
        )),
        card('ins:leaders', 'Leaderboard', (
          <Panel title="Leaderboard" icon="users" iconTone="green"><Leaderboard initial={d.leaderboard} /></Panel>
        )),
        card('ins:ask', 'Ask for a chart', (
          <Panel title="Ask for a chart" icon="chart" iconTone="blue" action={{ label: 'Build a report', to: `${REPORTS}builder` }}><AskChart compact /></Panel>
        )),
      ],
    },
    {
      id: 'mycharts',
      label: 'My charts',
      row: 'av4-row av4-row3',
      cards: d.pins.map((p) => card(`pin:${p.reportId}`, p.report.name, (
        <Panel title={p.report.name} sub={p.forTeam && !p.mine ? 'from your team lead' : null} icon="chart" iconTone="blue" action={{ label: 'Open', to: `${REPORTS}builder` }}>
          <PinnedChart pin={p} />
        </Panel>
      ))),
    },
  ];
}
