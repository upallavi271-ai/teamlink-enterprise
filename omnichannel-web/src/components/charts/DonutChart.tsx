import { useId, useState } from 'react';

export interface DonutSlice { key: string; label: string; value: number; color: string }

/**
 * Status ring. Slice order is deliberate: delivered → read → failed → sent puts
 * the green and the red on OPPOSITE sides of the ring, because those two are the
 * pair colour-blind readers cannot separate (ΔE 5.7 deutan). Every neighbouring
 * pair, including the wrap seam, clears ΔE 9.7. A 2px surface gap between arcs
 * and the labelled legend carry identity so colour is never the only signal.
 */
export function DonutChart({ slices, size = 200, thickness = 26 }: {
  slices: DonutSlice[]; size?: number; thickness?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const titleId = useId();
  const shown = slices.filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);

  const r = (size - thickness) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  // 2px of surface between arcs — the spacer that keeps adjacent fills readable.
  const gap = total > 0 && shown.length > 1 ? 2 : 0;

  let offset = 0;
  const arcs = shown.map((s) => {
    const len = Math.max((s.value / total) * circ - gap, 0);
    const arc = { ...s, len, offset };
    offset += (s.value / total) * circ;
    return arc;
  });

  const active = hover ? shown.find((s) => s.key === hover) : null;
  const headline = active ?? null;

  if (total === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-muted">
        No messages in this period yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-labelledby={titleId}>
          <title id={titleId}>
            Delivery status breakdown: {shown.map((s) => `${s.label} ${s.value}`).join(', ')}
          </title>
          <g transform={`rotate(-90 ${c} ${c})`}>
            {arcs.map((a) => (
              <circle
                key={a.key}
                cx={c} cy={c} r={r}
                fill="none"
                stroke={a.color}
                strokeWidth={hover === a.key ? thickness + 4 : thickness}
                strokeDasharray={`${a.len} ${circ - a.len}`}
                strokeDashoffset={-a.offset}
                strokeLinecap="butt"
                className="cursor-pointer transition-[stroke-width] duration-150"
                onMouseEnter={() => setHover(a.key)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </g>
        </svg>
        {/* Hero number in the hole — the headline the ring exists to support. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="font-display text-2xl font-semibold text-ink">
            {(headline ? headline.value : total).toLocaleString()}
          </div>
          <div className="max-w-[7rem] text-xs text-muted">
            {headline ? headline.label : 'Total messages'}
          </div>
        </div>
      </div>

      {/* Legend is always present: identity never rests on colour alone. */}
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1.5">
        {shown.map((s) => (
          <li
            key={s.key}
            className="flex cursor-pointer items-center gap-1.5 text-xs"
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span className={hover === s.key ? 'font-medium text-ink' : 'text-muted'}>{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
