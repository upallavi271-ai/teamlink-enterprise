// ---------------------------------------------------------------------------
// THE REST OF THE ATTENDANCE DASHBOARD (founder 2026-11-17: "the biometric list and the punch logs must all be covered
// in one dashboard").
//
// KpiReport.jsx draws the cards and the day-by-day status list. Below it, on the SAME screen and following the SAME
// filter bar (period, department, employee, check-in method, punch source), come these two lists:
//   - BiometricList: the old "First Check-In & Last Check-Out Report", one line per person per day (GET /attendance/biometric)
//   - PunchLogList : every punch of the day and how many times, with the time intervals (GET /attendance/punch-log)
// They used to be separate screens, then only Export files; now they are sections of the one Dashboard. Each keeps its
// own Export CSV / Excel button and its own search box (the filter bar above is not repeated).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import api from '../../api';
import Pager, { usePaged } from '../../components/Pager.jsx';
import ScrollTable from '../../components/ScrollTable.jsx';
import { downloadFrom, DayStatus } from './MyAttendance.jsx';
import { SourceChips, PunchToggle, PunchDetails } from '../../components/PunchSourceChip.jsx';
import { HalfLeaveChip } from './DayReport.jsx';

const hhmm = (t) => (t ? String(t).slice(0, 5) : '—');
// The short word on each punch time: where the punch came from.
const PUNCH_FROM = { web: 'Web', biometric: 'Device', bioimport: 'Import', pulse: 'Import', hr: 'HR' };
// What each time is on the day (server: utils/punchIntervals.js).
const PUNCH_KIND = { checkin: 'Check-in', checkout: 'Check-out', interval: 'Interval', extra: 'Outside the day' };
const minsText = (m) => (m == null ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`);
const spanName = (from, to) => (from === to ? from : `${from}_to_${to}`);

// A section of the Dashboard: a title with its count, a search box and the Export buttons, and a fold button.
function Section({ id, title, count, hint, q, setQ, onExport, busy, disabled, open, setOpen, children }) {
  return (
    <section className="att-kr-sec" id={id}>
      <div className="att-kr-sec-head">
        <button type="button" className="att-kr-fold" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Fold this list' : 'Open this list'}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> <b>{title}</b>
        </button>
        {count != null && <span className="small-muted">— {count}</span>}
        {open && (
          <span className="att-kr-sec-tools">
            <input type="search" placeholder="Search name or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search the ${title}`} />
            <button type="button" className="btn btn-sm" onClick={() => onExport('csv')} disabled={disabled || busy} title="Every row matching the filters above">CSV</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onExport('xlsx')} disabled={disabled || busy} title="Every row matching the filters above">Excel</button>
          </span>
        )}
      </div>
      {open && hint && <div className="small-muted att-kr-sec-hint">{hint}</div>}
      {open && children}
    </section>
  );
}

