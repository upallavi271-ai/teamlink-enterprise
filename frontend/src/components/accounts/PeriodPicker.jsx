// ---------------------------------------------------------------------------
// THE ACCOUNTS PERIOD PICKER (Accounts spec S1.6) — one calendar for every
// Accounts screen (Office & Accounts, Invoices, Bank, the Accounts dashboard).
//
//   <PeriodPicker value={v} onChange={setV} />
//
// value / onChange: { from, to, preset, applyTo }
//   from, to  'YYYY-MM-DD' (both null = All time)
//   preset    the key that was picked ('all', 'cfy', 'pfy', 'quarter', 'half',
//             'custom', 'today', 'thisMonth', … — see PRESET_LABEL)
//   applyTo   the chosen "Apply to" option's value (only when applyTo is given)
// onChange fires on Apply and on Clear (Clear = All time). Esc, or a click
// outside, closes without applying.
//
// Optional props
//   presets     true = the full quick list (Today … All time), or an array of
//               keys in the order to show. Without it the left panel is the
//               Indian-FY list: Current FY · Previous FY · Quarter · Half Year ·
//               Custom Date.
//   applyTo     [{ value, label }] or ['Invoice date', …] — adds an "Apply to"
//               dropdown; the first one is the default.
//   twoMonths   show two months side by side.
//   label       the small caption above the button (default "Period"; '' hides it).
//   minYear / maxYear  the year dropdown's range (the arrows stop at its edges).
//   align       'left' (default) | 'right' — which edge of the button the popover lines up with.
//
// Helpers exported for pages: ALL_TIME, periodText(value), presetRange(key),
// isAllTime(value), fyStartOf(date).
// The popover is rendered into document.body (position: fixed), so a table or
// a card with overflow never cuts it off; it re-positions on scroll / resize.
// ---------------------------------------------------------------------------
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import './PeriodPicker.css';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso) => new Date(`${iso}T00:00:00`);
const lastDay = (y, m0) => new Date(y, m0 + 1, 0).getDate();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const fmtDay = (iso) => {
  if (!iso || !ISO.test(iso)) return '';
  const [y, m, d] = iso.split('-');
  return `${d} ${MON[Number(m) - 1]} ${y}`;
};
// Indian financial year: 1 April – 31 March. The FY that holds `d`.
export const fyStartOf = (d = new Date()) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);
const fyName = (y) => `FY ${y}-${y + 1}`;
const fyRange = (y) => ({ from: `${y}-04-01`, to: `${y + 1}-03-31` });

const QUARTERS = [
  { k: 'Q1', label: 'Q1 · Apr–Jun', m0: 3, fyOff: 0 },
  { k: 'Q2', label: 'Q2 · Jul–Sep', m0: 6, fyOff: 0 },
  { k: 'Q3', label: 'Q3 · Oct–Dec', m0: 9, fyOff: 0 },
  { k: 'Q4', label: 'Q4 · Jan–Mar', m0: 0, fyOff: 1 },
];
const HALVES = [
  { k: 'H1', label: 'First Half · Apr–Sep' },
  { k: 'H2', label: 'Second Half · Oct–Mar' },
];
const quarterRange = (fy, k) => {
  const q = QUARTERS.find((x) => x.k === k);
  const y = fy + q.fyOff;
  return { from: `${y}-${pad(q.m0 + 1)}-01`, to: `${y}-${pad(q.m0 + 3)}-${pad(lastDay(y, q.m0 + 2))}` };
};
const halfRange = (fy, k) => (k === 'H1' ? { from: `${fy}-04-01`, to: `${fy}-09-30` } : { from: `${fy}-10-01`, to: `${fy + 1}-03-31` });

