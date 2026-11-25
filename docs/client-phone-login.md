# Client login on the phone ("Social posts")

Added 2026-11-25. A TeamLink CLIENT signs in on the phone (the installed app or the browser), looks at the social media posts TeamLink made for their company, approves or rejects each one, and sees which social accounts TeamLink manages for them.

## What it reuses (nothing here decides anything new)
- **The approval** is the AI Marketing "client approval" (`backend/src/marketing/clientReview.js`, table `OmniMkClientReview`): the same one behind the private link and the WhatsApp Approve / Reject buttons. A post reaches the client when the team presses "Ask the client to approve" / "Send to client" in AI Marketing; nothing is posted for a client before the client has approved (and, for "post after the client approves", before the client's own tick: `marketing/itemPlan.js`).
- **The login** is the ordinary Client 360 > Portal access login (`routes/portalLogins.js`): a `User` with role `CLIENT` and a company (`clientId`), a single-use "set your password" link (never a password in any answer or mail).
- **The wall**: `utils/externalPortalAuth.js` already allows `/api/portal/client/*` for a client and refuses every other `/api` path.

## What is new
| Piece | Where |
|---|---|
| "Social posts" login type = ONLY the tick `CREATIVE` (see `utils/clientPortalTypes.js`, preset `MARKETING`). Shown in Add user as "Fill like Social posts (phone app login)". It can be added even when the company has no Active agreement (every other type still needs one). | `utils/clientPortalTypes.js`, `routes/portalLogins.js`, `components/clients/*` |
| API for the client: list, one post, approve / reject, allow posting, social accounts | `routes/portalPosts.js` -> `marketing/clientPhone.js` (`/api/portal/client/posts`) |
| Phone screens: Posts to approve, Approved and posted, My social accounts | `frontend/src/pages/portal/ClientPosts.jsx`, `ClientAccounts.jsx` (`/client-posts`, `/client-accounts`) |
| Short menu for that login only (3 entries + Sign out); lands on `/client-posts` | `frontend/src/nav.js` (`isPostsOnlyClient`), `Shell.jsx`, `Dashboard.jsx`, `utils/identity.js` (`landingPath`) |
| A bell (and a phone alert, if switched on) for the company's client logins when the team sends a post | `clientPhone.announce()` called from `clientReview.create()` / `reopen()` |

## Rules
- A login sees only its own company's rows: `clientId` equal, or no `clientId` on the row and the same company name (the rule the web portal's "Creative work" list already used).
- The name on an answer is the login's own (never typed). A rejection needs a reason (5+ letters); the answer is saved once, goes to the sender as a bell, shows in AI Marketing's client reviews, and each answer is one more audit line ("client answered from their login").
- The accounts screen is read only and sends no token, no error text and no staff names.
- A client with other ticks (for example "See our requirements" + creative) keeps My Portal exactly as before; only a login whose only tick is `CREATIVE` gets the short menu.

## Test
`cd backend && TL_API=http://localhost:4063 node scripts/client-phone-test.js` (sandbox only; 55 checks: create the login and sign in, only-own-company, approve / reject, staff see the decision, accounts, walls).
