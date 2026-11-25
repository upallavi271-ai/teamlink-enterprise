import { TinyBtn } from '../ui.jsx';

// AI MARKETING > SEO ASSISTANT: the small pieces the SEO assistant screens share (MkSeoPage.jsx, MkSeoTools.jsx): a copy box, the impact / effort chips, a score-over-time line.
// Plain React and inline SVG: no chart library. Wording rule of the Omni-Channel UI: the word "Draft" is never shown.
export const sign = (n) => (n > 0 ? `+${n}` : String(n));

export function CopyBox({ text, rows = 4, toast, mono = true }) {
  const copy = () => { try { navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Select the text and copy it.')); } catch { toast('Select the text and copy it.'); } };
  return (
    <div>
      <textarea readOnly rows={rows} value={text} style={{ width: '100%', fontFamily: mono ? 'monospace' : 'inherit', fontSize: 12 }} onFocus={(e) => e.target.select()} />
      <div style={{ marginTop: 4 }}><TinyBtn onClick={copy}>Copy</TinyBtn></div>
    </div>
  );
}

export const IMPACT = { high: ['High impact', '#b91c1c'], medium: ['Medium impact', '#b45309'], low: ['Low impact', '#6b7280'] };
export const EFFORT = { quick: 'Quick fix', medium: 'Needs the web person', bigger: 'Bigger job' };
export function Chips({ impact, effort, area }) {
  const [label, color] = IMPACT[impact] || IMPACT.low;
  const chip = (t, c, k) => <span key={k} style={{ fontSize: 10.5, fontWeight: 700, color: c, border: `1px solid ${c}`, borderRadius: 999, padding: '1px 7px', marginRight: 5, whiteSpace: 'nowrap' }}>{t}</span>;
  return <span>{chip(label, color, 'i')}{effort ? chip(EFFORT[effort] || effort, '#1d4fa8', 'e') : null}{area ? chip(area, '#6b7280', 'a') : null}</span>;
}

// the score of each saved audit, oldest to newest: a line with a dot per audit and the 0 to 100 scale. points: [{ at, score }]
export function TrendChart({ points }) {
  const W = 320; const H = 96; const padL = 24; const padR = 8; const padT = 8; const padB = 16; const pts = (points || []).filter((p) => p && p.score != null);
  if (!pts.length) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No audit has been saved yet.</div>;
  const x = (i) => (pts.length === 1 ? (padL + W - padR) / 2 : padL + (i * (W - padL - padR)) / (pts.length - 1)); const y = (s) => padT + ((100 - s) * (H - padT - padB)) / 100;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  const label = `Website score at each saved audit: ${pts.map((p) => p.score).join(', ')}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ width: '100%', maxWidth: 420, height: 'auto' }}>
      <title>{label}</title>
      {[0, 50, 100].map((s) => <g key={s}><line x1={padL} x2={W - padR} y1={y(s)} y2={y(s)} stroke="#e5e9e7" strokeWidth="1" /><text x={padL - 4} y={y(s) + 3} fontSize="8" textAnchor="end" fill="#7f8b84">{s}</text></g>)}
      {pts.length > 1 ? <path d={d} fill="none" stroke="#0f766e" strokeWidth="2" /> : null}
      {pts.map((p, i) => <g key={i}><circle cx={x(i)} cy={y(p.score)} r="3.5" fill="#0f766e" /><text x={x(i)} y={y(p.score) - 7} fontSize="9" textAnchor="middle" fill="#14332d" fontWeight="700">{p.score}</text></g>)}
      <text x={padL} y={H - 3} fontSize="8" fill="#7f8b84">{String(pts[0].at || '').slice(0, 10)}</text>
      {pts.length > 1 ? <text x={W - padR} y={H - 3} fontSize="8" textAnchor="end" fill="#7f8b84">{String(pts[pts.length - 1].at || '').slice(0, 10)}</text> : null}
    </svg>
  );
}
