import { useId, useState } from 'react';

export interface BarDatum { key: string; label: string; value: number }

/**
 * Vertical bars for one measure across categories. A single series needs no
 * legend — the card title names it — so colour here carries no identity and one
 * hue is used throughout. Bars are thin, share a baseline, keep a 2px surface
 * gap, and round only the data end.
 */
export function BarChart({ data, height = 190, color = 'var(--accent)', formatValue = (v: number) => v.toLocaleString() }: {
  data: BarDatum[]; height?: number; color?: string; formatValue?: (v: number) => string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const titleId = useId();
  const max = Math.max(...data.map((d) => d.value), 0);

  if (!data.length || max === 0) {
    return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>No channel activity yet.</div>;
  }

  // Four gridlines, rounded to something a person would actually read.
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: 5 }, (_, i) => top - i * step);

  return (
    <figure className="m-0" aria-labelledby={titleId}>
      <span id={titleId} className="sr-only">Messages by channel</span>
      <div className="flex gap-2" style={{ height }}>
        {/* Recessive axis */}
        <div className="flex w-12 shrink-0 flex-col justify-between py-[2px] text-right text-[10px] text-muted">
          {ticks.map((t) => <span key={t}>{compact(t)}</span>)}
        </div>
        <div className="relative flex-1">
          {ticks.map((t, i) => (
            <div key={t} className="absolute left-0 right-0 border-t border-line"
              style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end justify-around gap-2 px-1">
            {data.map((d) => {
              const pct = (d.value / top) * 100;
              const on = hover === d.key;
              return (
                <div key={d.key} className="group relative flex h-full flex-1 items-end justify-center"
                  onMouseEnter={() => setHover(d.key)} onMouseLeave={() => setHover(null)}>
                  {on && (
                    <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-lg border border-line bg-surface px-2 py-1 text-xs shadow-card">
                      <span className="text-muted">{d.label}: </span>
                      <span className="font-medium text-ink">{formatValue(d.value)}</span>
                    </div>
                  )}
                  <div
                    className="w-full max-w-[38px] cursor-pointer rounded-t-[4px] transition-opacity"
                    style={{
                      height: `${Math.max(pct, d.value > 0 ? 1.5 : 0)}%`,
                      background: color,
                      opacity: hover && !on ? 0.45 : 1,
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex gap-2">
        <div className="w-12 shrink-0" />
        <div className="flex flex-1 justify-around gap-2 px-1">
          {data.map((d) => (
            <span key={d.key} className="flex-1 truncate text-center text-[10px] uppercase tracking-wide text-muted">
              {d.label}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}
