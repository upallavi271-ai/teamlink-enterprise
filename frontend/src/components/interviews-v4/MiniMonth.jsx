import { useEffect, useMemo, useState } from 'react';
import {
  addDays, dayKey, mondayOf, sameDay, startOfDay,
} from './calUtils.js';

// The small month on the left: pick a day to move the big calendar there.
// A dot marks a day that holds interviews (from the same rows the grid draws);
// the days the big calendar shows are shaded.
const HEAD = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export default function MiniMonth({
  anchor, from, to, counts, onPick,
}) {
  const [month, setMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  // Follow the big calendar when it moves to another month.
  useEffect(() => {
    setMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  }, [anchor.getFullYear(), anchor.getMonth()]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = startOfDay(new Date());
  const days = useMemo(() => {
    const start = mondayOf(month);
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const weeks = Math.ceil((((month.getDay() + 6) % 7) + last.getDate()) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  }, [month]);
  const a = from ? startOfDay(from).getTime() : null;
  const b = to ? startOfDay(to).getTime() : null;
  return (
    <div className="iv4-mini">
      <div className="iv4-mini-head">
        <b>{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</b>
        <span>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">›</button>
        </span>
      </div>
      <div className="iv4-mini-grid">
        {HEAD.map((h) => <span key={h} className="iv4-mini-dow">{h}</span>)}
        {days.map((d) => {
          const t = d.getTime();
          const n = counts.get(dayKey(d)) || 0;
          const cls = [
            'iv4-mini-d',
            d.getMonth() !== month.getMonth() ? 'is-out' : '',
            a !== null && t >= a && t <= b ? 'is-range' : '',
            sameDay(d, anchor) ? 'is-anchor' : '',
            sameDay(d, today) ? 'is-today' : '',
          ].filter(Boolean).join(' ');
          return (
            <button
              key={dayKey(d)}
              type="button"
              className={cls}
              onClick={() => onPick(d)}
              title={n ? `${n.toLocaleString('en-IN')} interview${n === 1 ? '' : 's'}` : undefined}
            >
              {d.getDate()}
              {n > 0 && <i aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
