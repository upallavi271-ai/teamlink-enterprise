// LineChart — one series over time.
//
//   <LineChart points={[{ label, value, onClick? }]} height? valueFormat? empty? title? />
//
// 2px line, a 10% wash under it, 8px dots ringed in the surface colour. A
// vertical crosshair snaps to the nearest point; clicking anywhere on the plot
// opens that point (its onClick). The last value is labelled at the line end.
import { useState } from 'react';
import {
  useChartBox, allWhole, Tip, SrTable, ChartEmpty, ticksFor, defaultFormat, shortNum,
} from './kit.jsx';

export default function LineChart({
  points = [], height = 220, valueFormat, empty, title,
}) {
  const fmt = valueFormat || defaultFormat;
  const { ref, width, tip, show, hide } = useChartBox();
  const [hover, setHover] = useState(-1);
  const pts = (points || []).filter(Boolean).map((p) => ({ ...p, value: Number(p.value) || 0 }));
  const max = Math.max(0, ...pts.map((p) => p.value));
  if (!pts.length || (max <= 0 && pts.every((p) => !p.value))) return <ChartEmpty text={empty} height={height} />;
  const ticks = ticksFor(max, 4, allWhole(pts.map((p) => p.value)));
  const top = ticks[ticks.length - 1];
  const padL = 40;
  // Room for the end label (the last value, formatted).
  const padR = pts.length ? Math.max(14, String(fmt(pts[pts.length - 1].value)).length * 6.6 + 12) : 14;
  const padT = 14;
  const padB = 30;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padT - padB;
  const x = (i) => padL + (pts.length === 1 ? plotW / 2 : (plotW * i) / (pts.length - 1));
  const y = (v) => padT + plotH - (v / top) * plotH;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('');
  const area = `${line}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const every = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(plotW / 60))));
  const nearest = (e) => {
    const svg = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - svg.left;
    let best = 0;
    pts.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    return best;
  };
  const tipOf = (i) => ({ title: pts[i].label, rows: [{ value: fmt(pts[i].value), color: 'var(--tlk-s1)' }], hint: pts[i].onClick ? 'Click to open the list' : null });
  const last = pts.length - 1;
  return (
    <div className="tlc tlk tlk-wrap" ref={ref}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={title || 'Line chart'}
          tabIndex={0}
          onPointerMove={(e) => { const i = nearest(e); setHover(i); show(e, tipOf(i)); }}
          onPointerLeave={() => { setHover(-1); hide(); }}
          onClick={(e) => { const i = nearest(e); if (pts[i].onClick) pts[i].onClick(); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const i = Math.max(0, Math.min(last, (hover < 0 ? 0 : hover) + (e.key === 'ArrowRight' ? 1 : -1)));
              setHover(i);
              const b = ref.current.getBoundingClientRect();
              show({ clientX: b.left + x(i), clientY: b.top + y(pts[i].value) }, tipOf(i));
            }
            if ((e.key === 'Enter' || e.key === ' ') && hover >= 0 && pts[hover].onClick) { e.preventDefault(); pts[hover].onClick(); }
          }}
          onBlur={() => { setHover(-1); hide(); }}
          style={pts.some((p) => p.onClick) ? { cursor: 'pointer' } : undefined}
        >
          <g className="tlk-grid">{ticks.map((t) => <line key={t} x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />)}</g>
          {ticks.map((t) => <text key={t} className="tlk-tick" x={padL - 6} y={y(t) + 3.5} textAnchor="end">{shortNum(t)}</text>)}
          <line className="tlk-base" x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} />
          {pts.map((p, i) => (i % every === 0 || i === last) && (
            // eslint-disable-next-line react/no-array-index-key
            <text key={i} className="tlk-tick" x={x(i)} y={height - padB + 15} textAnchor="middle">{p.label}</text>
          ))}
          <path d={area} className="tlk-area" />
          <path d={line} className="tlk-line" />
          {hover >= 0 && <line className="tlk-cross" x1={x(hover)} x2={x(hover)} y1={padT} y2={y(0)} />}
          {pts.map((p, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <circle key={i} cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 4} className="tlk-dot" />
          ))}
          <text className="tlk-val" x={x(last) + 7} y={y(pts[last].value) + 4}>{fmt(pts[last].value)}</text>
        </svg>
      ) : <div style={{ height }} />}
      <Tip tip={tip} />
      <SrTable caption={title} headers={['Period', 'Value']} rows={pts.map((p) => [p.label, fmt(p.value)])} />
    </div>
  );
}
