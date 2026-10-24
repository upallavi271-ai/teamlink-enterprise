import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './reach.css';

// ---------------------------------------------------------------------------
// ONE window for every Call / Message / WhatsApp / Email dialog of the Candidates list and board.
//
// It is drawn through a PORTAL into document.body, with its own fixed full-screen backdrop, so no
// sticky table header, sticky column, scroll box or transform of the page can paint over it or cut it.
// z-index 1150 = above the app shell (sidebar 45, dialogs 100, AI button 120, the View-as banner 1001),
// just under the global job-request popup (1200). Esc closes; Tab stays inside; the first button or field
// is focused; the page behind does not scroll. `compact` = a small centred card (a bottom sheet on a phone).
//   <ReachModal title onClose footer wide compact>…</ReachModal>
// ---------------------------------------------------------------------------
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function ReachModal({
  title, onClose, footer, children, wide = false, compact = false,
}) {
  const card = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    // first button / field of the body gets the focus (the head's × is the fallback)
    const t = setTimeout(() => {
      if (!card.current) return;
      const first = card.current.querySelector('.rch-modal-body [data-autofocus]:not([disabled])') || card.current.querySelector(`.rch-modal-body ${FOCUSABLE.split(',').join(', .rch-modal-body ')}`) || card.current.querySelector(FOCUSABLE);
      if (first) first.focus();
    }, 30);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !card.current) return;
      const list = [...card.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0]; const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } else if (!card.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* gone */ }
    };
  }, []);

  return createPortal(
    <div className="rch-modal-back" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={card} className={`rch-modal${wide ? ' is-wide' : ''}${compact ? ' is-compact' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="rch-modal-head">
          <h3>{title}</h3>
          <button type="button" className="rch-modal-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="rch-modal-body">{children}</div>
        {footer && <div className="rch-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
