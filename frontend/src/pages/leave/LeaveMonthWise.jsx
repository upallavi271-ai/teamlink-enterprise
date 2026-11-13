import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini, Modal, Status } from '../../components/proto.jsx';
import Combo from '../../components/Combo.jsx';
import LeaveRequestScreen from './LeaveRequestScreen.jsx';
import './LeaveExtras.css';

// ---------------------------------------------------------------------------
// MONTH-WISE LEAVE, ONE VIEW (founder 2026-11-13: "monthly-wise dantlo ahh 3 okey tab lo kanipinchali ... planned leave 1 medha click chestey
// ahh leave yepudu thisukunaru, chain open avali").
// The three views that sat under Month-wise Balance (One employee - month-wise / All employees - month-wise / All employees - current
// balances) are ONE table now:
//   * every employee in scope, every month of the year for the chosen leave type, Credited / Taken / Pending / Closing
//     and "Balance now" (the balance on record today: the old "current balances" view)
//   * click an employee's name: their month-by-month balance for every leave type (the old "One employee" view)
//   * click a number in a month: the leave(s) behind it with their dates; one leave opens its chain straight away
//     (the one leave screen: the leave, the approval chain, who approved and when, Approve / Reject)
// The numbers and the scope are the server's (routes/leave.js /monthly, /monthly-report, /monthly-requests); this only draws them.
// ---------------------------------------------------------------------------

