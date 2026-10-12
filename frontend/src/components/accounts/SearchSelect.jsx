// A small searchable dropdown: type to narrow the list, click to pick, x to clear.
// options: [{ value, label, sub?, count? }]. Used for the Employee filter of the Journal
// and the Employee salary tab (hundreds of names - a plain <select> would be a long scroll).
import { useEffect, useMemo, useRef, useState } from 'react';
import './salaryVoucher.css';

export default function SearchSelect({ label, value, onChange, options, placeholder = 'Search…', allLabel = 'Everyone' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [act, setAct] = useState(0);
  const box = useRef(null);
  const chosen = (options || []).find((o) => String(o.value) === String(value));
  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = (options || []).filter((o) => !s || `${o.label} ${o.sub || ''}`.toLowerCase().includes(s));
    return list.slice(0, 200);
  }, [options, q]);
  const pick = (v) => { onChange(v); setOpen(false); setQ(''); };
  return (
    <label className="lb-f ss" ref={box} style={{ position: 'relative' }}>
      {label && <span>{label}</span>}
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          value={open ? q : (chosen ? chosen.label : '')}
          placeholder={chosen ? chosen.label : (value ? '…' : allLabel)}
          onFocus={() => { setOpen(true); setQ(''); setAct(0); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setAct(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAct((a) => Math.min(a + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAct((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && open) { e.preventDefault(); if (shown[act]) pick(shown[act].value); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          aria-label={label || 'Search'}
          autoComplete="off"
        />
        {value ? <button type="button" className="ss-clear" aria-label="Clear" onClick={(e) => { e.preventDefault(); pick(''); }}>×</button> : null}
      </div>
      {open && (
        <div className="ss-list" role="listbox">
          <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(''); }}><span>{allLabel}</span></button>
          {shown.length === 0 && <div className="ss-empty">{placeholder === 'Search…' ? 'Nobody matches that.' : placeholder}</div>}
          {shown.map((o, i) => (
            <button type="button" key={o.value} className={i === act ? 'act' : ''} onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}>
              <span>{o.label}{o.sub ? <span className="ss-sub"> · {o.sub}</span> : null}</span>
              {o.count !== undefined && o.count !== null ? <span className="ss-sub">{o.count}</span> : null}
            </button>
          ))}
        </div>
      )}
    </label>
  );
}
