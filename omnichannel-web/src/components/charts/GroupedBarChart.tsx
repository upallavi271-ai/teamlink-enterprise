import { useId, useMemo, useState } from 'react';

export interface BarSeries { key: string; label: string; color: string; values: number[] }

/**
 * Grouped bar chart — one cluster per x label, one bar per series inside it.
 *
 * Bars are for comparing magnitudes at a point, which is why hovering
 * highlights the whole cluster and reports every series at once: reading a
 * single bar in isolation is almost never the question being asked.
 *
 * Matches LineChart's geometry (same padding, same nice-ceiling axis, same
 * tooltip) so the two read as one system when stacked on a page.
 */
export function GroupedBarChart({
  labels,
  series,
  height = 210,
  formatValue = (v: number) => v.toLocaleString(),
}: {
  labels: string[];
  series: BarSeries[];
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
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

  if (!n || !series.length) {
    return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>No data for this period.</div>;
  }

  // Each cluster gets an equal slice; 18% of it is breathing room between clusters.
  const slot = innerW / n;
  const groupW = slot * 0.82;
  const barW = Math.max(1, groupW / series.length);
  const clusterX = (i: number) => PAD.l + i * slot + (slot - groupW) / 2;
  const y = (v: number) => PAD.t + innerH - (Math.max(0, v) / top) * innerH;

  // Label every few clusters so the axis never collides with itself.
  const step = Math.max(1, Math.ceil(n / 7));

  return (
    <figure className="m-0">
      <span id={titleId} className="sr-only">
        Grouped bar chart of {series.map((s) => s.label).join(', ')} over time
      </span>
      <div className="relative" onMouseLeave={() => setHoverIdx(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-labelledby={titleId} style={{ height }}>
          {/* recessive grid */}
          {ticks.map((t, i) => (
            <g key={t + '-' + i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill="var(--muted)">{compact(t)}</text>
            </g>
          ))}

          {/* One transparent band per cluster carries the hover — hovering a
              1px gap between bars should not drop the tooltip. */}
          {labels.map((l, i) => (
            <rect
              key={`hit-${l}-${i}`}
              x={PAD.l + i * slot}
              y={PAD.t}
              width={slot}
              height={innerH}
              fill={hoverIdx === i ? 'var(--surface-2)' : 'transparent'}
              onMouseEnter={() => setHoverIdx(i)}
            />
          ))}

          {labels.map((l, i) => i % step === 0 && (
            <text key={`lbl-${l}-${i}`} x={PAD.l + i * slot + slot / 2} y={H - 6}
              textAnchor="middle" fontSize={9} fill="var(--muted)" pointerEvents="none">{l}</text>
          ))}

          {series.map((s, si) => (
            <g key={s.key} pointerEvents="none">
              {s.values.map((v, i) => {
                const h = Math.max(0, PAD.t + innerH - y(v));
                return (
                  <rect
                    key={`${s.key}-${i}`}
                    x={clusterX(i) + si * barW}
                    y={y(v)}
                    width={Math.max(1, barW - 1)}
                    height={h}
                    rx={Math.min(2, barW / 3)}
                    fill={s.color}
                    opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.45}
                  />
                );
              })}
            </g>
          ))}

          {/* baseline, so zero-height bars still sit on something */}
          <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH} y2={PAD.t + innerH}
            stroke="var(--line)" strokeWidth={1} pointerEvents="none" />
        </svg>

        {hoverIdx !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[130px] rounded-lg border border-line bg-surface p-2 text-xs shadow-card"
            style={{
              left: `${((PAD.l + hoverIdx * slot + slot / 2) / W) * 100}%`,
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
