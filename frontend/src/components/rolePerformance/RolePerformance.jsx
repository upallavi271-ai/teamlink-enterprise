// ---------------------------------------------------------------------------
// HRMS -> Performance & Development -> Monthly Targets -> "Recruitment performance by role"
// (user spec 2026-10-13). Pick a Role and see everyone who works - or ever worked - in it; pick an
// employee and a month and see how many candidates they generated, how many were selected and how
// many actually joined. Read-only. Every number comes from /api/role-performance (the server counts,
// scopes and hides); this file only draws it. Numbers open the candidates behind them.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import Pager, { usePaged } from '../Pager.jsx';
import { Modal } from '../proto.jsx';
import './rp.css';

const errText = (e, fallback) => (e && e.response && e.response.data && e.response.data.error) || fallback;
const METRICS = [
  ['generated', 'Generated', 'Candidates generated'],
  ['submitted', 'Submitted / Processed', 'Submitted / Processed'],
  ['selected', 'Selected', 'Selected'],
  ['joined', 'Actual Joinings', 'Actual joinings'],
];
const thisMonth = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
const NA = <span className="rpf-na" title="Nothing was recorded for this month">Data not available</span>;

function periodParams(p) {
  if (p.kind === 'all') return { period: 'all' };
  if (p.kind === 'custom') return p.from && p.to ? { from: p.from, to: p.to } : { year: p.year };
  if (p.kind === 'month') return { month: p.month };
  return { year: p.year };
}
const num = (n) => (n === null || n === undefined ? NA : Number(n).toLocaleString('en-IN'));
const conv = (c) => (c === null || c === undefined ? NA : c === 'N/A' ? <span className="rpf-na">N/A</span> : `${c}`);

