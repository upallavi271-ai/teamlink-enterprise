import {
  BarChart, GroupedBarChart, FunnelChart, DonutChart, LineChart,
} from '../../components/charts';

// ---------------------------------------------------------------------------
// REPORT CHARTS (ATS layout v3 §5, 2026-10-03) — at most THREE charts per
// report, drawn from the report's OWN tables (the sections the server sent),
// so a bar and its row can never disagree: one number, one meaning.
//
// Every bar / slice / point opens the list behind it, in place — the same
// drill-down a blue number in the table opens (GET /ats-reports/:tab/drill
// with section / row / col). A value that is not a count (days, ₹) opens the
// people / invoices it was measured from (`drill`).
//
// Kinds: bar (one series), grouped (2–4 series), donut (part of a whole),
// line (over time), funnel (steps). Charts come from the shared kit
// (components/charts) — none is drawn here.
// ---------------------------------------------------------------------------
const inr = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;
const days = (v) => `${Number(v).toLocaleString('en-IN')} d`;

export const REPORT_CHARTS = {
  // 1. Client-wise requirements & joinings.
  clients: [{
    kind: 'grouped', section: 'clients', title: 'Jobs and joinings, by client', top: 10, sortBy: 'requirements',
    series: [['requirements', 'Jobs'], ['joined', 'Joined']],
  }],
  // 2. Department-wise performance.
  departments: [{
    kind: 'grouped', section: 'departments', title: 'Department performance', skip: ['—'],
    series: [['openReqs', 'Open jobs'], ['shared', 'Sent to client'], ['interviews', 'Interviews'], ['joined', 'Joined']],
  }],
  funnel: [{ kind: 'funnel', section: 'funnel', col: 'count', title: 'From applied to joined' }],
  // 3. Recruiter & BDE performance (the tables stay below the bars).
  recruiters: [
    {
      kind: 'grouped', section: 'recruiters', title: 'Recruiters — sent, interviews, joined', top: 10, sortBy: 'joined', skip: ['—'],
      series: [['shared', 'Sent to client'], ['interviews', 'Interviews'], ['joined', 'Joined']],
    },
    {
      kind: 'grouped', section: 'bdes', title: 'Client managers (BDE) — sent, interviews, joined', top: 10, sortBy: 'joined', skip: ['—'],
      series: [['shared', 'Sent to client'], ['interviews', 'Interviews'], ['joined', 'Joined']],
      empty: 'No job has a client manager (BDE) yet. Set the BDE on the client or the job.',
    },
  ],
  // 4. Rejection analysis — whose decision (donut) and why (bars).
  rejections: [
    { kind: 'donut', section: 'sides', col: 'count', title: 'Who rejected', center: 'Rejected', tones: { 'Not recorded': 'grey' } },
    { kind: 'bar', section: 'reasons', col: 'count', title: 'Top reasons', top: 10, horizontal: true, tone: 'red' },
  ],
  // 5. Time to hire (line over months + bar by department) …
  timetofill: [
    { kind: 'line', section: 'ttfMonth', col: 'median', drill: 'joined', title: 'Usual days to hire, month by month', last: 12, format: days },
    { kind: 'bar', section: 'ttfDept', col: 'median', drill: 'joined', title: 'Usual days to hire, by department', horizontal: true, format: days, skip: ['—'] },
  ],
  // … and the time spent in each step.
  sla: [
    { kind: 'bar', section: 'transitions', col: 'avg', drill: 'samples', title: 'Average days in each step', horizontal: true, format: days, tone: 'blue' },
    { kind: 'bar', section: 'sla', col: 'overdue', title: 'Late now, by who it waits on', horizontal: true, tone: 'red' },
  ],
  // 6. Source-wise candidates.
  sources: [
    { kind: 'donut', section: 'channels', col: 'people', title: 'Candidates by source', center: 'Candidates' },
    { kind: 'bar', section: 'channels', col: 'joined', title: 'Joined, by source', horizontal: true, tone: 'green' },
  ],
  quality: [{ kind: 'bar', section: 'quality', col: 'joined', title: 'People who joined, by source', top: 10, horizontal: true, tone: 'green' }],
  // ATS-100 B6.3
  campaigns: [{ kind: 'bar', section: 'campaigns', col: 'applied', title: 'Applications, by campaign', top: 10, horizontal: true, tone: 'blue' }, { kind: 'bar', section: 'campaigns', col: 'joined', title: 'People who joined, by campaign', top: 10, horizontal: true, tone: 'green' }],
  recruitment: [{ kind: 'bar', section: 'recruitment', col: 'applications', title: 'Applications by group', top: 8, horizontal: true }],
  // 7. Revenue (Super Admin / Admin / Accountant only — the server refuses
  // everyone else before any of this is drawn).
  revenue: [
    { kind: 'line', section: 'revenueMonths', col: 'invoiced', title: 'Invoiced per month (before GST)', last: 24, format: inr, skip: ['—'] },
    { kind: 'line', section: 'revenueMonths', col: 'received', title: 'Received per month', last: 24, format: inr, skip: ['—'] },
  ],
};

