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
  (A "← Back to TeamLink" link inside the company was removed again on 2026-11-17 at the founder's request: the company opens in its own tab, so closing that tab is the way back. The server still answers /api/company-bridge/status; nothing in the screens uses it.)
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
## 11. The company's own Job Portal (added 2026-11-17)

Founder's wish: Omni-Channel and the Job Portal also visible in the other company, but with none of TeamLink's accounts or details. The Job Portal is a separate program with its own
database (the customer's `job_portal`, a git submodule of this repository). TeamLink runs it **inside its own server process** at `/jobs`, with a small database of its own. A company copy
does the same, as its own portal on its own ports, in its own folders:

| | TeamLink | the company (NISH) |
|---|---|---|
| address | `/jobs` on TeamLink's address | `/jobs` on the company's address |
| web port / database port | 4323 / 5434 | 4324 / 5435 (own, set in its settings) |
| code | `/opt/teamlink-enterprise/job-portal-app` | `/opt/company-<key>/job-portal-app` (replaced by a deploy) |
| database, uploads, run files | `.../job_portal-main/var` | `/opt/company-<key>/data/job-portal/{db,storage,run}` (a deploy never touches them) |
| secrets | its own | NEW random ones (sync token, push secret, portal auth secret, integration key) |

**Why a new portal is not simply switched on (found by running a fresh one):** the portal's own first start puts a company called **"TeamLink Consultants"** into the database, and, while its users
table is empty, two demo logins (`recruiter@teamlink.com` "Dev Recruiter", `bde@teamlink.com` "Priya Nair") that share one password (a published default unless one is given). Its AI-calling settings and two
publishing labels also say "TeamLink". `deploy/vps/company/company-portal-init.mjs` therefore runs once on the new database: renames those to the company's name, removes exactly the two demo logins and their two
profile rows (it refuses if the portal holds anything else), and gives the company's own Admin a portal admin login, which also stops the portal from writing the demo logins again on a later start (proved on a
throw-away copy: second start creates nothing). `JOBPORTAL__DEV_PASSWORD` is a random value nobody knows, so even a demo login that slipped in could not be used.

**The program refuses a portal that is not the company's own.** The supervisor adopts any portal that answers on its port, and the default ports ARE TeamLink's: a company copy that kept them would show TeamLink's
jobs and candidates under its own address. So `utils/jobPortalEmbed.js` starts a portal in a company copy (COMPANY_KEY) only when its own web port, database port (neither 4323 / 5434), run folder, database folder and
a long demo-account password are all set; `scripts/company-check.js` checks the same list, plus that the four portal secrets differ from TeamLink's and the folders are the company's own. TeamLink (no COMPANY_KEY) is unchanged.

**How it is installed** (`deploy/vps/company/company-portal-install.sh --key nish --name "..."`, plan first, `--apply` to do it; needs the founder's yes):
1. checks (company healthy, ports free and not TeamLink's, disk); 2. settings + folders (dated copy of the settings file; `JOB_PORTAL_EMBED=0` at first; the screens get the Job Portal menu through `VITE_BRAND_JOB_PORTAL=1`);
3. `company-deploy.sh` puts the portal's code (taken from the submodule at the commit the release pins) and packages next to the company's release (same method as TeamLink's own deploy; later releases refresh it only when
it changed, wait for the portal to stop before replacing code, and put the old code back on a failed start); 4. first start off to the side, clean-up (above); 5. `JOB_PORTAL_EMBED=1`, only the company's server restarts;
6. checks: the portal answers on ITS port, `/jobs` works through the company's address, the process runs from the company's folder, TeamLink's portal (4323) untouched, `company-check` passes.
Taking it away: `JOB_PORTAL_EMBED=0` and `pm2 restart company-<key>`; the folder `data/job-portal` can then be kept or deleted.

Proof: `npm run company-portal-test` in `backend/` (27 checks: the refusals, TeamLink unchanged, the settings check, the scripts), plus the throw-away end-to-end run on the server described above.
Not changed (wording, not data): the portal's message templates and the label "TeamLink AI Engine v2.3" in its AI settings keep the program's own wording; the company adds its own mail / SMS / WhatsApp / job-board accounts inside the portal.
### 11.1 Three faults found while installing it on the live server (2026-11-17), and what now prevents them

1. **The first-start process was left running and open to the internet.** `company-portal-install.sh` started the portal's own `dev-server.mjs` directly (it listens on every address; this server has no
   firewall) and stopped a wrapper process instead of the portal, so the portal stayed up on port 4324 while the clean-up opened the same database folder. Found because a process listened on `*:4324`; it was stopped,
   the empty database was made again and the clean-up repeated. The script now starts the portal through its own host (`embed/host.mjs`, bound to 127.0.0.1), uses `exec` so the stop reaches the portal itself,
   and refuses to go on if the portal listened anywhere else or a port is still held afterwards.
2. **The company's server was running with HOME=/root (TeamLink's home folder).** `pm2 restart --update-env` copies the caller's environment over the process's. From a root shell that overwrote the
   company's own HOME, so every default folder under the home folder was TeamLink's, and the company's server could read TeamLink's Companies key folder and make passes (a company Super Admin opened the menu
   inside the company). Now: `company-deploy.sh` and `company-portal-install.sh` restart with the company's own HOME and `PM2_HOME` naming the real pm2 folder (with another HOME pm2 looks in the wrong folder
   and starts a second manager there); `COMPANY_HOME` in the company's settings is applied by `utils/companyGuard.js` before anything reads the home folder (whatever starts the process);
   `utils/companyBridge.js` never issues a pass in a company copy; `company-check.js` requires COMPANY_HOME to be the company's own folder. `npm run company-portal-test` covers all four.
