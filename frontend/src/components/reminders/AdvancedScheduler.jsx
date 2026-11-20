import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { istDate, addDays } from './remUtil.js';

// ---------------------------------------------------------------------------
// ADVANCED SCHEDULING (founder 2026-11-20): the parts of "Schedule a message" for a RECURRING message, used by the candidate tab and by the
// "Schedule a message" window of the Candidates & Pipeline list.
//   C. Schedule start (date, time)    D. Repeat frequency (daily / weekly on weekdays / monthly on a day / custom every X hours, days, weeks)
//   E. How many times (a number / until a date / until stopped)    the time zone and the sending window    G. Schedule summary (live)
// The summary is computed by the server's engine (POST /api/ats/scheduled-messages/preview), never guessed here, so it is exactly what will go.
// ---------------------------------------------------------------------------
export const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

export function defaultRecurring(windowDefault = { start: '07:00', end: '20:00' }) {
  const tomorrow = addDays(istDate(new Date().toISOString()), 1);
  return {
    kind: 'recurring', frequency: 'daily', weekdays: [new Date(`${tomorrow}T00:00:00Z`).getUTCDay()], monthDay: Number(tomorrow.slice(8)), intervalValue: 2, intervalUnit: 'days',
    startDate: tomorrow, startTime: '10:00', endMode: 'count', totalCount: 5, endDate: addDays(tomorrow, 6), timezone: 'Asia/Kolkata', windowStart: windowDefault.start, windowEnd: windowDefault.end,
  };
}
// what the server reads (only the fields of the chosen frequency / end)
export function specPayload(r) {
  const out = { kind: r.kind, startDate: r.startDate, startTime: r.startTime, timezone: r.timezone, windowStart: r.windowStart, windowEnd: r.windowEnd };
  if (r.kind !== 'recurring') return out;
  out.frequency = r.frequency;
  out.endMode = r.endMode;
  if (r.frequency === 'weekly') out.weekdays = r.weekdays;
  if (r.frequency === 'monthly') out.monthDay = Number(r.monthDay);
  if (r.frequency === 'custom') { out.intervalValue = Number(r.intervalValue); out.intervalUnit = r.intervalUnit; }
  if (r.endMode === 'count') out.totalCount = Number(r.totalCount);
  if (r.endMode === 'until') out.endDate = r.endDate;
  return out;
}

