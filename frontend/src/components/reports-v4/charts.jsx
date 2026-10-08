import { useEffect, useRef, useState } from 'react';
import { fmtNum } from '../atskit/AtsKit.jsx';

// ---------------------------------------------------------------------------
// REPORTS v4 — two small presentation-only charts for the Reports overview
// (2026-10-08). Every value is passed in by the caller from an existing API
// response; nothing here fetches or defaults a number.
//
//   <TrendLines labels series />   1–2 lines over time, dots + soft wash
//   <FunnelShape steps />          the hiring funnel: stacked segments + table
// ---------------------------------------------------------------------------

const COLORS = { blue: '#2F6FE4', violet: '#8B5CF6', teal: '#1BA3A1', amber: '#E59A1A', pink: '#D9488F', green: '#22A06B' };

// A top value that splits into four whole, round steps.
function niceMax(v) {
  const raw = Math.max(1, v) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const step = Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p);
  return step * 4;
}
const short = (n) => (n >= 100000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${Math.round((n / 1000) * 10) / 10}K` : String(Math.round(n * 10) / 10));

//   labels: ['06 Oct', …]; series: [{ name, tone, values: [..] }]
export function TrendLines({ labels = [], series = [], height = 280 }) {
  const box = useRef(null);
  const [w, setW] = useState(460);
  const [hover, setHover] = useState(-1);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = labels.length;
  const all = series.flatMap((s) => s.values.map((v) => Number(v) || 0));
  const max = niceMax(Math.max(0, ...all));
  const pad = { l: 34, r: 16, t: 10, b: 26 };
  const iw = w - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v) => pad.t + ih - ((Number(v) || 0) / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  // X labels: the first starts at its point, the last ends at its point (so
  // neither is clipped), the rest are centred; a label that would touch its
  // neighbour is skipped (widths estimated at ~6px a character).
  const anchorOf = (i) => (n > 1 && i === n - 1 ? 'end' : n > 1 && i === 0 ? 'start' : 'middle');
  const spanOf = (i) => {
    const lw = String(labels[i] || '').length * 6;
    const a = anchorOf(i);
    return a === 'start' ? [x(i), x(i) + lw] : a === 'end' ? [x(i) - lw, x(i)] : [x(i) - lw / 2, x(i) + lw / 2];
  };
  const shownX = [];
  for (let i = 0; i < n; i += 1) {
    const [a] = spanOf(i);
    if (i === n - 1) {
      while (shownX.length && spanOf(shownX[shownX.length - 1])[1] + 10 > a && shownX[shownX.length - 1] !== 0) shownX.pop();
      if (!shownX.length || spanOf(shownX[shownX.length - 1])[1] + 10 <= a || n === 1) shownX.push(i);
    } else if (!shownX.length || spanOf(shownX[shownX.length - 1])[1] + 14 <= a) shownX.push(i);
  }
  const showX = new Set(shownX);
  const nearest = (e) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    for (let i = 0; i < n; i += 1) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    return best;
  };
  return (
    <div className="rv4-trend" ref={box}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={series.map((s) => s.name).join(' and ')}
        onPointerMove={(e) => n && setHover(nearest(e))} onPointerLeave={() => setHover(-1)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="rv4-grid" />
            <text x={pad.l - 6} y={y(t) + 3.5} textAnchor="end" className="rv4-tick">{short(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => showX.has(i) && (
          <text key={`${l}-${i}`} x={x(i)} y={height - 7} textAnchor={anchorOf(i)} className="rv4-tick">{l}</text>
        ))}
        {series.map((s, si) => {
          const c = COLORS[s.tone] || COLORS.blue;
          const line = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
          const area = `${line}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`;
          return (
            <g key={s.name}>
              {si === 0 && <path d={area} fill={c} opacity="0.08" />}
              <path d={line} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" />
              {n <= 40 && s.values.map((v, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4.5 : 3.2} fill={c} stroke="#fff" strokeWidth="1.5" />
              ))}
            </g>
          );
        })}
        {hover >= 0 && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={y(0)} className="rv4-cross" />}
      </svg>
      {hover >= 0 && (
        <div className="rv4-tip" style={{ left: Math.min(Math.max(x(hover) - 70, 0), w - 150) }}>
          <b>{labels[hover]}</b>
          {series.map((s) => (
            <span key={s.name}><i style={{ background: COLORS[s.tone] || COLORS.blue }} />{s.name}: {fmtNum(Number(s.values[hover]) || 0)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

//   steps: [{ key, label, title, value, pct, onClick }]
const FUNNEL_TONES = ['blue', 'violet', 'teal', 'amber', 'pink', 'green'];
export function FunnelShape({ steps = [] }) {
  const first = Number(steps[0] && steps[0].value) || 0;
  const H = 30;
  const W = 120;
  // Each band's width follows its share of the first step, with a floor so
  // a small step is still visible.
  const widthOf = (v) => W * (first > 0 ? Math.max(0.22, Math.min(1, (Number(v) || 0) / first)) : 0.22);
  return (
    <div className="rv4-funnel">
      <svg className="rv4-funnel-svg" width={W} height={steps.length * (H + 3)} viewBox={`0 0 ${W} ${steps.length * (H + 3)}`} aria-hidden="true">
        {steps.map((s, i) => {
          const top = widthOf(s.value);
          const bot = i < steps.length - 1 ? widthOf(steps[i + 1].value) : top * 0.82;
          const y0 = i * (H + 3);
          const pts = `${(W - top) / 2},${y0} ${(W + top) / 2},${y0} ${(W + bot) / 2},${y0 + H} ${(W - bot) / 2},${y0 + H}`;
          return <polygon key={s.key} points={pts} fill={COLORS[FUNNEL_TONES[i % FUNNEL_TONES.length]]} rx="3" />;
        })}
      </svg>
      <ul className="rv4-funnel-list">
        {steps.map((s, i) => (
          <li key={s.key} style={{ height: H + 3 }}>
            <i style={{ background: COLORS[FUNNEL_TONES[i % FUNNEL_TONES.length]] }} />
            <span className="rv4-fl-label" title={s.title || s.label}>{s.label}</span>
            {s.onClick && Number(s.value) > 0
              ? <button type="button" className="rv4-num-btn" onClick={s.onClick} title="Show who is behind this number">{fmtNum(Number(s.value))}</button>
              : <span className="rv4-fl-val">{fmtNum(Number(s.value) || 0)}</span>}
            <span className="rv4-fl-pct">{s.pct === null || s.pct === undefined ? '' : `${s.pct}%`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
