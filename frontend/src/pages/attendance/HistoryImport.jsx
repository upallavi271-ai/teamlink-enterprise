import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead } from '../../components/proto.jsx';
import { downloadFrom } from './MyAttendance.jsx';
import { ScrollTable } from './DayReport.jsx';

// ---- Sample files -------------------------------------------------------------
// The exact headers utils/attendanceHistoryImport.js reads, one file per kind,
// with two obviously made-up rows. Built here in the browser — no real data.
// The summary's period is read from its FILE NAME ("DD-mon-YYYY_to_DD-mon-YYYY").
const SAMPLES = [
  {
    key: 'report',
    label: 'Check-in / check-out report',
    hint: 'First Check-In & Last Check-Out report: one row per employee per day',
    file: 'sample-first-checkin-last-checkout-report.csv',
    headers: ['Employee Ref No', 'Employee Name', 'Date', 'First Check In', 'Last Check Out', 'Total Time Worked', 'Total Time In Break', 'Total Hours', 'Work Location'],
    rows: [
      ['SAMPLE001', 'Sample Employee One', '05-JAN-2026', '09:05:10', '18:10:45', '08:35:35', '00:30:00', '09:05:35', 'Sample Office'],
      ['SAMPLE002', 'Sample Employee Two', '05-JAN-2026', '09:40:02', '', '', '', '', 'Sample Office'],
    ],
  },
  {
    key: 'logs',
    label: 'Bio-metric logs',
    hint: 'Every punch time of the day in "Time Interval", separated by |',
    file: 'sample-biometric-logs.csv',
    headers: ['Employee', 'Attendance Date', 'Time Interval'],
    rows: [
      ['SAMPLE001 - Sample Employee One', '05-JAN-2026', '09:05:10|13:00:02|13:30:15|18:10:45'],
      ['SAMPLE002 - Sample Employee Two', '05-JAN-2026', '09:40:02|09:40:05'],
    ],
  },
  {
    key: 'summary',
    label: 'Attendance summary',
    hint: 'Totals per employee for a period — keep the period in the file name',
    file: 'sample-attendance-summary_01-jan-2026_to_31-jan-2026.csv',
    headers: ['Employee Ref No', 'Employee Name', 'Location', 'Half-Day', 'Present', 'Week Offs', 'Public Holidays', 'Leaves', 'Payable Days', 'Total Hours'],
    rows: [
      ['SAMPLE001', 'SAMPLE001-Sample Employee One', 'Sample Office', '1', '20', '4', '1', '1', '26.5', '172:30:00'],
      ['SAMPLE002', 'SAMPLE002-Sample Employee Two', 'Sample Office', '0', '18', '4', '1', '2', '25', '150:10:00'],
    ],
  },
];
const csvCell = (v) => (/[",\n|]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function downloadSample(s) {
  const text = [s.headers, ...s.rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const href = URL.createObjectURL(new Blob([`${text}\r\n`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = href; a.download = s.file;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

// ---- Imported-history filters -------------------------------------------------
const NO_HIST_FILTERS = { from: '', to: '', department: '', code: '', name: '', match: '' };
const HIST_CHIPS = [
  { key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'department', label: 'Department' },
  { key: 'code', label: 'Employee ID' }, { key: 'name', label: 'Name' }, { key: 'match', label: 'Match' },
];
function useDepartmentList() {
  const [list, setList] = useState([]);
  useEffect(() => { api.get('/admin/departments').then((r) => setList(r.data.map((d) => d.name))).catch(() => setList([])); }, []);
  return list;
}

// ---------------------------------------------------------------------------
// Attendance → Import History: past attendance from the old HRMS (PulseHRM
// CSV exports). Choose the files → Preview (writes nothing) → Import.
// Server: routes/attendance.js /history/*, utils/attendanceHistoryImport.js.
//
// Employee ID is the only matching key; name, department, designation and
// role always come from Employee Management. Existing TeamLink attendance is
// never changed — only empty check-in / check-out times are filled.
// ---------------------------------------------------------------------------

const ACTION_LABEL = {
  create: 'New days created (Present)',
  fill: 'Times added to existing days (status unchanged)',
  keep: 'Existing days already complete — kept',
  conflict: 'Kept — TeamLink marks the day Absent / Leave',
  'history-only': 'Punch times only (no first check-in) — stored, not created',
  unmatched: 'Unmatched Employee — stored, nothing created',
  skip: 'Already imported — skipped',
};

function readText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsText(file);
  });
}

function PlanView({ plan }) {
  const f = plan.files;
  return (
    <div style={{ padding: '0 18px 14px', fontSize: 13 }}>
      <div className="small-muted" style={{ margin: '4px 0 8px' }}>
        {f.report && <div>First check-in / last check-out report: <b>{f.report.rows}</b> rows ({f.report.name})</div>}
        {f.logs && <div>Bio-metric logs: <b>{f.logs.rows}</b> rows ({f.logs.name})</div>}
        {f.summary && <div>Attendance summary: <b>{f.summary.rows}</b> rows, period {f.summary.period?.from || '?'} to {f.summary.period?.to || '?'} ({f.summary.name})</div>}
        {f.unknown?.length > 0 && <div style={{ color: 'var(--red)' }}>Not recognised, ignored: {f.unknown.join(', ')}</div>}
      </div>
      <div className="tbl-wrap"><table>
        <thead><tr><th>Employee-days ({plan.days.total})</th><th style={{ textAlign: 'right' }}>Count</th></tr></thead>
        <tbody>
          {Object.entries(plan.days.byAction).map(([k, v]) => (
            <tr key={k}><td>{ACTION_LABEL[k] || k}</td><td style={{ textAlign: 'right' }}><b>{v}</b></td></tr>
          ))}
          <tr><td className="cell-muted">Check-in / check-out punches added</td><td style={{ textAlign: 'right' }}>{plan.days.punchesToAdd ?? plan.result?.punchesCreated}</td></tr>
          {plan.summaries.total > 0 && Object.entries(plan.summaries.byAction).map(([k, v]) => (
            <tr key={`s-${k}`}><td>Period summaries — {k === 'import' ? 'to import' : k === 'skip' ? 'already imported' : k === 'unmatched' ? 'Unmatched Employee' : k}</td><td style={{ textAlign: 'right' }}><b>{v}</b></td></tr>
          ))}
        </tbody>
      </table></div>

      {plan.unmatched.length > 0 ? (
        <div className="notice amber" style={{ marginTop: 10 }}><div>
          <b>{plan.unmatched.length} Unmatched Employee ID(s)</b> — not in Employee Management, so nothing is created for them.
          Their rows are stored as <i>Unmatched Employee</i>; add the employee and import again to apply them.
          <div style={{ marginTop: 4 }}>{plan.unmatched.map((u) => `${u.employeeRef}${u.sourceName ? ` (${u.sourceName})` : ''}`).join(', ')}</div>
        </div></div>
      ) : <div className="notice" style={{ marginTop: 10 }}>Every Employee ID in the files matches Employee Management.</div>}

      {plan.conflicts.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{plan.conflicts.length} day(s) kept because TeamLink marks them Absent / Leave</summary>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Employee ID</th><th>Employee (Employee Management)</th><th>Date</th><th>TeamLink status</th><th>File: first in</th><th>File: last out</th></tr></thead>
            <tbody>{plan.conflicts.map((c) => (
              <tr key={`${c.employeeRef}-${c.date}`}><td>{c.employeeRef}</td><td>{c.employee}</td><td>{c.date}</td><td>{c.existingStatus}</td><td>{c.firstCheckIn || '—'}</td><td>{c.lastCheckOut || '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      )}
      {plan.problemCount > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--red)' }}>{plan.problemCount} row(s) could not be read</summary>
          <ul style={{ fontSize: 12 }}>{plan.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export default function HistoryImport() {
  const [files, setFiles] = useState([]);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hist, setHist] = useState(null);
  const [sums, setSums] = useState(null);
  // The imported-history filters: status, date range, department, Employee ID
  // and name. Typed filters wait a moment before asking the server.
  const [hf, setHf] = useState(NO_HIST_FILTERS);
  const [applied, setApplied] = useState(NO_HIST_FILTERS);
  const departments = useDepartmentList();
  useEffect(() => { const t = setTimeout(() => setApplied(hf), 350); return () => clearTimeout(t); }, [hf]);
  const histParams = () => Object.fromEntries(Object.entries({
    matchStatus: applied.match, from: applied.from, to: applied.to, department: applied.department, code: applied.code, name: applied.name,
  }).filter(([, v]) => v));

  function loadHistory() {
    api.get('/attendance/history', { params: { ...histParams(), limit: 200 } }).then((r) => setHist(r.data)).catch(() => setHist(null));
    api.get('/attendance/history/summary').then((r) => setSums(r.data)).catch(() => setSums(null));
  }
  useEffect(loadHistory, [applied]); // eslint-disable-line react-hooks/exhaustive-deps
  const setH = (k, v) => setHf((f) => ({ ...f, [k]: v }));
  const chips = HIST_CHIPS.filter((c) => applied[c.key]);

  async function send(dryRun) {
    setError(''); setNotice(''); setBusy(dryRun ? 'Checking the files…' : 'Importing…');
    try {
      const payload = { files: await Promise.all(files.map(async (f) => ({ name: f.name, text: await readText(f) }))) };
      const r = await api.post(`/attendance/history/import${dryRun ? '?dryRun=1' : ''}`, JSON.stringify(payload), {
        headers: { 'Content-Type': 'text/plain' }, timeout: 300000,
      });
      setPlan(r.data);
      if (!dryRun) {
        const x = r.data.result;
        setNotice(`Imported: ${x.historyRows} day row(s) stored, ${x.daysCreated} day(s) created, ${x.daysFilled} existing day(s) given their times, ${x.punchesCreated} punch(es), ${x.summaryRows} period summary row(s).`);
        loadHistory();
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'The import failed. Nothing was changed.');
    } finally { setBusy(''); }
  }

  return (
    <>
      <Panel>
        <PanelHead title="Import past attendance (old HRMS CSV exports)" />
        <div style={{ padding: '12px 18px', fontSize: 13, lineHeight: 1.6 }}>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Choose any of: the <b>First Check-In &amp; Last Check-Out report</b>, the <b>Bio-metric logs</b> and the <b>Attendance summary</b> (.csv).
            Employees are matched by <b>Employee ID</b> only; name, department, designation, role and team always come from Employee Management.
            Existing attendance is never changed — only an empty check-in / check-out is filled. Importing the same file again adds nothing twice.
          </div>
          {/* SAMPLE FILES — one per layout the importer accepts. A file whose
              headers match none of them is refused with the expected list. */}
          <div className="att-samples">
            <div className="att-samples-head">Sample files — download one, fill it in, import it</div>
            <div className="att-samples-grid">
              {SAMPLES.map((s) => (
                <div key={s.key} className="att-sample">
                  <button type="button" className="btn btn-sm btn-primary" title={s.hint} onClick={() => downloadSample(s)}>⬇ Download sample file — {s.label}</button>
                  <div className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>{s.hint}</div>
                  <div className="small-muted" style={{ fontSize: 11, marginTop: 2 }}>Columns: {s.headers.join(', ')}</div>
                  {s.key === 'summary' && (
                    <div style={{ fontSize: 11.5, marginTop: 4 }}>
                      <b>File name rule:</b> the summary&apos;s period is read from its file name — keep <code>_DD-mon-YYYY_to_DD-mon-YYYY</code> in it,
                      e.g. <code>attendance_summary_01-sep-2025_to_01-jan-2026.csv</code>.
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="small-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              Each sample has the exact column headers the import reads and two made-up rows (SAMPLE001, SAMPLE002 — not real people).
              Dates are DD-MON-YYYY (05-JAN-2026), times HH:MM:SS. A file whose headers match none of these layouts is refused and nothing is changed.
            </div>
          </div>
          <input type="file" accept=".csv,text/csv" multiple onChange={(e) => { setFiles([...e.target.files]); setPlan(null); setNotice(''); setError(''); }} />
          {files.length > 0 && <div className="small-muted" style={{ marginTop: 4 }}>{files.map((f) => f.name).join(' · ')}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-sm" disabled={!files.length || !!busy} onClick={() => send(true)}>Preview</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!plan?.preview || !!busy} onClick={() => send(false)}>Import</button>
            {busy && <span className="small-muted" style={{ alignSelf: 'center' }}>{busy}</span>}
          </div>
          {!plan && files.length > 0 && <div className="small-muted" style={{ marginTop: 6 }}>Preview first — it shows exactly what will happen and writes nothing.</div>}
          {error && <div className="notice red" style={{ marginTop: 10 }}>{error}</div>}
          {notice && <div className="notice" style={{ marginTop: 10 }}>{notice}</div>}
        </div>
        {plan && (
          <>
            <div style={{ padding: '0 18px 4px', fontWeight: 700 }}>{plan.preview ? 'Preview — nothing written yet' : 'Import result'}</div>
            <PlanView plan={plan} />
          </>
        )}
      </Panel>

      <Panel>
        <PanelHead title={`Imported past attendance${hist ? ` (${hist.total} of ${hist.totalAll ?? hist.total} day rows)` : ''}`}>
          <button type="button" className="btn btn-sm btn-primary" disabled={!hist?.total}
            onClick={() => downloadFrom('/attendance/history', { ...histParams(), format: 'xlsx' }, 'past-attendance-import.xlsx')}>Export (Excel)</button>
        </PanelHead>
        <div style={{ padding: '12px 18px 0' }}>
          <div className="filter-row">
            <label className="small-muted" style={{ alignSelf: 'center', margin: 0 }}>From</label>
            <input type="date" value={hf.from} onChange={(e) => setH('from', e.target.value)} aria-label="From date" />
            <label className="small-muted" style={{ alignSelf: 'center', margin: 0 }}>To</label>
            <input type="date" value={hf.to} onChange={(e) => setH('to', e.target.value)} aria-label="To date" />
            <select value={hf.department} onChange={(e) => setH('department', e.target.value)} aria-label="Department">
              <option value="">All departments</option>
              {departments.map((d) => <option key={d}>{d}</option>)}
            </select>
            <input placeholder="Employee ID" value={hf.code} onChange={(e) => setH('code', e.target.value)} />
            <input placeholder="Search name" value={hf.name} onChange={(e) => setH('name', e.target.value)} />
            <select value={hf.match} onChange={(e) => setH('match', e.target.value)} aria-label="Match">
              <option value="">All rows</option>
              <option value="Matched">Matched</option>
              <option value="Unmatched Employee">Unmatched Employee</option>
            </select>
            {chips.length > 0 && <button type="button" className="btn btn-sm" onClick={() => { setHf(NO_HIST_FILTERS); setApplied(NO_HIST_FILTERS); }}>Clear All</button>}
          </div>
          <div className="att-hist-chips">
            {chips.map((c) => (
              <span key={c.key} className="att-hist-chip">
                {c.label}: <b>{applied[c.key]}</b>
                <button type="button" aria-label={`Remove ${c.label}`} onClick={() => { const next = { ...hf, [c.key]: '' }; setHf(next); setApplied(next); }}>✕</button>
              </span>
            ))}
            {hist && <span className="small-muted">{hist.total} of {hist.totalAll ?? hist.total} rows{hist.total > hist.rows.length ? ` · the latest ${hist.rows.length} shown, Export (Excel) has all of them` : ''}</span>}
          </div>
        </div>
        <ScrollTable><table>
          <thead><tr><th>Employee ID</th><th>Employee (Employee Management)</th><th>Department</th><th>Designation</th><th>Date</th><th>First Check In</th><th>Last Check Out</th><th>Total Hours</th><th>Punch Times</th><th>Result</th></tr></thead>
          <tbody>
            {(hist?.rows || []).map((r) => (
              <tr key={r.id}>
                <td><b>{r.employeeRef}</b></td>
                <td>{r.name || <span className="status rejected">Unmatched Employee{r.nameInFile ? ` · ${r.nameInFile}` : ''}</span>}</td>
                <td className="cell-muted">{r.department || '—'}</td>
                <td className="cell-muted">{r.designation || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
                <td>{r.firstCheckIn || '—'}</td><td>{r.lastCheckOut || '—'}</td><td>{r.totalHours || '—'}</td>
                <td className="cell-muted" style={{ fontSize: 12, maxWidth: 260 }}>{r.punchTimes.join(', ') || '—'}</td>
                <td className="cell-muted" style={{ fontSize: 12 }}>{r.result}</td>
              </tr>
            ))}
            {hist && !hist.rows.length && <tr><td colSpan="10" className="small-muted" style={{ padding: 14 }}>{hist.totalAll ? 'No imported rows match these filters.' : 'Nothing imported yet.'}</td></tr>}
          </tbody>
        </table></ScrollTable>
      </Panel>

      {sums && sums.length > 0 && (
        <Panel>
          <PanelHead title={`Period summaries (${sums.length})`} />
          <ScrollTable><table>
            <thead><tr><th>Employee ID</th><th>Employee (Employee Management)</th><th>Department</th><th>Designation</th><th>Period</th><th>Present</th><th>Half-Day</th><th>Week Offs</th><th>Public Holidays</th><th>Leaves</th><th>Payable Days</th><th>Total Hours</th></tr></thead>
            <tbody>{sums.map((s) => (
              <tr key={s.id}>
                <td><b>{s.employeeRef}</b></td>
                <td>{s.name || <span className="status rejected">Unmatched Employee{s.nameInFile ? ` · ${s.nameInFile}` : ''}</span>}</td>
                <td className="cell-muted">{s.department || '—'}</td><td className="cell-muted">{s.designation || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{s.periodFrom} to {s.periodTo}</td>
                <td>{s.present ?? '—'}</td><td>{s.halfDay ?? '—'}</td><td>{s.weekOffs ?? '—'}</td><td>{s.publicHolidays ?? '—'}</td>
                <td>{s.leaves ?? '—'}</td><td>{s.payableDays ?? '—'}</td><td>{s.totalHours || '—'}</td>
              </tr>
            ))}</tbody>
          </table></ScrollTable>
        </Panel>
      )}
    </>
  );
}
