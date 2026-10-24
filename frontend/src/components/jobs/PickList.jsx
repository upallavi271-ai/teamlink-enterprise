import { useId, useMemo, useState } from 'react';
import './tlChecklist.css';

// ---------------------------------------------------------------------------
// ONE compact "tick people" box, shared by TlChecklist and RecruiterChecklist (2026-10-14, "keep it clear").
//   picked strip (chips: name, Main tag, star = make main, x = remove) -> search + 2 small text buttons -> one-line rows grouped
//   by team/department (slim header: chevron, group tick, name, count). Groups start OPEN for <= 12 people, CLOSED above that
//   (groups holding a picked person start open). A search opens every group. One inner scroll only (max 320 px) with a shadow.
// groups: [{ key, label, tag?, total, rows: [{ id, name, sub?, badges?: [{ text, tone }], main? }] }]  (rows already filtered)
// picked: [{ id, name }] in order (first = main)
// ---------------------------------------------------------------------------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function PickList({
  noun, nounPlural, picked, groups, allCount, query, onQuery, onToggle, onToggleGroup, onSelectShown, onClear, onMakeMain,
  disabled = false, loading = false, note = '', searchPlaceholder, groupAria, emptyText, mainLabel,
}) {
  const uid = useId();
  const [open, setOpen] = useState({});
  const searching = !!query.trim();
  const pickedSet = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);
  const many = allCount > 12 || allCount + groups.length > 9; // would not fit in ~320 px: start closed
  const isOpen = (g) => {
    if (open[g.key] !== undefined) return open[g.key];
    if (searching || !many) return true;
    return g.rows.some((r) => pickedSet.has(r.id));
  };
  const shownIds = groups.flatMap((g) => g.rows.map((r) => r.id));
  const scrolls = groups.reduce((n, g) => n + (isOpen(g) ? g.rows.length : 0) + 1, 0) > 8;

  return (
    <div className={`tlc${disabled ? ' is-off' : ''}`}>
      <div className="tlc-picked" aria-live="polite">
        {picked.length === 0 && <span className="tlc-none">None picked yet</span>}
        {picked.map((p, i) => (
          <span key={p.id} className={`tlc-chip${i === 0 ? ' is-main' : ''}`}>
            <span className="tlc-chip-n">{p.name}</span>
            {i === 0 && <em className="tlc-main">Main</em>}
            {i > 0 && !disabled && (
              <button type="button" className="tlc-mk" onClick={() => onMakeMain(p.id)} aria-label={`Make ${p.name} the main ${noun}`} title="Make main">☆</button>
            )}
            {!disabled && <button type="button" className="tlc-x" aria-label={`Remove ${p.name}`} onClick={() => onToggle(p.id)}>×</button>}
          </span>
        ))}
        {picked.length > 0 && <small className="tlc-count">{`${picked.length} picked`}</small>}
      </div>
      {!disabled && (
        <>
          <div className="tlc-tools">
            <input className="tlc-search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={searchPlaceholder} aria-label={`Search ${nounPlural}`} />
            <button type="button" className="tlc-link" disabled={!shownIds.length} onClick={() => onSelectShown(shownIds)}>Select all shown</button>
            <button type="button" className="tlc-link" disabled={!picked.length} onClick={onClear}>Clear</button>
          </div>
          {note && <div className="tlc-note" role="alert">{note}</div>}
          <div className={`tlc-list${scrolls ? ' is-long' : ''}`} role="group" aria-label={mainLabel}>
            {loading && <div className="tlc-empty">{`Loading ${nounPlural}…`}</div>}
            {!loading && groups.length === 0 && <div className="tlc-empty">{emptyText}</div>}
            {groups.map((g, gi) => {
              const ids = g.rows.map((r) => r.id);
              const n = ids.filter((id) => pickedSet.has(id)).length;
              const expanded = isOpen(g);
              const hid = `${uid}-${gi}`;
              return (
                <div key={g.key} className="tlc-grp" role="group" aria-labelledby={hid}>
                  <div className="tlc-head">
                    <button type="button" className={`tlc-chev${expanded ? ' is-open' : ''}`} aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} ${g.label}`} onClick={() => setOpen({ ...open, [g.key]: !expanded })}>
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                    <label className="tlc-headlab" title="Select team">
                      <input
                        type="checkbox"
                        checked={n === ids.length && n > 0}
                        ref={(el) => { if (el) el.indeterminate = n > 0 && n < ids.length; }}
                        onChange={() => onToggleGroup(g.rows)}
                        aria-label={groupAria(g.label)}
                      />
                      <b id={hid}>{g.label}</b>
                      <span className="tlc-gcount">{`(${g.total})`}</span>
                    </label>
                    {g.tag && <span className="tlc-own">{g.tag}</span>}
                    {n > 0 && <span className="tlc-gn">{`${n} picked`}</span>}
                  </div>
                  {expanded && (
                    <div className="tlc-members">
                      {g.rows.map((r) => {
                        const on = pickedSet.has(r.id);
                        return (
                          <label key={r.id} className={`tlc-row${on ? ' on' : ''}`} title={r.sub || undefined}>
                            <input type="checkbox" checked={on} onChange={() => onToggle(r.id)} />
                            <span className="tlc-nm">{r.name}</span>
                            {r.sub && <span className="tlc-sub">{r.sub}</span>}
                            <span className="tlc-badges">
                              {(r.badges || []).map((b) => <span key={b.text} className={`tlc-b${b.tone ? ` is-${b.tone}` : ''}`}>{b.text}</span>)}
                              {on && r.main && <em className="tlc-main">Main</em>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export { plural };
