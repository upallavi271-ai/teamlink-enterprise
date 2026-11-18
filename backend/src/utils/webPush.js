// ---------------------------------------------------------------------------
// PHONE ALERTS (Web Push) — 2026-11-17.
//
// A person who switches "Phone alerts" on (Notifications page) registers their phone / browser here. From then on every
// notification that lands in THEIR bell is also pushed to that phone, so a leave decision, an approval waiting on them or a follow-up due
// reaches them with the app closed. Nobody gets anything until they switch it on, on that device.
//
//   - the keys (VAPID) are made the first time they are needed and kept in AppSetting "push.vapid" (the private half encrypted with
//     INTEGRATION_SECRET_KEY when the server has one), so there is nothing to set up on the server;
//   - a row is only ever sent when the same notification would be listed for that person in the bell (the same privacy filters as
//     GET /admin/notifications: an agreement line is never pushed to a TL / STL / Recruiter / HR login);
//   - Email / WhatsApp / SMS rows are the central message LOG, not alerts: they are never pushed;
//   - a burst (a bulk event writing many rows to one person) is folded into ONE "N new notifications" push, not N buzzes;
//   - a phone that says it is gone (404 / 410) is forgotten at once; one that keeps failing is dropped after 5 failures;
//   - in TEST_MODE / sandbox nothing leaves the machine: the push is written to an in-memory outbox instead (see _outbox());
//   - the library is loaded lazily and every public function swallows its own errors: a missing package, a bad key or a dead phone can
//     never stop a notification being saved or a request being answered.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const secrets = require('./secrets');
const sandbox = require('./sandbox');

const VAPID_KEY = 'push.vapid';
const MAX_FAILS = 5;
const BATCH_MS = Number(process.env.PUSH_BATCH_MS) || 3000; // notifications to one person inside this window go out as one push
const TTL_SECONDS = 60 * 60 * 24; // a phone that is off for a day still gets it, an older alert is useless
const MAX_BODY = 140;

let lib; // undefined = not tried, null = not installed
function webpush() {
  if (lib !== undefined) return lib;
  try { lib = require('web-push'); } catch (err) { lib = null; console.warn('[push] the web-push package is not installed: phone alerts are off —', err.message); } // eslint-disable-line global-require
  return lib;
}
const available = () => !!webpush();

// ------------------------------------------------------------------ keys
let keyCache = null;
async function vapid() {
  if (keyCache) return keyCache;
  const wp = webpush();
  if (!wp) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: VAPID_KEY } });
  if (row) {
    try {
      const v = JSON.parse(row.value);
      if (v.publicKey && v.privateKey) {
        keyCache = { publicKey: v.publicKey, privateKey: secrets.decryptSecret(v.privateKey) };
        return keyCache;
      }
    } catch { /* unreadable: make a new pair below */ }
  }
  const made = wp.generateVAPIDKeys();
  const stored = { publicKey: made.publicKey, privateKey: secrets.secretsConfigured() ? secrets.encryptSecret(made.privateKey) : made.privateKey, madeAt: new Date().toISOString() };
  try {
    // two requests at the very same moment: the first one's pair wins (create fails for the second, which then reads it)
    await prisma.appSetting.create({ data: { key: VAPID_KEY, value: JSON.stringify(stored) } });
    keyCache = { publicKey: made.publicKey, privateKey: made.privateKey };
  } catch {
    const again = await prisma.appSetting.findUnique({ where: { key: VAPID_KEY } });
    const v = JSON.parse(again.value);
    keyCache = { publicKey: v.publicKey, privateKey: secrets.decryptSecret(v.privateKey) };
  }
  return keyCache;
}
async function publicKey() {
  try { const k = await vapid(); return k ? k.publicKey : null; } catch (err) { console.error('[push] keys:', err.message); return null; }
}
// The address the push services may contact the sender at: this site's own address, never a person's e-mail.
const subject = () => String(process.env.APP_BASE_URL || process.env.FRONTEND_URL || '').startsWith('https://') ? String(process.env.APP_BASE_URL || process.env.FRONTEND_URL) : 'mailto:no-reply@teamlinks.in';

// ------------------------------------------------------------------ sending
const outbox = []; // TEST_MODE: what would have been sent
let sender = null; // tests may replace the real sender
function setSender(fn) { sender = fn; }
function _outbox() { return outbox; }

async function reallySend(sub, payload) {
  if (sender) return sender(sub, payload);
  if (sandbox.isSandbox()) { outbox.push({ endpoint: sub.endpoint, payload }); return { statusCode: 201, simulated: true }; }
  const wp = webpush();
  const k = await vapid();
  if (!wp || !k) throw Object.assign(new Error('phone alerts are not available'), { statusCode: 0 });
  return wp.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    { vapidDetails: { subject: subject(), publicKey: k.publicKey, privateKey: k.privateKey }, TTL: TTL_SECONDS, urgency: 'normal', timeout: 15000 },
  );
}

// Send one payload { title, body, url, tag } to every phone of one person. Never throws.
async function sendToUser(userId, payload) {
  const out = { sent: 0, failed: 0, removed: 0 };
  try {
    if (!userId) return out;
    const subs = await prisma.pushSubscription.findMany({ where: { userId } });
    for (const sub of subs) {
      try {
        await reallySend(sub, payload);
        out.sent += 1;
        await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: new Date(), failCount: 0 } }).catch(() => {});
      } catch (err) {
        const code = Number(err && err.statusCode);
        if (code === 404 || code === 410) { // the phone / browser says this address no longer exists
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          out.removed += 1;
        } else {
          out.failed += 1;
          const fails = (sub.failCount || 0) + 1;
          if (fails >= MAX_FAILS) { await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {}); out.removed += 1; }
          else await prisma.pushSubscription.update({ where: { id: sub.id }, data: { failCount: fails } }).catch(() => {});
        }
      }
    }
  } catch (err) { console.error('[push] send:', err.message); }
  return out;
}

