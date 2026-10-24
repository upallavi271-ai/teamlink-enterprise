import api from '../api';
import { registerClientAliases } from './searchMatch.js';
import { registerClientPlaces } from '../utils/clientLocation.js'; // "Name - Location" for clients that share a name (2026-10-22)

// ---------------------------------------------------------------------------
// OLD CLIENT NAMES FOR TYPE-TO-SEARCH (2026-10-17).
// Every client is listed under its OFFICIAL legal name. The names it was known by before are kept on the server
// (ClientAlias). This loads them once (GET /clients/aliases: only the clients this login may see by name) and hands
// them to components/searchMatch.js, so typing an old name in ANY dropdown / search box finds the client.
// Nothing here is ever shown: the boxes keep showing the official name.
// Called from the Shell after sign-in; reloads at most every 5 minutes when the tab comes back.
// ---------------------------------------------------------------------------
let loadedAt = 0;
let inflight = null;

export function loadClientAliases({ force = false } = {}) {
  if (!force && Date.now() - loadedAt < 5 * 60 * 1000) return Promise.resolve();
  if (inflight) return inflight;
  inflight = api.get('/clients/aliases')
    .then((res) => { registerClientAliases((res.data && res.data.rows) || []); registerClientPlaces((res.data && res.data.places) || []); loadedAt = Date.now(); })
    .catch(() => { /* no list of old names: the boxes just match official names */ })
    .finally(() => { inflight = null; });
  return inflight;
}

export function forgetClientAliases() {
  loadedAt = 0;
  registerClientAliases([]);
  registerClientPlaces([]);
}
