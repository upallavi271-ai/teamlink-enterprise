import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini, Status } from '../../components/proto.jsx';
import Combo from '../../components/Combo.jsx';
import './LeaveExtras.css';

// ---------------------------------------------------------------------------
// LEAVE — the request list with Team / Designation / Approved-by / Comments,
// the Approve · Reject · Reassign panel (with the TL approval rule), the
// month-wise balance, the HR month-wise report and the TL rule setting.
// Everything here draws what the SERVER returns (routes/leave.js); the rules
// themselves — TL limit, reassign targets, balance validation — are enforced
// there.
// ---------------------------------------------------------------------------

const fmtDate = (iso) => {
  if (!iso) return '';
  const s = String(iso);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const daysLabel = (r) => (r.halfDay ? `0.5 (${r.halfDay})` : `${r.days ?? 1}`);

function saveBlob(res, fallback) {
  const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || fallback;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// "Approved by / Decided by" cell — approver, date, comment on hover.
export function DecidedByCell({ r }) {
  const d = r.decision || {};
  if (d.state === 'Pending') {
    return (
      <span className="lvx-muted" title={d.level ? `Waiting at ${d.level}` : 'Waiting for a decision'}>
        {d.by ? <>With <b>{d.by}</b>{d.level ? ` (${d.level})` : ''}</> : 'Pending'}
      </span>
    );
  }
  if (!d.by && !d.at) return <span className="lvx-muted">—</span>;
  return (
    <span title={d.comment ? `${d.state} — ${d.comment}` : d.state}>
      <b>{d.by || '—'}</b>
      {d.at && <div className="lvx-muted">{fmtDate(d.at)}</div>}
      {d.comment && <div className="lvx-comment">“{d.comment.length > 40 ? `${d.comment.slice(0, 40)}…` : d.comment}”</div>}
    </span>
  );
}

// Reason + employee comments: the reason shown, the comments one click away.
export function ReasonCell({ r }) {
  const [open, setOpen] = useState(false);
  const reason = r.reasonText || r.reason || '';
  return (
    <span className="lvx-reason" title={[reason, r.employeeComments && `Employee comments: ${r.employeeComments}`].filter(Boolean).join('\n\n')}>
      {reason || <span className="lvx-muted">—</span>}
      {r.employeeComments && (
        <>
          {' '}
          <button type="button" className="lvx-link" onClick={() => setOpen((o) => !o)}>{open ? 'hide comments' : 'comments'}</button>
          {open && <div className="lvx-comments">{r.employeeComments}</div>}
        </>
      )}
    </span>
  );
}

// THE REQUEST LIST — HR / TL / Manager see their scope, an employee their own
// (the server scopes /api/leave).
export function LeaveRequestsTable({ requests, onOpen, limit = null, renderActions = null }) {
  const rows = limit ? requests.slice(0, limit) : requests;
  if (!rows.length) return <EmptyMini>No leave requests match.</EmptyMini>;
  return (
    <div className="tbl-wrap lvx-table">
      <table>
        <thead>
          <tr>
            <th>Code</th><th>Employee</th><th>Team</th><th>Designation</th><th>Type</th><th>From</th><th>To</th>
            <th>Days</th><th>Reason / comments</th><th>Status</th><th>Approved by / Decided by</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.employee?.employeeCode || '—'}</td>
              <td>{r.employee?.name || 'You'}<div className="lvx-muted">{r.employee?.department || ''}</div></td>
              <td className="lvx-muted">{r.employee?.team || '—'}</td>
              <td className="lvx-muted">{r.employee?.designation || '—'}</td>
              <td className="lvx-muted">{r.type}</td>
              <td className="lvx-muted" style={{ whiteSpace: 'nowrap' }}>{r.fromDate}</td>
              <td className="lvx-muted" style={{ whiteSpace: 'nowrap' }}>{r.toDate || r.fromDate}</td>
              <td className="lvx-muted" style={{ whiteSpace: 'nowrap' }}>{daysLabel(r)}</td>
              <td><ReasonCell r={r} /></td>
              <td><Status>{r.status}</Status></td>
              <td><DecidedByCell r={r} /></td>
              <td>
                <span style={{ display: 'flex', gap: 6 }}>
                  {onOpen && <button className="btn btn-sm" onClick={() => onOpen(r.id)}>Open</button>}
                  {renderActions && renderActions(r)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {limit && requests.length > limit && <div className="lvx-muted" style={{ padding: '6px 10px' }}>Showing {limit} of {requests.length} — use the Requests tab for all.</div>}
    </div>
  );
}

// The request's own facts in the Approval Workflow modal.
export function LeaveFacts({ leave, handoffs }) {
  if (!leave) return null;
  const e = leave.employee || {};
  return (
    <div className="lvx-facts">
      <div><span>Employee</span><b>{e.name}</b> <span className="lvx-muted">{e.code}</span></div>
      <div><span>Department · Team</span><b>{e.department || '—'}{e.team ? ` · ${e.team}` : ''}</b></div>
      <div><span>Designation</span><b>{e.designation || '—'}</b></div>
      <div><span>Leave</span><b>{leave.type} · {leave.fromDate}{leave.toDate && leave.toDate !== leave.fromDate ? ` – ${leave.toDate}` : ''} · {leave.halfDay ? `Half day (${leave.halfDay})` : `${leave.days ?? 1} day${(leave.days ?? 1) === 1 ? '' : 's'}`}</b></div>
      <div><span>Applied on</span><b>{fmtDate(leave.appliedAt)}</b></div>
      <div><span>Status</span><b>{leave.status}</b></div>
      <div className="lvx-wide"><span>Reason</span><b>{leave.reasonText || '—'}</b></div>
      {leave.employeeComments && <div className="lvx-wide"><span>Employee comments</span><b className="lvx-pre">{leave.employeeComments}</b></div>}
      <div className="lvx-wide">
        <span>{leave.status === 'Pending' ? 'Waiting on' : 'Approved by / Decided by'}</span>
        <b>
          {leave.decision?.by || '—'}
          {leave.decision?.level ? ` (${leave.decision.level})` : ''}
          {leave.decision?.at ? ` · ${fmtDate(leave.decision.at)}` : ''}
          {leave.decision?.comment ? ` — “${leave.decision.comment}”` : ''}
        </b>
      </div>
      {Object.entries(leave.details || {}).filter(([k]) => !['Half day', 'Approver'].includes(k)).map(([k, v]) => (
        <div key={k}><span>{k}</span><b>{v}</b></div>
      ))}
      {handoffs && handoffs.length > 0 && (
        <div className="lvx-wide">
          <span>Reassigned</span>
          <b>{handoffs.map((h, i) => <div key={i}>{fmtDate(h.at)}: {h.from} → {h.to} by {h.by}{h.reason ? ` — “${h.reason}”` : ''}</div>)}</b>
        </div>
      )}
    </div>
  );
}

// APPROVE · REJECT · REASSIGN, for the login whose turn it is (or a Super
// Admin deciding directly). The TL rule note and the disabled Approve come
// from the server's `tl` verdict; the API refuses the same things.
export function LeaveDecidePanel({ data, onDone }) {
  const wf = data?.workflow;
  const [mode, setMode] = useState('');
  const [remarks, setRemarks] = useState('');
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState('');
  const [reasons, setReasons] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setMode(''); setRemarks(''); setTarget(''); setError(''); setReasons(null); }, [data?.leave?.id]);
  useEffect(() => { if (reasons && reasons.length && !reason) setReason(reasons[0]); }, [reasons]);
  if (!wf || wf.state !== 'Pending' || data.leave.status !== 'Pending') return null;
  const mine = wf.canAct || wf.canDirect;
  const canReassign = !!data.reassign?.allowed;
  if (!mine && !canReassign) return null;
  const tl = data.tl;
  const tlBlocked = !!(tl && !tl.allowed);

  async function send(kind) {
    setError('');
    if (kind === 'Rejected' && !remarks.trim()) { setError('A reason is required to reject.'); return; }
    if (kind === 'Approved' && tl && !remarks.trim()) { setError('A reason is required when a TL approves.'); return; }
    if (kind === 'Reassign') {
      if (!target) { setError('Choose who to reassign it to.'); return; }
      if (!remarks.trim()) { setError('A reason is required to reassign.'); return; }
    }
    setBusy(true);
    try {
      if (kind === 'Reassign') {
        await api.post(`/leave/${data.leave.id}/reassign`, { toUserId: target, reason: remarks.trim() });
      } else {
        await api.patch(`/leave/${data.leave.id}/decision`, kind === 'Rejected'
          ? { status: 'Rejected', rejectReason: remarks.trim() }
          : { status: 'Approved', comment: remarks.trim() || undefined, approvalReason: reasons && reasons.length ? reason : undefined });
      }
      onDone();
    } catch (err) {
      const d = err.response?.data;
      if (d?.reasons?.length) setReasons(d.reasons);
      if (d?.reassign) setMode('reassign');
      setError(d?.error || 'Could not record that.');
    } finally { setBusy(false); }
  }

  return (
    <div className={`lvx-decide${wf.canDirect && !wf.canAct ? ' lvx-direct' : ''}`}>
      <div className="lvx-decide-title">{wf.canAct ? 'Your decision' : (wf.canDirect ? 'Super Admin — decide directly' : 'Reassign')}</div>
      {tl && <div className={`lvx-tl ${tl.allowed ? '' : 'blocked'}`}><b>TL approval rule:</b> {tl.note}</div>}
      {reasons && reasons.length > 0 && (
        <label className="lvx-muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
          Approval reason (required for this request)
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      )}
      {mode === 'reassign' && canReassign && (
        <label className="lvx-muted" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
          Reassign to
          <Combo value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose an approver</option>
            {data.reassign.targets.map((t) => <option key={t.userId} value={t.userId}>{t.label}</option>)}
          </Combo>
        </label>
      )}
      <textarea
        rows={2}
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
        placeholder={mode === 'reassign' ? 'Why are you reassigning it? (required)' : (tl ? 'Reason / remarks (required)' : 'Remarks (required to reject)')}
      />
      {error && <div className="error-text" style={{ margin: '4px 0' }}>{error}</div>}
      <div className="lvx-decide-row">
        {mode === 'reassign' ? (
          <>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => send('Reassign')}>Confirm reassign</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setMode('')}>Back</button>
          </>
        ) : (
          <>
            {mine && (
              <button
                className="btn btn-sm btn-primary"
                disabled={busy || tlBlocked}
                title={tlBlocked ? tl.note : undefined}
                onClick={() => send('Approved')}
              >
                {wf.canAct ? 'Approve' : 'Approve directly'}
              </button>
            )}
            {mine && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => send('Rejected')}>{wf.canAct ? 'Reject' : 'Reject directly'}</button>}
            {canReassign && <button className="btn btn-sm" disabled={busy} onClick={() => { setMode('reassign'); setError(''); }}>Reassign</button>}
          </>
        )}
      </div>
      {tlBlocked && mode !== 'reassign' && <div className="lvx-muted" style={{ marginTop: 4 }}>Approve is off for this request — use Reassign to send it to HR or your manager.</div>}
    </div>
  );
}

