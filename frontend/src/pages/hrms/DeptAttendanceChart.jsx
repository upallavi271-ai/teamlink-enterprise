// The HRMS dashboard's one chart (founder 2026-10-27: "chart ala bagaledhu, inka clear ga evvu"):
// one thick bar per department, biggest first, split into Present / Half day /
// Absent / On leave. Each colour means the same thing everywhere (green came,
// amber half day, red absent, blue on leave), the number sits inside a part
// when it fits, the department total is at the end, and hovering any part
// shows its number. Table view carries every figure.
//
// Colours (dept-attendance-chart.css) were run through the dataviz validator in
// this stack order: light #15803d #e0a100 #d03b3b #2a78d6 on #ffffff, dark
// #1f7f45 #c98500 #d03b3b #3d8fd6 on #1a1a19 — every check passes (light amber
// is under 3:1, so the numbers are printed on the bars and the table exists).
import { useEffect, useRef, useState } from 'react';
import ChartCard, { DataTable, useTip } from '../../components/charts/ChartCard.jsx';
import { fullValue } from '../../components/charts/format.js';
import './dept-attendance-chart.css';

// Server series name -> plain name + colour key. Colour follows the series, never its place.
const KNOWN = {
  present: { name: 'Present', key: 'p' },
  'half day': { name: 'Half day', key: 'h' },
  absent: { name: 'Absent', key: 'a' },
  'on leave': { name: 'On leave', key: 'l' },
};
const seriesOf = (names) => (names || []).map((n) => KNOWN[String(n).toLowerCase()] || { name: n, key: 'o' });

const sum = (vals) => vals.reduce((s, v) => s + (Number(v) || 0), 0);
const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);

// Does "123" fit inside a segment this many px wide? 12px bold digits ≈ 7.2px each, plus padding.
const fits = (px, text) => px >= String(text).length * 7.2 + 12;

function Bars({ series, rows, top }) {
  const tip = useTip();
  const plot = useRef(null);
  const [trackPx, setTrackPx] = useState(0);
  // The width the biggest bar gets, so a label is only printed where it really fits.
  useEffect(() => {
    const el = plot.current;
    if (!el) return undefined;
    const measure = () => {
      const t = el.querySelector('.da-track');
      setTrackPx(t ? t.getBoundingClientRect().width : 0);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    return () => ro && ro.disconnect();
  }, [rows.length]);

  return (
    <div className="da-rows" ref={plot}>
      {rows.map((r) => {
        const all = {
          title: `${r.label} · ${fullValue(r.total)} days`,
          rows: series.map((s, i) => ({ name: `${s.name} (${pct(r.values[i], r.total)}%)`, value: fullValue(r.values[i]), slot: `att-${s.key}` })),
        };
        const showAll = (e) => tip && tip.show(e, all);
        const hide = () => tip && tip.hide();
        return (
          <div key={r.label} className="da-row" aria-label={`${r.label}: ${series.map((s, i) => `${s.name} ${fullValue(r.values[i])}`).join(', ')}, total ${fullValue(r.total)} days`}>
            <div className="da-name" title={r.label} onPointerMove={showAll} onPointerLeave={hide}>{r.label}</div>
            <div className="da-track">
              <div className="da-bar" style={{ width: `${Math.max(2, (r.total / top) * 100)}%` }}>
                {series.map((s, i) => {
                  const v = Number(r.values[i]) || 0;
                  if (!v) return null;
                  const px = (v / top) * trackPx;
                  const one = { title: r.label, rows: [{ name: `${s.name} (${pct(v, r.total)}%)`, value: fullValue(v), slot: `att-${s.key}` }] };
                  return (
                    <div
                      key={s.name}
                      className={`da-seg fatt-${s.key}`}
                      style={{ flex: `${v} 1 0` }}
                      tabIndex={0}
                      aria-label={`${r.label}, ${s.name}: ${fullValue(v)} days`}
                      onPointerMove={(e) => tip && tip.show(e, one)}
                      onPointerLeave={hide}
                      onFocus={(e) => tip && tip.show(e, all)}
                      onBlur={hide}
                    >
                      {fits(px, fullValue(v)) && <span>{fullValue(v)}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="da-total" onPointerMove={showAll} onPointerLeave={hide}>
              <b>{fullValue(r.total)}</b>
              <small>{`${pct(r.present, r.total)}% present`}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function DeptAttendanceChart({ spec, period }) {
  const series = seriesOf(spec.series);
  const presentAt = series.findIndex((s) => s.key === 'p');
  const rows = (spec.rows || [])
    .filter(Boolean)
    .map((r) => ({ label: r.label, values: r.values, total: sum(r.values), present: presentAt >= 0 ? Number(r.values[presentAt]) || 0 : 0 }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
  const top = Math.max(...rows.map((r) => r.total), 1);

  const table = (
    <DataTable
      headers={['Department', ...series.map((s) => s.name), 'Total', '% present']}
      numeric={series.map((_, i) => i + 1).concat([series.length + 1, series.length + 2])}
      rows={rows.map((r) => [r.label, ...series.map((_, i) => fullValue(r.values[i])), fullValue(r.total), `${pct(r.present, r.total)}%`])}
    />
  );

  return (
    <ChartCard
      title="Attendance and leave by department"
      sub={`${period}: staff days per department, biggest first (late counts as present). Point at a colour to see its number.`}
      table={table}
      isEmpty={!rows.length}
      empty="No attendance recorded for this period"
    >
      <div className="da-legend" aria-hidden="true">
        {series.map((s) => <span key={s.name}><i className={`fatt-${s.key}`} />{s.name}</span>)}
        <span className="da-legend-total">Total days</span>
      </div>
      <Bars series={series} rows={rows} top={top} />
    </ChartCard>
  );
}
