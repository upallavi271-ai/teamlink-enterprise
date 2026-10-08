import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// TEAM v4 charts — a line chart and a donut drawn as plain SVG, sized to the
// panel. PRESENTATION ONLY: the caller passes the real series; a missing
// value (a day still to come) is left out of the line, never drawn as 0.
// ---------------------------------------------------------------------------

function useBoxWidth(fallback = 420) {
  const ref = useRef(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const set = () => setW(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    set();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

//   labels  ['06 Oct', …]       one per x position
//   series  [{ key, label, color, values: [n | null, …] }]
export function LineChart({ labels = [], series = [], height = 210, empty }) {
  const [ref, width] = useBoxWidth();
  const [hover, setHover] = useState(null);
  const all = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
  const max = niceMax(Math.max(0, ...all));
  const padL = 30; const padR = 22; const padT = 10; const padB = 24;
  const iw = width - padL - padR; const ih = height - padT - padB;
  const n = labels.length;
  const x = (i) => padL + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v) => padT + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 58))));
  const pathOf = (vals) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const first = series[0];
  let area = '';
  if (first) {
    const pts = first.values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
    if (pts.length > 1) area = `M${x(pts[0][0])},${y(0)}${pts.map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}L${x(pts[pts.length - 1][0])},${y(0)}Z`;
  }
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = n <= 1 ? 0 : Math.round(((px - padL) / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const hasAny = all.some((v) => v > 0);
  return (
    <div className="tv4-line" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(', ')}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="tv4-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={first ? first.color : '#2F6FE4'} stopOpacity="0.16" />
            <stop offset="100%" stopColor={first ? first.color : '#2F6FE4'} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} className="tv4-gl" />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" className="tv4-axis">{t}</text>
          </g>
        ))}
        {labels.map((l, i) => (i % every === 0 || i === n - 1) && (
          <text key={l + i} x={x(i)} y={height - 6} textAnchor="middle" className="tv4-axis">{l}</text>
        ))}
        {area && <path d={area} fill="url(#tv4-area)" />}
        {series.map((s) => (
          <g key={s.key}>
            <path d={pathOf(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {n <= 16 && s.values.map((v, i) => (v === null || v === undefined ? null
              : <circle key={i} cx={x(i)} cy={y(v)} r="3" fill="#fff" stroke={s.color} strokeWidth="1.8" />))}
          </g>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} className="tv4-hoverline" />}
      </svg>
      {hover !== null && (
        <div className="tv4-tip" style={{ left: Math.min(width - 150, Math.max(0, x(hover) + 10)) }}>
          <b>{labels[hover]}</b>
          {series.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.label}<em>{s.values[hover] === null || s.values[hover] === undefined ? '—' : s.values[hover]}</em></span>
          ))}
        </div>
      )}
      {!hasAny && empty && <div className="tv4-line-empty">{empty}</div>}
    </div>
  );
}

//   segments [{ key, label, value, color }]
export function Donut({ segments = [], size = 132, thickness = 18, center, centerLabel }) {
  const total = segments.reduce((n, s) => n + (Number(s.value) || 0), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF2F7" strokeWidth={thickness} />
      {total > 0 && segments.map((s) => {
        const len = ((Number(s.value) || 0) / total) * c;
        const el = (
          <circle key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        );
        off += len;
        return el;
      })}
      <text x="50%" y="47%" textAnchor="middle" className="tv4-donut-n">{center}</text>
      <text x="50%" y="62%" textAnchor="middle" className="tv4-donut-l">{centerLabel}</text>
    </svg>
  );
}
