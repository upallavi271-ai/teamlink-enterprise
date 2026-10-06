import { useMemo, useState } from 'react';
import './Interviews.css';

// ---------------------------------------------------------------------------
// CALENDAR VIEW — Day / Week / Month (change list §11, 2026-10-03).
// A toggle on the Interviews screen (List stays the default). It draws the
// SAME rows the list shows — your area, your filters — so the two never
// disagree. Late feedback is red.
//
//   blue    booked, still to happen
//   orange  happened, feedback not in yet (within a day)
//   red     feedback is LATE (more than a day after the interview)
//   green   feedback in
//   grey    cancelled / did not attend
// ---------------------------------------------------------------------------
const DAY = 86400000;
const LIVE = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED', 'COMPLETED', 'PENDING_FEEDBACK'];
const DECIDED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];

// Feedback is late when the interview was more than a day ago and nothing
// was written (and nothing was decided).
export function isLateFeedback(r, now = Date.now()) {
  if (!r || !r.interviewAt || !LIVE.includes(r.status) || DECIDED.includes(r.stage)) return false;
  // Feedback written after this slot counts; round 1's feedback does not
  // close round 2 (one Internal record per application).
  if (r.internalFeedback && (!r.internalFeedback.updatedAt || new Date(r.internalFeedback.updatedAt) > new Date(r.interviewAt))) return false;
  return new Date(r.interviewAt).getTime() + DAY < now;
}
export function toneOf(r, now = Date.now()) {
  if (['CANCELLED', 'NO_SHOW'].includes(r.status)) return 'grey';
  if (r.status === 'FEEDBACK_SUBMITTED' || DECIDED.includes(r.stage)) return 'green';
  if (isLateFeedback(r, now)) return 'red';
  if (r.interviewAt && new Date(r.interviewAt).getTime() < now) return 'orange';
  return 'blue';
}

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const keyOf = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const mondayOf = (d) => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const clean = (n) => String(n || '').replace(/^ZZTEST\S*\s*/i, '');

// LAYOUT v3 (2026-10-03): coloured by DEPARTMENT. Pass colorOf(row) -> a CSS
// colour (the kit's fixed categorical palette) and legend [{ name, color }].
// The status still shows on top of the colour: a red "!" = feedback late,
// crossed out = cancelled / did not attend. Without colorOf the older status
// colours are used.
export default function InterviewCalendarGrid({ rows, onOpen, colorOf = null, legend = null }) {
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const today = startOfDay(new Date());
  const now = Date.now();

  const byDay = useMemo(() => {
    const m = new Map();
    (rows || []).forEach((r) => {
      if (!r.interviewAt) return;
      const k = keyOf(new Date(r.interviewAt));
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    m.forEach((list) => list.sort((a, b) => new Date(a.interviewAt) - new Date(b.interviewAt)));
    return m;
  }, [rows]);

  let days;
  let title;
  if (mode === 'day') {
    days = [anchor];
    title = anchor.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  } else if (mode === 'week') {
    const mon = mondayOf(anchor);
    days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    title = `${days[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${days[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
  } else {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = mondayOf(first);
    const weeks = Math.ceil((((first.getDay() + 6) % 7) + new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()) / 7);
    days = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
    title = anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }
  const step = (dir) => {
    if (mode === 'day') setAnchor(addDays(anchor, dir));
    else if (mode === 'week') setAnchor(addDays(anchor, 7 * dir));
    else setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
  };
  const inView = days.reduce((n, d) => n + (byDay.get(keyOf(d)) || []).length, 0);
  const max = mode === 'month' ? 3 : 8;

  return (
    <div className="ivx-cal">
      <div className="ivx-cal-bar">
        <div className="ivx-seg" role="tablist" aria-label="Calendar size">
          {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? 'is-on' : ''} onClick={() => setMode(id)}>{label}</button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" onClick={() => step(-1)} aria-label="Earlier">‹</button>
        <button type="button" className="btn btn-sm" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
        <button type="button" className="btn btn-sm" onClick={() => step(1)} aria-label="Later">›</button>
        <span className="ivx-cal-title">{title}</span>
        {inView === 0 && <span className="small-muted">No interviews in these days.</span>}
      </div>
      <div className={`ivx-cal-grid${mode === 'day' ? ' is-day' : ''}`}>
        {mode !== 'day' && WEEKDAYS.map((w) => <div key={w} className="ivx-cal-head">{w}</div>)}
        {days.map((d) => {
          const list = byDay.get(keyOf(d)) || [];
          const out = mode === 'month' && d.getMonth() !== anchor.getMonth();
          return (
            <div key={keyOf(d)} className={`ivx-cal-cell${out ? ' is-out' : ''}${sameDay(d, today) ? ' is-today' : ''}`}>
              <div className="ivx-cal-day">{mode === 'day' ? '' : d.getDate()}</div>
              {list.slice(0, max).map((r) => {
                const tone = toneOf(r, now);
                const dc = colorOf ? colorOf(r) : null;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={dc ? `ivx-cal-ev ivv3-ev${tone === 'red' ? ' is-late' : ''}${tone === 'grey' ? ' is-off' : ''}` : `ivx-cal-ev ${tone}`}
                    style={dc ? { '--dc': dc } : undefined}
                    title={`${time(r.interviewAt)} · ${r.candidate.name} · ${r.requirement.title}${r.round ? ` · Round ${r.round}` : ''}${panelNames(r) ? ` · With ${panelNames(r)}` : ''}${r.requirement.department ? ` · ${r.requirement.department}` : ''}${tone === 'red' ? ' · Feedback is late' : ''}`}
                    onClick={() => onOpen && onOpen(r)}
                  >
                    {dc && tone === 'red' && <b className="ivv3-late" aria-label="Feedback late">!</b>}{time(r.interviewAt)} {clean(r.candidate.name)}{mode === 'day' ? ` — ${r.requirement.title}${r.requirement.client ? ` (${r.requirement.client.name})` : ''}${r.round ? ` · Round ${r.round}` : ''}${panelNames(r) ? ` · With ${panelNames(r)}` : ''}${tone === 'red' ? ' · Feedback late' : ''}` : ''}
                  </button>
                );
              })}
              {list.length > max && <div className="ivx-cal-more">+{list.length - max} more</div>}
            </div>
          );
        })}
      </div>
      {legend ? (
        <div className="ivx-legend ivv3-legend" aria-label="Colours: department">
          {legend.map((l) => <span key={l.name} className="ivv3-sw" style={{ '--dc': l.color }}>{l.name}</span>)}
          <span className="ivv3-sw-late"><b className="ivv3-late">!</b>Feedback late</span>
          <span className="ivv3-sw-off">Cancelled / did not attend</span>
        </div>
      ) : (
        <div className="ivx-legend" aria-label="Colours">
          <span>Booked</span><span className="lg-orange">Waiting for feedback</span><span className="lg-red">Feedback late</span><span className="lg-green">Feedback in</span>
        </div>
      )}
    </div>
  );
}

// B4 (2026-10-06): the panel's names on the calendar (old rows: the one interviewer).
function panelNames(r) {
  return (r.panel && r.panel.length ? r.panel.map((p) => p.name).join(', ') : r.interviewer) || '';
}
