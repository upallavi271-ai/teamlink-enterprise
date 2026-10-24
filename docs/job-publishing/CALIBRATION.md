# Calibrate the selectors (a person does this, once per portal)

**Why.** The page settings for Naukri, Shine and Foundit (`backend/src/portals/selectors/<portal>.json`) were written from the public look of those sites. Nobody has checked them against the real post-job form, so they are labelled **UNVERIFIED** (`"verified": false`). While they are unverified TeamLink **refuses a real post** (Dry run and Test connection still work). Only a person who has looked at the real pages can change that.

**What TeamLink never does here.** It never signs in for you during calibration, never types a password, never solves a CAPTCHA or an OTP, never clicks, never submits, never posts. The calibration tool only *looks* at the page you have open.

## 1. Before you start
- The posting computer has Google Chrome (or Edge) installed.
- The company login for the portal is saved (Administration > Integrations > Job portals > the portal's card > Save login). The format checks tell you about typing slips.
- You can sign in to the portal yourself (you may be asked for a CAPTCHA or an OTP: you solve it, not TeamLink).

## 2. Run the calibration (about 5 minutes per portal)
On the posting computer, in the `backend` folder:

```
npm run portal-calibrate -- naukri       (or shine, or foundit)
```

A Chrome window opens (it uses the portal's own saved browser profile, so you stay signed in afterwards). The tool asks for three pages and presses Enter-to-continue after each:

| Page | What you do | What the tool looks for |
|---|---|---|
| 1. Login page | leave it as it is, do not sign in yet | login name box, password box, sign-in button |
| 2. Post-a-job form | sign in yourself, open "Post a job" so an **empty** form is on screen | every form box, the Post / Submit button, the "Next" button of a two-page form |
| 3. My jobs list | open the list of your jobs (or skip) | the job row and the Close button |

For every step it prints one line:

```
[OK] Form: Job title box        main way works
[~~] Form: Pay from             DRIFT: only way 3 works
[--] Form: Company box          NOT FOUND
```

and saves a picture (passwords hidden) plus a page-structure snapshot (no typed values, no personal text) into the private picture folder (`~/.teamlink-portal-shots/<portal>/calibrate-*`). Nothing is typed or clicked by the tool.

## 3. Fix what it found
Open a **copy** of the page-settings file and set it as the override (so an update of TeamLink cannot overwrite your work):

1. Copy `backend/src/portals/selectors/naukri.json` to a folder of your own, for example `C:\teamlink-selectors\naukri.json`.
2. Set `TL_PORTAL_SELECTORS_DIR=C:\teamlink-selectors` in `backend/.env` (or the setting `jobpublish.selectorsDir`). Restart the worker.
3. For each **DRIFT** step: move the entry that worked to the **front** of that step's list.
4. For each **NOT FOUND** step: look at the page-structure snapshot (Health screen > the attempt > "Page shape", or the file from step 2) and add a new entry. An entry is one of:
   - a CSS or Playwright string: `"input[name='jobTitle']"`, `"button:has-text('Post Job')"`
   - `{ "role": "button", "name": "Post Job" }` (by accessible role and name)
   - `{ "label": "Job title" }` (by the text of its label)
   - `{ "text": "Post Job" }`, `{ "placeholder": "Job title" }`, `{ "testId": "post-job" }`
   Keep at least three ways per step, and at least one role / label / text way: they survive a redesign better than CSS.
5. Bump `"version"`. Run the calibration again until the steps you need say **main way works**. A box you never use (for example "Company") may stay NOT FOUND: leave it out of `order` or accept that it is skipped.

## 4. Mark it verified: only after a real Dry run
1. Switch the portal's automatic posting ON (the card asks you to read the risk).
2. Send one job as a **Dry run** (Post step > "Check only"). TeamLink fills the form and stops before Submit. Open the picture: is every box filled right?
3. If yes: set `"verified": true` in your copy of the file, restart the worker, and set `TL_ALLOW_REAL_POSTING=1` in the environment of both the API and the worker (this is the owner's deliberate "real posting is allowed here" switch).
4. Publish **one** real job. Check on the portal itself that it is there. Check that the Health screen shows the job id and a link, and the steps as **Works**.

A real post needs all of: `TL_ALLOW_REAL_POSTING=1` + the portal's switch ON + not a Dry run + `"verified": true`. Take any of them away and TeamLink holds the job back and keeps the by-hand task.

## 5. When a site changes later (self-healing)
Every step lists several ways to find its element. The run tries them in order and remembers which one worked. When the **main** way fails but a fallback works, the run still succeeds and the Health screen shows **Drift** for that step with the way that worked: put that way first. When **nothing** works the run stops (it never guesses a button), the step shows **Broken**, and a page-structure snapshot is saved to help you write a new entry. A destructive button (sign-in, Post, Close) is only pressed through a fallback if that fallback matches exactly one button.

## Honest status today (2026-10-14)
| Portal | Selectors | Evidence |
|---|---|---|
| Naukri | **UNVERIFIED** | exercised only against the local mock portal |
| Shine | **UNVERIFIED** | exercised only against the local mock portal |
| Foundit | **UNVERIFIED** | exercised only against the local mock portal |
