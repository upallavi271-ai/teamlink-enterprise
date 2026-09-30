import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini } from '../../components/proto.jsx';
import Combo from '../../components/Combo.jsx';
import { MonthlyBalance, MonthlyReport } from './LeaveExtras.jsx';
import './LeaveExtras.css';

// ---------------------------------------------------------------------------
// BALANCES — three views of the same scoped data:
//   One employee          month-by-month for the employee picked (searchable,
//                         scoped by the server; an employee sees only their own)
//   All employees · month  every employee's month-by-month taken, one table
//   All employees · now    every employee's current balance per leave type
// ---------------------------------------------------------------------------
function saveBlob(res, fallback) {
  const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || fallback;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function AllBalancesTable({ data, canExport, includeRelieved, onIncludeRelieved }) {
  const [f, setF] = useState({ q: '', department: '', team: '', status: '' });
  const [error, setError] = useState('');
  const rows = data?.rows || [];
  const types = data?.types || [];
  const departments = useMemo(() => [...new Set(rows.map((r) => r.department).filter(Boolean))].sort(), [rows]);
  const teams = useMemo(() => [...new Set(rows.filter((r) => !f.department || r.department === f.department).map((r) => r.team).filter(Boolean))].sort(), [rows, f.department]);
  const statuses = useMemo(() => [...new Set(rows.map((r) => r.employmentStatus || 'Active'))].sort(), [rows]);
  const shown = rows.filter((r) => (!f.q || `${r.employeeCode} ${r.name}`.toLowerCase().includes(f.q.toLowerCase()))
    && (!f.department || r.department === f.department) && (!f.team || (r.team || '') === f.team)
    && (!f.status || (r.employmentStatus || 'Active') === f.status));
  const set = (k, v) => setF((x) => ({ ...x, [k]: v, ...(k === 'department' ? { team: '' } : {}) }));
  async function exportXlsx() {
    setError('');
    try {
      const res = await api.get('/leave/balances', { params: { format: 'xlsx', includeRelieved: includeRelieved ? 1 : undefined, department: f.department || undefined, team: f.team || undefined, status: f.status || undefined }, responseType: 'blob' });
      saveBlob(res, 'leave-balances.xlsx');
    } catch { setError('Export is not included in your role’s permissions.'); }
  }
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="All employees — current leave balances">
        {canExport && <button className="btn btn-sm" onClick={exportXlsx}>Export Excel</button>}
      </PanelHead>
      <div className="filter-row" style={{ margin: '10px 18px' }}>
        <input placeholder="Employee ID or name" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <Combo value={f.department} onChange={(e) => set('department', e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d}>{d}</option>)}
        </Combo>
        <Combo value={f.team} onChange={(e) => set('team', e.target.value)}>
          <option value="">All teams</option>
          {teams.map((t) => <option key={t}>{t}</option>)}
        </Combo>
        <Combo value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          {statuses.map((s) => <option key={s}>{s}</option>)}
        </Combo>
        <label className="lvx-muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!includeRelieved} onChange={(e) => onIncludeRelieved(e.target.checked)} /> Include relieved employees
        </label>
        <span className="small-muted" style={{ alignSelf: 'center' }}>{shown.length} of {rows.length}</span>
      </div>
      {error && <div className="error-text" style={{ margin: '0 18px 8px' }}>{error}</div>}
      <div className="tbl-wrap lvx-table">
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>Code</th><th rowSpan={2}>Employee</th><th rowSpan={2}>Department</th><th rowSpan={2}>Team</th><th rowSpan={2}>Status</th>
              {types.map((t) => <th key={t.code} colSpan={4} style={{ textAlign: 'center' }} title={t.name}>{t.name}</th>)}
            </tr>
            <tr>
              {types.map((t) => ['Entitled', 'Taken', 'Pending', 'Balance'].map((h) => <th key={`${t.code}-${h}`} style={{ textAlign: 'right' }}>{h}</th>))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.employeeId}>
                <td><b>{r.employeeCode}</b></td><td>{r.name}</td>
                <td className="lvx-muted">{r.department || '—'}</td><td className="lvx-muted">{r.team || '—'}</td>
                <td className="lvx-muted">{r.employmentStatus || 'Active'}</td>
                {r.balances.map((b) => (b.total == null
                  ? <td key={b.code} colSpan={4} className="lvx-muted" style={{ textAlign: 'center' }}>—</td>
                  : [
                    <td key={`${b.code}-e`} style={{ textAlign: 'right' }}>{b.total}</td>,
                    <td key={`${b.code}-t`} style={{ textAlign: 'right' }}>{b.taken}</td>,
                    <td key={`${b.code}-p`} style={{ textAlign: 'right' }} className="lvx-muted">{b.pending || ''}</td>,
                    <td key={`${b.code}-b`} style={{ textAlign: 'right' }}><b>{b.remaining}</b></td>,
                  ]))}
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={5 + types.length * 4} className="small-muted" style={{ padding: 16 }}>No employees match.</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export default function LeaveBalancesTab({ canExport }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('one');
  const [allData, setAllData] = useState(null);
  const [includeRelieved, setIncludeRelieved] = useState(false);
  function load() {
    setError('');
    api.get('/leave/balances').then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load leave balances.'));
  }
  useEffect(load, []);
  // The all-employee table can include people who have left.
  useEffect(() => {
    if (view !== 'allNow') return;
    if (!includeRelieved) { setAllData(null); return; }
    api.get('/leave/balances', { params: { includeRelieved: 1 } }).then((r) => setAllData(r.data)).catch(() => setAllData(null));
  }, [view, includeRelieved]);
  // More than one person in scope → HR / TL / Manager / Super Admin: picker
  // and the all-employee views. An employee sees only their own.
  const many = (data?.rows || []).length > 1;
  if (error) return <Panel style={{ marginTop: 16 }}><div className="error-text" style={{ margin: 16 }}>{error} <button className="btn btn-sm" onClick={load}>Retry</button></div></Panel>;
  if (!data) return <Panel style={{ marginTop: 16 }}><EmptyMini>Loading…</EmptyMini></Panel>;
  return (
    <div>
      {many && (
        <div className="tabs" style={{ marginTop: 14 }}>
          <div className={`tab${view === 'one' ? ' active' : ''}`} onClick={() => setView('one')}>One employee — month-wise</div>
          <div className={`tab${view === 'allMonthly' ? ' active' : ''}`} onClick={() => setView('allMonthly')}>All employees — month-wise</div>
          <div className={`tab${view === 'allNow' ? ' active' : ''}`} onClick={() => setView('allNow')}>All employees — current balances</div>
        </div>
      )}
      {(!many || view === 'one') && <MonthlyBalance employees={many ? data.rows : null} />}
      {many && view === 'allMonthly' && <MonthlyReport canExport={canExport} allowRelieved />}
      {many && view === 'allNow' && <AllBalancesTable data={includeRelieved && allData ? allData : data} canExport={canExport} includeRelieved={includeRelieved} onIncludeRelieved={setIncludeRelieved} />}
    </div>
  );
}
