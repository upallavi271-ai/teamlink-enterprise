// ---------------------------------------------------------------------------
// BACK LANDS WHERE YOU LEFT IT (founder 2026-10-29: "back to invoice ani click chesanu ... adhey open avvali, starting
// nunchi ravodhu").
//
// useKeptState.js keeps what SHAPES a list (search, filters, page, tab, which rows are open). This keeps the rest of
// "where you were", so Invoices -> a client's Bank statement -> Bank & Reconciliation -> Back -> Back lands on the same
// invoice, the same open rows and the same spot on the page - never the top of the first tab:
//   rememberPlace(key, path) / placeOf(key, fallback)   a screen's own address (/invoices?tab=check) for a Back link
//   keepNote(key, v) / takeNote(key)                    one small note for the way back (which bank line was open)
//   useKeptScroll(key, ready)                           the page's scroll position, put back once its data is shown
// sessionStorage only (this browser tab), every access in try/catch: without it a screen simply starts at the top.
// ---------------------------------------------------------------------------
import { useEffect } from 'react';

const PRE = 'tl.place.';
const read = (k) => { try { return JSON.parse(sessionStorage.getItem(PRE + k) || 'null'); } catch { return null; } };
const write = (k, v) => {
  try {
    if (v == null) sessionStorage.removeItem(PRE + k); else sessionStorage.setItem(PRE + k, JSON.stringify(v));
  } catch { /* storage off: nothing is kept */ }
};

export const rememberPlace = (key, path) => write(`${key}.path`, path);
export const placeOf = (key, fallback) => read(`${key}.path`) || fallback;
export const keepNote = (key, v) => write(`${key}.note`, v);
export const takeNote = (key) => { const v = read(`${key}.note`); write(`${key}.note`, null); return v; };

// Put the window back where it was, trying for a moment while the rows are still being drawn.
export function scrollBack(y) {
  if (!(y > 0)) return () => {};
  let tries = 0; let t;
  const go = () => { window.scrollTo(0, y); if (Math.abs(window.scrollY - y) > 4 && tries++ < 25) t = setTimeout(go, 100); };
  t = setTimeout(go, 30);
  return () => clearTimeout(t);
}

export function useKeptScroll(key, ready) {
  useEffect(() => () => write(`${key}.y`, window.scrollY), [key]); // leaving: remember the spot
  useEffect(() => (ready ? scrollBack(read(`${key}.y`)) : undefined), [key, ready]);
}
