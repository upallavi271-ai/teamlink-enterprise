import { useEffect, useRef, useState } from 'react';
import NewPeopleStrip from './NewPeopleStrip.jsx';

// "67 new, not on a requirement yet": the green banner of the Candidates page as ONE chip next to the search. It opens the same list
// in a popover (people added in the last 7 days, or everybody without an application who matches the search).
export default function NewPeopleChip({ waiting, searching, onShowAll }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!waiting || !waiting.rows || !waiting.rows.length) return null;
  const n = Number(waiting.total || waiting.rows.length);
  return (
    <span className="npc" ref={wrap}>
      <button
        type="button"
        className={`npc-chip${open ? ' on' : ''}`}
        aria-expanded={open}
        title="People added in the last 7 days who are not on a requirement yet. Open the person, then add them to a requirement."
        onClick={() => setOpen((o) => !o)}
      >
        {searching ? `${n.toLocaleString('en-IN')} found, not on a requirement yet` : `${n.toLocaleString('en-IN')} new, not on a requirement yet`}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div className="npc-pop" role="dialog" aria-label="New people not on a requirement yet">
          <NewPeopleStrip waiting={waiting} searching={searching} onShowAll={() => { setOpen(false); onShowAll(); }} />
        </div>
      )}
    </span>
  );
}
