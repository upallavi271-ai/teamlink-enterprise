import { useEffect, useRef, useState } from 'react';
import './jobs.css';

// ---------------------------------------------------------------------------
// "⋯" — the secondary actions of one row (ATS review #3 §16: the row shows
// ONE next action; Edit / Assign / Hold / Close / Export live in here). The
// menu is fixed-positioned from the button so the table's own scroll box
// never clips it. items: [{ key, label, danger? }]; onPick(key).
// ---------------------------------------------------------------------------
export default function RowMenu({ items, onPick, label = 'More actions' }) {
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);
  useEffect(() => {
    if (!pos) return undefined;
    const close = (e) => {
      if (menu.current && menu.current.contains(e.target)) return;
      if (btn.current && btn.current.contains(e.target)) return;
      setPos(null);
    };
    const esc = (e) => { if (e.key === 'Escape') setPos(null); };
    const away = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [pos]);
  if (!items || !items.length) return null;
  const toggle = (e) => {
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const r = btn.current.getBoundingClientRect();
    const width = 210;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
    const below = r.bottom + 4;
    const tall = 36 * items.length + 12;
    const top = below + tall > window.innerHeight ? Math.max(8, r.top - tall - 4) : below;
    setPos({ top, left, width });
  };
  return (
    <span className="rowmenu" onClick={(e) => e.stopPropagation()}>
      <button ref={btn} type="button" className="btn btn-sm btn-ghost rowmenu-btn" aria-haspopup="menu" aria-expanded={!!pos} aria-label={label} title={label} onClick={toggle}>
        ⋯
      </button>
      {pos && (
        <div ref={menu} className="rowmenu-menu" role="menu" style={{ top: pos.top, left: pos.left, width: pos.width }}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={`rowmenu-item${it.danger ? ' danger' : ''}`}
              onClick={() => { setPos(null); onPick(it.key); }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
