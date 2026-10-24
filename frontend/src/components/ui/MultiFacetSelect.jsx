import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './MultiFacetSelect.css';
import { matchesText, noMatchText } from '../searchMatch.js';

// ---------------------------------------------------------------------------
// A filter where SEVERAL options can be ticked, each with its count —
// "Naukri (214)" — in the same look as FacetSelect (components/ui/ListPageHeader.jsx).
//
//   <MultiFacetSelect label="Source" allLabel="All sources" value="Naukri,Shine"
//     onChange={(csv) => …} options={[{ value, label, count }]} />
//
// `value` is a comma list (the URL / API form: ?source=Naukri,Shine). Options
// with a count of 0 are not offered, except the ones already ticked (so they
// can be seen and un-ticked). Nothing to choose = nothing drawn.
// ---------------------------------------------------------------------------
const csvOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

export default function MultiFacetSelect({
  label, value, onChange, options, allLabel = 'All', loading = false, title, plural = '',
}) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const [q, setQ] = useState('');
  const [act, setAct] = useState(0);
  const [flip, setFlip] = useState(false); // open towards the left when there is no room on the right
  const chosen = csvOf(value);
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    setQ(''); setAct(0);
    const r = box.current.getBoundingClientRect();
    setFlip(r.left + 270 > window.innerWidth);
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const list = (options || []).filter((o) => Number(o.count) > 0 || chosen.includes(String(o.value)));
  // A ticked value the server no longer lists (another filter hides it) stays visible.
  chosen.forEach((v) => { if (!list.some((o) => String(o.value) === v)) list.push({ value: v, label: v, count: 0 }); });
  if (!list.length) return loading ? <span className="lph-facet lph-facet-loading">{label}…</span> : null;
  const toggle = (v) => {
    const next = chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v];
    // keep the server's order, not the click order
    const order = list.map((o) => String(o.value));
    onChange(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(','));
  };
  const shown = list.filter((o) => matchesText(o.label, q));
  const hit = shown[Math.min(act, shown.length - 1)];
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) setAct((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length); }
    else if (e.key === 'Enter') { e.preventDefault(); if (hit) toggle(String(hit.value)); }
  };
  const labelOf = (v) => (list.find((o) => String(o.value) === v) || {}).label || v;
  const summary = !chosen.length ? allLabel
    : chosen.length <= 2 ? chosen.map(labelOf).join(', ')
      : `${chosen.length} ${plural || 'selected'}`;
  const nf = (n) => Number(n).toLocaleString('en-IN');
  return (
    <div className="lph-facet mfs" ref={box} title={title || label}>
      <span className="lph-facet-lbl">{label}</span>
      <button type="button" className={`mfs-btn${chosen.length ? ' is-set' : ''}`} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((o) => !o)}>
        <span className="mfs-sum">{summary}</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className={`mfs-pop${flip ? ' is-flip' : ''}`} role="listbox" aria-multiselectable="true" aria-label={label}>
          <input className="mfs-search" type="text" autoFocus autoComplete="off" value={q} placeholder="Type to search" aria-label={`Search ${label}`} onChange={(e) => { setQ(e.target.value); setAct(0); }} onKeyDown={onKey} />
          <div className="mfs-hint">Tick one or more</div>
          {!shown.length && <div className="mfs-hint">{noMatchText(q)}</div>}
          {shown.map((o) => {
            const v = String(o.value);
            const on = chosen.includes(v);
            return (
              <label key={v} className={`mfs-item${on ? ' is-on' : ''}${q.trim() && o === hit ? ' is-act' : ''}`} role="option" aria-selected={on}>
                <input type="checkbox" checked={on} onChange={() => toggle(v)} />
                <span className="mfs-name">{o.label}</span>
                <span className="mfs-n">{o.count !== undefined && o.count !== null ? nf(o.count) : ''}</span>
              </label>
            );
          })}
          <div className="mfs-foot">
            <button type="button" className="link-btn" disabled={!chosen.length} onClick={() => onChange('')}>Clear</button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