3. **`/jobs` showed the company's own screens, not its portal.** TeamLink's nginx site has two rules (`location = /jobs` and `location ^~ /jobs/`) that hand `/jobs` to the backend; a company's site
   (`company-install.sh`) only handed `/api/` over and served the rest as plain screens. `company-portal-install.sh` now adds the same two rules to the company's own nginx site (`nginx-jobs.snippet`; nginx is
   tested before it is reloaded and the old file is put back if the test fails).

Known and not changed: the portal's own pages are the customer's program and carry the name "TeamLink" (title, logo); only its data (company, demo logins, labels) is the company's.
## 12. The company's own Omni-Channel (Green Start) (added 2026-11-17)

Founder's wish: Omni-Channel visible in the other company too, with none of TeamLink's accounts or details. Green Start is a separate program (NestJS API + background worker + its own PostgreSQL database
+ Redis); TeamLink runs one at `greenstart.teamlinks.in`. A company gets a **second, completely separate set**, built by `deploy/vps/company/company-green-install.sh`:

| | TeamLink | the company (NISH) |
|---|---|---|
| database | `greenstart` (own login `greenstart`) | `greenstart_nish` (own login `gs_nish`), same PostgreSQL server, 153 tables, no company data |
| Redis | port 6379 | its own instance, port 6380, own password and folder |
| API / worker | `green-start-api` (4020) / `green-start-worker` | `green-start-nish-api` (4021) / `green-start-nish-worker` / `green-start-nish-redis` |
| settings + secrets | `/opt/green-start/gs-api/.env` | `/opt/company-nish/green/config/gs-api.env` (mode 640): every secret new, nothing copied |
| uploads | `/opt/green-start/uploads` | `/opt/company-nish/green/uploads` |
| address | `greenstart.teamlinks.in` | the company's own, for example `omni.nish.teamlinks.in` (own nginx site + certificate) |

The **program files** (`gs-api/dist`, the built website) are TeamLink's own read-only copy: the same program runs for both, so there is no second heavy build. The company's folder `green/gs-api` holds only
links to those files and **no `.env`** (the company's own settings come from its own file; nothing of TeamLink's `.env` can be read). After TeamLink's own deploy of a new Green Start version has finished,
`company-green-sync.sh` (called by the company's 2-minute check) migrates the company's own database and restarts its own API and worker. TeamLink's Green Start is only read, never changed.

**Three stages** (`--stage prepare|start|public`, plan first, `--apply` to do it):
1. **prepare** (needs nothing from outside): checks, database + login, Redis, folders, settings, migrations, services installed but NOT started.
2. **start**: refuses until the company's OWN sending mailbox is in the settings. Green Start e-mails sign-up codes, password resets and invitations, so as a real server it will not start without
   SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM, and TeamLink's mailbox is never used. `company-green-smtp.sh --key nish` asks for the details in the server terminal (password typed hidden, tested with a login check that
   sends nothing, saved only in the company's settings file, never printed, never in a chat).
3. **public** (needs the DNS record): the company's own nginx site (`nginx-omni.conf.tmpl`, from TeamLink's live Green Start site with its own port, name and origin; one new file, `nginx -t` before reload) + certificate (certbot)
   + the company's server is switched to its own Green Start (`GREENSTART_ENABLED=true`, its own API / Redis ports, its own sign-in secret `GREENSTART_SSO_SECRET` = the company's `TEAMLINK_SSO_SECRET`) and restarted with its own HOME.
   The company's Green Start account is made by Green Start itself on the first one-click sign-in; see 12.1 for the one step that is still needed (approval of that first organization).

