// ---------------------------------------------------------------------------
// Combo — ONE dropdown that you can also type into.
//
// It is a drop-in replacement for `<select>`: same children (`<option>` /
// `<optgroup>`), same `value`, and `onChange` is still handed an event-shaped
// object with `target.value`, so every existing form handler keeps working
// unchanged. The whole conversion across the app is `<select` -> `<Combo`.
//
// Two behaviours, and the difference is deliberate:
//
//   <Combo>            searchable  — type to filter, but the value MUST be one
//                                    of the options. Correct for anything the
//                                    API stores as an id or validates against a
//                                    closed enum (client, requirement,
//                                    recruiter, status, stage, role, priority).
//                                    Typed junk is refused, not silently kept.
//
//   <Combo creatable>  creatable   — type to filter, and a value that is not in
//                                    the list is ACCEPTED. Correct only for
//                                    fields the schema stores as a free string
//                                    (department, designation, location, city,
//                                    source, category, vendor, bank name).
//
// The listbox is portalled to <body> and positioned `fixed`, because .modal in
// styles.css is `overflow:auto` and would otherwise clip it.
//
// Looks: the control is an <input type=text>, which styles.css already styles
// with exactly the same rule as <select> (line 93), so the border, radius,
// padding, height and font match the rest of the app with no new design.
// ---------------------------------------------------------------------------
import {
  Children, isValidElement, Fragment, useCallback, useEffect, useId,
  useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';

// The text of an <option>'s children, whatever shape they arrive in
// ({c.name} ({c.code}) is an array, a number is a number, and so on).
function optionText(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(optionText).join('');
  if (isValidElement(node)) return optionText(node.props?.children);
  return '';
}

// Flatten <option> / <optgroup> children — including the ones that arrive from
// a .map(), a fragment or a `cond && <option/>` — into a plain list.
function collect(children, group, out) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) { collect(child.props.children, group, out); return; }
    if (child.type === 'optgroup') {
      collect(child.props.children, child.props.label || group, out);
      return;
    }
    if (child.type !== 'option') { collect(child.props?.children, group, out); return; }
    const label = optionText(child.props.children);
    // HTML: an <option> with no value attribute takes its text as the value.
    const value = child.props.value === undefined ? label : String(child.props.value);
    out.push({ value, label: label || value, group, disabled: !!child.props.disabled });
  });
  return out;
}

export default function Combo({
  value, onChange, children, creatable = false, disabled = false, required = false,
  className = '', style, placeholder, title, id, name, autoFocus,
  emptyText = 'No match', ...rest
}) {
  const options = useMemo(() => collect(children, null, []), [children]);
  const current = value === null || value === undefined ? '' : String(value);
  const selected = options.find((o) => o.value === current);

  // The first zero-value option ("— Select —", "All departments") doubles as
  // the placeholder, and STAYS in the list so clearing back to it still works.
  const blank = options.find((o) => o.value === '');
  const hint = placeholder || (blank ? blank.label : 'Select or type…');

  // What the input shows when it is not being typed into.
  const display = selected ? (selected.value === '' ? '' : selected.label)
    : (current && creatable ? current : '');

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listId = `${useId()}-list`;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [options, query]);

  const typed = query.trim();
  const exact = filtered.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const showCreate = creatable && !!typed && !exact;
  const rows = showCreate ? [...filtered, { create: true, value: typed, label: typed }] : filtered;

  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 200 && r.top > below;
    setRect({
      left: r.left, width: r.width,
      top: up ? undefined : r.bottom + 2,
      bottom: up ? window.innerHeight - r.top + 2 : undefined,
      max: Math.max(120, Math.min(260, (up ? r.top : below) - 12)),
    });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place, rows.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const node = listRef.current.children[active];
    if (node?.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function fire(next) {
    onChange?.({ target: { value: next, name }, currentTarget: { value: next, name } });
  }

  function commit(row) {
    if (!row || row.disabled) return;
    fire(row.value);
    setOpen(false); setQuery('');
  }

  function openList() {
    if (disabled) return;
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  }

  function close(revert) {
    setOpen(false);
    // Creatable: whatever was typed is a real value, so keep it rather than
    // throwing the user's typing away. Searchable: typed junk is dropped.
    if (!revert && creatable && query.trim() && query.trim() !== display) fire(query.trim());
    setQuery('');
  }

  function onKeyDown(e) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openList(); return; }
      if (!rows.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + rows.length) % rows.length);
      return;
    }
    if (e.key === 'Enter') {
      if (!open) return;                      // let the form submit as usual
      e.preventDefault();
      const row = rows[active];
      if (row) commit(row);
      else if (creatable && typed) { fire(typed); setOpen(false); setQuery(''); }
      return;
    }
    if (e.key === 'Escape') {
      if (!open) return;
      e.preventDefault(); e.stopPropagation();   // don't also close the modal
      close(true);
      return;
    }
    if (e.key === 'Tab' && open) close(false);
    if (e.key === 'Home' && open) { e.preventDefault(); setActive(0); }
    if (e.key === 'End' && open) { e.preventDefault(); setActive(rows.length - 1); }
  }

  const list = open && rect ? createPortal(
    <div
      className="combo-pop"
      style={{
        position: 'fixed', left: rect.left, width: rect.width,
        top: rect.top, bottom: rect.bottom, maxHeight: rect.max,
      }}
      onMouseDown={(e) => e.preventDefault()}   // keep focus on the input
    >
      <div className="combo-list" role="listbox" id={listId} ref={listRef} style={{ maxHeight: rect.max }}>
        {rows.map((o, i) => (
          <div
            key={`${o.create ? 'new' : 'o'}:${o.value}:${i}`}
            role="option"
            aria-selected={!o.create && o.value === current}
            className={`combo-opt${i === active ? ' active' : ''}${o.disabled ? ' disabled' : ''}${o.create ? ' create' : ''}${!o.create && o.value === current ? ' picked' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => commit(o)}
          >
            {o.create ? <>Use “<b>{o.label}</b>”</> : (o.label || <span className="combo-dim">{hint}</span>)}
            {o.group && !o.create && <span className="combo-group">{o.group}</span>}
          </div>
        ))}
        {!rows.length && (
          <div className="combo-opt disabled">
            {creatable ? 'Type a value…' : emptyText}
          </div>
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  // Only offer "clear" where empty is a value the field actually accepts: a
  // dropdown with no blank option (the workspace switcher, Employment type)
  // has no legal empty state, so clearing it would send junk to the handler.
  const showClear = !disabled && !!current && !required && (!!blank || creatable);

  return (
    <div
      ref={wrapRef}
      className={`combo${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        if (open) close(false);
      }}
    >
      <input
        {...rest}
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        title={title}
        autoFocus={autoFocus}
        disabled={disabled}
        // `required` on the visible input keeps native form validation: a
        // required dropdown still blocks submit when nothing is chosen.
        required={required}
        placeholder={hint}
        value={open ? query : display}
        onChange={(e) => { setQuery(e.target.value); setActive(0); if (!open) setOpen(true); }}
        onMouseDown={() => { if (!open) openList(); }}
        onFocus={() => { if (!open) openList(); }}
        onKeyDown={onKeyDown}
      />
      {showClear && (
        <button
          type="button"
          className="combo-clear"
          tabIndex={-1}
          aria-label="Clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { fire(''); setQuery(''); setOpen(false); inputRef.current?.focus(); }}
        >
          ×
        </button>
      )}
      <span className="combo-caret" aria-hidden="true" />
      {list}
    </div>
  );
}
