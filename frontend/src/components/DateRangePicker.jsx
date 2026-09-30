// ---------------------------------------------------------------------------
// DateRangePicker — the Date / Calendar filter on every dashboard (hrms-24 §1).
//
//   [Quick pick ▾]  From [dd/mm/yyyy 📅] → To [dd/mm/yyyy 📅]  [Apply]  label
//
// THE PRIMARY CONTROL IS From → To → Apply, and it is always on screen — not
// hidden behind "Custom". The quick picks (Today, Yesterday, This Week, This
// Month, Last Month, Current Year, …) fill the two dates in and apply at once;
// typing or picking a date makes it a custom range that waits for Apply.
// Dates are SHOWN and TYPED as dd/mm/yyyy; the calendar button opens the
// browser's own date picker.
//
// It emits { range, from, to } (from/to as YYYY-MM-DD). The SERVER resolves
// that into real dates (backend/src/utils/dateRange.js) and sends the result
// back as `period`, whose label is what this shows — so the dates on screen
// are the dates that were counted, never a browser guess.
//
// useDateRange(key) remembers the last choice per dashboard in localStorage.
//
// `apply={false}` is for a screen that has its OWN Apply button (ATS Reports):
// a valid date edit is passed straight up and that screen's button applies it.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import Combo from './Combo.jsx';
import './DateRangePicker.css';

export const RANGE_PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['this_week', 'This Week'],
  ['this_month', 'This Month'],
  ['last_month', 'Last Month'],
  ['this_year', 'Current Year'],
  ['last_7', 'Last 7 Days'],
  ['this_quarter', 'This Quarter'],
  ['custom', 'Custom Range'],
];

export const DEFAULT_RANGE = { range: 'today', from: '', to: '' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 3 * 366; // the server's cap, checked here so the user is told before asking

// dd/mm/yyyy <-> YYYY-MM-DD. A typed date must be a real calendar day.
export function toDmy(iso) {
  return ISO.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
}
export function fromDmy(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return '';
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : '';
}

// Why a custom range cannot be sent yet, or '' when it can.
function customProblem(from, to) {
  if (!ISO.test(from || '') || !ISO.test(to || '')) return 'Enter both dates as dd/mm/yyyy';
  if (from > to) return 'From must be on or before To';
  if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > MAX_DAYS) return 'At most 3 years';
  return '';
}

function usable(v) {
  if (!v || !RANGE_PRESETS.some(([k]) => k === v.range)) return false;
  return v.range !== 'custom' || !customProblem(v.from, v.to);
}

export function useDateRange(storageKey) {
  const [value, setValue] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (usable(saved)) return { ...DEFAULT_RANGE, ...saved };
    } catch { /* private window, or junk in storage */ }
    return DEFAULT_RANGE;
  });
  const change = (next) => {
    setValue(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* private window */ }
  };
  return [value, change];
}

