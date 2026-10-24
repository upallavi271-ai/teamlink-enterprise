# Job distribution: the Distribute tab (Posting Kit, tracked links, Posted tracker)

Migration: `20261014300000_job_distribution` (tables `DistPlatform`, `DistPosting`; rollback.sql undoes it). Until it is applied the
screens say "Distribution is not switched on yet" and nothing else changes.

## Click path
* Job page, **Distribute** tab (no sidebar entry). Every place is a card.
* Jobs list: **Posted on** chips now count by-hand places; **Expired** filter; **Posting tracker** button (where posted / pending / expired).
* Administration, Integrations, Job portals: **Where jobs are posted** (the editable list, reminder days, Google Indexing API),
  **Logins and switches** (Telegram and Facebook set-up cards).

## The three kinds of place
* **Automatic**: own job portal, Google for Jobs (job markup + site map), RSS/XML feed, Telegram, Facebook.
* **Copy and post (semi-automatic, the default for every job site)**: LinkedIn, Indeed, Naukri, Shine, Foundit, Apna, WorkIndia,
  Freshersworld, Quikr Jobs, OLX Jobs, NCS, WhatsApp. TeamLink writes the text, gives the place's own tracked apply link, opens the
  site's post page; a person posts and presses **Mark as posted** (link, date, posted by, expiry, notes).
  The Naukri/Shine/Foundit browser automation stays OFF by default; the kit is the normal route.
* **By hand**: college placement cells, employee referral.

## Honest words
A post a person marked reads **"Posted by <name> (not checked by the system)"**. Only the automatic places carry the system's own chips.

## Tracked links and applicant source
`<site>/careers/<slug>?src=<key>&utm_source=<key>&utm_medium=<type>&utm_campaign=job-<code>` is per place. `/careers/<slug>` forwards to the
embedded portal keeping the tags; the portal's embed host remembers them (cookie `tl_attr`) and sends them with the application; the ATS bridge
(`utils/jobPortalBridge.js`, `routes/careersPublic.js`) turns the key into the place's name: applicant source "LinkedIn", "Apna", "WhatsApp" ...
(`jobDist/attribution.js`) and stores `utm_*` on the application. The portal's own code is not changed.

## Expiry and closing
Reminder N days before expiry (default 3, setting): bell to the poster and the TL plus a My task "Renew or take down". When a job is closed:
one "Take it down: <job> on <place>" task per place where it was posted (with the links); marked done by hand ("I took it down").
TeamLink never deletes anything on those sites. Runs from the posting worker, and also when the Distribute tab or the tracker is opened.

## Google for Jobs
Every job live on the careers page serves `JobPosting` markup (`/api/public/jobs/<id>/jsonld`, client name never in it). Crawlers that follow a
tracked `/careers/<slug>` link get a page that carries the markup (`/api/public/job-portal/go/<slug>`); people are redirected as before.
The site map lists `/careers/<slug>`. The optional Google Indexing API is OFF, needs a company service account and is limited by Google to
certain content: see the card in Integrations.

## Telegram and Facebook
See TELEGRAM.md and FACEBOOK.md. They are normal portals of the job-publish engine (adapter, queue, chips, retry, diagnostics), default OFF.
