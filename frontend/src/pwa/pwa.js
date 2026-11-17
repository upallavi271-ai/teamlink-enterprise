import api from '../api';
import { BRAND } from '../brand.js';

// ---------------------------------------------------------------------------
// TEAMLINK ON YOUR PHONE (2026-11-17): the installable app and the phone alerts.
//
//   "Install"   Android / desktop Chrome and Edge offer it through the browser's own prompt (captured here, shown by a button);
//               on an iPhone the person adds it from Safari's Share menu, so the screen shows those steps instead.
//   "Alerts"    Web Push. On Android / desktop any browser works. An iPhone allows it ONLY for an app added to the Home Screen
//               (iOS 16.4+), opened from that icon, and only when asked from a tap: so nothing here ever asks on its own.
//
// All of it is off in a separate company's build (BRAND.separate): the manifest, the app worker and the alerts are TeamLink's own
// product, they carry TeamLink's name and picture, so another company's copy does not offer them.
// Every function here fails quietly: a phone without the feature just does not get the button.
// ---------------------------------------------------------------------------
const SW_URL = '/tl-app-sw.js';
const FLAG = (userId) => `tl_push_on:${userId}`;

const hasWindow = typeof window !== 'undefined';
const nav = hasWindow ? window.navigator : {};

export const pwaAvailable = hasWindow && !BRAND.separate && 'serviceWorker' in nav;

// ---- the worker -----------------------------------------------------------
let registering = null;
export function registerAppWorker() {
  if (!pwaAvailable) return Promise.resolve(null);
  if (!registering) {
    registering = nav.serviceWorker.register(SW_URL, { scope: '/' }).catch(() => null);
  }
  return registering;
}
if (pwaAvailable) {
  if (document.readyState === 'complete') registerAppWorker();
  else window.addEventListener('load', () => { registerAppWorker(); });
}

// ---- where is it running --------------------------------------------------
export const isStandalone = () => {
  if (!hasWindow) return false;
  try { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || nav.standalone === true; } catch { return false; }
};
export const isIos = () => /iPad|iPhone|iPod/.test(nav.userAgent || '') || (/Macintosh/.test(nav.userAgent || '') && Number(nav.maxTouchPoints || 0) > 1);
const iosOld = () => {
  const m = /OS (\d+)[_.](\d+)/.exec(nav.userAgent || '');
  return !!m && (Number(m[1]) < 16 || (Number(m[1]) === 16 && Number(m[2]) < 4));
};

// ---- install --------------------------------------------------------------
let deferred = null;
const listeners = new Set();
const tell = () => listeners.forEach((f) => { try { f(); } catch { /* a listener never breaks another */ } });
if (hasWindow) {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; tell(); });
  window.addEventListener('appinstalled', () => { deferred = null; tell(); });
}
export const canPromptInstall = () => !!deferred;
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const d = deferred;
  deferred = null;
  tell();
  try { d.prompt(); const r = await d.userChoice; return (r && r.outcome) || 'dismissed'; } catch { return 'dismissed'; }
}

// ---- alerts ---------------------------------------------------------------
// 'ok' | 'ios-add-first' (iPhone, not yet opened from the Home Screen) | 'ios-too-old' | 'unsupported'
export function pushSupport() {
  if (!pwaAvailable || !hasWindow || !('PushManager' in window) || !('Notification' in window)) {
    return isIos() && iosOld() ? 'ios-too-old' : (isIos() && !isStandalone() ? 'ios-add-first' : 'unsupported');
  }
  if (isIos()) {
    if (iosOld()) return 'ios-too-old';
    if (!isStandalone()) return 'ios-add-first';
  }
  return 'ok';
}

const keyBytes = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
};
const sameKey = (a, b) => {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
};

async function registration() {
  await registerAppWorker();
  return nav.serviceWorker.ready;
}
async function currentSubscription() {
  try { const reg = await registration(); return await reg.pushManager.getSubscription(); } catch { return null; }
}

// What the screen shows: the browser's permission, and whether THIS phone is switched on.
export async function pushState() {
  const support = pushSupport();
  if (support !== 'ok') return { support, permission: 'default', on: false };
  const sub = await currentSubscription();
  return { support, permission: Notification.permission, on: !!sub && Notification.permission === 'granted' };
}

// Called from a tap. Throws an Error whose message can be shown to the person.
export async function enablePush(userId) {
  if (pushSupport() !== 'ok') throw new Error('This phone or browser cannot receive alerts from TeamLink.');
  const cfg = (await api.get('/push/config')).data;
  if (!cfg || !cfg.supported || !cfg.publicKey) throw new Error('Phone alerts are not available on this server yet.');
  const permission = await Notification.requestPermission();
  if (permission === 'denied') throw new Error('Alerts are blocked for this site. Allow notifications for TeamLink in your browser or phone settings, then try again.');
  if (permission !== 'granted') throw new Error('You did not allow alerts, so nothing was switched on.');
  const reg = await registration();
  const want = keyBytes(cfg.publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options && sub.options.applicationServerKey, want.buffer)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  await api.post('/push/subscribe', { subscription: sub.toJSON() });
  try { localStorage.setItem(FLAG(userId), '1'); } catch { /* alerts still work until the next sign-in */ }
  return true;
}

export async function disablePush(userId) {
  const sub = await currentSubscription();
  try { localStorage.removeItem(FLAG(userId)); } catch { /* nothing stored */ }
  if (sub) {
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return true;
}

export async function sendTestAlert() {
  const r = await api.post('/push/test');
  return r.data;
}

// A person who switched alerts on keeps them across sign-ins: when the app opens signed in, make sure the server still knows this phone.
export async function syncPush(userId) {
  try {
    if (!userId || pushSupport() !== 'ok' || Notification.permission !== 'granted') return;
    if (localStorage.getItem(FLAG(userId)) !== '1') return;
    const sub = await currentSubscription();
    if (sub) await api.post('/push/subscribe', { subscription: sub.toJSON() });
  } catch { /* the next time the app opens tries again */ }
}

// Signing out on a phone stops THAT phone being alerted for THAT person (a shared phone must not keep showing someone else's alerts).
// The phone's own switch is kept, so signing in again as the same person turns alerts straight back on (syncPush).
export async function forgetThisDevice(token) {
  try {
    if (!pwaAvailable || !('PushManager' in window)) return;
    const reg = await nav.serviceWorker.getRegistration('/');
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub && token) await api.post('/push/unsubscribe', { endpoint: sub.endpoint }, { headers: { Authorization: `Bearer ${token}` } });
  } catch { /* signing out never waits for this */ }
}

// Where a signed-in person lands: the app opened from the phone's Home Screen opens on Mobile Home.
export function appHome(user, fallback = '/') {
  const external = !!user && (['CLIENT', 'CANDIDATE'].includes(user.role) || ['CLIENT', 'CANDIDATE'].includes(user.atsRole));
  return pwaAvailable && isStandalone() && !external ? '/mobile' : fallback;
}
