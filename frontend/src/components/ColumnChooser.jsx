import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// "Columns ⚙" (spec §29) and a remembered-setting hook (spec §27).
//
//   const [cols, setCols] = useStoredState(`tl.candidates.cols.${user.id}`, defaults);
//   <ColumnChooser columns={[{ id, label, locked? }]} value={cols} onChange={setCols}
//                  defaults={defaults} />
//
// Generic on purpose — any table can use it. Stored in localStorage per key
// (put the user id in the key so a shared browser keeps each person's own).
// Every storage access is wrapped: a private window or blocked storage just
// means the setting is not remembered, never a broken page.
// ---------------------------------------------------------------------------
export function useStoredState(key, initial, validate) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        const parsed = JSON.parse(raw);
        if (!validate || validate(parsed)) return parsed;
      }
    } catch { /* not remembered — fall back */ }
    return typeof initial === 'function' ? initial() : initial;
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }, [key, value]);
  return [value, setValue];
}

export default function ColumnChooser({ columns, value, onChange, defaults, label = 'Columns ⚙' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const on = new Set(value || []);
  const toggle = (id) => {
    const next = new Set(on);
    if (next.has(id)) next.delete(id); else next.add(id);
    // Keep the table's own column order, not the click order.
    onChange(columns.filter((c) => c.locked || next.has(c.id)).map((c) => c.id));
  };
  return (
    <div className="colchooser" ref={box}>
      <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && (
        <div className="colchooser-menu" role="menu">
          {columns.map((c) => (
            <label key={c.id} className={`colchooser-item${c.locked ? ' is-locked' : ''}`}>
              <input
                type="checkbox"
                checked={c.locked || on.has(c.id)}
                disabled={c.locked}
                onChange={() => toggle(c.id)}
              />
              {c.label}
            </label>
          ))}
          {defaults && (
            <button type="button" className="link-btn colchooser-reset" onClick={() => onChange(defaults)}>
              Reset to default
            </button>
          )}
        </div>
      )}
    </div>
  );
}
