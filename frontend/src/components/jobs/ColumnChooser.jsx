import { useEffect, useRef, useState } from 'react';
import './jobs.css';

// ---------------------------------------------------------------------------
// "Columns ⚙" (UX spec §29). A checkbox per column the login MAY see; the
// choice is remembered per user in localStorage (wrapped — private windows
// and blocked storage fall back to the role default, never an error).
//
//   const [cols, setCols] = useColumns(`tl.reqcols.${user.id}`, allowedKeys, defaultKeys);
//   <ColumnChooser columns={[{ key, label }]} value={cols} onChange={setCols} defaults={defaultKeys} />
// ---------------------------------------------------------------------------
function readStored(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}
function writeStored(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export function useColumns(storageKey, allowed, defaults) {
  const clean = (list) => (list || []).filter((k) => allowed.includes(k));
  const [cols, setColsState] = useState(() => {
    const stored = clean(readStored(storageKey));
    return stored.length ? stored : clean(defaults);
  });
  // Role / login changed: re-read.
  useEffect(() => {
    const stored = clean(readStored(storageKey));
    setColsState(stored.length ? stored : clean(defaults));
  }, [storageKey, allowed.join(','), defaults.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const setCols = (next) => {
    const v = clean(next);
    setColsState(v);
    writeStored(storageKey, v);
  };
  return [cols, setCols];
}

export default function ColumnChooser({ columns, value, onChange, defaults }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const toggle = (key) => {
    const on = value.includes(key);
    // Keep the column order of `columns`, and never allow zero columns.
    const next = columns.map((c) => c.key).filter((k) => (k === key ? !on : value.includes(k)));
    if (next.length) onChange(next);
  };
  return (
    <div className="jobsws-cols" ref={ref}>
      <button type="button" className="btn btn-sm btn-ghost" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Columns ⚙
      </button>
      {open && (
        <div className="jobsws-cols-menu">
          {columns.map((c) => (
            <label key={c.key}>
              <input type="checkbox" checked={value.includes(c.key)} onChange={() => toggle(c.key)} />
              {c.label}
            </label>
          ))}
          <div className="foot">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(defaults)}>Reset</button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
