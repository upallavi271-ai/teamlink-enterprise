// Click anywhere on a table row to open that record.
// Things inside the row that do their own job (buttons, links, ticks, dropdowns...) never open it.
const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="menu"],[role="menuitem"],[role="option"],[role="checkbox"],[role="combobox"],[role="listbox"],[contenteditable="true"],[data-no-row-click]';

export function isInteractiveTarget(e) {
  const t = e && e.target;
  if (!t || typeof t.closest !== 'function') return false;
  const hit = t.closest(INTERACTIVE);
  // Only things INSIDE the row count (the row itself may carry a role).
  return !!hit && hit !== e.currentTarget;
}

function selectingText() {
  try { return typeof window !== 'undefined' && !!window.getSelection && window.getSelection().toString().length > 0; } catch { return false; }
}

// rowClickProps(() => navigate(...), { href: '/clients/1', className: 'extra' }) -> spread on <tr>.
// href is optional: with it, ctrl / cmd / middle click open a new tab like the name link does.
export function rowClickProps(onOpen, opts = {}) {
  const { href, className = '' } = opts;
  return {
    className: `row-link row-click${className ? ` ${className}` : ''}`,
    tabIndex: 0,
    onClick: (e) => {
      if (e.defaultPrevented || isInteractiveTarget(e) || selectingText()) return;
      if (href && (e.ctrlKey || e.metaKey)) { window.open(href, '_blank', 'noopener'); return; }
      if (e.button && e.button !== 0) return;
      onOpen(e);
    },
    onAuxClick: href ? (e) => {
      if (e.button !== 1 || isInteractiveTarget(e)) return;
      window.open(href, '_blank', 'noopener');
    } : undefined,
    onKeyDown: (e) => {
      if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); onOpen(e); }
    },
  };
}