// MONTH-WISE BALANCE — one employee (own, or picked by HR / TL within scope).
export function MonthlyBalance({ employees = null }) {
  const [employeeId, setEmployeeId] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    if (employees && employees.length && !employeeId) return;
    api.get('/leave/monthly', { params: { year, employeeId: employeeId || undefined } })
      .then((r) => setData(r.data))
      .catch((e) => { setData(null); setError(e.response?.data?.error || 'Could not load the month-wise balance.'); });
  }, [employeeId, year, employees]);
  const years = [];
  for (let y = new Date().getFullYear(); y >= 2025; y -= 1) years.push(y);

  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Month-wise balance">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {employees && employees.length > 0 && (
            <label className="lvx-muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              Employee
              <Combo value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={{ minWidth: 280 }}>
                <option value="">Search employee by ID or name</option>
                {employees.map((e) => <option key={e.employeeId} value={e.employeeId}>{`${e.employeeCode} · ${e.name}${e.department ? ` · ${e.department}` : ''}`}</option>)}
              </Combo>
            </label>
          )}
          <Combo value={String(year)} onChange={(e) => setYear(Number(e.target.value))} style={{ minWidth: 110 }}>
            {years.map((y) => <option key={y} value={String(y)}>{`Leave year ${y}`}</option>)}
          </Combo>
        </span>
      </PanelHead>
      {error && <div className="error-text" style={{ margin: '8px 18px' }}>{error}</div>}
      {employees && employees.length > 0 && !employeeId && <EmptyMini>Choose an employee to see their month-by-month balance.</EmptyMini>}
      {data && (!employees || employeeId) && (
        <div style={{ padding: '6px 18px 14px' }}>
          <div className="lvx-muted" style={{ marginBottom: 8 }}>
            <b>{data.employee.name}</b> ({data.employee.employeeCode}) · {data.employee.department || '—'}{data.employee.team ? ` · ${data.employee.team}` : ''} · {data.leaveYear}.
            {' '}Taken = approved days in the month (a half day counts 0.5; a leave spanning two months is split by calendar days).
            Pending is shown but not deducted. A yearly leave type is credited in the first month of the leave year.
          </div>
          {data.types.map((t) => (
            <div key={t.type} className="lvx-month">
              <div className="lvx-month-head">
                <b>{t.type}</b> <span className="lvx-muted">{t.unit === 'month' ? `${t.cap} credited per month` : t.unit === 'unpaid' ? 'unpaid' : `yearly entitlement`}</span>
                {t.onRecord && <span className="lvx-muted"> · balance on record: <b>{t.onRecord.remaining}</b> of {t.onRecord.total} ({t.onRecord.taken} taken)</span>}
              </div>
              {!t.creditKnown && <div className="lvx-note">The entitlement for {data.year} is not on record (the imported balances are for the current leave year), so nothing is credited — taken and pending days are still shown.</div>}
              {t.reconcileNote && <div className="lvx-note">{t.reconcileNote}</div>}
              <div className="tbl-wrap">
                <table className="lvx-mtable">
                  <thead><tr><th>Month</th><th>Opening</th><th>Credited</th><th>Taken</th><th>Pending</th><th>Closing</th></tr></thead>
                  <tbody>
                    {t.months.map((m) => (
                      <tr key={m.month} className={m.taken || m.pending || m.credited ? '' : 'lvx-quiet'}>
                        <td>{m.label}</td><td>{m.opening}</td><td>{m.credited || '—'}</td><td>{m.taken || '—'}</td><td>{m.pending || '—'}</td>
                        <td className={m.closing < 0 ? 'lvx-neg' : ''}>{m.closing}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td>Year</td><td /><td>{t.totals.credited}</td><td>{t.totals.taken}</td><td>{t.totals.pending}</td><td className={t.totals.closing < 0 ? 'lvx-neg' : ''}>{t.totals.closing}</td></tr></tfoot>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// THE HR REPORT — taken per month for everyone in scope, with export.
export function MonthlyReport({ canExport, allowRelieved = false }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [includeRelieved, setIncludeRelieved] = useState(false);
  const [type, setType] = useState('Casual Leave');
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/leave/monthly-report', { params: { year, type: type || undefined, includeRelieved: includeRelieved ? 1 : undefined } })
      .then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not load the report.'));
  }, [year, type, includeRelieved]);
  const rows = useMemo(() => (data?.rows || []).filter((r) => !q || `${r.employeeCode} ${r.name} ${r.team || ''} ${r.department || ''}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  async function exportXlsx() {
    setError('');
    try {
      const res = await api.get('/leave/monthly-report', { params: { year, type: type || undefined, includeRelieved: includeRelieved ? 1 : undefined, format: 'xlsx' }, responseType: 'blob' });
      saveBlob(res, `leave-monthly-${year}.xlsx`);
    } catch { setError('Export is not included in your role’s permissions.'); }
  }
  const years = [];
  for (let y = new Date().getFullYear(); y >= 2025; y -= 1) years.push(y);
  const months = data?.rows?.[0]?.months?.map((m) => m.month) || [];
  const mLabel = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Month-wise Leave Report">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input placeholder="Search employee / team" value={q} onChange={(e) => setQ(e.target.value)} />
          <Combo value={type} onChange={(e) => setType(e.target.value)} style={{ minWidth: 150 }}>
            <option value="">All leave types</option>
            <option>Casual Leave</option>
            <option>Planned Leave</option>
            <option>Sick Leave</option>
          </Combo>
          <Combo value={String(year)} onChange={(e) => setYear(Number(e.target.value))} style={{ minWidth: 100 }}>
            {years.map((y) => <option key={y} value={String(y)}>{String(y)}</option>)}
          </Combo>
          {allowRelieved && (
          <label className="lvx-muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }} title="Add employees who have left">
            <input type="checkbox" style={{ width: 'auto' }} checked={includeRelieved} onChange={(e) => setIncludeRelieved(e.target.checked)} /> Relieved
          </label>
          )}
          {canExport && <button className="btn btn-sm" onClick={exportXlsx}>Export Excel</button>}
        </span>
      </PanelHead>
      {error && <div className="error-text" style={{ margin: '8px 18px' }}>{error}</div>}
      {!data ? <EmptyMini>Loading…</EmptyMini> : (
        <div className="tbl-wrap lvx-table">
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Employee</th><th>Team</th><th>Designation</th><th>Type</th><th>Credited</th>
                {months.map((k) => <th key={k} style={{ textAlign: 'center' }}>{mLabel(k)}</th>)}
                <th>Taken</th><th>Pending</th><th>Closing</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.id}-${r.type}`}>
                  <td>{r.employeeCode}</td><td>{r.name}</td><td className="lvx-muted">{r.team || '—'}</td><td className="lvx-muted">{r.designation || '—'}</td>
                  <td className="lvx-muted">{r.type}</td>
                  <td>{r.creditKnown ? r.totals.credited : <span className="lvx-muted" title="Entitlement not on record for this year">n/a</span>}</td>
                  {r.months.map((m) => <td key={m.month} style={{ textAlign: 'center' }} title={m.pending ? `${m.pending} pending` : undefined}>{m.taken || (m.pending ? <span className="lvx-muted">({m.pending})</span> : '')}</td>)}
                  <td><b>{r.totals.taken}</b></td><td>{r.totals.pending || ''}</td>
                  <td className={r.totals.closing < 0 ? 'lvx-neg' : ''}>{r.creditKnown ? r.totals.closing : ''}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9 + months.length} className="small-muted" style={{ padding: 16 }}>No employees.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// HR LEAVE SETTINGS — the TL approval rule.
export function TlRuleSetting({ canConfigure }) {
  const [rule, setRule] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/leave/tl-rule').then((r) => setRule(r.data)).catch(() => setRule(null)); }, []);
  async function save(patch) {
    setError('');
    try { setRule((await api.put('/leave/tl-rule', { ...rule, ...patch })).data); } catch (e) { setError(e.response?.data?.error || 'Could not save.'); }
  }
  if (!rule) return null;
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="⑥ TL Approval Rule" />
      <div style={{ padding: '8px 18px 12px' }}>
        <div className="lvx-muted" style={{ marginBottom: 8 }}>
          {rule.enabled
            ? (rule.mode === 'days'
              ? <>A TL may approve a leave request of <b>at most {rule.limit} day{rule.limit === 1 ? '' : 's'}</b>, and must give a reason. Longer requests are reassigned to HR / their manager.</>
              : <>A TL may approve <b>at most {rule.limit} leave request{rule.limit === 1 ? '' : 's'} per employee per month</b>, and must give a reason. Beyond that the request is reassigned to HR / their manager.</>)
            : <>The TL rule is <b>off</b> — a TL approves like any other level (a reason is still asked for).</>}
        </div>
        {(canConfigure || rule.canConfigure) && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Combo value={rule.mode} onChange={(e) => save({ mode: e.target.value })} style={{ minWidth: 260 }}>
              <option value="days">Per request — maximum days</option>
              <option value="count">Per employee per month — maximum requests</option>
            </Combo>
            <label className="lvx-muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              TL approval limit ({rule.mode === 'days' ? 'days' : 'requests'})
              <input type="number" min="0" max="365" style={{ width: 80 }} defaultValue={rule.limit} key={`${rule.mode}-${rule.limit}`} onBlur={(e) => { const v = Number(e.target.value); if (v !== rule.limit) save({ limit: v }); }} />
            </label>
            <button className="btn btn-sm" onClick={() => save({ enabled: !rule.enabled })}>{rule.enabled ? 'Turn off' : 'Turn on'}</button>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </Panel>
  );
}
