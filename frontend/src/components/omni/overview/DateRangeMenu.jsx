import { useEffect, useRef, useState } from 'react';
import { PRESETS, presetRange, todayIst, fmtDay, monthFirst, addMonths, monthTitle, monthCells } from './dateRange.js';

// ---------------------------------------------------------------------------
// The Analytics date-range button + menu (the prototype's #dateRangeMenu): presets on the left (radio rows), a two-month calendar on the right.
//   * choosing a preset or clicking days changes the label and the calendar at once, but the numbers only change on "Update"
//   * "Cancel" (or a click outside) is a true undo: the range from when the menu was opened comes back
//   * first calendar click = start and end are that day; second click = the other end (swapped if earlier) and the preset becomes "Custom"
// value / onApply: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', preset }   (India days)
// ---------------------------------------------------------------------------
export default function DateRangeMenu({ value, onApply }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [snap, setSnap] = useState(value);
  const [month, setMonth] = useState(monthFirst(value.from));
  const [picking, setPicking] = useState('start');
  const ref = useRef(null);
  const today = todayIst();

  const openMenu = () => { setSnap(value); setDraft(value); setMonth(monthFirst(value.from)); setPicking('start'); setOpen(true); };
  const cancel = () => { setDraft(snap); setOpen(false); };
  const apply = () => { setOpen(false); onApply(draft); };
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) { setDraft(snap); setOpen(false); } };
    const key = (e) => { if (e.key === 'Escape') { setDraft(snap); setOpen(false); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, snap]);

  const pick = (p) => { const r = presetRange(p); setDraft({ ...r, preset: p }); setMonth(monthFirst(r.from)); setPicking('start'); };
  const clickDay = (d) => {
    if (picking === 'start') { setDraft({ from: d, to: d, preset: draft.preset }); setPicking('end'); return; }
    const [a, b] = d < draft.from ? [d, draft.from] : [draft.from, d];
    setDraft({ from: a, to: b, preset: 'Custom' }); setPicking('start');
  };
  const Grid = ({ first }) => (
    <div className="ov-cal-grid" role="grid" aria-label={monthTitle(first)}>
      {['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].map((h) => <span key={h} className="h">{h}</span>)}
      {monthCells(first).map((d, i) => {
        if (!d) return <span key={`b${i}`} />;
        const edge = d === draft.from || d === draft.to;
        const cls = `d${d > draft.from && d < draft.to ? ' in' : ''}${edge ? ' edge' : ''}${d === draft.from ? ' s' : ''}${d === draft.to ? ' e' : ''}${d === today ? ' today' : ''}`;
        return <button type="button" key={d} className={cls} onClick={() => clickDay(d)} aria-label={fmtDay(d)} aria-pressed={edge}>{Number(d.slice(8))}</button>;
      })}
    </div>
  );
  const m2 = addMonths(month, 1);
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="tiny-btn" style={{ height: 36, padding: '0 14px', gap: 6, display: 'flex', alignItems: 'center' }} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? cancel() : openMenu())}>
        📅 <span>{(open ? draft : value).preset}: {fmtDay((open ? draft : value).from)} - {fmtDay((open ? draft : value).to)}</span> ▾
      </button>
      <div className={`menu ov-dr-menu${open ? ' show' : ''}`} role="dialog" aria-label="Choose dates">
        {open && (
          <div className="ov-dr-inner">
            <div className="dr-presets" role="radiogroup" aria-label="Quick ranges">
              {PRESETS.map((p) => <button type="button" key={p} className={`dr-preset${draft.preset === p ? ' sel' : ''}`} role="radio" aria-checked={draft.preset === p} onClick={() => pick(p)}><span className="dr-radio">{draft.preset === p ? <span /> : null}</span>{p}</button>)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                <button type="button" className="tiny-btn" style={{ width: 24, height: 24, padding: 0, fontSize: 12 }} onClick={() => setMonth(addMonths(month, -1))} aria-label="Earlier month">‹</button>
                <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', justifyContent: 'center' }}>{[month, m2].map((m) => <b key={m} style={{ fontSize: 11 }}>{monthTitle(m)}</b>)}</div>
                <button type="button" className="tiny-btn" style={{ width: 24, height: 24, padding: 0, fontSize: 12 }} onClick={() => setMonth(addMonths(month, 1))} aria-label="Later month">›</button>
              </div>
              <div className="ov-cal-months"><Grid first={month} /><Grid first={m2} /></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 8, color: 'var(--blue)' }}>Dates are shown in Kolkata Time</span>
                <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn" onClick={cancel}>Cancel</button><button type="button" className="btn primary" onClick={apply}>Update</button></div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
