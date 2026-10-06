// GroupedBarChart — two to six series side by side per category.
//
//   <GroupedBarChart categories={['Jan', …]} series={[{ name, values: [...] }]}
//     onClick?(catIndex, seriesIndex) height? valueFormat? empty? title? />
//
// A legend is always drawn (>= 2 series). Colours follow the series' position
// in the caller's list (fixed order, slots 1..6; a 7th+ or "Other" is grey).
// Hovering a category shows ONE tooltip with every series at that category;
// each bar is its own click target.
import {
  useChartBox, allWhole, Tip, SrTable, ChartEmpty, Legend, colPath, slotVar, ticksFor, defaultFormat, shortNum,
} from './kit.jsx';

export default function GroupedBarChart({
  categories = [], series = [], onClick, height = 240, valueFormat, empty, title,
}) {
  const fmt = valueFormat || defaultFormat;
  const { ref, width, tip, show, hide } = useChartBox();
  const ser = (series || []).filter(Boolean).map((s, si) => ({
    name: s.name, color: slotVar(si, s.name), values: (s.values || []).map((v) => Number(v) || 0),
  }));
  const cats = categories || [];
  const max = Math.max(0, ...ser.flatMap((s) => s.values));
  if (!cats.length || !ser.length || max <= 0) return <ChartEmpty text={empty} height={height} />;
  const ticks = ticksFor(max, 4, allWhole(ser.flatMap((s) => s.values)));
  const top = ticks[ticks.length - 1];
  const padL = 40;
  const padR = 8;
  const padT = 10;
  const padB = 30;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padT - padB;
  const band = plotW / cats.length;
  const gap = 2;
  const groupW = band * 0.72;
  const barW = Math.max(3, Math.min(24, (groupW - gap * (ser.length - 1)) / ser.length));
  const usedW = barW * ser.length + gap * (ser.length - 1);
  const y = (v) => padT + plotH - (v / top) * plotH;
  const maxChars = Math.max(3, Math.floor(band / 6.5));
  const tipFor = (ci) => ({
    title: String(cats[ci]),
    rows: ser.map((s) => ({ name: s.name, value: fmt(s.values[ci] || 0), color: s.color })),
    hint: onClick ? 'Click a bar to open the list' : null,
  });
  return (
    <div className="tlc tlk tlk-wrap" ref={ref}>
      <Legend items={ser} />
      {width > 0 ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={title || 'Grouped bar chart'}>
          <g className="tlk-grid">{ticks.map((t) => <line key={t} x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />)}</g>
          {ticks.map((t) => <text key={t} className="tlk-tick" x={padL - 6} y={y(t) + 3.5} textAnchor="end">{shortNum(t)}</text>)}
          <line className="tlk-base" x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} />
          {cats.map((c, ci) => {
            const x0 = padL + band * ci + (band - usedW) / 2;
            const lab = String(c);
            return (
              // eslint-disable-next-line react/no-array-index-key
              <g key={ci} onPointerMove={(e) => show(e, tipFor(ci))} onPointerLeave={hide}>
                <rect x={padL + band * ci} y={padT} width={band} height={plotH} fill="transparent" />
                {ser.map((s, si) => {
                  const v = s.values[ci] || 0;
                  const clickable = typeof onClick === 'function';
                  return (
                    <g
                      // eslint-disable-next-line react/no-array-index-key
                      key={si}
                      className="tlk-mark"
                      tabIndex={0}
                      role={clickable ? 'button' : 'img'}
                      aria-label={`${lab}, ${s.name}: ${fmt(v)}`}
                      style={clickable ? { cursor: 'pointer' } : undefined}
                      onFocus={(e) => show(e, tipFor(ci))}
                      onBlur={hide}
                      onClick={clickable ? () => onClick(ci, si) : undefined}
                      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(ci, si); } } : undefined}
                    >
                      <rect x={x0 + si * (barW + gap)} y={padT} width={barW + gap} height={plotH} fill="transparent" />
                      {v > 0 && <path className="tlk-bar" d={colPath(x0 + si * (barW + gap), y(v), barW, (v / top) * plotH)} style={{ fill: s.color }} />}
                    </g>
                  );
                })}
                <text className="tlk-tick tlk-xlab" x={padL + band * ci + band / 2} y={height - padB + 15} textAnchor="middle">
                  {lab.length > maxChars ? `${lab.slice(0, maxChars - 1)}…` : lab}
                </text>
              </g>
            );
          })}
        </svg>
      ) : <div style={{ height }} />}
      <Tip tip={tip} />
      <SrTable
        caption={title}
        headers={['Category', ...ser.map((s) => s.name)]}
        rows={cats.map((c, ci) => [String(c), ...ser.map((s) => fmt(s.values[ci] || 0))])}
      />
    </div>
  );
}