export const PRESET_LABEL = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  lastWeek: 'Last week',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisQuarter: 'This quarter',
  lastQuarter: 'Last quarter',
  cfy: 'Current Financial Year',
  pfy: 'Previous Financial Year',
  quarter: 'Quarter',
  half: 'Half Year',
  custom: 'Custom Date',
  all: 'All time',
};
// The quick list's own wording (spec S7.3) for the same keys.
const QUICK_LABEL = { cfy: 'This FY (Apr–Mar)', pfy: 'Last FY', custom: 'Custom' };
const QUICK_LIST = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'cfy', 'pfy', 'custom', 'all'];
const DEFAULT_LIST = ['cfy', 'pfy', 'quarter', 'half', 'custom'];
const ALIAS = { thisFy: 'cfy', lastFy: 'pfy', allTime: 'all' };

export const ALL_TIME = { from: null, to: null, preset: 'all' };
export const isAllTime = (v) => !v || !v.from || !v.to;

// The dates a fixed preset stands for, from `now`. Quarter / half / custom have
// no fixed dates (they need a pick) and return null.
export function presetRange(key, now = new Date()) {
  const k = ALIAS[key] || key;
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fy = fyStartOf(t);
  const mon = addDays(t, -((t.getDay() + 6) % 7));
  const qStartM = Math.floor(t.getMonth() / 3) * 3;
  switch (k) {
    case 'today': return { from: isoOf(t), to: isoOf(t) };
    case 'yesterday': { const y = addDays(t, -1); return { from: isoOf(y), to: isoOf(y) }; }
    case 'thisWeek': return { from: isoOf(mon), to: isoOf(addDays(mon, 6)) };
    case 'lastWeek': return { from: isoOf(addDays(mon, -7)), to: isoOf(addDays(mon, -1)) };
    case 'thisMonth': return { from: isoOf(new Date(t.getFullYear(), t.getMonth(), 1)), to: isoOf(new Date(t.getFullYear(), t.getMonth() + 1, 0)) };
    case 'lastMonth': return { from: isoOf(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: isoOf(new Date(t.getFullYear(), t.getMonth(), 0)) };
    case 'thisQuarter': return { from: isoOf(new Date(t.getFullYear(), qStartM, 1)), to: isoOf(new Date(t.getFullYear(), qStartM + 3, 0)) };
    case 'lastQuarter': return { from: isoOf(new Date(t.getFullYear(), qStartM - 3, 1)), to: isoOf(new Date(t.getFullYear(), qStartM, 0)) };
    case 'cfy': return fyRange(fy);
    case 'pfy': return fyRange(fy - 1);
    case 'all': return { from: null, to: null };
    default: return null;
  }
}

// "01 Apr 2026 – 31 Mar 2027", or "All time".
export function periodText(v) {
  if (isAllTime(v)) return 'All time';
  return v.from === v.to ? fmtDay(v.from) : `${fmtDay(v.from)} – ${fmtDay(v.to)}`;
}

// What a person may type into FROM / TO: 01 Apr 2026, 01-04-2026, 01/04/2026, 2026-04-01.
function parseTyped(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  let y; let m; let d;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (r) { [, y, m, d] = r; } else {
    r = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(t);
    if (r) { [, d, m, y] = r; } else {
      r = /^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/.exec(t);
      if (!r) return null;
      const mi = MON.findIndex((x) => x.toLowerCase() === r[2].slice(0, 3).toLowerCase());
      if (mi < 0) return null;
      [, d, , y] = r; m = mi + 1;
    }
  }
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(m) - 1 || dt.getDate() !== Number(d)) return null;
  return isoOf(dt);
}

const normApplyTo = (list) => (list || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));

// What the left item shows under its title: the dates it stands for.
function itemRangeText(key, draft, fy) {
  if (key === 'quarter') return draft.part && draft.part.startsWith('Q') ? periodText(quarterRange(draft.fy ?? fy, draft.part)) : 'Pick a quarter';
  if (key === 'half') return draft.part && draft.part.startsWith('H') ? periodText(halfRange(draft.fy ?? fy, draft.part)) : 'Pick a half';
  if (key === 'custom') return draft.from ? `${fmtDay(draft.from)} – ${draft.to ? fmtDay(draft.to) : '…'}` : 'Pick two days';
  return periodText(presetRange(key) || ALL_TIME);
}

