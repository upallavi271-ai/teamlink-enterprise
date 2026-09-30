// The frame every dashboard chart sits in: title, subtitle, a Chart / Table
// toggle (the table view carries every number the chart draws, so no value is
// ever reachable only by hovering), and one tooltip layer the chart inside can
// position.
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import './charts.css';

const TipContext = createContext(null);

// For a chart inside a card: show(event|element, { title, rows:[{name,value,slot}] }).
export function useTip() {
  return useContext(TipContext);
}

export default function ChartCard({ title, sub, table, empty, isEmpty, busy, children }) {
  const [view, setView] = useState('chart');
  const [tip, setTip] = useState(null);
  const ref = useRef(null);

  const show = useCallback((target, content) => {
    const box = ref.current;
    if (!box || !content) return;
    const b = box.getBoundingClientRect();
    let x;
    let y;
    if (target && typeof target.clientX === 'number' && target.type !== 'focus') {
      x = target.clientX - b.left;
      y = target.clientY - b.top;
    } else {
      const el = (target && target.currentTarget) || target;
      const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : b;
      x = r.left + r.width / 2 - b.left;
      y = r.top - b.top;
    }
    // Keep the tooltip inside the card.
    x = Math.max(70, Math.min(b.width - 70, x));
    y = Math.max(40, y);
    setTip({ x, y, ...content });
  }, []);
  const hide = useCallback(() => setTip(null), []);

  return (
    <section className={`tlc tlc-card${busy ? ' tlc-busy' : ''}`} ref={ref} aria-label={title}>
      <div className="tlc-head">
        <div>
          <h3>{title}</h3>
          {sub && <div className="tlc-sub">{sub}</div>}
        </div>
        {!isEmpty && table && (
          <button
            type="button"
            className="tlc-toggle"
            aria-pressed={view === 'table'}
            onClick={() => { setView((v) => (v === 'chart' ? 'table' : 'chart')); setTip(null); }}
          >
            {view === 'chart' ? 'Table view' : 'Chart view'}
          </button>
        )}
      </div>
      {isEmpty
        ? <div className="tlc-empty">{empty || 'No data for this range.'}</div>
        : view === 'table'
          ? <div className="tlc-tablewrap">{table}</div>
          : <TipContext.Provider value={{ show, hide }}>{children}</TipContext.Provider>}
      {tip && view === 'chart' && (
        <div className="tlc-tip" style={{ left: tip.x, top: tip.y }} role="status">
          {tip.title && <div className="t">{tip.title}</div>}
          {(tip.rows || []).map((r) => (
            <div className="r" key={r.name}>
              {r.slot && <i className={`f${r.slot}`} />}
              <b>{r.value}</b>
              <span>{r.name}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// A plain table from headers + rows, for the table view.
export function DataTable({ headers, rows, numeric = [] }) {
  return (
    <table className="tlc-table">
      <thead><tr>{headers.map((h, i) => <th key={h} className={numeric.includes(i) ? 'num' : undefined}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, ri) => (
          // eslint-disable-next-line react/no-array-index-key
          <tr key={ri}>{r.map((c, i) => <td key={headers[i]} className={numeric.includes(i) ? 'num' : undefined}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

export function Legend({ series, line = false }) {
  if (!series || series.length < 2) return null;
  return (
    <div className="tlc-legend">
      {series.map((s) => (
        <span key={s.name}><i className={`f${s.slot}${line ? ' line' : ''}`} />{s.name}</span>
      ))}
    </div>
  );
}
