import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import './MultiSelect.css';
import { matchesText, noMatchText } from '../searchMatch.js';

// ---------------------------------------------------------------------------
// THE ONE FILTER DROPDOWN (founder 2026-11-20: "in every filter there are dropdowns: give CHECKBOXES everywhere, so several can be selected
// at a time and viewed together").
//
//   <MultiSelect label="Stage" value="joined,selected" onChange={(csv) => ...} options={[{ value, label, count }]} />
//
//   - the button reads "Stage: All", "Stage: Joined, Selected" or "Stage: 3 selected"
//   - the panel: a search box when there are more than 8 options, "Select all" and "Clear", a checkbox per option with its count; it stays open
//     while ticking, applies each tick after a short pause (300 ms), closes on a click outside or Esc
//   - keyboard: arrows move, Space or Enter ticks, Esc closes; at 375px the panel is a bottom sheet
//   - `value` / `onChange` are a comma list (the URL / API form); a comma inside one value is written %2C (utils/multiParam.js reads it back)
//   - options with a count of 0 are not offered, except the ones already ticked (so they can be seen and unticked)
//   - `openToken`: change it to open the panel from outside (a click on the filter's chip)
// ---------------------------------------------------------------------------
export const encodeValue = (v) => String(v).replace(/,/g, '%2C');
export const decodeValue = (v) => String(v).replace(/%2C/gi, ',');
export const csvToList = (csv) => String(csv || '').split(',').map((x) => decodeValue(x).trim()).filter(Boolean);
export const listToCsv = (list) => list.map(encodeValue).join(',');
// "Hyderabad, Nagpur" / "Hyderabad, Nagpur +2" / "3 selected"
export function summaryOf(chosenLabels) {
  if (!chosenLabels.length) return 'All';
  if (chosenLabels.length <= 2) return chosenLabels.join(', ');
  return `${chosenLabels.length} selected`;
}

export default function MultiSelect({
  label, value, onChange, options, allLabel, plural = '', loading = false, title, hideZero = true, openToken = 0, className = '', noLabel = false, delay = 300,
}) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const [q, setQ] = useState('');
  const [act, setAct] = useState(0);
  const box = useRef(null);
  const timer = useRef(null);
  const draftRef = useRef(null);
  const external = useMemo(() => csvToList(value), [value]);
  const [draft, setDraft] = useState(external);
  // follow the outside value unless a tick is waiting to be sent
  useEffect(() => { if (!timer.current) setDraft(external); }, [external.join('\u0001')]); // eslint-disable-line react-hooks/exhaustive-deps
  draftRef.current = draft;

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; onChange(listToCsv(draftRef.current)); }
  }, [onChange]);
  const send = (next) => {
    setDraft(next);
    draftRef.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; onChange(listToCsv(draftRef.current)); }, delay);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => { if (openToken) setOpen(true); }, [openToken]);
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    setQ(''); setAct(0);
    const r = box.current.getBoundingClientRect();
    setFlip(r.left + 290 > window.innerWidth);
  }, [open]);
  useEffect(() => {
    if (!open) { flush(); return undefined; }
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('touchstart', close); document.removeEventListener('keydown', esc); };
  }, [open, flush]);

  const base = (options || []).filter((o) => !hideZero || o.count === undefined || o.count === null || Number(o.count) > 0 || draft.includes(String(o.value)));
  const list = [...base.map((o) => ({ ...o, value: String(o.value) }))];
  draft.forEach((v) => { if (!list.some((o) => o.value === v)) list.push({ value: v, label: v, count: 0 }); });
  const showSearch = list.length > 8;
  const shown = list.filter((o) => matchesText(o.label, q));
  const nf = (n) => Number(n).toLocaleString('en-IN');
  if (!list.length) return loading ? <span className={`lph-facet lph-facet-loading ${className}`}>{label}…</span> : null;
  const labelOf = (v) => (list.find((o) => o.value === v) || {}).label || v;
  const summary = summaryOf(draft.map(labelOf));
  const toggle = (v) => {
    const next = draft.includes(v) ? draft.filter((x) => x !== v) : [...draft, v];
    const order = list.map((o) => o.value);
    send(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  };
  const selectAll = () => send([...new Set([...draft, ...shown.map((o) => o.value)])]);
  const clear = () => send([]);
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) setAct((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length); }
    else if ((e.key === 'Enter' || e.key === ' ') && shown.length) { e.preventDefault(); toggle(shown[Math.min(act, shown.length - 1)].value); }
  };
  const allText = allLabel || 'All';
  const buttonText = draft.length ? summary : allText === 'All' || /^(any|all)/i.test(allText) ? 'All' : allText;
  return (
    <div className={`msel${draft.length ? ' is-set' : ''} ${className}`} ref={box} title={title || label}>
      <button
        type="button"
        className="msel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        <span className="msel-sum">{noLabel ? buttonText : `${label}: ${buttonText}`}</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className={`msel-pop${flip ? ' is-flip' : ''}`} role="listbox" aria-multiselectable="true" aria-label={label} tabIndex={-1} onKeyDown={onKey}>
          <div className="msel-sheet-head"><b>{label}</b><button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Done</button></div>
          {showSearch && (
            <input className="msel-search" type="text" autoFocus autoComplete="off" value={q} placeholder="Type to search" aria-label={`Search ${label}`} onChange={(e) => { setQ(e.target.value); setAct(0); }} onKeyDown={onKey} />
          )}
          <div className="msel-tools">
            <button type="button" className="link-btn" onClick={selectAll} disabled={!shown.length}>Select all</button>
            <button type="button" className="link-btn" onClick={clear} disabled={!draft.length}>Clear</button>
            <span className="small-muted">{draft.length ? `${draft.length} ticked` : 'Tick one or more'}</span>
          </div>
          {!shown.length && <div className="msel-hint">{noMatchText(q)}</div>}
          <div className="msel-list">
            {shown.map((o, i) => {
              const on = draft.includes(o.value);
              return (
                <label key={o.value} className={`msel-item${on ? ' is-on' : ''}${i === Math.min(act, shown.length - 1) ? ' is-act' : ''}`} role="option" aria-selected={on}>
                  <input type="checkbox" checked={on} onChange={() => toggle(o.value)} onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') onKey(e); }} />
                  <span className="msel-name">{o.label}{o.group ? <span className="msel-grp">{` · ${o.group}`}</span> : null}</span>
                  <span className="msel-n">{o.count !== undefined && o.count !== null ? nf(o.count) : ''}</span>
                </label>
              );
            })}
          </div>
          <div className="msel-foot"><button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Done</button></div>
        </div>
      )}
    </div>
  );
}