function CalIcon() {
  return (
    <svg className="tlpp-ico" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="2.5" y="4" width="15" height="13.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.5 8.2h15M6.5 2.5v3M13.5 2.5v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// One month: Monday first, six-week grid; the in-range band runs on without a
// gap; days of the next / previous month are faded and cannot be tapped.
function Month({
  y, m0, from, to, onDay, today,
}) {
  const first = new Date(y, m0, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = addDays(first, -lead);
  const weeks = Math.ceil((lead + lastDay(y, m0)) / 7);
  const cells = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const d = addDays(start, i);
    const iso = isoOf(d);
    const own = d.getMonth() === m0;
    const lo = from && to ? (from <= to ? from : to) : from;
    const hi = from && to ? (from <= to ? to : from) : from;
    const inBand = own && lo && hi && iso >= lo && iso <= hi;
    const isStart = own && iso === lo;
    const isEnd = own && iso === hi;
    const col = i % 7;
    const cls = ['tlpp-d'];
    if (!own) cls.push('out');
    if (inBand) cls.push('in');
    if (isStart) cls.push('s');
    if (isEnd) cls.push('e');
    if (inBand && col === 0) cls.push('rowS');
    if (inBand && col === 6) cls.push('rowE');
    if (own && iso === today) cls.push('today');
    cells.push(
      <span key={iso} className={cls.join(' ')}>
        {own ? (
          <button type="button" onClick={() => onDay(iso)} aria-label={fmtDay(iso)} aria-pressed={isStart || isEnd}>{d.getDate()}</button>
        ) : <span className="tlpp-dn" aria-hidden="true">{d.getDate()}</span>}
      </span>,
    );
  }
  return (
    <div className="tlpp-month">
      <div className="tlpp-wk" aria-hidden="true">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w, i) => <span key={i}>{w}</span>)}</div>
      <div className="tlpp-grid">{cells}</div>
    </div>
  );
}

