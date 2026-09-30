import { useEffect, useState } from 'react';
import api from '../../api';
import Chart, { Meter } from '../../components/Chart.jsx';
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import FilterChips from '../../components/FilterChips.jsx';

const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

export default function JobPortalReports() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // Date range: candidates registered (synced in) between these dates — asked of the API.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    setError('');
    const params = {};
    if (from) params.from = from;
    if (to) params.to = to;
    api.get('/reports/job-portal', { params })
      .then((res) => setData(res.data))
      .catch((e) => setError(e.response?.data?.error || 'The report could not be loaded.'));
  }, [from, to]);

  if (!data) return error ? <div className="notice red"><span>{error}</span></div> : <div className="small-muted">Loading…</div>;
  const on = !!(from || to);
  const clearAll = () => { setFrom(''); setTo(''); };
  const chips = on ? [{ key: 'date', label: 'Registered', value: from && to ? `${dmy(from)} → ${dmy(to)}` : from ? `from ${dmy(from)}` : `to ${dmy(to)}`, onRemove: clearAll }] : [];
  const total = data.rows.reduce((s, r) => s + r.candidates, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Job Portal Reports</h1>
          <div className="page-sub">From the connected Job Portal (via integration)</div>
        </div>
      </div>

      {error && <div className="notice red"><span>{error}</span></div>}
      <MoreFilters
        onClearAll={on ? clearAll : undefined}
        primary={(
          <>
            <span className="small-muted">Registered between</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Registered from" />
            <span aria-hidden="true">→</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Registered to" />
          </>
        )}
      />
      <FilterChips filters={chips} onClearAll={on ? clearAll : undefined} />

      <div className="statbar">
        <Stat n={data.registrationsSynced} l="Registrations synced" />
        <Stat n={data.applicationsSynced} l="Applications synced" />
        <Stat n={data.fromNaukri} l="From Naukri" />
        <Stat n={data.fromLinkedIn} l="From LinkedIn" />
      </div>

      {/* Each candidate came from exactly one source, so the shares are a
          real whole. The table below is the same numbers, exactly. */}
      {data.rows.length > 0 && (
        <Chart title="Where candidates came from" sub="Share of everything synced">
          <Meter
            rows={data.rows.map((r) => ({ label: r.source, value: r.candidates }))}
            format={(v) => Number(v).toLocaleString("en-IN")}
          />
        </Chart>
      )}

      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Source</th><th>Candidates</th></tr></thead>
          <tbody>
            {data.rows.map((r) => <tr key={r.source}><td>{r.source}</td><td>{r.candidates}</td></tr>)}
            {on && total === 0 && (
              <tr>
                <td colSpan="2" className="small-muted">
                  No candidates registered in these dates. <button type="button" className="link-btn" onClick={clearAll}>Clear filters</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ n, l }) {
  return <div className="statitem"><div className="n">{n}</div><div className="l">{l}</div></div>;
}
