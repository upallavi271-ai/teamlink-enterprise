// CRM > DASHBOARD > CHARTS (2026-11-17), plain SVG (no chart library): lead sources, the deal pipeline by stage value, Booked / Invoiced /
// Collected by month (12), the team (won value, and activities, as two charts - two measures never share one axis), lost reasons, and the
// weighted forecast by expected close month. Each chart has a hover tooltip and a "Table" view. GET /crm/charts (crm/analytics.js)
// follows the dashboard's Only mine, period and salesperson filters.
import { useEffect, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, money, moneyShort } from './crmShared.jsx';

// categorical slots in a fixed order (the validated reference palette); a 9th+ slice folds into "Other"
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const MONEY3 = { booked: SERIES[0], invoiced: SERIES[1], collected: SERIES[2] };

function Card({ title, sub, children, table }) {
  return (
    <div className="crm-card crm-chart">
      <div className="crm-card-head"><h3>{title}</h3></div>
      {sub && <div className="small-muted" style={{ fontSize: 11.5, marginTop: -6, marginBottom: 6 }}>{sub}</div>}
      {children}
      {table && (
        <details className="crm-chart-table">
          <summary>Table</summary>
          <div className="tbl-wrap"><table><thead><tr>{table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
        </details>
      )}
    </div>
  );
}

// a tooltip that follows the pointer inside the chart box
function useTip() {
  const [tip, setTip] = useState(null);
  const on = (text) => ({
    onMouseMove: (e) => { const box = e.currentTarget.closest('[data-tipbox]') || e.currentTarget; const b = box.getBoundingClientRect(); setTip({ text, x: e.clientX - b.left, y: e.clientY - b.top }); },
    onMouseLeave: () => setTip(null),
    onFocus: () => setTip({ text, x: 20, y: 20 }),
    onBlur: () => setTip(null),
    tabIndex: 0,
  });
  const view = tip ? <div className="crm-tip" style={{ left: Math.max(4, tip.x + 12), top: Math.max(4, tip.y - 8) }}>{tip.text.split('\n').map((l) => <div key={l}>{l}</div>)}</div> : null;
  return { on, view };
}

function Legend({ items }) {
  return <div className="crm-legend">{items.map((x) => <span key={x.name}><i style={{ background: x.color }} />{x.name}{x.value != null ? <b> {x.value}</b> : null}</span>)}</div>;
}

// a donut: identity by slot colour AND by the legend beside it
function Donut({ rows, valueOf = (r) => r.count, fmt = (v) => v.toLocaleString('en-IN'), empty }) {
  const { on, view } = useTip();
  const top = rows.slice(0, 7);
  const rest = rows.slice(7);
  const data = [...top, ...(rest.length ? [{ name: 'Other', count: rest.reduce((a, r) => a + r.count, 0), value: rest.reduce((a, r) => a + (r.value || 0), 0) }] : [])]
    .map((r, i) => ({ ...r, color: SERIES[i], v: valueOf(r) })).filter((r) => r.v > 0);
  const total = data.reduce((a, r) => a + r.v, 0);
  if (!total) return <div className="small-muted">{empty || 'Nothing in this period.'}</div>;
  const R = 52; const r0 = 32; const C = 60;
  let a0 = -Math.PI / 2;
  const arc = (s, e) => {
    const big = e - s > Math.PI ? 1 : 0;
    const p = (ang, rad) => `${C + rad * Math.cos(ang)} ${C + rad * Math.sin(ang)}`;
    return `M ${p(s, R)} A ${R} ${R} 0 ${big} 1 ${p(e, R)} L ${p(e, r0)} A ${r0} ${r0} 0 ${big} 0 ${p(s, r0)} Z`;
  };
  return (
    <div className="crm-donut">
      <div data-tipbox style={{ position: 'relative', flex: '0 0 130px' }}>
        <svg viewBox="0 0 120 120" width="130" height="130" role="img" aria-label={data.map((d) => `${d.name} ${fmt(d.v)}`).join(', ')}>
          {data.length === 1 ? <circle cx={C} cy={C} r={(R + r0) / 2} fill="none" stroke={data[0].color} strokeWidth={R - r0} {...on(`${data[0].name}: ${fmt(data[0].v)} (100%)`)} /> : data.map((d) => {
            const e = a0 + (d.v / total) * Math.PI * 2;
            const path = <path key={d.name} d={arc(a0, e)} fill={d.color} stroke="var(--paper-raised, #fff)" strokeWidth="2" {...on(`${d.name}: ${fmt(d.v)} (${Math.round((d.v / total) * 100)}%)`)} />;
            a0 = e;
            return path;
          })}
          <text x={C} y={C + 4} textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--ink, #0b0b0b)">{fmt(total)}</text>
        </svg>
        {view}
      </div>
      <Legend items={data.map((d) => ({ name: d.name, color: d.color, value: `${fmt(d.v)} · ${Math.round((d.v / total) * 100)}%` }))} />
    </div>
  );
}

// horizontal bars, one hue (a single measure), the label above each bar so long names never squeeze it
function HBars({ rows, label, value, fmt, color = SERIES[0], funnel }) {
  const { on, view } = useTip();
  const max = Math.max(1, ...rows.map(value));
  if (!rows.some((r) => value(r) > 0)) return <div className="small-muted">Nothing yet.</div>;
  return (
    <div data-tipbox style={{ position: 'relative' }}>
      <div className="crm-hbars">
        {rows.map((r) => {
          const w = Math.max(value(r) > 0 ? 1.5 : 0, (value(r) / max) * 100);
          return (
            <div key={label(r)} className="row" {...on(`${label(r)}: ${fmt(r)}`)}>
              <div className="l"><span>{label(r)}</span><b>{fmt(r)}</b></div>
              <div className="track" style={funnel ? { display: 'flex', justifyContent: 'center' } : undefined}><span style={{ width: `${w}%`, background: color }} /></div>
            </div>
          );
        })}
      </div>
      {view}
    </div>
  );
}

// vertical bars by month (the forecast): one measure, one hue; the close-date-passed bucket in the status red with its label
function VBars({ rows, value, fmt, labelOf }) {
  const { on, view } = useTip();
  const W = 560; const H = 170; const P = { l: 6, r: 6, t: 12, b: 34 };
  const max = Math.max(1, ...rows.map(value));
  const bw = (W - P.l - P.r) / rows.length;
  if (!rows.some((r) => value(r) > 0)) return <div className="small-muted">No open deals to forecast.</div>;
  return (
    <div data-tipbox style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Weighted forecast by close month" style={{ display: 'block' }}>
        <line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} stroke="var(--line, #ddd)" />
        {rows.map((r, i) => {
          const h = (value(r) / max) * (H - P.t - P.b);
          const x = P.l + i * bw + bw * 0.18; const w = bw * 0.64;
          return (
            <g key={r.key} {...on(fmt(r))}>
              <rect x={P.l + i * bw} y={P.t} width={bw} height={H - P.t - P.b} fill="transparent" />
              {h > 0 && <path d={`M ${x} ${H - P.b} V ${H - P.b - h + Math.min(4, h)} Q ${x} ${H - P.b - h} ${x + Math.min(4, w / 2)} ${H - P.b - h} H ${x + w - Math.min(4, w / 2)} Q ${x + w} ${H - P.b - h} ${x + w} ${H - P.b - h + Math.min(4, h)} V ${H - P.b} Z`} fill={r.key === 'late' ? '#d03b3b' : SERIES[0]} />}
              <text x={P.l + i * bw + bw / 2} y={H - P.b + 13} fontSize="9.5" textAnchor="middle" fill="var(--ink-soft, #52514e)">{labelOf(r).split(' ')[0]}</text>
              <text x={P.l + i * bw + bw / 2} y={H - P.b + 24} fontSize="9" textAnchor="middle" fill="var(--ink-soft, #52514e)">{labelOf(r).split(' ').slice(1).join(' ')}</text>
            </g>
          );
        })}
      </svg>
      {view}
    </div>
  );
}

