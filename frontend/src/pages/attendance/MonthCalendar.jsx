// ---------------------------------------------------------------------------
// ATTENDANCE CALENDAR (HRMS spec 2026-10-09, point 2) — HRMS -> Attendance &
// Time -> Monthly Summary -> "Calendar".
//
// Pick a month and a year; every day of the month is a box that says how many
// people were Present, Absent, on Half day, On leave, Late, left Early, were
// missing a check-in / check-out, and which days are a Holiday or the Week off
// (only Sunday, plus the company holidays). Tap a day to see the people behind
// the numbers, each with the plain reason and HOW the day was marked
// (Biometric device, Face check-in, Web, Mobile, Entered by HR, Imported).
//
// Filters: Department, Employee, Status, How marked, Employee status. They
// CASCADE (each list is counted with the others applied, options with nothing
// behind them are not offered) - counted in the browser from the month's rows.
// The rows are the ones the Attendance report uses (GET /attendance/kpi-report,
// utils/attendanceDays.js classifyDay - the one day rule behind every screen),
// so a number here is always the same as there. Pick one employee and the
// calendar becomes that person's own month.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api';
import { FacetSelect, useLocalFacets } from '../../components/ui/ListPageHeader.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import ScrollTable from '../../components/ScrollTable.jsx';
import { downloadFrom } from './MyAttendance.jsx';
import { fmtDay, clock12, localToday, HalfLeaveChip } from './DayReport.jsx';
import './attendance-calendar.css';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const t12 = (t) => (t ? clock12(String(t).slice(0, 5)) : '—');

// One status word per day (the user's list). Late coming is a flag on top of
// Present / Half day etc. and has its own filter value.
export const CATS = [
  { key: 'present', label: 'Present', tone: 'green' },
  { key: 'absent', label: 'Absent', tone: 'red' },
  { key: 'halfDay', label: 'Half day', tone: 'red' },
  { key: 'onLeave', label: 'On leave', tone: 'green' },
  { key: 'late', label: 'Late coming', tone: 'orange' },
  { key: 'earlyLogout', label: 'Early logout', tone: 'orange' },
  { key: 'missingCheckIn', label: 'Missing check-in', tone: 'red' },
  { key: 'missingCheckOut', label: 'Missing check-out', tone: 'red' },
  { key: 'leaveRejected', label: 'Half-day leave rejected', tone: 'red' },
  { key: 'noPunches', label: 'No punches', tone: 'orange' },
  { key: 'punchOnLeave', label: 'Punch on a leave day', tone: 'orange' },
  { key: 'holiday', label: 'Holiday', tone: 'grey' },
  { key: 'weeklyOff', label: 'Week off', tone: 'grey' },
  { key: 'other', label: 'Not counted yet', tone: 'blue' },
];
const CAT = Object.fromEntries(CATS.map((c) => [c.key, c]));
const SHORT = { noPunches: 'No punch', punchOnLeave: 'Punch on leave', present: 'Present', absent: 'Absent', halfDay: 'Half', onLeave: 'Leave', late: 'Late', earlyLogout: 'Early', missingCheckIn: 'No in', missingCheckOut: 'No out', holiday: 'Holiday', weeklyOff: 'Week off', other: 'Other' };

// The ONE main word for a day row = its tile (Present / Absent / Half day / On leave / Week off-Holiday).
// Early logout, Missing check-in and Missing check-out are people who WORKED, so they are Present;
// they (and Late) are notes on top of Present, never a second count (user, 2026-10-09).
export function catOf(r) {
  switch (r.tile) {
    case 'present': case 'absent': case 'halfDay': case 'onLeave': return r.tile;
    case 'offDay': return r.dayStatus === 'Holiday' ? 'holiday' : 'weeklyOff';
    default: return 'other';
  }
}
// Every status word a row answers to: its main word, plus the notes it carries (Present only).
const catsOf = (r) => [catOf(r), ...(r.notes || [])];

const FIELDS = [
  { key: 'department', get: (r) => r.department || '' },
  { key: 'employeeId', get: (r) => r.employeeId, label: (v, r) => `${r.name} (${r.employeeCode})` },
  { key: 'status', get: catsOf, label: (v) => CAT[v]?.label || v },
  { key: 'how', get: (r) => r.how || 'Nothing recorded' },
];
const EMPTY = { department: '', employeeId: '', status: '', how: '' };

