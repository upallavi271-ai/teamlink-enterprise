# TeamLink.Enterprise

One login covering three products — **HRMS**, **ATS** and **Accounts** — plus Administration and Reports.

Built as a faithful implementation of the `teamlink-enterprise` HTML prototype: the same design system, the same navigation, and the same screens, backed by a real database instead of `localStorage`.

## Stack

```
backend/    Node.js + Express, Prisma ORM, SQLite
frontend/   React 18 + Vite, React Router
```

## Running it

Two terminals, from the repository root.

Backend:

```bash
cp backend/.env.example backend/.env
npm install --prefix backend
npx prisma migrate dev --schema backend/prisma/schema.prisma
npm run seed --prefix backend
npm run dev --prefix backend
```

Frontend:

```bash
npm install --prefix frontend
npm run dev --prefix frontend
```

The app is then at **http://localhost:5183** and the API at **http://localhost:4010**.

## Identity and access

**One employee = one user = one login.** An HRMS employee and an "ATS Recruiter"
are the same person and the same record. Nobody has a second account for ATS,
and nobody ever picks a role — the login screen is email and password only.

A person's access is **derived**, never stored as a compound role:

```
Kiran Kumar · Department: Medical · Designation: Recruiter
  -> atsRole = RECRUITER   (from the designation mapping)
  -> atsScope = Medical    (from the employee's department)
  -> HRMS: employee self-service.  ATS: Recruiter, Medical only.
```

There is no `Medical TL` or `IT Recruiter` role anywhere. The
designation → ATS-role mapping is data in the **`DesignationRole`** table, is
editable from Administration → Users, and the same ATS role works in every
department.

**The permission engine** is `backend/src/utils/permissions.js`, one function:

```js
can(user, product, module, feature, action, record)
```

It checks, in order: user identity → product access → role → module permission
→ action permission → data scope → record ownership. Actions are `view`,
`create`, `edit`, `delete`, `approve`, `assign`, `export`, `configure`. It reads
the **`RoleAccess` matrix that Administration → Role Catalog edits** — turning a
module off there really refuses the API on the next request. Route guards are
`requirePerm(product, module, feature, action)`; there is no `requireRole` and
no second permission system.

**Data scope** lives in `backend/src/utils/scope.js` and is enforced
**server-side** on every list and record endpoint. The frontend hides UI from
the same model (`frontend/src/permissions.js`, fed by `/auth/me`), but hiding a
button is never the control — a cross-scope request returns `403`.

## Demo logins

The demo password for **every** login below is `password123`. It is documented
here and printed by `npm run seed`; it is never shown anywhere in the UI.

| Email | Department / Designation | Products | ATS role & scope |
|---|---|---|---|
| `admin@teamlink.test` | Leadership / Super Admin | HRMS + ATS + Accounts | Super Admin, global |
| `divya@teamlink.test` | Medical / TL | HRMS + ATS | TL, Medical (Medical Team-A) |
| `kiran@teamlink.test` | Medical / Recruiter | HRMS + ATS | Recruiter, Medical |
| `recruiter@teamlink.test` | IT / Recruiter | HRMS + ATS | Recruiter, IT |
| `tl@teamlink.test` | IT / TL | HRMS + ATS | TL, IT |
| `multi@teamlink.test` | Medical / Manager | HRMS + ATS + Accounts | Manager, scoped to Medical + IT |
| `bde@teamlink.test` | BDE / BDE | HRMS + ATS | BDE, assigned clients |
| `accounts@teamlink.test` | Accounts / Accountant | HRMS + Accounts | — (Accounts workspace) |
| `accountant@teamlink.test` | Accounts / Accountant | HRMS + Accounts | — (second accountant) |
| `employee@teamlink.test` | HR / HR Executive | HRMS only | — |
| `rahul.verma@teamlink.test` | IT / Junior Developer | HRMS only | — (profile unfilled) |
| `client@teamlink.test` | Client A — Orbit Software | ATS + Accounts | Client, own company only |
| `clientb@teamlink.test` | Client B — Medivant Healthcare | ATS + Accounts | Client, own company only |
| `candidate@teamlink.test` | Candidate — Arjun Mehta | — | Candidate, own profile only |

After signing in you land on the workspace your products and working role imply
— ATS, Accounts or HRMS self-service. A login with several products gets a
workspace switcher in the top bar; it never asks you to choose a role.

## Modules

**HRMS** — dashboard, Attendance & Time (five tabs, punch-derived lateness and half-days), Leave & Holidays, Payroll & Compensation (five tabs, salary structures, payslips), Performance & Development, Employee Services (help desk with SLA, assets, announcements, surveys, resignation).

**ATS** — dashboard, Jobs / Requirements with the seven-section create form and job-description generation, Clients with the agreement e-sign lifecycle (Draft → Sent → Confirmed → Active), Candidates & Pipeline across the 20-stage pipeline with match scoring and duplicate detection, Recruiter & BDE workload, Interview Calendar covering both recruitment/client and AI interviews.

**Accounts** — dashboard with the financial-year period picker, the invoice register with ageing and saved views, Office / Business (bills, GST position, P&L), Bank & Reconciliation with a six-state matching workflow.

**Administration** — Company Setup, Employee Management, Users, Role Catalog, Integrations and Job Portal Sync, Organization Structure, Notifications, Audit Logs, Profile.

**Public** — a careers portal at `/careers`, plus a tokenised client agreement signing page.

## Integrations, credentials and secrets

