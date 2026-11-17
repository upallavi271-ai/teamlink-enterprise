# A second, separate company on TeamLink.Enterprise (for example NISHTECHNOLOGIES INDIA PVT LTD)

Founder's request (2026-11-16): a second company that has **its own Super Admin**, **every feature and module** the application has, and
**none of TeamLink's data** (no employees, candidates, clients, invoices, attendance, messages, WhatsApp numbers, settings or logs).

## 1. What the application has today (checked in the code, 2026-11-16)

* **No company / tenant / organisation concept at all.** None of the 179 data models has a company id. The only `Company` table is ONE row
  (name, address, GSTIN, bank, logo) that prints on invoices; it does not separate anything.
* A login is a `User` (email is unique across the whole database). `SUPER_ADMIN` sees everything in that database; every list route filters
  by role, department, team or client, **never by company**. 1,381 GET routes, 172 migrations, 274 tables.
* The program also uses files outside the database (uploads, backups, WhatsApp sessions, import files). Their default place is the Linux
  user's home folder (`~/.teamlink-uploads`, `~/.teamlink-backups` ...), so two copies on one server would share them unless told not to.
* Omni-Channel (Green Start) and the Job Portal are **separate programs** with their own databases that TeamLink starts or links to.
* A few hundred places say "TeamLink Consultants" in words (agreement text, broadcast mails, AI-call greetings) and four PDF / mail builders
  draw TeamLink's logo file.

## 2. The choice, and why

| | (a) One database, a company id in every table | (b) A second, separate copy of the application (chosen) |
|---|---|---|
| Keeps the data apart | Only if **every one** of ~1,400 queries filters correctly. One miss shows TeamLink's data to the other company. | **By construction**: another database file, another folder, another process. There is nothing to leak. |
| Risk to live TeamLink | Adds a column to 179 live tables and changes how every screen reads data. | **None**: TeamLink's code path, database and process are not touched. |
| Effort | Weeks, then months of regression testing. | Days. |
| Updates | One release for both. | The same release reaches both (section 6). |
| Cost | none | one more Node process (about 600 MB) and its own database on the same server |

Everything in this folder implements (b). TeamLink's own site and data are unchanged.

## 3. What the new company gets

Everything inside the application, because it is the same code: HRMS (employees, attendance, leave, payroll, performance, assets ...), ATS
(clients, requirements, candidates, pipeline, interviews, reports), Accounts (invoices, bank, expenses, GST/TDS), CRM, Administration (users,
roles, company setup, integrations, backups), AI assistant, Employee Monitoring, LMS and the rest. The Super Admin is given the permission matrix
of a TeamLink Super Admin: the test compares them and they are identical (24 modules, same features, same actions).

It starts **empty**: one login (the Super Admin) and one employee record, plus what every company starts with (chart of accounts, expense
categories, portal field mappings, app categories). Nothing of TeamLink's business: the six Medical joining targets that a migration puts in
TeamLink's database are removed.

**Not in the first release (they are separate programs, each would need its own copy for this company):**

* **Omni-Channel / Green Start and AI Marketing** (they run on Green Start). The menu entry shows "Green Start is switched off on this server".
* **The Job Portal** (`/jobs`). Its menu link is hidden in this company's screens.

Both stay off by settings (`GREENSTART_ENABLED=false`, `JOB_PORTAL_EMBED=0`); `scripts/company-check.js` refuses a copy where they are on, because the
default addresses of those services on the server are TeamLink's.

## 4. How it is separated (files)

| File | What it does |
|---|---|
| `backend/scripts/company-init.js` | Creates the new company's EMPTY database (all migrations), removes TeamLink-only seed rows, creates the Super Admin + employee, writes the one-time password link to a private file. Refuses a database that already has a login, and a file called `dev.db`. |
| `backend/src/utils/companyGuard.js` + 3 lines in `index.js` | The company's server refuses to run on any database that is not its own (`COMPANY_KEY` in its settings must match a row in the database). TeamLink and every PC have no `COMPANY_KEY`: nothing changes there. |
| `backend/scripts/company-check.js` | Read-only check of the company's settings file: own database, port, secrets, folders, no Green Start / Job Portal / AI-calling services. Prints PASS / FAIL, never a secret. |
| `backend/scripts/second-company-test.js` (`npm run company-test`) | The proof (section 5). |
| `backend/scripts/company-sandbox.js`, `frontend/scripts/company-sandbox.mjs` | A throw-away company on this PC to look at (API :4066, screens :5185). |
| `frontend/src/brand.js` + small changes in `Logo.jsx`, `Login.jsx`, `Shell.jsx`, `HomeRoute.jsx`, `vite.config.js` | A company's build (`VITE_BRAND_NAME="..."`) shows its own name on the sign-in page, menu, footer and browser tab; its address opens the sign-in page, not TeamLink's public home page; no Job Portal link. TeamLink's build sets nothing and is byte-for-byte what it was. |
| `deploy/vps/company/*` | Server side: `company-install.sh` (plan first, `--apply` to do), `company-deploy.sh` (one release), `company-sync.sh` + systemd timer (follows TeamLink). |