// three money lines on ONE axis (all rupees), 12 months, a crosshair column per month
function MoneyLines({ rows }) {
  const { on, view } = useTip();
  const W = 560; const H = 190; const P = { l: 44, r: 8, t: 10, b: 24 };
  const keys = ['booked', 'invoiced', 'collected'];
  const max = Math.max(1, ...rows.flatMap((r) => keys.map((k) => r[k])));
  const x = (i) => P.l + (i * (W - P.l - P.r)) / Math.max(1, rows.length - 1);
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const [hover, setHover] = useState(null);
  return (
    <div data-tipbox style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Booked, invoiced and collected by month" style={{ display: 'block' }} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => <g key={t}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--line-soft, #eee)" /><text x={P.l - 4} y={y(t) + 3} fontSize="9.5" textAnchor="end" fill="var(--ink-soft, #52514e)">{moneyShort(t)}</text></g>)}
        {rows.map((r, i) => <text key={r.month} x={x(i)} y={H - 8} fontSize="9.5" textAnchor="middle" fill="var(--ink-soft, #52514e)">{i % 2 === rows.length % 2 ? '' : r.label.split(' ')[0]}</text>)}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="var(--ink-soft, #999)" strokeDasharray="3 3" />}
        {keys.map((k) => <polyline key={k} fill="none" stroke={MONEY3[k]} strokeWidth="2" strokeLinejoin="round" points={rows.map((r, i) => `${x(i)},${y(r[k])}`).join(' ')} />)}
        {hover != null && keys.map((k) => <circle key={k} cx={x(hover)} cy={y(rows[hover][k])} r="4" fill={MONEY3[k]} stroke="var(--paper-raised, #fff)" strokeWidth="2" />)}
        {rows.map((r, i) => (
          <rect key={r.month} x={x(i) - (W - P.l - P.r) / (2 * Math.max(1, rows.length - 1))} y={P.t} width={(W - P.l - P.r) / Math.max(1, rows.length - 1)} height={H - P.t - P.b} fill="transparent"
            onMouseEnter={() => setHover(i)} {...on(`${r.label}\nBooked ${money(r.booked)}\nInvoiced ${money(r.invoiced)}\nCollected ${money(r.collected)}`)} />
        ))}
      </svg>
      {view}
      <Legend items={keys.map((k) => ({ name: k === 'booked' ? 'Booked (won)' : k === 'invoiced' ? 'Invoiced' : 'Collected', color: MONEY3[k] }))} />
    </div>
  );
}

