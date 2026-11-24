import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './HrAuditChecks.css';

// ---------------------------------------------------------------------------
// HR AUDIT CHECKS (founder 2026-11-24, from the HR audit questionnaire).
// READ-ONLY. The page only asks GET /api/hr-audit/summary and GET /api/hr-audit/checks/:key (backend/src/routes/hrAudit.js,
// utils/hrAuditChecks.js). It lists what looks wrong in data TeamLink already keeps. No button here changes a record.
// HR and Admin with company-wide scope only: anybody else gets the server's 403 and sees the plain sentence below.
// ---------------------------------------------------------------------------

const GROUPS = ['People records', 'Access', 'Attendance and leave', 'Payroll', 'Process'];
const SEV_RANK = { High: 0, Medium: 1, Low: 2 };
const SHOW_ROWS = 200;

const num = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function Kpi({ label, value, hint }) {
  return (
    <div className="hra-kpi" title={hint || ''}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

async function download(key, title, format) {
  const res = await api.get(`/hr-audit/checks/${key}`, { params: { format }, responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `HR audit - ${title}.${format}`.replace(/[\\/:*?"<>|]+/g, '');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function DetailPanel({ check, onClose }) {
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let alive = true;
    setOut(null); setError('');
    api.get(`/hr-audit/checks/${check.key}`)
      .then((r) => { if (alive) setOut(r.data); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'This list could not be loaded.'); });
    return () => { alive = false; };
  }, [check.key]);
  async function save(format) {
    setBusy(format); setError('');
    try { await download(check.key, check.title, format); } catch (e) { setError('The file could not be made. Try again.'); }
    setBusy('');
  }
  const rows = out ? out.rows : [];
  return (
    <div className="hra-detail">
      <div className="hra-detail-head">
        <div className="small-muted">{check.why}</div>
        <div className="hra-detail-actions">
          <button type="button" className="btn btn-sm" disabled={!!busy || !rows.length} onClick={() => save('xlsx')}>{busy === 'xlsx' ? 'Making…' : 'Download Excel'}</button>
          <button type="button" className="btn btn-sm" disabled={!!busy || !rows.length} onClick={() => save('csv')}>{busy === 'csv' ? 'Making…' : 'Download CSV'}</button>
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
      {!out && !error && <div className="small-muted">Loading…</div>}
      {out && !rows.length && <div className="hra-clear">✓ Nothing found. This check is clear.</div>}
      {out && !!rows.length && (
        <div className="tbl-wrap tbl-fit">
          <table>
            <thead><tr><th>Name</th><th>Code</th><th>Department</th><th>Designation</th><th>What is wrong</th></tr></thead>
            <tbody>
              {rows.slice(0, SHOW_ROWS).map((r, i) => (
                <tr key={`${r.employeeId || r.name}-${i}`}>
                  <td>{r.employeeId ? <Link to={`/employees/${r.employeeId}`}>{r.name}</Link> : r.name}</td>
                  <td>{r.code || '—'}</td>
                  <td>{r.department || '—'}</td>
                  <td>{r.designation || '—'}</td>
                  <td>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > SHOW_ROWS && <div className="small-muted" style={{ padding: 8 }}>Showing the first {SHOW_ROWS} of {rows.length}. Download the Excel for all of them.</div>}
        </div>
      )}
    </div>
  );
}

export default function HrAuditChecks() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null);
  const [onlyFindings, setOnlyFindings] = useState(false);
  const [sev, setSev] = useState('All');

  function load(refresh) {
    setLoading(true); setError('');
    api.get('/hr-audit/summary', { params: refresh ? { refresh: 1 } : {} })
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.status === 403 ? 'The HR audit checks are for HR and Admin only.' : (e.response?.data?.error || 'The checks could not be loaded. Try again in a minute.')))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(false); }, []);

  const grouped = useMemo(() => {
    const list = (data ? data.checks : []).filter((c) => (sev === 'All' || c.severity === sev) && (!onlyFindings || c.count > 0));
    return GROUPS.map((g) => ({ name: g, items: list.filter((c) => c.group === g).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]) })).filter((g) => g.items.length);
  }, [data, sev, onlyFindings]);

  const k = data && data.kpis;
  const flagged = data ? data.checks.filter((c) => c.count > 0).length : 0;

  return (
    <div className="hra">
      <div className="page-head">
        <div>
          <h1>HR audit checks</h1>
          <div className="page-sub">Read-only. Lists what looks wrong in the data TeamLink already keeps, so HR can check it. Nothing on this page changes any record.</div>
        </div>
        <div className="hra-head-actions">
          {data && <span className="small-muted">Worked out {when(data.generatedAt)}</span>}
          <button type="button" className="btn btn-sm" onClick={() => load(true)} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</button>
        </div>
      </div>

      {error && <div className="error-text" role="alert">{error}</div>}
      {loading && !data && !error && <div className="small-muted">Working out the checks…</div>}

      {data && (
        <>
          <h2 className="hra-h2">Headline HR numbers</h2>
          {data.kpiError && <div className="error-text">{data.kpiError}</div>}
          {k && (
            <>
              <div className="hra-kpis">
                <Kpi label="People working now" value={num(k.headcount)} />
                <Kpi label="Joined, last 30 days" value={num(k.joinedLast30)} hint={`Last 90 days: ${k.joinedLast90}`} />
                <Kpi label="Left, last 30 days" value={num(k.leftLast30)} hint={`Last 90 days: ${k.leftLast90}`} />
                <Kpi label="Left, last 12 months" value={num(k.leftLast12Months)} />
                <Kpi label="Attrition, last 12 months" value={num(k.attritionPct12m, '%')} hint="People who left in the last 12 months divided by the average headcount." />
                <Kpi label="Retention, last 12 months" value={num(k.retentionPct12m, '%')} hint="Of the people who were here 12 months ago, the share still here." />
                <Kpi label="Left within 90 days of joining" value={num(k.earlyLeaversLast12m)} hint="Early leavers in the last 12 months." />
                <Kpi label="Absenteeism, last 30 days" value={num(k.absenteeismPct30d, '%')} hint="Absent days (not on leave) divided by the working days that count." />
                <Kpi label="Average time here (years)" value={num(k.avgTenureYears)} />
              </div>
              <div className="small-muted hra-note">{k.notes}{k.leaversWithoutLastDay ? ` ${k.leaversWithoutLastDay} people who left have no last working day recorded and are not in the leaver numbers.` : ''}</div>
              {!!(k.departments && k.departments.length) && (
                <div className="tbl-wrap tbl-fit hra-dept">
                  <table>
                    <thead><tr><th>Departments with people leaving (last 12 months)</th><th>Left</th><th>Working now</th><th>Turnover</th></tr></thead>
                    <tbody>{k.departments.map((d) => <tr key={d.name}><td>{d.name}</td><td>{d.left}</td><td>{d.headcount}</td><td>{d.turnoverPct}%</td></tr>)}</tbody>
                  </table>
                </div>
              )}
            </>
          )}

          <h2 className="hra-h2">Checks <span className="small-muted">({flagged} of {data.checks.length} have something to look at)</span></h2>
          <div className="hra-filters" role="group" aria-label="Filter the checks">
            {['All', 'High', 'Medium', 'Low'].map((s) => (
              <button key={s} type="button" className={`hra-chip${sev === s ? ' on' : ''}`} onClick={() => setSev(s)}>{s === 'All' ? 'All risks' : `${s} risk`}</button>
            ))}
            <label className="hra-only"><input type="checkbox" checked={onlyFindings} onChange={(e) => setOnlyFindings(e.target.checked)} /> Only checks with something found</label>
          </div>

          {grouped.map((g) => (
            <div key={g.name} className="hra-group">
              <h3>{g.name}</h3>
              {g.items.map((c) => {
                const isOpen = open === c.key;
                const tone = c.count === null ? 'err' : c.count === 0 ? 'ok' : c.severity === 'High' ? 'high' : c.severity === 'Medium' ? 'med' : 'low';
                return (
                  <div key={c.key} className={`hra-check${isOpen ? ' open' : ''}`}>
                    <button type="button" className="hra-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : c.key)}>
                      <span className={`hra-sev hra-sev-${c.severity.toLowerCase()}`}>{c.severity}</span>
                      <span className="hra-title">{c.title}</span>
                      <span className="hra-q small-muted">Questions {c.questions.join(', ')}</span>
                      <span className={`hra-count hra-count-${tone}`}>{c.count === null ? 'Could not check' : c.count === 0 ? 'Clear' : c.count}</span>
                    </button>
                    {isOpen && <DetailPanel check={c} onClose={() => setOpen(null)} />}
                  </div>
                );
              })}
            </div>
          ))}
          {!grouped.length && <div className="small-muted">No check matches this filter.</div>}
        </>
      )}
    </div>
  );
}
