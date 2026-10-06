import { useState } from 'react';
import './ui.css';

// ---------------------------------------------------------------------------
// "3–5 filters always visible, the rest under More Filters ▾" (review #3 §14).
//
//   <MoreFilters
//     primary={<>…search, department, stage, recruiter…</>}
//     activeMore={2}              // how many of the hidden filters are set
//     onClearAll={() => …}        // omit to hide the button
//     storageKey="cand"           // optional: remembers open/closed per page
//   >
//     …client, requirement, TL, BDE, location, source, follow-up, dates…
//   </MoreFilters>
//
// Active filters should still be shown as chips (components/FilterChips.jsx)
// so a hidden filter is never silently narrowing the list.
// ---------------------------------------------------------------------------
function readOpen(key) {
  if (!key) return false;
  try { return window.localStorage.getItem(`tl.morefilters.${key}`) === '1'; } catch { return false; }
}

export default function MoreFilters({ primary, children, activeMore = 0, onClearAll, storageKey, extra }) {
  const [open, setOpen] = useState(() => readOpen(storageKey));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (storageKey) { try { window.localStorage.setItem(`tl.morefilters.${storageKey}`, next ? '1' : '0'); } catch { /* ignore */ } }
  };
  return (
    <div className="mf">
      <div className="mf-row">
        {primary}
        {children && (
          <button type="button" className={`mf-toggle${open ? ' on' : ''}`} onClick={toggle} aria-expanded={open}>
            Filters{activeMore ? ` (${activeMore})` : ''} {open ? '▴' : '▾'}
          </button>
        )}
        {onClearAll && <button type="button" className="mf-clear" onClick={onClearAll}>Clear All</button>}
        {extra}
      </div>
      {children && open && <div className="mf-panel">{children}</div>}
    </div>
  );
}