export default function DashboardCharts({ mine, period, owner }) {
  const { version } = useCrm();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api.get('/crm/charts', { params: { period, mine: mine ? 1 : undefined, owner: owner || undefined } })
      .then((r) => { if (alive) { setD(r.data); setErr(''); } }).catch((e) => { if (alive) setErr(errOf(e, 'The charts could not be read.')); });
    return () => { alive = false; };
  }, [mine, period, owner, version]);
  if (err) return <div className="notice" role="alert">{err}</div>;
  if (!d) return <div className="small-muted">Loading the charts…</div>;
  const p = d.periodLabel.toLowerCase();
  const fc = d.forecast.filter((b) => b.count > 0 || /^\d{4}-\d{2}$/.test(b.key));
  return (
    <div className="crm-charts">
      <Card title="Lead sources" sub={`Leads added ${p}`} table={{ head: ['Source', 'Leads'], rows: d.sources.map((s) => [s.name, s.count]) }}>
        <Donut rows={d.sources} empty={`No leads added ${p}.`} />
      </Card>
      <Card title="Deal pipeline" sub="Open deals now, by stage value" table={{ head: ['Stage', 'Deals', 'Value'], rows: d.pipeline.map((s) => [s.stage, s.count, money(s.value)]) }}>
        <HBars funnel rows={d.pipeline} label={(r) => r.stage} value={(r) => r.value} fmt={(r) => `${moneyShort(r.value)} · ${r.count} deal${r.count === 1 ? '' : 's'}`} />
      </Card>
      <Card title="Booked, invoiced, collected" sub="The last 12 months" table={{ head: ['Month', 'Booked', 'Invoiced', 'Collected'], rows: d.revenue.map((r) => [r.label, money(r.booked), money(r.invoiced), money(r.collected)]) }}>
        <MoneyLines rows={d.revenue} />
      </Card>
      <Card title="Weighted forecast" sub={`Open value x stage probability, by expected close month · total ${moneyShort(d.forecastTotal)}`} table={{ head: ['Close month', 'Deals', 'Open value', 'Weighted'], rows: d.forecast.map((b) => [b.label, b.count, money(b.value), money(b.weighted)]) }}>
        <VBars rows={fc} value={(r) => r.weighted} labelOf={(r) => (r.key === 'late' ? 'Date passed' : r.key === 'none' ? 'No date' : r.label)} fmt={(r) => `${r.label}: ${money(r.weighted)} likely\n${r.count} deal${r.count === 1 ? '' : 's'}, ${money(r.value)} open`} />
      </Card>
      <Card title="Team: won value" sub={`Deals won ${p}`} table={{ head: ['Salesperson', 'Won', 'Won value', 'Activities'], rows: d.team.map((t) => [t.name, t.won, money(t.wonValue), t.activities]) }}>
        <HBars rows={d.team} label={(r) => r.name} value={(r) => r.wonValue} fmt={(r) => `${moneyShort(r.wonValue)} · ${r.won} won`} color={SERIES[0]} />
      </Card>
      <Card title="Team: activities" sub={`Calls, meetings, emails, WhatsApp and notes logged ${p}`}>
        <HBars rows={d.team} label={(r) => r.name} value={(r) => r.activities} fmt={(r) => `${r.activities}`} color={SERIES[2]} />
      </Card>
      <Card title="Lost reasons" sub={`Deals lost ${p}`} table={{ head: ['Reason', 'Deals', 'Value'], rows: d.lostReasons.map((x) => [x.name, x.count, money(x.value)]) }}>
        <Donut rows={d.lostReasons} empty={`No deal was lost ${p}.`} />
      </Card>
    </div>
  );
}