// ---- the records behind a number ----------------------------------------------------------
function DrillDialog({ spec, filters, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const ctl = new AbortController();
    setData(null); setError('');
    api.get('/role-performance/drill', { params: { ...filters, ...spec.params, page }, signal: ctl.signal })
      .then((r) => setData(r.data))
      .catch((e) => { if (!ctl.signal.aborted) setError(errText(e, 'Could not load the candidates.')); });
    return () => ctl.abort();
  }, [spec, filters, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  return (
    <Modal title={spec.title} onClose={onClose} wide footer={<button className="btn btn-sm" onClick={onClose}>Close</button>}>
      <div className="rpf">
        {error && <div className="rpf-error">{error}</div>}
        {!data && !error && <div className="rpf-empty">Loading...</div>}
        {data && (
          <>
            <p className="rpf-hint"><b>{data.total}</b> {data.total === 1 ? 'candidate' : 'candidates'}. {spec.note || ''} Each candidate is listed once.</p>
            {data.rows.length === 0 ? <div className="rpf-empty">No candidates here.</div> : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Candidate</th><th>Client</th><th>Requirement</th><th>Credited to</th><th>Generated on</th><th>Step now</th>
                      <th>Selected on</th><th>Joined on</th><th>Role / Department</th><th>Why credited</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={`${r.candidateId}-${i}`}>
                        <td><b>{r.candidate}</b><div className="rpf-sub">{r.candidateId.slice(-8)}</div></td>
                        <td>{r.client}</td><td>{r.job}</td>
                        <td>{r.employee}{r.employeeCode ? <div className="rpf-sub">{r.employeeCode}{r.employeeStatus ? ` · ${r.employeeStatus}` : ''}</div> : null}</td>
                        <td>{r.generationDate || <span className="rpf-na">date missing</span>}</td>
                        <td>{r.step}</td>
                        <td>{r.selectionDate || '—'}</td>
                        <td>{r.joiningDate || (spec.metric === 'joined' ? <span className="rpf-na">date missing</span> : '—')}</td>
                        <td>{r.role}<div className="rpf-sub">{r.department}</div></td>
                        <td className="rpf-sub">{r.creditBasis}<div>{r.seatBasis}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {pages > 1 && (
              <div className="rpf-pager">
                <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Back</button>
                <span>Page {page} of {pages}</span>
                <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---- how this is counted --------------------------------------------------------------------
function HowCounted({ report, options, onMode }) {
  const f = report && report.formulas;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!f) return null;
  const att = options && options.attribution;
  async function change(mode) {
    setBusy(true); setMsg('');
    try { await api.put('/role-performance/attribution', { mode }); setMsg('Saved.'); onMode(); } catch (e) { setMsg(errText(e, 'Could not save.')); } finally { setBusy(false); }
  }
  return (
    <div className="rpf-how">
      <h4>How this is counted</h4>
      <ul>
        <li>{f.generated}</li><li>{f.submitted}</li><li>{f.selected}</li><li>{f.joined}</li>
        <li><b>{f.conversion}</b></li><li><b>{f.average}</b></li>
        <li>{f.credit}</li><li>{f.role}</li><li>{f.missing}</li><li>{f.timezone}</li>
      </ul>
      {att && att.canChange && (
        <label className="rpf-credit">Who gets the credit for a selection or joining:
          <Combo value={att.mode} disabled={busy} onChange={(e) => change(e.target.value)}>
            {att.modes.map((m) => <option key={m.id} value={m.id}>{m.text}</option>)}
          </Combo>
          {msg && <span className="rpf-sub"> {msg}</span>}
        </label>
      )}
    </div>
  );
}

export default function RolePerformance() {
  const [filters, setFilters] = useState({ department: '', role: '', employee: '' });
  const [period, setPeriod] = useState({ kind: 'year', year: String(new Date().getFullYear()), month: thisMonth(), from: '', to: '' });
  const [options, setOptions] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState(null);
  const [how, setHow] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState({ key: 'month', dir: 'asc' });
  const optCtl = useRef(null);

  const query = useMemo(() => ({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), ...periodParams(period) }), [filters, period]);
  const qKey = JSON.stringify(query);

  // The cascading lists (server counts), refetched when a filter changes. A stale answer is cancelled.
  const loadOptions = useCallback(() => {
    if (optCtl.current) optCtl.current.abort();
    const ctl = new AbortController(); optCtl.current = ctl;
    api.get('/role-performance/options', { params: { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }, signal: ctl.signal })
      .then((r) => setOptions(r.data))
      .catch((e) => { if (!ctl.signal.aborted) setError(errText(e, 'Could not load the lists.')); });
  }, [filters]);
  useEffect(() => { const t = setTimeout(loadOptions, 150); return () => clearTimeout(t); }, [loadOptions]);

  // A pick that no longer exists in the narrowed lists goes back to "All" (role change -> employee All).
  useEffect(() => {
    if (!options) return;
    const has = (list, v, key) => !v || list.some((x) => String(x[key]) === String(v));
    setFilters((f) => {
      const next = { ...f };
      if (!has(options.departments, f.department, 'id')) next.department = '';
      if (!has(options.roles, f.role, 'id')) next.role = '';
      if (!has(options.employees, f.employee, 'value')) next.employee = '';
      return next.department === f.department && next.role === f.role && next.employee === f.employee ? f : next;
    });
  }, [options]);

  // The report: debounced, and every older request is cancelled, so quick changes never mix totals.
  useEffect(() => {
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      api.get('/role-performance/report', { params: query, signal: ctl.signal })
        .then((r) => { setReport(r.data); setError(''); setBusy(false); })
        .catch((e) => { if (!ctl.signal.aborted) { setError(errText(e, 'Could not load the performance numbers.')); setBusy(false); } });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [qKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setF = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const cards = report ? report.cards : null;
  const rows = useMemo(() => {
    if (!report) return [];
    const list = [...report.rows];
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (r) => (sort.key === 'conversion' ? (typeof r.conversion === 'number' ? r.conversion : -1) : r[sort.key]);
    if (sort.key !== 'month') {
      list.sort((a, b) => {
        const x = val(a); const y = val(b);
        if (x === y || (x == null && y == null)) return 0;
        if (x == null) return 1; if (y == null) return -1;
        return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
      });
    } else if (dir < 0) list.reverse();
    return list;
  }, [report, sort]);
  const page = usePaged(rows);
  const grouped = sort.key === 'month' && report && !query.employee;
  const monthly = useMemo(() => new Map(((cards && cards.monthly) || []).map((m) => [m.month, m])), [cards]);

  function head(key, label, title) {
    const on = sort.key === key;
    return (
      <th className="rpf-sort" title={title} onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))}>
        {label}{on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </th>
    );
  }
  const canDrill = report && report.viewer.drill;
  const open = (metric, r) => {
    const title = `${METRICS.find((m) => m[0] === metric)[1]} · ${r.monthLabel} · ${r.employee}${r.role && !r.noAssignment ? ` · ${r.role}` : ''}`;
    setDrill({ metric, title, params: { metric, month: r.month, employee: r.employeeKey, seat: r.roleId || '__none__' } });
  };
  const num2 = (metric, r) => {
    const v = r[metric];
    if (v === null || v === undefined) return NA;
    return canDrill && v > 0
      ? <button className="rpf-num" onClick={() => open(metric, r)} title="Open these candidates">{v}</button>
      : v;
  };
  async function exportXlsx() {
    setExporting(true);
    try {
      const res = await api.get('/role-performance/export', { params: query, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url; a.download = 'role-performance.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { setError(errText(e, 'Could not export.')); } finally { setExporting(false); }
  }
  const openMetric = (metric, extra = {}) => setDrill({
    metric, title: `${METRICS.find((m) => m[0] === metric)[1]}${extra.missing ? ' · date missing' : ''} · ${report.cards.period}`, params: { metric, ...extra },
    note: extra.missing ? 'These records qualify but have no usable date, so they are not in any month.' : '',
  });

  const periodLabel = report ? report.cards.period : '';
  const years = (options && options.years) || [String(new Date().getFullYear())];
  const opt = options || { departments: [], roles: [], employees: [] };
  const viewerLevel = report && report.viewer.level;

  return (
    <div className="rpf">
      <p className="rpf-lead">
        Pick a <b>Role</b> to see everyone who works in it now or worked in it before. Pick a person and a month to see how many
        candidates they <b>generated</b>, how many were <b>selected</b> and how many actually <b>joined</b>.
        {viewerLevel === 'self' ? ' You see your own numbers.' : ''}{viewerLevel === 'team' ? ' You see your team.' : ''}
        {viewerLevel === 'counts' ? ' You see the numbers; the candidate names are in ATS.' : ''}
      </p>
      <div className="rpf-bar">
        <label className="lph-facet"><span className="lph-facet-lbl">Department</span>
          <Combo value={filters.department} onChange={(e) => setF('department', e.target.value)}>
            <option value="">All departments</option>
            {opt.departments.map((d) => <option key={d.id} value={d.id}>{`${d.name} (${d.count})`}</option>)}
          </Combo>
        </label>
        <label className="lph-facet"><span className="lph-facet-lbl">Role</span>
          <Combo value={filters.role} onChange={(e) => setF('role', e.target.value)}>
            <option value="">All roles</option>
            {opt.roles.map((r) => <option key={r.id} value={r.id}>{`${r.label} (${r.count})`}</option>)}
          </Combo>
        </label>
        <label className="lph-facet rpf-wide"><span className="lph-facet-lbl">Employee</span>
          <Combo value={filters.employee} onChange={(e) => setF('employee', e.target.value)}>
            <option value="">{`All employees (${opt.employees.length})`}</option>
            {opt.employees.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
          </Combo>
        </label>
        <label className="lph-facet"><span className="lph-facet-lbl">Period</span>
          <Combo value={period.kind} onChange={(e) => setPeriod((p) => ({ ...p, kind: e.target.value }))}>
            <option value="year">A year</option>
            <option value="month">One month</option>
            <option value="custom">Between two dates</option>
            <option value="all">All available periods</option>
          </Combo>
        </label>
        {period.kind === 'year' && (
          <label className="lph-facet"><span className="lph-facet-lbl">Year</span>
            <Combo value={period.year} onChange={(e) => setPeriod((p) => ({ ...p, year: e.target.value }))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Combo>
          </label>
        )}
        {period.kind === 'month' && (
          <label className="lph-facet"><span className="lph-facet-lbl">Month</span>
            <input type="month" value={period.month} max={thisMonth()} onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, month: e.target.value }))} />
          </label>
        )}
        {period.kind === 'custom' && (
          <>
            <label className="lph-facet"><span className="lph-facet-lbl">From</span><input type="date" value={period.from} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} /></label>
            <label className="lph-facet"><span className="lph-facet-lbl">To</span><input type="date" value={period.to} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} /></label>
          </>
        )}
        <span className="rpf-grow" />
        <button className="btn btn-sm" onClick={() => setHow((x) => !x)}>{how ? 'Hide' : 'How this is counted'}</button>
        <button className="btn btn-sm" disabled={exporting || !report} onClick={exportXlsx}>{exporting ? 'Exporting...' : 'Export Excel'}</button>
      </div>
      {how && <HowCounted report={report} options={options} onMode={() => { loadOptions(); setPeriod((p) => ({ ...p })); }} />}
      {error && <div className="rpf-error">{error}</div>}
      {!report && !error && <div className="rpf-empty">Loading...</div>}
      {report && (
        <div className={busy ? 'rpf-busy' : ''}>
          <div className="rpf-cards">
            <div className="rpf-card"><b>{num(cards.employees)}</b><span>Employees</span></div>
            {METRICS.map(([k, , label]) => (
              <button key={k} className={`rpf-card${canDrill && cards[k] > 0 ? ' rpf-click' : ''}`} onClick={() => canDrill && cards[k] > 0 && openMetric(k)} title="Open these candidates">
                <b className={k === 'joined' ? 'green' : ''}>{num(cards[k])}</b><span>{label}</span>
              </button>
            ))}
            <div className="rpf-card" title={report.formulas.average}><b>{cards.averageMonthlyJoinings === null ? NA : cards.averageMonthlyJoinings}</b><span>Average joinings a month ({cards.monthsWithData} {cards.monthsWithData === 1 ? 'month' : 'months'} with data)</span></div>
          </div>
          <p className="rpf-hint">
            Period: <b>{periodLabel}</b>. Joinings per 100 generated: <b>{cards.conversion === null ? 'Data not available' : cards.conversion}</b>.
            {cards.employees === 0 ? ' ' : ''}
          </p>
          <div className="rpf-chips">
            {METRICS.map(([k, , label]) => (cards.missing[k] > 0 ? (
              <button key={k} className="rpf-chip" disabled={!canDrill} onClick={() => openMetric(k, { missing: 1 })}>
                {label.replace('Candidates generated', 'Generated')}, date missing: <b>{cards.missing[k]}</b>
              </button>
            ) : null))}
            {report.showUnattributed && (cards.unattributed.joined + cards.unattributed.selected + cards.unattributed.generated + cards.unattributed.missing > 0) && (
              <span className="rpf-chip rpf-chip-grey" title="No recruiter is written on these records, so they belong to nobody">
                Not credited to anyone in this period: generated {cards.unattributed.generated}, selected {cards.unattributed.selected}, joined {cards.unattributed.joined}
              </span>
            )}
          </div>
          {rows.length === 0 ? (
            <div className="rpf-empty">{report.message || 'No results for these filters'}</div>
          ) : (
            <>
              <div className="tbl-wrap">
                <table className="rpf-table">
                  <thead>
                    <tr>
                      {head('month', 'Month-Year')}{head('employee', 'Employee')}{head('employeeCode', 'Employee ID')}{head('status', 'Status')}
                      {head('department', 'Department')}{head('role', 'Role')}
                      {head('generated', 'Generated')}{head('submitted', 'Submitted / Processed')}{head('selected', 'Selected')}{head('joined', 'Actual Joinings')}
                      {head('conversion', 'Joinings per 100 generated', 'Actual Joinings / Candidates Generated x 100')}
                    </tr>
                  </thead>
                  <tbody>
                    {page.slice.map((r, i) => {
                      const prev = page.slice[i - 1];
                      const m = monthly.get(r.month);
                      const showGroup = grouped && m && (!prev || prev.month !== r.month);
                      return [
                        showGroup && (
                          <tr key={`g-${r.month}`} className="rpf-group">
                            <td colSpan={6}>{r.monthLabel} - all {m.employees} {m.employees === 1 ? 'employee' : 'employees'} together</td>
                            <td>{num(m.generated)}</td><td>{num(m.submitted)}</td><td>{num(m.selected)}</td><td>{num(m.joined)}</td><td>{conv(m.conversion)}</td>
                          </tr>
                        ),
                        <tr key={r.key}>
                          <td>{r.monthLabel}</td>
                          <td><b>{r.employee}</b></td>
                          <td>{r.employeeCode || <span className="rpf-sub">not linked</span>}</td>
                          <td><span className={`rpf-tag ${r.status === 'Active' ? 'green' : 'grey'}`} title={r.statusDetail}>{r.status}</span></td>
                          <td>{r.noAssignment ? '—' : r.department}</td>
                          <td>{r.noAssignment ? <span className="rpf-na">No assignment in this period</span> : r.role === 'History not available' ? <span className="rpf-na">History not available</span> : r.role}</td>
                          <td>{r.noAssignment ? '—' : num2('generated', r)}</td>
                          <td>{r.noAssignment ? '—' : num2('submitted', r)}</td>
                          <td>{r.noAssignment ? '—' : num2('selected', r)}</td>
                          <td>{r.noAssignment ? '—' : num2('joined', r)}</td>
                          <td>{r.noAssignment ? '—' : conv(r.conversion)}</td>
                        </tr>,
                      ];
                    })}
                  </tbody>
                </table>
              </div>
              <Pager page={page} noun="rows" />
            </>
          )}
        </div>
      )}
      {drill && <DrillDialog spec={drill} filters={query} onClose={() => setDrill(null)} />}
    </div>
  );
}
