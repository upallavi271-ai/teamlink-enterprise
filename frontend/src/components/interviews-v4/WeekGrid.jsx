import { useMemo } from 'react';
import { Icon } from '../atskit/AtsKit.jsx';
import {
  WEEKDAYS, dayKey, sameDay, startOfDay, groupByDay, viewRange, fmtHour, fmtClock,
  statusTone, isLateFeedback, cleanName, panelNames, STATUS_LEGEND,
} from './calUtils.js';

// ---------------------------------------------------------------------------
// The centre of the redesigned Interview Calendar: a Day / Week / Month grid
// of the SAME interview rows the list shows (your area, your filters). Pure
// presentation — the rows come from GET /ats/calendar via the page.
//   Day / Week: one row per hour (only the hours that hold interviews, at
//               least 9 AM – 5 PM); a busy hour shows the first few cards and
//               "+N more" (opens that day / that day's list) so a large area
//               never draws thousands of cards.
//   Month:      a day box with the first three, "+N more" opens the day.
// ---------------------------------------------------------------------------
function EventCard({ r, compact, selected, onSelect, now }) {
  const tone = statusTone(r, now);
  const late = isLateFeedback(r, now);
  const job = r.requirement?.title || '';
  const tip = [
    fmtClock(r.interviewAt), cleanName(r.candidate?.name), job, r.interviewCode,
    r.requirement?.client?.name, r.round ? `Round ${r.round}` : '', panelNames(r) ? `With ${panelNames(r)}` : '',
    r.statusLabel, late ? 'Feedback late' : '',
  ].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className={`iv4-ev iv4-tone-${tone}${selected ? ' is-sel' : ''}${late ? ' is-late' : ''}${compact ? ' is-compact' : ''}`}
      title={tip}
      onClick={() => onSelect(r)}
      aria-pressed={selected}
    >
      {compact ? (
        <span className="iv4-ev-line"><b>{fmtClock(r.interviewAt).replace(/^0/, '')}</b> {cleanName(r.candidate?.name)}</span>
      ) : (
        <>
          <span className="iv4-ev-name">{late && <i className="iv4-late" aria-label="Feedback late">!</i>}{cleanName(r.candidate?.name)}</span>
          <span className="iv4-ev-job">{job}{r.interviewCode ? ` · ${r.interviewCode}` : ''}</span>
          <span className="iv4-ev-st">{r.statusLabel || r.status}</span>
        </>
      )}
    </button>
  );
}

export default function WeekGrid({
  rows, mode, anchor, onStep, onToday, onPickDay, onMore, selectedId, onSelect, loaded = true, extra = null,
}) {
  const now = Date.now();
  const today = startOfDay(new Date());
  const { days, title } = viewRange(mode, anchor);
  const byDay = useMemo(() => groupByDay(rows), [rows]);
  const inView = days.reduce((n, d) => n + (byDay.get(dayKey(d)) || []).length, 0);

  // Hours shown: 9 AM – 5 PM, widened to every hour that holds an interview.
  const hours = useMemo(() => {
    if (mode === 'month') return [];
    let lo = 9;
    let hi = 17;
    days.forEach((d) => (byDay.get(dayKey(d)) || []).forEach((r) => {
      const h = new Date(r.interviewAt).getHours();
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }));
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [mode, byDay, anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  const cap = mode === 'day' ? 8 : 2;
  const nav = (
    <div className="iv4-grid-nav">
      <button type="button" className="iv4-btn" onClick={onToday}><Icon name="calendar" size={14} /> Today</button>
      <button type="button" className="iv4-btn iv4-ico" onClick={() => onStep(-1)} aria-label="Earlier">‹</button>
      <button type="button" className="iv4-btn iv4-ico" onClick={() => onStep(1)} aria-label="Later">›</button>
    </div>
  );

  return (
    <section className="ak-panel iv4-gridcard" aria-label="Interview calendar">
      <header className="iv4-grid-head">
        <h3>{title}</h3>
        <span className="iv4-grid-count">
          {!loaded ? 'Loading…' : inView ? `${inView.toLocaleString('en-IN')} interview${inView === 1 ? '' : 's'}` : 'No interviews in these days'}
        </span>
        {extra}
        {nav}
      </header>

      {mode === 'month' ? (
        <div className="iv4-month">
          {WEEKDAYS.map((w) => <div key={w} className="iv4-mhead">{w}</div>)}
          {days.map((d) => {
            const list = byDay.get(dayKey(d)) || [];
            const out = d.getMonth() !== anchor.getMonth();
            return (
              <div key={dayKey(d)} className={`iv4-mcell${out ? ' is-out' : ''}${sameDay(d, today) ? ' is-today' : ''}`}>
                <button type="button" className="iv4-mday" onClick={() => onPickDay(d)} title="Open this day">{d.getDate()}</button>
                {list.slice(0, 3).map((r) => (
                  <EventCard key={r.id} r={r} compact selected={r.id === selectedId} onSelect={onSelect} now={now} />
                ))}
                {list.length > 3 && <button type="button" className="iv4-more" onClick={() => onPickDay(d)}>{`+${list.length - 3} more`}</button>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="iv4-tgrid-wrap">
          <div className={`iv4-tgrid${mode === 'day' ? ' is-day' : ''}`} style={{ '--cols': days.length }}>
            <div className="iv4-thead iv4-corner" />
            {days.map((d) => (
              <div key={dayKey(d)} className={`iv4-thead${sameDay(d, today) ? ' is-today' : ''}`}>
                <button type="button" onClick={() => onPickDay(d)} title="Open this day">
                  <b>{d.toLocaleDateString('en-GB', { weekday: 'short' })}</b>
                  <span>{d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
                </button>
              </div>
            ))}
            {hours.map((h) => (
              <div key={h} className="iv4-trow">
                <div className="iv4-hour">{fmtHour(h)}</div>
                {days.map((d) => {
                  const list = (byDay.get(dayKey(d)) || []).filter((r) => new Date(r.interviewAt).getHours() === h);
                  return (
                    <div key={dayKey(d)} className={`iv4-tcell${sameDay(d, today) ? ' is-today' : ''}`}>
                      {list.slice(0, cap).map((r) => (
                        <EventCard key={r.id} r={r} selected={r.id === selectedId} onSelect={onSelect} now={now} />
                      ))}
                      {list.length > cap && (
                        <button
                          type="button"
                          className="iv4-more"
                          onClick={() => (mode === 'day' ? onMore(d, h) : onPickDay(d))}
                        >
                          {`+${list.length - cap} more`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      <footer className="iv4-legend" aria-label="Colours: interview status">
        {STATUS_LEGEND.map(([t, l]) => <span key={t}><i className={`iv4-dot iv4-sw-${t}`} />{l}</span>)}
        <span><i className="iv4-late">!</i>Feedback late</span>
      </footer>
    </section>
  );
}