// ------------------------------------------------------------------ registering a phone
async function subscribe(userId, subscription, userAgent) {
  const endpoint = String(subscription && subscription.endpoint || '');
  const keys = (subscription && subscription.keys) || {};
  if (!/^https:\/\//i.test(endpoint) || endpoint.length > 2000 || !keys.p256dh || !keys.auth) return { ok: false, error: 'That is not a valid phone subscription.' };
  const data = { userId, p256dh: String(keys.p256dh).slice(0, 200), auth: String(keys.auth).slice(0, 100), userAgent: userAgent ? String(userAgent).slice(0, 300) : null, failCount: 0 };
  // The same phone signing in as someone else moves the subscription to that person (it is the phone's address, not the person's).
  await prisma.pushSubscription.upsert({ where: { endpoint }, create: { endpoint, ...data }, update: data });
  return { ok: true };
}
async function unsubscribe(userId, endpoint) {
  if (!endpoint) return 0;
  const r = await prisma.pushSubscription.deleteMany({ where: { endpoint: String(endpoint), userId } });
  return r.count;
}
const devicesOf = (userId) => prisma.pushSubscription.count({ where: { userId } });

// ------------------------------------------------------------------ from a notification row
const OPEN_RE = /\nOpen: (\/[^\s]+)\s*$/;
const ANN_PREFIX = 'Announcement: ';
// The same rule the bell uses to decide where a notification opens (frontend components/NotificationBell.jsx).
function linkOf(n) {
  if (String(n.title || '').startsWith(ANN_PREFIX)) {
    return `/employee-services?tab=announcements&open=${encodeURIComponent(String(n.title).slice(ANN_PREFIX.length))}`;
  }
  const m = String(n.message || '').match(OPEN_RE);
  return (m && m[1]) || '/admin/notifications';
}
function payloadOf(n) {
  const body = String(n.message || '').replace(OPEN_RE, '').replace(/\s+/g, ' ').trim();
  return {
    title: String(n.title || 'TeamLink').slice(0, 100),
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body,
    url: linkOf(n),
    tag: n.id ? `n-${n.id}` : undefined,
  };
}

// one waiting batch per person
const waiting = new Map(); // userId -> { items: [payload], timer }
function queue(userId, payload) {
  let w = waiting.get(userId);
  if (!w) { w = { items: [], timer: null }; waiting.set(userId, w); }
  w.items.push(payload);
  if (w.timer) return;
  w.timer = setTimeout(() => {
    waiting.delete(userId);
    const items = w.items;
    const one = items.length === 1 ? items[0] : {
      title: `${items.length} new notifications`,
      body: items.slice(0, 3).map((i) => i.title).join(' · ') + (items.length > 3 ? ' …' : ''),
      url: '/admin/notifications',
      tag: 'n-many',
    };
    sendToUser(userId, one).catch(() => {});
  }, BATCH_MS);
  if (w.timer.unref) w.timer.unref();
}

// Called for every Notification row written (db.js). Decides whether it is an alert, then queues it. Never throws.
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function onNotification(row) {
  try {
    if (!row || !row.userId) return;
    await sleep(row.id ? 250 : 0); // let a surrounding transaction finish writing the row before it is looked up
    if (row.channel && row.channel !== 'In-App') return; // Email / WhatsApp / SMS rows are the message log
    if (!(await prisma.pushSubscription.count({ where: { userId: row.userId } }))) return; // nobody switched alerts on: stop here, cheaply
    let visible = true;
    if (row.id) {
      // the person must be able to see it in the bell: same filters as GET /admin/notifications
      // judged on the person's full identity (role, ATS role ...), exactly as the bell's request is
      const user = await require('./identity').resolveIdentity(row.userId).catch(() => null); // eslint-disable-line global-require
      if (!user || (user.status && user.status !== 'Active')) return; // a suspended login gets no alerts
      const noAgreement = require('./agreementPrivacy').notificationFilter(user); // eslint-disable-line global-require
      const PH = require('./announcementPause').PAUSED_HIDE; // eslint-disable-line global-require
      visible = (await prisma.notification.count({ where: { AND: [{ id: row.id }, { userId: row.userId }, PH, ...(noAgreement ? [noAgreement] : [])] } })) > 0;
    }
    if (visible) queue(row.userId, payloadOf(row));
  } catch (err) { console.error('[push] notification:', err.message); }
}

// createMany gives no ids back: find each row it wrote (same person, same title, written just now) and treat it like any other.
async function onNotificationRows(rows, startedAt) {
  try {
    for (const r of rows) {
      if (!r || !r.userId) continue;
      if (r.channel && r.channel !== 'In-App') continue;
      await sleep(250);
      const found = await prisma.notification.findFirst({ where: { userId: r.userId, title: r.title, createdAt: { gte: startedAt } }, orderBy: { createdAt: 'desc' } });
      if (found) await onNotification(found);
    }
  } catch (err) { console.error('[push] notifications:', err.message); }
}

module.exports = {
  available, publicKey, subscribe, unsubscribe, devicesOf, sendToUser, onNotification, onNotificationRows, payloadOf, linkOf,
  // for tests
  setSender, _outbox, _waiting: waiting, BATCH_MS,
};
