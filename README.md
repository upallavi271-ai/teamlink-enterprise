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
  `20260921140000_auth_rbac_identity_and_access`).