export default function PeriodPicker({
  value, onChange, presets, applyTo, twoMonths = false, label = 'Period', minYear, maxYear, align = 'left', className = '', id,
}) {
  const now = new Date();
  const curFy = fyStartOf(now);
  const yMin = minYear || now.getFullYear() - 8;
  const yMax = maxYear || now.getFullYear() + 2;
  const applyOpts = useMemo(() => normApplyTo(applyTo), [applyTo]);
  const list = useMemo(() => {
    if (presets === true) return QUICK_LIST;
    if (Array.isArray(presets) && presets.length) return presets.map((k) => ALIAS[k] || k).filter((k) => PRESET_LABEL[k]);
    return DEFAULT_LIST;
  }, [presets]);
  const quick = list !== DEFAULT_LIST;
  const itemLabel = (k) => (quick && QUICK_LABEL[k]) || PRESET_LABEL[k];

  const v = value || ALL_TIME;
  const [open, setOpen] = useState(false);
  // The draft being built in the popover — nothing reaches the page until Apply.
  //   key   the left item on      part  Q1..Q4 / H1 / H2      fy  the FY pill on
  //   from / to   the dates the grid shows (narrowed by tapping days)
  const [draft, setDraft] = useState({ key: list[0], from: null, to: null, fy: curFy, part: null, applyTo: undefined });
  const [ym, setYm] = useState([now.getFullYear(), now.getMonth()]);
  const [typed, setTyped] = useState({ from: '', to: '' });
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const pop = useRef(null);
  const tapNext = useRef('from');
  const today = isoOf(now);

  const jump = (iso) => { if (iso) { const d = dateOf(iso); setYm([d.getFullYear(), d.getMonth()]); } };
  const setDates = (from, to) => { setDraft((dd) => ({ ...dd, from, to })); setTyped({ from: fmtDay(from) || '', to: fmtDay(to) || '' }); };

  // Opening starts from what is applied.
  const openPanel = () => {
    let key = ALIAS[v.preset] || v.preset;
    if (!key || !list.includes(key)) {
      if (isAllTime(v)) key = list.includes('all') ? 'all' : list[0];
      else key = list.includes('custom') ? 'custom' : list[0];
    }
    let part = null; let fy = curFy;
    if ((key === 'quarter' || key === 'half') && v.from) {
      fy = fyStartOf(dateOf(v.from));
      const pool = key === 'quarter' ? QUARTERS.map((q) => [q.k, quarterRange(fy, q.k)]) : HALVES.map((h) => [h.k, halfRange(fy, h.k)]);
      const hit = pool.find(([, r]) => r.from === v.from && r.to === v.to);
      part = hit ? hit[0] : null;
    }
    const from = isAllTime(v) ? null : v.from;
    const to = isAllTime(v) ? null : v.to;
    let df = from; let dt = to;
    if (!df && key !== 'all' && key !== 'custom' && key !== 'quarter' && key !== 'half') {
      const r = presetRange(key); df = r?.from || null; dt = r?.to || null;
    }
    setDraft({
      key, from: df, to: dt, fy, part, applyTo: v.applyTo ?? applyOpts[0]?.value,
    });
    setTyped({ from: fmtDay(df) || '', to: fmtDay(dt) || '' });
    tapNext.current = 'from';
    jump(df || today);
    setOpen(true);
  };
  const close = useCallback(() => setOpen(false), []);

  const pick = (key) => {
    tapNext.current = 'from';
    if (key === 'quarter' || key === 'half') {
      // A quarter / half needs its pill first; the grid opens on the FY's April.
      const fy = draft.fy ?? curFy;
      setDraft((dd) => ({
        ...dd, key, part: null, from: null, to: null,
      }));
      setTyped({ from: '', to: '' });
      jump(`${fy}-04-01`);
      return;
    }
    if (key === 'custom') {
      setDraft((dd) => ({ ...dd, key, part: null }));
      if (!draft.from) jump(today);
      return;
    }
    const r = presetRange(key) || { from: null, to: null };
    setDraft((dd) => ({ ...dd, key, part: null }));
    setDates(r.from, r.to);
    jump(r.from || today);
  };
  const pickFy = (fy) => {
    setDraft((dd) => ({ ...dd, fy }));
    if (draft.part) {
      const r = draft.key === 'quarter' ? quarterRange(fy, draft.part) : halfRange(fy, draft.part);
      setDates(r.from, r.to); jump(r.from);
    } else jump(`${fy}-04-01`);
  };
  const pickPart = (part) => {
    const fy = draft.fy ?? curFy;
    const r = draft.key === 'quarter' ? quarterRange(fy, part) : halfRange(fy, part);
    setDraft((dd) => ({ ...dd, part }));
    setDates(r.from, r.to); jump(r.from);
    tapNext.current = 'from';
  };
  // Custom: the first tap is FROM, the second TO. On a preset, two taps narrow
  // the range (the preset stays lit, its dates follow the taps).
  const tapDay = (iso) => {
    if (draft.key === 'all') setDraft((dd) => ({ ...dd, key: list.includes('custom') ? 'custom' : dd.key }));
    if (tapNext.current === 'from' || !draft.from) {
      setDates(iso, null);
      tapNext.current = 'to';
      return;
    }
    if (iso < draft.from) setDates(iso, draft.from); else setDates(draft.from, iso);
    tapNext.current = 'from';
  };
  const typedDone = (which) => {
    const iso = parseTyped(typed[which]);
    if (iso === null) { setTyped((t) => ({ ...t, [which]: fmtDay(draft[which]) || '' })); return; }
    if (draft.key === 'all' && iso) setDraft((dd) => ({ ...dd, key: list.includes('custom') ? 'custom' : dd.key }));
    const from = which === 'from' ? (iso || null) : draft.from;
    const to = which === 'to' ? (iso || null) : draft.to;
    if (from && to && from > to) setDates(to, from); else setDates(from, to);
    if (iso) jump(iso);
  };

  const ready = draft.key === 'all' || (draft.from && draft.to);
  const apply = () => {
    if (!ready) return;
    const out = draft.key === 'all' || !draft.from ? { ...ALL_TIME } : { from: draft.from, to: draft.to, preset: draft.key };
    if (applyOpts.length) out.applyTo = draft.applyTo ?? applyOpts[0].value;
    onChange(out);
    setOpen(false);
  };
  const clear = () => {
    const out = { ...ALL_TIME };
    if (applyOpts.length) out.applyTo = draft.applyTo ?? applyOpts[0].value;
    onChange(out);
    setOpen(false);
  };

  // Esc / a click outside the button and the popover closes without applying.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btn.current?.contains(e.target) || pop.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  // Placement: below the button, kept inside the viewport (moves above it, or
  // pins to the top, when there is no room below).
  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    const p = pop.current;
    if (!b || !p) return;
    const vw = window.innerWidth; const vh = window.innerHeight;
    const w = Math.min(p.offsetWidth, vw - 16);
    const h = p.offsetHeight;
    let left = align === 'right' ? b.right - w : b.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = b.bottom + 6;
    if (top + h > vh - 8) {
      const above = b.top - h - 6;
      top = above >= 8 ? above : Math.max(8, vh - h - 8);
    }
    setPos({ left, top });
  }, [align]);
  useLayoutEffect(() => { if (open) place(); }, [open, place, draft.key, twoMonths, ym]);
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, place]);

  // Month header: the arrows stop at the year range's edges.
  const [y, m0] = ym;
  const canPrev = y > yMin || m0 > 0;
  const lastShownY = twoMonths && m0 === 11 ? y + 1 : y;
  const lastShownM = twoMonths ? (m0 + 1) % 12 : m0;
  const canNext = lastShownY < yMax || lastShownM < 11;
  const step = (k) => { const d = new Date(y, m0 + k, 1); setYm([d.getFullYear(), d.getMonth()]); };
  const years = [];
  for (let yy = yMin; yy <= yMax; yy += 1) years.push(yy);
  const second = new Date(y, m0 + 1, 1);

  const k = draft.key;
  let helper = '';
  if (k === 'cfy' || k === 'pfy') {
    const fy = k === 'cfy' ? curFy : curFy - 1;
    helper = `April ${fy} to March ${fy + 1} · tap days to narrow it.`;
  } else if (k === 'custom') helper = 'Tap a day for the from date, then another for the to date.';
  else if (k === 'all') helper = 'Every record, whatever its date. Tap two days to pick a range instead.';
  else if (k === 'quarter') helper = draft.part ? 'Tap days to narrow it.' : 'Pick the year, then the quarter.';
  else if (k === 'half') helper = draft.part ? 'Tap days to narrow it.' : 'Pick the year, then the half.';
  else helper = `${periodText(presetRange(k))} · tap days to narrow it.`;

  const fyPills = (
    <div className="tlpp-pills">
      {[curFy, curFy - 1].map((fy) => (
        <button type="button" key={fy} className={`tlpp-pill${(draft.fy ?? curFy) === fy ? ' on' : ''}`} onClick={() => pickFy(fy)}>{fyName(fy)}</button>
      ))}
    </div>
  );

  const shown = periodText(v);
  const popover = open && createPortal(
    <div
      ref={pop}
      className={`tlpp-pop${twoMonths ? ' two' : ''}`}
      role="dialog"
      aria-label="Choose a period"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
    >
      <div className="tlpp-left" role="listbox" aria-label="Period">
        {list.map((key) => {
          const on = k === key;
          return (
            <button type="button" key={key} role="option" aria-selected={on} className={`tlpp-item${on ? ' on' : ''}`} onClick={() => pick(key)}>
              <span className="tlpp-item-t">{itemLabel(key)}</span>
              {on && <span className="tlpp-item-r">{itemRangeText(key, draft, curFy)}</span>}
            </button>
          );
        })}
      </div>
      <div className="tlpp-right">
        <div className="tlpp-help">{helper}</div>
        {k === 'quarter' && (
          <>
            {fyPills}
            <div className="tlpp-pills">
              {QUARTERS.map((q) => <button type="button" key={q.k} className={`tlpp-pill${draft.part === q.k ? ' on' : ''}`} onClick={() => pickPart(q.k)}>{q.label}</button>)}
            </div>
          </>
        )}
        {k === 'half' && (
          <>
            {fyPills}
            <div className="tlpp-pills">
              {HALVES.map((h) => <button type="button" key={h.k} className={`tlpp-pill${draft.part === h.k ? ' on' : ''}`} onClick={() => pickPart(h.k)}>{h.label}</button>)}
            </div>
          </>
        )}
        <div className="tlpp-nav">
          <button type="button" className="tlpp-arrow" onClick={() => step(-1)} disabled={!canPrev} aria-label="Previous month">‹</button>
          <select value={m0} onChange={(e) => setYm([y, Number(e.target.value)])} aria-label="Month">
            {MONTH_FULL.map((mn, i) => <option key={mn} value={i}>{mn}</option>)}
          </select>
          <select value={y} onChange={(e) => setYm([Number(e.target.value), m0])} aria-label="Year">
            {years.map((yy) => <option key={yy} value={yy}>{yy}</option>)}
          </select>
          {twoMonths && <span className="tlpp-nav2">{MONTH_FULL[second.getMonth()]} {second.getFullYear()}</span>}
          <button type="button" className="tlpp-arrow" onClick={() => step(1)} disabled={!canNext} aria-label="Next month">›</button>
        </div>
        <div className="tlpp-months">
          <Month y={y} m0={m0} from={draft.from} to={draft.to} onDay={tapDay} today={today} />
          {twoMonths && <Month y={second.getFullYear()} m0={second.getMonth()} from={draft.from} to={draft.to} onDay={tapDay} today={today} />}
        </div>
        {applyOpts.length > 0 && (
          <label className="tlpp-apply-to">
            <span>Apply to</span>
            <select value={draft.applyTo ?? applyOpts[0].value} onChange={(e) => setDraft((dd) => ({ ...dd, applyTo: e.target.value }))}>
              {applyOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}
        <div className="tlpp-ft">
          <label className="tlpp-box">
            <span>From</span>
            <input
              value={typed.from}
              placeholder="DD Mon YYYY"
              onChange={(e) => setTyped((t) => ({ ...t, from: e.target.value }))}
              onBlur={() => typedDone('from')}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); typedDone('from'); } }}
              aria-label="From date"
            />
          </label>
          <label className="tlpp-box">
            <span>To</span>
            <input
              value={typed.to}
              placeholder="DD Mon YYYY"
              onChange={(e) => setTyped((t) => ({ ...t, to: e.target.value }))}
              onBlur={() => typedDone('to')}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); typedDone('to'); } }}
              aria-label="To date"
            />
          </label>
          <span className="tlpp-gap" />
          <button type="button" className="tlpp-btn" onClick={clear}>Clear</button>
          <button type="button" className="tlpp-btn pri" onClick={apply} disabled={!ready} title={ready ? undefined : 'Pick the to date first'}>Apply</button>
        </div>
      </div>
    </div>,
    document.body,
  );

  return (
    <div className={`tlpp ${className}`.trim()}>
      {label ? <span className="tlpp-cap" id={id ? `${id}-cap` : undefined}>{label}</span> : null}
      <button
        ref={btn}
        type="button"
        id={id}
        className={`tlpp-trigger${open ? ' open' : ''}${isAllTime(v) ? '' : ' set'}`}
        onClick={() => (open ? close() : openPanel())}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={applyOpts.length && v.applyTo ? `${shown} · by ${(applyOpts.find((o) => o.value === v.applyTo) || {}).label || v.applyTo}` : shown}
      >
        <CalIcon />
        <span className="tlpp-txt">{shown}</span>
        <span className="tlpp-caret" aria-hidden="true" />
      </button>
      {popover}
    </div>
  );
}
