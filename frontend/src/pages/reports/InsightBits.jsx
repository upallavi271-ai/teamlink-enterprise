import api from '../../api';
import { BarChart, LineChart, DonutChart } from '../../components/charts';
import { downloadFile, errText } from './ExperienceBits.jsx';

// ---------------------------------------------------------------------------
// Shared pieces of the ATS insight reports and dashboard cards (backend routes/atsInsights.js).
// ---------------------------------------------------------------------------
export { errText };
export const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
export const inr = (n) => (n === null || n === undefined ? '—' : `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`);
export const dayText = (iso) => (iso ? new Date(String(iso).length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// Excel / CSV of a GET report (?format=).
export function DownloadButtons({ url, params = {}, name, onError, show = true }) {
  if (!show) return null;
  const go = async (format) => { const m = await downloadFile(url, { ...params, format }, `${name}.${format}`); if (m && onError) onError(m); };
  return (
    <span className="ins-dl">
      <button type="button" className="btn btn-sm" onClick={() => go('xlsx')}>Excel</button>
      <button type="button" className="btn btn-sm" onClick={() => go('csv')}>CSV</button>
    </span>
  );
}

// A POST download (the report builder).
export async function postDownload(url, body, fallback) {
  try {
    const res = await api.post(url, body, { responseType: 'blob' });
    const cd = res.headers['content-disposition'] || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallback;
    const href = URL.createObjectURL(res.data);
    const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    return '';
  } catch (e) {
    if (e && e.response && e.response.data instanceof Blob) {
      try { const t = JSON.parse(await e.response.data.text()); return t.error || 'Could not download the file.'; } catch { /* plain */ }
    }
    return 'Could not download the file.';
  }
}

// One plain table. cols: [[label, (row) => value, { num }]]
export function Table({ cols, rows, empty = 'Nothing to show yet.', keyOf = (r, i) => r.id || r.key || i, max = 0 }) {
  const list = max ? (rows || []).slice(0, max) : (rows || []);
  return (
    <div className="tbl-wrap">
      <table>
        <thead><tr>{cols.map(([l, , o]) => <th key={l} className={o && o.num ? 'num' : undefined}>{l}</th>)}</tr></thead>
        <tbody>
          {list.map((r, i) => <tr key={keyOf(r, i)}>{cols.map(([l, f, o]) => <td key={l} className={o && o.num ? 'num' : undefined}>{f(r)}</td>)}</tr>)}
          {!list.length && <tr><td colSpan={cols.length} className="small-muted">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// The chart of a builder result (groups), or nothing for a table-only result.
export function ResultChart({ result, height = 240, max = 0 }) {
  if (!result || !result.groups || !result.groups.length || result.chart === 'table') return null;
  const data = (max && result.chart !== 'line' ? result.groups.slice(0, max) : result.groups).map((g) => ({ label: String(g.label), value: g.value }));
  if (result.chart === 'line') return <LineChart points={data} height={height} title={result.title} />;
  if (result.chart === 'donut') return <DonutChart data={data} title={result.title} />;
  const long = data.length > 8 || data.some((d) => d.label.length > 14);
  return <BarChart data={data} horizontal={long} height={long ? Math.max(height, data.length * 26) : height} title={result.title} />;
}
// The rows of a builder result.
export function ResultTable({ result, max = 50 }) {
  if (!result) return null;
  if (result.groups) {
    return (
      <Table
        cols={[[result.groupBy.label, (g) => g.label], [result.measure.label, (g) => g.value, { num: true }], ...(result.measure.op !== 'count' ? [['Rows', (g) => g.count, { num: true }]] : [])]}
        rows={result.groups}
        keyOf={(g) => g.key}
      />
    );
  }
  return (
    <>
      <Table cols={result.columns.map((c, i) => [c.label, (r) => dash(r[i]), { num: c.type === 'num' }])} rows={result.rows} max={max} keyOf={(r, i) => i} empty="No rows match." />
      {result.rows.length > max && <div className="small-muted">Showing {max} of {result.total}. Download Excel for all of them.</div>}
    </>
  );
}
