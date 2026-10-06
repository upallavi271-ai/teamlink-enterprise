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
import { Panel, PanelHead, EmptyMini, Modal, SectionLabel } from '../proto.jsx';
import {
  STATUS_LABEL, STATUS_CLS, SYNC_CLS, money, monthLabel, errText, bulkMessage,
} from './payrollUi';
import './payrollRun.css';
import ListFilterBar, { useListFilters, ListEmpty } from '../ui/ListFilters.jsx';
import Pager, { usePaged } from '../Pager.jsx';
import DataIoBar from '../dataio/DataIoBar.jsx';
import PayrollAccountsStrip from './PayrollAccountsStrip.jsx';

const inr0 = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

// The list filter standard for the three tables on this board.
const empSearch = (code, name) => ({ key: 'q', type: 'search', placeholder: 'Search employee name or ID…', get: (r) => `${code(r) || ''} ${name(r) || ''}` });
// S3: the month is posted as one journal, so a record is Posted / Paid / Not posted.
const syncLabel = (e) => (e.status === 'PAID' ? 'Paid' : e.status === 'SYNCED_TO_ACCOUNTS' ? 'Posted' : 'Not posted');
const ENTRY_FIELDS = [
  empSearch((e) => e.employee?.employeeCode, (e) => e.employee?.name),
  { key: 'status', label: 'Status', options: Object.keys(STATUS_LABEL).map((k) => ({ value: k, label: STATUS_LABEL[k] })), get: (e) => e.status, primary: true },
  { key: 'department', label: 'Department', get: (e) => e.employee?.department, primary: true },
  { key: 'sync', label: 'Accounts', allLabel: 'Posted or not', options: ['Posted', 'Paid', 'Not posted'], get: syncLabel },
  { key: 'source', label: 'Attendance source', allLabel: 'Any attendance source', options: ['HR override', 'Attendance'], get: (e) => (e.attendanceSource === 'OVERRIDE' ? 'HR override' : 'Attendance') },
  { key: 'lop', label: 'Loss of pay', allLabel: 'Everyone', options: ['With LOP days'], match: (e) => Number(e.daysLop) > 0 },
];
const ENTRY_SORTS = [
  { key: 'name', label: 'Name A–Z', cmp: (a, b) => String(a.employee?.name || '').localeCompare(String(b.employee?.name || '')) },
  { key: 'net', label: 'Net (high to low)', cmp: (a, b) => (Number(b.netPay) || 0) - (Number(a.netPay) || 0) },
  { key: 'lop', label: 'LOP days (most first)', cmp: (a, b) => (Number(b.daysLop) || 0) - (Number(a.daysLop) || 0) },
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
  const [lop, setLop] = useState(String(row.daysLop ?? 0));
  const [reason, setReason] = useState(row.override?.reason || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      await api.put(`/payroll/attendance-inputs/${row.employeeId}`, { month, daysPresent: Number(present), daysLop: Number(lop), reason });
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
      </div>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div className="field"><label>Days present</label><input type="number" min="0" step="0.5" value={present} onChange={(e) => setPresent(e.target.value)} /></div>
        <div className="field"><label>LOP days</label><input type="number" min="0" step="0.5" value={lop} onChange={(e) => setLop(e.target.value)} /></div>
      </div>
      <div className="field"><label>Reason (recorded in the audit log) *</label><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Approved regularization not yet in attendance" /></div>
      {error && <div className="error-text">{error}</div>}
    </Modal>
  );
}

