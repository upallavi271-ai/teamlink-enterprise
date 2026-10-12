// ---------------------------------------------------------------------------
// THE DAY REPORT'S SHARED PIECES — the date bar and the KPI block the
// Attendance Dashboard, the Biometric Attendance List and the Punch Log all
// draw, from the same server computation (routes/attendance.js dayReport()).
//
// Every KPI counts PEOPLE on the rolls that day, never punches or records:
// Present + Half Day + Absent + On Leave + Week-off / Holiday + No record +
// Not checked in yet = the day's headcount, and the block says so.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import ScrollTable from '../../components/ScrollTable.jsx';
import './attendance-day.css';
import './half-leave-chip.css';

// HALF DAY + THE LEAVE FOR THE OTHER HALF (user, 2026-10-09). state = Approved | Pending |
// Rejected | None (what the server sends as halfLeave); half = '1st half' | '2nd half'.
const HL_TEXT = { Approved: 'Approved', Pending: 'Pending approval', Rejected: 'Rejected', None: 'No leave applied' };
const HL_TONE = { Approved: 'green', Pending: 'orange', Rejected: 'red', None: 'red' };
export function HalfLeaveChip({ state, half, by }) {
  if (!state) return null;
  return (
    <span title={`Half day leave: ${HL_TEXT[state]}${half ? ` (${half})` : ''}${by ? ` - approved by ${by}` : ''}`}>
      <span className={`hl-chip tone-${HL_TONE[state]}`}>Half day leave: {HL_TEXT[state]}</span>
      {half ? <span className="hl-by">covers {half}</span> : null}
      {by ? <span className="hl-by">by {by}</span> : null}
    </span>
  );
}
// "1st half 1 · 2nd half 0 · Approved 1 · Pending 0 · Rejected 0 · No leave 0" for the Half day tile.
export function HalfLeaveSub({ c, short = false }) {
  if (!c) return null;
  return (
    <div className="hl-sub">
      Leave for 1st half <b>{c.firstHalf}</b> · 2nd half <b>{c.secondHalf}</b>
      {short ? null : <><br />Approved <b>{c.approved}</b> · Pending <b>{c.pending}</b>{c.rejected ? <> · Rejected <b>{c.rejected}</b></> : null} · No leave <b>{c.none}</b></>}
    </div>
  );
}

const pad = (n) => String(n).padStart(2, '0');
export const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return iso || '';
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WD[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
// "09:05:33" / "09:05" -> "9:05:33 AM" / "9:05 AM".
export function clock12(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return t || '—';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]}${m[3] ? `:${m[3]}` : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}

// One day: ◀ [date] ▶ · Today · Latest day with data.
export function DayBar({ value, onChange, latest, today = localToday(), children }) {
  return (
    <div className="att-day-bar">
      <button type="button" className="btn btn-sm" title="Previous day" aria-label="Previous day" onClick={() => onChange(addDays(value, -1))}>◀</button>
      <input type="date" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="Date" />
      <button type="button" className="btn btn-sm" title="Next day" aria-label="Next day" onClick={() => onChange(addDays(value, 1))}>▶</button>
      <span className="att-day-name">{fmtDay(value)}</span>
      {value !== today && <button type="button" className="btn btn-sm" onClick={() => onChange(today)}>Today</button>}
      {latest && latest !== value && (
        <button type="button" className="btn btn-sm" title="The latest day that has any punch or marked attendance" onClick={() => onChange(latest)}>
          Latest day with data ({latest})
        </button>
      )}
      {children}
    </div>
  );
}

