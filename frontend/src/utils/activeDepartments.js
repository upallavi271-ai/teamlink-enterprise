import { useEffect, useState } from 'react';
import api from '../api';
import { MASTERS_CHANGED } from './masters';

// ---------------------------------------------------------------------------
// ONLY THE DEPARTMENTS IN "DEPARTMENT & TEAM" THAT ARE SWITCHED ON.
//
// Founder, 2026-10-28: "Recruitment is not a department, yet the dropdown
// shows it. Show only what is in Department & Team; what I switched off must
// not show." Many screens build their department options from the DATA (the
// department written on each employee / record), so an old name like
// "Recruitment" leaked into "All departments" lists.
//
// GET /api/masters/departments answers the switched-on master names. Every
// <Combo> that is a department dropdown (components/Combo.jsx) cuts its
// options to them, and other department pickers (chips, checklists) can use
// useActiveDepartments() + isActiveDepartment() directly.
//
// This only decides what a list OFFERS: a record keeps its stored department,
// a filter already set to an old value keeps working, and the value already
// chosen always stays visible.
// ---------------------------------------------------------------------------

const STALE_MS = 30000;
let names = null; // Set of lower-case active department names, null = unknown
let at = 0;
let key = '';
let inflight = null;
const subs = new Set();

function loginKey() {
  try { return sessionStorage.getItem('tl_viewas_token') || localStorage.getItem('tl_token') || ''; } catch { return ''; }
}

export const deptKey = (v) => String(v == null ? '' : v).trim().toLowerCase();

export function loadActiveDepartments(force = false) {
  const k = loginKey();
  if (k !== key) { names = null; at = 0; key = k; }
  if (!k) return Promise.resolve(names);
  if (!force && Date.now() - at < STALE_MS) return Promise.resolve(names);
  if (!inflight) {
    inflight = api.get('/masters/departments')
      .then((res) => {
        const list = res && res.data && Array.isArray(res.data.departments) ? res.data.departments : null;
        // An empty master means "not set up yet": filter nothing.
        const next = list && list.length ? new Set(list.map(deptKey)) : null;
        const changed = String(next ? [...next] : '') !== String(names ? [...names] : '');
        names = next;
        if (changed) subs.forEach((fn) => { try { fn(names); } catch { /* one screen's error is its own */ } });
        return names;
      })
      .catch(() => names) // a portal login cannot read it: filter nothing
      .finally(() => { at = Date.now(); inflight = null; });
  }
  return inflight;
}

let wired = false;
function wire() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  // Department & Team saves call invalidateMasters(), which fires this.
  window.addEventListener(MASTERS_CHANGED, () => { if (subs.size) loadActiveDepartments(true); });
  window.addEventListener('focus', () => { if (subs.size && Date.now() - at >= STALE_MS) loadActiveDepartments(true); });
}

// Set of lower-case active names, or null while unknown (= show everything).
// `enabled` false = no request, no subscription (Combo calls it always).
export function useActiveDepartments(enabled = true) {
  const [set, setSet] = useState(() => (enabled && key === loginKey() ? names : null));
  useEffect(() => {
    if (!enabled) return undefined;
    wire();
    subs.add(setSet);
    loadActiveDepartments().then((s) => setSet(s));
    return () => { subs.delete(setSet); };
  }, [enabled]);
  return enabled ? set : null;
}

// "No department", "__none__", "Not recorded" … are the nobody's-department
// bucket, not a department name: they stay in a list.
// ("No department on file (3)", "Not recorded", "Unassigned", "—").
const NOT_A_DEPT = /^(__\w+__$|no\s|not\s|without\s|unassigned|none$|other$|others$|—|-$|\(none\)|\(blank\)|blank$)/i;

// The department name inside an option label: "Medical (12)", "Medical · 12",
// "Medical — 3 people", "Medical: 4" -> "medical".
export function deptBase(label) {
  return deptKey(String(label == null ? '' : label)
    .replace(/\s*[([][^)\]]*[)\]]\s*$/, '')
    .replace(/\s+[·•—–|]\s+.*$/, '')
    .replace(/\s+-\s+\d.*$/, '')
    .replace(/\s*:\s*\d.*$/, '')
    .replace(/\s+\d[\d,]*$/, ''));
}

// Is this option (value / label) allowed in a department list?
export function isActiveDepartment(set, value, label) {
  if (!set) return true;
  const v = String(value == null ? '' : value).trim();
  const l = String(label == null ? '' : label).trim();
  if (!v && !l) return true;
  if (set.has(deptKey(v)) || set.has(deptKey(l)) || set.has(deptBase(l)) || set.has(deptBase(v))) return true;
  return NOT_A_DEPT.test(v) || NOT_A_DEPT.test(l) || NOT_A_DEPT.test(deptBase(l));
}

// Cut a list to active departments, keeping the value(s) already chosen.
//   keepActive(set, rows, (r) => r.name, form.department)
export function keepActive(set, list, get = (x) => x, ...current) {
  if (!set) return list || [];
  const keep = new Set(current.flat().map(deptKey).filter(Boolean));
  return (list || []).filter((x) => {
    const n = get(x);
    return keep.has(deptKey(n)) || isActiveDepartment(set, n, n);
  });
}
