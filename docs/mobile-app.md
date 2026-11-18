# TeamLink on the phone (installable app + phone alerts)

Added 2026-11-17. The same web app, nothing rewritten: a staff member opens it on a phone, taps **Install**, and gets a TeamLink icon that opens full screen on the normal
home screen; if they switch **Phone alerts** on, a notification that lands in their 🔔 bell also reaches the phone.

**2026-11-18: the "Mobile Home" screen was removed (founder: "mobile home remove that").** The app opens on the normal home screen like the website. `/mobile` is kept only as a
redirect to `/` (query string kept), so the Android app (`android/`, which opens `/mobile?source=app`) and web apps installed before then keep working without a rebuild.
The install / alerts card now lives on the **Notifications** page (🔔 bell → All notifications).

## The short phone menu (2026-11-18, founder: "yes, trim it")

On a phone-width screen (the slide-in menu, under 900 px) and inside the installed / Android app (even on a wide screen), the menu shows only the essentials for that login.
The computer menu is untouched. It is a VIEW, never a lock: no permission changed, every screen still opens by its address, and a **Full menu** link at the bottom of the phone
menu shows the whole menu for the session (**Short menu** takes you back). A separate company's build has no phone app and always shows its full menu.

| Entry | Real screen | Who sees it (the SAME permission test as the full menu) |
| --- | --- | --- |
| Home | `/` | everyone |
| Check in / out | `/attendance?tab=mine` (a non-HR login's Attendance home is My Attendance, with the GPS + selfie check-in) | Attendance & Time view |
| Leave | `/leave` (Apply Leave, balance, status) | Leave & Holidays view |
| Payslips | `/payroll?tab=payslips` | Payroll & Compensation view |
| My tasks | `/timesheet` (Given to me, Checklist) | Employee Services view |
| Leave approvals / Regularization / Late coming | `/leave?tab=requests`, `/attendance?tab=regularization`, `/attendance?tab=late` | the **approve** permission on Leave & Holidays / Attendance & Time (TL, HR, Assistant Manager, Manager, Super Admin today; an STL does not hold it) |
| Follow-ups, candidates, interviews | `/ats/followups` (opens the follow-up lists; call / WhatsApp from the row), the candidate list, the interview calendar | ATS role Recruiter or BDE with the candidate-list permission |
| Notifications (the phone-alerts switch is on this page), My Employee Profile, Profile | `/admin/notifications`, `/my-profile`, `/admin/profile` | everyone (My Employee Profile: logins with an employee record) |

Left off the phone menu on purpose: payroll admin, Accounts, reports, Administration, Employee Monitoring, the org chart, Omni-Channel, bulk work and imports.
Code: `phoneGroupsFor()` in `frontend/src/nav.js` (the entries and their permission tests), `frontend/src/pwa/appMenu.js` (when it applies, the Full menu switch), the menu markup in `components/Shell.jsx`.
Payroll reads `?tab=payslips` so "Payslips" opens that tab.

## What is where

| Piece | Files |
| --- | --- |
| Installable app | `frontend/public/tl-app.webmanifest`, `tl-app-icons/`, `tl-app-offline.html`; the tags are injected into the page by `frontend/vite.config.js` (`brandHtml`) |
| App worker (alerts + offline page only) | `frontend/public/tl-app-sw.js` (its own address, never `/teamlink-sw.js`, which is the Job Portal's) |
| Install prompt, alerts switch, sign-out | `frontend/src/pwa/pwa.js`, `components/PhoneAlerts.jsx` (Notifications page), `context/AuthContext.jsx` (`endSession`) |
| Sending alerts | `backend/src/utils/webPush.js`, `routes/push.js` (`/api/push/*`), a hook in `db.js` that runs after every `Notification` row is written, table `PushSubscription` |
| Android app | `android/` and `.github/workflows/android-apk.yml` on branch `android-apk` (a Trusted Web Activity that opens the live site) |
| Test | `node backend/scripts/phone-alerts-test.js` (copy database only; nothing goes to a real phone) |

The manifest's `id` is still `/mobile`: it is only the app's identity string (changing it would make already-installed copies look like a different app), not a screen.

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

1. Android Chrome: open the site, 🔔 → All notifications → **Install the app** (or ⋮ → Install app). iPhone: Safari → Share → **Add to Home Screen** (iOS 16.4 or newer), then open it from the icon.
2. On the Notifications page → **Turn on alerts** → allow → **Send a test**. The test should arrive within seconds.
3. Have somebody approve or reject a leave for that person: the phone shows it, and tapping it opens the right screen.

## Switching it off

- One person: Notifications → **Turn off**.
- Everyone's alerts: `DELETE FROM PushSubscription;` (people can switch back on).
- The app worker itself: publish a `tl-app-sw.js` that calls `self.registration.unregister()`.
