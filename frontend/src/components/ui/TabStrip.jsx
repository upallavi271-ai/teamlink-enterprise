import { useEffect, useId, useRef, useState } from 'react';
import { t as tr } from '../../i18n.jsx'; // Telugu / Hindi when chosen (market wave 13.06)
import './TabStrip.css';

// ---------------------------------------------------------------------------
// ONE TAB STRIP FOR THE ATS (founder 2026-11-20): a few main tabs, the rarely
// used ones under "More", and ONE line under the strip that says what the open
// tab is for. Every tab also carries a `title` tooltip.
//
//   <TabStrip label="Candidates views" tabs={[{ key, label, hint, say, count, more }]}
//             value={tab} onChange={setTab} />
//
//   hint   the tooltip (what the tab is for)
//   say    the caption line under the strip while this tab is open (default: hint)
//   count  a number drawn on the tab (never a bare zero)
//   more   true = it sits under the "More" button
//   badge  a number drawn on "More" for an item inside it (e.g. duplicates waiting)
//   hideZero  a tab with count 0 is not drawn, except the open one (as StatusTabs did)
//
// Keyboard: Left / Right / Home / End move between tabs (roving tabindex);
// "More" opens a menu with Up / Down / Escape. ARIA: tablist > tab, the caption
// describes the open tab, the More button is a menu button.
// ---------------------------------------------------------------------------
//   note      the caption when the open tab says nothing of its own (what this strip is for)
//   maxMain   at most this many main tabs: the rest go under More (a tab keyed 'all' stays a main tab)
export default function TabStrip({
  tabs = [], value, onChange, label = 'Tabs', hideZero = false, extra = null, className = '',
  moreLabel = 'More', caption = true, small = false, note = '', maxMain = 0,
}) {
  const uid = useId().replace(/:/g, '');
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const list = useRef(null);
  const menuRef = useRef(null);

  const shown = tabs.filter((t) => !t.hidden
    && (!hideZero || t.key === value || t.count === undefined || t.count === null || Number(t.count) > 0));
  let main = shown.filter((t) => !t.more);
  let more = shown.filter((t) => t.more);
  if (maxMain > 0 && main.length > maxMain) {
    // too many: the first ones (and All) stay, the rest move under More, in their own order
    const pinned = main.filter((t) => t.key === 'all');
    const keep = new Set([...pinned, ...main.filter((t) => t.key !== 'all').slice(0, Math.max(0, maxMain - pinned.length))]);
    more = [...main.filter((t) => !keep.has(t)), ...more];
    main = main.filter((t) => keep.has(t));
  }
  const active = shown.find((t) => t.key === value) || null;
  const activeInMore = !!(active && more.includes(active));
  const moreBadge = more.reduce((n, t) => n + (Number(t.badge) > 0 ? Number(t.badge) : 0), 0);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (!shown.length) return null;
  const nf = (n) => Number(n).toLocaleString('en-IN');

  // A tab is reached with the arrow keys; the open one is the only tab stop.
  const tabStop = main.some((t) => t.key === value) ? value : (main[0] && main[0].key);
  function onTabKey(e, i) {
    const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: main.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const n = (keys[e.key] + main.length) % main.length;
    const el = list.current && list.current.querySelectorAll('[role="tab"]')[n];
    if (el) el.focus();
  }
  function onMoreKey(e) {
    if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); return; }
    if (['ArrowDown', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
      setTimeout(() => { const f = menuRef.current && menuRef.current.querySelector('[role="menuitem"]'); if (f) f.focus(); }, 0);
    }
  }
  function onMenuKey(e) {
    const items = menuRef.current ? [...menuRef.current.querySelectorAll('[role="menuitem"]')] : [];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); const b = wrap.current && wrap.current.querySelector('.tabstrip-more'); if (b) b.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) items[(at + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) items[(at - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Tab') setOpen(false);
  }
  const pick = (k) => { setOpen(false); if (k !== value) onChange(k); };

  const capText = (active && (active.say || active.hint)) || note || '';
  // every tab has a tooltip: its own words, else the strip's note
  const tipOf = (t) => t.hint || t.say || (note ? `${t.label}: ${note}` : undefined);
  return (
    <div className={`tabstrip${small ? ' tabstrip-sm' : ''} ${className}`} ref={wrap}>
      <div className="tabstrip-row">
        <div className="tabs tabstrip-tabs" role="tablist" aria-label={label} ref={list}>
          {main.map((t, i) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`ts-${uid}-${t.key}`}
              data-tab={t.key}
              aria-selected={value === t.key}
              aria-describedby={value === t.key && caption ? `ts-${uid}-cap` : undefined}
              tabIndex={tabStop === t.key ? 0 : -1}
              className={`tab${value === t.key ? ' active' : ''}${t.tone ? ` tone-${t.tone}` : ''}`}
              title={tipOf(t)}
              onClick={() => onChange(t.key)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {typeof t.label === 'string' ? tr(t.label) : t.label}
              {t.count !== undefined && t.count !== null && Number(t.count) > 0 && <span className="n">{nf(t.count)}</span>}
            </button>
          ))}
        </div>
        {more.length > 0 && (
          <div className="tabstrip-moreWrap">
            <button
              type="button"
              className={`tabstrip-more${activeInMore ? ' active' : ''}`}
              aria-haspopup="menu"
              aria-expanded={open}
              title={`${moreLabel}: ${more.map((t) => t.label).join(', ')}`}
              onClick={() => setOpen((o) => !o)}
              onKeyDown={onMoreKey}
            >
              {activeInMore ? `${moreLabel}: ${active.label}` : moreLabel}
              {moreBadge > 0 && <span className="n has-badge">{nf(moreBadge)}</span>}
              <span aria-hidden="true" className="tabstrip-caret">▾</span>
            </button>
            {open && (
              <div className="tabstrip-menu" role="menu" aria-label={`${label}: ${moreLabel}`} ref={menuRef} onKeyDown={onMenuKey}>
                {more.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="menuitem"
                    data-tab={t.key}
                    aria-current={value === t.key ? 'page' : undefined}
                    className={value === t.key ? 'is-on' : ''}
                    title={tipOf(t)}
                    onClick={() => pick(t.key)}
                  >
                    <span>{typeof t.label === 'string' ? tr(t.label) : t.label}</span>
                    {t.count !== undefined && t.count !== null && Number(t.count) > 0 && <span className="n">{nf(t.count)}</span>}
                    {Number(t.badge) > 0 && <span className="n has-badge">{nf(t.badge)}</span>}
                    {(t.say || t.hint) && <small>{t.say || t.hint}</small>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {extra && <div className="tabstrip-extra">{extra}</div>}
      </div>
      {caption && capText && <div className="tabstrip-cap small-muted" id={`ts-${uid}-cap`} role="note">{capText}</div>}
    </div>
  );
}