// the live summary: asks the engine 350 ms after the last change
export function useSchedulePreview(payload, enabled = true) {
  const [state, setState] = useState({ summary: null, error: '', busy: false });
  const key = JSON.stringify(payload || {});
  const seq = useRef(0);
  useEffect(() => {
    if (!enabled || !payload) { setState({ summary: null, error: '', busy: false }); return undefined; }
    const my = ++seq.current; // eslint-disable-line no-plusplus
    setState((s) => ({ ...s, busy: true }));
    const t = setTimeout(() => {
      api.post('/ats/scheduled-messages/preview', payload)
        .then((r) => { if (my === seq.current) setState({ summary: r.data.ok ? r.data.summary : null, error: r.data.ok ? '' : r.data.error, busy: false }); })
        .catch((e) => { if (my === seq.current) setState({ summary: null, error: e.response?.data?.error || 'The summary could not be worked out.', busy: false }); });
    }, 350);
    return () => clearTimeout(t);
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export function ScheduleSummary({ summary, error, busy, title = 'Schedule summary' }) {
  return (
    <div className="rem-text sm-summary" aria-label="Schedule summary" data-testid="sm-summary">
      <div className="sm-label" style={{ marginTop: 0 }}>{title}</div>
      {error && <div className="rem-bad">{error}</div>}
      {!error && !summary && <div className="small-muted">{busy ? 'Working it out…' : 'Pick the start, how often and how many times.'}</div>}
      {!error && summary && (
        <>
          <div className="sm-sum-grid">
            {summary.lines.map(([k, v]) => (
              <div key={k} className="sm-sum-line"><span className="small-muted">{k}</span><b>{v}</b></div>
            ))}
          </div>
          {summary.notes.map((n) => <div key={n} className="small-muted" style={{ fontSize: 11.5, marginTop: 4 }}>{n}</div>)}
          {summary.times && summary.times.length > 1 && (
            <details style={{ marginTop: 4 }}>
              <summary className="small-muted" style={{ cursor: 'pointer', fontSize: 12 }}>{summary.manual ? 'The first messages' : `All ${summary.times.length} times`}</summary>
              <ol className="sm-times">{summary.times.map((t) => <li key={t.at}>{t.words}</li>)}</ol>
            </details>
          )}
        </>
      )}
    </div>
  );
}

// C, D, E and the time zone / window
export default function AdvancedScheduler({ value: r, onChange, timezones = [], hours = { start: '07:00', end: '20:00' }, todayMin }) {
  const set = (p) => onChange({ ...r, ...p });
  const toggleDay = (d) => set({ weekdays: r.weekdays.includes(d) ? r.weekdays.filter((x) => x !== d) : [...r.weekdays, d].sort() });
  const minDay = todayMin || istDate(new Date().toISOString());
  return (
    <div className="sm-adv" data-testid="sm-advanced">
      <div className="sm-label">Schedule start</div>
      <div className="rem-actions">
        <input type="date" aria-label="Start date" value={r.startDate} min={minDay} onChange={(e) => set({ startDate: e.target.value })} />
        <input type="time" aria-label="Start time" value={r.startTime} onChange={(e) => set({ startTime: e.target.value })} />
      </div>

      <div className="sm-label">Repeat frequency</div>
      <div className="rem-quick" role="group" aria-label="Repeat frequency">
        {[['daily', 'Daily (every day)'], ['weekly', 'Weekly (selected weekdays)'], ['monthly', 'Monthly (selected date)'], ['custom', 'Custom (every X days / hours / weeks)']].map(([k, l]) => (
          <button key={k} type="button" className={`btn btn-sm${r.frequency === k ? ' btn-primary' : ''}`} aria-pressed={r.frequency === k} onClick={() => set({ frequency: k })}>{l}</button>
        ))}
      </div>
      {r.frequency === 'weekly' && (
        <div className="rem-quick" role="group" aria-label="Weekdays" style={{ marginTop: 6 }}>
          {WEEKDAYS.map(([d, l]) => (
            <label key={d} className="sm-day"><input type="checkbox" checked={r.weekdays.includes(d)} onChange={() => toggleDay(d)} />{l}</label>
          ))}
        </div>
      )}
      {r.frequency === 'monthly' && (
        <div className="rem-actions" style={{ marginTop: 6, alignItems: 'center' }}>
          <span className="small-muted">On day</span>
          <input type="number" min="1" max="31" style={{ width: 64 }} aria-label="Day of the month" value={r.monthDay} onChange={(e) => set({ monthDay: e.target.value })} />
          <span className="small-muted">of every month (a shorter month uses its last day)</span>
        </div>
      )}
      {r.frequency === 'custom' && (
        <div className="rem-actions" style={{ marginTop: 6, alignItems: 'center' }}>
          <span className="small-muted">Every</span>
          <input type="number" min="1" max="168" style={{ width: 64 }} aria-label="Every how many" value={r.intervalValue} onChange={(e) => set({ intervalValue: e.target.value })} />
          <select aria-label="Unit" value={r.intervalUnit} onChange={(e) => set({ intervalUnit: e.target.value })}>
            <option value="hours">hours</option><option value="days">days</option><option value="weeks">weeks</option>
          </select>
        </div>
      )}

      <div className="sm-label">How many times?</div>
      <div className="sm-ends" role="radiogroup" aria-label="How many times">
        <label className="sm-end">
          <input type="radio" name="sm-end" checked={r.endMode === 'count'} onChange={() => set({ endMode: 'count' })} />
          Specific number of times
          {r.endMode === 'count' && <input type="number" min="1" max="100" style={{ width: 64 }} aria-label="Total messages" value={r.totalCount} onChange={(e) => set({ totalCount: e.target.value })} />}
          {r.endMode === 'count' && <span className="small-muted">messages (1 to 100)</span>}
        </label>
        <label className="sm-end">
          <input type="radio" name="sm-end" checked={r.endMode === 'until'} onChange={() => set({ endMode: 'until' })} />
          Until a selected end date
          {r.endMode === 'until' && <input type="date" aria-label="End date" min={r.startDate || minDay} value={r.endDate} onChange={(e) => set({ endDate: e.target.value })} />}
        </label>
        <label className="sm-end">
          <input type="radio" name="sm-end" checked={r.endMode === 'manual'} onChange={() => set({ endMode: 'manual' })} />
          Until manually stopped
        </label>
      </div>

      <div className="sm-label">Timezone and sending window</div>
      <div className="rem-actions" style={{ alignItems: 'center' }}>
        <select aria-label="Timezone" value={r.timezone} onChange={(e) => set({ timezone: e.target.value })}>
          {(timezones.length ? timezones : [{ value: 'Asia/Kolkata', label: 'India (IST)' }]).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <span className="small-muted">Send only between</span>
        <input type="time" aria-label="Window start" value={r.windowStart} onChange={(e) => set({ windowStart: e.target.value })} />
        <span className="small-muted">and</span>
        <input type="time" aria-label="Window end" value={r.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })} />
        <span className="small-muted">{`(inside ${hours.start}-${hours.end})`}</span>
      </div>
    </div>
  );
}
