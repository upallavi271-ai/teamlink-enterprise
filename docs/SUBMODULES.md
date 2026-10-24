# Job Portal and Green Start are git submodules (since 2026-10-24)

TeamLink.Enterprise is the MAIN repo. Two products live in their own repos and are plugged into the main repo as **git submodules**, at exactly the folders the code already uses:

| Folder in the main repo | Sub repo | Visibility | Used by |
|---|---|---|---|
| `job-portal-app/job_portal-main` | `https://github.com/srvanthim084-afk/job_portal.git` (branch `main`) | public | `backend/src/utils/jobPortalEmbed.js` (served at `/jobs`) |
| `green-start-app` | `https://github.com/greenstart127-ui/Omni-channel---Greenstart.git` (branch `main`) | **private** | `backend/src/utils/greenStartEmbed.js`, `greenStartSupervisor.js` |

The main repo stores only ONE pointer (a commit id) per sub repo. That is what "pinned" means: everybody who clones the main repo at a commit gets the same Job Portal / Green Start code.

## Get everything on a new PC

```bash
git clone --recurse-submodules https://github.com/upallavi271-ai/teamlink-enterprise.git
cd teamlink-enterprise
powershell -ExecutionPolicy Bypass -File green-start-helpers\install-helpers.ps1
```

Already cloned without `--recurse-submodules`: `git submodule update --init --recursive`.
Green Start is private, so git asks for a GitHub login that can read it (Git Credential Manager, or a personal access token).

## Take the LATEST code of a sub repo into the main repo

```bash
git submodule update --remote job-portal-app/job_portal-main     # or: green-start-app   (or no name = both)
git add job-portal-app/job_portal-main green-start-app
git commit -m "Update Job Portal / Green Start to latest"
git push
```

Then restart the backend (it restarts the portal / Green Start by itself). Check what moved: `git submodule status` and `git diff --submodule=log HEAD~1`.
If the Job Portal brought new database migrations the portal applies them when it starts (`job-portal-app/run/portal.log`: "migrations: N applied"). For Green Start rebuild after an update: `npx prisma generate && npm run build` in `green-start-app/gs-api` and `npm run build` in `green-start-app/green-start-web` (stop Green Start first on Windows: prisma replaces a DLL).

## Rules

- **Never push to the sub repos' remotes from here, and do not edit files inside the two submodule folders.** They belong to other GitHub accounts: here we only fetch / pull them. A change to portal or Green Start code is made in THEIR repo, then pulled in with `--remote` as above.
- Runtime data stays local and is never committed: the portal's `var/` (its database), `.env` files, `node_modules`, Green Start's `run/` (pgdata, redis, logs). `.gitmodules` marks both submodules `ignore = untracked`, so this runtime data never shows as "dirty".
- **`green-start-helpers/run/`** holds TeamLink's own helper files that sit inside `green-start-app/run/` (gate.mjs, bind-local.cjs, gs-db.cjs, seed-demo, watchdog, start/stop scripts, pg-tool). They are NOT part of the Green Start repo, so they are tracked in the main repo and copied by `green-start-helpers/install-helpers.ps1`. Edit them in `green-start-helpers/run/`, then run the installer (an edit made only inside `green-start-app/run/` is lost on the next install).
- `job-portal-app/embed/` and `job-portal-app/update-tools/` belong to the main repo, not to the Job Portal repo.
- Line endings: the portal's database records a checksum of every migration file (`supabase/migrations`). With `core.autocrlf=true` (Windows default) the working files are CRLF, which is what the local database was built with. Do not change `core.autocrlf` inside `job-portal-app/job_portal-main` on a PC that already has a portal database.

## VPS

`deploy-local-to-vps.ps1` skips the `.git` pointer file that a submodule folder contains. `deploy/vps/teamlink-sync.sh` runs `git submodule update` after every checkout, works out Green Start's changed files inside the submodule, and only REPORTS (never pushes) a VPS edit of a sub repo folder. The VPS needs read access to the private Green Start repo (a GitHub token stored with `git config --global credential.helper store`, or a read-only deploy key for that repo); until then it says "waiting: cannot read the sub repo" in `/opt/teamlink-sync/STATUS`, or set `SUBS=job-portal-app/job_portal-main` to ignore Green Start on that server.

## Undo / problems

- `git submodule status` shows `+` = the folder is at another commit than the main repo pins (run `git submodule update`), `-` = not checked out yet.
- Before the conversion a full backup was taken (portal folder with `var` and `.env`, Green Start with `.env`, `run/pgdata`, redis, the TeamLink database) in `%USERPROFILE%\.teamlink-backups\submodule-setup-20261024-155902`, with `ROLLBACK.ps1` next to it.
