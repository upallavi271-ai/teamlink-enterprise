// ---------------------------------------------------------------------------
// The server's stage names and sub-statuses (GET /api/ats/stage-labels), read once per sign-in and kept here.
// Admin renames a stage in Company Setup -> Pipeline & checks; this writes the new words into atsVocab's STAGE_LABELS
// (applyStageLabels), so every screen that names a stage shows them. Sub-statuses: the chip next to a stage.
//   loadStageLabels({ fresh })  -> Promise<payload>   (one request at a time; cached)
//   subStatusesOf(stage)        -> [{ id, label, order }]
//   onStageLabels(fn)           -> unsubscribe        (called after every load)
// ---------------------------------------------------------------------------
import api from '../api';
import { applyStageLabels } from '../atsVocab';

let cache = null;
let pending = null;
const listeners = new Set();

export function loadStageLabels({ fresh = false } = {}) {
  if (cache && !fresh) return Promise.resolve(cache);
  if (pending) return pending;
  pending = api.get('/ats/stage-labels')
    .then((r) => {
      cache = r.data || {};
      applyStageLabels(cache.labels || {});
      listeners.forEach((fn) => { try { fn(cache); } catch { /* a listener's own problem */ } });
      return cache;
    })
    .catch(() => cache || {})
    .finally(() => { pending = null; });
  return pending;
}
export function subStatusesOf(stage) {
  const list = (cache && cache.subStatuses && cache.subStatuses[stage]) || [];
  return [...list].sort((a, b) => (a.order - b.order) || String(a.label).localeCompare(String(b.label)));
}
export function allSubStatuses() {
  return Object.values((cache && cache.subStatuses) || {}).flat();
}
export function onStageLabels(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function forgetStageLabels() { cache = null; }
