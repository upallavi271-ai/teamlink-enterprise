// Single-page forms for Office & Expenses: every section one below the other,
// a heading for each, an optional sticky index that follows the section in
// view, and "on submit, take me to the first field that needs fixing".
// The scroll container is the .modal itself (styles.css: .modal overflow:auto).
import { useEffect, useState } from 'react';

const smooth = () => (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// The heading of one section. It spans the whole form grid.
export function FormSection({ id, title, sub, className = '' }) {
  return (
    <h4 id={id} className={`oe-fs-h${className ? ` ${className}` : ''}`}>
      <span>{title}</span>
      {sub && <small>{sub}</small>}
    </h4>
  );
}

// A sticky row of section links. The section whose heading has scrolled past
// the top of the modal is highlighted; a click scrolls smoothly to it.
export function SectionIndex({ sections, label = 'Form sections' }) {
  const [active, setActive] = useState(sections[0] ? sections[0].id : null);
  const ids = sections.map((s) => s.id).join('|');

  useEffect(() => {
    const first = sections[0] && document.getElementById(sections[0].id);
    const root = first && first.closest('.modal');
    if (!root) return undefined;
    const heads = () => sections.map((s) => document.getElementById(s.id)).filter(Boolean);
    let raf = 0;
    const measure = () => {
      raf = 0;
      const list = heads();
      if (!list.length) return;
      const nav = root.querySelector('.oe-fs-nav');
      const line = root.getBoundingClientRect().top + (nav ? nav.offsetHeight : 0) + 24;
      let cur = list[0].id;
      list.forEach((h) => { if (h.getBoundingClientRect().top <= line) cur = h.id; });
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) cur = list[list.length - 1].id;
      setActive(cur);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    measure();
    return () => {
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  const go = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActive(id);
    el.scrollIntoView({ behavior: smooth(), block: 'start' });
  };

  return (
    <nav className="oe-fs-nav" aria-label={label}>
      {sections.map((s) => (
        <button key={s.id} type="button" className={`oe-fs-link${active === s.id ? ' on' : ''}`}
          aria-current={active === s.id ? 'true' : undefined} onClick={() => go(s.id)}>
          {s.short || s.title}
        </button>
      ))}
    </nav>
  );
}

// Scroll the first field marked data-invalid="true" into view and put the
// cursor in it (a type-to-search dropdown is only scrolled to, not opened).
export function focusFirstInvalid(container) {
  const bad = container && container.querySelector('[data-invalid="true"]');
  if (!bad) return false;
  bad.scrollIntoView({ behavior: smooth(), block: 'center' });
  const input = bad.querySelector('input:not([type=file]):not([role=combobox]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
  if (input) setTimeout(() => input.focus({ preventScroll: true }), 320);
  return true;
}

// Run focusFirstInvalid after the render that marked the fields: bump the
// returned `jump` function from the submit handler.
export function useJumpToInvalid(ref) {
  const [n, setN] = useState(0);
  useEffect(() => { if (n) focusFirstInvalid(ref.current); }, [n, ref]);
  return () => setN((x) => x + 1);
}
