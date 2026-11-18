import { useEffect, useState } from 'react';
import api from '../api';

// ONE PIPELINE PER INDUSTRY (2026-11-18, backend utils/deptPipelines.js): which steps a department uses. The server refuses a move into a
// step the department does not use; this only keeps the screens from OFFERING it. Read once and kept for a minute.
let cache = null; let loadedAt = 0; let inflight = null;

export function loadPipelines({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - loadedAt < 60000) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.get('/ats/pipelines').then((r) => { cache = r.data; loadedAt = Date.now(); return cache; })
      .catch(() => cache).finally(() => { inflight = null; });
  }
  return inflight;
}

export function usePipelines() {
  const [p, setP] = useState(cache);
  useEffect(() => { let live = true; loadPipelines().then((d) => { if (live && d) setP(d); }); return () => { live = false; }; }, []);
  return p;
}

// true when the department uses this step (or nothing is known: then everything is offered, as before)
export function stageUsed(p, department, code) {
  if (!p || !department || !p.pipelines) return true;
  const dept = (p.aliases && p.aliases[department]) || department;
  const row = p.pipelines[dept] && p.pipelines[dept][code];
  return !row || row.enabled !== false;
}