function saveBlob(res, fallback) {
  const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || fallback;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const monthName = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const dayText = (s) => {
  if (!s) return '';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// THE LEAVES BEHIND ONE NUMBER: one person, one leave type, one month. One leave opens its chain at once; several are listed first.
function LeaveMonthPeek({ employeeId, name, type, month, onClose, onActed }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/leave/monthly-requests', { params: { employeeId, type: type || undefined, month } })
      .then((r) => {
        if (!alive) return;
        setData(r.data);
        if (r.data.requests.length === 1) setOpenId(r.data.requests[0].id);
      })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'Could not load these leaves.'); });
    return () => { alive = false; };
  }, [employeeId, type, month]);
  const single = !!data && data.requests.length === 1;
  if (openId) {
    return <LeaveRequestScreen requestId={openId} onActed={onActed} onClose={() => { if (single) onClose(); else setOpenId(null); }} />;
  }
  const list = (data && data.requests) || [];
  return (
    <Modal title={`${name} · ${type || 'Leave'} · ${monthName(month)}`} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="error-text">{error}</div>}
      {!data && !error && <EmptyMini>Loading…</EmptyMini>}
      {data && list.length === 0 && <EmptyMini>No approved or pending leave in {monthName(month)}.</EmptyMini>}
      {list.length > 1 && (
        <>
          <div className="lvx-muted" style={{ marginBottom: 8 }}>{list.length} leaves touch {monthName(month)}. Open one to see when it was taken, who approved it and the reason.</div>
          <div className="tbl-wrap lvx-table">
            <table>
              <thead><tr><th>Leave</th><th>From</th><th>To</th><th>Days in {monthName(month).split(' ')[0]}</th><th>Status</th><th>Reason</th><th /></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td>{r.type}{r.halfDay ? <div className="lvx-muted">{/^half day$/i.test(r.halfDay) ? 'Half day' : r.halfDay}</div> : null}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dayText(r.fromDate)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dayText(r.toDate)}</td>
                    <td>{r.inMonth}{Number(r.days) !== Number(r.inMonth) ? <span className="lvx-muted"> of {r.days}</span> : null}</td>
                    <td><Status>{r.status}</Status></td>
                    <td className="lvx-muted">{r.reasonText ? (r.reasonText.length > 60 ? `${r.reasonText.slice(0, 60)}…` : r.reasonText) : '—'}</td>
                    <td><button className="btn btn-sm" onClick={() => setOpenId(r.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

// A number in a month: Taken, or (Pending) when nothing is approved yet. Clicking it opens the leave(s) behind it.
function MonthNumber({ taken, pending, onClick, title }) {
  if (!taken && !pending) return null;
  return (
    <button type="button" className="link-btn" style={{ fontWeight: 700 }} title={title || 'Click: when the leave was taken, who approved it'} onClick={onClick}>
      {taken || <span className="lvx-muted">({pending})</span>}
    </button>
  );
}

// ONE EMPLOYEE, every leave type, month by month: Opening / Credited / Taken / Pending / Closing.
function EmployeeMonthTables({ data, onPeek }) {
  return (
    <div style={{ padding: '6px 18px 14px' }}>
      <div className="lvx-muted" style={{ marginBottom: 8 }}>
        <b>{data.employee.name}</b> ({data.employee.employeeCode}) · {data.employee.department || '—'}{data.employee.team ? ` · ${data.employee.team}` : ''} · {data.leaveYear}.
        {' '}Taken = approved days in the month (a half day counts 0.5; a leave spanning two months is split by calendar days).
        Pending is shown but not deducted. A yearly leave type is credited in the first month of the leave year. Click a number to see the leave.
      </div>
      {data.types.map((t) => (
        <div key={t.type} className="lvx-month">
          <div className="lvx-month-head">
            <b>{t.type}</b> <span className="lvx-muted">{t.unit === 'month' ? `${t.cap} credited per month` : t.unit === 'unpaid' ? 'unpaid' : 'yearly entitlement'}</span>
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
                    <td>{m.label}</td><td>{m.opening}</td><td>{m.credited || '—'}</td>
                    <td>{m.taken ? <MonthNumber taken={m.taken} onClick={() => onPeek(t.type, m.month)} /> : '—'}</td>
                    <td>{m.pending ? <button type="button" className="link-btn" title="Click: the pending leave" onClick={() => onPeek(t.type, m.month)}>{m.pending}</button> : '—'}</td>
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
  );
}

// The same table in a window: opened from an employee's name in the month-wise report.
function EmployeeMonthsModal({ employeeId, name, year, onClose, onActed }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [peek, setPeek] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get('/leave/monthly', { params: { year, employeeId } })
      .then((r) => { if (alive) setData(r.data); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'Could not load the month-wise balance.'); });
    return () => { alive = false; };
  }, [employeeId, year]);
  return (
    <>
      <Modal title={`Month by month · ${name} · ${year}`} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Close</button>}>
        {error && <div className="error-text">{error}</div>}
        {!data && !error && <EmptyMini>Loading…</EmptyMini>}
        {data && <EmployeeMonthTables data={data} onPeek={(type, month) => setPeek({ type, month })} />}
      </Modal>
      {peek && <LeaveMonthPeek employeeId={employeeId} name={name} type={peek.type} month={peek.month} onClose={() => setPeek(null)} onActed={onActed} />}
    </>
  );
}

// MONTH-WISE BALANCE — one employee (own, or picked by HR / TL within scope). Kept for a login that sees only itself.
export function MonthlyBalance({ employees = null }) {
  const [employeeId, setEmployeeId] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [peek, setPeek] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setError('');
    if (employees && employees.length && !employeeId) return;
    api.get('/leave/monthly', { params: { year, employeeId: employeeId || undefined } })
      .then((r) => setData(r.data))
      .catch((e) => { setData(null); setError(e.response?.data?.error || 'Could not load the month-wise balance.'); });
  }, [employeeId, year, employees, reload]);
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
      {data && (!employees || employeeId) && <EmployeeMonthTables data={data} onPeek={(type, month) => setPeek({ type, month })} />}
      {peek && data && <LeaveMonthPeek employeeId={data.employee.id} name={data.employee.name} type={peek.type} month={peek.month} onClose={() => setPeek(null)} onActed={() => setReload((n) => n + 1)} />}
    </Panel>
  );
}

