import { useEffect, useState } from 'react';
import api from '../../api';
import { num } from './HistoryParts.jsx';

// ---------------------------------------------------------------------------
// The trend part of the people pages: a Day / Week / Month switch, the table, bars for one chosen number, and (recruiters / teams) the monthly
// target against what was achieved. The numbers come from the server (utils/atsHistoryPeople.js seriesOf / targetsFor); nothing is added up here.
// ---------------------------------------------------------------------------
const DEFAULT_COLS = [
  ['added', 'Profiles added'], ['sent', 'Sent to client'], ['interviews', 'Interviews'], ['selected', 'Selected'], ['offers', 'Offers'],
  ['joined', 'Joined (still working)'], ['dropped', 'Dropped'], ['followups', 'Follow-ups done'], ['calls', 'Calls made'],
];

export default function HistorySeries({
  series, grain, setGrain, targets, cols = DEFAULT_COLS,
}) {
  const COLS = cols; // the BDE page has its own columns
  const [metric, setMetric] = useState('sent');
  const [all, setAll] = useState(false);
  const rows = series.rows;
  const shown = all ? rows : rows.slice(0, 31);
  const bars = [...rows].reverse();
  const max = Math.max(1, ...bars.map((r) => r[metric] || 0));
  return (
    <div className="hx-sec">
      <div className="hx-bar">
        <h3 style={{ margin: 0 }}>Day, week and month wise</h3>
        <span style={{ flex: 1 }} />
        {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([k, l]) => (
          <button key={k} type="button" className={`btn btn-sm${grain === k ? ' btn-primary' : ''}`} onClick={() => setGrain(k)}>{l}</button>
        ))}
      </div>
      <div className="hx-muted" style={{ marginBottom: 6 }}>{series.from} to {series.to}. Use the From / To boxes above to change the range.</div>
      <div className="hx-bars" role="img" aria-label={`Bars of ${COLS.find(([k]) => k === metric)[1]}`}>
        {bars.map((r) => (
          <div className="hx-barcol" key={r.key} title={`${r.label}: ${r[metric]}`}>
            <span className="hx-barn">{r[metric] || ''}</span>
            <span className="hx-barfill" style={{ height: `${Math.round(((r[metric] || 0) / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="hx-filters" style={{ marginTop: 4 }}>
        <label>Show bars for
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>{COLS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
      </div>
      <div className="hx-scroll">
        <table className="hx-table" style={{ minWidth: 820 }}>
          <thead><tr><th>{grain === 'day' ? 'Day' : grain === 'week' ? 'Week' : 'Month'}</th>{COLS.map(([k, l]) => <th key={k} style={{ cursor: 'default' }}>{l}</th>)}</tr></thead>
          <tbody>
            {shown.map((r) => <tr key={r.key}><td>{r.label}</td>{COLS.map(([k]) => <td key={k}>{r[k] ? <b>{num(r[k])}</b> : <span className="hx-muted">0</span>}</td>)}</tr>)}
            <tr><td><b>Total</b></td>{COLS.map(([k]) => <td key={k}><b>{num(series.total[k])}</b></td>)}</tr>
          </tbody>
        </table>
      </div>
      {!all && rows.length > 31 && <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setAll(true)}>Show all {rows.length} rows</button>}
      {targets && targets.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h4 style={{ margin: '0 0 6px' }}>Target against achieved (joinings)</h4>
          <div className="hx-scroll"><table className="hx-table" style={{ minWidth: 380 }}>
            <thead><tr><th style={{ cursor: 'default' }}>Month</th><th style={{ cursor: 'default' }}>Target</th><th style={{ cursor: 'default' }}>Joined</th><th style={{ cursor: 'default' }}>Result</th></tr></thead>
            <tbody>{targets.map((t) => (
              <tr key={t.month}><td>{t.label}</td><td>{t.target === null ? '—' : t.target}</td><td><b>{t.achieved}</b></td>
                <td>{t.target === null ? '—' : t.achieved >= t.target ? <span className="hx-badge joined">Reached</span> : <span className="hx-badge inprocess">{t.target - t.achieved} short</span>}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}

// What a login may open, so a name links only where the page will open (the server decides again on every request).
let accessCache = null;
export function useHistoryAccess() {
  const [a, setA] = useState(accessCache);
  useEffect(() => {
    if (accessCache) return undefined;
    let live = true;
    api.get('/ats/history/access').then((r) => { accessCache = r.data; if (live) setA(r.data); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return a || { kind: 'none', peopleAll: false, peopleIds: [], tlIds: [], bdeIds: [], contact: false, billing: false };
}
export const mayOpenRecruiter = (a, id) => !!id && (a.peopleAll || (a.peopleIds || []).includes(id));
export const mayOpenTl = (a, id) => !!id && (a.peopleAll || (a.tlIds || []).includes(id));
export const mayOpenBde = (a, id) => !!id && (a.peopleAll || (a.bdeIds || []).includes(id));
