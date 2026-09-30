import api from '../api';

// ---------------------------------------------------------------------------
// ONE REQUEST FOR IDENTICAL READS THAT ARE IN FLIGHT AT THE SAME TIME.
//
// The dashboards' reads are the heaviest in the app, and the same one used to
// go out twice at once — React's StrictMode runs every effect twice in
// development, and a remount mid-load does the same in production. A caller
// asking for exactly what is already on its way gets that same promise. Nothing
// is cached: the entry is dropped the moment the answer (or error) lands, so
// the next read always goes to the server.
// ---------------------------------------------------------------------------
const inflight = new Map();

export default function sharedGet(url, params) {
  let token = '';
  try { token = localStorage.getItem('tl_token') || ''; } catch { /* no storage */ }
  const key = `${token}|${url}|${JSON.stringify(params || {})}`;
  if (!inflight.has(key)) {
    const request = api.get(url, params ? { params } : undefined)
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
  }
  return inflight.get(key);
}
