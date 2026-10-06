import {
  useEffect, useId, useMemo, useRef, useState,
} from 'react';

// ---------------------------------------------------------------------------
// A searchable multi-pick for the Invoice filters (Client, Recruiter name):
// a button that says what is picked, and a small panel with a search box,
// "Select all" / "Clear" and one checkbox per option with its count.
//
//   <MultiPick value={['A']} onChange={(list) => …} allLabel="All clients"
//              options={[{ value, label, count }]} noun="client" />
//
// Options with no rows are hidden unless picked (so a pick can be undone).
// Keyboard: Enter / Space / ↓ opens, Esc closes, Tab walks the checkboxes.
// ---------------------------------------------------------------------------
export default function MultiPick({
  value = [], onChange, options = [], allLabel = 'All', noun = 'item', searchHint, id,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);
  const search = useRef(null);
  const auto = useId();
  const panelId = `${id || auto}-panel`;
  const picked = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); box.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    setTimeout(() => search.current?.focus(), 0);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return options
      .filter((o) => Number(o.count) > 0 || picked.has(o.value))
      .filter((o) => !t || String(o.label).toLowerCase().includes(t));
  }, [options, q, picked]);

  const labelOf = (v) => (options.find((o) => o.value === v) || {}).label || v;
  const text = !value.length ? allLabel
    : value.length === 1 ? labelOf(value[0])
      : `${value.length} ${noun}s picked`;

  const toggle = (v) => onChange(picked.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const selectAll = () => onChange([...new Set([...value, ...shown.map((o) => o.value)])]);

  return (
    <div className={`invf-mp${open ? ' open' : ''}`} ref={box}>
      <button
        type="button"
        id={id}
        className={`invf-ctl invf-mp-btn${value.length ? ' set' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        title={value.length ? value.map(labelOf).join(', ') : allLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        <span className="invf-mp-txt">{text}</span>
        <span className="invf-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="invf-mp-pop" id={panelId} role="group" aria-label={`Pick ${noun}s`}>
          <input
            ref={search}
            type="search"
            className="invf-ctl"
            value={q}
            placeholder={searchHint || `Search ${noun}s…`}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown.length === 1) { e.preventDefault(); toggle(shown[0].value); }
            }}
          />
          <div className="invf-mp-acts">
            <button type="button" className="link-btn" onClick={selectAll} disabled={!shown.length}>Select all{q.trim() ? ' shown' : ''}</button>
            <button type="button" className="link-btn" onClick={() => onChange([])} disabled={!value.length}>Clear</button>
          </div>
          <div className="invf-mp-list">
            {shown.length === 0 && <div className="small-muted invf-mp-none">Nothing matches “{q.trim()}”.</div>}
            {shown.map((o) => (
              <label key={o.value} className={`invf-mp-opt${o.special ? ' special' : ''}`}>
                <input type="checkbox" checked={picked.has(o.value)} onChange={() => toggle(o.value)} />
                <span className="invf-mp-lbl">{o.label}</span>
                <span className="invf-mp-n">{Number(o.count || 0).toLocaleString('en-IN')}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
