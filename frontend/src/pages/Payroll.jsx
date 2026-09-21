import { useEffect, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import TabsPage from '../components/TabsPage.jsx';
import { downloadCsv, inr } from '../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, SectionLabel, ScopeNote, TwoCol } from '../components/proto.jsx';
import { canRunPayroll, isAdmin as hasAdminAccess } from '../permissions';
import Combo from '../components/Combo.jsx';

const thisMonth = () => new Date().toISOString().slice(0, 7);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(m) {
  if (!m) return '—';
  const [y, mm] = String(m).split('-');
  return `${MONTHS[Number(mm) - 1] || m} ${y}`;
}

// Opens the payslip in its own window, ready to print. Built from the expanded
// payslip the API returns so the figures match the stored run exactly.
function openPayslipWindow(slip) {
  const win = window.open('', '_blank');
  if (!win) {
    alert('Pop-up blocked — allow pop-ups to view the payslip.');
    return;
  }
  const money = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
  const rows = (lines) => lines.map((l) => `<tr><td>${l.label}</td><td style="text-align:right">${money(l.amount)}</td></tr>`).join('');
  const totalDeductions = slip.deductionLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip — ${slip.employee.name} — ${slip.period}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;padding:32px;color:#1c2733}
  h1{font-size:18px;margin:0}
  .sub{color:#6b7785;font-size:12px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
  table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px}
  td,th{padding:6px 8px;border-bottom:1px solid #e2e5ea;text-align:left}
  th{font-size:11px;text-transform:uppercase;color:#6b7785}
  .net{font-weight:bold;font-size:15px;margin-top:8px}
</style></head><body>
<div class="head">
  <div><h1>${slip.company.name}</h1><div class="sub">Payslip for ${slip.period}</div></div>
  <div class="sub">${slip.company.address || ''}</div>
</div>
<table>
  <tr><td>Employee</td><td>${slip.employee.name} (${slip.employee.employeeCode})</td></tr>
  <tr><td>Department</td><td>${slip.employee.department || '—'}</td></tr>
  <tr><td>Designation</td><td>${slip.employee.designation || '—'}</td></tr>
  <tr><td>Pay mode</td><td>${slip.payMode || 'Package'}</td></tr>
  <tr><td>Loss of pay days</td><td>${slip.lopDays || 0}</td></tr>
</table>
<table><thead><tr><th>Earnings</th><th style="text-align:right">Amount (₹)</th></tr></thead><tbody>
  ${rows(slip.earnings)}
  <tr><td><b>Gross Earnings</b></td><td style="text-align:right"><b>${money(slip.gross)}</b></td></tr>
</tbody></table>
<table><thead><tr><th>Deductions</th><th style="text-align:right">Amount (₹)</th></tr></thead><tbody>
  ${rows(slip.deductionLines)}
  <tr><td><b>Total Deductions</b></td><td style="text-align:right"><b>${money(totalDeductions)}</b></td></tr>
</tbody></table>
<table><thead><tr><th>Employer cost (not part of take-home)</th><th style="text-align:right">Amount (₹)</th></tr></thead><tbody>
  ${rows(slip.employerCost)}
</tbody></table>
<div class="net">Net Pay: ₹${money(slip.netPay)}</div>
<p class="sub">This is a system-generated payslip.</p>
</body></html>`);
  win.document.close();
}

// ---- Salary structures table (shared by the Dashboard and Salary Structure tabs) ----

function SalaryStructuresTable({ department, canEdit }) {
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ code: '', name: '', payType: '' });

  function load() { api.get('/payroll/structure').then((res) => setRows(res.data)); }
  useEffect(load, []);

  async function editCtc(employeeId, current) {
    const v = prompt('Annual CTC (₹)', current || 600000);
    if (v === null) return;
    await api.put(`/payroll/structure/${employeeId}`, { payMode: 'Package', ctc: Number(v) || 0 });
    load();
  }
  async function editStipend(employeeId, current) {
    const v = prompt('Monthly stipend (₹)', current || 20000);
    if (v === null) return;
    await api.put(`/payroll/structure/${employeeId}`, { payMode: 'Stipend', stipend: Number(v) || 0 });
    load();
  }
  async function toggleMode(row) {
    const mode = row.structure?.payMode === 'Stipend' ? 'Package' : 'Stipend';
    await api.put(`/payroll/structure/${row.employeeId}`, { payMode: mode });
    load();
  }

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered = rows.filter((r) => (
    (!filters.code || (r.employeeCode || '').toLowerCase().includes(filters.code.toLowerCase()))
    && (!filters.name || (r.name || '').toLowerCase().includes(filters.name.toLowerCase()))
    && (!filters.payType || (r.structure?.payMode || 'Package') === filters.payType)
    && (!department || r.department === department)
  ));

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Salary structures" />
      <div style={{ padding: '12px 18px' }}>
        <div className="filter-row">
          <input placeholder="Employee ID…" value={filters.code} onChange={(e) => set('code', e.target.value)} />
          <input placeholder="Employee name…" value={filters.name} onChange={(e) => set('name', e.target.value)} />
          <Combo value={filters.payType} onChange={(e) => set('payType', e.target.value)}>
            <option value="">All Pay Types</option><option>Package</option><option>Stipend</option>
          </Combo>
        </div>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th><th>Name</th><th>Pay Type</th>
              <th>HRA</th><th>Bonus</th><th>Employer PF</th><th>Special Allowance</th><th>Gratuity</th><th>PF</th><th>PT</th>
              <th>Net</th><th>CTC</th><th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const s = r.structure;
              const isStipend = s?.payMode === 'Stipend';
              return (
                <tr key={r.employeeId}>
                  <td><b>{r.employeeCode}</b></td>
                  <td>{r.name}</td>
                  <td><button className="btn btn-sm" disabled={!canEdit} onClick={() => toggleMode(r)}>{s?.payMode || 'Package'}</button></td>
                  {isStipend ? (
                    <td colSpan="7" className="cell-muted" style={{ textAlign: 'center', fontStyle: 'italic' }}>Fixed stipend — no components</td>
                  ) : (
                    <>
                      <td className="cell-muted">{inr(s?.hra)}</td>
                      <td className="cell-muted">{inr(s?.bonus)}</td>
                      <td className="cell-muted">{inr(s?.employerPf)}</td>
                      <td className="cell-muted">{inr(s?.specialAllowance)}</td>
                      <td className="cell-muted">{inr(s?.gratuity)}</td>
                      <td className="cell-muted">{inr(s?.employeePf)}</td>
                      <td className="cell-muted">{inr(s?.professionalTax)}</td>
                    </>
                  )}
                  <td className="cell-muted"><b>{isStipend ? inr(s?.stipend) : inr(r.breakup?.net)}</b></td>
                  <td className="cell-muted">{isStipend ? inr(s?.stipend) : inr(s?.ctc)}</td>
                  <td>{isStipend
                    ? <button className="btn btn-sm" disabled={!canEdit} onClick={() => editStipend(r.employeeId, s?.stipend)}>Edit stipend</button>
                    : <button className="btn btn-sm" disabled={!canEdit} onClick={() => editCtc(r.employeeId, s?.ctc)}>Edit CTC</button>}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan="13" className="small-muted" style={{ padding: 16 }}>No employees match.</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ---- Tab 1: Dashboard -------------------------------------------------------

function DashboardTab({ canRun, isAdmin, goTab }) {
  const [cycle, setCycle] = useState(thisMonth());
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState([]);
  const [payslips, setPayslips] = useState([]);
  const [fnf, setFnf] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [reference, setReference] = useState(null);
  const [showStructures, setShowStructures] = useState(true);
  const [runMonth, setRunMonth] = useState(thisMonth());
  const [message, setMessage] = useState('');

  function load() {
    if (!canRun) return;
    api.get('/payroll/fnf').then((res) => setFnf(res.data));
    api.get('/payroll/policy').then((res) => setPolicy(res.data));
    api.get('/payroll/reference-structure?ctc=300000').then((res) => setReference(res.data));
    api.get('/admin/departments').then((res) => setDepartments(res.data.map((d) => d.name))).catch(() => setDepartments([]));
  }
  useEffect(load, [canRun]);
  useEffect(() => {
    if (canRun) api.get(`/payroll?month=${cycle}`).then((res) => setPayslips(res.data));
  }, [canRun, cycle]);

  async function savePolicy(patch) {
    const updated = { ...policy, ...patch };
    setPolicy(updated);
    await api.put('/payroll/policy', patch);
  }

  async function runPayroll() {
    setMessage('');
    try {
      const res = await api.post('/payroll/run', { month: runMonth });
      setMessage(`Payroll processed for ${res.data.period} — ${res.data.count} employee(s), net ${inr(res.data.run.totalNet)}.`);
      goTab('payslips');
    } catch (err) {
      setMessage(err.response?.data?.error || 'Could not process the run');
    }
  }

  function exportStructures() {
    api.get('/payroll/structure').then((res) => {
      downloadCsv(
        'payroll-structures.csv',
        ['Code', 'Name', 'Department', 'Pay Type', 'Basic', 'HRA', 'Bonus', 'Special', 'Gross', 'PF', 'PT', 'Net', 'CTC'],
        res.data.map((r) => {
          const s = r.structure;
          if (s?.payMode === 'Stipend') return [r.employeeCode, r.name, r.department || '', 'Stipend', 0, 0, 0, 0, s.stipend, 0, 0, s.stipend, s.stipend * 12];
          const b = r.breakup || {};
          return [r.employeeCode, r.name, r.department || '', 'Package', b.basic || 0, b.hra || 0, b.bonus || 0, b.special || 0, b.gross || 0, b.employeePf || 0, b.professionalTax || 0, b.net || 0, s?.ctc || 0];
        })
      );
    });
  }

  if (!canRun) return <div className="small-muted">Payroll processing isn't included in your role's permissions — see the Payslips tab for your own pay history.</div>;

  const line = (label, value, strong) => (
    <div className="assign-row" style={{ padding: '7px 0' }} key={label}>
      <span style={strong ? { fontWeight: 600 } : undefined}>{label}</span><b>{value}</b>
    </div>
  );
  const cb = (key, label) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '5px 0' }} key={key}>
      <input type="checkbox" style={{ width: 'auto' }} disabled={!isAdmin} checked={!!policy[key]} onChange={(e) => savePolicy({ [key]: e.target.checked })} /> {label}
    </label>
  );
  const numIn = (key, label, type) => (
    <div className="field" style={{ marginBottom: 8 }} key={key}>
      <label>{label}</label>
      <input type={type || 'number'} disabled={!isAdmin} defaultValue={policy[key]} onBlur={(e) => savePolicy({ [key]: type === 'time' ? e.target.value : Number(e.target.value) })} />
    </div>
  );

  return (
    <div>
      <div className="filter-row" style={{ marginTop: 14, marginBottom: 12 }}>
        <Combo value={department} onChange={(e) => setDepartment(e.target.value)}>
          <option value="">All Departments</option>
          {departments.map((d) => <option key={d}>{d}</option>)}
        </Combo>
        <input type="month" value={cycle} onChange={(e) => setCycle(e.target.value)} />
        <button className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={exportStructures}>Export</button>
      </div>

      <StatRow cells={[
        { value: monthLabel(cycle), label: 'Payroll Cycle' },
        { value: payslips.length, label: 'Employees Processed' },
        { value: fnf.length, label: 'F&F Requests' },
      ]} />

      <TwoCol>
        {/* ① Reference salary structure */}
        <Panel>
          <PanelHead title="① Salary Structure" />
          <div style={{ padding: '10px 18px 4px', fontSize: 12 }} className="cell-muted">
            Standard Package reference structure — an illustrative example, not tied to any specific employee's actual pay.
          </div>
          {reference && (
            <div style={{ padding: '0 18px 16px' }}>
              <SectionLabel style={{ margin: '12px 0 4px' }}>Earnings</SectionLabel>
              {line('Basic', inr(reference.basic))}
              {line('HRA', inr(reference.hra))}
              {line('Bonus', inr(reference.bonus))}
              {line('Special Allowance', inr(reference.special))}
              {line('Gross', inr(reference.gross), true)}
              <SectionLabel style={{ margin: '12px 0 4px' }}>Deductions</SectionLabel>
              {line('PF (Provident Fund)', `−${inr(reference.employeePf)}`)}
              {line('PT (Professional Tax)', `−${inr(reference.professionalTax)}`)}
              {line('Total Deductions', `−${inr(reference.deductions)}`, true)}
              {line('Net Pay', inr(reference.net), true)}
              <SectionLabel style={{ margin: '12px 0 4px' }}>Employer cost (not part of take-home)</SectionLabel>
              {line('Employer PF', inr(reference.employerPf))}
              {line('Gratuity', inr(reference.gratuity))}
              {line('CTC', inr(reference.ctcCheck), true)}
            </div>
          )}
        </Panel>

        {/* ② Quick actions + attendance policy */}
        <Panel>
          <PanelHead title="② Quick Actions" />
          <div style={{ padding: '12px 18px 16px' }}>
            <div className="filter-row" style={{ marginBottom: 10 }}>
              <input type="month" style={{ flex: 1 }} value={runMonth} onChange={(e) => setRunMonth(e.target.value)} />
              <button className="btn btn-sm" onClick={() => goTab('process')}>Preview</button>
              <button className="btn btn-primary btn-sm" onClick={runPayroll}>Run Payroll</button>
            </div>
            {message && <div className="small-muted" style={{ marginBottom: 8 }}>{message}</div>}
            <div className="cell-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              Pay follows attendance: days marked Present or on approved Leave are paid, days marked Absent are deducted, and each
              check-in later than the grace period beyond the free monthly allowance costs half a day's pay.
            </div>
            {policy && (
              <>
                <SectionLabel style={{ color: 'var(--blue)', margin: '12px 0 4px' }}>How attendance affects pay</SectionLabel>
                {cb('unmarkedDaysUnpaid', 'Unmarked working days are unpaid')}
                {cb('weekendsPaid', 'Weekends are paid')}
                {cb('payByHours', 'Pay by hours worked')}
                {cb('halfDayBySession', 'Half day is measured by session')}
                <div className="grid-2" style={{ marginTop: 10 }}>
                  {numIn('sessionSplit', 'Session split time', 'time')}
                  {numIn('fullDayHours', 'Minimum hours for a full day')}
                  {numIn('halfDayHours', 'Minimum hours for a half day')}
                  {numIn('paidLeaveDaysPerMonth', 'Paid leave days per month')}
                </div>
                <div className="cell-muted" style={{ fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
                  A working day with no attendance record counts as Loss of Pay. {policy.paidLeaveDaysPerMonth} approved leave day(s)
                  a month are paid. Further approved leave that month is deducted.
                </div>
              </>
            )}
            <div className="qa-row" style={{ marginTop: 12 }}>
              <button className="btn btn-sm" onClick={() => setShowStructures((s) => !s)}>{showStructures ? '− Hide' : '+ Show'} salary structures table</button>
            </div>
          </div>
        </Panel>
      </TwoCol>

      {/* Full & Final settlements — kept from main; the prototype only counts them. */}
      <Panel>
        <PanelHead title="Full & Final Settlements" />
        {fnf.length === 0 ? <EmptyMini>No F&F requests.</EmptyMini> : fnf.map((f) => (
          <AssignRow key={f.id}>
            <span>{f.employee?.name} <span className="cell-muted" style={{ fontSize: 11.5 }}>— last working day {f.lastWorkingDate}</span></span>
            <span>
              {f.status === 'Pending'
                ? <button className="btn btn-sm" onClick={async () => { const a = prompt('Settlement amount (₹)'); if (a === null) return; await api.patch(`/payroll/fnf/${f.id}/process`, { settlementAmount: Number(a) || 0 }); load(); }}>Process</button>
                : <span className="status active">Processed {f.settlementAmount ? `· ${inr(f.settlementAmount)}` : ''}</span>}
            </span>
          </AssignRow>
        ))}
      </Panel>

      {showStructures && <SalaryStructuresTable department={department} canEdit={canRun} />}
    </div>
  );
}

// ---- Tab 2: Reports ---------------------------------------------------------

function ReportsTab({ canRun }) {
  const [data, setData] = useState(null);

  useEffect(() => { if (canRun) api.get('/payroll/reports').then((res) => setData(res.data)); }, [canRun]);

  if (!canRun) return <div className="small-muted">Payroll reports aren't included in your role's permissions.</div>;
  if (!data) return <div className="small-muted">Loading…</div>;

  const c = data.comparison;
  const direction = c ? (c.delta > 0 ? `${inr(Math.abs(c.delta))} more than` : c.delta < 0 ? `${inr(Math.abs(c.delta))} less than` : 'exactly the same as') : '';

  return (
    <div>
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="AI Monthly Comparison" />
        {c ? (
          <div style={{ padding: '12px 18px' }}>
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
              <b>{c.current.period}</b> paid out <b>{inr(c.current.net)}</b>, {direction} <b>{c.previous.period}</b>
              {c.pct ? ` (${c.pct > 0 ? '+' : ''}${c.pct}%)` : ''}.{' '}
              {c.headcountDelta === 0
                ? `Headcount was unchanged at ${c.current.employees}.`
                : `Headcount ${c.headcountDelta > 0 ? 'rose' : 'fell'} by ${Math.abs(c.headcountDelta)} to ${c.current.employees}.`}
            </div>
          </div>
        ) : <EmptyMini>Need at least two months of payroll runs to compare.</EmptyMini>}
      </Panel>

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Payroll by Period" />
        {data.byPeriod.length === 0 ? <EmptyMini>No payroll runs yet.</EmptyMini> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Period</th><th>Employees</th><th>Gross</th><th>Deductions</th><th>Late Cuts</th><th>Net Payout</th></tr></thead>
              <tbody>
                {data.byPeriod.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.period}</b></td>
                    <td className="cell-muted">{r.employees}</td>
                    <td className="cell-muted">{inr(r.gross)}</td>
                    <td className="cell-muted">{inr(r.deductions)}</td>
                    <td className="cell-muted">{inr(r.lateCuts)}</td>
                    <td><b>{inr(r.net)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Monthly Payout by Department" />
        {data.byDepartment.length === 0 ? <EmptyMini>No employees.</EmptyMini> : data.byDepartment.map((d) => (
          <AssignRow key={d.department}>
            <span>{d.department} <span className="cell-muted" style={{ fontSize: 11.5 }}>— {d.employees} employee(s)</span></span>
            <b>{inr(d.net)}</b>
          </AssignRow>
        ))}
      </Panel>
    </div>
  );
}

// ---- Tab 3: Salary Structure (CTC split config + per-employee structures) ----

const SPLIT_FIELDS = [
  ['basicPctOfCtc', 'Basic % of CTC', '%'],
  ['hraPctOfBasic', 'HRA % of Basic', '%'],
  ['bonusPctOfBasic', 'Bonus % of Basic', '%'],
  ['employeePfPctOfBasic', 'Employee PF % of Basic', '%'],
  ['employerPfPctOfBasic', 'Employer PF % of Basic', '%'],
  ['employeePfMonthlyCap', 'Employee PF monthly cap', ''],
  ['employerPfMonthlyCap', 'Employer PF monthly cap', ''],
  ['gratuityPctOfBasic', 'Gratuity % of Basic', '%'],
  ['professionalTaxFlat', 'Professional Tax (flat monthly)', ''],
];

function StructureTab({ canRun, isAdmin }) {
  const [policy, setPolicy] = useState(null);
  const [key, setKey] = useState(0);

  useEffect(() => { if (canRun) api.get('/payroll/policy').then((res) => setPolicy(res.data)); }, [canRun, key]);

  async function editSplit(field, label) {
    const v = prompt(`New value for ${label}`, policy[field]);
    if (v === null) return;
    await api.put('/payroll/ctc-settings', { [field]: Number(v) || 0 });
    setKey((k) => k + 1);
  }

  if (!canRun) return <div className="small-muted">Salary structures aren't included in your role's permissions.</div>;

  return (
    <div>
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="CTC Split Configuration" />
        <div style={{ padding: '10px 18px 0', fontSize: 12 }} className="cell-muted">
          These percentages drive every payslip and the salary structures table.
        </div>
        {policy && SPLIT_FIELDS.map(([field, label, suffix]) => (
          <AssignRow key={field}>
            <span>{label}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b>{policy[field]}{suffix}</b>
              {isAdmin && <button className="btn btn-sm" onClick={() => editSplit(field, label)}>Edit</button>}
            </span>
          </AssignRow>
        ))}
      </Panel>
      <SalaryStructuresTable key={key} canEdit={canRun} />
    </div>
  );
}

// ---- Tab 4: Process Payroll (preview, then confirm) -------------------------

function ProcessTab({ canRun }) {
  const [month, setMonth] = useState(thisMonth());
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState([]);
  const [preview, setPreview] = useState(null);
  const [runs, setRuns] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function loadRuns() { api.get('/payroll/runs').then((res) => setRuns(res.data)); }
  useEffect(() => {
    if (!canRun) return;
    loadRuns();
    api.get('/admin/departments').then((res) => setDepartments(res.data.map((d) => d.name))).catch(() => setDepartments([]));
  }, [canRun]);

  async function calculate(e) {
    e.preventDefault();
    setError(''); setMessage('');
    try {
      const res = await api.get(`/payroll/preview?month=${month}${department ? `&department=${encodeURIComponent(department)}` : ''}`);
      setPreview(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not calculate the run');
    }
  }

  async function confirm() {
    setError('');
    try {
      const res = await api.post('/payroll/run', { month, department: department || undefined });
      setMessage(`Payroll processed for ${res.data.period} — ${res.data.count} employee(s), net ${inr(res.data.run.totalNet)}.`);
      setPreview(null);
      loadRuns();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not process the run');
    }
  }

  async function markPaid(id) { await api.patch(`/payroll/runs/${id}/paid`); loadRuns(); }

  if (!canRun) return <div className="small-muted">Payroll processing isn't included in your role's permissions.</div>;

  return (
    <div>
      <PanelPad style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Run payroll</h3>
        <form onSubmit={calculate}>
          <div className="grid-2">
            <div className="field"><label>Month *</label><input type="month" required value={month} onChange={(e) => setMonth(e.target.value)} /></div>
            <div className="field">
              <label>Department (optional)</label>
              <Combo value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">All departments</option>
                {departments.map((d) => <option key={d}>{d}</option>)}
              </Combo>
            </div>
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Calculate</button>
        </form>
        {error && <div className="error-text">{error}</div>}
        {message && <div className="small-muted" style={{ marginTop: 8 }}>{message}</div>}

        {preview && (
          <div style={{ marginTop: 16 }}>
            <SectionLabel>Preview — {preview.period}</SectionLabel>
            {preview.alreadyProcessed && <div className="error-text">Payroll for {preview.period} has already been processed.</div>}
            <StatRow cells={[
              { value: preview.totals.employees, label: 'Employees' },
              { value: inr(preview.totals.gross), label: 'Total Gross' },
              { value: inr(preview.totals.net), label: 'Total Net' },
            ]} />
            <div className="tbl-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Code</th><th>Name</th><th>Pay Type</th><th>Gross</th><th>Deductions</th><th>LOP Days</th><th>Late Days</th><th>Late Cut</th><th>Net</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.employeeId}>
                      <td><b>{r.employeeCode}</b></td><td>{r.name}</td>
                      <td className="cell-muted">{r.payMode}</td>
                      <td className="cell-muted">{inr(r.gross)}</td>
                      <td className="cell-muted">{inr(r.deductions)}</td>
                      <td className="cell-muted">{r.lopDays}</td>
                      <td className="cell-muted">{r.lateDays}</td>
                      <td className="cell-muted">{inr(r.lateCut)}</td>
                      <td><b>{inr(r.netPay)}</b></td>
                    </tr>
                  ))}
                  {preview.rows.length === 0 && <tr><td colSpan="9" className="small-muted" style={{ padding: 16 }}>No eligible employees for this month.</td></tr>}
                </tbody>
              </table>
            </div>
            {!preview.alreadyProcessed && preview.rows.length > 0 && (
              <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={confirm}>Confirm &amp; Process Payroll</button>
            )}
          </div>
        )}
      </PanelPad>

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Payroll history" />
        {runs.length === 0 ? <EmptyMini>No payroll has been processed yet.</EmptyMini> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Month</th><th>Employees</th><th>Total Gross</th><th>Total Net</th><th>Status</th><th>Processed On</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.period}</td>
                    <td className="cell-muted">{r.employees}</td>
                    <td className="cell-muted">{inr(r.totalGross)}</td>
                    <td className="cell-muted">{inr(r.totalNet)}</td>
                    <td>
                      <span className={`status ${r.status === 'Paid' ? 'active' : 'pending'}`}>{r.status === 'Paid' ? 'Paid' : 'Processed'}</span>
                      {r.status !== 'Paid' && <> <button className="btn btn-sm" onClick={() => markPaid(r.id)}>Mark paid</button></>}
                    </td>
                    <td className="cell-muted">{r.processedAt ? new Date(r.processedAt).toISOString().slice(0, 10) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---- Tab 5: Payslips --------------------------------------------------------

function PayslipsTab({ canRun }) {
  const [payslips, setPayslips] = useState([]);
  const [filters, setFilters] = useState({ code: '', name: '', department: '' });

  useEffect(() => { api.get('/payroll').then((res) => setPayslips(res.data)); }, []);

  async function view(id) {
    const res = await api.get(`/payroll/payslips/${id}`);
    openPayslipWindow(res.data);
  }

  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered = payslips.filter((p) => (
    (!filters.code || (p.employee?.employeeCode || '').toLowerCase().includes(filters.code.toLowerCase()))
    && (!filters.name || (p.employee?.name || '').toLowerCase().includes(filters.name.toLowerCase()))
    && (!filters.department || p.employee?.department === filters.department)
  ));
  const departments = [...new Set(payslips.map((p) => p.employee?.department).filter(Boolean))].sort();

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Payslips" />
      {canRun && (
        <div style={{ padding: '12px 18px' }}>
          <div className="filter-row">
            <input placeholder="Employee ID…" value={filters.code} onChange={(e) => set('code', e.target.value)} />
            <input placeholder="Employee name…" value={filters.name} onChange={(e) => set('name', e.target.value)} />
            <Combo value={filters.department} onChange={(e) => set('department', e.target.value)}>
              <option value="">All Departments</option>
              {departments.map((d) => <option key={d}>{d}</option>)}
            </Combo>
            <span className="cell-muted" style={{ fontSize: 12, alignSelf: 'center' }}>{filtered.length} payslip(s)</span>
          </div>
        </div>
      )}
      {filtered.length === 0 ? <EmptyMini>No payslips generated yet — run payroll from the Process Payroll tab.</EmptyMini> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Period</th><th>Code</th><th>Employee</th><th>Pay Type</th><th>Gross</th><th>Deductions</th><th>Late Cut</th><th>Net</th><th></th></tr></thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>{monthLabel(p.month)}</td>
                  <td><b>{p.employee?.employeeCode || '—'}</b></td>
                  <td>{p.employee?.name}</td>
                  <td className="cell-muted">{p.payMode || 'Package'}</td>
                  <td className="cell-muted">{inr(p.gross)}</td>
                  <td className="cell-muted">{inr(p.deductions)}</td>
                  <td className="cell-muted">{inr(p.lateCut)}</td>
                  <td><b>{inr(p.netPay)}</b></td>
                  <td><button className="btn btn-sm" onClick={() => view(p.id)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function Payroll() {
  const { user } = useAuth();
  const canRun = canRunPayroll(user);
  const isAdmin = hasAdminAccess(user);
  const [tab, setTab] = useState('dashboard');

  const banner = isAdmin
    ? <ScopeNote amber>Full, unrestricted access — configures pay structures, processes/approves any run, organization-wide.</ScopeNote>
    : <ScopeNote>You are seeing your own payslips only. Pay structures are set by a Super Admin.</ScopeNote>;

  return (
    <TabsPage
      title="Payroll Management"
      subtitle={<>Signed in as: <b>{user?.name}</b></>}
      banner={banner}
      value={tab}
      onChange={setTab}
      tabs={[
        { key: 'dashboard', label: 'Dashboard', element: <DashboardTab canRun={canRun} isAdmin={isAdmin} goTab={setTab} /> },
        ...(canRun ? [
          { key: 'reports', label: 'Reports', element: <ReportsTab canRun={canRun} /> },
          { key: 'structure', label: 'Salary Structure', element: <StructureTab canRun={canRun} isAdmin={isAdmin} /> },
          { key: 'process', label: 'Process Payroll', element: <ProcessTab canRun={canRun} /> },
        ] : []),
        { key: 'payslips', label: 'Payslips', element: <PayslipsTab canRun={canRun} /> },
      ]}
    />
  );
}