// THE MONTH-WISE REPORT — taken per month for everyone in scope, with export. This is the one view of the three month-wise screens.
export function MonthlyReport({ canExport, allowRelieved = false }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [includeRelieved, setIncludeRelieved] = useState(false);
  const [type, setType] = useState('Casual Leave');
  const [data, setData] = useState(null);
  const [department, setDepartment] = useState('');
  const [employee, setEmployee] = useState(''); // an employee id ('' = everyone in the department)
  const [team, setTeam] = useState('');
  const [month, setMonth] = useState(''); // '01'..'12' ('' = all months)
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [peek, setPeek] = useState(null); // a number: { employeeId, name, type, month }
  const [who, setWho] = useState(null); // a name: { employeeId, name }
  useEffect(() => {
    api.get('/leave/monthly-report', { params: { year, type: type || undefined, includeRelieved: includeRelieved ? 1 : undefined } })
      .then((r) => { setError(''); setData(r.data); }).catch((e) => setError(e.response?.data?.error || 'Could not load the report.'));
  }, [year, type, includeRelieved, reload]);
  const all = data?.rows || [];
  const departments = useMemo(() => [...new Set(all.map((r) => r.department).filter(Boolean))].sort(), [all]);
  const teams = useMemo(() => [...new Set(all.filter((r) => !department || r.department === department).map((r) => r.team).filter(Boolean))].sort(), [all, department]);
  // The employee names: one entry per person (the rows repeat a person once per leave type), only those of the chosen department / team.
  const employees = useMemo(() => {
    const seen = new Map();
    all.forEach((r) => {
      if (department && r.department !== department) return;
      if (team && (r.team || '') !== team) return;
      if (!seen.has(String(r.id))) seen.set(String(r.id), { id: String(r.id), name: r.name, code: r.employeeCode });
    });
    return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [all, department, team]);
  const employeeNow = employees.some((e) => e.id === employee) ? employee : ''; // a pick that the year / type / department no longer has counts as "everyone"
  const monthKeys = data?.rows?.[0]?.months?.map((m) => m.month) || [];
  const monthKey = month ? monthKeys.find((k) => k.endsWith(`-${month}`)) || '' : '';
  const monthName = (mm) => new Date(`2000-${mm}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long' });
  const byPerson = useMemo(() => all.filter((r) => (!department || r.department === department) && (!team || (r.team || '') === team)
    && (!employeeNow || String(r.id) === employeeNow)), [all, department, team, employeeNow]);
  // One month picked: only the people who took (or have pending) leave in that month stay; the others had none.
  const rows = useMemo(() => (monthKey
    ? byPerson.filter((r) => { const m = r.months.find((x) => x.month === monthKey); return m && (m.taken || m.pending); })
    : byPerson), [byPerson, monthKey]);
  async function exportXlsx() {
    setError('');
    try {
      const res = await api.get('/leave/monthly-report', { params: { year, type: type || undefined, includeRelieved: includeRelieved ? 1 : undefined, format: 'xlsx' }, responseType: 'blob' });
      saveBlob(res, `leave-monthly-${year}.xlsx`);
    } catch { setError('Export is not included in your role’s permissions.'); }
  }
  const years = [];
  for (let y = new Date().getFullYear(); y >= 2025; y -= 1) years.push(y);
  const months = monthKey ? [monthKey] : monthKeys; // the month columns on screen
  const mLabel = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title="Month-wise Leave Report">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Combo value={department} onChange={(e) => { setDepartment(e.target.value); setTeam(''); setEmployee(''); }} style={{ minWidth: 150 }} title="Department">
            <option value="">All departments</option>
            {departments.map((d) => <option key={d}>{d}</option>)}
          </Combo>
          <Combo value={employeeNow} onChange={(e) => setEmployee(e.target.value)} style={{ minWidth: 220 }} title="Employee names">
            <option value="">{department ? `All employees of ${department}` : 'All employees'}</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.code ? ` (${e.code})` : ''}</option>)}
          </Combo>
          <Combo value={team} onChange={(e) => { setTeam(e.target.value); setEmployee(''); }} style={{ minWidth: 130 }}>
            <option value="">All teams</option>
            {teams.map((t) => <option key={t}>{t}</option>)}
          </Combo>
          <Combo value={type} onChange={(e) => setType(e.target.value)} style={{ minWidth: 150 }}>
            <option value="">All leave types</option>
            <option>Casual Leave</option>
            <option>Planned Leave</option>
            <option>Sick Leave</option>
          </Combo>
          <Combo value={String(year)} onChange={(e) => setYear(Number(e.target.value))} style={{ minWidth: 100 }}>
            {years.map((y) => <option key={y} value={String(y)}>{String(y)}</option>)}
          </Combo>
          <Combo value={month} onChange={(e) => setMonth(e.target.value)} style={{ minWidth: 130 }} title="Month">
            <option value="">All months</option>
            {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((mm) => <option key={mm} value={mm}>{monthName(mm)}</option>)}
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
        <>
          <div className="lvx-muted" style={{ margin: '0 18px 6px', fontSize: 12 }}>
            Click a number to see the leave: the dates, who approved it and the reason. Click a name for that person&apos;s month-by-month balance. <b>Balance now</b> is the balance on record today.
          </div>
          {monthKey && (
            <div className="lvx-muted" style={{ margin: '0 18px 6px', fontSize: 12 }}>
              <b>{monthName(month)} {year}</b>: {rows.length} {rows.length === 1 ? 'person' : 'people'} took or have pending leave this month
              {byPerson.length > rows.length ? `; the other ${byPerson.length - rows.length} had none` : ''}. Taken, Pending and Closing are for the whole year.
            </div>
          )}
          <div className="tbl-wrap lvx-table">
            <table>
              <thead>
                <tr>
                  <th>Code</th><th>Employee</th><th>Team</th><th>Designation</th><th>Type</th><th>Credited</th>
                  {months.map((k) => <th key={k} style={{ textAlign: 'center' }}>{mLabel(k)}</th>)}
                  <th title={monthKey ? 'The whole year, not only this month' : undefined}>{monthKey ? 'Taken (year)' : 'Taken'}</th>
                  <th title={monthKey ? 'The whole year, not only this month' : undefined}>{monthKey ? 'Pending (year)' : 'Pending'}</th>
                  <th title={monthKey ? 'At the end of the year' : undefined}>Closing</th>
                  <th title="The balance on record today (this leave year)">Balance now</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.id}-${r.type}`}>
                    <td>{r.employeeCode}</td>
                    <td><button type="button" className="link-btn" title="This person, month by month, for every leave type" onClick={() => setWho({ employeeId: r.id, name: r.name })}>{r.name}</button></td>
                    <td className="lvx-muted">{r.team || '—'}</td><td className="lvx-muted">{r.designation || '—'}</td>
                    <td className="lvx-muted">{r.type}</td>
                    <td>{r.creditKnown ? r.totals.credited : <span className="lvx-muted" title="Entitlement not on record for this year">n/a</span>}</td>
                    {r.months.filter((m) => !monthKey || m.month === monthKey).map((m) => (
                      <td key={m.month} style={{ textAlign: 'center' }} title={m.pending ? `${m.pending} pending` : undefined}>
                        <MonthNumber taken={m.taken} pending={m.pending} onClick={() => setPeek({ employeeId: r.id, name: r.name, type: r.type, month: m.month })} />
                      </td>
                    ))}
                    <td><b>{r.totals.taken}</b></td><td>{r.totals.pending || ''}</td>
                    <td className={r.totals.closing < 0 ? 'lvx-neg' : ''}>{r.creditKnown ? r.totals.closing : ''}</td>
                    <td title={r.onRecord ? `Entitled ${r.onRecord.total} · taken ${r.onRecord.taken}` : 'Only the current leave year has a balance on record'}>
                      {r.onRecord ? <><b>{r.onRecord.remaining}</b><span className="lvx-muted"> of {r.onRecord.total}</span></> : <span className="lvx-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={10 + months.length} className="small-muted" style={{ padding: 16 }}>No employees.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      {peek && <LeaveMonthPeek employeeId={peek.employeeId} name={peek.name} type={peek.type} month={peek.month} onClose={() => setPeek(null)} onActed={() => setReload((n) => n + 1)} />}
      {who && <EmployeeMonthsModal employeeId={who.employeeId} name={who.name} year={year} onClose={() => setWho(null)} onActed={() => setReload((n) => n + 1)} />}
    </Panel>
  );
}
