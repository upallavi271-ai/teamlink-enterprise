// A WIDE TABLE with its horizontal scrollbar at the TOP as well: a thin bar
// above the table, kept in step with the table's own scroll. The table box
// has a max height with a sticky header, so its bottom scrollbar is always on
// screen too.
//
// Moved here from pages/attendance/DayReport.jsx (which re-exports it, so the
// attendance screens import it exactly as before) so Employee Management and
// any other wide list can use the same one.
//
//   maxHeight      CSS max-height of the table box (default 70vh). Pass null
//                  to leave it to a class in bodyClassName (e.g. .tbl-fit).
//   bodyClassName  extra classes on the scrolling box.
import { useEffect, useRef, useState } from 'react';
import './ScrollTable.css';

export default function ScrollTable({ children, maxHeight = '70vh', className = '', bodyClassName = '' }) {
  const top = useRef(null);
  const body = useRef(null);
  const syncing = useRef(false);
  const [width, setWidth] = useState(0);
  const [wide, setWide] = useState(false);
  const measure = () => {
    const el = body.current;
    if (!el) return;
    // The two bars must have the SAME scroll range. The table box loses width
    // to its own vertical scrollbar and the thin top bar does not, so the top
    // spacer is sized to (overflow + the top bar's own width), not simply to
    // the table's scrollWidth — otherwise the top bar stops short of the end.
    const t = top.current;
    const inner = t && t.clientWidth ? el.scrollWidth - el.clientWidth + t.clientWidth : el.scrollWidth;
    setWidth((w) => (w === inner ? w : inner));
    setWide((v) => (v === (el.scrollWidth > el.clientWidth + 1) ? v : el.scrollWidth > el.clientWidth + 1));
  };
  // After every render (the rows change) — setState bails out when nothing moved.
  useEffect(() => { measure(); });
  useEffect(() => {
    const el = body.current;
    if (!el) return undefined;
    measure();
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    window.addEventListener('resize', measure);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const follow = (src, dst) => {
    if (syncing.current) { syncing.current = false; return; }
    if (src.current && dst.current && dst.current.scrollLeft !== src.current.scrollLeft) {
      syncing.current = true;
      dst.current.scrollLeft = src.current.scrollLeft;
    }
  };
  return (
    <div className={`att-wide ${className}`}>
      <div className="att-wide-top" ref={top} onScroll={() => follow(top, body)} style={{ display: wide ? 'block' : 'none' }} aria-hidden="true">
        <div style={{ width, height: 1 }} />
      </div>
      <div
        className={`tbl-wrap att-wide-body ${bodyClassName}`}
        ref={body}
        onScroll={() => follow(body, top)}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
