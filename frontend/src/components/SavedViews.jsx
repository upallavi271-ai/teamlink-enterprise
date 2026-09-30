import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import './SavedViews.css';

// ---------------------------------------------------------------------------
// SAVED VIEWS (ATS review #2 §19) — "Saved Views ▼" + "Save Current View",
// per user. GENERIC: any list page can use it; it knows nothing about the
// page's filters beyond "a plain JSON object".
//
// USAGE
//   import SavedViews from '../components/SavedViews.jsx';
//
//   <SavedViews
//     storageKey="req"                      // one namespace per page ("req", "cand", …)
//     current={{ view, filters, h, sort }}  // the page's CURRENT filter state (plain JSON)
//     onApply={(state) => { … }}            // put a saved / preset state back on the page
//     presets={[                            // optional built-in views (not deletable)
//       { name: 'My Open Requirements', filters: { view: 'open', mine: '1' } },
//     ]}
//   />
//
// - `current` and each preset's `filters` have the SAME shape — whatever the
//   page passes in `current` is what gets saved, and what onApply receives.
//   onApply is called with a deep copy, so the page may mutate it freely.
// - Stored in localStorage under `tl.savedViews.<storageKey>.<userId>` — per
//   user, per page, per browser. Every read/write is wrapped in try/catch: a
//   private window or blocked storage just means no saved views (presets still
//   work), never an error.
// - The view whose state equals `current` is marked as active (✓), so the
//   user can see which view they are on.
// - Saved views can be renamed and deleted; presets cannot.
// - Presets must only ever narrow what the server already scopes to the user
//   (they are filters, not permissions) — the API decides what is visible.
// ---------------------------------------------------------------------------

const keyFor = (storageKey, userId) => `tl.savedViews.${storageKey}.${userId || 'anon'}`;

function readViews(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string' && x.filters && typeof x.filters === 'object') : [];
  } catch { return []; }
}
function writeViews(key, list) {
  try { window.localStorage.setItem(key, JSON.stringify(list)); return true; } catch { return false; }
}

// Stable comparison: key order and empty values ('' / null / undefined /
// empty object) do not make two states different.
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((k) => {
      const v = canon(value[k]);
      const empty = v === '' || v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
      if (!empty) out[k] = v;
    });
    return out;
  }
  return value;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const copy = (v) => JSON.parse(JSON.stringify(v || {}));

export default function SavedViews({ storageKey, current, onApply, presets = [], label = 'Saved Views' }) {
  const { user } = useAuth();
  const key = keyFor(storageKey, user?.id);
  const [views, setViews] = useState(() => readViews(key));
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(null); // { mode: 'new' } | { mode: 'rename', index }
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const ref = useRef(null);

  useEffect(() => { setViews(readViews(key)); }, [key]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setNaming(null); } };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const active = useMemo(() => {
    const p = presets.find((v) => same(v.filters, current));
    if (p) return p.name;
    const s = views.find((v) => same(v.filters, current));
    return s ? s.name : null;
  }, [presets, views, current]);

  const persist = (next) => {
    setViews(next);
    if (!writeViews(key, next)) setMsg('Your browser is not letting this page save views (private window?).');
  };
  const apply = (v) => { onApply(copy(v.filters)); setOpen(false); setNaming(null); };

  function startNew() { setMsg(''); setName(''); setNaming({ mode: 'new' }); }
  function startRename(index) { setMsg(''); setName(views[index].name); setNaming({ mode: 'rename', index }); }
  function commitName(e) {
    e?.preventDefault();
    const n = name.trim().slice(0, 60);
    if (!n) { setMsg('Give the view a name.'); return; }
    const clash = views.findIndex((v) => v.name.toLowerCase() === n.toLowerCase());
    if (naming.mode === 'new') {
      if (presets.some((p) => p.name.toLowerCase() === n.toLowerCase())) { setMsg('That name is a built-in view — pick another.'); return; }
      // Same name again = overwrite that view with the current filters.
      const entry = { name: n, filters: copy(current), savedAt: new Date().toISOString() };
      persist(clash >= 0 ? views.map((v, i) => (i === clash ? entry : v)) : [...views, entry]);
      setMsg(clash >= 0 ? `Updated "${n}".` : `Saved "${n}".`);
    } else {
      if (clash >= 0 && clash !== naming.index) { setMsg('You already have a view with that name.'); return; }
      persist(views.map((v, i) => (i === naming.index ? { ...v, name: n } : v)));
      setMsg('');
    }
    setNaming(null);
  }
  function remove(index) {
    const v = views[index];
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete the saved view "${v.name}"?`)) return;
    persist(views.filter((_, i) => i !== index));
  }

  return (
    <div className="savedviews" ref={ref}>
      <button type="button" className="btn btn-sm btn-ghost savedviews-toggle" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen((o) => !o); setMsg(''); setNaming(null); }}>
        {active ? <>{`${label}: `}<b>{active}</b></> : label}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div className="savedviews-menu" role="menu">
          {presets.length > 0 && (
            <>
              <div className="savedviews-head">Suggested</div>
              {presets.map((v) => (
                <button key={`p-${v.name}`} type="button" role="menuitem" className={`savedviews-item${active === v.name ? ' on' : ''}`} onClick={() => apply(v)} title={v.hint || undefined}>
                  <span className="savedviews-check">{active === v.name ? '✓' : ''}</span>
                  <span className="savedviews-name">{v.name}</span>
                </button>
              ))}
            </>
          )}
          <div className="savedviews-head">My views</div>
          {views.length === 0 && <div className="savedviews-empty">No saved views yet. Set your filters, then Save Current View.</div>}
          {views.map((v, i) => (
            naming && naming.mode === 'rename' && naming.index === i ? (
              <form key={`s-${v.name}`} className="savedviews-form" onSubmit={commitName}>
                <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="New name" />
                <button type="submit" className="btn btn-sm btn-primary">Save</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNaming(null)}>Cancel</button>
              </form>
            ) : (
              <div key={`s-${v.name}`} className={`savedviews-row${active === v.name ? ' on' : ''}`}>
                <button type="button" role="menuitem" className="savedviews-item" onClick={() => apply(v)}>
                  <span className="savedviews-check">{active === v.name ? '✓' : ''}</span>
                  <span className="savedviews-name">{v.name}</span>
                </button>
                <button type="button" className="savedviews-icon" title={`Rename "${v.name}"`} aria-label={`Rename ${v.name}`} onClick={() => startRename(i)}>✎</button>
                <button type="button" className="savedviews-icon danger" title={`Delete "${v.name}"`} aria-label={`Delete ${v.name}`} onClick={() => remove(i)}>×</button>
              </div>
            )
          ))}
          <div className="savedviews-foot">
            {naming && naming.mode === 'new' ? (
              <form className="savedviews-form" onSubmit={commitName}>
                <input autoFocus placeholder="Name this view" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="View name" />
                <button type="submit" className="btn btn-sm btn-primary">Save</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNaming(null)}>Cancel</button>
              </form>
            ) : (
              <button type="button" className="btn btn-sm" onClick={startNew}>+ Save Current View</button>
            )}
            {msg && <div className="savedviews-msg" role="status">{msg}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