// The same resolution backend/src/utils/dateRange.js makes — keep the two in
// step. Used to fill the From/To boxes the moment a quick pick is chosen, and
// by a screen that reads endpoints taking plain from/to dates.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function resolveRange(v) {
  const day = (d) => d.toISOString().slice(0, 10);
  const today = day(new Date());
  const t = new Date(`${today}T00:00:00.000Z`);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const back = (n) => day(new Date(t.getTime() - n * 86400000));
  const key = usable(v) ? v.range : 'today';
  const [from, to] = {
    yesterday: [back(1), back(1)],
    this_week: [back((t.getUTCDay() + 6) % 7), today],
    last_7: [back(6), today],
    this_month: [day(new Date(Date.UTC(y, m, 1))), today],
    last_month: [day(new Date(Date.UTC(y, m - 1, 1))), day(new Date(Date.UTC(y, m, 0)))],
    this_quarter: [day(new Date(Date.UTC(y, m - (m % 3), 1))), today],
    this_year: [`${y}-01-01`, today],
    custom: [v && v.from, v && v.to],
  }[key] || [today, today];
  const part = (s, withYear) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    const txt = `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
    return withYear ? `${txt} ${d.getUTCFullYear()}` : txt;
  };
  const label = from === to ? part(from, true) : `${part(from, from.slice(0, 4) !== to.slice(0, 4))} – ${part(to, true)}`;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const name = key === 'custom' ? label : RANGE_PRESETS.find(([k]) => k === key)[1];
  return { key, from, to, label, name, days };
}

// The query parameters the dashboard endpoints take.
export function rangeParams(v) {
  return v.range === 'custom' ? { range: 'custom', from: v.from, to: v.to } : { range: v.range };
}

// One dd/mm/yyyy box with a calendar button beside it.
function DateBox({ label, text, iso, min, max, onText, onPick, onEnter }) {
  const native = useRef(null);
  function openCalendar() {
    const el = native.current;
    if (!el) return;
    try { el.showPicker(); } catch { el.focus(); }
  }
  return (
    <span className="drp-box">
      <span className="drp-lab">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        className="drp-text"
        placeholder="dd/mm/yyyy"
        aria-label={`${label} date (dd/mm/yyyy)`}
        value={text}
        maxLength={10}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } }}
      />
      <button type="button" className="drp-cal" aria-label={`Pick the ${label} date from a calendar`} title="Calendar" onClick={openCalendar}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          ref={native}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          className="drp-native"
          value={iso || ''}
          min={min || undefined}
          max={max || undefined}
          onChange={(e) => onPick(e.target.value)}
        />
      </button>
    </span>
  );
}

// `presets` lets a screen offer a different list — ATS Reports prepends
// All Time, which the dashboards do not have. Defaults to the list above.
export default function DateRangePicker({ value, onChange, period, presets = RANGE_PRESETS, apply = true }) {
  // What the boxes show: the applied range's real dates.
  const shown = value.range === 'all'
    ? { from: '', to: '' }
    : (period && period.from && period.key === value.range && (value.range !== 'custom' || (period.from === value.from && period.to === value.to)))
      ? { from: period.from, to: period.to }
      : resolveRange(value);
  const [draft, setDraft] = useState({ from: toDmy(shown.from), to: toDmy(shown.to) });
  const [dirty, setDirty] = useState(false);

  // A new applied range (a quick pick, or Apply) refills the boxes.
  useEffect(() => {
    setDraft({ from: toDmy(shown.from), to: toDmy(shown.to) });
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.range, value.from, value.to, shown.from, shown.to]);

  const isoFrom = fromDmy(draft.from);
  const isoTo = fromDmy(draft.to);
  const problem = dirty ? customProblem(isoFrom, isoTo) : '';

  function pick(range) {
    if (range === 'custom') {
      // Custom keeps the dates on screen until one is edited.
      const from = shown.from || new Date().toISOString().slice(0, 10);
      onChange({ range: 'custom', from, to: shown.to || from });
      return;
    }
    if (range !== value.range) onChange({ range, from: '', to: '' });
  }

  function edit(next) {
    setDraft(next);
    setDirty(true);
    if (!apply) {
      const f = fromDmy(next.from);
      const t = fromDmy(next.to);
      if (!customProblem(f, t)) onChange({ range: 'custom', from: f, to: t });
    }
  }

  function applyNow() {
    if (customProblem(isoFrom, isoTo)) { setDirty(true); return; }
    onChange({ range: 'custom', from: isoFrom, to: isoTo });
    setDirty(false);
  }

  const unchanged = value.range === 'custom' && value.from === isoFrom && value.to === isoTo;
  const label = period && period.label ? period.label : (value.range === 'all' ? '' : shown.label || resolveRange(value).label);

  return (
    <span className="drp" role="group" aria-label="Date range">
      <Combo value={dirty && apply ? 'custom' : value.range} onChange={(e) => pick(e.target.value)} title="Quick pick">
        {presets.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </Combo>
      <DateBox
        label="From"
        text={draft.from}
        iso={isoFrom}
        max={isoTo}
        onText={(t) => edit({ ...draft, from: t })}
        onPick={(iso) => edit({ ...draft, from: toDmy(iso) })}
        onEnter={applyNow}
      />
      <span className="drp-arrow" aria-hidden="true">→</span>
      <DateBox
        label="To"
        text={draft.to}
        iso={isoTo}
        min={isoFrom}
        onText={(t) => edit({ ...draft, to: t })}
        onPick={(iso) => edit({ ...draft, to: toDmy(iso) })}
        onEnter={applyNow}
      />
      {apply && (
        <button type="button" className="btn btn-sm btn-primary drp-apply" onClick={applyNow} disabled={!dirty || !!problem || unchanged}>
          Apply
        </button>
      )}
      {problem
        ? <span className="error-text drp-note">{problem}</span>
        : label && !dirty && <span className="small-muted drp-note">{label}</span>}
    </span>
  );
}
