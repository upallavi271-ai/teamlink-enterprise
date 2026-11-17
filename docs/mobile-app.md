# TeamLink on the phone (installable app + phone alerts)

Added 2026-11-17. The same web app, nothing rewritten: a staff member opens it on a phone, taps **Install**, and gets a TeamLink icon that opens
full screen on **Mobile Home**; if they switch **Phone alerts** on, a notification that lands in their 🔔 bell also reaches the phone.

## What is where

| Piece | Files |
| --- | --- |
| Installable app | `frontend/public/tl-app.webmanifest`, `tl-app-icons/`, `tl-app-offline.html`; the tags are injected into the page by `frontend/vite.config.js` (`brandHtml`) |
| App worker (alerts + offline page only) | `frontend/public/tl-app-sw.js` (its own address, never `/teamlink-sw.js`, which is the Job Portal's) |
| Install prompt, alerts switch, sign-out | `frontend/src/pwa/pwa.js`, `components/PhoneAlerts.jsx` (Mobile Home and the Notifications page), `context/AuthContext.jsx` (`endSession`) |
| Mobile Home | `frontend/src/pages/MobileHome.jsx`, route `/mobile`: the same check-in panel, the bell's "Important" list and messages, install / alerts, every screen the login may open |
| Sending alerts | `backend/src/utils/webPush.js`, `routes/push.js` (`/api/push/*`), a hook in `db.js` that runs after every `Notification` row is written, table `PushSubscription` |
| Test | `node backend/scripts/phone-alerts-test.js` (copy database only; nothing goes to a real phone) |

## Rules it keeps

- Nobody gets an alert until they switch it on, on that phone. The browser's permission question only opens from that tap.
- An alert is sent only if the same notification would be listed in that person's bell (same agreement-privacy and paused-announcement filters). Email / WhatsApp / SMS
  rows (the message log) and suspended logins never produce an alert.
- A burst of notifications to one person (inside 3 s) is one push: "N new notifications".
- Signing out (or the idle sign-out) first removes THIS phone from that person's alerts, so a shared phone never shows the previous person's alerts. Signing in again as the
  same person on that phone switches it straight back on.
- "View as" / "Act as" sessions cannot register or remove a phone.
- The sending keys (VAPID) are made on first use and kept in `AppSetting` `push.vapid` (private half encrypted when `INTEGRATION_SECRET_KEY` is set). Nothing to configure.
- A separate company's build (`VITE_BRAND_NAME`, see `docs/second-company.md`) gets no manifest, no worker and no install / alerts card: it would carry TeamLink's name and picture.
- The worker never answers a request from a cache and never touches `/api`, scripts or images; it only shows `tl-app-offline.html` when a page cannot be reached at all.

## Checking it on a real phone (first time after a deploy)

1. Android Chrome: open the site, Mobile Home → **Install the app** (or ⋮ → Install app). iPhone: Safari → Share → **Add to Home Screen** (iOS 16.4 or newer), then open it from the icon.
2. On Mobile Home → **Turn on alerts** → allow → **Send a test**. The test should arrive within seconds.
3. Have somebody approve or reject a leave for that person: the phone shows it, and tapping it opens the right screen.

## Switching it off

- One person: Mobile Home or Notifications → **Turn off**.
- Everyone's alerts: `DELETE FROM PushSubscription;` (people can switch back on).
- The app worker itself: publish a `tl-app-sw.js` that calls `self.registration.unregister()`.
