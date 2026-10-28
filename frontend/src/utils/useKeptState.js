// ---------------------------------------------------------------------------
// A LIST SCREEN REMEMBERS WHERE YOU LEFT IT (founder, 27 Oct, Accounts).
//
// Search in Invoices, open Bank & Reconciliation, come back: the search, the
// filters, the sort, the page and the tab are still there. Each screen keeps
// its OWN copy under its own key, so the Invoices search never shows up in
// Bank and the other way round.
//
//   const [filters, setFilters] = useKeptState('invoices.filters', BLANK);
//   // a drop-in for useState: same [value, setValue]
//
// WHAT IS KEPT, AND WHERE
//   * Only what the person typed or picked to SHAPE the list: search words,
//     filter picks, dates, sort, page, page size, the open tab. Never a row,
//     never an amount, never a bank number — callers pass only those values.
//     As a second guard, any text with nine or more digits in a row (an
//     account or card number) is not written at all.
//   * sessionStorage (this browser tab only, gone when the tab closes), keyed
//     by the signed-in user's id: tl.keep.<userId>.<key>. Another login in the
//     same tab never sees it.
//   * clearKeptState() removes every key; AuthContext calls it on sign-out.
//
// A refresh brings the screen back as it was; Back / Forward land on the
// screen as it was left. A saved value that no longer has the shape of the
// starting value (a field renamed in a later release) falls back to the start.
// Nothing is cleared except by the screen's own Clear / Reset, which simply
// sets the starting value again.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const PREFIX = 'tl.keep.';
const LONG_DIGITS = /\d{9,}/;

const kind = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);

// The saved value, if it still fits the shape of the starting one.
function fit(saved, init) {
  if (saved === undefined) return init;
  const k = kind(init);
  if (k === 'null' || k === 'undefined') return saved;
  if (kind(saved) !== k) return init;
  if (k !== 'object') return saved;
  // An open-ended filter object ({} to start with): keep its plain values.
  if (!Object.keys(init).length) {
    return Object.fromEntries(Object.entries(saved).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)));
  }
  // Field by field: a known field keeps its saved value only when it is of
  // the same kind; a field the starting value does not have is dropped.
  const out = { ...init };
  Object.keys(init).forEach((f) => {
    if (!(f in saved)) return;
    const a = kind(init[f]);
    if (a === 'null' || a === 'undefined' || a === kind(saved[f])) out[f] = saved[f];
  });
  return out;
}

const tooPrivate = (v) => {
  if (typeof v === 'string') return LONG_DIGITS.test(v);
  if (v && typeof v === 'object') return Object.values(v).some(tooPrivate);
  return false;
};

function read(full) {
  try {
    const s = sessionStorage.getItem(full);
    return s == null ? undefined : JSON.parse(s);
  } catch { return undefined; }
}
function write(full, v) {
  try {
    if (v === undefined || tooPrivate(v)) sessionStorage.removeItem(full);
    else sessionStorage.setItem(full, JSON.stringify(v));
  } catch { /* storage blocked: the screen still works, it just forgets */ }
}

function useKeyFor(key) {
  const uid = useAuth()?.user?.id;
  return key && uid ? `${PREFIX}${uid}.${key}` : '';
}

// useState that survives leaving the screen. `key` falsy = plain useState.
// `fresh` true = start from `initial` this time (a link that says exactly what
// to show) — the value is still kept from then on.
export function useKeptState(key, initial, fresh = false) {
  const full = useKeyFor(key);
  const [value, setValue] = useState(() => {
    const init = typeof initial === 'function' ? initial() : initial;
    return full && !fresh ? fit(read(full), init) : init;
  });
  useEffect(() => { if (full) write(full, value); }, [full, value]);
  return [value, setValue];
}

// The same for a screen that keeps its state in the address (?bankId&page…):
// arriving with none of `names` in the address puts the kept ones back (in
// place, no extra history step); every change of them is kept. `fresh` true =
// do not put anything back this time (a link that says what to show).
export function useKeptParams(key, names, fresh = false) {
  const full = useKeyFor(key);
  const [sp, setSp] = useSearchParams();
  const restored = useRef(false);
  const skip = useRef(false); // the address is being put back: do not save the empty one first
  const list = names.join('|');
  useEffect(() => {
    if (!full || restored.current) return;
    restored.current = true;
    if (fresh || names.some((n) => sp.has(n))) return;
    const saved = read(full);
    if (!saved || typeof saved !== 'object') return;
    const back = names.filter((n) => typeof saved[n] === 'string' && saved[n] !== '');
    if (!back.length) return;
    skip.current = true;
    setSp((cur) => { const n = new URLSearchParams(cur); back.forEach((k) => n.set(k, saved[k])); return n; }, { replace: true });
  }, [full]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = names.map((n) => sp.get(n) || '').join('|');
  useEffect(() => {
    if (!full || !restored.current) return;
    if (skip.current) { skip.current = false; return; }
    write(full, Object.fromEntries(names.map((n) => [n, sp.get(n) || ''])));
  }, [full, now, list]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Sign-out: every kept list state of every login in this tab goes.
export function clearKeptState() {
  try {
    const gone = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(PREFIX)) gone.push(k);
    }
    gone.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* nothing stored */ }
}
