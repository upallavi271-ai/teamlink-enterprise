import { useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// WHATSAPP QUICK CHAT (free wa.me links): the shared bits. NOTHING is sent by TeamLink: the person's own browser opens wa.me.
//   useWaConfig()   { loaded, ready, settings, gates, ... }   what this login may do (cached for a minute); gates[type].ok decides if a button shows
//   openWa(link)    opens the wa.me link in a NEW tab (noopener, noreferrer) - must be called straight from a click
// ---------------------------------------------------------------------------
let cache = null;
let cacheAt = 0;
let inflight = null;
const listeners = new Set();

export function refreshWaConfig() {
  cache = null; cacheAt = 0; inflight = null;
  return loadWaConfig(true);
}
function loadWaConfig(force) {
  if (!force && cache && Date.now() - cacheAt < 60000) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api.get('/wa/config').then((r) => ({ loaded: true, ...r.data }))
    .catch(() => ({ loaded: true, ready: false, gates: {}, settings: { enabled: false } }))
    .then((v) => { cache = v; cacheAt = Date.now(); inflight = null; listeners.forEach((fn) => fn(v)); return v; });
  return inflight;
}
export function useWaConfig() {
  const [v, setV] = useState(cache || { loaded: false, ready: false, gates: {}, settings: { enabled: false } });
  useEffect(() => {
    let live = true;
    const fn = (x) => { if (live) setV(x); };
    listeners.add(fn);
    loadWaConfig(false).then(fn);
    return () => { live = false; listeners.delete(fn); };
  }, []);
  return v;
}
export const waMayUse = (cfg, type) => !!(cfg && cfg.loaded && cfg.ready && cfg.settings && cfg.settings.enabled && cfg.gates && cfg.gates[type] && cfg.gates[type].ok);

export function openWa(link) {
  // a plain new tab, the opener is cut so WhatsApp's page can never reach back into TeamLink
  const w = window.open(link, '_blank', 'noopener,noreferrer');
  return !!w || w === null; // with noopener the handle is always null: a blocked popup cannot be told apart here
}

let tplCache = null;
export async function loadWaTemplates(force) {
  if (!force && tplCache && Date.now() - tplCache.at < 30000) return tplCache.list;
  const r = await api.get('/wa/templates');
  tplCache = { at: Date.now(), list: r.data.templates || [] };
  return tplCache.list;
}
export const clearWaTemplateCache = () => { tplCache = null; };
export const errText = (e, fallback) => (e && e.response && e.response.data && e.response.data.error) || fallback;
export const WA_ICON = '🟢';
