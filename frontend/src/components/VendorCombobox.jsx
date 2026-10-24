import {
  forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import './vendorCombobox.css';
import { matchesText, noMatchText } from './searchMatch.js';

// ---------------------------------------------------------------------------
// VendorCombobox - the Vendor field of "Add vendor login" (2026-10-14).
// A dedicated component (components/Combo.jsx stays untouched: it cannot carry a pinned "+ Add Vendor" row, the grey
// category text, loading / error states or the exact keyboard rules below).
//
//   OPTIONS   [{ id, name, category, disabled, note }]  A-Z by the caller. Option = vendor name + category in small
//             grey text; a `disabled` one is greyed and says its `note` ("Login exists"), and cannot be picked.
//   STATES    loading ("Loading vendors...") - error + Retry - nothing to pick - "No matching vendor". The last row,
//             "+ Add Vendor", is ALWAYS there (pinned to the bottom of the list), whatever the state.
//   KEYS      Tab reaches the field. Enter / Space / ArrowDown open it. ArrowUp / ArrowDown move the highlight (kept in
//             view), Home / End jump, Enter picks, Esc closes WITHOUT changing the choice and keeps focus here (it does
//             not close the drawer behind). Typing filters (name or category, any case). Backspace / Delete on a closed
//             field with a choice clears it. After a pick the caller moves focus (onSelect).
//   ARIA      role=combobox + aria-expanded / aria-controls / aria-activedescendant / aria-autocomplete, role=listbox,
//             role=option + aria-selected / aria-disabled; status text is aria-live. The list is portalled to <body>
//             at the field's width, so the drawer never clips it.
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase();

const VendorCombobox = forwardRef(function VendorCombobox({
  id, value, options = [], loading = false, error = '', onRetry, onSelect, onClear, onAddNew, disabled = false, selectedLabel,
  placeholder = 'Pick from the vendor list...', describedBy, className = '',
}, ref) {
  const uid = useId();
  const listId = `${uid}-list`;
  const inputRef = useRef(null);
  const wrapRef = useRef(null);
  const listRef = useRef(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current && inputRef.current.focus() }));

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState(null);

  const selected = options.find((o) => o.id === value);
  const shown = selected ? selected.name : (selectedLabel || '');

  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    return options.filter((o) => matchesText(`${o.name || ''} ${o.category || ''}`, query));
  }, [options, query]);

  // The rows the keyboard walks: Retry (on error), the vendors, then "+ Add Vendor" (always last).
  const rows = useMemo(() => {
    const r = [];
    if (error) r.push({ kind: 'retry' });
    if (!loading && !error) filtered.forEach((o) => r.push({ kind: 'vendor', o }));
    r.push({ kind: 'add' });
    return r;
  }, [filtered, loading, error]);

  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 220 && r.top > below;
    setRect({
      left: r.left, width: r.width, top: up ? undefined : r.bottom + 2, bottom: up ? window.innerHeight - r.top + 2 : undefined,
      max: Math.max(150, Math.min(340, (up ? r.top : below) - 12)),
    });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place, rows.length]);
  useEffect(() => {
    if (!open) return undefined;
    const f = () => place();
    window.addEventListener('scroll', f, true);
    window.addEventListener('resize', f);
    return () => { window.removeEventListener('scroll', f, true); window.removeEventListener('resize', f); };
  }, [open, place]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const node = listRef.current.querySelector(`[data-row="${active}"]`);
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }, [active, open, rows.length]);

  const openList = useCallback(() => {
    if (disabled) return;
    setQuery('');
    const at = rows.findIndex((r) => r.kind === 'vendor' && r.o.id === value);
    setActive(at >= 0 ? at : 0);
    setOpen(true);
  }, [disabled, rows, value]);
  const close = () => { setOpen(false); setQuery(''); };

  function choose(row) {
    if (!row) return;
    if (row.kind === 'vendor') {
      if (row.o.disabled) return;
      close();
      onSelect && onSelect(row.o);
    } else if (row.kind === 'add') {
      close();
      onAddNew && onAddNew();
    } else if (row.kind === 'retry') {
      onRetry && onRetry();
    }
  }

  function onKeyDown(e) {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || (k === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey)) {
        e.preventDefault();
        openList();
      } else if ((k === 'Backspace' || k === 'Delete') && value) {
        e.preventDefault();
        onClear && onClear();
      }
      return;
    }
    if (k === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(rows.length - 1, i + 1)); } else if (k === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); } else if (k === 'Home') { e.preventDefault(); setActive(0); } else if (k === 'End') { e.preventDefault(); setActive(rows.length - 1); } else if (k === 'Enter') { e.preventDefault(); choose(rows[active]); } else if (k === 'Escape') {
      // Close the list only: the choice stays as it was, focus stays here, the drawer behind does not close.
      e.preventDefault(); e.stopPropagation();
      close();
    } else if (k === 'Tab') close();
  }

  const status = loading ? 'Loading vendors' : (error || (filtered.length ? `${filtered.length} vendor${filtered.length === 1 ? '' : 's'} found` : noMatchText(query, 'No matching vendor')));

  const list = open && rect ? createPortal(
    <div
      className="vcb-pop"
      style={{ position: 'fixed', left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="vcb-list" role="listbox" id={listId} aria-label="Vendors" ref={listRef} style={{ maxHeight: rect.max }}>
        {loading && <div className="vcb-note" role="presentation">Loading vendors...</div>}
        {!loading && error && (
          <div
            id={`${listId}-0`} data-row={0} role="option" aria-selected="false"
            className={`vcb-opt vcb-retry${active === 0 ? ' active' : ''}`}
            onMouseEnter={() => setActive(0)} onClick={() => choose(rows[0])}
          >
            <span>{error}</span><b>Retry</b>
          </div>
        )}
        {!loading && !error && !filtered.length && <div className="vcb-note" role="presentation">{options.length ? noMatchText(query, 'No matching vendor') : 'No vendors to pick yet'}</div>}
        {rows.map((r, i) => {
          if (r.kind === 'vendor') {
            const o = r.o;
            return (
              <div
                key={o.id} id={`${listId}-${i}`} data-row={i} role="option" aria-selected={o.id === value} aria-disabled={o.disabled || undefined}
                className={`vcb-opt${i === active ? ' active' : ''}${o.disabled ? ' off' : ''}${o.id === value ? ' picked' : ''}`}
                onMouseEnter={() => setActive(i)} onClick={() => choose(r)}
              >
                <span className="vcb-name">{o.name}</span>
                <span className="vcb-cat">{o.disabled && o.note ? o.note : (o.category || '')}</span>
              </div>
            );
          }
          if (r.kind === 'add') {
            return (
              <div
                key="add" id={`${listId}-${i}`} data-row={i} role="option" aria-selected="false"
                className={`vcb-opt vcb-add${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)} onClick={() => choose(r)}
              >
                <span className="vcb-name">+ Add Vendor</span>
              </div>
            );
          }
          return null;
        })}
      </div>
      <span className="vcb-sr" role="status" aria-live="polite">{status}</span>
    </div>,
    document.body,
  ) : null;

  return (
    <span
      ref={wrapRef}
      className={`combo vcb${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      onBlur={(e) => { if (e.currentTarget.contains(e.relatedTarget)) return; if (open) close(); }}
    >
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-describedby={describedBy}
        aria-busy={loading || undefined}
        disabled={disabled}
        placeholder={loading ? 'Loading vendors...' : placeholder}
        value={open ? query : shown}
        onChange={(e) => { setQuery(e.target.value); setActive(0); if (!open) setOpen(true); }}
        onMouseDown={() => { if (!open) openList(); }}
        onFocus={() => { if (!open && !disabled) openList(); }}
        onKeyDown={onKeyDown}
      />
      {!disabled && !!value && (
        <button
          type="button" className="combo-clear" tabIndex={-1} aria-label="Clear the vendor"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onClear && onClear(); close(); inputRef.current && inputRef.current.focus(); }}
        >
          x
        </button>
      )}
      <span className="combo-caret" aria-hidden="true" />
      {list}
    </span>
  );
});

export default VendorCombobox;
