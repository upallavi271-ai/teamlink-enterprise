// BarChart — one series of bars (ATS layout v3 kit), plus the older HRMS API.
//
//   <BarChart data={[{ label, value, onClick?, tone? }]} horizontal? height?
//     valueFormat?(n) -> string  empty?="No data for this period" title? />
//
// Vertical columns by default; `horizontal` for long category names. One
// series, so no legend box (the card title names it). Value on the cap / at
// the tip; each bar is the hover / focus / click target. `tone` paints one bar
// in a status colour (green / yellow / red / blue / grey).
//
// LEGACY (HRMS dashboards, RoleBoard): <BarChart rows={[{label,value}]} unit slot />
// inside a <ChartCard> keeps working unchanged — see LegacyBarChart below.
import { useTip } from './ChartCard.jsx';
import { fullValue, shortValue } from './format.js';
import {
  useChartBox, allWhole, Tip, SrTable, ChartEmpty, markProps, colPath, toneVar, ticksFor, defaultFormat, shortNum,
} from './kit.jsx';

export default function BarChart(props) {
  if (props.rows && !props.data) return <LegacyBarChart {...props} />;
  return props.horizontal ? <HBars {...props} /> : <VBars {...props} />;
}

function clean(data) {
  return (data || []).filter(Boolean).map((d) => ({ ...d, value: Number(d.value) || 0 }));
}

function VBars({ data, height = 220, valueFormat, empty, title }) {
  const rows = clean(data);
  const fmt = valueFormat || defaultFormat;
  const { ref, width, tip, show, hide } = useChartBox();
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max <= 0) return <ChartEmpty text={empty} height={height} />;
  const ticks = ticksFor(max, 4, allWhole(rows.map((r) => r.value)));
  const top = ticks[ticks.length - 1];
  const padL = 40;
  const padR = 8;
  const padT = 18;
  const padB = 30;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padT - padB;
  const band = rows.length ? plotW / rows.length : 0;
  const barW = Math.max(4, Math.min(24, band * 0.6));
  const showVals = rows.length <= 12 && band >= 26;
  const maxChars = Math.max(3, Math.floor(band / 6.5));
  const y = (v) => padT + plotH - (v / top) * plotH;
  return (
    <div className="tlc tlk tlk-wrap" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="false" role="group" aria-label={title || 'Bar chart'}>
          <g className="tlk-grid">
            {ticks.map((t) => <line key={t} x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />)}
          </g>
          {ticks.map((t) => <text key={t} className="tlk-tick" x={padL - 6} y={y(t) + 3.5} textAnchor="end">{shortNum(t)}</text>)}
          <line className="tlk-base" x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} />
          {rows.map((r, i) => {
            const cx = padL + band * i + band / 2;
            const h = (r.value / top) * plotH;
            const color = toneVar(r.tone) || 'var(--tlk-s1)';
            const content = { title: r.label, rows: [{ value: fmt(r.value), color }], hint: r.onClick ? 'Click to open the list' : null };
            const lab = String(r.label);
            return (
              <g key={`${lab}-${i}`} className="tlk-mark" {...markProps({ onClick: r.onClick, show, hide, content, label: `${lab}: ${fmt(r.value)}` })}>
                {/* The hit target is the whole band, not only the painted bar. */}
                <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent" />
                {r.value > 0 && <path d={colPath(cx - barW / 2, y(r.value), barW, h)} style={{ fill: color }} className="tlk-bar" />}
                {showVals && r.value > 0 && <text className="tlk-val" x={cx} y={y(r.value) - 5} textAnchor="middle">{fmt(r.value)}</text>}
                <text className="tlk-tick tlk-xlab" x={cx} y={height - padB + 15} textAnchor="middle">
                  {lab.length > maxChars ? `${lab.slice(0, maxChars - 1)}…` : lab}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {width === 0 && <div style={{ height }} />}
      <Tip tip={tip} />
      <SrTable caption={title} headers={['Item', 'Value']} rows={rows.map((r) => [r.label, fmt(r.value)])} />
    </div>
  );
}

function HBars({ data, valueFormat, empty, title }) {
  const rows = clean(data);
  const fmt = valueFormat || defaultFormat;
  const { ref, tip, show, hide } = useChartBox();
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max <= 0) return <ChartEmpty text={empty} />;
  return (
    <div className="tlc tlk tlk-wrap" ref={ref}>
      <div className="tlk-hbars" role="group" aria-label={title || 'Bar chart'}>
        {rows.map((r, i) => {
          const color = toneVar(r.tone) || 'var(--tlk-s1)';
          const content = { title: r.label, rows: [{ value: fmt(r.value), color }], hint: r.onClick ? 'Click to open the list' : null };
          return (
            <div key={`${r.label}-${i}`} className="tlk-hbar tlk-mark" {...markProps({ onClick: r.onClick, show, hide, content, label: `${r.label}: ${fmt(r.value)}` })}>
              <div className="lab" title={r.label}>{r.label}</div>
              <div className="trk">
                {r.value > 0 && <div className="bar" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: color }} />}
              </div>
              <div className="val">{fmt(r.value)}</div>
            </div>
          );
        })}
      </div>
      <Tip tip={tip} />
      <SrTable caption={title} headers={['Item', 'Value']} rows={rows.map((r) => [r.label, fmt(r.value)])} />
    </div>
  );
}

// ---- the older API (HRMS dashboards) — unchanged behaviour ------------------
function LegacyBarChart({ rows, unit, slot = '1' }) {
  const tip = useTip();
  const data = (rows || []).filter(Boolean);
  const top = Math.max(...data.map((r) => Number(r.value) || 0), 1);
  return (
    <div className="tlc-bars">
      {data.map((r) => {
        const v = Number(r.value) || 0;
        const content = { title: r.label, rows: [{ name: '', value: fullValue(v, unit), slot }] };
        return (
          <div
            key={r.label}
            className="tlc-bar"
            tabIndex={0}
            aria-label={`${r.label}: ${fullValue(v, unit)}`}
            onPointerMove={(e) => tip && tip.show(e, content)}
            onPointerLeave={() => tip && tip.hide()}
            onFocus={(e) => tip && tip.show(e, content)}
            onBlur={() => tip && tip.hide()}
          >
            <div className="lab" title={r.label}>{r.label}</div>
            <div className="trk">
              {v > 0 && <div className={`bar f${slot}`} style={{ width: `${Math.max(1.5, (v / top) * 100)}%` }} />}
            </div>
            <div className="val">{shortValue(v, unit)}</div>
          </div>
        );
      })}
    </div>
  );
}
