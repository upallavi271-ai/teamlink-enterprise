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

## "Give phone login" from AI Marketing > Client plans (added 2026-11-25, same day)
A client that buys ONLY digital marketing is kept in AI Marketing > Client plans (`OmniMkClientPlan`: a name, a plan, a contact), not in Clients, but a login needs a Clients record (`User.clientId`). So each plan has a **Phone login** button:
- `GET /api/portal/logins/marketing-plan/:planId` reads the company's Clients record (found by the company NAME, any letter case or spaces round it; the oldest if there are branches), its logins and the seats left.
- `POST /api/portal/logins/marketing-plan/:planId/login {name,email}` finds that record, or MAKES a bare one when there is none (the name, a client ID `CLI....`, the plan's contact, the plan's department; agreement status DRAFT and no agreement document, i.e. like "Save for later"), then adds the "Social posts" login through the same rules as Add user (`whyNot`, `addDirect`) and the same one-time set-password link. A refused login (bad email, email already in use, 3-login limit) is checked BEFORE a record is made, so nothing empty is left behind.
- Admin-level only (the people who may add a login directly: `can(..., 'Client Portal Logins', 'approve')`), and the AI Marketing write right. A Manager sees it only for their own departments. Everyone else is told to ask the Admin.
- A Clients record with the same name is reused and never changed; a second login for the same company goes on the same record.
- Audit lines: "Client created" (when made), "Client portal login created (Social posts)", "Omni-Channel AI Marketing: phone login given to a client".
- The invite email and the set-password page now speak about posts for this login type (the email used to say "requirements and candidates", and the page told the person to open My Profile, which only employees have).
- Not done: a marketing-only client is not marked in the Clients list (it shows as a Draft with no agreement); no "switch off" button in the plan panel (use Clients > the client > Portal access).

## Rules
- A login sees only its own company's rows: `clientId` equal, or no `clientId` on the row and the same company name (the rule the web portal's "Creative work" list already used).
- The name on an answer is the login's own (never typed). A rejection needs a reason (5+ letters); the answer is saved once, goes to the sender as a bell, shows in AI Marketing's client reviews, and each answer is one more audit line ("client answered from their login").
- The accounts screen is read only and sends no token, no error text and no staff names.
- A client with other ticks (for example "See our requirements" + creative) keeps My Portal exactly as before; only a login whose only tick is `CREATIVE` gets the short menu.

## Tests
- `cd backend && TL_API=http://localhost:4063 node scripts/client-phone-test.js` (sandbox only; 55 checks: create the login and sign in, only-own-company, approve / reject, staff see the decision, accounts, walls).
- `cd backend && TL_API=http://localhost:4063 node scripts/client-plan-login-test.js` (sandbox only; 40 checks: Phone login from a client plan: the record is made or reused, nothing left behind on a refusal, who may, the login signs in and sees a post sent under the company name, Add user unchanged).
