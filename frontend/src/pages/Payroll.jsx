import { useEffect, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import TabsPage from '../components/TabsPage.jsx';
import { inr } from '../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, SectionLabel, ScopeNote, TwoCol, Modal } from '../components/proto.jsx';
import { canRunPayroll, isAdmin as hasAdminAccess, can } from '../permissions';
import Combo from '../components/Combo.jsx';
import SalaryStructureCard from '../components/payroll/SalaryStructureCard.jsx';
import PayslipView, { downloadPayslipPdf } from '../components/payroll/PayslipView.jsx';
import ExportMenu from '../components/ExportMenu.jsx';
import DataIoBar from '../components/dataio/DataIoBar.jsx';
import InsightsPanel from '../components/charts/InsightsPanel.jsx';
// SPEC B: per-employee payroll records (approval, Accounts sync, mark paid).
import PayrollRunBoard from '../components/payroll/PayrollRunBoard.jsx';
import { STATUS_LABEL as RUN_STATUS } from '../components/payroll/payrollUi';
import CompliancePanel from '../components/payroll/CompliancePanel.jsx';
import { ReconciliationPanel } from './accounts/JournalLedger.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../components/Pager.jsx';

const thisMonth = () => new Date().toISOString().slice(0, 7);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(m) {
  if (!m) return '—';
  const [y, mm] = String(m).split('-');
  return `${MONTHS[Number(mm) - 1] || m} ${y}`;
}

const REFERENCE_SUBTITLE = "Standard Package reference structure — an illustrative example, not tied to any specific employee's actual pay";

// Live preview of the Standard Package rules (backend utils/salaryRules.js) for
// a monthly CTC. The server does the arithmetic so there is one copy of the
// rules; the call is debounced while the user types.
function useStructurePreview(monthlyCtc, bonus) {
  const [b, setB] = useState(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(() => {
      const q = new URLSearchParams({ monthlyCtc: String(Number(monthlyCtc) || 0) });
      if (bonus !== '' && bonus != null) q.set('bonus', String(Number(bonus) || 0));
      api.get(`/payroll/reference-structure?${q}`)
        .then((res) => { if (n === seq.current) setB(res.data); })
        .catch(() => { if (n === seq.current) setB(null); });
    }, 220);
    return () => clearTimeout(t);
  }, [monthlyCtc, bonus]);
  return b;
}

// ① The reference card: the user's Standard Package, recalculated live.
function ReferenceStructure({ defaultBonus }) {
  const [ctc, setCtc] = useState('25000');
  const [bonus, setBonus] = useState('');
  useEffect(() => { if (defaultBonus != null && bonus === '') setBonus(String(defaultBonus)); }, [defaultBonus]); // eslint-disable-line react-hooks/exhaustive-deps
  const b = useStructurePreview(ctc, bonus);
  return (
    <SalaryStructureCard
      b={b}
      subtitle={REFERENCE_SUBTITLE}
      controls={(
        <>
          <div className="field">
            <label>Monthly CTC (₹)</label>
            <input type="number" min="0" step="500" value={ctc} onChange={(e) => setCtc(e.target.value)} />
          </div>
          <div className="field">
            <label>Bonus (₹ / month)</label>
            <input type="number" min="0" step="100" value={bonus} onChange={(e) => setBonus(e.target.value)} />
          </div>
        </>
      )}
      footer={b ? <>Annual CTC {inr(b.annualCtc)}. Basic 40% of CTC · HRA 40% of Basic · PF 12% of Basic · Gratuity 4.81% of Basic · PT on the Telangana slab · Special Allowance takes the rest.</> : null}
    />
  );
}

// The signed-in employee's OWN structure, in the same card.
function MyStructure() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/payroll/my-structure').then((res) => setData(res.data)).catch((err) => setError(err.response?.data?.error || 'Could not load your salary structure.'));
  }, []);
  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  const s = data.structure;
  const isStipend = s?.payMode === 'Stipend';
  return (
    <SalaryStructureCard
      title="My Salary Structure"
      subtitle={data.employee ? `${data.employee.name}${data.employee.employeeCode ? ` · ${data.employee.employeeCode}` : ''} — your monthly pay as HR has set it` : 'No employee record is linked to this login.'}
      b={isStipend ? null : data.breakup}
      stipend={isStipend ? Number(s.stipend || 0) : undefined}
      empty="HR has not set your salary structure yet."
      footer={s ? `Last updated ${new Date(s.updatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}.${!isStipend && s.ctc ? ` Annual CTC ${inr(s.ctc)}.` : ''}` : null}
    />
  );
}

// ---- One employee's structure: HR enters a CTC, components auto-fill --------

const COMPONENTS = [
  ['basic', 'Basic', 'basic'],
  ['hra', 'HRA', 'hra'],
  ['bonus', 'Bonus', 'bonus'],
  ['specialAllowance', 'Special Allowance', 'special'],
  ['employeePf', 'PF (employee)', 'employeePf'],
  ['professionalTax', 'PT', 'professionalTax'],
  ['employerPf', 'Employer PF', 'employerPf'],
  ['gratuity', 'Gratuity', 'gratuity'],
];

