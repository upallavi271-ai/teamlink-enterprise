// ---------------------------------------------------------------------------
// The Office & Expenses period picker.
//
// Left: All time · Current Financial Year · Previous Financial Year · Quarter ·
// Half Year · Custom Date. Right: what that choice needs (FY pills, quarter or
// half pills, or a free calendar), the exact dates as read-only text, and a
// month calendar with the chosen range shaded and its two ends in a solid pill.
//
// Nothing changes until Apply — closing the panel keeps the filter as it was.
// The value is the same selection string the API reads (see officeUtil.js).
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MONTH_FULL, QUARTERS, HALVES, fyOf, fyLabel, rangeOfSel, fmtD, isoOf, todayIso,
} from './officeUtil';

const MODES = [
  ['all', 'All time'],
  ['cfy', 'Current Financial Year'],
  ['pfy', 'Previous Financial Year'],
  ['quarter', 'Quarter'],
  ['half', 'Half Year'],
  ['custom', 'Custom Date'],
];

function modeOfSel(sel, curFy) {
  const s = String(sel || 'all');
  if (s === 'all') return 'all';
  if (s.startsWith('C:')) return 'custom';
  if (s === `FY:${curFy}`) return 'cfy';
  if (s === `FY:${curFy - 1}`) return 'pfy';
  if (/^Q\d:/.test(s)) return 'quarter';
  if (/^H\d:/.test(s)) return 'half';
  return 'all';
}

function MonthGrid({
  ym, setYm, from, to, onDay, navigable,
}) {
  const [y, m0] = ym;
  const first = new Date(y, m0, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const n = new Date(y, m0 + 1, 0).getDate();
  const today = todayIso();
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(<span key={`b${i}`} className="oe-cal-day oe-cal-blank" />);
  for (let d = 1; d <= n; d += 1) {
    const iso = isoOf(new Date(y, m0, d));
    const inRange = from && to && iso >= from && iso <= to;
    const end = iso === from || iso === to;
    cells.push(
      <button
        type="button"
        key={iso}
        className={`oe-cal-day${inRange ? ' in' : ''}${end ? ' end' : ''}${iso === today ? ' today' : ''}${onDay ? '' : ' ro'}`}
        onClick={onDay ? () => onDay(iso) : undefined}
        tabIndex={onDay ? 0 : -1}
        aria-label={fmtD(iso)}
      >
        {d}
      </button>,
    );
  }
  const step = (k) => { const d = new Date(y, m0 + k, 1); setYm([d.getFullYear(), d.getMonth()]); };
  const years = [];
  for (let yy = new Date().getFullYear() - 6; yy <= new Date().getFullYear() + 2; yy += 1) years.push(yy);
  return (
    <div className="oe-cal">
      <div className="oe-cal-nav">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => step(-1)} aria-label="Previous month">‹</button>
        {navigable ? (
          <span className="oe-cal-sel">
            <select value={m0} onChange={(e) => setYm([y, Number(e.target.value)])} aria-label="Month">
              {MONTH_FULL.map((mn, i) => <option key={mn} value={i}>{mn}</option>)}
            </select>
            <select value={y} onChange={(e) => setYm([Number(e.target.value), m0])} aria-label="Year">
              {years.map((yy) => <option key={yy} value={yy}>{yy}</option>)}
            </select>
          </span>
        ) : <b>{MONTH_FULL[m0]} {y}</b>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => step(1)} aria-label="Next month">›</button>
      </div>
      <div className="oe-cal-grid">
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => <span key={w} className="oe-cal-w">{w}</span>)}
        {cells}
      </div>
    </div>
  );
}

