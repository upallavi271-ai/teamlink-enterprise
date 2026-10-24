# Facebook Page posting (official Graph API, free)

TeamLink can post a job to your Facebook **Page** through the official Graph API
(`POST /{page-id}/feed`). **Nothing is sent until an Admin switches it ON.**

## What you need (the user must do these; TeamLink cannot)
* A Facebook **Page** you administer.
* A **Meta developer app** (developers.facebook.com) connected to a Business account.
* A **Page access token** with the permission **`pages_manage_posts`** (and `pages_read_engagement` to read the page name).
  Posting to a Page through the API needs this permission. For an app used only by the Page's own admins/developers, standard access is
  enough while the app is in development mode; to use it live for the company you must pass Meta **App Review** (Business Verification)
  to get advanced access. This is Meta's rule, not TeamLink's.
* Use a **long-lived** Page token (Graph API Explorer: get a user token with the permissions, exchange it for a long-lived token,
  then `GET /me/accounts` returns the Page token and the **Page ID**).

## Set up in TeamLink (once)
1. **Administration, Integrations, Job portals, Logins and switches, Facebook page.**
2. Type the **Page number (Page ID)** and paste the **Page access token**. **Save**. (The token is encrypted and never shown again.)
3. **Test connection**: reads the Page name (`GET /{page-id}?fields=id,name`). Posts nothing.
4. An Admin presses **Switch ON**, then **Send a test post to my page** (separate button; ONE real post you can delete).

## What gets posted
Same rules as Telegram (see TELEGRAM.md): the Posting Kit text for Facebook (no client name, no fee), the apply link with
`?src=facebook&utm_source=facebook&utm_medium=social&utm_campaign=job-<code>`, one post per job, **Post update** edits the existing
post (`POST /{post-id}`), **Check only (dry run)** sends nothing, closing a job sends nothing unless "post a closing note" is ON.
Facebook allows long posts; the default limit here is 5000 characters (editable under Where jobs are posted).

## Problems in plain words
| Message | Meaning |
|---|---|
| The token was not accepted | Facebook error 190: token wrong, expired or the password was changed. Save a new token. |
| The bot or token is not allowed to post there | Error 200/10: the token lacks `pages_manage_posts`, or the app is not approved for it. |
| The channel or page was not found | The Page ID is wrong. |
| The site asked us to slow down | Rate limit (codes 4, 17, 32, 613). TeamLink tries again later. |

## For developers
Base: `TL_FACEBOOK_GRAPH_BASE` (env, default `https://graph.facebook.com/v19.0`) or the setting `jobpublish.api.facebook.base`.
`TL_API_STRICT_LOCAL=1` refuses any non-local address (tests). Code: `backend/src/portals/facebook/FacebookAdapter.js`.