// A month with nothing in it is still a month on a line over time: the gaps
// between the first and last month (keys "YYYY-MM") are drawn as zero (a
// count) or skipped (days), with nothing to open. Not done across more than two years (an odd far-off date
// would flatten the line).
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fillMonths(rows, columns) {
  const keyed = rows.filter((r) => /^\d{4}-\d{2}$/.test(String(r.key)));
  if (keyed.length !== rows.length || rows.length < 2) return rows;
  const idx = (k) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
  const a = idx(rows[0].key);
  const b = idx(rows[rows.length - 1].key);
  if (b - a > 24) return rows;
  const have = new Map(rows.map((r) => [r.key, r]));
  const out = [];
  for (let m = a; m <= b; m += 1) {
    const k = `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
    out.push(have.get(k) || { key: k, gap: true, c: [`${MON[m % 12]} ${Math.floor(m / 12)}`, ...columns.slice(1).map((c) => (c.drill ? 0 : null))] });
  }
  return out;
}

function rowsOf(sec, spec) {
  let rows = sec.rows.filter((r) => !(spec.skip || []).includes(r.key));
  if (spec.kind === 'line') rows = fillMonths(rows, sec.columns);
  if (spec.sortBy) {
    const i = sec.columns.findIndex((c) => c.key === spec.sortBy);
    if (i >= 0) rows = [...rows].sort((a, b) => (Number(b.c[i]) || 0) - (Number(a.c[i]) || 0));
  }
  if (spec.last) rows = rows.slice(-spec.last);
  return rows;
}

function OneChart({ sec, spec, onDrill }) {
  const idx = (key) => sec.columns.findIndex((c) => c.key === key);
  const colOf = (key) => sec.columns[idx(key)];
  const label = (r) => String(r.c[0] ?? '—');
  // The list behind a mark: its own column when that is a count, else the
  // column it was measured from. No list behind a zero.
  const opener = (r, key) => {
    const dc = colOf(key && colOf(key) && colOf(key).drill ? key : (spec.drill || key));
    if (!dc || !dc.drill) return undefined;
    const n = Number(r.c[idx(dc.key)]) || 0;
    if (!n) return undefined;
    return () => onDrill(sec, r.key, dc, label(r));
  };
  const all = rowsOf(sec, spec);
  const fmt = spec.format;
  let body = null;
  let more = '';

  if (spec.kind === 'grouped') {
    let rows = all.filter((r) => spec.series.some(([k]) => Number(r.c[idx(k)]) > 0));
    if (spec.top && rows.length > spec.top) { more = `The ${spec.top} biggest of ${rows.length.toLocaleString('en-IN')}`; rows = rows.slice(0, spec.top); }
    const series = spec.series.filter(([k]) => idx(k) >= 0);
    body = (
      <GroupedBarChart
        title={spec.title}
        categories={rows.map(label)}
        series={series.map(([k, name]) => ({ name, values: rows.map((r) => Number(r.c[idx(k)]) || 0) }))}
        onClick={(ci, si) => { const f = opener(rows[ci], series[si][0]); if (f) f(); }}
        empty={spec.empty}
      />
    );
  } else {
    const i = idx(spec.col);
    if (i < 0) return null;
    let rows = all.filter((r) => r.c[i] !== null && r.c[i] !== undefined && (spec.kind === 'funnel' || spec.kind === 'line' || Number(r.c[i]) > 0));
    if (spec.kind === 'bar' && !spec.sortBy) rows = [...rows].sort((a, b) => (Number(b.c[i]) || 0) - (Number(a.c[i]) || 0));
    if (spec.top && rows.length > spec.top) { more = `The ${spec.top} biggest of ${rows.length.toLocaleString('en-IN')}`; rows = rows.slice(0, spec.top); }
    const data = rows.map((r) => ({
      label: label(r), value: Number(r.c[i]) || 0, onClick: opener(r, spec.col),
      tone: (spec.tones && spec.tones[label(r)]) || spec.tone,
    }));
    if (spec.kind === 'donut') {
      const total = data.reduce((n, d) => n + d.value, 0);
      body = <DonutChart title={spec.title} data={data} centerLabel={spec.center} centerValue={total ? total.toLocaleString('en-IN') : undefined} valueFormat={fmt} empty={spec.empty} />;
    } else if (spec.kind === 'line') {
      body = <LineChart title={spec.title} points={data.map(({ label: l, value, onClick }) => ({ label: l, value, onClick }))} valueFormat={fmt} empty={spec.empty} />;
    } else if (spec.kind === 'funnel') {
      body = <FunnelChart title={spec.title} steps={data.map(({ label: l, value, onClick }) => ({ label: l, value, onClick }))} valueFormat={fmt} empty={spec.empty} />;
    } else {
      body = <BarChart title={spec.title} data={data} horizontal={!!spec.horizontal} valueFormat={fmt} empty={spec.empty} />;
    }
  }
  return (
    <section className="card rch-card">
      <div className="rch-head">
        <h3>{spec.title}</h3>
        {more && <span className="small-muted">{more}</span>}
      </div>
      {body}
    </section>
  );
}

// The charts of one report (max 3). Nothing when the report has none.
export default function ReportCharts({ tab, data, onDrill }) {
  const specs = (REPORT_CHARTS[tab] || []).slice(0, 3);
  const drawn = specs
    .map((spec) => [spec, (data.sections || []).find((s) => s.id === spec.section)])
    .filter(([, sec]) => sec);
  if (!drawn.length) return null;
  return (
    <div className={`rch-grid${drawn.length === 1 ? ' one' : ''}`}>
      {drawn.map(([spec, sec]) => (
        <OneChart key={`${spec.section}-${spec.col || spec.series.map(([k]) => k).join('')}`} sec={sec} spec={spec} onDrill={onDrill} />
      ))}
      <div className="rch-tip">Click a bar, slice or point to see who is behind it.</div>
    </div>
  );
}
