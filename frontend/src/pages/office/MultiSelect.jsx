// A small multi-select dropdown for the Office & Expenses filter bar.
// Label: "All · <count>" when nothing is picked (count = every option), the
// one name when one is picked, "<n> selected" otherwise.
import { useEffect, useRef, useState } from 'react';

export default function MultiSelect({
  options, value, onChange, noun, allCount,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const count = allCount ?? options.length;
  const label = value.length === 0 ? `All · ${count}` : value.length === 1 ? value[0] : `${value.length} selected`;
  const shown = options.filter((o) => !q || o.name.toLowerCase().includes(q.toLowerCase()));
  // A picked value no longer on offer (another filter narrowed the list) stays
  // visible so it can be unticked.
  const extra = value.filter((v) => !options.some((o) => o.name === v)).map((name) => ({ name, n: 0 }));
  const toggle = (name) => onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);

  return (
    <div className="oe-ms" ref={box}>
      <button type="button" className={`oe-dd-btn${value.length ? ' set' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title={value.join(', ') || `All ${noun}`}>
        <span className="oe-dd-txt">{label}</span><span className="oe-caret" />
      </button>
      {open && (
        <div className="oe-ms-panel" role="listbox" aria-multiselectable="true">
          <input className="oe-ms-q" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find a ${noun.replace(/s$/, '')}…`} />
          <button type="button" className={`oe-ms-opt${value.length === 0 ? ' on' : ''}`} onClick={() => onChange([])}>
            <span className="oe-tick">{value.length === 0 ? '✓' : ''}</span>All {noun} <span className="oe-ms-n">{count}</span>
          </button>
          <div className="oe-ms-list">
            {[...extra, ...shown].map((o) => (
              <button type="button" key={o.name} className={`oe-ms-opt${value.includes(o.name) ? ' on' : ''}`} onClick={() => toggle(o.name)} role="option" aria-selected={value.includes(o.name)}>
                <span className="oe-tick">{value.includes(o.name) ? '✓' : ''}</span>
                <span className="oe-ms-name">{o.name}</span>
                {o.n > 0 && <span className="oe-ms-n">{o.n}</span>}
              </button>
            ))}
            {shown.length === 0 && extra.length === 0 && <div className="oe-ms-empty">Nothing matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
