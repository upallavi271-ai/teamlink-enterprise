// ---------------------------------------------------------------------------
// THE CRM WITH NO SIGNAL (CRM wave E, 2026-11-24; gap 14.03). A salesperson in a basement or on the road can still read the CRM lists and
// log what they did; it is sent when the signal comes back.
//
//   READ      every CRM list / record the person opens (and their own sign-in answer, /auth/me) is kept on THIS phone, per login, for 7 days.
//             With no network at all, the kept copy is shown and a bar says "You are offline. Showing the copy saved at 10:42."
//             With a network the server is always asked; the copy is never preferred.
//   WRITE     with no network, "Log it" (a call / meeting / note), "+ Follow-up", "Done" and "Move" on a follow-up and a phone call's outcome are
//             kept in a queue on the phone ("2 changes waiting") and sent in order the moment the network is back. Only when the phone KNEW it
//             was offline before sending: a save that may have reached the server is never sent twice.
//   PRIVACY   only for people who opened the CRM, only while the Admin switch "Offline copy" is on (CRM settings), and wiped at sign-out.
// The app worker (public/tl-app-sw.js) keeps the CRM screen itself so it opens with no signal.
// ---------------------------------------------------------------------------
import api from '../../api';

const PREFIX = 'tl_crm_off:';
const OUTBOX = 'tl_crm_outbox';
const FLAG = 'tl_crm_off_user';
const MAX_ENTRY = 300000;
const MAX_TOTAL = 2500000;
const MAX_AGE = 7 * 86400000;
const READS = [
  /^\/crm\/(me|dashboard|overview|tasks|tasks\/counts|tasks\/calendar|leads|deals|accounts|contacts|invoices|pluse\/plus-settings|pluse\/visits)$/,
  /^\/crm\/(leads|deals|accounts|contacts)\/[^/]+$/,
  /^\/crm\/ai\/insight\/[a-z]+\/[^/]+$/,
  /^\/crm\/pluse\/ai\/(predict|sentiment)\/[a-z]+\/[^/]+$/,
  /^\/crm\/pluse\/calls\/[a-z]+\/[^/]+$/,
];
const WRITES = [/^\/crm\/activities$/, /^\/crm\/tasks$/, /^\/crm\/tasks\/[^/]+\/(done|snooze)$/, /^\/crm\/pluse\/phone-call$/];

const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
  keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
};
const userOfToken = () => {
  const t = ls.get('tl_token');
  if (!t) return null;
  try { const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return p.id || p.sub || null; } catch { return null; }
};
const path = (config) => String(config.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/api(?=\/)/, '').split('?')[0];
const keyOf = (config, user) => {
  const q = config.params ? Object.entries(config.params).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&') : '';
  const inUrl = String(config.url || '').split('?')[1] || '';
  return `${PREFIX}${user}:${path(config)}?${[inUrl, q].filter(Boolean).join('&')}`;
};
const enabledFor = (user) => !!user && ls.get(FLAG) === user;
const isRead = (config) => (config.method || 'get').toLowerCase() === 'get' && (READS.some((re) => re.test(path(config))) || path(config) === '/auth/me');
const isWrite = (config) => ['post', 'put'].includes((config.method || '').toLowerCase()) && WRITES.some((re) => re.test(path(config)));

