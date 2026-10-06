// ---------------------------------------------------------------------------
// THE ATTENDANCE REPORT (user, 2026-10-05) — HRMS → Attendance → Dashboard.
//
// Cards: Present · Absent · Half day (1st / 2nd half) · Early logout · Late ·
// Missing check-in · Missing check-out · On leave. Each card opens its list
// (name, employee ID, department, date, in, out, the plain reason). Every
// number is the length of its list: both come from the same server rows
// (GET /attendance/kpi-report, utils/attendanceDays.js classifyDay — the one
// rule behind every attendance screen). Filters: Day / Week / Month, then
// Department → Employee (cascading, with counts). Export to Excel is its own
// button. Week offs and holidays are not cards (never Absent either).
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { FacetSelect } from '../../components/ui/ListPageHeader.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import ScrollTable from '../../components/ScrollTable.jsx';
import { downloadFrom } from './MyAttendance.jsx';
import { fmtDay, clock12, localToday, addDays } from './DayReport.jsx';
import './kpi-report.css';

const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const weekStart = (d) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
function rangeOf(mode, anchor) {
  if (mode === 'week') { const f = weekStart(anchor); return { from: f, to: addDays(f, 6) }; }
  if (mode === 'month') { const ym = anchor.slice(0, 7); return { from: `${ym}-01`, to: monthEnd(ym) }; }
  return { from: anchor, to: anchor };
}
function step(mode, anchor, n) {
  if (mode === 'week') return addDays(anchor, 7 * n);
  if (mode === 'month') {
    const [y, m] = anchor.slice(0, 7).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  return addDays(anchor, n);
}
function rangeLabel(mode, from, to) {
  if (mode === 'month') return `${MO[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  if (mode === 'week') return `${fmtDay(from)} → ${fmtDay(to)}`;
  return fmtDay(from);
}

// The cards, in the user's order. tone = the four colours of the simple-UX
// rule (green done · blue going on · orange waiting · red problem).
const CARDS = [
  { key: 'present', label: 'Present', tone: 'green', hint: 'Came and stayed till the end', hintOf: (r) => `Stayed till ${r.end}` },
  { key: 'absent', label: 'Absent', tone: 'red', hint: 'No check-in, did not inform' },
  { key: 'halfDay', label: 'Half day', tone: 'red', hint: 'Worked one half', parts: [['first', '1st half'], ['second', '2nd half'], ['marked', 'Marked by HR']] },
  { key: 'earlyLogout', label: 'Early logout', tone: 'orange', hint: 'Left a little early', hintOf: (r) => `Left ${r.early} – ${r.end}` },
  { key: 'late', label: 'Late', tone: 'orange', hint: 'Came late', hintOf: (r) => `Came after ${r.late}` },
  { key: 'missingCheckIn', label: 'Missing check-in', tone: 'red', hint: 'Check-out only — HR to fix' },
  { key: 'missingCheckOut', label: 'Missing check-out', tone: 'red', hint: 'Check-in only — HR to fix' },
  { key: 'onLeave', label: 'On leave', tone: 'green', hint: 'Leave or told the manager', parts: [['approved', 'Approved'], ['pending', 'Pending'], ['informed', 'Informed']] },
  { key: 'inOffice', label: 'Still in office', tone: 'blue', hint: 'Today, checked in', onlyIfAny: true },
  { key: 'notYet', label: 'Not in yet', tone: 'blue', hint: 'Today, no punch yet', onlyIfAny: true },
  { key: 'noData', label: 'No device data', tone: 'grey', hint: 'Device has not sent these days', onlyIfAny: true },
  // Not a KPI, but counted, so the cards add up to the headcount (user, 2026-10-05).
  { key: 'offDay', label: 'Week off / Holiday', tone: 'grey', hint: 'Not a working day for them' },
];
const NAME = Object.fromEntries(CARDS.map((c) => [c.key, c.label]));
// The cards that add up to the HEADCOUNT (Late is inside them).
const SUMMED = CARDS.filter((c) => c.key !== 'late').map((c) => c.key);
const hintOf = (k, r) => (r && k.hintOf ? k.hintOf(r) : k.hint);
const t12 = (t) => (t ? clock12(String(t).slice(0, 5)) : '—');

export default function KpiReport({ onRangeChange } = {}) {
  const [mode, setMode] = useState('day');
  const [anchor, setAnchor] = useState(localToday());
  const [dept, setDept] = useState('');
  const [emp, setEmp] = useState('');
  const [pick, setPick] = useState({ kpi: '', part: '' });
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const { from, to } = rangeOf(mode, anchor);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setError('');
    const params = { from, to, ...(dept ? { department: dept } : {}), ...(emp ? { employeeId: emp } : {}) };
    api.get('/attendance/kpi-report', { params })
      .then((res) => { if (mine === seq.current) setData(res.data); })
      .catch((e) => { if (mine === seq.current) setError(e.response?.data?.error || 'Could not load the attendance report. Please try again.'); });
  }, [from, to, dept, emp]);

  // The page around the report (daily marking, regularizations) follows its period.
  useEffect(() => { if (onRangeChange) onRangeChange(from, to); }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  // Picking a department that does not have the chosen person clears the person.
  useEffect(() => {
    if (emp && data && !(data.facets?.employeeId || []).some((o) => o.value === emp)) setEmp('');
  }, [data, emp]);

  const rowsAll = (data && data.rows) || [];
  const match = (x) => {
    if (!pick.kpi) return true;
    if (pick.kpi === 'late') return x.lateDay;
    if (x.kpi !== pick.kpi) return false;
    if (pick.kpi === 'halfDay' && pick.part) return pick.part === 'first' ? x.session === 'First half' : pick.part === 'second' ? x.session === 'Second half' : !x.session;
    if (pick.kpi === 'onLeave' && pick.part) return x.leaveKind === pick.part;
    return true;
  };
  const s = q.trim().toLowerCase();
  const list = rowsAll.filter((x) => match(x) && (!s || `${x.name} ${x.employeeCode} ${x.department}`.toLowerCase().includes(s)));
  const page = usePaged(list, 50);

  const choose = (kpi, part = '') => setPick((cur) => (cur.kpi === kpi && cur.part === part ? { kpi: '', part: '' } : { kpi, part }));

  async function exportExcel() {
    setBusy(true); setSaved('');
    try {
      const params = { from, to, ...(dept ? { department: dept } : {}), ...(emp ? { employeeId: emp } : {}), ...(pick.kpi ? { kpi: pick.kpi, part: pick.part } : {}), format: 'xlsx' };
      const name = `attendance-${pick.kpi ? `${NAME[pick.kpi].toLowerCase().replace(/\s+/g, '-')}-` : ''}${from === to ? from : `${from}_to_${to}`}.xlsx`;
      await downloadFrom('/attendance/kpi-report', params, name);
      setSaved(`Saved ${name}`);
    } catch { setError('Could not make the Excel file. Please try again.'); } finally { setBusy(false); }
  }

  const c = data ? data.cards : {};
  const parts = data ? data.parts : {};
  const shownCards = CARDS.filter((k) => !k.onlyIfAny || (c[k.key] || 0) > 0);
  const listTitle = pick.kpi
    ? `${NAME[pick.kpi]}${pick.part ? ` — ${(CARDS.find((k) => k.key === pick.kpi).parts || []).find(([v]) => v === pick.part)?.[1] || ''}` : ''}`
    : 'Everyone (headcount)';
  const r = data && data.rule;

  return (
    <div className="att-kr">
      <div className="att-kr-head">
        <h3>Attendance report</h3>
        <button type="button" className="btn btn-primary btn-sm" disabled={!data || busy} onClick={exportExcel}>{busy ? 'Making file…' : 'Export to Excel'}</button>
      </div>
      {saved && <div className="att-kr-saved">{saved}</div>}

      <div className="att-kr-bar">
        <div className="att-kr-seg" role="group" aria-label="Period">
          {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([k, l]) => (
            <button key={k} type="button" className={`btn btn-sm${mode === k ? ' btn-primary' : ''}`} onClick={() => { setMode(k); setPick({ kpi: '', part: '' }); }}>{l}</button>
          ))}
        </div>
        <div className="att-kr-nav">
          <button type="button" className="btn btn-sm" aria-label="Previous" onClick={() => setAnchor(step(mode, anchor, -1))}>◀</button>
          {mode === 'month'
            ? <input type="month" value={anchor.slice(0, 7)} onChange={(e) => e.target.value && setAnchor(`${e.target.value}-01`)} aria-label="Month" />
            : <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} aria-label="Date" />}
          <button type="button" className="btn btn-sm" aria-label="Next" onClick={() => setAnchor(step(mode, anchor, 1))}>▶</button>
          {anchor !== localToday() && <button type="button" className="btn btn-sm" onClick={() => setAnchor(localToday())}>Today</button>}
        </div>
        <span className="att-kr-range">{rangeLabel(mode, from, to)}</span>
      </div>

      <div className="att-kr-filters">
        <FacetSelect label="Department" allLabel="All departments" value={dept} onChange={(v) => { setDept(v); setPick({ kpi: '', part: '' }); }} options={data?.facets?.department || []} loading={!data} />
        <FacetSelect label="Employee" allLabel="Everyone" value={emp} onChange={(v) => { setEmp(v); setPick({ kpi: '', part: '' }); }} options={data?.facets?.employeeId || []} loading={!data} />
        {(dept || emp) && <button type="button" className="btn btn-sm att-kr-clear" onClick={() => { setDept(''); setEmp(''); }}>Clear filters</button>}
      </div>

      {error && <div className="notice red">{error}</div>}
      {!data && !error && <div className="small-muted">Loading…</div>}

      {data && (
        <>
          {r && (
            <div className="att-kr-rule">
              Office {r.start} – {r.end} · 1st half {r.start} – {r.split} · 2nd half {r.split} – {r.end} ·
              {' '}Left {r.early} – {r.end} = <b>Early logout</b> ({r.early} sharp counts as early logout) · Left before {r.early} = <b>Half day</b> ·
              {' '}Came at / after {r.split} = <b>Half day (2nd half)</b> · Came after {r.late} = <b>Late</b> · No check-in and no leave / request = <b>Absent</b>
            </div>
          )}
          {data.noDataDates && data.noDataDates.length > 0 && (
            <div className="notice att-kr-note">
              Nothing has come from the biometric device yet for {data.noDataDates.length === 1 ? fmtDay(data.noDataDates[0]) : `${data.noDataDates.length} days (${fmtDay(data.noDataDates[0])} → ${fmtDay(data.noDataDates[data.noDataDates.length - 1])})`}.
              {' '}Those days are shown as <b>No device data</b>, not Absent.
            </div>
          )}

          <div className="att-kr-cards">
            <div className={`att-kr-card tone-navy head${!pick.kpi ? ' on' : ''}`}>
              <button type="button" className="att-kr-main" onClick={() => setPick({ kpi: '', part: '' })} title="Everyone on the rolls in this period, with each person's status. Click to list them all.">
                <span className="v">{data.headcount}</span>
                <span className="l">Headcount</span>
                <span className="h">{data.single ? `${data.people} on the rolls — click to list all` : `${data.people} people × days — click to list all`}</span>
              </button>
            </div>
            {shownCards.map((k) => {
              const n = c[k.key] || 0;
              const on = pick.kpi === k.key;
              return (
                <div key={k.key} className={`att-kr-card tone-${k.tone}${on ? ' on' : ''}`}>
                  <button type="button" className="att-kr-main" onClick={() => choose(k.key)} title={`${hintOf(k, r)}. Click to see the list.`}>
                    <span className="v">{n}</span>
                    <span className="l">{k.label}</span>
                    <span className="h">{n ? hintOf(k, r) : 'Nobody'}</span>
                  </button>
                  {k.parts && n > 0 && (
                    <div className="att-kr-parts">
                      {k.parts.filter(([pk]) => (parts[k.key]?.[pk] || 0) > 0).map(([pk, pl]) => (
                        <button key={pk} type="button" className={`att-kr-part${on && pick.part === pk ? ' on' : ''}`} onClick={() => choose(k.key, pk)}>
                          {pl} <b>{parts[k.key][pk]}</b>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="att-kr-eq">
            {SUMMED.filter((k) => shownCards.some((x) => x.key === k)).map((k, i) => <span key={k}>{i ? ' + ' : ''}{NAME[k]} <b>{c[k] || 0}</b></span>)}
            {' '}= Headcount <b>{data.headcount}</b>{data.single ? '' : <> ({data.people} {data.people === 1 ? 'person' : 'people'} × the days they were on the rolls)</>}. Late <b>{c.late || 0}</b> is counted inside these.
            {data.workedOnOff ? <> <b>{data.workedOnOff}</b> worked on a week off / holiday (counted in Present etc., tagged in the list).</> : null}
          </div>

          <div className="att-kr-list">
            <div className="att-kr-list-head">
              <b>{listTitle}</b> <span className="small-muted">— {list.length} {list.length === 1 ? 'day' : 'days'}</span>
              {pick.kpi && <button type="button" className="btn btn-sm" onClick={() => setPick({ kpi: '', part: '' })}>Show all days</button>}
              <input type="search" placeholder="Search name, ID, department" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            </div>
            <ScrollTable maxHeight="60vh">
              <table>
                <thead>
                  <tr><th>Name</th><th>Employee ID</th><th>Department</th><th>Date</th><th>In</th><th>Out</th><th>Result</th><th>Why</th></tr>
                </thead>
                <tbody>
                  {page.slice.map((x) => (
                    <tr key={`${x.employeeId}|${x.date}`}>
                      <td><b>{x.name}</b></td>
                      <td>{x.employeeCode}</td>
                      <td className="cell-muted">{x.department || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(x.date)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t12(x.checkIn)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t12(x.checkOut)}</td>
                      <td><span className={`att-kr-pill tone-${CARDS.find((k) => k.key === x.kpi)?.tone || 'grey'}`}>{x.kpiLabel}{x.session ? ` · ${x.session === 'First half' ? '1st half' : '2nd half'}` : ''}</span>{x.lateDay && x.kpi !== 'present' ? <span className="att-kr-pill tone-orange">Late</span> : null}{x.workedOnOff ? <span className="att-kr-pill tone-blue" title={`Came in on a ${x.workedOnOff}`}>Worked on {x.workedOnOff.startsWith('holiday') ? 'holiday' : 'week off'}</span> : null}</td>
                      <td className="att-kr-why">{x.reason}</td>
                    </tr>
                  ))}
                  {list.length === 0 && (
                    <tr><td colSpan="8" className="att-kr-empty">{pick.kpi ? `No ${NAME[pick.kpi].toLowerCase()} days in this period.` : 'Nobody is on the rolls in this period.'}</td></tr>
                  )}
                </tbody>
              </table>
            </ScrollTable>
            {page.total > 0 && <Pager page={page} noun="days" />}
          </div>
        </>
      )}
    </div>
  );
}
