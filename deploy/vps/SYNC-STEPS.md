# TeamLink sync: PC ⇄ GitHub ⇄ VPS (step by step)

One rule: **GitHub (branch `main`) is the one place the code lives.** The PC and the VPS both follow it.

```
PC / AI edits ──► watch-sync.ps1 ──► GitHub main ──► VPS (every 2 min: backup → update → build → restart → health check → rollback if it fails)
VPS edits ──────► teamlink-sync.sh ─► GitHub main ──► PC (watch-sync pulls every 2 min)
```
Apps: **TeamLink** (HRMS, ATS, Accounts, Omni: `backend/`, `frontend/`), **Job Portal** (`job-portal-app/`), **Green Start** (`green-start-app/`). Only the app whose folder changed is rebuilt.
Never synced through Git (on purpose): databases, `.env` files, uploads, `node_modules`, the Job Portal's `var/` database, logs. Data (entries) is copied VPS → PC by the existing `sync-both.ps1` / Install-AutoSync, not by Git.

## Already done (nothing live was changed)
1. `deploy/vps/teamlink-sync.sh`: the VPS program (edits → GitHub, GitHub → deploy, rollback, pause, conflict handling).
2. `deploy/vps/test-sync.sh`: 20 tests, run on the VPS in a scratch folder with stub commands: **20 of 20 pass** (first deploy, keep `.env`/database, PC change deployed, VPS edit pushed and not redeployed, clash blocked, secret file blocked, failed build rolled back and not retried, pause, `[skip deploy]`).
3. `watch-sync.ps1` (PC): commit + push after 8 s of quiet, pull every 2 min, secret guard, big-batch hold.
4. `.gitignore`: keys, data folders, Job Portal `var/`, build output.

## What you do (once)
1. **Make the GitHub repo PRIVATE.** It is public today: anyone can read the code. GitHub → `upallavi271-ai/teamlink-enterprise` → Settings → General → Danger Zone → Change visibility → Private.
2. Tell me "private done". I check it and continue.

## What happens next (I do it, one step at a time, showing you each result)
3. VPS: copy the 4 files of `deploy/vps/` to `/root/` and run `bash /root/INSTALL-ON-VPS.sh`. It installs the program and creates a **new deploy key**, and prints the key. (The timer is NOT started.)
4. You: GitHub → repo → Settings → Deploy keys → Add deploy key → paste the key → tick **Allow write access** → Add.
5. PC: put the code on `main` (a fast-forward, no force): the 1,192 pending changes are reviewed with `git status`, committed once, and pushed. Then `watch-sync.ps1 -AllowBig` is started once for that first batch.
6. VPS: `DRY_RUN=1 /opt/teamlink-sync/teamlink-sync.sh` shows what the first deploy would do. If it looks right: `systemctl enable --now teamlink-sync.timer`. From now on it is automatic.

## Everyday use
- PC: keep `watch-sync.ps1` running (`powershell -ExecutionPolicy Bypass -File .\watch-sync.ps1`). Save a file → it reaches GitHub, then the VPS within about 2–5 minutes.
- Stop all deploys: `touch /opt/teamlink-sync/PAUSE` on the VPS. Resume: `rm /opt/teamlink-sync/PAUSE`.
- A commit message with `[skip deploy]` is not deployed.
- What is it doing? `tail -50 /opt/teamlink-sync/sync.log` and `cat /opt/teamlink-sync/STATUS`.
- If `/opt/teamlink-sync/ALERT` exists, something needs you: a failed build (rolled back automatically), or a VPS edit that clashes with a newer GitHub change. Resolve with `teamlink-sync.sh accept-github` (keep GitHub's version) or `accept-vps` (keep the VPS version).
- Going back to an older release by hand: `.\deploy-local-to-vps.ps1 -RollbackTo <stamp>` still works (the folders `backend-old-<stamp>` are kept, the 3 newest).

## Honest limits
- Editing code directly on the VPS is risky (it is live at once). It is supported, but use it for small fixes.
- Two people changing the same file before a sync can clash. The system never overwrites silently: it stops, raises an ALERT and waits for your choice.
- The first deploy after switching on replaces the code on the VPS with GitHub's `main`. Anything that exists only on the VPS and was never pushed would be overwritten (a backup of the previous release is kept). Step 6's dry run is where this is checked.

## Check made on 2026-10-22 (read-only, before anything was switched on)
PC code compared with the code running on the VPS, file by file (checksums):
- TeamLink backend/src: 775 same, **9 differ (today's changes), 0 files exist only on the VPS**.
- TeamLink frontend/src: 1,069 same, **17 differ (today's changes), 0 only on the VPS**.
- Green Start (api + web) and Job Portal: **identical** on PC and VPS.
So the VPS has **no code change that the PC lacks**: the first deploy overwrites nothing of value. What shows up on the VPS but not on the PC is **data** (entries made on the live site), which Git does not carry; that is the job of `sync-both.ps1` / the nightly auto-sync.
