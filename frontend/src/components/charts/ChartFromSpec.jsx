// One chart from the spec routes/insights.js sends:
//   { id, kind: 'bar' | 'stacked' | 'trend', title, sub, unit, series, rows }
// The table view is built from the SAME rows the chart draws.
import ChartCard, { DataTable } from './ChartCard.jsx';
import BarChart from './BarChart.jsx';
import StackedBarChart from './StackedBarChart.jsx';
import TrendChart from './TrendChart.jsx';
import { fullValue } from './format.js';

function isEmpty(spec) {
  const rows = spec.rows || [];
  if (!rows.length) return true;
  if (spec.kind === 'bar') return rows.every((r) => !Number(r.value));
  return rows.every((r) => (r.values || []).every((v) => !Number(v)));
}

function tableOf(spec) {
  const u = spec.unit;
  if (spec.kind === 'bar') {
    return <DataTable headers={['Category', 'Value']} numeric={[1]} rows={spec.rows.map((r) => [r.label, fullValue(r.value, u)])} />;
  }
  const series = spec.series || [];
  const withTotal = spec.kind === 'stacked';
  const headers = [spec.kind === 'trend' ? 'Period' : 'Category', ...series, ...(withTotal ? ['Total'] : [])];
  const numeric = headers.map((_, i) => i).filter((i) => i > 0);
  return (
    <DataTable
      headers={headers}
      numeric={numeric}
      rows={spec.rows.map((r) => [
        r.label,
        ...r.values.map((v) => fullValue(v, u)),
        ...(withTotal ? [fullValue(r.values.reduce((s, v) => s + (Number(v) || 0), 0), u)] : []),
      ])}
    />
  );
}

export default function ChartFromSpec({ spec, busy, empty }) {
  const blank = isEmpty(spec);
  return (
    <ChartCard
      title={spec.title}
      sub={spec.sub}
      busy={busy}
      isEmpty={blank}
      empty={empty || spec.empty || 'Nothing recorded for this range and scope.'}
      table={blank ? null : tableOf(spec)}
    >
      {spec.kind === 'bar' && <BarChart rows={spec.rows} unit={spec.unit} />}
      {spec.kind === 'stacked' && <StackedBarChart series={spec.series} rows={spec.rows} unit={spec.unit} />}
      {spec.kind === 'trend' && <TrendChart series={spec.series} rows={spec.rows} unit={spec.unit} />}
    </ChartCard>
  );
}