Each company lives in `/opt/company-<key>/`: `config/.env` (its own secrets, mode 600), `data/` (database, uploads, backups: a deploy never touches it),
`home/` (the process's HOME, so every default folder is its own), `backend/` `frontend/` (code), `state/`, `logs/`.

## 5. The proof: `npm run company-test` (in `backend/`, about 4 minutes)

On throw-away files only. It builds two databases from the same migrations: TeamLink-style (the repo's demo data) and a new company, starts both servers,
and checks, as each Super Admin:

* the new database holds only the generic defaults + the Super Admin, and not one of TeamLink's names, e-mails or titles;
* every screen's data request (965 GET requests: every route without an id) answered to the new Super Admin contains **no** TeamLink name or e-mail,
  while TeamLink's own answers contain 100+ of them (so the check can see them); every main list is empty (clients, candidates, requirements, invoices ...);
* the two Super Admins are given the identical permission matrix (menus) and the same pipeline stages; HRMS, ATS, Accounts all open;
* the one-time link works once; a weak password is refused; a TeamLink login does not exist in the company and the other way round; a token of one
  company is worthless on the other's server;
* a company server pointed at TeamLink's database stops; a server without `COMPANY_KEY` answers exactly as before;
* `company-check.js` passes separate settings and fails TeamLink's own.

## 6. Going live (needs the founder's yes; nothing here has been done on the server)

What is needed from the founder first: **the address** (for example `nish.teamlinks.in` or the company's own domain; its A record must point at the server),
**the Super Admin's name and sign-in e-mail**, and OK to use about 600 MB of the server's memory.

1. Read-only look at the server: free memory and disk, port 4012 free, pm2 and nginx names (`company-install.sh` prints these in its plan).
2. `bash /root/company-install.sh --key nish --name "NISHTECHNOLOGIES INDIA PVT LTD" --domain <address> --admin-name "<name>" --admin-email "<email>"` : the **plan** only.
3. The same with `--apply` : folders and secrets, the release (built from the commit TeamLink last deployed OK), the settings check, the empty database,
   pm2 start, ONE new nginx site (no existing site is edited, `nginx -t` first), HTTPS with certbot, the follower timer. It stops at the first problem.
4. The Super Admin opens the one-time link (file `/opt/company-nish/config/first-login.txt`, mode 600) and chooses their own password. Nobody else ever knows it.
   A new link: `node scripts/company-init.js --key nish --admin-email <email> --new-link` (the old one stops working).
5. Check: the address opens the company's sign-in page; TeamLink's site, database and pm2 process are untouched (`pm2 list`, `/opt/teamlink-sync/STATUS`).

**Taking it away again** (nothing of TeamLink depends on it): `systemctl disable --now company-sync@nish.timer; pm2 delete company-nish; pm2 save; rm /etc/nginx/sites-enabled/company-nish.conf /etc/nginx/sites-available/company-nish.conf; nginx -t && systemctl reload nginx`; the folder `/opt/company-nish` (with its database) can then be kept or deleted.

## 7. How later updates reach both companies

`company-sync.sh` runs every 2 minutes and only **reads** one file: `/opt/teamlink-sync/deployed-commit`, the commit TeamLink's own sync recorded after a
successful, healthy deploy. When it differs from what the company runs, the company is built from that same commit (`git archive`, next to the live copy), the
company's database gets its own migrations, and the company's server restarts for a few seconds. A release therefore reaches the company only after it proved
healthy on TeamLink; a TeamLink rollback never leaves the company ahead; a failed company deploy puts the previous release back and writes `/opt/company-nish/state/ALERT`.
TeamLink's own deploy script is not changed. Pause the company only: `touch /opt/company-nish/state/PAUSE`.

## 8. Still to decide / known limits

* **Wording and logo.** The company's own screens carry its name. Payslips, agreements, certificates and the password-reset e-mail draw a logo from
  `frontend/src/assets/teamlink-full-logo.png`; the company's copy has no such file, so those documents carry no logo until the company gives one
  (save it as `/opt/company-nish/config/logo.png`, the next release uses it). The text of agreements, broadcast mails and AI-call greetings still says "TeamLink Consultants"
  in about 100 places: a separate wording pass is needed before this company uses those features with its own customers. A few screen labels also still say
  "TeamLink" (for example the Invoices page header "TeamLink Accounts / Invoice"); they are wording, not data.
* **Green Start (Omni-Channel, AI Marketing) and the Job Portal** for this company: separate installs (own database, own ports, own address). Not done.
* **WhatsApp number, mail account, AI keys**: each company adds its own in Administration → Integrations; none is shared.
* **First-use quirk on any brand-new database.** The program sets up a few of its own tables the first time a screen needs them; two screens opening in the same
  instant can make one of them say "Something went wrong" once. Reloading fixes it. (TeamLink's database was set up long ago.)
* The server's free memory has not been looked at yet (a company copy needs about 600 MB while running).
## 9. The "Companies" menu: one Super Admin on top, the company's own admin below (added 2026-11-17)

Founder's wish: one Super Admin in TeamLink who can open the other company; the company's own admin is a "sub Super Admin" who sees only their company; TeamLink's data and
settings are not touched. Built as a **one-way door** between two separate copies (the data stays in separate databases, as in section 2):

* On TeamLink a **real** Super Admin (not an HR login lifted to Super Admin powers, not a View-as / Act-as session) sees **Companies ▾** in the top bar. Picking a company asks TeamLink
  for a **pass**: a signed note (Ed25519) that names the company, lives 60 seconds and works once. It goes in the address after the # sign, so it never reaches a server log.
* The company's server checks the signature with TeamLink's **public** key only, that the pass is for **its own** key, not older than 2 minutes, not used before, and signs the person in as
  that company's **"<name> (TeamLink owner)"**: a Super Admin of THIS company only, with no Employee record (the company's headcount and attendance stay its own), no password anyone knows.
  Inside the company the top bar shows **← Back to TeamLink**.
* **There is no way from a company into TeamLink.** The company holds no key that can make a pass; TeamLink has no door that takes one (it answers "not found" to a pass); a company token is worthless on TeamLink.
* The company's own admin is the "sub Super Admin": the top of that company, nothing of TeamLink. They **cannot lock the owner out**: at every visit the owner's login is made an Active Super Admin again.
* TeamLink's database gets **nothing** (no table, no login, no setting): one audit line each time a company is opened. The company records each visit ("Signed in from TeamLink") and each refused pass. No pass and no TeamLink e-mail address is written anywhere.
* Off by default: with no key files the menu does not exist and every route answers "nothing set up".

Files: `backend/src/utils/companyBridge.js`, `backend/src/routes/companyBridge.js` (mounted at `/api/company-bridge`), `backend/scripts/company-bridge-setup.js`,
`frontend/src/components/CompanySwitcher.jsx`, `frontend/src/pages/CompanyBridge.jsx` (route `/bridge`).
Proof: `npm run company-bridge-test` in `backend/` (59 checks: who sees the menu, empty company, replay / expired / long-lived / wrong company / wrong issuer / changed / forged / garbage pass, no way into TeamLink,
owner cannot be locked out, nothing stored). Try it by eye on a PC: `npm run company-sandbox` + `npm run bridge-sandbox` in backend/ and frontend/, then http://localhost:5186 (sign in as admin@teamlink.test) -> Companies.

### Going live (needs the founder's yes; the code reaches TeamLink and NISH through the normal main -> deploy -> follower path)

1. Push the code to main (TeamLink deploys it; the follower then builds NISH). Nothing changes on screen yet: no key files, no menu.
2. On the VPS, as root, ONE new folder and ONE new file for NISH (nothing existing is edited, TeamLink is not restarted):
   `cd /opt/teamlink-enterprise/backend && HOME=/root node scripts/company-bridge-setup.js --key nish --name "NISHTECHNOLOGIES INDIA PVT LTD" --url https://nish.teamlinks.in --public-out /opt/company-nish/config/bridge-public.pem`
   (makes /root/.teamlink-company-bridge/private.pem, mode 600, and companies.json; the private key never leaves that folder.)
3. NISH's own settings file gets two lines, then NISH (only) restarts:
   `COMPANY_BRIDGE_PUBLIC_KEY_FILE=/opt/company-nish/config/bridge-public.pem` and `COMPANY_BRIDGE_HOME_URL=https://teamlink.teamlinks.in`, then `pm2 restart company-nish`. `company-check.js` still passes.
4. The Super Admin reloads TeamLink: **Companies ▾** appears (TeamLink reads its two files at request time; no restart).
Taking it away: `node scripts/company-bridge-setup.js --remove nish` (the menu is gone at once); delete the two lines from NISH's settings and restart NISH.

## 10. TeamLink's own business words that are written in the program, not in the database (found 2026-11-17)

A separate company starts with an empty database, but a few screens draw TeamLink's own numbers from a default written in the program. Found and fixed: the dashboard's **Vacancies** card (the staffing plan:
Education Teams A / B, Medical, Manufacturing, BDE, R&D) — a company copy now starts with no plan and shows no card (`utils/vacancies.js`, `Vacancies.jsx`, `HrmsDashboard.jsx`; TeamLink unchanged).
`npm run company-test` now prints an information line with TeamLink's business words that still appear in the new company's answers, so the rest can be found and listed. Known and not yet changed: the
Vacancies plan editor cannot add departments (a company has no plan until that is built), the wording "TeamLink Consultants" in agreements / mails / greetings (section 8), and department lists that offer TeamLink's department names.
