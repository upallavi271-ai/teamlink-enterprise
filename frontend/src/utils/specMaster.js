import { useEffect, useState } from 'react';
import api from '../api';
import {
  LOCS, PRIORITIES, CANDIDATE_SOURCES, CANDIDATE_FIRST_SOURCES, CANDIDATE_FILTER_SOURCES,
  REJECTION_REASONS_BY_SIDE, REJECTION_REASON_CATEGORIES,
} from '../atsVocab';

// ---------------------------------------------------------------------------
// THE ADMIN'S MASTER LISTS, read by every dropdown (spec D + §18, 2026-10-03).
//
//   useSpecTree()        Department -> Qualification -> Specialization
//                        (GET /api/specialisations/tree — active values only,
//                        switched-off departments left out). One read per tab,
//                        shared; refreshSpecTree() after an Admin change.
//   loadListMasters()    Sources, Reject reasons, Priorities, Locations
//                        (GET /api/specialisations/lists). The answer is
//                        copied INTO the existing atsVocab arrays, so every
//                        screen that already reads REJECTION_REASONS_BY_SIDE,
//                        CANDIDATE_SOURCES, PRIORITIES or LOCS offers the
//                        Admin's list without being changed. If the read
//                        fails the built-in lists simply stay.
// ---------------------------------------------------------------------------

let treePromise = null;
const listeners = new Set();
let retryTimer = null;
function fetchTree() {
  treePromise = api.get('/specialisations/tree').then((r) => r.data).catch(() => {
    // The server was restarting: try again shortly instead of keeping "empty".
    if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; refreshSpecTree(); }, 8000);
    return { departments: [] };
  });
  return treePromise;
}
export function refreshSpecTree() {
  fetchTree().then((t) => listeners.forEach((fn) => fn(t)));
}

export function useSpecTree() {
  const [tree, setTree] = useState(null);
  useEffect(() => {
    let live = true;
    const fn = (t) => { if (live) setTree(t); };
    listeners.add(fn);
    (treePromise || fetchTree()).then(fn);
    return () => { live = false; listeners.delete(fn); };
  }, []);
  return tree;
}

// The options for one department (by name, case-insensitive).
export function deptOptionsOf(tree, departmentName) {
  const d = (tree?.departments || []).find((x) => x.name.toLowerCase() === String(departmentName || '').toLowerCase());
  return d || { qualifications: [], specialisations: [] };
}
export function specName(tree, id) {
  if (!id) return '';
  for (const d of tree?.departments || []) {
    const s = d.specialisations.find((x) => x.id === id);
    if (s) return s.name;
  }
  return '';
}
export function qualName(tree, id) {
  if (!id) return '';
  for (const d of tree?.departments || []) {
    const q = d.qualifications.find((x) => x.id === id);
    if (q) return q.name;
  }
  return '';
}

// --- Sources / Reject reasons / Priorities / Locations ------------------------
const fill = (arr, values) => {
  if (!Array.isArray(values) || !values.length) return;
  arr.splice(0, arr.length, ...values);
};
let listsVersion = null;
export function loadListMasters() {
  return api.get('/specialisations/lists').then((res) => {
    const l = res.data || {};
    if (l.version === listsVersion) return l;
    listsVersion = l.version;
    if (l.version === 'default') return l; // nothing changed by an Admin yet
    fill(CANDIDATE_SOURCES, l.sources);
    fill(CANDIDATE_FIRST_SOURCES, l.sources);
    fill(CANDIDATE_FILTER_SOURCES, l.sources);
    fill(PRIORITIES, l.priorities);
    fill(LOCS, l.locations);
    fill(REJECTION_REASON_CATEGORIES, l.rejectReasons);
    Object.keys(l.rejectReasonsBySide || {}).forEach((side) => {
      if (!REJECTION_REASONS_BY_SIDE[side]) REJECTION_REASONS_BY_SIDE[side] = [];
      fill(REJECTION_REASONS_BY_SIDE[side], l.rejectReasonsBySide[side]);
    });
    return l;
  }).catch(() => {
    // Server restarting: one more try later; until then the built-in lists stay.
    if (!listRetried) { listRetried = true; setTimeout(loadListMasters, 10000); }
    return null;
  });
}
let listRetried = false;
