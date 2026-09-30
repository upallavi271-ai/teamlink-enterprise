// ---------------------------------------------------------------------------
// THE SMALL CHART SET.
//
// No chart library. Everything here is a div with a width, which is all a
// ranked bar or a share meter has ever needed — and it means these render at
// the same speed as the table beside them and inherit the app's own tokens
// rather than a library's.
//
// There are four series colours and there is no fifth. They were validated
// against the six checks (lightness band, chroma floor, colour-vision
// separation, normal-vision separation, contrast against the surface); a
// fifth hue failed separation under deuteranopia, so anything past four
// series folds into "Other" rather than being given a colour a reader cannot
// reliably tell from the one next to it. `bucket()` below does that folding.
//
// Colour is never the only thing carrying meaning: every series is named in
// the legend and, on a BarList, beside its own bar.
// ---------------------------------------------------------------------------

// A number a person reads at a glance, not an accountant's figure.
export function compact(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(v);
}

// Keep the four biggest, add everything else together as Other. Sorted, so
// "biggest" means biggest and not "happened to be first in the query".
export function bucket(rows, keep = 4) {
  const sorted = [...rows].filter((r) => r && Number(r.value) > 0)
    .sort((a, b) => Number(b.value) - Number(a.value));
  if (sorted.length <= keep) return sorted;
  const rest = sorted.slice(keep).reduce((s, r) => s + Number(r.value), 0);
  return rest > 0
    ? [...sorted.slice(0, keep), { label: 'Other', value: rest, other: true }]
    : sorted.slice(0, keep);
}

const SERIES = ['s1', 's2', 's3', 's4'];
const cls = (i, row) => (row && row.other ? 's-other' : SERIES[i] || 's-other');

// ---------------------------------------------------------------------------
// A ranked list of bars. The form for "which of these is biggest", when the
// categories have names long enough that a vertical axis would truncate them.
// One series, so no legend — the title says what it is.
// ---------------------------------------------------------------------------
export function BarList({ rows, max, format = compact, mono = true, empty = 'Nothing yet' }) {
  const data = [...(rows || [])].filter((r) => r);
  if (!data.length) return <div className="empty-mini">{empty}</div>;
  // Scale to the biggest bar, not to the total: this compares items with each
  // other, and scaling to the total would make every bar a sliver.
  const top = max || Math.max(...data.map((r) => Number(r.value) || 0), 1);
  return (
    <div className="barlist">
      {data.map((r, i) => (
        <div className="barrow" key={r.label ?? i} title={`${r.label}: ${r.value}`}>
          <div className="k">{r.label}</div>
          <div className="track">
            {/* A floor of 1.5% keeps a real-but-tiny value visible. It is
                never applied to a zero: a stub on an empty bucket reads as
                "a little bit", which is the opposite of what is true. */}
            {Number(r.value) > 0 && (
              <div
                className={`fill ${mono ? 's1' : cls(i, r)}`}
                style={{ width: `${Math.max(1.5, (Number(r.value) / top) * 100)}%` }}
              />
            )}
          </div>
          <div className="n">{format(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One bar, split by share. The form for "what is this made of" — and only
// worth using when the parts genuinely sum to a meaningful whole.
// ---------------------------------------------------------------------------
export function Meter({ rows, format = compact }) {
  const data = bucket(rows || []);
  const total = data.reduce((s, r) => s + Number(r.value), 0);
  if (!total) return <div className="empty-mini">Nothing yet</div>;
  return (
    <>
      <div className="meter">
        {data.map((r, i) => (
          <span
            key={r.label}
            className={cls(i, r)}
            style={{ width: `${(Number(r.value) / total) * 100}%` }}
            title={`${r.label}: ${r.value}`}
          />
        ))}
      </div>
      <Legend rows={data} format={format} total={total} />
    </>
  );
}

// Two or more series always get one of these.
export function Legend({ rows, format = compact, total }) {
  return (
    <div className="legend">
      {(rows || []).map((r, i) => (
        <span key={r.label}>
          <i className={cls(i, r)} />
          {r.label}
          {' '}
          <b style={{ color: 'var(--ink)' }}>{format(r.value)}</b>
          {total ? ` · ${Math.round((Number(r.value) / total) * 100)}%` : ''}
        </span>
      ))}
    </div>
  );
}

// The frame the three above sit in, so every chart on a page lines up.
export function Chart({ title, sub, children, right }) {
  return (
    <div className="chart">
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

export default Chart;
