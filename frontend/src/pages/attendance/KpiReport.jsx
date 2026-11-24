// ---------------------------------------------------------------------------
// THE ATTENDANCE REPORT (user, 2026-10-05) — HRMS → Attendance → Dashboard.
//
// TILES (user, 2026-10-09): Present · Absent · Half day (1st / 2nd half) · On leave ·
// Week off / Holiday - they always add up to the Headcount. PRESENT is everyone who
// came to work, so Late · Early logout · Missing check-in · Missing check-out are only
// small clickable notes inside the Present tile (never tiles of their own).
// Each tile opens its list
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
import { SourceChips, SourceFilter, PunchToggle, PunchDetails } from '../../components/PunchSourceChip.jsx';
import { fmtDay, clock12, localToday, addDays, HalfLeaveChip, HalfLeaveSub } from './DayReport.jsx';
import { BiometricList, PunchLogList } from './DashboardLists.jsx'; // the biometric list and the punch log, on this same Dashboard
// Total working time as text: "6h 47m" / "35 min" (the same wording as the punch log's time away).
const workText = (m) => (m == null ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`);
import '../../components/ExportMenu.css';
import './kpi-report.css';

const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const weekStart = (d) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
function rangeOf(mode, anchor, custom) {
  if (mode === 'range') return { from: custom.from, to: custom.to < custom.from ? custom.from : custom.to };
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
  if (mode === 'week' || mode === 'range') return from === to ? fmtDay(from) : `${fmtDay(from)} → ${fmtDay(to)}`;
  return fmtDay(from);
}

// ONE Export button for everything this screen can hand out. Each file follows the dates and filters picked above.
function ExportDrop({ busy, disabled, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="xm xm-right" ref={ref}>
      <button type="button" className="btn btn-primary btn-sm" aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy} onClick={() => setOpen((o) => !o)}>
        {busy ? 'Making file…' : 'Export'} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <span className="xm-menu" role="menu">
          {items.map((it) => (it.heading
            ? <span key={it.heading} className="xm-note" style={{ fontWeight: 600 }}>{it.heading}</span>
            : <button key={it.label + it.key} type="button" role="menuitem" className="xm-item" onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>))}
        </span>
      )}
    </span>
  );
}

// The tiles, in the user's order. tone = the four colours of the simple-UX
// rule (green done · blue going on · orange waiting · red problem).
const CARDS = [
  { key: 'present', label: 'Present', tone: 'green', hint: 'Came to work' },
  { key: 'absent', label: 'Absent', tone: 'red', hint: 'No check-in, did not inform' },
  { key: 'halfDay', label: 'Half day', tone: 'red', hint: 'Worked one half', parts: [['first', 'Worked 1st half'], ['second', 'Worked 2nd half'], ['marked', 'Marked by HR']] },
  { key: 'onLeave', label: 'On leave', tone: 'green', hint: 'Leave or told the manager', parts: [['approved', 'Approved'], ['pending', 'Pending'], ['informed', 'Informed']] },
  { key: 'offDay', label: 'Week off / Holiday', tone: 'grey', hint: 'Sunday and company holidays' },
  { key: 'notYet', label: 'Not in yet', tone: 'blue', hint: 'Today, no punch yet', onlyIfAny: true },
  { key: 'noData', label: 'No device data', tone: 'grey', hint: 'Device has not sent these days', onlyIfAny: true },
];
// The small notes INSIDE the Present tile (not tiles, not in the equation).
const NOTES = [
  { key: 'late', label: 'Late', hintOf: (r) => `Came after ${r.late}` },
  { key: 'earlyLogout', label: 'Early logout', hintOf: (r) => `Left ${r.early} – ${r.end}` },
  { key: 'missingCheckIn', label: 'Missing check-in', hintOf: () => 'Check-out only — HR to fix' },
  { key: 'missingCheckOut', label: 'Missing check-out', hintOf: () => 'Check-in only — HR to fix' },
];
const LEAVE_NAME = { Approved: 'Approved', Pending: 'Pending approval', Rejected: 'Rejected', None: 'No leave applied' };
const NAME = Object.fromEntries(CARDS.map((c) => [c.key, c.label]));
const NOTE_NAME = { ...Object.fromEntries(NOTES.map((c) => [c.key, c.label])), noPunches: 'No punches', punchOnLeave: 'Punch on a leave day', leaveRejected: 'Half-day leave rejected' };
// The tiles that add up to the HEADCOUNT.
const SUMMED = CARDS.map((c) => c.key);
const hintOf = (k, r) => (r && k.hintOf ? k.hintOf(r) : k.hint);
const t12 = (t) => (t ? clock12(String(t).slice(0, 5)) : '—');

// `preset` = { from, to, q, tile, n }: the Monthly summary opened this period / person / count here (n changes each time).
// `onOpenSummary` draws the calendar button that opens the Monthly summary.
export default function KpiReport({ onRangeChange, preset = null, onOpenSummary = null } = {}) {
  const [mode, setMode] = useState('day');
  const [anchor, setAnchor] = useState(localToday());
  const [custom, setCustom] = useState({ from: localToday(), to: localToday() });
  const [dept, setDept] = useState('');
  const [emp, setEmp] = useState('');
  const [pick, setPick] = useState({ kpi: '', part: '', note: '', leave: '' });
  const [how, setHow] = useState('');
  const [src, setSrc] = useState(''); // Source filter: '' | web | biometric | pulse | hr
  const [openRow, setOpenRow] = useState(null);
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const { from, to } = rangeOf(mode, anchor, custom);
  const seq = useRef(0);

  // Opened from the Monthly summary: take its dates, the person and the count, and drop the other filters.
  const presetN = preset ? preset.n : 0;
  useEffect(() => {
    if (!preset) return;
    setMode('range');
    setCustom({ from: preset.from, to: preset.to });
    setDept(''); setEmp(''); setHow(''); setSrc('');
    setQ(preset.q || '');
    setPick({ kpi: preset.tile || '', part: '', note: '', leave: '' });
  }, [presetN]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const mine = ++seq.current;
    setError('');
    const params = { from, to, ...(dept ? { department: dept } : {}), ...(emp ? { employeeId: emp } : {}), ...(how ? { how } : {}), ...(src ? { punchSource: src } : {}) };
    api.get('/attendance/kpi-report', { params })
      .then((res) => { if (mine === seq.current) setData(res.data); })
      .catch((e) => { if (mine === seq.current) setError(e.response?.data?.error || 'Could not load the attendance report. Please try again.'); });
  }, [from, to, dept, emp, how, src]);

  // The page around the report (daily marking, regularizations) follows its period.
  useEffect(() => { if (onRangeChange) onRangeChange(from, to); }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  // Picking a department that does not have the chosen person clears the person.
  useEffect(() => {
    if (emp && data && !(data.facets?.employeeId || []).some((o) => o.value === emp)) setEmp('');
    if (how && data && !(data.facets?.how || []).some((o) => o.value === how)) setHow('');
  }, [data, emp, how]);

  const rowsAll = (data && data.rows) || [];
  const match = (x) => {
    if (!pick.kpi) return true;
    if (x.tile !== pick.kpi) return false;
    if (pick.note) return (x.notes || []).includes(pick.note);
    if (pick.kpi === 'halfDay' && pick.leave) return x.halfLeave === pick.leave;
    if (pick.kpi === 'halfDay' && pick.part) return pick.part === 'first' ? x.session === 'First half' : pick.part === 'second' ? x.session === 'Second half' : !x.session;
    if (pick.kpi === 'onLeave' && pick.part) return x.leaveKind === pick.part;
    return true;
  };
  const s = q.trim().toLowerCase();
  const list = rowsAll.filter((x) => match(x) && (!s || `${x.name} ${x.employeeCode} ${x.department}`.toLowerCase().includes(s)));
  const page = usePaged(list, 50);

  // Typing a From or To date opens exactly that period (the From – To choice), whatever Day / Week / Month was on.
  const pickDates = (f, t) => { setCustom({ from: f, to: t < f ? f : t }); setMode('range'); setPick(noPick); };
  const choose = (kpi, part = '', note = '', leave = '') => setPick((cur) => (cur.kpi === kpi && cur.part === part && cur.note === note && cur.leave === leave ? noPick : { kpi, part, note, leave }));
  const noPick = { kpi: '', part: '', note: '', leave: '' };

  async function exportExcel() {
    setBusy(true); setSaved('');
    try {
      const params = { from, to, ...(dept ? { department: dept } : {}), ...(emp ? { employeeId: emp } : {}), ...(how ? { how } : {}), ...(pick.kpi ? { tile: pick.kpi, ...(pick.note ? { note: pick.note } : {}), ...(pick.leave ? { leave: pick.leave } : {}), part: pick.part } : {}), format: 'xlsx' };
      const tagName = pick.kpi ? (pick.note ? NOTE_NAME[pick.note] : NAME[pick.kpi]) : '';
      const name = `attendance-${tagName ? `${tagName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-` : ''}${from === to ? from : `${from}_to_${to}`}.xlsx`;
      await downloadFrom('/attendance/kpi-report', params, name);
      setSaved(`Saved ${name}`);
    } catch { setError('Could not make the Excel file. Please try again.'); } finally { setBusy(false); }
  }

  // The other files this screen hands out. All follow the same dates, department, employee and source as the report.
  async function exportFile(url, params, name) {
    setBusy(true); setSaved('');
    try { await downloadFrom(url, params, name); setSaved(`Saved ${name}`); } catch { setError('Could not make the file. Please try again.'); } finally { setBusy(false); }
  }
  const span = from === to ? from : `${from}_to_${to}`;
  const base = { ...(dept ? { department: dept } : {}), ...(emp ? { employeeId: emp } : {}), ...(src ? { punchSource: src } : {}) };
  // The date-wise report finds a person by name / code, so hand it the code of the employee picked above.
  const empCode = () => { const o = (data?.facets?.employeeId || []).find((x) => x.value === emp); const m = o && /\(([^()]+)\)\s*$/.exec(o.label); return m ? m[1] : ''; };
  const dateWise = (format) => exportFile('/attendance/biometric', { ...(from === to ? { date: from } : { from, to }), ...(dept ? { department: dept } : {}), ...(emp ? { q: empCode() } : {}), ...(src ? { punchSource: src } : {}), format }, `first-check-in-last-check-out-${span}.${format}`);
  const punchLog = (format) => exportFile('/attendance/punch-log', { from, to, ...base, format }, `punch-log-${span}.${format}`);
  const exportItems = [
    { heading: 'Attendance report' },
    { key: 'r', label: 'Excel (.xlsx)', run: exportExcel },
    { heading: 'Date-wise report (first in, last out)' },
    { key: 'd1', label: 'Excel (.xlsx)', run: () => dateWise('xlsx') },
    { key: 'd2', label: 'CSV (.csv)', run: () => dateWise('csv') },
    { heading: 'Punch log' },
    { key: 'p1', label: 'Excel (.xlsx)', run: () => punchLog('xlsx') },
    { key: 'p2', label: 'CSV (.csv)', run: () => punchLog('csv') },
  ];

  const c = data ? data.cards : {};
  const parts = data ? data.parts : {};
  const tiles = data ? (data.tiles || {}) : {};
  const notes = data ? (data.notes || {}) : {};
  const tileNotes = data ? (data.tileNotes || {}) : {};
  // Small notes on Half day / On leave too (a missing punch stays visible when a leave is applied) - only the ones somebody has.
  const tileNoteChips = (tk) => Object.keys(NOTE_NAME).filter((nk) => ((tileNotes[tk] || {})[nk] || 0) > 0).map((nk) => [nk, tileNotes[tk][nk]]);
  const shownCards = CARDS.filter((k) => !k.onlyIfAny || (tiles[k.key] || 0) > 0);
  const listTitle = pick.kpi
    ? `${NAME[pick.kpi]}${pick.note ? ` — ${NOTE_NAME[pick.note]}` : ''}${pick.leave ? ` — half day leave: ${LEAVE_NAME[pick.leave]}` : ''}${pick.part ? ` — ${(CARDS.find((k) => k.key === pick.kpi).parts || []).find(([v]) => v === pick.part)?.[1] || ''}` : ''}`
    : 'Everyone (headcount)';
  const r = data && data.rule;

  return (
    <div className="att-kr">
      <div className="att-kr-head">
        <h3>Attendance report</h3>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onOpenSummary && (
            <button type="button" className="btn btn-sm" onClick={onOpenSummary} title="Monthly summary: the month at a glance, person by person" aria-label="Open the monthly summary">
              <span aria-hidden="true">📅</span> Monthly summary
            </button>
          )}
          <ExportDrop busy={busy} disabled={!data} items={exportItems} />
        </span>
      </div>
      {saved && <div className="att-kr-saved">{saved}</div>}

      <div className="att-kr-bar">
        <div className="att-kr-seg" role="group" aria-label="Period">
          {[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['range', 'From – To']].map(([k, l]) => (
            <button key={k} type="button" className={`btn btn-sm${mode === k ? ' btn-primary' : ''}`} onClick={() => { if (k === 'range') setCustom({ from, to }); setMode(k); setPick(noPick); }}>{l}</button>
          ))}
        </div>
        {mode !== 'range' && (
          <div className="att-kr-nav">
            <button type="button" className="btn btn-sm" aria-label="Previous" onClick={() => setAnchor(step(mode, anchor, -1))}>◀</button>
            {mode === 'month'
              ? <input type="month" value={anchor.slice(0, 7)} onChange={(e) => e.target.value && setAnchor(`${e.target.value}-01`)} aria-label="Month" />
              : <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} aria-label="Date" />}
            <button type="button" className="btn btn-sm" aria-label="Next" onClick={() => setAnchor(step(mode, anchor, 1))}>▶</button>
            {anchor !== localToday() && <button type="button" className="btn btn-sm" onClick={() => setAnchor(localToday())}>Today</button>}
          </div>
        )}
        {/* FROM – TO IS ALWAYS ON SCREEN (founder 2026-11-17): the two dates show the period being looked at; changing either one opens that exact period. */}
        <div className="att-kr-nav att-kr-fromto">
          <label className="small-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>From
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && pickDates(e.target.value, to)} aria-label="From date" />
          </label>
          <label className="small-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>To
            <input type="date" value={to} min={from} onChange={(e) => e.target.value && pickDates(from, e.target.value)} aria-label="To date" />
          </label>
        </div>
        <span className="att-kr-range">{rangeLabel(mode, from, to)}</span>
      </div>

      <div className="att-kr-filters">
        <FacetSelect label="Department" allLabel="All departments" value={dept} onChange={(v) => { setDept(v); setPick(noPick); }} options={data?.facets?.department || []} loading={!data} />
        <FacetSelect label="Employee" allLabel="Everyone" value={emp} onChange={(v) => { setEmp(v); setPick(noPick); }} options={data?.facets?.employeeId || []} loading={!data} />
        <FacetSelect label="Check-in method" allLabel="Any method" value={how} onChange={(v) => { setHow(v); setPick(noPick); }} options={data?.facets?.how || []} loading={!data} />
        {(dept || emp || how || src) && <button type="button" className="btn btn-sm att-kr-clear" onClick={() => { setDept(''); setEmp(''); setHow(''); setSrc(''); }}>Clear filters</button>}
      </div>

      <SourceFilter value={src} onChange={(v) => { setSrc(v); setPick(noPick); }} totals={data?.facets?.punchSource} />
      {/* ONE DASHBOARD (founder 2026-11-17): three lists below follow this one filter bar - one click to jump to each. */}
      <div className="att-kr-jump" aria-label="Lists on this dashboard">
        <span className="small-muted">On this page:</span>
        {[['att-kr-days', 'Day-by-day status'], ['att-biometric', 'Biometric list'], ['att-punchlog', 'Punch log']].map(([id, label]) => (
          <button key={id} type="button" className="att-kr-part" onClick={() => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{label}</button>
        ))}
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
              <button type="button" className="att-kr-main" onClick={() => setPick(noPick)} title="Everyone on the rolls in this period, with each person's status. Click to list them all.">
                <span className="v">{data.headcount}</span>
                <span className="l">Headcount</span>
                <span className="h">{data.single ? `${data.people} on the rolls — click to list all` : `${data.people} people × days — click to list all`}</span>
              </button>
            </div>
            {shownCards.map((k) => {
              const n = tiles[k.key] || 0;
              const on = pick.kpi === k.key;
              return (
                <div key={k.key} className={`att-kr-card tone-${k.tone}${on ? ' on' : ''}`}>
                  <button type="button" className="att-kr-main" onClick={() => choose(k.key)} title={`${hintOf(k, r)}. Click to see the list.`}>
                    <span className="v">{n}</span>
                    <span className="l">{k.label}</span>
                    <span className="h">{n ? hintOf(k, r) : 'Nobody'}</span>
                  </button>
                  {k.key === 'present' && (
                    <div className="att-kr-parts" aria-label="Notes inside Present">
                      {NOTES.map((nt) => (
                        <button key={nt.key} type="button" title={r ? nt.hintOf(r) : ''} className={`att-kr-part${on && pick.note === nt.key ? ' on' : ''}`} onClick={() => choose('present', '', nt.key)}>
                          {nt.label}{nt.key === 'late' && r ? ` (after ${r.late})` : ''} <b>{notes[nt.key] || 0}</b>
                        </button>
                      ))}
                    </div>
                  )}
                  {(k.key === 'halfDay' || k.key === 'onLeave' || k.key === 'absent') && tileNoteChips(k.key).length > 0 && (
                    <div className="att-kr-parts" aria-label={`Notes inside ${k.label}`}>
                      {tileNoteChips(k.key).map(([nk, nn]) => (
                        <button key={nk} type="button" className={`att-kr-part${on && pick.note === nk ? ' on' : ''}`} onClick={() => choose(k.key, '', nk)}>
                          {NOTE_NAME[nk]} <b>{nn}</b>
                        </button>
                      ))}
                    </div>
                  )}
                  {k.key === 'halfDay' && n > 0 && <HalfLeaveSub c={parts.halfDayLeave} short />}
                  {k.key === 'halfDay' && n > 0 && parts.halfDayLeave && (
                    <div className="att-kr-parts" aria-label="Half day leave">
                      {[['Approved', 'approved'], ['Pending', 'pending'], ['None', 'none']].concat(parts.halfDayLeave.rejected ? [['Rejected', 'rejected']] : []).map(([st, ck]) => (
                        <button key={st} type="button" className={`att-kr-part${on && pick.leave === st ? ' on' : ''}`} onClick={() => choose('halfDay', '', '', st)}>
                          Leave: {LEAVE_NAME[st]} <b>{parts.halfDayLeave[ck]}</b>
                        </button>
                      ))}
                    </div>
                  )}
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
            {SUMMED.filter((k) => shownCards.some((x) => x.key === k)).map((k, i) => <span key={k}>{i ? ' + ' : ''}{NAME[k]} <b>{tiles[k] || 0}</b></span>)}
            {' '}= Headcount <b>{data.headcount}</b>{data.single ? '' : <> ({data.people} {data.people === 1 ? 'person' : 'people'} × the days they were on the rolls)</>}. Late, Early logout, Missing check-in and Missing check-out are notes inside Present, not extra tiles.
            {data.workedOnOff ? <> <b>{data.workedOnOff}</b> worked on a week off / holiday (counted in Present etc., tagged in the list).</> : null}
          </div>

          <div className="att-kr-list" id="att-kr-days">
            <div className="att-kr-list-head">
              <b>{listTitle}</b> <span className="small-muted">— {list.length} {list.length === 1 ? 'day' : 'days'}</span>
              {pick.kpi && <button type="button" className="btn btn-sm" onClick={() => setPick(noPick)}>Show all days</button>}
              <input type="search" placeholder="Search name, ID, department" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            </div>
            <ScrollTable maxHeight="60vh">
              <table>
                <thead>
                  <tr><th>Name</th><th>Employee ID</th><th>Department</th><th>Date</th><th>In</th><th>Out</th><th title="First check-in to last check-out, minus the breaks in between">Total working time</th><th>Check-in method</th><th>Punches by source</th><th>Result</th><th>Why</th></tr>
                </thead>
                <tbody>
                  {page.slice.map((x) => [(
                    <tr key={`${x.employeeId}|${x.date}`}>
                      <td><b>{x.name}</b></td>
                      <td>{x.employeeCode}</td>
                      <td className="cell-muted">{x.department || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDay(x.date)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t12(x.checkIn)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t12(x.checkOut)}</td>
                      <td style={{ whiteSpace: 'nowrap' }} title={x.workedMinutes != null ? `First in to last out ${workText(x.spanMinutes)}${x.breakMinutes > 0 ? `, minus breaks ${workText(x.breakMinutes)}` : ''}` : 'Needs both a check-in and a check-out'}>{x.workedMinutes != null ? <b>{workText(x.workedMinutes)}</b> : '—'}{x.breakMinutes > 0 && <div className="small-muted" style={{ fontSize: 11 }}>break {workText(x.breakMinutes)}</div>}</td>
                      <td className="cell-muted">{x.howText || x.how || '—'}</td>
                      <td><SourceChips counts={x.sourceCounts} />{(x.punchList || []).length > 0 && <div><PunchToggle open={openRow === `${x.employeeId}|${x.date}`} count={x.punchList.length} onClick={() => setOpenRow(openRow === `${x.employeeId}|${x.date}` ? null : `${x.employeeId}|${x.date}`)} /></div>}</td>
                      <td><span className={`att-kr-pill tone-${CARDS.find((k) => k.key === x.tile)?.tone || 'grey'}`}>{NAME[x.tile] || x.kpiLabel}{x.session ? ` · ${x.session === 'First half' ? '1st half' : '2nd half'}` : ''}</span>{(x.notes || []).map((nk) => <span key={nk} className="att-kr-pill tone-orange">{NOTE_NAME[nk]}</span>)}{x.halfLeave ? <HalfLeaveChip state={x.halfLeave} half={x.halfLeaveHalf} by={x.halfLeaveBy} /> : null}{x.latePermissionText ? <span className={`att-kr-pill tone-${x.lateExcused ? 'green' : 'orange'}`}>{x.latePermissionText}</span> : null}{x.awlText ? <span className="att-kr-pill tone-red" title="No leave applied: payroll counts extra loss of pay">{x.awlText}</span> : null}{x.workedOnOff ? <span className="att-kr-pill tone-blue" title={`Came in on a ${x.workedOnOff}`}>Worked on {x.workedOnOff.startsWith('holiday') ? 'holiday' : 'week off'}</span> : null}</td>
                      <td className="att-kr-why">{x.reason}</td>
                    </tr>
                  ), openRow === `${x.employeeId}|${x.date}` && <tr key={`${x.employeeId}|${x.date}|d`}><td colSpan="11"><PunchDetails list={x.punchList} /></td></tr>])}
                  {list.length === 0 && (
                    <tr><td colSpan="11" className="att-kr-empty">{pick.kpi ? `No ${(pick.note ? NOTE_NAME[pick.note] : NAME[pick.kpi]).toLowerCase()} days in this period.` : 'Nobody is on the rolls in this period.'}</td></tr>
                  )}
                </tbody>
              </table>
            </ScrollTable>
            {page.total > 0 && <Pager page={page} noun="days" />}
          </div>
        </>
      )}

      {/* The biometric list and the punch log: same period, department, employee, method and source as everything above. */}
      <BiometricList from={from} to={to} dept={dept} emp={emp} empCode={emp ? empCode() : ''} how={how} src={src} />
      <PunchLogList from={from} to={to} dept={dept} emp={emp} how={how} src={src} />
    </div>
  );
}