function StructureEditor({ row, defaultBonus, onClose, onSaved }) {
  const s = row.structure;
  const [mode, setMode] = useState(s?.payMode || 'Package');
  const [ctc, setCtc] = useState(s?.ctc ? String(Math.round(s.ctc / 12)) : '');
  const [bonus, setBonus] = useState(s?.bonus != null && s?.ctc ? String(s.bonus) : String(defaultBonus ?? 1000));
  const [stipend, setStipend] = useState(s?.stipend ? String(s.stipend) : '');
  // Current component values, and which ones HR typed over.
  const [vals, setVals] = useState(() => {
    const v = {};
    COMPONENTS.forEach(([f]) => { v[f] = s && s.ctc ? String(s[f] ?? '') : ''; });
    return v;
  });
  const [overridden, setOverridden] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // SPEC B — versioning and the statutory / other deductions of this version.
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [esi, setEsi] = useState(s?.esiApplicable === true ? 'yes' : s?.esiApplicable === false ? 'no' : 'auto');
  const [tds, setTds] = useState(s?.tds != null ? String(s.tds) : '');
  const [other, setOther] = useState(s?.otherDeductions ? String(s.otherDeductions) : '');
  const [history, setHistory] = useState(null);
  useEffect(() => {
    api.get(`/payroll/structure/${row.employeeId}`).then((res) => {
      setHistory(res.data);
      const latest = res.data.versions?.[0];
      const next = (m) => { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`; };
      const locked = res.data.lockedThrough;
      if (latest) {
        const lm = latest.effectiveFrom.slice(0, 7);
        setEffectiveFrom(locked && lm <= locked ? next(locked) : lm);
      } else if (locked) setEffectiveFrom(next(locked));
    }).catch(() => setHistory({ versions: [] }));
  }, [row.employeeId]);
  const touched = useRef(false); // becomes true once HR changes CTC or bonus
  const preview = useStructurePreview(ctc, bonus);

  // A new CTC (or bonus) refills every component from the rules; HR's edits
  // are cleared, because they were edits of the old figures.
  useEffect(() => {
    if (!preview || !touched.current) return;
    const v = {};
    COMPONENTS.forEach(([f, , key]) => { v[f] = String(preview[key]); });
    setVals(v);
    setOverridden({});
  }, [preview]);
  // First open of an employee with no structure yet: fill from the preview.
  useEffect(() => {
    if (preview && !(s && s.ctc) && !Object.values(vals).some((x) => x !== '')) {
      const v = {};
      COMPONENTS.forEach(([f, , key]) => { v[f] = String(preview[key]); });
      setVals(v);
    }
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (f) => Number(vals[f]) || 0;
  const live = {
    basic: num('basic'), hra: num('hra'), bonus: num('bonus'), special: num('specialAllowance'),
    employeePf: num('employeePf'), professionalTax: num('professionalTax'), employerPf: num('employerPf'), gratuity: num('gratuity'),
  };
  live.gross = live.basic + live.hra + live.bonus + live.special;
  live.deductions = live.employeePf + live.professionalTax;
  live.net = live.gross - live.deductions;
  live.ctcCheck = live.gross + live.employerPf + live.gratuity;
  live.valid = live.special >= 0;
  const monthly = Math.round(Number(ctc) || 0);
  const mismatch = mode === 'Package' && monthly > 0 && live.ctcCheck !== monthly;

  async function save() {
    setError(''); setBusy(true);
    try {
      const body = { payMode: mode };
      if (mode === 'Package') {
        if (!(monthly > 0)) throw new Error('Enter the monthly CTC.');
        body.monthlyCtc = monthly;
        body.bonus = Number(bonus) || 0;
        const components = {};
        Object.keys(overridden).forEach((f) => { if (overridden[f]) components[f] = Number(vals[f]) || 0; });
        body.components = components;
      } else {
        if (!(Number(stipend) >= 0) || stipend === '') throw new Error('Enter the monthly stipend.');
        body.stipend = Number(stipend);
      }
      if (effectiveFrom) body.effectiveFrom = effectiveFrom;
      body.esiApplicable = esi === 'yes' ? true : esi === 'no' ? false : null;
      body.tds = tds === '' ? null : Number(tds);
      body.otherDeductions = Number(other) || 0;
      const res = await api.put(`/payroll/structure/${row.employeeId}`, body);
      if (res.data.staleDrafts?.length) window.alert(`Saved. Recalculate the draft payroll for ${res.data.staleDrafts.join(', ')} before submitting it — it was calculated from the previous figures.`);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Could not save the structure.');
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={`Salary structure — ${row.name}${row.employeeCode ? ` (${row.employeeCode})` : ''}`}
      onClose={onClose}
      wide
      footer={(
        <>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save structure'}</button>
        </>
      )}
    >
      <div className="grid-2" style={{ marginBottom: 12 }}>
        <div className="field">
          <label>Pay type</label>
          <Combo value={mode} onChange={(e) => setMode(e.target.value)}>
            <option>Package</option><option>Stipend</option>
          </Combo>
        </div>
        {mode === 'Package' ? (
          <div className="field">
            <label>Monthly CTC (₹) {monthly > 0 && <span className="cell-muted" style={{ fontWeight: 400 }}>· {inr(monthly * 12)} a year</span>}</label>
            <input type="number" min="0" step="500" value={ctc} autoFocus onChange={(e) => { touched.current = true; setCtc(e.target.value); }} />
          </div>
        ) : (
          <div className="field">
            <label>Monthly stipend (₹)</label>
            <input type="number" min="0" step="500" value={stipend} autoFocus onChange={(e) => setStipend(e.target.value)} />
          </div>
        )}
      </div>

      {mode === 'Package' ? (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Bonus (₹ / month)</label>
              <input type="number" min="0" step="100" value={bonus} onChange={(e) => { touched.current = true; setBonus(e.target.value); }} />
            </div>
            <SectionLabel style={{ margin: '4px 0 6px' }}>Components — filled from the CTC, edit any to override</SectionLabel>
            <div className="ss-edit-grid">
              {COMPONENTS.map(([f, label]) => (
                <div className="field" key={f}>
                  <label>{label} {overridden[f] && <span className="ss-overridden">edited</span>}</label>
                  <input
                    type="number"
                    value={vals[f]}
                    onChange={(e) => { const v = e.target.value; setVals((x) => ({ ...x, [f]: v })); setOverridden((o) => ({ ...o, [f]: true })); }}
                  />
                </div>
              ))}
            </div>
            {mismatch && (
              <div className="notice amber" style={{ marginTop: 10 }}>
                <span>The components add up to {inr(live.ctcCheck)} a month, not the {inr(monthly)} CTC entered. Adjust Special Allowance, or re-enter the CTC to refill everything.</span>
              </div>
            )}
          </div>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <SalaryStructureCard b={live} title="Preview" subtitle="What this employee will see on their side." />
          </div>
        </div>
      ) : (
        <div className="small-muted">A stipend is a flat monthly amount — no Basic/HRA split, and no PF or PT is deducted.</div>
      )}

      {/* SPEC B — version dates and the other deduction components */}
      <SectionLabel style={{ margin: '14px 0 6px' }}>Version &amp; other deductions</SectionLabel>
      <div className="prb-grid4">
        <div className="field">
          <label>Effective from</label>
          <input type="month" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>ESI</label>
          <select value={esi} onChange={(e) => setEsi(e.target.value)}>
            <option value="auto">Automatic (gross ≤ ceiling)</option>
            <option value="yes">Always deduct</option>
            <option value="no">Never deduct</option>
          </select>
        </div>
        <div className="field">
          <label>TDS (₹ / month)</label>
          <input type="number" min="0" step="100" value={tds} placeholder="policy %" onChange={(e) => setTds(e.target.value)} />
        </div>
        <div className="field">
          <label>Other deductions (₹ / month)</label>
          <input type="number" min="0" step="100" value={other} onChange={(e) => setOther(e.target.value)} />
        </div>
      </div>
      <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
        Payroll for a month uses the version in effect that month. The same month as an existing version edits it; a later month creates a new version and closes the previous one the day before.
        {history?.lockedThrough ? ` Payroll is approved up to ${monthLabel(history.lockedThrough)}, so a change can only take effect after that.` : ''}
        {!effectiveFrom && ' Left blank, a first structure takes effect from the joining month (or this month).'}
      </div>
      {history?.versions?.length > 0 && (
        <div className="tbl-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>From</th><th>To</th><th>Pay</th><th>Gross</th><th>ESI</th><th>TDS</th><th>Other</th><th>Used by</th></tr></thead>
            <tbody>
              {history.versions.map((v) => (
                <tr key={v.id}>
                  <td>{monthLabel(v.effectiveFrom.slice(0, 7))}</td>
                  <td className="cell-muted">{v.effectiveTo || 'current'}</td>
                  <td className="cell-muted">{v.payMode === 'Stipend' ? `Stipend ${inr(v.stipend)}` : `CTC ${inr(Math.round(v.ctc / 12))}`}</td>
                  <td className="cell-muted">{v.breakup ? inr(v.breakup.gross) : inr(v.stipend)}</td>
                  <td className="cell-muted">{v.esiEmployee ? `${inr(v.esiEmployee)} / ${inr(v.esiEmployer)}` : '—'}</td>
                  <td className="cell-muted">{v.tds == null ? 'policy' : inr(v.tds)}</td>
                  <td className="cell-muted">{inr(v.otherDeductions)}</td>
                  <td className="cell-muted">{v.runs.length ? v.runs.map((r) => `${r.month} (${RUN_STATUS[r.status] || r.status})`).join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <div className="error-text" style={{ marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}

// ---- Salary structures table (shared by the Dashboard and Salary Structure tabs) ----

// The pay type as the filter reads it: a row with no structure is "Not set".
const payTypeOf = (r) => (r.structure ? (r.structure.payMode || 'Package') : 'Not set');
const STRUCTURE_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search employee name or ID…', get: (r) => `${r.employeeCode || ''} ${r.name || ''}` },
  { key: 'department', label: 'Department', get: (r) => r.department, primary: true },
  { key: 'payType', label: 'Pay type', allLabel: 'All pay types', options: ['Package', 'Stipend', 'Not set'], get: payTypeOf, primary: true },
];
const STRUCTURE_SORTS = [
  { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name || '').localeCompare(String(b.name || '')) },
  { key: 'code', label: 'Employee ID', cmp: (a, b) => String(a.employeeCode || '').localeCompare(String(b.employeeCode || ''), undefined, { numeric: true }) },
  { key: 'net', label: 'Net (high to low)', cmp: (a, b) => (Number(b.breakup?.net ?? b.structure?.stipend) || 0) - (Number(a.breakup?.net ?? a.structure?.stipend) || 0) },
];

function SalaryStructuresTable({ canEdit, defaultBonus }) {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);

  function load() { api.get('/payroll/structure').then((res) => setRows(res.data)); }
  useEffect(load, []);

  const lf = useListFilters(rows, STRUCTURE_FIELDS, { sorts: STRUCTURE_SORTS });
  const filtered = lf.rows;
  const page = usePaged(filtered);

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Salary structures">
        {/* Export every version on the register / one employee's, and
            Import with the compulsory sample — each row saved as a salary
            VERSION, never over a submitted / paid month (src/io/payroll-salary.js). */}
        <DataIoBar ioKey="payroll-salary" onImported={load} />
      </PanelHead>
      <div style={{ padding: '12px 18px' }}>
        <ListFilterBar lf={lf} storageKey="payroll-structures" noun="employees" />
        <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          All figures are monthly. Set a CTC and every component fills itself from the Standard Package rules; nothing changes for an employee until you save their row.
        </div>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Code</th><th>Name</th><th>Pay Type</th>
              <th>Basic</th><th>HRA</th><th>Bonus</th><th>Special Allowance</th><th>Gross</th><th>PF</th><th>PT</th>
              <th>Net</th><th>Employer PF</th><th>Gratuity</th><th>CTC / month</th><th></th>
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => {
              const s = r.structure;
              const b = r.breakup;
              const isStipend = s?.payMode === 'Stipend';
              return (
                <tr key={r.employeeId}>
                  <td><b>{r.employeeCode}</b></td>
                  <td>{r.name}</td>
                  <td className="cell-muted">{s ? (s.payMode || 'Package') : '—'}</td>
                  {isStipend ? (
                    <td colSpan="10" className="cell-muted" style={{ textAlign: 'center', fontStyle: 'italic' }}>Fixed stipend {inr(s?.stipend)} — no components, no PF/PT</td>
                  ) : b ? (
                    <>
                      <td className="cell-muted">{inr(b.basic)}</td>
                      <td className="cell-muted">{inr(b.hra)}</td>
                      <td className="cell-muted">{inr(b.bonus)}</td>
                      <td className="cell-muted">{inr(b.special)}</td>
                      <td className="cell-muted">{inr(b.gross)}</td>
                      <td className="cell-muted">{inr(b.employeePf)}</td>
                      <td className="cell-muted">{inr(b.professionalTax)}</td>
                      <td><b>{inr(b.net)}</b></td>
                      <td className="cell-muted">{inr(b.employerPf)}</td>
                      <td className="cell-muted">{inr(b.gratuity)}</td>
                    </>
                  ) : (
                    <td colSpan="10" className="cell-muted" style={{ textAlign: 'center', fontStyle: 'italic' }}>Not set</td>
                  )}
                  <td className="cell-muted">{isStipend ? '—' : b ? inr(b.ctcCheck) : '—'}</td>
                  <td>
                    <button className="btn btn-sm" disabled={!canEdit} onClick={() => setEditing(r)}>{s ? 'Edit' : 'Set CTC'}</button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan="15"><ListEmpty lf={lf} noun="employees" title="No employees in your scope." /></td></tr>}
          </tbody>
        </table>
      </div>
      {page.total > 0 && <Pager page={page} noun="employees" />}
      {editing && (
        <StructureEditor
          row={editing}
          defaultBonus={defaultBonus}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </Panel>
  );
}

// ---- Tab 1: Dashboard -------------------------------------------------------

function DashboardTab({ canRun, isAdmin, goTab }) {
  const [fnf, setFnf] = useState([]);
  const [fnfStatus, setFnfStatus] = useState('');
  const [policy, setPolicy] = useState(null);
  const [showStructures, setShowStructures] = useState(true);
  const [runMonth, setRunMonth] = useState(thisMonth());
  const [message, setMessage] = useState('');

  function load() {
    if (!canRun) return;
    api.get('/payroll/fnf').then((res) => setFnf(res.data));
    api.get('/payroll/policy').then((res) => setPolicy(res.data));
  }
  useEffect(load, [canRun]);

  async function savePolicy(patch) {
    const updated = { ...policy, ...patch };
    setPolicy(updated);
    await api.put('/payroll/policy', patch);
  }

  async function runPayroll() {
    setMessage('');
    try {
      const res = await api.post('/payroll/run', { month: runMonth });
      const skipped = res.data.skipped?.length ? ` ${res.data.skipped.length} skipped (no salary structure).` : '';
      const locked = res.data.locked?.length ? ` ${res.data.locked.length} already beyond draft.` : '';
      setMessage(`Drafts calculated for ${res.data.period} — ${res.data.count} employee(s), net ${inr(res.data.totals?.net)}.${skipped}${locked} Submit them for approval on Process Payroll.`);
      goTab('process');
    } catch (err) {
      setMessage(err.response?.data?.error || 'Could not process the run');
    }
  }

  // An employee (and a view-only Manager / Assistant Manager) sees their OWN
  // salary structure here; their payslips are on the Payslips tab.
  if (!canRun) {
    return (
      <div style={{ marginTop: 16, maxWidth: 560 }}>
        <MyStructure />
        <div className="small-muted" style={{ marginTop: 10 }}>
          Your payslips are on the <a href="#" onClick={(e) => { e.preventDefault(); goTab('payslips'); }}>Payslips</a> tab.
        </div>
      </div>
    );
  }

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
      {/* hrms-24 §1 / §9 — payslips for the months in the range: gross,
          deductions, net, net pay by department and the month-by-month trend,
          plus the payslip register export. */}
      {/* ONE KPI row: the range's payslips, employees paid, gross,
          deductions and net, plus the F&F request count (not dated, so not
          range-driven). The old cycle picker's "Employees Processed" is the
          range's Employees Paid. */}
      <div style={{ marginTop: 14 }}>
        <InsightsPanel
          module="payroll"
          storageKey="tl_range_payroll"
          extraTiles={[{ value: fnf.length, label: 'F&F Requests (all)' }]}
        />
      </div>

      <TwoCol style={{ marginTop: 14 }}>
        {/* ① Reference salary structure — the Standard Package, live */}
        <ReferenceStructure defaultBonus={policy?.bonusFixedMonthly} />

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
              Pay follows attendance: days marked Present or on approved Leave are paid, days marked Absent are deducted as Loss of Pay
              (monthly gross ÷ working days × LOP days), and each check-in later than the grace period beyond the free monthly allowance
              costs half a day's pay. Employees with no salary structure are skipped, never paid a default.
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
        <PanelHead title="Full & Final Settlements">
          {fnf.length > 0 && (
            <select value={fnfStatus} onChange={(e) => setFnfStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status" title="Status">
              <option value="">All statuses</option>
              <option value="Pending">Pending</option>
              <option value="Processed">Processed</option>
            </select>
          )}
        </PanelHead>
        {fnf.length === 0 ? <EmptyMini>No F&F requests yet.</EmptyMini> : fnf.filter((f) => !fnfStatus || (fnfStatus === 'Pending' ? f.status === 'Pending' : f.status !== 'Pending')).length === 0 ? (
          <EmptyMini>No F&F requests match this status. <button type="button" className="btn btn-sm" onClick={() => setFnfStatus('')}>Clear filters</button></EmptyMini>
        ) : fnf.filter((f) => !fnfStatus || (fnfStatus === 'Pending' ? f.status === 'Pending' : f.status !== 'Pending')).map((f) => (
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

      {showStructures && (
        <>
          {/* Export all / one employee and Import (with the compulsory
              sample) sit in the table's own header — server-side, scoped,
              and the Super Admin is told (src/io/payroll-salary.js). */}
          <SalaryStructuresTable canEdit={canRun} defaultBonus={policy?.bonusFixedMonthly} />
        </>
      )}
    </div>
  );
}

// ---- Tab 2: Reports ---------------------------------------------------------

function ReportsTab({ canRun, canViewLedger }) {
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

      {/* SPEC B §8 — statutory compliance, and (for Accounts / SA / Admin) the
          HRMS-vs-ledger reconciliation that also lives under Accounts. */}
      <CompliancePanel />
      {canViewLedger && <ReconciliationPanel />}
    </div>
  );
}

// ---- Tab 3: Salary Structure (reference card, CTC split config, per-employee structures) ----

const SPLIT_FIELDS = [
  ['basicPctOfCtc', 'Basic % of CTC', '%'],
  ['hraPctOfBasic', 'HRA % of Basic', '%'],
  ['bonusFixedMonthly', 'Bonus (fixed, ₹ per month)', ''],
  ['employeePfPctOfBasic', 'Employee PF % of Basic', '%'],
  ['employerPfPctOfBasic', 'Employer PF % of Basic', '%'],
  ['employeePfMonthlyCap', 'Employee PF monthly cap (₹, 0 = no cap)', ''],
  ['employerPfMonthlyCap', 'Employer PF monthly cap (₹, 0 = no cap)', ''],
  ['gratuityPctOfBasic', 'Gratuity % of Basic', '%'],
  // SPEC B statutory settings (ESI applies only while gross ≤ the ceiling; 0 turns ESI off).
  ['esiEmployeePct', 'ESI employee % of gross', '%'],
  ['esiEmployerPct', 'ESI employer % of gross', '%'],
  ['esiGrossCeiling', 'ESI applies up to a monthly gross of (₹)', ''],
  ['tdsDefaultPctOfGross', 'Default TDS % of gross (when a structure has no TDS figure)', '%'],
];

function ptSlabText(slab) {
  if (!Array.isArray(slab)) return '';
  const rows = [...slab].sort((a, b) => a.above - b.above);
  return rows.map((r, i) => {
    const next = rows[i + 1];
    const range = next ? `${inr(r.above + (r.above ? 1 : 0))} – ${inr(next.above)}` : `above ${inr(r.above)}`;
    return `${range}: ${inr(r.tax)}`;
  }).join(' · ');
}

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
      <TwoCol>
        <ReferenceStructure key={`ref-${key}`} defaultBonus={policy?.bonusFixedMonthly} />
        <Panel>
          <PanelHead title="CTC Split Configuration" />
          <div style={{ padding: '10px 18px 0', fontSize: 12 }} className="cell-muted">
            These rules fill every salary structure when HR sets a CTC. Special Allowance always takes whatever is left, so the pieces add up to the CTC exactly. Saved structures keep their figures until HR edits that employee.
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
          {policy?.ptSlab && (
            <AssignRow>
              <span>Professional Tax ({policy.ptState} slab, on monthly gross)</span>
              <span className="cell-muted" style={{ fontSize: 12, textAlign: 'right' }}>{ptSlabText(policy.ptSlab)}</span>
            </AssignRow>
          )}
        </Panel>
      </TwoCol>
      <SalaryStructuresTable key={key} canEdit={canRun} defaultBonus={policy?.bonusFixedMonthly} />
    </div>
  );
}

// ---- Tab 4: Process Payroll (preview, then confirm) -------------------------

const PREVIEW_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search employee name or ID…', get: (r) => `${r.employeeCode || ''} ${r.name || ''}` },
  { key: 'payMode', label: 'Pay type', allLabel: 'All pay types', get: (r) => r.payMode, primary: true },
  { key: 'lop', label: 'Loss of pay', allLabel: 'Everyone', options: ['With LOP', 'With late cut'], match: (r, v) => (v === 'With LOP' ? Number(r.lopDays) > 0 : Number(r.lateCut) > 0), primary: true },
];
const PREVIEW_SORTS = [
  { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.name || '').localeCompare(String(b.name || '')) },
  { key: 'net', label: 'Net (high to low)', cmp: (a, b) => (Number(b.netPay) || 0) - (Number(a.netPay) || 0) },
  { key: 'lop', label: 'LOP days (most first)', cmp: (a, b) => (Number(b.lopDays) || 0) - (Number(a.lopDays) || 0) },
];
const runStatusOf = (r) => (r.perEmployee ? r.status : (r.status === 'Paid' ? 'Paid' : 'Processed'));
const RUN_FIELDS = [
  { key: 'year', label: 'Year', get: (r) => String(r.month || '').slice(0, 4), primary: true },
  { key: 'status', label: 'Status', get: runStatusOf, primary: true },
];

function ProcessTab({ canRun, canSeeRuns }) {
  const [month, setMonth] = useState(thisMonth());
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState([]);
  const [preview, setPreview] = useState(null);
  const [runs, setRuns] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [boardKey, setBoardKey] = useState(0);

  function loadRuns() { if (canRun) api.get('/payroll/runs').then((res) => setRuns(res.data)); }
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
      const locked = res.data.locked?.length ? ` ${res.data.locked.length} record(s) already beyond draft were left as they are.` : '';
      setMessage(`Drafts for ${res.data.period}: ${res.data.created} new, ${res.data.updated} recalculated — net ${inr(res.data.totals?.net)}.${locked} Submit them for approval below.`);
      setPreview(null);
      loadRuns();
      setBoardKey((k) => k + 1);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not process the run');
    }
  }

  async function markPaid(id) {
    setError('');
    try { await api.patch(`/payroll/runs/${id}/paid`); } catch (err) { setError(err.response?.data?.error || 'Could not mark the run paid'); }
    loadRuns();
  }

  // The preview's rows and the run history, each with its own small filter
  // bar (hooks first: the returns below depend on the role).
  const previewLf = useListFilters(preview?.rows || [], PREVIEW_FIELDS, { sorts: PREVIEW_SORTS });
  const previewPage = usePaged(previewLf.rows);
  const runsLf = useListFilters(runs, RUN_FIELDS);
  const runsPage = usePaged(runsLf.rows);

  if (!canRun && !canSeeRuns) return <div className="small-muted">Payroll processing isn't included in your role's permissions.</div>;

  // Approvers / Accounts / view-only oversight: the month's records only.
  if (!canRun) {
    return (
      <div>
        <div className="filter-row" style={{ marginTop: 14 }}>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <PayrollRunBoard month={month} reloadKey={boardKey} />
      </div>
    );
  }

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
            <SectionLabel>Preview — {preview.period} · {preview.workingDays} working day(s)</SectionLabel>
            {preview.alreadyProcessed && <div className="error-text">Payroll for {preview.period} was already processed as a month run (before per-employee records); it cannot be run again.</div>}
            <StatRow cells={[
              { value: preview.totals.employees, label: 'Employees' },
              { value: inr(preview.totals.gross), label: 'Total Gross' },
              { value: inr(preview.totals.net), label: 'Total Net' },
            ]} />
            {preview.rows.length > 0 && <div style={{ marginTop: 10 }}><ListFilterBar lf={previewLf} storageKey="payroll-preview" noun="employees" /></div>}
            <div className="tbl-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Code</th><th>Name</th><th>Pay Type</th><th>Gross</th><th>PF + PT</th><th>LOP Days</th><th>LOP</th><th>Late Days</th><th>Late Cut</th><th>Net</th></tr></thead>
                <tbody>
                  {previewPage.slice.map((r) => (
                    <tr key={r.employeeId}>
                      <td><b>{r.employeeCode}</b></td><td>{r.name}</td>
                      <td className="cell-muted">{r.payMode}</td>
                      <td className="cell-muted">{inr(r.gross)}</td>
                      <td className="cell-muted">{inr(r.deductions)}</td>
                      <td className="cell-muted">{r.lopDays}</td>
                      <td className="cell-muted">{inr(r.lopDeduction)}</td>
                      <td className="cell-muted">{r.lateDays}</td>
                      <td className="cell-muted">{inr(r.lateCut)}</td>
                      <td><b>{inr(r.netPay)}</b></td>
                    </tr>
                  ))}
                  {preview.rows.length === 0 && <tr><td colSpan="10" className="small-muted" style={{ padding: 16 }}>Nobody in this run has a salary structure yet — set a CTC on the Salary Structure tab first.</td></tr>}
                  {preview.rows.length > 0 && previewLf.rows.length === 0 && <tr><td colSpan="10"><ListEmpty lf={previewLf} noun="employees" /></td></tr>}
                </tbody>
              </table>
            </div>
            {previewPage.total > 0 && <Pager page={previewPage} noun="employees" />}
            {preview.skipped?.length > 0 && (
              <div className="notice amber" style={{ marginTop: 10 }}>
                <span>
                  <b>{preview.skipped.length} employee(s) will be skipped</b> — no salary structure set:{' '}
                  {preview.skipped.slice(0, 12).map((s) => `${s.name}${s.employeeCode ? ` (${s.employeeCode})` : ''}`).join(', ')}
                  {preview.skipped.length > 12 ? ` and ${preview.skipped.length - 12} more` : ''}.
                </span>
              </div>
            )}
            {preview.locked?.length > 0 && (
              <div className="small-muted" style={{ marginTop: 8 }}>{preview.locked.length} record(s) are already beyond draft and will not be recalculated.</div>
            )}
            {!preview.alreadyProcessed && preview.rows.length > 0 && (
              <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={confirm}>{preview.hasEntries ? 'Confirm & recalculate drafts' : 'Confirm & create drafts'}</button>
            )}
          </div>
        )}
      </PanelPad>

      {/* SPEC B — the month's per-employee records: approval, Accounts sync, mark paid. */}
      <PayrollRunBoard month={month} reloadKey={boardKey} onChanged={loadRuns} />

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Payroll history" />
        {runs.length > 0 && <div style={{ padding: '12px 18px 0' }}><ListFilterBar lf={runsLf} storageKey="payroll-history" noun="runs" /></div>}
        {runs.length === 0 ? <EmptyMini>No payroll has been processed yet.</EmptyMini> : runsLf.rows.length === 0 ? <ListEmpty lf={runsLf} noun="runs" /> : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Month</th><th>Employees</th><th>Total Gross</th><th>Total Net</th><th>Status</th><th>Processed On</th></tr></thead>
              <tbody>
                {runsPage.slice.map((r) => (
                  <tr key={r.id}>
                    <td>{r.period}</td>
                    <td className="cell-muted">{r.employees}</td>
                    <td className="cell-muted">{inr(r.totalGross)}</td>
                    <td className="cell-muted">{inr(r.totalNet)}</td>
                    <td>
                      {r.perEmployee ? (
                        <>
                          <span className={`status ${r.status === 'Paid' ? 'active' : 'pending'}`}>{r.status}</span>
                          {' '}<button className="btn btn-sm" onClick={() => { setMonth(r.month); setBoardKey((k) => k + 1); }}>Open</button>
                        </>
                      ) : (
                        <>
                          <span className={`status ${r.status === 'Paid' ? 'active' : 'pending'}`}>{r.status === 'Paid' ? 'Paid' : 'Processed'}</span>
                          {r.status !== 'Paid' && <> <button className="btn btn-sm" onClick={() => markPaid(r.id)}>Mark paid</button></>}
                        </>
                      )}
                    </td>
                    <td className="cell-muted">{r.processedAt ? new Date(r.processedAt).toISOString().slice(0, 10) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {runsPage.total > 0 && <Pager page={runsPage} noun="runs" />}
      </Panel>
    </div>
  );
}

// ---- Tab 5: Payslips --------------------------------------------------------

function PayslipsTab({ seesOthers }) {
  const [payslips, setPayslips] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { api.get('/payroll').then((res) => setPayslips(res.data)); }, []);

  // Search · Department · Month | More: Pay type — the employee filters only
  // for a login that sees other people's payslips.
  const months = [...new Set(payslips.map((p) => p.month).filter(Boolean))].sort().reverse();
  const lf = useListFilters(payslips, [
    { key: 'q', type: 'search', placeholder: 'Search employee name or ID…', get: (p) => `${p.employee?.employeeCode || ''} ${p.employee?.name || ''}`, show: seesOthers },
    { key: 'department', label: 'Department', get: (p) => p.employee?.department, primary: true, show: seesOthers },
    { key: 'month', label: 'Month', options: months.map((m) => ({ value: m, label: monthLabel(m) })), get: (p) => p.month, primary: true },
    { key: 'payMode', label: 'Pay type', allLabel: 'All pay types', get: (p) => p.payMode || 'Package' },
  ], {
    sorts: [
      { key: 'month', label: 'Newest month first', cmp: (a, b) => String(b.month || '').localeCompare(String(a.month || '')) || String(a.employee?.name || '').localeCompare(String(b.employee?.name || '')) },
      ...(seesOthers ? [{ key: 'name', label: 'Employee A–Z', cmp: (a, b) => String(a.employee?.name || '').localeCompare(String(b.employee?.name || '')) }] : []),
      { key: 'net', label: 'Net (high to low)', cmp: (a, b) => (Number(b.netPay) || 0) - (Number(a.netPay) || 0) },
    ],
  });
  const filtered = lf.rows;
  const page = usePaged(filtered);
  const totalDed = (p) => (p.deductions || 0) + (p.lopDeduction || 0) + (p.lateCut || 0);

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title={seesOthers ? 'Payslips' : 'My Payslips'} />
      {payslips.length > 0 && (
        <div style={{ padding: '12px 18px 0' }}>
          <ListFilterBar
            lf={lf} storageKey="payroll-payslips" noun="payslips"
            // The export takes the same filters (routes/insights.js payslips()).
            // Export all (these filters) · Export one employee; Import is
            // shown disabled with the reason — payslips come from the run.
            extra={seesOthers
              ? <DataIoBar ioKey="payslips" exportUrl="/insights/payroll/export" params={lf.params} showImport={false} />
              // An employee exports their own payslip register (the server
              // pins it to their own record). Each payslip also has its PDF.
              : <ExportMenu url="/insights/payroll/export" params={{ mine: '1' }} label="Export my payslips" />}
          />
        </div>
      )}
      {error && <div className="error-text" style={{ padding: '0 18px' }}>{error}</div>}
      {payslips.length === 0 ? <EmptyMini>{seesOthers ? 'No payslips generated yet — run payroll from the Process Payroll tab.' : 'No payslips yet — they appear here once payroll is run for a month.'}</EmptyMini> : filtered.length === 0 ? <ListEmpty lf={lf} noun="payslips" /> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Period</th><th>Code</th><th>Employee</th><th>Pay Type</th><th>Gross</th><th>Deductions</th><th>LOP Days</th><th>Net</th><th></th></tr></thead>
            <tbody>
              {page.slice.map((p) => (
                <tr key={p.id}>
                  <td>{monthLabel(p.month)}</td>
                  <td><b>{p.employee?.employeeCode || '—'}</b></td>
                  <td>{p.employee?.name}</td>
                  <td className="cell-muted">{p.payMode || 'Package'}</td>
                  <td className="cell-muted">{inr(p.gross)}</td>
                  <td className="cell-muted">{inr(totalDed(p))}</td>
                  <td className="cell-muted">{p.lopDays || 0}</td>
                  <td><b>{inr(p.netPay)}</b></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" onClick={() => setViewing(p.id)}>View</button>{' '}
                    <button
                      className="btn btn-sm"
                      onClick={() => { setError(''); downloadPayslipPdf({ id: p.id, month: p.month, employee: p.employee }).catch(() => setError('Could not download the payslip.')); }}
                    >
                      PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.total > 0 && <Pager page={page} noun="payslips" />}
      {viewing && <PayslipView payslipId={viewing} onClose={() => setViewing(null)} />}
    </Panel>
  );
}

export default function Payroll() {
  const { user } = useAuth();
  const canRun = canRunPayroll(user);
  const isAdmin = hasAdminAccess(user);
  // `export` without `create` is the view-only oversight (Manager / Assistant
  // Manager): payslips inside their scope, nothing to run or edit.
  const viewOnly = !canRun && can(user, 'hrms', 'hrms', 'Payroll & Compensation', 'export');
  // SPEC B: who sees the month's payroll records without running payroll —
  // approvers (incl. an Accounts role with approve), Accounts (sync / mark
  // paid) and the view-only oversight roles.
  const canSeeRuns = canRun || viewOnly
    || can(user, 'hrms', 'hrms', 'Payroll & Compensation', 'approve')
    || can(user, 'accounts', 'accounts', 'Journal & Ledger', 'view');
  const [tab, setTab] = useState('dashboard');

  const banner = isAdmin
    ? <ScopeNote amber>Full, unrestricted access — configures pay structures, processes/approves any run, organization-wide.</ScopeNote>
    : canRun
      ? <ScopeNote>Sets salary structures and runs payroll for the employees inside your scope.</ScopeNote>
      : viewOnly
        ? <ScopeNote>View only — payslips inside your scope. Salary structures and payroll runs are managed by HR / Accounts.</ScopeNote>
        : <ScopeNote>You are seeing your own salary structure and payslips only. Pay structures are set by HR.</ScopeNote>;

  return (
    <TabsPage
      title="Payroll Management"
      subtitle={<>Signed in as: <b>{user?.name}</b></>}
      banner={banner}
      value={tab}
      onChange={setTab}
      tabs={[
        { key: 'dashboard', label: canRun ? 'Dashboard' : 'My Salary Structure', element: <DashboardTab canRun={canRun} isAdmin={isAdmin} goTab={setTab} /> },
        ...(canRun ? [
          { key: 'reports', label: 'Reports', element: <ReportsTab canRun={canRun} canViewLedger={can(user, 'accounts', 'accounts', 'Journal & Ledger', 'view')} /> },
          { key: 'structure', label: 'Salary Structure', element: <StructureTab canRun={canRun} isAdmin={isAdmin} /> },
          { key: 'process', label: 'Process Payroll', element: <ProcessTab canRun={canRun} canSeeRuns={canSeeRuns} /> },
        ] : []),
        ...(!canRun && canSeeRuns ? [
          { key: 'process', label: viewOnly ? 'Payroll Runs' : 'Approve & Pay', element: <ProcessTab canRun={false} canSeeRuns /> },
          { key: 'compliance', label: 'Compliance', element: <CompliancePanel /> },
        ] : []),
        { key: 'payslips', label: canRun || viewOnly ? 'Payslips' : 'My Payslips', element: <PayslipsTab seesOthers={canRun || viewOnly} /> },
      ]}
    />
  );
}
