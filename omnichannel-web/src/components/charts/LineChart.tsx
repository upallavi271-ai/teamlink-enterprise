import { useId, useMemo, useRef, useState } from 'react';

export interface LineSeries { key: string; label: string; color: string; values: number[] }

/**
 * Multi-series line chart with a crosshair tooltip. An HTML/SVG chart IS
 * interactive, so the hover layer is not optional — pointer position maps to the
 * nearest x index and every series reports its value there at once, which is
 * what makes comparing them possible.
 */
export function LineChart({ labels, series, height = 210, formatValue = (v: number) => v.toLocaleString() }: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const PAD = { l: 38, r: 10, t: 10, b: 22 };
  const W = 600;
  const H = height;
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const max = useMemo(() => Math.max(1, ...series.flatMap((s) => s.values)), [series]);
  const top = niceCeil(max);
  const ticks = useMemo(() => Array.from({ length: 5 }, (_, i) => Math.round((top / 4) * (4 - i))), [top]);

  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;

  if (!n || !series.length) {
    return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>No data for this period.</div>;
  }

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const rel = ((e.clientX - box.left) / box.width) * W;
    const t = (rel - PAD.l) / (innerW || 1);
    setHoverIdx(Math.max(0, Math.min(n - 1, Math.round(t * (n - 1)))));
  };

  // Label every few ticks so the axis never collides with itself.
  const step = Math.max(1, Math.ceil(n / 7));

  return (
    <figure className="m-0">
      <span id={titleId} className="sr-only">Line chart of {series.map((s) => s.label).join(' and ')} over time</span>
      <div ref={wrapRef} className="relative" onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-labelledby={titleId} style={{ height }}>
          {/* recessive grid */}
          {ticks.map((t, i) => (
            <g key={t + '-' + i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{compact(t)}</text>
            </g>
          ))}
          {labels.map((l, i) => i % step === 0 && (
            <text key={l + i} x={x(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="var(--muted)">{l}</text>
          ))}

          {hoverIdx !== null && (
            <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD.t} y2={PAD.t + innerH} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />
          )}

          {series.map((s) => (
            <polyline
              key={s.key}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
            />
          ))}

          {/* markers only on hover — a dot on every point is noise */}
          {hoverIdx !== null && series.map((s) => (
            <circle key={s.key} cx={x(hoverIdx)} cy={y(s.values[hoverIdx] ?? 0)} r={4.5}
              fill={s.color} stroke="var(--surface)" strokeWidth={2} />
          ))}
        </svg>

        {hoverIdx !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[130px] rounded-lg border border-line bg-surface p-2 text-xs shadow-card"
            style={{
              left: `${(x(hoverIdx) / W) * 100}%`,
              transform: hoverIdx > n / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <div className="mb-1 font-medium text-ink">{labels[hoverIdx]}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}
                </span>
                <span className="font-medium text-ink">{formatValue(s.values[hoverIdx] ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Legend is always present for 2+ series. */}
      {series.length > 1 && (
        <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5 text-xs text-muted">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.label}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function niceCeil(v: number): number {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);
}