Third-party credentials are entered in **Administration → Integrations** and
live **server-side only**. `backend/src/utils/secrets.js` encrypts every
credential field with AES-256-GCM before it is stored in the existing
`Integration.values` JSON column, and `backend/src/utils/integrationStore.js`
is the only module that reads or writes it. The API returns the non-secret
fields (host, port, username, from-address, model name) plus a **masked hint**
such as `••••••a91f`; the plaintext never reaches the browser and is never
logged.

The encryption key comes from one environment variable:

```
INTEGRATION_SECRET_KEY   # 64 hex chars, or any long passphrase (scrypt-stretched)
```

It is documented in `backend/.env.example`. Without it the Integrations screen
**refuses to save a credential** rather than storing one in plain text —
everything else keeps working. Changing it makes stored credentials unreadable;
the screens say so and the credential must be entered again. `.env` is
gitignored and no real value belongs in the repository.

In the Configure dialog a credential box opens **empty**: blank means "keep
what is stored", and a single `-` clears it.

### Email (SMTP) — real

`nodemailer` sends through the host configured on the **Email (SMTP)** channel:
SMTP host, port, encryption (SSL / STARTTLS / None), username, password,
from-address and default from-name. To switch it on, fill those in and press
**Save & Connect**, then **Send test email** on the same screen — a failure
reports the provider's own error (`EAUTH`, `ECONNREFUSED`, the SMTP 5xx text),
not a generic one.

`backend/src/utils/mailWorker.js` then sends the `CandidateMessage` rows that a
stage change writes, and the status vocabulary stays honest:

| Status | Means |
|---|---|
| `NOT_SENT_NO_PROVIDER` | Recorded, not transmitted. The correct state when no SMTP channel is configured — and the permanent state of every SMS and WhatsApp row, because neither has a provider. |
| `QUEUED` | A provider exists; waiting for the worker. |
| `RETRY` | The provider failed **temporarily**. Retried with backoff (1, 5, 15, 60, 180 minutes), up to `MAIL_MAX_ATTEMPTS`. |
| `SENT` | The provider **accepted** it. `providerRef` carries its message id and `sentAt` the time. |
| `FAILED` | The provider refused it, or the retries ran out. `lastError` carries the provider's reason. |

`SENT` means accepted for delivery, not delivered: there is no bounce or
delivery webhook yet, and no suppression list. The screens say so.

**Sender identity, and why it needs DNS.** A candidate message goes out under
the **sending employee's own email address**, taken from their employee record
(`Employee.email`, captured when the employee is added). SMTP will not let an
authenticated mailbox claim an arbitrary envelope sender, so the message is
built as a standard *send-on-behalf-of*:

```
envelope MAIL FROM : the configured From address (the mailbox we authenticated as)
header   From      : "Employee Name" <employee@domain>     <- what the candidate sees
         Reply-To  : employee@domain                        <- where replies land
         Sender    : the configured From address
```

For that `From` to reach an inbox, **the employee's domain must authorise this
SMTP host**: SPF must include it, DKIM must sign for that domain, and DMARC
must be satisfiable. Without SPF/DKIM/DMARC alignment on each employee domain,
the mail is spam-foldered or bounced. Employees on a domain you do not control
(a personal Gmail address, say) cannot be used as a `From` at all — put a
domain you own on their employee record.

### AI Assistant (Anthropic Claude) — real, optional

The floating assistant has two halves. **"Do next"** is computed from the same
scoped, permission-guarded queues the dashboard renders and needs no model.
**"Ask"** is a real agent: paste an Anthropic API key into the **AI Assistant
(Anthropic Claude)** channel and free-text questions are answered by
`backend/src/utils/aiAgent.js`.

- The key is stored encrypted like any other credential and is used **only on
  the server**. The browser posts to `/api/ai/ask`; it never sees the key.
- The agent answers **only from this app's data**, through a small tool surface
  in `backend/src/utils/aiAgentTools.js`: pending actions, requirement and
  candidate search, requirement detail, job-description facts, client list, and
  candidate/requirement scoring.
- **Every tool call runs `can(...)` from the permission engine and spreads the
  `utils/scope.js` `where` fragments into the query**, exactly as a route does.
  A user cannot ask the agent for anything the API would refuse them; a refusal
  is reported as a refusal, not as "no such record". The agent is read-only.
- Match scores come from `backend/src/utils/matching.js`, never from the model.
- Cost and abuse: conversation history, tool iterations, output tokens and
  questions per user per hour are all capped (the last two are editable on the
  channel).

With no key, `/api/ai/status` reports it, the Ask tab says so plainly, and the
rest of the panel keeps working.

## Notes

- Invoice money is `amount + GST − TDS`; GST and TDS rates come from the client record.
- Role Catalog permissions are **enforced**: `backend/src/utils/permissions.js`
  reads the `RoleAccess` matrix on every guarded request. Until a role's row is
  saved, the engine falls back to `DEFAULT_RULES` in the same file, which
  reproduce the role lists the old `requireRole()` guards carried.
- Each login carries three independent product-access booleans plus a derived
  ATS working role and a stored data scope — all editable on
  Administration → Users.
- Manager and Assistant Manager are cross-department by default; give one an
  explicit department list on Administration → Users and they are held to it.
- SQLite migration rule: **`ALTER TABLE ... ADD COLUMN` only.** Prisma
  implements a column *change* on SQLite as a table rebuild that silently drops
  columns added by migrations it did not know about. If `prisma migrate dev`
  generates a rebuild, hand-write the migration instead (see
  `20260921140000_auth_rbac_identity_and_access` and
  `20260921170000_integr_message_delivery`).
- Never commit a credential. `.env` and `backend/prisma/dev.db` are gitignored,
  and nothing in the codebase logs a secret.