**The program refuses a Green Start that is not the company's own** (`utils/companyGuard.js`): the program's defaults (API port 4020, Redis 6379, "on" when unset) are TeamLink's own Green Start, so a company copy
keeps Green Start on only when `GREENSTART_API_PORT` is a port of its own (not 4020); otherwise it is switched off at start. `scripts/company-check.js` checks the same, plus its own Redis port (not 6379), a long sign-in secret that
differs from TeamLink's, and no TeamLink gate port. TeamLink (no COMPANY_KEY) is unchanged. `npm run company-portal-test` covers it (59 checks, including the sink and the approval stage).

**Proved on the live server before anything was handed over:** `--stage prepare` created the database (153 tables, 207 rows that the program installs itself: migration bookkeeping, permissions, plans, rate cards; nothing naming TeamLink
except one migration file name), then a boot test with clearly fake mailbox values started the company's Redis, API and worker (API health ok, listening on 127.0.0.1 only, about 230 MB, no errors, TeamLink's Green Start undisturbed),
and the services were stopped and the fake values blanked again.

Known: the company's own WhatsApp number, Meta app, SMS and ad accounts are added inside its Green Start later (none are shared). The program's public pages keep the product name "Green Start".

### 12.1 Opening it without a mailbox, and the first account (found while installing it for NISH, 2026-11-17)

**The e-mail sink (`company-green-mailsink.js`, service `green-start-<key>-mailsink`).** Green Start will not start as a real server without SMTP settings, and a company that has no mailbox yet must not borrow TeamLink's.
`company-green-install.sh --stage sink` installs a tiny local "mail server" that listens on 127.0.0.1 only, accepts any login and **throws every message away**. Green Start is pointed at it (`SMTP_*` in the company's own
`gs-api.env`), so it starts and works through the one-click button, and nothing is ever sent to anybody. The sink's log keeps only a count and a time, never an address, subject or text (`company-portal-test` checks this).
Consequence: with the sink in place, nobody receives sign-up codes, password resets or invitations. When the company has its own mailbox, run `company-green-smtp.sh --key <key>` in the server terminal (the real mailbox replaces the sink
settings; the sink service can then be stopped). The mailbox of another company (for example TeamLink's) must never be entered there.

**The first account has to be approved, and must NOT be a platform administrator.** Green Start holds every new organization in "waiting for approval" until a platform Super Admin approves it (`admin/signups/:id/approve`).
The company has no platform Super Admin, and an account marked platform administrator is refused by the one-click route (`TEAMLINK_NOT_ALLOWED`: platform administrators must sign in with their own email and password). So the first
organization is approved **once, by the installer (`company-green-install.sh --key <key> --domain <address> --stage approve --name "<the company's full name>" --apply`; safe to run again), with the same changes the program's own `approve()` makes, in one transaction**: organization -> trial (Starter), decision time; the owner's account gets "approved, source sign-up";
the welcome balance (1,000 rupees = 10,000,000 wallet units, once per business, with its ledger row); and a history line saying it was approved by the installer. The owner stays a normal account (no platform flag). Afterwards the
one-click ticket sign-in for that account returns a session (tested on the live server). The organization and workspace are given the company's name by the same transaction, because Green Start names its first ones after the person who signed in ("TeamLink").
Later organizations, if any, are approved the same way or by a platform Super Admin the company creates for itself.

**The Omni-Channel button must open the company's own address (found 2026-11-17: "Could not sign in - Your session has expired").** The screens decide the address (`frontend/src/components/outreach/greenStartLink.js`): with no
`VITE_GREENSTART_URL` at build time, any `*.teamlinks.in` screen opens TeamLink's own `https://greenstart.teamlinks.in`. A company's sign-in ticket is signed with the company's own secret, so TeamLink's Green Start rightly refuses it (HTTP 401:
nothing of TeamLink's was reachable), but the person only sees the error page. Fix, no code change: `config/brand.env` (read by every `company-deploy.sh` build) holds `VITE_GREENSTART_URL=https://<the company's Green Start address>`;
`--stage public` writes it, and the next build (`bash /opt/company-sync/company-deploy.sh <key>`) bakes it into the screens, so it survives every later automatic update. The sign-in is one-click only: the Green Start accounts it makes
have no password of their own, so there is no second login to remember (the Green Start page opened directly shows a login form that these accounts cannot use).

**Not yet done in code:** the names "TeamLink" that the app itself sends in the sign-in ticket (user name, organization name) still come from TeamLink's wording; a company name setting (`COMPANY_NAME`) would replace them. Until then the `approve` stage gives the first organization and workspace the company's name, and any further organization would need the same rename.
