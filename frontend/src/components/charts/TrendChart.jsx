// A line chart over time, 1–4 series on ONE axis. 2px lines, an 8px end dot
// ringed in the surface colour, the last value direct-labelled, hairline
// gridlines on clean ticks. A vertical crosshair snaps to the nearest period
// and one tooltip lists every series there; arrow keys walk the periods when
// the plot has keyboard focus.
import { useEffect, useRef, useState } from 'react';
import { useTip, Legend } from './ChartCard.jsx';
import { fullValue, shortValue, slotOf, niceTicks } from './format.js';

const H = 190;
const PAD = { top: 12, right: 44, bottom: 24, left: 40 };

export default function TrendChart({ series, rows, unit }) {
  const tip = useTip();
  const wrap = useRef(null);
  const [w, setW] = useState(520);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const names = series || [];
  const slots = names.map((n, i) => ({ name: n, slot: slotOf(i, n) }));
  const data = rows || [];
  const n = data.length;
  const max = Math.max(...data.flatMap((r) => r.values.map((v) => Number(v) || 0)), 1);
  const ticks = niceTicks(max);
  const yTop = ticks[ticks.length - 1];
  const iw = w - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => PAD.top + ih - ((Number(v) || 0) / yTop) * ih;

  // At most ~7 x labels, evenly spaced, always the first and last.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 80))));
  const xLabels = data.map((r, i) => ((i % every === 0 || i === n - 1) ? i : null)).filter((i) => i !== null);
  if (xLabels.length > 1 && xLabels[xLabels.length - 1] - xLabels[xLabels.length - 2] < every / 2) xLabels.splice(xLabels.length - 2, 1);

  // End labels, nudged apart so two close series never overprint.
  const ends = slots.map((s, si) => ({ ...s, v: n ? Number(data[n - 1].values[si]) || 0 : 0 }))
    .map((e) => ({ ...e, y: y(e.v) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) {
    if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
  }

  function contentAt(i) {
    const r = data[i];
    return { title: r.label, rows: slots.map((s, si) => ({ name: s.name, value: fullValue(r.values[si], unit), slot: s.slot })) };
  }
  function nearest(e) {
    const svg = e.currentTarget;
    const b = svg.getBoundingClientRect();
    const px = ((e.clientX - b.left) / b.width) * w;
    if (n <= 1) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(((px - PAD.left) / iw) * (n - 1))));
  }
  function move(e) {
    if (!n) return;
    const i = nearest(e);
    setHover(i);
    if (tip) tip.show(e, contentAt(i));
  }
  function key(e) {
    if (!n) return;
    let i = hover == null ? n - 1 : hover;
    if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else return;
    e.preventDefault();
    setHover(i);
    const svg = e.currentTarget;
    const b = svg.getBoundingClientRect();
    if (tip) tip.show({ clientX: b.left + (x(i) / w) * b.width, clientY: b.top + (y(Math.max(...data[i].values)) / H) * b.height, type: 'key' }, contentAt(i));
  }

  const path = (si) => data.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.values[si]).toFixed(1)}`).join(' ');

  return (
    <>
      <Legend series={slots} line />
      <div className="tlc-plot" ref={wrap}>
        <svg
          viewBox={`0 0 ${w} ${H}`}
          height={H}
          role="img"
          tabIndex={0}
          aria-label={`${names.join(', ')} by period. Use the table view for every value.`}
          onPointerMove={move}
          onPointerLeave={() => { setHover(null); if (tip) tip.hide(); }}
          onKeyDown={key}
          onBlur={() => { setHover(null); if (tip) tip.hide(); }}
        >
          <g className="tlc-grid">
            {ticks.map((t) => <line key={t} x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} />)}
          </g>
          {ticks.map((t) => (
            <text key={t} className="tlc-tick" x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end">{shortValue(t, unit)}</text>
          ))}
          <line className="tlc-base" x1={PAD.left} x2={w - PAD.right} y1={y(0)} y2={y(0)} />
          {xLabels.map((i) => (
            <text key={data[i].key || data[i].label} className="tlc-tick" x={x(i)} y={H - 6} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}>{data[i].label}</text>
          ))}
          {hover != null && <line className="tlc-cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} />}
          {slots.map((s, si) => <path key={s.name} className={`tlc-line k${s.slot}`} d={path(si)} />)}
          {n > 0 && slots.map((s, si) => (
            <circle key={s.name} className={`tlc-dot k${s.slot}`} cx={x(hover != null ? hover : n - 1)} cy={y(data[hover != null ? hover : n - 1].values[si])} r={4} />
          ))}
          {hover == null && ends.map((e) => (
            <text key={e.name} className="tlc-endlab" x={x(n - 1) + 8} y={e.y + 4}>{shortValue(e.v, unit)}</text>
          ))}
        </svg>
      </div>
    </>
  );
}
