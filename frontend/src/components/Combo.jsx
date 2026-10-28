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
import './comboCompat.css';
import './comboCompatHand.css';
import { cleanCustom, sameOption, resolveCustom, CUSTOM_MAX } from './customValue.js';
import { matchesText, noMatchText } from './searchMatch.js';
import { useActiveDepartments, isActiveDepartment } from '../utils/activeDepartments.js';

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

const BIG_LIST = 20;

// Is this a department dropdown? Its blank row says "All departments" / "Any
// department", or the control is titled "Department".
const DEPT_BLANK = /^\s*(all|any|every)\s+departments?\b/i;
const DEPT_NAME = /^\s*(department|departments|dept)\s*$/i;
function looksLikeDepartments(options, ...names) {
  // The "all" row is usually value '' but sometimes 'All' (Invoices).
  if (options.some((o) => DEPT_BLANK.test(o.label))) return true;
  return names.some((n) => typeof n === 'string' && DEPT_NAME.test(n));
}

export default function Combo({
  value, onChange, children, creatable = false, disabled = false, required = false,
  className = '', style, placeholder, title, id, name, autoFocus,
  emptyText = 'No match', onSearch,
  // allowCustom (2026-10-14): type your own value when the list has none. customLabel 'Add' = stored in a shared list.
  allowCustom = false, customLabel = 'Use', validateCustom, onCreateOption, maxCustomLength = CUSTOM_MAX,
  // departments (2026-10-28): true = this is a department dropdown, false =
  // it is not. Unset = worked out from the blank option ("All departments",
  // "Any department") or a title / aria-label of "Department".
  departments,
  ...rest
}) {
  const free = creatable || allowCustom;
  const allOptions = useMemo(() => collect(children, null, []), [children]);
  const current = value === null || value === undefined ? '' : String(value);
  // A DEPARTMENT DROPDOWN OFFERS ONLY THE SWITCHED-ON DEPARTMENTS OF
  // DEPARTMENT & TEAM (founder 2026-10-28): a name only written on old records
  // ("Recruitment") or a switched-off department is dropped from the list.
  // The value already chosen and the blank / "No department" rows stay, and
  // until the master list has loaded nothing is hidden.
  const deptMode = departments === undefined ? looksLikeDepartments(allOptions, title, rest['aria-label'], placeholder) : !!departments;
  const liveDepts = useActiveDepartments(deptMode);
  const options = useMemo(() => (deptMode && liveDepts
    ? allOptions.filter((o) => o.value === '' || o.value === current || DEPT_BLANK.test(o.label) || isActiveDepartment(liveDepts, o.value, o.label))
    : allOptions), [allOptions, deptMode, liveDepts, current]);
  const selected = options.find((o) => o.value === current);

  // The first zero-value option ("— Select —", "All departments") doubles as
  // the placeholder, and STAYS in the list so clearing back to it still works.
  const blank = options.find((o) => o.value === '');
  const hint = placeholder || (blank ? blank.label : 'Select or type…');

  // What the input shows when it is not being typed into.
  const display = selected ? (selected.value === '' ? '' : selected.label)
    : (current && free ? current : '');
  // A value typed earlier (not in the list) is shown in the list as 'Your own: X'.
  const own = allowCustom && current && !selected ? current : '';

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listId = `${useId()}-list`;
  // Optional: tell the owner what is being typed, so it can search on the server.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;
  useEffect(() => { if (searchRef.current) searchRef.current(open ? query : ''); }, [open, query]);

  const filtered = useMemo(() => {
    // onSearch = the options already come filtered from the server.
    if (!query.trim() || onSearch) return options;
    return options.filter((o) => matchesText(o.label, query) || matchesText(o.value, query));
  }, [options, query]);

  // 2026-10-16: typing always works, also on a phone and also for a short list.
  const tiny = false;
  const typed = query.trim();
  const exact = filtered.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const ownRow = own && (!typed || own.toLowerCase().includes(typed.toLowerCase())) ? [{ own: true, value: own, label: `Your own: ${own}` }] : [];
  const typedClean = allowCustom ? cleanCustom(typed, maxCustomLength) : typed;
  const dupOfOwn = allowCustom && !!own && own.toLowerCase() === typedClean.toLowerCase();
  const showCreate = free && !!typedClean && !exact && !dupOfOwn;
  const rows = [...ownRow, ...filtered, ...(showCreate ? [{ create: true, value: typedClean, label: typedClean }] : [])];

  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 200 && r.top > below;
    // THE LIST IS AS WIDE AS ITS LONGEST OPTION ("Bathineni Yamuna · MED-3 ·
    // left Jun 2026"), never narrower than the box and never off-screen. A
    // box on the right half of the window opens leftwards, its right edges
    // lined up, so a wide list has room.
    const vw = window.innerWidth;
    const openLeft = r.left > vw / 2;
    setRect({
      left: openLeft ? undefined : r.left,
      right: openLeft ? vw - r.right : undefined,
      minWidth: r.width,
      maxWidth: Math.max(r.width, Math.min(480, (openLeft ? r.right : vw - r.left) - 8)),
      top: up ? undefined : r.bottom + 2,
      bottom: up ? window.innerHeight - r.top + 2 : undefined,
      max: Math.max(140, Math.min(380, (up ? r.top : below) - 12)),
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

  async function commit(row) {
    if (!row || row.disabled) return;
    if (row.create && allowCustom) { await pickCustom(typed); return; }
    fire(row.value);
    setOpen(false); setQuery('');
  }

  // allowCustom: a case-insensitive match picks the existing option; otherwise the cleaned text is the value.
  const [customErr, setCustomErr] = useState('');
  async function pickCustom(raw) {
    const r = resolveCustom(options, raw, validateCustom);
    if (r.value === undefined) { setCustomErr(r.error || ''); return false; }
    let v = r.value;
    if (!r.existing && onCreateOption) {
      try { const made = await onCreateOption(v); if (!made) return false; v = made; }
      catch (e) { setCustomErr((e && e.response && e.response.data && e.response.data.error) || 'That did not save. Try again.'); return false; }
    }
    setCustomErr('');
    fire(v); setOpen(false); setQuery('');
    return true;
  }

  function openList() {
    if (disabled) return;
    setQuery(''); setCustomErr('');
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  }

  function close(revert) {
    setOpen(false);
    // Creatable: whatever was typed is a real value, so keep it rather than
    // throwing the user's typing away. Searchable: typed junk is dropped.
    if (!revert && creatable && !allowCustom && query.trim() && query.trim() !== display) fire(query.trim());
    // allowCustom: keep typed text on leaving only when it is an exact match or nothing in the list matches it.
    else if (!revert && allowCustom && query.trim() && query.trim() !== display) {
      const hit = sameOption(options, query);
      if (hit) fire(hit.value);
      else if (!filtered.length) { const r = resolveCustom(options, query, validateCustom); if (r.value !== undefined && !onCreateOption) fire(r.value); }
    }
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
      else if (allowCustom && typed) pickCustom(typed);
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
        position: 'fixed', left: rect.left, right: rect.right,
        width: 'max-content', minWidth: rect.minWidth, maxWidth: rect.maxWidth,
        top: rect.top, bottom: rect.bottom, maxHeight: rect.max,
      }}
      onMouseDown={(e) => e.preventDefault()}   // keep focus on the input
    >
      <div className="combo-list" role="listbox" id={listId} ref={listRef} style={{ maxHeight: rect.max }}>
        {rows.map((o, i) => (
          <div
            key={`${o.create ? 'new' : 'o'}:${o.value}:${i}`}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={!o.create && o.value === current}
            className={`combo-opt${i === active ? ' active' : ''}${o.disabled ? ' disabled' : ''}${o.create ? ' create' : ''}${!o.create && o.value === current ? ' picked' : ''}${o.own ? ' own' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => commit(o)}
          >
            {o.create ? <>{customLabel} “<b>{o.label}</b>”</> : (o.label || <span className="combo-dim">{hint}</span>)}
            {o.group && !o.create && <span className="combo-group">{o.group}</span>}
          </div>
        ))}
        {options.length > BIG_LIST && !!rows.length && (
          <div className="combo-count" aria-hidden="true">
            {query.trim()
              ? `${filtered.filter((o) => o.value !== '').length} of ${options.length - (blank ? 1 : 0)} shown`
              : `${options.length - (blank ? 1 : 0)} choices — type to search`}
          </div>
        )}
        {!rows.length && (
          <div className="combo-opt disabled">
            {free ? 'Type a value…' : noMatchText(query, emptyText)}
          </div>
        )}
        {customErr && <div className="combo-opt disabled combo-err" role="alert">{customErr}</div>}
      </div>
    </div>,
    document.body,
  ) : null;

  // Only offer "clear" where empty is a value the field actually accepts: a
  // dropdown with no blank option (the workspace switcher, Employment type)
  // has no legal empty state, so clearing it would send junk to the handler.
  const showClear = !disabled && !!current && !required && (!!blank || free);

  return (
    <span
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
        aria-activedescendant={open && rows.length ? `${listId}-${active}` : undefined}
        aria-haspopup="listbox"
        readOnly={tiny || undefined}
        inputMode={tiny ? 'none' : undefined}
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
    </span>
  );
}
