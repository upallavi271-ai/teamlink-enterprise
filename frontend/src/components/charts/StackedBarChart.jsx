// Horizontal stacked bars: each category split by series (department-wise
// status). 2px of surface between segments, a legend for the series, the
// category total at the tip, and every segment is its own hover / focus target.
import { useTip, Legend } from './ChartCard.jsx';
import { fullValue, shortValue, slotOf } from './format.js';

export default function StackedBarChart({ series, rows, unit }) {
  const tip = useTip();
  const names = series || [];
  const slots = names.map((n, i) => ({ name: n, slot: slotOf(i, n) }));
  const data = (rows || []).filter(Boolean);
  const totalOf = (r) => r.values.reduce((s, v) => s + (Number(v) || 0), 0);
  const top = Math.max(...data.map(totalOf), 1);
  return (
    <>
      <Legend series={slots} />
      <div className="tlc-bars tlc-stack">
        {data.map((r) => {
          const total = totalOf(r);
          const all = {
            title: `${r.label} · ${fullValue(total, unit)}`,
            rows: slots.map((s, i) => ({ name: s.name, value: fullValue(r.values[i], unit), slot: s.slot })),
          };
          return (
            <div key={r.label} className="tlc-bar" aria-label={`${r.label}: ${slots.map((s, i) => `${s.name} ${fullValue(r.values[i], unit)}`).join(', ')}`}>
              <div className="lab" title={r.label}>{r.label}</div>
              <div className="trk" style={{ width: `${Math.max(1.5, (total / top) * 100)}%` }}>
                {slots.map((s, i) => {
                  const v = Number(r.values[i]) || 0;
                  if (!v) return null;
                  const one = { title: r.label, rows: [{ name: s.name, value: `${fullValue(v, unit)} of ${fullValue(total, unit)}`, slot: s.slot }] };
                  return (
                    <div
                      key={s.name}
                      className={`seg f${s.slot}`}
                      style={{ flex: `${v} 1 0` }}
                      tabIndex={0}
                      aria-label={`${r.label}, ${s.name}: ${fullValue(v, unit)}`}
                      onPointerMove={(e) => tip && tip.show(e, one)}
                      onPointerLeave={() => tip && tip.hide()}
                      onFocus={(e) => tip && tip.show(e, all)}
                      onBlur={() => tip && tip.hide()}
                    />
                  );
                })}
              </div>
              <div className="val">{shortValue(total, unit)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
