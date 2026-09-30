// Horizontal bars, one series: "which of these is biggest", with category
// names long enough that a vertical axis would truncate them. The title names
// the series, so there is no legend box. Value at the bar tip; the bar itself
// is the hover / focus target and carries the full figure in a tooltip.
import { useTip } from './ChartCard.jsx';
import { fullValue, shortValue } from './format.js';

export default function BarChart({ rows, unit, slot = '1' }) {
  const tip = useTip();
  const data = (rows || []).filter(Boolean);
  // Scaled to the biggest bar, not the total: these are compared with each other.
  const top = Math.max(...data.map((r) => Number(r.value) || 0), 1);
  return (
    <div className="tlc-bars">
      {data.map((r) => {
        const v = Number(r.value) || 0;
        const content = { title: r.label, rows: [{ name: '', value: fullValue(v, unit), slot }] };
        return (
          <div
            key={r.label}
            className="tlc-bar"
            tabIndex={0}
            aria-label={`${r.label}: ${fullValue(v, unit)}`}
            onPointerMove={(e) => tip && tip.show(e, content)}
            onPointerLeave={() => tip && tip.hide()}
            onFocus={(e) => tip && tip.show(e, content)}
            onBlur={() => tip && tip.hide()}
          >
            <div className="lab" title={r.label}>{r.label}</div>
            <div className="trk">
              {/* A zero gets no stub: a sliver on an empty bucket reads as
                  "a little", the opposite of what is true. */}
              {v > 0 && <div className={`bar f${slot}`} style={{ width: `${Math.max(1.5, (v / top) * 100)}%` }} />}
            </div>
            <div className="val">{shortValue(v, unit)}</div>
          </div>
        );
      })}
    </div>
  );
}
