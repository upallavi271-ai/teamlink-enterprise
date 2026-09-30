// PF / ESI / TDS / PT compliance summary (SPEC B §8), from approved payroll
// records. One month by employee, or a year by month. Exports to Excel / CSV.
import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini } from '../proto.jsx';
import { monthLabel, errText, downloadFile } from './payrollUi';
import './payrollRun.css';
import ListFilterBar, { useListFilters, ListEmpty } from '../ui/ListFilters.jsx';
import Pager, { usePaged } from '../Pager.jsx';

// One month by employee: search, and who carries ESI / TDS.
const FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search employee name, ID, UAN or PAN…', get: (r) => `${r.employeeCode || ''} ${r.name || ''} ${r.uan || ''} ${r.pan || ''}` },
  {
    key: 'has', label: 'Deduction', allLabel: 'Any deduction', options: ['With ESI', 'With TDS', 'With PT'], primary: true,
    match: (r, v) => (v === 'With ESI' ? Number(r.esiEmployee) > 0 : v === 'With TDS' ? Number(r.tds) > 0 : Number(r.professionalTax) > 0),
  },
];

const inr0 = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function CompliancePanel() {
  const [mode, setMode] = useState('month');
  const [month, setMonth] = useState(thisMonth());
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [includeDraft, setIncludeDraft] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const q = () => `${mode === 'month' ? `month=${month}` : `year=${year}`}${includeDraft ? '&includeDraft=1' : ''}`;
  useEffect(() => {
    setError(''); setData(null);
    api.get(`/payroll/reports/compliance?${q()}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load the compliance summary.')));
  }, [mode, month, year, includeDraft]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = mode === 'month' ? `payroll-compliance-${month}` : `payroll-compliance-${year}`;
  const t = data?.totals;
  const lf = useListFilters(mode === 'month' ? (data?.rows || []) : [], FIELDS);
  const page = usePaged(lf.rows);
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Statutory compliance — PF / ESI / TDS / PT">
        <button className="btn btn-sm" onClick={() => downloadFile(`/payroll/reports/compliance?${q()}&format=xlsx`, `${name}.xlsx`).catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
        <button className="btn btn-sm" onClick={() => downloadFile(`/payroll/reports/compliance?${q()}&format=csv`, `${name}.csv`).catch((e) => setError(errText(e, 'Export failed')))}>CSV</button>
      </PanelHead>
      <div className="jl-filters">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="month">One month, by employee</option>
          <option value="year">A year, by month</option>
        </select>
        {mode === 'month'
          ? <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          : <input type="number" min="2000" max="2100" value={year} onChange={(e) => setYear(e.target.value)} style={{ width: 100, minWidth: 0 }} />}
        <label className="prb-check"><input type="checkbox" checked={includeDraft} onChange={(e) => setIncludeDraft(e.target.checked)} /> include drafts / pending</label>
        <span className="prb-note">Approved, synced and paid records{includeDraft ? ', plus drafts and pending' : ''}.</span>
      </div>
      {error && <div className="error-text" style={{ padding: '0 18px' }}>{error}</div>}
      {!data ? <EmptyMini>{error ? '' : 'Loading…'}</EmptyMini> : (
        <>
          <div className="jl-cards">
            <div className="jl-card"><div className="v">{inr0(t.pfTotal)}</div><div className="l">PF (employee {inr0(t.pfEmployee)} + employer {inr0(t.pfEmployer)})</div></div>
            <div className="jl-card"><div className="v">{inr0(t.esiTotal)}</div><div className="l">ESI (employee {inr0(t.esiEmployee)} + employer {inr0(t.esiEmployer)})</div></div>
            <div className="jl-card"><div className="v">{inr0(t.tds)}</div><div className="l">TDS deducted</div></div>
            <div className="jl-card"><div className="v">{inr0(t.professionalTax)}</div><div className="l">Professional tax</div></div>
          </div>
          {mode === 'month' && data.rows && data.rows.length > 0 && <div style={{ padding: '10px 18px 0' }}><ListFilterBar lf={lf} storageKey="payroll-compliance" noun="employees" /></div>}
          <div className="tbl-wrap">
            {mode === 'month' ? (
              <table>
                <thead><tr><th>Code</th><th>Employee</th><th>UAN</th><th>ESI No</th><th>PAN</th><th className="jl-num">Earned gross</th><th className="jl-num">PF emp</th><th className="jl-num">PF er</th><th className="jl-num">ESI emp</th><th className="jl-num">ESI er</th><th className="jl-num">TDS</th><th className="jl-num">PT</th></tr></thead>
                <tbody>
                  {page.slice.map((r) => (
                    <tr key={r.entryId}>
                      <td><b>{r.employeeCode}</b></td><td>{r.name}</td>
                      <td className="cell-muted">{r.uan || '—'}</td><td className="cell-muted">{r.esiNumber || '—'}</td><td className="cell-muted">{r.pan || '—'}</td>
                      <td className="jl-num">{inr0(r.earnedGross)}</td><td className="jl-num">{inr0(r.pfEmployee)}</td><td className="jl-num">{inr0(r.pfEmployer)}</td>
                      <td className="jl-num">{inr0(r.esiEmployee)}</td><td className="jl-num">{inr0(r.esiEmployer)}</td><td className="jl-num">{inr0(r.tds)}</td><td className="jl-num">{inr0(r.professionalTax)}</td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && <tr><td colSpan="12" className="small-muted" style={{ padding: 14 }}>No approved payroll for {monthLabel(month)}.</td></tr>}
                  {data.rows.length > 0 && lf.rows.length === 0 && <tr><td colSpan="12"><ListEmpty lf={lf} noun="employees" /></td></tr>}
                  {data.rows.length > 0 && (
                    <tr style={{ fontWeight: 700 }}>
                      <td colSpan="5">Total · {t.employees} employee(s){lf.activeCount ? ' — the whole month, not only the rows shown' : ''}</td>
                      <td className="jl-num">{inr0(t.earnedGross)}</td><td className="jl-num">{inr0(t.pfEmployee)}</td><td className="jl-num">{inr0(t.pfEmployer)}</td>
                      <td className="jl-num">{inr0(t.esiEmployee)}</td><td className="jl-num">{inr0(t.esiEmployer)}</td><td className="jl-num">{inr0(t.tds)}</td><td className="jl-num">{inr0(t.professionalTax)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table>
                <thead><tr><th>Month</th><th className="jl-num">Employees</th><th className="jl-num">Earned gross</th><th className="jl-num">PF total</th><th className="jl-num">ESI total</th><th className="jl-num">TDS</th><th className="jl-num">PT</th></tr></thead>
                <tbody>
                  {data.months.map((m) => (
                    <tr key={m.month}>
                      <td>{m.period}</td><td className="jl-num">{m.employees}</td><td className="jl-num">{inr0(m.earnedGross)}</td>
                      <td className="jl-num">{inr0(m.pfTotal)}</td><td className="jl-num">{inr0(m.esiTotal)}</td><td className="jl-num">{inr0(m.tds)}</td><td className="jl-num">{inr0(m.professionalTax)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700 }}>
                    <td>Total</td><td className="jl-num">{t.employees}</td><td className="jl-num">{inr0(t.earnedGross)}</td>
                    <td className="jl-num">{inr0(t.pfTotal)}</td><td className="jl-num">{inr0(t.esiTotal)}</td><td className="jl-num">{inr0(t.tds)}</td><td className="jl-num">{inr0(t.professionalTax)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
          {mode === 'month' && page.total > 0 && <Pager page={page} noun="employees" />}
        </>
      )}
    </Panel>
  );
}
