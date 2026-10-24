# Playwright adapters: guide

## Rules every adapter keeps (they live in `BasePortal`)
1. A **CAPTCHA, OTP, 2-step check, "unusual activity" page, email check or block page** is detected (page elements, wording, address, HTTP 403/429) and the run **stops** with `NEEDS_HUMAN`, a screenshot and a plain sentence. Nothing is solved or bypassed. The one exception is an **OTP that a person types** (rule 8).
2. No stealth plugin, no fingerprint change, no user-agent spoofing, no proxy rotation. Only 1-3 s pauses.
3. Wrong password: stop at once, never retried.
4. Submit is pressed once. The queue is told first; a failure after Submit is never retried (it could post twice).
5. PUBLISHED = id or link captured AND the listing page shows the job. Otherwise NEEDS_CHECK.
6. The browser may only open the portal's own domains. In tests and in the sandbox it may open **localhost only**.
7. DRY RUN fills the form, photographs it and stops before Submit.
8. **OTP = human in the loop.** When the site shows an OTP box the run keeps its browser open and the queue entry shows **Needs your help** (status RUNNING with a `waiting` note). A person types the code in the *Enter the OTP* box (Post step, job page, Health screen, Test connection). It goes `API -> 127.0.0.1 socket -> the waiting run -> the site's OTP box` and lives only in memory: never in the database, a log, an audit row, a file, a picture or an answer. It is used **once**: a wrong code ends the run as *needs a person* (repeated wrong codes lock accounts). Nobody typing within `otpWaitMs` (5 min) ends it the same way. A **CAPTCHA** is never handled by a program: the run stops and the screen says *Solve the CAPTCHA in the browser window* with the command `npm run portal-session -- <portal>`; afterwards the person presses *I did it, try again*.
9. **Real posting gate** (`src/jobPublish/guards.js`, checked by the service, the runner and `BasePortal.run`): a real post / update / take-down needs `TL_ALLOW_REAL_POSTING=1` **and** the portal's switch ON **and** not a Dry run **and** `"verified": true` page settings. The local mock portal, Dry runs and login checks are not "real posting".
10. **A destructive button is never guessed.** Sign-in, Post/Update and Close are pressed through a fallback selector only when that fallback matches exactly one visible element; the Close button is looked for inside the job's own row first.

## The browser
`playwright-core` only. The worker drives the installed Google Chrome (then Edge), or the file in `PLAYWRIGHT_CHROME_PATH`. No browser is downloaded. Headless by default; visible only for `npm run portal-session`. One browser, one context per run, one profile per portal in `~/.teamlink-portal-sessions/<portal>` (outside the repo; cookies are stored by Chrome in the clear: keep the folder private, never commit it). Screenshots go to `~/.teamlink-portal-shots` (folder mode 0700, outside the repo, served only through the authenticated API route), run logs to `~/.teamlink-portal-logs`. **Every attempt keeps at least one picture, success or failure** (login check, Dry run, post, take-down). Password, OTP and CAPTCHA boxes are always masked; on a page that shows a password box every input is masked. Pictures older than `jobpublish.screenshotRetentionDays` (default 30, Admin screen) are deleted by the worker's hourly sweep and their log rows lose the link.

## Page settings (selectors) are JSON
`src/portals/selectors/<portal>.json`: URLs, sign-in selectors, form fields (`type`: text, select, radio, tags, autocomplete, richtext, checkbox), steps for a two-page form, preview / submit / confirm buttons, how to read the success page and the job id, how to verify, how to close a job, blockers, timeouts, pacing. A selector is a **list of ways** to find one thing, tried in order (the first visible one wins). A way is a CSS / Playwright string **or** an object: `{ "role": "button", "name": "Post Job" }`, `{ "label": "Job title" }`, `{ "text": "Post Job" }`, `{ "placeholder": "..." }`, `{ "testId": "..." }`, `{ "css": "..." }` (`src/playwright/locate.js`). Each step in the three real files has at least three ways, with at least one role / label / text way.

### Self-healing report
Every run records, per step, which way worked: **ok** (the main, first way), **drift** (the main way failed, a fallback worked: the run still succeeds, a `selector-drift` warning is logged and the Health screen flags it), **broken** (nothing worked: the run stops with `SELECTOR_MISSING`, a page-structure snapshot is saved). The report is kept in the setting `jobpublish.portal.<portal>.selectorStatus` and shown on Integrations > Job portals > Health and problems, and on Jobs > Posting > Health.

### Page-structure snapshot
On a broken step a text file is saved next to the screenshots: tags, ids, names, roles, button / label wording. Never typed values, headings, paragraph or link text, query strings, e-mails or long numbers. Served as plain text through the same protected route.
Override without code: copy the file to a folder, set `TL_PORTAL_SELECTORS_DIR` (or `TL_PORTAL_SELECTORS_NAUKRI=<file>`, or the setting `jobpublish.selectorsDir`), bump `version`, set `"verified": true` after a DRY RUN matched.

**The Naukri, Foundit and Shine files are UNVERIFIED.** They were written from the public look of the sites. Only the local mock portal has been tested. While `"verified": false` a real post is refused. To verify them follow **CALIBRATION.md** (`npm run portal-calibrate -- <portal>`).

## DRY RUN procedure (with the company's own account, you trigger it)
1. Admin: Company Setup > Job portal logins > save the portal's login (the company's own account).
2. `npm run portal-session -- naukri` : a visible Chrome opens, sign in yourself (solve any CAPTCHA / OTP yourself), close the window. It says "Signed in".
3. Switch the portal's automatic posting ON.
4. On a complete job press **Publish > Naukri > Dry run** (`POST /jobs/:id/publish {"portals":["naukri"],"dryRun":true}`), with the worker running (`npm run posting-worker`).
5. Open the run's screenshot (`GET /logs/:id/screenshot`) and the step log. A field that was not found says `not found: <field>` (SELECTOR_MISSING): fix that selector in the JSON, run again.
6. When the form is filled right, publish one real job, then check the log: id captured, listing verified. Then set `"verified": true`.

## How to add a portal
1. Add it to `PORTALS` in `src/jobPublish/constants.js` (`kind: 'browser'`, `domains`).
2. Write `src/portals/selectors/<portal>.json` (copy `shine.json`).
3. `src/portals/<portal>/<Portal>Adapter.js`: `class X extends BasePortal`, `static get meta()`, override `fieldValues(payload)` only where the form differs.
4. Register it in `src/portals/registry.js`.
5. Add its mappings to `src/jobPublish/defaultMappings.js` (PORTALS list) and re-seed.
6. Add a mock layout to `test-fixtures/mock-portal/server.js` and a `mock-<portal>.json`, then a test in `scripts/job-publish-test.js`.

## Human session
`npm run portal-session -- <portal>` opens a visible Chrome on the saved profile at the login page. You type everything. Closing the window checks the sign-in quietly and, if signed in, marks the login Connected and clears the "needs a person" hold. The worker then reuses the cookies.
