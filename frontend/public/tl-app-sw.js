/*
 * TeamLink app worker (2026-11-17): the part of "TeamLink on your phone" that runs when the app is closed.
 *
 *   1. PHONE ALERTS   a push from the server becomes a notification; tapping it opens (or comes back to) the app on the right screen.
 *   2. OFFLINE PAGE   when a page cannot be reached at all (no signal) the person sees a short "You are offline" page, not the browser's
 *                     dinosaur. Nothing else is stored: no screens, no data, no API answers. TeamLink is always read live from the server.
 *
 * It deliberately does nothing else. It never answers a request from a cache (the site is updated every few minutes and must never show an
 * old screen), and it touches only page loads (navigations): scripts, styles, images and /api calls go straight to the network as if this
 * worker did not exist. It updates itself the moment a new copy is published.
 *
 *   3. THE CRM WITH NO SIGNAL (CRM wave E, 2026-11-24): a /crm page and the script / style files it loads are KEPT after each normal load, and
 *                     used ONLY when the network cannot be reached at all - so a salesperson in a basement can still open the CRM and read
 *                     the lists the screen saved (frontend/src/pages/crm/crmOffline.js). With a network it is always the live site: network
 *                     first, the kept copy is never preferred. Nothing from /api is kept here.
 *
 * Its address (/tl-app-sw.js) is not the Job Portal's (/teamlink-sw.js): the two never replace each other.
 */
const CACHE = 'tl-app-offline-v1';
const SHELL = 'tl-app-crm-shell-v1'; // the CRM page + its /assets/ files, for no-signal use only
const SHELL_MAX = 160;
const OFFLINE = '/tl-app-offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.add(OFFLINE)).catch(() => {}).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { for (const k of await caches.keys()) { if (k !== CACHE && k !== SHELL && k.startsWith('tl-app-')) await caches.delete(k); } } catch (e) { /* nothing to clean */ }
    await self.clients.claim();
  })());
});

const keep = async (key, res) => {
  try {
    const c = await caches.open(SHELL);
    await c.put(key, res);
    const keys = await c.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - SHELL_MAX))) await c.delete(k);
  } catch (e) { /* storage full or blocked: the live site still works */ }
};
const fromCrm = async (event) => {
  try { const c = event.clientId ? await self.clients.get(event.clientId) : null; return !!c && new URL(c.url).pathname.startsWith('/crm'); } catch (e) { return false; }
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url = null;
  try { url = new URL(req.url); } catch (e) { return; }
  if (req.mode === 'navigate') {
    if (url.origin === self.location.origin && url.pathname.startsWith('/crm')) {
      // the CRM: the live page, kept for later; with no network at all, the kept page (then the offline page)
      event.respondWith(fetch(req).then((res) => { if (res.ok) event.waitUntil(keep('/crm-shell', res.clone())); return res; })
        .catch(async () => (await caches.match('/crm-shell')) || (await caches.match(OFFLINE)) || Response.error()));
      return;
    }
    event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE)) || Response.error()));
    return;
  }
  // the hashed script / style files a CRM page loads: always fetched fresh; kept only to open the CRM with no signal
  if (req.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); event.waitUntil(fromCrm(event).then((crm) => (crm ? keep(req, copy) : null))); }
      return res;
    }).catch(async () => (await caches.match(req)) || Response.error()));
  }
});

// ---- phone alerts ---------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'TeamLink', body: event.data ? event.data.text() : '' }; }
  const title = String(data.title || 'TeamLink').slice(0, 100);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(data.body || '').slice(0, 200),
    icon: '/tl-app-icons/icon-192.png',
    badge: '/tl-app-icons/badge-96.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only ever a screen of this same site, whatever the push said.
  let target = self.location.origin + '/';
  try {
    const u = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
    if (u.origin === self.location.origin) target = u.href;
  } catch (e) { /* keep the default */ }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      try {
        if (new URL(w.url).origin !== self.location.origin) continue;
        await w.focus();
        if ('navigate' in w) await w.navigate(target);
        return;
      } catch (e) { /* try the next window, or open a new one */ }
    }
    await self.clients.openWindow(target);
  })());
});
