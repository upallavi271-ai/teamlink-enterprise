// ---------------------------------------------------------------------------
// ATS layout v3 chart kit — shared pieces (no chart library, plain React + SVG).
//
//   useWidth(ref)        the container's width, live (ResizeObserver), so every
//                        chart fills its box and redraws on resize.
//   useLocalTip()        one hover / focus tooltip per chart: { tip, show, hide }.
//   <Tip>                the tooltip: value leads, name follows, line keys.
//   <SrTable>            the hidden table a screen reader gets for every chart.
//   <ChartEmpty>         "No data for this period" — words, never a blank box.
//   toneVar / slotVar    colours from CSS tokens (charts.css .tlk):
//                          status tones green / yellow / red / blue / grey
//                          (the user's five, 2026-10-03), and the categorical
//                          series slots 1..6 in a FIXED order + grey Other.
//
// Categorical palette (validated with the dataviz validate_palette.js, adjacent
// pairs, light on #ffffff and dark on #1a1a19 — all checks PASS):
//   light #0a74bd #c2410c #7f56d9 #15803d #d6409f #b88600
//   dark  #3d8fd6 #e0662e #9a7de6 #2f9e57 #e05aaa #b88600
// Slots 1-4 are the HRMS kit's own four, so both kits read as one system.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import './charts.css';

export const MAX_SLOTS = 6;

const TONES = {
  green: 'green', good: 'green', joined: 'green', done: 'green', active: 'green',
  yellow: 'yellow', amber: 'yellow', orange: 'yellow', pending: 'yellow', warn: 'yellow', warning: 'yellow',
  red: 'red', bad: 'red', late: 'red', rejected: 'red', danger: 'red',
  blue: 'blue', info: 'blue', process: 'blue', new: 'blue',
  grey: 'grey', gray: 'grey', closed: 'grey', muted: 'grey',
};
// Any tone name the app uses -> one of the five.
export function normTone(t) {
  return TONES[String(t || '').toLowerCase()] || null;
}
export function toneVar(t) {
  const n = normTone(t);
  return n ? `var(--tlk-${n})` : null;
}
// Series colour by POSITION in the caller's fixed list; past six, or a series
// named "Other", is the grey Other bucket. Colour follows the series.
export function slotVar(index, name) {
  if (/^other$/i.test(String(name || '')) || index >= MAX_SLOTS) return 'var(--tlk-other)';
  return `var(--tlk-s${index + 1})`;
}

const IN = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
export const defaultFormat = (n) => IN.format(Number(n) || 0);
export function shortNum(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return IN.format(v);
}

// 0 and three or four round steps up to at least max. integer: whole-number
// steps only (counts never read "2.5 people").
export const allWhole = (vals) => vals.every((v) => Number.isInteger(Number(v) || 0));
export function ticksFor(max, count = 4, integer = false) {
  const top = Math.max(Number(max) || 0, 1);
  const raw = top / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const steps = integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  const step = Math.max(integer ? 1 : 0, steps.map((m) => m * pow).find((s) => s >= raw) || raw);
  const out = [];
  for (let v = 0; v <= top + step * 0.001; v += step) out.push(Math.round(v * 100) / 100);
  if (out[out.length - 1] < top) out.push(Math.round((out[out.length - 1] + step) * 100) / 100);
  return out;
}

export function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') {
      const on = () => setW(el.clientWidth);
      window.addEventListener('resize', on);
      return () => window.removeEventListener('resize', on);
    }
    const ro = new ResizeObserver((ents) => {
      const cw = Math.floor(ents[0].contentRect.width);
      setW((p) => (p === cw ? p : cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// Tooltip state positioned inside the chart's own wrapper (position:relative).
export function useLocalTip(wrapRef) {
  const [tip, setTip] = useState(null);
  const show = useCallback((e, content) => {
    const box = wrapRef.current;
    if (!box || !content) return;
    const b = box.getBoundingClientRect();
    let x;
    let y;
    if (e && typeof e.clientX === 'number' && e.type !== 'focus') {
      x = e.clientX - b.left;
      y = e.clientY - b.top;
    } else {
      const el = (e && e.currentTarget) || null;
      const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : b;
      x = r.left + r.width / 2 - b.left;
      y = r.top - b.top;
    }
    x = Math.max(60, Math.min(b.width - 60, x));
    y = Math.max(36, y);
    setTip({ x, y, ...content });
  }, [wrapRef]);
  const hide = useCallback(() => setTip(null), []);
  return { tip, show, hide };
}

// content: { title, rows: [{ name, value, color }], hint }
export function Tip({ tip }) {
  if (!tip) return null;
  return (
    <div className="tlk-tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.title && <div className="t">{tip.title}</div>}
      {(tip.rows || []).map((r, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="r" key={i}>
          {r.color && <i style={{ background: r.color }} />}
          <b>{r.value}</b>
          {r.name && <span>{r.name}</span>}
        </div>
      ))}
      {tip.hint && <div className="h">{tip.hint}</div>}
    </div>
  );
}

export function SrTable({ caption, headers, rows }) {
  return (
    // Wrapped in a div: a <table> ignores width:1px and pushed phones sideways.
    <div className="tlk-sr"><table>
      {caption && <caption>{caption}</caption>}
      <thead><tr>{headers.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, ri) => (
          // eslint-disable-next-line react/no-array-index-key
          <tr key={ri}>{r.map((c, ci) => (ci === 0 ? <th key={ci} scope="row">{c}</th> : <td key={ci}>{c}</td>))}</tr>
        ))}
      </tbody>
    </table></div>
  );
}

export function ChartEmpty({ text, height }) {
  return <div className="tlk-empty" style={height ? { minHeight: Math.min(height, 150) } : undefined}>{text || 'No data for this period'}</div>;
}

// Keyboard + pointer props for a clickable / hoverable mark.
export function markProps({ onClick, show, hide, content, label }) {
  const clickable = typeof onClick === 'function';
  return {
    tabIndex: 0,
    role: clickable ? 'button' : 'img',
    'aria-label': label,
    style: clickable ? { cursor: 'pointer' } : undefined,
    onPointerMove: (e) => show(e, content),
    onPointerLeave: hide,
    onFocus: (e) => show(e, content),
    onBlur: hide,
    onClick: clickable ? onClick : undefined,
    onKeyDown: clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } } : undefined,
  };
}

// A vertical bar's path: 4px rounded data-end, square at the baseline.
export function colPath(x, y, w, h, r = 4) {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function useChartBox() {
  const ref = useRef(null);
  const width = useWidth(ref);
  const tipApi = useLocalTip(ref);
  return { ref, width, ...tipApi };
}

export function Legend({ items }) {
  if (!items || items.length < 2) return null;
  return (
    <div className="tlk-legend">
      {items.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
    </div>
  );
}
