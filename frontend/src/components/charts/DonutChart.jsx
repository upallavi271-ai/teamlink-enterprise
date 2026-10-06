// DonutChart — part-to-whole, at most six slices (the rest fold into "Other").
//
//   <DonutChart data={[{ label, value, onClick?, tone? }]} centerLabel? centerValue?
//     valueFormat? empty? title? size? />
//
// Colours follow each slice's POSITION in the caller's list (fixed slots 1..6,
// "Other" grey) — or a status tone when `tone` is given. A 2px surface gap
// separates slices. The legend beside it names every slice with its value and
// share, so identity never rests on colour alone.
import {
  useChartBox, Tip, SrTable, ChartEmpty, markProps, slotVar, toneVar, defaultFormat, MAX_SLOTS,
} from './kit.jsx';

function arc(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(r1, a0);
  const [x1, y1] = p(r1, a1);
  const [x2, y2] = p(r0, a1);
  const [x3, y3] = p(r0, a0);
  return `M${x0},${y0}A${r1},${r1} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large} 0 ${x3},${y3}Z`;
}

export default function DonutChart({
  data = [], centerLabel, centerValue, valueFormat, empty, title, size = 168,
}) {
  const fmt = valueFormat || defaultFormat;
  const { ref, tip, show, hide } = useChartBox();
  let rows = (data || []).filter(Boolean).map((d, i) => ({ ...d, value: Number(d.value) || 0, color: toneVar(d.tone) || slotVar(i, d.label) }));
  if (rows.length > MAX_SLOTS) {
    const head = rows.slice(0, MAX_SLOTS - 1);
    const rest = rows.slice(MAX_SLOTS - 1);
    rows = [...head, { label: 'Other', value: rest.reduce((n, r) => n + r.value, 0), color: 'var(--tlk-other)', folded: rest.length }];
  }
  const total = rows.reduce((n, r) => n + r.value, 0);
  if (!rows.length || total <= 0) return <ChartEmpty text={empty} height={size} />;
  const cx = size / 2;
  const cy = size / 2;
  const r1 = size / 2 - 2;
  const r0 = r1 * 0.62;
  const share = (v) => `${Math.round((v / total) * 1000) / 10}%`;
  let a = 0;
  const shown = rows.filter((r) => r.value > 0);
  return (
    <div className="tlc tlk tlk-wrap tlk-donut" ref={ref}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="group" aria-label={title || 'Donut chart'}>
        {shown.length === 1 ? (
          <g className="tlk-mark" {...markProps({ onClick: shown[0].onClick, show, hide, content: { title: shown[0].label, rows: [{ value: fmt(shown[0].value), name: '100%', color: shown[0].color }] }, label: `${shown[0].label}: ${fmt(shown[0].value)}` })}>
            <circle cx={cx} cy={cy} r={(r0 + r1) / 2} fill="none" strokeWidth={r1 - r0} style={{ stroke: shown[0].color }} />
          </g>
        ) : shown.map((r) => {
          const a0 = a;
          const a1 = a + (r.value / total) * Math.PI * 2;
          a = a1;
          const content = { title: r.label, rows: [{ value: fmt(r.value), name: share(r.value), color: r.color }], hint: r.onClick ? 'Click to open the list' : null };
          return (
            <g key={r.label} className="tlk-mark" {...markProps({ onClick: r.onClick, show, hide, content, label: `${r.label}: ${fmt(r.value)} (${share(r.value)})` })}>
              <path d={arc(cx, cy, r0, r1, a0, a1)} className="tlk-slice" style={{ fill: r.color }} />
            </g>
          );
        })}
        {(centerValue !== undefined && centerValue !== null) && (
          <text x={cx} y={cy + (centerLabel ? 2 : 6)} textAnchor="middle" className="tlk-cval">{centerValue}</text>
        )}
        {centerLabel && <text x={cx} y={cy + 18} textAnchor="middle" className="tlk-clab">{centerLabel}</text>}
      </svg>
      <ul className="tlk-dlegend">
        {rows.map((r) => {
          const clickable = typeof r.onClick === 'function';
          const Tag = clickable ? 'button' : 'span';
          return (
            <li key={r.label}>
              <Tag type={clickable ? 'button' : undefined} className="tlk-dl-row" onClick={clickable ? r.onClick : undefined}>
                <i style={{ background: r.color }} />
                <span className="n">{r.label}</span>
                <b>{fmt(r.value)}</b>
                <span className="p">{share(r.value)}</span>
              </Tag>
            </li>
          );
        })}
      </ul>
      <Tip tip={tip} />
      <SrTable caption={title} headers={['Part', 'Count', 'Share']} rows={rows.map((r) => [r.label, fmt(r.value), share(r.value)])} />
    </div>
  );
}
