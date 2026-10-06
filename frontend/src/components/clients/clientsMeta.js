import { useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// GET /clients/meta — what the Clients screens draw for THIS login (clients
// role spec §1–§4, §7, §8): role, default view, list columns / filters, the
// top and row buttons, the agreement-expiry alert. One call per login per
// page load; the server decides every flag from the same can() / role rules
// its data routes enforce.
// ---------------------------------------------------------------------------
const cache = new Map();

export function loadClientsMeta(userId, { fresh = false } = {}) {
  const key = userId || 'anon';
  if (fresh) cache.delete(key);
  if (!cache.has(key)) {
    const p = api.get('/clients/meta').then((r) => r.data);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}

export function useClientsMeta(user, enabled = true) {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || !user) return undefined;
    let live = true;
    loadClientsMeta(user.id)
      .then((m) => { if (live) setMeta(m); })
      .catch((err) => { if (live) setError(err.response?.data?.error || 'Could not load this page. Please try again.'); });
    return () => { live = false; };
  }, [user?.id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { meta, error, refresh: () => loadClientsMeta(user?.id, { fresh: true }).then(setMeta) };
}

// §8.1 — the health badge colours (green / yellow / red).
export const HEALTH_TONE = { active: 'green', quiet: 'amber', dormant: 'red' };
export const HEALTH_HINT = {
  active: 'Worked on in the last 30 days',
  quiet: 'Quiet for 30+ days. Follow up.',
  dormant: 'Quiet for 90+ days.',
};
