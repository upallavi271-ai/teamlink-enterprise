// OWN-RESULT REPORTS (per-role spec 2026-10-03): a recruiter's "My Results"
// and a client's company report. Number cards for a date range, plus a CSV
// download when the login holds the report's export permission.
//   endpoint  GET /ats-reports/my-results  |  GET /portal/client/reports
import { useEffect, useState } from 'react';
import api from '../api';
import { downloadCsv } from '../utils/csv';

// fixed: { from, to } — a set period with no date inputs and no download of
// its own (My Results shows this month above the Daily report, which has the
// page's one date control and its downloads).
export default function OwnResults({
  endpoint, title, sub, mayExport = false, compact = false, fixed = null,
}) {
  const [from, setFrom] = useState(fixed ? fixed.from : '');
  const [to, setTo] = useState(fixed ? fixed.to : '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    const params = {};
    if (from) params.from = from;
    if (to) params.to = to;
    api.get(endpoint, { params })
      .then((res) => setData(res.data))
      .catch((e) => setError(e.response?.data?.error || 'The report could not be loaded.'));
  }, [endpoint, from, to]);

  const Head = compact ? 'h3' : 'h1';
  return (
    <div className="own-results">
      <div className="page-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <Head>{title}</Head>
          {sub && <div className="page-sub">{sub}{data ? ` · ${data.range}` : ''}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {!fixed && <label className="field" style={{ margin: 0 }}><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
          {!fixed && <label className="field" style={{ margin: 0 }}><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
          {!fixed && mayExport && data && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => downloadCsv(`${title.toLowerCase().replace(/\s+/g, '-')}.csv`, ['Metric', 'Value', 'Period'], data.cards.map((c) => [c.label, c.value, data.range]))}
            >
              Download CSV
            </button>
          )}
        </div>
      </div>
      {error && <div className="notice red">{error}</div>}
      {!data && !error && <div className="small-muted">Loading…</div>}
      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          {data.cards.map((c) => (
            <div key={c.key} className="card" style={{ padding: 14 }}>
              <div className="small-muted" style={{ fontSize: 12 }}>{c.label}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--navy)' }}>{c.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
