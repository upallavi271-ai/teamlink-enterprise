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

## Demo logins

Password for all of them is `password123`. On the login screen, picking a role prefills its email.

| Role | Email |
|---|---|
| Super Admin | `admin@teamlink.test` |
| Recruiter | `recruiter@teamlink.test` |
| BDE | `bde@teamlink.test` |
| TL | `tl@teamlink.test` |
| Accountant | `accountant@teamlink.test` |
| Employee | `employee@teamlink.test` |
| Client | `client@teamlink.test` |

## Modules

**HRMS** — dashboard, Attendance & Time (five tabs, punch-derived lateness and half-days), Leave & Holidays, Payroll & Compensation (five tabs, salary structures, payslips), Performance & Development, Employee Services (help desk with SLA, assets, announcements, surveys, resignation).

**ATS** — dashboard, Jobs / Requirements with the seven-section create form and job-description generation, Clients with the agreement e-sign lifecycle (Draft → Sent → Confirmed → Active), Candidates & Pipeline across the 20-stage pipeline with match scoring and duplicate detection, Recruiter & BDE workload, Interview Calendar covering both recruitment/client and AI interviews.

**Accounts** — dashboard with the financial-year period picker, the invoice register with ageing and saved views, Office / Business (bills, GST position, P&L), Bank & Reconciliation with a six-state matching workflow.

**Administration** — Company Setup, Employee Management, Users, Role Catalog, Integrations and Job Portal Sync, Organization Structure, Notifications, Audit Logs, Profile.

**Public** — a careers portal at `/careers`, plus a tokenised client agreement signing page.

## Notes

- Invoice money is `amount + GST − TDS`; GST and TDS rates come from the client record.
- Role Catalog permissions are stored and editable but **not yet enforced** — no route reads them.
- Each login carries a single role. The prototype gives each account three independent product roles; that split is deliberately deferred.
