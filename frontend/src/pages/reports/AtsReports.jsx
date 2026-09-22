import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { downloadCsv } from '../../utils/csv.js';
import { canExportReports } from '../../permissions';
import Combo from '../../components/Combo.jsx';

// ---------------------------------------------------------------------------
// ATS REPORTS (§18).
//
// "specialization wise data kaavali antey yelaaga? team wise report, individual
//  report kaavali."
//
// ONE report, and "group by" is the question. The same scoped set of
// applications counted a different way, so a department total and the sum of
// its recruiters can never disagree — which is the whole reason this is one
// endpoint rather than eight.
//
// The filters STACK on the grouping, so "Medical department, this month, by
// recruiter" is one screen and not a special report. The filter dropdowns are
// built from what the CALLER can actually see, so they cannot offer a
// department or a person the report would then refuse.
// ---------------------------------------------------------------------------

// Each family counts different things, so each has its own columns. The
// grouping is the ROW; these are the numbers on it.
const COLUMNS_BY_FAMILY = {
  ats: [
    ['applications', 'Applications'], ['inPipeline', 'In Pipeline'],
    ['recruiterReview', 'Recruiter Review'], ['tlReview', 'TL Review'],
    ['bdeReview', 'BDE Review'], ['clientReview', 'Client Review'],
    ['interview', 'Interview'], ['selected', 'Selected'], ['offer', 'Offer'],
    ['joined', 'Joined'], ['rejected', 'Rejected'], ['hold', 'Hold'],
  ],
  interviews: [
    ['scheduled', 'Scheduled'], ['completed', 'Completed'],
    ['feedbackPending', 'Feedback Pending'], ['rescheduled', 'Rescheduled'],
    ['cancelled', 'Cancelled'], ['noShow', 'No Show'],
    ['selected', 'Selected'], ['rejected', 'Rejected'],
  ],
  followups: [
    ['total', 'Follow-ups'], ['due', 'Due Today'], ['overdue', 'Overdue'],
    ['completed', 'Completed'], ['escalated', 'Escalated'],
  ],
};

const EMPTY = {
  from: '', to: '', department: '', location: '', clientId: '',
  recruiterId: '', bdeId: '', source: '', stage: '',
};