export default function PeriodPicker({ value, onChange }) {
  const curFy = fyOf(new Date());
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('all');
  const [fy, setFy] = useState(curFy);
  const [part, setPart] = useState(null); // Q1..Q4 | H1 | H2
  const [cFrom, setCFrom] = useState('');
  const [cTo, setCTo] = useState('');
  const [ym, setYm] = useState([curFy, 3]);
  const box = useRef(null);

  // Opening the panel starts from what is applied, never from a stale draft.
  const openPanel = () => {
    const m = modeOfSel(value, curFy);
    const r = rangeOfSel(value);
    setMode(m);
    setFy(r.fy || curFy);
    setPart(m === 'quarter' || m === 'half' ? String(value).split(':')[0] : null);
    setCFrom(m === 'custom' ? r.from : '');
    setCTo(m === 'custom' ? r.to : '');
    const start = r.from ? new Date(`${r.from}T00:00:00`) : new Date();
    setYm([start.getFullYear(), start.getMonth()]);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // The draft selection string for the mode on screen.
  const draft = useMemo(() => {
    if (mode === 'all') return 'all';
    if (mode === 'cfy') return `FY:${curFy}`;
    if (mode === 'pfy') return `FY:${curFy - 1}`;
    if (mode === 'quarter') return part && part.startsWith('Q') ? `${part}:${fy}` : null;
    if (mode === 'half') return part && part.startsWith('H') ? `${part}:${fy}` : null;
    if (mode === 'custom') return cFrom && cTo ? `C:${cFrom}:${cTo}` : null;
    return null;
  }, [mode, fy, part, cFrom, cTo, curFy]);
  const dr = draft ? rangeOfSel(draft) : null;

  const jumpTo = (sel) => {
    const r = rangeOfSel(sel);
    if (r.from) { const d = new Date(`${r.from}T00:00:00`); setYm([d.getFullYear(), d.getMonth()]); }
  };
  const pickMode = (m) => {
    setMode(m);
    if (m === 'cfy') jumpTo(`FY:${curFy}`);
    if (m === 'pfy') jumpTo(`FY:${curFy - 1}`);
    if (m === 'quarter' || m === 'half') { setPart(null); jumpTo(`FY:${fy}`); }
    if (m === 'custom' && !cFrom) { const d = new Date(); setYm([d.getFullYear(), d.getMonth()]); }
  };
  const pickPart = (k) => { setPart(k); jumpTo(`${k}:${fy}`); };
  const pickFy = (y) => { setFy(y); if (part) jumpTo(`${part}:${y}`); else jumpTo(`FY:${y}`); };

  // Custom: the first tap is the from date, the second the to date (swapped if
  // it lands earlier); a third tap starts again.
  const tapDay = (iso) => {
    if (!cFrom || (cFrom && cTo)) { setCFrom(iso); setCTo(''); return; }
    if (iso < cFrom) { setCTo(cFrom); setCFrom(iso); } else setCTo(iso);
  };

  const apply = () => { if (draft) { onChange(draft); setOpen(false); } };
  const label = rangeOfSel(value).label;
  const fyPills = (
    <div className="oe-pills">
      {[curFy, curFy - 1].map((y) => (
        <button type="button" key={y} className={`oe-pill${fy === y ? ' on' : ''}`} onClick={() => pickFy(y)}>{fyLabel(y)}</button>
      ))}
    </div>
  );

  return (
    <div className="oe-pp" ref={box}>
      <button type="button" className={`oe-dd-btn${value !== 'all' ? ' set' : ''}`} onClick={() => (open ? setOpen(false) : openPanel())} aria-haspopup="dialog" aria-expanded={open}>
        <span className="oe-dd-txt">{label}</span><span className="oe-caret" />
      </button>
      {open && (
        <div className="oe-pp-panel" role="dialog" aria-label="Choose a period">
          <div className="oe-pp-left">
            {MODES.map(([k, l]) => (
              <button type="button" key={k} className={`oe-pp-mode${mode === k ? ' on' : ''}`} onClick={() => pickMode(k)}>{l}</button>
            ))}
          </div>
          <div className="oe-pp-right">
            {mode === 'all' && (
              <div className="oe-pp-note">Every bill on record, whatever its date.</div>
            )}
            {(mode === 'quarter') && (
              <>
                {fyPills}
                <div className="oe-pills">
                  {QUARTERS.map((q) => (
                    <button type="button" key={q.k} className={`oe-pill${part === q.k ? ' on' : ''}`} onClick={() => pickPart(q.k)}>{q.label}</button>
                  ))}
                </div>
              </>
            )}
            {(mode === 'half') && (
              <>
                {fyPills}
                <div className="oe-pills">
                  {HALVES.map((h) => (
                    <button type="button" key={h.k} className={`oe-pill${part === h.k ? ' on' : ''}`} onClick={() => pickPart(h.k)}>{h.label}</button>
                  ))}
                </div>
              </>
            )}
            {mode !== 'all' && mode !== 'custom' && (
              <div className="oe-pp-range">
                {dr ? `${fmtD(dr.from)} – ${fmtD(dr.to)}` : `Pick a ${mode === 'quarter' ? 'quarter' : 'half'}`}
              </div>
            )}
            {mode === 'custom' && (
              <div className="oe-pp-note">Tap a day for the from date, then another for the to date.</div>
            )}
            {mode !== 'all' && (
              <MonthGrid
                ym={ym}
                setYm={setYm}
                from={mode === 'custom' ? cFrom : dr?.from}
                to={mode === 'custom' ? (cTo || cFrom) : dr?.to}
                onDay={mode === 'custom' ? tapDay : null}
                navigable={mode === 'custom'}
              />
            )}
            {mode === 'custom' && (
              <div className="oe-pp-ft">
                <label><span>From</span><input readOnly value={cFrom ? fmtD(cFrom) : ''} placeholder="—" /></label>
                <label><span>To</span><input readOnly value={cTo ? fmtD(cTo) : ''} placeholder="—" /></label>
              </div>
            )}
            <div className="oe-pp-actions">
              {mode === 'custom' && <button type="button" className="btn btn-sm" onClick={() => { setCFrom(''); setCTo(''); }}>Clear</button>}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={!draft} onClick={apply}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
