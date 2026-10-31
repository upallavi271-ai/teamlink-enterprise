# Job posts to social media: Facebook, Instagram, Threads, LinkedIn (official APIs, free)

"Post job" (the Post step after Save & Post, and the Postings tab of a job) lists a **Social media** group next to Naukri, Shine, Indeed and
LinkedIn Jobs. Ticking one and pressing **Post selected** posts the job there for real, through the platform's own API.
**Nothing is sent until an Admin switches that place ON** (Administration, Integrations, Job portals). Every place also has **Check only (dry run)**.

| Place | What is posted | Account comes from | Can the post be changed later? |
|---|---|---|---|
| Facebook | text + apply link on the Page | Social Media > Facebook (default Page) | yes (Post update) |
| Instagram | a **picture of the job** (made by TeamLink) with the text under it | the Instagram professional account linked to the default Facebook Page | **no** (Instagram's rule) |
| Threads | a short text (max 500 characters) | Social Media > Threads (default profile) | **no** (Threads' rule) |
| LinkedIn post | text + apply link on the **feed** of the profile (or Company Page) | Social Media > LinkedIn (default account) | yes (Post update) |

LinkedIn *Jobs* (an entry in LinkedIn's job list) is **not** this: LinkedIn does not let programs create those, so the "LinkedIn" tile stays a by-hand post.

## How accounts reach job posting
Administration, Integrations, **Social Media** keeps every connected account (any number) and marks one **default** per platform.
After every change of that list `utils/socialPosting.js` copies each platform's default to the job-posting connection of that place and
checks it (read-only). It never switches posting ON. Remove the default account and that place stops posting.

## One-time setup
* **Facebook + Instagram**: connect the Page (Social Media > Facebook). The Instagram account must be **Business or Creator**, linked to the Page
  (Page > Settings > Linked accounts). The Meta login asks for `instagram_basic` and `instagram_content_publish`. While the Meta app is not Live,
  only people with a role in the app can connect and post.
* **Instagram needs a public https site address** (`APP_BASE_URL`): Instagram's servers download the picture from
  `<site>/api/public/job-card/<job id>.jpg` (a plain 1080x1080 JPEG of the title, place, experience, mode and where to apply; it never shows the
  client, the fee or the agreement; the pay only if that place shows salary). A closed or internal job has no picture (404).
* **Threads**: paste the Threads token (Social Media > Threads), same Meta app.
* **LinkedIn**: on developers.linkedin.com make an app, add the products *Sign In with LinkedIn using OpenID Connect* and *Share on LinkedIn*
  (both free, instant). Under Auth add the redirect address shown on the LinkedIn tab. Type the Client ID / Client secret once on the tab, press
  **Connect LinkedIn** and sign in on LinkedIn. A **Company Page** also needs LinkedIn's approval of the *Community Management API* for the app and a
  Page administrator: tick the Company Page box and type the Page number. The token lasts **about 60 days** (LinkedIn's rule): the account shows
  *Expired* and posting says so until you press Connect LinkedIn again.
* The LinkedIn API version header comes from `TL_LINKEDIN_VERSION` (or the Admin setting `jobpublish.api.linkedinpost.version`); LinkedIn retires old months,
  so set a current `YYYYMM` if LinkedIn ever answers "version not active".

## What gets posted
Same rules as Telegram / Facebook (TELEGRAM.md, FACEBOOK.md): the Posting Kit text for that place (no client name, no fee, no agreement), the apply link
with `?src=<place>&utm_source=<place>&utm_medium=social&utm_campaign=job-<code>` (applicants from it show the place as their source), one post per
job per place, nothing is ever called Posted unless the platform answered with a post id. A closed job sends nothing (the post stays where it is).

## Test
`backend/scripts/job-social-post-test.js` (sandbox only; a local fake Facebook / Instagram / Threads / LinkedIn on port 4598). Start a sandbox API with
`TL_FACEBOOK_GRAPH_BASE`, `TL_THREADS_GRAPH_BASE`, `TL_LINKEDIN_AUTH_BASE`, `TL_LINKEDIN_API_BASE` pointing at the fake, `TEST_MOCK_PORTS=4598`,
`TL_API_STRICT_LOCAL=1`, then `TL_API=http://localhost:<port> node scripts/job-social-post-test.js`.
