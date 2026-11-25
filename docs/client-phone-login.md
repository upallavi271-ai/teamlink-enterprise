# Client login for the web and the phone ("Social posts")

Added 2026-11-25. A TeamLink CLIENT signs in (one login, the same email and password on the web and on the phone app), sees a dashboard (posts by status, by platform and by day, their plan and what is delivered, their social accounts), looks at the social media posts TeamLink made for their company, approves or rejects each one, and sees which social accounts TeamLink manages for them. The login is made from Omni-Channel > AI Marketing > Client plans > **Client login** (or from Clients > Portal access); it opens on the dashboard (`/client-home`).

## The dashboard (`/client-home`, same day)
- `GET /api/portal/client/posts/dashboard?month=YYYY-MM` -> `marketing/clientPhone.js dashboard()` (one answer for the month): the numbers (posts / waiting / approved / posted / changes asked), posts by platform, every post with its day, the posts waiting now, the accounts, and the plan (`marketing/clientServices.js forClient()`: the plan, its period, what is delivered this month against the plan; NO price, notes, contact or team names).
- **Dates.** A post has no "post on" date of its own in TeamLink, so it sits on the day of the last thing that happened to it: posted (the day it went out), answered (approved or rejected), else sent for approval (India time).
- **Platforms.** A message names its channels; a picture or video names the accounts of its posting plan and the accounts it really went out on; a post with none yet is counted under "Not chosen yet".
- **Plan numbers** are the team's own count (Client plans > delivered: counted from approved work in Client projects + the team's + and - buttons), the same figures the team sees; the page says so.
- Screen `frontend/src/pages/portal/ClientHome.jsx`: month stepper, tiles / calendar days / platform bars each filter the list below, the waiting posts at the top, rows open the post (`/client-posts?post=<id>`). One column on a phone, two on a computer; reads again when the person comes back to the page.
- Menu for this login: Dashboard, Posts to approve, Approved & posted, My social accounts (+ Sign out).

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

## "Client login" button in AI Marketing > Client plans (added 2026-11-25, same day; first called "Phone login")
A client that buys ONLY digital marketing is kept in AI Marketing > Client plans (`OmniMkClientPlan`: a name, a plan, a contact), but a login needs a company record (`User.clientId`). **FOUNDER 2026-11-25: such a client must show ONLY in AI Marketing, never as an ATS client.** So each plan has a **Client login** button, and:
- The record is flagged `Client.marketingOnly = true` (migration `20261125160000_client_marketing_only`). It takes NO ATS client ID (`clientCode` stays empty, so ATS numbering is not used up), no agreement, and carries the plan's contact and department.
- **It is hidden from ATS everywhere.** `src/db.js` (middleware "mkonly_") adds `marketingOnly = false` to every ordinary LIST read of Client (findMany / findFirst / count / aggregate / groupBy): the Clients list, pickers, dashboards, counts, reminders, duplicate checks, the login-review queue. A query that NAMES the field (any value) sees what it asks for: that is how AI Marketing finds its own. Reads by id (findUnique: the client login finds its own company) and all writes are untouched. Raw SQL on Client is not covered (checked: none of it is an ATS list).
- A record made by the FIRST version of the button (before the column) is flagged by the migration itself: it looks in the audit log for "Client created" lines that start with "Made from AI Marketing > Client plans" (keep those words in the audit text).
- An ATS client that carries the same name is NEVER touched: no login is put on it, none of its seats is used. The AI Marketing record is its own (two records may share a name; posts match by name, and the bell goes to the logins of every record with that name).
- `GET /api/portal/logins/marketing-plan/:planId` reads the company's AI Marketing record (found by company NAME, any letter case or spaces round it), its logins and the seats left. `POST .../login {name,email}` finds it or makes it, then adds the "Social posts" login through the same rules as Add user (`whyNot`, `addDirect`) and the same one-time set-password link. A refused login (bad email, email already in use, 3-login limit) is checked BEFORE a record is made, so nothing empty is left behind.
- The plan panel lists the company's logins with **Send a new link**, **Switch off** and **Switch on again** (the routes of Clients > Portal access: `resend`, `disable`, `enable`; `loadClient` opts in to marketing-only records). This company is not in Clients, so the buttons are here.
- Admin-level only (the people who may add a login directly: `can(..., 'Client Portal Logins', 'approve')`), and the AI Marketing write right. A Manager sees it only for their own departments. Everyone else is told to ask the Admin.
- Audit lines: "Client created" (when made), "Client portal login created (Social posts)", "Omni-Channel AI Marketing: client login given (web and phone)".
- The invite email and the set-password page speak about posts for this login type (the email used to say "requirements and candidates", and the page told the person to open My Profile, which only employees have).

## Rules
- A login sees only its own company's rows: `clientId` equal, or no `clientId` on the row and the same company name (the rule the web portal's "Creative work" list already used).
- The name on an answer is the login's own (never typed). A rejection needs a reason (5+ letters); the answer is saved once, goes to the sender as a bell, shows in AI Marketing's client reviews, and each answer is one more audit line ("client answered from their login").
- The accounts screen is read only and sends no token, no error text and no staff names.
- A client with other ticks (for example "See our requirements" + creative) keeps My Portal exactly as before; only a login whose only tick is `CREATIVE` gets the short menu.

## Tests
- `cd backend && TL_API=http://localhost:4063 node scripts/client-phone-test.js` (sandbox only; 55 checks: create the login and sign in, only-own-company, approve / reject, staff see the decision, accounts, walls).
- `cd backend && TL_API=http://localhost:4063 node scripts/client-dashboard-test.js` (sandbox only; 34 checks: the dashboard numbers, platforms and dates, the plan without price or notes, only-own-company, who is refused, landing on /client-home).
- `cd backend && TL_API=http://localhost:4063 node scripts/client-plan-login-test.js` (sandbox only; 53 checks: Client login from a client plan: an AI Marketing-only record is made or reused, never an ATS client and never in the ATS Clients list, nothing left behind on a refusal, who may, switch off / on, the login signs in and sees a post sent under the company name, Add user unchanged, the migration flags an older record).
