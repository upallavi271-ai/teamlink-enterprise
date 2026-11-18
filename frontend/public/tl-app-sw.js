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
 * Its address (/tl-app-sw.js) is not the Job Portal's (/teamlink-sw.js): the two never replace each other.
 */
const CACHE = 'tl-app-offline-v1';
const OFFLINE = '/tl-app-offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.add(OFFLINE)).catch(() => {}).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { for (const k of await caches.keys()) { if (k !== CACHE && k.startsWith('tl-app-')) await caches.delete(k); } } catch (e) { /* nothing to clean */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return; // not a page load: the browser handles it itself
  event.respondWith(
    fetch(req).catch(async () => (await caches.match(OFFLINE)) || Response.error()),
  );
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
