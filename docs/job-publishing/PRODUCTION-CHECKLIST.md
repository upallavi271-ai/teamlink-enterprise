# Production checklist

1. [ ] Migration `20261013120000_job_publish_queue` applied, `prisma generate` run, `/api/job-publish/health` says `migrated: true`.
2. [ ] `INTEGRATION_SECRET_KEY` set (64 hex chars) and backed up. Changing it makes saved portal logins unreadable.
3. [ ] Role Catalog: "Job Portal Credentials" is Super Admin / Admin only (default). Nobody else holds it.
4. [ ] The company has read each portal's terms and, where possible, has the portal's written OK for automated posting. LinkedIn stays manual.
5. [ ] Chrome (or Edge) installed on the worker machine; `PLAYWRIGHT_CHROME_PATH` set if it is not in the usual place.
6. [ ] Worker started under pm2 (or Docker) as its own user; profile folder `chmod 700`; `TL_ALLOW_REAL_POSTING=1` set on purpose; the worker heartbeat shows on `/health`.
7. [ ] Every portal's switch is OFF until its DRY RUN passed (PLAYWRIGHT.md). Page settings (`selectors/*.json`) marked `"verified": true` after the DRY RUN.
8. [ ] For each portal: save the login, run `npm run portal-session -- <portal>` once yourself, press "Test connection" (CONNECTED), DRY RUN one job, check the screenshot, publish ONE real job, check id + link + listing, then switch ON.
9. [ ] Limits set to what the plan allows (`perHour`, `perDay`, `minGapSeconds`). Defaults are low on purpose.
10. [ ] Mappings reviewed (employment type, city, industry, experience / salary bands): `GET /api/job-publish/mappings`, edit with `PUT`.
11. [ ] Kill switch and Pause all tried once by an Admin; the screen shows who switched what.
12. [ ] A CAPTCHA drill: with a test account, confirm the job turns "Needs a person", the by-hand task is there and the portal is on hold until `portal-session` / Resume.
13. [ ] Backups include the posting tables (same DB); retention job for `PostingLog`, screenshots and log files.
14. [ ] Notices go to the person who pressed Publish (live / needs a person / failed). Dead letters are looked at daily (`/dead-letters`).
15. [ ] Migrations: all five pending ones applied in order (`omnichannel_inbox`, `scheduled_messages`, `candidate_duplicates`, `job_publish_queue`, `job_duplicates`) after a backup. They were rehearsed on a copy of the real database.
16. [ ] Calibration done per portal (CALIBRATION.md): every needed step says *main way works*, then `"verified": true`. Until then a real post is refused on purpose.
17. [ ] `TL_ALLOW_REAL_POSTING=1` set on purpose in the API and the worker environment; the Health screen says *Real posting allowed*.
18. [ ] Health screen (Integrations > Job portals > Health and problems) looked at: no *Broken* portal, worker running, session age sensible, picture retention set.
19. [ ] An OTP drill: with the company account, ask for an OTP login, confirm the job shows *Needs your help*, type the code, confirm the run continues and the code is nowhere in the logs.
20. [ ] Existing flows re-checked: Save & Post to the six sites, by-hand tasks, the Indeed feed, the careers page, the embedded Job Portal.
