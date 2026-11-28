// The month's per-employee payroll records (SPEC B), inside Process Payroll.
//
//   Attendance input  default from attendance, HR override with a reason
//   Records           DRAFT -> PENDING_APPROVAL -> APPROVED -> SYNCED -> PAID
//   Sync log          failed / pending Accounts deliveries, Retry
//
// Every button is shown from the `access` the API returns for this login, and
// the API refuses anything else anyway.
import { useEffect, useState } from 'react';
import api from '../../api';
import { useKeptState } from '../../utils/useKeptState.js';
import { Panel, PanelHead, EmptyMini, Modal, SectionLabel } from '../proto.jsx';
import {
  STATUS_LABEL, STATUS_CLS, SYNC_CLS, money, monthLabel, errText, bulkMessage,
} from './payrollUi';
import './payrollRun.css';
import ListFilterBar, { useListFilters, ListEmpty } from '../ui/ListFilters.jsx';
import Pager, { usePaged } from '../Pager.jsx';
import DataIoBar from '../dataio/DataIoBar.jsx';
import PayrollAccountsStrip from './PayrollAccountsStrip.jsx';
import { usePayrollCycle, monthHeading } from './payrollCycleUi.jsx';
// Payroll edit and recalculate (2026-10-13)
import PayrollEditor from './PayrollEditor.jsx';
import PayrollEditHistory, { ChangesInRun } from './PayrollEditHistory.jsx';
import Combo from '../Combo.jsx';
// Which dates are the LOP days (2026-11-19): the LOP number opens the dates, reasons and approvals behind it
import LopBreakdown, { LopLink } from './LopBreakdown.jsx';
// The salary breakup in the Details window (founder 2026-11-27)
import SalaryBreakdown from './SalaryBreakdown.jsx';

