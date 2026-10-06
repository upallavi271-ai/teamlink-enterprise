// FunnelChart — ordered steps as horizontal bars.
//
//   <FunnelChart steps={[{ label, value, onClick? }]} valueFormat? empty? title? />
//
// Each bar is scaled to the FIRST step; the row says "% of <first step>", and
// between two steps a small line says how many dropped ("▼ 120 dropped · 40%").
// One hue (slot 1): the steps are one series in order, not categories.
import {
  useChartBox, Tip, SrTable, ChartEmpty, markProps, defaultFormat,
} from './kit.jsx';

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export default function FunnelChart({ steps = [], valueFormat, empty, title }) {
  const fmt = valueFormat || defaultFormat;
  const { ref, tip, show, hide } = useChartBox();
  const rows = (steps || []).filter(Boolean).map((s) => ({ ...s, value: Number(s.value) || 0 }));
  const first = rows.length ? rows[0].value : 0;
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max <= 0) return <ChartEmpty text={empty} />;
  const base = first > 0 ? first : max;
  const firstLabel = rows[0].label;
  return (
    <div className="tlc tlk tlk-wrap tlk-funnelwrap" ref={ref}>
      <div className="tlk-funnel" role="group" aria-label={title || 'Funnel'}>
        {rows.map((r, i) => {
          const prev = i > 0 ? rows[i - 1].value : null;
          const drop = prev !== null ? Math.max(0, prev - r.value) : 0;
          const ofFirst = pct(r.value, base);
          const content = {
            title: r.label,
            rows: [
              { value: fmt(r.value), color: 'var(--tlk-s1)' },
              ...(i > 0 ? [{ value: `${ofFirst}%`, name: `of ${firstLabel}` }] : []),
            ],
            hint: r.onClick ? 'Click to open the list' : null,
          };
          return (
            <div key={`${r.label}-${i}`}>
              {i > 0 && (
                <div className="tlk-drop" aria-hidden="true">
                  {drop > 0 ? `▼ ${fmt(drop)} dropped · ${pct(drop, prev)}%` : '▼ none dropped'}
                </div>
              )}
              <div className="tlk-hbar tlk-mark" {...markProps({ onClick: r.onClick, show, hide, content, label: `${r.label}: ${fmt(r.value)}, ${ofFirst}% of ${firstLabel}` })}>
                <div className="lab" title={r.label}>{r.label}</div>
                <div className="trk">
                  {r.value > 0 && <div className="bar" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: 'var(--tlk-s1)' }} />}
                </div>
                <div className="val">
                  {fmt(r.value)}
                  {i > 0 && <span className="pct">{`${ofFirst}%`}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Tip tip={tip} />
      <SrTable
        caption={title}
        headers={['Step', 'Count', `% of ${firstLabel}`, 'Dropped from the step before']}
        rows={rows.map((r, i) => [r.label, fmt(r.value), `${pct(r.value, base)}%`, i ? fmt(Math.max(0, rows[i - 1].value - r.value)) : '—'])}
      />
    </div>
  );
}
