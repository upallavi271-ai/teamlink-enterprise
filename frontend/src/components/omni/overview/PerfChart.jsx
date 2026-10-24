import { useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// "Performance overview" chart (the prototype's SVG 820 x 250): grid lines, a green filled Reach line, a blue dashed Engagement line, x labels, and
// invisible hover circles that show a dark tooltip. Real series: [{ label, reach, engagement }] (one point per day, or per month for "This year").
// Clicking the chart (or a point) calls onOpen (Analytics).
// ---------------------------------------------------------------------------
const W = 820; const H = 250; const X0 = 30; const X1 = 805; const Y0 = 235; const Y1 = 35;
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

// a smooth line through the points (no overshoot): each step is an S curve with horizontal handles
function smooth(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]} L${pts[0][0] + 0.01} ${pts[0][1]}`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 1) { const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; const mx = (x0 + x1) / 2; d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`; }
  return d;
}

export default function PerfChart({ series, onOpen }) {
  const [tip, setTip] = useState(null);
  const g = useMemo(() => {
    const n = series.length;
    const max = Math.max(1, ...series.map((p) => Math.max(p.reach, p.engagement)));
    const xs = (i) => (n <= 1 ? (X0 + X1) / 2 : X0 + ((X1 - X0) * i) / (n - 1));
    const ys = (v) => Y0 - ((Y0 - Y1) * v) / max;
    const reach = series.map((p, i) => [xs(i), ys(p.reach)]);
    const eng = series.map((p, i) => [xs(i), ys(p.engagement)]);
    // about seven x labels, always including the first and the last
    const step = Math.max(1, Math.ceil((n - 1) / 6));
    const labelIdx = []; for (let i = 0; i < n; i += step) labelIdx.push(i); if (n && labelIdx[labelIdx.length - 1] !== n - 1 && n - 1 - labelIdx[labelIdx.length - 1] >= Math.ceil(step / 2)) labelIdx.push(n - 1);
    return { n, max, xs, ys, reach, eng, labelIdx, any: series.some((p) => p.reach > 0 || p.engagement > 0) };
  }, [series]);
  const line = smooth(g.reach);
  const area = g.reach.length ? `${line} L${g.reach[g.reach.length - 1][0]} ${Y0} L${g.reach[0][0]} ${Y0}Z` : '';
  const hit = tip !== null ? series[tip] : null;
  return (
    <div className="chart-shell" id="perfChartShell">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Performance chart" onClick={onOpen}>
        <defs><linearGradient id="ovFillG" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#b9ef78" stopOpacity=".32" /><stop offset="100%" stopColor="#b9ef78" stopOpacity="0" /></linearGradient></defs>
        <g stroke="#edf1ee" strokeWidth="1">{[35, 85, 135, 185, 235].map((y) => <line key={y} x1="30" y1={y} x2="805" y2={y} />)}</g>
        <g fill="#8b958f" fontSize="9" textAnchor="end">{[[235, 0], [135, Math.round(g.max / 2)], [35, g.max]].map(([y, v]) => <text key={y} x="24" y={y + 3}>{fmt(v)}</text>)}</g>
        {g.any && <path d={area} fill="url(#ovFillG)" />}
        <path d={line} fill="none" stroke="#11985a" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        <path d={smooth(g.eng)} fill="none" stroke="#4d7ddb" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="7 7" />
        <g fill="#8b958f" fontSize="9">{g.labelIdx.map((i) => <text key={i} x={g.xs(i)} y="247" textAnchor={i === 0 ? 'start' : (i === g.n - 1 ? 'end' : 'middle')}>{series[i].label}</text>)}</g>
        <g>{series.map((p, i) => <circle key={p.key || i} className="chart-point" cx={g.xs(i)} cy={g.ys(p.reach)} r={g.n > 40 ? 8 : 16} onMouseEnter={() => setTip(i)} onMouseLeave={() => setTip(null)} onClick={onOpen} />)}</g>
      </svg>
      {!g.any && <div className="chart-empty"><span>Nothing was really sent in this period, so there is nothing to draw yet.</span></div>}
      <div className={`chart-tooltip${hit ? ' show' : ''}`} style={hit ? { left: `${(g.xs(tip) / W) * 100}%`, top: `${(g.ys(hit.reach) / H) * 100}%` } : undefined} role="status">
        {hit && <><b>{hit.label}</b>People reached: {fmt(hit.reach)} · Engaged: {fmt(hit.engagement)}</>}
      </div>
    </div>
  );
}