// THE TILE SET (user, 2026-10-09), in order: Present · Absent · Half day · On leave ·
// Week off / Holiday. They add up to the headcount. Present = everyone who came to work, so
// Late · Early logout · Missing check-in · Missing check-out are small notes INSIDE Present.
export const BUCKETS = [
  { key: 'present', label: 'Present', hint: 'Came to work' },
  { key: 'absent', label: 'Absent', hint: 'No check-in, no leave or request' },
  { key: 'halfDay', label: 'Half day', hint: 'Worked one half, or marked' },
  { key: 'onLeave', label: 'On leave', hint: 'Leave (approved or pending) or told the manager' },
  { key: 'offDay', label: 'Week off / Holiday', hint: 'Sunday and company holidays' },
  { key: 'noRecord', label: 'No device data', hint: 'Nothing came from the device that day' },
  { key: 'notYet', label: 'Not checked in yet', hint: 'Today, no punch yet' },
  { key: 'upcoming', label: 'Upcoming', hint: 'A future date' },
];
export const BUCKET_LABEL = Object.fromEntries(BUCKETS.map((b) => [b.key, b.label]));

// The KPI block. `active` / `onPick` make the cards filters for a list below
// (click again to clear). `extra` = more info cells [{ key, value, label, hint }].
export function DayKpis({ kpis, date, headcount, active, onPick, extra = [], lateAfter = '' }) {
  if (!kpis) return null;
  const pick = (key) => onPick && onPick(active === key ? '' : key);
  // Buckets that can only be zero on this date are left out (Not checked in
  // yet is a today thing, Upcoming a future one) unless they hold someone.
  // The cards ADD UP TO THE HEADCOUNT, visibly (user, 2026-10-05): Week off /
  // Holiday is a small card again. Cards that can only be zero on this date are
  // left out (Not checked in yet is a today thing, Upcoming a future one).
  const shown = BUCKETS.filter((b) => !['notYet', 'upcoming', 'noRecord'].includes(b.key) || kpis[b.key] > 0);
  // The notes INSIDE Present (they are already counted in Present - never separate tiles).
  const notes = kpis.notes || {};
  const noteChips = [
    { key: 'late', label: `Late${lateAfter ? ` (after ${lateAfter})` : ''}`, value: notes.late || 0 },
    { key: 'earlyLogout', label: 'Early logout', value: notes.earlyLogout || 0 },
    { key: 'missingCheckIn', label: 'Missing check-in', value: notes.missingCheckIn || 0 },
    { key: 'missingCheckOut', label: 'Missing check-out', value: notes.missingCheckOut || 0 },
  ];
  // LATE COMING: of the people who came late, how many told why and were approved (an approved one is not a payroll late).
  const lateStates = kpis.lateStates || null;
  const lateChips = lateStates ? [
    { key: 'late:approved', label: 'Late: Approved', value: lateStates.approved, tone: 'green', title: 'Came late, told why, and a manager approved. Stays Present; not counted as a late arrival in payroll. Click to list them.' },
    { key: 'late:pending', label: 'Waiting for approval', value: lateStates.pending, tone: 'orange', title: 'Told why; the approver has not decided yet. Still counts as late. Click to list them.' },
    ...(lateStates.rejected ? [{ key: 'late:rejected', label: 'Rejected', value: lateStates.rejected, tone: 'red', title: 'The reason was not accepted. Counts as late. Click to list them.' }] : []),
    { key: 'late:none', label: 'Not explained', value: lateStates.none, tone: 'red', title: 'Came late and nobody was told why. Counts as late. Click to list them.' },
  ] : [];
  // The same notes on Half day and On leave (only the ones somebody has): a missing punch stays
  // visible when a leave is applied. key = 'halfDay:missingCheckOut'.
  const NOTE_WORDS = { late: 'Late', earlyLogout: 'Early logout', missingCheckIn: 'Missing check-in', missingCheckOut: 'Missing check-out', noPunches: 'No punches', punchOnLeave: 'Punch on a leave day', leaveRejected: 'Half-day leave rejected' };
  const tileChips = (tileKey) => Object.keys(NOTE_WORDS).filter((k) => ((kpis.tileNotes || {})[tileKey] || {})[k] > 0)
    .map((k) => ({ key: `${tileKey}:${k}`, label: NOTE_WORDS[k], value: kpis.tileNotes[tileKey][k] }));
  // Plain facts about the day (not statuses): who has a check-in / check-out on record.
  const info = [
    { key: 'checkedIn', value: kpis.checkedIn, label: 'Checked in', hint: 'People with a check-in' },
    { key: 'checkedOut', value: kpis.checkedOut, label: 'Checked out', hint: 'People who pressed check-out' },
    { key: 'punched', value: kpis.punched, label: 'People with punches', hint: `Biometric device: ${kpis.biometric}` },
    ...extra,
  ];
  return (
    <div>
      <div className="att-kpis">
        <button type="button" className={`att-kpi total${active === 'headcount' ? ' on' : ''}`} onClick={() => pick('headcount')} title="Everyone on the rolls on this date, with each person's status. Click to list them.">
          <div className="v">{kpis.headcount}</div>
          <div className="l">Headcount on {date}</div>
          <div className="h">Everyone on the rolls — click to list all</div>
        </button>
        {shown.map((b) => (
          <div key={b.key} className={`att-kpi-wrap${b.key === 'present' ? ' has-notes' : ''}`}>
            <button type="button" className={`att-kpi${active === b.key ? ' on' : ''}`} onClick={() => pick(b.key)} title={`${b.hint}. Click to list them.`}>
              <div className="v">{kpis[b.key]}</div>
              <div className="l">{b.label}</div>
              <div className="h">{b.hint}</div>
            </button>
            {b.key === 'halfDay' && kpis.halfDayLeave && <HalfLeaveSub c={kpis.halfDayLeave} />}
            {(b.key === 'halfDay' || b.key === 'onLeave' || b.key === 'absent') && tileChips(b.key).length > 0 && (
              <div className="att-kpi-notes" aria-label={`Notes inside ${b.label}`}>
                {tileChips(b.key).map((n) => (
                  <button key={n.key} type="button" className={`att-note${active === n.key ? ' on' : ''}`} onClick={() => pick(n.key)} title={`${n.label}: already counted in ${b.label}. Click to list them.`}>
                    {n.label} <b>{n.value}</b>
                  </button>
                ))}
              </div>
            )}
            {b.key === 'present' && (
              <div className="att-kpi-notes" aria-label="Notes inside Present">
                {noteChips.map((n) => (
                  <button key={n.key} type="button" className={`att-note${active === n.key ? ' on' : ''}`} onClick={() => pick(n.key)} title={`${n.label}: already counted in Present. Click to list them.`}>
                    {n.label} <b>{n.value}</b>
                  </button>
                ))}
              </div>
            )}
            {b.key === 'present' && lateStates && lateStates.late > 0 && (
              <div className="att-kpi-notes att-late-states" aria-label="Late coming: told why?">
                {lateChips.map((n) => (
                  <button key={n.key} type="button" className={`att-note att-late-${n.tone}${active === n.key ? ' on' : ''}`} onClick={() => pick(n.key)} title={n.title}>
                    {n.label} <b>{n.value}</b>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="att-eq">
        {shown.map((b, i) => <span key={b.key}>{i ? ' + ' : ''}{b.label} <b>{kpis[b.key]}</b></span>)}
        {' '}= Headcount <b>{kpis.headcount}</b>
        {shown.reduce((n, b) => n + (kpis[b.key] || 0), 0) === kpis.headcount ? '' : <> (these add up to <b>{shown.reduce((n, b) => n + (kpis[b.key] || 0), 0)}</b>)</>}.
        {' '}Late, Early logout, Missing check-in and Missing check-out are notes inside Present, not extra tiles.
        {headcount && (
          <> {' '}Of the <b>{headcount.records}</b> employee record(s) in your scope
            {headcount.systemAccounts ? <>, <b>{headcount.systemAccounts}</b> Super Admin (system account) is not counted</> : null}
            {headcount.inScope !== headcount.records - headcount.systemAccounts ? <>, <b>{headcount.inScope}</b> match the filters</> : null}
            , <b>{headcount.left}</b> had left before this date
            {headcount.notYetJoined ? <>, <b>{headcount.notYetJoined}</b> had not joined yet</> : null}
            {' '}— leaving <b>{headcount.onRolls}</b> on the rolls.
          </>
        )}
      </div>
      <div className="att-kpi-sep">About the day (information)</div>
      <div className="att-kpis info">
        {info.map((c) => (
          <button key={c.key} type="button" className={`att-kpi${active === c.key ? ' on' : ''}`} onClick={() => pick(c.key)} title={c.hint}>
            <div className="v">{c.value}</div>
            <div className="l">{c.label}</div>
            {c.hint && <div className="h">{c.hint}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

// Does a row (with bucket / status / late / punches / checkIn / checkOut) match a KPI key?
// Does a row match a KPI card? Day rows carry bucket / status / late /
// punchRows / checkIn / checkOut; the range's per-person rows carry day counts.
export function matchesKpi(row, key) {
  if (!key || key === 'headcount') return true;
  // 'pd:present' = a PERSON-DAY tile of the period (PersonDayTiles): the same test, on the day rows.
  if (String(key).startsWith('pd:')) return matchesKpi(row, String(key).slice(3));
  // 'halfDay:missingCheckOut' = a note on Half day / On leave (the person keeps the tile, the note says what HR can fix).
  // 'late:approved' = a late arrival whose late-coming request is approved / pending / rejected / none (not explained).
  if (String(key).startsWith('late:')) return !!row.late && row.lateState === String(key).slice(5);
  if (String(key).includes(':')) { const [t, n] = String(key).split(':'); return row.bucket === t && (row.notes || []).includes(n); }
  if (BUCKET_LABEL[key]) return row.bucket === key;
  // The four notes inside Present: only people who are Present carry them.
  if (key === 'late') return 'bucket' in row ? row.bucket === 'present' && !!row.late : !!row.late;
  if (key === 'earlyLogout') return row.bucket === 'present' && (row.dayStatus || row.status) === 'Early Logout';
  if (key === 'missingCheckIn') return row.bucket === 'present' && (row.dayStatus || row.status) === 'Missing Check-In';
  if (key === 'checkedIn') return 'checkIn' in row ? !!row.checkIn : !!(row.checkInTimes && row.checkInTimes.length);
  if (key === 'checkedOut') return 'checkOut' in row ? !!row.checkOut : !!(row.checkOutTimes && row.checkOutTimes.length);
  if (key === 'missingCheckOut') return row.bucket === 'present' && (row.dayStatus || row.status) === 'Missing Check-Out';
  if (key === 'punched') return (row.punchRows ?? row.punches ?? 0) > 0;
  // Range, per person.
  const any = { presentAny: 'present', halfDayAny: 'halfDay', absentAny: 'absent', onLeaveAny: 'onLeave', noRecordAny: 'noRecord', lateAny: 'late' }[key];
  if (any) return (row[any] || 0) > 0;
  if (key === 'presentAll') return row.workingDays > 0 && row.present === row.workingDays;
  return true;
}

// ---------------------------------------------------------------------------
// ONE DAY OR A RANGE: quick picks (Today, Yesterday, This week, This month,
// Latest day with data), ◀ ▶ (moves by the range's own length) and a custom
// From–To with Apply. onChange(from, to).
// ---------------------------------------------------------------------------
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) + 1;
export const MAX_RANGE_DAYS = 62;

export function RangeBar({ from, to, onChange, latest, today = localToday(), children }) {
  const [draft, setDraft] = useState({ from, to });
  const [err, setErr] = useState('');
  useEffect(() => { setDraft({ from, to }); setErr(''); }, [from, to]);
  const weekStart = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const monthStart = `${today.slice(0, 7)}-01`;
  const len = daysBetween(from, to);
  const picks = [
    { label: 'Today', f: today, t: today },
    { label: 'Yesterday', f: addDays(today, -1), t: addDays(today, -1) },
    { label: 'This week', f: weekStart, t: today },
    { label: 'This month', f: monthStart, t: today },
  ];
  function apply(e) {
    if (e) e.preventDefault();
    if (!draft.from || !draft.to) { setErr('Pick both dates.'); return; }
    if (draft.from > draft.to) { setErr('The From date is after the To date.'); return; }
    if (daysBetween(draft.from, draft.to) > MAX_RANGE_DAYS) { setErr(`Pick at most ${MAX_RANGE_DAYS} days — the Monthly Summary covers longer periods.`); return; }
    setErr('');
    onChange(draft.from, draft.to);
  }
  return (
    <div>
      <div className="att-day-bar">
        <button type="button" className="btn btn-sm" title={len === 1 ? 'Previous day' : `Previous ${len} days`} aria-label="Previous" onClick={() => onChange(addDays(from, -len), addDays(to, -len))}>◀</button>
        {picks.map((p) => (
          <button key={p.label} type="button" className={`btn btn-sm${from === p.f && to === p.t ? ' btn-primary' : ''}`} onClick={() => onChange(p.f, p.t)}>{p.label}</button>
        ))}
        {latest && (
          <button type="button" className={`btn btn-sm${from === latest && to === latest ? ' btn-primary' : ''}`} title="The latest day that has any punch or marked attendance" onClick={() => onChange(latest, latest)}>
            Latest day with data ({latest})
          </button>
        )}
        <button type="button" className="btn btn-sm" title={len === 1 ? 'Next day' : `Next ${len} days`} aria-label="Next" onClick={() => onChange(addDays(from, len), addDays(to, len))}>▶</button>
      </div>
      <form className="att-day-bar" onSubmit={apply}>
        <label className="small-muted" style={{ margin: 0 }}>Month</label>
        <input type="month" aria-label="Whole month" title="A whole calendar month: the same dates as Monthly Summary" value={from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') ? from.slice(0, 7) : ''}
          onChange={(e) => { const m = e.target.value; if (!m) return; const [y, mo] = m.split('-').map(Number); onChange(`${m}-01`, `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`); }} />
        <label className="small-muted" style={{ margin: 0 }}>From</label>
        <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} aria-label="From date" />
        <label className="small-muted" style={{ margin: 0 }}>To</label>
        <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-label="To date" />
        <button type="submit" className="btn btn-sm btn-primary">Apply</button>
        <span className="att-day-name">{from === to ? fmtDay(from) : `${fmtDay(from)} → ${fmtDay(to)} (${len} days)`}</span>
        {children}
      </form>
      {err && <div className="notice red">{err}</div>}
    </div>
  );
}

// A PERIOD IN PERSON-DAYS (user, 2026-10-10: the Biometric list and the Monthly Summary must show the same counts).
// These are the Monthly Summary's totals - one engine definition (attendanceDays.tallyPerson): Present (it INCLUDES late, early
// logout and missing check-in / check-out, which are notes inside it) + Absent + Half day + On leave + Week off / Holiday = days.
// Clicking a count lists exactly those person-days below. "Days with a punch" / "Punches received" are plain facts, not statuses.
export function PersonDayTiles({ tiles, equation, from, to, active, onPick, onOpenSummary }) {
  if (!tiles) return null;
  const pick = (key) => onPick && onPick(active === key ? '' : key);
  const T = tiles;
  const main = [
    { key: 'present', label: 'Present', value: T.present, hint: 'Came to work (includes late, early logout and missing punches)' },
    { key: 'absent', label: 'Absent', value: T.absent, hint: 'No check-in, no leave or request' },
    { key: 'halfDay', label: 'Half day', value: T.halfDay, hint: 'Worked one half, or half-day leave' },
    { key: 'onLeave', label: 'On leave', value: T.onLeave, hint: 'Leave (approved, waiting) or told the manager' },
    { key: 'offDay', label: 'Week off / Holiday', value: T.offDay, hint: 'Sunday and company holidays' },
    ...(T.noRecord ? [{ key: 'noRecord', label: 'No device data', value: T.noRecord, hint: 'Nothing came from the device that day' }] : []),
    ...(T.notYet ? [{ key: 'notYet', label: 'Not checked in yet', value: T.notYet, hint: 'Today, no punch yet' }] : []),
  ];
  const notes = [
    { key: 'late', label: 'Late', value: T.late },
    { key: 'earlyLogout', label: 'Early logout', value: T.earlyLogout },
    { key: 'missingCheckIn', label: 'Missing check-in', value: T.missingCheckIn },
    { key: 'missingCheckOut', label: 'Missing check-out', value: T.missingCheckOut },
  ];
  const ls = T.lateStates || {};
  return (
    <div className="att-pd" data-testid="person-day-tiles">
      <div className="att-kpi-sep" style={{ marginTop: 0 }}>Person-days {from} → {to} — the same counts as Monthly Summary</div>
      <div className="att-kpis">
        <div className="att-kpi total" title="Every person on the rolls, for every day of the period">
          <div className="v">{T.days}</div><div className="l">Person-days</div><div className="h">people × days on the rolls</div>
        </div>
        {main.map((b) => (
          <button key={b.key} type="button" className={`att-kpi${active === `pd:${b.key}` ? ' on' : ''}`} onClick={() => pick(`pd:${b.key}`)} title={`${b.hint}. Click to list these days.`}>
            <div className="v">{b.value}</div><div className="l">{b.label}</div><div className="h">{b.hint}</div>
          </button>
        ))}
      </div>
      <div className="att-eq" data-testid="pd-equation">{equation}. Working days = {T.workingDays} (every day except Week off / Holiday{T.upcoming ? ` and ${T.upcoming} coming days` : ''}).</div>
      <div className="att-kpi-notes" style={{ margin: '6px 0' }} aria-label="Notes inside Present">
        <span className="small-muted">Inside Present:</span>
        {notes.map((n) => (
          <button key={n.key} type="button" className={`att-note${active === `pd:${n.key}` ? ' on' : ''}`} onClick={() => pick(`pd:${n.key}`)} title={`${n.label}: already counted in Present. Click to list them.`}>{n.label} <b>{n.value}</b></button>
        ))}
        {ls.late > 0 && <span className="small-muted">Late: approved {ls.approved} · waiting {ls.pending}{ls.rejected ? ` · rejected ${ls.rejected}` : ''} · not explained {ls.none}</span>}
      </div>
      <div className="att-kpi-notes" style={{ margin: '0 0 6px' }} aria-label="Plain facts, not statuses">
        <span className="small-muted">Plain facts (not statuses):</span>
        <button type="button" className={`att-note${active === 'pd:punched' ? ' on' : ''}`} onClick={() => pick('pd:punched')} title="Days on which the person has at least one punch (device, web, mobile or import)">Days with a punch <b>{T.punchDays}</b></button>
        <span className="att-note" title="Every punch row received from the device / web / mobile / import in the period">Punches received <b>{T.punchRows}</b></span>
      </div>
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Counts match the Monthly Summary for the same dates and filters (same rule, same people).
        {onOpenSummary && <> <button type="button" className="link-btn" onClick={onOpenSummary}>Open Monthly Summary</button></>}
      </div>
    </div>
  );
}

// A RANGE in people: how many had at least one such day, and per-day averages.
export function RangeKpis({ summary, from, to, active, onPick }) {
  if (!summary) return null;
  const pick = (key) => onPick && onPick(active === key ? '' : key);
  const s = summary;
  const people = [
    { key: 'presentAny', value: s.presentAny, label: 'Present on ≥ 1 day', hint: 'People who came in on at least one day' },
    { key: 'presentAll', value: s.presentAll, label: 'Present every working day', hint: 'No absence, leave, half day or missing day' },
    { key: 'halfDayAny', value: s.halfDayAny, label: 'Half day on ≥ 1 day' },
    { key: 'absentAny', value: s.absentAny, label: 'Absent on ≥ 1 day' },
    { key: 'onLeaveAny', value: s.onLeaveAny, label: 'On leave on ≥ 1 day' },
    { key: 'noRecordAny', value: s.noRecordAny, label: 'No device data on ≥ 1 day', hint: 'Nothing came from the device that day' },
    { key: 'lateAny', value: s.lateAny, label: 'Late on ≥ 1 day' },
  ];
  const avg = [
    { value: s.avg.headcount, label: 'Headcount per day (avg)' },
    { value: s.avg.present, label: 'Present per day (avg)' },
    { value: s.avg.halfDay, label: 'Half day per day (avg)' },
    { value: s.avg.absent, label: 'Absent per day (avg)' },
    { value: s.avg.onLeave, label: 'On leave per day (avg)' },
    { value: s.avg.noRecord, label: 'No device data per day (avg)' },
    { value: s.avg.offDay, label: 'Week off / holiday per day (avg)' },
  ];
  return (
    <div>
      <div className="att-kpi-sep" style={{ marginTop: 6 }}>People — how many PEOPLE had at least one such day (not person-days)</div>
      <div className="att-kpis">
        <div className="att-kpi total" title="Everyone on the rolls on at least one day of the range">
          <div className="v">{s.people}</div>
          <div className="l">People on the rolls</div>
          <div className="h">{from} → {to} ({s.days} days)</div>
        </div>
        {people.map((c) => (
          <button key={c.key} type="button" className={`att-kpi${active === c.key ? ' on' : ''}`} onClick={() => pick(c.key)} title={`${c.hint || c.label}. Click to list them.`}>
            <div className="v">{c.value}</div>
            <div className="l">{c.label}</div>
            {c.hint && <div className="h">{c.hint}</div>}
          </button>
        ))}
      </div>
      <div className="att-eq">
        Each figure in this People row is a number of <b>people</b> (never more than the <b>{s.people}</b> on the rolls); the person-day counts are above. Below: the average per day over the
        {' '}<b>{s.days}</b> days. Each day&apos;s buckets add up to that day&apos;s headcount (see the date-wise table).
      </div>
      <div className="att-kpi-sep">Per-day averages</div>
      <div className="att-kpis info">
        {avg.map((c) => (
          <div key={c.label} className="att-kpi total">
            <div className="v">{c.value}</div>
            <div className="l">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// One line per date: the day's buckets, adding up to its headcount.
export function DateTotalsTable({ days, onPickDay }) {
  if (!days || days.length < 2) return null;
  const rows = [...days].reverse();
  const sum = (k) => days.reduce((n, d) => n + (d[k] || 0), 0);
  return (
    <ScrollTable maxHeight="45vh">
      <table>
        <thead>
          <tr>
            <th>Date</th><th>Headcount</th><th>Present</th><th>Late</th><th>Half Day</th><th>Absent</th><th>On Leave</th>
            <th>Week off / Holiday</th><th>No device data</th><th>Not checked in yet</th><th>Checked in</th><th>Checked out</th><th>Missing check-out</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.date}>
              <td style={{ whiteSpace: 'nowrap' }}>
                {onPickDay ? <button type="button" className="link-btn" onClick={() => onPickDay(d.date)} title="Open this day">{fmtDay(d.date)}</button> : <b>{fmtDay(d.date)}</b>}
              </td>
              <td className="att-num">{d.headcount}</td>
              <td className="att-num"><b>{d.present}</b></td>
              <td className="att-num">{d.late}</td>
              <td className="att-num">{d.halfDay}</td>
              <td className="att-num">{d.absent}</td>
              <td className="att-num">{d.onLeave}</td>
              <td className="att-num">{d.offDay}</td>
              <td className="att-num">{d.noRecord}</td>
              <td className="att-num">{d.notYet}</td>
              <td className="att-num">{d.checkedIn}</td>
              <td className="att-num">{d.checkedOut}</td>
              <td className="att-num">{d.missingCheckOut}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Person-days ({days.length} days)</td>
            {['headcount', 'present', 'late', 'halfDay', 'absent', 'onLeave', 'offDay', 'noRecord', 'notYet', 'checkedIn', 'checkedOut', 'missingCheckOut']
              .map((k) => <td key={k} className="att-num">{sum(k)}</td>)}
          </tr>
        </tfoot>
      </table>
    </ScrollTable>
  );
}

// ScrollTable (top + bottom horizontal scrollbars, sticky header) lives in
// components/ScrollTable.jsx now; re-exported here so the attendance screens
// import it exactly as before.
export { ScrollTable };
