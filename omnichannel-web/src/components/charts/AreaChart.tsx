import type { PerformancePoint } from '@/types';

// Dependency-free two-series area chart for the dashboard performance panel.
export function AreaChart({ data, height = 220 }: { data: PerformancePoint[]; height?: number }) {
  if (data.length < 2) return null;
  const width = 640;
  const pad = { l: 8, r: 8, t: 12, b: 22 };
  const allVals = data.flatMap((d) => [d.reach, d.engagement]);
  const max = Math.max(...allVals) || 1;
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / (data.length - 1)) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = (sel: (d: PerformancePoint) => number) => data.map((d, i) => `${x(i)},${y(sel(d))}`).join(' ');
  const area = (sel: (d: PerformancePoint) => number) =>
    `${pad.l},${pad.t + ih} ${line(sel)} ${pad.l + iw},${pad.t + ih}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Reach and engagement over time">
      <polygon points={area((d) => d.reach)} fill="var(--accent)" opacity={0.10} />
      <polyline points={line((d) => d.reach)} fill="none" stroke="var(--accent)" strokeWidth={2.5} />
      <polyline points={line((d) => d.engagement)} fill="none" stroke="var(--blue)" strokeWidth={2} strokeDasharray="4 3" />
      {data.map((d, i) => (
        <text key={i} x={x(i)} y={height - 6} textAnchor="middle" className="fill-[var(--muted)]" fontSize={10}>{d.label}</text>
      ))}
    </svg>
  );
}
