import { useEffect, useState } from 'react';
import api from '../api';

// ---------------------------------------------------------------------------
// THE LIVE MASTER LISTS — "when a role is added, it must automatically appear
// in the dropdowns" (the user's rule, 2026-09-29).
//
// ONE client-side reader of GET /api/masters (backend utils/masters.js). Any
// dropdown or filter offering roles, designations, departments, teams,
// branches, locations, employment statuses / types, genders, blood groups,
// address types, experience or shifts reads it here instead of a hard-coded
// array:
//
//   const m = useMasters();          // null until the first answer lands
//   (m?.departments || []).map(...)
//   withCurrent(m?.branches, form.branch)   // keep a record's own value
//
// Shape: { roles: [{code,name,isSystem,products}], designations: [..],
//   departments: [..], teams: [{name,department}], teamNames: [..],
//   branches, locations, employmentStatuses, employmentTypes, genders,
//   bloodGroups, addressTypes, experience, shifts, version }
//
// Freshness: one module-level cache shared by every screen. It is re-read
//   - when the window regains focus and the copy is older than 60 s, and
//   - immediately when invalidateMasters() runs (dispatches
//     'tl:masters-changed') — call it after any save on a master screen
//     (Role Catalog, custom roles, Departments & Teams, designation mapping).
// The server answers a revalidation with a weak ETag, so a re-read that finds
// nothing changed is cheap.
// ---------------------------------------------------------------------------

export const MASTERS_CHANGED = 'tl:masters-changed';
const STALE_MS = 60000;
const STORAGE_PING = 'tl_masters_changed';

let cache = null; // the last answer
let cacheAt = 0;
let cacheKey = ''; // the login the cache belongs to
let inflight = null;
const subscribers = new Set();

function loginKey() {
  try { return sessionStorage.getItem('tl_viewas_token') || localStorage.getItem('tl_token') || ''; } catch { return ''; }
}

function publish() {
  subscribers.forEach((fn) => { try { fn(cache); } catch { /* one screen's error is its own */ } });
}

// Fetch (or join the fetch already on its way). `force` skips the freshness check.
export function loadMasters(force = false) {
  const key = loginKey();
  if (key !== cacheKey) { cache = null; cacheAt = 0; cacheKey = key; }
  if (!force && cache && Date.now() - cacheAt < STALE_MS) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.get('/masters')
      .then((res) => {
        const changed = !cache || !res.data || res.data.version !== cache.version;
        if (res.data && typeof res.data === 'object') cache = res.data;
        cacheAt = Date.now();
        if (changed) publish();
        return cache;
      })
      .catch(() => cache)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Drop the cache and tell every mounted useMasters() to re-read now.
export function invalidateMasters() {
  cacheAt = 0;
  try { window.dispatchEvent(new CustomEvent(MASTERS_CHANGED)); } catch { /* no window */ }
  // Other open tabs hear it through the storage event.
  try { localStorage.setItem(STORAGE_PING, String(Date.now())); } catch { /* no storage */ }
}

// One set of window listeners for the whole app, attached on first use.
let wired = false;
function wire() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener(MASTERS_CHANGED, () => { if (subscribers.size) loadMasters(true); });
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_PING && subscribers.size) { cacheAt = 0; loadMasters(true); }
  });
  window.addEventListener('focus', () => {
    if (subscribers.size && Date.now() - cacheAt >= STALE_MS) loadMasters(true);
  });
}

export function useMasters() {
  const [data, setData] = useState(() => (cache && cacheKey === loginKey() ? cache : null));
  useEffect(() => {
    wire();
    const fn = (next) => setData(next);
    subscribers.add(fn);
    loadMasters().then((m) => { if (m) setData(m); });
    return () => { subscribers.delete(fn); };
  }, []);
  return data;
}

// A master list plus the value(s) already on the record, so an edit never
// silently drops a legacy value that is no longer (or not yet) in the master.
export function withCurrent(list, ...current) {
  const out = [...(list || [])];
  current.flat().forEach((v) => {
    const s = v == null ? '' : String(v).trim();
    if (s && !out.some((x) => String(x).toLowerCase() === s.toLowerCase())) out.push(s);
  });
  return out;
}
