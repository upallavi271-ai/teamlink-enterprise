import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import EmptyState from '../../components/ui/EmptyState.jsx';
import './TeamReports.css';

// ---------------------------------------------------------------------------
// TEAM & PERSON REPORTS (ATS Reports -> "Team & person" tab; also the "Team-wise
// cash" view inside Accounts Reports).
//
// One screen for every report with a Team view and a Person view, the period
// buttons (Today / Yesterday / This week / This month / Last month / Custom),
// Total / Day by day / Week by week / Month by month columns, the cascading
// Department -> Team -> Person filters (counts shown), and two clear buttons:
// Download Excel and Download PDF. Both write EXACTLY the table drawn here (same
// filters, period and view) with a title, the filters used, who made it and when.
//
// Everything is the server's: what a login may open, which rows it gets and
// whether it may download (GET /api/ats-report-pack/*). Hidden here != allowed;
// the server refuses the rest.
// ---------------------------------------------------------------------------
const FAMILIES = [
  ['activity', 'Daily numbers'], ['apps', 'Progress & sources'], ['money', 'Cash'],
];
const fmt = (v, type) => {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'money') return `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;
  if (type === 'pct') return `${v}%`;
  if (typeof v === 'number') return v.toLocaleString('en-IN');
  return v;
};

async function download(url, params, fallback) {
  try {
    const res = await api.get(url, { params, responseType: 'blob' });
    const cd = res.headers['content-disposition'] || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallback;
    const href = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    return { ok: name };
  } catch (err) {
    const blob = err.response?.data;
    if (blob && typeof blob.text === 'function') {
      try { return { error: JSON.parse(await blob.text()).error || 'Download failed' }; } catch { /* not JSON */ }
    }
    return { error: 'Download failed — please try again.' };
  }
}

export default function TeamReports({ fixedReport = '', embedded = false }) {
  const [meta, setMeta] = useState(null);
  const [report, setReport] = useState(fixedReport || 'summary');
  const [view, setView] = useState('team');
  const [range, setRange] = useState('this_month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [group, setGroup] = useState('total');
  const [filters, setFilters] = useState({ department: '', team: '', person: '', people: '' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [said, setSaid] = useState('');
  const [trail, setTrail] = useState(null); // where "Back" returns after opening a person's own numbers
  const seq = useRef(0);

  useEffect(() => {
    api.get('/ats-report-pack/meta').then((r) => {
      setMeta(r.data);
      if (r.data.selfOnly || r.data.bde) setView('individual');
      if (fixedReport && !r.data.reports.some((x) => x.id === fixedReport)) setError('This report is not part of your role.');
      else if (!fixedReport && !r.data.reports.some((x) => x.id === 'summary')) setReport(r.data.reports[0] ? r.data.reports[0].id : 'summary');
    }).catch((e) => setError(e.response?.data?.error || 'Could not open the reports.'));
  }, [fixedReport]);

  const rep = useMemo(() => (meta ? meta.reports.find((r) => r.id === report) : null), [meta, report]);
  const grouped = !!(rep && rep.grouped);
  const customOk = range !== 'custom' || (from && to && from <= to);

  const params = useMemo(() => {
    const p = { report, view, range, group: grouped ? group : 'total' };
    if (range === 'custom') { p.from = from; p.to = to; }
    Object.entries(filters).forEach(([k, v]) => { if (v) p[k] = v; });
    return p;
  }, [report, view, range, from, to, group, grouped, filters]);

  const load = useCallback(() => {
    if (!meta || !customOk || (error && !data && !meta.reports.length)) return;
    const mine = ++seq.current;
    setLoading(true);
    api.get('/ats-report-pack/report', { params })
      .then((r) => { if (mine === seq.current) { setData(r.data); setError(''); } })
      .catch((e) => { if (mine === seq.current) setError(e.response?.data?.error || 'Could not load this report — try again.'); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [meta, params, customOk]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);

  const setF = (patch) => setFilters((f) => {
    const next = { ...f, ...patch };
    if ('department' in patch && patch.department !== f.department) { next.team = ''; next.person = ''; }
    if ('team' in patch && patch.team !== f.team) next.person = '';
    return next;
  });
  const pickReport = (id) => { setReport(id); setTrail(null); const r = meta.reports.find((x) => x.id === id); if (r && !r.grouped) setGroup('total'); else if (r && r.grouped && group === 'total' && id !== 'cash') setGroup('day'); };

  async function get(kind, format) {
    setBusy(`${kind}${format || ''}`); setSaid('');
    const url = kind === 'report' ? '/ats-report-pack/export' : kind === 'all' ? '/ats-report-pack/export-all' : '/ats-report-pack/export-people';
    const res = await download(url, kind === 'report' ? { ...params, format } : params, 'report.xlsx');
    setBusy('');
    if (res.error) setError(res.error); else setSaid(`Saved ${res.ok}`);
  }
  async function email(kind) {
    setBusy('email'); setSaid('');
    try {
      const r = await api.post('/ats-report-pack/email', { ...params, kind });
      setSaid(`Sent to ${r.data.to}`);
    } catch (e) { setError(e.response?.data?.error || 'The e-mail was not sent.'); }
    setBusy('');
  }

  function open(row) {
    if (!data || !data.canDrill) return;
    setTrail({ report, view, group, filters });
    setReport('daily'); setGroup('day');
    if (view === 'team') setFilters((f) => ({ ...f, team: row.key, person: '' }));
    else { setView('individual'); setFilters((f) => ({ ...f, person: row.key })); }
  }
  function back() {
    if (!trail) return;
    setReport(trail.report); setView(trail.view); setGroup(trail.group); setFilters(trail.filters); setTrail(null);
  }

  if (error && !meta) return <div className="notice red">{error}</div>;
  if (!meta) return <div className="small-muted">Opening the reports…</div>;

  const list = meta.reports;
  const fam = rep ? rep.family : 'activity';
  const inFam = (f) => list.filter((r) => r.family === f);
  const showViewToggle = meta.views.length > 1 && !(rep && rep.clientWise);
  const opts = data ? data.options : null;
  const filterDefs = opts ? [
    ['department', 'Department', 'All departments', opts.departments],
    ['team', 'Team', 'All teams', opts.teams],
    ['person', 'Person', 'Everyone', opts.people],
    ['people', 'Still working?', 'Current and former', opts.status],
  ].filter(([k, , , o]) => (o || []).length > 1 || filters[k]) : [];
  const canFilter = !meta.selfOnly && !meta.bde && !(rep && rep.clientWise);

  return (
    <div className={`tpr${embedded ? ' embedded' : ''}`}>
      {!fixedReport && (
        <div className="tpr-fams" role="tablist" aria-label="Kinds of report">
          {FAMILIES.filter(([f]) => inFam(f).length || (f === 'apps' && list.some((r) => r.clientWise))).map(([f, label]) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={fam === f || (f === 'apps' && rep && rep.clientWise)}
              className={`tpr-fam${fam === f ? ' on' : ''}`}
              onClick={() => pickReport(inFam(f)[0].id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!fixedReport && inFam(fam).length > 1 && (
        <div className="tpr-chips" role="group" aria-label="Pick a report">
          {inFam(fam).map((r) => (
            <button key={r.id} type="button" className={`tpr-chip${r.id === report ? ' on' : ''}`} aria-pressed={r.id === report} onClick={() => pickReport(r.id)} title={r.help}>{r.label}</button>
          ))}
        </div>
      )}

      <div className="tpr-bar">
        {showViewToggle && (
          <span className="tpr-seg" role="group" aria-label="Team or person">
            {meta.views.map(([id, label]) => (
              <button key={id} type="button" className={view === id ? 'on' : ''} aria-pressed={view === id} onClick={() => { setView(id); setTrail(null); }}>{label}</button>
            ))}
          </span>
        )}
        <span className="tpr-seg" role="group" aria-label="Period">
          {meta.periods.map((p) => (
            <button key={p.id} type="button" className={range === p.id ? 'on' : ''} aria-pressed={range === p.id} onClick={() => setRange(p.id)}>{p.label}</button>
          ))}
        </span>
        {range === 'custom' && (
          <span className="tpr-dates">
            <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            {!customOk && <span className="small-muted">Pick both dates.</span>}
          </span>
        )}
        {grouped && (
          <span className="tpr-seg" role="group" aria-label="Columns">
            {meta.groups.filter((g) => !(g.id === 'total' && report === 'daily')).map((g) => (
              <button key={g.id} type="button" className={(group === g.id || (report === 'daily' && group === 'total' && g.id === 'day')) ? 'on' : ''} aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>{g.label}</button>
            ))}
          </span>
        )}
      </div>

      {canFilter && filterDefs.length > 0 && (
        <div className="tpr-filters">
          {filterDefs.map(([k, label, all, list2]) => (
            <label key={k} className="tpr-filter">
              <span>{label}</span>
              <select value={filters[k]} onChange={(e) => setF({ [k]: e.target.value })}>
                <option value="">{all}</option>
                {list2.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
              </select>
            </label>
          ))}
          {Object.values(filters).some(Boolean) && <button type="button" className="btn btn-sm" onClick={() => setFilters({ department: '', team: '', person: '', people: '' })}>Clear filters</button>}
        </div>
      )}

      <div className="tpr-actions">
        {trail && <button type="button" className="btn btn-sm" onClick={back}>← Back to the {trail.view === 'team' ? 'teams' : 'people'}</button>}
        {meta.canExport && (
          <>
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !data} onClick={() => get('report', 'xlsx')}>{busy === 'reportxlsx' ? 'Preparing…' : '⬇ Download Excel'}</button>
            <button type="button" className="btn btn-sm" disabled={!!busy || !data} onClick={() => get('report', 'pdf')}>{busy === 'reportpdf' ? 'Preparing…' : '⬇ Download PDF'}</button>
            {data && data.caps.emailConnected && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => email('report')}>{busy === 'email' ? 'Sending…' : '✉ Send to my email'}</button>}
          </>
        )}
        {meta.canExportAll && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => get('all')} title="One Excel file with a sheet for every report of this period">{busy === 'all' ? 'Preparing…' : '⬇ All my reports (one Excel file)'}</button>}
        {meta.canExportPeople && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => get('people')} title="One Excel file with one sheet for each person, to hand over">{busy === 'people' ? 'Preparing…' : '⬇ One sheet for each person'}</button>}
        {said && <span className="tpr-said" role="status">{said}</span>}
      </div>

      {error && <div className="notice red" role="alert">{error} <button type="button" className="btn btn-sm" onClick={() => { setError(''); load(); }}>Try again</button></div>}

      {data && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          <div className="tpr-title">
            <h3>{data.title}</h3>
            <span className="small-muted">
              {data.period.label}{data.groupLabel ? ` · ${data.groupLabel}` : ''} · Your area: <b>{data.scope}</b>
            </span>
          </div>
          <div className="tbl-wrap tpr-table">
            <table>
              <thead>
                <tr>{data.columns.map((c) => <th key={c.key} className={c.type !== 'text' ? 'num' : undefined}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.key}>
                    {data.columns.map((c, i) => (
                      <td key={c.key} className={c.type !== 'text' ? 'num' : undefined}>
                        {i === 0 && data.canDrill
                          ? <button type="button" className="link-btn" onClick={() => open(r)} title="Open the day-by-day numbers">{r.c[0]}</button>
                          : fmt(r.c[i], c.type)}
                      </td>
                    ))}
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr><td colSpan={data.columns.length} style={{ padding: 0 }}>
                    <EmptyState
                      compact
                      title={data.family === 'money' ? 'No money data yet for these filters.' : 'Nothing here for these filters.'}
                      hint={data.family === 'money' ? 'Cash shows once invoices are raised for placements.' : 'Try another period, or clear a filter.'}
                    />
                  </td></tr>
                )}
              </tbody>
              {data.total && data.rows.length > 0 && (
                <tfoot>
                  <tr className="report-total">
                    {data.columns.map((c, i) => <td key={c.key} className={c.type !== 'text' ? 'num' : undefined}><b>{i === 0 ? 'Total' : fmt(data.total[i], c.type)}</b></td>)}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {(data.notes || []).map((n) => <div key={n} className="tpr-note">{n}</div>)}
          <div className="tpr-note">Made by {data.generatedBy} on {data.generatedAt}. The Excel and PDF files carry exactly this table.</div>
        </div>
      )}
      {!data && !error && <div className="small-muted">Loading the report…</div>}
    </div>
  );
}
