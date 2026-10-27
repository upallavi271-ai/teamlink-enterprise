# Local import, 2026-10-27

One-off scripts used to rebuild a **local** TeamLink database (fresh clone, demo seed) from the company's own files.
They change only `backend/prisma/dev.db` and the uploads folder of the PC they run on. Nothing here talks to the
live site. No data is stored in this folder: every script reads the source files from the paths you give it.

Every script is a **dry run by default** and writes only with `--apply`; each takes a `VACUUM INTO` backup under
`~/.teamlink-backups/` first and prints where the backup and the undo list are.

## Order they were run in

| # | Script | What it does |
|---|--------|--------------|
| 1 | `import-agreement-clients.js` | Every client of the signed-agreements zip (194), named exactly as printed on the agreement, agreement Active, its signed files behind "View agreement" (through `../lib/joinings-2026-10-17/agreements.js`). Requirements from the Medical / Manufacturing / Education requirement sheets: Running = OPEN, Stopped = CLOSED. |
| 2 | `remove-demo-data.js` | Removes the seeded demo data (logins except `developer@tmlink.in`, demo employees, demo clients, candidates, demo accounts / HR records). Keeps the agreement clients and the setup data (departments, teams, roles, leave types, holidays, ledger, templates, settings). Follows every foreign key. |
| 3 | `add-sheet-clients.js` | The 28 companies that are on the requirement sheets but have no agreement in the zip, with their sheet requirements; a word-for-word repeated sheet row becomes one requirement. |
| 4 | `joinings-run.js` | Runs `../import-joinings-2026-10-17.js --only joinings` against the local database: creates the joinings-only colleges as clients and points the importer's name rules at the local client names (in memory; the rules file is not edited). |

```bash
node scripts/local-import-2026-10-27/import-agreement-clients.js --zip "<extracted zip>/All Signed Agreements (File responses)" --med "<Medical team requirements sheet.xlsx>" --mfg "<ManuFacture Requirements  Sheet.xlsx>" --edu "<Edu - 2 Requirement Sheet .xlsx>"
```

Add `--apply` to write. `add-sheet-clients.js` takes the same `--med / --mfg / --edu`. `joinings-run.js --db <file> [--create-clients] -- <importer args>`.

## Added later the same day

| Script | What it does |
|--------|--------------|
| `edu-resolve.js` | Maps the "college" column of an Education sheet to the local clients (the joinings importer's name rules + hand-checked short names); writes a JSON map and lists what did not match. |
| `edu-tracker-plan.js` | PLAN only: the Education interview tracker -> the app's own Candidates and Applications import files (one candidate per phone / e-mail, one application per person + college, the latest row decides the step). The files are then checked and committed through `/api/ats-io/import/<kind>/check` and `/commit`. |
| `edu1-import.js` | Edu - 1 Requirement Sheet: one "Faculty requirement" per college (Running = OPEN, Stopped = CLOSED), nothing new where one already exists, disagreements listed and left alone. `--bde "<name>"` sets the client manager of colleges that are new. |
| `edu2-clients.js` | Maps every row of the Edu - 2 sheet to its client (input for `edu-tl.js`). |
| `edu-tl.js` | Sets the TL on Education requirements by sheet: `--team-a "<TL>"` for Edu - 1 colleges, `--team-b "<TL>"` for Edu - 2 colleges; only where no TL is written yet; a college on both sheets is left alone. |
| `recruiter-report.js` | Read only: the recruiter-wise / BDE-wise / client-wise status report as one Excel file (candidate phone numbers and e-mails left out). Write it outside the repository. |

## Done through the app, not by a script

- Employees: HRMS > Employee Management > Import (`/api/employees/bulk-import`) with the global employee export; leavers imported as Inactive, then given their Relieved / Exited status.
- Resignations, helpdesk, leave history: the data import/export screen (`/api/io/<module>/import`).
- Recruiter seats: `/api/positions` (create + assign). Logins: Employee Management > Create missing logins (no email is sent while the Email channel is not configured).
