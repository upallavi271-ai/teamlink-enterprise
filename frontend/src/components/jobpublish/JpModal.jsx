import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './jobpublish.css';

// A dialog drawn at <body> (above sticky table parts), closes on Escape / backdrop, keeps focus inside, gives focus back.
export default function JpModal({ title, onClose, children, foot, size = '', top = false, label }) {
  const box = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    const el = box.current;
    if (el) el.focus();
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose && onClose(); return; }
      if (e.key !== 'Tab' || !el) return;
      const f = Array.from(el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const a = f[0]; const z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (before && before.focus) try { before.focus(); } catch { /* gone */ } };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div className={`jp-back${top ? ' is-top' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <div className={`jp-modal ${size}`} role="dialog" aria-modal="true" aria-label={label || title} tabIndex={-1} ref={box}>
        <div className="jp-mhead">
          <h3>{title}</h3>
          <button type="button" className="jp-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="jp-mbody">{children}</div>
        {foot && <div className="jp-mfoot">{foot}</div>}
      </div>
    </div>,
    document.body,
  );
}