function AttendancePanel({ month, canEdit, reloadKey, onChanged }) {
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
      <PanelHead title={`Attendance input — ${monthLabel(month)}`}>
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
            HR can override any employee before calculating; every override is audit-logged. Recalculate the drafts afterwards.
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
                      <td>{r.daysLop}</td>
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
  const [error, setError] = useState('');
  useEffect(() => { api.get(`/payroll/entries/${id}`).then((r) => setData(r.data)).catch((err) => setError(errText(err, 'Could not load.'))); }, [id]);
  const e = data?.entry;
  const p = data?.journalPayload;
  return (
    <Modal title={e ? `${e.employee.name} · ${monthLabel(e.month)}` : 'Payroll record'} onClose={onClose} wide footer={<button className="btn btn-sm" onClick={onClose}>Close</button>}>
      {error && <div className="error-text">{error}</div>}
      {!e ? <div className="small-muted">Loading…</div> : (
        <div className="prb-detail">
          <div className="prb-kv">
            <span>Status</span><b><span className={`status ${STATUS_CLS[e.status]}`}>{STATUS_LABEL[e.status]}</span></b>
            <span>Structure version</span><b>{data.version ? `from ${data.version.effectiveFrom.slice(0, 7)}${data.version.effectiveTo ? ` to ${data.version.effectiveTo}` : ''}` : '—'}</b>
            <span>Payroll days / LOP</span><b>{e.workingDays} / {e.daysLop} ({e.attendanceSource === 'OVERRIDE' ? 'HR override' : 'attendance'})</b>
            <span>Gross / LOP / earned</span><b>{inr0(e.grossPay)} − {inr0(e.lopDeduction)} = {inr0(e.earnedGross)}</b>
            {Number(e.incentive) > 0 && <><span>Incentive (in gross)</span><b>{inr0(e.incentive)} — recruiter joinings, given by Super Admin</b></>}
            <span>Deductions</span><b>PF {inr0(e.pfEmployee)} · ESI {inr0(e.esiEmployee)} · PT {inr0(e.professionalTax)} · TDS {inr0(e.tds)} · Other {inr0(e.otherDeductions)} · LOP {inr0(e.lopDeduction)} = {inr0(e.totalDeductions)}</b>
            <span>Net pay</span><b>{inr0(e.netPay)}</b>
            <span>Employer</span><b>PF {inr0(e.pfEmployer)} · ESI {inr0(e.esiEmployer)}</b>
            {e.rejectionReason && <><span>Sent back</span><b>{e.rejectionReason}</b></>}
          </div>
          <SectionLabel style={{ margin: '14px 0 6px' }}>This employee's share of the month's journal</SectionLabel>
          <table className="prb-journal">
            <thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
            <tbody>
              {p.debit.map((l) => <tr key={`d${l.account}`}><td>{l.account}</td><td>{money(l.amount)}</td><td /></tr>)}
              {p.credit.map((l) => <tr key={`c${l.account}`}><td>{l.account}</td><td /><td>{money(l.amount)}</td></tr>)}
              <tr className="tot"><td>Total</td><td>{money(p.debit.reduce((n, l) => n + l.amount, 0))}</td><td>{money(p.credit.reduce((n, l) => n + l.amount, 0))}</td></tr>
            </tbody>
          </table>
          <div className="prb-note">{p.note || 'Part of the one journal entry booked for the whole month.'}</div>
          <SectionLabel style={{ margin: '14px 0 6px' }}>History</SectionLabel>
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
        </div>
      )}
    </Modal>
  );
}

// (Mark paid is now one action for the whole month: PayrollAccountsStrip.jsx.)