// ---- The biometric list: first check-in, last check-out, hours --------------------------------------------------------
// One line per person per day, the old report's columns. Only days with a check-in unless "Show people without a check-in"
// is ticked (the same rule as the old screen). Imported days show the CSV's values as exported.
export function BiometricList({ from, to, dept, emp, empCode, how, src, canSee = true }) {
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openRow, setOpenRow] = useState(null);

  const params = {
    ...(from === to ? { date: from } : { from, to }),
    ...(dept ? { department: dept } : {}),
    ...(q.trim() ? { q: q.trim() } : emp && empCode ? { q: empCode } : {}),
    ...(how && how !== 'Nothing recorded' ? { method: how } : {}),
    ...(src ? { punchSource: src } : {}),
    ...(everyone ? { all: '1' } : {}),
  };
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!open || !canSee) return undefined;
    let alive = true;
    setError('');
    // a short pause so typing in the search box asks the server once, not once per letter
    const t = setTimeout(() => {
      api.get('/attendance/biometric', { params })
        .then((res) => { if (alive) setData(res.data); })
        .catch((e) => { if (alive) { setData(null); setError(e.response?.data?.error || 'Could not load the biometric list.'); } });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [key, open, canSee]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const page = usePaged(rows, 100);

  async function exportAs(format) {
    setBusy(true);
    try { await downloadFrom('/attendance/biometric', { ...params, format }, `first-check-in-last-check-out-${spanName(from, to)}.${format}`); } catch { setError('Could not export the list.'); } finally { setBusy(false); }
  }

  if (!canSee) return null;
  return (
    <Section
      id="att-biometric" title="Biometric list — first check-in & last check-out" count={data ? `${rows.length.toLocaleString()} ${rows.length === 1 ? 'day' : 'days'}` : null}
      q={q} setQ={setQ} onExport={exportAs} busy={busy} disabled={!data} open={open} setOpen={setOpen}
      hint={(
        <>
          One line per person per day. First Check In = the first check-in, Last Check Out = the last check-out the person pressed, Total Hours = last out − first in,
          Total Time In Break = the gaps from a check-out to the next check-in, Total Time Worked = Total Hours − breaks. Imported days show the old HRMS report&apos;s values as exported.
          {data && !data.everyone && data.withoutCheckIn > 0 && (
            <> <b>{data.withoutCheckIn}</b> day(s) on the rolls without a check-in are not listed — <button type="button" className="link-btn" onClick={() => setEveryone(true)}>show them</button>.</>
          )}
          {everyone && <> <button type="button" className="link-btn" onClick={() => setEveryone(false)}>Only the days with a check-in</button></>}
        </>
      )}
    >
      {error && <div className="notice red">{error}</div>}
      <ScrollTable maxHeight="60vh">
        <table>
          <thead>
            <tr>
              {['Employee No', 'Employee Name', 'Department', 'Designation', 'Date', 'Day status', 'Check-in method', 'First Check In', 'Last Check Out', 'Work Location', 'Total Time Worked', 'Total Time In Break', 'Total Hours', 'Punches by source']
                .map((h) => <th key={h} style={{ whiteSpace: 'nowrap' }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {page.slice.map((r) => {
              const rk = `${r.employeeId}-${r.date}`;
              return [(
                <tr key={rk} title={`${r.dateLabel}: ${r.bucket === 'noRecord' ? 'No device data' : r.status}${r.note ? ` — ${r.note}` : ''}`}>
                  <td><b>{r.employeeNo}</b></td>
                  <td>{r.name}</td>
                  <td className="cell-muted">{r.department || ''}</td>
                  <td className="cell-muted">{r.designation || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.dateLabel}</td>
                  <td>
                    {r.status ? <DayStatus status={r.bucket === 'noRecord' ? 'No device data' : r.status} earlyLogout={r.earlyLogout} /> : ''}
                    {r.halfLeave ? <div><HalfLeaveChip state={r.halfLeave} half={r.halfLeaveHalf} by={r.halfLeaveBy} /></div> : null}
                  </td>
                  <td className="cell-muted">{r.methodText || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.firstCheckIn || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.lastCheckOut || ''}</td>
                  <td className="cell-muted">{r.workLocation || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.totalTimeWorked || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.totalBreak || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.totalHours || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <SourceChips counts={r.sourceCounts} />
                    {(r.rawPunches || []).length > 0 && <div><PunchToggle open={openRow === rk} count={r.rawPunches.length} onClick={() => setOpenRow(openRow === rk ? null : rk)} /></div>}
                  </td>
                </tr>
              ), openRow === rk && <tr key={`${rk}-d`}><td colSpan="14"><PunchDetails list={r.rawPunches} /></td></tr>];
            })}
            {data && rows.length === 0 && <tr><td colSpan="14" className="att-kr-empty">No check-ins in this period.</td></tr>}
            {!data && !error && <tr><td colSpan="14" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>}
          </tbody>
        </table>
      </ScrollTable>
      {rows.length > 0 && <Pager page={page} noun="days" />}
    </Section>
  );
}

// ---- The punch log: every punch, and how many times each day ---------------------------------------------------------
// One row per person per day: Punches (how many times), every punch time with where it came from, the time intervals
// (out -> back), First in, Last out. The server pages it; the export has every row.
export function PunchLogList({ from, to, dept, emp, how, src }) {
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState('');
  const [absentees, setAbsentees] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openRow, setOpenRow] = useState(null);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(100);

  const query = {
    from, to,
    ...(dept ? { department: dept } : {}),
    ...(emp ? { employeeId: emp } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(how && how !== 'Nothing recorded' ? { method: how } : {}),
    ...(src ? { punchSource: src } : {}),
    ...(absentees ? { absentees: '1' } : {}),
  };
  const qKey = JSON.stringify(query);
  useEffect(() => { setPageNo(1); }, [qKey, pageSize]);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setError('');
    const t = setTimeout(() => {
      api.get('/attendance/punch-log', { params: { ...query, page: String(pageNo), pageSize: String(pageSize) } })
        .then((res) => { if (alive) setData(res.data); })
        .catch((e) => { if (alive) { setData(null); setError(e.response?.data?.error || 'Could not load the punch log.'); } });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [qKey, pageNo, pageSize, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || [];
  const totals = data?.totals || { rows: 0, employees: 0, punches: 0 };
  const pg = data?.page || { page: 1, pages: 1, total: rows.length, pageSize };
  const page = {
    total: pg.total, pages: pg.pages, size: pageSize, setSize: setPageSize, page: pg.page, setPage: setPageNo,
    from: pg.total ? (pg.page - 1) * pageSize + 1 : 0, to: Math.min(pg.page * pageSize, pg.total),
  };

  async function exportAs(format) {
    setBusy(true);
    try { await downloadFrom('/attendance/punch-log', { ...query, format }, `punch-log-${spanName(from, to)}.${format}`); } catch { setError('Could not export the punch log.'); } finally { setBusy(false); }
  }

  return (
    <Section
      id="att-punchlog" title="Punch log — every punch of the day" count={data ? `${totals.punches.toLocaleString()} punches · ${totals.employees.toLocaleString()} ${totals.employees === 1 ? 'person' : 'people'} · ${totals.rows.toLocaleString()} ${totals.rows === 1 ? 'day' : 'days'}` : null}
      q={q} setQ={setQ} onExport={exportAs} busy={busy} disabled={!data} open={open} setOpen={setOpen}
      hint={(
        <>
          <b>Punches</b> = how many times the person punched that day. Each time says where it came from: <b>Device</b> (biometric machine), <b>Web</b> (web / mobile check-in),
          {' '}<b>Import</b> (old HRMS file) or <b>HR</b> (typed or set by HR). <b>Time interval</b> = every punch between the check-in and the check-out, out → back, with the time away.
          {' '}<label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, margin: '0 0 0 8px' }} title="Also list the people on the rolls with no punch that day">
            <input type="checkbox" style={{ width: 15, height: 15, minHeight: 0, minWidth: 0 }} checked={absentees} onChange={(e) => setAbsentees(e.target.checked)} /> Show people without punches
          </label>
        </>
      )}
    >
      {error && <div className="notice red">{error}</div>}
      <ScrollTable maxHeight="60vh">
        <table>
          <thead>
            <tr><th>Employee</th><th>Department</th><th>Date</th><th style={{ textAlign: 'center' }}>Punches</th><th>Punch times</th><th title="Every punch between the check-in and the check-out: out → back, and the time away.">Time interval</th><th>First in</th><th>Last out</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rk = `${r.employeeId}-${r.date}`;
              const list = r.punchList || [];
              return [
                <tr key={rk} title={r.dayStatus ? `${r.dateLabel}: ${r.dayStatus}` : undefined}>
                  <td style={{ whiteSpace: 'nowrap' }}><b>{r.employeeCode}</b> {r.name}</td>
                  <td className="cell-muted">{r.department || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.dateLabel}</td>
                  <td style={{ textAlign: 'center', fontSize: 15 }}><b>{r.punchCount || 0}</b></td>
                  <td>
                    {list.length
                      ? (
                        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                          {list.map((p, i) => (
                            <span key={`${p.time}-${i}`} className={`psc-chip psc-${p.source}`} title={`${p.time} · ${PUNCH_KIND[p.kind] || (p.direction === 'Out' ? 'Out' : 'In')} · ${p.from}`}>
                              {hhmm(p.time)} <span style={{ fontWeight: 400 }}>{PUNCH_FROM[p.source] || p.from}</span>
                            </span>
                          ))}
                        </span>
                      )
                      : <span className="cell-muted">{r.dayStatus || 'No punch'}</span>}
                    {(r.rawPunches || []).length > 0 && <div><PunchToggle open={openRow === rk} count={r.rawPunches.length} onClick={() => setOpenRow(openRow === rk ? null : rk)} /></div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {(r.intervals || []).length
                      ? (
                        <>
                          {r.intervals.map((iv, i) => (
                            <div key={`${iv.from}-${i}`} title={iv.to ? `${hhmm(iv.from)} (${iv.fromSource}) → ${hhmm(iv.to)} (${iv.toSource})` : `${hhmm(iv.from)} (${iv.fromSource}): no later punch`}>
                              {hhmm(iv.from)} → {iv.to ? hhmm(iv.to) : <span className="cell-muted">no return</span>}
                              {iv.minutes != null && <span className="cell-muted"> · {minsText(iv.minutes)}</span>}
                            </div>
                          ))}
                          {r.intervals.length > 1 && r.intervalMinutes > 0 && <div className="small-muted">Total {minsText(r.intervalMinutes)}</div>}
                        </>
                      )
                      : <span className="cell-muted">{list.length ? 'No interval' : '—'}</span>}
                    {r.hrSetTimes && <div className="small-muted" title="HR set the check-in / check-out by hand; they stand over the device punches">HR set times</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{hhmm(r.firstInTime)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.lastOutTime ? hhmm(r.lastOutTime) : <span className="cell-muted">{list.length ? 'No check-out' : '—'}</span>}</td>
                </tr>,
                openRow === rk && <tr key={`${rk}-d`}><td colSpan="8"><PunchDetails list={r.rawPunches} /></td></tr>,
              ];
            })}
            {data && rows.length === 0 && <tr><td colSpan="8" className="att-kr-empty">No punches in these dates.</td></tr>}
            {!data && !error && <tr><td colSpan="8" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>}
          </tbody>
        </table>
      </ScrollTable>
      {pg.total > 0 && <Pager page={page} noun="rows" />}
      {data && pg.pages > 1 && <div className="small-muted" style={{ fontSize: 12 }}>The export has every matching row.</div>}
    </Section>
  );
}
