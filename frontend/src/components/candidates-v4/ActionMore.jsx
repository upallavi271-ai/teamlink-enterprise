import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// THE ONE "MORE" MENU OF THE CANDIDATES PAGE ACTION BAR (founder 2026-11-20: "this page looks too clumsy").
// The bar shows Add candidate and Import; everything else (Duplicates, New people, Verify, Templates & campaigns, Export, Template,
// Approvals & history, Saved filters) is a line in this menu. `badge` is a small number on the button (duplicates waiting).
//
// The children keep their own dialogs (the template library, the export window ...). So they stay MOUNTED when the menu is closed:
// only their buttons are hidden by CSS (candidatesTidy.css), their dialogs are not.
// ---------------------------------------------------------------------------
export default function ActionMore({ badge = 0, children, label = 'More' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); const b = wrap.current && wrap.current.querySelector('.ac-more-btn'); if (b) b.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  // A line that opens a dialog closes the menu (the dialog stays); the Saved filters list keeps it open.
  const onPanelClick = (e) => {
    const b = e.target.closest('button');
    if (b && !b.closest('.savedviews')) setTimeout(() => setOpen(false), 0);
  };
  return (
    <div className="ac-more" ref={wrap}>
      <button
        type="button"
        className="btn ac-more-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="More actions"
        title="Duplicates, new people, templates and campaigns, export, template, history and saved filters"
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {Number(badge) > 0 && <span className="ac-badge">{Number(badge).toLocaleString('en-IN')}</span>}
        <span aria-hidden="true" className="ac-caret">▾</span>
      </button>
      <div className={`ac-panel${open ? ' open' : ''}`} role="group" aria-label="More actions" onClick={onPanelClick}>
        {children}
      </div>
    </div>
  );
}