export default function MonthCalendar() {
  const today = localToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [f, setF] = useState(EMPTY);
  const [pickedDay, setPickedDay] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const seq = useRef(0);
  const detailRef = useRef(null);

  const from = `${month}-01`;
  const to = monthEnd(month);
  useEffect(() => {
    const mine = ++seq.current;
    setError(''); setData(null);
    api.get('/attendance/kpi-report', { params: { from, to } })
      .then((res) => { if (mine === seq.current) setData(res.data); })
      .catch((e) => { if (mine === seq.current) setError(e.response?.data?.error || 'Could not load the calendar. Please try again.'); });
  }, [from, to]);

  const rows = useMemo(() => (data && data.rows) || [], [data]);
  // The cascading lists, counted over this month's rows.
  const facets = useLocalFacets(rows, FIELDS, f);
  const statusOptions = useMemo(() => (facets.status || [])
    .sort((a, b) => CATS.findIndex((c) => c.key === a.value) - CATS.findIndex((c) => c.key === b.value)), [facets.status]);

  const shown = useMemo(() => rows.filter((r) => (!f.department || (r.department || '') === f.department)
    && (!f.employeeId || r.employeeId === f.employeeId)
    && (!f.status || catsOf(r).includes(f.status))
    && (!f.how || (r.how || 'Nothing recorded') === f.how)), [rows, f]);

  // Rows by date.
  const byDate = useMemo(() => {
    const m = new Map();
    shown.forEach((r) => { if (!m.has(r.date)) m.set(r.date, []); m.get(r.date).push(r); });
    return m;
  }, [shown]);

  // Drop a chosen value that the other filters no longer leave anything for.
  useEffect(() => {
    if (!data) return;
    setF((cur) => {
      let next = cur; let changed = false;
      FIELDS.forEach((fd) => {
        const v = cur[fd.key];
        if (v && !(facets[fd.key] || []).some((o) => o.value === v)) { next = { ...next, [fd.key]: '' }; changed = true; }
      });
      return changed ? next : cur;
    });
  }, [data, facets]);

  const setFilter = (k, v) => { setF((cur) => ({ ...cur, [k]: v })); };
  const anyFilter = Object.values(f).some(Boolean);

  // The grid: weeks starting Sunday.
  const [yy, mm] = month.split('-').map(Number);
  const firstDow = new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay();
  const daysIn = Number(to.slice(8, 10));
  const cells = [];
  for (let i = 0; i < firstDow; i += 1) cells.push(null);
  for (let d = 1; d <= daysIn; d += 1) cells.push(`${month}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);

  const shift = (n) => { const d = new Date(Date.UTC(yy, mm - 1 + n, 1)); setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`); setPickedDay(''); };
  const setYM = (y, m) => { setMonth(`${y}-${pad(m)}`); setPickedDay(''); };
  const thisYear = Number(today.slice(0, 4));
  const years = []; for (let y = thisYear + 1; y >= thisYear - 3; y -= 1) years.push(y);

  const holidayName = (date) => { const r = (byDate.get(date) || rows.filter((x) => x.date === date)).find((x) => x.dayStatus === 'Holiday'); return r ? r.reason.replace(/^Holiday — /, '') : ''; };

  const dayRows = pickedDay ? (byDate.get(pickedDay) || []) : [];
  const s = q.trim().toLowerCase();
  const list = dayRows.filter((x) => !s || `${x.name} ${x.employeeCode} ${x.department}`.toLowerCase().includes(s))
    .sort((a, b) => a.name.localeCompare(b.name));
  const page = usePaged(list, 25);
  const pick = (date) => {
    setPickedDay((cur) => (cur === date ? '' : date)); setQ('');
    setTimeout(() => { if (detailRef.current) detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50);
  };

  async function exportExcel() {
    setBusy(true); setSaved('');
    try {
      const params = { from, to, ...(f.department ? { department: f.department } : {}), ...(f.employeeId ? { employeeId: f.employeeId } : {}), format: 'xlsx' };
      const name = `attendance-calendar-${month}.xlsx`;
      await downloadFrom('/attendance/kpi-report', params, name);
      setSaved(`Saved ${name}`);
    } catch { setError('Could not make the Excel file. Please try again.'); } finally { setBusy(false); }
  }

  // Counts in the month under the current filters (the line under the calendar).
  const totals = useMemo(() => {
    const c = Object.fromEntries(CATS.map((k) => [k.key, 0]));
    shown.forEach((r) => catsOf(r).forEach((k) => { c[k] += 1; }));
    return c;
  }, [shown]);
  const one = !!f.employeeId;

  return (
    <div className="att-cal">
      <p className="att-cal-lead">
        Pick a month, then tap a day to see who was present, absent, on leave or late. Week off is <b>only Sunday</b> (plus the company holidays).
        {' '}Use the lists to look at one department or one person; the number in brackets is how many days (one person on one day) match.
      </p>

      <div className="att-cal-bar">
        <div className="att-cal-nav" role="group" aria-label="Month and year">
          <button type="button" className="btn btn-sm" aria-label="Previous month" onClick={() => shift(-1)}>◀</button>
          <select value={mm} onChange={(e) => setYM(yy, Number(e.target.value))} aria-label="Month">
            {MONTHS.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
          </select>
          <select value={yy} onChange={(e) => setYM(Number(e.target.value), mm)} aria-label="Year">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button type="button" className="btn btn-sm" aria-label="Next month" onClick={() => shift(1)}>▶</button>
          {month !== today.slice(0, 7) && <button type="button" className="btn btn-sm" onClick={() => { setMonth(today.slice(0, 7)); setPickedDay(''); }}>This month</button>}
        </div>
        <span className="att-cal-grow" />
        <button type="button" className="btn btn-primary btn-sm" disabled={!data || busy} onClick={exportExcel}>{busy ? 'Making file…' : 'Export month to Excel'}</button>
      </div>
      {saved && <div className="att-cal-saved">{saved}</div>}

      <div className="att-cal-filters">
        <FacetSelect label="Department" allLabel="All departments" value={f.department} onChange={(v) => setFilter('department', v)} options={facets.department || []} loading={!data} />
        <FacetSelect label="Employee" allLabel="Everyone" value={f.employeeId} onChange={(v) => setFilter('employeeId', v)} options={(facets.employeeId || []).slice().sort((a, b) => a.label.localeCompare(b.label))} loading={!data} />
        <FacetSelect label="Status" allLabel="Any status" value={f.status} onChange={(v) => setFilter('status', v)} options={statusOptions} loading={!data} />
        <FacetSelect label="Check-in method" allLabel="Any method" value={f.how} onChange={(v) => setFilter('how', v)} options={facets.how || []} loading={!data} />
        {anyFilter && <button type="button" className="btn btn-sm" onClick={() => setF(EMPTY)}>Clear filters</button>}
      </div>

      {error && <div className="notice red">{error}</div>}
      {!data && !error && <div className="small-muted">Loading…</div>}

      {data && (
        <>
          <div className="att-cal-title">{MONTHS[mm - 1]} {yy}{one ? ` — ${(rows.find((r) => r.employeeId === f.employeeId) || {}).name || ''}` : ''}</div>
          <div className="att-cal-grid" role="grid" aria-label={`${MONTHS[mm - 1]} ${yy}`}>
            {WEEK.map((w) => <div key={w} className="att-cal-dow" role="columnheader">{w}</div>)}
            {cells.map((date, i) => {
              if (!date) return <div key={`b${i}`} className="att-cal-cell blank" aria-hidden="true" />;
              const rs = byDate.get(date) || [];
              const counts = {};
              rs.forEach((r) => catsOf(r).forEach((k) => { counts[k] = (counts[k] || 0) + 1; }));
              const allOff = rs.length > 0 && rs.every((r) => ['holiday', 'weeklyOff'].includes(catOf(r)));
              const isHol = rs.some((r) => catOf(r) === 'holiday');
              const future = date > today;
              const day = Number(date.slice(8, 10));
              const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
              const cls = ['att-cal-cell', date === today ? 'today' : '', date === pickedDay ? 'picked' : '', future ? 'future' : '', allOff ? (isHol ? 'holiday' : 'off') : '', dow === 0 ? 'sun' : ''].filter(Boolean).join(' ');
              const mine = one && rs.length === 1 ? rs[0] : null;
              return (
                <button key={date} type="button" className={cls} onClick={() => pick(date)} aria-pressed={date === pickedDay}
                  aria-label={`${fmtDay(date)}: ${rs.length ? Object.entries(counts).map(([k, n]) => `${n} ${CAT[k].label}`).join(', ') : 'nobody listed'}`}>
                  <span className="att-cal-day">{day}</span>
                  {mine && (
                    <span className="att-cal-mine">
                      <span className={`att-cal-pill tone-${CAT[catOf(mine)].tone}`}>{CAT[catOf(mine)].label}</span>
                      {(mine.notes || []).map((k) => <span key={k} className="att-cal-pill tone-orange">{CAT[k].label}</span>)}
                      {mine.checkIn ? <span className="att-cal-time">{t12(mine.checkIn)} – {t12(mine.checkOut)}</span> : null}
                    </span>
                  )}
                  {!mine && allOff && <span className="att-cal-offword">{isHol ? (holidayName(date) || 'Holiday') : 'Week off'}</span>}
                  {!mine && !allOff && (
                    <span className="att-cal-chips">
                      {CATS.filter((k) => counts[k.key]).map((k) => (
                        <span key={k.key} className={`att-cal-chip tone-${k.tone}`} title={`${counts[k.key]} ${k.label}`}>
                          <b>{counts[k.key]}</b><span className="att-cal-chipword"> {SHORT[k.key]}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="att-cal-legend">
            {CATS.filter((k) => totals[k.key] > 0).map((k) => (
              <button key={k.key} type="button" className={`att-cal-key tone-${k.tone}${f.status === k.key ? ' on' : ''}`}
                onClick={() => setFilter('status', f.status === k.key ? '' : k.key)} title={`Show only ${k.label.toLowerCase()} days`}>
                <i /> {k.label} <b>{totals[k.key]}</b>
              </button>
            ))}
            <span className="small-muted att-cal-keyhint">{one ? 'days' : 'person-days'} in {MONTHS[mm - 1]} · tap a word to filter</span>
          </div>
          {data.noDataDates && data.noDataDates.length > 0 && (
            <div className="notice att-cal-note">
              Nothing has come from the biometric device yet for {data.noDataDates.length === 1 ? fmtDay(data.noDataDates[0]) : `${data.noDataDates.length} days (${fmtDay(data.noDataDates[0])} → ${fmtDay(data.noDataDates[data.noDataDates.length - 1])})`}.
              {' '}Those days are in <b>Not counted yet</b>, not Absent.
            </div>
          )}

          <div ref={detailRef} className="att-cal-detail">
            {!pickedDay ? (
              <div className="att-cal-hint">Tap a day above to see the people behind it.</div>
            ) : (
              <>
                <div className="att-cal-dhead">
                  <b>{fmtDay(pickedDay)}</b>
                  <span className="small-muted"> — {dayRows.length} {dayRows.length === 1 ? 'person' : 'people'}{anyFilter ? ' (with your filters)' : ''}</span>
                  <button type="button" className="btn btn-sm" onClick={() => setPickedDay('')}>Close</button>
                  <input type="search" placeholder="Search name or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search this day" />
                </div>
                <ScrollTable maxHeight="50vh">
                  <table>
                    <thead><tr><th>Name</th><th>Employee ID</th><th>Department</th><th>Status</th><th>In</th><th>Out</th><th>Check-in method</th><th>Why</th></tr></thead>
                    <tbody>
                      {page.slice.map((x) => (
                        <tr key={x.employeeId}>
                          <td><b>{x.name}</b></td>
                          <td>{x.employeeCode}</td>
                          <td className="cell-muted">{x.department || '—'}</td>
                          <td>
                            <span className={`att-cal-pill tone-${CAT[catOf(x)].tone}`}>{CAT[catOf(x)].label}{x.session ? ` · ${x.session === 'First half' ? '1st half' : '2nd half'}` : ''}</span>
                            {(x.notes || []).map((k) => <span key={k} className="att-cal-pill tone-orange">{CAT[k].label}</span>)}
                            {x.halfLeave ? <div><HalfLeaveChip state={x.halfLeave} half={x.halfLeaveHalf} by={x.halfLeaveBy} /></div> : null}
                            {x.latePermissionText ? <div><span className={`att-cal-pill tone-${x.lateExcused ? 'green' : 'orange'}`}>{x.latePermissionText}</span></div> : null}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>{t12(x.checkIn)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{t12(x.checkOut)}</td>
                          <td>{x.howText || x.how || <span className="small-muted">Nothing recorded</span>}</td>
                          <td className="att-cal-why">{x.reason}</td>
                        </tr>
                      ))}
                      {list.length === 0 && <tr><td colSpan="8" className="att-cal-empty">{anyFilter ? 'Nobody on this day matches your filters.' : 'Nobody is on the rolls on this day.'}</td></tr>}
                    </tbody>
                  </table>
                </ScrollTable>
                {page.total > 0 && <Pager page={page} noun="people" />}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