// ---- the screen's state ------------------------------------------------------------------------------------------------------
const state = { servedFromCopy: false, copyAt: null, failed: [] };
const listeners = new Set();
const tell = () => listeners.forEach((f) => { try { f(); } catch { /* a listener never breaks another */ } });
const outbox = () => { try { return JSON.parse(ls.get(OUTBOX) || '[]').filter((x) => x.user === userOfToken()); } catch { return []; } };
const saveOutbox = (list) => { const others = (() => { try { return JSON.parse(ls.get(OUTBOX) || '[]').filter((x) => x.user !== userOfToken()); } catch { return []; } })(); ls.set(OUTBOX, JSON.stringify([...others, ...list])); };
export const offlineState = () => ({ online: typeof navigator === 'undefined' ? true : navigator.onLine !== false, waiting: outbox().length, failed: state.failed, servedFromCopy: state.servedFromCopy, copyAt: state.copyAt });
export function onOfflineChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ---- the copy --------------------------------------------------------------------------------------------------------------------
function prune() {
  const mine = ls.keys().filter((k) => k.startsWith(PREFIX));
  let total = 0;
  const rows = mine.map((k) => { const v = ls.get(k) || ''; total += v.length; let at = 0; try { at = JSON.parse(v).at || 0; } catch { at = 0; } return { k, at, n: v.length }; }).sort((a, b) => a.at - b.at);
  for (const r of rows) {
    if (total <= MAX_TOTAL && Date.now() - r.at < MAX_AGE) continue; // eslint-disable-line no-continue
    ls.del(r.k); total -= r.n;
  }
}
function keep(config, data) {
  const user = userOfToken();
  if (!enabledFor(user)) return;
  let text;
  try { text = JSON.stringify({ at: Date.now(), data }); } catch { return; }
  if (text.length > MAX_ENTRY) return;
  if (!ls.set(keyOf(config, user), text)) { prune(); ls.set(keyOf(config, user), text); }
}
function copyOf(config) {
  const user = userOfToken();
  if (!enabledFor(user)) return null;
  try { const v = JSON.parse(ls.get(keyOf(config, user)) || 'null'); return v && Date.now() - v.at < MAX_AGE ? v : null; } catch { return null; }
}
const fake = (config, data, status = 200) => ({ data, status, statusText: 'OK', headers: { 'x-tl-offline': '1' }, config, request: {} });
export function clearOfflineCopy() {
  ls.keys().filter((k) => k.startsWith(PREFIX)).forEach((k) => ls.del(k));
  ls.del(OUTBOX); ls.del(FLAG);
  state.servedFromCopy = false; state.failed = []; tell();
}
// called by the CRM screen once it opened: this login uses the CRM, and the Admin allows the copy
export function setOfflineAllowed(allowed) {
  const user = userOfToken();
  if (!user) return;
  if (allowed) ls.set(FLAG, user);
  else clearOfflineCopy();
}

// ---- the queue -------------------------------------------------------------------------------------------------------------------
const QUEUED_ANSWER = { ok: true, queued: true, openFollowUps: [], activity: null, task: null, next: null };
let sending = false;
export async function syncOutbox() {
  if (sending || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  sending = true;
  try {
    let list = outbox();
    while (list.length) {
      const item = list[0];
      try {
        // eslint-disable-next-line no-await-in-loop
        await api.request({ method: item.method, url: item.url, params: item.params, data: item.data, headers: { 'X-TL-Offline-Replay': '1' } });
      } catch (e) {
        if (!e.response || e.response.status >= 500) break; // still no server: try again later
        state.failed = [...state.failed, `${item.label}: ${(e.response.data && e.response.data.error) || `error ${e.response.status}`}`].slice(-5);
      }
      list = list.slice(1); saveOutbox(list); tell();
    }
  } finally { sending = false; tell(); }
}
const labelOf = (config) => { const p = path(config); return /activities/.test(p) ? 'Logged activity' : /done$/.test(p) ? 'Follow-up done' : /snooze$/.test(p) ? 'Follow-up moved' : /phone-call/.test(p) ? 'Phone call' : 'New follow-up'; };

// ---- the hooks on the app's one API client -------------------------------------------------------------------------------------
let installed = false;
export function installOffline() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  api.interceptors.request.use((config) => {
    if (navigator.onLine !== false || config.headers?.['X-TL-Offline-Replay']) return config;
    if (isRead(config)) {
      const c = copyOf(config);
      if (c) { state.servedFromCopy = true; state.copyAt = c.at; setTimeout(tell, 0); return { ...config, adapter: () => Promise.resolve(fake(config, c.data)) }; }
      return config;
    }
    const user = userOfToken();
    if (isWrite(config) && enabledFor(user)) {
      const list = outbox();
      list.push({ user, method: config.method, url: config.url, params: config.params || null, data: config.data && typeof config.data === 'object' ? config.data : (() => { try { return JSON.parse(config.data); } catch { return config.data; } })(), at: Date.now(), label: labelOf(config) });
      saveOutbox(list); setTimeout(tell, 0);
      return { ...config, adapter: () => Promise.resolve(fake(config, { ...QUEUED_ANSWER }, 202)) };
    }
    return config;
  });
  api.interceptors.response.use((res) => {
    const config = res.config || {};
    if (!(res.headers && res.headers['x-tl-offline']) && isRead(config) && res.status === 200) {
      keep(config, res.data);
      if (state.servedFromCopy) { state.servedFromCopy = false; tell(); }
    }
    return res;
  }, (error) => {
    const config = error && error.config;
    // no answer at all (the network dropped though the phone thinks it is online): the kept copy, for reads only
    if (config && !error.response && isRead(config)) {
      const c = copyOf(config);
      if (c) { state.servedFromCopy = true; state.copyAt = c.at; tell(); return fake(config, c.data); }
    }
    return Promise.reject(error);
  });
  window.addEventListener('online', () => { tell(); syncOutbox(); });
  window.addEventListener('offline', tell);
  window.addEventListener('tl-signed-out', clearOfflineCopy);
  setTimeout(() => { if (outbox().length) syncOutbox(); }, 4000);
}
installOffline();