export default function AtsReports() {
  const { user } = useAuth();
  const canExport = canExportReports(user, 'ATS Reports');
  // §18 — THREE REPORT FAMILIES, one screen. Recruitment is the pipeline,
  // Interviews is the calendar's outcomes (AI counted separately, never mixed
  // in), Follow-ups is whether the chasing is actually working.
  const [family, setFamily] = useState('ats');
  const [groupBy, setGroupBy] = useState('department');
  const [filters, setFilters] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const params = new URLSearchParams({ groupBy });
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    api.get(`/reports/${family === 'ats' ? 'ats' : family}?${params.toString()}`)
      .then((res) => { setData(res.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'ATS Reports are not included in your role’s permissions.'));
  }, [family, groupBy, filters]);
  useEffect(load, [load]);

  // Each family has its own groupings, so switching family resets to its first.
  function pickFamily(id) {
    setFamily(id);
    setGroupBy(id === 'followups' ? 'owner' : 'department');
  }

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const active = Object.values(filters).filter(Boolean).length;

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="small-muted">Loading reports…</div>;

  const opts = data.filterOptions || {};
  const COLUMNS = COLUMNS_BY_FAMILY[family];
  // Conversion only means something on the recruitment family.
  const showConversion = family === 'ats';

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>ATS Reports</h1>
          <div className="page-sub">
            <b className="scope-tag">Scope: {data.scope}</b>
            {' · '}Grouped by <b>{data.groupLabel}</b>
            {active ? ` · ${active} filter${active === 1 ? '' : 's'} applied` : ''}
          </div>
        </div>
        {canExport && (
          <button
            className="btn"
            onClick={() => downloadCsv(
              `ats-report-by-${data.groupBy}.csv`,
              [data.groupLabel, ...COLUMNS.map(([, l]) => l), 'Conversion %'],
              data.rows.map((r) => [r.group, ...COLUMNS.map(([k]) => r[k]), r.conversionPct]),
            )}
          >
            Export CSV
          </button>
        )}
      </div>

      {/* THE QUESTION. Department = specialization-wise, Team = team-wise,
          Recruiter / TL / STL / BDE = individual-wise. */}
      <div className="report-family">
        {[['ats', 'Recruitment'], ['interviews', 'Interviews'], ['followups', 'Follow-ups']].map(([id, label]) => (
          <button
            key={id}
            className={`report-fam${family === id ? ' is-on' : ''}`}
            onClick={() => pickFamily(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="report-groupby">
        {data.groupings.map((g) => (
          <button
            key={g.id}
            className={`report-tab${groupBy === g.id ? ' is-on' : ''}`}
            onClick={() => setGroupBy(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="filter-row" style={{ flexWrap: 'wrap' }}>
        {/* Dates apply to every family. The rest are offered only where the
            endpoint actually returns options for them — a filter that does
            nothing is worse than no filter. */}
        <label className="report-date">From <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="report-date">To <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></label>
        {opts.departments && (
          <Combo value={filters.department} onChange={(e) => set({ department: e.target.value })}>
            <option value="">All departments</option>
            {opts.departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </Combo>
        )}
        {opts.locations && (
          <Combo value={filters.location} onChange={(e) => set({ location: e.target.value })}>
            <option value="">All locations</option>
            {opts.locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </Combo>
        )}
        {opts.clients && (
          <Combo value={filters.clientId} onChange={(e) => set({ clientId: e.target.value })}>
            <option value="">All clients</option>
            {opts.clients.map((cl) => <option key={cl.id} value={cl.id}>{cl.name}</option>)}
          </Combo>
        )}
        {opts.recruiters && (
          <Combo value={filters.recruiterId} onChange={(e) => set({ recruiterId: e.target.value })}>
            <option value="">All recruiters</option>
            {opts.recruiters.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Combo>
        )}
        {opts.bdes && (
          <Combo value={filters.bdeId} onChange={(e) => set({ bdeId: e.target.value })}>
            <option value="">All BDEs</option>
            {opts.bdes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Combo>
        )}
        {opts.sources && (
          <Combo value={filters.source} onChange={(e) => set({ source: e.target.value })}>
            <option value="">All sources</option>
            {opts.sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </Combo>
        )}
        {opts.stages && (
          <Combo value={filters.stage} onChange={(e) => set({ stage: e.target.value })}>
            <option value="">All stages</option>
            {opts.stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Combo>
        )}
        {active > 0 && <button className="btn btn-sm" onClick={() => setFilters(EMPTY)}>Clear filters</button>}
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>{data.groupLabel}</th>
              {COLUMNS.map(([k, l]) => <th key={k} style={{ textAlign: 'right' }}>{l}</th>)}
              {showConversion && <th style={{ textAlign: 'right' }}>Conversion</th>}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.group}>
                <td><b>{r.group}</b></td>
                {COLUMNS.map(([k]) => (
                  <td key={k} className={r[k] ? undefined : 'cell-muted'} style={{ textAlign: 'right' }}>{r[k]}</td>
                ))}
                {showConversion && <td style={{ textAlign: 'right' }}>{r.conversionPct}%</td>}
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr><td colSpan={COLUMNS.length + 2} className="small-muted" style={{ padding: 16 }}>
                Nothing matches these filters inside your scope.
              </td></tr>
            )}
          </tbody>
          {data.rows.length > 0 && data.totals && (
            <tfoot>
              <tr className="report-total">
                <td><b>Total</b></td>
                {COLUMNS.map(([k]) => <td key={k} style={{ textAlign: 'right' }}><b>{data.totals[k] || 0}</b></td>)}
                {showConversion && <td style={{ textAlign: 'right' }}><b>{data.totals.conversionPct}%</b></td>}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="notice" style={{ marginTop: 12 }}>
        {family === 'ats' && <>Every grouping counts the SAME set of applications — the ones your scope reaches — so a department total and the sum of its recruiters always agree. Conversion is Joined ÷ Applications.</>}
        {family === 'interviews' && <>AI interviews are counted SEPARATELY ({data.aiInterviews ?? 0} in your scope) and are never mixed into client interview outcomes — an AI screening score is not an interview result.</>}
        {family === 'followups' && <>Overdue is measured against the date somebody committed to, not the stage SLA. Escalated counts follow-ups that have passed their owner; the owner stays responsible at every rung.</>}
      </div>
    </div>
  );
}