// Paise are shown when there are any (pay-register months are worked out to the paisa, 2026-10-28).
const inr0 = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`; };
const groupOf = (e) => (e.payMode === 'Stipend' ? 'Stipend' : 'Group A');
// Monthly CTC (founder 2026-11-27): the pay register's figure, else the salary structure's - the tooltip says which
const ctcFrom = (f) => (!f ? 'No CTC on the salary structure' : f.from === 'register' ? `From the ${monthLabel(f.month)} pay register` : 'From the salary structure');

// Joined inside the pay period (founder 2026-11-27): LOP is only what was lost after joining; the days before it are said apart
const lopOf = (e) => (e.join ? e.join.lopDays : e.daysLop);
const shortDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

// Salary credit date (founder 2026-11-28): 2 or more leave days applied after the pay period -> the 10th of the next month,
// else the last day of the payroll month. Worked out by the server (utils/payrollSalaryDate.js); absent = the rule is off.
const payDayOf = (e) => (e.salaryDate ? shortDay(e.salaryDate.date) : '');
const leaveText = (s) => (s && s.dates.length ? s.dates.map((x) => `${shortDay(x.date)}${x.value === 0.5 ? ' (half)' : ''}${x.waiting ? ' (waiting)' : ''}`).join(', ') : 'no leave');
const dayCount = (n) => `${n} leave day${n === 1 ? '' : 's'}`;
const PAYDAY_FIELD = { key: 'payday', label: 'Salary date', allLabel: 'Any salary date', get: payDayOf, primary: true };

// The list filter standard for the three tables on this board.
const empSearch = (code, name) => ({ key: 'q', type: 'search', placeholder: 'Search employee name or ID…', get: (r) => `${code(r) || ''} ${name(r) || ''}` });
// S3: the month is posted as one journal, so a record is Posted / Paid / Not posted.
const syncLabel = (e) => (e.status === 'PAID' ? 'Paid' : e.status === 'SYNCED_TO_ACCOUNTS' ? 'Posted' : 'Not posted');
const ENTRY_FIELDS = [
  empSearch((e) => e.employee?.employeeCode, (e) => e.employee?.name),
  { key: 'group', label: 'Group', allLabel: 'Group A and Stipend', options: ['Group A', 'Stipend'], get: groupOf, primary: true },
  { key: 'status', label: 'Status', options: Object.keys(STATUS_LABEL).map((k) => ({ value: k, label: STATUS_LABEL[k] })), get: (e) => e.status, primary: true },
  { key: 'department', label: 'Department', get: (e) => e.employee?.department, primary: true },
  { key: 'sync', label: 'Accounts', allLabel: 'Posted or not', options: ['Posted', 'Paid', 'Not posted'], get: syncLabel },
  { key: 'source', label: 'Attendance source', allLabel: 'Any attendance source', options: ['HR override', 'Attendance'], get: (e) => (e.attendanceSource === 'OVERRIDE' ? 'HR override' : 'Attendance') },
  { key: 'lop', label: 'Loss of pay', allLabel: 'Everyone', options: ['With LOP days'], match: (e) => Number(lopOf(e)) > 0 },
];
const ENTRY_SORTS = [
  { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.employee?.name || '').localeCompare(String(b.employee?.name || '')) },
  { key: 'net', label: 'Net (high to low)', cmp: (a, b) => (Number(b.netPay) || 0) - (Number(a.netPay) || 0) },
  { key: 'lop', label: 'LOP days (most first)', cmp: (a, b) => (Number(lopOf(b)) || 0) - (Number(lopOf(a)) || 0) },
  { key: 'payday', label: 'Salary date', cmp: (a, b) => String(a.salaryDate?.date || '').localeCompare(String(b.salaryDate?.date || '')) || String(a.employee?.name || '').localeCompare(String(b.employee?.name || '')) },
];
const ATT_FIELDS = [
  empSearch((r) => r.employeeCode, (r) => r.name),
  { key: 'department', label: 'Department', get: (r) => r.department, primary: true },
  { key: 'source', label: 'Source', allLabel: 'Any source', options: ['Override', 'Attendance'], get: (r) => (r.source === 'OVERRIDE' ? 'Override' : 'Attendance'), primary: true },
  { key: 'lop', label: 'Loss of pay', allLabel: 'Everyone', options: ['With LOP days'], match: (r) => Number(r.daysLop) > 0 },
];
const LOG_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search employee or key…', get: (l) => `${l.employeeName || ''} ${l.employeeCode || ''} ${l.idempotencyKey || ''}` },
  { key: 'status', label: 'Status', get: (l) => l.status, primary: true },
  { key: 'kind', label: 'Kind', options: [{ value: 'ACCRUAL', label: 'Salary journal' }, { value: 'PAYMENT', label: 'Bank payment' }], get: (l) => (l.kind === 'PAYMENT' ? 'PAYMENT' : 'ACCRUAL'), primary: true },
];

function AttendanceEditor({ row, month, onClose, onSaved }) {
  const [present, setPresent] = useState(String(row.daysPresent ?? ''));
  // joined / came back inside the pay period: the box counts loss of pay after that date only
  const early = row.join ? row.join.beforeDays : 0;
  const [lop, setLop] = useState(String(Math.max(0, Math.round(((Number(row.daysLop) || 0) - early) * 100) / 100)));
  const [reason, setReason] = useState(row.override?.reason || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      await api.put(`/payroll/attendance-inputs/${row.employeeId}`, { month, daysPresent: Number(present), daysLop: early + Number(lop), reason });
      onSaved();
    } catch (err) { setError(errText(err, 'Could not save the override.')); } finally { setBusy(false); }
  }
  const d = row.detail || {};
  return (
    <Modal
      title={`Attendance — ${row.name} · ${monthLabel(month)}`}
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save override'}</button>
        </>
      )}
    >
      <div className="prb-note">
        From attendance: {row.override ? row.override.autoDaysPresent : row.daysPresent} present · {row.override ? row.override.autoDaysLop : row.daysLop} LOP of {row.workingDays} payroll days
        {d.absent != null && <> (absent {d.absent}, half days {d.halfDay}, no check-in {d.missingCheckIn}, leave {d.onLeave}, late beyond allowance {d.excessLate})</>}.
        {early > 0 && <> The {early} day(s) before {row.join.word} ({shortDay(row.join.joinedOn)}) are not paid; type only the loss of pay after that date.</>}
      </div>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div className="field"><label>Days present</label><input type="number" min="0" step="0.5" value={present} onChange={(e) => setPresent(e.target.value)} /></div>
        <div className="field"><label>{row.join ? `LOP days (after ${row.join.word})` : 'LOP days'}</label><input type="number" min="0" step="0.5" value={lop} onChange={(e) => setLop(e.target.value)} /></div>
      </div>
      <div className="field"><label>Reason (recorded in the audit log)</label><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Approved regularization not yet in attendance" /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

function AttendancePanel({ month, canEdit, reloadKey, onChanged }) {
  usePayrollCycle();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  function load() {
    setError('');
    api.get(`/payroll/attendance-inputs?month=${month}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load attendance.')));
  }
  useEffect(() => { if (open) load(); }, [month, open, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const lf = useListFilters(data?.rows || [], ATT_FIELDS);
  const page = usePaged(lf.rows);
  async function revert(row) {
    try { await api.delete(`/payroll/attendance-inputs/${row.employeeId}?month=${month}`); load(); onChanged(); } catch (err) { setError(errText(err, 'Could not revert.')); }
  }
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title={`Attendance input — ${monthHeading(month)}`}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* This month's inputs: export all / one employee, and import HR
              overrides with the compulsory sample (src/io/payroll-attendance.js). */}
          {open && <DataIoBar ioKey="payroll-attendance" params={{ month }} onImported={() => { load(); onChanged(); }} />}
          <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>{open ? '− Hide' : '+ Show'}</button>
        </span>
      </PanelHead>
      {open && (
        <>
          <div className="prb-note" style={{ padding: '8px 18px 0' }}>
            Defaults come from the attendance module (absent, half days, days with no check-in, leave beyond the paid allowance, late arrivals beyond the free allowance).
            HR can override any employee before calculating; every override is audit-logged. Recalculate the payroll afterwards.
          </div>
          {error && <div className="error-text" style={{ padding: '0 18px' }}>{error}</div>}
          {data && data.rows.length > 0 && <div style={{ padding: '10px 18px 0' }}><ListFilterBar lf={lf} storageKey="payroll-attendance-input" noun="employees" /></div>}
          {!data ? <EmptyMini>Loading…</EmptyMini> : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Code</th><th>Name</th><th>Payroll days</th><th>Present</th><th>LOP</th><th>Source</th><th>Payroll</th><th /></tr></thead>
                <tbody>
                  {page.slice.map((r) => (
                    <tr key={r.employeeId}>
                      <td><b>{r.employeeCode}</b></td>
                      <td>{r.name}</td>
                      <td className="cell-muted">{r.workingDays}</td>
                      <td>{r.daysPresent}</td>
                      <td>{r.join && r.daysLop >= r.join.beforeDays
                        ? <>{Math.round((r.daysLop - r.join.beforeDays) * 100) / 100}<div className="prb-note">from {shortDay(r.join.joinedOn)}</div></>
                        : r.daysLop}</td>
                      <td>{r.source === 'OVERRIDE' ? <span className="status pending" title={`${r.override.reason} — ${r.override.by}`}>Override</span> : <span className="cell-muted">Attendance</span>}</td>
                      <td className="cell-muted">{r.payrollStatus ? STATUS_LABEL[r.payrollStatus] : '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (!r.payrollStatus || r.payrollStatus === 'DRAFT') && (
                          <>
                            <button className="btn btn-sm" onClick={() => setEditing(r)}>Override</button>{' '}
                            {r.source === 'OVERRIDE' && <button className="btn btn-sm" onClick={() => revert(r)}>Use attendance</button>}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && <tr><td colSpan="8" className="small-muted" style={{ padding: 14 }}>No payable employees in your scope.</td></tr>}
                  {data.rows.length > 0 && lf.rows.length === 0 && <tr><td colSpan="8"><ListEmpty lf={lf} noun="employees" /></td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {data && page.total > 0 && <Pager page={page} noun="employees" />}
        </>
      )}
      {editing && <AttendanceEditor row={editing} month={month} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); onChanged(); }} />}
    </Panel>
  );
}

function EntryDetail({ id, onClose }) {
  const [data, setData] = useState(null);
  const [lop, setLop] = useState(false); // the LOP dates drawer, opened from the days line
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/payroll/entries/${id}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load.'))); }, [id]);
  const e = data?.entry;
  const p = data?.journalPayload;
  return (
    <Modal title={e ? `${e.employee.name} · ${monthLabel(e.month)}` : 'Payroll record'} onClose={onClose} wide footer={<button className="btn btn-sm" onClick={onClose}>Close</button>}>
      {error && <div className="error-text">{error}</div>}
      {!e ? <div className="small-muted">Loading…</div> : (
        <div className="prb-detail">
          <div className="psb-who">
            <span>{[e.employee.employeeCode, e.employee.department, e.employee.designation].filter(Boolean).join(' · ')}</span>
            <span className={`status ${STATUS_CLS[e.status]}`}>{STATUS_LABEL[e.status]}</span>
            <span>{e.join ? `Counted from ${shortDay(e.join.joinedOn)} (${e.join.word}) to ${shortDay(e.join.periodTo)}` : data.period ? `Pay period ${data.period.rangeText}` : ''}</span>
          </div>
          {e.rejectionReason && <div className="psb-back"><b>Sent back:</b> {e.rejectionReason}</div>}
          {data.salaryDate && (
            <div className="prb-paydays inline" data-testid="detail-payday">
              <b>Salary date: {shortDay(data.salaryDate.date)}</b>
              <span className="prb-note">{dayCount(data.salaryDate.leaveDays)} from {shortDay(data.salaryDate.window.from)} to {shortDay(data.salaryDate.window.to)}{data.salaryDate.dates.length ? `: ${leaveText(data.salaryDate)}` : ''}</span>
            </div>
          )}
          <SalaryBreakdown entry={e} lines={data.lines} onLop={() => setLop(true)} ctcNote={e.monthlyCtc ? ctcFrom(e.monthlyCtcFrom) : ''} />
          {data.breakup && (
            <details className="psb-more">
              <summary>How it was worked out</summary>
              <div className="prb-kv">
                <span>Salary record used</span><b>{data.version ? `from ${monthLabel(data.version.effectiveFrom.slice(0, 7))}` : '—'}</b>
                <span>Rules used</span><b>{data.breakup.rules.mode}</b>
                <span>Earned parts</span><b>{data.breakup.rules.earned}</b>
                <span>PF</span><b>{data.breakup.rules.pf}</b>
                <span>ESI</span><b>{data.breakup.rules.esi}</b>
                <span>PT</span><b>{data.breakup.rules.pt}</b>
                <span>TDS</span><b>{data.breakup.rules.tds}</b>
                {data.breakup.calculatedAt && <><span>Calculated</span><b>{new Date(data.breakup.calculatedAt).toLocaleString('en-GB')}{data.breakup.calculatedBy ? ` by ${data.breakup.calculatedBy}` : ''}</b></>}
              </div>
            </details>
          )}
          <details className="psb-more">
            <summary>Accounts journal entry</summary>
            <div className="psb-note">This employee's share of the month's journal</div>
            <table className="prb-journal">
              <thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
              <tbody>
                {p.debit.map((l) => <tr key={`d${l.account}`}><td>{l.account}</td><td>{money(l.amount)}</td><td /></tr>)}
                {p.credit.map((l) => <tr key={`c${l.account}`}><td>{l.account}</td><td /><td>{money(l.amount)}</td></tr>)}
                <tr className="tot"><td>Total</td><td>{money(p.debit.reduce((n, l) => n + l.amount, 0))}</td><td>{money(p.credit.reduce((n, l) => n + l.amount, 0))}</td></tr>
              </tbody>
            </table>
            <div className="prb-note">{p.note || 'Part of the one journal entry booked for the whole month.'}</div>
          </details>
          <details className="psb-more">
            <summary>History of this record</summary>
            {data.history.length === 0 ? <div className="small-muted">No transitions yet.</div> : (
              <ul className="prb-hist">
                {data.history.map((h, i) => (
                  <li key={i}><b>{h.action.replace(/^Payroll /, '')}</b> {h.fromValue && h.toValue ? `(${STATUS_LABEL[h.fromValue] || h.fromValue} → ${STATUS_LABEL[h.toValue] || h.toValue})` : ''} — {h.actorName || 'System'}, {new Date(h.createdAt).toLocaleString('en-GB')}{h.reason && !h.reason.includes(' · ') ? ` · ${h.reason}` : ''}</li>
                ))}
              </ul>
            )}
            {data.syncLogs.length > 0 && (
              <>
                <SectionLabel style={{ margin: '14px 0 6px' }}>Accounts sync</SectionLabel>
                <ul className="prb-hist">
                  {data.syncLogs.map((l) => (
                    <li key={l.id}><span className={`status ${SYNC_CLS[l.status]}`}>{l.status}</span> {l.kind === 'PAYMENT' ? 'Bank payment' : 'Salary journal'} · {l.attempts} attempt(s){l.lastError ? ` · ${l.lastError}` : ''}</li>
                  ))}
                </ul>
              </>
            )}
          </details>
          {lop && <LopBreakdown entryId={id} onClose={() => setLop(false)} />}
        </div>
      )}
    </Modal>
  );
}

// (Mark paid is now one action for the whole month: PayrollAccountsStrip.jsx.)

export default function PayrollRunBoard({ month, reloadKey = 0, onChanged = () => {} }) {
  usePayrollCycle();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState({});
  const [detail, setDetail] = useState(null);
  const [attKey, setAttKey] = useState(0);
  const [stripKey, setStripKey] = useState(0);
  const [editId, setEditId] = useState(null); // the pay editor (Edit / Adjust)
  const [histId, setHistId] = useState(null); // the history drawer
  const [lopId, setLopId] = useState(null); // the LOP dates drawer
  const [changesKey, setChangesKey] = useState(0);

  function load() {
    setError('');
    api.get(`/payroll/entries?month=${month}`).then((r) => { setData(r.data); setSelected({}); }).catch((err) => setError(errText(err, 'Could not load the payroll records.')));
  }
  useEffect(load, [month, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = data?.access || {};
  const entries = data?.entries || [];
  // EVERYBODY ON THE LIST (founder 2026-11-24): payable employees with no record for the month, with the reason
  const missing = data?.missing || [];
  const readyIds = missing.filter((x) => x.canCalculate).map((x) => x.employeeId);
  const chosen = entries.filter((e) => selected[e.id]);
  const idsOr = (status) => {
    const pick = chosen.filter((e) => e.status === status);
    return chosen.length ? { ids: pick.map((e) => e.id) } : { month };
  };

  async function act(label, url, body) {
    setBusy(label); setMessage(''); setError('');
    try {
      const r = await api.post(url, body);
      // Approving the last pending record finalizes the month: it is posted
      // to Accounts as ONE journal (S3) — say what happened.
      const post = (r.data.posting || []).find((x) => x.month === month);
      const postText = !post ? '' : post.posted ? ` · Posted to Accounts${post.voucherNo ? ` (${post.voucherNo})` : ''}.` : post.error ? ` · Not posted to Accounts: ${post.error}` : '';
      setMessage((r.data.results ? bulkMessage(label, r.data) : `${label}: done`) + postText);
    } catch (err) {
      const d = err.response?.data;
      if (d?.results) setMessage(bulkMessage(label, d)); else setError(errText(err, `${label} failed`));
    } finally {
      setBusy(''); load(); onChanged(); setStripKey((k) => k + 1);
    }
  }
  async function recalc() {
    setBusy('Calculate'); setMessage(''); setError('');
    try {
      const r = await api.post('/payroll/calculate', { month });
      setMessage(`Calculated ${monthHeading(month)}: ${r.data.created} new record(s), ${r.data.updated} recalculated, ${r.data.locked.length} already submitted (left as they are)${(r.data.edited || []).length ? `, ${r.data.edited.length} edited by hand (left as edited)` : ''}, ${r.data.skipped.length} skipped (no structure effective this month).`);
    } catch (err) { setError(errText(err, 'Could not calculate.')); } finally { setBusy(''); load(); onChanged(); setAttKey((k) => k + 1); }
  }
  // Calculate just these people (the list of people with no record, under the table) - the same Calculate, limited to them.
  async function calcSome(ids) {
    setBusy('Calculate'); setMessage(''); setError('');
    try {
      const r = await api.post('/payroll/calculate', { month, employeeIds: ids });
      setMessage(`Calculated ${ids.length === 1 ? '1 person' : `${ids.length} people`} for ${monthHeading(month)}: ${r.data.created} new record(s)${r.data.skipped.length ? `, ${r.data.skipped.length} could not be calculated (see the reason in the list)` : ''}.`);
    } catch (err) { setError(errText(err, 'Could not calculate.')); } finally { setBusy(''); load(); onChanged(); setAttKey((k) => k + 1); }
  }
  async function reject() {
    const reason = window.prompt('Reason for sending back for changes');
    if (!reason) return;
    const ids = chosen.filter((e) => e.status === 'PENDING_APPROVAL').map((e) => e.id);
    if (!ids.length) { setError('Select the pending records to send back.'); return; }
    await act('Sent back', '/payroll/entries/reject', { ids, reason });
  }
  // Export the month's calculated payroll (founder 2026-10-27): the same records as the table, Excel or CSV.
  async function exportAs(format) {
    setBusy(format === 'xlsx' ? 'Making Excel' : 'Making CSV'); setError('');
    try {
      const res = await api.get(`/payroll/runs/${month}/export`, { params: { format }, responseType: 'blob' });
      const cd = res.headers['content-disposition'] || '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      const href = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = href; link.download = (m && m[1]) || `payroll-${month}.${format}`; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 2000);
      setMessage(`${format === 'xlsx' ? 'Excel' : 'CSV'} file is ready.`);
    } catch (err) {
      let msg = 'The file could not be made.';
      const d = err.response && err.response.data;
      if (d instanceof Blob) { try { msg = JSON.parse(await d.text()).error || msg; } catch { /* keep */ } } else if (d && d.error) msg = d.error;
      setError(msg);
    } finally { setBusy(''); }
  }
  const count = (s) => (data?.byStatus || {})[s] || 0;
  // Filters narrow what is SHOWN; the header checkbox ticks the rows shown.
  // A bulk button with nothing ticked still acts on the whole month, as it
  // always has — the note under the bar says so while a filter is on.
  const paydays = data?.salaryDates || null;
  const lf = useListFilters(entries, [ENTRY_FIELDS[0], { ...PAYDAY_FIELD, show: !!paydays }, ...ENTRY_FIELDS.slice(1)], { sorts: paydays ? ENTRY_SORTS : ENTRY_SORTS.filter((x) => x.key !== 'payday') });
  const page = usePaged(lf.rows);
  const allOn = lf.rows.length > 0 && lf.rows.every((e) => selected[e.id]);
  const showOther = entries.some((e) => Number(e.otherDeductions) > 0);

  return (
    <div className="prb">
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title={`Salaries — ${monthHeading(month)}`}>
          {a.prepare && <button className="btn btn-sm btn-primary" disabled={!!busy} title={entries.length ? 'Work out the month again from the salary structures and attendance (records already submitted stay as they are)' : 'Work out every salary for this month'} onClick={recalc}>{busy === 'Calculate' ? 'Calculating…' : 'Calculate'}</button>}
          {a.export && entries.length > 0 && <button className="btn btn-sm" disabled={!!busy} onClick={() => exportAs('xlsx')}>Export Excel</button>}
          {a.export && entries.length > 0 && <button className="btn btn-sm" disabled={!!busy} onClick={() => exportAs('csv')}>Export CSV</button>}
        </PanelHead>
        <div className="prb-bar">
          {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SYNCED_TO_ACCOUNTS', 'PAID'].map((s) => (
            <span key={s} className={`prb-chip ${count(s) ? '' : 'zero'}`}><span className={`status ${STATUS_CLS[s]}`}>{STATUS_LABEL[s]}</span> {count(s)}</span>
          ))}
          {missing.length > 0 && <span className="prb-chip" title="People on the payroll who have no salary record for this month yet - listed under the table"><span className="status pending">No record</span> {missing.length}</span>}
          {data && (
            <span className="prb-tot">
              Net to pay {inr0(data.totals.netPay)}
              {entries.some((x) => x.payMode === 'Stipend') && entries.some((x) => x.payMode !== 'Stipend') && (
                <> · Group A {inr0(entries.filter((x) => x.payMode !== 'Stipend').reduce((n, x) => n + Number(x.netPay || 0), 0))} · Stipend {inr0(entries.filter((x) => x.payMode === 'Stipend').reduce((n, x) => n + Number(x.netPay || 0), 0))}</>
              )}
            </span>
          )}
        </div>
        {paydays && entries.length > 0 && (
          <div className="prb-paydays" data-testid="prb-paydays">
            <b>Salary date:</b>
            {[paydays.onTime, paydays.late].map((d) => {
              const list = entries.filter((x) => x.salaryDate && x.salaryDate.date === d);
              const on = lf.values.payday === shortDay(d);
              return (
                <button key={d} type="button" className={`prb-payday ${on ? 'on' : ''}`} title={on ? 'Show everybody again' : `Show only the people paid on ${shortDay(d)}`} onClick={() => lf.setValue('payday', on ? '' : shortDay(d))}>
                  <b>{shortDay(d)}</b> {list.length} {list.length === 1 ? 'person' : 'people'} · {inr0(list.reduce((n, x) => n + Number(x.netPay || 0), 0))}
                </button>
              );
            })}
            <span className="prb-note">
              {shortDay(paydays.late)} = {paydays.threshold} or more leave days applied from {shortDay(paydays.window.from)} to {shortDay(paydays.window.to)} (approved or waiting).
              {paydays.closed ? '' : ` This can still change until ${shortDay(paydays.window.to)}.`}
            </span>
          </div>
        )}
        <PayrollAccountsStrip month={month} reloadKey={reloadKey + stripKey} onChanged={() => { load(); onChanged(); }} />
        <div className="prb-actions">
          {a.prepare && <button className="btn btn-sm" disabled={!!busy || (!count('DRAFT'))} onClick={() => act('Submitted', '/payroll/entries/submit', idsOr('DRAFT'))}>Submit {chosen.length ? 'selected' : 'all'} for approval</button>}
          {a.approve && (
            <>
              <button className="btn btn-sm" disabled={!!busy || !count('PENDING_APPROVAL')} onClick={() => act('Approved', '/payroll/entries/approve', idsOr('PENDING_APPROVAL'))}>Approve {chosen.length ? 'selected' : 'all pending'}</button>
              <button className="btn btn-sm" disabled={!!busy || !chosen.some((e) => e.status === 'PENDING_APPROVAL')} onClick={reject}>Send back</button>
              <span className="prb-note">When every record is approved, the month is posted to Accounts as one journal.</span>
            </>
          )}
          {!a.prepare && !a.approve && !a.post && <span className="prb-note">View only.</span>}
          {a.edit && entries.length > 0 && !entries.some((x) => !x.lock) && <span className="prb-note" data-testid="month-lock-note">{(entries.find((x) => x.lock) || {}).lock?.message}</span>}
          {busy && <span className="prb-note">{busy}…</span>}
        </div>
        {message && <div className="prb-msg">{message}</div>}
        {error && <div className="error-text" style={{ padding: '0 18px 8px' }}>{error}</div>}
        {data && entries.length > 0 && (
          <div style={{ padding: '4px 18px 0' }}>
            <ListFilterBar lf={lf} storageKey="payroll-entries" noun="records" />
            {lf.activeCount > 0 && (a.prepare || a.approve || a.post) && !chosen.length && (
              <div className="prb-note" style={{ marginBottom: 6 }}>
                The buttons above act on the whole month while nothing is ticked — tick rows (or the header box) to act on the filtered records only.
              </div>
            )}
          </div>
        )}
        {!data ? <EmptyMini>Loading…</EmptyMini> : entries.length === 0 ? (
          <EmptyMini>No salaries worked out for {monthLabel(month)} yet{a.prepare ? ' — press Calculate.' : '.'}</EmptyMini>
        ) : lf.rows.length === 0 ? <ListEmpty lf={lf} noun="payroll records" /> : (
          <div className="tbl-wrap">
            <table className="prb-table">
              <thead>
                <tr>
                  <th><input type="checkbox" checked={allOn} title="Tick every record the filters show" onChange={(e) => setSelected(e.target.checked ? Object.fromEntries(lf.rows.map((x) => [x.id, true])) : {})} /></th>
                  <th>Code</th><th>Name</th><th>Group</th><th title="Cost to company per month: the pay register's figure, else the salary structure's">Monthly CTC</th><th title="Days paid in the pay period">Paid days</th><th title="Days not paid (loss of pay)">LOP days</th><th title="Pay for the paid days">Earned</th><th>PF</th><th>ESI</th><th>PT</th><th>TDS</th>{showOther && <th>Other</th>}<th>Net pay</th>{paydays && <th title={`The date the salary is credited: ${shortDay(paydays.late)} for ${paydays.threshold} or more leave days after the pay period, else ${shortDay(paydays.onTime)}`}>Salary date</th>}<th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {page.slice.map((e) => (
                  <tr key={e.id}>
                    <td><input type="checkbox" checked={!!selected[e.id]} onChange={(ev) => setSelected((s) => ({ ...s, [e.id]: ev.target.checked }))} /></td>
                    <td><b>{e.employee.employeeCode}</b></td>
                    <td>{e.employee.name}</td>
                    <td className="cell-muted">{groupOf(e)}</td>
                    <td title={ctcFrom(e.monthlyCtcFrom)}>{e.monthlyCtc ? inr0(e.monthlyCtc) : '—'}</td>
                    <td>{e.workingDays - e.daysLop}<span className="cell-muted"> / {e.join ? e.join.daysFromJoining : e.workingDays}</span>{e.attendanceSource === 'OVERRIDE' ? <span className="cell-muted" title="Days typed or imported by HR"> *</span> : null}{e.join && <div className="prb-note" title="Joined in this pay period: the days are counted from the joining date">from {shortDay(e.join.joinedOn)}</div>}</td>
                    <td className="cell-muted"><LopLink value={lopOf(e)} onOpen={() => setLopId(e.id)} title={`Click to see which dates were counted as loss of pay for ${e.employee.name}, and why`} /></td>
                    <td>{inr0(e.earnedGross)}</td>
                    <td className="cell-muted">{inr0(e.pfEmployee)}</td>
                    <td className="cell-muted">{inr0(e.esiEmployee)}</td>
                    <td className="cell-muted">{inr0(e.professionalTax)}</td>
                    <td className="cell-muted">{inr0(e.tds)}</td>
                    {showOther && <td className="cell-muted">{inr0(e.otherDeductions)}</td>}
                    <td><b>{inr0(e.netPay)}</b></td>
                    {paydays && (
                      <td style={{ whiteSpace: 'nowrap' }} title={e.salaryDate ? `${dayCount(e.salaryDate.leaveDays)} from ${shortDay(paydays.window.from)} to ${shortDay(paydays.window.to)}: ${leaveText(e.salaryDate)}` : ''}>
                        {e.salaryDate ? <><span className={`prb-paytag ${e.salaryDate.late ? 'late' : ''}`}>{shortDay(e.salaryDate.date)}</span>{e.salaryDate.leaveDays > 0 && <div className="prb-note">{dayCount(e.salaryDate.leaveDays)}</div>}</> : '—'}
                      </td>
                    )}
                    <td>
                      <span className={`status ${STATUS_CLS[e.status]}`}>{STATUS_LABEL[e.status]}</span>
                      {e.edit && e.edit.edited && <span className="pe-badge" title={`Edited by ${e.edit.lastBy || 'someone'}`}>Edited</span>}
                      {e.rejectionReason && e.status === 'DRAFT' && <div className="prb-note" title={e.rejectionReason}>sent back</div>}
                      {(e.status === 'PAID' || e.status === 'SYNCED_TO_ACCOUNTS') && <div className="prb-note">{e.status === 'PAID' ? 'Paid' : 'Posted to Accounts'}</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {a.edit && !e.lock && <button className="btn btn-sm btn-primary" title="Change this person's pay" onClick={() => setEditId(e.id)}>Edit</button>}
                      {a.edit && e.lock && <button className="btn btn-sm" title={e.lock.message} onClick={() => setEditId(e.id)}>Adjust</button>}{' '}
                      <button className="btn btn-sm" title="The full breakup of this month's pay" onClick={() => setDetail(e.id)}>Details</button>{' '}
                      <button className="btn btn-sm" title="Every change to this record: edits, recalculations, approvals" onClick={() => setHistId(e.id)}>History</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && page.total > 0 && <Pager page={page} noun="records" />}
        {data && missing.length > 0 && (
          <div className="prb-missing" data-testid="prb-missing">
            <div className="prb-missing-head">
              <div>
                <b>{missing.length} {missing.length === 1 ? 'person has' : 'people have'} no salary record for {monthHeading(month)}</b>
                <div className="prb-note">Everybody on the payroll is listed here until their record is made. Nobody is paid until a salary structure is set.</div>
              </div>
              {a.prepare && readyIds.length > 0 && <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => calcSome(readyIds)}>{busy === 'Calculate' ? 'Calculating…' : `Calculate the ${readyIds.length} ready`}</button>}
            </div>
            <div className="tbl-wrap">
              <table className="prb-table">
                <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Joined</th><th>Why there is no record</th><th /></tr></thead>
                <tbody>
                  {missing.map((x) => (
                    <tr key={x.employeeId} className={x.code === 'NOT_JOINED' ? 'prb-missing-later' : ''}>
                      <td><b>{x.employeeCode}</b></td>
                      <td>{x.name}</td>
                      <td className="cell-muted">{x.department || '—'}</td>
                      <td className="cell-muted">{x.dateOfJoining ? new Date(`${x.dateOfJoining}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 260 }}><span className={`prb-why ${x.code === 'NOT_CALCULATED' ? 'ready' : x.code === 'NOT_JOINED' ? 'later' : 'todo'}`}>{x.code === 'NOT_CALCULATED' ? 'Ready' : x.code === 'NOT_JOINED' ? 'Not yet' : 'Needs salary'}</span> {x.reason}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{a.prepare && x.canCalculate && <button className="btn btn-sm" disabled={!!busy} onClick={() => calcSome([x.employeeId])}>Calculate</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>
      <ChangesInRun month={month} reloadKey={reloadKey + changesKey + (data ? data.entries.length : 0)} />
      <AttendancePanel month={month} canEdit={!!a.prepare} reloadKey={attKey} onChanged={() => {}} />
      {(a.post || a.approve) && <SyncLogPanel month={month} canRetry={!!a.post} reloadKey={reloadKey + (data ? data.entries.length : 0)} onChanged={load} />}
      {detail && <EntryDetail id={detail} onClose={() => setDetail(null)} />}
      {editId && (
        <PayrollEditor
          entryId={editId} canAdjust={!!a.edit}
          onClose={() => setEditId(null)}
          onSaved={(msg, keepOpen) => { setMessage(msg); if (!keepOpen) setEditId(null); load(); onChanged(); setStripKey((k) => k + 1); setChangesKey((k) => k + 1); }}
        />
      )}
      {histId && <PayrollEditHistory entryId={histId} onClose={() => setHistId(null)} />}
      {lopId && <LopBreakdown entryId={lopId} onClose={() => setLopId(null)} />}
    </div>
  );
}

// keepKey (optional, Accounts -> Journal & Ledger): the filter, search and page are kept when you leave and come back.
export function SyncLogPanel({ month, canRetry, reloadKey = 0, onChanged = () => {}, keepKey = null }) {
  const [logs, setLogs] = useState(null);
  const [filter, setFilter] = useKeptState(keepKey && `${keepKey}.filter`, 'open');
  const [msg, setMsg] = useState('');
  function load() {
    const q = new URLSearchParams();
    if (month) q.set('month', month);
    api.get(`/payroll/sync-logs?${q}`).then((r) => setLogs(r.data)).catch(() => setLogs([]));
  }
  useEffect(load, [month, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (logs || []).filter((l) => (filter === 'open' ? l.status !== 'SUCCESS' : true));
  const lf = useListFilters(open, LOG_FIELDS, { keep: keepKey });
  const shown = lf.rows;
  const page = usePaged(shown, 25, keepKey, `${lf.sig}|${filter}`);
  async function retry(id) {
    setMsg('');
    try { await api.post(`/payroll/sync-logs/${id}/retry`); setMsg('Retried — booked.'); } catch (err) { setMsg(errText(err, 'Retry failed; the error is in the log.')); }
    load(); onChanged();
  }
  async function sweep() {
    const r = await api.post('/payroll/sync-logs/sweep');
    setMsg(`Retry sweep: ${r.data.tried || 0} tried, ${r.data.succeeded || 0} booked, ${r.data.failed || 0} still failing.`);
    load(); onChanged();
  }
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Accounts sync log">
        <Combo value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="open">Pending / failed</option><option value="all">All</option>
        </Combo>
        {canRetry && <button className="btn btn-sm" onClick={sweep}>Run retry sweep</button>}
      </PanelHead>
      {msg && <div className="prb-msg">{msg}</div>}
      {open.length > 0 && <div style={{ padding: '10px 18px 0' }}><ListFilterBar lf={lf} storageKey="payroll-sync-log" noun="syncs" /></div>}
      {!logs ? <EmptyMini>Loading…</EmptyMini> : open.length === 0 ? <EmptyMini>{filter === 'open' ? 'Nothing pending or failed — every approved record is booked.' : 'No syncs yet.'}</EmptyMini> : shown.length === 0 ? <ListEmpty lf={lf} noun="syncs" /> : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Employee</th><th>Month</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Next retry</th><th>Key</th><th /></tr></thead>
            <tbody>
              {page.slice.map((l) => (
                <tr key={l.id}>
                  <td>{l.employeeName || l.employeeId}</td>
                  <td className="cell-muted">{monthLabel(l.month)}</td>
                  <td className="cell-muted">{l.kind === 'PAYMENT' ? 'Bank payment' : 'Salary journal'}</td>
                  <td><span className={`status ${SYNC_CLS[l.status]}`}>{l.status}</span></td>
                  <td className="cell-muted">{l.attempts}</td>
                  <td className="cell-muted" style={{ maxWidth: 260 }}>{l.lastError || '—'}</td>
                  <td className="cell-muted">{l.status === 'SUCCESS' ? '—' : l.nextAttemptAt ? new Date(l.nextAttemptAt).toLocaleString('en-GB') : 'manual'}</td>
                  <td className="cell-muted"><code>{l.idempotencyKey}</code></td>
                  <td>{canRetry && l.status !== 'SUCCESS' && <button className="btn btn-sm" onClick={() => retry(l.id)}>Retry</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {logs && page.total > 0 && <Pager page={page} noun="syncs" />}
    </Panel>
  );
}