export default function PayrollRunBoard({ month, reloadKey = 0, onChanged = () => {} }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState({});
  const [detail, setDetail] = useState(null);
  const [attKey, setAttKey] = useState(0);
  const [stripKey, setStripKey] = useState(0);

  function load() {
    setError('');
    api.get(`/payroll/entries?month=${month}`).then((r) => { setData(r.data); setSelected({}); }).catch((err) => setError(errText(err, 'Could not load the payroll records.')));
  }
  useEffect(load, [month, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = data?.access || {};
  const entries = data?.entries || [];
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
      setMessage(`Calculated ${monthLabel(month)}: ${r.data.created} new draft(s), ${r.data.updated} recalculated, ${r.data.locked.length} already beyond draft (left as they are), ${r.data.skipped.length} skipped (no structure effective this month).`);
    } catch (err) { setError(errText(err, 'Could not calculate.')); } finally { setBusy(''); load(); onChanged(); setAttKey((k) => k + 1); }
  }
  async function reject() {
    const reason = window.prompt('Reason for sending back to draft');
    if (!reason) return;
    const ids = chosen.filter((e) => e.status === 'PENDING_APPROVAL').map((e) => e.id);
    if (!ids.length) { setError('Select the pending records to send back.'); return; }
    await act('Sent back', '/payroll/entries/reject', { ids, reason });
  }
  const count = (s) => (data?.byStatus || {})[s] || 0;
  // Filters narrow what is SHOWN; the header checkbox ticks the rows shown.
  // A bulk button with nothing ticked still acts on the whole month, as it
  // always has — the note under the bar says so while a filter is on.
  const lf = useListFilters(entries, ENTRY_FIELDS, { sorts: ENTRY_SORTS });
  const page = usePaged(lf.rows);
  const allOn = lf.rows.length > 0 && lf.rows.every((e) => selected[e.id]);

  return (
    <div className="prb">
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title={`Payroll records — ${monthLabel(month)}`}>
          {a.prepare && <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={recalc}>{busy === 'Calculate' ? 'Calculating…' : entries.length ? 'Recalculate drafts' : 'Calculate drafts'}</button>}
        </PanelHead>
        <div className="prb-bar">
          {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SYNCED_TO_ACCOUNTS', 'PAID'].map((s) => (
            <span key={s} className={`prb-chip ${count(s) ? '' : 'zero'}`}><span className={`status ${STATUS_CLS[s]}`}>{STATUS_LABEL[s]}</span> {count(s)}</span>
          ))}
          {data && <span className="prb-tot">Net {inr0(data.totals.netPay)} · Gross {inr0(data.totals.grossPay)} · Employer PF/ESI {inr0(data.totals.pfEmployer + data.totals.esiEmployer)}</span>}
        </div>
        <PayrollAccountsStrip month={month} reloadKey={reloadKey + stripKey} onChanged={() => { load(); onChanged(); }} />
        <div className="prb-actions">
          {a.prepare && <button className="btn btn-sm" disabled={!!busy || (!count('DRAFT'))} onClick={() => act('Submitted', '/payroll/entries/submit', idsOr('DRAFT'))}>Submit {chosen.length ? 'selected' : 'all drafts'} for approval</button>}
          {a.approve && (
            <>
              <button className="btn btn-sm" disabled={!!busy || !count('PENDING_APPROVAL')} onClick={() => act('Approved', '/payroll/entries/approve', idsOr('PENDING_APPROVAL'))}>Approve {chosen.length ? 'selected' : 'all pending'}</button>
              <button className="btn btn-sm" disabled={!!busy || !chosen.some((e) => e.status === 'PENDING_APPROVAL')} onClick={reject}>Send back</button>
              <span className="prb-note">When every record is approved, the month is posted to Accounts as one journal.</span>
            </>
          )}
          {!a.prepare && !a.approve && !a.post && <span className="prb-note">View only.</span>}
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
          <EmptyMini>No payroll records for {monthLabel(month)} yet{a.prepare ? ' — Calculate drafts to create them.' : '.'}</EmptyMini>
        ) : lf.rows.length === 0 ? <ListEmpty lf={lf} noun="payroll records" /> : (
          <div className="tbl-wrap">
            <table className="prb-table">
              <thead>
                <tr>
                  <th><input type="checkbox" checked={allOn} title="Tick every record the filters show" onChange={(e) => setSelected(e.target.checked ? Object.fromEntries(lf.rows.map((x) => [x.id, true])) : {})} /></th>
                  <th>Code</th><th>Name</th><th>Status</th><th>Days (LOP)</th><th>Gross</th><th>LOP</th><th>PF</th><th>ESI</th><th>PT</th><th>TDS</th><th>Other</th><th>Net</th><th>Employer</th><th>Accounts</th><th />
                </tr>
              </thead>
              <tbody>
                {page.slice.map((e) => {
                  return (
                    <tr key={e.id}>
                      <td><input type="checkbox" checked={!!selected[e.id]} onChange={(ev) => setSelected((s) => ({ ...s, [e.id]: ev.target.checked }))} /></td>
                      <td><b>{e.employee.employeeCode}</b></td>
                      <td>{e.employee.name}</td>
                      <td><span className={`status ${STATUS_CLS[e.status]}`}>{STATUS_LABEL[e.status]}</span>{e.rejectionReason && e.status === 'DRAFT' && <div className="prb-note" title={e.rejectionReason}>sent back</div>}</td>
                      <td className="cell-muted">{e.workingDays - e.daysLop}/{e.workingDays}{e.daysLop ? ` (${e.daysLop})` : ''}{e.attendanceSource === 'OVERRIDE' ? ' *' : ''}</td>
                      <td className="cell-muted">{inr0(e.grossPay)}</td>
                      <td className="cell-muted">{inr0(e.lopDeduction)}</td>
                      <td className="cell-muted">{inr0(e.pfEmployee)}</td>
                      <td className="cell-muted">{inr0(e.esiEmployee)}</td>
                      <td className="cell-muted">{inr0(e.professionalTax)}</td>
                      <td className="cell-muted">{inr0(e.tds)}</td>
                      <td className="cell-muted">{inr0(e.otherDeductions)}</td>
                      <td><b>{inr0(e.netPay)}</b></td>
                      <td className="cell-muted">{inr0(e.pfEmployer + e.esiEmployer)}</td>
                      <td>{e.status === 'PAID' ? <span className="lb-badge green">Paid</span> : e.status === 'SYNCED_TO_ACCOUNTS' ? <span className="lb-badge green">Posted</span> : <span className="lb-badge grey">Not posted</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-sm" onClick={() => setDetail(e.id)}>Details</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && page.total > 0 && <Pager page={page} noun="records" />}
      </Panel>
      <AttendancePanel month={month} canEdit={!!a.prepare} reloadKey={attKey} onChanged={() => {}} />
      {(a.post || a.approve) && <SyncLogPanel month={month} canRetry={!!a.post} reloadKey={reloadKey + (data ? data.entries.length : 0)} onChanged={load} />}
      {detail && <EntryDetail id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

export function SyncLogPanel({ month, canRetry, reloadKey = 0, onChanged = () => {} }) {
  const [logs, setLogs] = useState(null);
  const [filter, setFilter] = useState('open');
  const [msg, setMsg] = useState('');
  function load() {
    const q = new URLSearchParams();
    if (month) q.set('month', month);
    api.get(`/payroll/sync-logs?${q}`).then((r) => setLogs(r.data)).catch(() => setLogs([]));
  }
  useEffect(load, [month, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (logs || []).filter((l) => (filter === 'open' ? l.status !== 'SUCCESS' : true));
  const lf = useListFilters(open, LOG_FIELDS);
  const shown = lf.rows;
  const page = usePaged(shown);
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
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
          <option value="open">Pending / failed</option><option value="all">All</option>
        </select>
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
